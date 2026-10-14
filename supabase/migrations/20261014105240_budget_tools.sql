-- Budget tools for the PPC team's most frequent Productive tasks:
-- "Provera budžeta" / "Optimizacija dnevnih budžeta i tROAS-a" (budget_plan) and
-- "Mesečna potrošnja - All clients" (monthly_spend_report). Numbers only; nothing is changed in any account.

-- Monthly budget per campaign, the part of the team's "Budgets & Optimization" sheets that is typed in by hand.
create table if not exists public.campaign_budgets (
  client_id uuid not null references clients(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  network text not null check (network in ('google', 'meta')),
  campaign text not null,
  monthly_budget numeric not null check (monthly_budget >= 0),
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (client_id, month, network, campaign)
);
alter table public.campaign_budgets enable row level security;
create policy "agency campaign budgets read" on public.campaign_budgets for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency campaign budgets insert" on public.campaign_budgets for insert with check (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency campaign budgets update" on public.campaign_budgets for update using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select, insert, update on public.campaign_budgets to authenticated;

-- Per campaign: month budget, spend to date, the daily budget that spends the rest evenly
-- (the sheet's "Daily" column), recent pace and the last 30 days' ROAS as the tROAS reference.
create or replace function public.budget_plan(p_client_id uuid, p_month date default null)
returns table (
  network text, campaign text, campaign_type text, monthly_budget numeric, spent_mtd numeric, remaining numeric,
  data_date date, days_left int, recommended_daily numeric, avg_daily_7d numeric, spend_last_day numeric,
  projected_month numeric, roas_30d numeric, conversions_30d numeric, cpa_30d numeric, lost_is_budget_7d numeric, status text
)
language plpgsql stable security definer set search_path = public as $$
declare
  m date := date_trunc('month', coalesce(p_month, current_date))::date;
  m_end date;
  d date;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'budget_plan: not allowed';
  end if;
  m_end := (m + interval '1 month' - interval '1 day')::date;
  -- Spend is known through the last synced day (Windsor runs a day behind).
  d := least(m_end, (select max(x) from (
         select max(g.report_date) as x from google_ads_metrics g where g.client_id = p_client_id
         union all select max(f.report_date) from facebook_ads_metrics f where f.client_id = p_client_id) t));
  if d is null or d < m - 1 then d := m - 1; end if;

  return query
  with daily as (
    select 'google'::text as net, g.campaign as camp, max(g.campaign_type) as ctype, g.report_date as day,
           sum(g.spend) as spend, sum(g.conversions) as conv, sum(g.conversion_value) as val,
           avg(g.search_lost_is_budget) as lost
    from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date between least(m, d - 29) and d
    group by g.campaign, g.report_date
    union all
    select 'meta', f.campaign, max(f.objective), f.report_date, sum(f.spend), sum(f.conversions), sum(f.conversion_value), null
    from facebook_ads_metrics f
    where f.client_id = p_client_id and f.report_date between least(m, d - 29) and d
    group by f.campaign, f.report_date
  ), agg as (
    select x.net, x.camp, max(x.ctype) as ctype,
           sum(x.spend) filter (where x.day >= m) as mtd,
           sum(x.spend) filter (where x.day > d - 7) / 7 as avg7,
           sum(x.spend) filter (where x.day = d) as last_day,
           sum(x.spend) filter (where x.day > d - 30) as sp30,
           sum(x.val) filter (where x.day > d - 30) as val30,
           sum(x.conv) filter (where x.day > d - 30) as conv30,
           avg(x.lost) filter (where x.day > d - 7) as lost7
    from daily x group by x.net, x.camp
  ), camps as (
    select a.net, a.camp from agg a where coalesce(a.mtd, 0) > 0 or coalesce(a.avg7, 0) > 0
    union
    select b.network, b.campaign from campaign_budgets b where b.client_id = p_client_id and b.month = m
  )
  select c.net, c.camp, a.ctype, b.monthly_budget,
         round(coalesce(a.mtd, 0), 2),
         round(b.monthly_budget - coalesce(a.mtd, 0), 2),
         d,
         (m_end - d)::int,
         case when b.monthly_budget is not null and m_end > d then round(greatest(b.monthly_budget - coalesce(a.mtd, 0), 0) / (m_end - d), 2) end,
         round(coalesce(a.avg7, 0), 2),
         round(coalesce(a.last_day, 0), 2),
         round(coalesce(a.mtd, 0) + coalesce(a.avg7, 0) * (m_end - d), 2),
         round(a.val30 / nullif(a.sp30, 0), 2),
         round(a.conv30, 1),
         round(a.sp30 / nullif(a.conv30, 0), 2),
         round(a.lost7, 3),
         case
           when b.monthly_budget is null then 'bez_budzeta'
           when coalesce(a.mtd, 0) > b.monthly_budget then 'prekoraceno'
           when coalesce(a.mtd, 0) + coalesce(a.avg7, 0) * (m_end - d) > b.monthly_budget * 1.05 then 'prebrzo'
           when coalesce(a.mtd, 0) + coalesce(a.avg7, 0) * (m_end - d) < b.monthly_budget * 0.9 then 'presporo'
           else 'u_planu' end
  from camps c
  left join agg a on a.net = c.net and a.camp = c.camp
  left join campaign_budgets b on b.client_id = p_client_id and b.month = m and b.network = c.net and b.campaign = c.camp
  order by c.net, coalesce(a.mtd, 0) desc;
end $$;

-- Month spend per client and bucket, as the monthly "Potrošnja - All clients" sheet splits it
-- (F&F: Meta Social / Ecomm / App, Google Regular / App), with an end-of-month projection.
create or replace function public.monthly_spend_report(p_month date default null)
returns table (
  client_id uuid, client_name text, currency text, data_date date, days_left int,
  google_regular numeric, google_app numeric, meta_ecomm numeric, meta_social numeric, meta_app numeric,
  total numeric, projected_total numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  m date := date_trunc('month', coalesce(p_month, current_date))::date;
  m_end date;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_user_client_id() is not null then
    raise exception 'monthly_spend_report: not allowed';
  end if;
  m_end := (m + interval '1 month' - interval '1 day')::date;
  return query
  with g as (
    select x.client_id as cid, x.report_date as day,
           case when x.campaign_type = 'MULTI_CHANNEL' or x.campaign ~* 'Ct:App' then 'google_app' else 'google_regular' end as bucket,
           sum(x.spend) as spend
    from google_ads_metrics x where x.report_date between m - 7 and m_end
    group by 1, 2, 3
  ), f as (
    select x.client_id as cid, x.report_date as day,
           case when x.campaign ~* '^\s*social' then 'meta_social'
                when x.objective ilike '%APP%' or x.campaign ~* '^\s*app\M|Ct:App' then 'meta_app'
                else 'meta_ecomm' end as bucket,
           sum(x.spend) as spend
    from facebook_ads_metrics x where x.report_date between m - 7 and m_end
    group by 1, 2, 3
  ), allx as (select * from g union all select * from f),
  last_day as (select a.cid, least(m_end, max(a.day)) as d from allx a group by a.cid)
  select c.id, c.name, coalesce(rs.params->>'currency', 'EUR'), ld.d, greatest(m_end - ld.d, 0)::int,
         round(coalesce(sum(a.spend) filter (where a.bucket = 'google_regular' and a.day >= m), 0), 2),
         round(coalesce(sum(a.spend) filter (where a.bucket = 'google_app' and a.day >= m), 0), 2),
         round(coalesce(sum(a.spend) filter (where a.bucket = 'meta_ecomm' and a.day >= m), 0), 2),
         round(coalesce(sum(a.spend) filter (where a.bucket = 'meta_social' and a.day >= m), 0), 2),
         round(coalesce(sum(a.spend) filter (where a.bucket = 'meta_app' and a.day >= m), 0), 2),
         round(coalesce(sum(a.spend) filter (where a.day >= m), 0), 2),
         round(coalesce(sum(a.spend) filter (where a.day >= m), 0)
               + coalesce(sum(a.spend) filter (where a.day > ld.d - 7 and a.day <= ld.d), 0) / 7 * greatest(m_end - ld.d, 0), 2)
  from clients c
  join last_day ld on ld.cid = c.id
  join allx a on a.cid = c.id
  left join review_settings rs on rs.client_id = c.id
  where c.agency_id = coalesce(current_user_agency_id(), c.agency_id)
  group by c.id, c.name, rs.params, ld.d
  having coalesce(sum(a.spend) filter (where a.day >= m), 0) > 0
  order by c.name;
end $$;

grant execute on function public.budget_plan(uuid, date), public.monthly_spend_report(date) to authenticated;