// =========================================================================
// BRYX SAAS — ENGINE DA WEBHOOK DA LOGZZ (VERCEL SERVERLESS AUTO-HEALING)
// REPOSITÓRIO: henriqueprals-code/bh-webhook-api
// ENDPOINT: https://bh-webhook-api.vercel.app/api/webhook?slug=SEU_SLUG
// =========================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "https://nkueyeaqhfkzcepqbxkk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7";

module.exports = async (req, res) => {
  // 1. Configuração de CORS
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

  // 2. Identificação da Operação / Usuário (?slug=...)
  const rawSlug = (req.query.slug || req.query.user || req.query.usuario || 'master')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '');

  const isMaster = rawSlug === 'master' || rawSlug === 'gustavo' || !rawSlug;
  const targetTable = isMaster ? 'orders' : `orders_${rawSlug}`;

  // Teste no navegador (GET)
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      service: 'BRYX Logzz Webhook API Engine (Auto-Healing)',
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

    // 3. Extração dos Dados do Pedido da Logzz
    const orderId = String(
      body.id || body.code || body.codigo || body.order_id || body.pedido_id || body.uuid || ('lgz_' + Date.now())
    ).trim();

    const customer = (
      body.cliente?.nome ||
      body.cliente_nome ||
      body.customer_name ||
      body.customer ||
      body.cliente ||
      body.nome ||
      'Cliente'
    ).trim();

    const phone = (
      body.cliente?.telefone ||
      body.cliente?.celular ||
      body.cliente_telefone ||
      body.telefone ||
      body.phone ||
      body.whatsapp ||
      ''
    ).trim();

    const product = (
      body.produto?.nome ||
      body.produto_nome ||
      body.produto ||
      body.product ||
      body.itens?.[0]?.nome ||
      body.item?.[0]?.nome ||
      'Produto Geral'
    ).trim();

    const offer = (
      body.oferta?.nome ||
      body.oferta_nome ||
      body.oferta ||
      body.offer ||
      body.itens?.[0]?.oferta ||
      '1 UN'
    ).trim();

    const rawStatus = (body.status || body.situacao || body.order_status || 'Agendado').trim();

    const totalVal = parseFloat(body.valor_total || body.total || body.valor || body.value || 0);
    const commVal = parseFloat(body.comissao || body.commission || body.valor_comissao || 0);

    const dateVal = (
      body.data_criacao ||
      body.data_agendamento ||
      body.data_pedido ||
      body.date ||
      body.created_at ||
      new Date().toISOString().split('T')[0]
    ).split('T')[0];

    const deliveryVal = (
      body.data_entrega ||
      body.delivery_date ||
      body.data_prevista ||
      body.delivery ||
      ''
    ).split('T')[0];

    const utm_campaign = body.utm_campaign || body.utm?.campaign || '';
    const utm_source = body.utm_source || body.utm?.source || '';
    const utm_medium = body.utm_medium || body.utm?.medium || '';

    // Monta o payload inicial com suporte a 'total' e 'value'
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
      data_agendamento: dateVal,
      delivery_date: deliveryVal || null,
      utm_campaign,
      utm_source,
      utm_medium,
      updated_at: new Date().toISOString()
    };

    // 4. Gravação com Auto-Healing no Supabase
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

      // Se a tabela não tiver a coluna, remove do objeto e reenvia automaticamente
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
