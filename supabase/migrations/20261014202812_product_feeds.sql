-- Praćenje product feeda. feed-sync downloads each client's feed on its interval and records every
-- change per product: new, gone (out of stock: the feed lists only products in stock), back, price
-- up/down, sale start/end, title and custom label changes. A feed that suddenly shrinks by more than
-- half is treated as broken and marks nothing as gone. Later steps join feed_items with GA4 and ad
-- platform results by item id.

create table if not exists public.product_feeds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  market text not null,
  url text not null,
  interval_hours int not null default 4 check (interval_hours between 1 and 24),
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_status text,
  last_error text,
  last_hash text,
  created_at timestamptz not null default now(),
  unique (client_id, market)
);

create table if not exists public.feed_items (
  feed_id uuid not null references public.product_feeds(id) on delete cascade,
  item_id text not null,
  group_id text,
  title text,
  brand text,
  category text,
  price numeric,
  sale_price numeric,
  currency text,
  availability text,
  link text,
  image text,
  labels jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (feed_id, item_id)
);
create index if not exists feed_items_group_idx on public.feed_items(feed_id, group_id);

create table if not exists public.feed_changes (
  id bigserial primary key,
  feed_id uuid not null references public.product_feeds(id) on delete cascade,
  item_id text not null,
  changed_at timestamptz not null default now(),
  kind text not null check (kind in ('new', 'removed', 'back', 'price_up', 'price_down', 'sale_start', 'sale_end', 'title', 'label', 'availability')),
  old_value text,
  new_value text
);
create index if not exists feed_changes_feed_idx on public.feed_changes(feed_id, changed_at desc);
create index if not exists feed_changes_item_idx on public.feed_changes(feed_id, item_id, changed_at desc);

create table if not exists public.feed_snapshots (
  id bigserial primary key,
  feed_id uuid not null references public.product_feeds(id) on delete cascade,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('ok', 'nepromenjen', 'osnova', 'sumnjiv', 'greska')),
  bytes int,
  items int,
  on_sale int,
  avg_discount_pct numeric,
  new_items int,
  removed_items int,
  back_items int,
  price_changes int,
  sale_changes int,
  other_changes int,
  duration_ms int,
  error text
);
create index if not exists feed_snapshots_feed_idx on public.feed_snapshots(feed_id, checked_at desc);

alter table public.product_feeds enable row level security;
alter table public.feed_items enable row level security;
alter table public.feed_changes enable row level security;
alter table public.feed_snapshots enable row level security;
create policy "agency feeds read" on public.product_feeds for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency feeds insert" on public.product_feeds for insert with check (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency feeds update" on public.product_feeds for update using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency feed items read" on public.feed_items for select using (
  feed_id in (select f.id from product_feeds f join clients c on c.id = f.client_id
              where current_user_client_id() is null and c.agency_id = current_user_agency_id()));
create policy "agency feed changes read" on public.feed_changes for select using (
  feed_id in (select f.id from product_feeds f join clients c on c.id = f.client_id
              where current_user_client_id() is null and c.agency_id = current_user_agency_id()));
create policy "agency feed snapshots read" on public.feed_snapshots for select using (
  feed_id in (select f.id from product_feeds f join clients c on c.id = f.client_id
              where current_user_client_id() is null and c.agency_id = current_user_agency_id()));
grant select, insert, update on public.product_feeds to authenticated;
grant select on public.feed_items, public.feed_changes, public.feed_snapshots to authenticated;

-- Hourly: every enabled feed whose interval has passed goes to the sync queue once.
create or replace function public.enqueue_feed_sync()
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sync_queue (fn, body)
  select 'feed-sync', jsonb_build_object('feed_id', f.id)
  from product_feeds f
  where f.enabled
    and (f.last_checked_at is null or f.last_checked_at < now() - make_interval(hours => f.interval_hours) + interval '5 minutes')
    and not exists (select 1 from sync_queue q where q.fn = 'feed-sync' and q.body->>'feed_id' = f.id::text and q.status in ('pending', 'dispatched'));
  get diagnostics n = row_count;
  return n;
end $$;

select cron.schedule('feed-sync', '7 * * * *', 'select public.enqueue_feed_sync()');

insert into public.product_feeds (client_id, market, url, interval_hours)
select c.id, 'DE', 'https://www.replayjeans.com/de/media/feed/germany_meta_product_feed.csv', 4
from public.clients c where c.name = 'Replay'
on conflict (client_id, market) do nothing;
