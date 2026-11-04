"""Publish gate on a throwaway owner, so the demo account keeps exactly one restaurant."""
import json, pathlib, time, urllib.error, urllib.request

BASE = "https://digimenu.indubaicity.com"
env = {}
for line in pathlib.Path(".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
SB, K, ANON, ADMIN = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"], env["SUPABASE_ANON_KEY"], env["ADMIN_TOKEN"]
HDB = {"apikey": K, "Authorization": "Bearer " + K, "Content-Type": "application/json"}


def call(url, method="GET", body=None, headers=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.lstrip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def admin(method="GET", body=None):
    return call(BASE + "/api/admin", method, body, {"x-admin-token": ADMIN})


def uncached(path):
    return call(BASE + path + ("&" if "?" in path else "?") + "_=" + str(int(time.time() * 1000)))


# 0. clear anything a previous run left behind
_, leftovers = call(SB + "/rest/v1/restaurants?handle=like.paywall-test*&select=id,handle", headers=HDB)
for row in leftovers if isinstance(leftovers, list) else []:
    call(SB + "/rest/v1/menu_items?restaurant_id=eq." + row["id"], "DELETE", None, HDB)
    call(SB + "/rest/v1/menu_categories?restaurant_id=eq." + row["id"], "DELETE", None, HDB)
    call(SB + "/rest/v1/restaurants?id=eq." + row["id"], "DELETE", None, HDB)
    print("cleaned leftover:", row["handle"])

stamp = int(time.time())
email = "gate-%d@indubaicity.com" % stamp
handle = "paywall-test-%d" % stamp

# 1. a fresh owner
st, u = call(SB + "/auth/v1/admin/users", "POST",
             {"email": email, "password": "Gate#Test2026", "email_confirm": True}, HDB)
uid = u["id"]
print("throwaway owner:", email)

_, tok = call(SB + "/auth/v1/token?grant_type=password", "POST", {"email": email, "password": "Gate#Test2026"}, {"apikey": ANON})
AUTH = {"Authorization": "Bearer " + tok["access_token"]}

# 2. a restaurant that passes every readiness check, unpaid
_, made = call(SB + "/rest/v1/restaurants", "POST", {
    "owner_id": uid, "handle": handle, "name": "Paywall Test", "status": "trial",
    "plan": "qr", "billing": "monthly", "whatsapp_e164": "+971500000000",
    "order_email": "connect@indubaicity.com", "purposes": ["Dine In"],
    "logo_url": "https://example.com/logo.png",
    "licence_url": "https://example.com/licence.pdf",
    "maps_url": "https://maps.google.com/?q=test"
}, {**HDB, "Prefer": "return=representation"})
rid = made[0]["id"]
_, cat = call(SB + "/rest/v1/menu_categories", "POST", {"restaurant_id": rid, "name": "Mains", "position": 0},
              {**HDB, "Prefer": "return=representation"})
call(SB + "/rest/v1/menu_items", "POST", {"restaurant_id": rid, "category_id": cat[0]["id"],
     "name": "Test Dish", "price": 10, "position": 0}, HDB)
print("restaurant:", handle, "| ready to publish, unpaid")

print("\n=== publish while unpaid ===")
st, r = call(BASE + "/api/restaurant", "POST", {"status": "published"}, AUTH)
print("  ", st, "|", r.get("code"), "|", (r.get("message") or "")[:120])

print("\n=== record the payment, then publish ===")
st, r = admin("POST", {"handle": handle, "action": "record-payment", "billing": "monthly", "payRef": "test transfer 001"})
print("   admin:", st, "| paid_through:", r.get("restaurant", {}).get("paid_through"))
st, r = call(BASE + "/api/restaurant", "POST", {"status": "published"}, AUTH)
print("   publish:", st, "| status:", (r.get("restaurant") or {}).get("status"))

print("\n=== guest sees it, then payment lapses ===")
st, m = uncached("/api/menu?handle=" + handle)
print("   guest API:", st, "| ordering:", (m.get("restaurant") or {}).get("ordering"), "| plan:", (m.get("restaurant") or {}).get("plan"))
st, r = admin("POST", {"handle": handle, "action": "stop"})
print("   stop:", st, "| status:", r.get("restaurant", {}).get("status"), "| paid_through:", r.get("restaurant", {}).get("paid_through"))
st, m = uncached("/api/menu?handle=" + handle)
print("   guest API after lapse:", st, "| (404 = no longer public)")

print("\n=== clean up ===")
call(SB + "/rest/v1/menu_items?restaurant_id=eq." + rid, "DELETE", None, HDB)
call(SB + "/rest/v1/menu_categories?restaurant_id=eq." + rid, "DELETE", None, HDB)
call(SB + "/rest/v1/restaurants?id=eq." + rid, "DELETE", None, HDB)
call(SB + "/auth/v1/admin/users/" + uid, "DELETE", None, HDB)
st, m = uncached("/api/menu?handle=" + handle)
print("   after delete:", st, "| (404 expected)")
_, users = call(SB + "/auth/v1/admin/users?per_page=100", headers=HDB)
print("   accounts left:", [x["email"] for x in users.get("users", [])])
