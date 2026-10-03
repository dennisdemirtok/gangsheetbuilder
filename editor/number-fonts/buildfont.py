"""
Build TransferCraft's number styles as fonts: digits and space only.

tc-kantig ("Agency"), tc-teknisk ("Din") and tc-liga ("Premier League") are
traced from glyphs.npy; tc-digital ("Digital siffra") is drawn from the
sample's 8: seven mitred segments, thin joins, rounded outer corners.

Writes font-<id>.json ({family, copyright, license, woff2}) into the theme
app extension's assets — the shape the gang sheet editor loads its fonts in.
"""
import base64
import json
import os

import numpy as np
import potrace
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
# Where the editor loads its fonts from (next to editor.iife.js).
ASSETS = os.path.join(HERE, "..", "..", "extensions", "gang-sheet-editor", "assets")
UPM = 1000
CAP = 700
SIDE = 34  # side bearing each side, in units
NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def traced_contours(mask, t, baseline, f):
    """Potrace curves of a mask, in font units: list of contours of segments."""
    p = potrace.Bitmap(~mask).trace(
        turdsize=40,
        turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,
        alphamax=1.15,
        opticurve=True,
        opttolerance=0.8,
    )

    def tf(pt):
        return (pt.x * f + SIDE, (baseline + 1 - (t + pt.y)) * f)

    contours = []
    for c in p.curves:
        segs = []
        for s in c.segments:
            if s.is_corner:
                segs.append(("corner", tf(s.c), tf(s.end_point)))
            else:
                segs.append(("curve", tf(s.c1), tf(s.c2), tf(s.end_point)))
        contours.append((tf(c.start_point), segs))
    return contours


def draw_traced(pen, contours):
    for start, segs in contours:
        pen.moveTo(start)
        for s in segs:
            if s[0] == "corner":
                pen.lineTo(s[1])
                pen.lineTo(s[2])
            else:
                pen.curveTo(s[1], s[2], s[3])
        pen.closePath()


def draw_polygons(pen, geom):
    polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    for poly in polys:
        rings = [poly.exterior] + list(poly.interiors)
        for i, ring in enumerate(rings):
            pts = list(ring.coords)[:-1]
            # TrueType: outer clockwise, holes counter-clockwise (y up).
            area = sum(pts[k][0] * pts[(k + 1) % len(pts)][1] - pts[(k + 1) % len(pts)][0] * pts[k][1] for k in range(len(pts)))
            clockwise = area < 0
            if (i == 0) != clockwise:
                pts = pts[::-1]
            pen.moveTo(pts[0])
            for q in pts[1:]:
                pen.lineTo(q)
            pen.closePath()


def build_font(font_id, family, glyph_draw, advances, out_dir):
    fb = FontBuilder(UPM, isTTF=True)
    order = [".notdef", "space"] + NAMES
    fb.setupGlyphOrder(order)
    cmap = {0x20: "space"}
    cmap.update({0x30 + i: n for i, n in enumerate(NAMES)})
    fb.setupCharacterMap(cmap)

    glyphs = {}
    pen = TTGlyphPen(None)
    glyphs[".notdef"] = pen.glyph()
    glyphs["space"] = TTGlyphPen(None).glyph()
    for name in NAMES:
        tt = TTGlyphPen(None)
        glyph_draw[name](Cu2QuPen(tt, max_err=0.8, reverse_direction=False))
        glyphs[name] = tt.glyph()
    fb.setupGlyf(glyphs)
    glyf = fb.font["glyf"]
    metrics = {".notdef": (int(CAP * 0.5), 0), "space": (int(CAP * 0.28), 0)}
    for name in NAMES:
        g = glyf[name]
        g.recalcBounds(glyf)
        metrics[name] = (int(round(advances[name])), int(getattr(g, "xMin", 0)))
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=850, descent=-150)
    fb.setupNameTable(
        {
            "familyName": family,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"TransferCraft:{family}:1.0",
            "fullName": family,
            "psName": family.replace(" ", ""),
            "version": "Version 1.000",
            "copyright": "© TransferCraft. Siffror ritade av TransferCraft.",
        }
    )
    fb.setupOS2(
        sTypoAscender=850,
        sTypoDescender=-150,
        sTypoLineGap=0,
        usWinAscent=900,
        usWinDescent=200,
        sCapHeight=CAP,
        sxHeight=int(CAP * 0.7),
        fsType=0,
    )
    fb.setupPost()
    fb.font.flavor = "woff2"
    path = f"{HERE}/font-{font_id}.woff2"
    fb.save(path)
    data = open(path, "rb").read()
    os.remove(path)
    json.dump(
        {
            "family": family,
            "copyright": "© TransferCraft. Egna siffror, ritade efter TransferCraft's provark.",
            "license": "TransferCraft — endast för TransferCraft",
            "woff2": base64.b64encode(data).decode("ascii"),
        },
        open(f"{out_dir}/font-{font_id}.json", "w"),
    )
    return path, len(data)


def traced_font(style, font_id, family, result):
    r = result[style]
    f = CAP / (r["baseline"] - r["cap_top"] + 1)
    draws, advances = {}, {}
    for d, name in enumerate(NAMES):
        mask, t, b = r["glyphs"][d]
        contours = traced_contours(mask, t, r["baseline"], f)
        draws[name] = lambda pen, c=contours: draw_traced(pen, c)
        advances[name] = mask.shape[1] * f + 2 * SIDE
    return build_font(font_id, family, draws, advances, ASSETS)


def digital_font():
    # The sample's 8 is 46 x 80 px with 9-10 px bars and hairline joins.
    H = CAP
    W = round(CAP * 46 / 80)
    T = CAP * 10.2 / 80
    gap = CAP * 0.9 / 80
    radius = CAP * 2.5 / 80
    mid = H / 2
    seg = {
        "a": [(0, 0), (W, 0), (W - T, T), (T, T)],
        "b": [(W, 0), (W, mid), (W - T, mid - T / 2), (W - T, T)],
        "c": [(W, mid), (W, H), (W - T, H - T), (W - T, mid + T / 2)],
        "d": [(0, H), (T, H - T), (W - T, H - T), (W, H)],
        "e": [(0, mid), (T, mid + T / 2), (T, H - T), (0, H)],
        "f": [(0, 0), (T, T), (T, mid - T / 2), (0, mid)],
        "g": [(0, mid), (T, mid - T / 2), (W - T, mid - T / 2), (W, mid), (W - T, mid + T / 2), (T, mid + T / 2)],
    }
    outer = box(0, 0, W, H).buffer(-radius, join_style=2).buffer(radius, join_style=1)
    shapes = {}
    for k, pts in seg.items():
        # y down in the drawing above; fonts count up from the baseline.
        poly = Polygon([(x, H - y) for x, y in pts]).buffer(-gap / 2, join_style=2)
        shapes[k] = poly.intersection(outer)
    digits = {
        "zero": "abcdef", "one": "bc", "two": "abged", "three": "abgcd", "four": "fgbc",
        "five": "afgcd", "six": "afgedc", "seven": "abc", "eight": "abcdefg", "nine": "abcdfg",
    }
    draws, advances = {}, {}
    for name, segs in digits.items():
        geom = unary_union([shapes[s] for s in segs])
        geom = __import__("shapely.affinity", fromlist=["translate"]).translate(geom, xoff=SIDE)
        draws[name] = lambda pen, g=geom: draw_polygons(pen, g)
        advances[name] = W + 2 * SIDE
    return build_font("tc-digital", "TC Digital", draws, advances, ASSETS)


if __name__ == "__main__":
    result = np.load(os.path.join(HERE, "glyphs.npy"), allow_pickle=True).item()
    for style, font_id, family in (
        ("agency", "tc-kantig", "TC Kantig"),
        ("din", "tc-teknisk", "TC Teknisk"),
        ("pl", "tc-liga", "TC Liga"),
    ):
        print(traced_font(style, font_id, family, result))
    print(digital_font())
