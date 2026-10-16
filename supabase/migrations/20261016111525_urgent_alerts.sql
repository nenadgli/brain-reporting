-- Urgent PPC alarms during the day, sent to Slack (#ppc-alarmi) by the urgent-alerts function. Each alarm is
-- stored once per client, day, kind and key, so it goes to Slack at most once a day.
create table if not exists public.urgent_alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  alert_date date not null,
  kind text not null,
  key text not null,
  text text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  unique (client_id, alert_date, kind, key)
);
alter table public.urgent_alerts enable row level security;
create policy "agency urgent alerts read" on public.urgent_alerts for select using (
  client_id in (select id from clients where agency_id = current_user_agency_id() and current_user_client_id() is null));

-- Usual purchases per day over the last 28 days, per network (the morning review's daily tables).
create or replace function public.daily_purchases_baseline(p_client_id uuid)
returns table (network text, per_day numeric)
language sql stable set search_path = public as $$
  select 'google', coalesce(sum(g.conversions), 0) / 28 from google_ads_metrics g
  where g.client_id = p_client_id and g.report_date > current_date - 29 and g.report_date < current_date
  union all
  select 'meta', coalesce(sum(f.conversions), 0) / 28 from facebook_ads_metrics f
  where f.client_id = p_client_id and f.report_date > current_date - 29 and f.report_date < current_date
$$;

-- Fashion&Friends RS: alarms to #ppc-alarmi with @channel, as the PPC team asked.
update public.review_settings set params = params || jsonb_build_object('alerts', jsonb_build_object(
  'channel', 'ppc-alarmi', 'mention_channel', true, 'no_conv_hours', jsonb_build_array(12, 16),
  'no_conv_min_spend', 30, 'min_baseline', 10, 'overspend_ratio', 1.5))
where client_id = (select id from public.clients where name = 'Fashion&Friends RS');

-- Every hour at :05, 07:05-23:05 Belgrade summer time (the function works in Belgrade time itself).
select cron.schedule('urgent-alerts', '5 5-21 * * *', $$
  select net.http_post(
    url := 'https://yryclxxuueupuruowjvn.supabase.co/functions/v1/urgent-alerts',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-internal-key', (select value from public.integration_secrets where name = 'review_cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
$$);
