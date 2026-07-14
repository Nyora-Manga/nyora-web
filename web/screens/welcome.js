// Nyora Web — first-run welcome / start screen.
//
// A cinematic, anime-inspired night-rain landing shown once on first launch
// when the user isn't signed in and hasn't chosen to continue as a guest.
// Animated rain + atmospheric glow/mist + the occasional lightning flash, over
// a glass auth card. Desktop-first but responsive. Email/password sign-in
// against the self-hosted sync server, plus guest and restore actions.

import { el, toast, spinner, langCode, languageOptions } from '../core/ui.js';
import sync from '../core/sync.js';
import api from '../core/api.js';
import { store } from '../core/store.js';

const ONBOARD_KEY = 'nyora.web.onboarded.v1';

const ICON_GUEST = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

/** True when the welcome screen should be shown (not signed in, not dismissed). */
export function shouldShowWelcome() {
  try {
    if (sync.status().isAuthenticated) return false;
    return localStorage.getItem(ONBOARD_KEY) !== '1';
  } catch {
    return false;
  }
}

function markOnboarded() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* private mode */ }
}

// Build a layer of randomised raindrops. Cheap (transform-only animation).
function rainLayer(count, cls) {
  const layer = el('div', { class: `wlc-rain ${cls}`, 'aria-hidden': 'true' });
  let html = '';
  for (let i = 0; i < count; i++) {
    const left = (Math.random() * 100).toFixed(2);
    const dur = (0.45 + Math.random() * 0.7).toFixed(2);
    const delay = (Math.random() * 7).toFixed(2);
    const h = Math.round(46 + Math.random() * 92);
    const op = (0.08 + Math.random() * 0.34).toFixed(2);
    html += `<span class="wlc-drop" style="left:${left}%;height:${h}px;opacity:${op};animation-duration:${dur}s;animation-delay:-${delay}s"></span>`;
  }
  layer.innerHTML = html;
  return layer;
}

/** Mount the welcome overlay. Calls `onDone()` once the user proceeds. */
export function showWelcome(onDone) {
  const finish = () => {
    overlay.classList.add('is-leaving');
    document.documentElement.classList.remove('wlc-open');
    setTimeout(() => { overlay.remove(); if (onDone) onDone(); }, 380);
  };

  const statusLine = el('div', { class: 'wlc-status' }, '');

  const emailInput = el('input', {
    class: 'wlc-input', type: 'email', autocomplete: 'email',
    placeholder: 'Email', 'aria-label': 'Email',
  });
  const passwordInput = el('input', {
    class: 'wlc-input', type: 'password', autocomplete: 'current-password',
    placeholder: 'Password', 'aria-label': 'Password',
  });

  const signInBtn = el('button', { class: 'wlc-google', type: 'button' },
    el('span', null, 'Sign in'));
  const createBtn = el('button', { class: 'wlc-ghost', type: 'button' },
    el('span', null, 'Create account'));

  const guestBtn = el('button', { class: 'wlc-ghost', type: 'button' },
    el('span', { class: 'wlc-ghost-ic', html: ICON_GUEST }), el('span', null, 'Continue as guest'));
  const restoreBtn = el('button', { class: 'wlc-ghost', type: 'button' },
    el('span', { class: 'wlc-ghost-ic', html: ICON_RESTORE }), el('span', null, 'Restore backup'));

  const setBusy = (busy) => {
    signInBtn.disabled = createBtn.disabled = guestBtn.disabled = restoreBtn.disabled = busy;
    emailInput.disabled = passwordInput.disabled = busy;
    signInBtn.classList.toggle('is-busy', busy);
  };

  async function doAuth(register) {
    if (signInBtn.disabled) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      statusLine.className = 'wlc-status is-error';
      statusLine.textContent = 'Enter your email and password.';
      return;
    }
    setBusy(true);
    statusLine.className = 'wlc-status is-info';
    statusLine.textContent = register ? 'Creating your account…' : 'Signing in…';
    try {
      if (register) {
        // NEW ACCOUNT → create + sign in, then onboard. Their local (guest) data
        // plus the onboarding picks are MIGRATED up to the cloud when they finish
        // (enterPreferences({ migrate: true }) → sync.syncNow after seeding).
        const st = await sync.register(email, password);
        if (st && st.isAuthenticated) {
          enterPreferences({ migrate: true });
        } else {
          statusLine.className = 'wlc-status is-error';
          statusLine.textContent = 'Could not create the account. Please try again.';
          setBusy(false);
        }
      } else {
        // EXISTING ACCOUNT → FETCH the library from the cloud and go straight in.
        // Returning user: no onboarding. (Any local guest data is merged up first.)
        statusLine.textContent = 'Signing in… fetching your library…';
        const st = await sync.signInAndFetch(email, password);
        if (st && st.isAuthenticated) {
          statusLine.textContent = 'Welcome back.';
          markOnboarded();
          finish();
        } else {
          statusLine.className = 'wlc-status is-error';
          statusLine.textContent = 'Sign-in failed. Please try again.';
          setBusy(false);
        }
      }
    } catch (e) {
      statusLine.className = 'wlc-status is-error';
      statusLine.textContent = (register ? 'Sign-up failed: ' : 'Sign-in failed: ') + ((e && e.message) || e);
      setBusy(false);
    }
  }

  // Restore from a JSON backup file (reuses the Settings import path).
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    setBusy(true);
    statusLine.className = 'wlc-status is-info';
    statusLine.textContent = 'Restoring backup…';
    try {
      await api.importBackup(await file.text());
      toast('Backup restored');
      markOnboarded();
      finish();
    } catch (e) {
      statusLine.className = 'wlc-status is-error';
      statusLine.textContent = 'Restore failed: ' + ((e && e.message) || e);
      setBusy(false);
    } finally {
      fileInput.value = '';
    }
  });

  signInBtn.addEventListener('click', () => doAuth(false));
  createBtn.addEventListener('click', () => doAuth(true));
  passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(false); });
  guestBtn.addEventListener('click', () => { enterPreferences(); });
  restoreBtn.addEventListener('click', () => { if (!restoreBtn.disabled) fileInput.click(); });

  const logo = el('img', { class: 'wlc-logo', src: '/icon.png', alt: '' });
  logo.addEventListener('error', () => { logo.style.display = 'none'; });

  // ── Left: editorial hero ────────────────────────────────────────────────
  const hero = el('div', { class: 'wlc-hero' },
    el('div', { class: 'wlc-brand' },
      logo,
      el('span', { class: 'wlc-wordmark' }, 'NYORA')),
    el('div', { class: 'wlc-eyebrow' },
      el('span', { class: 'wlc-eyebrow-jp' }, '破壊'),
      'Manga, anywhere the night takes you'),
    el('h1', { class: 'wlc-title' },
      'Read like the ',
      el('em', null, 'world'),
      ' can wait.'),
    el('p', { class: 'wlc-sub' },
      'Nyora pulls hundreds of sources into one quiet shelf and remembers exactly where you stopped — on your phone, your tablet, your desk. Sign in to sync and back it up, or just start reading.'),
    el('ul', { class: 'wlc-features' },
      el('li', null, 'Hundreds of sources'),
      el('li', null, 'Picks up on every device'),
      el('li', null, 'No ads, ever')),
  );

  // ── Right: auth panel ───────────────────────────────────────────────────
  const auth = el('div', { class: 'wlc-auth' },
    el('div', { class: 'wlc-auth-head' }, 'Start reading'),
    el('div', { class: 'wlc-fields' }, emailInput, passwordInput),
    signInBtn,
    createBtn,
    el('div', { class: 'wlc-or' }, el('span', null, 'or')),
    el('div', { class: 'wlc-secondary' }, guestBtn, restoreBtn),
    statusLine,
    el('p', { class: 'wlc-foot' }, 'No account needed — go in as a guest and sync whenever you like.'),
    fileInput,
  );

  const stage = el('div', { class: 'wlc-inner' }, hero, auth);

  // Phones get a much lighter scene — far fewer raindrops, and (via CSS) no
  // backdrop blur / lightning — so the welcome doesn't lag low-power GPUs.
  const small = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches;

  const overlay = el('div', { class: 'wlc', role: 'dialog', 'aria-label': 'Welcome to Nyora', 'aria-modal': 'true' },
    el('div', { class: 'wlc-sky', 'aria-hidden': 'true' },
      el('span', { class: 'wlc-glow wlc-glow-1' }),
      el('span', { class: 'wlc-glow wlc-glow-2' }),
      el('span', { class: 'wlc-mist' }),
      rainLayer(small ? 0 : 34, 'is-back'),
      rainLayer(small ? 7 : 54, 'is-front'),
      el('span', { class: 'wlc-flash' }),
      el('span', { class: 'wlc-horizon' }),
      el('span', { class: 'wlc-vignette' }),
    ),
    stage,
  );

  document.documentElement.classList.add('wlc-open');
  document.body.appendChild(overlay);

  // ── Preferences onboarding ──────────────────────────────────────────────
  // After the user is in (sign-in / create / guest): swap the auth stage for the
  // preferences card. On "Start reading" it sets showNsfw + seeds the matching
  // sources; for a NEW account it then migrates everything up to the cloud.
  function enterPreferences(opts) {
    const migrate = !!(opts && opts.migrate);
    markOnboarded();
    const card = el('div', { class: 'wlc-prefs' });
    stage.replaceWith(el('div', { class: 'wlc-prefs-stage' }, card));
    populatePreferencesCard(card, { migrate, onDone: finish });
  }

  // Awwwards-style staggered entrance for the welcome content (GSAP is loaded
  // globally; no-op when absent or under reduced-motion, so content never hides).
  try {
    const gsap = window.gsap;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (gsap && !reduce) {
      const items = overlay.querySelectorAll(
        '.wlc-brand, .wlc-eyebrow, .wlc-title, .wlc-sub, .wlc-features, .wlc-auth',
      );
      gsap.fromTo(items,
        { y: 26, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, duration: 0.7, stagger: 0.09, ease: 'power3.out', delay: 0.12 });
    }
  } catch { /* motion is optional polish */ }
}

// Build the preferences UI into `card` and wire the CTA to apply the choices
// (showNsfw + seed the matching installed sources), optionally migrate to the
// cloud, then call onDone(). Shared by first-run onboarding (welcome) and the
// "Re-run setup" action in Settings.
function populatePreferencesCard(card, opts = {}) {
  const {
    migrate = false,
    kicker = 'You’re in',
    title = 'Set up your shelf',
    sub = 'Choose your languages and content preference — we’ll line up the matching sources. You can change any of this later in Settings.',
    cta = 'Start reading',
    onDone,
  } = opts;

  let show18 = !!store.get().showNsfw;   // reflect the current pref (matters on re-run)
  const selected = new Set();            // empty ⇒ all languages

  card.append(
    el('div', { class: 'wlc-prefs-head' },
      el('div', { class: 'wlc-prefs-kicker' }, kicker),
      el('h2', { class: 'wlc-prefs-title' }, title),
      el('p', { class: 'wlc-prefs-sub' }, sub)),
    el('div', { class: 'wlc-prefs-loading' }, spinner()),
  );

  try {
    const gsap = window.gsap;
    if (gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.fromTo(card, { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.6, ease: 'power3.out' });
    }
  } catch { /* optional polish */ }

  const matchIds = (entries) => entries
    .filter((e) => (selected.size === 0 || selected.has(langCode(e))) && (show18 || !e.isNsfw))
    .map((e) => e.id);

  async function applyAndFinish(entries) {
    try {
      store.set({ showNsfw: show18 });
      let ids = matchIds(entries);
      // Never leave an empty shelf (e.g. a language with only adult sources while
      // 18+ is off) — fall back to everything matching the 18+ rule.
      if (!ids.length) ids = entries.filter((e) => show18 || !e.isNsfw).map((e) => e.id);
      await api.setInstalledSources(ids);
      // Signed-in / new account → push the freshly-seeded prefs + library up.
      if (migrate) { try { await sync.syncNow(); } catch { /* best-effort */ } }
    } catch { /* proceed regardless — defaults remain */ }
    if (onDone) onDone();
  }

  function buildBody(entries) {
    const loading = card.querySelector('.wlc-prefs-loading');
    if (loading) loading.remove();

    const nsfwInput = el('input', { type: 'checkbox' });
    nsfwInput.checked = show18;
    nsfwInput.addEventListener('change', () => { show18 = nsfwInput.checked; renderCount(); });
    const nsfwRow = el('div', { class: 'wlc-pref-row' },
      el('div', { class: 'wlc-pref-row-main' },
        el('div', { class: 'wlc-pref-row-title' }, 'Show 18+ sources'),
        el('div', { class: 'wlc-pref-row-sub' }, 'Include adult-only sources in Explore & search.')),
      el('label', { class: 'switch' }, nsfwInput, el('span', { class: 'slider' })),
    );

    const chips = new Map();
    const allChip = el('button', {
      class: 'wlc-lang-chip', type: 'button',
      onClick: () => { selected.clear(); paint(); renderCount(); },
    }, 'All languages');
    const grid = el('div', { class: 'wlc-lang-grid' }, allChip);
    for (const o of languageOptions(entries)) {
      const c = el('button', {
        class: 'wlc-lang-chip', type: 'button',
        onClick: () => {
          if (selected.has(o.code)) selected.delete(o.code); else selected.add(o.code);
          paint(); renderCount();
        },
      }, el('span', null, o.label), el('span', { class: 'wlc-lang-count' }, String(o.count)));
      chips.set(o.code, c);
      grid.appendChild(c);
    }
    function paint() {
      allChip.classList.toggle('active', selected.size === 0);
      for (const [code, c] of chips) c.classList.toggle('active', selected.has(code));
    }
    paint();

    const countLine = el('div', { class: 'wlc-prefs-count' });
    function renderCount() {
      const n = matchIds(entries).length || entries.filter((e) => show18 || !e.isNsfw).length;
      countLine.textContent = `${n} source${n === 1 ? '' : 's'} will be added`;
    }
    renderCount();

    const startBtn = el('button', { class: 'wlc-google', type: 'button' }, el('span', null, cta));
    startBtn.addEventListener('click', () => {
      startBtn.disabled = true;
      startBtn.classList.add('is-busy');
      applyAndFinish(entries);
    });

    // Head fixed; sections scroll; foot (count + CTA) pinned so the CTA is always
    // reachable even with a long language list.
    const body = el('div', { class: 'wlc-prefs-body' },
      el('div', { class: 'wlc-prefs-section' }, nsfwRow),
      el('div', { class: 'wlc-prefs-section' },
        el('div', { class: 'wlc-prefs-label' }, 'Languages'),
        el('p', { class: 'wlc-prefs-hint' }, 'Pick the languages you read, or keep “All languages”.'),
        grid),
      el('div', { class: 'wlc-prefs-section' },
        el('div', { class: 'wlc-prefs-label' }, 'Good to know'),
        el('ul', { class: 'wlc-prefs-tips' },
          el('li', null, 'Tap the heart to favourite a series'),
          el('li', null, 'Pin your go-to sources to search them first'),
          el('li', null, 'Sign in on any device to pick up where you left off'))),
    );
    card.append(body, el('div', { class: 'wlc-prefs-foot' }, countLine, startBtn));
  }

  api.catalog()
    .then((res) => buildBody((res && res.entries) || []))
    .catch(() => {
      const loading = card.querySelector('.wlc-prefs-loading');
      if (loading) loading.remove();
      const startBtn = el('button', { class: 'wlc-google', type: 'button' }, el('span', null, cta));
      startBtn.addEventListener('click', () => { if (onDone) onDone(); });
      card.append(el('div', { class: 'wlc-prefs-foot' }, startBtn));
    });
}

// Open the preferences step on its own — used by Settings' "Re-run setup" so the
// user can re-pick languages / 18+ and reseed their sources without a fresh
// onboarding. Mounts a lightweight overlay; onDone fires after apply + close.
export function showPreferences(opts = {}) {
  const card = el('div', { class: 'wlc-prefs' });
  const overlay = el('div', {
    class: 'wlc wlc-prefs-only', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Preferences',
  },
    el('div', { class: 'wlc-sky', 'aria-hidden': 'true' },
      el('span', { class: 'wlc-glow wlc-glow-1' }),
      el('span', { class: 'wlc-glow wlc-glow-2' }),
      el('span', { class: 'wlc-vignette' })),
    el('div', { class: 'wlc-prefs-stage' }, card),
  );
  document.documentElement.classList.add('wlc-open');
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.classList.add('is-leaving');
    document.documentElement.classList.remove('wlc-open');
    setTimeout(() => overlay.remove(), 380);
  };
  // Dismiss without applying: click the backdrop or press Esc.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  populatePreferencesCard(card, {
    kicker: 'Preferences',
    title: 'Languages & sources',
    sub: 'Re-pick the languages you read and your content preference — this reseeds your installed sources.',
    cta: 'Save & apply',
    ...opts,
    onDone: () => { close(); if (opts.onDone) opts.onDone(); },
  });
}

export default { shouldShowWelcome, showWelcome, showPreferences };
