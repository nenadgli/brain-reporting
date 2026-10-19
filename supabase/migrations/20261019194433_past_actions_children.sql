-- Past actions also inside always-on campaigns: an action usually gets its own asset group in a running PMax campaign
-- and its own ad sets in the running Meta campaigns (ADV, remarketing, collection). Such an ad set or asset group,
-- running for a limited time, comes back as its own row (always_on true, with only that child), so the app groups it
-- into the action by its dates like a campaign of its own.
create or replace function public.past_actions(p_client_id uuid, p_days int default 180)
returns jsonb language sql stable set search_path = public as $function$
  with win as (
    select greatest(current_date - p_days,
             coalesce((select min(report_date) from google_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days), current_date)) as g0,
           greatest(current_date - p_days,
             coalesce((select min(report_date) from facebook_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days), current_date)) as m0
  ), c as materialized (
    select 'google' as network, campaign, max(campaign_type) as ctype, min(report_date) as s, max(report_date) as e, sum(spend) as spend,
           sum(conversion_value) as value
    from google_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0
    group by campaign
    union all
    select 'meta', campaign, max(objective), min(report_date), max(report_date), sum(spend), sum(conversion_value)
    from facebook_ads_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0
      and campaign !~* '^(social|app)\M|boost'
    group by campaign
  ), k as materialized (
    select 'google' as network, campaign, asset_group_name as name, 'asset_group' as kind, min(report_date) as s, max(report_date) as e, sum(spend) as spend
    from google_asset_group_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0 and asset_group_name is not null
    group by 2, 3
    union all
    select 'google', campaign, ad_group_name, 'ad_group', min(report_date), max(report_date), sum(spend)
    from google_ad_group_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0 and ad_group_name is not null
    group by 2, 3
    union all
    select 'meta', campaign, adset_name, 'ad_set', min(report_date), max(report_date), sum(spend)
    from meta_ad_set_metrics where client_id = p_client_id and report_date >= current_date - p_days and spend > 0 and adset_name is not null
    group by 2, 3
  ), cf as (
    -- a campaign, or a child, that ran for a limited time
    select c.*, (c.e - c.s <= 60 and (c.s > (case when c.network = 'google' then win.g0 else win.m0 end) + 2 or c.e < current_date - 2)) as flight
    from c, win
  ), kf as (
    select k.*, (k.e - k.s <= 60 and (k.s > (case when k.network = 'google' then win.g0 else win.m0 end) + 2 or k.e < current_date - 2)) as flight
    from k, win
  ), ads as materialized (
    select campaign, adset_name, array_agg(distinct ad_name) as ads
    from facebook_ads_creatives where client_id = p_client_id and report_date >= current_date - p_days
    group by 1, 2
  ), gs as (
    select distinct on (campaign) campaign, campaign_id, daily_budget, budget_type, bidding_strategy_type, target_roas, target_cpa, campaign_status
    from google_campaign_settings where client_id = p_client_id
    order by campaign, snapshot_date desc
  ), urls as (
    select distinct on (campaign) campaign, final_url
    from (select campaign, final_url, count(*) as n from google_search_ads
          where client_id = p_client_id and snapshot_date >= current_date - p_days and final_url is not null group by 1, 2) x
    order by campaign, n desc
  ), kid as (
    select kf.*, jsonb_build_object('kind', kf.kind, 'name', kf.name, 'start', kf.s, 'end', kf.e, 'spend', round(kf.spend, 2), 'ads', to_jsonb(a.ads)) as j
    from kf left join ads a on kf.network = 'meta' and a.campaign = kf.campaign and a.adset_name = kf.name
  ), kagg as (
    select network, campaign, jsonb_agg(j order by spend desc) as children from kid group by 1, 2
  ), rows as (
    -- a flighted campaign with everything in it
    select cf.network, cf.campaign, cf.ctype, cf.s, cf.e, cf.spend, cf.value, false as always_on,
           coalesce(kagg.children, '[]'::jsonb) as children
    from cf left join kagg on kagg.network = cf.network and kagg.campaign = cf.campaign
    where cf.flight
    union all
    -- a flighted asset group or ad set inside an always-on campaign
    select kid.network, kid.campaign, cf.ctype, kid.s, kid.e, kid.spend, null, true, jsonb_build_array(kid.j)
    from kid join cf on cf.network = kid.network and cf.campaign = kid.campaign
    where not cf.flight and kid.flight
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'network', r.network, 'campaign', r.campaign, 'type', r.ctype, 'start', r.s, 'end', r.e, 'days', r.e - r.s + 1,
    'spend', round(r.spend, 2), 'value', round(r.value, 2), 'always_on', r.always_on,
    'campaign_id', gs.campaign_id, 'daily_budget', gs.daily_budget, 'budget_type', gs.budget_type, 'bidding', gs.bidding_strategy_type,
    'target_roas', gs.target_roas, 'target_cpa', gs.target_cpa, 'status', gs.campaign_status,
    'final_url', u.final_url, 'children', r.children
  ) order by r.s desc, r.network, r.spend desc), '[]'::jsonb)
  from rows r
    left join gs on r.network = 'google' and gs.campaign = r.campaign
    left join urls u on r.network = 'google' and u.campaign = r.campaign
$function$;
