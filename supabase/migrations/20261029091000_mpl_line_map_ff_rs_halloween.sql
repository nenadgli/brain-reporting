-- F&F RS, October 2026 (PPC answers, 29.10.): Halloween ad sets / ad groups / asset groups carry "Halloween" in the name;
-- the Main FW26 lines run to the end of the month, so the whole AOn Demand Gen (minus group lines) is the Main DG line.
insert into public.media_plan_line_map (client_id, month, network, campaign_label, plan_start, level, campaign_pattern, sub_pattern, confirmed, note)
select c.id, '2026-10-01'::date, v.network, v.label, '2026-10-30'::date, v.level, v.cp, v.sp, true, null
from clients c cross join (values
  ('meta',   'Halloween - Conversion',  'meta_ad_set',     '^ADV_Akcije_?\(Mkt:RS',          '[Hh][ae]llow[e]?en'),
  ('meta',   'Halloween - Remarketing', 'meta_ad_set',     '^Remarketinga\(Mkt:RS',          '[Hh][ae]llow[e]?en'),
  ('meta',   'Halloween - Traffic',     'meta_ad_set',     '^Collection\(Mkt:RS',            '[Hh][ae]llow[e]?en'),
  ('meta',   'Halloween awareness',     'meta_ad_set',     'Mkt:RS;Ct:Awareness',            '[Hh][ae]llow[e]?en'),
  ('google', 'Helloween - Pmax',        'asset_group',     '\(Mkt:RS;Ct:PMax\)$',            '[Hh][ae]llow[e]?en'),
  ('google', 'Helloween - Deman Gen',   'google_ad_group', '\(Mkt:RS;Ct:DemandGen',          '[Hh][ae]llow[e]?en')
) as v(network, label, level, cp, sp)
where c.name = 'Fashion&Friends RS'
on conflict do nothing;

update public.media_plan_line_map m set confirmed = true, note = 'AOn Demand Gen ceo mesec, bez ad grupa drugih linija (Halloween)'
from clients c
where c.id = m.client_id and c.name = 'Fashion&Friends RS' and m.month = '2026-10-01' and m.campaign_label = 'Main campaign FW26 - Deman Gen';
