-- Daily spend/conversions trend across the full requested range
create or replace function google_ads_daily_trend(p_client_id uuid, p_start date, p_end date)
returns table(report_date date, spend numeric, conversions numeric)
language sql stable as $$
  select report_date, sum(spend), sum(conversions)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by report_date
  order by report_date;
$$;

-- Totals for one period (current or previous)
create or replace function google_ads_period_totals(p_client_id uuid, p_start date, p_end date)
returns table(impressions numeric, clicks numeric, spend numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select coalesce(sum(impressions),0), coalesce(sum(clicks),0), coalesce(sum(spend),0),
         coalesce(sum(conversions),0), coalesce(sum(conversion_value),0)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end;
$$;

-- Per-campaign aggregation for a period
create or replace function google_ads_campaign_summary(p_client_id uuid, p_start date, p_end date)
returns table(campaign text, campaign_type text, impressions numeric, clicks numeric, spend numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select campaign, max(campaign_type), sum(impressions), sum(clicks), sum(spend), sum(conversions), sum(conversion_value)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by campaign
  order by sum(spend) desc;
$$;

-- Per campaign_type aggregation
create or replace function google_ads_campaign_type_summary(p_client_id uuid, p_start date, p_end date)
returns table(campaign_type text, spend numeric, clicks numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select coalesce(campaign_type, 'OSTALO'), sum(spend), sum(clicks), sum(conversions), sum(conversion_value)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(campaign_type, 'OSTALO')
  order by sum(spend) desc;
$$;

-- Per device aggregation
create or replace function google_ads_device_summary(p_client_id uuid, p_start date, p_end date)
returns table(device text, spend numeric, clicks numeric, impressions numeric, conversions numeric)
language sql stable as $$
  select coalesce(device, 'OTHER'), sum(spend), sum(clicks), sum(impressions), sum(conversions)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by coalesce(device, 'OTHER')
  order by sum(spend) desc;
$$;

-- Impression-weighted average search impression share (SEARCH campaigns only)
create or replace function google_ads_impression_share(p_client_id uuid, p_start date, p_end date)
returns table(avg_share numeric)
language sql stable as $$
  select case when sum(impressions) > 0
    then sum(search_impression_share * impressions) / sum(impressions) * 100
    else null end
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
    and campaign_type = 'SEARCH' and search_impression_share is not null;
$$;

-- Top keywords by spend
create or replace function google_ads_top_keywords(p_client_id uuid, p_start date, p_end date, p_limit int default 20)
returns table(keyword_text text, keyword_match_type text, impressions numeric, clicks numeric, spend numeric, conversions numeric, avg_quality_score numeric)
language sql stable as $$
  select keyword_text, max(keyword_match_type), sum(impressions), sum(clicks), sum(spend), sum(conversions), avg(quality_score)
  from google_ads_keywords
  where client_id = p_client_id and report_date between p_start and p_end
  group by keyword_text
  order by sum(spend) desc
  limit p_limit;
$$;

-- Top search terms by spend, optionally restricted to zero-conversion terms with clicks (negative keyword candidates)
create or replace function google_ads_top_search_terms(p_client_id uuid, p_start date, p_end date, p_zero_conv_only boolean default false, p_limit int default 25)
returns table(search_term text, impressions numeric, clicks numeric, spend numeric, conversions numeric)
language sql stable as $$
  select search_term, sum(impressions), sum(clicks), sum(spend), sum(conversions)
  from google_ads_search_terms
  where client_id = p_client_id and report_date between p_start and p_end
  group by search_term
  having (not p_zero_conv_only) or (sum(conversions) = 0 and sum(clicks) > 0)
  order by sum(spend) desc
  limit p_limit;
$$;

-- Top competitor domains by co-occurrence
create or replace function google_ads_top_competitors(p_client_id uuid, p_start date, p_end date, p_limit int default 12)
returns table(domain text, campaign_count bigint, occurrences bigint)
language sql stable as $$
  select domain, count(distinct campaign), count(*)
  from google_ads_competitors
  where client_id = p_client_id and report_date between p_start and p_end
  group by domain
  order by count(*) desc
  limit p_limit;
$$;

grant execute on function google_ads_daily_trend(uuid, date, date) to anon, authenticated;
grant execute on function google_ads_period_totals(uuid, date, date) to anon, authenticated;
grant execute on function google_ads_campaign_summary(uuid, date, date) to anon, authenticated;
grant execute on function google_ads_campaign_type_summary(uuid, date, date) to anon, authenticated;
grant execute on function google_ads_device_summary(uuid, date, date) to anon, authenticated;
grant execute on function google_ads_impression_share(uuid, date, date) to anon, authenticated;
grant execute on function google_ads_top_keywords(uuid, date, date, int) to anon, authenticated;
grant execute on function google_ads_top_search_terms(uuid, date, date, boolean, int) to anon, authenticated;
grant execute on function google_ads_top_competitors(uuid, date, date, int) to anon, authenticated;
