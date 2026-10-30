/* Public configuration. These two values are safe in a browser: the publishable
 * key only ever carries the rights of a signed-in user (RLS does the rest).
 * The service key is not here and must never be. */
window.DIGIMENU_CONFIG = {
  supabaseUrl: "https://kifdywnkbzsvtconuacn.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZmR5d25rYnpzdnRjb251YWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyNzM4MzAsImV4cCI6MjEwODg0OTgzMH0.8vdWhMBoZdezbKFyNAXgPNSC4W3HdmIBmQ8S2MNUs9I",
  /* same-origin on Vercel; ogle.live and localhost call the deployed API */
  /* leave this empty to print whatever domain the page is served from;
     set it (e.g. "https://digimenu.ogle.live/") to pin the QR for ever */
  publicBase: "",
  apiBase: /(^|\.)vercel\.app$/i.test(location.hostname)
    ? ""
    : "https://digimenu-blush.vercel.app"
};
