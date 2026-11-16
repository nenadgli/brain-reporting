-- One JSON per F&F market for October 2026: plan lines with actuals, GA4 by channel, Social and unplanned spend.
with c as (select id, replace(name, 'Fashion&Friends ', '') mk from clients where name ~ '^Fashion&Friends (RS|HR|ME|SI|AL|BA)$'),
ln as (
  select c.mk, json_agg(json_build_object(
    'section', x.section, 'network', x.network, 'label', x.campaign_label, 'start', x.start_date, 'end', x.end_date,
    'type', h.flight_type, 'channel', h.channel, 'reg', h.budget_regular, 'flash', h.budget_flash, 'plan', x.budget_total,
    'spend', x.spend, 'imp', x.impressions, 'clk', x.clicks, 'reach', x.reach, 'tx', x.transactions, 'rev', x.revenue,
    'inst', x.installs, 'n', cardinality(x.matched), 'matched', array_to_string(x.matched, ' | '), 'confirmed', x.map_confirmed, 'note', x.map_note,
    'team_spend', x.team_spend) order by x.start_date nulls last, x.campaign_label) lines
  from c cross join lateral mpl_report_v2(c.id, '2026-10-01') x join media_plan_history h on h.id = x.line_id
  where x.campaign_label ~ '[A-Za-z]' group by 1),
ga as (
  select c.mk, json_build_object(
    'web', json_build_array(sum(g.transactions), round(sum(g.total_revenue), 2)),
    'meta', json_build_array(sum(g.transactions) filter (where g.source = 'facebook'), round(sum(g.total_revenue) filter (where g.source = 'facebook'), 2)),
    'google', json_build_array(sum(g.transactions) filter (where g.source = 'google' and g.medium = 'cpc'), round(sum(g.total_revenue) filter (where g.source = 'google' and g.medium = 'cpc'), 2)),
    'prog', json_build_array(sum(g.transactions) filter (where g.source ~* 'rtbhouse'), round(sum(g.total_revenue) filter (where g.source ~* 'rtbhouse'), 2)),
    'tiktok', json_build_array(sum(g.transactions) filter (where g.source ~* 'tiktok'), round(sum(g.total_revenue) filter (where g.source ~* 'tiktok'), 2))) res
  from c join ga4_metrics g on g.client_id = c.id and g.report_date between '2026-10-01' and '2026-10-31' group by 1),
so as (
  select c.mk, json_agg(json_build_array(f.campaign, f.sp) order by f.sp desc) social
  from c join (select client_id, campaign, round(sum(spend), 2) sp from facebook_ads_metrics where report_date between '2026-10-01' and '2026-10-31'
               and campaign ~ '^Social' group by 1, 2 having sum(spend) > 0) f on f.client_id = c.id group by 1),
ac as (
  select c.mk,
    (select round(sum(spend), 2) from facebook_ads_metrics where client_id = c.id and report_date between '2026-10-01' and '2026-10-31' and campaign !~ '^Social') meta,
    (select round(sum(spend), 2) from google_ads_metrics where client_id = c.id and report_date between '2026-10-01' and '2026-10-31') google
  from c),
rt as (
  select c.mk, json_object_agg(p.line, json_build_array(p.sp, p.imp, p.clk)) rtb
  from c join (select client_id, line, round(sum(spend), 2) sp, sum(impressions) imp, sum(clicks) clk from programmatic_daily_metrics
               where report_date between '2026-10-01' and '2026-10-31' group by 1, 2) p on p.client_id = c.id group by 1)
select json_object_agg(c.mk, json_build_object('lines', ln.lines, 'res', ga.res, 'social', coalesce(so.social, '[]'::json),
                                               'acct', json_build_object('meta', ac.meta, 'google', ac.google),
                                               'rtb', coalesce(rt.rtb, '{}'::json)))
from c left join ln using (mk) left join ga using (mk) left join so using (mk) left join ac using (mk) left join rt using (mk);
