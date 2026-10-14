-- Allow authenticated agency users to upload/replace media plan data for clients they can access.
create policy "scoped media_plan_lines insert" on media_plan_lines for insert to authenticated
  with check (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));

create policy "scoped media_plan_lines delete" on media_plan_lines for delete to authenticated
  using (client_id in (select id from clients where agency_id = current_user_agency_id() and (current_user_client_id() is null or id = current_user_client_id())));
