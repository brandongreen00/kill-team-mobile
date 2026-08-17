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
 * The window is aspect-locked to the board, so the letterboxing produced by
 * `preserveAspectRatio="xMidYMid meet"` never changes as you zoom; `fitRect` reproduces that
 * letterboxing so pointer maths stays exact when the container is not the board's aspect.
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

// `-0` is a legal clamp result and renders fine, but it breaks value equality in tests and
// in any memo that compares viewports, so it is normalised away at the one place it appears.
const clamp = (v: number, lo: number, hi: number): number => {
  const c = v < lo ? lo : v > hi ? hi : v;
  return c === 0 ? 0 : c;
};
const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** The whole board, i.e. the fit-to-screen viewport. */
export function fitViewport(board: BoardSize): Viewport {
  return { x: 0, y: 0, w: board.w, h: board.h };
}

/** Narrowest legal window width for this board (the most-zoomed-in state). */
export function minViewportWidth(board: BoardSize, minSpanIn: number = MIN_SPAN_IN): number {
  const aspect = board.w / board.h; // width per unit of height
  // The short side is the one that must not fall below `minSpanIn`.
  const byShortSide = minSpanIn * Math.max(1, aspect);
  return Math.min(board.w, byShortSide);
}

/**
 * Force a window to be legal: aspect-locked to the board, no wider than the board, no
 * narrower than `minViewportWidth`, and positioned so at most `maxOverscanIn` of empty
 * space shows past an edge. This is what stops the board being lost off screen.
 */
export function clampViewport(
  vp: Viewport,
  board: BoardSize,
  minSpanIn: number = MIN_SPAN_IN,
  maxOverscanIn: number = DEFAULT_OVERSCAN_IN,
): Viewport {
  const aspect = board.w / board.h;
  const minW = minViewportWidth(board, minSpanIn);
  const w = clamp(finite(vp.w, board.w), minW, board.w);
  const h = w / aspect;
  const over = Math.max(0, finite(maxOverscanIn, 0));
  const x = clamp(finite(vp.x, 0), -over, board.w - w + over);
  const y = clamp(finite(vp.y, 0), -over, board.h - h + over);
  return { x, y, w, h };
}

/** Magnification relative to fit-to-board: 1 = the whole board, 2 = half of it. */
export function zoomOf(vp: Viewport, board: BoardSize): number {
  return vp.w > 0 ? board.w / vp.w : 1;
}

/** Largest magnification this board allows. */
export function maxZoom(board: BoardSize, minSpanIn: number = MIN_SPAN_IN): number {
  return board.w / minViewportWidth(board, minSpanIn);
}

/** True when the whole board is on screen (one-finger drag then pans nothing). */
export function isFitViewport(vp: Viewport, board: BoardSize): boolean {
  return vp.w >= board.w - 1e-6;
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
function resizeAbout(vp: Viewport, board: BoardSize, factor: number, anchor: Pt, minSpanIn: number): Viewport {
  const aspect = board.w / board.h;
  const minW = minViewportWidth(board, minSpanIn);
  const f = factor > 0 && Number.isFinite(factor) ? factor : 1;
  const w = clamp(vp.w / f, minW, board.w);
  const h = w / aspect;
  // Keep the anchor at the same fraction of the window, i.e. the same place on screen.
  const rx = vp.w > 0 ? (anchor.x - vp.x) / vp.w : 0.5;
  const ry = vp.h > 0 ? (anchor.y - vp.y) / vp.h : 0.5;
  return { x: anchor.x - rx * w, y: anchor.y - ry * h, w, h };
}

/** Zoom by `factor` (>1 zooms in) keeping the VIEW-space point `anchor` under the cursor. */
export function zoomAtView(
  vp: Viewport,
  board: BoardSize,
  factor: number,
  anchor: Pt,
  minSpanIn: number = MIN_SPAN_IN,
  maxOverscanIn: number = DEFAULT_OVERSCAN_IN,
): Viewport {
  return clampViewport(resizeAbout(vp, board, factor, anchor, minSpanIn), board, minSpanIn, maxOverscanIn);
}

/**
 * Zoom by `factor` (>1 zooms in) about a fixed WORLD point — so wheel and pinch both feel
 * anchored under the finger instead of jumping to the centre. Near an edge the clamp wins,
 * which is the one case where the anchor drifts.
 */
export function zoomAt(
  vp: Viewport,
  board: BoardSize,
  factor: number,
  anchorWorld: Pt,
  minSpanIn: number = MIN_SPAN_IN,
  maxOverscanIn: number = DEFAULT_OVERSCAN_IN,
): Viewport {
  return zoomAtView(vp, board, factor, worldToView(anchorWorld, board.h), minSpanIn, maxOverscanIn);
}

/**
 * Move the window. Deltas are VIEW space (x right, y **down** — screen orientation), because
 * every caller derives them from pointer movement: a finger dragged right by D inches is
 * `panBy(vp, board, -D, 0)`, since dragging the content right moves the window left.
 */
export function panBy(
  vp: Viewport,
  board: BoardSize,
  dxIn: number,
  dyIn: number,
  minSpanIn: number = MIN_SPAN_IN,
  maxOverscanIn: number = DEFAULT_OVERSCAN_IN,
): Viewport {
  return clampViewport(
    { ...vp, x: vp.x + finite(dxIn, 0), y: vp.y + finite(dyIn, 0) },
    board,
    minSpanIn,
    maxOverscanIn,
  );
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
  minSpanIn: number = MIN_SPAN_IN,
  maxOverscanIn: number = DEFAULT_OVERSCAN_IN,
): Viewport {
  const d0 = Math.hypot(startTouches[1].x - startTouches[0].x, startTouches[1].y - startTouches[0].y);
  const d1 = Math.hypot(currentTouches[1].x - currentTouches[0].x, currentTouches[1].y - currentTouches[0].y);
  const factor = d0 > 1e-6 ? d1 / d0 : 1;
  const mid0 = { x: (startTouches[0].x + startTouches[1].x) / 2, y: (startTouches[0].y + startTouches[1].y) / 2 };
  const mid1 = {
    x: (currentTouches[0].x + currentTouches[1].x) / 2,
    y: (currentTouches[0].y + currentTouches[1].y) / 2,
  };
  const zoomed = resizeAbout(vp, board, factor, mid0, minSpanIn);
  const effective = zoomed.w > 0 ? vp.w / zoomed.w : 1;
  return clampViewport(
    { ...zoomed, x: zoomed.x - (mid1.x - mid0.x) / effective, y: zoomed.y - (mid1.y - mid0.y) / effective },
    board,
    minSpanIn,
    maxOverscanIn,
  );
}
