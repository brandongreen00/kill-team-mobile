#!/usr/bin/env python3
"""
Render `docs/maps/overlays/<mapId>.png` — the extracted geometry drawn on top of
the source card (left) and on its own (right), so the two can be compared by eye.

    python3 tools/maps/render_overlay.py               # all 24
    python3 tools/maps/render_overlay.py volkus-1      # a subset
"""
from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cardlib as C          # noqa: E402
from extract_cards import CARDS, CQ_KILLZONES  # noqa: E402

OUT = os.path.join(C.ROOT, 'docs', 'maps', 'overlays')
SCALE = 24.0            # px per inch in the rendered panel

ROLE_COLOUR = {
    'wall':        (255, 40, 40),
    'door':        (255, 210, 0),
    'floor':       (40, 200, 255),
    'rubble':      (120, 255, 120),
    'crate':       (255, 130, 0),
    'rampart':     (200, 120, 255),
    'ledge':       (255, 160, 200),
    'accessPoint': (255, 240, 60),
    'teleportPad': (0, 255, 200),
    None:          (255, 255, 255),
}


def load_map(killzone, mapId):
    p = os.path.join(C.ROOT, 'data', 'maps', killzone, '%s.json' % mapId)
    with open(p) as fh:
        return json.load(fh)


def render(card, mapId, killzone, name):
    m = load_map(killzone, mapId)
    src = Image.open(os.path.join(C.CARDS_DIR, card)).convert('RGB')
    cq = killzone in CQ_KILLZONES
    img = C.load(os.path.join(C.CARDS_DIR, card))
    frame = C.calibrate(img, cq)

    # --- panel A: overlay on the card -------------------------------------
    a = src.copy().convert('RGBA')
    ov = Image.new('RGBA', a.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    to_px = _boardToCard(frame)
    _draw(d, m, to_px, alpha=170, width=2)
    a = Image.alpha_composite(a, ov).convert('RGB')

    # --- panel B: extraction on its own -----------------------------------
    W = int(round(m['board']['w'] * SCALE)) + 2
    H = int(round(m['board']['h'] * SCALE)) + 2
    b = Image.new('RGB', (W, H), (24, 26, 30))
    db = ImageDraw.Draw(b)

    def bp(x, y):
        return (1 + x * SCALE, 1 + (m['board']['h'] - y) * SCALE)

    for who, col in (('p1', (150, 80, 45)), ('p2', (80, 80, 90))):
        for poly in m['territories'][who]:
            db.polygon([bp(p['x'], p['y']) for p in poly], fill=col)
    for who, col in (('p1', (205, 120, 70)), ('p2', (120, 120, 130))):
        for poly in m['dropZones'][who]:
            db.polygon([bp(p['x'], p['y']) for p in poly], fill=col)
    for poly in m.get('hazardous', []):
        db.polygon([bp(p['x'], p['y']) for p in poly], fill=(70, 90, 130))
    _draw(db, m, bp, alpha=255, width=2)

    out = Image.new('RGB', (a.width + b.width + 24, max(a.height, b.height) + 24),
                    (250, 250, 250))
    out.paste(a, (8, 8))
    out.paste(b, (a.width + 16, 8))
    os.makedirs(OUT, exist_ok=True)
    out.save(os.path.join(OUT, '%s.png' % mapId))
    return len(m['features'])


def _boardToCard(frame):
    """Inverse of Frame.to_board."""
    if frame.close_quarters:
        sx = (frame.lattice_x[-1] - frame.lattice_x[0]) / (C.CQ_NX * C.CQ_SQUARE)
        sy = (frame.lattice_y[-1] - frame.lattice_y[0]) / (C.CQ_NY * C.CQ_SQUARE)

        def f(x, y):
            px = frame.lattice_x[0] + (x - C.CQ_BORDER_X) * sx
            py = frame.lattice_y[0] + ((frame.board_h - y) - C.CQ_BORDER_Y) * sy
            return (px, py)
        return f

    def f(x, y):
        return (frame.x0 + x * frame.ppi_x,
                frame.y0 + (frame.board_h - y) * frame.ppi_y)
    return f


def _draw(d, m, to, alpha=255, width=2):
    for f in m['features']:
        for p in f['parts']:
            col = ROLE_COLOUR.get(p.get('role'), (255, 255, 255)) + (alpha,)
            pts = [to(q['x'], q['y']) for q in p['poly']]
            if len(pts) >= 3:
                d.polygon(pts, outline=col, width=width)
        px, py = to(f['placement']['x'], f['placement']['y'])
        d.text((px - 4, py - 6), f.get('label') or '?', fill=(255, 255, 255, alpha))
    for s in (m['centreLine'],):
        d.line([to(s['a']['x'], s['a']['y']), to(s['b']['x'], s['b']['y'])],
               fill=(255, 255, 255, alpha), width=2)
    s = m['flankLine']
    d.line([to(s['a']['x'], s['a']['y']), to(s['b']['x'], s['b']['y'])],
           fill=(160, 160, 255, alpha), width=1)
    for ob in m['objectives']:
        x, y = to(ob['pos']['x'], ob['pos']['y'])
        col = {'p1': (255, 90, 40), 'p2': (200, 200, 210), 'centre': (0, 0, 0)}[ob['kind']]
        d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=col + (alpha,), width=3)
    for who, col in (('p1', (255, 140, 60)), ('p2', (170, 170, 180)),
                     ('neutral', (110, 110, 112))):
        for seg in m['killzoneEdges'][who]:
            d.line([to(seg['a']['x'], seg['a']['y']), to(seg['b']['x'], seg['b']['y'])],
                   fill=col + (alpha,), width=4)


def main(argv):
    want = set(argv[1:])
    n = 0
    for card, mapId, killzone, name in CARDS:
        if want and mapId not in want:
            continue
        c = render(card, mapId, killzone, name)
        print('%-16s %2d features -> docs/maps/overlays/%s.png' % (mapId, c, mapId))
        n += 1
    print('rendered %d overlays' % n)


if __name__ == '__main__':
    main(sys.argv)
