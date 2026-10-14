-- Kvartalno osvežavanje Search oglasa. search-ads-sync stores every responsive search ad weekly with
-- its headlines and descriptions, Google's label per asset (BEST/GOOD/LOW/LEARNING), Ad Strength and
-- the last 30 days' results. rsa_refresh_candidates() picks the ads worth refreshing; Claude writes
-- replacement texts into rsa_refresh_drafts, exported as a new Paused ad for Google Ads Editor.

create table if not exists public.google_search_ads (
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id),
  snapshot_date date not null,
  ad_id text not null,
  campaign text not null,
  ad_group text,
  ad_status text,
  ad_strength text,
  headlines jsonb not null default '[]',
  descriptions jsonb not null default '[]',
  path1 text,
  path2 text,
  final_url text,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  created_at timestamptz not null default now(),
  primary key (client_id, snapshot_date, ad_id)
);
alter table public.google_search_ads enable row level security;
create policy "agency search ads read" on public.google_search_ads for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select on public.google_search_ads to authenticated;

create table if not exists public.rsa_refresh_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  ad_id text not null,
  campaign text not null,
  ad_group text not null,
  final_url text not null,
  path1 text,
  path2 text,
  -- [{text, pin (1-3 or null), source: kept|new, replaces (old text) or null}]
  headlines jsonb not null default '[]',
  descriptions jsonb not null default '[]',
  reasons text[] not null default '{}',
  rationale text,
  status text not null default 'draft' check (status in ('draft', 'exported', 'rejected')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  exported_at timestamptz
);
create index if not exists rsa_refresh_drafts_client_idx on public.rsa_refresh_drafts(client_id, created_at desc);
alter table public.rsa_refresh_drafts enable row level security;
create policy "agency rsa drafts read" on public.rsa_refresh_drafts for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency rsa drafts insert" on public.rsa_refresh_drafts for insert with check (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency rsa drafts update" on public.rsa_refresh_drafts for update using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select, insert, update on public.rsa_refresh_drafts to authenticated;

-- Enabled ads from each client's latest snapshot that spent in the last 30 days and need work:
-- Ad Strength Poor/Average, assets Google labels LOW, or fewer than 10 headlines / 4 descriptions.
-- Ads with a draft from the last 60 days are left out. p_client_id null: all clients the caller may see.
create or replace function public.rsa_refresh_needed(p_client_id uuid default null)
returns table (
  client_id uuid, ad_id text, campaign text, ad_group text, ad_strength text, n_headlines int, n_descriptions int,
  low_headlines text[], low_descriptions text[], best_assets text[], reasons text[],
  impressions numeric, clicks numeric, ctr numeric, spend numeric, conversions numeric, roas numeric, snapshot_date date
)
language sql stable security definer set search_path = public as $$
  with snap as (
    select a.client_id, max(a.snapshot_date) as d from google_search_ads a
    where (p_client_id is null or a.client_id = p_client_id)
      -- Agency users see their own agency's clients; the service role sees all.
      and (coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') = 'service_role'
           or (current_user_client_id() is null and a.client_id in (select c.id from clients c where c.agency_id = current_user_agency_id())))
    group by 1
  ), ads as (
    select a.*,
      jsonb_array_length(a.headlines) as nh, jsonb_array_length(a.descriptions) as nd,
      array(select h->>'text' from jsonb_array_elements(a.headlines) h where h->>'label' = 'LOW') as low_h,
      array(select h->>'text' from jsonb_array_elements(a.descriptions) h where h->>'label' = 'LOW') as low_d,
      array(select h->>'text' from jsonb_array_elements(a.headlines || a.descriptions) h where h->>'label' = 'BEST') as best
    from google_search_ads a join snap s on s.client_id = a.client_id and s.d = a.snapshot_date
    where a.ad_status = 'ENABLED' and a.spend > 0
  ), live as (
    -- Campaigns paused or removed since stop spending; only campaigns with spend in the last 7 days count.
    select distinct m.client_id, m.campaign from google_ads_metrics m
    where m.report_date > current_date - 8 and m.spend > 0 and (p_client_id is null or m.client_id = p_client_id)
  )
  select x.client_id, x.ad_id, x.campaign, x.ad_group, x.ad_strength, x.nh, x.nd, x.low_h, x.low_d, x.best, r.reasons,
         x.impressions, x.clicks, round(x.clicks / nullif(x.impressions, 0) * 100, 2), round(x.spend, 2), round(x.conversions, 1),
         round(x.conversion_value / nullif(x.spend, 0), 2), x.snapshot_date
  from ads x
  join live l on l.client_id = x.client_id and l.campaign = x.campaign
  cross join lateral (select array_remove(array[
      case when x.ad_strength in ('POOR', 'AVERAGE') then 'ad_strength' end,
      case when cardinality(x.low_h) + cardinality(x.low_d) > 0 then 'low_assets' end,
      case when x.nh < 10 or x.nd < 4 then 'malo_asseta' end], null) as reasons) r
  where cardinality(r.reasons) > 0
    and not exists (select 1 from rsa_refresh_drafts d where d.client_id = x.client_id and d.ad_id = x.ad_id
                    and d.status <> 'rejected' and d.created_at > now() - interval '60 days')
  order by x.client_id, x.spend desc
$$;

-- The screen's list for one client, checked against the caller's agency.
create or replace function public.rsa_refresh_candidates(p_client_id uuid)
returns table (
  ad_id text, campaign text, ad_group text, ad_strength text, n_headlines int, n_descriptions int,
  low_headlines text[], low_descriptions text[], best_assets text[], reasons text[],
  impressions numeric, clicks numeric, ctr numeric, spend numeric, conversions numeric, roas numeric, snapshot_date date
)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'rsa_refresh_candidates: not allowed';
  end if;
  return query select n.ad_id, n.campaign, n.ad_group, n.ad_strength, n.n_headlines, n.n_descriptions, n.low_headlines, n.low_descriptions,
                      n.best_assets, n.reasons, n.impressions, n.clicks, n.ctr, n.spend, n.conversions, n.roas, n.snapshot_date
               from rsa_refresh_needed(p_client_id) n;
end $$;
grant execute on function public.rsa_refresh_candidates(uuid) to authenticated;

-- Search ads are synced weekly with the placements.
create or replace function public.enqueue_weekly_sync()
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sync_queue (fn, body)
  select distinct x.fn, jsonb_build_object('client_id', ds.client_id, 'date_preset', 'last_30d')
  from data_sources ds cross join (values ('placements-sync'), ('search-ads-sync')) x(fn)
  where ds.provider = 'google_ads' and ds.windsor_connection_id is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- The task board learns the quarterly Search ad refresh: ads waiting for it are its open items.
create or replace function public.ppc_task_board(p_asof date default null)
returns table (client_id uuid, client_name text, task text, applies boolean, last_done timestamptz, open_items int, status text)
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_asof, current_date);
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_user_client_id() is not null then
    raise exception 'ppc_task_board: not allowed';
  end if;
  return query
  with cl as (
    select c.id, c.name,
           exists (select 1 from data_sources s where s.client_id = c.id and s.provider = 'google_ads') as has_google,
           exists (select 1 from data_sources s where s.client_id = c.id and s.provider = 'ga4') as has_ga4
    from clients c join review_settings r on r.client_id = c.id and r.enabled
    where c.agency_id = coalesce(current_user_agency_id(), c.agency_id)
  ), tasks(task, cadence) as (values
    ('provera_budzeta', 3), ('optimizacija_budzeta', 10), ('provera_naloga', 7), ('search_terms', 14),
    ('disapproved', 7), ('recommendations', 7), ('placements', 7), ('ga4', 7), ('mesecna_potrosnja', 31), ('kampanje', null),
    ('alokacija_budzeta', null), ('osvezavanje_oglasa', 90)
  ), log as (
    select w.client_id, w.task, max(w.at) as last_done from ppc_work_log(d - 120, d) w group by 1, 2
  ), open_findings as (
    select f.client_id, ppc_task_of_check(f.check_type) as task, count(*)::int as n
    from review_findings f
    where f.status = 'novo' and f.run_date > d - 7
    group by 1, 2
  ), open_drafts as (
    select x.client_id, count(*)::int as n from (
      select p.client_id from pmax_asset_group_drafts p where p.status in ('draft', 'exported')
      union all select g.client_id from demand_gen_drafts g where g.status in ('draft', 'exported')
      union all select v.client_id from video_campaign_drafts v where v.status in ('draft', 'exported')
      union all select s.client_id from display_ad_drafts s where s.status in ('draft', 'exported')
      union all select a.client_id from automation_drafts a where a.kind = 'campaign' and a.status in ('draft', 'exported')
    ) x group by 1
  ), alloc as (
    -- Latest approved allocation per client, by the month it is for.
    select p.client_id, max(p.month) as month, max(p.approved_at) as approved_at
    from allocation_proposals p where p.status = 'approved' group by 1
  ), rsa_open as (
    select x.client_id, count(*)::int as n from rsa_refresh_needed() x group by 1
  ), spend_month as (
    -- The monthly spend report covers every client at once.
    select max(a.created_at) as last_done from ppc_actions a where a.task = 'mesecna_potrosnja'
  )
  select cl.id, cl.name, t.task,
         case when t.task in ('search_terms', 'disapproved', 'recommendations', 'placements', 'optimizacija_budzeta', 'osvezavanje_oglasa') then cl.has_google
              when t.task = 'ga4' then cl.has_ga4 else true end,
         case when t.task = 'mesecna_potrosnja' then (select sm.last_done from spend_month sm)
              when t.task = 'alokacija_budzeta' then al.approved_at else l.last_done end,
         coalesce(case when t.task = 'kampanje' then od.n when t.task = 'osvezavanje_oglasa' then ro.n else ofi.n end, 0),
         case
           when t.task = 'kampanje' then case when coalesce(od.n, 0) > 0 then 'ceka' else 'u_roku' end
           -- Next month's allocation is due from the 25th; the current month's is late after the 3rd.
           when t.task = 'alokacija_budzeta' then
             case when al.month >= (date_trunc('month', d) + interval '1 month')::date then 'u_roku'
                  when al.month = date_trunc('month', d)::date then case when extract(day from d) >= 25 then 'uskoro' else 'u_roku' end
                  when extract(day from d) <= 3 then 'uskoro' else 'kasni' end
           when t.task = 'mesecna_potrosnja' then
             case when (select sm.last_done from spend_month sm) >= date_trunc('month', d) then 'u_roku'
                  when extract(day from d) <= 5 then 'uskoro' else 'kasni' end
           when l.last_done is null then 'nikad'
           when l.last_done::date >= d - t.cadence then 'u_roku'
           else 'kasni' end
  from cl cross join tasks t
  left join log l on l.client_id = cl.id and l.task = t.task
  left join open_findings ofi on ofi.client_id = cl.id and ofi.task = t.task
  left join open_drafts od on od.client_id = cl.id
  left join alloc al on al.client_id = cl.id
  left join rsa_open ro on ro.client_id = cl.id
  order by cl.name, t.task;
end $$;

grant execute on function public.ppc_work_log(date, date, uuid), public.ppc_task_board(date) to authenticated;