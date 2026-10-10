import { test } from 'node:test';
import assert from 'node:assert/strict';

const catalogue = [{ id: 'data:mangadex' }, { id: 'data:asurascans' }, { id: 'data:webtoons' }];
test('bounded migration rewrites source references without changing opaque manga/chapter IDs or progress', async () => {
  const { migrateLibrarySources } = await import('../web/core/source-migration.js');
  const original = { favourites: { '9223372036854775806': { manga: { id: '9223372036854775806', source: { name: 'DD_MANGADEX' }, url: '/a' }, addedAt: 50 } },
    history: { '9223372036854775806': { sourceId: 'parser:MANGADEX', manga: { id: '9223372036854775806', source: { name: 'JS_MANGADEX' } }, chapterId: '999999999999999', page: 5, updatedAt: 80 } },
    bookmarks: [], prefs: { '9223372036854775806': { mode: 'RTL' } }, categoryMembers: { c: { '9223372036854775806': true } } };
  const actual = migrateLibrarySources(original, catalogue);
  assert.equal(actual.favourites['9223372036854775806'].manga.source.name, 'data:mangadex');
  assert.equal(actual.history['9223372036854775806'].sourceId, 'data:mangadex');
  assert.equal(actual.history['9223372036854775806'].chapterId, '999999999999999');
  assert.equal(actual.history['9223372036854775806'].page, 5);
  assert.deepEqual(actual.prefs, original.prefs);
  assert.deepEqual(actual.categoryMembers, original.categoryMembers);
  assert.equal(original.history['9223372036854775806'].sourceId, 'parser:MANGADEX');
  assert.deepEqual(migrateLibrarySources(actual, catalogue), actual);
});
test('migration rekeys URL-based records and dependencies and retains unresolved records', async () => {
  const { migrateLibrarySources } = await import('../web/core/source-migration.js');
  const old = 'parser:ASURASCANS_US|/series/a';
  const next = 'data:asurascans|/series/a';
  const original = { favourites: { [old]: { manga: { source: 'parser:ASURASCANS_US', url: '/series/a' }, addedAt: 1 },
    unknown: { manga: { id: 'unknown', source: 'parser:NO_SUCH_SOURCE' } } }, history: {},
    bookmarks: [{ mangaId: old, sourceId: 'parser:ASURASCANS_US', manga: { source: 'parser:ASURASCANS_US', url: '/series/a' }, chapterId: 'c1' }],
    prefs: { [old]: { mode: 'RTL' } }, snapshots: { [old]: { sourceId: 'parser:ASURASCANS_US' } }, categoryMembers: { c: { [old]: true } } };
  const actual = migrateLibrarySources(original, catalogue);
  assert.equal(actual.favourites[next].manga.source.name, 'data:asurascans');
  assert.equal(actual.bookmarks[0].mangaId, next);
  assert.deepEqual(actual.prefs[next], { mode: 'RTL' });
  assert.equal(actual.categoryMembers.c[next], true);
  assert.equal(actual.snapshots[next].sourceId, 'data:asurascans');
  assert.deepEqual(actual.favourites.unknown, original.favourites.unknown);
});
test('legacy conversion is catalogue-backed and canonical unknown IDs remain recoverable', async () => {
  const { migrateSourceId } = await import('../web/core/source-migration.js');
  assert.equal(migrateSourceId('JS_data:WEBTOONS', catalogue), 'data:webtoons');
  assert.equal(migrateSourceId('{"name":"DD_MANGADEX"}', catalogue), 'data:mangadex');
  assert.equal(migrateSourceId('parser:ASURASCANS_US', catalogue), 'data:asurascans');
  assert.equal(migrateSourceId('parser:NO_SUCH_SOURCE', catalogue), '');
  assert.equal(migrateSourceId('data:unavailable', catalogue), 'data:unavailable');
  assert.equal(migrateSourceId('parser:bad/id', catalogue), '');
});

test('known retired data aliases migrate only to a catalogue-backed successor', async () => {
  const { migrateSourceId } = await import('../web/core/source-migration.js');
  assert.equal(migrateSourceId('data:asurascans_us', catalogue), 'data:asurascans');
  assert.equal(migrateSourceId('data:asurascans_us', []), 'data:asurascans_us');
  assert.equal(migrateSourceId({ name: JSON.stringify({ name: 'DD_MANGADEX' }) }, catalogue), 'data:mangadex');
});
