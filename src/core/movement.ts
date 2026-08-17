/**
 * Movement legality: straight-line increments, climb / drop / jump, Accessible, Wall,
 * Ceiling, hazardous areas, control range.
 *
 * Killzones › Terrain and Movement:
 *  - Climbing: "within 1" horizontally and 3" vertically of terrain that's visible to them
 *    to climb it. Each climb is treated as a minimum of 2" vertically."
 *  - Dropping: "Ignore 2" of vertical distance that they drop during each action... If they
 *    drop multiple times during an action, only 2" total is ignored."
 *  - Jumping: "from Vantage terrain higher than 2"... up to 4" horizontally from the edge...
 *    in one straight-line increment... When jumping to a terrain feature, you can ignore its
 *    height difference of 1" or less."
 * Core rules › Reposition: "This must be done in one or more straight-line increments, and
 * increments are always rounded up to the nearest inch."
 */
import { dist, baseGap } from './geometry.ts';
import { terrain, type GameContext } from './context.ts';
import {
  accessibleCrossings,
  baseBlockedByTerrain,
  baseTouchesHazardous,
  obstructingCrossings,
  surfaceAt,
  surfacesAt,
  hasType,
  type TerrainIndex,
} from './terrain.ts';
import { aliveOperatives, card, inControlRange, moveOf, body } from './state.ts';
import { isVisible } from './visibility.ts';
import type { MovePath } from './intents.ts';
import type { GameState, OperativeState, Vec2 } from './types.ts';
import { otherPlayer } from './types.ts';

export interface MoveLeg {
  from: Vec2;
  to: Vec2;
  fromZ: number;
  toZ: number;
  kind: 'horizontal' | 'climb' | 'drop' | 'jump' | 'accessible';
  /** Raw distance before rounding. */
  raw: number;
  /** Distance charged against the budget, after rounding up to the inch. */
  charged: number;
  note?: string;
}

export interface MoveValidation {
  ok: boolean;
  reason?: string;
  legs: MoveLeg[];
  total: number;
  budget: number;
  endPos: Vec2;
  endZ: number;
}

export interface MoveOptions {
  action: 'Reposition' | 'Dash' | 'Fall Back' | 'Charge' | 'Move With Barricade' | 'Counteract' | 'Free';
  /** Dash: "it cannot climb during this move, but it can drop and jump". */
  noClimb?: boolean;
  /** Charge / Fall Back may move within enemy control range. */
  mayEnterEnemyControlRange?: boolean;
  /** Charge must finish within control range; Reposition/Dash must not. */
  mustFinishEngaged?: boolean;
  mustNotFinishEngaged?: boolean;
  /** Ladders: "treat the vertical distance as 1"" once per action. */
  ladderClimbUsed?: boolean;
  /** Extra inches, e.g. Charge +2". */
  bonusInches?: number;
  /** Counteract: "cannot move more than 2"". */
  hardCap?: number;
}

const ceil1 = (v: number): number => Math.ceil(v - 1e-9);

/**
 * Validate a path for an operative. The path is a list of waypoints; each consecutive pair
 * is one straight-line increment, charged rounded UP to the nearest inch.
 */
export function validateMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  path: MovePath,
  opts: MoveOptions,
): MoveValidation {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  const budget = moveBudget(ctx, state, op, opts);
  const legs: MoveLeg[] = [];
  let cur: Vec2 = { ...op.pos };
  let curZ = op.z;
  let dropIgnoreLeft = 2; // "only 2" total is ignored" per action
  let total = 0;
  let ladderUsed = opts.ladderClimbUsed ?? false;

  const fail = (reason: string): MoveValidation => ({
    ok: false,
    reason,
    legs,
    total,
    budget,
    endPos: cur,
    endZ: curZ,
  });

  if (path.points.length === 0) return fail('no movement declared');

  for (const next of path.points) {
    const horizontal = dist(cur, next);
    const targetZ = closestSurface(index, next, curZ);
    const dz = targetZ - curZ;

    // --- vertical handling ------------------------------------------------
    if (dz > 1e-6) {
      // Climb. "An operative must be within 1" horizontally and 3" vertically of terrain
      // that's visible to them to climb it."
      if (opts.noClimb) return fail(`${opts.action} cannot climb`);
      if (dz > 3 + 1e-6) return fail(`cannot climb ${dz.toFixed(1)}" (more than 3" vertically)`);
      if (horizontal > 1 + 1e-6 && !isJumpLanding(index, cur, curZ, next, targetZ))
        return fail('must be within 1" horizontally of the terrain to climb it');
      const vertical = ladderAvailable(index, ctx, state, op, cur, next) && !ladderUsed ? 1 : Math.max(2, dz);
      if (vertical === 1) ladderUsed = true;
      const charged = ceil1(vertical);
      legs.push({
        from: cur,
        to: next,
        fromZ: curZ,
        toZ: targetZ,
        kind: 'climb',
        raw: vertical,
        charged,
        ...(vertical === 1 ? { note: 'ladder' } : {}),
      });
      total += charged;
      curZ = targetZ;
    } else if (dz < -1e-6) {
      const drop = -dz;
      const isJump = curZ > 2 + 1e-6 && horizontal > 1 + 1e-6 && isOnVantageAt(index, cur, curZ);
      if (isJump && horizontal > 4 + 1e-6) return fail('a jump can move at most 4" horizontally');
      // "When jumping to a terrain feature, you can ignore its height difference of 1" or less."
      const ignorable = isJump && drop <= 1 + 1e-6 ? drop : Math.min(drop, dropIgnoreLeft);
      dropIgnoreLeft = Math.max(0, dropIgnoreLeft - ignorable);
      const charged = ceil1(Math.max(0, drop - ignorable));
      legs.push({
        from: cur,
        to: next,
        fromZ: curZ,
        toZ: targetZ,
        kind: isJump ? 'jump' : 'drop',
        raw: drop,
        charged,
        ...(ignorable > 0 ? { note: `${ignorable.toFixed(1)}" ignored` } : {}),
      });
      total += charged;
      curZ = targetZ;
    }

    // --- horizontal handling ---------------------------------------------
    if (horizontal > 1e-6) {
      // Accessible terrain: "counts as an additional 1"... Only the centre of an operative's
      // base needs to move through Accessible terrain."
      const access = accessibleCrossings(index, cur, next, curZ);
      const obstructing = obstructingCrossings(index, cur, next);
      const extra = (access.length > 0 ? 1 : 0) + (obstructing.length > 0 ? 1 : 0);
      const charged = ceil1(horizontal + extra);
      legs.push({
        from: cur,
        to: next,
        fromZ: curZ,
        toZ: targetZ,
        kind: access.length > 0 ? 'accessible' : 'horizontal',
        raw: horizontal,
        charged,
        ...(extra > 0 ? { note: `+${extra}" terrain` } : {}),
      });
      total += charged;

      // Wall terrain: "Operatives cannot move over or through Wall terrain."
      const wall = index.walls.find((w) => crossesWall(w, cur, next) && !isOpenAccessPoint(w));
      if (wall) return fail('cannot move through Wall terrain');
    }

    cur = { ...next };
  }

  // --- final position legality -------------------------------------------
  const finalZ = path.endZ ?? curZ;
  const rot = path.endRot ?? op.rot;
  const blocked = baseBlockedByTerrain(index, cur, c.base, rot, finalZ, heightOf(ctx, op));
  if (blocked) return fail(`cannot finish on ${blocked.role ?? 'terrain'} (${blocked.types.join('+')})`);
  if (baseTouchesHazardous(index, cur, c.base, rot)) return fail('a base cannot touch a hazardous area');
  if (finalZ > 1e-6 && !canStandAt(index, cur, finalZ))
    return fail('operatives can only finish a move on Vantage terrain');
  if (outOfBoard(state, cur, op, ctx, rot)) return fail('bases cannot be over the edge of the killzone');

  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = card(ctx, other);
    if (Math.abs(other.z - finalZ) > 1.0) continue;
    if (baseGap(cur, c.base, rot, other.pos, oc.base, other.rot) < -1e-4)
      return fail('a base cannot be placed on another');
  }

  const engagedAtEnd = aliveOperatives(state, otherPlayer(op.player)).some((e) =>
    inControlRange(ctx, { ...state, operatives: { ...state.operatives, [op.id]: { ...op, pos: cur, z: finalZ } } }, {
      ...op,
      pos: cur,
      z: finalZ,
    }, e),
  );
  if (opts.mustFinishEngaged && !engagedAtEnd)
    return fail('a Charge must finish within control range of an enemy operative');
  if (opts.mustNotFinishEngaged && engagedAtEnd)
    return fail('cannot finish this move within control range of an enemy operative');

  if (total > budget + 1e-6) return fail(`move of ${total}" exceeds the ${budget}" budget`);
  if (opts.hardCap !== undefined && total > opts.hardCap + 1e-6)
    return fail(`cannot move more than ${opts.hardCap}" while counteracting`);

  return { ok: true, legs, total, budget, endPos: cur, endZ: finalZ };
}

export function moveBudget(ctx: GameContext, state: GameState, op: OperativeState, opts: MoveOptions): number {
  let base: number;
  if (opts.action === 'Dash') base = 3;
  else if (opts.action === 'Move With Barricade') base = Math.max(0, moveOf(ctx, state, op) - 2);
  else base = moveOf(ctx, state, op);
  base += opts.bonusInches ?? 0;
  const ev = ctx.hooks.emit('onMoveDistance', state, { state, operative: op, action: opts.action, inches: base });
  return ev.inches;
}

function heightOf(ctx: GameContext, op: OperativeState): number {
  return body(ctx, op).height;
}

function closestSurface(index: TerrainIndex, p: Vec2, fromZ: number): number {
  const zs = surfacesAt(index, p);
  // Prefer the surface closest to where we are (climb up one level, or drop to the floor).
  let best = zs[0]!;
  let bestD = Math.abs(best - fromZ);
  for (const z of zs) {
    const d = Math.abs(z - fromZ);
    if (d < bestD) {
      best = z;
      bestD = d;
    }
  }
  return best;
}

function canStandAt(index: TerrainIndex, p: Vec2, z: number): boolean {
  if (z <= 1e-6) return true;
  return Math.abs(surfaceAt(index, p, z + 0.05) - z) < 0.05;
}

function isOnVantageAt(index: TerrainIndex, p: Vec2, z: number): boolean {
  return index.standable.some(
    (part) => hasType(part, 'Vantage') && Math.abs(part.z1 - z) < 0.05 && pointInsidePart(part.poly, p),
  );
}

function pointInsidePart(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y + 1e-12) + pi.x)
      inside = !inside;
  }
  return inside;
}

function isJumpLanding(index: TerrainIndex, from: Vec2, fromZ: number, to: Vec2, toZ: number): boolean {
  // "When jumping to a terrain feature, you can ignore its height difference of 1" or less."
  return fromZ > 2 && toZ - fromZ <= 1 + 1e-6 && dist(from, to) <= 4 + 1e-6;
}

function ladderAvailable(
  index: TerrainIndex,
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  from: Vec2,
  to: Vec2,
): boolean {
  const ladders = index.parts.filter((p) => p.feature.kind === 'equipment.ladder');
  if (ladders.length === 0) return false;
  const c = card(ctx, op);
  return ladders.some(
    (l) =>
      baseGap(from, c.base, op.rot, { x: l.bounds.min.x, y: l.bounds.min.y }, { shape: 'round', mm: 20 }, 0) <= 1 ||
      dist(to, { x: (l.bounds.min.x + l.bounds.max.x) / 2, y: (l.bounds.min.y + l.bounds.max.y) / 2 }) <= 1.5,
  );
}

function crossesWall(wall: { poly: Vec2[] }, a: Vec2, b: Vec2): boolean {
  const poly = wall.poly;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segInt(a, b, poly[j]!, poly[i]!)) return true;
  }
  return pointInsidePart(poly, a) || pointInsidePart(poly, b);
}

function isOpenAccessPoint(part: { role?: string; state?: string }): boolean {
  return part.role === 'accessPoint' && part.state === 'open';
}

function segInt(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function outOfBoard(state: GameState, p: Vec2, op: OperativeState, ctx: GameContext, rot: number): boolean {
  const c = card(ctx, op);
  const r = c.base.shape === 'round' ? c.base.mm / 25.4 / 2 : Math.max(c.base.mm[0], c.base.mm[1]) / 25.4 / 2;
  const { w, h } = state.map.board;
  return p.x - r < -1e-6 || p.y - r < -1e-6 || p.x + r > w + 1e-6 || p.y + r > h + 1e-6;
}

/**
 * Reachability field for the AI and for "can this operative reach X?" previews.
 * 0.5" grid flood fill respecting climb/drop/jump/Wall/Accessible/hazardous.
 */
export function reachableCells(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  budget: number,
  step = 0.5,
): Map<string, { pos: Vec2; z: number; cost: number }> {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  const h = heightOf(ctx, op);
  const out = new Map<string, { pos: Vec2; z: number; cost: number }>();
  const key = (p: Vec2, z: number) => `${p.x.toFixed(1)},${p.y.toFixed(1)},${z.toFixed(1)}`;
  const start = { pos: { ...op.pos }, z: op.z, cost: 0 };
  const queue: { pos: Vec2; z: number; cost: number }[] = [start];
  out.set(key(start.pos, start.z), start);
  const dirs = [
    [step, 0],
    [-step, 0],
    [0, step],
    [0, -step],
    [step, step],
    [step, -step],
    [-step, step],
    [-step, -step],
  ];
  let guard = 0;
  while (queue.length > 0 && guard++ < 20000) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift()!;
    for (const [dx, dy] of dirs) {
      const np = { x: cur.pos.x + dx!, y: cur.pos.y + dy! };
      if (np.x < 0 || np.y < 0 || np.x > state.map.board.w || np.y > state.map.board.h) continue;
      const nz = closestSurface(index, np, cur.z);
      const dz = nz - cur.z;
      if (dz > 3 + 1e-6) continue;
      const stepCost = Math.hypot(dx!, dy!) + (dz > 0 ? Math.max(2, dz) : 0) + (dz < -2 ? -dz - 2 : 0);
      const cost = cur.cost + stepCost;
      if (cost > budget + 1e-6) continue;
      if (baseBlockedByTerrain(index, np, c.base, op.rot, nz, h)) continue;
      if (baseTouchesHazardous(index, np, c.base, op.rot)) continue;
      if (index.walls.some((w) => crossesWall(w, cur.pos, np) && !isOpenAccessPoint(w))) continue;
      const k = key(np, nz);
      const prev = out.get(k);
      if (prev && prev.cost <= cost) continue;
      const node = { pos: np, z: nz, cost };
      out.set(k, node);
      queue.push(node);
    }
  }
  return out;
}

/** Human-readable diagnostics for the UI, naming the rule that blocked the move. */
export function explainIllegalMove(v: MoveValidation): string {
  return v.ok ? '' : (v.reason ?? 'illegal move');
}

export { isVisible };
