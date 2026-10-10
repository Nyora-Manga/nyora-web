# Mobile parity implementation plan

Goal: apply the approved desktop visual language to the mobile web app.
Architecture: shared theme/component styles, explicitly scoped mobile layout; existing route and data services.
Tech stack: ES modules, CSS, Playwright.

- [x] Record current mobile screenshots and identify desktop-only styles affecting shared screens.
- [x] Share theme tokens, align bottom navigation naming/icons and add mobile component layout rules.
- [x] Add browser checks for phone widths, scrolling, filters, focus, themes and breakpoint changes.
- [x] Review screenshots, run mobile and desktop browser suites and production build, document results.
- [ ] Publish through the existing web deployment workflow and verify the live mobile build.

Constraints: preserve security headers, source gate, public manga pages, saved preferences and desktop layouts. No new dependencies. 44px primary touch controls, 16px typing fields, safe-area spacing. Follow the user's existing authorization to implement and deploy web parity; no additional design approval required.
