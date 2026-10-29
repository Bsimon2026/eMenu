"""Convert menu.js from localStorage to /api/menu.

The file is one linear IIFE, so: declare the data as mutable at the top, wrap
the render in paint(), and fetch before painting.
"""
import pathlib

p = pathlib.Path("assets/menu.js")
s = p.read_text(encoding="utf-8")

# ---- 1. the stored-data block becomes mutable, API-filled state -------------
old_data = '''  /* a link for restaurant A must not borrow the saved data of restaurant B */
  const mine = stored && (!urlHandle || stored.handle === urlHandle);
  const restaurant = (mine && stored.restaurant) || {};
  const docs = (mine && stored.docs) || {};

  const PUBLIC_BASE = /^(www\\.)?ogle\\.live$/i.test(location.hostname)
    ? "https://ogle.live/digimenu/"
    : location.origin + "/digimenu/";

  const name = restaurant.name || DEMO_MENU.restaurant;
  const accent = (mine && stored.accent) || "#f7941d";
  const handle = urlHandle || (stored && stored.handle) || DEMO_MENU.handle;
  const publicLink = PUBLIC_BASE.replace(/^https?:\\/\\//i, "") + handle;
  const whatsapp = (restaurant.whatsapp || DEMO_MENU.whatsapp).replace(/\\D/g, "");
  const purposes = (restaurant.purposes && restaurant.purposes.length)
    ? restaurant.purposes
    : ["Dine In", "Take Away"];

  const cats = (mine && stored.menu && stored.menu.categories) || DEMO_MENU.categories;
'''

new_data = '''  const PUBLIC_BASE = /^(www\\.)?ogle\\.live$/i.test(location.hostname)
    ? "https://ogle.live/digimenu/"
    : location.origin + "/digimenu/";

  /* Filled from /api/menu before the first paint: the database decides what
     this page shows, so the same link looks the same on every phone. */
  let restaurant = {};
  let docs = { logo: null };
  let name = "";
  let accent = "#f7941d";
  let handle = urlHandle || "";
  let publicLink = "";
  let whatsapp = "";
  let purposes = ["Dine In", "Take Away"];
  let cats = [];
'''

assert old_data in s, "stored-data block not found"
s = s.replace(old_data, new_data)

# ---- 2. wrap the render in paint() ------------------------------------------
head_marker = "  /* ---------- head ---------- */\n"
assert head_marker in s
s = s.replace(head_marker, "  function paint() {\n" + head_marker, 1)

tail = "  renderCart();\n})();\n"
assert s.endswith(tail), "unexpected file ending"
s = s[: -len(tail)] + '''  renderCart();
  }

  /* ---------- when there is no menu to show ---------- */

  function unavailable(message) {
    document.title = "Menu not available — DigiMenu";
    const rail = $("#rail");
    if (rail) rail.innerHTML = "";
    $("#sections").innerHTML =
      '<div style="padding:64px 24px;text-align:center;max-width:420px;margin:0 auto">' +
        '<h2 style="margin:0 0 10px;font-size:20px">This menu is not available</h2>' +
        '<p style="margin:0;color:var(--ink-3);line-height:1.6">' + message + '</p>' +
      '</div>';
  }

  /* ---------- load, then paint ---------- */

  (async function start() {
    const cfg = window.DIGIMENU_CONFIG || {};
    const base = cfg.apiBase || "";
    const wanted = urlHandle || handle || "";

    if (!wanted) {
      unavailable("This link has no menu address in it. Scan the restaurant's QR code again.");
      return;
    }

    let res;
    let data;
    try {
      res = await fetch(base + "/api/menu?handle=" + encodeURIComponent(wanted));
      data = await res.json();
    } catch (e) {
      unavailable("We could not reach the menu. Check your connection and try again.");
      return;
    }

    if (!res.ok || !data.ok) {
      unavailable((data && data.message) || "This menu is not published yet.");
      return;
    }

    const r = data.restaurant || {};
    restaurant = { name: r.name, city: r.city, whatsapp: r.whatsapp, purposes: r.purposes };
    docs = { logo: r.logoUrl || null };
    name = r.name || "Menu";
    accent = r.accent || "#f7941d";
    handle = r.handle || wanted;
    publicLink = PUBLIC_BASE.replace(/^https?:\\/\\//i, "") + handle;
    whatsapp = String(r.whatsapp || "").replace(/\\D/g, "");
    purposes = (r.purposes && r.purposes.length) ? r.purposes : ["Dine In", "Take Away"];
    mode = purposes[0] || "Dine In";

    cats = (data.categories || []).map((c, i) => ({
      id: "c" + i,
      name: c.name,
      items: (c.items || []).map((it, j) => ({
        id: "i" + i + "x" + j,
        name: it.name,
        desc: it.description || "",
        price: it.price == null ? 0 : it.price,
        image: it.image || null,
        soldOut: !!it.soldOut,
        diet: null
      }))
    }));

    paint();
  })();
})();
'''

p.write_text(s, encoding="utf-8")
print("menu.js rewritten | lines:", s.count("\n"))
