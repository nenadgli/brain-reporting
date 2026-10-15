-- Upozorenja po proizvodu prošireno na Metu: "Meta troši bez prodaje" (product_meta_no_sale, 30 or
-- more in 14 days with no GA4 purchase and no Meta purchase), "skoro bez oglasa" counts Google Ads and
-- Meta spend, and "van stanja, a troši" counts spend on both after the product left the feed.

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

      -- Meta spends without selling (GA4 purchases and Meta purchases both zero).
      return query
      with w as (
        select m.item_id, sum(m.spend) as spend, sum(m.clicks) as clicks, sum(m.purchases) as meta_purchases
        from product_daily_meta m where m.client_id = p_client_id and m.market = f.market and m.report_date between d - 13 and d
        group by 1
      ), ga as (
        select p.item_id, sum(p.purchases) as purchases, sum(p.views) as views
        from product_daily p where p.client_id = p_client_id and p.market = f.market and p.source = 'ga4' and p.report_date between d - 13 and d
        group by 1
      ), hit as (
        select w.*, coalesce(ga.views, 0) as views, i.title, i.price, i.sale_price, i.removed_at is null as in_feed
        from w left join ga on ga.item_id = w.item_id left join feed_items i on i.feed_id = f.id and i.item_id = w.item_id
        where w.spend >= min_spend and coalesce(ga.purchases, 0) = 0 and w.meta_purchases < 1
      )
      select 'product_meta_no_sale', 'product_meta_no_sale:' || f.market,
             case when sum(h.spend) >= 500 then 'visoko' else 'srednje' end, round(sum(h.spend), 2),
             jsonb_build_object('market', f.market, 'from', d - 13, 'to', d, 'min_spend', min_spend, 'count', count(*),
               'total_spend', round(sum(h.spend), 2),
               'items', (select jsonb_agg(x order by x.spend desc) from (select h2.item_id, h2.title, round(h2.spend, 2) as spend, h2.clicks, h2.views,
                          h2.price, h2.sale_price, h2.in_feed from hit h2 order by h2.spend desc limit 15) x))
      from hit h having count(*) > 0;

      -- Sells, but gets almost no ads.
      return query
      with w as (
        select x.item_id, sum(x.purchases) as purchases, sum(x.revenue) as revenue, sum(x.spend) as spend from (
          select p.item_id, p.purchases, p.revenue, p.spend
          from product_daily p where p.client_id = p_client_id and p.market = f.market and p.report_date between d - 13 and d
          union all
          select m.item_id, 0, 0, m.spend
          from product_daily_meta m where m.client_id = p_client_id and m.market = f.market and m.report_date between d - 13 and d
        ) x group by 1
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
        select g.item_id, g.title, g.removed_at::date as removed, sum(s.spend) as spend_after, sum(s.clicks) as clicks_after,
               sum(s.spend) filter (where s.src = 'google_ads') as google_after, sum(s.spend) filter (where s.src = 'meta') as meta_after
        from gone g join (
          select p.item_id, p.report_date, p.spend, p.clicks, 'google_ads' as src from product_daily p
          where p.client_id = p_client_id and p.market = f.market and p.source = 'google_ads'
          union all
          select m.item_id, m.report_date, m.spend, m.clicks, 'meta' from product_daily_meta m
          where m.client_id = p_client_id and m.market = f.market
        ) s on s.item_id = g.item_id and s.report_date >= g.removed_at::date
        group by 1, 2, 3 having sum(s.spend) > 0
      )
      select 'product_gone_spending', 'product_gone_spending:' || f.market || ':' || max(h.removed),
             'visoko', round(sum(h.spend_after), 2),
             jsonb_build_object('market', f.market, 'count', count(*), 'total_spend_after', round(sum(h.spend_after), 2),
               'items', (select jsonb_agg(x order by x.spend_after desc) from (select h2.item_id, h2.title, h2.removed, round(h2.spend_after, 2) as spend_after,
                          h2.clicks_after, round(coalesce(h2.google_after, 0), 2) as google_after, round(coalesce(h2.meta_after, 0), 2) as meta_after from hit h2 order by h2.spend_after desc limit 15) x))
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
