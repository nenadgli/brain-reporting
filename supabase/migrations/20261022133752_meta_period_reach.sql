-- Meta reach for a whole period (month), as Meta counts it: unique people, not a sum of daily reach.
-- Filled by facebook-ads-sync with period_reach; read by meta_reach_for in the monthly report.
create table if not exists public.meta_period_reach (
  client_id uuid not null references public.clients(id) on delete cascade,
  data_source_id uuid not null,
  level text not null check (level in ('campaign', 'adset')),
  campaign text not null,
  adset_name text not null default '',
  date_from date not null,
  date_to date not null,
  reach numeric,
  impressions numeric,
  synced_at timestamptz not null default now(),
  primary key (data_source_id, level, campaign, adset_name, date_from, date_to)
);
create index if not exists meta_period_reach_client on public.meta_period_reach(client_id, date_from, date_to);
alter table public.meta_period_reach enable row level security;
create policy "visible clients read" on public.meta_period_reach for select using (client_id in (select id from clients));
comment on table public.meta_period_reach is 'Meta reach for a whole period (month), as Meta counts it: unique people, not a sum of daily reach. Filled by facebook-ads-sync with period_reach.';
