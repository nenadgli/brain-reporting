-- Slack reactions on an alarm: 👀 = someone took it, ✅ = solved, ❌ = false alarm. Brain reads them every hour,
-- stores who did what, and reminds in the thread when nobody took an alarm within reminder_hours.
alter table public.urgent_alerts
  add column if not exists slack_channel text,
  add column if not exists slack_ts text,
  add column if not exists taken_by text,
  add column if not exists taken_at timestamptz,
  add column if not exists resolved_by text,
  add column if not exists resolved_at timestamptz,
  add column if not exists false_alarm_by text,
  add column if not exists reminded_at timestamptz;