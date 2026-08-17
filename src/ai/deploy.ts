/**
 * Deployment placement.
 *
 * Every candidate position is checked against the same three rules `DeployOperative` enforces
 * — wholly within the drop zone, not touching a hazardous area, not on another base — so a
 * deployment intent is never rejected. The same planner is used by every agent, so measured
 * win rates reflect play rather than setup.
 */
import type { GameContext } from '../core/context.ts';
import { terrain } from '../core/context.ts';
import { baseGap, baseWhollyWithin, dist, polyBounds } from '../core/geometry.ts';
import { aliveOperatives, card } from '../core/state.ts';
import { baseTouchesHazardous } from '../core/terrain.ts';
import type { BaseShape, GameState, OperativeState, PlayerId, Poly, Vec2 } from '../core/types.ts';

const GRID_CACHE = new Map<string, Vec2[]>();

function zoneGrid(map: { id: string }, zoneKey: string, zone: Poly[], base: BaseShape, rot: number, step = 0.75): Vec2[] {
  const key = `${map.id}|${zoneKey}|${JSON.stringify(base)}|${rot}|${step}`;
  const hit = GRID_CACHE.get(key);
  if (hit) return hit;
  const points: Vec2[] = [];
  for (const poly of zone) {
    const b = polyBounds(poly);
    for (let x = b.min.x; x <= b.max.x; x += step) {
      for (let y = b.min.y; y <= b.max.y; y += step) {
        const p = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
        if (baseWhollyWithin(p, base, rot, zone)) points.push(p);
      }
    }
  }
  if (GRID_CACHE.size > 64) GRID_CACHE.clear();
  GRID_CACHE.set(key, points);
  return points;
}

/**
 * Where should this operative set up? Forward toward the objectives, spread out enough that a
 * Blast weapon cannot catch two operatives, and never on top of a friend.
 */
export function deployPosition(ctx: GameContext, state: GameState, op: OperativeState): Vec2 | null {
  const zoneKey = state.setup.dropZone[op.player] ?? op.player;
  const zone = state.map.dropZones[zoneKey];
  if (!zone || zone.length === 0) return null;
  const c = card(ctx, op);
  const grid = zoneGrid(state.map, zoneKey, zone, c.base, op.rot);
  if (grid.length === 0) return null;
  const index = terrain(ctx, state);
  const objectives = Object.values(state.markers).filter((m) => m.kind === 'objective');
  const placed = aliveOperatives(state).filter((o) => o.pos.x > -50);

  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (const p of grid) {
    if (baseTouchesHazardous(index, p, c.base, op.rot)) continue;
    let blocked = false;
    let spread = 0;
    for (const other of placed) {
      if (other.id === op.id) continue;
      const oc = card(ctx, other);
      const gap = baseGap(p, c.base, op.rot, other.pos, oc.base, other.rot);
      if (gap < 0.05) {
        blocked = true;
        break;
      }
      if (other.player === op.player) spread += Math.min(gap, 4);
    }
    if (blocked) continue;
    let objectivePull = 0;
    let nearest = Infinity;
    for (const m of objectives) nearest = Math.min(nearest, dist(p, m.pos));
    if (nearest < Infinity) objectivePull = -Math.min(nearest, 30);
    const score = objectivePull * 1.0 + spread * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Reset the cached drop-zone grids (used between soak runs). */
export function clearDeployCache(): void {
  GRID_CACHE.clear();
}

export type { PlayerId };
