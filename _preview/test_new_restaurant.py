"""Prove a brand-new restaurant is reachable the moment it exists — no folder, no upload."""
import json, time, urllib.request, urllib.error

API = "https://digimenu-blush.vercel.app"
env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SB, SECRET, ANON = env["SUPABASE_URL"], env["SUPABASE_SECRET_KEY"], env["SUPABASE_ANON_KEY"]

def call(url, method="GET", body=None, token=None, key=None):
    h = {"Content-Type": "application/json"}
    if key: h["apikey"] = key
    if token: h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t

def page(url):
    """status code of an HTML page (not JSON)"""
    try:
        with urllib.request.urlopen(url, timeout=40) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

stamp = int(time.time())
handle = f"brand-new-{stamp}"
email = f"new{stamp}@ogle.live"
pw = "ProbePass!2026"

# before anything exists
s, body = call(API + "/api/menu?handle=" + handle)
print("1. before signup      :", s, body.get("code"), "| page:", page(API + "/digimenu/" + handle))

s, user = call(SB + "/auth/v1/admin/users", "POST", {"email": email, "password": pw, "email_confirm": True}, key=SECRET)
uid = user["id"]
try:
    s, tok = call(SB + "/auth/v1/token?grant_type=password", "POST", {"email": email, "password": pw}, key=ANON)
    jwt = tok["access_token"]

    s, r = call(API + "/api/restaurant", "POST", {
        "name": "Brand New Kitchen", "handle": handle, "whatsapp_e164": "+971500000001",
        "order_email": email, "purposes": ["Dine In"], "status": "published"
    }, token=jwt)
    print("2. restaurant created :", s, (r.get("restaurant") or {}).get("handle"), "| status:", (r.get("restaurant") or {}).get("status"))

    s, cat = call(API + "/api/menu-edit", "POST", {"action": "addCategory", "name": "First Shelf"}, token=jwt)
    s, item = call(API + "/api/menu-edit", "POST", {
        "action": "addItem", "categoryId": cat["category"]["id"], "name": "First Dish", "price": 25
    }, token=jwt)
    print("3. menu added         :", "category+item ok")

    s, m = call(API + "/api/menu?handle=" + handle)
    print("4. guest API          :", s, "| items:", m.get("itemCount"), "| cats:", [c["name"] for c in m.get("categories", [])])
    print("5. guest page         :", page(API + "/digimenu/" + handle), "(the same .htaccess rewrite)")

    # the URL is live with no deploy, no folder, no upload
finally:
    call(SB + "/auth/v1/admin/users/" + uid, "DELETE", key=SECRET)
    s, after = call(API + "/api/menu?handle=" + handle)
    print("6. after deletion     :", s, after.get("code"), "| page still:", page(API + "/digimenu/" + handle))
