-- Podaci po proizvodu. product-sync pulls GA4 item results (views, add to cart, purchases, revenue)
-- and Google Ads Shopping/PMax product results (impressions, clicks, cost, conversions, value) per
-- day for the markets a client has a product feed for. Item ids are stored upper-case, as in
-- feed_items, so the three sources join by item id.

create table if not exists public.product_daily (
  client_id uuid not null references public.clients(id) on delete cascade,
  source text not null check (source in ('ga4', 'google_ads')),
  report_date date not null,
  market text not null,
  item_id text not null,
  campaign_type text not null default '',
  views numeric not null default 0,
  add_to_cart numeric not null default 0,
  purchases numeric not null default 0,
  revenue numeric not null default 0,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  conversions numeric not null default 0,
  conversion_value numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (client_id, source, report_date, market, item_id, campaign_type)
);
create index if not exists product_daily_item_idx on public.product_daily(client_id, market, item_id, report_date);
alter table public.product_daily enable row level security;
create policy "agency product daily read" on public.product_daily for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select on public.product_daily to authenticated;

-- Every product of a feed with its feed data and GA4 and Google Ads results in a period, plus the
-- last change the feed showed for it.
create or replace function public.product_performance(p_feed_id uuid, p_from date, p_to date)
returns table (
  item_id text, group_id text, title text, category text, link text, image text, price numeric, sale_price numeric,
  in_feed boolean, first_seen_at timestamptz, removed_at timestamptz,
  views numeric, add_to_cart numeric, purchases numeric, revenue numeric,
  impressions numeric, clicks numeric, spend numeric, conversions numeric, conversion_value numeric,
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
           sum(p.impressions) as impressions, sum(p.clicks) as clicks, sum(p.spend) as spend, sum(p.conversions) as conv, sum(p.conversion_value) as val
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
         ch.kind, ch.changed_at, ch.old_value, ch.new_value
  from feed_items i
  left join d on d.item_id = i.item_id
  left join ch on ch.item_id = i.item_id
  where i.feed_id = p_feed_id and (i.removed_at is null or d.item_id is not null)
  order by coalesce(d.spend, 0) + coalesce(d.revenue, 0) desc;
end $$;
grant execute on function public.product_performance(uuid, date, date) to authenticated;

-- Nightly: the last 3 days (GA4 and conversions settle late) for every client with a feed.
create or replace function public.enqueue_product_sync(p_from date default null, p_to date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sync_queue (fn, body)
  select distinct 'product-sync', jsonb_build_object('client_id', pf.client_id,
         'date_from', coalesce(p_from, current_date - 3), 'date_to', coalesce(p_to, current_date - 1))
  from product_feeds pf where pf.enabled;
  get diagnostics n = row_count;
  return n;
end $$;

select cron.schedule('product-sync', '40 4 * * *', 'select public.enqueue_product_sync()');
