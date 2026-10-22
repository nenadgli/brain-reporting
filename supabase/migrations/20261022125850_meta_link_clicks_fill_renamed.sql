-- Link clicks backfill, second match: a campaign renamed since (e.g. Mkt:BiH -> Mkt:BA) keeps its old name in the stored
-- rows, so a row still without link clicks takes them from Windsor's row of the same day with the same spend and
-- impressions, when exactly one such row exists.
create or replace function public.meta_link_clicks_fill(p_source uuid, p_level text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $function$
declare n int; n2 int;
begin
  if p_level = 'campaign' then
    update facebook_ads_metrics m set link_clicks = (x->>'link_clicks')::numeric
    from jsonb_array_elements(p_rows) x
    where m.data_source_id = p_source and m.report_date = (x->>'date')::date and m.campaign = x->>'campaign';
    get diagnostics n = row_count;
    -- A campaign renamed since keeps its old name in the stored rows: the same day with the same spend and impressions is it.
    with x as (select (e->>'date')::date d, (e->>'spend')::numeric sp, (e->>'impressions')::numeric im, (e->>'link_clicks')::numeric lc
               from jsonb_array_elements(p_rows) e where coalesce((e->>'impressions')::numeric, 0) > 0),
    u as (select d, sp, im, min(lc) lc from x group by 1, 2, 3 having count(*) = 1)
    update facebook_ads_metrics m set link_clicks = u.lc
    from u where m.data_source_id = p_source and m.link_clicks is null and m.report_date = u.d and m.spend = u.sp and m.impressions = u.im;
    get diagnostics n2 = row_count;
  else
    update meta_ad_set_metrics m set link_clicks = (x->>'link_clicks')::numeric
    from jsonb_array_elements(p_rows) x
    where m.data_source_id = p_source and m.report_date = (x->>'date')::date and m.campaign = x->>'campaign'
      and m.adset_name is not distinct from (x->>'adset_name');
    get diagnostics n = row_count;
    with x as (select (e->>'date')::date d, (e->>'spend')::numeric sp, (e->>'impressions')::numeric im, (e->>'link_clicks')::numeric lc
               from jsonb_array_elements(p_rows) e where coalesce((e->>'impressions')::numeric, 0) > 0),
    u as (select d, sp, im, min(lc) lc from x group by 1, 2, 3 having count(*) = 1)
    update meta_ad_set_metrics m set link_clicks = u.lc
    from u where m.data_source_id = p_source and m.link_clicks is null and m.report_date = u.d and m.spend = u.sp and m.impressions = u.im;
    get diagnostics n2 = row_count;
  end if;
  return n + n2;
end $function$;
revoke all on function public.meta_link_clicks_fill(uuid, text, jsonb) from public, anon, authenticated;
