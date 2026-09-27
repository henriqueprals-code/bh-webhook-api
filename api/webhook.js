import { NextRequest, NextResponse } from 'next/server';

// Configurações do Supabase (lê das variáveis de ambiente da Vercel ou usa os fallbacks do seu projeto)
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://nkueyeaqhfkzcepqbxkk.supabase.co").trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7").trim();

export async function POST(req: NextRequest) {
  try {
    // 1. Identifica a operação via parâmetro ?slug= (ex: ?slug=jhonyelly ou ?slug=master)
    const { searchParams } = new URL(req.url);
    const slug = (searchParams.get('slug') || 'master').toLowerCase().trim();

    // Determina a tabela correta no Supabase
    let targetTable = 'orders';
    if (slug === 'jhonyelly') {
      targetTable = 'orders_jhonyelly';
    } else if (slug !== 'master' && slug !== 'gustavo') {
      targetTable = `orders_${slug.replace(/[^a-z0-9_]/gi, '')}`;
    }

    // 2. Lê o payload JSON enviado pela Logzz
    const body = await req.json();

    if (!body) {
      return NextResponse.json({ success: false, error: 'Payload vazio' }, { status: 400 });
    }

    // 3. Sanitização de Valores Monetários (converte vírgula da Logzz para float)
    const rawTotal = body.order_final_price || body.total || body.price || '0';
    const total = parseFloat(String(rawTotal).replace(',', '.')) || 0;

    const rawComm = body.affiliate_commission || body.commission || body.producer_commission || '0';
    const commission = parseFloat(String(rawComm).replace(',', '.')) || 0;

    // 4. Conversão de Datas (converte DD.MM.YYYY da Logzz para YYYY-MM-DD do banco)
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

    // 5. Identificação do Produto e Variações
    const product = body.products?.main?.product_name || body.product_name || body.product || 'Produto Padrão';
    const offer = body.products?.main?.variations?.[0]?.product_name || 'Padrão';

    // 6. Tratamento do ID do Pedido
    // Gera ID numérico caso o banco exija inteiro, ou preserva o código da Logzz
    let orderId: any = body.order_number || body.code || body.id;
    if (!orderId || isNaN(Number(orderId))) {
      orderId = Math.floor(10000000 + Math.random() * 90000000);
    } else {
      orderId = Number(orderId);
    }

    // 7. Monta o registro sanitizado para o Supabase
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

    // 8. Monta a URL REST válida do Supabase (sem parênteses quebrados)
    const restUrl = `\({SUPABASE_URL}/rest/v1/\){targetTable}`;

    // 9. Envia para o Supabase via Upsert (insere novo ou atualiza existente)
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
      console.error(`Erro ao inserir no Supabase (${targetTable}):`, errDetails);
      return NextResponse.json({ 
        success: false, 
        error: 'Erro retornado pelo banco Supabase',
        details: errDetails 
      }, { status: 400 });
    }

    const savedData = await supabaseResponse.json();

    return NextResponse.json({
      success: true,
      message: 'Pedido processado e salvo com sucesso!',
      table: targetTable,
      data: savedData
    }, { status: 200 });

  } catch (error: any) {
    console.error('Erro na execução do Webhook:', error);
    return NextResponse.json({
      success: false,
      error: 'Erro interno ao processar webhook',
      message: error?.message || 'Erro desconhecido'
    }, { status: 500 });
  }
}

// Suporte a requisição GET para teste rápido no navegador
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug') || 'master';
  return NextResponse.json({
    status: 'online',
    message: 'BRYX Webhook API ativa e operacional',
    slug_recebido: slug,
    supabase_url: SUPABASE_URL
  });
}
