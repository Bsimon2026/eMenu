/**
 * The four platforms, and the two pieces of plumbing they all need.
 *
 * Everything here is server-side only. It holds live keys to other people's
 * business pages, so:
 *
 *   - tokens are stored encrypted (AES-256-GCM, key from SOCIAL_TOKEN_KEY) and
 *     never leave this process in the clear
 *   - the OAuth `state` is signed, not looked up in a table: the callback from
 *     Meta arrives with no session attached, so the restaurant has to be
 *     carried inside the state itself and proved to be ours
 *
 * Each provider is an object with the same four verbs, because the differences
 * between them are small and embarrassing:
 *
 *   authUrl(state, redirect)          where to send the owner to approve us
 *   exchange(code, redirect)          code -> the accounts we may now post to
 *   publish(account, post)            put the poster on one account
 *   refresh(account)                  renew a token that is about to die
 *
 * `exchange` returns a list, not a single account, because a restaurant that
 * approves Facebook may have one Page and one linked Instagram behind it, and
 * making them approve twice for that is a bad trade.
 */

const crypto = require("crypto");

/* Every platform stops at a different length, so one caption is never one
   post. Asking the owner to write four versions is a worse product than
   trimming one well-written caption at a word boundary. */
const LIMITS = { instagram: 2200, facebook: 63206, x: 280, gbp: 1500 };

function fit(text, provider) {
  const limit = LIMITS[provider] || 2200;
  const t = String(text || "").trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  /* cut at a word boundary when there is one late enough to be worth keeping;
     a single long word is better hard-cut than lost */
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "\u2026";
}

const GRAPH = "https://graph.facebook.com/v21.0";
const X_API = "https://api.x.com/2";
const GBP_POSTS = "https://mybusiness.googleapis.com/v4";

/* ------------------------------------------------------------------ crypto --- */

/** 32 bytes from any secret, so a short env var cannot silently weaken AES. */
function keyFrom(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function tokenKey() {
  const s = process.env.SOCIAL_TOKEN_KEY || "";
  if (!s) throw new Error("SOCIAL_TOKEN_KEY is not set");
  return keyFrom(s);
}

function stateKey() {
  const s = process.env.SOCIAL_STATE_KEY || process.env.SOCIAL_TOKEN_KEY || "";
  if (!s) throw new Error("SOCIAL_STATE_KEY is not set");
  return keyFrom(s);
}

/** iv.tag.cipher, all base64url. Changing the key orphans every stored token. */
function encrypt(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

function decrypt(blob) {
  if (!blob) return "";
  const [iv, tag, ct] = String(blob).split(".");
  if (!iv || !tag || !ct) throw new Error("stored token is not in the expected shape");
  const d = crypto.createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** A restaurant id and a deadline, signed. Tampering fails the signature. */
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", stateKey()).update(body).digest("base64url");
  return body + "." + sig;
}

function readState(raw) {
  const [body, sig] = String(raw || "").split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", stateKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let o;
  try {
    o = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!o || !o.r || !o.exp || o.exp < Date.now()) return null;
  return o;
}

/* -------------------------------------------------------------------- meta --- */

/**
 * One call to the Graph API. Meta reports failures as HTTP 200 with an `error`
 * body often enough that the body is always checked, not just the status.
 */
async function graph(path, { method = "GET", token, query, json } = {}) {
  const url = new URL(GRAPH + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {})
    },
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = { raw: text };
  }
  if (data && data.error) {
    const e = new Error(data.error.message || "Graph API error");
    e.status = res.status;
    e.detail = data.error;
    throw e;
  }
  if (!res.ok) {
    const e = new Error("Graph API " + res.status);
    e.status = res.status;
    e.detail = data;
    throw e;
  }
  return data;
}

/**
 * Instagram, through Facebook Login (Meta docs: the "Instagram API with
 * Facebook Login" path). Two things about it are not negotiable:
 *
 *   1. Meta fetches `image_url` from OUR server — it must be a public HTTPS URL
 *      and the file must be a real JPEG. A data: URL, an expiring signed link
 *      or a WebP all fail.
 *   2. Publishing is two calls with a wait between them: make a container,
 *      wait for it to finish processing, then publish. Publishing before it is
 *      FINISHED fails with a container-not-ready error.
 */
async function igPublish(acc, { imageUrl, caption }) {
  const container = await graph("/" + acc.account_ref + "/media", {
    method: "POST",
    token: acc.access_token,
    json: { image_url: imageUrl, caption }
  });
  const id = container && container.id;
  if (!id) throw new Error("Instagram returned no container id");

  /* 18 seconds is generous for a single image; a timeout here is a soft
     failure the owner can simply press again, not a lost post */
  let state = "";
  for (let i = 0; i < 12; i++) {
    const s = await graph("/" + id, { token: acc.access_token, query: { fields: "status_code" } });
    state = (s && s.status_code) || "";
    if (state === "FINISHED") break;
    if (state === "ERROR" || state === "EXPIRED") {
      throw new Error("Instagram could not process the image (" + state.toLowerCase() + ")");
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (state !== "FINISHED") throw new Error("Instagram was still processing the image after 18s — try again");

  const out = await graph("/" + acc.account_ref + "/media_publish", {
    method: "POST",
    token: acc.access_token,
    json: { creation_id: id }
  });
  return { remote_id: out && out.id, permalink: null };
}

const PROVIDERS = {
  /* ----------------------------------------------------------- instagram --- */
  instagram: {
    label: "Instagram",
    /**
     * Page tokens minted from a long-lived user token do not expire, which is
     * why there is no refresh here: the only thing that kills one is the owner
     * removing the app.
     */
    authUrl(state, redirect) {
      const u = new URL(GRAPH + "/dialog/oauth");
      u.searchParams.set("client_id", process.env.FACEBOOK_APP_ID || "");
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      /* instagram_content_publish is the one that matters; the rest are what
         Meta requires alongside it to read the Page/IG pair at all */
      u.searchParams.set(
        "scope",
        [
          "pages_show_list",
          "pages_read_engagement",
          "business_management",
          "instagram_basic",
          "instagram_content_publish"
        ].join(",")
      );
      return u.toString();
    },

    async exchange(code, redirect) {
      const short = await graph("/oauth/access_token", {
        query: {
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          redirect_uri: redirect,
          code
        }
      });
      /* the 1-hour token is useless to us: swap it for the 60-day one, then
         read the Pages off it, whose own tokens are the permanent ones */
      const long = await graph("/oauth/access_token", {
        query: {
          grant_type: "fb_exchange_token",
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          fb_exchange_token: short.access_token
        }
      });

      const pages = await graph("/me/accounts", {
        token: long.access_token,
        query: { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100" }
      });

      const out = [];
      for (const page of (pages && pages.data) || []) {
        const ig = page.instagram_business_account;
        if (!ig || !ig.id) continue; /* a Page with no Instagram behind it */
        out.push({
          provider: "instagram",
          account_name: ig.username ? "@" + ig.username : page.name,
          account_ref: ig.id,
          parent_ref: page.id,
          access_token: page.access_token,
          refresh_token: null,
          expires_at: null,
          scopes: "instagram_content_publish"
        });
      }
      return out;
    },

    publish: igPublish
  },

  /* ------------------------------------------------------------ facebook --- */
  facebook: {
    label: "Facebook Page",
    authUrl(state, redirect) {
      const u = new URL(GRAPH + "/dialog/oauth");
      u.searchParams.set("client_id", process.env.FACEBOOK_APP_ID || "");
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", ["pages_show_list", "pages_read_engagement", "pages_manage_posts"].join(","));
      return u.toString();
    },

    async exchange(code, redirect) {
      const short = await graph("/oauth/access_token", {
        query: {
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          redirect_uri: redirect,
          code
        }
      });
      const long = await graph("/oauth/access_token", {
        query: {
          grant_type: "fb_exchange_token",
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          fb_exchange_token: short.access_token
        }
      });
      const pages = await graph("/me/accounts", {
        token: long.access_token,
        query: { fields: "id,name,access_token", limit: "100" }
      });
      return ((pages && pages.data) || []).map((page) => ({
        provider: "facebook",
        account_name: page.name,
        account_ref: page.id,
        parent_ref: null,
        access_token: page.access_token,
        refresh_token: null,
        expires_at: null,
        scopes: "pages_manage_posts"
      }));
    },

    /* Meta posts the photo itself from the URL, so nothing is uploaded here. */
    async publish(acc, { imageUrl, caption }) {
      const out = await graph("/" + acc.account_ref + "/photos", {
        method: "POST",
        token: acc.access_token,
        json: { url: imageUrl, message: caption }
      });
      return { remote_id: out && (out.post_id || out.id), permalink: null };
    }
  },

  /* ------------------------------------------------------------------- x --- */
  x: {
    label: "X",
    /**
     * OAuth 2.0 with PKCE. The verifier rides inside the signed state so no
     * server-side session is needed between the redirect out and back.
     */
    authUrl(state, redirect, verifier) {
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const u = new URL("https://x.com/i/oauth2/authorize");
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", process.env.X_CLIENT_ID || "");
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("scope", "tweet.read tweet.write users.read media.write offline.access");
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async exchange(code, redirect, verifier) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
        client_id: process.env.X_CLIENT_ID
      });
      const basic = Buffer.from(process.env.X_CLIENT_ID + ":" + process.env.X_CLIENT_SECRET).toString("base64");
      const tok = await xToken(body, basic);
      const me = await fetch(X_API + "/users/me", {
        headers: { Authorization: "Bearer " + tok.access_token },
        signal: AbortSignal.timeout(15000)
      }).then((r) => r.json());

      return [
        {
          provider: "x",
          account_name: me && me.data && me.data.username ? "@" + me.data.username : "X",
          account_ref: (me && me.data && me.data.id) || "me",
          parent_ref: null,
          access_token: tok.access_token,
          refresh_token: tok.refresh_token || null,
          expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
          scopes: tok.scope || null
        }
      ];
    },

    async refresh(acc) {
      if (!acc.refresh_token) throw new Error("X token expired and there is no refresh token — reconnect");
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: acc.refresh_token,
        client_id: process.env.X_CLIENT_ID
      });
      const basic = Buffer.from(process.env.X_CLIENT_ID + ":" + process.env.X_CLIENT_SECRET).toString("base64");
      const tok = await xToken(body, basic);
      return {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || acc.refresh_token,
        expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null
      };
    },

    /**
     * Two calls: the image has to exist on X before the post can reference it.
     * Billed per request — $0.015 a post, and $0.20 if the text carries a link,
     * so the caption builder is told to leave links out.
     */
    async publish(acc, { imageUrl, caption }) {
      let mediaIds = [];
      if (imageUrl) {
        const img = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
        if (!img.ok) throw new Error("could not fetch the poster to upload it to X");
        const form = new FormData();
        form.append("media", new Blob([await img.arrayBuffer()], { type: "image/jpeg" }), "poster.jpg");
        form.append("media_category", "tweet_image");
        const up = await fetch(X_API + "/media/upload", {
          method: "POST",
          headers: { Authorization: "Bearer " + acc.access_token },
          body: form,
          signal: AbortSignal.timeout(60000)
        });
        const upJson = await up.json().catch(() => null);
        if (!up.ok) {
          const e = new Error("X refused the image");
          e.detail = upJson;
          throw e;
        }
        const mid = upJson && (upJson.media_id_string || (upJson.data && upJson.data.id) || (upJson.data && upJson.data.media_id_string));
        if (mid) mediaIds = [String(mid)];
      }

      const res = await fetch(X_API + "/tweets", {
        method: "POST",
        headers: { Authorization: "Bearer " + acc.access_token, "Content-Type": "application/json" },
        body: JSON.stringify(mediaIds.length ? { text: caption, media: { media_ids: mediaIds } } : { text: caption }),
        signal: AbortSignal.timeout(30000)
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const e = new Error("X refused the post");
        e.detail = json;
        throw e;
      }
      const id = json && json.data && json.data.id;
      return { remote_id: id, permalink: id ? "https://x.com/i/status/" + id : null };
    }
  },

  /* ------------------------------------------------------------------ gbp --- */
  /**
   * Google Business Profile. For a restaurant this is the highest-value channel
   * of the four — it shows in Search and Maps where the customer already is —
   * and the most awkward to get into: access is granted per project by an
   * application form, not by self-service.
   */
  gbp: {
    label: "Google Business",
    authUrl(state, redirect) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID || "");
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "https://www.googleapis.com/auth/business.manage");
      u.searchParams.set("access_type", "offline");
      /* without prompt=consent Google returns no refresh_token on a re-consent */
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("state", state);
      return u.toString();
    },

    async exchange(code, redirect) {
      const tok = await googleToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET
      });

      const accounts = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
        headers: { Authorization: "Bearer " + tok.access_token },
        signal: AbortSignal.timeout(20000)
      }).then((r) => r.json());

      const out = [];
      for (const a of (accounts && accounts.accounts) || []) {
        const locs = await fetch(
          "https://mybusinessbusinessinformation.googleapis.com/v1/" + a.name +
            "/locations?readMask=name,title,storeCode",
          { headers: { Authorization: "Bearer " + tok.access_token }, signal: AbortSignal.timeout(20000) }
        ).then((r) => r.json());

        for (const l of (locs && locs.locations) || []) {
          out.push({
            provider: "gbp",
            account_name: l.title,
            /* both halves of the path are needed and neither means anything
               alone, so they are stored as one "accounts/…/locations/…" ref */
            account_ref: a.name.replace("accounts/", "") + "/" + l.name.replace("locations/", ""),
            parent_ref: a.name,
            access_token: tok.access_token,
            refresh_token: tok.refresh_token || null,
            expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
            scopes: "business.manage"
          });
        }
      }
      return out;
    },

    async refresh(acc) {
      if (!acc.refresh_token) throw new Error("Google token expired and there is no refresh token — reconnect");
      const tok = await googleToken({
        grant_type: "refresh_token",
        refresh_token: acc.refresh_token,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET
      });
      return {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || acc.refresh_token,
        expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString()
      };
    },

    async publish(acc, { imageUrl, caption }) {
      const [acct, loc] = String(acc.account_ref).split("/");
      const res = await fetch(GBP_POSTS + "/accounts/" + acct + "/locations/" + loc + "/localPosts", {
        method: "POST",
        headers: { Authorization: "Bearer " + acc.access_token, "Content-Type": "application/json" },
        body: JSON.stringify({
          languageCode: "en",
          summary: caption,
          topicType: "STANDARD",
          media: [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }]
        }),
        signal: AbortSignal.timeout(30000)
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const e = new Error("Google refused the post");
        e.detail = json;
        throw e;
      }
      return { remote_id: json && json.name, permalink: null };
    }
  }
};

/* --------------------------------------------------------------- token POST --- */

async function xToken(body, basic) {
  const res = await fetch(X_API + "/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error("X refused the token exchange");
    e.detail = json;
    throw e;
  }
  return json;
}

async function googleToken(form) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error("Google refused the token exchange");
    e.detail = json;
    throw e;
  }
  return json;
}

/** Which providers the server is actually configured for, for the UI to show. */
function available() {
  const out = [];
  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    out.push("instagram", "facebook");
  }
  if (process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET) out.push("x");
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) out.push("gbp");
  return out;
}

module.exports = {
  PROVIDERS,
  LIMITS,
  fit,
  encrypt,
  decrypt,
  signState,
  readState,
  available
};
