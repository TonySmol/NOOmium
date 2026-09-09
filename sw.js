/**
 * ═══════════════════════════════════════════════════════════════════
 * NOOmium — sw.js · v1.1.2 (сборка 88)
 * Service Worker: офлайн-оболочка приложения.
 *
 * Стратегия:
 * - network-first с cache:'reload': навигация и shell-файлы
 *   (index.html, style.css, app.js). 'reload' заставляет fetch идти
 *   мимо HTTP-кэша — GitHub Pages держит ответы до 10 минут, и без
 *   этого обновления версии могли «застревать» даже при живой сети;
 * - cache-first: остальная same-origin статика (иконки, скриншоты,
 *   манифест);
 * - pass-through: внешние CDN и WebSocket (SW их не трогает).
 * ═══════════════════════════════════════════════════════════════════
 */

/** Версия кэша: на activate все кэши с другой версией удаляются. */
const CACHE_VERSION = 'noomium-v1.1.2';

/**
 * App shell — кэшируется при установке; отказ любого обязательного
 * URL честно проваливает install (браузер оставляет рабочую старую
 * версию SW вместо «успешной» установки с полупустым кэшем).
 */
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

/**
 * Ресурсы, кэшируемые «по ходу»: их отсутствие (не задеплоены /
 * нет прав) не блокирует установку и не ломает офлайн-режим.
 */
const OPTIONAL_URLS = [
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './screenshot-narrow.png',
  './screenshot-wide.png',
];

/**
 * INSTALL: кэшируем shell (обязательно) + опциональные ресурсы.
 * skipWaiting не вызывается — обновлением управляет index.html
 * (postMessage 'SKIP_WAITING' при наличии контроллера); первый
 * install активируется и без него (нечего вытеснять).
 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        const required = Promise.all(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(err => {
              console.error('[SW] precache failed:', url, err.message);
              throw err;
            })
          )
        );

        const optional = Promise.all(
          OPTIONAL_URLS.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] optional cache skipped:', url, err.message);
            })
          )
        );

        return Promise.all([required, optional]);
      })
  );
});

/**
 * ACTIVATE: удаляем все кэши, кроме текущей версии, и сразу
 * забираем контроль над открытыми вкладками (clients.claim).
 */
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.log('[SW] deleting old cache:', key);
            return caches.delete(key);
          })
      );

      await self.clients.claim();
    })()
  );
});

/**
 * FETCH: маршрутизация запросов.
 * - не-GET и cross-origin (CDN, релеи, Telegram) — pass-through;
 * - навигация и shell-файлы — network-first;
 * - остальная same-origin статика — cache-first.
 */
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstThenCache(req));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(networkFirstThenCache(req));
    return;
  }

  event.respondWith(cacheFirstThenNetwork(req));
});

/**
 * Shell-файлы приложения: точное совпадение имени файла из множества
 * (работает и при деплое в подкаталог).
 * @param {URL} url - Разобранный URL запроса.
 * @returns {boolean}
 */
const SHELL_FILES = new Set(['style.css', 'app.js']);

function isShellAsset(url) {
  const name = url.pathname.split('/').pop();
  return SHELL_FILES.has(name);
}

/**
 * Network-first с обходом HTTP-кэша (cache: 'reload').
 * Свежесть shell-файлов важнее экономии трафика: без 'reload' fetch
 * мог возвращать протухший ответ из кэша CDN (GitHub Pages, max-age
 * 600). Офлайн — fallback на кэш SW, затем на index.html, затем 503.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function networkFirstThenCache(req) {
  try {
    const netRes = await fetch(req, { cache: 'reload' });
    if (netRes && netRes.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, netRes.clone()).catch(() => {});
    }
    return netRes;
  } catch (err) {
    const cached = await caches.match(req, { cacheName: CACHE_VERSION });
    if (cached) return cached;

    const fallback = await caches.match('./index.html', { cacheName: CACHE_VERSION });
    if (fallback) return fallback;

    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

/**
 * Cache-first для статики: только кэш актуальной версии, затем сеть
 * (успешные ответы складируются), затем 503.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function cacheFirstThenNetwork(req) {
  const cached = await caches.match(req, { cacheName: CACHE_VERSION });
  if (cached) return cached;

  try {
    const netRes = await fetch(req);
    if (netRes && netRes.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, netRes.clone()).catch(() => {});
    }
    return netRes;
  } catch (err) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

/**
 * MESSAGE: принудительное обновление из приложения.
 * 'SKIP_WAITING' — новая версия активируется немедленно;
 * 'CLEAR_CACHE' — полный сброс (все кэши, не только текущей версии).
 */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => console.log('[SW] все кэши очищены по запросу'));
  }
});
