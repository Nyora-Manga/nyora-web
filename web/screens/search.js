// screens/search.js — GLOBAL SEARCH across ALL installed sources, run in
// concurrency-limited batches so the hosted helper isn't hammered with hundreds
// of concurrent upstream searches. Results stream in as each source responds;
// only sources with matches get a section (no wall of empty skeletons).

import { api } from '../core/api.js';
import {
  el, card, btn, spinner, emptyState, errorBox, langLabel,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = { title: 'Search', nav: false, icon: 'search', order: 99 };

const PER_SOURCE_LIMIT = 12;
// How many sources are queried at once. Kept modest: each query can trigger a
// server-side Cloudflare solve, and too many at once overloads the small VM.
const BATCH_SIZE = 6;
// A slow/hung source shouldn't hold a batch slot forever — free it after this.
const PER_SOURCE_TIMEOUT = 25_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function render(view, params) {
  view.replaceChildren();

  const runState = { token: 0, total: 0, done: 0, hits: 0 };
  const query = (params && params.q != null ? String(params.q) : '').trim();

  const title = el('h1', { class: 'page-title', style: { marginBottom: '8px' } },
    query ? `Results for “${query}”` : 'Global Search');
  const searchInput = el('input', {
    id: 'searchPageInput', type: 'search', value: query,
    placeholder: 'Search all sources', autocomplete: 'off', enterkeyhint: 'search',
  });
  const searchForm = el('form', {
    class: 'search-page-header',
    onSubmit: (e) => {
      e.preventDefault();
      const next = searchInput.value.trim();
      router.navigate('search', next ? { q: next } : undefined);
    },
  },
    el('div', { class: 'search-field-v2' },
      btn('Search', { variant: 'accent', class: 'btn-sm', type: 'submit' }),
      searchInput,
    ),
  );
  const status = el('div', { class: 'search-status', style: { marginBottom: '24px' } });
  const results = el('div', { class: 'search-results' });

  view.append(title, searchForm, status, results);
  requestAnimationFrame(() => {
    if (!query || document.body.dataset.route === 'search') {
      searchInput.focus({ preventScroll: true });
      try { searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); } catch { /* ignore */ }
    }
  });

  function updateProgress() {
    if (runState.done < runState.total) {
      status.replaceChildren(
        spinner(),
        el('span', null, `Searching ${runState.done}/${runState.total} sources · ${runState.hits} with matches`),
      );
    } else {
      status.replaceChildren(el('span', { class: 'chip' },
        runState.hits > 0
          ? `Found matches in ${runState.hits} of ${runState.total} sources`
          : `No matches found for “${query}”`));
    }
  }

  // Append a result section for a source that returned matches.
  function appendResultSection(src, list) {
    const sid = src.id;
    const lang = (src.lang || '').toUpperCase();
    const head = el('div', { class: 'search-result-header' },
      el('div', { class: 'source-meta' },
        el('div', { class: 'medallion-sm' }, lang.slice(0, 2) || '??'),
        el('div', null,
          el('h3', { class: 'source-name' }, src.name || sid),
          el('div', { class: 'source-sub' }, langLabel(src)),
        ),
      ),
      el('span', { class: 'chip btn-sm' }, list.length + (list.length >= PER_SOURCE_LIMIT ? '+' : '')),
    );
    const grid = el('div', { class: 'grid dense' });
    for (const manga of list) {
      grid.appendChild(card(manga, (m) => router.navigate('details', { sid, url: m.url })));
    }
    results.appendChild(el('section', { class: 'search-source-card-minimal' }, head, grid));
  }

  async function searchOne(src, token) {
    try {
      const res = await withTimeout(api.search(src.id, query, 1), PER_SOURCE_TIMEOUT);
      if (token !== runState.token) return;
      const list = ((res && res.entries) || []).slice(0, PER_SOURCE_LIMIT);
      if (list.length) { runState.hits++; appendResultSection(src, list); }
    } catch {
      // Failed / blocked / timed-out source — skip silently (don't clutter with
      // an error card per dead source when searching hundreds).
    } finally {
      if (token === runState.token) { runState.done++; updateProgress(); }
    }
  }

  function renderEmpty() {
    title.textContent = 'Global Search';
    status.replaceChildren();
    results.replaceChildren(emptyState('Search across every installed source', 'search'));
  }

  async function runSearch() {
    const token = ++runState.token;
    runState.total = 0; runState.done = 0; runState.hits = 0;
    results.replaceChildren();
    status.replaceChildren(spinner(), el('span', null, 'Loading sources…'));

    let sources;
    try {
      const res = await api.listSources();
      if (token !== runState.token) return;
      sources = (res && res.sources || []).filter((s) => s.isInstalled);
    } catch (e) {
      results.replaceChildren(errorBox(e.message));
      return;
    }
    if (!sources.length) { results.replaceChildren(emptyState('No sources installed', 'compass')); return; }

    // Pinned first, then the rest — results still stream in as they resolve.
    sources.sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));
    runState.total = sources.length;
    updateProgress();

    // Concurrency-limited worker pool: BATCH_SIZE workers each pull the next
    // source off the shared cursor until every source has been queried.
    let cursor = 0;
    const worker = async () => {
      while (token === runState.token) {
        const i = cursor++;
        if (i >= sources.length) return;
        await searchOne(sources[i], token);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_SIZE, sources.length) }, worker));
    if (token === runState.token) updateProgress();
  }

  if (query) runSearch(); else renderEmpty();
}

export default { meta, render };
