drop function if exists fashion_rs_budget_pacing(date);

create or replace function fashion_rs_budget_pacing(p_month date)
returns table(
  network text, ad_set_type text, campaign_label text, start_date date, end_date date,
  budget_total numeric, actual_spend numeric,
  days_total int, days_elapsed int, pct_time_elapsed numeric
)
language plpgsql stable as $$
declare
  fashion_client_id uuid;
  today date := current_date;
begin
  select id into fashion_client_id from clients where slug = 'fashion-friends-rs' limit 1;

  return query
  with grouped_plan as (
    select
      pl.network,
      case when pl.network = 'google' then pl.ad_set_type else null end as gad_set_type,
      case when pl.network = 'meta' then
        case when pl.campaign_label ilike '%Remarketing%' then 'BOF' else 'TOF' end
      else null end as meta_phase,
      string_agg(distinct pl.campaign_label, ' + ' order by pl.campaign_label) as campaign_label,
      pl.start_date, pl.end_date,
      sum(pl.budget_total) as budget_total
    from media_plan_lines pl
    where pl.month = p_month and pl.client_id = fashion_client_id and pl.start_date is not null
    group by pl.network,
      case when pl.network = 'google' then pl.ad_set_type else null end,
      case when pl.network = 'meta' then (case when pl.campaign_label ilike '%Remarketing%' then 'BOF' else 'TOF' end) else null end,
      pl.start_date, pl.end_date
  ),
  meta_classified as (
    select m.client_id, m.report_date, m.spend, c.funnel_stage
    from facebook_ads_metrics m
    cross join lateral fashion_rs_classify(m.campaign, m.objective) c
    where m.client_id = fashion_client_id
  )
  select
    gp.network, coalesce(gp.gad_set_type, gp.meta_phase), gp.campaign_label, gp.start_date, gp.end_date, gp.budget_total,
    coalesce((
      select sum(g.spend) from google_ads_metrics g
      where gp.network = 'google' and g.client_id = fashion_client_id
        and g.report_date between gp.start_date and gp.end_date
        and (gp.gad_set_type is null or g.campaign_type = gp.gad_set_type)
    ), (
      select sum(mc.spend) from meta_classified mc
      where gp.network = 'meta'
        and mc.report_date between gp.start_date and gp.end_date
        and mc.funnel_stage = gp.meta_phase
    ), 0) as actual_spend,
    (gp.end_date - gp.start_date + 1)::int as days_total,
    greatest(0, least(gp.end_date, today) - gp.start_date + 1)::int as days_elapsed,
    round(100.0 * greatest(0, least(gp.end_date, today) - gp.start_date + 1) / nullif(gp.end_date - gp.start_date + 1, 0), 1) as pct_time_elapsed
  from grouped_plan gp
  order by gp.network, gp.start_date;
end;
$$;

grant execute on function fashion_rs_budget_pacing(date) to authenticated;
