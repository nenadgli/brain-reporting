-- Report rows for the September 2026 check: Meta App Install (RS) by pattern after its rename, and Awareness and
-- Social boost rows for F&F RS and HR.
-- Meta App Install (RS): renamed in Ads Manager, matched by pattern from now on.
update public.fashion_rs_report_rows set campaign_pattern = 'app.?install'
where client_id = 'c710bfd0-5281-412b-a7d6-2a96c80b9b57' and channel = 'meta' and row_label = 'App Install';

-- Awareness and Social boost rows for F&F RS and HR.
insert into public.fashion_rs_report_rows (row_order, row_label, channel, level, campaign_names, campaign_pattern, note, client_id)
select v.row_order, v.row_label, 'meta', 'campaign', '{}'::text[], v.pattern, v.note, c.id
from clients c
cross join (values
  (19, 'Awareness', 'Ct:Awareness', 'Meta awareness kampanje (stalne i akcijske), po oznaci Ct:Awareness u imenu'),
  (20, 'Social boost', '^(LB_)?Social|Page.?Likes', 'Boost kampanje social tima, po imenu (Social…, Page Likes)')
) v(row_order, row_label, pattern, note)
where c.id in ('c710bfd0-5281-412b-a7d6-2a96c80b9b57', 'a25dd5fb-6f77-4d5a-9055-259d1ceeb213')
  and not exists (select 1 from fashion_rs_report_rows x where x.client_id = c.id and x.row_label = v.row_label and x.channel = 'meta');

