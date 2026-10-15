-- Upozorenja po proizvodu u jutarnjem pregledu, for clients with a product feed. product_candidates()
-- computes every number; the morning review words them and the team decides in "PPC taskovi" under
-- the new task "Proizvodi i feed". One grouped finding per kind and market:
-- - product_spend_no_sale: Google Ads spent at least product_min_spend (30) in 14 days, no GA4
--   purchase and no Ads conversion;
-- - product_no_ads: at least 3 GA4 purchases in 14 days, almost no Google Ads spend (< 2);
-- - product_gone_spending: gone from the feed (out of stock) in the last 7 days, ads still spent after;
-- - product_price_drop: after a price increase or the end of a sale, daily purchases fell by half or more;
-- - feed_wave: in the last 24 hours the feed failed, looked broken, or changed a lot at once.

create or replace function public.product_candidates(p_client_id uuid)
returns table (check_type text, fingerprint text, severity text, impact_eur numeric, evidence jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  f record;
  d date;
  min_spend numeric;
begin
  select coalesce((r.params->>'product_min_spend')::numeric, 30) into min_spend from review_settings r where r.client_id = p_client_id;
  min_spend := coalesce(min_spend, 30);
  for f in select pf.id, pf.market from product_feeds pf where pf.client_id = p_client_id and pf.enabled loop
    d := (select max(p.report_date) from product_daily p where p.client_id = p_client_id and p.market = f.market);

    if d is not null then
      -- Spends without selling.
      return query
      with w as (
        select p.item_id, sum(p.spend) as spend, sum(p.clicks) as clicks, sum(p.conversions) as conv,
               sum(p.purchases) as purchases, sum(p.views) as views
        from product_daily p where p.client_id = p_client_id and p.market = f.market and p.report_date between d - 13 and d
        group by 1
      ), hit as (
        select w.*, i.title, i.price, i.sale_price, i.removed_at is null as in_feed
        from w left join feed_items i on i.feed_id = f.id and i.item_id = w.item_id
        where w.spend >= min_spend and w.purchases = 0 and w.conv < 1
      )
      select 'product_spend_no_sale', 'product_spend_no_sale:' || f.market,
             case when sum(h.spend) >= 500 then 'visoko' else 'srednje' end, round(sum(h.spend), 2),
             jsonb_build_object('market', f.market, 'from', d - 13, 'to', d, 'min_spend', min_spend, 'count', count(*),
               'total_spend', round(sum(h.spend), 2),
               'items', (select jsonb_agg(x order by x.spend desc) from (select h2.item_id, h2.title, round(h2.spend, 2) as spend, h2.clicks, h2.views,
                          h2.price, h2.sale_price, h2.in_feed from hit h2 order by h2.spend desc limit 15) x))
      from hit h having count(*) > 0;

      -- Sells, but gets almost no ads.
      return query
      with w as (
        select p.item_id, sum(p.purchases) as purchases, sum(p.revenue) as revenue, sum(p.spend) as spend
        from product_daily p where p.client_id = p_client_id and p.market = f.market and p.report_date between d - 13 and d
        group by 1
      ), hit as (
        select w.*, i.title, i.price, i.sale_price
        from w join feed_items i on i.feed_id = f.id and i.item_id = w.item_id and i.removed_at is null
        where w.purchases >= 3 and w.spend < 2
      )
      select 'product_no_ads', 'product_no_ads:' || f.market, 'info', null::numeric,
             jsonb_build_object('market', f.market, 'from', d - 13, 'to', d, 'count', count(*), 'total_revenue', round(sum(h.revenue), 2),
               'total_purchases', sum(h.purchases),
               'items', (select jsonb_agg(x order by x.revenue desc) from (select h2.item_id, h2.title, h2.purchases, round(h2.revenue, 2) as revenue,
                          round(h2.spend, 2) as spend, h2.price, h2.sale_price from hit h2 order by h2.revenue desc limit 15) x))
      from hit h having count(*) > 0;

      -- Out of stock, still spending.
      return query
      with gone as (
        select i.item_id, i.title, i.removed_at from feed_items i
        where i.feed_id = f.id and i.removed_at > now() - interval '7 days'
      ), hit as (
        select g.item_id, g.title, g.removed_at::date as removed, sum(p.spend) as spend_after, sum(p.clicks) as clicks_after
        from gone g join product_daily p on p.client_id = p_client_id and p.market = f.market and p.item_id = g.item_id
          and p.source = 'google_ads' and p.report_date >= g.removed_at::date
        group by 1, 2, 3 having sum(p.spend) > 0
      )
      select 'product_gone_spending', 'product_gone_spending:' || f.market || ':' || max(h.removed),
             'visoko', round(sum(h.spend_after), 2),
             jsonb_build_object('market', f.market, 'count', count(*), 'total_spend_after', round(sum(h.spend_after), 2),
               'items', (select jsonb_agg(x order by x.spend_after desc) from (select h2.item_id, h2.title, h2.removed, round(h2.spend_after, 2) as spend_after,
                          h2.clicks_after from hit h2 order by h2.spend_after desc limit 15) x))
      from hit h having count(*) > 0;

      -- Sales fell after a price increase or the end of a sale (at least 4 days after the change).
      return query
      with ch as (
        select distinct on (c.item_id) c.item_id, c.kind, c.changed_at::date as day, c.old_value, c.new_value
        from feed_changes c where c.feed_id = f.id and c.kind in ('price_up', 'sale_end')
          and c.changed_at::date between d - 21 and d - 4
        order by c.item_id, c.changed_at desc
      ), rates as (
        select ch.*,
          (select coalesce(sum(p.purchases), 0) from product_daily p where p.client_id = p_client_id and p.market = f.market and p.source = 'ga4'
             and p.item_id = ch.item_id and p.report_date between ch.day - 7 and ch.day - 1) as before7,
          (select coalesce(sum(p.purchases), 0) from product_daily p where p.client_id = p_client_id and p.market = f.market and p.source = 'ga4'
             and p.item_id = ch.item_id and p.report_date between ch.day and least(d, ch.day + 6)) as after_n,
          least(d, ch.day + 6) - ch.day + 1 as after_days
        from ch
      ), hit as (
        select r.*, i.title, round(r.before7 / 7.0, 2) as per_day_before, round(r.after_n / r.after_days::numeric, 2) as per_day_after
        from rates r left join feed_items i on i.feed_id = f.id and i.item_id = r.item_id
        where r.before7 >= 3 and r.after_n / r.after_days::numeric <= r.before7 / 7.0 * 0.5
      )
      select 'product_price_drop', 'product_price_drop:' || f.market, 'srednje', null::numeric,
             jsonb_build_object('market', f.market, 'count', count(*),
               'items', (select jsonb_agg(x order by x.before7 desc) from (select h2.item_id, h2.title, h2.kind, h2.day, h2.old_value, h2.new_value,
                          h2.before7, h2.per_day_before, h2.per_day_after, h2.after_days from hit h2 order by h2.before7 desc limit 15) x))
      from hit h having count(*) > 0;
    end if;

    -- Feed failed, looked broken, or changed a lot in the last 24 hours.
    return query
    with s as (
      select * from feed_snapshots x where x.feed_id = f.id and x.checked_at > now() - interval '24 hours'
    ), agg as (
      select max(s.items) as items, sum(coalesce(s.price_changes, 0) + coalesce(s.sale_changes, 0)) as price_changes,
             sum(coalesce(s.removed_items, 0)) as removed, sum(coalesce(s.new_items, 0)) as added,
             bool_or(s.status = 'sumnjiv') as suspicious, bool_or(s.status = 'greska') as failed,
             (select x.error from s x where x.error is not null order by x.checked_at desc limit 1) as error,
             (select x.status from s x order by x.checked_at desc limit 1) as last_status
      from s
    )
    select 'feed_wave', 'feed_wave:' || f.market || ':' || current_date,
           case when a.suspicious or a.last_status = 'greska' then 'visoko' else 'srednje' end, null::numeric,
           jsonb_build_object('market', f.market, 'items', a.items, 'price_changes', a.price_changes, 'removed', a.removed, 'added', a.added,
             'suspicious', a.suspicious, 'failed', a.last_status = 'greska', 'error', a.error)
    from agg a
    where (a.items is not null or a.failed)
      and (a.suspicious or a.last_status = 'greska'
           or a.price_changes >= greatest(50, coalesce(a.items, 0) * 0.10)
           or a.removed >= greatest(30, coalesce(a.items, 0) * 0.05));
  end loop;
end $$;

-- Product and feed findings belong to their own task.
create or replace function public.ppc_task_of_check(p_check text)
returns text language sql immutable as $$
  select case
    when p_check in ('pacing', 'campaign_budgets', 'meta_cap') then 'provera_budzeta'
    when p_check = 'search_terms' then 'search_terms'
    when p_check = 'ads_policy' then 'disapproved'
    when p_check = 'recommendations' then 'recommendations'
    when p_check = 'placements' then 'placements'
    when p_check = 'ga4_tracking' then 'ga4'
    when p_check like 'product\_%' or p_check = 'feed_wave' then 'proizvodi'
    else 'provera_naloga' end
$$;

-- The task board learns "Proizvodi i feed" (weekly), for clients with a product feed.
create or replace function public.ppc_task_board(p_asof date default null)
returns table (client_id uuid, client_name text, task text, applies boolean, last_done timestamptz, open_items int, status text)
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_asof, current_date);
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_user_client_id() is not null then
    raise exception 'ppc_task_board: not allowed';
  end if;
  return query
  with cl as (
    select c.id, c.name,
           exists (select 1 from data_sources s where s.client_id = c.id and s.provider = 'google_ads') as has_google,
           exists (select 1 from data_sources s where s.client_id = c.id and s.provider = 'ga4') as has_ga4,
           exists (select 1 from product_feeds pf where pf.client_id = c.id and pf.enabled) as has_feed
    from clients c join review_settings r on r.client_id = c.id and r.enabled
    where c.agency_id = coalesce(current_user_agency_id(), c.agency_id)
  ), tasks(task, cadence) as (values
    ('provera_budzeta', 3), ('optimizacija_budzeta', 10), ('provera_naloga', 7), ('search_terms', 14),
    ('disapproved', 7), ('recommendations', 7), ('placements', 7), ('ga4', 7), ('mesecna_potrosnja', 31), ('kampanje', null),
    ('alokacija_budzeta', null), ('osvezavanje_oglasa', 90), ('proizvodi', 7)
  ), log as (
    select r.client_id, r.task, max(r.created_at) as last_done from ppc_task_reviews r group by 1, 2
  ), open_findings as (
    select f.client_id, ppc_task_of_check(f.check_type) as task, count(*)::int as n
    from review_findings f
    where f.status = 'novo' and f.run_date > d - 7
    group by 1, 2
  ), open_drafts as (
    select x.client_id, count(*)::int as n from (
      select p.client_id from pmax_asset_group_drafts p where p.status in ('draft', 'exported')
      union all select g.client_id from demand_gen_drafts g where g.status in ('draft', 'exported')
      union all select v.client_id from video_campaign_drafts v where v.status in ('draft', 'exported')
      union all select s.client_id from display_ad_drafts s where s.status in ('draft', 'exported')
      union all select a.client_id from automation_drafts a where a.kind = 'campaign' and a.status in ('draft', 'exported')
    ) x group by 1
  ), alloc as (
    select p.client_id, max(p.month) as month, max(p.approved_at) as approved_at
    from allocation_proposals p where p.status = 'approved' group by 1
  ), rsa_open as (
    select x.client_id, count(*)::int as n from rsa_refresh_needed() x group by 1
  ), spend_month as (
    select max(a.created_at) as last_done from ppc_actions a where a.task = 'mesecna_potrosnja'
  )
  select cl.id, cl.name, t.task,
         case when t.task in ('search_terms', 'disapproved', 'recommendations', 'placements', 'optimizacija_budzeta', 'osvezavanje_oglasa') then cl.has_google
              when t.task = 'ga4' then cl.has_ga4 when t.task = 'proizvodi' then cl.has_feed else true end,
         case when t.task = 'mesecna_potrosnja' then (select sm.last_done from spend_month sm)
              when t.task = 'alokacija_budzeta' then al.approved_at else l.last_done end,
         coalesce(case when t.task = 'kampanje' then od.n when t.task = 'osvezavanje_oglasa' then ro.n else ofi.n end, 0),
         case
           when t.task = 'kampanje' then case when coalesce(od.n, 0) > 0 then 'ceka' else 'u_roku' end
           when t.task = 'alokacija_budzeta' then
             case when al.month >= (date_trunc('month', d) + interval '1 month')::date then 'u_roku'
                  when al.month = date_trunc('month', d)::date then case when extract(day from d) >= 25 then 'uskoro' else 'u_roku' end
                  when extract(day from d) <= 3 then 'uskoro' else 'kasni' end
           when t.task = 'mesecna_potrosnja' then
             case when (select sm.last_done from spend_month sm) >= date_trunc('month', d) then 'u_roku'
                  when extract(day from d) <= 5 then 'uskoro' else 'kasni' end
           when l.last_done is null then 'nikad'
           when l.last_done::date >= d - t.cadence then 'u_roku'
           else 'kasni' end
  from cl cross join tasks t
  left join log l on l.client_id = cl.id and l.task = t.task
  left join open_findings ofi on ofi.client_id = cl.id and ofi.task = t.task
  left join open_drafts od on od.client_id = cl.id
  left join alloc al on al.client_id = cl.id
  left join rsa_open ro on ro.client_id = cl.id
  order by cl.name, t.task;
end $$;
