alter table google_ads_metrics add column if not exists unique_users numeric default 0;
alter table google_ad_group_metrics add column if not exists unique_users numeric default 0;
alter table google_asset_group_metrics add column if not exists unique_users numeric default 0;