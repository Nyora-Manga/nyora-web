// Nyora Web — environment configuration.
//
// Sets the globals that core/sync.js reads (with a baked fallback). Loaded as a
// classic script before the app module, so the values are in place by the time
// sync.js is imported.
//
// Active profile = production. To point the web app at a local Supabase, comment
// the production block and uncomment the development block, then reload.

// --- Production (active) ---
globalThis.NYORA_SUPABASE_URL = 'https://fqguzcoytnbnjwaddakn.supabase.co';
globalThis.NYORA_SUPABASE_ANON_KEY = 'sb_publishable_RZTcdZZlzb_UhYAxtB09AQ_URTEftE4';
globalThis.NYORA_GOOGLE_WEB_CLIENT_ID = '181067068545-k123p818q8qp0b1ppiee7h6ud8h54ei6.apps.googleusercontent.com';

// --- Local development ---
// globalThis.NYORA_SUPABASE_URL = 'http://localhost:54321';
// globalThis.NYORA_SUPABASE_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
// globalThis.NYORA_GOOGLE_WEB_CLIENT_ID = '181067068545-k123p818q8qp0b1ppiee7h6ud8h54ei6.apps.googleusercontent.com';
