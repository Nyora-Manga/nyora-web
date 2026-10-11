// OCR and colorization share a single heavy inference lane. Switching tools
// releases the previous worker's model memory while keeping its page results.
let queue = Promise.resolve();
let owner = null;
let idleTimer = null;

export function runSharedInference(kind, release, task, { signal, shouldProcess } = {}) {
  const result = queue.then(async () => {
    signal?.throwIfAborted();
    if (shouldProcess && !shouldProcess()) throw new DOMException('Page left the reader window', 'AbortError');
    clearTimeout(idleTimer);
    if (owner?.kind !== kind) {
      owner?.release();
      owner = { kind, release };
    }
    const current = owner;
    const abort = () => { current.release(); if (owner === current) owner = null; };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await task();
    } finally {
      signal?.removeEventListener('abort', abort);
      // Do not leave a model resident indefinitely when reading stops.
      idleTimer = setTimeout(() => {
        if (owner === current) { current.release(); owner = null; }
      }, 5000);
      idleTimer?.unref?.(); // Node test runners need not wait for browser-idle cleanup.
    }
  });
  queue = result.catch(() => {});
  return result;
}
