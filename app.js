// ═══════════════════════════════════════════════════════════════════════════════
// NOOmium — app.js
// Соцсеть смыслов: мысли ищутся по значению, а не по словам.
//
// Архитектура: DI-контейнер + EventBus. Слои: CORE / DATA / AI / NET / DOMAIN /
// UI / PLATFORM / BOOT.
//
// МОДЕЛЬ ДАННЫХ (v0.7):
// - uid — единственный стабильный идентификатор своей заметки.
// - Канон: зашифрованное NIP-44 событие kind 30078 (replaceable, d-tag = uid)
//   — синхронизация между устройствами через релеи.
// - Публичная заметка — проекция kind 1 с тегом uid (видна сети).
// - eventId — только ссылка на публичную проекцию, не идентификатор заметки.
// - parentId своих заметок — всегда uid. Миграция parentId→eventId удалена.
//
// КАРТА ПОСТАВКИ (волны):
//   в1:  Config, EventBus, Logger
//   в2:  Utils, I18n, Store
//   в3:  Vec, DB
//   в4:  Embedder, Ranker
//   в5:  Crypto*, Nostr, Protocol
//   в6:  NetService
//   в7:  Notes, Context
//   в8:  Feed, Provenance, Influence
//   в9:  Account*, NoteActions
//   в10: Modal, Toast, Progress
//   в11: HeaderStatus, Onboarding
//   в12: Composer
//   в13: FeedView
//   в14: BaseView, NoteView
//   в15: AccountView*, MenuView
//   в16: TelegramAdapter, Boot
//   (* — новые модули)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ВЕРСИЯ ПРИЛОЖЕНИЯ
// ═══════════════════════════════════════════════════════════════════════════════
const APP_VERSION = '0.7.2';

// ═══════════════════════════════════════════════════════════════════════════════
// CORE/DI — ПРЕАМБУЛА
// Контейнер зависимостей: ленивый резолв, защита от циклов.
// ═══════════════════════════════════════════════════════════════════════════════
const DI = (() => {
  const factories = new Map();
  const instances = new Map();

  function register(name, factory, deps) {
    factories.set(name, { factory, deps: deps || [] });
  }

  function resolve(name, visiting) {
    if (instances.has(name)) return instances.get(name);
    const def = factories.get(name);
    if (!def) throw new Error('Module not found: ' + name);
    visiting = visiting || new Set();
    if (visiting.has(name)) throw new Error('Circular dependency: ' + name);
    visiting.add(name);
    const args = def.deps.map(d => resolve(d, visiting));
    visiting.delete(name);
    const inst = def.factory(...args);
    instances.set(name, inst);
    return inst;
  }

  return { register, resolve };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: CORE — конфигурация, события, логирование, утилиты, i18n, стор
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CORE/Config ─── START ──────────────────────────────────────────────────
/**
 * Глобальная конфигурация приложения с поддержкой миграций схемы.
 *
 * Единственный источник истины для всех настраиваемых параметров.
 * Хранится в localStorage под ключом «noomium:cfg».
 *
 * При добавлении нового параметра:
 * 1. Добавить в `defaults`
 * 2. При необходимости добавить миграцию в `migrations`
 * 3. Поднять `SCHEMA_VERSION`
 *
 * Схема v8 (v0.7.0):
 * - добавлены ключи аккаунта/синхронизации: syncEnabled, keyExported,
 *   syncMigrated и kPrivate (kind приватного канона);
 * - удалены мёртвые ключи ранних версий (миграция 8);
 * - reconnectMaxAttempts / reconnectMaxDelay теперь реально используются
 *   (экспоненциальный реконнект в NetService).
 */
DI.register('Config', function () {
  const KEY = 'noomium:cfg';
  const SCHEMA_VERSION = 8;

  const defaults = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    room: 'noomium-main',
    theme: 'dark',
    lang: null,
    onboarded: false,
    logLevel: 'info',

    // AI / Embedding
    model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    dim: 384,
    aiCacheLimit: 300,
    aiEmbedTimeout: 15000,

    // Ранжирование (адаптировано под Granite R2, диапазон ~0.55–0.93)
    threshold: 0.81,
    serendipity: 0.07,
    duplicateThreshold: 0.88,

    // Отображение сходства: 'signal' (индикатор + текст) или 'percent' (сырые %)
    similarityDisplay: 'signal',

    // Nostr / сеть
    relays: [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://offchain.pub',
      'wss://nos.lol',
      'wss://nostr.oxtr.dev',
      'wss://relay.mostr.pub',
    ],
    kNote: 1,
    kPrivate: 30078,
    kQuery: 21000,
    kAnswer: 21001,
    kDelete: 5,
    queryRateLimit: 3000,
    maxResponses: 8,
    responseWindow: 6000,
    centroidCount: 12,
    peerTTL: 60000,
    heartbeat: 30000,
    subWindow: 300,
    historyMaxWindow: 2592000,
    reconnectMaxAttempts: 10,
    reconnectBaseDelay: 1000,
    reconnectMaxDelay: 60000,
    seenMaxSize: 1000,
    maxAnswerTextLength: 10000,
    maxNoteTextLength: 10000,
    maxIncomingNotesPerPeer: 20,

    // Хранилище
    dbName: 'noomium_v2',
    storeName: 'notes',
    cacheStoreName: 'cache',

    // UI / UX
    debounce: 350,
    baseSearchDebounce: 200,
    truncateTextLength: 140,
    toastMaxVisible: 3,
    toastDefaultDuration: 2200,

    // Лимиты длины поста
    maxPostLength: 2500,
    softLimit: 1200,
    hardLimit: 2000,

    // Telegram: если пользователь вручную выбрал тему, игнорируем themeChanged
    userThemeOverride: false,

    // Аккаунт / синхронизация (v8)
    syncEnabled: true,   // публикация приватного канона (kind 30078) на релеи
    keyExported: false,  // пользователь видел/сохранял свой ключ
    syncMigrated: false, // одноразовый backsweep v0.6 → v0.7 выполнен
  });

  const migrations = {
    // Исторические миграции (оставлены для совместимости цикла)
    1: s => s,
    2: s => s,
    3: s => s,
    4: s => s,

    // v5: адаптация порогов под Granite R2
    5: s => {
      if (typeof s.threshold === 'number' && s.threshold === 0.65) {
        s.threshold = defaults.threshold;
      }
      if (typeof s.serendipity === 'number' && s.serendipity === 0.25) {
        s.serendipity = defaults.serendipity;
      }
      if (typeof s.vectorSimilarityThreshold === 'number' && s.vectorSimilarityThreshold === 0.98) {
        s.vectorSimilarityThreshold = 0.95;
      }
      return s;
    },

    // v6: добавлен режим отображения сходства
    6: s => {
      if (typeof s.similarityDisplay !== 'string') {
        s.similarityDisplay = defaults.similarityDisplay;
      }
      return s;
    },

    // v7: переименование vectorSimilarityThreshold → duplicateThreshold
    7: s => {
      if ('vectorSimilarityThreshold' in s) {
        s.duplicateThreshold = s.vectorSimilarityThreshold;
        delete s.vectorSimilarityThreshold;
      }
      if (typeof s.duplicateThreshold !== 'number') {
        s.duplicateThreshold = defaults.duplicateThreshold;
      }
      return s;
    },

    // v8: аккаунт/синк + чистка мёртвых ключей
    8: s => {
      const dead = [
        'maxPasswordAttempts',
        'influenceWeightByAge',
        'indexerUrl',
        'premiumRelay',
        'gpuRanking',
        'cloudView',
        'relayErrorThreshold',
        'relayCircuitBreakTime',
        'relayBackoff1',
        'relayBackoff2',
      ];
      dead.forEach(k => { delete s[k]; });
      return s;
    },
  };

  const state = Object.assign({}, defaults);

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      let saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        let v = saved.schemaVersion || saved.version || 1;
        while (v < SCHEMA_VERSION) {
          const migrate = migrations[v];
          if (typeof migrate === 'function') {
            saved = migrate(saved);
          }
          v++;
        }
        saved.schemaVersion = SCHEMA_VERSION;
        for (const k of Object.keys(defaults)) {
          if (k in saved) state[k] = saved[k];
        }
      }
    }
  } catch (_) {}

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (_) {}
  }

  return {
    /**
     * Получить значение параметра.
     * @param {string} k - Ключ.
     * @param {*} [def] - Значение по умолчанию, если ключа нет в состоянии.
     * @returns {*}
     */
    get(k, def) { return (k in state) ? state[k] : def; },

    /**
     * Установить значение и сразу сохранить.
     * @param {string} k - Ключ.
     * @param {*} v - Значение.
     */
    set(k, v) { state[k] = v; persist(); },

    /** Сохранить текущее состояние в localStorage. */
    save: persist,

    /** @returns {Object} Копия дефолтов. */
    defaults() { return Object.assign({}, defaults); },

    /** @returns {Object} Копия всего состояния. */
    all() { return Object.assign({}, state); },

    /** @returns {number} Текущая версия схемы. */
    schemaVersion() { return SCHEMA_VERSION; },

    /** Сбросить все параметры к дефолтам и сохранить. */
    reset() {
      for (const k of Object.keys(defaults)) state[k] = defaults[k];
      persist();
    },
  };
});
// ─── CORE/Config ─── END ────────────────────────────────────────────────────

// ─── CORE/EventBus ─── START ────────────────────────────────────────────────
/**
 * Простая шина событий с поддержкой точечных подписок и wildcard ('*').
 * Все модули общаются исключительно через неё, избегая прямых ссылок друг на друга.
 */
DI.register('EventBus', function () {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();
  /** @type {Set<Function>} */
  const wild = new Set();

  /**
   * Подписаться на событие.
   * @param {string} event - Имя события или '*' для перехвата всех.
   * @param {Function} fn - Обработчик.
   * @returns {Function} Функция отписки.
   */
  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (event === '*') {
      wild.add(fn);
      return () => wild.delete(fn);
    }
    if (!map.has(event)) map.set(event, new Set());
    map.get(event).add(fn);
    return () => {
      const s = map.get(event);
      if (s) {
        s.delete(fn);
        if (!s.size) map.delete(event);
      }
    };
  }

  /**
   * Подписаться на одно срабатывание.
   * @param {string} event - Имя события.
   * @param {Function} fn - Обработчик.
   * @returns {Function} Функция отписки.
   */
  function once(event, fn) {
    const off = on(event, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }

  /**
   * Отписаться (альтернатива вызову функции отписки).
   * @param {string} event - Имя события или '*'.
   * @param {Function} fn - Обработчик.
   */
  function off(event, fn) {
    if (event === '*') {
      wild.delete(fn);
      return;
    }
    const s = map.get(event);
    if (s) {
      s.delete(fn);
      if (!s.size) map.delete(event);
    }
  }

  /**
   * Эмит события. Ошибки в обработчиках логируются, но не прерывают цепочку.
   * @param {string} event - Имя события.
   * @param {*} [payload] - Полезная нагрузка.
   */
  function emit(event, payload) {
    const s = map.get(event);
    if (s) {
      for (const fn of Array.from(s)) {
        try {
          fn(payload);
        } catch (e) {
          console.error('[bus:' + event + ']', e);
        }
      }
    }
    if (wild.size) {
      for (const fn of Array.from(wild)) {
        try {
          fn(event, payload);
        } catch (e) {
          console.error('[bus:*]', e);
        }
      }
    }
  }

  return { on, once, off, emit };
});
// ─── CORE/EventBus ─── END ──────────────────────────────────────────────────

// ─── CORE/Logger ─── START ──────────────────────────────────────────────────
/**
 * Логгер с уровнями, цветным выводом в консоль и кольцевым буфером истории.
 *
 * Отличие от v0.6: начальный порог вывода читается из Config.logLevel
 * (раньше параметр существовал в конфиге, но игнорировался).
 */
DI.register('Logger', function (Config) {
  /** @type {Object<string, number>} */
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  /** @type {Object<string, string>} */
  const COLORS = {
    debug: 'color:#56c2b8',
    info: 'color:#e8a33d',
    warn: 'color:#e5c156',
    error: 'color:#e5646e;font-weight:bold',
  };

  /** @type {number} Минимальный уровень для вывода в консоль. */
  let threshold = LEVELS[Config.get('logLevel', 'info')] || LEVELS.info;

  /** @type {Array<Object>} Кольцевой буфер истории. */
  const ring = [];
  const RING_MAX = 200;

  const ts = () => new Date().toISOString().substr(11, 12);

  /**
   * Запись: буфер пишется всегда (независимо от порога),
   * консоль — только если уровень не ниже порога.
   * @param {'debug'|'info'|'warn'|'error'} level - Уровень.
   * @param {string} msg - Сообщение.
   * @param {*} [data] - Дополнительные данные.
   */
  function write(level, msg, data) {
    const time = ts();
    ring.push({ ts: time, level, msg, data });
    if (ring.length > RING_MAX) ring.shift();

    if (LEVELS[level] < threshold) return;
    const fn = console[level] || console.log;
    const prefix = '%c[' + time + '][' + level.toUpperCase() + ']';
    if (data === undefined) {
      fn(prefix, COLORS[level], msg);
    } else {
      fn(prefix, COLORS[level], msg, data);
    }
  }

  return {
    /**
     * Установить минимальный уровень вывода (в рантайме, не персистится).
     * @param {'debug'|'info'|'warn'|'error'} l - Уровень.
     */
    setLevel(l) {
      if (LEVELS[l]) threshold = LEVELS[l];
    },
    debug(m, d) { write('debug', m, d); },
    info(m, d) { write('info', m, d); },
    warn(m, d) { write('warn', m, d); },
    error(m, d) { write('error', m, d); },
    /** @returns {Array<Object>} Снимок кольцевого буфера. */
    history() { return ring.slice(); },
    /** Выгрузить всю накопленную историю в консоль. */
    dump() {
      for (const r of ring) {
        const fn = console[r.level] || console.log;
        fn('[' + r.ts + '][' + r.level.toUpperCase() + ']', r.msg, r.data === undefined ? '' : r.data);
      }
    },
  };
}, ['Config']);
// ─── CORE/Logger ─── END ────────────────────────────────────────────────────

// ─── CORE/Utils ─── START ───────────────────────────────────────────────────
/**
 * Утилиты: экранирование, плюрализация, форматирование дат, debounce.
 */
DI.register('Utils', function () {
  /** @type {Object<string, string>} */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /**
   * HTML-экранирование.
   * ВНИМАНИЕ: в текущей версии приложения весь пользовательский контент
   * рендерится через `textContent`, поэтому эта функция зарезервирована
   * на случай будущего rich-text рендеринга.
   * @param {*} s - Произвольное значение.
   * @returns {string} Безопасная для вставки строка.
   */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  }

  /**
   * Экранирование строки для использования в RegExp.
   * @param {*} s - Произвольное значение.
   * @returns {string} Экранированная строка.
   */
  function escRe(s) {
    return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Русская/общая плюрализация: одна форма для 1, другая для 2–4,
   * третья для остальных.
   * @param {number} n - Число.
   * @param {string} one - «1 символ».
   * @param {string} few - «2 символа».
   * @param {string} many - «5 символов».
   * @returns {string}
   */
  function plural(n, one, few, many) {
    n = Math.abs(n);
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
    return many;
  }

  /**
   * Словоформы для составных подписей (счётчики, статистика).
   * @type {Object<string, Function>}
   */
  const words = {
    symbols: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'char', 'chars', 'chars') : plural(n, 'символ', 'символа', 'символов')),
    peers: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'peer', 'peers', 'peers') : plural(n, 'узел', 'узла', 'узлов')),
    thoughts: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'note', 'notes', 'notes') : plural(n, 'мысль', 'мысли', 'мыслей')),
    descendants: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'heir', 'heirs', 'heirs') : plural(n, 'потомок', 'потомка', 'потомков')),
  };

  /**
   * Получить подпись «N <словоформа>» по ключу.
   * @param {string} key - Ключ словоформы (symbols/peers/thoughts/descendants).
   * @param {number} n - Число.
   * @param {string} [lang] - Язык ('ru' | 'en').
   * @returns {string}
   */
  function word(key, n, lang) {
    const fn = words[key];
    return fn ? fn(n, lang) : String(n);
  }

  /**
   * Дата в формате «12 мар».
   * @param {number} ts - Unix-milliseconds.
   * @param {string} [lang] - Язык.
   * @returns {string}
   */
  function fmtDate(ts, lang) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU', {
        day: '2-digit',
        month: 'short',
      });
    } catch (_) {
      return '';
    }
  }

  /**
   * Время в формате «14:05».
   * @param {number} ts - Unix-milliseconds.
   * @param {string} [lang] - Язык.
   * @returns {string}
   */
  function fmtTime(ts, lang) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return '';
    }
  }

  /**
   * Относительное время: «только что», «5 минут назад», «3 дня назад»,
   * дальше — дата. Формы берутся из словаря I18n.
   * @param {number} ts - Unix-milliseconds.
   * @param {string} lang - Язык.
   * @param {Function} t - Функция перевода I18n.
   * @returns {string}
   */
  function fmtRelativeTime(ts, lang, t) {
    if (!ts || typeof t !== 'function') return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return t('time.now');
    const min = Math.floor(sec / 60);
    if (min < 60) {
      const form = plural(min, t('time.min.one'), t('time.min.few'), t('time.min.many'));
      return min + ' ' + form;
    }
    const hr = Math.floor(min / 60);
    if (hr < 24) {
      const form = plural(hr, t('time.hr.one'), t('time.hr.few'), t('time.hr.many'));
      return hr + ' ' + form;
    }
    const day = Math.floor(hr / 24);
    if (day < 30) {
      const form = plural(day, t('time.day.one'), t('time.day.few'), t('time.day.many'));
      return day + ' ' + form;
    }
    return fmtDate(ts, lang);
  }

  /**
   * Сокращённый публичный ключ: первые 8 символов + многоточие.
   * @param {string} pk - Публичный ключ в hex.
   * @returns {string}
   */
  const shortPk = pk => (pk ? pk.slice(0, 8) + '…' : '');

  /**
   * Уникальный идентификатор: префикс + время в base36 + случайность.
   * @param {string} [prefix] - Префикс ('n' для заметок).
   * @returns {string}
   */
  function uid(prefix) {
    return (prefix || 'n') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Debounce с методом отмены.
   * @param {Function} fn - Функция.
   * @param {number} ms - Задержка в мс.
   * @returns {Function & {cancel: Function}} Отложенная функция.
   */
  function debounce(fn, ms) {
    let timer = null;
    function debounced(...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, ms);
    }
    debounced.cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return debounced;
  }

  return { esc, escRe, plural, word, fmtDate, fmtTime, fmtRelativeTime, shortPk, uid, debounce };
});
// ─── CORE/Utils ─── END ─────────────────────────────────────────────────────

// ─── CORE/I18n ─── START ────────────────────────────────────────────────────
/**
 * Интернационализация (ru/en).
 * Словари хранятся в одном месте. Все тексты интерфейса берутся только отсюда.
 *
 * Отличие от v0.6: новые ключи — net.offline (офлайн-бар), account.* и
 * sync.* (экран аккаунта, ключ, экспорт/импорт), preview.* (параметризованный
 * предпросмотр настроек ранжирования), onb.key.* (слайд онбординга про ключ
 * и устройства).
 */
DI.register('I18n', function (Config, bus) {
  /** @type {Object<string, Object<string, string>>} */
  const dicts = Object.create(null);
  /** @type {Array<Function>} */
  const listeners = [];
  let current = 'ru';

  const saved = Config.get('lang', null);
  if (saved === 'ru' || saved === 'en') {
    current = saved;
  } else {
    current = (navigator.language || 'ru').toLowerCase().indexOf('ru') === 0 ? 'ru' : 'en';
  }

  /**
   * Подстановка параметров: 'Максимум {max} символов' + {max: 2500}.
   * @param {string} str - Шаблон.
   * @param {Object} [params] - Параметры.
   * @returns {string}
   */
  function format(str, params) {
    const s = String(str == null ? '' : str);
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  }

  /**
   * Перевод ключа: текущий язык → en → fallback → сам ключ.
   * @param {string} key - Ключ перевода.
   * @param {Object} [params] - Параметры подстановки.
   * @param {string} [fallback] - Значение, если ключ не найден нигде.
   * @returns {string}
   */
  function t(key, params, fallback) {
    const d = dicts[current] || {};
    let val = Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    if (val === undefined) {
      const en = dicts['en'] || {};
      val = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : undefined;
    }
    return format(val !== undefined ? val : (fallback !== undefined ? fallback : key), params);
  }

  /**
   * Зарегистрировать словарь (merges поверх существующего).
   * @param {string} lang - Код языка.
   * @param {Object} dict - Словарь ключ → строка.
   */
  function addDict(lang, dict) {
    dicts[lang] = Object.assign(dicts[lang] || {}, dict || {});
  }

  /** Применить переводы ко всем [data-i18n] элементам в DOM. */
  function applyToDOM() {
    try {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        const key = el.getAttribute('data-i18n-ph');
        if (key) el.setAttribute('placeholder', t(key));
      });
      document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria');
        if (key) el.setAttribute('aria-label', t(key));
      });
    } catch (_) {}
  }

  /**
   * Сменить язык. Сохраняет выбор, применяет к DOM, оповещает слушателей
   * и шину ('i18n:change').
   * @param {string} lang - 'ru' | 'en'.
   */
  function setLang(lang) {
    if (lang !== 'ru' && lang !== 'en') return;
    current = lang;
    Config.set('lang', current);
    applyToDOM();
    for (const fn of listeners.slice()) {
      try {
        fn(current);
      } catch (_) {}
    }
    try {
      bus.emit('i18n:change', { lang: current });
    } catch (_) {}
  }

  const getLang = () => current;

  /**
   * Подписаться на смену языка.
   * @param {Function} fn - Колбэк (lang) => {}.
   */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  // Русский словарь
  addDict('ru', {
    'st.net': 'сеть',
    'st.ai.loading': 'модель',
    'st.ai.ready': 'ии',
    'st.ai.demo': 'ии/хеш',
    'st.net.online': 'онлайн',
    'st.net.connecting': 'соединение',
    'st.net.reconnecting': 'пересоединение',
    'st.net.failed': 'нет сети',
    'net.offline': 'офлайн — заметки сохраняются локально',

    'progress.title': 'Загружаем модель',

    'ed.placeholder': 'О чём думаешь?',
    'ed.chars': 'симв.',
    'ed.limit.soft': 'Для точного поиска пиши короче',
    'ed.limit.hard': 'Вектор обрезается, качество поиска низкое',
    'ed.limit.max': 'Максимум {max} символов',

    'btn.private': 'Личное',
    'btn.public': 'Мир',
    'btn.save': 'Сохранить',
    'btn.send.aria': 'Отправить',
    'btn.menu.aria': 'Меню',
    'btn.base.aria': 'Моя база',
    'btn.ctx.clear.aria': 'Снять контекст',
    'btn.show': 'Показать',
    'btn.hide': 'Скрыть',
    'btn.copy': 'Копировать',
    'btn.download': 'Скачать',
    'btn.import': 'Импорт',
    'btn.confirm': 'Подтвердить',

    'tab.stream': 'Поток',
    'tab.base': 'База',

    'seg.local': 'Моё',
    'seg.world': 'Мир',
    'seg.seren': 'Озарения',

    'ctx.pinned': 'пин',
    'ctx.drift': 'дрейф от',

    'sim.score': 'похожа на',
    'sim.level.high': 'В тему',
    'sim.level.mid': 'Озарение',
    'sim.level.low': 'Проблеск',

    'inf.resonance': 'резонанс',
    'inf.linked': 'по мотивам',
    'inf.openparent': 'Открыть заметку-источник',
    'inf.children': 'Потомки',
    'inf.nochildren': 'Потомков пока нет',
    'inf.lineage': 'Линейка «по мотивам»',
    'inf.noancestors': 'Это корень — предков нет',
    'inf.orphan.hint': 'Родитель этой заметки был удалён',

    'empty.local.t': 'Пока нет мыслей',
    'empty.world.t': 'Никто не думает так же',
    'empty.seren.t': 'Озарений нет',
    'empty.base.t': 'База пуста',
    'empty.base.empty': 'Ничего не найдено',

    'base.search': 'поиск...',
    'base.sort.new': 'новые',
    'base.sort.old': 'старые',
    'base.sort.az': 'а-я',
    'base.stat.total': 'всего',
    'base.stat.open': 'открыто',
    'base.stat.priv': 'лично',
    'base.tag.private': 'лично',
    'base.tag.shared': 'открыто',
    'base.wipe': 'Стереть базу',
    'base.wipe.confirm': 'Удалить все ваши заметки навсегда?',

    'btn.open': 'Открыть',
    'btn.edit': 'Развить',
    'btn.del': 'Удалить',
    'btn.pin': 'Пин',
    'btn.pin.aria': 'Закрепить для поиска',
    'btn.cancel': 'Отмена',
    'btn.close': 'Закрыть',
    'btn.toggle.priv': 'Скрыть',
    'btn.toggle.pub': 'Открыть',

    'toast.pinned': 'закреплено',
    'toast.saved.private': 'сохранено лично',
    'toast.saved.public': 'опубликовано',
    'toast.copied': 'скопировано',
    'toast.deleted': 'удалено',
    'toast.copy.fail': 'не удалось',
    'toast.empty': 'напиши что-нибудь',
    'toast.base.wiped': 'база очищена',
    'toast.edit.saved': 'сохранено',

    'menu.settings': 'Настройки',
    'menu.theme': 'Тема',
    'menu.lang': 'Язык',
    'menu.help': 'Как это работает',
    'menu.fullreset': 'Полный сброс',
    'menu.fullreset.confirm': 'Удалить ВСЕ данные из браузера (заметки, кэш, модель) и перезагрузить? Это как первый запуск.',
    'menu.fullreset.done': 'перезагрузка через 1.5 сек...',
    'menu.ranking': 'Настройки поиска',
    'menu.account': 'Аккаунт и ключ',

    'ranking.threshold': 'Порог релевантности',
    'ranking.threshold.hint': 'Минимальное сходство для показа в ленте (5%–95%)',
    'ranking.serendipity': 'Диапазон озарений',
    'ranking.serendipity.hint': 'Насколько широкие связи показывать как озарения (5%–30%)',
    'ranking.similarity': 'Порог одинаковости',
    'ranking.similarity.hint': 'Сходство, выше которого заметки считаются одинаковыми (88%–99%)',
    'ranking.reset': 'Сбросить настройки',
    'ranking.saved': 'Настройки сохранены',
    'ranking.display': 'Отображение сходства',
    'ranking.display.signal': 'Индикатор сигнала',
    'ranking.display.percent': 'Проценты (отладка)',

    // Параметризованный предпросмотр границ ранжирования (замена хардкода)
    'preview.ranking': 'Релевантно: ≥ {relevant}% | Озарения: {serenLo}%–{serenHi}% | Скрыто: < {hidden}%',

    'del.confirm': 'Удалить эту заметку навсегда?',

    'net.loadmore': 'Загрузить ещё',
    'net.loading': 'Загружаю…',

    'note.public.noedit': 'Публичные заметки нельзя редактировать',
    'note.edit.placeholder': 'Текст заметки',

    // Аккаунт, ключ, синхронизация
    'account.title': 'Аккаунт и ключ',
    'account.identity': 'Ваш ключ',
    'account.identity.desc': 'Ключ — это вы. Заметки синхронизируются между устройствами через зашифрованные события на вашем релее. Контент видите только вы.',
    'account.npub': 'Публичный адрес',
    'account.nsec.masked': 'Ключ скрыт',
    'account.nsec.hint': 'Никому не показывайте ключ. Если кто-то его получит — он станет вами.',
    'account.exported.mark': 'Ключ показан и скопирован',
    'account.password.set': 'Защитить ключ паролем',
    'account.password.hint': 'Пароль шифрует ключ при показе. Без пароля — быстрый доступ.',
    'account.enter.title': 'Вход по ключу',
    'account.enter.desc': 'Вставьте ключ (nsec… или ncryptsec…) с другого устройства. Текущие заметки и ключ будут заменены.',
    'account.enter.placeholder': 'nsec… или ncryptsec…',
    'account.enter.confirm': 'Заменить аккаунт?',
    'account.enter.confirm.d': 'Текущий ключ и локальные заметки будут удалены. Продолжить?',
    'account.enter.bad': 'Ключ не распознан',
    'account.enter.done': 'Аккаунт заменён, синхронизирую…',
    'account.import.done': 'Импортировано заметок: {count}',
    'account.export.file': 'Архив заметок',
    'account.export.desc': 'Файл с заметками и настройками. Страховка на случай, если релеи очистят данные.',
    'account.import.file': 'Восстановить из файла',
    'account.import.confirm': 'Заменить локальную базу данными из архива?',
    'account.import.confirm.d': 'Заметки из архива будут добавлены (совпадающие по id — обновлены).',
    'account.import.bad': 'Файл не похож на архив NOOmium',
    'account.sync.status': 'Синхронизация',
    'account.sync.on': 'включена',
    'account.sync.off': 'выключена',
    'account.sync.running': 'идёт обмен…',
    'account.sync.hint': 'Зашифрованные копии заметок публикуются на релеи. Отключите, если не хотите ничего отправлять в сеть.',

    'toast.key.copied': 'ключ скопирован',
    'toast.key.saved': 'ключ сохранён',
    'toast.account.migrated': 'заметки переносятся в облако…',
    'toast.sync.disabled': 'синхронизация выключена',
    'toast.sync.enabled': 'синхронизация включена',

    'onb.title': 'Как это работает',
    'onb.dontshow': 'Больше не показывать',
    'onb.gotit': 'Понятно',
    'onb.what.t': 'NOOmium',
    'onb.what.d': 'Соцсеть смыслов: мысли ищутся не по словам и не по лайкам, а по значению. Каждая мысль превращается в вектор — точку в пространстве смыслов.',
    'onb.stream.t': 'Лента',
    'onb.stream.d': 'Показывает свежие мысли — твои и из сети. Просто читай.',
    'onb.pin.t': 'Пин',
    'onb.pin.d': 'Кликни по мысли — она станет контекстом: лента покажет созвучное из твоей базы и из сети. Закреплённая мысль становится «мамой» для всего, что ты напишешь следом.',
    'onb.drift.t': 'Дрейф',
    'onb.drift.d': 'Начни печатать при пине — контекст плавно перейдёт к твоему тексту. Так можно органично уйти от исходной мысли к своей.',
    'onb.modes.t': 'Личное и Мир',
    'onb.modes.d': 'Личное остаётся только у тебя. Мир — делится мыслью с сетью, и другие смогут найти её по смыслу.',
    'onb.resonance.t': 'Резонанс ◆',
    'onb.resonance.d': 'Сколько чужих мыслей родила твоя. «↳ по мотивам» ведёт к заметке-источнику, клик по ◆ показывает потомков.',
    'onb.key.t': 'Ключ и устройства',
    'onb.key.d': 'Твой ключ — это твой аккаунт. Сохрани его в «Настройки → Аккаунт»: с ним любая мысль вернётся на новое устройство автоматически.',
    'onb.delete.t': 'Удаление',
    'onb.delete.d': 'Удаление в Nostr — это просьба к релеям удалить заметку. Большинство рэлеев её выполнят, но те, кто уже увидел заметку, могут её сохранить. Полное удаление возможно только на своём релее.',

    'time.now': 'только что',
    'time.min.one': 'минуту назад',
    'time.min.few': 'минуты назад',
    'time.min.many': 'минут назад',
    'time.hr.one': 'час назад',
    'time.hr.few': 'часа назад',
    'time.hr.many': 'часов назад',
    'time.day.one': 'день назад',
    'time.day.few': 'дня назад',
    'time.day.many': 'дней назад',
  });

  // Английский словарь
  addDict('en', {
    'st.net': 'net',
    'st.ai.loading': 'model',
    'st.ai.ready': 'ai',
    'st.ai.demo': 'ai/hash',
    'st.net.online': 'online',
    'st.net.connecting': 'connecting',
    'st.net.reconnecting': 'reconnecting',
    'st.net.failed': 'offline',
    'net.offline': 'offline — notes are saved locally',

    'progress.title': 'Loading model',

    'ed.placeholder': 'What are you thinking?',
    'ed.chars': 'chars',
    'ed.limit.soft': 'Shorter text = more precise search',
    'ed.limit.hard': 'Vector will be truncated, search quality drops',
    'ed.limit.max': 'Maximum {max} characters',

    'btn.private': 'Private',
    'btn.public': 'World',
    'btn.save': 'Save',
    'btn.send.aria': 'Send',
    'btn.menu.aria': 'Menu',
    'btn.base.aria': 'My base',
    'btn.ctx.clear.aria': 'Clear context',
    'btn.show': 'Show',
    'btn.hide': 'Hide',
    'btn.copy': 'Copy',
    'btn.download': 'Download',
    'btn.import': 'Import',
    'btn.confirm': 'Confirm',

    'tab.stream': 'Stream',
    'tab.base': 'Base',

    'seg.local': 'Mine',
    'seg.world': 'World',
    'seg.seren': 'Insights',

    'ctx.pinned': 'pinned',
    'ctx.drift': 'drift from',

    'sim.score': 'similarity',
    'sim.level.high': 'On topic',
    'sim.level.mid': 'Insight',
    'sim.level.low': 'Glimmer',

    'inf.resonance': 'resonance',
    'inf.linked': 'inspired by',
    'inf.openparent': 'Open source note',
    'inf.children': 'Descendants',
    'inf.nochildren': 'No descendants yet',
    'inf.lineage': '"Inspired by" lineage',
    'inf.noancestors': 'This is the root — no ancestors',
    'inf.orphan.hint': 'The parent of this note was deleted',

    'empty.local.t': 'No thoughts yet',
    'empty.world.t': 'Nobody thinks alike',
    'empty.seren.t': 'No insights',
    'empty.base.t': 'Base is empty',
    'empty.base.empty': 'Nothing found',

    'base.search': 'search...',
    'base.sort.new': 'newest',
    'base.sort.old': 'oldest',
    'base.sort.az': 'a-z',
    'base.stat.total': 'total',
    'base.stat.open': 'open',
    'base.stat.priv': 'private',
    'base.tag.private': 'private',
    'base.tag.shared': 'open',
    'base.wipe': 'Wipe base',
    'base.wipe.confirm': 'Delete all your notes forever?',

    'btn.open': 'Open',
    'btn.edit': 'Develop',
    'btn.del': 'Delete',
    'btn.pin': 'Pin',
    'btn.pin.aria': 'Pin for search',
    'btn.cancel': 'Cancel',
    'btn.close': 'Close',
    'btn.toggle.priv': 'Hide',
    'btn.toggle.pub': 'Share',

    'toast.pinned': 'pinned',
    'toast.saved.private': 'saved privately',
    'toast.saved.public': 'shared',
    'toast.copied': 'copied',
    'toast.deleted': 'deleted',
    'toast.copy.fail': 'copy failed',
    'toast.empty': 'write something',
    'toast.base.wiped': 'base wiped',
    'toast.edit.saved': 'saved',

    'menu.settings': 'Settings',
    'menu.theme': 'Theme',
    'menu.lang': 'Language',
    'menu.help': 'How it works',
    'menu.fullreset': 'Full reset',
    'menu.fullreset.confirm': 'Delete ALL data from browser (notes, cache, model) and reload? This is like first launch.',
    'menu.fullreset.done': 'reloading in 1.5 sec...',
    'menu.ranking': 'Search settings',
    'menu.account': 'Account & key',

    'ranking.threshold': 'Relevance threshold',
    'ranking.threshold.hint': 'Minimum similarity to show in feed (5%–95%)',
    'ranking.serendipity': 'Serendipity range',
    'ranking.serendipity.hint': 'How broad connections to show as insights (5%–30%)',
    'ranking.similarity': 'Duplicate threshold',
    'ranking.similarity.hint': 'Similarity above which notes are considered identical (88%–99%)',
    'ranking.reset': 'Reset settings',
    'ranking.saved': 'Settings saved',
    'ranking.display': 'Similarity display',
    'ranking.display.signal': 'Signal indicator',
    'ranking.display.percent': 'Percentages (debug)',

    'preview.ranking': 'Relevant: ≥ {relevant}% | Insights: {serenLo}%–{serenHi}% | Hidden: < {hidden}%',

    'del.confirm': 'Delete this note forever?',

    'net.loadmore': 'Load more',
    'net.loading': 'Loading…',

    'note.public.noedit': 'Public notes cannot be edited',
    'note.edit.placeholder': 'Note text',

    'account.title': 'Account & key',
    'account.identity': 'Your key',
    'account.identity.desc': 'The key is you. Notes sync between your devices via encrypted events on your relay. Only you can read the content.',
    'account.npub': 'Public address',
    'account.nsec.masked': 'Key hidden',
    'account.nsec.hint': 'Never show your key to anyone. Whoever gets it becomes you.',
    'account.exported.mark': 'Key shown and copied',
    'account.password.set': 'Protect key with password',
    'account.password.hint': 'Password encrypts the key when displayed. Without it — quick access.',
    'account.enter.title': 'Sign in with key',
    'account.enter.desc': 'Paste a key (nsec… or ncryptsec…) from another device. Current notes and key will be replaced.',
    'account.enter.placeholder': 'nsec… or ncryptsec…',
    'account.enter.confirm': 'Replace account?',
    'account.enter.confirm.d': 'Current key and local notes will be deleted. Continue?',
    'account.enter.bad': 'Key not recognized',
    'account.enter.done': 'Account replaced, syncing…',
    'account.import.done': 'Notes imported: {count}',
    'account.export.file': 'Notes archive',
    'account.export.desc': 'A file with your notes and settings. A safety net in case relays wipe their data.',
    'account.import.file': 'Restore from file',
    'account.import.confirm': 'Replace local base with archive data?',
    'account.import.confirm.d': 'Notes from the archive will be added (matching ids updated).',
    'account.import.bad': 'File does not look like a NOOmium archive',
    'account.sync.status': 'Sync',
    'account.sync.on': 'on',
    'account.sync.off': 'off',
    'account.sync.running': 'exchanging…',
    'account.sync.hint': 'Encrypted copies of notes are published to relays. Turn off if you do not want anything sent to the network.',

    'toast.key.copied': 'key copied',
    'toast.key.saved': 'key saved',
    'toast.account.migrated': 'moving notes to the cloud…',
    'toast.sync.disabled': 'sync disabled',
    'toast.sync.enabled': 'sync enabled',

    'onb.title': 'How it works',
    'onb.dontshow': "Don't show again",
    'onb.gotit': 'Got it',
    'onb.what.t': 'NOOmium',
    'onb.what.d': 'A social network of meaning: thoughts are found not by words or likes, but by sense. Each thought becomes a vector — a point in meaning-space.',
    'onb.stream.t': 'Feed',
    'onb.stream.d': 'Shows fresh thoughts — yours and from the network. Just read.',
    'onb.pin.t': 'Pin',
    'onb.pin.d': 'Click a thought to make it the context: the feed shows what resonates, from your base and the network. The pinned thought becomes the "mother" of what you write next.',
    'onb.drift.t': 'Drift',
    'onb.drift.d': 'Start typing while pinned — the context shifts toward your text. A natural way to drift from the original thought to your own.',
    'onb.modes.t': 'Private & World',
    'onb.modes.d': 'Private stays with you. World shares the thought with the network so others can find it by meaning.',
    'onb.resonance.t': 'Resonance ◆',
    'onb.resonance.d': 'How many thoughts yours inspired. "↳ inspired by" leads to the source note; click ◆ to see descendants.',
    'onb.key.t': 'Key & devices',
    'onb.key.d': 'Your key is your account. Save it in "Settings → Account": with it, every thought returns to a new device automatically.',
    'onb.delete.t': 'Deletion',
    'onb.delete.d': 'Deletion in Nostr is a request to relays to delete a note. Most relays will honor it, but those who already saw the note may keep it. Full deletion is only possible on your own relay.',

    'time.now': 'just now',
    'time.min.one': 'min ago',
    'time.min.few': 'min ago',
    'time.min.many': 'min ago',
    'time.hr.one': 'hr ago',
    'time.hr.few': 'hrs ago',
    'time.hr.many': 'hrs ago',
    'time.day.one': 'day ago',
    'time.day.few': 'days ago',
    'time.day.many': 'days ago',
  });

  /** Применить переводы к текущему DOM. Вызывается из BOOT. */
  function init() {
    applyToDOM();
  }

  return { t, addDict, setLang, getLang, onChange, applyToDOM, init };
}, ['Config', 'EventBus']);
// ─── CORE/I18n ─── END ──────────────────────────────────────────────────────

// ─── CORE/Store ─── START ───────────────────────────────────────────────────
/**
 * Минимальный синхронный стор приложения.
 * Не содержит бизнес-логики — только состояние и подписки.
 */
DI.register('Store', function () {
  /**
   * Состояние приложения.
   * @type {Object}
   * @property {string} state.view - Активный экран: 'stream' | 'base'.
   * @property {string} state.seg - Активный сегмент ленты: 'local' | 'world' | 'seren'.
   * @property {Object} state.context - Контекст поиска.
   * @property {string|null} state.context.source - 'pin' | 'drift' | 'input' | null.
   * @property {string|null} state.context.noteId - uid закреплённой заметки.
   * @property {string} state.context.text - Текст контекста.
   * @property {Array<number>|Float32Array|null} state.context.vector - Вектор контекста.
   * @property {string|null} state.context.pinText - Текст пина при дрейфе.
   * @property {string} state.sendMode - Режим отправки: 'private' | 'world'.
   * @property {Object} state.lists - Ранжированные списки при контексте.
   * @property {Array} state.feed - Хронологический поток без контекста.
   */
  const state = {
    view: 'stream',
    seg: 'local',
    context: { source: null, noteId: null, text: '', vector: null, pinText: null },
    sendMode: 'private',
    lists: { local: [], world: [], seren: [] },
    feed: [],
  };

  /** @type {Array<Function>} */
  const listeners = [];

  /**
   * Поверхностное сравнение объектов (для selector-подписок).
   * @param {*} a
   * @param {*} b
   * @returns {boolean}
   */
  function shallowEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.is(a[k], b[k])) return false;
    }
    return true;
  }

  /** @returns {Object} Замороженный снапшот состояния. */
  const snapshot = () => Object.freeze(Object.assign({}, state));

  /** Оповестить всех слушателей снапшотом. */
  function notify() {
    const snap = snapshot();
    for (const l of listeners.slice()) {
      try {
        l(snap);
      } catch (e) {
        console.error('[store]', e);
      }
    }
  }

  /** @returns {Object} Замороженный снапшот состояния. */
  const getState = () => snapshot();

  /**
   * Получить значение поля состояния напрямую (без снапшота).
   * @param {string} k - Ключ.
   * @returns {*}
   */
  const get = k => state[k];

  /**
   * Частичное обновление состояния + уведомление подписчиков.
   * @param {Object} partial - Патч состояния.
   */
  function setState(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return;
    Object.assign(state, partial);
    notify();
  }

  /**
   * Подписка на изменения.
   * Варианты:
   *   subscribe(listener) — на любое изменение;
   *   subscribe(selector, listener, equals?) — только когда результат
   *   селектора изменился (по умолчанию Object.is, для объектов —
   *   передавайте Store.shallowEqual).
   * @param {Function} a - Слушатель или селектор.
   * @param {Function} [b] - Слушатель (при selector-варианте).
   * @param {Function} [equals] - Функция равенства.
   * @returns {Function} Функция отписки.
   */
  function subscribe(a, b, equals) {
    if (typeof b === 'function') {
      const selector = a, listener = b, eq = equals || Object.is;
      let prev = selector(snapshot());
      const wrap = s => {
        const next = selector(s);
        if (!eq(next, prev)) {
          prev = next;
          listener(next, s);
        }
      };
      listeners.push(wrap);
      return () => {
        const i = listeners.indexOf(wrap);
        if (i > -1) listeners.splice(i, 1);
      };
    }

    listeners.push(a);
    return () => {
      const i = listeners.indexOf(a);
      if (i > -1) listeners.splice(i, 1);
    };
  }

  return { getState, get, setState, subscribe, shallowEqual };
});
// ─── CORE/Store ─── END ─────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: DATA — векторная математика, хранилище
// ═══════════════════════════════════════════════════════════════════════════════

// ─── DATA/Vec ─── START ─────────────────────────────────────────────────────
/**
 * Векторные операции: нормализация, cosine similarity, сжатие в base64, k-means.
 * Все векторы ожидаются нормализованными (единичная длина).
 */
DI.register('Vec', function () {
  /**
   * Приведение к Float32Array.
   * @param {Float32Array|Array<number>} v - Входной вектор.
   * @returns {Float32Array}
   */
  const f32 = v => (v instanceof Float32Array ? v : Float32Array.from(v || []));

  /**
   * Сериализация вектора в compact base64 (Int16 квантование).
   * Используется для передачи векторов в Nostr-событиях.
   * @param {Float32Array|Array<number>} vec - Нормализованный вектор.
   * @returns {string} Base64-строка.
   */
  function toB64(vec) {
    const f = f32(vec);
    const i16 = new Int16Array(f.length);

    for (let i = 0; i < f.length; i++) {
      let x = f[i];
      if (x > 1) x = 1;
      else if (x < -1) x = -1;
      i16[i] = Math.round(x * 32767);
    }

    const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }

    return btoa(bin);
  }

  /**
   * Десериализация вектора из base64 + повторная нормализация.
   * @param {string} b64 - Base64-строка.
   * @returns {Float32Array|null} Нормализованный вектор или null при ошибке.
   */
  function fromB64(b64) {
    try {
      const bin = atob(String(b64 || ''));
      if (!bin || bin.length < 2 || bin.length % 2 !== 0) return null;

      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }

      const i16 = new Int16Array(bytes.buffer);
      const out = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) {
        out[i] = i16[i] / 32767;
      }

      return normalize(out);
    } catch (_) {
      return null;
    }
  }

  /**
   * Косинусное сходство для нормализованных векторов (скалярное произведение).
   * Если векторы разной длины, сравниваем по минимальной длине.
   * @param {Float32Array|Array<number>} a - Первый вектор.
   * @param {Float32Array|Array<number>} b - Второй вектор.
   * @returns {number} Сходство в диапазоне [-1, 1].
   */
  function cosine(a, b) {
    if (!a || !b) return 0;
    const n = Math.min(a.length, b.length);
    if (!n) return 0;

    let s = 0;
    for (let i = 0; i < n; i++) {
      s += a[i] * b[i];
    }

    return s;
  }

  /**
   * Нормализация вектора к единичной длине.
   * @param {Float32Array|Array<number>} v - Входной вектор.
   * @returns {Float32Array} Нормализованный вектор (нулевой при нулевой норме).
   */
  function normalize(v) {
    const f = f32(v);
    let norm = 0;

    for (let i = 0; i < f.length; i++) {
      norm += f[i] * f[i];
    }

    norm = Math.sqrt(norm);
    const out = new Float32Array(f.length);
    if (!norm) return out;

    for (let i = 0; i < f.length; i++) {
      out[i] = f[i] / norm;
    }

    return out;
  }

  /**
   * Квадрат евклидова расстояния (внутренняя для k-means).
   * @param {Float32Array|Array<number>} a
   * @param {Float32Array|Array<number>} b
   * @returns {number}
   */
  function sqDist(a, b) {
    const n = Math.min(a.length, b.length);
    let s = 0;

    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }

    return s;
  }

  /**
   * Упрощённый k-means с инициализацией k-means++.
   * Используется для центроидов префильтра входящих запросов.
   * @param {Array<Float32Array|Array<number>>} vectors - Набор векторов.
   * @param {number} k - Число кластеров.
   * @param {number} [iterations] - Число итераций (по умолчанию 10).
   * @returns {Array<Float32Array>} Центроиды.
   */
  function kmeans(vectors, k, iterations) {
    const iters = iterations || 10;
    const n = vectors.length;

    if (!n || !k) return [];
    if (n <= k) return vectors.map(v => f32(v));

    const dim = vectors[0].length;

    const cents = [f32(vectors[0])];
    while (cents.length < k) {
      let bestI = 0, bestD = -1;

      for (let i = 0; i < n; i++) {
        let minD = Infinity;

        for (const c of cents) {
          const d = sqDist(vectors[i], c);
          if (d < minD) minD = d;
        }

        if (minD > bestD) {
          bestD = minD;
          bestI = i;
        }
      }

      cents.push(f32(vectors[bestI]));
    }

    for (let it = 0; it < iters; it++) {
      const sums = Array.from({ length: k }, () => new Float32Array(dim));
      const counts = new Array(k).fill(0);

      for (let i = 0; i < n; i++) {
        let best = 0, bestD = Infinity;

        for (let c = 0; c < k; c++) {
          const d = sqDist(vectors[i], cents[c]);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }

        counts[best]++;
        for (let d = 0; d < dim; d++) {
          sums[best][d] += vectors[i][d];
        }
      }

      for (let c = 0; c < k; c++) {
        if (counts[c]) {
          for (let d = 0; d < dim; d++) {
            cents[c][d] = sums[c][d] / counts[c];
          }
        }
      }
    }

    return cents;
  }

  return { toB64, fromB64, cosine, normalize, kmeans };
});
// ─── DATA/Vec ─── END ───────────────────────────────────────────────────────

// ─── DATA/DB ─── START ──────────────────────────────────────────────────────
/**
 * Слой хранения: IndexedDB с fallback в память.
 * Два хранилища:
 * - notes: локальные заметки пользователя
 * - cache: сетевые заметки/ответы
 *
 * Отличие от v0.6: ин-мемори индексы идентификаторов.
 * Строятся один раз при открытии БД, поддерживаются инкрементально
 * на каждой операции. Методы hasLocal()/hasCache() дают O(1)-проверку
 * «есть ли заметка локально» — вместо полного скана DB.all() на каждое
 * входящее сетевое событие (фикс #10).
 *
 * КОНТРАКТ: сетевые обработчики (NetService) должны дождаться
 * DB.ready() перед началом приёма событий — иначе индексы могут
 * быть ещё не построены.
 */
DI.register('DB', function (Config, bus, Logger) {
  let db = null;
  let mem = null;
  let memCache = null;
  let openPromise = null;

  const NOTES = () => Config.get('storeName', 'notes');
  const CACHE = () => Config.get('cacheStoreName', 'cache');

  // ─── Ин-мемори индексы ─────────────────────────────────────────────────────

  /** @type {Set<string>} id всех локальных заметок. */
  const localIds = new Set();
  /** @type {Set<string>} eventId всех опубликованных локальных заметок. */
  const localEventIds = new Set();
  /** @type {Set<string>} id всех заметок в сетевом кэше. */
  const cacheIds = new Set();

  function emitChange() {
    try { bus.emit('db:change'); } catch (_) {}
  }

  function emitCache() {
    try { bus.emit('db:cache'); } catch (_) {}
  }

  /**
   * Обёртка IDBRequest → Promise.
   * @param {IDBRequest} req - Запрос.
   * @returns {Promise<*>}
   */
  function reqPromise(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  /**
   * Открытие БД. При успешном открытии ДО резолва строит индексы
   * (один полный проход по notes + чтение ключей cache).
   * При недоступности IndexedDB — fallback в память (индексы
   * поддерживаются инкрементально с пустого состояния).
   * @returns {Promise<IDBDatabase|null>}
   */
  function open() {
    if (openPromise) return openPromise;

    openPromise = new Promise(resolve => {
      if (!window.indexedDB) {
        mem = new Map();
        memCache = new Map();
        Logger.warn('DB: IndexedDB недоступен, in-memory fallback');
        return resolve(null);
      }

      try {
        const req = indexedDB.open(Config.get('dbName', 'noomium_v2'), 1);

        req.onupgradeneeded = e => {
          const d = e.target.result;

          if (!d.objectStoreNames.contains(NOTES())) {
            d.createObjectStore(NOTES(), { keyPath: 'id' });
          }

          if (!d.objectStoreNames.contains(CACHE())) {
            d.createObjectStore(CACHE(), { keyPath: 'id' });
          }
        };

        req.onsuccess = e => {
          db = e.target.result;
          buildIndexes().then(() => resolve(db)).catch(() => resolve(db));
        };

        req.onerror = () => {
          mem = new Map();
          memCache = new Map();
          Logger.warn('DB: ошибка открытия, fallback');
          resolve(null);
        };

        req.onblocked = () => {
          mem = new Map();
          memCache = new Map();
          Logger.warn('DB: open blocked, fallback');
          resolve(null);
        };
      } catch (err) {
        mem = new Map();
        memCache = new Map();
        Logger.warn('DB: не поддерживается, fallback', String(err));
        resolve(null);
      }
    });

    return openPromise;
  }

  /**
   * Полная перестройка индексов из БД (однократно при открытии).
   * @returns {Promise<void>}
   */
  function buildIndexes() {
    const t = db.transaction([NOTES(), CACHE()], 'readonly');

    return Promise.all([
      reqPromise(t.objectStore(NOTES()).getAll()).catch(() => []),
      reqPromise(t.objectStore(CACHE()).getAllKeys()).catch(() => []),
    ]).then(([notes, keys]) => {
      localIds.clear();
      localEventIds.clear();
      cacheIds.clear();

      (notes || []).forEach(n => {
        if (n && n.id) {
          localIds.add(n.id);
          if (n.eventId) localEventIds.add(n.eventId);
        }
      });

      (keys || []).forEach(k => cacheIds.add(k));

      Logger.info('DB: индексы построены (' + localIds.size + ' локальных, ' + cacheIds.size + ' в кэше)');
    });
  }

  /**
   * Универсальная обёртка транзакции с memory-fallback.
   * @param {string} store - Имя object store.
   * @param {string} mode - 'readonly' | 'readwrite'.
   * @param {Function} fn - (objectStore) => IDBRequest.
   * @param {Function} memFn - Синхронный fallback в памяти.
   * @returns {Promise<*>}
   */
  function withStore(store, mode, fn, memFn) {
    return open().then(d => {
      if (!d) return memFn();

      return new Promise((res, rej) => {
        try {
          const r = fn(d.transaction(store, mode).objectStore(store));
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        } catch (e) {
          rej(e);
        }
      });
    });
  }

  // ─── Локальные заметки ─────────────────────────────────────────────────────

  /**
   * Сохранить/обновить заметку.
   * @param {Object} note - Заметка с полем id.
   * @returns {Promise<string>} id заметки.
   */
  function put(note) {
    return withStore(
      NOTES(),
      'readwrite',
      s => s.put(note),
      () => { mem.set(note.id, note); return note.id; }
    ).then(res => {
      if (note && note.id) {
        localIds.add(note.id);
        if (note.eventId) localEventIds.add(note.eventId);
      }
      emitChange();
      return res;
    });
  }

  /**
   * Получить заметку по id.
   * @param {string} id
   * @returns {Promise<Object|undefined>}
   */
  function get(id) {
    return withStore(
      NOTES(),
      'readonly',
      s => s.get(id),
      () => mem.get(id)
    );
  }

  /**
   * Удалить заметку. Перед удалением читает заметку, чтобы вычистить
   * из индекса и её eventId.
   * @param {string} id
   * @returns {Promise<*>}
   */
  function del(id) {
    return get(id).then(note => {
      return withStore(
        NOTES(),
        'readwrite',
        s => s.delete(id),
        () => { mem.delete(id); }
      ).then(res => {
        localIds.delete(id);
        if (note && note.eventId) localEventIds.delete(note.eventId);
        emitChange();
        return res;
      });
    });
  }

  /**
   * Все локальные заметки.
   * @returns {Promise<Array<Object>>}
   */
  function all() {
    return withStore(
      NOTES(),
      'readonly',
      s => s.getAll(),
      () => Array.from(mem.values())
    );
  }

  /**
   * Полная очистка обоих хранилищ + индексов.
   * @returns {Promise<void>}
   */
  function reset() {
    return open().then(d => {
      if (!d) {
        mem.clear();
        memCache.clear();
        return;
      }

      return new Promise((res, rej) => {
        const t = d.transaction([NOTES(), CACHE()], 'readwrite');
        t.objectStore(NOTES()).clear();
        t.objectStore(CACHE()).clear();

        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    }).then(() => {
      localIds.clear();
      localEventIds.clear();
      cacheIds.clear();
      emitChange();
      emitCache();
    });
  }

  // ─── Сетевой кэш ───────────────────────────────────────────────────────────

  /**
   * Сохранить/обновить заметку в кэше.
   * @param {Object} note - Заметка с полем id.
   * @returns {Promise<string>}
   */
  function cachePut(note) {
    return withStore(
      CACHE(),
      'readwrite',
      s => s.put(note),
      () => { memCache.set(note.id, note); return note.id; }
    ).then(res => {
      if (note && note.id) cacheIds.add(note.id);
      emitCache();
      return res;
    });
  }

  /**
   * Получить заметку из кэша.
   * @param {string} id
   * @returns {Promise<Object|undefined>}
   */
  function cacheGet(id) {
    return withStore(
      CACHE(),
      'readonly',
      s => s.get(id),
      () => memCache.get(id)
    );
  }

  /**
   * Все заметки кэша.
   * @returns {Promise<Array<Object>>}
   */
  function cacheAll() {
    return withStore(
      CACHE(),
      'readonly',
      s => s.getAll(),
      () => Array.from(memCache.values())
    );
  }

  /**
   * Удалить заметку из кэша.
   * @param {string} id
   * @returns {Promise<*>}
   */
  function cacheDel(id) {
    return withStore(
      CACHE(),
      'readwrite',
      s => s.delete(id),
      () => { memCache.delete(id); }
    ).then(res => {
      cacheIds.delete(id);
      emitCache();
      return res;
    });
  }

  return {
    put,
    get,
    del,
    all,
    reset,
    cachePut,
    cacheGet,
    cacheAll,
    cacheDel,

    /**
     * Готовность БД (индексы построены). NetService обязан дождаться
     * этого перед открытием подписки на входящие события.
     * @returns {Promise<IDBDatabase|null>}
     */
    ready: open,

    /**
     * Есть ли заметка с таким id ИЛИ eventId среди ЛОКАЛЬНЫХ (O(1)).
     * Используется для отсечения дублей своих заметок, приходящих
     * из сети.
     * @param {string} idOrEventId - Локальный id или eventId.
     * @returns {boolean}
     */
    hasLocal(idOrEventId) {
      if (!idOrEventId) return false;
      return localIds.has(idOrEventId) || localEventIds.has(idOrEventId);
    },

    /**
     * Есть ли заметка с таким id в сетевом кэше (O(1)).
     * @param {string} id
     * @returns {boolean}
     */
    hasCache(id) {
      return !!id && cacheIds.has(id);
    },
  };
}, ['Config', 'EventBus', 'Logger']);
// ─── DATA/DB ─── END ────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: AI — эмбеддинг, ранжирование
// ═══════════════════════════════════════════════════════════════════════════════

// ─── AI/Embedder ─── START ──────────────────────────────────────────────────
/**
 * Embedder для Granite R2 (ModernBERT backbone).
 *
 * Архитектура модели (из документации IBM):
 * - granite-encoder-small-multilingual: 12 слоёв, 384-dim, SiLU, RoPE theta 160,000
 * - Пулинг: [CLS] (формула 3.2 в paper)
 * - Нормализация: да (косинусное сходство нормализованных векторов)
 *
 * Транспортировка:
 * - Модель грузится в Web Worker через transformers.js
 * - Fallback: FNV-1a хеш-эмбеддинг при недоступности Worker или ошибке загрузки
 *
 * Режимы:
 * - 'loading' — модель грузится
 * - 'model'   — модель готова
 * - 'demo'    — хеш-фолбэк (качество поиска нулевое, приложение не падает)
 */
DI.register('Embedder', function (Config, bus, Logger) {
  /**
   * Код Web Worker'а (строкой — для создания через Blob).
   * Грузит transformers.js с CDN, строит pipeline, отвечает на запросы embed.
   * @type {string}
   */
  const workerCode = `
let extractor = null;
let ready = false;
let files = new Map();

self.onmessage = async function (e) {
  const msg = e.data;
  
  if (msg.type === 'load') {
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@latest');
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;
      
      extractor = await mod.pipeline('feature-extraction', msg.model, {
        dtype: 'q8',
        progress_callback: function (p) {
          if (p.status === 'progress') {
            const fileName = p.file || p.name || 'unknown';
            files.set(fileName, { 
              loaded: p.loaded || 0, 
              total: p.total || 0,
              file: fileName
            });
            
            let totalLoaded = 0, totalSize = 0;
            files.forEach(f => { 
              totalLoaded += f.loaded; 
              if (f.total > 0) totalSize += f.total; 
            });
            
            const pct = totalSize > 0 ? (totalLoaded / totalSize) * 100 : 0;
            self.postMessage({ 
              type: 'progress', 
              pct,
              loadedMB: (totalLoaded / 1024 / 1024).toFixed(1),
              totalMB: totalSize > 0 ? (totalSize / 1024 / 1024).toFixed(1) : null,
              model: msg.model
            });
          }
        }
      });
      
      ready = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ 
        type: 'error', 
        id: null, 
        message: String(err && err.message || err) 
      });
    }
    return;
  }
  
  if (!ready) {
    self.postMessage({ 
      type: 'error', 
      id: msg.id, 
      message: 'model not loaded' 
    });
    return;
  }
  
  if (msg.type === 'embed') {
    try {
      // Granite R2: [CLS] pooling + нормализация (согласно документации)
      const out = await extractor(msg.text, { pooling: 'cls', normalize: true });
      self.postMessage({ 
        type: 'result', 
        id: msg.id, 
        vector: Array.from(out.data) 
      });
    } catch (err) {
      self.postMessage({ 
        type: 'error', 
        id: msg.id, 
        message: String(err && err.message || err) 
      });
    }
  }
};
`;

  /** @type {Worker|null} */
  let worker = null;
  /** @type {string|null} */
  let workerUrl = null;
  /** @type {'loading'|'model'|'demo'} */
  let mode = 'loading';
  let loadPromise = null;
  let nextId = 0;
  let lastPct = 0;
  /** @type {Map<number, {resolve: Function, timer: number, text: string}>} */
  const pending = new Map();
  /** @type {Array<Function>} */
  const progressFns = [];
  /** @type {Map<string, Float32Array>} */
  const cache = new Map();

  function emitStatus() {
    try {
      bus.emit('ai:status', { mode, percent: lastPct });
    } catch (_) {}
  }

  /**
   * Fallback: детерминированный хеш-эмбеддинг (FNV-1a).
   * Используется только если Worker/модель недоступны.
   * Качество поиска при этом нулевое, но приложение не падает.
   * @param {string} text - Текст.
   * @returns {Float32Array} Нормализованный вектор размерности dim.
   */
  function hashEmbed(text) {
    const DIM = Config.get('dim', 384);
    const vec = new Float32Array(DIM);
    const tokens = (text || '').toLowerCase().match(/[a-zа-яё0-9]+/gi) || [];

    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      vec[Math.abs(h) % DIM] += 1;

      const h2 = Math.imul(h ^ 0x9e3779b9, 2654435761);
      vec[Math.abs(h2) % DIM] += 0.5;
    }

    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;

    for (let i = 0; i < DIM; i++) vec[i] /= norm;
    return vec;
  }

  /**
   * LRU-чтение из кэша.
   * @param {string} key - Текст.
   * @returns {Float32Array|undefined}
   */
  function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  /**
   * LRU-запись в кэш с вытеснением старых записей.
   * @param {string} key - Текст.
   * @param {Float32Array} v - Вектор.
   */
  function cacheSet(key, v) {
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= Config.get('aiCacheLimit', 300)) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, v);
  }

  /**
   * Аварийная очистка: завершает все ожидающие embed-запросы
   * хеш-векторами, убивает Worker и revoke'ит Blob-URL.
   */
  function cleanup() {
    pending.forEach(p => {
      clearTimeout(p.timer);
      const v = hashEmbed(p.text);
      cacheSet(p.text, v);
      p.resolve(v);
    });
    pending.clear();

    if (worker) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }

    if (workerUrl) {
      try { URL.revokeObjectURL(workerUrl); } catch (_) {}
      workerUrl = null;
    }
  }

  /**
   * Загрузка модели: создаёт Worker, шлёт 'load', ждёт 'ready'.
   * Любой сбой (таймаут 120с, ошибка Worker, ошибка модели) → demo mode.
   * @returns {Promise<void>}
   */
  function doLoad() {
    return new Promise(resolve => {
      if (typeof Worker === 'undefined') {
        mode = 'demo';
        emitStatus();
        Logger.warn('Embedder: Worker не поддерживается, demo mode');
        return resolve();
      }

      try {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        workerUrl = URL.createObjectURL(blob);
        worker = new Worker(workerUrl, { type: 'module' });
      } catch (err) {
        mode = 'demo';
        emitStatus();
        Logger.warn('Embedder: не создать Worker, demo mode', String(err));
        return resolve();
      }

      // Таймаут загрузки модели: 120 секунд.
      // Если Worker не прислал 'ready' за это время, переходим в demo mode.
      // Это защищает от зависшего CDN или бесконечной загрузки.
      const LOAD_TIMEOUT = 120000;
      let resolved = false;

      const loadTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        Logger.warn('Embedder: таймаут загрузки модели (' + LOAD_TIMEOUT / 1000 + 'с), demo mode');
        cleanup();
        mode = 'demo';
        emitStatus();
        resolve();
      }, LOAD_TIMEOUT);

      worker.onerror = err => {
        if (resolved) return;
        resolved = true;
        clearTimeout(loadTimer);
        Logger.warn('Embedder: ошибка Worker, demo mode', String(err && err.message || err));
        cleanup();
        mode = 'demo';
        emitStatus();
        resolve();
      };

      worker.onmessage = e => {
        const msg = e.data;

        if (msg.type === 'progress') {
          lastPct = msg.pct;

          for (const fn of progressFns) {
            try { fn(msg); } catch (_) {}
          }

          try { bus.emit('ai:progress', msg); } catch (_) {}
          try {
            bus.emit('ai:status', {
              mode: 'loading',
              percent: msg.pct,
              loadedMB: msg.loadedMB,
              totalMB: msg.totalMB,
              model: msg.model,
            });
          } catch (_) {}
        }
        else if (msg.type === 'ready') {
          if (resolved) return;
          resolved = true;
          clearTimeout(loadTimer);
          mode = 'model';
          emitStatus();
          Logger.info('Embedder: модель готова');
          resolve();
        }
        else if (msg.type === 'error' && msg.id === null) {
          if (resolved) return;
          resolved = true;
          clearTimeout(loadTimer);
          Logger.warn('Embedder: ошибка загрузки модели, demo mode', msg.message);
          cleanup();
          mode = 'demo';
          emitStatus();
          resolve();
        }
        else if (msg.type === 'result') {
          const p = pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(msg.id);

            const vec = Float32Array.from(msg.vector);
            cacheSet(p.text, vec);
            p.resolve(vec);
          }
        }
        else if (msg.type === 'error' && msg.id != null) {
          const p = pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(msg.id);

            Logger.warn('Embedder: ошибка embed, hash fallback', msg.message);
            const v = hashEmbed(p.text);
            cacheSet(p.text, v);
            p.resolve(v);
          }
        }
      };

      worker.postMessage({
        type: 'load',
        model: Config.get('model', 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX'),
      });
    });
  }

  return {
    /**
     * Загрузка модели. Повторные вызовы возвращают тот же промис /
     * мгновенно резолвятся в режимах model/demo.
     * @param {Function} [onProgress] - Колбэк прогресса ({pct, loadedMB, totalMB, model}).
     * @returns {Promise<void>}
     */
    load(onProgress) {
      if (typeof onProgress === 'function') {
        progressFns.push(onProgress);
      }

      if (mode === 'model' || mode === 'demo') {
        return Promise.resolve();
      }

      if (loadPromise) return loadPromise;

      mode = 'loading';
      emitStatus();
      loadPromise = doLoad().then(() => {
        loadPromise = null;
      });

      return loadPromise;
    },

    /**
     * Эмбеддинг текста. Кэш LRU → Worker (с таймаутом) → hash-fallback.
     * @param {string} text - Текст.
     * @returns {Promise<Float32Array|null>} Вектор или null для пустого текста.
     */
    embed(text) {
      const t = (text || '').trim();
      if (!t) return Promise.resolve(null);

      const cached = cacheGet(t);
      if (cached) return Promise.resolve(cached);

      if (mode === 'demo' || !worker) {
        const v = hashEmbed(t);
        cacheSet(t, v);
        return Promise.resolve(v);
      }

      const id = nextId++;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            Logger.warn('Embedder: таймаут embed, hash fallback');
            const v = hashEmbed(t);
            cacheSet(t, v);
            resolve(v);
          }
        }, Config.get('aiEmbedTimeout', 15000));

        pending.set(id, { resolve, timer, text: t });
        worker.postMessage({ type: 'embed', id, text: t });
      });
    },

    /**
     * Готов ли эмбеддер к работе (model или demo).
     * @returns {boolean}
     */
    ready() {
      return mode === 'model' || mode === 'demo';
    },

    /**
     * Текущий режим: 'loading' | 'model' | 'demo'.
     * @returns {string}
     */
    getMode() {
      return mode;
    },

    /**
     * Подписка на прогресс загрузки (для UI).
     * @param {Function} fn - Колбэк.
     */
    onProgress(fn) {
      if (typeof fn === 'function') {
        progressFns.push(fn);
      }
    },
  };
}, ['Config', 'EventBus', 'Logger']);
// ─── AI/Embedder ─── END ────────────────────────────────────────────────────

// ─── AI/Ranker ─── START ────────────────────────────────────────────────────
/**
 * Ранжирование заметок по косинусному сходству.
 *
 * Логика порогов (адаптирована под Granite R2, диапазон ~0.55–0.93):
 *
 *   >= threshold               → relevant («В тему»)
 *   >= threshold - serendipity → serendipity («Озарение»)
 *   <  threshold - serendipity → скрыто полностью
 *
 * Нижний порог = threshold − serendipity БЕЗ дополнительного клампа:
 * пользователь сам отвечает за свои настройки через ползунки
 * (жёсткий предел 0.40 был убран намеренно — экстремальные настройки
 * дают экстремальные результаты, это ожидаемое поведение).
 */
DI.register('Ranker', function (Vec, Config) {
  /**
   * Пакетное вычисление косинусного сходства.
   * @param {Float32Array|number[]} queryVector - Вектор запроса.
   * @param {Array<{id: string, vector: Array|Float32Array}>} items - Заметки с векторами.
   * @param {AbortSignal} [signal] - Сигнал отмены.
   * @returns {Promise<Array<{id: string, score: number}>>} Отсортировано по убыванию.
   */
  function cosineBatch(queryVector, items, signal) {
    if (!queryVector || !items || !items.length) {
      return Promise.resolve([]);
    }

    if (signal && signal.aborted) {
      return Promise.reject(new Error('aborted'));
    }

    const out = [];
    for (const it of items) {
      if (signal && signal.aborted) {
        return Promise.reject(new Error('aborted'));
      }
      out.push({ id: it.id, score: Vec.cosine(queryVector, it.vector) });
    }

    out.sort((a, b) => b.score - a.score);
    return Promise.resolve(out);
  }

  /**
   * Разделение результатов на relevant и serendipity.
   * Пороги берутся из Config (настраиваются пользователем).
   *
   * @param {Array<{id: string, score: number}>} scored - Результаты cosineBatch.
   * @returns {{relevant: Array, seren: Array}}
   */
  function split(scored) {
    const threshold = Config.get('threshold', 0.81);
    const serendipity = Config.get('serendipity', 0.07);

    // Нижний порог = threshold - serendipity (без ограничений).
    const lowerBound = threshold - serendipity;

    const relevant = [];
    const seren = [];

    for (const s of scored) {
      if (s.score < lowerBound) {
        continue;
      }

      if (s.score >= threshold) {
        relevant.push(s);
      } else {
        seren.push(s);
      }
    }

    return { relevant, seren };
  }

  /**
   * Проверка на дубликат: два вектора считаются одинаковыми,
   * если их сходство >= duplicateThreshold.
   * Используется для предотвращения повторных запросов в сеть.
   *
   * Для Granite R2 (диапазон ~0.55–0.93) порог 0.88 означает
   * «практически идентичные по смыслу».
   *
   * @param {Float32Array|number[]} a
   * @param {Float32Array|number[]} b
   * @returns {boolean}
   */
  function isSimilar(a, b) {
    return Vec.cosine(a, b) >= Config.get('duplicateThreshold', 0.88);
  }

  return { cosineBatch, split, isSimilar };
}, ['Vec', 'Config']);
// ─── AI/Ranker ─── END ──────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: NET — криптография, транспорт, протокол, сетевой сервис
// ═══════════════════════════════════════════════════════════════════════════════

// ─── NET/Crypto ─── START ───────────────────────────────────────────────────
/**
 * Криптография аккаунта.
 *
 * Две зоны ответственности:
 *
 * 1. NIP-44 v2 — шифрование «самому себе»: ECDH(sk, pk(sk)).
 *    conversationKey, который может вычислить только владелец sk, —
 *    на нём держится приватный канон (kind 30078).
 *
 * 2. Форматы ключа:
 *    - nsec / hex — ввод (вход с другого устройства);
 *    - npub — публичный адрес (безопасен для показа);
 *    - ncryptsec (NIP-49) — ключ, обёрнутый паролем (scrypt + ChaCha20).
 *
 * ВАЖНО (выявлено в продакшене): в сборке nostr-tools@2.7.2 с CDN (+esm)
 * модуль nip49 может отсутствовать — тогда encryptKey/decryptKey
 * возвращают null. Потребители обязаны это обрабатывать: Account при
 * недоступности NIP-49 выдаёт ключ в формате nsec, UI адаптируется
 * через Account.canWrapKey() / Crypto.hasNip49().
 *
 * Все методы ждут Nostr.init() — загрузка nostr-tools асинхронная.
 * Методы форматов возвращают null при неудаче (UI показывает тост);
 * encryptSelf/decryptSelf бросают исключение (вызовы обёрнуты в
 * try/catch в Protocol).
 *
 * NIP-49 API-drift защита: nostr-tools в разных версиях возвращал из
 * decrypt() то Uint8Array, то {data}, то {secretKey} — поддержаны все
 * три формы.
 */
DI.register('Crypto', function (Nostr, Logger) {
  /**
   * Дождаться загрузки nostr-tools и вернуть её пространство имён.
   * @returns {Promise<Object>}
   * @throws {Error} Если библиотека не загрузилась.
   */
  async function lib() {
    await Nostr.init();
    const n = Nostr.lib();
    if (!n) throw new Error('nostr-tools not loaded');
    return n;
  }

  /**
   * Шифрование текста самому себе (NIP-44 v2).
   * @param {string} plaintext - Открытый текст.
   * @returns {Promise<string>} Шифртекст.
   * @throws {Error} Если NIP-44 недоступен или нет ключа.
   */
  async function encryptSelf(plaintext) {
    const n = await lib();
    const nip44 = n.nip44 && n.nip44.v2;
    if (!nip44 || !nip44.utils || typeof nip44.encrypt !== 'function') {
      throw new Error('NIP-44 unavailable');
    }

    const sk = Nostr.getSecretKey();
    const pk = Nostr.getPubkey();
    if (!sk || !pk) throw new Error('no secret key');

    const conversationKey = nip44.utils.getConversationKey(sk, pk);
    return nip44.encrypt(plaintext, conversationKey);
  }

  /**
   * Расшифровка своего шифртекста (NIP-44 v2).
   * @param {string} ciphertext - Шифртекст.
   * @returns {Promise<string>} Открытый текст.
   * @throws {Error} При неудаче расшифровки.
   */
  async function decryptSelf(ciphertext) {
    const n = await lib();
    const nip44 = n.nip44 && n.nip44.v2;
    if (!nip44 || !nip44.utils || typeof nip44.decrypt !== 'function') {
      throw new Error('NIP-44 unavailable');
    }

    const sk = Nostr.getSecretKey();
    const pk = Nostr.getPubkey();
    if (!sk || !pk) throw new Error('no secret key');

    const conversationKey = nip44.utils.getConversationKey(sk, pk);
    return nip44.decrypt(ciphertext, conversationKey);
  }

  /**
   * Доступность NIP-49 в загруженной сборке nostr-tools.
   * При false: encryptKey/decryptKey бесполезны, ключ следует выдавать
   * в формате nsec (без парольной обёртки).
   * @returns {Promise<boolean>}
   */
  async function hasNip49() {
    try {
      const n = await lib();
      return !!(n.nip49 && typeof n.nip49.encrypt === 'function' && typeof n.nip49.decrypt === 'function');
    } catch (_) {
      return false;
    }
  }

  /**
   * Классификация ввода ключа (синхронно, по префиксу).
   * @param {*} input - Строка от пользователя.
   * @returns {'nsec'|'ncryptsec'|'hex'|null} Тип или null.
   */
  function classifyKeyInput(input) {
    const t = String(input || '').trim();
    if (t.startsWith('ncryptsec1')) return 'ncryptsec';
    if (t.startsWith('nsec1')) return 'nsec';
    if (/^[0-9a-fA-F]{64}$/.test(t)) return 'hex';
    return null;
  }

  /**
   * Декодировать приватный ключ из nsec… или hex (без пароля).
   * @param {*} input - Строка от пользователя.
   * @returns {Promise<Uint8Array|null>} 32-байтный ключ или null.
   */
  async function decodeSecret(input) {
    const t = String(input || '').trim();
    if (!t) return null;

    // Raw hex
    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      return new Uint8Array(t.match(/.{2}/g).map(b => parseInt(b, 16)));
    }

    // nsec (bech32) — валидация библиотекой
    try {
      const n = await lib();
      if (t.startsWith('nsec1') && n.nip19 && typeof n.nip19.decode === 'function') {
        const dec = n.nip19.decode(t);
        if (dec && dec.type === 'nsec' && dec.data instanceof Uint8Array && dec.data.length === 32) {
          return dec.data;
        }
      }
    } catch (_) {}

    return null;
  }

  /**
   * Обернуть ключ паролем → ncryptsec (NIP-49).
   * Возвращает null, если NIP-49 недоступен в сборке или при ошибке.
   * @param {Uint8Array} sk - Приватный ключ.
   * @param {string} password - Пароль.
   * @returns {Promise<string|null>} Строка ncryptsec1… или null.
   */
  async function encryptKey(sk, password) {
    try {
      const n = await lib();
      if (!n.nip49 || typeof n.nip49.encrypt !== 'function') return null;
      return n.nip49.encrypt(sk, String(password || ''));
    } catch (e) {
      Logger.warn('Crypto: encryptKey', String(e && e.message || e));
      return null;
    }
  }

  /**
   * Снять ncryptsec → приватный ключ (NIP-49).
   * @param {string} ncryptsec - Строка ncryptsec1….
   * @param {string} password - Пароль.
   * @returns {Promise<Uint8Array|null>} 32-байтный ключ или null
   *   (неверный пароль → null, не исключение).
   */
  async function decryptKey(ncryptsec, password) {
    try {
      const n = await lib();
      if (!n.nip49 || typeof n.nip49.decrypt !== 'function') return null;

      const res = n.nip49.decrypt(String(ncryptsec || '').trim(), String(password || ''));

      // API-drift защита: три исторические формы возврата
      if (res instanceof Uint8Array) return res.length === 32 ? res : null;
      if (res && res.secretKey instanceof Uint8Array && res.secretKey.length === 32) return res.secretKey;
      if (res && res.data instanceof Uint8Array && res.data.length === 32) return res.data;

      return null;
    } catch (_) {
      // Неверный пароль или битая строка — тихий null
      return null;
    }
  }

  /**
   * Кодировать ключ в nsec… (bech32).
   * @param {Uint8Array} sk - Приватный ключ.
   * @returns {Promise<string|null>}
   */
  async function encodeNsec(sk) {
    try {
      const n = await lib();
      return n.nip19 ? n.nip19.nsecEncode(sk) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Кодировать публичный ключ в npub… (bech32).
   * @param {string} pk - Публичный ключ (hex).
   * @returns {Promise<string|null>}
   */
  async function encodeNpub(pk) {
    try {
      const n = await lib();
      return n.nip19 ? n.nip19.npubEncode(pk) : null;
    } catch (_) {
      return null;
    }
  }

  return {
    encryptSelf,
    decryptSelf,
    hasNip49,
    classifyKeyInput,
    decodeSecret,
    encryptKey,
    decryptKey,
    encodeNsec,
    encodeNpub,
  };
}, ['Nostr', 'Logger']);
// ─── NET/Crypto ─── END ─────────────────────────────────────────────────────

// ─── NET/Nostr ─── START ────────────────────────────────────────────────────
/**
 * Транспортный слой Nostr.
 * Управляет ключами, пулом рэлеев, публикацией и подписками.
 * Не содержит бизнес-логики — только отправка/приём.
 *
 * Отличие от v0.6: три новых метода для аккаунта и криптографии —
 * lib() (доступ к загруженной nostr-tools для NET/Crypto),
 * getSecretKey() и setKey() (замена ключа при входе с другого устройства).
 */
DI.register('Nostr', function (Config, bus, Logger) {
  const CDN = 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
  const SK_KEY = 'noomium:sk';

  /** @type {Object|null} Загруженное пространство имён nostr-tools. */
  let nostr = null;
  /** @type {Object|null} Пул рэлеев. */
  let pool = null;
  /** @type {Uint8Array|null} Приватный ключ. */
  let sk = null;
  /** @type {string|null} Публичный ключ (hex). */
  let pk = null;
  /** @type {Promise|null} */
  let initPromise = null;

  /**
   * Загрузить ключ из localStorage.
   * @returns {Uint8Array|null}
   */
  function loadKey() {
    try {
      const hex = localStorage.getItem(SK_KEY);
      if (hex && /^[0-9a-f]{64}$/i.test(hex)) {
        return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
      }
    } catch (_) {}
    return null;
  }

  /**
   * Сохранить ключ в localStorage (hex).
   * @param {Uint8Array} key
   */
  function saveKey(key) {
    try {
      localStorage.setItem(
        SK_KEY,
        Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('')
      );
    } catch (_) {}
  }

  /**
   * Инициализация: загрузка nostr-tools с CDN, восстановление/генерация
   * ключа, создание пула. Идемпотентна.
   * @returns {Promise<string>} Публичный ключ.
   */
  function init() {
    if (initPromise) return initPromise;

    initPromise = import(CDN).then(mod => {
      nostr = (typeof mod.generateSecretKey === 'function')
        ? mod
        : (mod.default && typeof mod.default.generateSecretKey === 'function' ? mod.default : mod);

      if (typeof nostr.generateSecretKey !== 'function') {
        throw new Error('nostr-tools: несовместимый модуль');
      }

      sk = loadKey();
      if (!sk) {
        sk = nostr.generateSecretKey();
        saveKey(sk);
      }

      pk = nostr.getPublicKey(sk);
      pool = new nostr.SimplePool();

      Logger.info('Nostr: готов, pubkey ' + pk.slice(0, 8) + '…');
      return pk;
    }).catch(err => {
      initPromise = null;
      Logger.error('Nostr: не загрузить nostr-tools', String(err && err.message || err));
      try { bus.emit('net:status', { status: 'failed' }); } catch (_) {}
      throw err;
    });

    return initPromise;
  }

  /**
   * Доступ к загруженному пространству имён nostr-tools.
   * Используется NET/Crypto (nip19/nip44/nip49) — не для транспорта.
   * @returns {Object|null}
   */
  function lib() {
    return nostr;
  }

  /**
   * Текущий приватный ключ (для экспорта/шифрования).
   * @returns {Uint8Array|null}
   */
  function getSecretKey() {
    return sk;
  }

  /**
   * Заменить ключ (вход с другого устройства). Пересчитывает pubkey,
   * сохраняет новый ключ. Пул рэлеев не зависит от ключа и не пересоздаётся.
   * Вызывать только после init().
   * @param {Uint8Array} newSk - Новый приватный ключ (32 байта).
   * @returns {string} Новый публичный ключ.
   * @throws {Error} Если ключ невалиден или библиотека не загружена.
   */
  function setKey(newSk) {
    if (!nostr) throw new Error('Nostr not ready');
    if (!(newSk instanceof Uint8Array) || newSk.length !== 32) {
      throw new Error('invalid secret key');
    }

    sk = newSk;
    pk = nostr.getPublicKey(sk);
    saveKey(sk);
    Logger.info('Nostr: ключ заменён, pubkey ' + pk.slice(0, 8) + '…');
    return pk;
  }

  /**
   * Подписать шаблон события текущим ключом.
   * @param {Object} template - Шаблон события.
   * @returns {Object} Подписанное событие.
   */
  function sign(template) {
    if (!nostr || !sk) throw new Error('Nostr not ready');
    return nostr.finalizeEvent(template, sk);
  }

  /**
   * Публикация события на все настроенные рэлеи.
   * Резолвится при успехе хотя бы на одном рэлее, таймаут 30 секунд.
   * @param {Object} template - Шаблон события.
   * @returns {Promise<Object>} Подписанное опубликованное событие.
   */
  function publish(template) {
    let ev;
    try {
      ev = sign(template);
    } catch (e) {
      return Promise.reject(e);
    }

    if (!pool) return Promise.reject(new Error('Nostr not ready'));

    const urls = relays();
    if (!urls.length) return Promise.reject(new Error('no relays configured'));

    const PUBLISH_TIMEOUT = 30000;

    const publishPromise = new Promise((resolve, reject) => {
      let settled = false;
      let failures = 0;

      urls.forEach(url => {
        pool.ensureRelay(url)
          .then(relay => relay.publish(ev))
          .then(() => {
            if (!settled) {
              settled = true;
              resolve(ev);
            }
          })
          .catch(err => {
            failures++;
            Logger.warn('Nostr: релей ' + url + ' не принял', String(err && err.message || err));

            if (!settled && failures === urls.length) {
              settled = true;
              reject(new Error('no relay accepted'));
            }
          });
      });
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('publish timeout')), PUBLISH_TIMEOUT);
    });

    return Promise.race([publishPromise, timeoutPromise]);
  }

  /**
   * Подписка на события через пул.
   * @param {Array<Object>} filters - Фильтры Nostr.
   * @param {Object} handlers - {onevent, onclose}.
   * @returns {Object|null} Объект подписки с методом close().
   */
  function subscribe(filters, handlers) {
    if (!pool) return null;
    return pool.subscribeMany(relays(), filters, handlers);
  }

  /**
   * Список настроенных рэлеев.
   * @returns {Array<string>}
   */
  function relays() {
    return Config.get('relays', []);
  }

  /**
   * Текущий публичный ключ.
   * @returns {string|null}
   */
  function getPubkey() {
    return pk;
  }

  /**
   * Готовность к работе.
   * @returns {boolean}
   */
  function isReady() {
    return !!(nostr && sk && pool);
  }

  /** Закрыть соединения пула. */
  function close() {
    if (pool && typeof pool.close === 'function') {
      try { pool.close(relays()); } catch (_) {}
    }
  }

  return {
    init,
    sign,
    publish,
    subscribe,
    ensureRelay(url) {
      if (!pool) return Promise.reject(new Error('Nostr not ready'));
      return pool.ensureRelay(url);
    },
    getPubkey,
    getSecretKey,
    setKey,
    lib,
    isReady,
    relays,
    close,
  };
}, ['Config', 'EventBus', 'Logger']);
// ─── NET/Nostr ─── END ──────────────────────────────────────────────────────

// ─── NET/Protocol ─── START ─────────────────────────────────────────────────
/**
 * Сериализация/десериализация Nostr-событий NOOmium.
 *
 * Виды событий:
 * - kind 1:     Публичная проекция заметки (текст + вектор + parent + uid)
 * - kind 30078: Приватный канон (NIP-78, replaceable, d-tag = uid,
 *               content = NIP-44-шифрованный JSON). Источник истины для
 *               синхронизации между устройствами.
 * - kind 21000: Запрос (вектор + параметры)
 * - kind 21001: Ответ (заметка + скор)
 * - kind 5:     Удаление публичных проекций (список event ID)
 *
 * Формат payload kind 30078 (до шифрования):
 *   { v: 1, text, vec: base64|null, parent: uid|null, shared: bool,
 *     ev: eventId|null, ts: ms }
 * Tombstone (удаление через replaceable-семантику):
 *   { v: 1, del: true, ts: ms }
 *
 * КРИТИЧНО: created_at для 30078 строго монотонен (счётчик ниже) —
 * иначе релей не заменит предыдущую версию.
 *
 * Безопасность:
 * - Все входящие тексты ограничены по длине (защита от переполнения)
 * - Все входящие векторы валидируются (конечность, числовой тип)
 */
DI.register('Protocol', function (Config, Vec, Crypto) {
  /** Максимальная длина шифртекста 30078 (с запасом на NIP-44 оверхед). */
  const MAX_PRIVATE_CONTENT = 65536;

  /** Монотонный счётчик created_at для replaceable-событий. */
  let lastPrivateTs = 0;

  /**
   * Следующий строго возрастающий timestamp (секунды).
   * Два апдейта в одну секунду не коллизируют.
   * @returns {number}
   */
  function nextPrivateTs() {
    let t = Math.floor(Date.now() / 1000);
    if (t <= lastPrivateTs) t = lastPrivateTs + 1;
    lastPrivateTs = t;
    return t;
  }

  /**
   * Найти тег по имени.
   * @param {Array} tags - Теги события.
   * @param {string} name - Имя тега.
   * @returns {Array|null}
   */
  function findTag(tags, name) {
    if (!Array.isArray(tags)) return null;
    for (const t of tags) {
      if (Array.isArray(t) && t[0] === name) return t;
    }
    return null;
  }

  // ─── Публичная проекция (kind 1) ──────────────────────────────────────────

  /**
   * Событие публичной проекции заметки.
   * @param {Object} note - Заметка (id = uid).
   * @param {string} room - Имя комнаты (тег t).
   * @param {string} [parentRef] - Ссылка на родителя для тега parent.
   *   По умолчанию note.parentId. NetService передаёт eventId родителя,
   *   если родитель опубликован (иначе сеть увидит неразрешимый uid).
   * @param {string} [parentPubkey] - Публичный ключ автора родителя
   *   (для чужих родителей). По умолчанию note.parentPubkey.
   * @returns {Object} Шаблон события (без подписи).
   */
  function noteEvent(note, room, parentRef, parentPubkey) {
    const tags = [['t', room], ['uid', note.id]];
    if (note.vector) tags.push(['v', Vec.toB64(note.vector)]);
    if (note.parentId) {
      tags.push(['parent', parentRef || note.parentId, parentPubkey !== undefined ? parentPubkey : (note.parentPubkey || '')]);
    }

    return {
      kind: Config.get('kNote', 1),
      created_at: Math.floor((note.createdAt || Date.now()) / 1000),
      tags,
      content: note.text || '',
    };
  }

  /**
   * Декодирование чужой публичной заметки (kind 1).
   * @param {Object} ev - Nostr-событие.
   * @returns {Object|null} Заметка-кандидат для сетевого кэша.
   */
  function decodeNote(ev) {
    if (!ev || ev.kind !== Config.get('kNote', 1)) return null;

    const maxLen = Config.get('maxNoteTextLength', 10000);
    if (typeof ev.content === 'string' && ev.content.length > maxLen) return null;

    const vTag = findTag(ev.tags, 'v');
    const pTag = findTag(ev.tags, 'parent');

    return {
      id: ev.id,
      text: ev.content || '',
      vector: vTag ? Vec.fromB64(vTag[1]) : null,
      shared: true,
      authorPubkey: ev.pubkey,
      parentId: pTag ? pTag[1] : null,
      parentPubkey: pTag ? (pTag[2] || null) : null,
      createdAt: (ev.created_at || 0) * 1000,
    };
  }

  // ─── Приватный канон (kind 30078, NIP-78) ────────────────────────────────

  /**
   * Событие приватного канона заметки. Полная версия (upsert).
   * @param {Object} note - Локальная заметка (id = uid).
   * @returns {Promise<Object>} Шаблон события с зашифрованным content.
   * @throws {Error} При недоступности NIP-44.
   */
  async function privateEvent(note) {
    const payload = {
      v: 1,
      text: note.text || '',
      vec: note.vector ? Vec.toB64(note.vector) : null,
      parent: note.parentId || null,
      shared: note.shared === true,
      ev: note.eventId || null,
      ts: Number(note.updatedAt || note.createdAt) || Date.now(),
    };

    const content = await Crypto.encryptSelf(JSON.stringify(payload));

    return {
      kind: Config.get('kPrivate', 30078),
      created_at: nextPrivateTs(),
      tags: [['d', note.id], ['client', 'noomium']],
      content,
    };
  }

  /**
   * Tombstone приватного канона: «заметка удалена».
   * Заменяет собой последнюю версию 30078 на релеях — все устройства
   * при синхронизации удалят локальную копию.
   * @param {string} uid - Идентификатор заметки.
   * @returns {Promise<Object>} Шаблон события.
   * @throws {Error} При недоступности NIP-44.
   */
  async function privateTombstone(uid) {
    const content = await Crypto.encryptSelf(JSON.stringify({ v: 1, del: true, ts: Date.now() }));

    return {
      kind: Config.get('kPrivate', 30078),
      created_at: nextPrivateTs(),
      tags: [['d', uid], ['client', 'noomium']],
      content,
    };
  }

  /**
   * Декодирование приватного канона (kind 30078): расшифровка + парсинг.
   * Чужие события не расшифруются (NIP-44 keys не совпадут) → null.
   *
   * @param {Object} ev - Nostr-событие kind 30078.
   * @returns {Promise<Object|null>}
   *   При полной версии: объект заметки для DB.put (id = uid, authorPubkey
   *   = null — заметка своя, own-семантика сохранена) + syncTs для LWW.
   *   При tombstone: {id, deleted: true, syncTs}.
   *   null — событие невалидно или не наше.
   */
  async function decodePrivate(ev) {
    if (!ev || ev.kind !== Config.get('kPrivate', 30078)) return null;

    const dTag = findTag(ev.tags, 'd');
    if (!dTag || typeof dTag[1] !== 'string' || !dTag[1]) return null;

    if (typeof ev.content !== 'string' || !ev.content) return null;
    if (ev.content.length > MAX_PRIVATE_CONTENT) return null;

    let plaintext;
    try {
      plaintext = await Crypto.decryptSelf(ev.content);
    } catch (_) {
      return null;
    }

    let data;
    try {
      data = JSON.parse(plaintext);
    } catch (_) {
      return null;
    }
    if (!data || typeof data !== 'object') return null;

    const syncTs = (ev.created_at || 0) * 1000;

    // Tombstone — удаление
    if (data.del === true) {
      return { id: dTag[1], deleted: true, syncTs };
    }

    // Полная версия — валидация полей
    if (typeof data.text !== 'string') return null;
    if (data.text.length > Config.get('maxNoteTextLength', 10000)) return null;

    let vector = null;
    if (typeof data.vec === 'string') {
      const v = Vec.fromB64(data.vec);
      if (v) vector = Array.from(v);
    }

    const ts = typeof data.ts === 'number' && data.ts > 0 ? data.ts : syncTs;

    return {
      id: dTag[1],
      text: data.text,
      vector,
      shared: data.shared === true,
      parentId: (typeof data.parent === 'string' && data.parent) ? data.parent : null,
      parentPubkey: null,
      authorPubkey: null,
      eventId: (typeof data.ev === 'string' && data.ev) ? data.ev : null,
      createdAt: ts,
      updatedAt: ts,
      syncTs,
    };
  }

  // ─── Запрос / ответ / удаление ────────────────────────────────────────────

  /**
   * Событие запроса (kind 21000).
   * @param {Float32Array|Array<number>} vector - Вектор запроса.
   * @param {number} maxResponses - Максимум ответов.
   * @param {number} window - Окно ответа (мс).
   * @returns {Object} Шаблон события.
   */
  function queryEvent(vector, maxResponses, window) {
    return {
      kind: Config.get('kQuery', 21000),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', Config.get('room', 'noomium-main')]],
      content: JSON.stringify({ vector: Array.from(vector), maxResponses, window }),
    };
  }

  /**
   * Декодирование запроса (kind 21000).
   * @param {Object} ev - Nostr-событие.
   * @returns {Object|null}
   */
  function decodeQuery(ev) {
    if (!ev || ev.kind !== Config.get('kQuery', 21000)) return null;

    let data;
    try {
      data = JSON.parse(ev.content);
    } catch (_) {
      return null;
    }

    if (!data || !Array.isArray(data.vector) || !data.vector.length) return null;

    for (const x of data.vector) {
      if (typeof x !== 'number' || !isFinite(x)) return null;
    }

    return {
      vector: data.vector,
      maxResponses: typeof data.maxResponses === 'number' ? data.maxResponses : Config.get('maxResponses', 8),
      window: typeof data.window === 'number' ? data.window : Config.get('responseWindow', 6000),
      authorPubkey: ev.pubkey,
      queryId: ev.id,
    };
  }

  /**
   * Событие ответа (kind 21001).
   * @param {Object} note - Локальная заметка.
   * @param {number} score - Скор сходства.
   * @param {string} queryId - ID запроса.
   * @param {string} room - Имя комнаты.
   * @returns {Object} Шаблон события.
   */
  function answerEvent(note, score, queryId, room) {
    return {
      kind: Config.get('kAnswer', 21001),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', room], ['e', queryId]],
      content: JSON.stringify({
        noteId: note.id,
        text: note.text,
        vector: note.vector ? Array.from(note.vector) : null,
        score,
      }),
    };
  }

  /**
   * Декодирование ответа (kind 21001).
   * @param {Object} ev - Nostr-событие.
   * @returns {Object|null}
   */
  function decodeAnswer(ev) {
    if (!ev || ev.kind !== Config.get('kAnswer', 21001)) return null;

    const eTag = findTag(ev.tags, 'e');
    if (!eTag) return null;

    let data;
    try {
      data = JSON.parse(ev.content);
    } catch (_) {
      return null;
    }

    if (!data || typeof data.text !== 'string') return null;
    if (data.text.length > Config.get('maxAnswerTextLength', 10000)) return null;

    let vector = null;
    if (Array.isArray(data.vector)) {
      for (const x of data.vector) {
        if (typeof x !== 'number' || !isFinite(x)) return null;
      }
      vector = data.vector;
    }

    return {
      id: ev.id,
      queryId: eTag[1],
      noteId: data.noteId || ev.id,
      text: data.text,
      vector,
      score: typeof data.score === 'number' ? data.score : 0,
      authorPubkey: ev.pubkey,
      createdAt: (ev.created_at || 0) * 1000,
    };
  }

  /**
   * Событие удаления публичных проекций (kind 5).
   * @param {string|Array<string>} eventIds - ID удаляемых событий.
   * @param {string} [room] - Имя комнаты (тег t).
   * @returns {Object|null} Шаблон события или null при пустом списке.
   */
  function deleteEvent(eventIds, room) {
    const ids = Array.isArray(eventIds) ? eventIds : [eventIds];
    const tags = ids.filter(Boolean).map(id => ['e', id]);

    if (!tags.length) return null;
    if (room) tags.push(['t', room]);

    return {
      kind: Config.get('kDelete', 5),
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    };
  }

  /**
   * Декодирование события удаления (kind 5).
   * @param {Object} ev - Nostr-событие.
   * @returns {Object|null} {eventIds, authorPubkey}.
   */
  function decodeDelete(ev) {
    if (!ev || ev.kind !== Config.get('kDelete', 5)) return null;

    const eTags = (ev.tags || []).filter(t => Array.isArray(t) && t[0] === 'e' && t[1]);
    if (!eTags.length) return null;

    return {
      eventIds: eTags.map(t => t[1]),
      authorPubkey: ev.pubkey,
    };
  }

  return {
    noteEvent,
    decodeNote,
    privateEvent,
    privateTombstone,
    decodePrivate,
    queryEvent,
    decodeQuery,
    answerEvent,
    decodeAnswer,
    deleteEvent,
    decodeDelete,
  };
}, ['Config', 'Vec', 'Crypto']);
// ─── NET/Protocol ─── END ───────────────────────────────────────────────────

// ─── NET/NetService ─── START ───────────────────────────────────────────────
/**
 * Оркестрация Nostr-сети: подписки, публикация, обработка входящих событий.
 *
 * Три канала:
 * 1. Комнатная подписка (kind 1/21000/21001/5 по тегу t) — как в v0.6.
 * 2. Подписка на себя (kind 30078, authors = свой pk) — живой синк между
 *    устройствами. NIP-01: для replaceable-событий релей отдаёт только
 *    последнюю версию каждого d-тега → restore = один дешёвый REQ.
 * 3. Исходящая публикация: приватный канон (30078) на каждое изменение
 *    заметки + публичная проекция (kind 1) для shared.
 *
 * LWW-модель канона:
 * - note.syncTs ставится при локальной правке (Notes) и при применении
 *   входящего события;
 * - входящий 30078 применяется только при syncTs > локального
 *   (равенство = эхо собственной публикации → пропуск);
 * - удаление канона — tombstone (30078 с del:true), НЕ kind 5.
 *
 * note.canonTs — время последней успешной публикации/приёма канона.
 * Самолечение: заметки без canonTs (созданные в паузе сети: смена ключа,
 * офлайн-старт, retry-гэп) ставятся в очередь при каждом старте.
 *
 * ФИКСЫ финальной редакции:
 * - unshare сбрасывает eventId СРАЗУ (иначе повторный «в мир» никогда
 *   не публиковал новую проекцию — баг, унаследованный из v0.6);
 * - account:changed чистит outbox и лимитеры (смена ключа);
 * - flushOutbox фазы priv/privdel уважают syncEnabled;
 * - parentId модели v0.7 — всегда uid своих / eventId чужих (см. Composer).
 */
DI.register('NetService', function (Nostr, Protocol, DB, Ranker, Vec, Store, Config, Logger, bus) {
  let started = false;
  let startPromise = null;
  let subscription = null;
  let selfSubscription = null;
  let hbTimer = null;
  let activeQueryId = null;
  let lastQueryVec = null;
  let lastQueryTime = 0;
  let centroids = [];
  let contextUnsub = null;
  let hasReceivedEvent = false;
  let flushing = false;
  let flushTimer = null;
  let startRetryTimer = null;
  let onlineListenerAdded = false;
  let reconnectAttempts = 0;
  let busUnsubs = [];

  /** @type {Set<string>} seen для комнатной подписки. */
  const seen = new Set();
  /** @type {Set<string>} seen для подписки на себя (оптимизация расшифровки). */
  const selfSeen = new Set();
  /** @type {Map<string, boolean>} дедупликация контента pubkey::text. */
  const contentSeen = new Map();
  /** @type {Map<string, number>} активные пиры (последний контакт). */
  const peers = new Map();
  /** @type {Map<string, number>} время последнего запроса от пира. */
  const peerQueryTimes = new Map();
  /** @type {Map<string, {tokens:number, ts:number}>} token bucket'ы пиров. */
  const peerNoteBudgets = new Map();

  let currentWindow = Config.get('subWindow', 300);
  let historyLoading = false;
  let subEpoch = 0;

  const OUTBOX_KEY = 'noomium:outbox';

  /**
   * Загрузка outbox из localStorage (четыре очереди, устойчиво к старому
   * формату v0.6 без priv/privdel).
   * @returns {{announce: string[], del: string[], priv: string[], privdel: string[]}}
   */
  function loadOutbox() {
    try {
      const raw = localStorage.getItem(OUTBOX_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        return {
          announce: Array.isArray(o.announce) ? o.announce.filter(Boolean) : [],
          del: Array.isArray(o.del) ? o.del.filter(Boolean) : [],
          priv: Array.isArray(o.priv) ? o.priv.filter(Boolean) : [],
          privdel: Array.isArray(o.privdel) ? o.privdel.filter(Boolean) : [],
        };
      }
    } catch (_) {}

    return { announce: [], del: [], priv: [], privdel: [] };
  }

  /** Сохранить outbox в localStorage. */
  function saveOutbox() {
    try {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    } catch (_) {}
  }

  let outbox = loadOutbox();

  const kNote = () => Config.get('kNote', 1);
  const kPrivate = () => Config.get('kPrivate', 30078);
  const kQuery = () => Config.get('kQuery', 21000);
  const kAnswer = () => Config.get('kAnswer', 21001);
  const kDelete = () => Config.get('kDelete', 5);
  const room = () => Config.get('room', 'noomium-main');

  function setStatus(s) {
    try { bus.emit('net:status', { status: s }); } catch (_) {}
  }

  /**
   * Фаза синка для AccountView: 'off' | 'active' | 'idle'.
   * @param {string} phase
   */
  function emitSync(phase) {
    try { bus.emit('sync:status', { phase }); } catch (_) {}
  }

  function notifyPeers() {
    try { bus.emit('net:peers', { count: peers.size }); } catch (_) {}
  }

  /**
   * @param {boolean} loading
   * @param {number} [windowSec]
   */
  function emitHistory(loading, windowSec) {
    try { bus.emit('net:history', { loading: loading, window: windowSec }); } catch (_) {}
  }

  /** @returns {boolean} Браузер считает себя офлайн. */
  function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /** @returns {boolean} Можно ли публиковать. */
  function canPublish() {
    return Nostr.isReady() && !isOffline();
  }

  // ─── Outbox: очереди ──────────────────────────────────────────────────────

  /** @param {string} id */
  function queueAnnounce(id) {
    if (!id) return;
    if (outbox.announce.indexOf(id) === -1) {
      outbox.announce.push(id);
      saveOutbox();
    }
    scheduleFlush();
  }

  /** @param {string} id */
  function unqueueAnnounce(id) {
    if (!id) return;
    const i = outbox.announce.indexOf(id);
    if (i > -1) {
      outbox.announce.splice(i, 1);
      saveOutbox();
    }
  }

  /** @param {string} id */
  function queuePrivate(id) {
    if (!id) return;
    if (outbox.priv.indexOf(id) === -1) {
      outbox.priv.push(id);
      saveOutbox();
    }
    scheduleFlush();
  }

  /** @param {string} id */
  function unqueuePrivate(id) {
    if (!id) return;
    const i = outbox.priv.indexOf(id);
    if (i > -1) {
      outbox.priv.splice(i, 1);
      saveOutbox();
    }
  }

  /** @param {string} id */
  function queuePrivDel(id) {
    if (!id) return;
    if (outbox.privdel.indexOf(id) === -1) {
      outbox.privdel.push(id);
      saveOutbox();
    }
    scheduleFlush();
  }

  /** @param {string} id */
  function unqueuePrivDel(id) {
    if (!id) return;
    const i = outbox.privdel.indexOf(id);
    if (i > -1) {
      outbox.privdel.splice(i, 1);
      saveOutbox();
    }
  }

  /** @param {string} id */
  function queueDelete(id) {
    if (!id) return;
    if (outbox.del.indexOf(id) === -1) {
      outbox.del.push(id);
      saveOutbox();
    }
    scheduleFlush();
  }

  /** @param {string} id */
  function unqueueDelete(id) {
    if (!id) return;
    const i = outbox.del.indexOf(id);
    if (i > -1) {
      outbox.del.splice(i, 1);
      saveOutbox();
    }
  }

  /**
   * Отложить сброс outbox.
   * @param {number} [delay]
   */
  function scheduleFlush(delay) {
    if (flushTimer) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushOutbox();
    }, delay || 5000);
  }

  /**
   * Сброс накопившихся офлайн-операций: priv → announce → del → privdel.
   * Фазы priv/privdel выполняются только при syncEnabled (иначе
   * отключённый синк всё равно публиковал бы очередь).
   * @returns {Promise<void>}
   */
  async function flushOutbox() {
    if (flushing) return;
    if (!canPublish()) return;
    if (!outbox.announce.length && !outbox.del.length && !outbox.priv.length && !outbox.privdel.length) return;

    flushing = true;

    try {
      // Фаза 1: приватный канон — последовательно, мягко к релеям.
      if (Config.get('syncEnabled', true)) {
        for (const uid of outbox.priv.slice()) {
          const note = await DB.get(uid).catch(() => null);
          if (!note) {
            unqueuePrivate(uid);
            continue;
          }
          try {
            const tpl = await Protocol.privateEvent(note);
            await Nostr.publish(tpl);
            unqueuePrivate(uid);
            const now = Date.now();
            note.canonTs = now;
            if (!note.syncTs) note.syncTs = now;
            DB.put(note).catch(() => {});
          } catch (_) {
            // Остаётся в очереди для повторной попытки.
          }
        }
      }

      // Фаза 2: публичные проекции — параллельно, allSettled.
      const announceIds = outbox.announce.slice();
      const tasks = announceIds.map(async noteId => {
        const note = await DB.get(noteId).catch(() => null);
        if (!note || !note.shared || !note.vector || note.eventId) {
          unqueueAnnounce(noteId);
          return;
        }
        try {
          const tpl = await buildNoteEvent(note);
          const ev = await Nostr.publish(tpl);
          unqueueAnnounce(noteId);

          if (ev && ev.id && note.id) {
            const cur = await DB.get(note.id).catch(() => null);
            if (cur && cur.eventId !== ev.id) {
              cur.eventId = ev.id;
              await DB.put(cur).catch(() => {});
              // eventId должен доехать в канон на другие устройства
              publishPrivate(cur);
            }
          }
        } catch (_) {
          // Остаётся в очереди.
        }
      });
      await Promise.allSettled(tasks);

      // Фаза 3: kind 5 — пачкой одним событием.
      if (outbox.del.length) {
        const ev = Protocol.deleteEvent(outbox.del.slice(), room());
        if (ev) {
          try {
            await Nostr.publish(ev);
            outbox.del = [];
            saveOutbox();
          } catch (_) {
            // Остаётся в очереди.
          }
        }
      }

      // Фаза 4: tombstone канона — последовательно.
      if (Config.get('syncEnabled', true)) {
        for (const uid of outbox.privdel.slice()) {
          try {
            const tpl = await Protocol.privateTombstone(uid);
            await Nostr.publish(tpl);
            unqueuePrivDel(uid);
          } catch (_) {
            // Остаётся в очереди.
          }
        }
      }
    } catch (_) {} finally {
      flushing = false;

      if (outbox.announce.length || outbox.del.length || outbox.priv.length || outbox.privdel.length) {
        scheduleFlush(10000);
      }
    }
  }

  /**
   * Сканирование при старте:
   * - shared без eventId → очередь анонса (ремонт офлайн-заметок);
   * - без canonTs → очередь канона (самолечение: заметки, созданные в
   *   паузе сети — смена ключа, офлайн, retry-гэп — публикуются здесь).
   * @returns {Promise<void>}
   */
  async function scanLocalUnpublished() {
    try {
      const notes = await DB.all();
      const syncOn = Config.get('syncEnabled', true);

      notes.forEach(n => {
        if (!n || !n.id) return;
        if (n.shared && n.vector && !n.eventId) queueAnnounce(n.id);
        if (syncOn && !n.canonTs) queuePrivate(n.id);
      });

      flushOutbox();
    } catch (_) {}
  }

  // ─── Приватный канон: публикация ──────────────────────────────────────────

  /**
   * Опубликовать канон заметки (kind 30078). Очередь при офлайне/сбое.
   * При успехе ставит canonTs (метка «канон на релее есть»).
   * @param {Object} note - Локальная заметка.
   * @returns {Promise<void>}
   */
  async function publishPrivate(note) {
    if (!Config.get('syncEnabled', true)) return;
    if (!note || !note.id) return;

    if (!canPublish()) {
      queuePrivate(note.id);
      return;
    }

    try {
      const tpl = await Protocol.privateEvent(note);
      await Nostr.publish(tpl);
      unqueuePrivate(note.id);
      const now = Date.now();
      note.canonTs = now;
      if (!note.syncTs) note.syncTs = now;
      DB.put(note).catch(() => {});
    } catch (e) {
      Logger.warn('NetService: канон в очередь', String(e && e.message || e));
      queuePrivate(note.id);
    }
  }

  /**
   * Опубликовать tombstone канона (удаление заметки из синка).
   * @param {string} uid - Идентификатор заметки.
   * @returns {Promise<void>}
   */
  async function tombstoneNote(uid) {
    if (!Config.get('syncEnabled', true)) return;
    if (!uid) return;

    if (!canPublish()) {
      queuePrivDel(uid);
      return;
    }

    try {
      const tpl = await Protocol.privateTombstone(uid);
      await Nostr.publish(tpl);
      unqueuePrivDel(uid);
    } catch (e) {
      Logger.warn('NetService: tombstone в очередь', String(e && e.message || e));
      queuePrivDel(uid);
    }
  }

  /**
   * Резолв ссылки на родителя для публичной проекции: если родитель —
   * своя опубликованная заметка, тег parent получает её eventId
   * (резолвимо сетью). Иначе Protocol использует note.parentId как есть
   * (uid своего неопубликованного родителя или eventId чужого).
   * @param {Object} note - Заметка.
   * @returns {Promise<Object>} Шаблон события kind 1.
   */
  async function buildNoteEvent(note) {
    let parentRef;
    let parentPubkey;

    if (note.parentId) {
      const parent = await DB.get(note.parentId).catch(() => null);
      if (parent && parent.eventId) {
        parentRef = parent.eventId;
        parentPubkey = note.parentPubkey || '';
      }
    }

    return Protocol.noteEvent(note, room(), parentRef, parentPubkey);
  }

  /**
   * Одноразовый backsweep: публикация канона для всех локальных заметок
   * (миграция v0.6 → v0.7). Флаг ставится после enqueue — недоставшее
   * доедет через outbox и самолечение scanLocalUnpublished.
   * @returns {Promise<void>}
   */
  async function runBacksweep() {
    if (!Config.get('syncEnabled', true)) {
      emitSync('off');
      return;
    }
    if (Config.get('syncMigrated', false)) {
      emitSync('idle');
      return;
    }

    emitSync('active');

    try {
      const notes = await DB.all();
      let queued = 0;

      for (const n of notes) {
        if (n && n.id) {
          if (canPublish()) {
            await publishPrivate(n);
          } else {
            queuePrivate(n.id);
          }
          queued++;
        }
      }

      Config.set('syncMigrated', true);
      Logger.info('NetService: backsweep — ' + queued + ' заметок в канон');
    } catch (e) {
      Logger.warn('NetService: backsweep ошибка', String(e && e.message || e));
    }

    emitSync('idle');
    flushOutbox();
  }

  // ─── Приватный канон: приём ───────────────────────────────────────────────

  /**
   * Применить входящий канон (от своего ключа с другого устройства).
   * LWW: применяется только при отсутствии локальной версии или при
   * строго большем syncTs (равенство = эхо своей публикации).
   * Принятые заметки получают canonTs (канон на релее есть).
   * @param {Object} d - Результат Protocol.decodePrivate.
   * @returns {Promise<void>}
   */
  async function applyIncomingPrivate(d) {
    if (!d || !d.id) return;

    try {
      const cur = await DB.get(d.id);

      // Tombstone — удаление
      if (d.deleted) {
        if (!cur) return;
        if (!cur.syncTs || d.syncTs > cur.syncTs) {
          await DB.del(d.id);
          try { bus.emit('sync:applied', { uid: d.id, deleted: true }); } catch (_) {}
        }
        return;
      }

      // Полная версия
      if (!cur) {
        await DB.put({
          id: d.id,
          text: d.text,
          vector: d.vector,
          shared: d.shared,
          parentId: d.parentId,
          parentPubkey: d.parentPubkey,
          authorPubkey: null,
          eventId: d.eventId,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          syncTs: d.syncTs,
          canonTs: Date.now(),
        });
        try { bus.emit('sync:applied', { uid: d.id }); } catch (_) {}
        return;
      }

      if (!cur.syncTs || d.syncTs > cur.syncTs) {
        await DB.put({
          id: d.id,
          text: d.text,
          vector: d.vector,
          shared: d.shared,
          parentId: d.parentId,
          parentPubkey: d.parentPubkey,
          authorPubkey: null,
          eventId: d.eventId,
          createdAt: cur.createdAt || d.createdAt,
          updatedAt: d.updatedAt,
          syncTs: d.syncTs,
          canonTs: Date.now(),
        });
        try { bus.emit('sync:applied', { uid: d.id }); } catch (_) {}
      }
    } catch (e) {
      Logger.warn('NetService: applyIncomingPrivate', String(e && e.message || e));
    }
  }

  // ─── Подписка на себя ─────────────────────────────────────────────────────

  /** Подписка на собственный приватный канон (живой синк + restore). */
  function subscribeSelf() {
    const pk = Nostr.getPubkey();
    if (!pk) return;

    if (!Config.get('syncEnabled', true)) {
      emitSync('off');
      return;
    }

    if (selfSubscription && typeof selfSubscription.close === 'function') {
      try { selfSubscription.close(); } catch (_) {}
    }

    selfSubscription = Nostr.subscribe(
      [{ authors: [pk], kinds: [kPrivate()] }],
      {
        onevent: ev => {
          if (!ev || !ev.id) return;

          // Оптимизация: не расшифровывать повторно одно и то же событие.
          if (selfSeen.has(ev.id)) return;
          selfSeen.add(ev.id);
          if (selfSeen.size > 500) {
            const arr = Array.from(selfSeen);
            selfSeen.clear();
            for (let i = Math.floor(arr.length / 2); i < arr.length; i++) {
              selfSeen.add(arr[i]);
            }
          }

          Protocol.decodePrivate(ev)
            .then(d => { if (d) applyIncomingPrivate(d); })
            .catch(() => {});
        },
        onclose: () => {
          // Синк критичен: переподписка с фиксированной задержкой, без статусов.
          setTimeout(() => {
            if (started && Config.get('syncEnabled', true)) {
              subscribeSelf();
            }
          }, 5000);
        },
      }
    );
  }

  // ─── Вспомогательные сети ─────────────────────────────────────────────────

  function ensureOnlineListener() {
    if (onlineListenerAdded) return;
    onlineListenerAdded = true;

    window.addEventListener('online', () => {
      if (!started) {
        start();
        return;
      }

      if (!isOffline()) {
        if (!subscription) subscribeToRoom();
        if (!selfSubscription && Config.get('syncEnabled', true)) subscribeSelf();
      }

      flushOutbox();
    });

    window.addEventListener('offline', () => {
      if (!started) return;

      setStatus('failed');

      // Инвалидируем подписки, чтобы onclose не запускал переподключение.
      subEpoch++;

      if (subscription && typeof subscription.close === 'function') {
        try { subscription.close(); } catch (_) {}
      }
      subscription = null;
    });
  }

  /** Обрезка seen-множества (комнатного). */
  function trimSeen() {
    const max = Config.get('seenMaxSize', 1000);
    if (seen.size <= max) return;

    const arr = Array.from(seen);
    seen.clear();

    for (let i = arr.length - Math.floor(max / 2); i < arr.length; i++) {
      seen.add(arr[i]);
    }
  }

  /**
   * Дедупликация контента от одного автора.
   * @param {string} pubkey
   * @param {string} text
   * @returns {boolean} true, если уже видели такой же текст.
   */
  function isContentDuplicate(pubkey, text) {
    const key = pubkey + '::' + String(text || '').trim();
    if (contentSeen.has(key)) return true;

    contentSeen.set(key, true);

    if (contentSeen.size > 2000) {
      const first = contentSeen.keys().next().value;
      contentSeen.delete(first);
    }

    return false;
  }

  /**
   * Token bucket для входящих заметок от одного автора.
   * Стартовый бюджет позволяет загрузить историю при первичной
   * синхронизации, но защищает от флуда.
   * @param {string} pubkey
   * @returns {boolean}
   */
  function allowIncomingNote(pubkey) {
    const now = Date.now();
    const capacity = Math.max(1, Number(Config.get('maxIncomingNotesPerPeer', 20)) || 20);
    const refillPerSec = 2;

    let bucket = peerNoteBudgets.get(pubkey);

    if (!bucket) {
      bucket = { tokens: capacity, ts: now };
      peerNoteBudgets.set(pubkey, bucket);
    }

    const elapsedSec = Math.max(0, (now - bucket.ts) / 1000);
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
      bucket.ts = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /** Перестройка центроидов префильтра (k-means по публичным заметкам). */
  function rebuildCentroids() {
    DB.all().then(notes => {
      const vecs = notes.filter(n => n.shared && n.vector).map(n => n.vector);
      if (!vecs.length) {
        centroids = [];
        return;
      }

      centroids = Vec.kmeans(
        vecs,
        Math.min(Config.get('centroidCount', 12), vecs.length),
        8
      );
    }).catch(() => {});
  }

  /**
   * @param {Float32Array|Array<number>} queryVector
   * @returns {boolean}
   */
  function passesPrefilter(queryVector) {
    if (!centroids.length) return true;

    const floor = Config.get('threshold', 0.81) - 0.20;
    for (const c of centroids) {
      if (Vec.cosine(queryVector, c) >= floor) return true;
    }

    return false;
  }

  // ─── Входящие события (комната) ───────────────────────────────────────────

  /**
   * @param {boolean} hard - true при реальном получении события
   *   (сбрасывает счётчик реконнектов); false — по 5с-таймауту.
   */
  function markConnected(hard) {
    if (!started) return;

    if (hard) {
      hasReceivedEvent = true;
      reconnectAttempts = 0;
    }

    setStatus('connected');
    flushOutbox();
  }

  /** Обработчик событий комнатной подписки. */
  function onEvent(ev) {
    if (!ev) return;

    // Любое полученное событие подтверждает, что сеть жива.
    if (!hasReceivedEvent) {
      markConnected(true);
    }

    if (seen.has(ev.id)) return;

    // Свои события комнаты игнорируем, но помечаем как виденные.
    // (30078 сюда не попадает — отдельная подписка на себя.)
    if (ev.pubkey === Nostr.getPubkey()) {
      seen.add(ev.id);
      trimSeen();
      return;
    }

    let accepted = false;

    if (ev.kind === kNote()) {
      accepted = handleIncomingNote(ev);
    } else if (ev.kind === kQuery()) {
      accepted = handleIncomingQuery(ev);
    } else if (ev.kind === kAnswer()) {
      accepted = handleIncomingAnswer(ev);
    } else if (ev.kind === kDelete()) {
      accepted = handleIncomingDelete(ev);
    }

    if (accepted) {
      seen.add(ev.id);
      trimSeen();
    }
  }

  /**
   * @param {Object} ev
   * @returns {boolean} true — пометить seen; false — оставить для повторной обработки.
   */
  function handleIncomingNote(ev) {
    const note = Protocol.decodeNote(ev);

    if (!note) return true;

    // Rate-limit: НЕ помечаем seen, чтобы событие могло пройти позже.
    if (!allowIncomingNote(note.authorPubkey)) {
      return false;
    }

    if (isContentDuplicate(note.authorPubkey, note.text)) {
      return true;
    }

    peers.set(note.authorPubkey, Date.now());

    // O(1): своя заметка, вернувшаяся от релея (по id или eventId).
    if (DB.hasLocal(note.id)) return true;

    DB.cacheGet(note.id).then(existing => {
      if (existing && existing.createdAt && note.createdAt && existing.createdAt > note.createdAt) {
        return;
      }

      DB.cachePut(note);
      notifyPeers();
    }).catch(() => {});

    return true;
  }

  /**
   * @param {Object} ev
   * @returns {boolean}
   */
  function handleIncomingQuery(ev) {
    const q = Protocol.decodeQuery(ev);

    if (!q) return true;

    const now = Date.now();
    const last = peerQueryTimes.get(ev.pubkey) || 0;

    if (now - last < Config.get('queryRateLimit', 3000)) {
      return true;
    }

    peerQueryTimes.set(ev.pubkey, now);

    if (!passesPrefilter(q.vector)) {
      return true;
    }

    DB.all().then(notes => {
      const candidates = notes.filter(n => n.shared && n.vector);
      if (!candidates.length) return null;

      const byId = new Map(candidates.map(n => [n.id, n]));
      const items = candidates.map(n => ({ id: n.id, vector: n.vector }));

      return Ranker.cosineBatch(q.vector, items).then(scored => {
        const top = scored
          .filter(s => s.score >= Config.get('threshold', 0.81))
          .slice(0, q.maxResponses || Config.get('maxResponses', 8));

        top.forEach((s, i) => {
          const note = byId.get(s.id);
          if (!note) return;

          setTimeout(() => {
            Nostr.publish(Protocol.answerEvent(note, s.score, q.queryId, room()))
              .catch(e => Logger.warn('NetService: не отправить ответ', String(e)));
          }, i * 250);
        });
      });
    }).catch(e => Logger.warn('NetService: ошибка обработки запроса', String(e)));

    return true;
  }

  /**
   * @param {Object} ev
   * @returns {boolean}
   */
  function handleIncomingAnswer(ev) {
    const a = Protocol.decodeAnswer(ev);

    if (!a) return true;

    if (a.queryId !== activeQueryId) {
      return true;
    }

    if (isContentDuplicate(a.authorPubkey, a.text)) {
      return true;
    }

    peers.set(a.authorPubkey, Date.now());

    DB.cachePut({
      id: a.id,
      text: a.text,
      vector: a.vector,
      shared: true,
      authorPubkey: a.authorPubkey,
      createdAt: a.createdAt,
      score: a.score,
    });

    notifyPeers();

    return true;
  }

  /**
   * @param {Object} ev
   * @returns {boolean}
   */
  function handleIncomingDelete(ev) {
    const del = Protocol.decodeDelete(ev);

    if (!del) return true;

    del.eventIds.forEach(eventId => {
      if (eventId) DB.cacheDel(eventId);
    });

    if (del.authorPubkey) peers.set(del.authorPubkey, Date.now());
    notifyPeers();

    return true;
  }

  // ─── Исходящие операции ───────────────────────────────────────────────────

  /**
   * Анонс публичной проекции заметки (kind 1). При успехе eventId
   * сохраняется и уезжает в канон (чтобы другие устройства могли
   * удалить проекцию при необходимости).
   * @param {Object} note
   * @returns {Promise<void>}
   */
  async function announceNote(note) {
    if (!note || !note.shared || !note.vector) return;

    if (note.eventId) {
      unqueueAnnounce(note.id);
      return;
    }

    if (!canPublish()) {
      queueAnnounce(note.id);
      return;
    }

    try {
      const tpl = await buildNoteEvent(note);
      const ev = await Nostr.publish(tpl);
      unqueueAnnounce(note.id);
      Logger.info('NetService: анонс заметки ' + note.id);

      if (ev && ev.id && note.id) {
        const cur = await DB.get(note.id).catch(() => null);
        if (cur && cur.eventId !== ev.id) {
          cur.eventId = ev.id;
          await DB.put(cur).catch(() => {});
          publishPrivate(cur);
        }
      }
    } catch (e) {
      Logger.warn('NetService: не анонсировать, поставлено в очередь', String(e && e.message || e));
      queueAnnounce(note.id);
    }
  }

  /**
   * Запрос удаления публичной проекции с рэлеев (kind 5).
   * @param {Object} note - Заметка (нужны id и eventId).
   * @returns {Promise<void>}
   */
  async function forgetNote(note) {
    if (!note || !note.eventId) return;

    if (!canPublish()) {
      queueDelete(note.eventId);
      return;
    }

    const ev = Protocol.deleteEvent(note.eventId, room());
    if (!ev) return;

    try {
      await Nostr.publish(ev);
      unqueueDelete(note.eventId);
      Logger.info('NetService: запрос удаления с рэлеев ' + note.id);
    } catch (e) {
      Logger.warn('NetService: не удалить с рэлеев, поставлено в очередь', String(e && e.message || e));
      queueDelete(note.eventId);
    }
  }

  /**
   * Отправка запроса в сеть при изменении контекста.
   * В офлайне запросы не отправляем.
   */
  function maybeSendQuery() {
    const ctx = Store.get('context');

    if ((ctx.source !== 'pin' && ctx.source !== 'drift') || !ctx.vector) {
      lastQueryVec = null;
      return;
    }

    if (!canPublish()) {
      lastQueryVec = null;
      return;
    }

    const now = Date.now();
    if (now - lastQueryTime < Config.get('queryRateLimit', 3000)) return;

    if (lastQueryVec && Ranker.isSimilar(lastQueryVec, ctx.vector)) return;

    lastQueryVec = ctx.vector;
    lastQueryTime = now;

    const tpl = Protocol.queryEvent(
      ctx.vector,
      Config.get('maxResponses', 8),
      Config.get('responseWindow', 6000)
    );

    Nostr.publish(tpl)
      .then(ev => {
        activeQueryId = ev.id;
        Logger.info('NetService: запрос ' + ev.id.slice(0, 8) + '…');
      })
      .catch(e => {
        lastQueryVec = null;
        lastQueryTime = 0;
        Logger.warn('NetService: не отправить запрос', String(e && e.message || e));
      });
  }

  // ─── Подписка на комнату ──────────────────────────────────────────────────

  /** Подписка на комнату с экспоненциальным реконнектом. */
  function subscribeToRoom() {
    const since = Math.floor(Date.now() / 1000) - currentWindow;
    const filters = [{
      kinds: [kNote(), kQuery(), kAnswer(), kDelete()],
      '#t': [room()],
      since,
    }];

    const myEpoch = ++subEpoch;

    if (subscription && typeof subscription.close === 'function') {
      try { subscription.close(); } catch (_) {}
    }

    subscription = Nostr.subscribe(filters, {
      onevent: onEvent,
      onclose: () => {
        if (myEpoch !== subEpoch) return;

        setStatus('reconnecting');

        // Экспоненциальный реконнект: base * 2^(n-1), максимум maxDelay,
        // джиттер ±25% против синхронных штормов.
        const maxAttempts = Config.get('reconnectMaxAttempts', 10);
        const baseDelay = Config.get('reconnectBaseDelay', 1000);
        const maxDelay = Config.get('reconnectMaxDelay', 60000);

        reconnectAttempts++;

        if (reconnectAttempts > maxAttempts) {
          Logger.warn('NetService: ' + maxAttempts + ' неудачных подключений, жду сеть/пользователя');
          setStatus('failed');
          return;
        }

        const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts - 1), maxDelay);
        const jitter = delay * 0.25 * Math.random();

        setTimeout(() => {
          if (started && myEpoch === subEpoch && !isOffline()) {
            subscribeToRoom();
          }
        }, delay + jitter);
      },
    });

    if (subscription) {
      setStatus('connecting');

      // Пустая комната: через 5 секунд считаем подключение установленным
      // (без сброса счётчика реконнектов — только реальное событие его сбрасывает).
      setTimeout(() => {
        if (myEpoch === subEpoch && started && !isOffline()) {
          markConnected(false);
        }
      }, 5000);
    }
  }

  /** Расширение окна истории («Загрузить ещё»). */
  function loadHistory() {
    if (!started || historyLoading) return;

    const maxWindow = Config.get('historyMaxWindow', 2592000);
    if (currentWindow >= maxWindow) {
      emitHistory(false, currentWindow);
      return;
    }

    historyLoading = true;
    emitHistory(true, currentWindow);

    currentWindow = Math.min(maxWindow, Math.max(currentWindow * 4, 86400));

    try {
      subscribeToRoom();
      Logger.info('NetService: окно истории → ' + currentWindow + 's');
    } finally {
      setTimeout(() => {
        historyLoading = false;
        emitHistory(false, currentWindow);
      }, 1200);
    }
  }

  /** Heartbeat: чистка пиров и лимитеров. */
  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);

    hbTimer = setInterval(() => {
      const now = Date.now();
      const ttl = Config.get('peerTTL', 60000);
      let changed = false;

      peers.forEach((ts, pk) => {
        if (now - ts > ttl) {
          peers.delete(pk);
          changed = true;
        }
      });

      peerQueryTimes.forEach((ts, pk) => {
        if (now - ts > 60000) peerQueryTimes.delete(pk);
      });

      peerNoteBudgets.forEach((bucket, pk) => {
        if (now - bucket.ts > 300000) peerNoteBudgets.delete(pk);
      });

      if (changed) notifyPeers();
      trimSeen();
    }, Config.get('heartbeat', 30000));
  }

  // ─── Старт/стоп ───────────────────────────────────────────────────────────

  function start() {
    if (started) return Promise.resolve();
    if (startPromise) return startPromise;

    ensureOnlineListener();

    startPromise = Nostr.init()
      .then(() => DB.ready())
      .then(() => {
        started = true;
        hasReceivedEvent = false;
        reconnectAttempts = 0;

        busUnsubs.forEach(u => {
          try { u(); } catch (_) {}
        });
        busUnsubs = [];

        busUnsubs.push(bus.on('note:created', note => {
          if (!note) return;
          publishPrivate(note);
          if (note.shared) announceNote(note);
        }));

        busUnsubs.push(bus.on('note:updated', note => {
          // Правки только личных заметок; канон должен узнать новую версию.
          if (note) publishPrivate(note);
        }));

        busUnsubs.push(bus.on('note:shared', note => {
          if (!note || !note.shared) return;
          publishPrivate(note);
          announceNote(note);
        }));

        busUnsubs.push(bus.on('note:unshared', note => {
          if (!note) return;

          if (note.id) unqueueAnnounce(note.id);

          if (!note.shared && note.eventId) {
            // ФИКС: сбрасываем eventId СРАЗУ — иначе повторный «в мир»
            // никогда не опубликует новую проекцию (announceNote exit'ит
            // по наличию eventId). Старую проекцию удаляем kind 5.
            const oldEventId = note.eventId;

            DB.get(note.id).then(cur => {
              if (!cur) {
                publishPrivate(note);
                return;
              }
              cur.eventId = null;
              return DB.put(cur).then(() => {
                // Канон должен узнать, что eventId больше нет
                publishPrivate(cur);
                // Удаление старой проекции (kind 5, очередь при офлайне)
                forgetNote({ id: cur.id, eventId: oldEventId });
              });
            }).catch(() => publishPrivate(note));
            return;
          }

          publishPrivate(note);
        }));

        busUnsubs.push(bus.on('note:deleted', note => {
          if (!note) return;

          if (note.id) unqueueAnnounce(note.id);
          tombstoneNote(note.id);
          if (note.shared && note.eventId) forgetNote(note);
        }));

        busUnsubs.push(bus.on('db:change', () => rebuildCentroids()));

        // Смена ключа (вход с другого устройства): очереди и лимитеры
        // принадлежат старому аккаунту — чистим, чтобы не публиковать
        // мусор новым ключом и не блокировать restore дедупликацией.
        busUnsubs.push(bus.on('account:changed', () => {
          outbox = { announce: [], del: [], priv: [], privdel: [] };
          saveOutbox();
          seen.clear();
          selfSeen.clear();
          contentSeen.clear();
          peers.clear();
          peerQueryTimes.clear();
          peerNoteBudgets.clear();
        }));

        busUnsubs.push(bus.on('sync:toggle', p => {
          if (!p) return;
          if (p.enabled) {
            subscribeSelf();
            runBacksweep();
          } else {
            if (selfSubscription && typeof selfSubscription.close === 'function') {
              try { selfSubscription.close(); } catch (_) {}
            }
            selfSubscription = null;
            emitSync('off');
          }
        }));

        contextUnsub = Store.subscribe(s => s.context, () => maybeSendQuery());

        startHeartbeat();
        rebuildCentroids();
        scanLocalUnpublished();

        if (isOffline()) {
          setStatus('failed');
          Logger.warn('NetService: офлайн, ожидаем появление сети');
        } else {
          subscribeToRoom();
        }

        subscribeSelf();
        runBacksweep();

        Logger.info('NetService: запущен, комната #' + room());
      }).catch(e => {
        Logger.error('NetService: не стартовать', String(e && e.message || e));
        setStatus('failed');

        if (startRetryTimer) clearTimeout(startRetryTimer);
        startRetryTimer = setTimeout(() => {
          if (!started) start();
        }, 10000);
      }).finally(() => {
        startPromise = null;
      });

    return startPromise;
  }

  /**
   * @param {boolean} full - Полная остановка с очисткой лимитеров.
   */
  function stop(full) {
    started = false;
    hasReceivedEvent = false;

    if (subscription && typeof subscription.close === 'function') {
      try { subscription.close(); } catch (_) {}
    }
    subscription = null;

    if (selfSubscription && typeof selfSubscription.close === 'function') {
      try { selfSubscription.close(); } catch (_) {}
    }
    selfSubscription = null;

    if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }

    if (contextUnsub) {
      try { contextUnsub(); } catch (_) {}
      contextUnsub = null;
    }

    busUnsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    busUnsubs = [];

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = null;
    }

    activeQueryId = null;
    lastQueryVec = null;
    lastQueryTime = 0;
    reconnectAttempts = 0;

    if (full) {
      peers.clear();
      seen.clear();
      selfSeen.clear();
      contentSeen.clear();
      peerQueryTimes.clear();
      peerNoteBudgets.clear();
    }

    setStatus('disconnected');
  }

  /**
   * Публичный wipe для Boot/MenuView: удаление всего канона и проекций.
   *
   * Надёжность:
   * - tombstone'ы и kind 5 СНАЧАЛА ставятся в персистентную очередь
   *   (outbox в localStorage) — wipe корректен и в офлайне;
   * - доставка сейчас — с бюджетом 15 секунд; недоставленное в бюджет
   *   при wipe доедет из outbox позже, при fullReset — теряется
   *   осознанно (best-effort природа удаления в Nostr).
   *
   * @returns {Promise<void>}
   */
  async function publishWipeAll() {
    let notes = [];
    try {
      notes = await DB.all();
    } catch (_) {
      return;
    }

    // Публичные проекции: kind 5 пачкой (или в очередь при офлайне).
    if (canPublish()) {
      const pubIds = notes.filter(n => n && n.eventId).map(n => n.eventId);
      if (pubIds.length) {
        const ev = Protocol.deleteEvent(pubIds, room());
        if (ev) {
          await Nostr.publish(ev).catch(() => {});
        }
      }
    } else {
      notes.forEach(n => {
        if (n && n.eventId) queueDelete(n.eventId);
      });
    }

    // Tombstone'ы канона — в персистентную очередь (независимо от сети).
    if (Config.get('syncEnabled', true)) {
      notes.forEach(n => {
        if (n && n.id) queuePrivDel(n.id);
      });
    }

    // Попытка доставить сейчас — с бюджетом.
    if (canPublish()) {
      const WIPE_BUDGET = 15000;
      await Promise.race([
        flushOutbox().catch(() => {}),
        new Promise(res => setTimeout(res, WIPE_BUDGET)),
      ]);
    }
  }

  return { start, stop, loadHistory, publishWipeAll };
}, ['Nostr', 'Protocol', 'DB', 'Ranker', 'Vec', 'Store', 'Config', 'Logger', 'EventBus']);
// ─── NET/NetService ─── END ─────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: DOMAIN — бизнес-логика
// ═══════════════════════════════════════════════════════════════════════════════

// ─── DOMAIN/Notes ─── START ─────────────────────────────────────────────────
/**
 * CRUD для локальных заметок.
 * Каждая заметка при создании/редактировании получает вектор через Embedder.
 * События: note:created, note:updated, note:deleted, note:shared, note:unshared.
 *
 * Модель v0.7:
 * - id — стабильный uid (Utils.uid('n')), никогда не меняется;
 * - parentId — всегда uid родителя (никаких eventId в ссылках);
 * - syncTs — метка последнего локального изменения; NetService использует
 *   её для LWW при синхронизации канона (kind 30078). Ставится при каждом
 *   изменении: равенство syncTs у входящего события = эхо собственной
 *   публикации, событие не применяется;
 * - eventId — ссылка на публичную проекцию (kind 1), проставляется
 *   NetService'ом после анонса.
 */
DI.register('Notes', function (DB, Embedder, bus, Logger, Utils) {
  /**
   * Эмит события в шину (никогда не бросает).
   * @param {string} event - Имя события.
   * @param {*} payload - Полезная нагрузка.
   */
  function emit(event, payload) {
    try { bus.emit(event, payload); } catch (_) {}
  }

  /**
   * Создание заметки.
   * @param {string} text - Текст заметки.
   * @param {string} mode - 'private' или 'world'.
   * @param {string|null} parentId - uid родительской заметки (связь «по мотивам»).
   * @returns {Promise<Object|null>} Созданная заметка или null при пустом тексте.
   */
  function create(text, mode, parentId) {
    const t = (text || '').trim();
    if (!t) return Promise.resolve(null);

    return Embedder.embed(t).then(vector => {
      const now = Date.now();
      const note = {
        id: Utils.uid('n'),
        text: t,
        vector: vector ? Array.from(vector) : null,
        shared: mode === 'world',
        parentId: parentId || null,
        parentPubkey: null,
        createdAt: now,
        updatedAt: now,
        syncTs: now,
      };

      return DB.put(note).then(() => {
        emit('note:created', note);
        return note;
      });
    });
  }

  /**
   * Редактирование заметки. Пересчитывает вектор.
   * Публичные заметки редактировать нельзя (immutable в Nostr) —
   * проверяется на уровне UI (NoteView), здесь не блокируется.
   * @param {string} id - uid заметки.
   * @param {string} newText - Новый текст.
   * @returns {Promise<Object|null>} Обновлённая заметка или null.
   */
  function edit(id, newText) {
    const t = (newText || '').trim();
    if (!t) return Promise.resolve(null);

    return DB.get(id).then(note => {
      if (!note) return null;

      return Embedder.embed(t).then(vector => {
        const now = Date.now();
        note.text = t;
        note.vector = vector ? Array.from(vector) : null;
        note.updatedAt = now;
        note.syncTs = now;

        return DB.put(note).then(() => {
          emit('note:updated', note);
          return note;
        });
      });
    });
  }

  /**
   * Удаление заметки.
   * @param {string} id - uid заметки.
   * @returns {Promise<Object|null>} Удалённая заметка (для NetService) или null.
   */
  function remove(id) {
    return DB.get(id).then(note => {
      if (!note) return null;

      return DB.del(id).then(() => {
        emit('note:deleted', note);
        return note;
      });
    });
  }

  /**
   * Переключение видимости: личное ↔ мир.
   * При публикации NetService (слушает note:shared/note:unshared)
   * обновляет канон и анонсирует/удаляет публичную проекцию.
   * @param {string} id - uid заметки.
   * @returns {Promise<Object|null>} Обновлённая заметка или null.
   */
  function toggleShared(id) {
    return DB.get(id).then(note => {
      if (!note) return null;

      note.shared = !note.shared;
      note.updatedAt = Date.now();
      note.syncTs = Date.now();

      return DB.put(note).then(() => {
        emit(note.shared ? 'note:shared' : 'note:unshared', note);
        return note;
      });
    });
  }

  /**
   * Получить заметку по uid.
   * @param {string} id
   * @returns {Promise<Object|undefined>}
   */
  function get(id) {
    return DB.get(id);
  }

  return { create, edit, remove, toggleShared, get };
}, ['DB', 'Embedder', 'EventBus', 'Logger', 'Utils']);
// ─── DOMAIN/Notes ─── END ───────────────────────────────────────────────────

// ─── DOMAIN/Context ─── START ───────────────────────────────────────────────
/**
 * Управление текущим контекстом поиска.
 *
 * Состояния контекста:
 * - 'pin':   Заметка закреплена (клик по карточке). Лента показывает созвучное.
 * - 'drift': Закреплённая заметка + пользователь печатает. Контекст плавно
 *            смещается от закреплённой мысли к вводимому тексту.
 * - 'input': Пользователь печатает без закреплённой заметки.
 * - null:    Контекста нет. Лента в хронологическом порядке.
 *
 * Событие 'note:pin' от NoteView/FeedView активирует пин.
 *
 * pinNote хранит eventId, если родитель опубликован: Composer передаёт
 * parentId = eventId || id (v0.6-семантика), NetService дополнительно
 * резолвит ссылку родителя при публикации проекции.
 */
DI.register('Context', function (Store, Embedder, Config, Utils, bus) {
  /** @type {string} */
  let inputText = '';
  /** @type {Float32Array|null} */
  let inputVector = null;
  /** @type {Object|null} */
  let pinNote = null;

  /**
   * Вычисление активного контекста на основе текущего состояния.
   * Приоритет: drift > pin > input > none.
   * @returns {Object} Контекст для Store.
   */
  function activeContext() {
    const hasInput = !!inputText.trim();

    if (pinNote && hasInput) {
      return {
        source: 'drift',
        noteId: pinNote.id,
        text: inputText.trim(),
        vector: inputVector,
        pinText: pinNote.text,
      };
    }

    if (pinNote) {
      return {
        source: 'pin',
        noteId: pinNote.id,
        text: pinNote.text,
        vector: pinNote.vector,
      };
    }

    if (hasInput) {
      return {
        source: 'input',
        noteId: null,
        text: inputText.trim(),
        vector: inputVector,
      };
    }

    return {
      source: null,
      noteId: null,
      text: '',
      vector: null,
      pinText: null,
    };
  }

  /** Пуш активного контекста в Store. */
  function push() {
    Store.setState({ context: activeContext() });
  }

  /**
   * Дебаунс для эмбеддинга вводимого текста.
   * Если пользователь быстро печатает, вектор пересчитывается
   * только после паузы в `debounce` мс.
   */
  const debouncedEmbed = Utils.debounce(() => {
    const t = inputText.trim();
    if (!t) {
      inputVector = null;
      push();
      return;
    }

    Embedder.embed(t).then(v => {
      // Защита от race condition: если текст изменился пока считался вектор,
      // не применяем устаревший результат.
      if (inputText.trim() === t) {
        inputVector = v;
        push();
      }
    });
  }, Config.get('debounce', 350));

  return {
    /**
     * Обновить вводимый текст (из Composer).
     * @param {string} text - Текущее значение поля ввода.
     */
    setInput(text) {
      inputText = text || '';
      if (!inputText.trim()) inputVector = null;
      push();
      debouncedEmbed();
    },

    /**
     * Закрепить заметку (пин).
     * @param {Object} note - Заметка с вектором.
     */
    setPin(note) {
      if (!note || !note.vector) return;
      pinNote = {
        id: note.id,
        eventId: note.eventId || null,
        text: note.text,
        vector: note.vector,
      };
      push();
    },

    /** Снять пин. */
    clearPin() {
      pinNote = null;
      push();
    },

    /** Полная очистка (ввод + пин). */
    clear() {
      inputText = '';
      inputVector = null;
      pinNote = null;
      debouncedEmbed.cancel();
      push();
    },

    /**
     * Вектор активного контекста.
     * @returns {Float32Array|Array<number>|null}
     */
    getVector() {
      return activeContext().vector;
    },

    /**
     * Активный контекст (снапшот).
     * @returns {Object}
     */
    getActive() {
      return activeContext();
    },

    /**
     * Текущий пин (для Composer).
     * @returns {Object|null}
     */
    getPin() {
      return pinNote;
    },

    /**
     * Инициализация: подписка на note:pin из шины.
     * Вызывается через Context.init() (метод, не деструктуризация).
     */
    init() {
      bus.on('note:pin', note => {
        if (note) this.setPin(note);
      });
    },
  };
}, ['Store', 'Embedder', 'Config', 'Utils', 'EventBus']);
// ─── DOMAIN/Context ─── END ─────────────────────────────────────────────────

// ─── DOMAIN/Feed ─── START ──────────────────────────────────────────────────
/**
 * Формирование ленты.
 *
 * Два режима:
 * 1. Без контекста (source === null):
 *    Все заметки (локальные + сетевые) в хронологическом порядке.
 *
 * 2. С контекстом (pin / drift / input):
 *    Ранжирование по косинусному сходству с вектором контекста.
 *    Разделение на relevant (>= threshold) и serendipity (ниже порога,
 *    но в пределах окна озарений).
 *
 * Обновление триггерится:
 * - Изменением контекста (подписка на Store)
 * - Изменением локальной БД (db:change) — включая заметки, применённые
 *   из приватного канона (sync)
 * - Изменением сетевого кэша (db:cache)
 */
DI.register('Feed', function (DB, Ranker, Store, bus, Logger) {
  /** Счётчик поколений для защиты от гонок. */
  let seq = 0;
  /** @type {Array<Function>} */
  let unsubs = [];

  /**
   * Пересборка ленты. Если за время асинхронной работы пришёл новый вызов,
   * результат устаревшего отбрасывается (seq-guard).
   * @returns {Promise<void>}
   */
  function refresh() {
    const my = ++seq;
    const ctx = Store.get('context');

    return Promise.all([DB.all(), DB.cacheAll()]).then(([local, cached]) => {
      if (my !== seq) return;

      if (!ctx.source) {
        // Режим 1: без контекста — хронологический поток

        // Дедупликация: исключаем из cached заметки, уже существующие
        // локально (по id или eventId). Вторая линия обороны после
        // DB.hasLocal в NetService.
        const localIds = new Set();
        local.forEach(n => {
          if (n && n.id) localIds.add(n.id);
          if (n && n.eventId) localIds.add(n.eventId);
        });

        const filteredCached = cached.filter(n => {
          if (!n || !n.id) return false;
          return !localIds.has(n.id);
        });

        const merged = [
          ...local.map(n => Object.assign({}, n, { own: true })),
          ...filteredCached.map(n => Object.assign({}, n, { own: false })),
        ].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));

        Store.setState({
          feed: merged,
          lists: { local: [], world: [], seren: [] },
        });

        return;
      }

      if (!ctx.vector) return;

      // Режим 2: ранжирование по сходству
      const items = [];
      const dataMap = new Map();

      for (const n of local) {
        if (n && n.vector) {
          items.push({ id: n.id, vector: n.vector });
          dataMap.set(n.id, Object.assign({}, n, { own: true }));
        }
      }

      for (const n of cached) {
        if (n && n.vector) {
          items.push({ id: n.id, vector: n.vector });
          dataMap.set(n.id, Object.assign({}, n, { own: false }));
        }
      }

      return Ranker.cosineBatch(ctx.vector, items).then(scored => {
        if (my !== seq) return;

        const { relevant, seren } = Ranker.split(scored);

        const toRes = s => {
          const n = dataMap.get(s.id);
          return n ? Object.assign({}, n, { score: s.score }) : null;
        };

        const rel = relevant.map(toRes).filter(Boolean);

        Store.setState({
          lists: {
            local: rel.filter(n => n.own),
            world: rel.filter(n => !n.own),
            seren: seren.map(toRes).filter(Boolean),
          },
          feed: [],
        });
      });
    }).catch(err => {
      Logger.warn('Feed: ошибка refresh', String(err && err.message || err));
    });
  }

  /**
   * Инициализация: подписки на триггеры + первичная сборка.
   */
  function init() {
    unsubs.push(Store.subscribe(s => s.context, () => refresh(), Store.shallowEqual));
    unsubs.push(bus.on('db:change', () => refresh()));
    unsubs.push(bus.on('db:cache', () => refresh()));

    refresh();
  }

  /** Отписка от всех триггеров. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, refresh };
}, ['DB', 'Ranker', 'Store', 'EventBus', 'Logger']);
// ─── DOMAIN/Feed ─── END ────────────────────────────────────────────────────

// ─── DOMAIN/Provenance ─── START ────────────────────────────────────────────
/**
 * Построение генеалогических связей между заметками.
 *
 * Заметки связаны через поле parentId:
 * - свои заметки (в т.ч. пришедшие из приватного канона): parentId = uid;
 * - чужие заметки: parentId = eventId публичной проекции родителя.
 *
 * Поэтому поиск родителя/детей всегда проверяет оба поля (id и eventId).
 *
 * Отличие от v0.6: кэш предков (TTL 5с) инвалидируется сам — модуль
 * подписан на db:change / db:cache в теле фабрики. Внешний вызов
 * clearCache из MenuView удалён (мёртвый код в новой версии).
 *
 * Модуль инстанцируется при резолве FeedView (BOOT, шаг 5) — до
 * первого сетевого события, подписка безопасна.
 */
DI.register('Provenance', function (DB, bus) {
  /** @type {Map<string, {chain: Array, timestamp: number}>} */
  const ancestorsCache = new Map();
  const CACHE_TTL = 5000;

  /**
   * Все заметки: локальные + сетевой кэш.
   * @returns {Promise<Array<Object>>}
   */
  function loadAll() {
    return Promise.all([DB.all(), DB.cacheAll()]).then(([own, cached]) => own.concat(cached));
  }

  /**
   * Прямые дети заметки по её id или eventId.
   * @param {string} id - uid или eventId заметки.
   * @returns {Promise<Array<Object>>}
   */
  function children(id) {
    if (!id) return Promise.resolve([]);

    return loadAll().then(all => all.filter(n => n && n.parentId === id));
  }

  /**
   * Все потомки (BFS). Защита от циклов через seenIds.
   * @param {string} id - uid или eventId заметки.
   * @returns {Promise<Array<Object>>}
   */
  function descendants(id) {
    if (!id) return Promise.resolve([]);

    return loadAll().then(all => {
      const out = [];
      const seenIds = new Set([id]);
      let frontier = [id];

      while (frontier.length) {
        const next = [];

        for (const n of all) {
          if (n && n.parentId && frontier.indexOf(n.parentId) !== -1 && !seenIds.has(n.id)) {
            seenIds.add(n.id);
            out.push(n);
            next.push(n.id);
          }
        }

        frontier = next;
      }

      return out;
    });
  }

  /**
   * Цепочка предков от текущей заметки до корня.
   *
   * Поиск родителя учитывает:
   * 1. Точное совпадение по id (локальная/своя заметка, uid)
   * 2. Совпадение по eventId (опубликованная проекция)
   * 3. Локальная заметка с matching eventId
   *
   * Защита от циклов через seen.
   *
   * @param {string} id - uid или eventId заметки.
   * @returns {Promise<Array<Object>>} Цепочка от непосредственного родителя к корню.
   */
  function ancestors(id) {
    if (!id) return Promise.resolve([]);

    const cached = ancestorsCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return Promise.resolve(cached.chain);
    }

    return loadAll().then(all => {
      const byId = new Map();

      all.forEach(n => {
        if (!n) return;
        if (n.id) byId.set(n.id, n);
        if (n.eventId) byId.set(n.eventId, n);
      });

      function findNote(targetId) {
        if (!targetId) return null;

        // 1. Прямое совпадение по id или eventId
        if (byId.has(targetId)) return byId.get(targetId);

        // 2. Локальная заметка, которая была опубликована (имеет matching eventId)
        const localPublished = all.find(n => n && n.id === targetId && n.eventId);
        if (localPublished) return localPublished;

        // 3. Сетевая заметка с matching eventId
        const byEvent = all.find(n => n && n.eventId === targetId);
        if (byEvent) return byEvent;

        return null;
      }

      const chain = [];
      const seen = new Set();
      let current = findNote(id);

      while (current && current.parentId) {
        if (seen.has(current.parentId)) break;
        seen.add(current.parentId);

        const parent = findNote(current.parentId);
        if (!parent) break;

        chain.push(parent);
        current = parent;
      }

      ancestorsCache.set(id, { chain, timestamp: Date.now() });
      return chain;
    });
  }

  /**
   * Принудительная очистка кеша предков.
   * @returns {void}
   */
  function clearCache() {
    ancestorsCache.clear();
  }

  // Самоинвалидация кэша при любом изменении данных.
  bus.on('db:change', clearCache);
  bus.on('db:cache', clearCache);

  return { children, descendants, ancestors, loadAll, clearCache };
}, ['DB', 'EventBus']);
// ─── DOMAIN/Provenance ─── END ──────────────────────────────────────────────

// ─── DOMAIN/Influence ─── START ─────────────────────────────────────────────
/**
 * Подсчёт резонанса: сколько уникальных авторов создали потомков заметки.
 *
 * Резонанс показывает влияние заметки на сеть. Если заметка A породила
 * 5 заметок от 3 разных авторов, её резонанс = 3 (уникальные авторы).
 * Свои потомки учитываются как автор 'self'.
 *
 * Карта resonanceMap перестраивается при изменении БД или создании/
 * удалении заметок; инкрементальное обновление при создании/обновлении.
 *
 * Ключи карты — значения parentId детей (uid для своих, eventId для
 * чужих). Consumers проверяют оба: resonance(n.id) + resonance(n.eventId).
 */
DI.register('Influence', function (DB, bus, Logger) {
  /** @type {Map<string, Set<string>>} uid/eventId → множество авторов. */
  const resonanceMap = new Map();
  /** Счётчик поколений для защиты от гонок. */
  let seq = 0;

  /**
   * Полная перестройка карты резонанса.
   * @returns {Promise<void>}
   */
  function rebuild() {
    const my = ++seq;

    return Promise.all([DB.all(), DB.cacheAll()]).then(([own, cached]) => {
      if (my !== seq) return;

      const map = new Map();

      own.concat(cached).forEach(n => {
        if (n && n.parentId) {
          if (!map.has(n.parentId)) map.set(n.parentId, new Set());
          map.get(n.parentId).add(n.authorPubkey || 'self');
        }
      });

      resonanceMap.clear();
      map.forEach((v, k) => resonanceMap.set(k, v));

      try { bus.emit('influence:updated'); } catch (_) {}
    }).catch(e => Logger.warn('Influence: ошибка rebuild', String(e)));
  }

  /**
   * Инкрементальное обновление при создании/обновлении заметки.
   * @param {Object} note - Заметка с parentId.
   */
  function updateForNote(note) {
    if (!note || !note.parentId) return;

    if (!resonanceMap.has(note.parentId)) {
      resonanceMap.set(note.parentId, new Set());
    }

    resonanceMap.get(note.parentId).add(note.authorPubkey || 'self');

    try { bus.emit('influence:updated'); } catch (_) {}
  }

  /**
   * Резонанс заметки по id (uid).
   * @param {string} id - uid заметки.
   * @returns {number} Число уникальных авторов потомков.
   */
  function resonance(id) {
    if (!id) return 0;
    const s = resonanceMap.get(id);
    return s ? s.size : 0;
  }

  /**
   * Инициализация: подписки на изменения + первичная перестройка.
   */
  function init() {
    bus.on('note:created', updateForNote);
    bus.on('note:updated', updateForNote);
    bus.on('note:deleted', () => rebuild());
    bus.on('db:change', () => rebuild());
    bus.on('db:cache', () => rebuild());

    rebuild();
  }

  return { init, resonance, rebuild };
}, ['DB', 'EventBus', 'Logger']);
// ─── DOMAIN/Influence ─── END ───────────────────────────────────────────────

// ─── DOMAIN/Account ─── START ───────────────────────────────────────────────
/**
 * Аккаунт: ключ, экспорт/импорт, вход с другого устройства.
 *
 * Ответственность модуля:
 * - состояние аккаунта (pubkey, keyExported, syncEnabled — снапшот);
 * - показ ключа: npub (безопасен), ncryptsec (NIP-49, пароль опционален);
 *   ПРИ НЕДОСТУПНОСТИ NIP-49 в сборке nostr-tools — fallback на nsec
 *   (незашифрованный ключ; вход по нему работает через decodeSecret);
 * - вход по ключу (nsec/hex/ncryptsec): замена ключа, сброс локальной базы,
 *   перезапуск сети. Релеи НЕ чистятся — старые заметки принадлежат старому
 *   ключу и остаются доступными при возврате к нему;
 * - JSON-архив: экспорт ({version, app, pubkey, ncryptsec?, notes, config})
 *   и импорт с upsert по uid (LWW по syncTs/updatedAt).
 *
 * Интеграция с сетью:
 * - импортированные заметки эмитятся как note:created → существующий
 *   слушатель NetService публикует приватный канон для каждой;
 * - announceNote пропускает заметки с eventId из архива (повторный анонс
 *   не нужен, replaceable-семантика дорезает конфликты).
 *
 * UI-оркестрация (подтверждения, тосты, скачивание файла) — AccountView.
 */
DI.register('Account', function (Config, Nostr, Crypto, DB, bus, Logger) {
  /** Whitelist параметров конфига, переносимых из архива. */
  const CONFIG_WHITELIST = [
    'threshold',
    'serendipity',
    'duplicateThreshold',
    'similarityDisplay',
    'lang',
    'theme',
  ];

  /**
   * Снапшот состояния аккаунта для UI.
   * @returns {Promise<Object>} {pubkey, keyExported, syncEnabled}
   */
  async function getAccountInfo() {
    await Nostr.init();
    return {
      pubkey: Nostr.getPubkey(),
      keyExported: Config.get('keyExported', false),
      syncEnabled: Config.get('syncEnabled', true),
    };
  }

  /**
   * Публичный адрес (npub, bech32). Безопасен для показа и передачи.
   * @returns {Promise<string|null>}
   */
  async function getNpub() {
    const pk = Nostr.getPubkey();
    if (!pk) return null;
    return Crypto.encodeNpub(pk);
  }

  /**
   * Можно ли обернуть ключ паролем (NIP-49 доступен в окружении).
   * Если нет — ключ будет выдан в формате nsec, UI скрывает поле пароля.
   * @returns {Promise<boolean>}
   */
  async function canWrapKey() {
    try {
      return await Crypto.hasNip49();
    } catch (_) {
      return false;
    }
  }

  /**
   * Ключ для передачи на другое устройство.
   *
   * Приоритет: ncryptsec (NIP-49, с паролем или без). Если NIP-49
   * недоступен в сборке nostr-tools с CDN — fallback: nsec
   * (незашифрованный ключ, nip19 гарантированно доступен).
   *
   * При успехе помечает keyExported = true.
   *
   * @param {string} [password] - Пароль (имеет смысл только при
   *   доступном NIP-49; может быть пустым).
   * @returns {Promise<string|null>} Строка nsec1…/ncryptsec1… или null.
   */
  async function getWrappedKey(password) {
    const sk = Nostr.getSecretKey();
    if (!sk) return null;

    const wrapped = await Crypto.encryptKey(sk, String(password || ''));
    if (wrapped) {
      Config.set('keyExported', true);
      return wrapped;
    }

    // Fallback: NIP-49 недоступен — выдаём nsec.
    const nsec = await Crypto.encodeNsec(sk);
    if (nsec) {
      Logger.warn('Account: NIP-49 недоступен, ключ выдан в формате nsec');
      Config.set('keyExported', true);
      return nsec;
    }

    return null;
  }

  /**
   * Вход по ключу с другого устройства: замена ключа, сброс локальной базы,
   * перезапуск сети. Релеи не чистятся (заметки старого ключа остаются).
   *
   * Вызывать только после подтверждения пользователя (UI).
   *
   * @param {string} input - nsec…, hex(64) или ncryptsec….
   * @param {string} [password] - Пароль для ncryptsec.
   * @returns {Promise<{ok: boolean, error?: string, pubkey?: string}>}
   */
  async function enterKey(input, password) {
    const type = Crypto.classifyKeyInput(input);
    if (!type) return { ok: false, error: 'bad' };

    let sk = null;
    try {
      if (type === 'ncryptsec') {
        sk = await Crypto.decryptKey(String(input || '').trim(), String(password || ''));
      } else {
        sk = await Crypto.decodeSecret(input);
      }
    } catch (e) {
      Logger.warn('Account: enterKey decode', String(e && e.message || e));
    }

    if (!sk) return { ok: false, error: 'bad' };

    try {
      await Nostr.init();
      const pk = Nostr.setKey(sk);

      // Локальная база принадлежит старому ключу — сбрасываем.
      await DB.reset();

      Config.set('keyExported', false);

      try { bus.emit('account:changed', { pubkey: pk }); } catch (_) {}

      // Перезапуск сети: новая подписка на себя, restore канона.
      try {
        const NetService = DI.resolve('NetService');
        NetService.stop(false);
        setTimeout(() => { NetService.start(); }, 500);
      } catch (_) {}

      Logger.info('Account: ключ заменён, pubkey ' + pk.slice(0, 8) + '…');
      return { ok: true, pubkey: pk };
    } catch (e) {
      Logger.error('Account: enterKey', String(e && e.message || e));
      return { ok: false, error: 'failed' };
    }
  }

  // ─── Экспорт архива ───────────────────────────────────────────────────────

  /**
   * Собрать JSON-архив: заметки + настройки + опционально ключ.
   * Ключ в архиве — в том же формате, что выдаёт getWrappedKey
   * (ncryptsec или nsec-fallback при недоступном NIP-49).
   * @param {boolean} [includeKey] - Включить ключ в архив.
   * @param {string} [keyPassword] - Пароль для ключа в архиве.
   * @returns {Promise<{json: string, filename: string}|null>}
   */
  async function exportArchive(includeKey, keyPassword) {
    try {
      await Nostr.init();

      const notes = await DB.all();
      const archive = {
        version: 1,
        app: 'noomium',
        createdAt: Date.now(),
        pubkey: Nostr.getPubkey(),
        ncryptsec: null,
        notes: notes.map(sanitizeNoteForArchive).filter(Boolean),
        config: {},
      };

      CONFIG_WHITELIST.forEach(k => {
        archive.config[k] = Config.get(k);
      });

      if (includeKey) {
        archive.ncryptsec = await getWrappedKey(keyPassword);
        if (!archive.ncryptsec) {
          return null;
        }
      }

      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      const filename = 'noomium-backup-'
        + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
        + '-' + pad(d.getHours()) + pad(d.getMinutes())
        + '.json';

      return { json: JSON.stringify(archive, null, 2), filename };
    } catch (e) {
      Logger.error('Account: exportArchive', String(e && e.message || e));
      return null;
    }
  }

  /**
   * Валидация заметки перед записью в архив: копируем только известные поля.
   * @param {Object} n - Заметка из DB.
   * @returns {Object|null}
   */
  function sanitizeNoteForArchive(n) {
    if (!n || typeof n.id !== 'string' || typeof n.text !== 'string') return null;
    if (n.text.length > Config.get('maxNoteTextLength', 10000)) return null;

    let vector = null;
    if (Array.isArray(n.vector)) {
      vector = n.vector.filter(x => typeof x === 'number' && isFinite(x));
    }

    return {
      id: n.id,
      text: n.text,
      vector,
      shared: n.shared === true,
      parentId: (typeof n.parentId === 'string' && n.parentId) ? n.parentId : null,
      eventId: (typeof n.eventId === 'string' && n.eventId) ? n.eventId : null,
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
      updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : null,
      syncTs: typeof n.syncTs === 'number' ? n.syncTs : null,
    };
  }

  // ─── Импорт архива ────────────────────────────────────────────────────────

  /**
   * Разобрать и валидировать текст архива (без применения).
   * @param {string} text - Содержимое файла.
   * @returns {{ok: boolean, error?: string, archive?: Object}}
   *   archive: {version, pubkey, ncryptsec: string|null,
   *             notes: Array, config: Object, noteCount: number}
   */
  function parseArchive(text) {
    let data;
    try {
      data = JSON.parse(String(text || ''));
    } catch (_) {
      return { ok: false, error: 'bad' };
    }

    if (!data || typeof data !== 'object' || data.app !== 'noomium') {
      return { ok: false, error: 'bad' };
    }
    if (!Array.isArray(data.notes)) {
      return { ok: false, error: 'bad' };
    }

    const notes = [];
    for (const raw of data.notes) {
      const note = sanitizeNoteForArchive(raw);
      if (note) notes.push(note);
    }

    const config = {};
    if (data.config && typeof data.config === 'object') {
      CONFIG_WHITELIST.forEach(k => {
        if (k in data.config) config[k] = data.config[k];
      });
    }

    return {
      ok: true,
      archive: {
        version: typeof data.version === 'number' ? data.version : 1,
        pubkey: typeof data.pubkey === 'string' ? data.pubkey : null,
        ncryptsec: (typeof data.ncryptsec === 'string' && data.ncryptsec) ? data.ncryptsec : null,
        notes,
        config,
        noteCount: notes.length,
      },
    };
  }

  /**
   * Применить архив: upsert заметок по uid (LWW по syncTs/updatedAt),
   * мердж whitelisted-конфига. Каждая применённая заметка эмитится как
   * note:created → NetService публикует приватный канон.
   *
   * Ключ из архива НЕ применяется автоматически (для этого нужен пароль —
   * оркестрация в AccountView: enterKey → importArchive).
   *
   * @param {Object} archive - Архив из parseArchive.
   * @returns {Promise<number>} Число применённых заметок.
   */
  async function importArchive(archive) {
    if (!archive || !Array.isArray(archive.notes)) return 0;

    let applied = 0;

    for (const note of archive.notes) {
      try {
        const cur = await DB.get(note.id);

        if (cur) {
          const curTs = cur.syncTs || cur.updatedAt || 0;
          const newTs = note.syncTs || note.updatedAt || 0;
          if (newTs <= curTs) continue;
        }

        await DB.put({
          id: note.id,
          text: note.text,
          vector: note.vector,
          shared: note.shared,
          parentId: note.parentId,
          parentPubkey: null,
          authorPubkey: null,
          eventId: note.eventId,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt || note.createdAt,
          syncTs: note.syncTs || note.updatedAt || note.createdAt,
        });

        // Канон должен узнать об этой заметке (слушатель NetService).
        try { bus.emit('note:created', note); } catch (_) {}

        applied++;
      } catch (e) {
        Logger.warn('Account: import note ' + note.id, String(e && e.message || e));
      }
    }

    // Whitelisted-конфиг из архива.
    const cfg = archive.config || {};
    let cfgChanged = false;
    CONFIG_WHITELIST.forEach(k => {
      if (k in cfg) {
        Config.set(k, cfg[k]);
        cfgChanged = true;
      }
    });

    if (cfgChanged) {
      try { bus.emit('config:imported', { keys: Object.keys(cfg) }); } catch (_) {}
    }

    Logger.info('Account: импортировано заметок — ' + applied);
    return applied;
  }

  /**
   * Переключить синхронизацию (канон 30078). Эмитит sync:toggle —
   * NetService переконфигурирует подписку и запустит backsweep при включении.
   * @param {boolean} enabled
   */
  function setSyncEnabled(enabled) {
    const v = enabled === true;
    Config.set('syncEnabled', v);
    try { bus.emit('sync:toggle', { enabled: v }); } catch (_) {}
  }

  return {
    getAccountInfo,
    getNpub,
    canWrapKey,
    getWrappedKey,
    enterKey,
    exportArchive,
    parseArchive,
    importArchive,
    setSyncEnabled,
  };
}, ['Config', 'Nostr', 'Crypto', 'DB', 'EventBus', 'Logger']);
// ─── DOMAIN/Account ─── END ─────────────────────────────────────────────────

// ─── DOMAIN/NoteActions ─── START ───────────────────────────────────────────
/**
 * UI-действия над заметками: удаление, переключение видимости, копирование.
 * Модуль не содержит бизнес-логики — только связывает UI с DOMAIN/Notes.
 */
DI.register('NoteActions', function (Notes, Modal, Toast, I18n) {
  /**
   * Удаление заметки с подтверждением.
   * @param {string} id - uid заметки.
   */
  function remove(id) {
    if (!id) return;

    Modal.confirm(I18n.t('btn.del'), I18n.t('del.confirm'), () => {
      Notes.remove(id).then(() => {
        Toast.show('ok', I18n.t('toast.deleted'));
      }).catch(() => {
        Toast.show('err', I18n.t('toast.copy.fail'));
      });
    });
  }

  /**
   * Переключение видимости: личное ↔ мир.
   * @param {string} id - uid заметки.
   */
  function toggle(id) {
    if (!id) return;

    Notes.toggleShared(id).then(note => {
      if (!note) return;
      Toast.show('ok', I18n.t(note.shared ? 'toast.saved.public' : 'toast.saved.private'));
    }).catch(() => {
      Toast.show('err', I18n.t('toast.copy.fail'));
    });
  }

  /**
   * Копирование текста в буфер обмена.
   * Использует Clipboard API с fallback на document.execCommand.
   * @param {string} text - Текст для копирования.
   */
  function copy(text) {
    const done = () => Toast.show('ok', I18n.t('toast.copied'));
    const fail = () => Toast.show('err', I18n.t('toast.copy.fail'));

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text || '').then(done).catch(fail);
    } else {
      try {
        const ta = document.createElement('textarea');
        ta.value = text || '';
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (_) {
        fail();
      }
    }
  }

  return { remove, toggle, copy };
}, ['Notes', 'Modal', 'Toast', 'I18n']);
// ─── DOMAIN/NoteActions ─── END ─────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: UI — компоненты интерфейса
// ═══════════════════════════════════════════════════════════════════════════════

// ─── UI/Modal ─── START ─────────────────────────────────────────────────────
/**
 * Универсальная система модальных окон.
 * Поддерживает: текстовые body, DOM-элементы, кнопки с primary/danger
 * модификаторами.
 *
 * Доступность:
 * - Закрытие по Escape
 * - Закрытие по клику на overlay
 * - Возврат фокуса на элемент, открывший модалку
 * - Автофокус на первый интерактивный элемент
 */
DI.register('Modal', function (I18n) {
  let overlay, modal, titleEl, bodyEl, footEl, closeBtn;
  let escHandler = null;
  let lastFocus = null;

  /** Ленивая привязка к DOM (однократно). */
  function bind() {
    if (overlay) return;

    overlay = document.getElementById('overlay');
    modal = document.getElementById('modal');
    titleEl = document.getElementById('modal-t');
    bodyEl = document.getElementById('modal-b');
    footEl = document.getElementById('modal-f');
    closeBtn = document.getElementById('modal-x');

    if (closeBtn) closeBtn.addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
    });
  }

  /**
   * Открыть модальное окно.
   * @param {Object} opts - Параметры модалки.
   * @param {string} [opts.title] - Заголовок.
   * @param {string|Element} [opts.body] - Тело: строка или DOM-элемент.
   * @param {Array<{text: string, primary?: boolean, danger?: boolean, onClick: Function}>} [opts.buttons] - Кнопки футера.
   */
  function open(opts) {
    bind();
    if (!overlay) return;

    opts = opts || {};
    lastFocus = document.activeElement;

    if (titleEl) titleEl.textContent = opts.title || '';

    if (bodyEl) {
      bodyEl.innerHTML = '';

      if (opts.body) {
        if (typeof opts.body === 'string') {
          bodyEl.textContent = opts.body;
        } else {
          bodyEl.appendChild(opts.body);
        }
      }
    }

    if (footEl) {
      footEl.innerHTML = '';

      (opts.buttons || []).forEach(b => {
        const btn = document.createElement('button');
        btn.className = 'mbtn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
        btn.textContent = b.text || 'OK';
        btn.addEventListener('click', () => {
          if (b.onClick) b.onClick();
        });
        footEl.appendChild(btn);
      });
    }

    overlay.classList.add('on');

    if (escHandler) document.removeEventListener('keydown', escHandler);
    escHandler = e => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', escHandler);

    // Автофокус на первый интерактивный элемент после анимации появления
    setTimeout(() => {
      if (!modal) return;
      const focusable = modal.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length) focusable[0].focus();
    }, 50);
  }

  /** Закрыть модальное окно. */
  function close() {
    if (!overlay) return;

    overlay.classList.remove('on');

    if (escHandler) {
      document.removeEventListener('keydown', escHandler);
      escHandler = null;
    }

    // Возврат фокуса на элемент, открывший модалку
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (_) {}
    }
  }

  /**
   * Модальное окно подтверждения (2 кнопки: Отмена / OK).
   * @param {string} title - Заголовок.
   * @param {string} text - Текст.
   * @param {Function} onOk - Колбэк подтверждения.
   * @param {string} [okText] - Текст кнопки OK (по умолчанию 'OK').
   */
  function confirm(title, text, onOk, okText) {
    open({
      title,
      body: text,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: close },
        {
          text: okText || 'OK',
          primary: true,
          danger: true,
          onClick: () => {
            close();
            if (onOk) onOk();
          },
        },
      ],
    });
  }

  return { open, close, confirm };
}, ['I18n']);
// ─── UI/Modal ─── END ───────────────────────────────────────────────────────

// ─── UI/Toast ─── START ─────────────────────────────────────────────────────
/**
 * Всплывающие уведомления (тосты).
 * - Держит не более `toastMaxVisible` уведомлений, старые вытесняет
 * - Haptic feedback для Telegram Mini Apps (если доступен)
 * - Автоудаление после `toastDefaultDuration` мс
 *
 * Типы: ok (зелёный), err (розовый), warn (янтарный), info (бирюзовый).
 * Иконка — span.t-ic, цвета через классы .toast.ok/.err/.warn/.info
 * (style.css, секция 12) — инлайн-стили v0.6 вынесены в CSS.
 */
DI.register('Toast', function (Config) {
  /** @type {Object<string, string>} */
  const ICONS = { ok: '✓', err: '✕', warn: '!', info: '◆' };

  /** @type {HTMLElement|null} */
  let container = null;

  /**
   * Отправка haptic feedback через TelegramAdapter, если приложение
   * запущено внутри Telegram. Безопасно: если TelegramAdapter не загружен
   * или DI.resolve падает, ничего не происходит.
   * @param {'ok'|'err'|'warn'|'info'} type - Тип уведомления.
   */
  function haptic(type) {
    try {
      const tg = DI.resolve('TelegramAdapter');
      if (tg && tg.isTelegram()) {
        if (type === 'ok') tg.hapticFeedback('success');
        else if (type === 'err') tg.hapticFeedback('error');
        else tg.hapticFeedback('light');
      }
    } catch (_) {}
  }

  /**
   * Показать тост.
   * @param {'ok'|'err'|'warn'|'info'} type - Тип уведомления.
   * @param {string} msg - Текст сообщения.
   * @param {number} [ms] - Длительность показа (по умолчанию из Config).
   */
  function show(type, msg, ms) {
    if (!container) container = document.getElementById('toasts');
    if (!container) return;

    const cls = ICONS[type] ? type : 'info';
    haptic(type);

    const el = document.createElement('div');
    el.className = 'toast ' + cls;

    const ic = document.createElement('span');
    ic.className = 't-ic';
    ic.textContent = ICONS[cls];

    const m = document.createElement('span');
    m.textContent = String(msg || '');

    el.appendChild(ic);
    el.appendChild(m);
    container.appendChild(el);

    // Лимит количества видимых тостов: вытесняем старые
    const limit = Config.get('toastMaxVisible', 3);
    while (container.children.length > limit) {
      container.removeChild(container.firstChild);
    }

    // Анимация исчезновения и удаление из DOM
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';

      setTimeout(() => {
        try { el.remove(); } catch (_) {}
      }, 260);
    }, ms || Config.get('toastDefaultDuration', 2200));
  }

  return { show };
}, ['Config']);
// ─── UI/Toast ─── END ───────────────────────────────────────────────────────

// ─── UI/Progress ─── START ──────────────────────────────────────────────────
/**
 * Полноэкранный оверлей прогресса загрузки модели.
 *
 * Логика показа:
 * - Показывается только если загрузка длится дольше SHOW_DELAY (500мс)
 * - Это предотвращает мелькание при быстром кэшированном запуске
 * - Скрывается автоматически при переходе в режим 'model' или 'demo'
 *
 * События:
 * - 'ai:progress' — обновление прогресс-бара (pct, loadedMB, totalMB, model)
 * - 'ai:status' — смена режима (loading/model/demo)
 */
DI.register('Progress', function (bus) {
  let overlay, fill, pctEl, infoEl;
  let showTimer = null;
  const SHOW_DELAY = 500;

  /** Привязка к DOM. */
  function bind() {
    overlay = document.getElementById('progress');
    fill = document.getElementById('prog-fill');
    pctEl = document.getElementById('prog-pct');
    infoEl = document.getElementById('prog-info');
  }

  /** Показать оверлей. */
  function show() {
    if (overlay) overlay.classList.add('on');
  }

  /** Скрыть оверлей. */
  function hide() {
    if (overlay) overlay.classList.remove('on');
  }

  /**
   * Обновление прогресс-бара и подписей.
   * @param {Object} data - {pct|percent, loadedMB, totalMB, model}.
   */
  function update(data) {
    if (!data) return;

    const p = Math.max(0, Math.min(100, Math.round(data.pct || data.percent || 0)));

    if (fill) {
      fill.style.width = p + '%';
    }

    if (pctEl) {
      let text = p + '%';

      if (data.loadedMB) {
        text = data.loadedMB + ' MB';
        if (data.totalMB) text += ' / ' + data.totalMB + ' MB';
      }

      pctEl.textContent = text;
    }

    if (infoEl && data.model) {
      infoEl.textContent = data.model;
    }
  }

  /**
   * Инициализация: подписки на события эмбеддера.
   */
  function init() {
    bind();

    bus.on('ai:progress', e => update(e));

    bus.on('ai:status', e => {
      if (!e) return;

      if (e.mode === 'loading') {
        update(e);

        // Показываем прогресс только если загрузка затянулась
        if (!showTimer && overlay && !overlay.classList.contains('on')) {
          showTimer = setTimeout(() => {
            show();
            showTimer = null;
          }, SHOW_DELAY);
        }
      } else {
        // Загрузка завершена (успех или fallback): скрываем
        if (showTimer) {
          clearTimeout(showTimer);
          showTimer = null;
        }
        hide();
      }
    });
  }

  return { init, show, hide, update };
}, ['EventBus']);
// ─── UI/Progress ─── END ────────────────────────────────────────────────────

// ─── UI/HeaderStatus ─── START ──────────────────────────────────────────────
/**
 * Индикаторы состояния в шапке: сеть (NetService) и ИИ (Embedder).
 *
 * Состояния сети:
 * - disconnected (серый): не запущен
 * - connecting (пульсирующий): попытка соединения
 * - connected (зелёный): подписка активна
 * - reconnecting (янтарный): пересоединение
 * - failed (розовый): ошибка инициализации / офлайн
 *
 * Состояния ИИ:
 * - loading (пульсирующий): загрузка модели
 * - model (зелёный): модель готова
 * - demo (янтарный): fallback на hash-эмбеддинг
 *
 * Фичи:
 * - Клик по тексту статуса сети запускает stop/start цикл переподключения.
 * - Офлайн-бар: показывается при net:status=failed + navigator.onLine=false,
 *   скрывается при любом другом статусе (фикс #5 — в v0.6 разметка была мёртвой).
 */
DI.register('HeaderStatus', function (bus, I18n, Embedder) {
  let netDot, netTxt, aiDot, aiTxt, offlineBar;
  let unsubs = [];
  let currentNetStatus = 'disconnected';
  let currentAiMode = 'loading';
  let currentAiPercent = 0;

  /** Привязка к DOM. */
  function bind() {
    netDot = document.getElementById('st-net-dot');
    netTxt = document.getElementById('st-net-txt');
    aiDot = document.getElementById('st-ai-dot');
    aiTxt = document.getElementById('st-ai-txt');
    offlineBar = document.getElementById('offline-bar');
  }

  /**
   * Обновление индикатора ИИ.
   * @param {'loading'|'model'|'demo'} mode - Режим эмбеддера.
   * @param {number} [percent] - Прогресс загрузки (0–100).
   */
  function setAI(mode, percent) {
    currentAiMode = mode;
    currentAiPercent = percent || 0;

    if (!aiDot || !aiTxt) return;

    if (mode === 'model') {
      aiDot.className = 'dot ok';
      aiTxt.textContent = I18n.t('st.ai.ready');
    } else if (mode === 'demo') {
      aiDot.className = 'dot warn';
      aiTxt.textContent = I18n.t('st.ai.demo');
    } else {
      aiDot.className = 'dot load';
      aiTxt.textContent = I18n.t('st.ai.loading') + (currentAiPercent ? ' ' + Math.round(currentAiPercent) + '%' : '');
    }
  }

  /**
   * Обновление индикатора сети + офлайн-бара.
   * @param {string} status - Состояние сети.
   */
  function setNet(status) {
    currentNetStatus = status;

    if (!netDot || !netTxt) return;

    const map = {
      connected: ['ok', 'st.net.online'],
      connecting: ['load', 'st.net.connecting'],
      reconnecting: ['warn', 'st.net.reconnecting'],
      failed: ['err', 'st.net.failed'],
      disconnected: ['', 'st.net'],
    };

    const [cls, key] = map[status] || ['', 'st.net'];
    netDot.className = 'dot' + (cls ? ' ' + cls : '');
    netTxt.textContent = I18n.t(key);

    // Офлайн-бар: только реальный офлайн браузера. «Нет сети» из-за упавших
    // релеев — не повод пугать пользователя офлайн-баннером.
    if (offlineBar) {
      const offline = status === 'failed' && typeof navigator !== 'undefined' && navigator.onLine === false;
      offlineBar.classList.toggle('on', offline);
    }
  }

  /**
   * Инициализация: интерактивный статус, подписки, начальное состояние.
   */
  function init() {
    bind();

    // Интерактивный статус сети: клик запускает переподключение
    if (netTxt) {
      netTxt.style.cursor = 'pointer';
      netTxt.addEventListener('click', () => {
        try {
          const NetService = DI.resolve('NetService');
          if (NetService) {
            NetService.stop(false);
            setTimeout(() => NetService.start(), 500);
          }
        } catch (_) {}
      });
    }

    // Офлайн-бар реагирует и на браузерные события (мгновенно),
    // и на статусы сети (истина после online-листенера NetService).
    window.addEventListener('offline', () => setNet('failed'));
    window.addEventListener('online', () => {
      // NetService поднимет статус через подписку; здесь только бар.
      if (offlineBar) offlineBar.classList.remove('on');
    });

    // Подписки на изменения состояния
    unsubs.push(bus.on('ai:status', e => setAI(e.mode, e.percent)));
    unsubs.push(bus.on('net:status', e => setNet(e.status)));

    // Обновление при смене языка
    unsubs.push(bus.on('i18n:change', () => {
      setAI(currentAiMode, currentAiPercent);
      setNet(currentNetStatus);
    }));

    // Начальное состояние
    setAI(Embedder.getMode());
    setNet('disconnected');
  }

  /** Отписка от всех подписок. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy };
}, ['EventBus', 'I18n', 'Embedder']);
// ─── UI/HeaderStatus ─── END ────────────────────────────────────────────────

// ─── UI/Onboarding ─── START ────────────────────────────────────────────────
/**
 * Онбординг: первый запуск показывает объяснение механик приложения.
 * Пользователь может отключить показ флажком "Больше не показывать".
 *
 * Восемь секций: что это, лента, пин, дрейф, режимы, ключ и устройства
 * (новая — про аккаунт и синхронизацию), резонанс, удаление.
 */
DI.register('Onboarding', function (Config, Modal, I18n, Embedder) {
  /**
   * Построение тела модалки онбординга.
   * @param {boolean} firstRun - Если true, показывает флажок "Больше не показывать".
   * @returns {{el: Element, checkbox: HTMLInputElement|null}}
   */
  function buildBody(firstRun) {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;gap:14px;';

    const sections = [
      ['◇ ' + I18n.t('onb.what.t'), I18n.t('onb.what.d')],
      ['▤ ' + I18n.t('onb.stream.t'), I18n.t('onb.stream.d')],
      ['◈ ' + I18n.t('onb.pin.t'), I18n.t('onb.pin.d')],
      ['∿ ' + I18n.t('onb.drift.t'), I18n.t('onb.drift.d')],
      ['⌘ ' + I18n.t('onb.modes.t'), I18n.t('onb.modes.d')],
      ['⚿ ' + I18n.t('onb.key.t'), I18n.t('onb.key.d')],
      ['◆ ' + I18n.t('onb.resonance.t'), I18n.t('onb.resonance.d')],
      ['🗑 ' + I18n.t('onb.delete.t'), I18n.t('onb.delete.d')],
    ];

    sections.forEach(([title, desc]) => {
      const s = document.createElement('div');
      const t = document.createElement('div');
      t.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:3px;';
      t.textContent = title;

      const d = document.createElement('div');
      d.style.cssText = 'font-size:13px;color:var(--text-2);line-height:1.5;';
      d.textContent = desc;

      s.appendChild(t);
      s.appendChild(d);
      el.appendChild(s);
    });

    let checkbox = null;

    if (firstRun) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer;margin-top:4px;';

      checkbox = document.createElement('input');
      checkbox.type = 'checkbox';

      label.appendChild(checkbox);

      const span = document.createElement('span');
      span.textContent = I18n.t('onb.dontshow');
      label.appendChild(span);

      el.appendChild(label);
    }

    return { el, checkbox };
  }

  /**
   * Показать модалку «Как это работает».
   * @param {boolean} [firstRun] - Режим первого запуска (с флажком).
   */
  function showHelp(firstRun) {
    const { el, checkbox } = buildBody(!!firstRun);

    Modal.open({
      title: I18n.t('onb.title'),
      body: el,
      buttons: [{
        text: I18n.t('onb.gotit'),
        primary: true,
        onClick: () => {
          if (firstRun && checkbox && checkbox.checked) {
            Config.set('onboarded', true);
          }
          Modal.close();
        },
      }],
    });
  }

  /**
   * Инициализация: показать онбординг при первом запуске.
   * Ждёт загрузки модели, чтобы не перекрывать прогресс-бар.
   */
  function init() {
    if (Config.get('onboarded', false)) return;

    // Ждём загрузки модели, чтобы онбординг не перекрывал прогресс-бар
    Embedder.load().then(() => {
      showHelp(true);
    });
  }

  return { init, showHelp };
}, ['Config', 'Modal', 'I18n', 'Embedder']);
// ─── UI/Onboarding ─── END ──────────────────────────────────────────────────

// ─── UI/Composer ─── START ──────────────────────────────────────────────────
/**
 * Композер: поле ввода, счётчик символов, переключатель Личное/Мир, отправка.
 *
 * Лимиты длины поста (из Config):
 * - softLimit: жёлтая подсветка, подсказка «пиши короче»
 * - hardLimit: красная подсветка, подсказка «вектор обрезается»
 * - maxPostLength: блокировка ввода через maxlength + блокировка кнопки
 *
 * Подсказка лимитов — элемент #ed-hint с классами .warn/.err
 * (style.css, секция 9).
 *
 * Обработка виртуальной клавиатуры:
 * При открытии клавиатуры сжимаем #app до видимой области через
 * VisualViewport API, чтобы композер оставался в потоке.
 *
 * Отличия от v0.6:
 * - удалён мёртвый канал note:edit-request и режим редактирования
 *   (правка живёт в NoteView со своим редактором);
 * - ФИКС модели v0.7: parentId = pin.id (uid своей заметки или eventId
 *   чужой). В v0.6 передавался pin.eventId || pin.id — для опубликованной
 *   своей заметки это eventId, что противоречит uid-модели: после unshare
 *   родителя (сброс eventId) дети оставались сиротами. pin.id всегда
 *   стабилен; NetService сам резолвит uid → eventId при публикации
 *   проекции (buildNoteEvent).
 */
DI.register('Composer', function (Context, Notes, Store, I18n, bus, Toast, Utils, Config) {
  let ta, cnt, sendBtn, toggle;
  let sending = false;
  let unsubs = [];
  let vvCleanup = null;

  // SVG-иконка отправки (paper plane). Единый источник — совпадает с HTML.
  const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';

  /**
   * Обновление счётчика символов, подсветки и состояния кнопки отправки.
   */
  function updateCounter() {
    if (!cnt || !ta) return;

    const len = ta.value.length;
    const max = Config.get('maxPostLength', 2500);
    const soft = Config.get('softLimit', 1200);
    const hard = Config.get('hardLimit', 2000);

    cnt.textContent = Utils.word('symbols', len, I18n.getLang());

    let color = 'var(--text-3)';
    let hint = null;
    let hintLevel = null;

    if (len >= max) {
      color = 'var(--rose)';
      hint = I18n.t('ed.limit.max', { max });
      hintLevel = 'err';
    } else if (len >= hard) {
      color = 'var(--rose)';
      hint = I18n.t('ed.limit.hard');
      hintLevel = 'err';
    } else if (len >= soft) {
      color = 'var(--amber)';
      hint = I18n.t('ed.limit.soft');
      hintLevel = 'warn';
    }

    cnt.style.color = color;
    updateHint(hint, hintLevel);

    if (sendBtn) {
      sendBtn.disabled = len >= max || sending;
    }
  }

  /**
   * Показ/скрытие/обновление подсказки лимитов (#ed-hint).
   * Класс warn — янтарная, err — розовая (style.css, секция 9).
   * @param {string|null} text - Текст подсказки или null для скрытия.
   * @param {'warn'|'err'|null} [level] - Уровень (цвет).
   */
  function updateHint(text, level) {
    let hintEl = document.getElementById('ed-hint');

    if (!text) {
      if (hintEl) hintEl.remove();
      return;
    }

    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.id = 'ed-hint';
      cnt.parentNode.insertBefore(hintEl, cnt.nextSibling);
    }

    hintEl.textContent = text;
    hintEl.className = level === 'err' ? 'err' : 'warn';
  }

  /**
   * Отражение режима Личное/Мир в DOM тумблера.
   * @param {string} mode - 'private' | 'world'.
   */
  function reflectMode(mode) {
    if (!toggle) return;
    toggle.setAttribute('data-mode', mode);
    toggle.querySelectorAll('.mt-opt').forEach(o =>
      o.classList.toggle('on', o.getAttribute('data-v') === mode)
    );
  }

  /**
   * Переключение кнопки отправки в состояние «отправляется» и обратно.
   * @param {boolean} on - true — отправка идёт.
   */
  function setSendingUI(on) {
    if (!sendBtn) return;
    sendBtn.disabled = on;
    sendBtn.classList.toggle('sending', on);

    if (on) {
      sendBtn.innerHTML = '<span style="font-size:16px;line-height:1;display:block;">…</span>';
    } else {
      sendBtn.innerHTML = SEND_SVG;
    }
  }

  /**
   * Отправка: создание заметки.
   * parentId = pin.id: uid своей закреплённой заметки или eventId чужой
   * (модель v0.7 — см. докстринг модуля).
   */
  function send() {
    if (sending) return;

    const text = ta.value.trim();
    if (!text) {
      Toast.show('warn', I18n.t('toast.empty'));
      return;
    }

    const max = Config.get('maxPostLength', 2500);
    if (text.length > max) {
      Toast.show('err', I18n.t('ed.limit.max', { max }));
      return;
    }

    const mode = Store.get('sendMode');
    sending = true;
    setSendingUI(true);

    const finish = () => {
      sending = false;
      setSendingUI(false);
      ta.value = '';
      ta.style.height = 'auto';
      Context.setInput('');
      updateCounter();
    };

    const pin = Context.getPin();
    const parentId = pin ? pin.id : null;

    Notes.create(text, mode, parentId)
      .then(note => {
        Toast.show('ok', I18n.t(mode === 'world' ? 'toast.saved.public' : 'toast.saved.private')
          + (note && note.parentId ? ' · ' + I18n.t('inf.linked') : ''));
        try { bus.emit('editor:sent'); } catch (_) {}
        finish();
      })
      .catch(e => {
        Toast.show('err', String(e && e.message || e));
        sending = false;
        setSendingUI(false);
      });
  }

  /**
   * Обработка виртуальной клавиатуры через VisualViewport API.
   * При открытии клавиатуры сжимаем #app до видимой области,
   * чтобы композер оставался в потоке, а лента корректно скроллилась.
   */
  function setupKeyboardHandler() {
    if (!window.visualViewport) return;

    const vv = window.visualViewport;

    const onResize = () => {
      const app = document.getElementById('app');
      if (!app) return;

      const keyboardHeight = window.innerHeight - vv.height;

      if (keyboardHeight > 100) {
        app.style.height = vv.height + 'px';
        app.style.maxHeight = vv.height + 'px';
      } else {
        app.style.height = '';
        app.style.maxHeight = '';
      }
    };

    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);

    vvCleanup = () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }

  /**
   * Инициализация: привязка DOM, слушатели, подписки.
   */
  function init() {
    ta = document.getElementById('ed-ta');
    cnt = document.getElementById('ed-cnt');
    sendBtn = document.getElementById('btn-send');
    toggle = document.getElementById('mode-toggle');

    if (!ta) return;

    // Блокировка ввода на уровне браузера
    ta.setAttribute('maxlength', Config.get('maxPostLength', 2500));

    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';

      updateCounter();
      Context.setInput(ta.value);
    });

    setupKeyboardHandler();

    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });

    if (sendBtn) sendBtn.addEventListener('click', send);

    if (toggle) {
      toggle.addEventListener('click', e => {
        const opt = e.target.closest('.mt-opt');
        if (opt && opt.getAttribute('data-v')) {
          Store.setState({ sendMode: opt.getAttribute('data-v') });
        }
      });
    }

    unsubs.push(Store.subscribe(s => s.sendMode, reflectMode));

    unsubs.push(bus.on('i18n:change', () => {
      updateCounter();
      reflectMode(Store.get('sendMode'));
    }));

    reflectMode(Store.get('sendMode'));
    updateCounter();
  }

  /** Отписки и очистка VisualViewport-листенеров. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];

    if (vvCleanup) {
      try { vvCleanup(); } catch (_) {}
      vvCleanup = null;
    }
  }

  return { init, destroy, send };
}, ['Context', 'Notes', 'Store', 'I18n', 'EventBus', 'Toast', 'Utils', 'Config']);
// ─── UI/Composer ─── END ────────────────────────────────────────────────────

// ─── UI/FeedView ─── START ──────────────────────────────────────────────────
/**
 * Рендеринг ленты заметок.
 *
 * Три режима отображения:
 * 1. Без контекста: хронологический поток (все заметки)
 * 2. Пин: все релевантные + озарения, отсортированные по убыванию скора
 * 3. Ввод/дрейф: заметки из активного сегмента (Моё / Мир / Озарения)
 *
 * Карточка заметки содержит:
 * - Текст
 * - Тег (лично/открыто или сокращённый pubkey автора)
 * - Кнопку «↳ по мотивам» (если есть parentId)
 * - Кнопку «◆ резонанс» (если есть потомки)
 * - Индикатор сходства (сигнал или проценты)
 * - Дату
 * - Кнопку «✎ открыть» (только для своих заметок)
 *
 * Отличие от v0.6: обрезка текста в модалках предков/потомков —
 * по Config.truncateTextLength (было захардкожено 140).
 */
DI.register('FeedView', function (Store, Context, I18n, Utils, Config, bus, Influence, Provenance, Modal, NetService) {
  let feedEl, emptyEl, emptyT, segBar, ctxBanner, ctxSrc, ctxTxt, ctxX;
  let cLocal, cWorld, cSeren, histBtn;
  let unsubs = [];
  let rafPending = false;

  /** Привязка к DOM. */
  function bind() {
    feedEl = document.getElementById('feed');
    emptyEl = document.getElementById('feed-empty');
    emptyT = document.getElementById('feed-empty-t');
    segBar = document.getElementById('seg');
    ctxBanner = document.getElementById('ctx-banner');
    ctxSrc = document.getElementById('ctx-src');
    ctxTxt = document.getElementById('ctx-txt');
    ctxX = document.getElementById('ctx-x');
    cLocal = document.getElementById('c-local');
    cWorld = document.getElementById('c-world');
    cSeren = document.getElementById('c-seren');
    histBtn = document.getElementById('btn-history');
  }

  /** Коалесценция рендеров через requestAnimationFrame. */
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  /**
   * @param {Object} n - Заметка.
   * @returns {boolean} Является ли заметка закреплённой.
   */
  function isPinned(n) {
    const ctx = Store.get('context');
    return ctx.source === 'pin' && ctx.noteId === n.id;
  }

  /**
   * Клик по карточке: повторный клик по закреплённой — снять пин,
   * иначе — закрепить (если есть вектор).
   * @param {Object} n - Заметка.
   */
  function onNoteClick(n) {
    const ctx = Store.get('context');

    if ((ctx.source === 'pin' || ctx.source === 'drift') && ctx.noteId === n.id) {
      Context.clearPin();
      return;
    }

    if (n.vector) Context.setPin(n);
  }

  /**
   * Модалка «Потомки»: список заметок, порождённых данной.
   * @param {Array<Object>} children - Прямые и непрямые потомки.
   */
  function renderChildrenModal(children) {
    const truncate = Config.get('truncateTextLength', 140);
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    if (!children.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-3);font-size:13px;text-align:center;padding:12px;';
      empty.textContent = I18n.t('inf.nochildren');
      body.appendChild(empty);
    } else {
      children.forEach(c => {
        const item = document.createElement('button');
        item.className = 'nv-act';
        item.style.cssText = 'text-align:left;justify-content:flex-start;white-space:normal;height:auto;min-height:40px;width:100%;';
        item.textContent = (c.text || '').slice(0, truncate);

        item.addEventListener('click', () => {
          Modal.close();
          try { bus.emit('note:open', { id: c.id }); } catch (_) {}
        });

        body.appendChild(item);
      });
    }

    Modal.open({
      title: I18n.t('inf.children') + (children.length ? ' · ' + children.length : ''),
      body: body,
      buttons: [{ text: I18n.t('btn.close'), onClick: () => Modal.close() }],
    });
  }

  /**
   * Открыть модалку потомков заметки (по uid и eventId).
   * @param {Object} note - Заметка.
   */
  function showChildren(note) {
    const ids = [note.id];
    if (note.eventId) ids.push(note.eventId);

    Promise.all(ids.map(id => Provenance.children(id))).then(results => {
      const seenIds = new Set();
      const children = [];

      results.forEach(list => {
        (list || []).forEach(c => {
          if (c && !seenIds.has(c.id)) {
            seenIds.add(c.id);
            children.push(c);
          }
        });
      });

      renderChildrenModal(children);
    }).catch(() => {});
  }

  /**
   * Модалка «Линейка по мотивам»: цепочка предков с отступами.
   * @param {Object} note - Заметка.
   * @param {Array<Object>} chain - Цепочка предков.
   */
  function renderAncestorsModal(note, chain) {
    const truncate = Config.get('truncateTextLength', 140);
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    if (!chain.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-3);font-size:13px;text-align:center;padding:12px;';
      empty.textContent = I18n.t('inf.noancestors');
      body.appendChild(empty);
    } else {
      chain.forEach((c, i) => {
        const item = document.createElement('button');
        item.className = 'nv-act';
        item.style.cssText = 'text-align:left;justify-content:flex-start;white-space:normal;height:auto;min-height:40px;width:100%;';
        item.style.paddingLeft = (16 + i * 14) + 'px';
        item.textContent = '↳ ' + (c.text || '').slice(0, truncate);

        item.addEventListener('click', () => {
          Modal.close();
          try { bus.emit('note:open', { id: c.id }); } catch (_) {}
        });

        body.appendChild(item);
      });
    }

    Modal.open({
      title: I18n.t('inf.lineage') + (chain.length ? ' · ' + chain.length : ''),
      body: body,
      buttons: [{ text: I18n.t('btn.close'), onClick: () => Modal.close() }],
    });
  }

  /**
   * Открыть модалку предков заметки.
   * @param {Object} note - Заметка.
   */
  function showAncestors(note) {
    Provenance.ancestors(note.id).then(chain => {
      renderAncestorsModal(note, chain);
    }).catch(() => {});
  }

  /**
   * Создать разделитель мета-блока.
   * @returns {HTMLSpanElement}
   */
  function createSep() {
    const sep = document.createElement('span');
    sep.className = 'note-meta-sep';
    return sep;
  }

  /**
   * Рендеринг одной карточки заметки.
   * @param {Object} n - Заметка.
   * @param {boolean} isRanked - Показывать ли индикатор сходства.
   * @param {number} i - Индекс для анимации появления.
   * @returns {HTMLDivElement}
   */
  function card(n, isRanked, i) {
    const el = document.createElement('div');
    el.className = 'note' + (isPinned(n) ? ' pinned' : '');
    el.style.animationDelay = Math.min(i * 25, 300) + 'ms';
    el.dataset.id = n.id;

    const txt = document.createElement('div');
    txt.className = 'note-txt';
    txt.textContent = n.text || '';
    el.appendChild(txt);

    const meta = document.createElement('div');
    meta.className = 'note-meta';

    // Тег: лично/открыто для своих, «· pubkey» для чужих
    const tag = document.createElement('span');
    if (n.own) {
      tag.className = 'note-tag ' + (n.shared ? 'world' : 'priv');
      tag.textContent = n.shared ? I18n.t('base.tag.shared') : I18n.t('base.tag.private');
    } else {
      tag.className = 'note-tag world';
      tag.textContent = '· ' + Utils.shortPk(n.authorPubkey || '');
    }
    meta.appendChild(tag);

    const hasNav = !!n.parentId;
    const res = Influence.resonance(n.id) + Influence.resonance(n.eventId);
    const hasResonance = res > 0;

    if (hasNav || hasResonance) {
      meta.appendChild(createSep());

      // Кнопка «↳ по мотивам»
      if (n.parentId) {
        const link = document.createElement('button');
        link.className = 'note-parent';
        link.textContent = '↳';
        link.title = I18n.t('inf.lineage');
        link.setAttribute('aria-label', I18n.t('inf.openparent'));

        Provenance.ancestors(n.id).then(chain => {
          if (!chain.length) {
            link.classList.add('orphan');
            link.title = I18n.t('inf.orphan.hint');
          } else {
            link.addEventListener('click', e => {
              e.stopPropagation();
              showAncestors(n);
            });
          }
        }).catch(() => {});

        meta.appendChild(link);
      }

      // Кнопка «◆ резонанс»
      if (hasResonance) {
        const r = document.createElement('button');
        r.className = 'note-sim';
        r.textContent = '◆' + res;
        r.title = I18n.t('inf.resonance');
        r.setAttribute('aria-label', I18n.t('inf.resonance'));

        r.addEventListener('click', e => {
          e.stopPropagation();
          showChildren(n);
        });

        meta.appendChild(r);
      }
    }

    meta.appendChild(createSep());

    // Индикатор сходства (сигнал или проценты)
    if (isRanked && typeof n.score === 'number') {
      const threshold = Config.get('threshold', 0.81);
      const serendipity = Config.get('serendipity', 0.07);
      // Середина диапазона озарений: делит на «сильные» и «слабые»
      const serenMid = threshold - serendipity / 2;
      const displayMode = Config.get('similarityDisplay', 'signal');
      const pct = Math.round(n.score * 100);

      const sim = document.createElement('span');
      sim.className = 'note-sim-info';

      if (displayMode === 'percent') {
        // Режим отладки: сырые проценты
        sim.textContent = pct + '%';
        sim.title = I18n.t('sim.score');
      } else {
        // Режим сигнала: палочки + текстовая метка
        if (n.score >= threshold) {
          // ▰▰▰ В тему
          sim.innerHTML = '<span class="sig-bar sig-full"></span><span class="sig-bar sig-full"></span><span class="sig-bar sig-full"></span>';
          sim.title = I18n.t('sim.level.high') + ' (' + pct + '%)';
        } else if (n.score >= serenMid) {
          // ▰▰▱ Озарение (сильная связь, верхняя половина диапазона)
          sim.innerHTML = '<span class="sig-bar sig-full"></span><span class="sig-bar sig-full"></span><span class="sig-bar sig-empty"></span>';
          sim.title = I18n.t('sim.level.mid') + ' (' + pct + '%)';
        } else {
          // ▰▱▱ Проблеск (слабая связь, нижняя половина диапазона)
          sim.innerHTML = '<span class="sig-bar sig-full"></span><span class="sig-bar sig-empty"></span><span class="sig-bar sig-empty"></span>';
          sim.title = I18n.t('sim.level.low') + ' (' + pct + '%)';
        }
        const label = document.createElement('span');
        label.className = 'sig-label';
        label.textContent = n.score >= threshold
          ? I18n.t('sim.level.high')
          : (n.score >= serenMid ? I18n.t('sim.level.mid') : I18n.t('sim.level.low'));
        sim.appendChild(label);
      }

      meta.appendChild(sim);
    }

    // Дата
    const date = document.createElement('span');
    date.className = 'note-date';
    date.textContent = Utils.fmtRelativeTime(n.createdAt, I18n.getLang(), I18n.t);
    meta.appendChild(date);

    // Кнопка «✎ открыть» (только для своих заметок)
    if (n.own) {
      const openBtn = document.createElement('button');
      openBtn.className = 'na';
      openBtn.textContent = '✎';
      openBtn.title = I18n.t('btn.open');
      openBtn.setAttribute('aria-label', I18n.t('btn.open'));

      openBtn.addEventListener('click', e => {
        e.stopPropagation();
        try { bus.emit('note:open', { id: n.id }); } catch (_) {}
      });

      meta.appendChild(openBtn);
    }

    el.appendChild(meta);
    el.addEventListener('click', () => onNoteClick(n));
    return el;
  }

  /**
   * Полный рендер ленты по текущему состоянию Store.
   */
  function render() {
    if (!feedEl) return;

    const state = Store.getState();
    const ctx = state.context;
    const isPinnedMode = ctx.source === 'pin';
    const isTyping = ctx.source === 'input';
    const isDrift = ctx.source === 'drift';
    const isRanked = isPinnedMode || isTyping || isDrift;

    segBar.classList.toggle('on', isTyping || isDrift);
    ctxBanner.classList.toggle('on', isPinnedMode || isDrift);

    if (isPinnedMode || isDrift) {
      ctxSrc.textContent = isDrift ? I18n.t('ctx.drift') : I18n.t('ctx.pinned');
      ctxTxt.textContent = isDrift ? (ctx.pinText || ctx.text) : ctx.text;
    }

    document.querySelectorAll('.seg-b').forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-k') === state.seg);
    });

    cLocal.textContent = state.lists.local.length;
    cWorld.textContent = state.lists.world.length;
    cSeren.textContent = state.lists.seren.length;

    let notes;

    if (isPinnedMode) {
      // Пин: все релевантные + озарения, по убыванию скора
      notes = [...state.lists.local, ...state.lists.world, ...state.lists.seren]
        .filter(n => n.id !== ctx.noteId)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
    } else if (isTyping || isDrift) {
      // Ввод/дрейф: заметки из активного сегмента
      notes = state.lists[state.seg] || [];
    } else {
      // Без контекста: хронологический поток
      notes = state.feed;
    }

    feedEl.innerHTML = '';

    if (!notes.length) {
      emptyEl.classList.add('on');

      emptyT.textContent = isPinnedMode
        ? I18n.t('empty.world.t')
        : ((isTyping || isDrift) ? I18n.t('empty.' + state.seg + '.t') : I18n.t('empty.local.t'));
    } else {
      emptyEl.classList.remove('on');

      const frag = document.createDocumentFragment();
      notes.forEach((n, i) => {
        frag.appendChild(card(n, isRanked, i));
      });
      feedEl.appendChild(frag);
    }
  }

  /**
   * Инициализация: привязка DOM, подписки, слушатели, первичный рендер.
   */
  function init() {
    bind();
    if (!feedEl) return;

    unsubs.push(Store.subscribe(s => s.context, scheduleRender, Store.shallowEqual));
    unsubs.push(Store.subscribe(s => s.lists, scheduleRender));
    unsubs.push(Store.subscribe(s => s.feed, scheduleRender));
    unsubs.push(Store.subscribe(s => s.seg, scheduleRender));
    unsubs.push(bus.on('i18n:change', scheduleRender));
    unsubs.push(bus.on('db:change', scheduleRender));
    unsubs.push(bus.on('db:cache', scheduleRender));
    unsubs.push(bus.on('influence:updated', scheduleRender));

    if (histBtn) {
      histBtn.addEventListener('click', () => NetService.loadHistory());

      unsubs.push(bus.on('net:history', e => {
        if (!histBtn) return;

        if (e && e.loading) {
          histBtn.disabled = true;
          histBtn.textContent = I18n.t('net.loading');
        } else {
          histBtn.disabled = false;
          histBtn.textContent = I18n.t('net.loadmore');
        }
      }));
    }

    document.querySelectorAll('.seg-b').forEach(b => {
      b.addEventListener('click', () => {
        Store.setState({ seg: b.getAttribute('data-k') });
      });
    });

    if (ctxX) {
      ctxX.addEventListener('click', () => Context.clearPin());
    }

    render();
  }

  /** Отписка от всех подписок. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, render };
}, ['Store', 'Context', 'I18n', 'Utils', 'Config', 'EventBus', 'Influence', 'Provenance', 'Modal', 'NetService']);
// ─── UI/FeedView ─── END ────────────────────────────────────────────────────

// ─── UI/BaseView ─── START ──────────────────────────────────────────────────
/**
 * Экран «База»: все локальные заметки пользователя.
 * - Статистика: всего / открыто / лично
 * - Текстовый поиск (дебаунс)
 * - Сортировка: новые / старые / а-я
 * - Клик по заметке → открывает NoteView
 */
DI.register('BaseView', function (Store, DB, I18n, Utils, Config, bus) {
  let listEl, statsTotal, statsOpen, statsPriv, qEl, sortEl;
  let unsubs = [];
  let rafPending = false;

  /** Привязка к DOM. */
  function bind() {
    listEl = document.getElementById('base-list');
    statsTotal = document.getElementById('bs-total');
    statsOpen = document.getElementById('bs-open');
    statsPriv = document.getElementById('bs-priv');
    qEl = document.getElementById('base-q');
    sortEl = document.getElementById('base-sort');
  }

  /** Коалесценция рендеров через requestAnimationFrame. */
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  /**
   * Рендер списка базы (только при активном экране 'base').
   */
  function render() {
    if (!listEl) return;

    const view = Store.get('view');
    if (view !== 'base') return;

    const q = (qEl && qEl.value || '').trim().toLowerCase();
    const sort = (sortEl && sortEl.value) || 'new';

    DB.all().then(notes => {
      let arr = notes.slice();

      if (q) arr = arr.filter(n => (n.text || '').toLowerCase().includes(q));

      if (sort === 'old') {
        arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      } else if (sort === 'az') {
        arr.sort((a, b) => (a.text || '').localeCompare(b.text || '', I18n.getLang() === 'en' ? 'en' : 'ru'));
      } else {
        arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      }

      const shared = notes.filter(n => n.shared).length;

      if (statsTotal) statsTotal.textContent = notes.length;
      if (statsOpen) statsOpen.textContent = shared;
      if (statsPriv) statsPriv.textContent = notes.length - shared;

      listEl.innerHTML = '';

      if (!arr.length) {
        const empty = document.createElement('div');
        empty.className = 'note';
        empty.style.cursor = 'default';
        empty.textContent = q ? I18n.t('empty.base.empty') : I18n.t('empty.base.t');
        listEl.appendChild(empty);
        return;
      }

      const frag = document.createDocumentFragment();
      arr.forEach(n => frag.appendChild(row(n)));
      listEl.appendChild(frag);
    }).catch(() => {});
  }

  /**
   * Рендер строки базы.
   * @param {Object} n - Заметка.
   * @returns {HTMLDivElement}
   */
  function row(n) {
    const el = document.createElement('div');
    el.className = 'bi';
    el.dataset.id = n.id;

    const t = document.createElement('div');
    t.className = 'bi-t';
    t.textContent = n.text || '';
    el.appendChild(t);

    const f = document.createElement('div');
    f.className = 'bi-f';

    const tag = document.createElement('span');
    tag.className = 'note-tag ' + (n.shared ? 'world' : 'priv');
    tag.textContent = n.shared ? I18n.t('base.tag.shared') : I18n.t('base.tag.private');
    f.appendChild(tag);

    const date = document.createElement('span');
    date.textContent = Utils.fmtDate(n.updatedAt || n.createdAt, I18n.getLang());
    f.appendChild(date);

    el.appendChild(f);
    el.addEventListener('click', () => {
      try { bus.emit('note:open', { id: n.id }); } catch (_) {}
    });

    return el;
  }

  /**
   * Инициализация: привязка, слушатели поиска/сортировки, подписки.
   */
  function init() {
    bind();
    if (!listEl) return;

    const debouncedRender = Utils.debounce(scheduleRender, Config.get('baseSearchDebounce', 200));

    if (qEl) qEl.addEventListener('input', debouncedRender);
    if (sortEl) sortEl.addEventListener('change', scheduleRender);

    unsubs.push(bus.on('db:change', scheduleRender));
    unsubs.push(bus.on('view:changed', scheduleRender));
    unsubs.push(bus.on('i18n:change', scheduleRender));

    render();
  }

  /** Отписка от всех подписок. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, render };
}, ['Store', 'DB', 'I18n', 'Utils', 'Config', 'EventBus']);
// ─── UI/BaseView ─── END ────────────────────────────────────────────────────

// ─── UI/NoteView ─── START ──────────────────────────────────────────────────
/**
 * Полноэкранный просмотр заметки.
 *
 * Для своих заметок:
 * - Удаление (с подтверждением)
 * - Переключение видимости (лично ↔ открыто)
 * - Пин (закрепление для контекстного поиска)
 * - Редактирование (только для личных; публичные immutable в Nostr)
 *
 * Для чужих заметок:
 * - Только просмотр + пин
 *
 * Текст в режиме чтения не выделяется (user-select: none из глобального стиля).
 * В режиме редактирования (.nv-text-edit) выделение разрешено.
 *
 * Отличия от v0.6:
 * - ФИКС #1: click-листенер на root вешается один раз в init()
 *   (раньше — при каждом render(), с накоплением);
 * - ФИКС #9: ре-рендер при смене языка (если экран открыт и не в режиме
 *   редактирования — текст пользователя в textarea важнее перевода).
 */
DI.register('NoteView', function (DB, Notes, NoteActions, I18n, Utils, Toast, bus) {
  let root = null;
  let currentId = null;
  let currentNote = null;
  let escHandler = null;
  let editMode = false;
  let editTextarea = null;
  let i18nUnsub = null;

  /** Ленивая привязка к DOM. */
  function ensureRoot() {
    if (!root) root = document.getElementById('noteview');
    return root;
  }

  /** Закрыть экран просмотра. */
  function close() {
    const r = ensureRoot();
    if (r) {
      r.classList.remove('on');
      r.innerHTML = '';
    }

    if (escHandler) {
      document.removeEventListener('keydown', escHandler);
      escHandler = null;
    }

    currentId = null;
    currentNote = null;
    editMode = false;
    editTextarea = null;
  }

  /**
   * Открыть заметку по id. Сначала ищем в локальной БД,
   * потом в сетевом кэше (для чужих заметок).
   * @param {string} id - uid или eventId заметки.
   */
  function open(id) {
    if (!id) return;

    DB.get(id).then(note => {
      if (!note) {
        return DB.cacheGet(id).then(cached => {
          if (cached) render(cached);
        });
      }
      render(note);
    }).catch(() => {});
  }

  /**
   * Переход в режим редактирования: текст заменяется на textarea.
   * @param {Object} note - Заметка.
   * @param {HTMLButtonElement} editBtn - Кнопка «Развить».
   */
  function enterEditMode(note, editBtn) {
    if (editMode) return;

    editMode = true;
    const r = ensureRoot();
    if (!r) return;

    const txt = r.querySelector('.nv-text');

    if (txt) {
      const ta = document.createElement('textarea');
      ta.className = 'nv-text-edit';
      ta.value = note.text || '';
      ta.placeholder = I18n.t('note.edit.placeholder');
      txt.replaceWith(ta);
      editTextarea = ta;
      ta.focus();
    }

    if (editBtn) {
      editBtn.textContent = I18n.t('btn.save');
    }
  }

  /**
   * Сохранение изменений при редактировании.
   * Notes.edit обновляет syncTs → NetService публикует канон (синк).
   * @param {Object} note - Заметка.
   */
  function saveEdit(note) {
    if (!editMode || !editTextarea) return;

    const newText = editTextarea.value.trim();

    if (!newText) {
      Toast.show('warn', I18n.t('toast.empty'));
      return;
    }

    const editBtn = document.querySelector('[data-role="edit"]');

    if (editBtn) {
      editBtn.disabled = true;
      editBtn.textContent = '…';
    }

    Notes.edit(note.id, newText).then(updatedNote => {
      if (!updatedNote) {
        Toast.show('err', I18n.t('toast.copy.fail'));
        return;
      }

      Toast.show('ok', I18n.t('toast.edit.saved'));
      currentNote = updatedNote;
      render(updatedNote);
    }).catch(() => {
      Toast.show('err', I18n.t('toast.copy.fail'));

      if (editBtn) {
        editBtn.disabled = false;
        editBtn.textContent = I18n.t('btn.save');
      }
    });
  }

  /** Пин текущей заметки + закрытие. */
  function pinAndClose() {
    if (!currentNote) {
      close();
      return;
    }

    try {
      bus.emit('note:pin', currentNote);
      Toast.show('ok', I18n.t('toast.pinned'));
    } catch (_) {}

    close();
  }

  /**
   * Полный рендер экрана просмотра заметки.
   * @param {Object} note - Заметка (своя из DB или чужая из кэша).
   */
  function render(note) {
    const r = ensureRoot();
    if (!r) return;

    currentId = note.id;
    currentNote = note;
    r.innerHTML = '';
    r.classList.add('on');
    editMode = false;
    editTextarea = null;

    const isOwn = !!(note.id && !note.authorPubkey);

    // Верхняя панель действий
    const top = document.createElement('div');
    top.className = 'nv-f';

    if (isOwn) {
      const del = document.createElement('button');
      del.className = 'nv-act danger';
      del.textContent = I18n.t('btn.del');
      del.addEventListener('click', () => {
        NoteActions.remove(note.id);
        close();
      });
      top.appendChild(del);

      const tog = document.createElement('button');
      tog.className = 'nv-act';
      tog.textContent = note.shared ? I18n.t('btn.toggle.priv') : I18n.t('btn.toggle.pub');
      tog.addEventListener('click', () => {
        NoteActions.toggle(note.id);
        close();
      });
      top.appendChild(tog);
    }

    const pinBtn = document.createElement('button');
    pinBtn.className = 'nv-act';
    pinBtn.textContent = '◈ ' + I18n.t('btn.pin');
    pinBtn.title = I18n.t('btn.pin.aria');
    pinBtn.setAttribute('aria-label', I18n.t('btn.pin.aria'));
    pinBtn.addEventListener('click', pinAndClose);
    top.appendChild(pinBtn);

    if (isOwn && !note.shared) {
      // Редактирование доступно только для личных заметок
      const edit = document.createElement('button');
      edit.className = 'nv-act';
      edit.setAttribute('data-role', 'edit');
      edit.textContent = I18n.t('btn.edit');

      edit.addEventListener('click', () => {
        if (editMode) {
          saveEdit(note);
        } else {
          enterEditMode(note, edit);
        }
      });

      top.appendChild(edit);
    } else if (isOwn && note.shared) {
      // Публичные заметки нельзя редактировать (immutable в Nostr)
      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:12px;color:var(--text-3);align-self:center;';
      hint.textContent = I18n.t('note.public.noedit');
      top.appendChild(hint);
    }

    r.appendChild(top);

    // Тело: мета + текст
    const body = document.createElement('div');
    body.className = 'nv-b';

    const info = document.createElement('div');
    info.className = 'note-meta';
    info.style.marginBottom = '12px';

    const tag = document.createElement('span');

    if (isOwn) {
      tag.className = 'note-tag ' + (note.shared ? 'world' : 'priv');
      tag.textContent = note.shared ? I18n.t('base.tag.shared') : I18n.t('base.tag.private');
    } else {
      tag.className = 'note-tag world';
      tag.textContent = '· ' + Utils.shortPk(note.authorPubkey || '');
    }

    info.appendChild(tag);

    const date = document.createElement('span');
    date.textContent = Utils.fmtDate(note.updatedAt || note.createdAt, I18n.getLang()) + ' ' +
                       Utils.fmtTime(note.updatedAt || note.createdAt, I18n.getLang());
    info.appendChild(date);
    body.appendChild(info);

    const txt = document.createElement('div');
    txt.className = 'nv-text';
    txt.textContent = note.text || '';
    body.appendChild(txt);

    r.appendChild(body);

    // Нижняя панель: кнопка закрытия
    const bottom = document.createElement('div');
    bottom.className = 'nv-f-bottom';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nv-act';
    closeBtn.textContent = I18n.t('btn.close');
    closeBtn.addEventListener('click', close);
    bottom.appendChild(closeBtn);

    r.appendChild(bottom);

    // Закрытие по Escape
    if (escHandler) document.removeEventListener('keydown', escHandler);
    escHandler = e => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', escHandler);
  }

  /**
   * Инициализация: root click-листенер (один раз, фикс #1),
   * подписка на note:open, подписка на i18n:change (фикс #9).
   */
  function init() {
    const r = ensureRoot();
    if (!r) return;

    // ФИКС #1: один листенер на root. Дети пересоздаются через
    // innerHTML = '', слушатель живёт на корне — накопления нет.
    r.addEventListener('click', e => {
      if (e.target === r) close();
    });

    bus.on('note:open', p => {
      if (p && p.id) open(p.id);
    });

    // ФИКС #9: смена языка при открытом экране. В режиме редактирования
    // не трогаем — текст пользователя в textarea важнее.
    i18nUnsub = bus.on('i18n:change', () => {
      if (currentNote && !editMode && root && root.classList.contains('on')) {
        render(currentNote);
      }
    });
  }

  /** Закрытие + отписка. */
  function destroy() {
    if (i18nUnsub) {
      try { i18nUnsub(); } catch (_) {}
      i18nUnsub = null;
    }
    close();
  }

  return { init, destroy, open, close };
}, ['DB', 'Notes', 'NoteActions', 'I18n', 'Utils', 'Toast', 'EventBus']);
// ─── UI/NoteView ─── END ────────────────────────────────────────────────────

// ─── UI/AccountView ─── START ───────────────────────────────────────────────
/**
 * Экран аккаунта: ключ, вход по ключу, экспорт/импорт архива, синк.
 *
 * Оркестрирует DOMAIN/Account: все подтверждения, тосты, пароли и
 * скачивание файлов — здесь; вся логика — там.
 *
 * Разделы экрана:
 * 1. Публичный адрес (npub) — всегда виден, безопасен.
 * 2. Ключ: маска по умолчанию; «Показать» → ncryptsec (при доступном
 *    NIP-49, поле пароля опционально) или nsec-fallback (пароль-поле
 *    скрыто — обёртка невозможна). Показ = автокопирование + keyExported.
 * 3. Вход по ключу: nsec/hex/ncryptsec (+пароль) → подтверждение
 *    замены аккаунта → Account.enterKey.
 * 4. Экспорт: файл JSON (с ключом или без); импорт: файл → предпросмотр →
 *    применение (при ключе в архиве — сначала замена ключа, потом заметки;
 *    если ключ архива совпадает с текущим — аккаунт не трогаем).
 * 5. Синк: переключатель, статус (живая подписка sync:status — одна
 *    на всё время работы, в init, без накопления при переоткрытиях).
 *
 * Стили — секции 16–17 style.css (.acc-*, .key-box, .field-*).
 */
DI.register('AccountView', function (Account, Modal, Toast, I18n, Config, bus) {
  let unsubs = [];

  /**
   * Создание кнопки-действия (.nv-act) для рядов экрана.
   * @param {string} text - Подпись.
   * @param {Function} onClick - Обработчик.
   * @returns {HTMLButtonElement}
   */
  function actionBtn(text, onClick) {
    const b = document.createElement('button');
    b.className = 'nv-act';
    b.style.cssText = 'flex:1;min-width:100px;font-size:12px;';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  // ─── Раздел: ключ ─────────────────────────────────────────────────────────

  /**
   * Модалка показа ключа.
   * Адаптивна к доступности NIP-49: если обёртка паролем невозможна
   * (нет nip49 в сборке nostr-tools), поле пароля не показывается,
   * а «Показать» выдаст nsec — незашифрованный ключ.
   */
  async function openShowKey() {
    const wrapAvailable = await Account.canWrapKey().catch(() => false);

    const body = document.createElement('div');
    body.className = 'acc-body';

    // Пароль (опционально) — только когда NIP-49 доступен
    let pwInput = null;

    if (wrapAvailable) {
      const pwField = document.createElement('div');
      pwField.className = 'field';

      const pwLabel = document.createElement('span');
      pwLabel.className = 'field-label';
      pwLabel.textContent = I18n.t('account.password.set');
      pwField.appendChild(pwLabel);

      pwInput = document.createElement('input');
      pwInput.type = 'password';
      pwInput.className = 'field-input';
      pwInput.placeholder = I18n.t('account.password.hint');
      pwField.appendChild(pwInput);

      body.appendChild(pwField);
    }

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = I18n.t('account.nsec.hint');
    body.appendChild(hint);

    const keyBox = document.createElement('div');
    keyBox.className = 'key-box masked';
    keyBox.textContent = I18n.t('account.nsec.masked');
    body.appendChild(keyBox);

    const reveal = () => {
      keyBox.textContent = '…';
      Account.getWrappedKey(wrapAvailable && pwInput ? pwInput.value : '').then(wrapped => {
        if (!wrapped) {
          keyBox.textContent = I18n.t('account.nsec.masked');
          Toast.show('err', I18n.t('toast.copy.fail'));
          return;
        }
        keyBox.textContent = wrapped;
        keyBox.classList.remove('masked');
        keyBox.classList.add('focused');
        copyText(wrapped);
        Toast.show('ok', I18n.t('toast.key.copied'));
      });
    };

    Modal.open({
      title: I18n.t('account.identity'),
      body,
      buttons: [
        {
          text: I18n.t('btn.show'),
          primary: true,
          onClick: reveal,
        },
        {
          text: I18n.t('btn.close'),
          onClick: () => Modal.close(),
        },
      ],
    });
  }

  /**
   * Копирование текста в буфер (тихое, без тостов — тосты у вызывающих).
   * @param {string} text
   */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text || '').catch(() => {});
    }
  }

  // ─── Раздел: вход по ключу ────────────────────────────────────────────────

  /**
   * Модалка входа по ключу с другого устройства.
   */
  function openEnterKey() {
    const body = document.createElement('div');
    body.className = 'acc-body';

    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.enter.desc');
    body.appendChild(desc);

    const keyField = document.createElement('div');
    keyField.className = 'field';

    const keyLabel = document.createElement('span');
    keyLabel.className = 'field-label';
    keyLabel.textContent = I18n.t('account.enter.title');
    keyField.appendChild(keyLabel);

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'field-input mono';
    keyInput.placeholder = I18n.t('account.enter.placeholder');
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    keyField.appendChild(keyInput);
    body.appendChild(keyField);

    // Поле пароля (показывается только для ncryptsec)
    const pwField = document.createElement('div');
    pwField.className = 'field';
    pwField.style.display = 'none';

    const pwLabel = document.createElement('span');
    pwLabel.className = 'field-label';
    pwLabel.textContent = I18n.t('account.password.set');
    pwField.appendChild(pwLabel);

    const pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.className = 'field-input';
    pwField.appendChild(pwInput);
    body.appendChild(pwField);

    // Показ пароля при ncryptsec
    keyInput.addEventListener('input', () => {
      const v = keyInput.value.trim();
      pwField.style.display = v.startsWith('ncryptsec1') ? '' : 'none';
    });

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = I18n.t('account.nsec.hint');
    body.appendChild(hint);

    const submit = () => {
      const raw = keyInput.value.trim();
      if (!raw) return;

      Modal.confirm(
        I18n.t('account.enter.confirm'),
        I18n.t('account.enter.confirm.d'),
        async () => {
          const res = await Account.enterKey(raw, pwInput.value);
          if (res.ok) {
            Toast.show('ok', I18n.t('account.enter.done'));
          } else {
            Toast.show('err', I18n.t(res.error === 'bad'
              ? 'account.enter.bad'
              : 'toast.copy.fail'));
          }
        },
        I18n.t('btn.confirm')
      );
    };

    Modal.open({
      title: I18n.t('account.enter.title'),
      body,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: () => Modal.close() },
        { text: I18n.t('btn.confirm'), primary: true, onClick: submit },
      ],
    });
  }

  // ─── Раздел: экспорт / импорт ──────────────────────────────────────────────

  /**
   * Модалка экспорта: без ключа или с ключом (пароль опционален),
   * скачивание файла.
   */
  function openExport() {
    const body = document.createElement('div');
    body.className = 'acc-body';

    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.export.desc');
    body.appendChild(desc);

    const pwField = document.createElement('div');
    pwField.className = 'field';

    const pwLabel = document.createElement('span');
    pwLabel.className = 'field-label';
    pwLabel.textContent = I18n.t('account.password.set');
    pwField.appendChild(pwLabel);

    const pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.className = 'field-input';
    pwField.appendChild(pwInput);
    body.appendChild(pwField);

    const run = (includeKey) => {
      Account.exportArchive(includeKey, includeKey ? pwInput.value : '').then(res => {
        if (!res) {
          Toast.show('err', I18n.t('toast.copy.fail'));
          return;
        }
        downloadText(res.json, res.filename);
        Modal.close();
        Toast.show('ok', I18n.t('account.export.file'));
      });
    };

    Modal.open({
      title: I18n.t('account.export.file'),
      body,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: () => Modal.close() },
        { text: I18n.t('account.export.file'), onClick: () => run(false) },
        { text: I18n.t('btn.download'), primary: true, onClick: () => run(true) },
      ],
    });
  }

  /**
   * Скачивание текста как файла.
   * @param {string} text - Содержимое.
   * @param {string} filename - Имя файла.
   */
  function downloadText(text, filename) {
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (e) {
      Toast.show('err', I18n.t('toast.copy.fail'));
    }
  }

  /**
   * Импорт архива: выбор файла → предпросмотр → подтверждение → применение.
   */
  function openImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();

      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const parsed = Account.parseArchive(String(reader.result || ''));

        if (!parsed.ok) {
          Toast.show('err', I18n.t('account.import.bad'));
          return;
        }

        confirmImport(parsed.archive);
      };
      reader.onerror = () => {
        Toast.show('err', I18n.t('account.import.bad'));
      };
      reader.readAsText(file);
    });

    input.click();
  }

  /**
   * Подтверждение импорта с предпросмотром количества заметок.
   *
   * Порядок применения:
   * - без ключа в архиве — сразу заметки (upsert по LWW);
   * - с ключом, если он ОТЛИЧАЕТСЯ от текущего — сначала замена аккаунта
   *   (сброс базы через enterKey), затем заметки;
   * - с ключом, если он СОВПАДАЕТ с текущим — аккаунт и базу НЕ трогаем
   *   (иначе повторный импорт своего бэкапа на том же устройстве стёр бы
   *   заметки, созданные после бэкапа); upsert дорезолит новое/старое.
   *
   * @param {Object} archive - Архив из Account.parseArchive.
   */
  function confirmImport(archive) {
    /**
     * @param {string} password - Пароль ncryptsec (может быть пустым;
     *   для nsec из архива игнорируется).
     */
    const apply = async (password) => {
      if (archive.ncryptsec && archive.pubkey) {
        let currentPk = null;
        try {
          currentPk = (await Account.getAccountInfo()).pubkey;
        } catch (_) {}

        if (currentPk !== archive.pubkey) {
          const enter = await Account.enterKey(archive.ncryptsec, password);
          if (!enter.ok) {
            Toast.show('err', I18n.t('account.enter.bad'));
            return;
          }
          Toast.show('ok', I18n.t('account.enter.done'));
        }
      }

      const count = await Account.importArchive(archive);
      Toast.show('ok', I18n.t('account.import.done', { count }));
    };

    // Без ключа — обычное подтверждение.
    if (!archive.ncryptsec) {
      Modal.confirm(
        I18n.t('account.import.file'),
        I18n.t('account.import.confirm.d') + ' (' + archive.noteCount + ')',
        () => { apply(''); },
        I18n.t('btn.import')
      );
      return;
    }

    // С ключом — сначала пароль, затем применение.
    const body = document.createElement('div');
    body.className = 'acc-body';

    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.import.confirm.d') + ' (' + archive.noteCount + ')';
    body.appendChild(desc);

    const pwField = document.createElement('div');
    pwField.className = 'field';

    const pwLabel = document.createElement('span');
    pwLabel.className = 'field-label';
    pwLabel.textContent = I18n.t('account.password.set');
    pwField.appendChild(pwLabel);

    const pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.className = 'field-input';
    pwField.appendChild(pwInput);
    body.appendChild(pwField);

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = I18n.t('account.nsec.hint');
    body.appendChild(hint);

    Modal.open({
      title: I18n.t('account.import.file'),
      body,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: () => Modal.close() },
        {
          text: I18n.t('btn.import'),
          primary: true,
          onClick: () => {
            Modal.close();
            apply(pwInput.value);
          },
        },
      ],
    });
  }

  // ─── Раздел: синк ─────────────────────────────────────────────────────────

  /**
   * Обновление индикатора статуса синка в ОТКРЫТОМ экране аккаунта.
   * Подписка на sync:status живёт в init() — одна на всё время работы,
   * листенеры не накапливаются при повторных открытиях экрана.
   * @param {string} phase - 'off' | 'active' | 'idle'.
   */
  function paintSyncStatus(phase) {
    const wrap = document.querySelector('.acc-sync');
    if (!wrap) return;

    const dot = wrap.querySelector('.dot');
    const txt = wrap.querySelector('.acc-sync-txt');
    if (!dot || !txt) return;

    dot.className = 'dot '
      + (phase === 'off' ? 'err'
        : phase === 'active' ? 'load'
        : 'ok');
    txt.textContent = phase === 'off' ? I18n.t('account.sync.off')
      : phase === 'active' ? I18n.t('account.sync.running')
      : I18n.t('account.sync.on');
  }

  /**
   * Ряд синка: переключатель + статус.
   * @returns {HTMLDivElement}
   */
  function buildSyncRow() {
    const row = document.createElement('div');
    row.className = 'acc-section';

    const title = document.createElement('span');
    title.className = 'acc-title';
    title.textContent = I18n.t('account.sync.status');
    row.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'acc-desc';
    hint.textContent = I18n.t('account.sync.hint');
    row.appendChild(hint);

    const syncLine = document.createElement('div');
    syncLine.className = 'acc-sync';

    const dot = document.createElement('span');
    dot.className = 'dot';
    syncLine.appendChild(dot);

    const statusTxt = document.createElement('span');
    statusTxt.className = 'acc-sync-txt';
    syncLine.appendChild(statusTxt);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'nv-act';
    toggleBtn.style.cssText = 'flex:1;font-size:12px;';

    function paint() {
      const enabled = Config.get('syncEnabled', true);
      toggleBtn.textContent = enabled ? I18n.t('account.sync.on') : I18n.t('account.sync.off');
      toggleBtn.classList.toggle('danger', !enabled);
    }

    toggleBtn.addEventListener('click', () => {
      const next = !Config.get('syncEnabled', true);
      Account.setSyncEnabled(next);
      Toast.show('ok', I18n.t(next ? 'toast.sync.enabled' : 'toast.sync.disabled'));
      paint();
      paintSyncStatus(next ? 'idle' : 'off');
    });

    syncLine.appendChild(toggleBtn);
    row.appendChild(syncLine);

    paint();

    // Начальный статус — красим локально (экран ещё не в DOM,
    // paintSyncStatus его не найдёт; дальше живёт подписка из init).
    const phase = Config.get('syncEnabled', true) ? 'idle' : 'off';
    dot.className = 'dot ' + (phase === 'off' ? 'err' : phase === 'active' ? 'load' : 'ok');
    statusTxt.textContent = phase === 'off' ? I18n.t('account.sync.off') : I18n.t('account.sync.on');

    return row;
  }

  // ─── Главный экран ────────────────────────────────────────────────────────

  /**
   * Открыть экран аккаунта (модалка с секциями).
   */
  function open() {
    const body = document.createElement('div');
    body.className = 'acc-body';

    // Секция 1: публичный адрес (npub) — асинхронно, вставляется первым.
    Account.getNpub().then(npub => {
      if (!npub) return;

      const sec = document.createElement('div');
      sec.className = 'acc-section';

      const t = document.createElement('span');
      t.className = 'acc-title';
      t.textContent = I18n.t('account.npub');
      sec.appendChild(t);

      const box = document.createElement('div');
      box.className = 'key-box';
      box.textContent = npub;
      sec.appendChild(box);

      const actions = document.createElement('div');
      actions.className = 'acc-actions';
      actions.appendChild(actionBtn(I18n.t('btn.copy'), () => {
        copyText(npub);
        Toast.show('ok', I18n.t('toast.copied'));
      }));
      sec.appendChild(actions);

      // Вставляем первой секцией (npub — верх экрана)
      body.insertBefore(sec, body.firstChild);
    }).catch(() => {});

    // Секция 2: описание
    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.identity.desc');
    body.appendChild(desc);

    // Секция 3: ключ
    const keySec = document.createElement('div');
    keySec.className = 'acc-section';

    const keyTitle = document.createElement('span');
    keyTitle.className = 'acc-title';
    keyTitle.textContent = I18n.t('account.identity');
    keySec.appendChild(keyTitle);

    const keyHint = document.createElement('div');
    keyHint.className = 'acc-desc';
    keyHint.textContent = I18n.t('account.nsec.hint');
    keySec.appendChild(keyHint);

    const keyActions = document.createElement('div');
    keyActions.className = 'acc-actions';
    keyActions.appendChild(actionBtn(I18n.t('btn.show'), () => { openShowKey(); }));
    keyActions.appendChild(actionBtn(I18n.t('account.enter.title'), openEnterKey));
    keySec.appendChild(keyActions);

    body.appendChild(keySec);

    // Секция 4: экспорт / импорт
    const ioSec = document.createElement('div');
    ioSec.className = 'acc-section';

    const ioTitle = document.createElement('span');
    ioTitle.className = 'acc-title';
    ioTitle.textContent = I18n.t('account.export.file');
    ioSec.appendChild(ioTitle);

    const ioDesc = document.createElement('div');
    ioDesc.className = 'acc-desc';
    ioDesc.textContent = I18n.t('account.export.desc');
    ioSec.appendChild(ioDesc);

    const ioActions = document.createElement('div');
    ioActions.className = 'acc-actions';
    ioActions.appendChild(actionBtn(I18n.t('btn.download'), openExport));
    ioActions.appendChild(actionBtn(I18n.t('btn.import'), openImport));
    ioSec.appendChild(ioActions);

    body.appendChild(ioSec);

    // Секция 5: синк
    body.appendChild(buildSyncRow());

    Modal.open({
      title: I18n.t('account.title'),
      body,
      buttons: [{ text: I18n.t('btn.close'), onClick: () => Modal.close() }],
    });
  }

  /**
   * Инициализация: подписка на sync:status (одна, навсегда — статус
   * красится только если экран аккаунта сейчас открыт) и на
   * account:changed (пересборка открытого экрана после замены ключа).
   */
  function init() {
    unsubs.push(bus.on('sync:status', e => {
      if (e && e.phase) paintSyncStatus(e.phase);
    }));

    unsubs.push(bus.on('account:changed', () => {
      // Ключ заменили — пересобираем экран, если открыт.
      const overlay = document.getElementById('overlay');
      if (overlay && overlay.classList.contains('on')) {
        open();
      }
    }));
  }

  /** Отписка. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, open };
}, ['Account', 'Modal', 'Toast', 'I18n', 'Config', 'EventBus']);
// ─── UI/AccountView ─── END ─────────────────────────────────────────────────

// ─── UI/MenuView ─── START ──────────────────────────────────────────────────
/**
 * Меню настроек и переключение экранов (Поток / База).
 *
 * Содержит:
 * - Переключение темы (с установкой userThemeOverride для Telegram)
 * - Переключение языка
 * - Настройки ранжирования (ползунки + режим отображения)
 * - Переход на экран аккаунта (новое)
 * - Переход между экранами Поток/База
 * - Стирание базы и полный сброс
 *
 * Отличия от v0.6:
 * - ФИКС #2: предпросмотр ранжирования через i18n-ключ с параметрами
 *   (был русский хардкод);
 * - ФИКС #3: единый setView — подпись на 'view:set' из шины (wipe-обработчик
 *   Boot сбрасывает экран корректно);
 * - ФИКС #6: мёртвые .tab-b удалены;
 * - Слайдеры на CSS-классах (style.css, секция 15) вместо инлайна;
 * - Очистка Provenance-кэша удалена — модуль самоинвалидируется (волна 8).
 */
DI.register('MenuView', function (Store, Config, Modal, Toast, I18n, bus, Onboarding, DB, Nostr) {
  let unsubs = [];

  /**
   * Применить тему.
   * @param {string} theme - 'dark' | 'light'.
   */
  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    Config.set('theme', theme);
  }

  /**
   * Переключение экрана (единственная точка входа).
   * @param {string} view - 'stream' | 'base'.
   */
  function setView(view) {
    Store.setState({ view });

    const isBase = view === 'base';

    ['ctx-banner', 'seg', 'feed-wrap', 'btn-history', 'composer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', isBase);
    });

    const base = document.getElementById('base');
    if (base) base.classList.toggle('on', isBase);

    try { bus.emit('view:changed', { view }); } catch (_) {}
  }

  /**
   * Синхронизация активного состояния кнопок с Store.
   */
  function viewSync() {
    const view = Store.get('view');

    const bb = document.getElementById('btn-base');
    if (bb) bb.classList.toggle('active', view === 'base');
  }

  /**
   * Модальное окно настроек ранжирования.
   * Три ползунка + режим отображения + живой предпросмотр.
   */
  function openRankingSettings() {
    const body = document.createElement('div');
    body.className = 'range-body';

    const sliders = [
      {
        key: 'threshold',
        min: 0.50,
        max: 0.95,
        step: 0.01,
        label: I18n.t('ranking.threshold'),
        hint: I18n.t('ranking.threshold.hint'),
        color: 'amber',
      },
      {
        key: 'serendipity',
        min: 0.05,
        max: 0.30,
        step: 0.01,
        label: I18n.t('ranking.serendipity'),
        hint: I18n.t('ranking.serendipity.hint'),
        color: 'teal',
      },
      {
        key: 'duplicateThreshold',
        min: 0.88,
        max: 0.99,
        step: 0.01,
        label: I18n.t('ranking.similarity'),
        hint: I18n.t('ranking.similarity.hint'),
        color: 'rose',
      },
    ];

    /** @type {Object<string, {slider: HTMLInputElement, val: HTMLSpanElement}>} */
    const valueEls = {};

    sliders.forEach(cfg => {
      const current = Number(Config.get(cfg.key, cfg.min));
      const safe = Number.isFinite(current) ? current : cfg.min;

      const group = document.createElement('div');
      group.className = 'range-group';

      const labelRow = document.createElement('div');
      labelRow.className = 'range-head';

      const lbl = document.createElement('span');
      lbl.className = 'range-lbl';
      lbl.textContent = cfg.label;

      const val = document.createElement('span');
      val.className = 'range-val ' + cfg.color;
      val.textContent = safe.toFixed(2);

      labelRow.appendChild(lbl);
      labelRow.appendChild(val);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(cfg.min);
      slider.max = String(cfg.max);
      slider.step = String(cfg.step);
      slider.value = String(safe);
      slider.className = 'no-range ' + cfg.color;

      const hintEl = document.createElement('div');
      hintEl.className = 'range-hint';
      hintEl.textContent = cfg.hint;

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        val.textContent = Number.isFinite(v) ? v.toFixed(2) : cfg.min.toFixed(2);
      });

      valueEls[cfg.key] = { slider, val };

      group.appendChild(labelRow);
      group.appendChild(slider);
      group.appendChild(hintEl);
      body.appendChild(group);
    });

    // Живой предпросмотр: что значит текущая настройка (ФИКС #2)
    const previewEl = document.createElement('div');
    previewEl.className = 'range-preview';

    function updatePreview() {
      const threshold = parseFloat(valueEls['threshold'].slider.value);
      const serendipity = parseFloat(valueEls['serendipity'].slider.value);
      const lowerBound = threshold - serendipity;

      previewEl.textContent = I18n.t('preview.ranking', {
        relevant: Math.round(threshold * 100),
        serenLo: Math.round(lowerBound * 100),
        serenHi: Math.round(threshold * 100),
        hidden: Math.round(lowerBound * 100),
      });
    }

    updatePreview();
    body.appendChild(previewEl);

    valueEls['threshold'].slider.addEventListener('input', updatePreview);
    valueEls['serendipity'].slider.addEventListener('input', updatePreview);

    // Режим отображения сходства: signal / percent
    let pendingDisplay = Config.get('similarityDisplay', 'signal');
    if (pendingDisplay !== 'signal' && pendingDisplay !== 'percent') {
      pendingDisplay = 'signal';
    }

    const displayGroup = document.createElement('div');
    displayGroup.className = 'range-display';

    const displayLabel = document.createElement('span');
    displayLabel.className = 'range-display-lbl';
    displayLabel.textContent = I18n.t('ranking.display');

    const displayToggle = document.createElement('div');
    displayToggle.className = 'range-display-btns';

    /** @type {Array<HTMLButtonElement>} */
    const displayBtns = [];

    /**
     * Подсветка активной кнопки режима отображения.
     */
    function paintDisplayButtons() {
      displayBtns.forEach(btn => {
        btn.classList.toggle('selected', btn.getAttribute('data-display-mode') === pendingDisplay);
      });
    }

    ['signal', 'percent'].forEach(mode => {
      const btn = document.createElement('button');
      btn.className = 'nv-act';
      btn.setAttribute('data-display-mode', mode);
      btn.textContent = I18n.t('ranking.display.' + mode);

      btn.addEventListener('click', () => {
        pendingDisplay = mode;
        paintDisplayButtons();
      });

      displayBtns.push(btn);
      displayToggle.appendChild(btn);
    });

    paintDisplayButtons();

    displayGroup.appendChild(displayLabel);
    displayGroup.appendChild(displayToggle);
    body.appendChild(displayGroup);

    Modal.open({
      title: I18n.t('menu.ranking'),
      body,
      buttons: [
        {
          text: I18n.t('btn.cancel'),
          onClick: () => Modal.close(),
        },
        {
          text: I18n.t('btn.save'),
          primary: true,
          onClick: () => {
            sliders.forEach(cfg => {
              const v = parseFloat(valueEls[cfg.key].slider.value);
              if (Number.isFinite(v)) Config.set(cfg.key, v);
            });

            Config.set('similarityDisplay', pendingDisplay);

            try { bus.emit('db:change'); } catch (_) {}

            Toast.show('ok', I18n.t('ranking.saved'));
            Modal.close();
          },
        },
        {
          text: I18n.t('ranking.reset'),
          danger: true,
          onClick: () => {
            const d = Config.defaults();

            sliders.forEach(cfg => {
              const def = Number(d[cfg.key]);
              const safe = Number.isFinite(def) ? def : cfg.min;

              Config.set(cfg.key, safe);
              valueEls[cfg.key].slider.value = String(safe);
              valueEls[cfg.key].val.textContent = safe.toFixed(2);
            });

            pendingDisplay = d.similarityDisplay === 'percent' ? 'percent' : 'signal';
            Config.set('similarityDisplay', pendingDisplay);
            paintDisplayButtons();
            updatePreview();

            try { bus.emit('db:change'); } catch (_) {}

            Toast.show('ok', I18n.t('ranking.reset'));
          },
        },
      ],
    });
  }

  /**
   * Полный сброс: удаление всех данных (БД, кэш, localStorage, Service Worker).
   * Safari-safe: проверка `typeof indexedDB.databases === 'function'`.
   * Канон: tombstone'ы отправит publishWipeAll (вызывается Boot'ом до этого
   * метода? — нет: здесь свой вызов; см. код ниже).
   */
  function fullReset() {
    Modal.confirm(
      I18n.t('menu.fullreset'),
      I18n.t('menu.fullreset.confirm'),
      () => {
        // Отправляем delete/tombstone на релеи ДО очистки.
        let wipePromise = Promise.resolve();
        try {
          const NetService = DI.resolve('NetService');
          wipePromise = NetService.publishWipeAll().catch(() => {});
        } catch (_) {}

        wipePromise.finally(() => {
          try { Nostr.close(); } catch (_) {}

          if (window.indexedDB && typeof indexedDB.databases === 'function') {
            indexedDB.databases().then(dbs => {
              dbs.forEach(dbInfo => {
                if (dbInfo.name) {
                  indexedDB.deleteDatabase(dbInfo.name);
                }
              });
            }).catch(() => {});
          } else if (window.indexedDB) {
            try {
              indexedDB.deleteDatabase(Config.get('dbName', 'noomium_v2'));
            } catch (_) {}
          }

          try { localStorage.clear(); } catch (_) {}
          try { sessionStorage.clear(); } catch (_) {}

          if (window.caches) {
            caches.keys().then(names => {
              names.forEach(name => caches.delete(name));
            }).catch(() => {});
          }

          if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            try {
              navigator.serviceWorker.controller.postMessage('CLEAR_CACHE');
            } catch (_) {}
          }

          Toast.show('ok', I18n.t('menu.fullreset.done'));

          setTimeout(() => {
            window.location.reload();
          }, 1500);
        });
      }
    );
  }

  /**
   * Открыть меню.
   */
  function openMenu() {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

    // Как это работает
    const helpBtn = document.createElement('button');
    helpBtn.className = 'nv-act';
    helpBtn.textContent = '? ' + I18n.t('menu.help');
    helpBtn.addEventListener('click', () => {
      Modal.close();
      Onboarding.showHelp(false);
    });
    body.appendChild(helpBtn);

    // Переключение темы
    const themeBtn = document.createElement('button');
    themeBtn.className = 'nv-act';
    themeBtn.textContent = I18n.t('menu.theme') + ': ' + (Config.get('theme', 'dark') === 'dark' ? '🌙' : '☀️');
    themeBtn.addEventListener('click', () => {
      const next = Config.get('theme', 'dark') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      // Помечаем что тема выбрана вручную — Telegram не должен её перезаписывать
      Config.set('userThemeOverride', true);
      Modal.close();
      Toast.show('ok', I18n.t('menu.theme') + ' → ' + next);
    });
    body.appendChild(themeBtn);

    // Переключение языка
    const langBtn = document.createElement('button');
    langBtn.className = 'nv-act';
    langBtn.textContent = I18n.t('menu.lang') + ': ' + I18n.getLang().toUpperCase();
    langBtn.addEventListener('click', () => {
      const next = I18n.getLang() === 'ru' ? 'en' : 'ru';
      I18n.setLang(next);
      Modal.close();
    });
    body.appendChild(langBtn);

    // Настройки ранжирования
    const rankingBtn = document.createElement('button');
    rankingBtn.className = 'nv-act';
    rankingBtn.textContent = '⚙ ' + I18n.t('menu.ranking');
    rankingBtn.addEventListener('click', () => {
      Modal.close();
      openRankingSettings();
    });
    body.appendChild(rankingBtn);

    // Аккаунт и ключ (новое)
    const accountBtn = document.createElement('button');
    accountBtn.className = 'nv-act';
    accountBtn.textContent = '⚿ ' + I18n.t('menu.account');
    accountBtn.addEventListener('click', () => {
      Modal.close();
      DI.resolve('AccountView').open();
    });
    body.appendChild(accountBtn);

    // Переход: База
    const goBase = document.createElement('button');
    goBase.className = 'nv-act';
    goBase.textContent = I18n.t('tab.base');
    goBase.addEventListener('click', () => {
      Modal.close();
      setView('base');
    });
    body.appendChild(goBase);

    // Переход: Поток
    const goStream = document.createElement('button');
    goStream.className = 'nv-act';
    goStream.textContent = I18n.t('tab.stream');
    goStream.addEventListener('click', () => {
      Modal.close();
      setView('stream');
    });
    body.appendChild(goStream);

    // Стирание базы
    const wipe = document.createElement('button');
    wipe.className = 'nv-act danger';
    wipe.textContent = I18n.t('base.wipe');
    wipe.addEventListener('click', () => {
      Modal.close();
      Modal.confirm(I18n.t('base.wipe'), I18n.t('base.wipe.confirm'), () => {
        try { bus.emit('wipe:request'); } catch (_) {}
      });
    });
    body.appendChild(wipe);

    // Полный сброс
    const resetBtn = document.createElement('button');
    resetBtn.className = 'nv-act danger';
    resetBtn.textContent = I18n.t('menu.fullreset');
    resetBtn.addEventListener('click', () => {
      Modal.close();
      fullReset();
    });
    body.appendChild(resetBtn);

    // Версия приложения
    const version = document.createElement('div');
    version.style.cssText = 'text-align:center;font-size:11px;color:var(--text-3);margin-top:8px;';
    version.textContent = 'v' + APP_VERSION;
    body.appendChild(version);

    Modal.open({ title: I18n.t('menu.settings'), body });
  }

  /**
   * Инициализация: тема, кнопки шапки, подписка на view:set (фикс #3).
   */
  function init() {
    applyTheme(Config.get('theme', 'dark'));

    const menuBtn = document.getElementById('btn-menu');
    if (menuBtn) menuBtn.addEventListener('click', openMenu);

    const baseBtn = document.getElementById('btn-base');
    if (baseBtn) {
      baseBtn.addEventListener('click', () =>
        setView(Store.get('view') === 'base' ? 'stream' : 'base')
      );
    }

    // ФИКС #3: внешний сброс экрана (wipe в Boot) — через шину, единый setView.
    unsubs.push(bus.on('view:set', p => {
      if (p && p.view) setView(p.view);
    }));

    unsubs.push(Store.subscribe(s => s.view, viewSync));
    unsubs.push(bus.on('i18n:change', viewSync));

    viewSync();
  }

  /** Отписка. */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, setView, openMenu };
}, ['Store', 'Config', 'Modal', 'Toast', 'I18n', 'EventBus', 'Onboarding', 'DB', 'Nostr']);
// ─── UI/MenuView ─── END ────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: PLATFORM — интеграция с окружением
// ═══════════════════════════════════════════════════════════════════════════════

// ─── PLATFORM/TelegramAdapter ─── START ─────────────────────────────────────
/**
 * Интеграция с Telegram Mini Apps.
 *
 * Определяет, открыто ли приложение в Telegram, применяет тему, даёт
 * haptic feedback для тостов.
 *
 * Защита от конфликта тем:
 * Если пользователь вручную выбрал тему в настройках (userThemeOverride = true),
 * событие themeChanged от Telegram игнорируется.
 */
DI.register('TelegramAdapter', function (Config, bus, Logger) {
  /** @type {Object|null} window.Telegram.WebApp. */
  let tg = null;
  /** @type {boolean} */
  let isActive = false;

  /**
   * Инициализация: если открыты в Telegram — ready/expand/тема/события.
   * Вне Telegram — тихий выход.
   */
  function init() {
    if (!window.Telegram || !window.Telegram.WebApp) {
      Logger.info('TelegramAdapter: не в Telegram, пропускаем');
      return;
    }

    tg = window.Telegram.WebApp;

    try {
      tg.ready();
      tg.expand();
      isActive = true;
      Logger.info('TelegramAdapter: активирован');
    } catch (e) {
      Logger.warn('TelegramAdapter: ошибка инициализации', String(e));
      return;
    }

    applyTheme();

    tg.onEvent('themeChanged', () => {
      applyTheme();
    });

    try {
      tg.setHeaderColor(tg.colorScheme === 'dark' ? '#0a0a0b' : '#fafafa');
      tg.setBackgroundColor(tg.colorScheme === 'dark' ? '#0a0a0b' : '#fafafa');
    } catch (_) {}
  }

  /**
   * Применение темы из Telegram.
   * Если пользователь вручную выбрал тему (userThemeOverride), пропускаем.
   */
  function applyTheme() {
    if (!tg) return;

    // Защита от конфликта: ручная тема имеет приоритет
    if (Config.get('userThemeOverride', false)) {
      return;
    }

    const scheme = tg.colorScheme || 'dark';
    document.body.setAttribute('data-theme', scheme);

    try {
      tg.setHeaderColor(scheme === 'dark' ? '#0a0a0b' : '#fafafa');
      tg.setBackgroundColor(scheme === 'dark' ? '#0a0a0b' : '#fafafa');
    } catch (_) {}

    try {
      bus.emit('telegram:theme', { scheme });
    } catch (_) {}
  }

  /**
   * @returns {boolean} Запущено ли приложение внутри Telegram.
   */
  function isTelegram() {
    return isActive;
  }

  /**
   * Тактильный отклик.
   * @param {'success'|'error'|'light'} type - Тип воздействия.
   */
  function hapticFeedback(type) {
    if (!tg || !tg.HapticFeedback) return;

    try {
      if (type === 'success') {
        tg.HapticFeedback.notificationOccurred('success');
      } else if (type === 'error') {
        tg.HapticFeedback.notificationOccurred('error');
      } else {
        tg.HapticFeedback.impactOccurred('light');
      }
    } catch (_) {}
  }

  /**
   * Нативный alert с браузерным fallback.
   * @param {string} message - Текст.
   */
  function showAlert(message) {
    if (!tg) return;

    try {
      tg.showAlert(message);
    } catch (_) {
      alert(message);
    }
  }

  /**
   * Нативный confirm с браузерным fallback.
   * @param {string} message - Текст.
   * @param {Function} callback - Колбэк(true) при подтверждении.
   */
  function showConfirm(message, callback) {
    if (!tg) {
      if (confirm(message)) callback();
      return;
    }

    try {
      tg.showConfirm(message, confirmed => {
        if (confirmed) callback();
      });
    } catch (_) {
      if (confirm(message)) callback();
    }
  }

  return { init, isTelegram, hapticFeedback, showAlert, showConfirm };
}, ['Config', 'EventBus', 'Logger']);
// ─── PLATFORM/TelegramAdapter ─── END ───────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: BOOT — точка входа
// ═══════════════════════════════════════════════════════════════════════════════

// ─── BOOT ─── START ─────────────────────────────────────────────────────────
/**
 * Точка входа. Инициализирует все модули в правильном порядке.
 *
 * Порядок инициализации:
 * 1. Тема + переводы статических элементов (до показа)
 * 2. Подписчики событий (без DOM): Progress, HeaderStatus, Feed, Influence
 * 3. TelegramAdapter (до Context, чтобы тема применилась вовремя)
 * 4. Context (подписывается на 'note:pin')
 * 5. DOM-модули: Composer, FeedView, NoteView, BaseView, MenuView,
 *    AccountView (FeedView резолвит Provenance — подписка на db:change
 *    существует до старта сети в шаге 8)
 * 6. Обработчик стирания данных: publishWipeAll (tombstone'ы в outbox)
 *    → DB.reset → view:set (единый setView в MenuView, фикс #3)
 * 7. Показ приложения (body.ready)
 * 8. Запуск AI и сети (NetService.start: подписки, backsweep v0.6 → v0.7)
 * 9. Онбординг (последним, ждёт загрузки модели)
 */
DI.register('Boot', function () {
  function mount() {
    // 1. Тема и перевод статических элементов до показа
    const Config = DI.resolve('Config');
    document.body.setAttribute('data-theme', Config.get('theme', 'dark'));
    DI.resolve('I18n').init();

    // 2. Подписчики событий (без DOM)
    DI.resolve('Progress').init();
    DI.resolve('HeaderStatus').init();
    DI.resolve('Feed').init();
    DI.resolve('Influence').init();

    // 3. Telegram адаптер ДО Context, чтобы тема применилась вовремя
    DI.resolve('TelegramAdapter').init();

    // 4. Context.init подписывается на 'note:pin' от NoteView/FeedView
    DI.resolve('Context').init();

    // 5. DOM-модули
    DI.resolve('Composer').init();
    DI.resolve('FeedView').init();
    DI.resolve('NoteView').init();
    DI.resolve('BaseView').init();
    DI.resolve('MenuView').init();
    DI.resolve('AccountView').init();

    // 6. Слушатель стирания данных
    const bus = DI.resolve('EventBus');
    const DB = DI.resolve('DB');
    const Toast = DI.resolve('Toast');
    const I18n = DI.resolve('I18n');
    const NetService = DI.resolve('NetService');

    bus.on('wipe:request', () => {
      // Tombstone'ы канона + kind 5 проекций: в персистентный outbox,
      // попытка доставки с бюджетом (см. NetService.publishWipeAll).
      NetService.publishWipeAll()
        .catch(() => {})
        .finally(() => DB.reset())
        .then(() => {
          Toast.show('ok', I18n.t('toast.base.wiped'));
          // ФИКС #3: единый setView — DOM-переключение, а не только Store.
          try { bus.emit('view:set', { view: 'stream' }); } catch (_) {}
        });
    });

    // 7. Показ приложения
    document.body.classList.add('ready');

    // 8. Запуск AI и сети
    DI.resolve('Embedder').load();
    DI.resolve('NetService').start();

    // 9. Онбординг последним (ждёт загрузки модели)
    DI.resolve('Onboarding').init();
  }

  return { mount };
});
// ─── BOOT ─── END ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════════════════════════════════════════════
window.DI = DI;

// Активируется после реализации BOOT (волна 16). До тех пор — тихое
// предупреждение в консоль: каркас не является рабочим приложением.
try {
  DI.resolve('Boot').mount();
} catch (e) {
  console.warn('[NOOmium] каркас: ждём реализации модулей —', e && e.message);
}
