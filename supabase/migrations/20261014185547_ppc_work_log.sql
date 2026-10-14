-- Where the team's work in Brain shows up, per recurring Productive task:
--   ppc_actions        downloads and exports the database cannot see otherwise (Editor CSVs, spend report)
--   *_by columns       who drafted, exported and published each campaign draft
--   ppc_work_log()     one log of decisions, budgets, drafts and exports ("Urađeno")
--   ppc_task_board()   per client and task: last done, open items, on time or late ("Taskovi")

create table if not exists public.ppc_actions (
  id bigserial primary key,
  client_id uuid references public.clients(id) on delete cascade,
  task text not null,
  action text not null,
  detail jsonb not null default '{}',
  user_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ppc_actions_created_idx on public.ppc_actions(created_at desc);
alter table public.ppc_actions enable row level security;
create policy "agency ppc actions read" on public.ppc_actions for select using (
  current_user_client_id() is null and (client_id is null or client_id in (select id from clients where agency_id = current_user_agency_id())));
create policy "agency ppc actions insert" on public.ppc_actions for insert with check (
  current_user_client_id() is null and (client_id is null or client_id in (select id from clients where agency_id = current_user_agency_id())));
grant select, insert on public.ppc_actions to authenticated;
grant usage on sequence public.ppc_actions_id_seq to authenticated;

-- Who drafted, exported and published. Exports run in edge functions with the user's own JWT, so
-- auth.uid() inside the trigger is the person who clicked.
create or replace function public.set_draft_actor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by_user := coalesce(new.created_by_user, auth.uid());
  elsif new.status is distinct from old.status then
    if new.status = 'exported' then new.exported_by := auth.uid(); end if;
    if new.status = 'published' then new.published_by := auth.uid(); end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['automation_drafts', 'pmax_asset_group_drafts', 'demand_gen_drafts', 'video_campaign_drafts', 'display_ad_drafts'] loop
    execute format('alter table public.%I add column if not exists created_by_user uuid, add column if not exists exported_by uuid, add column if not exists published_by uuid', t);
    execute format('create or replace trigger %I before insert or update on public.%I for each row execute function public.set_draft_actor()', t || '_actor', t);
  end loop;
end $$;

-- Productive task each review check belongs to.
create or replace function public.ppc_task_of_check(p_check text) returns text
language sql immutable as $$
  select case
    when p_check in ('pacing', 'campaign_budgets', 'meta_cap') then 'provera_budzeta'
    when p_check = 'search_terms' then 'search_terms'
    when p_check = 'ads_policy' then 'disapproved'
    when p_check = 'recommendations' then 'recommendations'
    when p_check = 'placements' then 'placements'
    when p_check = 'ga4_tracking' then 'ga4'
    else 'provera_naloga' end
$$;

create or replace function public.ppc_work_log(p_from date, p_to date, p_client_id uuid default null)
returns table (at timestamptz, client_id uuid, client_name text, task text, action text, detail text, user_email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_user_client_id() is not null then
    raise exception 'ppc_work_log: not allowed';
  end if;
  return query
  with ev as (
    select f.decided_at as at, f.client_id, ppc_task_of_check(f.check_type) as task, f.status as action, f.title as detail, f.decided_by as uid
    from review_findings f where f.decided_at is not null and f.status in ('odobreno', 'odbijeno', 'odlozeno', 'izvrseno')
    union all
    select b.updated_at, b.client_id, 'optimizacija_budzeta', 'budzet_unet', b.network || ' · ' || b.campaign || ': ' || b.monthly_budget, b.updated_by
    from campaign_budgets b
    union all
    select a.created_at, a.client_id, a.task, a.action, coalesce(a.detail->>'text', a.detail::text), a.user_id from ppc_actions a
    union all
    select x.at, x.client_id, 'kampanje', x.action, x.detail, x.uid from (
      select d.created_at as at, d.client_id, 'nacrt' as action, 'PMax · ' || d.asset_group_name as detail, d.created_by_user as uid from pmax_asset_group_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'PMax · ' || d.asset_group_name, d.exported_by from pmax_asset_group_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'PMax · ' || d.asset_group_name, d.published_by from pmax_asset_group_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Demand Gen · ' || d.ad_group_name, d.created_by_user from demand_gen_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'Demand Gen · ' || d.ad_group_name, d.exported_by from demand_gen_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Demand Gen · ' || d.ad_group_name, d.published_by from demand_gen_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Video · ' || d.campaign_name, d.created_by_user from video_campaign_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'Video · ' || d.campaign_name, d.exported_by from video_campaign_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Video · ' || d.campaign_name, d.published_by from video_campaign_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Display · ' || d.ad_group_name, d.created_by_user from display_ad_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'Display · ' || d.ad_group_name, d.exported_by from display_ad_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Display · ' || d.ad_group_name, d.published_by from display_ad_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Search · ' || d.campaign_name, d.created_by_user from automation_drafts d where d.kind = 'campaign'
      union all select d.exported_at, d.client_id, 'izvezeno', 'Search · ' || d.campaign_name, d.exported_by from automation_drafts d where d.kind = 'campaign' and d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Search · ' || d.campaign_name, d.published_by from automation_drafts d where d.kind = 'campaign' and d.published_at is not null
    ) x
  )
  select ev.at, ev.client_id, c.name, ev.task, ev.action, ev.detail, u.email
  from ev
  left join clients c on c.id = ev.client_id
  left join app_users u on u.id = ev.uid
  where ev.at >= p_from and ev.at < p_to + 1
    and (p_client_id is null or ev.client_id = p_client_id)
    and (ev.client_id is null or c.agency_id = coalesce(current_user_agency_id(), c.agency_id))
  order by ev.at desc;
end $$;

-- Per client and recurring task: when it was last done in Brain, what is waiting, and whether it is
-- on time against the cadence of the Productive task (budget check Mon/Wed/Fri, budget optimisation
-- about every 10 days, search terms twice a month, weekly checks, monthly spend by the 5th).
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
    ('disapproved', 7), ('recommendations', 7), ('placements', 7), ('ga4', 7), ('mesecna_potrosnja', 31), ('kampanje', null)
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
  ), spend_month as (
    -- The monthly spend report covers every client at once.
    select max(a.created_at) as last_done from ppc_actions a where a.task = 'mesecna_potrosnja'
  )
  select cl.id, cl.name, t.task,
         case when t.task in ('search_terms', 'disapproved', 'recommendations', 'placements', 'optimizacija_budzeta') then cl.has_google
              when t.task = 'ga4' then cl.has_ga4 else true end,
         case when t.task = 'mesecna_potrosnja' then (select sm.last_done from spend_month sm) else l.last_done end,
         coalesce(case when t.task = 'kampanje' then od.n else ofi.n end, 0),
         case
           when t.task = 'kampanje' then case when coalesce(od.n, 0) > 0 then 'ceka' else 'u_roku' end
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
  order by cl.name, t.task;
end $$;

grant execute on function public.ppc_work_log(date, date, uuid), public.ppc_task_board(date) to authenticated;
