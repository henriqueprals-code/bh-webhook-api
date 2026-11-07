begin;

create table public.bryx_meta_purchase_deliveries (
  user_id uuid not null,
  root_order_code text not null,
  order_code text not null,
  event_id text not null unique,
  state text not null default 'sending'
    check (state in ('sending', 'accepted', 'review')),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  response_status integer,
  primary key (user_id, root_order_code)
);

alter table public.bryx_meta_purchase_deliveries enable row level security;
revoke all on public.bryx_meta_purchase_deliveries from public, anon, authenticated;
grant select, insert, update on public.bryx_meta_purchase_deliveries to service_role;

create function public.bryx_claim_master_purchase(
  p_order_code text,
  p_start_at timestamptz
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  purchase record;
  root_code text;
  purchase_id text;
begin
  if p_start_at is null or p_start_at > now() then
    return null;
  end if;

  -- Usa a mesma trava da recepção Logzz durante a checagem do vínculo.
  perform pg_advisory_xact_lock(hashtextextended('bryx-logzz:master', 0));

  select l.user_id, l.completed_at, o.total, origin.click_id
    into purchase
  from public.bryx_memberships m
  join public.bryx_connect_order_links l
    on l.user_id = m.user_id and l.order_code = p_order_code
  join public.orders o on o.id = l.order_code
  join public.bryx_connect_checkouts checkout
    on checkout.user_id = l.user_id and checkout.id = l.checkout_id
  join public.bryx_connect_origins origin
    on origin.user_id = checkout.user_id and origin.id = checkout.origin_id
    and origin.lead_id = checkout.lead_id
  join public.bryx_connect_leads lead
    on lead.user_id = checkout.user_id and lead.id = checkout.lead_id
  join public.bryx_connect_connections connection
    on connection.user_id = lead.user_id and connection.id = lead.connection_id
  where m.operation_slug = 'master'
    and m.active
    and (select count(*) from public.bryx_memberships where operation_slug = 'master') = 1
    and l.attribution_status = 'linked'
    and l.replaced_by_order is null
    and l.completed_at >= greatest(p_start_at, now() - interval '7 days')
    and l.completed_at <= now()
    and lower(btrim(o.status)) = 'completo'
    and o.user_id::text = '516f255c-5b2a-4706-a0a9-d662c59c19b0'
    and o.total > 0 and o.total < 'Infinity'::numeric
    and nullif(btrim(origin.click_id), '') is not null
    and connection.id = '862f625e-9835-4f95-ba85-ea2672a54bb1'
    and connection.deleted_at is null;

  if not found then
    return null;
  end if;

  -- Só segue substituições confirmadas nos dois sentidos. Ciclos e
  -- recriações sem vínculo confirmado ficam fora do envio automático.
  with recursive lineage as (
    select l.order_code, l.replaces_order, l.is_recreated
    from public.bryx_connect_order_links l
    where l.user_id = purchase.user_id and l.order_code = p_order_code
    union
    select previous.order_code, previous.replaces_order, previous.is_recreated
    from lineage current_link
    join public.bryx_connect_order_links previous
      on previous.user_id = purchase.user_id
      and previous.order_code = current_link.replaces_order
      and previous.replaced_by_order = current_link.order_code
  )
  select order_code into root_code
  from lineage
  where replaces_order is null and not coalesce(is_recreated, false);

  if root_code is null then
    return null;
  end if;

  purchase_id := 'bryx-purchase-' || root_code;

  insert into public.bryx_meta_purchase_deliveries (user_id, root_order_code, order_code, event_id)
  values (purchase.user_id, root_code, p_order_code, purchase_id)
  on conflict do nothing;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'event_id', purchase_id,
    'event_time', floor(extract(epoch from purchase.completed_at))::bigint,
    'total', purchase.total,
    'click_id', purchase.click_id
  );
end;
$$;

revoke all on function public.bryx_claim_master_purchase(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.bryx_claim_master_purchase(text, timestamptz)
  to service_role;

commit;
