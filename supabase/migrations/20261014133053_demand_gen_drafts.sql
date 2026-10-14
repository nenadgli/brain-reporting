-- Demand Gen ad group drafts: for every action (Productive brief) the team adds a new ad group
-- named "<akcija> (Tg:Mix)" to the existing Demand Gen campaign, next to the PMax asset group.
-- Drafts are exported to Google Ads Editor as Paused; nothing is published from Brain.

create table if not exists public.demand_gen_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_name text not null,
  ad_group_name text not null,
  copy_settings_from text,
  final_url text not null,
  headlines text[] not null default '{}',
  long_headlines text[] not null default '{}',
  descriptions text[] not null default '{}',
  business_name text,
  call_to_action text,
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
create index if not exists demand_gen_drafts_client_idx on public.demand_gen_drafts(client_id, created_at desc);
alter table public.demand_gen_drafts enable row level security;
create policy "scoped demand gen drafts read" on public.demand_gen_drafts for select using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and (current_user_client_id() is null or c.id = current_user_client_id())));
create policy "agency demand gen drafts insert" on public.demand_gen_drafts for insert with check (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
create policy "agency demand gen drafts update" on public.demand_gen_drafts for update using (
  client_id in (select c.id from clients c where c.agency_id = current_user_agency_id() and current_user_client_id() is null));
grant select, insert, update on public.demand_gen_drafts to authenticated;

-- Existing Demand Gen campaigns of a client with their ad groups, newest first.
-- security invoker: RLS on the metrics tables decides what the caller sees.
create or replace function public.demand_gen_campaigns(p_client_id uuid)
returns table (campaign text, last_date date, spend_30d numeric, ad_groups text[])
language sql stable security invoker set search_path = public as $$
  with dg as (
    select distinct m.campaign from google_ads_metrics m
    where m.client_id = p_client_id and m.campaign_type = 'DEMAND_GEN' and m.report_date > current_date - 180
  ), groups as (
    select a.campaign, a.ad_group_name, max(a.report_date) as last_date,
           coalesce(sum(a.spend) filter (where a.report_date > current_date - 30), 0) as spend_30d
    from google_ad_group_metrics a join dg on dg.campaign = a.campaign
    where a.client_id = p_client_id and a.report_date > current_date - 180
    group by a.campaign, a.ad_group_name
  )
  select g.campaign, max(g.last_date), round(sum(g.spend_30d)),
         array_agg(g.ad_group_name order by g.last_date desc)
  from groups g
  group by g.campaign
  order by max(g.last_date) desc, 3 desc
$$;
grant execute on function public.demand_gen_campaigns(uuid) to authenticated;
