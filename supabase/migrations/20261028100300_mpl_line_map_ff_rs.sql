-- F&F RS, September and October 2026: which campaigns / ad sets / asset groups make each MPL line.
-- confirmed = false where the link is our reading of the names and the PPC team still has to confirm it.
insert into public.media_plan_line_map (client_id, month, network, campaign_label, plan_start, level, campaign_pattern, sub_pattern, confirmed, note)
select c.id, v.month::date, v.network, v.label, v.plan_start::date, v.level, v.cp, v.sp, v.confirmed, v.note
from clients c cross join (values
  -- September: Meta
  ('2026-09-01', 'meta', 'Main campaign FW26 - Traffic',       '2026-09-21', 'meta_ad_set', '^Collection\(Mkt:RS', '^Main_traffic\(Mkt:RS', true, null),
  ('2026-09-01', 'meta', 'Main campaign FW26 - Conversion',    '2026-09-21', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^Main_FW26_?\(Mkt:RS', true, 'GA4 ima samo 60 sesija za ovaj ad set (45.828 link klikova) - UTM-ovi ne rade'),
  ('2026-09-01', 'meta', 'Main campaign FW26 - Remarketing',   '2026-09-21', 'meta_ad_set', '^Remarketinga\(Mkt:RS', '^Main\(Mkt:RS', true, null),
  ('2026-09-01', 'meta', 'Main campaign FW26 - Awareness',     '2026-09-21', 'campaign',    '^Main\(Mkt:RS;Ct:Awareness', null, true, null),
  ('2026-09-01', 'meta', 'Precollection - Conversion',         '2026-09-01', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^Precollection_FW26\(Mkt:RS', true, null),
  ('2026-09-01', 'meta', 'Precollection - Traffic',            '2026-09-01', 'meta_ad_set', '^Collection\(Mkt:RS', '^Precollection_traffic\(Mkt:RS', true, null),
  ('2026-09-01', 'meta', 'Precollection - Remarketing',        '2026-09-07', 'meta_ad_set', '^Remarketinga\(Mkt:RS', '^Precollection\(Mkt:RS', true, null),
  ('2026-09-01', 'meta', 'Univerzalna kampanja - Conversion',  '2026-09-01', 'campaign',    '^Univerzalna1_?\(Mkt:RS', null, true, null),
  ('2026-09-01', 'meta', 'Univerzalna kampanja - Remarketing', '2026-09-01', 'campaign',    '^Univerzalna\(Mkt:RS', null, true, null),
  ('2026-09-01', 'meta', 'KIKO - Conversion',                  '2026-09-01', 'campaign',    '^KIKO_\(Mkt:RS', null, true, null),
  ('2026-09-01', 'meta', 'Ad hoc akcija - Conversion',         null,         'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^(BTS|Final_sale)', false, null),
  ('2026-09-01', 'meta', 'Ad hoc akcija - Remarketing',        null,         'meta_ad_set', '^Remarketinga\(Mkt:RS', '^(BTS|Final_sale)', false, null),
  ('2026-09-01', 'meta', 'App Install (Android)',              '2026-09-01', 'campaign',    '^App', null, true, null),
  -- September: Google
  ('2026-09-01', 'google', 'Search Category + Brand',          '2026-09-01', 'campaign', '^(?!KIKO |Outlet ).*\(Mkt:RS;Ct:(Generic|Brand)_Search\)$', null, true, null),
  ('2026-09-01', 'google', 'Search KIKO Brand',                '2026-09-01', 'campaign', '^KIKO \(Mkt:RS;Ct:Generic_Search\)$', null, true, null),
  ('2026-09-01', 'google', 'Search Outlet',                    '2026-09-01', 'campaign', '^Outlet \(Mkt:RS;Ct:Brand_Search\)$', null, true, null),
  ('2026-09-01', 'google', 'KIKO Remarketing',                 '2026-09-01', 'campaign', '^KIKO \(Mkt:RS;Ct:Display;Ph:Bof\)$', null, true, null),
  ('2026-09-01', 'google', 'KIKO Prospecting',                 '2026-09-01', 'campaign', '^KIKO \(Mkt:RS;Ct:Display;Ph:Tof\)$', null, true, null),
  ('2026-09-01', 'google', 'Dynamic Display Remarketing',      '2026-09-01', 'campaign', '^AOn.*\(Mkt:RS;Ct:Display_Dyn;Ph:Bof\)$', null, true, null),
  ('2026-09-01', 'google', 'Dynamic Display Prospecting',      '2026-09-01', 'campaign', '^AOn \(Mkt:RS;Ct:Display_Dyn;Ph:Tof\)$', null, true, null),
  ('2026-09-01', 'google', 'Main campaign FW26 - Pmax',        '2026-09-21', 'campaign', '^AOn \(Mkt:RS;Ct:PMax\)$', null, true, null),
  ('2026-09-01', 'google', 'Precollection - Pmax',             '2026-09-01', 'campaign', '^BTS_Precollection \(Mkt:RS;Ct:PMax\)$', null, true, null),
  ('2026-09-01', 'google', 'Main campaign FW26  - Demand Gen', '2026-09-24', 'campaign', '^AOn \(Mkt:RS;Ct:DemandGen;Ph:Tof\)$', null, true, null),
  ('2026-09-01', 'google', 'App Install (Android)',            '2026-09-01', 'campaign', '\(Mkt:RS;Ct:App\)$', null, true, null),
  -- October: Meta
  ('2026-10-01', 'meta', 'Univerzalna kampanja - Remarketing', '2026-10-01', 'campaign',    '^Univerzalna\(Mkt:RS', null, true, null),
  ('2026-10-01', 'meta', 'Univerzalna kampanja - Conversion',  '2026-10-01', 'campaign',    '^Univerzalna1_?\(Mkt:RS', null, true, null),
  ('2026-10-01', 'meta', 'KIKO - Conversion',                  '2026-10-01', 'campaign',    '^KIKO_\(Mkt:RS', null, true, null),
  ('2026-10-01', 'meta', 'App Install (Android)',              '2026-10-01', 'campaign',    '^App', null, true, null),
  ('2026-10-01', 'meta', 'Main campaign FW26 - Conversion',    '2026-10-01', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^Main_FW26_?\(Mkt:RS', true, null),
  ('2026-10-01', 'meta', 'Main campaign FW26 - Remarketing',   '2026-10-01', 'meta_ad_set', '^Remarketinga\(Mkt:RS', '^Main\(Mkt:RS', true, null),
  ('2026-10-01', 'meta', 'Main campaign FW26 - Traffic',       '2026-10-01', 'meta_ad_set', '^Collection\(Mkt:RS', '^Main_traffic\(Mkt:RS', true, null),
  ('2026-10-01', 'meta', '–20% FW - Conversion',               '2026-10-02', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^Akcija_20%_na_FW26\(', true, null),
  ('2026-10-01', 'meta', '–20% FW - Remarketing',              '2026-10-02', 'meta_ad_set', '^Remarketinga\(Mkt:RS', '^Akcija_20%_na_FW26\(', true, null),
  ('2026-10-01', 'meta', '–20% FW - Traffic',                  '2026-10-02', 'meta_ad_set', '^Collection\(Mkt:RS', '^Akcija_20%_na_FW26_traffic', true, null),
  ('2026-10-01', 'meta', '–20% FW - Conversion',               '2026-10-08', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^Akcija_20%_?na_racun\(', true, null),
  ('2026-10-01', 'meta', '–20% FW - Remarketing',              '2026-10-08', 'meta_ad_set', '^Remarketinga\(Mkt:RS', '^Akcija_20%_?na_racun\(', true, null),
  ('2026-10-01', 'meta', '–20% FW - Traffic',                  '2026-10-08', 'meta_ad_set', '^Collection\(Mkt:RS', '^Akcija_20%_?na_racun_traffic', true, null),
  ('2026-10-01', 'meta', '–20% FW awareness',                  '2026-10-08', 'campaign',    '^Akcija_-20%\(Mkt:RS;Ct:Awareness', null, true, null),
  ('2026-10-01', 'meta', 'MSS - Conversion',                   '2026-10-30', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS', '^Loyalty_?\(', false, 'Pretpostavka: MSS = Loyalty ad setovi od 22.10. (plan kaže 30.-31.10.)'),
  ('2026-10-01', 'meta', 'MSS - Remarketing',                  '2026-10-30', 'meta_ad_set', '^Remarketinga\(Mkt:RS', '^Loyalty\(', false, 'Pretpostavka: MSS = Loyalty ad setovi od 22.10. (plan kaže 30.-31.10.)'),
  ('2026-10-01', 'meta', 'MSS - Traffic',                      '2026-10-30', 'meta_ad_set', '^Collection\(Mkt:RS', '^Loyalty_traffic', false, 'Pretpostavka: MSS = Loyalty ad setovi od 22.10. (plan kaže 30.-31.10.)'),
  -- October: Google
  ('2026-10-01', 'google', 'Search Category + Brand',          '2026-10-01', 'campaign', '^(?!KIKO |Outlet ).*\(Mkt:RS;Ct:(Generic|Brand)_Search\)$', null, true, null),
  ('2026-10-01', 'google', 'Search KIKO Brand',                '2026-10-01', 'campaign', '^KIKO \(Mkt:RS;Ct:Generic_Search\)$', null, true, null),
  ('2026-10-01', 'google', 'Search Outlet',                    '2026-10-01', 'campaign', '^Outlet \(Mkt:RS;Ct:Brand_Search\)$', null, true, null),
  ('2026-10-01', 'google', 'KIKO Remarketing',                 '2026-10-01', 'campaign', '^KIKO \(Mkt:RS;Ct:Display;Ph:Bof\)$', null, true, null),
  ('2026-10-01', 'google', 'KIKO Prospecting',                 '2026-10-01', 'campaign', '^KIKO \(Mkt:RS;Ct:Display;Ph:Tof\)$', null, true, null),
  ('2026-10-01', 'google', 'Dynamic Display Remarketing',      '2026-10-01', 'campaign', '^AOn.*\(Mkt:RS;Ct:Display_Dyn;Ph:Bof\)$', null, true, null),
  ('2026-10-01', 'google', 'Dynamic Display Prospecting',      '2026-10-01', 'campaign', '^AOn \(Mkt:RS;Ct:Display_Dyn;Ph:Tof\)$', null, true, null),
  ('2026-10-01', 'google', 'Main campaign FW26 - Pmax',        '2026-10-01', 'campaign', '^AOn \(Mkt:RS;Ct:PMax\)$', null, true, null),
  ('2026-10-01', 'google', 'Main campaign FW26 - Deman Gen',   '2026-10-01', 'campaign', '^AOn \(Mkt:RS;Ct:DemandGen;Ph:Tof\)$', null, false, 'Ceo AOn Demand Gen (jedan ad group MAIN FW26 ceo mesec); MSS Demand Gen nema svoj ad group'),
  ('2026-10-01', 'google', '–20% FW - Pmax',                   '2026-10-02', 'asset_group', '^Short Sales \(Mkt:RS;Ct:PMax\)$', '^Vikend Akcija -20%', true, null),
  ('2026-10-01', 'google', '–20% FW - Pmax',                   '2026-10-08', 'asset_group', '^Short Sales \(Mkt:RS;Ct:PMax\)$', '^Akcija 08\.-11\.10\.', true, null),
  ('2026-10-01', 'google', 'MSS - Pmax',                       '2026-10-20', 'asset_group', '^Short Sales \(Mkt:RS;Ct:PMax\)$', '^Loyalty only', false, 'Pretpostavka: MSS = asset grupa "Loyalty only 22.-25.10."'),
  ('2026-10-01', 'google', 'App Install (Android)',            '2026-10-01', 'campaign', '\(Mkt:RS;Ct:App\)$', null, true, null)
) as v(month, network, label, plan_start, level, cp, sp, confirmed, note)
where c.name = 'Fashion&Friends RS'
on conflict do nothing;
