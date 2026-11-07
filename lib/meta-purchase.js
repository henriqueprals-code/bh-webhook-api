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

  let state = 'review';
  let responseStatus = null;
  try {
    const response = await fetch('https://graph.facebook.com/v26.0/1367197798491297/events', {
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
            page_id: '1195511893652701',
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
    }
  } catch {
    // A Meta pode ter recebido o evento antes de a conexão falhar.
  }

  try {
    await call(
      'bryx_meta_purchase_deliveries?' +
        `event_id=eq.${encodeURIComponent(purchase.event_id)}&state=eq.sending`,
      'PATCH',
      { state, response_status: responseStatus, finished_at: new Date().toISOString() }
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
