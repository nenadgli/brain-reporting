create or replace function fashion_rs_ppc_channel_summary(p_start date, p_end date)
returns table(channel text, bucket text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  with fashion_client as (select id from clients where slug = 'fashion-friends-rs' limit 1),
  google_rows as (
    select 'google'::text as channel, fashion_rs_budget_bucket(g.campaign, g.campaign_type) as bucket,
      sum(g.spend) as spend, sum(g.unique_users) as reach, sum(g.impressions) as impressions, sum(g.clicks) as clicks,
      sum(g.conversions) as conversions,
      (select coalesce(sum(ga.total_revenue),0) from ga4_metrics ga, fashion_client fc2
        where ga.client_id = fc2.id and ga.report_date between p_start and p_end
        and ga.campaign = any(array_agg(distinct g.campaign))) as conversion_value
    from google_ads_metrics g, fashion_client fc
    where g.client_id = fc.id and g.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(g.campaign, g.campaign_type)
  ),
  meta_rows as (
    select 'meta'::text as channel, fashion_rs_budget_bucket(m.campaign, m.objective) as bucket,
      sum(m.spend) as spend, sum(m.reach) as reach, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
      sum(m.conversions) as conversions,
      (select coalesce(sum(ga.total_revenue),0) from ga4_metrics ga, fashion_client fc2
        where ga.client_id = fc2.id and ga.report_date between p_start and p_end
        and exists (select 1 from unnest(array_agg(distinct m.campaign)) cn where ga.campaign like cn || '--%')) as conversion_value
    from facebook_ads_metrics m, fashion_client fc
    where m.client_id = fc.id and m.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(m.campaign, m.objective)
  )
  select * from google_rows union all select * from meta_rows
  order by channel, bucket;
$$;
