-- media_plan_history follows the MPL fully: a line that is no longer in the sheet is marked removed (removed_at, kept
-- with its reported results) and a line set to 0 gets 0; a removed line that comes back is restored. Guard: nothing is
-- removed or zeroed when the sheet gave fewer than half as many lines as the plan has. The MPL report skips removed lines.
alter table public.media_plan_history add column if not exists removed_at timestamptz;

create or replace function public.brain_mpl_history_sync(p_client uuid, p_month date, p_lines jsonb, p_apply boolean)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  l jsonb; h media_plan_history%rowtype; v_seen uuid[] := '{}';
  v_net text; v_ast text; v_sec text; v_msg text; v_apply_removals boolean; v_new int := 0; v_upd int := 0; v_rem int := 0; v_ask jsonb := '[]'; v_out jsonb := '[]';
  fmt constant text := 'DD.MM.';
begin
  -- A sheet that came back nearly empty (a parse problem, a renamed column) must not empty the plan: lines are removed or
  -- set to 0 only when the sheet gave at least half as many lines as the plan has.
  v_apply_removals := p_apply and jsonb_array_length(coalesce(p_lines, '[]')) * 2 >=
    (select count(*) from media_plan_history x where x.client_id = p_client and x.month = v_month and x.removed_at is null);
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
    order by (x.removed_at is null) desc, (x.start_date = (l->>'start')::date and x.end_date = (l->>'end')::date) desc,
             abs(coalesce(x.start_date, v_month) - (l->>'start')::date), abs(coalesce(x.end_date, v_to) - (l->>'end')::date)
    limit 1;

    if h.id is not null and h.removed_at is not null and coalesce((l->>'total')::numeric, 0) > 0 then
      v_msg := format('%s (%s) ponovo u planu %s–%s: %s €', h.campaign_label, l->>'network',
                      to_char((l->>'start')::date, fmt), to_char((l->>'end')::date, fmt), round((l->>'total')::numeric));
      v_out := v_out || to_jsonb(v_msg);
      if p_apply then
        update media_plan_history set removed_at = null where id = h.id;
        insert into media_plan_changes (client_id, month, target, kind, campaign_label, network, new_value, message, applied)
        values (p_client, v_month, 'history', 'restored', h.campaign_label, v_net, l, v_msg, true);
      end if;
      h.removed_at := null;
    end if;

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
    if coalesce(h.budget_total, 0) > 0 and coalesce((l->>'total')::numeric, 0) <= 0 and not v_apply_removals then
      v_msg := format('%s (%s): u tabeli 0 €, u Brainu %s €. Nije menjano (tabela je vratila premalo linija).', h.campaign_label, l->>'network', round(h.budget_total));
      v_ask := v_ask || to_jsonb(v_msg);
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
           where x.client_id = p_client and x.month = v_month and not (x.id = any (v_seen)) and x.removed_at is null
             and coalesce(x.budget_total, 0) > 0 loop
    if v_apply_removals then
      v_msg := format('%s (%s, %s–%s, %s €): nema je više u tabeli → uklonjena iz plana', h.campaign_label, h.network,
                      to_char(h.start_date, fmt), to_char(h.end_date, fmt), round(h.budget_total));
      v_rem := v_rem + 1;
      v_out := v_out || to_jsonb(v_msg);
      update media_plan_history set removed_at = now() where id = h.id;
      insert into media_plan_changes (client_id, month, target, kind, campaign_label, network, old_value, message, applied)
      values (p_client, v_month, 'history', 'removed', h.campaign_label, h.network,
              jsonb_build_object('start', h.start_date, 'end', h.end_date, 'total', h.budget_total), v_msg, true);
    else
      v_msg := format('%s (%s, %s–%s): %s € u Brainu, nema u tabeli. Nije menjano.', h.campaign_label, h.network,
                      to_char(h.start_date, fmt), to_char(h.end_date, fmt), round(h.budget_total));
      v_ask := v_ask || to_jsonb(v_msg);
    end if;
  end loop;

  return jsonb_build_object('new', v_new, 'updated', v_upd, 'removed', v_rem, 'questions', v_ask, 'changes', v_out);
end $function$;
revoke all on function public.brain_mpl_history_sync(uuid, date, jsonb, boolean) from public, anon, authenticated;
