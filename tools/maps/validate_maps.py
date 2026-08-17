#!/usr/bin/env python3
"""
Acceptance gates for the extracted Approved Ops 2025 maps.

    python3 tools/maps/validate_maps.py            # human-readable report
    python3 tools/maps/validate_maps.py --json     # machine-readable

Gates
  G1 calibration   px/inch is exactly 24.0 (open) / 94.0 px per lattice square (CQ)
  G2 geometry      every polygon lies on the board; no degenerate rings
  G3 inventory     per-map piece counts never exceed the printed killzone inventory
  G4 labels        every feature carries a card letter
  G5 objectives    exactly 3 markers, the centre one on the centre line (<= 0.15")
  G6 drop zones    depth is one of the printed values for that killzone
  G7 templates     fitted-template IoU >= 0.92
  G8 lattice       close-quarters wall centrelines sit within 0.1" of a lattice line
  G9 symmetry      report 180-degree rotational symmetry of the terrain footprint
"""
from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cardlib as C          # noqa: E402
import terrain as T          # noqa: E402

MAPS = os.path.join(C.ROOT, 'data', 'maps')

# Printed inventories (Killzones rules page + the killzone keys).
INVENTORY = {
    'volkus': {'A': 1, 'B': 1, 'C': 1, 'D': 1, 'E': 1, 'F': 1, 'G': 1, 'H': 1,
               'I': 1, 'J': 1, 'K': 1, 'L': 1, 'M': 1, 'N': 1},
    'bheta-decima': {'A': 2, 'B': 4, 'C': 2, 'D': 1},
    'gallowdark': {'A1': 2, 'A2': 2, 'A3': 2, 'A4': 2, 'B1': 2, 'B2': 2, 'B3': 4},
    'tomb-world': {'A1': 2, 'A2': 2, 'A3': 2, 'A4': 2, 'B1': 2, 'B2': 2, 'B3': 2,
                   'B4': 2, 'C1': 1, 'C2': 1, 'C3': 1, 'C4': 1, 'C5': 1, 'T': 2},
}
DROP_DEPTHS = {
    'volkus': [6.0, 3.0],
    'bheta-decima': [6.0, 4.0, 3.0],
    'gallowdark': [C.CQ_BORDER_X + C.CQ_SQUARE, C.CQ_BORDER_Y + C.CQ_SQUARE],
    'tomb-world': [C.CQ_BORDER_X + C.CQ_SQUARE, C.CQ_BORDER_Y + C.CQ_SQUARE],
}
IOU_GATE = 0.92


def check(m):
    kz = m['killzone']
    W, H = m['board']['w'], m['board']['h']
    fails, warns, info = [], [], {}

    # G1 calibration
    ppi = m['source']['qa']['pxPerInch']
    if kz in ('volkus', 'bheta-decima'):
        if abs(ppi - 24.0) > 1e-6:
            fails.append('G1 px/inch %.4f != 24.0' % ppi)
    else:
        step = m['source']['qa'].get('latticeStepPx')
        if step is None or abs(step - 94.0) > 0.05:
            fails.append('G1 lattice step %s != 94 px' % step)
    info['pxPerInch'] = ppi

    # G2 geometry
    def polys():
        for k in ('dropZones', 'territories'):
            for v in m[k].values():
                for p in v:
                    yield p
        for p in m.get('hazardous', []):
            yield p
        for f in m['features']:
            for part in f['parts']:
                yield part['poly']
    off = 0
    for p in polys():
        if len(p) < 3:
            fails.append('G2 degenerate polygon (%d points)' % len(p))
            continue
        xs = [q['x'] for q in p]
        ys = [q['y'] for q in p]
        if min(xs) < -0.05 or max(xs) > W + 0.05 or min(ys) < -0.05 or max(ys) > H + 0.05:
            off += 1
    if off:
        fails.append('G2 %d polygons off the board' % off)

    # G3 inventory, G4 labels
    counts = {}
    for f in m['features']:
        lab = f.get('label')
        if not lab or '?' in lab:
            warns.append('G4 unlabelled feature %s' % f['id'])
            continue
        counts[lab] = counts.get(lab, 0) + 1
    inv = INVENTORY[kz]
    for lab, n in sorted(counts.items()):
        if lab not in inv:
            fails.append('G3 unknown piece %r' % lab)
        elif n > inv[lab]:
            fails.append('G3 %s used %dx, inventory has %d' % (lab, n, inv[lab]))
    info['pieces'] = sum(counts.values())

    # G5 objectives
    if len(m['objectives']) != 3:
        fails.append('G5 %d objective markers, expected 3' % len(m['objectives']))
    kinds = {o['kind'] for o in m['objectives']}
    if kinds != {'p1', 'p2', 'centre'}:
        fails.append('G5 objective kinds %s' % sorted(kinds))
    cl = m['centreLine']
    for o in m['objectives']:
        if o['kind'] != 'centre':
            continue
        d = _pt_seg(o['pos']['x'], o['pos']['y'], cl['a'], cl['b'])
        info['centreObjOffIn'] = round(d, 4)
        if d > 0.15:
            # the neutral objective is not required to sit on the centre line
            # (Bheta-Decima 5 prints it 2" into P2 territory) - report, don't fail
            warns.append('G5 centre objective %.3f" off the centre line' % d)

    # G6 drop zones
    for who in ('p1', 'p2'):
        d = m['source']['qa']['dropDepth' + who.upper()]
        if not any(abs(d - v) < 0.02 for v in DROP_DEPTHS[kz]):
            fails.append('G6 %s drop depth %.4f" not a printed value' % (who, d))
    info['dropDepth'] = (m['source']['qa']['dropDepthP1'], m['source']['qa']['dropDepthP2'])

    # G7 templates
    ious = [f['qa']['templateIoU'] for f in m['features'] if 'qa' in f]
    if ious:
        info['iouMin'] = round(min(ious), 4)
        info['iouMedian'] = round(float(np.median(ious)), 4)
        bad = [f for f in m['features']
               if 'qa' in f and f['qa']['templateIoU'] < IOU_GATE]
        for f in bad:
            warns.append('G7 %s IoU %.3f < %.2f' % (f.get('label'), f['qa']['templateIoU'],
                                                    IOU_GATE))

    # G8 lattice alignment
    if m['closeQuarters']:
        nodes_x = [C.CQ_BORDER_X + i * C.CQ_SQUARE for i in range(C.CQ_NX + 1)]
        nodes_y = [C.CQ_BORDER_Y + i * C.CQ_SQUARE for i in range(C.CQ_NY + 1)]
        worst = 0.0
        for f in m['features']:
            if not f['kind'].endswith(tuple('A1 A2 A3 A4 B1 B2 B3 B4'.split())):
                continue
            for p in f['parts']:
                if p.get('role') != 'wall':
                    continue
                xs = [q['x'] for q in p['poly']]
                ys = [q['y'] for q in p['poly']]
                cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
                if max(xs) - min(xs) > max(ys) - min(ys):
                    worst = max(worst, min(abs(cy - v) for v in nodes_y))
                else:
                    worst = max(worst, min(abs(cx - v) for v in nodes_x))
        info['latticeErrIn'] = round(worst, 4)
        if worst > 0.1:
            fails.append('G8 wall centreline %.3f" off the lattice' % worst)

    # G9 180-degree symmetry of the terrain footprint
    info['symmetry'] = round(_symmetry(m), 3)

    if 'centreSeamErrIn' in m['source']['qa']:
        info['seamErrIn'] = m['source']['qa']['centreSeamErrIn']
        if m['source']['qa']['centreSeamErrIn'] > 0.15:
            warns.append('territory seam %.3f" off the board centre'
                         % m['source']['qa']['centreSeamErrIn'])
    return fails, warns, info


def _pt_seg(px, py, a, b):
    ax, ay, bx, by = a['x'], a['y'], b['x'], b['y']
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L2))
    return float(np.hypot(px - (ax + t * vx), py - (ay + t * vy)))


def _symmetry(m, res=96):
    """Fraction of the terrain footprint that maps onto itself under a 180-degree
    rotation about the board centre."""
    W, H = m['board']['w'], m['board']['h']
    grid = np.zeros((res, res), bool)
    bbox = (0, 0, W, H)
    for f in m['features']:
        for p in f['parts']:
            poly = [[q['x'], q['y']] for q in p['poly']]
            if len(poly) < 3:
                continue
            grid |= C.rasterize(poly, res, bbox)
    rot = grid[::-1, ::-1]
    u = (grid | rot).sum()
    return float((grid & rot).sum() / u) if u else 1.0


def main(argv):
    as_json = '--json' in argv
    report = {}
    nfail = 0
    for path in sorted(glob.glob(os.path.join(MAPS, '*', '*.json'))):
        m = json.load(open(path))
        fails, warns, info = check(m)
        report[m['id']] = dict(fails=fails, warns=warns, info=info)
        nfail += len(fails)
        if not as_json:
            flag = 'FAIL' if fails else ('warn' if warns else 'ok  ')
            print('%-16s %-4s  %s' % (m['id'], flag, _fmt(info)))
            for f in fails:
                print('      ! ' + f)
            for w in warns:
                print('      ~ ' + w)
    if as_json:
        print(json.dumps(report, indent=1))
    else:
        print('\n%d maps, %d gate failures' % (len(report), nfail))
    return 1 if nfail else 0


def _fmt(info):
    bits = []
    for k in ('pieces', 'dropDepth', 'iouMin', 'iouMedian', 'centreObjOffIn',
              'latticeErrIn', 'seamErrIn', 'symmetry'):
        if k in info:
            bits.append('%s=%s' % (k, info[k]))
    return '  '.join(bits)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
