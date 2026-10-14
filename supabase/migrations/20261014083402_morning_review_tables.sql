create table if not exists public.review_settings (
  client_id uuid primary key references public.clients(id) on delete cascade,
  enabled boolean not null default true,
  params jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists public.review_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  run_date date not null,
  data_date date,
  status text not null default 'running' check (status in ('running','done','failed')),
  error text,
  candidates int,
  findings int,
  model text,
  team_notes jsonb not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (client_id, run_date)
);
create table if not exists public.review_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.review_runs(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  run_date date not null,
  check_type text not null,
  fingerprint text not null,
  severity text not null check (severity in ('hitno','visoko','srednje','info')),
  impact_eur numeric,
  title text not null,
  detail text,
  proposal text,
  evidence jsonb not null default '{}',
  rank int,
  status text not null default 'novo' check (status in ('novo','odobreno','odbijeno','odlozeno','izvrseno','isteklo')),
  decision_reason text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists review_findings_client_idx on public.review_findings(client_id, run_date desc);
create index if not exists review_findings_fp_idx on public.review_findings(client_id, fingerprint);
alter table public.review_settings enable row level security;
alter table public.review_runs enable row level security;
alter table public.review_findings enable row level security;
-- Everything in the morning review is internal to the agency.
create policy "agency review settings read" on public.review_settings for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency review settings update" on public.review_settings for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency review runs read" on public.review_runs for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency review runs update" on public.review_runs for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency review findings read" on public.review_findings for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency review findings update" on public.review_findings for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
grant select, update on public.review_settings, public.review_runs, public.review_findings to authenticated;

-- Phase 1: F&F RS only. Values are the proposals from the questionnaire; the team corrects them.
insert into public.review_settings (client_id, params)
select c.id, jsonb_build_object(
  'productive_project_id', '189010',
  'pacing_tolerance', 0.15,
  'spend_anomaly', 0.5,
  'spend_anomaly_min_eur', 20,
  'conv_drop', 0.4,
  'conv_drop_min_baseline', 10,
  'tracking_min_spend_eur', 50,
  'waste_min_spend_eur', 15,
  'waste_days', 30,
  'max_findings', 7,
  'cooldown_days', 14,
  'brief_lead_days', 3,
  'exclude_campaign_patterns', jsonb_build_array('^Social_', 'App', 'Ct:Awareness'),
  'protected_terms', jsonb_build_array('fashion and friends', 'fashion&friends', 'fashion friends', 'f&f', 'fandf', 'kiko'),
  'competitors', jsonb_build_array('n fashion', 'nfashion', 'stradivarius', 'massimo dutti', 'reserved', 'mohito', 'p s fashion', 'ps fashion', 'xyz', 'blondy', 'zara', 'h&m', 'bershka', 'pull&bear', 'lc waikiki', 'sinsay', 'about you'),
  'brands_sold', jsonb_build_array('guess', 'calvin klein', 'tommy hilfiger', 'replay', 'bata', 'steve madden', 'premiata', 'levis', 'levi''s', 'diesel', 'camper', 'liu jo', 'desigual', 'superdry', 'new balance', 'miss sixty', 'moschino', 'ugg', 'inuikii', 'wellensteyn', 'mango')
)
from public.clients c where c.name ilike 'fashion%friends%rs%'
on conflict (client_id) do nothing;