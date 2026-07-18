// screens/local.js — read local manga, fully client-side (no server).
//
// "Choose Folder" uses the File System Access API (ui.pickDirectory) to read a
// real local folder in the browser. Each immediate subfolder of images becomes a
// book; loose images at the root form one book; .cbz/.zip archives are unzipped
// in-browser (stored + deflate via DecompressionStream). Pages render from
// object URLs — nothing touches the network or a server filesystem.

import {
  el, $, toast, spinner, emptyState, errorBox, sectionHeader,
  btn, iconBtn, icon, chip, pickDirectory,
} from '../core/ui.js';

export const meta = {
  title: 'Local',
  nav: true,
  icon: 'folder',
  order: 50,
};

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const ARCHIVE_RE = /\.(cbz|zip)$/i;

// Session state: the scanned books, plus the object URLs to revoke on rescan.
let books = [];
let folderName = '';
let _urls = [];

function revokeUrls() {
  for (const u of _urls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  _urls = [];
}

export function render(view, _params) {
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

async function choose(view, body) {
  const picked = await pickDirectory();
  if (!picked) return; // cancelled / unsupported
  body.replaceChildren(centerSpinner());
  revokeUrls();
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
      out.push({ kind: 'archive', name: f.name.replace(ARCHIVE_RE, ''), file: f, pages: null });
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
  view.replaceChildren(centerSpinner());
  let pages;
  try {
    if (book.kind === 'images') {
      pages = book.files.map((f) => track(URL.createObjectURL(f)));
    } else {
      if (!book.pages) book.pages = (await unzipImages(book.file)).map(track);
      pages = book.pages;
    }
  } catch (err) {
    view.replaceChildren(sectionHeader(book.name, backBtn(view)),
      errorBox(`Couldn't open "${book.name}": ${err.message || err}`));
    return;
  }

  const header = sectionHeader(book.name, chip(`${pages.length} pages`), backBtn(view));
  view.replaceChildren(header);
  if (!pages.length) { view.appendChild(emptyState('This book has no readable pages.')); return; }

  const reader = el('div', { class: 'reader webtoon fit-width', style: { paddingBottom: '48px' } });
  for (let i = 0; i < pages.length; i++) {
    const img = el('img', { class: 'reader-page', loading: 'lazy', decoding: 'async', alt: `Page ${i + 1}`, src: pages[i] });
    img.addEventListener('error', () => {
      img.replaceWith(el('div', { class: 'reader-page', style: { background: 'var(--surface2)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px', borderRadius: 'var(--radius)' } }, icon('image')));
    });
    reader.appendChild(img);
  }
  view.appendChild(reader);
}

function track(url) { _urls.push(url); return url; }

// ---- in-browser ZIP/CBZ reader (stored + deflate) ----------------------

async function unzipImages(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // Find End Of Central Directory (signature 0x06054b50), scanning back.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (IMAGE_RE.test(name)) entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const urls = [];
  for (const e of entries) {
    // Local file header: 30 + nameLen + extraLen, then the data.
    const lnameLen = dv.getUint16(e.localOff + 26, true);
    const lextraLen = dv.getUint16(e.localOff + 28, true);
    const dataStart = e.localOff + 30 + lnameLen + lextraLen;
    const comp = buf.subarray(dataStart, dataStart + e.compSize);
    let bytes;
    if (e.method === 0) {
      bytes = comp; // stored
    } else if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([comp]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue; // unsupported compression
    }
    urls.push(URL.createObjectURL(new Blob([bytes])));
  }
  return urls;
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
    emptyState('Read offline — choose a folder of images or CBZ/ZIP archives. Everything stays on your device.'),
    btn('Choose Folder', { variant: 'accent', icon: 'folder', onClick: onChoose }),
  );
  return wrap;
}

function centerSpinner() { return el('div', { class: 'center', style: { padding: '48px 0' } }, spinner()); }
