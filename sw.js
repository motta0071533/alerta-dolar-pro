// Service worker do Alerta Dólar Pro.
// - Não faz cache: cotações precisam ser sempre ao vivo (o fetch só repassa à rede).
// - Recebe Web Push (VAPID), mostra a notificação nativa e abre o app ao tocar.

const ICON = '/icons/icon-192.png';        // logo colorido do app (ao lado do texto)
const BADGE = '/icons/favicon-32.png';     // ícone pequeno da barra de status
const DEFAULT_URL = '/index.html';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  // requisição especial do Chrome que não pode ser repassada à rede
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  event.respondWith(fetch(event.request));
});

/* ---------- Histórico local de sinais (IndexedDB, lido pelo painel) ---------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('adp', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('signals', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSignal(d) {
  const signal = { id: d.id, t: d.t, score: d.score, price: d.price == null ? null : d.price, ativo: d.ativo || 'USDTBRL' };
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('signals', 'readwrite');
      tx.objectStore('signals').put(signal);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) { /* sem IndexedDB: a notificação continua funcionando */ }
  // avisa abas abertas para atualizarem a lista na hora
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach(c => c.postMessage({ type: 'signal', signal }));
}

/* ---------- Web Push ---------- */
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Alerta Dólar Pro';
  // Tag SEMPRE preenchida (renotify: true exige tag, senão showNotification lança TypeError).
  // Uma tag por ativo: o alerta novo do mesmo ativo substitui o anterior, mas alertas de ativos diferentes convivem.
  const tag = data.tag || `adp-${String(data.ativo || 'geral').toLowerCase()}`;
  const options = {
    body: data.body || 'Novo sinal de oportunidade.',
    icon: ICON,
    badge: BADGE,
    tag,
    renotify: true,                    // ...mas toca/vibra de novo mesmo com a mesma tag
    requireInteraction: true,          // fica na tela até o usuário tocar ou dispensar (Android/Windows)
    silent: false,                     // som/vibração padrão do sistema
    vibrate: [200, 100, 200, 100, 300],
    timestamp: data.t || Date.now(),
    data: { url: data.url || DEFAULT_URL, ativo: data.ativo || null }
  };

  // Todo push PRECISA mostrar uma notificação (exigência do iOS/Safari e do Chrome).
  const jobs = [self.registration.showNotification(title, options)];
  if (data.type === 'signal' && data.id) jobs.push(saveSignal(data));
  event.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || DEFAULT_URL, self.location.origin).href;

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const ativo = event.notification.data && event.notification.data.ativo;
    for (const c of wins) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        // app já aberto: foca e pede ao painel para mostrar o ativo do alerta (sem recarregar a página)
        if (ativo) c.postMessage({ type: 'open-asset', ativo });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

// Se o navegador trocar/expirar a inscrição, renova e reenvia ao servidor sem o usuário perceber.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const oldKey = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!oldKey) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: oldKey });
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
    } catch (e) { /* o painel tenta sincronizar de novo na próxima abertura */ }
  })());
});