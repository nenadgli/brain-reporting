-- Meta campaigns prepared from Productive briefs: one row per campaign (settings, ad sets, ads in payload).
-- They leave Brain only as an Ads Manager bulk import file, everything Paused; several can go into one file.
create table if not exists public.meta_campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brief_task_id text,
  name text not null,
  status text not null default 'nacrt' check (status in ('nacrt', 'odobreno', 'izvezeno', 'odbijeno')),
  payload jsonb not null default '{}'::jsonb,
  comment text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  exported_at timestamptz
);
create index if not exists meta_campaign_drafts_client on public.meta_campaign_drafts(client_id, status, created_at desc);
alter table public.meta_campaign_drafts enable row level security;

create policy "agency meta drafts read" on public.meta_campaign_drafts for select using (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency meta drafts insert" on public.meta_campaign_drafts for insert with check (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency meta drafts update" on public.meta_campaign_drafts for update using (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));
