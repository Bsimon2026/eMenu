"""Insert the new menu-edit actions before the default case."""
import pathlib

target = pathlib.Path("api/menu-edit.js")
src = target.read_text(encoding="utf-8")
block = pathlib.Path("_preview/menu-edit-cases.js").read_text(encoding="utf-8")

anchor = '      default:\n        return res.status(400).json({ ok: false, code: "UNKNOWN_ACTION"'
if anchor not in src:
    raise SystemExit("anchor not found")

src = src.replace(anchor, block + anchor, 1)
target.write_text(src, encoding="utf-8")

for key in ("linkItem", "unlinkItem", "setItemCategories", "importRows", "addExistingItems"):
    print(key, "->", key in src)
