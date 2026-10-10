import { sourceId } from '../core/source-identity.js';

const routes = [
  ['library', 'Library', 'favourites favorites saved manga', '1'],
  ['discover', 'Discover', 'find manga recommendations', '2'],
  ['explore', 'Sources', 'browse sources explore extensions catalogue catalog', '3'],
  ['search', 'Search manga', 'all sources query', '4'],
  ['downloads', 'Downloads', 'offline chapters queue', '5'],
  ['history', 'History', 'reading history recently read', '6'],
  ['bookmarks', 'Bookmarks', 'saved pages', '7'],
  ['updates', 'Updates', 'new chapters', '8'],
  ['stats', 'Stats', 'reading statistics', '9'],
  ['local', 'Local files', 'offline imported comics', 'O'],
  ['settings', 'Settings', 'preferences appearance accounts reader', ','],
];
export function desktopRouteForShortcut(key) { return routes.find(([, , , shortcut]) => shortcut.toLowerCase() === key.toLowerCase())?.[0]; }
export function navigateDesktopRoute(router, route, document) {
  if (!routes.some(([id]) => id === route) || document.querySelector('#modalRoot .modal-backdrop')) return;
  router.navigate(route);
}
function contentKey(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 16384 || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('//')) return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
// Preserve exact stored parser keys. An unresolved chapter fingerprint is never
// guessed into a URL or looked up by a title match.
export function continueReadingTarget(services) {
  const state = services.snapshot();
  const row = state.history?.[0];
  if (!row) return null;
  const manga = state.favourites?.find(item => String(item.id) === String(row.mangaId));
  const source = row.sourceId || manga?.source?.name || manga?.source?.id;
  const url = row.mangaUrl || manga?.url;
  const chapter = row.chapterUrl || (typeof row.chapterId === 'string' && row.chapterId.includes('/') ? row.chapterId : undefined);
  if (!/^data:[A-Za-z0-9_.-]{1,200}$/.test(source || '') || !contentKey(url) || !contentKey(chapter)) return null;
  return { sid: source, url, chapterUrl: chapter };
}
export function createDesktopCommands({ router, services, files, navigation, focusSearch, showShortcuts }) {
  const row = (id, label, keywords, run, enabled = () => true, shortcut = '', section = 'Navigate') => Object.freeze({ id, label, keywords, run, enabled, shortcut, section });
  const importFiles = async kind => { const result = await files.select(kind); if (result?.books?.length) router.navigate('local'); return result; };
  return Object.freeze([
    row('continue-reading', 'Continue reading', 'resume latest chapter', () => {
      const target = continueReadingTarget(services); if (!target) throw new Error('Continue reading is not available yet. Open a chapter first.');
      router.navigate('reader', target);
    }, () => !!continueReadingTarget(services)),
    ...routes.map(([id, label, words, shortcut]) => row(id, label, words, () => router.navigate(id), undefined, shortcut)),
    row('back', 'Back', 'previous screen navigation', () => navigation.back()),
    row('forward', 'Forward', 'next screen navigation', () => navigation.forward()),
    row('focus-search', 'Focus search', 'find query manga', focusSearch, undefined, 'F'),
    row('import-comics', 'Import comic archives…', 'open cbz zip offline import', () => importFiles('files'), undefined, '', 'Files'),
    row('import-folder', 'Import image folder…', 'offline import directory', () => importFiles('folder'), undefined, '', 'Files'),
    row('shortcuts', 'Keyboard shortcuts', 'help controls reader keys', showShortcuts, undefined, '/', 'Help'),
  ]);
}
export function searchCommands(commands, query) {
  const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command => terms.every(term => `${command.label} ${command.keywords}`.toLocaleLowerCase().includes(term)));
}
// Read only the hydrated library. Never search a remote source while typing.
export function librarySearchCommands(services, router, query) {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().trim();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return (services.snapshot().favourites || []).flatMap((manga, index) => {
    const sid = sourceId(manga.sourceId || manga.source);
    if (!/^data:[A-Za-z0-9_.-]{1,200}$/.test(sid || '') || !contentKey(manga.url)) return [];
    const names = [manga.title, ...(Array.isArray(manga.altTitles) ? manga.altTitles : [])].map(normalize).join(' ');
    if (!terms.every(term => names.includes(term))) return [];
    return [{ id: 'library-title-' + index, label: manga.title || 'Untitled manga', section: 'Your library · ' + sid.slice(5),
      shortcut: '', enabled: () => true, run: () => router.navigate('details', { sid, url: manga.url }) }];
  }).slice(0, 20);
}
export async function runCommand(commands, id) {
  const command = commands.find(row => row.id === id);
  if (!command) throw new Error('Unknown command');
  if (!command.enabled()) throw new Error('This command is not available yet.');
  return command.run();
}
export function shortcutGroups(mac) {
  const modifier = mac ? '⌘' : 'Ctrl+';
  return [
    ['App', [['Search', modifier + 'K'], ['Focus search', modifier + 'F'], ['Keyboard shortcuts', modifier + '/'], ...routes.map(([, label,,key]) => [label, modifier + key]), ['Back / Forward', mac ? '⌘[ / ⌘]' : 'Alt+← / Alt+→']]],
    ['Reader', [['Turn pages', '← / → (RTL aware), ↑ / ↓'], ['Next / Previous chapter', 'N / P'], ['Fit page', 'F'], ['Auto-scroll', 'A'], ['Turn page / Webtoon auto-scroll', 'Space'], ['Auto-scroll faster / slower', '+ / −'], ['First / Last page', 'Home / End'], ['Original / Translation', 'T (when translation is active)'], ['Back to details', 'Esc']]],
  ];
}
