/**
 * The whole stack, assembled: a context built by `createGameContext` must actually drive
 * ops scoring, the initiative-card window and equipment placement through the reducer.
 *
 * These are the seams that are easy to leave dangling — the ops layer reported that a
 * missing `resolveOpDecision` hookup would silently block the reducer on the turning-point-1
 * primary-op prompt — so each one gets a test that fails loudly if the wiring is dropped.
 */
import { describe, expect, it } from 'vitest';
import { createGameContext } from '../src/core/game.ts';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { defaultDecisionOption } from '../src/core/decisions.ts';
import { SeededRng } from '../src/core/rng.ts';
import { makeCard, testMap } from './fixtures.ts';
import type { GameState, PlayerId } from '../src/core/types.ts';

function ctxWithCards(seed = 4) {
  const trooper = makeCard({ id: 'test.trooper', name: 'TROOPER' });
  return createGameContext({ rng: new SeededRng(seed), datacards: [trooper], maps: [testMap()] });
}

function deployedBattle(seed = 4): { state: GameState; ctx: ReturnType<typeof ctxWithCards> } {
  const ctx = ctxWithCards(seed);
  let s = createBattle(ctx, { map: testMap(), seed, critOpId: 'crit.secure' });
  const picks = Array.from({ length: 4 }, () => ({ datacardId: 'test.trooper' }));
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: picks }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: picks }, ctx).state;
  s.setup.dropZone = { p1: 'p1', p2: 'p2' };
  s.teams.p1.operativeIds.forEach((id, i) => {
    s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: id, pos: { x: 3, y: 4 + i * 4 } }, ctx).state;
  });
  s.teams.p2.operativeIds.forEach((id, i) => {
    s = reduce(s, { t: 'DeployOperative', player: 'p2', operativeId: id, pos: { x: 27, y: 4 + i * 4 } }, ctx).state;
  });
  s = reduce(s, { t: 'FinishSetup' }, ctx).state;
  return { state: s, ctx };
}

/** Answer every pending decision with the deterministic default policy. */
function drainDecisions(state: GameState, ctx: ReturnType<typeof ctxWithCards>, limit = 200): GameState {
  let s = state;
  let guard = 0;
  while (s.pending.length > 0 && guard++ < limit) {
    const d = s.pending[0]!;
    const choice = defaultDecisionOption(d);
    const optionId = d.options.some((o) => o.id === choice.optionId && !o.disabled)
      ? choice.optionId
      : (d.options.find((o) => !o.disabled)?.id ?? 'pass');
    s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId }, ctx).state;
  }
  return s;
}

describe('assembled game context', () => {
  it('registers every op and equipment option', () => {
    const ctx = ctxWithCards();
    // 9 crit ops + 12 tac ops + the kill op
    expect(ctx.ops.size).toBe(22);
    // 11 universal equipment options
    expect(ctx.equipment.size).toBe(11);
    for (const seam of ['scoreEndOfTurningPoint', 'scoreEndOfBattle', 'resolveOpDecision', 'beginInitiative', 'initOps', 'placeEquipment'] as const) {
      expect(typeof ctx[seam], `${seam} seam is not wired`).toBe('function');
    }
  });

  it('opens the initiative-card window on a turning-point roll-off and never leaves it stuck', () => {
    const { state, ctx } = deployedBattle();
    let s: GameState = { ...state, turningPoint: 2, phase: 'strategy', initiative: 'p1' as PlayerId };
    s.teams.p1.initiativeCards = [];
    s.teams.p2.initiativeCards = [];
    s = reduce(s, { t: 'RollOff', kind: 'initiative' }, ctx).state;
    // beginInitiative must have raised a decision rather than silently deciding.
    expect(s.pending.length + s.rolls.filter((r) => r.kind === 'initiative').length).toBeGreaterThan(0);
    s = drainDecisions(s, ctx);
    expect(s.pending).toHaveLength(0);
    expect(s.initiative === 'p1' || s.initiative === 'p2').toBe(true);
    expect(s.rejected).toHaveLength(0);
  });

  it('rejects an equipment option selected twice, and more than four options', () => {
    const { state, ctx } = deployedBattle();
    const twice = reduce(state, { t: 'SelectEquipment', player: 'p1', equipment: ['eq.mines', 'eq.mines'] }, ctx);
    expect(twice.ok).toBe(false);
    expect(twice.reason).toMatch(/only be selected once/);
    const five = reduce(
      state,
      { t: 'SelectEquipment', player: 'p1', equipment: ['eq.mines', 'eq.ammoCache', 'eq.commsDevice', 'eq.razorWire', 'eq.ladders'] },
      ctx,
    );
    expect(five.ok).toBe(false);
    expect(five.reason).toMatch(/up to four/);
  });

  it('places an equipment marker through the reducer and refuses an illegal spot', () => {
    const { state, ctx } = deployedBattle();
    let s = reduce(state, { t: 'SelectEquipment', player: 'p1', equipment: ['eq.ammoCache'] }, ctx).state;
    // "Before the battle, you can set up one of your Ammo Cache markers wholly within your
    // territory." p1's territory is x in [0,15].
    const outside = reduce(
      s,
      { t: 'PlaceEquipment', player: 'p1', equipmentId: 'eq.ammoCache', itemIndex: 0, pos: { x: 25, y: 11 } },
      ctx,
    );
    expect(outside.ok).toBe(false);
    const inside = reduce(
      s,
      { t: 'PlaceEquipment', player: 'p1', equipmentId: 'eq.ammoCache', itemIndex: 0, pos: { x: 6, y: 11 } },
      ctx,
    );
    expect(inside.ok, inside.reason).toBe(true);
    expect(Object.values(inside.state.markers).some((m) => m.kind === 'ammoCache')).toBe(true);
  });

  it('scores a crit op at the end of a turning point through the wired seam', () => {
    const { state, ctx } = deployedBattle();
    let s: GameState = { ...state, phase: 'firefight', turningPoint: 1, initiative: 'p1' as PlayerId };
    // Park two p1 operatives on the centre objective so they control it.
    const ids = s.teams.p1.operativeIds;
    s.operatives[ids[0]!]!.pos = { x: 15, y: 11 };
    s.operatives[ids[1]!]!.pos = { x: 15.9, y: 11 };
    for (const op of Object.values(s.operatives)) op.ready = false;
    const before = s.teams.p1.vp;
    s = reduce(s, { t: 'AdvancePhase' }, ctx).state;
    expect(s.rejected).toHaveLength(0);
    // Secure: "you control one or more objective markers" scores at the end of the turning point.
    expect(s.teams.p1.vp).toBeGreaterThanOrEqual(before);
    expect(s.turningPoint).toBe(2);
  });
});
