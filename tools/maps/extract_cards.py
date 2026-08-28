#!/usr/bin/env python3
"""
Extract the 24 Approved Ops 2025 killzone map layouts from the official map-card
PNGs into `data/maps/<killzone>/<killzone>-N.json`, and the terrain piece
templates into `data/terrain/<killzone>.json`.

    python3 tools/maps/extract_cards.py                  # all 24 cards
    python3 tools/maps/extract_cards.py volkus-1 ...     # a subset

Nothing is hand-traced: every polygon comes from a colour mask on the card.
See tools/maps/README.md for the method and the tolerances.
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cardlib as C          # noqa: E402
import doors as DOORS        # noqa: E402
import geom as G             # noqa: E402
import labels as L           # noqa: E402
import terrain as T          # noqa: E402

ROOT = C.ROOT
OUT_MAPS = os.path.join(ROOT, 'data', 'maps')
OUT_TERRAIN = os.path.join(ROOT, 'data', 'terrain')
TOOL = 'tools/maps/extract_cards.py'

CARDS = (
    [(f'Volkus2025-{i}.png', f'volkus-{i}', 'volkus', f'Volkus {i}') for i in range(1, 7)] +
    [(f'Bheta-Decima2025-{"55" if i == 5 else i}.png', f'bheta-decima-{i}', 'bheta-decima',
      f'Bheta-Decima {i}') for i in range(1, 7)] +
    [(f'Gallowdark{i}.png', f'gallowdark-{i}', 'gallowdark', f'Gallowdark {i}')
     for i in range(1, 7)] +
    [(f'Tomb-World{i}.png', f'tomb-world-{i}', 'tomb-world', f'Tomb World {i}')
     for i in range(1, 7)]
)

CQ_KILLZONES = {'gallowdark', 'tomb-world'}


# ===========================================================================
# Shared board furniture
# ===========================================================================

def _band(mask: np.ndarray, axis: int, frac=0.35):
    """Extent of a full-width/height tint band along `axis` (0=x, 1=y), in px."""
    prof = mask.sum(0 if axis == 0 else 1)
    span = mask.shape[0] if axis == 0 else mask.shape[1]
    idx = np.where(prof > frac * span)[0]
    return (int(idx.min()), int(idx.max()) + 1) if len(idx) else None


def extract_zones(img, frame, cq):
    """Drop zones, territories, the deployment axis and the drop-zone depth."""
    interior = np.zeros(img.shape[:2], bool)
    x0, y0, x1, y1 = frame.qa['board_px']
    interior[y0:y1, x0:x1] = True

    def tint(keys):
        return C.mask_any(img, [C.PALETTE[k] for k in keys], tol=3) & interior

    # Solid fills only: on the close-quarters cards the multiply-darkened
    # 3.8125" lattice line over P2 territory lands within 2 of the P2 drop-zone
    # grid colour, which would smear the drop-zone band across the whole half.
    p1d = tint(['p1_drop'])
    p2d = tint(['p2_drop'])
    p1t = tint(['p1_terr'])
    p2t = tint(['p2_terr'])

    # Which axis do the drop zones band along?
    hx = _band(p1d, 0)
    hy = _band(p1d, 1)
    vertical_bands = (hx is not None) and (hx[1] - hx[0]) < (x1 - x0) * 0.5
    axis = 'x' if vertical_bands else 'y'

    W, H = frame.board_w, frame.board_h

    def depth_from(px_lo, px_hi, side):
        """Board-space depth of a band that runs from a board edge."""
        if axis == 'x':
            lo = frame.to_board(px_lo, (y0 + y1) / 2)[0]
            hi = frame.to_board(px_hi, (y0 + y1) / 2)[0]
            return (hi if side == 'lo' else W - lo), (lo, hi)
        lo = frame.to_board((x0 + x1) / 2, px_hi)[1]     # px y down -> board y up
        hi = frame.to_board((x0 + x1) / 2, px_lo)[1]
        return (hi if side == 'lo' else H - lo), (lo, hi)

    def band_poly(mask, terr_mask):
        m = mask | terr_mask
        if axis == 'x':
            b = _band(mask, 0)
            lo = frame.to_board(b[0], (y0 + y1) / 2)[0]
            hi = frame.to_board(b[1], (y0 + y1) / 2)[0]
            near_left = b[0] - x0 < x1 - b[1]
            if cq:
                lo, hi = _snap_cq(frame, lo, 'x'), _snap_cq(frame, hi, 'x')
            else:
                lo, hi = _snap(lo, W), _snap(hi, W)
            if near_left:
                lo = 0.0
            else:
                hi = W
            return [(lo, 0.0), (hi, 0.0), (hi, H), (lo, H)], ('left' if near_left else 'right'), \
                   (hi - lo)
        b = _band(mask, 1)
        top = frame.to_board((x0 + x1) / 2, b[0])[1]
        bot = frame.to_board((x0 + x1) / 2, b[1])[1]
        near_top = (b[0] - y0) < (y1 - b[1])
        lo, hi = min(top, bot), max(top, bot)
        if cq:
            lo, hi = _snap_cq(frame, lo, 'y'), _snap_cq(frame, hi, 'y')
        else:
            lo, hi = _snap(lo, H), _snap(hi, H)
        if near_top:
            hi = H
        else:
            lo = 0.0
        return [(0.0, lo), (W, lo), (W, hi), (0.0, hi)], ('top' if near_top else 'bottom'), \
               (hi - lo)

    p1_poly, p1_side, p1_depth = band_poly(p1d, p1t)
    p2_poly, p2_side, p2_depth = band_poly(p2d, p2t)

    # Territories: each player's half, split on the board centre line.
    if axis == 'x':
        mid = W / 2
        left = [(0.0, 0.0), (mid, 0.0), (mid, H), (0.0, H)]
        right = [(mid, 0.0), (W, 0.0), (W, H), (mid, H)]
        p1_terr = right if p1_side == 'right' else left
        p2_terr = left if p1_side == 'right' else right
        centre = {'a': (mid, 0.0), 'b': (mid, H)}
        flank = {'a': (0.0, H / 2), 'b': (W, H / 2)}
    else:
        mid = H / 2
        bottom = [(0.0, 0.0), (W, 0.0), (W, mid), (0.0, mid)]
        top = [(0.0, mid), (W, mid), (W, H), (0.0, H)]
        p1_terr = top if p1_side == 'top' else bottom
        p2_terr = bottom if p1_side == 'top' else top
        centre = {'a': (0.0, mid), 'b': (W, mid)}
        flank = {'a': (W / 2, 0.0), 'b': (W / 2, H)}

    # QA: the printed territory tints must meet exactly on the centre line.
    if axis == 'x':
        seam = _seam(p1t | p1d, p2t | p2d, 0)
        seam_in = frame.to_board(seam, (y0 + y1) / 2)[0] if seam is not None else None
    else:
        seam = _seam(p1t | p1d, p2t | p2d, 1)
        seam_in = frame.to_board((x0 + x1) / 2, seam)[1] if seam is not None else None

    return dict(axis=axis, p1_side=p1_side, p2_side=p2_side,
                dropZones={'p1': [p1_poly], 'p2': [p2_poly]},
                territories={'p1': [p1_terr], 'p2': [p2_terr]},
                centreLine=centre, flankLine=flank,
                p1_depth=p1_depth, p2_depth=p2_depth,
                seam=seam_in, mid=mid)


def _snap(v, extent, step=0.125):
    v = round(v / step) * step
    return min(max(v, 0.0), extent)


def _snap_cq(frame, v, axis):
    """Snap to the nearest close-quarters lattice line (or the board edge)."""
    n = C.CQ_NX if axis == 'x' else C.CQ_NY
    b = C.CQ_BORDER_X if axis == 'x' else C.CQ_BORDER_Y
    ext = frame.board_w if axis == 'x' else frame.board_h
    cands = [0.0, ext] + [b + i * C.CQ_SQUARE for i in range(n + 1)]
    return min(cands, key=lambda c: abs(c - v))


def _seam(a, b, axis):
    """Where mask `a` gives way to mask `b`, as the median over scanlines.

    Taking the median rather than the global extent keeps the measurement honest
    on Bheta-Decima, where the printed ocean covers the tints over most of the
    board's middle.
    """
    vals = []
    n = a.shape[1] if axis == 0 else a.shape[0]
    lines = a.shape[0] if axis == 0 else a.shape[1]
    for k in range(0, lines, 3):
        la = a[k] if axis == 0 else a[:, k]
        lb = b[k] if axis == 0 else b[:, k]
        ia = np.where(la)[0]
        ib = np.where(lb)[0]
        if not len(ia) or not len(ib):
            continue
        if ia.max() < ib.min():
            vals.append((ia.max() + ib.min()) / 2)
        elif ib.max() < ia.min():
            vals.append((ib.max() + ia.min()) / 2)
    return float(np.median(vals)) if vals else None


def extract_edges(img, frame):
    """Killzone edge ownership, read off the printed dot strip around the board."""
    x0, y0, x1, y1 = frame.qa['board_px']
    owners = {'p1': C.PALETTE['p1_edge'], 'p2': C.PALETTE['p2_edge'],
              'neutral': C.PALETTE['n_edge']}
    masks = {k: C.mask_exact(img, v, 6) for k, v in owners.items()}
    H, W = img.shape[:2]
    out = {'p1': [], 'p2': [], 'neutral': []}
    # Each board side: sample the dot strip outside the interior.
    sides = [
        ('top',    lambda i: (i, slice(0, y0)),  x0, x1),
        ('bottom', lambda i: (i, slice(y1, H)),  x0, x1),
        ('left',   lambda i: (slice(x0, x1), i), None, None),
        ('right',  lambda i: (slice(x0, x1), i), None, None),
    ]
    for name in ('top', 'bottom', 'left', 'right'):
        if name in ('top', 'bottom'):
            strip = slice(0, y0) if name == 'top' else slice(y1, H)
            runs = _classify_run(masks, lambda k, i: masks[k][strip, i].sum(), range(x0, x1))
            for owner, a, b in runs:
                pa = frame.to_board(a, y0 if name == 'top' else y1)
                pb = frame.to_board(b, y0 if name == 'top' else y1)
                ycoord = frame.board_h if name == 'top' else 0.0
                out[owner].append({'a': (round(pa[0], 3), ycoord), 'b': (round(pb[0], 3), ycoord)})
        else:
            strip = slice(0, x0) if name == 'left' else slice(x1, W)
            runs = _classify_run(masks, lambda k, i: masks[k][i, strip].sum(), range(y0, y1))
            for owner, a, b in runs:
                pa = frame.to_board(x0 if name == 'left' else x1, a)
                pb = frame.to_board(x0 if name == 'left' else x1, b)
                xcoord = 0.0 if name == 'left' else frame.board_w
                out[owner].append({'a': (xcoord, round(pa[1], 3)), 'b': (xcoord, round(pb[1], 3))})
    return out


def _classify_run(masks, score, rng):
    """Walk one board side and split it into runs of a single edge owner."""
    seq = []
    for i in rng:
        best, bv = None, 0
        for k in masks:
            v = score(k, i)
            if v > bv:
                best, bv = k, v
        seq.append(best)
    # fill gaps between dots
    last = None
    for i, v in enumerate(seq):
        if v is None:
            seq[i] = last
        else:
            last = v
    for i in range(len(seq) - 1, -1, -1):
        if seq[i] is None:
            seq[i] = last
        else:
            last = seq[i]
    runs, start = [], 0
    for i in range(1, len(seq) + 1):
        if i == len(seq) or seq[i] != seq[start]:
            if seq[start] is not None and (i - start) > 8:
                runs.append((seq[start], list(rng)[start], list(rng)[i - 1] + 1))
            start = i
    return runs


def extract_objectives(img, frame):
    """The three objective markers, classified by the ring colour around the white annulus."""
    white = (img >= 245).all(2)
    lab, n = ndimage.label(white)
    out = []
    for i, o in enumerate(ndimage.find_objects(lab)):
        h = o[0].stop - o[0].start
        w = o[1].stop - o[1].start
        if not (26 <= h <= 40 and 26 <= w <= 40):
            continue
        blob = lab[o] == i + 1
        if blob.mean() > 0.75:                 # the marker's white part is an annulus
            continue
        cy = (o[0].start + o[0].stop) / 2
        cx = (o[1].start + o[1].stop) / 2
        r = max(h, w) / 2 - 4        # inside the white outline, on the owner disc
        ring = []
        for a in np.linspace(0, 2 * np.pi, 72, endpoint=False):
            py, px = int(round(cy + r * np.sin(a))), int(round(cx + r * np.cos(a)))
            if 0 <= py < img.shape[0] and 0 <= px < img.shape[1]:
                ring.append(img[py, px])
        ring = np.array(ring, float)
        kind = _ring_owner(ring)
        if kind is None:
            continue
        bx, by = frame.to_board(cx, cy)
        out.append(dict(kind=kind, pos=(round(bx, 3), round(by, 3)), px=(cx, cy)))
    order = {'p1': 0, 'p2': 1, 'centre': 2}
    out.sort(key=lambda d: order[d['kind']])
    return out


def _ring_owner(ring):
    for kind, col in (('p1', C.PALETTE['p1_ring']), ('p2', C.PALETTE['p2_ring'])):
        if (np.abs(ring - np.array(col)).max(1) <= 24).mean() > 0.30:
            return kind
    if (ring.max(1) <= 60).mean() > 0.30:
        return 'centre'
    return None


def extract_annotations(img, frame):
    """Printed callout boxes (Bheta-Decima 6: 'BENEATH THERMOMETRIC CONDENSER')."""
    black = C.mask_exact(img, (0, 0, 0), 2)
    black = ndimage.binary_fill_holes(black)
    lab, n = ndimage.label(black)
    out = []
    for i, o in enumerate(ndimage.find_objects(lab)):
        h = o[0].stop - o[0].start
        w = o[1].stop - o[1].start
        if w < 90 or h < 30 or h > 90:
            continue
        if (lab[o] == i + 1).mean() < 0.7:
            continue
        out.append((o[1].start, o[0].start, o[1].stop, o[0].stop))
    return out


# ===========================================================================
# Volkus
# ===========================================================================

VOLKUS_STRUCTURE_LETTERS = set('ABCDEF')


def heal_chips(mask, boxes, pad=3, frac=0.30, side_frac=0.25):
    """Paint opaque overlays back into the mask they were printed on top of.

    Label chips and objective markers are opaque, so they punch a notch out of
    the terrain footprint under them. The overlay belongs to a piece if the ring
    just outside it is mostly that piece, or if the piece continues on two
    opposite sides of it (a chip printed on a piece narrower than the chip, e.g.
    Volkus light rubble).
    """
    out = mask.copy()
    H, W = mask.shape
    for (x0, y0, x1, y1) in boxes:
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(W, int(x1)), min(H, int(y1))
        if x1 <= x0 or y1 <= y0:
            continue
        ya, yb = max(0, y0 - pad), min(H, y1 + pad)
        xa, xb = max(0, x0 - pad), min(W, x1 + pad)
        box = mask[ya:yb, xa:xb]
        inner = np.zeros(box.shape, bool)
        inner[y0 - ya:y1 - ya, x0 - xa:x1 - xa] = True
        ring = box[~inner]
        left = mask[y0:y1, xa:x0]
        right = mask[y0:y1, x1:xb]
        top = mask[ya:y0, x0:x1]
        bot = mask[y1:yb, x0:x1]
        opposite = ((left.size and left.mean() >= side_frac) and
                    (right.size and right.mean() >= side_frac)) or \
                   ((top.size and top.mean() >= side_frac) and
                    (bot.size and bot.mean() >= side_frac))
        if (ring.size and ring.mean() >= frac) or opposite:
            out[max(0, y0 - 1):y1 + 1, max(0, x0 - 1):x1 + 1] = True
    return out


def marker_boxes(objectives, r=21):
    """Bounding boxes of the printed objective markers, for healing."""
    return [(int(cx - r), int(cy - r), int(cx + r), int(cy + r))
            for cx, cy in (o['px'] for o in objectives)]


# --- D-014 dashed-rectangle detection --------------------------------------
# A dashed rectangle is recognised by its GEOMETRY, never by how many dash
# segments survived. A segment count is scale-dependent: piece I (2 x 3.5") has
# a 264px perimeter and ~20 dashes, piece K (0.75 x 1.979") has 131px and ~8 --
# and the opaque label pill, which on these cards sits ON the outline rather
# than inside it, swallows two to four of them. The old `parts >= 5` gate
# therefore fired on every large rectangle and missed every small one, which
# left the small piece in `chips` to be carved out of its neighbour's green
# blob -- corrupting both.
DASH_MAX_AREA = 120        # px^2 of one printed dash
DASH_MAX_EXTENT = 18       # px, its longest side
DASH_GROUP_PX = 11         # px, the isotropic dilation that joins dashes at a corner
DASH_RUN_PX = 21           # px, and the directional one that closes gaps ALONG an edge
RECT_MIN_SIDE = 12         # px, 0.5" at the 24 px/in card scale
RECT_BAND = 4              # px, how far a dash may sit off the fitted edge
RECT_MIN_COVER = 0.35      # dash coverage of the VISIBLE perimeter, all edges
RECT_EDGE_COVER = 0.25     # ... and of each visible edge on its own
RECT_OFF_BAND = 0.10       # share of a group's dashes allowed off the perimeter
OVERLAY_PAD = 2            # px of slop around an opaque overlay box


def _boxes_mask(shape, boxes, pad=0):
    """Union of pixel boxes, grown by `pad` and clipped to `shape`."""
    m = np.zeros(shape, bool)
    H, W = shape
    for (x0, y0, x1, y1) in boxes:
        m[max(0, int(y0) - pad):min(H, int(y1) + pad),
          max(0, int(x0) - pad):min(W, int(x1) + pad)] = True
    return m


def _perimeter_band(shape, box, band=RECT_BAND):
    """Pixels within `band` of the outline of `box`."""
    x0, y0, x1, y1 = box
    H, W = shape
    outer = np.zeros(shape, bool)
    outer[max(0, y0 - band):min(H, y1 + band), max(0, x0 - band):min(W, x1 + band)] = True
    if x1 - x0 > 2 * band and y1 - y0 > 2 * band:
        outer[y0 + band:y1 - band, x0 + band:x1 - band] = False
    return outer


def _edge_windows(shape, box, band=RECT_BAND):
    """The four edges of `box` as (rows, cols, axis) slices.

    `axis` is the array axis to collapse ACROSS the stroke, so that what is
    left is one sample per pixel of edge run.
    """
    x0, y0, x1, y1 = box
    H, W = shape

    def rr(a, b):
        return slice(max(0, a), max(0, min(H, b)))

    def cc(a, b):
        return slice(max(0, a), max(0, min(W, b)))

    return [
        (rr(y0 - band, y0 + band), cc(x0, x1), 0),     # top
        (rr(y1 - band, y1 + band), cc(x0, x1), 0),     # bottom
        (rr(y0, y1), cc(x0 - band, x0 + band), 1),     # left
        (rr(y0, y1), cc(x1 - band, x1 + band), 1),     # right
    ]


def _edge_coverage(group, blocked, box, band=RECT_BAND):
    """Per edge, (dashed samples, visible samples) along its run.

    A sample hidden under an opaque overlay is dropped from BOTH counts: the
    card cannot show a dash there, so it is not evidence either way. That is
    what lets a small rectangle whose label pill covers a third of its
    perimeter still be recognised.
    """
    out = []
    for rows, cols, axis in _edge_windows(group.shape, box, band):
        d, b = group[rows, cols], blocked[rows, cols]
        if d.size == 0:
            out.append((0, 0))
            continue
        hidden = b.mean(axis) >= 0.5
        seen = ~hidden
        out.append((int((d.any(axis) & seen).sum()), int(seen.sum())))
    return out


def _accept_group(group, blocked):
    """The bounding box of `group`, if `group` is a dashed rectangle."""
    if not group.any():
        return None
    ys, xs = np.where(group)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    return box if _accept_rect(group, blocked, box) else None


def _accept_rect(group, blocked, box):
    """Is `group` a dashed rectangle with corners at `box`?

    Three properties, all scale-free: the box is big enough to be a piece,
    essentially every dash lies on its perimeter (rectangularity), and the
    dashes cover enough of the perimeter that is actually visible -- each edge
    on its own, and all four together.
    """
    x0, y0, x1, y1 = box
    if x1 - x0 < RECT_MIN_SIDE or y1 - y0 < RECT_MIN_SIDE:
        return False
    n = int(group.sum())
    if not n:
        return False
    if int((group & ~_perimeter_band(group.shape, box)).sum()) > RECT_OFF_BAND * n:
        return False
    cov = _edge_coverage(group, blocked, box)
    if any(c < RECT_EDGE_COVER * v for c, v in cov if v):
        return False
    seen = sum(v for _, v in cov)
    return bool(seen) and sum(c for c, _ in cov) >= RECT_MIN_COVER * seen


def _bridge_overlays(grow, boxes, pad=OVERLAY_PAD):
    """Let the grouping run through an opaque overlay printed on an outline.

    The label pill hides the dashes underneath it, cutting the outline into two
    arcs that the grouping dilation cannot bridge. When dashes reach the same
    pill from two or more sides they are one outline, so the pill is filled in.
    """
    H, W = grow.shape
    for (x0, y0, x1, y1) in boxes:
        ya, yb = max(0, int(y0) - pad), min(H, int(y1) + pad)
        xa, xb = max(0, int(x0) - pad), min(W, int(x1) + pad)
        if yb <= ya or xb <= xa:
            continue
        sides = sum(bool(s.size and s.any()) for s in (
            grow[ya:yb, max(0, xa - 1):xa], grow[ya:yb, xb:min(W, xb + 1)],
            grow[max(0, ya - 1):ya, xa:xb], grow[yb:min(H, yb + 1), xa:xb]))
        if sides >= 2:
            grow[ya:yb, xa:xb] = True
    return grow


def dashed_rects(img, ink, chip_boxes, occluders=()):
    """Rectangles drawn in thick white dashes.

    keys/VS2.png: white dashed lines mark a door when they cross a wall, and a
    rectangle of them marks a piece that tucks under the adjacent raised
    terrain (D-014). Dashes on a wall are excluded here (they are handled as
    doors), so what is left is those outlines. Returns their pixel bounding
    boxes.

    `chip_boxes` and `occluders` are the opaque things printed over the card --
    label pills and objective markers. They are cut from the dash evidence (a
    pill's white letter is not a dash) and the perimeter they hide is then
    discounted rather than counted as a miss.
    """
    shape = img.shape[:2]
    blocked = _boxes_mask(shape, list(chip_boxes) + list(occluders), OVERLAY_PAD)

    white = (img >= 235).all(2)
    white &= ~ndimage.binary_dilation(ink, np.ones((7, 7), bool))
    white &= ~blocked

    dash = np.zeros_like(white)
    for blob in G.component_masks(white, 4):
        ys, xs = np.where(blob)
        if (blob.sum() <= DASH_MAX_AREA and
                max(ys.max() - ys.min(), xs.max() - xs.min()) <= DASH_MAX_EXTENT):
            dash |= blob
    if not dash.any():
        return []

    # Group dashes into outlines two ways. `tight` is the isotropic dilation,
    # which joins the two strokes meeting at a corner. `loose` adds directional
    # dilations that close the gaps ALONG an edge -- that is where the printed
    # rhythm varies, and closing it there cannot pull in a piece lying
    # alongside. Both then run through the overlay bridge, because a label pill
    # printed on the outline cuts it into two arcs neither dilation can join.
    overlays = list(chip_boxes) + list(occluders)
    tight = ndimage.binary_dilation(dash, np.ones((DASH_GROUP_PX, DASH_GROUP_PX), bool))
    loose = (tight | ndimage.binary_dilation(dash, np.ones((1, DASH_RUN_PX), bool))
             | ndimage.binary_dilation(dash, np.ones((DASH_RUN_PX, 1), bool)))
    tight = _bridge_overlays(tight, overlays)
    loose = _bridge_overlays(loose, overlays)

    out = []
    lab, _n = ndimage.label(loose)
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        # The cell's box is the DILATED extent, so anything smaller than a
        # piece cannot contain one -- skip it before touching the image.
        if sl is None or (sl[1].stop - sl[1].start < RECT_MIN_SIDE
                          or sl[0].stop - sl[0].start < RECT_MIN_SIDE):
            continue
        cell = lab == i
        box = _accept_group(cell & dash, blocked)
        if box is not None:
            out.append(box)
            continue
        # The wider grouping can swallow two pieces printed less than
        # DASH_RUN_PX apart; fall back to the tight grouping inside this cell
        # rather than losing both.
        sub, ks = ndimage.label(tight & cell)
        for j in range(1, ks + 1):
            box = _accept_group((sub == j) & dash, blocked)
            if box is not None:
                out.append(box)
    return out


def cut_rect_outline(mask, box, t=2):
    """Erase a 2px rectangle outline so a piece drawn on an upper level is no
    longer connected to that level's footprint."""
    x0, y0, x1, y1 = box
    out = mask.copy()
    out[y0:y1, x0:x0 + t] = False
    out[y0:y1, x1 - t:x1] = False
    out[y0:y0 + t, x0:x1] = False
    out[y1 - t:y1, x0:x1] = False
    return out


def volkus_features(img, frame, objectives):
    x0, y0, x1, y1 = frame.qa['board_px']
    interior = np.zeros(img.shape[:2], bool)
    interior[y0:y1, x0:x1] = True

    chip_list = L.chips(img, 'open')
    chip_boxes = [b for _, _, _, b in chip_list]

    green = C.mask_any(img, C.GREEN_MID, tol=4) & interior
    dgreen = C.mask_any(img, C.GREEN_DARK, tol=4) & interior
    overlays = chip_boxes + marker_boxes(objectives)
    green = heal_chips(green, overlays)
    dgreen = heal_chips(dgreen, overlays)

    # Structural ink: thick black strokes only. The centre-line dashes, the
    # drop-zone arrows and the marker rings are all thinner than a wall, so an
    # opening keeps just the walls; the result is then grown back to full width.
    ink = C.mask_exact(img, (0, 0, 0), 2) & interior
    for ob in objectives:                      # marker rings are black too
        cx, cy = ob['px']
        yy, xx = np.ogrid[:img.shape[0], :img.shape[1]]
        ink &= ~(((xx - cx) ** 2 + (yy - cy) ** 2) <= 30 ** 2)
    core = ndimage.binary_opening(ink, np.ones((5, 5), bool))
    ink = ndimage.binary_propagation(core, mask=ink)

    doors = _volkus_doors(img, ink, interior)

    chips = {t: (cx, cy) for t, cx, cy, _ in chip_list}

    # --- DECISION D-014 (owner, 2026-08-17) -------------------------------
    # A white DASHED rectangle around a piece means that piece tucks slightly
    # UNDER the adjacent raised terrain; a solid outline means it sits on top.
    # So a dashed piece is on the killzone floor (z0 = 0) and the card only
    # draws the part of it that is not hidden by the level above. The dashed
    # rectangle is therefore the piece's real footprint, and the raised level
    # it tucks under stays continuous across it (its green is NOT cut).
    under = {}
    for box in dashed_rects(img, ink, chip_boxes, marker_boxes(objectives)):
        owner = None
        for t, (cx, cy) in chips.items():
            if box[0] <= cx < box[2] and box[1] <= cy < box[3]:
                owner = t
                break
        if owner is not None:
            under[owner] = box
    for t in under:
        chips.pop(t, None)          # its footprint comes from the rectangle

    green_blobs = []
    for blob in G.component_masks(green, 40):
        inside = {t: c for t, c in chips.items()
                  if blob[int(round(c[1])), int(round(c[0]))]}
        if len(inside) > 1:
            green_blobs.extend(G.split_blob_by_chips(blob, inside).values())
        else:
            green_blobs.append(blob)
    dgreen_blobs = list(G.component_masks(dgreen, 40))
    ink_blobs = list(G.component_masks(ink, 60))

    # Assign each primitive to a letter.
    owner_of_green = [_nearest_chip(b, chips) for b in green_blobs]
    owner_of_dgreen = [_nearest_chip(b, chips) for b in dgreen_blobs]
    struct_chips = {k: v for k, v in chips.items() if k in VOLKUS_STRUCTURE_LETTERS}
    owner_of_ink = [_nearest_chip(b, struct_chips) for b in ink_blobs]

    feats = defaultdict(lambda: dict(green=[], darkgreen=[], ink=[], door=[]))
    for b, o in zip(green_blobs, owner_of_green):
        if o:
            feats[o]['green'].append(b)
    for b, o in zip(dgreen_blobs, owner_of_dgreen):
        if o:
            feats[o]['darkgreen'].append(b)
    for b, o in zip(ink_blobs, owner_of_ink):
        if o:
            feats[o]['ink'].append(b)
    for d in doors:
        o = _nearest_chip(d, struct_chips)
        if o:
            feats[o]['door'].append(d)

    out = []
    for label in sorted(feats):
        kind = T.LABEL_TO_KIND.get(('volkus', label))
        if kind is None:
            continue
        parts = []
        spec = T.PIECES[kind]
        for pspec in spec['parts']:
            src = pspec['from_']
            if src == 'ink':
                for blob in feats[label]['ink']:
                    for r in G.rect_decompose(blob, min_px=20):
                        parts.append((pspec, G.px_rect_to_board(frame, *r)))
            elif src == 'door':
                for d in feats[label]['door']:
                    ys, xs = np.where(d)
                    parts.append((pspec, G.px_rect_to_board(
                        frame, xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)))
            elif src in ('green', 'darkgreen'):
                for blob in feats[label][src]:
                    for poly, area, _ in G.blob_polys(blob, frame):
                        parts.append((pspec, poly))
        if not parts:
            continue
        out.append(dict(label=label, kind=kind, parts=parts))

    for label, box in sorted(under.items()):
        kind = T.LABEL_TO_KIND.get(('volkus', label))
        if kind is None:
            continue
        pspec = dict(T.PIECES[kind]['parts'][0])
        pspec['z0'] = 0.0           # D-014: dashed => on the killzone floor
        pspec['underRaisedLevel'] = True
        poly = G.px_rect_to_board(frame, *box)
        out.append(dict(label=label, kind=kind, parts=[(pspec, poly)]))
    return out


def _volkus_doors(img, ink, interior):
    """White dashed segments printed across a wall mark a door (keys/VS2.png)."""
    white = (img >= 235).all(2) & interior
    near_ink = ndimage.binary_dilation(ink, np.ones((7, 7), bool))
    cand = white & near_ink
    cand = ndimage.binary_closing(cand, np.ones((9, 9), bool))
    out = []
    for blob in G.component_masks(cand, 25):
        ys, xs = np.where(blob)
        h, w = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
        if max(h, w) < 12 or min(h, w) > 14:
            continue
        out.append(blob)
    return out


def _nearest_chip(blob, chips, max_px=1e9):
    if not chips:
        return None
    ys, xs = np.where(blob)
    pts = np.stack([xs, ys], 1).astype(float)
    best, bd = None, max_px
    for t, (cx, cy) in chips.items():
        d = np.min((pts[:, 0] - cx) ** 2 + (pts[:, 1] - cy) ** 2) ** 0.5
        if d < bd:
            best, bd = t, d
    return best


# ===========================================================================
# Bheta-Decima
# ===========================================================================

def bheta_features(img, frame, objectives):
    x0, y0, x1, y1 = frame.qa['board_px']
    interior = np.zeros(img.shape[:2], bool)
    interior[y0:y1, x0:x1] = True
    chip_list = L.chips(img, 'open')
    green = C.mask_any(img, C.GREEN_MID, tol=5) & interior
    # the label chips sit on the decks and punch notches out of them
    green = heal_chips(green, [b for _, _, _, b in chip_list] + marker_boxes(objectives))
    # every gantry deck and the condenser are printed with their own outline in
    # the chip colour; cutting along it separates decks drawn edge to edge
    outline = C.mask_exact(img, C.PALETTE['label_open'], 6) & interior
    for (bx0, by0, bx1, by1) in [b for _, _, _, b in chip_list]:
        outline[max(0, by0 - 2):by1 + 2, max(0, bx0 - 2):bx1 + 2] = False
    touching = green.copy()
    green &= ~ndimage.binary_dilation(outline, np.ones((3, 3), bool))

    chips = {}
    for idx, (t, cx, cy, _) in enumerate(chip_list):
        chips['%s#%d' % (t, idx)] = (cx, cy)

    # adjacency groups: pieces that were one blob before the outline cut are
    # gantries drawn deck-to-deck, i.e. "treated as the same terrain"
    tlab, _ = ndimage.label(touching)

    pieces, orphans = [], []
    for blob in G.component_masks(green, 120):
        inside = {k: c for k, c in chips.items()
                  if blob[int(round(c[1])), int(round(c[0]))]}
        if not inside:
            orphans.append(blob)
            continue
        grp = int(np.bincount(tlab[blob]).argmax())
        if len(inside) > 1:
            for k, sub in G.split_blob_by_chips(blob, inside).items():
                pieces.append(dict(key=k, mask=sub, group=grp))
        else:
            pieces.append(dict(key=next(iter(inside)), mask=blob, group=grp))

    out = []
    for pc in pieces:
        label = pc['key'].split('#')[0]
        kind = T.LABEL_TO_KIND.get(('bheta-decima', label))
        if kind is None:
            continue
        polys = G.blob_polys(pc['mask'], frame)
        if not polys:
            continue
        poly = polys[0][0]
        spec = T.PIECES[kind]
        parts = []
        for pspec in spec['parts']:
            if pspec['from_'] == 'green':
                parts.append((pspec, poly))
            elif pspec['from_'] == 'green_inner':
                inner = _inner_blob(pc['mask'], orphans)
                if inner is not None:
                    ip = G.blob_polys(inner, frame)
                    if ip:
                        parts.append((pspec, ip[0][0]))
        out.append(dict(label=label, kind=kind, parts=parts, groupKey=pc['group']))
    shared = {g for g in [p['groupKey'] for p in out]
              if [p['groupKey'] for p in out].count(g) > 1}
    for p in out:
        p['shared'] = p['groupKey'] in shared
    return out


def _inner_blob(outer, orphans):
    """A chipless blob wholly inside another one is that piece's inner detail
    (the thermometric condenser's inner ledge)."""
    ys, xs = np.where(outer)
    bb = (xs.min(), ys.min(), xs.max(), ys.max())
    for o in orphans:
        oy, ox = np.where(o)
        if bb[0] <= ox.min() and ox.max() <= bb[2] and bb[1] <= oy.min() and oy.max() <= bb[3]:
            return o
    return None


def bheta_hazard(img, frame):
    x0, y0, x1, y1 = frame.qa['board_px']
    interior = np.zeros(img.shape[:2], bool)
    interior[y0:y1, x0:x1] = True
    haz = C.mask_any(img, [C.PALETTE['hazard'], C.PALETTE['hazard_grid']], tol=3) & interior
    # the gantries and their chips are drawn on top of the ocean
    haz = L._fill_small_holes(haz, 20000)
    out = []
    for poly, area, _ in C.trace(haz, frame, close_in=0.12, min_area=1.0, dp_in=0.08):
        out.append([frame.to_board(p[0], p[1]) for p in poly])
    return out


# ===========================================================================
# Gallowdark / Tomb World
# ===========================================================================

def cq_features(img, frame, killzone):
    """Walls snapped to the 7x6 lattice, plus pads and light terrain."""
    wall = C.mask_exact(img, C.PALETTE['wall_cq'], 6)
    lx, ly = frame.lattice_x, frame.lattice_y
    step_px = (lx[1] - lx[0])

    occupied_h = {}      # (i, j) -> horizontal edge from node (i,j) to (i+1,j)
    occupied_v = {}
    for j in range(len(ly)):
        for i in range(len(lx) - 1):
            occupied_h[(i, j)] = _edge_covered(wall, lx[i], ly[j], lx[i + 1], ly[j])
    for i in range(len(lx)):
        for j in range(len(ly) - 1):
            occupied_v[(i, j)] = _edge_covered(wall, lx[i], ly[j], lx[i], ly[j + 1])

    # Access points (hatchway / breach point) — the dark pill printed beside a wall.
    access = []
    pill = C.mask_exact(img, C.PALETTE['hatch_cq'], 8)
    for blob in G.component_masks(pill, 60):
        ys, xs = np.where(blob)
        access.append(dict(cx=(xs.min() + xs.max() + 1) / 2, cy=(ys.min() + ys.max() + 1) / 2,
                           x0=xs.min(), y0=ys.min(), x1=xs.max() + 1, y1=ys.max() + 1,
                           horiz=xs.max() - xs.min() > ys.max() - ys.min()))

    chips = [(t, cx, cy) for t, cx, cy, _ in L.chips(img, 'cq')]
    blackchips = [(t, cx, cy, b) for t, cx, cy, b in L.chips(img, 'black', **L.BLACK_CHIP)]

    runs = _cq_runs(occupied_h, occupied_v)
    feats = _assign_labels(runs, chips, lx, ly)
    walls = []
    thick = _wall_thickness(wall, lx, ly, occupied_h, occupied_v)
    for f in feats:
        walls.append(_cq_wall_feature(f, frame, lx, ly, thick, access, killzone))

    extras = []
    for t, cx, cy, box in blackchips:
        kind = T.LABEL_TO_KIND.get((killzone, t))
        if kind is None:
            continue
        extras.append(dict(label=t, kind=kind, box=box, centre=(cx, cy)))
    return walls, extras, dict(step_px=step_px, wall_px=thick)


def _edge_covered(wall, xa, ya, xb, yb, samples=17, frac=0.8):
    hits = 0
    for t in np.linspace(0.12, 0.88, samples):
        x = int(round(xa + (xb - xa) * t))
        y = int(round(ya + (yb - ya) * t))
        if wall[max(0, min(wall.shape[0] - 1, y)), max(0, min(wall.shape[1] - 1, x))]:
            hits += 1
    return hits / samples >= frac


def _cq_runs(oh, ov):
    """Maximal straight runs of occupied lattice edges."""
    runs = []
    js = sorted({j for (_, j) in oh})
    for j in js:
        i = 0
        cols = sorted({i for (i, jj) in oh if jj == j})
        while i < len(cols):
            if oh.get((cols[i], j)):
                k = i
                while k + 1 < len(cols) and oh.get((cols[k + 1], j)) and cols[k + 1] == cols[k] + 1:
                    k += 1
                runs.append(('h', cols[i], j, cols[k] - cols[i] + 1))
                i = k + 1
            else:
                i += 1
    iss = sorted({i for (i, _) in ov})
    for i in iss:
        rows = sorted({j for (ii, j) in ov if ii == i})
        k = 0
        while k < len(rows):
            if ov.get((i, rows[k])):
                m = k
                while m + 1 < len(rows) and ov.get((i, rows[m + 1])) and rows[m + 1] == rows[m] + 1:
                    m += 1
                runs.append(('v', i, rows[k], rows[m] - rows[k] + 1))
                k = m + 1
            else:
                k += 1
    return runs


def _assign_labels(runs, chips, lx, ly):
    """Attach each printed wall label to the run it sits beside, then tile each
    run with the labelled pieces (A* spans two lattice squares, B* one).

    A chip near a T-junction is close to two runs; it is given to the run whose
    centreline it is nearer to, and only if it lies strictly *along* that run —
    which is what separates e.g. an "A3" printed above a horizontal wall from
    the vertical wall that starts underneath it.
    """
    stepx, stepy = lx[1] - lx[0], ly[1] - ly[0]
    max_perp = 0.55 * stepx
    best = {}
    for ci, (t, cx, cy) in enumerate(chips):
        pick = None
        for ri, (orient, i, j, length) in enumerate(runs):
            if orient == 'h':
                pos = (cx - lx[i]) / stepx
                perp = abs(cy - ly[j])
            else:
                pos = (cy - ly[j]) / stepy
                perp = abs(cx - lx[i])
            if not (0.05 <= pos <= length - 0.05):
                continue
            if perp > max_perp:
                continue
            if pick is None or perp < pick[0]:
                pick = (perp, ri, pos)
        if pick is not None:
            best.setdefault(pick[1], []).append((pick[2], t))

    out = []
    for ri, (orient, i, j, length) in enumerate(runs):
        mine = sorted(best.get(ri, []))
        placed = []
        taken = [False] * length
        for pos, t in mine:
            span = 2 if t.startswith('A') else 1     # A* walls are two squares long
            if span > length:
                span = length
            # the chip is printed centred on its piece
            off = int(round(pos - span / 2.0))
            off = max(0, min(length - span, off))
            while off + span <= length and any(taken[off:off + span]):
                off += 1
            if off + span > length:
                off = 0
                while off + span <= length and any(taken[off:off + span]):
                    off += 1
            if off + span > length:
                continue                             # no room: label dropped
            for k in range(off, off + span):
                taken[k] = True
            placed.append((off, span, t))
        for k in range(length):                      # unlabelled remainder
            if not taken[k]:
                placed.append((k, 1, None))
        for off, span, t in sorted(placed):
            out.append((orient, i, j, off, span, t))
    return out


def _wall_thickness(wall, lx, ly, oh, ov):
    """Median printed wall stroke, measured perpendicular to occupied edges.

    Sampling has to avoid the lattice nodes, where the printed pillar blocks are
    two to three times wider than the wall itself.
    """
    runs = []
    for (i, j), on in oh.items():
        if not on:
            continue
        x = int(round((lx[i] + lx[i + 1]) / 2))
        y = int(round(ly[j]))
        runs.append(_run_len(wall[:, x], y))
    for (i, j), on in ov.items():
        if not on:
            continue
        y = int(round((ly[j] + ly[j + 1]) / 2))
        x = int(round(lx[i]))
        runs.append(_run_len(wall[y, :], x))
    runs = [r for r in runs if r]
    return float(np.median(runs)) if runs else 9.0


def _run_len(line, k):
    if not line[k]:
        return 0
    a = k
    while a > 0 and line[a - 1]:
        a -= 1
    b = k
    while b + 1 < len(line) and line[b + 1]:
        b += 1
    return b - a + 1


def _cq_wall_feature(seg, frame, lx, ly, thick, access, killzone):
    orient, i, j, off, span, label = seg
    half = thick / 2
    if orient == 'h':
        xa, xb = lx[i + off], lx[i + off + span]
        y = ly[j]
        px_box = (xa, y - half, xb, y + half)
        a_px, b_px = (xa, y), (xb, y)
    else:
        ya, yb = ly[j + off], ly[j + off + span]
        x = lx[i]
        px_box = (x - half, ya, x + half, yb)
        a_px, b_px = (x, ya), (x, yb)
    poly = G.px_rect_to_board(frame, *px_box)
    a = frame.to_board(*a_px)
    b = frame.to_board(*b_px)
    # The access-point pill printed alongside this wall.
    #
    # The pill is drawn BESIDE the wall with its long axis running along it. Measured across
    # all twelve Close Quarters cards, the perpendicular offset of a pill from the wall it
    # marks clusters at 18-22px (118 pairs) and the nearest unrelated pairing is at 73px — a
    # 3.5x gap. The old threshold was `thick * 2.2` = 19.8px, which cut through the middle of
    # that cluster and kept only the tightest few: 3 access points out of 10 pills on
    # gallowdark-1, and ZERO on every Tomb World card. `thick * 4` = 36px sits in the gap.
    ap = None
    for cand in access:
        if orient == 'h' and cand['horiz'] and abs(cand['cy'] - a_px[1]) < thick * 4 \
                and min(a_px[0], b_px[0]) - 4 <= cand['cx'] <= max(a_px[0], b_px[0]) + 4:
            ap = cand
        if orient == 'v' and not cand['horiz'] and abs(cand['cx'] - a_px[0]) < thick * 4 \
                and min(a_px[1], b_px[1]) - 4 <= cand['cy'] <= max(a_px[1], b_px[1]) + 4:
            ap = cand
    return dict(label=label, orient=orient, span=span, poly=poly, a=a, b=b, access=ap,
                px=px_box)


# ===========================================================================
# Template fitting
# ===========================================================================

def fit_templates(instances):
    """Pick a canonical footprint per label and fit every instance to it.

    `instances` maps label -> [ (mapId, polygon) ].  Every card draws a given
    piece with the same vector art, so the fit is a rigid 90 degrees-multiple
    rotation plus an optional mirror; the returned IoU is the QA number.
    """
    templates, fits = {}, []
    for label, items in instances.items():
        cands = [_centre(p) for _, _, p in items]
        best_idx, best_score = 0, -1
        for a in range(len(cands)):
            scores = [_best_align(cands[a], cands[b])[0] for b in range(len(cands))]
            s = float(np.median(scores))
            if s > best_score:
                best_idx, best_score = a, s
        tmpl = cands[best_idx]
        templates[label] = tmpl
        for (mapId, fi, poly), c in zip(items, cands):
            score, rot, flip = _best_align(tmpl, c)
            cx, cy = C.centroid(poly)
            fits.append(dict(label=label, mapId=mapId, featureIndex=fi, iou=round(score, 4),
                             rotDeg=rot, flip=flip, x=round(cx, 3), y=round(cy, 3)))
    return templates, fits


def _centre(poly):
    p = np.asarray(poly, float)
    cx, cy = C.centroid(p)
    return p - np.array([cx, cy])


def _best_align(tmpl, cand):
    best = (-1, 0, False)
    for rot in (0, 90, 180, 270):
        for flip in (False, True):
            t = G.transform(tmpl, rot, flip, 0, 0)
            t = t - np.array(C.centroid(t))
            v = C.iou(t, cand)
            if v > best[0]:
                best = (v, rot, flip)
    return best


# ===========================================================================
# Assembly
# ===========================================================================

def build_map(card, mapId, killzone, name):
    path = os.path.join(C.CARDS_DIR, card)
    img = C.load(path)
    cq = killzone in CQ_KILLZONES
    frame = C.calibrate(img, cq)
    zones = extract_zones(img, frame, cq)
    edges = extract_edges(img, frame)
    objs = extract_objectives(img, frame)
    annotations = extract_annotations(img, frame)

    hazardous = None
    features = []
    qa = dict(pxPerInch=round(frame.ppi_x, 4), pxPerInchY=round(frame.ppi_y, 4),
              dropDepthP1=round(zones['p1_depth'], 4), dropDepthP2=round(zones['p2_depth'], 4),
              deployment='short-edge' if zones['axis'] == 'x' else 'long-edge',
              p1Side=zones['p1_side'])
    if zones['seam'] is not None:
        qa['centreSeamErrIn'] = round(abs(zones['seam'] - zones['mid']), 4)

    if killzone == 'volkus':
        raw = volkus_features(img, frame, objs)
        features = _finish_open(raw, mapId)
    elif killzone == 'bheta-decima':
        raw = bheta_features(img, frame, objs)
        features = _finish_open(raw, mapId, group=True)
        hazardous = bheta_hazard(img, frame)
    else:
        walls, extras, wqa = cq_features(img, frame, killzone)
        features = _finish_cq(walls, extras, mapId, killzone, frame)
        qa['latticeStepPx'] = round(wqa['step_px'], 3)
        qa['wallThicknessPx'] = round(wqa['wall_px'], 2)

    objectives = _finish_objectives(objs, features, annotations, killzone)

    out = dict(
        id=mapId, killzone=killzone, name=name,
        board=dict(w=round(frame.board_w, 5), h=round(frame.board_h, 5),
                   grid=(C.CQ_SQUARE if cq else 1)),
        closeQuarters=cq,
        dropZones={k: [G.round_poly(p) for p in v] for k, v in zones['dropZones'].items()},
        territories={k: [G.round_poly(p) for p in v] for k, v in zones['territories'].items()},
        killzoneEdges={k: [{'a': _pt(s['a']), 'b': _pt(s['b'])} for s in v]
                       for k, v in edges.items()},
        centreLine={'a': _pt(zones['centreLine']['a']), 'b': _pt(zones['centreLine']['b'])},
        flankLine={'a': _pt(zones['flankLine']['a']), 'b': _pt(zones['flankLine']['b'])},
        objectives=objectives,
        features=features,
        source=dict(card='docs/context-pack/research/approved-ops/maps/' + card,
                    pxPerInch=round(frame.ppi_x, 4),
                    extractedAt=datetime.now(timezone.utc).strftime('%Y-%m-%d'),
                    tool=TOOL, qa=qa),
    )
    if cq:
        out['board']['border'] = C.CQ_BORDER_X
    if hazardous is not None:
        out['hazardous'] = [G.round_poly(p) for p in hazardous]
    return out, frame


def _pt(p):
    return {'x': round(float(p[0]), 3), 'y': round(float(p[1]), 3)}


def _finish_open(raw, mapId, group=False):
    feats = []
    groups = {}
    for idx, f in enumerate(raw):
        fid = '%s.%s' % (mapId, f['label'])
        parts = []
        for k, (pspec, poly) in enumerate(f['parts']):
            p = dict(id='%s.p%d' % (fid, k), featureId=fid, poly=G.round_poly(poly),
                     z0=pspec['z0'], z1=pspec['z1'], types=list(pspec['types']))
            for opt in ('role', 'blocksVisibility', 'standable', 'solid', 'state',
                        'treatAsZ', 'maxOperatives', 'underRaisedLevel'):
                if opt in pspec:
                    p[opt] = pspec[opt]
            parts.append(p)
        allpts = np.vstack([np.asarray(poly, float) for _, poly in f['parts']])
        cx, cy = float(allpts[:, 0].mean()), float(allpts[:, 1].mean())
        feat = dict(id=fid, kind=f['kind'], label=f['label'], parts=parts,
                    placement=dict(x=round(cx, 3), y=round(cy, 3), rotDeg=0, flip=False))
        if group and f.get('shared'):
            feat['groupId'] = '%s.g%s' % (mapId, f['groupKey'])
        feats.append(feat)
    # deduplicate ids when a letter appears twice on one card (Bheta gantries)
    seen = defaultdict(int)
    for f in feats:
        seen[f['id']] += 1
        if seen[f['id']] > 1:
            suffix = seen[f['id']]
            old = f['id']
            f['id'] = '%s%d' % (old, suffix)
            for p in f['parts']:
                p['featureId'] = f['id']
                p['id'] = p['id'].replace(old + '.', f['id'] + '.')
    return feats


def _finish_cq(walls, extras, mapId, killzone, frame):
    feats = []
    counters = defaultdict(int)
    for w in walls:
        label = w['label'] or ('A?' if w['span'] == 2 else 'B?')
        kind = T.LABEL_TO_KIND.get((killzone, label), '%s.wallUnknown' % killzone)
        counters[label] += 1
        fid = '%s.%s-%d' % (mapId, label, counters[label])
        spec = T.PIECES.get(kind, {})
        x0, y0, x1, y1 = w['px']
        wall_boxes = [(x0, y0, x1, y1)]
        access_box = None
        if w['access'] is not None and (spec.get('hatch') or spec.get('breach')):
            # The access point is a NOTCH IN THE WALL, not a marker beside it: it takes the
            # wall's own thickness, and the pill's long extent gives the width of the opening.
            # It used to be a square centred on the pill — which is drawn alongside the wall,
            # not in it — so the wall ran unbroken behind it and opening a hatchway changed
            # nothing: `wallRouteDistance` across one was Infinity open or closed.
            ap = w['access']
            if w['orient'] == 'h':
                ax0, ax1 = ap['x0'], ap['x1']
                ax0, ax1 = max(ax0, x0), min(ax1, x1)
                access_box = (ax0, y0, ax1, y1)
                wall_boxes = [b for b in ((x0, y0, ax0, y1), (ax1, y0, x1, y1)) if b[2] - b[0] > 1]
            else:
                ay0, ay1 = ap['y0'], ap['y1']
                ay0, ay1 = max(ay0, y0), min(ay1, y1)
                access_box = (x0, ay0, x1, ay1)
                wall_boxes = [b for b in ((x0, y0, x1, ay0), (x0, ay1, x1, y1)) if b[3] - b[1] > 1]

        parts = []
        for n, box in enumerate(wall_boxes):
            suffix = '.wall' if len(wall_boxes) == 1 else '.wall%d' % n
            parts.append(dict(id=fid + suffix, featureId=fid,
                              poly=G.round_poly(G.px_rect_to_board(frame, *box)),
                              z0=0.0, z1=T.h('cq.wall.top'), types=list(T.CQ_WALL_TYPES),
                              role='wall', blocksVisibility=True, solid=True, standable=False))
        if access_box is not None:
            role = 'hatch' if spec.get('hatch') else 'breachWall'
            parts.append(dict(id=fid + '.access', featureId=fid,
                              poly=G.round_poly(G.px_rect_to_board(frame, *access_box)),
                              z0=0.0, z1=T.h('cq.wall.top'),
                              types=list(T.CQ_ACCESS_CLOSED), role='accessPoint',
                              state='closed', blocksVisibility=True, solid=True,
                              standable=False,
                              openTypes=list(T.CQ_ACCESS_OPEN), opensAs=role))
        a, b = w['a'], w['b']
        feats.append(dict(id=fid, kind=kind, label=label, parts=parts,
                          placement=dict(x=round((a[0] + b[0]) / 2, 3),
                                         y=round((a[1] + b[1]) / 2, 3),
                                         rotDeg=0 if w['orient'] == 'h' else 90,
                                         flip=False)))
    for e in extras:
        counters[e['label']] += 1
        fid = '%s.%s' % (mapId, e['label'])
        x0, y0, x1, y1 = e['box']
        poly = G.px_rect_to_board(frame, x0, y0, x1, y1)
        if e['label'] == 'T':
            fid = '%s.T-%d' % (mapId, counters['T'])
            part = dict(id=fid + '.pad', featureId=fid, poly=G.round_poly(poly), z0=0.0,
                        z1=T.h('cq.teleportPad.top'), types=list(T.CQ_PAD_TYPES),
                        role='teleportPad', blocksVisibility=False, standable=True, solid=False)
        else:
            part = dict(id=fid + '.light', featureId=fid, poly=G.round_poly(poly), z0=0.0,
                        z1=T.h('cq.light.top'), types=list(T.CQ_LIGHT_TYPES),
                        role='rubble', blocksVisibility=False, standable=False, solid=True)
        cx, cy = frame.to_board((x0 + x1) / 2, (y0 + y1) / 2)
        feats.append(dict(id=fid, kind=e['kind'], label=e['label'], parts=[part],
                          placement=dict(x=round(cx, 3), y=round(cy, 3), rotDeg=0, flip=False)))
    return feats


def _finish_objectives(objs, features, annotations, killzone):
    """Objective markers, bound to the feature they stand on.

    Appendix > GAME SEQUENCE: "Other than in Killzone: Bheta-Decima, all objective
    markers must be set up on the killzone floor." So outside Bheta-Decima a
    marker printed inside a stronghold or large ruin is on that structure's
    GROUND floor, underneath its Ceiling/Vantage upper level — `onFeatureId` is
    still recorded, but z stays 0. Only Bheta-Decima lifts a marker onto the
    thermometric condenser's roof, and even there map 6's marker is annotated
    "BENEATH THERMOMETRIC CONDENSER" and stays on the floor.
    """
    # DECISION D-013 (owner, 2026-08-17): floor-only everywhere but Bheta-Decima,
    # with no per-map exceptions.
    lift = killzone == 'bheta-decima'
    out = []
    for ob in objs:
        x, y = ob['pos']
        z, on = 0.0, None
        for f in features:
            for p in f['parts']:
                if not p.get('standable'):
                    continue
                if _inside([[q['x'], q['y']] for q in p['poly']], x, y):
                    if p['z0'] >= z:
                        z, on = p['z0'], f['id']
        note = None
        for (ax0, ay0, ax1, ay1) in annotations:
            cx, cy = ob['px']
            if abs((ax0 + ax1) / 2 - cx) < 200 and abs((ay0 + ay1) / 2 - cy) < 200:
                note = 'BENEATH THERMOMETRIC CONDENSER'
        if note is not None or not lift:
            z = 0.0
        d = dict(id='obj.%s' % ob['kind'], kind=ob['kind'],
                 pos={'x': x, 'y': y}, z=round(z, 3))
        if on:
            d['onFeatureId'] = on
        if note:
            d['note'] = note
        out.append(d)
    return out


def _inside(poly, x, y):
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ===========================================================================
# main
# ===========================================================================

def main(argv):
    want = set(argv[1:])
    maps = {}
    for card, mapId, killzone, name in CARDS:
        if want and mapId not in want:
            continue
        m, frame = build_map(card, mapId, killzone, name)
        maps[mapId] = m
        path = os.path.join(OUT_MAPS, killzone, '%s.json' % mapId)
        C.dump_json(path, m)
        print('%-16s %2d features  %d objectives  %s' %
              (mapId, len(m['features']), len(m['objectives']), m['source']['qa']['deployment']))

    # Template fit QA across each killzone.
    by_kz = defaultdict(lambda: defaultdict(list))
    for mid, m in maps.items():
        for fi, f in enumerate(m['features']):
            poly = _footprint(f)
            if poly is not None and f.get('label'):
                by_kz[m['killzone']][f['label']].append((mid, fi, poly))
    qa_fits = {}
    for kz, inst in by_kz.items():
        templates, fits = fit_templates(inst)
        qa_fits[kz] = fits
        for f in fits:
            feat = maps[f['mapId']]['features'][f['featureIndex']]
            feat['placement']['rotDeg'] = f['rotDeg']
            feat['placement']['flip'] = bool(f['flip'])
            feat.setdefault('qa', {})['templateIoU'] = f['iou']
        write_terrain(kz, templates)
    # Doors are read off the card as a white dashed segment across the wall, which in practice
    # only ever resolves on Stronghold B. Recover the rest from the hole they leave in the wall
    # ring, now that `placement.rotDeg` / `flip` are known. See tools/maps/doors.py.
    fill_volkus_doors(maps)
    # ...and only once the doors exist, because a door is part of the ring and is capped with
    # the wall band it sits in.
    cap_stronghold_walls(maps)

    for mid, m in maps.items():
        ious = [f['qa']['templateIoU'] for f in m['features'] if 'qa' in f]
        if ious:
            m['source']['qa']['templateIoUMin'] = round(min(ious), 4)
            m['source']['qa']['templateIoUMedian'] = round(float(np.median(ious)), 4)
        C.dump_json(os.path.join(OUT_MAPS, m['killzone'], '%s.json' % mid), m)
    C.dump_json(os.path.join(ROOT, 'docs', 'maps', 'fit-report.json'), qa_fits)
    print('wrote %d maps' % len(maps))


def cap_stronghold_walls(maps):
    """Stop a stronghold's wall ring 1" above the level it encloses, not at the piece maximum.

    Killzones §Vantage is the rule this serves: an operative on Vantage terrain is meant to see
    out. The traced ink ring carries no height of its own, so every wall part was extruded to
    the PIECE's maximum height — 5.906" for Stronghold A, 7.48" for Stronghold B — while the
    Vantage floors those rings enclose sit at 3.0" and 6.0". The edge of every upper level was
    therefore a 2.9"/4.5" opaque Heavy parapet, and climbing the two biggest features on all six
    maps was a pure downside. Measured on the shipped data, the best spot on volkus-1 Stronghold
    A's roof saw 31 of 568 killzone-floor positions (5%).

    A wall band rises `volkus.stronghold.parapet` above the highest floor of its own feature
    that it BORDERS. Bordering matters: Stronghold B's ring encloses a small second level in one
    corner, and capping the WHOLE ring at that level's parapet leaves its big lower level in a
    4" well exactly as before (measured: 17% -> 17%). Per-band it reaches 36-56% on every one of
    the eighteen stronghold levels across the six maps.

    The `*.top` heights stay in the catalogue: they are the promethium tank and the tower, which
    the cards do not draw and the extraction therefore never emits.
    """
    pad = 0.35  # a traced wall is ~0.21" thick; this reaches the floor it stands against
    parapet = T.h('volkus.stronghold.parapet')
    for m in maps.values():
        if m['killzone'] != 'volkus':
            continue
        for feat in m['features']:
            if not feat['kind'].startswith('volkus.stronghold'):
                continue
            floors = [p for p in feat['parts'] if p.get('role') == 'floor']
            if not floors:
                continue
            base = min(p['z1'] for p in floors) + parapet
            rebuilt = []
            for part in feat['parts']:
                if part.get('role') == 'wall':
                    rebuilt.extend(_split_wall_band(part, floors, base, parapet, pad,
                                                    ramparts=feat['kind'] == 'volkus.strongholdA'))
                elif part.get('role') == 'door':
                    # A door is one physical object and is never split; it takes the band of
                    # the run it sits in, decided at its own midpoint.
                    part['z1'] = round(_band_at(_rect_centre(part['poly']), floors, base, parapet, pad), 3)
                    rebuilt.append(part)
                else:
                    rebuilt.append(part)
            feat['parts'] = rebuilt
            for i, p in enumerate(feat['parts']):
                p['id'] = '%s.p%d' % (feat['id'], i)


def _boxes_touch(a, b, pad):
    return (a[0] - pad <= b[2] and a[2] + pad >= b[0]
            and a[1] - pad <= b[3] and a[3] + pad >= b[1])


def _rect_centre(poly):
    """Centre of a board-space polygon given as [{x, y}, ...]."""
    b = DOORS._bbox(poly)
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _band_at(pt, floors, base, parapet, pad):
    """The parapet band at a point: 1" above the highest floor whose footprint reaches it."""
    zs = [f['z1'] for f in floors
          if _boxes_touch(DOORS._bbox(f['poly']), (pt[0], pt[1], pt[0], pt[1]), pad)]
    return (max(zs) + parapet) if zs else base


def _split_wall_band(part, floors, base, parapet, pad, ramparts=False):
    """One wall bar, cut into the parapet bands its length passes through.

    Bounding boxes alone are not enough. Stronghold B's second level is a small square in one
    corner of the ring, and the ring's east bar runs the whole side of the building — its bbox
    overlaps that square, so capping the WHOLE bar at the upper parapet leaves the big lower
    level in a 4" well exactly as before (measured on volkus-1: 17% -> 19% of the killzone
    floor visible). Cutting the bar where the upper floor's extent ends gives the corner its
    parapet and the rest of the side its own: 19% -> 45%.
    """
    b = DOORS._bbox(part['poly'])
    axis = 0 if (b[2] - b[0]) >= (b[3] - b[1]) else 1
    lo, hi = b[axis], b[axis + 2]
    # Intervals of this bar's length that a HIGHER floor stands against.
    raised = []
    for f in floors:
        z = f['z1'] + parapet
        if z <= base + 1e-6:
            continue
        fb = DOORS._bbox(f['poly'])
        if not _boxes_touch(fb, b, pad):
            continue
        a0, a1 = max(lo, fb[axis] - pad), min(hi, fb[axis + 2] + pad)
        if a1 - a0 > 0.05:
            raised.append((a0, a1, z))
    raised.sort()
    out, cursor = [], lo
    for a0, a1, z in raised:
        if a0 - cursor > 0.05:
            out.append((cursor, a0, base))
        if a1 > cursor:
            out.append((max(cursor, a0), a1, z))
            cursor = a1
    if hi - cursor > 0.05 or not out:
        out.append((cursor, hi, base))
    pieces = []
    for a0, a1, z in out:
        rect = list(b)
        rect[axis], rect[axis + 2] = a0, a1
        poly = DOORS.rect_poly(rect)
        if not ramparts:
            pieces.append({**part, 'poly': poly, 'z1': round(z, 3)})
            continue
        # Killzones §Stronghold F: "The small broken ramparts on the edge of the Vantage
        # terrain of Stronghold A are Insignificant and Exposed terrain." So on Stronghold A
        # the Heavy wall stops at the level it holds up, and the last inch is a rampart, which
        # `defaultBlocksVisibility` correctly treats as too small and open to obstruct a line.
        # Stronghold B gets no such clause — §Stronghold ends "All other parts of it are Heavy
        # terrain" — so its parapet stays Heavy and its lower level stays partly enclosed.
        pieces.append({**part, 'poly': poly, 'z1': round(z - parapet, 3)})
        pieces.append({**part, 'poly': poly, 'role': 'rampart',
                       'types': ['Insignificant', 'Exposed'],
                       'z0': round(z - parapet, 3), 'z1': round(z, 3),
                       'blocksVisibility': False, 'solid': False, 'standable': False})
    return pieces or [part]


def fill_volkus_doors(maps):
    """Add the `door` part to every Volkus feature whose doorway was left as a bare hole.

    Calibration is across every instance in this run, so a partial re-extraction of one map
    has less to go on than a full one; `tools/maps/derive_doors.py --check` is the gate that
    catches anything left unresolved.
    """
    instances = []
    for m in maps.values():
        if m['killzone'] != 'volkus':
            continue
        for feat in m['features']:
            if feat['kind'] not in DOORS.DOOR_KINDS:
                continue
            if any(p.get('role') == 'door' for p in feat['parts']):
                continue
            walls = [p['poly'] for p in feat['parts'] if p.get('role') == 'wall']
            if walls:
                instances.append(dict(id=feat['id'], kind=feat['kind'],
                                      placement=feat['placement'], walls=walls, feature=feat))
    if not instances:
        return
    resolved, _how = DOORS.derive_doors(instances)
    for inst in instances:
        box = resolved.get(inst['id'])
        if box is None:
            continue
        # A wall bar traced across the opening plugs the door; cut the doorway back out of it.
        feat_walls = [p for p in inst['feature']['parts'] if p.get('role') == 'wall']
        overlap = DOORS.clip_walls_out_of_doorway(box, [p['poly'] for p in feat_walls])
        if overlap:
            rebuilt = []
            for p in inst['feature']['parts']:
                pieces = overlap.get(feat_walls.index(p)) if p in feat_walls else None
                if pieces is None:
                    rebuilt.append(p)
                    continue
                rebuilt.extend(dict(p, poly=DOORS.rect_poly(r)) for r in pieces)
            inst['feature']['parts'] = rebuilt
        spec = next((p for p in T.PIECES[inst['kind']]['parts'] if p.get('role') == 'door'), None)
        if spec is None:
            continue
        feat = inst['feature']
        walls = [p for p in feat['parts'] if p.get('role') == 'wall']
        feat['parts'].insert(len(walls), dict(
            id='', featureId=feat['id'], poly=DOORS.rect_poly(box),
            z0=float(spec['z0']), z1=float(spec['z1']), types=list(spec['types']),
            role='door', blocksVisibility=bool(spec.get('blocksVisibility', True)),
            standable=bool(spec.get('standable', False)), solid=bool(spec.get('solid', False))))
        for i, p in enumerate(feat['parts']):
            p['id'] = '%s.p%d' % (feat['id'], i)


FOOTPRINT_ROLES = ('floor', 'rubble', 'crate', 'teleportPad', 'ledge')


def _footprint(feat):
    """The polygon used for template matching.

    Structural ink is decomposed into individual wall bars, so the largest part
    of a stronghold is one wall, not the building. Prefer the piece's own
    footprint (its upper level / rubble outline) and fall back to the largest
    wall bar for pieces that are nothing but wall (small ruins, CQ walls).
    """
    best = None
    for p in feat['parts']:
        poly = [[q['x'], q['y']] for q in p['poly']]
        a = C.poly_area(poly)
        pref = 1 if p.get('role') in FOOTPRINT_ROLES else 0
        key = (pref, a)
        if best is None or key > best[0]:
            best = (key, poly)
    if best is not None and best[0][0] == 0:
        # A piece that is nothing but wall — every Close Quarters wall — is matched on the
        # extent of the WHOLE run, not its largest bar. An access point notches the run into
        # two bars, and which of them is larger is an accident of where the hatchway sits, so
        # fitting on one of them made the same physical piece look like a different one.
        bars = [p for p in feat['parts'] if p.get('role') in ('wall', 'accessPoint')]
        if bars:
            xs = [q['x'] for p in bars for q in p['poly']]
            ys = [q['y'] for p in bars for q in p['poly']]
            return [[min(xs), min(ys)], [max(xs), min(ys)], [max(xs), max(ys)], [min(xs), max(ys)]]
    return best[1] if best else None


def write_terrain(killzone, templates):
    """data/terrain/<killzone>.json — local-space footprints + typed parts."""
    pieces = {k: v for k, v in T.PIECES.items() if v['killzone'] == killzone}
    out = dict(killzone=killzone, generatedBy=TOOL,
               generatedAt=datetime.now(timezone.utc).strftime('%Y-%m-%d'),
               heights={k: dict(inches=v[0], confidence=v[1], provenance=v[2])
                        for k, v in T.HEIGHTS.items() if k.split('.')[0] in
                        {'volkus': ['volkus'], 'bheta-decima': ['bheta'],
                         'gallowdark': ['cq'], 'tomb-world': ['cq']}[killzone]},
               pieces=[])
    for kind, spec in pieces.items():
        entry = dict(kind=kind, name=spec['name'], labels=spec['labels'],
                     inventoryCount=spec['count'])
        if spec.get('notes'):
            entry['notes'] = spec['notes']
        if 'span' in spec:
            entry['spanSquares'] = spec['span']
            entry['lengthIn'] = round(spec['span'] * C.CQ_SQUARE, 5)
            entry['hasHatchway'] = bool(spec.get('hatch'))
            entry['hasBreachPoint'] = bool(spec.get('breach'))
            entry['hasPillars'] = bool(spec.get('pillars'))
            entry['parts'] = [
                dict(role='wall', types=list(T.CQ_WALL_TYPES), z0=0.0, z1=T.h('cq.wall.top'),
                     heightRef='cq.wall.top'),
            ]
            if spec.get('hatch') or spec.get('breach'):
                entry['parts'].append(dict(
                    role='accessPoint', z0=0.0, z1=T.h('cq.wall.top'), heightRef='cq.wall.top',
                    typesClosed=list(T.CQ_ACCESS_CLOSED), typesOpen=list(T.CQ_ACCESS_OPEN)))
        elif spec.get('pad'):
            entry['parts'] = [dict(role='teleportPad', types=list(T.CQ_PAD_TYPES), z0=0.0,
                                   z1=T.h('cq.teleportPad.top'),
                                   heightRef='cq.teleportPad.top')]
        elif spec.get('light'):
            entry['parts'] = [dict(role='rubble', types=list(T.CQ_LIGHT_TYPES), z0=0.0,
                                   z1=T.h('cq.light.top'), heightRef='cq.light.top')]
        else:
            entry['parts'] = [
                {k: v for k, v in p.items() if k != 'from_'} | {'source': p['from_']}
                for p in spec['parts']]
        for lab in spec['labels']:
            if lab in templates:
                entry.setdefault('footprints', {})[lab] = G.round_poly(templates[lab])
        out['pieces'].append(entry)
    C.dump_json(os.path.join(OUT_TERRAIN, '%s.json' % killzone), out)


if __name__ == '__main__':
    main(sys.argv)
