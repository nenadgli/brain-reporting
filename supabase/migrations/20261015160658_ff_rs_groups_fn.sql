-- Phase 1 for Fashion&Friends RS, from the PPC team's answers (Jutarnji pregled — šta nam treba od PPC tima):
-- campaign groups with what Brain may do in each, ROAS from GA4, pacing by end-of-month projection
-- (the plan is not spent evenly), a 30-day cooldown for decided findings and competitor negatives.

-- The first group from review_settings.params.campaign_groups whose network and pattern match the campaign.
-- mode: predlozi (findings and ready changes) | upozorenja (findings only) | ne_dirati (left out).
create or replace function public.campaign_group(p_params jsonb, p_network text, p_campaign text)
returns jsonb language sql immutable as $$
  select coalesce(
    (select g from jsonb_array_elements(coalesce(p_params->'campaign_groups', '[]'::jsonb)) with ordinality x(g, i)
     where (g->>'network' is null or g->>'network' = p_network) and p_campaign ~ (g->>'pattern')
     order by i limit 1),
    '{"name": null, "mode": "predlozi"}'::jsonb)
$$;

-- A literal for use inside a regular expression ("pull&bear", "levi's" stay as they are; ".", "(" are escaped).
create or replace function public.re_escape(p text)
returns text language sql immutable as $$
  select regexp_replace(p, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')
$$;
