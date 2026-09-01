// ═════════════════════════════════════════════════════════════════════════════
// NOOmium — app.js v1.0.0 «Чистый лист»
// Соцсеть смыслов: мысли ищутся по значению, а не по словам.
//
// МОДЕЛЬ v1 (унаследована от v0.9):
// - Заметка = (uid, owner). Истина — у владельца. Канон kind 30078, d = uid.
// - Все переходы = новые версии одного события. version = noteVersion
//   (монотонный счётчик владельца, живёт в payload канона).
// - created_at канона = секунда публикации (свежесть для since-окон).
// - Зеркало сходится upsert'ом по noteVersion payload; created_at — fallback.
// - Удалённый канон — открытый факт, несёт noteVersion на момент удаления.
// - Ответ на запрос (21001) — ссылка (uid, owner), не копия.
// - Офлайн: операции владельца мгновенны локально, сеть догоняет.
//
// ЗАКОНЫ КАРКАСА:
// 1. Контент юзера/сети — только через textContent / createElement. Никакого
//    innerHTML с данными. (XSS)
// 2. Методы DOMAIN/Notes reject'ят при ошибке. UI обязан обрабатывать
//    reject — текст пользователя неприкосновенен. (B-02)
// 3. Embedder без fallback-хешей: embed() → null, пока модель не готова.
//    Заметки без вектора легальны; Notes.backfill() доэмбеддит их после
//    ai:ready. (B-01)
// 4. Публикация только при version > publishedVersion. (M-03)
// 5. Слои: CORE / DATA / AI / NET / DOMAIN / UI / PLATFORM / BOOT.
//    DOMAIN не импортирует UI. UI не пишет в DB напрямую.
// 6. Тихие catch — только с Logger.warn. Голый catch(_) допускается только
//    там, где ошибка объективно не важна, и это указано в комментарии.
//
// СЛОИ И ПОРЯДОК: см. BOOT.mount — он единственный оркестратор.
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

const APP_VERSION = '1.0.1';

// ═══ РЕЕСТР СОБЫТИЙ ШИНЫ (полный контракт) ════════════════════════════════════
//
// ai:progress   Embedder → Progress            {pct, loadedMB, totalMB, model}
// ai:status     Embedder → HeaderStatus, Progress  {mode:'loading'|'model', percent?}
// ai:ready      Embedder → Boot (→ Notes.backfill), HeaderStatus   (однократно)
//
// net:status    NetService → HeaderStatus      {status: connecting|connected|
//               reconnecting|failed|disconnected}
// net:canon     NetService → Mirror            (raw Nostr event kind 30078)
// net:answer    NetService → Mirror            {queryId, uid, owner, score}
// net:history   NetService → FeedView          {loading, window}
// net:resync    NetService → Mirror            (сброс fetched-дедупа)
//
// sync:status   NetService → AccountView       {phase: 'off'|'active'|'idle'}
// sync:toggle   Account → NetService           {enabled}
//
// db:change     DB → Feed, Influence, Provenance, FeedView, BaseView, NetService
// db:mirror     DB → Feed, Influence, Provenance, FeedView
//               (не эмитится из updatePublishState — тихая запись)
//
// note:created  Notes, Account(импорт) → NetService(очередь), Influence
// note:updated  Notes → NetService(очередь), Influence
// note:deleted  Notes → NetService(очередь deleted), Influence(rebuild)
// note:pin      NoteView → Context              {uid, owner, text, vector}
// note:open     FeedView, BaseView, модалки → NoteView  {uid}
// notes:imported Account → Notes               {maxVersion}
//
// account:changed Account → NetService(сброс), AccountView(ре-открыть) {pubkey}
// i18n:change   I18n → все UI-модули            {lang}
// influence:updated Influence → FeedView
// mirror:fetch  Mirror → NetService             {uid, owner}
// wipe:request  MenuView → Boot                 (локальная очистка + сетевой wipe)
// telegram:theme TelegramAdapter → (резерв)
//
// view, seg, sendMode, context, feed, lists — ТОЛЬКО через Store.subscribe.
// Событий view:changed / view:set / editor:sent / config:imported НЕТ.
// ═════════════════════════════════════════════════════════════════════════════

// ═══ CORE/DI ═════════════════════════════════════════════════════════════════
// Контейнер зависимостей: ленивый резолв, кэш, защита от циклов. Реализован —
// это часть каркаса. (Без изменений от v0.9.9)
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

// ═══ СЛОЙ: CORE ═══════════════════════════════════════════════════════════════

// ─── CORE/EventBus ─── START ────────────────────────────────────────────────
/**
 * Шина событий. Контракт — см. РЕЕСТР в шапке файла.
 * on/once/off/emit, wildcard '*'. Ошибки обработчиков изолированы.
 * Итерация по копии множества: подписка/отписка внутри emit безопасны.
 */
DI.register('EventBus', function () {
  const map = new Map();
  const wild = new Set();

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

  function once(event, fn) {
    const off = on(event, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }

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

  function emit(event, payload) {
    const s = map.get(event);
    if (s) {
      for (const fn of Array.from(s)) {
        try { fn(payload); } catch (e) { console.error('[bus:' + event + ']', e); }
      }
    }
    if (wild.size) {
      for (const fn of Array.from(wild)) {
        try { fn(event, payload); } catch (e) { console.error('[bus:*]', e); }
      }
    }
  }

  return { on, once, off, emit };
}, []);
// ─── CORE/EventBus ─── END ──────────────────────────────────────────────────

// ─── CORE/Logger ─── START ──────────────────────────────────────────────────
/**
 * Уровни debug/info/warn/error, кольцевой буфер 200, цветной вывод,
 * history()/dump() — инфраструктура «пришлите логи» для баг-репортов.
 * Порог читается из Config при создании; setLevel — на лету.
 */
DI.register('Logger', function (Config) {
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const COLORS = {
    debug: 'color:#56c2b8',
    info: 'color:#e8a33d',
    warn: 'color:#e5c156',
    error: 'color:#e5646e;font-weight:bold',
  };

  let threshold = LEVELS[Config.get('logLevel', 'info')] || LEVELS.info;

  const ring = [];
  const RING_MAX = 200;

  const ts = () => new Date().toISOString().slice(11, 23);

  function write(level, msg, data) {
    const time = ts();
    ring.push({ ts: time, level, msg, data });
    if (ring.length > RING_MAX) ring.shift();

    if (LEVELS[level] < threshold) return;
    const fn = console[level] || console.log;
    const prefix = '%c[' + time + '][' + level.toUpperCase() + ']';
    if (data === undefined) fn(prefix, COLORS[level], msg);
    else fn(prefix, COLORS[level], msg, data);
  }

  return {
    setLevel(l) { if (LEVELS[l]) threshold = LEVELS[l]; },
    debug(m, d) { write('debug', m, d); },
    info(m, d) { write('info', m, d); },
    warn(m, d) { write('warn', m, d); },
    error(m, d) { write('error', m, d); },
    history() { return ring.slice(); },
    dump() {
      for (const r of ring) {
        const fn = console[r.level] || console.log;
        fn('[' + r.ts + '][' + r.level.toUpperCase() + ']',
          r.msg, r.data === undefined ? '' : r.data);
      }
    },
  };
}, ['Config']);
// ─── CORE/Logger ─── END ────────────────────────────────────────────────────

// ─── CORE/Utils ─── START ───────────────────────────────────────────────────
/**
 * esc (зарезервирован законом 1), escRe, plural, word, fmtDate/fmtTime/
 * fmtRelativeTime, shortPk, uid (crypto), debounce (с cancel).
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9:
 * - uid: crypto.getRandomValues (6 случайных байт) вместо Math.random —
 *   коллизии на одной миллисекунде практически исключены.
 * - fmtRelativeTime: ts из будущего (разошедшиеся часы клиента/релея)
 *   возвращает fmtDate вместо пустой строки — дата не «исчезает».
 */
DI.register('Utils', function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  }

  function escRe(s) {
    return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function plural(n, one, few, many) {
    n = Math.abs(n);
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
    return many;
  }

  const words = {
    symbols: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'char', 'chars', 'chars') : plural(n, 'символ', 'символа', 'символов')),
    peers: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'peer', 'peers', 'peers') : plural(n, 'узел', 'узла', 'узлов')),
    thoughts: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'note', 'notes', 'notes') : plural(n, 'мысль', 'мысли', 'мыслей')),
    descendants: (n, l) => n + ' ' + (l === 'en' ? plural(n, 'heir', 'heirs', 'heirs') : plural(n, 'потомок', 'потомка', 'потомков')),
  };

  function word(key, n, lang) {
    const fn = words[key];
    return fn ? fn(n, lang) : String(n);
  }

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

  function fmtRelativeTime(ts, lang, t) {
    if (!ts || typeof t !== 'function') return '';
    const diff = Date.now() - ts;
    if (diff < 0) return fmtDate(ts, lang); // будущее → дата, не пустота
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return t('time.now');
    const min = Math.floor(sec / 60);
    if (min < 60) {
      return min + ' ' + plural(min, t('time.min.one'), t('time.min.few'), t('time.min.many'));
    }
    const hr = Math.floor(min / 60);
    if (hr < 24) {
      return hr + ' ' + plural(hr, t('time.hr.one'), t('time.hr.few'), t('time.hr.many'));
    }
    const day = Math.floor(hr / 24);
    if (day < 30) {
      return day + ' ' + plural(day, t('time.day.one'), t('time.day.few'), t('time.day.many'));
    }
    return fmtDate(ts, lang);
  }

  const shortPk = pk => (pk ? pk.slice(0, 8) + '…' : '');

  function uid(prefix) {
    let rand = '';
    try {
      const b = new Uint8Array(6);
      crypto.getRandomValues(b);
      for (let i = 0; i < b.length; i++) rand += b[i].toString(36).padStart(2, '0');
      rand = rand.slice(0, 6);
    } catch (_) {
      rand = Math.random().toString(36).slice(2, 8); // очень старые окружения
    }
    return (prefix || 'n') + Date.now().toString(36) + rand;
  }

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
}, []);
// ─── CORE/Utils ─── END ─────────────────────────────────────────────────────

// ─── CORE/I18n ─── START ────────────────────────────────────────────────────
/**
 * Интернационализация ru/en.
 * t(): каскад текущий → en → fallback → ключ; format {param}.
 * applyToDOM: data-i18n / data-i18n-ph / data-i18n-aria.
 * setLang: persist в Config + applyToDOM + onChange + bus 'i18n:change'.
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9 (словари):
 * + 'st.ai.off' (вместо 'st.ai.demo' — demo-режима больше нет)
 * + 'progress.skip' — кнопка «Продолжить без ИИ» на оверлее загрузки
 * + 'ai.pending' — подсказка композера, пока модель учится
 * + 'toast.save.fail' — ошибка сохранения (B-02)
 * + 'toast.wipe.offline' — честный офлайн-вайп (H-04)
 * + 'toast.pin.novector' — пин без вектора (H-03)
 * ~ 'ranking.threshold.hint' — диапазон исправлен на 50%–95% (H-06)
 * − 'note.public.noedit' — рудимент (M-05, консенсус)
 */
DI.register('I18n', function (Config, bus) {
  const dicts = Object.create(null);
  const listeners = [];
  let current = 'ru';

  const saved = Config.get('lang', null);
  if (saved === 'ru' || saved === 'en') {
    current = saved;
  } else {
    current = (navigator.language || 'ru').toLowerCase().indexOf('ru') === 0 ? 'ru' : 'en';
  }

  function format(str, params) {
    const s = String(str == null ? '' : str);
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  }

  function t(key, params, fallback) {
    const d = dicts[current] || {};
    let val = Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    if (val === undefined) {
      const en = dicts['en'] || {};
      val = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : undefined;
    }
    return format(val !== undefined ? val : (fallback !== undefined ? fallback : key), params);
  }

  function addDict(lang, dict) {
    dicts[lang] = Object.assign(dicts[lang] || {}, dict || {});
  }

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
    } catch (_) {} // DOM-элементы недоступны до body.ready — не критично
  }

  function setLang(lang) {
    if (lang !== 'ru' && lang !== 'en') return;
    current = lang;
    Config.set('lang', current);
    applyToDOM();
    for (const fn of listeners.slice()) {
      try { fn(current); } catch (_) {}
    }
    try { bus.emit('i18n:change', { lang: current }); } catch (_) {}
  }

  const getLang = () => current;

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  addDict('ru', {
    'st.net': 'сеть',
    'st.ai.loading': 'модель',
    'st.ai.ready': 'ии',
    'st.ai.off': 'ии нет',
    'st.net.online': 'онлайн',
    'st.net.connecting': 'соединение',
    'st.net.reconnecting': 'пересоединение',
    'st.net.failed': 'нет сети',
    'net.offline': 'офлайн — заметки сохраняются локально',

    'progress.title': 'Загружаем модель',
    'progress.skip': 'Продолжить без ИИ',

    'ed.placeholder': 'О чём думаешь?',
    'ed.chars': 'симв.',
    'ed.limit.soft': 'Для точного поиска пиши короче',
    'ed.limit.hard': 'Вектор обрезается, качество поиска низкое',
    'ed.limit.max': 'Максимум {max} символов',
    'ai.pending': 'ии учится: мысль сохранится и научится искаться позже',

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
    'toast.save.fail': 'не удалось сохранить',
    'toast.empty': 'напиши что-нибудь',
    'toast.base.wiped': 'база очищена',
    'toast.edit.saved': 'сохранено',
    'toast.wipe.offline': 'офлайн — копии в сети останутся',
    'toast.pin.novector': 'мысль ещё не научилась искаться',

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
    'ranking.threshold.hint': 'Минимальное сходство для показа в ленте (50%–95%)',
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
    'st.ai.off': 'no ai',
    'st.net.online': 'online',
    'st.net.connecting': 'connecting',
    'st.net.reconnecting': 'reconnecting',
    'st.net.failed': 'offline',
    'net.offline': 'offline — notes are saved locally',

    'progress.title': 'Loading model',
    'progress.skip': 'Continue without AI',

    'ed.placeholder': 'What are you thinking?',
    'ed.chars': 'chars',
    'ed.limit.soft': 'Shorter text = more precise search',
    'ed.limit.hard': 'Vector will be truncated, search quality drops',
    'ed.limit.max': 'Maximum {max} characters',
    'ai.pending': 'ai is learning: the thought will be saved and become searchable later',

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
    'toast.save.fail': 'failed to save',
    'toast.empty': 'write something',
    'toast.base.wiped': 'base wiped',
    'toast.edit.saved': 'saved',
    'toast.wipe.offline': 'offline — copies on relays remain',
    'toast.pin.novector': 'this thought is not searchable yet',

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
    'ranking.threshold.hint': 'Minimum similarity to show in feed (50%–95%)',
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
 * Конфигурация: localStorage 'noomium:cfg', схема v10.
 * v9 → v10: identity-миграция (поля не менялись; версия поднята
 * для новой эпохи сборки). Загрузка с проверкой типов: значение
 * битого типа не копируется — остаётся default.
 * При битом JSON — бэкап сырой строки в 'noomium:cfg.broken'
 * (Logger недоступен из-за цикла зависимостей — console напрямую).
 */
DI.register('Config', function () {
  const KEY = 'noomium:cfg';
  const BROKEN_KEY = 'noomium:cfg.broken';
  const SCHEMA_VERSION = 10;

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
    10: s => s, // identity: поля и формат не менялись
  };

  const state = Object.assign({}, defaults);

  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        let v = saved.schemaVersion || saved.version || 1;
        while (v < SCHEMA_VERSION) {
          const migrate = migrations[v];
          if (typeof migrate === 'function') saved = migrate(saved);
          v++;
        }
        saved.schemaVersion = SCHEMA_VERSION;

        // Копируем только ключи из defaults И только совпадающего типа.
        for (const k of Object.keys(defaults)) {
          if (!(k in saved)) continue;
          const d = defaults[k];
          const s = saved[k];
          const ok = Array.isArray(d) ? Array.isArray(s)
            : d === null ? (s === null || typeof s === 'string')
            : typeof s === typeof d;
          if (ok) state[k] = s;
        }
      }
    }
  } catch (_) {
    // Битый JSON: сохраняем сырую строку для разбора полётов, живём на defaults.
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) localStorage.setItem(BROKEN_KEY, raw);
    } catch (_) {}
    console.warn('[NOOmium] config повреждён — сброшен к значениям по умолчанию');
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[NOOmium] config не сохранён (quota?)', String(e));
    }
  }

  console.info('[NOOmium] v' + APP_VERSION + ' · config готов (schema v' + SCHEMA_VERSION + ')');

  return {
    get(k, def) { return (k in state) ? state[k] : def; },
    set(k, v) { state[k] = v; persist(); },
    save: persist,
    defaults() { return Object.assign({}, defaults); },
    all() { return Object.assign({}, state); },
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
 * context: {source: 'pin'|'drift'|'input'|null, uid, owner, text,
 *   vector, pinText}.
 *
 * КОНТРАКТ v1.0:
 * - view меняется только через setState; DOM-переключение панелей —
 *   единый подписчик в MenuView.applyView.
 * - context всегда ЗАМЕНЯЕТСЯ новым объектом (Context.push), никогда
 *   не мутируется на месте — подписки Object.is/shallowEqual корректны.
 * - snapshot: замороженная копия верхнего уровня + защищённые копии
 *   вложенных рабочих объектов (context — freeze, lists/feed —
 *   свежие массивы). Слушатель не может мутировать живое состояние
 *   через снапшот (v1.0.1: в v1.0.0 freeze был поверхностным).
 */
DI.register('Store', function () {
  const state = {
    view: 'stream',
    seg: 'local',
    context: { source: null, uid: null, owner: null, text: '', vector: null, pinText: null },
    sendMode: 'private',
    lists: { local: [], world: [], seren: [] },
    feed: [],
  };

  const listeners = [];

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
   * Защищённый снапшот: верх заморожен; context — замороженная копия;
   * lists/feed — копии массивов (push/pop из снапшота не трогает
   * живые данные; сам объект lists тоже заморожен).
   * Элементы массивов (карточки лент) остаются общими ссылками —
   * только для чтения; DOM-модули рендерят их без мутаций.
   */
  const snapshot = () => Object.freeze(Object.assign(
    {},
    state,
    { context: Object.freeze(Object.assign({}, state.context)) },
    { lists: Object.freeze({
        local: state.lists.local.slice(),
        world: state.lists.world.slice(),
        seren: state.lists.seren.slice(),
      }) },
    { feed: state.feed.slice() }
  ));

  function notify() {
    const snap = snapshot();
    for (const l of listeners.slice()) {
      try { l(snap); } catch (e) { console.error('[store]', e); }
    }
  }

  const getState = () => snapshot();
  const get = k => state[k];

  function setState(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return;
    Object.assign(state, partial);
    notify();
  }

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
}, []);
// ─── CORE/Store ─── END ─────────────────────────────────────────────────────

// ═══ СЛОЙ: DATA ═══════════════════════════════════════════════════════════════

// ─── DATA/Vec ─── START ─────────────────────────────────────────────────────
/**
 * Векторные операции: квантование base64 (int16), косинус (dot по
 * min-длине — контракт: все векторы нормализованы), нормализация,
 * sqDist, kmeans (farthest-first, детерминированный).
 * Формат без изменений от v0.9.9 — round-trip с канонами на релеях.
 */
DI.register('Vec', function () {
  /**
   * @param {Float32Array|Array<number>} v
   * @returns {Float32Array}
   */
  const f32 = v => (v instanceof Float32Array ? v : Float32Array.from(v || []));

  /**
   * Квантование в base64: clamp ±1 → int16 (×32767) → байты → btoa.
   * Ненормализованный вход теряет точность выше ±1 — контракт:
   * сохраняются только нормализованные векторы.
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
   * Из base64: int16 → float (/32767) → нормализация.
   * Нечётная/пустая строка, битый b64 → null.
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
   * Косинус = dot product по min-длине (векторы нормализованы).
   * Нулевые/пустые → 0.
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
   * @returns {Float32Array} Нулевой вектор при нулевой норме.
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
   * k-means: инициализация farthest-first (детерминированная),
   * до `iterations` (по умолчанию 10) проходов.
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
}, []);
// ─── DATA/Vec ─── END ───────────────────────────────────────────────────────

// ─── DATA/DB ─── START ──────────────────────────────────────────────────────
/**
 * Хранение: notes (свои) + mirror (чужие). IndexedDB noomium_v3
 * (данные v0.9 читаются как есть). In-memory fallback при недоступности.
 *
 * Формат mirror-записи = результат Protocol.decodeCanon:
 *   {uid, owner, version (created_at канона, fallback-версия),
 *    noteVersion? (истина заметки из payload — приоритетна),
 *    visibility, text?, vec?, parent?, ts?, deleted?}
 *
 * Формат notes-записи (модель v1.0):
 *   {uid, text, vector: Array|null, visibility, parent, version,
 *    publishedVersion, createdAt, updatedAt}
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9:
 * 1. upsertMirror — ОДНА readwrite-транзакция (get → решение → put):
 *    конкурентные upsert одного uid сериализуются движком, TOCTOU-окна
 *    нет. Сходимость: LWW по noteVersion (payload), fallback version
 *    (created_at); равные → richer-wins + мердж недостающих полей;
 *    deleted-факт побеждает равную версию (эхо-удаление).
 * 2. updatePublishState(uid, version) — тихая запись publishedVersion
 *    БЕЗ db:change (иначе цикл: публикация → событие → рендер).
 * 3. close() — закрытие соединения для fullReset; после close все
 *    операции тихо уходят в память, соединение НЕ переоткрывается.
 * 4. onblocked: ждём до 10с, потом mem-fallback (вместо мгновенного
 *    провала в память при мульти-табе).
 */
DI.register('DB', function (Config, bus, Logger) {
  let db = null;
  let memNotes = null;
  let memMirror = null;
  let openPromise = null;
  let closed = false;

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
   * Открытие соединения. Кэшируется; после close() — всегда null (mem).
   * @returns {Promise<IDBDatabase|null>}
   */
  function open() {
    if (openPromise) return openPromise;
    if (closed) return Promise.resolve(null);

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

        // Блокировано другой вкладкой: даём 10с на снятие блока,
        // потом деградируем в память (а не мгновенно, как в v0.9.9).
        req.onblocked = () => {
          Logger.warn('DB: открытие заблокировано (другая вкладка?), жду 10с');
          setTimeout(() => {
            if (db) return; // блок снят, onsuccess уже отработал
            memNotes = new Map();
            memMirror = new Map();
            Logger.warn('DB: блок не снят, fallback в память');
            resolve(null);
          }, 10000);
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
   * Индексы uid в памяти (быстрые hasOwn/проверки владения).
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
   * Обёртка транзакции. fn получает objectStore и возвращает IDBRequest.
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

  /**
   * @param {Object} note
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

  // ─── upsertMirror: сходимость зеркала ────────────────────────────────────

  /**
   * Эффективная версия записи: noteVersion (payload, истина заметки),
   * fallback — version (created_at канона; legacy/fact-only записи).
   * @param {Object} x
   * @returns {number}
   */
  function effVersion(x) {
    return typeof x.noteVersion === 'number' && x.noteVersion > 0
      ? x.noteVersion
      : (typeof x.version === 'number' ? x.version : 0);
  }

  /**
   * Новая запись полнее существующей той же версии?
   * @param {Object} incoming
   * @param {Object} existing
   * @returns {boolean}
   */
  function hasRicherFields(incoming, existing) {
    const incomingHas = !!(incoming.text || incoming.vec || incoming.parent);
    const existingHas = !!(existing.text || existing.vec || existing.parent);
    return incomingHas && !existingHas;
  }

  /**
   * Заимствование недостающих полей из существующей записи
   * (fact-only не затирает полную; полная поглощает факт).
   * @param {Object} entry
   * @param {Object} existing
   */
  function borrowMissing(entry, existing) {
    ['text', 'vec', 'parent', 'ts'].forEach(k => {
      if (entry[k] === undefined || entry[k] === null) {
        if (existing[k] !== undefined && existing[k] !== null) {
          entry[k] = existing[k];
        }
      }
    });
  }

  /**
   * Решение о сходимости. Возвращает запись для put или null.
   * Порядок правил:
   *   - tombstone (deleted) побеждает при ev >= xv;
   *   - живая запись воскрешает tombstone только при ev > xv;
   *   - ev > xv → замена с заимствованием недостающих полей;
   *   - ev < xv → отказ;
   *   - равные → только если incoming «богаче» (richer-wins).
   * @param {Object} entry
   * @param {Object|undefined} existing
   * @returns {Object|null}
   */
  function decideUpsert(entry, existing) {
    if (!existing) return entry;

    const ev = effVersion(entry);
    const xv = effVersion(existing);

    if (entry.deleted) {
      return ev >= xv ? entry : null;
    }

    if (existing.deleted) {
      return ev > xv ? entry : null;
    }

    if (ev > xv) {
      borrowMissing(entry, existing);
      return entry;
    }

    if (ev < xv) return null;

    if (hasRicherFields(entry, existing)) {
      borrowMissing(entry, existing);
      return entry;
    }

    return null;
  }

  /**
   * Upsert в mirror: ОДНА readwrite-транзакция (get → решение → put).
   * Атомарно: конкурентные upsert сериализуются движком IDB.
   * @param {Object} entry
   * @returns {Promise<boolean>} true — запись обновлена.
   */
  function upsertMirror(entry) {
    if (!entry || !entry.uid || typeof entry.version !== 'number') {
      return Promise.resolve(false);
    }

    return open().then(d => {
      // mem-путь: та же логика решения, без транзакции.
      if (!d) {
        const existing = memMirror.get(entry.uid);
        const toPut = decideUpsert(entry, existing);
        if (!toPut) return false;
        memMirror.set(entry.uid, toPut);
        mirrorUids.add(entry.uid);
        emitMirror();
        return true;
      }

      return new Promise(resolve => {
        let result = false;

        try {
          const tx = d.transaction(MIRROR(), 'readwrite');
          const store = tx.objectStore(MIRROR());

          const req = store.get(entry.uid);
          req.onsuccess = () => {
            const toPut = decideUpsert(entry, req.result);
            if (toPut) {
              store.put(toPut);
              result = true;
            }
            // решения null — tx завершится пусто, result=false
          };

          tx.oncomplete = () => {
            if (result) {
              mirrorUids.add(entry.uid);
              emitMirror();
            }
            resolve(result);
          };
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (e) {
          Logger.warn('DB: upsertMirror', String(e && e.message || e));
          resolve(false);
        }
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
   * Тихая запись publishedVersion (после успешной публикации канона).
   * БЕЗ db:change — иначе цикл публикация→событие→ререндер.
   * undefined трактуется как 0 (не публиковалось).
   * @param {string} uid
   * @param {number} version
   * @returns {Promise<void>}
   */
  function updatePublishState(uid, version) {
    if (!uid || typeof version !== 'number') return Promise.resolve();

    return open().then(d => {
      if (!d) {
        const n = memNotes.get(uid);
        if (n && (n.publishedVersion || 0) < version) {
          n.publishedVersion = version;
        }
        return;
      }

      return new Promise(resolve => {
        try {
          const tx = d.transaction(NOTES(), 'readwrite');
          const store = tx.objectStore(NOTES());

          const req = store.get(uid);
          req.onsuccess = () => {
            const n = req.result;
            if (n && (n.publishedVersion || 0) < version) {
              n.publishedVersion = version;
              store.put(n);
            }
          };

          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }).catch(() => {});
  }

  /**
   * Очистка обоих сторов (wipe локальной базы).
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

  /**
   * Закрытие соединения (только перед deleteDatabase в fullReset).
   * После close: все операции тихо идут в память; соединение НЕ
   * переоткрывается — deleteDatabase не упадёт в blocked.
   */
  function close() {
    closed = true;
    if (db) {
      try { db.close(); } catch (_) {}
      db = null;
    }
    if (!memNotes) memNotes = new Map();
    if (!memMirror) memMirror = new Map();
    openPromise = Promise.resolve(null);
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

    updatePublishState,
    reset,
    close,

    ready: open,
  };
}, ['Config', 'EventBus', 'Logger']);
// ─── DATA/DB ─── END ────────────────────────────────────────────────────────

// ═══ СЛОЙ: AI ═════════════════════════════════════════════════════════════════

// ─── AI/Embedder ─── START ──────────────────────────────────────────────────
/**
 * Эмбеддер Granite R2: Web Worker (Blob, module) + transformers.js,
 * q8, CLS-pooling, normalize.
 *
 * Режимы: 'loading' | 'model'. Demo/hash-fallback НЕТ.
 *
 * КОНТРАКТ v1.0:
 * - embed(text) → Promise<Float32Array|null>. null — модель не готова
 *   (loading/stalled/ошибка/таймаут/пустой текст). null НЕ кэшируется.
 * - load() → Promise<void>, resolve при переходе в 'model'.
 * - При готовности: ai:status {mode:'model'} + ai:ready (однократно).
 * - Таймаут загрузки 120с: НЕ убивает воркер — stalled:true (воркер
 *   докачивает в фоне; если добьётся — штатный переход в model).
 *   Ретрай после фатальной ошибки — только перезапуском приложения.
 * - Кэш LRU 300, только настоящие векторы, чистится при старте загрузки.
 * - getState(): {mode, percent, stalled} — снимок для UI-инициализации.
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
    self.postMessage({ type: 'error', id: msg.id, message: 'model not loaded' });
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

  /** @type {'loading'|'model'} */
  let mode = 'loading';
  /** @type {boolean} */
  let stalled = false;
  /** @type {number} */
  let lastPct = 0;

  let loadPromise = null;
  let loadSettled = false;
  let readyEmitted = false;
  let nextId = 0;

  /** @type {Map<number, {resolve: Function, timer: number}>} */
  const pending = new Map();
  /** @type {Array<Function>} */
  const progressFns = [];
  /** @type {Map<string, Float32Array>} */
  const cache = new Map();

  /**
   * @param {Object} [extra]
   */
  function emitStatus(extra) {
    try {
      bus.emit('ai:status', Object.assign(
        { mode, percent: lastPct, stalled },
        extra || {}
      ));
    } catch (_) {}
  }

  /**
   * LRU-чтение.
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
   * LRU-запись.
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
   * Аварийная остановка: все pending разрешаются null, воркер убивается.
   * Вызывается только при фатальной ошибке воркера (не при таймауте
   * загрузки — там воркер жив и может докачать).
   */
  function cleanup() {
    pending.forEach(p => {
      clearTimeout(p.timer);
      p.resolve(null);
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
   * Фатальный отказ загрузки/воркера: остаёмся в loading+stalled.
   * @param {string} reason
   */
  function stall(reason) {
    if (mode === 'model') return;
    stalled = true;
    cleanup();
    emitStatus();
    Logger.warn('Embedder: ' + reason + ' — ии недоступно до перезапуска');
  }

  /**
   * Загрузка модели.
   * @returns {Promise<void>}
   */
  function doLoad() {
    return new Promise(resolve => {
      if (typeof Worker === 'undefined') {
        stall('Worker не поддерживается браузером');
        return resolve();
      }

      try {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        workerUrl = URL.createObjectURL(blob);
        worker = new Worker(workerUrl, { type: 'module' });
      } catch (err) {
        stall('не создать Worker: ' + String(err && err.message || err));
        return resolve();
      }

      // Таймаут загрузки: НЕ убиваем воркер — он докачивает в фоне.
      // stalled прячет прогресс и переводит статус в «ии нет»;
      // поздний 'ready' всё равно переведёт в model.
      const LOAD_TIMEOUT = 120000;
      const loadTimer = setTimeout(() => {
        if (loadSettled || mode === 'model') return;
        stalled = true;
        emitStatus();
        Logger.warn('Embedder: таймаут загрузки модели (120с), модель качается в фоне');
        resolve();
      }, LOAD_TIMEOUT);

      worker.onerror = err => {
        if (loadSettled) {
          // краш после готовности: гасим только pending
          pending.forEach(p => {
            clearTimeout(p.timer);
            p.resolve(null);
          });
          pending.clear();
          Logger.warn('Embedder: воркер упал после загрузки', String(err && err.message || err));
          return;
        }
        clearTimeout(loadTimer);
        stall('ошибка Worker: ' + String(err && err.message || err));
        resolve();
      };

      worker.onmessage = e => {
        const msg = e.data;

        if (msg.type === 'progress') {
          lastPct = msg.pct;
          stalled = false;

          for (const fn of progressFns.slice()) {
            try { fn(msg); } catch (_) {}
          }
          try { bus.emit('ai:progress', msg); } catch (_) {}
          emitStatus({ loadedMB: msg.loadedMB, totalMB: msg.totalMB, model: msg.model });
        }
        else if (msg.type === 'ready') {
          if (mode === 'model') return;
          clearTimeout(loadTimer);

          mode = 'model';
          stalled = false;
          lastPct = 100;
          emitStatus();

          if (!readyEmitted) {
            readyEmitted = true;
            try { bus.emit('ai:ready'); } catch (_) {}
          }

          Logger.info('Embedder: модель готова');
          resolve();
        }
        else if (msg.type === 'error' && msg.id === null) {
          if (mode === 'model') return;
          clearTimeout(loadTimer);
          stall('ошибка загрузки модели: ' + String(msg.message));
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
            Logger.warn('Embedder: ошибка embed', String(msg.message));
            p.resolve(null);
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
     * Запуск загрузки. Идемпотентен.
     * @param {Function} [onProgress] - подписка на прогресс (снимается
     *   после завершения загрузки).
     * @returns {Promise<void>}
     */
    load(onProgress) {
      let off = null;
      if (typeof onProgress === 'function') {
        progressFns.push(onProgress);
        off = () => {
          const i = progressFns.indexOf(onProgress);
          if (i > -1) progressFns.splice(i, 1);
        };
      }

      if (mode === 'model') {
        if (off) off();
        return Promise.resolve();
      }

      if (loadPromise) return loadPromise;

      cache.clear();
      mode = 'loading';
      stalled = false;
      lastPct = 0;
      emitStatus();

      loadPromise = doLoad().then(() => {
        loadSettled = true;
        loadPromise = null;
        if (off) off();
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

      if (mode !== 'model' || !worker) {
        return Promise.resolve(null);
      }

      const cached = cacheGet(t);
      if (cached) return Promise.resolve(cached);

      const id = nextId++;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            Logger.warn('Embedder: таймаут embed');
            resolve(null);
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
      return mode === 'model';
    },

    /**
     * @returns {'loading'|'model'}
     */
    getMode() {
      return mode;
    },

    /**
     * Снимок состояния для UI-инициализации.
     * @returns {{mode: string, percent: number, stalled: boolean}}
     */
    getState() {
      return { mode, percent: lastPct, stalled };
    },

    /**
     * Подписка на прогресс с отпиской.
     * @param {Function} fn
     * @returns {Function} off
     */
    onProgress(fn) {
      if (typeof fn !== 'function') return () => {};
      progressFns.push(fn);
      return () => {
        const i = progressFns.indexOf(fn);
        if (i > -1) progressFns.splice(i, 1);
      };
    },
  };
}, ['Config', 'EventBus', 'Logger']);
// ─── AI/Embedder ─── END ────────────────────────────────────────────────────

// ─── AI/Ranker ─── START ────────────────────────────────────────────────────
/**
 * Ранжирование: пакетный косинус, пороги relevant/seren, дубликаты.
 * Пороги читаются из Config при каждом вызове — настройки применяются
 * без перезагрузки.
 */
DI.register('Ranker', function (Vec, Config) {
  /**
   * @param {Float32Array|number[]} queryVector
   * @param {Array<{id: string, vector: Array|Float32Array}>} items
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{id: string, score: number}>>} По убыванию score.
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
   * relevant: score >= threshold. seren: [threshold - serendipity, threshold).
   * Ниже lowerBound — отброс.
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

// ═══ СЛОЙ: NET ═══════════════════════════════════════════════════════════════

// ─── NET/Nostr ─── START ────────────────────────────────────────────────────
/**
 * Транспорт: nostr-tools@2.7.2 (версия запиннена), SimplePool, ключи.
 *
 * КОНТРАКТ v1.0:
 * - init() → Promise<pubkey>; идемпотентен; при ошибке CDN —
 *   net:status failed + throw (вызывающий решает, жить ли без сети).
 * - Секретный ключ: localStorage hex (известный компромисс B-04,
 *   изолирован здесь; смена хранилища — точечная правка load/saveKey).
 * - publish: параллельно на все релеи, успех = первый принявший,
 *   полный отказ = все упали, таймаут 30с. После таймаута событие
 *   МОЖЕТ уйти позднее — это безопасно: повторная публикация той же
 *   заметки даёт новый created_at при том же noteVersion в payload,
 *   зеркала сходятся (см. NetService/DB).
 * - setKey: замена аккаунта (валидация 32 байта).
 */
DI.register('Nostr', function (Config, bus, Logger) {
  const CDN = 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
  const SK_KEY = 'noomium:sk';

  /** @type {Object|null} */
  let nostr = null;
  /** @type {Object|null} */
  let pool = null;
  /** @type {Uint8Array|null} */
  let sk = null;
  /** @type {string|null} */
  let pk = null;
  /** @type {Promise|null} */
  let initPromise = null;

  /**
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
   * @param {Uint8Array} key
   */
  function saveKey(key) {
    try {
      localStorage.setItem(
        SK_KEY,
        Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('')
      );
    } catch (e) {
      Logger.warn('Nostr: ключ не сохранён (storage?)', String(e));
    }
  }

  /**
   * Инициализация: загрузка библиотеки, восстановление/генерация
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
   * @returns {Object|null}
   */
  function lib() {
    return nostr;
  }

  /**
   * @returns {Uint8Array|null}
   */
  function getSecretKey() {
    return sk;
  }

  /**
   * @param {Uint8Array} newSk
   * @returns {string} Новый pubkey.
   * @throws {Error}
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
   * @param {Object} template
   * @returns {Object} Подписанное событие.
   * @throws {Error}
   */
  function sign(template) {
    if (!nostr || !sk) throw new Error('Nostr not ready');
    return nostr.finalizeEvent(template, sk);
  }

  /**
   * Публикация на все релеи; успех при первом принявшем.
   * @param {Object} template
   * @returns {Promise<Object>} Подписанное событие.
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
   * @param {Array<Object>} filters
   * @param {Object} handlers - {onevent, onclose}
   * @returns {Object|null}
   */
  function subscribe(filters, handlers) {
    if (!pool) return null;
    return pool.subscribeMany(relays(), filters, handlers);
  }

  /**
   * @returns {Array<string>}
   */
  function relays() {
    return Config.get('relays', []);
  }

  /**
   * @returns {string|null}
   */
  function getPubkey() {
    return pk;
  }

  /**
   * @returns {boolean}
   */
  function isReady() {
    return !!(nostr && sk && pool);
  }

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

// ─── NET/Vault ─── START ────────────────────────────────────────────────────
/**
 * Шифрование приватного канона: NIP-44 v2, self-ECDH
 * (conversation key из своего sk и своего pk). Единственная точка
 * криптографии payload. Потеря sk = потеря приватного канона
 * (страховка — экспорт ncryptsec в Account).
 */
DI.register('Vault', function (Nostr) {
  /**
   * @returns {Promise<Object>}
   * @throws {Error}
   */
  async function lib() {
    await Nostr.init();
    const n = Nostr.lib();
    if (!n) throw new Error('nostr-tools not loaded');
    return n;
  }

  /**
   * @param {string} plaintext - JSON payload.
   * @returns {Promise<string>} Шифртекст.
   * @throws {Error}
   */
  async function seal(plaintext) {
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
   * @param {string} ciphertext
   * @returns {Promise<string>} Открытый JSON payload.
   * @throws {Error}
   */
  async function open(ciphertext) {
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

  return { seal, open };
}, ['Nostr']);
// ─── NET/Vault ─── END ──────────────────────────────────────────────────────

// ─── NET/Crypto ─── START ───────────────────────────────────────────────────
/**
 * Криптография аккаунта: форматы ключей (nsec/npub/ncryptsec/hex),
 * NIP-49. Все ошибки — null-возврат + Logger.warn (кроме decodeSecret
 * на hex/nsec — тихий null: битый ввод юзера — штатный случай).
 */
DI.register('Crypto', function (Nostr, Logger) {
  /**
   * @returns {Promise<Object>}
   * @throws {Error}
   */
  async function lib() {
    await Nostr.init();
    const n = Nostr.lib();
    if (!n) throw new Error('nostr-tools not loaded');
    return n;
  }

  /**
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
   * @param {*} input
   * @returns {'nsec'|'ncryptsec'|'hex'|null}
   */
  function classifyKeyInput(input) {
    const t = String(input || '').trim();
    if (t.startsWith('ncryptsec1')) return 'ncryptsec';
    if (t.startsWith('nsec1')) return 'nsec';
    if (/^[0-9a-fA-F]{64}$/.test(t)) return 'hex';
    return null;
  }

  /**
   * @param {*} input
   * @returns {Promise<Uint8Array|null>}
   */
  async function decodeSecret(input) {
    const t = String(input || '').trim();
    if (!t) return null;

    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      return new Uint8Array(t.match(/.{2}/g).map(b => parseInt(b, 16)));
    }

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
   * @param {Uint8Array} sk
   * @param {string} password
   * @returns {Promise<string|null>} ncryptsec.
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
   * @param {string} ncryptsec
   * @param {string} password
   * @returns {Promise<Uint8Array|null>}
   */
  async function decryptKey(ncryptsec, password) {
    try {
      const n = await lib();
      if (!n.nip49 || typeof n.nip49.decrypt !== 'function') return null;

      const res = n.nip49.decrypt(String(ncryptsec || '').trim(), String(password || ''));

      if (res instanceof Uint8Array) return res.length === 32 ? res : null;
      if (res && res.secretKey instanceof Uint8Array && res.secretKey.length === 32) return res.secretKey;
      if (res && res.data instanceof Uint8Array && res.data.length === 32) return res.data;

      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {Uint8Array} sk
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
   * @param {string} pk
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

// ─── NET/Protocol ─── START ─────────────────────────────────────────────────
/**
 * Кодек событий: канон состояний (kind 30078, replaceable, d = uid)
 * и служебные (запрос 21000, ответ-ссылка 21001).
 *
 * Payload v2: {v, visibility, text?, vec?, parent?, noteVersion, ts}.
 *   noteVersion — истина заметки (счётчик владельца); created_at
 *   канона — секунда публикации (свежесть, не истина).
 *   ВСЕ каноны, включая удаление, несут noteVersion.
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9:
 * - canonDeleted(uid, version) — сигнатура с noteVersion; эхо-удаление
 *   на других устройствах решается LWW по payload-версии, а не по
 *   секунде публикации (быстрое «создал → удалил» больше не теряется).
 * - decodeCanon: возвращает noteVersion и deleted для всех веток,
 *   где они есть в payload.
 * - decodeQuery: жёсткий кап длины вектора (1024) и конечность
 *   значений — анти-спам (векторы продукта 384-мерные).
 */
DI.register('Protocol', function (Config, Vec, Vault, Nostr) {
  /** @type {number} */
  const MAX_CONTENT = 65536;
  /** @type {number} */
  const MAX_QUERY_DIM = 1024;

  /**
   * @param {Array} tags
   * @param {string} name
   * @returns {Array|null}
   */
  function findTag(tags, name) {
    if (!Array.isArray(tags)) return null;
    for (const t of tags) {
      if (Array.isArray(t) && t[0] === name) return t;
    }
    return null;
  }

  /**
   * Свежая секунда публикации.
   * @returns {number}
   */
  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Канон приватной версии (NIP-44).
   * @param {Object} note - {uid, text, vector, parent, version, updatedAt}
   * @returns {Promise<Object>}
   * @throws {Error}
   */
  async function canonPrivate(note) {
    const payload = {
      v: 2,
      visibility: 'private',
      text: note.text || '',
      vec: note.vector ? Vec.toB64(note.vector) : null,
      parent: note.parent || null,
      noteVersion: note.version,
      ts: note.updatedAt || note.version,
    };

    const content = await Vault.seal(JSON.stringify(payload));

    return {
      kind: Config.get('kCanon', 30078),
      created_at: nowSec(),
      tags: [
        ['d', note.uid],
        ['client', 'noomium'],
        ['t', Config.get('room', 'noomium-main')],
      ],
      content,
    };
  }

  /**
   * Канон публичной версии (открытый JSON).
   * @param {Object} note
   * @returns {Promise<Object>}
   */
  async function canonPublic(note) {
    const payload = {
      v: 2,
      visibility: 'public',
      text: note.text || '',
      vec: note.vector ? Vec.toB64(note.vector) : null,
      parent: note.parent || null,
      noteVersion: note.version,
      ts: note.updatedAt || note.version,
    };

    return {
      kind: Config.get('kCanon', 30078),
      created_at: nowSec(),
      tags: [
        ['d', note.uid],
        ['client', 'noomium'],
        ['t', Config.get('room', 'noomium-main')],
      ],
      content: JSON.stringify(payload),
    };
  }

  /**
   * Канон удаления — открытый факт с noteVersion на момент удаления.
   * @param {string} uid
   * @param {number} version - noteVersion удаляемой заметки.
   * @returns {Promise<Object>}
   */
  async function canonDeleted(uid, version) {
    return {
      kind: Config.get('kCanon', 30078),
      created_at: nowSec(),
      tags: [
        ['d', uid],
        ['client', 'noomium'],
        ['t', Config.get('room', 'noomium-main')],
      ],
      content: JSON.stringify({
        v: 2,
        visibility: 'deleted',
        noteVersion: typeof version === 'number' ? version : 0,
        ts: Date.now(),
      }),
    };
  }

  /**
   * Декодирование канона.
   * @param {Object} ev - Nostr-событие kind 30078.
   * @returns {Promise<Object|null>} Формат записи mirror:
   *   {uid, owner, version (created_at), noteVersion?, visibility,
   *    text?, vec?, parent?, ts, deleted?}
   */
  async function decodeCanon(ev) {
    if (!ev || ev.kind !== Config.get('kCanon', 30078)) return null;

    const dTag = findTag(ev.tags, 'd');
    if (!dTag || typeof dTag[1] !== 'string' || !dTag[1]) return null;
    if (typeof ev.content !== 'string' || !ev.content) return null;
    if (ev.content.length > MAX_CONTENT) return null;
    if (!ev.created_at) return null;

    const uid = dTag[1];
    const owner = ev.pubkey;
    const version = ev.created_at;

    let data = null;
    try {
      data = JSON.parse(ev.content);
    } catch (_) {
      data = null;
    }

    if (!data || typeof data !== 'object') {
      // Не JSON: возможно, наш NIP-44-канон.
      if (owner === Nostr.getPubkey()) {
        try {
          data = JSON.parse(await Vault.open(ev.content));
        } catch (_) {
          return null;
        }
      } else {
        // Чужой приватный канон: факт существования, без контента.
        return { uid, owner, version, visibility: 'private', ts: version * 1000 };
      }
    }

    if (!data || typeof data !== 'object') return null;

    const visibility = data.visibility === 'public' ? 'public'
      : data.visibility === 'deleted' ? 'deleted'
      : 'private';

    if (visibility === 'private' && owner !== Nostr.getPubkey()) {
      return { uid, owner, version, visibility: 'private', ts: version * 1000 };
    }

    const noteVersion = typeof data.noteVersion === 'number' && data.noteVersion > 0
      ? data.noteVersion
      : undefined;

    if (visibility === 'deleted') {
      return { uid, owner, version, noteVersion, visibility, deleted: true,
               ts: typeof data.ts === 'number' && data.ts > 0 ? data.ts : version * 1000 };
    }

    if (typeof data.text !== 'string') return null;
    if (data.text.length > Config.get('maxNoteTextLength', 10000)) return null;

    let vec = null;
    if (typeof data.vec === 'string') {
      const v = Vec.fromB64(data.vec);
      if (v) vec = Array.from(v);
    }

    let parent = null;
    if (data.parent && typeof data.parent === 'object' && typeof data.parent.uid === 'string' && data.parent.uid) {
      parent = { uid: data.parent.uid, owner: data.parent.owner || null };
    }

    const ts = typeof data.ts === 'number' && data.ts > 0 ? data.ts : (version * 1000);

    return { uid, owner, version, noteVersion, visibility, text: data.text, vec, parent, ts };
  }

  /**
   * Событие запроса (публичный вектор — известный компромисс,
   * отложен по консенсусу).
   * @param {Float32Array|Array<number>} vector
   * @param {number} maxResponses
   * @param {number} window
   * @returns {Object}
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
   * @param {Object} ev
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
    if (data.vector.length > MAX_QUERY_DIM) return null;

    for (const x of data.vector) {
      if (typeof x !== 'number' || !isFinite(x)) return null;
    }

    return {
      vector: data.vector,
      maxResponses: typeof data.maxResponses === 'number' ? data.maxResponses : Config.get('maxResponses', 8),
      window: typeof data.window === 'number' ? data.window : Config.get('responseWindow', 6000),
      owner: ev.pubkey,
      queryId: ev.id,
    };
  }

  /**
   * Ответ-ссылка: (uid) владельца заметки, не копия контента.
   * @param {Object} note
   * @param {number} score
   * @param {string} queryId
   * @returns {Object}
   */
  function answerEvent(note, score, queryId) {
    return {
      kind: Config.get('kAnswer', 21001),
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', Config.get('room', 'noomium-main')],
        ['e', queryId],
        ['uid', note.uid],
      ],
      content: JSON.stringify({ score }),
    };
  }

  /**
   * @param {Object} ev
   * @returns {Object|null}
   */
  function decodeAnswer(ev) {
    if (!ev || ev.kind !== Config.get('kAnswer', 21001)) return null;

    const eTag = findTag(ev.tags, 'e');
    const uidTag = findTag(ev.tags, 'uid');
    if (!eTag || !uidTag || !uidTag[1]) return null;

    let data = null;
    try {
      data = JSON.parse(ev.content);
    } catch (_) {}

    return {
      queryId: eTag[1],
      uid: uidTag[1],
      owner: ev.pubkey,
      score: data && typeof data.score === 'number' ? data.score : 0,
    };
  }

  return {
    canonPrivate,
    canonPublic,
    canonDeleted,
    decodeCanon,
    queryEvent,
    decodeQuery,
    answerEvent,
    decodeAnswer,
  };
}, ['Config', 'Vec', 'Vault', 'Nostr']);
// ─── NET/Protocol ─── END ───────────────────────────────────────────────────

// ─── NET/NetService ─── START ───────────────────────────────────────────────
/**
 * Движение: подписка на комнату (каноны — без since: replaceable
 * отдаёт последнюю версию каждого канона; запросы/ответы — скользящим
 * окном), подписка на себя, публикация канонов через очередь,
 * ответы-ссылки на чужие запросы, запросы при контексте, история.
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9:
 * 1. Очередь хранит версии: {uids: [{uid, version}], deleted:
 *    [{uid, version}]}. flushQueue публикует живой канон только при
 *    note.version > publishedVersion; после успеха — тихая запись
 *    DB.updatePublishState. Стартовая переочередка — только
 *    неопубликованные заметки (не все, как было).
 * 2. sync:status — полный цикл: 'active' при публикации, 'idle' при
 *    покое (синк включён, очередь пуста), 'off' при выключенном.
 * 3. publishWipeAll() → Promise<{published, offline}>: офлайн честно
 *    сообщается вызывающему (Boot тостит предупреждение).
 * 4. canonDeleted публикуется с noteVersion на момент удаления —
 *    эхо-удаление на других устройствах сходится по payload-версии.
 * Остальное — поведение v0.9.9 без изменений (эпохи, бэкофф, окна,
 * центроиды, rate-limits, heartbeat, seen-дедуп).
 */
DI.register('NetService', function (Nostr, Protocol, DB, Ranker, Vec, Store, Config, Logger, bus) {
  let started = false;
  let startPromise = null;
  let subscription = null;
  let selfSubscription = null;
  let fetchSubscription = null;
  let hbTimer = null;
  let lastQueryVec = null;
  let lastQueryTime = 0;
  let centroids = [];
  let contextUnsub = null;
  let flushing = false;
  let flushTimer = null;
  let startRetryTimer = null;
  let onlineListenerAdded = false;
  let reconnectAttempts = 0;
  let busUnsubs = [];

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Map<string, number>} */
  const peerQueryTimes = new Map();

  let currentWindow = Config.get('subWindow', 300);
  let historyLoading = false;
  let subEpoch = 0;

  const QUEUE_KEY = 'noomium:queue';

  /**
   * Очередь: {uids: [{uid, version}], deleted: [{uid, version}]}.
   * version для deleted — версия на момент удаления (заметки в DB
   * уже нет, версия живёт только здесь). Для uids версия — справочная;
   * flush читает актуальную из заметки.
   * @returns {{uids: Array<{uid: string, version: number}>,
   *   deleted: Array<{uid: string, version: number}>}}
   */
  function loadQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (raw) {
        const q = JSON.parse(raw);
        const norm = arr => (Array.isArray(arr) ? arr : [])
          .filter(x => x && typeof x.uid === 'string' && x.uid)
          .map(x => ({ uid: x.uid, version: typeof x.version === 'number' ? x.version : 0 }));
        return { uids: norm(q.uids), deleted: norm(q.deleted) };
      }
    } catch (_) {}
    return { uids: [], deleted: [] };
  }

  /**
   * Сохранение очереди.
   */
  function saveQueue() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      Logger.warn('NetService: очередь не сохранена', String(e && e.message || e));
    }
  }

  let queue = loadQueue();

  const kCanon = () => Config.get('kCanon', 30078);
  const kQuery = () => Config.get('kQuery', 21000);
  const kAnswer = () => Config.get('kAnswer', 21001);
  const room = () => Config.get('room', 'noomium-main');

  /**
   * @param {string} s
   */
  function setStatus(s) {
    try { bus.emit('net:status', { status: s }); } catch (_) {}
  }

  /**
   * @param {'off'|'active'|'idle'} phase
   */
  function emitSync(phase) {
    try { bus.emit('sync:status', { phase }); } catch (_) {}
  }

  /**
   * @returns {boolean}
   */
  function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /**
   * @returns {boolean}
   */
  function canPublish() {
    return Nostr.isReady() && !isOffline();
  }

  /**
   * Удаление из очереди по uid.
   * @param {'uids'|'deleted'} list
   * @param {string} uid
   */
  function removeFromQueue(list, uid) {
    const i = queue[list].findIndex(x => x.uid === uid);
    if (i > -1) {
      queue[list].splice(i, 1);
      saveQueue();
    }
  }

  /**
   * @param {string} uid
   * @param {number} [version]
   */
  function queuePublish(uid, version) {
    if (!uid) return;
    const v = typeof version === 'number' ? version : 0;
    const i = queue.uids.findIndex(x => x.uid === uid);
    if (i > -1) queue.uids[i] = { uid, version: v };
    else queue.uids.push({ uid, version: v });
    saveQueue();
    scheduleFlush();
  }

  /**
   * @param {string} uid
   * @param {number} [version]
   */
  function queueDeleted(uid, version) {
    if (!uid) return;

    removeFromQueue('uids', uid);

    const v = typeof version === 'number' ? version : 0;
    const i = queue.deleted.findIndex(x => x.uid === uid);
    if (i > -1) queue.deleted[i] = { uid, version: v };
    else queue.deleted.push({ uid, version: v });
    saveQueue();
    scheduleFlush();
  }

  /**
   * @param {number} [delay]
   */
  function scheduleFlush(delay) {
    if (flushTimer) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, delay || 5000);
  }

  /**
   * Сброс очереди: каноны живых (только непубликованные версии),
   * затем deleted. После успеха — тихая запись publishedVersion.
   * @returns {Promise<void>}
   */
  async function flushQueue() {
    if (flushing) return;
    if (!canPublish()) return;
    if (!queue.uids.length && !queue.deleted.length) return;

    flushing = true;
    const syncing = Config.get('syncEnabled', true);

    try {
      if (syncing) {
        emitSync('active');

        for (const item of queue.uids.slice()) {
          const note = await DB.getNote(item.uid).catch(() => null);
          if (!note) {
            removeFromQueue('uids', item.uid);
            continue;
          }

          // Уже опубликовано этой или более новой версией — не дублируем.
          if (typeof note.version === 'number'
              && note.version <= (note.publishedVersion || 0)) {
            removeFromQueue('uids', item.uid);
            continue;
          }

          try {
            const tpl = note.visibility === 'public'
              ? await Protocol.canonPublic(note)
              : await Protocol.canonPrivate(note);
            await Nostr.publish(tpl);
            await DB.updatePublishState(item.uid, note.version);
            removeFromQueue('uids', item.uid);
          } catch (_) {
            // Релей не принял — останется в очереди, ретрай ниже.
          }
        }

        for (const item of queue.deleted.slice()) {
          try {
            const tpl = await Protocol.canonDeleted(item.uid, item.version || 0);
            await Nostr.publish(tpl);
            removeFromQueue('deleted', item.uid);
          } catch (_) {}
        }
      }
    } catch (_) {} finally {
      flushing = false;

      const hasLeft = queue.uids.length || queue.deleted.length;
      if (syncing) {
        emitSync(hasLeft ? 'active' : 'idle');
        if (hasLeft) scheduleFlush(10000);
      }
    }
  }

  /**
   * Перестройка центроидов (prefilter для чужих запросов).
   */
  function rebuildCentroids() {
    DB.allNotes().then(notes => {
      const vecs = notes.filter(n => n.visibility === 'public' && n.vector).map(n => n.vector);
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

  /**
   * @param {boolean} hard
   */
  function markConnected(hard) {
    if (!started) return;

    if (hard) {
      reconnectAttempts = 0;
    }

    setStatus('connected');
    flushQueue();
  }

  /**
   * @param {Object} ev
   */
  function onEvent(ev) {
    if (!ev) return;

    markConnected(true);

    if (seen.has(ev.id)) return;

    if (ev.kind === kCanon()) {
      seen.add(ev.id);
      trimSeen();
      try { bus.emit('net:canon', ev); } catch (_) {}
      return;
    }

    if (ev.kind === kQuery()) {
      seen.add(ev.id);
      trimSeen();
      handleIncomingQuery(ev);
      return;
    }

    if (ev.kind === kAnswer()) {
      seen.add(ev.id);
      trimSeen();
      try { bus.emit('net:answer', Protocol.decodeAnswer(ev)); } catch (_) {}
      return;
    }
  }

  /**
   * Обрезка seen до половины лимита.
   */
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
   * Чужой запрос: rate-limit → prefilter → топ-ответы-ссылки.
   * @param {Object} ev
   */
  function handleIncomingQuery(ev) {
    const q = Protocol.decodeQuery(ev);
    if (!q) return;

    if (q.owner === Nostr.getPubkey()) return;

    const now = Date.now();
    const last = peerQueryTimes.get(q.owner) || 0;

    if (now - last < Config.get('queryRateLimit', 3000)) return;

    peerQueryTimes.set(q.owner, now);

    if (!passesPrefilter(q.vector)) return;

    DB.allNotes().then(notes => {
      const candidates = notes.filter(n => n.visibility === 'public' && n.vector);
      if (!candidates.length) return null;

      const byId = new Map(candidates.map(n => [n.uid, n]));
      const items = candidates.map(n => ({ id: n.uid, vector: n.vector }));

      return Ranker.cosineBatch(q.vector, items).then(scored => {
        const top = scored
          .filter(s => s.score >= Config.get('threshold', 0.81))
          .slice(0, q.maxResponses || Config.get('maxResponses', 8));

        top.forEach((s, i) => {
          const note = byId.get(s.id);
          if (!note) return;

          setTimeout(() => {
            Nostr.publish(Protocol.answerEvent(note, s.score, q.queryId))
              .catch(e => Logger.warn('NetService: не отправить ответ', String(e && e.message || e)));
          }, i * 250);
        });
      });
    }).catch(e => Logger.warn('NetService: ошибка обработки запроса', String(e && e.message || e)));
  }

  /**
   * Отправка запроса при изменении контекста (pin/drift).
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
        Logger.info('NetService: запрос ' + ev.id.slice(0, 8) + '…');
      })
      .catch(e => {
        lastQueryVec = null;
        lastQueryTime = 0;
        Logger.warn('NetService: не отправить запрос', String(e && e.message || e));
      });
  }

  /**
   * Подписка на комнату: каноны без since (replaceable-семантика:
   * релей хранит последнюю версию каждого канона по d-tag); запросы
   * и ответы — со скользящим окном.
   */
  function subscribeToRoom() {
    const filters = [
      { kinds: [kCanon()], '#t': [room()] },
      { kinds: [kQuery(), kAnswer()], '#t': [room()], since: Math.floor(Date.now() / 1000) - currentWindow },
    ];

    const myEpoch = ++subEpoch;

    if (subscription && typeof subscription.close === 'function') {
      try { subscription.close(); } catch (_) {}
    }

    subscription = Nostr.subscribe(filters, {
      onevent: onEvent,
      onclose: () => {
        if (myEpoch !== subEpoch) return;

        setStatus('reconnecting');

        const maxAttempts = Config.get('reconnectMaxAttempts', 10);
        const baseDelay = Config.get('reconnectBaseDelay', 1000);
        const maxDelay = Config.get('reconnectMaxDelay', 60000);

        reconnectAttempts++;

        if (reconnectAttempts > maxAttempts) {
          Logger.warn('NetService: ' + maxAttempts + ' неудачных подключений');
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

      setTimeout(() => {
        if (myEpoch === subEpoch && started && !isOffline()) {
          markConnected(false);
        }
      }, 5000);
    }
  }

  /**
   * Подписка на свои каноны (синк устройств).
   */
  function subscribeSelf() {
    const pk = Nostr.getPubkey();
    if (!pk) return;

    if (selfSubscription && typeof selfSubscription.close === 'function') {
      try { selfSubscription.close(); } catch (_) {}
    }

    selfSubscription = Nostr.subscribe(
      [{ authors: [pk], kinds: [kCanon()] }],
      {
        onevent: ev => {
          if (!ev || !ev.id) return;
          try { bus.emit('net:canon', ev); } catch (_) {}
        },
        onclose: () => {
          setTimeout(() => {
            if (started && Config.get('syncEnabled', true)) subscribeSelf();
          }, 5000);
        },
      }
    );
  }

  /**
   * Подтяжка цели по ответу-ссылке.
   * @param {Object} p - {uid, owner}
   */
  function handleMirrorFetch(p) {
    if (!p || !p.uid || !p.owner) return;
    if (!Nostr.isReady()) return;

    if (fetchSubscription && typeof fetchSubscription.close === 'function') {
      try { fetchSubscription.close(); } catch (_) {}
    }

    fetchSubscription = Nostr.subscribe(
      [{ authors: [p.owner], kinds: [kCanon()], '#d': [p.uid] }],
      {
        onevent: ev => {
          if (!ev || !ev.id) return;
          try { bus.emit('net:canon', ev); } catch (_) {}
          if (fetchSubscription && typeof fetchSubscription.close === 'function') {
            try { fetchSubscription.close(); } catch (_) {}
            fetchSubscription = null;
          }
        },
        onclose: () => {
          setTimeout(() => {
            if (fetchSubscription) {
              try { fetchSubscription.close(); } catch (_) {}
              fetchSubscription = null;
            }
          }, 10000);
        },
      }
    );
  }

  /**
   * Слушатели online/offline.
   */
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
        if (!selfSubscription) subscribeSelf();
      }

      flushQueue();
    });

    window.addEventListener('offline', () => {
      if (!started) return;

      setStatus('failed');

      subEpoch++;

      if (subscription && typeof subscription.close === 'function') {
        try { subscription.close(); } catch (_) {}
      }
      subscription = null;
    });
  }

  /**
   * Heartbeat: чистка peerQueryTimes + seen.
   */
  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);

    hbTimer = setInterval(() => {
      const now = Date.now();

      peerQueryTimes.forEach((ts, pk) => {
        if (now - ts > Config.get('peerTTL', 60000)) peerQueryTimes.delete(pk);
      });

      trimSeen();
    }, Config.get('heartbeat', 30000));
  }

  /**
   * Расширение окна истории (для запросов/ответов).
   */
  function loadHistory() {
    if (!started || historyLoading) return;

    const maxWindow = Config.get('historyMaxWindow', 2592000);
    if (currentWindow >= maxWindow) {
      emitHistoryDone(false);
      return;
    }

    historyLoading = true;
    emitHistoryDone(true);

    currentWindow = Math.min(maxWindow, Math.max(currentWindow * 4, 86400));

    try {
      subscribeToRoom();
      Logger.info('NetService: окно истории → ' + currentWindow + 's');
    } finally {
      setTimeout(() => {
        historyLoading = false;
        emitHistoryDone(false);
      }, 1200);
    }
  }

  /**
   * @param {boolean} loading
   */
  function emitHistoryDone(loading) {
    try { bus.emit('net:history', { loading: loading, window: currentWindow }); } catch (_) {}
  }

  /**
   * Старт. Идемпотентен; при падении — retry 10с.
   * @returns {Promise<void>}
   */
  function start() {
    if (started) return Promise.resolve();
    if (startPromise) return startPromise;

    ensureOnlineListener();

    startPromise = Nostr.init()
      .then(() => DB.ready())
      .then(() => {
        const Notes = DI.resolve('Notes');
        return Notes.init();
      })
      .then(() => {
        started = true;
        reconnectAttempts = 0;

        busUnsubs.forEach(u => {
          try { u(); } catch (_) {}
        });
        busUnsubs = [];

        busUnsubs.push(bus.on('note:created', note => {
          if (note && note.uid) queuePublish(note.uid, note.version);
        }));

        busUnsubs.push(bus.on('note:updated', note => {
          if (note && note.uid) queuePublish(note.uid, note.version);
        }));

        busUnsubs.push(bus.on('note:deleted', p => {
          if (p && p.uid) queueDeleted(p.uid, p.version);
        }));

        busUnsubs.push(bus.on('db:change', () => rebuildCentroids()));

        busUnsubs.push(bus.on('account:changed', () => {
          queue = { uids: [], deleted: [] };
          saveQueue();
          seen.clear();
          peerQueryTimes.clear();
        }));

        busUnsubs.push(bus.on('sync:toggle', p => {
          if (!p) return;
          if (p.enabled) {
            subscribeSelf();
            flushQueue();
          } else {
            if (selfSubscription && typeof selfSubscription.close === 'function') {
              try { selfSubscription.close(); } catch (_) {}
            }
            selfSubscription = null;
            emitSync('off');
          }
        }));

        busUnsubs.push(bus.on('mirror:fetch', handleMirrorFetch));

        contextUnsub = Store.subscribe(s => s.context, () => maybeSendQuery());

        startHeartbeat();
        rebuildCentroids();

        // Стартовая переочередка: только неопубликованные версии
        // (publishedVersion отсутствует/меньше version — включая
        // первое знакомство после v0.9).
        DB.allNotes().then(notes => {
          notes.forEach(n => {
            if (n && n.uid
                && typeof n.version === 'number'
                && n.version > (n.publishedVersion || 0)) {
              queuePublish(n.uid, n.version);
            }
          });
          flushQueue();
        }).catch(() => {});

        if (isOffline()) {
          setStatus('failed');
          Logger.warn('NetService: офлайн, ожидаем появление сети');
        } else {
          subscribeToRoom();
        }

        subscribeSelf();

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
   * Полное переподключение.
   */
  function resync() {
    if (!Nostr.isReady()) {
      start();
      return;
    }

    reconnectAttempts = 0;

    if (!isOffline()) {
      subscribeToRoom();
      if (Config.get('syncEnabled', true)) subscribeSelf();
    }

    try { bus.emit('net:resync'); } catch (_) {}

    flushQueue();
  }

  /**
   * @param {boolean} full
   */
  function stop(full) {
    started = false;

    if (subscription && typeof subscription.close === 'function') {
      try { subscription.close(); } catch (_) {}
    }
    subscription = null;

    if (selfSubscription && typeof selfSubscription.close === 'function') {
      try { selfSubscription.close(); } catch (_) {}
    }
    selfSubscription = null;

    if (fetchSubscription && typeof fetchSubscription.close === 'function') {
      try { fetchSubscription.close(); } catch (_) {}
    }
    fetchSubscription = null;

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

    lastQueryVec = null;
    lastQueryTime = 0;
    reconnectAttempts = 0;

    if (full) {
      seen.clear();
      peerQueryTimes.clear();
    }

    setStatus('disconnected');
  }

  /**
   * Публичный wipe: каноны deleted для всех своих заметок.
   * @returns {Promise<{published: number, offline: boolean}>}
   */
  async function publishWipeAll() {
    if (!canPublish()) {
      return { published: 0, offline: true };
    }

    let published = 0;

    try {
      const notes = await DB.allNotes();

      for (const n of notes) {
        if (!n || !n.uid) continue;
        try {
          const tpl = await Protocol.canonDeleted(n.uid, n.version || 0);
          await Nostr.publish(tpl);
          published++;
        } catch (_) {}
      }
    } catch (_) {}

    return { published, offline: false };
  }

  return { start, stop, resync, loadHistory, publishWipeAll };
}, ['Nostr', 'Protocol', 'DB', 'Ranker', 'Vec', 'Store', 'Config', 'Logger', 'EventBus']);
// ─── NET/NetService ─── END ─────────────────────────────────────────────────

// ═══ СЛОЙ: DOMAIN ═════════════════════════════════════════════════════════════

// ─── DOMAIN/Notes ─── START ─────────────────────────────────────────────────
/**
 * Переходы состояний своих заметок. Единственная точка записи в notes.
 * Каждая мутация = новая version + note:* на шину; публикацию дергает
 * NetService через шину.
 *
 * Запись (модель v1.0):
 *   {uid, text, vector: Array|null, visibility, parent, version,
 *    publishedVersion, createdAt, updatedAt}
 *
 * КОНТРАКТ v1.0:
 * - create/edit/remove/toggle REJECT'ят при ошибке (Закон 2): UI обязан
 *   обработать reject — текст пользователя неприкосновенен.
 * - vector = null легален (модель не готова): заметка сохраняется,
 *   backfill() доэмбеддит после ai:ready.
 * - КОНТРАКТ УТОЧНЁН (вместо «сохранять старый вектор»): edit и
 *   applyOwnCanonical при недоступном эмбеддинге пишут vector = null.
 *   Старый вектор соответствовал бы СТАРОМУ тексту — поиск по нему
 *   возвращал бы ложные совпадения. null = «ещё не искается», backfill
 *   лечит. Это та же логика, что у create (B-01: вектор без текста
 *   не персистим никогда).
 * - applyOwnCanonical/restoreFromCanonical ставят publishedVersion =
 *   версии из сети (канон, пришедший с релея, по определению
 *   опубликован) — замкнутый цикл «эхо → републикация» исключён.
 */
DI.register('Notes', function (DB, Embedder, bus, Logger, Utils) {
  /** @type {number} */
  let versionCounter = 0;

  /**
   * @param {string} event
   * @param {*} payload
   */
  function emit(event, payload) {
    try { bus.emit(event, payload); } catch (_) {}
  }

  /**
   * Восстановление монотонности + подписка на notes:imported.
   * @returns {Promise<void>}
   */
  async function init() {
    try {
      const notes = await DB.allNotes();
      for (const n of notes) {
        if (n && typeof n.version === 'number' && n.version > versionCounter) {
          versionCounter = n.version;
        }
      }
    } catch (_) {}

    const now = Math.floor(Date.now() / 1000);
    if (versionCounter < now) versionCounter = now;

    bus.on('notes:imported', p => {
      if (p && typeof p.maxVersion === 'number' && p.maxVersion > versionCounter) {
        versionCounter = p.maxVersion;
      }
    });
  }

  /**
   * @returns {number}
   */
  function nextVersion() {
    const t = Math.floor(Date.now() / 1000);
    if (t <= versionCounter) versionCounter = versionCounter + 1;
    else versionCounter = t;
    return versionCounter;
  }

  /**
   * @param {string} text
   * @param {string} visibility
   * @param {Object|null} [parent] - {uid, owner}
   * @returns {Promise<Object>} Созданная заметка.
   * @throws {Error} 'empty' | 'db' | причина ошибки
   */
  async function create(text, visibility, parent) {
    const t = (text || '').trim();
    if (!t) throw new Error('empty');

    // null при неготовой модели — легально, backfill догонит.
    const vector = await Embedder.embed(t);

    const now = Date.now();
    const note = {
      uid: Utils.uid('n'),
      text: t,
      vector: vector ? Array.from(vector) : null,
      visibility: visibility === 'public' ? 'public' : 'private',
      parent: parent && parent.uid ? { uid: parent.uid, owner: parent.owner || null } : null,
      version: nextVersion(),
      publishedVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await DB.putNote(note);
    } catch (e) {
      Logger.error('Notes: create — не записать', String(e && e.message || e));
      throw e;
    }

    emit('note:created', note);
    return note;
  }

  /**
   * @param {string} uid
   * @param {string} newText
   * @returns {Promise<Object>}
   * @throws {Error} 'empty' | 'not found' | причина ошибки
   */
  async function edit(uid, newText) {
    const t = (newText || '').trim();
    if (!t) throw new Error('empty');

    const note = await DB.getNote(uid);
    if (!note) throw new Error('not found');

    // Эмбеддинг нового текста; null → vector null (см. контракт выше).
    const vector = await Embedder.embed(t);
    note.text = t;
    note.vector = vector ? Array.from(vector) : null;
    note.version = nextVersion();
    note.updatedAt = Date.now();

    try {
      await DB.putNote(note);
    } catch (e) {
      Logger.error('Notes: edit — не записать', String(e && e.message || e));
      throw e;
    }

    emit('note:updated', note);
    return note;
  }

  /**
   * @param {string} uid
   * @returns {Promise<Object>} Удалённая заметка (для вызывающего).
   * @throws {Error} 'not found' | причина ошибки
   */
  async function remove(uid) {
    const note = await DB.getNote(uid);
    if (!note) throw new Error('not found');

    try {
      await DB.delNote(uid);
    } catch (e) {
      Logger.error('Notes: remove — не удалить', String(e && e.message || e));
      throw e;
    }

    // Версия на момент удаления — канон deleted опубликует её же.
    emit('note:deleted', { uid, version: note.version });
    return note;
  }

  /**
   * @param {string} uid
   * @returns {Promise<Object>}
   * @throws {Error} 'not found' | причина ошибки
   */
  async function toggle(uid) {
    const note = await DB.getNote(uid);
    if (!note) throw new Error('not found');

    note.visibility = note.visibility === 'public' ? 'private' : 'public';
    note.version = nextVersion();
    note.updatedAt = Date.now();

    try {
      await DB.putNote(note);
    } catch (e) {
      Logger.error('Notes: toggle — не записать', String(e && e.message || e));
      throw e;
    }

    emit('note:updated', note);
    return note;
  }

  /**
   * @param {string} uid
   * @returns {Promise<Object|undefined>}
   */
  function get(uid) {
    return DB.getNote(uid);
  }

  /**
   * Эффективная версия канона: noteVersion (payload, истина) с
   * fallback на created_at (legacy-каноны v0.9).
   * @param {Object} canonical
   * @returns {number}
   */
  function effVersion(canonical) {
    if (typeof canonical.noteVersion === 'number' && canonical.noteVersion > 0) {
      return canonical.noteVersion;
    }
    return typeof canonical.version === 'number' ? canonical.version : 0;
  }

  /**
   * Применение своего канона с другого устройства: LWW по
   * noteVersion payload (не по created_at публикации).
   * @param {Object} canonical
   * @returns {Promise<boolean>} true — применено.
   */
  async function applyOwnCanonical(canonical) {
    if (!canonical || !canonical.uid) return false;

    const cur = await DB.getNote(canonical.uid);
    if (!cur) return false;

    const incoming = effVersion(canonical);
    if (incoming <= cur.version) return false;

    if (typeof canonical.text === 'string') cur.text = canonical.text;
    cur.vector = canonical.vec || null; // null → backfill
    if (canonical.visibility === 'public' || canonical.visibility === 'private') {
      cur.visibility = canonical.visibility;
    }
    if (canonical.parent) cur.parent = canonical.parent;
    cur.version = incoming;
    // Канон пришёл из сети — эта версия опубликована.
    cur.publishedVersion = Math.max(cur.publishedVersion || 0, incoming);
    cur.updatedAt = Date.now();

    try {
      await DB.putNote(cur);
    } catch (e) {
      Logger.warn('Notes: applyOwnCanonical — не записать', String(e && e.message || e));
      return false;
    }

    emit('note:updated', cur);
    return true;
  }

  /**
   * Восстановление отсутствующей заметки из своего канона
   * (новое устройство / после сброса).
   * @param {Object} canonical
   * @returns {Promise<boolean>}
   */
  async function restoreFromCanonical(canonical) {
    if (!canonical || !canonical.uid) return false;

    const cur = await DB.getNote(canonical.uid);
    if (cur) return applyOwnCanonical(canonical);

    const version = effVersion(canonical);
    const note = {
      uid: canonical.uid,
      text: canonical.text || '',
      vector: canonical.vec || null,
      visibility: canonical.visibility || 'private',
      parent: canonical.parent || null,
      version: version > 0 ? version : nextVersion(),
      // Восстановлено из сети — эта версия уже опубликована.
      publishedVersion: version > 0 ? version : 0,
      createdAt: canonical.ts || (canonical.version * 1000) || Date.now(),
      updatedAt: canonical.ts || Date.now(),
    };

    try {
      await DB.putNote(note);
    } catch (e) {
      Logger.warn('Notes: restoreFromCanonical — не записать', String(e && e.message || e));
      return false;
    }

    emit('note:created', note);
    return true;
  }

  /**
   * Доэмбеддинг заметок без вектора (созданных до готовности модели
   * или отредактированных при её недоступности). Вызывается из BOOT
   * по ai:ready. Каждая доэмбедденная заметка получает новую version
   * и уходит в сеть штатным путём (note:updated → очередь).
   * @returns {Promise<number>} Сколько заметок вылечено.
   */
  async function backfill() {
    let notes;
    try {
      notes = await DB.allNotes();
    } catch (_) {
      return 0;
    }

    let count = 0;

    for (const n of notes) {
      if (!n || n.vector || !n.text) continue;

      const v = await Embedder.embed(n.text);
      if (!v) continue; // модель снова не ответила — лечим на следующем ai:ready

      n.vector = Array.from(v);
      n.version = nextVersion();
      n.updatedAt = Date.now();

      try {
        await DB.putNote(n);
        emit('note:updated', n);
        count++;
      } catch (e) {
        Logger.warn('Notes: backfill — не записать ' + n.uid, String(e && e.message || e));
      }
    }

    if (count) Logger.info('Notes: backfill — доэмбеджено ' + count);
    return count;
  }

  return {
    init,
    create,
    edit,
    remove,
    toggle,
    get,
    applyOwnCanonical,
    restoreFromCanonical,
    backfill,
  };
}, ['DB', 'Embedder', 'EventBus', 'Logger', 'Utils']);
// ─── DOMAIN/Notes ─── END ───────────────────────────────────────────────────

// ─── DOMAIN/Mirror ─── START ────────────────────────────────────────────────
/**
 * Интерпретация входящих канонов: свой → notes (LWW по noteVersion;
 * deleted-канон побеждает при >= — быстрое «создал → удалил»
 * больше не теряется), чужой → mirror. Единственная точка записи в
 * mirror. Свои записи в mirror невозможны (И2); purgeSelf вычищает
 * исторические дубли. ts из payload — хронология ленты.
 *
 * net:answer → fetchTarget (дедуп 500) → mirror:fetch → NetService
 * точечная подписка (authors + #d) — подтяжка цели по ссылке.
 */
DI.register('Mirror', function (DB, Protocol, Notes, bus, Nostr, Logger) {
  /** @type {Set<string>} */
  const fetched = new Set();

  /**
   * Эффективная версия канона: noteVersion payload, fallback —
   * created_at (legacy-каноны v0.9 без noteVersion в payload).
   * @param {Object} c
   * @returns {number}
   */
  function effVersion(c) {
    if (typeof c.noteVersion === 'number' && c.noteVersion > 0) {
      return c.noteVersion;
    }
    return typeof c.version === 'number' ? c.version : 0;
  }

  /**
   * Вычистка исторических mirror-дублей своего владельца.
   * @returns {Promise<void>}
   */
  async function purgeSelf() {
    try {
      const pk = Nostr.getPubkey();
      if (!pk) return;

      const all = await DB.allMirror();
      const mine = all.filter(m => m && m.owner === pk);

      for (const m of mine) {
        await DB.delMirror(m.uid).catch(() => {});
      }

      if (mine.length) {
        Logger.info('Mirror: вычищено своих дублей — ' + mine.length);
      }
    } catch (_) {}
  }

  /**
   * Инициализация: подписки, стартовая чистка.
   */
  function init() {
    bus.on('net:canon', ev => {
      if (ev) applyCanon(ev);
    });

    bus.on('net:answer', a => {
      if (a && a.uid && a.owner) fetchTarget(a.uid, a.owner);
    });

    bus.on('net:resync', () => {
      fetched.clear();
    });

    Nostr.init().then(purgeSelf).catch(() => {});
  }

  /**
   * Применить входящее событие канона. Маршрутизация по владельцу.
   * @param {Object} ev - Nostr-событие kind 30078.
   * @returns {Promise<void>}
   */
  async function applyCanon(ev) {
    try {
      const canonical = await Protocol.decodeCanon(ev);
      if (!canonical || !canonical.uid || !canonical.owner) return;

      const myPk = Nostr.getPubkey();

      // Чужой канон → зеркало (сходимость решает DB.upsertMirror).
      if (!myPk || canonical.owner !== myPk) {
        await DB.upsertMirror(canonical);
        return;
      }

      // Свой канон: синк устройств / эхо удалений.
      const cur = await DB.getNote(canonical.uid);

      if (canonical.deleted) {
        if (!cur) return;
        // deleted побеждает при >= : удаление на той же версии —
        // законная финальная операция; более ранняя — игнорируется.
        if (effVersion(canonical) >= (typeof cur.version === 'number' ? cur.version : 0)) {
          await DB.delNote(canonical.uid);
          Logger.info('Mirror: удаление по эху v' + effVersion(canonical)
            + ' ' + canonical.uid.slice(0, 6));
        }
        return;
      }

      if (cur) {
        const applied = await Notes.applyOwnCanonical(canonical);
        if (applied) {
          Logger.info('Mirror: синк ' + canonical.uid.slice(0, 6) + ' v' + effVersion(canonical));
        }
        return;
      }

      const restored = await Notes.restoreFromCanonical(canonical);
      if (restored) {
        Logger.info('Mirror: restore ' + canonical.uid.slice(0, 6) + ' v' + effVersion(canonical));
      }
    } catch (e) {
      Logger.warn('Mirror: applyCanon', String(e && e.message || e));
    }
  }

  /**
   * Подтяжка заметки по ответу-ссылке.
   * @param {string} uid
   * @param {string} owner
   */
  function fetchTarget(uid, owner) {
    if (!uid || !owner) return;
    if (DB.hasOwn(uid)) return;
    if (fetched.has(uid)) return;

    fetched.add(uid);
    if (fetched.size > 500) {
      const arr = Array.from(fetched);
      fetched.clear();
      for (let i = Math.floor(arr.length / 2); i < arr.length; i++) {
        fetched.add(arr[i]);
      }
    }

    try { bus.emit('mirror:fetch', { uid, owner }); } catch (_) {}
  }

  return { init, applyCanon, fetchTarget };
}, ['DB', 'Protocol', 'Notes', 'EventBus', 'Nostr', 'Logger']);
// ─── DOMAIN/Mirror ─── END ──────────────────────────────────────────────────

// ─── DOMAIN/Context ─── START ───────────────────────────────────────────────
/**
 * Контекст поиска: пин/дрейф/ввод. Приоритет drift > pin > input.
 * Пин несёт идентичность заметки {uid, owner} (И1) и вектор.
 *
 * КОНТРАКТ v1.0:
 * - setPin требует вектор: без него тихо НЕ пинует и НЕ меняет
 *   состояние (защита от fact-only и безвекторных записей; честный
 *   тост показывают UI-модули до вызова).
 * - context всегда новый объект (подписки Object.is/shallowEqual
 *   корректны); embed недоступен → vector null (модель не готова —
 *   закон v1.0: не заменяем мусорными векторами).
 * - init(): подписка note:pin → setPin.
 *
 * v1.0.1: функции фабрики объявлены локально (НЕ методами литерала) —
 * подписка в init() держит легальную ссылку на замыкание. В v1.0.0
 * ссылка на setPin внутри bus.on отсутствовала в скоупе → пин по
 * кнопке из NoteView падал ReferenceError.
 */
DI.register('Context', function (Store, Embedder, Config, Utils, bus) {
  /** @type {string} */
  let inputText = '';
  /** @type {Float32Array|null} */
  let inputVector = null;
  /** @type {Object|null} */
  let pin = null;

  /**
   * Вычисление активного контекста.
   * @returns {Object}
   */
  function activeContext() {
    const hasInput = !!inputText.trim();

    if (pin && hasInput) {
      return {
        source: 'drift',
        uid: pin.uid,
        owner: pin.owner,
        text: inputText.trim(),
        vector: inputVector,
        pinText: pin.text,
      };
    }

    if (pin) {
      return {
        source: 'pin',
        uid: pin.uid,
        owner: pin.owner,
        text: pin.text,
        vector: pin.vector,
      };
    }

    if (hasInput) {
      return {
        source: 'input',
        uid: null,
        owner: null,
        text: inputText.trim(),
        vector: inputVector,
      };
    }

    return {
      source: null,
      uid: null,
      owner: null,
      text: '',
      vector: null,
    };
  }

  /**
   * Пуш контекста в Store.
   */
  function push() {
    Store.setState({ context: activeContext() });
  }

  /**
   * Дебаунс эмбеддинга ввода с защитой от гонок (сверка текста).
   */
  const debouncedEmbed = Utils.debounce(() => {
    const t = inputText.trim();
    if (!t) {
      inputVector = null;
      push();
      return;
    }

    Embedder.embed(t).then(v => {
      if (inputText.trim() === t) {
        inputVector = v;
        push();
      }
    });
  }, Config.get('debounce', 350));

  /**
   * @param {string} text
   */
  function setInput(text) {
    inputText = text || '';
    if (!inputText.trim()) inputVector = null;
    push();
    debouncedEmbed();
  }

  /**
   * @param {Object} note - Заметка с вектором (notes или mirror).
   */
  function setPin(note) {
    if (!note || !note.vector) return;
    pin = {
      uid: note.uid,
      owner: note.owner !== undefined ? note.owner : null,
      text: note.text,
      vector: note.vector,
    };
    push();
  }

  /**
   * Снять пин (ввод не трогаем — дрейф закончится, ввод останется).
   */
  function clearPin() {
    pin = null;
    push();
  }

  /**
   * Полная очистка (ввод + пин).
   */
  function clear() {
    inputText = '';
    inputVector = null;
    pin = null;
    debouncedEmbed.cancel();
    push();
  }

  /**
   * @returns {Float32Array|Array<number>|null}
   */
  function getVector() {
    return activeContext().vector;
  }

  /**
   * @returns {Object}
   */
  function getActive() {
    return activeContext();
  }

  /**
   * @returns {Object|null}
   */
  function getPin() {
    return pin;
  }

  /**
   * Инициализация: подписка на пин из UI (NoteView).
   */
  function init() {
    bus.on('note:pin', note => {
      if (note) setPin(note);
    });
  }

  return {
    setInput,
    setPin,
    clearPin,
    clear,
    getVector,
    getActive,
    getPin,
    init,
  };
}, ['Store', 'Embedder', 'Config', 'Utils', 'EventBus']);
// ─── DOMAIN/Context ─── END ─────────────────────────────────────────────────

// ─── DOMAIN/Feed ─── START ──────────────────────────────────────────────────
/**
 * Сборка лент из notes (свои: все) и mirror (чужие: public).
 * Свои private участвуют в поиске — ядро продукта.
 * Хронология чужих — по ts из payload (время заметки), не по
 * version (время публикации канона).
 *
 * ИЗМЕНЕНИЕ v1.0: подписки db:change/db:mirror — через debounce
 * 120мс (гасит шторм полных сканов при пакетном сетевом синке;
 * seq-guard дополнительно отбрасывает устаревшие проходы).
 * Ликая логика v0.9.9 сохранена.
 */
DI.register('Feed', function (DB, Ranker, Store, bus, Logger, Utils, Config) {
  /** @type {number} */
  let seq = 0;
  /** @type {Array<Function>} */
  let unsubs = [];

  /**
   * Пересборка лент (seq-guard).
   * @returns {Promise<void>}
   */
  function refresh() {
    const my = ++seq;
    const ctx = Store.get('context');

    return Promise.all([DB.allNotes(), DB.allMirror()]).then(([notes, mirror]) => {
      if (my !== seq) return;

      const ownUids = new Set();
      notes.forEach(n => {
        if (n) ownUids.add(n.uid);
      });

      const pinUid = ctx.uid || null;
      const pinOwner = ctx.owner || null;

      const ownNotes = notes
        .filter(n => n && n.text)
        .map(n => ({ uid: n.uid, owner: null, text: n.text, vector: n.vector,
                     parent: n.parent, visibility: n.visibility,
                     createdAt: n.createdAt, updatedAt: n.updatedAt,
                     own: true }));

      const foreignPublic = mirror
        .filter(m => m && m.visibility === 'public' && m.text && !ownUids.has(m.uid))
        .map(m => {
          const ts = m.ts || (m.version * 1000);
          return { uid: m.uid, owner: m.owner, text: m.text, vector: m.vec,
                   parent: m.parent, visibility: 'public',
                   createdAt: ts, updatedAt: ts,
                   own: false };
        });

      if (!ctx.source) {
        const merged = [...ownNotes, ...foreignPublic]
          .filter(n => !isPin(n, pinUid, pinOwner))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        Store.setState({
          feed: merged,
          lists: { local: [], world: [], seren: [] },
        });

        return;
      }

      if (!ctx.vector) return;

      const all = [...ownNotes, ...foreignPublic]
        .filter(n => !isPin(n, pinUid, pinOwner));

      const items = [];
      const dataMap = new Map();
      const seenUids = new Set();

      for (const n of all) {
        if (!n.vector || seenUids.has(n.uid)) continue;
        seenUids.add(n.uid);
        items.push({ id: n.uid, vector: n.vector });
        dataMap.set(n.uid, n);
      }

      return Ranker.cosineBatch(ctx.vector, items).then(scored => {
        if (my !== seq) return;

        const { relevant, seren } = Ranker.split(scored);

        const toRes = s => {
          const n = dataMap.get(s.id);
          return n ? Object.assign({}, n, { score: s.score }) : null;
        };

        const rel = relevant.map(toRes).filter(Boolean);
        const srn = seren.map(toRes).filter(Boolean);

        Store.setState({
          lists: {
            local: rel.filter(n => n.own),
            world: rel.filter(n => !n.own),
            seren: srn,
          },
          feed: [],
        });
      });
    }).catch(err => {
      Logger.warn('Feed: ошибка refresh', String(err && err.message || err));
    });
  }

  /**
   * @param {Object} n
   * @param {string|null} pinUid
   * @param {string|null} pinOwner
   * @returns {boolean}
   */
  function isPin(n, pinUid, pinOwner) {
    if (!pinUid) return false;
    if (n.uid !== pinUid) return false;
    if (n.own && !pinOwner) return true;
    if (!n.own && pinOwner && n.owner === pinOwner) return true;
    return false;
  }

  /**
   * Инициализация.
   */
  function init() {
    const debouncedRefresh = Utils.debounce(refresh, 120);

    unsubs.push(Store.subscribe(s => s.context, () => refresh(), Store.shallowEqual));
    unsubs.push(bus.on('db:change', debouncedRefresh));
    unsubs.push(bus.on('db:mirror', debouncedRefresh));

    refresh();
  }

  /**
   * Отписка.
   */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, refresh };
}, ['DB', 'Ranker', 'Store', 'EventBus', 'Logger', 'Utils', 'Config']);
// ─── DOMAIN/Feed ─── END ────────────────────────────────────────────────────

// ─── DOMAIN/Provenance ─── START ────────────────────────────────────────────
/**
 * Генеалогия по parent {uid, owner} через notes + mirror.
 * mirror-записи своих uid и deleted исключаются (дубли/мусор).
 * Цикл-защита: seen до рекурсии/спуска.
 *
 * ИЗМЕНЕНИЕ v1.0 (безопасное): descendants — BFS по предпостроенному
 * индексу parent→children вместо полного скана базы на каждый уровень
 * (O(N) вместо O(уровни×N)); семантика идентична, включая циклы и
 * ромбы. ancestors — кэш ограничен 100 записями (раньше рос
 * неограниченно за длинную сессию).
 */
DI.register('Provenance', function (DB, bus, Nostr) {
  /** @type {Map<string, {chain: Array, timestamp: number}>} */
  const cache = new Map();
  const CACHE_TTL = 5000;
  const CACHE_MAX = 100;

  /**
   * Все заметки: свои (notes, полные) + чужой живой mirror.
   * @returns {Promise<Array<Object>>}
   */
  function loadAll() {
    return Promise.all([DB.allNotes(), DB.allMirror()]).then(([notes, mirror]) => {
      const out = notes.map(n => ({
        uid: n.uid, owner: null, text: n.text, visibility: n.visibility,
        parent: n.parent, isOwn: true,
      }));

      mirror.forEach(m => {
        if (!m || m.visibility === 'deleted') return;
        if (DB.hasOwn(m.uid)) return;
        out.push({
          uid: m.uid, owner: m.owner, text: m.text, visibility: m.visibility,
          parent: m.parent, isOwn: false,
        });
      });

      return out;
    });
  }

  /**
   * @param {Array<Object>} all
   * @returns {Map<string, Object>}
   */
  function buildIndex(all) {
    const byUid = new Map();
    all.forEach(n => {
      if (n && n.uid) byUid.set(n.uid, n);
    });
    return byUid;
  }

  /**
   * @param {Object} note
   * @param {Map<string, Object>} idx
   * @returns {Object|null}
   */
  function resolveParent(note, idx) {
    if (!note || !note.parent || !note.parent.uid) return null;
    return idx.get(note.parent.uid) || null;
  }

  /**
   * Прямые дети заметки.
   * @param {string} uid
   * @returns {Promise<Array<Object>>}
   */
  function children(uid) {
    if (!uid) return Promise.resolve([]);

    return loadAll().then(all => {
      return all.filter(n => n.parent && n.parent.uid === uid);
    });
  }

  /**
   * Все потомки (BFS по индексу parent→children, защита от циклов).
   * @param {string} uid
   * @returns {Promise<Array<Object>>}
   */
  function descendants(uid) {
    if (!uid) return Promise.resolve([]);

    return loadAll().then(all => {
      // Индекс: родитель → его дети (один проход по базе).
      const byParent = new Map();
      for (const n of all) {
        if (n.parent && n.parent.uid) {
          if (!byParent.has(n.parent.uid)) byParent.set(n.parent.uid, []);
          byParent.get(n.parent.uid).push(n);
        }
      }

      const out = [];
      const seenIds = new Set([uid]);
      let frontier = [uid];

      while (frontier.length) {
        const next = [];

        for (const p of frontier) {
          const kids = byParent.get(p) || [];
          for (const k of kids) {
            if (!seenIds.has(k.uid)) {
              seenIds.add(k.uid);
              out.push(k);
              next.push(k.uid);
            }
          }
        }

        frontier = next;
      }

      return out;
    });
  }

  /**
   * Цепочка предков от заметки до корня.
   * @param {string} uid
   * @returns {Promise<Array<Object>>}
   */
  async function ancestors(uid) {
    if (!uid) return [];

    const cached = cache.get(uid);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.chain;
    }

    const all = await loadAll();
    const idx = buildIndex(all);

    let current = idx.get(uid) || null;
    const chain = [];
    const seen = new Set([uid]);

    while (current && current.parent && current.parent.uid) {
      const parent = resolveParent(current, idx);
      if (!parent) break;
      if (seen.has(parent.uid)) break;

      seen.add(parent.uid);
      chain.push(parent);
      current = parent;
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(uid, { chain, timestamp: Date.now() });
    return chain;
  }

  /**
   * @param {Object} note
   * @returns {Promise<boolean>}
   */
  function hasResolvableParent(note) {
    if (!note || !note.parent || !note.parent.uid) {
      return Promise.resolve(false);
    }

    return loadAll().then(all => {
      const idx = buildIndex(all);
      return !!resolveParent(note, idx);
    });
  }

  /**
   * Очистка кэша.
   */
  function clearCache() {
    cache.clear();
  }

  bus.on('db:change', clearCache);
  bus.on('db:mirror', clearCache);

  return { children, descendants, ancestors, hasResolvableParent, loadAll, clearCache };
}, ['DB', 'EventBus', 'Nostr']);
// ─── DOMAIN/Provenance ─── END ──────────────────────────────────────────────

// ─── DOMAIN/Influence ─── START ─────────────────────────────────────────────
/**
 * Резонанс: уникальные авторы потомков по ключу uid родителя.
 * Свои дети — 'self'; чужие — owner. mirror-дубли своих uid
 * и неизвестные авторы не считаются.
 *
 * ИЗМЕНЕНИЕ v1.0: db:change/db:mirror — через debounce 120мс
 * (как Feed): пакетный сетевой синк не устраивает шторм rebuild'ов.
 * Точечные note:created/updated — без дебаунса (мгновенный отклик
 * на собственные действия). note:deleted — прямой rebuild.
 */
DI.register('Influence', function (DB, bus, Logger, Utils, Config) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  /** @type {number} */
  let seq = 0;

  /**
   * @param {Object} n
   * @returns {string|null}
   */
  function parentKey(n) {
    if (!n || !n.parent || !n.parent.uid) return null;
    return n.parent.uid;
  }

  /**
   * @returns {Promise<void>}
   */
  function rebuild() {
    const my = ++seq;

    return Promise.all([DB.allNotes(), DB.allMirror()]).then(([notes, mirror]) => {
      if (my !== seq) return;

      const m = new Map();

      const add = (key, author) => {
        if (!key || !author) return;
        if (!m.has(key)) m.set(key, new Set());
        m.get(key).add(author);
      };

      notes.forEach(n => {
        if (!n) return;
        add(parentKey(n), 'self');
      });

      mirror.forEach(mm => {
        if (!mm || mm.visibility !== 'public') return;
        if (DB.hasOwn(mm.uid)) return;
        add(parentKey(mm), mm.owner || null);
      });

      map.clear();
      m.forEach((v, k) => map.set(k, v));

      try { bus.emit('influence:updated'); } catch (_) {}
    }).catch(e => Logger.warn('Influence: ошибка rebuild', String(e && e.message || e)));
  }

  /**
   * Точечное обновление для своей заметки (мгновенный отклик).
   * @param {Object} note
   */
  function updateForNote(note) {
    const key = parentKey(note);
    if (!key) return;

    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add('self');

    try { bus.emit('influence:updated'); } catch (_) {}
  }

  /**
   * @param {string} uid
   * @returns {number}
   */
  function resonance(uid) {
    if (!uid) return 0;
    const s = map.get(uid);
    return s ? s.size : 0;
  }

  /**
   * Инициализация.
   */
  function init() {
    const debouncedRebuild = Utils.debounce(rebuild, 120);

    bus.on('note:created', updateForNote);
    bus.on('note:updated', updateForNote);
    bus.on('note:deleted', () => rebuild());
    bus.on('db:change', debouncedRebuild);
    bus.on('db:mirror', debouncedRebuild);

    rebuild();
  }

  return { init, resonance, rebuild };
}, ['DB', 'EventBus', 'Logger', 'Utils', 'Config']);
// ─── DOMAIN/Influence ─── END ───────────────────────────────────────────────

// ─── DOMAIN/Account ─── START ───────────────────────────────────────────────
/**
 * Аккаунт: показ/ввод ключа (nsec/npub/ncryptsec, NIP-49),
 * вход с заменой ключа, JSON-архив v3 (заметки + настройки).
 *
 * ИЗМЕНЕНИЯ v1.0:
 * - importArchive: импортированные заметки получают publishedVersion=0
 *   — переиздаются один раз (для переноса между аккаунтами и
 *   восстановления); повторная републикация той же версии исключена
 *   логикой очереди NetService.
 * - Событие-призрак config:imported удалено (слушателей не было);
 *   настройки из архива применяются через Config.set и подхватываются
 *   живыми читателями (Ranker читает пороги при каждом split, тема/
 *   язык — при открытии меню).
 * Остальное — поведение v0.9.9: enterKey (замена ключа + DB.reset +
 * рестарт NetService через 500мс; гонки с импортом нет: старт
 * переочередит всё неопубликованное, note:created-хендлеры ловят
 * остальное), экспорт v3, whitelist-конфиг, setSyncEnabled.
 */
DI.register('Account', function (Config, Nostr, Crypto, DB, bus, Logger) {
  /** @type {Array<string>} */
  const CONFIG_WHITELIST = [
    'threshold',
    'serendipity',
    'duplicateThreshold',
    'similarityDisplay',
    'lang',
    'theme',
  ];

  /**
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
   * @returns {Promise<string|null>}
   */
  async function getNpub() {
    const pk = Nostr.getPubkey();
    if (!pk) return null;
    return Crypto.encodeNpub(pk);
  }

  /**
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
   * Экспорт ключа: NIP-49 (с паролем или без), fallback nsec.
   * @param {string} [password]
   * @returns {Promise<string|null>}
   */
  async function getWrappedKey(password) {
    const sk = Nostr.getSecretKey();
    if (!sk) return null;

    const wrapped = await Crypto.encryptKey(sk, String(password || ''));
    if (wrapped) {
      Config.set('keyExported', true);
      return wrapped;
    }

    const nsec = await Crypto.encodeNsec(sk);
    if (nsec) {
      Logger.warn('Account: NIP-49 недоступен, ключ в формате nsec');
      Config.set('keyExported', true);
      return nsec;
    }

    return null;
  }

  /**
   * @param {string} input
   * @param {string} [password]
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

      // Замена аккаунта: локальные данные (notes + mirror) стираются.
      await DB.reset();

      Config.set('keyExported', false);

      try { bus.emit('account:changed', { pubkey: pk }); } catch (_) {}

      // Рестарт сети: stop снимает подписки/очередь; старт через 500мс
      // переочередит всё неопубликованное нового аккаунта. Заметки,
      // импортируемые сразу после enterKey, попадают в очередь либо
      // снапшотом старта, либо хендлером note:created (он регистрируется
      // ДО снапшота) — гонки нет.
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

  /**
   * Валидация заметки из внешнего источника (архив).
   * @param {Object} n
   * @returns {Object|null}
   */
  function sanitizeNote(n) {
    if (!n || typeof n.uid !== 'string' || typeof n.text !== 'string') return null;
    if (n.text.length > Config.get('maxNoteTextLength', 10000)) return null;

    let vector = null;
    if (Array.isArray(n.vector)) {
      vector = n.vector.filter(x => typeof x === 'number' && isFinite(x));
    }

    let parent = null;
    if (n.parent && typeof n.parent === 'object' && typeof n.parent.uid === 'string' && n.parent.uid) {
      parent = { uid: n.parent.uid, owner: n.parent.owner || null };
    }

    return {
      uid: n.uid,
      text: n.text,
      vector,
      visibility: n.visibility === 'public' ? 'public' : 'private',
      parent,
      version: typeof n.version === 'number' && n.version > 0 ? n.version : Math.floor(Date.now() / 1000),
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
      updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.now(),
    };
  }

  /**
   * @param {boolean} [includeKey]
   * @param {string} [keyPassword]
   * @returns {Promise<{json: string, filename: string}|null>}
   */
  async function exportArchive(includeKey, keyPassword) {
    try {
      await Nostr.init();

      const notes = await DB.allNotes();
      const archive = {
        version: 3,
        app: 'noomium',
        createdAt: Date.now(),
        pubkey: Nostr.getPubkey(),
        ncryptsec: null,
        notes: notes.map(sanitizeNote).filter(Boolean),
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
   * @param {string} text
   * @returns {{ok: boolean, error?: string, archive?: Object}}
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
      const note = sanitizeNote(raw);
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
        version: typeof data.version === 'number' ? data.version : 3,
        pubkey: typeof data.pubkey === 'string' ? data.pubkey : null,
        ncryptsec: (typeof data.ncryptsec === 'string' && data.ncryptsec) ? data.ncryptsec : null,
        notes,
        config,
        noteCount: notes.length,
      },
    };
  }

  /**
   * Импорт: LWW по version (совпадающие uid обновляются).
   * publishedVersion=0 — заметки переиздаются один раз.
   * @param {Object} archive
   * @returns {Promise<number>}
   */
  async function importArchive(archive) {
    if (!archive || !Array.isArray(archive.notes)) return 0;

    let applied = 0;
    let maxVersion = 0;

    for (const note of archive.notes) {
      try {
        const cur = await DB.getNote(note.uid);
        if (cur && cur.version >= note.version) continue;

        const record = {
          uid: note.uid,
          text: note.text,
          vector: note.vector,
          visibility: note.visibility,
          parent: note.parent,
          version: note.version,
          publishedVersion: 0,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        };

        await DB.putNote(record);

        try { bus.emit('note:created', record); } catch (_) {}

        if (note.version > maxVersion) maxVersion = note.version;
        applied++;
      } catch (e) {
        Logger.warn('Account: import note ' + note.uid, String(e && e.message || e));
      }
    }

    if (maxVersion > 0) {
      try { bus.emit('notes:imported', { maxVersion }); } catch (_) {}
    }

    const cfg = archive.config || {};
    CONFIG_WHITELIST.forEach(k => {
      if (k in cfg) {
        Config.set(k, cfg[k]);
      }
    });

    Logger.info('Account: импортировано заметок — ' + applied);
    return applied;
  }

  /**
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

// ═══ СЛОЙ: UI ═════════════════════════════════════════════════════════════════

// ─── UI/Modal ─── START ─────────────────────────────────────────────────────
/**
 * Универсальные модалки: open/close/confirm, Escape, клик по overlay,
 * возврат фокуса, автофокус.
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9:
 * - confirm: подтверждение — primary по умолчанию (янтарная);
 *   розовая (danger) — только для явной деструкции. В v0.9.9 у ОК
 *   стояли оба класса — розовый всегда перекрывал primary.
 * - Пустой список кнопок → #modal-f скрывается целиком (нет пустой
 *   полосы с бордером).
 * - Контент — только textContent/appendChild (Закон 1).
 */
DI.register('Modal', function (I18n) {
  let overlay, modal, titleEl, bodyEl, footEl, closeBtn;
  let escHandler = null;
  let lastFocus = null;

  /**
   * Ленивая привязка к DOM.
   */
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
   * @param {Object} opts - {title, body (string|Element),
   *   buttons: [{text, primary?, danger?, onClick}]}
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
      // Пустой футер — скрываем целиком (нет пустой полосы).
      footEl.classList.toggle('hidden', !(opts.buttons && opts.buttons.length));

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

    setTimeout(() => {
      if (!modal) return;
      const focusable = modal.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length) focusable[0].focus();
    }, 50);
  }

  /**
   * Закрыть.
   */
  function close() {
    if (!overlay) return;

    overlay.classList.remove('on');

    if (escHandler) {
      document.removeEventListener('keydown', escHandler);
      escHandler = null;
    }

    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (_) {}
    }
  }

  /**
   * @param {string} title
   * @param {string} text
   * @param {Function} onOk
   * @param {string} [okText]
   * @param {Object} [opts] - {danger: boolean} - розовая кнопка ОК.
   */
  function confirm(title, text, onOk, okText, opts) {
    const o = opts || {};
    open({
      title,
      body: text,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: close },
        {
          text: okText || 'OK',
          primary: !o.danger,
          danger: !!o.danger,
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
 * Тосты: 4 типа, лимит, автоудаление, haptic.
 * Контейнер #toasts — FIXED снизу, z-index 1300 (см. style.css):
 * видны поверх модалки и noteview (H-01).
 */
DI.register('Toast', function (Config) {
  /** @type {Object<string, string>} */
  const ICONS = { ok: '✓', err: '✕', warn: '!', info: '◆' };

  /** @type {HTMLElement|null} */
  let container = null;

  /**
   * @param {'ok'|'err'|'warn'|'info'} type
   */
  function haptic(type) {
    try {
      const tg = DI.resolve('TelegramAdapter');
      if (tg && tg.isTelegram()) {
        if (type === 'ok') tg.hapticFeedback('success');
        else if (type === 'err') tg.hapticFeedback('error');
        else tg.hapticFeedback('light');
      }
    } catch (_) {} // адаптер недоступен до BOOT-фазы — не важно
  }

  /**
   * @param {'ok'|'err'|'warn'|'info'} type
   * @param {string} msg
   * @param {number} [ms]
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

    const limit = Config.get('toastMaxVisible', 3);
    while (container.children.length > limit) {
      container.removeChild(container.firstChild);
    }

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
 * Оверлей загрузки модели: показ с задержкой 500мс (быстрый кэш-старт
 * не мелькает), скрытие по ai:status model.
 *
 * v1.0: кнопка «Продолжить без ИИ» — оверлей перестаёт быть
 * блокировкой. Модель качается в фоне; если докачается — штатный
 * ai:ready → backfill. Заметки, созданные до готовности, сохраняются
 * без вектора (null) и доэмбедживаются автоматически.
 * stalled (120с без прогресса / ошибка воркера) — оверлей уходит сам.
 */
DI.register('Progress', function (bus, I18n) {
  let overlay, fill, pctEl, infoEl, skipBtn;
  let showTimer = null;
  let forcedSkip = false;
  const SHOW_DELAY = 500;

  /**
   * Привязка к DOM + кнопка «Продолжить без ИИ».
   */
  function bind() {
    if (overlay) return;

    overlay = document.getElementById('progress');
    fill = document.getElementById('prog-fill');
    pctEl = document.getElementById('prog-pct');
    infoEl = document.getElementById('prog-info');

    const c = overlay ? overlay.querySelector('.prog-c') : null;
    if (c && !c.querySelector('.prog-skip')) {
      skipBtn = document.createElement('button');
      skipBtn.className = 'prog-skip';
      skipBtn.type = 'button';
      skipBtn.textContent = I18n.t('progress.skip');
      skipBtn.addEventListener('click', skip);
      c.appendChild(skipBtn);
    }
  }

  /**
   * Показ (если юзер ещё не пропустил).
   */
  function show() {
    if (forcedSkip) return;
    if (overlay) overlay.classList.add('on');
  }

  /**
   * Скрытие.
   */
  function hide() {
    if (overlay) overlay.classList.remove('on');
  }

  /**
   * Ручной пропуск: интерфейс свободен, модель докачивается в фоне.
   */
  function skip() {
    forcedSkip = true;
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    hide();
  }

  /**
   * @param {Object} data - {pct|percent, loadedMB, totalMB, model}
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
   * Инициализация.
   */
  function init() {
    bind();

    bus.on('ai:progress', e => update(e));

    bus.on('ai:status', e => {
      if (!e) return;

      if (e.mode === 'loading') {
        if (e.stalled) {
          // Загрузка сорвалась — оверлей не нужен, интерфейс свободен.
          skip();
          return;
        }

        update(e);

        if (!showTimer && overlay && !overlay.classList.contains('on') && !forcedSkip) {
          showTimer = setTimeout(() => {
            show();
            showTimer = null;
          }, SHOW_DELAY);
        }
      } else {
        // model
        if (showTimer) {
          clearTimeout(showTimer);
          showTimer = null;
        }
        forcedSkip = true;
        hide();
      }
    });

    bus.on('i18n:change', () => {
      if (skipBtn) skipBtn.textContent = I18n.t('progress.skip');
    });
  }

  return { init, show, hide, update };
}, ['EventBus', 'I18n']);
// ─── UI/Progress ─── END ────────────────────────────────────────────────────

// ─── UI/HeaderStatus ─── START ──────────────────────────────────────────────
/**
 * Индикаторы шапки: сеть/ИИ, офлайн-бар, клик по статусу сети —
 * переподключение.
 *
 * ИЗМЕНЕНИЕ v1.0: ai-статус stalled → 'ии нет' (dot warn) —
 * вместо вечно-пульсирующего «модель» при сорвавшейся загрузке.
 */
DI.register('HeaderStatus', function (bus, I18n, Embedder) {
  let netDot, netTxt, aiDot, aiTxt, offlineBar;
  let unsubs = [];
  let currentNetStatus = 'disconnected';
  let currentAiState = { mode: 'loading', percent: 0, stalled: false };

  /**
   * Привязка к DOM.
   */
  function bind() {
    netDot = document.getElementById('st-net-dot');
    netTxt = document.getElementById('st-net-txt');
    aiDot = document.getElementById('st-ai-dot');
    aiTxt = document.getElementById('st-ai-txt');
    offlineBar = document.getElementById('offline-bar');
  }

  /**
   * @param {string} mode - 'loading'|'model'
   * @param {number} [percent]
   * @param {boolean} [stalled]
   */
  function setAI(mode, percent, stalled) {
    currentAiState = { mode, percent: percent || 0, stalled: !!stalled };

    if (!aiDot || !aiTxt) return;

    if (mode === 'model') {
      aiDot.className = 'dot ok';
      aiTxt.textContent = I18n.t('st.ai.ready');
    } else if (stalled) {
      aiDot.className = 'dot warn';
      aiTxt.textContent = I18n.t('st.ai.off');
    } else {
      aiDot.className = 'dot load';
      aiTxt.textContent = I18n.t('st.ai.loading') + (currentAiState.percent ? ' ' + Math.round(currentAiState.percent) + '%' : '');
    }
  }

  /**
   * @param {string} status
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

    if (offlineBar) {
      const offline = status === 'failed' && typeof navigator !== 'undefined' && navigator.onLine === false;
      offlineBar.classList.toggle('on', offline);
    }
  }

  /**
   * Инициализация.
   */
  function init() {
    bind();

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

    window.addEventListener('offline', () => setNet('failed'));
    window.addEventListener('online', () => {
      if (offlineBar) offlineBar.classList.remove('on');
    });

    unsubs.push(bus.on('ai:status', e => setAI(e.mode, e.percent, e.stalled)));
    unsubs.push(bus.on('net:status', e => setNet(e.status)));

    unsubs.push(bus.on('i18n:change', () => {
      setAI(currentAiState.mode, currentAiState.percent, currentAiState.stalled);
      setNet(currentNetStatus);
    }));

    const init = Embedder.getState();
    setAI(init.mode, init.percent, init.stalled);
    setNet('disconnected');
  }

  /**
   * Отписка.
   */
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
 * Онбординг: 8 секций механик + чекбокс «больше не показывать»
 * (только firstRun; из меню — showHelp() без чекбокса).
 *
 * ИЗМЕНЕНИЕ v1.0: показ не ждёт модель бесконечно. Раньше онбординг
 * стоял за Embedder.load() (до 120с+ на холодном старте); теперь —
 * модель готова ИЛИ 30с, что раньше. Прогресс больше не блокирует
 * интерфейс, онбординг не блокирует знакомство с приложением.
 */
DI.register('Onboarding', function (Config, Modal, I18n, Embedder) {
  /**
   * @param {boolean} firstRun
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
      ['⌫ ' + I18n.t('onb.delete.t'), I18n.t('onb.delete.d')],
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
   * @param {boolean} [firstRun]
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
   * Инициализация: первый запуск → показ (модель готова ИЛИ 30с).
   */
  function init() {
    if (Config.get('onboarded', false)) return;

    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      showHelp(true);
    };

    // Страховка: модель качается долго/сорвалась — знакомство
    // с приложением не должно ждать загрузки.
    const timer = setTimeout(show, 30000);

    Embedder.load().then(() => {
      clearTimeout(timer);
      show();
    }).catch(() => {
      clearTimeout(timer);
      show();
    });
  }

  return { init, showHelp };
}, ['Config', 'Modal', 'I18n', 'Embedder']);
// ─── UI/Onboarding ─── END ──────────────────────────────────────────────────

// ─── UI/Composer ─── START ──────────────────────────────────────────────────
/**
 * Ввод: лимиты (soft 1200 / hard 2000 / max 2500), тумблер видимости,
 * Ctrl+Enter, VisualViewport-клавиатура, отправка через Notes.create.
 * Родитель = пин {uid, owner} (И1). После отправки пин НЕ снимается
 * («мама» для серии заметок); контекст возвращается в 'pin'.
 *
 * КОНТРАКТ v1.0:
 * - Notes.create REJECT → тост 'toast.save.fail', текст ОСТАЁТСЯ в
 *   textarea, кнопка восстанавливается (Закон 2, B-02).
 * - mode='loading' (не stalled) и текст непуст → hint 'ai.pending':
 *   отправка НЕ блокируется — заметка сохранится без вектора,
 *   backfill доэмбеддит после ai:ready.
 * - Double-click защита: sending-флаг + disabled.
 */
DI.register('Composer', function (Context, Notes, Store, I18n, bus, Toast, Utils, Config, Embedder) {
  let ta, cnt, sendBtn, toggle, footEl;
  let sending = false;
  let unsubs = [];
  let vvCleanup = null;
  let iconTimer = null;

  const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';

  const SEND_SPINNER = '<span class="btn-spinner"></span>';

  /**
   * Вставить иконку отправки, если кнопка пуста.
   */
  function ensureSendIcon() {
    if (!sendBtn || sending) return;
    if (!sendBtn.querySelector('svg, .btn-spinner')) {
      sendBtn.innerHTML = SEND_ICON;
    }
  }

  /**
   * Счётчик и лимиты. Приоритет подсказок: max > hard > soft >
   * ai.pending (модель учится, текст непуст).
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
    } else if (len > 0) {
      const st = Embedder.getState();
      if (st.mode === 'loading' && !st.stalled) {
        hint = I18n.t('ai.pending');
        hintLevel = 'warn';
      }
    }

    cnt.style.color = color;
    updateHint(hint, hintLevel);

    if (sendBtn) {
      sendBtn.disabled = len >= max || sending;
    }
  }

  /**
   * @param {string|null} text
   * @param {'warn'|'err'|null} [level]
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
      if (footEl && footEl.parentNode) {
        footEl.parentNode.insertBefore(hintEl, footEl.nextSibling);
      }
    }

    hintEl.textContent = text;
    hintEl.className = level === 'err' ? 'err' : 'warn';
  }

  /**
   * @param {string} mode - 'private' | 'world'
   */
  function reflectMode(mode) {
    if (!toggle) return;
    toggle.setAttribute('data-mode', mode);
    toggle.querySelectorAll('.mt-opt').forEach(o =>
      o.classList.toggle('on', o.getAttribute('data-v') === mode)
    );
  }

  /**
   * @param {boolean} on
   */
  function setSendingUI(on) {
    if (!sendBtn) return;
    sendBtn.disabled = on;
    sendBtn.classList.toggle('sending', on);
    sendBtn.innerHTML = on ? SEND_SPINNER : SEND_ICON;
  }

  /**
   * Отправка: Notes.create(text, visibility, parent).
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

    const sendMode = Store.get('sendMode');
    const visibility = sendMode === 'world' ? 'public' : 'private';

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
    const parent = pin ? { uid: pin.uid, owner: pin.owner || null } : null;

    Notes.create(text, visibility, parent)
      .then(note => {
        Toast.show('ok', I18n.t(visibility === 'public' ? 'toast.saved.public' : 'toast.saved.private')
          + (note && note.parent ? ' · ' + I18n.t('inf.linked') : ''));
        finish();
      })
      .catch(() => {
        // Закон 2: текст пользователя неприкосновенен — остаётся
        // в textarea, кнопка восстанавливается. Причину Notes уже
        // записал в лог.
        Toast.show('err', I18n.t('toast.save.fail'));
        sending = false;
        setSendingUI(false);
      });
  }

  /**
   * VisualViewport-обработка клавиатуры.
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
   * Инициализация.
   */
  function init() {
    ta = document.getElementById('ed-ta');
    cnt = document.getElementById('ed-cnt');
    sendBtn = document.getElementById('btn-send');
    toggle = document.getElementById('mode-toggle');
    footEl = document.getElementById('ed-foot');

    if (!ta) return;

    ensureSendIcon();

    if (iconTimer) clearTimeout(iconTimer);
    iconTimer = setTimeout(ensureSendIcon, 300);

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

    // Состояние модели меняется → пересчитать подсказку ai.pending.
    unsubs.push(bus.on('ai:status', () => updateCounter()));

    unsubs.push(bus.on('i18n:change', () => {
      updateCounter();
      reflectMode(Store.get('sendMode'));
    }));

    reflectMode(Store.get('sendMode'));
    updateCounter();
  }

  /**
   * Отписка.
   */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];

    if (iconTimer) {
      clearTimeout(iconTimer);
      iconTimer = null;
    }

    if (vvCleanup) {
      try { vvCleanup(); } catch (_) {}
      vvCleanup = null;
    }
  }

  return { init, destroy, send };
}, ['Context', 'Notes', 'Store', 'I18n', 'EventBus', 'Toast', 'Utils', 'Config', 'Embedder']);
// ─── UI/Composer ─── END ────────────────────────────────────────────────────

// ─── UI/FeedView ─── START ──────────────────────────────────────────────────
/**
 * Рендер ленты: хронология / пин-дрейф / ввод; карточки, связи,
 * резонанс, история (#btn-history).
 *
 * ИЗМЕНЕНИЯ v1.0 против v0.9.9:
 * - Анимация входа только НОВЫМ карточкам (diff по uid): повторный
 *   рендер не мигает (M-02). Стагger считает только новые.
 * - Тикер 30с: обновляет текст .note-date (dataset.ts), без
 *   пересборки ленты — «н минут назад» живёт.
 * - isTyping && ctx.vector===null → прежняя лента (state.feed),
 *   пустого состояния-вспышки нет (H-05). Сегменты в этом окне
 *   скрыты (вектор ещё не готов — счётчики были бы ложными).
 * - Кнопка ↳: слушатель вешается СРАЗУ с флагом parentOk; быстрый
 *   клик до резолва — тихо, без всплытия в пин (M-08).
 * - Клик по карточке без вектора → warn-тост (честный отказ пина).
 * Контент — только textContent/createElement (Закон 1; innerHTML —
 * исключительно статические sig-bar полоски).
 */
DI.register('FeedView', function (Store, Context, I18n, Utils, Config, bus, Influence, Provenance, Modal, NetService, Toast) {
  let feedEl, emptyEl, emptyT, segBar, ctxBanner, ctxSrc, ctxTxt, ctxX;
  let cLocal, cWorld, cSeren, histBtn;
  let segBtns = [];
  let unsubs = [];
  let rafPending = false;
  let tickerTimer = null;

  /**
   * Привязка к DOM.
   */
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
    segBtns = Array.from(document.querySelectorAll('.seg-b'));
  }

  /**
   * Коалесценция рендеров.
   */
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  /**
   * @param {Object} n
   * @returns {boolean}
   */
  function isPinnedCard(n) {
    const ctx = Store.get('context');
    return ctx.source === 'pin' && ctx.uid === n.uid;
  }

  /**
   * @param {Object} n
   */
  function onNoteClick(n) {
    const ctx = Store.get('context');

    // Повторный клик по закреплённой — снять пин.
    if ((ctx.source === 'pin' || ctx.source === 'drift') && ctx.uid === n.uid) {
      Context.clearPin();
      return;
    }

    if (n.vector) {
      Context.setPin(n);
    } else {
      // Без вектора (модель не готова / fact-only) — честный отказ.
      Toast.show('warn', I18n.t('toast.pin.novector'));
    }
  }

  /**
   * @param {Array<Object>} childrenList
   */
  function renderChildrenModal(childrenList) {
    const truncate = Config.get('truncateTextLength', 140);
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    if (!childrenList.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-3);font-size:13px;text-align:center;padding:12px;';
      empty.textContent = I18n.t('inf.nochildren');
      body.appendChild(empty);
    } else {
      childrenList.forEach(c => {
        const item = document.createElement('button');
        item.className = 'nv-act';
        item.style.cssText = 'text-align:left;justify-content:flex-start;white-space:normal;height:auto;min-height:40px;width:100%;';
        item.textContent = (c.text || '').slice(0, truncate);

        item.addEventListener('click', () => {
          Modal.close();
          try { bus.emit('note:open', { uid: c.uid }); } catch (_) {}
        });

        body.appendChild(item);
      });
    }

    Modal.open({
      title: I18n.t('inf.children') + (childrenList.length ? ' · ' + childrenList.length : ''),
      body: body,
      buttons: [{ text: I18n.t('btn.close'), onClick: () => Modal.close() }],
    });
  }

  /**
   * @param {Object} note
   */
  function showChildren(note) {
    Provenance.children(note.uid).then(childrenList => {
      renderChildrenModal(childrenList);
    }).catch(() => {});
  }

  /**
   * @param {Object} note
   * @param {Array<Object>} chain
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
          try { bus.emit('note:open', { uid: c.uid }); } catch (_) {}
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
   * @param {Object} note
   */
  function showAncestors(note) {
    Provenance.ancestors(note.uid).then(chain => {
      renderAncestorsModal(note, chain);
    }).catch(() => {});
  }

  /**
   * @returns {HTMLSpanElement}
   */
  function createSep() {
    const sep = document.createElement('span');
    sep.className = 'note-meta-sep';
    return sep;
  }

  /**
   * @param {Object} n
   * @param {boolean} isRanked
   * @param {number} i - индекс среди НОВЫХ карточек (для stagger).
   * @returns {HTMLDivElement}
   */
  function card(n, isRanked, i) {
    const el = document.createElement('div');
    el.className = 'note' + (isPinnedCard(n) ? ' pinned' : '');
    el.style.animationDelay = Math.min(i * 25, 300) + 'ms';
    el.dataset.uid = n.uid;

    const txt = document.createElement('div');
    txt.className = 'note-txt';
    txt.textContent = n.text || '';
    el.appendChild(txt);

    const meta = document.createElement('div');
    meta.className = 'note-meta';

    const tag = document.createElement('span');
    if (n.own) {
      tag.className = 'note-tag ' + (n.visibility === 'public' ? 'world' : 'priv');
      tag.textContent = n.visibility === 'public' ? I18n.t('base.tag.shared') : I18n.t('base.tag.private');
    } else {
      tag.className = 'note-tag world';
      tag.textContent = '· ' + Utils.shortPk(n.owner || '');
    }
    meta.appendChild(tag);

    const hasNav = !!(n.parent && n.parent.uid);
    const res = Influence.resonance(n.uid);
    const hasResonance = res > 0;

    if (hasNav || hasResonance) {
      meta.appendChild(createSep());

      if (hasNav) {
        const link = document.createElement('button');
        link.className = 'note-parent';
        link.textContent = '↳';
        link.title = I18n.t('inf.lineage');
        link.setAttribute('aria-label', I18n.t('inf.openparent'));

        // Слушатель сразу; резолв поднимает флаг или вешает orphan.
        // Быстрый клик до резолва — тихо (M-08: без всплытия в пин).
        let parentOk = false;
        link.addEventListener('click', e => {
          e.stopPropagation();
          if (parentOk) showAncestors(n);
        });

        Provenance.hasResolvableParent(n).then(ok => {
          parentOk = ok;
          if (!ok) {
            link.classList.add('orphan');
            link.title = I18n.t('inf.orphan.hint');
          }
        }).catch(() => {
          link.classList.add('orphan');
          link.title = I18n.t('inf.orphan.hint');
        });

        meta.appendChild(link);
      }

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

    if (isRanked && typeof n.score === 'number') {
      const threshold = Config.get('threshold', 0.81);
      const serendipity = Config.get('serendipity', 0.07);
      const serenMid = threshold - serendipity / 2;
      const displayMode = Config.get('similarityDisplay', 'signal');
      const pct = Math.round(n.score * 100);

      const sim = document.createElement('span');
      sim.className = 'note-sim-info';

      if (displayMode === 'percent') {
        sim.textContent = pct + '%';
        sim.title = I18n.t('sim.score');
      } else {
        if (n.score >= threshold) {
          sim.innerHTML = '<span class="sig-bar sig-full"></span><span class="sig-bar sig-full"></span><span class="sig-bar sig-full"></span>';
          sim.title = I18n.t('sim.level.high') + ' (' + pct + '%)';
        } else if (n.score >= serenMid) {
          sim.innerHTML = '<span class="sig-bar sig-full"></span><span class="sig-bar sig-full"></span><span class="sig-bar sig-empty"></span>';
          sim.title = I18n.t('sim.level.mid') + ' (' + pct + '%)';
        } else {
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

    const date = document.createElement('span');
    date.className = 'note-date';
    date.dataset.ts = String(n.updatedAt || n.createdAt || 0);
    date.textContent = Utils.fmtRelativeTime(n.updatedAt || n.createdAt, I18n.getLang(), I18n.t);
    meta.appendChild(date);

    if (n.own) {
      const openBtn = document.createElement('button');
      openBtn.className = 'na';
      openBtn.textContent = '✎';
      openBtn.title = I18n.t('btn.open');
      openBtn.setAttribute('aria-label', I18n.t('btn.open'));

      openBtn.addEventListener('click', e => {
        e.stopPropagation();
        try { bus.emit('note:open', { uid: n.uid }); } catch (_) {}
      });

      meta.appendChild(openBtn);
    }

    el.appendChild(meta);
    el.addEventListener('click', () => onNoteClick(n));
    return el;
  }

  /**
   * Тикер дат: раз в 30с обновляет только текст, без пересборки.
   */
  function startTicker() {
    if (tickerTimer) clearInterval(tickerTimer);

    tickerTimer = setInterval(() => {
      if (document.hidden || !feedEl) return;
      const lang = I18n.getLang();
      feedEl.querySelectorAll('.note-date').forEach(el => {
        const ts = Number(el.dataset.ts) || 0;
        if (ts) el.textContent = Utils.fmtRelativeTime(ts, lang, I18n.t);
      });
    }, 30000);
  }

  /**
   * Полный рендер.
   */
  function render() {
    if (!feedEl) return;

    const state = Store.getState();
    const ctx = state.context;
    const isPinnedMode = ctx.source === 'pin';
    const isTyping = ctx.source === 'input';
    const isDrift = ctx.source === 'drift';
    const isRanked = isPinnedMode || isTyping || isDrift;
    const hasVector = !!ctx.vector;

    // Сегменты — только в режиме ввода с готовым вектором
    // (до готовности счётчики были бы нулевыми/ложными).
    segBar.classList.toggle('on', isTyping && hasVector);
    ctxBanner.classList.toggle('on', isPinnedMode || isDrift);

    if (isPinnedMode || isDrift) {
      ctxSrc.textContent = isDrift ? I18n.t('ctx.drift') : I18n.t('ctx.pinned');
      ctxTxt.textContent = isDrift ? (ctx.pinText || ctx.text) : ctx.text;
    }

    segBtns.forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-k') === state.seg);
    });

    cLocal.textContent = state.lists.local.length;
    cWorld.textContent = state.lists.world.length;
    cSeren.textContent = state.lists.seren.length;

    let notes;

    if (isPinnedMode || isDrift) {
      notes = [...state.lists.local, ...state.lists.world, ...state.lists.seren]
        .sort((a, b) => (b.score || 0) - (a.score || 0));
    } else if (isTyping && hasVector) {
      notes = state.lists[state.seg] || [];
    } else {
      // Хронология — ИЛИ ввод до готовности вектора: прежняя лента
      // (H-05: без пустой вспышки на окно debounce+embed).
      notes = state.feed;
    }

    // Diff по uid: анимация входа только новым карточкам.
    const prevUids = new Set();
    for (const el of feedEl.children) {
      if (el.dataset && el.dataset.uid) prevUids.add(el.dataset.uid);
    }

    feedEl.innerHTML = '';

    if (!notes.length) {
      emptyEl.classList.add('on');

      emptyT.textContent = (isPinnedMode || isDrift)
        ? I18n.t('empty.world.t')
        : (isTyping && hasVector ? I18n.t('empty.' + state.seg + '.t') : I18n.t('empty.local.t'));
    } else {
      emptyEl.classList.remove('on');

      let newIdx = 0;
      const frag = document.createDocumentFragment();
      notes.forEach(n => {
        const c = card(n, isRanked, newIdx);
        if (prevUids.has(n.uid)) {
          c.style.animation = 'none'; // уже была на экране — без мигания
        } else {
          newIdx++;
        }
        frag.appendChild(c);
      });
      feedEl.appendChild(frag);
    }
  }

  /**
   * Инициализация.
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
    unsubs.push(bus.on('db:mirror', scheduleRender));
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

    segBtns.forEach(b => {
      b.addEventListener('click', () => {
        Store.setState({ seg: b.getAttribute('data-k') });
      });
    });

    if (ctxX) {
      ctxX.addEventListener('click', () => Context.clearPin());
    }

    render();
    startTicker();
  }

  /**
   * Отписка.
   */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];

    if (tickerTimer) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }
  }

  return { init, destroy, render };
}, ['Store', 'Context', 'I18n', 'Utils', 'Config', 'EventBus', 'Influence', 'Provenance', 'Modal', 'NetService', 'Toast']);
// ─── UI/FeedView ─── END ────────────────────────────────────────────────────

// ─── UI/NoteView ─── START ──────────────────────────────────────────────────
/**
 * Полноэкранный просмотр: свои (удалить/видимость/пин/правка),
 * чужие (просмотр/пин). Lookup: notes → mirror.
 *
 * КОНТРАКТ v1.0:
 * - render принимает ts — дата ЗАМЕТКИ, не Date.now() (H-02).
 * - pinAndClose: без вектора — warn-тост, пин не врёт (H-03).
 * - saveEdit: Notes.edit reject → тост + кнопка восстанавливается
 *   (спиннер не застревает, B-02). Публичные заметки НЕ
 *   редактируются (контракт модели канона: публичная версия
 *   уже разошлась в сеть).
 * - Пустой ввод при правке — warn, режим правки сохраняется
 *   (текст юзера не уничтожается).
 * - Toggle/удаление: закрытие просмотра ДО подтверждения —
 *   окей (подтверждение поверх; отмена возвращает юзера в ленту).
 */
DI.register('NoteView', function (DB, Notes, NoteActions, I18n, Utils, Toast, bus) {
  let root = null;
  let currentNote = null;
  let escHandler = null;
  let editMode = false;
  let editTextarea = null;
  let i18nUnsub = null;

  /**
   * Ленивая привязка к DOM.
   */
  function ensureRoot() {
    if (!root) root = document.getElementById('noteview');
    return root;
  }

  /**
   * Закрыть.
   */
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

    currentNote = null;
    editMode = false;
    editTextarea = null;
  }

  /**
   * Открыть по uid: notes → mirror. Ничего не найдено — тихо
   * (вытеснено/удалено в другой сессии — тост не нужен, лента
   * перерисуется событием db:*).
   */
  function open(uid) {
    if (!uid) return;

    DB.getNote(uid).then(note => {
      if (note) {
        render({
          uid: note.uid,
          owner: null,
          text: note.text,
          vector: note.vector,
          visibility: note.visibility,
          ts: note.updatedAt || note.createdAt || Date.now(),
          isOwn: true,
        });
        return;
      }

      DB.getMirror(uid).then(m => {
        if (m && m.text !== undefined) {
          render({
            uid: m.uid,
            owner: m.owner,
            text: m.text,
            vector: m.vec,
            visibility: m.visibility,
            ts: m.ts || (m.version * 1000) || Date.now(),
            isOwn: false,
          });
        }
      });
    }).catch(() => {});
  }

  /**
   * @param {Object} note - {uid, owner, text, vector, visibility, ts, isOwn}
   */
  function enterEditMode(editBtn) {
    if (editMode) return;

    editMode = true;
    const r = ensureRoot();
    if (!r) return;

    const txt = r.querySelector('.nv-text');

    if (txt) {
      const ta = document.createElement('textarea');
      ta.className = 'nv-text-edit';
      ta.value = currentNote.text || '';
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
   * Сохранение правки. Закон 2: reject → тост, кнопка
   * восстанавливается, textarea с текстом остаётся.
   */
  function saveEdit(editBtn) {
    if (!editMode || !editTextarea) return;

    const newText = editTextarea.value.trim();

    if (!newText) {
      Toast.show('warn', I18n.t('toast.empty'));
      return;
    }

    if (editBtn) {
      editBtn.disabled = true;
      editBtn.innerHTML = '<span class="btn-spinner"></span>';
    }

    Notes.edit(currentNote.uid, newText)
      .then(updated => {
        Toast.show('ok', I18n.t('toast.edit.saved'));
        currentNote.text = updated.text;
        currentNote.vector = updated.vector;
        currentNote.visibility = updated.visibility;
        currentNote.ts = updated.updatedAt || currentNote.ts;
        render(currentNote);
      })
      .catch(() => {
        Toast.show('err', I18n.t('toast.save.fail'));
        if (editBtn) {
          editBtn.disabled = false;
          editBtn.textContent = I18n.t('btn.save');
        }
        // textarea с текстом юзера остаётся на месте.
      });
  }

  /**
   * Пин текущей + закрытие. Без вектора — честный отказ.
   */
  function pinAndClose() {
    if (!currentNote) {
      close();
      return;
    }

    if (!currentNote.vector) {
      Toast.show('warn', I18n.t('toast.pin.novector'));
      return; // не закрываем — юзер остаётся в просмотре
    }

    try {
      bus.emit('note:pin', {
        uid: currentNote.uid,
        owner: currentNote.owner,
        text: currentNote.text,
        vector: currentNote.vector,
      });
      Toast.show('ok', I18n.t('toast.pinned'));
    } catch (_) {}

    close();
  }

  /**
   * @param {Object} note - {uid, owner, text, vector, visibility, ts, isOwn}
   */
  function render(note) {
    const r = ensureRoot();
    if (!r) return;

    currentNote = note;
    r.innerHTML = '';
    r.classList.add('on');
    editMode = false;
    editTextarea = null;

    const top = document.createElement('div');
    top.className = 'nv-f';

    if (note.isOwn) {
      const del = document.createElement('button');
      del.className = 'nv-act danger';
      del.textContent = I18n.t('btn.del');
      del.addEventListener('click', () => {
        NoteActions.remove(note.uid);
        close();
      });
      top.appendChild(del);

      const tog = document.createElement('button');
      tog.className = 'nv-act';
      tog.textContent = note.visibility === 'public'
        ? I18n.t('btn.toggle.priv')
        : I18n.t('btn.toggle.pub');
      tog.addEventListener('click', () => {
        NoteActions.toggle(note.uid);
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

    // Правка — только для своих НЕпубличных (контракт модели канона).
    if (note.isOwn && note.visibility !== 'public') {
      const edit = document.createElement('button');
      edit.className = 'nv-act';
      edit.setAttribute('data-role', 'edit');
      edit.textContent = I18n.t('btn.edit');

      edit.addEventListener('click', () => {
        if (editMode) {
          saveEdit(edit);
        } else {
          enterEditMode(edit);
        }
      });

      top.appendChild(edit);
    }

    r.appendChild(top);

    const body = document.createElement('div');
    body.className = 'nv-b';

    const info = document.createElement('div');
    info.className = 'note-meta';
    info.style.marginBottom = '12px';

    const tag = document.createElement('span');

    if (note.isOwn) {
      tag.className = 'note-tag ' + (note.visibility === 'public' ? 'world' : 'priv');
      tag.textContent = note.visibility === 'public' ? I18n.t('base.tag.shared') : I18n.t('base.tag.private');
    } else {
      tag.className = 'note-tag world';
      tag.textContent = '· ' + Utils.shortPk(note.owner || '');
    }

    info.appendChild(tag);

    // Дата ЗАМЕТКИ, не момент открытия (H-02).
    const ts = note.ts || Date.now();
    const date = document.createElement('span');
    date.textContent = Utils.fmtDate(ts, I18n.getLang()) + ' ' + Utils.fmtTime(ts, I18n.getLang());
    info.appendChild(date);
    body.appendChild(info);

    const txt = document.createElement('div');
    txt.className = 'nv-text';
    txt.textContent = note.text || '';
    body.appendChild(txt);

    r.appendChild(body);

    const bottom = document.createElement('div');
    bottom.className = 'nv-f-bottom';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nv-act';
    closeBtn.textContent = I18n.t('btn.close');
    closeBtn.addEventListener('click', close);
    bottom.appendChild(closeBtn);

    r.appendChild(bottom);

    if (escHandler) document.removeEventListener('keydown', escHandler);
    escHandler = e => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', escHandler);
  }

  /**
   * Инициализация.
   */
  function init() {
    const r = ensureRoot();
    if (!r) return;

    r.addEventListener('click', e => {
      if (e.target === r) close();
    });

    bus.on('note:open', p => {
      if (p && p.uid) open(p.uid);
    });

    i18nUnsub = bus.on('i18n:change', () => {
      if (currentNote && !editMode && root && root.classList.contains('on')) {
        render(currentNote);
      }
    });
  }

  /**
   * Закрытие + отписка.
   */
  function destroy() {
    if (i18nUnsub) {
      try { i18nUnsub(); } catch (_) {}
      i18nUnsub = null;
    }
    close();
  }

  return { init, destroy, open, close };
}, ['DB', 'Notes', 'NoteActions', 'I18n', 'Utils', 'Toast', 'EventBus']);
// ─── UI/NoteView ─── END ─────────────────══─────────────────────────────────

// ─── UI/NoteActions ─── START ───────────────────────────────────────────────
/**
 * Действия над заметками: удаление (confirm), видимость (toggle),
 * копирование. ПЕРЕЕХАЛ в UI-слой (был DOMAIN — инверсия слоёв).
 *
 * v1.0: тексты ошибок раздельные — 'toast.save.fail' для операций
 * записи, 'toast.copy.fail' только для копирования (в v0.9.9
 * удаление падало с тостом «не удалось скопировать»).
 */
DI.register('NoteActions', function (Notes, Modal, Toast, I18n) {
  /**
   * Удаление с подтверждением. Закон 2: reject — честный тост,
   * заметка остаётся (не «удалено» при падении).
   */
  function remove(uid) {
    if (!uid) return;

    Modal.confirm(I18n.t('btn.del'), I18n.t('del.confirm'), () => {
      Notes.remove(uid)
        .then(() => {
          Toast.show('ok', I18n.t('toast.deleted'));
        })
        .catch(() => {
          Toast.show('err', I18n.t('toast.save.fail'));
        });
    }, I18n.t('btn.del'), { danger: true });
  }

  /**
   * Переключение видимости. Reject — честный тост, состояние
   * в базе не изменилось (DB транзакция атомарна).
   */
  function toggle(uid) {
    if (!uid) return;

    Notes.toggle(uid)
      .then(note => {
        Toast.show('ok', I18n.t(note.visibility === 'public' ? 'toast.saved.public' : 'toast.saved.private'));
      })
      .catch(() => {
        Toast.show('err', I18n.t('toast.save.fail'));
      });
  }

  /**
   * Копирование: clipboard API → execCommand-fallback.
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
// ─── UI/NoteActions ─── END ─────────────────────────────────────────────────

// ─── UI/BaseView ─── START ──────────────────────────────────────────────────
/**
 * База: статистика по visibility, поиск (substring), сортировка.
 * Рендер только при view === 'base' — переключение через
 * Store.subscribe (событие-призрак view:changed удалён).
 */
DI.register('BaseView', function (Store, DB, I18n, Utils, Config, bus) {
  let listEl, statsTotal, statsOpen, statsPriv, qEl, sortEl;
  let unsubs = [];
  let rafPending = false;

  /**
   * Привязка к DOM.
   */
  function bind() {
    listEl = document.getElementById('base-list');
    statsTotal = document.getElementById('bs-total');
    statsOpen = document.getElementById('bs-open');
    statsPriv = document.getElementById('bs-priv');
    qEl = document.getElementById('base-q');
    sortEl = document.getElementById('base-sort');
  }

  /**
   * Коалесценция рендеров.
   */
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  /**
   * Рендер (только при view === 'base').
   */
  function render() {
    if (!listEl) return;

    const view = Store.get('view');
    if (view !== 'base') return;

    const q = (qEl && qEl.value || '').trim().toLowerCase();
    const sort = (sortEl && sortEl.value) || 'new';

    DB.allNotes().then(notes => {
      let arr = notes.slice();

      if (q) arr = arr.filter(n => (n.text || '').toLowerCase().includes(q));

      if (sort === 'old') {
        arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      } else if (sort === 'az') {
        arr.sort((a, b) => (a.text || '').localeCompare(b.text || '', I18n.getLang() === 'en' ? 'en' : 'ru'));
      } else {
        arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      }

      const publicCount = notes.filter(n => n.visibility === 'public').length;

      if (statsTotal) statsTotal.textContent = notes.length;
      if (statsOpen) statsOpen.textContent = publicCount;
      if (statsPriv) statsPriv.textContent = notes.length - publicCount;

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
   * @param {Object} n - Своя заметка.
   * @returns {HTMLDivElement}
   */
  function row(n) {
    const el = document.createElement('div');
    el.className = 'bi';
    el.dataset.uid = n.uid;

    const t = document.createElement('div');
    t.className = 'bi-t';
    t.textContent = n.text || '';
    el.appendChild(t);

    const f = document.createElement('div');
    f.className = 'bi-f';

    const tag = document.createElement('span');
    tag.className = 'note-tag ' + (n.visibility === 'public' ? 'world' : 'priv');
    tag.textContent = n.visibility === 'public' ? I18n.t('base.tag.shared') : I18n.t('base.tag.private');
    f.appendChild(tag);

    const date = document.createElement('span');
    date.textContent = Utils.fmtDate(n.updatedAt || n.createdAt, I18n.getLang());
    f.appendChild(date);

    el.appendChild(f);
    el.addEventListener('click', () => {
      try { bus.emit('note:open', { uid: n.uid }); } catch (_) {}
    });

    return el;
  }

  /**
   * Инициализация.
   */
  function init() {
    bind();
    if (!listEl) return;

    const debouncedRender = Utils.debounce(scheduleRender, Config.get('baseSearchDebounce', 200));

    if (qEl) qEl.addEventListener('input', debouncedRender);
    if (sortEl) sortEl.addEventListener('change', scheduleRender);

    // view — из Store (единая точка истины; DOM-переключение — в MenuView).
    unsubs.push(Store.subscribe(s => s.view, scheduleRender));

    unsubs.push(bus.on('db:change', scheduleRender));
    unsubs.push(bus.on('i18n:change', scheduleRender));

    render();
  }

  /**
   * Отписка.
   */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, render };
}, ['Store', 'DB', 'I18n', 'Utils', 'Config', 'EventBus']);
// ─── UI/BaseView ─── END ────────────────────────────────────────────────────

// ─── UI/AccountView ─── START ───────────────────────────────────────────────
/**
 * Экран аккаунта: ключ (показ с автокопией), вход по ключу,
 * данные (экспорт/импорт), синк (полный цикл off/active/idle).
 *
 * КОНТРАКТ v1.0:
 * - «Показать ключ» блокируется на время async-операции (защита
 *   от параллельных вызовов и двойной автокопии).
 * - sync-строка слушает sync:status полного цикла: active (идёт
 *   обмен) / idle (покой) / off (выключен) — M-06.
 * - Все тексты ошибок — по назначению (save.fail/copy.fail/
 *   enter.bad/clip.bad/import.bad).
 * Контент — только textContent/createElement (Закон 1).
 */
DI.register('AccountView', function (Account, Modal, Toast, I18n, Config, bus) {
  let unsubs = [];
  /** @type {Object|null} - текущая sync-строка (для живого обновления) */
  let activeSyncRow = null;

  /**
   * @param {string} text
   * @param {Function} onClick
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

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text || '');
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /**
   * @returns {Promise<string|null>}
   */
  async function readClipboard() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        return await navigator.clipboard.readText();
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * Скачать JSON-файл (Blob + a.download + revoke).
   * @param {string} text
   * @param {string} filename
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

  // ─── Показ ключа ──────────────────────────────────────────────────────────

  /**
   * Модалка показа ключа. Кнопка блокируется на время операции.
   */
  async function openShowKey() {
    const wrapAvailable = await Account.canWrapKey().catch(() => false);

    const body = document.createElement('div');
    body.className = 'acc-body';

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

    let revealing = false;

    Modal.open({
      title: I18n.t('account.identity'),
      body,
      buttons: [
        {
          text: I18n.t('btn.show'),
          primary: true,
          onClick: () => {
            if (revealing) return; // защита от двойного клика
            revealing = true;
            keyBox.textContent = '…';

            Account.getWrappedKey(wrapAvailable && pwInput ? pwInput.value : '')
              .then(wrapped => {
                if (!wrapped) {
                  keyBox.textContent = I18n.t('account.nsec.masked');
                  Toast.show('err', I18n.t('toast.copy.fail'));
                  revealing = false;
                  return;
                }
                keyBox.textContent = wrapped;
                keyBox.classList.remove('masked');
                keyBox.classList.add('focused');
                copyText(wrapped).then(ok => {
                  Toast.show(ok ? 'ok' : 'err',
                    I18n.t(ok ? 'toast.key.copied' : 'toast.clip.bad'));
                });
                revealing = false;
              })
              .catch(() => {
                keyBox.textContent = I18n.t('account.nsec.masked');
                Toast.show('err', I18n.t('toast.copy.fail'));
                revealing = false;
              });
          },
        },
        { text: I18n.t('btn.close'), onClick: () => Modal.close() },
      ],
    });
  }

  // ─── Вход по ключу ─────────────────────────────────────────────────────────

  /**
   * Модалка входа по ключу (замена аккаунта).
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

    keyInput.addEventListener('input', () => {
      const v = keyInput.value.trim();
      pwField.style.display = v.startsWith('ncryptsec1') ? '' : 'none';
    });

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = I18n.t('account.nsec.hint');
    body.appendChild(hint);

    let submitting = false;

    const submit = () => {
      const raw = keyInput.value.trim();
      if (!raw || submitting) return;
      submitting = true;

      Modal.confirm(
        I18n.t('account.enter.confirm'),
        I18n.t('account.enter.confirm.d'),
        async () => {
          const res = await Account.enterKey(raw, pwInput.value);
          submitting = false;
          if (res.ok) {
            Toast.show('ok', I18n.t('account.enter.done'));
          } else {
            Toast.show('err', I18n.t(res.error === 'bad'
              ? 'account.enter.bad'
              : 'toast.save.fail'));
          }
        },
        I18n.t('btn.confirm'),
        { danger: true }
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

  // ─── Экспорт ───────────────────────────────────────────────────────────────

  /**
   * Модалка экспорта архива.
   */
  async function openExport() {
    const wrapAvailable = await Account.canWrapKey().catch(() => false);

    const body = document.createElement('div');
    body.className = 'acc-body';

    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.export.desc');
    body.appendChild(desc);

    let withKey = false;

    const displayGroup = document.createElement('div');
    displayGroup.className = 'range-display';

    const lbl = document.createElement('span');
    lbl.className = 'range-display-lbl';
    lbl.textContent = I18n.t('account.export.withkey');
    displayGroup.appendChild(lbl);

    const btnsWrap = document.createElement('div');
    btnsWrap.className = 'range-display-btns';

    /** @type {Array<HTMLButtonElement>} */
    const btns = [];

    function paint() {
      btns.forEach(b => {
        const mode = b.getAttribute('data-key-mode') === 'on';
        b.classList.toggle('selected', mode === withKey);
      });
    }

    let pwInput = null;
    let pwField = null;

    if (wrapAvailable) {
      pwField = document.createElement('div');
      pwField.className = 'field';
      pwField.style.display = 'none';

      const pwLabel = document.createElement('span');
      pwLabel.className = 'field-label';
      pwLabel.textContent = I18n.t('account.password.set');
      pwField.appendChild(pwLabel);

      pwInput = document.createElement('input');
      pwInput.type = 'password';
      pwInput.className = 'field-input';
      pwField.appendChild(pwInput);
      body.appendChild(pwField);
    }

    [['off', false], ['on', true]].forEach(([mode, val]) => {
      const btn = document.createElement('button');
      btn.className = 'nv-act';
      btn.setAttribute('data-key-mode', mode);
      btn.style.cssText = 'flex:1;font-size:12px;';
      btn.textContent = I18n.t(mode === 'on' ? 'btn.on' : 'btn.off');

      btn.addEventListener('click', () => {
        withKey = val;
        paint();
        if (pwField) pwField.style.display = (withKey && wrapAvailable) ? '' : 'none';
      });

      btns.push(btn);
      btnsWrap.appendChild(btn);
    });

    paint();
    displayGroup.appendChild(btnsWrap);
    body.appendChild(displayGroup);

    const withKeyHint = document.createElement('div');
    withKeyHint.className = 'field-hint';
    withKeyHint.textContent = I18n.t('account.export.withkey.hint');
    body.appendChild(withKeyHint);

    let running = false;

    const run = async () => {
      if (running) return;
      running = true;
      const res = await Account.exportArchive(withKey, withKey && wrapAvailable && pwInput ? pwInput.value : '');
      running = false;
      if (!res) {
        Toast.show('err', I18n.t('toast.copy.fail'));
        return;
      }
      Modal.close();
      downloadText(res.json, res.filename);
      Toast.show('ok', I18n.t('account.export.title'));
    };

    const runCopy = async () => {
      if (running) return;
      running = true;
      const res = await Account.exportArchive(withKey, withKey && wrapAvailable && pwInput ? pwInput.value : '');
      running = false;
      if (!res) {
        Toast.show('err', I18n.t('toast.copy.fail'));
        return;
      }
      const ok = await copyText(res.json);
      Toast.show(ok ? 'ok' : 'err', I18n.t(ok ? 'toast.json.copied' : 'toast.clip.bad'));
    };

    Modal.open({
      title: I18n.t('account.export.title'),
      body,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: () => Modal.close() },
        { text: I18n.t('btn.copy'), onClick: runCopy },
        { text: I18n.t('btn.download'), primary: true, onClick: run },
      ],
    });
  }

  // ─── Импорт ────────────────────────────────────────────────────────────────

  /**
   * Модалка импорта.
   */
  function openImport() {
    const body = document.createElement('div');
    body.className = 'acc-body';

    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.import.desc');
    body.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'acc-actions';
    actions.appendChild(actionBtn(I18n.t('account.import.file'), importFromFile));
    actions.appendChild(actionBtn(I18n.t('account.import.clip'), importFromClipboard));
    body.appendChild(actions);

    Modal.open({
      title: I18n.t('account.import.title'),
      body,
      buttons: [{ text: I18n.t('btn.close'), onClick: () => Modal.close() }],
    });
  }

  /**
   * Импорт из файла.
   */
  function importFromFile() {
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
        Modal.close();
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
   * Импорт из буфера: сначала попытка чтения, при пустом/негодном —
   * ручная textarea-модалка.
   */
  async function importFromClipboard() {
    const clip = await readClipboard();

    if (clip && clip.trim()) {
      const parsed = Account.parseArchive(clip);
      if (parsed.ok) {
        Modal.close();
        confirmImport(parsed.archive);
        return;
      }
      // Негодный буфер — сразу в ручной ввод, без тоста
      // (юзер ещё ничего не потерял).
    }

    const body = document.createElement('div');
    body.className = 'acc-body';

    const field = document.createElement('div');
    field.className = 'field';

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = I18n.t('account.import.clip');
    field.appendChild(label);

    const ta = document.createElement('textarea');
    ta.className = 'field-input mono';
    ta.style.cssText = 'min-height:80px;resize:vertical;';
    ta.placeholder = I18n.t('account.import.clip.ph');
    field.appendChild(ta);
    body.appendChild(field);

    let running = false;

    Modal.open({
      title: I18n.t('account.import.title'),
      body,
      buttons: [
        { text: I18n.t('btn.cancel'), onClick: () => Modal.close() },
        {
          text: I18n.t('btn.import'),
          primary: true,
          onClick: () => {
            if (running) return;
            const parsed = Account.parseArchive(ta.value);
            if (!parsed.ok) {
              Toast.show('err', I18n.t('account.import.clip.empty'));
              return;
            }
            running = true;
            Modal.close();
            confirmImport(parsed.archive);
          },
        },
      ],
    });
  }

  /**
   * Подтверждение импорта. Ветви: без ключа → простой confirm;
   * ncryptsec → пароль-модалка; голый nsec (fallback-экспорт) →
   * простой confirm. Ключ в архиве + pubkey ≠ текущего → замена
   * аккаунта (деструктивно: честный текст в описании).
   * @param {Object} archive
   */
  function confirmImport(archive) {
    const apply = async (password) => {
      let accountReplaced = false;

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
          accountReplaced = true;
          Toast.show('ok', I18n.t('account.enter.done'));
        }
      }

      const count = await Account.importArchive(archive);
      Toast.show('ok', I18n.t('account.import.done', { count }));

      if (accountReplaced) {
        // account:changed ре-откроет экран (init-подписка) — обновим
        // заголовок фактом замены. Тост уже показан, здесь ничего.
      }
    };

    if (!archive.ncryptsec) {
      Modal.confirm(
        I18n.t('account.import.confirm'),
        I18n.t('account.import.desc') + ' (' + archive.noteCount + ')',
        () => { apply(''); },
        I18n.t('btn.import')
      );
      return;
    }

    if (archive.ncryptsec.startsWith('ncryptsec1')) {
      const body = document.createElement('div');
      body.className = 'acc-body';

      const desc = document.createElement('div');
      desc.className = 'acc-desc';
      desc.textContent = I18n.t('account.import.desc') + ' (' + archive.noteCount + ')';
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

      Modal.open({
        title: I18n.t('account.import.confirm'),
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
      return;
    }

    // Голый nsec из fallback-экспорта.
    Modal.confirm(
      I18n.t('account.import.confirm'),
      I18n.t('account.import.desc') + ' (' + archive.noteCount + ')',
      () => { apply(''); },
      I18n.t('btn.import')
    );
  }

  // ─── Синк ──────────────────────────────────────────────────────────────────

  /**
   * Обновление sync-строки по фазе.
   * @param {string} phase - 'off' | 'active' | 'idle'
   */
  function paintSyncStatus(phase) {
    const wrap = activeSyncRow || document.querySelector('.acc-sync');
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
   * Строка синка с тумблером и «Синхронизировать».
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

    const nowHint = document.createElement('div');
    nowHint.className = 'acc-desc';
    nowHint.textContent = I18n.t('account.sync.now.hint');
    row.appendChild(nowHint);

    const nowActions = document.createElement('div');
    nowActions.className = 'acc-actions';

    let resyncing = false;

    nowActions.appendChild(actionBtn(I18n.t('account.sync.now'), () => {
      if (resyncing) return;
      resyncing = true;
      paintSyncStatus('active');
      Toast.show('info', I18n.t('toast.sync.now'));
      try {
        DI.resolve('NetService').resync();
      } catch (_) {}
      // Через 6с возвращаем в idle — фаза могла реально смениться
      // (NetService эмитит active/idle по факту flush), этот таймер
      // лишь страховка от «вечно active» при мгновенном resync.
      setTimeout(() => { resyncing = false; }, 6000);
    }));
    row.appendChild(nowActions);

    paint();

    // Начальная фаза: off если выключен; иначе NetService сам
    // эмитит актуальную (idle/active) при первом flush.
    const phase = Config.get('syncEnabled', true) ? 'idle' : 'off';
    dot.className = 'dot ' + (phase === 'off' ? 'err' : 'ok');
    statusTxt.textContent = phase === 'off' ? I18n.t('account.sync.off') : I18n.t('account.sync.on');

    return row;
  }

  // ─── Главный экран ──────────────────────────────────────────────────────────

  /**
   * Открыть экран аккаунта.
   */
  function open() {
    const body = document.createElement('div');
    body.className = 'acc-body';

    // npub-секция — асинхронно в начало (ссылка на элемент,
    // вставка до Modal.open не нужна — фрагмент живой).
    const headAnchor = document.createElement('div');
    body.appendChild(headAnchor);

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
        copyText(npub).then(ok => {
          Toast.show(ok ? 'ok' : 'err', I18n.t(ok ? 'toast.copied' : 'toast.clip.bad'));
        });
      }));
      sec.appendChild(actions);

      // Вставить вместо якоря (пока модалка открыта — elem в DOM).
      if (headAnchor.parentNode) {
        headAnchor.parentNode.replaceChild(sec, headAnchor);
      }
    }).catch(() => {});

    const desc = document.createElement('div');
    desc.className = 'acc-desc';
    desc.textContent = I18n.t('account.identity.desc');
    body.appendChild(desc);

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

    const dataSec = document.createElement('div');
    dataSec.className = 'acc-section';

    const dataTitle = document.createElement('span');
    dataTitle.className = 'acc-title';
    dataTitle.textContent = I18n.t('account.data.section');
    dataSec.appendChild(dataTitle);

    const dataDesc = document.createElement('div');
    dataDesc.className = 'acc-desc';
    dataDesc.textContent = I18n.t('account.data.desc');
    dataSec.appendChild(dataDesc);

    const dataActions = document.createElement('div');
    dataActions.className = 'acc-actions';
    dataActions.appendChild(actionBtn(I18n.t('account.export.title'), openExport));
    dataActions.appendChild(actionBtn(I18n.t('account.import.title'), openImport));
    dataSec.appendChild(dataActions);

    body.appendChild(dataSec);

    const syncRow = buildSyncRow();
    body.appendChild(syncRow);
    activeSyncRow = syncRow;

    Modal.open({
      title: I18n.t('account.title'),
      body,
      buttons: [{ text: I18n.t('btn.close'), onClick: () => Modal.close() }],
    });
  }

  /**
   * Инициализация.
   */
  function init() {
    unsubs.push(bus.on('sync:status', e => {
      if (e && e.phase) paintSyncStatus(e.phase);
    }));

    unsubs.push(bus.on('account:changed', () => {
      const overlay = document.getElementById('overlay');
      if (overlay && overlay.classList.contains('on')) {
        open();
      }
    }));

    unsubs.push(bus.on('i18n:change', () => {
      // Откранный экран перерисуем целиком (кроме режима ввода —
      // здесь вводов нет, просто закрыть/открыть нельзя: потеряем
      // контекст. Просто re-open: модалка статична, это безопасно).
      const overlay = document.getElementById('overlay');
      if (overlay && overlay.classList.contains('on')) {
        const t = document.getElementById('modal-t');
        if (t && t.textContent === I18n.t('account.title')) {
          open();
        }
      }
    }));
  }

  /**
   * Отписка.
   */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
    activeSyncRow = null;
  }

  return { init, destroy, open };
}, ['Account', 'Modal', 'Toast', 'I18n', 'Config', 'EventBus']);
// ─── UI/AccountView ─── END ─────────────────══──────────────────────────────

// ─── UI/MenuView ─── START ──────────────────────────────────────────────────
/**
 * Меню: помощь, тема, язык, ранжирование, аккаунт, «Стереть базу»,
 * «Полный сброс», версия. Переключение stream/base — единый
 * подписчик Store (applyView), событие-призрак view:changed удалён.
 *
 * fullReset: ПОРЯДОК ОБЯЗАТЕЛЕН (B-03):
 *   publishWipeAll → NetService.stop(true) → Nostr.close() →
 *   DB.close() → пауза 150мс → deleteDatabase(все) → localStorage/
 *   sessionStorage.clear → caches.delete → SW CLEAR_CACHE → тост →
 *   reload 1500мс.
 */
DI.register('MenuView', function (Store, Config, Modal, Toast, I18n, bus, Onboarding, Nostr, DB, NetService) {
  let unsubs = [];

  /**
   * @param {string} theme
   */
  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    Config.set('theme', theme);
  }

  /**
   * @param {string} [theme]
   * @returns {string}
   */
  function themeGlyph(theme) {
    const t = theme || Config.get('theme', 'dark');
    return t === 'dark' ? '◐' : '○';
  }

  /**
   * Переключение панелей: единый подписчик Store.view.
   * ctx-banner/seg/feed-wrap/btn-history/composer ↔ #base.
   * #notif-bar НЕ скрывается — тосты нужны в базе.
   */
  function applyView(view) {
    const isBase = view === 'base';

    ['ctx-banner', 'seg', 'feed-wrap', 'btn-history', 'composer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', isBase);
    });

    const base = document.getElementById('base');
    if (base) base.classList.toggle('on', isBase);

    const bb = document.getElementById('btn-base');
    if (bb) bb.classList.toggle('active', isBase);
  }

  /**
   * @param {string} label
   * @param {string} [val]
   * @param {Function} onClick
   * @param {boolean} [danger]
   * @returns {HTMLButtonElement}
   */
  function menuRow(label, val, onClick, danger) {
    const row = document.createElement('button');
    row.className = 'menu-row' + (danger ? ' danger' : '');
    row.addEventListener('click', onClick);

    const lbl = document.createElement('span');
    lbl.textContent = label;
    row.appendChild(lbl);

    if (val) {
      const v = document.createElement('span');
      v.className = 'menu-row-val';
      v.textContent = val;
      row.appendChild(v);
    }

    return row;
  }

  // ─── Настройки ранжирования ───────────────────────────────────────────────

  /**
   * Модалка настроек ранжирования: 3 слайдера + превью + отображение.
   * Сохранение — Config.set + bus db:change (триггер пересборки лент;
   * событие семантически «данные изменились» — сохранено как в
   * v0.9.9, слушатели известны: Feed/Influence/BaseView/FeedView).
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

    const previewEl = document.createElement('div');
    previewEl.className = 'range-preview';

    const pvRelevant = document.createElement('div');
    const pvSeren = document.createElement('div');
    const pvHidden = document.createElement('div');
    previewEl.appendChild(pvRelevant);
    previewEl.appendChild(pvSeren);
    previewEl.appendChild(pvHidden);

    function updatePreview() {
      const threshold = parseFloat(valueEls['threshold'].slider.value);
      const serendipity = parseFloat(valueEls['serendipity'].slider.value);
      const lowerBound = threshold - serendipity;

      pvRelevant.textContent = I18n.t('preview.relevant', { lo: Math.round(threshold * 100) });
      pvSeren.textContent = I18n.t('preview.seren', { lo: Math.round(lowerBound * 100), hi: Math.round(threshold * 100) });
      pvHidden.textContent = I18n.t('preview.hidden', { lo: Math.round(lowerBound * 100) });
    }

    updatePreview();
    body.appendChild(previewEl);

    valueEls['threshold'].slider.addEventListener('input', updatePreview);
    valueEls['serendipity'].slider.addEventListener('input', updatePreview);

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

  // ─── Полный сброс ──────────────────────────────────────────────────────────

  /**
   * Полный сброс. Порядок исполнения фиксирован (B-03): остановка
   * сети → закрытие соединения БД → пауза → удаление баз → очистка
   * хранилищ → SW CLEAR_CACHE → reload.
   */
  async function fullReset() {
    // 1. Сетевой wipe (каноны deleted для всех своих заметок).
    try {
      const report = await NetService.publishWipeAll();
      if (report && report.offline) {
        Toast.show('warn', I18n.t('toast.wipe.offline'));
      }
    } catch (_) {}

    // 2. Остановка всего.
    try { NetService.stop(true); } catch (_) {}
    try { Nostr.close(); } catch (_) {}

    // 3. Закрыть соединение с БД — иначе deleteDatabase уйдёт в
    //    blocked и reload гонится с удалением (B-03).
    try {
      const db = await DB.ready();
      if (db && typeof db.close === 'function') db.close();
    } catch (_) {}
    DB.close(); // дублирующий страховочный вызов: DB знает, что закрыт
    await new Promise(r => setTimeout(r, 150));

    // 4. Удаление всех IndexedDB-баз origin.
    const names = [];
    try {
      if (window.indexedDB && typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases().catch(() => []);
        (dbs || []).forEach(d => { if (d.name) names.push(d.name); });
      } else if (window.indexedDB) {
        names.push(Config.get('dbName', 'noomium_v3'));
      }
    } catch (_) {}

    await Promise.all(names.map(name => new Promise(res => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      } catch (_) { res(); }
    })));

    // 5. Хранилища и кэши.
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
    if (window.caches) {
      try {
        const cs = await caches.keys().catch(() => []);
        await Promise.all(cs.map(n => caches.delete(n)));
      } catch (_) {}
    }

    // 6. SW: чистка кэша версии на случай, если страницы не была
    //    под контролем (первый визит).
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try { navigator.serviceWorker.controller.postMessage('CLEAR_CACHE'); } catch (_) {}
    }

    Toast.show('ok', I18n.t('menu.fullreset.done'));

    setTimeout(() => {
      window.location.reload();
    }, 1500);
  }

  /**
   * Открыть меню.
   */
  function openMenu() {
    const body = document.createElement('div');
    body.className = 'menu-list';

    body.appendChild(menuRow(I18n.t('menu.help'), '', () => {
      Modal.close();
      Onboarding.showHelp(false);
    }));

    const themeVal = themeGlyph() + ' ' + I18n.t(Config.get('theme', 'dark') === 'dark' ? 'theme.dark' : 'theme.light');
    body.appendChild(menuRow(I18n.t('menu.theme'), themeVal, () => {
      const next = Config.get('theme', 'dark') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      Config.set('userThemeOverride', true);
      Modal.close();
      Toast.show('ok', I18n.t('menu.theme') + ': ' + themeGlyph(next) + ' ' + I18n.t(next === 'dark' ? 'theme.dark' : 'theme.light'));
    }));

    body.appendChild(menuRow(I18n.t('menu.lang'), I18n.getLang().toUpperCase(), () => {
      I18n.setLang(I18n.getLang() === 'ru' ? 'en' : 'ru');
      Modal.close();
    }));

    body.appendChild(menuRow(I18n.t('menu.ranking'), '', () => {
      Modal.close();
      openRankingSettings();
    }));

    body.appendChild(menuRow(I18n.t('menu.account'), '', () => {
      Modal.close();
      DI.resolve('AccountView').open();
    }));

    body.appendChild(menuRow(I18n.t('base.wipe'), '', () => {
      Modal.close();
      Modal.confirm(I18n.t('base.wipe'), I18n.t('base.wipe.confirm'), () => {
        try { bus.emit('wipe:request'); } catch (_) {}
      }, I18n.t('btn.del'), { danger: true });
    }, true));

    body.appendChild(menuRow(I18n.t('menu.fullreset'), '', () => {
      Modal.close();
      Modal.confirm(I18n.t('menu.fullreset'), I18n.t('menu.fullreset.confirm'), () => {
        fullReset();
      }, I18n.t('menu.fullreset'), { danger: true });
    }, true));

    const version = document.createElement('div');
    version.className = 'menu-version';
    version.textContent = 'v' + APP_VERSION;
    body.appendChild(version);

    Modal.open({ title: I18n.t('menu.settings'), body });
  }

  /**
   * Инициализация.
   */
  function init() {
    applyTheme(Config.get('theme', 'dark'));

    const menuBtn = document.getElementById('btn-menu');
    if (menuBtn) menuBtn.addEventListener('click', openMenu);

    // view — единственная точка истины: клик → Store, DOM — подписчик.
    const baseBtn = document.getElementById('btn-base');
    if (baseBtn) {
      baseBtn.addEventListener('click', () =>
        Store.setState({ view: Store.get('view') === 'base' ? 'stream' : 'base' })
      );
    }

    unsubs.push(Store.subscribe(s => s.view, applyView));
    unsubs.push(bus.on('i18n:change', () => {
      applyView(Store.get('view'));
    }));

    applyView(Store.get('view'));
  }

  /**
   * Отписка.
   */
  function destroy() {
    unsubs.forEach(u => {
      try { u(); } catch (_) {}
    });
    unsubs = [];
  }

  return { init, destroy, openMenu };
}, ['Store', 'Config', 'Modal', 'Toast', 'I18n', 'EventBus', 'Onboarding', 'Nostr', 'DB', 'NetService']);
// ─── UI/MenuView ─── END ─────────────────══─────────────────────────────────

// ═══ СЛОЙ: PLATFORM ═══════════════════════════════════════════════════════════

// ─── PLATFORM/TelegramAdapter ─── START ─────────────────────────────────────
/**
 * Telegram Mini Apps: тема, haptic, нативные диалоги.
 *
 * ИЗМЕНЕНИЕ v1.0 (B-05): init() НЕ сдаётся, если window.Telegram
 * ещё не загрузился. TG-скрипт грузится async без блокировки, а
 * Boot выполняется раньше CDN на холодном старте. Активация:
 * DOM-событие 'tg:ready' (onload в index.html) ИЛИ ретрай через 3с.
 * В тёплом сценарии поведение идентично v0.9.9.
 */
DI.register('TelegramAdapter', function (Config, bus, Logger) {
  /** @type {Object|null} */
  let tg = null;
  /** @type {boolean} */
  let isActive = false;

  /**
   * Активация (прежняя логика v0.9.9). Идемпотентна.
   */
  function activate() {
    if (isActive) return;
    if (!window.Telegram || !window.Telegram.WebApp) return;

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
   * Инициализация с ретраем (B-05).
   */
  function init() {
    // Уже загрузился (тёплый кэш / быстрый CDN) — сразу.
    if (window.Telegram && window.Telegram.WebApp) {
      activate();
      return;
    }

    // Холодный старт: ждём сигнал от onload в index.html.
    window.addEventListener('tg:ready', activate, { once: true });

    // Страховка: onload не пришёл (тихий сбой CDN) — проверяем сами.
    setTimeout(() => {
      if (!isActive && window.Telegram && window.Telegram.WebApp) {
        activate();
      }
    }, 3000);
  }

  /**
   * Применение темы Telegram (если юзер не выбрал свою в меню).
   */
  function applyTheme() {
    if (!tg) return;

    if (Config.get('userThemeOverride', false)) {
      return;
    }

    const scheme = tg.colorScheme || 'dark';
    document.body.setAttribute('data-theme', scheme);

    try {
      tg.setHeaderColor(scheme === 'dark' ? '#0a0a0b' : '#fafafa');
      tg.setBackgroundColor(scheme === 'dark' ? '#0a0a0b' : '#fafafa');
    } catch (_) {}

    try { bus.emit('telegram:theme', { scheme }); } catch (_) {}
  }

  /**
   * @returns {boolean}
   */
  function isTelegram() {
    return isActive;
  }

  /**
   * @param {'success'|'error'|'light'} type
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
   * @param {string} message
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
   * @param {string} message
   * @param {Function} callback
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

// ═══ СЛОЙ: BOOT (реализован — это оркестрация каркаса) ══════════════════════
DI.register('Boot', function () {
  function mount() {
    const Config = DI.resolve('Config');
    document.body.setAttribute('data-theme', Config.get('theme', 'dark'));

    DI.resolve('I18n').init();

    // Индикаторы и домен — первыми, UI подписывается на их события.
    DI.resolve('Progress').init();
    DI.resolve('HeaderStatus').init();
    DI.resolve('Feed').init();
    DI.resolve('Influence').init();
    DI.resolve('Mirror').init();

    DI.resolve('TelegramAdapter').init();
    DI.resolve('Context').init();

    DI.resolve('Composer').init();
    DI.resolve('FeedView').init();
    DI.resolve('NoteView').init();
    DI.resolve('BaseView').init();
    DI.resolve('MenuView').init();
    DI.resolve('AccountView').init();

    const bus = DI.resolve('EventBus');
    const DB = DI.resolve('DB');
    const Toast = DI.resolve('Toast');
    const I18n = DI.resolve('I18n');
    const NetService = DI.resolve('NetService');

    // Модель догрузилась → доэмбеддить заметки, созданные без вектора.
    bus.on('ai:ready', () => {
      DI.resolve('Notes').backfill().catch(e => {
        DI.resolve('Logger').warn('Boot: backfill', String(e));
      });
    });

    // Локальная очистка базы + сетевой wipe (честный отчёт при офлайне).
    bus.on('wipe:request', async () => {
      const report = await NetService.publishWipeAll().catch(() => ({ published: 0, offline: true }));
      try { await DB.reset(); } catch (_) {}
      Toast.show(report && report.offline ? 'warn' : 'ok',
        I18n.t(report && report.offline ? 'toast.wipe.offline' : 'toast.base.wiped'));
      DI.resolve('Store').setState({ view: 'stream' });
    });

    document.body.classList.add('ready');

    DI.resolve('Embedder').load();
    NetService.start();
    DI.resolve('Onboarding').init();
  }

  return { mount };
});

// ═══ ЗАПУСК ═══════════════════════════════════════════════════════════════════
window.DI = DI;

try {
  DI.resolve('Boot').mount();
} catch (e) {
  console.error('[NOOmium] запуск упал:', e);
  document.body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100dvh;padding:20px;'
    + 'font:500 14px -apple-system,sans-serif;color:#fafafa;background:#0a0a0b;text-align:center">'
    + 'NOOmium не запустился. Обновите страницу.<br>Если повторится — пришлите скриншот консоли (F12).</div>';
}
