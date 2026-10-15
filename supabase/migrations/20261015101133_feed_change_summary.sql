-- "Šta se promenilo u feedu": changes per day, segment (category, price band, discount...) and kind,
-- with the average price change in percent and the products, so the team reads "Hosen: 45 cheaper by
-- 18% on average, 12 new, 8 removed" instead of a raw log.

create or replace function public.feed_change_summary(p_feed_id uuid, p_dim text, p_from date, p_to date)
returns table (day date, value text, kind text, n int, avg_pct numeric, items jsonb)
language plpgsql stable security definer set search_path = public as $$
declare f record;
begin
  select pf.id, pf.client_id into f from product_feeds pf where pf.id = p_feed_id;
  if f.id is null then return; end if;
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and not (current_user_client_id() is null
              and exists (select 1 from clients c where c.id = f.client_id and c.agency_id = current_user_agency_id())) then
    raise exception 'feed_change_summary: not allowed';
  end if;
  return query
  with x as (
    select c.changed_at::date as day, feed_dim(i, p_dim) as value, c.kind, c.item_id, i.title, c.old_value, c.new_value,
           case when c.kind in ('price_up', 'price_down', 'sale_start', 'sale_end') and c.old_value ~ '^[0-9.]+$' and c.new_value ~ '^[0-9.]+$'
                     and c.old_value::numeric > 0
                then round((c.new_value::numeric / c.old_value::numeric - 1) * 100, 1) end as pct
    from feed_changes c join feed_items i on i.feed_id = c.feed_id and i.item_id = c.item_id
    where c.feed_id = p_feed_id and c.changed_at::date between p_from and p_to
  )
  select x.day, x.value, x.kind, count(*)::int, round(avg(x.pct), 1),
         (jsonb_agg(jsonb_build_object('item_id', x.item_id, 'title', x.title, 'old', x.old_value, 'new', x.new_value, 'pct', x.pct)
                    order by abs(coalesce(x.pct, 0)) desc, x.item_id))
  from x group by x.day, x.value, x.kind
  order by x.day desc, count(*) desc;
end $$;
grant execute on function public.feed_change_summary(uuid, text, date, date) to authenticated;
