"""Place a real order through /api/order and read it back with its phone number."""
import json, urllib.request, urllib.error, time

API = "https://digimenu-blush.vercel.app"
env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SB, K = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"]
AUTH = {"apikey": K, "Authorization": "Bearer " + K}


def post(url, body, headers=None, tries=4):
    last = None
    for attempt in range(tries):
        h = {"Content-Type": "application/json", **(headers or {})}
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            t = e.read()
            try: return e.code, json.loads(t)
            except Exception: return e.code, {"raw": t[:120]}
        except Exception as e:
            last = e; time.sleep(2 + attempt * 2)
    return 0, {"error": str(last)}


def get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=AUTH), timeout=45) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(2 + attempt * 2)
    return None


order = {
    "handle": "spice-route",
    "mode": "Dine In",
    "table": "12",
    "name": "Test Guest",
    "phone": "+971 50 999 1234",
    "total": 999,
    "items": [
        {"name": "Mix Grills Tray", "qty": 1, "price": 185},
        {"name": "Tabbouleh Big", "qty": 2, "price": 29}
    ]
}

s, r = post(API + "/api/order", order)
print("1. order placed      :", s, r.get("ok"), "| total:", r.get("total"), "| items:", r.get("items"), "| id:", (r.get("orderId") or "")[:8])

if r.get("ok"):
    row = get(SB + "/rest/v1/orders?id=eq." + r["orderId"] + "&select=guest_name,guest_phone,mode,table_no,total,status")
    print("2. stored in database:", row)
    lines = get(SB + "/rest/v1/order_items?order_id=eq." + r["orderId"] + "&select=name,qty,unit_price")
    print("3. lines stored      :", lines)

print("4. no phone          :", post(API + "/api/order", {**order, "phone": ""})[0:2])
print("5. no name           :", post(API + "/api/order", {**order, "name": ""})[0:2])
print("6. unknown handle    :", post(API + "/api/order", {**order, "handle": "nobody-here"})[0:2])
print("7. empty order       :", post(API + "/api/order", {**order, "items": []})[0:2])

# tidy up the test rows
for o in get(SB + "/rest/v1/orders?select=id&guest_name=eq.Test Guest") or []:
    urllib.request.urlopen(urllib.request.Request(SB + "/rest/v1/orders?id=eq." + o["id"], headers=AUTH, method="DELETE"))
print("8. test rows removed")
