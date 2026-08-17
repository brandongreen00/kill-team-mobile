/**
 * WOLF SCOUTS. Every test quotes the printed rule it pins, read out of
 * `data/teams/wolf-scouts.json` rather than retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/wolf-scouts/
 */
import { describe, expect, it } from 'vitest';
import { getAction } from '../../src/core/actions.ts';
import { newPool } from '../../src/core/dice.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { hitOf, inflictDamage, moveOf } from '../../src/core/state.ts';
import { rareWeaponRules } from '../../src/core/weaponRules.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  CHANGE_ORDER_COUNTERACT,
  CHARGE_INSTINCT,
  CHARGE_STORM,
  ELEMENTAL_STORM_GAMBIT,
  FIGHT_COUNTERATTACK,
  FIGHT_HUNTING,
  GUARD_STORM_VEILED,
  LAST_RANGED,
  PLACE_HAYWIRE,
  POUNCE_GAMBIT,
  SHOOT_HUNTING,
  SHOOT_HUNTING_PLASMA,
  haywireMarkerId,
  runeCredits,
  stormMarkerId,
  wolfScouts,
} from '../../src/teams/wolf-scouts/index.ts';
import { act, activate, battle, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';

const DATA = teamData('wolf-scouts');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const ability = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const uaText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

const PACK_LEADER = 'wolf-scouts.pack-leader';
const FANGBEARER = 'wolf-scouts.fangbearer';
const FROSTEYE = 'wolf-scouts.frosteye';
const GUNNER = 'wolf-scouts.gunner';
const HUNTER = 'wolf-scouts.hunter';
const RUNE_PRIEST = 'wolf-scouts.rune-priest-skjald';
const TRAPMASTER = 'wolf-scouts.trapmaster';
const WOLF = 'wolf-scouts.fenrisian-wolf';

const HEALING_BALMS = 'wolf-scouts.fangbearer.act.healing-balms';
const HUNTERS_SENSES = 'wolf-scouts.frosteye.act.hunters-senses';
const CALL_THE_STORM = 'wolf-scouts.rune-priest-skjald.act.call-the-storm';

const EVERY_ROLE = [PACK_LEADER, FANGBEARER, FROSTEYE, GUNNER, HUNTER, RUNE_PRIEST, TRAPMASTER, WOLF];

function setup(
  equipment: string[] = [],
  opts: { seed?: number; script?: number[] } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([wolfScouts], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = rosterIncluding(wolfScouts, EVERY_ROLE);
  const state = battle({
    ctx,
    p1: { module: wolfScouts, equipment, picks },
    p2: { module: wolfScouts, picks },
  });
  state.teams.p1.cp = 4;
  state.teams.p2.cp = 4;
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = cardOf(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

/** Put the Storm marker down without going through the gambit. */
function placeStormAt(state: GameState, player: 'p1' | 'p2', x: number, y: number): void {
  state.markers[stormMarkerId(player)] = {
    id: stormMarkerId(player),
    kind: 'generic',
    diameterMm: 20,
    pos: { x, y },
    z: 0,
    owner: player,
    flags: { storm: true },
  };
}

/** A shoot sequence parked at a given step, for rules that read the live sequence. */
function fakeShoot(
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  weaponName: string,
  over: Partial<ShootSequence> = {},
): ShootSequence {
  const seq: ShootSequence = {
    kind: 'shoot',
    step: 'rollAttack',
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
    attack: newPool(),
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: attacker.player,
    defender: target.player,
    free: false,
    ...over,
  };
  state.sequence = seq;
  return seq;
}

function fakeFight(
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  attackerWeapon: string,
  defenderWeapon: string,
): FightSequence {
  const seq: FightSequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerWeapon,
    defenderWeapon,
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: attacker.player,
    defender: defender.player,
    free: false,
    hatchway: false,
  };
  state.sequence = seq;
  return seq;
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  type: 'ranged' | 'melee',
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules: profile.rules,
    type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 4,
  };
}

const zeroMods = () => ({ hit: 0, save: 0, apl: 0, move: 0, atk: 0 });

// ---------------------------------------------------------------------------
describe('WOLF SCOUTS data (pinned against data/teams/wolf-scouts.json)', () => {
  it('has 8 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(8);
    for (const id of [PACK_LEADER, FANGBEARER, FROSTEYE, GUNNER, HUNTER, RUNE_PRIEST, TRAPMASTER]) {
      expect(cardOf(id), id).toMatchObject({ apl: 3, move: 7, save: 3, wounds: 13, base: { shape: 'round', mm: 32 } });
    }
    expect(cardOf(WOLF)).toMatchObject({ apl: 2, move: 8, save: 5, wounds: 9, base: { shape: 'oval', mm: [60, 35] } });
    expect(cardOf(PACK_LEADER).keywords).toEqual([
      'WOLF SCOUT',
      'IMPERIUM',
      'ADEPTUS ASTARTES',
      'SPACE WOLVES',
      'PACK',
      'LEADER',
    ]);
    expect(cardOf(RUNE_PRIEST).keywords).toContain('PSYKER');
  });

  it('pins every weapon profile of the RUNE PRIEST SKJALD and the plasma weapons', () => {
    const flat = cardOf(RUNE_PRIEST).weapons.flatMap((w) =>
      w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')),
    );
    expect(flat).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Jaws of the World Wolf||ranged|5|3|3|5',
      'Thunderclap||ranged|5|2|2|2',
      'Runic stave||melee|5|3|4|6',
    ]);
    expect(profileOf(GUNNER, 'Plasma gun', 'supercharge').rules.map((r) => r.raw)).toEqual([
      'Hot',
      'Lethal 5+',
      'Piercing 1',
    ]);
    expect(profileOf(PACK_LEADER, 'Plasma pistol', 'standard').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Piercing 1',
    ]);
    expect(profileOf(WOLF, 'Fangs').rules.map((r) => r.id)).toEqual(['Rending']);
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 3 unique actions and 11 abilities', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Elemental Storm', 'Hunting Astartes']);
    expect(wolfScouts.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(wolfScouts.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(wolfScouts.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'HEALING BALMS',
      'HUNTER’S SENSES',
      'CALL THE STORM',
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(11);
  });

  it('registers the PSYCHIC rare weapon rule and fields a legal default roster (the PACK LEADER is in the list)', () => {
    expect(DATA.rareWeaponRules).toEqual(['PSYCHIC']);
    expect(rareWeaponRules().find((r) => r.id === 'PSYCHIC')?.teams).toContain('wolf-scouts');
    expect(DATA.selection.leader.inList).toBe(true);
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(6);
    expect(validateRosterFor(DATA, picks).errors).toEqual([]);
  });

  it('fills in the aiHints the generic AI needs (roles, ploy value, equipment value)', () => {
    for (const p of wolfScouts.ploys) expect(wolfScouts.aiHints!.ployValue![p.id], p.id).toBeGreaterThan(0);
    for (const e of wolfScouts.equipment) expect(wolfScouts.aiHints!.equipmentValue![e.id], e.id).toBeGreaterThan(0);
    for (const c of DATA.datacards) expect(wolfScouts.aiHints!.roles![c.id], c.id).toBeTruthy();
    // The two faction STRATEGIC GAMBITs are priced through the same table.
    expect(wolfScouts.aiHints!.ployValue![ELEMENTAL_STORM_GAMBIT]).toBeGreaterThan(0);
    expect(wolfScouts.aiHints!.ployValue![POUNCE_GAMBIT]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('Elemental Storm — "Remove your Storm marker from the killzone (if any), then place it in the killzone"', () => {
  it('is offered as a STRATEGIC GAMBIT and places the Storm marker; "within 6\\" horizontally … is within your STORM"', () => {
    expect(rule(ELEMENTAL_STORM_GAMBIT)).toContain('within 6" horizontally of your Storm marker');
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(options.map((o) => o.id)).toContain(ELEMENTAL_STORM_GAMBIT);

    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: ELEMENTAL_STORM_GAMBIT, data: { pos: { x: 12, y: 11 } } },
      ctx,
    ).state;
    expect(s.markers[stormMarkerId('p1')]?.pos).toEqual({ x: 12, y: 11 });

    // A HUNTER inside the STORM gains Severe (Fierce Temperament); outside it does not.
    const hunter = s.operatives[opWith(s, 'p1', HUNTER)]!;
    const blade = profileOf(HUNTER, 'Combat blade');
    hunter.pos = { x: 14, y: 11 };
    expect(
      effectiveRules(ctx, s, blade, { operative: hunter, weaponName: 'Combat blade' }).some((r) => r.id === 'Severe'),
    ).toBe(true);
    hunter.pos = { x: 24, y: 11 };
    expect(
      effectiveRules(ctx, s, blade, { operative: hunter, weaponName: 'Combat blade' }).some((r) => r.id === 'Severe'),
    ).toBe(false);
  });

  it('lets a Conceal-order WOLF SCOUT "perform the Charge action … if it ends that action within your STORM"', () => {
    expect(rule(ELEMENTAL_STORM_GAMBIT)).toContain('can perform the Charge action while it has a Conceal order');
    const { ctx, state } = setup();
    const hunterId = opWith(state, 'p1', HUNTER);
    const foeId = opWith(state, 'p2', HUNTER);
    state.operatives[hunterId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 13, y: 11 };
    for (const id of state.teams.p2.operativeIds) if (id !== foeId) state.operatives[id]!.pos = { x: 28, y: 20 };
    for (const id of state.teams.p1.operativeIds) if (id !== hunterId) state.operatives[id]!.pos = { x: 2, y: 20 };

    let s = activate(ctx, state, hunterId, 'conceal');
    const path = { points: [{ x: 11.4, y: 11 }] };
    // The universal Charge refuses a Conceal order…
    expect(getAction('Charge')!.check(ctx, s, s.operatives[hunterId]!, { path }).reason).toMatch(/Conceal order/);
    // …and so does the Elemental Storm charge, until the Storm marker covers the end point.
    expect(getAction(CHARGE_STORM)!.check(ctx, s, s.operatives[hunterId]!, { path }).reason).toMatch(/within your STORM/);

    placeStormAt(s, 'p1', 12, 11);
    expect(getAction(CHARGE_STORM)!.check(ctx, s, s.operatives[hunterId]!, { path }).ok).toBe(true);
    s = act(ctx, s, hunterId, CHARGE_STORM, { path }).state;
    expect(s.operatives[hunterId]!.pos.x).toBeCloseTo(11.4);
    // `treatedAs: 'Charge'` shares the universal action's restrictions.
    expect(s.operatives[hunterId]!.actionsThisActivation).toContain('Charge');
  });
});

// ---------------------------------------------------------------------------
describe('Hunting Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('charges "1 additional AP … if both actions are using a plasma gun or plasma pistol"', () => {
    expect(rule('wolf-scouts.rule.hunting-astartes')).toContain(
      '1 additional AP must be spent for the second action if both actions are using a plasma gun or plasma pistol',
    );
    const { ctx, state } = setup();
    const gunnerId = opWith(state, 'p1', GUNNER);
    const foeA = opWith(state, 'p2', HUNTER);
    const foeB = opWith(state, 'p2', GUNNER);
    state.operatives[gunnerId]!.pos = { x: 10, y: 11 };
    state.operatives[foeA]!.pos = { x: 16, y: 11 };
    state.operatives[foeB]!.pos = { x: 16, y: 15 };
    for (const id of state.teams.p1.operativeIds) if (id !== gunnerId) state.operatives[id]!.pos = { x: 2, y: 20 };

    let s = activate(ctx, state, gunnerId);
    s = act(ctx, s, gunnerId, 'Shoot', { weaponName: 'Plasma gun', profileName: 'standard', targetId: foeA }).state;
    s = settle(ctx, s);
    expect(s.operatives[gunnerId]!.actionsThisActivation).toContain('Shoot');

    const gunner = s.operatives[gunnerId]!;
    const params = { weaponName: 'Plasma gun', profileName: 'standard', targetId: foeB };
    expect(getAction(SHOOT_HUNTING)!.check(ctx, s, gunner, params).reason).toMatch(/1 additional AP/);
    expect(getAction(SHOOT_HUNTING_PLASMA)!.check(ctx, s, gunner, params).ok).toBe(true);
    expect(getAction(SHOOT_HUNTING_PLASMA)!.ap).toBe(2);
    expect(getAction(SHOOT_HUNTING)!.ap).toBe(1);

    // …and it really resolves as a second Shoot, for 1 + 2 of the GUNNER's 3AP.
    const out = act(ctx, s, gunnerId, SHOOT_HUNTING_PLASMA, params);
    expect(out.ok, out.reason).toBe(true);
    s = settle(ctx, out.state);
    expect(s.operatives[gunnerId]!.apSpent).toBe(3);
    expect(s.rejected).toEqual([]);
  });

  it('"You cannot select two PSYCHIC ranged weapons"', () => {
    expect(rule('wolf-scouts.rule.hunting-astartes')).toContain('You cannot select two PSYCHIC ranged weapons');
    const { ctx, state } = setup();
    const priestId = opWith(state, 'p1', RUNE_PRIEST);
    const foeId = opWith(state, 'p2', HUNTER);
    state.operatives[priestId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 14, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (id !== priestId) state.operatives[id]!.pos = { x: 2, y: 20 };
    for (const id of state.teams.p2.operativeIds) if (id !== foeId) state.operatives[id]!.pos = { x: 28, y: 20 };

    const s = activate(ctx, state, priestId);
    const priest = s.operatives[priestId]!;
    priest.actionsThisActivation = ['Shoot'];
    s.effects.push({
      id: 'test-last-ranged',
      rule: LAST_RANGED,
      source: { kind: 'core', id: 'test' },
      operativeId: priestId,
      player: 'p1',
      data: { weapon: 'Jaws of the World Wolf' },
      expiry: { kind: 'endOfActivation', operativeId: priestId },
    });
    expect(
      getAction(SHOOT_HUNTING)!.check(ctx, s, priest, { weaponName: 'Thunderclap', targetId: foeId }).reason,
    ).toMatch(/two PSYCHIC ranged weapons/);
    // A non-PSYCHIC second weapon is fine.
    expect(getAction(SHOOT_HUNTING)!.check(ctx, s, priest, { weaponName: 'Bolt pistol', targetId: foeId }).ok).toBe(true);
  });

  it('allows a second Fight action, but never a second Shoot AND a second Fight', () => {
    const { ctx, state } = setup();
    const hunterId = opWith(state, 'p1', HUNTER);
    const foeId = opWith(state, 'p2', HUNTER);
    state.operatives[hunterId]!.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 11.4, y: 11 };
    const s = activate(ctx, state, hunterId);
    const op = s.operatives[hunterId]!;

    op.actionsThisActivation = ['Fight'];
    expect(getAction(FIGHT_HUNTING)!.check(ctx, s, op, { targetId: foeId }).ok).toBe(true);
    op.actionsThisActivation = ['Shoot', 'Fight', SHOOT_HUNTING];
    expect(getAction(FIGHT_HUNTING)!.check(ctx, s, op, { targetId: foeId }).reason).toMatch(/second Shoot action/);
    op.actionsThisActivation = [];
    expect(getAction(FIGHT_HUNTING)!.check(ctx, s, op, { targetId: foeId }).reason).toMatch(/second Fight action/);
  });

  it('"…change its order instead of performing an action" while counteracting within your STORM', () => {
    expect(rule('wolf-scouts.rule.hunting-astartes')).toContain('or change its order instead of performing an action');
    const { ctx, state } = setup();
    const hunterId = opWith(state, 'p1', HUNTER);
    state.operatives[hunterId]!.pos = { x: 10, y: 11 };
    state.opState['counteract'] = { operativeId: hunterId, actionsUsed: 0 };
    const op = state.operatives[hunterId]!;
    expect(getAction(CHANGE_ORDER_COUNTERACT)!.check(ctx, state, op, {}).reason).toMatch(/within your STORM/);

    placeStormAt(state, 'p1', 10, 11);
    expect(getAction(CHANGE_ORDER_COUNTERACT)!.check(ctx, state, op, {}).ok).toBe(true);
    op.order = 'engage';
    getAction(CHANGE_ORDER_COUNTERACT)!.perform(ctx, state, op, {});
    expect(op.order).toBe('conceal');
  });

  it('is reminder-only for "can counteract regardless of its order" (the engine filters on Engage first)', () => {
    expect(rule('wolf-scouts.rule.hunting-astartes')).toContain(
      'Each friendly WOLF SCOUT operative can counteract regardless of its order',
    );
    const { ctx, state } = setup();
    const hunterId = opWith(state, 'p1', HUNTER);
    const op = state.operatives[hunterId]!;
    op.expended = true;
    op.order = 'conceal';
    // `counteractCandidates` filters `order === 'engage'` BEFORE `onCounteract` is emitted, and
    // the hook can only forbid — so no team rule can widen the candidate list.
    const ev = ctx.hooks.emit('onCounteract', state, { state, operative: op, allowed: true });
    expect(ev.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('WOLF SCOUTS datacard abilities', () => {
  it('Grizzled Veteran: "it\'s not incapacitated, has 1 wound remaining and cannot be incapacitated for the remainder of the action"', () => {
    const { ctx, state } = setup();
    const pack = state.operatives[opWith(state, 'p1', PACK_LEADER)]!;
    const foe = state.operatives[opWith(state, 'p2', PACK_LEADER)]!;
    pack.pos = { x: 10, y: 11 };
    foe.pos = { x: 11.4, y: 11 };
    const seq = fakeFight(state, foe, pack, 'Power weapon', 'Power weapon');
    seq.attackerPool.dice.push({ id: 1, value: 6, state: 'crit', rolled: true });
    seq.defenderPool.dice.push({ id: 1, value: 5, state: 'normal', rolled: true });

    inflictDamage(ctx, state, pack, 20, 'attack');
    expect(pack.incapacitated).toBeFalsy();
    expect(pack.wounds).toBe(1);
    // "All remaining attack dice are discarded (including yours if this operative is … retaliating)."
    expect(seq.attackerPool.dice[0]!.state).toBe('discarded');
    expect(seq.defenderPool.dice[0]!.state).toBe('discarded');
    // "…and cannot be incapacitated for the remainder of the action."
    inflictDamage(ctx, state, pack, 20, 'attack');
    expect(pack.incapacitated).toBeFalsy();
    // "You cannot use the Counterattack firefight ploy … at the end of that action."
    const counter = wolfScouts.ploys.find((p) => p.id === 'wolf-scouts.fp.counterattack')!;
    expect(counter.usable!(state, 'p1').ok).toBe(false);
  });

  it('Lupine Guile is reminder-only: the initiative roll-off has no post-roll re-roll seam', () => {
    expect(ability(PACK_LEADER, 'wolf-scouts.pack-leader.lupine-guile')).toContain(
      'after rolling off to decide initiative',
    );
    const { ctx, state } = setup();
    // `initiativeRollModifiers` is emitted BEFORE the dice are rolled and its `rerollOffered`
    // field is never read back, so there is nothing a hook can re-roll.
    const ev = ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p1', mod: 0, rerollOffered: false });
    expect(ev.mod).toBe(0);
    expect(ev.rerollOffered).toBe(false);
  });

  it('Spiritual Chirurgy: "ignore any changes to the stats … from being injured (including their weapons\' stats)"', () => {
    const { ctx, state } = setup();
    const hunter = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const wolf = state.operatives[opWith(state, 'p1', WOLF)]!;
    hunter.wounds = 5; // 13 wounds → injured below 6.5
    wolf.wounds = 4; // 9 wounds → injured below 4.5
    expect(moveOf(ctx, state, hunter)).toBe(7);
    expect(hitOf(ctx, state, hunter, profileOf(HUNTER, 'Combat blade'))).toBe(3);
    // "(excluding FENRISIAN WOLF)"
    expect(moveOf(ctx, state, wolf)).toBe(6);

    // "…friendly operatives have this rule if you select this operative for the battle (even if
    //  it's incapacitated later)."
    const fang = state.operatives[opWith(state, 'p1', FANGBEARER)]!;
    fang.removed = true;
    fang.incapacitated = true;
    expect(moveOf(ctx, state, hunter)).toBe(7);
  });

  it('Storm-veiled Execution: Guard "regardless of the killzone" and "while it has a Conceal order"', () => {
    expect(ability(FROSTEYE, 'wolf-scouts.frosteye.storm-veiled-execution')).toContain(
      'It can perform the Guard action while it has a Conceal order',
    );
    const { ctx, state } = setup();
    const frosteye = state.operatives[opWith(state, 'p1', FROSTEYE)]!;
    frosteye.pos = { x: 10, y: 11 };
    frosteye.order = 'conceal';
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    // The test killzone is not Close Quarters, so the universal Guard is not even available.
    expect(state.map.closeQuarters).toBe(false);
    expect(getAction('Guard')!.available!(ctx, state, frosteye)).toBe(false);

    expect(getAction(GUARD_STORM_VEILED)!.check(ctx, state, frosteye, {}).reason).toMatch(/within your STORM/);
    placeStormAt(state, 'p1', 10, 11);
    expect(getAction(GUARD_STORM_VEILED)!.check(ctx, state, frosteye, {}).ok).toBe(true);
    getAction(GUARD_STORM_VEILED)!.perform(ctx, state, frosteye, {});
    expect(frosteye.onGuard).toBe(true);
  });

  it('Tempest’s Fury: "All profiles of its plasma gun have the Punishing weapon rule … (supercharge) doesn’t have the Hot weapon rule"', () => {
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    gunner.pos = { x: 10, y: 11 };
    const supercharge = profileOf(GUNNER, 'Plasma gun', 'supercharge');
    const before = effectiveRules(ctx, state, supercharge, { operative: gunner, weaponName: 'Plasma gun' });
    expect(before.some((r) => r.id === 'Hot')).toBe(true);
    expect(before.some((r) => r.id === 'Punishing')).toBe(false);

    placeStormAt(state, 'p1', 10, 11);
    const after = effectiveRules(ctx, state, supercharge, { operative: gunner, weaponName: 'Plasma gun' });
    expect(after.some((r) => r.id === 'Punishing')).toBe(true);
    expect(after.some((r) => r.id === 'Hot')).toBe(false);
    const standard = effectiveRules(ctx, state, profileOf(GUNNER, 'Plasma gun', 'standard'), {
      operative: gunner,
      weaponName: 'Plasma gun',
    });
    expect(standard.some((r) => r.id === 'Punishing')).toBe(true);
  });

  it('Fierce Temperament: "Whenever this operative is within your STORM, its weapons have the Severe weapon rule"', () => {
    expect(ability(HUNTER, 'wolf-scouts.hunter.fierce-temperament')).toContain('its weapons have the Severe weapon rule');
    const { ctx, state } = setup();
    const hunter = state.operatives[opWith(state, 'p1', HUNTER)]!;
    hunter.pos = { x: 10, y: 11 };
    placeStormAt(state, 'p1', 10, 11);
    for (const [weapon, profile] of [
      ['Plasma pistol', 'standard'],
      ['Combat blade', undefined],
    ] as const) {
      const rules = effectiveRules(ctx, state, profileOf(HUNTER, weapon, profile), {
        operative: hunter,
        weaponName: weapon,
      });
      expect(rules.some((r) => r.id === 'Severe'), weapon).toBe(true);
    }
  });

  it('Cast the Runes: "For each result of 5-6, you gain 1CP" and 1-4 is a 0CP Command Re-roll in that turning point', () => {
    const { ctx, state } = setup([], { script: [5, 2, 2] });
    const cpBefore = state.teams.p1.cp;
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(state.teams.p1.cp).toBe(cpBefore + 1);
    expect(runeCredits(state, 'p1')).toEqual({ '2': 2 });
    // "…once during the turning point that matches the result."
    state.turningPoint = 2;
    const attacker = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const target = state.operatives[opWith(state, 'p2', HUNTER)]!;
    fakeShoot(state, attacker, target, 'Plasma pistol');
    const grants = [{ id: 'commandReroll:attack', label: 'Command Re-roll (1CP)', mode: 'one' as const, cp: 1, player: 'p1' as const }];
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(attacker, target, 'Plasma pistol', profileOf(HUNTER, 'Plasma pistol', 'standard'), 'ranged'),
      dice: [],
      rerolls: grants,
    });
    expect(grants[0]!.cp).toBe(0);
    expect(runeCredits(state, 'p1')['2']).toBe(1);
  });

  it('Haywire Mine: the TRAPMASTER carries your marker, controls it, and cannot place it in another operative’s control range', () => {
    expect(ability(TRAPMASTER, 'wolf-scouts.trapmaster.haywire-mine')).toContain(
      'that marker cannot be placed within another operative’s control range',
    );
    const { ctx, state } = setup();
    const trapId = opWith(state, 'p1', TRAPMASTER);
    const mateId = opWith(state, 'p1', HUNTER);
    state.operatives[trapId]!.pos = { x: 10, y: 11 };
    state.operatives[mateId]!.pos = { x: 11.4, y: 11 };
    const s = activate(ctx, state, trapId);
    const marker = s.markers[haywireMarkerId('p1')];
    expect(marker).toBeDefined();
    expect(marker!.carriedBy).toBe(trapId);
    expect(s.operatives[trapId]!.carryingMarkerId).toBe(marker!.id);

    // "It can perform the Pick Up Marker action on that marker" — and only YOU control it.
    expect(marker!.flags['pickUpAllowed']).toBe(true);
    const control = ctx.hooks.emit('onMarkerControl', s, {
      state: s,
      markerId: haywireMarkerId('p1'),
      aplByPlayer: { p1: 0, p2: 3 },
    });
    expect(control.forced).toBe('p1');

    // The universal Place Marker is refused in favour of the restricted variant.
    const gate = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[trapId]!,
      action: 'Place Marker',
      allowed: true,
    });
    expect(gate.allowed).toBe(false);
    const trap = s.operatives[trapId]!;
    expect(getAction(PLACE_HAYWIRE)!.check(ctx, s, trap, { markerPos: { x: 10.8, y: 11 } }).reason).toMatch(
      /another operative’s control range/,
    );
    expect(getAction(PLACE_HAYWIRE)!.check(ctx, s, trap, { markerPos: { x: 9.2, y: 11 } }).ok).toBe(true);
    getAction(PLACE_HAYWIRE)!.perform(ctx, s, trap, { markerPos: { x: 9.2, y: 11 } });
    expect(s.markers[haywireMarkerId('p1')]!.carriedBy).toBeUndefined();
    expect(trap.carryingMarkerId).toBeUndefined();
  });

  it('Proximity Mine is reminder-only: the engine has no post-move seam a team can own', () => {
    expect(ability(TRAPMASTER, 'wolf-scouts.trapmaster.proximity-mine')).toContain('inflict 2D3+3 damage on it');
    const { ctx, state } = setup();
    const trapId = opWith(state, 'p1', TRAPMASTER);
    const s = activate(ctx, state, trapId);
    // The universal mine trigger in `applyMove` is hard-coded to markers of kind 'mine' with
    // D3+3 damage, so the Haywire Mine marker is deliberately NOT of that kind: it would fire
    // the wrong effect, on the wrong operatives, including its own carrier.
    expect(s.markers[haywireMarkerId('p1')]!.kind).not.toBe('mine');
  });

  it('Instinctive Predator: "cannot perform any actions other than Charge, Dash, Fall Back, Fight, Guard and Reposition"', () => {
    const { ctx, state } = setup();
    const wolf = state.operatives[opWith(state, 'p1', WOLF)]!;
    const foeId = opWith(state, 'p2', HUNTER);
    wolf.pos = { x: 10, y: 11 };
    state.operatives[foeId]!.pos = { x: 14, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (id !== wolf.id) state.operatives[id]!.pos = { x: 2, y: 20 };
    for (const id of state.teams.p2.operativeIds) if (id !== foeId) state.operatives[id]!.pos = { x: 28, y: 20 };

    const gate = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: wolf, action, allowed: true }).allowed;
    for (const a of ['Charge', 'Dash', 'Fall Back', 'Fight', 'Guard', 'Reposition']) expect(gate(a), a).toBe(true);
    for (const a of ['Shoot', 'Pick Up Marker', 'Place Marker', 'Operate Hatch']) expect(gate(a), a).toBe(false);

    // "This operative can perform the Charge action while it has a Conceal order."
    const s = activate(ctx, state, wolf.id, 'conceal');
    const path = { points: [{ x: 12, y: 11 }] };
    expect(getAction('Charge')!.check(ctx, s, s.operatives[wolf.id]!, { path }).ok).toBe(false);
    expect(getAction(CHARGE_INSTINCT)!.check(ctx, s, s.operatives[wolf.id]!, { path }).ok).toBe(true);
  });

  it('Pounce: "Once per battle STRATEGIC GAMBIT … a free Charge, Fall Back or Reposition action"', () => {
    expect(ability(WOLF, POUNCE_GAMBIT)).toContain('Once per battle STRATEGIC GAMBIT');
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const wolfId = opWith(state, 'p1', WOLF);
    expect(
      ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options.map((o) => o.id),
    ).toContain(POUNCE_GAMBIT);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: POUNCE_GAMBIT }, ctx).state;
    const wolf = s.operatives[wolfId]!;
    const gate = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: wolf, action, allowed: true }).allowed;
    // "until the end of its next activation, subtract 1 from its APL stat and it cannot perform
    //  any of the aforementioned actions" — its own AP cannot move…
    wolf.apSpent = 0;
    expect(gate('Reposition')).toBe(false);
    expect(gate('Fight')).toBe(true);
    // …while the free action must be one of them.
    wolf.apSpent = 1;
    expect(gate('Reposition')).toBe(true);
    expect(gate('Fight')).toBe(false);

    // "Once per battle" survives the per-turning-point gambit reset.
    s.teams.p1.gambitsUsedTP = [];
    expect(
      ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options.map((o) => o.id),
    ).not.toContain(POUNCE_GAMBIT);
  });
});

// ---------------------------------------------------------------------------
describe('WOLF SCOUTS unique actions', () => {
  it('HEALING BALMS 1AP: "one friendly WOLF SCOUT operative within this operative’s control range to regain up to D3+3 lost wounds"', () => {
    const { ctx, state } = setup();
    const fangId = opWith(state, 'p1', FANGBEARER);
    const patientId = opWith(state, 'p1', HUNTER);
    state.operatives[fangId]!.pos = { x: 10, y: 11 };
    state.operatives[patientId]!.pos = { x: 11.4, y: 11 };
    state.operatives[patientId]!.wounds = 2;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };

    let s = activate(ctx, state, fangId);
    // "This operative cannot perform this action while within control range of an enemy operative."
    const enemyId = opWith(s, 'p2', HUNTER);
    expect(
      getAction(HEALING_BALMS)!.check(ctx, s, s.operatives[fangId]!, { targetOperativeId: enemyId }).ok,
    ).toBe(false);

    s = act(ctx, s, fangId, HEALING_BALMS, { targetOperativeId: patientId }).state;
    expect(s.operatives[patientId]!.wounds).toBeGreaterThanOrEqual(6);
    expect(s.operatives[patientId]!.wounds).toBeLessThanOrEqual(8);
  });

  it('HUNTER’S SENSES 1AP grants the chosen rule to the instigator bolt carbine (the printed option list is missing from the data)', () => {
    const printed = uaText(FROSTEYE, HUNTERS_SENSES);
    expect(printed).toContain('Select one of the following rules for this operative’s instigator bolt carbine');
    // DATA GAP: the bullet list the sentence introduces is absent — the first paragraph ends at
    // the colon and the next paragraph is the engagement restriction.
    expect(printed.split('\n')[0]!.trim().endsWith(':')).toBe(true);

    const { ctx, state } = setup();
    const frosteyeId = opWith(state, 'p1', FROSTEYE);
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, frosteyeId);
    // Without a choice the action refuses rather than inventing an option the source never printed.
    expect(reduce(s, { t: 'PerformAction', operativeId: frosteyeId, action: HUNTERS_SENSES }, ctx).ok).toBe(false);

    s = act(ctx, s, frosteyeId, HUNTERS_SENSES, { choice: 'Severe' }).state;
    const rules = effectiveRules(ctx, s, profileOf(FROSTEYE, 'Instigator bolt carbine'), {
      operative: s.operatives[frosteyeId]!,
      weaponName: 'Instigator bolt carbine',
    });
    expect(rules.some((r) => r.id === 'Severe')).toBe(true);
  });

  it('CALL THE STORM 1AP: "Remove your Storm marker from the killzone (if any), then place it in the killzone"', () => {
    expect(uaText(RUNE_PRIEST, CALL_THE_STORM)).toContain('PSYCHIC. Remove your Storm marker from the killzone');
    const { ctx, state } = setup();
    const priestId = opWith(state, 'p1', RUNE_PRIEST);
    state.operatives[priestId]!.pos = { x: 10, y: 11 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    placeStormAt(state, 'p1', 2, 2);
    let s = activate(ctx, state, priestId);
    s = act(ctx, s, priestId, CALL_THE_STORM, { targetPos: { x: 12, y: 11 } }).state;
    expect(s.markers[stormMarkerId('p1')]!.pos).toEqual({ x: 12, y: 11 });
    expect(Object.values(s.markers).filter((m) => m.flags['storm'])).toHaveLength(1);
  });

  it('CALL THE STORM (alternative): "whenever that friendly operative is within your STORM and more than 3\\" from the active operative, it’s obscured"', () => {
    const { ctx, state } = setup();
    const priestId = opWith(state, 'p1', RUNE_PRIEST);
    const wardId = opWith(state, 'p1', HUNTER);
    const foeId = opWith(state, 'p2', HUNTER);
    state.operatives[priestId]!.pos = { x: 8, y: 11 };
    state.operatives[wardId]!.pos = { x: 12, y: 11 };
    state.operatives[foeId]!.pos = { x: 20, y: 11 };
    for (const id of state.teams.p2.operativeIds) if (id !== foeId) state.operatives[id]!.pos = { x: 28, y: 20 };
    placeStormAt(state, 'p1', 12, 11);

    let s = activate(ctx, state, priestId);
    s = act(ctx, s, priestId, CALL_THE_STORM, { choice: 'obscure', targetOperativeId: wardId }).state;
    expect(s.effects.some((e) => e.rule === 'wolf-scouts.callTheStorm' && e.operativeId === wardId)).toBe(true);

    const shooter = s.operatives[foeId]!;
    const ward = s.operatives[wardId]!;
    s.activeOperativeId = shooter.id;
    const seq = fakeShoot(s, shooter, ward, 'Plasma pistol');
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(shooter, ward, 'Plasma pistol', profileOf(HUNTER, 'Plasma pistol', 'standard'), 'ranged'),
      count: 4,
      mods: zeroMods(),
    });
    expect(seq.obscured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('WOLF SCOUTS strategy ploys', () => {
  it('CLOAKED BY THE STORM: "you can re-roll one of your defence dice"', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const shooter = state.operatives[opWith(state, 'p2', HUNTER)]!;
    target.pos = { x: 12, y: 11 };
    placeStormAt(state, 'p1', 12, 11);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'wolf-scouts.sp.cloaked-by-the-storm' }, ctx).state;
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(shooter, s.operatives[target.id]!, 'Plasma pistol', profileOf(HUNTER, 'Plasma pistol', 'standard'), 'ranged'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroMods(),
      rerolls: [],
    });
    expect(ev.rerolls.some((r) => r.id === 'wolf-scouts.cloakedByTheStorm')).toBe(true);
  });

  it('STORM’S BITE: "subtract 1 from the Atk stat of that enemy operative’s melee weapons (to a minimum of 3)"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const enemy = state.operatives[opWith(state, 'p2', HUNTER)]!;
    mine.pos = { x: 11, y: 11 };
    enemy.pos = { x: 12.4, y: 11 };
    placeStormAt(state, 'p1', 12, 11);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'wolf-scouts.sp.storms-bite' }, ctx).state;
    const blade = profileOf(HUNTER, 'Combat blade');
    const roll = (count: number): number =>
      ctx.hooks.emit('onCollectAttackDice', s, {
        state: s,
        ctx: attackCtx(s.operatives[enemy.id]!, s.operatives[mine.id]!, 'Combat blade', blade, 'melee'),
        count,
        mods: zeroMods(),
      }).count;
    expect(roll(5)).toBe(4);
    expect(roll(3)).toBe(3); // "(to a minimum of 3)"
  });

  it('TEMPESTUOUS WRATH: "if it’s within your STORM or was within your STORM at the start of the activation, its melee weapons have the Balanced weapon rule"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', HUNTER)]!;
    mine.pos = { x: 24, y: 11 };
    placeStormAt(state, 'p1', 12, 11);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'wolf-scouts.sp.tempestuous-wrath' }, ctx).state;
    const blade = profileOf(HUNTER, 'Combat blade');
    const has = (): boolean =>
      effectiveRules(ctx, s, blade, { operative: s.operatives[mine.id]!, weaponName: 'Combat blade' }).some(
        (r) => r.id === 'Balanced',
      );
    expect(has()).toBe(false);
    // "…or was within your STORM at the start of the activation"
    s.opState['wolf-scouts.stormAtActivationStart'] = { [mine.id]: true };
    expect(has()).toBe(true);
  });

  it('SAVAGE FIGHTERS: "Whenever a friendly WOLF SCOUT operative finishes retaliating … inflict D3+1 damage"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const enemy = state.operatives[opWith(state, 'p2', HUNTER)]!;
    mine.pos = { x: 11, y: 11 };
    enemy.pos = { x: 12.4, y: 11 };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'wolf-scouts.sp.savage-fighters' }, ctx).state;
    const me = s.operatives[mine.id]!;
    const foe = s.operatives[enemy.id]!;
    fakeFight(s, foe, me, 'Combat blade', 'Combat blade'); // my operative RETALIATES
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(foe, me, 'Combat blade', profileOf(HUNTER, 'Combat blade'), 'melee'),
      crit: false,
      struck: me,
    });
    expect(before - foe.wounds).toBeGreaterThanOrEqual(2);
    expect(before - foe.wounds).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
describe('WOLF SCOUTS firefight ploys', () => {
  it('ACUTE SENSES: "ranged weapons have the Range 6\\" and Seek Light weapon rules and enemy operatives cannot be obscured"', () => {
    const { ctx, state } = setup();
    const shooterId = opWith(state, 'p1', HUNTER);
    const targetId = opWith(state, 'p2', HUNTER);
    state.operatives[shooterId]!.pos = { x: 10, y: 11 };
    state.operatives[targetId]!.pos = { x: 14, y: 11 };
    let s = activate(ctx, state, shooterId);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'wolf-scouts.fp.acute-senses' }, ctx).state;

    const pistol = profileOf(HUNTER, 'Plasma pistol', 'standard');
    const rules = effectiveRules(ctx, s, pistol, {
      operative: s.operatives[shooterId]!,
      target: s.operatives[targetId]!,
      weaponName: 'Plasma pistol',
    });
    expect(rules.filter((r) => r.id === 'Range').map((r) => r.x)).toEqual([6]); // replaces Range 8"
    expect(rules.some((r) => r.id === 'SeekLight')).toBe(true);

    const seq = fakeShoot(s, s.operatives[shooterId]!, s.operatives[targetId]!, 'Plasma pistol', { obscured: true });
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[shooterId]!, s.operatives[targetId]!, 'Plasma pistol', pistol, 'ranged'),
      count: 4,
      mods: zeroMods(),
    });
    expect(seq.obscured).toBe(false);
  });

  it('TOUCHED BY LOKYAR: "if it’s fighting more than 5\\" from other friendly operatives. You can re-roll any of your attack dice"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const enemy = state.operatives[opWith(state, 'p2', HUNTER)]!;
    const mate = state.operatives[opWith(state, 'p1', GUNNER)]!;
    mine.pos = { x: 14, y: 11 };
    enemy.pos = { x: 15.4, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (id !== mine.id) state.operatives[id]!.pos = { x: 2, y: 20 };
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'wolf-scouts.fp.touched-by-lokyar' }, ctx).state;
    const blade = profileOf(HUNTER, 'Combat blade');
    fakeFight(s, s.operatives[mine.id]!, s.operatives[enemy.id]!, 'Combat blade', 'Combat blade');
    const has = (): boolean =>
      effectiveRules(ctx, s, blade, {
        operative: s.operatives[mine.id]!,
        target: s.operatives[enemy.id]!,
        weaponName: 'Combat blade',
      }).some((r) => r.id === 'Relentless');
    expect(has()).toBe(true);
    // A friendly operative closer than 5" switches it off.
    s.operatives[mate.id]!.pos = { x: 16, y: 13 };
    expect(has()).toBe(false);
  });

  it('COUNTERATTACK: a free Fight action, "but you cannot select any other enemy operative to fight against"', () => {
    const { ctx, state } = setup();
    const mineId = opWith(state, 'p1', HUNTER);
    const foeId = opWith(state, 'p2', HUNTER);
    const otherFoeId = opWith(state, 'p2', GUNNER);
    state.operatives[mineId]!.pos = { x: 14, y: 11 };
    state.operatives[foeId]!.pos = { x: 15.4, y: 11 };
    state.operatives[otherFoeId]!.pos = { x: 14, y: 12.4 };
    for (const id of state.teams.p1.operativeIds) if (id !== mineId) state.operatives[id]!.pos = { x: 2, y: 20 };

    state.activeOperativeId = foeId;
    state.activePlayer = 'p2';
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'wolf-scouts.fp.counterattack', data: { operativeId: mineId } }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'wolf-scouts.counterattack' && e.operativeId === mineId)).toBe(true);
    expect(s.operatives[mineId]!.aplMods).toContain(1);

    const me = s.operatives[mineId]!;
    expect(getAction(FIGHT_COUNTERATTACK)!.check(ctx, s, me, { targetId: otherFoeId }).reason).toMatch(
      /any other enemy operative/,
    );
    expect(getAction(FIGHT_COUNTERATTACK)!.check(ctx, s, me, { targetId: foeId }).ok).toBe(true);
  });

  it('TRANSHUMAN PHYSIOLOGY: "You can retain one of your normal successes as a critical success instead"', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const shooter = state.operatives[opWith(state, 'p2', HUNTER)]!;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'wolf-scouts.fp.transhuman-physiology' }, ctx).state;
    const me = s.operatives[target.id]!;
    const foe = s.operatives[shooter.id]!;
    const seq = fakeShoot(s, foe, me, 'Plasma pistol', { step: 'defenceRerolls' });
    seq.defence.dice.push({ id: 1, value: 4, state: 'normal', rolled: true });
    ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(foe, me, 'Plasma pistol', profileOf(HUNTER, 'Plasma pistol', 'standard'), 'ranged'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroMods(),
      rerolls: [],
    });
    expect(seq.defence.dice[0]!.state).toBe('crit');
  });
});

// ---------------------------------------------------------------------------
describe('WOLF SCOUTS faction equipment', () => {
  it('FROST WEAPONS: "wholly within your STORM, its combat blade (if any) has the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup(['wolf-scouts.eq.frost-weapons']);
    const mine = state.operatives[opWith(state, 'p1', HUNTER)]!;
    placeStormAt(state, 'p1', 12, 11);
    const blade = profileOf(HUNTER, 'Combat blade');
    const lethal = (): boolean =>
      effectiveRules(ctx, state, blade, { operative: mine, weaponName: 'Combat blade' }).some(
        (r) => r.id === 'Lethal' && r.x === 5,
      );
    mine.pos = { x: 12, y: 11 };
    expect(lethal()).toBe(true);
    // Within the STORM but not WHOLLY within it (part of the base is beyond 6").
    mine.pos = { x: 18, y: 11 };
    expect(lethal()).toBe(false);
  });

  it('WOLFTEETH NECKLACES: "if you roll two or more fails, you can discard one of them to retain another as a normal success"', () => {
    const { ctx, state } = setup(['wolf-scouts.eq.wolfteeth-necklaces']);
    const shooter = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const target = state.operatives[opWith(state, 'p2', HUNTER)]!;
    const pistol = profileOf(HUNTER, 'Plasma pistol', 'standard');
    const seq = fakeShoot(state, shooter, target, 'Plasma pistol', { step: 'attackRerolls' });
    seq.attack.dice.push(
      { id: 1, value: 2, state: 'fail', rolled: true },
      { id: 2, value: 1, state: 'fail', rolled: true },
      { id: 3, value: 6, state: 'crit', rolled: true },
    );
    const fire = () =>
      ctx.hooks.emit('onRollAttack', state, {
        state,
        ctx: attackCtx(shooter, target, 'Plasma pistol', pistol, 'ranged'),
        dice: [],
        rerolls: [],
      });
    fire();
    expect(seq.attack.dice.map((d) => d.state)).toEqual(['discarded', 'normal', 'crit']);
    // "Once per turning point" — a second pool in the same turning point is untouched.
    const seq2 = fakeShoot(state, shooter, target, 'Plasma pistol', { step: 'attackRerolls' });
    seq2.attack.dice.push(
      { id: 1, value: 2, state: 'fail', rolled: true },
      { id: 2, value: 3, state: 'fail', rolled: true },
    );
    fire();
    expect(seq2.attack.dice.map((d) => d.state)).toEqual(['fail', 'fail']);

    // "…is shooting, FIGHTING OR RETALIATING": fight.ts offers its re-rolls without a hook, so
    // the melee half rides on the weapon-rule lookup it makes after the dice are rolled.
    state.turningPoint = 2;
    const enemy = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const fseq = fakeFight(state, shooter, enemy, 'Combat blade', 'Combat blade');
    fseq.step = 'attackerRerolls';
    fseq.attackerPool.dice.push(
      { id: 1, value: 2, state: 'fail', rolled: true },
      { id: 2, value: 3, state: 'fail', rolled: true },
    );
    effectiveRules(ctx, state, profileOf(HUNTER, 'Combat blade'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Combat blade',
    });
    expect(fseq.attackerPool.dice.map((d) => d.state)).toEqual(['discarded', 'normal']);
  });

  it('RUNIC CHARMS: "worsen the x of the Piercing weapon rule by 1 (if any) … Piercing 1 would therefore be ignored"', () => {
    const { ctx, state } = setup(['wolf-scouts.eq.runic-charms']);
    const target = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const shooter = state.operatives[opWith(state, 'p2', HUNTER)]!;
    target.pos = { x: 12, y: 11 };
    placeStormAt(state, 'p1', 12, 11);
    const pistol = profileOf(HUNTER, 'Plasma pistol', 'standard'); // Piercing 1
    expect(pistol.rules.some((r) => r.id === 'Piercing' && r.x === 1)).toBe(true);
    fakeShoot(state, shooter, target, 'Plasma pistol', { step: 'rollDefence' });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Plasma pistol', pistol, 'ranged'),
      count: 3 - 1, // the engine already subtracted Piercing 1
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(3);
  });

  it('TALISMANIC TROPHIES: "you can subtract 1 from the damage inflicted on it from one normal success"', () => {
    const { ctx, state } = setup(['wolf-scouts.eq.talismanic-trophies']);
    const mine = state.operatives[opWith(state, 'p1', HUNTER)]!;
    const enemy = state.operatives[opWith(state, 'p2', HUNTER)]!;
    mine.pos = { x: 12, y: 11 };
    enemy.pos = { x: 13.4, y: 11 };
    placeStormAt(state, 'p1', 12, 11);
    fakeFight(state, enemy, mine, 'Combat blade', 'Combat blade');
    const dmgN = profileOf(HUNTER, 'Combat blade').dmgN;
    const before = mine.wounds;
    inflictDamage(ctx, state, mine, dmgN, 'attack');
    expect(before - mine.wounds).toBe(dmgN - 1);
    // "…from ONE normal success" — the next one lands in full.
    const mid = mine.wounds;
    inflictDamage(ctx, state, mine, dmgN, 'attack');
    expect(mid - mine.wounds).toBe(dmgN);
  });
});
