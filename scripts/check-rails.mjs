// scripts/check-rails.mjs — guard against the Discover feed drifting apart.
//
// The rail list exists in three places that MUST agree:
//   web/core/discover-feed.js        the browser (canonical: FEED_KEYS)
//   scripts/prerender-discover.mjs   deploy-time snapshot (derives from FEED_KEYS)
//   deploy/refresh-discover-feed.sh  the on-node cron refresher (standalone)
//
// The shell script can't import the JS — the nodes have no Node runtime — so it
// re-implements the query. That duplication is deliberate but silent: rename a
// rail in one place and a node keeps publishing a feed the client drops on the
// floor, with no error anywhere. This turns that into a build failure.
import { readFile } from 'node:fs/promises';
import { FEED_KEYS } from '../web/core/discover-feed.js';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

const sh = await readFile('deploy/refresh-discover-feed.sh', 'utf8');

// Rails the shell script requests, in `$(page <name> …)` order.
const shellQueryRails = [...sh.matchAll(/\$\(page\s+(\w+)\s/g)].map((m) => m[1]);
// Rails it actually emits, from the jq `rail("…")` calls.
const shellEmitRails = [...sh.matchAll(/rail\("(\w+)"\)/g)].map((m) => m[1]);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

if (!same(shellQueryRails, FEED_KEYS)) {
  fail('deploy/refresh-discover-feed.sh queries different rails than web/core/discover-feed.js\n'
    + `    shell: ${shellQueryRails.join(', ')}\n    app:   ${FEED_KEYS.join(', ')}`);
}
if (!same(shellEmitRails, FEED_KEYS)) {
  fail('deploy/refresh-discover-feed.sh emits different rails than web/core/discover-feed.js\n'
    + `    shell: ${shellEmitRails.join(', ')}\n    app:   ${FEED_KEYS.join(', ')}`);
}

// The client rejects a snapshot without a numeric `at` and a non-empty
// `feed.trending`, so the shell script has to produce exactly that envelope.
if (!/\bat:\s*\(now/.test(sh) || !/\bfeed:\s*\{/.test(sh)) {
  fail('deploy/refresh-discover-feed.sh no longer emits the { at, feed } envelope the client expects');
}

if (!process.exitCode) console.log(`✓ Discover rails agree across app, prerenderer and node script (${FEED_KEYS.length} rails)`);
