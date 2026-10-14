drop function if exists fashion_rs_budget_pacing(date);

-- Google: reliable flight-level pacing (ad_set_type + date range has no overlap issue).
create or replace function fashion_rs_google_pacing(p_month date)
returns table(
  ad_set_type text, campaign_label text, start_date date, end_date date,
  budget_total numeric, actual_spend numeric, days_total int, days_elapsed int, pct_time_elapsed numeric
)
language plpgsql stable as $$
declare
  fashion_client_id uuid;
  today date := current_date;
begin
  select id into fashion_client_id from clients where slug = 'fashion-friends-rs' limit 1;
  return query
  with grouped_plan as (
    select pl.ad_set_type,
      string_agg(distinct pl.campaign_label, ' + ' order by pl.campaign_label) as campaign_label,
      pl.start_date, pl.end_date, sum(pl.budget_total) as budget_total
    from media_plan_lines pl
    where pl.month = p_month and pl.client_id = fashion_client_id and pl.network = 'google' and pl.start_date is not null
    group by pl.ad_set_type, pl.start_date, pl.end_date
  )
  select gp.ad_set_type, gp.campaign_label, gp.start_date, gp.end_date, gp.budget_total,
    coalesce((select sum(g.spend) from google_ads_metrics g
      where g.client_id = fashion_client_id and g.report_date between gp.start_date and gp.end_date
        and (gp.ad_set_type is null or g.campaign_type = gp.ad_set_type)), 0) as actual_spend,
    (gp.end_date - gp.start_date + 1)::int,
    greatest(0, least(gp.end_date, today) - gp.start_date + 1)::int,
    round(100.0 * greatest(0, least(gp.end_date, today) - gp.start_date + 1) / nullif(gp.end_date - gp.start_date + 1, 0), 1)
  from grouped_plan gp
  order by gp.start_date;
end;
$$;

-- Meta: only reliable at whole-month bucket level (Ecomm/Loyalty/Social), matching
-- fashion_rs_budget_bucket classification - flight-level isn't separable from our synced data.
create or replace function fashion_rs_meta_pacing(p_month date)
returns table(bucket text, budget_planned numeric, actual_spend numeric)
language sql stable as $$
  with fashion_client as (select id from clients where slug = 'fashion-friends-rs' limit 1),
  planned as (
    select fashion_rs_budget_bucket(pl.campaign_label, null) as bucket, sum(pl.budget_total) as budget_planned
    from media_plan_lines pl
    where pl.month = p_month and pl.client_id = (select id from fashion_client) and pl.network = 'meta'
    group by fashion_rs_budget_bucket(pl.campaign_label, null)
  ),
  actual as (
    select bucket, spend as actual_spend from fashion_rs_ppc_channel_summary(p_month, (p_month + interval '1 month' - interval '1 day')::date)
    where channel = 'meta'
  )
  select coalesce(p.bucket, a.bucket), coalesce(p.budget_planned, 0), coalesce(a.actual_spend, 0)
  from planned p full outer join actual a on p.bucket = a.bucket;
$$;

grant execute on function fashion_rs_google_pacing(date) to authenticated;
grant execute on function fashion_rs_meta_pacing(date) to authenticated;
