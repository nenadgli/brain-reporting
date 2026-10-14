drop function if exists fashion_rs_report_structure(date, date);

create or replace function fashion_rs_report_structure(p_start date, p_end date)
returns table(
  row_order int, row_label text, channel text, level text, sub_dimension text,
  spend numeric, reach numeric, impressions numeric, clicks numeric,
  conversions numeric, conversion_value numeric, revenue_source text
)
language plpgsql stable as $$
declare
  fashion_client_id uuid;
  r record;
  cname text;
begin
  select id into fashion_client_id from clients where slug = 'fashion-friends-rs' limit 1;

  for r in select * from fashion_rs_report_rows order by fashion_rs_report_rows.row_order loop
    if r.level = 'campaign' then
      if r.channel = 'google' then
        return query
        select r.row_order, r.row_label, r.channel, r.level, null::text,
          coalesce(sum(g.spend),0), coalesce(sum(g.unique_users),0), coalesce(sum(g.impressions),0), coalesce(sum(g.clicks),0),
          coalesce(sum(g.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = fashion_client_id
            and ga.report_date between p_start and p_end and ga.campaign = any(r.campaign_names)), 0),
          'GA4'::text
        from google_ads_metrics g
        where g.client_id = fashion_client_id and g.report_date between p_start and p_end
          and g.campaign = any(r.campaign_names);
      else
        return query
        select r.row_order, r.row_label, r.channel, r.level, null::text,
          coalesce(sum(m.spend),0), coalesce(sum(m.reach),0), coalesce(sum(m.impressions),0), coalesce(sum(m.clicks),0),
          coalesce(sum(m.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = fashion_client_id
            and ga.report_date between p_start and p_end
            and exists (select 1 from unnest(r.campaign_names) cn where ga.campaign like cn || '--%')), 0),
          'GA4'::text
        from facebook_ads_metrics m
        where m.client_id = fashion_client_id and m.report_date between p_start and p_end
          and m.campaign = any(r.campaign_names);
      end if;

    elsif r.level = 'meta_ad_set' then
      cname := r.campaign_names[1];
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.adset_name, '(bez ad seta)'),
        sum(a.spend), 0::numeric, sum(a.impressions), sum(a.clicks), sum(a.conversions),
        coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = fashion_client_id
          and ga.report_date between p_start and p_end
          and ga.campaign like cname || '--' || a.adset_name || '%'), 0),
        'GA4'::text
      from meta_ad_set_metrics a
      where a.client_id = fashion_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.adset_name, '(bez ad seta)')
      order by sum(a.spend) desc;

    elsif r.level = 'google_ad_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.ad_group_name, '(bez ad grupe)'),
        sum(a.spend), sum(a.unique_users), sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_ad_group_metrics a
      where a.client_id = fashion_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.ad_group_name, '(bez ad grupe)')
      order by sum(a.spend) desc;

    elsif r.level = 'asset_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.asset_group_name, '(bez asset grupe)'),
        sum(a.spend), sum(a.unique_users), sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_asset_group_metrics a
      where a.client_id = fashion_client_id and a.report_date between p_start and p_end
        and a.campaign = any(r.campaign_names)
      group by coalesce(a.asset_group_name, '(bez asset grupe)')
      order by sum(a.spend) desc;
    end if;
  end loop;
end;
$$;

grant execute on function fashion_rs_report_structure(date, date) to authenticated;
