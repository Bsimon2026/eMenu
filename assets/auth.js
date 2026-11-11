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

  /** Staff door: a NAME and a PASSWORD, typed at the restaurant's own address.
   *  The server turns the pair into the identity — the browser never builds or
   *  sees it, so a name cannot be aimed at a restaurant it was not made for. */
  async function staffSignIn(handle, username, password) {
    const res = await fetch(API + "/api/team?login=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, username, password })
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }
    if (!res.ok || !data || !data.ok) {
      return { ok: false, message: (data && data.message) || "That did not work. Try again." };
    }
    write(stamp(data.session));
    return { ok: true, session: read(), role: data.role, restaurant: data.restaurant };
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

  /** Pull the tokens Supabase puts in the fragment of a recovery/confirm link. */
  function tokensFromHash(hash) {
    const h = (hash || "").replace(/^#/, "");
    if (!h) return null;
    const p = new URLSearchParams(h);
    const access = p.get("access_token");
    if (!access) return { error: p.get("error_code") || p.get("error") || "" };
    return {
      access_token: access,
      refresh_token: p.get("refresh_token") || "",
      type: p.get("type") || "",
      expires_in: Number(p.get("expires_in")) || 3600
    };
  }

  /** Ask Supabase to email a reset link. Always reports success to the page —
   *  telling a stranger whether an address has an account is a free user list. */
  async function recover(email) {
    const r = await post("/auth/v1/recover", { email });
    return { ok: r.ok || r.status === 429, message: r.data.msg || r.data.message || "" };
  }

  /** Set a new password using the access token from the recovery link, and keep
   *  the resulting session so the owner lands signed in rather than back at the door. */
  async function setPassword(accessToken, password) {
    const res = await fetch(SUPA + "/auth/v1/user", {
      method: "PUT",
      headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }
    if (!res.ok) {
      const raw = (data && (data.msg || data.message || data.error_description)) || "Could not change the password.";
      return { ok: false, message: /should be at least|weak/i.test(raw) ? "Use at least 6 characters." : raw };
    }
    return { ok: true, user: data };
  }

  /** Adopt a recovery token as the live session. */
  function adopt(tok) {
    write(stamp({ access_token: tok.access_token, refresh_token: tok.refresh_token,
      expires_in: tok.expires_in, user: tok.user || null }));
    return read();
  }

  /** Change the password of the signed-in user, and clear the "temporary" flag. */
  async function changePassword(password, clearTempFlag) {
    const t = await token();
    if (!t) return { ok: false, message: "Sign in again — that session has expired." };
    const s = read();
    const meta = Object.assign({}, (s && s.user && s.user.user_metadata) || {});
    if (clearTempFlag) meta.must_change_password = false;
    const res = await fetch(SUPA + "/auth/v1/user", {
      method: "PUT",
      headers: { apikey: ANON, Authorization: "Bearer " + t, "Content-Type": "application/json" },
      body: JSON.stringify({ password, data: meta })
    });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      const raw = (data && (data.msg || data.message || data.error_description)) || "Could not change the password.";
      return { ok: false, message: /at least|weak|short/i.test(raw) ? "Use at least 8 characters." : raw };
    }
    if (s && s.user && data) { s.user.user_metadata = data.user_metadata || meta; write(s); }
    return { ok: true };
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

  /* ---------------- Google sign-in (PKCE) ----------------
     Our own token handling, so the OAuth flow is four lines of crypto: make a
     verifier, send its hash, exchange the code that comes back. No library. */

  function b64url(bytes) {
    const arr = new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function googleStart() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    localStorage.setItem("digimenu.pkce.v1", verifier);
    const back = location.origin + "/login.html";
    location.href = SUPA + "/auth/v1/authorize?provider=google" +
      "&redirect_to=" + encodeURIComponent(back) +
      "&code_challenge=" + b64url(digest) + "&code_challenge_method=s256";
  }

  /** Called on the login page after Google sends the user back. */
  async function googleFinish() {
    const q = new URLSearchParams(location.search);
    const err = q.get("error_description") || q.get("error");
    if (err && !q.get("code")) return { ok: false, message: String(err).replace(/_/g, " ") };
    const code = q.get("code");
    if (!code) return null;
    const verifier = localStorage.getItem("digimenu.pkce.v1") || "";
    localStorage.removeItem("digimenu.pkce.v1");
    const r = await post("/auth/v1/token?grant_type=pkce", { auth_code: code, code_verifier: verifier });
    if (!r.ok) {
      const msg = r.data.error_description || r.data.msg || r.data.message || "Google sign-in failed.";
      return { ok: false, message: msg };
    }
    write(stamp(r.data));
    return { ok: true, session: read(), isNew: Boolean(r.data.user && r.data.user.created_at) };
  }

  return { signIn, staffSignIn, signUp, signOut, requireSession, session, user, token, refresh, api, apiBase: API,
    changePassword, googleStart, googleFinish, recover, setPassword, tokensFromHash, adopt };
})();
