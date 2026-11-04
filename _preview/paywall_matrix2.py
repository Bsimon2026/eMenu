"""Exercise the paywall on a disposable restaurant, so the demo keeps its real data.
Also re-checks the ordering gate with a cache-buster, because /api/menu is CDN-cached."""
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


# owner token
_, tok = call(SB + "/auth/v1/token?grant_type=password", "POST",
              {"email": "emenu@ogle.live", "password": "SpiceRoute#2026Menu"}, {"apikey": ANON})
AUTH = {"Authorization": "Bearer " + tok["access_token"]}
_, me = call(SB + "/auth/v1/user", headers={"apikey": ANON, "Authorization": "Bearer " + tok["access_token"]})
owner = me["id"]

handle = "paywall-test-%d" % int(time.time())
print("throwaway restaurant:", handle)

# a restaurant that would pass readiness, on the cheapest plan, unpaid
_, made = call(SB + "/rest/v1/restaurants", "POST", {
    "owner_id": owner, "handle": handle, "name": "Paywall Test", "status": "trial",
    "plan": "qr", "billing": "monthly", "whatsapp_e164": "+971500000000",
    "order_email": "connect@indubaicity.com", "purposes": ["Dine In"],
    "logo_url": "x", "licence_url": "x", "maps_url": "https://maps.google.com"
}, {**HDB, "Prefer": "return=representation"}, 40)
rid = made[0]["id"]
_, cat = call(SB + "/rest/v1/menu_categories", "POST", {"restaurant_id": rid, "name": "Mains", "position": 0}, {**HDB, "Prefer": "return=representation"})
call(SB + "/rest/v1/menu_items", "POST", {
    "restaurant_id": rid, "category_id": cat[0]["id"], "name": "Test Dish", "price": 10, "position": 0
}, HDB)

print("\n=== publish while unpaid ===")
st, r = call(BASE + "/api/restaurant", "POST", {"status": "published"}, AUTH)
print("  ", st, r.get("code"), "|", (r.get("message") or "")[:100])

print("\n=== record the payment, publish again ===")
st, r = admin("POST", {"handle": handle, "action": "record-payment", "billing": "monthly", "payRef": "test transfer"})
print("   admin:", st, "| paid_through:", r.get("restaurant", {}).get("paid_through"))
st, r = call(BASE + "/api/restaurant", "POST", {"status": "published"}, AUTH)
print("   publish:", st, "| status:", (r.get("restaurant") or {}).get("status"))

print("\n=== stop paying: what a guest gets ===")
admin("POST", {"handle": handle, "action": "stop"})
st, m = uncached("/api/menu?handle=" + handle)
print("   guest API:", st, "| ordering:", (m.get("restaurant") or {}).get("ordering"),
      "| modes:", (m.get("restaurant") or {}).get("purposes"))
st, o = call(BASE + "/api/order", "POST", {"handle": handle, "mode": "Dine In", "table": "2",
             "name": "Gate", "phone": "+971500000000", "items": [{"name": "x", "qty": 1, "price": 1}]})
print("   POST /api/order:", st, "|", o.get("code"))

print("\n=== downgrade Spice Route to qr, uncached ===")
admin("POST", {"handle": "spice-route", "action": "set-plan", "plan": "qr"})
st, m = uncached("/api/menu?handle=spice-route")
print("   guest API:", st, "| ordering:", (m.get("restaurant") or {}).get("ordering"),
      "| modes:", (m.get("restaurant") or {}).get("purposes"))
admin("POST", {"handle": "spice-route", "action": "set-plan", "plan": "order"})
st, m = uncached("/api/menu?handle=spice-route")
print("   restored:", st, "| ordering:", (m.get("restaurant") or {}).get("ordering"),
      "| plan:", (m.get("restaurant") or {}).get("plan"))

print("\n=== clean up the throwaway ===")
call(SB + "/rest/v1/menu_items?restaurant_id=eq." + rid, "DELETE", None, HDB)
call(SB + "/rest/v1/menu_categories?restaurant_id=eq." + rid, "DELETE", None, HDB)
call(SB + "/rest/v1/restaurants?id=eq." + rid, "DELETE", None, HDB)
st, m = call(BASE + "/api/menu?handle=" + handle + "&_=" + str(int(time.time())))
print("   after delete:", st, "| (404 expected)")
