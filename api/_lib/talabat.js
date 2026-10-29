/* Talabat menu importer.
 *
 * Talabat renders the whole menu server-side into __NEXT_DATA__:
 *   props.pageProps.initialMenuState.menuData
 *     .categories[]  -> { id, name, ... }
 *     .items[]       -> { id, name, description, price, oldPrice,
 *                         image, originalImage, sectionName, sectionId,
 *                         hasChoices, isItemDiscount }
 * So a plain fetch plus a JSON parse is enough. No browser needed.
 *
 * NOTE ON IMAGES: the image URLs belong to talabat.dhmedia.io. Storing or
 * re-serving them is a rights question, not a technical one. This importer
 * returns them so the review screen can show the dish; whether they are
 * copied into our own storage is a decision for the operator, and by default
 * they should NOT be.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* Any Talabat page under a country path. The brand page
 * (/uae/ushna-restaurant) is a valid starting point: it carries the vendorId
 * and areaId needed to fetch the branch menu. */
const RE_TALABAT = /^https?:\/\/(www\.)?talabat\.com\/[a-z]{2,3}\/[^/?#\s]+/i;

/* Brand / branch-picker pages have no menuData, but pageProps.data does carry
 * vendorId + areaId. Verified: ushna-restaurant -> vendorId 48447, areaId 1446
 * -> /uae/restaurant/48447/ushna-restaurant?aid=1446 returns the menu. */
function resolveMenuUrl(data, originalUrl) {
  const pp = data && data.props && data.props.pageProps;
  const d = pp && pp.data;
  if (!d || !d.vendorId) return null;

  let country = "uae";
  try {
    const seg = new URL(originalUrl).pathname.split("/").filter(Boolean);
    if (seg.length) country = seg[0];
  } catch (e) {}

  const slug = clean(d.restaurantSlug || d.branchSlug || pp.brandSlug || "restaurant")
    .replace(/[^a-z0-9-]/gi, "") || "restaurant";
  const aid = d.areaId ? "?aid=" + encodeURIComponent(d.areaId) : "";
  return "https://www.talabat.com/" + country + "/restaurant/" + d.vendorId + "/" + slug + aid;
}

function isTalabatUrl(url) {
  return RE_TALABAT.test(String(url || "").trim());
}

function toPrice(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function pickImage(item) {
  const raw = item.originalImage || item.image || null;
  if (!raw) return null;
  // Talabat sometimes stores a relative path; normalise to absolute
  return /^https?:\/\//i.test(raw) ? raw : "https://talabat.dhmedia.io/" + raw.replace(/^\/+/, "");
}

function parseNextData(html) {
  const m = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

function stateFromNextData(data) {
  return (data && data.props && data.props.pageProps && data.props.pageProps.initialMenuState) || null;
}

function menuFromNextData(data) {
  const state = stateFromNextData(data);
  const menu = state && state.menuData;
  if (!menu || !Array.isArray(menu.items)) return null;
  return menu;
}

/* Turn Talabat's flat item list into the shape our review screen and the
 * database use: categories in order, each with its items. */
function normalise(menu) {
  const cats = Array.isArray(menu.categories) ? menu.categories : [];
  const order = new Map();
  cats.forEach((c, i) => order.set(String(c.id), i));

  const bySection = new Map();
  for (const raw of menu.items) {
    const name = clean(raw.name);
    if (!name) continue;

    const sectionId = String(raw.sectionId != null ? raw.sectionId : raw.sectionName || "other");
    const sectionName = clean(raw.sectionName || "Other");

    if (!bySection.has(sectionId)) {
      bySection.set(sectionId, { id: sectionId, name: sectionName, items: [] });
    }

    bySection.get(sectionId).items.push({
      source: "talabat",
      sourceId: String(raw.id != null ? raw.id : ""),
      name,
      description: clean(raw.description),
      price: toPrice(raw.price),
      wasPrice: raw.isItemDiscount ? toPrice(raw.oldPrice) : null,
      image: pickImage(raw),
      hasChoices: !!raw.hasChoices,
      soldOut: false
    });
  }

  const categories = Array.from(bySection.values()).sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : 999;
    const bi = order.has(b.id) ? order.get(b.id) : 999;
    return ai - bi;
  });

  return {
    categories,
    itemCount: categories.reduce((n, c) => n + c.items.length, 0),
    withImages: categories.reduce(
      (n, c) => n + c.items.filter((i) => i.image).length,
      0
    )
  };
}

async function fetchPage(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-AE,en;q=0.9"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeout || 15000)
    });
  } catch (e) {
    return { ok: false, error: { ok: false, code: "FETCH_FAILED", message: String(e.message || e) } };
  }

  if (!res.ok) {
    return { ok: false, error: { ok: false, code: "HTTP_" + res.status, message: "Talabat answered " + res.status } };
  }

  const html = await res.text();
  const data = parseNextData(html);
  if (!data) {
    return { ok: false, error: { ok: false, code: "NO_NEXT_DATA", message: "Page loaded but carried no menu payload." } };
  }
  return { ok: true, data, url };
}

async function importTalabat(url, opts = {}) {
  const target = String(url || "").trim();
  if (!isTalabatUrl(target)) {
    return { ok: false, code: "NOT_TALABAT", message: "That is not a Talabat page URL." };
  }

  const first = await fetchPage(target, opts);
  if (!first.ok) return first.error;

  let data = first.data;
  let menu = menuFromNextData(data);
  let resolvedUrl = null;

  /* Brand / branch-picker page: no menuData, but pageProps.data knows the
   * vendorId and areaId. Follow it to the branch menu once. */
  if (!menu) {
    const guess = resolveMenuUrl(data, target);
    if (guess) {
      const second = await fetchPage(guess, opts);
      if (second.ok) {
        const menu2 = menuFromNextData(second.data);
        if (menu2) {
          data = second.data;
          menu = menu2;
          resolvedUrl = guess;
        }
      }
    }
  }

  if (!menu) {
    return {
      ok: false,
      code: "NO_MENU",
      message:
        "That page has no menu on it. If it is a brand page, open the branch you want on Talabat so the address contains /restaurant/<id>/ and paste that."
    };
  }

  const state = stateFromNextData(data) || {};
  const rest = state.restaurant || {};

  const parsed = normalise(menu);
  if (!parsed.itemCount) {
    return { ok: false, code: "EMPTY_MENU", message: "Menu payload contained no items." };
  }

  return {
    ok: true,
    source: "talabat",
    url: target,
    resolvedUrl: resolvedUrl,
    restaurant: {
      name: clean(rest.name || menu.branchName || menu.name || "") || null,
      branch: clean(rest.branchName || "") || null,
      area: clean(rest.areaName || (state.area && state.area.name) || "") || null,
      city: clean((state.city && state.city.name) || "") || null,
      lat: rest.latitude ? Number(rest.latitude) : null,
      lng: rest.longitude ? Number(rest.longitude) : null
    },
    ...parsed
  };
}

module.exports = { importTalabat, isTalabatUrl, normalise, parseNextData, menuFromNextData };
