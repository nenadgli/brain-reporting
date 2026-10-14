create table public.media_plan_history (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null,
  source_sheet text,
  section text not null,            -- 'ecomm' | 'loyalty'
  network text not null,            -- 'meta' | 'google' | 'tiktok' | 'programmatic'
  channel text,                     -- raw plan value, e.g. 'Google Ads (Search)'
  flight_type text,
  funnel text,
  target text,
  ad_set_type text,
  campaign_label text,
  start_date date,
  end_date date,
  budget_regular numeric not null default 0,
  budget_ontop numeric not null default 0,
  budget_flash numeric not null default 0,
  budget_total numeric not null default 0,
  reported_spend numeric,
  reported_impressions numeric,
  reported_clicks numeric,
  reported_reach numeric,
  reported_conversions numeric,
  reported_revenue numeric,
  reported_installs numeric,
  created_at timestamptz not null default now()
);
create index media_plan_history_client_month on public.media_plan_history(client_id, month);
alter table public.media_plan_history enable row level security;
create policy "scoped media_plan_history access" on public.media_plan_history for select using (
  client_id in (select clients.id from clients where clients.agency_id = current_user_agency_id()
    and (current_user_client_id() is null or clients.id = current_user_client_id())));
comment on table public.media_plan_history is 'Full monthly media plans incl. loyalty/TikTok/programmatic and PPC-reported results; media_plan_lines keeps only ecomm Meta+Google lines used by Budget Pacing.';