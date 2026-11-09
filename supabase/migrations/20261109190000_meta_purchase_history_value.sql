begin;

alter table public.bryx_meta_purchase_setups
  add column value_mode text not null default 'total' check (value_mode in ('total','commission'));
alter table public.bryx_meta_purchase_deliveries
  drop constraint bryx_meta_purchase_deliveries_state_check,
  add constraint bryx_meta_purchase_deliveries_state_check
    check (state in ('sending','accepted','review','waiting_commission')),
  add column sent_value numeric,
  add column value_mode text check (value_mode in ('total','commission')),
  add column reason text check (reason in ('meta_rejected','token_or_permissions','receipt_unconfirmed'));
create index bryx_meta_purchase_history_idx
  on public.bryx_meta_purchase_deliveries (user_id, claimed_at desc, event_id desc);

create function public.bryx_record_meta_purchase(
  p_user_id uuid, p_root text, p_order text, p_event text, p_dataset text, p_page text,
  p_mode text, p_value numeric
) returns boolean language plpgsql set search_path = '' as $$
begin
  insert into public.bryx_meta_purchase_deliveries
    (user_id, root_order_code, order_code, event_id, dataset_id, page_id, value_mode, sent_value, state)
  values (p_user_id, p_root, p_order, p_event, p_dataset, p_page, p_mode, p_value,
          case when p_value is null then 'waiting_commission' else 'sending' end)
  on conflict (user_id, root_order_code) do update set
    order_code=excluded.order_code, dataset_id=excluded.dataset_id, page_id=excluded.page_id,
    value_mode=excluded.value_mode, sent_value=excluded.sent_value,
    state=excluded.state, claimed_at=excluded.claimed_at
  where bryx_meta_purchase_deliveries.state='waiting_commission' and excluded.state='sending';
  return found and p_value is not null;
end;
$$;
revoke all on function public.bryx_record_meta_purchase(uuid,text,text,text,text,text,text,numeric) from public, anon, authenticated;
grant execute on function public.bryx_record_meta_purchase(uuid,text,text,text,text,text,text,numeric) to service_role;

CREATE OR REPLACE FUNCTION public.bryx_claim_master_purchase(p_order_code text, p_start_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  purchase record;
  root_code text;
  purchase_id text;
  mode text;
  event_value numeric;
begin
  if p_start_at is null or p_start_at > now() then
    return null;
  end if;

  -- Usa a mesma trava da recepção Logzz durante a checagem do vínculo.
  perform pg_advisory_xact_lock(hashtextextended('bryx-logzz:master', 0));

  select l.user_id, l.completed_at, o.total, o.commission, origin.click_id
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

  select value_mode into mode from public.bryx_meta_purchase_setups
  where user_id=purchase.user_id and dataset_id='1367197798491297' and page_id='1195511893652701'
  for share;
  mode := coalesce(mode, 'total');
  event_value := case when mode='total' then purchase.total
    when purchase.commission > 0 and purchase.commission < 'Infinity'::numeric then purchase.commission end;
  if not public.bryx_record_meta_purchase(purchase.user_id, root_code, p_order_code, purchase_id,
      '1367197798491297', '1195511893652701', mode, event_value) then
    return null;
  end if;

  return jsonb_build_object(
    'event_id', purchase_id,
    'event_time', floor(extract(epoch from purchase.completed_at))::bigint,
    'total', event_value,
    'click_id', purchase.click_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.bryx_prepare_subscriber_purchase(p_slug text, p_order_code text, p_ad_id text DEFAULT NULL::text, p_page_id text DEFAULT NULL::text, p_account_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  order_table text;
  tenant uuid;
  tracked record;
  purchase_setup record;
  order_total numeric;
  order_commission numeric;
  event_value numeric;
  root_code text;
  purchase_id text;
  settings jsonb;
  selected_accounts jsonb;
  capi_token text;
begin
  if p_slug is null or p_slug = 'master' or p_slug !~ '^[a-z][a-z0-9_]{0,39}$'
     or p_order_code is null
     or not exists (select 1 from public.bryx_operations where slug = p_slug) then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bryx-logzz:' || p_slug, 0));
  select m.user_id into tenant
  from public.bryx_memberships m
  where m.operation_slug = p_slug and m.active
    and (select count(*) from public.bryx_memberships where operation_slug = p_slug) = 1;
  if tenant is null then return null; end if;

  select l.completed_at, a.ad_id, a.click_id into tracked
  from public.bryx_connect_order_links l
  join public.bryx_connect_checkouts c
    on c.user_id = l.user_id and c.id = l.checkout_id and c.discarded_at is null
  join public.bryx_connect_origins a
    on a.user_id = c.user_id and a.id = c.origin_id and a.lead_id = c.lead_id
  join public.bryx_connect_leads lead on lead.user_id = c.user_id and lead.id = c.lead_id
  join public.bryx_connect_connections conn
    on conn.user_id = lead.user_id and conn.id = lead.connection_id and conn.deleted_at is null
  where l.user_id = tenant and l.order_code = p_order_code
    and l.attribution_status = 'linked' and l.replaced_by_order is null
    and l.completed_at between now() - interval '7 days' and now()
    and a.ad_id ~ '^[0-9]{5,24}$' and nullif(btrim(a.click_id), '') is not null;
  if not found then return null; end if;

  order_table := 'orders_' || p_slug;
  if to_regclass('public.' || order_table) is null then return null; end if;
  execute format(
    'select total, commission from public.%I where id = $1 and lower(btrim(status)) = ''completo''',
    order_table
  ) into order_total, order_commission using p_order_code;
  if order_total is null or order_total <= 0 or order_total >= 'Infinity'::numeric then
    return null;
  end if;

  with recursive lineage as (
    select l.order_code, l.replaces_order, l.is_recreated
    from public.bryx_connect_order_links l where l.user_id = tenant and l.order_code = p_order_code
    union
    select prior.order_code, prior.replaces_order, prior.is_recreated
    from lineage current_link
    join public.bryx_connect_order_links prior
      on prior.user_id = tenant and prior.order_code = current_link.replaces_order
      and prior.replaced_by_order = current_link.order_code
  )
  select order_code into root_code
  from lineage where replaces_order is null and not coalesce(is_recreated, false);

  if root_code is null or exists (
    select 1 from public.bryx_meta_purchase_deliveries d
    where d.user_id = tenant and d.root_order_code = root_code and d.state <> 'waiting_commission'
  ) then return null; end if;

  select value into settings from public.bh_settings where key = p_slug || '_meta_accounts';
  if jsonb_typeof(settings) = 'string' then settings := (settings #>> '{}')::jsonb; end if;
  if jsonb_typeof(settings) is distinct from 'array' then return null; end if;

  if p_ad_id is null and p_page_id is null and p_account_id is null then
    select jsonb_agg(distinct jsonb_build_object(
      'id', regexp_replace(a->>'id', '^act_', '', 'i'), 'token', a->>'token'
    )) into selected_accounts
    from jsonb_array_elements(settings) a
    where nullif(btrim(a->>'token'), '') is not null
      and exists (
        select 1 from public.bryx_meta_purchase_setups s
        where s.user_id = tenant and tracked.completed_at >= s.active_from
          and regexp_replace(a->>'id', '^act_', '', 'i') = any(s.account_ids)
      );
    if selected_accounts is null then return null; end if;
    return jsonb_build_object('ad_id', tracked.ad_id, 'accounts', selected_accounts);
  end if;

  if p_ad_id is distinct from tracked.ad_id or p_page_id is null or p_account_id is null
     or not exists (select 1 from jsonb_array_elements(settings) a
                    where regexp_replace(a->>'id', '^act_', '', 'i') = p_account_id
                    and nullif(btrim(a->>'token'), '') is not null) then return null; end if;

  select s.dataset_id, s.page_id, s.encrypted_token, s.value_mode into purchase_setup
  from public.bryx_meta_purchase_setups s
  where s.user_id = tenant and s.page_id = p_page_id and p_account_id = any(s.account_ids)
    and tracked.completed_at >= s.active_from
  for share;
  if not found then return null; end if;

  select extensions.pgp_sym_decrypt(decode(purchase_setup.encrypted_token, 'base64'), k.secret)
    into capi_token from bryx_purchase_private.encryption_key k where k.singleton;
  if nullif(btrim(capi_token), '') is null then return null; end if;

  purchase_id := 'bryx-purchase-' || tenant::text || '-' || root_code;
  event_value := case when purchase_setup.value_mode='total' then order_total
    when order_commission > 0 and order_commission < 'Infinity'::numeric then order_commission end;
  if not public.bryx_record_meta_purchase(tenant, root_code, p_order_code, purchase_id,
      purchase_setup.dataset_id, purchase_setup.page_id, purchase_setup.value_mode, event_value) then
    return null;
  end if;

  return jsonb_build_object(
    'event_id', purchase_id, 'event_time', floor(extract(epoch from tracked.completed_at))::bigint,
    'total', event_value, 'click_id', tracked.click_id,
    'dataset_id', purchase_setup.dataset_id, 'page_id', purchase_setup.page_id, 'token', capi_token
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.bryx_save_meta_purchase_setup(p_setup jsonb, p_token text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  with saved as (
    insert into public.bryx_meta_purchase_setups (
      user_id, page_id, page_name, dataset_id, dataset_name, dataset_readable,
      account_ids, confirmed_account_ids, encrypted_token, value_mode
    )
    select
      (p_setup->>'user_id')::uuid, p_setup->>'page_id', p_setup->>'page_name',
      p_setup->>'dataset_id', p_setup->>'dataset_name', (p_setup->>'dataset_readable')::boolean,
      array(select jsonb_array_elements_text(p_setup->'account_ids')),
      array(select jsonb_array_elements_text(p_setup->'confirmed_account_ids')),
      encode(extensions.pgp_sym_encrypt(p_token, k.secret, 'cipher-algo=aes256'), 'base64'),
      coalesce(p_setup->>'value_mode','total')
    from bryx_purchase_private.encryption_key k
    where k.singleton
    on conflict (user_id, page_id) do update set
      page_name = excluded.page_name,
      dataset_id = excluded.dataset_id,
      dataset_name = excluded.dataset_name,
      dataset_readable = excluded.dataset_readable,
      account_ids = excluded.account_ids,
      confirmed_account_ids = excluded.confirmed_account_ids,
      encrypted_token = excluded.encrypted_token,
      value_mode = coalesce(p_setup->>'value_mode',bryx_meta_purchase_setups.value_mode)
    returning dataset_id, dataset_name, page_id, page_name, account_ids, confirmed_account_ids, dataset_readable, value_mode
  )
  select to_jsonb(saved) from saved;
$function$;

create function public.bryx_meta_purchase_today(p_user uuid, p_master boolean)
returns jsonb language sql stable set search_path = '' as $$
  with rows as (
    select coalesce(d.page_id,case when p_master then '1195511893652701' end) as page_id,
      coalesce(d.dataset_id,case when p_master then '1367197798491297' end) as dataset_id,
      count(*) filter(where d.state='accepted') as accepted,
      count(*) filter(where d.state='review') as review,
      count(*) filter(where d.state='sending') as sending,
      count(*) filter(where d.state='waiting_commission') as waiting
    from public.bryx_meta_purchase_deliveries d
    where d.user_id=p_user
      and d.claimed_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'
    group by 1,2
  )
  select coalesce(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) from rows;
$$;
revoke all on function public.bryx_meta_purchase_today(uuid,boolean) from public, anon, authenticated;
grant execute on function public.bryx_meta_purchase_today(uuid,boolean) to service_role;

commit;
