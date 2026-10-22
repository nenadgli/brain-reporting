-- Backfill of Meta link clicks into the rows already stored (facebook-ads-sync / meta-adset-sync with link_clicks_only):
-- matched by source, date and name, so old rows keep their names. Rows of campaigns renamed since keep null and the
-- report falls back to all clicks for them. Called by the sync functions only (service role).
create or replace function public.meta_link_clicks_fill(p_source uuid, p_level text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $function$
declare n int;
begin
  if p_level = 'campaign' then
    update facebook_ads_metrics m set link_clicks = (x->>'link_clicks')::numeric
    from jsonb_array_elements(p_rows) x
    where m.data_source_id = p_source and m.report_date = (x->>'date')::date and m.campaign = x->>'campaign';
  else
    update meta_ad_set_metrics m set link_clicks = (x->>'link_clicks')::numeric
    from jsonb_array_elements(p_rows) x
    where m.data_source_id = p_source and m.report_date = (x->>'date')::date and m.campaign = x->>'campaign'
      and m.adset_name is not distinct from (x->>'adset_name');
  end if;
  get diagnostics n = row_count;
  return n;
end $function$;
revoke all on function public.meta_link_clicks_fill(uuid, text, jsonb) from public, anon, authenticated;
