// screens/local.js — read local manga, fully client-side (no server).
//
// "Choose Folder" uses the File System Access API (ui.pickDirectory) to read a
// real local folder in the browser. Each immediate subfolder of images becomes a
// book; loose images at the root form one book; .cbz/.zip archives are unzipped
// in-browser (stored + deflate via DecompressionStream). Pages render from
// object URLs. The shared reader also supplies translation and colorization.

import {
  el, spinner, emptyState, errorBox, sectionHeader,
  btn, iconBtn, icon, pickDirectory,
} from '../core/ui.js';
import { router } from '../core/store.js';
import { createLocalReader } from '../core/local-reader.js';
import { unzipImages } from '../core/zip.js';

export const meta = {
  title: 'Local',
  nav: true,
  icon: 'folder',
  order: 50,
};

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const ARCHIVE_RE = /\.(cbz|zip)$/i;

// Picked files stay available until another folder is selected or the tab closes.
let books = [];
let folderName = '';

export function render(view, _params) {
  if (matchMedia('(min-width:761px)').matches) return renderDesktop(view);
  view.replaceChildren();

  const chooseBtn = btn('Choose Folder', {
    variant: 'accent', icon: 'folder', onClick: () => choose(view, body),
  });
  const header = sectionHeader('Local', chooseBtn);
  const body = el('div', { class: 'local-body' });
  view.append(header, body);

  if (books.length) {
    renderBooks(view, body);
  } else {
    body.replaceChildren(cta(() => choose(view, body)));
  }
}

export async function selectLocalFiles(kind = 'folder') {
  let picked;
  if (kind === 'folder') picked = await pickDirectory();
  else {
    const files = await new Promise(resolve => {
      const input = el('input', { type: 'file', accept: '.cbz,.zip', multiple: true, hidden: true });
      const finish = files => { input.remove(); resolve(files); };
      input.addEventListener('change', () => finish([...input.files]), { once: true });
      input.addEventListener('cancel', () => finish([]), { once: true });
      document.body.append(input); input.click();
    });
    if (files.length) picked = { name: 'Imported comics', files };
  }
  if (!picked) return { cancelled: true, books: [] };
  folderName = picked.name || 'Imported comics';
  books = await buildBooks(picked.files);
  return { cancelled: false, books };
}

function renderDesktop(view) {
  const body = el('div', { class: 'local-body' });
  const status = el('p', { role: 'status' });
  const select = async (kind, control) => {
    control.disabled = true;
    try { const result = await selectLocalFiles(kind); if (!result.cancelled) paint(); }
    catch (error) { status.textContent = error.message; }
    finally { control.disabled = false; }
  };
  const folder = btn('Choose folder', { variant: 'accent', icon: 'folder', onClick: () => select('folder', folder) });
  const archive = btn('Open archive', { variant: 'ghost', onClick: () => select('archive', archive) });
  view.replaceChildren(sectionHeader('Local', folder, archive), status, body);
  function paint() {
    if (!books.length) { body.replaceChildren(emptyState('Choose a folder of images or CBZ/ZIP archives to read offline.')); return; }
    const list = el('div', { class: 'list' });
    for (const book of books) list.append(el('div', { class: 'row-item' },
      el('div', { class: 'row-main' }, el('div', { class: 'name' }, book.name),
        el('div', { class: 'sub' }, book.kind === 'images' ? `${book.files.length} pages` : 'Comic archive')),
      el('div', { class: 'row-actions' }, btn('Read', { variant: 'ghost', onClick: () => openBook(view, book) }))));
    body.replaceChildren(list);
  }
  paint();
}

async function choose(view, body) {
  const picked = await pickDirectory();
  if (!picked) return; // cancelled / unsupported
  body.replaceChildren(centerSpinner());
  books = [];
  folderName = picked.name || 'Folder';
  try {
    books = await buildBooks(picked.files);
  } catch (err) {
    body.replaceChildren(errorBox(`Couldn't read this folder: ${err.message || err}`));
    return;
  }
  if (!books.length) {
    body.replaceChildren(emptyState('No images or CBZ/ZIP archives found in that folder.'));
    return;
  }
  renderBooks(view, body);
}

// Group picked files into books: one per immediate subfolder of images, one for
// loose root images, and one per archive (lazily unzipped on open).
async function buildBooks(files) {
  const out = [];
  const folders = new Map(); // top-level dir -> File[]
  const rootImages = [];

  for (const f of files) {
    const rel = (f._relpath || f.name).replace(/^\/+/, '');
    if (ARCHIVE_RE.test(f.name)) {
      out.push({ kind: 'archive', name: f.name.replace(ARCHIVE_RE, ''), file: f });
      continue;
    }
    if (!IMAGE_RE.test(f.name)) continue;
    const parts = rel.split('/');
    if (parts.length <= 1) {
      rootImages.push(f);
    } else {
      const top = parts.slice(0, -1).join('/');
      if (!folders.has(top)) folders.set(top, []);
      folders.get(top).push(f);
    }
  }

  for (const [name, imgs] of folders) {
    imgs.sort(byNaturalName);
    out.push({ kind: 'images', name: name.split('/').pop() || name, files: imgs });
  }
  if (rootImages.length) {
    rootImages.sort(byNaturalName);
    out.unshift({ kind: 'images', name: folderName, files: rootImages });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

function byNaturalName(a, b) {
  return (a._relpath || a.name).localeCompare(b._relpath || b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function renderBooks(view, body) {
  body.replaceChildren(folderHint(folderName));
  const list = el('div', { class: 'list' });
  for (const book of books) list.appendChild(bookRow(view, book));
  body.appendChild(list);
}

function bookRow(view, book) {
  const count = book.kind === 'images' ? book.files.length : null;
  const open = () => openBook(view, book);
  const item = el('div', { class: 'row-item', role: 'button', tabindex: '0' },
    el('div', { class: 'thumb', style: { display: 'grid', placeItems: 'center' } },
      icon(book.kind === 'archive' ? 'download' : 'folder')),
    el('div', { class: 'row-main' },
      el('div', { class: 'name', title: book.name }, book.name),
      el('div', { class: 'sub' }, book.kind === 'archive' ? 'Archive · tap to open' : `${count} page${count === 1 ? '' : 's'}`),
    ),
    el('div', { class: 'row-actions' }, icon('chevron')),
  );
  item.addEventListener('click', open);
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return item;
}

async function openBook(view, book) {
  const loading = centerSpinner();
  view.replaceChildren(loading);
  let pages;
  try {
    if (book.kind === 'images') {
      pages = book.files;
    } else {
      pages = (await unzipImages(book.file)).map(e => new Blob([e.bytes]));
    }
  } catch (err) {
    if (!loading.isConnected) return;
    view.replaceChildren(sectionHeader(book.name, backBtn(view)),
      errorBox(`Couldn't open "${book.name}": ${err.message || err}`));
    return;
  }

  if (!loading.isConnected) return;
  if (!pages.length) {
    view.replaceChildren(sectionHeader(book.name, backBtn(view)), emptyState('This book has no readable pages.'));
    return;
  }
  book.readerState ||= {};
  router.navigate('reader', createLocalReader({ title: book.name, pages, state: book.readerState }));
}

// ---- small building blocks ---------------------------------------------

function backBtn(view) { return iconBtn('back', () => render(view), 'Back to files'); }

function folderHint(name) {
  return el('div', { class: 'sub', style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 16px' }, title: name },
    icon('folder'),
    el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
  );
}

function cta(onChoose) {
  const wrap = el('div', { class: 'center', style: { flexDirection: 'column', gap: '14px', padding: '48px 0' } });
  wrap.append(
    emptyState('Read offline — choose a folder of images or CBZ/ZIP archives. Images stay on your device. Optional translation sends recognized text to your translation provider.'),
    btn('Choose Folder', { variant: 'accent', icon: 'folder', onClick: onChoose }),
  );
  return wrap;
}

function centerSpinner() { return el('div', { class: 'center', style: { padding: '48px 0' } }, spinner()); }
