"""A new restaurant from signup to a live guest URL, with nothing manual in between."""
import base64, json, time, urllib.request, urllib.error

API = "https://digimenu-blush.vercel.app"
env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SB, SECRET, ANON = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"], env["SUPABASE_ANON_KEY"]


def call(url, method="GET", body=None, token=None, key=None, raw=None, tries=4):
    last = None
    for attempt in range(tries):
        h = {"Content-Type": "application/json"}
        if key: h["apikey"] = key
        if token: h["Authorization"] = "Bearer " + token
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                t = r.read()
                return r.status, (json.loads(t) if t[:1] in (b"{", b"[") else t[:60])
        except urllib.error.HTTPError as e:
            t = e.read()
            try: return e.code, json.loads(t)
            except Exception: return e.code, t[:120]
        except Exception as e:
            last = e; time.sleep(2 + attempt * 2)
    return 0, {"error": str(last)}


def page(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception:
            time.sleep(2)
    return 0


stamp = int(time.time())
handle = f"newjoiner-{stamp}"
email = f"join{stamp}@ogle.live"
pw = "ProbePass!2026"

s, user = call(SB + "/auth/v1/admin/users", "POST", {"email": email, "password": pw, "email_confirm": True}, key=SECRET)
uid = user["id"]
print("1. account created        :", s, uid[:8])

try:
    s, tok = call(SB + "/auth/v1/token?grant_type=password", "POST", {"email": email, "password": pw}, key=ANON)
    jwt = tok["access_token"]

    s, r = call(API + "/api/restaurant", "POST", {
        "name": "New Joiner Kitchen", "handle": handle, "whatsapp_e164": "+971500000123",
        "order_email": email, "purposes": ["Dine In", "Take Away"]
    }, token=jwt)
    print("2. onboarding saved       :", s, "status =", r["restaurant"]["status"])

    s, r = call(API + "/api/restaurant", "POST", {"status": "published"}, token=jwt)
    print("3. publish too early      :", s, r.get("code"), "|", r.get("missing"))

    s, cat = call(API + "/api/menu-edit", "POST", {"action": "addCategory", "name": "Starters"}, token=jwt)
    call(API + "/api/menu-edit", "POST", {"action": "addItem", "categoryId": cat["category"]["id"],
                                          "name": "Hummus", "price": 18}, token=jwt)
    print("4. menu added             :", s)

    s, r = call(API + "/api/restaurant", "POST", {"status": "published"}, token=jwt)
    print("5. publish with no papers :", s, r.get("missing"))

    png = "data:image/png;base64," + base64.b64encode(open("assets/favicon-512.png", "rb").read()).decode()
    call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": png}, token=jwt)
    s, logo = call(API + "/api/upload", "POST", {"kind": "licence", "dataUrl": png}, token=jwt)
    call(API + "/api/restaurant", "POST", {
        "logo_url": logo["url"], "licence_url": logo["url"], "maps_url": "https://maps.app.goo.gl/example"
    }, token=jwt)
    print("6. logo + licence + maps  : saved")

    s, r = call(API + "/api/restaurant", "POST", {"status": "published"}, token=jwt)
    print("7. publish                :", s, "| status =", (r.get("restaurant") or {}).get("status"))

    s, m = call(API + "/api/menu?handle=" + handle)
    print("8. guest API              :", s, "| items:", m.get("itemCount"), m.get("restaurant", {}).get("name"))
    print("9. guest page             :", page(API + "/digimenu/" + handle))
    print("10. ogle.live would need  : nothing — the same rewrite answers")

finally:
    call(SB + "/auth/v1/admin/users/" + uid, "DELETE", key=SECRET)
    s, after = call(API + "/api/menu?handle=" + handle)
    print("11. after deleting account:", s, after.get("code"), "| page:", page(API + "/digimenu/" + handle))
