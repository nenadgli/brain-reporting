alter table report_metrics add column campaign text;

insert into clients (id, agency_id, name, slug) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Planika BA', 'planika-ba');

insert into data_sources (client_id, provider, windsor_connection_id, status) values
  ('00000000-0000-0000-0000-000000000003', 'facebook', 'facebook__2263934350789326', 'active');

-- demo read access for this real client too (same temporary caveat as before)
create policy "demo anon read clients planika" on clients for select to anon
  using (id = '00000000-0000-0000-0000-000000000003');
create policy "demo anon read data_sources planika" on data_sources for select to anon
  using (client_id = '00000000-0000-0000-0000-000000000003');
create policy "demo anon read report_metrics planika" on report_metrics for select to anon
  using (client_id = '00000000-0000-0000-0000-000000000003');
