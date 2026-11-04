"""Does deepseek-flash really read a menu photo into structured JSON?
Uses a synthetic menu image so the ground truth is known exactly."""
import base64, io, json, pathlib, urllib.error, urllib.request
from PIL import Image, ImageDraw

env = {}
for l in pathlib.Path(".env").read_text(encoding="utf-8").splitlines():
    if "=" in l and not l.lstrip().startswith("#"):
        k, v = l.split("=", 1); env[k.strip()] = v.strip()
KEY = env["DEEPSEEK_API_KEY"]

# --- draw a menu with known contents ---
img = Image.new("RGB", (900, 1200), "white")
d = ImageDraw.Draw(img)
d.text((60, 50), "SPICE ROUTE", fill="black")
d.text((60, 140), "STARTERS", fill="black")
rows = [
    ("Chicken 65", "27.00"), ("Paneer Tikka", "32.00"), ("Veg Samosa", "12.00"),
    ("MAINS", ""), ("Butter Chicken", "48.00"), ("Mutton Biryani", "55.00"),
    ("Dal Tadka", "26.00"), ("DRINKS", ""), ("Fresh Lime", "14.00"), ("Masala Chai", "9.00"),
]
y = 200
for name, price in rows:
    if not price:
        y += 40
        d.text((60, y), name, fill="black"); y += 70
        continue
    d.text((80, y), name, fill="black")
    d.text((760, y), price, fill="black")
    y += 55
buf = io.BytesIO(); img.save(buf, "PNG")
b64 = base64.b64encode(buf.getvalue()).decode()
pathlib.Path("_preview/menu-fixture.png").write_bytes(buf.getvalue())
print("fixture:", len(b64), "base64 chars |", img.size)

PROMPT = (
    "Read this restaurant menu image. Return ONLY minified JSON, no prose, shaped exactly:\n"
    '{"currency":"AED","categories":[{"name":"string","items":[{"name":"string","description":"string","price":number}]}]}\n'
    "Rules: keep the category headings as categories. price is a number without the currency symbol. "
    "If a dish has no description use an empty string. Do not invent dishes."
)

body = {
    "model": "deepseek-flash",
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": PROMPT},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
    ]}],
    "max_tokens": 2000,
    "temperature": 0,
}

r = urllib.request.Request("https://api.deepseek.com/chat/completions",
                           data=json.dumps(body).encode(), method="POST",
                           headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
try:
    res = urllib.request.urlopen(r, timeout=180)
    data = json.loads(res.read())
    content = data["choices"][0]["message"]["content"]
    print("usage:", data.get("usage"))
    print("raw text:", content[:400])
    cleaned = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    parsed = json.loads(cleaned)
    cats = parsed.get("categories", [])
    items = [(c["name"], i["name"], i["price"]) for c in cats for i in c["items"]]
    print("\nparsed categories:", [c["name"] for c in cats])
    print("dishes found:", len(items))
    for t in items:
        print("   ", t)
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:400])
except json.JSONDecodeError as e:
    print("JSON parse failed:", e)
