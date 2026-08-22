/**
 * Pan/zoom maths. These are the invariants the gesture layer in `Board.tsx` leans on:
 * the window can never be lost off screen, a zoom stays under the finger, a pinch is
 * reproducible, and a tap round-trips to the same world point at any zoom.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_SPAN_IN,
  boundsOf,
  clampViewport,
  fillViewport,
  fitViewport,
  frameRect,
  maxViewportWidth,
  isFitViewport,
  maxZoom,
  minViewportWidth,
  panBy,
  pinch,
  pixelsPerInch,
  screenToView,
  screenToWorld,
  viewToWorld,
  worldToScreen,
  worldToView,
  zoomAt,
  zoomOf,
  type ScreenRect,
  type Viewport,
} from '../src/ui/boardView.ts';

/** Every KT24 killzone is 30" × 22". */
const BOARD = { w: 30, h: 22 };
/** A phone-shaped element: much taller than the board, so the fit letterboxes vertically. */
const PHONE: ScreenRect = { left: 0, top: 60, width: 375, height: 500 };
/** A wide element, so the fit letterboxes horizontally instead. */
const WIDE: ScreenRect = { left: 20, top: 0, width: 1000, height: 400 };

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('clampViewport keeps the board on screen', () => {
  it('never lets the window grow past the board', () => {
    const vp = clampViewport({ x: -10, y: -10, w: 100, h: 90 }, BOARD);
    expect(vp).toEqual({ x: 0, y: 0, w: 30, h: 22 });
    expect(isFitViewport(vp, BOARD)).toBe(true);
  });

  it('never lets the window shrink past the tappable minimum', () => {
    const vp = clampViewport({ x: 5, y: 5, w: 0.2, h: 0.15 }, BOARD);
    close(vp.w, minViewportWidth(BOARD));
    // The SHORT side is the one held at the minimum span.
    close(Math.min(vp.w, vp.h), MIN_SPAN_IN);
    expect(zoomOf(vp, BOARD)).toBeLessThanOrEqual(maxZoom(BOARD) + 1e-9);
  });

  it('stays aspect-locked to the board, so the letterboxing never changes', () => {
    for (const w of [30, 21, 13.7, minViewportWidth(BOARD)]) {
      const vp = clampViewport({ x: 3, y: 2, w, h: 1 }, BOARD);
      close(vp.w / vp.h, BOARD.w / BOARD.h, 1e-9);
    }
  });

  it('pins a panned-off window back onto the board at both ends', () => {
    const zoomed = clampViewport({ x: 0, y: 0, w: 12, h: 1 }, BOARD);
    const left = clampViewport({ ...zoomed, x: -99, y: -99 }, BOARD);
    expect(left.x).toBe(0);
    expect(left.y).toBe(0);
    const right = clampViewport({ ...zoomed, x: 99, y: 99 }, BOARD);
    close(right.x, BOARD.w - zoomed.w);
    close(right.y, BOARD.h - zoomed.h);
  });

  it('honours an overscan allowance when one is asked for', () => {
    const vp = clampViewport({ x: -99, y: -99, w: 12, h: 1 }, BOARD, { maxOverscanIn: 2 });
    expect(vp.x).toBe(-2);
    expect(vp.y).toBe(-2);
  });

  it('survives NaN without producing a broken viewBox', () => {
    const vp = clampViewport({ x: NaN, y: NaN, w: NaN, h: NaN }, BOARD);
    expect(Object.values(vp).every(Number.isFinite)).toBe(true);
  });
});

describe('zoomAt is anchored, not centred', () => {
  it('leaves the anchored world point exactly where it was on screen', () => {
    const anchor = { x: 21, y: 6 }; // world inches, well clear of every edge
    let vp: Viewport = fitViewport(BOARD);
    const before = worldToScreen(anchor, PHONE, vp, BOARD.h);
    for (const factor of [1.2, 1.2, 1.35]) {
      vp = zoomAt(vp, BOARD, factor, anchor);
      const after = worldToScreen(anchor, PHONE, vp, BOARD.h);
      close(after.x, before.x, 1e-6);
      close(after.y, before.y, 1e-6);
    }
    expect(zoomOf(vp, BOARD)).toBeGreaterThan(1.9);
  });

  it('zooming out again returns to the fit window', () => {
    const anchor = { x: 12, y: 9 };
    const inThen = zoomAt(fitViewport(BOARD), BOARD, 2, anchor);
    const out = zoomAt(inThen, BOARD, 0.5, anchor);
    expect(out).toEqual(fitViewport(BOARD));
  });

  it('cannot escape the zoom range however hard it is pushed', () => {
    let vp = fitViewport(BOARD);
    for (let i = 0; i < 40; i++) vp = zoomAt(vp, BOARD, 2, { x: 15, y: 11 });
    close(zoomOf(vp, BOARD), maxZoom(BOARD));
    for (let i = 0; i < 40; i++) vp = zoomAt(vp, BOARD, 0.5, { x: 15, y: 11 });
    expect(vp).toEqual(fitViewport(BOARD));
    expect(zoomOf(vp, BOARD)).toBe(1);
  });

  it('reads the anchor as WORLD space, so +y is up the board', () => {
    // The bottom-left corner of the world is the BOTTOM-left of the viewBox window.
    const vp = zoomAt(fitViewport(BOARD), BOARD, 3, { x: 0, y: 0 });
    expect(vp.x).toBe(0);
    close(vp.y, BOARD.h - vp.h);
  });
});

describe('panBy', () => {
  it('moves the window in view space and clamps at the edge', () => {
    const zoomed = clampViewport({ x: 10, y: 6, w: 15, h: 1 }, BOARD);
    const moved = panBy(zoomed, BOARD, 2, -1);
    close(moved.x, 12);
    close(moved.y, 5);
    expect(panBy(zoomed, BOARD, -999, -999)).toEqual({ ...zoomed, x: 0, y: 0 });
  });

  it('does nothing at fit, because the whole board is already visible', () => {
    expect(panBy(fitViewport(BOARD), BOARD, 5, 5)).toEqual(fitViewport(BOARD));
  });
});

describe('pinch', () => {
  it('reproduces a known transform: fingers 5" apart pulled to 10" halves the window', () => {
    const start = fitViewport(BOARD);
    // View-space touches of the STARTING window, symmetric about (15, 11).
    const a0 = { x: 12.5, y: 11 };
    const b0 = { x: 17.5, y: 11 };
    const vp = pinch(start, BOARD, [a0, b0], [{ x: 10, y: 11 }, { x: 20, y: 11 }]);
    close(vp.w, 15);
    close(vp.h, 11);
    // The midpoint did not move, so the window stays centred on it.
    close(vp.x, 7.5);
    close(vp.y, 5.5);
  });

  it('translates with the fingers when the separation does not change', () => {
    const zoomed = clampViewport({ x: 8, y: 5, w: 15, h: 1 }, BOARD);
    const drag = { x: -3, y: 2 };
    const a0 = { x: 12, y: 8 };
    const b0 = { x: 18, y: 12 };
    const vp = pinch(zoomed, BOARD, [a0, b0], [
      { x: a0.x + drag.x, y: a0.y + drag.y },
      { x: b0.x + drag.x, y: b0.y + drag.y },
    ]);
    close(vp.w, zoomed.w);
    close(vp.x, zoomed.x - drag.x);
    close(vp.y, zoomed.y - drag.y);
  });

  it('keeps the pinched midpoint under the fingers while it also moves', () => {
    const start = clampViewport({ x: 6, y: 4, w: 18, h: 1 }, BOARD);
    const a0 = { x: 11, y: 9 };
    const b0 = { x: 17, y: 9 };
    const a1 = { x: 11, y: 8 };
    const b1 = { x: 19, y: 8 };
    const vp = pinch(start, BOARD, [a0, b0], [a1, b1]);
    const factor = 8 / 6; // separation 6" → 8", short of the zoom limit
    close(vp.w, start.w / factor);
    // The world point that began under the midpoint must now sit under the new midpoint.
    const mid0World = viewToWorld({ x: 14, y: 9 }, BOARD.h);
    const before = worldToScreen(mid0World, PHONE, start, BOARD.h);
    const after = worldToScreen(mid0World, PHONE, vp, BOARD.h);
    const scale = pixelsPerInch(PHONE, start);
    close(after.x - before.x, (15 - 14) * scale, 1e-6);
    close(after.y - before.y, (8 - 9) * scale, 1e-6);
  });

  it('never escapes the board or the zoom range, however wild the fingers', () => {
    const start = fitViewport(BOARD);
    const vp = pinch(start, BOARD, [{ x: 14, y: 11 }, { x: 16, y: 11 }], [
      { x: -400, y: 900 },
      { x: 800, y: -300 },
    ]);
    expect(vp.x).toBeGreaterThanOrEqual(0);
    expect(vp.y).toBeGreaterThanOrEqual(0);
    expect(vp.x + vp.w).toBeLessThanOrEqual(BOARD.w + 1e-9);
    expect(vp.y + vp.h).toBeLessThanOrEqual(BOARD.h + 1e-9);
    expect(zoomOf(vp, BOARD)).toBeGreaterThanOrEqual(1);
    expect(zoomOf(vp, BOARD)).toBeLessThanOrEqual(maxZoom(BOARD) + 1e-9);
  });
});

describe('screen ↔ world', () => {
  it('round-trips to within 0.01" at every zoom, on both letterbox orientations', () => {
    const windows: Viewport[] = [
      fitViewport(BOARD),
      clampViewport({ x: 4, y: 3, w: 18, h: 1 }, BOARD),
      clampViewport({ x: 12, y: 8, w: 0, h: 0 }, BOARD),
    ];
    for (const rect of [PHONE, WIDE]) {
      for (const vp of windows) {
        for (const world of [{ x: 15, y: 11 }, { x: 13, y: 9.5 }, { x: 12.5, y: 8.25 }]) {
          const screen = worldToScreen(world, rect, vp, BOARD.h);
          const back = screenToWorld(screen, rect, vp, BOARD.h);
          close(back.x, world.x, 0.01);
          close(back.y, world.y, 0.01);
        }
      }
    }
  });

  it('accounts for the letterbox bars preserveAspectRatio leaves', () => {
    const vp = fitViewport(BOARD);
    // PHONE is 375×500 for a 30×22 board: it fits to width, so the board draws 375×275
    // with 112.5px bars top and bottom. The centre of the ELEMENT is the centre of the board.
    const mid = screenToWorld({ x: 0 + 375 / 2, y: 60 + 500 / 2 }, PHONE, vp, BOARD.h);
    close(mid.x, 15, 1e-9);
    close(mid.y, 11, 1e-9);
    // The very top of the element is above the board, i.e. off the top edge in world terms.
    const above = screenToWorld({ x: 187.5, y: 60 }, PHONE, vp, BOARD.h);
    expect(above.y).toBeGreaterThan(BOARD.h);
  });

  it('is the y-flip and nothing else between view and world', () => {
    const vp = fitViewport(BOARD);
    const v = screenToView({ x: 187.5, y: 60 + 500 / 2 }, PHONE, vp);
    close(v.x, 15, 1e-9);
    close(v.y, 11, 1e-9);
    expect(worldToView({ x: 3, y: 4 }, BOARD.h)).toEqual({ x: 3, y: 18 });
    expect(viewToWorld({ x: 3, y: 18 }, BOARD.h)).toEqual({ x: 3, y: 4 });
  });

  it('degrades safely before layout, when the element has no size', () => {
    const vp = fitViewport(BOARD);
    const p = screenToWorld({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }, vp, BOARD.h);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(pixelsPerInch({ left: 0, top: 0, width: 0, height: 0 }, vp)).toBe(0);
  });
});

describe('zoom range is usable on a phone', () => {
  it('magnifies enough that a 25mm base is a comfortable target', () => {
    const tightest = clampViewport({ x: 0, y: 0, w: 0, h: 0 }, BOARD);
    const baseIn = 25 / 25.4;
    const px = baseIn * pixelsPerInch(PHONE, tightest);
    expect(px).toBeGreaterThanOrEqual(24); // ≥ 24px across — tappable with a finger
    expect(Math.min(tightest.w, tightest.h)).toBeGreaterThanOrEqual(8);
    expect(Math.min(tightest.w, tightest.h)).toBeLessThanOrEqual(10);
  });
});


/**
 * The pane-aspect lock. A 30x22 killzone rendered at its own aspect into a portrait phone
 * pane letterboxes to a third of the screen — the defect that made the board unusable on a
 * phone. Locking the window to the pane instead is what these pin.
 */
describe('the window is aspect-locked to its container', () => {
  /** A phone pane with the command sheet at its resting detent: tall and narrow. */
  const PORTRAIT = { aspect: 390 / 620 };
  const LANDSCAPE = { aspect: 844 / 390 };

  it('fills a portrait pane with board, edge to edge, with nothing left over', () => {
    const vp = fillViewport(BOARD, PORTRAIT);
    close(vp.w / vp.h, PORTRAIT.aspect, 1e-9);
    // The short side of the board (22") is what a portrait pane can show in full.
    close(vp.h, BOARD.h, 1e-9);
    expect(vp.w).toBeLessThan(BOARD.w);
    // …and it is centred, so the same amount of board is cropped off either end.
    close(vp.x, (BOARD.w - vp.w) / 2, 1e-9);
  });

  it('fills a landscape pane the other way round', () => {
    const vp = fillViewport(BOARD, LANDSCAPE);
    close(vp.w / vp.h, LANDSCAPE.aspect, 1e-9);
    close(vp.w, BOARD.w, 1e-9);
    expect(vp.h).toBeLessThanOrEqual(BOARD.h + 1e-9);
  });

  it('still fits the WHOLE board when asked, letterboxing rather than cropping', () => {
    const vp = fitViewport(BOARD, PORTRAIT);
    close(vp.w / vp.h, PORTRAIT.aspect, 1e-9);
    // Everything is inside the window…
    expect(vp.x).toBeLessThanOrEqual(0 + 1e-9);
    expect(vp.y).toBeLessThanOrEqual(0 + 1e-9);
    expect(vp.x + vp.w).toBeGreaterThanOrEqual(BOARD.w - 1e-9);
    expect(vp.y + vp.h).toBeGreaterThanOrEqual(BOARD.h - 1e-9);
    // …and that is the most zoomed-out the clamp allows.
    expect(isFitViewport(vp, BOARD, PORTRAIT)).toBe(true);
    close(clampViewport({ x: 0, y: 0, w: 999, h: 999 }, BOARD, PORTRAIT).w, vp.w, 1e-9);
  });

  it('centres the axis that has nowhere to pan instead of pinning it to an edge', () => {
    const vp = clampViewport({ x: -500, y: -500, w: maxViewportWidth(BOARD, PORTRAIT), h: 1 }, BOARD, PORTRAIT);
    close(vp.x + vp.w / 2, BOARD.w / 2, 1e-9);
    close(vp.y + vp.h / 2, BOARD.h / 2, 1e-9);
  });

  it('pans along the cropped axis and refuses to pan along the filled one', () => {
    const vp = fillViewport(BOARD, PORTRAIT);
    const right = panBy(vp, BOARD, 99, 99, PORTRAIT);
    close(right.x, BOARD.w - vp.w, 1e-9); // panned to the right-hand edge…
    close(right.y, vp.y, 1e-9); //            …and not a hair vertically.
  });

  it('defaults to the board\'s own aspect, so every old call means what it always did', () => {
    expect(fitViewport(BOARD)).toEqual({ x: 0, y: 0, w: 30, h: 22 });
    expect(fillViewport(BOARD)).toEqual({ x: 0, y: 0, w: 30, h: 22 });
    close(maxViewportWidth(BOARD), BOARD.w, 1e-9);
  });

  it('keeps a 25mm base tappable at the tightest zoom on a portrait pane', () => {
    const pane: ScreenRect = { left: 0, top: 0, width: 390, height: 620 };
    const tightest = clampViewport({ x: 0, y: 0, w: 0, h: 0 }, BOARD, { aspect: 390 / 620 });
    const px = (25 / 25.4) * pixelsPerInch(pane, tightest);
    expect(px).toBeGreaterThanOrEqual(24);
  });
});

describe('frameRect points the board at what matters', () => {
  const PORTRAIT = { aspect: 390 / 620 };
  /** A drop zone: a 6"-wide strip up the left-hand edge, in WORLD coords (y-up). */
  const DROP_ZONE = { x: 0, y: 0, w: 6, h: 22 };

  const containsWorld = (vp: Viewport, x: number, y: number) => {
    const vy = BOARD.h - y;
    return x >= vp.x - 1e-6 && x <= vp.x + vp.w + 1e-6 && vy >= vp.y - 1e-6 && vy <= vp.y + vp.h + 1e-6;
  };

  it('puts the whole rect on screen', () => {
    const vp = frameRect(DROP_ZONE, BOARD, PORTRAIT, 1);
    for (const [x, y] of [[0, 0], [6, 0], [0, 22], [6, 22]] as const) {
      expect(containsWorld(vp, x, y)).toBe(true);
    }
  });

  it('zooms in on a small rect instead of showing the whole board', () => {
    const vp = frameRect({ x: 14, y: 10, w: 2, h: 2 }, BOARD, PORTRAIT, 1);
    expect(vp.w).toBeLessThan(fillViewport(BOARD, PORTRAIT).w);
    close(vp.x + vp.w / 2, 15, 1e-6);
    close(BOARD.h - (vp.y + vp.h / 2), 11, 1e-6);
  });

  it('never asks to see past the board edge, so a full-height rect draws no bars', () => {
    // A drop zone is 6" x 22" — the board's whole height. Padding it vertically would demand
    // 25" of a 22" board, and those 3" come back as letterbox bars.
    const vp = frameRect(DROP_ZONE, BOARD, PORTRAIT, 1.5);
    close(vp.y, 0, 1e-9);
    close(vp.h, BOARD.h, 1e-9);
    expect(vp.y + vp.h).toBeLessThanOrEqual(BOARD.h + 1e-9);
  });

  it('never zooms out past fill, so a framing request can never letterbox', () => {
    // Framing means "point the camera at this". Asking for more than fits frames as much as
    // fits — it does not fall back to the fit window, which on a portrait pane would bring
    // back the black bars the whole model exists to remove.
    const huge = frameRect({ x: -50, y: -50, w: 500, h: 500 }, BOARD, PORTRAIT, 1);
    close(huge.w, fillViewport(BOARD, PORTRAIT).w, 1e-9);
    expect(isFitViewport(huge, BOARD, PORTRAIT)).toBe(false);
    expect(huge.y).toBeGreaterThanOrEqual(-1e-9);
    expect(huge.y + huge.h).toBeLessThanOrEqual(BOARD.h + 1e-9);
  });

  it('returns a legal window for a degenerate rect', () => {
    const empty = frameRect({ x: 15, y: 11, w: 0, h: 0 }, BOARD, PORTRAIT, 0);
    expect(Number.isFinite(empty.x) && Number.isFinite(empty.w)).toBe(true);
    expect(empty.w).toBeGreaterThan(0);
  });

  it('survives NaN without producing a NaN window', () => {
    const vp = frameRect({ x: NaN, y: NaN, w: NaN, h: NaN }, BOARD, PORTRAIT, NaN);
    for (const v of [vp.x, vp.y, vp.w, vp.h]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('boundsOf', () => {
  it('boxes a set of polygons', () => {
    expect(
      boundsOf([
        [
          { x: 1, y: 2 },
          { x: 5, y: 2 },
        ],
        [{ x: 3, y: 9 }],
      ]),
    ).toEqual({ x: 1, y: 2, w: 4, h: 7 });
  });

  it('is null for nothing, and ignores non-finite points', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([[]])).toBeNull();
    expect(boundsOf([[{ x: NaN, y: 1 }, { x: 2, y: 3 }]])).toEqual({ x: 2, y: 3, w: 0, h: 0 });
  });
});
