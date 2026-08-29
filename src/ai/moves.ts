/**
 * Movement candidate generation.
 *
 * Destinations are sampled from the engine's own 0.5" reachability field
 * (`reachableCells`, which already respects climb / drop / jump / Wall / Accessible /
 * hazardous), turned into straight-line `MovePath`s, and then verified with `validateMove`
 * BEFORE they ever become an intent — so a move intent can never be rejected.
 */
import type { GameContext } from '../core/context.ts';
import { baseGap, dist } from '../core/geometry.ts';
import type { MovePath } from '../core/intents.ts';
import {
  moveBudget,
  moveOptionsFor,
  reachableCells,
  routePath,
  validateMove,
  type MoveAction,
  type MoveOptions,
  type ReachCell,
} from '../core/movement.ts';
import { aliveOperatives, card } from '../core/state.ts';
import type { GameState, OperativeState, Vec2 } from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';

export type { MoveAction } from '../core/movement.ts';

export interface MoveCandidate {
  action: MoveAction;
  path: MovePath;
  pos: Vec2;
  z: number;
  /** Inches charged by the engine. */
  cost: number;
}

export { moveOptionsFor } from '../core/movement.ts';

type Cell = ReachCell;

/**
 * Reachability fields are pure in (map, terrain state, operative base/pos/rot, budget) — they
 * do not depend on the other operatives — so they cache well across planning candidates.
 * Bounded to keep memory flat over a soak run.
 */
/**
 * Two-level cache: (operative, position, step) -> budget -> field. A field computed for a
 * LARGER budget already contains every cell of a smaller one, so a single flood fill can serve
 * Reposition, Dash, Fall Back, Charge and a counteract move. `reachableCells` is by far the
 * most expensive call the AI makes, so this matters.
 */
const FIELD_CACHE = new Map<string, Map<number, Map<string, Cell>>>();
const FIELD_CACHE_MAX = 512;

/** Every runtime terrain override that can change where an operative may go. */
function terrainKey(state: GameState): string {
  const ids = Object.keys(state.terrainState).sort();
  let out = '';
  for (const id of ids) {
    const st = state.terrainState[id]!;
    out += `${id}:${st.state ?? ''}${st.removed ? 'x' : ''};`;
  }
  return out;
}

function opKey(state: GameState, op: OperativeState, step: number): string {
  return [
    state.map.id,
    // The map object itself can differ between battles with the same id (a regenerated or
    // edited layout), so the fingerprint includes its shape, not just its name.
    state.map.features.length,
    state.map.board.w,
    state.map.board.h,
    // The VALUES, not the count. `Operate Hatch` writes `state.terrainState[part.id]` on both
    // open AND close, so once a hatchway has been opened the key exists and the count never
    // changes again: closing it returned the cached field computed while it was open, and the
    // AI then proposed a move through a shut door, which the reducer refuses into
    // `state.rejected` — the one thing the soak suites assert is empty.
    terrainKey(state),
    state.placedFeatures.length,
    op.datacardId,
    op.pos.x.toFixed(2),
    op.pos.y.toFixed(2),
    op.z.toFixed(2),
    op.rot.toFixed(1),
    step,
  ].join('|');
}

function fieldFor(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  budget: number,
  step: number,
): Map<string, Cell> {
  const key = opKey(state, op, step);
  let byBudget = FIELD_CACHE.get(key);
  if (byBudget) {
    let bestBudget = Infinity;
    let best: Map<string, Cell> | undefined;
    for (const [b, field] of byBudget) {
      if (b + 1e-6 >= budget && b < bestBudget) {
        bestBudget = b;
        best = field;
      }
    }
    if (best) return best;
  } else {
    if (FIELD_CACHE.size >= FIELD_CACHE_MAX) FIELD_CACHE.clear();
    byBudget = new Map();
    FIELD_CACHE.set(key, byBudget);
  }
  const field = reachableCells(ctx, state, op, budget, step);
  byBudget.set(budget, field);
  return field;
}

/**
 * Pre-compute the field at the largest budget any of this operative's movement actions could
 * use, so the per-action calls all hit the cache.
 */
export function primeMoveField(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  actions: MoveAction[],
  step = 0.5,
  hardCap?: number,
): void {
  let max = 0;
  for (const action of actions) {
    const budget = Math.min(moveBudget(ctx, state, op, moveOptionsFor(action)), hardCap ?? Infinity);
    max = Math.max(max, budget);
  }
  if (max > 0) fieldFor(ctx, state, op, max, step);
}

function cellsWithin(ctx: GameContext, state: GameState, op: OperativeState, budget: number, step: number): Cell[] {
  const field = fieldFor(ctx, state, op, budget, step);
  const out: Cell[] = [];
  for (const cell of field.values()) if (cell.cost <= budget + 1e-6) out.push(cell);
  return out;
}

/** Test hook: drop the cached reachability fields (e.g. between games). */
export function clearMoveCache(): void {
  FIELD_CACHE.clear();
}

/** One reachable cell per `bucket`-inch square, cheapest first. */
function sampleField(field: Iterable<Cell>, bucket: number): Cell[] {
  const best = new Map<string, Cell>();
  for (const cell of field) {
    const k = `${Math.round(cell.pos.x / bucket)},${Math.round(cell.pos.y / bucket)},${cell.z.toFixed(1)}`;
    const prev = best.get(k);
    if (!prev || prev.cost > cell.cost) best.set(k, cell);
  }
  return [...best.values()];
}

export interface GenerateOptions {
  /** Extra positions to try (objective centres, charge rings, ...). */
  extraTargets?: Vec2[];
  /** How many validated candidates to return. */
  limit?: number;
  /** Counteract: "it can't move more than 2"". */
  hardCap?: number;
  /** Cheap ranking function; the best `limit * 2` are validated. */
  rank?: (pos: Vec2, z: number) => number;
  /**
   * Reachability-field resolution. The engine's default is 0.5"; the baseline agents use a
   * coarser 1" field because `reachableCells` is the AI's single most expensive call
   * (see docs/AI.md › Known weaknesses).
   */
  step?: number;
}

/**
 * Validated movement candidates for one action. The returned paths are guaranteed legal for
 * the state they were generated from.
 */
export function generateMoves(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  action: MoveAction,
  opts: GenerateOptions = {},
): MoveCandidate[] {
  const limit = opts.limit ?? 8;
  const options = moveOptionsFor(action, opts.hardCap);
  const budget = Math.min(moveBudget(ctx, state, op, options), opts.hardCap ?? Infinity);
  if (budget <= 0) return [];
  const step = opts.step ?? 0.5;
  const field = fieldFor(ctx, state, op, budget, step);
  const reachable = cellsWithin(ctx, state, op, budget, step);
  if (reachable.length === 0) return [];

  const bucket = budget <= 3 ? 1 : 1.5;
  const cells = sampleField(reachable, bucket);

  // Snap the requested extra targets (objectives, charge rings) onto the nearest field cell.
  for (const target of opts.extraTargets ?? []) {
    let best: Cell | undefined;
    let bestD = Infinity;
    for (const cell of reachable) {
      const d = dist(cell.pos, target);
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (best && bestD < 3) cells.push(best);
  }

  const ranked = opts.rank
    ? cells.map((c) => ({ cell: c, score: opts.rank!(c.pos, c.z) })).sort((a, b) => b.score - a.score)
    : cells.map((c) => ({ cell: c, score: -c.cost }));

  const out: MoveCandidate[] = [];
  const seen = new Set<string>();
  for (const { cell } of ranked) {
    if (out.length >= limit) break;
    if (cell.pos.x === op.pos.x && cell.pos.y === op.pos.y) continue;
    // The LEVEL is part of the identity now that the field has more than one. Without it the
    // rooftop above a floor cell — or the far side of a wall, which shares x/y with nothing —
    // was silently dropped as a duplicate of whichever the ranking happened to reach first.
    const key = `${cell.pos.x.toFixed(1)},${cell.pos.y.toFixed(1)},${cell.z.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = buildPath(ctx, state, op, cell, action, options, field);
    if (candidate) out.push(candidate);
  }
  return out;
}

/**
 * Turn a reachable cell into a legal path: the straight line first because it is the cheapest
 * (one increment, one round-up), then the field's own route around the terrain, then a two-leg
 * dog-leg via a mid-point. Anything that fails `validateMove` is dropped, so a move intent can
 * never be rejected.
 */
function buildPath(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  cell: Cell,
  action: MoveAction,
  options: MoveOptions,
  field?: Map<string, Cell>,
): MoveCandidate | null {
  const attempts: MovePath[] = [{ points: [cell.pos] }];
  // The flood fill reached this cell by walking round whatever is in the way; the straight
  // line to it usually goes through that terrain, which is not a legal move.
  if (field) {
    const routed = routePath(ctx, state, op, field, cell);
    if (routed && routed.points.length > 1) attempts.push(routed);
  }
  const mid = { x: (op.pos.x + cell.pos.x) / 2, y: (op.pos.y + cell.pos.y) / 2 };
  attempts.push({ points: [mid, cell.pos] });
  // Two perpendicular dog-legs, which get around a corner the straight line clips. Only worth
  // the extra `validateMove` calls for a Charge, where reaching the target is the whole point.
  if (action === 'Charge') {
    const dx = cell.pos.x - op.pos.x;
    const dy = cell.pos.y - op.pos.y;
    attempts.push({ points: [{ x: op.pos.x + dx, y: op.pos.y }, cell.pos] });
    attempts.push({ points: [{ x: op.pos.x, y: op.pos.y + dy }, cell.pos] });
  }

  for (const path of attempts) {
    const v = validateMove(ctx, state, op, path, options);
    if (v.ok) return { action, path, pos: v.endPos, z: v.endZ, cost: v.total };
  }
  return null;
}

/**
 * Positions from which `op` would be within control range of `enemy` — the landing ring for a
 * Charge. Sampled around the enemy's base at just inside 1" of clearance.
 */
export function chargeRing(ctx: GameContext, state: GameState, op: OperativeState, enemy: OperativeState, n = 12): Vec2[] {
  const a = card(ctx, op);
  const b = card(ctx, enemy);
  const ra = a.base.shape === 'round' ? a.base.mm / 25.4 / 2 : Math.max(...a.base.mm) / 25.4 / 2;
  const rb = b.base.shape === 'round' ? b.base.mm / 25.4 / 2 : Math.max(...b.base.mm) / 25.4 / 2;
  const radius = ra + rb + 0.45;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: enemy.pos.x + Math.cos(t) * radius, y: enemy.pos.y + Math.sin(t) * radius });
  }
  return out;
}

/** Enemies this operative could plausibly reach with a Charge this activation. */
export function chargeTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const budget = moveBudget(ctx, state, op, moveOptionsFor('Charge'));
  const c = card(ctx, op);
  return aliveOperatives(state, otherPlayer(op.player)).filter((e) => {
    const gap = baseGap(op.pos, c.base, op.rot, e.pos, card(ctx, e).base, e.rot);
    return gap > 1 && gap <= budget + 1;
  });
}
