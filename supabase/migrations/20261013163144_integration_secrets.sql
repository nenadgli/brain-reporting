create table public.integration_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
-- RLS on with no policies: only the service role (Edge Functions) can read it.
alter table public.integration_secrets enable row level security;
comment on table public.integration_secrets is 'Keys for calling other projects (e.g. Feed Hub). Service role only.';