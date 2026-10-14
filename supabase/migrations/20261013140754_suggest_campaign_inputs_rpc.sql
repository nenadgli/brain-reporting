create or replace function public.suggest_campaign_inputs(p_client_id uuid, p_tokens text[], p_days int default 90)
returns jsonb language sql stable security definer set search_path=public as $$
with since as (select (current_date - p_days) d),
pat as (select coalesce(array_agg('%'||t||'%'), array[]::text[]) p from unnest(p_tokens) t),
st as (
  select search_term, sum(clicks) clicks, sum(spend) spend, sum(conversions) conv, sum(impressions) impr
  from google_ads_search_terms, since, pat
  where client_id=p_client_id and report_date>=since.d
    and (cardinality(pat.p)=0 or lower(search_term) ilike any(pat.p))
  group by 1
),
kw as (
  select lower(keyword_text) keyword_text, keyword_match_type, sum(clicks) clicks, sum(spend) spend, sum(conversions) conv, sum(conversion_value) val
  from google_ads_keywords, since, pat
  where client_id=p_client_id and report_date>=since.d
    and (cardinality(pat.p)=0 or lower(keyword_text) ilike any(pat.p))
  group by 1,2
),
waste as (
  select search_term, sum(clicks) clicks, sum(spend) spend
  from google_ads_search_terms, since
  where client_id=p_client_id and report_date>=since.d
  group by 1 having sum(conversions)=0 and sum(clicks)>=8
)
select jsonb_build_object(
 'search_terms', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from st order by conv desc, clicks desc limit 60) x),'[]'),
 'keywords', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from kw order by conv desc, clicks desc limit 50) x),'[]'),
 'wasted_terms', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from waste order by spend desc limit 40) x),'[]')
);
$$;
revoke all on function public.suggest_campaign_inputs(uuid,text[],int) from public, anon, authenticated;
grant execute on function public.suggest_campaign_inputs(uuid,text[],int) to service_role;