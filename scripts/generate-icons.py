#!/usr/bin/env python3
"""Generate favicon.ico and PWA/home-screen icons from assets/logo.png.

Run via `npm run icons` after changing the logo. Requires Pillow.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "logo.png"
ICONS = ROOT / "public" / "icons"

# Android launchers may crop maskable icons to a circle spanning 80% of the
# canvas; keep the mark inside 70% for comfortable breathing room.
MASKABLE_CONTENT_FRACTION = 0.70


def content_bbox(img, tolerance=30):
    """Bounding box of pixels that differ from the corner background color."""
    bg = img.getpixel((2, 2))
    px = img.load()
    w, h = img.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if sum(abs(a - b) for a, b in zip(px[x, y], bg)) > tolerance:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def main():
    logo = Image.open(LOGO).convert("RGB")
    bg = logo.getpixel((2, 2))
    left, top, right, bottom = content_bbox(logo)
    mark_size = max(right - left, bottom - top)

    ICONS.mkdir(parents=True, exist_ok=True)

    for name, size in [
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("apple-touch-icon.png", 180),
    ]:
        logo.resize((size, size), Image.LANCZOS).save(ICONS / name)
        print(f"icons/{name} ({size}x{size})")

    # Maskable: same mark, rescaled onto a background-filled canvas so the
    # circle lands inside the safe zone regardless of the logo's own padding.
    size = 512
    scale = size * MASKABLE_CONTENT_FRACTION / mark_size
    scaled = logo.resize(
        (round(logo.width * scale), round(logo.height * scale)), Image.LANCZOS
    )
    canvas = Image.new("RGB", (size, size), bg)
    canvas.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    canvas.save(ICONS / "icon-maskable-512.png")
    print(f"icons/icon-maskable-512.png ({size}x{size}, mark at "
          f"{MASKABLE_CONTENT_FRACTION:.0%})")

    # Favicon: crop closer to the mark so it stays legible at 16px.
    margin = mark_size // 16
    crop = logo.crop(
        (left - margin, top - margin, right + margin, bottom + margin)
    )
    sizes = [(16, 16), (32, 32), (48, 48)]
    crop.save(ROOT / "public" / "favicon.ico", sizes=sizes)
    print(f"favicon.ico ({', '.join(f'{w}x{h}' for w, h in sizes)})")


if __name__ == "__main__":
    main()
