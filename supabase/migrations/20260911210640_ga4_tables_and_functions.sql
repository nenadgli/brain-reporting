create table ga4_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  source text,
  campaign text,
  store text,
  sessions numeric not null default 0,
  total_users numeric not null default 0,
  new_users numeric not null default 0,
  engaged_sessions numeric not null default 0,
  engagement_rate numeric,
  bounce_rate numeric,
  conversions numeric not null default 0,
  total_revenue numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_ga4_client_date on ga4_metrics(client_id, report_date);

alter table ga4_metrics enable row level security;

create policy "scoped ga4_metrics access" on ga4_metrics for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));

create policy "demo anon read ga4_metrics whole agency" on ga4_metrics for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));

create or replace function ga4_daily_trend(p_client_id uuid, p_start date, p_end date)
returns table(report_date date, sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select report_date, sum(sessions), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by report_date order by report_date;
$$;

create or replace function ga4_period_totals(p_client_id uuid, p_start date, p_end date)
returns table(sessions numeric, total_users numeric, new_users numeric, engaged_sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select coalesce(sum(sessions),0), coalesce(sum(total_users),0), coalesce(sum(new_users),0),
         coalesce(sum(engaged_sessions),0), coalesce(sum(conversions),0), coalesce(sum(total_revenue),0)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end;
$$;

create or replace function ga4_source_summary(p_client_id uuid, p_start date, p_end date)
returns table(source text, sessions numeric, total_users numeric, engaged_sessions numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select coalesce(source, '(not set)'), sum(sessions), sum(total_users), sum(engaged_sessions), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(source, '(not set)')
  order by sum(sessions) desc;
$$;

create or replace function ga4_campaign_summary(p_client_id uuid, p_start date, p_end date, p_limit int default 20)
returns table(campaign text, source text, sessions numeric, total_users numeric, conversions numeric, total_revenue numeric)
language sql stable as $$
  select campaign, max(source), sum(sessions), sum(total_users), sum(conversions), sum(total_revenue)
  from ga4_metrics
  where client_id = p_client_id and report_date between p_start and p_end
    and campaign is not null and campaign not in ('(direct)', '(not set)')
  group by campaign
  order by sum(sessions) desc
  limit p_limit;
$$;

create or replace function ga4_date_range(p_client_id uuid)
returns table(min_date date, max_date date)
language sql stable as $$
  select min(report_date), max(report_date) from ga4_metrics where client_id = p_client_id;
$$;

grant execute on function ga4_daily_trend(uuid, date, date) to anon, authenticated;
grant execute on function ga4_period_totals(uuid, date, date) to anon, authenticated;
grant execute on function ga4_source_summary(uuid, date, date) to anon, authenticated;
grant execute on function ga4_campaign_summary(uuid, date, date, int) to anon, authenticated;
grant execute on function ga4_date_range(uuid) to anon, authenticated;
