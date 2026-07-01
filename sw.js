/**
 * NOOmium Service Worker
 * 
 * Стратегия кэширования:
 * - App Shell (HTML) — Cache First с версионированием
 * - CDN ресурсы (nostr-tools, transformers) — Network First с fallback на cache
 * - AI модель — Network Only (слишком большая для cache)
 * 
 * Обновления:
 * - При получении SKIP_WAITING → немедленная активация
 * - При активации → очистка старых кэшей
 * - После активации → уведомление клиентов о reload
 */

var CACHE_VERSION = 'noomium-sw-v2-r1';
var APP_SHELL_CACHE = 'noomium-app-shell-v2-r1';
var CDN_CACHE = 'noomium-cdn-v2-r1';

/**
 * Список URL для предварительного кэширования при установке.
 */
var PRECACHE_URLS = [
  './',
  './index.html'
];

/**
 * Паттерны CDN для кэширования.
 */
var CDN_PATTERNS = [
  'cdn.jsdelivr.net/npm/nostr-tools',
  'cdn.jsdelivr.net/npm/@xenova/transformers'
];

/**
 * Паттерны для Network Only (не кэшировать).
 */
var NETWORK_ONLY_PATTERNS = [
  'huggingface.co',
  'cdn-lfs',
  '.gguf',
  '.onnx'
];

/**
 * Проверяет, соответствует ли URL одному из паттернов.
 */
function matchesPattern(url, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    if (url.indexOf(patterns[i]) !== -1) return true;
  }
  return false;
}

/**
 * Установка: предварительное кэширование app shell.
 */
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(function(cache) {
        return cache.addAll(PRECACHE_URLS);
      })
      .then(function() {
        return self.skipWaiting();
      })
  );
});

/**
 * Активация: очистка старых кэшей, захват клиентов.
 */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(cacheNames) {
        return Promise.all(
          cacheNames
            .filter(function(name) {
              return name !== APP_SHELL_CACHE && 
                     name !== CDN_CACHE &&
                     name.indexOf('noomium') !== -1;
            })
            .map(function(name) {
              return caches.delete(name);
            })
        );
      })
      .then(function() {
        return self.clients.claim();
      })
      .then(function() {
        // Уведомляем всех клиентов о новой версии
        return self.clients.matchAll().then(function(clients) {
          clients.forEach(function(client) {
            client.postMessage({ type: 'sw:activated', version: CACHE_VERSION });
          });
        });
      })
  );
});

/**
 * Обработка сообщений от клиентов.
 */
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Fetch: маршрутизация запросов.
 */
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  
  // Network Only для AI модели и Nostr relay WebSocket
  if (matchesPattern(url, NETWORK_ONLY_PATTERNS) || 
      url.indexOf('ws://') === 0 || 
      url.indexOf('wss://') === 0) {
    return;
  }
  
  // App Shell — Cache First
  if (url.indexOf(self.location.origin) === 0 && 
      (url.endsWith('/') || url.endsWith('.html') || url === self.location.origin)) {
    event.respondWith(
      caches.match(event.request)
        .then(function(cached) {
          var fetchPromise = fetch(event.request).then(function(networkResponse) {
            if (networkResponse && networkResponse.status === 200) {
              var cache = caches.open(APP_SHELL_CACHE);
              cache.then(function(c) { c.put(event.request, networkResponse); });
            }
            return networkResponse;
          }).catch(function() {
            return cached;
          });
          return cached || fetchPromise;
        })
    );
    return;
  }
  
  // CDN ресурсы — Network First с fallback
  if (matchesPattern(url, CDN_PATTERNS)) {
    event.respondWith(
      fetch(event.request)
        .then(function(networkResponse) {
          if (networkResponse && networkResponse.status === 200) {
            var cache = caches.open(CDN_CACHE);
            cache.then(function(c) { c.put(event.request, networkResponse); });
          }
          return networkResponse;
        })
        .catch(function() {
          return caches.match(event.request);
        })
    );
    return;
  }
  
  // Остальные запросы — Network First
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
