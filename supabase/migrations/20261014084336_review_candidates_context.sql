create or replace function public.review_candidates(p_client_id uuid, p_asof date default null)
returns table (check_type text, fingerprint text, severity text, impact_eur numeric, evidence jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  s jsonb;
  d date;
  m date;
  month_days int;
  excl text;
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'review_candidates: not allowed';
  end if;
  select r.params into s from review_settings r where r.client_id = p_client_id and r.enabled;
  if s is null then return; end if;

  -- Windsor data runs a day behind; review the last complete day.
  d := coalesce(p_asof, (select max(g.report_date) from google_ads_metrics g where g.client_id = p_client_id));
  m := date_trunc('month', d)::date;
  month_days := extract(day from (m + interval '1 month' - interval '1 day'))::int;
  select coalesce(string_agg(x, '|'), '^\b$') into excl from jsonb_array_elements_text(s->'exclude_campaign_patterns') x;

  -- 1. Pacing per network against the flight-weighted plan (a line spends evenly across its own dates).
  return query
  with plan as (
    select l.network,
           sum(l.budget_total) as full_month,
           sum(case when l.start_date is null or l.start_date > d then 0
                    else l.budget_total * (least(d, l.end_date) - l.start_date + 1)::numeric / (l.end_date - l.start_date + 1) end) as to_date,
           sum(case when l.start_date is null then l.budget_total else 0 end) as unscheduled,
           sum(case when l.flight_type = 'Always-on' and l.start_date is not null then l.budget_total / (l.end_date - l.start_date + 1) else 0 end) as always_on_daily,
           jsonb_agg(jsonb_build_object('label', l.campaign_label, 'from', l.start_date, 'to', l.end_date, 'budget', l.budget_total)
                     order by l.start_date) filter (where l.flight_type = 'Flight' and l.start_date > d) as upcoming_flights
    from media_plan_lines l
    where l.client_id = p_client_id and l.month = m and l.network in ('google', 'meta')
    group by l.network
  ), actual as (
    select 'google'::text as network, sum(g.spend) as spend from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date between m and d and g.campaign !~ excl
    union all
    select 'meta', sum(f.spend) from facebook_ads_metrics f
    where f.client_id = p_client_id and f.report_date between m and d and f.campaign !~ excl
  )
  select 'pacing'::text,
         'pacing:' || p.network || ':' || to_char(m, 'YYYY-MM'),
         case when abs(a.spend / p.to_date - 1) > 0.3 then 'visoko' else 'srednje' end,
         round(abs(a.spend - p.to_date)),
         jsonb_build_object(
           'network', p.network, 'month', to_char(m, 'YYYY-MM'), 'data_date', d,
           'plan_month', round(p.full_month), 'plan_to_date', round(p.to_date), 'spent_to_date', round(a.spend),
           'linear_to_date', round(p.full_month * (d - m + 1) / month_days),
           'ratio', round(a.spend / p.to_date, 3), 'gap', round(a.spend - p.to_date),
           'remaining_days', month_days - (d - m + 1),
           'always_on_daily_plan', round(p.always_on_daily), 'unscheduled_budget', round(p.unscheduled),
           'upcoming_flights', coalesce(p.upcoming_flights, '[]'::jsonb),
           'excluded_campaign_patterns', s->'exclude_campaign_patterns')
  from plan p join actual a on a.network = p.network
  where p.to_date > 0 and a.spend is not null
    and abs(a.spend / p.to_date - 1) > (s->>'pacing_tolerance')::numeric;

  -- 2. Spend anomalies per campaign: yesterday against the same weekday of the previous 4 weeks,
  --    with the context a person checks first (since when it stopped, which flights just ended).
  return query
  with daily as (
    select 'google'::text as net, g.campaign, g.report_date, sum(g.spend) as spend, sum(g.conversions) as conv
    from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date between d - 28 and d and g.campaign !~ excl
    group by 1, 2, 3
    union all
    select 'meta', f.campaign, f.report_date, sum(f.spend), sum(f.conversions)
    from facebook_ads_metrics f
    where f.client_id = p_client_id and f.report_date between d - 28 and d and f.campaign !~ excl
    group by 1, 2, 3
  ), base as (
    select x.net, x.campaign, avg(x.spend) as avg_spend, avg(x.conv) as avg_conv, count(*) as n
    from daily x where x.report_date in (d - 7, d - 14, d - 21, d - 28)
    group by 1, 2
  ), last_spend as (
    select x.net, x.campaign, max(x.report_date) as last_date from daily x where x.spend > 0 group by 1, 2
  ), y as (
    select x.net, x.campaign, x.spend, x.conv from daily x where x.report_date = d
  ), cmp as (
    select b.net, b.campaign, coalesce(y.spend, 0) as spend, coalesce(y.conv, 0) as conv, b.avg_spend, b.avg_conv, b.n, ls.last_date
    from base b
    left join y on y.net = b.net and y.campaign = b.campaign
    left join last_spend ls on ls.net = b.net and ls.campaign = b.campaign
  )
  select 'spend_anomaly'::text,
         'anom:' || c.net || ':' || c.campaign || ':' || case when c.spend > c.avg_spend then 'up' else 'down' end,
         case when c.spend = 0 then 'visoko' else 'srednje' end,
         round(abs(c.spend - c.avg_spend)),
         jsonb_build_object(
           'network', c.net, 'campaign', c.campaign, 'date', d,
           'direction', case when c.spend > c.avg_spend then 'up' else 'down' end,
           'spend', round(c.spend, 2), 'baseline_same_weekday', round(c.avg_spend, 2),
           'change_pct', round((c.spend / nullif(c.avg_spend, 0) - 1) * 100),
           'conversions', round(c.conv, 1), 'baseline_conversions', round(c.avg_conv, 1),
           'last_spend_date', c.last_date,
           'days_without_spend', case when c.spend = 0 and c.last_date is not null then d - c.last_date end,
           'planned_flights_that_day', (select coalesce(jsonb_agg(l.campaign_label), '[]'::jsonb) from media_plan_lines l
              where l.client_id = p_client_id and l.network = c.net and l.flight_type = 'Flight' and d between l.start_date and l.end_date),
           'flights_ended_last_3_days', (select coalesce(jsonb_agg(jsonb_build_object('label', l.campaign_label, 'end', l.end_date)), '[]'::jsonb)
              from media_plan_lines l
              where l.client_id = p_client_id and l.network = c.net and l.flight_type = 'Flight' and l.end_date between d - 3 and d - 1))
  from cmp c
  where c.n >= 3
    and greatest(c.spend, c.avg_spend) >= (s->>'spend_anomaly_min_eur')::numeric
    and abs(c.spend / nullif(c.avg_spend, 0) - 1) > (s->>'spend_anomaly')::numeric;

  -- 3. Tracking and conversion drops per network (the last day's conversions are still settling).
  return query
  with nd as (
    select 'google'::text as net, g.report_date, sum(g.spend) as spend, sum(g.conversions) as conv
    from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date between d - 28 and d and g.campaign !~ excl
    group by 1, 2
    union all
    select 'meta', f.report_date, sum(f.spend), sum(f.conversions)
    from facebook_ads_metrics f
    where f.client_id = p_client_id and f.report_date between d - 28 and d and f.campaign !~ excl
    group by 1, 2
  ), c as (
    select n.net,
           max(n.spend) filter (where n.report_date = d) as spend,
           max(n.conv) filter (where n.report_date = d) as conv,
           max(n.conv) filter (where n.report_date = d - 1) as conv_prev_day,
           avg(n.conv) filter (where n.report_date in (d - 7, d - 14, d - 21, d - 28)) as base_conv,
           avg(n.spend) filter (where n.report_date in (d - 7, d - 14, d - 21, d - 28)) as base_spend
    from nd n group by n.net
  )
  select case when c.conv = 0 then 'tracking' else 'conv_drop' end,
         case when c.conv = 0 then 'tracking:' else 'convdrop:' end || c.net,
         case when c.conv = 0 then 'hitno' else 'visoko' end,
         null::numeric,
         jsonb_build_object('network', c.net, 'date', d, 'spend', round(c.spend, 2), 'conversions', round(c.conv, 1),
                            'conversions_day_before', round(c.conv_prev_day, 1),
                            'baseline_conversions', round(c.base_conv, 1), 'baseline_spend', round(c.base_spend, 2),
                            'change_pct', round((c.conv / nullif(c.base_conv, 0) - 1) * 100))
  from c
  where c.spend >= (s->>'tracking_min_spend_eur')::numeric
    and (c.conv = 0
         or (c.base_conv >= (s->>'conv_drop_min_baseline')::numeric and c.conv < c.base_conv * (1 - (s->>'conv_drop')::numeric)));

  -- 4. Search terms that spent without a conversion (protected brand terms never come up).
  return query
  with st as (
    select lower(trim(t.search_term)) as term, sum(t.spend) as sp, sum(t.clicks) as cl, sum(t.impressions) as imp,
           sum(t.conversions) as cv, array_agg(distinct t.campaign order by t.campaign) as camps
    from google_ads_search_terms t
    where t.client_id = p_client_id and t.report_date > d - (s->>'waste_days')::int and t.report_date <= d
    group by 1
  )
  select 'search_term'::text,
         'st:' || st.term,
         'srednje',
         round(st.sp),
         jsonb_build_object(
           'term', st.term, 'spend', round(st.sp, 2), 'clicks', st.cl, 'impressions', st.imp,
           'days', (s->>'waste_days')::int, 'to_date', d, 'campaigns', to_jsonb(st.camps),
           'known_competitor', exists (select 1 from jsonb_array_elements_text(s->'competitors') x where st.term like '%' || x || '%'),
           'brand_sold', exists (select 1 from jsonb_array_elements_text(s->'brands_sold') x where st.term like '%' || x || '%'))
  from st
  where st.cv = 0 and st.sp >= (s->>'waste_min_spend_eur')::numeric
    and not exists (select 1 from jsonb_array_elements_text(s->'protected_terms') x where st.term like '%' || x || '%');
end $$;