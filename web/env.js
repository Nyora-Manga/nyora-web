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

// The hosted data-driven helper supplies content and the image proxy.
// All configured nodes must expose the same lowercase data:<catalogue-id> contract.
globalThis.NYORA_HELPER_URL = 'https://api.nyora.xyz';
globalThis.NYORA_HELPER_URLS = ['https://api.nyora.xyz'];

// --- Local development ---
// globalThis.NYORA_SYNC_URL = 'http://localhost:8787';
// globalThis.NYORA_HELPER_URL = 'http://localhost:8788';
