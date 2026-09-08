import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405.json({ error: 'Method not allowed' }));
  }

  try {
    const userParam = req.query.user; // Ex: ?user=jhonyelly ou master
    const payload = req.body;

    // 1. Identificar o user_id correto no Supabase
    let targetUserId = null;

    if (userParam) {
      // Busca o ID na tabela profiles pelo nome ou email
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .or(`email.eq.${userParam},name.ilike.%${userParam}%`)
        .single();
      
      if (profile) {
        targetUserId = profile.id;
      }
    }

    // Se não achar pelo parâmetro, pega o primeiro usuário admin/master padrão
    if (!targetUserId) {
      const { data: defaultProfile } = await supabase
        .from('profiles')
        .select('id')
        .limit(1)
        .single();
      
      if (defaultProfile) {
        targetUserId = defaultProfile.id;
      }
    }

    // 2. Extrair os dados do payload da Logzz (tratando nulos/vazios)
    const orderData = {
      id: payload.id || payload.order_id || `lgz_${Date.now()}`,
      user_id: targetUserId,
      code: payload.code || payload.order_code || 'EMPTY',
      customer: payload.customer?.name || payload.client_name || 'Cliente Logzz',
      phone: payload.customer?.phone || payload.client_phone || 'EMPTY',
      product: payload.product?.name || payload.product_name || 'Produto Geral',
      total: payload.total || payload.amount || 0,
      commission: payload.commission || payload.producer_commission || 0,
      status: payload.status || 'Agendado',
      date: payload.date || new Date().toISOString().split('T')[0],
      frustrated_fee: payload.frustrated_fee || 0,
      delivery_date: payload.delivery_date || 'EMPTY'
    };

    // 3. Inserir na tabela orders
    const { error } = await supabase.from('orders').upsert([orderData]);

    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true, message: 'Pedido processado com sucesso!' });

  } catch (err) {
    console.error('Erro interno:', err);
    return res.status(500).json({ error: err.message });
  }
}
