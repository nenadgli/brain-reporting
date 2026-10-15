-- Meta po proizvodu. product-sync stores Meta catalog ads per product (spend, impressions, clicks,
-- purchases and purchase value as Meta attributes them) in their own table. Meta returns the product
-- as "ID, title" with the title in the market's language, so a row belongs to the feed whose product
-- has that id and title. The product and segment views add these next to the Google Ads columns.

create table if not exists public.product_daily_meta (
  client_id uuid not null references public.clients(id) on delete cascade,
  report_date date not null,
  market text not null,
  item_id text not null,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  spend numeric not null default 0,
  purchases numeric not null default 0,
  purchase_value numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (client_id, report_date, market, item_id)
);
alter table public.product_daily_meta enable row level security;
create policy "agency product meta read" on public.product_daily_meta for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select on public.product_daily_meta to authenticated;

-- Meta results per product of a feed in a period.
create or replace function public.product_meta_items(p_feed_id uuid, p_from date, p_to date)
returns table (item_id text, impressions numeric, clicks numeric, spend numeric, purchases numeric, purchase_value numeric)
language plpgsql stable security definer set search_path = public as $$
declare f record;
begin
  select pf.id, pf.client_id, pf.market into f from product_feeds pf where pf.id = p_feed_id;
  if f.id is null then return; end if;
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = f.client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'product_meta_items: not allowed';
  end if;
  return query
  select m.item_id, sum(m.impressions), sum(m.clicks), round(sum(m.spend), 2), round(sum(m.purchases), 2), round(sum(m.purchase_value), 2)
  from product_daily_meta m
  where m.client_id = f.client_id and m.market = f.market and m.report_date between p_from and p_to
  group by 1;
end $$;
grant execute on function public.product_meta_items(uuid, date, date) to authenticated;

-- Meta results per segment of one dimension in a period.
create or replace function public.feed_segments_meta(p_feed_id uuid, p_dim text, p_from date, p_to date)
returns table (value text, spend numeric, purchases numeric, purchase_value numeric)
language plpgsql stable security definer set search_path = public as $$
declare f record;
begin
  select pf.id, pf.client_id, pf.market into f from product_feeds pf where pf.id = p_feed_id;
  if f.id is null then return; end if;
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = f.client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'feed_segments_meta: not allowed';
  end if;
  return query
  select feed_dim(i, p_dim), round(sum(m.spend), 2), round(sum(m.purchases), 2), round(sum(m.purchase_value), 2)
  from product_daily_meta m join feed_items i on i.feed_id = p_feed_id and i.item_id = m.item_id
  where m.client_id = f.client_id and m.market = f.market and m.report_date between p_from and p_to
  group by 1;
end $$;
grant execute on function public.feed_segments_meta(uuid, text, date, date) to authenticated;
