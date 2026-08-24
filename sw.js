const CACHE_NAME = 'noomium-v1';
const ASSETS = [
  '.',
  './index.html',
  './manifest.json',
];

// Установка: кэшируем основные ресурсы
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Кэшируем по одному, чтобы 404 не ронял весь addAll
        const promises = ASSETS.map(url =>
          cache.add(url).catch(err => {
            console.warn('SW: не удалось закэшировать', url, err.message);
          })
        );
        return Promise.all(promises);
      })
      .catch(err => {
        console.warn('SW: ошибка установки кэша', err.message);
      })
  );
  self.skipWaiting();
});

// Активация: удаляем старые кэши
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Перехват запросов: сеть с фолбэком на кэш
self.addEventListener('fetch', event => {
  // Игнорируем не-GET запросы и не-HTTP
  if (event.request.method !== 'GET') return;
  
  let url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return;
  }
  
  // Для внешних ресурсов (CDN, relays): только сеть
  if (url.origin !== self.location.origin) {
    return;
  }
  
  // Для своих ресурсов: сеть с фолбэком на кэш
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Кэшируем только успешные ответы
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, clone))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => {
        // Если сеть упала, берём из кэша
        return caches.match(event.request).then(r => r || Response.error());
      })
  );
});
