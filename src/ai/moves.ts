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
import { moveBudget, reachableCells, validateMove, type MoveOptions } from '../core/movement.ts';
import { aliveOperatives, card } from '../core/state.ts';
import type { GameState, OperativeState, Vec2 } from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';

export type MoveAction = 'Reposition' | 'Dash' | 'Fall Back' | 'Charge';

export interface MoveCandidate {
  action: MoveAction;
  path: MovePath;
  pos: Vec2;
  z: number;
  /** Inches charged by the engine. */
  cost: number;
}

/** The exact MoveOptions the reducer will use for this action — never looser. */
export function moveOptionsFor(action: MoveAction, hardCap?: number): MoveOptions {
  const base: MoveOptions =
    action === 'Reposition'
      ? { action: 'Reposition', mustNotFinishEngaged: true }
      : action === 'Dash'
        ? { action: 'Dash', noClimb: true, mustNotFinishEngaged: true }
        : action === 'Fall Back'
          ? { action: 'Fall Back', mayEnterEnemyControlRange: true, mustNotFinishEngaged: true }
          : { action: 'Charge', bonusInches: 2, mayEnterEnemyControlRange: true, mustFinishEngaged: true };
  return hardCap === undefined ? base : { ...base, hardCap };
}

interface Cell {
  pos: Vec2;
  z: number;
  cost: number;
}

/**
 * Reachability fields are pure in (map, terrain state, operative base/pos/rot, budget) — they
 * do not depend on the other operatives — so they cache well across planning candidates.
 * Bounded to keep memory flat over a soak run.
 */
const FIELD_CACHE = new Map<string, Map<string, Cell>>();
const FIELD_CACHE_MAX = 256;

function fieldFor(ctx: GameContext, state: GameState, op: OperativeState, budget: number): Map<string, Cell> {
  const key = [
    state.map.id,
    Object.keys(state.terrainState).length,
    state.placedFeatures.length,
    op.datacardId,
    op.pos.x.toFixed(2),
    op.pos.y.toFixed(2),
    op.z.toFixed(2),
    op.rot.toFixed(1),
    budget.toFixed(2),
  ].join('|');
  const hit = FIELD_CACHE.get(key);
  if (hit) return hit;
  const field = reachableCells(ctx, state, op, budget);
  if (FIELD_CACHE.size >= FIELD_CACHE_MAX) FIELD_CACHE.clear();
  FIELD_CACHE.set(key, field);
  return field;
}

/** Test hook: drop the cached reachability fields (e.g. between games). */
export function clearMoveCache(): void {
  FIELD_CACHE.clear();
}

/** One reachable cell per `bucket`-inch square, cheapest first. */
function sampleField(field: Map<string, Cell>, bucket: number): Cell[] {
  const best = new Map<string, Cell>();
  for (const cell of field.values()) {
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
  const field = fieldFor(ctx, state, op, budget);

  const bucket = budget <= 3 ? 1 : 1.5;
  const cells = sampleField(field, bucket);

  // Snap the requested extra targets (objectives, charge rings) onto the nearest field cell.
  for (const target of opts.extraTargets ?? []) {
    let best: Cell | undefined;
    let bestD = Infinity;
    for (const cell of field.values()) {
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
    const key = `${cell.pos.x.toFixed(1)},${cell.pos.y.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = buildPath(ctx, state, op, cell, action, options);
    if (candidate) out.push(candidate);
  }
  return out;
}

/**
 * Turn a reachable cell into a legal path: try the straight line, then a two-leg dog-leg via
 * a mid-point, then a shortened straight line. Anything that fails `validateMove` is dropped.
 */
function buildPath(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  cell: Cell,
  action: MoveAction,
  options: MoveOptions,
): MoveCandidate | null {
  const attempts: Vec2[][] = [[cell.pos]];
  const mid = { x: (op.pos.x + cell.pos.x) / 2, y: (op.pos.y + cell.pos.y) / 2 };
  attempts.push([mid, cell.pos]);
  // Two perpendicular dog-legs, which get around a corner the straight line clips.
  const dx = cell.pos.x - op.pos.x;
  const dy = cell.pos.y - op.pos.y;
  attempts.push([{ x: op.pos.x + dx, y: op.pos.y }, cell.pos]);
  attempts.push([{ x: op.pos.x, y: op.pos.y + dy }, cell.pos]);

  for (const points of attempts) {
    const path: MovePath = { points };
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
