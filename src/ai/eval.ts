/**
 * Position evaluation.
 *
 * `evaluate()` scores a whole GameState from one player's point of view; `positionScore()`
 * scores one candidate destination for one operative. Both are pure and read-only.
 *
 * The terms and their default weights are documented in docs/AI.md.
 */
import type { GameContext } from '../core/context.ts';
import { markerController } from '../core/state.ts';
import { aliveOperatives, card, gapBetween, isInjured } from '../core/state.ts';
import { baseGap, dist } from '../core/geometry.ts';
import { terrain } from '../core/context.ts';
import { coverAndObscured, isVisible, type Body } from '../core/visibility.ts';
import { modelHeight } from '../core/state.ts';
import { healthFraction, operativeValue, shootEstimate, shotPlans, shotValue } from './combat.ts';
import { checkTarget, effectiveRules } from '../core/sequences/shoot.ts';
import { weaponsOf } from '../core/state.ts';
import type { GameState, MarkerState, OperativeState, PlayerId, Vec2 } from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';
import type { EvalWeights } from './types.ts';

export interface EvalOptions {
  /** Skip the (expensive) threat/exposure maps. */
  fast?: boolean;
}

export interface TeamSnapshot {
  vp: number;
  cp: number;
  objectives: number;
  value: number;
  health: number;
  carrying: number;
  alive: number;
}

export function snapshot(ctx: GameContext, state: GameState, player: PlayerId): TeamSnapshot {
  const team = state.teams[player];
  let value = 0;
  let health = 0;
  let carrying = 0;
  const ops = aliveOperatives(state, player);
  for (const op of ops) {
    const v = operativeValue(ctx, op);
    value += v;
    health += v * healthFraction(ctx, op);
    if (op.carryingMarkerId) carrying++;
  }
  let objectives = 0;
  for (const marker of Object.values(state.markers)) {
    if (marker.kind !== 'objective') continue;
    if (markerController(ctx, state, marker) === player) objectives++;
  }
  return { vp: team.vp, cp: team.cp, objectives, value, health, carrying, alive: ops.length };
}

/** Sum of the best shot each of `player`'s operatives could take right now. */
export function threatScore(ctx: GameContext, state: GameState, player: PlayerId, cap = 6): number {
  let total = 0;
  let n = 0;
  for (const op of aliveOperatives(state, player)) {
    if (n++ >= cap) break;
    const plans = shotPlans(ctx, state, op);
    const best = plans[0];
    if (best) total += best.estimate.effective;
  }
  return total;
}

/**
 * Score a whole state from `me`'s point of view. Positive is good for `me`.
 * VP dominates; everything else is a proxy for the VP those things will eventually pay.
 */
export function evaluate(
  ctx: GameContext,
  state: GameState,
  me: PlayerId,
  w: EvalWeights,
  opts: EvalOptions = {},
): number {
  const them = otherPlayer(me);
  const a = snapshot(ctx, state, me);
  const b = snapshot(ctx, state, them);

  let score = 0;
  score += w.vp * (a.vp - b.vp);
  score += w.objective * (a.objectives - b.objectives);
  score += w.operative * (a.value - b.value);
  score += w.wounds * (a.health - b.health);
  score += w.cp * (a.cp - b.cp);
  score += w.carry * (a.carrying - b.carrying);

  if (!opts.fast && (w.threat !== 0 || w.exposure !== 0)) {
    score += w.threat * threatScore(ctx, state, me);
    score -= w.exposure * threatScore(ctx, state, them);
  }

  if (w.advance !== 0) score += w.advance * (advanceScore(ctx, state, me) - advanceScore(ctx, state, them));

  // A finished battle is worth exactly its result — no proxy term can outweigh losing.
  if (state.phase === 'battleEnd') {
    if (state.winner === me) score += 4000;
    else if (state.winner === them) score -= 4000;
  }
  return score;
}

/** Negative distance from each operative to the objective it is closest to. */
function advanceScore(ctx: GameContext, state: GameState, player: PlayerId): number {
  const objectives = Object.values(state.markers).filter((m) => m.kind === 'objective');
  if (objectives.length === 0) return 0;
  let total = 0;
  for (const op of aliveOperatives(state, player)) {
    let best = Infinity;
    for (const m of objectives) best = Math.min(best, dist(op.pos, m.pos));
    total -= Math.min(best, 24);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Per-operative positional scoring (used to rank movement destinations)
// ---------------------------------------------------------------------------

export type Role = 'melee' | 'shooter' | 'objective' | 'support';

/** Infer a role from the datacard, or take the team module's `aiHints.roles` when it has one. */
export function roleOf(ctx: GameContext, state: GameState, op: OperativeState): Role {
  const hints = ctx.teams.get(state.teams[op.player].teamId)?.aiHints?.roles;
  const hinted = hints?.[op.datacardId];
  if (hinted === 'melee') return 'melee';
  if (hinted === 'sniper' || hinted === 'gunner') return 'shooter';
  if (hinted === 'objective' || hinted === 'scout') return 'objective';
  if (hinted === 'support' || hinted === 'leader') return 'support';
  const c = card(ctx, op);
  let ranged = 0;
  let melee = 0;
  for (const wep of c.weapons) {
    for (const p of wep.profiles) {
      const power = p.atk * (p.dmgN + p.dmgC);
      if (p.type === 'ranged') ranged = Math.max(ranged, power);
      else melee = Math.max(melee, power);
    }
  }
  if (melee > ranged * 1.25) return 'melee';
  if (ranged === 0) return 'objective';
  return 'shooter';
}

export interface PositionContext {
  role: Role;
  objectives: MarkerState[];
  enemies: OperativeState[];
  /** Weights, so a difficulty can retune positioning as well as search. */
  weights: EvalWeights;
}

export function positionContext(ctx: GameContext, state: GameState, op: OperativeState, weights: EvalWeights): PositionContext {
  return {
    role: roleOf(ctx, state, op),
    objectives: Object.values(state.markers).filter((m) => m.kind === 'objective'),
    enemies: aliveOperatives(state, otherPlayer(op.player)),
    weights,
  };
}

function bodyAt(ctx: GameContext, op: OperativeState, pos: Vec2, z: number): Body {
  const c = card(ctx, op);
  return { id: op.id, pos, z, rot: op.rot, base: c.base, height: modelHeight(c) };
}

/**
 * Cheap geometric pre-score for a destination — no visibility maths. Used to prune the
 * reachability field down to a handful of candidates worth the expensive scoring pass.
 */
export function cheapPositionScore(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
  pc: PositionContext,
): number {
  const c = card(ctx, op);
  let score = 0;
  for (const m of pc.objectives) {
    const gap = baseGap(pos, c.base, op.rot, m.pos, { shape: 'round', mm: m.diameterMm }, 0);
    if (gap <= 1) score += 26;
    else score -= Math.min(gap, 20) * 0.85;
  }
  let nearest = Infinity;
  for (const e of pc.enemies) nearest = Math.min(nearest, dist(pos, e.pos));
  if (nearest < Infinity) {
    if (pc.role === 'melee') score -= Math.min(nearest, 24) * 1.4;
    else if (pc.role === 'shooter') score -= Math.abs(Math.min(nearest, 24) - 9) * 0.5;
    else score -= Math.min(nearest, 24) * 0.2;
    if (nearest < 2 && pc.role !== 'melee') score -= 6;
  }
  score += pos.x === op.pos.x && pos.y === op.pos.y ? 1 : 0; // tiny bias to standing still
  return score;
}

/**
 * Full positional score for a destination: what can I shoot / charge from here, and what can
 * shoot me back. Expensive (visibility + dice maths), so only run on the pruned candidates.
 */
export function positionScore(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
  z: number,
  pc: PositionContext,
  order: OperativeState['order'] = op.order,
): number {
  let score = cheapPositionScore(ctx, state, op, pos, pc);
  const hypothetical: OperativeState = { ...op, pos, z, order };
  const index = terrain(ctx, state);
  const me = bodyAt(ctx, op, pos, z);

  // Opportunity: the best shot available from here.
  const plans = shotPlans(ctx, state, op, { pos, z, order });
  const best = plans[0];
  if (best) score += pc.weights.threat * 3 * shotValue(best);

  // Exposure: what the enemy can do to me from where they stand.
  let exposure = 0;
  for (const e of pc.enemies) {
    if (dist(e.pos, pos) > 30) continue;
    const them = bodyAt(ctx, e, e.pos, e.z);
    if (!isVisible(index, them, me).visible) continue;
    const cover = coverAndObscured(index, them, me);
    let worst = 0;
    for (const w of weaponsOf(ctx, state, e, 'ranged')) {
      for (const profile of w.profiles) {
        if (profile.type !== 'ranged') continue;
        const rules = effectiveRules(ctx, state, profile);
        const check = checkTarget(ctx, state, e, hypothetical, profile, rules);
        if (!check.valid) continue;
        const est = shootEstimate(ctx, state, {
          attacker: e,
          target: hypothetical,
          profile,
          rules,
          check: {
            inCover: check.inCover || cover.inCover,
            obscured: check.obscured || cover.obscured,
            vantageAccurate: check.vantageAccurate,
            vantageImprovedCover: check.vantageImprovedCover,
          },
        });
        worst = Math.max(worst, est.effective + est.killProb * 4);
      }
    }
    exposure += worst;
  }
  score -= pc.weights.exposure * 3 * exposure;

  // Being in someone's control range is only good for a melee operative.
  let engaged = 0;
  for (const e of pc.enemies) {
    const gap = baseGap(pos, card(ctx, op).base, op.rot, e.pos, card(ctx, e).base, e.rot);
    if (gap <= 1) engaged++;
  }
  if (engaged > 0) score += pc.role === 'melee' ? 6 * engaged : -10 * engaged;

  if (isInjured(ctx, op)) score -= 4 * engaged;
  return score;
}

/** Objective markers this operative would contest from `pos`. */
export function objectivesHeldFrom(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2): number {
  const c = card(ctx, op);
  let n = 0;
  for (const m of Object.values(state.markers)) {
    if (m.kind !== 'objective') continue;
    if (baseGap(pos, c.base, op.rot, m.pos, { shape: 'round', mm: m.diameterMm }, 0) <= 1) n++;
  }
  return n;
}

export { gapBetween };
