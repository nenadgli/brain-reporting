-- Demand Gen ad groups carry their audience by name in Editor ("Audience name", e.g. "DMG - Audience"
-- in F&F BA, Editor export 2026-10-14). The draft keeps the exported name; the client default fills the form.
alter table public.demand_gen_drafts add column if not exists audience_name text;
alter table public.client_editor_defaults add column if not exists dg_audience_name text;

insert into public.client_editor_defaults (client_id, dg_audience_name)
values ('740ea196-31b8-400c-be91-5753d84bc98b', 'DMG - Audience')
on conflict (client_id) do update set dg_audience_name = excluded.dg_audience_name;
