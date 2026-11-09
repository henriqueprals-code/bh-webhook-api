export async function sendMetaPurchase(call, orderCode, env = process.env) {
  if (env.BRYX_META_PURCHASE_ENABLED !== 'true') return;

  const { BRYX_META_CAPI_TOKEN: token, BRYX_META_PURCHASE_START_AT: startAt } = env;
  const startTime = Date.parse(startAt);
  if (!token?.trim() || !startAt?.endsWith('Z') || !Number.isFinite(startTime)) {
    console.error('BRYX Meta Purchase: configuração incompleta');
    return;
  }

  const purchase = await call('rpc/bryx_claim_master_purchase', 'POST', {
    p_order_code: orderCode,
    p_start_at: startAt
  });
  if (!purchase) return;
  await sendPurchase(call, orderCode, purchase, {
    token, dataset_id: '1367197798491297', page_id: '1195511893652701'
  });
}

const graphUrl = 'https://graph.facebook.com/v26.0/';
const metaId = /^[0-9]{5,24}$/;

export async function sendSubscriberPurchase(call, slug, orderCode) {
  if (process.env.BRYX_SUBSCRIBER_META_PURCHASE_ENABLED === 'false') return;
  const path = 'rpc/bryx_prepare_subscriber_purchase';
  const order = { p_slug: slug, p_order_code: orderCode };
  const candidate = await call(path, 'POST', order);
  if (!candidate || !metaId.test(candidate.ad_id)) return;

  const credentials = new Map();
  for (const account of candidate.accounts) {
    if (!credentials.has(account.token)) credentials.set(account.token, new Set());
    credentials.get(account.token).add(account.id);
  }
  const fields = 'id,account_id,creative{object_story_spec,effective_object_story_id,object_story_id}';
  const signal = AbortSignal.timeout(6000);
  const entries = [...credentials.entries()];
  let shouldRetry = false;
  for (let offset = 0; offset < entries.length && !signal.aborted; offset += 5) {
    const origins = await Promise.all(entries.slice(offset, offset + 5).map(async ([token, accounts]) => {
      try {
        const response = await fetch(graphUrl + candidate.ad_id + '?' + new URLSearchParams({ fields }), {
          headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error'
        });
        if (!response.ok) {
          shouldRetry ||= response.status === 429 || response.status >= 500;
          return null;
        }
        const ad = await response.json();
        const account = String(ad.account_id ?? '');
        if (ad.id !== candidate.ad_id || !accounts.has(account)) return null;
        const creative = ad.creative;
        const story = /^([0-9]{5,24})_[0-9]+$/.exec(creative?.effective_object_story_id ?? creative?.object_story_id ?? '');
        const declaredPage = creative?.object_story_spec?.page_id;
        const page = String(declaredPage ?? story?.[1] ?? '');
        if (!metaId.test(page) || (story && story[1] !== page)) return null;
        return { p_page_id: page, p_account_id: account };
      } catch {
        shouldRetry = true;
        return null;
      }
    }));
    const found = origins.filter(Boolean);
    if (!found.length) continue;
    const [origin] = found;
    if (found.some(item => item.p_page_id !== origin.p_page_id || item.p_account_id !== origin.p_account_id)) return;
    const purchase = await call(path, 'POST', { ...order, p_ad_id: candidate.ad_id, ...origin });
    if (purchase) await sendPurchase(call, orderCode, purchase, purchase);
    return;
  }
  if (shouldRetry || signal.aborted) throw new Error('Consulta da origem Meta indisponível');
}

async function sendPurchase(call, orderCode, purchase, { token, dataset_id, page_id }) {
  let state = 'review';
  let responseStatus = null;
  let reason = 'receipt_unconfirmed';
  try {
    const response = await fetch(graphUrl + dataset_id + '/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: [{
          event_name: 'Purchase',
          event_time: purchase.event_time,
          event_id: purchase.event_id,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: {
            page_id,
            ctwa_clid: purchase.click_id
          },
          custom_data: {
            currency: 'BRL',
            value: purchase.total,
            order_id: orderCode
          }
        }]
      }),
      signal: AbortSignal.timeout(8000)
    });
    responseStatus = response.status;
    const result = await response.json();
    if (response.ok && result.events_received === 1 && !result.error) {
      state = 'accepted';
      reason = null;
    } else if (response.status >= 400 && response.status < 500 && result.error) {
      reason = [10, 190, 200].includes(Number(result.error.code)) ||
        response.status === 401 || response.status === 403 ? 'token_or_permissions' : 'meta_rejected';
    }
  } catch {
    // A Meta pode ter recebido o evento antes de a conexão falhar.
  }

  try {
    await call(
      'bryx_meta_purchase_deliveries?' +
        `event_id=eq.${encodeURIComponent(purchase.event_id)}&state=eq.sending`,
      'PATCH',
      { state, reason, response_status: responseStatus, finished_at: new Date().toISOString() }
    );
  } catch {
    // Mantém a reserva para evitar outro envio se a atualização falhar.
    console.error('BRYX Meta Purchase: resultado não gravado', purchase.event_id);
    return;
  }

  if (state === 'review') {
    console.error('BRYX Meta Purchase: revisar envio', purchase.event_id, responseStatus);
  }
}
