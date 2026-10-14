-- Audience signal for new PMax asset groups. New asset groups otherwise go out without one and the
-- team copies it in Editor. Values use Google Ads Editor's own columns and formats (lists separated
-- by ";"), as in Editor's export of a PMax campaign; a client default fills the form, the draft keeps
-- what was exported.

create table if not exists public.client_editor_defaults (
  client_id uuid primary key references public.clients(id) on delete cascade,
  pmax_audience jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.client_editor_defaults enable row level security;
create policy "agency editor defaults read" on public.client_editor_defaults for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency editor defaults insert" on public.client_editor_defaults for insert with check (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency editor defaults update" on public.client_editor_defaults for update using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select, insert, update on public.client_editor_defaults to authenticated;

alter table public.pmax_asset_group_drafts add column if not exists audience jsonb not null default '{}';

-- F&F BA, from the asset group "Main 2" in BTS(Mkt:BA;Ct:PMax) (Editor export 2026-10-14).
insert into public.client_editor_defaults (client_id, pmax_audience)
select c.id, jsonb_build_object(
  'Remarketing audience segments', 'Purchasers of Fashion and Friends GA4 (Web + Apps for All Markets)',
  'Interest categories', 'Apparel & Accessories;Apparel & Accessories>Activewear;Apparel & Accessories>Men''s Apparel;Apparel & Accessories>Shoes;Apparel & Accessories>Women''s Apparel;Apparel & Accessories>Shoes>Dress Shoes;Apparel & Accessories>Socks;Apparel & Accessories>Pants;Apparel & Accessories>Shirts & Tops;Shoppers>Luxury Shoppers')
from public.clients c where c.id = '740ea196-31b8-400c-be91-5753d84bc98b'
on conflict (client_id) do nothing;
