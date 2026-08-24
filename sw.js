const CACHE_NAME = 'noomium-v1';
const ASSETS = [
  '.',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Установка: кэшируем основные ресурсы
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting(); // Активируем сразу, без ожидания
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
  self.clients.claim(); // Берём контроль над всеми клиентами
});

// Перехват запросов: сеть с фолбэком на кэш
self.addEventListener('fetch', event => {
  // Игнорируем не-GET запросы
  if (event.request.method !== 'GET') return;
  
  const url = new URL(event.request.url);
  
  // Для внешних ресурсов (nostr-tools, transformers): только сеть, без кэша
  if (url.origin !== self.location.origin) {
    return;
  }
  
  // Для своих ресурсов: сеть с фолбэком на кэш
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Кэшируем успешные ответы
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Если сеть упала, берём из кэша
        return caches.match(event.request);
      })
  );
});
