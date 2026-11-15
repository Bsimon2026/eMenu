/**
 * Content negotiation, before the filesystem.
 *
 * `Accept: text/markdown` on a page that has a Markdown variant returns the
 * Markdown instead of the HTML — the same URL, the same status, a different
 * representation, with `Vary: Accept` saying so.
 *
 * Why middleware and not a `has: accept` rewrite in vercel.json: rewrites are
 * applied *after* the filesystem check, so a conditional rewrite never fires for
 * `/` or `/terms.html` — a static file answers first. This layer runs before both
 * the filesystem and the CDN cache, which matters for the restaurant pages too:
 * their HTML sits in the edge cache under `/<handle>`, the CDN keys on the URL
 * alone, and a negotiation done inside the page function therefore gets the
 * cached HTML back for a client that asked for Markdown.
 *
 * It fetches the Markdown from `api/crawl` over the standard `fetch` rather than
 * using Vercel's rewrite helper: nothing to install, nothing to keep in step with
 * a CLI upgrade, and a browser's request is untouched — this function returns
 * nothing for them, which lets the request carry on to the page.
 */

const DOCS = {
  "/": "home",
  "/index.html": "home",
  "/terms.html": "terms",
  "/privacy.html": "privacy"
};

/* `/login`, `/app` and the rest are rewrites to pages, not restaurants, even
   though they match the handle shape. */
const RESERVED = {
  login: 1, app: 1, menu: 1, superadmin: 1, feedback: 1, digimenu: 1, assets: 1, api: 1,
  terms: 1, privacy: 1, index: 1, robots: 1, llms: 1, openapi: 1, sitemap: 1, favicon: 1
};

const HANDLE = /^\/([a-z0-9][a-z0-9-]{2,31})\/?$/;

export const config = {
  /* the pages with a Markdown variant, then any single-segment menu address;
     nothing else costs an invocation */
  matcher: [
    "/",
    "/index.html",
    "/terms.html",
    "/privacy.html",
    "/:handle([a-z0-9][a-z0-9-]{2,31})"
  ]
};

export default async function middleware(request) {
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  if (accept.indexOf("text/markdown") === -1) return;

  const { pathname } = new URL(request.url);
  let doc = DOCS[pathname];
  let extra = "";
  if (!doc) {
    const m = pathname.match(HANDLE);
    if (!m || RESERVED[m[1]]) return;
    doc = "menu";
    extra = "&handle=" + m[1];
  }

  try {
    const url = new URL(request.url);
    url.pathname = "/api/crawl";
    url.search = "?doc=" + doc + extra;
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
