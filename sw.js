/**
 * Service Worker для PWA-приложения NOOmium.
 * Версия передаётся через URL-параметр ?v=<app-version> для cache-busting.
 *
 * @file sw.js
 * @version 1.0.0
 */

/**
 * Уникальное имя кэша для текущей версии приложения.
 * Извлекается из query-параметра `v` URL-адреса регистрации SW.
 * @type {string}
 */
const APP_VERSION = '1.3.9';
const CACHE_NAME = 'noomium-v' + new URL(self.location).searchParams.get('v');

/**
 * Список доменов CDN, которые должны проходить сквозь SW без перехвата (network-only).
 *
 * Причины исключения:
 * 1. `@xenova/transformers` имеет собственный механизм кэширования ONNX-весов через `env.useBrowserCache`.
 * 2. Динамические ESM-импорты с CDN могут возвращать Opaque Responses (CORS),
 *    которые нельзя сохранить через `caches.put()` без повреждения бандла.
 * 3. Кэширование ML-моделей (~33 МБ) через Cache API рискует исчерпать квоту StorageManager,
 *    что может привести к принудительной очистке IndexedDB браузером.
 *
 * @type {string[]}
 */
const CDN_HOSTS = ['cdn.jsdelivr.net', 'huggingface.co'];

/**
 * Событие установки Service Worker.
 * Немедленно активирует новый SW, не дожидаясь закрытия всех клиентов.
 *
 * @param {ExtendableEvent} e - Событие жизненного цикла SW.
 * @returns {void}
 */
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

/**
 * Событие активации Service Worker.
 * Очищает устаревшие кэши предыдущих версий приложения и захватывает контроль над клиентами.
 *
 * @param {ExtendableEvent} e - Событие жизненного цикла SW.
 * @returns {void}
 */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    /** @type {Promise<void>} */ (
      caches.keys().then(
        /**
         * Фильтрует и удаляет все кэши, не совпадающие с текущим CACHE_NAME.
         * @param {string[]} cacheNames - Массив всех существующих имён кэшей.
         * @returns {Promise<boolean[]>}
         */
        (cacheNames) => {
          return Promise.all(
            cacheNames
              .filter((name) => name !== CACHE_NAME)
              .map((name) => caches.delete(name))
          );
        }
      ).then(() => self.clients.claim())
    )
  );
});

/**
 * Обработчик сообщений от основного потока (main thread).
 * Поддерживает команду `SKIP_WAITING` для немедленной активации новой версии SW
 * без ожидания закрытия вкладок пользователем.
 *
 * @param {MessageEvent<{type: string}>} event - Сообщение от клиента.
 * @returns {void}
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Глобальный обработчик сетевых запросов (fetch).
 * Реализует гибридную стратегию кэширования:
 * - Pass-through (network-only) для WebSocket и CDN.
 * - Cache-First для навигации (HTML) — обеспечивает мгновенный offline-старт.
 * - Cache-First с network-fallback для локальных ассетов.
 *
 * @param {FetchEvent} e - Событие перехваченного запроса.
 * @returns {void}
 */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  /** @type {URL} */
  const url = new URL(e.request.url);

  // 1. Pass-through: WebSocket и CDN пропускаем напрямую.
  // SW не должен вмешиваться в загрузку ML-моделей, ESM-библиотек и live-подписок Nostr.
  if (
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    CDN_HOSTS.includes(url.hostname)
  ) {
    return;
  }

  // 2. Navigation (index.html): Cache-First.
  // Обновление HTML происходит автоматически за счёт смены CACHE_NAME при деплое новой версии.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match(e.request).then(
        /**
         * Возвращает закэшированный HTML или загружает его из сети.
         * @param {Response | undefined} cached - Найденный в кэше ответ.
         * @returns {Promise<Response>}
         */
        (cached) => {
          return cached || fetch(e.request).then(
            /**
             * Сохраняет свежий HTML в кэш при успешном сетевом ответе.
             * @param {Response} res - Ответ от сервера.
             * @returns {Response}
             */
            (res) => {
              if (res && res.status === 200) {
                const clone = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
              }
              return res;
            }
          );
        }
      )
    );
    return;
  }

  // 3. Local Assets (CSS, JS, fonts): Cache-First с network-fallback.
  e.respondWith(
    caches.match(e.request).then(
      /**
       * Пытается отдать ассет из кэша, при промахе обращается к сети.
       * @param {Response | undefined} cached - Найденный в кэше ответ.
       * @returns {Promise<Response>}
       */
      (cached) => {
        return cached || fetch(e.request).then(
          /**
           * Кэширует и возвращает сетевой ответ.
           * @param {Response} res - Ответ от сервера.
           * @returns {Response | Promise<Response>}
           */
          (res) => {
            // Кэшируем только same-origin успешные ответы (type === 'basic').
            // Cross-origin ответы без CORS (opaque) кэшировать опасно — они могут сломать бандл.
            if (res && res.status === 200 && res.type === 'basic') {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
            }
            return res;
          }
        ).catch(
          /**
           * Обработка полного отсутствия сети.
           * Fallback на корневой документ применим только для навигации.
           * @returns {Response | Promise<Response | undefined>}
           */
          () => {
            // Fallback на корень ТОЛЬКО для документов, не для бинарных ассетов
            if (e.request.destination === 'document') {
              return caches.match('/');
            }
            // Для картинок/шрифтов отдаём 408, чтобы браузер не получил HTML вместо бинарника
            return new Response('', { status: 408, statusText: 'Offline' });
          }
        );
      }
    )
  );
});
