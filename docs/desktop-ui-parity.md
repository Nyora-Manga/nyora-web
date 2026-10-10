# Desktop presentation in Nyora Web

The browser app now uses the Electron screen composition, rather than only its CSS.
The source reference is nyora-desktop commit `2264b2951cf74281342aef3599fccb90ad115cba`.

`web/desktop/` carries the shell, command dialog, library presentation and filters,
source filter controls and reader helpers from `nyora-desktop/frontend/`.
`browser-services.js` adapts those components to existing browser storage and APIs.
`browser-shell.js` mounts the desktop shell above 760px and restores mobile navigation below it. Both widths keep the shared reading-room theme tokens.
The Settings, Sources, Library, Details, Downloads and Discover render functions
include the corresponding desktop build overlays from `nyora-desktop/scripts/`.
`web/desktop.css` preserves Electron's stylesheet order. Its final browser rules
handle mobile resume-card layout and a stable sync-input outline on focus.

Browser-specific behavior stays explicit: local files require browser selection,
source websites open in another tab, storage management uses browser APIs, and
cloud sync retains the web account implementation. Existing saved themes are kept;
new settings default to the same soft dark surfaces as Electron.

## Verification

```sh
npm ci
npm test
npm run build
npx playwright install chromium
CHROMIUM_CHANNEL=chromium npm run test:desktop
```

To compare against a built Electron checkout, also set
`NYORA_DESKTOP_DIST=../nyora-desktop/dist`. The test checks geometry, typography
and surface colors on Settings, Library, Sources and Downloads using identical
fixture data and viewport sizes. Screenshots go to ignored `test-results/`.
The browser tests also cover pinned scrolling, command navigation, source and
library filters, chapter search, input focus, sidebar collapse and mobile resizing.

`npm run test:reader` against a source server exercises local folders, archives,
offline downloads, reader controls, translation/colorization integration and cleanup.
Network and inference fixtures make these deterministic; they do not measure live
source uptime or translation quality.

When refreshing desktop presentation, port both frontend modules and the screen
overlays, retain browser adapters, and run the optional Electron comparison.

## Mobile presentation

Below 761px, the shared palette and typography accompany a fixed, safe-area-aware
bottom bar: Library, Discover, Sources, Updates and Settings. History, downloads,
local files and bookmarks remain available in the drawer and library controls.
Source filters stay pinned above an independently scrolling source list. Settings
uses category drill-down, and Search has a visible in-page field on phones.
Typing focus changes the field surface without moving it or changing its border.

`npm run test:mobile` checks 320px, 390px and 760px layouts, source pinning and
filters, search submission, library tools, dark/light themes, and breakpoint
transitions. Screenshots are stored in `test-results/mobile-parity/`. Both mobile
and desktop browser suites run before deployment.
