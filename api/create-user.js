// Vercel: api/create-user.js.
// SUPABASE_SERVICE_ROLE_KEY fica somente nas variáveis do servidor.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!['GET', 'POST', 'PATCH'].includes(req.method)) {
    return res.status(405).json({
      success: false,
      error: 'Método não permitido.'
    });
  }

  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(503).json({
      success: false,
      error: 'Servidor sem configuração do Supabase.'
    });
  }

  const call = async (
    path,
    method = 'GET',
    body,
    bearer = key
  ) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000)
    });

    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error('Falha ao consultar o Supabase.');
      error.status = response.status;
      throw error;
    }

    return data;
  };

  const read = (table, query = '') =>
    call(`/rest/v1/${table}?${query}`);

  const encoded = encodeURIComponent;

  const webhook = async (slug) => {
    const [record] = await read(
      'bryx_webhook_credentials',
      `operation_slug=eq.${encoded(slug)}&select=token`
    );

    if (!record) {
      throw new Error(
        'Credencial de webhook não configurada. Execute o SQL de preparação.'
      );
    }

    const base = (
      process.env.WEBHOOK_BASE_URL ||
      'https://bh-webhook-api.vercel.app'
    ).replace(/\/$/, '');

    return (
      `${base}/api/webhook?slug=${encoded(slug)}` +
      `&token=${encoded(record.token)}`
    );
  };

  const toUser = (membership, operations) => ({
    id: membership.user_id,
    name: membership.name || membership.email || 'Usuário',
    email: membership.email || '',
    role: membership.is_admin ? 'Administrador' : 'Usuário',
    operation:
      operations.find(
        operation => operation.slug === membership.operation_slug
      )?.name || membership.operation_slug,
    slug: membership.operation_slug,
    status: membership.active ? 'Ativo' : 'Inativo',
    created_at: membership.created_at,
    due_date: membership.due_date
  });

  try {
    const bearer = String(
      req.headers.authorization || ''
    ).match(/^Bearer (.+)$/i)?.[1];

    if (!bearer) {
      return res.status(401).json({
        success: false,
        error: 'Faça login para continuar.'
      });
    }

    let auth;

    try {
      auth = await call(
        '/auth/v1/user',
        'GET',
        undefined,
        bearer
      );
    } catch {
      return res.status(401).json({
        success: false,
        error: 'Sessão inválida. Entre novamente.'
      });
    }

    const [actor] = await read(
      'bryx_memberships',
      `user_id=eq.${encoded(auth.id)}&select=*`
    );

    if (!actor?.active) {
      return res.status(403).json({
        success: false,
        error: 'Acesso inativo ou não autorizado.'
      });
    }

    // Assinantes recebem somente o próprio webhook.
    if (req.method === 'GET' && !actor.is_admin) {
      return res.status(200).json({
        success: true,
        webhook_url: await webhook(actor.operation_slug)
      });
    }

    if (!actor.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Somente o administrador pode gerenciar usuários.'
      });
    }

    // Lista administrativa, sem retornar senhas.
    if (req.method === 'GET') {
      const memberships = await read(
        'bryx_memberships',
        'select=*&order=created_at.asc'
      );

      const operations = await read(
        'bryx_operations',
        'select=slug,name'
      );

      const users = [];

      for (const membership of memberships) {
        users.push({
          ...toUser(membership, operations),
          webhook_url: await webhook(membership.operation_slug)
        });
      }

      return res.status(200).json({
        success: true,
        users,
        webhook_url: users.find(
          user => user.id === auth.id
        )?.webhook_url
      });
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : (req.body || {});

    const name = String(body.name || '').trim();
    const due = body.due_date || null;

    if (!name || name.length > 120) {
      return res.status(400).json({
        success: false,
        error: 'Informe um nome de até 120 caracteres.'
      });
    }

    if (
      due &&
      (
        !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
        !Number.isFinite(Date.parse(due)) ||
        new Date(due).toISOString().slice(0, 10) !== due
      )
    ) {
      return res.status(400).json({
        success: false,
        error: 'Data de vencimento inválida.'
      });
    }

    if (!['Ativo', 'Inativo'].includes(body.status || 'Ativo')) {
      return res.status(400).json({
        success: false,
        error: 'Status inválido.'
      });
    }

    const password = body.password === undefined
      ? ''
      : String(body.password);

    if (
      (req.method === 'POST' || password) &&
      (password.length < 12 || password.length > 128)
    ) {
      return res.status(400).json({
        success: false,
        error: 'A senha deve ter entre 12 e 128 caracteres.'
      });
    }

    // Editar nome, assinatura, status ou redefinir senha.
    if (req.method === 'PATCH') {
      const id = String(body.id || '');

      if (!/^[a-f0-9-]{36}$/i.test(id)) {
        return res.status(400).json({
          success: false,
          error: 'Usuário inválido.'
        });
      }

      const [target] = await read(
        'bryx_memberships',
        `user_id=eq.${encoded(id)}&select=*`
      );

      if (!target) {
        return res.status(404).json({
          success: false,
          error: 'Usuário não encontrado.'
        });
      }

      if (target.is_admin && body.status === 'Inativo') {
        return res.status(400).json({
          success: false,
          error: 'O administrador não pode ser inativado.'
        });
      }

      // Após ativar o isolamento, a RLS verifica este status
      // em cada acesso ao banco, inclusive com sessão já aberta.
      const [saved] = await call(
        `/rest/v1/bryx_memberships?user_id=eq.${encoded(id)}`,
        'PATCH',
        {
          name,
          due_date: due,
          active: body.status !== 'Inativo'
        }
      );

      let password_updated = false;

      if (password) {
        try {
          await call(
            `/auth/v1/admin/users/${encoded(id)}`,
            'PUT',
            { password }
          );

          password_updated = true;
        } catch {
          return res.status(200).json({
            success: true,
            user: toUser(
              saved,
              await read('bryx_operations', 'select=slug,name')
            ),
            warning:
              'Cadastro salvo, mas a senha não foi alterada. ' +
              'Tente redefini-la novamente.'
          });
        }
      }

      return res.status(200).json({
        success: true,
        user: {
          ...toUser(
            saved,
            await read('bryx_operations', 'select=slug,name')
          ),
          webhook_url: await webhook(saved.operation_slug)
        },
        password_updated
      });
    }

    // Criar usuário e provisionar sua operação.
    const email = String(body.email || '').trim().toLowerCase();
    const operation = String(body.operation || '').trim();
    const attach = body.attach_existing === true;

    const slug = attach
      ? 'jhonyelly'
      : String(body.slug || '').trim().toLowerCase();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !operation ||
      operation.length > 120 ||
      !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(slug) ||
      slug.length > 40 ||
      ['master', 'guest', 'global'].includes(slug) ||
      (!attach && slug === 'jhonyelly')
    ) {
      return res.status(400).json({
        success: false,
        error: 'Revise e-mail, operação e código da operação.'
      });
    }

    if (attach) {
      if (email !== 'jhonyellybrito@gmail.com') {
        return res.status(400).json({
          success: false,
          error:
            'Esta migração é exclusiva da conta Jhonyelly existente.'
        });
      }

      const existingMemberships = await read(
        'bryx_memberships',
        'operation_slug=eq.jhonyelly&select=user_id'
      );

      if (existingMemberships.length) {
        return res.status(409).json({
          success: false,
          error: 'Jhonyelly já foi vinculada.'
        });
      }
    } else {
      const existingOperations = await read(
        'bryx_operations',
        `slug=eq.${encoded(slug)}&select=slug`
      );

      if (existingOperations.length) {
        return res.status(409).json({
          success: false,
          error:
            'Código de operação já utilizado. Escolha outro.'
        });
      }
    }

    let newAuth;

    try {
      newAuth = await call(
        '/auth/v1/admin/users',
        'POST',
        {
          email,
          password,
          email_confirm: true,
          user_metadata: { name }
        }
      );
    } catch (error) {
      return res.status(error.status === 422 ? 409 : 400).json({
        success: false,
        error:
          'Não foi possível criar o acesso. Verifique se o e-mail ' +
          'já existe e se a senha atende à política do Supabase.'
      });
    }

    const args = {
      p_slug: slug,
      p_operation: operation,
      p_user_id: newAuth.id,
      p_name: name,
      p_email: email,
      p_due_date: due,
      p_active: body.status !== 'Inativo',
      p_attach_existing: attach
    };

    try {
      await call(
        '/rest/v1/rpc/bryx_register_user',
        'POST',
        args
      );
    } catch {
      // A resposta pode ter sido perdida depois do commit.
      // Confere o vínculo antes de considerar o cadastro pendente.
      const rows = await read(
        'bryx_memberships',
        `user_id=eq.${encoded(newAuth.id)}&select=*`
      ).catch(() => []);

      if (!rows.length) {
        return res.status(503).json({
          success: false,
          pending: true,
          user_id: newAuth.id,
          error:
            'O acesso foi criado, mas o provisionamento não foi ' +
            'confirmado. Não cadastre de novo: confira o SQL e ' +
            'use o procedimento de recuperação com o ID: ' +
            newAuth.id
        });
      }
    }

    const [membership] = await read(
      'bryx_memberships',
      `user_id=eq.${encoded(newAuth.id)}&select=*`
    );

    return res.status(201).json({
      success: true,
      user: {
        ...toUser(
          membership,
          await read('bryx_operations', 'select=slug,name')
        ),
        webhook_url: await webhook(slug)
      }
    });
  } catch (error) {
    console.error('BRYX users API:', error.status || 'internal');

    return res.status(500).json({
      success: false,
      error:
        'Não foi possível concluir. Confira a configuração ' +
        'e os logs do servidor.'
    });
  }
}
