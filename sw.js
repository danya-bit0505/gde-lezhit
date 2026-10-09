// Стратегия: stale-while-revalidate.
// Приложение всегда открывается из кеша (мгновенно и без сети),
// а в фоне подтягивается свежая версия. Если файл изменился —
// страница получает сообщение UPDATE_READY и показывает плашку «Обновить».
// CACHE_VERSION меняй только если поменялся список файлов в APP_SHELL.
const CACHE_VERSION = 'v2';
const CACHE_NAME = 'gde-lezhit-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './favicon-16.png',
  './favicon.ico'
];

const SCOPE = self.registration.scope;
const DOC_KEYS = [SCOPE, SCOPE + 'index.html'];

function isDoc(url) {
  const p = new URL(url).pathname;
  return p.endsWith('/') || p.endsWith('/index.html');
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

async function notifyClients() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'UPDATE_READY' }));
}

// Тихо тянем свежую копию в обход HTTP-кеша; если отличается — кладём в кеш
async function revalidate(url) {
  try {
    const fresh = await fetch(url, { cache: 'no-cache' });
    if (!fresh || fresh.status !== 200 || fresh.type !== 'basic') return;

    const cache = await caches.open(CACHE_NAME);
    const old = await cache.match(url, { ignoreSearch: true });

    let changed = false;
    if (old) {
      const [a, b] = await Promise.all([old.clone().arrayBuffer(), fresh.clone().arrayBuffer()]);
      changed = !sameBytes(a, b);
    }

    if (!old || changed) {
      if (isDoc(url)) {
        // «/» и «/index.html» — одна и та же страница, держим обе записи синхронными
        await Promise.all(DOC_KEYS.map(k => cache.put(k, fresh.clone())));
      } else {
        await cache.put(url, fresh.clone());
      }
    }

    if (changed && isDoc(url)) await notifyClients();
  } catch (e) {
    // нет сети — ничего страшного, остаёмся на кеше
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:'reload' — не брать устаревшее из HTTP-кеша GitHub Pages
    await Promise.all(APP_SHELL.map(async path => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (!res.ok) throw new Error(path + ' ' + res.status);
      await cache.put(path, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('gde-lezhit-') && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // всё чужое (api.github.com для синхронизации и т.п.) — напрямую в сеть
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });

    if (cached) {
      event.waitUntil(revalidate(req.url));
      return cached;
    }

    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match(SCOPE + 'index.html');
        if (fallback) return fallback;
      }
      return Response.error();
    }
  })());
});

// Страница просит проверить обновления (например, когда её снова открыли из фона)
self.addEventListener('message', event => {
  if (event.data === 'CHECK_UPDATE') {
    event.waitUntil(revalidate(SCOPE + 'index.html'));
  }
});
