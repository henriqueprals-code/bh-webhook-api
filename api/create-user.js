// As chaves são lidas exclusivamente no servidor, pela Vercel.
// Nunca coloque a chave service_role diretamente neste arquivo.

function normalizeSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Utilize POST para cadastrar um usuário."
    });
  }

  const supabaseUrl = String(
    process.env.SUPABASE_URL || ""
  ).replace(/\/+$/, "");

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      success: false,
      error: "As variáveis do Supabase não estão configuradas."
    });
  }

  async function supabaseRequest(path, options = {}) {
    const response = await fetch(supabaseUrl + path, {
      method: options.method || "GET",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + (options.token || serviceKey),
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {})
    });

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  }

  let createdUserId = null;

  try {
    // Valida o token com o Supabase Auth.
    // O cargo informado pelo navegador nunca é utilizado.
    const authorization = String(
      req.headers.authorization || ""
    );

    const tokenMatch = authorization.match(/^Bearer\s+(\S+)$/i);

    if (!tokenMatch) {
      return res.status(401).json({
        success: false,
        error: "Entre no sistema para cadastrar usuários."
      });
    }

    const session = await supabaseRequest("/auth/v1/user", {
      token: tokenMatch[1]
    });

    if (!session.ok || !session.data?.id) {
      return res.status(401).json({
        success: false,
        error: "Seu login expirou. Entre novamente."
      });
    }

    // Confere a autorização registrada no banco.
    const admin = await supabaseRequest(
      "/rest/v1/bryx_memberships" +
      "?select=user_id,is_admin,active" +
      "&user_id=eq." + encodeURIComponent(session.data.id)
    );

    if (!admin.ok) {
      return res.status(503).json({
        success: false,
        error: "Não foi possível verificar sua permissão."
      });
    }

    const membership = Array.isArray(admin.data)
      ? admin.data[0]
      : null;

    if (
      membership?.is_admin !== true ||
      membership?.active !== true
    ) {
      return res.status(403).json({
        success: false,
        error: "Somente o administrador pode cadastrar assinantes."
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
        error: "O cadastro enviado não é um JSON válido."
      });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        error: "Preencha os dados do usuário."
      });
    }

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = typeof body.password === "string"
      ? body.password
      : "";
    const operation = String(body.operation || "").trim();
    const slug = normalizeSlug(body.slug || operation);

    if (!name || name.length > 120) {
      return res.status(400).json({
        success: false,
        error: "Informe um nome com até 120 caracteres."
      });
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        success: false,
        error: "Informe um e-mail válido."
      });
    }

    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({
        success: false,
        error: "A senha deve ter entre 10 e 128 caracteres."
      });
    }

    if (!operation || operation.length > 120) {
      return res.status(400).json({
        success: false,
        error: "Informe o nome da operação."
      });
    }

    if (
      !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug) ||
      slug.length > 40 ||
      ["master", "jhonyelly", "guest", "global"].includes(slug)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Use um identificador de operação com até 40 caracteres, " +
          "contendo apenas letras sem acentos, números e underscores. " +
          "Master e Jhonyelly são identificadores reservados."
      });
    }

    // Nunca reutiliza uma operação existente.
    const existing = await supabaseRequest(
      "/rest/v1/bryx_operations?select=slug&slug=eq." +
      encodeURIComponent(slug)
    );

    if (!existing.ok || !Array.isArray(existing.data)) {
      return res.status(503).json({
        success: false,
        error: "Não foi possível consultar as operações."
      });
    }

    if (existing.data.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Esse identificador de operação já está em uso."
      });
    }

    // O Supabase Auth armazena a senha.
    // Ela não é gravada nas tabelas do painel nem devolvida na resposta.
    const created = await supabaseRequest("/auth/v1/admin/users", {
      method: "POST",
      body: {
        email,
        password,
        email_confirm: true,
        user_metadata: {
          name,
          operation
        }
      }
    });

    if (!created.ok || !created.data?.id) {
      return res.status(created.status === 422 ? 400 : 502).json({
        success: false,
        error:
          "Não foi possível criar o login. Verifique se o e-mail " +
          "já está cadastrado e se a senha atende às regras do Supabase."
      });
    }

    createdUserId = created.data.id;

    // A função SQL cria as quatro tabelas, o vínculo e as permissões
    // dentro de uma única transação, sem copiar dados de outros usuários.
    const provisioned = await supabaseRequest(
      "/rest/v1/rpc/bryx_provision_operation",
      {
        method: "POST",
        body: {
          p_slug: slug,
          p_name: operation,
          p_user_id: createdUserId
        }
      }
    );

    if (!provisioned.ok) {
      // Confere se a operação foi concluída apesar de uma falha
      // na resposta. Não apaga automaticamente um login recém-criado.
      const verification = await supabaseRequest(
        "/rest/v1/bryx_memberships" +
        "?select=operation_slug" +
        "&user_id=eq." + encodeURIComponent(createdUserId)
      );

      const linked = verification.ok &&
        Array.isArray(verification.data) &&
        verification.data.some(
          item => item.operation_slug === slug
        );

      if (!linked) {
        return res.status(503).json({
          success: false,
          pending: true,
          user_id: createdUserId,
          error:
            "O login foi criado, mas a criação das tabelas não foi " +
            "confirmada. O administrador precisa verificar este " +
            "cadastro antes de tentar novamente."
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: "Login e tabelas individuais criados com sucesso.",
      user: {
        id: createdUserId,
        name,
        email,
        operation,
        slug,
        role: "Usuário",
        status: "Ativo"
      },
      tables: {
        orders: "orders_" + slug,
        products: "products_" + slug,
        expenses: "expenses_" + slug,
        ads_campaigns: "ads_campaigns_" + slug
      }
    });
  } catch {
    return res.status(503).json({
      success: false,
      pending: Boolean(createdUserId),
      ...(createdUserId ? { user_id: createdUserId } : {}),
      error: createdUserId
        ? "O login foi criado, mas o cadastro não foi confirmado. " +
          "Verifique o cadastro antes de tentar novamente."
        : "Não foi possível concluir a solicitação. Tente novamente."
    });
  }
}
