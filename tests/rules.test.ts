import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { validateMove } from '../src/core/movement.ts';
import { buildTerrainIndex, wallRouteDistance } from '../src/core/terrain.ts';
import { counteractCandidates, readyStep, whoActivates } from '../src/core/phases.ts';
import { aplOf, isInjured, moveOf } from '../src/core/state.ts';
import { heavyBlock, rect, testContext, testMap, vantagePlatform } from './fixtures.ts';
import type { GameContext } from '../src/core/context.ts';
import type { GameState, KillzoneMap, TerrainFeature } from '../src/core/types.ts';

function battle(ctx: GameContext, map: KillzoneMap, n = 2): GameState {
  let s = createBattle(ctx, { map, seed: 5 });
  const picks = (k: number) => Array.from({ length: k }, () => ({ datacardId: 'test.trooper' }));
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: picks(n) }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: picks(n) }, ctx).state;
  s.setup.dropZone = { p1: 'p1', p2: 'p2' };
  s.teams.p1.operativeIds.forEach((id, i) => {
    s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: id, pos: { x: 3, y: 6 + i * 3 } }, ctx).state;
  });
  s.teams.p2.operativeIds.forEach((id, i) => {
    s = reduce(s, { t: 'DeployOperative', player: 'p2', operativeId: id, pos: { x: 27, y: 6 + i * 3 } }, ctx).state;
  });
  s = reduce(s, { t: 'FinishSetup' }, ctx).state;
  s.initiative = 'p1';
  s.phase = 'firefight';
  s.activePlayer = 'p1';
  for (const op of Object.values(s.operatives)) op.ready = true;
  return s;
}

describe('movement (Killzones › Terrain and Movement)', () => {
  it('rounds each straight-line increment up to the nearest inch', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    // 3.5" is treated as 4"; the Move stat is 6 so 3.5 + 3.5 = 8" charged, over budget.
    const v = validateMove(ctx, s, op, { points: [{ x: op.pos.x + 3.5, y: op.pos.y }, { x: op.pos.x + 7, y: op.pos.y }] }, {
      action: 'Reposition',
    });
    expect(v.legs.map((l) => l.charged)).toEqual([4, 4]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('exceeds');
  });

  it('treats each climb as a minimum of 2" vertically', () => {
    const ctx = testContext();
    const map = testMap({ features: [vantagePlatform('v', 6, 9, 4, 4, 1)] });
    const s = battle(ctx, map);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    op.pos = { x: 5.5, y: 11 };
    // Within 1" horizontally of the terrain, so the climb is legal.
    const v = validateMove(ctx, s, op, { points: [{ x: 6.3, y: 11 }], zs: [1] }, { action: 'Reposition' });
    const climb = v.legs.find((l) => l.kind === 'climb');
    expect(climb?.charged).toBe(2); // a 1" climb is treated as 2"
  });

  it('Dash cannot climb but may drop ("it cannot climb during this move, but it can drop and jump")', () => {
    const ctx = testContext();
    const map = testMap({ features: [vantagePlatform('v', 6, 9, 4, 4, 2)] });
    const s = battle(ctx, map);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    op.pos = { x: 5.5, y: 11 };
    const climb = validateMove(ctx, s, op, { points: [{ x: 6.3, y: 11 }], zs: [2] }, { action: 'Dash', noClimb: true });
    expect(climb.ok).toBe(false);
    expect(climb.reason).toContain('cannot climb');
  });

  it('ignores 2" of vertical distance dropped per ACTION, not per drop', () => {
    const ctx = testContext();
    const map = testMap({ features: [vantagePlatform('v', 6, 9, 4, 4, 4)] });
    const s = battle(ctx, map);
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    op.pos = { x: 8, y: 11 };
    op.z = 4;
    const v = validateMove(ctx, s, op, { points: [{ x: 11, y: 11 }], zs: [0] }, { action: 'Reposition' });
    const drop = v.legs.find((l) => l.kind === 'drop' || l.kind === 'jump');
    // 4" drop with the first 2" ignored -> 2" charged.
    expect(drop?.charged).toBe(2);
  });

  it('a base cannot be over the edge of the killzone', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const v = validateMove(ctx, s, op, { points: [{ x: 0.1, y: 11 }] }, { action: 'Reposition' });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('edge of the killzone');
  });

  it('a Charge must finish within control range of an enemy operative', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const v = validateMove(ctx, s, op, { points: [{ x: 8, y: 6 }] }, {
      action: 'Charge',
      bonusInches: 2,
      mustFinishEngaged: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('within control range');
  });
});

describe('Wall terrain (Gallowdark / Tomb World)', () => {
  const wall = (id: string, x: number, y: number, w: number, h: number): TerrainFeature => ({
    id,
    kind: 'gallowdark.wall',
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      { id: `${id}.p`, featureId: id, poly: rect(x, y, w, h), z0: 0, z1: 4, types: ['Heavy', 'Wall'], role: 'wall' },
    ],
  });

  it('measures distances around walls, not through them', () => {
    const map = testMap({ features: [wall('w1', 10, 4, 0.3, 14)] });
    const index = buildTerrainIndex(map);
    const straight = 6;
    const routed = wallRouteDistance(index, { x: 7, y: 11 }, { x: 13, y: 11 });
    expect(routed).toBeGreaterThan(straight);
  });

  it('blocks visibility regardless of the wall height', () => {
    const short: TerrainFeature = {
      ...wall('w2', 10, 4, 0.3, 14),
      parts: [
        {
          id: 'w2.p',
          featureId: 'w2',
          poly: rect(10, 4, 0.3, 14),
          z0: 0,
          z1: 0.5, // deliberately shorter than a model
          types: ['Heavy', 'Wall'],
          role: 'wall',
        },
      ],
    };
    const map = testMap({ features: [short] });
    const index = buildTerrainIndex(map);
    const a = { id: 'a', pos: { x: 7, y: 11 }, z: 0, rot: 0, base: { shape: 'round' as const, mm: 32 }, height: 1.6 };
    const b = { id: 'b', pos: { x: 13, y: 11 }, z: 0, rot: 0, base: { shape: 'round' as const, mm: 32 }, height: 1.6 };
    // "Visibility cannot be determined over or through Wall terrain."
    expect(buildTerrainIndex(map).walls).toHaveLength(1);
    const { isVisible } = require('../src/core/visibility.ts') as typeof import('../src/core/visibility.ts');
    expect(isVisible(index, a, b).visible).toBe(false);
  });
});

describe('Close Quarters gating (docs/DECISIONS.md D-002/D-003)', () => {
  it('Guard is not offered on an open killzone', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const a = s.teams.p1.operativeIds[0]!;
    let next = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    const out = reduce(next, { t: 'PerformAction', operativeId: a, action: 'Guard' }, ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Close Quarters/);
  });

  it('Guard is available in a Close Quarters killzone', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap({ closeQuarters: true }));
    const a = s.teams.p1.operativeIds[0]!;
    let next = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    const out = reduce(next, { t: 'PerformAction', operativeId: a, action: 'Guard' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[a]!.onGuard).toBe(true);
  });
});

describe('turning-point structure', () => {
  it('Ready: 1CP each, 2CP for the player without initiative from TP2', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    s.turningPoint = 2;
    s.initiative = 'p1';
    s.teams.p1.cp = 0;
    s.teams.p2.cp = 0;
    readyStep(ctx, s);
    expect(s.teams.p1.cp).toBe(1);
    expect(s.teams.p2.cp).toBe(2);
  });

  it('counteract: an expended Engage operative, once per turning point, and not an activation', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap(), 1);
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    s.operatives[a]!.expended = true;
    s.operatives[a]!.ready = false;
    s.operatives[a]!.order = 'engage';
    s.activePlayer = 'p1';
    const turn = whoActivates(s);
    expect(turn).toEqual({ player: 'p1', mode: 'counteract' });
    expect(counteractCandidates(ctx, s, 'p1').map((o) => o.id)).toEqual([a]);
    const out = reduce(s, { t: 'Counteract', player: 'p1', operativeId: a }, ctx);
    expect(out.ok).toBe(true);
    // "Counteracting isn't an activation... action restrictions won't apply."
    expect(out.state.operatives[a]!.actionsThisActivation).toEqual([]);
    expect(out.state.operatives[b]!.ready).toBe(true);
  });
});

describe('damage, injured and APL clamping', () => {
  it('injured: -2" Move (floor 4") and Hit worsened by 1', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    expect(moveOf(ctx, s, op)).toBe(6);
    op.wounds = 4; // fewer than half of 10
    expect(isInjured(ctx, op)).toBe(true);
    expect(moveOf(ctx, s, op)).toBe(4);
  });

  it('APL changes clamp to -1/+1 no matter how many apply', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const op = s.operatives[s.teams.p1.operativeIds[0]!]!;
    op.aplMods = [-1, -1, -1];
    expect(aplOf(ctx, s, op)).toBe(1);
    op.aplMods = [1, 1, 1];
    expect(aplOf(ctx, s, op)).toBe(3);
  });
});

describe('counteract is one free 1AP action, capped at 2" (core rules › Counteract)', () => {
  function counteracting(): { s: GameState; ctx: GameContext; id: string } {
    const ctx = testContext();
    const s = battle(ctx, testMap(), 1);
    const id = s.teams.p1.operativeIds[0]!;
    s.operatives[id]!.expended = true;
    s.operatives[id]!.ready = false;
    s.operatives[id]!.order = 'engage';
    s.activePlayer = 'p1';
    const out = reduce(s, { t: 'Counteract', player: 'p1', operativeId: id }, ctx);
    expect(out.ok).toBe(true);
    return { s: out.state, ctx, id };
  }

  it('allows exactly one action, not an unlimited free turn', () => {
    const { s, ctx, id } = counteracting();
    const first = reduce(s, { t: 'PerformAction', operativeId: id, action: 'Reposition', params: { path: { points: [{ x: 4.5, y: 6 }] } } }, ctx);
    expect(first.ok, first.reason).toBe(true);
    const second = reduce(first.state, { t: 'PerformAction', operativeId: id, action: 'Dash', params: { path: { points: [{ x: 5.5, y: 6 }] } } }, ctx);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('only perform one action');
  });

  it('caps the move at 2", whatever the Move stat says', () => {
    const { s, ctx, id } = counteracting();
    const far = reduce(s, { t: 'PerformAction', operativeId: id, action: 'Reposition', params: { path: { points: [{ x: 8, y: 6 }] } } }, ctx);
    expect(far.ok).toBe(false);
    expect(far.reason).toContain('more than 2"');
    const near = reduce(s, { t: 'PerformAction', operativeId: id, action: 'Reposition', params: { path: { points: [{ x: 4.9, y: 6 }] } } }, ctx);
    expect(near.ok, near.reason).toBe(true);
  });

  it('does not count as an activation for the smoke-duration clock', () => {
    const { s, ctx, id } = counteracting();
    const before = s.activationsThisTP;
    const out = reduce(s, { t: 'EndActivation', operativeId: id }, ctx);
    // "Counteracting isn't an activation, it's instead of activating."
    expect(out.state.activationsThisTP).toBe(before);
  });
});

describe('performance invariants', () => {
  it('shares the immutable map across intents instead of deep-cloning it', () => {
    const ctx = testContext();
    const s = battle(ctx, testMap());
    const out = reduce(s, { t: 'AdvancePhase' }, ctx);
    // A structuredClone of state.map would break the terrain-index cache on every intent
    // and, when profiled, accounted for 36% of the engine's CPU.
    expect(out.state.map).toBe(s.map);
    expect(out.state.operatives).not.toBe(s.operatives);
  });
});

describe('hatchways (Killzones › Gallowdark / Tomb World)', () => {
  const hatchway = (id: string): TerrainFeature => ({
    id,
    kind: 'gallowdark.wallB2',
    placement: { x: 10, y: 10, rotDeg: 0, flip: false },
    parts: [
      { id: `${id}.access`, featureId: id, poly: rect(10, 10, 1.5, 0.3), z0: 0, z1: 4, types: ['Heavy', 'Wall'], role: 'accessPoint', state: 'closed' },
      { id: `${id}.hatch`, featureId: id, poly: rect(10, 10, 1.5, 0.3), z0: 0, z1: 4, types: ['Heavy', 'Wall'], role: 'hatch', state: 'closed' },
    ],
  });

  it('closed: the access point and hatch are Heavy and Wall terrain', () => {
    const map = testMap({ closeQuarters: true, features: [hatchway('h')] });
    const index = buildTerrainIndex(map);
    const access = index.byId.get('h.access')!;
    expect(access.types).toContain('Wall');
    expect(access.solid).toBe(true);
    expect(index.byId.get('h.hatch')!.solid).toBe(true);
  });

  it('open: the access point becomes Accessible, Insignificant and Exposed, and the hatch stops blocking its own doorway', () => {
    const map = testMap({ closeQuarters: true, features: [hatchway('h')] });
    const state = { terrainState: { 'h.access': { state: 'open' }, 'h.hatch': { state: 'open' } }, placedFeatures: [] } as never;
    const index = buildTerrainIndex(map, state);
    const access = index.byId.get('h.access')!;
    expect(access.types.sort()).toEqual(['Accessible', 'Exposed', 'Insignificant']);
    expect(access.solid).toBe(false);
    // "Its hatch is Heavy and Wall terrain" — it keeps those types for cover and obscuring,
    // but it has swung clear, so it must not seal the opening it shares a footprint with.
    const hatch = index.byId.get('h.hatch')!;
    expect(hatch.types).toContain('Wall');
    expect(hatch.solid).toBe(false);
    expect(hatch.blocksVisibility).toBe(false);
    // Routing must now go straight through rather than around.
    const through = wallRouteDistance(index, { x: 10.7, y: 9 }, { x: 10.7, y: 11 });
    expect(through).toBeCloseTo(2, 1);
  });

  it('Tomb World: an open hatch is removed from the killzone entirely', () => {
    const f = hatchway('t');
    const tw: TerrainFeature = { ...f, id: 'tomb-world-1.h', parts: f.parts.map((p) => ({ ...p, id: p.id.replace('t.', 'tomb-world-1.h.'), featureId: 'tomb-world-1.h' })) };
    const map = testMap({ closeQuarters: true, features: [tw] });
    const state = { terrainState: { 'tomb-world-1.h.access': { state: 'open' }, 'tomb-world-1.h.hatch': { state: 'open' } }, placedFeatures: [] } as never;
    const index = buildTerrainIndex(map, state);
    expect(index.byId.has('tomb-world-1.h.hatch')).toBe(false);
  });
});
