-- Daily snapshot of what the team checks by hand in the account UIs: Google campaign daily budgets
-- and bidding targets (for "Optimizacija dnevnih budžeta i tROAS-a") and the Meta account spending
-- limit (for "Provera limita"). Filled by account-settings-sync from the daily queue.

create table if not exists public.google_campaign_settings (
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id),
  snapshot_date date not null,
  campaign_id text not null,
  campaign text not null,
  campaign_status text,
  daily_budget numeric,
  budget_type text,
  budget_shared boolean,
  bidding_strategy_type text,
  target_roas numeric,
  target_cpa numeric,
  created_at timestamptz not null default now(),
  primary key (client_id, snapshot_date, campaign_id)
);
create table if not exists public.meta_account_limits (
  client_id uuid not null references clients(id) on delete cascade,
  data_source_id uuid references data_sources(id),
  snapshot_date date not null,
  account_id text not null,
  account_name text,
  currency text,
  account_status text,
  spend_cap numeric,
  amount_spent numeric,
  balance numeric,
  created_at timestamptz not null default now(),
  primary key (client_id, snapshot_date, account_id)
);
alter table public.google_campaign_settings enable row level security;
alter table public.meta_account_limits enable row level security;
create policy "agency campaign settings read" on public.google_campaign_settings for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
create policy "agency meta limits read" on public.meta_account_limits for select using (
  current_user_client_id() is null and client_id in (select id from clients where agency_id = current_user_agency_id()));
grant select on public.google_campaign_settings, public.meta_account_limits to authenticated;

-- The daily queue also takes the settings snapshot (once per client, after the metric pulls).
create or replace function public.enqueue_daily_sync(p_preset text default 'last_14d')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into sync_queue (fn, body)
  select j.fn, j.body from (
    select distinct on (c.client_id, f.fn) f.fn,
           case when f.fn = 'windsor-sync' then jsonb_build_object('client_id', c.client_id, 'date_preset', 'last_7d')
                when f.fn = 'ga4-sync' then jsonb_build_object('client_id', c.client_id, 'date_preset', p_preset, 'store', cl.ga4_store)
                else jsonb_build_object('client_id', c.client_id, 'date_preset', p_preset) end as body,
           c.client_id, f.ord
    from (select distinct client_id, provider from data_sources) c
    join clients cl on cl.id = c.client_id
    join (values
      ('windsor-sync', null, 0),
      ('google-ads-sync', 'google_ads', 1), ('google-ads-keywords-sync', 'google_ads', 2),
      ('google-ads-search-terms-sync', 'google_ads', 3), ('google-ads-competitors-sync', 'google_ads', 4),
      ('google-granular-sync', 'google_ads', 5),
      ('facebook-ads-sync', 'facebook', 1), ('facebook-ads-placements-sync', 'facebook', 2),
      ('facebook-ads-creatives-sync', 'facebook', 3), ('meta-adset-sync', 'facebook', 4),
      ('ga4-sync', 'ga4', 6),
      ('account-settings-sync', null, 7)
    ) as f(fn, provider, ord) on (f.provider is null or f.provider = c.provider)
    where f.fn <> 'ga4-sync' or cl.ga4_store is not null
    order by c.client_id, f.fn
  ) j
  order by j.ord, j.client_id;
  get diagnostics n = row_count;
  return n;
end $$;
