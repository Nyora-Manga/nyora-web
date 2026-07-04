// core/ui.js — DOM helpers, the design-system widgets, inline icons, modals,
// toasts and small formatters shared by every screen.

import { api } from './api.js';
import { store } from './store.js';

// ---- langLabel() : friendly source subtitle ---------------------------
// Sources expose an internal parser/engine name (e.g. "MadaraParser"); users
// should only ever see the reader's LANGUAGE, never that developer jargon.
const LANG_NAMES = {
  en: 'English', es: 'Spanish', 'es-419': 'Spanish (LatAm)', pt: 'Portuguese',
  'pt-br': 'Portuguese (BR)', fr: 'French', de: 'German', it: 'Italian', ru: 'Russian',
  id: 'Indonesian', ar: 'Arabic', tr: 'Turkish', pl: 'Polish', vi: 'Vietnamese',
  th: 'Thai', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', 'zh-hans': 'Chinese',
  'zh-hant': 'Chinese (Trad.)', uk: 'Ukrainian', fa: 'Persian', nl: 'Dutch', multi: 'Multi-language',
};
export function langLabel(src) {
  const raw = (src && (src.lang || src.locale) ? String(src.lang || src.locale) : '').toLowerCase();
  if (!raw) return 'Manga';
  return LANG_NAMES[raw] || LANG_NAMES[raw.slice(0, 2)] || raw.toUpperCase();
}

// ---- el() : tiny hyperscript ------------------------------------------
//
// el('div', {class:'x', html:'…', onClick:fn, title:'…'}, child, child, …)
//   - `class`      -> className
//   - `html`       -> innerHTML (use sparingly; trusted markup only)
//   - on<Event>    -> addEventListener(event.toLowerCase(), handler)
//   - everything else -> setAttribute (value coerced to string; false/null skip)
//   - children flattened; strings -> text nodes; null/undefined skipped.

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      if (key === 'class' || key === 'className') {
        node.className = value;
      } else if (key === 'html') {
        node.innerHTML = value;
      } else if (key === 'style' && typeof value === 'object') {
        // Object.assign can't set CSS custom properties (--foo) on a style
        // declaration, so route those through setProperty; plain props as-is.
        for (const [k, v] of Object.entries(value)) {
          if (v === null || v === undefined) continue;
          if (k.startsWith('--')) node.style.setProperty(k, v);
          else node.style[k] = v;
        }
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === false) {
        // boolean false -> omit attribute
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

// ---- selectors ---------------------------------------------------------

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

// ---- image proxy -------------------------------------------------------

export function proxyImage(url, headers) {
  return api.imageUrl(url, headers);
}

// Load a cover/page image the way the native apps do: hit the real CDN first
// (an <img> displays cross-origin images with no CORS), and only fall back to
// the /image proxy — which attaches the source-domain Referer + a browser UA,
// matching Android's CommonHeadersInterceptor — when the CDN hotlink-blocks the
// direct request. Non-gated images then load instantly without the backend, and
// it survives the proxy being cold/slow/unavailable. `onFail` runs only after
// BOTH attempts fail.
export function applyImage(img, url, headers, onFail) {
  const u = (url || '').trim();
  if (!u) { if (onFail) onFail(); return; }
  if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('/')) { img.src = u; return; }
  const abs = u.startsWith('//') ? 'https:' + u : u;
  // Already a helper /image proxy URL (often the loopback host from the helper) —
  // go straight to the public proxy; the direct/loopback attempt would just fail.
  if (abs.includes('/image?u=')) {
    img.addEventListener('error', () => { if (onFail) onFail(); });
    img.src = proxyImage(abs, headers); // imageUrl() repoints to the public host
    return;
  }
  const canDirect = abs.startsWith('http');
  let stage = canDirect ? 0 : 1; // 0 = direct, 1 = proxied, 2 = failed
  img.addEventListener('error', () => {
    if (stage === 0) { stage = 1; img.src = proxyImage(abs, headers); }
    else if (stage === 1) { stage = 2; if (onFail) onFail(); }
  });
  img.src = canDirect ? abs : proxyImage(abs, headers);
}

// ---- toast -------------------------------------------------------------

let toastTimer = null;

export function toast(msg) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = msg;
  node.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add('hidden');
    toastTimer = null;
  }, 2600);
}

// ---- spinner / skeletons ----------------------------------------------

export function spinner() {
  return el('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
}

export function skeletonCard() {
  return el(
    'div',
    { class: 'card skeleton' },
    el('div', { class: 'cover skeleton' }),
    el('div', { class: 'title skeleton', style: { height: '14px', width: '80%' } }),
  );
}

// ---- icons (inline SVG) -----------------------------------------------
//
// 24x24 viewBox, currentColor stroke, 1.8 stroke-width. icon(name) returns a
// <span class="icon"> wrapping the SVG so it inherits text colour/size.

const ICON_PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  library: '<path d="M3 5.4v12.9c3-1.1 6-.8 9 1 3-1.8 6-2.1 9-1V5.4c-3-1.1-6-.8-9 1-3-1.8-6-2.1-9-1z"/><path d="M12 6.4v12.9"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  bookmark: '<path d="M6 4h12v16l-6-4-6 4z"/>',
  update: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.4 7.5 2.4 7.5H3.6S6 15 6 9z"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  stats: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  anilist: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 16V9l-2 7M8 9h3"/><path d="M14 16l2.5-7L19 16"/>',
  back: '<path d="M15 19l-7-7 7-7"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  heart: '<path d="M12 20s-7-4.5-9.3-9A5 5 0 0 1 12 6a5 5 0 0 1 9.3 5C19 15.5 12 20 12 20z"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M21 12.8A8.5 8.5 0 0 1 11.2 3 7 7 0 1 0 21 12.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6 0 10 7 10 7a17.8 17.8 0 0 1-3.3 3.9M6.6 6.6A17.6 17.6 0 0 0 2 11s4 7 10 7a10.7 10.7 0 0 0 3.4-.6"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H17a4 4 0 0 0 4-4c0-2.8-4-7.6-9-7.6z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16.5" cy="11.5" r="1"/>',
  install: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M5 21h14"/>',
  uninstall: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11l4 4M14 11l-4 4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/>',
  share: '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 11l8-4M8 13l8 4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  trending: '<path d="M3 17l6-6 4 4 7-7"/><path d="M17 8h4v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m14.9 9.1-2 4.8-4.8 2 2-4.8z"/><circle cx="12" cy="12" r="0.6"/>',
  inbox: '<path d="M4 13l2.5-7h11L20 13"/><path d="M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/><path d="M4 13h4l1.2 2.2h5.6L16 13h4"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/>',
  feed: '<path d="M4 6a2 2 0 0 1 2-2h9v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M15 8h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2"/><path d="M7 8h5M7 11h5M7 14h3"/>',
  book: '<path d="M5 5a2 2 0 0 1 2-2h11v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 1 2-2h11"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  logo: '<path d="M3 3l6 18h2l6-18h-2l-5 15-5-15h-2z M13 3l6 18h2l-6-18h-2z" fill="currentColor" stroke="none"/>',
  instagram: '<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>',
  linkedin: '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A3.37 3.37 0 0 0 18.25 5 3.37 3.37 0 0 0 18.25 5 3.37 3.37 0 0 0 16 3.5c-.92 0-2.3 1-2.3 1a10.59 10.59 0 0 0-4.4 0s-1.38-1-2.3-1A3.37 3.37 0 0 0 4 5a3.37 3.37 0 0 0-.94 2.61c0 5.46 3.3 6.65 6.44 7a3.37 3.37 0 0 0-.94 2.61V22"/>',
  mail: '<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><rect x="2" y="5" width="20" height="14" rx="2"/>',
};

export function icon(name) {
  const paths = ICON_PATHS[name] || ICON_PATHS.info;
  const span = el('span', { class: 'icon', 'data-icon': name });
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
    `width="20" height="20" aria-hidden="true">${paths}</svg>`;
  return span;
}

// The real multicolour Google "G" — NOT a monochrome stroke icon, so it can't
// go through icon(); use this anywhere a "Sign in with Google" button needs the
// official mark.
const GOOGLE_G_SVG =
  '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">' +
  '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
  '</svg>';
export function googleMark() {
  return el('span', { class: 'icon google-mark', html: GOOGLE_G_SVG });
}

// ---- buttons / chips ---------------------------------------------------

export function btn(label, opts = {}) {
  const cls = ['btn'];
  if (opts.variant === 'accent' || opts.primary) cls.push('btn-accent');
  else if (opts.variant === 'ghost') cls.push('btn-ghost');
  if (opts.class) cls.push(opts.class);
  const props = { class: cls.join(' '), type: opts.type || 'button' };
  if (opts.onClick) props.onClick = opts.onClick;
  if (opts.title) props.title = opts.title;
  if (opts.disabled) props.disabled = true;
  const kids = [];
  if (opts.icon) kids.push(icon(opts.icon));
  if (label) kids.push(el('span', null, label));
  return el('button', props, ...kids);
}

export function iconBtn(svgName, onClick, title) {
  return el(
    'button',
    {
      class: 'btn btn-ghost icon-btn',
      type: 'button',
      title: title || svgName,
      'aria-label': title || svgName,
      onClick,
    },
    icon(svgName),
  );
}

export function chip(text, opts = {}) {
  const cls = ['chip'];
  if (opts.active) cls.push('active');
  if (opts.nsfw) cls.push('nsfw');
  if (opts.class) cls.push(opts.class);
  const props = { class: cls.join(' ') };
  if (opts.onClick) {
    props.onClick = opts.onClick;
    props.role = 'button';
    props.tabindex = '0';
  }
  return el('span', props, text);
}

// ---- structural widgets -----------------------------------------------

export function sectionHeader(title, ...actions) {
  return el(
    'div',
    { class: 'section-header' },
    el('h2', null, title),
    actions.length ? el('div', { class: 'section-actions' }, ...actions) : null,
  );
}

export function emptyState(msg, iconName) {
  return el(
    'div',
    { class: 'empty' },
    icon(iconName || 'inbox'),
    el('p', null, msg || 'Nothing here yet.'),
  );
}

export function errorBox(msg) {
  return el('div', { class: 'error-box' }, el('span', null, msg || 'Something went wrong.'));
}

// ---- stepper : a pill-shaped −/value/+ number control ------------------
//
// stepper({ value, min, max, onChange }) -> node. Buttons get full .btn-less
// .stepper styling (fixes the old white-default-button bug where −/+ buttons
// carried only `icon-btn` and rendered unstyled).

export function stepper({ value = 0, min = 0, max = 99, step = 1, onChange } = {}) {
  let v = value;
  const num = el('span', { class: 'num' }, String(v));
  const dec = el('button', { type: 'button', 'aria-label': 'Decrease' }, '−');
  const inc = el('button', { type: 'button', 'aria-label': 'Increase' }, '+');
  const sync = () => {
    num.textContent = String(v);
    dec.disabled = v <= min;
    inc.disabled = v >= max;
  };
  const bump = (d) => {
    const next = Math.min(max, Math.max(min, v + d * step));
    if (next === v) return;
    v = next;
    sync();
    if (onChange) onChange(v);
  };
  dec.addEventListener('click', () => bump(-1));
  inc.addEventListener('click', () => bump(+1));
  sync();
  const node = el('div', { class: 'stepper' }, dec, num, inc);
  node.setValue = (nv) => { v = Math.min(max, Math.max(min, nv)); sync(); };
  return node;
}

// ---- segmented : a small multi-option toggle ---------------------------
//
// segmented([{label,value}], current, onPick) -> node.

export function segmented(options, current, onPick) {
  const seg = el('div', { class: 'seg' });
  for (const opt of options) {
    const b = el('button', {
      type: 'button',
      class: opt.value === current ? 'active' : '',
      onClick: () => {
        if (opt.value === current) return;
        Array.from(seg.children).forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
        current = opt.value;
        onPick(opt.value);
      },
    }, opt.label);
    seg.appendChild(b);
  }
  return seg;
}

// ---- pickDirectory : choose a real local folder, client-side -----------
//
// Uses the File System Access API (showDirectoryPicker) where available,
// falling back to a hidden <input webkitdirectory>. Resolves to
// { name, files: File[] } (each File tagged with ._relpath) or null if the
// user cancels. This replaces the JVM-era "type a server folder path" prompt.

export async function pickDirectory() {
  if (window.showDirectoryPicker) {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'nyora-local', mode: 'read' });
    } catch (e) {
      return null; // AbortError (cancelled) or unsupported gesture
    }
    const files = [];
    async function walk(handle, prefix) {
      for await (const [name, h] of handle.entries()) {
        if (h.kind === 'file') {
          const f = await h.getFile();
          f._relpath = prefix + name;
          files.push(f);
        } else if (h.kind === 'directory') {
          await walk(h, prefix + name + '/');
        }
      }
    }
    await walk(dir, '');
    return { name: dir.name, files };
  }
  // Fallback: webkitdirectory input.
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', style: { display: 'none' } });
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      files.forEach((f) => { f._relpath = f.webkitRelativePath || f.name; });
      input.remove();
      resolve(files.length
        ? { name: (files[0].webkitRelativePath || '').split('/')[0] || 'Folder', files }
        : null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

// ---- card --------------------------------------------------------------
//
// Cover card: lazy proxied image, title, optional 18+ badge. The <img> hides
// itself on load error so a broken cover degrades to the surface fill.

export function card(manga, onClick) {
  // Remember this manga's cover/title so a details view navigated to by url can
  // fall back to it when the source's /manga/details returns an empty cover.
  store.cacheManga(manga);
  const coverWrap = el('div', { class: 'cover' });
  const coverDomain = manga.source && manga.source.domain;
  const coverHeaders = coverDomain ? { Referer: `https://${coverDomain}/` } : undefined;
  const cover = manga.coverUrl || manga.largeCoverUrl || '';
  if (cover) {
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: manga.title || '' });
    applyImage(img, cover, coverHeaders, () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }
  const nsfw =
    manga.isNsfw === true || manga.contentRating === 'ADULT';
  if (nsfw) {
    coverWrap.appendChild(el('span', { class: 'badge nsfw' }, '18+'));
  }

  const node = el(
    'div',
    { class: 'card', role: 'button', tabindex: '0' },
    coverWrap,
    el('div', { class: 'title', title: manga.title || '' }, manga.title || 'Untitled'),
  );
  if (onClick) {
    node.addEventListener('click', () => onClick(manga));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(manga);
      }
    });
  }
  return node;
}

// ---- modal / dialogs ---------------------------------------------------
//
// modal({title, body, actions:[{label,primary,onClick}]}) -> opens in
// #modalRoot, returns a close() fn. Clicking the backdrop or pressing Escape
// closes it. An action's onClick may return false to KEEP the modal open;
// any other return value (or none) closes it.

export function modal({ title, body, actions } = {}) {
  const root = $('#modalRoot');
  if (!root) {
    return () => {};
  }

  const backdrop = el('div', { class: 'modal-backdrop' });

  function close() {
    backdrop.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    // Allow the fade-out transition to play before removing.
    setTimeout(() => backdrop.remove(), 160);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  const bodyNode =
    body instanceof Node ? body : el('div', null, body == null ? '' : String(body));

  const actionNodes = (actions || []).map((a) =>
    btn(a.label, {
      primary: a.primary,
      variant: a.variant,
      onClick: () => {
        const keep = a.onClick && a.onClick() === false;
        if (!keep) close();
      },
    }),
  );

  const dialog = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    el(
      'div',
      { class: 'modal-head' },
      el('h3', null, title || ''),
      iconBtn('close', close, 'Close'),
    ),
    el('div', { class: 'modal-body' }, bodyNode),
    actionNodes.length ? el('div', { class: 'modal-actions' }, ...actionNodes) : null,
  );

  backdrop.appendChild(dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  // next frame -> transition in
  requestAnimationFrame(() => backdrop.classList.add('open'));

  return close;
}

export function confirmDialog(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const close = modal({
      title: 'Confirm',
      body: el('p', { class: 'desc' }, msg),
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => done(false) },
        { label: 'Confirm', primary: true, onClick: () => done(true) },
      ],
    });
    // If the user dismisses via Escape/backdrop, resolve false on next tick.
    const backdrop = $('#modalRoot .modal-backdrop');
    if (backdrop) {
      const observer = new MutationObserver(() => {
        if (!backdrop.isConnected) {
          observer.disconnect();
          done(false);
        }
      });
      observer.observe($('#modalRoot'), { childList: true });
    }
    void close;
  });
}

export function promptDialog(title, value = '') {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const input = el('input', {
      class: 'field',
      type: 'text',
      value: value == null ? '' : String(value),
    });
    const form = el('div', null, input);
    const close = modal({
      title: title || 'Enter value',
      body: form,
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => done(null) },
        { label: 'OK', primary: true, onClick: () => done(input.value) },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value);
        close();
      }
    });
    setTimeout(() => input.focus(), 30);
    const root = $('#modalRoot');
    if (root) {
      const backdrop = $('.modal-backdrop', root);
      if (backdrop) {
        const observer = new MutationObserver(() => {
          if (!backdrop.isConnected) {
            observer.disconnect();
            done(null);
          }
        });
        observer.observe(root, { childList: true });
      }
    }
  });
}

// ---- formatters --------------------------------------------------------

export const fmt = {
  // rating: source ratings are 0..1 (or -1 unknown). Render as N.N out of 10.
  rating(r) {
    if (r == null || r < 0) return '—';
    const scaled = r <= 1 ? r * 10 : r;
    return scaled.toFixed(1);
  },

  // date: epoch millis -> short locale date; 0/empty -> ''.
  date(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  },

  // chapterTitle: prefer the chapter's own title, else synthesize from number.
  chapterTitle(c, i) {
    if (!c) return '';
    if (c.title && c.title.trim()) return c.title.trim();
    if (c.number != null && c.number > 0) {
      const n = Number.isInteger(c.number) ? c.number : c.number.toFixed(1);
      return `Chapter ${n}`;
    }
    if (i != null) return `Chapter ${i + 1}`;
    return 'Chapter';
  },
};

export default {
  el,
  $,
  $$,
  proxyImage,
  toast,
  spinner,
  skeletonCard,
  modal,
  confirmDialog,
  promptDialog,
  card,
  chip,
  btn,
  iconBtn,
  stepper,
  segmented,
  pickDirectory,
  sectionHeader,
  emptyState,
  errorBox,
  icon,
  fmt,
};
