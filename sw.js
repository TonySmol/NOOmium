/**
 * Service Worker для PWA-приложения NOOmium.
 *
 * Версионирование кеша:
 * Имя кеша формируется из query-параметра `?v=<app-version>` при регистрации SW,
 * что обеспечивает cache-busting при деплое новой версии приложения.
 *
 * Стратегии кеширования:
 * ┌──────────────────────┬────────────────────────┬──────────────────────────┐
 * │ Тип запроса          │ Стратегия              │ Поведение                │
 * ├──────────────────────┼────────────────────────┼──────────────────────────┤
 * │ WebSocket / CDN      │ Pass-through           │ Без перехвата SW         │
 * │ Navigation (HTML)    │ Network-First + Cache  │ Свежий HTML + offline    │
 * │ Static Assets        │ Stale-While-Revalidate │ Быстрый ответ + bg update│
 * │ Остальные GET        │ Network-Only           │ Только сеть              │
 * └──────────────────────┴────────────────────────┴──────────────────────────┘
 *
 * Жизненный цикл обновления:
 * 1. Клиент посылает {type: 'SKIP_WAITING'} для немедленной активации.
 * 2. Новый SW активируется, удаляет кеши предыдущих версий.
 * 3. clients.claim() перехватывает контроль над открытыми вкладками.
 * 4. controllerchange на клиенте перезагружает страницу для консистентности.
 *
 * @file sw.js
 * @version 1.2.0
 */

/**
 * Уникальное имя кеша для текущей версии.
 * Извлекается из query-параметра `v` URL регистрации SW.
 * Fallback на 'unknown' защищает от мусорных ключей при ручной регистрации без параметра.
 * @type {string}
 */
const CACHE_NAME = 'noomium-v' + (new URL(self.location).searchParams.get('v') || 'unknown');

/**
 * Канонический ключ для кеширования навигационных документов.
 * Используется вместо оригинального URL, чтобы унифицировать / и /index.html.
 * Это решает проблему, когда браузер запрашивает `/index.html`,
 * а в кеше хранится только `/` (или наоборот).
 * @type {string}
 */
const CACHE_NAVIGATION_KEY = '/';

/**
 * Список destination-типов, для которых применяется Stale-While-Revalidate.
 * Включает все статические ассеты, критичные для быстрого повторного запуска.
 * @type {string[]}
 */
const STALE_WHILE_REVALIDATE_DESTINATIONS = ['script', 'style', 'font', 'image'];

/**
 * Домены CDN, проходящие через SW без перехвата (Network-Only).
 *
 * Причины исключения:
 * 1. `@xenova/transformers` использует собственный кеш ONNX-весов (`env.useBrowserCache`).
 * 2. Динамические ESM-импорты возвращают Opaque Responses (CORS),
 *    которые нельзя корректно сохранить через `caches.put()`.
 * 3. ML-модели (~33 МБ) рискуют исчерпать квоту StorageManager,
 *    что может привести к принудительной очистке IndexedDB браузером.
 *
 * @type {string[]}
 */
const CDN_HOSTS = ['cdn.jsdelivr.net', 'huggingface.co'];

/**
 * Генерирует HTML-ответ для офлайн-режима, когда навигационный документ
 * недоступен ни из сети, ни из кеша (первый запуск без интернета).
 *
 * Возвращает status 200, чтобы SW не бросал исключение и браузер
 * корректно отобразил страницу вместо "No internet" ошибки.
 *
 * Использует тег <a href="/"> вместо <button onclick="location.reload()">,
 * так как строгий CSP приложения (script-src без 'unsafe-inline')
 * блокирует inline-обработчики событий.
 *
 * @returns {Response} Офлайн-страница с ссылкой-кнопкой для повторной попытки.
 */
function buildOfflineResponse() {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOOmium — Offline</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0b10;color:#ececf1;font-family:ui-sans-serif,-apple-system,sans-serif;
    padding:24px;text-align:center}
  .card{max-width:400px}
  h1{font-size:48px;margin:0 0 8px;font-weight:800}
  p{color:#a0a0ae;margin:0 0 24px;line-height:1.5}
  .btn{display:inline-block;background:#8b7cff;color:white;text-decoration:none;
    padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600}
  .btn:active{filter:brightness(1.1)}
</style>
</head>
<body>
<div class="card">
  <h1>◆</h1>
  <p>NOOmium недоступен без сети.<br>Проверьте подключение и попробуйте снова.</p>
  <a href="/" class="btn">Попробовать снова</a>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/**
 * Удаляет устаревшие кеши предыдущих версий приложения.
 * Логирует каждое успешное удаление для отладки.
 *
 * @param {string[]} cacheNames - Все существующие имена кешей.
 * @returns {Promise<void>}
 */
function cleanupOldCaches(cacheNames) {
  const outdated = cacheNames.filter((name) => name !== CACHE_NAME);
  if (outdated.length === 0) return Promise.resolve();

  return Promise.all(
    outdated.map((name) =>
      caches.delete(name)
        .then((deleted) => {
          if (deleted) {
            console.log('[SW] Deleted outdated cache:', name);
          }
          return deleted;
        })
        .catch((err) => {
          console.warn('[SW] Failed to delete cache:', name, err);
          return false;
        })
    )
  ).then(() => undefined);
}

/**
 * Событие установки Service Worker.
 *
 * **Важно:** `self.skipWaiting()` НЕ вызывается автоматически.
 * Это даёт клиенту контроль над процессом обновления:
 * пользователь может завершить критические операции (например,
 * редактирование заметки) перед активацией нового SW.
 *
 * Немедленная активация инициируется только сообщением `SKIP_WAITING`
 * от основного потока (см. обработчик `message`).
 *
 * @param {ExtendableEvent} _e - Событие жизненного цикла SW.
 * @returns {void}
 */
self.addEventListener('install', (_e) => {
  // Намеренно пусто: skipWaiting управляется клиентом через message event
  console.log('[SW] Installed, version:', CACHE_NAME);
});

/**
 * Событие активации Service Worker.
 * 1. Очищает кеши предыдущих версий.
 * 2. Захватывает контроль над всеми открытыми клиентами (clients.claim).
 *
 * @param {ExtendableEvent} e - Событие жизненного цикла SW.
 * @returns {void}
 */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(cleanupOldCaches)
      .then(() => self.clients.claim())
      .then(() => {
        console.log('[SW] Activated, cache:', CACHE_NAME);
      })
      .catch((err) => {
        console.error('[SW] Activation failed:', err);
      })
  );
});

/**
 * Обработчик сообщений от основного потока (main thread).
 * Поддерживает команду `SKIP_WAITING` для немедленной активации
 * новой версии SW без ожидания закрытия вкладок пользователем.
 *
 * @param {MessageEvent<{type: string}>} event - Сообщение от клиента.
 * @returns {void}
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received, activating immediately');
    self.skipWaiting();
  }
});

/**
 * Стратегия Network-First для навигационных запросов.
 *
 * Алгоритм:
 * 1. Пытаемся загрузить свежий HTML из сети.
 * 2. При успехе — сохраняем клон под каноническим ключом `CACHE_NAVIGATION_KEY`.
 * 3. При провале сети — ищем в кеше по оригинальному URL, затем по каноническому ключу.
 * 4. Если ничего не найдено — возвращаем offline-страницу.
 *
 * @param {Request} request - Навигационный запрос.
 * @returns {Promise<Response>}
 */
function handleNavigation(request) {
  return fetch(request)
    .then((networkRes) => {
      if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
        const clone = networkRes.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(CACHE_NAVIGATION_KEY, clone))
          .catch((err) => console.warn('[SW] Failed to cache navigation:', err));
      }
      return networkRes;
    })
    .catch(() => {
      // Сеть недоступна — ищем в кеше
      return caches.match(request)
        .then((exactMatch) => {
          if (exactMatch) return exactMatch;
          return caches.match(CACHE_NAVIGATION_KEY);
        })
        .then((fallbackMatch) => {
          return fallbackMatch || buildOfflineResponse();
        });
    });
}

/**
 * Стратегия Stale-While-Revalidate для статических ассетов.
 *
 * Алгоритм:
 * 1. Ищем совпадение в кеше.
 * 2. Если найдено — сразу возвращаем (stale) и в фоне обновляем кеш (revalidate).
 * 3. Если не найдено — ждём ответа сети и сохраняем его в кеш.
 * 4. При сетевой ошибке без кеша — возвращаем 504 Gateway Timeout.
 *
 * @param {Request} request - Запрос статического ассета.
 * @param {FetchEvent} event - Исходное событие fetch (для waitUntil).
 * @returns {Promise<Response>}
 */
function handleStaleWhileRevalidate(request, event) {
  return caches.match(request).then((cached) => {
    /**
     * Фоновое обновление кеша из сети.
     * @returns {Promise<Response | null>}
     */
    const revalidate = () =>
      fetch(request)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(request, clone))
              .catch((err) => console.warn('[SW] Cache update failed:', err));
          }
          return networkRes;
        })
        .catch(() => null);

    if (cached) {
      // Stale: отдаём кеш сразу, revalidate в фоне
      event.waitUntil(revalidate());
      return cached;
    }

    // Нет в кеше — ждём сеть и сохраняем
    return revalidate().then((res) => {
      if (res) return res;
      // Финальный fallback: если и сеть упала, бросаем ошибку,
      // чтобы браузер показал нативную offline-ошибку для ассетов
      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    });
  });
}

/**
 * Pass-through для запросов, которые не должны перехватываться SW.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
function handlePassthrough(request) {
  return fetch(request);
}

/**
 * Определяет, должен ли запрос пройти через SW без перехвата.
 * @param {URL} url - URL запроса.
 * @returns {boolean}
 */
function shouldPassthrough(url) {
  return (
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    CDN_HOSTS.includes(url.hostname)
  );
}

/**
 * Глобальный обработчик сетевых запросов (fetch).
 * Маршрутизирует запросы к соответствующей стратегии кеширования.
 *
 * @param {FetchEvent} e - Событие перехваченного запроса.
 * @returns {void}
 */
self.addEventListener('fetch', (e) => {
  // Обрабатываем только GET-запросы
  if (e.request.method !== 'GET') return;

  let url;
  try {
    url = new URL(e.request.url);
  } catch (err) {
    // Некорректный URL — пропускаем
    return;
  }

  // 1. Pass-through: WebSocket и CDN
  if (shouldPassthrough(url)) {
    return;
  }

  // 2. Navigation: Network-First с fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(handleNavigation(e.request));
    return;
  }

  // 3. Static Assets: Stale-While-Revalidate
  if (STALE_WHILE_REVALIDATE_DESTINATIONS.includes(e.request.destination)) {
    e.respondWith(handleStaleWhileRevalidate(e.request, e));
    return;
  }

  // 4. Остальные GET-запросы: Network-Only (без кеширования)
  e.respondWith(handlePassthrough(e.request));
});
