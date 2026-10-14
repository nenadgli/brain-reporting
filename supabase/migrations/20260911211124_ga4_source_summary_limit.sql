create or replace function ga4_source_summary(p_client_id uuid, p_start date, p_end date, p_limit int default 15)
returns table(source text, sessions numeric, total_users numeric, engaged_sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select coalesce(source, '(not set)'), sum(sessions), sum(total_users), sum(engaged_sessions), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(source, '(not set)')
  order by sum(sessions) desc
  limit p_limit;
$$;
grant execute on function ga4_source_summary(uuid, date, date, int) to anon, authenticated;
