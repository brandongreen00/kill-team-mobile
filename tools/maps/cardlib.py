#!/usr/bin/env python3
"""
Shared primitives for the Approved Ops 2025 map-card extraction.

Everything here is deterministic and depends only on the committed card PNGs
under docs/context-pack/research/approved-ops/. No network access.

Coordinate systems
------------------
  card px  : origin top-left, +y DOWN  (the PNG)
  board in : origin bottom-left, +y UP, x along the LONG edge (src/core/types.ts)

The conversion happens exactly once, in `Frame.to_board`.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np
from PIL import Image
from scipy import ndimage
from skimage import measure

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CARDS_DIR = os.path.join(ROOT, 'docs', 'context-pack', 'research', 'approved-ops', 'maps')

# ---------------------------------------------------------------------------
# Palette — every value read off the legend swatch PNGs in
# docs/context-pack/research/approved-ops/keys/ (A-Drop.png etc.), verified
# against the cards themselves.
# ---------------------------------------------------------------------------
PALETTE = {
    'p1_drop':      (227, 157, 121),   # keys/A-Drop.png
    'p1_drop_grid': (209, 144, 111),
    'p1_terr':      (233, 204, 186),   # keys/A-Territory.png
    'p1_terr_grid': (214, 187, 171),
    'p2_drop':      (164, 165, 169),   # keys/B-Drop.png
    'p2_drop_grid': (150, 151, 155),
    'p2_terr':      (193, 192, 197),   # keys/B-Territory.png
    'p2_terr_grid': (177, 176, 181),
    'hazard':       (148, 163, 192),   # keys/Hazardous.png
    'hazard_grid':  (136, 149, 176),
    'p1_ring':      (246, 90, 41),     # keys/A-Obj.png
    'p2_ring':      (123, 123, 126),   # keys/B-Obj.png
    'p1_edge':      (247, 144, 86),    # keys/A-Edge.png
    'p2_edge':      (147, 146, 152),   # keys/B-Edge.png
    'n_edge':       (109, 110, 112),   # keys/N-Edge.png
    'label_open':   (79, 85, 90),      # label chip on Volkus / Bheta-Decima cards
    'label_cq':     (103, 103, 98),    # label chip on Gallowdark / Tomb World cards
    'wall_cq':      (19, 23, 29),      # Gallowdark / Tomb World wall ink
    'hatch_cq':     (63, 57, 52),      # hatchway pill
    'edge_pillar_a': (159, 110, 85),   # board-edge pillar over P1 tint
    'edge_pillar_b': (115, 116, 119),  # board-edge pillar over P2 tint
    'black':        (0, 0, 0),
    'white':        (255, 255, 255),
}

# Terrain green is alpha-blended over whichever tint is underneath, so it is a
# small family rather than one value. These are the observed members.
GREEN_MID = [(102, 118, 109), (103, 120, 110), (103, 118, 109), (102, 117, 108),
             (104, 121, 111), (101, 116, 107)]
GREEN_DARK = [(46, 69, 57), (47, 70, 58), (45, 68, 56)]
# Tomb World breach-point ticks: green over the two tints.
GREEN_TICK = [(93, 111, 84), (94, 112, 85), (92, 110, 83), (95, 113, 86),
              (100, 118, 90), (88, 105, 80)]

BOARD_OPEN = (30.0, 22.0)
# Physical close-quarters board: 703mm x 606mm.  7x6 lattice of 3.8125" squares
# centred on it -> border strips of exactly 0.46875" (x) and 0.5" (y).
CQ_SQUARE = 3.8125
CQ_NX, CQ_NY = 7, 6
CQ_BORDER_X = 0.46875
CQ_BORDER_Y = 0.5
BOARD_CQ = (CQ_BORDER_X * 2 + CQ_NX * CQ_SQUARE, CQ_BORDER_Y * 2 + CQ_NY * CQ_SQUARE)


def load(path: str) -> np.ndarray:
    return np.array(Image.open(path).convert('RGB')).astype(np.int16)


def mask_exact(img: np.ndarray, colour, tol: int = 2) -> np.ndarray:
    return np.abs(img - np.array(colour, dtype=np.int16)).max(2) <= tol


def mask_any(img: np.ndarray, colours: Iterable, tol: int = 2) -> np.ndarray:
    out = np.zeros(img.shape[:2], bool)
    for c in colours:
        out |= mask_exact(img, c, tol)
    return out


# ---------------------------------------------------------------------------
# Frame calibration
# ---------------------------------------------------------------------------

@dataclass
class Frame:
    """Maps card pixels to board inches."""
    x0: float        # px x of board-interior left edge
    y0: float        # px y of board-interior top edge
    ppi_x: float
    ppi_y: float
    board_w: float
    board_h: float
    close_quarters: bool
    lattice_x: list = field(default_factory=list)   # px of lattice lines (CQ only)
    lattice_y: list = field(default_factory=list)
    qa: dict = field(default_factory=dict)

    def to_board(self, px: float, py: float) -> tuple[float, float]:
        """Card pixel -> board inches (origin bottom-left, +y up)."""
        if self.close_quarters:
            # Card px are mapped through the lattice: the card's border strip is
            # drawn compressed, so only lattice-relative position is trusted.
            u = (px - self.lattice_x[0]) / (self.lattice_x[-1] - self.lattice_x[0])
            v = (py - self.lattice_y[0]) / (self.lattice_y[-1] - self.lattice_y[0])
            x = CQ_BORDER_X + u * (CQ_NX * CQ_SQUARE)
            y_down = CQ_BORDER_Y + v * (CQ_NY * CQ_SQUARE)
            return (x, self.board_h - y_down)
        x = (px - self.x0) / self.ppi_x
        y_down = (py - self.y0) / self.ppi_y
        return (x, self.board_h - y_down)

    def scale_x(self, dpx: float) -> float:
        if self.close_quarters:
            return dpx / ((self.lattice_x[-1] - self.lattice_x[0]) / (CQ_NX * CQ_SQUARE))
        return dpx / self.ppi_x

    def scale_y(self, dpy: float) -> float:
        if self.close_quarters:
            return dpy / ((self.lattice_y[-1] - self.lattice_y[0]) / (CQ_NY * CQ_SQUARE))
        return dpy / self.ppi_y

    def to_board_poly(self, pts_xy_px: Sequence[Sequence[float]]) -> list:
        return [dict(zip(('x', 'y'), (round(v, 4) for v in self.to_board(p[0], p[1]))))
                for p in pts_xy_px]


def _tint_mask(img: np.ndarray) -> np.ndarray:
    """Everything that is part of the printed board (tints, grid, ink, terrain)."""
    keys = ['p1_drop', 'p1_drop_grid', 'p1_terr', 'p1_terr_grid', 'p2_drop',
            'p2_drop_grid', 'p2_terr', 'p2_terr_grid', 'hazard', 'hazard_grid']
    return mask_any(img, [PALETTE[k] for k in keys], tol=3)


def calibrate(img: np.ndarray, close_quarters: bool) -> Frame:
    """Locate the board interior and (for CQ cards) the 7x6 lattice."""
    H, W, _ = img.shape
    tint = _tint_mask(img)
    colsum, rowsum = tint.sum(0), tint.sum(1)
    xs = np.where(colsum > 0.25 * H)[0]
    ys = np.where(rowsum > 0.25 * W)[0]
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1

    qa: dict = {}
    if not close_quarters:
        ppi_x = (x1 - x0) / BOARD_OPEN[0]
        ppi_y = (y1 - y0) / BOARD_OPEN[1]
        # Independent check: the printed 1" grid.
        gx = _grid_lines(img, axis=0, x0=x0, x1=x1, y0=y0, y1=y1)
        gy = _grid_lines(img, axis=1, x0=x0, x1=x1, y0=y0, y1=y1)
        qa['grid_step_x_px'] = round(float(np.median(np.diff(gx))), 4) if len(gx) > 2 else None
        qa['grid_step_y_px'] = round(float(np.median(np.diff(gy))), 4) if len(gy) > 2 else None
        qa['board_px'] = [x0, y0, x1, y1]
        return Frame(x0, y0, ppi_x, ppi_y, *BOARD_OPEN, False, qa=qa)

    # Close quarters: find the lattice from the printed 3.8125" grid.
    gx = _cq_grid_lines(img, axis=0, x0=x0, x1=x1, y0=y0, y1=y1)
    gy = _cq_grid_lines(img, axis=1, x0=x0, x1=x1, y0=y0, y1=y1)
    lx = _fit_lattice(gx, CQ_NX + 1)
    ly = _fit_lattice(gy, CQ_NY + 1)
    qa['board_px'] = [x0, y0, x1, y1]
    qa['lattice_step_x_px'] = round(float(np.median(np.diff(lx))), 4)
    qa['lattice_step_y_px'] = round(float(np.median(np.diff(ly))), 4)
    ppi_x = (lx[-1] - lx[0]) / (CQ_NX * CQ_SQUARE)
    ppi_y = (ly[-1] - ly[0]) / (CQ_NY * CQ_SQUARE)
    return Frame(x0, y0, ppi_x, ppi_y, *BOARD_CQ, True,
                 lattice_x=[float(v) for v in lx], lattice_y=[float(v) for v in ly], qa=qa)


def _grid_lines(img, axis, x0, x1, y0, y1, cq=False):
    """Columns (axis=0) / rows (axis=1) carrying the printed grid ink."""
    grids = [PALETTE[k] for k in ('p1_drop_grid', 'p1_terr_grid', 'p2_drop_grid',
                                  'p2_terr_grid', 'hazard_grid')]
    m = mask_any(img, grids, tol=3)
    sub = m[y0:y1, x0:x1]
    prof = sub.sum(0) if axis == 0 else sub.sum(1)
    span = sub.shape[0] if axis == 0 else sub.shape[1]
    thresh = 0.30 * span
    idx = np.where(prof > thresh)[0]
    if len(idx) == 0:
        return np.array([])
    # collapse runs to their centre
    out, run = [], [idx[0]]
    for v in idx[1:]:
        if v - run[-1] <= 2:
            run.append(v)
        else:
            out.append(np.mean(run))
            run = [v]
    out.append(np.mean(run))
    base = x0 if axis == 0 else y0
    return np.array([v + base for v in out], float)


def _cq_grid_lines(img, axis, x0, x1, y0, y1):
    """Close-quarters cards print the 3.8125" lattice as a 1px multiply-darkened
    line over whatever tint is underneath, so it has no fixed colour. Detect it
    as "one pixel darker than both neighbours" and accumulate along the axis."""
    lum = img.astype(float).mean(2)[y0:y1, x0:x1]
    if axis == 0:
        d = lum[:, 1:-1]
        darker = (lum[:, :-2] - d > 18) & (lum[:, 2:] - d > 18)
        prof = np.zeros(lum.shape[1]); prof[1:-1] = darker.sum(0)
        span = lum.shape[0]
    else:
        d = lum[1:-1, :]
        darker = (lum[:-2, :] - d > 18) & (lum[2:, :] - d > 18)
        prof = np.zeros(lum.shape[0]); prof[1:-1] = darker.sum(1)
        span = lum.shape[1]
    idx = np.where(prof > 0.25 * span)[0]
    if len(idx) == 0:
        return np.array([])
    out, run = [], [idx[0]]
    for v in idx[1:]:
        if v - run[-1] <= 2:
            run.append(v)
        else:
            out.append(np.mean(run)); run = [v]
    out.append(np.mean(run))
    base = x0 if axis == 0 else y0
    return np.array([v + base for v in out], float)


def _fit_lattice(lines, n):
    """Least-squares fit of `n` evenly spaced lattice lines to detected grid ink."""
    if len(lines) < 2:
        raise RuntimeError('not enough grid lines to fit a lattice')
    lo, hi = float(lines.min()), float(lines.max())
    best = None
    # The printed CQ grid is exactly the lattice, but the outermost lines may be
    # hidden under walls; search the plausible (start, step) space.
    step0 = (hi - lo) / max(1, round((hi - lo) / ((hi - lo) / (n - 1))))
    for k in range(0, n):
        for m in range(0, n):
            if k + m >= n:
                continue
            step = (hi - lo) / (n - 1 - k - m) if (n - 1 - k - m) > 0 else None
            if step is None:
                continue
            start = lo - k * step
            cand = np.array([start + i * step for i in range(n)])
            err = sum(min(abs(cand - v)) for v in lines)
            if best is None or err < best[0]:
                best = (err, cand)
    return best[1]


# ---------------------------------------------------------------------------
# Contour tracing (mirrors tools/layouts11 in the 40k sim: close -> label ->
# find_contours -> Douglas-Peucker, tolerances scaled to Kill Team's small pieces)
# ---------------------------------------------------------------------------

CLOSE_IN = 0.07      # morphological closing radius, inches
MIN_AREA_SQIN = 0.20  # drop specks smaller than this
DP_IN = 0.07         # Douglas-Peucker tolerance, inches


def trace(mask: np.ndarray, frame: Frame, close_in=CLOSE_IN, min_area=MIN_AREA_SQIN,
          dp_in=DP_IN, fill_holes=True):
    """Boolean mask -> list of (polygon_px, area_sqin, blob_mask)."""
    ppi = (frame.ppi_x + frame.ppi_y) / 2
    r = max(1, int(round(close_in * ppi)))
    st = np.ones((2 * r + 1, 2 * r + 1), bool)
    m = ndimage.binary_closing(mask, st)
    if fill_holes:
        m = ndimage.binary_fill_holes(m)
    lab, n = ndimage.label(m)
    out = []
    for i in range(1, n + 1):
        blob = lab == i
        area = blob.sum() / (frame.ppi_x * frame.ppi_y)
        if area < min_area:
            continue
        padded = np.pad(blob.astype(float), 1)
        cs = measure.find_contours(padded, 0.5)
        if not cs:
            continue
        c = max(cs, key=len)  # outer ring
        poly = np.stack([c[:, 1] - 1, c[:, 0] - 1], 1)  # (x, y) px
        poly = simplify(poly, dp_in * ppi)
        out.append((poly, area, blob))
    out.sort(key=lambda t: -t[1])
    return out


def simplify(ring: np.ndarray, tol_px: float) -> np.ndarray:
    """Douglas-Peucker on a closed ring.

    The ring's first and last point coincide, which gives a zero-length RDP
    baseline; cut it at two extreme vertices and simplify each chain (the bug
    documented in tools/layouts11/README).
    """
    pts = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
    if len(pts) < 4:
        return pts
    i0 = int(np.argmin(pts[:, 0] + pts[:, 1]))
    pts = np.roll(pts, -i0, axis=0)
    i1 = int(np.argmax(np.sum((pts - pts[0]) ** 2, 1)))
    a = _rdp(pts[:i1 + 1], tol_px)
    b = _rdp(np.vstack([pts[i1:], pts[:1]]), tol_px)
    out = np.vstack([a[:-1], b[:-1]])
    return ccw(out)


def _rdp(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = math.hypot(*ab)
    if L < 1e-9:
        d = np.hypot(pts[:, 0] - a[0], pts[:, 1] - a[1])
    else:
        d = np.abs(np.cross(np.tile(ab, (len(pts), 1)), pts - a)) / L
    i = int(np.argmax(d))
    if d[i] <= tol:
        return np.vstack([a, b])
    return np.vstack([_rdp(pts[:i + 1], tol)[:-1], _rdp(pts[i:], tol)])


def ccw(poly: np.ndarray) -> np.ndarray:
    """Force counter-clockwise winding in BOARD space.

    Card pixels are y-down, so a ring that is CCW on the board is CW in px:
    the shoelace sign is inverted when the y axis flips.
    """
    if signed_area(poly) > 0:      # CCW in px == CW on the board
        poly = poly[::-1]
    return poly


def signed_area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def poly_area(poly) -> float:
    p = np.asarray(poly, float)
    return abs(signed_area(p))


def centroid(poly) -> tuple[float, float]:
    p = np.asarray(poly, float)
    a = signed_area(p)
    if abs(a) < 1e-12:
        return float(p[:, 0].mean()), float(p[:, 1].mean())
    x, y = p[:, 0], p[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    cr = x * yn - xn * y
    return (float(np.dot(x + xn, cr) / (6 * a)), float(np.dot(y + yn, cr) / (6 * a)))


def rasterize(poly, res, bbox):
    """Rasterize a polygon into a res x res boolean grid over bbox=(x0,y0,x1,y1).

    Even-odd scanline fill, vectorised over the grid; no plotting dependency.
    """
    x0, y0, x1, y1 = bbox
    gx = np.linspace(x0, x1, res)
    gy = np.linspace(y0, y1, res)
    P = np.asarray(poly, float)
    xs, ys = P[:, 0], P[:, 1]
    xs2, ys2 = np.roll(xs, -1), np.roll(ys, -1)
    Y = gy[:, None]                                   # (res, 1)
    crosses = ((ys[None, :] > Y) != (ys2[None, :] > Y))
    with np.errstate(divide='ignore', invalid='ignore'):
        xint = (xs2 - xs)[None, :] * (Y - ys[None, :]) / (ys2 - ys)[None, :] + xs[None, :]
    out = np.zeros((res, res), bool)
    for r in range(res):
        c = crosses[r]
        if not c.any():
            continue
        e = np.sort(xint[r][c])
        idx = np.searchsorted(e, gx, side='right')
        out[r] = (idx % 2) == 1
    return out


def iou(polyA, polyB, res=220) -> float:
    A = np.asarray(polyA, float)
    B = np.asarray(polyB, float)
    x0 = min(A[:, 0].min(), B[:, 0].min()); x1 = max(A[:, 0].max(), B[:, 0].max())
    y0 = min(A[:, 1].min(), B[:, 1].min()); y1 = max(A[:, 1].max(), B[:, 1].max())
    pad = 0.02 * max(x1 - x0, y1 - y0, 1e-6)
    bbox = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
    ra = rasterize(A, res, bbox); rb = rasterize(B, res, bbox)
    u = (ra | rb).sum()
    return float((ra & rb).sum() / u) if u else 0.0


def dump_json(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(obj, fh, indent=1, sort_keys=False)
        fh.write('\n')
