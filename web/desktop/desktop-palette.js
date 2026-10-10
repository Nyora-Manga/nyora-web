import { createDesktopCommands, searchCommands, librarySearchCommands, runCommand, shortcutGroups } from './desktop-commands.js';

export function mountDesktopCommands({ router, services, files, bridge = globalThis.nyoraDesktop, toast = () => {}, document = globalThis.document, window = globalThis.window }) {
  const root = document.getElementById('modalRoot');
  const sidebar = document.getElementById('sidebar');
  if (!root || !sidebar) return () => {};
  const mac = /Mac/i.test(window.navigator.platform || '');
  const modifier = mac ? '⌘' : 'Ctrl+';
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let active, pendingOpen, disposed = false;
  function close({ immediate = false } = {}) {
    const state = active;
    if (!state) return Promise.resolve();
    if (state.closing) { if (immediate) state.finish(); return state.closed; }
    state.closing = true;
    state.closed = new Promise(resolve => {
      let timer;
      const ended = event => { if (event.target === state.panel && event.animationName === 'nyora-search-out') state.finish(); };
      state.finish = () => {
        if (state.finished) return;
        state.finished = true;
        window.clearTimeout(timer);
        state.panel.removeEventListener('animationend', ended);
        state.backdrop.remove();
        if (active === state) active = null;
        if (!disposed && state.previous?.isConnected) state.previous.focus();
        resolve();
      };
      if (immediate || reducedMotion.matches) { state.finish(); return; }
      const panelStyle = window.getComputedStyle(state.panel);
      state.panel.style.setProperty('--nyora-search-exit-from', panelStyle.transform);
      state.panel.style.setProperty('--nyora-search-exit-opacity', panelStyle.opacity);
      state.backdrop.style.setProperty('--nyora-search-backdrop-from', window.getComputedStyle(state.backdrop).opacity);
      state.backdrop.classList.add('is-closing');
      state.panel.addEventListener('animationend', ended);
      // A cancelled animation or a background window must still release focus.
      timer = window.setTimeout(state.finish, 180);
    });
    return state.closed;
  }
  function dialog(title, mode) {
    if (disposed) return null;
    if (active?.closing) {
      pendingOpen = mode;
      if (!active.reopening) {
        active.reopening = true;
        active.closed.then(() => {
          const next = pendingOpen; pendingOpen = undefined;
          if (!disposed) { if (next === 'palette') showPalette(); else if (next === 'shortcuts') showShortcuts(); }
        });
      }
      return null;
    }
    if (active?.mode === mode) { active.input?.focus(); return active; }
    if (active || root.querySelector('.modal-backdrop')) return null;
    const previous = document.activeElement;
    const backdrop = node('div', 'modal-backdrop open desktop-command-backdrop');
    const panel = node('div', 'modal desktop-command-dialog');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title);
    const header = node('div', 'desktop-command-head');
    header.append(node('h2', '', title));
    const dismiss = node('button', 'desktop-command-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Close'); dismiss.onclick = () => { void close(); };
    header.append(dismiss); panel.append(header); backdrop.append(panel); root.append(backdrop);
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) close(); });
    active = { previous, backdrop, panel, mode, dismiss, selected: -1, options: [] };
    return active;
  }
  function focusSearch() {
    const local = document.querySelector('#view input[type="search"]');
    if (local && local.getClientRects().length) { local.focus(); local.select(); return; }
    const input = document.getElementById('searchInput');
    if (input && input.getClientRects().length) { input.focus(); input.select(); return; }
    router.navigate('search');
    window.requestAnimationFrame(() => { const field = document.querySelector('#view input[type="search"], #view input'); field?.focus(); });
  }
  const commands = createDesktopCommands({ router, services, files,
    navigation: { back: () => window.history.back(), forward: () => window.history.forward() }, focusSearch, showShortcuts });
  function choose(index) {
    if (!active || active.closing || active.mode !== 'palette') return;
    active.selected = index;
    active.options.forEach((item, position) => { const selected = position === index; item.button.setAttribute('aria-selected', String(selected)); item.button.classList.toggle('selected', selected); });
    if (index >= 0) { active.input.setAttribute('aria-activedescendant', active.options[index].button.id); active.options[index].button.scrollIntoView({ block: 'nearest' }); }
    else active.input.removeAttribute('aria-activedescendant');
  }
  function execute(id) {
    if (!active || active.closing) return;
    const command = active.options.find(item => item.command.id === id)?.command;
    if (!command) return;
    void close().then(() => { if (!disposed) return runCommand([command], id); })
      .catch(error => toast(error.message || 'The action could not be completed.'));
  }
  function renderOptions(state) {
    state.list.replaceChildren(); state.options = [];
    const local = librarySearchCommands(services, router, state.input.value);
    const matches = searchCommands(commands, state.input.value);
    const results = [...local, ...matches];
    for (const command of results) {
      const button = node('button', 'desktop-command-option'); button.type = 'button'; button.id = 'desktop-command-'+command.id;
      button.setAttribute('role', 'option'); button.tabIndex = -1; button.disabled = !command.enabled(); button.setAttribute('aria-disabled', String(button.disabled));
      const label = node('span', 'desktop-command-label', command.label);
      label.append(node('small', '', button.disabled ? 'Open a chapter first' : command.section)); button.append(label);
      if (command.shortcut) button.append(node('kbd', '', modifier+command.shortcut));
      button.onclick = () => execute(command.id);
      const index = state.options.length;
      button.onmousemove = () => { if (!button.disabled) choose(index); };
      state.options.push({ command, button }); state.list.append(button);
    }
    state.empty.hidden = state.options.length > 0;
    state.remote.hidden = !state.input.value.trim();
    state.remote.textContent = 'Search manga for “' + state.input.value.trim() + '”';
    state.announcement.textContent = `${state.options.length} result${state.options.length === 1 ? '' : 's'}`;
    choose(state.options.findIndex(item => !item.button.disabled));
  }
  function showPalette() {
    const state = dialog('Search', 'palette');
    if (!state || state.input) return;
    const input = node('input', 'desktop-command-input'); input.type = 'search'; input.placeholder = 'Search your library, pages, and actions…'; input.autocomplete = 'off';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', 'Search'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'desktop-command-list');
    const list = node('div', 'desktop-command-list'); list.id = 'desktop-command-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Search results');
    const empty = node('p', 'desktop-command-empty', 'No results found.');
    const announcement = node('span', 'desktop-command-sr'); announcement.setAttribute('role', 'status');
    const remote = node('button', 'desktop-command-remote btn btn-ghost'); remote.type = 'button';
    remote.onclick = () => { const query=input.value.trim(); if(query) void close().then(()=>{if(!disposed)router.navigate('search',{q:query});}); };
    state.input = input; state.list = list; state.empty = empty; state.announcement = announcement; state.remote = remote;
    state.panel.append(input, list, empty, remote, node('p', 'desktop-command-hint', '↑ ↓ to choose · Enter to open · Esc to close'), announcement);
    input.addEventListener('input', () => renderOptions(state)); renderOptions(state); input.focus();
  }
  function showShortcuts() {
    const state = dialog('Keyboard shortcuts', 'shortcuts'); if (!state || state.help) return;
    state.help = true;
    const content = node('div', 'desktop-shortcut-content');
    for (const [title, entries] of shortcutGroups(mac)) {
      const section = node('section', 'desktop-shortcut-section'); section.append(node('h3', '', title));
      const list = node('dl');
      for (const [label, shortcut] of entries) { list.append(node('dt', '', label), node('dd', '', shortcut)); }
      section.append(list); content.append(section);
    }
    content.append(node('p', 'desktop-command-hint', 'Reader keys pause while you type or use a dialog. Arrow and Space behavior depends on the reader mode.'));
    state.panel.append(content); state.dismiss.focus();
  }
  function onKey(event) {
    if (event.isComposing || event.defaultPrevented) return;
    if (active?.closing) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') showPalette();
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (active) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') {
        const focusable = [...active.panel.querySelectorAll('button:not(:disabled), input')].filter(item => item.tabIndex !== -1 && item.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (active.mode === 'palette' && document.activeElement === active.input) {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const enabled = active.options.map((item, index) => item.button.disabled ? -1 : index).filter(index => index >= 0);
          const current = enabled.indexOf(active.selected);
          if (enabled.length) choose(enabled[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
        } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const selected = active.options[active.selected]; if (selected) execute(selected.command.id); }
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); showPalette(); }
    else if (event.key === '/') { event.preventDefault(); event.stopPropagation(); showShortcuts(); }
    else if (event.key.toLowerCase() === 'f' && !root.querySelector('.modal-backdrop')) { event.preventDefault(); event.stopPropagation(); focusSearch(); }
  }
  const trigger = node('button', 'nav-item desktop-command-trigger'); trigger.type = 'button'; trigger.dataset.desktopCommandTrigger = '';
  trigger.setAttribute('aria-label', 'Search'); trigger.append(node('span', '', 'Search'), node('kbd', '', modifier+'K')); trigger.onclick = showPalette;
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-keyshortcuts', mac ? 'Meta+K' : 'Control+K');
  const brand = sidebar.querySelector('.brand'); if (brand) brand.after(trigger); else sidebar.prepend(trigger);
  document.addEventListener('keydown', onKey, true);
  const onMotionChange = event => { if (event.matches && active?.closing) active.finish(); };
  reducedMotion.addEventListener('change', onMotionChange);
  const unsubscribe = bridge?.onCommand?.(name => {
    if (name === 'palette') showPalette(); else if (name === 'shortcuts') showShortcuts();
    else if (name === 'search-focus' && !active && !root.querySelector('.modal-backdrop')) focusSearch();
    else if (['back', 'forward'].includes(name) && !active && !root.querySelector('.modal-backdrop')) void runCommand(commands, name).catch(error => toast(error.message));
  });
  return () => { disposed = true; pendingOpen = undefined; void close({ immediate: true }); trigger.remove(); document.removeEventListener('keydown', onKey, true); reducedMotion.removeEventListener('change', onMotionChange); unsubscribe?.(); };
}
