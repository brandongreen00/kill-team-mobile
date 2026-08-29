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

/**
 * Terrain fills, every one of them >= 3:1 against the board floor (#12151b).
 *
 * The previous set was a full stop darker — Wall came out at **1.17:1** and Heavy at 1.87:1 —
 * and was then multiplied by an opacity ramp of `0.55 + z1 * 0.08`, so on a phone in daylight
 * a wall was a slightly different black. You cannot plan a shot through terrain you cannot
 * see. Height is now carried by the stroke weight rather than by fading the fill.
 */
const BOARD_FLOOR = '#12151b';
const TYPE_FILL: Record<string, string> = {
  Wall: '#5e6774',
  Heavy: '#42704e',
  Light: '#4e7a46',
  Vantage: '#5b8fa8',
  Accessible: '#8a7a3d',
  Blocking: '#68717f',
  Exposed: '#7a808a',
  Insignificant: '#7a808a',
  Hazardous: '#215d7a',
  Barred: '#3d7550',
  Obstructing: '#9c7534',
  Protective: '#9c7534',
};

function fillFor(part: TerrainPart): string {
  for (const t of ['Wall', 'Vantage', 'Heavy', 'Barred', 'Light', 'Accessible', 'Blocking', 'Obstructing'] as const) {
    if (part.types.includes(t)) return TYPE_FILL[t]!;
  }
  return '#3a3f47';
}

const pts = (poly: readonly Vec2[]): string => poly.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');

/** The close-quarters wall family: one continuous structure, drawn with one outline. */
const WALL_SILHOUETTE_ROLES = new Set(['wall', 'connector', 'wallEnd']);

/**
 * Doors, hatchways and breach points, drawn as doors.
 *
 * They used to be drawn with `fillFor`, which reads the terrain TYPES — and a closed hatchway
 * is `Heavy, Wall`, exactly like the wall it is cut into, while a Volkus doorway is
 * `Accessible, Heavy` and lost to the same green. So on Gallowdark and Tomb World every one of
 * the ten hatchways on the board was invisible, and the only way to find one was to open the
 * Operate Hatch list and read part ids.
 *
 * The vocabulary is deliberately small and shared by all three: a CLOSED access point is a
 * panel with a lock, an OPEN one is a gap between two jambs with a dashed threshold, and the
 * accent hue says whether opening it is a 1AP Operate Hatch (amber) or a 2AP Breach (red).
 * Every fill clears 3:1 against the board floor, and the closed/open difference is carried by
 * SHAPE as well as by value, so it survives a greyscale screen.
 */
const DOOR = {
  hatch: { frame: '#e0a94a', panel: '#96601c', mark: '#1a1206' },
  breach: { frame: '#e08159', panel: '#963a24', mark: '#1a0805' },
  door: { frame: '#c9b48a', panel: '#6b5c3c', mark: '#14110a' },
} as const;

interface DoorBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Along the wall. */
  long: number;
  /** Across the wall. */
  thick: number;
  horiz: boolean;
  cx: number;
  cy: number;
}

function doorBox(poly: readonly Vec2[]): DoorBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const horiz = w >= h;
  return { x0, y0, x1, y1, horiz, long: horiz ? w : h, thick: horiz ? h : w,
           cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** Which door vocabulary a part speaks, or null if it is not a door at all. */
function doorKindOf(part: TerrainPart): keyof typeof DOOR | null {
  if (part.role === 'accessPoint') return part.opensAs === 'breachWall' ? 'breach' : 'hatch';
  if (part.role === 'door') return 'door';
  return null;
}

function DoorPart({ part, kind }: { part: TerrainPart; kind: keyof typeof DOOR }) {
  const c = DOOR[kind];
  const b = doorBox(part.poly);
  // A Volkus doorway has no `state`: it is a permanent opening in the ruin, so it is drawn
  // open. A close-quarters access point carries one.
  const open = part.state !== 'closed';
  // Jambs: a short block of the wall's own thickness at each end, so the opening still reads
  // as part of the wall run rather than as a hole someone forgot to fill.
  const jamb = Math.min(0.28, b.long * 0.18);
  const jambs = b.horiz
    ? [
        [b.x0, b.y0, jamb, b.thick],
        [b.x1 - jamb, b.y0, jamb, b.thick],
      ]
    : [
        [b.x0, b.y0, b.thick, jamb],
        [b.x0, b.y1 - jamb, b.thick, jamb],
      ];
  const inset = Math.min(0.05, b.thick * 0.16);
  return (
    <g class={`door door-${kind}${open ? ' is-open' : ''}`}>
      {open ? (
        <>
          {/* The opening itself: floor, not wall — this is the thing you can walk through. */}
          <rect
            x={b.x0}
            y={b.y0}
            width={b.x1 - b.x0}
            height={b.y1 - b.y0}
            fill={BOARD_FLOOR}
          />
          {/* Threshold: a dashed line ACROSS the gap, along the wall's line. */}
          <line
            x1={b.horiz ? b.x0 : b.cx}
            y1={b.horiz ? b.cy : b.y0}
            x2={b.horiz ? b.x1 : b.cx}
            y2={b.horiz ? b.cy : b.y1}
            stroke={c.frame}
            stroke-width={0.06}
            stroke-dasharray="0.18 0.14"
            opacity={0.9}
          />
        </>
      ) : (
        <>
          <rect
            x={b.x0}
            y={b.y0}
            width={b.x1 - b.x0}
            height={b.y1 - b.y0}
            fill={c.frame}
          />
          {/* The panel: inset so the frame reads as the wall the hatch is set into. */}
          <rect
            x={b.x0 + inset}
            y={b.y0 + inset}
            width={Math.max(0, b.x1 - b.x0 - inset * 2)}
            height={Math.max(0, b.y1 - b.y0 - inset * 2)}
            fill={c.panel}
          />
          {/* The lock. A hatchway takes a wheel; a breach point takes a charge, so it is
              marked with a burst instead — you cannot simply open one. */}
          {kind === 'breach' ? (
            <g stroke={c.frame} stroke-width={0.055} stroke-linecap="round">
              {[-1, 0, 1].map((k) => (
                <line
                  key={k}
                  x1={b.cx + (b.horiz ? k * 0.34 : 0) - (b.horiz ? 0.11 : b.thick * 0.34)}
                  y1={b.cy + (b.horiz ? 0 : k * 0.34) - (b.horiz ? b.thick * 0.34 : 0.11)}
                  x2={b.cx + (b.horiz ? k * 0.34 : 0) + (b.horiz ? 0.11 : b.thick * 0.34)}
                  y2={b.cy + (b.horiz ? 0 : k * 0.34) + (b.horiz ? b.thick * 0.34 : 0.11)}
                />
              ))}
            </g>
          ) : (
            <circle
              cx={b.cx}
              cy={b.cy}
              r={Math.min(0.16, b.thick * 0.34)}
              fill="none"
              stroke={c.frame}
              stroke-width={0.055}
            />
          )}
        </>
      )}
      {jambs.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={c.frame} opacity={open ? 1 : 0.85} />
      ))}
    </g>
  );
}

/** A 32 mm round base is the fallback when no context is available to look one up. */
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

/**
 * The two sides, separated by VALUE and by SHAPE.
 *
 * The old pair (#ff9a4d / #8fb8d8) had a luminance ratio of 1.00:1 — identical brightness,
 * different hue — so in a greyscale copy of the screen, and to a red-green colour-blind
 * player, friend and enemy were the same token. These are 2.26:1 apart, and p2 additionally
 * carries an inner ring so the difference survives even a monochrome print-out.
 */
const P1_COLOUR = '#f2751f';
const P2_COLOUR = '#cfe8fa';

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
  /**
   * Terrain-picking: a tap on a hatchway or breach point resolves here.
   *
   * Operate Hatch and Breach are the only actions in the game aimed at a piece of terrain, and
   * before this the only way to aim one was a list of raw part ids in the sheet. A door is a
   * thing on the board; you point at it.
   */
  onPart?: (partId: string) => void;
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
   * Where to aim the board. A WORLD-space rectangle frames that region and never zooms out
   * past fill, so aiming at something can never letterbox; `'fit'` is the explicit opposite —
   * show the WHOLE killzone and accept the bars — which is what a summary screen ("both kill
   * teams are on the killzone", the end of a turning point, the result) actually wants.
   */
  frame?: { x: number; y: number; w: number; h: number } | 'fit' | null;
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
  /** Terrain parts the current step invites a tap on: hatchways and breach points. */
  partIds?: readonly string[];
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
  partIds,
  controlsSide = 'right',
  showGrid = true,
  showZones,
  variant = 'main',
}: BoardProps) {
  const map = state.map;
  const board = map.board;
  /** Thumbnails are previews: no gestures, no controls, always the whole killzone. */
  const interactive = variant === 'main';
  /**
   * Drop zones and territories are a SETUP construct. Left on for the whole battle they put an
   * orange wash under player 1's orange operatives, which is the one distinction that has to
   * stay readable.
   */
  const zones = showZones ?? state.phase === 'setup';

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
  const frameKey =
    frame === 'fit'
      ? 'fit'
      : frame
        ? `${frame.x.toFixed(2)},${frame.y.toFixed(2)},${frame.w.toFixed(2)},${frame.h.toFixed(2)}`
        : '-';
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
    if (frame === 'fit') return setOwnVp(fitViewport(board, { aspect }));
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

  /**
   * Does the current arm actually aim a THING at a point? Only then is a ghost meaningful.
   *
   * Two arms take a `commit` without a base: the drop-zone picker (a tap chooses a zone) and
   * the shooting screen (`commit` is a no-op that swallows taps on empty board). Both drew a
   * phantom 32mm disc under the finger for an operative that does not exist, and — worse —
   * both stole the one-finger pan, because any `commit` used to start a ghost drag. Gating on
   * `base` fixes the phantom and gives those screens their pan back.
   */
  const aimsABase = (): boolean => Boolean(armedRef.current?.commit && armedRef.current.base);

  /** True once, then rearmed — a pinch or a pan must never place an operative. */
  const gestureConsumedClick = (): boolean => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  };

  /**
   * A ghost belongs to the arm that produced it. Without this, walking off the move screen
   * with the cursor still over the board left the previous screen's green disc sitting there
   * as if something were still being aimed.
   */
  const armKey = armed?.commit && armed.base ? `${armed.base.shape}:${armed.base.mm}:${armed.rotDeg ?? 0}` : '';
  useEffect(() => {
    setGhost(null);
  }, [armKey]);

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
      // Armed: one FINGER aims the ghost. Two fingers still pan and zoom.
      //
      // A mouse is deliberately excluded. It has exactly one pointer, so routing it into the
      // ghost drag left desktop with no way to pan at all on the deploy and move screens —
      // the two screens that most need it. A mouse gets the desktop idiom instead: hover
      // previews the ghost (see `hoverGhost`), drag pans, click commits.
      if (e.pointerType !== 'mouse' && aimsABase()) {
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

    /**
     * Desktop: the ghost follows the cursor with no button held, so legality is visible
     * BEFORE the click that commits it — the same guarantee the finger gets from the drag,
     * minus the lift (a mouse cursor is exact, so lifting the ghost would place it somewhere
     * other than where you clicked).
     */
    const hoverGhost = (e: PointerEvent) => {
      const rect = rectOf();
      if (!aimsABase() || !rect) {
        if (ghostRef.current) setGhost(null);
        return;
      }
      const over =
        e.clientX >= rect.left &&
        e.clientX <= rect.left + rect.width &&
        e.clientY >= rect.top &&
        e.clientY <= rect.top + rect.height;
      if (!over) {
        if (ghostRef.current) setGhost(null);
        return;
      }
      setGhost(judge(screenToWorld({ x: e.clientX, y: e.clientY }, rect, vpRef.current, board.h)));
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) {
        if (e.pointerType === 'mouse' && pointers.current.size === 0) hoverGhost(e);
        return;
      }
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
  const liveParts = new Set(partIds ?? []);
  /**
   * How far a door's tap disc may reach, per door.
   *
   * A door is a 2" x 0.37" slot, so it needs the same 44px minimum a base gets — but at fit
   * zoom on a 390px phone that is a 3.1" disc, and the two closest access points in the
   * shipped data are 2.5" apart. Overlapping discs let SVG paint order decide which hatchway a
   * tap opens, and Operate Hatch costs 1AP with no confirm step. Each disc is capped at half
   * the distance to its nearest neighbour, so two of them can never overlap.
   */
  const doorReach = new Map<string, number>();
  {
    const centres = parts
      .filter((p) => doorKindOf(p) !== null)
      .map((p) => ({ id: p.id, b: doorBox(p.poly) }));
    for (const { id, b } of centres) {
      let nearest = Infinity;
      for (const other of centres) {
        if (other.id === id) continue;
        nearest = Math.min(nearest, Math.hypot(other.b.cx - b.cx, other.b.cy - b.cy));
      }
      doorReach.set(id, Number.isFinite(nearest) ? Math.max(0.2, nearest / 2 - 0.02) : Infinity);
    }
  }

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
        <rect x={0} y={0} width={map.board.w} height={map.board.h} fill={BOARD_FLOOR} />

        {zones && (
          <g class="zones" opacity={0.35}>
            {map.territories.p1.map((poly, i) => (
              <polygon key={`t1-${i}`} points={pts(poly)} fill="#e39d79" opacity={0.22} />
            ))}
            {map.territories.p2.map((poly, i) => (
              <polygon key={`t2-${i}`} points={pts(poly)} fill="#c1c0c5" opacity={0.18} />
            ))}
            {map.dropZones.p1.map((poly, i) => (
              <polygon key={`d1-${i}`} points={pts(poly)} fill="#f2703a" opacity={0.28} />
            ))}
            {map.dropZones.p2.map((poly, i) => (
              <polygon key={`d2-${i}`} points={pts(poly)} fill="#9fb6cc" opacity={0.26} />
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

        {/* Hazardous. On Bheta-Decima this is the OCEAN — most of the killzone, not an
            exception to it — so it is drawn as deep water rather than as a warning stripe:
            loud enough to be unmistakably not-floor (2.53:1 against it), quiet enough that
            it does not shout over the whole board. The wave hatch carries it in greyscale;
            the boundary stroke is what a player traces with a finger. */}
        {(map.hazardous ?? []).length > 0 && (
          <defs>
            <pattern id="hazard-water" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
              <rect width="1.2" height="1.2" fill={TYPE_FILL['Hazardous']} />
              <rect y="0.55" width="1.2" height="0.14" fill="#2f6f8f" opacity={0.55} />
            </pattern>
          </defs>
        )}
        {(map.hazardous ?? []).map((poly, i) => (
          <polygon key={`hz${i}`} points={pts(poly)} fill="url(#hazard-water)" stroke="#2f6f8f" stroke-width={0.07}>
            <title>Hazardous — no operative&apos;s base may touch this</title>
          </polygon>
        ))}

        {/* One silhouette, not thirty-five outlined bricks.
            A close-quarters wall run is many abutting pieces — three or four wall bars plus a
            connector post at every joint — and stroking each polygon separately drew a dark
            seam wherever two of them met, so a continuous wall read as a row of blocks with
            gaps in it and a square corner read as a cross. Stroking the whole family first
            and then filling it leaves only the outer edge dark: neighbours paint over each
            other's internal strokes, which is exactly what the printed map card looks like. */}
        {map.closeQuarters && (
          <g class="terrain-silhouette" stroke="#0b0d10" stroke-width={0.16} stroke-linejoin="round">
            {parts
              .filter((p) => WALL_SILHOUETTE_ROLES.has(p.role ?? ''))
              .map((part) => (
                <polygon key={`sil-${part.id}`} points={pts(part.poly)} fill="#0b0d10" />
              ))}
          </g>
        )}

        <g class="terrain">
          {parts.map((part) => {
            const door = doorKindOf(part);
            if (door) {
              const b = doorBox(part.poly);
              const live = liveParts.has(part.id);
              // The tap target is a disc at least MIN_TAP_PX across, exactly as an operative
              // gets: a hatchway is 2" x 0.37" and would otherwise be a hairline on a phone.
              const hitR = Math.max(
                b.long / 2,
                Math.min((MIN_TAP_PX / 2) * inPerPx, doorReach.get(part.id) ?? Infinity),
              );
              return (
                <g
                  key={part.id}
                  class={`terrain-door${live ? ' is-live' : ''}`}
                  onClick={(e: MouseEvent) => {
                    const arm = armedRef.current;
                    if (!arm?.onPart) return;
                    e.stopPropagation();
                    if (gestureConsumedClick()) return;
                    arm.onPart(part.id);
                  }}
                  style={{ cursor: armed?.onPart ? 'pointer' : 'default' }}
                >
                  <DoorPart part={part} kind={door} />
                  {live && (
                    <circle
                      class="door-ring"
                      cx={b.cx}
                      cy={b.cy}
                      r={hitR}
                      fill="none"
                      stroke={DOOR[door].frame}
                      stroke-width={0.07}
                      opacity={0.9}
                    />
                  )}
                  {armed?.onPart && <circle cx={b.cx} cy={b.cy} r={hitR} fill="transparent" />}
                  <title>
                    {`${door === 'door' ? 'Doorway' : door === 'breach' ? 'Breach point' : 'Hatchway'}`}
                    {part.feature.label ? ` in wall ${part.feature.label}` : ''}
                    {part.role === 'accessPoint' ? ` — ${part.state === 'open' ? 'open' : 'closed'}` : ''}
                  </title>
                </g>
              );
            }
            const silhouetted = map.closeQuarters && WALL_SILHOUETTE_ROLES.has(part.role ?? '');
            return (
              <polygon
                key={part.id}
                points={pts(part.poly)}
                fill={fillFor(part)}
                stroke={silhouetted ? 'none' : '#0b0d10'}
                // Height reads from the outline weight, not from fading the fill into the
                // floor: a taller piece is more strongly drawn, and stays legible either way.
                stroke-width={0.03 + Math.min(0.06, part.z1 * 0.012)}
                // The wall family is drawn opaque. Its parts overlap by design — a connector
                // post covers the end of the bar it caps — and two 0.92-alpha fills composite
                // to 0.994, so a translucent wall showed a lighter patch at every joint.
                opacity={silhouetted ? 1 : 0.92}
              >
                <title>{`${part.feature.label ?? part.feature.kind} — ${part.types.join(', ')} (z ${part.z0}–${part.z1}")`}</title>
              </polygon>
            );
          })}
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
              const colour = op.player === 'p1' ? P1_COLOUR : P2_COLOUR;
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
                  style={{
                    cursor: onOperativeClick ? 'pointer' : 'default',
                    // While the board is armed for a DOOR, the operatives stop taking taps.
                    // An operative gets a 44px invisible disc — about 1" of board at fit zoom
                    // on a phone — and it is painted after the terrain, so the one operative
                    // standing in base contact with a hatchway (the only position from which
                    // Operate Hatch is legal at all) covered the middle of the very door the
                    // prompt asks you to tap.
                    ...(armed?.onPart && !armed.onOperative ? { pointerEvents: 'none' as const } : {}),
                  }}
                >
                  {/* The real base, to scale: this is the shape control range is measured from. */}
                  <polygon
                    points={pts(basePerimeter(op.pos, base, op.rot))}
                    fill={colour}
                    fill-opacity={op.order === 'conceal' ? 0.34 : 0.95}
                    stroke={selectedId === op.id ? '#ffffff' : '#0b0d10'}
                    stroke-width={selectedId === op.id ? 0.1 : 0.045}
                  />
                  {/* Player 2 carries a second ring: the sides differ in shape as well as
                      in value, so the board is readable in greyscale. */}
                  {op.player === 'p2' && (
                    <circle cx={op.pos.x} cy={op.pos.y} r={r * 0.6} fill="none" stroke="#0b0d10" stroke-width={0.05} />
                  )}
                  {/* Conceal is a dashed outline, not just a lower alpha. */}
                  {op.order === 'conceal' && (
                    <polygon
                      points={pts(basePerimeter(op.pos, base, op.rot))}
                      fill="none"
                      stroke={colour}
                      stroke-width={0.07}
                      stroke-dasharray="0.22 0.16"
                    />
                  )}
                  {isTarget && (
                    <circle
                      class="target-ring"
                      cx={op.pos.x}
                      cy={op.pos.y}
                      r={r + 0.22}
                      fill="none"
                      stroke="#ffc94a"
                      stroke-width={0.08}
                    />
                  )}
                  {/* Expended: struck through, so it is not merely "a bit dimmer". */}
                  {op.expended && (
                    <line
                      x1={op.pos.x - r * 0.8}
                      y1={op.pos.y - r * 0.8}
                      x2={op.pos.x + r * 0.8}
                      y2={op.pos.y + r * 0.8}
                      stroke="#0b0d10"
                      stroke-width={0.09}
                      opacity={0.85}
                    />
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
        {ghost && armed?.commit && armed.base && (
          <g class="ghost" style={{ pointerEvents: 'none' }}>
            <polygon
              points={pts(basePerimeter(ghost.pos, armed.base, armed.rotDeg ?? 0))}
              fill={ghost.ok ? '#62d08a' : '#ff6b5c'}
              fill-opacity={0.35}
              stroke={ghost.ok ? '#62d08a' : '#ff6b5c'}
              stroke-width={0.07}
            />
            <line
              x1={ghost.pos.x}
              y1={ghost.pos.y - baseRadius(armed.base) - 0.6}
              x2={ghost.pos.x}
              y2={ghost.pos.y - baseRadius(armed.base) - 0.15}
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
