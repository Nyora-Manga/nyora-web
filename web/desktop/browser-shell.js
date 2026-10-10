import { desktopRouteForShortcut, navigateDesktopRoute } from './desktop-commands.js';
import { mountDesktopShell } from './desktop-shell.js';
import { mountDesktopCommands } from './desktop-palette.js';
import { browserLibrary, browserFiles } from './browser-services.js';
import { toast } from '../core/ui.js';

// Share the reading-room theme at every width; mount the Electron shell on desktop.
// Rebuild the mobile drawer
// when crossing the breakpoint so neither layout leaves dead or duplicate links.
export function mountBrowserDesktop({ router, store, buildSidebar, syncNav, render }) {
  const media = matchMedia('(min-width:761px)');
  let unmountShell, unmountCommands;
  function update(event) {
    unmountShell?.(); unmountCommands?.();
    unmountShell = unmountCommands = undefined;
    buildSidebar();
    document.body.classList.remove('nav-open');
    if (media.matches) {
      document.documentElement.dataset.nyoraPlatform = 'desktop';
      unmountCommands = mountDesktopCommands({ router, services: browserLibrary, files: browserFiles, toast });
      unmountShell = mountDesktopShell({ router, store });
    } else document.documentElement.dataset.nyoraPlatform = 'mobile';
    syncNav(router.current().name);
    if (event) render(router.current());
  }
  function onShortcut(event) {
    if (!media.matches || event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (document.querySelector('[role="dialog"], [role="menu"]') || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const route = desktopRouteForShortcut(event.key);
    if (route) { event.preventDefault(); navigateDesktopRoute(router, route, document); }
  }
  document.addEventListener('keydown', onShortcut);
  media.addEventListener('change', update);
  update();
  window.addEventListener('pagehide', () => {
    document.removeEventListener('keydown', onShortcut);
    unmountShell?.(); unmountCommands?.(); media.removeEventListener('change', update);
  }, { once: true });
}
