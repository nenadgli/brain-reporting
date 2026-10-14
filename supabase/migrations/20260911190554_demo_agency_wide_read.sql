-- TEMPORARY (same caveat as earlier demo policies): agency-wide anon read,
-- needed for the cross-client agency report view. Replace with real auth-scoped
-- policies once login is wired up.
create policy "demo anon read clients whole agency" on clients for select to anon
  using (agency_id = '00000000-0000-0000-0000-000000000001');

create policy "demo anon read report_metrics whole agency" on report_metrics for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));

create policy "demo anon read data_sources whole agency" on data_sources for select to anon
  using (client_id in (select id from clients where agency_id = '00000000-0000-0000-0000-000000000001'));
