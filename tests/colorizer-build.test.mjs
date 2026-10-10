import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('a colorizer worker update versions its request and updates the app and service worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyora-colorizer-build-'));
  try {
    for (const path of ['web/boot', 'web/core/colorize', 'web/core/translate', 'web/vendor/ort']) await mkdir(join(dir, path), { recursive: true });
    await cp(join(root, 'build.mjs'), join(dir, 'build.mjs'));
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    await cp(join(root, 'web/core/colorize/engine.js'), join(dir, 'web/core/colorize/engine.js'));
    const files = {
      'web/boot/migrate.js': '/* migration */',
      'web/boot/theme.js': '/* theme */',
      'web/app.js': "import {colorizePage} from './core/colorize/engine.js'; globalThis.colorizePage=colorizePage;",
      'web/core/api.js': 'export const api={imageUrl:u=>u};',
      'web/core/colorize/model.js': 'export const colorizeModelCached=async()=>true,loadColorizeModel=async()=>{};',
      'web/core/translate/tl-worker.js': 'self.onmessage=()=>{};',
      'web/vendor/ort/ort.min.mjs': '// Build prerequisite; inference is not run by this test.',
      'web/index.html': '<script src="/boot/migrate.js"></script><script src="/boot/theme.js"></script><script src="/app.js?v=old"></script><link href="/styles.css?v=old">',
      'web/styles.css': 'body{}',
      'web/sw.js': "const VERSION = 'old';",
    };
    for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
    const builds = [];
    for (const revision of ['one', 'two']) {
      await writeFile(join(dir, 'web/core/colorize/worker.js'), `self.postMessage('${revision}');`);
      await exec(process.execPath, ['build.mjs'], { cwd: dir });
      builds.push({
        app: await readFile(join(dir, 'dist/app.js'), 'utf8'),
        html: await readFile(join(dir, 'dist/index.html'), 'utf8'),
        sw: await readFile(join(dir, 'dist/sw.js'), 'utf8'),
      });
    }
    assert.notEqual(builds[0].app, builds[1].app, 'Existing clients must request the updated worker');
    assert.notEqual(builds[0].html, builds[1].html, 'App URL must change with its worker');
    assert.notEqual(builds[0].sw, builds[1].sw, 'Service worker must update with its worker');
    await writeFile(join(dir, 'web/sw.js'), "const VERSION = 'old'; // SW-only repair");
    await exec(process.execPath, ['build.mjs'], { cwd: dir });
    assert.notEqual(await readFile(join(dir, 'dist/index.html'), 'utf8'), builds[1].html, 'SW-only updates must version the shell');
    const beforeBoot = await readFile(join(dir, 'dist/index.html'), 'utf8');
    await writeFile(join(dir, 'web/boot/theme.js'), '/* theme repaired */');
    await exec(process.execPath, ['build.mjs'], { cwd: dir });
    const afterBoot = await readFile(join(dir, 'dist/index.html'), 'utf8');
    assert.notEqual(afterBoot.match(/theme.js\?v=([a-f0-9]+)/)[1], beforeBoot.match(/theme.js\?v=([a-f0-9]+)/)[1], 'Standalone startup scripts must bust the browser cache');
    assert.notEqual(afterBoot.match(/app.js\?v=([a-f0-9]+)/)[1], beforeBoot.match(/app.js\?v=([a-f0-9]+)/)[1], 'Boot-only updates must version the shell');
    assert.equal(await readFile(join(dir, 'dist/boot/migrate.js'), 'utf8'), '/* migration */');
    assert.match(builds[1].app, /\/core\/colorize\/worker\.js\?v=[a-f0-9]+/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
