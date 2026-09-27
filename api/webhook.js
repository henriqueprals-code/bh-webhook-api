// =========================================================================
// BRYX SAAS — ENGINE DA WEBHOOK DA LOGZZ (VERSÃO OFICIAL PRODUÇÃO)
// REPOSITÓRIO: henriqueprals-code/bh-webhook-api
// ENDPOINT: https://bh-webhook-api.vercel.app/api/webhook?slug=SEU_SLUG
// =========================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "https://nkueyeaqhfkzcepqbxkk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7";

function parseMoneyLogzz(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const s = String(val).trim().replace(/[^\d,\.-]/g, '');
  if (s.includes(',') && s.includes('.')) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  }
  if (s.includes(',')) {
    return parseFloat(s.replace(',', '.')) || 0;
  }
  return parseFloat(s) || 0;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, apikey, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const rawSlug = (req.query.slug || req.query.user || req.query.usuario || 'master')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '');

  const isMaster = rawSlug === 'master' || rawSlug === 'gustavo' || !rawSlug;
  const targetTable = isMaster ? 'orders' : `orders_${rawSlug}`;

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      service: 'BRYX Logzz Webhook API Engine (Produção)',
      operation_slug: rawSlug,
      target_table: targetTable,
      endpoint_url: `https://bh-webhook-api.vercel.app/api/webhook?slug=${rawSlug}`,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Utilize POST.' });
  }

  try {
    const body = req.body || {};

    // 1. Extração Cirúrgica dos Campos Oficiais da Logzz
    const orderId = String(
      body.order_number || body.id || body.code || body.codigo || body.order_id || body.pedido_id || body.uuid || ('lgz_' + Date.now())
    ).trim();

    const customer = String(
      body.client_name || body.cliente_nome || body.customer_name || body.customer || body.cliente || body.nome || 'Cliente'
    ).trim();

    const phone = String(
      body.client_phone || body.cliente_telefone || body.cliente?.celular || body.telefone || body.phone || body.whatsapp || ''
    ).trim();

    const product = String(
      body.products?.main?.product_name || body.produto?.nome || body.produto_nome || body.produto || body.product || 'Produto Geral'
    ).trim();

    const offer = String(
      body.products?.main?.variations?.[0]?.product_name || body.oferta_nome || body.oferta || body.offer || '1 UN'
    ).trim();

    const rawStatus = String(body.order_status || body.status || body.situacao || 'Agendado').trim();

    const totalVal = parseMoneyLogzz(body.order_final_price || body.valor_total || body.total || body.valor || body.value || 0);
    const commVal = parseMoneyLogzz(body.commission || body.affiliate_commission || body.comissao || 0);

    const dateVal = String(
      body.date_order || body.data_criacao || body.data_agendamento || body.data_pedido || body.date || body.created_at || new Date().toISOString().split('T')[0]
    ).trim();

    const deliveryVal = String(
      body.date_delivery || body.data_entrega || body.delivery_date || body.data_prevista || body.delivery || ''
    ).trim();

    const cityVal = String(body.client_address_city || body.cidade || '').trim();
    const stateVal = String(body.client_address_state || body.estado || '').trim();

    // 2. Montagem do Objeto Exato das Colunas do Supabase
    let currentPayload = {
      id: orderId,
      code: orderId,
      customer,
      phone,
      product,
      offer,
      status: rawStatus,
      total: totalVal,
      value: totalVal,
      commission: commVal,
      date: dateVal,
      delivery_date: deliveryVal || null,
      cidade: cityVal,
      estado: stateVal,
      unidade: cityVal ? `\({cityVal} -\){stateVal}` : ''
    };

    // 3. Gravação com Auto-Healing no Supabase
    const supabaseEndpoint = `\({SUPABASE_URL}/rest/v1/\){targetTable}`;
    let success = false;
    let lastError = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(supabaseEndpoint, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(currentPayload)
      });

      if (response.ok) {
        success = true;
        break;
      }

      const errText = await response.text();
      lastError = errText;

      // Se a tabela não tiver alguma coluna específica, remove e reenvia no mesmo milissegundo
      const matchCol = errText.match(/Could not find the '([^']+)' column/i);
      if (matchCol && matchCol) {
        delete currentPayload[matchCol[1]];
        continue;
      } else {
        break;
      }
    }

    if (!success) {
      console.error(`Erro ao salvar no Supabase (${targetTable}):`, lastError);
      return res.status(400).json({
        success: false,
        error: 'Falha ao gravar pedido no banco',
        target_table: targetTable,
        details: lastError
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Pedido processado e sincronizado no BRYX!',
      target_table: targetTable,
      order_id: orderId,
      customer,
      status: rawStatus
    });

  } catch (error) {
    console.error('Erro interno:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao processar webhook',
      message: error.message
    });
  }
};
