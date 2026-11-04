/* Public configuration. These two values are safe in a browser: the publishable
 * key only ever carries the rights of a signed-in user (RLS does the rest).
 * The service key is not here and must never be. */
/* FALLBACK ONLY — the live values come from /api/config, which reads the same
 * environment variables the server uses, so the browser and the server can never
 * drift onto different Supabase projects (which is exactly what happened once).
 *
 * Only consulted if /api/config fails or the server has no env set, e.g. when
 * opening these pages straight from disk.
 *
 * The publishable key is safe in a browser: it only carries the rights of a
 * signed-in user and RLS does the rest. The service key must never appear here. */
window.DIGIMENU_CONFIG = window.DIGIMENU_CONFIG || {
  supabaseUrl: "https://ryqtsglqclmdkcqgvtnd.supabase.co",
  anonKey: "sb_publishable_LXjDmtNMCIpYpKl6Jp4KLg_Bu6pun3N",
  /* leave empty to print whatever domain the page is served from */
  publicBase: "",
  apiBase: ""
};
