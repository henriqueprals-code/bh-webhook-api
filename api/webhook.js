import { timingSafeEqual } from 'node:crypto';

const money = value => {
  let text = String(value)
    .trim()
    .replace(/R\$\s*/g, '')
    .replace(/\s/g, '');

  if (text.includes(',')) {
    text = text.replace(/\./g, '').replace(',', '.');
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    throw new Error('Valor inválido');
  }

  return number;
};

const date = value => {
  const match = String(value)
    .trim()
    .split(' ')[0]
    .match(/^(\d{2})[./](\d{2})[./](\d{4})$/);

  const iso = match
    ? `${match[3]}-${match[2]}-${match[1]}`
    : String(value).slice(0, 10);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(iso) ||
    !Number.isFinite(Date.parse(iso)) ||
    new Date(iso).toISOString().slice(0, 10) !== iso
  ) {
    throw new Error('Data inválida');
  }

  return iso;
};

const first = (...values) =>
  values.find(
    value =>
      value !== undefined &&
      value !== null &&
      value !== ''
  );

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      message: 'BRYX Webhook API ativa'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Utilize POST.'
    });
  }

  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(503).json({
      success: false,
      error: 'Configuração indisponível.'
    });
  }

  const call = async (path, method = 'GET', body) => {
    const response = await fetch(
      url + '/rest/v1/' + path,
      {
        method,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000)
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      const error = new Error('Banco indisponível');
      error.status = response.status;
      throw error;
    }

    return raw ? JSON.parse(raw) : null;
  };

  try {
    const slug = String(req.query?.slug || '')
      .trim()
      .toLowerCase();

    const token = String(req.query?.token || '');

    if (
      !/^[a-z][a-z0-9_]{0,39}$/.test(slug) ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      return res.status(401).json({
        success: false,
        error: 'Webhook não autorizado.'
      });
    }

    const [credential] = await call(
      'bryx_webhook_credentials?' +
      `operation_slug=eq.${encodeURIComponent(slug)}` +
      '&select=token'
    );

    if (
      !credential ||
      Buffer.byteLength(credential.token) !==
        Buffer.byteLength(token) ||
      !timingSafeEqual(
        Buffer.from(credential.token),
        Buffer.from(token)
      )
    ) {
      return res.status(401).json({
        success: false,
        error: 'Webhook não autorizado.'
      });
    }

    const [operation] = await call(
      'bryx_operations?' +
      `slug=eq.${encodeURIComponent(slug)}` +
      '&select=slug'
    );

    if (!operation) {
      return res.status(401).json({
        success: false,
        error: 'Webhook não autorizado.'
      });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== 'object' ||
      !Object.keys(body).length
    ) {
      return res.status(400).json({
        success: false,
        error: 'Payload vazio ou inválido.'
      });
    }

    const code = String(
      first(body.order_number, body.code) || ''
    ).trim();

    if (!code || code.length > 160) {
      return res.status(400).json({
        success: false,
        error: 'Código do pedido obrigatório.'
      });
    }

    const table =
      slug === 'master' ? 'orders' : 'orders_' + slug;

    const [existing] = await call(
      `${table}?id=eq.${encodeURIComponent(code)}&select=id`
    );

    const record = {
      id: code,
      code,
      updated_at: new Date().toISOString()
    };

    const set = (
      column,
      value,
      transform = value => value
    ) => {
      if (value !== undefined && value !== null) {
        record[column] = transform(value);
      }
    };

    set('customer', first(body.client_name, body.customer));
    set('phone', first(body.client_phone, body.phone));

    set(
      'product',
      first(
        body.products?.main?.product_name,
        body.product_name,
        body.product
      )
    );

    set(
      'total',
      first(
        body.order_final_price,
        body.total,
        body.price
      ),
      money
    );

    set(
      'commission',
      first(
        body.affiliate_commission,
        body.commission,
        body.producer_commission
      ),
      money
    );

    set('status', body.order_status);
    set('date', body.date_order, date);
    set('delivery_date', body.date_delivery, date);

    if (!existing) {
      record.customer ??= 'Cliente Logzz';
      record.phone ??= '';
      record.product ??= 'Produto Logzz';
      record.total ??= 0;
      record.commission ??= 0;
      record.status ??= 'Agendado';
      record.date ??= new Date().toISOString().slice(0, 10);
      record.delivery_date ??= record.date;
    }

    if (slug === 'master') {
      record.user_id =
        '516f255c-5b2a-4706-a0a9-d662c59c19b0';
    }

    // O webhook continua recebendo eventos mesmo
    // quando o acesso do assinante está inativo.
    await call(
      `${table}?on_conflict=id`,
      'POST',
      [record]
    );

    return res.status(200).json({
      success: true,
      message: 'Pedido sincronizado.'
    });
  } catch (error) {
    console.error(
      'BRYX webhook:',
      error.status || error.name
    );

    const invalidPayload =
      error instanceof SyntaxError ||
      error.message === 'Valor inválido' ||
      error.message === 'Data inválida';

    return res.status(
      invalidPayload ? 400 : 503
    ).json({
      success: false,
      error:
        'Não foi possível processar o pedido. A Logzz pode reenviar.'
    });
  }
}
