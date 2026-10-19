-- Past actions of a client, for "Dupliraj prošlu akciju": the campaigns that ran for a limited time (a flight of up to
-- 60 days that started after the data window opened or ended before yesterday), with what is inside them, the latest
-- Google settings and the landing pages. Always-on campaigns are left out, and so are the social team's boosts and app
-- campaigns on Meta. The app groups the campaigns into actions by start date.
create or replace function public.past_actions(p_client_id uuid, p_days int default 180)
returns jsonb language sql stable set search_path = public as $function$
  with win as (
    select greatest(current_date - p_days,
             coalesce((select min(report_date) from google_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days), current_date)) as g0,
           greatest(current_date - p_days,
             coalesce((select min(report_date) from facebook_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days), current_date)) as m0
  ), c as (
    select 'google' as network, campaign, max(campaign_type) as ctype, min(report_date) as s, max(report_date) as e, sum(spend) as spend,
           sum(conversion_value) as value
    from google_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0
    group by campaign
    union all
    select 'meta', campaign, max(objective), min(report_date), max(report_date), sum(spend), sum(conversion_value)
    from facebook_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0
      and campaign !~* '^(social|app)\M|boost'
    group by campaign
  ), f as materialized (
    select c.* from c, win
    where c.e - c.s <= 60
      and (c.s > (case when c.network = 'google' then win.g0 else win.m0 end) + 2 or c.e < current_date - 2)
  ), kids as materialized (
    select 'google' as network, campaign, asset_group_name as name, sum(spend) as spend, 'asset_group' as kind
    from google_asset_group_metrics where client_id = p_client_id and report_date >= current_date - p_days and campaign in (select campaign from f where network = 'google')
    group by 1, 2, 3
    union all
    select 'google', campaign, ad_group_name, sum(spend), 'ad_group'
    from google_ad_group_metrics where client_id = p_client_id and report_date >= current_date - p_days and campaign in (select campaign from f where network = 'google')
    group by 1, 2, 3
    union all
    select 'meta', campaign, adset_name, sum(spend), 'ad_set'
    from meta_ad_set_metrics where client_id = p_client_id and report_date >= current_date - p_days and campaign in (select campaign from f where network = 'meta')
    group by 1, 2, 3
  ), ads as materialized (
    select campaign, adset_name, array_agg(distinct ad_name) as ads
    from facebook_ads_creatives where client_id = p_client_id and report_date >= current_date - p_days and campaign in (select campaign from f where network = 'meta')
    group by 1, 2
  ), gs as (
    select distinct on (campaign) campaign, campaign_id, daily_budget, budget_type, bidding_strategy_type, target_roas, target_cpa, campaign_status
    from google_campaign_settings where client_id = p_client_id and campaign in (select campaign from f where network = 'google')
    order by campaign, snapshot_date desc
  ), urls as materialized (
    select campaign, final_url, count(*) as n
    from google_search_ads where client_id = p_client_id and snapshot_date >= current_date - p_days and final_url is not null
      and campaign in (select campaign from f where network = 'google')
    group by 1, 2
  ), kj as (
    select k.network, k.campaign, jsonb_agg(jsonb_build_object('kind', k.kind, 'name', k.name, 'spend', round(k.spend, 2), 'ads', to_jsonb(a.ads)) order by k.spend desc) as children
    from kids k left join ads a on k.network = 'meta' and a.campaign = k.campaign and a.adset_name = k.name
    where k.spend > 0
    group by 1, 2
  ), u1 as (
    select distinct on (campaign) campaign, final_url from urls order by campaign, n desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'network', f.network, 'campaign', f.campaign, 'type', f.ctype, 'start', f.s, 'end', f.e, 'days', f.e - f.s + 1,
    'spend', round(f.spend, 2), 'value', round(f.value, 2),
    'campaign_id', gs.campaign_id, 'daily_budget', gs.daily_budget, 'budget_type', gs.budget_type, 'bidding', gs.bidding_strategy_type,
    'target_roas', gs.target_roas, 'target_cpa', gs.target_cpa, 'status', gs.campaign_status,
    'final_url', u1.final_url, 'children', coalesce(kj.children, '[]'::jsonb)
  ) order by f.s desc, f.network, f.spend desc), '[]'::jsonb)
  from f left join gs on f.network = 'google' and gs.campaign = f.campaign
    left join u1 on f.network = 'google' and u1.campaign = f.campaign
    left join kj on kj.network = f.network and kj.campaign = f.campaign
$function$;

grant execute on function public.past_actions(uuid, int) to authenticated;
