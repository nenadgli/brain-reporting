-- Google Ads vs GA4: the team wants a warning when the two differ by more than 50%. Compared over the last 3 days
-- (one day is too noisy, and the last day's conversions keep arriving): Google Ads conversion value against GA4
-- revenue from google / cpc. Raised only when the gap is unusual for the account: if it was already over the threshold
-- in the 4 weeks before, the difference is structural (attribution, settings), not a new tracking break.
create or replace function public.ga4_gap_candidates(p_client_id uuid)
returns table(check_type text, fingerprint text, severity text, impact_eur numeric, evidence jsonb)
language plpgsql stable security definer set search_path = public as $function$
declare
  s jsonb := coalesce((select params from review_settings where client_id = p_client_id), '{}'::jsonb);
  lim numeric := coalesce((s->>'ga4_gap')::numeric, 0.5);
  min_rev numeric := coalesce((s->>'ga4_gap_min_rev_eur')::numeric, 300);
  d date := (select max(report_date) from google_ads_metrics where client_id = p_client_id);
begin
  if d is null or not exists (select 1 from ga4_metrics where client_id = p_client_id and report_date > d - 7) then return; end if;
  return query
  with g as (
    select report_date as day, sum(spend) as spend, sum(conversion_value) as val
    from google_ads_metrics where client_id = p_client_id and report_date > d - 31 and report_date <= d group by 1
  ), a as (
    select report_date as day, sum(total_revenue) as rev
    from ga4_metrics where client_id = p_client_id and report_date > d - 31 and report_date <= d and source = 'google' and medium = 'cpc' group by 1
  ), x as (
    select g.day, g.spend, g.val, coalesce(a.rev, 0) as rev, g.day > d - 3 as recent from g left join a using (day)
  ), t as (
    select sum(spend) filter (where recent) as spend3, sum(val) filter (where recent) as val3, sum(rev) filter (where recent) as rev3,
           sum(val) filter (where not recent) as val28, sum(rev) filter (where not recent) as rev28,
           jsonb_agg(jsonb_build_object('date', day, 'google', round(val), 'ga4', round(rev)) order by day) filter (where recent) as days
    from x
  )
  select 'ga4_gap'::text, 'ga4gap:google', 'visoko', round(t.spend3),
         jsonb_build_object('network', 'google', 'from_date', d - 2, 'to_date', d, 'spend', round(t.spend3),
           'google_value', round(t.val3), 'ga4_revenue', round(t.rev3),
           'gap_pct', round(100 * (1 - least(t.val3, t.rev3) / greatest(t.val3, t.rev3))),
           'usual_gap_pct', round(100 * (1 - least(t.val28, t.rev28) / nullif(greatest(t.val28, t.rev28), 0))),
           'lower', case when t.val3 < t.rev3 then 'google' else 'ga4' end, 'days', t.days, 'threshold_pct', round(lim * 100))
  from t
  where greatest(t.val3, t.rev3) >= min_rev
    and 1 - least(t.val3, t.rev3) / greatest(t.val3, t.rev3) > lim
    and coalesce(1 - least(t.val28, t.rev28) / nullif(greatest(t.val28, t.rev28), 0), 0) <= lim;
end $function$;