alter table ga4_metrics add column medium text;

create or replace function ga4_paid_channel_verification(p_client_id uuid, p_start date, p_end date)
returns table(channel text, sessions numeric, total_users numeric, engaged_sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select
    case when source = 'google' then 'google' when source = 'facebook' then 'meta' else source end,
    sum(sessions), sum(total_users), sum(engaged_sessions), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
    and source in ('google', 'facebook')
    and medium in ('cpc', 'paid', 'paid_social')
  group by case when source = 'google' then 'google' when source = 'facebook' then 'meta' else source end;
$$;

-- New vs returning users, blended across the whole site (retention proxy)
create or replace function ga4_new_vs_returning_trend(p_client_id uuid, p_start date, p_end date)
returns table(report_date date, new_users numeric, returning_users numeric)
language sql stable as $$
  select report_date, sum(new_users), greatest(sum(total_users) - sum(new_users), 0)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by report_date order by report_date;
$$;

-- Engagement quality by channel (which channels bring traffic that actually behaves well on-site)
create or replace function ga4_engagement_by_channel(p_client_id uuid, p_start date, p_end date, p_limit int default 8)
returns table(source text, sessions numeric, engaged_sessions numeric, bounce_rate numeric, conversions numeric)
language sql stable as $$
  select coalesce(source, '(not set)'), sum(sessions), sum(engaged_sessions),
    case when sum(sessions) > 0 then sum(bounce_rate * sessions) / sum(sessions) else null end,
    sum(conversions)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(source, '(not set)')
  order by sum(sessions) desc
  limit p_limit;
$$;

grant execute on function ga4_paid_channel_verification(uuid, date, date) to anon, authenticated;
grant execute on function ga4_new_vs_returning_trend(uuid, date, date) to anon, authenticated;
grant execute on function ga4_engagement_by_channel(uuid, date, date, int) to anon, authenticated;
