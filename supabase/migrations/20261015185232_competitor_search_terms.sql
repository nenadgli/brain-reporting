-- Search terms of the last p_days days that contain one of the given names (competitors), summed per campaign and
-- term. One light query (LIKE filter, then grouping); the morning review does the word matching and the proposals.
create or replace function public.competitor_search_terms(p_client_id uuid, p_names text[], p_days int default 30)
returns table (campaign text, term text, spend numeric, clicks bigint)
language sql stable set search_path = public as $$
  select t.campaign, lower(t.search_term), sum(t.spend), sum(t.clicks)::bigint
  from google_ads_search_terms t
  where t.client_id = p_client_id and t.report_date > current_date - p_days
    and lower(t.search_term) like any (select '%' || lower(n) || '%' from unnest(p_names) n)
  group by 1, 2
$$;
