#!/usr/bin/env python3
"""Small geometry helpers shared by the card extractor."""
from __future__ import annotations

import numpy as np
from scipy import ndimage


def rect_decompose(mask: np.ndarray, min_px: int = 12):
    """Greedy decomposition of a binary mask into maximal axis-aligned rectangles.

    Every structural stroke on these cards (Volkus stronghold/ruin walls,
    Gallowdark and Tomb World walls) is an axis-aligned bar, so a rectangle
    decomposition recovers the individual wall segments instead of one filled
    blob with a hole in it.
    """
    ys, xs = np.where(mask)
    if not len(ys):
        return []
    oy, ox = int(ys.min()), int(xs.min())
    m = mask[oy:ys.max() + 1, ox:xs.max() + 1].copy()
    out = []
    while m.any():
        r = _largest_rect(m)
        if r is None:
            break
        y0, x0, y1, x1 = r
        if (y1 - y0) * (x1 - x0) < min_px:
            break
        out.append((x0 + ox, y0 + oy, x1 + ox, y1 + oy))
        m[y0:y1, x0:x1] = False
    return out


def _largest_rect(m: np.ndarray):
    """Largest all-true axis-aligned rectangle (maximal rectangle in histogram)."""
    H, W = m.shape
    heights = np.zeros(W, int)
    best = (0, None)
    for y in range(H):
        row = m[y]
        heights = np.where(row, heights + 1, 0)
        stack = []
        for x in range(W + 1):
            h = heights[x] if x < W else 0
            start = x
            while stack and stack[-1][1] >= h:
                sx, sh = stack.pop()
                area = sh * (x - sx)
                if area > best[0]:
                    best = (area, (y - sh + 1, sx, y + 1, x))
                start = sx
            stack.append((start, h))
    return best[1]


def blob_polys(mask, frame, **kw):
    """Trace a mask and return board-space polygons (list of [ [x,y], ... ])."""
    import cardlib as C
    out = []
    for poly_px, area, blob in C.trace(mask, frame, **kw):
        pts = [frame.to_board(p[0], p[1]) for p in poly_px]
        out.append((np.array(pts, float), area, blob))
    return out


def px_rect_to_board(frame, x0, y0, x1, y1):
    """Pixel rectangle -> CCW board polygon."""
    a = frame.to_board(x0, y0)
    b = frame.to_board(x1, y1)
    xlo, xhi = min(a[0], b[0]), max(a[0], b[0])
    ylo, yhi = min(a[1], b[1]), max(a[1], b[1])
    return [(xlo, ylo), (xhi, ylo), (xhi, yhi), (xlo, yhi)]


def round_poly(poly, nd=3):
    return [{'x': round(float(p[0]), nd), 'y': round(float(p[1]), nd)} for p in poly]


def bbox(poly):
    p = np.asarray(poly, float)
    return float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())


def transform(poly, rotDeg, flip, dx, dy):
    """Rotate about the origin (CCW, degrees), optionally mirror in x, translate."""
    p = np.asarray(poly, float).copy()
    if flip:
        p[:, 0] = -p[:, 0]
    t = np.deg2rad(rotDeg)
    c, s = np.cos(t), np.sin(t)
    R = np.array([[c, -s], [s, c]])
    p = p @ R.T
    p[:, 0] += dx
    p[:, 1] += dy
    return p


def component_masks(mask, min_px=1):
    lab, n = ndimage.label(mask)
    for i in range(1, n + 1):
        blob = lab == i
        if blob.sum() >= min_px:
            yield blob


def split_blob_by_chips(blob, chips):
    """Split one traced blob between the label chips printed on it.

    Two terrain pieces drawn touching (Bheta-Decima gantries, a Volkus rubble
    piece against a ruin) trace as a single component. Both are drawn as
    axis-aligned rectangles, so a rectangle decomposition recovers the pieces;
    each rectangle goes to the chip inside it, or failing that to the nearest.
    """
    rects = rect_decompose(blob, min_px=30)
    out = {k: np.zeros_like(blob) for k in chips}
    for (x0, y0, x1, y1) in rects:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        owner = None
        for k, (px, py) in chips.items():
            if x0 <= px < x1 and y0 <= py < y1:
                owner = k
                break
        if owner is None:
            owner = min(chips, key=lambda k: (chips[k][0] - cx) ** 2 + (chips[k][1] - cy) ** 2)
        out[owner][y0:y1, x0:x1] = True
    for k in list(out):
        out[k] &= blob
        if not out[k].any():
            del out[k]
    return out
