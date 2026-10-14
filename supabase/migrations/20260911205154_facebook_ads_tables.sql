create table facebook_ads_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  objective text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  reach numeric not null default 0,
  frequency numeric,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  roas numeric,
  created_at timestamptz not null default now()
);
create index idx_fam_client_date on facebook_ads_metrics(client_id, report_date);

create table facebook_ads_placements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  device_platform text,
  publisher_platform text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  reach numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_fap_client_date on facebook_ads_placements(client_id, report_date);

create table facebook_ads_creatives (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  adset_name text,
  ad_name text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_fac_client_date on facebook_ads_creatives(client_id, report_date);

alter table facebook_ads_metrics enable row level security;
alter table facebook_ads_placements enable row level security;
alter table facebook_ads_creatives enable row level security;

create policy "scoped facebook_ads_metrics access" on facebook_ads_metrics for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
create policy "scoped facebook_ads_placements access" on facebook_ads_placements for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
create policy "scoped facebook_ads_creatives access" on facebook_ads_creatives for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));

-- TEMPORARY demo policies (same caveat as elsewhere)
create policy "demo anon read facebook_ads_metrics whole agency" on facebook_ads_metrics for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
create policy "demo anon read facebook_ads_placements whole agency" on facebook_ads_placements for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
create policy "demo anon read facebook_ads_creatives whole agency" on facebook_ads_creatives for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));

-- Aggregation functions (mirrors the google_ads_* set)
create or replace function facebook_ads_daily_trend(p_client_id uuid, p_start date, p_end date)
returns table(report_date date, spend numeric, conversions numeric)
language sql stable as $$
  select report_date, sum(spend), sum(conversions)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by report_date order by report_date;
$$;

create or replace function facebook_ads_period_totals(p_client_id uuid, p_start date, p_end date)
returns table(impressions numeric, clicks numeric, spend numeric, reach numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select coalesce(sum(impressions),0), coalesce(sum(clicks),0), coalesce(sum(spend),0), coalesce(sum(reach),0),
         coalesce(sum(conversions),0), coalesce(sum(conversion_value),0)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end;
$$;

create or replace function facebook_ads_campaign_summary(p_client_id uuid, p_start date, p_end date)
returns table(campaign text, objective text, impressions numeric, clicks numeric, spend numeric, reach numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select campaign, max(objective), sum(impressions), sum(clicks), sum(spend), sum(reach), sum(conversions), sum(conversion_value)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by campaign order by sum(spend) desc;
$$;

create or replace function facebook_ads_objective_summary(p_client_id uuid, p_start date, p_end date)
returns table(objective text, spend numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select coalesce(objective, 'OSTALO'), sum(spend), sum(clicks), sum(conversions), sum(conversion_value)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(objective, 'OSTALO') order by sum(spend) desc;
$$;

create or replace function facebook_ads_platform_summary(p_client_id uuid, p_start date, p_end date)
returns table(publisher_platform text, spend numeric, clicks numeric, impressions numeric, reach numeric)
language sql stable as $$
  select coalesce(publisher_platform, 'other'), sum(spend), sum(clicks), sum(impressions), sum(reach)
  from facebook_ads_placements
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(publisher_platform, 'other') order by sum(spend) desc;
$$;

create or replace function facebook_ads_device_summary(p_client_id uuid, p_start date, p_end date)
returns table(device_platform text, spend numeric, clicks numeric, impressions numeric)
language sql stable as $$
  select coalesce(device_platform, 'other'), sum(spend), sum(clicks), sum(impressions)
  from facebook_ads_placements
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(device_platform, 'other') order by sum(spend) desc;
$$;

create or replace function facebook_ads_top_creatives(p_client_id uuid, p_start date, p_end date, p_limit int default 20)
returns table(ad_name text, adset_name text, campaign text, impressions numeric, clicks numeric, spend numeric)
language sql stable as $$
  select coalesce(ad_name, '(bez imena)'), max(adset_name), max(campaign), sum(impressions), sum(clicks), sum(spend)
  from facebook_ads_creatives
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(ad_name, '(bez imena)')
  order by sum(spend) desc
  limit p_limit;
$$;

grant execute on function facebook_ads_daily_trend(uuid, date, date) to anon, authenticated;
grant execute on function facebook_ads_period_totals(uuid, date, date) to anon, authenticated;
grant execute on function facebook_ads_campaign_summary(uuid, date, date) to anon, authenticated;
grant execute on function facebook_ads_objective_summary(uuid, date, date) to anon, authenticated;
grant execute on function facebook_ads_platform_summary(uuid, date, date) to anon, authenticated;
grant execute on function facebook_ads_device_summary(uuid, date, date) to anon, authenticated;
grant execute on function facebook_ads_top_creatives(uuid, date, date, int) to anon, authenticated;
