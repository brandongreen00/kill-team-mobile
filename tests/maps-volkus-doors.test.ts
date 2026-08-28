/**
 * The Volkus buildings are enterable, and their walls are not.
 *
 * These two properties are one bug, not two. `validateMove` used to check only the END of a
 * move against terrain, so an operative walked through a stronghold's Heavy wall in a straight
 * line and the app raised no objection. And because `_volkus_doors` only ever resolved
 * Stronghold B's door, eighteen of the twenty-four doorways in `data/maps/volkus/**` were
 * unmodelled holes in a wall ring — free to cross, no cover, obscuring nobody.
 *
 * Fixing only the first would have sealed those buildings shut: Stronghold A's doorway is
 * 1.17" wide and a 32mm base is 1.26", so the base does not fit through it. It only works
 * because the door is Accessible terrain, where "only the centre of an operative's base needs
 * to move through Accessible terrain, so base sizes are irrelevant" (Killzones § Accessible).
 *
 * So this walks the real shipped maps: through every door, and never through a wall.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { validateMove } from '../src/core/movement.ts';
import { buildTerrainIndex } from '../src/core/terrain.ts';
import { testContext } from './fixtures.ts';
import type { GameContext } from '../src/core/context.ts';
import type { GameState, KillzoneMap, TerrainPart, Vec2 } from '../src/core/types.ts';

const MAPS_DIR = join(process.cwd(), 'data', 'maps', 'volkus');
const DOOR_KINDS = new Set(['volkus.strongholdA', 'volkus.strongholdB', 'volkus.largeRuin']);

const maps: KillzoneMap[] = readdirSync(MAPS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(MAPS_DIR, f), 'utf8')) as KillzoneMap);

const bbox = (poly: Vec2[]) => ({
  x0: Math.min(...poly.map((p) => p.x)),
  y0: Math.min(...poly.map((p) => p.y)),
  x1: Math.max(...poly.map((p) => p.x)),
  y1: Math.max(...poly.map((p) => p.y)),
});

/** A point `d` inches either side of a thin part, along its short axis. */
function acrossFrom(part: TerrainPart, d: number): [Vec2, Vec2] {
  const b = bbox(part.poly);
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return b.x1 - b.x0 < b.y1 - b.y0
    ? [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]
    : [{ x: cx, y: cy - d }, { x: cx, y: cy + d }];
}

/** A one-operative battle on a real map, with the operative dropped wherever we need it. */
function battleOn(ctx: GameContext, map: KillzoneMap): GameState {
  let s = createBattle(ctx, { map, seed: 7 });
  const pick = [{ datacardId: 'test.trooper' }];
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: pick }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: pick }, ctx).state;
  return s;
}

describe('Killzone: Volkus — doors and walls', () => {
  it('every stronghold and large ruin has exactly one Accessible + Heavy door', () => {
    const seen: string[] = [];
    for (const map of maps) {
      for (const feat of map.features) {
        if (!DOOR_KINDS.has(feat.kind)) continue;
        const doors = feat.parts.filter((p) => p.role === 'door');
        seen.push(`${feat.id}:${doors.length}`);
        expect(doors).toHaveLength(1);
        // Killzones § Stronghold B: "The door is Accessible and Heavy terrain."
        expect([...doors[0]!.types].sort()).toEqual(['Accessible', 'Heavy']);
      }
    }
    expect(seen).toHaveLength(24);
  });

  it('an operative moves through a door — "only the centre of an operative\'s base needs to move through Accessible terrain"', () => {
    const ctx = testContext();
    for (const map of maps) {
      const s = battleOn(ctx, map);
      const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
      for (const feat of map.features) {
        if (!DOOR_KINDS.has(feat.kind)) continue;
        const door = feat.parts.find((p) => p.role === 'door')!;
        const [from, to] = acrossFrom(door, 1.6);
        op.pos = { ...from };
        op.z = 0;
        const v = validateMove(ctx, s, op, { points: [to] }, { action: 'Reposition' });
        // Either the doorway is walkable, or the far side is not somewhere a base fits —
        // never "you cannot move through terrain", which is what a sealed door would say.
        expect(`${map.id} ${feat.id}: ${v.reason ?? 'ok'}`).not.toContain('cannot move through');
      }
    }
  });

  it('an operative cannot walk through a wall — "operatives cannot move through terrain"', () => {
    const ctx = testContext();
    let checked = 0;
    for (const map of maps) {
      const s = battleOn(ctx, map);
      const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
      const index = buildTerrainIndex(map, s);
      for (const feat of map.features) {
        if (!DOOR_KINDS.has(feat.kind)) continue;
        for (const part of feat.parts) {
          if (part.role !== 'wall') continue;
          const b = bbox(part.poly);
          // Only long, thin, clearly-traced wall bars: a sliver is not a wall to test against.
          const thin = Math.min(b.x1 - b.x0, b.y1 - b.y0);
          const long = Math.max(b.x1 - b.x0, b.y1 - b.y0);
          if (thin < 0.15 || long < 2) continue;
          const [from, to] = acrossFrom(part, 1.2);
          // Skip a spot where the crossing would clip a neighbouring door or another piece.
          const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
          if (index.parts.some((p) => p.role === 'door' && p.feature.id === feat.id &&
            Math.hypot((bbox(p.poly).x0 + bbox(p.poly).x1) / 2 - mid.x,
                       (bbox(p.poly).y0 + bbox(p.poly).y1) / 2 - mid.y) < 1.5)) continue;
          op.pos = { ...from };
          op.z = 0;
          const v = validateMove(ctx, s, op, { points: [to] }, { action: 'Reposition' });
          expect(`${map.id} ${part.id}: ${v.ok ? 'WALKED THROUGH THE WALL' : v.reason}`).not.toContain(
            'WALKED THROUGH',
          );
          checked++;
        }
      }
    }
    // Guard against the filters quietly excluding everything.
    expect(checked).toBeGreaterThan(50);
  });
});
