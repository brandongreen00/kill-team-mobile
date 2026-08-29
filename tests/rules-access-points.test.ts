/**
 * Hatchways and breach points: the two actions aimed at a piece of terrain.
 *
 * Three things were wrong with them and none was reachable through a rule test, because both
 * actions had only ever been exercised on synthetic fixtures with one hand-built access point:
 *
 *  1. `Operate Hatch.check` never read `opensAs`, so on Tomb World — where A1 and B2 carry
 *     BREACH POINTS, not hatchways (keys/TW1.jpg, keys/TW2.jpg) — the aim list offered every
 *     breach point as a 1AP Operate Hatch, and the reducer opened it. "Open or close a
 *     HATCHWAY that's access point is within the operative's control range" and "BREACH 2AP:
 *     Open a closed breach point" are different actions on different terrain.
 *  2. Control range was measured to a synthetic 20mm marker at the access point's bounding-box
 *     CENTRE. An access point is ~2" wide, so an operative standing at the edge of a doorway,
 *     plainly within 1" of it, measured 1.2" from that centre and was refused.
 *  3. The aim list named its options `access point gallowdark-1.A3-1.access`, which does not
 *     say which of the sixteen hatchways on the board it is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionTargetOptions, getAction } from '../src/core/actions.ts';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { buildTerrainIndex } from '../src/core/terrain.ts';
import { testContext } from './fixtures.ts';
import type { GameContext } from '../src/core/context.ts';
import type { GameState, KillzoneMap, Vec2 } from '../src/core/types.ts';

const mapOf = (kz: string, id: string): KillzoneMap =>
  JSON.parse(readFileSync(join(process.cwd(), 'data', 'maps', kz, `${id}.json`), 'utf8')) as KillzoneMap;

const tombWorld = mapOf('tomb-world', 'tomb-world-2');
const gallowdark = mapOf('gallowdark', 'gallowdark-1');

function battleOn(ctx: GameContext, map: KillzoneMap): GameState {
  let s = createBattle(ctx, { map, seed: 7 });
  const pick = [{ datacardId: 'test.trooper' }];
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: pick }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: pick }, ctx).state;
  return s;
}

const bbox = (poly: readonly Vec2[]) => ({
  x0: Math.min(...poly.map((p) => p.x)),
  y0: Math.min(...poly.map((p) => p.y)),
  x1: Math.max(...poly.map((p) => p.x)),
  y1: Math.max(...poly.map((p) => p.y)),
});

/** A point `d` inches to one side of a thin part, level with the point `t` along its length. */
function beside(poly: readonly Vec2[], d: number, t: number): Vec2 {
  const b = bbox(poly);
  const horiz = b.x1 - b.x0 >= b.y1 - b.y0;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return horiz
    ? { x: b.x0 + (b.x1 - b.x0) * t, y: cy + d }
    : { x: cx + d, y: b.y0 + (b.y1 - b.y0) * t };
}

describe('access points — hatchways and breach points', () => {
  it('Tomb World prints breach points on A1 and B2 and hatchways on A3, A4 and B3', () => {
    const byKind: Record<string, Set<string>> = {};
    for (const f of tombWorld.features) {
      for (const p of f.parts) {
        if (p.role !== 'accessPoint') continue;
        (byKind[p.opensAs!] ??= new Set()).add(f.label!);
      }
    }
    expect([...(byKind['breachWall'] ?? [])].sort()).toEqual(['A1', 'B2']);
    expect([...(byKind['hatch'] ?? [])].sort()).toEqual(['A3', 'A4', 'B3']);
  });

  it('Operate Hatch refuses a breach point, and Breach refuses a hatchway', () => {
    const ctx = testContext();
    const s = battleOn(ctx, tombWorld);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const index = buildTerrainIndex(tombWorld, s);
    const hatch = index.parts.find((p) => p.role === 'accessPoint' && p.opensAs === 'hatch')!;
    const breach = index.parts.find((p) => p.role === 'accessPoint' && p.opensAs === 'breachWall')!;
    expect(hatch).toBeTruthy();
    expect(breach).toBeTruthy();

    // Stand right beside the breach point, so distance is never the reason.
    op.pos = beside(breach.poly, 0.7, 0.5);
    op.z = 0;
    const hatchOnBreach = getAction('Operate Hatch')!.check(ctx, s, op, { partId: breach.id });
    expect(hatchOnBreach.ok).toBe(false);
    expect(hatchOnBreach.reason).toContain('breach point, not a hatchway');
    expect(getAction('Breach')!.check(ctx, s, op, { partId: breach.id }).ok).toBe(true);

    op.pos = beside(hatch.poly, 0.7, 0.5);
    const breachOnHatch = getAction('Breach')!.check(ctx, s, op, { partId: hatch.id });
    expect(breachOnHatch.ok).toBe(false);
    expect(breachOnHatch.reason).toContain('hatchway, not a breach point');
    expect(getAction('Operate Hatch')!.check(ctx, s, op, { partId: hatch.id }).ok).toBe(true);
  });

  it('control range is measured to the access point, not to its centre', () => {
    const ctx = testContext();
    const s = battleOn(ctx, gallowdark);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const index = buildTerrainIndex(gallowdark, s);
    const hatch = index.parts.find((p) => p.role === 'accessPoint')!;
    const b = bbox(hatch.poly);
    const length = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    // A Gallowdark hatchway is ~2" wide, so its far end is ~1" from its centre. Stand a
    // finger's width off one END of it: within control range of the hatchway, and further
    // than 1" from the point the old check measured to.
    expect(length).toBeGreaterThan(1.6);
    op.pos = beside(hatch.poly, 0.7, 0.04);
    op.z = 0;
    const centre = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    expect(Math.hypot(op.pos.x - centre.x, op.pos.y - centre.y)).toBeGreaterThan(1);
    expect(getAction('Operate Hatch')!.check(ctx, s, op, { partId: hatch.id }).ok).toBe(true);
  });

  it('an operative across the killzone still cannot reach a hatchway', () => {
    const ctx = testContext();
    const s = battleOn(ctx, gallowdark);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const index = buildTerrainIndex(gallowdark, s);
    const hatch = index.parts.find((p) => p.role === 'accessPoint')!;
    op.pos = beside(hatch.poly, 6, 0.5);
    op.z = 0;
    const v = getAction('Operate Hatch')!.check(ctx, s, op, { partId: hatch.id });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('not within control range');
  });

  it('the aim list names a hatchway by the wall it is cut into, never by its part id', () => {
    const ctx = testContext();
    const s = battleOn(ctx, gallowdark);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const index = buildTerrainIndex(gallowdark, s);
    const hatch = index.parts.find((p) => p.role === 'accessPoint')!;
    op.pos = beside(hatch.poly, 0.7, 0.5);
    op.z = 0;
    const opts = actionTargetOptions(ctx, s, op, getAction('Operate Hatch')!);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.label).not.toContain(o.id);
      expect(o.label).toMatch(/^(open )?hatchway in wall [A-B]\d — \d+\.\d" away$/);
    }
  });

  it('opening a hatchway opens the way through it, and closing it shuts it again', () => {
    const ctx = testContext();
    const s = battleOn(ctx, gallowdark);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const hatch = buildTerrainIndex(gallowdark, s).parts.find((p) => p.role === 'accessPoint')!;
    op.pos = beside(hatch.poly, 0.7, 0.5);
    op.z = 0;
    const closed = buildTerrainIndex(gallowdark, s).byId.get(hatch.id)!;
    expect(closed.solid).toBe(true);
    expect(closed.blocksVisibility).toBe(true);

    expect(getAction('Operate Hatch')!.perform(ctx, s, op, { partId: hatch.id }).ok).toBe(true);
    const open = buildTerrainIndex(gallowdark, s).byId.get(hatch.id)!;
    expect(open.state).toBe('open');
    expect(open.solid).toBe(false);
    expect(open.blocksVisibility).toBe(false);

    expect(getAction('Operate Hatch')!.perform(ctx, s, op, { partId: hatch.id }).ok).toBe(true);
    expect(buildTerrainIndex(gallowdark, s).byId.get(hatch.id)!.solid).toBe(true);
  });
});
