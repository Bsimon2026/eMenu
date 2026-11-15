/**
 * The machine-readable surface of the site, in one function.
 *
 *   ?doc=sitemap (default)  /sitemap.xml    what may be indexed, with last-modified
 *   ?doc=llms               /llms.txt       the site as a Markdown map for agents
 *   ?doc=openapi            /openapi.json   the public endpoints as OpenAPI 3.1
 *   ?doc=home|terms|privacy / · /terms.html · /privacy.html, as Markdown
 *   ?doc=menu&handle=…      /<handle>       one restaurant's whole menu as Markdown
 *   ?notfound=1             any other path   a 404 that says where everything is
 *
 * One file, because a Vercel Hobby deployment may carry twelve Serverless
 * Functions and the site already needs eleven for its own work — this is the
 * twelfth only when the middleware that negotiates `Accept` is counted. The
 * document bodies live in `api/_lib/agent.js`; what is here is the routing, the
 * status and the cache rule for each.
 *
 * The sitemap and llms.txt share one row query on purpose: both list "what a
 * guest can actually open", so both use the same `isLive()` the guest endpoint
 * applies. A row that says "published" while its free week has ended is dark for
 * guests, and advertising it is worse than having no sitemap at all.
 */

const agent = require("./_lib/agent");
const { rest, configured } = require("./_lib/db");
const { isLive } = require("./_lib/plans");

const BASE = agent.base();

/* Bump when the marketing page or a legal page changes. The restaurant entries
   do not use this: they read the row. */
const PAGE_LASTMOD = "2026-11-15";

function x(s) {
  return String(s == null ? "" : s).replace(/[<>&'"]/g, function (c) {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c];
  });
}

function day(v, fallback) {
  const d = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : fallback;
}

function url(o) {
  return "  <url>\n" +
    "    <loc>" + x(o.loc) + "</loc>\n" +
    (o.lastmod ? "    <lastmod>" + x(o.lastmod) + "</lastmod>\n" : "") +
    (o.changefreq ? "    <changefreq>" + x(o.changefreq) + "</changefreq>\n" : "") +
    (o.priority ? "    <priority>" + x(o.priority) + "</priority>\n" : "") +
    "  </url>\n";
}

/**
 * Every restaurant a guest can open. `published` is the cheap filter; the
 * entitlement test happens in JS, so a column this deployment does not know
 * about cannot empty the file.
 */
async function liveRows() {
  if (!configured) return [];
  const wide = await rest("restaurants?status=eq.published&select=handle,name,city,status,plan,paid_through,trial_ends,updated_at,published_at,created_at&order=updated_at.desc");
  const rows = wide.ok
    ? (wide.data || [])
    : (await rest("restaurants?status=eq.published&select=handle,name,city,status,published_at,created_at&order=created_at.desc")).data || [];
  return rows.filter(function (r) { return r && r.handle && isLive(r); });
}

/* ---------- the documents ---------- */

async function sitemap(req, res) {
  const pages = [
    { loc: BASE + "/", lastmod: PAGE_LASTMOD, changefreq: "weekly", priority: "1.0" },
    { loc: BASE + "/terms.html", lastmod: PAGE_LASTMOD, changefreq: "yearly", priority: "0.3" },
    { loc: BASE + "/privacy.html", lastmod: PAGE_LASTMOD, changefreq: "yearly", priority: "0.3" }
  ];

  const menus = (await liveRows()).map(function (r) {
    return {
      loc: BASE + "/" + encodeURIComponent(r.handle),
      lastmod: day(r.updated_at || r.published_at || r.created_at, PAGE_LASTMOD),
      changefreq: "weekly",
      priority: "0.8"
    };
  });

  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.concat(menus).map(url).join("") +
    "</urlset>\n";

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  /* an hour is plenty: a new restaurant appearing an hour late costs nothing,
     and a crawler hammering this should not cost a database read each time */
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.end(req.method === "HEAD" ? undefined : body);
}

function send(res, status, type, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  if (cache) res.setHeader("Cache-Control", cache);
  return res.end(body);
}

/** The origin this request reached us on, for the same-origin menu read. */
function originOf(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwarded || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  return proto + "://" + host;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};

  res.setHeader("Vary", "Accept");

  /* the catch-all rewrite on Vercel lands here: anything the site does not
     serve. It is checked before the document default, or every missing path
     would answer with the sitemap. */
  if (q.notfound) {
    const miss = agent.notFoundBody({ base: BASE, accept: String(req.headers.accept || "") });
    return send(res, 404, miss.type, miss.body, "no-store");
  }

  const doc = String(q.doc || "sitemap").toLowerCase();
  if (doc === "sitemap") return sitemap(req, res);

  const menusAs = function (rows) {
    return rows.slice(0, 40).map(function (r) {
      return { handle: r.handle, name: r.name || r.handle, city: r.city || "" };
    });
  };

  /* ---------------------------------------------------------- the site map */
  if (doc === "llms") {
    const menus = menusAs(await liveRows());
    return send(res, 200, "text/plain; charset=utf-8", agent.llmsTxt({ base: BASE, menus }),
      "public, s-maxage=3600, stale-while-revalidate=86400");
  }

  /* --------------------------------------------------------- the API contract */
  if (doc === "openapi") {
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(agent.openapiDoc({ base: BASE }), null, 2),
      "public, s-maxage=3600, stale-while-revalidate=86400");
  }

  /* --------------------------------------------------------- page as Markdown */
  if (doc === "home" || doc === "terms" || doc === "privacy") {
    const body = doc === "home" ? agent.homeMarkdown({ base: BASE, menus: menusAs(await liveRows()) })
      : doc === "terms" ? agent.termsMarkdown({ base: BASE })
      : agent.privacyMarkdown({ base: BASE });
    /* served at the page's own URL, so it must not be cached there */
    return send(res, 200, "text/markdown; charset=utf-8", body, "no-store");
  }

  /* --------------------------------------------------- a menu as Markdown */
  if (doc === "menu") {
    const handle = String(q.handle || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(handle)) {
      return send(res, 404, "text/markdown; charset=utf-8",
        agent.notFoundBody({ base: BASE, accept: "text/markdown" }).body, "no-store");
    }
    const data = await agent.fetchMenu(originOf(req), handle);
    if (!data) {
      /* no live menu behind that address: the same 404, in Markdown, because
         that is what the caller asked for */
      return send(res, 404, "text/markdown; charset=utf-8",
        "# 404 — no live menu there\n\nThere is no published menu at `/" + handle + "` on this site. The menus that exist are listed in [" + BASE + "/sitemap.xml](" + BASE + "/sitemap.xml).\n",
        "no-store");
    }
    return send(res, 200, "text/markdown; charset=utf-8", agent.menuMarkdown({
      base: BASE,
      handle: handle,
      restaurant: data.restaurant || {},
      categories: data.categories || [],
      live: true
    }), "no-store");
  }

  /* ------------------------------------------------------------- everything else */
  if (q.doc) {
    return send(res, 200, "text/markdown; charset=utf-8", agent.noMarkdownPage({ base: BASE }), "no-store");
  }

  const miss = agent.notFoundBody({ base: BASE, accept: String(req.headers.accept || "") });
  return send(res, 404, miss.type, miss.body, "no-store");
};