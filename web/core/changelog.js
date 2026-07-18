// core/changelog.js — "What's new" dialog, shown once per release.
//
// Existing installs matter here: the marker key didn't exist before this
// release, so anyone already using Nyora has no stored version. Rather than
// treating that as "nothing to show", we treat a MISSING marker as "show the
// latest entry once" — that's what makes the changelog reach people who are
// already using the app, not just fresh installs.
//
// The one exception is a genuine first run: the welcome screen is already
// introducing the app, so app.js stamps the version instead of stacking a
// second dialog on top (see markChangelogSeen).

import { el, icon, modal } from './ui.js';

const SEEN_KEY = 'nyora.changelog.seen';

// Bump this with every user-visible release, newest entry first in CHANGELOG.
export const APP_VERSION = '2.6.0';

export const CHANGELOG = [
  {
    version: '2.6.0',
    date: 'July 2026',
    entries: [
      {
        icon: 'globe',
        title: 'Much better manga translation',
        text: 'Speech-bubble text now reads like a scanlation instead of a literal '
          + 'machine translation: repeated punctuation stays intact (“Run away!!” not '
          + '“Run away! !”), screams keep their original length, stutters are lettered '
          + 'properly (“N-no way…”), and common manga interjections are handled directly '
          + 'so lines like しまった！ no longer come back as “It’s gone!”.',
      },
      {
        icon: 'user',
        title: 'Character names get translated correctly',
        text: 'Nyora now looks up the series’ cast and uses the spellings readers '
          + 'actually know. Names that machine translation used to mangle — or translate '
          + 'as ordinary words — come out right, in natural English name order.',
      },
      {
        icon: 'droplet',
        title: 'AI colorization stays off until you ask for it',
        text: 'Colorization now requires its model to be downloaded first, from '
          + 'Settings → Experimental → Colorization. Turning on Experimental no longer '
          + 'switches colorization on by itself or triggers a background download.',
      },
      {
        icon: 'flask',
        title: 'Reorganised Experimental settings',
        text: 'Translation and Colorization are now their own pages under Settings → '
          + 'Experimental, each with a clear model download and progress bar.',
      },
      {
        icon: 'palette',
        title: 'Material You redesign',
        text: 'Cards, empty states, dialogs and the reader chrome were rebuilt on '
          + 'Material 3 components, with a proper splash screen replacing the black '
          + 'flash on startup.',
      },
    ],
  },
];

function storedVersion() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return APP_VERSION; }
}

// Record the current version WITHOUT showing anything — used for first runs,
// where the welcome screen already covers the introduction.
export function markChangelogSeen() {
  try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch { /* private mode */ }
}

export function shouldShowChangelog() {
  return storedVersion() !== APP_VERSION;
}

export function showChangelog(onDone) {
  const release = CHANGELOG[0];
  if (!release) { markChangelogSeen(); if (onDone) onDone(); return; }

  const body = el('div', { class: 'changelog' },
    el('div', { class: 'changelog-version' }, `Version ${release.version} · ${release.date}`),
    ...release.entries.map((e) => el('div', { class: 'changelog-item' },
      el('div', { class: 'changelog-icon' }, icon(e.icon)),
      el('div', { class: 'changelog-text' },
        el('div', { class: 'changelog-title' }, e.title),
        el('div', { class: 'changelog-desc' }, e.text)),
    )),
  );

  // Stamp on dismissal by ANY route (button, Escape, backdrop click) so the
  // dialog can't reappear on the next load just because it wasn't closed with
  // the button.
  let done = false;
  const finish = () => { if (done) return; done = true; markChangelogSeen(); if (onDone) onDone(); };

  const close = modal({
    title: 'What’s new',
    body,
    actions: [{ label: 'Got it', primary: true, variant: 'accent', onClick: finish }],
  });
  // modal() removes the backdrop ~160ms after any close path; catch the ones
  // that bypass the action button.
  const root = document.getElementById('modalRoot');
  if (root) {
    const obs = new MutationObserver(() => {
      if (!root.querySelector('.modal-backdrop')) { obs.disconnect(); finish(); }
    });
    obs.observe(root, { childList: true });
  }
  return close;
}
