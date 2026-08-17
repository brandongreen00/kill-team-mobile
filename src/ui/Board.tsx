/**
 * The board: SVG, so it stays crisp at any zoom and hit-testing is free.
 * World coordinates are inches with the origin bottom-left; the single `worldTransform`
 * below is the ONLY place the y-flip happens.
 *
 * Pan and zoom are a gesture layer over the `viewBox`, nothing more: all the maths lives in
 * the pure `boardView.ts`, this file only turns pointer events into calls on it. Because the
 * window is the viewBox, everything drawn inside the world transform — terrain, operatives,
 * markers and the `overlays` (dice pools, firing line) — follows pan and zoom for free.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GameState, KillzoneMap, OperativeState, TerrainPart, Vec2 } from '../core/types.ts';
import { buildTerrainIndex } from '../core/terrain.ts';
import {
  fitViewport,
  isFitViewport,
  maxZoom,
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
  type Viewport,
} from './boardView.ts';

export type { Viewport } from './boardView.ts';

export const fullViewport = (map: KillzoneMap): Viewport => fitViewport(map.board);

/** A press that never wanders this far (CSS px) is a tap, not a drag. */
const TAP_SLOP_PX = 8;
/** One wheel notch (deltaY ≈ 100) zooms about 17%; trackpads deliver much smaller deltas. */
const WHEEL_ZOOM_PER_PX = 0.0016;
/** The +/− buttons step by a fixed factor about the centre of the current window. */
const BUTTON_ZOOM_STEP = 1.5;

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

const pts = (poly: Vec2[]): string => poly.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');

export interface BoardProps {
  state: GameState;
  /**
   * Starting window. Omitted, the board fits the killzone and then owns its own window
   * through the gestures below; supplied, it re-seeds the window whenever it changes.
   */
  viewport?: Viewport;
  /** Highlights: control range, targeting lines, reachability. */
  overlays?: preact.ComponentChildren;
  onOperativeClick?: (op: OperativeState) => void;
  onBoardClick?: (world: Vec2) => void;
  selectedId?: string;
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
  viewport,
  overlays,
  onOperativeClick,
  onBoardClick,
  selectedId,
  showGrid = true,
  showZones = true,
  variant = 'main',
}: BoardProps) {
  const map = state.map;
  const board = map.board;
  /** Thumbnails are previews: no gestures, no controls, always the whole killzone. */
  const interactive = variant === 'main';

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [ownVp, setOwnVp] = useState<Viewport>(() => viewport ?? fitViewport(board));
  const vp = interactive ? ownVp : (viewport ?? fitViewport(board));
  // The gesture handlers are plain DOM listeners, so they read the live window off a ref
  // rather than closing over a stale render.
  const vpRef = useRef(vp);
  vpRef.current = vp;

  // Re-seed only when the caller actually changes something: a new killzone or a new
  // `viewport` prop. Anything else would fight the user's own pan mid-gesture.
  const seedKey = `${map.id}|${viewport ? `${viewport.x},${viewport.y},${viewport.w},${viewport.h}` : '-'}`;
  const seedRef = useRef(seedKey);
  useEffect(() => {
    if (seedRef.current === seedKey) return;
    seedRef.current = seedKey;
    setOwnVp(viewport ?? fitViewport(board));
  }, [seedKey]);

  /** Live pointers, so a second finger is detectable the moment it lands. */
  const pointers = useRef(new Map<number, Pt>());
  /** Single-finger pan, anchored to where the press started (no frame-to-frame drift). */
  const drag = useRef<{ id: number; from: Pt; vp: Viewport; rect: ScreenRect; moved: boolean } | null>(null);
  /** Two-finger pinch, anchored to the window as it was when the second finger landed. */
  const twoFinger = useRef<{ ids: [number, number]; start: [Pt, Pt]; vp: Viewport; rect: ScreenRect } | null>(null);
  /** Set by any gesture that moved: the trailing `click` is then swallowed, not acted on. */
  const suppressClick = useRef(false);

  /** True once, then rearmed — a pinch or a pan must never place an operative. */
  const gestureConsumedClick = (): boolean => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  };

  const rectOf = (): ScreenRect | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
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
      drag.current = { id: e.pointerId, from: { x: e.clientX, y: e.clientY }, vp: vpRef.current, rect, moved: false };
      twoFinger.current = null;
    } else if (pointers.current.size === 2) {
      // A second finger cancels whatever the first was doing, so a pinch can never fall
      // through to onBoardClick / onOperativeClick.
      drag.current = null;
      suppressClick.current = true;
      beginPinch(rect);
    } else {
      drag.current = null;
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
        setOwnVp(pinch(two.vp, board, two.start, now));
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
      // One finger pans only when zoomed in. At fit there is nothing to pan, so the press
      // stays a tap however far the finger slid — swallowing it would just look broken to
      // someone placing an operative with an imprecise thumb.
      if (isFitViewport(d.vp, board)) return;
      const scale = pixelsPerInch(d.rect, d.vp);
      if (scale <= 0) return;
      suppressClick.current = true;
      setOwnVp(panBy(d.vp, board, -dx / scale, -dy / scale));
    };

    const onEnd = (e: PointerEvent) => {
      if (!pointers.current.delete(e.pointerId)) return;
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
      if (pointers.current.size === 0) drag.current = null;
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
      setOwnVp(zoomAt(cur, board, factor, screenToWorld({ x: e.clientX, y: e.clientY }, rect, cur, board.h)));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [interactive, board.w, board.h]);

  const zoomStep = (factor: number) => {
    const cur = vpRef.current;
    setOwnVp(zoomAtView(cur, board, factor, { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 }));
  };

  const index = buildTerrainIndex(map, state);
  // Parts are drawn lowest-first so upper levels sit on top.
  const parts = [...index.parts].sort((a, b) => a.z1 - b.z1);

  const handleClick = (e: MouseEvent) => {
    if (gestureConsumedClick()) return;
    if (!onBoardClick) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    // preserveAspectRatio letterboxes the window, so the rect is not the viewBox: the
    // conversion has to skip the bars or every tap is offset on a non-board-shaped screen.
    onBoardClick(screenToWorld({ x: e.clientX, y: e.clientY }, rect, vp, board.h));
  };

  const zoom = zoomOf(vp, board);
  const atFit = isFitViewport(vp, board);
  const atMax = vp.w <= minViewportWidth(board) + 1e-6 || maxZoom(board) <= 1;

  const svgEl = (
    <svg
      ref={svgRef}
      class={`board board-${variant}`}
      viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Killzone ${map.name}`}
      onClick={handleClick}
      onPointerDown={onPointerDown}
      style={
        interactive
          ? { flex: '1 1 0%', minHeight: 0, height: 'auto', userSelect: 'none', WebkitUserSelect: 'none' }
          : undefined
      }
    >
      <g transform={worldTransform(map.board.h)}>
        <rect x={0} y={0} width={map.board.w} height={map.board.h} fill="#15181d" />

        {showZones && (
          <g class="zones" opacity={0.35}>
            {map.territories.p1.map((poly, i) => (
              <polygon key={`t1-${i}`} points={pts(poly)} fill="#e39d79" opacity={0.25} />
            ))}
            {map.territories.p2.map((poly, i) => (
              <polygon key={`t2-${i}`} points={pts(poly)} fill="#c1c0c5" opacity={0.2} />
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

        <g class="markers">
          {Object.values(state.markers).map((m) => (
            <circle
              key={m.id}
              cx={m.pos.x}
              cy={m.pos.y}
              r={m.diameterMm / 25.4 / 2}
              fill="none"
              stroke={m.kind === 'objective' ? '#f6c445' : '#8fd0ff'}
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
              const dc = state.map ? undefined : undefined;
              const r = 0.63; // refined per datacard by the caller-supplied overlay
              const colour = op.player === 'p1' ? '#f6a35a' : '#9fb2c9';
              return (
                <g
                  key={op.id}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    // stopPropagation means the svg handler never runs, so the gesture
                    // guard has to be consumed here too.
                    if (gestureConsumedClick()) return;
                    onOperativeClick?.(op);
                  }}
                  style={{ cursor: onOperativeClick ? 'pointer' : 'default' }}
                >
                  <circle
                    cx={op.pos.x}
                    cy={op.pos.y}
                    r={r}
                    fill={colour}
                    fill-opacity={op.order === 'conceal' ? 0.45 : 0.9}
                    stroke={selectedId === op.id ? '#ffffff' : '#0b0d10'}
                    stroke-width={selectedId === op.id ? 0.12 : 0.05}
                  />
                  <g transform={`translate(${op.pos.x} ${op.pos.y}) scale(1 -1)`}>
                    <text text-anchor="middle" dy="0.18" font-size="0.7" fill="#0b0d10" font-weight="700">
                      {op.letter}
                    </text>
                  </g>
                  <title>{`${op.letter} — ${op.order}, ${op.wounds} wounds${op.onGuard ? ', on Guard' : ''}`}</title>
                </g>
              );
            })}
        </g>

        {overlays}
      </g>
    </svg>
  );

  if (!interactive) return svgEl;

  // The controls sit UNDER the board, never over it: the drop zones run along the left and
  // right edges of every killzone, which is exactly where an overlaid cluster would steal
  // the taps that place operatives.
  return (
    <div
      class="board-view"
      style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      {svgEl}
      <div
        class="board-controls"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          padding: '4px 6px',
          background: 'var(--panel)',
          borderTop: '1px solid var(--line)',
        }}
      >
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={atFit}
          style={{ minWidth: '44px', padding: '0 10px' }}
          onClick={() => zoomStep(1 / BUTTON_ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={atMax}
          style={{ minWidth: '44px', padding: '0 10px' }}
          onClick={() => zoomStep(BUTTON_ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Fit the killzone to the screen"
          title="Fit the killzone to the screen"
          disabled={atFit}
          style={{ minWidth: '44px', padding: '0 10px' }}
          onClick={() => setOwnVp(fitViewport(board))}
        >
          ⤢
        </button>
        <span class="tag" aria-live="off" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  );
}
