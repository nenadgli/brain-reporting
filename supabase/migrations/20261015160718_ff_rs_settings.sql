-- Fashion&Friends RS settings from the PPC team's answers: 30-day cooldown, campaign groups and modes, ROAS from GA4,
-- pacing by projection, Meta thresholds. Only Social boost stays out of the review.
update public.review_settings set params = params || jsonb_build_object(
  'cooldown_days', 30,
  'exclude_campaign_patterns', jsonb_build_array('^Social_'),
  'roas_source', 'ga4',
  'roas_days', 7,
  'roas_min_spend_eur', 100,
  'pacing_mode', 'projection',
  'meta_frequency_max', 3,
  'meta_ctr_drop', 0.3,
  'meta_cpm_rise', 0.4,
  'meta_min_ad_spend_eur', 30,
  'meta_learning_days', 4,
  'campaign_groups', jsonb_build_array(
    jsonb_build_object('name', 'Meta Social boost', 'network', 'meta', 'pattern', '^Social_', 'mode', 'ne_dirati', 'purpose', 'Social / awareness (vodi social tim)'),
    jsonb_build_object('name', 'Google Brand Search', 'network', 'google', 'pattern', 'Ct:Brand_Search', 'mode', 'upozorenja', 'purpose', 'Zaštita brenda i ecomm prodaja'),
    jsonb_build_object('name', 'Google App', 'network', 'google', 'pattern', 'Ct:App', 'mode', 'upozorenja', 'purpose', 'Loyalty / aplikacija'),
    jsonb_build_object('name', 'Meta App installs', 'network', 'meta', 'pattern', '^App ', 'mode', 'upozorenja', 'purpose', 'Loyalty / aplikacija'),
    jsonb_build_object('name', 'Meta Collection', 'network', 'meta', 'pattern', '^Collection', 'mode', 'upozorenja', 'purpose', 'Saobraćaj za MOF i BOF kampanje (nizak ROAS je očekivan)'),
    jsonb_build_object('name', 'Meta akcije', 'network', 'meta', 'pattern', '^(ADV_Akcije|Akcija)', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 8, 'min_roas', 4),
    jsonb_build_object('name', 'Meta awareness', 'network', 'meta', 'pattern', 'Ct:(Awareness|Traffic)', 'mode', 'upozorenja', 'purpose', 'Social / awareness (meri se CPM i CTR)'),
    jsonb_build_object('name', 'Meta konverzije Bof', 'network', 'meta', 'pattern', 'Ct:Conversions;Ph:Bof', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 15, 'min_roas', 8),
    jsonb_build_object('name', 'Meta konverzije Tof', 'network', 'meta', 'pattern', 'Ct:Conversions', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 8, 'min_roas', 4),
    jsonb_build_object('name', 'Google PMax', 'network', 'google', 'pattern', 'Ct:PMax', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja (često cilj prihod, ROAS nije strog)', 'target_roas', 15, 'min_roas', 8),
    jsonb_build_object('name', 'Google Display Bof', 'network', 'google', 'pattern', 'Ct:Display(_Dyn)?;Ph:Bof', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja (remarketing)', 'target_roas', 15, 'min_roas', 8),
    jsonb_build_object('name', 'Google Display Tof', 'network', 'google', 'pattern', 'Ct:Display', 'mode', 'predlozi', 'purpose', 'Prospekting, niži ROAS je očekivan', 'target_roas', 5, 'min_roas', 2),
    jsonb_build_object('name', 'Google Demand Gen', 'network', 'google', 'pattern', 'Ct:DemandGen', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 10, 'min_roas', 4),
    jsonb_build_object('name', 'Google DSA', 'network', 'google', 'pattern', '^Dynamic Search', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja', 'target_roas', 5, 'min_roas', 3),
    jsonb_build_object('name', 'Google Search po brendu', 'network', 'google', 'pattern', 'Ct:Generic_Search', 'mode', 'predlozi', 'purpose', 'Ecomm prodaja (cilj po klijentu i mesecu)', 'target_roas', 6, 'min_roas', 3)
  ))
where client_id = (select id from public.clients where name = 'Fashion&Friends RS');
