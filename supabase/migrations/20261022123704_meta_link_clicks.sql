-- Meta "Link clicks" next to "Clicks (all)": the monthly report compares with Ads Manager, which shows link clicks.
alter table public.facebook_ads_metrics add column if not exists link_clicks numeric;
alter table public.meta_ad_set_metrics add column if not exists link_clicks numeric;
comment on column public.facebook_ads_metrics.clicks is 'Meta "Clicks (all)": every click on the ad, likes and profile included';
comment on column public.facebook_ads_metrics.link_clicks is 'Meta "Link clicks" (inline_link_clicks), as Ads Manager shows by default; null before it was synced';
comment on column public.meta_ad_set_metrics.link_clicks is 'Meta "Link clicks" (inline_link_clicks); null before it was synced';
