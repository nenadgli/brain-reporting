alter table clients
  add column if not exists automation_enabled boolean not null default false,
  add column if not exists automation_mode text not null default 'suggest' check (automation_mode in ('suggest','apply'));

create table if not exists automation_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('campaign','ad_group','rsa','keyword','negative_keyword')),
  campaign_name text not null check (campaign_name like 'LB\_%'),
  ad_group_name text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','approved','exported','published','rejected')),
  created_by text,
  created_at timestamptz not null default now(),
  exported_at timestamptz,
  published_at timestamptz
);
create index if not exists automation_drafts_client_status on automation_drafts(client_id, status);

create table if not exists automation_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  rule_type text not null check (rule_type in ('budget_pacing','pause_at_100','sku_segment','customizer','alarm')),
  params jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists automation_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  source text not null,
  action text not null,
  target text,
  old_value jsonb,
  new_value jsonb,
  mode text check (mode in ('suggest','apply')),
  created_at timestamptz not null default now()
);
create index if not exists automation_log_client_time on automation_log(client_id, created_at desc);

create table if not exists sku_performance (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete cascade,
  report_date date not null,
  campaign text not null,
  item_id text not null,
  product_title text,
  brand text,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (client_id, report_date, campaign, item_id)
);
create index if not exists sku_performance_client_date on sku_performance(client_id, report_date);

do $$
declare t text;
begin
  foreach t in array array['automation_drafts','automation_rules','automation_log','sku_performance'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy "scoped %1$s access" on %1$I for select using (client_id is null or client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())))$p$, t);
  end loop;
  foreach t in array array['automation_drafts','automation_rules'] loop
    execute format($p$create policy "scoped %1$s insert" on %1$I for insert with check (client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null))$p$, t);
    execute format($p$create policy "scoped %1$s update" on %1$I for update using (client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null))$p$, t);
  end loop;
end $$;