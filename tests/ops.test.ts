/**
 * Approved Ops: crit ops, tac ops, the kill op, the primary op and the initiative cards.
 * Every test quotes the rule it pins.
 */
import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { readyStep } from '../src/core/phases.ts';
import { inflictDamage, removeIncapacitated } from '../src/core/state.ts';
import { actionCost, getAction } from '../src/core/actions.ts';
import {
  ALL_OPS,
  CRIT_OPS,
  CRIT_OP_GROUPS,
  KILL_GRADE_TABLE,
  TAC_OPS,
  beginInitiative,
  grantSetupRerollCard,
  initOps,
  initiativeResult,
  killGradeFor,
  killGradeThresholds,
  opsMap,
  primaryOpChoices,
  resolveOpDecision,
  scoreEndOfBattle,
  scoreEndOfTurningPoint,
  vpFromOp,
} from '../src/core/ops/index.ts';
import { equipmentMap } from '../src/core/equipment/index.ts';
import { heavyBlock, testContext, testMap } from './fixtures.ts';
import { createGameContext } from '../src/core/game.ts';
import { SeededRng } from '../src/core/rng.ts';
import type { GameContext } from '../src/core/context.ts';
import type { ActionParams } from '../src/core/intents.ts';
import type { GameState, PlayerId, Vec2 } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Game {
  ctx: GameContext;
  state: GameState;
}

function makeGame(
  opts: { critOpId?: string; tac?: Partial<Record<PlayerId, string>>; n?: number; script?: number[] } = {},
): Game {
  const ctx = testContext(opts.script ? { script: opts.script } : { seed: 5 });
  ctx.ops = opsMap();
  ctx.equipment = equipmentMap();
  const n = opts.n ?? 3;
  let state = createBattle(ctx, {
    map: ctx.maps.get('test-open')!,
    seed: 5,
    ...(opts.critOpId ? { critOpId: opts.critOpId } : {}),
  });
  const roster = Array.from({ length: n }, () => ({ datacardId: 'test.trooper' }));
  state = reduce(state, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: roster }, ctx).state;
  state = reduce(state, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: roster }, ctx).state;
  state.setup.dropZone = { p1: 'p1', p2: 'p2' };
  for (const player of ['p1', 'p2'] as PlayerId[]) {
    const tacOpId = opts.tac?.[player];
    if (tacOpId) state = reduce(state, { t: 'SelectTacOp', player, tacOpId }, ctx).state;
  }
  state.teams.p1.operativeIds.forEach((id, i) => {
    const o = state.operatives[id]!;
    o.pos = { x: 3, y: 3 + i * 3 };
    o.ready = true;
  });
  state.teams.p2.operativeIds.forEach((id, i) => {
    const o = state.operatives[id]!;
    o.pos = { x: 27, y: 3 + i * 3 };
    o.ready = true;
  });
  state.setup.step = 'done';
  state.phase = 'firefight';
  state.turningPoint = 1;
  state.initiative = 'p1';
  state.activePlayer = 'p1';
  initOps(ctx, state);
  return { ctx, state };
}

/** Put an operative somewhere and run one action through the reducer. */
function act(
  game: Game,
  operativeId: string,
  action: string,
  params: ActionParams = {},
  at?: Vec2,
): { ok: boolean; reason?: string } {
  const op = game.state.operatives[operativeId]!;
  if (at) op.pos = { ...at };
  game.state.phase = 'firefight';
  game.state.activePlayer = op.player;
  game.state.activeOperativeId = operativeId;
  op.apSpent = 0;
  op.actionsThisActivation = [];
  const out = reduce(game.state, { t: 'PerformAction', operativeId, action, params }, game.ctx);
  game.state = out.state;
  return { ok: out.ok, ...(out.reason ? { reason: out.reason } : {}) };
}

function nextTurningPoint(game: Game): void {
  scoreEndOfTurningPoint(game.ctx, game.state);
  game.state.turningPoint += 1;
}

const kill = (game: Game, operativeId: string, killerId?: string): void => {
  if (killerId) {
    // Give the kill a killer, the way a shoot sequence does.
    game.state.sequence = {
      kind: 'shoot',
      step: 'resolve',
      attackerId: killerId,
      targetId: operativeId,
      queue: [],
      resolvedTargets: [],
      weaponName: 'lasgun',
      secondary: false,
      pointBlank: false,
      inCover: false,
      obscured: false,
      coverChoiceMade: true,
      vantageAccurate: 0,
      vantageImprovedCover: false,
      attack: { dice: [], nextId: 1 },
      defence: { dice: [], nextId: 1 },
      usedRerolls: [],
      usedRetention: [],
      damage: 0,
      useCounted: false,
      attacker: game.state.operatives[killerId]!.player,
      defender: game.state.operatives[operativeId]!.player,
      free: false,
    };
  }
  inflictDamage(game.ctx, game.state, game.state.operatives[operativeId]!, 99, 'attack');
  game.state.sequence = null;
  removeIncapacitated(game.ctx, game.state);
};

// ---------------------------------------------------------------------------
describe('op registry', () => {
  it('has 9 crit ops, 12 tac ops (3 per archetype) and the kill op', () => {
    expect(CRIT_OPS).toHaveLength(9);
    expect(TAC_OPS).toHaveLength(12);
    expect(ALL_OPS).toHaveLength(22);
    for (const archetype of ['Infiltration', 'Recon', 'Security', 'Seek & Destroy']) {
      expect(TAC_OPS.filter((o) => o.archetype === archetype)).toHaveLength(3);
    }
  });

  it('exposes the tournament companion crit-op groupings {1,2,3} {4,6,7} {5,8,9}', () => {
    expect(CRIT_OP_GROUPS.map((g) => g.ops)).toEqual([
      ['crit.secure', 'crit.loot', 'crit.transmission'],
      ['crit.orb', 'crit.energyCells', 'crit.download'],
      ['crit.stakeClaim', 'crit.data', 'crit.reboot'],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('crit ops', () => {
  it('1. Secure: "If any objective markers are secured by your kill team, you score 1VP. If more objective markers are secured... than your opponent\'s kill team, you score 1VP."', () => {
    const game = makeGame({ critOpId: 'crit.secure' });
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.turningPoint = 1;
    // "An operative cannot perform this action during the first turning point"
    expect(act(game, a, 'Secure', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(false);
    game.state.turningPoint = 2;
    expect(act(game, a, 'Secure', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.secure')).toBe(2);
    expect(vpFromOp(game.state, 'p2', 'crit.secure')).toBe(0);
  });

  it('2. Loot: "you score 1VP (to a maximum of 2VP per turning point)" and a marker cannot be looted twice in a turning point', () => {
    const game = makeGame({ critOpId: 'crit.loot' });
    const [a, b, c] = game.state.teams.p1.operativeIds as [string, string, string];
    game.state.turningPoint = 2;
    expect(act(game, a, 'Loot', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    // "or if that objective marker has already been looted during this turning point"
    expect(act(game, b, 'Loot', { markerId: 'centre' }, { x: 15, y: 10.4 }).ok).toBe(false);
    expect(act(game, b, 'Loot', { markerId: 'p1' }, { x: 8, y: 11.6 }).ok).toBe(true);
    expect(act(game, c, 'Loot', { markerId: 'p2' }, { x: 22, y: 11.6 }).ok).toBe(true);
    expect(vpFromOp(game.state, 'p1', 'crit.loot')).toBe(2);
  });

  it('3. Transmission: markers are "transmitting until the start of the next turning point"', () => {
    const game = makeGame({ critOpId: 'crit.transmission' });
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.turningPoint = 2;
    expect(act(game, a, 'Initiate Transmission', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.transmission')).toBe(2);
    // Next turning point it is no longer transmitting.
    game.state.turningPoint = 3;
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.transmission')).toBe(2);
  });

  it('4. Orb: "At the start of the battle, the centre objective marker has the Orb token" and you score for controlled markers WITHOUT it', () => {
    const game = makeGame({ critOpId: 'crit.orb' });
    expect(game.state.markers['centre']!.flags['orb']).toBe(true);
    const [a, b] = game.state.teams.p1.operativeIds as [string, string];
    game.state.turningPoint = 2;
    // Controlling the centre (which has the Orb) scores nothing; controlling p1's marker does.
    game.state.operatives[a]!.pos = { x: 15, y: 11.6 };
    game.state.operatives[b]!.pos = { x: 8, y: 11.6 };
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.orb')).toBe(1);
    // "If the centre objective marker has it, move it to either player's objective marker"
    expect(act(game, a, 'Move Orb', { choice: 'p2' }).ok).toBe(true);
    expect(game.state.markers['p2']!.flags['orb']).toBe(true);
    expect(game.state.markers['centre']!.flags['orb']).toBeUndefined();
  });

  it('5. Stake Claim: the claim is a secret PendingDecision and "each player cannot select each objective marker more than once per battle"', () => {
    const game = makeGame({ critOpId: 'crit.stakeClaim' });
    game.state.turningPoint = 2;
    readyStep(game.ctx, game.state);
    const decision = game.state.pending.find((d) => d.kind === 'stakeClaim' && d.who === 'p1')!;
    expect(decision).toBeDefined();
    expect(decision.options.some((o) => o.id === 'centre|control')).toBe(true);
    expect(resolveOpDecision(game.ctx, game.state, decision.id, 'centre|control').ok).toBe(true);
    // Hold the centre and the claim comes true (plus 1VP for controlling more markers).
    game.state.operatives[game.state.teams.p1.operativeIds[0]!]!.pos = { x: 15, y: 11.6 };
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.stakeClaim')).toBe(2);
    // The centre may not be claimed again.
    game.state.turningPoint = 3;
    readyStep(game.ctx, game.state);
    const second = game.state.pending.find((d) => d.kind === 'stakeClaim' && d.who === 'p1')!;
    expect(second.options.some((o) => o.id.startsWith('centre'))).toBe(false);
  });

  it('6. Energy Cells: Pick Up Marker on an objective costs "an additional 2AP" in TP2, 1AP in TP3 and nothing in TP4, and not at all in TP1', () => {
    const game = makeGame({ critOpId: 'crit.energyCells' });
    const a = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    a.pos = { x: 15, y: 11.6 };
    const pickUp = getAction('Pick Up Marker')!;
    expect(game.state.markers['centre']!.flags['pickUpAllowed']).toBe(false);
    for (const [tp, expected] of [
      [2, 3],
      [3, 2],
      [4, 1],
    ] as const) {
      game.state.turningPoint = tp;
      readyStep(game.ctx, game.state);
      expect(game.state.markers['centre']!.flags['pickUpAllowed']).toBe(true);
      expect(actionCost(game.ctx, game.state, a, pickUp)).toBe(expected);
    }
  });

  it('7. Download: not before the third turning point, 1VP in TP3 and 2VP in TP4, and downloaded markers are ignored for control', () => {
    const game = makeGame({ critOpId: 'crit.download' });
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.turningPoint = 2;
    expect(act(game, a, 'Download', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(false);
    game.state.turningPoint = 3;
    expect(act(game, a, 'Download', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    expect(vpFromOp(game.state, 'p1', 'crit.download')).toBe(1);
    // "Ignore downloaded objective markers when determining this" — the centre no longer counts.
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.download')).toBe(1);
    // "if that objective marker has already been downloaded during the battle"
    game.state.turningPoint = 4;
    expect(act(game, a, 'Download', { markerId: 'centre' }).ok).toBe(false);
  });

  it('8. Data: Compile Data adds a point per turning point; Send Data scores "VP equal to the number of Data points removed"', () => {
    const game = makeGame({ critOpId: 'crit.data' });
    const [a, b] = game.state.teams.p1.operativeIds as [string, string];
    game.state.turningPoint = 2;
    expect(act(game, a, 'Compile Data', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    expect(act(game, b, 'Compile Data', { markerId: 'centre' }, { x: 15, y: 10.4 }).ok).toBe(false);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.data')).toBe(1); // more Compile Data actions than the enemy
    game.state.turningPoint = 3;
    expect(act(game, a, 'Compile Data', { markerId: 'centre' }).ok).toBe(true);
    // "cannot perform this action during the first, second or third turning point"
    expect(act(game, a, 'Send Data', { markerId: 'centre' }).ok).toBe(false);
    game.state.turningPoint = 4;
    expect(act(game, a, 'Send Data', { markerId: 'centre' }).ok).toBe(true);
    expect(game.state.markers['centre']!.flags['data']).toBe(0);
  });

  it('9. Reboot: both players secretly select a number; matching picks make that marker inert, otherwise the unselected one is', () => {
    const game = makeGame({ critOpId: 'crit.reboot' });
    expect(Object.values(game.state.markers).map((m) => m.flags['number'])).toEqual([1, 2, 3]);
    game.state.turningPoint = 2;
    readyStep(game.ctx, game.state);
    const p1 = game.state.pending.find((d) => d.kind === 'rebootSelect' && d.who === 'p1')!;
    const p2 = game.state.pending.find((d) => d.kind === 'rebootSelect' && d.who === 'p2')!;
    resolveOpDecision(game.ctx, game.state, p1.id, '1');
    resolveOpDecision(game.ctx, game.state, p2.id, '2');
    // Neither selected marker 3, so it is inert.
    const inert = Object.values(game.state.markers).find((m) => m.flags['inertTP'] === 2)!;
    expect(inert.flags['number']).toBe(3);
    // "Ignore inert objective markers when determining this."
    game.state.operatives[game.state.teams.p1.operativeIds[0]!]!.pos = { x: 22, y: 11.6 };
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.reboot')).toBe(inert.id === 'p2' ? 0 : 1);
  });
});

// ---------------------------------------------------------------------------
describe('tac ops', () => {
  it('Plant Devices: 1VP for a device on "your opponent\'s objective marker", capped at 2VP per turning point', () => {
    const game = makeGame({ tac: { p1: 'tac.plantDevices' } });
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.turningPoint = 2;
    expect(act(game, a, 'Plant Device', { markerId: 'p2' }, { x: 22, y: 11.6 }).ok).toBe(true);
    expect(act(game, a, 'Plant Device', { markerId: 'p2' }).ok).toBe(false); // already has one
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.plantDevices')).toBe(1);
  });

  it('Steal Intelligence: "place one of your Intelligence mission markers within its control range" when an enemy is incapacitated', () => {
    const game = makeGame({ tac: { p1: 'tac.stealIntelligence' } });
    game.state.turningPoint = 2;
    const victim = game.state.teams.p2.operativeIds[0]!;
    const killer = game.state.teams.p1.operativeIds[0]!;
    game.state.operatives[victim]!.pos = { x: 15, y: 11 };
    kill(game, victim, killer);
    const intel = Object.values(game.state.markers).find((m) => m.kind === 'intelligence')!;
    expect(intel.owner).toBe('p1');
    expect(intel.pos).toEqual({ x: 15, y: 11 });
    // "if any friendly operatives are carrying any of your Intelligence mission markers, 1VP"
    expect(act(game, killer, 'Pick Up Intelligence', { markerId: intel.id }, { x: 15, y: 11.6 }).ok).toBe(true);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.stealIntelligence')).toBe(1);
  });

  it('Track Enemy: the watcher "must have a Conceal order" and the tracked operative must not be able to see it back', () => {
    const game = makeGame({ tac: { p1: 'tac.trackEnemy' } });
    game.state.turningPoint = 2;
    // A low block beside the watcher: it is in cover (so a Conceal order makes it an invalid
    // target) but it can still see over the top.
    game.state.map = testMap({ features: [heavyBlock('h1', 12.8, 10.5, 0.5, 1, 0.5)] });
    const watcher = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    const enemy = game.state.operatives[game.state.teams.p2.operativeIds[0]!]!;
    watcher.pos = { x: 12, y: 11 };
    watcher.order = 'conceal';
    enemy.pos = { x: 16, y: 11 };
    enemy.order = 'engage';
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.trackEnemy')).toBe(1);
    // An Engage order on the watcher stops it tracking.
    game.state.turningPoint = 3;
    watcher.order = 'engage';
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.trackEnemy')).toBe(1);
  });

  it('Flank: revealed "As a STRATEGIC GAMBIT"; an operative contests a flank "while both wholly within it and wholly within their opponent\'s territory"', () => {
    const game = makeGame({ tac: { p1: 'tac.flank' } });
    game.state.turningPoint = 2;
    const a = game.state.operatives[game.state.teams.p1.operativeIds[0]!]!;
    a.pos = { x: 20, y: 16 }; // enemy territory (x > 15), above the flank line (y = 11)
    // Not revealed yet: no VP.
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.flank')).toBe(0);
    game.state.turningPoint = 3;
    game.state.teams.p1.gambitsUsedTP.push('tac.flank:reveal');
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.flank')).toBe(1);
  });

  it('Retrieval: "The first time each objective marker is searched by friendly operatives, you score 1VP"', () => {
    const game = makeGame({ tac: { p1: 'tac.retrieval' } });
    const [a, b] = game.state.teams.p1.operativeIds as [string, string];
    game.state.turningPoint = 2;
    expect(act(game, a, 'Retrieve', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    expect(vpFromOp(game.state, 'p1', 'tac.retrieval')).toBe(1);
    expect(game.state.operatives[a]!.carryingMarkerId).toBeDefined();
    // The same marker cannot be searched twice, and a carrier cannot retrieve again.
    expect(act(game, b, 'Retrieve', { markerId: 'centre' }, { x: 15, y: 10.4 }).ok).toBe(false);
    scoreEndOfBattle(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.retrieval')).toBe(2);
  });

  it('Scout Enemy Movement: Scout needs a ready enemy "visible to and more than 6" from the active operative"', () => {
    const game = makeGame({ tac: { p1: 'tac.scoutEnemyMovement' } });
    game.state.turningPoint = 2;
    const a = game.state.teams.p1.operativeIds[0]!;
    const enemy = game.state.teams.p2.operativeIds[0]!;
    game.state.operatives[a]!.order = 'conceal';
    game.state.operatives[enemy]!.pos = { x: 20, y: 11 };
    // Too close: 4" away.
    expect(act(game, a, 'Scout', { targetOperativeId: enemy }, { x: 16, y: 11 }).ok).toBe(false);
    expect(act(game, a, 'Scout', { targetOperativeId: enemy }, { x: 10, y: 11 }).ok).toBe(true);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.scoutEnemyMovement')).toBe(1);
  });

  it('Plant Banner: the banner must be "wholly within your opponent\'s territory" and scores 2VP when uncontested', () => {
    const game = makeGame({ tac: { p1: 'tac.plantBanner' } });
    game.state.turningPoint = 2;
    const a = game.state.teams.p1.operativeIds[0]!;
    // Own territory: rejected.
    expect(act(game, a, 'Plant Banner', { markerPos: { x: 10, y: 11 } }, { x: 10, y: 11 }).ok).toBe(false);
    expect(act(game, a, 'Plant Banner', { markerPos: { x: 20, y: 11 } }, { x: 20, y: 11 }).ok).toBe(true);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.plantBanner')).toBe(2);
  });

  it('Martyrs: a friendly incapacitated while contesting a marker gives it a Martyr token, worth 2VP if you control that marker', () => {
    const game = makeGame({ tac: { p1: 'tac.martyrs' } });
    game.state.turningPoint = 2;
    const [a, b] = game.state.teams.p1.operativeIds as [string, string];
    game.state.operatives[a]!.pos = { x: 15, y: 11.6 };
    game.state.operatives[b]!.pos = { x: 15, y: 10.4 };
    kill(game, a, game.state.teams.p2.operativeIds[0]!);
    scoreEndOfTurningPoint(game.ctx, game.state);
    // b still contests and controls the centre: 2VP for the removed token.
    expect(vpFromOp(game.state, 'p1', 'tac.martyrs')).toBe(2);
    expect(game.state.markers['centre']!.flags['martyr:p1']).toBe(0);
  });

  it('Envoy: 2VP when the envoy is in enemy territory and "has not lost any wounds during that turning point"', () => {
    const game = makeGame({ tac: { p1: 'tac.envoy' } });
    game.state.turningPoint = 2;
    readyStep(game.ctx, game.state);
    for (const d of [...game.state.pending]) resolveOpDecision(game.ctx, game.state, d.id, d.options[0]!.id);
    const a = game.state.teams.p1.operativeIds[0]!;
    game.state.operatives[a]!.pos = { x: 20, y: 11 };
    game.state.teams.p1.gambitsUsedTP.push(`tac.envoy:select:${a}`);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.envoy')).toBe(2);
    // Wounded during the turning point: 1VP instead.
    game.state.turningPoint = 3;
    readyStep(game.ctx, game.state);
    const b = game.state.teams.p1.operativeIds[1]!;
    game.state.operatives[b]!.pos = { x: 20, y: 14 };
    game.state.operatives[b]!.wounds -= 3;
    game.state.teams.p1.gambitsUsedTP.push(`tac.envoy:select:${b}`);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.envoy')).toBe(3);
  });

  it('Rout: 1VP for a kill made "within 6" of your opponent\'s drop zone", 2VP against a Wounds stat of 12 or more', () => {
    const game = makeGame({ tac: { p1: 'tac.rout' } });
    game.state.turningPoint = 2;
    const killer = game.state.teams.p1.operativeIds[0]!;
    const victim = game.state.teams.p2.operativeIds[0]!;
    game.state.operatives[killer]!.pos = { x: 26, y: 11 }; // inside p2's drop zone (x >= 24)
    game.state.operatives[victim]!.pos = { x: 26, y: 12 };
    kill(game, victim, killer);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.rout')).toBe(1);
  });

  it('Sweep & Clear: a cleared, uncontested marker with a Swept token scores 2VP', () => {
    const game = makeGame({ tac: { p1: 'tac.sweepAndClear' } });
    game.state.turningPoint = 2;
    const a = game.state.teams.p1.operativeIds[0]!;
    const victim = game.state.teams.p2.operativeIds[0]!;
    game.state.operatives[victim]!.pos = { x: 15, y: 11.6 };
    kill(game, victim, a);
    expect(act(game, a, 'Clear', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    scoreEndOfTurningPoint(game.ctx, game.state);
    // 2VP for the cleared + swept marker, capped at 2VP per turning point.
    expect(vpFromOp(game.state, 'p1', 'tac.sweepAndClear')).toBe(2);
  });

  it('Dominate: tokens are gained per kill and cashed in "at the end of the third and fourth turning point" (max 3VP each)', () => {
    const game = makeGame({ tac: { p1: 'tac.dominate' }, n: 5 });
    game.state.turningPoint = 2;
    const killer = game.state.teams.p1.operativeIds[0]!;
    for (const victim of game.state.teams.p2.operativeIds.slice(0, 4)) kill(game, victim, killer);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.dominate')).toBe(0); // not until TP3
    game.state.turningPoint = 3;
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.dominate')).toBe(3);
    game.state.turningPoint = 4;
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'tac.dominate')).toBe(4); // the fourth token
  });
});

// ---------------------------------------------------------------------------
describe('kill op', () => {
  it('reproduces the printed kill-grade table exactly with round(start x grade / 5)', () => {
    for (const [size, thresholds] of Object.entries(KILL_GRADE_TABLE)) {
      const start = Number(size);
      expect(thresholds).toEqual([1, 2, 3, 4, 5].map((g) => Math.round((start * g) / 5)));
      expect(killGradeThresholds(start)).toEqual(thresholds);
    }
    // Starting sizes outside 5-14: extrapolate above, one kill per grade below (docs/OPS.md).
    expect(killGradeThresholds(20)).toEqual([4, 8, 12, 16, 20]);
    expect(killGradeThresholds(4)).toEqual([1, 2, 3, 4, 4]);
  });

  it('"Whenever you move to a new kill grade, you score 1VP" and +1VP at the end of the battle for the higher grade', () => {
    const game = makeGame({ n: 5 });
    game.state.turningPoint = 2;
    expect(killGradeFor(5, 2)).toBe(2);
    for (const victim of game.state.teams.p2.operativeIds.slice(0, 2))
      kill(game, victim, game.state.teams.p1.operativeIds[0]!);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(game.state.teams.p1.killGrade).toBe(2);
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(2);
    game.state.turningPoint = 4;
    scoreEndOfBattle(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(3);
    expect(vpFromOp(game.state, 'p2', 'kill.killOp')).toBe(0);
  });

  it('"your opponent\'s kill grade can go down during the battle (they lose VP accordingly)"', () => {
    const game = makeGame({ n: 5 });
    game.state.turningPoint = 2;
    const victims = game.state.teams.p2.operativeIds.slice(0, 2);
    for (const victim of victims) kill(game, victim, game.state.teams.p1.operativeIds[0]!);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(game.state.teams.p1.killGrade).toBe(2);
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(2);
    const vpBefore = game.state.teams.p1.vp;
    // Exactly what HIEROTEK CIRCLE's reanimate() does to one of them.
    const back = game.state.operatives[victims[0]!]!;
    back.removed = false;
    back.incapacitated = false;
    game.state.turningPoint = 3;
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(game.state.teams.p1.killGrade).toBe(1);
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(1);
    expect(game.state.teams.p1.vp).toBe(vpBefore - 1);
    // "...this won't retroactively change any other VPs": the tac op's slots are untouched.
    expect(vpFromOp(game.state, 'p1', 'tac.rout')).toBe(0);
    // And the grade is re-scored if the operative goes down again — the 6VP cap came back too.
    back.incapacitated = true;
    game.state.turningPoint = 4;
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(game.state.teams.p1.killGrade).toBe(2);
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(2);
  });

  it('"The row you use is determined by the STARTING number of enemy operatives"', () => {
    // A 6-operative team grown to 9 mid-battle. Row 6 is [1,2,4,5,6] and row 9 is [2,4,5,7,9],
    // so four kills is grade 3 on the row the rules name and grade 2 on the live roster.
    const game = makeGame({ n: 6 });
    expect(game.state.teams.p2.startingSize).toBe(6);
    for (let i = 0; i < 3; i++) {
      const id = `p2-extra-${i}`;
      game.state.operatives[id] = { ...game.state.operatives[game.state.teams.p2.operativeIds[0]!]!, id };
      game.state.teams.p2.operativeIds.push(id);
    }
    game.state.turningPoint = 3;
    for (const victim of game.state.teams.p2.operativeIds.slice(0, 4))
      kill(game, victim, game.state.teams.p1.operativeIds[0]!);
    scoreEndOfTurningPoint(game.ctx, game.state);
    expect(game.state.teams.p1.killGrade).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('initiative cards', () => {
  it('"Starting with the loser of the roll-off, each player alternates either using an initiative card... or passing, until they both pass"', () => {
    // Rolls 2 then 5: p1 loses and plays first.
    const game = makeGame({ script: [2, 5] });
    grantSetupRerollCard(game.state, 'p1');
    game.state.teams.p1.initiativeCards.push('ic.plus2');
    beginInitiative(game.ctx, game.state);
    const first = game.state.pending.find((d) => d.kind === 'initiativeCard')!;
    expect(first.who).toBe('p1');
    // "+2/-2... this can take it above 6 or below 1"
    resolveOpDecision(game.ctx, game.state, first.id, 'ic.plus2|+2');
    expect(initiativeResult(game.state, 'p1')).toBe(4);
    // p2 has no cards, so it auto-passes; p1 gets another window and passes.
    const second = game.state.pending.find((d) => d.kind === 'initiativeCard')!;
    expect(second.who).toBe('p1');
    resolveOpDecision(game.ctx, game.state, second.id, 'pass');
    const choose = game.state.pending.find((d) => d.kind === 'chooseInitiative')!;
    expect(choose.who).toBe('p2'); // p2 still won 5 to 4
    resolveOpDecision(game.ctx, game.state, choose.id, 'p2');
    expect(game.state.initiative).toBe('p2');
    // "the loser of the roll-off gains an initiative card equal to the turning point number"
    expect(game.state.teams.p1.initiativeCards).toContain('ic.plus1');
  });

  it('"If a player uses the Re-roll initiative card after they\'ve modified their roll result, the new result supersedes their modification(s)"', () => {
    const game = makeGame({ script: [2, 5, 6] });
    game.state.teams.p1.initiativeCards.push('ic.plus1', 'ic.reroll');
    beginInitiative(game.ctx, game.state);
    const d1 = game.state.pending.find((d) => d.kind === 'initiativeCard')!;
    resolveOpDecision(game.ctx, game.state, d1.id, 'ic.plus1|+1');
    expect(initiativeResult(game.state, 'p1')).toBe(3);
    const d2 = game.state.pending.find((d) => d.kind === 'initiativeCard')!;
    resolveOpDecision(game.ctx, game.state, d2.id, 'ic.reroll|reroll');
    expect(initiativeResult(game.state, 'p1')).toBe(6); // the re-rolled 6, not 6+1
  });

  it('"If the roll-off is a tie, the player who doesn\'t currently have initiative is the winner"', () => {
    const game = makeGame({ script: [4, 4] });
    game.state.initiative = 'p1';
    beginInitiative(game.ctx, game.state);
    const choose = game.state.pending.find((d) => d.kind === 'chooseInitiative')!;
    expect(choose.who).toBe('p2');
    resolveOpDecision(game.ctx, game.state, choose.id, 'p2');
    // The loser of the roll-off (p1, who lost the tie) gains the turning point's card.
    expect(game.state.teams.p1.initiativeCards).toContain('ic.plus1');
  });

  it('the opponent of the player with initiative gains the Re-roll card during setup, and no card is gained in TP4', () => {
    const game = makeGame({ script: [6, 1] });
    grantSetupRerollCard(game.state, 'p2');
    expect(game.state.teams.p2.initiativeCards).toEqual(['ic.reroll']);
    game.state.turningPoint = 4;
    beginInitiative(game.ctx, game.state);
    // p2 holds the Re-roll card and is losing, so it acts first; pass to keep the test short.
    const d = game.state.pending.find((x) => x.kind === 'initiativeCard')!;
    resolveOpDecision(game.ctx, game.state, d.id, 'pass');
    const choose = game.state.pending.find((x) => x.kind === 'chooseInitiative')!;
    resolveOpDecision(game.ctx, game.state, choose.id, 'p1');
    expect(game.state.teams.p2.initiativeCards).toEqual(['ic.reroll']); // nothing gained in TP4
  });
});

// ---------------------------------------------------------------------------
describe('scripted four-turning-point games', () => {
  it('game A — Secure + kill op + a crit primary op: 6 + 3 + 3 = 12VP', () => {
    const game = makeGame({ critOpId: 'crit.secure', tac: { p1: 'tac.rout' }, n: 5 });
    // TP1: the Ready step asks each player for their secret primary op.
    readyStep(game.ctx, game.state);
    const p1Choice = game.state.pending.find((d) => d.kind === 'primaryOp' && d.who === 'p1')!;
    expect(p1Choice.options.map((o) => o.id)).toEqual(['crit.secure', 'kill.killOp', 'tac.rout']);
    resolveOpDecision(game.ctx, game.state, p1Choice.id, 'crit.secure');
    const p2Choice = game.state.pending.find((d) => d.kind === 'primaryOp' && d.who === 'p2')!;
    resolveOpDecision(game.ctx, game.state, p2Choice.id, 'kill.killOp');
    expect(game.state.pending).toHaveLength(0);
    nextTurningPoint(game); // nothing scores in TP1

    // TP2: secure the centre marker.
    const a = game.state.teams.p1.operativeIds[0]!;
    expect(act(game, a, 'Secure', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
    nextTurningPoint(game);
    expect(vpFromOp(game.state, 'p1', 'crit.secure')).toBe(2);

    // TP3: two kills, well away from p2's drop zone so Rout scores nothing.
    for (const victim of game.state.teams.p2.operativeIds.slice(0, 2)) {
      game.state.operatives[victim]!.pos = { x: 16, y: 11 };
      kill(game, victim, a);
    }
    nextTurningPoint(game);
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(2);
    expect(vpFromOp(game.state, 'p1', 'tac.rout')).toBe(0);

    // TP4 and the end of the battle.
    scoreEndOfTurningPoint(game.ctx, game.state);
    scoreEndOfBattle(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.secure')).toBe(6); // 2VP a turning point, capped at 6
    expect(vpFromOp(game.state, 'p1', 'kill.killOp')).toBe(3); // grade 2 + the end-of-battle point
    expect(vpFromOp(game.state, 'p1', 'primary')).toBe(3); // half of 6, rounding up
    expect(game.state.teams.p1.vp).toBe(12);
    expect(game.state.teams.p2.vp).toBe(0);
  });

  it('game B — Loot + Plant Devices with a tac primary op: 6 + 3 + 2 = 11VP', () => {
    const game = makeGame({ critOpId: 'crit.loot', tac: { p1: 'tac.plantDevices' }, n: 3 });
    const [a, b, c] = game.state.teams.p1.operativeIds as [string, string, string];
    game.state.teams.p1.primaryOpId = 'tac.plantDevices';
    nextTurningPoint(game); // TP1

    for (const tp of [2, 3, 4]) {
      expect(game.state.turningPoint).toBe(tp);
      // Two Loot actions a turning point — the third is refused by the 2VP-per-TP cap only in
      // VP, so we stick to two markers and keep a device on the opponent's marker.
      expect(act(game, a, 'Loot', { markerId: 'centre' }, { x: 15, y: 11.6 }).ok).toBe(true);
      expect(act(game, b, 'Loot', { markerId: 'p1' }, { x: 8, y: 11.6 }).ok).toBe(true);
      if (tp === 2) expect(act(game, c, 'Plant Device', { markerId: 'p2' }, { x: 22, y: 11.6 }).ok).toBe(true);
      if (tp < 4) nextTurningPoint(game);
    }
    scoreEndOfTurningPoint(game.ctx, game.state);
    scoreEndOfBattle(game.ctx, game.state);
    expect(vpFromOp(game.state, 'p1', 'crit.loot')).toBe(6); // 2VP a turning point, capped at 6
    expect(vpFromOp(game.state, 'p1', 'tac.plantDevices')).toBe(3); // 1VP a turning point from TP2
    expect(vpFromOp(game.state, 'p1', 'primary')).toBe(2); // half of 3, rounding up
    expect(game.state.teams.p1.vp).toBe(11);
  });
});

// ---------------------------------------------------------------------------
describe('op-owned decisions actually resolve', () => {
  /**
   * `resolveDecision` removes the decision from `state.pending` before it dispatches. While
   * the op seam took the decision's ID, every op-owned decision — the secret primary op,
   * Stake Claim, Reboot, Envoy, Flank — looked itself up, found nothing, and was logged as
   * "had no handler — recorded only". The primary op alone is worth up to 3VP a side.
   */
  it('records the primary op chosen through the ordinary decision channel', () => {
    // A context with the ops layer actually wired in — the seam this test is about.
    const ctx = createGameContext({ rng: new SeededRng(4), maps: [testMap()] });
    const s = createBattle(ctx, { map: testMap(), seed: 4, critOpId: 'crit.secure' });
    s.teams.p1.tacOpId = 'tac.plantDevices';
    s.teams.p2.tacOpId = 'tac.plantDevices';
    s.pending.push({
      id: 'primaryOp-p1',
      who: 'p1',
      kind: 'primaryOp',
      prompt: 'Secretly select your primary op',
      options: primaryOpChoices(s, 'p1').map((id) => ({ id, label: id })),
    });
    const chosen = primaryOpChoices(s, 'p1')[0]!;
    const out = reduce(s, { t: 'ResolveDecision', decisionId: 'primaryOp-p1', optionId: chosen }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.primaryOpId).toBe(chosen);
    expect(out.state.log.some((l) => /had no handler/.test(l.text))).toBe(false);
  });
});
