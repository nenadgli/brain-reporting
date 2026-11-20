-- Windsor returns campaign_lifetime_budget in whole currency units (e.g. 250 = 250 EUR, matches the spend of awareness
-- campaigns), while campaign_daily_budget, adset_daily_budget and adset_lifetime_budget come in cents. Same view, only
-- campaign_lifetime_eur is no longer divided by 100.
create or replace view public.meta_adsets with (security_invoker = true) as
select distinct on (s.client_id, s.adset_id)
  s.client_id, c.name as client, s.account_id, s.campaign_id, s.campaign, s.campaign_status, s.campaign_objective,
  s.campaign_daily_budget / 100 as campaign_daily_eur, s.campaign_lifetime_budget as campaign_lifetime_eur, s.campaign_bid_strategy,
  (coalesce(s.campaign_daily_budget, 0) + coalesce(s.campaign_lifetime_budget, 0)) > 0 as cbo,
  s.adset_id, s.adset_name, s.adset_status, s.adset_daily_budget / 100 as adset_daily_eur, s.adset_lifetime_budget / 100 as adset_lifetime_eur,
  s.adset_bid_strategy, s.adset_optimization_goal, s.adset_start_time, s.adset_end_time,
  s.adset_promoted_object, s.adset_attribution_spec, s.adset_targeting,
  (select count(*) from meta_structure x where x.data_source_id = s.data_source_id and x.adset_id = s.adset_id) as ads,
  (select round(sum(x.spend), 2) from meta_structure x where x.data_source_id = s.data_source_id and x.adset_id = s.adset_id) as spend,
  (select string_agg(distinct x.url_tags, ' || ') from meta_structure x where x.data_source_id = s.data_source_id and x.adset_id = s.adset_id) as url_tags,
  s.window_from, s.window_to, s.synced_at
from meta_structure s join clients c on c.id = s.client_id
order by s.client_id, s.adset_id, s.spend desc nulls last;
