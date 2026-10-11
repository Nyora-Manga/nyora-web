# Reader AI stability

Translation and colorization run locally and can exhaust a browser's memory even
though model downloads are small. These safeguards keep failures inside the AI
feature instead of automatically restarting it or reloading the reader.

- Translation serializes image fetch, decode and OCR. Queued pages that have left
  the viewport are skipped. Only a bounded cache of OCR/translation results stays
  in memory.
- Every OCR inference releases input/output tensors, including failures. Japanese
  OCR creates crops one batch at a time and retains only the newest decoder token's
  logits. Temporary canvases and bitmaps are released explicitly.
- Translated text is fitted again only when its content or width changes, not
  on every scroll event for every page. This avoids repeated synchronous layout
  work while scrolling a translated chapter.
- Turning AI off or leaving the reader terminates its worker, aborts image fetches,
  and cancels queued work. Models remain downloaded in persistent storage.
- Phones, touch devices and devices reporting 4 GB or less use one AI feature at a
  time. Enabling translation pauses colorization and vice versa. Unknown device
  memory uses this conservative budget. Worker capability flags come from the
  main thread because WorkerNavigator may omit touch/memory information.
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

## Verification

`npm test` includes cancellation during fetch, fast-scroll queue bounds, fatal
worker recovery, repeated OCR tensor accounting and service-worker updates.
`npm run test:colorizer` uses real worker/canvas paths with a constrained inference
double for CPU/GPU, mobile budgets, tall/oversized pages and model-load failures.
`npm run test:reader` covers local folders, CBZ, offline books, overlays, worker
cleanup, reload recovery and explicit re-enabling. `AI_MOBILE=1 npm run test:reader`
also checks mutual exclusion and restoration of the original page on touch devices.
`npm run test:overlay` checks scrolling, resizing and text changes.
These tests run before deployment.

Real ONNX colorization and Japanese OCR were also exercised in Chromium on a
synthetic lettered page. Browser emulation does not reproduce a physical phone's
OS memory limit. CPU-only inference remains hardware-dependent and is not instant;
this change does not introduce a larger model or a remote inference service.
