-- Monthly budget allocation ("Mesečna alokacija budžeta i analiza performansa kampanja"): Brain
-- proposes next month's budget per campaign from the month total (media plan or the team's number),
-- recent spend, ROAS/CPA and budget-limited impression share; the team edits and approves, and the
-- approved amounts go to campaign_budgets. allocation_inputs() computes every number.

create table if not exists public.allocation_proposals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  totals jsonb not null default '{}',
  lines jsonb not null default '[]',
  summary text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz
);
create index if not exists allocation_proposals_client_idx on public.allocation_proposals(client_id, month desc);
alter table public.allocation_proposals enable row level security;
create policy "agency allocation read" on public.allocation_proposals for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency allocation insert" on public.allocation_proposals for insert with check (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency allocation update" on public.allocation_proposals for update using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select, insert, update on public.allocation_proposals to authenticated;

-- Per campaign of a client: spend last month and in the same month last year, the last 30 days'
-- spend, value, conversions and ROAS, the last 7 days (still running?), budget-lost impression share
-- and today's daily budget. Campaigns outside PPC (review_settings exclude patterns) are left out.
create or replace function public.allocation_inputs(p_client_id uuid, p_month date)
returns table (
  network text, campaign text, campaign_type text, daily_budget numeric,
  spend_last_month numeric, spend_ly_month numeric, spend_30d numeric, value_30d numeric, conversions_30d numeric,
  roas_30d numeric, cpa_30d numeric, spend_7d numeric, lost_is_budget numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  m date := date_trunc('month', p_month)::date;
  lm date := (date_trunc('month', p_month) - interval '1 month')::date;
  ly date := (date_trunc('month', p_month) - interval '1 year')::date;
  d date;
  excl text;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'allocation_inputs: not allowed';
  end if;
  d := (select max(x) from (
         select max(g.report_date) as x from google_ads_metrics g where g.client_id = p_client_id
         union all select max(f.report_date) from facebook_ads_metrics f where f.client_id = p_client_id) t);
  if d is null then return; end if;
  select coalesce(string_agg(x, '|'), '^\b$') into excl
  from review_settings r, jsonb_array_elements_text(r.params->'exclude_campaign_patterns') x where r.client_id = p_client_id;
  excl := coalesce(excl, '^\b$');

  return query
  with daily as (
    select 'google'::text as net, g.campaign as camp, max(g.campaign_type) as ctype, g.report_date as day,
           sum(g.spend) as spend, sum(g.conversion_value) as val, sum(g.conversions) as conv, avg(g.search_lost_is_budget) as lost
    from google_ads_metrics g
    where g.client_id = p_client_id and g.campaign !~ excl
      and (g.report_date between least(lm, d - 29) and d or g.report_date between ly and (ly + interval '1 month - 1 day')::date)
    group by g.campaign, g.report_date
    union all
    select 'meta', f.campaign, max(f.objective), f.report_date, sum(f.spend), sum(f.conversion_value), sum(f.conversions), null
    from facebook_ads_metrics f
    where f.client_id = p_client_id and f.campaign !~ excl
      and (f.report_date between least(lm, d - 29) and d or f.report_date between ly and (ly + interval '1 month - 1 day')::date)
    group by f.campaign, f.report_date
  ), agg as (
    select x.net, x.camp, max(x.ctype) as ctype,
           sum(x.spend) filter (where x.day >= lm and x.day < m) as lmo,
           sum(x.spend) filter (where x.day >= ly and x.day < (ly + interval '1 month')::date) as lyo,
           sum(x.spend) filter (where x.day > d - 30) as sp30,
           sum(x.val) filter (where x.day > d - 30) as val30,
           sum(x.conv) filter (where x.day > d - 30) as conv30,
           sum(x.spend) filter (where x.day > d - 7) as sp7,
           avg(x.lost) filter (where x.day > d - 7) as lost7
    from daily x group by x.net, x.camp
  ), budgets as (
    select distinct on (s.campaign) s.campaign, s.daily_budget
    from google_campaign_settings s where s.client_id = p_client_id order by s.campaign, s.snapshot_date desc
  )
  select a.net, a.camp, a.ctype, b.daily_budget,
         round(coalesce(a.lmo, 0), 2), round(coalesce(a.lyo, 0), 2), round(coalesce(a.sp30, 0), 2),
         round(coalesce(a.val30, 0), 2), round(coalesce(a.conv30, 0), 1),
         round(a.val30 / nullif(a.sp30, 0), 2), round(a.sp30 / nullif(a.conv30, 0), 2),
         round(coalesce(a.sp7, 0), 2), round(a.lost7, 3)
  from agg a
  left join budgets b on a.net = 'google' and b.campaign = a.camp
  where coalesce(a.sp30, 0) > 0 or coalesce(a.lmo, 0) > 0
  order by a.net, coalesce(a.sp30, 0) desc;
end $$;
grant execute on function public.allocation_inputs(uuid, date) to authenticated;

-- The task board learns the monthly allocation task.
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
    ('alokacija_budzeta', null)
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
  ), spend_month as (
    -- The monthly spend report covers every client at once.
    select max(a.created_at) as last_done from ppc_actions a where a.task = 'mesecna_potrosnja'
  )
  select cl.id, cl.name, t.task,
         case when t.task in ('search_terms', 'disapproved', 'recommendations', 'placements', 'optimizacija_budzeta') then cl.has_google
              when t.task = 'ga4' then cl.has_ga4 else true end,
         case when t.task = 'mesecna_potrosnja' then (select sm.last_done from spend_month sm)
              when t.task = 'alokacija_budzeta' then al.approved_at else l.last_done end,
         coalesce(case when t.task = 'kampanje' then od.n else ofi.n end, 0),
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
  order by cl.name, t.task;
end $$;

grant execute on function public.ppc_work_log(date, date, uuid), public.ppc_task_board(date) to authenticated;