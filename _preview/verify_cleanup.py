"""Replace-delete verification, with retries for the flaky DNS."""
import base64, json, time, urllib.request, urllib.error

env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
U, K, ANON = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"], env["SUPABASE_ANON_KEY"]
AUTH = {"apikey": K, "Authorization": "Bearer " + K}
API = "https://digimenu-blush.vercel.app"


def call(url, method="GET", body=None, token=None, raw=None, ctype="application/json", tries=4):
    last = None
    for attempt in range(tries):
        h = dict(AUTH) if not token else {"apikey": ANON, "Authorization": "Bearer " + token}
        data = raw
        if raw is not None:
            h["Content-Type"] = ctype
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                t = resp.read()
                return resp.status, (json.loads(t) if t[:1] in (b"{", b"[") else t[:80])
        except urllib.error.HTTPError as e:
            t = e.read()
            try:
                return e.code, json.loads(t)
            except Exception:
                return e.code, t[:120]
        except Exception as e:
            last = e
            time.sleep(2 + attempt * 2)
    return 0, {"error": str(last)}


def bucket_files():
    s, body = call(U + "/storage/v1/object/list/menu-media", "POST", {"prefix": "spice-route/", "limit": 100})
    return sorted(o["name"] for o in body) if isinstance(body, list) else body


s, tok = call(U + "/auth/v1/token?grant_type=password", "POST",
              {"email": "emenu@ogle.live", "password": "DigiMenu2026!"})
if s != 200:
    raise SystemExit("auth failed: " + str(s))
jwt = tok["access_token"]

data = "data:image/png;base64," + base64.b64encode(open("assets/favicon-32.png", "rb").read()).decode()

print("before      :", bucket_files())

s, a = call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": data}, token=jwt)
print("1st upload  :", s, a.get("path"))
call(API + "/api/restaurant", "POST", {"logo_url": a.get("url")}, token=jwt)

s, b = call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": data}, token=jwt)
print("2nd upload  :", s, b.get("path"), "| replaced:", b.get("replaced"))

files = bucket_files()
print("after       :", files)
print("first gone  :", a.get("path", "").split("/")[-1] not in files)

s, dry = call(API + "/api/upload?action=sweep", token=jwt)
print("sweep dry   :", s, "| would delete:", dry.get("wouldDelete"))
s, done = call(API + "/api/upload?action=sweep&go=1", token=jwt)
print("sweep real  :", s, "| deleted:", done.get("deleted"))
print("final       :", bucket_files())
