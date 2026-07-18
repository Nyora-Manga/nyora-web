// core/translate/overlay.js — draws translated blocks over a reader page, the
// web equivalent of Android's TranslationOverlayView: no inpainting, each
// bubble is repainted with an opaque rounded rect in its sampled background
// colour and the translated text is auto-sized to fit inside it.
//
// The overlay is an absolutely-positioned sibling of the <img> (its parent —
// .reader.webtoon / .reader-slide — is position:relative), synced to the
// image's layout box with a ResizeObserver. Blocks are placed in % of the
// image's natural size, so panning/scrolling/resizing is free; only the font
// fitting needs recomputing when the displayed size changes.

function textColorFor(bg) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg || '');
  if (!m) return '#111';
  const lum = 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3];
  return lum < 128 ? '#fff' : '#111';
}

export function attachOverlay(img) {
  const parent = img.closest('.reader-slide') || img.parentElement;
  const ov = document.createElement('div');
  ov.className = 'tl-overlay';
  parent.appendChild(ov);

  let blocks = [];
  let texts = null;
  let natW = 1;
  let natH = 1;

  function sync() {
    if (!img.isConnected) return;
    ov.style.left = img.offsetLeft + 'px';
    ov.style.top = img.offsetTop + 'px';
    ov.style.width = img.offsetWidth + 'px';
    ov.style.height = img.offsetHeight + 'px';
    fitAll();
  }

  const ro = new ResizeObserver(sync);
  ro.observe(img);

  // In webtoon mode the ResizeObserver only fires when THIS image's own box
  // changes; when a sibling page above reflows it shifts our offsetTop without
  // resizing us, so the observer never fires and the bubbles drift. Re-sync on
  // scroll of the webtoon scroll container (throttled to one call per frame)
  // and on window resize.
  const scrollTarget =
    img.closest('.reader.webtoon') || img.closest('.reader') || window;
  let rafPending = 0;
  function onScroll() {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      sync();
    });
  }
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', sync);

  function renderBlocks() {
    ov.replaceChildren();
    blocks.forEach((b, i) => {
      const t = texts && texts[i];
      const d = document.createElement('div');
      d.className = 'tl-block' + (t ? '' : ' tl-pending');
      d.style.left = (b.x / natW) * 100 + '%';
      d.style.top = (b.y / natH) * 100 + '%';
      d.style.width = (b.w / natW) * 100 + '%';
      d.style.height = (b.h / natH) * 100 + '%';
      if (t) {
        d.style.background = b.bg;
        // Soft edge in place of Android's BlurMaskFilter.
        d.style.boxShadow = `0 0 6px 4px ${b.bg}`;
        d.style.color = textColorFor(b.bg);
        d.textContent = t;
      }
      d.__block = b;
      ov.appendChild(d);
    });
  }

  // Typeset each block to the largest font that actually fits the bubble in
  // BOTH dimensions. We binary-search on measured overflow instead of guessing
  // from glyph widths, so it's language-agnostic: it copes with space-separated
  // Latin, space-less CJK (Chinese/Japanese/Korean targets, where the old
  // longest-word heuristic collapsed the text to the floor), single short
  // words in huge bubbles, long unbreakable strings, and many-line paragraphs
  // in tiny bubbles — every case converges to the true best fit.
  function fits(d) {
    return d.scrollHeight <= d.clientHeight + 1 && d.scrollWidth <= d.clientWidth + 1;
  }
  function fitAll() {
    if (!texts) return;
    const scale = (ov.clientWidth || 1) / natW || 1;
    const MIN = 6; // readable floor; smaller than this is clipped by overflow:hidden
    for (const d of ov.children) {
      const b = d.__block;
      if (!b || !d.textContent) continue;
      const boxW = b.w * scale;
      const boxH = b.h * scale;
      if (boxW < 1 || boxH < 1) continue;
      // Upper bound: a single line can't exceed the box height; cap keeps very
      // large bubbles from ballooning. Never below the floor.
      const hi0 = Math.max(MIN, Math.min(64, boxH * 0.92));
      let lo = MIN, hi = hi0, best = MIN;
      // Words are unbreakable by default (see .tl-block) so the search shrinks
      // to fit whole words instead of hyphenating them. Reset per pass: a
      // previous fit at a narrower zoom may have turned breaking on.
      d.style.overflowWrap = 'normal';
      d.style.fontSize = hi0 + 'px';
      if (fits(d)) { best = hi0; } // common case: it already fits at the cap
      else {
        for (let i = 0; i < 12 && hi - lo > 0.4; i++) {
          const mid = (lo + hi) / 2;
          d.style.fontSize = mid + 'px';
          if (fits(d)) { best = mid; lo = mid; } else { hi = mid; }
        }
      }
      d.style.fontSize = best.toFixed(1) + 'px';
      // Last resort: a single word wider than the bubble even at the floor
      // (a URL, a long compound). Breaking it is ugly, but silently clipping
      // it to overflow:hidden is worse — the reader would lose the word.
      if (!fits(d)) d.style.overflowWrap = 'anywhere';
    }
  }

  // Android-style page status pill (top-right of the page): OCR progress
  // counts while bubbles are being read, then "Translating…".
  let pill = null;
  function setProgress(progress) {
    if (!progress) {
      if (pill) { pill.remove(); pill = null; }
      return;
    }
    if (!pill || !pill.isConnected) {
      pill = document.createElement('div');
      pill.className = 'tl-progress';
      ov.appendChild(pill);
    }
    pill.textContent = progress.stage === 'refine'
      ? 'Refining with AI…'
      : progress.stage === 'translate'
        ? 'Translating…'
        : (progress.total ? `Reading text ${progress.done}/${progress.total}…` : 'Finding text…');
  }

  return {
    setBlocks(b, t, progress) {
      blocks = b || [];
      texts = t;
      natW = img.naturalWidth || 1;
      natH = img.naturalHeight || 1;
      renderBlocks();
      sync();
      setProgress(progress || null); // engine sends explicit stage/null
    },
    destroy() {
      ro.disconnect();
      scrollTarget.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', sync);
      if (rafPending) cancelAnimationFrame(rafPending);
      ov.remove();
    },
  };
}
