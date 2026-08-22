/**
 * Board viewport maths — PURE. No DOM, no Preact, no rules-core imports; numbers in,
 * numbers out, so every gesture is unit-testable without a browser.
 *
 * THREE coordinate spaces, and the difference between them is the whole point of this file:
 *
 * | space  | units  | origin              | +y   | who speaks it                          |
 * | ------ | ------ | ------------------- | ---- | -------------------------------------- |
 * | world  | inches | board bottom-left   | up   | `src/core/**`, operative positions      |
 * | view   | inches | board top-left      | down | the SVG `viewBox` window                |
 * | screen | CSS px | the browser viewport| down | `PointerEvent.clientX/Y`                |
 *
 * A `Viewport` is a **view-space** rectangle: it is literally the four numbers written into
 * `viewBox`. The world→view flip for *rendering* still happens exactly once, in `Board.tsx`'s
 * `worldTransform` — the renderer never calls anything here. The converters below exist only
 * to turn pointer input into world coordinates and back, and they are explicit about it:
 * anything named `…World` takes or returns y-up world inches, everything else is view space.
 *
 * The window is aspect-locked to its CONTAINER, not to the board. A 30x22 killzone drawn
 * into a portrait phone pane at the board's own aspect letterboxes to a third of the screen,
 * which is the single biggest thing that made the old board unusable on a phone; locking the
 * window to the pane instead means the board fills it and you pan. Pass `aspect` (pane width
 * / pane height, in the same units) to every function that takes `ViewLimits`; omit it and
 * everything falls back to the board's own aspect, which is the old behaviour exactly.
 *
 * `fitRect` still reproduces the letterboxing `preserveAspectRatio="xMidYMid meet"` produces,
 * because a pane can be mid-resize (or pre-layout) when a pointer event arrives.
 */

export interface Viewport {
  /** Left edge of the visible window, view space (inches from the board's left edge). */
  x: number;
  /** Top edge of the visible window, view space (inches DOWN from the board's top edge). */
  y: number;
  w: number;
  h: number;
}

/** Board extents in inches. `KillzoneMap['board']` is assignable to this. */
export interface BoardSize {
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** The subset of `DOMRect` this module needs — passing a real `DOMRect` works. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Most-zoomed-in state: how few inches of the board's SHORT side may fill the viewport.
 * A 25 mm base is ~0.98"; at 9" of a 22" board on a 375 px-wide phone that base draws about
 * 30 px across, which is a comfortable touch target. Zooming further just wastes screen.
 */
export const MIN_SPAN_IN = 9;

/** How far past the board edge a pan may drift, inches. 0 = the window stays on the board. */
export const DEFAULT_OVERSCAN_IN = 0;

/**
 * The knobs every viewport function shares. `aspect` is the CONTAINER's width/height ratio;
 * omitted, the window keeps the board's own aspect and the maths is exactly what it was
 * before the pane-aspect lock existed.
 */
export interface ViewLimits {
  minSpanIn?: number;
  maxOverscanIn?: number;
  /** View-space width per unit of view-space height. Defaults to the board's own aspect. */
  aspect?: number;
}

const aspectOf = (board: BoardSize, limits: ViewLimits = {}): number => {
  const a = limits.aspect;
  return a !== undefined && Number.isFinite(a) && a > 0 ? a : board.w / board.h;
};

/**
 * `board.h * (board.w / board.h)` is 29.999999999999996 for a 30x22 killzone, and that ulp
 * leaks straight into "is the whole board on screen?". Snap it back when it is the board.
 */
const snapToBoard = (v: number, boardW: number): number => (Math.abs(v - boardW) < 1e-9 ? boardW : v);

// `-0` is a legal clamp result and renders fine, but it breaks value equality in tests and
// in any memo that compares viewports, so it is normalised away at the one place it appears.
const clamp = (v: number, lo: number, hi: number): number => {
  const c = v < lo ? lo : v > hi ? hi : v;
  return c === 0 ? 0 : c;
};
const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/**
 * The window that shows the WHOLE board inside a pane of this aspect. On a pane shaped like
 * the board that is the board itself; on a portrait phone it is wider than the board, and the
 * spare inches are the letterbox bars you accept in exchange for seeing everything at once.
 */
export function fitViewport(board: BoardSize, limits: ViewLimits = {}): Viewport {
  const aspect = aspectOf(board, limits);
  const w = maxViewportWidth(board, limits);
  return centred(w, w / aspect, board);
}

/**
 * The window that FILLS a pane of this aspect with board and nothing else: the board's short
 * side against the pane's short side, the long side cropped and pannable. This is the phone's
 * resting framing — no dead bars, and an operative base draws at a size a thumb can hit.
 */
export function fillViewport(board: BoardSize, limits: ViewLimits = {}): Viewport {
  const aspect = aspectOf(board, limits);
  const cover = Math.min(board.w, snapToBoard(board.h * aspect, board.w));
  const w = clamp(cover, minViewportWidth(board, limits), maxViewportWidth(board, limits));
  return centred(w, w / aspect, board);
}

/** A window of this size, centred on the board — the only sane place to put one that fits. */
function centred(w: number, h: number, board: BoardSize): Viewport {
  const x = (board.w - w) / 2;
  const y = (board.h - h) / 2;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, w, h };
}

/** Widest legal window: the one that just contains the whole board at this aspect. */
export function maxViewportWidth(board: BoardSize, limits: ViewLimits = {}): number {
  return Math.max(board.w, snapToBoard(board.h * aspectOf(board, limits), board.w));
}

/**
 * Narrowest legal window width for this board (the most-zoomed-in state).
 *
 * The floor is "do not zoom in past `minSpanIn` inches on the window's short side" — but it
 * must never come out WIDER than the fill window, or the clamp starts pushing the window
 * bigger than the board. That is not hypothetical: a phone in landscape with the sheet up
 * leaves a pane about 10:1, where `minSpanIn * aspect` is 86" of a 30" board, and the board
 * was forced out to 50% zoom with the killzone a strip in the middle.
 */
export function minViewportWidth(board: BoardSize, limits: ViewLimits | number = {}): number {
  const opts: ViewLimits = typeof limits === 'number' ? { minSpanIn: limits } : limits;
  const aspect = aspectOf(board, opts);
  const minSpanIn = opts.minSpanIn ?? MIN_SPAN_IN;
  // The short side of the WINDOW is the one that must not fall below `minSpanIn`.
  const byShortSide = minSpanIn * Math.max(1, aspect);
  const cover = Math.min(board.w, snapToBoard(board.h * aspect, board.w));
  return Math.min(maxViewportWidth(board, opts), cover, byShortSide);
}

/**
 * Force a window to be legal: aspect-locked to the board, no wider than the board, no
 * narrower than `minViewportWidth`, and positioned so at most `maxOverscanIn` of empty
 * space shows past an edge. This is what stops the board being lost off screen.
 */
export function clampViewport(vp: Viewport, board: BoardSize, limits: ViewLimits = {}): Viewport {
  const aspect = aspectOf(board, limits);
  const minW = minViewportWidth(board, limits);
  const maxW = maxViewportWidth(board, limits);
  const w = clamp(finite(vp.w, maxW), minW, maxW);
  const h = w / aspect;
  const over = Math.max(0, finite(limits.maxOverscanIn ?? DEFAULT_OVERSCAN_IN, 0));
  // A window larger than the board in an axis has nowhere to pan in it: centre it, so the
  // letterbox bars a tall pane forces are split evenly instead of piling up on one edge.
  const x = w >= board.w ? (board.w - w) / 2 : clamp(finite(vp.x, 0), -over, board.w - w + over);
  const y = h >= board.h ? (board.h - h) / 2 : clamp(finite(vp.y, 0), -over, board.h - h + over);
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, w, h };
}

/**
 * The window that frames a WORLD-space rectangle (y-up) with `padIn` inches of breathing
 * room — what "show me my drop zone" and "show me where this operative can go" compile to.
 * The result is a legal viewport, so a rect larger than the board just fits the board.
 */
export function frameRect(
  rect: { x: number; y: number; w: number; h: number },
  board: BoardSize,
  limits: ViewLimits = {},
  padIn = 1,
): Viewport {
  const aspect = aspectOf(board, limits);
  const pad = Math.max(0, finite(padIn, 0));
  // Cap the padded rect at the board. A 6x22 drop zone padded by 1.5" asks for 25" of a 22"
  // board, and the extra 3" come back as letterbox bars — the exact thing the pane-aspect
  // lock exists to remove.
  const wantW = Math.min(board.w, Math.max(0, finite(rect.w, 0)) + pad * 2);
  const wantH = Math.min(board.h, Math.max(0, finite(rect.h, 0)) + pad * 2);
  // Widen to whichever dimension does not fit, so the whole rect is inside the window.
  // Clamp the width to the legal range FIRST: widening it afterwards (which the zoom limit
  // does for a small rect) would slide the rect off the centre of the window.
  //
  // The ceiling is the FILL width, not the fit width. Framing is "point the camera at this";
  // if a large rect were allowed to zoom out past fill, the pane would letterbox and the
  // black bars this whole model exists to remove would come back. Asking to frame more than
  // fits simply frames as much as fits.
  const w = clamp(
    Math.max(wantW, wantH * aspect),
    minViewportWidth(board, limits),
    Math.max(minViewportWidth(board, limits), fillViewport(board, limits).w),
  );
  const h = w / aspect;
  const cx = finite(rect.x, 0) + finite(rect.w, 0) / 2;
  const cy = board.h - (finite(rect.y, 0) + finite(rect.h, 0) / 2); // world y-up -> view y-down
  return clampViewport({ x: cx - w / 2, y: cy - h / 2, w, h }, board, limits);
}

/** The world-space bounding box of a set of polygons (or points), or null when empty. */
export function boundsOf(polys: readonly (readonly Pt[])[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const pt of poly) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Magnification relative to fit-to-board: 1 = the whole board, 2 = half of it. */
export function zoomOf(vp: Viewport, board: BoardSize): number {
  return vp.w > 0 ? board.w / vp.w : 1;
}

/** Largest magnification this board allows. */
export function maxZoom(board: BoardSize, limits: ViewLimits | number = {}): number {
  const opts: ViewLimits = typeof limits === 'number' ? { minSpanIn: limits } : limits;
  return board.w / minViewportWidth(board, opts);
}

/** True when the whole board is on screen (one-finger drag then pans nothing). */
export function isFitViewport(vp: Viewport, board: BoardSize, limits: ViewLimits = {}): boolean {
  return vp.w >= maxViewportWidth(board, limits) - 1e-6;
}

/* --- space conversions ---------------------------------------------------- */

/** World (y-up, origin bottom-left) → view (y-down, origin top-left). */
export function worldToView(p: Pt, boardH: number): Pt {
  return { x: p.x, y: boardH - p.y };
}

/** View (y-down) → world (y-up). Same arithmetic; named for the reader, not the compiler. */
export function viewToWorld(p: Pt, boardH: number): Pt {
  return { x: p.x, y: boardH - p.y };
}

/**
 * Where the viewBox actually lands inside the element, given
 * `preserveAspectRatio="xMidYMid meet"`: the window is scaled to fit and centred, so when the
 * element is not the board's aspect there are letterbox bars that pointer maths must skip.
 * `scale` is screen px per view inch; 0 means the element has no size yet (pre-layout/jsdom).
 */
export function fitRect(rect: ScreenRect, vp: Viewport): { scale: number; left: number; top: number } {
  if (rect.width <= 0 || rect.height <= 0 || vp.w <= 0 || vp.h <= 0) {
    return { scale: 0, left: rect.left, top: rect.top };
  }
  const scale = Math.min(rect.width / vp.w, rect.height / vp.h);
  return {
    scale,
    left: rect.left + (rect.width - vp.w * scale) / 2,
    top: rect.top + (rect.height - vp.h * scale) / 2,
  };
}

/** Screen px per view inch for the current window (0 before layout). */
export function pixelsPerInch(rect: ScreenRect, vp: Viewport): number {
  return fitRect(rect, vp).scale;
}

/** Screen point (client coords) → view space. */
export function screenToView(pt: Pt, rect: ScreenRect, vp: Viewport): Pt {
  const f = fitRect(rect, vp);
  if (f.scale <= 0) return { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 };
  return { x: vp.x + (pt.x - f.left) / f.scale, y: vp.y + (pt.y - f.top) / f.scale };
}

/** View space → screen point (client coords). */
export function viewToScreen(pt: Pt, rect: ScreenRect, vp: Viewport): Pt {
  const f = fitRect(rect, vp);
  if (f.scale <= 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return { x: f.left + (pt.x - vp.x) * f.scale, y: f.top + (pt.y - vp.y) * f.scale };
}

/** Screen point → WORLD inches (y-up). This is what a board tap means. */
export function screenToWorld(pt: Pt, rect: ScreenRect, vp: Viewport, boardH: number): Pt {
  return viewToWorld(screenToView(pt, rect, vp), boardH);
}

/** WORLD inches (y-up) → screen point. */
export function worldToScreen(world: Pt, rect: ScreenRect, vp: Viewport, boardH: number): Pt {
  return viewToScreen(worldToView(world, boardH), rect, vp);
}

/* --- gestures ------------------------------------------------------------- */

/** Resize about a view-space anchor without clamping the position (internal composition step). */
function resizeAbout(vp: Viewport, board: BoardSize, factor: number, anchor: Pt, limits: ViewLimits): Viewport {
  const aspect = aspectOf(board, limits);
  const minW = minViewportWidth(board, limits);
  const f = factor > 0 && Number.isFinite(factor) ? factor : 1;
  const w = clamp(vp.w / f, minW, maxViewportWidth(board, limits));
  const h = w / aspect;
  // Keep the anchor at the same fraction of the window, i.e. the same place on screen.
  const rx = vp.w > 0 ? (anchor.x - vp.x) / vp.w : 0.5;
  const ry = vp.h > 0 ? (anchor.y - vp.y) / vp.h : 0.5;
  return { x: anchor.x - rx * w, y: anchor.y - ry * h, w, h };
}

/** Zoom by `factor` (>1 zooms in) keeping the VIEW-space point `anchor` under the cursor. */
export function zoomAtView(vp: Viewport, board: BoardSize, factor: number, anchor: Pt, limits: ViewLimits = {}): Viewport {
  return clampViewport(resizeAbout(vp, board, factor, anchor, limits), board, limits);
}

/**
 * Zoom by `factor` (>1 zooms in) about a fixed WORLD point — so wheel and pinch both feel
 * anchored under the finger instead of jumping to the centre. Near an edge the clamp wins,
 * which is the one case where the anchor drifts.
 */
export function zoomAt(vp: Viewport, board: BoardSize, factor: number, anchorWorld: Pt, limits: ViewLimits = {}): Viewport {
  return zoomAtView(vp, board, factor, worldToView(anchorWorld, board.h), limits);
}

/**
 * Move the window. Deltas are VIEW space (x right, y **down** — screen orientation), because
 * every caller derives them from pointer movement: a finger dragged right by D inches is
 * `panBy(vp, board, -D, 0)`, since dragging the content right moves the window left.
 */
export function panBy(vp: Viewport, board: BoardSize, dxIn: number, dyIn: number, limits: ViewLimits = {}): Viewport {
  return clampViewport({ ...vp, x: vp.x + finite(dxIn, 0), y: vp.y + finite(dyIn, 0) }, board, limits);
}

/**
 * One two-finger update, start-anchored: `vp` is the viewport as it was when the second
 * finger landed, and both touch pairs are in the VIEW space of THAT viewport (convert with
 * `screenToView(pt, startRect, startVp)`). Anchoring to the start rather than integrating
 * frame-to-frame deltas is what stops a pinch from drifting.
 *
 * The pinch scales by the change in finger separation about the starting midpoint, then pans
 * so that midpoint follows the fingers. The pan is divided by the *effective* zoom factor
 * because a screen distance is worth fewer view inches once you have zoomed in — without
 * that, a pinch that hits the zoom limit keeps sliding.
 */
export function pinch(
  vp: Viewport,
  board: BoardSize,
  startTouches: readonly [Pt, Pt],
  currentTouches: readonly [Pt, Pt],
  limits: ViewLimits = {},
): Viewport {
  const d0 = Math.hypot(startTouches[1].x - startTouches[0].x, startTouches[1].y - startTouches[0].y);
  const d1 = Math.hypot(currentTouches[1].x - currentTouches[0].x, currentTouches[1].y - currentTouches[0].y);
  const factor = d0 > 1e-6 ? d1 / d0 : 1;
  const mid0 = { x: (startTouches[0].x + startTouches[1].x) / 2, y: (startTouches[0].y + startTouches[1].y) / 2 };
  const mid1 = {
    x: (currentTouches[0].x + currentTouches[1].x) / 2,
    y: (currentTouches[0].y + currentTouches[1].y) / 2,
  };
  const zoomed = resizeAbout(vp, board, factor, mid0, limits);
  const effective = zoomed.w > 0 ? vp.w / zoomed.w : 1;
  return clampViewport(
    { ...zoomed, x: zoomed.x - (mid1.x - mid0.x) / effective, y: zoomed.y - (mid1.y - mid0.y) / effective },
    board,
    limits,
  );
}
