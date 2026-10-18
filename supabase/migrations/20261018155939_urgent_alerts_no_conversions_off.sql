-- The team does not want the "0 purchases today" alarm in #ppc-alarm any more: no hours left for it, for every client.
-- Budget (Google and Meta) and landing page alarms stay on.
update public.review_settings
set params = jsonb_set(params, '{alerts,no_conv_hours}', '[]'::jsonb)
where params ? 'alerts';