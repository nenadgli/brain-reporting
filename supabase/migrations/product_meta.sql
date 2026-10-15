-- Meta po proizvodu. product-sync also stores Meta catalog ads per product (spend, impressions,
-- clicks, purchases and purchase value as Meta attributes them). Meta returns the product as
-- "ID, title" with the title in the market's language, so a row belongs to the feed whose product has
-- that id and title. Google Ads and Meta are kept apart in the product and segment views; the
-- product alerts keep using Google Ads for "spends without selling" and both for "almost no ads".

alter table public.product_daily drop constraint if exists product_daily_source_check;
alter table public.product_daily add constraint product_daily_source_check check (source in ('ga4', 'google_ads', 'meta'));

drop function if exists public.product_performance(uuid, date, date);
create or replace function public.product_performance(p_feed_id uuid, p_from date, p_to date)
returns table (
  item_id text, group_id text, title text, category text, link text, image text, price numeric, sale_price numeric,
  in_feed boolean, first_seen_at timestamptz, removed_at timestamptz,
  views numeric, add_to_cart numeric, purchases numeric, revenue numeric,
  impressions numeric, clicks numeric, spend numeric, conversions numeric, conversion_value numeric,
  meta_impressions numeric, meta_clicks numeric, meta_spend numeric, meta_purchases numeric, meta_value numeric,
  last_change_kind text, last_change_at timestamptz, last_change_old text, last_change_new text
)
language plpgsql stable security definer set search_path = public as $$
declare f record;
begin
  select pf.id, pf.client_id, pf.market into f from product_feeds pf where pf.id = p_feed_id;
  if f.id is null then return; end if;
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = f.client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'product_performance: not allowed';
  end if;
  return query
  with d as (
    select p.item_id,
           sum(p.views) as views, sum(p.add_to_cart) as atc, sum(p.purchases) as purchases, sum(p.revenue) as revenue,
           sum(p.impressions) filter (where p.source = 'google_ads') as impressions, sum(p.clicks) filter (where p.source = 'google_ads') as clicks,
           sum(p.spend) filter (where p.source = 'google_ads') as spend, sum(p.conversions) filter (where p.source = 'google_ads') as conv,
           sum(p.conversion_value) filter (where p.source = 'google_ads') as val,
           sum(p.impressions) filter (where p.source = 'meta') as m_impr, sum(p.clicks) filter (where p.source = 'meta') as m_clicks,
           sum(p.spend) filter (where p.source = 'meta') as m_spend, sum(p.conversions) filter (where p.source = 'meta') as m_conv,
           sum(p.conversion_value) filter (where p.source = 'meta') as m_val
    from product_daily p
    where p.client_id = f.client_id and p.market = f.market and p.report_date between p_from and p_to
    group by 1
  ), ch as (
    select distinct on (c.item_id) c.item_id, c.kind, c.changed_at, c.old_value, c.new_value
    from feed_changes c where c.feed_id = p_feed_id order by c.item_id, c.changed_at desc
  )
  select i.item_id, i.group_id, i.title, i.category, i.link, i.image, i.price, i.sale_price,
         i.removed_at is null, i.first_seen_at, i.removed_at,
         coalesce(d.views, 0), coalesce(d.atc, 0), coalesce(d.purchases, 0), round(coalesce(d.revenue, 0), 2),
         coalesce(d.impressions, 0), coalesce(d.clicks, 0), round(coalesce(d.spend, 0), 2), round(coalesce(d.conv, 0), 2), round(coalesce(d.val, 0), 2),
         coalesce(d.m_impr, 0), coalesce(d.m_clicks, 0), round(coalesce(d.m_spend, 0), 2), round(coalesce(d.m_conv, 0), 2), round(coalesce(d.m_val, 0), 2),
         ch.kind, ch.changed_at, ch.old_value, ch.new_value
  from feed_items i
  left join d on d.item_id = i.item_id
  left join ch on ch.item_id = i.item_id
  where i.feed_id = p_feed_id and (i.removed_at is null or d.item_id is not null)
  order by coalesce(d.spend, 0) + coalesce(d.m_spend, 0) + coalesce(d.revenue, 0) desc;
end $$;
grant execute on function public.product_performance(uuid, date, date) to authenticated;
drop function if exists public.feed_segments(uuid, text, date, date);
-- Segments of one dimension: today's feed state, the state at the start of the period (nearest
-- snapshot on or after p_from), changes in the period and GA4 / Google Ads results in the period.
create or replace function public.feed_segments(p_feed_id uuid, p_dim text, p_from date, p_to date)
returns table (
  value text, items int, items_start int, on_sale int, on_sale_start int, avg_price numeric, avg_effective_price numeric,
  avg_discount_pct numeric, avg_discount_start numeric, max_discount_pct numeric, new_items int, removed_items int, price_changes int,
  views numeric, add_to_cart numeric, purchases numeric, revenue numeric, clicks numeric, spend numeric, conversion_value numeric,
  meta_spend numeric, meta_value numeric, start_day date, end_day date
)
language plpgsql stable security definer set search_path = public as $$
declare f record; d0 date; d1 date;
begin
  select pf.id, pf.client_id, pf.market into f from product_feeds pf where pf.id = p_feed_id;
  if f.id is null then return; end if;
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = f.client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'feed_segments: not allowed';
  end if;
  d1 := (select max(s.day) from feed_segment_daily s where s.feed_id = p_feed_id);
  d0 := coalesce((select min(s.day) from feed_segment_daily s where s.feed_id = p_feed_id and s.day >= p_from), d1);
  return query
  with cur as (select * from feed_segment_daily s where s.feed_id = p_feed_id and s.day = d1 and s.dimension = p_dim),
  st as (select * from feed_segment_daily s where s.feed_id = p_feed_id and s.day = d0 and s.dimension = p_dim),
  per as (
    select s.value, sum(s.new_items)::int as n_new, sum(s.removed_items)::int as n_removed, sum(s.price_changes)::int as n_price
    from feed_segment_daily s where s.feed_id = p_feed_id and s.dimension = p_dim and s.day between greatest(d0, p_from) and d1 group by 1
  ), perf as (
    select feed_dim(i, p_dim) as value, sum(p.views) as views, sum(p.add_to_cart) as atc, sum(p.purchases) as purchases, sum(p.revenue) as revenue,
           sum(p.clicks) filter (where p.source = 'google_ads') as clicks, sum(p.spend) filter (where p.source = 'google_ads') as spend,
           sum(p.conversion_value) filter (where p.source = 'google_ads') as val,
           sum(p.spend) filter (where p.source = 'meta') as m_spend, sum(p.conversion_value) filter (where p.source = 'meta') as m_val
    from product_daily p join feed_items i on i.feed_id = p_feed_id and i.item_id = p.item_id
    where p.client_id = f.client_id and p.market = f.market and p.report_date between p_from and p_to
    group by 1
  ), vals as (select cur.value from cur union select st.value from st union select perf.value from perf)
  select v.value, coalesce(cur.items, 0), st.items, coalesce(cur.on_sale, 0), st.on_sale, cur.avg_price, cur.avg_effective_price,
         cur.avg_discount_pct, st.avg_discount_pct, cur.max_discount_pct, coalesce(per.n_new, 0), coalesce(per.n_removed, 0), coalesce(per.n_price, 0),
         coalesce(perf.views, 0), coalesce(perf.atc, 0), coalesce(perf.purchases, 0), round(coalesce(perf.revenue, 0), 2),
         coalesce(perf.clicks, 0), round(coalesce(perf.spend, 0), 2), round(coalesce(perf.val, 0), 2),
         round(coalesce(perf.m_spend, 0), 2), round(coalesce(perf.m_val, 0), 2), d0, d1
  from vals v
  left join cur on cur.value = v.value left join st on st.value = v.value
  left join per on per.value = v.value left join perf on perf.value = v.value
  order by coalesce(perf.revenue, 0) + coalesce(perf.spend, 0) + coalesce(perf.m_spend, 0) desc, coalesce(cur.items, 0) desc;
end $$;
grant execute on function public.feed_segments(uuid, text, date, date) to authenticated;

-- Spends without selling: Google Ads only (Meta attributes purchases its own way).
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
        select p.item_id, sum(p.spend) filter (where p.source = 'google_ads') as spend, sum(p.clicks) filter (where p.source = 'google_ads') as clicks,
               sum(p.conversions) filter (where p.source = 'google_ads') as conv, sum(p.purchases) as purchases, sum(p.views) as views
        from product_daily p where p.client_id = p_client_id and p.market = f.market and p.report_date between d - 13 and d
        group by 1
      ), hit as (
        select w.*, i.title, i.price, i.sale_price, i.removed_at is null as in_feed
        from w left join feed_items i on i.feed_id = f.id and i.item_id = w.item_id
        where coalesce(w.spend, 0) >= min_spend and w.purchases = 0 and coalesce(w.conv, 0) < 1
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

