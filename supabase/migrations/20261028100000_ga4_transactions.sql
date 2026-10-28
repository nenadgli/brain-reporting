alter table public.ga4_metrics add column if not exists transactions numeric;
comment on column public.ga4_metrics.transactions is 'GA4 transactions (purchases) - PPC team conversion definition. conversions = key events (not purchases).';
