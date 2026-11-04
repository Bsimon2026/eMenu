"""Copy the live data from the Sydney project into the new Mumbai one.

IDs are preserved so every foreign key keeps pointing at the right row; only
owner_id is rewritten, because the auth user is recreated in the new project and
gets a different UUID.
"""
import json, pathlib, urllib.error, urllib.request

OLD = pathlib.Path(".env").read_text(encoding="utf-8")
env = {}
for line in OLD.splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

OLD_URL, OLD_KEY = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SECRET_KEY"]
NEW_URL = "https://ryqtsglqclmdkcqgvtnd.supabase.co"
NEW_KEY = pathlib.Path("_preview/new-secret.txt").read_text(encoding="utf-8").strip()


def call(url, method="GET", body=None, headers=None, timeout=90):
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


OH = {"apikey": OLD_KEY, "Authorization": "Bearer " + OLD_KEY}
NH = {"apikey": NEW_KEY, "Authorization": "Bearer " + NEW_KEY}

# ---- 1. the owner account -------------------------------------------------
EMAIL, PASSWORD = "emenu@ogle.live", "SpiceRoute#2026Menu"
st, users = call(NEW_URL + "/auth/v1/admin/users?per_page=50", headers=NH)
existing = [u for u in (users.get("users") or []) if u["email"] == EMAIL] if st == 200 else []
if existing:
    new_uid = existing[0]["id"]
    print("owner already exists:", new_uid[:8])
else:
    st, made = call(NEW_URL + "/auth/v1/admin/users",
                    "POST", {"email": EMAIL, "password": PASSWORD, "email_confirm": True,
                             "user_metadata": {"must_change_password": False}}, NH)
    if st not in (200, 201):
        raise SystemExit("could not create the owner: " + str(made)[:200])
    new_uid = made["id"]
    print("owner created:", new_uid[:8])

# ---- 2. copy tables in dependency order ----------------------------------
PLAN = [
    ("restaurants", "id", lambda r: {**r, "owner_id": new_uid}),
    ("menu_categories", "id", lambda r: r),
    ("menu_items", "id", lambda r: r),
    ("menu_item_categories", None, lambda r: r),
    ("orders", "id", lambda r: r),
    ("order_items", "id", lambda r: r),
]

for table, key, shape in PLAN:
    st, rows = call(OLD_URL + "/rest/v1/" + table + "?select=*", headers=OH)
    if st != 200:
        print(f"  {table:<22} READ FAILED {st} {str(rows)[:80]}")
        continue
    if not rows:
        print(f"  {table:<22} 0 rows, nothing to copy")
        continue
    payload = [shape(dict(r)) for r in rows]

    # strip columns the new schema may not have (it should match, but be safe)
    st, cols = call(NEW_URL + "/rest/v1/" + table + "?select=*&limit=1", headers=NH)
    if st == 200:
        allowed = None
        # discover columns from the OpenAPI description instead of a row (table is empty)
        pass

    st, res = call(NEW_URL + "/rest/v1/" + table, "POST", payload, {**NH, "Prefer": "return=minimal"})
    if st in (200, 201, 204):
        print(f"  {table:<22} copied {len(payload)} rows")
    else:
        print(f"  {table:<22} FAILED {st} {str(res)[:220]}")

# ---- 3. what the new project now holds ------------------------------------
print("\nnew project row counts:")
for table, _, _ in PLAN:
    st, rows = call(NEW_URL + "/rest/v1/" + table + "?select=*", headers=NH)
    print(f"  {table:<22} {len(rows) if isinstance(rows, list) else '?'}")
