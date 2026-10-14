create or replace function public.generate_media_plan_proposal(p_client_id uuid, p_month date, p_total numeric default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_src date;
  v_prev_plan numeric;
  v_ratio numeric;
  v_total numeric;
  v_assumption text;
  v_raw_sum numeric;
  v_scale numeric;
  v_id uuid;
  v_inc text; v_cut text;
  v_month_names text[] := array['januar','februar','mart','april','maj','jun','jul','avgust','septembar','oktobar','novembar','decembar'];
begin
  -- Only agency users of the client's agency may generate.
  if not exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id() and current_user_client_id() is null) then
    raise exception 'Nemate pravo da pravite predlog za ovog klijenta';
  end if;

  -- Source month: same month last year, else two years ago.
  select m into v_src from (values ((v_month - interval '1 year')::date), ((v_month - interval '2 years')::date)) s(m)
  where exists (select 1 from media_plan_history h where h.client_id = p_client_id and h.month = s.m and h.section = 'ecomm')
  order by m desc limit 1;
  if v_src is null then
    raise exception 'Nema media plana za isti mesec prethodne dve godine — učitaj istoriju planova za ovog klijenta';
  end if;

  -- Default total: previous month's plan x average seasonal jump (this month / previous month) in past years.
  if p_total is null then
    select sum(budget_total) into v_prev_plan from media_plan_history
      where client_id = p_client_id and section = 'ecomm' and month = (v_month - interval '1 month')::date and campaign_label is not null;
    select avg(cur / nullif(prev, 0)) into v_ratio from (
      select h.month, sum(h.budget_total) cur,
        (select sum(budget_total) from media_plan_history x where x.client_id = p_client_id and x.section = 'ecomm' and x.month = (h.month - interval '1 month')::date) prev
      from media_plan_history h
      where h.client_id = p_client_id and h.section = 'ecomm' and h.month < v_month and extract(month from h.month) = extract(month from v_month)
      group by h.month) r where prev > 0;
    if v_prev_plan > 0 and v_ratio is not null then
      v_total := round(v_prev_plan * v_ratio / 1000) * 1000;
      v_assumption := format('Ukupan budžet %s je izračunat: plan za prethodni mesec (%s) × prosečan sezonski skok ovog meseca u prošlim godinama (%s).',
        to_char(v_total, 'FM999G999G999'), to_char(v_prev_plan, 'FM999G999G999'), to_char(v_ratio, 'FM0D00'));
    else
      select round(sum(coalesce(reported_spend, budget_total)) / 1000) * 1000 into v_total from media_plan_history
        where client_id = p_client_id and section = 'ecomm' and month = v_src and campaign_label not ilike 'ad hoc%';
      v_assumption := format('Ukupan budžet %s = potrošnja u istom mesecu %s (nema plana za prethodni mesec).', to_char(v_total, 'FM999G999G999'), extract(year from v_src));
    end if;
  else
    v_total := p_total;
    v_assumption := format('Ukupan budžet %s je zadat ručno.', to_char(v_total, 'FM999G999G999'));
  end if;

  select sum(c.last_spend * c.factor) into v_raw_sum from proposal_candidates(p_client_id, v_src, v_month) c;
  if coalesce(v_raw_sum, 0) = 0 then raise exception 'Nema linija sa potrošnjom u izvornom mesecu'; end if;
  v_scale := (v_total * 0.97) / v_raw_sum;  -- 3% stays as ad hoc reserve

  select string_agg(t.campaign_label, ', ') into v_inc
    from (select c.campaign_label from proposal_candidates(p_client_id, v_src, v_month) c
          where c.last_spend * c.factor * v_scale > c.last_spend
          order by c.last_spend * c.factor * v_scale - c.last_spend desc limit 3) t;
  select string_agg(c.campaign_label, ', ') into v_cut from proposal_candidates(p_client_id, v_src, v_month) c where c.factor = 0;

  -- One proposal per client + month: regenerating overwrites its header and archives its old lines.
  insert into media_plan_proposals (client_id, month, title, assumption, summary, checks, status)
  values (p_client_id, v_month,
    format('Predlog za %s %s', v_month_names[extract(month from v_month)::int], extract(year from v_month)),
    v_assumption,
    array_remove(array[
      format('Predlog je napravljen automatski iz media plana za %s %s i rezultata koje je PPC tim upisao po liniji.', v_month_names[extract(month from v_src)::int], extract(year from v_src)),
      'Pravila: ROAS od 15 naviše ×1,25; od 5 do 15 isto; od 2 do 5 ×0,8; ispod 2 warm-up/awareness/traffic na pola, ostalo se gasi. Zatim se sve skalira na ukupan budžet, a 3% po mreži ide u ad hoc rezervu.',
      case when v_inc is not null then 'Najveća povećanja: ' || v_inc || '.' end,
      case when v_cut is not null then 'Gasi se (ROAS ispod 2): ' || v_cut || '.' end
    ], null),
    '[{"text":"Potvrditi ukupan budžet sa klijentom","done":false},{"text":"Pregledati linije i datume akcija za ovaj mesec","done":false},{"text":"Dodati nove akcije kojih nije bilo prošle godine","done":false}]'::jsonb,
    'automatski predlog')
  on conflict (client_id, month) do update set title = excluded.title, assumption = excluded.assumption, summary = excluded.summary,
    checks = excluded.checks, status = excluded.status
  returning id into v_id;

  update media_plan_proposal_lines set archived = true where proposal_id = v_id and not archived;

  insert into media_plan_proposal_lines (proposal_id, client_id, sort, network, flight_type, ad_set_type, campaign_label, start_date, end_date, last_year_spend, proposed_budget, rationale)
  select v_id, p_client_id, c.sort, c.network, c.flight_type, c.ad_set_type, c.campaign_label, c.start_date, c.end_date, round(c.last_spend),
    round(c.last_spend * c.factor * v_scale / 50) * 50, c.note
  from proposal_candidates(p_client_id, v_src, v_month) c;

  -- Ad hoc reserve per network = that network's share of the 3%.
  insert into media_plan_proposal_lines (proposal_id, client_id, sort, network, flight_type, campaign_label, last_year_spend, proposed_budget, rationale)
  select v_id, p_client_id, 1000 + row_number() over (), c.network, 'Flight', 'Ad hoc rezerva', 0,
    round(sum(c.last_spend * c.factor) * v_scale * 0.03 / 0.97 / 50) * 50, '3% rezerve za akcije van plana'
  from proposal_candidates(p_client_id, v_src, v_month) c group by c.network having sum(c.last_spend * c.factor) > 0;

  return v_id;
end $$;