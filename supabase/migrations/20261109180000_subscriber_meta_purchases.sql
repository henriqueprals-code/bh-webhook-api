begin;

alter table public.bryx_meta_purchase_setups add column active_from timestamptz not null default statement_timestamp();
alter table public.bryx_meta_purchase_deliveries
  add column dataset_id text,
  add column page_id text;

create function public.bryx_meta_purchase_setup_clock()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.dataset_id, new.encrypted_token, new.account_ids) is distinct from
     (old.dataset_id, old.encrypted_token, old.account_ids) then
    new.active_from := statement_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function public.bryx_meta_purchase_setup_clock() from public, anon, authenticated;
create trigger bryx_meta_purchase_setup_clock
before update on public.bryx_meta_purchase_setups
for each row execute function public.bryx_meta_purchase_setup_clock();

-- An authenticated Logzz webhook calls this in two stages. Only the second
-- stage, with the ad account and Page returned by Meta, reserves a purchase.
create function public.bryx_prepare_subscriber_purchase(
  p_slug text, p_order_code text, p_ad_id text default null,
  p_page_id text default null, p_account_id text default null
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  order_table text;
  tenant uuid;
  tracked record;
  purchase_setup record;
  order_total numeric;
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
    'select total from public.%I where id = $1 and lower(btrim(status)) = ''completo''',
    order_table
  ) into order_total using p_order_code;
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
    where d.user_id = tenant and d.root_order_code = root_code
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

  select s.dataset_id, s.page_id, s.encrypted_token into purchase_setup
  from public.bryx_meta_purchase_setups s
  where s.user_id = tenant and s.page_id = p_page_id and p_account_id = any(s.account_ids)
    and tracked.completed_at >= s.active_from
  for share;
  if not found then return null; end if;

  select extensions.pgp_sym_decrypt(decode(purchase_setup.encrypted_token, 'base64'), k.secret)
    into capi_token from bryx_purchase_private.encryption_key k where k.singleton;
  if nullif(btrim(capi_token), '') is null then return null; end if;

  purchase_id := 'bryx-purchase-' || tenant::text || '-' || root_code;
  insert into public.bryx_meta_purchase_deliveries
    (user_id, root_order_code, order_code, event_id, dataset_id, page_id)
  values (tenant, root_code, p_order_code, purchase_id, purchase_setup.dataset_id, purchase_setup.page_id)
  on conflict do nothing;
  if not found then return null; end if;

  return jsonb_build_object(
    'event_id', purchase_id, 'event_time', floor(extract(epoch from tracked.completed_at))::bigint,
    'total', order_total, 'click_id', tracked.click_id,
    'dataset_id', purchase_setup.dataset_id, 'page_id', purchase_setup.page_id, 'token', capi_token
  );
end;
$$;

revoke all on function public.bryx_prepare_subscriber_purchase(text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.bryx_prepare_subscriber_purchase(text,text,text,text,text)
  to service_role;

commit;
