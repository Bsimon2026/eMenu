/* Public configuration. These two values are safe in a browser: the publishable
 * key only ever carries the rights of a signed-in user (RLS does the rest).
 * The service key is not here and must never be. */
window.DIGIMENU_CONFIG = {
  supabaseUrl: "https://ryqtsglqclmdkcqgvtnd.supabase.co",
  anonKey: "sb_publishable_LXjDmtNMCIpYpKl6Jp4KLg_Bu6pun3N",
  /* same-origin on Vercel; ogle.live and localhost call the deployed API */
  /* leave this empty to print whatever domain the page is served from;
     set it (e.g. "https://digimenu.ogle.live/") to pin the QR for ever */
  publicBase: "",
  apiBase: /(^|\.)vercel\.app$/i.test(location.hostname)
    ? ""
    : "https://digimenu-blush.vercel.app"
};
