/**
 * GET /sitemap.xml   (rewritten here from /sitemap.xml)
 *
 * What search engines may index, and when it last changed:
 *   · the marketing page and the two legal pages;
 *   · every restaurant whose menu is LIVE — published and subscribed. A row that
 *     says "published" while its free week has ended is dark for guests, and a
 *     sitemap that advertises a 404 is worse than no sitemap: `isLive` is the
 *     same test the guest endpoint applies.
 *
 * Not listed, and not indexable (see robots.txt): /login, /app, /superadmin,
 * /feedback, the bare /menu.html shell and the old landing-page backup.
 *
 * The restaurant entries carry <lastmod> from the row's own updated_at, so a
 * price change is visible to a crawler without anybody remembering to bump a
 * number here.
 */

const { rest, configured } = require("./_lib/db");
const { isLive } = require("./_lib/plans");

const BASE = (process.env.PUBLIC_BASE || "https://digimenu.indubaicity.com").replace(/\/+$/, "");

/* Bump when the marketing page or a legal page changes. The restaurant entries
   do not use this: they read the row. */
const PAGE_LASTMOD = "2026-11-14";

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

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }

  const pages = [
    { loc: BASE + "/", lastmod: PAGE_LASTMOD, changefreq: "weekly", priority: "1.0" },
    { loc: BASE + "/terms.html", lastmod: PAGE_LASTMOD, changefreq: "yearly", priority: "0.3" },
    { loc: BASE + "/privacy.html", lastmod: PAGE_LASTMOD, changefreq: "yearly", priority: "0.3" }
  ];

  let rows = [];
  if (configured) {
    /* published is the cheap filter; the entitlement test happens below, so a
       column this deployment does not know about cannot empty the sitemap */
    const q = await rest("restaurants?status=eq.published&select=handle,status,plan,paid_through,trial_ends,updated_at,published_at,created_at&order=updated_at.desc");
    if (q.ok) rows = q.data || [];
    else {
      const fallback = await rest("restaurants?status=eq.published&select=handle,status,published_at,created_at&order=created_at.desc");
      rows = fallback.ok ? (fallback.data || []) : [];
    }
  }

  const menus = rows
    .filter(function (r) { return r && r.handle && isLive(r); })
    .map(function (r) {
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
};
