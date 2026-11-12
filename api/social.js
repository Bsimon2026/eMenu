/**
 * /api/social — a photo of a dish, out to the restaurant's own accounts.
 *
 *   GET  ?accounts=1                                (owner)  what is connected
 *   POST ?connect=1   { provider }                  (owner)  where to send them
 *   GET  ?callback=1&code=…&state=…                 (Meta/X/Google return here)
 *   POST ?upload=1    { dataUrl }                   (owner)  the approved poster
 *   POST ?caption=1   { imageUrl, item, price }      (owner)  words, in their voice
 *   POST ?publish=1   { imageUrl, caption, targets } (owner)  fan out, per channel
 *   POST ?disconnect=1 { id }                       (owner)  forget an account
 *
 * Three things this file is careful about:
 *
 * 1. The poster is uploaded to storage before anything is published, because
 *    Instagram and Google both fetch the image themselves from a public URL.
 *    A data: URL cannot be posted — there is nothing for them to fetch.
 *
 * 2. One caption is not one post. X stops at 280 characters and Google at
 *    1500, so the same words are trimmed per channel rather than rejected
 *    wholesale by the shortest one.
 *
 * 3. Publishing is a fan-out, and fan-outs half-fail. Every channel writes its
 *    own row with its own error, and the post's status says "partial" when some
 *    landed. The owner has to be able to see that Instagram worked and TikTok
 *    did not, without reading a log.
 */

const crypto = require("crypto");
const { rest, userFromToken, actorRestaurant, can, bearer, cors, configured } = require("./_lib/db");
const social = require("./_lib/social");

const DS_URL = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.SOCIAL_MODEL || "deepseek-flash";

/* the composed poster goes here, NOT in menu-media: the upload sweeper deletes
   anything in a restaurant's menu-media folder that is not the logo, the cover
   or the licence, which would quietly eat every post ever made */
const BUCKET = "social-media";
/* binary before base64. 3 MB becomes ~4 MB on the wire, which stays under
   Vercel's 4.5 MB body cap — a higher number here would be replaced by the
   platform's own opaque 413 before this file ever ran */
const MAX_BYTES = 3_000_000;

/* --------------------------------------------------------------- helpers --- */

const hits = new Map();
function throttled(key, max, windowMs) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < windowMs);
  seen.push(now);
  hits.set(key, seen);
  if (hits.size > 800) hits.clear();
  return seen.length > max;
}

function storageUrl(path) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return base + "/storage/v1/object/" + path;
}

async function putObject(path, buffer, mime) {
  const res = await fetch(storageUrl(BUCKET + "/" + path), {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
      "Content-Type": mime,
      "x-upsert": "true",
      "cache-control": "public, max-age=31536000"
    },
    body: buffer,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) {
    return { ok: false, detail: (await res.text()).slice(0, 200) };
  }
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return { ok: true, url: base + "/storage/v1/object/public/" + BUCKET + "/" + path };
}

/**
 * The stored token, renewed if it is close to dying. X and Google hand out
 * short-lived tokens; Meta's Page tokens never expire. Renewing here rather
 * than on a timer means a restaurant that posts once a month still works.
 */
async function liveToken(account) {
  const provider = social.PROVIDERS[account.provider];
  const acc = {
    ...account,
    access_token: social.decrypt(account.access_token),
    refresh_token: account.refresh_token ? social.decrypt(account.refresh_token) : null
  };

  const dying = acc.expires_at && new Date(acc.expires_at).getTime() - Date.now() < 120_000;
  if (!dying || !provider.refresh || !acc.refresh_token) return acc;

  const fresh = await provider.refresh(acc);
  await rest("social_accounts?id=eq." + account.id, {
    method: "PATCH",
    body: {
      access_token: social.encrypt(fresh.access_token),
      refresh_token: fresh.refresh_token ? social.encrypt(fresh.refresh_token) : account.refresh_token,
      expires_at: fresh.expires_at,
      updated_at: new Date().toISOString()
    },
    prefer: "return=minimal"
  });
  return { ...acc, ...fresh };
}

/* ---------------------------------------------------------------- handler --- */

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  const q = req.query || {};

  /* ---------------------------------------------------- the OAuth callback
   * Meta, X and Google send the browser here with no session of any kind. The
   * restaurant travelled inside the signed state, so that is the only thing
   * this branch is allowed to trust. It ends in a redirect back to the
   * dashboard, never in JSON, because a human is looking at the tab.
   */
  if (req.method === "GET" && q.callback) {
    /* the result travels in the query, not the hash: app.html reads
       location.search, and "#marketing" only picks the pane */
    const back = (what) =>
      res.redirect(302, (process.env.SOCIAL_RETURN_URL || "/app") + "?" + (what || "social=failed") + "#marketing");

    const state = social.readState(q.state);
    if (!state) return back("social=expired");

    const provider = social.PROVIDERS[state.p];
    if (!provider) return back("social=unknown");

    if (q.error) return back("social=denied");

    const redirect = callbackUrl(req);
    try {
      const found = await provider.exchange(q.code, redirect, state.v);
      if (!found.length) return back("social=nothing");

      let stored = 0;
      let firstFailure = null;
      for (const a of found) {
        /* upsert on (restaurant, provider, account_ref): reconnecting refreshes
           the token instead of creating a second row that would double-post */
        const put = await rest("social_accounts?on_conflict=restaurant_id,provider,account_ref", {
          method: "POST",
          body: {
            restaurant_id: state.r,
            provider: a.provider,
            account_name: a.account_name,
            account_ref: a.account_ref,
            parent_ref: a.parent_ref,
            access_token: social.encrypt(a.access_token),
            refresh_token: a.refresh_token ? social.encrypt(a.refresh_token) : null,
            expires_at: a.expires_at,
            scopes: a.scopes,
            status: "active",
            last_error: null,
            updated_at: new Date().toISOString()
          },
          prefer: "resolution=merge-duplicates,return=minimal"
        });
        if (put.ok) stored++;
        else if (!firstFailure) firstFailure = put.data;
      }
      /* Meta said yes but our database said no: never claim a connection that
         a later publish would not find */
      if (!stored) {
        console.error("[social] store", firstFailure);
        return back("social=failed");
      }
      return back("social=connected&n=" + stored);
    } catch (e) {
      console.error("[social] callback", e.message, e.detail);
      return back("social=failed");
    }
  }

  /* a redirect URI has to be byte-identical between the authorize call and the
     token exchange, so it is derived once, from the same place, both times */
  function callbackUrl(req) {
    if (process.env.SOCIAL_CALLBACK_URL) return process.env.SOCIAL_CALLBACK_URL;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
    return proto + "://" + host + "/api/social?callback=1";
  }

  /* ------------------------------------------------------------------ auth --- */
  const user = await userFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  const actor = await actorRestaurant(user, "id,handle,name");
  const restaurant = actor && actor.restaurant;
  if (!restaurant) return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Finish the restaurant details first." });
  /* posting publicly in the restaurant's name is the owner's call alone */
  if (!can(actor.role, "publish")) {
    return res.status(403).json({ ok: false, code: "NOT_ALLOWED", message: "Only the owner can post on the restaurant's behalf." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = null;
    }
  }
  if (req.method === "POST" && !body) return res.status(400).json({ ok: false, code: "BAD_BODY" });

  /* -------------------------------------------------------------- accounts --- */
  if (req.method === "GET" && q.accounts) {
    const rows = await rest(
      "social_accounts?restaurant_id=eq." + restaurant.id +
        "&select=id,provider,account_name,account_ref,status,expires_at,last_error,created_at&order=created_at.asc"
    );
    return res.status(200).json({
      ok: true,
      accounts: (rows.data || []).map((a) => ({
        id: a.id,
        provider: a.provider,
        label: (social.PROVIDERS[a.provider] || {}).label || a.provider,
        name: a.account_name,
        status: a.status,
        /* expires_at null means it does not expire — say so rather than
           showing a blank that looks like a bug */
        expires: a.expires_at || null,
        error: a.last_error || null
      })),
      available: social.available(),
      configured: Boolean(process.env.SOCIAL_TOKEN_KEY && process.env.SOCIAL_STATE_KEY)
    });
  }

  /* --------------------------------------------------------------- connect --- */
  if (req.method === "POST" && q.connect) {
    const provider = social.PROVIDERS[body.provider];
    if (!provider) return res.status(400).json({ ok: false, code: "UNKNOWN_PROVIDER" });
    if (social.available().indexOf(body.provider) === -1) {
      return res.status(503).json({ ok: false, code: "NOT_CONFIGURED", message: "That platform is not set up on this server yet." });
    }

    /* X is the only one that needs PKCE; its verifier rides in the state so no
       server-side session is needed between leaving and coming back */
    const verifier = crypto.randomBytes(32).toString("base64url");
    const state = social.signState({
      r: restaurant.id,
      p: body.provider,
      v: body.provider === "x" ? verifier : undefined,
      exp: Date.now() + 10 * 60 * 1000
    });

    return res.status(200).json({ ok: true, url: provider.authUrl(state, callbackUrl(req), verifier) });
  }

  /* ------------------------------------------------------------ disconnect --- */
  if (req.method === "POST" && q.disconnect) {
    await rest("social_accounts?id=eq." + body.id + "&restaurant_id=eq." + restaurant.id, {
      method: "DELETE",
      prefer: "return=minimal"
    });
    return res.status(200).json({ ok: true });
  }

  /* ---------------------------------------------------------------- upload --- */
  /* The composer draws the poster in the browser, so what arrives here is the
     finished artwork, not the owner's camera roll. */
  if (req.method === "POST" && q.upload) {
    const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(String(body.dataUrl || ""));
    if (!m) return res.status(400).json({ ok: false, code: "BAD_IMAGE", message: "That image could not be read." });

    const buffer = Buffer.from(m[2], "base64");
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, code: "TOO_BIG", message: "That poster is over 4 MB — lower the export quality." });
    }

    /* Instagram refuses anything that is not JPEG, so anything that is not
       JPEG is declared as JPEG only after the browser has encoded it as JPEG.
       The composer always exports image/jpeg, and this guards against a
       client that did not. */
    const mime = m[1].toLowerCase() === "image/jpeg" ? "image/jpeg" : m[1].toLowerCase();
    if (mime !== "image/jpeg") {
      return res.status(415).json({
        ok: false,
        code: "NOT_JPEG",
        message: "Instagram only accepts JPEG — export the poster as JPG."
      });
    }

    const path = restaurant.handle + "/poster-" + Date.now() + ".jpg";
    const put = await putObject(path, buffer, "image/jpeg");
    if (!put.ok) return res.status(502).json({ ok: false, code: "UPLOAD_FAILED", detail: put.detail });

    return res.status(200).json({ ok: true, url: put.url, path, bytes: buffer.length });
  }

  /* --------------------------------------------------------------- caption --- */
  if (req.method === "POST" && q.caption) {
    if (!process.env.DEEPSEEK_API_KEY) {
      return res.status(503).json({ ok: false, code: "NO_MODEL_KEY", message: "Caption writing is not switched on for this server yet." });
    }
    if (throttled("cap:" + user.id, 30, 3600_000)) {
      return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "That is a lot of captions in one hour. Try again shortly." });
    }

    /* The photo is sent along because the model can see it, but the menu row is
       what makes the words right: "Peri Peri Chicken" and its price are facts,
       and the booking link is the point of the post. */
    const prompt = [
      "You write social captions for a restaurant.",
      "Restaurant: " + (restaurant.name || restaurant.handle) + ".",
      body.item ? "Dish: " + body.item + "." : "",
      body.price ? "Price: " + body.price + "." : "",
      body.notes ? "What the owner wants said: " + body.notes : "",
      "",
      "Write ONE caption, under 180 characters, that a hungry person would stop for.",
      "Rules:",
      "- No quotation marks around it. No preamble. Just the caption.",
      "- Warm and specific, not corporate. Never say 'indulge', 'elevate', 'treat yourself' or 'craving satisfied'.",
      "- No hashtags, no emoji spam — at most one emoji.",
      "- Do NOT include a URL. Links are added per platform later and cost money on X.",
      body.tone === "offer" ? "- This is a limited offer: make the deadline or the saving the headline." : ""
    ].filter(Boolean).join("\n");

    const content = [{ type: "text", text: prompt }];
    if (body.imageUrl && /^https:\/\//i.test(body.imageUrl)) {
      content.push({ type: "image_url", image_url: { url: body.imageUrl } });
    }

    try {
      const r = await fetch(DS_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, temperature: 0.8, max_tokens: 300, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(45000)
      });
      const text = await r.text();
      if (!r.ok) {
        console.error("[social] caption", r.status, text.slice(0, 300));
        return res.status(502).json({ ok: false, code: "MODEL_ERROR", message: "The writer could not be reached. Try again." });
      }
      const data = JSON.parse(text);
      const out = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "")
        .trim()
        .replace(/^["“]|["”]$/g, "");
      if (!out) return res.status(502).json({ ok: false, code: "EMPTY" });
      return res.status(200).json({ ok: true, caption: out });
    } catch (e) {
      return res.status(502).json({ ok: false, code: "MODEL_ERROR", message: String(e.message || e) });
    }
  }

  /* --------------------------------------------------------------- publish --- */
  if (req.method === "POST" && q.publish) {
    const imageUrl = String(body.imageUrl || "");
    const caption = String(body.caption || "").trim();
    const targets = Array.isArray(body.targets) ? body.targets : [];

    if (!/^https:\/\//i.test(imageUrl)) {
      return res.status(400).json({ ok: false, code: "NO_IMAGE", message: "The poster has not been uploaded yet." });
    }
    if (!caption) return res.status(400).json({ ok: false, code: "NO_CAPTION", message: "Add a caption first." });
    if (!targets.length) return res.status(400).json({ ok: false, code: "NO_TARGET", message: "Pick at least one account." });

    if (throttled("pub:" + restaurant.id, 20, 3600_000)) {
      return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "That is a lot of posts in one hour." });
    }

    const rows = await rest(
      "social_accounts?restaurant_id=eq." + restaurant.id +
        "&id=in.(" + targets.map((t) => encodeURIComponent(t)).join(",") + ")"
    );
    const accounts = (rows.data || []).filter((a) => a.status !== "revoked");
    if (!accounts.length) return res.status(409).json({ ok: false, code: "NO_ACCOUNT", message: "Those accounts are no longer connected." });

    /* the post row exists before any platform is called, so a function timeout
       mid-fan-out still leaves a record of what was attempted */
    const postRows = await rest("social_posts", {
      method: "POST",
      body: {
        restaurant_id: restaurant.id,
        created_by: user.id,
        source_url: body.sourceUrl || null,
        image_url: imageUrl,
        caption,
        item_name: body.item || null,
        status: "draft"
      },
      prefer: "return=representation"
    });
    const post = (postRows.data || [])[0];
    if (!post) return res.status(502).json({ ok: false, code: "POST_ROW_FAILED" });

    const results = [];
    for (const account of accounts) {
      const provider = social.PROVIDERS[account.provider];
      const trimmed = social.fit(caption, account.provider);
      if (!provider) {
        results.push({ provider: account.provider, account_ref: account.account_ref, status: "failed", error: "unknown provider" });
        continue;
      }
      try {
        const live = await liveToken(account);
        const out = await provider.publish(live, { imageUrl, caption: trimmed });
        results.push({
          provider: account.provider,
          account_ref: account.account_ref,
          name: account.account_name,
          status: "sent",
          remote_id: out.remote_id || null,
          permalink: out.permalink || null,
          error: null
        });
      } catch (e) {
        /* the platform's own words, kept verbatim: "Invalid aspect ratio" tells
           the owner what to change, "something went wrong" does not */
        const detail = e.detail && (e.detail.error_description || e.detail.message || e.detail.detail)
          ? (e.detail.error_description || e.detail.message || e.detail.detail)
          : null;
        results.push({
          provider: account.provider,
          account_ref: account.account_ref,
          name: account.account_name,
          status: "failed",
          error: detail || String(e.message || e)
        });
      }
    }

    await rest("social_post_results?on_conflict=post_id,provider,account_ref", {
      method: "POST",
      body: results.map((r) => ({
        post_id: post.id,
        provider: r.provider,
        account_ref: r.account_ref,
        status: r.status,
        remote_id: r.remote_id || null,
        permalink: r.permalink || null,
        error: r.error || null
      })),
      prefer: "resolution=merge-duplicates,return=minimal"
    });

    const sent = results.filter((r) => r.status === "sent").length;
    const status = sent === results.length ? "published" : sent ? "partial" : "failed";

    await rest("social_posts?id=eq." + post.id, {
      method: "PATCH",
      body: { status, published_at: sent ? new Date().toISOString() : null },
      prefer: "return=minimal"
    });

    return res.status(sent ? 200 : 502).json({ ok: Boolean(sent), status, sent, total: results.length, results });
  }

  return res.status(405).json({ ok: false, code: "METHOD" });
};
