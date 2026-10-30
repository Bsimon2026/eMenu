"""Category reordering, picker search, config-driven public base."""
import pathlib

# ---------------------------------------------------------------- api: reorder
p = pathlib.Path("api/menu-edit.js")
s = p.read_text(encoding="utf-8")

case = '''      case "moveCategory": {
        const cat = await ownsCategory(body.id);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });

        const all = await rest(
          "menu_categories?restaurant_id=eq." + rid + "&select=id,name,position,is_featured&order=is_featured.desc,position.asc"
        );
        if (!all.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });

        const list = all.data || [];
        const at = list.findIndex((c) => c.id === cat.id);
        const to = body.direction === "up" ? at - 1 : at + 1;
        if (at === -1 || to < 0 || to >= list.length) {
          return res.status(200).json({ ok: true, moved: false });   /* already at the edge */
        }

        /* only swap with a neighbour in the same band: a featured shelf never
           trades places with an ordinary section */
        const a = list[at];
        const b = list[to];
        if (Boolean(a.is_featured) !== Boolean(b.is_featured)) {
          return res.status(200).json({ ok: true, moved: false });
        }

        await rest("menu_categories?id=eq." + a.id, { method: "PATCH", body: { position: b.position } });
        await rest("menu_categories?id=eq." + b.id, { method: "PATCH", body: { position: a.position } });

        return res.status(200).json({ ok: true, moved: true, order: [b.id, a.id] });
      }

'''
anchor = '      case "deleteCategory": {'
if anchor not in s:
    raise SystemExit("anchor missing")
p.write_text(s.replace(anchor, case + anchor, 1), encoding="utf-8")
print("moveCategory:", "moveCategory" in p.read_text(encoding="utf-8"))

# ------------------------------------------------------- front end: app.js
a = pathlib.Path("assets/app.js")
t = a.read_text(encoding="utf-8")

# reorder arrows next to the star
old = '''            <button class="btn btn-outline btn-sm" type="button" data-add="${c.id}">+ Dish</button>'''
new = '''            <button class="btn btn-outline btn-sm" type="button" data-add="${c.id}">+ Dish</button>
            <span class="ord">
              <button class="ord-btn" type="button" data-move="up" data-cat-move="${c.id}" title="Move up">▲</button>
              <button class="ord-btn" type="button" data-move="down" data-cat-move="${c.id}" title="Move down">▼</button>
            </span>'''
assert old in t
t = t.replace(old, new, 1)

# wire the arrows
old_wire = '''    /* ---- pull in existing dishes ---- */'''
new_wire = '''    /* ---- reorder categories ---- */
    $$("[data-cat-move]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.catMove;
        const saved = await menuEdit({ action: "moveCategory", id, direction: btn.dataset.move });
        if (saved) {
          await reloadOwnMenu();
          renderMenuEditor();
        }
      })
    );

    /* ---- pull in existing dishes ---- */'''
assert old_wire in t
t = t.replace(old_wire, new_wire, 1)

# config-driven public base
old_base = '''  /* A QR code is printed once and lives on a table for years: it must never
     contain a preview domain, so this is the production address whatever host
     the dashboard is being viewed on. */
  const PUBLIC_BASE = "https://ogle.live/digimenu/";'''
new_base = '''  /* A QR code is printed once and lives on a table for years: it must never
     contain a preview domain, so this is the production address whatever host
     the dashboard is being viewed on. Set it once in assets/config.js. */
  const PUBLIC_BASE = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.publicBase) || "https://ogle.live/digimenu/";'''
assert old_base in t
t = t.replace(old_base, new_base, 1)

a.write_text(t, encoding="utf-8")
print("arrows:", "data-cat-move" in t, "| base from config:", "DIGIMENU_CONFIG.publicBase" in t)

# ------------------------------------------------------ front end: menu.js
m = pathlib.Path("assets/menu.js")
u = m.read_text(encoding="utf-8")
u = u.replace('const PUBLIC_BASE = "https://ogle.live/digimenu/";',
              'const PUBLIC_BASE = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.publicBase) || "https://ogle.live/digimenu/";')
m.write_text(u, encoding="utf-8")
print("menu.js base from config:", "DIGIMENU_CONFIG.publicBase" in u)

# ------------------------------------------------------------- config.js
c = pathlib.Path("assets/config.js")
v = c.read_text(encoding="utf-8")
if "publicBase" not in v:
    v = v.replace('  apiBase:', '  /* the address printed on every QR code */\n  publicBase: "https://ogle.live/digimenu/",\n  apiBase:')
    c.write_text(v, encoding="utf-8")
print("config publicBase:", "publicBase" in c.read_text(encoding="utf-8"))
