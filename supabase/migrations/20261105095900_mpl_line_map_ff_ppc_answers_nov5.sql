-- PPC answers (5.11.): HR Main_DPA_FW26 is not part of Main Remarketing; a Main traffic ad set without its own line
-- goes to the Main line active that month (AL, ME, SI: Main FW26 Conversion).
update public.media_plan_line_map m set campaign_pattern = '^RH_Remarketing_?\(Mkt:HR', sub_pattern = '^Main_FW26\(', confirmed = true, note = null
  from clients c where c.id = m.client_id and c.name = 'Fashion&Friends HR' and m.month = '2026-10-01' and m.campaign_label = 'Main campaign - Remarketing';
update public.media_plan_line_map m
   set campaign_pattern = '^(ADV_Akcije_?|Main_FW26|Collection_?)\(Mkt:' || case c.name when 'Fashion&Friends SI' then '(SI|SLO)' else replace(c.name, 'Fashion&Friends ', '') end,
       sub_pattern = '^Main_?FW26', confirmed = true, note = 'Uključen i Main traffic ad set (1.10.), po PPC pravilu: na aktivnu Main liniju'
  from clients c where c.id = m.client_id and c.name in ('Fashion&Friends AL', 'Fashion&Friends ME', 'Fashion&Friends SI')
   and m.month = '2026-10-01' and m.campaign_label = 'Main campaign FW26 - Conversion';
