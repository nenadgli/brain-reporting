-- Search terms are queued in 2-day windows (big accounts return ~24k rows a day), the rest as before.
create or replace function public.enqueue_daily_sync(p_preset text default 'last_14d')
returns int language plpgsql security definer set search_path = public as $$
declare
  n int;
  days int := coalesce(substring(p_preset from '^last_(\d+)d$')::int, 14);
begin
  insert into sync_queue (fn, body)
  select j.fn, j.body from (
    select f.fn,
           case when f.fn = 'windsor-sync' then jsonb_build_object('client_id', c.client_id, 'date_preset', 'last_7d')
                when f.fn = 'ga4-sync' then jsonb_build_object('client_id', c.client_id, 'date_preset', p_preset, 'store', cl.ga4_store)
                else jsonb_build_object('client_id', c.client_id, 'date_preset', p_preset) end as body,
           c.client_id, f.ord
    from (select distinct client_id, provider from data_sources) c
    join clients cl on cl.id = c.client_id
    join (values
      ('windsor-sync', null, 0),
      ('google-ads-sync', 'google_ads', 1), ('google-ads-keywords-sync', 'google_ads', 2),
      ('google-ads-competitors-sync', 'google_ads', 4), ('google-granular-sync', 'google_ads', 5),
      ('facebook-ads-sync', 'facebook', 1), ('facebook-ads-placements-sync', 'facebook', 2),
      ('facebook-ads-creatives-sync', 'facebook', 3), ('meta-adset-sync', 'facebook', 4),
      ('ga4-sync', 'ga4', 6)
    ) as f(fn, provider, ord) on (f.provider is null or f.provider = c.provider)
    where (f.fn <> 'ga4-sync' or cl.ga4_store is not null)
      and (f.provider is not null or c.provider = (select min(d.provider) from data_sources d where d.client_id = c.client_id))
    union all
    select 'google-ads-search-terms-sync',
           jsonb_build_object('client_id', c.client_id,
                              'date_from', to_char(current_date - w.start_back, 'YYYY-MM-DD'),
                              'date_to', to_char(current_date - greatest(w.start_back - 1, 0), 'YYYY-MM-DD')),
           c.client_id, 3
    from (select distinct client_id from data_sources where provider = 'google_ads') c
    cross join (select g as start_back from generate_series(1, days + 1, 2) g) w
  ) j
  order by j.ord, j.client_id, j.body->>'date_from' desc nulls first;
  get diagnostics n = row_count;
  return n;
end $$;