#!/usr/bin/env python3
"""
Label-chip detection + glyph OCR for the Approved Ops 2025 map cards.

The cards print each terrain piece's letter (A..N on Volkus, A..D on
Bheta-Decima, A1..A4 / B1..B4 / C1..C5 / T on the close-quarters killzones) as
white text on a small opaque chip:

    Volkus / Bheta-Decima   chip fill (79, 85, 90)
    Gallowdark / Tomb World chip fill (103, 103, 98)
    Tomb World light terrain + teleport pads  chip fill (0, 0, 0)

OCR is exact-bitmap matching. The cards are vector renders at one fixed scale,
so each character is pixel-identical up to a handful of sub-pixel rasterisation
variants; `GLYPHS` maps the raw glyph bitmap signature to its character.
Regenerate the unmapped-signature contact sheet with:

    python3 tools/maps/labels.py --dump
"""
from __future__ import annotations

import hashlib
import os
import sys

import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cardlib as C  # noqa: E402

BLACK_CHIP = dict(min_w=18, max_w=90, min_h=18, max_h=90)

CHIP_COLOURS = {
    'open': (79, 85, 90),
    'cq': (103, 103, 98),
    'black': (0, 0, 0),
}


def _sig(bitmap: np.ndarray) -> str:
    h, w = bitmap.shape
    return '%dx%d.' % (w, h) + hashlib.sha1(np.packbits(bitmap).tobytes()).hexdigest()[:8]


def _crop(sub: np.ndarray) -> np.ndarray:
    ys, xs = np.where(sub)
    return sub[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def _fill_small_holes(mask: np.ndarray, max_area: int) -> np.ndarray:
    """Fill enclosed background regions smaller than max_area.

    Plain fill_holes would swallow the interior of the Bheta-Decima gantry
    outline (a large closed stroke in the same colour as the chips).
    """
    inv = ~mask
    lab, n = ndimage.label(inv)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    out = mask.copy()
    for i in range(1, n + 1):
        if i in border:
            continue
        blob = lab == i
        if blob.sum() <= max_area:
            out |= blob
    return out


def chip_boxes(img: np.ndarray, kind: str, min_w=12, max_w=64, min_h=14, max_h=40):
    """Opaque label chips of the given fill colour.

    Chips can touch same-coloured strokes (the Bheta-Decima gantry outline), so
    the mask is opened first to sever 1-2px connections, and the white text
    punches holes that are filled back in.
    """
    m = C.mask_exact(img, CHIP_COLOURS[kind], 0)
    m = _fill_small_holes(m, 400)     # the white text punches holes in the chip
    m = ndimage.binary_opening(m, np.ones((3, 3), bool))  # sever thin strokes
    lab, n = ndimage.label(m)
    white = (img >= 200).all(2)
    out = []
    for i, o in enumerate(ndimage.find_objects(lab)):
        h = o[0].stop - o[0].start
        w = o[1].stop - o[1].start
        if not (min_h <= h <= max_h and min_w <= w <= max_w):
            continue
        a = (lab[o] == i + 1).sum()
        if a < 0.75 * w * h:
            continue
        if white[o].sum() < 12:
            continue
        out.append((o[1].start, o[0].start, o[1].stop, o[0].stop))
    return out


def read_chip(img: np.ndarray, box, thresh: int = 200) -> tuple[str, list]:
    """OCR one chip. Returns (text, [glyph bitmaps]).

    `thresh` is the white-ink cut. The black light-terrain chips on the Tomb
    World cards print their text in a lighter weight, so their anti-aliased
    strokes need a lower cut than the bold chips (which would smear together
    at the same value).
    """
    x0, y0, x1, y1 = box
    sub = (img[y0:y1, x0:x1] >= thresh).all(2)
    lab, n = ndimage.label(sub)
    parts = []
    for i, o in enumerate(ndimage.find_objects(lab)):
        h = o[0].stop - o[0].start
        w = o[1].stop - o[1].start
        if h < 7 or w < 2:
            continue
        bm = _crop(lab[o] == i + 1)
        if bm.mean() > 0.94 and bm.shape[1] > 3:
            continue          # solid block: printed decoration, not a glyph
        parts.append((o[1].start, bm))
    parts.sort(key=lambda t: t[0])
    return ''.join(GLYPHS.get(_sig(b), '?') for _, b in parts), [b for _, b in parts]


INK_THRESH = {'open': 200, 'cq': 200, 'black': 140}


def chips(img: np.ndarray, kind: str, **kw):
    """[(text, cx_px, cy_px, (x0,y0,x1,y1))] for every readable chip."""
    out = []
    for box in chip_boxes(img, kind, **kw):
        text, _ = read_chip(img, box, INK_THRESH[kind])
        # Unrecognised blobs are printed decoration (the octagon's bevel, the
        # teleport pad's ring, the objective marker's skull) rather than text.
        text = text.replace('?', '')
        if text:
            out.append((text, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box))
    return out


# Signature -> character, read off the --dump contact sheet. Signatures encode
# the glyph's pixel dimensions, so they are stable across re-runs.
GLYPHS = {
    # signature -> character, read off the --dump contact sheet.
    "10x11.5cfcee53": "A",
    "10x11.7f0ae727": "A",
    "10x11.b25e94e1": "A",
    "10x11.cff96626": "C",
    "10x12.ca23cf44": "C",
    "10x12.d9dfb11f": "4",
    "10x13.0792c107": "B",
    "10x13.0f444107": "4",
    "10x13.1c3dd235": "B",
    "10x13.28f5beea": "3",
    "10x13.9c098cd7": "3",
    "10x13.a80ead43": "4",
    "10x13.f4979249": "B",
    "11x12.610dc961": "C",
    "11x13.5c85c0a4": "C",
    "11x13.66ed1b9f": "C",
    "12x11.15a77f6c": "M",
    "12x11.7321423e": "M",
    "12x11.afa2f4a9": "M",
    "12x11.b75cfcf8": "M",
    "12x13.9a96785f": "A",
    "2x10.6cb029c8": "I",
    "2x11.4b9dc367": "I",
    "2x11.60c66d51": "I",
    "3x13.b5e45ce9": "1",
    "5x13.acfcd866": "1",
    "7x10.6d5e3712": "J",
    "7x11.100ebb0b": "L",
    "7x11.3e126227": "F",
    "7x11.56fc3c3f": "E",
    "7x11.9c458399": "J",
    "8x10.2a8baf66": "B",
    "8x11.2b08e4ef": "B",
    "8x11.8729fc7e": "B",
    "8x11.99ad1e10": "B",
    "8x11.9c3c6e43": "B",
    "8x12.c1f81fe4": "2",
    "8x13.9b6cb635": "5",
    "9x10.09e904f2": "H",
    "9x10.98d60864": "A",
    "9x10.c16d1702": "A",
    "9x10.ea00c130": "A",
    "9x11.04073152": "D",
    "9x11.1bf61302": "H",
    "9x11.24da13b8": "C",
    "9x11.3149586a": "G",
    "9x11.47c5a1fb": "H",
    "9x11.56d08f15": "C",
    "9x11.5a4ff952": "K",
    "9x11.a2bd7b50": "G",
    "9x11.a4a4f5b5": "C",
    "9x11.a69d1e4a": "D",
    "9x11.a6ed2a76": "N",
    "9x11.bd57a57b": "K",
    "9x11.c81e8341": "K",
    "9x11.cb0a64ee": "N",
    "9x11.dba0ea07": "D",
    "9x12.bd8d9d19": "T",
    "9x13.89f0ade9": "2",
    "9x13.a120cd20": "2",
    "9x13.c7acfed3": "3",
    "9x13.d3f7d137": "2",
    # Tomb World light-terrain / teleport-pad chips (lighter ink, thresh 140)
    "10x13.23705551": "4",
    "10x13.7e3ae1d9": "T",
    "11x13.8792d30d": "C",
    "11x13.8fbb9c89": "C",
    "11x14.25d51788": "C",
    "11x14.87a6158a": "C",
    "5x13.6dd4b44c": "1",
    "8x13.41f055cd": "5",
    "8x14.b4b413a5": "2",
    "9x13.19c65485": "2",
    "9x13.c8985091": "3",
    # 8x7.88391f98 is a fragment of the objective-marker skull, deliberately
    # left unmapped so those blobs read "?" and are discarded.
}


def _dump():
    """Contact sheet of every glyph signature that GLYPHS does not yet name."""
    import glob
    from collections import Counter, defaultdict
    from PIL import Image, ImageDraw

    occ = defaultdict(list)
    bit = {}
    for f in sorted(glob.glob(C.CARDS_DIR + '/*.png')):
        b = os.path.basename(f)
        if b.startswith('Non-specific'):
            continue
        img = C.load(f)
        cq = b.startswith('Gallowdark') or b.startswith('Tomb-World')
        for kind, kw in ((('cq', {}), ('black', BLACK_CHIP)) if cq else (('open', {}),)):
            for box in chip_boxes(img, kind, **kw):
                for bm in read_chip(img, box, INK_THRESH[kind])[1]:
                    s = _sig(bm)
                    occ[s].append(b[:4])
                    bit[s] = bm
    unknown = [s for s in sorted(occ) if s not in GLYPHS]
    print('%d signatures, %d unmapped' % (len(occ), len(unknown)))
    if not unknown:
        return
    os.makedirs('/tmp/glyphs', exist_ok=True)
    cols, cw, ch, S = 5, 120, 200, 10
    rows = (len(unknown) + cols - 1) // cols
    im = Image.new('RGB', (cols * cw, rows * ch), 'white')
    d = ImageDraw.Draw(im)
    for k, s in enumerate(unknown):
        bm = bit[s]
        g = Image.fromarray(((~bm) * 255).astype(np.uint8)).convert('RGB')
        g = g.resize((bm.shape[1] * S, bm.shape[0] * S), Image.NEAREST)
        cx, cy = (k % cols) * cw, (k // cols) * ch
        im.paste(g, (cx + 5, cy + 4))
        d.text((cx + 3, cy + 160), '#%d %s' % (k, s), fill='red')
        d.text((cx + 3, cy + 174), str(dict(Counter(occ[s]))), fill='blue')
    im.save('/tmp/glyphs/unknown.png')
    print('/tmp/glyphs/unknown.png', im.size)


if __name__ == '__main__':
    if '--dump' in sys.argv:
        _dump()
