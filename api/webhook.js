// Configurações do Supabase
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://nkueyeaqhfkzcepqbxkk.supabase.co").trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7").trim();

export default async function handler(req, res) {
  // Libera CORS para evitar bloqueios
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Permite testar pelo navegador com requisição GET
  if (req.method === 'GET') {
    const slug = (req.query?.slug || 'master').toLowerCase().trim();
    return res.status(200).json({
      status: 'online',
      message: 'BRYX Webhook API ativa e operacional',
      slug_recebido: slug,
      supabase_url: SUPABASE_URL
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  try {
    // 1. Identifica a operação via parâmetro ?slug= (ex: ?slug=jhonyelly ou ?slug=master)
    const slug = (req.query?.slug || 'master').toLowerCase().trim();

    let targetTable = 'orders';
    if (slug === 'jhonyelly') {
      targetTable = 'orders_jhonyelly';
    } else if (slug !== 'master' && slug !== 'gustavo') {
      targetTable = `orders_${slug.replace(/[^a-z0-9_]/gi, '')}`;
    }

    // 2. Lê o payload JSON da Logzz
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    if (!body || Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, error: 'Payload vazio recebido' });
    }

    // 3. Sanitização de Valores Monetários (converte vírgula da Logzz para float)
    const rawTotal = body.order_final_price || body.total || body.price || '0';
    const total = parseFloat(String(rawTotal).replace(',', '.')) || 0;

    const rawComm = body.affiliate_commission || body.commission || body.producer_commission || '0';
    const commission = parseFloat(String(rawComm).replace(',', '.')) || 0;

    // 4. Conversão de Datas (converte DD.MM.YYYY da Logzz para YYYY-MM-DD do Postgres)
    let delivery_date = new Date().toISOString().split('T')[0];
    if (body.date_delivery) {
      const parts = String(body.date_delivery).trim().split(' ')[0].split('.');
      if (parts.length === 3) {
        delivery_date = `\({parts}-\){parts}-${parts[0]}`;
      } else {
        delivery_date = body.date_delivery;
      }
    }

    let date = new Date().toISOString().split('T')[0];
    if (body.date_order) {
      const parts = String(body.date_order).trim().split(' ')[0].split('.');
      if (parts.length === 3) {
        date = `\({parts}-\){parts}-${parts[0]}`;
      }
    }

    // 5. Produto e Variações
    const product = body.products?.main?.product_name || body.product_name || body.product || 'Produto Padrão';
    const offer = body.products?.main?.variations?.[0]?.product_name || 'Padrão';

    // 6. ID do Pedido (compatível com tipo numérico do Supabase)
    let orderId = body.order_number || body.code || body.id;
    if (!orderId || isNaN(Number(orderId))) {
      orderId = Math.floor(10000000 + Math.random() * 90000000);
    } else {
      orderId = Number(orderId);
    }

    // 7. Registro do Pedido
    const orderRecord = {
      id: orderId,
      customer: body.client_name || body.customer || 'Cliente Logzz',
      phone: body.client_phone || body.phone || '',
      product: product,
      offer: offer,
      status: body.order_status || 'Agendado',
      total: total,
      commission: commission,
      date: date,
      delivery_date: delivery_date,
      city: body.client_address_city || '',
      state: body.client_address_state || '',
      address: body.client_address 
        ? `\({body.client_address},\){body.client_address_number || ''} ${body.client_address_district || ''}`.trim() 
        : ''
    };

    // 8. Monta a URL REST válida do Supabase
    const restUrl = `\({SUPABASE_URL}/rest/v1/\){targetTable}`;

    // 9. Envia para o Supabase via Upsert
    const supabaseResponse = await fetch(restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify([orderRecord])
    });

    if (!supabaseResponse.ok) {
      const errDetails = await supabaseResponse.text();
      console.error(`Erro no Supabase (${targetTable}):`, errDetails);
      return res.status(400).json({ 
        success: false, 
        error: 'Erro retornado pelo banco Supabase',
        details: errDetails 
      });
    }

    const savedData = await supabaseResponse.json();

    return res.status(200).json({
      success: true,
      message: 'Pedido processado e salvo com sucesso!',
      table: targetTable,
      data: savedData
    });

  } catch (error) {
    console.error('Erro na execução do Webhook:', error);
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao processar webhook',
      message: error?.message || 'Erro desconhecido'
    });
  }
}
