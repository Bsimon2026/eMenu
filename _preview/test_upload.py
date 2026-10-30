"""Upload a real image through /api/upload and prove it is public."""
import base64, io, json, urllib.request, urllib.error

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

# a real PNG: the Ogle favicon we generated earlier
png = open("assets/favicon-512.png", "rb").read()
data_url = "data:image/png;base64," + base64.b64encode(png).decode()

s, tok = call(SB + "/auth/v1/token?grant_type=password", "POST",
              {"email": "emenu@ogle.live", "password": "DigiMenu2026!"}, key=ANON)
jwt = tok["access_token"]
print("signed in:", bool(jwt))

for kind in ("logo", "cover"):
    s, r = call(API + "/api/upload", "POST", {"kind": kind, "dataUrl": data_url}, token=jwt)
    print(f"{kind:6} upload:", s, r.get("ok"), (r.get("url") or "")[-60:], r.get("bytes"), "bytes")
    if s != 200:
        print("   detail:", r)
        continue

    # the URL must be publicly readable with no auth at all
    try:
        with urllib.request.urlopen(r["url"], timeout=30) as resp:
            body = resp.read()
            print(f"   public fetch: {resp.status} {resp.headers.get('content-type')} {len(body)} bytes")
    except Exception as e:
        print("   public fetch FAILED:", e)

# rejections
s, r = call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": data_url}, token=None)
print("no token      :", s, r.get("code"))
s, r = call(API + "/api/upload", "POST", {"kind": "logo", "dataUrl": "data:text/html;base64,PGI+"}, token=jwt)
print("wrong filetype:", s, r.get("code"), r.get("message"))
