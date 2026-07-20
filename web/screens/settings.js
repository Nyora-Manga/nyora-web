// screens/settings.js — client-side preferences for the Nyora web SPA.

import library from '../core/library.js';
import { downloads } from '../core/downloads.js';
import { colorizeModelReady, downloadColorizeModel } from '../core/colorize/engine.js';
import {
  el, toast, btn, sectionHeader, confirmDialog, icon, iconBtn, menuSelect, m3Range, schemeCard, infoDot, segmented, stepper, m3Switch, modal, spinner,
} from '../core/ui.js';
import {
  store, router, COLOR_SCHEMES, resolveAccent, detectBrowserAccent,
} from '../core/store.js';
import sync from '../core/sync.js';
import tracking from '../core/tracking.js';
import { showPreferences } from './welcome.js';
import { TL_LANGS, TL_SOURCES } from '../core/translate/mt.js';

export const meta = {
  title: 'Settings',
  nav: true,
  icon: 'settings',
  order: 90,
};

function field(label, control, hint) {
  return el('div', { class: 'field' },
    label ? el('label', null, label) : null,
    control,
    hint ? el('span', { class: 'hint' }, hint) : null,
  );
}

// settingRow(name, sub, control) — `sub` may be a short string (rendered
// beneath the name) or, to keep the row terse, an { info: '…' } object that
// tucks the explanation behind a small circled "!".
//
// The row auto-adapts to whatever control it's given so every case lays out
// sanely — small controls (switch, button, dropdown) sit inline on the right;
// wide/typed controls (text/URL/password inputs, textareas) drop onto their own
// full-width line under the label instead of being crushed into the right slot.
function controlLayout(node) {
  if (!node || !node.tagName) return 'inline';
  const tag = node.tagName.toLowerCase();
  if (tag === 'textarea') return 'block';
  if (tag === 'input') {
    const t = (node.getAttribute('type') || 'text').toLowerCase();
    // typed fields want the whole row; toggles/sliders/swatches stay inline.
    return ['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file'].includes(t)
      ? 'inline' : 'block';
  }
  // helper-built filled fields carry the `.input` class on the element itself.
  if (node.classList && node.classList.contains('input')) return 'block';
  return 'inline';
}
function settingRow(name, sub, control) {
  const info = sub && typeof sub === 'object' && sub.info ? sub.info : null;
  const layout = controlLayout(control);
  return el('div', { class: 'setting-row' + (layout === 'block' ? ' setting-row--stack' : '') },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, name, info ? infoDot(info) : null),
      (sub && !info) ? el('div', { class: 'sub' }, sub) : null,
    ),
    control ? el('div', { class: 'row-actions' }, control) : null,
  );
}

function switchToggle(checked, onToggle) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onToggle(input.checked));
  return el('label', { class: 'switch' }, input, el('span', { class: 'slider' }));
}

// Colour-scheme preview cards are shared with onboarding — see schemeCard in
// core/ui.js.

// Android-style preference screens: the settings route is a hub listing the
// categories; tapping one navigates to '#/settings?s=<id>', a sub-page with a
// back header and only that category's preferences.
const SECTIONS = [
  { id: 'appearance', name: 'Appearance', sub: 'Theme and color scheme', icon: 'palette', build: buildAppearance },
  { id: 'reader', name: 'Reader', sub: 'Default reading mode, fit and prefetch', icon: 'book', build: buildReader },
  { id: 'downloads', name: 'Downloads', sub: 'Format, concurrency and offline storage', icon: 'download', build: buildDownloads },
  { id: 'content', name: 'Content', sub: '18+ sources, languages and sources', icon: 'eye', build: buildContent },
  { id: 'sync', name: 'Cloud Sync', sub: 'Account, sync and restore', icon: 'refresh', build: buildSync },
  { id: 'tracking', name: 'Tracking', sub: 'AniList, MyAnimeList and MangaBaka', icon: 'bookmark', build: buildTracking },
  { id: 'backup', name: 'Backup & Data', sub: 'Export, import and clear data', icon: 'download', build: buildBackupData },
  { id: 'advanced', name: 'Advanced', sub: 'Storage, caches and servers', icon: 'bars', build: buildAdvanced },
  { id: 'experimental', name: 'Experimental', sub: 'On-device AI translation & colorization (beta)', icon: 'flask', build: buildExperimental },
  { id: 'about', name: 'About', sub: 'Version, links and credits', icon: 'info', build: buildAbout },
];

// A settings-hub row (icon + name + sub + chevron) that drills into a sub-page.
// Reused by the top-level hub AND by nested hubs (Experimental → Translation…).
function navRow(name, sub, iconName, onClick, disabled) {
  const row = el('div', {
    class: 'settings-nav-row' + (disabled ? ' is-disabled' : ''),
    role: 'button', tabindex: disabled ? '-1' : '0',
    'aria-disabled': disabled ? 'true' : null,
  },
    el('span', { class: 'settings-nav-icon' }, icon(iconName)),
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, name),
      el('div', { class: 'sub' }, sub),
    ),
    el('span', { class: 'settings-nav-chevron' }, icon('chevron')),
  );
  if (!disabled) {
    row.addEventListener('click', onClick);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
  }
  return row;
}

// Nested sub-pages of Experimental (recursive settings). Function refs are
// hoisted, so this literal can reference the builders defined further down.
const EXP_CHILDREN = {
  translation: { name: 'Translation', sub: 'In-image AI page translation + LLM refinement', icon: 'globe', build: buildExpTranslation },
  colorization: { name: 'Colorization', sub: 'AI-colour black-and-white manga on-device', icon: 'droplet', build: buildExpColorization },
};

export function render(view, params) {
  view.replaceChildren();
  const s = params && params.s;
  const sub = params && params.sub;

  // Top-level hub.
  if (!s) {
    view.append(sectionHeader('Settings'));
    const list = el('div', { class: 'settings-nav' });
    for (const sec of SECTIONS) {
      list.appendChild(navRow(sec.name, sec.sub, sec.icon, () => router.navigate('settings', { s: sec.id })));
    }
    view.append(list);
    return;
  }

  const section = SECTIONS.find((x) => x.id === s);
  if (!section) { router.navigate('settings'); return; }

  // Recursive sub-page: Experimental → Translation / Colorization.
  if (s === 'experimental' && sub && EXP_CHILDREN[sub]) {
    const child = EXP_CHILDREN[sub];
    const back = iconBtn('back', () => router.navigate('settings', { s: 'experimental' }), 'Back to Experimental');
    view.append(el('div', { class: 'settings-subheader' }, back, el('h1', null, child.name)));
    if (store.get().experimental !== true) {
      view.append(el('p', { class: 'exp-hint' }, 'Enable experimental features to use this.'));
    }
    view.append(child.build());
    return;
  }

  const back = iconBtn('back', () => router.navigate('settings'), 'Back to settings');
  view.append(el('div', { class: 'settings-subheader' }, back, el('h1', null, section.name)));
  view.append(section.build());
}

function buildAppearance() {
  const prefs = store.get();
  const section = el('section', { class: 'settings-section' });
  section.append(settingRow('Theme', 'System follows your OS setting and switches live.',
    segmented([{ value: 'SYSTEM', label: 'System' }, { value: 'DARK', label: 'Dark' }, { value: 'LIGHT', label: 'Light' }],
      ['SYSTEM', 'LIGHT', 'DARK'].includes(prefs.appearance) ? prefs.appearance : 'DARK',
      (v) => store.set({ appearance: v }))));
  section.append(settingRow('Cover grid density', 'How many covers fit per row in Library, Explore and Search.',
    segmented([{ value: 'S', label: 'Compact' }, { value: 'M', label: 'Comfort' }, { value: 'L', label: 'Large' }], prefs.gridSize || 'M', (v) => store.set({ gridSize: v }))));
  section.append(settingRow('Dark style', 'Pure black saves OLED power; Soft uses Material grey surfaces.',
    segmented([{ value: 'BLACK', label: 'Pure black' }, { value: 'SOFT', label: 'Soft' }], prefs.darkStyle === 'SOFT' ? 'SOFT' : 'BLACK', (v) => store.set({ darkStyle: v }))));
  section.append(settingRow('Interface scale', 'Overall size of text and controls.',
    segmented([{ value: 'S', label: 'Small' }, { value: 'M', label: 'Default' }, { value: 'L', label: 'Large' }], ['S', 'L'].includes(prefs.uiScale) ? prefs.uiScale : 'M', (v) => store.set({ uiScale: v }))));
  section.append(settingRow('Show titles under covers', null,
    switchToggle(prefs.showCardTitles !== false, (v) => store.set({ showCardTitles: v }))));
  section.append(settingRow('Compact sidebar', 'Icon-only navigation rail on desktop — more room for content.',
    switchToggle(prefs.navRail === true, (v) => store.set({ navRail: v }))));
  section.append(settingRow('Background blur effects', 'Frosted-glass surfaces. Turn off on low-power devices.',
    switchToggle(prefs.noBlur !== true, (v) => store.set({ noBlur: !v }))));
  section.append(settingRow('Reduce motion', 'Minimise page and interface animations.',
    switchToggle(prefs.reduceMotion === true, (v) => store.set({ reduceMotion: v }))));
  const appearance = prefs.appearance === 'LIGHT' ? 'LIGHT' : 'DARK';
  const cards = el('div', { class: 'scheme-cards' });
  // Any unknown/legacy stored value (old 'wallpaper'/'auto', raw hex) → default Sakura.
  const knownIds = new Set(COLOR_SCHEMES.map((s) => s.id));
  const isCustomHex = /^#[0-9a-fA-F]{6}$/.test(prefs.accent);
  // Custom hex accent → no scheme card is selected.
  const selectedId = knownIds.has(prefs.accent) ? prefs.accent : (isCustomHex ? null : 'sakura');
  const clearActive = () => { for (const child of Array.from(cards.children)) child.classList.remove('active'); };
  for (const scheme of COLOR_SCHEMES) {
    cards.appendChild(schemeCard(scheme, {
      active: scheme.id === selectedId,
      appearance,
      onChoose: (node) => { store.set({ accent: scheme.id }); clearActive(); node.classList.add('active'); },
    }));
  }
  section.append(field('Color scheme', cards, 'Sakura is the default accent.'));

  // Custom accent — any hex color, overrides the scheme (resolveAccent honours
  // raw hex values directly).
  const isCustom = isCustomHex;
  const picker = el('input', {
    type: 'color', class: 'accent-picker',
    value: isCustom ? prefs.accent : resolveAccent(selectedId || 'sakura', appearance),
  });
  // Re-render the whole Appearance section so the 'Use scheme' revert
  // affordance appears immediately; store.set re-themes live via resolveAccent
  // (no full-page reload).
  const rerender = () => section.replaceWith(buildAppearance());
  picker.addEventListener('change', () => { store.set({ accent: picker.value }); rerender(); });
  section.append(settingRow('Custom accent', 'Overrides the color scheme with any color you like.',
    el('div', { class: 'row', style: { gap: '10px' } },
      picker,
      isCustom ? btn('Use scheme', { variant: 'ghost', onClick: () => { store.set({ accent: 'sakura' }); rerender(); } }) : null,
    )));
  return section;
}

function dlBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  return `${(v / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function buildDownloads() {
  const s = downloads.getSettings();
  const section = el('section', { class: 'settings-section' });

  section.append(settingRow('Archive format', 'CBZ opens in comic readers; ZIP is the same file, renamed.',
    segmented([{ label: 'CBZ', value: 'CBZ' }, { label: 'ZIP', value: 'ZIP' }], s.format,
      (v) => { downloads.saveSettings({ format: v }); toast(`Saving as ${v}`); })));

  section.append(settingRow('Concurrent chapters', 'Chapters downloaded in parallel.',
    stepper({ value: s.maxConcurrent, min: 1, max: 5, onChange: (v) => downloads.saveSettings({ maxConcurrent: v }) })));

  section.append(settingRow('Parallel pages', 'Page images fetched at once per chapter.',
    stepper({ value: s.imageConcurrency, min: 1, max: 8, onChange: (v) => downloads.saveSettings({ imageConcurrency: v }) })));

  section.append(settingRow('Retries per page', 'Re-attempts before a page is skipped.',
    stepper({ value: s.retries, min: 0, max: 5, onChange: (v) => downloads.saveSettings({ retries: v }) })));

  section.append(settingRow('Keep for offline reading', 'Store downloaded chapters in this browser.',
    m3Switch(s.keepOffline, (on) => {
      downloads.saveSettings({ keepOffline: on });
      if (!on) toast('New downloads will not be kept offline');
    })));

  section.append(settingRow('Auto-save to device', 'Also download each finished file to your computer.',
    m3Switch(s.saveToDevice, (on) => downloads.saveSettings({ saveToDevice: on }))));

  // Offline storage usage + clear actions.
  const usage = el('div', { class: 'sub' });
  const refresh = () => {
    const c = downloads.counts();
    const parts = [];
    if (c.completed) parts.push(`${c.completed} chapter${c.completed === 1 ? '' : 's'}`);
    parts.push(dlBytes(c.totalBytes));
    usage.textContent = `${parts.join(' · ')} stored offline`;
  };
  refresh();
  const clearDone = btn('Clear finished', { variant: 'ghost', class: 'btn-sm', icon: 'trash', onClick: async () => { const r = await downloads.clearCompleted(); toast(r.removed ? `Cleared ${r.removed}` : 'Nothing to clear'); refresh(); } });
  const delAll = btn('Delete all', { variant: 'ghost', class: 'btn-sm btn-danger', icon: 'trash', onClick: async () => { if (!(await confirmDialog('Delete every download, including offline files?'))) return; const r = await downloads.clearAll(); toast(r.removed ? `Deleted ${r.removed}` : 'Nothing to delete'); refresh(); } });
  section.append(el('div', { class: 'setting-row' },
    el('div', { class: 'row-main' }, el('div', { class: 'name' }, 'Offline storage'), usage),
    el('div', { class: 'row-actions' }, clearDone, delAll),
  ));

  return section;
}

function buildReader() {
  const prefs = store.get();
  const r = prefs.reader || {};
  const section = el('section', { class: 'settings-section' });
  section.append(settingRow('Default reading mode', 'New manga open in this mode; each title remembers its own override.', segmented([{ value: 'WEBTOON', label: 'Webtoon' }, { value: 'PAGED', label: 'Paged' }, { value: 'PAGED_RTL', label: 'Paged RTL' }], r.mode, (v) => store.set({ reader: { mode: v } }))));
  section.append(settingRow('Image fit', null, segmented([{ value: 'WIDTH', label: 'Width' }, { value: 'HEIGHT', label: 'Height' }], r.fit, (v) => store.set({ reader: { fit: v } }))));
  section.append(settingRow('Prefetch next chapter', 'Preload the next chapter’s pages for seamless chapter turns.', switchToggle(r.prefetch, (v) => store.set({ reader: { prefetch: v } }))));

  const sliderRow = (label, sub, min, max, step, value, fmtVal, onChange) => {
    const valOut = el('span', { class: 'counter' }, fmtVal(value));
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), style: { width: '100%' } });
    input.addEventListener('input', () => { valOut.textContent = fmtVal(Number(input.value)); onChange(Number(input.value)); });
    m3Range(input);
    return el('div', { class: 'field', style: { margin: '6px 0 10px' } },
      el('div', { class: 'row', style: { justifyContent: 'space-between' } },
        el('div', null, el('label', null, label), sub ? el('div', { class: 'sub', style: { color: 'var(--text-faint)', fontSize: '12.5px' } }, sub) : null),
        valOut),
      input);
  };
  section.append(sliderRow('Default webtoon width', 'Column width on desktop; phones always use the full width.', 30, 100, 5,
    Math.min(100, Math.max(30, Number(r.webtoonWidth) || 70)), (v) => `${v}%`, (v) => store.set({ reader: { webtoonWidth: v } })));
  section.append(sliderRow('Auto-scroll speed', 'Default hands-free reading speed (a / space in the reader).', 1, 10, 1,
    Math.min(10, Math.max(1, Number(r.autoScrollLevel) || 4)), (v) => `${v}/10`, (v) => store.set({ reader: { autoScrollLevel: v } })));
  section.append(settingRow('Keep screen awake', 'Hold a wake lock while reading so the display never sleeps.',
    switchToggle(r.keepAwake !== false, (v) => store.set({ reader: { keepAwake: v } }))));
  section.append(settingRow('Tap to turn pages', 'Paged modes: tapping the left/right edges turns the page.',
    switchToggle(r.tapZones !== false, (v) => store.set({ reader: { tapZones: v } }))));
  section.append(settingRow('Roll chapters at the edges', 'Webtoon: scrolling past the last page (or above the first) moves between chapters.',
    switchToggle(r.edgeGestures !== false, (v) => store.set({ reader: { edgeGestures: v } }))));
  return section;
}

// Experimental HUB: a master gate + collapsed nav rows that drill into the
// Translation and Colorization sub-pages (recursive settings). The gate also
// controls the reader (see reader.js): while off, translate/colorize toggles
// never appear or apply, and the rows here are disabled.
function buildExperimental() {
  const enabled = store.get().experimental === true;
  const section = el('section', { class: 'settings-section experimental' });
  const rerender = () => section.replaceWith(buildExperimental());

  section.append(el('div', { class: 'exp-banner' + (enabled ? ' on' : '') },
    el('span', { class: 'exp-banner-icon' }, icon('flask')),
    el('div', { class: 'exp-banner-text' },
      el('div', { class: 'exp-banner-title' }, 'Experimental features'),
      el('div', { class: 'exp-banner-sub' },
        'On-device AI translation and colorization. Beta — everything runs in your browser; models download on first use and results can be slow or imperfect.'),
    ),
    switchToggle(enabled, (v) => { store.set({ experimental: v }); rerender(); }),
  ));

  if (!enabled) {
    section.append(el('p', { class: 'exp-hint' }, 'Turn on experimental features to open translation and colorization.'));
  }

  // Collapsed feature rows → each opens its own sub-page.
  const nav = el('div', { class: 'settings-nav exp-nav' });
  for (const [id, child] of Object.entries(EXP_CHILDREN)) {
    nav.appendChild(navRow(child.name, child.sub, child.icon,
      () => router.navigate('settings', { s: 'experimental', sub: id }), !enabled));
  }
  section.append(nav);

  // Shared model storage (used by both features).
  section.append(el('h2', { class: 'exp-h2' }, el('span', { class: 'exp-h2-icon' }, icon('download')), 'Storage'));
  section.append(expModelStorageRow());

  return section;
}

// Downloaded-models storage row (shared by translation + colorization).
function expModelStorageRow() {
  const usage = el('span', { class: 'hint' }, 'Calculating…');
  (async () => {
    try {
      const cache = await caches.open('nyora-tl-models');
      const keys = await cache.keys();
      let bytes = 0;
      for (const req of keys) { const res = await cache.match(req); if (res) bytes += (await res.blob()).size; }
      usage.textContent = keys.length
        ? `${keys.length} file${keys.length === 1 ? '' : 's'} · ${(bytes / 1024 / 1024).toFixed(0)} MB`
        : 'No models downloaded yet';
    } catch { usage.textContent = 'Unavailable'; }
  })();
  return settingRow('Downloaded models', usage,
    btn('Delete', {
      variant: 'ghost', class: 'btn-danger',
      onClick: async () => {
        if (!(await confirmDialog('Delete all downloaded AI models? They re-download on next use.'))) return;
        try { await caches.delete('nyora-tl-models'); usage.textContent = 'No models downloaded yet'; toast('Models deleted'); }
        catch { toast('Could not delete models'); }
      },
    }));
}

// Experimental → Translation sub-page.
function buildExpTranslation() {
  const r = store.get().reader || {};
  const section = el('section', { class: 'settings-section' });
  const select = (opts, val, onChange) => menuSelect(opts, val, onChange);

  section.append(settingRow('Translate pages',
    { info: 'Show manga pages with speech bubbles translated in place. Runs on-device — pages never leave your browser. Also toggleable per manga in the reader. Models download on first use (Japanese ~123 MB; Chinese/English ~32 MB; Korean ~24 MB).' },
    switchToggle(r.translate, (v) => store.set({ reader: { translate: v } }))));
  section.append(settingRow('Translate from',
    { info: 'Text-recognition language. Auto follows the manga source’s language.' },
    select(TL_SOURCES, r.translateFrom || 'auto', (v) => store.set({ reader: { translateFrom: v } }))));
  section.append(settingRow('Translate to', null,
    select(TL_LANGS, r.translateTo || 'en', (v) => store.set({ reader: { translateTo: v } }))));

  // Not under "AI refinement": the glossary now rewrites names before the plain
  // machine translation too, so it works with no API key at all.
  section.append(settingRow('Character names',
    { info: 'Look the series up on MangaBaka/AniList and its Fandom wiki, detect which characters actually appear on each page, and use their canonical names — e.g. 早川アキ → Aki Hayakawa — instead of letting the translator invent a reading. Works on its own with no API key, and also sharpens AI refinement.' },
    switchToggle(store.get().aiFandom === true, (v) => store.set({ aiFandom: v }))));

  section.append(el('h3', { class: 'exp-h3' }, 'AI refinement'));
  const AI_PLACEHOLDERS = {
    openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-sol', key: 'sk-…' },
    anthropic: { endpoint: 'https://api.anthropic.com', model: 'claude-fable-5', key: 'sk-ant-…' },
  };
  const aiInputs = {};
  const aiField = (label, key, type) => {
    const input = el('input', { class: 'input', type, autocomplete: 'off', spellcheck: 'false' });
    input.value = store.get()[key] || '';
    input.addEventListener('change', () => { store.set({ [key]: input.value.trim() }); toast('Saved'); });
    aiInputs[key] = input;
    return settingRow(label, key === 'aiEndpoint' || key === 'aiModel'
      ? { info: 'Leave empty to use the provider default.' } : null, input);
  };
  const paintAiPlaceholders = (provider) => {
    const ph = AI_PLACEHOLDERS[provider] || AI_PLACEHOLDERS.openai;
    if (aiInputs.aiEndpoint) aiInputs.aiEndpoint.placeholder = ph.endpoint;
    if (aiInputs.aiModel) aiInputs.aiModel.placeholder = ph.model;
    if (aiInputs.aiApiKey) aiInputs.aiApiKey.placeholder = ph.key;
  };
  section.append(settingRow('API style',
    { info: 'Refine each translated page with a language model for coherence. OpenAI style covers OpenAI, OpenRouter, Groq and local Ollama; Anthropic covers Claude. Leave the API key empty to disable. The key is stored only in this browser.' },
    segmented([{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }],
      store.get().aiProvider === 'anthropic' ? 'anthropic' : 'openai',
      (v) => { store.set({ aiProvider: v }); paintAiPlaceholders(v); })));
  section.append(aiField('API endpoint', 'aiEndpoint', 'url'));
  section.append(aiField('API key', 'aiApiKey', 'password'));
  section.append(aiField('Model', 'aiModel', 'text'));
  paintAiPlaceholders(store.get().aiProvider === 'anthropic' ? 'anthropic' : 'openai');

  section.append(el('h3', { class: 'exp-h3' }, 'Storage'));
  section.append(expModelStorageRow());
  return section;
}

// Experimental → Colorization sub-page. The model is big (~980 MB), so it is
// downloaded EXPLICITLY here (with a progress bar) and the Colorize toggle stays
// locked until it's cached — no surprise multi-hundred-MB download mid-read.
function buildExpColorization() {
  const r = store.get().reader || {};
  const section = el('section', { class: 'settings-section' });

  // Colorize toggle — locked until the model is present.
  const czToggle = switchToggle(r.colorize === true, (v) => store.set({ reader: { colorize: v } }));
  const czInput = czToggle.querySelector('input');
  czInput.disabled = true;
  const czRow = settingRow('Colorize pages',
    { info: 'AI-colour black-and-white manga on this device with manga-colorization-v2 — a model trained on manga/anime art. Download the model below to enable this; line art stays crisp because only colour comes from the model.' },
    czToggle);
  czRow.classList.add('is-locked');
  section.append(czRow);

  // ── Model download, with a real progress bar ──
  const state = el('div', { class: 'sub' }, 'Checking…');
  const fill = el('span', { style: { width: '0%' } });
  const bar = el('div', { class: 'progress exp-dl-bar', style: { display: 'none' } }, fill);
  const dlBtn = btn('Download', { variant: 'accent', class: 'btn-sm', icon: 'install', onClick: () => startDownload() });
  section.append(el('div', { class: 'setting-row exp-model-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, 'Colorization model'),
      state,
      bar,
    ),
    el('div', { class: 'row-actions' }, dlBtn),
  ));

  function setReady(ready) {
    czInput.disabled = !ready;
    czRow.classList.toggle('is-locked', !ready);
    bar.style.display = 'none';
    if (ready) {
      state.textContent = 'Downloaded — manga-colorization-v2 (59 MB), cached on this device.';
      dlBtn.style.display = 'none';
    } else {
      state.textContent = 'manga-colorization-v2 · 59 MB — download once to enable colorization.';
      dlBtn.style.display = '';
      dlBtn.disabled = false;
    }
  }

  async function startDownload() {
    dlBtn.disabled = true;
    bar.style.display = '';
    fill.style.width = '0%';
    state.textContent = 'Downloading… 0%';
    try {
      await downloadColorizeModel((pct) => {
        fill.style.width = pct + '%';
        state.textContent = `Downloading… ${pct}%`;
      });
      toast('Colorization model ready');
      setReady(true);
    } catch (e) {
      state.textContent = `Download failed — ${(e && e.message) || 'check your connection'}. Tap Download to retry.`;
      bar.style.display = 'none';
      dlBtn.disabled = false;
    }
  }

  colorizeModelReady().then(setReady).catch(() => setReady(false));

  // Credit the people whose work this runs on, and link both the original
  // model and the ONNX export actually downloaded. No claims beyond what the
  // pipeline does — the denoising step this used to describe was removed.
  section.append(el('p', { class: 'exp-note' },
    'Runs entirely on this device — pages never leave your browser. Line art stays '
    + 'crisp because only colour comes from the model; the original page supplies '
    + 'the luminance. Colour is generated at a lower resolution and upscaled, so '
    + 'expect soft or occasionally wrong hues — this is a beta.'));

  section.append(el('p', { class: 'exp-note' },
    'Model: ',
    el('a', { href: 'https://github.com/qweasdd/manga-colorization-v2', target: '_blank', rel: 'noopener noreferrer' },
      'manga-colorization-v2'),
    ' by qweasdd (MIT). ONNX build from ',
    el('a', { href: 'https://huggingface.co/Faridzar/manga-colorization-v2-onnx', target: '_blank', rel: 'noopener noreferrer' },
      'Faridzar/manga-colorization-v2-onnx'),
    '. Inference by ',
    el('a', { href: 'https://github.com/microsoft/onnxruntime', target: '_blank', rel: 'noopener noreferrer' },
      'ONNX Runtime'),
    ' (MIT).'));

  section.append(el('h3', { class: 'exp-h3' }, 'Storage'));
  section.append(expModelStorageRow());
  return section;
}

function buildContent() {
  const prefs = store.get();
  const section = el('section', { class: 'settings-section' });
  section.append(settingRow('Show 18+ sources', 'Enable adult-only manga sources in Explore and search.', switchToggle(prefs.showNsfw, (v) => store.set({ showNsfw: v }))));
  section.append(settingRow('Keep 18+ out of history', 'Don’t save adult manga to your reading history.', switchToggle(prefs.noNsfwHistory, (v) => store.set({ noNsfwHistory: v }))));
  section.append(settingRow('Incognito mode', 'Pause reading history entirely — nothing you open is recorded until this is turned off.', switchToggle(prefs.incognito, (v) => { store.set({ incognito: v }); toast(v ? 'Incognito on — history paused' : 'Incognito off'); })));
  section.append(settingRow('Universal search scope', 'Pinned searches only the sources you pinned in Explore (faster, curated); All installed searches everything.',
    segmented([{ value: 'pinned', label: 'Pinned' }, { value: 'all', label: 'All installed' }], prefs.searchScope === 'all' ? 'all' : 'pinned', (v) => store.set({ searchScope: v }))));
  section.append(settingRow(
    'Languages & sources',
    'Re-pick your languages and content preference; reseeds the installed sources.',
    btn('Re-run setup', {
      onClick: () => showPreferences({
        // Push the reseeded sources to the cloud when signed in.
        migrate: sync.status().isAuthenticated,
        onDone: () => {
          try { window.dispatchEvent(new CustomEvent('nyora:sources-synced')); } catch { /* no DOM */ }
          toast('Sources updated');
        },
      }),
    }),
  ));
  return section;
}

function buildBackupData() {
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Backup'));
  section.append(el('p', { class: 'hint', style: { lineHeight: '1.6', margin: '0 0 12px' } },
    'Web-only format (.json) — NOT compatible with backups from the other Nyora apps. ',
    'To move your library between devices, sign in to the same account under ',
    el('a', {
      href: '#/settings?s=sync',
      style: { color: 'var(--accent)', fontWeight: '650', textDecoration: 'none' },
    }, 'Cloud Sync'),
    ' instead.'));
  const exportBtn = btn('Export', { icon: 'download', onClick: () => {
    try {
      const blob = new Blob([JSON.stringify(library.exportData(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `nyora-backup.json` });
      a.click(); URL.revokeObjectURL(url); toast('Exported');
    } catch (e) { toast('Export failed'); }
  }});
  const fileInput = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    try { library.importData(JSON.parse(await file.text())); toast('Imported'); }
    catch (e) { toast('Import failed'); }
    finally { fileInput.value = ''; }
  });
  const importBtn = btn('Import', { icon: 'update', onClick: () => fileInput.click() });
  section.append(el('div', { class: 'row' }, exportBtn, importBtn, fileInput));
  section.append(el('h2', { style: { marginTop: '28px' } }, 'Data'));
  section.append(settingRow('Clear history', 'Favourites kept.', btn('Clear', { variant: 'ghost', onClick: async () => { if (await confirmDialog('Clear history?')) { library.clearHistory(); toast('Cleared'); } } })));
  section.append(settingRow('Erase everything', 'Permanent.', btn('Erase', { variant: 'ghost', class: 'btn-danger', onClick: async () => { if (await confirmDialog('Erase all?')) { library.clearAll(); toast('Erased'); } } })));
  return section;
}

function buildSync() {
  const section = el('section', { class: 'settings-section' });

  const statusText = el('span', { class: 'hint' }, 'Checking...');
  const actions = el('div', { class: 'col', style: { gap: '10px', width: '100%' } });
  section.append(settingRow('Status', 'Your Nyora account keeps favourites, history and bookmarks in sync across all your devices — Android, iOS, desktop, terminal and the web.', statusText));
  section.append(actions);

  const authAndSync = async (register) => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) { toast('Enter your email and password'); return; }
    await runSync(register ? 'Creating account...' : 'Signing in...', async () => {
      // Create Account → migrate this device's (guest) library up to the new
      // cloud account. Sign In → fetch the account's library down from the cloud.
      if (register) await sync.registerAndMigrate(email, password);
      else await sync.signInAndFetch(email, password);
    }, register ? 'Library migrated to your account' : 'Cloud library ready', paint, true);
  };

  const emailInput = el('input', {
    class: 'input', type: 'email', autocomplete: 'email',
    placeholder: 'Email', style: { width: '100%' },
  });
  const passwordInput = el('input', {
    class: 'input', type: 'password', autocomplete: 'current-password',
    placeholder: 'Password', style: { width: '100%' },
  });
  passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') authAndSync(false); });

  const paint = () => {
    const st = sync.status();
    statusText.textContent = !st.isConfigured
      ? 'Not configured'
      : st.isAuthenticated
        ? `Signed in${st.email ? ` (${st.email})` : ` (${st.userId.slice(0, 8)})`}`
        : 'Signed out';
    actions.replaceChildren();
    if (st.isAuthenticated) {
      actions.append(el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
        btn('Sync Now', { icon: 'refresh', onClick: () => runSync('Syncing...', () => sync.syncNow(), 'Cloud sync complete', paint) }),
        btn('Restore', { icon: 'download', variant: 'ghost', onClick: () => runSync('Restoring...', () => sync.restoreFromCloud(), 'Cloud library restored', paint, true) }),
        btn('Sign Out', { variant: 'ghost', onClick: () => { sync.signOut(); paint(); toast('Signed out'); } }),
      ));
    } else {
      emailInput.value = '';
      passwordInput.value = '';
      actions.append(
        el('div', { class: 'field', style: { margin: 0 } }, emailInput),
        el('div', { class: 'field', style: { margin: 0 } }, passwordInput),
        el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
          btn('Sign In', { onClick: () => authAndSync(false) }),
          btn('Create Account', { variant: 'ghost', onClick: () => authAndSync(true) }),
        ),
      );
    }
  };

  paint();
  return section;
}

async function runSync(working, fn, done, repaint, isRestore) {
  toast(working);
  try {
    await fn();
    if (repaint) repaint();
    toast(done);
    if (isRestore) {
      // Notify other screens (e.g. history.js) that the library has been refreshed.
      window.dispatchEvent(new CustomEvent('nyora:library-restored'));
    }
  } catch (e) {
    toast(e && e.message ? e.message : 'Cloud sync failed');
  }
}

function buildAdvanced() {
  const section = el('section', { class: 'settings-section' });

  // Storage usage + persistence (protects the AI models from quota eviction).
  const usage = el('span', { class: 'hint' }, 'Calculating…');
  const persistState = el('span', { class: 'hint' }, 'Checking…');
  (async () => {
    try {
      const est = await navigator.storage.estimate();
      usage.textContent = `${((est.usage || 0) / 1024 / 1024).toFixed(0)} MB used of ${((est.quota || 0) / 1024 / 1024 / 1024).toFixed(1)} GB`;
    } catch { usage.textContent = 'Unavailable'; }
    try {
      persistState.textContent = (await navigator.storage.persisted()) ? 'Protected from eviction' : 'Best-effort (may be evicted)';
    } catch { persistState.textContent = 'Unavailable'; }
  })();
  section.append(settingRow('Storage used', usage, null));
  section.append(settingRow('Storage protection', persistState,
    btn('Request', {
      variant: 'ghost',
      onClick: async () => {
        try {
          const ok = await navigator.storage.persist();
          persistState.textContent = ok ? 'Protected from eviction' : 'Best-effort (may be evicted)';
          toast(ok ? 'Storage protected' : 'Browser declined — keep using the app and try again');
        } catch { toast('Not supported here'); }
      },
    })));

  // Cached page/cover images (service-worker caches; safe to clear anytime).
  section.append(settingRow('Image & API cache', 'Cached page images and chapter lists for offline reading.',
    btn('Clear', {
      variant: 'ghost',
      onClick: async () => {
        try {
          const keys = await caches.keys();
          const targets = keys.filter((k) => /-img$|-api$|-runtime$|-shell$/.test(k));
          await Promise.all(targets.map((k) => caches.delete(k)));
          toast(`Cleared ${targets.length} cache${targets.length === 1 ? '' : 's'}`);
        } catch { toast('Could not clear caches'); }
      },
    })));

  // Server endpoints (read-only — configured at deploy time in env.js).
  const helper = (typeof window !== 'undefined' && window.NYORA_HELPER_URL) || '—';
  const syncUrl = (typeof window !== 'undefined' && window.NYORA_SYNC_URL) || '—';
  section.append(settingRow('Helper server', 'Source parsing and the image proxy.', el('code', { class: 'hint' }, helper)));
  section.append(settingRow('Sync server', 'Cloud account and library sync.', el('code', { class: 'hint' }, syncUrl)));

  section.append(settingRow('Update app', 'Check for a new version now and reload if one is waiting.',
    btn('Check now', {
      variant: 'ghost',
      onClick: async () => {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) { await reg.update(); toast('Checked — reloading'); setTimeout(() => location.reload(), 600); }
          else location.reload();
        } catch { location.reload(); }
      },
    })));
  section.append(settingRow('Reset all settings', 'Restore every preference to its default. Library, history and bookmarks are kept.',
    btn('Reset', {
      variant: 'ghost', class: 'btn-danger',
      onClick: async () => {
        if (!(await confirmDialog('Reset all settings to defaults?'))) return;
        try { localStorage.removeItem('nyora.prefs'); location.reload(); } catch { toast('Could not reset'); }
      },
    })));
  return section;
}

function buildAbout() {
  const section = el('section', { class: 'settings-section about-section', style: { borderBottom: 'none', textAlign: 'center', padding: '48px 0' } });

  const iconLink = (iconName, url, title) => el('a', {
    href: url, target: '_blank', rel: 'noopener', title, 'aria-label': title,
    class: 'social-link',
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '42px', height: '42px', borderRadius: 'var(--radius)',
      background: 'var(--surface2)', color: 'var(--text-dim)',
      transition: 'all 0.2s var(--ease)',
      margin: '0 8px',
    }
  }, icon(iconName));

  const textLink = (label, url) => el('a', {
    href: url, target: '_blank', rel: 'noopener',
    style: { color: 'var(--accent)', fontSize: '13px', textDecoration: 'none', fontWeight: '600' },
  }, label);

  const credits = el('div', { class: 'credits' },
    el('div', { style: { fontWeight: '800', fontSize: '18px', letterSpacing: '0.08em', marginBottom: '6px', color: 'var(--text)' } }, 'NYORA WEB 2.0'),
    el('div', { style: { color: 'var(--text-faint)', fontSize: '13px', marginBottom: '4px' } }, 'A free, open-source manga reader for the browser.'),
    el('div', { style: { color: 'var(--text-faint)', fontSize: '12px', marginBottom: '24px' } }, 'Released under the Apache 2.0 License.'),
    el('div', { class: 'row', style: { justifyContent: 'center' } },
      iconLink('github', 'https://github.com/Nyora-Manga/nyora-web', 'Source code on GitHub'),
      iconLink('globe', 'https://nyora.xyz', 'Website'),
    ),
    el('div', { style: { marginTop: '18px', display: 'flex', justifyContent: 'center', gap: '20px', flexWrap: 'wrap' } },
      textLink('Source code ↗', 'https://github.com/Nyora-Manga/nyora-web'),
      textLink('Report an issue ↗', 'https://github.com/Nyora-Manga/nyora-web/issues'),
      textLink('License ↗', 'https://github.com/Nyora-Manga/nyora-web/blob/main/LICENSE'),
    ),
    el('div', {
      style: { color: 'var(--text-faint)', fontSize: '12px', marginTop: '20px', maxWidth: '420px', marginLeft: 'auto', marginRight: 'auto', lineHeight: '1.5' },
    }, 'Nyora — your manga library, everywhere. Available on Android, Windows, macOS, Linux, iOS and the web.')
  );

  section.append(credits);
  return section;
}

// ── Tracking ─────────────────────────────────────────────────────────────────

function buildTracking() {
  const section = el('section', { class: 'settings-section' });
  const rerender = () => section.replaceWith(buildTracking());
  section.append(el('p', { class: 'exp-hint' },
    'Connect any of these services — you can enable several at once, and each linked '
    + 'manga scrobbles to all of them once per chapter as you read. Use the toggle to '
    + 'pause a service without signing out; link/change status per manga from a title’s '
    + 'Tracking button. Tokens are stored on this device.'));
  for (const t of tracking.TRACKERS) section.append(trackerRow(t, rerender));
  return section;
}

function trackerRow(t, refresh) {
  if (tracking.isConnected(t.slug)) {
    const toggle = m3Switch(tracking.isEnabled(t.slug), (on) => tracking.setEnabled(t.slug, on));
    const signOut = btn('Disconnect', {
      variant: 'ghost', class: 'btn-sm btn-danger',
      onClick: () => { tracking.disconnect(t.slug); toast(`${t.name} disconnected`); refresh(); },
    });
    return el('div', { class: 'setting-row' },
      el('div', { class: 'row-main' },
        el('div', { class: 'name' }, t.name),
        el('div', { class: 'sub' }, 'Connected — scrobbling on chapter open')),
      el('div', { class: 'row-actions', style: { gap: '8px' } }, toggle, signOut));
  }
  if (t.auth === 'password') return trackerPasswordRow(t, refresh);
  const connectBtn = btn('Connect', {
    variant: 'ghost', class: 'btn-sm',
    onClick: async () => {
      connectBtn.disabled = true;
      try { await tracking.connect(t.slug); toast(`${t.name} connected`); refresh(); }
      catch (e) { toast(e && e.message ? e.message : 'Sign-in failed'); connectBtn.disabled = false; }
    },
  });
  return el('div', { class: 'setting-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, t.name),
      el('div', { class: 'sub' }, 'Not connected')),
    el('div', { class: 'row-actions' }, connectBtn));
}

function trackerPasswordRow(t, refresh) {
  // Kitsu has no OAuth popup — collect email/password in a proper Material dialog,
  // so its row looks and behaves like the OAuth trackers (a single Connect button).
  const connectBtn = btn('Connect', {
    variant: 'ghost', class: 'btn-sm',
    onClick: () => openPasswordLogin(t, refresh),
  });
  return el('div', { class: 'setting-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, t.name),
      el('div', { class: 'sub' }, 'Sign in with your email and password')),
    el('div', { class: 'row-actions' }, connectBtn));
}

function openPasswordLogin(t, refresh) {
  const email = el('input', {
    type: 'email', placeholder: 'you@example.com',
    autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false',
  });
  const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const errLine = el('div', {
    style: { color: 'var(--danger, #ef5350)', fontSize: '12.5px', minHeight: '15px', margin: '-8px 0 12px' },
  });
  const loginBtn = btn('Log in', { variant: 'accent' });
  loginBtn.style.width = '100%';

  const body = el('div', {},
    el('p', { class: 'exp-hint', style: { margin: '0 0 16px' } },
      `Sign in with your ${t.name} email and password. Your password is sent once to fetch an `
      + 'access token and is never stored — only the token is kept on this device.'),
    el('div', { class: 'field' }, el('label', null, 'Email'), email),
    el('div', { class: 'field' }, el('label', null, 'Password'), pass),
    errLine,
    loginBtn,
  );
  const close = modal({ title: `Sign in to ${t.name}`, body });

  let busy = false;
  async function submit() {
    if (busy) return;
    errLine.textContent = '';
    if (!email.value.trim() || !pass.value) { errLine.textContent = 'Enter your email and password.'; return; }
    busy = true;
    loginBtn.disabled = email.disabled = pass.disabled = true;
    loginBtn.replaceChildren(spinner(), el('span', null, 'Signing in…'));
    try {
      await tracking.connect(t.slug, { username: email.value.trim(), password: pass.value });
      close();
      toast(`${t.name} connected`);
      refresh();
    } catch (e) {
      errLine.textContent = (e && e.message) || 'Login failed — check your email and password.';
      busy = false;
      loginBtn.disabled = email.disabled = pass.disabled = false;
      loginBtn.replaceChildren(el('span', null, 'Log in'));
    }
  }
  loginBtn.addEventListener('click', submit);
  email.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pass.focus(); } });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  setTimeout(() => { try { email.focus(); } catch { /* ignore */ } }, 60);
}

export default { meta, render };
