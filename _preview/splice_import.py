"""Splice the new import block into assets/app.js between two markers."""
import pathlib

app = pathlib.Path("assets/app.js")
src = app.read_text(encoding="utf-8")
block = pathlib.Path("_preview/import-block.js").read_text(encoding="utf-8")

start_marker = '  $("#importLink").addEventListener("click", () => {'
end_marker = '  /* ---------------- qr pane ---------------- */'

start = src.index(start_marker)
end = src.index(end_marker)

src = src[:start] + block + "\n" + src[end:]
app.write_text(src, encoding="utf-8")
print("spliced. pendingImport present:", "pendingImport" in src, "| length:", len(src))
