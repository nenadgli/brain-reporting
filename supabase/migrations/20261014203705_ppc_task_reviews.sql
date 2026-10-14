-- Završeni PPC taskovi. A task for a client counts as done when someone on the team goes through
-- Brain's analysis for it (each finding approved, rejected or postponed, with an optional comment)
-- and closes it with a comment. The closing record keeps a snapshot of the analysis and decisions.
-- Comments on findings and on closed tasks are what the morning review learns from.

create table if not exists public.ppc_task_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  task text not null,
  period_from date,
  period_to date,
  findings jsonb not null default '[]',
  n_findings int not null default 0,
  n_approved int not null default 0,
  n_rejected int not null default 0,
  n_postponed int not null default 0,
  n_open int not null default 0,
  comment text not null check (length(trim(comment)) > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists ppc_task_reviews_client_idx on public.ppc_task_reviews(client_id, task, created_at desc);
alter table public.ppc_task_reviews enable row level security;
create policy "agency task reviews read" on public.ppc_task_reviews for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency task reviews insert" on public.ppc_task_reviews for insert with check (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select, insert on public.ppc_task_reviews to authenticated;

-- Brain's analysis for one task of one client: findings of the checks behind that task from the last
-- p_days, open ones first.
create or replace function public.ppc_task_findings(p_client_id uuid, p_task text, p_days int default 14)
returns setof public.review_findings
language plpgsql stable security definer set search_path = public as $$
begin
  if not (current_user_client_id() is null
          and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'ppc_task_findings: not allowed';
  end if;
  return query
  select f.* from review_findings f
  where f.client_id = p_client_id and ppc_task_of_check(f.check_type) = p_task and f.run_date > current_date - p_days
  order by (f.status = 'novo') desc, f.run_date desc, f.rank;
end $$;
grant execute on function public.ppc_task_findings(uuid, text, int) to authenticated;

-- Closed tasks in a period, with who closed them.
create or replace function public.ppc_task_reviews_list(p_from date, p_to date, p_client_id uuid default null)
returns table (id uuid, client_id uuid, client_name text, task text, created_at timestamptz, user_email text,
               n_findings int, n_approved int, n_rejected int, n_postponed int, n_open int, comment text, findings jsonb)
language sql stable security definer set search_path = public as $$
  select r.id, r.client_id, c.name, r.task, r.created_at, u.email, r.n_findings, r.n_approved, r.n_rejected, r.n_postponed, r.n_open, r.comment, r.findings
  from ppc_task_reviews r join clients c on c.id = r.client_id left join app_users u on u.id = r.created_by
  where r.created_at >= p_from and r.created_at < p_to + 1
    and (p_client_id is null or r.client_id = p_client_id)
    and current_user_client_id() is null and c.agency_id = current_user_agency_id()
  order by r.created_at desc
$$;
grant execute on function public.ppc_task_reviews_list(date, date, uuid) to authenticated;

-- The task board: a task is done when it was closed in "PPC taskovi"; decisions and exports alone
-- no longer count. Monthly spend and allocation keep their own rules.
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
    select r.client_id, r.task, max(r.created_at) as last_done from ppc_task_reviews r group by 1, 2
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
    select p.client_id, max(p.month) as month, max(p.approved_at) as approved_at
    from allocation_proposals p where p.status = 'approved' group by 1
  ), rsa_open as (
    select x.client_id, count(*)::int as n from rsa_refresh_needed() x group by 1
  ), spend_month as (
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
