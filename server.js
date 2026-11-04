/**
 * server.js — the whole app in one process.
 *
 * Vercel runs one function per file in api/. Hostinger runs one Node process, so
 * this file does what the platform did for us: route /api/<name> to the very same
 * handlers (unchanged), serve the static site, and rewrite a handle to menu.html.
 *
 * Zero dependencies on purpose — `npm install` has nothing to do, and the host
 * cannot break us with a transitive dependency.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const MAX_JSON_BYTES = 4 * 1024 * 1024; /* upload.js allows a 2.5 MB base64 payload */

/* Only these exist at the top level. Anything else is a 404 — which is what keeps
   .env, db/, tools/, _preview/ and .git unreachable even though they sit in the
   deployed folder. */
const STATIC_FILES = new Set([
  "index.html", "login.html", "app.html", "menu.html", "admin.html",
  "favicon.ico", "site.webmanifest", "robots.txt",
]);
const STATIC_DIRS = ["assets"];

const HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/i;

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
    if (e || !st.isFile()) return notFound(res);
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

function notFound(res, json) {
  res.statusCode = 404;
  if (json) return res.json({ ok: false, code: "NOT_FOUND" });
  res.setHeader("Content-Type", MIME[".html"]);
  res.end("<!doctype html><meta charset=utf-8><title>Not found</title>"
    + "<body style=\"font:16px/1.5 system-ui;padding:48px;color:#111\">"
    + "<h1 style=\"font-size:22px\">Not found</h1>"
    + "<p style=\"color:#555\">This page does not exist. "
    + "<a href=\"/\" style=\"color:#F7941D\">Go to the home page</a>.</p>");
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
function loadHandler(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  if (handlerCache.has(name)) return handlerCache.get(name);
  let fn = null;
  try {
    fn = require(path.join(ROOT, "api", name + ".js"));
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") console.error("[api] failed to load", name, e && e.message);
  }
  handlerCache.set(name, fn);
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

  let parsed;
  try {
    parsed = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch {
    return notFound(res);
  }
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) return serveApi(req, res, pathname, parsed.searchParams);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.json({ ok: false, code: "METHOD" });
  }

  /* /digimenu/<handle> and /<handle> both mean "open that restaurant's menu" */
  /* browsers probe these at the root regardless of the <link> tags */
  const rootAlias = { "/favicon.ico": "assets/favicon.ico", "/favicon-32.png": "assets/favicon-32.png",
    "/favicon-180.png": "assets/favicon-180.png", "/site.webmanifest": "assets/site.webmanifest" };
  if (rootAlias[pathname]) return sendFile(req, res, path.join(ROOT, ...rootAlias[pathname].split("/")));

  const seg = pathname.split("/").filter(Boolean);
  const handleSegment = seg.length === 2 && seg[0] === "digimenu" ? seg[1]
    : (seg.length === 1 && !pathname.includes(".") ? seg[0] : null);
  if (handleSegment && HANDLE.test(handleSegment)) {
    return sendFile(req, res, path.join(ROOT, "menu.html"));
  }

  const filePath = resolveStatic(pathname);
  if (!filePath) return notFound(res);
  return sendFile(req, res, filePath);
});

server.listen(PORT, () => {
  console.log("digimenu listening on " + PORT + "  (node " + process.version + ")");
});
