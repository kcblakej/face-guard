"""Generates the app, PWA and tray icons. Run: python scripts/make-icons.py (needs Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "src/renderer/public/icons"
BUILD = ROOT / "build"
PUB.mkdir(parents=True, exist_ok=True)
BUILD.mkdir(parents=True, exist_ok=True)

S = 1024
NAVY = (11, 18, 32, 255)
TEAL = (45, 212, 191, 255)
CORAL = (239, 68, 68, 255)
WHITE = (255, 255, 255, 255)


def palm(d, cx, cy, h, color):
    """A simple raised 'stop' palm centred at (cx, cy), total height h."""
    fw = h * 0.16  # finger width
    gap = h * 0.035
    palm_w = 4 * fw + 3 * gap
    left = cx - palm_w / 2
    palm_top = cy - h * 0.05
    d.rounded_rectangle([left, palm_top, left + palm_w, cy + h * 0.45], radius=fw * 0.9, fill=color)
    tops = [0.42, 0.5, 0.46, 0.34]
    for i, t in enumerate(tops):
        x = left + i * (fw + gap)
        d.rounded_rectangle([x, cy - h * t - h * 0.05, x + fw, palm_top + fw], radius=fw / 2, fill=color)
    # thumb, angled out to the left
    d.polygon([(left + fw * 0.2, palm_top + h * 0.15), (left - h * 0.2, cy - h * 0.02),
               (left - h * 0.12, cy - h * 0.12), (left + fw * 0.9, palm_top + h * 0.02)], fill=color)
    d.ellipse([left - h * 0.24, cy - h * 0.14, left - h * 0.08, cy + h * 0.0], fill=color)


def glyph(size=S, bg=True, pad=0.0, ring=TEAL, badge=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size / 1024
    if bg:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(230 * u), fill=NAVY)
    inner = size * (1 - 2 * pad)
    o = size * pad
    k = inner / 1024
    # face (shifted up-left when a badge is drawn)
    cx, cy = o + (440 if badge else 512) * k, o + (460 if badge else 512) * k
    r = (300 if badge else 360) * k
    w = max(2, int((56 if badge else 90) * k))
    d.ellipse([cx - r, cy - r * 1.1, cx + r, cy + r * 1.1], outline=ring, width=w)
    er = r * 0.1
    for ex in (cx - r * 0.36, cx + r * 0.36):
        d.ellipse([ex - er, cy - r * 0.2 - er, ex + er, cy - r * 0.2 + er], fill=WHITE)
    d.arc([cx - r * 0.42, cy - r * 0.1, cx + r * 0.42, cy + r * 0.5], 25, 155, fill=WHITE, width=max(2, int(w * 0.7)))
    if badge:
        bx, by, br = o + 730 * k, o + 740 * k, 210 * k
        d.ellipse([bx - br - 24 * k, by - br - 24 * k, bx + br + 24 * k, by + br + 24 * k], fill=NAVY)
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=CORAL)
        palm(d, bx + 14 * k, by + 8 * k, br * 1.25, WHITE)
    return img


def save(img, path, size):
    img.resize((size, size), Image.LANCZOS).save(path)


base = glyph()
save(base, PUB / "icon-192.png", 192)
save(base, PUB / "icon-512.png", 512)
save(base, BUILD / "icon.png", 512)
# Maskable: full-bleed background, content inside the 80% safe zone.
m = Image.new("RGBA", (S, S), NAVY)
m.alpha_composite(glyph(S, bg=False, pad=0.12))
save(m, PUB / "icon-maskable-512.png", 512)
apple = Image.new("RGBA", (S, S), NAVY)
apple.alpha_composite(glyph(S, bg=False, pad=0.08))
save(apple.convert("RGB"), PUB / "apple-touch-icon.png", 180)
base.save(BUILD / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# Tray icons: status-colored face ring on transparent background, with @2x for high-DPI.
TRAY = {
    "watching": TEAL,
    "touching": (245, 158, 11, 255),
    "alert": CORAL,
    "paused": (139, 151, 173, 255),
}
for name, color in TRAY.items():
    t = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    d.ellipse([40, 40, S - 40, S - 40], fill=NAVY)
    t.alpha_composite(glyph(S, bg=False, pad=0.02, ring=color, badge=False))
    save(t, BUILD / f"tray-{name}.png", 16)
    save(t, BUILD / f"tray-{name}@2x.png", 32)
print("icons written")

# Microsoft Store (MSIX) tiles and logos -> build/appx/ (picked up by electron-builder's appx target).
APPX = BUILD / "appx"
APPX.mkdir(exist_ok=True)
for old in APPX.glob("*.png"):
    old.unlink()


def tile(w, h, glyph_frac):
    img = Image.new("RGBA", (w, h), NAVY)
    g = min(w, h) * glyph_frac
    size = int(g)
    img.alpha_composite(glyph(S, bg=False, pad=0.0).resize((size, size), Image.LANCZOS), ((w - size) // 2, (h - size) // 2))
    return img


APPX_ASSETS = {
    # name: (width, height, glyph size as a fraction of the shorter side)
    "StoreLogo": (50, 50, 0.9),
    "Square44x44Logo": (44, 44, 0.92),
    "SmallTile": (71, 71, 0.7),
    "Square150x150Logo": (150, 150, 0.62),
    "LargeTile": (310, 310, 0.55),
    "Wide310x150Logo": (310, 150, 0.7),
    "SplashScreen": (620, 300, 0.6),
}
for name, (w, h, frac) in APPX_ASSETS.items():
    for scale in (100, 200):
        k = scale / 100
        tile(int(w * k), int(h * k), frac).save(APPX / f"{name}.scale-{scale}.png")
print("store assets written")
