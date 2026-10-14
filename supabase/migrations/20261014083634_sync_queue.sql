-- daily-sync fanned out ~200 function calls from one invocation and hit Supabase's per-trace
-- rate limit (173 of 203 failed on 2026-10-14). Jobs now go into a queue and are dispatched
-- from the database a few at a time, each as its own request.
create table if not exists public.sync_queue (
  id bigserial primary key,
  run_date date not null default current_date,
  fn text not null,
  body jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'done', 'failed')),
  attempts int not null default 0,
  request_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz
);
create index if not exists sync_queue_status_idx on public.sync_queue(status, id);
alter table public.sync_queue enable row level security;

create or replace function public.enqueue_daily_sync(p_preset text default 'last_14d')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sync_queue (fn, body)
  select j.fn, j.body from (
    select distinct on (c.client_id, f.fn) f.fn,
           case when f.fn = 'windsor-sync' then jsonb_build_object('client_id', c.client_id, 'date_preset', 'last_7d')
                when f.fn = 'ga4-sync' then jsonb_build_object('client_id', c.client_id, 'date_preset', p_preset, 'store', cl.ga4_store)
                else jsonb_build_object('client_id', c.client_id, 'date_preset', p_preset) end as body,
           c.client_id, f.ord
    from (select distinct client_id, provider from data_sources) c
    join clients cl on cl.id = c.client_id
    join (values
      ('windsor-sync', null, 0),
      ('google-ads-sync', 'google_ads', 1), ('google-ads-keywords-sync', 'google_ads', 2),
      ('google-ads-search-terms-sync', 'google_ads', 3), ('google-ads-competitors-sync', 'google_ads', 4),
      ('google-granular-sync', 'google_ads', 5),
      ('facebook-ads-sync', 'facebook', 1), ('facebook-ads-placements-sync', 'facebook', 2),
      ('facebook-ads-creatives-sync', 'facebook', 3), ('meta-adset-sync', 'facebook', 4),
      ('ga4-sync', 'ga4', 6)
    ) as f(fn, provider, ord) on (f.provider is null or f.provider = c.provider)
    where f.fn <> 'ga4-sync' or cl.ga4_store is not null
    order by c.client_id, f.fn
  ) j
  order by j.ord, j.client_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.dispatch_sync_queue(p_batch int default 15)
returns int language plpgsql security definer set search_path = public as $$
declare
  j record;
  n int := 0;
  anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyeWNseHh1dWV1cHVydW93anZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNDk0ODQsImV4cCI6MjEwNDcyNTQ4NH0.Gjlsk2Kv44Rys_hLVuoKq0d1bZIWft2RSMocTbqQwA8';
begin
  -- Settle jobs whose response has arrived; a failed one goes back to the queue once.
  update sync_queue q
     set status = case when r.status_code between 200 and 299 then 'done'
                       when q.attempts < 2 then 'pending' else 'failed' end,
         last_error = case when r.status_code between 200 and 299 then null
                           else coalesce(r.error_msg, 'HTTP ' || r.status_code || ': ' || left(r.content, 200)) end
    from net._http_response r
   where q.status = 'dispatched' and r.id = q.request_id;
  -- A response pg_net never recorded within 10 minutes counts as a failed attempt.
  update sync_queue set status = case when attempts < 2 then 'pending' else 'failed' end, last_error = 'no response'
   where status = 'dispatched' and dispatched_at < now() - interval '10 minutes'
     and not exists (select 1 from net._http_response r where r.id = sync_queue.request_id);

  for j in select * from sync_queue where status = 'pending' order by id limit p_batch for update skip locked loop
    update sync_queue set status = 'dispatched', attempts = attempts + 1, dispatched_at = now(),
           request_id = net.http_post(
             url := 'https://yryclxxuueupuruowjvn.supabase.co/functions/v1/' || j.fn,
             headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || anon),
             body := j.body,
             timeout_milliseconds := 150000)
     where id = j.id;
    n := n + 1;
  end loop;
  return n;
end $$;