-- MPL report: every media plan line (media_plan_history, imported from the PPC team's "MPL & REPORT" sheet) with the
-- actuals of the campaigns, ad sets or asset groups mapped to it in media_plan_line_map.
-- Definitions are the PPC team's: clicks = Meta link clicks / Google clicks, conversions and revenue = GA4 transactions
-- and revenue, reach = Meta period reach / Google period unique users (people, never summed from days).
create table if not exists public.media_plan_line_map (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null,
  network text not null,
  campaign_label text not null,
  plan_start date,
  level text not null check (level in ('campaign', 'meta_ad_set', 'asset_group', 'google_ad_group')),
  campaign_pattern text not null,
  sub_pattern text,
  confirmed boolean not null default false,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists media_plan_line_map_line on public.media_plan_line_map (client_id, month, network, campaign_label, plan_start) nulls not distinct;
alter table public.media_plan_line_map enable row level security;
create policy "scoped media_plan_line_map access" on public.media_plan_line_map for select using (client_id in (
  select c.id from clients c where c.agency_id = current_user_agency_id() and (current_user_client_id() is null or c.id = current_user_client_id())));
create policy "scoped media_plan_line_map write" on public.media_plan_line_map for all using (client_id in (
  select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null))
  with check (client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));

create or replace function public.mpl_report(p_client_id uuid, p_month date)
returns table (
  line_id uuid, section text, network text, channel text, flight_type text, campaign_label text, start_date date, end_date date,
  budget_total numeric, map_level text, map_confirmed boolean, matched text[],
  spend numeric, impressions numeric, clicks numeric, ctr numeric, reach numeric,
  transactions numeric, revenue numeric, roas numeric, platform_conversions numeric,
  team_spend numeric, team_impressions numeric, team_clicks numeric, team_reach numeric,
  team_conversions numeric, team_revenue numeric, team_installs numeric, map_note text
) language sql stable security invoker set search_path = public as $function$
  with per as (
    select date_trunc('month', p_month)::date as ms,
           least((date_trunc('month', p_month) + interval '1 month - 1 day')::date, current_date - 1) as me
  ),
  lines as (
    select h.*, m.level as m_level, m.campaign_pattern, m.sub_pattern, m.confirmed, m.note as m_note
    from media_plan_history h
    left join media_plan_line_map m on m.client_id = h.client_id and m.month = h.month and m.network = h.network
      and m.campaign_label = h.campaign_label and m.plan_start is not distinct from h.start_date
    where h.client_id = p_client_id and h.month = date_trunc('month', p_month)::date
  ),
  -- Platform rows of every mapped line; clicks are link clicks on Meta.
  base as (
    select l.id as line_id, b.campaign, b.sub, b.report_date, b.spend, b.impressions, b.clicks, b.conversions
    from lines l cross join per
    cross join lateral (
      select g.campaign, null::text as sub, g.report_date, g.spend, g.impressions, g.clicks, g.conversions
        from google_ads_metrics g where l.m_level = 'campaign' and l.network = 'google' and g.client_id = p_client_id
         and g.report_date between per.ms and per.me and g.campaign ~ l.campaign_pattern
      union all
      select a.campaign, a.asset_group_name, a.report_date, a.spend, a.impressions, a.clicks, a.conversions
        from google_asset_group_metrics a where l.m_level = 'asset_group' and a.client_id = p_client_id
         and a.report_date between per.ms and per.me and a.campaign ~ l.campaign_pattern and a.asset_group_name ~ coalesce(l.sub_pattern, '')
      union all
      select a.campaign, a.ad_group_name, a.report_date, a.spend, a.impressions, a.clicks, a.conversions
        from google_ad_group_metrics a where l.m_level = 'google_ad_group' and a.client_id = p_client_id
         and a.report_date between per.ms and per.me and a.campaign ~ l.campaign_pattern and a.ad_group_name ~ coalesce(l.sub_pattern, '')
      union all
      select f.campaign, null, f.report_date, f.spend, f.impressions, coalesce(f.link_clicks, f.clicks), f.conversions
        from facebook_ads_metrics f where l.m_level = 'campaign' and l.network = 'meta' and f.client_id = p_client_id
         and f.report_date between per.ms and per.me and f.campaign ~ l.campaign_pattern
      union all
      select s.campaign, s.adset_name, s.report_date, s.spend, s.impressions, coalesce(s.link_clicks, s.clicks), s.conversions
        from meta_ad_set_metrics s where l.m_level = 'meta_ad_set' and s.client_id = p_client_id
         and s.report_date between per.ms and per.me and s.campaign ~ l.campaign_pattern and s.adset_name ~ coalesce(l.sub_pattern, '')
    ) b
  ),
  units as (  -- matched campaigns / ad sets / asset groups, with the days they spent
    select b.line_id, b.campaign, b.sub, array_agg(distinct b.report_date) filter (where b.spend > 0) as days,
           sum(b.spend) as spend, sum(b.impressions) as impressions, sum(b.clicks) as clicks, sum(b.conversions) as conversions
    from base b group by 1, 2, 3
    having sum(b.spend) > 0 or sum(b.impressions) > 0
  ),
  ga as (  -- GA4 per unit: Google by campaign name (a shared campaign's asset group / ad group only on the days it spent),
           -- Meta by "campaign--ad set", or for a campaign line by the campaign name with or without the ad set suffix
    select u.line_id, u.campaign, u.sub, sum(g.transactions) as tx, sum(g.total_revenue) as rev
    from units u join lines l on l.id = u.line_id cross join per
    join ga4_metrics g on g.client_id = p_client_id and g.report_date between per.ms and per.me
     and case
       when l.network = 'google' then g.source = 'google' and g.medium = 'cpc' and g.campaign = u.campaign
            and (u.sub is null or g.report_date = any(u.days))
       when u.sub is not null then g.campaign = u.campaign || '--' || u.sub
       else g.campaign = u.campaign or left(g.campaign, length(u.campaign) + 2) = u.campaign || '--'
     end
    group by 1, 2, 3
  ),
  rch as (
    select u.line_id, sum(case
      when l.network = 'meta' then meta_reach_for(p_client_id, per.ms, per.me, array[u.campaign], u.sub)
      when u.sub is null then (select r.unique_users from google_period_reach r where r.client_id = p_client_id and r.campaign = u.campaign
                                 and r.date_from = per.ms and r.date_to between per.me - 1 and per.me order by r.date_to desc limit 1)
    end) as reach
    from units u join lines l on l.id = u.line_id cross join per group by 1
  )
  select l.id, l.section, l.network, l.channel, l.flight_type, l.campaign_label, l.start_date, l.end_date, l.budget_total,
    l.m_level, l.confirmed,
    (select array_agg(u.campaign || coalesce(' / ' || u.sub, '') order by u.spend desc) from units u where u.line_id = l.id),
    round(a.spend, 2), a.impressions, a.clicks, round(a.clicks / nullif(a.impressions, 0) * 100, 2), r.reach,
    t.tx, round(t.rev, 2), round(t.rev / nullif(a.spend, 0), 2), round(a.conversions, 1),
    l.reported_spend, l.reported_impressions, l.reported_clicks, l.reported_reach, l.reported_conversions, l.reported_revenue,
    l.reported_installs, l.m_note
  from lines l
  left join (select line_id, sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions from units group by 1) a on a.line_id = l.id
  left join (select line_id, sum(tx) tx, sum(rev) rev from ga group by 1) t on t.line_id = l.id
  left join rch r on r.line_id = l.id
  order by case l.section when 'ecomm' then 0 else 1 end, l.network, l.start_date nulls last, l.campaign_label
$function$;
