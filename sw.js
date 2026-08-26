// ═══════════════════════════════════════════════════════════════════════════
// NOOmium Service Worker
// Стратегия: network-first для навигации, cache-first для статики,
// pass-through для внешних CDN и WebSocket.
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'noomium-v0.6.2';

// Ресурсы, которые кэшируем сразу при установке (app shell)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Ресурсы, которые кэшируем "по ходу" (не блокируют установку, если отсутствуют)
// НОВОЕ: добавлены скриншоты для офлайн-доступа
const OPTIONAL_URLS = [
  './icon-maskable.png',
  './screenshot-narrow.png',
  './screenshot-wide.png',
];

// ═══════════════════════════════════════════════════════════════════════════
// INSTALL: кэшируем shell + опциональные ресурсы
// ═══════════════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        // Обязательные ресурсы: если хоть один упал — установка фейлится
        const required = Promise.all(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(err => {
              console.error('[SW] precache failed:', url, err.message);
              throw err;
            })
          )
        );

        // Опциональные: не блокируем установку, если их нет
        const optional = Promise.all(
          OPTIONAL_URLS.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] optional cache skipped:', url, err.message);
            })
          )
        );

        return Promise.all([required, optional]);
      })
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[SW] install failed:', err);
      })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVATE: удаляем старые кэши, берём контроль над клиентами
// ═══════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Удаляем все кэши, кроме текущего
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.log('[SW] deleting old cache:', key);
            return caches.delete(key);
          })
      );

      // Берём контроль над всеми открытыми вкладками сразу
      await self.clients.claim();
    })()
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// FETCH: маршрутизация запросов
// ═══════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const req = event.request;

  // Игнорируем не-GET
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // Cross-origin (CDN, relays, Telegram): не трогаем, пусть идёт напрямую.
  // SW не может корректно кэшировать их из-за CORS и особенностей (WS, ESM).
  if (url.origin !== self.location.origin) return;

  // Навигация (HTML-страницы): network-first с fallback на кэш.
  // Это даёт офлайн-работу, но всегда свежую версию при сети.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstThenCache(req));
    return;
  }

  // Всё остальное (CSS, JS, иконки, картинки из same-origin): cache-first.
  event.respondWith(cacheFirstThenNetwork(req));
});

// ═══════════════════════════════════════════════════════════════════════════
// СТРАТЕГИИ
// ═══════════════════════════════════════════════════════════════════════════

async function networkFirstThenCache(req) {
  try {
    const netRes = await fetch(req);
    // Успех — обновляем кэш свежей копией
    if (netRes && netRes.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, netRes.clone()).catch(() => {});
    }
    return netRes;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;

    // Fallback на главную (для SPA-навигации)
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;

    // Совсем ничего — обычный network error
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirstThenNetwork(req) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const netRes = await fetch(req);
    // Кэшируем только валидные ответы
    if (netRes && netRes.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, netRes.clone()).catch(() => {});
    }
    return netRes;
  } catch (err) {
    // Нет ни в кэше, ни в сети — 503
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE: принудительное обновление кэша (можно вызвать из приложения)
// ═══════════════════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.delete(CACHE_VERSION).then(() => {
      console.log('[SW] cache cleared on demand');
    });
  }
});
