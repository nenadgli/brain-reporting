# Windsor write actions for our accounts (GET /{connector}/actions, 20.11.2026)

Fetched with google-ads-sync `probe_actions` (GET only, nothing executed). Executing an action is
`POST https://connectors.windsor.ai/{connector}/actions` with `{account, action, params}`; the team must have write
actions enabled in Windsor Team management (otherwise 403). Not checked yet whether it is enabled for our team.

## google_ads (37)
attach_user_list_to_ad_group, create_ad_asset, create_ad_group, create_asset_group, create_campaign,
create_customer_match_list, create_performance_max_campaign, create_responsive_search_ad, delete_customer_match_list,
detach_user_list_from_ad_group, enable_ad, enable_ad_group, enable_campaign, get_customer_match_upload_status, pause_ad,
pause_ad_group, pause_campaign, push_keywords, push_negative_keywords, remove_keywords, remove_negative_keywords,
rename_ad_group, rename_campaign, rename_customer_match_list, set_ad_schedule, set_campaign_bidding_strategy,
set_campaign_budget, set_campaign_geo_targeting, set_campaign_language_targeting, set_cpc_bid_ceiling, set_max_cpc,
set_target_cpa, set_target_roas, set_url_options, update_ad_group, update_keywords, upload_customer_match_list

- create_campaign: Search or Display only (channel_type), budget in micros, created paused.
- create_performance_max_campaign: no Merchant Center / feed parameter -> no retail (shopping) PMax. Images are existing
  asset ids (no upload). Bidding maximize_conversions / maximize_conversion_value (target_roas).
- create_asset_group: added ENABLED (serves as soon as the campaign does).
- set_campaign_budget: amount_micros, daily or lifetime; shared budgets need apply_to_shared_budget=true.
- set_target_roas: ratio (4.0 = 400 %), only on campaigns already on tROAS / max conversion value.
- No Demand Gen, no video/app campaigns, no editing of existing ad text or asset groups.

## facebook (24)
boost_post, create_ad, create_ad_image, create_ad_video, create_adset, create_campaign, create_lead_form, duplicate_adset,
enable_ad, enable_adset, enable_campaign, pause_ad, pause_adset, pause_campaign, search_locations, search_targeting,
set_adset_budget, set_campaign_budget, set_lead_form_status, set_page_welcome_message, update_ad, update_ad_creative,
update_adset, update_campaign

- Budgets in cents (5000 = 50.00 EUR); max 4 budget changes per ad set per hour.
- create_ad builds a single-image/video link ad (page_id, link, image_hash/video_id) or takes a creative object;
  no product_set parameter -> catalog / DPA / Advantage+ catalog ads are not covered by the simple path.
- duplicate_adset keeps targeting, budget, schedule; copy is paused.
- create_adset needs dsa_beneficiary / dsa_payor for EU.

## tiktok (8)
enable_ad, enable_ad_group, enable_campaign, pause_ad, pause_ad_group, pause_campaign, set_ad_group_budget, set_campaign_budget

## GA4
No write actions (Windsor reads GA4 only).
