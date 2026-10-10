// Data adapters for the shared Electron presentation. Browser storage remains
// authoritative; no native bridge or second copy of the user's library is used.
import library from '../core/library.js';
import { store } from '../core/store.js';
import { sourceId } from '../core/source-identity.js';

export const browserLibrary = {
  snapshot() {
    const data = library.exportData();
    let readMarks = {};
    try { readMarks = JSON.parse(localStorage.getItem('nyora.read.marks.v1') || '{}'); } catch {}
    return {
      favourites: Object.values(data.favourites || {}).map(row => ({ ...row.manga, libraryAddedAt: row.addedAt })),
      history: library.history().entries.map(row => ({ ...row,
        mangaId: row.manga?.id, mangaUrl: row.manga?.url, mangaTitle: row.manga?.title,
        mangaCoverUrl: row.manga?.coverUrl || row.manga?.largeCoverUrl,
        sourceId: sourceId(row.sourceId || row.manga?.source),
      })),
      updates: library.updates().entries || [],
      readMarks,
    };
  },
};

export const browserFiles = {
  async select(kind) {
    const { selectLocalFiles } = await import('../screens/local.js');
    return selectLocalFiles(kind);
  },
};

export const browserPreferences = {
  uiPreferences: () => store.get(),
  async mutate(operation, build) {
    if (operation !== 'ui.preferences.save') throw new Error('Unknown preference action');
    return store.set(build().patch);
  },
};
