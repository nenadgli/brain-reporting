-- Existing PMax campaigns of a client with their asset groups, for the asset group draft form.
-- security invoker: RLS on google_asset_group_metrics decides what the caller sees.
create or replace function public.pmax_campaigns(p_client_id uuid)
returns table (campaign text, last_date date, spend_30d numeric, asset_groups text[])
language sql stable security invoker set search_path = public as $$
  select a.campaign,
         max(a.report_date) as last_date,
         round(coalesce(sum(a.spend) filter (where a.report_date > current_date - 30), 0)) as spend_30d,
         array_agg(distinct a.asset_group_name order by a.asset_group_name) as asset_groups
  from google_asset_group_metrics a
  where a.client_id = p_client_id and a.report_date > current_date - 180
  group by a.campaign
  order by max(a.report_date) desc, 3 desc
$$;
grant execute on function public.pmax_campaigns(uuid) to authenticated;