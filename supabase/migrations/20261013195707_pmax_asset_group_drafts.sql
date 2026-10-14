create table if not exists public.pmax_asset_group_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_name text not null,
  asset_group_name text not null,
  final_url text not null,
  path1 text,
  path2 text,
  headlines text[] not null default '{}',
  long_headlines text[] not null default '{}',
  descriptions text[] not null default '{}',
  business_name text,
  call_to_action text,
  search_themes text[] not null default '{}',
  images jsonb not null default '[]',
  video_ids text[] not null default '{}',
  brief_task_id text,
  brief_title text,
  start_date date,
  end_date date,
  status text not null default 'draft' check (status in ('draft','exported','published','rejected')),
  created_by text,
  created_at timestamptz not null default now(),
  exported_at timestamptz,
  published_at timestamptz
);
create index if not exists pmax_asset_group_drafts_client_idx on public.pmax_asset_group_drafts(client_id, created_at desc);
alter table public.pmax_asset_group_drafts enable row level security;
create policy "scoped pmax drafts read" on public.pmax_asset_group_drafts for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and (current_user_client_id() is null or c.id = current_user_client_id())));
create policy "agency pmax drafts insert" on public.pmax_asset_group_drafts for insert with check (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency pmax drafts update" on public.pmax_asset_group_drafts for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
grant select, insert, update on public.pmax_asset_group_drafts to authenticated;