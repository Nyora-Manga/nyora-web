// Canonical-host redirect (Cloudflare Pages Function middleware).
//
// web.nyora.xyz is the canonical app domain (served from the VM). The legacy CF
// Pages hosts below are redirected here.
//
// Two paths, on purpose:
//   • Crawlers / bots / non-navigation requests (assets, fetches, link
//     previews)               -> hard 301 to web.nyora.xyz. Clean SEO signal,
//                                 no dependence on JavaScript.
//   • A real browser PAGE navigation -> fall through to index.html, whose
//                                 synchronous <head> script redirects to
//                                 web.nyora.xyz AND first carries the visitor's
//                                 local library (favourites / history /
//                                 bookmarks / prefs) across the origin boundary.
//                                 A plain 301 cannot move localStorage between
//                                 origins, so we must let that script run.
//
// Preview *.pages.dev deploy hosts are intentionally NOT redirected, so deploy
// previews stay viewable. Requests already on web.nyora.xyz never reach this
// Function (that host is on the VM), so there is no redirect loop.
const CANONICAL = "web.nyora.xyz";
const LEGACY = new Set(["nyoraweb.pages.dev", "nyoramanga.hasanraza.tech"]);

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (LEGACY.has(url.hostname)) {
    const isBrowserNav =
      request.headers.get("sec-fetch-mode") === "navigate" &&
      (request.headers.get("accept") || "").includes("text/html");

    if (!isBrowserNav) {
      url.hostname = CANONICAL;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
  }
  return context.next();
}
