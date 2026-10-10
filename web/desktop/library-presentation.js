import { continueReadingTarget } from './desktop-commands.js';
import api from '../core/api.js';
const nativeImageUrl = (url, headers) => url ? api.imageUrl(url, headers) : '';

// One snapshot ties the displayed title and saved position to the same exact
// chapter used by the existing Continue reading command.
export function libraryResumeModel(services) {
  if (!services?.snapshot) return null;
  const state = services.snapshot();
  const row = state.history?.[0];
  if (!row) return null;
  const manga = state.favourites?.find(item => String(item.id) === String(row.mangaId));
  const target = continueReadingTarget({ snapshot: () => state });
  let cover = '';
  try {
    cover = nativeImageUrl(row.mangaCoverUrl || manga?.coverUrl || manga?.largeCoverUrl,
      undefined, row.sourceId || manga?.source?.name || manga?.source?.id);
  } catch { /* A stale image must not prevent opening a saved chapter. */ }
  const page = Number.isInteger(row.page) && row.page >= 0 ? row.page + 1 : null;
  const total = Number.isInteger(row.total) && row.total >= page && row.total > 0 ? row.total : null;
  return {
    target, cover, title: row.mangaTitle || manga?.title || 'Recently read title',
    chapter: row.chapterTitle || 'Saved chapter',
    position: page === null ? '' : total ? `Page ${page} of ${total}` : `Page ${page}`,
  };
}

export function createLibraryResume({ services, el, btn, icon, router }) {
  const model = libraryResumeModel(services);
  if (!model) return null;
  const artwork = el('div', { class: 'library-resume-art', 'aria-hidden': 'true' }, icon('book'));
  if (model.cover) artwork.appendChild(el('img', {
    src: model.cover, alt: '', loading: 'eager', referrerpolicy: 'no-referrer',
    onError: event => { event.target.hidden = true; },
  }));
  return el('section', { class: 'library-resume', 'aria-label': 'Continue reading' },
    artwork,
    el('div', { class: 'library-resume-copy' },
      el('span', { class: 'library-resume-label' }, 'Continue reading'),
      el('h2', null, model.title),
      el('p', { class: 'library-resume-progress' }, [model.chapter, model.position].filter(Boolean).join(' · '))),
    btn(model.target ? 'Resume chapter' : 'View history', { variant: 'accent', onClick: () => {
      // Revalidate at activation in case history changed while this screen was open.
      const target = continueReadingTarget(services);
      if (model.target && target && JSON.stringify(target) === JSON.stringify(model.target)) router.navigate('reader', target);
      else router.navigate('history');
    } }));
}

export async function importLibraryComics({ files, router, toast }) {
  try {
    if (!files?.select) throw new Error('Comic import is unavailable.');
    const result = await files.select('files');
    if (result?.books?.length) router.navigate('local');
  } catch (error) { toast(error.message || 'Could not import comics.'); }
}
