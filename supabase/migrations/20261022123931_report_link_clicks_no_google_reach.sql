-- Monthly report (fashion_rs_report_structure, fashion_rs_ppc_channel_summary_v2), from the September 2026 check:
-- no Google reach (a sum of daily unique users per device is not reach), Meta link clicks as Ads Manager shows them
-- (all clicks until a day is synced again), and ad sets / ad groups / asset groups with purchases but no spend in the
-- period (attributed to earlier days) are listed, so the rows add up to the campaign.
-- Parts of the live definitions are replaced in place; a part that is not found stops the migration.
do $do$
declare d text;
  pairs text[][] := array[
    array['case when bool_and(g.campaign_type = ''SEARCH'') then null else coalesce(sum(g.unique_users),0) end', 'null::numeric'],
    array['coalesce(sum(m.impressions),0), coalesce(sum(m.clicks),0)', 'coalesce(sum(m.impressions),0), coalesce(sum(coalesce(m.link_clicks, m.clicks)),0)'],
    array['sum(a.impressions) as impressions, sum(a.clicks) as clicks, sum(a.conversions) as conversions', 'sum(a.impressions) as impressions, sum(coalesce(a.link_clicks, a.clicks)) as clicks, sum(a.conversions) as conversions'],
    array['group by coalesce(a.adset_name, ''(bez ad seta)'')
        having sum(a.spend) > 0', 'group by coalesce(a.adset_name, ''(bez ad seta)'')
        having sum(a.spend) > 0 or sum(a.conversions) > 0'],
    array['group by coalesce(a.ad_group_name, ''(bez ad grupe)'')
      having sum(a.spend) > 0', 'group by coalesce(a.ad_group_name, ''(bez ad grupe)'')
      having sum(a.spend) > 0 or sum(a.conversions) > 0'],
    array['group by coalesce(a.asset_group_name, ''(bez asset grupe)'')
      having sum(a.spend) > 0', 'group by coalesce(a.asset_group_name, ''(bez asset grupe)'')
      having sum(a.spend) > 0 or sum(a.conversions) > 0']];
  i int;
begin
  select pg_get_functiondef('public.fashion_rs_report_structure(uuid,date,date)'::regprocedure) into d;
  for i in 1 .. array_length(pairs, 1) loop
    if position(pairs[i][1] in d) = 0 then raise exception 'report_structure: part % not found', i; end if;
    d := replace(d, pairs[i][1], pairs[i][2]);
  end loop;
  execute d;

  select pg_get_functiondef('public.fashion_rs_ppc_channel_summary_v2(uuid,date,date)'::regprocedure) into d;
  if position('sum(g.spend), sum(g.unique_users), sum(g.impressions)' in d) = 0 then raise exception 'summary: google reach not found'; end if;
  if position('sum(m.clicks) as clicks' in d) = 0 then raise exception 'summary: meta clicks not found'; end if;
  d := replace(d, 'sum(g.spend), sum(g.unique_users), sum(g.impressions)', 'sum(g.spend), null::numeric, sum(g.impressions)');
  d := replace(d, 'sum(m.clicks) as clicks', 'sum(coalesce(m.link_clicks, m.clicks)) as clicks');
  execute d;
end $do$;
