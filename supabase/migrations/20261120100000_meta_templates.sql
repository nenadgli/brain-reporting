-- Meta builder: line type of every F&F Meta campaign, and the template ad set per market and type = the most recently started
-- ad set of that type (a new promo ad set is a copy of it). Read only, from meta_structure.
create or replace view public.meta_campaign_types with (security_invoker = true) as
select distinct a.client_id, a.client, a.campaign_id, a.campaign, a.campaign_objective, a.cbo,
  case when a.campaign ~* '^Social' then 'social'
       when a.campaign_objective in ('APP_INSTALLS', 'OUTCOME_APP_PROMOTION') then 'app'
       when a.campaign ~* 'remarketing' then 'remarketing'
       when a.campaign ~* '^ADV_Akcije' then 'conversion'
       when a.campaign ~* '^Collection' then 'traffic'
       when a.campaign_objective = 'OUTCOME_AWARENESS' then 'awareness'
       when a.campaign ~* '^Univerzal' then 'always_on'
       when a.campaign ~* '^KIKO' then 'kiko'
       when a.campaign ~* '^Main' then 'main'
       else 'other' end as line_type
from meta_adsets a;

create or replace view public.meta_template_adsets with (security_invoker = true) as
select distinct on (x.client_id, x.line_type, x.add_to_cart) x.*
from (
  select a.client_id, a.client, t.line_type, coalesce(a.adset_promoted_object->>'custom_event_type' = 'ADD_TO_CART', false) as add_to_cart,
    a.campaign_id, a.campaign, a.cbo, a.adset_id, a.adset_name, a.adset_start_time, a.adset_end_time,
    a.adset_daily_eur, a.adset_lifetime_eur, a.adset_optimization_goal, a.adset_promoted_object, a.adset_attribution_spec,
    coalesce((a.adset_targeting->'targeting_automation'->>'advantage_audience') = '1', false) as advantage_audience, a.ads, a.url_tags
  from meta_adsets a join meta_campaign_types t on t.client_id = a.client_id and t.campaign_id = a.campaign_id
  where t.line_type in ('conversion', 'remarketing', 'traffic', 'awareness')
) x
order by x.client_id, x.line_type, x.add_to_cart, x.adset_start_time desc nulls last;
