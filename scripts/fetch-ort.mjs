// scripts/fetch-ort.mjs — fetch the onnxruntime-web runtime into web/vendor/ort/.
//
// These files are NOT committed: the wasm alone is 24 MB, which is a lot of
// permanent git history for a build artefact. CI fetches them before building
// (see .github/workflows/deploy.yml); locally, run `npm run fetch:ort` once.
//
// The whole point of self-hosting was to stop executing unverified third-party
// code, so downloading it here would defeat itself without a check — every file
// is verified against a pinned SHA-256 below and a mismatch is a hard failure.
// Regenerate the hashes only when deliberately bumping ORT_VERSION:
//   shasum -a 256 web/vendor/ort/*
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const ORT_VERSION = '1.21.0';
const OUT = 'web/vendor/ort';

const SHA256 = {
  'ort.min.mjs': 'f04e7c794f156c0e2b109497456c3abea148f4c8bd234230e94bc2f571716a92',
  'ort-wasm-simd-threaded.jsep.mjs': 'b69c8812bf2d8356dd248fef0abb35e22d1f05f9c593ca34d4b942f35ea93592',
  'ort-wasm-simd-threaded.jsep.wasm': '0663b902fb3937883a34375926bdfe3e1c86cd4c99cbc04c06a7cdf46c78bdde',
  'ort-wasm-simd-threaded.mjs': 'e9ba2350c370278fc90108f1514fb9ce6a4051341ab977b5b0dca7eca9e78dfa',
  'ort-wasm-simd-threaded.wasm': '06b3f98e5aa2fffec1e3ac57a48bf1073828c6624e14d210750bc596c2e35d65',
};

const digest = (buf) => createHash('sha256').update(buf).digest('hex');

await mkdir(OUT, { recursive: true });

let fetched = 0;
let cached = 0;
for (const [name, want] of Object.entries(SHA256)) {
  const dest = `${OUT}/${name}`;
  // Already present and correct → skip. Keeps repeat local runs instant, and
  // re-verifies rather than trusting whatever is on disk.
  const have = await readFile(dest).catch(() => null);
  if (have && digest(have) === want) { cached++; continue; }

  const url = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch-ort: ${name} failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  const got = digest(buf);
  if (got !== want) {
    throw new Error(
      `fetch-ort: ${name} FAILED INTEGRITY CHECK\n  expected ${want}\n  got      ${got}\n`
      + '  Refusing to write it. If you intentionally bumped ORT_VERSION, update SHA256 above.',
    );
  }
  await writeFile(dest, buf);
  fetched++;
  console.log(`  ✓ ${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

console.log(`✓ onnxruntime-web ${ORT_VERSION} ready in ${OUT}/ (${fetched} fetched, ${cached} already valid)`);
