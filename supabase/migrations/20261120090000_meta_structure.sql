-- Meta structure snapshot (phase 1 of the Meta builder): every ad that delivered in the window, with its campaign and ad set
-- settings and ids, as Windsor returns them (ads insights fields). Filled by facebook-ads-sync with body.structure; each run
-- replaces the rows of that data source. Read only: nothing is written to Meta.
create table if not exists public.meta_structure (
  client_id uuid not null references public.clients(id) on delete cascade,
  data_source_id uuid not null references public.data_sources(id) on delete cascade,
  account_id text not null,
  campaign_id text, campaign text, campaign_status text, campaign_objective text,
  campaign_daily_budget numeric, campaign_lifetime_budget numeric, campaign_bid_strategy text,
  campaign_start_time timestamptz, campaign_stop_time timestamptz,
  adset_id text, adset_name text, adset_status text,
  adset_daily_budget numeric, adset_lifetime_budget numeric, adset_bid_strategy text,
  adset_optimization_goal text, adset_billing_event text, adset_start_time timestamptz, adset_end_time timestamptz,
  adset_targeting jsonb, adset_promoted_object jsonb, adset_attribution_spec jsonb,
  ad_id text not null, ad_name text, ad_status text, creative_id text, url_tags text, link_url text,
  spend numeric, window_from date, window_to date,
  synced_at timestamptz not null default now(),
  primary key (data_source_id, ad_id)
);
create index if not exists meta_structure_adset on public.meta_structure (client_id, adset_id);
alter table public.meta_structure enable row level security;
create policy "visible clients read" on public.meta_structure for select using (client_id in (select id from clients));

-- One row per ad set (budgets in EUR; Meta returns minor units, i.e. cents).
create or replace view public.meta_adsets with (security_invoker = true) as
select distinct on (s.client_id, s.adset_id)
  s.client_id, c.name as client, s.account_id, s.campaign_id, s.campaign, s.campaign_status, s.campaign_objective,
  s.campaign_daily_budget / 100 as campaign_daily_eur, s.campaign_lifetime_budget / 100 as campaign_lifetime_eur, s.campaign_bid_strategy,
  (coalesce(s.campaign_daily_budget, 0) + coalesce(s.campaign_lifetime_budget, 0)) > 0 as cbo,
  s.adset_id, s.adset_name, s.adset_status, s.adset_daily_budget / 100 as adset_daily_eur, s.adset_lifetime_budget / 100 as adset_lifetime_eur,
  s.adset_bid_strategy, s.adset_optimization_goal, s.adset_start_time, s.adset_end_time,
  s.adset_promoted_object, s.adset_attribution_spec, s.adset_targeting,
  (select count(*) from meta_structure x where x.data_source_id = s.data_source_id and x.adset_id = s.adset_id) as ads,
  (select round(sum(x.spend), 2) from meta_structure x where x.data_source_id = s.data_source_id and x.adset_id = s.adset_id) as spend,
  (select string_agg(distinct x.url_tags, ' || ') from meta_structure x where x.data_source_id = s.data_source_id and x.adset_id = s.adset_id) as url_tags,
  s.window_from, s.window_to, s.synced_at
from meta_structure s join clients c on c.id = s.client_id
order by s.client_id, s.adset_id, s.spend desc nulls last;
