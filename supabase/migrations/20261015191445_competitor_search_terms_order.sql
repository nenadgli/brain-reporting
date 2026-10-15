-- Stable order, so the morning review can read the result in pages (the API returns at most 1000 rows per call).
create or replace function public.competitor_search_terms(p_client_id uuid, p_names text[], p_days int default 30)
returns table (campaign text, term text, spend numeric, clicks bigint)
language sql stable set search_path = public as $$
  select t.campaign, lower(t.search_term), sum(t.spend), sum(t.clicks)::bigint
  from google_ads_search_terms t
  where t.client_id = p_client_id and t.report_date > current_date - p_days
    and lower(t.search_term) like any (select '%' || lower(n) || '%' from unnest(p_names) n)
  group by 1, 2
  order by 1, 2
$$;
