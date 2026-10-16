-- The week's plan from the media plan (shown in Danas): each line's budget spread evenly over its days, counted for
-- the days that fall in the week, plus last week's plan next to what was actually spent. A line's dates are kept to
-- its own month (a sheet sometimes carries a line dated in the month before); such lines come back flagged.
create or replace function public.week_plan(p_client_id uuid, p_week date)
returns jsonb language sql stable set search_path = public as $function$
  with l as (
    select m.network, m.flight_type, m.campaign_label, m.start_date, m.end_date, m.budget_total, m.month,
           greatest(coalesce(m.start_date, m.month), m.month) as s,
           least(coalesce(m.end_date, (m.month + interval '1 month - 1 day')::date), (m.month + interval '1 month - 1 day')::date) as e,
           (m.start_date is not null and m.end_date is not null
             and (m.end_date < m.month or m.start_date > (m.month + interval '1 month - 1 day')::date)) as outside
    from media_plan_lines m
    where m.client_id = p_client_id and m.network in ('google', 'meta')
      and m.month between date_trunc('month', p_week - 7)::date and date_trunc('month', p_week + 6)::date
  ), w as (
    select l.*, greatest(0, least(l.e, p_week + 6) - greatest(l.s, p_week) + 1) as days_this,
           greatest(0, least(l.e, p_week - 1) - greatest(l.s, p_week - 7) + 1) as days_last,
           greatest(1, l.e - l.s + 1) as days_all
    from l
  ), sp as (
    select 'google' as network, sum(spend) as spend from google_ads_metrics where client_id = p_client_id and report_date between p_week - 7 and p_week - 1
    union all
    select 'meta', sum(spend) from facebook_ads_metrics where client_id = p_client_id and report_date between p_week - 7 and p_week - 1
  )
  select jsonb_build_object(
    'week', p_week,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('network', network, 'flight_type', flight_type, 'campaign', campaign_label,
               'start', start_date, 'end', end_date, 'budget', budget_total, 'week_budget', round(budget_total * days_this / days_all),
               'starts', s between p_week and p_week + 6, 'ends', e between p_week and p_week + 6, 'outside', outside)
             order by network, (s between p_week and p_week + 6) desc, budget_total desc)
             from w where days_this > 0), '[]'::jsonb),
    'outside', coalesce((select jsonb_agg(jsonb_build_object('network', network, 'campaign', campaign_label, 'start', start_date, 'end', end_date, 'budget', budget_total, 'month', month))
             from w where outside and month = date_trunc('month', p_week)::date), '[]'::jsonb),
    'last_week', (select jsonb_object_agg(n.network, jsonb_build_object(
               'plan', (select round(coalesce(sum(budget_total * days_last / days_all), 0)) from w where w.network = n.network and not outside),
               'spend', (select round(coalesce(sp.spend, 0)) from sp where sp.network = n.network)))
             from (values ('google'), ('meta')) n(network)))
$function$;