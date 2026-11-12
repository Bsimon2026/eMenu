/**
 * GET /<handle>   (rewritten here from /:handle)
 *
 * The guest menu, served with the restaurant's own title and share card.
 *
 * Why a function and not just menu.html: WhatsApp, Facebook, X and every other
 * preview fetcher read the <head> of the HTML response and never run the
 * JavaScript. A static page can only ever say one thing, which is why every
 * restaurant's link previewed as "DigiMenu". Here the head is filled in before
 * the page is sent; the body is the same menu.html the site already serves.
 *
 * If anything below fails, the untouched menu.html goes out. A share card is
 * never worth a broken menu.
 */
const { rest, configured } = require("../_lib/db");

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[<>&"]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function abs(url, base) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.charAt(0) === "/" ? "" : "/") + u;
}

module.exports = async function page(req, res) {
  const handle = String((req.query && req.query.handle) || "").toLowerCase();
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  const base = proto + "://" + host;

  let html = "";
  try {
    const r = await fetch(base + "/menu.html", { headers: { "user-agent": "digimenu-page" } });
    if (r.ok) html = await r.text();
  } catch (e) {
    /* fall through to the redirect */
  }

  if (!html) {
    res.statusCode = 302;
    res.setHeader("Location", "/menu.html");
    return res.end();
  }

  try {
    if (configured && handle) {
      const q = await rest(
        "restaurants?handle=eq." + encodeURIComponent(handle) +
        "&status=eq.published&select=name,tagline,city,logo_url,cover_url"
      );
      const row = (q.ok && (q.data || [])[0]) || null;

      if (row && row.name) {
        const name = clean(row.name, 80);
        const desc = clean(row.tagline || (row.city ? row.city + " \u2014 the live menu" : "The live menu"), 160);
        const img = abs(row.cover_url || row.logo_url, base) || (base + "/assets/favicon-512.png");
        const url = base + "/" + encodeURIComponent(handle);

        const tags = [
          "<title>" + name + " \u2014 Menu</title>",
          '<meta name="description" content="' + desc + '">',
          '<meta property="og:type" content="website">',
          '<meta property="og:site_name" content="DigiMenu">',
          '<meta property="og:title" content="' + name + '">',
          '<meta property="og:description" content="' + desc + '">',
          '<meta property="og:image" content="' + img + '">',
          '<meta property="og:url" content="' + url + '">',
          '<meta name="twitter:card" content="summary_large_image">',
          '<meta name="twitter:title" content="' + name + '">',
          '<meta name="twitter:image" content="' + img + '">'
        ].join("\n");

        html = html.replace(/<!--DM_META_START-->[\s\S]*?<!--DM_META_END-->/, tags);
      }
    }
  } catch (e) {
    /* the menu still works; only the card stays generic */
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(200).send(html);
};
