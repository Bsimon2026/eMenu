/**
 * server.js — the whole app in one process.
 *
 * Vercel runs one function per file in api/. Hostinger runs one Node process, so
 * this file does what the platform did for us: route /api/<name> to the very same
 * handlers (unchanged), serve the static site, and rewrite a handle to menu.html.
 *
 * Zero dependencies on purpose — `npm install` has nothing to do, and the host
 * cannot break us with a transitive dependency.
 *
 * The machine-readable surface mirrors `vercel.json` route for route, so both
 * hosts answer an agent the same way: /llms.txt and /openapi.json are generated
 * by `api/agent.js`, `Accept: text/markdown` on a page is served by that same
 * handler, and a 404 carries a body that says where everything is.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const agentSurface = require("./api/_lib/agent");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const MAX_JSON_BYTES = 4 * 1024 * 1024; /* upload.js allows a 2.5 MB base64 payload */

/* Only these exist at the top level. Anything else is a 404 — which is what keeps
   .env, db/, tools/, _preview/ and .git unreachable even though they sit in the
   deployed folder. */
const STATIC_FILES = new Set([
  "index.html", "login.html", "app.html", "menu.html",
  "terms.html", "privacy.html", "feedback.html", "superadmin.html",
  "favicon.ico", "site.webmanifest", "robots.txt",
]);
const STATIC_DIRS = ["assets"];

const HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/i;

/* Pages that have a Markdown variant, and the document each one maps to. */
const MD_PAGES = {
  "/": "home", "/index.html": "home",
  "/digimenu": "home", "/digimenu/": "home",
  "/terms.html": "terms", "/privacy.html": "privacy",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/* ---------- response helpers Vercel gave us, now ours ---------- */

function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (res.writableEnded) return res;
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", MIME[".json"]);
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (res.writableEnded) return res;
    if (typeof body === "object" && body !== null) return res.json(body);
    res.end(body == null ? "" : String(body));
    return res;
  };
  return res;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") return resolve(undefined);
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) { reject(Object.assign(new Error("Payload too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
    req.on("error", reject);
  });
}

/* ---------- static ---------- */

function sendFile(req, res, filePath) {
  fs.stat(filePath, (e, st) => {
    if (e || !st.isFile()) return notFound(res, false, req.headers.accept);
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Content-Length", st.size);
    /* html changes on deploy; assets are cache-busted with ?v= */
    res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=3600");
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).on("error", () => res.end()).pipe(res);
  });
}

/**
 * A 404 worth reading: the sitemap, the agent map and the API contract, instead
 * of a stock page. `json` keeps the API's answer a machine code, and the body is
 * Markdown when the caller asked for Markdown.
 */
function notFound(res, json, accept) {
  res.statusCode = 404;
  res.setHeader("Cache-Control", "no-store");
  if (json) return res.json({ ok: false, code: "NOT_FOUND" });
  const page = agentSurface.notFoundBody({ accept });
  res.setHeader("Content-Type", page.type);
  res.end(page.body);
  return undefined;
}

/** Resolve a URL path to a file we are willing to serve, or null. */
function resolveStatic(pathname) {
  if (pathname === "/" || pathname === "" || pathname === "/digimenu" || pathname === "/digimenu/") {
    return path.join(ROOT, "index.html");
  }
  const clean = path.posix.normalize(decodeURIComponent(pathname)).replace(/^(\.\.\/)+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length) return path.join(ROOT, "index.html");

  if (parts[0] === "digimenu") parts.shift();           /* legacy /digimenu prefix */
  if (!parts.length) return path.join(ROOT, "index.html");

  const [head] = parts;
  const allowed = STATIC_FILES.has(head) || STATIC_DIRS.includes(head);
  if (!allowed) return null;

  const filePath = path.join(ROOT, ...parts);
  if (!filePath.startsWith(ROOT + path.sep)) return null;   /* traversal */
  return filePath;
}

/* ---------- api ---------- */

const handlerCache = new Map();
/* /api/orders lives inside order.js to stay under Vercel's function limit */
const ALIAS = { orders: "order" };

function loadHandler(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  const file = ALIAS[name] || name;
  if (handlerCache.has(file)) return handlerCache.get(file);
  let fn = null;
  try {
    fn = require(path.join(ROOT, "api", file + ".js"));
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") console.error("[api] failed to load", file, e && e.message);
  }
  handlerCache.set(file, fn);
  return fn;
}

async function serveApi(req, res, pathname, query) {
  const name = pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, apikey");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (name === "health") {
    return res.status(200).json({ ok: true, app: "digimenu", node: process.version, uptime: Math.round(process.uptime()) });
  }

  const handler = loadHandler(name);
  if (!handler) return notFound(res, true);

  req.query = Object.fromEntries(query.entries());
  try {
    req.body = await readJsonBody(req);
  } catch (e) {
    return res.status(e.code || 400).json({ ok: false, code: "BODY", message: e.message });
  }

  try {
    await handler(req, res);
    if (!res.writableEnded) res.end();
  } catch (e) {
    console.error("[api]", name, e && (e.stack || e.message));
    if (!res.writableEnded) res.status(500).json({ ok: false, code: "SERVER" });
  }
  return undefined;
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  decorate(res);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  /* the answer to a URL depends on what the client said it accepts */
  res.setHeader("Vary", "Accept");

  let parsed;
  try {
    parsed = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch {
    return notFound(res, false, req.headers.accept);
  }
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) return serveApi(req, res, pathname, parsed.searchParams);

  /* the sitemap is generated, not a file: it lists every live menu with its
     last-modified date */
  if (pathname === "/sitemap.xml") return serveApi(req, res, "/api/crawl", new URLSearchParams("doc=sitemap"));

  /* the agent map and the API contract, generated by the handler both hosts use
     (see vercel.json for the rewrites that do this on Vercel) */
  if (pathname === "/llms.txt") return serveApi(req, res, "/api/crawl", new URLSearchParams("doc=llms"));
  if (pathname === "/openapi.json") return serveApi(req, res, "/api/crawl", new URLSearchParams("doc=openapi"));

  /* the short order link in the guest's mail: /s/<order id> — same handler the
     Vercel rewrite reaches, so one implementation serves both hosts */
  const shortLink = pathname.match(/^\/s\/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if (shortLink) {
    const q = new URLSearchParams(parsed.searchParams);
    q.set("short", "1");
    q.set("code", shortLink[1]);
    return serveApi(req, res, "/api/order", q);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.json({ ok: false, code: "METHOD" });
  }

  /* `Accept: text/markdown` gets the Markdown variant of a page, where one
     exists — the same negotiation the Vercel rewrites perform */
  const wantsMd = agentSurface.wantsMarkdown(req.headers.accept);
  if (wantsMd && MD_PAGES[pathname]) {
    return serveApi(req, res, "/api/crawl", new URLSearchParams("doc=" + MD_PAGES[pathname]));
  }

  /* /digimenu/<handle> and /<handle> both mean "open that restaurant's menu" */
  /* browsers probe these at the root regardless of the <link> tags */
  const rootAlias = {
    "/favicon.ico": "assets/favicon.ico", "/favicon-32.png": "assets/favicon-32.png",
    "/favicon-180.png": "assets/favicon-180.png", "/site.webmanifest": "assets/site.webmanifest",
    /* the clean addresses vercel.json rewrites. Without them this host reads
       "/login" as a restaurant handle and serves a menu page called "login" —
       the two hosts must answer the same address the same way. */
    "/login": "login.html", "/app": "app.html", "/menu": "menu.html",
    "/superadmin": "superadmin.html"
  };
  if (rootAlias[pathname]) return sendFile(req, res, path.join(ROOT, ...rootAlias[pathname].split("/")));

  /* /<handle>/terms and /<handle>/privacy: the restaurant's own paperwork, the
     page an ad lands on. Checked before the single-segment menu route below. */
  const policyPath = pathname.match(/^\/([a-z0-9][a-z0-9-]{2,31})\/(terms|privacy)\/?$/i);
  if (policyPath) return sendFile(req, res, path.join(ROOT, "policy.html"));

  /* /<handle>/tablet: the staff tablet that takes an order at the table */
  const tabletPath = pathname.match(/^\/([a-z0-9][a-z0-9-]{2,31})\/tablet\/?$/i);
  if (tabletPath) return sendFile(req, res, path.join(ROOT, "tablet.html"));

  /* the two staff doors under a handle — also vercel.json rewrites, and also
     missing here, so a waiter sent to /kings-kebab/login was answered with the
     404 page instead of the sign-in */
  const staffDoor = pathname.match(/^\/([a-z0-9][a-z0-9-]{2,31})\/(login|dashboard)\/?$/i);
  if (staffDoor) {
    return sendFile(req, res, path.join(ROOT, staffDoor[2].toLowerCase() === "login" ? "login.html" : "app.html"));
  }

  const seg = pathname.split("/").filter(Boolean);
  const handleSegment = seg.length === 2 && seg[0] === "digimenu" ? seg[1]
    : (seg.length === 1 && !pathname.includes(".") ? seg[0] : null);
  if (handleSegment && HANDLE.test(handleSegment)) {
    /* an agent asking for a restaurant gets the whole menu as Markdown — names,
       descriptions and prices — not the HTML shell it cannot read */
    if (wantsMd) {
      return serveApi(req, res, "/api/crawl",
        new URLSearchParams("doc=menu&handle=" + handleSegment.toLowerCase()));
    }
    return sendFile(req, res, path.join(ROOT, "menu.html"));
  }

  const filePath = resolveStatic(pathname);
  if (!filePath) return notFound(res, false, req.headers.accept);
  return sendFile(req, res, filePath);
});

server.listen(PORT, () => {
  console.log("digimenu listening on " + PORT + "  (node " + process.version + ")");
});
