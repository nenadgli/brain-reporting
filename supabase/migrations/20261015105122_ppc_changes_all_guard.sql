-- ppc_generate_changes_all() is for the nightly cron only: an API caller other than the service role
-- is refused (it would otherwise let anyone with the public key build proposals for every client).
create or replace function public.ppc_generate_changes_all()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
    raise exception 'ppc_generate_changes_all: not allowed';
  end if;
  for r in select client_id from review_settings where enabled loop
    begin
      n := n + ppc_generate_changes(r.client_id);
    exception when others then
      raise warning 'ppc_generate_changes % failed: %', r.client_id, sqlerrm;
    end;
  end loop;
  return n;
end $$;
