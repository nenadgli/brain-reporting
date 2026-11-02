-- MPL from Drive into media_plan_history too. Feed Hub's mpl-daily-check reads every market's "MPL & REPORT - <month>"
-- tabs at 07h and 17h (Belgrade) and calls brain_mpl_sync with every dated line; until now that only kept
-- media_plan_lines (pacing) current, while the MPL report reads media_plan_history. The same call now also keeps
-- media_plan_history current, by the same rule: new lines and changes are written, a line that is gone or fell to 0 is
-- only reported. The PPC team's reported results (reported_*) are never touched. Every change is logged.
create table if not exists public.media_plan_changes (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  month date not null,
  checked_at timestamptz not null default now(),
  target text not null,                 -- 'history'
  kind text not null,                   -- 'new' | 'updated' | 'question'
  campaign_label text,
  network text,
  old_value jsonb,
  new_value jsonb,
  message text not null,
  applied boolean not null
);
create index if not exists media_plan_changes_client_month on public.media_plan_changes (client_id, month, checked_at desc);
alter table public.media_plan_changes enable row level security;
create policy "scoped media_plan_changes access" on public.media_plan_changes for select using (client_id in (
  select c.id from clients c where c.agency_id = current_user_agency_id() and (current_user_client_id() is null or c.id = current_user_client_id())));

create or replace function public.brain_mpl_history_sync(p_client uuid, p_month date, p_lines jsonb, p_apply boolean)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  l jsonb; h media_plan_history%rowtype; v_seen uuid[] := '{}';
  v_net text; v_ast text; v_sec text; v_msg text; v_new int := 0; v_upd int := 0; v_ask jsonb := '[]'; v_out jsonb := '[]';
  fmt constant text := 'DD.MM.';
begin
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    v_net := case when l->>'network' ~* 'meta|facebook' then 'meta' when l->>'network' ~* 'google' then 'google'
                  when l->>'network' ~* 'tiktok' then 'tiktok' when l->>'network' ~* 'programmatic' then 'programmatic' end;
    if v_net is null then continue; end if;
    v_ast := case when v_net <> 'google' then null
                  when l->>'network' ~* 'pmax|performance' then 'PERFORMANCE_MAX' when l->>'network' ~* 'search' then 'SEARCH'
                  when l->>'network' ~* 'display' then 'DISPLAY' when l->>'network' ~* 'demand' then 'DEMAND_GEN'
                  when l->>'network' ~* 'app' then 'APP' when l->>'network' ~* 'youtube|video' then 'VIDEO' end;
    v_sec := case when l->>'type' ~* 'loyal' or l->>'name' ~* 'app ?install' then 'loyalty' else 'ecomm' end;
    h := null;
    select * into h from media_plan_history x
    where x.client_id = p_client and x.month = v_month and not (x.id = any (v_seen))
      and brain_mpl_norm(x.campaign_label) = brain_mpl_norm(l->>'name') and x.network = v_net
      and (v_net <> 'google' or x.ad_set_type is not distinct from v_ast or x.ad_set_type is null)
    order by (x.start_date = (l->>'start')::date and x.end_date = (l->>'end')::date) desc,
             abs(coalesce(x.start_date, v_month) - (l->>'start')::date), abs(coalesce(x.end_date, v_to) - (l->>'end')::date)
    limit 1;

    if h.id is null then
      if coalesce((l->>'total')::numeric, 0) <= 0 then continue; end if;
      v_new := v_new + 1;
      v_msg := format('nova stavka %s (%s) %s–%s: %s €', l->>'name', l->>'network',
                      to_char((l->>'start')::date, fmt), to_char((l->>'end')::date, fmt), round((l->>'total')::numeric));
      v_out := v_out || to_jsonb(v_msg);
      if p_apply then
        insert into media_plan_history (client_id, month, source_sheet, section, network, channel, flight_type, ad_set_type,
                                        campaign_label, start_date, end_date, budget_regular, budget_flash, budget_total)
        values (p_client, v_month, 'MPL & REPORT (Drive, dnevna provera)', v_sec, v_net, l->>'network', nullif(l->>'type', ''), v_ast,
                l->>'name', (l->>'start')::date, (l->>'end')::date,
                coalesce((l->>'regular')::numeric, 0), coalesce((l->>'flash')::numeric, 0), coalesce((l->>'total')::numeric, 0))
        returning id into h.id;
        v_seen := v_seen || h.id;
        insert into media_plan_changes (client_id, month, target, kind, campaign_label, network, new_value, message, applied)
        values (p_client, v_month, 'history', 'new', l->>'name', v_net, l, v_msg, true);
      end if;
      continue;
    end if;

    v_seen := v_seen || h.id;
    if coalesce(h.budget_total, 0) > 0 and coalesce((l->>'total')::numeric, 0) <= 0 then
      v_msg := format('%s (%s): u tabeli 0 €, u Brainu %s €. Nije menjano.', h.campaign_label, l->>'network', round(h.budget_total));
      v_ask := v_ask || to_jsonb(v_msg);
      if p_apply then
        insert into media_plan_changes (client_id, month, target, kind, campaign_label, network, old_value, new_value, message, applied)
        values (p_client, v_month, 'history', 'question', h.campaign_label, v_net, to_jsonb(h) - 'raw', l, v_msg, false);
      end if;
      continue;
    end if;
    if h.start_date is distinct from (l->>'start')::date or h.end_date is distinct from (l->>'end')::date
       or round(coalesce(h.budget_total, 0)) <> round((l->>'total')::numeric)
       or round(coalesce(h.budget_flash, 0)) <> round(coalesce((l->>'flash')::numeric, 0)) then
      v_upd := v_upd + 1;
      v_msg := format('%s (%s): %s', h.campaign_label, l->>'network', coalesce(nullif(concat_ws(', ',
                 case when round(coalesce(h.budget_total, 0)) <> round((l->>'total')::numeric)
                      then round(coalesce(h.budget_total, 0)) || ' → ' || round((l->>'total')::numeric) || ' €' end,
                 case when h.start_date is distinct from (l->>'start')::date or h.end_date is distinct from (l->>'end')::date
                      then to_char(h.start_date, fmt) || '–' || to_char(h.end_date, fmt) || ' → ' || to_char((l->>'start')::date, fmt) || '–' || to_char((l->>'end')::date, fmt) end), ''),
                 'regular/flash podela'));
      v_out := v_out || to_jsonb(v_msg);
      if p_apply then
        insert into media_plan_changes (client_id, month, target, kind, campaign_label, network, old_value, new_value, message, applied)
        values (p_client, v_month, 'history', 'updated', h.campaign_label, v_net,
                jsonb_build_object('start', h.start_date, 'end', h.end_date, 'regular', h.budget_regular, 'flash', h.budget_flash, 'total', h.budget_total),
                l, v_msg, true);
        update media_plan_history set start_date = (l->>'start')::date, end_date = (l->>'end')::date,
               flight_type = coalesce(nullif(l->>'type', ''), flight_type),
               budget_regular = coalesce((l->>'regular')::numeric, 0), budget_flash = coalesce((l->>'flash')::numeric, 0),
               budget_total = coalesce((l->>'total')::numeric, 0)
        where id = h.id;
      end if;
    end if;
  end loop;

  for h in select * from media_plan_history x
           where x.client_id = p_client and x.month = v_month and not (x.id = any (v_seen)) and coalesce(x.budget_total, 0) > 0 loop
    v_msg := format('%s (%s, %s–%s): %s € u Brainu, nema u tabeli. Nije menjano.', h.campaign_label, h.network,
                    to_char(h.start_date, fmt), to_char(h.end_date, fmt), round(h.budget_total));
    v_ask := v_ask || to_jsonb(v_msg);
    if p_apply and not exists (select 1 from media_plan_changes c where c.client_id = p_client and c.month = v_month and c.kind = 'question'
                                 and c.message = v_msg and c.checked_at > now() - interval '1 day') then
      insert into media_plan_changes (client_id, month, target, kind, campaign_label, network, message, applied)
      values (p_client, v_month, 'history', 'question', h.campaign_label, h.network, v_msg, false);
    end if;
  end loop;

  return jsonb_build_object('new', v_new, 'updated', v_upd, 'questions', v_ask, 'changes', v_out);
end $function$;
revoke all on function public.brain_mpl_history_sync(uuid, date, jsonb, boolean) from public, anon, authenticated;

-- brain_mpl_sync: unchanged for media_plan_lines; at the end it also syncs media_plan_history (an error there is
-- returned in "history", it does not undo the media_plan_lines sync).
create or replace function public.brain_mpl_sync(p_key text, p_market text, p_month date, p_lines jsonb, p_apply boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_client uuid; v_month date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  l jsonb; c media_plan_lines%rowtype; v_seen uuid[] := '{}';
  v_net text; v_ast text; v_out jsonb := '[]'; v_ask jsonb := '[]'; v_new int := 0; v_upd int := 0; v_hist jsonb;
  fmt constant text := 'DD.MM.';
begin
  if p_key is null or p_key is distinct from (select decrypted_secret from vault.decrypted_secrets where name = 'brain_sync_key') then
    raise exception 'invalid key';
  end if;
  select id into v_client from clients where name = 'Fashion&Friends ' || upper(p_market);
  if v_client is null then raise exception 'nema klijenta Fashion&Friends %', p_market; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    v_net := case when l->>'network' ~* 'meta|facebook' then 'meta' when l->>'network' ~* 'google' then 'google'
                  when l->>'network' ~* 'tiktok' then 'tiktok' when l->>'network' ~* 'programmatic' then 'programmatic'
                  end;
    if v_net is null then continue; end if;
    v_ast := case when v_net <> 'google' then null
                  when l->>'network' ~* 'pmax|performance' then 'PERFORMANCE_MAX' when l->>'network' ~* 'search' then 'SEARCH'
                  when l->>'network' ~* 'display' then 'DISPLAY' when l->>'network' ~* 'demand' then 'DEMAND_GEN'
                  when l->>'network' ~* 'app' then 'APP' when l->>'network' ~* 'youtube|video' then 'VIDEO' end;
    c := null;
    select * into c from media_plan_lines x
    where x.client_id = v_client and x.month = v_month and not (x.id = any (v_seen))
      and brain_mpl_norm(x.campaign_label) = brain_mpl_norm(l->>'name') and x.network = v_net and x.ad_set_type is not distinct from v_ast
    order by (x.start_date = (l->>'start')::date and x.end_date = (l->>'end')::date) desc,
             abs(coalesce(x.start_date, v_month) - (l->>'start')::date), abs(coalesce(x.end_date, v_to) - (l->>'end')::date)
    limit 1;

    if c.id is null then
      if coalesce((l->>'total')::numeric, 0) <= 0 then continue; end if;
      v_new := v_new + 1;
      v_out := v_out || to_jsonb(format('nova stavka %s (%s) %s–%s: %s €', l->>'name', l->>'network',
                to_char((l->>'start')::date, fmt), to_char((l->>'end')::date, fmt), round((l->>'total')::numeric)));
      if p_apply then
        insert into media_plan_lines (client_id, month, network, flight_type, ad_set_type, campaign_label, start_date, end_date,
                                      budget_regular, budget_flash, budget_total)
        values (v_client, v_month, v_net, nullif(l->>'type', ''), v_ast, l->>'name', (l->>'start')::date, (l->>'end')::date,
                (l->>'regular')::numeric, (l->>'flash')::numeric, (l->>'total')::numeric)
        returning id into c.id;
        v_seen := v_seen || c.id;
      end if;
      continue;
    end if;

    v_seen := v_seen || c.id;
    if coalesce(c.budget_total, 0) > 0 and coalesce((l->>'total')::numeric, 0) <= 0 then
      v_ask := v_ask || to_jsonb(format('%s (%s): u tabeli 0 €, u Brainu %s €. Nije menjano.', c.campaign_label, l->>'network', round(c.budget_total)));
      continue;
    end if;
    if c.start_date is distinct from (l->>'start')::date or c.end_date is distinct from (l->>'end')::date
       or round(coalesce(c.budget_total, 0)) <> round((l->>'total')::numeric)
       or round(coalesce(c.budget_flash, 0)) <> round(coalesce((l->>'flash')::numeric, 0)) then
      v_upd := v_upd + 1;
      v_out := v_out || to_jsonb(format('%s (%s): %s', c.campaign_label, l->>'network', coalesce(nullif(concat_ws(', ',
                 case when round(coalesce(c.budget_total, 0)) <> round((l->>'total')::numeric)
                      then round(coalesce(c.budget_total, 0)) || ' → ' || round((l->>'total')::numeric) || ' €' end,
                 case when c.start_date is distinct from (l->>'start')::date or c.end_date is distinct from (l->>'end')::date
                      then to_char(c.start_date, fmt) || '–' || to_char(c.end_date, fmt) || ' → ' || to_char((l->>'start')::date, fmt) || '–' || to_char((l->>'end')::date, fmt) end), ''),
                 'regular/flash podela')));
      if p_apply then
        update media_plan_lines set start_date = (l->>'start')::date, end_date = (l->>'end')::date,
               flight_type = coalesce(nullif(l->>'type', ''), flight_type),
               budget_regular = (l->>'regular')::numeric, budget_flash = (l->>'flash')::numeric, budget_total = (l->>'total')::numeric
        where id = c.id;
      end if;
    end if;
  end loop;

  for c in select * from media_plan_lines x
           where x.client_id = v_client and x.month = v_month and not (x.id = any (v_seen)) and coalesce(x.budget_total, 0) > 0 loop
    v_ask := v_ask || to_jsonb(format('%s (%s, %s–%s): %s € u Brainu, nema u tabeli. Nije menjano.', c.campaign_label, c.network,
                                      to_char(c.start_date, fmt), to_char(c.end_date, fmt), round(c.budget_total)));
  end loop;

  begin
    v_hist := brain_mpl_history_sync(v_client, v_month, p_lines, p_apply);
  exception when others then
    v_hist := jsonb_build_object('error', sqlerrm);
  end;

  return jsonb_build_object('client', v_client, 'new', v_new, 'updated', v_upd, 'questions', v_ask, 'changes', v_out, 'history', v_hist);
end $function$;
