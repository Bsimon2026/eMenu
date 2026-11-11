"""DigiMenu / Indubaicity favicon set.

The brand is a single continuous wordmark with no separable emblem, and at 16px a
wordmark is a smudge. So the tab icon is the brand's monogram: the two letters that
open "indubaicity", white on the coral, on the rounded tile that every browser tab
expects. The full wordmark is kept as an alternative (fav/wordmark-512.png).

Run:  python _preview/make_favicon.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

CORAL = (240, 72, 95, 255)
WHITE = (255, 255, 255, 255)
OUT = "assets"
PREVIEW = "_preview/fav"
SIZE = 1024                      # draw big, downscale once

FONTS = [
    "C:/Windows/Fonts/seguisb.ttf",   # Segoe UI Semibold
    "C:/Windows/Fonts/arialbd.ttf",
]


def font(px, index=0):
    for path in FONTS[index:]:
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    raise SystemExit("no usable font found")


def monogram(text="in"):
    """White letters, optically centred, on a coral rounded tile."""
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.18), fill=CORAL)

    f = font(int(SIZE * 0.72))
    box = d.textbbox((0, 0), text, font=f)
    tw, th = box[2] - box[0], box[3] - box[1]
    # cap height sits a touch high in most faces; nudge down 1% for optical centre
    x = (SIZE - tw) / 2 - box[0]
    y = (SIZE - th) / 2 - box[1] + int(SIZE * 0.01)
    d.text((x, y), text, font=f, fill=WHITE)
    return canvas


def wordmark_tile():
    """Alternative: the whole wordmark, white, on the coral tile."""
    src = Image.open(f"{OUT}/indubaicity-mark.png").convert("RGBA")
    white = Image.new("RGBA", src.size, WHITE)
    white.putalpha(src.split()[3])
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.18), fill=CORAL)
    target = int(SIZE * 0.86)
    white.thumbnail((target, target), Image.LANCZOS)
    canvas.paste(white, ((SIZE - white.width) // 2, (SIZE - white.height) // 2), white)
    return canvas


def save_set(master, prefix, ico=False):
    os.makedirs(PREVIEW, exist_ok=True)
    sizes = {"32": 32, "180": 180, "192": 192, "512": 512}
    for name, px in sizes.items():
        master.resize((px, px), Image.LANCZOS).save(f"{OUT}/{prefix}-{name}.png", optimize=True)
    if ico:
        master.resize((256, 256), Image.LANCZOS).save(
            f"{OUT}/{prefix}.ico",
            format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        )


if __name__ == "__main__":
    mono = monogram()
    save_set(mono, "favicon", ico=True)

    alt = wordmark_tile()
    alt.resize((512, 512), Image.LANCZOS).save(f"{PREVIEW}/wordmark-512.png", optimize=True)

    # a contact sheet at the sizes the browser actually uses
    sheet = Image.new("RGB", (5 * 84 + 8, 190), "white")
    d = ImageDraw.Draw(sheet)
    for i, px in enumerate((16, 24, 32, 48, 64)):
        t = mono.resize((px, px), Image.LANCZOS)
        sheet.paste(t, (4 + i * 84 + (72 - px) // 2, 18 + (72 - px) // 2), t)
        t2 = alt.resize((px, px), Image.LANCZOS)
        sheet.paste(t2, (4 + i * 84 + (72 - px) // 2, 100 + (64 - px) // 2 + 8), t2)
        d.text((4 + i * 84, 4), f"{px}px", fill="black")
    sheet.save(f"{PREVIEW}/contact-sheet.png")
    print("wrote assets/favicon.{ico,32,180,192,512} and previews in", PREVIEW)
