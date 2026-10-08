const SUPABASE_URL = "https://nkueyeaqhfkzcepqbxkk.supabase.co";
const SUPABASE_KEY = "sb_publishable_MzEdLWuinPdJWASPBBIm9Q_tCP3ceY7";

function money(value) {
  const text = String(value ?? "0").trim();
  const number = Number(
    text.includes(",")
      ? text.replace(/\./g, "").replace(",", ".")
      : text
  );
  return Number.isFinite(number) ? number : 0;
}

function dateISO(value) {
  if (!value) return null;

  const text = String(value).trim();
  const br = text.match(/^(\d{2})[./](\d{2})[./](\d{4})(?:\s|$)/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);

  if (!br && !iso) return null;

  const year = Number(br ? br[3] : iso[1]);
  const month = Number(br ? br[2] : iso[2]);
  const day = Number(br ? br[1] : iso[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const slug = String(req.query?.slug || "master")
    .toLowerCase()
    .trim();

  if (!["master", "jhonyelly"].includes(slug)) {
    return res.status(400).json({
      success: false,
      error: "Operação desconhecida"
    });
  }

  if (req.method === "GET") {
    return res.status(200).json({
      status: "online",
      message: "BRYX Webhook API ativa e operacional",
      slug_recebido: slug,
      supabase_url: SUPABASE_URL
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Método não permitido"
    });
  }

  let body;

  try {
    body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return res.status(400).json({
      success: false,
      error: "JSON inválido"
    });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Object.keys(body).length
  ) {
    return res.status(400).json({
      success: false,
      error: "Payload vazio ou inválido"
    });
  }

  const orderCode = String(
    body.order_number || body.code || ""
  ).trim();

  if (!orderCode) {
    return res.status(400).json({
      success: false,
      error: "Código do pedido ausente"
    });
  }

  const dateOrder = dateISO(body.date_order);
  const dateDelivery = dateISO(body.date_delivery);

  if (
    (body.date_order && !dateOrder) ||
    (body.date_delivery && !dateDelivery)
  ) {
    return res.status(400).json({
      success: false,
      error: "Data inválida no payload"
    });
  }

  const isJhonyelly = slug === "jhonyelly";
  const targetTable = isJhonyelly
    ? "orders_jhonyelly"
    : "orders";

  const orderRecord = {
    id: orderCode,
    code: orderCode
  };

  const customer = body.client_name ?? body.customer;
  const phone = body.client_phone ?? body.phone;
  const product =
    body.products?.main?.product_name ??
    body.product_name ??
    body.product;
  const total =
    body.order_final_price ??
    body.total ??
    body.price;
  const commission =
    body.affiliate_commission ??
    body.commission ??
    body.producer_commission;

  // Atualiza somente os campos presentes no evento.
  if (customer != null) orderRecord.customer = customer;
  if (phone != null) orderRecord.phone = phone;
  if (product != null) orderRecord.product = product;
  if (total != null) orderRecord.total = money(total);
  if (commission != null) {
    orderRecord.commission = money(commission);
  }
  if (body.order_status) {
    orderRecord.status = body.order_status;
  }
  if (dateOrder) orderRecord.date = dateOrder;
  if (dateDelivery) {
    orderRecord.delivery_date = dateDelivery;
  }

  if (!isJhonyelly) {
    orderRecord.user_id =
      "516f255c-5b2a-4706-a0a9-d662c59c19b0";
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/${targetTable}?on_conflict=id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify([orderRecord])
      }
    );

    if (!response.ok) {
      const details = await response.text();
      console.error("Erro retornado pelo Supabase:", details);

      return res.status(400).json({
        success: false,
        error: "Erro retornado pelo Supabase",
        details
      });
    }

    const data = await response.json();

    return res.status(200).json({
      success: true,
      message: "Pedido processado e sincronizado com sucesso!",
      table: targetTable,
      data
    });
  } catch (error) {
    console.error("Erro na execução do Webhook:", error);

    return res.status(500).json({
      success: false,
      error: "Erro interno ao processar webhook",
      message: error?.message || "Erro desconhecido"
    });
  }
}
