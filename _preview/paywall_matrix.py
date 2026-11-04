"""Prove the paywall matrix on the live host: plan switch, ordering refusal,
publish gate, payment record, and the demo left in a working state."""
import json, pathlib, urllib.error, urllib.request

BASE = "https://digimenu.indubaicity.com"
env = {}
for line in pathlib.Path(".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

ADMIN = env["ADMIN_TOKEN"]
SB = env["SUPABASE_URL"].rstrip("/")
ANON = env["SUPABASE_ANON_KEY"]


def req(url, method="GET", body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=40) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def admin(method="GET", body=None):
    return req(BASE + "/api/admin", method, body, {"x-admin-token": ADMIN})


print("=== 1. columns exist now? ===")
status, d = admin()
print("   admin GET:", status, "| restaurants:", [r["handle"] for r in d.get("restaurants", [])] if status == 200 else d)
if status != 200:
    raise SystemExit("migration not in place yet")

print("\n=== 2. put Spice Route on the ordering plan, paid for a year ===")
status, d = admin("POST", {"handle": "spice-route", "action": "record-payment", "plan": "order", "billing": "yearly"})
print("  ", status, json.dumps(d.get("restaurant", d))[:160])

print("\n=== 3. guest menu reports ordering ===")
status, m = req(BASE + "/api/menu?handle=spice-route")
r = m.get("restaurant", {})
print("   ", status, "| ordering:", r.get("ordering"), "| plan:", r.get("plan"), "| modes:", r.get("purposes"))

print("\n=== 4. switch to the QR-only plan ===")
status, d = admin("POST", {"handle": "spice-route", "action": "set-plan", "plan": "qr"})
print("   set-plan:", status, "| plan:", d.get("restaurant", {}).get("plan"))
status, m = req(BASE + "/api/menu?handle=spice-route")
print("   guest API:", status, "| ordering:", m.get("restaurant", {}).get("ordering"), "| modes:", m.get("restaurant", {}).get("purposes"))
status, o = req(BASE + "/api/order", "POST", {
    "handle": "spice-route", "mode": "Dine In", "table": "3", "name": "Gate Test",
    "phone": "+971500000000", "items": [{"name": "Test", "qty": 1, "price": 10}]})
print("   POST /api/order:", status, "|", o.get("code"), "|", o.get("message"))

print("\n=== 5. back to the ordering plan ===")
status, d = admin("POST", {"handle": "spice-route", "action": "set-plan", "plan": "order"})
print("   set-plan:", status, "| plan:", d.get("restaurant", {}).get("plan"))

print("\n=== 6. owner token, then the publish gate ===")
status, tok = req(SB + "/auth/v1/token?grant_type=password", "POST",
                  {"email": "emenu@ogle.live", "password": "SpiceRoute#2026Menu"}, {"apikey": ANON})
access = tok.get("access_token")
print("   sign-in:", status, "| token:", bool(access))
H = {"Authorization": "Bearer " + access}

print("\n   stop the subscription first (this also unpublishes):")
status, d = admin("POST", {"handle": "spice-route", "action": "stop"})
print("   stop:", status, "| status now:", d.get("restaurant", {}).get("status"), "| paid_through:", d.get("restaurant", {}).get("paid_through"))

status, p = req(BASE + "/api/restaurant", "POST", {"status": "published"}, H)
print("   publish while unpaid:", status, "|", p.get("code"))
print("   message:", (p.get("message") or "")[:110])

print("\n=== 7. record the payment, publish again ===")
status, d = admin("POST", {"handle": "spice-route", "action": "record-payment", "plan": "order", "billing": "yearly", "payRef": "bank transfer 001"})
print("   record:", status, "| paid_through:", d.get("restaurant", {}).get("paid_through"), "| active:", d.get("restaurant", {}).get("active"))
status, p = req(BASE + "/api/restaurant", "POST", {"status": "published"}, H)
print("   publish when paid:", status, "| status:", (p.get("restaurant") or {}).get("status"))

print("\n=== 8. final guest state ===")
status, m = req(BASE + "/api/menu?handle=spice-route")
r = m.get("restaurant", {})
print("   guest API:", status, "| ordering:", r.get("ordering"), "| modes:", r.get("purposes"), "| items:", m.get("itemCount"))
