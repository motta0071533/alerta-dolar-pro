// netlify/functions/subscribe.js
// POST   /api/subscribe  { subscription, preco_alvo?, ativo? } -> salva/atualiza a inscrição Web Push no Supabase
//                                                              (preco_alvo opcional: número = define o alvo; null = remove;
//                                                               ativo = USDTBRL | EURBRL | PAXGBRL | BTCUSDT, padrão USDTBRL)
// POST   /api/subscribe  { endpoint, preco_alvo, ativo? }   -> só atualiza o alvo (e o ativo vigiado) de uma inscrição já salva
// POST   /api/subscribe  { subscription?, endpoint?, prefs: { score, flash, alvo, viagem } }
//                                                           -> salva os filtros de notificação do aparelho (booleans)
// POST   /api/subscribe  { subscription?, endpoint?, viagem_ultima_cotacao, viagem_ativo? }
//                                                           -> guarda a cotação da última compra do Modo Viagem (USDTBRL | EURBRL)
//                                                              e rearma o aviso (viagem_alertado = false); null = remove
// POST   /api/subscribe  { action: 'status', endpoint }     -> devolve { preco_alvo, alvo_disparado, ativo, prefs, viagem_* } daquele aparelho
// DELETE /api/subscribe  { endpoint }                       -> remove a inscrição (usuário desativou)
// GET    /api/subscribe                                     -> devolve a VAPID_PUBLIC_KEY (o painel usa se não houver chave fixa no HTML)
//
// Login (opcional): se a requisição trouxer `Authorization: Bearer <access_token do Supabase Auth>`, o token é validado no servidor
// e o aparelho passa a ficar vinculado ao usuário (coluna push_subscriptions.user_id). Token ausente/inválido = aparelho anônimo, como antes.
//
// Variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY

const { createClient } = require('@supabase/supabase-js');

// Só aceita endpoints dos serviços de push reais (impede que alguém grave URLs arbitrárias na tabela).
function isPushHost(host) {
  return host === 'fcm.googleapis.com' ||
    host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com');
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// Ativos que o robô (check-dollar.js) monitora, com o maior preço-alvo aceito em cada um (na moeda do ativo).
const ATIVOS = {
  USDTBRL: { max: 1000 },       // R$
  EURBRL:  { max: 1000 },       // R$
  PAXGBRL: { max: 1000000 },    // R$
  BTCUSDT: { max: 10000000 }    // US$
};
const ATIVO_PADRAO = 'USDTBRL'; // apps antigos (sem o campo "ativo") só conheciam o USDT/BRL

// Filtros de notificação (coluna prefs jsonb). Tudo ligado por padrão; só `false` desliga.
const PREF_KEYS = ['score', 'flash', 'alvo', 'viagem'];
function normPrefs(p) {
  const out = {};
  PREF_KEYS.forEach(k => { out[k] = !(p && p[k] === false); });
  return out;
}

// Modo Viagem: só dólar e euro; cotação paga em R$ por unidade.
const VIAGEM_ATIVOS = ['USDTBRL', 'EURBRL'];
const VIAGEM_MAX_RATE = 100;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function validEndpoint(ep) {
  if (typeof ep !== 'string' || ep.length > 1000) return false;
  try {
    const u = new URL(ep);
    return u.protocol === 'https:' && isPushHost(u.hostname);
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY } = process.env;
  const method = event.httpMethod;

  if (method === 'GET') {
    if (!VAPID_PUBLIC_KEY) return json(500, { error: 'VAPID_PUBLIC_KEY não configurada.' });
    return json(200, { publicKey: VAPID_PUBLIC_KEY });
  }
  if (method !== 'POST' && method !== 'DELETE') return json(405, { error: 'Método não permitido.' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Netlify.' });
  }
  if (event.body && event.body.length > 8000) return json(413, { error: 'Corpo grande demais.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'JSON inválido.' }); }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    // usuário logado (opcional): o id vem do token validado pelo Supabase, nunca do corpo da requisição
    let userId = null;
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const bearer = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (bearer && bearer[1].length < 4000) {
      try {
        const { data: u, error: uErr } = await supabase.auth.getUser(bearer[1]);
        if (!uErr && u && u.user) userId = u.user.id;
      } catch (e) { /* token inválido: segue como anônimo */ }
    }

    if (method === 'DELETE') {
      if (!validEndpoint(body.endpoint)) return json(400, { error: 'Endpoint inválido.' });
      const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', body.endpoint);
      if (error) throw error;
      return json(200, { ok: true, removed: true });
    }

    // ---- status do alvo (para o painel mostrar o estado real) ----
    if (body.action === 'status') {
      if (!validEndpoint(body.endpoint)) return json(400, { error: 'Endpoint inválido.' });
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('preco_alvo, alvo_disparado, ativo, prefs, viagem_ultima_cotacao, viagem_ativo, viagem_alertado')
        .eq('endpoint', body.endpoint).maybeSingle();
      if (error) throw error;
      return json(200, {
        ok: true,
        preco_alvo: data && data.preco_alvo != null ? Number(data.preco_alvo) : null,
        alvo_disparado: data ? !!data.alvo_disparado : false,
        ativo: data && ATIVOS[data.ativo] ? data.ativo : ATIVO_PADRAO,
        prefs: normPrefs(data && data.prefs),
        viagem_ultima_cotacao: data && data.viagem_ultima_cotacao != null ? Number(data.viagem_ultima_cotacao) : null,
        viagem_ativo: data && VIAGEM_ATIVOS.includes(data.viagem_ativo) ? data.viagem_ativo : ATIVO_PADRAO,
        viagem_alertado: data ? !!data.viagem_alertado : false
      });
    }

    // ---- ativo vigiado pelo preço-alvo (opcional) ----
    const hasAtivo = body.ativo !== undefined && body.ativo !== null;
    if (hasAtivo && (typeof body.ativo !== 'string' || !Object.prototype.hasOwnProperty.call(ATIVOS, body.ativo))) {
      return json(400, { error: 'ativo inválido.' });
    }

    // ---- preco_alvo (opcional): número > 0 define o alvo; null remove ----
    const hasTarget = Object.prototype.hasOwnProperty.call(body, 'preco_alvo');
    let alvo = null;
    if (hasTarget && body.preco_alvo !== null) {
      const ativoDoAlvo = hasAtivo ? body.ativo : ATIVO_PADRAO;
      alvo = typeof body.preco_alvo === 'number' || typeof body.preco_alvo === 'string' ? Number(body.preco_alvo) : NaN;
      if (!isFinite(alvo) || alvo <= 0 || alvo >= ATIVOS[ativoDoAlvo].max) return json(400, { error: 'preco_alvo inválido.' });
      alvo = Math.round(alvo * 10000) / 10000;
    }
    // salvar um novo alvo (ou removê-lo) sempre rearma o aviso. O ativo só muda junto com o alvo:
    // um alvo antigo nunca é reaproveitado para outro ativo por engano.
    const targetCols = {};
    if (hasTarget) {
      targetCols.preco_alvo = alvo;
      targetCols.alvo_disparado = false;
      if (alvo !== null) targetCols.ativo = hasAtivo ? body.ativo : ATIVO_PADRAO;
      else if (hasAtivo) targetCols.ativo = body.ativo;
    }

    // ---- prefs (opcional): filtros de notificação. Objeto com booleans; chave ausente/inválida = ligado ----
    const hasPrefs = Object.prototype.hasOwnProperty.call(body, 'prefs');
    const prefCols = {};
    if (hasPrefs) {
      if (!body.prefs || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) return json(400, { error: 'prefs inválido.' });
      prefCols.prefs = normPrefs(body.prefs);
    }

    // ---- Modo Viagem (opcional): cotação paga na última compra (R$ por unidade) e a moeda; null remove ----
    // Salvar uma nova cotação (ou removê-la) sempre rearma o aviso (viagem_alertado = false).
    const hasViagem = Object.prototype.hasOwnProperty.call(body, 'viagem_ultima_cotacao');
    const viagemCols = {};
    if (hasViagem) {
      if (body.viagem_ultima_cotacao === null) {
        viagemCols.viagem_ultima_cotacao = null;
      } else {
        const v = typeof body.viagem_ultima_cotacao === 'number' || typeof body.viagem_ultima_cotacao === 'string'
          ? Number(body.viagem_ultima_cotacao) : NaN;
        if (!isFinite(v) || v <= 0 || v >= VIAGEM_MAX_RATE) return json(400, { error: 'viagem_ultima_cotacao inválida.' });
        viagemCols.viagem_ultima_cotacao = Math.round(v * 10000) / 10000;
      }
      const va = body.viagem_ativo === undefined || body.viagem_ativo === null ? ATIVO_PADRAO : body.viagem_ativo;
      if (typeof va !== 'string' || !VIAGEM_ATIVOS.includes(va)) return json(400, { error: 'viagem_ativo inválido.' });
      viagemCols.viagem_ativo = va;
      viagemCols.viagem_alertado = false;
    }

    // tudo que o corpo quer alterar na linha do aparelho
    const extraCols = { ...targetCols, ...prefCols, ...viagemCols };
    if (userId) extraCols.user_id = userId;   // vincula o aparelho (e seus alertas) à conta
    const hasExtra = hasTarget || hasPrefs || hasViagem;

    const sub = body.subscription;

    // ---- só colunas (alvo, prefs, viagem) sem subscription: { endpoint, ... } ----
    if (!sub && hasExtra) {
      if (!validEndpoint(body.endpoint)) return json(400, { error: 'Endpoint inválido.' });
      const { data, error } = await supabase
        .from('push_subscriptions').update(extraCols).eq('endpoint', body.endpoint).select('id');
      if (error) throw error;
      if (!data || !data.length) return json(404, { ok: false, error: 'Aparelho não inscrito. Ative as notificações push primeiro.' });
      return json(200, { ok: true });
    }

    const keys = sub && sub.keys;
    if (!sub || !validEndpoint(sub.endpoint) || !keys ||
        typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
        keys.p256dh.length > 200 || keys.auth.length > 100 ||
        !B64URL.test(keys.p256dh) || !B64URL.test(keys.auth)) {
      return json(400, { error: 'Inscrição inválida.' });
    }
    if (body.endpoint !== undefined && body.endpoint !== sub.endpoint) {
      return json(400, { error: 'endpoint diferente da inscrição enviada.' });
    }

    // grava só o que o web-push precisa (sanitizado)
    const clean = {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime == null ? null : sub.expirationTime,
      keys: { p256dh: keys.p256dh, auth: keys.auth }
    };

    // upsert por endpoint: reinscrever o mesmo aparelho não duplica. Só as colunas enviadas são alteradas,
    // então os "ultimo_alerta_*" / "ultimo_flash_*" / criado_em, o alvo (com o ativo), as prefs e o Modo Viagem atuais
    // são preservados quando esses campos não vêm no corpo.
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({ endpoint: clean.endpoint, subscription: clean, ...extraCols }, { onConflict: 'endpoint' });
    if (error) throw error;

    return json(200, { ok: true });
  } catch (err) {
    return json(502, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};