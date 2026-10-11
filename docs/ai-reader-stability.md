# Reader AI stability

Translation and colorization run locally and can exhaust a browser's memory even
though model downloads are small. The browser can kill a tab before JavaScript
can handle an allocation failure.
Both tools remain available on mobile and desktop, with a three-page reader
window and one shared inference lane to reduce memory pressure.

- Translation serializes image fetch, decode and OCR. Queued pages that have left
  the three-page window are skipped. Only a bounded cache of OCR/translation results stays
  in memory.
- Every OCR inference releases input/output tensors, including failures. Japanese
  OCR creates crops one batch at a time and retains only the newest decoder token's
  logits. Temporary canvases and bitmaps are released explicitly.
- Translated text is fitted again only when its content or width changes, not
  on every scroll event for every page. This avoids repeated synchronous layout
  work while scrolling a translated chapter.
- Turning AI off or leaving the reader terminates its worker, aborts image fetches,
  and cancels queued work. Models remain downloaded in persistent storage.
- Translation and colorization can both stay enabled. They share a serialized
  fetch/decode/inference lane on every device. Before switching tools, the previous
  worker is terminated; completed page results remain usable. Five idle seconds
  release the remaining worker. Model files stay in persistent storage and are
  loaded from that cache when needed, without another download.
- Phone OCR batches contain two crops; desktop batches retain eight. Phone
  colorizer inference is limited to 256 × 768 model pixels. Full output dimensions
  and original luminance are preserved for accepted pages.
- Inputs above eight million pixels or 16,384 pixels on either side fail safely
  with the original page available. This is a deliberate limit, not automatic
  low-resolution processing of long strips.
- An AI failure pauses that feature. A fatal colorizer allocation is not retried
  immediately with the same page. Memory failures do not evict cached models.
- A session marker prevents interrupted AI from automatically restarting after
  a browser reload. The reader remains available; AI can be enabled explicitly.
  The marker stores no book identity or image data.
- Service-worker updates notify users instead of calling `location.reload()`.
  Both worker URLs are versioned with their bundled content hash.

## Mobile crash mitigation

- All readers mount at most three page images: the current page and one neighbour
  on either side. Distant images become placeholders preserving their known aspect
  ratio. Leaving the window aborts that page's inference/fetch, removes its overlay,
  revokes its colour result and releases its displayed image resource. Returning
  or jumping loads the needed pages again. This covers webtoon, horizontal, RTL
  and vertical readers. Native lazy loading alone previously left visited images
  attached to the chapter.
- Colorization replaces the existing image's source. Translation is drawn on that
  same page; enabling either tool no longer switches the other off. Colour results
  and each translation-result cache are limited to three entries.
- Chapter metadata prefetch retains at most three lists.
- Model storage usage reads cached response headers, never full model blobs.
  Missing size metadata shows a file count instead.

## Verification

`npm test` includes cancellation during fetch, fast-scroll queue bounds, fatal
worker recovery, repeated OCR tensor accounting and service-worker updates.
`npm run test:colorizer` uses real worker/canvas paths with a constrained inference
double for CPU/GPU, mobile budgets, tall/oversized pages and model-load failures.
`npm run test:reader` covers local folders, CBZ, offline books, overlays, worker
cleanup, reload recovery and explicit re-enabling. `AI_MOBILE=1 npm run test:reader`
also checks combined translation/colorization with at most one resident worker on touch devices.
`npm run test:overlay` checks scrolling, resizing and text changes.
These tests run before deployment.

Real ONNX colorization and Japanese OCR were also exercised in Chromium on a
synthetic lettered page. Browser emulation does not reproduce a physical phone's
OS memory limit. CPU-only inference remains hardware-dependent and is not instant;
this change does not introduce a larger model or a remote inference service.

`npm run test:mobile-stability` checks 100-page chapters across all reader modes,
backwards navigation, combined AI, worker counts, blob cleanup, and model-size
reporting without reading model bodies. This is a
Chromium mobile emulation test, not proof against every physical device OOM.
