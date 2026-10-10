// core/motion.js — Awwwards-grade entrance motion, powered by GSAP (loaded as a
// global <script> in index.html, so referenced here via window.gsap).
//
// Design contract: this is purely additive polish. If GSAP failed to load, or
// the user prefers reduced motion, every function below is a no-op and NOTHING
// is ever left hidden — content always renders on its own. GSAP's fromTo sets
// the "from" state synchronously on the same tick it's called, so there is no
// first-frame flash of the pre-animation state.

const prefersReducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

// Routes whose content is scroll-critical or owns its own choreography. The
// reader must never have its pages tweened (it would fight the scroll); details
// runs its own hero reveal below.
const SKIP_ROUTES = new Set(['reader']);

// Cap the cascade so a 100-item grid doesn't take 4s to settle — the first rows
// carry the "designed" feel; everything past the fold simply appears.
const MAX_TILES = 16;

/**
 * Cascade a freshly-rendered screen into view: heads lead, content tiles follow.
 * @param {HTMLElement} view  the #view container that was just (re)rendered
 * @param {string} routeName  the active route key
 */
export function revealView(view, routeName) {
  if (document.documentElement.dataset.nyoraPlatform === 'desktop') return;
  const gsap = window.gsap;
  if (!gsap || !view || prefersReducedMotion() || SKIP_ROUTES.has(routeName)) return;

  const heads = view.querySelectorAll(
    '.page-title, .section-head, .view > h1, .view > h2, .settings-section > h2, '
    + '.hero-card, .wlc-title, .wlc-eyebrow, .wlc-sub',
  );
  const tiles = Array.from(view.querySelectorAll(
    '.cover-card, .manga-card, .grid-card, .source-pill, .feat-chip, .setting-row, '
    + '.settings-section, .shelf-card, .update-row, .result-card, .rec-card, .welcome-card',
  )).slice(0, MAX_TILES);

  if (!heads.length && !tiles.length) return;

  gsap.killTweensOf([...heads, ...tiles]);

  // Calm, minimal motion: a short fade + small lift, no scale — quiet and
  // editorial rather than springy.
  const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
  if (heads.length) {
    tl.fromTo(heads,
      { y: 12, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.45, stagger: 0.045 }, 0);
  }
  if (tiles.length) {
    tl.fromTo(tiles,
      { y: 14, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.45, stagger: 0.03 },
      heads.length ? 0.05 : 0);
  }
}

export default { revealView };
