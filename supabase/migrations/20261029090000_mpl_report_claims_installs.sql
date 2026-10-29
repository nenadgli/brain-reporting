-- MPL report v2 (mpl_report_v2; mpl_report stays until the app moves over, so nothing is dropped).
-- 1. A Google line on a whole campaign (Main FW26 PMax / Demand Gen) no longer also counts the asset groups / ad groups that
--    another line of the month takes (Halloween, Short Sales flights): the campaign line gets the campaign minus those.
-- 2. GA4 for a Google asset group / ad group: the campaign's GA4 of each day times the group's share of that day's campaign
--    spend (GA4 has no asset group or ad group). A group that spent alone that day gets the whole day.
-- 3. Google app installs (platform, conversion actions with install / first open in the name), the PPC team's definition.
alter table public.google_ads_metrics add column if not exists installs numeric;
comment on column public.google_ads_metrics.installs is 'App installs (conversion actions named install / first open), on the same carrier row as conversions.';

create or replace function public.mpl_report_v2(p_client_id uuid, p_month date)
returns table (
  line_id uuid, section text, network text, channel text, flight_type text, campaign_label text, start_date date, end_date date,
  budget_total numeric, map_level text, map_confirmed boolean, matched text[],
  spend numeric, impressions numeric, clicks numeric, ctr numeric, reach numeric,
  transactions numeric, revenue numeric, roas numeric, platform_conversions numeric, installs numeric,
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
    select l.id as line_id, l.network, l.m_level, b.campaign, b.sub, b.report_date, b.spend, b.impressions, b.clicks, b.conversions, b.installs
    from lines l cross join per
    cross join lateral (
      select g.campaign, null::text as sub, g.report_date, g.spend, g.impressions, g.clicks, g.conversions, g.installs
        from google_ads_metrics g where l.m_level = 'campaign' and l.network = 'google' and g.client_id = p_client_id
         and g.report_date between per.ms and per.me and g.campaign ~ l.campaign_pattern
      union all
      select a.campaign, a.asset_group_name, a.report_date, a.spend, a.impressions, a.clicks, a.conversions, null
        from google_asset_group_metrics a where l.m_level = 'asset_group' and a.client_id = p_client_id
         and a.report_date between per.ms and per.me and a.campaign ~ l.campaign_pattern and a.asset_group_name ~ coalesce(l.sub_pattern, '')
      union all
      select a.campaign, a.ad_group_name, a.report_date, a.spend, a.impressions, a.clicks, a.conversions, null
        from google_ad_group_metrics a where l.m_level = 'google_ad_group' and a.client_id = p_client_id
         and a.report_date between per.ms and per.me and a.campaign ~ l.campaign_pattern and a.ad_group_name ~ coalesce(l.sub_pattern, '')
      union all
      select f.campaign, null, f.report_date, f.spend, f.impressions, coalesce(f.link_clicks, f.clicks), f.conversions, null
        from facebook_ads_metrics f where l.m_level = 'campaign' and l.network = 'meta' and f.client_id = p_client_id
         and f.report_date between per.ms and per.me and f.campaign ~ l.campaign_pattern
      union all
      select s.campaign, s.adset_name, s.report_date, s.spend, s.impressions, coalesce(s.link_clicks, s.clicks), s.conversions, null
        from meta_ad_set_metrics s where l.m_level = 'meta_ad_set' and s.client_id = p_client_id
         and s.report_date between per.ms and per.me and s.campaign ~ l.campaign_pattern and s.adset_name ~ coalesce(l.sub_pattern, '')
    ) b
  ),
  g_day as (  -- Google campaign spend and GA4 per day, for the GA4 share of asset groups / ad groups
    select c.campaign, c.report_date, c.spend, coalesce(ga.tx, 0) as tx, coalesce(ga.rev, 0) as rev
    from (select g.campaign, g.report_date, sum(g.spend) as spend from google_ads_metrics g, per
          where g.client_id = p_client_id and g.report_date between per.ms and per.me group by 1, 2) c
    left join (select g.campaign, g.report_date, sum(g.transactions) as tx, sum(g.total_revenue) as rev from ga4_metrics g, per
               where g.client_id = p_client_id and g.report_date between per.ms and per.me and g.source = 'google' and g.medium = 'cpc'
               group by 1, 2) ga using (campaign, report_date)
  ),
  sub_g as (  -- Google asset group / ad group rows with their GA4 share
    select b.*, d.tx * b.spend / nullif(d.spend, 0) as tx, d.rev * b.spend / nullif(d.spend, 0) as rev
    from base b left join g_day d on d.campaign = b.campaign and d.report_date = b.report_date
    where b.network = 'google' and b.sub is not null
  ),
  claimed as (  -- what the asset group / ad group lines take out of each Google campaign
    select campaign, sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks, sum(conversions) as conversions,
           sum(tx) as tx, sum(rev) as rev
    from (select distinct on (campaign, sub, report_date) * from sub_g) s group by 1
  ),
  units as (  -- matched campaigns / ad sets / asset groups
    select b.line_id, b.network, b.campaign, b.sub,
           sum(b.spend) as spend, sum(b.impressions) as impressions, sum(b.clicks) as clicks, sum(b.conversions) as conversions,
           sum(b.installs) as installs
    from base b group by 1, 2, 3, 4
    having sum(b.spend) > 0 or sum(b.impressions) > 0
  ),
  units_net as (  -- a Google whole-campaign unit minus what the group lines took
    select u.line_id, u.network, u.campaign, u.sub,
           u.spend - case when u.network = 'google' and u.sub is null then coalesce(c.spend, 0) else 0 end as spend,
           u.impressions - case when u.network = 'google' and u.sub is null then coalesce(c.impressions, 0) else 0 end as impressions,
           u.clicks - case when u.network = 'google' and u.sub is null then coalesce(c.clicks, 0) else 0 end as clicks,
           u.conversions - case when u.network = 'google' and u.sub is null then coalesce(c.conversions, 0) else 0 end as conversions,
           u.installs, (u.network = 'google' and u.sub is null and c.spend > 0) as reduced
    from units u left join claimed c on c.campaign = u.campaign
  ),
  ga as (  -- GA4 per unit: Google campaign = its GA4 minus what the group lines took; Google group = its share;
           -- Meta by "campaign--ad set", or for a campaign line by the campaign name with or without the ad set suffix
    select u.line_id, u.campaign, u.sub,
      case when u.network = 'google' and u.sub is not null then
             (select sum(s.tx) from sub_g s where s.line_id = u.line_id and s.campaign = u.campaign and s.sub = u.sub)
           when u.network = 'google' then
             (select sum(d.tx) from g_day d where d.campaign = u.campaign) - coalesce((select c.tx from claimed c where c.campaign = u.campaign), 0)
           else (select sum(g.transactions) from ga4_metrics g, per where g.client_id = p_client_id and g.report_date between per.ms and per.me
                   and case when u.sub is not null then g.campaign = u.campaign || '--' || u.sub
                            else g.campaign = u.campaign or left(g.campaign, length(u.campaign) + 2) = u.campaign || '--' end)
      end as tx,
      case when u.network = 'google' and u.sub is not null then
             (select sum(s.rev) from sub_g s where s.line_id = u.line_id and s.campaign = u.campaign and s.sub = u.sub)
           when u.network = 'google' then
             (select sum(d.rev) from g_day d where d.campaign = u.campaign) - coalesce((select c.rev from claimed c where c.campaign = u.campaign), 0)
           else (select sum(g.total_revenue) from ga4_metrics g, per where g.client_id = p_client_id and g.report_date between per.ms and per.me
                   and case when u.sub is not null then g.campaign = u.campaign || '--' || u.sub
                            else g.campaign = u.campaign or left(g.campaign, length(u.campaign) + 2) = u.campaign || '--' end)
      end as rev
    from units_net u
  ),
  rch as (  -- people for the month; a Google campaign reduced by group lines keeps the whole campaign's unique users
    select u.line_id, sum(case
      when u.network = 'meta' then meta_reach_for(p_client_id, per.ms, per.me, array[u.campaign], u.sub)
      when u.sub is null then (select r.unique_users from google_period_reach r where r.client_id = p_client_id and r.campaign = u.campaign
                                 and r.date_from = per.ms and r.date_to between per.me - 1 and per.me order by r.date_to desc limit 1)
    end) as reach
    from units_net u cross join per group by 1
  )
  select l.id, l.section, l.network, l.channel, l.flight_type, l.campaign_label, l.start_date, l.end_date, l.budget_total,
    l.m_level, l.confirmed,
    (select array_agg(u.campaign || coalesce(' / ' || u.sub, '') || case when u.reduced then ' (bez grupa drugih linija)' else '' end
            order by u.spend desc) from units_net u where u.line_id = l.id),
    round(a.spend, 2), a.impressions, a.clicks, round(a.clicks / nullif(a.impressions, 0) * 100, 2), r.reach,
    round(t.tx, 1), round(t.rev, 2), round(t.rev / nullif(a.spend, 0), 2), round(a.conversions, 1), a.installs,
    l.reported_spend, l.reported_impressions, l.reported_clicks, l.reported_reach, l.reported_conversions, l.reported_revenue,
    l.reported_installs, l.m_note
  from lines l
  left join (select line_id, sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions,
                    sum(installs) installs from units_net group by 1) a on a.line_id = l.id
  left join (select line_id, sum(tx) tx, sum(rev) rev from ga group by 1) t on t.line_id = l.id
  left join rch r on r.line_id = l.id
  order by case l.section when 'ecomm' then 0 else 1 end, l.network, l.start_date nulls last, l.campaign_label
$function$;
