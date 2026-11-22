// server.js — Alerta Dólar Pro no Render (Express)
//
// Reaproveita SEM alteração a lógica de netlify/functions/subscribe.js e netlify/functions/check-dollar.js
// (o Express só converte a requisição no formato "event" do Netlify). Mantenha a pasta netlify/functions/.
//
// Rotas:
//   GET|POST|DELETE /api/subscribe
//   GET             /api/check-dollar?secret=...&test=true
//   POST            /api/leads                       { nome?, contato, interesse? }          (público)
//   GET             /api/admin/stats                 header x-admin-secret (ou ?secret=)      (CRON_SECRET)
//   POST            /api/admin/broadcast             { secret?, title, body, url? }           (CRON_SECRET)
//   GET             /api/maxima-dia                  máxima do dia (Brasília) dos 5 preços do painel  (público, somente leitura)
//   GET             /healthz
//   estáticos       index.html, manifest.json, sw.js, icons/ ...
//
// Variáveis de ambiente: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
//                        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const subscribe = require('./netlify/functions/subscribe.js');
const checkDollar = require('./netlify/functions/check-dollar.js');
const dailyHigh = require('./daily-high.js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render fica atrás de um proxy (req.ip passa a ser o IP real do cliente)

// Mesmos headers globais do netlify.toml
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

/* ------------------------------- Utilidades ------------------------------- */
let _supabase = null;
function getSupabase() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!_supabase) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _supabase;
}

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const errMsg = e => String(e && e.message ? e.message : e);

// Limitador simples em memória (por IP). Suficiente para uma instância única.
function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, 60 * 1000).unref();
  return {
    // conta uma tentativa; devolve true se ainda está dentro do limite
    hit(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
      v.n++;
      return v.n <= max;
    },
    blocked(key) {
      const v = hits.get(key);
      return !!v && v.reset > Date.now() && v.n > max;
    },
    clear(key) { hits.delete(key); }
  };
}
const leadLimiter = makeLimiter(6, 60 * 60 * 1000);        // 6 cadastros por IP por hora
const adminFailLimiter = makeLimiter(8, 15 * 60 * 1000);   // 8 senhas erradas por IP a cada 15 min

// Comparação em tempo constante (hash antes, para não vazar o tamanho da senha)
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Autentica rotas admin. Prefere o header x-admin-secret (não vai para o log de URLs); aceita ?secret= e body.secret.
function adminAuth(req, res) {
  const expected = process.env.CRON_SECRET;
  noStore(res);
  if (!expected) { res.status(500).json({ ok: false, error: 'CRON_SECRET não configurada no servidor.' }); return false; }
  if (adminFailLimiter.blocked(req.ip)) {
    res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' }); return false;
  }
  const given = req.get('x-admin-secret') || (req.body && req.body.secret) || req.query.secret || '';
  if (!given || !safeEqual(given, expected)) {
    adminFailLimiter.hit(req.ip);
    res.status(401).json({ ok: false, error: 'Senha inválida.' }); return false;
  }
  adminFailLimiter.clear(req.ip);
  return true;
}

/* ------------------------- Adaptador Netlify -> Express ------------------------- */
const rawBody = express.text({ type: () => true, limit: '16kb' });

function toEvent(req) {
  const queryStringParameters = {};
  for (const [k, v] of Object.entries(req.query)) {
    queryStringParameters[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return {
    httpMethod: req.method,
    path: req.path,
    headers: req.headers,
    queryStringParameters,
    body: typeof req.body === 'string' && req.body.length ? req.body : null,
    isBase64Encoded: false
  };
}

function adapt(handler) {
  return async (req, res) => {
    try {
      const result = await handler(toEvent(req));
      res.status(result.statusCode || 200);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      res.send(result.body == null ? '' : result.body);
    } catch (err) {
      console.error('Erro não tratado em', req.path, err);
      res.status(500).json({ ok: false, error: 'Erro interno.' });
    }
  };
}

app.all('/api/subscribe', rawBody, adapt(subscribe.handler));
app.all('/api/check-dollar', rawBody, adapt(checkDollar.handler));

/* ------------------------- Máxima do dia (público, leitura) ------------------------- */
app.get('/api/maxima-dia', async (req, res) => {
  noStore(res);
  try {
    await dailyHigh.ensureFresh();
    res.json({ ok: true, ...dailyHigh.snapshot() });
  } catch (err) {
    res.status(502).json({ ok: false, error: errMsg(err) });
  }
});

/* ------------------------------ Leads (público) ------------------------------ */
const jsonBody = express.json({ limit: '8kb' });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// E-mail em minúsculas; WhatsApp só com dígitos (DDI 55 se vier só DDD+número).
function normContato(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 120) return null;
  if (s.includes('@')) return EMAIL_RE.test(s) ? s.toLowerCase() : null;
  let d = s.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 13 ? d : null;
}

app.post('/api/leads', jsonBody, async (req, res) => {
  noStore(res);
  const b = req.body && typeof req.body === 'object' ? req.body : {};

  // honeypot: robôs preenchem o campo escondido; fingimos sucesso e não gravamos
  if (typeof b.website === 'string' && b.website.trim()) return res.json({ ok: true });

  if (!leadLimiter.hit(req.ip)) return res.status(429).json({ ok: false, error: 'Muitas tentativas. Tente mais tarde.' });

  const contato = normContato(b.contato);
  if (!contato) return res.status(400).json({ ok: false, error: 'Informe um WhatsApp (com DDD) ou e-mail válido.' });

  const nome = typeof b.nome === 'string' ? b.nome.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  const interesse = (typeof b.interesse === 'string' && b.interesse.trim() ? b.interesse.trim() : 'Geral').slice(0, 60);

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'Servidor sem Supabase configurado.' });

  try {
    // mesmo contato de novo: responde sucesso sem duplicar a linha
    const { data: dup, error: dupErr } = await supabase.from('leads_cambio').select('id').eq('contato', contato).limit(1);
    if (dupErr) throw dupErr;
    if (!dup || !dup.length) {
      const { error } = await supabase.from('leads_cambio').insert({ nome: nome || null, contato, interesse });
      if (error) throw error;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao salvar lead:', errMsg(err));
    res.status(502).json({ ok: false, error: 'Não foi possível salvar agora. Tente de novo em instantes.' });
  }
});

/* ------------------------------ Admin (CRON_SECRET) ------------------------------ */
async function countRows(supabase, build) {
  const { count, error } = await build(supabase.from('push_subscriptions').select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
}

app.get('/api/admin/stats', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'Servidor sem Supabase configurado.' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 5000);
  try {
    const [devices, targets, trips, leadsCount, leadsRes] = await Promise.all([
      countRows(supabase, q => q),
      countRows(supabase, q => q.not('preco_alvo', 'is', null)),
      countRows(supabase, q => q.not('viagem_ultima_cotacao', 'is', null)),
      supabase.from('leads_cambio').select('id', { count: 'exact', head: true }),
      supabase.from('leads_cambio').select('nome, contato, interesse, created_at').order('created_at', { ascending: false }).limit(limit)
    ]);
    if (leadsCount.error) throw leadsCount.error;
    if (leadsRes.error) throw leadsRes.error;
    res.json({
      ok: true,
      totals: { devices, targets, trips, leads: leadsCount.count || 0 },
      leads: leadsRes.data || [],
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: errMsg(err) });
  }
});

let broadcastBusy = false; // evita duplo clique / duas rodadas simultâneas

app.post('/api/admin/broadcast', jsonBody, async (req, res) => {
  if (!adminAuth(req, res)) return;
  const b = req.body && typeof req.body === 'object' ? req.body : {};

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  let url = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : '/index.html';
  if (!title || title.length > 80) return res.status(400).json({ ok: false, error: 'Título obrigatório (até 80 caracteres).' });
  if (!body || body.length > 300) return res.status(400).json({ ok: false, error: 'Mensagem obrigatória (até 300 caracteres).' });
  // só caminhos do próprio app (o service worker abre essa URL ao tocar na notificação)
  if (url.length > 300 || !url.startsWith('/') || url.startsWith('//')) {
    return res.status(400).json({ ok: false, error: 'O link deve ser um caminho do app, como /index.html#viagem.' });
  }

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return res.status(500).json({ ok: false, error: 'Defina VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT.' });
  }
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'Servidor sem Supabase configurado.' });
  if (broadcastBusy) return res.status(409).json({ ok: false, error: 'Já existe um disparo em andamento. Aguarde terminar.' });

  broadcastBusy = true;
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    // lê TODAS as inscrições, em páginas de 1000 (limite do Supabase por consulta)
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('push_subscriptions').select('endpoint, subscription').order('id', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    if (!rows.length) return res.json({ ok: true, total: 0, delivered: 0, failed: 0, removed: 0, note: 'Nenhum aparelho inscrito.' });

    const payload = JSON.stringify({
      type: 'broadcast',
      title, body,
      tag: 'adp-broadcast',
      url,
      t: Date.now()
    });
    const opts = { timeout: 8000, TTL: 6 * 3600, urgency: 'normal', topic: 'adp-broadcast' };

    let delivered = 0, failed = 0;
    const expired = [];
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const results = await Promise.allSettled(chunk.map(r => webpush.sendNotification(r.subscription, payload, opts)));
      results.forEach((r, k) => {
        if (r.status === 'fulfilled') { delivered++; return; }
        const code = r.reason && r.reason.statusCode;
        if (code === 404 || code === 410) expired.push(chunk[k].endpoint); else failed++;
      });
    }

    // limpa inscrições expiradas (404/410), em lotes
    let removed = 0;
    for (let i = 0; i < expired.length; i += 100) {
      const part = expired.slice(i, i + 100);
      const { error } = await supabase.from('push_subscriptions').delete().in('endpoint', part);
      if (error) console.error('Falha ao remover inscrições expiradas:', error.message); else removed += part.length;
    }

    console.log(`[broadcast] total=${rows.length} entregues=${delivered} falhas=${failed} removidas=${removed}`);
    res.json({ ok: true, total: rows.length, delivered, failed, removed });
  } catch (err) {
    console.error('Erro no broadcast:', errMsg(err));
    res.status(502).json({ ok: false, error: errMsg(err) });
  } finally {
    broadcastBusy = false;
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// JSON inválido / corpo grande demais nas rotas com express.json()
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const status = err.status || err.statusCode || 400;
    return res.status(status === 413 ? 413 : 400).json({ ok: false, error: status === 413 ? 'Corpo grande demais.' : 'JSON inválido.' });
  }
  next(err);
});

/* ------------------------------ Arquivos estáticos ------------------------------ */
// Bloqueia o que NÃO pode ser público: código do servidor, funções, package*.json, node_modules, dotfiles etc.
const BLOCKED = /^\/(netlify(\/|\.toml$)|node_modules(\/|$)|server\.js$|daily-high\.js$|package(-lock)?\.json$|render\.yaml$|[^/]*\.sql$|\.)/i;
app.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch (e) { return res.status(400).end(); }
  if (BLOCKED.test(p) || p.includes('/.')) return res.status(404).end();
  next();
});

app.use(express.static(__dirname, {
  index: 'index.html',
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'sw.js') {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
  }
}));

app.use((req, res) => res.status(404).type('text').send('Não encontrado.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Alerta Dólar Pro rodando na porta ${PORT}`);
  dailyHigh.start(getSupabase);   // rastreia a máxima do dia (Brasília) e grava no Supabase
});