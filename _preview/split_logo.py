"""Second pass: split the Indubaicity lockup from its strapline by horizontal
extent, because the two blocks touch vertically and cannot be separated by gaps."""
from PIL import Image

SRC = r"D:\eMenuBuilder\assets\indubaicity-lockup.png"   # already keyed, transparent
im = Image.open(SRC).convert("RGBA")
w, h = im.size
px = im.load()

profile = []
for y in range(h):
    xs = [x for x in range(w) if px[x, y][3] > 40]
    profile.append((xs[0], xs[-1], len(xs)) if xs else (0, 0, 0))

# the strapline is the run at the bottom whose width is a fraction of the lockup's
full = max(p[1] - p[0] for p in profile)
cut = None
for y in range(h - 1, int(h * 0.55), -1):
    left, right, count = profile[y]
    if count and (right - left) < full * 0.55:
        cut = y
    elif cut is not None and count == 0:
        break

print("image:", (w, h), "| full width:", full, "| strapline starts at y =", cut)

if cut:
    mark = im.crop((0, 0, w, cut))
    bbox = mark.getbbox()
    if bbox:
        mark = mark.crop(bbox)
    ratio = 160 / mark.height
    mark = mark.resize((round(mark.width * ratio), 160), Image.LANCZOS)
    mark.save(r"D:\eMenuBuilder\assets\indubaicity-mark.png", "PNG", optimize=True)
    print("mark  ->", mark.size)
    tail = im.crop((0, cut, w, h)).getbbox()
    print("strapline block:", tail)
