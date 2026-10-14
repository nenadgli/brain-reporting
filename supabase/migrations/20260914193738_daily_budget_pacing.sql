-- Daily planned budget (each flight's budget spread evenly across its own date range)
-- vs actual daily spend, both cumulative, per network. Lets PPC see day-by-day if
-- they're tracking ahead/behind the plan, not just a single end-of-month %.
create or replace function fashion_rs_daily_pacing(p_month date)
returns table(report_date date, network text, planned_daily numeric, actual_daily numeric, planned_cum numeric, actual_cum numeric)
language plpgsql stable as $$
declare
  fashion_client_id uuid;
  month_end date := (p_month + interval '1 month' - interval '1 day')::date;
begin
  select id into fashion_client_id from clients where slug = 'fashion-friends-rs' limit 1;

  return query
  with days as (
    select generate_series(p_month, month_end, interval '1 day')::date as d
  ),
  networks as (select unnest(array['google','meta']) as network),
  planned_daily as (
    select d.d as report_date, n.network,
      coalesce(sum(pl.budget_total / nullif(pl.end_date - pl.start_date + 1, 0)), 0) as planned
    from days d
    cross join networks n
    left join media_plan_lines pl
      on pl.client_id = fashion_client_id and pl.month = p_month and pl.network = n.network
      and pl.start_date is not null and d.d between pl.start_date and pl.end_date
    group by d.d, n.network
  ),
  actual_daily as (
    select g.report_date, 'google'::text as network, sum(g.spend) as actual
    from google_ads_metrics g where g.client_id = fashion_client_id and g.report_date between p_month and month_end
    group by g.report_date
    union all
    select m.report_date, 'meta'::text, sum(m.spend)
    from facebook_ads_metrics m where m.client_id = fashion_client_id and m.report_date between p_month and month_end
    group by m.report_date
  )
  select
    pd.report_date, pd.network, pd.planned,
    coalesce(ad.actual, 0),
    sum(pd.planned) over (partition by pd.network order by pd.report_date),
    sum(coalesce(ad.actual, 0)) over (partition by pd.network order by pd.report_date)
  from planned_daily pd
  left join actual_daily ad on ad.report_date = pd.report_date and ad.network = pd.network
  order by pd.network, pd.report_date;
end;
$$;

grant execute on function fashion_rs_daily_pacing(date) to authenticated;
