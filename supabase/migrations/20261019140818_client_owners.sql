-- Who owns which client, per network (the PPC team's split, 19.10.2026): params.owners = { google: email, meta: email }.
-- Danas shows each person their own clients first, and Slack alarms tag the owner of the network instead of @channel.
with o(client, google, meta) as (values
  ('Fashion&Friends RS', 'aleksandar.ilic@loft19.co', 'jelena@loft19.co'),
  ('Fashion&Friends HR', 'jelena@loft19.co', 'aleksandar.ilic@loft19.co'),
  ('Fashion&Friends BA', 'jelena@loft19.co', 'aleksandra@loft19.co'),
  ('Fashion&Friends ME', 'jelena@loft19.co', 'aleksandra@loft19.co'),
  ('Fashion&Friends AL', null, 'aleksandra@loft19.co'),
  ('Fashion&Friends SI', 'aleksandar.ilic@loft19.co', 'aleksandra@loft19.co'),
  ('XYZ RS', 'aleksandra@loft19.co', 'aleksandra@loft19.co'),
  ('XYZ HR', 'aleksandra@loft19.co', 'aleksandra@loft19.co'),
  ('XYZ ME', 'aleksandra@loft19.co', 'aleksandra@loft19.co'),
  ('Movem', 'aleksandra@loft19.co', 'aleksandra@loft19.co'),
  ('Salamander HR', 'aleksandra@loft19.co', 'aleksandra@loft19.co'),
  ('Planika BA', 'aleksandra@loft19.co', 'aleksandra@loft19.co'),
  ('Remiks', 'aleksandar.ilic@loft19.co', 'aleksandra@loft19.co'),
  ('Replay JV RS', 'aleksandar.ilic@loft19.co', 'aleksandar.ilic@loft19.co'),
  ('Marera Facility Management', 'aleksandar.ilic@loft19.co', 'aleksandar.ilic@loft19.co'),
  ('Desk&More', 'aleksandar.ilic@loft19.co', 'aleksandar.ilic@loft19.co'),
  ('Editus', 'aleksandar.ilic@loft19.co', 'aleksandar.ilic@loft19.co'),
  ('Replay', 'boris.peric@loft19.co', 'boris.peric@loft19.co')
)
update public.review_settings rs
set params = coalesce(rs.params, '{}'::jsonb) || jsonb_build_object('owners', jsonb_strip_nulls(jsonb_build_object('google', o.google, 'meta', o.meta)))
from o join public.clients c on c.name = o.client
where rs.client_id = c.id;