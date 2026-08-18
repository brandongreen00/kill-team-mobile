/**
 * Tap-to-move. A movement action (Reposition / Dash / Fall Back / Charge) is ARMED from the
 * action sheet, then each board tap lays a waypoint; the plan is confirmed or cancelled from
 * a small control card (the phone docks it under the board, the desktop shows it in the rail).
 *
 * The preview calls the engine's own `previewMove` — the exact validation `PerformAction`
 * will run — so a path shown green is a path the reducer accepts.
 */
import { getAction, moveBudgetFor, previewMove } from '../core/actions.ts';
import type { MoveAction } from '../core/movement.ts';
import { card } from '../core/state.ts';
import type { GameContext } from '../core/context.ts';
import type { GameState, OperativeState, PlayerId, Vec2 } from '../core/types.ts';
import type { Store } from './store.ts';

export interface MovePlan {
  operativeId: string;
  action: MoveAction;
  points: Vec2[];
}

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Fall Back', 'Charge', 'Move With Barricade'] as const;
export const isMoveAction = (id: string): id is MoveAction => (MOVE_ACTIONS as readonly string[]).includes(id);

const OK = '#5fbf7a';
const BAD = '#e0574a';
const GUIDE = '#8fd0ff';

const baseRadius = (ctx: GameContext, op: OperativeState): number => {
  const base = card(ctx, op).base;
  return (base.shape === 'round' ? base.mm : Math.max(base.mm[0], base.mm[1])) / 25.4 / 2;
};

/**
 * Legality comes from the action's own `check` — the same call the reducer makes, so it also
 * carries checks beyond the path itself (Charge needs an enemy, the barricade must be
 * connected). Distances for the readout come from `previewMove`.
 */
function validate(ctx: GameContext, state: GameState, op: OperativeState, plan: MovePlan) {
  const chk = getAction(plan.action)?.check(ctx, state, op, { path: { points: plan.points } }) ?? {
    ok: false,
    reason: `${plan.action} is not registered`,
  };
  const v = previewMove(ctx, state, op, plan.action, { points: plan.points });
  return { ok: chk.ok, reason: chk.reason, total: v.total };
}

/** Drawn inside the board's world transform, so it follows pan and zoom. */
export function MoveOverlay({ ctx, state, plan }: { ctx: GameContext; state: GameState; plan: MovePlan }) {
  const op = state.operatives[plan.operativeId];
  if (!op) return null;
  const budget = moveBudgetFor(ctx, state, op, plan.action);
  const v = plan.points.length > 0 ? validate(ctx, state, op, plan) : null;
  const pts = [op.pos, ...plan.points];
  const end = pts[pts.length - 1]!;
  const colour = v ? (v.ok ? OK : BAD) : GUIDE;
  const r = baseRadius(ctx, op);
  return (
    <g class="move-overlay" pointer-events="none">
      {/* Straight-line range guide — terrain can shorten (climbs) or block the real path. */}
      <circle cx={op.pos.x} cy={op.pos.y} r={budget + r} fill={GUIDE} fill-opacity={0.06} stroke={GUIDE} stroke-opacity={0.55} stroke-width={0.06} stroke-dasharray="0.4 0.25" />
      {plan.points.length > 0 && (
        <>
          <polyline
            points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={colour}
            stroke-width={0.1}
            stroke-dasharray="0.35 0.2"
            stroke-linejoin="round"
          />
          {plan.points.slice(0, -1).map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={0.14} fill={colour} />
          ))}
          {/* Where the base ends up. */}
          <circle cx={end.x} cy={end.y} r={r} fill={colour} fill-opacity={0.25} stroke={colour} stroke-width={0.1} />
          <g transform={`translate(${end.x} ${end.y + r + 0.9}) scale(1 -1)`}>
            <text text-anchor="middle" font-size="0.7" font-weight="700" fill={colour} stroke="#0b0d10" stroke-width={0.05} paint-order="stroke">
              {v ? `${v.total}" / ${budget}"` : ''}
            </text>
          </g>
        </>
      )}
    </g>
  );
}

export interface MoveControlsProps {
  store: Store;
  plan: MovePlan;
  onChange: (plan: MovePlan | null) => void;
}

/** The armed move's status + Confirm / Undo / Cancel. */
export function MoveControls({ store, plan, onChange }: MoveControlsProps) {
  const { state, ctx } = store;
  const op = state.operatives[plan.operativeId];
  if (!op) return null;
  const budget = moveBudgetFor(ctx, state, op, plan.action);
  const v = plan.points.length > 0 ? validate(ctx, state, op, plan) : null;
  /** With no waypoints yet, still surface a reason that has nothing to do with the path. */
  const armedBlock = plan.points.length === 0 ? validate(ctx, state, op, plan) : null;
  const confirm = () => {
    const ok = store.dispatch({
      t: 'PerformAction',
      operativeId: op.id,
      action: plan.action,
      params: { path: { points: plan.points } },
    });
    if (ok) onChange(null);
  };
  return (
    <section class="card move-card">
      <h2>
        {plan.action} — {op.name}
      </h2>
      {plan.points.length === 0 ? (
        armedBlock && !armedBlock.ok && armedBlock.reason !== 'no movement declared' && armedBlock.reason !== 'no path supplied' ? (
          <p class="err">✖ {armedBlock.reason}</p>
        ) : (
          <p class="muted">
            Tap the board where {op.name} should move — up to {budget}". Tap more than once to turn a corner.
            {plan.action === 'Charge' && ' A Charge must finish within control range (1") of an enemy operative.'}
          </p>
        )
      ) : v!.ok ? (
        <p class="ok-line">✔ {v!.total}" of {budget}" — confirm to move.</p>
      ) : (
        <p class="err">✖ {v!.reason ?? 'illegal move'}</p>
      )}
      <div class="row">
        <button class="primary" disabled={!v?.ok} onClick={confirm}>
          Confirm move
        </button>
        <button disabled={plan.points.length === 0} onClick={() => onChange({ ...plan, points: plan.points.slice(0, -1) })}>
          Undo
        </button>
        <button onClick={() => onChange(null)}>Cancel</button>
      </div>
    </section>
  );
}

/** Bright outline around the deploying player's drop zone while a placement is armed. */
export function DropZoneHighlight({ state, player }: { state: GameState; player: PlayerId }) {
  const zoneKey = state.setup.dropZone[player] ?? player;
  const polys = state.map.dropZones[zoneKey];
  return (
    <g class="dropzone-highlight" pointer-events="none">
      {polys.map((poly, i) => (
        <polygon
          key={i}
          points={poly.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="#f6c445"
          fill-opacity={0.08}
          stroke="#f6c445"
          stroke-width={0.12}
          stroke-dasharray="0.6 0.3"
        />
      ))}
    </g>
  );
}
