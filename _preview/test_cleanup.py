"""Prove replaced files are deleted, and that the sweep clears old orphans."""
import base64, json, urllib.request, urllib.error

API = "https://digimenu-blush.vercel.app"
env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SB, ANON = env["SUPABASE_URL"], env["SUPABASE_ANON_KEY"]

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

def head(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

s, tok = call(SB + "/auth/v1/token?grant_type=password", "POST",
              {"email": "emenu@ogle.live", "password": "DigiMenu2026!"}, key=ANON)
jwt = tok["access_token"]

png = open("assets/favicon-512.png", "rb").read()
data = "data:image/png;base64," + base64.b64encode(png).decode()

s, first = call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": data}, token=jwt)
print("1. first logo  :", s, first.get("path"))
print("   reachable   :", head(first["url"]))

call(API + "/api/restaurant", "POST", {"logo_url": first["url"]}, token=jwt)
print("   column saved:", call(API + "/api/restaurant", token=jwt)[1]["restaurant"]["logo_url"][-26:])

s, second = call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": data}, token=jwt)
print("2. second logo :", s, second.get("path"), "| replaced:", second.get("replaced"))
print("   new file    :", head(second["url"]), "| old file now:", head(first["url"]), "(404 = deleted)")

s, shop = call(API + "/api/restaurant", token=jwt)
r = shop["restaurant"]
print("3. columns     : logo =", (r.get("logo_url") or "")[-28:])

s, dry = call(API + "/api/upload?action=sweep", token=jwt)
print("4. sweep dry   :", s, "keeping", dry.get("keeping"), "| would delete:", dry.get("wouldDelete"))

s, done = call(API + "/api/upload?action=sweep&go=1", token=jwt)
print("5. sweep real  :", s, "| deleted:", len(done.get("deleted", [])), done.get("deleted"))

s, dry2 = call(API + "/api/upload?action=sweep", token=jwt)
print("6. sweep again :", s, "| would delete:", dry2.get("wouldDelete"), "(nothing left)")
print("   live logo   :", head(r["logo_url"]))
