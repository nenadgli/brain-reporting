-- New granularity tables
create table meta_ad_set_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  adset_name text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_masm_client_date on meta_ad_set_metrics(client_id, report_date);

create table google_ad_group_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  ad_group_name text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_gagm_client_date on google_ad_group_metrics(client_id, report_date);

create table google_asset_group_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  campaign text not null,
  asset_group_name text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_gagrm_client_date on google_asset_group_metrics(client_id, report_date);

alter table meta_ad_set_metrics enable row level security;
alter table google_ad_group_metrics enable row level security;
alter table google_asset_group_metrics enable row level security;

create policy "scoped meta_ad_set_metrics access" on meta_ad_set_metrics for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
create policy "scoped google_ad_group_metrics access" on google_ad_group_metrics for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
create policy "scoped google_asset_group_metrics access" on google_asset_group_metrics for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));

-- Report structure config: which real campaigns map to which display row, at what level
create table fashion_rs_report_rows (
  id uuid primary key default gen_random_uuid(),
  row_order int not null,
  row_label text not null,
  channel text not null,
  level text not null check (level in ('campaign', 'meta_ad_set', 'google_ad_group', 'asset_group')),
  campaign_names text[] not null,
  note text
);
