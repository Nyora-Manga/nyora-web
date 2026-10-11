// The shipped "What's new" version. Browser tests mark it seen so the changelog
// dialog cannot cover the page — read it from the source so a version bump
// never needs a test edit.
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/core/changelog.js', import.meta.url), 'utf8');
export const APP_VERSION = /export const APP_VERSION = '([^']+)'/.exec(source)[1];

// Register on a Playwright BrowserContext or Page, after its other init scripts.
export const markChangelogSeen = (target) =>
  target.addInitScript((version) => localStorage.setItem('nyora.changelog.seen', version), APP_VERSION);
