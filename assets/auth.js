/**
 * Session handling for DigiMenu.
 *
 * Sign-in goes straight to Supabase with the publishable key; the access token
 * is kept in localStorage and renewed with the refresh token. Every dashboard
 * request then carries that token, and the API resolves the restaurant from the
 * token — never from anything the page sends.
 */
window.Auth = (function () {
  "use strict";

  const KEY = "digimenu.session.v1";
  const cfg = window.DIGIMENU_CONFIG || {};
  const SUPA = (cfg.supabaseUrl || "").replace(/\/+$/, "");
  const ANON = cfg.anonKey || "";
  const API = cfg.apiBase || "";

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function write(session) {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  }

  function stamp(tok) {
    const expires = tok.expires_in ? Date.now() + tok.expires_in * 1000 : Date.now() + 3500 * 1000;
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: expires,
      user: tok.user || null
    };
  }

  async function post(path, body, headers) {
    const res = await fetch(SUPA + path, {
      method: "POST",
      headers: {
        apikey: ANON,
        "Content-Type": "application/json",
        ...(headers || {})
      },
      body: JSON.stringify(body)
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  async function signIn(email, password) {
    const r = await post("/auth/v1/token?grant_type=password", { email, password });
    if (!r.ok) {
      const msg = r.data.error_description || r.data.msg || r.data.message || "Sign in failed.";
      return { ok: false, message: msg.replace(/^Invalid login credentials$/i, "That email and password do not match an account.") };
    }
    write(stamp(r.data));
    return { ok: true, session: read() };
  }

  async function signUp(email, password, meta) {
    const r = await post("/auth/v1/signup", { email, password, data: meta || {} });
    if (!r.ok) {
      const msg = r.data.msg || r.data.message || r.data.error_description || "Sign up failed.";
      return { ok: false, message: msg };
    }
    /* confirmation may be required: no access_token means "check your email" */
    if (r.data.access_token) {
      write(stamp(r.data));
      return { ok: true, session: read(), confirmed: true };
    }
    return { ok: true, session: null, confirmed: false, user: r.data.user || r.data };
  }

  async function refresh() {
    const s = read();
    if (!s || !s.refresh_token) return null;
    const r = await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    if (!r.ok) { write(null); return null; }
    write(stamp(r.data));
    return read();
  }

  async function token() {
    const s = read();
    if (!s) return "";
    if (s.expires_at && Date.now() < s.expires_at - 30000) return s.access_token;
    const fresh = await refresh();
    return fresh ? fresh.access_token : "";
  }

  function session() { return read(); }
  function user() { const s = read(); return s ? s.user : null; }
  function signOut() { write(null); }

  /** Redirect to the sign-in page unless a session exists. */
  async function requireSession() {
    if (!read()) { location.replace("login.html"); return false; }
    const t = await token();
    if (!t) { write(null); location.replace("login.html"); return false; }
    return true;
  }

  /** Call one of our own API endpoints with the user's token. */
  async function api(path, opts) {
    const t = await token();
    if (!t) { location.replace("login.html"); throw new Error("NO_SESSION"); }
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + t,
        ...((opts && opts.headers) || {})
      }
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }
    if (res.status === 401) { write(null); location.replace("login.html"); }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  return { signIn, signUp, signOut, requireSession, session, user, token, refresh, api, apiBase: API };
})();
