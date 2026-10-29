"""Verify the dedupe fix: save the Ushna menu (142 rows, 71 duplicates) on a throwaway account."""
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

stamp = int(time.time())
email, pw, handle = f"probe{stamp}@ogle.live", "ProbePass!2026", f"probe-{stamp}"

s, user = call(SB + "/auth/v1/admin/users", "POST", {"email": email, "password": pw, "email_confirm": True}, key=SECRET)
uid = user["id"]
print("probe user:", s, uid[:8])
try:
    s, tok = call(SB + "/auth/v1/token?grant_type=password", "POST", {"email": email, "password": pw}, key=ANON)
    jwt = tok["access_token"]

    s, r = call(API + "/api/restaurant", "POST", {
        "name": "Ushna Probe", "handle": handle, "whatsapp_e164": "+971525757079",
        "order_email": email, "purposes": ["Dine In", "Take Away", "Delivery"], "status": "published"
    }, token=jwt)
    print("restaurant:", s, (r.get("restaurant") or {}).get("handle"))

    # the real import payload, exactly as the review screen builds it
    s, imp = call(API + "/api/import", "POST", {"url": "https://www.talabat.com/uae/ushna-restaurant"})
    print("import:", s, "| dishes:", imp.get("itemCount"), "| categories:", len(imp.get("categories") or []))

    payload = {"categories": [
        {"name": c["name"], "items": [
            {"name": it["name"], "desc": it.get("description"), "price": it.get("price"),
             "image": it.get("image"), "soldOut": False, "source": "talabat", "sourceId": it.get("sourceId")}
            for it in c["items"]]}
        for c in imp["categories"]]}

    s, r = call(API + "/api/save-menu", "POST", payload, token=jwt)
    print("save:", s, json.dumps(r)[:220])

    s, m = call(API + "/api/menu?handle=" + handle)
    print("guest read:", s, "| items:", m.get("itemCount"), "| cats:", [c["name"] for c in m.get("categories", [])])
    if m.get("categories"):
        print("sample:", m["categories"][0]["name"], "->", [i["name"] for i in m["categories"][0]["items"][:3]])
finally:
    call(SB + "/auth/v1/admin/users/" + uid, "DELETE", key=SECRET)
    print("cleanup done")
