/**
 * /api/members — the owner's team, managed inside his own panel.
 *
 * GET                        list the logins at this restaurant
 * POST { action:"create",  username, password, role }
 * POST { action:"password", username, password }   owner sets a new one
 * POST { action:"role",     username, role }
 * POST { action:"remove",   username }
 *
 * A login is a NAME and a PASSWORD and nothing else. There is no invitation, no
 * email and no verification step, because the owner is going to write both
 * fields on a piece of paper and hand them over — which is the fastest thing
 * that actually happens in a restaurant.
 *
 * The name is only unique inside one restaurant: the server turns (handle, name)
 * into `name@handle.staff.digimenu.internal`, so the same name at two
 * restaurants is two unrelated identities.
 *
 * Owner only. A staff login cannot create, change or remove another.
 */

const {
  rest, userFromToken, actorRestaurant, adminAuth, adminAuthJson, memberEmail, bearer, cors, configured
} = require("./_lib/db");

const SAFE_USER = /^[a-z0-9][a-z0-9._-]{1,23}$/i;
const ROLES = ["menu", "orders"];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  const user = await userFromToken(bearer(req));
  if (!user) {
    return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
  }

  const actor = await actorRestaurant(user, "id,handle,name");
  if (!actor) {
    return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Set up your restaurant first." });
  }
  if (actor.role !== "owner") {
    return res.status(403).json({ ok: false, code: "NOT_OWNER", message: "Only the owner can manage team logins." });
  }

  const rid = actor.restaurant.id;
  const handle = actor.restaurant.handle;

  /* ---------------------------------------------------------------- list */
  if (req.method === "GET") {
    const rows = await rest(
      "restaurant_members?restaurant_id=eq." + rid + "&select=user_id,username,role,created_at&order=created_at.asc"
    );
    if (!rows.ok) {
      return res.status(503).json({
        ok: false, code: "NO_TEAM",
        message: "Team logins are not switched on yet — run db/0008_members.sql in Supabase."
      });
    }

    const list = Array.isArray(rows.data) ? rows.data : [];
    if (list.length) {
      /* one call for the sign-in times, matched by id; a missing user (deleted
         in the dashboard) simply shows as never signed in */
      const all = await adminAuth("/users?per_page=1000");
      const users = (all.ok && all.data && (all.data.users || all.data)) || [];
      const seen = new Map();
      for (const u of users) seen.set(u.id, u.last_sign_in_at || null);
      for (const m of list) m.last_sign_in_at = seen.get(m.user_id) || null;
    }

    return res.status(200).json({
      ok: true,
      handle,
      members: list.map((m) => ({
        user_id: m.user_id, username: m.username, role: m.role,
        created_at: m.created_at, last_sign_in_at: m.last_sign_in_at || null
      }))
    });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, code: "BAD_BODY", message: "Send the fields as JSON." });
  }

  const action = String(body.action || "");
  const username = String(body.username || "").trim().toLowerCase();
  const role = String(body.role || "orders");
  const password = String(body.password || "");

  if (!SAFE_USER.test(username)) {
    return res.status(400).json({
      ok: false, code: "BAD_NAME",
      message: "Use 2–24 characters: letters, numbers, dot, dash or underscore."
    });
  }
  if (role && ROLES.indexOf(role) === -1 && action !== "remove") {
    return res.status(400).json({ ok: false, code: "BAD_ROLE", message: "Choose menu access or orders access." });
  }

  /* -------------------------------------------------------------- create */
  if (action === "create") {
    if (password.length < 6) {
      return res.status(400).json({ ok: false, code: "BAD_PASSWORD", message: "Use at least 6 characters." });
    }
    if (password.length > 72) {
      return res.status(400).json({ ok: false, code: "BAD_PASSWORD", message: "Keep the password under 72 characters." });
    }

    const clash = await rest(
      "restaurant_members?restaurant_id=eq." + rid + "&username=eq." + encodeURIComponent(username) + "&select=username"
    );
    if (clash.ok && Array.isArray(clash.data) && clash.data.length) {
      return res.status(409).json({ ok: false, code: "NAME_TAKEN", message: "There is already a “" + username + "” here. Pick another name." });
    }

    const email = memberEmail(handle, username);
    const app_metadata = { staff: true, restaurant_handle: handle, restaurant_name: actor.restaurant.name };
    const created = await adminAuthJson("/users", "POST", {
      email,
      password,
      email_confirm: true,
      app_metadata,
      user_metadata: { name: username }
    });

    let userId = created.ok && created.data && created.data.id ? created.data.id : null;

    /* the identity outlives its membership when a login is removed, so a name
       that is being re-added finds its old identity and takes a new password */
    if (!userId) {
      const found = await adminAuth("/users?filter=" + encodeURIComponent(email) + "&per_page=20");
      const users = (found.ok && found.data && (found.data.users || found.data)) || [];
      const prev = (Array.isArray(users) ? users : []).find(
        (u) => String(u.email || "").toLowerCase() === email.toLowerCase()
      );
      if (!prev) {
        const raw = (created.data && (created.data.msg || created.data.message)) || "";
        return res.status(502).json({
          ok: false, code: "CREATE_FAILED",
          message: raw && /already/i.test(raw) ? "That name is already taken." : "The login could not be created. Try again."
        });
      }
      userId = prev.id;
      await adminAuthJson("/users/" + userId, "PUT", { password, app_metadata, email_confirm: true });
    }

    const row = await rest("restaurant_members", {
      method: "POST",
      body: { restaurant_id: rid, user_id: userId, username, role: role || "orders" },
      prefer: "return=representation"
    });

    if (!row.ok) {
      /* no membership means the identity must not linger */
      await adminAuthJson("/users/" + userId, "DELETE");
      const detail = String(typeof row.data === "object" ? JSON.stringify(row.data) : row.data).slice(0, 160);
      const notReady = /relation .*restaurant_members.* does not exist/i.test(detail);
      return res.status(notReady ? 503 : 502).json({
        ok: false, code: notReady ? "NO_TEAM" : "SAVE_FAILED",
        message: notReady
          ? "Team logins are not switched on yet — run db/0008_members.sql in Supabase."
          : "The login was created but not attached to your restaurant. Try again."
      });
    }

    return res.status(200).json({
      ok: true,
      member: { username, role: role || "orders", user_id: userId },
      share: { url: handle + "/login", username, password }
    });
  }

  /* everything else acts on an existing login */
  const mem = await rest(
    "restaurant_members?restaurant_id=eq." + rid + "&username=eq." + encodeURIComponent(username) +
    "&select=user_id,username,role"
  );
  if (!mem.ok) {
    return res.status(503).json({ ok: false, code: "NO_TEAM", message: "Run db/0008_members.sql in Supabase first." });
  }
  const member = Array.isArray(mem.data) ? mem.data[0] : null;
  if (!member) {
    return res.status(404).json({ ok: false, code: "NO_MEMBER", message: "No login called “" + username + "” here." });
  }

  /* ------------------------------------------------------------ password */
  if (action === "password") {
    if (password.length < 6) {
      return res.status(400).json({ ok: false, code: "BAD_PASSWORD", message: "Use at least 6 characters." });
    }
    const set = await adminAuthJson("/users/" + member.user_id, "PUT", { password });
    if (!set.ok) {
      return res.status(502).json({ ok: false, code: "SET_FAILED", message: "That password could not be set. Try again." });
    }
    /* a new password for a login that may be in a stranger's pocket: end every
       session it had, so the old phone stops working instead of drifting on */
    await adminAuthJson("/users/" + member.user_id + "/logout", "POST", {});
    return res.status(200).json({ ok: true, share: { url: handle + "/login", username, password } });
  }

  /* ---------------------------------------------------------------- role */
  if (action === "role") {
    const upd = await rest(
      "restaurant_members?restaurant_id=eq." + rid + "&username=eq." + encodeURIComponent(username),
      { method: "PATCH", body: { role }, prefer: "return=representation" }
    );
    if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "The role was not changed." });
    return res.status(200).json({ ok: true, member: { username, role } });
  }

  /* -------------------------------------------------------------- remove */
  if (action === "remove") {
    const del = await rest(
      "restaurant_members?restaurant_id=eq." + rid + "&username=eq." + encodeURIComponent(username),
      { method: "DELETE" }
    );
    if (!del.ok) return res.status(502).json({ ok: false, code: "DELETE_FAILED", message: "That login was not removed." });

    /* deleting the identity is what makes the phone in his pocket stop working */
    await adminAuthJson("/users/" + member.user_id, "DELETE");
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ ok: false, code: "BAD_ACTION", message: "Unknown action." });
};
