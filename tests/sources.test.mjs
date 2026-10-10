import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = { location: { origin: 'https://reader.test' }, dispatchEvent() {} };
globalThis.NYORA_HELPER_URL = 'https://helper.test';
const { api, helperSourceId } = await import('../web/core/api.js');
const { sourcePrefRows, applySourcePrefRows } = await import('../web/core/parser-runtime.js');
const library = (await import('../web/core/library.js')).default;
const { syncNow } = await import('../web/core/sync.js');
let requests;
let catalogue;
let remote;
beforeEach(async () => {
  storage.clear();
  requests = [];
  catalogue = [{ id: 'data:mangadex', name: 'MangaDex' }, { id: 'data:asurascans', name: 'Asura' }];
  remote = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://reader.test');
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: u, method: init.method || 'GET', body, cache: init.cache });
    let data = u.pathname === '/sources/catalog' ? { entries: catalogue } : { entries: [], filters: [{ name: 'Genres' }] };
    if (body?.action === 'select') data = { data: remote[body.table] || [] };
    if (body?.action === 'upsert') data = { ok: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await api.refreshSources();
  library.importData({});
});

test('catalogue refresh bypasses older browser and shared-cache snapshots', async () => {
  await api.catalog();
  await api.refreshSources();
  await api.catalog();
  const reads = requests.filter((r) => r.url.pathname === '/sources/catalog');
  assert.ok(reads.length >= 2);
  assert.ok(reads.every((r) => r.cache === 'no-store'));
});

test('canonical source IDs survive every reader request and filters use the helper', async () => {
  assert.equal(await helperSourceId('data:mangadex'), 'data:mangadex');
  await api.popular('data:mangadex');
  await api.latest('data:mangadex');
  await api.search('data:mangadex', 'one');
  await api.details('data:mangadex', '/title/1');
  await api.pages('data:mangadex', '/chapter/2');
  const filters = await api.sourceFilters('data:mangadex');
  assert.equal(filters.filters[0].name, 'Genres');
  for (const r of requests.filter((r) => r.url.searchParams.has('id'))) {
    assert.equal(r.url.origin, 'https://helper.test');
    assert.equal(r.url.searchParams.get('id'), 'data:mangadex');
  }
});

test('runtime rejects legacy IDs instead of guessing a parser route', async () => {
  await assert.rejects(helperSourceId('parser:MANGADEX'), /source/i);
  await assert.rejects(helperSourceId('data:bad/id'), /source/i);
  assert.equal(await helperSourceId('data:unavailable'), 'data:unavailable');
});

test('catalogue fails clearly for an old helper and retries after it is upgraded', async () => {
  catalogue = [{ id: 'parser:MANGADEX', name: 'MangaDex' }];
  await assert.rejects(api.catalog(), /data.driven|catalogue/i);
  catalogue = [{ id: 'data:mangadex', name: 'MangaDex' }];
  assert.equal((await api.catalog()).entries[0].id, 'data:mangadex');
});

test('install, disable, and pin share the source preference sync store without mutating the shared helper', async () => {
  await api.setInstalledSources(['data:mangadex']);
  await api.pinSource('data:mangadex', true);
  assert.deepEqual((await api.listSources()).sources.map((s) => [s.id, s.isPinned]), [['data:mangadex', true]]);
  let rows = sourcePrefRows('u');
  assert.equal(rows.find((r) => r.source_id === 'data:mangadex')?.is_pinned, true);
  assert.equal(rows.find((r) => r.source_id === 'data:asurascans')?.is_enabled, false);
  await api.uninstallSource('data:mangadex');
  rows = sourcePrefRows('u');
  assert.equal(rows.find((r) => r.source_id === 'data:mangadex')?.is_enabled, false);
  assert.equal(rows.find((r) => r.source_id === 'data:mangadex')?.is_pinned, false);
  assert.equal(requests.filter((r) => r.method !== 'GET').length, 0);
});

test('pulled canonical preferences change Explore and persist the newer clock even when values match', async () => {
  await api.catalog();
  applySourcePrefRows([{ source_id: 'data:mangadex', is_enabled: false, is_pinned: false, updated_at: '2026-09-17T12:00:00Z' }]);
  applySourcePrefRows([{ source_id: 'data:mangadex', is_enabled: false, is_pinned: false, updated_at: '2026-09-17T13:00:00Z' }]);
  applySourcePrefRows([{ source_id: 'data:mangadex', is_enabled: true, is_pinned: true, updated_at: '2026-09-17T12:30:00Z' }]);
  assert.deepEqual((await api.listSources()).sources.map((s) => s.id), ['data:asurascans']);
  assert.equal(sourcePrefRows('u').find((r) => r.source_id === 'data:mangadex').updated_at, '2026-09-17T13:00:00.000Z');
});

test('cloud push and pull preserve canonical source references and opaque manga IDs', async () => {
  localStorage.setItem('nyora.sync.session.v1', JSON.stringify({ access_token: 'test', user_id: 'u' }));
  const manga = { id: '9223372036854775806', url: '/title/1', title: 'A', source: { name: 'data:mangadex' } };
  library.importData({ favourites: { [manga.id]: { manga, addedAt: 1000 } }, history: {
    [manga.id]: { manga, sourceId: 'data:mangadex', chapterId: 'ch1', updatedAt: 1000, page: 4 },
  }});
  remote.nyora_manga = [{ id: manga.id, title: 'A', url: manga.url, source_ref: '{"name":"data:mangadex"}' }];
  remote.nyora_history = [{ manga_id: manga.id, source_id: 'data:mangadex', chapter_id: 'ch1', page: 4, updated_at: '2026-09-17T12:00:00Z' }];
  await syncNow();
  const pushed = requests.find((r) => r.body?.action === 'upsert' && r.body.table === 'nyora_manga').body.rows[0];
  assert.equal(pushed.id, manga.id);
  assert.deepEqual(JSON.parse(pushed.source_ref), { name: 'data:mangadex' });
  assert.equal(library.exportData().history[manga.id].sourceId, 'data:mangadex');
});

test('first catalogue load migrates visible preferences and saved source IDs once', async () => {
  localStorage.setItem('nyora.sources.installed.v3', JSON.stringify(['parser:MANGADEX']));
  localStorage.setItem('nyora.sources.pinned.v1', JSON.stringify(['parser:MANGADEX']));
  const manga = { id: '42', source: { name: 'DD_MANGADEX' }, url: '/a' };
  library.importData({ favourites: { '42': { manga, addedAt: 1 } } });
  const sources = (await api.listSources()).sources;
  assert.deepEqual(sources.map((s) => [s.id, s.isPinned]), [['data:mangadex', true]]);
  assert.equal(library.exportData().favourites['42'].manga.source.name, 'data:mangadex');
  await api.uninstallSource('data:mangadex');
  await api.refreshSources();
  assert.equal((await api.listSources()).sources.length, 0);
  catalogue.push({ id: 'data:newsource' });
  await api.refreshSources();
  assert.equal((await api.listSources()).sources.length, 0);
});

test('sync retains unresolved local records, skips legacy wire sources, and uses existing metadata for delta history', async () => {
  localStorage.setItem('nyora.sync.session.v1', JSON.stringify({ access_token: 'test', user_id: 'u' }));
  library.importData({ favourites: {
    keep: { manga: { id: 'keep', source: 'parser:UNAVAILABLE', title: 'Keep me' }, addedAt: 1 },
    good: { manga: { id: 'good', source: { name: 'data:mangadex' }, title: 'Known', url: '/good' }, addedAt: 1 },
  }});
  remote.nyora_manga = [{ id: 'old', source_ref: '{"name":"JS_MANGADEX"}', url: '/old' }];
  remote.nyora_favourite = [{ manga_id: 'old', updated_at: '2026-09-17T12:00:00Z' }];
  remote.nyora_history = [{ manga_id: 'good', source_id: 'data:mangadex', chapter_id: 'ch2', page: 6, updated_at: '2026-09-17T12:00:00Z' }];
  await syncNow();
  const data = library.exportData();
  assert.equal(data.favourites.keep.manga.title, 'Keep me');
  assert.equal(data.favourites.old, undefined);
  assert.equal(data.history.good.manga.title, 'Known');
  const uploaded = requests.filter((r) => r.body?.action === 'upsert').flatMap((r) => r.body.rows);
  assert.equal(uploaded.some((r) => r.id === 'keep' || r.manga_id === 'keep'), false);
});

test('an empty catalogue cannot finalize the legacy source migration', async () => {
  catalogue = [];
  localStorage.setItem('nyora.sources.installed.v3', '["parser:MANGADEX"]');
  await assert.rejects(api.catalog(), /catalogue/i);
  assert.equal(localStorage.getItem('nyora.sources.migrated.v1'), null);
  catalogue = [{ id: 'data:mangadex' }];
  assert.equal((await api.listSources()).sources[0].id, 'data:mangadex');
});

test('failed migration storage can retry without marking stale library data complete', async () => {
  library.importData({ favourites: { a: { manga: { id: 'a', source: 'parser:MANGADEX', url: '/a' } } } });
  const setItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === 'nyora.library.v1') throw new Error('QuotaExceededError');
    setItem(key, value);
  };
  try {
    await assert.rejects(api.catalog());
    assert.equal(localStorage.getItem('nyora.sources.migrated.v1'), null);
  } finally { localStorage.setItem = setItem; }
  await api.catalog();
  assert.equal(JSON.parse(localStorage.getItem('nyora.library.v1')).favourites.a.manga.source.name, 'data:mangadex');
  assert.equal(localStorage.getItem('nyora.sources.migrated.v1'), '1');
});

test('catalogue rejects object IDs and canonical duplicate IDs', async () => {
  catalogue = [{ id: { name: 'data:mangadex' } }];
  await assert.rejects(api.catalog(), /catalogue/i);
  catalogue = [{ id: 'data:mangadex' }, { id: 'data:mangadex' }];
  await assert.rejects(api.catalog(), /catalogue/i);
});

test('delta history can update a URL-keyed title that is not favourited', async () => {
  localStorage.setItem('nyora.sync.session.v1', JSON.stringify({ access_token: 'test', user_id: 'u' }));
  const id = 'data:mangadex|/a';
  library.importData({ history: { [id]: { manga: { title: 'History only', url: '/a', source: { name: 'data:mangadex' } }, sourceId: 'data:mangadex', page: 2, updatedAt: 1000 } } });
  remote.nyora_history = [{ manga_id: id, source_id: 'data:mangadex', chapter_id: 'ch1', page: 5, updated_at: '2026-09-17T12:00:00Z' }];
  await syncNow();
  assert.equal(library.exportData().history[id].page, 5);
  assert.equal(library.exportData().history[id].manga.title, 'History only');
});

test('NSFW catalogue metadata is consistent for flags and content types', async () => {
  catalogue = [
    { id: 'data:normal', contentType: 'Manga' },
    { id: 'data:flagged', nsfw: true, contentType: 'Manga' },
    { id: 'data:typed', isNsfw: false, contentType: 'Hentai' },
    { id: 'data:adult', isNsfw: true },
  ];
  const rows = (await api.catalog()).entries;
  assert.deepEqual(rows.map((s) => s.isNsfw), [false, true, true, true]);
  assert.deepEqual((await api.listSources()).sources.map((s) => s.isNsfw), [false, true, true, true]);
});

test('enabling 18+ restores sources hidden by setup but preserves explicit removals and language choices', async () => {
  catalogue = [
    { id: 'data:normal', lang: 'en' },
    { id: 'data:adult', lang: 'en', isNsfw: true },
    { id: 'data:otherlanguage', lang: 'fr', isNsfw: true },
  ];
  await api.setInstalledSources(['data:normal'], { deferredNsfwIds: ['data:adult'] });
  assert.deepEqual((await api.listSources()).sources.map((s) => s.id), ['data:normal']);
  assert.equal(sourcePrefRows('u').some((r) => r.source_id === 'data:adult'), false);
  await api.enableSetupNsfwSources();
  assert.deepEqual((await api.listSources()).sources.map((s) => s.id), ['data:normal', 'data:adult']);
  await api.uninstallSource('data:adult');
  await api.enableSetupNsfwSources();
  assert.deepEqual((await api.listSources()).sources.map((s) => s.id), ['data:normal']);
});

test('explicitly adding adult sources repairs older setup selections without removing other sources', async () => {
  catalogue = [{ id: 'data:normal' }, { id: 'data:adult', isNsfw: true }, { id: 'data:removed' }];
  await api.setInstalledSources(['data:normal']);
  await api.installNsfwSources();
  assert.deepEqual((await api.listSources()).sources.map((s) => s.id), ['data:normal', 'data:adult']);
  assert.equal(sourcePrefRows('u').find((r) => r.source_id === 'data:adult').is_enabled, true);
});

test('a direct reader details request loads adult source metadata before history can be recorded', async () => {
  catalogue = [{ id: 'data:adult', isNsfw: true }];
  await api.details('data:adult', '/series/a');
  assert.equal(api.isSourceNsfw('data:adult'), true);
  localStorage.setItem('nyora.prefs', JSON.stringify({ noNsfwHistory: true }));
  library.recordHistory({ manga: { id: 'adult-title', source: { name: 'data:adult' } }, sourceId: 'data:adult', sourceNsfw: api.isSourceNsfw('data:adult'), chapterId: 'ch1', page: 0 });
  assert.equal(library.exportData().history['adult-title'], undefined);
});

test('history privacy skips unknown source ratings but still records known safe sources', () => {
  localStorage.setItem('nyora.prefs', JSON.stringify({ noNsfwHistory: true }));
  library.recordHistory({ manga: { id: 'unknown', source: { name: 'data:unavailable' } }, sourceNsfw: api.isSourceNsfw('data:unavailable'), chapterId: 'ch1', page: 0 });
  assert.equal(library.exportData().history.unknown, undefined);
  library.recordHistory({ manga: { id: 'safe', source: { name: 'data:mangadex' } }, sourceNsfw: false, chapterId: 'ch1', page: 0 });
  assert.equal(library.exportData().history.safe.page, 0);
});
