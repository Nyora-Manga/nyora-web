// Local pages live only for the active reading session. The URL contains an
// opaque handle, never a filename, page blob URL, or a remote source identity.
const sessions = new Map();

export function createLocalReader({ title, chapterTitle = title, pages, back = 'local', state = {} }) {
  if (!pages?.length || pages.some(page => !(page instanceof Blob))) {
    throw new Error('This book has no readable pages.');
  }
  const id = crypto.randomUUID();
  const url = `local:${id}`;
  const session = {
    state,
    back: back === 'downloads' ? 'downloads' : 'local',
    details: { manga: { id: url, url, title }, chapters: [{ url, title: chapterTitle }] },
    pages: [],
    dispose() {
      for (const page of session.pages) URL.revokeObjectURL(page.url);
      session.pages = [];
      sessions.delete(id);
    },
  };
  try {
    for (const page of pages) session.pages.push({ url: URL.createObjectURL(page) });
  } catch (error) {
    session.dispose();
    throw error;
  }
  sessions.set(id, session);
  return { local: id, back: session.back };
}

export function getLocalReader(id) { return sessions.get(id) || null; }
