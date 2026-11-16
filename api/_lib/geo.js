/**
 * Where a restaurant is, and how far it will go — worked out from what the owner
 * has already given us.
 *
 * The owner pastes a Google Maps share link into the dashboard (it is the same
 * `maps_url` the guest page's "Open in Maps" button uses). Nobody types a
 * latitude: this follows the link to its destination and reads the coordinates
 * out of the URL, which is where Google always puts them:
 *
 *   https://www.google.com/maps/place/…/@25.2048,55.2708,17z
 *   https://maps.google.com/?q=25.2048,55.2708
 *   https://www.google.com/maps/dir/?api=1&destination=25.2048,55.2708
 *   …/data=!3d25.2048!4d55.2708
 *
 * A short `maps.app.goo.gl` link carries none, which is why the short link has
 * to be followed first — that redirect is the whole point of this file.
 *
 * Nothing here fails loudly. A link we cannot read costs the fence, and the
 * restaurant keeps confirming delivery addresses by phone exactly as before.
 */

const UA = "Mozilla/5.0 (compatible; digimenu-geo/1.0)";
const TIMEOUT_MS = 8000;

/** A pair of floats inside the real world, or null. */
function pair(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!isFinite(a) || !isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  /* 0,0 is the Gulf of Guinea: a parse that lands there read nothing */
  if (a === 0 && b === 0) return null;
  return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
}

/** Coordinates out of a maps URL, in the shapes Google writes them. */
function fromUrl(url) {
  const u = String(url || "");
  const tries = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,          /* /place/…/@lat,lng,17z */
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,        /* data=!3d…!4d… */
    /[?&](?:q|ll|center|destination|saddr)=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
    /[?&]query=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/i
  ];
  for (const re of tries) {
    const m = u.match(re);
    if (m) {
      const p = pair(m[1], m[2]);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Coordinates out of the HTML Google renders for a place.
 *
 * A `maps.app.goo.gl` share link — what the Share button actually copies on a
 * phone — never carries them in its URL. It redirects to
 * `/maps?q=<place name>&ftid=…`, and the coordinates exist only in the page:
 *
 *   window.APP_INITIALIZATION_STATE=[[[57777.7,55.364812799999996,25.165824],…
 *
 * which is [scale, lng, lat]. So the order is reversed against everything else
 * here, and getting it backwards puts the restaurant in the wrong hemisphere.
 * The other shapes are tried after it, for pages that render differently.
 */
function fromHtml(html) {
  const page = String(html || "");

  const state = page.match(/APP_INITIALIZATION_STATE\s*=\s*\[\[\[\s*-?\d+(?:\.\d+)?\s*,\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (state) {
    /* lng first, then lat */
    const p = pair(state[2], state[1]);
    if (p) return p;
  }

  const keys = page.match(/\\?"latitude\\?"\s*:\s*(-?\d{1,3}\.\d+)[^}]{0,80}?\\?"longitude\\?"\s*:\s*(-?\d{1,3}\.\d+)/);
  if (keys) {
    const p = pair(keys[1], keys[2]);
    if (p) return p;
  }

  return fromUrl(page);
}

/**
 * Follow a map link (short or long) and return { lat, lng } or null.
 * `fetch` follows redirects by default; the coordinates are usually in either
 * the final URL or the HTML Google renders for the place.
 */
async function locate(url) {
  const link = String(url || "").trim();
  if (!/^https?:\/\//i.test(link)) return null;

  /* a long link already carries them — no network needed */
  const direct = fromUrl(link);
  if (direct) return direct;

  let res;
  try {
    res = await fetch(link, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return null;
  }

  const settled = fromUrl(res.url);
  if (settled) return settled;

  let html = "";
  try { html = await res.text(); } catch (e) { return null; }
  if (html.length > 400000) html = html.slice(0, 400000);
  return fromHtml(html);
}

/** Great-circle distance in km, rounded to 100 m. */
function kmBetween(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(km * 10) / 10;
}

module.exports = { locate, fromUrl, fromHtml, kmBetween, pair };
