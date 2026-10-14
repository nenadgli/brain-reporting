-- Add client scoping to the report-structure config table (was RS-only)
alter table fashion_rs_report_rows add column if not exists client_id uuid references clients(id) on delete cascade;
update fashion_rs_report_rows set client_id = 'c710bfd0-5281-412b-a7d6-2a96c80b9b57' where client_id is null;
alter table fashion_rs_report_rows alter column client_id set not null;

drop function if exists fashion_rs_ppc_channel_summary(date, date);
create or replace function fashion_rs_ppc_channel_summary(p_client_id uuid, p_start date, p_end date)
returns table(channel text, bucket text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  with google_rows as (
    select 'google'::text as channel, fashion_rs_budget_bucket(g.campaign, g.campaign_type) as bucket,
      sum(g.spend) as spend, sum(g.unique_users) as reach, sum(g.impressions) as impressions, sum(g.clicks) as clicks,
      sum(g.conversions) as conversions,
      (select coalesce(sum(ga.total_revenue),0) from ga4_metrics ga
        where ga.client_id = p_client_id and ga.report_date between p_start and p_end
        and ga.campaign = any(array_agg(distinct g.campaign))) as conversion_value
    from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(g.campaign, g.campaign_type)
  ),
  meta_rows as (
    select 'meta'::text as channel, fashion_rs_budget_bucket(m.campaign, m.objective) as bucket,
      sum(m.spend) as spend, sum(m.reach) as reach, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
      sum(m.conversions) as conversions,
      (select coalesce(sum(ga.total_revenue),0) from ga4_metrics ga
        where ga.client_id = p_client_id and ga.report_date between p_start and p_end
        and exists (select 1 from unnest(array_agg(distinct m.campaign)) cn where ga.campaign like cn || '--%')) as conversion_value
    from facebook_ads_metrics m
    where m.client_id = p_client_id and m.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(m.campaign, m.objective)
  )
  select * from google_rows union all select * from meta_rows
  order by channel, bucket;
$$;
grant execute on function fashion_rs_ppc_channel_summary(uuid, date, date) to authenticated;

drop function if exists fashion_rs_report_structure(date, date);
create or replace function fashion_rs_report_structure(p_client_id uuid, p_start date, p_end date)
returns table(
  row_order int, row_label text, channel text, level text, sub_dimension text,
  spend numeric, reach numeric, impressions numeric, clicks numeric,
  conversions numeric, conversion_value numeric, revenue_source text
)
language plpgsql stable as $$
declare
  r record;
  cname text;
begin
  for r in select * from fashion_rs_report_rows where fashion_rs_report_rows.client_id = p_client_id order by fashion_rs_report_rows.row_order loop
    if r.level = 'campaign' then
      if r.channel = 'google' then
        return query
        select r.row_order, r.row_label, r.channel, r.level, null::text,
          coalesce(sum(g.spend),0), coalesce(sum(g.unique_users),0), coalesce(sum(g.impressions),0), coalesce(sum(g.clicks),0),
          coalesce(sum(g.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
            and ga.report_date between p_start and p_end and ga.campaign = any(r.campaign_names)), 0),
          'GA4'::text
        from google_ads_metrics g
        where g.client_id = p_client_id and g.report_date between p_start and p_end
          and g.campaign = any(r.campaign_names);
      else
        return query
        select r.row_order, r.row_label, r.channel, r.level, null::text,
          coalesce(sum(m.spend),0), coalesce(sum(m.reach),0), coalesce(sum(m.impressions),0), coalesce(sum(m.clicks),0),
          coalesce(sum(m.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
            and ga.report_date between p_start and p_end
            and exists (select 1 from unnest(r.campaign_names) cn where ga.campaign like cn || '--%')), 0),
          'GA4'::text
        from facebook_ads_metrics m
        where m.client_id = p_client_id and m.report_date between p_start and p_end
          and m.campaign = any(r.campaign_names);
      end if;

    elsif r.level = 'meta_ad_set' then
      cname := r.campaign_names[1];
      return query
      with grouped as (
        select coalesce(a.adset_name, '(bez ad seta)') as adset_name,
          sum(a.spend) as spend, sum(a.impressions) as impressions, sum(a.clicks) as clicks, sum(a.conversions) as conversions
        from meta_ad_set_metrics a
        where a.client_id = p_client_id and a.report_date between p_start and p_end
          and a.campaign = any(r.campaign_names)
        group by coalesce(a.adset_name, '(bez ad seta)')
      )
      select r.row_order, r.row_label, r.channel, r.level, gr.adset_name,
        gr.spend, 0::numeric, gr.impressions, gr.clicks, gr.conversions,
        coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
          and ga.report_date between p_start and p_end
          and ga.campaign like cname || '--' || gr.adset_name || '%'), 0),
        'GA4'::text
      from grouped gr
      order by gr.spend desc;

    elsif r.level = 'google_ad_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.ad_group_name, '(bez ad grupe)'),
        sum(a.spend), sum(a.unique_users), sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_ad_group_metrics a
      where a.client_id = p_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.ad_group_name, '(bez ad grupe)')
      order by sum(a.spend) desc;

    elsif r.level = 'asset_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.asset_group_name, '(bez asset grupe)'),
        sum(a.spend), sum(a.unique_users), sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_asset_group_metrics a
      where a.client_id = p_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.asset_group_name, '(bez asset grupe)')
      order by sum(a.spend) desc;
    end if;
  end loop;
end;
$$;
grant execute on function fashion_rs_report_structure(uuid, date, date) to authenticated;

drop function if exists fashion_rs_google_pacing(date);
create or replace function fashion_rs_google_pacing(p_client_id uuid, p_month date)
returns table(
  ad_set_type text, campaign_label text, start_date date, end_date date,
  budget_total numeric, actual_spend numeric, days_total int, days_elapsed int, pct_time_elapsed numeric
)
language plpgsql stable as $$
declare
  today date := current_date;
begin
  return query
  with grouped_plan as (
    select pl.ad_set_type,
      string_agg(distinct pl.campaign_label, ' + ' order by pl.campaign_label) as campaign_label,
      pl.start_date, pl.end_date, sum(pl.budget_total) as budget_total
    from media_plan_lines pl
    where pl.month = p_month and pl.client_id = p_client_id and pl.network = 'google' and pl.start_date is not null
    group by pl.ad_set_type, pl.start_date, pl.end_date
  )
  select gp.ad_set_type, gp.campaign_label, gp.start_date, gp.end_date, gp.budget_total,
    coalesce((select sum(g.spend) from google_ads_metrics g
      where g.client_id = p_client_id and g.report_date between gp.start_date and gp.end_date
        and (gp.ad_set_type is null or g.campaign_type = gp.ad_set_type)), 0) as actual_spend,
    (gp.end_date - gp.start_date + 1)::int,
    greatest(0, least(gp.end_date, today) - gp.start_date + 1)::int,
    round(100.0 * greatest(0, least(gp.end_date, today) - gp.start_date + 1) / nullif(gp.end_date - gp.start_date + 1, 0), 1)
  from grouped_plan gp
  order by gp.start_date;
end;
$$;
grant execute on function fashion_rs_google_pacing(uuid, date) to authenticated;

drop function if exists fashion_rs_meta_pacing(date);
create or replace function fashion_rs_meta_pacing(p_client_id uuid, p_month date)
returns table(bucket text, budget_planned numeric, actual_spend numeric)
language sql stable as $$
  with planned as (
    select fashion_rs_budget_bucket(pl.campaign_label, null) as bucket, sum(pl.budget_total) as budget_planned
    from media_plan_lines pl
    where pl.month = p_month and pl.client_id = p_client_id and pl.network = 'meta'
    group by fashion_rs_budget_bucket(pl.campaign_label, null)
  ),
  actual as (
    select bucket, spend as actual_spend from fashion_rs_ppc_channel_summary(p_client_id, p_month, (p_month + interval '1 month' - interval '1 day')::date)
    where channel = 'meta'
  )
  select coalesce(p.bucket, a.bucket), coalesce(p.budget_planned, 0), coalesce(a.actual_spend, 0)
  from planned p full outer join actual a on p.bucket = a.bucket;
$$;
grant execute on function fashion_rs_meta_pacing(uuid, date) to authenticated;

drop function if exists fashion_rs_daily_pacing(date);
create or replace function fashion_rs_daily_pacing(p_client_id uuid, p_month date)
returns table(report_date date, network text, planned_daily numeric, actual_daily numeric, planned_cum numeric, actual_cum numeric)
language plpgsql stable as $$
declare
  month_end date := (p_month + interval '1 month' - interval '1 day')::date;
begin
  return query
  with days as (select generate_series(p_month, month_end, interval '1 day')::date as d),
  networks as (select unnest(array['google','meta']) as network),
  planned_daily as (
    select d.d as report_date, n.network,
      coalesce(sum(pl.budget_total / nullif(pl.end_date - pl.start_date + 1, 0)), 0) as planned
    from days d cross join networks n
    left join media_plan_lines pl
      on pl.client_id = p_client_id and pl.month = p_month and pl.network = n.network
      and pl.start_date is not null and d.d between pl.start_date and pl.end_date
    group by d.d, n.network
  ),
  actual_daily as (
    select g.report_date, 'google'::text as network, sum(g.spend) as actual
    from google_ads_metrics g where g.client_id = p_client_id and g.report_date between p_month and month_end
    group by g.report_date
    union all
    select m.report_date, 'meta'::text, sum(m.spend)
    from facebook_ads_metrics m where m.client_id = p_client_id and m.report_date between p_month and month_end
    group by m.report_date
  )
  select pd.report_date, pd.network, pd.planned, coalesce(ad.actual, 0),
    sum(pd.planned) over (partition by pd.network order by pd.report_date),
    sum(coalesce(ad.actual, 0)) over (partition by pd.network order by pd.report_date)
  from planned_daily pd
  left join actual_daily ad on ad.report_date = pd.report_date and ad.network = pd.network
  order by pd.network, pd.report_date;
end;
$$;
grant execute on function fashion_rs_daily_pacing(uuid, date) to authenticated;
