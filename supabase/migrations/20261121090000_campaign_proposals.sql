-- Campaign proposals (Meta builder phase 2 and the same for Google), PROPOSALS ONLY: nothing is sent to Meta or Google.
-- For every Meta / Google flight line of the month's MPL: what to build (Meta ad set copied from the template ad set of the
-- same line type; Google asset group / ad group in the Short Sales or AOn campaign, or a new video campaign), the proposed
-- name, dates, daily budget, and the exact steps a builder would run. The team approves or rejects a proposal in Brain;
-- that only records the decision.

create table if not exists public.campaign_proposal_decisions (
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null,
  network text not null,
  campaign_label text not null,
  plan_start date,
  status text not null check (status in ('odobreno', 'odbaceno', 'napravljeno_rucno')),
  note text,
  decided_by text default (auth.jwt() ->> 'email'),
  decided_at timestamptz not null default now(),
  unique nulls not distinct (client_id, month, network, campaign_label, plan_start)
);
alter table public.campaign_proposal_decisions enable row level security;
create policy "visible clients read" on public.campaign_proposal_decisions for select using (client_id in (select id from clients));
create policy "visible clients write" on public.campaign_proposal_decisions for insert with check (client_id in (select id from clients));
create policy "visible clients update" on public.campaign_proposal_decisions for update using (client_id in (select id from clients));
create policy "visible clients delete" on public.campaign_proposal_decisions for delete using (client_id in (select id from clients));

-- "Black Friday - Conversion" -> "Black Friday"; "Cyber monday- - Traffic" -> "Cyber monday".
create or replace function public.mpl_action_name(p_label text)
returns text language sql immutable as $$
  select btrim(regexp_replace(
    regexp_replace(p_label, '\s*-*\s*(conversion|remarketing|traffic|add to cart|atc|awareness|pmax|deman gen|demand gen|yt|youtube|video)\s*$', '', 'i'),
    '[\s-]+$', ''))
$$;

-- "Black Friday", 2026 -> "Black_Friday_26"
create or replace function public.mpl_action_token(p_action text, p_start date)
returns text language sql immutable as $$
  select array_to_string(array(select initcap(w) from regexp_split_to_table(regexp_replace(p_action, '[^[:alnum:]% ]+', ' ', 'g'), '\s+') w where w <> ''), '_')
         || '_' || to_char(coalesce(p_start, now()::date), 'YY')
$$;

create or replace function public.campaign_proposals(p_client_id uuid, p_month date)
returns table (
  network text, kind text, campaign_label text, channel text, start_date date, end_date date, days int,
  budget_total numeric, daily_budget numeric, action text,
  target_campaign text, template_name text, template_id text, template_dates text,
  proposed_name text, proposed_campaign text, existing text, state text, notes text[], steps jsonb,
  decision text, decision_note text, decided_by text, decided_at timestamptz
) language sql stable security invoker set search_path = public as $function$
  with mk as (select upper(substring(name from '([A-Z]{2})$')) as mk from clients where id = p_client_id),
  lines as (
    select h.*, (h.end_date - h.start_date + 1) as d, mpl_action_name(h.campaign_label) as act,
      case when h.network = 'meta' then
             case when h.campaign_label ~* 'add to cart|\matc\M' then 'add_to_cart' when h.campaign_label ~* 'remarketing' then 'remarketing'
                  when h.campaign_label ~* 'traffic' then 'traffic' when h.campaign_label ~* 'awareness' then 'awareness'
                  when h.campaign_label ~* 'conversion' then 'conversion' else 'other' end
           else case when h.campaign_label ~* '\m(yt|youtube|video)\M' then 'video' when h.channel ~* 'pmax' or h.campaign_label ~* 'pmax' then 'pmax'
                     when h.channel ~* 'demand' or h.campaign_label ~* 'dema?n gen' then 'demand_gen' else 'other' end end as k
    from media_plan_history h
    where h.client_id = p_client_id and h.month = date_trunc('month', p_month)::date and h.removed_at is null
      and h.network in ('meta', 'google') and h.flight_type = 'Flight' and coalesce(h.budget_total, 0) > 0
  ),
  -- Google: last 90 days of asset groups / ad groups with their first and last spend day.
  ggroups as (
    select 'asset_group' as lvl, campaign, asset_group_name as sub, min(report_date) as f, max(report_date) as t
    from google_asset_group_metrics where client_id = p_client_id and report_date >= current_date - 90 and spend > 0 group by 1, 2, 3
    union all
    select 'ad_group', campaign, ad_group_name, min(report_date), max(report_date)
    from google_ad_group_metrics where client_id = p_client_id and report_date >= current_date - 90 and spend > 0 group by 1, 2, 3
  ),
  gcamps as (
    select campaign, max(report_date) as t, min(report_date) as f from google_ads_metrics
    where client_id = p_client_id and report_date >= current_date - 90 and spend > 0 group by 1
  ),
  prop as (
    select l.*, mk.mk,
      -- Meta template ad set of the same line type (Add to cart falls back to the conversion template).
      (select t from meta_template_adsets t where t.client_id = p_client_id
         and t.line_type = case l.k when 'add_to_cart' then 'conversion' else l.k end
       order by (t.add_to_cart = (l.k = 'add_to_cart')) desc limit 1) as mt,
      -- Google target campaign: short flights (<= 7 days) go to Short Sales, longer ones to AOn.
      case when l.network = 'google' and l.k in ('pmax', 'demand_gen') then
        (select c.campaign from gcamps c
         where c.campaign ~* (case when l.end_date - l.start_date + 1 <= 7 then '^Short Sales' else '^AOn' end)
           and c.campaign ~* case l.k when 'pmax' then 'Ct:PMax' else 'Ct:DemandGen' end
         order by c.t desc limit 1) end as gcamp
    from lines l cross join mk
  ),
  prop2 as (
    select p.*, gt.sub as gt_sub, gt.f as gt_f, gt.t as gt_t, gv.campaign as gv_campaign, gv.f as gv_f, gv.t as gv_t,
      mpl_action_token(p.act, p.start_date) as tok,
      lower(split_part(regexp_replace(p.act, '[^[:alnum:] ]+', ' ', 'g'), ' ', 1)) as key1
    from prop p
    left join lateral (select g.sub, g.f, g.t from ggroups g
      where p.network = 'google' and p.k in ('pmax', 'demand_gen') and g.campaign = p.gcamp and g.lvl = case p.k when 'pmax' then 'asset_group' else 'ad_group' end
      order by g.f desc limit 1) gt on true
    left join lateral (select c.campaign, c.f, c.t from gcamps c
      where p.network = 'google' and p.k = 'video' and c.campaign ~* 'Ct:Video' order by c.f desc limit 1) gv on true
  ),
  named as (
    select p.*,
      case
        when p.network = 'meta' and p.k = 'conversion' then p.tok || '(Mkt:' || p.mk || ';Tg:Broad)'
        when p.network = 'meta' and p.k = 'add_to_cart' then p.tok || '_ATC(Mkt:' || p.mk || ';Tg:Broad)'
        when p.network = 'meta' and p.k = 'remarketing' then p.tok || '(Mkt:' || p.mk || ';Tg:LP_Visitors)'
        when p.network = 'meta' and p.k = 'traffic' then p.tok || '_traffic(Mkt:' || p.mk || ';Tg:Broad)'
        when p.network = 'meta' and p.k = 'awareness' then p.tok || '_awareness(Mkt:' || p.mk || ';Tg:Broad)'
        when p.network = 'google' and p.k = 'pmax' then replace(p.tok, '_', ' ')
        when p.network = 'google' and p.k = 'demand_gen' then p.tok || '(Tg:Mix)'
        when p.network = 'google' and p.k = 'video' then p.tok
      end as pname,
      case
        when p.network = 'meta' and p.k = 'awareness' then p.tok || '(Mkt:' || p.mk || ';Ct:Awareness;Ph:Tof)'
        when p.network = 'meta' then (p.mt).campaign
        when p.network = 'google' and p.k = 'video' then p.tok || ' (Mkt:' || p.mk || ';Ct:Video_reach;Ph:Tof)'
        else p.gcamp
      end as pcamp,
      -- Already built? An ad set / group with the action's first word that started around the line's start.
      case when p.network = 'meta' then
        (select string_agg(distinct a.adset_name, ' | ') from meta_adsets a join meta_campaign_types t on t.client_id = a.client_id and t.campaign_id = a.campaign_id
         where a.client_id = p_client_id and length(p.key1) >= 3 and lower(regexp_replace(a.adset_name, '[^[:alnum:]]', '', 'g')) like '%' || p.key1 || '%'
           and a.adset_start_time::date between p.start_date - 4 and p.start_date + 1
           and t.line_type = case p.k when 'add_to_cart' then 'conversion' else p.k end
           and (p.k <> 'add_to_cart' or a.adset_name ~* 'atc') and (p.k <> 'conversion' or a.adset_name !~* 'atc'))
      else
        (select string_agg(distinct g.campaign || ' / ' || g.sub, ' | ') from ggroups g
         where length(p.key1) >= 3 and lower(regexp_replace(g.sub || ' ' || g.campaign, '[^[:alnum:]]', '', 'g')) like '%' || p.key1 || '%'
           and g.f between p.start_date - 4 and p.end_date
           and case p.k when 'pmax' then g.lvl = 'asset_group' and g.campaign ~* 'PMax' when 'demand_gen' then g.lvl = 'ad_group' and g.campaign ~* 'DemandGen'
                        else g.campaign ~* 'Video' end)
      end as existing
    from prop2 p
  )
  select n.network, n.k, n.campaign_label, n.channel, n.start_date, n.end_date, n.d, n.budget_total, round(n.budget_total / nullif(n.d, 0), 2), n.act,
    n.pcamp,
    case when n.network = 'meta' then (n.mt).adset_name when n.k = 'video' then n.gv_campaign else n.gt_sub end,
    case when n.network = 'meta' then (n.mt).adset_id end,
    case when n.network = 'meta' then to_char((n.mt).adset_start_time, 'DD.MM.') || '–' || coalesce(to_char((n.mt).adset_end_time, 'DD.MM.'), '')
         when n.k = 'video' then to_char(n.gv_f, 'DD.MM.') || '–' || to_char(n.gv_t, 'DD.MM.')
         else to_char(n.gt_f, 'DD.MM.') || '–' || to_char(n.gt_t, 'DD.MM.') end,
    n.pname, n.pcamp, n.existing,
    case when n.existing is not null then 'postoji' when n.end_date < current_date then 'prošlo'
         when n.k = 'other' then 'ručno' when n.network = 'meta' and n.mt is null then 'nema šablona'
         when n.network = 'google' and n.k in ('pmax', 'demand_gen') and n.gcamp is null then 'nema kampanje' else 'za izradu' end,
    array_remove(array[
      case when n.network = 'meta' and n.k = 'remarketing' and ((n.mt).adset_promoted_object ? 'product_set_id') then 'Remarketing (DPA): product set za ovu akciju mora postojati u katalogu; tim upisuje njegov ID.' end,
      case when n.network = 'meta' and n.k = 'add_to_cart' and not coalesce((n.mt).add_to_cart, false) then 'Nema ATC šablona: kopira se conversion ad set i optimizacija se menja na Add to cart.' end,
      case when n.network = 'meta' and n.k = 'awareness' then 'Awareness je nova kampanja po akciji (lifetime budžet = budžet linije); ad set se kopira iz poslednje awareness akcije.' end,
      case when n.network = 'google' and n.k = 'pmax' then 'Budžet Google kampanje deli sve asset grupe u njoj: za dane akcije budžet kampanje = dnevni budžet linije (+ ostale aktivne grupe).' end,
      case when n.network = 'google' and n.k = 'demand_gen' then 'Ad grupa u Demand Gen kampanji; budžet je na nivou kampanje, za dane akcije.' end,
      case when n.network = 'google' and n.k = 'video' then 'Nova video kampanja (kao poslednja Video_reach); budžet i datumi iz MPL-a.' end,
      case when n.network = 'google' then 'Google se ne šalje dok Google Ads API nema secrets; ovo je samo predlog.' end,
      case when n.d = 1 then 'Akcija traje jedan dan: start 00:00, kraj 23:59.' end
    ], null),
    case
      when n.network = 'meta' and n.k = 'awareness' then jsonb_build_array(
        jsonb_build_object('action', 'create_campaign', 'params', jsonb_build_object('name', n.pcamp, 'objective', 'OUTCOME_AWARENESS', 'status', 'paused',
          'lifetime_budget', round(n.budget_total * 100), 'special_ad_categories', '[]'::jsonb)),
        jsonb_build_object('action', 'duplicate_adset', 'params', jsonb_build_object('adset_id', (n.mt).adset_id, 'campaign_id', '<nova kampanja>', 'deep_copy', true, 'status_option', 'paused')),
        jsonb_build_object('action', 'update_adset', 'params', jsonb_build_object('adset_id', '<kopija>', 'name', n.pname,
          'start_time', n.start_date || 'T00:00:00+0100', 'end_time', n.end_date || 'T23:59:00+0100')),
        jsonb_build_object('action', 'update_ad_creative', 'params', jsonb_build_object('ad_id', '<oglas kopije>', 'url_tags',
          'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}--{{adset.name}}&utm_content={{ad.name}}', 'kreativa', 'iz briefa (slika/video, tekst, link)')))
      when n.network = 'meta' then jsonb_build_array(
        jsonb_build_object('action', 'duplicate_adset', 'params', jsonb_build_object('adset_id', (n.mt).adset_id, 'deep_copy', true, 'status_option', 'paused')),
        jsonb_build_object('action', 'update_adset', 'params', jsonb_build_object('adset_id', '<kopija>', 'name', n.pname,
          'start_time', n.start_date || 'T00:00:00+0100', 'end_time', n.end_date || 'T23:59:00+0100')
          || case when n.k = 'remarketing' and ((n.mt).adset_promoted_object ? 'product_set_id') then jsonb_build_object('extra_params', jsonb_build_object('promoted_object',
               jsonb_build_object('product_set_id', '<product set akcije>', 'custom_event_type', 'PURCHASE'))) else '{}'::jsonb end
          || case when n.k = 'add_to_cart' and not coalesce((n.mt).add_to_cart, false) then jsonb_build_object('extra_params', jsonb_build_object('promoted_object',
               jsonb_build_object('pixel_id', (n.mt).adset_promoted_object->>'pixel_id', 'custom_event_type', 'ADD_TO_CART')), 'optimization_goal', 'OFFSITE_CONVERSIONS') else '{}'::jsonb end),
        jsonb_build_object('action', 'set_adset_budget', 'params', jsonb_build_object('adset_id', '<kopija>', 'budget_type', 'daily', 'amount', round(n.budget_total / nullif(n.d, 0) * 100))),
        jsonb_build_object('action', 'update_ad_creative', 'params', jsonb_build_object('ad_id', '<oglas kopije>', 'url_tags',
          'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}--{{adset.name}}&utm_content={{ad.name}}', 'kreativa',
          case when n.k = 'remarketing' then 'katalog (DPA), bez izmene' else 'iz briefa (slika/video, tekst, link)' end)))
      when n.k = 'pmax' then jsonb_build_array(
        jsonb_build_object('action', 'AssetGroupService.create', 'params', jsonb_build_object('campaign', n.gcamp, 'name', n.pname, 'status', 'PAUSED',
          'copy_from', n.gt_sub, 'final_url', 'landing iz briefa', 'assets', 'naslovi, opisi, slike, video iz briefa; signal iz šablona')),
        jsonb_build_object('action', 'CampaignBudgetService.update', 'params', jsonb_build_object('campaign', n.gcamp,
          'daily_eur', round(n.budget_total / nullif(n.d, 0), 2), 'od', n.start_date, 'do', n.end_date)),
        jsonb_build_object('action', 'AssetGroupService.pause', 'params', jsonb_build_object('name', n.pname, 'posle', n.end_date)))
      when n.k = 'demand_gen' then jsonb_build_array(
        jsonb_build_object('action', 'AdGroupService.create', 'params', jsonb_build_object('campaign', n.gcamp, 'name', n.pname, 'status', 'PAUSED',
          'copy_from', n.gt_sub, 'audience', 'kao šablon (Tg:Mix)')),
        jsonb_build_object('action', 'AdGroupAdService.create', 'params', jsonb_build_object('ad_group', n.pname, 'kreativa', 'iz briefa', 'final_url', 'landing iz briefa')),
        jsonb_build_object('action', 'CampaignBudgetService.update', 'params', jsonb_build_object('campaign', n.gcamp,
          'daily_eur', round(n.budget_total / nullif(n.d, 0), 2), 'od', n.start_date, 'do', n.end_date)))
      when n.k = 'video' then jsonb_build_array(
        jsonb_build_object('action', 'CampaignService.create', 'params', jsonb_build_object('name', n.pcamp, 'type', 'VIDEO (reach)', 'status', 'PAUSED',
          'copy_from', n.gv_campaign, 'start', n.start_date, 'end', n.end_date, 'total_budget_eur', n.budget_total)),
        jsonb_build_object('action', 'AdGroupAdService.create', 'params', jsonb_build_object('video', 'YouTube video iz briefa')))
      else '[]'::jsonb
    end,
    d.status, d.note, d.decided_by, d.decided_at
  from named n
  left join campaign_proposal_decisions d on d.client_id = p_client_id and d.month = date_trunc('month', p_month)::date
    and d.network = n.network and d.campaign_label = n.campaign_label and d.plan_start is not distinct from n.start_date
  order by n.start_date, n.network desc, n.campaign_label
$function$;
