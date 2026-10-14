-- Fields Editor's export of the Editus account (2026-10-14) shows on video campaigns: the responsive
-- video ad carries a business name ("Kino Film") and a display path, and the ad group often names its
-- audience ("Audience name", e.g. "Children Fantasy movie lovers"). A per-client business name default
-- serves the video and display forms.
alter table public.video_campaign_drafts add column if not exists business_name text;
alter table public.video_campaign_drafts add column if not exists path1 text;
alter table public.video_campaign_drafts add column if not exists audience_name text;
alter table public.client_editor_defaults add column if not exists business_name text;

insert into public.client_editor_defaults (client_id, business_name)
values ('d2cccb2a-5a59-4d07-98a9-b01091a28564', 'Kino Film')
on conflict (client_id) do update set business_name = excluded.business_name;
