// server.js — Alerta Dólar Pro no Render (Express)
//
// Reaproveita SEM alteração a lógica de netlify/functions/subscribe.js e netlify/functions/check-dollar.js:
// o Express só converte a requisição no formato "event" do Netlify e devolve { statusCode, headers, body }.
// Por isso a pasta netlify/functions/ precisa continuar no projeto (ela não é mais servida ao público).
//
// Rotas:
//   GET|POST|DELETE /api/subscribe
//   GET             /api/check-dollar?secret=...&test=true
//   GET             /healthz
//   estáticos       index.html, manifest.json, sw.js, icons/ ...

const path = require('path');
const express = require('express');

const subscribe = require('./netlify/functions/subscribe.js');
const checkDollar = require('./netlify/functions/check-dollar.js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render fica atrás de um proxy

// Mesmos headers globais do netlify.toml
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Health check (configure em Render > Settings > Health Check Path)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

/* ------------------------- Adaptador Netlify -> Express ------------------------- */
// O corpo chega como TEXTO (igual ao event.body do Netlify): o subscribe.js faz o próprio JSON.parse
// e responde 400 "JSON inválido." / 413 "Corpo grande demais." exatamente como antes.
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
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

/* ------------------------------ Arquivos estáticos ------------------------------ */
// Como a raiz do projeto é servida (express.static(__dirname)), bloqueamos o que NÃO pode ser público:
// código-fonte do servidor, funções, package*.json, node_modules, dotfiles (.env, .git) etc.
const BLOCKED = /^\/(netlify(\/|\.toml$)|node_modules(\/|$)|server\.js$|package(-lock)?\.json$|render\.yaml$|\.)/i;
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
    // o service worker precisa ser sempre revalidado (igual ao netlify.toml)
    if (path.basename(filePath) === 'sw.js') {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
  }
}));

app.use((req, res) => res.status(404).type('text').send('Não encontrado.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Alerta Dólar Pro rodando na porta ${PORT}`));