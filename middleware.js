/**
 * Content negotiation, before the filesystem.
 *
 * `Accept: text/markdown` on a page that has a Markdown variant returns the
 * Markdown instead of the HTML — the same URL, the same status, a different
 * representation, with `Vary: Accept` saying so.
 *
 * Why this file exists at all: `vercel.json` rewrites are applied *after* the
 * filesystem is checked, so a rewrite carrying a `has: accept` condition never
 * fires for `/` or `/terms.html` — a static file answers first. Routing
 * Middleware runs before that check, so it is the only layer that can decide
 * this. The `has` rewrites stay in `vercel.json` as the fallback for a build
 * where middleware is not picked up.
 *
 * It fetches the Markdown from `api/agent` over the standard `fetch` rather than
 * using Vercel's rewrite helper: no package to install, nothing to keep in step
 * with a CLI upgrade, and the answer a browser gets is untouched (this function
 * returns nothing for them, which lets the request carry on to the static file).
 */

const DOCS = {
  "/": "home",
  "/index.html": "home",
  "/terms.html": "terms",
  "/privacy.html": "privacy"
};

export const config = {
  /* only the pages that have a Markdown variant, so the HTML path costs nothing */
  matcher: ["/", "/index.html", "/terms.html", "/privacy.html"]
};

export default async function middleware(request) {
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  if (accept.indexOf("text/markdown") === -1) return;

  const { pathname } = new URL(request.url);
  const doc = DOCS[pathname];
  if (!doc) return;

  try {
    const url = new URL(request.url);
    url.pathname = "/api/crawl";
    url.search = "?doc=" + doc;
    const res = await fetch(url.toString(), { headers: { accept: "text/markdown" } });
    const type = String(res.headers.get("content-type") || "");
    /* Only a real Markdown answer may be passed on. On a preview deployment a
       self-fetch can be intercepted by Deployment Protection, and an SSO login
       page returned as "Markdown" would be worse than no variant at all. */
    if (res.status !== 200 || type.indexOf("text/markdown") === -1) return;
    const body = await res.text();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        vary: "Accept",
        /* served at the page's own URL: a cache keyed on the URL must not keep it */
        "cache-control": "no-store"
      }
    });
  } catch (e) {
    /* a broken Markdown variant must never cost the page itself */
    return;
  }
}
