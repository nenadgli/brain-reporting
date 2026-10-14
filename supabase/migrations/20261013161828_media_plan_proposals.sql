create table public.media_plan_proposals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null,
  title text not null,
  assumption text,
  summary text[] not null default '{}',
  checks jsonb not null default '[]',
  status text not null default 'predlog',
  created_at timestamptz not null default now(),
  unique (client_id, month)
);
create table public.media_plan_proposal_lines (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.media_plan_proposals(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  sort int not null default 0,
  network text not null,
  flight_type text,
  ad_set_type text,
  campaign_label text not null,
  start_date date,
  end_date date,
  last_year_spend numeric,
  proposed_budget numeric not null default 0,
  rationale text
);
create index on public.media_plan_proposal_lines(proposal_id);
alter table public.media_plan_proposals enable row level security;
alter table public.media_plan_proposal_lines enable row level security;
do $$ declare t text; begin
  foreach t in array array['media_plan_proposals','media_plan_proposal_lines'] loop
    execute format($p$create policy "scoped %1$s select" on public.%1$s for select using (client_id in (select clients.id from clients where clients.agency_id = current_user_agency_id() and (current_user_client_id() is null or clients.id = current_user_client_id())))$p$, t);
    execute format($p$create policy "scoped %1$s update" on public.%1$s for update to authenticated using (client_id in (select clients.id from clients where clients.agency_id = current_user_agency_id() and current_user_client_id() is null))$p$, t);
  end loop;
end $$;