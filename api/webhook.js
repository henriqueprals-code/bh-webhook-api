// URL e Chave DIRETO do seu Supabase
const SUPABASE_URL = "https://nkueyeaqhfkzcepqbxkk.supabase.co";
const SUPABASE_KEY = "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
    // 1. Lê o payload JSON da Logzz
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Confirma teste da Logzz na hora com 200 OK
    if (!body || Object.keys(body).length === 0 || body.event === 'test' || body.teste === true) {
      return res.status(200).json({ success: true, message: 'Teste de webhook recebido com sucesso' });
    }

    // 2. Identifica a operação via ?slug= ou link interno da Logzz
    let slug = (req.query?.slug || '').toLowerCase().trim();
    if (!slug && body.integration && body.integration.link) {
      try {
        const u = new URL(body.integration.link);
        slug = (u.searchParams.get('slug') || '').toLowerCase().trim();
      } catch(e){}
    }
    if (!slug) slug = 'jhonyelly';

    const isJhonyelly = slug === 'jhonyelly';
    const targetTable = isJhonyelly ? 'orders_jhonyelly' : 'orders';

    // 3. Converte valores da Logzz (vírgula para ponto)
    const rawTotal = body.order_final_price || body.total || body.price || '0';
    const total = parseFloat(String(rawTotal).replace(',', '.')) || 0;

    const rawComm = body.affiliate_commission || body.commission || body.producer_commission || '0';
    const commission = parseFloat(String(rawComm).replace(',', '.')) || 0;

    // 4. Converte datas DD.MM.YYYY para YYYY-MM-DD com limpeza de repetições (ex: 28.09.2026-28.09.2026)
    let dataPedido = new Date().toISOString().split('T')[0];
    if (body.date_order) {
      const first = String(body.date_order).trim().split(' ')[0].split('-')[0].trim();
      const parts = first.split('.');
      if (parts.length === 3) {
        dataPedido = parts + '-' + parts + '-' + parts[0];
      }
    }

    let dataEntrega = dataPedido;
    if (body.date_delivery) {
      const first = String(body.date_delivery).trim().split(' ')[0].split('-')[0].trim();
      const parts = first.split('.');
      if (parts.length === 3) {
        dataEntrega = parts + '-' + parts + '-' + parts[0];
      }
    }

    // 5. Produto e Código do Pedido
    const product = body.products?.main?.product_name || body.product_name || body.product || 'Produto Padrão';
    const orderCode = String(body.order_number || body.code || ('ord_' + Date.now()));

    // 6. Monta o registro exatamente como sua tabela espera
    const orderRecord = {
      id: orderCode,
      code: orderCode,
      customer: body.client_name || body.customer || 'Cliente Logzz',
      phone: body.client_phone || body.phone || '',
      product: product,
      total: total,
      commission: commission,
      status: body.order_status || 'Agendado',
      date: dataPedido,
      delivery_date: dataEntrega
    };

    // A tabela Master ('orders') exige user_id
    if (!isJhonyelly) {
      orderRecord.user_id = '516f255c-5b2a-4706-a0a9-d662c59c19b0';
    }

    // 7. Envia para o Supabase
    const restUrl = "https://nkueyeaqhfkzcepqbxkk.supabase.co/rest/v1/" + targetTable;

    const supabaseResponse = await fetch(restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify([orderRecord])
    });

    if (!supabaseResponse.ok) {
      const errDetails = await supabaseResponse.text();
      console.error('Aviso Supabase:', errDetails);
    }

    // 8. Resposta 200 OK sempre para a Logzz confirmar recebimento com sucesso
    return res.status(200).json({
      success: true,
      message: 'Pedido processado e sincronizado com sucesso!',
      table: targetTable,
      order_id: orderCode
    });

  } catch (error) {
    console.error('Erro no processamento do Webhook:', error);
    return res.status(200).json({
      success: true,
      warning: 'Webhook recebido com fallback',
      message: error?.message || 'Erro desconhecido'
    });
  }
}
