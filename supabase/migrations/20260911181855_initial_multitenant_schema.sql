-- Agencies (top-level tenant, e.g. the marketing agency)
create table agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Clients belong to an agency (e.g. the agency's own clients)
create table clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

-- App users, linked to Supabase auth.users, scoped to an agency and optionally a single client
create table app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  client_id uuid references clients(id) on delete cascade, -- null = agency-level user (sees all clients)
  role text not null default 'client_viewer' check (role in ('agency_admin', 'agency_member', 'client_viewer')),
  email text not null,
  created_at timestamptz not null default now()
);

-- Connected data sources per client (Windsor.ai connections)
create table data_sources (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  provider text not null, -- e.g. 'meta_ads', 'google_ads', 'ga4'
  windsor_connection_id text,
  status text not null default 'pending' check (status in ('pending', 'syncing', 'active', 'error')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

-- Reporting fact table: daily metrics per client per source
create table report_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id) on delete set null,
  report_date date not null,
  channel text not null,
  metric_name text not null,
  metric_value numeric not null default 0,
  created_at timestamptz not null default now()
);

create index idx_report_metrics_client_date on report_metrics(client_id, report_date);
create index idx_clients_agency on clients(agency_id);
create index idx_app_users_agency on app_users(agency_id);

-- Enable RLS
alter table agencies enable row level security;
alter table clients enable row level security;
alter table app_users enable row level security;
alter table data_sources enable row level security;
alter table report_metrics enable row level security;

-- Helper: get current user's agency_id and client_id
create or replace function current_user_agency_id()
returns uuid
language sql
security definer
stable
as $$
  select agency_id from app_users where id = auth.uid()
$$;

create or replace function current_user_client_id()
returns uuid
language sql
security definer
stable
as $$
  select client_id from app_users where id = auth.uid()
$$;

create or replace function current_user_role()
returns text
language sql
security definer
stable
as $$
  select role from app_users where id = auth.uid()
$$;

-- Policies: agencies (user sees only their own agency)
create policy "agency members see own agency"
  on agencies for select
  using (id = current_user_agency_id());

-- Policies: clients (agency-level users see all clients in their agency; client users see only their client)
create policy "scoped client access"
  on clients for select
  using (
    agency_id = current_user_agency_id()
    and (current_user_client_id() is null or id = current_user_client_id())
  );

-- Policies: app_users (users see colleagues in their own agency)
create policy "agency members see each other"
  on app_users for select
  using (agency_id = current_user_agency_id());

-- Policies: data_sources (scoped via client's agency + client match)
create policy "scoped data source access"
  on data_sources for select
  using (
    client_id in (
      select id from clients
      where agency_id = current_user_agency_id()
        and (current_user_client_id() is null or id = current_user_client_id())
    )
  );

-- Policies: report_metrics (scoped via client's agency + client match)
create policy "scoped report metrics access"
  on report_metrics for select
  using (
    client_id in (
      select id from clients
      where agency_id = current_user_agency_id()
        and (current_user_client_id() is null or id = current_user_client_id())
    )
  );
