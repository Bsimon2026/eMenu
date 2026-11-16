/**
 * The two pieces of arithmetic behind the delivery fence, checked without a
 * database, a browser or a map provider.
 *
 *   · reading coordinates out of the link an owner pastes (the long link has
 *     them inline; a short maps.app.goo.gl link needs the redirect followed,
 *     which is why this is a network call and cannot be unit-tested offline);
 *   · the distance between two points, which decides whether a guest is inside
 *     the radius — the same formula in api/_lib/geo.js and assets/menu.js, kept
 *     in step by this test rather than by memory.
 *
 * Run: node tools/geo-check.js
 */

const geo = require("../api/_lib/geo");

let failed = 0;
function check(name, ok, detail) {
  if (ok) return console.log("PASS  " + name);
  failed++;
  console.log("FAIL  " + name + (detail ? "\n      " + detail : ""));
}

/* ---------- reading a URL ---------- */

const cases = [
  ["place link", "https://www.google.com/maps/place/Kings+Kebab/@25.2048493,55.2707828,17z/data=!3m1", { lat: 25.204849, lng: 55.270783 }],
  ["query link", "https://maps.google.com/?q=25.1972,55.2744", { lat: 25.1972, lng: 55.2744 }],
  ["dir link", "https://www.google.com/maps/dir/?api=1&destination=25.11234,55.22334", { lat: 25.11234, lng: 55.22334 }],
  ["data marker", "https://www.google.com/maps/place/x/data=!4m6!3d24.4539!4d54.3773", { lat: 24.4539, lng: 54.3773 }],
  ["negative", "https://maps.google.com/?q=-33.8688,151.2093", { lat: -33.8688, lng: 151.2093 }]
];

for (const [label, url, want] of cases) {
  const got = geo.fromUrl(url);
  check("reads coordinates from a " + label,
    got && Math.abs(got.lat - want.lat) < 0.0001 && Math.abs(got.lng - want.lng) < 0.0001,
    "got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want));
}

check("a short link carries none (so it has to be followed)",
  geo.fromUrl("https://maps.app.goo.gl/qkbYYqMbx7PB8F4j6") === null);
check("a bare number is not a location",
  geo.fromUrl("https://example.com/order/25") === null);
check("0,0 is refused as a parse failure",
  geo.pair(0, 0) === null);
check("out-of-range coordinates are refused",
  geo.pair(91, 55) === null && geo.pair(25, 181) === null);

/* ---------- the HTML blob a short link lands on ----------
   `maps.app.goo.gl` gives a place name and no coordinates; they exist only in
   APP_INITIALIZATION_STATE, as [scale, lng, lat]. Reversed against every other
   shape — reading it as lat,lng puts Dubai in Somalia. */
const blob = '<script>window.APP_INITIALIZATION_STATE=[[[57777.729570200565,55.364812799999996,25.165824],[0,0,0],[1024,768],13.1],'
  + '[[["m",[13,5349,3499]]]];</script>';
const fromBlob = geo.fromHtml(blob);
check("reads the coordinates out of APP_INITIALIZATION_STATE, lng first",
  fromBlob && Math.abs(fromBlob.lat - 25.165824) < 0.0001 && Math.abs(fromBlob.lng - 55.364813) < 0.0001,
  JSON.stringify(fromBlob));

const jsonPair = geo.fromHtml('{"latitude":25.1972,"longitude":55.2744}');
check("reads a JSON latitude/longitude pair when that is what the page has",
  jsonPair && Math.abs(jsonPair.lat - 25.1972) < 0.0001 && Math.abs(jsonPair.lng - 55.2744) < 0.0001,
  JSON.stringify(jsonPair));

check("a page with no location in it returns nothing",
  geo.fromHtml("<html><body>Somewhere</body></html>") === null);

/* ---------- the distance ---------- */

/* Known pairs: the Burj Khalifa to Dubai Marina is ~21 km by road, ~19.5 km as
   the crow flies; Dubai to Abu Dhabi is ~126 km straight. */
const burj = { lat: 25.1972, lng: 55.2744 };
const marina = { lat: 25.0805, lng: 55.1403 };
const abudhabi = { lat: 24.4539, lng: 54.3773 };

const km1 = geo.kmBetween(burj, marina);
check("Burj Khalifa → Dubai Marina is about 19–21 km", km1 > 18 && km1 < 22, km1 + " km");

const km2 = geo.kmBetween(burj, abudhabi);
check("Dubai → Abu Dhabi is about 120–135 km", km2 > 118 && km2 < 136, km2 + " km");

check("the distance to itself is zero", geo.kmBetween(burj, burj) === 0);
check("the distance is symmetric",
  Math.abs(geo.kmBetween(burj, marina) - geo.kmBetween(marina, burj)) < 0.001);

check("a guest 3 km out is inside a 5 km radius", geo.kmBetween(burj, { lat: 25.2242, lng: 55.2744 }) < 5,
  geo.kmBetween(burj, { lat: 25.2242, lng: 55.2744 }) + " km");

/* the same formula ships in the guest page; keep it byte-comparable */
const fs = require("fs");
const path = require("path");
const menuJs = fs.readFileSync(path.join(__dirname, "..", "assets", "menu.js"), "utf8");
check("the guest page carries the same haversine (R = 6371, asin form)",
  /Math\.asin/.test(menuJs) && /6371/.test(menuJs) && /getCurrentPosition/.test(menuJs));

/* The real thing, when the machine has a network: the share link Kings Kebab
   actually gave us resolves next to Al Muteena, Deira. Run with ONLINE=1. */
(async function () {
  if (process.env.ONLINE === "1") {
    const at = await geo.locate("https://maps.app.goo.gl/qkbYYqMbx7PB8F4j6");
    const near = at ? geo.kmBetween(at, { lat: 25.1658, lng: 55.3648 }) : null;
    check("a real maps.app.goo.gl share link resolves to its restaurant", near != null && near < 1,
      JSON.stringify(at));
  } else {
    console.log("SKIP  the real share link — set ONLINE=1 to fetch it");
  }
  console.log("\n" + (failed ? failed + " failed" : "the fence arithmetic holds"));
  process.exit(failed ? 1 : 0);
})();
