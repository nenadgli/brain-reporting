-- Feed notices read "Sklonjeno iz feeda: brend „X“" (no gender agreement problem) and percentages use a decimal comma.

create or replace function public.feed_generate_alerts(p_feed_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s record; p record; last_change timestamptz; n int := 0; k int;
  dims text[] := array['brand', 'category', 'label0', 'label1', 'label2', 'label3', 'label4'];
  dim_label jsonb := '{"brand": "Brend", "category": "Kategorija", "label0": "Custom label 0", "label1": "Custom label 1", "label2": "Custom label 2", "label3": "Custom label 3", "label4": "Custom label 4"}';
begin
  -- Called by feed-sync (service role); an API caller must be an agency user of the feed's client.
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not exists (select 1 from product_feeds f join clients c on c.id = f.client_id
                     where f.id = p_feed_id and current_user_client_id() is null and c.agency_id = current_user_agency_id()) then
    raise exception 'feed_generate_alerts: not allowed';
  end if;
  select * into s from feed_snapshots x where x.feed_id = p_feed_id order by x.checked_at desc limit 1;
  if s.id is null then return 0; end if;
  select * into p from feed_snapshots x where x.feed_id = p_feed_id and x.checked_at < s.checked_at order by x.checked_at desc limit 1;

  -- Works / does not work.
  if s.status = 'greska' and (p.id is null or p.status <> 'greska') then
    insert into feed_alerts (feed_id, created_at, severity, kind, title, lines, fingerprint)
    values (p_feed_id, s.checked_at, 'visoko', 'feed_down', 'Feed ne radi', jsonb_build_array(coalesce(s.error, 'nepoznata greška')), 'down:' || s.id)
    on conflict do nothing;
    n := n + 1;
  elsif s.status <> 'greska' and p.status = 'greska' then
    insert into feed_alerts (feed_id, created_at, severity, kind, title, lines, fingerprint)
    values (p_feed_id, s.checked_at, 'ok', 'feed_up', 'Feed ponovo radi', jsonb_build_array(s.items || ' proizvoda'), 'up:' || s.id)
    on conflict do nothing;
  end if;
  if s.status = 'sumnjiv' then
    insert into feed_alerts (feed_id, created_at, severity, kind, title, lines, fingerprint)
    values (p_feed_id, s.checked_at, 'visoko', 'feed_suspicious', 'Feed izgleda pokvareno: naglo mnogo manje proizvoda', jsonb_build_array(coalesce(s.error, '')), 'susp:' || s.id)
    on conflict do nothing;
  end if;

  -- No change for two days (once a day).
  last_change := (select max(x.checked_at) from feed_snapshots x where x.feed_id = p_feed_id and x.status in ('ok', 'osnova'));
  if s.status = 'nepromenjen' and last_change < s.checked_at - interval '48 hours' then
    insert into feed_alerts (feed_id, created_at, severity, kind, title, lines, fingerprint)
    values (p_feed_id, s.checked_at, 'srednje', 'feed_stale',
            'Feed se nije menjao od ' || to_char(last_change, 'DD.MM. HH24:MI'),
            jsonb_build_array('Isti fajl u svim proverama posle toga; proveriti da li se feed na sajtu još osvežava (cene, stanje).'),
            'stale:' || s.checked_at::date)
    on conflict do nothing;
  end if;

  if s.status not in ('ok') then return n; end if;
  -- The custom label used as the category is reported once, as the category.
  select array_remove(dims, 'label' || right(f.settings->>'category_field', 1)) into dims
  from product_feeds f where f.id = p_feed_id and f.settings->>'category_field' like 'custom\_label\_%';
  dims := coalesce(dims, array['brand', 'category', 'label0', 'label1', 'label2', 'label3', 'label4']);

  -- Brand, category or label value appeared (all its products are new or back in this check) or
  -- disappeared (its products left in this check and none is left).
  insert into feed_alerts (feed_id, created_at, severity, kind, title, lines, data, fingerprint)
  with ch as (
    select c.item_id, c.kind from feed_changes c where c.feed_id = p_feed_id and c.changed_at = s.checked_at
  ), x as (
    select d.dim, feed_dim(i, d.dim) as value,
           count(*) filter (where i.removed_at is null) as active,
           count(*) filter (where ch.kind in ('new', 'back')) as came,
           count(*) filter (where ch.kind = 'removed') as left_now
    from feed_items i cross join unnest(dims) d(dim) left join ch on ch.item_id = i.item_id
    where i.feed_id = p_feed_id
    group by 1, 2
  )
  select p_feed_id, s.checked_at,
         case when x.left_now > 0 and x.active = 0 then 'srednje' else 'info' end,
         case when x.left_now > 0 and x.active = 0 then 'segment_removed' else 'segment_added' end,
         case when x.left_now > 0 and x.active = 0
              then 'Sklonjeno iz feeda: ' || lower(dim_label->>x.dim) || ' „' || x.value || '“ (' || x.left_now || ' proizvoda)'
              else 'Dodato u feed: ' || lower(dim_label->>x.dim) || ' „' || x.value || '“ (' || x.came || ' proizvoda)' end,
         '[]'::jsonb, jsonb_build_object('dimension', x.dim, 'value', x.value),
         x.dim || ':' || x.value || ':' || case when x.left_now > 0 and x.active = 0 then 'out' else 'in' end || ':' || s.id
  from x
  where x.value <> '(prazno)'
    and ((x.left_now > 0 and x.active = 0) or (x.came > 0 and x.came = x.active))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  -- What changed in this check, per category.
  insert into feed_alerts (feed_id, created_at, severity, kind, title, lines, data, fingerprint)
  with ch as (
    select c.item_id, c.kind,
           case when c.kind in ('price_up', 'price_down', 'sale_start', 'sale_end') and c.old_value ~ '^[0-9.]+$' and c.new_value ~ '^[0-9.]+$'
                     and c.old_value::numeric > 0 then (c.new_value::numeric / c.old_value::numeric - 1) * 100 end as pct
    from feed_changes c where c.feed_id = p_feed_id and c.changed_at = s.checked_at
  ), per as (
    select feed_dim(i, 'category') as value, ch.kind, count(*) as cnt, round(avg(ch.pct), 1) as avg_pct
    from ch join feed_items i on i.feed_id = p_feed_id and i.item_id = ch.item_id
    group by 1, 2
  ), seg as (
    select per.value, sum(per.cnt) as total,
           string_agg(
             case per.kind
               when 'price_down' then per.cnt || ' pojeftinilo' || coalesce(' (' || replace(per.avg_pct::text, '.', ',') || '%)', '')
               when 'price_up' then per.cnt || ' poskupelo' || coalesce(' (+' || replace(per.avg_pct::text, '.', ',') || '%)', '')
               when 'sale_start' then per.cnt || ' na akciji' || coalesce(' (' || replace(per.avg_pct::text, '.', ',') || '%)', '')
               when 'sale_end' then per.cnt || ' skinuto sa akcije'
               when 'new' then per.cnt || ' ubačeno'
               when 'removed' then per.cnt || ' izbačeno'
               when 'back' then per.cnt || ' vraćeno'
               when 'title' then per.cnt || ' promenjen naslov'
               when 'label' then per.cnt || ' promenjen label'
               else per.cnt || ' ' || per.kind end, ', ' order by per.cnt desc) as text
    from per group by 1
  )
  select p_feed_id, s.checked_at,
         case when coalesce(s.removed_items, 0) >= greatest(20, s.items * 0.05) or coalesce(s.price_changes, 0) + coalesce(s.sale_changes, 0) >= greatest(30, s.items * 0.1)
              then 'srednje' else 'info' end,
         'feed_changes',
         'Promene u feedu: ' || concat_ws(', ',
            nullif(coalesce(s.price_changes, 0) + coalesce(s.sale_changes, 0), 0) || ' promena cene/akcije',
            nullif(coalesce(s.new_items, 0), 0) || ' ubačeno',
            nullif(coalesce(s.removed_items, 0), 0) || ' izbačeno',
            nullif(coalesce(s.back_items, 0), 0) || ' vraćeno',
            nullif(coalesce(s.other_changes, 0), 0) || ' ostalo'),
         (select jsonb_agg(seg.value || ': ' || seg.text order by seg.total desc) from seg),
         jsonb_build_object('items', s.items), 'changes:' || s.id
  where exists (select 1 from ch)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
