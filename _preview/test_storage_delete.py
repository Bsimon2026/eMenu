"""Which delete call actually removes a storage object?"""
import base64, json, urllib.request, urllib.error

env = {}
for line in open(".env", encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
U, K = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"]
AUTH = {"apikey": K, "Authorization": "Bearer " + K}

def call(url, method="GET", body=None, ctype="application/json", raw=None):
    headers = dict(AUTH)
    data = raw
    if raw is not None:
        headers["Content-Type"] = ctype
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = ctype
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            body = r.read()
            try:
                return r.status, body.decode()[:160]
            except UnicodeDecodeError:
                return r.status, '<' + str(len(body)) + ' binary bytes>'
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:160]

png = open("assets/favicon-32.png", "rb").read()
path = "spice-route/zz-probe.png"

print("upload :", call(U + "/storage/v1/object/menu-media/" + path, "POST", raw=png, ctype="image/png"))
print("public :", call(U + "/storage/v1/object/public/menu-media/" + path)[0])

print("single DELETE:", call(U + "/storage/v1/object/menu-media/" + path, "DELETE"))
print("public after :", call(U + "/storage/v1/object/public/menu-media/" + path)[0], "(404 = really gone)")

if call(U + "/storage/v1/object/public/menu-media/" + path)[0] == 200:
    print("bulk DELETE  :", call(U + "/storage/v1/object/menu-media", "DELETE", body={"prefixes": [path]}))
    print("public after :", call(U + "/storage/v1/object/public/menu-media/" + path)[0], "(404 = really gone)")
