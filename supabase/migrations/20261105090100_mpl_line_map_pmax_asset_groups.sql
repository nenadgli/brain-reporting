-- PPC answers (5.11.): PMax lines are read by asset group, not by campaign; Meta ADV by ad set (naming is right).
-- Main FW26 PMax = asset groups "Main…" in any PMax campaign of the market; the Meta Main assumptions are confirmed.
update public.media_plan_line_map m
   set level = 'asset_group',
       campaign_pattern = '\(Mkt:' || case c.name when 'Fashion&Friends BA' then '(BA|BiH)' when 'Fashion&Friends SI' then '(SI|SLO)'
                                           else replace(c.name, 'Fashion&Friends ', '') end || ';Ct:PMax\)$',
       sub_pattern = '^[Mm][Aa][Ii][Nn]', confirmed = true, note = null
  from clients c
 where c.id = m.client_id and c.name ~ '^Fashion&Friends ' and m.month = '2026-10-01' and m.network = 'google'
   and m.campaign_label in ('Main campaign FW26 - Pmax', 'Main - PMax');

update public.media_plan_line_map m set confirmed = true, note = null
  from clients c
 where c.id = m.client_id and c.name ~ '^Fashion&Friends ' and m.month = '2026-10-01'
   and (m.note like 'Pretpostavka: ad set Main_FW26%' or m.note like 'Pretpostavka: RH_Remarketing%');
