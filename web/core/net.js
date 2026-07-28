// core/net.js — the networking primitives the app shares: how hard to push, how
// long to wait before trying again, when to stop trying, and how not to ask the
// same question twice at once.
//
// The constraints these exist for are real and specific:
//
//   • ONE small VM serves every synced user. 133 accounts on a fixed 60s timer
//     is a herd — and a herd that RE-FORMS after every blip, because everyone
//     who failed retries on the same schedule. Backoff without jitter does not
//     spread a herd; it preserves it.
//   • Page images come from scraper CDNs of wildly varying quality over links
//     of wildly varying quality. A concurrency number picked in advance is
//     wrong twice: too low on fibre, too high on tethered 3G, where extra
//     parallelism only builds a queue and makes every image slower.
//   • A budget laptop is the CPU floor. Everything here is arithmetic on
//     completion — no timers per request, no polling.
//
// Nothing here knows about fetch(); they are policies, and the call sites
// supply the I/O.

// ---- decorrelated jitter ------------------------------------------------
//
// The backoff schedule from AWS's "Exponential Backoff and Jitter". Plain
// exponential backoff keeps a herd in lockstep — every client that failed
// together waits the same 1s, 2s, 4s and collides again, which is exactly the
// pattern that turns one bad minute on a single VM into ten. Decorrelated
// jitter draws from a window that grows with the LAST sleep, so retries spread
// out instead of stacking, while the expected delay still climbs.
//
//   sleep = min(cap, uniform(base, prev * 3))
export function decorrelatedJitter(base, cap, prev) {
  const low = Math.max(1, base);
  const high = Math.max(low, Math.min(cap, (prev || low) * 3));
  return Math.floor(low + Math.random() * (high - low));
}

/** A jittered interval: `period` ± `spread` (fraction). Keeps timers from aligning. */
export function jitteredPeriod(period, spread = 0.25) {
  const delta = period * spread;
  return Math.max(0, Math.round(period - delta + Math.random() * delta * 2));
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { cleanup(); resolve(); }
  function onAbort() { cleanup(); reject(signal.reason || new Error('aborted')); }
  function cleanup() {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (signal) {
    if (signal.aborted) { cleanup(); reject(signal.reason || new Error('aborted')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

/**
 * Run `attempt(i)` until it succeeds or the budget runs out.
 *
 * `shouldRetry(error, i)` decides what is worth repeating — the default retries
 * nothing, because retrying a 404 or a bad request is just load. An aborted
 * signal always wins immediately: a user who navigated away must not be kept
 * waiting by a backoff sleep.
 */
export async function withRetry(attempt, {
  attempts = 3,
  baseMs = 250,
  capMs = 8_000,
  shouldRetry = () => false,
  signal = null,
  onRetry = null,
} = {}) {
  let wait = baseMs;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (signal && signal.aborted) throw signal.reason || new Error('aborted');
    try {
      return await attempt(i);
    } catch (error) {
      lastError = error;
      if (signal && signal.aborted) throw error;
      if (i === attempts - 1 || !shouldRetry(error, i)) throw error;
      wait = decorrelatedJitter(baseMs, capMs, wait);
      if (onRetry) { try { onRetry(error, i, wait); } catch { /* reporting must not break the retry */ } }
      await sleep(wait, signal);
    }
  }
  throw lastError;
}

// ---- adaptive concurrency ----------------------------------------------
//
// A gradient limiter, after TCP Vegas and Netflix's concurrency-limits. The
// insight both share: you cannot know the right concurrency in advance, but you
// can MEASURE it, because queueing announces itself as latency. The shortest
// round trip ever seen is roughly the no-queue service time; when live requests
// take longer than that, the extra is time spent waiting in a queue somewhere —
// in the browser's socket pool, in the network, at the origin — and adding more
// parallelism to a queue makes every request slower without finishing any more
// of them.
//
//   gradient  = minRtt / recentRtt        (1 = no queue, → 0 = deep queue)
//   newLimit  = limit * gradient + sqrt(limit)
//
// The sqrt term is the probe: it lets the limit climb while there is headroom,
// at a rate that slows as the limit grows. Errors and timeouts skip the
// arithmetic and halve the limit — that is a signal about capacity, not
// latency, and it deserves the multiplicative-decrease response.
//
// minRtt decays back upward periodically, or a single lucky-fast sample early
// on would define "no queue" forever and hold the limit at the floor.
export class AdaptiveLimiter {
  constructor({ min = 1, max = 12, start = 4, smoothing = 0.2, minRttWindowMs = 30_000 } = {}) {
    this.min = min;
    this.max = max;
    this.limit = Math.min(max, Math.max(min, start));
    this.smoothing = smoothing;
    this.minRttWindowMs = minRttWindowMs;
    this.inFlight = 0;
    this.minRtt = Infinity;
    this.minRttAt = 0;
    this.waiters = [];
    this.samples = 0;
  }

  /** Resolves when a slot is free; the caller MUST call the returned release(). */
  acquire() {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => { this.inFlight++; resolve(() => this.#release()); });
    });
  }

  /** Wrap one request: measures it, adjusts the limit, always frees the slot. */
  async run(task) {
    const release = await this.acquire();
    const startedAt = now();
    try {
      const value = await task();
      this.recordSuccess(now() - startedAt);
      return value;
    } catch (error) {
      // A cancelled request says nothing about capacity — it never competed.
      if (isAbortLike(error)) this.recordIgnored();
      else this.recordFailure();
      throw error;
    } finally {
      release();
    }
  }

  recordSuccess(rttMs) {
    this.samples++;
    const rtt = Math.max(1, rttMs);
    const stale = this.minRttAt && (now() - this.minRttAt) > this.minRttWindowMs;
    if (rtt < this.minRtt || stale) {
      this.minRtt = stale ? Math.min(rtt, this.minRtt * 2) : rtt;
      this.minRttAt = now();
    }

    // Only a saturated limiter has evidence about the limit. Raising it while
    // slots sit idle would chase a number nothing is asking for.
    if (this.inFlight < this.limit) return;

    const gradient = Math.max(0.5, Math.min(1, this.minRtt / rtt));
    const target = this.limit * gradient + Math.sqrt(this.limit);
    this.#setLimit(this.limit * (1 - this.smoothing) + target * this.smoothing);
  }

  recordFailure() {
    this.samples++;
    this.#setLimit(this.limit / 2);
  }

  recordIgnored() { /* cancelled — no signal either way */ }

  #setLimit(next) {
    const clamped = Math.max(this.min, Math.min(this.max, next));
    const before = Math.floor(this.limit);
    this.limit = clamped;
    // Slots opened up: hand them out now rather than at the next completion.
    if (Math.floor(this.limit) > before) this.#drain();
  }

  #release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.#drain();
  }

  #drain() {
    while (this.waiters.length && this.inFlight < this.limit) {
      const next = this.waiters.shift();
      next();
    }
  }

  stats() {
    return {
      limit: Math.round(this.limit * 100) / 100,
      inFlight: this.inFlight,
      queued: this.waiters.length,
      minRtt: this.minRtt === Infinity ? null : Math.round(this.minRtt),
      samples: this.samples,
    };
  }
}

// ---- circuit breaker ----------------------------------------------------
//
// Per host. A node that is down answers fastest of all, and retrying it on
// every request spends the user's time discovering the same thing repeatedly —
// worse when there is a healthy node next in line that could have served the
// request immediately. After `threshold` consecutive failures the breaker opens
// and calls fail instantly; after a jittered cool-off one probe is allowed
// through, and its result decides whether to close or wait again.
export class CircuitBreaker {
  constructor({ threshold = 4, openMs = 20_000, maxOpenMs = 5 * 60_000 } = {}) {
    this.threshold = threshold;
    this.openMs = openMs;
    this.maxOpenMs = maxOpenMs;
    this.state = new Map();  // key → { failures, openUntil, backoff, probing }
  }

  #entry(key) {
    let e = this.state.get(key);
    if (!e) { e = { failures: 0, openUntil: 0, backoff: this.openMs, probing: false }; this.state.set(key, e); }
    return e;
  }

  /** False when the breaker is open and no probe slot is available. */
  allows(key) {
    const e = this.#entry(key);
    if (!e.openUntil) return true;
    if (now() < e.openUntil) return false;
    if (e.probing) return false;      // a probe is already deciding
    e.probing = true;                 // half-open: exactly one request through
    return true;
  }

  succeed(key) {
    const e = this.#entry(key);
    e.failures = 0;
    e.openUntil = 0;
    e.backoff = this.openMs;
    e.probing = false;
  }

  fail(key) {
    const e = this.#entry(key);
    e.failures++;
    if (e.probing) {
      // The probe failed: stay open, and wait longer next time.
      e.probing = false;
      e.backoff = Math.min(this.maxOpenMs, e.backoff * 2);
      e.openUntil = now() + jitteredPeriod(e.backoff, 0.3);
      return;
    }
    if (e.failures >= this.threshold) {
      e.openUntil = now() + jitteredPeriod(e.backoff, 0.3);
    }
  }

  isOpen(key) {
    const e = this.state.get(key);
    return !!(e && e.openUntil && now() < e.openUntil);
  }
}

// ---- single flight ------------------------------------------------------
//
// Identical concurrent requests collapse into one. Two rails asking for the
// same cover, a re-render racing its own previous render, a retry firing while
// the first attempt is still open — all of it costs one request. The entry is
// dropped as soon as it settles, so this is deduplication, never a cache.
const inFlight = new Map();
export function singleFlight(key, run) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => run())().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export function inFlightCount() { return inFlight.size; }

// ---- shared helpers -----------------------------------------------------

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export function isAbortLike(error) {
  return !!error && (error.name === 'AbortError' || error.code === 20 || /abort/i.test(error.message || ''));
}

/** Network-ish failures and the 5xx family: worth another go. 4xx is not. */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export default {
  AdaptiveLimiter, CircuitBreaker, withRetry, singleFlight,
  decorrelatedJitter, jitteredPeriod, sleep, isAbortLike, isRetryableStatus,
};
