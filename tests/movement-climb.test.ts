/**
 * Climbing OVER terrain, which the route planner could not do.
 *
 * Owner report, with a screenshot: a Reposition across a 2"-high Volkus wall was refused with
 * "cannot move through wall (Heavy)". `validateMove` was never the problem — a hand-built
 * three-increment climb-over has always validated. The reach field was: it gave every cell one
 * elevation, `closestSurface(np, cur.z)`, which from the killzone floor is always 0, so no cell
 * above the floor existed anywhere on any map and there was nothing for `routePath` to turn
 * into an up / across / down triple.
 *
 * Every test quotes the rule it pins.
 */
import { describe, expect, it } from 'vitest';
import { reachableCells, routePath, validateMove } from '../src/core/movement.ts';
import { terrain } from '../src/core/context.ts';
import type { IndexedPart } from '../src/core/terrain.ts';
import type { GameState, OperativeState } from '../src/core/types.ts';
import { deathwatch } from '../src/teams/deathwatch/index.ts';
import { battle, mapById, opWith, rosterIncluding, teamContext } from './teams/harness.ts';

const MARKSMAN = 'deathwatch.marksman-veteran';

/** One operative alone on a real killzone, with everybody else parked out of the way. */
function loneOperative(mapId: string): {
  ctx: ReturnType<typeof teamContext>;
  state: GameState;
  op: OperativeState;
} {
  const ctx = teamContext([deathwatch], { seed: 3 });
  const state = battle({
    ctx,
    map: mapById(mapId),
    p1: { module: deathwatch, picks: rosterIncluding(deathwatch, [MARKSMAN]) },
    p2: { module: deathwatch, picks: rosterIncluding(deathwatch, [MARKSMAN]) },
  });
  const id = opWith(state, 'p1', MARKSMAN);
  for (const o of Object.values(state.operatives)) if (o.id !== id) o.pos = { x: 28, y: 20 };
  return { ctx, state, op: state.operatives[id]! };
}

const wallsOf = (parts: IndexedPart[], height: number): IndexedPart[] =>
  parts.filter((p) => p.role === 'wall' && Math.abs(p.z1 - height) < 1e-6);

/**
 * Stand the operative just off the near face of `part`, approaching across its THIN axis — a
 * wall is a long thin box, and walking at its end runs along it rather than over it.
 */
function standBeside(op: OperativeState, part: IndexedPart, clearance = 0.9): { across: 'x' | 'y'; mid: number } {
  const w = part.bounds.max.x - part.bounds.min.x;
  const hgt = part.bounds.max.y - part.bounds.min.y;
  op.z = 0;
  if (w <= hgt) {
    const mid = (part.bounds.min.y + part.bounds.max.y) / 2;
    op.pos = { x: part.bounds.min.x - clearance, y: mid };
    return { across: 'x', mid };
  }
  const mid = (part.bounds.min.x + part.bounds.max.x) / 2;
  op.pos = { x: mid, y: part.bounds.min.y - clearance };
  return { across: 'y', mid };
}

describe('climbing over terrain — killzones.txt:160 "they must move around, climb over or drop/jump off it"', () => {
  it('the reach field crosses a 2" Heavy wall, and the route it returns is the rules’ own three increments', () => {
    const { ctx, state, op } = loneOperative('volkus-1');
    const index = terrain(ctx, state);
    const wall = wallsOf(index.parts, 2)[0]!;
    const { across, mid } = standBeside(op, wall);

    const field = reachableCells(ctx, state, op, 6);
    const beyond = (c: { pos: { x: number; y: number } }): boolean =>
      across === 'x'
        ? c.pos.x > wall.bounds.max.x + 0.1 && Math.abs(c.pos.y - mid) < 1.2
        : c.pos.y > wall.bounds.max.y + 0.1 && Math.abs(c.pos.x - mid) < 1.2;
    const far = [...field.values()].filter(beyond).sort((a, b) => a.cost - b.cost);
    expect(far.length, 'cells beyond the wall on this row').toBeGreaterThan(0);

    const target = far[0]!;
    expect(target.via, 'reached by climbing over, not by walking round').toBeDefined();
    expect(target.via!.top).toBe(wall.z1);

    // killzones.txt:182 — "The operative moves up for 2" (a 1" distance, but treated as the
    // minimum 2") until it's above the highest point it must climb over. It moves across N"
    // until its base is fully past the terrain feature, then drops down for 0" (as the drop is
    // less than 2")."
    const path = routePath(ctx, state, op, field, target)!;
    expect(path.zs).toEqual([wall.z1, wall.z1, 0]);
    const v = validateMove(ctx, state, op, path, { action: 'Reposition' });
    expect(v.ok, v.ok ? '' : v.reason).toBe(true);
    expect(v.legs.map((l) => l.kind)).toEqual(['climb', 'horizontal', 'drop']);
    expect(v.legs[0]!.charged, 'each climb is treated as a minimum of 2" vertically').toBe(2);
    expect(v.legs[2]!.charged, 'a vertical drop of 2" or less is ignored').toBeCloseTo(0, 9);
    // …and the field's own price is the one the engine charges, so the cell is not offered at
    // one cost and then refused at another.
    expect(v.total).toBe(target.cost);
    expect(v.total).toBeLessThanOrEqual(6);
  });

  it('killzones.txt:163 — "within 1\\" horizontally and 3\\" vertically … to climb it"', () => {
    const { ctx, state, op } = loneOperative('volkus-1');
    const index = terrain(ctx, state);
    // Volkus ships wall parts at 2", 3", 3.5", 4" and 7". The reach is 3", so the first two
    // are climbable and the rest are not — they need the Accessible door instead.
    for (const [height, climbable] of [
      [2, true],
      [3, true],
      [3.5, false],
      [4, false],
    ] as const) {
      const wall = wallsOf(index.parts, height)[0];
      if (!wall) continue;
      standBeside(op, wall);
      const field = reachableCells(ctx, state, op, 6);
      const over = [...field.values()].filter((c) => c.via?.top === height);
      expect(over.length > 0, `a ${height}" wall should ${climbable ? '' : 'not '}be climbable`).toBe(climbable);
    }
  });

  it('killzones.txt:464 — "Operatives cannot move over or through Wall terrain"', () => {
    // Gallowdark's walls are 2.362" high, well inside the 3" climb reach, and every one of them
    // is `['Heavy', 'Wall']`. Height is not what makes them impassable; the Wall type is.
    const { ctx, state, op } = loneOperative('gallowdark-1');
    const index = terrain(ctx, state);
    const wall = index.parts.find((p) => p.typeSet.has('Wall'))!;
    expect(wall.z1).toBeLessThan(3);
    standBeside(op, wall, 0.7);
    const field = reachableCells(ctx, state, op, 6);
    expect([...field.values()].some((c) => c.via)).toBe(false);
  });

  it('core-rules.txt:269 — a Dash "cannot climb during this move, but it can drop and jump"', () => {
    const { ctx, state, op } = loneOperative('volkus-1');
    const index = terrain(ctx, state);
    const wall = wallsOf(index.parts, 2)[0]!;
    standBeside(op, wall);
    expect([...reachableCells(ctx, state, op, 6, 0.5, { noClimb: true }).values()].some((c) => c.via)).toBe(false);
    expect([...reachableCells(ctx, state, op, 6).values()].some((c) => c.via)).toBe(true);
  });
});

describe('the reach field has levels at all — killzones.txt:163', () => {
  it('standing beside a Vantage roof, the field reaches it', () => {
    // The other half of the same defect, and the larger one: `closestSurface` returns the level
    // NEAREST the operative's feet and `surfacesAt` always offers 0, so from the floor the
    // answer was always 0. Every Vantage level in the game was unreachable through the preview.
    const { ctx, state, op } = loneOperative('volkus-1');
    const index = terrain(ctx, state);
    const roof = index.standable.filter((p) => p.z1 > 0).sort((a, b) => a.z1 - b.z1)[0]!;
    op.pos = { x: roof.bounds.min.x - 0.7, y: (roof.bounds.min.y + roof.bounds.max.y) / 2 };
    op.z = 0;
    const field = reachableCells(ctx, state, op, 6);
    const up = [...field.values()].filter((c) => c.z > 0);
    expect(up.length, 'cells on the roof').toBeGreaterThan(0);
    expect(up.every((c) => c.z === roof.z1)).toBe(true);

    // …and the route to one of them validates as a climb.
    const target = up.sort((a, b) => a.cost - b.cost)[0]!;
    const path = routePath(ctx, state, op, field, target)!;
    const v = validateMove(ctx, state, op, path, { action: 'Reposition' });
    expect(v.ok, v.ok ? '' : v.reason).toBe(true);
    expect(v.endZ).toBe(roof.z1);
  });
});
