-- RTB House (Programmatic) daily cost, impressions and clicks per F&F market and line (Retargeting / Traffic), from the
-- "F&F - RTB Daily Cost" sheet (tabs "F&F - <MKT> - <Line>"). The sheet is filled daily; Feed Hub mpl-daily-check reads it
-- at 07h/17h and calls brain_rtb_sync, the same way it calls brain_mpl_sync. Replaces the manual Programmatic spend input.
create table if not exists public.programmatic_daily_metrics (
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null default 'rtbhouse',
  line text not null,
  report_date date not null,
  spend numeric,
  impressions numeric,
  clicks numeric,
  source_tab text,
  synced_at timestamptz not null default now(),
  primary key (client_id, platform, line, report_date)
);
alter table public.programmatic_daily_metrics enable row level security;
create policy "visible clients read" on public.programmatic_daily_metrics for select using (client_id in (select id from clients));

-- p_rows: [{tab, day, cost, impressions, clicks}]; the market and line come from the tab name. A day is overwritten
-- with the sheet's figures (the sheet is the source); days not in the call are left as they are. A day listed twice
-- in a tab counts once (the lower row).
create or replace function public.brain_rtb_sync(p_key text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_n int := 0; v_skip jsonb := '[]';
begin
  if p_key is null or p_key is distinct from (select decrypted_secret from vault.decrypted_secrets where name = 'brain_sync_key') then
    raise exception 'invalid key';
  end if;
  with r as (
    select x->>'tab' tab, upper(substring(x->>'tab' from '-\s*([A-Za-z]{2})\s*-')) mkt, btrim(substring(x->>'tab' from '-\s*[A-Za-z]{2}\s*-\s*(.+)$')) line,
           (x->>'day')::date d, nullif(x->>'cost', '')::numeric cost, nullif(x->>'impressions', '')::numeric impr, nullif(x->>'clicks', '')::numeric clicks
    , n from jsonb_array_elements(coalesce(p_rows, '[]')) with ordinality t(x, n) where x->>'day' ~ '^\d{4}-\d{2}-\d{2}$'
  ), r1 as (  -- a day listed twice in a tab (seen once, identical rows): the lower row counts
    select distinct on (mkt, line, d) * from r order by mkt, line, d, n desc
  ), ins as (
    insert into programmatic_daily_metrics (client_id, line, report_date, spend, impressions, clicks, source_tab, synced_at)
    select c.id, r.line, r.d, r.cost, r.impr, r.clicks, r.tab, now() from r1 r join clients c on c.name = 'Fashion&Friends ' || r.mkt
    on conflict (client_id, platform, line, report_date) do update
      set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks, source_tab = excluded.source_tab, synced_at = now()
    returning 1
  )
  select count(*) into v_n from ins;
  select coalesce(jsonb_agg(distinct x->>'tab'), '[]') into v_skip from jsonb_array_elements(coalesce(p_rows, '[]')) x
  where not exists (select 1 from clients c where c.name = 'Fashion&Friends ' || upper(substring(x->>'tab' from '-\s*([A-Za-z]{2})\s*-')));
  return jsonb_build_object('rows', v_n, 'unknown_tabs', v_skip);
end $function$;
revoke all on function public.brain_rtb_sync(text, jsonb) from public;
grant execute on function public.brain_rtb_sync(text, jsonb) to anon, authenticated;
