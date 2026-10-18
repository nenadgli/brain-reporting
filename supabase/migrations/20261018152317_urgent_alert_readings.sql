-- Each hourly reading of today's spend and purchases per account, so a no-purchase alarm can tell fresh data from
-- data Windsor keeps returning unchanged (same spend to the cent hours apart), and fires only on two fresh zeros in a row.
-- Also the usual purchases per day, counted from purchase conversion actions only (Google's own conversions column
-- holds every action), refreshed once a day.
create table if not exists public.urgent_alert_readings (
  client_id uuid not null references public.clients(id) on delete cascade,
  network text not null,
  reading_date date not null,
  hour int not null,
  spend numeric not null,
  purchases numeric not null,
  created_at timestamptz not null default now(),
  primary key (client_id, network, reading_date, hour)
);
alter table public.urgent_alert_readings enable row level security;

create table if not exists public.alert_baselines (
  client_id uuid not null references public.clients(id) on delete cascade,
  network text not null,
  computed_on date not null,
  purchases_per_day numeric not null,
  primary key (client_id, network)
);
alter table public.alert_baselines enable row level security;