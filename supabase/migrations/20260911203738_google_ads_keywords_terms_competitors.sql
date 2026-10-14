create table google_ads_keywords (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  keyword_text text not null,
  keyword_match_type text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  quality_score numeric,
  created_at timestamptz not null default now()
);
create index idx_gakw_client_date on google_ads_keywords(client_id, report_date);

create table google_ads_search_terms (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  search_term text not null,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_gast_client_date on google_ads_search_terms(client_id, report_date);

create table google_ads_competitors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  domain text not null,
  created_at timestamptz not null default now()
);
create index idx_gac_client_date on google_ads_competitors(client_id, report_date);

alter table google_ads_keywords enable row level security;
alter table google_ads_search_terms enable row level security;
alter table google_ads_competitors enable row level security;

create policy "scoped google_ads_keywords access" on google_ads_keywords for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
create policy "scoped google_ads_search_terms access" on google_ads_search_terms for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
create policy "scoped google_ads_competitors access" on google_ads_competitors for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));

-- TEMPORARY demo policies (same caveat as elsewhere)
create policy "demo anon read google_ads_keywords whole agency" on google_ads_keywords for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
create policy "demo anon read google_ads_search_terms whole agency" on google_ads_search_terms for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
create policy "demo anon read google_ads_competitors whole agency" on google_ads_competitors for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
