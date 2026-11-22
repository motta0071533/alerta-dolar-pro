// netlify/functions/check-dollar.js
// Motor de monitoramento 24/7 do Alerta Dólar Pro (Score de Oportunidade 0–100) com Web Push (VAPID).
// Monitora os 4 ativos do painel, em paralelo, a cada execução:
//   USDTBRL (Dólar em R$) · EURBRL (EURUSDT × USDTBRL) · PAXGBRL (PAXGUSDT × USDTBRL) · BTCUSDT (Bitcoin em US$)
//
// Acionado a cada 1 minuto pelo cron-job.org:
//   https://SEUSITE.netlify.app/api/check-dollar?secret=SUA_CHAVE
// A cada execução também dispara os avisos de preço-alvo (colunas ativo / preco_alvo / alvo_disparado),
// o Flash Crash (queda brusca em até 15 min) e o aviso do Modo Viagem (cotação abaixo da última compra).
// Cada aparelho só recebe o que deixou ligado em `prefs` (jsonb: score / flash / alvo / viagem). Sem prefs = tudo ligado.
// Teste imediato de push (ignora a trava anti-spam e envia para todos os aparelhos inscritos):
//   https://SEUSITE.netlify.app/api/check-dollar?secret=SUA_CHAVE&test=true
//
// Variáveis de ambiente (Netlify > Site configuration > Environment variables):
//   CRON_SECRET                (obrigatória) chave secreta usada em ?secret=
//   VAPID_PUBLIC_KEY           (obrigatória) chave pública VAPID (a mesma do index.html)
//   VAPID_PRIVATE_KEY          (obrigatória) chave privada VAPID (NUNCA no front-end)
//   VAPID_SUBJECT              (obrigatória) "mailto:voce@email.com" ou a URL do seu site
//   SUPABASE_URL               (obrigatória) https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  (obrigatória) chave service_role (NUNCA no front-end)

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const BINANCE_BASES = [
  'https://data-api.binance.vision', // funciona bem a partir de servidores nos EUA
  'https://api.binance.com'
];
const MB_URL = 'https://api.mercadobitcoin.net/api/v4/tickers?symbols=USDT-BRL';
const KRAKEN_URL = 'https://api.kraken.com/0/public/Ticker?pair=USDTBRL';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl';

const MINUTE = 60 * 1000;
const FIFTEEN_MIN = 15 * MINUTE;
const HOUR = 60 * MINUTE;

// Trava anti-spam (POR ATIVO):
// 1) o Score de AGORA precisa estar >= 75 e o Score de ~3 min atrás (fechamento de minuto) < 75;
// 2) cada aparelho só recebe um novo alerta do MESMO ativo a cada DEDUPE_MINUTES. A reserva é feita de forma
//    atômica no Supabase (uma coluna de "último alerta" por ativo), então execuções simultâneas não duplicam o push.
const LOOKBACK_MINUTES = 3;
const DEDUPE_MINUTES = 6;

// Flash Crash: queda de `flashPct` % ou mais entre a MÁXIMA dos últimos 15 min (janela móvel de candles de 1m,
// incluindo o minuto em andamento) e o preço atual. Dispara só no cruzamento (há ~3 min a queda ainda não batia o limite)
// e respeita a mesma trava de DEDUPE_MINUTES, numa coluna própria por ativo (`flashCol`) para não brigar com o alerta de Score.
const FLASH_WINDOW = 15 * MINUTE;

// Modo Viagem: avisa quando a cotação fica pelo menos 0,3% abaixo da última compra registrada no app.
const VIAGEM_DROP_PCT = 0.3;

// Preferências do aparelho (coluna prefs jsonb). Sem prefs, ou chave ausente = ligado; só `false` desliga.
// Filtro PostgREST para usar em .or(): `prefs->>chave` nulo (sem preferência) ou diferente de "false".
const prefOn = k => `prefs->>${k}.is.null,prefs->>${k}.neq.false`;

// Ativos monitorados. `via` = par da Binance multiplicado por USDTBRL (igual ao painel).
// `alertCol` = coluna do Supabase com o horário do último alerta de Score daquele ativo.
// USDTBRL mantém a coluna original (ultimo_alerta_em) para não perder o histórico existente.
// `flashCol` = coluna do último Flash Crash; `flashPct` = queda mínima (%) em até 15 min para disparar.
const ASSETS = {
  USDTBRL: { key: 'USDTBRL', label: 'USDT/BRL', name: 'Dólar',   cur: 'BRL', symbol: 'USDTBRL', digits: 4, alertCol: 'ultimo_alerta_em',      flashCol: 'ultimo_flash_usdtbrl', flashPct: 0.8 },
  EURBRL:  { key: 'EURBRL',  label: 'EUR/BRL',  name: 'Euro',    cur: 'BRL', via: 'EURUSDT',     digits: 4, alertCol: 'ultimo_alerta_eurbrl',  flashCol: 'ultimo_flash_eurbrl',  flashPct: 0.8 },
  PAXGBRL: { key: 'PAXGBRL', label: 'PAXG/BRL', name: 'Ouro',    cur: 'BRL', via: 'PAXGUSDT',    digits: 2, alertCol: 'ultimo_alerta_paxgbrl', flashCol: 'ultimo_flash_paxgbrl', flashPct: 0.8 },
  BTCUSDT: { key: 'BTCUSDT', label: 'BTC/USDT', name: 'Bitcoin', cur: 'USD', symbol: 'BTCUSDT', digits: 2, alertCol: 'ultimo_alerta_btcusdt', flashCol: 'ultimo_flash_btcusdt', flashPct: 3.5 }
};
const ASSET_LIST = Object.values(ASSETS);

// ==== SCORE ENGINE START (código idêntico no painel e no robô) ====
const SCORE_ACTIVE = 75; // Score mínimo para o sinal ficar ATIVO
const SCORE_STRONG = 85; // 85+ = Sinal Forte / Alta Confluência

// Limiares da queda em 24h (em %). Bitcoin é bem mais volátil que câmbio e ouro, então exige quedas maiores.
// "BTC" = chave BTCUSDT (vale para a exibição em US$ e em R$).
const DROP24_RULES = {
  fx:  { strong: -1.2, mild: -0.6 },  // USDTBRL, EURBRL, PAXGBRL
  btc: { strong: -5.0, mild: -3.0 }   // BTCUSDT / BTCBRL
};

function calcRSI(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function calcBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

// Preço de referência de 24h atrás: abertura do candle de 1h que começou 24 candles antes do atual.
// Calculado a partir dos candles de 1h do próprio ativo, então funciona também nos pares sintéticos (EUR, PAXG).
function ref24FromCandles(c1h) {
  if (!c1h || c1h.length < 25) return null;
  const r = c1h[c1h.length - 25].o;
  return isFinite(r) && r > 0 ? r : null;
}

// Fator 1 — RSI 15m (máx. 25 pts)
function ptsRsi15(r) {
  if (r == null) return 0;
  if (r < 28) return 25;
  if (r < 33) return 18;
  if (r < 38) return 8;
  return 0;
}

// Fator 2 — Banda de Bollinger inferior 15m (máx. 20 pts)
function ptsBollinger(broke, distPct) {
  if (broke) return 20;
  if (distPct != null && distPct < 0.08) return 12;
  return 0;
}

// Fator 3 — Desconto acumulado nas últimas 24h (máx. 20 pts). chg = variação % em 24h (negativa = queda)
function ptsDrop24(chg, assetKey) {
  if (chg == null || !isFinite(chg)) return 0;
  const rule = assetKey === 'BTCUSDT' ? DROP24_RULES.btc : DROP24_RULES.fx;
  if (chg <= rule.strong) return 20;
  if (chg <= rule.mild) return 12;
  return 0;
}

// Fator 4 — RSI 1h, confluência multi-timeframe (máx. 15 pts)
function ptsRsi1h(r) {
  if (r == null) return 0;
  if (r < 38) return 15;
  if (r < 44) return 8;
  return 0;
}

function scoreLevel(score) {
  if (score >= SCORE_STRONG) return 'strong';
  if (score >= SCORE_ACTIVE) return 'moderate';
  return 'waiting';
}

// c15: candles de 15m {t,o,h,l,c,v}; o ÚLTIMO é o candle atual (ao vivo).
// closes1h: fechamentos dos candles de 1h; o último é o preço atual.
// ref24: preço de 24h atrás (ver ref24FromCandles) ou null. assetKey: USDTBRL | EURBRL | PAXGBRL | BTCUSDT.
function computeScore(c15, closes1h, ref24, assetKey) {
  const n = c15.length;
  const cur = c15[n - 1];
  const closes = c15.map(c => c.c);
  const rsi15 = calcRSI(closes);
  const bb = calcBollinger(closes);
  const rsi1h = closes1h && closes1h.length ? calcRSI(closes1h) : null;

  // Queda/variação em 24h (%), usando o preço atual da vela de 15m
  const change24 = ref24 != null && ref24 > 0 ? (cur.c / ref24 - 1) * 100 : null;

  // Bollinger: rompeu = fechamento ou mínima na/abaixo da banda; distância em % do preço até a banda
  let bbBroke = false, bbDistPct = null;
  if (bb && bb.mid - bb.lower > 0) {
    bbBroke = cur.c <= bb.lower || cur.l <= bb.lower;
    bbDistPct = ((cur.c - bb.lower) / bb.lower) * 100;
  }

  // Reversão: vela verde OU pavio inferior > 50% do tamanho total da vela
  const range = cur.h - cur.l;
  const lowerWick = Math.min(cur.o, cur.c) - cur.l;
  const green = cur.c > cur.o;
  const rejection = range > 0 && lowerWick / range > 0.5;

  // Volume: vela atual OU anterior fechada acima da média das 10 últimas velas fechadas
  let volAvg = null, volBoost = false;
  if (n >= 12) {
    const base = c15.slice(n - 11, n - 1);
    volAvg = base.reduce((a, c) => a + c.v, 0) / base.length;
    volBoost = cur.v > volAvg || c15[n - 2].v > volAvg;
  }

  const factors = {
    rsi15: ptsRsi15(rsi15),
    bb: ptsBollinger(bbBroke, bbDistPct),
    drop24: ptsDrop24(change24, assetKey),
    rsi1h: ptsRsi1h(rsi1h),
    reversal: green || rejection ? 12 : 0,
    volume: volBoost ? 8 : 0
  };
  const score = factors.rsi15 + factors.bb + factors.drop24 + factors.rsi1h + factors.reversal + factors.volume;

  return {
    score, level: scoreLevel(score), active: score >= SCORE_ACTIVE, factors,
    rsi15, rsi1h, bb, bbBroke, bbDistPct, green, rejection, volAvg, volBoost, change24
  };
}
// ==== SCORE ENGINE END ====

/* ----------------------------- Dados ---------------------------- */
async function fetchJSON(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

// Klines de UM símbolo da Binance (com fallback entre as bases). Memoizado por execução:
// USDTBRL é usado pelo próprio USDT/BRL e por EUR/BRL e PAXG/BRL, mas só é baixado uma vez por intervalo.
const klineCache = new Map();
function klinesRaw(symbol, interval, limit) {
  const id = `${symbol}|${interval}|${limit}`;
  if (!klineCache.has(id)) {
    klineCache.set(id, (async () => {
      let lastErr;
      for (const base of BINANCE_BASES) {
        try {
          const raw = await fetchJSON(`${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, 6000);
          if (!Array.isArray(raw) || !raw.length) throw new Error(`sem candles de ${symbol}`);
          return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })());
  }
  return klineCache.get(id);
}

// Candles do ativo. Sintéticos (EUR, PAXG) = par/USDT × USDT/BRL, candle a candle, igual ao painel.
async function assetKlines(asset, interval, limit) {
  if (!asset.via) return klinesRaw(asset.symbol, interval, limit);
  const [a, q] = await Promise.all([klinesRaw(asset.via, interval, limit), klinesRaw('USDTBRL', interval, limit)]);
  const qm = new Map(q.map(c => [c.t, c]));
  const out = [];
  for (const c of a) {
    const f = qm.get(c.t);
    if (!f) continue;
    const o = c.o * f.o, cl = c.c * f.c;
    out.push({ t: c.t, o, c: cl, h: Math.max(o, cl, c.h * f.c), l: Math.min(o, cl, c.l * f.c), v: c.v });
  }
  if (!out.length) throw new Error(`sem candles sintéticos de ${asset.key}`);
  return out;
}

// Cotação secundária: Mercado Bitcoin → Kraken → CoinGecko (mesma ordem do painel)
const SECONDARY_SOURCES = [
  {
    name: 'Mercado Bitcoin', exchange: true,
    get: async () => {
      const data = await fetchJSON(MB_URL);
      const row = Array.isArray(data) ? data[0] : data;
      const p = parseFloat(row.last);
      if (!isFinite(p) || p <= 0) throw new Error('MB inválido');
      return p;
    }
  },
  {
    name: 'Kraken', exchange: true,
    get: async () => {
      const d = await fetchJSON(KRAKEN_URL);
      if (d.error && d.error.length) throw new Error(d.error.join(', '));
      const first = Object.values(d.result || {})[0];
      const p = parseFloat(first && first.c && first.c[0]);
      if (!isFinite(p) || p <= 0) throw new Error('Kraken inválido');
      return p;
    }
  },
  {
    name: 'CoinGecko (referência)', exchange: false,
    get: async () => {
      const d = await fetchJSON(COINGECKO_URL);
      const p = parseFloat(d && d.tether && d.tether.brl);
      if (!isFinite(p) || p <= 0) throw new Error('CoinGecko inválido');
      return p;
    }
  }
];

async function fetchSecondary() {
  for (const src of SECONDARY_SOURCES) {
    try {
      const price = await src.get();
      return { price, name: src.name, exchange: src.exchange };
    } catch (e) { /* tenta a próxima fonte */ }
  }
  return null;
}

/* ------------------- Estado passado (anti-spam) ------------------ */
// Reconstrói o Score como estava no instante `endTime` (fechamento de um minuto),
// agregando os candles de 1m da janela de 15m daquele instante.
function stateAt(endTime, k15, k1, k1h, assetKey) {
  const closedMin = k1.filter(m => m.t + MINUTE <= endTime);
  if (!closedMin.length) return null;
  const lastMin = closedMin[closedMin.length - 1];

  const winStart = Math.floor((endTime - 1) / FIFTEEN_MIN) * FIFTEEN_MIN;
  const inWin = closedMin.filter(m => m.t >= winStart);
  const series = k15.filter(c => c.t < winStart);
  if (inWin.length) {
    const real = k15.find(c => c.t === winStart);
    series.push({
      t: winStart,
      o: real ? real.o : inWin[0].o,
      h: Math.max(...inWin.map(m => m.h)),
      l: Math.min(...inWin.map(m => m.l)),
      c: inWin[inWin.length - 1].c,
      v: inWin.reduce((a, m) => a + m.v, 0)
    });
  }
  if (series.length < 20) return null;

  const hourStart = Math.floor((endTime - 1) / HOUR) * HOUR;
  const closes1h = k1h.filter(c => c.t < hourStart).map(c => c.c);
  closes1h.push(lastMin.c);

  // referência de 24h: abertura do candle de 1h que começou 24 h antes da hora daquele instante
  const ref24 = ref24FromCandles(k1h.filter(c => c.t <= hourStart));

  return computeScore(series, closes1h, ref24, assetKey);
}

// Queda rápida no instante `endTime`: máxima dos candles de 1m da janela de 15 min até esse instante contra o último preço.
// Para "agora" passe Date.now() (inclui o minuto em andamento); para o passado, um fechamento de minuto.
function flashAt(endTime, k1) {
  if (!k1) return null;
  const win = k1.filter(m => m.t >= endTime - FLASH_WINDOW && m.t < endTime);
  if (!win.length) return null;
  const high = Math.max(...win.map(m => m.h));
  const price = win[win.length - 1].c;
  if (!isFinite(high) || high <= 0 || !isFinite(price)) return null;
  return { high, price, drop: (price / high - 1) * 100 }; // negativo = queda
}

/* -------------------------- Utilidades -------------------------- */
const fmtNum = (n, d) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (asset, n) => (asset.cur === 'USD' ? 'US$ ' : 'R$ ') + fmtNum(n, asset.digits);
const fmt1 = n => n.toFixed(1).replace('.', ',');
const fmtPct2 = n => (n > 0 ? '+' : '') + n.toFixed(2).replace('.', ',') + '%';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function levelLabel(score) {
  if (score >= SCORE_STRONG) return 'Sinal Forte / Alta Confluência';
  if (score >= SCORE_ACTIVE) return 'Sinal Moderado/Bom';
  return 'Abaixo do limite de disparo';
}

const tagOf = (prefix, asset) => `${prefix}-${asset.key.toLowerCase()}`; // também serve de "topic" do push (≤ 32 chars)
const urlOf = (asset, source) => `/index.html?ativo=${asset.key}&source=${source}`;

// Texto da notificação (curto: o mais importante vem primeiro)
function buildBody(asset, res, price, sec) {
  const lines = [`${asset.label}: ${money(asset, price)} · Score ${res.score}/100`];
  lines.push(`${levelLabel(res.score)}. ${res.score >= SCORE_STRONG ? 'Ação sugerida: boa janela para avaliar uma compra agora.' : 'Ação sugerida: avaliar uma compra com cautela.'}`);
  lines.push(`${asset.via ? 'Binance (calculado)' : 'Binance'}: ${money(asset, price)}`);
  if (sec) {
    lines.push(`${sec.name}: ${money(asset, sec.price)}`);
    if (sec.exchange) {
      if (price < sec.price) lines.push('Mais barata agora: Binance');
      else if (sec.price < price) lines.push(`Mais barata agora: ${sec.name}`);
    }
  }
  lines.push(`RSI 15m ${res.rsi15 != null ? fmt1(res.rsi15) : 'n/d'} | RSI 1h ${res.rsi1h != null ? fmt1(res.rsi1h) : 'n/d'}`);
  lines.push(`Queda 24h: ${res.change24 != null ? fmtPct2(res.change24) : 'n/d'} (${res.factors.drop24}/20 pts)`);
  if (res.bb) lines.push(`Alvo de repique: ${money(asset, res.bb.mid)}`);
  return lines.join('\n');
}

/* --------------------------- Web Push --------------------------- */
const SEND_CHUNK = 100; // quantos pushes em paralelo por vez

// Envia o payload a todas as inscrições. Remove as expiradas (404/410) do Supabase.
// Falhas temporárias vêm em `retry` para o chamador liberar a trava anti-spam desses aparelhos.
// `payload` pode ser um objeto (igual para todos) ou uma função row => objeto (mensagem por aparelho).
async function dispatch(supabase, rows, payload, options) {
  const bodyFor = typeof payload === 'function'
    ? row => JSON.stringify(payload(row))
    : (() => { const b = JSON.stringify(payload); return () => b; })();
  let sent = 0, failed = 0;
  const expired = [], retry = [];

  for (let i = 0; i < rows.length; i += SEND_CHUNK) {
    const chunk = rows.slice(i, i + SEND_CHUNK);
    const results = await Promise.allSettled(
      chunk.map(r => webpush.sendNotification(r.subscription, bodyFor(r), { timeout: 8000, ...options }))
    );
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') { sent++; return; }
      const code = r.reason && r.reason.statusCode;
      if (code === 404 || code === 410) expired.push(chunk[k].endpoint);
      else { failed++; retry.push(chunk[k].endpoint); }
    });
  }

  if (expired.length) {
    const { error } = await supabase.from('push_subscriptions').delete().in('endpoint', expired);
    if (error) console.error('Falha ao remover inscrições expiradas:', error.message);
  }
  return { sent, failed, removed: expired.length, retry };
}

/* ------------------------- Preço-alvo push ------------------------ */
// Reserva atômica: marca alvo_disparado = true só nas inscrições que vigiam ESTE ativo, cujo alvo foi atingido
// (preço <= preco_alvo) e que ainda não foram avisadas, e devolve exatamente essas linhas.
// Duas execuções simultâneas não duplicam o aviso.
async function fireTargets(supabase, asset, price) {
  const { data: hit, error } = await supabase
    .from('push_subscriptions')
    .update({ alvo_disparado: true })
    .eq('ativo', asset.key)
    .not('preco_alvo', 'is', null)
    .gte('preco_alvo', price)
    .or('alvo_disparado.is.null,alvo_disparado.eq.false')
    .or(prefOn('alvo'))   // aparelho que desligou "Meu Preço-Alvo" não é tocado (o alvo continua armado)
    .select('endpoint, subscription, preco_alvo');
  if (error) throw error;
  if (!hit.length) return { fired: 0, delivered: 0, failed: 0, removed: 0 };

  const r = await dispatch(supabase, hit, row => ({
    type: 'target',
    title: `Alerta Dólar Pro · Alvo Atingido ${asset.label}`,
    body: `${asset.label}: ${money(asset, price)}, no seu alvo de ${money(asset, Number(row.preco_alvo))} ou abaixo.\nAção sugerida: avaliar sua compra agora.\nToque para abrir o painel.`,
    tag: tagOf('adp-alvo', asset),
    ativo: asset.key,
    url: urlOf(asset, 'push'),
    price,
    t: Date.now()
  }), { TTL: 1800, urgency: 'high', topic: tagOf('adp-alvo', asset) });

  // falha temporária: rearma só esses aparelhos para tentar de novo no próximo minuto
  if (r.retry.length) {
    await supabase.from('push_subscriptions').update({ alvo_disparado: false }).in('endpoint', r.retry);
  }
  return { fired: hit.length, delivered: r.sent, failed: r.failed, removed: r.removed };
}

/* ------------------------- Alerta de Score ------------------------ */
// d = { asset, price, now, past, sec }. Retorna o resultado (sem lançar erro por falta de histórico).
async function fireScore(supabase, d) {
  const { asset, price, now, past, sec } = d;
  const info = {
    ok: true, sent: false, score: now.score, level: now.level, factors: now.factors,
    scorePast: past ? past.score : null, justFormed: false, deduped: false,
    price, rsi15: now.rsi15, rsi1h: now.rsi1h, change24: now.change24, target: now.bb ? now.bb.mid : null
  };

  if (!now.active) return info;
  if (!past) return { ...info, note: 'Sem histórico de 1m suficiente para validar o cruzamento; alerta não enviado.' };

  info.justFormed = past.score < SCORE_ACTIVE;
  if (!info.justFormed) return info;

  // Reserva atômica por ativo: marca a coluna de último alerta DESTE ativo e devolve só os aparelhos
  // que NÃO receberam alerta dele nos últimos DEDUPE_MINUTES.
  const col = asset.alertCol;
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - DEDUPE_MINUTES * MINUTE).toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('push_subscriptions')
    .update({ [col]: nowIso })
    .or(`${col}.is.null,${col}.lt.${cutoff}`)
    .or(prefOn('score'))  // só quem deixou "Oportunidades de Alta Confluência" ligado
    .select('endpoint, subscription');
  if (claimErr) throw claimErr;

  if (!claimed.length) {
    const { count } = await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true });
    return { ...info, subscribers: count || 0, deduped: (count || 0) > 0 };
  }

  const r = await dispatch(supabase, claimed, {
    type: 'signal',
    id: `s-${Math.floor(Date.now() / MINUTE)}-${asset.key}`,
    title: `Alerta Dólar Pro · Oportunidade ${asset.label}`,
    body: buildBody(asset, now, price, sec),
    tag: tagOf('adp-sinal', asset),          // um banner por ativo: o alerta novo do mesmo ativo substitui o anterior
    ativo: asset.key,
    url: urlOf(asset, 'push'),
    score: now.score,
    price,
    t: Date.now()
  }, { TTL: 600, urgency: 'high', topic: tagOf('adp-sinal', asset) }); // alerta velho não serve: expira em 10 min

  // falha temporária (ex.: 5xx do serviço de push): libera a trava para tentar de novo no próximo minuto
  if (r.retry.length) {
    await supabase.from('push_subscriptions').update({ [col]: null }).in('endpoint', r.retry);
  }
  return { ...info, sent: r.sent > 0, subscribers: claimed.length, delivered: r.sent, failed: r.failed, removed: r.removed };
}

/* ------------------------- Flash Crash (queda brusca) ------------------------ */
// d = { asset, price, flash, flashPast }. Dispara só quando a queda de 15 min cruza o limite
// (há ~3 min ainda não batia), para não repetir mensagem durante a mesma queda.
async function fireFlash(supabase, d) {
  const { asset, flash, flashPast } = d;
  const limit = -asset.flashPct;
  const info = {
    ok: true, sent: false, drop: flash ? flash.drop : null, limit,
    dropPast: flashPast ? flashPast.drop : null, justFormed: false, deduped: false
  };

  if (!flash || flash.drop > limit) return info;
  if (!flashPast) return { ...info, note: 'Sem histórico de 1m suficiente para validar a queda; alerta não enviado.' };

  info.justFormed = flashPast.drop > limit;
  if (!info.justFormed) return info;

  const col = asset.flashCol;
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - DEDUPE_MINUTES * MINUTE).toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('push_subscriptions')
    .update({ [col]: nowIso })
    .or(`${col}.is.null,${col}.lt.${cutoff}`)
    .or(prefOn('flash'))
    .select('endpoint, subscription');
  if (claimErr) throw claimErr;
  if (!claimed.length) return { ...info, deduped: true };

  const pct = fmtNum(Math.abs(flash.drop), 2);
  const r = await dispatch(supabase, claimed, {
    type: 'flash',
    id: `f-${Math.floor(Date.now() / MINUTE)}-${asset.key}`,
    title: `Alerta Dólar Pro · Queda Brusca em ${asset.label}`,
    body: `${asset.label} caiu -${pct}% em até 15 min.\nAgora: ${money(asset, flash.price)} (máxima recente: ${money(asset, flash.high)}).\nConfira o painel antes de decidir: quedas rápidas podem continuar ou reverter.`,
    tag: tagOf('adp-flash', asset),
    ativo: asset.key,
    url: urlOf(asset, 'push'),
    price: flash.price,
    t: Date.now()
  }, { TTL: 600, urgency: 'high', topic: tagOf('adp-flash', asset) });

  if (r.retry.length) {
    await supabase.from('push_subscriptions').update({ [col]: null }).in('endpoint', r.retry);
  }
  return { ...info, sent: r.sent > 0, subscribers: claimed.length, delivered: r.sent, failed: r.failed, removed: r.removed };
}

/* ------------------------- Modo Viagem (abaixo da última compra) ------------------------ */
// Só vale para os ativos do Modo Viagem (USDTBRL e EURBRL). Reserva atômica: marca viagem_alertado = true nas linhas
// que vigiam ESTE ativo, ligadas em prefs.viagem, com última compra registrada e cotação atual >= 0,3% abaixo dela.
async function fireViagem(supabase, asset, price) {
  if (asset.key !== 'USDTBRL' && asset.key !== 'EURBRL') return { fired: 0 };
  const minRef = price / (1 - VIAGEM_DROP_PCT / 100); // última compra precisa ser >= isto
  const { data: hit, error } = await supabase
    .from('push_subscriptions')
    .update({ viagem_alertado: true })
    .eq('viagem_ativo', asset.key)
    .not('viagem_ultima_cotacao', 'is', null)
    .gte('viagem_ultima_cotacao', minRef)
    .or('viagem_alertado.is.null,viagem_alertado.eq.false')
    .or(prefOn('viagem'))
    .select('endpoint, subscription, viagem_ultima_cotacao');
  if (error) throw error;
  if (!hit.length) return { fired: 0, delivered: 0, failed: 0, removed: 0 };

  const r = await dispatch(supabase, hit, row => {
    const last = Number(row.viagem_ultima_cotacao);
    const diff = last - price;
    const pct = (diff / last) * 100;
    return {
      type: 'viagem',
      title: `Modo Viagem · ${asset.name} mais barato que sua última compra!`,
      body: `${asset.label} está em ${money(asset, price)}, R$ ${fmtNum(diff, 4)} (-${fmtNum(pct, 2)}%) abaixo da sua última compra de ${money(asset, last)}.\nUm novo aporte agora pode baixar seu preço médio.\nToque para abrir o Modo Viagem.`,
      tag: tagOf('adp-viagem', asset),
      ativo: asset.key,
      url: `/index.html?ativo=${asset.key}&source=push#viagem`,
      price,
      t: Date.now()
    };
  }, { TTL: 1800, urgency: 'high', topic: tagOf('adp-viagem', asset) });

  // falha temporária: rearma só esses aparelhos para tentar de novo no próximo minuto
  if (r.retry.length) {
    await supabase.from('push_subscriptions').update({ viagem_alertado: false }).in('endpoint', r.retry);
  }
  return { fired: hit.length, delivered: r.sent, failed: r.failed, removed: r.removed };
}

/* ------------------------------ Handler ------------------------- */
// Baixa os candles de um ativo e calcula o Score de agora e o de ~3 min atrás (e a queda rápida de 15 min, agora e ~3 min atrás).
async function loadAsset(asset) {
  const [k15, k1, k1h] = await Promise.all([
    assetKlines(asset, '15m', 50),
    assetKlines(asset, '1m', 40).catch(() => null),
    assetKlines(asset, '1h', 30)
  ]);
  const price = k15[k15.length - 1].c;
  const now = computeScore(k15, k1h.map(c => c.c), ref24FromCandles(k1h), asset.key);
  let past = null, flash = null, flashPast = null;
  if (k1) {
    const minuteStart = Math.floor(Date.now() / MINUTE) * MINUTE;
    past = stateAt(minuteStart - LOOKBACK_MINUTES * MINUTE, k15, k1, k1h, asset.key);
    flash = flashAt(Date.now(), k1);
    flashPast = flashAt(minuteStart - LOOKBACK_MINUTES * MINUTE, k1);
  }
  return { asset, price, now, past, flash, flashPast };
}

const errMsg = e => String(e && e.message ? e.message : e);

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const {
    CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  const missing = Object.entries({
    CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return json(500, { error: 'Defina no Netlify as variáveis de ambiente: ' + missing.join(', ') });
  }
  if (qs.secret !== CRON_SECRET) {
    return json(401, { error: 'Não autorizado.' });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  klineCache.clear(); // instância "quente" da função: não reaproveita candles de execuções anteriores

  try {
    // Os 4 ativos + cotação secundária do USDT, tudo em paralelo. Um ativo que falhe não derruba os outros.
    const [loaded, sec] = await Promise.all([
      Promise.allSettled(ASSET_LIST.map(loadAsset)),
      fetchSecondary()
    ]);

    const results = {};
    const ready = [];
    loaded.forEach((r, i) => {
      const asset = ASSET_LIST[i];
      if (r.status === 'fulfilled') ready.push(r.value);
      else results[asset.key] = { ok: false, error: errMsg(r.reason) };
    });
    if (!ready.length) {
      return json(502, { ok: false, error: 'Nenhum ativo pôde ser consultado.', assets: results });
    }

    // ---- Modo teste: dispara push imediatamente para todos os aparelhos inscritos ----
    // (limite de 1000 linhas por consulta do Supabase; acima disso, pagine com .range())
    if (qs.test === 'true') {
      const { data: rows, error } = await supabase.from('push_subscriptions').select('endpoint, subscription').limit(1000);
      if (error) throw error;
      const scores = ready.map(d => `${d.asset.name} ${d.now.score}`).join(' · ');
      if (!rows.length) {
        return json(200, { ok: true, test: true, subscribers: 0, sent: 0, note: 'Nenhum aparelho inscrito ainda. Abra o app, toque em "Ativar Notificações Push" e tente de novo.' });
      }
      const r = await dispatch(supabase, rows, {
        type: 'test',
        title: 'Alerta Dólar Pro · Teste de notificação',
        body: 'Notificação de teste funcionando!\nScore agora: ' + scores,
        tag: 'adp-test',
        url: '/index.html',
        t: Date.now()
      }, { TTL: 60, urgency: 'high', topic: 'adp-test' });
      return json(200, {
        ok: true, test: true, subscribers: rows.length, delivered: r.sent, failed: r.failed, removed: r.removed,
        scores: Object.fromEntries(ready.map(d => [d.asset.key, d.now.score]))
      });
    }

    // ---- Por ativo, em paralelo: alvos de preço e Modo Viagem (todo minuto) + Score e Flash Crash (só no cruzamento) ----
    await Promise.all(ready.map(async d => {
      let targets;
      try { targets = await fireTargets(supabase, d.asset, d.price); }
      catch (e) { targets = { error: errMsg(e) }; } // um erro aqui não pode travar o alerta de Score

      let score;
      try { score = await fireScore(supabase, { ...d, sec: d.asset.key === 'USDTBRL' ? sec : null }); }
      catch (e) { score = { ok: false, error: errMsg(e) }; }

      let flash;
      try { flash = await fireFlash(supabase, d); }
      catch (e) { flash = { ok: false, error: errMsg(e) }; }

      let viagem;
      try { viagem = await fireViagem(supabase, d.asset, d.price); }
      catch (e) { viagem = { error: errMsg(e) }; }

      results[d.asset.key] = { ...score, targets, flash, viagem };
    }));

    return json(200, { ok: true, assets: results, secondary: sec });
  } catch (err) {
    return json(502, { ok: false, error: errMsg(err) });
  }
};

// exportados apenas para testes automatizados
exports.computeScore = computeScore;
exports.stateAt = stateAt;
exports.flashAt = flashAt;
exports.ptsRsi15 = ptsRsi15;
exports.ptsRsi1h = ptsRsi1h;
exports.ptsBollinger = ptsBollinger;
exports.ptsDrop24 = ptsDrop24;
exports.ref24FromCandles = ref24FromCandles;
exports.ASSETS = ASSETS;
exports.assetKlines = assetKlines;