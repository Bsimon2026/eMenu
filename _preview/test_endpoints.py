"""End-to-end test of the new write path on a throwaway account."""
import json, time, urllib.request, urllib.error

API = "https://digimenu-blush.vercel.app"
env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SB, SECRET = env["SUPABASE_URL"], env["SUPABASE_SECRET_KEY"]

def call(url, method="GET", body=None, token=None, key=None):
    h = {"Content-Type": "application/json"}
    if key: h["apikey"] = key
    if token: h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t

stamp = int(time.time())
email = f"probe{stamp}@ogle.live"
pw = "ProbePass!2026"
handle = f"probe-{stamp}"

# 1. create a confirmed throwaway user with the service key
s, user = call(SB + "/auth/v1/admin/users", "POST",
               {"email": email, "password": pw, "email_confirm": True}, key=SECRET)
print("1. admin create user:", s, user.get("id", "")[:8] if isinstance(user, dict) else user)
uid = user["id"]

try:
    # 2. sign in like the browser will
    s, tok = call(API.replace(API, SB) + "/auth/v1/token?grant_type=password", "POST",
                  {"email": email, "password": pw}, key=env["SUPABASE_ANON_KEY"])
    print("2. password sign-in:", s, "| token:", bool(tok and tok.get("access_token")))
    jwt = tok["access_token"]

    # 3. no restaurant yet
    s, r = call(API + "/api/restaurant", token=jwt)
    print("3. GET own restaurant (none yet):", s, r.get("restaurant"))

    # 4. create it
    s, r = call(API + "/api/restaurant", "POST", {
        "name": "Probe Kitchen", "handle": handle, "owner_name": "Probe",
        "whatsapp_e164": "+971525757079", "order_email": email,
        "purposes": ["Dine In", "Delivery"]
    }, token=jwt)
    print("4. create restaurant:", s, "|", (r.get("restaurant") or {}).get("handle"), "| status:", (r.get("restaurant") or {}).get("status"))

    # 5. handle clash must be refused
    s, r = call(API + "/api/restaurant", "POST", {"name": "Probe Two", "handle": "spice-route",
               "whatsapp_e164": "+971525757079", "order_email": email}, token=jwt)
    print("5. taking a used handle:", s, r.get("code"), "|", r.get("message"))

    # 6. trial menu must be invisible to guests
    s, r = call(API + "/api/menu?handle=" + handle)
    print("6. guest reads a TRIAL menu:", s, r.get("code"))

    # 7. save a small menu
    menu = {"categories": [
        {"name": "Breads", "items": [
            {"name": "Roti", "desc": "Tandoor", "price": 3.5, "image": "https://talabat.dhmedia.io/image/talabat/MenuItems/Roti_638386720810565551", "source": "talabat", "sourceId": "111"},
            {"name": "Butter Naan", "desc": "", "price": 6, "image": None, "source": "talabat", "sourceId": "222"}]},
        {"name": "Curries", "items": [
            {"name": "Butter Chicken", "desc": "Slow cooked", "price": 62, "image": None, "source": "talabat", "sourceId": "333"}]}
    ]}
    s, r = call(API + "/api/save-menu", "POST", menu, token=jwt)
    print("7. save menu:", s, r)

    # 8. still invisible while trial
    s, r = call(API + "/api/menu?handle=" + handle)
    print("8. guest after save, still trial:", s, r.get("code"))

    # 9. publish, then read like a guest
    s, r = call(API + "/api/restaurant", "POST", {"status": "published"}, token=jwt)
    print("9. publish:", s, "| status:", (r.get("restaurant") or {}).get("status"))
    s, m = call(API + "/api/menu?handle=" + handle)
    print("10. guest reads published menu:", s, "| items:", m.get("itemCount"),
          "| cats:", [c["name"] for c in m.get("categories", [])])
    print("    first dish:", m["categories"][0]["items"][0])

    # 11. a second owner must not be able to touch that menu
    s, r = call(API + "/api/restaurant", "POST", {"status": "suspended"}, token="bogus-token")
    print("11. write with a fake token:", s, r.get("code"))

finally:
    s, _ = call(SB + "/auth/v1/admin/users/" + uid, "DELETE", key=SECRET)
    print("cleanup: deleted probe user ->", s)
