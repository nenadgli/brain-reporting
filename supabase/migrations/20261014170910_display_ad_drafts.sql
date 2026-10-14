-- Responsive display ad drafts, the two ways the team builds Display:
--   ad_group: a new ad group per action, brand or collection in an existing Display campaign
--             (KIKO Tof/Bof, Movem Flight, Planika Brendovi), one draft per target campaign;
--   campaign: a new campaign per title with a daily budget and flight dates (Editus films).
-- Exported to Google Ads Editor as Paused; nothing is published from Brain.

create table if not exists public.display_ad_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  mode text not null check (mode in ('ad_group', 'campaign')),
  campaign_name text not null,
  ad_group_name text not null,
  daily_budget numeric,
  start_date date,
  end_date date,
  locations text[] not null default '{}',
  languages text[] not null default '{}',
  final_url text not null,
  headlines text[] not null default '{}',
  long_headline text not null,
  descriptions text[] not null default '{}',
  business_name text not null,
  call_to_action text,
  images jsonb not null default '[]',
  video_ids text[] not null default '{}',
  brief_task_id text,
  brief_title text,
  status text not null default 'draft' check (status in ('draft','exported','published','rejected')),
  created_by text,
  created_at timestamptz not null default now(),
  exported_at timestamptz,
  published_at timestamptz,
  check (mode = 'ad_group' or (daily_budget > 0 and start_date is not null))
);
create index if not exists display_ad_drafts_client_idx on public.display_ad_drafts(client_id, created_at desc);
alter table public.display_ad_drafts enable row level security;
create policy "scoped display drafts read" on public.display_ad_drafts for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and (current_user_client_id() is null or c.id = current_user_client_id())));
create policy "agency display drafts insert" on public.display_ad_drafts for insert with check (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency display drafts update" on public.display_ad_drafts for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
grant select, insert, update on public.display_ad_drafts to authenticated;

-- Display campaigns built by hand (not dynamic remarketing) with their ad groups, newest first.
create or replace function public.display_campaigns(p_client_id uuid)
returns table (campaign text, last_date date, spend_30d numeric, ad_groups text[])
language sql stable security invoker set search_path = public as $$
  with dc as (
    select distinct m.campaign from google_ads_metrics m
    where m.client_id = p_client_id and m.campaign_type = 'DISPLAY' and m.campaign !~* 'Display_Dyn'
      and m.report_date > current_date - 180
  ), groups as (
    select a.campaign, a.ad_group_name, max(a.report_date) as last_date,
           coalesce(sum(a.spend) filter (where a.report_date > current_date - 30), 0) as spend_30d
    from google_ad_group_metrics a join dc on dc.campaign = a.campaign
    where a.client_id = p_client_id and a.report_date > current_date - 180
    group by a.campaign, a.ad_group_name
  )
  select g.campaign, max(g.last_date), round(sum(g.spend_30d)), array_agg(g.ad_group_name order by g.last_date desc)
  from groups g
  group by g.campaign
  order by max(g.last_date) desc, 3 desc
$$;
grant execute on function public.display_campaigns(uuid) to authenticated;
