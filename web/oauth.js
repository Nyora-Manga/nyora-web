// Tracker OAuth relay (loaded by oauth.html). Kept as an external 'self' script
// because the site's CSP is hash-pinned (no 'unsafe-inline' for scripts), so an
// inline <script> here would be blocked.
//
// The popup lands on oauth.html (same origin as the app that opened it) after the
// helper's callback redirects to <origin>/oauth.html#…token…. Because this page is
// same-origin as the opener, it hands the token back over a BroadcastChannel even
// when the provider's Cross-Origin-Opener-Policy severed window.opener (which is
// exactly why a plain cross-origin postMessage from the helper failed).
(function () {
  var p = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  var msg = {
    source: 'nyora-tracker',
    slug: p.get('slug') || '',
    access_token: p.get('access_token') || '',
    refresh_token: p.get('refresh_token') || '',
    error: p.get('error') || '',
  };
  // Scrub the token out of the address bar / history immediately.
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  // Primary: same-origin BroadcastChannel — survives a COOP-severed opener.
  try { var bc = new BroadcastChannel('nyora-tracker'); bc.postMessage(msg); bc.close(); } catch (e) { /* older browser */ }
  // Fallbacks: a storage event (same-origin) and a direct opener postMessage.
  try { localStorage.setItem('nyora.oauth.msg', JSON.stringify(Object.assign({ ts: Date.now() }, msg))); } catch (e) { /* quota */ }
  try { if (window.opener) window.opener.postMessage(msg, location.origin); } catch (e) { /* severed */ }

  var ok = !!msg.access_token;
  var dot = document.getElementById('dot');
  var m = document.getElementById('m');
  if (dot) dot.style.display = 'none';
  if (m) m.textContent = ok
    ? 'Connected — you can close this window.'
    : 'Sign-in failed — you can close this window.';
  setTimeout(function () { try { window.close(); } catch (e) { /* ignore */ } }, ok ? 500 : 1600);
})();
