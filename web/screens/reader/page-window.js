// Keep a bounded set of decoded images in every reader. Native loading="lazy"
// delays downloads but doesn't release pages after a long reading session.
const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function createPageWindow({ createImage, onRelease = () => {}, radius = 1 }) {
  const active = new Map();

  function placeholder(page, index, ratio) {
    const node = document.createElement('div');
    node.className = 'reader-page';
    node.dataset.page = String(index);
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', `Page ${index + 1}`);
    if (ratio) node.style.aspectRatio = ratio;
    node.__loadPage = () => {
      const img = createImage(page, index);
      img.loading = 'eager';
      if (ratio) img.style.aspectRatio = ratio;
      node.replaceWith(img);
      active.set(index, { img, page, ratio });
    };
    return node;
  }

  function release(index, entry, keepSlot) {
    const { img, page, ratio } = entry;
    onRelease(img);
    const measured = img.naturalWidth && img.naturalHeight
      ? `${img.naturalWidth} / ${img.naturalHeight}` : ratio;
    if (keepSlot && img.isConnected) img.replaceWith(placeholder(page, index, measured));
    // Release/cancel the original resource without invoking its error fallback.
    img.src = EMPTY_IMAGE;
    active.delete(index);
  }

  return {
    slot: (page, index) => placeholder(page, index, ''),
    update(root, center) {
      // Release before loading, so page jumps cannot double the live image set.
      for (const [index, entry] of active) {
        if (Math.abs(index - center) > radius || !entry.img.isConnected) release(index, entry, true);
      }
      for (const node of root.querySelectorAll('.reader-page[data-page]')) {
        if (Math.abs(Number(node.dataset.page) - center) <= radius) node.__loadPage?.();
      }
    },
    clear() { for (const [index, entry] of active) release(index, entry, false); },
  };
}
