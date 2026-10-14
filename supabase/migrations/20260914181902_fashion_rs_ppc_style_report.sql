-- Classifies each campaign into a budget bucket the way the PPC team's manual
-- media plan does: Loyalty (app install), Social (brand-awareness boost, separate
-- budget line), or Ecomm (everything else - the main paid-media budget).
create or replace function fashion_rs_budget_bucket(p_campaign text, p_native_type text)
returns text
language sql immutable as $$
  select case
    when p_campaign ilike 'Social%' or p_campaign ilike '%Page Likes%' then 'Social'
    when p_campaign ilike '%Ct:App%' or p_native_type ilike '%APP_INSTALLS%' then 'Loyalty'
    else 'Ecomm'
  end;
$$;

create or replace function fashion_rs_ppc_channel_summary(p_start date, p_end date)
returns table(channel text, bucket text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  with fashion_client as (select id from clients where slug = 'fashion-friends-rs' limit 1),
  google_rows as (
    select 'google'::text as channel, fashion_rs_budget_bucket(g.campaign, g.campaign_type) as bucket,
      sum(g.spend) as spend, 0::numeric as reach, sum(g.impressions) as impressions, sum(g.clicks) as clicks,
      sum(g.conversions) as conversions, sum(g.conversion_value) as conversion_value
    from google_ads_metrics g, fashion_client fc
    where g.client_id = fc.id and g.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(g.campaign, g.campaign_type)
  ),
  meta_rows as (
    select 'meta'::text as channel, fashion_rs_budget_bucket(m.campaign, m.objective) as bucket,
      sum(m.spend) as spend, sum(m.reach) as reach, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
      sum(m.conversions) as conversions, sum(m.conversion_value) as conversion_value
    from facebook_ads_metrics m, fashion_client fc
    where m.client_id = fc.id and m.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(m.campaign, m.objective)
  )
  select * from google_rows union all select * from meta_rows
  order by channel, bucket;
$$;

create or replace function fashion_rs_ppc_campaign_detail(p_start date, p_end date)
returns table(channel text, bucket text, campaign text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  with fashion_client as (select id from clients where slug = 'fashion-friends-rs' limit 1),
  google_rows as (
    select 'google'::text as channel, fashion_rs_budget_bucket(g.campaign, g.campaign_type) as bucket, g.campaign,
      sum(g.spend) as spend, 0::numeric as reach, sum(g.impressions) as impressions, sum(g.clicks) as clicks,
      sum(g.conversions) as conversions, sum(g.conversion_value) as conversion_value
    from google_ads_metrics g, fashion_client fc
    where g.client_id = fc.id and g.report_date between p_start and p_end
    group by g.campaign, fashion_rs_budget_bucket(g.campaign, g.campaign_type)
  ),
  meta_rows as (
    select 'meta'::text as channel, fashion_rs_budget_bucket(m.campaign, m.objective) as bucket, m.campaign,
      sum(m.spend) as spend, sum(m.reach) as reach, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
      sum(m.conversions) as conversions, sum(m.conversion_value) as conversion_value
    from facebook_ads_metrics m, fashion_client fc
    where m.client_id = fc.id and m.report_date between p_start and p_end
    group by m.campaign, fashion_rs_budget_bucket(m.campaign, m.objective)
  )
  select * from google_rows union all select * from meta_rows
  order by spend desc;
$$;

grant execute on function fashion_rs_ppc_channel_summary(date, date) to authenticated;
grant execute on function fashion_rs_ppc_campaign_detail(date, date) to authenticated;
