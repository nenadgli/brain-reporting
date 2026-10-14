alter table public.clients add column if not exists ga4_store text;

update public.clients set ga4_store = 'RS' where id = 'c710bfd0-5281-412b-a7d6-2a96c80b9b57';
update public.clients set ga4_store = 'AL' where id = '65a8d2e5-901a-4bb8-8a74-5fe45bc1db7a';
update public.clients set ga4_store = 'HR' where name = 'Fashion&Friends HR';

insert into public.data_sources (client_id, provider, windsor_connection_id, status)
select '65a8d2e5-901a-4bb8-8a74-5fe45bc1db7a', 'ga4', 'ga4__281614331', 'pending'
where not exists (
  select 1 from public.data_sources
  where client_id = '65a8d2e5-901a-4bb8-8a74-5fe45bc1db7a' and provider = 'ga4'
);