create or replace function fashion_rs_ppc_channel_summary(p_client_id uuid, p_start date, p_end date)
returns table(channel text, bucket text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric)
language plpgsql stable as $$
declare
  b record;
  camp_list text[];
begin
  -- Google: unchanged, straightforward campaign-name match
  return query
  select 'google'::text, fashion_rs_budget_bucket(g.campaign, g.campaign_type),
    sum(g.spend), sum(g.unique_users), sum(g.impressions), sum(g.clicks), sum(g.conversions),
    (select coalesce(sum(ga.total_revenue),0) from ga4_metrics ga
      where ga.client_id = p_client_id and ga.report_date between p_start and p_end
      and ga.campaign = any(array_agg(distinct g.campaign)))
  from google_ads_metrics g
  where g.client_id = p_client_id and g.report_date between p_start and p_end
  group by fashion_rs_budget_bucket(g.campaign, g.campaign_type);

  -- Meta: loop per bucket so we can do the campaign-list + adset-fallback revenue match cleanly
  for b in
    select fashion_rs_budget_bucket(m.campaign, m.objective) as bucket,
      array_agg(distinct m.campaign) as campaigns,
      sum(m.spend) as spend, sum(m.reach) as reach, sum(m.impressions) as impressions,
      sum(m.clicks) as clicks, sum(m.conversions) as conversions
    from facebook_ads_metrics m
    where m.client_id = p_client_id and m.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(m.campaign, m.objective)
  loop
    return query
    select 'meta'::text, b.bucket, b.spend, b.reach, b.impressions, b.clicks, b.conversions,
      coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
        and ga.report_date between p_start and p_end
        and (
          exists (select 1 from unnest(b.campaigns) cn where ga.campaign like cn || '--%')
          or exists (
            select 1 from meta_ad_set_metrics ms
            where ms.client_id = p_client_id and ms.campaign = any(b.campaigns)
            and ga.campaign like substring(ms.adset_name from '^[A-Za-z0-9_]+') || '%'
          )
        )), 0);
  end loop;
end;
$$;
