"""Turn the Indubaicity artwork into transparent PNGs the site can use.

DP3 is the one-colour (coral) version on a dark background, so the whole mark is a
blend between two known colours: solve alpha per pixel instead of guessing a
threshold, which keeps the calligraphy's curves smooth.
"""
from PIL import Image

SRC = r"D:\eMenuBuilder\logo\DP3.jpg.jpeg"
OUT_MARK = r"D:\eMenuBuilder\assets\indubaicity-mark.png"
OUT_LOCKUP = r"D:\eMenuBuilder\assets\indubaicity-lockup.png"

im = Image.open(SRC).convert("RGB")
w, h = im.size
px = im.load()

# background = median of a border ring
samples = []
for x in range(0, w, 7):
    samples += [px[x, 2], px[x, h - 3]]
for y in range(0, h, 7):
    samples += [px[2, y], px[w - 3, y]]
bg = tuple(sorted(c[i] for c in samples)[len(samples) // 2] for i in range(3))

# foreground = the most saturated coral pixel
best, fg = -1, (232, 85, 111)
for x in range(0, w, 3):
    for y in range(0, h, 3):
        r, g, b = px[x, y]
        score = r - max(g, b)
        if score > best:
            best, fg = score, (r, g, b)

print("background:", bg, "| foreground:", fg)

# alpha per pixel from the channel with the most separation
ch = max(range(3), key=lambda i: abs(fg[i] - bg[i]))
span = (fg[ch] - bg[ch]) or 1
out = Image.new("RGBA", (w, h))
op = out.load()
for y in range(h):
    for x in range(w):
        v = px[x, y][ch]
        a = int(max(0.0, min(1.0, (v - bg[ch]) / span)) * 255)
        op[x, y] = (fg[0], fg[1], fg[2], a if a > 12 else 0)

# find horizontal bands of artwork so the strapline can be dropped for the header
rows = [any(op[x, y][3] for x in range(0, w, 3)) for y in range(h)]
bands, start = [], None
for y, filled in enumerate(rows):
    if filled and start is None:
        start = y
    elif not filled and start is not None:
        bands.append((start, y)); start = None
if start is not None:
    bands.append((start, h))
print("bands:", bands)

main = max(bands, key=lambda b: b[1] - b[0])
def crop(band, target_h, path):
    top, bottom = band
    box = out.crop((0, top, w, bottom))
    # trim the empty sides too
    bbox = box.getbbox()
    if bbox:
        box = box.crop(bbox)
    ratio = target_h / box.height
    box = box.resize((max(1, round(box.width * ratio)), target_h), Image.LANCZOS)
    box.save(path, "PNG", optimize=True)
    print(path, box.size)

crop(main, 160, OUT_MARK)                          # header / dashboard
crop((bands[0][0], bands[-1][1]), 120, OUT_LOCKUP) # footer, strapline included
