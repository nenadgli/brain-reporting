-- Reach for the whole ad account and a whole period (normally a month): one figure per account, deduplicated by the platform
-- (the "Total" row in Ads Manager / Google Ads). Windsor asked with no dimension returns exactly one row.
-- Filled by facebook-ads-sync / google-ads-sync in period_reach mode (the same morning crons as campaign reach).
create table if not exists public.account_period_reach (
  client_id uuid not null references public.clients(id) on delete cascade,
  data_source_id uuid not null references public.data_sources(id) on delete cascade,
  platform text not null check (platform in ('meta', 'google')),
  date_from date not null,
  date_to date not null,
  reach numeric,
  impressions numeric,
  synced_at timestamptz not null default now(),
  primary key (data_source_id, date_from, date_to)
);
alter table public.account_period_reach enable row level security;
create policy "visible clients read" on public.account_period_reach for select using (client_id in (select id from clients));

-- Monthly reach per client and platform: the latest stored period starting on the 1st (the whole month once it is over).
create or replace function public.account_month_reach(p_client_id uuid, p_month date)
returns table (platform text, date_from date, date_to date, reach numeric, impressions numeric, frequency numeric)
language sql stable security invoker set search_path = public as $function$
  -- More than one account of a platform: their figures are added (different accounts, no overlap to remove).
  select r.platform, r.date_from, r.date_to, sum(r.reach), sum(r.impressions), round(sum(r.impressions) / nullif(sum(r.reach), 0), 2)
  from account_period_reach r
  where r.client_id = p_client_id and r.date_from = date_trunc('month', p_month)::date
    and r.date_to = (select max(x.date_to) from account_period_reach x where x.data_source_id = r.data_source_id and x.date_from = r.date_from)
  group by 1, 2, 3
$function$;
