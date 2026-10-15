-- Competitor matching on search terms collapsed per campaign, with a LIKE prefilter before the regular expression
-- (the first version ran the expression on every daily row and did not finish within a minute).
create or replace function public.ppc_generate_changes(p_client_id uuid)
 returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare
  n int := 0;
  k int;
  m date := date_trunc('month', current_date)::date;
  snap date;
  s jsonb;
begin
  -- The nightly cron runs without a request (no JWT claims); API callers must be the service role or the agency.
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = p_client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'ppc_generate_changes: not allowed';
  end if;
  -- Access is checked above; budget_plan() checks its caller again, so it runs as the service role for
  -- the rest of this call (the nightly cron has no request at all).
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  s := coalesce((select r.params from review_settings r where r.client_id = p_client_id), '{}'::jsonb);

  update ppc_changes set status = 'isteklo'
  where client_id = p_client_id and kind = 'daily_budget' and status = 'predlog' and created_at < current_date;

  snap := (select max(x.snapshot_date) from google_campaign_settings x where x.client_id = p_client_id);

  -- All candidates in one statement. When both budget sources propose a budget for the same campaign,
  -- the team's monthly budget wins over Google's recommendation (priority 1 before 2).
  -- Ready changes only for campaigns whose group allows proposals (mode predlozi).
  insert into ppc_changes (client_id, task, kind, network, campaign, ad_group, target, match_type, old_amount, new_amount, reason, details, fingerprint, finding_id)
  with acc as (
    select sum(g.conversion_value) / nullif(sum(g.spend), 0) as roas from google_ads_metrics g
    where g.client_id = p_client_id and g.report_date > current_date - 31
  ), camp as (
    select g.campaign, sum(g.conversion_value) / nullif(sum(g.spend), 0) as roas,
           avg(g.search_lost_is_budget) filter (where g.report_date > current_date - 8) as lost
    from google_ads_metrics g where g.client_id = p_client_id and g.report_date > current_date - 31 group by 1
  ), rec as (
    select distinct on (o.campaign) o.campaign, o.recommended_budget
    from google_optimization o where o.client_id = p_client_id and o.recommended_budget is not null
      and o.snapshot_date > current_date - 3 order by o.campaign, o.snapshot_date desc
  ), st as (
    select t.campaign, lower(t.search_term) as term, sum(t.spend) as sp, sum(t.clicks) as cl
    from google_ads_search_terms t
    where t.client_id = p_client_id and t.report_date > current_date - 31
    group by 1, 2
  ), cn as (
    select lower(c.name) as name, '(^|[^a-z0-9])' || re_escape(lower(c.name)) || '($|[^a-z0-9])' as re
    from jsonb_array_elements_text(coalesce(s->'competitors', '[]'::jsonb)) c(name)
    where not exists (select 1 from jsonb_array_elements_text(coalesce(s->'brands_sold', '[]'::jsonb)) b(name) where lower(c.name) = lower(b.name))
  ), comp as (
    -- Competitors from the client's list: the team never targets them, so the competitor's name goes in as one
    -- phrase negative in every campaign where a search term with it showed up in the last 30 days.
    select st.campaign, cn.name as competitor, sum(st.sp) as sp, sum(st.cl) as cl,
           count(*) as n_terms, (array_agg(st.term order by st.sp desc))[1:5] as terms
    from st join cn on st.term like '%' || cn.name || '%' and st.term ~ cn.re
    group by 1, 2
  ), cand as (
    -- Negative keywords: terms the morning review classified for exclusion, in the campaigns they spent in.
    select 'search_terms' as task, 'negative_keyword' as kind, 'google' as network, c.campaign, null::text as ad_group,
           t->>'term' as target, 'Exact' as match_type, null::numeric as old_amount, null::numeric as new_amount,
           concat_ws(' · ', t->>'why', 'potrošeno ' || (t->>'spend') || ' za ' || (t->>'days') || ' dana, ' || (t->>'clicks') || ' klikova, 0 konverzija') as reason,
           jsonb_build_object('spend', t->'spend', 'clicks', t->'clicks', 'kind', t->'kind', 'action', f.evidence->'action') as details,
           'neg:' || c.campaign || ':' || lower(t->>'term') as fingerprint, f.id as finding_id, 1 as priority
    from review_findings f
    cross join lateral jsonb_array_elements(f.evidence->'terms') t
    cross join lateral jsonb_array_elements_text(t->'campaigns') c(campaign)
    where f.client_id = p_client_id and f.check_type = 'search_terms' and f.run_date >= current_date - 7
      and f.status in ('novo', 'odobreno') and coalesce(f.evidence->>'action', '') <> 'zadrzi'
      and campaign_group(s, 'google', c.campaign)->>'mode' = 'predlozi'
    union all
    select 'search_terms', 'negative_keyword', 'google', x.campaign, null, x.competitor, 'Phrase', null, null,
           'Konkurent „' || x.competitor || '“: tim ne gađa konkurente · ' || x.n_terms || ' termina, potrošeno ' || round(x.sp, 2) || ' za 30 dana, ' || x.cl || ' klikova',
           jsonb_build_object('spend', round(x.sp, 2), 'clicks', x.cl, 'terms', to_jsonb(x.terms), 'kind', 'konkurent', 'source', 'lista_konkurenata'),
           'neg:' || x.campaign || ':' || lower(x.competitor), null, 1
    from comp x
    where campaign_group(s, 'google', x.campaign)->>'mode' = 'predlozi'
    union all
    -- Placement exclusions (account level), written the way the Google Ads exclusion list takes them.
    select 'placements', 'placement_exclusion', 'google', null, null,
           case i->>'type' when 'MOBILE_APPLICATION' then 'mobileapp::' || (i->>'placement')
                           when 'YOUTUBE_CHANNEL' then 'youtube.com/channel/' || (i->>'placement')
                           when 'YOUTUBE_VIDEO' then 'youtube.com/video/' || (i->>'placement')
                           else i->>'placement' end,
           null, null, null,
           concat_ws(' · ', i->>'why', 'potrošeno ' || (i->>'spend') || ' za 30 dana, ' || (i->>'clicks') || ' klikova, 0 konverzija'),
           jsonb_build_object('name', i->'name', 'type', i->'type', 'spend', i->'spend', 'clicks', i->'clicks'),
           'pl:' || (i->>'placement'), f.id, 1
    from review_findings f
    cross join lateral jsonb_array_elements(f.evidence->'items') i
    where f.client_id = p_client_id and f.check_type = 'placements' and f.run_date >= current_date - 7
      and f.status in ('novo', 'odobreno') and coalesce(i->>'action', f.evidence->>'action') = 'iskljuci'
    union all
    -- Daily budgets from the monthly budgets the team entered: more than 10% away from today's budget.
    select 'optimizacija_budzeta', 'daily_budget', b.network, b.campaign, null, null, null,
           st.daily_budget, round(b.recommended_daily, 2),
           'Mesečni budžet ' || round(b.monthly_budget) || ', potrošeno ' || round(b.spent_mtd) || ', ostalo ' || b.days_left || ' dana; ravnomerno do kraja meseca',
           jsonb_build_object('monthly_budget', b.monthly_budget, 'spent_mtd', b.spent_mtd, 'days_left', b.days_left, 'roas_30d', b.roas_30d, 'source', 'mesecni_budzet'),
           'budget:' || b.network || ':' || b.campaign || ':' || current_date, null, 1
    from budget_plan(p_client_id, m) b
    left join google_campaign_settings st on b.network = 'google' and st.client_id = p_client_id and st.snapshot_date = snap and st.campaign = b.campaign
    where b.recommended_daily is not null and b.recommended_daily > 0 and coalesce(st.budget_shared, false) = false
      and (st.daily_budget is null or abs(b.recommended_daily / nullif(st.daily_budget, 0) - 1) > 0.1)
      and (b.network = 'meta' or coalesce(st.campaign_status, 'ENABLED') = 'ENABLED')
      and campaign_group(s, b.network, b.campaign)->>'mode' = 'predlozi'
    union all
    -- Google's budget recommendation, only for enabled campaigns that lose at least 10% of impressions
    -- to budget (Search) and return at least the account's ROAS in the last 30 days.
    select 'optimizacija_budzeta', 'daily_budget', 'google', r.campaign, null, null, null,
           st.daily_budget, round(r.recommended_budget, 2),
           'Google predlaže veći budžet; kampanja gubi ' || round(c.lost * 100) || '% prikazivanja zbog budžeta, ROAS 30d ' || round(c.roas, 2) || ' (nalog ' || round(a.roas, 2) || ')',
           jsonb_build_object('lost_is_budget', c.lost, 'roas_30d', c.roas, 'account_roas', a.roas, 'source', 'google_preporuka'),
           'budget:google:' || r.campaign || ':' || current_date, null, 2
    from rec r
    join google_campaign_settings st on st.client_id = p_client_id and st.snapshot_date = snap and st.campaign = r.campaign
    join camp c on c.campaign = r.campaign cross join acc a
    where st.campaign_status = 'ENABLED' and coalesce(st.budget_shared, false) = false and st.daily_budget > 0
      and r.recommended_budget > st.daily_budget * 1.05 and c.lost >= 0.1 and c.roas >= coalesce(a.roas, 0)
      and campaign_group(s, 'google', r.campaign)->>'mode' = 'predlozi'
  )
  select distinct on (x.fingerprint) p_client_id, x.task, x.kind, x.network, x.campaign, x.ad_group, x.target, x.match_type,
         x.old_amount, x.new_amount, x.reason, x.details, x.fingerprint, x.finding_id
  from cand x
  where not exists (
    select 1 from ppc_changes c where c.client_id = p_client_id and c.fingerprint = x.fingerprint
      and (c.status in ('predlog', 'odobreno', 'izvezeno', 'poslato') or (c.status = 'odbijeno' and c.decided_at > now() - interval '90 days')))
  order by x.fingerprint, x.priority;
  get diagnostics k = row_count;
  n := n + k;

  -- A whole search term ("stradivarius haljine") is no longer needed once the competitor's name is a phrase
  -- negative in the same campaign; and nothing stays proposed for campaigns the team only wants warnings for.
  update ppc_changes c set status = 'isteklo'
  where c.client_id = p_client_id and c.status = 'predlog' and c.kind = 'negative_keyword'
    and coalesce(c.details->>'source', '') <> 'lista_konkurenata'
    and exists (select 1 from ppc_changes c2
                where c2.client_id = p_client_id and c2.kind = 'negative_keyword' and c2.campaign = c.campaign
                  and c2.details->>'source' = 'lista_konkurenata' and c2.status in ('predlog', 'odobreno', 'izvezeno', 'poslato')
                  and lower(c.target) ~ ('(^|[^a-z0-9])' || re_escape(lower(c2.target)) || '($|[^a-z0-9])'));
  update ppc_changes c set status = 'isteklo'
  where c.client_id = p_client_id and c.status = 'predlog' and c.campaign is not null
    and campaign_group(s, c.network, c.campaign)->>'mode' <> 'predlozi';
  return n;
end $function$;
