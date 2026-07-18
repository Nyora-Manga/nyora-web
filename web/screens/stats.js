// screens/stats.js — reading-life dashboard.
//
// A headline .stat-grid of counter cards (chapters read, distinct manga,
// favourites, sources) over a "By Source" leaderboard with accent .progress
// bars showing each source's share of reads.
//
// Data: library.stats() (core/library.js) is SYNCHRONOUS and returns
// {totalChapters, totalManga, totalFavourites, bySource:[{sourceName, count}]}
// derived client-side from history + favourites. bySource is sorted desc.
// Stats are always returned (zeros when no history) so "empty" = every headline
// is 0 AND no sources. Only real numbers from stats() are shown — no estimates.

import library from '../core/library.js';
import {
  el, emptyState, errorBox, sectionHeader, icon, chip, btn,
} from '../core/ui.js';

export const meta = {
  title: 'Stats',
  nav: false,
  icon: 'stats',
  order: 75,
};

export function render(view, _params) {
  view.replaceChildren();

  const header = sectionHeader('Stats');
  const body = el('div', { class: 'stats-body' });
  view.append(header, body);

  load(body);
}

function load(body) {
  let stats;
  try {
    stats = library.stats();
  } catch (err) {
    body.replaceChildren(
      errorBox(`Couldn't load statistics: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '12px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body) }),
      ),
    );
    return;
  }

  stats = stats || {};
  const totalChapters = num(stats.totalChapters);
  const distinctManga = num(stats.totalManga != null ? stats.totalManga : stats.distinctManga);
  const favouritesCount = num(stats.totalFavourites != null ? stats.totalFavourites : stats.favouritesCount);

  // bySource is the canonical leaderboard ([{sourceName, count}], sorted desc).
  const sources = (Array.isArray(stats.bySource) ? stats.bySource
    : (Array.isArray(stats.topSources) ? stats.topSources : []))
    .map((s) => ({ name: sourceName(s), count: num(s.count) }))
    .filter((s) => s.count > 0);
  const sourceCount = sources.length;

  const hasAny =
    totalChapters > 0 || distinctManga > 0 || favouritesCount > 0 || sourceCount > 0;

  if (!hasAny) {
    body.replaceChildren(
      emptyState('No statistics yet — start reading and your stats will gather here.'),
    );
    return;
  }

  body.replaceChildren();

  // ---- Headline counters --------------------------------------------------
  body.appendChild(
    el('div', { class: 'stat-grid' },
      statCard('history', totalChapters, 'Chapters read'),
      statCard('library', distinctManga, 'Manga'),
      statCard('heart', favouritesCount, 'Favourites'),
      statCard('globe', sourceCount, 'Sources'),
    ),
  );

  // ---- By-source leaderboard ---------------------------------------------
  if (sources.length) {
    const maxCount = Math.max(1, ...sources.map((s) => s.count));

    const list = el('div', { class: 'list', style: { marginTop: '8px' } });
    for (const source of sources) {
      list.appendChild(sourceRow(source, maxCount));
    }

    body.append(
      sectionHeader('By Source'),
      list,
    );
  }
}

// A single headline counter card: accent number + dim label, icon-led.
function statCard(iconName, value, label) {
  return el('div', { class: 'stat-card' },
    el('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
      icon(iconName),
      el('div', { class: 'num' }, num(value).toLocaleString()),
    ),
    el('div', { class: 'lbl' }, label),
  );
}

// A leaderboard row: source name + read-count chip over an accent progress bar
// whose width is the source's share of the most-read source.
function sourceRow(source, maxCount) {
  const { name, count } = source;
  const pct = Math.max(2, Math.round((count / maxCount) * 100));

  const main = el('div', { class: 'row-main' },
    el('div', { class: 'name', title: name }, name),
    el('div', { class: 'progress' },
      el('span', { style: { width: `${pct}%` } })),
  );

  const actions = el('div', { class: 'row-actions' },
    chip(`${count.toLocaleString()} read`),
  );

  return el('div', { class: 'row-item' }, main, actions);
}

function sourceName(s) {
  return (s && s.sourceName && String(s.sourceName).trim()) ||
    (s && s.sourceId && String(s.sourceId).trim()) || 'Unknown';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
