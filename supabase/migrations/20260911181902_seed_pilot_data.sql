insert into agencies (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Pilot Agencija');

insert into clients (id, agency_id, name, slug) values
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Pilot Klijent', 'pilot-klijent');

insert into data_sources (client_id, provider, status) values
  ('00000000-0000-0000-0000-000000000002', 'meta_ads', 'active'),
  ('00000000-0000-0000-0000-000000000002', 'google_ads', 'active');

insert into report_metrics (client_id, report_date, channel, metric_name, metric_value)
select
  '00000000-0000-0000-0000-000000000002',
  d::date,
  channel,
  metric,
  round((random() * 500 + 50)::numeric, 2)
from generate_series(current_date - interval '13 days', current_date, interval '1 day') d
cross join (values ('meta_ads'), ('google_ads')) as c(channel)
cross join (values ('spend'), ('impressions'), ('clicks')) as m(metric);
