// Стратегия: приложение всегда открывается из кеша — мгновенно и без сети.
// Свежая версия скачивается в фоне, но НЕ подменяет текущую: она лежит отдельно
// («отложенная» версия), а приложение показывает плашку «Обновить».
// Пока её не нажали, при каждом запуске открывается прежняя версия.
// После нажатия отложенные файлы переносятся в основной кеш, и страница перезагружается.
//
// CACHE_VERSION меняй, только если поменялся список файлов в APP_SHELL.
// Новый sw.js тоже не включается сам: ждёт той же кнопки «Обновить».
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'gde-lezhit-' + CACHE_VERSION;
const NEXT_NAME = CACHE_NAME + '-next';   // скачанная, но ещё не применённая версия
const INSTALL_NAME = CACHE_NAME + '-install';   // файлы нового sw.js до его включения: прежняя версия их не видит

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './qrcode.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './favicon-16.png',
  './favicon.ico'
];

// Необязательные файлы: кешируем, если они лежат рядом, а если их нет, установка не ломается.
// jsQR.js нужен только браузерам без встроенного BarcodeDetector (Safari, Firefox).
const OPTIONAL = ['./jsQR.js'];

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

async function hasStaged() {
  if (!(await caches.has(NEXT_NAME))) return false;
  const next = await caches.open(NEXT_NAME);
  return (await next.keys()).length > 0;
}

// Тихо тянем свежую копию в обход HTTP-кеша.
// Возвращает true, если файл изменился и отложен до нажатия «Обновить».
async function revalidate(url) {
  try {
    const fresh = await fetch(url, { cache: 'no-cache' });
    if (!fresh || fresh.status !== 200 || fresh.type !== 'basic') return false;

    const main = await caches.open(CACHE_NAME);
    const keys = isDoc(url) ? DOC_KEYS : [url];
    const old = await main.match(url, { ignoreSearch: true });

    if (!old) {                                   // такого файла в текущей версии нет — просто кладём
      await Promise.all(keys.map(k => main.put(k, fresh.clone())));
      return false;
    }
    const [a, b] = await Promise.all([old.clone().arrayBuffer(), fresh.clone().arrayBuffer()]);
    if (sameBytes(a, b)) {                        // не изменился (или на сервере откатили) — откладывать нечего
      if (await caches.has(NEXT_NAME)) {
        const next = await caches.open(NEXT_NAME);
        await Promise.all(keys.map(k => next.delete(k)));
      }
      return false;
    }
    const next = await caches.open(NEXT_NAME);
    await Promise.all(keys.map(k => next.put(k, fresh.clone())));
    return true;
  } catch (e) {
    return false;                                 // нет сети — ничего страшного, остаёмся на кеше
  }
}

// Страница изменилась — подтягиваем и остальные файлы, чтобы новая версия применилась целиком
async function stageAll() {
  for (const path of APP_SHELL) {
    if (path === './' || path === './index.html') continue;
    await revalidate(new URL(path, SCOPE).href);
  }
}

async function checkFor(url) {
  const changed = await revalidate(url);
  if (changed && isDoc(url)) await stageAll();
  if (changed) await notifyClients();
}

// «Обновить»: переносим отложенную версию в основной кеш
async function applyStaged() {
  const main = await caches.open(CACHE_NAME);
  const next = await caches.open(NEXT_NAME);
  for (const req of await next.keys()) {
    const res = await next.match(req);
    if (res) await main.put(req, res);
  }
  await caches.delete(NEXT_NAME);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await caches.delete(INSTALL_NAME);
    const cache = await caches.open(INSTALL_NAME);
    // cache:'reload' — не брать устаревшее из HTTP-кеша GitHub Pages
    await Promise.all(APP_SHELL.map(async path => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (!res.ok) throw new Error(path + ' ' + res.status);
      await cache.put(path, res);
    }));
    await Promise.all(OPTIONAL.map(async path => {
      try {
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (res.ok) await cache.put(path, res);
      } catch (e) { /* файла нет: не страшно */ }
    }));
    // Первая установка — включаемся сразу. Если уже работает прежняя версия — ждём «Обновить».
    if (!self.registration.active) await self.skipWaiting();
  })());
});

// Включение нового sw.js. Браузер включает его сам, когда приложение закрыли полностью,
// поэтому без нажатия «Обновить» свежие файлы не становятся основными, а откладываются —
// пользователь увидит прежнюю версию и плашку, как и при обычном обновлении.
let consented = false;                          // нажали «Обновить» (пришёл SKIP_WAITING)

async function copyCache(fromName, toName, onlyChanged) {
  const from = await caches.open(fromName);
  let to = null;
  const main = onlyChanged ? await caches.open(CACHE_NAME) : null;
  for (const req of await from.keys()) {
    const res = await from.match(req);
    if (!res) continue;
    if (main) {
      const old = await main.match(req, { ignoreSearch: true });
      if (old) {
        const [x, y] = await Promise.all([old.clone().arrayBuffer(), res.clone().arrayBuffer()]);
        if (sameBytes(x, y)) continue;          // не изменился — откладывать нечего
      }
    }
    if (!to) to = await caches.open(toName);
    await to.put(req, res);
  }
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const service = k => k === NEXT_NAME || k === INSTALL_NAME || k.endsWith('-next') || k.endsWith('-install');
    const prevMain = keys.find(k => k.startsWith('gde-lezhit-') && !service(k) && k !== CACHE_NAME);
    const hasMain = keys.includes(CACHE_NAME) && (await (await caches.open(CACHE_NAME)).keys()).length > 0;
    const legacy = prevMain === 'gde-lezhit-v3';    // прежняя схема не умеет «Обновить» по-новому — применяем сразу
    const firstRun = !hasMain && !prevMain;

    if (firstRun || consented || legacy) {
      await copyCache(INSTALL_NAME, CACHE_NAME, false);   // свежие файлы становятся основными
      await caches.delete(NEXT_NAME);
    } else {
      if (!hasMain && prevMain) await copyCache(prevMain, CACHE_NAME, false);   // сменилась CACHE_VERSION — переносим текущую версию
      await copyCache(INSTALL_NAME, NEXT_NAME, true);    // а свежую откладываем до «Обновить»
    }
    await caches.delete(INSTALL_NAME);
    await Promise.all(
      (await caches.keys())
        .filter(k => k.startsWith('gde-lezhit-') && k !== CACHE_NAME && k !== NEXT_NAME)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
    if (await hasStaged()) await notifyClients();
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
      event.waitUntil(checkFor(req.url));
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

self.addEventListener('message', event => {
  const msg = event.data;
  if (msg === 'CHECK_UPDATE') {
    // сначала — уже скачанная версия (работает и без сети), потом — проверка сервера
    event.waitUntil((async () => {
      if (await hasStaged()) await notifyClients();
      await checkFor(SCOPE + 'index.html');
    })());
  } else if (msg === 'APPLY_UPDATE') {
    const port = event.ports && event.ports[0];
    event.waitUntil(applyStaged()
      .then(() => { if (port) port.postMessage('APPLIED'); })
      .catch(() => { if (port) port.postMessage('FAILED'); }));
  } else if (msg === 'SKIP_WAITING') {
    consented = true;
    self.skipWaiting();
  }
});
