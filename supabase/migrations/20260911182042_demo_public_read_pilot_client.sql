-- TEMPORARY: public read access scoped to the pilot demo client only, for prototype purposes.
-- Must be dropped once real auth (app_users + login) is wired up.
create policy "demo anon read clients" on clients for select to anon
  using (id = '00000000-0000-0000-0000-000000000002');

create policy "demo anon read data_sources" on data_sources for select to anon
  using (client_id = '00000000-0000-0000-0000-000000000002');

create policy "demo anon read report_metrics" on report_metrics for select to anon
  using (client_id = '00000000-0000-0000-0000-000000000002');
