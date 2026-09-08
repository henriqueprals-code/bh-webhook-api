import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://nkueyeaqhfkzcepqbxkk.supabase.co";
const SUPABASE_KEY = "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  // Permite requisições POST da Logzz
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    
    // Extrai os dados que a Logzz envia
    const code = body.code || body.pedido_id || '#LGZ-' + Math.floor(1000 + Math.random() * 9000);
    const customer = body.customer_name || body.cliente || 'Cliente Logzz';
    const phone = body.customer_phone || body.telefone || '';
    const product = body.product_name || body.produto || 'Produto Geral';
    const total = parseFloat(body.total_price || body.valor || 0);
    const commission = parseFloat(body.commission || body.comissao || 0);
    const status = body.status || 'Agendado';
    const date = body.date || new Date().toISOString().split('T')[0];
    const delivery_date = body.delivery_date || '';

    // Define qual usuário é o dono deste pedido (padrão: Gustavo Master se não especificado)
    const userQuery = req.query.user || '';
    let targetUserId = '516f255c-5b2a-4706-a0a9-d662c59c19b0'; // Gustavo Master

    if (userQuery.toLowerCase().includes('jhonyelly')) {
      targetUserId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'; // Jhonyelly
    }

    const payload = {
      id: 'lgz_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      user_id: targetUserId,
      code,
      customer,
      phone,
      product,
      total,
      commission,
      status,
      date,
      delivery_date
    };

    // Insere direto no Supabase
    const { error } = await supabase.from('orders').upsert(payload);

    if (error) {
      console.error('Erro ao salvar no Supabase:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, message: 'Webhook processado com sucesso!', order: code });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}