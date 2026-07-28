// screens/reader/presentation.js — how much of the screen the reader takes over.
//
// Two independent things the reader can do to get out of the way, both of which
// have to survive a re-render and be undone on teardown:
//
//   immersive  — hides the app's own sidebar (CSS gates it on the body classes)
//   fullscreen — the browser Fullscreen API, so the browser chrome goes too
//
// Also the screen wake lock, which belongs to the same "keep reading undisturbed"
// concern and has the same lifecycle.

import { $$, icon } from '../../core/ui.js';

/**
 * @param deps.view              the reader's root element (for the toggle buttons)
 * @param deps.toast             (message) => void
 * @param deps.onImmersiveChange (on) => void — persist the preference
 */
export function createPresentation({ view, toast, onImmersiveChange }) {
  function toggleImmersive(event) {
    if (event) event.stopPropagation();
    const on = !document.body.classList.contains('reader-immersive');
    document.body.classList.toggle('reader-immersive', on);
    onImmersiveChange(on);
    $$('.reader-sidebar-toggle', view).forEach((node) => {
      node.classList.toggle('active', on);
      node.title = on ? 'Show sidebar' : 'Hide sidebar';
    });
    toast(on ? 'Sidebar hidden' : 'Sidebar shown');
  }

  function toggleFullscreen(event) {
    if (event) event.stopPropagation();
    if (currentFullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => {});
      return;
    }
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) { toast('Fullscreen not supported'); return; }
    Promise.resolve(request.call(root)).catch(() => toast('Fullscreen not available'));
  }

  // The browser can leave fullscreen without us asking (Escape), so the button
  // state has to follow the event rather than the click.
  function syncFullscreen() {
    const on = !!currentFullscreenElement();
    document.body.classList.toggle('reader-fullscreen', on);
    $$('.reader-fs-toggle', view).forEach((node) => {
      node.classList.toggle('active', on);
      node.title = on ? 'Exit fullscreen' : 'Fullscreen';
      node.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
    });
  }

  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);

  return {
    toggleImmersive,
    toggleFullscreen,
    syncFullscreen,
    dispose() {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('webkitfullscreenchange', syncFullscreen);
      document.body.classList.remove('reader-immersive', 'reader-fullscreen');
      if (currentFullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        try { if (exit) Promise.resolve(exit.call(document)).catch(() => {}); }
        catch { /* already leaving */ }
      }
    },
  };
}

/**
 * Holds the screen awake while reading, best-effort.
 *
 * The OS drops the lock whenever the tab is hidden and will not let it be
 * re-taken until the tab is visible again, so this re-acquires on
 * visibilitychange rather than assuming one request lasts the session. Silently
 * does nothing where the API is missing or the user denied it.
 *
 * @param deps.isEnabled () => boolean — the user's keep-awake preference
 * @param deps.isAlive   () => boolean — false once the reader has torn down
 */
export function keepScreenAwake({ isEnabled, isAlive }) {
  let sentinel = null;

  async function acquire() {
    if (!isEnabled() || !isAlive()) return;
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    // A lock the OS has not dropped is still ours; asking again would strand the
    // old sentinel, and only the one we keep a handle to ever gets released.
    if (sentinel && sentinel.released === false) return;
    try {
      const next = await navigator.wakeLock.request('screen');
      // The reader can be torn down during the await; nothing would release it.
      if (!isAlive()) { try { await next.release(); } catch { /* ignore */ } return; }
      sentinel = next;
    } catch { /* denied or unsupported */ }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') acquire();
  }

  document.addEventListener('visibilitychange', onVisibility);
  acquire();

  return {
    dispose() {
      document.removeEventListener('visibilitychange', onVisibility);
      try { if (sentinel) sentinel.release(); } catch { /* already released */ }
      sentinel = null;
    },
  };
}

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}
