/**
 * Is the site ready for agents? Every promise the machine surface makes, checked
 * against a running copy of the app.
 *
 * The audit that prompted this file scored the live site on exactly these points
 * — entity identity in JSON-LD, sameAs, llms.txt and whether its links resolve,
 * Organization completeness, a 404 a robot can act on, Markdown negotiation, a
 * real OpenAPI document. So each one is an assertion here rather than a one-off
 * curl somebody has to remember:
 *
 *   · JSON-LD parses, carries Organization + WebSite + WebPage + Product +
 *     FAQPage, and the FAQ's questions are the ones a guest can actually read;
 *   · the prices in that JSON-LD are the prices in `api/_lib/plans.js`;
 *   · /llms.txt is shaped the way llmstxt.org asks, and every link in it
 *     returns real content from this server;
 *   · /openapi.json is a valid-enough 3.x document, and every endpoint it names
 *     exists as a file in api/ (so the document cannot drift from the code);
 *   · a missing path answers 404 with a body that names the sitemap, llms.txt and
 *     the OpenAPI file — as HTML, or as Markdown when the caller asked;
 *   · `Accept: text/markdown` returns `text/markdown` with `Vary: Accept`, and a
 *     browser still gets the HTML page at the same URL;
 *   · a restaurant's page answers its whole menu as Markdown when asked;
 *   · nothing that shipped before broke: robots.txt, the sitemap, the assets and
 *     the guest menu still answer.
 *
 * Run: node tools/agent-readiness.js        (no dependencies; boots server.js)
 *      ONLINE=1 node tools/agent-readiness.js   also fetches the off-site links
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PLANS } = require("../api/_lib/plans");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.AGENT_TEST_PORT) || 4173;
const ORIGIN = "http://127.0.0.1:" + PORT;
const ONLINE = process.env.ONLINE === "1";

let failed = 0;
let passed = 0;
let skipped = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log("PASS  " + name); return true; }
  failed++;
  console.log("FAIL  " + name + (detail ? "\n      " + detail : ""));
  return false;
}

function skip(name, why) {
  skipped++;
  console.log("SKIP  " + name + " — " + why);
}

async function get(url, headers) {
  const r = await fetch(url, { headers: Object.assign({ "user-agent": "digimenu-agent-check" }, headers || {}) });
  const body = await r.text();
  return { status: r.status, type: String(r.headers.get("content-type") || ""), vary: String(r.headers.get("vary") || ""), body: body };
}

/* ---------- the server under test ---------- */

function startServer() {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    /* so every link the machine surface prints points back at this test server
       and can actually be fetched — a link nobody opens is not verified */
    PUBLIC_BASE: ORIGIN
  });
  const args = ["server.js"];
  if (fs.existsSync(path.join(ROOT, ".env"))) args.unshift("--env-file=.env");
  const child = spawn(process.execPath, args, { cwd: ROOT, env: env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", function () {});
  child.stderr.on("data", function (d) { process.stderr.write("[server] " + d); });
  return child;
}

async function waitForServer(ms) {
  const until = Date.now() + (ms || 12000);
  while (Date.now() < until) {
    try {
      const r = await fetch(ORIGIN + "/robots.txt");
      if (r.status === 200) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(function (r) { setTimeout(r, 200); });
  }
  return false;
}

/* ---------- JSON-LD ---------- */

function ldBlocks(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function graphs(html) {
  return ldBlocks(html).map(function (raw) {
    try { return JSON.parse(raw); } catch (e) { return { __error: String(e.message) }; }
  });
}

function flatten(node, acc) {
  acc = acc || [];
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) { node.forEach(function (n) { flatten(n, acc); }); return acc; }
  if (node["@graph"]) flatten(node["@graph"], acc);
  else acc.push(node);
  return acc;
}

/* ---------- the run ---------- */

async function main() {
  const child = startServer();
  const up = await waitForServer();
  if (!up) {
    child.kill();
    console.log("FAIL  the test server did not start on " + ORIGIN);
    process.exit(1);
  }

  try {
    /* ---------------------------------------------------------- the home page */
    const home = await get(ORIGIN + "/");
    check("/ answers 200 as HTML", home.status === 200 && /text\/html/.test(home.type),
      "status " + home.status + " · " + home.type);
    check("/ varies on Accept", /accept/i.test(home.vary), "Vary: " + (home.vary || "(none)"));

    const docs = graphs(home.body);
    const broken = docs.filter(function (d) { return d.__error; });
    check("every JSON-LD block on / parses",
      docs.length > 0 && broken.length === 0,
      broken.length ? broken[0].__error : "no ld+json on the page");

    const nodes = flatten(docs);
    const byType = function (t) {
      return nodes.filter(function (n) {
        const ty = n["@type"];
        return Array.isArray(ty) ? ty.indexOf(t) !== -1 : ty === t;
      });
    };
    const org = byType("Organization")[0];
    const site = byType("WebSite")[0];
    const page = byType("WebPage")[0];
    const product = byType("Product")[0];
    const app = byType("SoftwareApplication")[0];
    const faq = byType("FAQPage")[0];

    check("Organization schema is present", Boolean(org));
    check("WebSite schema is present", Boolean(site));
    check("WebPage schema is present", Boolean(page));
    check("Product schema is present", Boolean(product));
    check("SoftwareApplication schema is present", Boolean(app));
    check("FAQPage schema is present", Boolean(faq));

    if (org) {
      const need = ["name", "url", "logo", "description", "email", "telephone", "address", "contactPoint", "sameAs"];
      const missing = need.filter(function (k) { return !org[k]; });
      check("Organization carries name, url, logo, description, contactPoint and address",
        missing.length === 0, "missing: " + missing.join(", "));
      check("Organization logo is an absolute https URL",
        Boolean(org.logo && /^https:\/\//.test(org.logo.url || "")), JSON.stringify(org.logo));
      const cp = Array.isArray(org.contactPoint) ? org.contactPoint[0] : org.contactPoint;
      check("Organization contactPoint has a telephone and an email",
        Boolean(cp && cp.telephone && cp.email), JSON.stringify(cp));
      const addr = org.address || {};
      check("Organization address names a locality and a country",
        Boolean(addr.addressLocality && addr.addressCountry), JSON.stringify(addr));
      const sameAs = Array.isArray(org.sameAs) ? org.sameAs : [];
      check("Organization sameAs links external profiles", sameAs.length > 0,
        "sameAs is empty — an assistant has nothing to corroborate the entity with");
      check("every sameAs entry is an absolute https URL",
        sameAs.every(function (u) { return /^https:\/\//.test(u); }), sameAs.join(" "));
    }

    if (faq) {
      const qs = (faq.mainEntity || []).map(function (q) { return q.name || ""; });
      check("FAQPage carries at least four questions", qs.length >= 4, "found " + qs.length);
      const visible = qs.filter(function (q) { return q && home.body.indexOf(q.replace(/&/g, "&amp;")) !== -1; });
      check("every FAQ answer is a question the page actually shows",
        visible.length === qs.length,
        "not on the page: " + qs.filter(function (q) { return visible.indexOf(q) === -1; }).join(" | "));
      check("every FAQ question has an accepted answer",
        (faq.mainEntity || []).every(function (q) { return q.acceptedAnswer && q.acceptedAnswer.text; }));
    }

    /* the JSON-LD prices are the prices the code charges — a second copy of a
       price is how the site and the till drifted apart before */
    if (product) {
      const offers = product.offers || [];
      const want = [
        { name: PLANS.qr.label, price: String(PLANS.qr.price.yearly) },
        { name: PLANS.order.label, price: String(PLANS.order.price.monthly) },
        { name: PLANS.pro.label, price: String(PLANS.pro.price.monthly) }
      ];
      const bad = want.filter(function (w) {
        const o = offers.filter(function (x) { return x.name === w.name; })[0];
        return !o || String(o.price) !== w.price;
      });
      check("the JSON-LD offers carry the prices in api/_lib/plans.js",
        offers.length === 3 && bad.length === 0,
        bad.length ? "off by: " + JSON.stringify(bad) : "offers: " + JSON.stringify(offers.map(function (o) { return o.name + " " + o.price; })));
    }

    /* the legal pages carry a breadcrumb, and are still plain pages */
    for (const p of ["/terms.html", "/privacy.html"]) {
      const r = await get(ORIGIN + p);
      check(p + " still answers 200 as HTML", r.status === 200 && /text\/html/.test(r.type), r.status + " " + r.type);
      const ns = flatten(graphs(r.body));
      check(p + " carries a BreadcrumbList", ns.some(function (n) { return n["@type"] === "BreadcrumbList"; }));
    }

    /* -------------------------------------------------------------- llms.txt */
    const llms = await get(ORIGIN + "/llms.txt");
    check("/llms.txt answers 200", llms.status === 200, "status " + llms.status);
    check("/llms.txt is served as text (not HTML)",
      /text\/plain|text\/markdown/.test(llms.type), llms.type);
    const lines = llms.body.split(/\r?\n/);
    check("/llms.txt opens with an H1", /^# \S/.test(lines[0] || ""), "first line: " + JSON.stringify(lines[0]));
    check("/llms.txt has a blockquote summary before the sections",
      (function () {
        const firstSection = lines.findIndex(function (l) { return /^## /.test(l); });
        const quote = lines.findIndex(function (l) { return /^> \S/.test(l); });
        return quote > 0 && (firstSection === -1 || quote < firstSection);
      })(), "no '>' blockquote above the first '## ' section");
    check("/llms.txt has at least three '## ' sections",
      lines.filter(function (l) { return /^## \S/.test(l); }).length >= 3);

    const links = [];
    const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
    let lm;
    while ((lm = linkRe.exec(llms.body))) links.push({ text: lm[1], url: lm[2] });
    check("/llms.txt carries at least six links", links.length >= 6, "found " + links.length);
    check("every llms.txt link is an absolute URL (the reader has no base to resolve against)",
      links.every(function (l) { return /^https?:\/\//i.test(l.url); }),
      links.filter(function (l) { return !/^https?:\/\//i.test(l.url); }).map(function (l) { return l.url; }).join(" "));

    for (const l of links) {
      const local = l.url.indexOf(ORIGIN) === 0;
      const external = !local;
      if (external && !ONLINE) { skip("llms.txt link " + l.url, "off-site; set ONLINE=1 to fetch it"); continue; }
      let r;
      try { r = await fetch(l.url, { redirect: "follow" }); } catch (e) {
        check("llms.txt link resolves: " + l.url, false, String(e.message));
        continue;
      }
      const body = await r.text();
      check("llms.txt link resolves with real content: " + l.url.replace(ORIGIN, "") ,
        r.status === 200 && body.trim().length > 40,
        "status " + r.status + " · " + body.length + " bytes");
    }

    /* ---------------------------------------------------------- openapi.json */
    const specRes = await get(ORIGIN + "/openapi.json");
    check("/openapi.json answers 200", specRes.status === 200, "status " + specRes.status);
    check("/openapi.json is application/json", /application\/json/.test(specRes.type), specRes.type);
    let spec = null;
    try { spec = JSON.parse(specRes.body); } catch (e) { /* reported below */ }
    check("the OpenAPI document is valid JSON", Boolean(spec));
    if (spec) {
      check("it declares an OpenAPI 3.x version", /^3\./.test(String(spec.openapi)), String(spec.openapi));
      check("it has info.title and info.version",
        Boolean(spec.info && spec.info.title && spec.info.version), JSON.stringify(spec.info));
      const paths = spec.paths || {};
      check("it has a paths object with at least three paths", Object.keys(paths).length >= 3,
        Object.keys(paths).join(" "));
      const ops = [];
      Object.keys(paths).forEach(function (p) {
        Object.keys(paths[p]).forEach(function (method) {
          if (["get", "post", "put", "patch", "delete"].indexOf(method) !== -1) ops.push({ p: p, m: method, o: paths[p][method] });
        });
      });
      check("every operation has a responses object",
        ops.every(function (x) { return x.o.responses && Object.keys(x.o.responses).length; }),
        ops.filter(function (x) { return !(x.o.responses && Object.keys(x.o.responses).length); }).map(function (x) { return x.m + " " + x.p; }).join(" "));
      /* the document names code that has to exist: a renamed handler must break
         this check rather than leave the contract describing a dead endpoint */
      const ghost = ops.map(function (x) { return x.p; })
        .filter(function (p) { return /^\/api\//.test(p); })
        .filter(function (p) {
          const file = path.join(ROOT, "api", p.replace(/^\/api\//, "") + ".js");
          return !fs.existsSync(file);
        });
      check("every /api path in the document exists in api/", ghost.length === 0, ghost.join(" "));
    }

    /* ---------------------------------------------------------- the 404 page */
    const miss = await get(ORIGIN + "/no/such/deep/path");
    check("a missing path answers 404", miss.status === 404, "status " + miss.status);
    check("the 404 body names the sitemap, llms.txt and the OpenAPI file",
      /\/sitemap\.xml/.test(miss.body) && /\/llms\.txt/.test(miss.body) && /\/openapi\.json/.test(miss.body));
    check("the 404 is HTML for a browser", /text\/html/.test(miss.type), miss.type);

    const missMd = await get(ORIGIN + "/no/such/deep/path", { accept: "text/markdown" });
    check("the 404 is Markdown when Markdown was asked for",
      missMd.status === 404 && /text\/markdown/.test(missMd.type) && /^# /.test(missMd.body.trim()),
      missMd.status + " " + missMd.type);

    /* On Vercel a missing path is rewritten here by the catch-all in
       vercel.json, so the flag — not the path — decides the status. A 200 with
       a sitemap in the body is the failure this catches. */
    const flag = await get(ORIGIN + "/api/crawl?notfound=1");
    check("the catch-all's notfound flag answers 404, never the default document",
      flag.status === 404 && !/<urlset/.test(flag.body) && /llms\.txt/.test(flag.body),
      flag.status + " " + flag.type);

    /* --------------------------------------------------- content negotiation */
    const md = await get(ORIGIN + "/", { accept: "text/markdown" });
    check("Accept: text/markdown on / returns Markdown",
      md.status === 200 && /text\/markdown/.test(md.type), md.status + " " + md.type);
    check("the Markdown variant says what page it is", /^# \S/.test(md.body.trim()), JSON.stringify(md.body.slice(0, 40)));
    check("the Markdown variant is not the HTML page", md.body.indexOf("<html") === -1);
    check("Markdown responses carry Vary: Accept", /accept/i.test(md.vary), "Vary: " + (md.vary || "(none)"));
    check("the Markdown variant is not cached at the page's URL",
      /no-store|private/.test(String((await fetch(ORIGIN + "/", { headers: { accept: "text/markdown" } })).headers.get("cache-control") || "")),
      "a CDN keyed on the URL would hand this to the next browser");

    const browser = await get(ORIGIN + "/", { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });
    check("a browser still gets the HTML page at the same URL",
      /text\/html/.test(browser.type) && browser.body.indexOf("DigiMenu") !== -1, browser.type);

    const termsMd = await get(ORIGIN + "/terms.html", { accept: "text/markdown" });
    check("Accept: text/markdown on /terms.html returns Markdown",
      /text\/markdown/.test(termsMd.type) && /Terms of Service/i.test(termsMd.body), termsMd.type);

    const q0 = await get(ORIGIN + "/", { accept: "text/html, text/markdown;q=0" });
    check("text/markdown;q=0 is respected (HTML, not Markdown)",
      /text\/html/.test(q0.type), q0.type);

    /* ------------------------------------------------- a menu as Markdown */
    const menuSection = llms.body.split(/^## /m).filter(function (s) { return /^Live menus/.test(s); })[0];
    const handle = menuSection ? ((menuSection.match(/\(https?:\/\/[^)]*\/([a-z0-9][a-z0-9-]{2,31})\)/) || [])[1]) : null;
    if (!handle) {
      skip("a restaurant's page answers Markdown", "no live menu found in llms.txt (database not reachable?)");
    } else {
      const m1 = await get(ORIGIN + "/" + handle, { accept: "text/markdown" });
      check("/" + handle + " answers Markdown when asked",
        m1.status === 200 && /text\/markdown/.test(m1.type), m1.status + " " + m1.type);
      check("/" + handle + " as Markdown carries dishes and prices",
        /^# /.test(m1.body.trim()) && /## /.test(m1.body) && /AED|USD|EUR/.test(m1.body),
        "no heading, no sections or no price in the body");
      const m2 = await get(ORIGIN + "/" + handle);
      check("/" + handle + " is still the HTML menu for a browser",
        /text\/html/.test(m2.type) && /menu\.js/.test(m2.body), m2.type);
    }

    /* ------------------------------------------------------- nothing broke */
    const robots = await get(ORIGIN + "/robots.txt");
    check("/robots.txt still answers", robots.status === 200 && /Sitemap:/.test(robots.body));
    const map = await get(ORIGIN + "/sitemap.xml");
    check("/sitemap.xml still answers XML",
      map.status === 200 && /xml/.test(map.type) && /<urlset/.test(map.body), map.status + " " + map.type);
    const css = await get(ORIGIN + "/assets/landing.css");
    check("/assets still answer", css.status === 200 && /text\/css/.test(css.type), css.status + " " + css.type);
    const guest = await get(ORIGIN + "/menu.html");
    check("/menu.html still answers", guest.status === 200 && /text\/html/.test(guest.type), guest.status);
  } finally {
    child.kill();
  }

  console.log("\n" + passed + " passed · " + failed + " failed · " + skipped + " skipped");
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.log("FAIL  the check itself threw: " + (e && e.stack || e));
  process.exit(1);
});
