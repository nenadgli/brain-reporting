-- Istorija: an alarm Feed Hub sent (copied into urgent_alerts by urgent-alerts) shows Feed Hub as its sender, not Brain.
create or replace function public.ppc_work_log(p_from date, p_to date, p_client_id uuid default null::uuid)
 returns table(at timestamp with time zone, client_id uuid, client_name text, task text, action text, detail text, user_email text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_user_client_id() is not null then
    raise exception 'ppc_work_log: not allowed';
  end if;
  return query
  with ev as (
    select f.decided_at as at, f.client_id, ppc_task_of_check(f.check_type) as task, f.status as action, f.title as detail, f.decided_by as uid
    from review_findings f where f.decided_at is not null and f.status in ('odobreno', 'odbijeno', 'odlozeno', 'izvrseno')
    union all
    select b.updated_at, b.client_id, 'optimizacija_budzeta', 'budzet_unet', b.network || ' · ' || b.campaign || ': ' || b.monthly_budget, b.updated_by
    from campaign_budgets b
    union all
    select a.created_at, a.client_id, a.task, a.action, coalesce(a.detail->>'text', a.detail::text), a.user_id from ppc_actions a
    union all
    select x.at, x.client_id, 'kampanje', x.action, x.detail, x.uid from (
      select d.created_at as at, d.client_id, 'nacrt' as action, 'PMax · ' || d.asset_group_name as detail, d.created_by_user as uid from pmax_asset_group_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'PMax · ' || d.asset_group_name, d.exported_by from pmax_asset_group_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'PMax · ' || d.asset_group_name, d.published_by from pmax_asset_group_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Demand Gen · ' || d.ad_group_name, d.created_by_user from demand_gen_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'Demand Gen · ' || d.ad_group_name, d.exported_by from demand_gen_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Demand Gen · ' || d.ad_group_name, d.published_by from demand_gen_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Video · ' || d.campaign_name, d.created_by_user from video_campaign_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'Video · ' || d.campaign_name, d.exported_by from video_campaign_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Video · ' || d.campaign_name, d.published_by from video_campaign_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Display · ' || d.ad_group_name, d.created_by_user from display_ad_drafts d
      union all select d.exported_at, d.client_id, 'izvezeno', 'Display · ' || d.ad_group_name, d.exported_by from display_ad_drafts d where d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Display · ' || d.ad_group_name, d.published_by from display_ad_drafts d where d.published_at is not null
      union all select d.created_at, d.client_id, 'nacrt', 'Search · ' || d.campaign_name, d.created_by_user from automation_drafts d where d.kind = 'campaign'
      union all select d.exported_at, d.client_id, 'izvezeno', 'Search · ' || d.campaign_name, d.exported_by from automation_drafts d where d.kind = 'campaign' and d.exported_at is not null
      union all select d.published_at, d.client_id, 'objavljeno', 'Search · ' || d.campaign_name, d.published_by from automation_drafts d where d.kind = 'campaign' and d.published_at is not null
    ) x
  ), ev2 as (
    select e.at, e.client_id, e.task, e.action, e.detail, e.uid, null::text as who from ev e
    union all
    select s.sent_at, s.client_id, 'hitni_alarmi', 'alarm_poslat', s.text, null::uuid, coalesce(s.payload->>'sender', 'Brain') from urgent_alerts s where s.sent_at is not null and s.kind <> 'test'
    union all
    select s.taken_at, s.client_id, 'hitni_alarmi', 'alarm_preuzet', s.text, null::uuid, s.taken_by from urgent_alerts s where s.taken_at is not null and s.kind <> 'test'
    union all
    select s.resolved_at, s.client_id, 'hitni_alarmi', 'alarm_resen', s.text, null::uuid, s.resolved_by from urgent_alerts s where s.resolved_at is not null and s.resolved_by is not null and s.kind <> 'test'
    union all
    select coalesce(s.resolved_at, s.taken_at, s.sent_at), s.client_id, 'hitni_alarmi', 'lazna_uzbuna', s.text, null::uuid, s.false_alarm_by from urgent_alerts s where s.false_alarm_by is not null and s.kind <> 'test'
  )
  select ev.at, ev.client_id, c.name, ev.task, ev.action, ev.detail, coalesce(u.email, ev.who)
  from ev2 ev
  left join clients c on c.id = ev.client_id
  left join app_users u on u.id = ev.uid
  where ev.at >= p_from and ev.at < p_to + 1
    and (p_client_id is null or ev.client_id = p_client_id)
    and (ev.client_id is null or c.agency_id = coalesce(current_user_agency_id(), c.agency_id))
  order by ev.at desc;
end $function$;