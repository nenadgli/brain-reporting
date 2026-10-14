# Supabase

Source of the Edge Functions deployed to Supabase. The deployed version is what runs; keep this folder in sync when you deploy.

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

Scheduling is done with pg_cron in the Brain database: `daily-windsor-sync` (04:00 UTC, fills `sync_queue`),
`dispatch-sync-queue` (every minute, 15 jobs at a time) and `morning-review` (05:00 UTC).
`daily-sync` is kept for manual runs only; called for all clients at once it hits Supabase's per-trace rate limit.
