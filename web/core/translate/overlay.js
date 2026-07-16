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

  // findBestFitLayout, webified: start at 0.34 × displayed block height,
  // capped so the longest word fits the block width (Android's
  // WIDTH_FILL_TARGET_RATIO — avoids mid-word breaks in tall narrow bubbles),
  // then shrink until the text no longer overflows the box.
  function fitAll() {
    if (!texts) return;
    const scale = (ov.clientWidth || 1) / natW;
    for (const d of ov.children) {
      const b = d.__block;
      if (!b || !d.textContent) continue;
      const longest = d.textContent.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 1);
      const maxByWidth = (b.w * scale * 0.96) / (longest * 0.6); // ~0.6em avg glyph width
      let fs = Math.max(9, Math.min(40, b.h * scale * 0.34, maxByWidth));
      d.style.fontSize = fs + 'px';
      let guard = 34;
      while (guard-- > 0 && fs > 7 &&
             (d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1)) {
        fs -= 1;
        d.style.fontSize = fs + 'px';
      }
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
      ov.remove();
    },
  };
}
