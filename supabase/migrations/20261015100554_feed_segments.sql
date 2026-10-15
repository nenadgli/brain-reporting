-- Praćenje feeda po segmentima: kategorija, brend, pol, boja, custom labeli, cenovni razred, popust.
-- feed-sync stores more product attributes (attrs) and, after each check, a daily snapshot per segment
-- (feed_segment_daily): products, share on sale, average price and discount, new, gone and price
-- changes that day. feed_segments() compares a period's start with today and adds GA4 and Google Ads
-- results per segment. Which feed field is the category is set per feed (settings.category_field).

alter table public.feed_items add column if not exists attrs jsonb not null default '{}';
alter table public.product_feeds add column if not exists settings jsonb not null default '{}';
update public.product_feeds set settings = settings || '{"category_field": "custom_label_1"}'
where market = 'DE' and client_id = (select id from clients where name = 'Replay') and not settings ? 'category_field';

-- The segment value of a product for one dimension.
create or replace function public.feed_dim(i public.feed_items, p_dim text)
returns text language sql immutable as $$
  select coalesce(nullif(case p_dim
    when 'category' then i.category
    when 'brand' then i.brand
    when 'gender' then i.attrs->>'gender'
    when 'color' then i.attrs->>'color'
    when 'google_category' then i.attrs->>'google_product_category'
    when 'label0' then i.labels->>'custom_label_0'
    when 'label1' then i.labels->>'custom_label_1'
    when 'label2' then i.labels->>'custom_label_2'
    when 'label3' then i.labels->>'custom_label_3'
    when 'label4' then i.labels->>'custom_label_4'
    when 'sale' then case when i.sale_price is not null then 'na akciji' else 'puna cena' end
    when 'discount' then case
      when i.sale_price is null or i.price is null or i.price = 0 then '0% (puna cena)'
      when 1 - i.sale_price / i.price < 0.2 then '1–19%'
      when 1 - i.sale_price / i.price < 0.4 then '20–39%'
      when 1 - i.sale_price / i.price < 0.6 then '40–59%'
      else '60%+' end
    when 'price' then case
      when coalesce(i.sale_price, i.price) is null then '—'
      when coalesce(i.sale_price, i.price) < 50 then 'do 50'
      when coalesce(i.sale_price, i.price) < 100 then '50–99'
      when coalesce(i.sale_price, i.price) < 150 then '100–149'
      when coalesce(i.sale_price, i.price) < 250 then '150–249'
      else '250+' end
    end, ''), '(prazno)')
$$;

create table if not exists public.feed_segment_daily (
  feed_id uuid not null references public.product_feeds(id) on delete cascade,
  day date not null,
  dimension text not null,
  value text not null,
  items int not null,
  on_sale int not null,
  avg_price numeric,
  avg_effective_price numeric,
  avg_discount_pct numeric,
  max_discount_pct numeric,
  new_items int not null default 0,
  removed_items int not null default 0,
  price_changes int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (feed_id, day, dimension, value)
);
alter table public.feed_segment_daily enable row level security;
create policy "agency feed segments read" on public.feed_segment_daily for select using (
  feed_id in (select f.id from product_feeds f join clients c on c.id = f.client_id
              where current_user_client_id() is null and c.agency_id = current_user_agency_id()));
grant select on public.feed_segment_daily to authenticated;

-- Today's state of every segment, rewritten after each feed check.
create or replace function public.feed_segment_snapshot(p_feed_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into feed_segment_daily (feed_id, day, dimension, value, items, on_sale, avg_price, avg_effective_price, avg_discount_pct, max_discount_pct, new_items, removed_items, price_changes, updated_at)
  with dims(dim) as (values ('category'), ('brand'), ('gender'), ('color'), ('google_category'), ('label0'), ('label1'), ('label2'), ('label3'), ('label4'), ('sale'), ('discount'), ('price')),
  today as (
    select c.item_id, count(*) filter (where c.kind = 'new') as n_new, count(*) filter (where c.kind = 'removed') as n_removed,
           count(*) filter (where c.kind in ('price_up', 'price_down', 'sale_start', 'sale_end')) as n_price
    from feed_changes c where c.feed_id = p_feed_id and c.changed_at >= current_date group by 1
  ), x as (
    select d.dim, feed_dim(i, d.dim) as value, i.removed_at is null as active, i.price, i.sale_price,
           coalesce(t.n_new, 0) as n_new, coalesce(t.n_removed, 0) as n_removed, coalesce(t.n_price, 0) as n_price
    from feed_items i cross join dims d left join today t on t.item_id = i.item_id
    where i.feed_id = p_feed_id and (i.removed_at is null or i.removed_at >= current_date)
  )
  select p_feed_id, current_date, x.dim, x.value,
         count(*) filter (where x.active), count(*) filter (where x.active and x.sale_price is not null),
         round(avg(x.price) filter (where x.active), 2), round(avg(coalesce(x.sale_price, x.price)) filter (where x.active), 2),
         round(avg(100 * (1 - x.sale_price / x.price)) filter (where x.active and x.sale_price is not null and x.price > 0), 1),
         round(max(100 * (1 - x.sale_price / x.price)) filter (where x.active and x.sale_price is not null and x.price > 0), 1),
         sum(x.n_new), sum(x.n_removed), sum(x.n_price), now()
  from x group by x.dim, x.value
  on conflict (feed_id, day, dimension, value) do update set
    items = excluded.items, on_sale = excluded.on_sale, avg_price = excluded.avg_price, avg_effective_price = excluded.avg_effective_price,
    avg_discount_pct = excluded.avg_discount_pct, max_discount_pct = excluded.max_discount_pct, new_items = excluded.new_items,
    removed_items = excluded.removed_items, price_changes = excluded.price_changes, updated_at = now();
  get diagnostics n = row_count;
  -- A segment that emptied today keeps a row with zero products.
  update feed_segment_daily s set items = 0, on_sale = 0, updated_at = now()
  where s.feed_id = p_feed_id and s.day = current_date and s.updated_at < now() - interval '1 second';
  return n;
end $$;

-- Segments of one dimension: today's feed state, the state at the start of the period (nearest
-- snapshot on or after p_from), changes in the period and GA4 / Google Ads results in the period.
create or replace function public.feed_segments(p_feed_id uuid, p_dim text, p_from date, p_to date)
returns table (
  value text, items int, items_start int, on_sale int, on_sale_start int, avg_price numeric, avg_effective_price numeric,
  avg_discount_pct numeric, avg_discount_start numeric, max_discount_pct numeric, new_items int, removed_items int, price_changes int,
  views numeric, add_to_cart numeric, purchases numeric, revenue numeric, clicks numeric, spend numeric, conversion_value numeric,
  start_day date, end_day date
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
           sum(p.clicks) as clicks, sum(p.spend) as spend, sum(p.conversion_value) as val
    from product_daily p join feed_items i on i.feed_id = p_feed_id and i.item_id = p.item_id
    where p.client_id = f.client_id and p.market = f.market and p.report_date between p_from and p_to
    group by 1
  ), vals as (select cur.value from cur union select st.value from st union select perf.value from perf)
  select v.value, coalesce(cur.items, 0), st.items, coalesce(cur.on_sale, 0), st.on_sale, cur.avg_price, cur.avg_effective_price,
         cur.avg_discount_pct, st.avg_discount_pct, cur.max_discount_pct, coalesce(per.n_new, 0), coalesce(per.n_removed, 0), coalesce(per.n_price, 0),
         coalesce(perf.views, 0), coalesce(perf.atc, 0), coalesce(perf.purchases, 0), round(coalesce(perf.revenue, 0), 2),
         coalesce(perf.clicks, 0), round(coalesce(perf.spend, 0), 2), round(coalesce(perf.val, 0), 2), d0, d1
  from vals v
  left join cur on cur.value = v.value left join st on st.value = v.value
  left join per on per.value = v.value left join perf on perf.value = v.value
  order by coalesce(perf.revenue, 0) + coalesce(perf.spend, 0) desc, coalesce(cur.items, 0) desc;
end $$;
grant execute on function public.feed_segments(uuid, text, date, date) to authenticated;
