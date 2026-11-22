// daily-high.js — Máxima do Dia (fuso de Brasília) dos 5 preços exibidos no painel.
//
// Chaves: USDTBRL · EURBRL (EURUSDT × USDTBRL) · PAXGBRL (PAXGUSDT × USDTBRL) · BTCUSDT (US$) · BTCBRL (R$)
//
// Como funciona:
//  1) "Dia" = data YYYY-MM-DD em America/Sao_Paulo. Virou a data, as máximas zeram e recomeçam do novo dia.
//  2) A cada 20 s consulta o preço atual na Binance e sobe a máxima se o preço for maior.
//  3) A cada 3 min (e ao subir o servidor / na virada do dia) refaz o "backfill": lê os candles de 5 min desde 00:00
//     de Brasília e pega a maior máxima. Assim, pavios que aconteceram entre duas consultas — ou enquanto o Render
//     estava dormindo/reiniciando — não se perdem.
//  4) Cada novo recorde é gravado no Supabase (tabela maximas_diarias, função registrar_maxima = "maior valor vence").
//     Ao subir, o servidor relê o dia atual do banco.
//
// Uso (server.js):  const dailyHigh = require('./daily-high'); dailyHigh.start(getSupabase);
//                   GET /api/maxima-dia -> await dailyHigh.ensureFresh(); res.json({ ok: true, ...dailyHigh.snapshot() })

'use strict';

const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];
const TZ = 'America/Sao_Paulo';
const POLL_MS = 20 * 1000;
const BACKFILL_MS = 3 * 60 * 1000;
const STALE_MS = 45 * 1000;

const ASSETS = {
  USDTBRL: ['USDTBRL'],
  EURBRL:  ['EURUSDT', 'USDTBRL'],
  PAXGBRL: ['PAXGUSDT', 'USDTBRL'],
  BTCUSDT: ['BTCUSDT'],
  BTCBRL:  ['BTCBRL']
};
const SYMBOLS = [...new Set(Object.values(ASSETS).flat())];

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const brtDay = (ms = Date.now()) => dayFmt.format(new Date(ms));
// O Brasil não tem horário de verão desde 2019: Brasília é UTC-3 o ano todo.
const dayStartMs = day => Date.parse(day + 'T00:00:00-03:00');

const S = { day: null, max: {}, dirty: new Set(), loaded: false, lastOk: 0, lastBackfill: 0 };
let getSupabase = () => null;
let busy = null;

async function getJSON(path) {
  let err;
  for (const base of BASES) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}

function rollover() {
  const d = brtDay();
  if (d !== S.day) {
    S.day = d; S.max = {}; S.dirty.clear(); S.loaded = false; S.lastBackfill = 0;
  }
  return S.day;
}

// aplica um mapa { chave: valor } mantendo sempre o maior
function merge(map) {
  for (const [k, v] of Object.entries(map)) {
    if (isFinite(v) && v > 0 && v > (S.max[k] || 0)) { S.max[k] = v; S.dirty.add(k); }
  }
}

async function loadFromDb(day) {
  const sb = getSupabase();
  if (!sb) return {};
  const { data, error } = await sb.from('maximas_diarias').select('ativo, maxima').eq('dia', day);
  if (error) throw error;
  const out = {};
  for (const r of data || []) if (ASSETS[r.ativo]) out[r.ativo] = Number(r.maxima);
  return out;
}

// maior máxima desde 00:00 de Brasília, a partir dos candles de 5 min
async function backfill(day) {
  const start = dayStartMs(day);
  const res = await Promise.allSettled(SYMBOLS.map(async s => {
    const raw = await getJSON(`/api/v3/klines?symbol=${s}&interval=5m&startTime=${start}&limit=1000`);
    return [s, new Map(raw.map(k => [k[0], { o: +k[1], h: +k[2], c: +k[4] }]))];
  }));
  const kl = {};
  for (const r of res) if (r.status === 'fulfilled') kl[r.value[0]] = r.value[1];

  const out = {};
  for (const [key, legs] of Object.entries(ASSETS)) {
    const a = kl[legs[0]], q = legs[1] ? kl[legs[1]] : null;
    if (!a || (legs[1] && !q)) continue;
    let hi = 0;
    for (const [t, c] of a) {
      if (!q) { hi = Math.max(hi, c.h); continue; }
      const f = q.get(t);
      if (!f) continue;
      // mesma conta do painel para pares cruzados (candle a candle)
      hi = Math.max(hi, c.o * f.o, c.c * f.c, c.h * f.c);
    }
    if (hi > 0) out[key] = hi;
  }
  return out;
}

async function poll() {
  const rows = await getJSON('/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(SYMBOLS)));
  const px = {};
  for (const r of rows) px[r.symbol] = parseFloat(r.price);
  const out = {};
  for (const [key, legs] of Object.entries(ASSETS)) {
    let p = 1;
    for (const l of legs) p *= px[l];
    if (isFinite(p) && p > 0) out[key] = p;
  }
  return out;
}

async function flush(day) {
  const sb = getSupabase();
  if (!sb || !S.dirty.size) return;
  for (const k of [...S.dirty]) {
    const { error } = await sb.rpc('registrar_maxima', { p_ativo: k, p_dia: day, p_maxima: S.max[k] });
    if (error) { console.error('[maxima-dia] falha ao gravar', k, error.message); continue; }
    S.dirty.delete(k);
  }
}

async function run() {
  const day = rollover();
  const first = !S.loaded;
  let fromDb = {}, fromBackfill = {}, fromPoll = {};

  if (first) { try { fromDb = await loadFromDb(day); S.loaded = true; } catch (e) { console.error('[maxima-dia] leitura do banco:', e.message || e); } }
  if (first || Date.now() - S.lastBackfill > BACKFILL_MS) {
    try { fromBackfill = await backfill(day); S.lastBackfill = Date.now(); } catch (e) { console.error('[maxima-dia] backfill:', e.message || e); }
  }
  try { fromPoll = await poll(); S.lastOk = Date.now(); } catch (e) { console.error('[maxima-dia] preço:', e.message || e); }

  // se a meia-noite de Brasília passou durante as consultas, descarta (evita creditar o dia novo ao dia velho)
  if (brtDay() !== day || S.day !== day) return;
  merge(fromDb); merge(fromBackfill); merge(fromPoll);
  await flush(day);
}

function cycle() {
  if (!busy) busy = run().catch(e => console.error('[maxima-dia]', e && e.message ? e.message : e)).finally(() => { busy = null; });
  return busy;
}

// Chamada pela rota: garante dados recentes mesmo se o servidor acabou de acordar
async function ensureFresh() {
  if (S.day !== brtDay() || Date.now() - S.lastOk > STALE_MS || !S.loaded) {
    await Promise.race([cycle(), new Promise(r => setTimeout(r, 5000))]);
  }
}

function snapshot() {
  rollover();
  return { dia: S.day, maximas: { ...S.max }, atualizadoEm: S.lastOk ? new Date(S.lastOk).toISOString() : null };
}

function start(supabaseGetter) {
  getSupabase = supabaseGetter || getSupabase;
  cycle();
  setInterval(cycle, POLL_MS);
  // limpeza: guarda 60 dias de histórico
  const sb = getSupabase();
  if (sb) sb.from('maximas_diarias').delete().lt('dia', brtDay(Date.now() - 60 * 86400000)).then(() => {}, () => {});
}

module.exports = { start, ensureFresh, snapshot, brtDay };