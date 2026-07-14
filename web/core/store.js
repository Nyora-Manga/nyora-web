// core/store.js — observable prefs (localStorage-backed) + a hash router.
//
//  store  : appearance / accent / reader prefs persisted to 'nyora.prefs',
//           deep-merged via set(), with subscribe() + applyTheme(); plus
//           store.source — the current Source object shared across screens.
//  router : hash router. navigate(name, params) -> '#/name?k=v'; onChange(cb);
//           current() -> {name, params}; back(); start(routesMap, defaultName).

const STORAGE_KEY = 'nyora.prefs';

const WALLPAPER_ACCENT = 'wallpaper';
const LEGACY_AUTO_ACCENT = 'auto';

// Shared named colour-scheme set (ported from nyora-android). Each scheme carries
// both a light and a dark primary — the active appearance (LIGHT/DARK) selects
// which one is used as the Material accent. The `sec` (dark secondary) tone draws
// the two preview bars on each card. Default = Sakura (see DEFAULT_PREFS).
export const COLOR_SCHEMES = [
  // Dynamic/wallpaper accent removed on web — browsers rarely expose a usable
  // OS accent, so it silently did nothing. Sakura is the default instead.
  { id: 'totoro', name: 'Totoro', light: '#3C6090', dark: '#A6C8FF', sec: '#BCC7DC' },
  { id: 'miku', name: 'Miku', light: '#00696D', dark: '#6FDDE2', sec: '#A6CECF' },
  { id: 'asuka', name: 'Asuka', light: '#904A40', dark: '#FFB4A8', sec: '#E7BDB6' },
  { id: 'mion', name: 'Mion', light: '#3B693A', dark: '#A1D39A', sec: '#EEBF6D' },
  { id: 'rikka', name: 'Rikka', light: '#68548D', dark: '#D3BBFD', sec: '#CDC2DB' },
  { id: 'sakura', name: 'Sakura', light: '#8C4A60', dark: '#FFB1C8', sec: '#E3BDC6' },
  { id: 'mamimi', name: 'Mamimi', light: '#465D91', dark: '#AFC6FF', sec: '#BFC6DC' },
  { id: 'kanade', name: 'Kanade', light: '#353543', dark: '#FFFFFF', sec: '#DDDCDC' },
  { id: 'itsuka', name: 'Itsuka', light: '#974800', dark: '#FFBA8F', sec: '#F7B993' },
  { id: 'yuki', name: 'Yuki', light: '#43474A', dark: '#FFFFFF', sec: '#C6C6C9' },
];

/** Look up a scheme by id. Unknown/legacy values fall back to the default (Sakura). */
export function schemeById(id) {
  return COLOR_SCHEMES.find((s) => s.id === id)
    || COLOR_SCHEMES.find((s) => s.id === 'sakura')
    || COLOR_SCHEMES[0];
}
const FALLBACK_ACCENT = '#6366f1'; // Matches the CSS default --accent; used when the OS/browser exposes no accent (e.g. most mobile browsers) instead of a stray green.

const DEFAULT_PREFS = {
  appearance: 'DARK', // 'DARK' | 'LIGHT'
  accent: 'sakura',
  showNsfw: false,
  noNsfwHistory: false, // when true, 18+ manga are never written to history
  reader: {
    mode: 'WEBTOON', // 'WEBTOON' | 'PAGED' | 'PAGED_RTL'
    fit: 'WIDTH', // 'WIDTH' | 'HEIGHT'
    prefetch: true,
    webtoonWidth: 70,
  },
};

// ---- browser accent detection -----------------------------------------

function rgbToHex(rgb) {
  const m = /rgba?\(([^)]+)\)/.exec(rgb || '');
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((v) => parseInt(v.trim(), 10));
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

let _browserAccent; // memoized
export function detectBrowserAccent() {
  if (_browserAccent !== undefined) return _browserAccent;
  _browserAccent = null;
  try {
    if (window.CSS && CSS.supports && CSS.supports('color', 'AccentColor')) {
      const probe = document.createElement('span');
      probe.style.cssText = 'color:AccentColor;position:absolute;opacity:0;pointer-events:none';
      (document.body || document.documentElement).appendChild(probe);
      const hex = rgbToHex(getComputedStyle(probe).color);
      probe.remove();
      // Some platforms report pure white/black for AccentColor — treat as no signal.
      if (hex && hex !== '#ffffff' && hex !== '#000000') _browserAccent = hex;
    }
  } catch {
    _browserAccent = null;
  }
  return _browserAccent;
}

/**
 * Resolve the effective accent hex from a pref value, appearance-aware.
 *   - a known scheme id  -> its light/dark primary per `theme`
 *   - 'wallpaper'/'auto' -> the OS/browser accent (single-valued, no L/D split)
 *   - a legacy raw hex   -> returned as-is (backward compatible)
 *   - anything unknown   -> Dynamic/wallpaper fallback
 * `theme` is 'LIGHT' | 'DARK' (defaults to 'DARK').
 */
export function resolveAccent(pref, theme) {
  const scheme = COLOR_SCHEMES.find((s) => s.id === pref);
  if (scheme) return theme === 'LIGHT' ? scheme.light : scheme.dark;
  // Legacy raw hex saved by an older build — keep honouring it.
  if (pref && /^#[0-9a-fA-F]{6}$/.test(pref)) return pref;
  // 'wallpaper' / 'auto' / anything unknown -> default Sakura.
  const sakura = COLOR_SCHEMES.find((s) => s.id === 'sakura');
  return sakura ? (theme === 'LIGHT' ? sakura.light : sakura.dark) : FALLBACK_ACCENT;
}

// ---- deep helpers ------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively clone so callers can't mutate our internal state by reference. */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

/** Deep-merge `patch` into `target` in place. Arrays/scalars overwrite. */
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = deepClone(v);
    }
  }
  return target;
}

function loadPrefs() {
  const base = deepClone(DEFAULT_PREFS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) deepMerge(base, JSON.parse(raw));
  } catch {
    /* corrupt storage — fall back to defaults */
  }
  return base;
}

// ---- the store ---------------------------------------------------------

function createStore() {
  let prefs = loadPrefs();
  const subscribers = new Set();
  // Display-field cache (cover/title) keyed by manga url. Populated by the
  // card() grid helper so a details view reached by navigation can still show
  // the cover when a source's /manga/details omits it (e.g. AsuraScans returns
  // an empty coverUrl — the cover only ever comes from the list entry).
  const mangaCache = new Map();
  // Persist the cover cache so covers survive reloads and flow into details,
  // favourites and the library (the source `details` endpoint often omits them).
  const MANGA_CACHE_KEY = 'nyora.mangacache.v1';
  const MANGA_CACHE_MAX = 500;
  try {
    const saved = JSON.parse(localStorage.getItem(MANGA_CACHE_KEY) || '[]');
    if (Array.isArray(saved)) for (const [url, v] of saved) if (url && v) mangaCache.set(url, v);
  } catch { /* corrupt/absent — ignore */ }
  let _mcTimer = null;
  function persistMangaCache() {
    if (_mcTimer) return;
    _mcTimer = setTimeout(() => {
      _mcTimer = null;
      try { localStorage.setItem(MANGA_CACHE_KEY, JSON.stringify([...mangaCache.entries()].slice(-MANGA_CACHE_MAX))); }
      catch { /* quota — ignore */ }
    }, 800);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* storage full / disabled — ignore, state still lives in memory */
    }
  }

  function notify() {
    const snapshot = deepClone(prefs);
    for (const cb of subscribers) {
      try {
        cb(snapshot);
      } catch (e) {
        /* ignore subscriber error */
      }
    }
  }

  const store = {
    // current Source object shared across screens (not persisted).
    source: null,

    /** Returns a deep clone of the current prefs (safe to read freely). */
    get() {
      return deepClone(prefs);
    },

    /** Deep-merge a patch, persist, apply theme, and notify subscribers. */
    set(patch) {
      if (!patch || typeof patch !== 'object') return store.get();
      deepMerge(prefs, patch);
      persist();
      applyTheme();
      notify();
      return store.get();
    },

    /** Subscribe to changes. Returns an unsubscribe fn. */
    subscribe(cb) {
      if (typeof cb !== 'function') return () => {};
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    /** Remember a manga's display fields (cover/title) keyed by its url. */
    cacheManga(m) {
      if (m && m.url) {
        const v = {
          coverUrl: m.coverUrl || '',
          largeCoverUrl: m.largeCoverUrl || '',
          title: m.title || '',
          isNsfw: m.isNsfw === true,
        };
        mangaCache.delete(m.url);       // move-to-end (recency for the LRU cap)
        mangaCache.set(m.url, v);
        if (mangaCache.size > MANGA_CACHE_MAX) mangaCache.delete(mangaCache.keys().next().value);
        if (v.coverUrl || v.largeCoverUrl) persistMangaCache();
      }
    },

    /** Recall cached display fields for a manga url (or null). */
    cachedManga(url) {
      return (url && mangaCache.get(url)) || null;
    },
  };

  /** Toggle body/root data-theme + set the --accent CSS variable. */
  function applyTheme() {
    const root = document.documentElement;
    const theme = prefs.appearance === 'LIGHT' ? 'LIGHT' : 'DARK';
    root.setAttribute('data-theme', theme);
    if (document.body) document.body.setAttribute('data-theme', theme);
    const accent = resolveAccent(prefs.accent, theme);
    root.style.setProperty('--accent', accent);
    
    // Calculate contrast for --on-accent
    const rgb = hexToRgb(accent);
    const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
    const onAccent = brightness > 180 ? '#000000' : '#ffffff';
    root.style.setProperty('--on-accent', onAccent);

    // theme-color for mobile browser chrome / PWA. <meta> can't use var(), so
    // resolve the concrete value of the --bg token instead of hardcoding a literal.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }

  store.applyTheme = applyTheme;
  return store;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

export const store = createStore();
export const applyTheme = () => store.applyTheme();

// ---- hash router -------------------------------------------------------

/** Encode a params object into a query string (no leading '?'). */
function encodeParams(params) {
  if (!params) return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

/** Decode a query string (no leading '?') into a plain string-valued object. */
function decodeParams(query) {
  const out = {};
  if (!query) return out;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx < 0) {
      out[decodeURIComponent(pair)] = '';
    } else {
      const k = decodeURIComponent(pair.slice(0, idx));
      const v = decodeURIComponent(pair.slice(idx + 1));
      out[k] = v;
    }
  }
  return out;
}

/** Parse a raw hash ('#/name?k=v') into {name, params}. */
function parseHash(hash, defaultName) {
  let h = (hash || '').replace(/^#/, '');
  if (h.startsWith('/')) h = h.slice(1);
  if (!h) return { name: defaultName, params: {} };
  const qIdx = h.indexOf('?');
  const name = qIdx < 0 ? h : h.slice(0, qIdx);
  const query = qIdx < 0 ? '' : h.slice(qIdx + 1);
  return { name: name || defaultName, params: decodeParams(query) };
}

function createRouter() {
  const listeners = new Set();
  let routes = {};
  let defaultName = 'explore';
  let started = false;

  function current() {
    return parseHash(location.hash, defaultName);
  }

  function emit() {
    const route = current();
    for (const cb of listeners) {
      try {
        cb(route);
      } catch (e) {
        /* ignore listener error */
      }
    }
  }

  function navigate(name, params) {
    const query = encodeParams(params);
    const target = '#/' + name + (query ? '?' + query : '');
    if (location.hash === target) {
      // Same hash — fire manually so re-navigation still re-renders.
      emit();
    } else {
      location.hash = target;
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function back() {
    history.back();
  }

  function start(routesMap, fallbackName) {
    routes = routesMap || {};
    if (fallbackName) defaultName = fallbackName;
    if (!started) {
      window.addEventListener('hashchange', emit);
      started = true;
    }
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      navigate(defaultName);
    } else {
      emit();
    }
  }

  return {
    routes: () => routes,
    current,
    navigate,
    onChange,
    back,
    start,
  };
}

export const router = createRouter();

export default { store, router, applyTheme, COLOR_SCHEMES };
