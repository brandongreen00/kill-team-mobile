/**
 * SCOUT SQUAD. Every test quotes the printed rule it pins, read out of
 * `data/teams/scout-squad.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/scout-squad/
 */
import { describe, expect, it } from 'vitest';
import { availableActions } from '../../src/core/actions.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { reduce } from '../../src/core/reducer.ts';
import { apBudgetOf, aplOf, freeApOf, hitOf, moveOf } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { rebuildHooks, type GameContext } from '../../src/core/context.ts';
import { counteractCandidates } from '../../src/core/phases.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import type { ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  ADAPTIVE_SMOKE,
  DIVERSION_GAMBIT,
  GUIDANCE_ACTION,
  SCOUT_ASTARTES_FIGHT,
  SCOUT_ASTARTES_SHOOT,
  TACTICAL_MANOEUVRE_GAMBIT,
  scoutSquad,
  selectForwardScouting,
} from '../../src/teams/scout-squad/index.ts';
import { activate, battle, opWith, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';

const DATA = teamData('scout-squad');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const uniqueText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

function setup(equipment: string[] = [], opts: { seed?: number; script?: number[] } = {}): {
  ctx: GameContext;
  state: GameState;
} {
  const ctx = teamContext([scoutSquad], opts);
  const state = battle({ ctx, p1: { module: scoutSquad, equipment }, p2: { module: scoutSquad } });
  return { ctx, state };
}

/** The in-flight shoot sequence, narrowed. */
function shootOf(state: GameState): ShootSequence {
  const seq = state.sequence;
  if (!seq || seq.kind !== 'shoot') throw new Error('no shoot sequence in flight');
  return seq;
}

/** A ranged AttackContext for hooks that are normally driven by the shoot sequence. */
function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  over: Partial<AttackContext> = {},
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules: profile.rules,
    type: profile.type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 6,
    ...over,
  };
}

/** A shoot sequence parked mid-flight, so sequence-reading rules can be exercised. */
function fakeShoot(
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  weaponName: string,
  over: Record<string, unknown> = {},
): void {
  state.sequence = {
    kind: 'shoot',
    step: 'resolve',
    attackerId: attacker.id,
    targetId: target.id,
    queue: [],
    resolvedTargets: [],
    weaponName,
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
    attacker: attacker.player,
    defender: target.player,
    free: false,
    ...over,
  } as GameState['sequence'];
}

// ---------------------------------------------------------------------------
describe('SCOUT SQUAD data (pinned against data/teams/scout-squad.json)', () => {
  it('has 6 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(6);
    const sergeant = DATA.datacards.find((c) => c.id === 'scout-squad.sergeant')!;
    expect(sergeant).toMatchObject({ apl: 3, move: 6, save: 4, wounds: 11, base: { shape: 'round', mm: 28 } });
    expect(sergeant.keywords).toEqual(['SCOUT SQUAD', 'IMPERIUM', 'ADEPTUS ASTARTES', 'LEADER', 'SERGEANT']);
    for (const card of DATA.datacards.filter((c) => c.id !== 'scout-squad.sergeant')) {
      expect(card).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 10, base: { shape: 'round', mm: 28 } });
      expect(card.keywords.slice(0, 3)).toEqual(['SCOUT SQUAD', 'IMPERIUM', 'ADEPTUS ASTARTES']);
    }
  });

  it('pins every weapon profile of the HEAVY GUNNER and the SNIPER', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) => w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')));
    expect(flat('scout-squad.heavy-gunner')).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Heavy bolter|focused|ranged|5|3|4|5',
      'Heavy bolter|sweeping|ranged|4|3|4|5',
      'Missile launcher|frag|ranged|4|3|3|5',
      'Missile launcher|krak|ranged|4|3|5|7',
      'Fists||melee|3|3|3|4',
    ]);
    expect(flat('scout-squad.sniper')).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Sniper rifle|mobile|ranged|4|3|3|4',
      'Sniper rifle|stationary|ranged|4|2|3|3',
      'Fists||melee|3|3|3|4',
    ]);
    expect(profileOf('scout-squad.sniper', 'Sniper rifle', 'stationary').rules.map((r) => r.raw)).toEqual([
      'Devastating 3',
      'Heavy (Dash only)',
      'Silent',
    ]);
  });

  it('exposes 1 faction rule, 4 strategy ploys, 4 firefight ploys, 4 equipment and no rare weapon rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Forward Scouting']);
    expect(scoutSquad.ploys.filter((p) => p.kind === 'strategy').map((p) => p.id)).toEqual([
      'scout-squad.sp.guerrilla-engagement',
      'scout-squad.sp.ambush',
      'scout-squad.sp.adaptable-training',
      'scout-squad.sp.stealth-relocation',
    ]);
    expect(scoutSquad.ploys.filter((p) => p.kind === 'firefight').map((p) => p.id)).toEqual([
      'scout-squad.fp.astartes-training',
      'scout-squad.fp.raw-physiology',
      'scout-squad.fp.emboldened-aspirant',
      'scout-squad.fp.covert-position',
    ]);
    expect(scoutSquad.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual([]);
    // aiHints are a deliverable: without ployValue the AI never uses a firefight ploy.
    for (const p of scoutSquad.ploys) expect(scoutSquad.aiHints!.ployValue![p.id]).toBeGreaterThan(0);
    for (const e of scoutSquad.equipment) expect(scoutSquad.aiHints!.equipmentValue![e.id]).toBeGreaterThan(0);
    for (const c of DATA.datacards) expect(scoutSquad.aiHints!.roles![c.id]).toBeTruthy();
  });

  it('defaultRoster is a legal kill team: 1 SERGEANT + 8, "other than WARRIOR … only once"', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(9);
    expect(validateRosterFor(DATA, picks).errors).toEqual([]);
    const ids = picks.map((p) => p.datacardId);
    expect(ids.filter((i) => i === 'scout-squad.sergeant')).toHaveLength(1);
    expect(new Set(ids)).toEqual(
      new Set([
        'scout-squad.sergeant',
        'scout-squad.heavy-gunner',
        'scout-squad.hunter',
        'scout-squad.sniper',
        'scout-squad.tracker',
        'scout-squad.warrior',
      ]),
    );
    expect(DATA.selection.rawText).toContain(
      'Other than WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
  });
});

// ---------------------------------------------------------------------------
describe('Forward Scouting — "you can select and resolve up to six Forward Scouting options"', () => {
  it('caps the selection at six and enforces each option’s number in brackets', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain(
      'you can select and resolve up to six Forward Scouting options',
    );
    const { ctx, state } = setup();
    const seven = selectForwardScouting(ctx, state, 'p1', [
      { option: 'devise-plan' },
      { option: 'spy' },
      { option: 'designate-target' },
      { option: 'tactical-manoeuvre' },
      { option: 'diversion' },
      { option: 'trip-alarm', pos: { x: 12, y: 4 } },
      { option: 'trip-alarm', pos: { x: 12, y: 18 } },
    ]);
    expect(seven.resolved).toHaveLength(6);
    expect(seven.errors[0]).toMatch(/up to six/);

    const twice = selectForwardScouting(ctx, battle({ ctx, p1: { module: scoutSquad }, p2: { module: scoutSquad } }), 'p1', [
      { option: 'devise-plan' },
      { option: 'devise-plan' },
    ]);
    expect(twice.resolved).toEqual(['devise-plan']);
    expect(twice.errors[0]).toMatch(/at most 1 time/);
  });

  it('Devise Plan: "You gain 1CP." and Spy: "Your opponent must reveal their selected tac op."', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain('Devise Plan(1)\nYou gain 1CP.');
    const { ctx, state } = setup();
    const cp = state.teams.p1.cp;
    selectForwardScouting(ctx, state, 'p1', [{ option: 'devise-plan' }, { option: 'spy' }]);
    expect(state.teams.p1.cp).toBe(cp + 1);
    expect(state.setup.revealed.p2).toBe(true);
  });

  it('Trip Alarm gives Seek within 2" of the marker in TP1–2 and is removed in the third Ready step', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain(
      'During the first and second turning point, whenever a friendly SCOUT SQUAD operative is shooting an enemy operative that’s within 2" of that marker, that friendly operative’s ranged weapons have the Seek weapon rule.',
    );
    const { ctx, state } = setup();
    selectForwardScouting(ctx, state, 'p1', [{ option: 'trip-alarm', pos: { x: 15, y: 5 } }]);
    expect(state.markers['scout-squad.tripAlarm.p1.0']).toBeDefined();

    const shooter = state.operatives[opWith(state, 'p1', 'scout-squad.tracker')]!;
    const target = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    target.pos = { x: 15.5, y: 5 };
    const boltgun = profileOf('scout-squad.tracker', 'Boltgun');
    const use = { operative: shooter, target, weaponName: 'Boltgun' };
    expect(effectiveRules(ctx, state, boltgun, use).some((r) => r.id === 'Seek')).toBe(true);

    state.turningPoint = 3;
    expect(effectiveRules(ctx, state, boltgun, use).some((r) => r.id === 'Seek')).toBe(false);
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(state.markers['scout-squad.tripAlarm.p1.0']).toBeUndefined();
  });

  it('Booby Trap: "remove that marker and inflict 2D3 damage on that operative"', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain('inflict 2D3 damage on that operative');
    // ScriptedRng: d3 = ceil(d6/2), so 5 -> 3 and 3 -> 2, i.e. 2D3 = 5.
    const { ctx, state } = setup([], { script: [5, 3] });
    selectForwardScouting(ctx, state, 'p1', [{ option: 'booby-trap', pos: { x: 15, y: 5 } }]);
    const marker = state.markers['scout-squad.boobyTrap.p1']!;
    expect(marker).toBeDefined();

    const victim = state.operatives[opWith(state, 'p2', 'scout-squad.warrior')]!;
    victim.pos = { x: marker.pos.x + 0.6, y: marker.pos.y };
    const before = victim.wounds;
    ctx.hooks.emit('onActivationEnd', state, { state, operative: victim });
    expect(before - victim.wounds).toBe(5);
    expect(state.markers['scout-squad.boobyTrap.p1']).toBeUndefined();
  });

  it('Designate Target: a Target token buys a re-roll when shooting, and Balanced when fighting', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain(
      'Whenever a friendly SCOUT SQUAD operative is shooting against, fighting against or retaliating against an enemy operative that has one of your Target tokens, you can re-roll one of your attack dice.',
    );
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.warrior')]!;
    const shooter = state.operatives[opWith(state, 'p1', 'scout-squad.tracker')]!;
    selectForwardScouting(ctx, state, 'p1', [{ option: 'designate-target', operativeId: foe.id }]);

    const boltgun = profileOf('scout-squad.tracker', 'Boltgun');
    const ev = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(shooter, foe, 'Boltgun', boltgun),
      dice: [],
      rerolls: [],
    });
    expect(ev.rerolls.some((r) => r.id === 'scoutSquad.designateTarget')).toBe(true);

    const fists = profileOf('scout-squad.tracker', 'Fists');
    expect(
      effectiveRules(ctx, state, fists, { operative: shooter, target: foe, weaponName: 'Fists' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(true);
    // …and nothing for an enemy without a token.
    const clean = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    expect(
      effectiveRules(ctx, state, fists, { operative: shooter, target: clean, weaponName: 'Fists' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(false);
  });

  it('Tactical Manoeuvre is a twice-per-battle STRATEGIC GAMBIT that adds 1 to an APL stat', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain(
      'Tactical Manoeuvre(1)\nTwice per battle STRATEGIC GAMBIT. Select one friendly operative. Until the end of that operative’s next activation, add 1 to its APL stat.',
    );
    const { ctx, state } = setup();
    selectForwardScouting(ctx, state, 'p1', [{ option: 'tactical-manoeuvre' }]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const target = opWith(state, 'p1', 'scout-squad.tracker');

    let s = state;
    for (let i = 0; i < 2; i++) {
      const options = ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options;
      expect(options.some((o) => o.id === TACTICAL_MANOEUVRE_GAMBIT)).toBe(true);
      s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: TACTICAL_MANOEUVRE_GAMBIT, data: { operativeId: target } }, ctx)
        .state;
      s.teams.p1.gambitsUsedTP = []; // a fresh turning point; the twice-per-BATTLE cap must survive it
    }
    expect(aplOf(ctx, s, s.operatives[target]!)).toBe(3);
    const third = ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options;
    expect(third.some((o) => o.id === TACTICAL_MANOEUVRE_GAMBIT)).toBe(false);
  });

  it('Diversion is a once-per-battle STRATEGIC GAMBIT against an enemy within 6" of a killzone edge', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain(
      'Once per battle STRATEGIC GAMBIT. Select one enemy operative within 6" of a killzone edge. Until the end of that operative’s next activation, subtract 1 from its APL stat.',
    );
    const { ctx, state } = setup();
    selectForwardScouting(ctx, state, 'p1', [{ option: 'diversion' }]);
    const foe = opWith(state, 'p2', 'scout-squad.tracker');
    // Everything else is pushed to the middle, so the only edge candidate is `foe`.
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 15, y: 11 };
    state.operatives[foe]!.pos = { x: 28, y: 11 };

    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: DIVERSION_GAMBIT, data: { operativeId: foe } }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[foe]!)).toBe(1);
    s.teams.p1.gambitsUsedTP = [];
    expect(
      ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options.some((o) => o.id === DIVERSION_GAMBIT),
    ).toBe(false);
  });

  it('Reposition: "It must end that move wholly within 3\\" of your drop zone."', () => {
    expect(rule('scout-squad.rule.forward-scouting')).toContain(
      'It must end that move wholly within 3" of your drop zone.',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'scout-squad.tracker');
    const other = opWith(state, 'p1', 'scout-squad.sniper');
    state.operatives[id]!.pos = { x: 3, y: 11 };
    state.operatives[other]!.pos = { x: 3.5, y: 15 };

    // The p1 drop zone is x in [0,6]; a full 6" Move to x = 9.5 leaves the far edge of the
    // 28mm base 4" beyond it, so the base is no longer wholly within 3" of the zone.
    const tooFar = selectForwardScouting(ctx, state, 'p1', [
      { option: 'reposition', operativeId: other, path: { points: [{ x: 9.5, y: 15 }] } },
    ]);
    expect(tooFar.errors[0]).toMatch(/wholly within 3"/);
    expect(state.operatives[other]!.pos.x).toBeCloseTo(3.5);

    // 5.4" lands at x = 8.4, whose whole base is within 3" of the drop zone's x = 6 edge.
    const ok = selectForwardScouting(ctx, state, 'p1', [
      { option: 'reposition', operativeId: id, path: { points: [{ x: 8.4, y: 11 }] } },
    ]);
    expect(ok.errors).toEqual([]);
    expect(state.operatives[id]!.pos.x).toBeCloseTo(8.4);
  });
});

// ---------------------------------------------------------------------------
describe('SCOUT SQUAD strategy ploys', () => {
  it('GUERRILLA ENGAGEMENT: a re-roll in cover, only "more than 6\\" from enemy operatives it’s visible to"', () => {
    expect(rule('scout-squad.sp.guerrilla-engagement')).toContain(
      'if that friendly operative is in cover and more than 6" from enemy operatives it’s visible to, you can re-roll one of your defence dice',
    );
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'scout-squad.sp.guerrilla-engagement' }, ctx).state;
    const target = s.operatives[opWith(s, 'p1', 'scout-squad.warrior')]!;
    const shooter = s.operatives[opWith(s, 'p2', 'scout-squad.warrior')]!;
    const boltgun = profileOf('scout-squad.tracker', 'Boltgun');
    const roll = (): { rerolls: { id: string }[] } =>
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(shooter, target, 'Boltgun', boltgun, { inCover: true, distance: 20 }),
        count: 3,
        coverSave: true,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
        rerolls: [],
      });
    expect(roll().rerolls.some((r) => r.id === 'scoutSquad.guerrillaEngagement')).toBe(true);

    // An enemy it is visible to within 6" switches it off.
    shooter.pos = { x: target.pos.x + 3, y: target.pos.y };
    expect(roll().rerolls.some((r) => r.id === 'scoutSquad.guerrillaEngagement')).toBe(false);
  });

  it('a real Shoot records the attack order and the weapon used, which Astartes and EMBOLDENED ASPIRANT read', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'scout-squad.tracker');
    const foe = opWith(state, 'p2', 'scout-squad.tracker');
    let s = activate(ctx, state, id);
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: 'Shoot', params: { weaponName: 'Boltgun', targetId: foe } },
      ctx,
    );
    expect(out.ok).toBe(true);
    s = settle(ctx, out.state);
    expect((s.opState['scoutSquad.attackOrder'] as Record<string, string[]>)['p1:1']).toEqual([id]);
    expect(s.effects.find((e) => e.rule === 'scoutSquad.lastRanged' && e.operativeId === id)!.data).toEqual({
      weapon: 'Boltgun',
    });
    expect(s.rejected).toEqual([]);
  });

  it('AMBUSH: Balanced when the order flipped Conceal→Engage, Ceaseless "if the target is expended"', () => {
    expect(rule('scout-squad.sp.ambush')).toContain(
      'if its order was changed from Conceal to Engage at the start of that activation, or it wasn’t visible to enemy operatives at the start of that activation',
    );
    expect(rule('scout-squad.sp.ambush')).toContain('If the target is expended, that friendly operative’s weapons have the Ceaseless weapon rule instead.');
    const { ctx, state } = setup();
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'scout-squad.sp.ambush' }, ctx).state;
    const id = opWith(s, 'p1', 'scout-squad.tracker');
    s = activate(ctx, s, id, 'engage');
    const shooter = s.operatives[id]!;
    const target = s.operatives[opWith(s, 'p2', 'scout-squad.tracker')]!;
    const boltgun = profileOf('scout-squad.tracker', 'Boltgun');
    const use = { operative: shooter, target, weaponName: 'Boltgun' };
    expect(effectiveRules(ctx, s, boltgun, use).some((r) => r.id === 'Balanced')).toBe(true);

    target.expended = true;
    const rules = effectiveRules(ctx, s, boltgun, use);
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
    expect(rules.some((r) => r.id === 'Balanced')).toBe(false);

    // An operative that was already on Engage and was visible all along gets nothing.
    const other = opWith(s, 'p1', 'scout-squad.warrior');
    s.opState['scoutSquad.prevOrder'] = { ...(s.opState['scoutSquad.prevOrder'] ?? {}), [other]: 'engage' };
    s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    s = activate(ctx, s, other, 'engage');
    expect(
      effectiveRules(ctx, s, boltgun, { operative: s.operatives[other]!, target: s.operatives[target.id]!, weaponName: 'Boltgun' }).some(
        (r) => r.id === 'Balanced' || r.id === 'Ceaseless',
      ),
    ).toBe(false);
  });

  it('ADAPTABLE TRAINING changes the order of up to D3 operatives more than 4" from enemy operatives', () => {
    expect(rule('scout-squad.sp.adaptable-training')).toContain(
      'You can change the order of up to D3 friendly SCOUT SQUAD operatives that are more than 4" from enemy operatives.',
    );
    // ScriptedRng: a 4 gives d3 = 2.
    const { ctx, state } = setup([], { script: [4] });
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.order = 'engage';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'scout-squad.sp.adaptable-training' }, ctx).state;
    const flipped = s.teams.p1.operativeIds.filter((id) => s.operatives[id]!.order === 'conceal');
    expect(flipped).toHaveLength(2);
  });

  it('STEALTH RELOCATION: "You cannot use this ploy during the first turning point" and grants a free Dash', () => {
    expect(rule('scout-squad.sp.stealth-relocation')).toContain('You cannot use this ploy during the first turning point.');
    const ploy = scoutSquad.ploys.find((p) => p.id === 'scout-squad.sp.stealth-relocation')!;
    const { ctx, state } = setup([], { script: [1] }); // d3 = 1
    expect(ploy.usable!({ ...state, turningPoint: 1 }, 'p1').ok).toBe(false);
    expect(ploy.usable!({ ...state, turningPoint: 2 }, 'p1').ok).toBe(true);

    const start = { ...state, turningPoint: 2 };
    for (const id of start.teams.p1.operativeIds) start.operatives[id]!.order = 'conceal';
    const s = reduce(start, { t: 'UseGambit', player: 'p1', gambitId: 'scout-squad.sp.stealth-relocation' }, ctx).state;
    // The grant is free AP, not an APL stat change (docs/DECISIONS.md D-100), so it is found
    // through `freeApOf` rather than by looking for a +1 in `aplMods`.
    const granted = s.teams.p1.operativeIds.filter((id) => freeApOf(s, s.operatives[id]!) > 0);
    expect(granted).toHaveLength(1);
    const op = s.operatives[granted[0]!]!;
    expect(op.aplMods).toEqual([]);
    expect(apBudgetOf(ctx, s, op)).toBe(aplOf(ctx, s, op) + 1);
    // Spend the operative's OWN AP, so the next one it pays with is the free one — which is
    // where the "must be Dash" restriction bites.
    op.apSpent = aplOf(ctx, s, op);
    const shoot = availableActions(ctx, s, op).find((a) => a.def.id === 'Shoot');
    expect(shoot?.reason ?? '').toMatch(/free action must be Dash/);
  });
});

// ---------------------------------------------------------------------------
describe('SCOUT SQUAD firefight ploys', () => {
  it('ASTARTES TRAINING lets any friendly operative "Perform two Shoot actions"', () => {
    expect(rule('scout-squad.fp.astartes-training')).toContain(
      'Perform two Shoot actions if an Astartes shotgun, bolt pistol or boltgun is selected for at least one of them.',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'scout-squad.tracker');
    const foe = opWith(state, 'p2', 'scout-squad.tracker');
    let s = activate(ctx, state, id);
    s.operatives[id]!.actionsThisActivation = ['Shoot'];

    // Without the ploy a TRACKER gets nothing — Astartes is the SERGEANT's ability.
    const refused = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: SCOUT_ASTARTES_SHOOT, params: { weaponName: 'Boltgun', targetId: foe } },
      ctx,
    );
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/SERGEANT \(Astartes\) or the Astartes Training ploy/);

    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.astartes-training' }, ctx).state;
    s.operatives[id]!.actionsThisActivation = ['Shoot'];
    const allowed = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: SCOUT_ASTARTES_SHOOT, params: { weaponName: 'Boltgun', targetId: foe } },
      ctx,
    );
    expect(allowed.ok).toBe(true);
  });

  it('RAW PHYSIOLOGY: +1" Move and "ignore any changes … from being injured (including its weapons’ stats)"', () => {
    expect(rule('scout-squad.fp.raw-physiology')).toContain(
      'add 1" to its Move stat and you can ignore any changes to that operative’s stats from being injured (including its weapons’ stats)',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'scout-squad.tracker');
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.raw-physiology' }, ctx).state;
    const op = s.operatives[id]!;
    expect(moveOf(ctx, s, op)).toBeCloseTo(7);
    expect(moveBudget(ctx, s, op, { action: 'Reposition' })).toBeCloseTo(7);

    op.wounds = 4; // injured: fewer than half of 10
    expect(moveOf(ctx, s, op)).toBeCloseTo(7);
    expect(hitOf(ctx, s, op, profileOf('scout-squad.tracker', 'Boltgun'))).toBe(3);
  });

  it('EMBOLDENED ASPIRANT retains a normal success as a critical for the first attacker of the turning point', () => {
    expect(rule('scout-squad.fp.emboldened-aspirant')).toContain(
      'If it’s the first friendly operative to perform either of those actions during this turning point, or if the enemy operative in that action (primary target, if relevant) has a higher Wounds stat than that friendly SCOUT SQUAD operative, you can retain one of your normal successes as a critical success instead.',
    );
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'scout-squad.tracker')]!;
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    fakeShoot(state, shooter, foe, 'Boltgun', {
      attack: { dice: [{ id: 1, value: 4, state: 'normal', rolled: true }], nextId: 2 },
    });

    // Not the first attacker and the target is no tougher (10 wounds each) — nothing happens.
    state.opState['scoutSquad.attackOrder'] = { 'p1:1': ['someone-else', shooter.id] };
    const none = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.emboldened-aspirant' }, ctx).state;
    expect(shootOf(none).attack.dice[0]!.state).toBe('normal');

    state.opState['scoutSquad.attackOrder'] = { 'p1:1': [shooter.id] };
    state.teams.p1.ploysUsedTP = [];
    const promoted = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.emboldened-aspirant' }, ctx).state;
    expect(shootOf(promoted).attack.dice[0]!.state).toBe('crit');
  });

  it('EMBOLDENED ASPIRANT also fires against an enemy with a higher Wounds stat', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'scout-squad.tracker')]!; // 10 wounds
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.sergeant')]!; // 11 wounds
    fakeShoot(state, shooter, foe, 'Boltgun', {
      attack: { dice: [{ id: 1, value: 4, state: 'normal', rolled: true }], nextId: 2 },
    });
    state.opState['scoutSquad.attackOrder'] = { 'p1:1': ['someone-else', shooter.id] };
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.emboldened-aspirant' }, ctx).state;
    expect(shootOf(out).attack.dice[0]!.state).toBe('crit');
  });

  it('COVERT POSITION: a Conceal order in cover "cannot be selected as a valid target … except being within 2\\""', () => {
    expect(rule('scout-squad.fp.covert-position')).toContain(
      'while that operative has a Conceal order and is in cover, it cannot be selected as a valid target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"',
    );
    const ctx = teamContext([scoutSquad], { seed: 5 });
    const map = testMap({ features: [heavyBlock('cover', 16, 9, 1.5, 1.5, 1)] });
    const state = battle({ ctx, map, p1: { module: scoutSquad }, p2: { module: scoutSquad } });
    const hider = state.operatives[opWith(state, 'p1', 'scout-squad.warrior')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'scout-squad.warrior')]!;
    hider.pos = { x: 17, y: 11 };
    hider.order = 'conceal';
    shooter.pos = { x: 17, y: 3 };
    state.activeOperativeId = hider.id;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.covert-position' }, ctx).state;

    const check = (): { valid: boolean } =>
      ctx.hooks.emit('onValidTarget', s, {
        state: s,
        attacker: s.operatives[shooter.id]!,
        target: s.operatives[hider.id]!,
        valid: true,
        ignoreCoverTerrain: 'all', // Seek — the ploy takes precedence over it
        forceVisible: false,
      });
    expect(check().valid).toBe(false);

    // "except being within 2""
    s.operatives[shooter.id]!.pos = { x: 17, y: 12 };
    expect(check().valid).toBe(true);
    // …and an Engage order is not protected at all.
    s.operatives[shooter.id]!.pos = { x: 17, y: 3 };
    s.operatives[hider.id]!.order = 'engage';
    expect(check().valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('SCOUT SQUAD faction equipment', () => {
  const defenceEvent = (
    ctx: GameContext,
    state: GameState,
    shooter: OperativeState,
    target: OperativeState,
    coverSave: boolean,
  ) =>
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Boltgun', profileOf('scout-squad.tracker', 'Boltgun'), { inCover: true }),
      count: 3,
      coverSave,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });

  it('CAMO CLOAK: "one additional cover save" for everyone "excluding SNIPER"', () => {
    expect(rule('scout-squad.eq.camo-cloak')).toContain(
      'Whenever an operative is shooting a friendly SCOUT SQUAD operative (excluding SNIPER), if you can retain any cover saves, you can retain one additional cover save.',
    );
    const bare = setup();
    const bareWarrior = bare.state.operatives[opWith(bare.state, 'p1', 'scout-squad.warrior')]!;
    const bareShooter = bare.state.operatives[opWith(bare.state, 'p2', 'scout-squad.tracker')]!;
    fakeShoot(bare.state, bareShooter, bareWarrior, 'Boltgun', { inCover: true });
    expect(defenceEvent(bare.ctx, bare.state, bareShooter, bareWarrior, true).extraCoverSaves).toBe(0);

    const { ctx, state } = setup(['scout-squad.eq.camo-cloak']);
    const shooter = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    const warrior = state.operatives[opWith(state, 'p1', 'scout-squad.warrior')]!;
    fakeShoot(state, shooter, warrior, 'Boltgun', { inCover: true });
    expect(defenceEvent(ctx, state, shooter, warrior, true).extraCoverSaves).toBe(1);

    // "(excluding SNIPER)" — the SNIPER's own Camo Cloak ability covers it instead, and the
    // two never stack into two additional cover saves.
    const sniper = state.operatives[opWith(state, 'p1', 'scout-squad.sniper')]!;
    fakeShoot(state, shooter, sniper, 'Boltgun', { inCover: true });
    expect(defenceEvent(ctx, state, shooter, sniper, true).extraCoverSaves).toBe(1);
  });

  it('TARGETING OCULARS: Lethal 5+ and Saturate, "up to twice per turning point"', () => {
    expect(rule('scout-squad.eq.targeting-oculars')).toContain(
      'Up to twice per turning point, when a friendly SCOUT SQUAD operative is performing the Shoot action and you’re selecting a valid target, you can use this rule. If you do, until the end of that action, that friendly operative’s ranged weapons have the Lethal 5+ and Saturate weapon rules.',
    );
    const { ctx, state } = setup(['scout-squad.eq.targeting-oculars']);
    const shooter = state.operatives[opWith(state, 'p1', 'scout-squad.tracker')]!;
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    const boltgun = profileOf('scout-squad.tracker', 'Boltgun');
    const select = (): void => {
      ctx.hooks.emit('onSelectTarget', state, {
        state,
        attacker: shooter,
        target: foe,
        weaponName: 'Boltgun',
        profile: boltgun,
        rules: [...boltgun.rules],
      });
    };
    select();
    fakeShoot(state, shooter, foe, 'Boltgun');
    const armed = effectiveRules(ctx, state, boltgun, { operative: shooter, target: foe, weaponName: 'Boltgun' });
    expect(armed.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
    expect(armed.some((r) => r.id === 'Saturate')).toBe(true);

    select();
    select(); // the third Shoot of the turning point gets nothing
    state.sequence = null;
    fakeShoot(state, shooter, foe, 'Boltgun');
    const spent = effectiveRules(ctx, state, boltgun, { operative: shooter, target: foe, weaponName: 'Boltgun' });
    expect(spent.some((r) => r.id === 'Saturate')).toBe(false);
  });

  it('COMBAT BLADE is granted to operatives that lack it, never to one with "the better version"', () => {
    expect(rule('scout-squad.eq.combat-blade')).toContain(
      'Note that some operatives already have this weapon but with better stats; in that instance, use the better version.',
    );
    const { ctx, state } = setup(['scout-squad.eq.combat-blade']);
    const tracker = opWith(state, 'p1', 'scout-squad.tracker');
    const hunter = opWith(state, 'p1', 'scout-squad.hunter');
    const s = activate(ctx, state, tracker);
    const granted = (id: string): string[] =>
      ((s.operatives[id] as { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).map((w) => w.name);
    expect(granted(tracker)).toContain('Combat blade');
    expect(granted(hunter)).not.toContain('Combat blade');
    // The granted profile is the one printed in the JSON's equipment table, not a retyped copy.
    const blade = (s.operatives[tracker] as { grantedWeapons?: { profiles: WeaponProfile[] }[] }).grantedWeapons![0]!;
    const printed = (DATA.equipment.find((e) => e.id === 'scout-squad.eq.combat-blade') as { weapons?: { profiles: WeaponProfile[] }[] })
      .weapons![0]!;
    expect(blade.profiles[0]).toEqual(printed.profiles[0]);
    expect(printed.profiles[0]).toMatchObject({ type: 'melee', atk: 3, hit: 3, dmgN: 4, dmgC: 5 });
  });

  it('TACTICAL VOX-LINK refunds one Astartes Training or Emboldened Aspirant per turning point', () => {
    expect(rule('scout-squad.eq.tactical-vox-link')).toContain(
      'Once per turning point, you can use the Astartes Training or Emboldened Aspirant firefight ploy for 0CP if a friendly SERGEANT operative is in the killzone.',
    );
    const { ctx, state } = setup(['scout-squad.eq.tactical-vox-link']);
    state.teams.p1.cp = 5;
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.astartes-training' }, ctx).state;
    expect(s.teams.p1.cp).toBe(5); // 1CP spent, 1CP refunded
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'scout-squad.fp.emboldened-aspirant' }, ctx).state;
    expect(s.teams.p1.cp).toBe(4); // once per turning point
  });
});

// ---------------------------------------------------------------------------
describe('SCOUT SQUAD datacard abilities', () => {
  it('SERGEANT › Astartes: "either two Shoot actions or two Fight actions", one of them Astartes-armed', () => {
    expect(ability('scout-squad.sergeant', 'scout-squad.sergeant.astartes')).toContain(
      'it can perform either two Shoot actions or two Fight actions',
    );
    const { ctx, state } = setup();
    const sergeant = opWith(state, 'p1', 'scout-squad.sergeant');
    const foe = opWith(state, 'p2', 'scout-squad.tracker');
    const s = activate(ctx, state, sergeant);
    s.operatives[sergeant]!.pos = { x: 14, y: 11 };
    s.operatives[foe]!.pos = { x: 17, y: 11 };

    // First Shoot not yet performed.
    const early = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: SCOUT_ASTARTES_SHOOT, params: { weaponName: 'Astartes shotgun', targetId: foe } },
      ctx,
    );
    expect(early.reason).toMatch(/second Shoot action/);

    s.operatives[sergeant]!.actionsThisActivation = ['Shoot'];
    const ok = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: SCOUT_ASTARTES_SHOOT, params: { weaponName: 'Astartes shotgun', targetId: foe } },
      ctx,
    );
    expect(ok.ok).toBe(true);

    // "either two Shoot actions OR two Fight actions"
    const mixed = { ...s };
    mixed.operatives[sergeant]!.actionsThisActivation = ['Shoot', 'Fight'];
    const both = reduce(
      mixed,
      { t: 'PerformAction', operativeId: sergeant, action: SCOUT_ASTARTES_FIGHT, params: {} },
      ctx,
    );
    expect(both.reason).toMatch(/either two Shoot actions or two Fight actions/);
  });

  it('SERGEANT › Astartes: "This operative can counteract regardless of its order"', () => {
    expect(ability('scout-squad.sergeant', 'scout-squad.sergeant.astartes')).toContain(
      'This operative can counteract regardless of its order.',
    );
    const { ctx, state } = setup();
    const sergeant = state.operatives[opWith(state, 'p1', 'scout-squad.sergeant')]!;
    const warrior = state.operatives[opWith(state, 'p1', 'scout-squad.warrior')]!;
    const ids = (player: 'p1' | 'p2'): string[] => counteractCandidates(ctx, state, player).map((o) => o.id);

    // "each of their operatives that is EXPENDED" is the core's condition, and this rule does
    // not touch it: a ready SERGEANT is not a candidate whatever its order.
    sergeant.order = 'conceal';
    expect(ids('p1')).not.toContain(sergeant.id);

    for (const op of [sergeant, warrior]) {
      op.expended = true;
      op.ready = false;
      op.order = 'conceal';
    }
    // The clause reaches a Conceal SERGEANT — the whole point of it.
    expect(ids('p1')).toContain(sergeant.id);
    // …and the printed default (an Engage order) still counteracts.
    sergeant.order = 'engage';
    expect(ids('p1')).toContain(sergeant.id);

    // The clause is printed on the SERGEANT datacard, not on the faction rule, so a Conceal
    // WARRIOR is not widened by it.
    expect(ids('p1')).not.toContain(warrior.id);
    warrior.order = 'engage';
    expect(ids('p1')).toContain(warrior.id);

    // "can counteract ONCE during the turning point" is the core's condition, still enforced.
    sergeant.order = 'conceal';
    sergeant.counteractedThisTP = true;
    expect(ids('p1')).not.toContain(sergeant.id);
    sergeant.counteractedThisTP = false;

    // …as is the On Guard lockout ("that friendly operative cannot counteract during the
    // turning point").
    sergeant.guardSpentTP = state.turningPoint;
    expect(ids('p1')).not.toContain(sergeant.id);
    sergeant.guardSpentTP = null;
    expect(ids('p1')).toContain(sergeant.id);

    // The grant is friendly-only: an ENEMY Conceal operative this rule does not cover stays on
    // the printed default. The fixture puts SCOUT SQUAD on both sides, so p2's own copy of the
    // rule is dropped first — otherwise it, not p1's handler, would be what allows the enemy.
    const enemy = state.operatives[opWith(state, 'p2', 'scout-squad.sergeant')]!;
    enemy.expended = true;
    enemy.ready = false;
    enemy.order = 'conceal';
    expect(ids('p2')).toContain(enemy.id); // p2 has the same SERGEANT ability
    state.teams.p2.teamId = 'no-such-team';
    rebuildHooks(ctx, state);
    expect(ids('p2')).not.toContain(enemy.id);
    expect(ids('p1')).toContain(sergeant.id); // p1's grant is untouched
  });

  it('SERGEANT › Guidance and Experience adds 1 APL to one OTHER friendly operative, once per activation', () => {
    expect(ability('scout-squad.sergeant', 'scout-squad.sergeant.guidance-and-experience')).toContain(
      'Once during each of this operative’s activations, you can select one other friendly SCOUT SQUAD operative in the killzone. Until the end of that operative’s next activation, add 1 to its APL stat.',
    );
    const { ctx, state } = setup();
    const sergeant = opWith(state, 'p1', 'scout-squad.sergeant');
    const friend = opWith(state, 'p1', 'scout-squad.tracker');
    const foe = opWith(state, 'p2', 'scout-squad.tracker');
    let s = activate(ctx, state, sergeant);

    const enemyTarget = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: GUIDANCE_ACTION, params: { targetOperativeId: foe } },
      ctx,
    );
    expect(enemyTarget.ok).toBe(false);
    const itself = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: GUIDANCE_ACTION, params: { targetOperativeId: sergeant } },
      ctx,
    );
    expect(itself.ok).toBe(false);

    s = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: GUIDANCE_ACTION, params: { targetOperativeId: friend } },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[friend]!)).toBe(3);
    expect(s.operatives[sergeant]!.apSpent).toBe(0); // it costs no AP
    const again = reduce(
      s,
      { t: 'PerformAction', operativeId: sergeant, action: GUIDANCE_ACTION, params: { targetOperativeId: friend } },
      ctx,
    );
    expect(again.reason).toMatch(/action restrictions/);
  });

  it('HEAVY GUNNER › Heavy Weapon Bipod: Ceaseless when it has not moved, Relentless when it already has Ceaseless', () => {
    expect(ability('scout-squad.heavy-gunner', 'scout-squad.heavy-gunner.heavy-weapon-bipod')).toContain(
      'if it hasn’t moved during the activation, or if it’s a counteraction, that weapon has the Ceaseless weapon rule; if the weapon already has that weapon rule (i.e. from the Ambush strategy ploy), it has the Relentless weapon rule instead',
    );
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', 'scout-squad.heavy-gunner')]!;
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    const bolter = profileOf('scout-squad.heavy-gunner', 'Heavy bolter', 'focused');
    const use = { operative: gunner, target: foe, weaponName: 'Heavy bolter' };
    expect(effectiveRules(ctx, state, bolter, use).some((r) => r.id === 'Ceaseless')).toBe(true);

    gunner.actionsThisActivation = ['Reposition'];
    expect(effectiveRules(ctx, state, bolter, use).some((r) => r.id === 'Ceaseless')).toBe(false);

    // Ambush's Ceaseless (target expended) upgrades the bipod to Relentless.
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'scout-squad.sp.ambush' }, ctx).state;
    const id = gunner.id;
    s.operatives[id]!.actionsThisActivation = [];
    s = activate(ctx, s, id, 'engage');
    s.operatives[foe.id]!.expended = true;
    const rules = effectiveRules(ctx, s, bolter, {
      operative: s.operatives[id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Heavy bolter',
    });
    expect(rules.some((r) => r.id === 'Relentless')).toBe(true);
  });

  it('HUNTER › Grapnel Assault: Lethal 3+ after a Charge in which it changed level', () => {
    expect(ability('scout-squad.hunter', 'scout-squad.hunter.grapnel-assault')).toContain(
      'if it climbs, drops, jumps or its base moves underneath Vantage terrain during that action, its melee weapons have the Lethal 3+ weapon rule until the end of that activation',
    );
    const { ctx, state } = setup();
    const hunter = state.operatives[opWith(state, 'p1', 'scout-squad.hunter')]!;
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.hunter')]!;
    const blade = profileOf('scout-squad.hunter', 'Combat blade');
    const use = { operative: hunter, target: foe, weaponName: 'Combat blade' };
    state.opState['scoutSquad.activationZ'] = { [hunter.id]: 0 };

    hunter.actionsThisActivation = ['Reposition'];
    hunter.z = 3;
    expect(effectiveRules(ctx, state, blade, use).some((r) => r.id === 'Lethal')).toBe(false);

    hunter.actionsThisActivation = ['Charge'];
    expect(effectiveRules(ctx, state, blade, use).some((r) => r.id === 'Lethal' && r.x === 3)).toBe(true);

    hunter.z = 0; // a Charge on the flat is not a climb, drop or jump
    expect(effectiveRules(ctx, state, blade, use).some((r) => r.id === 'Lethal')).toBe(false);
  });

  it('HUNTER › Grapnel Launcher is reminder-only: the printed text is still carried', () => {
    // No hook can change a climb's charged vertical distance — `validateMove` computes it as
    // max(2, dz) with no seam, and `onMoveRules` is declared but never emitted.
    expect(ability('scout-squad.hunter', 'scout-squad.hunter.grapnel-launcher')).toContain(
      'Whenever this operative is climbing up, you can treat the vertical distance as 2"',
    );
  });

  it('SNIPER › Camo Cloak ignores Saturate and retains one additional cover save', () => {
    expect(ability('scout-squad.sniper', 'scout-squad.sniper.camo-cloak')).toContain('Ignore the Saturate weapon rule.');
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', 'scout-squad.sniper')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    fakeShoot(state, shooter, sniper, 'Boltgun', { inCover: true });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, sniper, 'Boltgun', profileOf('scout-squad.tracker', 'Boltgun'), { inCover: true }),
      count: 3,
      coverSave: false, // Saturate had denied the cover save
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.coverSave).toBe(true);
    expect(ev.extraCoverSaves).toBe(1);
  });

  it('WARRIOR › Adaptive Equipment: a free Smoke Grenade action, once per turning point, no equipment needed', () => {
    expect(ability('scout-squad.warrior', 'scout-squad.warrior.adaptive-equipment')).toContain(
      'Performing these actions using this rule doesn’t count towards their action limits',
    );
    const { ctx, state } = setup();
    const warriors = state.teams.p1.operativeIds.filter((id) => state.operatives[id]!.datacardId === 'scout-squad.warrior');
    expect(warriors.length).toBeGreaterThan(1);
    const first = warriors[0]!;
    let s = activate(ctx, state, first);
    const pos = { x: s.operatives[first]!.pos.x + 2, y: s.operatives[first]!.pos.y };
    const uses = { ...s.teams.p1.equipmentUses };
    const out = reduce(s, { t: 'PerformAction', operativeId: first, action: ADAPTIVE_SMOKE, params: { targetPos: pos } }, ctx);
    expect(out.ok).toBe(true);
    s = out.state;
    expect(Object.values(s.markers).some((m) => m.kind === 'smoke')).toBe(true);
    expect(s.teams.p1.equipmentUses).toEqual(uses); // the kill team's grenade budget is untouched

    s = reduce(s, { t: 'EndActivation', operativeId: first }, ctx).state;
    const second = warriors[1]!;
    s = activate(ctx, s, second);
    const again = reduce(
      s,
      { t: 'PerformAction', operativeId: second, action: ADAPTIVE_SMOKE, params: { targetPos: { x: s.operatives[second]!.pos.x + 2, y: s.operatives[second]!.pos.y } } },
      ctx,
    );
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/once per turning point/);
  });
});

// ---------------------------------------------------------------------------
describe('SCOUT SQUAD unique actions', () => {
  it('OPTICS 1AP: "whenever it’s shooting, enemy operatives cannot be obscured"', () => {
    expect(uniqueText('scout-squad.sniper', 'scout-squad.sniper.act.optics')).toContain(
      'Until the start of this operative’s next activation, whenever it’s shooting, enemy operatives cannot be obscured.',
    );
    const { ctx, state } = setup();
    const sniper = opWith(state, 'p1', 'scout-squad.sniper');
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    let s = activate(ctx, state, sniper);
    s = reduce(s, { t: 'PerformAction', operativeId: sniper, action: 'scout-squad.sniper.act.optics' }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'scoutSquad.optics' && e.operativeId === sniper)).toBe(true);

    const shooter = s.operatives[sniper]!;
    fakeShoot(s, shooter, foe, 'Sniper rifle', { obscured: true, profileName: 'mobile' });
    const rifle = profileOf('scout-squad.sniper', 'Sniper rifle', 'mobile');
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(shooter, foe, 'Sniper rifle', rifle, { obscured: true }),
      count: rifle.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(shootOf(s).obscured).toBe(false);
  });

  it('TRACK ENEMY 1AP gives friendly SCOUT SQUAD ranged weapons Seek Light against the marked enemy', () => {
    expect(uniqueText('scout-squad.tracker', 'scout-squad.tracker.act.track-enemy')).toContain(
      'Select one enemy operative within 8" of this operative. Until the end of the turning point, whenever a friendly SCOUT SQUAD operative is shooting that enemy operative, that friendly operative’s ranged weapons have the Seek Light weapon rule.',
    );
    const { ctx, state } = setup();
    const tracker = opWith(state, 'p1', 'scout-squad.tracker');
    const foe = opWith(state, 'p2', 'scout-squad.tracker');
    const far = opWith(state, 'p2', 'scout-squad.hunter');
    state.operatives[tracker]!.pos = { x: 6, y: 11 };
    state.operatives[foe]!.pos = { x: 12, y: 11 };
    state.operatives[far]!.pos = { x: 27, y: 11 };
    let s = activate(ctx, state, tracker);

    // D-026: the whole legality lives in `check`.
    expect(
      reduce(s, { t: 'PerformAction', operativeId: tracker, action: 'scout-squad.tracker.act.track-enemy', params: { targetOperativeId: far } }, ctx)
        .reason,
    ).toMatch(/more than 8" away/);
    expect(
      reduce(
        s,
        { t: 'PerformAction', operativeId: tracker, action: 'scout-squad.tracker.act.track-enemy', params: { targetOperativeId: opWith(s, 'p1', 'scout-squad.sniper') } },
        ctx,
      ).ok,
    ).toBe(false);

    s = reduce(
      s,
      { t: 'PerformAction', operativeId: tracker, action: 'scout-squad.tracker.act.track-enemy', params: { targetOperativeId: foe } },
      ctx,
    ).state;
    const boltgun = profileOf('scout-squad.tracker', 'Boltgun');
    expect(
      effectiveRules(ctx, s, boltgun, {
        operative: s.operatives[opWith(s, 'p1', 'scout-squad.warrior')]!,
        target: s.operatives[foe]!,
        weaponName: 'Boltgun',
      }).some((r) => r.id === 'SeekLight'),
    ).toBe(true);
  });

  it('AUSPEX SCAN 1AP denies obscured within 8", and adds Seek Light for a SNIPER using OPTICS', () => {
    expect(uniqueText('scout-squad.tracker', 'scout-squad.tracker.act.auspex-scan')).toContain(
      'whenever a friendly SCOUT SQUAD operative is shooting an enemy operative within 8" of this operative, that enemy operative cannot be obscured; if that friendly operative is a SNIPER that’s currently benefitting from the effects of its Optics action, its ranged weapons also have the Seek Light weapon rule',
    );
    const { ctx, state } = setup();
    const tracker = opWith(state, 'p1', 'scout-squad.tracker');
    const sniper = opWith(state, 'p1', 'scout-squad.sniper');
    const foe = state.operatives[opWith(state, 'p2', 'scout-squad.tracker')]!;
    state.operatives[tracker]!.pos = { x: 10, y: 11 };
    state.operatives[sniper]!.pos = { x: 4, y: 11 };
    foe.pos = { x: 15, y: 11 };

    let s = activate(ctx, state, tracker);
    s = reduce(s, { t: 'PerformAction', operativeId: tracker, action: 'scout-squad.tracker.act.auspex-scan' }, ctx).state;
    s = reduce(s, { t: 'EndActivation', operativeId: tracker }, ctx).state;

    const shot = s.operatives[sniper]!;
    const rifle = profileOf('scout-squad.sniper', 'Sniper rifle', 'mobile');
    fakeShoot(s, shot, s.operatives[foe.id]!, 'Sniper rifle', { obscured: true, profileName: 'mobile' });
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(shot, s.operatives[foe.id]!, 'Sniper rifle', rifle, { obscured: true }),
      count: rifle.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(shootOf(s).obscured).toBe(false);

    const use = { operative: shot, target: s.operatives[foe.id]!, weaponName: 'Sniper rifle' };
    expect(effectiveRules(ctx, s, rifle, use).some((r) => r.id === 'SeekLight')).toBe(false);
    s = activate(ctx, s, sniper);
    s = reduce(s, { t: 'PerformAction', operativeId: sniper, action: 'scout-squad.sniper.act.optics' }, ctx).state;
    expect(
      effectiveRules(ctx, s, rifle, {
        operative: s.operatives[sniper]!,
        target: s.operatives[foe.id]!,
        weaponName: 'Sniper rifle',
      }).some((r) => r.id === 'SeekLight'),
    ).toBe(true);
  });
});
