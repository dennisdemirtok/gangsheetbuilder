"""
The user's own team figures as fonts: "Egen kantig" and "Egen med
skugglinje", first drawn for Sundsvalls HK (2026-10-16).

The sources are the figures cut out of those print sheets, 300 dpi, 25 cm
tall (egna/<style>/0-9.png); each is traced with the same potrace settings
as the sample-sheet styles. Run after buildfont.py's requirements are in
place: python egna.py
"""
import os

import numpy as np
from PIL import Image

import buildfont
from buildfont import ASSETS, NAMES, build_font, draw_traced, traced_contours

HERE = os.path.dirname(os.path.abspath(__file__))
# The sheets set 1,7 cm between the figures of a 25 cm number; side
# bearings of 24 units give the same gap.
buildfont.SIDE = 24

STYLES = (
    ("kantig", "tc-egen-kantig", "TC Egen Kantig"),
    ("skugglinje", "tc-egen-skugglinje", "TC Egen Skugglinje"),
)


def egen_font(style, font_id, family):
    masks = [np.array(Image.open(os.path.join(HERE, "egna", style, f"{d}.png")).getchannel("A")) > 127 for d in range(10)]
    height = max(m.shape[0] for m in masks)
    f = buildfont.CAP / height
    draws, advances = {}, {}
    for d, name in enumerate(NAMES):
        mask = masks[d]
        top = height - mask.shape[0]
        contours = traced_contours(mask, top, height - 1, f)
        draws[name] = lambda pen, c=contours: draw_traced(pen, c)
        advances[name] = mask.shape[1] * f + 2 * buildfont.SIDE
    return build_font(font_id, family, draws, advances, ASSETS)


if __name__ == "__main__":
    for style, font_id, family in STYLES:
        print(egen_font(style, font_id, family))
