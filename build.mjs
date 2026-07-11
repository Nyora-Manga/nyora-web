// Production build for Cloudflare Pages.
//
// The app is authored as ~60 unbundled ES modules (great for local dev — just
// serve web/ with no build step). On a cold first visit that's ~60 chained
// network requests, which is slow. This script bundles web/app.js into a handful
// of content-hashed, code-split chunks (esbuild, ESM) and emits a dist/ that the
// CI deploys instead of the raw web/. Local dev is untouched.
//
//   web/  →  edit + serve unbundled (python3 -m http.server in web/)
//   dist/ →  built bundle, deployed to nyoraweb.pages.dev
import { build } from 'esbuild';
import { rm, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SRC = 'web';
const OUT = 'dist';

// 1. Fresh dist/ that mirrors every static asset (html, css, env.js, sw.js,
//    icons, manifest, _redirects, sources.json, …). The source .js modules are
//    copied too but go unused — the bundle below inlines them.
await rm(OUT, { recursive: true, force: true });
await cp(SRC, OUT, { recursive: true });

// 2. Bundle the entry over the copied tree (overwrites dist/app.js, adds chunks).
await build({
  entryPoints: [`${SRC}/app.js`],
  outdir: OUT,
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  entryNames: 'app',
  chunkNames: 'chunk-[hash]',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'info',
});

// 3. Cache-bust id from the bundled entry's bytes.
const id = createHash('sha256').update(await readFile(`${OUT}/app.js`)).digest('hex').slice(0, 8);

// 4. Point index.html at the freshly bundled app.js and refresh the SW version
//    so the new bundle reaches returning visitors.
let html = await readFile(`${OUT}/index.html`, 'utf8');
html = html.replace(/\/app\.js\?v=[\w-]+/g, `/app.js?v=${id}`);
// Version styles.css by its content hash too, so CSS edits bust the cache
// automatically (it was pinned at a hand-bumped ?v= that got forgotten).
const cssId = createHash('sha256').update(await readFile(`${OUT}/styles.css`)).digest('hex').slice(0, 8);
html = html.replace(/\/styles\.css\?v=[\w-]+/g, `/styles.css?v=${cssId}`);
await writeFile(`${OUT}/index.html`, html);

let sw = await readFile(`${OUT}/sw.js`, 'utf8');
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = 'nyora-${id}';`);
await writeFile(`${OUT}/sw.js`, sw);

// 5. Hard-cache the immutable, content-hashed chunks (everything else keeps the
//    Pages default revalidate behaviour).
const existing = await readFile(`${SRC}/_headers`, 'utf8').catch(() => '');
await writeFile(`${OUT}/_headers`,
`# Content-hashed bundle chunks — safe to cache forever.
/chunk-*.js
  Cache-Control: public, max-age=31536000, immutable
/api-*.js
  Cache-Control: public, max-age=31536000, immutable
/zip-*.js
  Cache-Control: public, max-age=31536000, immutable
${existing}`);

console.log(`✓ built ${OUT}/  (bundle id ${id})`);
