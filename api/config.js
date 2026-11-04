/**
 * GET /api/config — the browser's public configuration, generated from the same
 * environment variables the server already uses.
 *
 * Why this exists: the Supabase URL and publishable key used to be hard-coded in
 * assets/config.js as well as living in the environment. When the database moved
 * to another project, the server followed and the browser did not — sign-in kept
 * hitting the old project with nothing failing loudly. One source of truth ends
 * that class of bug: change the env var, redeploy, and both sides move together.
 *
 * Only the publishable key is published. The service key never appears here.
 */

module.exports = async function handler(req, res) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const anon = process.env.SUPABASE_ANON_KEY || "";

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  /* short cache: a config mistake should be fixable in a minute, not a day */
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.statusCode = 200;

  if (!url || !anon) {
    /* leave the global untouched so assets/config.js can supply a fallback */
    return res.end("/* server config unavailable — falling back to assets/config.js */\n");
  }

  return res.end("window.DIGIMENU_CONFIG = " + JSON.stringify({
    supabaseUrl: url,
    anonKey: anon,
    publicBase: "",
    apiBase: ""            /* the API is same-origin */
  }) + ";\n");
};
