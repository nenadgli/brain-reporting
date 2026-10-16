-- Urgent Slack alarms (#ppc-alarm) for the other Fashion&Friends markets too, with the same thresholds as RS.
-- AL sells less (~8 Meta purchases a day), so its no-purchase alarm needs 6 a day and only runs at 16h,
-- when a day with none means something is broken. SI (~1 a day) stays below the threshold: landing/overspend only.
update public.review_settings rs set params = coalesce(rs.params, '{}'::jsonb) || jsonb_build_object('alerts', jsonb_build_object(
  'channel', 'ppc-alarm', 'mention_channel', true, 'no_conv_hours', case when c.name = 'Fashion&Friends AL' then '[16]'::jsonb else '[12,16]'::jsonb end,
  'no_conv_min_spend', 30, 'min_baseline', case when c.name = 'Fashion&Friends AL' then 6 else 10 end, 'overspend_ratio', 1.5))
from public.clients c
where c.id = rs.client_id and c.name in ('Fashion&Friends HR', 'Fashion&Friends ME', 'Fashion&Friends BA', 'Fashion&Friends AL', 'Fashion&Friends SI');