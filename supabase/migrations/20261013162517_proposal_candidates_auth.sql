create or replace function public.proposal_candidates(p_client_id uuid, p_src date, p_month date)
returns table (sort bigint, network text, flight_type text, ad_set_type text, campaign_label text, start_date date, end_date date, last_spend numeric, roas numeric, factor numeric, note text)
language sql stable security definer set search_path = public as $$
  with c as (
    select h.*, coalesce(h.reported_spend, h.budget_total) as spend,
      case when coalesce(h.reported_spend, 0) > 0 then coalesce(h.reported_revenue, 0) / h.reported_spend end as r,
      h.campaign_label ~* '(warm.?up|awareness|add to cart|atc|traffic|teaser)' as builds_audience,
      extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::int as last_day
    from media_plan_history h
    where h.client_id = p_client_id and h.month = p_src and h.section = 'ecomm'
      and h.campaign_label is not null and h.campaign_label not ilike 'ad hoc%'
      and coalesce(h.reported_spend, h.budget_total) > 0
      -- callers see only clients of their own agency, like the table's RLS
      and exists (select 1 from clients cl where cl.id = p_client_id and cl.agency_id = current_user_agency_id()
                  and (current_user_client_id() is null or cl.id = current_user_client_id())))
  select row_number() over (order by case c.network when 'google' then 1 when 'meta' then 2 when 'programmatic' then 3 else 4 end, c.spend desc),
    c.network, c.flight_type, c.ad_set_type, c.campaign_label,
    case when c.start_date is null then null else make_date(extract(year from p_month)::int, extract(month from p_month)::int, least(extract(day from c.start_date)::int, c.last_day)) end,
    case when c.end_date is null then null else make_date(extract(year from p_month)::int, extract(month from p_month)::int, least(extract(day from c.end_date)::int, c.last_day)) end,
    c.spend, c.r,
    case when c.r is null then 1 when c.r >= 15 then 1.25 when c.r >= 5 then 1 when c.r >= 2 then 0.8 when c.builds_audience then 0.5 else 0 end,
    case when c.r is null then 'Nema prihoda u izveštaju; zadržano'
      else format('ROAS %s (%s) → ×%s', to_char(c.r, 'FM9990D0'), extract(year from p_src),
        case when c.r >= 15 then '1,25' when c.r >= 5 then '1' when c.r >= 2 then '0,8' when c.builds_audience then '0,5 (gradi publiku)' else '0 (gasi se)' end) end
  from c
$$;