-- Phase 1 for Fashion&Friends RS, from the PPC team's answers (Jutarnji pregled — šta nam treba od PPC tima):
-- campaign groups with what Brain may do in each, ROAS from GA4, pacing by end-of-month projection
-- (the plan is not spent evenly), a 30-day cooldown for decided findings and competitor negatives.

-- The first group from review_settings.params.campaign_groups whose network and pattern match the campaign.
-- mode: predlozi (findings and ready changes) | upozorenja (findings only) | ne_dirati (left out).
create or replace function public.campaign_group(p_params jsonb, p_network text, p_campaign text)
returns jsonb language sql immutable as $$
  select coalesce(
    (select g from jsonb_array_elements(coalesce(p_params->'campaign_groups', '[]'::jsonb)) with ordinality x(g, i)
     where (g->>'network' is null or g->>'network' = p_network) and p_campaign ~ (g->>'pattern')
     order by i limit 1),
    '{"name": null, "mode": "predlozi"}'::jsonb)
$$;

-- A literal for use inside a regular expression ("pull&bear", "levi's" stay as they are; ".", "(" are escaped).
create or replace function public.re_escape(p text)
returns text language sql immutable as $$
  select regexp_replace(p, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')
$$;

update public.review_settings set params = params || jsonb_build_object(
  'cooldown_days', 30,
  'exclude_campaign_patterns', jsonb_build_array('^Social_'),
  'roas_source', 'ga4',
  'roas_days', 7,
  'roas_min_spend_eur', 100,
  'pacing_mode', 'projection',
  'meta_frequency_max', 3,
  'meta_ctr_drop', 0.3,
  'meta_cpm_rise', 0.4,
  'meta_min_ad_spend_eur', 30,
  'meta_learning_days', 4,
  'campaign_groups', jsonb_build_array(
    jsonb_build_object('name', 'Meta Social boost', 'network', 'meta', 'pattern', '^Social_', 'mode', 'ne_dirati', 'purpose', 'Social / awareness (vodi social tim)'),
    jsonb_build_object('name', 'Google Brand Search', 'network', 'google', 'pattern', 'Ct:Brand_Search', 'mode', 'upozorenja', 'purpose', 'Zaštita brenda i ecomm prodaja'),
    jsonb_build_object('name', 'Google App', 'network', 'google', 'pattern', 'Ct:App', 'mode', 'upozorenja', 'purpose', 'Loyalty / aplikacija'),
    jsonb_build_object('name', 'Meta App installs', 'network', 'meta', 'pattern', '^App ', 'mode', 'upozorenja', 'purpose', 'Loyalty / aplikacija'),
    jsonb_build_object('name', 'Meta Collection', 'network', 'meta', 'pattern', '^Collection', 'mode', 'upozorenja', 'purpose', 'Saobraćaj za MOF i BOF kampanje (nizak ROAS je očekivan)'),
    jsonb_build_object('name', 'Meta akcije', 'network', 'meta', 'pattern', '^(ADV_Akcije|Akcija)', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 8, 'min_roas', 4),
    jsonb_build_object('name', 'Meta awareness', 'network', 'meta', 'pattern', 'Ct:(Awareness|Traffic)', 'mode', 'upozorenja', 'purpose', 'Social / awareness (meri se CPM i CTR)'),
    jsonb_build_object('name', 'Meta konverzije Bof', 'network', 'meta', 'pattern', 'Ct:Conversions;Ph:Bof', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 15, 'min_roas', 8),
    jsonb_build_object('name', 'Meta konverzije Tof', 'network', 'meta', 'pattern', 'Ct:Conversions', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 8, 'min_roas', 4),
    jsonb_build_object('name', 'Google PMax', 'network', 'google', 'pattern', 'Ct:PMax', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja (često cilj prihod, ROAS nije strog)', 'target_roas', 15, 'min_roas', 8),
    jsonb_build_object('name', 'Google Display Bof', 'network', 'google', 'pattern', 'Ct:Display(_Dyn)?;Ph:Bof', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja (remarketing)', 'target_roas', 15, 'min_roas', 8),
    jsonb_build_object('name', 'Google Display Tof', 'network', 'google', 'pattern', 'Ct:Display', 'mode', 'predlozi', 'purpose', 'Prospekting, niži ROAS je očekivan', 'target_roas', 5, 'min_roas', 2),
    jsonb_build_object('name', 'Google Demand Gen', 'network', 'google', 'pattern', 'Ct:DemandGen', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 10, 'min_roas', 4),
    jsonb_build_object('name', 'Google DSA', 'network', 'google', 'pattern', '^Dynamic Search', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 5, 'min_roas', 3),
    jsonb_build_object('name', 'Google Search po brendu', 'network', 'google', 'pattern', 'Ct:Generic_Search', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja (cilj po klijentu i mesecu)', 'target_roas', 6, 'min_roas', 3)
  ))
where client_id = (select id from public.clients where name = 'Fashion&Friends RS');

create or replace function public.review_candidates(p_client_id uuid, p_asof date default null)
 returns table(check_type text, fingerprint text, severity text, impact_eur numeric, evidence jsonb)
 language plpgsql stable security definer set search_path to 'public'
as $function$
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
  -- Some clients run only Meta or only Google: take the latest day of whichever they have.
  d := coalesce(p_asof, (select max(x) from (
         select max(g.report_date) as x from google_ads_metrics g where g.client_id = p_client_id
         union all select max(f.report_date) from facebook_ads_metrics f where f.client_id = p_client_id) t));
  if d is null then return; end if;
  m := date_trunc('month', d)::date;
  month_days := extract(day from (m + interval '1 month' - interval '1 day'))::int;
  select coalesce(string_agg(x, '|'), '^\b$') into excl from jsonb_array_elements_text(s->'exclude_campaign_patterns') x;

  -- 1a. Pacing per network against the flight-weighted plan (a line spends evenly across its own dates).
  if coalesce(s->>'pacing_mode', 'flight') = 'flight' then
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
  end if;

  -- 1b. Pacing by projection: spent so far plus the last 7 days' daily average for the rest of the month,
  --     against the month's plan. For clients whose plan is not spent evenly (actions, weekly plans).
  if s->>'pacing_mode' = 'projection' then
  return query
  with plan as (
    select l.network, sum(l.budget_total) as full_month
    from media_plan_lines l
    where l.client_id = p_client_id and l.month = m and l.network in ('google', 'meta')
    group by l.network
  ), daily as (
    select 'google'::text as network, g.report_date, sum(g.spend) as spend from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date between m and d and g.campaign !~ excl group by 1, 2
    union all
    select 'meta', f.report_date, sum(f.spend) from facebook_ads_metrics f
    where f.client_id = p_client_id and f.report_date between m and d and f.campaign !~ excl group by 1, 2
  ), actual as (
    select x.network, sum(x.spend) as spend,
           sum(x.spend) filter (where x.report_date > d - 7) / least(7, d - m + 1) as last7_daily
    from daily x group by 1
  ), proj as (
    select p.network, p.full_month, a.spend, a.last7_daily, month_days - (d - m + 1) as remaining,
           a.spend + coalesce(a.last7_daily, 0) * (month_days - (d - m + 1)) as projected
    from plan p join actual a on a.network = p.network
    where p.full_month > 0
  )
  select 'pacing'::text,
         'pacing:' || x.network || ':' || to_char(m, 'YYYY-MM'),
         case when abs(x.projected / x.full_month - 1) > 0.3 then 'visoko' else 'srednje' end,
         round(abs(x.projected - x.full_month)),
         jsonb_build_object(
           'mode', 'projection', 'network', x.network, 'month', to_char(m, 'YYYY-MM'), 'data_date', d,
           'plan_month', round(x.full_month), 'spent_to_date', round(x.spend), 'last7_daily', round(x.last7_daily),
           'projected_month', round(x.projected), 'ratio', round(x.projected / x.full_month, 3),
           'gap', round(x.projected - x.full_month), 'remaining_days', x.remaining,
           'excluded_campaign_patterns', s->'exclude_campaign_patterns')
  from proj x
  where x.remaining > 0 and abs(x.projected / x.full_month - 1) > (s->>'pacing_tolerance')::numeric;
  end if;

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
           'group', campaign_group(s, c.net, c.campaign)->>'name', 'mode', campaign_group(s, c.net, c.campaign)->>'mode',
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

  -- 5. ROAS below the campaign group's minimum over the last roas_days days. Revenue comes from GA4 when
  --    roas_source = 'ga4' (Google by campaign name; Meta by the "kampanja--adset" utm_campaign), as the
  --    team reports it to the client; the platform's ROAS is shown next to it.
  if s->'campaign_groups' is not null then
  return query
  with sp as (
    select 'google'::text as net, g.campaign, sum(g.spend) as spend, sum(g.conversion_value) as rev_platform
    from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date > d - coalesce((s->>'roas_days')::int, 7) and g.report_date <= d and g.campaign !~ excl
    group by 1, 2
    union all
    select 'meta', f.campaign, sum(f.spend), sum(f.conversion_value)
    from facebook_ads_metrics f
    where f.client_id = p_client_id and f.report_date > d - coalesce((s->>'roas_days')::int, 7) and f.report_date <= d and f.campaign !~ excl
    group by 1, 2
  ), ga as (
    select case when a.source = 'google' then 'google' else 'meta' end as net,
           case when a.source = 'google' then a.campaign else split_part(a.campaign, '--', 1) end as campaign,
           sum(a.total_revenue) as rev
    from ga4_metrics a
    where a.client_id = p_client_id and a.report_date > d - coalesce((s->>'roas_days')::int, 7) and a.report_date <= d
      and ((a.source = 'google' and a.medium = 'cpc') or (a.source in ('facebook', 'fb', 'instagram', 'ig') and a.medium in ('paid', 'cpc')))
    group by 1, 2
  ), x as (
    select sp.net, sp.campaign, sp.spend, sp.rev_platform, coalesce(ga.rev, 0) as rev_ga4,
           campaign_group(s, sp.net, sp.campaign) as grp,
           case when s->>'roas_source' = 'ga4' then coalesce(ga.rev, 0) else sp.rev_platform end / nullif(sp.spend, 0) as roas
    from sp left join ga on ga.net = sp.net and ga.campaign = sp.campaign
  )
  select 'roas_low'::text,
         'roas:' || x.net || ':' || x.campaign,
         case when x.roas < (x.grp->>'min_roas')::numeric * 0.6 then 'visoko' else 'srednje' end,
         round(x.spend),
         jsonb_build_object(
           'network', x.net, 'campaign', x.campaign, 'group', x.grp->>'name', 'mode', x.grp->>'mode', 'purpose', x.grp->>'purpose',
           'days', coalesce((s->>'roas_days')::int, 7), 'to_date', d, 'spend', round(x.spend, 2),
           'revenue_ga4', round(x.rev_ga4), 'revenue_platform', round(x.rev_platform),
           'roas', round(x.roas, 2), 'roas_ga4', round(x.rev_ga4 / nullif(x.spend, 0), 2), 'roas_platform', round(x.rev_platform / nullif(x.spend, 0), 2),
           'roas_source', coalesce(s->>'roas_source', 'platform'),
           'target_roas', (x.grp->>'target_roas')::numeric, 'min_roas', (x.grp->>'min_roas')::numeric)
  from x
  where x.grp->>'mode' <> 'ne_dirati' and x.grp->>'min_roas' is not null
    and x.spend >= coalesce((s->>'roas_min_spend_eur')::numeric, 100)
    and coalesce(x.roas, 0) < (x.grp->>'min_roas')::numeric;
  end if;
end $function$;

create or replace function public.ppc_generate_changes(p_client_id uuid)
 returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare
  n int := 0;
  k int;
  m date := date_trunc('month', current_date)::date;
  snap date;
  s jsonb;
begin
  -- The nightly cron runs without a request (no JWT claims); API callers must be the service role or the agency.
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'ppc_generate_changes: not allowed';
  end if;
  -- Access is checked above; budget_plan() checks its caller again, so it runs as the service role for
  -- the rest of this call (the nightly cron has no request at all).
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  s := coalesce((select r.params from review_settings r where r.client_id = p_client_id), '{}'::jsonb);

  update ppc_changes set status = 'isteklo'
  where client_id = p_client_id and kind = 'daily_budget' and status = 'predlog' and created_at < current_date;

  snap := (select max(x.snapshot_date) from google_campaign_settings x where x.client_id = p_client_id);

  -- All candidates in one statement. When both budget sources propose a budget for the same campaign,
  -- the team's monthly budget wins over Google's recommendation (priority 1 before 2).
  -- Ready changes only for campaigns whose group allows proposals (mode predlozi).
  insert into ppc_changes (client_id, task, kind, network, campaign, ad_group, target, match_type, old_amount, new_amount, reason, details, fingerprint, finding_id)
  with acc as (
    select sum(g.conversion_value) / nullif(sum(g.spend), 0) as roas from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date > current_date - 31
  ), camp as (
    select g.campaign, sum(g.conversion_value) / nullif(sum(g.spend), 0) as roas,
           avg(g.search_lost_is_budget) filter (where g.report_date > current_date - 8) as lost
    from google_ads_metrics g where g.client_id = p_client_id and g.report_date > current_date - 31 group by 1
  ), rec as (
    select distinct on (o.campaign) o.campaign, o.recommended_budget
    from google_optimization o where o.client_id = p_client_id and o.recommended_budget is not null
      and o.snapshot_date > current_date - 3 order by o.campaign, o.snapshot_date desc
  ), comp as (
    -- Competitors from the client's list: the team never targets them, so the competitor's name goes in as one
    -- phrase negative in every campaign where a search term with it showed up in the last 30 days.
    select t.campaign, c.name as competitor, sum(t.spend) as sp, sum(t.clicks) as cl,
           count(distinct lower(t.search_term)) as n_terms, (array_agg(distinct lower(t.search_term)))[1:5] as terms
    from google_ads_search_terms t
    cross join jsonb_array_elements_text(coalesce(s->'competitors', '[]'::jsonb)) c(name)
    where t.client_id = p_client_id and t.report_date > current_date - 31
      and lower(t.search_term) ~ ('(^|[^a-z0-9])' || re_escape(lower(c.name)) || '($|[^a-z0-9])')
      and not exists (select 1 from jsonb_array_elements_text(coalesce(s->'brands_sold', '[]'::jsonb)) b(name) where lower(c.name) = lower(b.name))
    group by 1, 2
  ), cand as (
    -- Negative keywords: terms the morning review classified for exclusion, in the campaigns they spent in.
    select 'search_terms' as task, 'negative_keyword' as kind, 'google' as network, c.campaign, null::text as ad_group,
           t->>'term' as target, 'Exact' as match_type, null::numeric as old_amount, null::numeric as new_amount,
           concat_ws(' · ', t->>'why', 'potrošeno ' || (t->>'spend') || ' za ' || (t->>'days') || ' dana, ' || (t->>'clicks') || ' klikova, 0 konverzija') as reason,
           jsonb_build_object('spend', t->'spend', 'clicks', t->'clicks', 'kind', t->'kind', 'action', f.evidence->'action') as details,
           'neg:' || c.campaign || ':' || lower(t->>'term') as fingerprint, f.id as finding_id, 1 as priority
    from review_findings f
    cross join lateral jsonb_array_elements(f.evidence->'terms') t
    cross join lateral jsonb_array_elements_text(t->'campaigns') c(campaign)
    where f.client_id = p_client_id and f.check_type = 'search_terms' and f.run_date >= current_date - 7
      and f.status in ('novo', 'odobreno') and coalesce(f.evidence->>'action', '') <> 'zadrzi'
      and campaign_group(s, 'google', c.campaign)->>'mode' = 'predlozi'
    union all
    select 'search_terms', 'negative_keyword', 'google', x.campaign, null, x.competitor, 'Phrase', null, null,
           'Konkurent „' || x.competitor || '“: tim ne gađa konkurente · ' || x.n_terms || ' termina, potrošeno ' || round(x.sp, 2) || ' za 30 dana, ' || x.cl || ' klikova',
           jsonb_build_object('spend', round(x.sp, 2), 'clicks', x.cl, 'terms', to_jsonb(x.terms), 'kind', 'konkurent', 'source', 'lista_konkurenata'),
           'neg:' || x.campaign || ':' || lower(x.competitor), null, 1
    from comp x
    where campaign_group(s, 'google', x.campaign)->>'mode' = 'predlozi'
    union all
    -- Placement exclusions (account level), written the way the Google Ads exclusion list takes them.
    select 'placements', 'placement_exclusion', 'google', null, null,
           case i->>'type' when 'MOBILE_APPLICATION' then 'mobileapp::' || (i->>'placement')
                           when 'YOUTUBE_CHANNEL' then 'youtube.com/channel/' || (i->>'placement')
                           when 'YOUTUBE_VIDEO' then 'youtube.com/video/' || (i->>'placement')
                           else i->>'placement' end,
           null, null, null,
           concat_ws(' · ', i->>'why', 'potrošeno ' || (i->>'spend') || ' za 30 dana, ' || (i->>'clicks') || ' klikova, 0 konverzija'),
           jsonb_build_object('name', i->'name', 'type', i->'type', 'spend', i->'spend', 'clicks', i->'clicks'),
           'pl:' || (i->>'placement'), f.id, 1
    from review_findings f
    cross join lateral jsonb_array_elements(f.evidence->'items') i
    where f.client_id = p_client_id and f.check_type = 'placements' and f.run_date >= current_date - 7
      and f.status in ('novo', 'odobreno') and coalesce(i->>'action', f.evidence->>'action') = 'iskljuci'
    union all
    -- Daily budgets from the monthly budgets the team entered: more than 10% away from today's budget.
    select 'optimizacija_budzeta', 'daily_budget', b.network, b.campaign, null, null, null,
           st.daily_budget, round(b.recommended_daily, 2),
           'Mesečni budžet ' || round(b.monthly_budget) || ', potrošeno ' || round(b.spent_mtd) || ', ostalo ' || b.days_left || ' dana; ravnomerno do kraja meseca',
           jsonb_build_object('monthly_budget', b.monthly_budget, 'spent_mtd', b.spent_mtd, 'days_left', b.days_left, 'roas_30d', b.roas_30d, 'source', 'mesecni_budzet'),
           'budget:' || b.network || ':' || b.campaign || ':' || current_date, null, 1
    from budget_plan(p_client_id, m) b
    left join google_campaign_settings st on b.network = 'google' and st.client_id = p_client_id and st.snapshot_date = snap and st.campaign = b.campaign
    where b.recommended_daily is not null and b.recommended_daily > 0 and coalesce(st.budget_shared, false) = false
      and (st.daily_budget is null or abs(b.recommended_daily / nullif(st.daily_budget, 0) - 1) > 0.1)
      and (b.network = 'meta' or coalesce(st.campaign_status, 'ENABLED') = 'ENABLED')
      and campaign_group(s, b.network, b.campaign)->>'mode' = 'predlozi'
    union all
    -- Google's budget recommendation, only for enabled campaigns that lose at least 10% of impressions
    -- to budget (Search) and return at least the account's ROAS in the last 30 days.
    select 'optimizacija_budzeta', 'daily_budget', 'google', r.campaign, null, null, null,
           st.daily_budget, round(r.recommended_budget, 2),
           'Google predlaže veći budžet; kampanja gubi ' || round(c.lost * 100) || '% prikazivanja zbog budžeta, ROAS 30d ' || round(c.roas, 2) || ' (nalog ' || round(a.roas, 2) || ')',
           jsonb_build_object('lost_is_budget', c.lost, 'roas_30d', c.roas, 'account_roas', a.roas, 'source', 'google_preporuka'),
           'budget:google:' || r.campaign || ':' || current_date, null, 2
    from rec r
    join google_campaign_settings st on st.client_id = p_client_id and st.snapshot_date = snap and st.campaign = r.campaign
    join camp c on c.campaign = r.campaign cross join acc a
    where st.campaign_status = 'ENABLED' and coalesce(st.budget_shared, false) = false and st.daily_budget > 0
      and r.recommended_budget > st.daily_budget * 1.05 and c.lost >= 0.1 and c.roas >= coalesce(a.roas, 0)
      and campaign_group(s, 'google', r.campaign)->>'mode' = 'predlozi'
  )
  select distinct on (x.fingerprint) p_client_id, x.task, x.kind, x.network, x.campaign, x.ad_group, x.target, x.match_type,
         x.old_amount, x.new_amount, x.reason, x.details, x.fingerprint, x.finding_id
  from cand x
  where not exists (
    select 1 from ppc_changes c where c.client_id = p_client_id and c.fingerprint = x.fingerprint
      and (c.status in ('predlog', 'odobreno', 'izvezeno', 'poslato') or (c.status = 'odbijeno' and c.decided_at > now() - interval '90 days')))
  order by x.fingerprint, x.priority;
  get diagnostics k = row_count;
  n := n + k;

  -- A whole search term ("stradivarius haljine") is no longer needed once the competitor's name is a phrase
  -- negative in the same campaign; and nothing stays proposed for campaigns the team only wants warnings for.
  update ppc_changes c set status = 'isteklo'
  where c.client_id = p_client_id and c.status = 'predlog' and c.kind = 'negative_keyword'
    and coalesce(c.details->>'source', '') <> 'lista_konkurenata'
    and exists (select 1 from ppc_changes c2
                where c2.client_id = p_client_id and c2.kind = 'negative_keyword' and c2.campaign = c.campaign
                  and c2.details->>'source' = 'lista_konkurenata' and c2.status in ('predlog', 'odobreno', 'izvezeno', 'poslato')
                  and lower(c.target) ~ ('(^|[^a-z0-9])' || re_escape(lower(c2.target)) || '($|[^a-z0-9])'));
  update ppc_changes c set status = 'isteklo'
  where c.client_id = p_client_id and c.status = 'predlog' and c.campaign is not null
    and campaign_group(s, c.network, c.campaign)->>'mode' <> 'predlozi';
  return n;
end $function$;
