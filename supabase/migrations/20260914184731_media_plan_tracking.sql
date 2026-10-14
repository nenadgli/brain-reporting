create table media_plan_lines (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  month date not null,
  network text not null,
  flight_type text not null,
  ad_set_type text,
  campaign_label text not null,
  start_date date,
  end_date date,
  budget_regular numeric not null default 0,
  budget_flash numeric not null default 0,
  budget_total numeric not null default 0,
  created_at timestamptz not null default now()
);
create index idx_mpl_client_month on media_plan_lines(client_id, month);

alter table media_plan_lines enable row level security;
create policy "scoped media_plan_lines access" on media_plan_lines for select
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));

-- Matches each plan line to actual spend on the same network within its date range,
-- classified by budget bucket the same way fashion_rs_ppc_* does.
create or replace function fashion_rs_budget_pacing(p_month date)
returns table(
  network text, flight_type text, campaign_label text, start_date date, end_date date,
  budget_total numeric, actual_spend numeric,
  days_total int, days_elapsed int, pct_time_elapsed numeric, pct_budget_spent numeric, pacing_status text
)
language plpgsql stable as $$
declare
  fashion_client_id uuid;
  today date := current_date;
begin
  select id into fashion_client_id from clients where slug = 'fashion-friends-rs' limit 1;

  return query
  select
    pl.network, pl.flight_type, pl.campaign_label, pl.start_date, pl.end_date,
    pl.budget_total,
    coalesce(actual.spend, 0) as actual_spend,
    case when pl.start_date is not null and pl.end_date is not null
      then (pl.end_date - pl.start_date + 1)::int else null end as days_total,
    case when pl.start_date is not null and pl.end_date is not null
      then greatest(0, least(pl.end_date, today) - pl.start_date + 1)::int else null end as days_elapsed,
    case when pl.start_date is not null and pl.end_date is not null and pl.end_date >= pl.start_date
      then round(100.0 * greatest(0, least(pl.end_date, today) - pl.start_date + 1) / (pl.end_date - pl.start_date + 1), 1)
      else null end as pct_time_elapsed,
    case when pl.budget_total > 0 then round(100.0 * coalesce(actual.spend, 0) / pl.budget_total, 1) else null end as pct_budget_spent,
    case
      when pl.budget_total = 0 then 'Bez budžeta'
      when pl.start_date is null then 'Ad hoc'
      when coalesce(actual.spend, 0) = 0 and today >= pl.start_date then 'Nije pokrenuto'
      when pl.end_date < today and coalesce(actual.spend,0) < pl.budget_total * 0.9 then 'Potrošeno manje od plana'
      when pl.end_date < today and coalesce(actual.spend,0) > pl.budget_total * 1.1 then 'Potrošeno više od plana'
      when pl.end_date < today then 'Završeno, u okviru plana'
      when coalesce(actual.spend, 0) > pl.budget_total * (greatest(0, least(pl.end_date, today) - pl.start_date + 1)::numeric / nullif(pl.end_date - pl.start_date + 1, 0)) * 1.15 then 'Ispred plana (troši brže)'
      when coalesce(actual.spend, 0) < pl.budget_total * (greatest(0, least(pl.end_date, today) - pl.start_date + 1)::numeric / nullif(pl.end_date - pl.start_date + 1, 0)) * 0.85 then 'Iza plana (troši sporije)'
      else 'Na tragu plana'
    end as pacing_status
  from media_plan_lines pl
  left join lateral (
    select sum(g.spend) as spend
    from google_ads_metrics g
    where g.client_id = fashion_client_id and pl.network = 'google'
      and pl.start_date is not null and g.report_date between pl.start_date and pl.end_date
  ) actual_g on pl.network = 'google'
  left join lateral (
    select sum(m.spend) as spend
    from facebook_ads_metrics m
    where m.client_id = fashion_client_id and pl.network = 'meta'
      and pl.start_date is not null and m.report_date between pl.start_date and pl.end_date
  ) actual_m on pl.network = 'meta'
  cross join lateral (select coalesce(actual_g.spend, actual_m.spend, 0) as spend) actual
  where pl.month = p_month and pl.client_id = fashion_client_id
  order by pl.network, pl.start_date;
end;
$$;

grant execute on function fashion_rs_budget_pacing(date) to authenticated;
