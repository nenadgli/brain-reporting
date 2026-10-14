-- Cron jobs that were created or changed outside migrations on 2026-10-14, recorded here so the
-- schedule is reproducible. cron.schedule with an existing job name updates that job (pg_cron >= 1.4).
-- The anon key is public; the morning-review internal key is read from integration_secrets at run time.

-- 04:00 UTC: fill sync_queue (replaces the single daily-sync call that hit the per-trace rate limit).
select cron.schedule('daily-windsor-sync', '0 4 * * *', $c$select public.enqueue_daily_sync('last_14d')$c$);

-- Every minute: send up to 15 queued sync jobs, each as its own request; failed jobs are retried once.
select cron.schedule('dispatch-sync-queue', '* * * * *', $c$select public.dispatch_sync_queue(15)$c$);

-- 05:00 UTC: morning review for every client with review_settings.
select cron.schedule('morning-review', '0 5 * * *', $c$
  select net.http_post(
    url := 'https://yryclxxuueupuruowjvn.supabase.co/functions/v1/morning-review',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyeWNseHh1dWV1cHVydW93anZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNDk0ODQsImV4cCI6MjEwNDcyNTQ4NH0.Gjlsk2Kv44Rys_hLVuoKq0d1bZIWft2RSMocTbqQwA8',
      'x-internal-key', (select value from public.integration_secrets where name = 'review_cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
$c$);