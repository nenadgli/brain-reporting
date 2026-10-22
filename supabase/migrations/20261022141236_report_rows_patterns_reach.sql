-- Monthly report, second round of the September 2026 check:
-- 1. Report rows can name their campaigns by a pattern (campaign_pattern, case-insensitive regex) besides a list, so a
--    renamed campaign stays in its row (Meta "App | App Installs | …" became "App_Installs_(…)") and campaign families
--    that change name every month (Social boost, awareness) get a row of their own.
-- 2. Every campaign that no row takes goes into "Ostalo (van strukture)" per network, so the rows always add up to the
--    totals (Social boost and the "Main" awareness campaign, ~4,700 € in September, were in no row).
-- 3. Meta reach is the period's reach as Meta counts it (meta_period_reach, people, not a sum of days); when the period
--    is not stored, reach is empty instead of a sum of daily reach.

alter table public.fashion_rs_report_rows add column if not exists campaign_pattern text;

-- Reach of a set of Meta campaigns (or of their ad sets) for a period: the stored period reach, matched by name, or for a
-- campaign renamed since by the same period impressions; null when the period is not stored. Campaigns are added up,
-- so people reached by two campaigns count twice (as in Ads Manager when campaign rows are added by hand).
create or replace function public.meta_reach_for(p_client_id uuid, p_start date, p_end date, p_campaigns text[], p_adset text default null)
returns numeric language sql stable set search_path = public as $function$
  with per as (
    select r.date_from, r.date_to from meta_period_reach r
    where r.client_id = p_client_id and r.date_from = p_start and r.date_to between p_end - 1 and p_end
    order by r.date_to desc limit 1
  ), own as (
    select m.campaign, sum(m.impressions) as impressions
    from (select campaign, impressions from facebook_ads_metrics where p_adset is null and client_id = p_client_id and report_date between p_start and p_end and campaign = any(p_campaigns)
          union all
          select campaign, impressions from meta_ad_set_metrics where p_adset is not null and client_id = p_client_id and report_date between p_start and p_end and campaign = any(p_campaigns) and adset_name = p_adset) m
    group by 1
  ), stored as (
    select r.* from meta_period_reach r, per
    where r.client_id = p_client_id and r.date_from = per.date_from and r.date_to = per.date_to
      and r.level = case when p_adset is null then 'campaign' else 'adset' end
      and (p_adset is null or r.adset_name = p_adset)
  )
  select case when not exists (select 1 from per) then null else
    coalesce(sum(coalesce(
      (select s.reach from stored s where s.campaign = o.campaign limit 1),
      (select min(s.reach) from stored s where s.impressions = o.impressions and o.impressions > 0 having count(*) = 1)
    )), 0) end
  from own o
$function$;

create or replace function public.fashion_rs_report_structure(p_client_id uuid, p_start date, p_end date)
 returns table(row_order integer, row_label text, channel text, level text, sub_dimension text, spend numeric, reach numeric, impressions numeric, clicks numeric, conversions numeric, conversion_value numeric, revenue_source text)
 language plpgsql stable set search_path = public
as $function$
declare
  r record;
  names text[];
  cname text;
  mkt_tag text;
  use_fallback boolean;
  used_google text[] := '{}';
  used_meta text[] := '{}';
begin
  select enable_bare_adset_revenue_match into use_fallback from clients where id = p_client_id;

  for r in
    select x.row_order, x.row_label, x.channel, x.level, x.campaign_names, x.campaign_pattern from fashion_rs_report_rows x where x.client_id = p_client_id
    union all
    -- whatever no row took, per network (filled in below from the campaigns used so far)
    select 1000, 'Ostalo (van strukture)', 'google', 'unmapped', null::text[], null::text
    union all
    select 1001, 'Ostalo (van strukture)', 'meta', 'unmapped', null::text[], null::text
    order by 1
  loop
    -- The row's campaigns in the period: its list, plus what its pattern matches; for "Ostalo", everything not used yet.
    if r.level = 'unmapped' then
      if r.channel = 'google' then
        select array_agg(distinct g.campaign) into names from google_ads_metrics g
        where g.client_id = p_client_id and g.report_date between p_start and p_end and not (g.campaign = any(used_google))
        having sum(g.spend) > 0 or sum(g.conversions) > 0;
      else
        select array_agg(distinct m.campaign) into names from facebook_ads_metrics m
        where m.client_id = p_client_id and m.report_date between p_start and p_end and not (m.campaign = any(used_meta))
        having sum(m.spend) > 0 or sum(m.conversions) > 0;
      end if;
      if names is null then continue; end if;
    else
      names := coalesce(r.campaign_names, '{}');
      if r.campaign_pattern is not null then
        if r.channel = 'google' then
          names := names || coalesce((select array_agg(distinct g.campaign) from google_ads_metrics g where g.client_id = p_client_id
            and g.report_date between p_start and p_end and g.campaign ~* r.campaign_pattern and not (g.campaign = any(names))), '{}');
        else
          names := names || coalesce((select array_agg(distinct m.campaign) from facebook_ads_metrics m where m.client_id = p_client_id
            and m.report_date between p_start and p_end and m.campaign ~* r.campaign_pattern and not (m.campaign = any(names))), '{}');
        end if;
      end if;
      -- a campaign already taken by an earlier row is not counted twice
      if r.channel = 'google' then names := array(select unnest(names) except select unnest(used_google));
      else names := array(select unnest(names) except select unnest(used_meta)); end if;
    end if;
    if r.channel = 'google' then used_google := used_google || names; else used_meta := used_meta || names; end if;

    if r.level in ('campaign', 'unmapped') then
      if r.channel = 'google' then
        return query
        select r.row_order, r.row_label, r.channel, 'campaign'::text, null::text,
          coalesce(sum(g.spend),0), null::numeric,
          coalesce(sum(g.impressions),0), coalesce(sum(g.clicks),0),
          coalesce(sum(g.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
            and ga.report_date between p_start and p_end and ga.campaign = any(names)), 0),
          'GA4'::text
        from google_ads_metrics g
        where g.client_id = p_client_id and g.report_date between p_start and p_end
          and g.campaign = any(names);
      else
        mkt_tag := substring(names[1] from 'Mkt:[A-Za-z]+');
        return query
        select r.row_order, r.row_label, r.channel, 'campaign'::text, null::text,
          coalesce(sum(m.spend),0), meta_reach_for(p_client_id, p_start, p_end, names), coalesce(sum(m.impressions),0), coalesce(sum(coalesce(m.link_clicks, m.clicks)),0),
          coalesce(sum(m.conversions),0),
          coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
            and ga.report_date between p_start and p_end
            and (
              exists (select 1 from unnest(names) cn where ga.campaign like cn || '--%')
              or (
                use_fallback and mkt_tag is not null and ga.campaign like '%' || mkt_tag || '%' and exists (
                  select 1 from meta_ad_set_metrics ms
                  where ms.client_id = p_client_id and ms.campaign = any(names)
                  and ga.campaign like substring(ms.adset_name from '^[A-Za-z0-9_]+') || '%'
                )
              )
            )), 0),
          'GA4'::text
        from facebook_ads_metrics m
        where m.client_id = p_client_id and m.report_date between p_start and p_end
          and m.campaign = any(names);
      end if;

    elsif r.level = 'meta_ad_set' then
      cname := names[1];
      mkt_tag := substring(cname from 'Mkt:[A-Za-z]+');
      return query
      with grouped as (
        select coalesce(a.adset_name, '(bez ad seta)') as adset_name,
          sum(a.spend) as spend, sum(a.impressions) as impressions, sum(coalesce(a.link_clicks, a.clicks)) as clicks, sum(a.conversions) as conversions
        from meta_ad_set_metrics a
        where a.client_id = p_client_id and a.report_date between p_start and p_end
          and a.campaign = any(names)
        group by coalesce(a.adset_name, '(bez ad seta)')
        having sum(a.spend) > 0 or sum(a.conversions) > 0
      )
      select r.row_order, r.row_label, r.channel, r.level, gr.adset_name,
        gr.spend, meta_reach_for(p_client_id, p_start, p_end, names, gr.adset_name), gr.impressions, gr.clicks, gr.conversions,
        coalesce((select sum(ga.total_revenue) from ga4_metrics ga where ga.client_id = p_client_id
          and ga.report_date between p_start and p_end
          and (
            ga.campaign like cname || '--' || substring(gr.adset_name from '^[A-Za-z0-9_]+') || '%'
            or (use_fallback and mkt_tag is not null and ga.campaign like '%' || mkt_tag || '%'
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
        and a.campaign = any(names)
      group by coalesce(a.ad_group_name, '(bez ad grupe)')
      having sum(a.spend) > 0 or sum(a.conversions) > 0
      order by sum(a.spend) desc;

    elsif r.level = 'asset_group' then
      return query
      select r.row_order, r.row_label, r.channel, r.level, coalesce(a.asset_group_name, '(bez asset grupe)'),
        sum(a.spend), null::numeric, sum(a.impressions), sum(a.clicks), sum(a.conversions), sum(a.conversion_value),
        'Platforma (GA4 nema ovu granularnost)'::text
      from google_asset_group_metrics a
      where a.client_id = p_client_id and a.report_date between p_start and p_end
        and a.campaign = any(names)
      group by coalesce(a.asset_group_name, '(bez asset grupe)')
      having sum(a.spend) > 0 or sum(a.conversions) > 0
      order by sum(a.spend) desc;
    end if;
  end loop;
end;
$function$;

-- The summary by channel and bucket: Meta reach of the bucket's campaigns for the period, the same way.
do $do$
declare d text;
begin
  select pg_get_functiondef('public.fashion_rs_ppc_channel_summary_v2(uuid,date,date)'::regprocedure) into d;
  if position('select ''meta''::text, b.bucket, b.spend, b.reach,' in d) = 0 then raise exception 'summary: meta reach not found'; end if;
  d := replace(d, 'select ''meta''::text, b.bucket, b.spend, b.reach,', 'select ''meta''::text, b.bucket, b.spend, meta_reach_for(p_client_id, p_start, p_end, b.campaigns),');
  execute d;
end $do$;
