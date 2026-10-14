create or replace function owned_channel_period_totals(p_client_id uuid, p_start date, p_end date)
returns table(source text, sessions numeric, total_users numeric, engaged_sessions numeric, conversions numeric, total_revenue numeric, campaign_count bigint)
language sql stable as $$
  select source, sum(sessions), sum(total_users), sum(engaged_sessions), sum(conversions), sum(total_revenue), count(distinct campaign)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
    and source in ('push_notification', 'newsletter')
  group by source;
$$;

create or replace function owned_channel_daily_trend(p_client_id uuid, p_start date, p_end date)
returns table(report_date date, source text, sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select report_date, source, sum(sessions), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
    and source in ('push_notification', 'newsletter')
  group by report_date, source
  order by report_date;
$$;

create or replace function owned_channel_top_campaigns(p_client_id uuid, p_start date, p_end date, p_source text, p_limit int default 20)
returns table(campaign text, sessions numeric, total_users numeric, engaged_sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select campaign, sum(sessions), sum(total_users), sum(engaged_sessions), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end and source = p_source
  group by campaign
  order by sum(total_revenue) desc, sum(sessions) desc
  limit p_limit;
$$;

-- Auto-classify newsletter campaigns into flow types by naming pattern
create or replace function owned_channel_type_summary(p_client_id uuid, p_start date, p_end date, p_source text)
returns table(campaign_type text, sessions numeric, total_users numeric, conversions numeric, total_revenue numeric, campaign_count bigint)
language sql stable as $$
  select
    case
      when p_source = 'newsletter' and campaign ilike 'AbandCart%' then 'Napušteta korpa (automatizacija)'
      when p_source = 'newsletter' then 'Broadcast newsletter'
      else 'Push kampanja'
    end,
    sum(sessions), sum(total_users), sum(conversions), sum(total_revenue), count(distinct campaign)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end and source = p_source
  group by 1
  order by sum(total_revenue) desc;
$$;

create or replace function owned_channel_date_range(p_client_id uuid)
returns table(min_date date, max_date date)
language sql stable as $$
  select min(report_date), max(report_date) from ga4_metrics
  where client_id = p_client_id and source in ('push_notification', 'newsletter');
$$;

grant execute on function owned_channel_period_totals(uuid, date, date) to anon, authenticated;
grant execute on function owned_channel_daily_trend(uuid, date, date) to anon, authenticated;
grant execute on function owned_channel_top_campaigns(uuid, date, date, text, int) to anon, authenticated;
grant execute on function owned_channel_type_summary(uuid, date, date, text) to anon, authenticated;
grant execute on function owned_channel_date_range(uuid) to anon, authenticated;
