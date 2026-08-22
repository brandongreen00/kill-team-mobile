/**
 * The board: SVG, so it stays crisp at any zoom and hit-testing is free.
 * World coordinates are inches with the origin bottom-left; the single `worldTransform`
 * below is the ONLY place the y-flip happens.
 *
 * Three things here exist because of the phone:
 *
 * 1. **The window follows the pane.** The viewport is aspect-locked to the element, not to
 *    the 30x22 killzone, so a portrait phone shows a tall slice of board instead of a
 *    letterboxed strip with dead black above and below it. `boardView` does the maths.
 * 2. **`frame` aims the board.** Deployment frames your drop zone, an activation frames the
 *    operative and where it can reach. The player never has to find the relevant inch.
 * 3. **A base is drawn true to scale but hit at thumb size.** The circle is the operative's
 *    real base — control range is measured off it — while an invisible disc gives it at
 *    least a 44px target, and the letter is drawn at a constant screen size so it stays
 *    legible at any zoom.
 *
 * Pan and zoom are a gesture layer over the `viewBox`, nothing more: all the maths lives in
 * the pure `boardView.ts`. While a board interaction is ARMED (placing an operative, picking
 * a destination) one finger drags the ghost instead of panning — two fingers still pan, and
 * the armed banner says so.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GameContext } from '../core/context.ts';
import { basePerimeter, baseRadius } from '../core/geometry.ts';
import { card } from '../core/state.ts';
import type { BaseShape, GameState, KillzoneMap, OperativeState, TerrainPart, Vec2 } from '../core/types.ts';
import { buildTerrainIndex } from '../core/terrain.ts';
import {
  fillViewport,
  fitViewport,
  frameRect,
  isFitViewport,
  maxViewportWidth,
  minViewportWidth,
  panBy,
  pinch,
  pixelsPerInch,
  screenToView,
  screenToWorld,
  zoomAt,
  zoomAtView,
  zoomOf,
  type Pt,
  type ScreenRect,
  type ViewLimits,
  type Viewport,
} from './boardView.ts';
import { IconFit, IconZoomIn, IconZoomOut } from './icons.tsx';

export type { Viewport } from './boardView.ts';

export const fullViewport = (map: KillzoneMap): Viewport => fitViewport(map.board);

/** A press that never wanders this far (CSS px) is a tap, not a drag. */
const TAP_SLOP_PX = 8;
/** One wheel notch (deltaY ≈ 100) zooms about 17%; trackpads deliver much smaller deltas. */
const WHEEL_ZOOM_PER_PX = 0.0016;
/** The +/− buttons step by a fixed factor about the centre of the current window. */
const BUTTON_ZOOM_STEP = 1.6;
/** Smallest on-screen diameter, px, at which an operative is a reliable target. */
const MIN_TAP_PX = 44;
/** How far above the finger a dragged ghost sits, px, so the thumb never covers it. */
const GHOST_LIFT_PX = 46;
/** Constant on-screen size for an operative's letter, px. */
const LETTER_PX = 13;

/** World (y-up) → SVG (y-down) for a given board height. */
export const worldTransform = (boardH: number): string => `translate(0 ${boardH}) scale(1 -1)`;

const TYPE_FILL: Record<string, string> = {
  Wall: '#20242b',
  Heavy: '#2f4a35',
  Light: '#4d6b3f',
  Vantage: '#5b7f96',
  Accessible: '#8a7a3d',
  Blocking: '#3a3f47',
  Exposed: '#6b6f76',
  Insignificant: '#6b6f76',
  Hazardous: '#243a4d',
  Barred: '#3d5744',
  Obstructing: '#7a5a2a',
  Protective: '#7a5a2a',
};

function fillFor(part: TerrainPart): string {
  for (const t of ['Wall', 'Vantage', 'Heavy', 'Barred', 'Light', 'Accessible', 'Blocking', 'Obstructing'] as const) {
    if (part.types.includes(t)) return TYPE_FILL[t]!;
  }
  return '#3a3f47';
}

const pts = (poly: readonly Vec2[]): string => poly.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');

/** A 32 mm round base is the fallback when no context is available to look one up. */
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

/**
 * What the board is currently waiting for a tap on. Two flavours, and an arm may be both:
 * a POINT (place this operative, move to here) and/or an OPERATIVE (shoot that one). Charge
 * is the case that needs both — you pick an enemy, then a spot next to it.
 */
export interface ArmedState {
  /** Shown in the ghost while a point is being aimed. */
  base?: BaseShape;
  rotDeg?: number;
  /** Is this world point a legal choice? Called on every ghost move, so keep it cheap. */
  legal?: (world: Vec2) => { ok: boolean; reason?: string };
  /** Point-picking: committed on tap, or on release of a ghost drag. */
  commit?: (world: Vec2) => void;
  /** Operative-picking: a tap on an operative resolves here instead of as a point. */
  onOperative?: (op: OperativeState) => void;
}

export interface BoardProps {
  state: GameState;
  /** Supplied, base sizes and datacards are exact rather than assumed. */
  ctx?: GameContext;
  /**
   * Starting window. Omitted, the board fills the pane and then owns its own window through
   * the gestures below; supplied, it re-seeds the window whenever it changes.
   */
  viewport?: Viewport;
  /**
   * A WORLD-space rectangle to aim the board at. Changing it re-frames — this is how
   * deployment shows your drop zone and an activation shows where an operative can go.
   */
  frame?: { x: number; y: number; w: number; h: number } | null;
  /** Drawn under the operatives, inside the world transform: zones, reachability, paths. */
  highlights?: preact.ComponentChildren;
  /** Drawn over everything: dice pools, firing lines. */
  overlays?: preact.ComponentChildren;
  /** Arms the board: the next tap means something specific. */
  armed?: ArmedState | null;
  onOperativeClick?: (op: OperativeState) => void;
  onBoardClick?: (world: Vec2) => void;
  selectedId?: string | undefined;
  /** Operatives to draw as available targets — a pulsing ring, so they read as tappable. */
  targetIds?: readonly string[];
  /**
   * Which side the zoom cluster floats on. Drop zones run up the LEFT and RIGHT edges of
   * every killzone, so a fixed corner would sit on top of the very inches the player is
   * being asked to tap; the caller flips it away from whatever is currently armed.
   */
  controlsSide?: 'left' | 'right';
  showGrid?: boolean;
  showZones?: boolean;
  /**
   * 'main' is the one interactive board; 'thumb' is a contact-sheet preview. They carry
   * different classes so a selector can address exactly one of them — the killzone browser
   * renders 24 thumbnails, which otherwise makes any `svg.board` query ambiguous.
   */
  variant?: 'main' | 'thumb';
}

export function Board({
  state,
  ctx,
  viewport,
  frame,
  highlights,
  overlays,
  armed,
  onOperativeClick,
  onBoardClick,
  selectedId,
  targetIds,
  controlsSide = 'right',
  showGrid = true,
  showZones = true,
  variant = 'main',
}: BoardProps) {
  const map = state.map;
  const board = map.board;
  /** Thumbnails are previews: no gestures, no controls, always the whole killzone. */
  const interactive = variant === 'main';

  const svgRef = useRef<SVGSVGElement | null>(null);
  /**
   * The pane's aspect, measured. Everything about the window depends on it, so it is state
   * rather than a ref: a rotation or a sheet resize has to re-clamp the viewport.
   */
  const [pane, setPane] = useState<{ w: number; h: number }>({ w: 390, h: 390 / (board.w / board.h) });
  const aspect = pane.w > 0 && pane.h > 0 ? pane.w / pane.h : board.w / board.h;
  const limits: ViewLimits = { aspect };
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  const [ownVp, setOwnVp] = useState<Viewport>(() => viewport ?? fillViewport(board, { aspect: board.w / board.h }));
  const vp = interactive ? ownVp : (viewport ?? fitViewport(board));
  // The gesture handlers are plain DOM listeners, so they read the live window off a ref
  // rather than closing over a stale render.
  const vpRef = useRef(vp);
  vpRef.current = vp;

  /** The ghost a drag is currently positioning, world coords. */
  const [ghost, setGhost] = useState<{ pos: Vec2; ok: boolean; reason?: string } | null>(null);
  /** The gesture listeners are bound once and must read the ghost as it is NOW. */
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const armedRef = useRef(armed);
  armedRef.current = armed;

  const rectOf = (): ScreenRect | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };

  // --- pane measurement --------------------------------------------------
  // Layout effect, not effect: the first paint should already use the real aspect, or the
  // board visibly snaps from board-shaped to pane-shaped on load.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const read = () => {
      const r = svg.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setPane((p) => (Math.abs(p.w - r.width) < 0.5 && Math.abs(p.h - r.height) < 0.5 ? p : { w: r.width, h: r.height }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [interactive]);

  // --- what the window should be ----------------------------------------
  // Re-seed only when the caller actually changes something: a new killzone, a new explicit
  // `viewport`, a new `frame`, or a pane that changed shape. Anything else would fight the
  // user's own pan mid-gesture.
  const frameKey = frame ? `${frame.x.toFixed(2)},${frame.y.toFixed(2)},${frame.w.toFixed(2)},${frame.h.toFixed(2)}` : '-';
  const vpKey = viewport ? `${viewport.x},${viewport.y},${viewport.w},${viewport.h}` : '-';
  const seedKey = `${map.id}|${vpKey}|${frameKey}`;
  const seedRef = useRef<string | null>(null);
  const aspectRef = useRef(aspect);
  /**
   * Has the player panned or zoomed since the last re-frame? Only then is their window worth
   * preserving across a pane reshape. Without this the first ResizeObserver callback — which
   * always arrives after the first render, with the real pane aspect — is treated as "the
   * player moved the board" and freezes the pre-measurement default framing in place.
   */
  const userAdjusted = useRef(false);

  useEffect(() => {
    if (!interactive) return;
    const aspectChanged = Math.abs(aspectRef.current - aspect) > 1e-4;
    if (seedRef.current === seedKey && !aspectChanged) return;
    const firstSeed = seedRef.current === null;
    seedRef.current = seedKey;
    aspectRef.current = aspect;
    if (viewport) return setOwnVp(viewport);
    if (frame) return setOwnVp(frameRect(frame, board, { aspect }, 1.5));
    // A pane reshape (sheet moved, device rotated) must not throw away where the player is
    // looking: re-clamp what they had rather than jumping back to the default framing.
    if (!firstSeed && aspectChanged && userAdjusted.current) {
      return setOwnVp((cur) => zoomAtView(cur, board, 1, { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 }, { aspect }));
    }
    if (!aspectChanged) userAdjusted.current = false;
    setOwnVp(fillViewport(board, { aspect }));
  }, [seedKey, aspect, interactive, board.w, board.h]);

  /** Live pointers, so a second finger is detectable the moment it lands. */
  const pointers = useRef(new Map<number, Pt>());
  /** Single-finger pan, anchored to where the press started (no frame-to-frame drift). */
  const drag = useRef<{ id: number; from: Pt; vp: Viewport; rect: ScreenRect; moved: boolean } | null>(null);
  /** Two-finger pinch, anchored to the window as it was when the second finger landed. */
  const twoFinger = useRef<{ ids: [number, number]; start: [Pt, Pt]; vp: Viewport; rect: ScreenRect } | null>(null);
  /** Set by any gesture that moved: the trailing `click` is then swallowed, not acted on. */
  const suppressClick = useRef(false);
  /** A ghost drag in progress — one finger, while the board is armed. */
  const ghostDrag = useRef<{ id: number; rect: ScreenRect } | null>(null);

  /** True once, then rearmed — a pinch or a pan must never place an operative. */
  const gestureConsumedClick = (): boolean => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  };

  const judge = (world: Vec2): { pos: Vec2; ok: boolean; reason?: string } => {
    const verdict = armedRef.current?.legal?.(world);
    return { pos: world, ok: verdict ? verdict.ok : true, ...(verdict?.reason ? { reason: verdict.reason } : {}) };
  };

  const beginPinch = (rect: ScreenRect) => {
    const live = [...pointers.current.entries()].slice(0, 2);
    if (live.length < 2) return;
    const [a, b] = live as [[number, Pt], [number, Pt]];
    const start = vpRef.current;
    twoFinger.current = {
      ids: [a[0], b[0]],
      start: [screenToView(a[1], rect, start), screenToView(b[1], rect, start)],
      vp: start,
      rect,
    };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!interactive) return;
    const rect = rectOf();
    if (!rect) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      suppressClick.current = false;
      // Armed: one finger aims the ghost. Two fingers still pan and zoom.
      if (armedRef.current?.commit) {
        ghostDrag.current = { id: e.pointerId, rect };
        drag.current = null;
      } else {
        drag.current = { id: e.pointerId, from: { x: e.clientX, y: e.clientY }, vp: vpRef.current, rect, moved: false };
      }
      twoFinger.current = null;
    } else if (pointers.current.size === 2) {
      // A second finger cancels whatever the first was doing, so a pinch can never fall
      // through to onBoardClick / onOperativeClick / a placement.
      drag.current = null;
      ghostDrag.current = null;
      setGhost(null);
      suppressClick.current = true;
      beginPinch(rect);
    } else {
      drag.current = null;
      ghostDrag.current = null;
    }
  };

  // Move/up live on the window: without pointer capture (which would retarget `click` away
  // from the operative that was tapped) a gesture must still survive leaving the element.
  useEffect(() => {
    if (!interactive) return;

    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const two = twoFinger.current;
      if (two && pointers.current.size >= 2) {
        const a = pointers.current.get(two.ids[0]);
        const b = pointers.current.get(two.ids[1]);
        if (!a || !b) return;
        const now: [Pt, Pt] = [screenToView(a, two.rect, two.vp), screenToView(b, two.rect, two.vp)];
        userAdjusted.current = true;
        setOwnVp(pinch(two.vp, board, two.start, now, limitsRef.current));
        return;
      }

      const g = ghostDrag.current;
      if (g && g.id === e.pointerId) {
        // The ghost rides ABOVE the finger: a 32mm base is smaller than a fingertip, so
        // placing under the touch point means placing something you cannot see.
        const lifted = { x: e.clientX, y: e.clientY - GHOST_LIFT_PX };
        setGhost(judge(screenToWorld(lifted, g.rect, vpRef.current, board.h)));
        suppressClick.current = true;
        return;
      }

      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.from.x;
      const dy = e.clientY - d.from.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) <= TAP_SLOP_PX) return;
        d.moved = true;
      }
      // One finger pans only when there is somewhere to pan. At the fit framing the whole
      // board is on screen, so the press stays a tap however far the finger slid —
      // swallowing it would just look broken to someone tapping with an imprecise thumb.
      if (isFitViewport(d.vp, board, limitsRef.current)) return;
      const scale = pixelsPerInch(d.rect, d.vp);
      if (scale <= 0) return;
      suppressClick.current = true;
      userAdjusted.current = true;
      setOwnVp(panBy(d.vp, board, -dx / scale, -dy / scale, limitsRef.current));
    };

    const onEnd = (e: PointerEvent) => {
      if (!pointers.current.delete(e.pointerId)) return;

      const g = ghostDrag.current;
      if (g && g.id === e.pointerId) {
        ghostDrag.current = null;
        const pending = ghostRef.current;
        setGhost(null);
        // A drag that produced a ghost commits where the ghost is; a drag that never moved
        // is a tap, and `click` handles it so a tap on an operative still selects it.
        if (pending && armedRef.current?.commit) {
          suppressClick.current = true;
          // An illegal release still goes through `commit`: the reducer rejects it and its
          // reason reaches the player as a toast. Swallowing it silently is the old bug.
          armedRef.current.commit(pending.pos);
        }
      }

      if (pointers.current.size < 2) twoFinger.current = null;
      if (pointers.current.size === 1) {
        // A finger lifted mid-pinch: hand the survivor a fresh pan anchor so the board does
        // not jump, and keep the click suppressed — this was still a gesture.
        const rest = [...pointers.current.entries()][0];
        const rect = rectOf();
        if (rest && rect) {
          drag.current = { id: rest[0], from: rest[1], vp: vpRef.current, rect, moved: true };
          suppressClick.current = true;
        }
      }
      if (pointers.current.size === 0) {
        drag.current = null;
        ghostDrag.current = null;
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [interactive, board.w, board.h]);

  // Wheel zoom, anchored at the cursor. Registered by hand because it must be non-passive:
  // the page itself never scrolls, so the browser's default scroll has to be cancelled.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = rectOf();
      if (!rect) return;
      const cur = vpRef.current;
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * rect.height : e.deltaY;
      const factor = Math.exp(-px * WHEEL_ZOOM_PER_PX);
      userAdjusted.current = true;
      setOwnVp(
        zoomAt(cur, board, factor, screenToWorld({ x: e.clientX, y: e.clientY }, rect, cur, board.h), limitsRef.current),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [interactive, board.w, board.h]);

  const zoomStep = (factor: number) => {
    userAdjusted.current = true;
    const cur = vpRef.current;
    setOwnVp(zoomAtView(cur, board, factor, { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 }, limitsRef.current));
  };

  const index = buildTerrainIndex(map, state);
  // Parts are drawn lowest-first so upper levels sit on top.
  const parts = [...index.parts].sort((a, b) => a.z1 - b.z1);

  const handleClick = (e: MouseEvent) => {
    if (gestureConsumedClick()) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    // preserveAspectRatio letterboxes the window whenever it is not the pane's aspect (a
    // pane mid-resize), so the rect is not the viewBox: the conversion has to skip the bars
    // or every tap is offset.
    const world = screenToWorld({ x: e.clientX, y: e.clientY }, rect, vp, board.h);
    if (armedRef.current?.commit) {
      armedRef.current.commit(world);
      return;
    }
    onBoardClick?.(world);
  };

  const zoom = zoomOf(vp, board);
  const atFit = isFitViewport(vp, board, limits);
  const atMax = vp.w <= minViewportWidth(board, limits) + 1e-6 || maxViewportWidth(board, limits) <= minViewportWidth(board, limits) + 1e-6;
  /**
   * World inches per screen px — how a constant-size decoration is sized. Derived from the
   * measured pane rather than read out of the DOM during render, which would be a forced
   * layout on every frame of a pan.
   */
  const inPerPx = vp.w / Math.max(1, pane.w);
  const baseOf = (op: OperativeState): BaseShape => (ctx ? card(ctx, op).base : DEFAULT_BASE);
  const targets = new Set(targetIds ?? []);

  const svgEl = (
    <svg
      ref={svgRef}
      class={`board board-${variant}${armed ? ' is-armed' : ''}`}
      viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Killzone ${map.name}`}
      onClick={handleClick}
      onPointerDown={onPointerDown}
      style={interactive ? { userSelect: 'none', WebkitUserSelect: 'none' } : undefined}
    >
      <g transform={worldTransform(map.board.h)}>
        <rect x={0} y={0} width={map.board.w} height={map.board.h} fill="#15181d" />

        {showZones && (
          <g class="zones" opacity={0.35}>
            {map.territories.p1.map((poly, i) => (
              <polygon key={`t1-${i}`} points={pts(poly)} fill="#e39d79" opacity={0.22} />
            ))}
            {map.territories.p2.map((poly, i) => (
              <polygon key={`t2-${i}`} points={pts(poly)} fill="#c1c0c5" opacity={0.18} />
            ))}
            {map.dropZones.p1.map((poly, i) => (
              <polygon key={`d1-${i}`} points={pts(poly)} fill="#f65a29" opacity={0.22} />
            ))}
            {map.dropZones.p2.map((poly, i) => (
              <polygon key={`d2-${i}`} points={pts(poly)} fill="#7b7b7e" opacity={0.3} />
            ))}
          </g>
        )}

        {showGrid && (
          <g class="grid" stroke="#ffffff" stroke-width={0.012} opacity={0.09}>
            {Array.from({ length: Math.floor(map.board.w) + 1 }, (_, i) => (
              <line key={`gx${i}`} x1={i} y1={0} x2={i} y2={map.board.h} />
            ))}
            {Array.from({ length: Math.floor(map.board.h) + 1 }, (_, i) => (
              <line key={`gy${i}`} x1={0} y1={i} x2={map.board.w} y2={i} />
            ))}
          </g>
        )}

        {(map.hazardous ?? []).map((poly, i) => (
          <polygon key={`hz${i}`} points={pts(poly)} fill={TYPE_FILL['Hazardous']} opacity={0.85} />
        ))}

        <g class="terrain">
          {parts.map((part) => (
            <polygon
              key={part.id}
              points={pts(part.poly)}
              fill={fillFor(part)}
              stroke="#0b0d10"
              stroke-width={0.03}
              // Shade by elevation so height reads at a glance.
              opacity={0.55 + Math.min(0.4, part.z1 * 0.08)}
            >
              <title>{`${part.feature.label ?? part.feature.kind} — ${part.types.join(', ')} (z ${part.z0}–${part.z1}")`}</title>
            </polygon>
          ))}
        </g>

        {/* Legality shading, reachability, planned paths — under the pieces, over terrain. */}
        {highlights}

        <g class="markers">
          {Object.values(state.markers).map((m) => (
            <circle
              key={m.id}
              cx={m.pos.x}
              cy={m.pos.y}
              r={m.diameterMm / 25.4 / 2}
              fill="none"
              stroke={m.kind === 'objective' ? '#ffc94a' : '#8fd0ff'}
              stroke-width={0.07}
            >
              <title>{m.kind}</title>
            </circle>
          ))}
        </g>

        <g class="operatives">
          {Object.values(state.operatives)
            .filter((o) => !o.removed && o.pos.x > -50)
            .map((op) => {
              const base = baseOf(op);
              const r = baseRadius(base);
              const colour = op.player === 'p1' ? '#ff9a4d' : '#8fb8d8';
              const hitR = Math.max(r, (MIN_TAP_PX / 2) * inPerPx);
              const isTarget = targets.has(op.id);
              return (
                <g
                  key={op.id}
                  class={`op op-${op.player}${selectedId === op.id ? ' is-selected' : ''}${isTarget ? ' is-target' : ''}`}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    // stopPropagation means the svg handler never runs, so the gesture
                    // guard has to be consumed here too.
                    if (gestureConsumedClick()) return;
                    // An armed board owns the tap. An arm that wants an operative gets
                    // this one; an arm that wants a point gets the point under it, so
                    // placing next to a model does not silently select the model instead.
                    const arm = armedRef.current;
                    if (arm?.onOperative) return arm.onOperative(op);
                    if (arm?.commit) {
                      const rect = rectOf();
                      if (rect) arm.commit(screenToWorld({ x: e.clientX, y: e.clientY }, rect, vpRef.current, board.h));
                      return;
                    }
                    onOperativeClick?.(op);
                  }}
                  style={{ cursor: onOperativeClick ? 'pointer' : 'default' }}
                >
                  {/* The real base, to scale: this is the shape control range is measured from. */}
                  <polygon
                    points={pts(basePerimeter(op.pos, base, op.rot))}
                    fill={colour}
                    fill-opacity={op.order === 'conceal' ? 0.42 : 0.9}
                    stroke={selectedId === op.id ? '#ffffff' : '#0b0d10'}
                    stroke-width={selectedId === op.id ? 0.1 : 0.045}
                  />
                  {isTarget && (
                    <circle cx={op.pos.x} cy={op.pos.y} r={r + 0.22} fill="none" stroke="#ffc94a" stroke-width={0.07} opacity={0.9} />
                  )}
                  {op.expended && (
                    <circle cx={op.pos.x} cy={op.pos.y} r={r * 0.55} fill="none" stroke="#0b0d10" stroke-width={0.06} opacity={0.6} />
                  )}
                  {/* Constant on-screen letter: legible whether you are at fit or at 5x. */}
                  <g transform={`translate(${op.pos.x} ${op.pos.y}) scale(${inPerPx} ${-inPerPx})`}>
                    <text
                      text-anchor="middle"
                      dy={LETTER_PX * 0.35}
                      font-size={LETTER_PX}
                      fill="#0b0d10"
                      font-weight="700"
                      style={{ pointerEvents: 'none' }}
                    >
                      {op.letter}
                    </text>
                  </g>
                  {/* Invisible thumb-sized target, so a 16px base is still hittable. */}
                  <circle cx={op.pos.x} cy={op.pos.y} r={hitR} fill="transparent" stroke="none" />
                  <title>{`${op.letter} — ${op.order}, ${op.wounds} wounds${op.onGuard ? ', on Guard' : ''}`}</title>
                </g>
              );
            })}
        </g>

        {/* The ghost: where the thing being placed would go, and whether it may. */}
        {ghost && armed?.commit && (
          <g class="ghost" style={{ pointerEvents: 'none' }}>
            <polygon
              points={pts(basePerimeter(ghost.pos, armed.base ?? DEFAULT_BASE, armed.rotDeg ?? 0))}
              fill={ghost.ok ? '#62d08a' : '#ff6b5c'}
              fill-opacity={0.35}
              stroke={ghost.ok ? '#62d08a' : '#ff6b5c'}
              stroke-width={0.07}
            />
            <line
              x1={ghost.pos.x}
              y1={ghost.pos.y - baseRadius(armed.base ?? DEFAULT_BASE) - 0.6}
              x2={ghost.pos.x}
              y2={ghost.pos.y - baseRadius(armed.base ?? DEFAULT_BASE) - 0.15}
              stroke={ghost.ok ? '#62d08a' : '#ff6b5c'}
              stroke-width={0.05}
            />
          </g>
        )}

        {overlays}
      </g>
    </svg>
  );

  if (!interactive) return svgEl;

  return (
    <>
      {svgEl}
      <div class={`board-controls side-${controlsSide}`}>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={atMax}
          onClick={() => zoomStep(BUTTON_ZOOM_STEP)}
        >
          <IconZoomIn size={20} />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={atFit}
          onClick={() => zoomStep(1 / BUTTON_ZOOM_STEP)}
        >
          <IconZoomOut size={20} />
        </button>
        <button
          type="button"
          aria-label="Fit the killzone to the screen"
          title="Fit the killzone to the screen"
          disabled={atFit}
          onClick={() => {
            userAdjusted.current = true;
            setOwnVp(fitViewport(board, limits));
          }}
        >
          <IconFit size={20} />
        </button>
        <span class="zoom-readout" aria-live="off" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </>
  );
}
