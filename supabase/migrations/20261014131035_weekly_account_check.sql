-- Weekly account check: the recurring Productive tasks "Redovna provera Disapproved Ads-a",
-- "Weekly Gads Recommendations Check", "Placement optimizacija" and "GA4 Analiza - Source / medium".
-- Snapshots come from account-settings-sync (daily) and placements-sync (weekly); weekly_candidates()
-- computes every number and morning-review turns them into findings once a week. Nothing is changed
-- in any account.

create table if not exists public.google_ad_policy (
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id),
  snapshot_date date not null,
  ad_id text not null,
  campaign text not null,
  ad_group text,
  ad_status text,
  approval_status text,
  review_status text,
  policy_topics text,
  created_at timestamptz not null default now(),
  primary key (client_id, snapshot_date, ad_id)
);
create table if not exists public.google_optimization (
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id),
  snapshot_date date not null,
  campaign_id text not null,
  campaign text not null,
  account_score numeric,
  campaign_score numeric,
  recommendation_types text[] not null default '{}',
  recommended_budget numeric,
  created_at timestamptz not null default now(),
  primary key (client_id, snapshot_date, campaign_id)
);
create table if not exists public.google_placements (
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id),
  snapshot_date date not null,
  period text not null,
  campaign text not null,
  placement text not null,
  display_name text,
  placement_type text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  created_at timestamptz not null default now(),
  primary key (client_id, snapshot_date, campaign, placement)
);
alter table public.google_ad_policy enable row level security;
alter table public.google_optimization enable row level security;
alter table public.google_placements enable row level security;
create policy "agency ad policy read" on public.google_ad_policy for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency optimization read" on public.google_optimization for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency placements read" on public.google_placements for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select on public.google_ad_policy, public.google_optimization, public.google_placements to authenticated;

create or replace function public.weekly_candidates(p_client_id uuid, p_asof date default null)
returns table (check_type text, fingerprint text, severity text, impact_eur numeric, evidence jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  s jsonb;
  d date;
  wk text;
  snap date;
  min_spend numeric;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'weekly_candidates: not allowed';
  end if;
  select r.params into s from review_settings r where r.client_id = p_client_id and r.enabled;
  if s is null then return; end if;
  d := coalesce(p_asof, (select max(x) from (
         select max(g.report_date) as x from google_ads_metrics g where g.client_id = p_client_id
         union all select max(f.report_date) from facebook_ads_metrics f where f.client_id = p_client_id) t));
  if d is null then return; end if;
  -- One finding per check per ISO week: a decision holds for that week, next week is checked again.
  wk := to_char(d, 'IYYY-"W"IW');

  -- 1. Ads that are disapproved or limited by policy, from the latest snapshot.
  select max(a.snapshot_date) into snap from google_ad_policy a where a.client_id = p_client_id;
  if snap is not null then
    return query
    with latest_status as (
      select distinct on (cs.campaign) cs.campaign, cs.campaign_status
      from google_campaign_settings cs where cs.client_id = p_client_id
      order by cs.campaign, cs.snapshot_date desc
    ), bad as (
      select a.campaign, a.ad_group, a.ad_id, a.approval_status, a.review_status, a.policy_topics,
             coalesce(ls.campaign_status, 'UNKNOWN') as campaign_status
      from google_ad_policy a
      left join latest_status ls on ls.campaign = a.campaign
      where a.client_id = p_client_id and a.snapshot_date = snap
        and a.approval_status in ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')
        and coalesce(a.ad_status, 'ENABLED') = 'ENABLED'
    )
    select 'ads_policy'::text,
           'ads_policy:' || wk,
           case when bool_or(b.approval_status = 'DISAPPROVED' and b.campaign_status = 'ENABLED') then 'visoko'
                when bool_or(b.approval_status = 'DISAPPROVED') then 'srednje' else 'info' end,
           null::numeric,
           jsonb_build_object('snapshot_date', snap, 'week', wk,
             'disapproved', count(*) filter (where b.approval_status = 'DISAPPROVED'),
             'limited', count(*) filter (where b.approval_status <> 'DISAPPROVED'),
             'items', jsonb_agg(jsonb_build_object('campaign', b.campaign, 'ad_group', b.ad_group, 'ad_id', b.ad_id,
                        'approval', b.approval_status, 'campaign_status', b.campaign_status, 'topics', b.policy_topics)
                      order by (b.approval_status = 'DISAPPROVED') desc, b.campaign))
    from bad b
    having count(*) > 0;
  end if;

  -- 2. Optimization score and the recommendations behind it; budget recommendations are compared
  --    with today's daily budget and the budget-lost impression share.
  select max(o.snapshot_date) into snap from google_optimization o where o.client_id = p_client_id;
  if snap is not null then
    return query
    with o as (
      select o.*, cs.daily_budget, cs.campaign_status
      from google_optimization o
      left join google_campaign_settings cs on cs.client_id = o.client_id and cs.snapshot_date = o.snapshot_date and cs.campaign_id = o.campaign_id
      where o.client_id = p_client_id and o.snapshot_date = snap
    ), lost as (
      select g.campaign, avg(g.search_lost_is_budget) as lost7
      from google_ads_metrics g where g.client_id = p_client_id and g.report_date > d - 7 and g.search_lost_is_budget is not null
      group by g.campaign
    )
    select 'recommendations'::text,
           'recs:' || wk,
           case when max(o.account_score) < 0.7 then 'srednje' else 'info' end,
           null::numeric,
           jsonb_build_object('snapshot_date', snap, 'week', wk,
             'account_score_pct', round(max(o.account_score) * 100),
             'target_pct', round(coalesce((s->>'opt_score_min')::numeric, 0.9) * 100),
             'campaigns', coalesce(jsonb_agg(jsonb_build_object('campaign', o.campaign, 'score_pct', round(o.campaign_score * 100),
                              'types', to_jsonb(o.recommendation_types))
                            order by o.campaign_score) filter (where o.campaign_score < 0.8 and cardinality(o.recommendation_types) > 0), '[]'::jsonb),
             'budget_recommendations', coalesce(jsonb_agg(jsonb_build_object('campaign', o.campaign, 'daily_budget', o.daily_budget,
                              'recommended_budget', o.recommended_budget, 'lost_is_budget_pct', round(l.lost7 * 100)))
                            filter (where o.recommended_budget > coalesce(o.daily_budget, 0)), '[]'::jsonb))
    from o left join lost l on l.campaign = o.campaign
    having max(o.account_score) < coalesce((s->>'opt_score_min')::numeric, 0.9)
        or bool_or(o.recommended_budget > coalesce(o.daily_budget, 0));
  end if;

  -- 3. Placements that cost money without a conversion in the last 30 days (one row per placement).
  select max(p.snapshot_date) into snap from google_placements p where p.client_id = p_client_id;
  min_spend := greatest(3, coalesce((s->>'placement_min_spend_eur')::numeric, (s->>'waste_min_spend_eur')::numeric));
  if snap is not null then
    return query
    select 'placement'::text,
           'pl:' || p.placement,
           'srednje',
           round(sum(p.spend)),
           jsonb_build_object('placement', p.placement, 'name', max(p.display_name), 'type', max(p.placement_type),
             'spend', round(sum(p.spend), 2), 'clicks', sum(p.clicks), 'impressions', sum(p.impressions),
             'ctr_pct', round(sum(p.clicks)::numeric / nullif(sum(p.impressions), 0) * 100, 2),
             'campaigns', to_jsonb(array_agg(distinct p.campaign order by p.campaign)), 'period', max(p.period), 'snapshot_date', snap)
    from google_placements p
    where p.client_id = p_client_id and p.snapshot_date = snap
    group by p.placement
    having sum(p.conversions) = 0 and sum(p.spend) >= min_spend;
  end if;

  -- 4. GA4: traffic without a known source, and paid traffic GA4 no longer attributes
  --    (last 7 days against the 4 weeks before).
  return query
  with ga as (
    select case when x.report_date > d - 7 then 'now' else 'base' end as per,
           sum(x.sessions) as sessions,
           sum(x.sessions) filter (where x.source in ('(direct)', '(not set)', '(data not available)') or x.medium in ('(none)', '(not set)')) as unknown,
           sum(x.sessions) filter (where x.source = 'google' and x.medium = 'cpc') as g_cpc,
           sum(x.sessions) filter (where x.source in ('facebook', 'fb', 'ig', 'instagram', 'meta') and x.medium in ('paid', 'cpc', 'paid_social')) as m_paid
    from ga4_metrics x
    where x.client_id = p_client_id and x.report_date between d - 34 and d
    group by 1
  ), clicks as (
    select case when g.report_date > d - 7 then 'now' else 'base' end as per, sum(g.clicks) as g_clicks, null::numeric as m_clicks
    from google_ads_metrics g where g.client_id = p_client_id and g.report_date between d - 34 and d group by 1
    union all
    select case when f.report_date > d - 7 then 'now' else 'base' end, null, sum(f.clicks)
    from facebook_ads_metrics f where f.client_id = p_client_id and f.report_date between d - 34 and d group by 1
  ), c as (
    select per, sum(g_clicks) as g_clicks, sum(m_clicks) as m_clicks from clicks group by per
  ), x as (
    select n.sessions as s_now, b.sessions / 4.0 as s_base,
           n.unknown::numeric / nullif(n.sessions, 0) as unk_now, b.unknown::numeric / nullif(b.sessions, 0) as unk_base,
           n.g_cpc::numeric / nullif(cn.g_clicks, 0) as g_now, b.g_cpc::numeric / nullif(cb.g_clicks, 0) as g_base,
           n.m_paid::numeric / nullif(cn.m_clicks, 0) as m_now, b.m_paid::numeric / nullif(cb.m_clicks, 0) as m_base
    from ga n join ga b on n.per = 'now' and b.per = 'base'
    left join c cn on cn.per = 'now' left join c cb on cb.per = 'base'
  )
  select 'ga4_tracking'::text,
         'ga4:' || wk,
         'srednje',
         null::numeric,
         jsonb_build_object('week', wk, 'to_date', d,
           'sessions_7d', x.s_now, 'unknown_share_pct', round(x.unk_now * 100, 1), 'unknown_share_base_pct', round(x.unk_base * 100, 1),
           'google_sessions_per_click', round(x.g_now, 2), 'google_sessions_per_click_base', round(x.g_base, 2),
           'meta_sessions_per_click', round(x.m_now, 2), 'meta_sessions_per_click_base', round(x.m_base, 2),
           'signals', to_jsonb(array_remove(array[
             case when x.unk_now - x.unk_base >= 0.05 and x.unk_now >= x.unk_base * 1.25 then 'unknown_up' end,
             case when x.g_base >= 0.3 and x.g_now < x.g_base * 0.7 then 'google_paid_gap' end,
             case when x.m_base >= 0.3 and x.m_now < x.m_base * 0.7 then 'meta_paid_gap' end], null)))
  from x
  where x.s_now >= 1000
    and ((x.unk_now - x.unk_base >= 0.05 and x.unk_now >= x.unk_base * 1.25)
         or (x.g_base >= 0.3 and x.g_now < x.g_base * 0.7)
         or (x.m_base >= 0.3 and x.m_now < x.m_base * 0.7));
end $$;

-- Placements change slowly and the report is large: pulled once a week, Monday 04:30 UTC,
-- before the morning review that runs the weekly checks.
create or replace function public.enqueue_weekly_sync()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sync_queue (fn, body)
  select distinct 'placements-sync', jsonb_build_object('client_id', ds.client_id, 'date_preset', 'last_30d')
  from data_sources ds where ds.provider = 'google_ads' and ds.windsor_connection_id is not null;
  get diagnostics n = row_count;
  return n;
end $$;

select cron.schedule('weekly-placements-sync', '30 4 * * 1', $c$select public.enqueue_weekly_sync()$c$);
