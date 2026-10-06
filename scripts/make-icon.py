# Builds the app icon from resources/logo-source.png:
#   resources/icon.png + icon.icns  (macOS grid: 824px rounded tile on a 1024px transparent canvas)
#   src/renderer/src/assets/logo.png (full-bleed rounded tile for the UI)
# Needs Pillow + numpy, and macOS `iconutil` for the .icns.   python3 scripts/make-icon.py
import subprocess, shutil, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SS = 4  # supersampling for smooth corners

def glyph():
    """The mark cropped to its ink (the source has a wide white margin)."""
    src = Image.open(ROOT / 'resources/logo-source.png').convert('RGBA')
    white = Image.new('RGBA', src.size, 'white')
    rgb = Image.alpha_composite(white, src).convert('RGB')
    ink = np.asarray(rgb.convert('L')) < 200
    ys, xs = np.where(ink)
    return rgb.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

def tile(size, radius_ratio=0.2237, fill=0.60):
    """White rounded square with the mark centred, `fill` = share of the tile the mark's longer side takes."""
    big = size * SS
    g = glyph()
    scale = big * fill / max(g.size)
    g = g.resize((round(g.width * scale), round(g.height * scale)), Image.LANCZOS)
    img = Image.new('RGB', (big, big), 'white')
    img.paste(g, ((big - g.width) // 2, (big - g.height) // 2))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * radius_ratio), fill=255)
    img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)

def app_icon():
    canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    t = tile(824)
    shadow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 70), (100, 110), t.getchannel('A'))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(12)))
    canvas.alpha_composite(t, (100, 100))
    return canvas

icon = app_icon()
icon.save(ROOT / 'resources/icon.png')
tile(256).save(ROOT / 'src/renderer/src/assets/logo.png')

if shutil.which('iconutil'):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'icon.iconset'
        iconset.mkdir()
        for s in (16, 32, 128, 256, 512):
            icon.resize((s, s), Image.LANCZOS).save(iconset / f'icon_{s}x{s}.png')
            icon.resize((s * 2, s * 2), Image.LANCZOS).save(iconset / f'icon_{s}x{s}@2x.png')
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(ROOT / 'resources/icon.icns')], check=True)
print('wrote resources/icon.png, resources/icon.icns, src/renderer/src/assets/logo.png')
