/**
 * The board: SVG, so it stays crisp at any zoom and hit-testing is free.
 * World coordinates are inches with the origin bottom-left; the single `worldTransform`
 * below is the ONLY place the y-flip happens.
 */
import type { GameState, KillzoneMap, OperativeState, TerrainPart, Vec2 } from '../core/types.ts';
import { buildTerrainIndex } from '../core/terrain.ts';

export interface Viewport {
  /** Visible world rectangle, inches. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const fullViewport = (map: KillzoneMap): Viewport => ({ x: 0, y: 0, w: map.board.w, h: map.board.h });

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
  viewport?: Viewport;
  /** Highlights: control range, targeting lines, reachability. */
  overlays?: preact.ComponentChildren;
  onOperativeClick?: (op: OperativeState) => void;
  onBoardClick?: (world: Vec2) => void;
  selectedId?: string;
  showGrid?: boolean;
  showZones?: boolean;
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
}: BoardProps) {
  const map = state.map;
  const vp = viewport ?? fullViewport(map);
  const index = buildTerrainIndex(map, state);
  // Parts are drawn lowest-first so upper levels sit on top.
  const parts = [...index.parts].sort((a, b) => a.z1 - b.z1);

  const handleClick = (e: MouseEvent) => {
    if (!onBoardClick) return;
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = vp.x + ((e.clientX - rect.left) / rect.width) * vp.w;
    const yTop = vp.y + ((e.clientY - rect.top) / rect.height) * vp.h;
    onBoardClick({ x, y: map.board.h - yTop });
  };

  return (
    <svg
      class="board"
      viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Killzone ${map.name}`}
      onClick={handleClick}
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
}
