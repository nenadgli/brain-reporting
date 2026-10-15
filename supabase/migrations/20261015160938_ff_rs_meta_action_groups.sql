-- Meta actions with the Conversions objective are judged by ROAS; awareness actions (e.g. "Akcija_-20% ... Ct:Awareness")
-- stay in proposals mode but without a ROAS minimum, since they are measured by reach, CPM and CTR.
update public.review_settings
set params = jsonb_set(params, '{campaign_groups}', (
  select jsonb_agg(case
      when g->>'name' = 'Meta akcije' then g || jsonb_build_object('pattern', '^(ADV_Akcije|Akcija).*Ct:Conversions')
      else g end
    order by i)
  || jsonb_build_array(jsonb_build_object('name', 'Meta akcije awareness', 'network', 'meta', 'pattern', '^(ADV_Akcije|Akcija)', 'mode', 'predlozi', 'purpose', 'Akcija, awareness (meri se doseg, CPM i CTR)'))
  from jsonb_array_elements(params->'campaign_groups') with ordinality x(g, i)))
where client_id = (select id from public.clients where name = 'Fashion&Friends RS');
