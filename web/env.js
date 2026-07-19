// Nyora Web — environment configuration.
//
// Sets the globals that core/sync.js (and core/api.js) read, with baked
// fallbacks. Loaded as a classic script before the app module, so the values
// are in place by the time those modules are imported.
//
// Active profile = production. To point the web app at a locally-running sync
// server, comment the production line and uncomment the development one.

// --- Production (active) ---
// Self-hosted FastAPI sync backend (OAuth2 password flow + JWT). Replaces the
// old Supabase edge function + Google sign-in.
globalThis.NYORA_SYNC_URL = 'https://sync.nyora.xyz';

// Hosted content/parser helper (the REST parser runner). core/api.js prefers
// this for the shared, read-only catalog (catalog/popular/latest/search/
// details/pages) and the /image proxy, falling back to the in-browser web
// parsers only when the helper is unreachable.
globalThis.NYORA_HELPER_URL = 'https://api.nyora.xyz';

// Extra parser nodes to client-side round-robin the JSON API across (browse/search/
// details/pages), with failover. Images always stay on NYORA_HELPER_URL above. Add a
// Hugging Face Space node here to give it real traffic share without a DNS/CF change;
// list api.nyora.xyz more than once to weight the Space lower. Single entry = no-op.
globalThis.NYORA_HELPER_URLS = [
  // api.nyora.xyz (WARP-backed VM cluster) listed twice to weight it ~2/3 of the
  // rotation vs the free HF node below (~1/3). The HF node serves normal sources
  // locally and transparently relays CF/IP-banned sources back to api.nyora.xyz,
  // so it never returns a broken CF result — safe to round-robin. Images always
  // stay on NYORA_HELPER_URL (the VM cluster) regardless.
  'https://api.nyora.xyz',
  'https://api.nyora.xyz',
  'https://mdhasanraza-nyora-one.hf.space/n',
];

// --- Local development ---
// globalThis.NYORA_SYNC_URL = 'http://localhost:8787';
// globalThis.NYORA_HELPER_URL = 'http://localhost:8788';
