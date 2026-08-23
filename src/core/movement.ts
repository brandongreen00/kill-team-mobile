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
import { dist, baseGap, baseRadius } from './geometry.ts';
import { terrain, type GameContext } from './context.ts';
import {
  accessibleCrossings,
  baseBlockedByTerrain,
  baseTouchesHazardous,
  featureIdsSupporting,
  obstructingCrossings,
  pathBlockedByTerrain,
  surfaceAt,
  surfacesAt,
  hasType,
  type TerrainIndex,
} from './terrain.ts';
import { aliveOperatives, card, inControlRange, moveOf, body } from './state.ts';
import { isVisible, withinControlRange } from './visibility.ts';
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
  /** "It can move through enemy operatives" — a printed permission, never the default. */
  mayMoveThroughEnemies?: boolean;
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

/** The move actions that take a MovePath. */
export type MoveAction = 'Reposition' | 'Dash' | 'Fall Back' | 'Charge';

/**
 * The exact `MoveOptions` the reducer will use for a move action — never looser. Both the AI
 * and the board's move preview build candidate paths against this, so what the preview draws
 * as reachable is what `PerformAction` will accept.
 */
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
  opts = movePermissions(ctx, state, op, opts);
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

  for (let i = 0; i < path.points.length; i++) {
    const next = path.points[i]!;
    const horizontal = dist(cur, next);
    const startZ = curZ;
    const declaredZ = path.zs?.[i];
    const targetZ = declaredZ !== undefined ? declaredZ : closestSurface(index, next, curZ);
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
      const wall = index.walls.find((w) => w.solid !== false && crossesWall(w, cur, next) && !isOpenAccessPoint(w));
      if (wall) return fail('cannot move through Wall terrain');

      // "Operatives cannot move through terrain — they must move around, climb over or
      // drop/jump off it." An increment that also changes level IS the climb over / drop off,
      // so the feature being climbed or dropped from does not block itself.
      const changesLevel = Math.abs(curZ - startZ) > 1e-6;
      const exempt = changesLevel
        ? new Set([
            ...featureIdsSupporting(index, cur, startZ),
            ...featureIdsSupporting(index, next, curZ),
          ])
        : undefined;
      const through = pathBlockedByTerrain(
        index,
        cur,
        next,
        Math.max(startZ, curZ),
        c.base,
        heightOf(ctx, op),
        exempt,
      );
      if (through)
        return fail(`cannot move through ${through.role ?? 'terrain'} (${through.types.join('+')})`);

      // Core rules › Bases: "Friendly operatives can move through other friendly operatives
      // (the base and the miniature), but not through enemy operatives."
      // Core rules › Reposition: "It cannot move within control range of an enemy operative,
      // unless one or more other friendly operatives are already within control range of that
      // enemy operative, in which case it can move within control range of that enemy
      // operative but cannot finish the move there."
      // Both were checked only where the move ENDED, so an operative walked over an enemy's
      // base and through its control range and the reducer raised no objection.
      const blockedBy = enemyOnTheWay(ctx, state, op, cur, next, Math.max(startZ, curZ), opts);
      if (blockedBy) return fail(blockedBy);
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

/**
 * Walk one increment past every living enemy. Returns a reason, or undefined.
 *
 * The base test is absolute — no move may pass through an enemy's base. The control-range
 * test is waived for a Charge and a Fall Back ("it may move within control range of an enemy
 * operative but cannot finish there"), and for the printed exception: an enemy some other
 * friendly operative is already engaged with may be moved past.
 */
/** Fold in any printed permission a rule grants this move (`onMovePermissions`). */
function movePermissions(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  opts: MoveOptions,
): MoveOptions {
  const ev = ctx.hooks.emit('onMovePermissions', state, {
    state,
    operative: op,
    action: opts.action,
    mayEnterEnemyControlRange: opts.mayEnterEnemyControlRange ?? false,
    mayMoveThroughEnemies: opts.mayMoveThroughEnemies ?? false,
  });
  if (ev.mayEnterEnemyControlRange === (opts.mayEnterEnemyControlRange ?? false) &&
      ev.mayMoveThroughEnemies === (opts.mayMoveThroughEnemies ?? false))
    return opts;
  return {
    ...opts,
    mayEnterEnemyControlRange: ev.mayEnterEnemyControlRange,
    mayMoveThroughEnemies: ev.mayMoveThroughEnemies,
  };
}

function enemyOnTheWay(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  from: Vec2,
  to: Vec2,
  z: number,
  opts: MoveOptions,
): string | undefined {
  if (opts.mayMoveThroughEnemies && opts.mayEnterEnemyControlRange) return undefined;
  const enemies = aliveOperatives(state, otherPlayer(op.player)).filter((e) => e.id !== op.id);
  if (enemies.length === 0) return undefined;
  const c = card(ctx, op);
  const rOp = baseRadius(c.base);

  let index: TerrainIndex | undefined;
  let screenedBy: Map<string, boolean> | undefined;

  for (const enemy of enemies) {
    const ec = card(ctx, enemy);
    const rEnemy = baseRadius(ec.base);
    // Cheap rejection first: how close does this increment ever get to the enemy? Almost
    // every enemy is nowhere near almost every increment, and the control-range test below
    // costs two visibility sweeps.
    const near = distancePointToSegment(enemy.pos, from, to);
    const reach = rOp + rEnemy + 1 + 0.05;
    if (near > reach) continue;

    const span = dist(from, to);
    // 0.2" is under half the smallest base radius in the game, so a base cannot slip past an
    // enemy between two samples.
    const steps = Math.max(1, Math.ceil(span / 0.2));
    const eBody = body(ctx, enemy);
    let startedEngagedWith: boolean | undefined;
    const startedEngaged = (e: OperativeState): boolean =>
      (startedEngagedWith ??= inControlRange(ctx, state, op, e));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      if (dist(p, enemy.pos) > reach) continue;
      if (!opts.mayMoveThroughEnemies && baseGap(p, c.base, op.rot, enemy.pos, ec.base, enemy.rot) < -1e-4)
        return `cannot move through ${enemy.letter}'s base`;
      if (opts.mayEnterEnemyControlRange) continue;
      // "It cannot MOVE WITHIN control range" — an enemy it is already within control range
      // of when the move starts is not one it moves within control range of. Without this an
      // operative that is legitimately engaged (Fall Back, or a rule that lets it Dash out of
      // combat) could not move at all, because the start of its own path failed the test.
      // Worked out only once an increment actually enters a control range: it is another
      // visibility sweep, and almost no increment ever gets here.
      if (startedEngaged(enemy)) break;
      index ??= terrain(ctx, state);
      const here = { id: op.id, pos: p, z, rot: op.rot, base: c.base, height: body(ctx, op).height };
      if (!withinControlRange(index, here, eBody)) continue;
      // "…unless one or more other friendly operatives are ALREADY within control range of
      // that enemy operative" — measured before this move, which is the state we are in.
      // Worked out only once an increment actually enters the control range, because it is
      // another visibility sweep per friendly operative.
      screenedBy ??= new Map<string, boolean>();
      let screened = screenedBy.get(enemy.id);
      if (screened === undefined) {
        screened = aliveOperatives(state, op.player).some(
          (f) => f.id !== op.id && inControlRange(ctx, state, f, enemy),
        );
        screenedBy.set(enemy.id, screened);
      }
      if (screened) break; // this enemy may be moved past for the whole increment
      return `cannot move within control range of ${enemy.letter}`;
    }
  }
  return undefined;
}

/** Shortest distance from a point to a line segment. */
function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
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

/** One cell of a reachability field. `from` is the key of the cell it was reached from. */
export interface ReachCell {
  pos: Vec2;
  z: number;
  cost: number;
  from?: string;
}

const cellKey = (p: Vec2, z: number): string => `${p.x.toFixed(1)},${p.y.toFixed(1)},${z.toFixed(1)}`;

/**
 * Reachability field for the AI and for "can this operative reach X?" previews.
 * 0.5" grid flood fill respecting climb/drop/jump/Wall/Accessible/hazardous, and — like
 * `validateMove` — the rule that operatives cannot move through terrain. Each cell records
 * the cell it was reached from, so `routePath` can turn the field back into a legal path
 * that goes AROUND terrain rather than through it.
 */
export function reachableCells(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  budget: number,
  step = 0.5,
): Map<string, ReachCell> {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  const h = heightOf(ctx, op);
  const out = new Map<string, ReachCell>();
  const key = cellKey;
  const start: ReachCell = { pos: { ...op.pos }, z: op.z, cost: 0 };
  const queue: ReachCell[] = [start];
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
      if (index.walls.some((w) => w.solid !== false && crossesWall(w, cur.pos, np) && !isOpenAccessPoint(w))) continue;
      const exempt =
        Math.abs(dz) > 1e-6
          ? new Set([...featureIdsSupporting(index, cur.pos, cur.z), ...featureIdsSupporting(index, np, nz)])
          : undefined;
      if (pathBlockedByTerrain(index, cur.pos, np, Math.max(cur.z, nz), c.base, h, exempt)) continue;
      const k = key(np, nz);
      const prev = out.get(k);
      if (prev && prev.cost <= cost) continue;
      const node: ReachCell = { pos: np, z: nz, cost, from: key(cur.pos, cur.z) };
      out.set(k, node);
      queue.push(node);
    }
  }
  return out;
}

/**
 * Turn a reachability-field cell back into a `MovePath` that goes AROUND terrain.
 *
 * Both the AI and the board's move preview used to declare a single straight-line increment to
 * the destination. That was only ever legal because nothing checked the increment against the
 * terrain it crossed; now that it does, a destination the flood fill reached by walking round a
 * wall needs the path that actually walks round it.
 *
 * The parent chain is followed back to the operative, then greedily simplified: consecutive
 * steps at the same level are merged into one increment for as far as the straight line between
 * them stays legal. Fewer increments matter — "increments are always rounded up to the nearest
 * inch", so every extra corner can cost up to another inch.
 *
 * Returns null if the cell is the operative's own, or its chain is broken.
 */
export function routePath(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  field: Map<string, ReachCell>,
  target: ReachCell,
): MovePath | null {
  const chain: ReachCell[] = [];
  let node: ReachCell | undefined = target;
  const seen = new Set<string>();
  while (node) {
    const k = cellKey(node.pos, node.z);
    if (seen.has(k)) break; // defensive: a cycle would hang the reconstruction
    seen.add(k);
    chain.push(node);
    node = node.from ? field.get(node.from) : undefined;
  }
  chain.reverse();
  if (chain.length < 2) return null;

  const index = terrain(ctx, state);
  const c = card(ctx, op);
  const h = heightOf(ctx, op);
  const straight = (a: ReachCell, b: ReachCell): boolean => {
    if (Math.abs(a.z - b.z) > 1e-6) return false; // a level change is its own increment
    if (index.walls.some((w) => w.solid !== false && crossesWall(w, a.pos, b.pos) && !isOpenAccessPoint(w)))
      return false;
    return pathBlockedByTerrain(index, a.pos, b.pos, a.z, c.base, h) === null;
  };

  const points: Vec2[] = [];
  const zs: number[] = [];
  let i = 0;
  while (i < chain.length - 1) {
    let j = i + 1;
    for (let k = chain.length - 1; k > i + 1; k--) {
      if (straight(chain[i]!, chain[k]!)) {
        j = k;
        break;
      }
    }
    points.push({ ...chain[j]!.pos });
    zs.push(chain[j]!.z);
    i = j;
  }
  if (points.length === 0) return null;
  return { points, zs };
}

/**
 * The cheapest legal path to a destination, or null. Convenience wrapper for callers that have
 * a point rather than a field cell: the field is flooded once and the nearest reached cell to
 * `dest` within half a step is routed to.
 */
export function routeTo(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  dest: Vec2,
  budget: number,
  step = 0.5,
): MovePath | null {
  const field = reachableCells(ctx, state, op, budget, step);
  let best: ReachCell | undefined;
  let bestD = Infinity;
  for (const cell of field.values()) {
    const d = dist(cell.pos, dest);
    if (d < bestD) {
      bestD = d;
      best = cell;
    }
  }
  if (!best || bestD > step) return null;
  const routed = routePath(ctx, state, op, field, best);
  if (!routed) return null;
  // The caller asked for `dest`, not the cell centre the field happened to land on.
  const points = [...routed.points];
  const zs = [...(routed.zs ?? [])];
  points[points.length - 1] = { ...dest };
  return { points, ...(zs.length > 0 ? { zs } : {}) };
}

/** Human-readable diagnostics for the UI, naming the rule that blocked the move. */
export function explainIllegalMove(v: MoveValidation): string {
  return v.ok ? '' : (v.reason ?? 'illegal move');
}

export { isVisible };
