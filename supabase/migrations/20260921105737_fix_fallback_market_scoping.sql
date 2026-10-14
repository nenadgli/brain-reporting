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
  mkt_tag text;
begin
  for r in select * from fashion_rs_report_rows where fashion_rs_report_rows.client_id = p_client_id order by fashion_rs_report_rows.row_order loop
    if r.level = 'campaign' then
      if r.channel = 'google' then
        return query
        select r.row_order, r.row_label, r.channel, r.level, null::text,
          coalesce(sum(g.spend),0),
          case when bool_and(g.campaign_type = 'SEARCH') then null else coalesce(sum(g.unique_users),0) end,
          coalesce(sum(g.impressions),0), coalesce(sum(g.clicks),0),
          coalesce(sum(g.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
            and ga.report_date between p_start and p_end and ga.campaign = any(r.campaign_names)), 0),
          'GA4'::text
        from google_ads_metrics g
        where g.client_id = p_client_id and g.report_date between p_start and p_end
          and g.campaign = any(r.campaign_names);
      else
        mkt_tag := substring(r.campaign_names[1] from 'Mkt:[A-Za-z]+');
        return query
        select r.row_order, r.row_label, r.channel, r.level, null::text,
          coalesce(sum(m.spend),0), coalesce(sum(m.reach),0), coalesce(sum(m.impressions),0), coalesce(sum(m.clicks),0),
          coalesce(sum(m.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
            and ga.report_date between p_start and p_end
            and (
              exists (select 1 from unnest(r.campaign_names) cn where ga.campaign like cn || '--%')
              or (
                mkt_tag is not null and ga.campaign like '%' || mkt_tag || '%' and exists (
                  select 1 from meta_ad_set_metrics ms
                  where ms.client_id = p_client_id and ms.campaign = any(r.campaign_names)
                  and ga.campaign like substring(ms.adset_name from '^[A-Za-z0-9_]+') || '%'
                )
              )
            )), 0),
          'GA4'::text
        from facebook_ads_metrics m
        where m.client_id = p_client_id and m.report_date between p_start and p_end
          and m.campaign = any(r.campaign_names);
      end if;

    elsif r.level = 'meta_ad_set' then
      cname := r.campaign_names[1];
      mkt_tag := substring(cname from 'Mkt:[A-Za-z]+');
      return query
      with grouped as (
        select coalesce(a.adset_name, '(bez ad seta)') as adset_name,
          sum(a.spend) as spend, sum(a.reach) as reach, sum(a.impressions) as impressions, sum(a.clicks) as clicks, sum(a.conversions) as conversions
        from meta_ad_set_metrics a
        where a.client_id = p_client_id and a.report_date between p_start and p_end
          and a.campaign = any(r.campaign_names)
        group by coalesce(a.adset_name, '(bez ad seta)')
        having sum(a.spend) > 0
      )
      select r.row_order, r.row_label, r.channel, r.level, gr.adset_name,
        gr.spend, gr.reach, gr.impressions, gr.clicks, gr.conversions,
        coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
          and ga.report_date between p_start and p_end
          and (
            ga.campaign like cname || '--' || substring(gr.adset_name from '^[A-Za-z0-9_]+') || '%'
            or (mkt_tag is not null and ga.campaign like '%' || mkt_tag || '%'
                and ga.campaign like substring(gr.adset_name from '^[A-Za-z0-9_]+') || '%')
          )), 0),
        'GA4'::text
      from grouped gr
      order by gr.spend desc;

    elsif r.level = 'google_ad_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.ad_group_name, '(bez ad grupe)'),
        sum(a.spend), null::numeric, sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_ad_group_metrics a
      where a.client_id = p_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.ad_group_name, '(bez ad grupe)')
      having sum(a.spend) > 0
      order by sum(a.spend) desc;

    elsif r.level = 'asset_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.asset_group_name, '(bez asset grupe)'),
        sum(a.spend), null::numeric, sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_asset_group_metrics a
      where a.client_id = p_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.asset_group_name, '(bez asset grupe)')
      having sum(a.spend) > 0
      order by sum(a.spend) desc;
    end if;
  end loop;
end;
$$;

create or replace function fashion_rs_ppc_channel_summary(p_client_id uuid, p_start date, p_end date)
returns table(channel text, bucket text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric)
language plpgsql stable as $$
declare
  b record;
  mkt_tag text;
begin
  return query
  select 'google'::text, fashion_rs_budget_bucket(g.campaign, g.campaign_type),
    sum(g.spend), sum(g.unique_users), sum(g.impressions), sum(g.clicks), sum(g.conversions),
    (select coalesce(sum(ga.total_revenue),0) from ga4_metrics ga
      where ga.client_id = p_client_id and ga.report_date between p_start and p_end
      and ga.campaign = any(array_agg(distinct g.campaign)))
  from google_ads_metrics g
  where g.client_id = p_client_id and g.report_date between p_start and p_end
  group by fashion_rs_budget_bucket(g.campaign, g.campaign_type);

  for b in
    select fashion_rs_budget_bucket(m.campaign, m.objective) as bucket,
      array_agg(distinct m.campaign) as campaigns,
      sum(m.spend) as spend, sum(m.reach) as reach, sum(m.impressions) as impressions,
      sum(m.clicks) as clicks, sum(m.conversions) as conversions
    from facebook_ads_metrics m
    where m.client_id = p_client_id and m.report_date between p_start and p_end
    group by fashion_rs_budget_bucket(m.campaign, m.objective)
  loop
    mkt_tag := substring(b.campaigns[1] from 'Mkt:[A-Za-z]+');
    return query
    select 'meta'::text, b.bucket, b.spend, b.reach, b.impressions, b.clicks, b.conversions,
      coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
        and ga.report_date between p_start and p_end
        and (
          exists (select 1 from unnest(b.campaigns) cn where ga.campaign like cn || '--%')
          or (
            mkt_tag is not null and ga.campaign like '%' || mkt_tag || '%' and exists (
              select 1 from meta_ad_set_metrics ms
              where ms.client_id = p_client_id and ms.campaign = any(b.campaigns)
              and ga.campaign like substring(ms.adset_name from '^[A-Za-z0-9_]+') || '%'
            )
          )
        )), 0);
  end loop;
end;
$$;
