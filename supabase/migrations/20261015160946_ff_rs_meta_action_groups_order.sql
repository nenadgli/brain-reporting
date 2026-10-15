-- "Meta akcije awareness" must come right after "Meta akcije", before the general "Meta awareness" group (first match wins).
update public.review_settings
set params = jsonb_set(params, '{campaign_groups}', (
  select jsonb_agg(g order by case when g->>'name' = 'Meta akcije awareness'
                                   then (select j from jsonb_array_elements(params->'campaign_groups') with ordinality y(h, j) where h->>'name' = 'Meta akcije') + 0.5
                                   else i end)
  from jsonb_array_elements(params->'campaign_groups') with ordinality x(g, i)))
where client_id = (select id from public.clients where name = 'Fashion&Friends RS');
