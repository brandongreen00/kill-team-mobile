import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { canDeployAt, reduce } from '../src/core/reducer.ts';
import { deployBatchRemaining, deployToAct, gambitToAct } from '../src/core/phases.ts';
import { actionAvailability } from '../src/core/actions.ts';
import { defaultDecisionOption } from '../src/core/decisions.ts';
import {
  accurateValue,
  allocateSavesOptimally,
  applyRetention,
  addRolled,
  classify,
  newPool,
  retentionOptions,
} from '../src/core/dice.ts';
import { parseWeaponRule, parseWeaponRules, condensedEnvironmentRules } from '../src/core/weaponRules.ts';
import { baseGap, baseWhollyWithin, segmentIntersectsPrism } from '../src/core/geometry.ts';
import { buildTerrainIndex } from '../src/core/terrain.ts';
import { coverAndObscured, isVisible, vantageAccurate } from '../src/core/visibility.ts';
import { SeededRng } from '../src/core/rng.ts';
import { heavyBlock, rect, testContext, testMap, vantagePlatform } from './fixtures.ts';
import type { BaseShape, GameState } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
describe('geometry', () => {
  it('measures base-to-base, not centre-to-centre (core rules › Distances)', () => {
    // Two 32mm bases 2" apart centre-to-centre: 2 - 0.63 - 0.63 = 0.74"
    const gap = baseGap({ x: 0, y: 0 }, { shape: 'round', mm: 32 }, 0, { x: 2, y: 0 }, { shape: 'round', mm: 32 }, 0);
    expect(gap).toBeCloseTo(0.7401, 3);
  });

  it('models oval bases with facing, not always horizontal', () => {
    const oval: BaseShape = { shape: 'oval', mm: [60, 35] };
    const alongLong = baseGap({ x: 0, y: 0 }, oval, 0, { x: 4, y: 0 }, { shape: 'round', mm: 25 }, 0);
    const alongShort = baseGap({ x: 0, y: 0 }, oval, 90, { x: 4, y: 0 }, { shape: 'round', mm: 25 }, 0);
    expect(alongShort).toBeGreaterThan(alongLong + 0.4);
  });

  it('"wholly within" requires every part of the base inside', () => {
    const zone = [rect(0, 0, 6, 22)];
    expect(baseWhollyWithin({ x: 3, y: 11 }, { shape: 'round', mm: 32 }, 0, zone)).toBe(true);
    expect(baseWhollyWithin({ x: 5.9, y: 11 }, { shape: 'round', mm: 32 }, 0, zone)).toBe(false);
  });

  it('intersects a 3D segment with an extruded prism', () => {
    const poly = rect(4, 4, 2, 2);
    expect(segmentIntersectsPrism({ x: 0, y: 5, z: 1 }, { x: 10, y: 5, z: 1 }, poly, 0, 3)).toBe(true);
    // Passing over the top of a 3" block.
    expect(segmentIntersectsPrism({ x: 0, y: 5, z: 4 }, { x: 10, y: 5, z: 4 }, poly, 0, 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('dice', () => {
  it('classifies: 1 always fails, 6 always crits (core rules › Roll Attack Dice)', () => {
    expect(classify(1, 2)).toBe('fail');
    expect(classify(6, 6)).toBe('crit');
    expect(classify(4, 4)).toBe('normal');
    expect(classify(3, 4)).toBe('fail');
  });

  it('Lethal x+: successes >= x are critical successes', () => {
    expect(classify(5, 4, { lethal: 5 })).toBe('crit');
    expect(classify(4, 4, { lethal: 5 })).toBe('normal');
  });

  it('Accurate: multiple instances become Accurate 2', () => {
    expect(accurateValue(parseWeaponRules('Accurate 1, Accurate 1'))).toBe(2);
    expect(accurateValue(parseWeaponRules('Accurate 1'))).toBe(1);
  });

  it('allocates defence dice optimally (2 normals block a crit)', () => {
    // 1 crit incoming (dmgC 4), defender has 2 normals: blocking the crit saves 4.
    const a = allocateSavesOptimally(1, 0, 0, 2, 2, 4, false);
    expect(a.damage).toBe(0);
    // Brutal: "Your opponent can only block with critical successes."
    const b = allocateSavesOptimally(1, 0, 0, 2, 2, 4, true);
    expect(b.damage).toBe(4);
  });

  it('Severe promotes a normal to a critical only when no crits are retained', () => {
    const pool = newPool();
    addRolled(pool, [4, 4], 4);
    const rules = parseWeaponRules('Severe');
    expect(retentionOptions(pool, rules, false).map((o) => o.id)).toContain('severe');
    applyRetention(pool, 'severe');
    expect(retentionOptions(pool, rules, false)).toHaveLength(0);
  });

  it('Condensed Environment grants Lethal 5+ to Blast/Torrent/x" Devastating weapons', () => {
    const withBlast = condensedEnvironmentRules(parseWeaponRules('Blast 2"'));
    expect(withBlast.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
    const plain = condensedEnvironmentRules(parseWeaponRules('Piercing 1'));
    expect(plain.some((r) => r.id === 'Lethal')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('weapon rule parsing', () => {
  it('parses every printed form', () => {
    expect(parseWeaponRule('Lethal 5+')).toMatchObject({ id: 'Lethal', x: 5 });
    expect(parseWeaponRule('Range 9"')).toMatchObject({ id: 'Range', x: 9 });
    expect(parseWeaponRule('Piercing Crits 1')).toMatchObject({ id: 'PiercingCrits', x: 1 });
    expect(parseWeaponRule('1" Devastating 3')).toMatchObject({ id: 'Devastating', x: 3, dist: 1 });
    expect(parseWeaponRule('Heavy (Dash only)')).toMatchObject({ id: 'Heavy', only: 'Dash' });
    expect(parseWeaponRule('Seek Light')).toMatchObject({ id: 'SeekLight' });
    expect(parseWeaponRule('Saturate')).toMatchObject({ id: 'Saturate' });
  });
});

// ---------------------------------------------------------------------------
describe('visibility, cover and obscured', () => {
  const shooter = { id: 'a', pos: { x: 2, y: 11 }, z: 0, rot: 0, base: { shape: 'round', mm: 32 } as const, height: 1.6 };
  const target = { id: 'b', pos: { x: 20, y: 11 }, z: 0, rot: 0, base: { shape: 'round', mm: 32 } as const, height: 1.6 };

  it('Heavy terrain in the way blocks visibility', () => {
    const map = testMap({ features: [heavyBlock('h1', 10, 9, 2, 4, 3)] });
    const index = buildTerrainIndex(map);
    expect(isVisible(index, shooter, target).visible).toBe(false);
  });

  it('obscured ignores Heavy terrain within 1" of either operative', () => {
    // Block placed right next to the target: intervening, but ignored for obscured.
    const map = testMap({ features: [heavyBlock('h1', 18.5, 9, 0.6, 4, 3)] });
    const index = buildTerrainIndex(map);
    const near = { ...target, pos: { x: 19.8, y: 11 } };
    const r = coverAndObscured(index, shooter, near);
    expect(r.obscured).toBe(false);
  });

  it('cover is denied within 2" of the active operative (core rules › Cover)', () => {
    const map = testMap({ features: [heavyBlock('h1', 3.2, 9, 0.4, 4, 1.2)] });
    const index = buildTerrainIndex(map);
    const close = { ...target, pos: { x: 4.2, y: 11 } };
    const r = coverAndObscured(index, shooter, close);
    expect(r.inCover).toBe(false);
    expect(r.reason).toContain('within 2"');
  });

  it('Vantage grants Accurate 1 at 2" and Accurate 2 at 4" lower', () => {
    const map = testMap({ features: [vantagePlatform('v1', 1, 9, 4, 4, 4), vantagePlatform('v2', 6, 9, 3, 3, 2)] });
    const index = buildTerrainIndex(map);
    const high = { ...shooter, pos: { x: 3, y: 11 }, z: 4 };
    expect(vantageAccurate(index, high, target)).toBe(2);
    const low = { ...shooter, pos: { x: 7, y: 10.5 }, z: 2 };
    expect(vantageAccurate(index, low, { ...target, z: 0 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('end-to-end: two operatives, one shot, deterministic dice', () => {
  function setup(script?: number[]): { state: GameState; ctx: ReturnType<typeof testContext> } {
    const ctx = testContext(script ? { script } : { seed: 7 });
    let state = createBattle(ctx, { map: ctx.maps.get('test-open')!, seed: 7, critOpId: undefined });
    const pick = (n: number, id: string) => Array.from({ length: n }, () => ({ datacardId: id }));
    state = reduce(state, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: pick(2, 'test.trooper') }, ctx).state;
    state = reduce(state, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: pick(2, 'test.trooper') }, ctx).state;
    state.setup.dropZone = { p1: 'p1', p2: 'p2' };
    const ids1 = state.teams.p1.operativeIds;
    const ids2 = state.teams.p2.operativeIds;
    state = reduce(state, { t: 'DeployOperative', player: 'p1', operativeId: ids1[0]!, pos: { x: 3, y: 11 } }, ctx).state;
    state = reduce(state, { t: 'DeployOperative', player: 'p1', operativeId: ids1[1]!, pos: { x: 3, y: 14 } }, ctx).state;
    state = reduce(state, { t: 'DeployOperative', player: 'p2', operativeId: ids2[0]!, pos: { x: 27, y: 11 } }, ctx).state;
    state = reduce(state, { t: 'DeployOperative', player: 'p2', operativeId: ids2[1]!, pos: { x: 27, y: 14 } }, ctx).state;
    state = reduce(state, { t: 'FinishSetup' }, ctx).state;
    state.initiative = 'p1';
    state.phase = 'firefight';
    state.activePlayer = 'p1';
    for (const op of Object.values(state.operatives)) op.ready = true;
    return { state, ctx };
  }

  it('rejects a shot out of visibility rather than throwing', () => {
    const { state, ctx } = setup();
    let s = state;
    s.map = testMap({ features: [heavyBlock('h1', 14, 5, 2, 12, 4)] });
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    s = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    const out = reduce(s, { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'lasgun', targetId: b } }, ctx);
    expect(out.ok).toBe(false);
    expect(out.state.rejected.length).toBe(1);
    expect(out.reason).toMatch(/not visible|not a valid target/);
  });

  it('resolves a full shoot sequence deterministically and inflicts damage', () => {
    // Attack dice 4,5,6,2 vs Hit 4+ -> 2 normals + 1 crit; defence 1,1,1 vs Save 4+ -> nothing.
    const { state, ctx } = setup([4, 5, 6, 2, 1, 1, 1]);
    let s = state;
    // Move the operatives into line of sight and range.
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    s.operatives[a]!.pos = { x: 10, y: 11 };
    s.operatives[b]!.pos = { x: 16, y: 11 };
    s = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    const r = reduce(s, { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'lasgun', targetId: b } }, ctx);
    expect(r.ok).toBe(true);
    s = r.state;
    // Resolve any decisions with the deterministic default policy.
    let guard = 0;
    while (s.pending.length > 0 && guard++ < 20) {
      const d = s.pending[0]!;
      const choice = defaultDecisionOption(d);
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: choice.optionId, ...(choice.data ? { data: choice.data } : {}) }, ctx).state;
    }
    const target = s.operatives[b]!;
    expect(target.wounds).toBeLessThan(10);
    expect(s.rejected).toHaveLength(0);
    expect(s.rolls.some((x) => x.kind === 'attack')).toBe(true);
    expect(s.rolls.some((x) => x.kind === 'defence')).toBe(true);
  });

  it('replays byte-identically from the same seed', () => {
    const run = () => {
      const ctx = testContext({ seed: 99 });
      const rng = new SeededRng(99);
      ctx.rng = rng;
      const { state, ctx: c2 } = setup();
      c2.rng = new SeededRng(99);
      let s = state;
      const a = s.teams.p1.operativeIds[0]!;
      const b = s.teams.p2.operativeIds[0]!;
      s.operatives[a]!.pos = { x: 10, y: 11 };
      s.operatives[b]!.pos = { x: 16, y: 11 };
      s = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, c2).state;
      s = reduce(s, { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'lasgun', targetId: b } }, c2).state;
      let guard = 0;
      while (s.pending.length > 0 && guard++ < 20) {
        const d = s.pending[0]!;
        const choice = defaultDecisionOption(d);
        s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: choice.optionId }, c2).state;
      }
      return s.rolls.map((r) => r.results.join(',')).join('|');
    };
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
describe('action restrictions and AP (core rules › Perform Actions)', () => {
  it('rejects a second Reposition in the same activation', () => {
    const ctx = testContext({ seed: 3 });
    let s = createBattle(ctx, { map: ctx.maps.get('test-open')!, seed: 3 });
    s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: [{ datacardId: 'test.trooper' }] }, ctx).state;
    s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: [{ datacardId: 'test.trooper' }] }, ctx).state;
    s.setup.dropZone = { p1: 'p1', p2: 'p2' };
    const a = s.teams.p1.operativeIds[0]!;
    s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: a, pos: { x: 3, y: 11 } }, ctx).state;
    s = reduce(s, { t: 'DeployOperative', player: 'p2', operativeId: s.teams.p2.operativeIds[0]!, pos: { x: 27, y: 11 } }, ctx).state;
    s = reduce(s, { t: 'FinishSetup' }, ctx).state;
    s.phase = 'firefight';
    s.initiative = 'p1';
    s.activePlayer = 'p1';
    for (const op of Object.values(s.operatives)) op.ready = true;
    s = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    const path = { points: [{ x: 6, y: 11 }] };
    s = reduce(s, { t: 'PerformAction', operativeId: a, action: 'Reposition', params: { path } }, ctx).state;
    const second = reduce(s, { t: 'PerformAction', operativeId: a, action: 'Reposition', params: { path: { points: [{ x: 9, y: 11 }] } } }, ctx);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('action restrictions');
  });
});

// ---------------------------------------------------------------------------
/**
 * Selectors the UI reads instead of deriving. Each of these was a rule living in
 * `src/ui/**` — which meant the app was the only thing that knew it, and nothing tested it.
 */
describe('order-of-play selectors', () => {
  const battleWith = (p1: number, p2: number) => {
    const ctx = testContext();
    let s = createBattle(ctx, { map: ctx.maps.get('test-open')!, seed: 5 });
    s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: Array.from({ length: p1 }, () => ({ datacardId: 'test.trooper' })) }, ctx).state;
    s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: Array.from({ length: p2 }, () => ({ datacardId: 'test.trooper' })) }, ctx).state;
    s.initiative = 'p1';
    return { ctx, s };
  };

  it('alternates deployment in thirds, rounding up, starting with initiative', () => {
    // "Starting with the player that has initiative, players alternate setting up one third
    // of their kill team (rounding up)." Six operatives each: 2, 2, 2.
    const { s } = battleWith(6, 6);
    expect(deployToAct(s)).toBe('p1');
    expect(deployBatchRemaining(s, 'p1')).toBe(2);

    s.setup.deployedCount = { p1: 2 };
    expect(deployToAct(s)).toBe('p2');
    s.setup.deployedCount = { p1: 2, p2: 2 };
    expect(deployToAct(s)).toBe('p1');
    s.setup.deployedCount = { p1: 6, p2: 2 };
    // One side finished: the other keeps going rather than the turn stalling.
    expect(deployToAct(s)).toBe('p2');
    s.setup.deployedCount = { p1: 6, p2: 6 };
    expect(deployToAct(s)).toBeNull();
  });

  it('rounds a third UP, so a five-operative kill team places 2, 2, 1', () => {
    const { s } = battleWith(5, 5);
    expect(deployBatchRemaining(s, 'p1')).toBe(2);
    s.setup.deployedCount = { p1: 4 };
    expect(deployBatchRemaining(s, 'p1')).toBe(1);
  });

  it('alternates gambits from the initiative player until both have passed', () => {
    const { s } = battleWith(3, 3);
    expect(gambitToAct(s)).toBe('p1');
    s.teams.p1.passedGambit = true;
    expect(gambitToAct(s)).toBe('p2');
    s.teams.p1.passedGambit = false;
    s.teams.p2.passedGambit = true;
    expect(gambitToAct(s)).toBe('p1');
    s.teams.p1.passedGambit = true;
    expect(gambitToAct(s)).toBeNull();
  });
});

describe('canDeployAt is the reducer, exported', () => {
  const setUp = () => {
    const ctx = testContext();
    let s = createBattle(ctx, { map: ctx.maps.get('test-open')!, seed: 5 });
    s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: [{ datacardId: 'test.trooper' }, { datacardId: 'test.trooper' }] }, ctx).state;
    s.setup.dropZone = { p1: 'p1', p2: 'p2' };
    return { ctx, s };
  };

  it('gives the same verdict, in the same words, as DeployOperative itself', () => {
    const { ctx, s } = setUp();
    const op = s.operatives['p1-0']!;
    for (const pos of [{ x: 3, y: 11 }, { x: 20, y: 11 }, { x: 5.9, y: 11 }]) {
      const selector = canDeployAt(ctx, s, op, pos);
      const viaReducer = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: op.id, pos }, ctx);
      expect(selector.ok).toBe(viaReducer.ok);
      if (!selector.ok) expect(selector.reason).toBe(viaReducer.reason);
    }
  });

  it('refuses a base that is not wholly within the drop zone, or is on another base', () => {
    const { ctx, s } = setUp();
    const a = s.operatives['p1-0']!;
    expect(canDeployAt(ctx, s, a, { x: 3, y: 11 }).ok).toBe(true);
    expect(canDeployAt(ctx, s, a, { x: 5.9, y: 11 }).reason).toMatch(/wholly within your drop zone/);
    const placed = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: a.id, pos: { x: 3, y: 11 } }, ctx).state;
    const b = placed.operatives['p1-1']!;
    expect(canDeployAt(ctx, placed, b, { x: 3, y: 11 }).reason).toMatch(/cannot be placed on another/);
  });

  it('does not mutate the state it is asked about', () => {
    const { ctx, s } = setUp();
    const before = JSON.stringify(s.operatives);
    canDeployAt(ctx, s, s.operatives['p1-0']!, { x: 3, y: 11 });
    expect(JSON.stringify(s.operatives)).toBe(before);
  });
});

describe('actionAvailability runs the checks availableActions skips', () => {
  it('reports a move as needing a target rather than as simply legal', () => {
    const ctx = testContext();
    let s = createBattle(ctx, { map: ctx.maps.get('test-open')!, seed: 5 });
    s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: [{ datacardId: 'test.trooper' }] }, ctx).state;
    s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: [{ datacardId: 'test.trooper' }] }, ctx).state;
    s.setup.dropZone = { p1: 'p1', p2: 'p2' };
    s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: 'p1-0', pos: { x: 3, y: 11 } }, ctx).state;
    s = reduce(s, { t: 'DeployOperative', player: 'p2', operativeId: 'p2-0', pos: { x: 27, y: 11 } }, ctx).state;
    s = reduce(s, { t: 'FinishSetup' }, ctx).state;
    s.phase = 'firefight';
    s.activePlayer = 'p1';
    const op = s.operatives['p1-0']!;
    op.ready = true;

    const rows = actionAvailability(ctx, s, op);
    const reposition = rows.find((r) => r.def.id === 'Reposition')!;
    // `availableActions` says "ok" because it never runs `check`; a UI that rendered that as
    // an enabled button would dispatch an intent the reducer rejects for "no path supplied".
    expect(reposition.needsTarget).toBe('point');
    // …and an unparameterised action is genuinely checked.
    const pass = rows.find((r) => r.def.id === 'Pass');
    if (pass) expect(typeof pass.ok).toBe('boolean');
  });
});
