alter table public.facebook_ads_metrics add column if not exists installs numeric;
comment on column public.facebook_ads_metrics.installs is 'App installs (actions:mobile_app_install, the App campaigns'' result in Meta).';
