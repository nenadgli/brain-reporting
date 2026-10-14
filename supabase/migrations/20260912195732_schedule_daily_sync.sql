create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'daily-windsor-sync',
  '0 4 * * *',  -- 04:00 UTC = 06:00 Serbia time (CEST, UTC+2, currently in effect)
  $$
  select net.http_post(
    url := 'https://yryclxxuueupuruowjvn.supabase.co/functions/v1/daily-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyeWNseHh1dWV1cHVydW93anZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNDk0ODQsImV4cCI6MjEwNDcyNTQ4NH0.Gjlsk2Kv44Rys_hLVuoKq0d1bZIWft2RSMocTbqQwA8'
    ),
    body := jsonb_build_object('date_preset', 'last_14d'),
    timeout_milliseconds := 120000
  );
  $$
);