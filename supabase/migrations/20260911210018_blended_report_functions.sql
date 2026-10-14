-- Daily spend/conversions per channel (google vs meta), for stacked/toggleable charts
create or replace function blended_daily_trend(p_client_id uuid, p_start date, p_end date)
returns table(report_date date, channel text, spend numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select report_date, 'google'::text, sum(spend), sum(conversions), sum(conversion_value)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by report_date
  union all
  select report_date, 'meta'::text, sum(spend), sum(conversions), sum(conversion_value)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by report_date
  order by 1;
$$;

-- Per-channel period totals, one row per channel
create or replace function blended_channel_summary(p_client_id uuid, p_start date, p_end date)
returns table(channel text, impressions numeric, clicks numeric, spend numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select 'google'::text, coalesce(sum(impressions),0), coalesce(sum(clicks),0), coalesce(sum(spend),0), coalesce(sum(conversions),0), coalesce(sum(conversion_value),0)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  union all
  select 'meta'::text, coalesce(sum(impressions),0), coalesce(sum(clicks),0), coalesce(sum(spend),0), coalesce(sum(conversions),0), coalesce(sum(conversion_value),0)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end;
$$;

-- Combined campaign-level ranking across both channels
create or replace function blended_campaign_summary(p_client_id uuid, p_start date, p_end date)
returns table(channel text, campaign text, impressions numeric, clicks numeric, spend numeric, conversions numeric, conversion_value numeric)
language sql stable as $$
  select 'google'::text, campaign, sum(impressions), sum(clicks), sum(spend), sum(conversions), sum(conversion_value)
  from google_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by campaign
  union all
  select 'meta'::text, campaign, sum(impressions), sum(clicks), sum(spend), sum(conversions), sum(conversion_value)
  from facebook_ads_metrics
  where client_id = p_client_id and report_date between p_start and p_end
  group by campaign
  order by 5 desc;
$$;

-- Overall date range available across both channels (for period-comparison split)
create or replace function blended_date_range(p_client_id uuid)
returns table(min_date date, max_date date)
language sql stable as $$
  select min(d), max(d) from (
    select min(report_date) as d from google_ads_metrics where client_id = p_client_id
    union all select max(report_date) from google_ads_metrics where client_id = p_client_id
    union all select min(report_date) from facebook_ads_metrics where client_id = p_client_id
    union all select max(report_date) from facebook_ads_metrics where client_id = p_client_id
  ) t;
$$;

grant execute on function blended_daily_trend(uuid, date, date) to anon, authenticated;
grant execute on function blended_channel_summary(uuid, date, date) to anon, authenticated;
grant execute on function blended_campaign_summary(uuid, date, date) to anon, authenticated;
grant execute on function blended_date_range(uuid) to anon, authenticated;
