-- F&F RS, October 2026, lines as in the final MPL (daily Drive check, 2.11.): the MSS lines became "loyalty akcija"
-- (22.–25.10.), Google "Helloween" became "Halloween", and Halloween got separate Add to cart / ATC lines.
insert into public.media_plan_line_map (client_id, month, network, campaign_label, plan_start, level, campaign_pattern, sub_pattern, confirmed, note)
select c.id, '2026-10-01'::date, v.network, v.label, v.plan_start::date, v.level, v.cp, v.sp, true, null
from clients c cross join (values
  ('meta',   'loyalty akcija - Conversion',  '2026-10-22', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS',  '^Loyalty_?\('),
  ('meta',   'loyalty akcija - Traffic',     '2026-10-22', 'meta_ad_set', '^Collection\(Mkt:RS',    '^Loyalty_traffic'),
  ('meta',   'loyalty akcija- Remarketing',  '2026-10-22', 'meta_ad_set', '^Remarketinga\(Mkt:RS',  '^Loyalty\('),
  ('meta',   'Halloween - Add to cart',      '2026-10-29', 'meta_ad_set', '^ADV_Akcije_?\(Mkt:RS',  '[Hh]alloween.*ATC'),
  ('google', 'Loyalty - Pmax',               '2026-10-22', 'asset_group', '^Short Sales \(Mkt:RS;Ct:PMax\)$', '^Loyalty only'),
  ('google', 'Halloween - Pmax',             '2026-10-30', 'asset_group', '\(Mkt:RS;Ct:PMax\)$',     '^[Hh]alloween(?!.*ATC)'),
  ('google', 'Halloween ATC - Pmax',         '2026-10-29', 'asset_group', '\(Mkt:RS;Ct:PMax\)$',     '[Hh]alloween.*ATC'),
  ('google', 'Halloween - Deman Gen',        '2026-10-30', 'google_ad_group', '\(Mkt:RS;Ct:DemandGen', '[Hh][ae]llow[e]?en')
) as v(network, label, plan_start, level, cp, sp)
where c.name = 'Fashion&Friends RS'
on conflict do nothing;

-- Halloween - Conversion no longer takes the ATC ad set (it has its own line now).
update public.media_plan_line_map m set sub_pattern = '^[Hh]alloween_?26(?!.*ATC)'
from clients c
where c.id = m.client_id and c.name = 'Fashion&Friends RS' and m.month = '2026-10-01' and m.network = 'meta'
  and m.campaign_label = 'Halloween - Conversion';
