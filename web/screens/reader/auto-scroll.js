// screens/reader/auto-scroll.js — hands-free reading.
//
// One time-based rAF clock drives both reading modes: webtoon scrolls by pixels
// per second, paged advances after a delay. Using elapsed time rather than a
// per-frame step keeps the speed honest on any refresh rate, and a single clock
// means there are no setTimeout races to cancel when the chapter or mode changes.

/** Level 1–10 → webtoon scroll speed. 24 … 258 px/s. */
export const webtoonPxPerSec = (level) => 24 + (level - 1) * 26;

/** Level 1–10 → paged dwell time. ~8.7s … 1.7s per page. */
export const pagedDelayMs = (level) => Math.max(1500, 9500 - level * 780);

// A backgrounded tab pauses rAF; without a ceiling the first frame back would
// bank the whole gap and jump the reader.
const MAX_FRAME_MS = 100;

/**
 * @param deps.getMode          () => 'WEBTOON' | 'PAGED'
 * @param deps.getLevel         () => number — current speed level, owned by the caller
 * @param deps.getScrollEl      () => Element | null — the webtoon scroller
 * @param deps.getPageState     () => { currentPage, pageCount }
 * @param deps.advancePage      () => void — paged mode, one page forward
 * @param deps.revealControls   () => void — so the pause button is reachable
 * @param deps.hasNextChapter   () => boolean
 * @param deps.goNextChapter    () => void
 * @param deps.onStateChange    () => void — running state changed; re-sync the UI
 * @param deps.onFinished       () => void — stopped at the last page of the last chapter
 */
export function createAutoScroll(deps) {
  let running = false;
  let raf = null;
  let lastTs = 0;
  // Sub-pixel scroll remainder (webtoon) or elapsed dwell time (paged).
  let accumulator = 0;

  function frame(ts) {
    if (!running) { raf = null; return; }
    if (!lastTs) lastTs = ts;
    const dt = Math.min(MAX_FRAME_MS, ts - lastTs);
    lastTs = ts;

    const advanced = deps.getMode() === 'WEBTOON' ? scrollWebtoon(dt) : advancePaged(dt);
    if (advanced === 'ended') { reachedEnd(); return; }

    raf = requestAnimationFrame(frame);
  }

  function scrollWebtoon(dt) {
    const target = deps.getScrollEl();
    if (!target) return 'continue';

    accumulator += webtoonPxPerSec(deps.getLevel()) * (dt / 1000);
    const step = Math.floor(accumulator);
    if (step < 1) return 'continue';
    accumulator -= step;

    const before = target.scrollTop;
    target.scrollTop = before + step;
    const moved = target.scrollTop - before;

    const canScroll = target.scrollHeight > target.clientHeight + 4;
    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 2;
    // Only end on the LAST page. Lazy-loaded images below can briefly make
    // scrollHeight look short, and treating that as the end would skip a chapter.
    const { currentPage, pageCount } = deps.getPageState();
    if (currentPage >= pageCount - 1 && (atBottom || !canScroll)) return 'ended';

    // Hit a wall while lower images are still loading — don't bank the shortfall.
    if (moved < step - 0.5) accumulator = 0;
    return 'continue';
  }

  function advancePaged(dt) {
    accumulator += dt;
    if (accumulator < pagedDelayMs(deps.getLevel())) return 'continue';
    accumulator = 0;
    const { currentPage, pageCount } = deps.getPageState();
    if (currentPage >= pageCount - 1) return 'ended';
    deps.advancePage();
    return 'continue';
  }

  // Roll on to the next chapter with auto still on — the loop restarts once it
  // renders — or stop at the very end of the series.
  function reachedEnd() {
    raf = null;
    if (deps.hasNextChapter()) deps.goNextChapter();
    else { stop(); deps.onFinished(); }
  }

  function cancel() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  /** Restart the clock without touching the running flag (after a re-render). */
  function restart() {
    lastTs = 0;
    accumulator = 0;
    cancel();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!deps.getPageState().pageCount) return;
    running = true;
    deps.revealControls();
    restart();
    deps.onStateChange();
  }

  function stop() {
    running = false;
    cancel();
    deps.onStateChange();
  }

  return {
    start,
    stop,
    cancel,
    restart,
    toggle: () => (running ? stop() : start()),
    isRunning: () => running,
  };
}
