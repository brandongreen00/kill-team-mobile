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

    p1d = tint(['p1_drop', 'p1_drop_grid'])
    p2d = tint(['p2_drop', 'p2_drop_grid'])
    p1t = tint(['p1_terr', 'p1_terr_grid'])
    p2t = tint(['p2_terr', 'p2_terr_grid'])

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
    """Pixel index where mask `a` ends and mask `b` begins along `axis`."""
    pa = a.sum(0 if axis == 0 else 1)
    pb = b.sum(0 if axis == 0 else 1)
    ia = np.where(pa > pa.max() * 0.3)[0]
    ib = np.where(pb > pb.max() * 0.3)[0]
    if not len(ia) or not len(ib):
        return None
    return (ia.max() + ib.min()) / 2 if ia.max() < ib.min() else (ib.max() + ia.min()) / 2


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
        r = max(h, w) / 2 + 3
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


def volkus_features(img, frame, objectives):
    x0, y0, x1, y1 = frame.qa['board_px']
    interior = np.zeros(img.shape[:2], bool)
    interior[y0:y1, x0:x1] = True

    green = C.mask_any(img, C.GREEN_MID, tol=4) & interior
    dgreen = C.mask_any(img, C.GREEN_DARK, tol=4) & interior

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

    chips = {t: (cx, cy) for t, cx, cy, _ in L.chips(img, 'open')}

    green_blobs = list(G.component_masks(green, 40))
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
    green = C.mask_any(img, C.GREEN_MID, tol=5) & interior
    # the label chips sit on the decks and punch holes in them
    green = L._fill_small_holes(green, 900)
    chips = {}
    for idx, (t, cx, cy, _) in enumerate(L.chips(img, 'open')):
        chips['%s#%d' % (t, idx)] = (cx, cy)

    out = []
    for blob in G.component_masks(green, 120):
        ys, xs = np.where(blob)
        pts = np.stack([xs, ys], 1).astype(float)
        # the deck may carry more than one chip when gantries are drawn touching
        inside = [k for k, (cx, cy) in chips.items()
                  if blob[int(round(cy)), int(round(cx))]]
        if not inside:
            k = min(chips, key=lambda k: np.min((pts[:, 0] - chips[k][0]) ** 2 +
                                                (pts[:, 1] - chips[k][1]) ** 2))
            inside = [k]
        polys = G.blob_polys(blob, frame)
        if not polys:
            continue
        poly = polys[0][0]
        for k in inside:
            label = k.split('#')[0]
            kind = T.LABEL_TO_KIND.get(('bheta-decima', label))
            if kind is None:
                continue
            spec = T.PIECES[kind]
            parts = []
            for pspec in spec['parts']:
                if pspec.get('optional'):
                    continue
                if pspec['from_'] == 'green':
                    parts.append((pspec, poly))
            out.append(dict(label=label, kind=kind, parts=parts,
                            groupKey=id(blob) if len(inside) > 1 else None,
                            shared=len(inside) > 1))
    return out


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
        access.append(((xs.min() + xs.max() + 1) / 2, (ys.min() + ys.max() + 1) / 2,
                       xs.max() - xs.min() > ys.max() - ys.min()))

    chips = [(t, cx, cy) for t, cx, cy, _ in L.chips(img, 'cq')]
    blackchips = [(t, cx, cy, b) for t, cx, cy, b in L.chips(img, 'black', **L.BLACK_CHIP)]

    runs = _cq_runs(occupied_h, occupied_v)
    feats = []
    used = set()
    for orient, i, j, length in runs:
        segs = _split_run(orient, i, j, length, chips, frame, lx, ly, used)
        feats.extend(segs)

    walls = []
    thick = _wall_thickness(wall, lx, ly)
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


def _split_run(orient, i, j, length, chips, frame, lx, ly, used):
    """Cut a run of lattice edges into the printed wall pieces using the labels."""
    # Labels sitting alongside this run, ordered along it.
    tol = (lx[1] - lx[0]) * 0.42
    mine = []
    for t, cx, cy in chips:
        if orient == 'h':
            if abs(cy - ly[j]) > tol:
                continue
            pos = (cx - lx[i]) / (lx[1] - lx[0])
            if -0.35 <= pos <= length + 0.35:
                mine.append((pos, t))
        else:
            if abs(cx - lx[i]) > tol:
                continue
            pos = (cy - ly[j]) / (ly[1] - ly[0])
            if -0.35 <= pos <= length + 0.35:
                mine.append((pos, t))
    mine.sort()
    mine = [(p, t) for p, t in mine if (orient, i, j, round(p, 2), t) not in used]

    spans = [2 if t.endswith(('1', '2', '3', '4')) and t[0] == 'A' else 1 for _, t in mine]
    out, cursor = [], 0
    for (pos, t), span in zip(mine, spans):
        if cursor + span > length:
            span = max(1, length - cursor)
        if span <= 0:
            break
        out.append((orient, i, j, cursor, span, t))
        cursor += span
    while cursor < length:                      # unlabelled remainder
        out.append((orient, i, j, cursor, 1, None))
        cursor += 1
    return out


def _wall_thickness(wall, lx, ly):
    """Median printed wall thickness in px, measured across occupied lattice lines."""
    widths = []
    for y in ly:
        yy = int(round(y))
        row = wall[yy]
        run = 0
        for v in wall[max(0, yy - 12):yy + 13, :].sum(1):
            pass
        col = wall[max(0, yy - 12):min(wall.shape[0], yy + 13), :]
        prof = col.sum(1)
        if prof.max() > wall.shape[1] * 0.2:
            widths.append(int((prof > wall.shape[1] * 0.2).sum()))
    return float(np.median(widths)) if widths else 9.0


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
    # nearest access-point pill lying along this wall
    ap = None
    for cx, cy, horiz in access:
        if orient == 'h' and horiz and abs(cy - a_px[1]) < thick * 2.2 \
                and min(a_px[0], b_px[0]) - 4 <= cx <= max(a_px[0], b_px[0]) + 4:
            ap = (cx, cy)
        if orient == 'v' and not horiz and abs(cx - a_px[0]) < thick * 2.2 \
                and min(a_px[1], b_px[1]) - 4 <= cy <= max(a_px[1], b_px[1]) + 4:
            ap = (cx, cy)
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
        cands = [_centre(p) for _, p in items]
        best_idx, best_score = 0, -1
        for a in range(len(cands)):
            scores = [_best_align(cands[a], cands[b])[0] for b in range(len(cands))]
            s = float(np.median(scores))
            if s > best_score:
                best_idx, best_score = a, s
        tmpl = cands[best_idx]
        templates[label] = tmpl
        for (mapId, poly), c in zip(items, cands):
            score, rot, flip = _best_align(tmpl, c)
            cx, cy = C.centroid(poly)
            fits.append(dict(label=label, mapId=mapId, iou=round(score, 4),
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

    objectives = _finish_objectives(objs, features, annotations, frame, img)

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
                        'treatAsZ', 'maxOperatives'):
                if opt in pspec:
                    p[opt] = pspec[opt]
            parts.append(p)
        allpts = np.vstack([np.asarray(poly, float) for _, poly in f['parts']])
        cx, cy = float(allpts[:, 0].mean()), float(allpts[:, 1].mean())
        feat = dict(id=fid, kind=f['kind'], label=f['label'], parts=parts,
                    placement=dict(x=round(cx, 3), y=round(cy, 3), rotDeg=0, flip=False))
        if group and f.get('shared'):
            gk = f['groupKey']
            groups.setdefault(gk, 'g%d' % len(groups))
            feat['groupId'] = '%s.%s' % (mapId, groups[gk])
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
        parts = [dict(id=fid + '.wall', featureId=fid, poly=G.round_poly(w['poly']),
                      z0=0.0, z1=T.h('cq.wall.top'), types=list(T.CQ_WALL_TYPES),
                      role='wall', blocksVisibility=True, solid=True, standable=False)]
        spec = T.PIECES.get(kind, {})
        if w['access'] is not None and (spec.get('hatch') or spec.get('breach')):
            cx, cy = w['access']
            half = (frame.lattice_x[1] - frame.lattice_x[0]) * 0.14
            box = G.px_rect_to_board(frame, cx - half, cy - half, cx + half, cy + half)
            role = 'hatch' if spec.get('hatch') else 'breachWall'
            parts.append(dict(id=fid + '.access', featureId=fid, poly=G.round_poly(box),
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


def _finish_objectives(objs, features, annotations, frame, img):
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
                z, on = 0.0, on
        d = dict(id='obj.%s' % ob['kind'], kind=ob['kind'],
                 pos={'x': x, 'y': y}, z=round(z, 3))
        if on and note is None:
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
        for f in m['features']:
            poly = _footprint(f)
            if poly is not None and f.get('label'):
                by_kz[m['killzone']][f['label']].append((mid, poly))
    qa_fits = {}
    for kz, inst in by_kz.items():
        templates, fits = fit_templates(inst)
        qa_fits[kz] = fits
        for f in fits:
            m = maps[f['mapId']]
            for feat in m['features']:
                if feat.get('label') == f['label'] and abs(feat['placement']['x'] - f['x']) < 1e-6 \
                        and abs(feat['placement']['y'] - f['y']) < 1e-6:
                    feat['placement']['rotDeg'] = f['rotDeg']
                    feat['placement']['flip'] = bool(f['flip'])
                    feat.setdefault('qa', {})['templateIoU'] = f['iou']
        write_terrain(kz, templates)
    for mid, m in maps.items():
        ious = [f['qa']['templateIoU'] for f in m['features'] if 'qa' in f]
        if ious:
            m['source']['qa']['templateIoUMin'] = round(min(ious), 4)
            m['source']['qa']['templateIoUMedian'] = round(float(np.median(ious)), 4)
        C.dump_json(os.path.join(OUT_MAPS, m['killzone'], '%s.json' % mid), m)
    C.dump_json(os.path.join(ROOT, 'docs', 'maps', 'fit-report.json'), qa_fits)
    print('wrote %d maps' % len(maps))


def _footprint(feat):
    """The polygon used for template matching: the largest standable/solid part."""
    best = None
    for p in feat['parts']:
        poly = [[q['x'], q['y']] for q in p['poly']]
        a = C.poly_area(poly)
        if best is None or a > best[0]:
            best = (a, poly)
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
