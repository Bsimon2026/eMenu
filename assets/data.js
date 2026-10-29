/* Shared demo data + helpers. No framework, no build step. */

const DEMO_MENU = {
  restaurant: "Spice Route",
  handle: "spice-route",
  city: "Abu Dhabi",
  whatsapp: "971525757079",
  accent: "#7c2231",
  categories: [
    {
      id: "starters",
      name: "Starters",
      items: [
        { id: "hummus", name: "Hummus with Toasted Pita", desc: "Chickpeas, tahini, olive oil, cumin", price: 24, diet: "veg" },
        { id: "fattoush", name: "Fattoush", desc: "Sumac, crisp pita, pomegranate molasses", price: 28, diet: "veg" },
        { id: "chicken-65", name: "Chicken 65", desc: "Curry leaf, yoghurt, red chilli", price: 34, diet: "nonveg" },
        { id: "prawn-koli", name: "Koliwada Prawns", desc: "Semolina crust, lime, green chutney", price: 46, diet: "nonveg", soldOut: true }
      ]
    },
    {
      id: "veg",
      name: "Vegetarian",
      items: [
        { id: "paneer-butter", name: "Paneer Butter Masala", desc: "Tomato, cashew, kasuri methi", price: 46, diet: "veg" },
        { id: "dal-makhani", name: "Dal Makhani", desc: "Black lentil, slow-cooked overnight", price: 38, diet: "veg" },
        { id: "bhindi", name: "Bhindi Do Pyaza", desc: "Okra, onion, dry mango", price: 36, diet: "veg" }
      ]
    },
    {
      id: "nonveg",
      name: "Non-Vegetarian",
      items: [
        { id: "rogan-josh", name: "Mutton Rogan Josh", desc: "Kashmiri chilli, fennel, slow braise", price: 62, diet: "nonveg" },
        { id: "butter-chicken", name: "Butter Chicken", desc: "Tandoori thigh, tomato cream", price: 54, diet: "nonveg" },
        { id: "fish-moilee", name: "Fish Moilee", desc: "Coconut milk, raw mango, curry leaf", price: 58, diet: "nonveg", soldOut: true }
      ]
    },
    {
      id: "chinese",
      name: "Chinese",
      items: [
        { id: "chilli-chicken", name: "Chilli Chicken", desc: "Dry, Sichuan pepper, spring onion", price: 42, diet: "nonveg" },
        { id: "veg-manchurian", name: "Veg Manchurian", desc: "Crisp dumpling, garlic gravy", price: 36, diet: "veg" },
        { id: "schezwan-noodles", name: "Schezwan Noodles", desc: "Wok-tossed, house chilli paste", price: 34, diet: "veg" }
      ]
    },
    {
      id: "breads",
      name: "Breads & Rice",
      items: [
        { id: "naan", name: "Butter Naan", desc: "Tandoor, white butter", price: 9, diet: "veg" },
        { id: "jeera-rice", name: "Jeera Rice", desc: "Basmati, cumin, ghee", price: 18, diet: "veg" },
        { id: "biryani", name: "Hyderabadi Chicken Biryani", desc: "Dum-cooked, saffron, raita", price: 48, diet: "nonveg" }
      ]
    },
    {
      id: "sweets",
      name: "Desserts",
      items: [
        { id: "gulab", name: "Gulab Jamun", desc: "Warm, cardamom syrup", price: 22, diet: "veg" },
        { id: "kulfi", name: "Pistachio Kulfi", desc: "Slow-reduced milk", price: 24, diet: "veg" }
      ]
    }
  ]
};

const CARD_PREVIEW = [
  { cat: "Starters", items: [["Hummus with Toasted Pita", 24], ["Chicken 65", 34]] },
  { cat: "Main Course", items: [["Butter Chicken", 54], ["Paneer Butter Masala", 46]] },
  { cat: "Breads", items: [["Butter Naan", 9]] }
];

const TAKEN_HANDLES = [
  "karak-house", "al-noor", "tandoori-nights", "biryani-point",
  "the-grill", "shishawi", "table9", "salt-pepper", "khan-mandi"
];

const STORE_KEY = "digimenu.state.v1";

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch (e) {
    return null;
  }
}

function saveState(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch (e) {
    /* storage may be full after a large logo upload — ignore */
  }
}

function slugify(v) {
  return String(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function aed(n) {
  return "AED " + Number(n).toFixed(n % 1 === 0 ? 0 : 2);
}

/* ---- dominant colour extraction from an uploaded logo ---- */
function extractPalette(imgEl, cb) {
  const size = 48;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, size, size);
  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch (e) {
    cb(null);
    return;
  }
  const buckets = {};
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 180) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum > 0.94 || lum < 0.06) continue; // skip near-white / near-black
    if (sat < 0.18) continue; // skip greys
    const key = [r >> 4, g >> 4, b >> 4].join(",");
    if (!buckets[key]) buckets[key] = { n: 0, r: 0, g: 0, b: 0, sat };
    buckets[key].n++;
    buckets[key].r += r;
    buckets[key].g += g;
    buckets[key].b += b;
  }
  const ranked = Object.values(buckets)
    .map((b) => ({
      n: b.n,
      sat: b.sat,
      r: Math.round(b.r / b.n),
      g: Math.round(b.g / b.n),
      b: Math.round(b.b / b.n)
    }))
    .sort((x, y) => y.n * (0.5 + y.sat) - x.n * (0.5 + x.sat));

  if (!ranked.length) { cb(null); return; }
  const top = ranked[0];
  cb({
    hex: "#" + [top.r, top.g, top.b].map((v) => v.toString(16).padStart(2, "0")).join(""),
    swatches: ranked.slice(0, 4).map(
      (c2) => "#" + [c2.r, c2.g, c2.b].map((v) => v.toString(16).padStart(2, "0")).join("")
    )
  });
}

function readableInk(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#191811" : "#fff7ee";
}
