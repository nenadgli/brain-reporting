-- YouTube video campaign drafts: one new campaign per title and goal, the way the team builds them
-- for Editus films ("FILM (Mkt:HR;Ct:Video_Reach;Ph:All)" with a Combo ad group on target CPM, and
-- "FILM (Mkt:HR;Ct:Video_Views;Ph:All)" with a responsive video ad on target CPV), with a campaign
-- total budget and flight dates. Exported to Google Ads Editor as Paused; nothing is published.

create table if not exists public.video_campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  goal text not null check (goal in ('reach', 'views')),
  title text not null,
  campaign_name text not null,
  ad_group_name text not null,
  start_date date not null,
  end_date date not null,
  total_budget numeric not null check (total_budget > 0),
  target_bid numeric,
  locations text[] not null default '{}',
  languages text[] not null default '{}',
  final_url text not null,
  video_ids text[] not null default '{}',
  headlines text[] not null default '{}',
  long_headlines text[] not null default '{}',
  descriptions text[] not null default '{}',
  call_to_action text,
  brief_task_id text,
  status text not null default 'draft' check (status in ('draft','exported','published','rejected')),
  created_by text,
  created_at timestamptz not null default now(),
  exported_at timestamptz,
  published_at timestamptz,
  check (end_date >= start_date)
);
create index if not exists video_campaign_drafts_client_idx on public.video_campaign_drafts(client_id, created_at desc);
alter table public.video_campaign_drafts enable row level security;
create policy "scoped video drafts read" on public.video_campaign_drafts for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and (current_user_client_id() is null or c.id = current_user_client_id())));
create policy "agency video drafts insert" on public.video_campaign_drafts for insert with check (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency video drafts update" on public.video_campaign_drafts for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
grant select, insert, update on public.video_campaign_drafts to authenticated;

-- Recent video campaigns of a client as a reference for budgets and flights of the next title.
create or replace function public.video_campaign_history(p_client_id uuid)
returns table (campaign text, first_date date, last_date date, days int, spend numeric, impressions bigint, clicks bigint)
language sql stable security invoker set search_path = public as $$
  select m.campaign, min(m.report_date), max(m.report_date), (max(m.report_date) - min(m.report_date) + 1)::int,
         round(sum(m.spend)), sum(m.impressions)::bigint, sum(m.clicks)::bigint
  from google_ads_metrics m
  where m.client_id = p_client_id and m.campaign_type = 'VIDEO' and m.report_date > current_date - 120
  group by m.campaign
  order by max(m.report_date) desc
  limit 20
$$;
grant execute on function public.video_campaign_history(uuid) to authenticated;
