"""Recover the door part of a Volkus stronghold / large ruin from its wall ring.

Killzones § Stronghold B: "The door is Accessible and Heavy terrain."
Killzones § Large Ruin C: "The door is Accessible and Heavy terrain. For the purposes of
control range, ignore the door when determining visibility."

`extract_cards.py::_volkus_doors` reads the door off the card as a white dashed segment
printed across the wall. That detector is narrow (it demands a blob 12-14px on its short
side) and in practice only ever fires on Stronghold B, so Stronghold A and both Large Ruins
came out with the doorway left as an unmodelled HOLE in the wall ring: not Accessible, not
Heavy, not there at all. That is worse than either alternative — the gap cost nothing to
cross, gave no cover and obscured nobody, and once movement is checked against terrain a
1.17" hole is narrower than a 32mm base, so the building would have sealed shut instead.

The doorway is still in the geometry, as the gap the wall ring is traced around, so it is
recoverable without the source PNGs:

  1. Split the ring into straight runs. Two wall parts lie on the same run when they share a
     minor-axis extent (same line, same thickness). A door-sized hole between two parts of
     one run is a door candidate. Traced fragments thinner than `MIN_THICKNESS` are ignored:
     they are tracing noise, and one of them bridging a doorway hides it.
  2. Calibrate each piece kind's door width from the candidates that are unambiguous, and
     keep only candidates that match it. A physical terrain piece has one door of one width,
     so this rejects the stray hole an imperfect trace leaves elsewhere in the ring.
  3. Where a ring is too damaged to resolve (Stronghold A on volkus-5, whose top wall is
     traced as three sub-thickness slivers), fall back to the consensus position of the same
     piece on the maps that did resolve, expressed as a fraction of the rotation-normalised
     wall-ring bounding box and mapped back onto this instance.

Step 3's normalisation is checked, not assumed: the six Stronghold B doors that
`_volkus_doors` DID find all normalise to exactly (0.974, 0.453) - (1.0, 0.693), and
`test_doors.py` pins that the derivation reproduces every one of them from geometry alone.
"""
from __future__ import annotations

import math
from collections import defaultdict

# Piece kinds with a door in the Volkus terrain key.
DOOR_KINDS = ('volkus.strongholdA', 'volkus.strongholdB', 'volkus.largeRuin')

# A traced wall run is ~0.21" thick. Anything much thinner is a sliver the rasteriser left
# behind, not a wall, and must not be allowed to bridge a doorway.
MIN_THICKNESS = 0.15
# Plausible doorway widths before per-kind calibration narrows it further.
DOOR_MIN, DOOR_MAX = 0.7, 2.6
# How far a candidate may sit from the kind's calibrated door width.
WIDTH_TOL = 0.2
# Two parts are on the same run when their minor extents agree to this.
LINE_TOL = 0.08


def _bbox(poly):
    xs = [p['x'] for p in poly]
    ys = [p['y'] for p in poly]
    return [min(xs), min(ys), max(xs), max(ys)]


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _thickness(b):
    return min(b[2] - b[0], b[3] - b[1])


def _candidates(walls):
    """Door-sized holes between two parts of the same straight wall run."""
    out = []
    for i in range(len(walls)):
        for j in range(i + 1, len(walls)):
            a, b = walls[i], walls[j]
            # same horizontal run (shared y extent) -> hole along x
            if abs(a[1] - b[1]) <= LINE_TOL and abs(a[3] - b[3]) <= LINE_TOL:
                lo, hi = (a, b) if a[0] <= b[0] else (b, a)
                gap = hi[0] - lo[2]
                if DOOR_MIN <= gap <= DOOR_MAX:
                    out.append((gap, [lo[2], min(a[1], b[1]), hi[0], max(a[3], b[3])]))
            # same vertical run (shared x extent) -> hole along y
            if abs(a[0] - b[0]) <= LINE_TOL and abs(a[2] - b[2]) <= LINE_TOL:
                lo, hi = (a, b) if a[1] <= b[1] else (b, a)
                gap = hi[1] - lo[3]
                if DOOR_MIN <= gap <= DOOR_MAX:
                    out.append((gap, [min(a[0], b[0]), lo[3], max(a[2], b[2]), hi[1]]))
    return out


def _rotate(x, y, cx, cy, rot_deg, flip):
    a = -math.radians(rot_deg)
    x, y = x - cx, y - cy
    rx, ry = x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)
    return (-rx if flip else rx), ry


def _to_fraction(box, ring, placement):
    """The box as a fraction of the rotation-normalised wall-ring bounding box."""
    cx, cy = (ring[0] + ring[2]) / 2, (ring[1] + ring[3]) / 2
    rot, flip = placement.get('rotDeg', 0), placement.get('flip', False)
    corners = lambda b: [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
    rp = [_rotate(x, y, cx, cy, rot, flip) for x, y in corners(ring)]
    bp = [_rotate(x, y, cx, cy, rot, flip) for x, y in corners(box)]
    rx0, rx1 = min(p[0] for p in rp), max(p[0] for p in rp)
    ry0, ry1 = min(p[1] for p in rp), max(p[1] for p in rp)
    w, h = rx1 - rx0, ry1 - ry0
    if w <= 0 or h <= 0:
        return None
    return [(min(p[0] for p in bp) - rx0) / w, (min(p[1] for p in bp) - ry0) / h,
            (max(p[0] for p in bp) - rx0) / w, (max(p[1] for p in bp) - ry0) / h]


def _from_fraction(frac, ring, placement):
    """Inverse of `_to_fraction`: a normalised fraction back to a world-space rectangle."""
    cx, cy = (ring[0] + ring[2]) / 2, (ring[1] + ring[3]) / 2
    rot, flip = placement.get('rotDeg', 0), placement.get('flip', False)
    corners = lambda b: [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
    rp = [_rotate(x, y, cx, cy, rot, flip) for x, y in corners(ring)]
    rx0, rx1 = min(p[0] for p in rp), max(p[0] for p in rp)
    ry0, ry1 = min(p[1] for p in rp), max(p[1] for p in rp)
    w, h = rx1 - rx0, ry1 - ry0
    nx0, ny0 = rx0 + frac[0] * w, ry0 + frac[1] * h
    nx1, ny1 = rx0 + frac[2] * w, ry0 + frac[3] * h
    # rotate the normalised rectangle back into world space
    a = math.radians(rot)
    pts = []
    for x, y in [(nx0, ny0), (nx1, ny0), (nx1, ny1), (nx0, ny1)]:
        if flip:
            x = -x
        pts.append((x * math.cos(a) - y * math.sin(a) + cx, x * math.sin(a) + y * math.cos(a) + cy))
    return [min(p[0] for p in pts), min(p[1] for p in pts),
            max(p[0] for p in pts), max(p[1] for p in pts)]


def _median(values):
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def derive_doors(instances):
    """Resolve one door rectangle per instance.

    `instances` is a list of dicts: {id, kind, placement, walls: [poly, ...]}.
    Returns {id: [x0, y0, x1, y1]} for every instance a door could be resolved for, and a
    second dict {id: 'ring' | 'consensus'} recording how each was resolved.
    """
    prepared = []
    for inst in instances:
        boxes = [_bbox(p) for p in inst['walls']]
        solid = [b for b in boxes if _thickness(b) >= MIN_THICKNESS] or boxes
        prepared.append({**inst, 'boxes': boxes, 'ring': _union(solid),
                         'cands': _candidates(solid)})

    # 1. Calibrate each kind's door width from the instances with exactly one candidate.
    widths = defaultdict(list)
    for inst in prepared:
        if len(inst['cands']) == 1:
            widths[inst['kind']].append(inst['cands'][0][0])
    calibrated = {k: _median(v) for k, v in widths.items()}

    resolved, how = {}, {}
    for inst in prepared:
        target = calibrated.get(inst['kind'])
        keep = [c for c in inst['cands']
                if target is None or abs(c[0] - target) <= WIDTH_TOL]
        if len(keep) == 1:
            resolved[inst['id']] = keep[0][1]
            how[inst['id']] = 'ring'

    # 2. Consensus position per kind, for the rings too damaged to resolve on their own.
    fractions = defaultdict(list)
    for inst in prepared:
        box = resolved.get(inst['id'])
        if box is None:
            continue
        frac = _to_fraction(box, inst['ring'], inst['placement'])
        if frac:
            fractions[inst['kind']].append(frac)

    for inst in prepared:
        if inst['id'] in resolved:
            continue
        pool = fractions.get(inst['kind'])
        if not pool:
            continue
        consensus = [_median([f[i] for f in pool]) for i in range(4)]
        resolved[inst['id']] = _from_fraction(consensus, inst['ring'], inst['placement'])
        how[inst['id']] = 'consensus'

    return resolved, how


def clip_walls_out_of_doorway(box, walls, pad=0.02):
    """Cut the doorway back out of any wall part that overlaps it.

    Two things end up inside a door opening when the ring is traced imperfectly: a short bar
    floating in the middle of it (volkus-4 Stronghold A), and a sub-thickness sliver running
    along the top of the wall run that bridges straight across it (volkus-5 Stronghold A).
    Both plug the door — and a plugged 1.17" doorway is a sealed building, because a 32mm base
    only fits through it by the Accessible rule in the first place.

    Returns {index: [rect, ...]} for every wall that overlaps the opening, giving the pieces of
    it that survive outside. An empty list means the whole part was inside the doorway.
    """
    long_axis = 0 if (box[2] - box[0]) >= (box[3] - box[1]) else 1
    lo, hi = box[long_axis], box[long_axis + 2]
    out = {}
    for i, poly in enumerate(walls):
        b = _bbox(poly)
        # a real intersection, not a shared edge
        ox = min(b[2], box[2]) - max(b[0], box[0])
        oy = min(b[3], box[3]) - max(b[1], box[1])
        if ox <= pad or oy <= pad:
            continue
        pieces = []
        if b[long_axis] < lo - pad:
            piece = list(b)
            piece[long_axis + 2] = lo
            pieces.append(piece)
        if b[long_axis + 2] > hi + pad:
            piece = list(b)
            piece[long_axis] = hi
            pieces.append(piece)
        out[i] = [p for p in pieces if (p[2] - p[0]) > pad and (p[3] - p[1]) > pad]
    return out


def rect_poly(box):
    """A door rectangle as the CCW polygon the KillzoneMap schema wants."""
    x0, y0, x1, y1 = (round(v, 3) for v in box)
    return [{'x': x0, 'y': y0}, {'x': x1, 'y': y0}, {'x': x1, 'y': y1}, {'x': x0, 'y': y1}]
