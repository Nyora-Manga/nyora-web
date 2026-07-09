// Canonical-host redirect (Cloudflare Pages Function middleware).
// Requests on the *.pages.dev preview host are 301'd to the custom domain,
// preserving path + query. Requests already on the custom domain fall through
// to the static asset pipeline (which honours _redirects, incl. the SPA
// fallback) — so no loop and the app still works normally.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "nyoraweb.pages.dev") {
    url.hostname = "nyoramanga.hasanraza.tech";
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
