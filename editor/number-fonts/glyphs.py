"""
TransferCraft's own number styles, from their sample sheet, as clean masks.

Shown on the sheet: 0-7 for "Agency", "Din" and "Premier League" (the 7 only
outlined, the same athletic 7 in all three, so it shows the outline rather
than the style's own 7) and an 8 for "Digital siffra".

- 0-6 are traced from the sheet at 10x.
- 7: a top bar and a diagonal in the style's stroke width.
- 8: the 3 and its mirror image (Agency, Din); two stacked rings in the
  0's shape (Premier League, whose 3 has a flat top).
- 9: the 6 turned half a turn.

Writes glyphs.npy: per style and digit a mask (10x the sheet) and where it
sits (top and bottom row, in the row's own coordinates), and glyphs.png to
look at. Then run buildfont.py.

    python3 -m venv .venv && .venv/bin/pip install fonttools brotli numpy scipy scikit-image potracer pillow shapely
    .venv/bin/python glyphs.py && .venv/bin/python buildfont.py
"""
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage.morphology import skeletonize, disk
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
UP = 10
PAD = 4

im = np.asarray(Image.open(f"{HERE}/sample-sheet.png").convert("RGB")).astype(float)
bg = np.median(im[5:40, 5:40].reshape(-1, 3), axis=0)
dist = np.abs(im - bg).max(axis=2)

ROWS = {"agency": (150, 280, 0, 650), "din": (150, 280, 650, 1368), "pl": (500, 642, 650, 1368)}


def boxes_in(y0, y1, x0, x1):
    band = dist[y0:y1, x0:x1] > 8
    lab, _ = ndi.label(ndi.binary_closing(band, iterations=1))
    out = []
    for sl in ndi.find_objects(lab):
        h = sl[0].stop - sl[0].start
        if h < 30:
            continue
        out.append((sl[1].start + x0, sl[1].stop + x0))
    return sorted(out)


def upscale(a):
    img = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    img = img.resize((img.width * UP, img.height * UP), Image.BICUBIC)
    return np.asarray(img).astype(float) / 255


def traced(y0, y1, xa, xb):
    """The digit between xa and xb, in the row's coordinates at 10x, smoothed."""
    c = dist[y0:y1, xa - PAD:xb + PAD]
    m = np.percentile(c[c > 6], 90)
    hi = upscale(c / m)
    # A little blur before the threshold: the sheet is 75 px a digit and its
    # steps would trace as wobbles.
    hi = ndi.gaussian_filter(hi, 13)
    mask = ndi.binary_opening(hi > 0.5, iterations=2)
    lab, n = ndi.label(mask)
    if n > 1:  # keep the digit, drop specks
        sizes = ndi.sum(mask, lab, range(1, n + 1))
        mask = lab == (1 + int(np.argmax(sizes)))
    return mask


def extent(mask):
    ys, xs = np.where(mask)
    return ys.min(), ys.max(), xs.min(), xs.max()


def crop(mask):
    t, b, l, r = extent(mask)
    return mask[t:b + 1, l:r + 1], t, b


def half_width(m):
    sk = skeletonize(m)
    dt = ndi.distance_transform_edt(m)
    return float(np.median(dt[sk]))


def smooth(m, r):
    se = disk(max(1, r))
    p = r + 2
    out = ndi.binary_closing(np.pad(m, p), structure=se)
    out = ndi.binary_opening(out, structure=se)
    return out[p:-p, p:-p]


def seven(W, H, T, bottom_right=0.46):
    xb = W * bottom_right
    s = (W - xb) / (H - T)
    th = T * np.sqrt(1 + s * s)
    g = unary_union([box(0, 0, W, T), Polygon([(W - th, 0), (W, 0), (xb, H), (xb - th, H)])])
    g = g.intersection(box(0, 0, W, H))
    r = T * 0.12
    g = g.buffer(-r, join_style=1).buffer(r, join_style=1)
    img = Image.new("1", (int(round(W)), int(round(H))), 0)
    ImageDraw.Draw(img).polygon(list(g.exterior.coords), fill=1)
    return np.asarray(img).astype(bool)


def resize_mask(m, w, h):
    img = Image.fromarray((m * 255).astype(np.uint8)).resize((int(w), int(h)), Image.LANCZOS)
    return np.asarray(img) > 127


def stacked_rings(zero, T, top_scale=0.9, split=0.47):
    H, W = zero.shape
    filled = ndi.binary_fill_holes(zero)
    th = int(H * split + T / 2)
    bh = int(H * (1 - split) + T / 2)
    top = resize_mask(filled, W * top_scale, th)
    bot = resize_mask(filled, W, bh)
    se = disk(int(T))

    def ring(o):
        p = int(T) + 2
        inner = ndi.binary_erosion(np.pad(o, p), structure=se)[p:-p, p:-p]
        return o & ~inner

    out = np.zeros((H, W), bool)
    x0 = (W - top.shape[1]) // 2
    out[:th, x0:x0 + top.shape[1]] |= ring(top)
    out[H - bh:, :] |= ring(bot)
    return smooth(out, int(T * 0.12))


result = {}
for style, (y0, y1, x0, x1) in ROWS.items():
    spans = boxes_in(y0, y1, x0, x1)
    assert len(spans) == 8, (style, len(spans))
    g = {}
    for d in range(7):
        m, t, b = crop(traced(y0, y1, *spans[d]))
        g[d] = (m, t, b)
    T = 2 * float(np.median([half_width(g[d][0]) for d in range(7)]))
    # Where the flat-bottomed digits stand, and the height of a flat top.
    baseline = int(np.median([g[d][2] for d in (1, 2, 4)]))
    cap_top = int(np.median([g[d][1] for d in (1, 4, 5)]))
    H = baseline - cap_top + 1
    # 9
    m6, t6, b6 = g[6]
    g[9] = (np.rot90(m6, 2), t6, b6)
    # 8
    m3, t3, b3 = g[3]
    if style == "pl":
        m0, t0, b0 = g[0]
        g[8] = (stacked_rings(m0, T), t0, b0)
    else:
        g[8] = (smooth(m3 | np.fliplr(m3), int(T * 0.15)), t3, b3)
    # 7: as wide as the 2, flat on top and on the baseline.
    W2 = g[2][0].shape[1]
    g[7] = (seven(W2, H, T), cap_top, baseline)
    result[style] = {"glyphs": g, "stroke": T, "baseline": baseline, "cap_top": cap_top}
    print(style, "stroke", round(T), "cap height", H, "px at 10x")

np.save(f"{HERE}/glyphs.npy", result, allow_pickle=True)

# Preview: each row on its own baseline.
rows = []
for style in ("agency", "din", "pl"):
    r = result[style]
    top = min(v[1] for v in r["glyphs"].values())
    bottom = max(v[2] for v in r["glyphs"].values())
    W = sum(v[0].shape[1] for v in r["glyphs"].values()) + 70 * 10
    c = Image.new("L", (W, bottom - top + 1), 255)
    x = 0
    for d in range(10):
        m, t, b = r["glyphs"][d]
        c.paste(Image.fromarray(((~m) * 255).astype(np.uint8)), (x, t - top))
        x += m.shape[1] + 70
    rows.append(c)
out = Image.new("L", (max(c.width for c in rows), sum(c.height + 80 for c in rows)), 255)
y = 0
for c in rows:
    out.paste(c, (0, y))
    y += c.height + 80
out.resize((out.width // 6, out.height // 6)).save(f"{HERE}/glyphs.png")
print("preview written")
