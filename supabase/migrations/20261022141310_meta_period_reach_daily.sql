-- Meta period reach, every morning: the current month to yesterday for every Meta account, and in the first five days of a
-- month also the whole previous month (late attribution and corrections still move it then).
create or replace function public.enqueue_meta_period_reach()
returns int language plpgsql security definer set search_path = public as $function$
declare n int; m0 date := date_trunc('month', current_date - 1)::date;
begin
  insert into sync_queue (fn, body)
  select 'facebook-ads-sync', jsonb_build_object('client_id', ds.client_id, 'period_reach', true, 'date_from', p.f::text, 'date_to', p.t::text)
  from (select distinct client_id from data_sources where provider = 'facebook' and windsor_connection_id is not null) ds
  cross join (
    select m0 as f, current_date - 1 as t
    union all
    select (m0 - interval '1 month')::date, m0 - 1 where extract(day from current_date) <= 5
  ) p;
  get diagnostics n = row_count;
  return n;
end $function$;

select cron.schedule('meta-period-reach', '20 4 * * *', 'select public.enqueue_meta_period_reach()');
