-- One action ("Black Friday", "Vikend -20%") planned as a copy of a past one: every campaign, asset group and ad set to
-- create, with the source it copies, the new name, dates, budget, landing page, texts and the images picked, in one row.
-- Today the team carries it out by hand (copy in Editor / Ads Manager); later the Ads APIs create it from the same row,
-- always Paused. status: nacrt -> spremno (checked) -> napravljeno (exists in the account, still Paused) | odbačeno.
create table if not exists public.action_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brief_task_id text,
  brief_title text,
  name text not null,
  start_date date,
  end_date date,
  source jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  copy jsonb not null default '{}'::jsonb,
  images jsonb not null default '[]'::jsonb,
  status text not null default 'nacrt' check (status in ('nacrt', 'spremno', 'napravljeno', 'odbačeno')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists action_plans_client on public.action_plans(client_id, created_at desc);
alter table public.action_plans enable row level security;

create policy "agency action plans read" on public.action_plans for select using (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency action plans insert" on public.action_plans for insert with check (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency action plans update" on public.action_plans for update using (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));
