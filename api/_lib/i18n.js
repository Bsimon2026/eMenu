/**
 * Arabic drafts for menu text.
 *
 * The model writes the first version; the owner publishes it. Nothing in this
 * file ever writes status = 'published' — a dish called "Chicken 65" comes
 * back as something no Arabic menu would print, often enough that the second
 * pair of eyes has to be the restaurant's.
 */

const KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.I18N_MODEL || "deepseek-flash";
const URL = "https://api.deepseek.com/chat/completions";

const SYSTEM = [
  "You translate restaurant menu text into Modern Standard Arabic for a restaurant in the UAE.",
  "Dish names: if the name is a proper noun, a brand, or a dish Arabic menus already know",
  "(Biryani, Shawarma, Karak, Hummus), transliterate it into Arabic letters — do not translate it.",
  "Keep any number in the name exactly as it is.",
  "Descriptions: short, plain, no marketing language, no exclamation marks.",
  "Return JSON only, no prose, no code fences."
].join(" ");

function batches(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* The model is asked for JSON; some models still wrap it in a fence or add a
   sentence. Take the first {...} that parses rather than failing the batch. */
function parseLoose(text) {
  const raw = String(text || "").trim();
  const tryIt = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
  const direct = tryIt(raw);
  if (direct) return direct;
  const fenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const f2 = tryIt(fenced);
  if (f2) return f2;
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) return tryIt(raw.slice(a, b + 1));
  return null;
}

async function translateChunk(rows) {
  if (!KEY) return { ok: false, code: "NO_KEY", message: "No translation key on the server." };
  let r;
  try {
    r = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: 'Translate each entry into Arabic. Reply as {"items":[{"id":"…","name":"…","description":"…"}]}.\n'
              + JSON.stringify(rows)
          }
        ]
      })
    });
  } catch (e) {
    return { ok: false, code: "NETWORK", message: String(e.message || e) };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { ok: false, code: "UPSTREAM", message: ("translation " + r.status + " " + t).slice(0, 200) };
  }
  const data = await r.json().catch(() => null);
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = parseLoose(text);
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!items) return { ok: false, code: "BAD_ANSWER", message: "The translator did not answer in JSON." };

  /* only ids we asked for, and never an empty name over a real one */
  const byId = new Map(rows.map((x) => [x.id, x]));
  const out = [];
  for (const it of items) {
    const src = byId.get(String(it.id || ""));
    if (!src) continue;
    const name = String(it.name || "").trim();
    if (!name) continue;
    out.push({
      id: src.id,
      name: name.slice(0, 200),
      description: src.description ? String(it.description || "").trim().slice(0, 600) : ""
    });
  }
  return { ok: true, items: out };
}

module.exports = { translateChunk, batches };
