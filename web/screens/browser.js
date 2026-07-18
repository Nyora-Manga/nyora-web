// screens/browser.js — open source websites (and any URL) in a new tab.
//
// A standalone web app can't embed manga sites in an iframe (X-Frame-Options /
// CSP block it), so "Browser" is an honest launcher: a URL bar plus a list of
// your installed sources, each opening its real site in a new browser tab.

import { api } from '../core/api.js';
import {
  el, $, btn, icon, sectionHeader, spinner, emptyState, errorBox, toast,
} from '../core/ui.js';

export const meta = { title: 'Browser', nav: false, icon: 'globe' };

function openUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    window.open(new URL(url).href, '_blank', 'noopener');
  } catch {
    toast('That doesn’t look like a valid URL.');
  }
}

export function render(view, _params) {
  view.replaceChildren(sectionHeader('Browser'));

  // ── URL bar ──────────────────────────────────────────────────────────────
  const input = el('input', {
    class: 'field',
    type: 'url',
    placeholder: 'Enter a website address…',
    'aria-label': 'Website address',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); openUrl(input.value); } },
  });
  const go = btn('Open', { variant: 'accent', icon: 'external', onClick: () => openUrl(input.value) });
  view.append(
    el('div', { class: 'settings-section' },
      el('p', { class: 'hint', style: { margin: '0 0 12px' } },
        'Open any site, or a source’s website below, in a new tab. Sites open directly (not through the reader).'),
      el('div', { class: 'row', style: { gap: '10px' } },
        el('div', { style: { flex: '1 1 auto', minWidth: '0' } }, input),
        go,
      ),
    ),
  );

  // ── source websites ────────────────────────────────────────────────────
  const host = el('div', { class: 'list' });
  view.append(sectionHeader('Source websites'), host);
  loadSources(host);
}

async function loadSources(host) {
  host.replaceChildren(el('div', { class: 'center', style: { padding: '40px 0' } }, spinner()));
  let sources;
  try {
    const res = await api.listSources();
    sources = (res && res.sources) || (Array.isArray(res) ? res : []);
  } catch (e) {
    host.replaceChildren(errorBox(`Couldn't load sources: ${e.message || e}`));
    return;
  }
  const installed = sources.filter((s) => s.isInstalled);
  if (!installed.length) {
    host.replaceChildren(emptyState('No installed sources yet — install some from Explore.'));
    return;
  }
  installed.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  host.replaceChildren(
    ...installed.map((s) => {
      const url = s.baseUrl || (s.domain ? `https://${s.domain}` : '');
      const lang = (s.lang || '').toUpperCase().slice(0, 2) || '??';
      return el('div', {
        class: 'row-item',
        role: 'button',
        tabindex: '0',
        'aria-label': `Open ${s.name}`,
        onClick: () => openUrl(url),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openUrl(url); } },
      },
        el('div', { class: 'thumb', style: { display: 'grid', placeItems: 'center', fontWeight: '800', fontSize: '12px' } }, lang),
        el('div', { class: 'row-main' },
          el('div', { class: 'name' }, s.name || 'Source'),
          el('div', { class: 'sub' }, (url || '').replace(/^https?:\/\//, '')),
        ),
        el('div', { class: 'row-actions' },
          btn('Open', { variant: 'ghost', class: 'btn-sm', icon: 'external', onClick: (e) => { e.stopPropagation(); openUrl(url); } }),
        ),
      );
    }),
  );
}
