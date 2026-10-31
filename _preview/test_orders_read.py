"""A guest order from a phone, then the same order seen by the restaurant."""
import json, time, urllib.request, urllib.error

API = "https://digimenu-blush.vercel.app"
env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SB, K, ANON = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"], env["SUPABASE_ANON_KEY"]


def req(url, method="GET", body=None, token=None, key=None, tries=4):
    last = None
    for attempt in range(tries):
        h = {"Content-Type": "application/json"}
        if key: h["apikey"] = key
        if token: h["Authorization"] = "Bearer " + token
        r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
        try:
            with urllib.request.urlopen(r, timeout=45) as resp:
                t = resp.read()
                return resp.status, (json.loads(t) if t[:1] in (b"{", b"[") else t[:80])
        except urllib.error.HTTPError as e:
            t = e.read()
            try: return e.code, json.loads(t)
            except Exception: return e.code, t[:120]
        except Exception as e:
            last = e; time.sleep(2 + attempt * 2)
    return 0, {"error": str(last)}


# 1. guest places an order from their phone
s, placed = req(API + "/api/order", "POST", {
    "handle": "spice-route", "mode": "Take Away", "pickupAt": "2026-10-31T20:30:00Z",
    "name": "Aisha K", "phone": "+971 55 123 9876",
    "items": [{"name": "Chicken 65", "qty": 2, "price": 34}]
})
print("1. guest order     :", s, placed.get("ok"), "| total:", placed.get("total"))

# 2. the restaurant reads its own orders
s, tok = req(SB + "/auth/v1/token?grant_type=password", "POST",
             {"email": "emenu@ogle.live", "password": "DigiMenu2026!"}, key=ANON)
jwt = tok["access_token"]
s, listr = req(API + "/api/orders", token=jwt)
print("2. dashboard read  :", s, "| orders:", len(listr.get("orders", [])))
for o in listr.get("orders", [])[:3]:
    print("   ", o["guest"], "|", o["phone"], "|", o["mode"], "|", o["total"], "|", [i["name"] + " x" + str(i["qty"]) for i in o["items"]])

# 3. another restaurant must not see these
s, other = req(API + "/api/orders")
print("3. no token        :", s, other.get("code"))

# 4. tidy up
if placed.get("orderId"):
    req(SB + "/rest/v1/orders?id=eq." + placed["orderId"], "DELETE", key=K)
    print("4. test order removed")
