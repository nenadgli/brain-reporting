create or replace function fashion_rs_classify(p_campaign text, p_native_type text)
returns table(campaign_subtype text, funnel_group text, funnel_stage text)
language plpgsql immutable as $$
declare
  ct text := fashion_rs_extract_tag(p_campaign, 'Ct');
  ph text := fashion_rs_extract_tag(p_campaign, 'Ph');
begin
  if ct ilike '%Display_Dyn%' or ct ilike '%Dyn%' then
    if ph ilike 'Bof' then
      return query select 'Dynamic remarketing'::text, 'Pure Performance'::text, 'BOF'::text;
    else
      return query select 'Dynamic prospecting'::text, 'Pure Performance'::text, 'TOF'::text;
    end if;
    return;
  end if;

  if ct ilike '%Display%' then
    return query select 'Display'::text, 'Brandformance'::text, coalesce(nullif(upper(ph), ''), 'TOF')::text;
    return;
  end if;

  if ct ilike '%PMax%' or ct ilike '%Pmax%' then
    return query select 'Performance Max'::text, 'Brandformance'::text, 'Full-funnel'::text;
    return;
  end if;

  if ct ilike '%DemandGen%' or ct ilike '%Demand_Gen%' or ct ilike '%DemanGen%' then
    return query select 'Demand Gen'::text, 'Brandformance'::text, 'TOF'::text;
    return;
  end if;

  if ct ilike '%Brand_Search%' then
    return query select 'Brand Search'::text, 'Pure Performance'::text, 'BOF'::text;
    return;
  end if;

  if ct ilike '%Generic_Search%' then
    return query select 'Generic Search'::text, 'Pure Performance'::text, 'BOF'::text;
    return;
  end if;

  if ct ilike '%App%' then
    return query select 'App Install'::text, 'Brandformance'::text, 'TOF'::text;
    return;
  end if;

  if ct ilike '%Conversions%' then
    if ph ilike 'Bof' then
      return query select 'Catalog Sales (remarketing)'::text, 'Pure Performance'::text, 'BOF'::text;
    else
      return query select 'Catalog Sales (prospecting)'::text, 'Pure Performance'::text, 'TOF'::text;
    end if;
    return;
  end if;

  if ct ilike '%Traffic%' or ct ilike '%Awareness%' then
    return query select 'Reach/Traffic'::text, 'Brandformance'::text, 'TOF'::text;
    return;
  end if;

  if p_native_type ilike '%AWARENESS%' or p_native_type ilike '%LINK_CLICKS%' then
    return query select 'Reach/Traffic (legacy)'::text, 'Brandformance'::text, 'TOF'::text;
    return;
  end if;
  if p_native_type ilike '%APP_INSTALLS%' then
    return query select 'App Install (legacy)'::text, 'Brandformance'::text, 'TOF'::text;
    return;
  end if;

  return query select coalesce(p_native_type, 'Nekategorisano')::text, 'Nekategorisano'::text, 'Nepoznato'::text;
end;
$$;