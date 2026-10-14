create or replace function public.fashion_rs_budget_bucket(p_campaign text, p_native_type text)
 returns text language sql immutable as $$
  select case
    when regexp_replace(p_campaign,'^LB_','') ilike 'Social%' or p_campaign ilike '%Page Likes%' then 'Social'
    when p_campaign ilike '%Ct:App%' or p_native_type ilike '%APP_INSTALLS%' then 'Loyalty'
    else 'Ecomm'
  end;
$$;