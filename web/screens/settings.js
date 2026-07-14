// screens/settings.js — client-side preferences for the Nyora web SPA.

import library from '../core/library.js';
import {
  el, toast, btn, sectionHeader, confirmDialog, icon,
} from '../core/ui.js';
import {
  store, COLOR_SCHEMES, resolveAccent, detectBrowserAccent,
} from '../core/store.js';
import sync from '../core/sync.js';
import { showPreferences } from './welcome.js';

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

function settingRow(name, sub, control) {
  return el('div', { class: 'setting-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, name),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ),
    el('div', { class: 'row-actions' }, control),
  );
}

function segControl(options, selected, onSelect) {
  const wrap = el('div', { class: 'seg' });
  for (const [value, label] of options) {
    const b = el('button', {
      type: 'button', class: value === selected ? 'active' : '',
      onClick: () => {
        if (b.classList.contains('active')) return;
        for (const child of Array.from(wrap.children)) child.classList.remove('active');
        b.classList.add('active'); onSelect(value);
      },
    }, label);
    wrap.appendChild(b);
  }
  return wrap;
}

function switchToggle(checked, onToggle) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onToggle(input.checked));
  return el('label', { class: 'switch' }, input, el('span', { class: 'slider' }));
}

// --- colour-scheme preview card (mirrors android item_color_scheme.xml) -----
// Each card paints a mini surface with an "Abc" label, two secondary-tone bars,
// a primary swatch, an optional check, and the scheme name beneath.

/** Resolve a card's primary tone for the active appearance. */
function cardPrimary(scheme, appearance) {
  if (scheme.wallpaper) return detectBrowserAccent() || resolveAccent('wallpaper', appearance);
  return appearance === 'LIGHT' ? scheme.light : scheme.dark;
}

/** Resolve a card's secondary tone (used for the two preview bars). */
function cardSecondary(scheme, appearance) {
  if (scheme.wallpaper) return cardPrimary(scheme, appearance);
  return scheme.sec || scheme.dark;
}

function schemeCard(scheme, { active, appearance, onChoose } = {}) {
  const primary = cardPrimary(scheme, appearance);
  const secondary = cardSecondary(scheme, appearance);
  const check = icon('check');
  check.classList.add('scheme-check');
  const surface = el('div', { class: 'scheme-card-surface' },
    el('span', { class: 'scheme-abc' }, 'Abc'),
    el('span', { class: 'scheme-bar', style: { background: secondary, width: '40%' } }),
    el('span', { class: 'scheme-bar', style: { background: secondary, width: '70%' } }),
    el('span', { class: 'scheme-primary', style: { background: primary } }),
    check,
  );
  const card = el('div', {
    class: active ? 'scheme-card active' : 'scheme-card',
    role: 'button', tabindex: '0', title: scheme.name,
    style: { '--card-primary': primary },
  },
    surface,
    el('span', { class: 'scheme-name' }, scheme.name),
  );
  const choose = () => onChoose && onChoose(card);
  card.addEventListener('click', choose);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  return card;
}

export function render(view, _params) {
  view.replaceChildren();
  view.append(sectionHeader('Settings'));
  view.append(buildAppearance());
  view.append(buildReader());
  view.append(buildContent());
  view.append(buildSync());
  view.append(buildBackup());
  view.append(buildData());
  view.append(buildAbout());
}

function buildAppearance() {
  const prefs = store.get();
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Appearance'));
  section.append(settingRow('Theme', null, segControl([['DARK', 'Dark'], ['LIGHT', 'Light']], prefs.appearance === 'LIGHT' ? 'LIGHT' : 'DARK', (v) => store.set({ appearance: v }))));
  const appearance = prefs.appearance === 'LIGHT' ? 'LIGHT' : 'DARK';
  const cards = el('div', { class: 'scheme-cards' });
  // Any unknown/legacy stored value (old 'wallpaper'/'auto', raw hex) → default Sakura.
  const knownIds = new Set(COLOR_SCHEMES.map((s) => s.id));
  const selectedId = knownIds.has(prefs.accent) ? prefs.accent : 'sakura';
  const clearActive = () => { for (const child of Array.from(cards.children)) child.classList.remove('active'); };
  for (const scheme of COLOR_SCHEMES) {
    cards.appendChild(schemeCard(scheme, {
      active: scheme.id === selectedId,
      appearance,
      onChoose: (node) => { store.set({ accent: scheme.id }); clearActive(); node.classList.add('active'); },
    }));
  }
  section.append(field('Color scheme', cards, 'Sakura is the default accent.'));
  return section;
}

function buildReader() {
  const prefs = store.get();
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Reader'));
  section.append(settingRow('Default reading mode', null, segControl([['WEBTOON', 'Webtoon'], ['PAGED', 'Paged'], ['PAGED_RTL', 'Paged RTL']], prefs.reader.mode, (v) => store.set({ reader: { mode: v } }))));
  section.append(settingRow('Image fit', null, segControl([['WIDTH', 'Width'], ['HEIGHT', 'Height']], prefs.reader.fit, (v) => store.set({ reader: { fit: v } }))));
  section.append(settingRow('Prefetch next pages', null, switchToggle(prefs.reader.prefetch, (v) => store.set({ reader: { prefetch: v } }))));
  return section;
}

function buildContent() {
  const prefs = store.get();
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Content'));
  section.append(settingRow('Show 18+ sources', 'Enable adult-only manga sources in Explore and search.', switchToggle(prefs.showNsfw, (v) => store.set({ showNsfw: v }))));
  section.append(settingRow('Keep 18+ out of history', 'Don’t save adult manga to your reading history.', switchToggle(prefs.noNsfwHistory, (v) => store.set({ noNsfwHistory: v }))));
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

function buildBackup() {
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Backup'));
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
  return section;
}

function buildSync() {
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Cloud Sync'));

  const statusText = el('span', { class: 'hint' }, 'Checking...');
  const actions = el('div', { class: 'col', style: { gap: '10px', width: '100%' } });
  section.append(settingRow('Status', 'Self-hosted account sync', statusText));
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

function buildData() {
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Data'));
  section.append(settingRow('Clear history', 'Favourites kept.', btn('Clear', { variant: 'ghost', onClick: async () => { if (await confirmDialog('Clear history?')) { library.clearHistory(); toast('Cleared'); } } })));
  section.append(settingRow('Erase everything', 'Permanent.', btn('Erase', { variant: 'ghost', class: 'btn-danger', onClick: async () => { if (await confirmDialog('Erase all?')) { library.clearAll(); toast('Erased'); } } })));
  return section;
}

function buildAbout() {
  const section = el('section', { class: 'settings-section about-section', style: { borderBottom: 'none', textAlign: 'center', padding: '48px 0' } });

  const iconLink = (iconName, url, title) => el('a', {
    href: url, target: '_blank', rel: 'noopener', title, 'aria-label': title,
    class: 'social-link',
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '42px', height: '42px', borderRadius: '12px',
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

export default { meta, render };
