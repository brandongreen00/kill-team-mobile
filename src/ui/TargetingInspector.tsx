/**
 * Targeting-line inspector: tap a shooter, tap a target, and see WHY the shot is or is not
 * legal — the visibility line, the part that blocks it, what makes the target obscured or in
 * cover, and both operatives' heights.
 *
 * The elevation view is a pure-SVG side projection along the shooter→target axis: distance on
 * x, height on y. That communicates the intersections a 3D view would show (which terrain the
 * 1mm line passes through, and at what height) without shipping a 3D engine to a phone.
 */
import { dist } from '../core/geometry.ts';
import { terrain, type GameContext } from '../core/context.ts';
import { body, card, gapBetween } from '../core/state.ts';
import {
  coverAndObscured,
  headPoint,
  interveningParts,
  isVisible,
  silhouetteSamples,
  vantageAccurate,
  vantageIgnoreFilter,
} from '../core/visibility.ts';
import { hasType, type IndexedPart } from '../core/terrain.ts';
import type { GameState, OperativeState } from '../core/types.ts';

export interface InspectorResult {
  visible: boolean;
  blockedBy?: IndexedPart;
  inCover: boolean;
  obscured: boolean;
  coverParts: IndexedPart[];
  obscuringParts: IndexedPart[];
  vantage: number;
  distance: number;
  shooterZ: number;
  targetZ: number;
  shooterHeadZ: number;
  targetTopZ: number;
  /** Parts the targeting lines cross, in order of distance from the shooter. */
  crossed: { part: IndexedPart; at: number; z0: number; z1: number; wholly: boolean }[];
}

export function inspect(ctx: GameContext, state: GameState, shooter: OperativeState, target: OperativeState): InspectorResult {
  const index = terrain(ctx, state);
  const a = body(ctx, shooter);
  const b = body(ctx, target);
  const vis = isVisible(index, a, b);
  const cover = coverAndObscured(index, a, b, { ignore: vantageIgnoreFilter(index, a, b) });
  const inter = interveningParts(index, a, b);
  const total = dist(a.pos, b.pos) || 1;
  const crossed = inter.any
    .map((part) => {
      // Where along the shooter→target axis does the part sit?
      const cx = part.poly.reduce((s, p) => s + p.x, 0) / part.poly.length;
      const cy = part.poly.reduce((s, p) => s + p.y, 0) / part.poly.length;
      const t = ((cx - a.pos.x) * (b.pos.x - a.pos.x) + (cy - a.pos.y) * (b.pos.y - a.pos.y)) / (total * total);
      return {
        part,
        at: Math.max(0, Math.min(1, t)) * total,
        z0: part.z0,
        z1: hasType(part, 'Wall') ? Math.max(part.z1, 4) : part.z1,
        wholly: inter.wholly.includes(part),
      };
    })
    .sort((x, y) => x.at - y.at);

  return {
    visible: vis.visible,
    ...(vis.blockedBy ? { blockedBy: vis.blockedBy } : {}),
    inCover: cover.inCover,
    obscured: cover.obscured,
    coverParts: cover.coverParts,
    obscuringParts: cover.obscuringParts,
    vantage: vantageAccurate(index, a, b),
    distance: gapBetween(ctx, shooter, target),
    shooterZ: a.z,
    targetZ: b.z,
    shooterHeadZ: headPoint(a).z,
    targetTopZ: b.z + b.height,
    crossed,
  };
}

export interface TargetingInspectorProps {
  ctx: GameContext;
  state: GameState;
  shooter: OperativeState;
  target: OperativeState;
  onClose?: () => void;
}

export function TargetingInspector({ ctx, state, shooter, target, onClose }: TargetingInspectorProps) {
  const r = inspect(ctx, state, shooter, target);
  const span = Math.max(1, dist(shooter.pos, target.pos));
  const maxZ = Math.max(6, r.shooterHeadZ, r.targetTopZ, ...r.crossed.map((c) => c.z1)) + 0.5;
  // Side elevation: x = distance along the axis, y = height.
  const W = span;
  const H = maxZ;

  return (
    <section class="card">
      <h2>
        Targeting line — {shooter.letter} → {target.letter}
        {onClose && (
          <button style={{ float: 'right', minHeight: 32 }} onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </h2>

      <div class="row" style={{ marginBottom: 8 }}>
        <span class="tag" style={{ color: r.visible ? 'var(--ok)' : 'var(--danger)' }}>
          {r.visible ? 'visible' : 'not visible'}
        </span>
        <span class="tag">{r.distance.toFixed(1)}" base to base</span>
        {r.obscured && <span class="tag">obscured</span>}
        {r.inCover && <span class="tag">in cover</span>}
        {r.vantage > 0 && <span class="tag">Vantage Accurate {r.vantage}</span>}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: '160px', background: '#0a0c0f', borderRadius: '8px' }}
        role="img"
        aria-label="Side elevation of the targeting line"
      >
        <g transform={`translate(0 ${H}) scale(1 -1)`}>
          {/* killzone floor */}
          <line x1={0} y1={0} x2={W} y2={0} stroke="#2b313b" stroke-width={H * 0.012} />
          {/* terrain crossed, drawn at its true height */}
          {r.crossed.map((c) => (
            <rect
              key={c.part.id}
              x={Math.max(0, c.at - W * 0.03)}
              y={c.z0}
              width={W * 0.06}
              height={Math.max(0.05, c.z1 - c.z0)}
              fill={hasType(c.part, 'Wall') ? '#20242b' : hasType(c.part, 'Heavy') ? '#2f4a35' : '#4d6b3f'}
              stroke={c.wholly ? '#f6c445' : '#0b0d10'}
              stroke-width={H * 0.008}
            >
              <title>{`${c.part.feature.label ?? c.part.feature.kind}: ${c.part.types.join('+')} (${c.z0}–${c.z1}")`}</title>
            </rect>
          ))}
          {/* the visibility line: shooter's head to the top of the target's miniature */}
          <line
            x1={0}
            y1={r.shooterHeadZ}
            x2={W}
            y2={r.targetTopZ}
            stroke={r.visible ? '#5fbf7a' : '#e0574a'}
            stroke-width={H * 0.014}
            stroke-dasharray={r.visible ? undefined : `${H * 0.05} ${H * 0.03}`}
          />
          {/* operatives as columns from feet to head */}
          <rect x={-W * 0.008} y={r.shooterZ} width={W * 0.016} height={r.shooterHeadZ - r.shooterZ} fill="#f6a35a" />
          <rect x={W - W * 0.016} y={r.targetZ} width={W * 0.016} height={r.targetTopZ - r.targetZ} fill="#9fb2c9" />
        </g>
      </svg>

      <ul class="muted" style={{ paddingLeft: 18, marginTop: 8 }}>
        <li>
          {shooter.letter}: feet {r.shooterZ.toFixed(2)}", head {r.shooterHeadZ.toFixed(2)}" ·{' '}
          {target.letter}: feet {r.targetZ.toFixed(2)}", top {r.targetTopZ.toFixed(2)}"
        </li>
        {!r.visible && r.blockedBy && (
          <li>
            Blocked by <strong>{r.blockedBy.feature.label ?? r.blockedBy.feature.kind}</strong> (
            {r.blockedBy.types.join(' + ')}
            {hasType(r.blockedBy, 'Wall')
              ? ') — "Visibility cannot be determined over or through Wall terrain."'
              : hasType(r.blockedBy, 'Blocking')
                ? ') — "Visibility cannot be drawn through such gaps."'
                : hasType(r.blockedBy, 'Barred')
                  ? ') — Barred: visibility only within 1" horizontally.'
                  : ').'}
          </li>
        )}
        {r.obscuringParts.length > 0 && (
          <li>
            Obscured by {r.obscuringParts.map((p) => p.feature.label ?? p.feature.kind).join(', ')} — intervening Heavy
            terrain more than 1" from both operatives.
          </li>
        )}
        {r.coverParts.length > 0 && (
          <li>
            In cover from {r.coverParts.map((p) => p.feature.label ?? p.feature.kind).join(', ')} — intervening terrain
            within the target's control range.
          </li>
        )}
        {r.crossed.length === 0 && <li>No terrain is intervening.</li>}
        {r.vantage > 0 && (
          <li>
            {shooter.letter} is on Vantage terrain {(r.shooterZ - r.targetZ).toFixed(1)}" above the target — Accurate{' '}
            {r.vantage}.
          </li>
        )}
      </ul>
    </section>
  );
}
