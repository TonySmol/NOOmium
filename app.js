// ═══════════════════════════════════════════════════════════════════════════════
// NOOmium — app.js
// Соцсеть смыслов: мысли ищутся по значению, а не по словам.
//
// МОДЕЛЬ v0.9.0 «Состояния вместо событий»:
// - Заметка = (uid, owner). Единственная идентичность (И1).
// - Истина заметки — у владельца: notes у себя, канон в сети (И2).
// - Канон: kind 30078, replaceable, d = uid. ВСЕ переходы
//   (создать/скрыть/показать/удалить/править) = новые версии одного
//   события. Публичная версия — открытый JSON; приватная — NIP-44;
//   удалённая — открытый факт (И4, И5).
// - Зеркало читателя сходится: upsert строго по version, обработка
//   версий в любом порядке даёт один результат (И3).
// - Ответ на запрос (21001) — ссылка (uid, owner), не копия.
// - kind 5 не используется. eventId отсутствует как понятие.
// - Офлайн: операции владельца мгновенны локально, сеть догоняет (И6).
// - Одна запись в зеркале = максимум одна карточка (И7).
//
// СЛОИ: CORE / DATA / AI / NET / DOMAIN / UI / PLATFORM / BOOT.
// Каждый модуль — одна ответственность, дублей нет.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ВЕРСИЯ ПРИЛОЖЕНИЯ
// ═══════════════════════════════════════════════════════════════════════════════
const APP_VERSION = '0.9.0';

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
// СЛОЙ: CORE
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CORE/EventBus ─── START ────────────────────────────────────────────────
/**
 * Шина событий с точечными подписками и wildcard ('*').
 */
DI.register('EventBus', function () {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();
  /** @type {Set<Function>} */
  const wild = new Set();

  /**
   * Подписаться на событие.
   * @param {string} event - Имя события или '*'.
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
   * @param {string} event
   * @param {Function} fn
   * @returns {Function}
   */
  function once(event, fn) {
    const off = on(event, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }

  /**
   * Отписаться.
   * @param {string} event
   * @param {Function} fn
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
   * Эмит. Ошибки обработчиков изолированы.
   * @param {string} event
   * @param {*} [payload]
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
 * Логгер с уровнями, кольцевым буфером и цветным выводом.
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

  /** @type {number} */
  let threshold = LEVELS[Config.get('logLevel', 'info')] || LEVELS.info;

  /** @type {Array<Object>} */
  const ring = [];
  const RING_MAX = 200;

  const ts = () => new Date().toISOString().substr(11, 12);

  /**
   * Запись: буфер всегда, консоль — по порогу.
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} msg
   * @param {*} [data]
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
    /** @param {'debug'|'info'|'warn'|'error'} l */
    setLevel(l) {
      if (LEVELS[l]) threshold = LEVELS[l];
    },
    debug(m, d) { write('debug', m, d); },
    info(m, d) { write('info', m, d); },
    warn(m, d) { write('warn', m, d); },
    error(m, d) { write('error', m, d); },
    /** @returns {Array<Object>} */
    history() { return ring.slice(); },
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
 * Утилиты: экранирование, плюрализация, даты, debounce, uid.
 */
DI.register('Utils', function () {
  /** @type {Object<string, string>} */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /**
   * HTML-экранирование (зарезервировано: контент рендерится textContent).
   * @param {*} s
   * @returns {string}
   */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  }

  /**
   * Экранирование для RegExp.
   * @param {*} s
   * @returns {string}
   */
  function escRe(s) {
    return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Плюрализация.
   * @param {number} n @param {string} one @param {string} few @param {string} many
   * @returns {string}
   */
  function plural(n, one, few, many) {
    n = Math.abs(n);
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
    return many;
  }

  /** @type {Object<string, Function>} */
  const words = {
    symbols: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'char', 'chars', 'chars') : plural(n, 'символ', 'символа', 'символов')),
    peers: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'peer', 'peers', 'peers') : plural(n, 'узел', 'узла', 'узлов')),
    thoughts: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'note', 'notes', 'notes') : plural(n, 'мысль', 'мысли', 'мыслей')),
    descendants: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'heir', 'heirs', 'heirs') : plural(n, 'потомок', 'потомка', 'потомков')),
  };

  /**
   * @param {string} key @param {number} n @param {string} [lang]
   * @returns {string}
   */
  function word(key, n, lang) {
    const fn = words[key];
    return fn ? fn(n, lang) : String(n);
  }

  /**
   * Дата «12 мар».
   * @param {number} ts @param {string} [lang]
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
   * Время «14:05».
   * @param {number} ts @param {string} [lang]
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
   * Относительное время.
   * @param {number} ts @param {string} lang @param {Function} t
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
   * Сокращённый pubkey.
   * @param {string} pk
   * @returns {string}
   */
  const shortPk = pk => (pk ? pk.slice(0, 8) + '…' : '');

  /**
   * Уникальный идентификатор.
   * @param {string} [prefix]
   * @returns {string}
   */
  function uid(prefix) {
    return (prefix || 'n') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Debounce с отменой.
   * @param {Function} fn @param {number} ms
   * @returns {Function & {cancel: Function}}
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
 * Интернационализация ru/en.
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
   * Подстановка параметров.
   * @param {string} str @param {Object} [params]
   * @returns {string}
   */
  function format(str, params) {
    const s = String(str == null ? '' : str);
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  }

  /**
   * Перевод: текущий → en → fallback → ключ.
   * @param {string} key @param {Object} [params] @param {string} [fallback]
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
   * Регистрация словаря.
   * @param {string} lang @param {Object} dict
   */
  function addDict(lang, dict) {
    dicts[lang] = Object.assign(dicts[lang] || {}, dict || {});
  }

  /** Применить переводы к DOM. */
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
   * Сменить язык.
   * @param {string} lang
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
   * Подписка на смену языка.
   * @param {Function} fn
   */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

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
    'btn.paste': 'Вставить из буфера',
    'btn.on': 'Вкл',
    'btn.off': 'Выкл',

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
    'inf.orphan.hint': 'Источник недоступен',
    'inf.parent.unavailable': 'Источник недоступен: скрыт автором или удалён',

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
    'theme.dark': 'тёмная',
    'theme.light': 'светлая',
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

    'preview.relevant': 'Релевантно: ≥ {lo}%',
    'preview.seren': 'Озарения: {lo}%–{hi}%',
    'preview.hidden': 'Скрыто: < {lo}%',

    'del.confirm': 'Удалить эту заметку навсегда?',

    'net.loadmore': 'Загрузить ещё',
    'net.loading': 'Загружаю…',

    'note.public.noedit': 'Публичные заметки нельзя редактировать',
    'note.edit.placeholder': 'Текст заметки',

    'account.title': 'Аккаунт и ключ',
    'account.identity': 'Ваш ключ',
    'account.identity.desc': 'Ключ — это вы. Заметки синхронизируются между устройствами через зашифрованные события на вашем релее. Контент видите только вы.',
    'account.npub': 'Публичный адрес',
    'account.nsec.masked': 'Ключ скрыт',
    'account.nsec.hint': 'Никому не показывайте ключ. Если кто-то его получит — он станет вами.',
    'account.exported.mark': 'Ключ показан и скопирован',
    'account.password.set': 'Пароль',
    'account.password.hint': 'Пароль шифрует ключ (NIP-49). Оставьте пустым — без шифрования.',
    'account.enter.title': 'Вход по ключу',
    'account.enter.desc': 'Вставьте ключ (nsec… или ncryptsec…) с другого устройства. Текущие заметки и ключ будут заменены.',
    'account.enter.placeholder': 'nsec… или ncryptsec…',
    'account.enter.confirm': 'Заменить аккаунт?',
    'account.enter.confirm.d': 'Текущий ключ и локальные заметки будут удалены. Продолжить?',
    'account.enter.bad': 'Ключ не распознан',
    'account.enter.done': 'Аккаунт заменён, синхронизирую…',
    'account.import.done': 'Импортировано заметок: {count}',
    'account.data.section': 'Данные',
    'account.data.desc': 'Архив — страховка на случай, если релеи очистят данные.',
    'account.export.title': 'Экспорт',
    'account.export.desc': 'Файл или буфер обмена с заметками и настройками.',
    'account.export.withkey': 'Включить ключ',
    'account.export.withkey.hint': 'С ключом архив восстановит аккаунт целиком. Без ключа — только заметки на текущем аккаунте.',
    'account.import.title': 'Импорт',
    'account.import.desc': 'Заметки из архива будут добавлены (совпадающие по id — обновлены).',
    'account.import.file': 'Загрузить файл',
    'account.import.clip': 'Вставить из буфера',
    'account.import.clip.ph': 'Вставьте сюда JSON архива…',
    'account.import.confirm': 'Применить архив?',
    'account.import.bad': 'Файл не похож на архив NOOmium',
    'account.import.clip.empty': 'Буфер пуст или не похож на архив',
    'account.sync.status': 'Синхронизация',
    'account.sync.on': 'включена',
    'account.sync.off': 'выключена',
    'account.sync.running': 'идёт обмен…',
    'account.sync.hint': 'Зашифрованные копии заметок публикуются на релеи. Отключите, если не хотите ничего отправлять в сеть.',
    'account.sync.now': 'Синхронизировать',
    'account.sync.now.hint': 'Переподключиться к сети и вытянуть заметки с релеев.',

    'toast.key.copied': 'ключ скопирован',
    'toast.key.saved': 'ключ сохранён',
    'toast.account.migrated': 'заметки переносятся в облако…',
    'toast.sync.disabled': 'синхронизация выключена',
    'toast.sync.enabled': 'синхронизация включена',
    'toast.sync.now': 'переподключаюсь…',
    'toast.json.copied': 'JSON скопирован в буфер',
    'toast.clip.bad': 'не удалось прочитать буфер',

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
    'btn.paste': 'Paste from clipboard',
    'btn.on': 'On',
    'btn.off': 'Off',

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
    'inf.orphan.hint': 'Source unavailable',
    'inf.parent.unavailable': 'Source unavailable: hidden by author or deleted',

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
    'theme.dark': 'dark',
    'theme.light': 'light',
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

    'preview.relevant': 'Relevant: ≥ {lo}%',
    'preview.seren': 'Insights: {lo}%–{hi}%',
    'preview.hidden': 'Hidden: < {lo}%',

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
    'account.password.set': 'Password',
    'account.password.hint': 'Password encrypts the key (NIP-49). Leave empty — no encryption.',
    'account.enter.title': 'Sign in with key',
    'account.enter.desc': 'Paste a key (nsec… or ncryptsec…) from another device. Current notes and key will be replaced.',
    'account.enter.placeholder': 'nsec… or ncryptsec…',
    'account.enter.confirm': 'Replace account?',
    'account.enter.confirm.d': 'Current key and local notes will be deleted. Continue?',
    'account.enter.bad': 'Key not recognized',
    'account.enter.done': 'Account replaced, syncing…',
    'account.import.done': 'Notes imported: {count}',
    'account.data.section': 'Data',
    'account.data.desc': 'Archive is a safety net in case relays wipe their data.',
    'account.export.title': 'Export',
    'account.export.desc': 'File or clipboard with your notes and settings.',
    'account.export.withkey': 'Include key',
    'account.export.withkey.hint': 'With the key the archive restores the whole account. Without it — only notes on the current account.',
    'account.import.title': 'Import',
    'account.import.desc': 'Notes from the archive will be added (matching ids updated).',
    'account.import.file': 'Load file',
    'account.import.clip': 'Paste from clipboard',
    'account.import.clip.ph': 'Paste archive JSON here…',
    'account.import.confirm': 'Apply archive?',
    'account.import.bad': 'File does not look like a NOOmium archive',
    'account.import.clip.empty': 'Clipboard is empty or not an archive',
    'account.sync.status': 'Sync',
    'account.sync.on': 'on',
    'account.sync.off': 'off',
    'account.sync.running': 'exchanging…',
    'account.sync.hint': 'Encrypted copies of notes are published to relays. Turn off if you do not want anything sent to the network.',
    'account.sync.now': 'Sync now',
    'account.sync.now.hint': 'Reconnect to the network and pull notes from relays.',

    'toast.key.copied': 'key copied',
    'toast.key.saved': 'key saved',
    'toast.account.migrated': 'moving notes to the cloud…',
    'toast.sync.disabled': 'sync disabled',
    'toast.sync.enabled': 'sync enabled',
    'toast.sync.now': 'reconnecting…',
    'toast.json.copied': 'JSON copied to clipboard',
    'toast.clip.bad': 'could not read clipboard',

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

  /** Применить переводы к DOM (вызывается из BOOT). */
  function init() {
    applyToDOM();
  }

  return { t, addDict, setLang, getLang, onChange, applyToDOM, init };
}, ['Config', 'EventBus']);
// ─── CORE/I18n ─── END ──────────────────────────────────────────────────────

// ─── CORE/Config ─── START ──────────────────────────────────────────────────
/**
 * Конфигурация приложения: localStorage, схема v9, цепочка миграций.
 * v9: kCanon/kQuery/kAnswer; dbName noomium_v3 (notes+mirror);
 * notesStore/mirrorStore; чистка сетевых ключей v8.
 */
DI.register('Config', function () {
  const KEY = 'noomium:cfg';
  const SCHEMA_VERSION = 9;

  const defaults = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    room: 'noomium-main',
    theme: 'dark',
    lang: null,
    onboarded: false,
    logLevel: 'info',

    model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    dim: 384,
    aiCacheLimit: 300,
    aiEmbedTimeout: 15000,

    threshold: 0.81,
    serendipity: 0.07,
    duplicateThreshold: 0.88,
    similarityDisplay: 'signal',

    relays: [
      'wss://relay.primal.net',
      'wss://nostr.mom',
      'wss://nos.lol',
      'wss://purplerelay.com',
      'wss://nostr.oxtr.dev',
    ],
    kCanon: 30078,
    kQuery: 21000,
    kAnswer: 21001,
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

    dbName: 'noomium_v3',
    notesStore: 'notes',
    mirrorStore: 'mirror',

    debounce: 350,
    baseSearchDebounce: 200,
    truncateTextLength: 140,
    toastMaxVisible: 3,
    toastDefaultDuration: 2200,

    maxPostLength: 2500,
    softLimit: 1200,
    hardLimit: 2000,

    userThemeOverride: false,

    syncEnabled: true,
    keyExported: false,
  });

  const migrations = {
    1: s => s,
    2: s => s,
    3: s => s,
    4: s => s,
    5: s => {
      if (typeof s.threshold === 'number' && s.threshold === 0.65) {
        s.threshold = defaults.threshold;
      }
      if (typeof s.serendipity === 'number' && s.serendipity === 0.25) {
        s.serendipity = defaults.serendipity;
      }
      return s;
    },
    6: s => {
      if (typeof s.similarityDisplay !== 'string') {
        s.similarityDisplay = defaults.similarityDisplay;
      }
      return s;
    },
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
    8: s => {
      const dead = [
        'maxPasswordAttempts', 'influenceWeightByAge', 'indexerUrl',
        'premiumRelay', 'gpuRanking', 'cloudView', 'relayErrorThreshold',
        'relayCircuitBreakTime', 'relayBackoff1', 'relayBackoff2',
        'kNote', 'kPrivate', 'kDelete', 'syncMigrated',
      ];
      dead.forEach(k => { delete s[k]; });
      return s;
    },
    9: s => {
      s.dbName = defaults.dbName;
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
     * @param {string} k @param {*} [def] @returns {*}
     */
    get(k, def) { return (k in state) ? state[k] : def; },

    /**
     * @param {string} k @param {*} v
     */
    set(k, v) { state[k] = v; persist(); },

    save: persist,

    /**
     * @returns {Object}
     */
    defaults() { return Object.assign({}, defaults); },

    /**
     * @returns {Object}
     */
    all() { return Object.assign({}, state); },

    /**
     * @returns {number}
     */
    schemaVersion() { return SCHEMA_VERSION; },

    reset() {
      for (const k of Object.keys(defaults)) state[k] = defaults[k];
      persist();
    },
  };
});
// ─── CORE/Config ─── END ────────────────────────────────────────────────────

// ─── CORE/Store ─── START ───────────────────────────────────────────────────
/**
 * UI-состояние сессии: view, seg, context, sendMode, lists, feed.
 * Context пина v0.9: {uid, owner} — идентичность заметки (И1).
 */
DI.register('Store', function () {
  /**
   * @type {Object}
   * @property {string} view - 'stream' | 'base'
   * @property {string} seg - 'local' | 'world' | 'seren'
   * @property {Object} context - Контекст поиска
   * @property {string|null} context.source - 'pin' | 'drift' | 'input' | null
   * @property {string|null} context.uid - uid закреплённой заметки
   * @property {string|null} context.owner - pubkey владельца пина
   * @property {string} context.text - Текст контекста
   * @property {Float32Array|Array<number>|null} context.vector - Вектор
   * @property {string|null} context.pinText - Текст пина при дрейфе
   */
  const state = {
    view: 'stream',
    seg: 'local',
    context: { source: null, uid: null, owner: null, text: '', vector: null, pinText: null },
    sendMode: 'private',
    lists: { local: [], world: [], seren: [] },
    feed: [],
  };

  /** @type {Array<Function>} */
  const listeners = [];

  /**
   * @param {*} a @param {*} b
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

  /**
   * @returns {Object}
   */
  const snapshot = () => Object.freeze(Object.assign({}, state));

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

  /**
   * @returns {Object}
   */
  const getState = () => snapshot();

  /**
   * @param {string} k
   * @returns {*}
   */
  const get = k => state[k];

  /**
   * @param {Object} partial
   */
  function setState(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return;
    Object.assign(state, partial);
    notify();
  }

  /**
   * @param {Function} a - Слушатель или селектор
   * @param {Function} [b] - Слушатель (selector-вариант)
   * @param {Function} [equals] - Функция равенства
   * @returns {Function} Отписка
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
// СЛОЙ: DATA
// ═══════════════════════════════════════════════════════════════════════════════

// ─── DATA/Vec ─── START ─────────────────────────────────────────────────────
/**
 * Векторные операции: квантование base64, косинус, нормализация, kmeans.
 */
DI.register('Vec', function () {
  /**
   * @param {Float32Array|Array<number>} v
   * @returns {Float32Array}
   */
  const f32 = v => (v instanceof Float32Array ? v : Float32Array.from(v || []));

  /**
   * @param {Float32Array|Array<number>} vec
   * @returns {string}
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
   * @param {string} b64
   * @returns {Float32Array|null}
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
   * @param {Float32Array|Array<number>} a
   * @param {Float32Array|Array<number>} b
   * @returns {number}
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
   * @param {Float32Array|Array<number>} v
   * @returns {Float32Array}
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
   * @param {Array} vectors
   * @param {number} k
   * @param {number} [iterations]
   * @returns {Array<Float32Array>}
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
 * Хранение: notes (свои, истина владельца, keyPath uid) и
 * mirror (зеркало чужих, keyPath uid, index owner).
 * upsertMirror — строгое сравнение версий: повторная доставка и
 * ретро-доставка безопасны, порядок обработки любых версий
 * сходится к последней (И3).
 */
DI.register('DB', function (Config, bus, Logger) {
  let db = null;
  let memNotes = null;
  let memMirror = null;
  let openPromise = null;

  const NOTES = () => Config.get('notesStore', 'notes');
  const MIRROR = () => Config.get('mirrorStore', 'mirror');

  /** @type {Set<string>} */
  const ownUids = new Set();
  /** @type {Set<string>} */
  const mirrorUids = new Set();

  function emitChange() {
    try { bus.emit('db:change'); } catch (_) {}
  }

  function emitMirror() {
    try { bus.emit('db:mirror'); } catch (_) {}
  }

  /**
   * @param {IDBRequest} req
   * @returns {Promise<*>}
   */
  function reqPromise(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  /**
   * Открытие БД с построением индексов до резолва.
   * @returns {Promise<IDBDatabase|null>}
   */
  function open() {
    if (openPromise) return openPromise;

    openPromise = new Promise(resolve => {
      if (!window.indexedDB) {
        memNotes = new Map();
        memMirror = new Map();
        Logger.warn('DB: IndexedDB недоступен, in-memory fallback');
        return resolve(null);
      }

      try {
        const req = indexedDB.open(Config.get('dbName', 'noomium_v3'), 1);

        req.onupgradeneeded = e => {
          const d = e.target.result;

          if (!d.objectStoreNames.contains(NOTES())) {
            d.createObjectStore(NOTES(), { keyPath: 'uid' });
          }

          if (!d.objectStoreNames.contains(MIRROR())) {
            const s = d.createObjectStore(MIRROR(), { keyPath: 'uid' });
            s.createIndex('owner', 'owner', { unique: false });
          }
        };

        req.onsuccess = e => {
          db = e.target.result;
          buildIndexes().then(() => resolve(db)).catch(() => resolve(db));
        };

        req.onerror = () => {
          memNotes = new Map();
          memMirror = new Map();
          Logger.warn('DB: ошибка открытия, fallback');
          resolve(null);
        };

        req.onblocked = () => {
          memNotes = new Map();
          memMirror = new Map();
          Logger.warn('DB: open blocked, fallback');
          resolve(null);
        };
      } catch (err) {
        memNotes = new Map();
        memMirror = new Map();
        Logger.warn('DB: не поддерживается, fallback', String(err));
        resolve(null);
      }
    });

    return openPromise;
  }

  /**
   * Построение индексов ownUids/mirrorUids.
   * @returns {Promise<void>}
   */
  function buildIndexes() {
    const t = db.transaction([NOTES(), MIRROR()], 'readonly');

    return Promise.all([
      reqPromise(t.objectStore(NOTES()).getAllKeys()).catch(() => []),
      reqPromise(t.objectStore(MIRROR()).getAllKeys()).catch(() => []),
    ]).then(([nKeys, mKeys]) => {
      ownUids.clear();
      mirrorUids.clear();

      (nKeys || []).forEach(k => ownUids.add(k));
      (mKeys || []).forEach(k => mirrorUids.add(k));

      Logger.info('DB: индексы (' + ownUids.size + ' своих, ' + mirrorUids.size + ' в зеркале)');
    });
  }

  /**
   * @param {string} store
   * @param {string} mode
   * @param {Function} fn
   * @param {Function} memFn
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

  // ─── Свои заметки ─────────────────────────────────────────────────────────

  /**
   * Запись своей заметки. Единственная точка записи — Notes.
   * @param {Object} note - {uid, text, vector, visibility, parent, version, createdAt, updatedAt}
   * @returns {Promise<string>}
   */
  function putNote(note) {
    return withStore(
      NOTES(),
      'readwrite',
      s => s.put(note),
      () => { memNotes.set(note.uid, note); return note.uid; }
    ).then(res => {
      if (note && note.uid) ownUids.add(note.uid);
      emitChange();
      return res;
    });
  }

  /**
   * @param {string} uid
   * @returns {Promise<Object|undefined>}
   */
  function getNote(uid) {
    return withStore(
      NOTES(),
      'readonly',
      s => s.get(uid),
      () => memNotes.get(uid)
    );
  }

  /**
   * @param {string} uid
   * @returns {Promise<*>}
   */
  function delNote(uid) {
    return withStore(
      NOTES(),
      'readwrite',
      s => s.delete(uid),
      () => { memNotes.delete(uid); }
    ).then(res => {
      ownUids.delete(uid);
      emitChange();
      return res;
    });
  }

  /**
   * @returns {Promise<Array<Object>>}
   */
  function allNotes() {
    return withStore(
      NOTES(),
      'readonly',
      s => s.getAll(),
      () => Array.from(memNotes.values())
    );
  }

  /**
   * @param {string} uid
   * @returns {boolean}
   */
  function hasOwn(uid) {
    return !!uid && ownUids.has(uid);
  }

  // ─── Зеркало чужих ────────────────────────────────────────────────────────

  /**
   * Upsert записи зеркала по version. Downgrade и повтор одной
   * версии игнорируются — сходимость к последней версии (И3).
   * @param {Object} entry - {uid, owner, version, visibility,
   *   text?, vec?, parent?, deleted?}
   * @returns {Promise<boolean>} true — запись обновлена.
   */
  function upsertMirror(entry) {
    if (!entry || !entry.uid || typeof entry.version !== 'number') {
      return Promise.resolve(false);
    }

    return withStore(
      MIRROR(),
      'readonly',
      s => s.get(entry.uid),
      () => memMirror.get(entry.uid)
    ).then(existing => {
      if (existing && existing.version >= entry.version) {
        return false;
      }

      return withStore(
        MIRROR(),
        'readwrite',
        s => s.put(entry),
        () => { memMirror.set(entry.uid, entry); return entry.uid; }
      ).then(() => {
        mirrorUids.add(entry.uid);
        emitMirror();
        return true;
      });
    }).catch(e => {
      Logger.warn('DB: upsertMirror', String(e && e.message || e));
      return false;
    });
  }

  /**
   * @param {string} uid
   * @returns {Promise<Object|undefined>}
   */
  function getMirror(uid) {
    return withStore(
      MIRROR(),
      'readonly',
      s => s.get(uid),
      () => memMirror.get(uid)
    );
  }

  /**
   * @returns {Promise<Array<Object>>}
   */
  function allMirror() {
    return withStore(
      MIRROR(),
      'readonly',
      s => s.getAll(),
      () => Array.from(memMirror.values())
    );
  }

  /**
   * @param {string} uid
   * @returns {Promise<*>}
   */
  function delMirror(uid) {
    return withStore(
      MIRROR(),
      'readwrite',
      s => s.delete(uid),
      () => { memMirror.delete(uid); }
    ).then(res => {
      mirrorUids.delete(uid);
      emitMirror();
      return res;
    });
  }

  /**
   * Полная очистка хранилищ.
   * @returns {Promise<void>}
   */
  function reset() {
    return open().then(d => {
      if (!d) {
        memNotes.clear();
        memMirror.clear();
        return;
      }

      return new Promise((res, rej) => {
        const t = d.transaction([NOTES(), MIRROR()], 'readwrite');
        t.objectStore(NOTES()).clear();
        t.objectStore(MIRROR()).clear();

        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    }).then(() => {
      ownUids.clear();
      mirrorUids.clear();
      emitChange();
      emitMirror();
    });
  }

  return {
    putNote,
    getNote,
    delNote,
    allNotes,
    hasOwn,

    upsertMirror,
    getMirror,
    allMirror,
    delMirror,

    reset,

    ready: open,
  };
}, ['Config', 'EventBus', 'Logger']);
// ─── DATA/DB ─── END ────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: AI
// ═══════════════════════════════════════════════════════════════════════════════

// ─── AI/Embedder ─── START ──────────────────────────────────────────────────
/**
 * Эмбеддер Granite R2: Web Worker + transformers.js (q8, CLS-pooling).
 * Режимы: 'loading' | 'model' | 'demo'. Fallback — FNV-1a хеш.
 */
DI.register('Embedder', function (Config, bus, Logger) {
  /** @type {string} */
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
   * @param {string} text
   * @returns {Float32Array}
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
   * @param {string} key
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
   * @param {string} key
   * @param {Float32Array} v
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
   * Аварийная очистка: pending разрешаются хеш-векторами.
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
   * Загрузка модели: Worker → 'ready' | таймаут 120с | ошибка → demo.
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

      const LOAD_TIMEOUT = 120000;
      let resolved = false;

      const loadTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        Logger.warn('Embedder: таймаут загрузки модели (120с), demo mode');
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
     * @param {Function} [onProgress]
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
     * @param {string} text
     * @returns {Promise<Float32Array|null>}
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
     * @returns {boolean}
     */
    ready() {
      return mode === 'model' || mode === 'demo';
    },

    /**
     * @returns {string}
     */
    getMode() {
      return mode;
    },

    /**
     * @param {Function} fn
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
 * Ранжирование: пакетный косинус, пороги relevant/serendipity,
 * проверка дубликатов по векторам.
 */
DI.register('Ranker', function (Vec, Config) {
  /**
   * @param {Float32Array|number[]} queryVector
   * @param {Array<{id: string, vector: Array|Float32Array}>} items
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{id: string, score: number}>>}
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
   * @param {Array<{id: string, score: number}>} scored
   * @returns {{relevant: Array, seren: Array}}
   */
  function split(scored) {
    const threshold = Config.get('threshold', 0.81);
    const serendipity = Config.get('serendipity', 0.07);

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
// СЛОЙ: NET
// ═══════════════════════════════════════════════════════════════════════════════

// ─── NET/Nostr ─── START ────────────────────────────────────────────────────
/**
 * Транспорт: nostr-tools с CDN, ключ, SimplePool, publish (>=1 релей,
 * таймаут 30с), subscribe. setKey для смены аккаунта.
 */
// ─── NET/Nostr ─── END ──────────────────────────────────────────────────────

// ─── NET/Vault ─── START ────────────────────────────────────────────────────
/**
 * Шифрование канона: NIP-44 self-ECDH. seal/open — единственная точка
 * криптографии payload.
 */
// ─── NET/Vault ─── END ──────────────────────────────────────────────────────

// ─── NET/Crypto ─── START ───────────────────────────────────────────────────
/**
 * Криптография аккаунта: nsec/npub/ncryptsec форматы, NIP-49.
 */
// ─── NET/Crypto ─── END ─────────────────────────────────────────────────────

// ─── NET/Protocol ─── START ─────────────────────────────────────────────────
/**
 * Кодек событий: канон состояний (canonPrivate/canonPublic/canonDeleted,
 * decodeCanon — свои расшифровывает, чужие публичные читает, чужие
 * приватные дают only-fact), запрос (queryEvent/decodeQuery),
 * ответ-ссылка (answerEvent/decodeAnswer). syncVersion для монотонности.
 */
// ─── NET/Protocol ─── END ───────────────────────────────────────────────────

// ─── NET/NetService ─── START ───────────────────────────────────────────────
/**
 * Движение: подписка на комнату (kinds 30078/21000/21001 по t),
 * подписка на себя, публикация канона (паблиш-очередь: uids в
 * localStorage, flush при canPublish), ответы на запросы по своим
 * публичным, отправка запросов при контексте. Экспоненциальный
 * реконнект, rate-лимиты. Никакой интерпретации смысла —
 * события передаются Mirror/Notes через шину.
 */
// ─── NET/NetService ─── END ─────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: DOMAIN
// ═══════════════════════════════════════════════════════════════════════════════

// ─── DOMAIN/Notes ─── START ─────────────────────────────────────────────────
/**
 * Переходы состояний своих заметок. Единственная точка записи в
 * notes. Каждая операция = bump version + запись + шина note:*,
 * паблиш-очередь обновляется. create/edit/hide/show/delete.
 */
// ─── DOMAIN/Notes ─── END ───────────────────────────────────────────────────

// ─── DOMAIN/Mirror ─── START ────────────────────────────────────────────────
/**
 * Интерпретация входящих канонов: расшифровка (Protocol), свои —
 * применение к notes (синк устройств), чужие — upsertMirror.
 * Deleted — вычистка. Подтяжка по ответам-ссылкам. Единственная
 * точка записи в mirror.
 */
// ─── DOMAIN/Mirror ─── END ──────────────────────────────────────────────────

// ─── DOMAIN/Context ─── START ───────────────────────────────────────────────
/**
 * Пин/дрейф/ввод. Пин = снимок {uid, owner, vector, text}.
 */
// ─── DOMAIN/Context ─── END ─────────────────────────────────────────────────

// ─── DOMAIN/Feed ─── START ──────────────────────────────────────────────────
/**
 * Сборка лент: хронология (notes public + mirror public) и
 * ранжирование по контексту. Дедуп: свои доминируют над зеркалом
 * по (uid, owner). Исключение пина по идентичности (И7).
 */
// ─── DOMAIN/Feed ─── END ────────────────────────────────────────────────────

// ─── DOMAIN/Provenance ─── START ────────────────────────────────────────────
/**
 * Генеалогия по parent {uid, owner} через notes + mirror.
 * Фотография: родительский текст фиксируется у ребёнка при ответе.
 */
// ─── DOMAIN/Provenance ─── END ──────────────────────────────────────────────

// ─── DOMAIN/Influence ─── START ─────────────────────────────────────────────
/**
 * Резонанс: уникальные авторы потомков по ключу (uid, owner).
 */
// ─── DOMAIN/Influence ─── END ───────────────────────────────────────────────

// ─── DOMAIN/Account ─── START ───────────────────────────────────────────────
/**
 * Аккаунт: ключи (nsec/npub/ncryptsec), вход, архив v3
 * ({version, app, pubkey, ncryptsec?, notes, config}).
 */
// ─── DOMAIN/Account ─── END ─────────────────────────────────────────────────

// ─── DOMAIN/NoteActions ─── START ───────────────────────────────────────────
/**
 * UI-действия: remove/toggle/copy через Notes + подтверждения.
 */
// ─── DOMAIN/NoteActions ─── END ─────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: UI
// ═══════════════════════════════════════════════════════════════════════════════

// ─── UI/Modal ─── START ─────────────────────────────────────────────────────
/**
 * Модалки: open/close/confirm, Escape, возврат фокуса.
 */
// ─── UI/Modal ─── END ───────────────────────────────────────────────────────

// ─── UI/Toast ─── START ─────────────────────────────────────────────────────
/**
 * Тосты: 4 типа, лимит, haptic.
 */
// ─── UI/Toast ─── END ───────────────────────────────────────────────────────

// ─── UI/Progress ─── START ──────────────────────────────────────────────────
/**
 * Оверлей загрузки модели.
 */
// ─── UI/Progress ─── END ────────────────────────────────────────────────────

// ─── UI/HeaderStatus ─── START ──────────────────────────────────────────────
/**
 * Индикаторы сети/ИИ, офлайн-бар, клик-переподключение.
 */
// ─── UI/HeaderStatus ─── END ────────────────────────────────────────────────

// ─── UI/Onboarding ─── START ────────────────────────────────────────────────
/**
 * Онбординг: 8 секций, флажок.
 */
// ─── UI/Onboarding ─── END ──────────────────────────────────────────────────

// ─── UI/Composer ─── START ──────────────────────────────────────────────────
/**
 * Ввод: лимиты, тумблер видимости, отправка через Notes.create.
 */
// ─── UI/Composer ─── END ────────────────────────────────────────────────────

// ─── UI/FeedView ─── START ──────────────────────────────────────────────────
/**
 * Рендер ленты: три режима, карточки, связи, резонанс, история.
 */
// ─── UI/FeedView ─── END ────────────────────────────────────────────────────

// ─── UI/BaseView ─── START ──────────────────────────────────────────────────
/**
 * База: статистика, поиск, сортировка по notes.
 */
// ─── UI/BaseView ─── END ────────────────────────────────────────────────────

// ─── UI/NoteView ─── START ──────────────────────────────────────────────────
/**
 * Просмотр: свои (удалить/видимость/пин/правка), чужие (просмотр/пин).
 */
// ─── UI/NoteView ─── END ────────────────────────────────────────────────────

// ─── UI/AccountView ─── START ───────────────────────────────────────────────
/**
 * Аккаунт: ключ, вход, экспорт/импорт, синк.
 */
// ─── UI/AccountView ─── END ─────────────────────────────────────────────────

// ─── UI/MenuView ─── START ──────────────────────────────────────────────────
/**
 * Меню: тема, язык, ранжирование, аккаунт, сбросы.
 */
// ─── UI/MenuView ─── END ────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: PLATFORM
// ═══════════════════════════════════════════════════════════════════════════════

// ─── PLATFORM/TelegramAdapter ─── START ─────────────────────────────────────
/**
 * Telegram Mini Apps: тема, haptic, нативные диалоги.
 */
// ─── PLATFORM/TelegramAdapter ─── END ───────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// СЛОЙ: BOOT
// ═══════════════════════════════════════════════════════════════════════════════

// ─── BOOT ─── START ─────────────────────────────────────────────────────────
/**
 * Старт: тема/i18n → подписчики → Telegram → Context → DOM →
 * wipe-обработчик → показ → Embedder+NetService+Mirror → онбординг.
 */
// ─── BOOT ─── END ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════════════════════════════════════════════
window.DI = DI;

try {
  DI.resolve('Boot').mount();
} catch (e) {
  console.error('[NOOmium] запуск упал:', e);
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100dvh;padding:20px;font:500 14px -apple-system,sans-serif;color:#fafafa;background:#0a0a0b;text-align:center">NOOmium не запустился. Обновите страницу.<br>Если повторится — пришлите скриншот консоли (F12).</div>';
}
