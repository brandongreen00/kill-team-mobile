#!/usr/bin/env python3
"""
Regression tests for the card extractor's pixel-level detectors.

    python3 tools/maps/test_extract.py          # or: pnpm maps:test

The official map cards are Games Workshop IP and are not in the repository
(`docs/context-pack/` is gitignored), so these tests draw their own cards using
the same drawing conventions the real ones use -- terrain green, a white dashed
outline, an opaque label pill printed on top, black wall ink with white door
dashes across it, a white objective annulus. That is enough to pin the property
`dashed_rects()` actually depends on, which is RECALL ACROSS SCALE: the same
outline must be found whether it is drawn around piece I (2 x 3.5") or piece K
(0.75 x 1.979"), and whether or not the label pill lands on top of it.

Sizes below are in card pixels at the real card scale of 24 px/inch.
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cardlib as C          # noqa: E402
import extract_cards as E    # noqa: E402

PPI = 24.0                   # px per inch, asserted on every real open card
GREEN = C.GREEN_MID[0]
CHIP = C.PALETTE['label_open']
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)

# The Volkus pieces this bug was found on, at their template sizes.
PIECE_IN = {
    'I': (2.0, 3.5),         # light rubble  -- always detected
    'G': (3.0, 1.0),         # heavy rubble  -- always detected
    'J': (0.75, 2.396),      # light rubble  -- never detected before this fix
    'K': (0.75, 1.979),      # light rubble  -- never detected before this fix
}


# ---------------------------------------------------------------------------
# A synthetic card
# ---------------------------------------------------------------------------

def card(w=743, h=550):
    """A blank card the size of a real open-killzone card, filled with green."""
    img = np.zeros((h, w, 3), np.uint8)
    img[:, :] = GREEN
    return img


def px(size_in):
    """Inches -> the pixel side of a piece at card scale."""
    return int(round(size_in * PPI))


def rect_px(cx, cy, size_in, rot=False):
    """Pixel box (x0, y0, x1, y1) for a piece centred on (cx, cy)."""
    a, b = (px(size_in[1]), px(size_in[0])) if rot else (px(size_in[0]), px(size_in[1]))
    return (cx - a // 2, cy - b // 2, cx - a // 2 + a, cy - b // 2 + b)


def dashed_outline(img, box, t=3, dash=10, gap=6):
    """Draw a white dashed rectangle whose stroke straddles `box`'s outline.

    Dashes are laid along each edge and stop short of the corners, which is how
    the cards draw them: no dash wraps a corner, so a small rectangle's short
    side carries a single segment.
    """
    x0, y0, x1, y1 = box
    o = t // 2
    for (a, b, fixed, horizontal) in ((x0, x1, y0, True), (x0, x1, y1 - 1, True),
                                      (y0, y1, x0, False), (y0, y1, x1 - 1, False)):
        run = b - a
        period = dash + gap
        n = max(1, (run + gap) // period)
        start = a + (run - (n * period - gap)) // 2
        for i in range(n):
            s = start + i * period
            e = min(b, s + dash)
            if horizontal:
                img[fixed - o:fixed - o + t, s:e] = WHITE
            else:
                img[s:e, fixed - o:fixed - o + t] = WHITE
    return img


def label_pill(img, cx, cy, w=20, h=18):
    """An opaque label chip with its white letter punched through it."""
    x0, y0 = cx - w // 2, cy - h // 2
    img[y0:y0 + h, x0:x0 + w] = CHIP
    img[y0 + 4:y0 + h - 4, x0 + 8:x0 + 12] = WHITE      # the glyph
    return (x0, y0, x0 + w, y0 + h)


def wall(img, box, thickness=12):
    """A black structural wall bar."""
    x0, y0, x1, y1 = box
    img[y0:y1, x0:x1] = BLACK
    return C.mask_exact(img, BLACK, 2)


def objective(img, cx, cy, r=16):
    """The printed objective marker: a white annulus around a dark disc."""
    yy, xx = np.ogrid[:img.shape[0], :img.shape[1]]
    d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    img[d2 <= r ** 2] = WHITE
    img[d2 <= (r - 4) ** 2] = (60, 60, 60)
    return (cx - r, cy - r, cx + r, cy + r)


def no_ink(img):
    return np.zeros(img.shape[:2], bool)


# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

FAILURES = []


def check(name, ok, detail=''):
    print('%-4s %s%s' % ('ok' if ok else 'FAIL', name, ('  -- ' + detail) if detail else ''))
    if not ok:
        FAILURES.append(name)


def one_rect(name, boxes, want, tol=3):
    """Exactly one rectangle, within `tol` px of `want` on every side."""
    if len(boxes) != 1:
        check(name, False, 'expected 1 rectangle, got %d: %s' % (len(boxes), boxes))
        return None
    got = boxes[0]
    off = max(abs(g - w) for g, w in zip(got, want))
    check(name, off <= tol, 'want %s got %s (max side error %d px)' % (want, got, off))
    return got


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

# (dash, gap) in px. The cards are vector art at one scale, but the exact
# rhythm is not something the detector may depend on: a gate tuned to it is a
# gate that fails on the next killzone.
DASH_RHYTHMS = ((10, 6), (14, 14), (8, 4))


def test_recall_across_scale():
    """Every Volkus rubble piece is found, at every size and both rotations.

    This is the bug: the old segment-count gate fired on I and G (long
    perimeters) and missed J and K (short ones) on every card.
    """
    for label, size in sorted(PIECE_IN.items()):
        for rot in (False, True):
            for dash, gap in DASH_RHYTHMS:
                img = card()
                box = rect_px(300, 260, size, rot)
                dashed_outline(img, box, dash=dash, gap=gap)
                got = E.dashed_rects(img, no_ink(img), [])
                one_rect('recall %s %s dash %d/%d' % (
                    label, 'rotated' if rot else 'upright', dash, gap), got, box)


def test_pill_on_the_outline():
    """The label pill sits ON the outline, not inside it.

    It hides two to four consecutive dashes, and on a piece narrower than the
    pill it cuts the outline clean in two. Both arcs are still one rectangle.
    """
    for label in ('K', 'J', 'I'):
        size = PIECE_IN[label]
        box = rect_px(300, 260, size, rot=False)
        for where in ('middle', 'corner'):
            cx, cy = ((box[0] + box[2]) // 2, (box[1] + box[3]) // 2) if where == 'middle' \
                else (box[0], box[1])
            for dash, gap in DASH_RHYTHMS:
                img = card()
                dashed_outline(img, box, dash=dash, gap=gap)
                chip = label_pill(img, cx, cy)
                got = E.dashed_rects(img, no_ink(img), [chip])
                one_rect('pill on %s outline (%s) dash %d/%d' % (
                    label, where, dash, gap), got, box)


def test_objective_marker_on_the_outline():
    """A printed objective marker occludes the outline the same way a pill does."""
    img = card()
    box = rect_px(300, 260, PIECE_IN['K'])
    dashed_outline(img, box)
    mk = objective(img, (box[0] + box[2]) // 2, (box[1] + box[3]) // 2)
    got = E.dashed_rects(img, no_ink(img), [], [mk])
    one_rect('objective marker on the outline', got, box)


def test_two_rectangles_side_by_side():
    """Two pieces printed close together stay two rectangles.

    Closing the gaps along an edge must not also close the gap BETWEEN two
    pieces. 16px is 0.67" -- closer than any two dashed pieces on the cards.
    """
    for gap in (16, 24, 60):
        img = card()
        a = rect_px(240, 260, PIECE_IN['K'])
        b = (a[2] + gap, a[1], a[2] + gap + px(PIECE_IN['K'][0]), a[3])
        dashed_outline(img, a)
        dashed_outline(img, b)
        got = sorted(E.dashed_rects(img, no_ink(img), []))
        check('two rectangles %dpx apart stay separate' % gap, len(got) == 2, 'got %s' % (got,))


def test_doors_are_not_rectangles():
    """White dashes printed across a wall are doors (keys/VS2.png), not outlines."""
    img = card()
    ink = wall(img, (200, 200, 212, 340))
    for y in (240, 260, 280):
        img[y:y + 3, 200:212] = WHITE
    got = E.dashed_rects(img, ink, [])
    check('door dashes are not a rectangle', got == [], 'got %s' % (got,))


def test_open_and_partial_shapes_are_rejected():
    """A run of dashes, or a three-sided outline, is not a rectangle."""
    img = card()
    for i in range(6):
        img[260:263, 200 + i * 16:210 + i * 16] = WHITE
    check('a line of dashes is not a rectangle', E.dashed_rects(img, no_ink(img), []) == [],
          'got %s' % (E.dashed_rects(img, no_ink(img), []),))

    img = card()
    box = rect_px(300, 260, PIECE_IN['I'])
    dashed_outline(img, box)
    img[box[1] - 2:box[3] + 2, box[2] - 4:box[2] + 4] = GREEN      # rub out one long edge
    got = E.dashed_rects(img, no_ink(img), [])
    check('a three-sided outline is not a rectangle', got == [], 'got %s' % (got,))


def test_too_small_is_rejected():
    """Below half an inch a "rectangle" is print noise, not a piece."""
    img = card()
    box = (300, 260, 310, 270)
    dashed_outline(img, box, t=2, dash=4, gap=3)
    got = E.dashed_rects(img, no_ink(img), [])
    check('a sub-0.5" outline is rejected', got == [], 'got %s' % (got,))


def test_solid_outline_is_not_dashed():
    """D-014 turns on dashed vs solid: a solid outline means the piece sits on
    top of the raised level and its footprint comes from the green, so a solid
    rectangle must not be reported."""
    img = card()
    box = rect_px(300, 260, PIECE_IN['I'])
    x0, y0, x1, y1 = box
    img[y0:y0 + 3, x0:x1] = WHITE
    img[y1 - 3:y1, x0:x1] = WHITE
    img[y0:y1, x0:x0 + 3] = WHITE
    img[y0:y1, x1 - 3:x1] = WHITE
    got = E.dashed_rects(img, no_ink(img), [])
    check('a solid outline is not reported', got == [], 'got %s' % (got,))




# ---------------------------------------------------------------------------
# Close quarters: connector blocks, wall ends and the piece tiling
# ---------------------------------------------------------------------------
#
# The real Gallowdark / Tomb World cards are 702 x 608 px with a 94 px lattice step, a 9 px
# wall bar and a 27 px square block wherever a wall PIECE ends. These synthetic cards draw
# exactly that, and go straight at `_cq_blocks` / `_cq_lines` / `_cq_tile` with a hand-built
# `Frame` rather than through `calibrate()`, so they pin the wall detectors without also
# having to reproduce the printed lattice hairline the calibrator looks for.

CQ_STEP = 94
CQ_BAR = C.CQ_BAR_PX
CQ_BLOCK = C.CQ_BLOCK_PX
WALL_INK = C.PALETTE['wall_cq']
CROSS = C.PALETTE['wall_end_cq']
CQ_CHIP = C.PALETTE['label_cq']


def cq_card():
    """A blank close-quarters card, and the frame that reads it."""
    img = np.zeros((608, 702, 3), np.uint8)
    img[:, :] = (233, 204, 186)                    # p1 territory tint
    lx = [21.0 + i * CQ_STEP for i in range(C.CQ_NX + 1)]
    ly = [21.0 + j * CQ_STEP for j in range(C.CQ_NY + 1)]
    frame = C.Frame(x0=9.4, y0=8.6, ppi_x=CQ_STEP / C.CQ_SQUARE, ppi_y=CQ_STEP / C.CQ_SQUARE,
                    board_w=C.BOARD_CQ[0], board_h=C.BOARD_CQ[1], close_quarters=True,
                    lattice_x=lx, lattice_y=ly)
    return img, frame, lx, ly


def cq_bar(img, a, b):
    """A wall bar between two node centres."""
    (ax, ay), (bx, by) = a, b
    h = CQ_BAR // 2
    if ay == by:
        img[int(ay) - h:int(ay) + h + 1, int(min(ax, bx)):int(max(ax, bx)) + 1] = WALL_INK
    else:
        img[int(min(ay, by)):int(max(ay, by)) + 1, int(ax) - h:int(ax) + h + 1] = WALL_INK


def cq_block(img, c, end=False):
    """A connector post, or a wall end with the key's cross knocked out of it."""
    x, y = int(c[0]), int(c[1])
    h = CQ_BLOCK // 2
    img[y - h:y + h + 1, x - h:x + h + 1] = WALL_INK
    if not end:
        return
    for d in range(-11, 12):
        for t in (-1, 0, 1):
            img[y + d, x + d + t] = CROSS
            img[y + d, x - d + t] = CROSS


def cq_chip(img, cx, cy):
    img[int(cy) - 9:int(cy) + 9, int(cx) - 12:int(cx) + 12] = CQ_CHIP


def _tile(img, frame, chips):
    solid, blocks = E._cq_blocks(img, C.mask_exact(img, WALL_INK, 6), frame)
    lines = E._cq_lines(solid, blocks, CQ_STEP)
    return blocks, E._cq_tile(lines, chips, CQ_STEP)


def test_cq_blocks_are_found_and_wall_ends_told_apart():
    """A post is a post; a post with the key's cross in it is a WALL END."""
    img, frame, lx, ly = cq_card()
    a, b, c = (lx[1], ly[1]), (lx[3], ly[1]), (lx[3], ly[3])
    cq_bar(img, a, b)
    cq_bar(img, b, c)
    cq_block(img, a)
    cq_block(img, b)
    cq_block(img, c, end=True)
    # The dashed centre line is drawn in the same grey as the cross and must not be mistaken
    # for one: it is one pixel wide, and the cards really do print it across a card.
    img[40:560, 351] = CROSS
    solid, blocks = E._cq_blocks(img, C.mask_exact(img, WALL_INK, 6), frame)
    check('three blocks found', len(blocks) == 3, 'got %d' % len(blocks))
    kinds = sorted(bl['kind'] for bl in blocks)
    check('exactly one of them is a wall end', kinds == ['connector', 'connector', 'wallEnd'],
          'got %s' % (kinds,))
    ends = [bl for bl in blocks if bl['kind'] == 'wallEnd']
    if ends:
        off = max(abs(ends[0]['x'] - c[0]), abs(ends[0]['y'] - c[1]))
        check('the wall end sits on its node', off <= 1.0, 'off by %.1f px' % off)


def test_cq_pieces_are_tiled_by_their_printed_letters():
    """A block in the MIDDLE of a long wall belongs to the run that crosses there, not to it.

    This is the case that defeats cutting at every block: a two-square A-piece crossed by
    another run has a post at its own midpoint. Only the printed letter says whether the run
    is one A or two Bs, so the tiler is scored on consuming every letter exactly once.
    """
    img, frame, lx, ly = cq_card()
    # A horizontal A-piece from node 1 to node 3, crossed at node 2 by a vertical B-piece.
    cq_bar(img, (lx[1], ly[2]), (lx[3], ly[2]))
    cq_bar(img, (lx[2], ly[2]), (lx[2], ly[3]))
    for n in ((lx[1], ly[2]), (lx[2], ly[2]), (lx[3], ly[2]), (lx[2], ly[3])):
        cq_block(img, n)
    chips = [('A1', lx[2], ly[2] - 22), ('B1', lx[2] - 22, (ly[2] + ly[3]) / 2)]
    _blocks, segs = _tile(img, frame, chips)
    got = sorted((s['label'], s['span']) for s in segs)
    check('the long wall stays one A piece', got == [('A1', 2), ('B1', 1)], 'got %s' % (got,))


def test_cq_half_square_offset_piece_is_placed_where_it_is_printed():
    """Two pieces on the real cards are printed offset by half a square, not on a lattice line.

    `tomb-world-1`'s A2 and `tomb-world-6`'s B4. Snapping them to the nearest lattice line
    moved them ~1.9" and re-sized them; the blocks say exactly where they are.
    """
    img, frame, lx, ly = cq_card()
    a = (lx[2] + CQ_STEP / 2, ly[4])
    b = (lx[4] + CQ_STEP / 2, ly[4])
    cq_bar(img, a, b)
    cq_block(img, a)
    cq_block(img, b)
    chips = [('A2', (a[0] + b[0]) / 2, ly[4] - 22)]
    _blocks, segs = _tile(img, frame, chips)
    if len(segs) != 1:
        check('the offset piece is one two-square wall', False, 'got %d pieces' % len(segs))
        return
    seg = segs[0]
    off = max(abs(seg['a'][0] - a[0]), abs(seg['b'][0] - b[0]))
    check('the offset piece is one two-square wall',
          seg['span'] == 2 and seg['label'] == 'A2' and off <= 1.0,
          'got span=%s label=%s off=%.1f px' % (seg['span'], seg['label'], off))


def test_cq_dropped_run_leaves_its_printed_letter_behind():
    """A run the tiler cannot see leaves its letter unconsumed, and that is the alarm.

    A piece whose ends BOTH butt into the side of another wall carries no connector block, so
    it forms no chain and no feature — and nothing downstream can tell: there is no unlabelled
    segment for G4, and G3 only checks that a piece is not over-used. The printed letter left
    on the card is the only evidence, so it is counted and G10 fails on it.
    """
    img, frame, lx, ly = cq_card()
    for x in (lx[1], lx[3]):                          # two vertical A pieces with posts
        cq_bar(img, (x, ly[2]), (x, ly[4]))
        cq_block(img, (x, ly[2]))
        cq_block(img, (x, ly[4]))
    cq_bar(img, (lx[1], ly[3]), (lx[3], ly[3]))       # joined by a bar with no post at either end
    chips = [('A1', lx[1] - 22, ly[3]), ('A2', lx[3] + 22, ly[3]), ('A3', (lx[1] + lx[3]) / 2, ly[3] - 22)]
    _blocks, segs = _tile(img, frame, chips)
    consumed = {s['chip'] for s in segs if s['chip'] is not None}
    check('the dropped run leaves one letter unconsumed',
          len(chips) - len(consumed) == 1,
          'segs=%d consumed=%d of %d' % (len(segs), len(consumed), len(chips)))


def test_cq_run_that_butts_into_another_wall_still_ends_there():
    """A piece can end against the SIDE of another run, where the card prints no post."""
    img, frame, lx, ly = cq_card()
    cq_bar(img, (lx[1], ly[3]), (lx[5], ly[3]))       # a long horizontal run
    for n in ((lx[1], ly[3]), (lx[3], ly[3]), (lx[5], ly[3])):
        cq_block(img, n)
    cq_bar(img, (lx[2], ly[2]), (lx[2], ly[3]))       # butts into its side at node 2
    cq_block(img, (lx[2], ly[2]))
    chips = [('A1', lx[2], ly[3] - 22), ('A2', lx[4], ly[3] - 22),
             ('B1', lx[2] - 22, (ly[2] + ly[3]) / 2)]
    _blocks, segs = _tile(img, frame, chips)
    got = sorted((s['label'], s['span']) for s in segs)
    check('the butting piece is found and is one square',
          got == [('A1', 2), ('A2', 2), ('B1', 1)], 'got %s' % (got,))


def main():
    for fn in (test_recall_across_scale, test_pill_on_the_outline,
               test_objective_marker_on_the_outline, test_two_rectangles_side_by_side,
               test_doors_are_not_rectangles, test_open_and_partial_shapes_are_rejected,
               test_too_small_is_rejected, test_solid_outline_is_not_dashed,
               test_cq_blocks_are_found_and_wall_ends_told_apart,
               test_cq_pieces_are_tiled_by_their_printed_letters,
               test_cq_half_square_offset_piece_is_placed_where_it_is_printed,
               test_cq_run_that_butts_into_another_wall_still_ends_there,
               test_cq_dropped_run_leaves_its_printed_letter_behind):
        print('\n== %s' % fn.__name__)
        fn()
    print('\n%d failure(s)' % len(FAILURES))
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
