-- Google Ads unique users for a whole period (normally a month); filled by google-ads-sync with body.period_reach.
create table if not exists public.google_period_reach (
  client_id uuid not null references public.clients(id) on delete cascade,
  data_source_id uuid not null references public.data_sources(id) on delete cascade,
  campaign text not null,
  date_from date not null,
  date_to date not null,
  unique_users numeric,
  impressions numeric,
  synced_at timestamptz not null default now(),
  primary key (data_source_id, campaign, date_from, date_to)
);
alter table public.google_period_reach enable row level security;
create policy "visible clients read" on public.google_period_reach for select using (client_id in (select id from clients));

-- Every morning, like Meta: the current month to yesterday, and in the first five days also the whole previous month.
create or replace function public.enqueue_google_period_reach()
returns int language plpgsql security definer set search_path = public as $function$
declare n int; m0 date := date_trunc('month', current_date - 1)::date;
begin
  insert into sync_queue (fn, body)
  select 'google-ads-sync', jsonb_build_object('client_id', ds.client_id, 'period_reach', true, 'date_from', p.f::text, 'date_to', p.t::text)
  from (select distinct client_id from data_sources where provider = 'google_ads' and windsor_connection_id is not null) ds
  cross join (
    select m0 as f, current_date - 1 as t
    union all
    select (m0 - interval '1 month')::date, m0 - 1 where extract(day from current_date) <= 5
  ) p;
  get diagnostics n = row_count;
  return n;
end $function$;

select cron.schedule('google-period-reach', '25 4 * * *', 'select public.enqueue_google_period_reach()');
