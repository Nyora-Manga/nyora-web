// Desktop composition only. Route handlers and native state remain shared.
const destinations = [
  ['library', 'Library'], ['discover', 'Discover'], ['explore', 'Sources'],
  ['updates', 'Updates'], ['downloads', 'Downloads'], ['local', 'Local files'],
];
const titles = Object.fromEntries([...destinations, ['history','History'], ['bookmarks','Bookmarks'], ['stats','Reading statistics'], ['settings','Settings'], ['search','Search manga'], ['browser','Source browser']]);
export function mountDesktopShell({ router, store, document = globalThis.document }) {
  const sidebar = document.getElementById('sidebar');
  const topbar = document.getElementById('topbar');
  if (!sidebar || !topbar) return () => {};
  const node = (tag, className, text) => { const element = document.createElement(tag); element.className = className; if (text) element.textContent = text; return element; };
  // Drop the shared brand's Explore listener before assigning the Library action.
  const brand = sidebar.querySelector('.brand')?.cloneNode(true);
  const trigger = sidebar.querySelector('[data-desktop-command-trigger]');
  const settings = sidebar.querySelector('[data-route="settings"]');
  const nav = node('nav', 'desktop-main-nav'); nav.setAttribute('aria-label', 'Main navigation');
  for (const [route,label] of destinations) {
    const item = sidebar.querySelector(`[data-route="${route}"]`);
    if (!item) continue;
    item.querySelector('span:not(.icon)').textContent = label;
    item.title = label; item.setAttribute('aria-label', label); nav.append(item);
  }
  const footer = node('div', 'desktop-sidebar-footer');
  if (settings) footer.append(settings);
  const collapse = node('button', 'desktop-sidebar-collapse');
  collapse.type = 'button';
  collapse.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path class="desktop-sidebar-chevron" d="m16 9-3 3 3 3"/></svg>';
  collapse.onclick = async () => {
    collapse.disabled = true;
    try { await store.set({ navRail: !store.get().navRail }); }
    finally { collapse.disabled = false; }
  };
  footer.append(collapse);
  sidebar.replaceChildren(...[brand,nav,footer].filter(Boolean));
  if (brand) { brand.setAttribute('role','button'); brand.tabIndex=0; brand.setAttribute('aria-label','Open Library'); brand.onclick=()=>router.navigate('library'); brand.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();router.navigate('library');}}; }
  const context = node('span','desktop-context');
  const action = trigger || node('button','');
  action.className = 'desktop-command-trigger desktop-header-search';
  action.type='button';
  const label = action.querySelector('span');
  if (label) label.textContent = 'Search manga or actions';
  action.setAttribute('aria-label','Search manga or actions');
  action.setAttribute('aria-haspopup','dialog');
  const sourceBrowser = node('button','btn btn-ghost desktop-browser-action','Source browser'); sourceBrowser.type='button'; sourceBrowser.onclick=()=>router.navigate('browser');
  topbar.prepend(context); topbar.append(sourceBrowser,action);
  const update = () => {
    const route = router.current().name;
    context.textContent = titles[route] || 'Nyora';
    sourceBrowser.hidden = route !== 'explore';
    const libraryRoute = ['history','bookmarks','stats'].includes(route);
    if (libraryRoute) { const item=nav.querySelector('[data-route="library"]'); item?.classList.add('active'); item?.setAttribute('aria-current','page'); }
    const compact = !!store.get().navRail;
    collapse.setAttribute('aria-expanded',String(!compact));
    collapse.title = compact ? 'Expand sidebar' : 'Collapse sidebar';
    collapse.setAttribute('aria-label', collapse.title);
  };
  const offRoute=router.onChange(update),offStore=store.subscribe(update); update();
  return () => { offRoute(); offStore(); context.remove(); action.remove(); sourceBrowser.remove(); };
}
