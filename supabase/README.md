# Supabase

Source of the Brain database schema and the Edge Functions deployed to Supabase. The deployed version is what runs; keep this folder in sync when you deploy.

- `functions/` — Brain project `yryclxxuueupuruowjvn`. `config.toml` holds each function's `verify_jwt`.
- `feedhub/functions/` — the two Feed Hub (`bagpjjejeuteojpsufto`) functions that Brain uses:
  `export-campaign-briefs` (Productive briefs, attachments, on-demand refresh) and `productive-file`
  (streams Productive attachments through signed links). The rest of Feed Hub is not in this repo.

Deploy one function:

```
supabase functions deploy morning-review --project-ref yryclxxuueupuruowjvn
cd supabase/feedhub && supabase functions deploy export-campaign-briefs --project-ref bagpjjejeuteojpsufto
```

Secrets are set in the Supabase dashboard, never in this repo:

| Project | Secret | Used by |
| --- | --- | --- |
| Brain | `WINDSOR_API_KEY` | all `*-sync` functions |
| Brain | `ANTHROPIC_API_KEY` | `productive-briefs`, `morning-review` (and `chat`, `suggest-campaign`) |
| Feed Hub | `PRODUCTIVE_API_TOKEN`, `PRODUCTIVE_ORGANIZATION_ID` | `export-campaign-briefs`, `productive-file` |

Keys shared between functions live in database tables with RLS and no policies (service role only):
Brain `integration_secrets` (`feedhub_briefs_key`, `review_cron_key`), Feed Hub `external_api_keys` (hash of the Brain key)
and `internal_secrets` (`productive_file_signing_key`).

Scheduling is done with pg_cron in the Brain database: `daily-windsor-sync` (04:00 UTC, fills `sync_queue`,
including `account-settings-sync` for budgets, bidding targets and Meta spend caps),
`weekly-placements-sync` (Monday 04:30 UTC, `placements-sync` for the last 30 days),
`dispatch-sync-queue` (every minute, 15 jobs at a time) and `morning-review` (05:00 UTC, queues one
review per client in `review_settings`; the dispatcher adds the internal key for those jobs).
On Mondays the review also runs the weekly account check (`weekly_candidates`: disapproved ads,
optimization score and recommendations, placements without conversions, GA4 traffic without a source).
`daily-sync` is kept for manual runs only; called for all clients at once it hits Supabase's per-trace rate limit.

## Database migrations

`migrations/` holds every migration applied to the Brain database, exported from
`supabase_migrations.schema_migrations` and checked byte for byte (md5) against what was applied.
Apply new schema changes as a migration and add the file here; changes made with plain SQL in the
dashboard are not reproducible. Data (clients, media plans, synced metrics) and secret values are not
in the migrations.

Known differences between the database and the migrations:

- `public._mpl_stage` is a leftover staging table from a media-plan import (RLS on, no access). It is not
  in any migration and can be dropped: `drop table public._mpl_stage;`
- Feed Hub schema changes made for Brain (`productive_task_attachments`, `internal_secrets`,
  `external_api_keys`, the `productive-attachments` bucket) live in the Feed Hub project's own migration history.
