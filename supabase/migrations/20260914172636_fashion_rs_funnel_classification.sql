-- Specific to Fashion&Friends RS naming convention (Mkt:/Ct:/Ph: tags embedded in campaign names).
-- Not intended as a generic classifier for other clients.

create or replace function fashion_rs_extract_tag(p_campaign text, p_tag text)
returns text
language sql immutable as $$
  select (regexp_match(p_campaign, p_tag || ':([^;)]+)'))[1];
$$;

create or replace function fashion_rs_classify(p_campaign text, p_native_type text)
returns table(campaign_subtype text, funnel_group text, funnel_stage text)
language plpgsql immutable as $$
declare
  ct text := fashion_rs_extract_tag(p_campaign, 'Ct');
  ph text := fashion_rs_extract_tag(p_campaign, 'Ph');
begin
  -- Dynamic display (prospecting/remarketing split by Ph) — Pure Performance
  if ct ilike '%Display_Dyn%' or ct ilike '%Dyn%' then
    if ph ilike 'Bof' then
      return query select 'Dynamic remarketing'::text, 'Pure Performance'::text, 'BOF'::text;
    else
      return query select 'Dynamic prospecting'::text, 'Pure Performance'::text, 'TOF'::text;
    end if;
  end if;

  -- Plain Display (not dynamic) — Brandformance
  if ct ilike '%Display%' then
    return query select 'Display'::text, 'Brandformance'::text, coalesce(nullif(upper(ph), ''), 'TOF')::text;
  end if;

  if ct ilike '%PMax%' or ct ilike '%Pmax%' then
    return query select 'Performance Max'::text, 'Brandformance'::text, 'Full-funnel'::text;
  end if;

  if ct ilike '%DemandGen%' or ct ilike '%Demand_Gen%' or ct ilike '%DemanGen%' then
    return query select 'Demand Gen'::text, 'Brandformance'::text, 'TOF'::text;
  end if;

  if ct ilike '%Brand_Search%' then
    return query select 'Brand Search'::text, 'Pure Performance'::text, 'BOF'::text;
  end if;

  if ct ilike '%Generic_Search%' then
    return query select 'Generic Search'::text, 'Pure Performance'::text, 'BOF'::text;
  end if;

  if ct ilike '%App%' then
    return query select 'App Install'::text, 'Brandformance'::text, 'TOF'::text;
  end if;

  -- Meta "Conversions" campaigns = catalog-sales-equivalent, split TOF/BOF like the doc's Catalog sales prospecting/remarketing
  if ct ilike '%Conversions%' then
    if ph ilike 'Bof' then
      return query select 'Catalog Sales (remarketing)'::text, 'Pure Performance'::text, 'BOF'::text;
    else
      return query select 'Catalog Sales (prospecting)'::text, 'Pure Performance'::text, 'TOF'::text;
    end if;
  end if;

  if ct ilike '%Traffic%' or ct ilike '%Awareness%' then
    return query select 'Reach/Traffic'::text, 'Brandformance'::text, 'TOF'::text;
  end if;

  -- Legacy/untagged campaigns: fall back to the platform's native objective/campaign_type
  if p_native_type ilike '%AWARENESS%' or p_native_type ilike '%LINK_CLICKS%' then
    return query select 'Reach/Traffic (legacy)'::text, 'Brandformance'::text, 'TOF'::text;
  end if;
  if p_native_type ilike '%APP_INSTALLS%' then
    return query select 'App Install (legacy)'::text, 'Brandformance'::text, 'TOF'::text;
  end if;

  return query select coalesce(p_native_type, 'Nekategorisano')::text, 'Nekategorisano'::text, 'Nepoznato'::text;
end;
$$;

-- Combined funnel summary across Google Ads + Meta for Fashion&Friends RS specifically.
create or replace function fashion_rs_funnel_summary(p_start date, p_end date)
returns table(funnel_group text, funnel_stage text, campaign_subtype text, channel text, spend numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  with fashion_client as (
    select id from clients where slug = 'fashion-friends-rs' limit 1
  ),
  google_rows as (
    select
      (fashion_rs_classify(g.campaign, g.campaign_type)).*,
      'google'::text as channel,
      sum(g.spend) as spend, sum(g.clicks) as clicks, sum(g.conversions) as conversions, sum(g.conversion_value) as conversion_value
    from google_ads_metrics g, fashion_client fc
    where g.client_id = fc.id and g.report_date between p_start and p_end
    group by g.campaign, g.campaign_type
  ),
  meta_rows as (
    select
      (fashion_rs_classify(m.campaign, m.objective)).*,
      'meta'::text as channel,
      sum(m.spend) as spend, sum(m.clicks) as clicks, sum(m.conversions) as conversions, sum(m.conversion_value) as conversion_value
    from facebook_ads_metrics m, fashion_client fc
    where m.client_id = fc.id and m.report_date between p_start and p_end
    group by m.campaign, m.objective
  ),
  combined as (
    select * from google_rows union all select * from meta_rows
  )
  select funnel_group, funnel_stage, campaign_subtype, channel,
    sum(spend), sum(clicks), sum(conversions), sum(conversion_value)
  from combined
  group by funnel_group, funnel_stage, campaign_subtype, channel
  order by sum(spend) desc;
$$;

create or replace function fashion_rs_funnel_group_totals(p_start date, p_end date)
returns table(funnel_group text, spend numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select funnel_group, sum(spend), sum(conversions), sum(conversion_value)
  from fashion_rs_funnel_summary(p_start, p_end)
  group by funnel_group
  order by sum(spend) desc;
$$;

grant execute on function fashion_rs_funnel_summary(date, date) to authenticated;
grant execute on function fashion_rs_funnel_group_totals(date, date) to authenticated;
