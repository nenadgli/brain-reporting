create table google_ads_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  campaign_type text,
  device text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  search_impression_share numeric,
  search_lost_is_budget numeric,
  search_lost_is_rank numeric,
  quality_score numeric,
  created_at timestamptz not null default now()
);

create index idx_google_ads_metrics_client_date on google_ads_metrics(client_id, report_date);
create index idx_google_ads_metrics_source on google_ads_metrics(data_source_id);

alter table google_ads_metrics enable row level security;

-- Same pattern as report_metrics: scoped to the logged-in user's agency once auth exists.
create policy "scoped google_ads_metrics access"
  on google_ads_metrics for select
  using (
    client_id in (
      select id from clients
      where agency_id = current_user_agency_id()
        and (current_user_client_id() is null or id = current_user_client_id())
    )
  );

-- TEMPORARY demo policy (same caveat as other demo policies elsewhere) — agency-wide
-- anon read until real auth is wired up.
create policy "demo anon read google_ads_metrics whole agency" on google_ads_metrics for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
