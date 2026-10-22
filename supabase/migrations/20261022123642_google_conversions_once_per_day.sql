-- Google purchases were written on every device row of a campaign and day (they come per campaign and day, the other
-- metrics per device), so every sum counted them two to four times (F&F RS, September 2026: 25,871 instead of 7,225).
-- All device rows of a campaign and day hold the same number (checked on all 25,712 campaign-days), so the history is
-- fixed exactly: the number stays on the device row with the most clicks, the others get 0, as google-ads-sync now writes it.
with ranked as (
  select id, row_number() over (partition by client_id, report_date, campaign order by clicks desc, device asc) as rn
  from google_ads_metrics
)
update google_ads_metrics g set conversions = 0
from ranked r
where r.id = g.id and r.rn > 1 and g.conversions <> 0;
