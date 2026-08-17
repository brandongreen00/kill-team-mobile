/**
 * DEATHWATCH. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/deathwatch/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { zeroStatMods } from '../../src/core/hooks.ts';
import { reduce } from '../../src/core/reducer.ts';
import { counteractCandidates } from '../../src/core/phases.ts';
import { validateMove } from '../../src/core/movement.ts';
import { newPool } from '../../src/core/dice.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { hitOf, inflictDamage, moveOf } from '../../src/core/state.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { kommandos } from '../../src/teams/kommandos/index.ts';
import {
  AMMO,
  CUFFS_ACTION,
  HEADTAKER_CHARGE,
  OMNI_SCRAMBLER_GAMBIT,
  PHASE_SWEEP,
  PHASE_SWEEP_ACTIONS,
  SIA_SHOOT,
  VETERAN_FIGHT,
  VETERAN_SHOOT,
  VIGILANT_GUARD,
  deathwatch,
} from '../../src/teams/deathwatch/index.ts';
import { activate, act, battle, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap, vantagePlatform } from '../fixtures.ts';

const DATA = teamData('deathwatch');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const SERGEANT = 'deathwatch.watch-sergeant';
const AEGIS = 'deathwatch.aegis-veteran';
const BLADEMASTER = 'deathwatch.blademaster-veteran';
const BOMBARD = 'deathwatch.bombard-veteran';
const BREACHER = 'deathwatch.breacher-veteran';
const DEMOLISHER = 'deathwatch.demolisher-veteran';
const DISRUPTOR = 'deathwatch.disruptor-veteran';
const GUNNER = 'deathwatch.gunner-veteran';
const HEADTAKER = 'deathwatch.headtaker-veteran';
const HORDE_SLAYER = 'deathwatch.horde-slayer-veteran';
const MARKSMAN = 'deathwatch.marksman-veteran';

const EVERY_ROLE = [
  SERGEANT,
  AEGIS,
  BLADEMASTER,
  BOMBARD,
  BREACHER,
  DEMOLISHER,
  DISRUPTOR,
  GUNNER,
  HEADTAKER,
  HORDE_SLAYER,
  MARKSMAN,
];

function setup(
  opts: { equipment?: string[]; script?: number[]; map?: ReturnType<typeof testMap>; foe?: typeof deathwatch } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const foe = opts.foe ?? deathwatch;
  const ctx = teamContext(foe === deathwatch ? [deathwatch] : [deathwatch, foe], {
    seed: 7,
    ...(opts.script ? { script: opts.script } : {}),
  });
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: deathwatch, picks: rosterIncluding(deathwatch, EVERY_ROLE), ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: foe === deathwatch ? { module: deathwatch, picks: rosterIncluding(deathwatch, EVERY_ROLE) } : { module: foe },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

function shootSequence(over: Partial<ShootSequence> & { attackerId: string; targetId: string; weaponName: string }): ShootSequence {
  return {
    kind: 'shoot',
    step: 'resolve',
    queue: [],
    resolvedTargets: [],
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
    attacker: 'p2',
    defender: 'p1',
    free: false,
    ...over,
  };
}

function fightSequence(over: Partial<FightSequence> & { attackerId: string; defenderId: string; attackerWeapon: string }): FightSequence {
  return {
    kind: 'fight',
    step: 'resolve',
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: 'p1',
    defender: 'p2',
    free: false,
    hatchway: false,
    ...over,
  };
}

function attackCtx(attacker: OperativeState, defender: OperativeState, weaponName: string, profile: WeaponProfile, type: 'ranged' | 'melee') {
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
    distance: type === 'melee' ? 0 : 6,
  };
}

// ---------------------------------------------------------------------------
describe('DEATHWATCH data (pinned against data/teams/deathwatch.json)', () => {
  it('has 11 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(11);
    const sergeant = DATA.datacards.find((c) => c.id === SERGEANT)!;
    expect(sergeant).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 15, base: { shape: 'round', mm: 32 } });
    expect(sergeant.keywords).toEqual(['DEATHWATCH', 'IMPERIUM', 'ADEPTUS ASTARTES', 'LEADER', 'WATCH SERGEANT']);
    // The AEGIS is the only 2+ save; the three GRAVIS operatives are 40mm / 18 wounds / Move 5".
    expect(DATA.datacards.find((c) => c.id === AEGIS)).toMatchObject({ save: 2, wounds: 15 });
    for (const id of [BOMBARD, BREACHER, HORDE_SLAYER]) {
      const card = DATA.datacards.find((c) => c.id === id)!;
      expect(card).toMatchObject({ apl: 3, move: 5, save: 3, wounds: 18, base: { shape: 'round', mm: 40 } });
      expect(card.keywords).toContain('GRAVIS');
    }
    // The two Phobos-armoured scouts are Move 7" / 13 wounds.
    for (const id of [DISRUPTOR, HEADTAKER]) {
      expect(DATA.datacards.find((c) => c.id === id)).toMatchObject({ move: 7, wounds: 13 });
    }
  });

  it('pins every weapon profile of the WATCH SERGEANT, BLADEMASTER and HORDE-SLAYER', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) => w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')));
    expect(flat(SERGEANT)).toEqual([
      'Plasma pistol|standard|ranged|4|3|3|5',
      'Plasma pistol|supercharge|ranged|4|3|4|5',
      'Power weapon||melee|5|3|4|6',
    ]);
    expect(flat(BLADEMASTER)).toEqual([
      'Special issue bolt pistol||ranged|4|3|3|4',
      'Xenophase blade|duel|melee|5|3|4|6',
      'Xenophase blade|phase sweep|melee|4|3|4|6',
    ]);
    expect(flat(HORDE_SLAYER)).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Infernus heavy bolter|flame|ranged|5|2|3|3',
      'Infernus heavy bolter|focused bolt|ranged|5|3|4|5',
      'Infernus heavy bolter|sweeping bolt|ranged|4|3|4|5',
      'Fists||melee|4|3|3|4',
    ]);
    // The two rare weapon rules the team uses are printed on the weapons that carry them.
    expect(profileOf(AEGIS, 'Power maul & storm shield').rules.map((r) => r.id)).toContain('Shield');
    expect(profileOf(BLADEMASTER, 'Xenophase blade', 'phase sweep').rules.map((r) => r.id)).toContain('PhaseSweep');
    expect(PHASE_SWEEP).toEqual({ weapon: 'Xenophase blade', profile: 'phase sweep' });
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment options and 2 rare rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Veteran Astartes', 'Special Issue Ammunition']);
    expect(deathwatch.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(deathwatch.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(deathwatch.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual(['PhaseSweep', 'Shield']);
    // aiHints are a real deliverable: without ployValue the AI never uses a firefight ploy.
    expect(Object.keys(deathwatch.aiHints!.roles!)).toHaveLength(11);
    expect(Object.keys(deathwatch.aiHints!.ployValue!)).toHaveLength(8);
    expect(Object.keys(deathwatch.aiHints!.equipmentValue!)).toHaveLength(4);
  });

  it('selection: "5 DEATHWATCH operatives selected from the following list" with the leader IN the list', () => {
    expect(DATA.selection.leader.inList).toBe(true);
    expect(DATA.selection.slots).toBe(5);
    expect(DATA.selection.rawText).toContain('can only include each operative on this list once');
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(5);
    expect(picks[0]!.datacardId).toBe(SERGEANT);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    // KNOWN DATA GAP, reported to the orchestrator: "can only include up to one GRAVIS
    // operative" is scraped as `{kind:'maxCount', role:'GRAVIS'}`, but GRAVIS is a KEYWORD,
    // not a selection role, so the shared validator's role match never fires and the printed
    // default roster contains two GRAVIS operatives.
    expect(DATA.selection.constraints).toContainEqual({ kind: 'maxCount', role: 'GRAVIS', max: 1 });
    const gravis = picks.filter((p) => (DATA.datacards.find((c) => c.id === p.datacardId)?.keywords ?? []).includes('GRAVIS'));
    expect(gravis).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('Veteran Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('the second Shoot is its own action and only follows a first Shoot', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    const s = activate(ctx, state, id);
    const early = act(ctx, s, id, VETERAN_SHOOT, { weaponName: 'Stalker bolt rifle', profileName: 'mobile', targetId: enemy });
    expect(early.ok).toBe(false);
    expect(early.reason).toMatch(/second Shoot action/);
    expect(rule('deathwatch.rule.veteran-astartes')).toContain('two Shoot actions or two Fight actions');
  });

  it('"1 additional AP must be spent for the second action" when a stalker bolt rifle is selected for both', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    state.operatives[id]!.pos = { x: 12, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, id);
    s = settle(ctx, act(ctx, s, id, 'Shoot', { weaponName: 'Stalker bolt rifle', profileName: 'mobile', targetId: enemy }).state);
    expect(s.operatives[id]!.apSpent).toBe(1);
    const second = act(ctx, s, id, VETERAN_SHOOT, { weaponName: 'Stalker bolt rifle', profileName: 'mobile', targetId: enemy });
    expect(second.ok).toBe(true);
    s = settle(ctx, second.state);
    expect(s.operatives[id]!.apSpent).toBe(3); // 1 + (1 + 1 additional)
    expect(rule('deathwatch.rule.veteran-astartes')).toContain('1 additional AP must be spent for the second action');
  });

  it('two Fight actions are allowed, but never a Fight and a Shoot', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', DEMOLISHER);
    const enemy = opWith(state, 'p2', BOMBARD);
    state.operatives[id]!.pos = { x: 15, y: 11 };
    state.operatives[enemy]!.pos = { x: 16.5, y: 11 };
    state.operatives[id]!.wounds = 60;
    state.operatives[enemy]!.wounds = 60;
    let s = activate(ctx, state, id);
    s = settle(ctx, act(ctx, s, id, 'Fight', { meleeWeaponName: 'Heavy thunder hammer', targetId: enemy }).state);
    const mixed = act(ctx, s, id, VETERAN_SHOOT, { weaponName: 'Bolt pistol', targetId: enemy });
    expect(mixed.reason).toMatch(/either two Shoot actions or two Fight actions/);
    const again = act(ctx, s, id, VETERAN_FIGHT, { meleeWeaponName: 'Heavy thunder hammer', targetId: enemy });
    expect(again.ok).toBe(true);
  });

  it('"Each friendly DEATHWATCH operative can counteract regardless of its order"', () => {
    const { ctx, state } = setup({ foe: kommandos as unknown as typeof deathwatch });
    expect(rule('deathwatch.rule.veteran-astartes')).toContain(
      'Each friendly DEATHWATCH operative can counteract regardless of its order',
    );
    const engage = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const conceal = state.operatives[opWith(state, 'p1', DISRUPTOR)]!;
    const already = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const guardLocked = state.operatives[opWith(state, 'p1', BREACHER)]!;
    for (const o of [engage, conceal, already, guardLocked]) {
      o.expended = true;
      o.ready = false;
      o.counteractedThisTP = false;
    }
    conceal.order = 'conceal';
    already.order = 'conceal';
    guardLocked.order = 'conceal';
    // Core conditions the clause does NOT lift: "can counteract ONCE during the turning point",
    // and On Guard's "that friendly operative cannot counteract during the turning point".
    already.counteractedThisTP = true;
    guardLocked.guardSpentTP = state.turningPoint;

    const ids = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(conceal.id); // "regardless of its order" — a Conceal order is no bar
    expect(ids).toContain(engage.id); // and an Engage one counteracts as it always did
    expect(ids).not.toContain(already.id);
    expect(ids).not.toContain(guardLocked.id);

    // The clause names friendly DEATHWATCH operatives only. The KOMMANDOS opposite print no
    // such rule, so an expended Conceal ork keeps the core's printed Engage-order default.
    const ork = state.operatives[opWith(state, 'p2', 'kommandos.boss-nob')]!;
    ork.expended = true;
    ork.ready = false;
    ork.counteractedThisTP = false;
    ork.order = 'conceal';
    expect(counteractCandidates(ctx, state, 'p2').map((o) => o.id)).not.toContain(ork.id);
    ork.order = 'engage';
    expect(counteractCandidates(ctx, state, 'p2').map((o) => o.id)).toContain(ork.id);
  });
});

// ---------------------------------------------------------------------------
describe('Special Issue Ammunition — "select one of the following weapon rules for that operative’s ranged weapons"', () => {
  it('offers exactly the six printed ammunition types, parsed out of the rule text', () => {
    expect(AMMO.map((a) => a.id)).toEqual(['blast', 'devastating', 'lethal', 'piercing-crits', 'saturate', 'severe']);
    expect(AMMO.map((a) => a.label)).toEqual(['Blast 1"', 'Devastating 1', 'Lethal 5+', 'Piercing Crits 1', 'Saturate', 'Severe']);
    expect(AMMO.map((a) => a.rule.id)).toEqual(['Blast', 'Devastating', 'Lethal', 'PiercingCrits', 'Saturate', 'Severe']);
    for (const option of AMMO) expect(rule('deathwatch.rule.special-issue-ammunition')).toContain(option.label);
  });

  it('grants the chosen rule to that operative’s ranged weapons "until the end of the action"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    state.operatives[id]!.pos = { x: 12, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, id);
    const out = act(ctx, s, id, SIA_SHOOT, {
      weaponName: 'Stalker bolt rifle',
      profileName: 'mobile',
      targetId: enemy,
      choice: 'severe',
    });
    expect(out.ok).toBe(true);
    s = settle(ctx, out.state);
    const eff = s.effects.find((e) => e.rule === 'deathwatch.specialIssueAmmo' && e.operativeId === id);
    expect(eff?.data?.['ammo']).toBe('severe');

    const profile = profileOf(MARKSMAN, 'Stalker bolt rifle', 'mobile');
    const use = { operative: s.operatives[id]!, target: s.operatives[enemy]!, weaponName: 'Stalker bolt rifle' };
    // Live only while THIS operative's shoot sequence is in flight — never a later action.
    s.sequence = shootSequence({ attackerId: id, targetId: enemy, weaponName: 'Stalker bolt rifle', attacker: 'p1', defender: 'p2' });
    expect(effectiveRules(ctx, s, profile, use).some((r) => r.id === 'Severe')).toBe(true);
    s.sequence = null;
    expect(effectiveRules(ctx, s, profile, use).some((r) => r.id === 'Severe')).toBe(false);
  });

  it('is "Once per turning point", and cannot be used with a melta bomb or Blast with a Torrent profile', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    state.operatives[id]!.pos = { x: 12, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, id);
    s = settle(
      ctx,
      act(ctx, s, id, SIA_SHOOT, { weaponName: 'Stalker bolt rifle', profileName: 'mobile', targetId: enemy, choice: 'severe' }).state,
    );
    const again = getAction(SIA_SHOOT)!.check(ctx, s, s.operatives[id]!, {
      weaponName: 'Stalker bolt rifle',
      profileName: 'mobile',
      targetId: enemy,
      choice: 'lethal',
    });
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/once per turning point/);

    // "This rule cannot be used with explosive grenades … or melta bombs."
    const breacher = s.operatives[opWith(s, 'p1', BREACHER)]!;
    breacher.pos = { x: 17.2, y: 11 };
    const melta = getAction(SIA_SHOOT)!.check(ctx, s, breacher, { weaponName: 'Melta bomb', targetId: enemy, choice: 'severe' });
    expect(melta.reason).toMatch(/explosive grenades or melta bombs/);
    // "Blast 1\" (you cannot select this if the weapon profile being used has the Torrent weapon rule)"
    const torrent = getAction(SIA_SHOOT)!.check(ctx, s, breacher, {
      weaponName: 'Hellstorm bolt rifle',
      targetId: enemy,
      choice: 'blast',
    });
    expect(torrent.reason).toMatch(/Torrent weapon rule/);
  });

  it('AMMUNITION RESERVE: "for up to two Shoot actions during one turning point … different weapon rules for both"', () => {
    const { ctx, state } = setup({ equipment: ['deathwatch.eq.ammunition-reserve'] });
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    state.operatives[id]!.pos = { x: 12, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, id);
    s = settle(
      ctx,
      act(ctx, s, id, SIA_SHOOT, { weaponName: 'Stalker bolt rifle', profileName: 'mobile', targetId: enemy, choice: 'severe' }).state,
    );
    const params = { weaponName: 'Stalker bolt rifle', profileName: 'mobile', targetId: enemy };
    expect(getAction(SIA_SHOOT)!.check(ctx, s, s.operatives[id]!, { ...params, choice: 'severe' }).reason).toMatch(
      /different weapon rules/,
    );
    expect(getAction(SIA_SHOOT)!.check(ctx, s, s.operatives[id]!, { ...params, choice: 'lethal' }).ok).toBe(true);
    expect(rule('deathwatch.eq.ammunition-reserve')).toContain('you must select different weapon rules for both uses');
  });
});

// ---------------------------------------------------------------------------
describe('DEATHWATCH datacard abilities', () => {
  it('WATCH SERGEANT › Strategic Command: one strategy and one firefight ploy for 0CP, once each per battle', () => {
    const { ctx, state } = setup();
    expect(ability(SERGEANT, 'deathwatch.watch-sergeant.strategic-command')).toContain('Use a DEATHWATCH strategy ploy for 0CP');
    const before = state.teams.p1.cp;
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'deathwatch.sp.the-long-vigil' }, ctx).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP spent, 1CP refunded
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.transhuman-physiology' }, ctx).state;
    expect(s.teams.p1.cp).toBe(before);
    // "once per battle" for each kind: a second strategy ploy is paid for.
    s.teams.p1.gambitsUsedTP = [];
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: 'deathwatch.sp.mission-tactics' }, ctx).state;
    expect(s.teams.p1.cp).toBe(before - 1);
  });

  it('AEGIS › Shield: "each of your blocks can be allocated to block two unresolved successes"', () => {
    const { ctx, state } = setup();
    const aegis = state.operatives[opWith(state, 'p1', AEGIS)]!;
    const foe = state.operatives[opWith(state, 'p2', MARKSMAN)]!;
    const maul = profileOf(AEGIS, 'Power maul & storm shield');
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: attackCtx(aegis, foe, 'Power maul & storm shield', maul, 'melee'),
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev.blocks).toBe(2);
    expect(ability(AEGIS, 'deathwatch.aegis-veteran.shield')).toContain('block two unresolved successes');
  });

  it('AEGIS › Storm Shield: "worsen the x of the Piercing weapon rule by 1 … Piercing 1 would therefore be ignored"', () => {
    const { ctx, state } = setup();
    const aegis = state.operatives[opWith(state, 'p1', AEGIS)]!;
    const shooter = state.operatives[opWith(state, 'p2', BLADEMASTER)]!;
    const pistol = profileOf(BLADEMASTER, 'Special issue bolt pistol'); // Piercing 1
    expect(
      effectiveRules(ctx, state, pistol, { operative: shooter, target: aegis, weaponName: 'Special issue bolt pistol' }).some(
        (r) => r.id === 'Piercing',
      ),
    ).toBe(false);
    const melta = profileOf(BREACHER, 'Melta bomb'); // Piercing 2 -> Piercing 1
    const worsened = effectiveRules(ctx, state, melta, { operative: shooter, target: aegis, weaponName: 'Melta bomb' }).find(
      (r) => r.id === 'Piercing',
    );
    expect(worsened?.x).toBe(1);
    // Someone else is unaffected.
    const other = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    expect(
      effectiveRules(ctx, state, pistol, { operative: shooter, target: other, weaponName: 'Special issue bolt pistol' }).some(
        (r) => r.id === 'Piercing',
      ),
    ).toBe(true);
  });

  it('BLADEMASTER › Adaptive Swordsmanship: "ignore any changes to the Hit stat of this operative’s xenophase blade"', () => {
    const { ctx, state } = setup();
    const bm = state.operatives[opWith(state, 'p1', BLADEMASTER)]!;
    const foe = state.operatives[opWith(state, 'p2', MARKSMAN)]!;
    const blade = profileOf(BLADEMASTER, 'Xenophase blade', 'duel');
    const pistol = profileOf(BLADEMASTER, 'Special issue bolt pistol');
    bm.wounds = 5; // injured: "worsen the Hit stat of their weapons by 1"
    expect(hitOf(ctx, state, bm, pistol)).toBe(4);
    state.sequence = fightSequence({ attackerId: bm.id, defenderId: foe.id, attackerWeapon: 'Xenophase blade', attackerProfile: 'duel' });
    expect(hitOf(ctx, state, bm, blade)).toBe(3);
  });

  it('BLADEMASTER › Adaptive Swordsmanship: the retaliating BLADEMASTER "resolves one of your successes before the normal order"', () => {
    const { ctx, state } = setup();
    const bm = state.operatives[opWith(state, 'p1', BLADEMASTER)]!;
    const foe = state.operatives[opWith(state, 'p2', DEMOLISHER)]!;
    const seq = fightSequence({
      attackerId: foe.id,
      defenderId: bm.id,
      attackerWeapon: 'Heavy thunder hammer',
      defenderWeapon: 'Xenophase blade',
      defenderProfile: 'duel',
      attacker: 'p2',
      defender: 'p1',
    });
    state.sequence = seq;
    const blade = profileOf(BLADEMASTER, 'Xenophase blade', 'duel');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(bm, foe, 'Xenophase blade', blade, 'melee'),
      count: blade.atk,
      mods: zeroStatMods(),
    });
    expect(seq.turn).toBe('defender');
    // "If you do, that success must be used to block" is NOT enforceable — the engine builds
    // the strike/block options itself. Reported as reminder-only.
    expect(ability(BLADEMASTER, 'deathwatch.blademaster-veteran.adaptive-swordsmanship')).toContain(
      'that success must be used to block',
    );
  });

  it('BLADEMASTER › Phase Sweep: free Fight actions chain until every engaged enemy has been fought once', () => {
    const { ctx, state } = setup();
    const bm = state.operatives[opWith(state, 'p1', BLADEMASTER)]!;
    const a = state.operatives[opWith(state, 'p2', BOMBARD)]!;
    const b = state.operatives[opWith(state, 'p2', BREACHER)]!;
    bm.pos = { x: 15, y: 11 };
    a.pos = { x: 16.6, y: 11 };
    b.pos = { x: 15, y: 12.6 };
    // The chain, not the damage, is what this test pins.
    for (const o of [bm, a, b]) o.wounds = 90;
    let s = activate(ctx, state, bm.id);
    s = settle(
      ctx,
      act(ctx, s, bm.id, 'Fight', { meleeWeaponName: PHASE_SWEEP.weapon, meleeProfileName: PHASE_SWEEP.profile, targetId: a.id }).state,
    );
    const sweep = act(ctx, s, bm.id, PHASE_SWEEP_ACTIONS[0]!, {});
    expect(sweep.ok).toBe(true);
    s = settle(ctx, sweep.state);
    expect(s.operatives[bm.id]!.apSpent).toBe(1); // "a free Fight action"
    const exhausted = act(ctx, s, bm.id, PHASE_SWEEP_ACTIONS[1]!, {});
    expect(exhausted.ok).toBe(false);
    expect(exhausted.reason).toMatch(/every enemy operative within its control range/);
    expect(ability(BLADEMASTER, 'deathwatch.blademaster-veteran.phase-sweep')).toContain(
      'once per activation or counteraction using this weapon profile',
    );
  });

  it('DEMOLISHER › Brutal Assault: Brutal while fighting (not retaliating), Ceaseless after a Charge', () => {
    const { ctx, state } = setup();
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHER)]!;
    const foe = state.operatives[opWith(state, 'p2', MARKSMAN)]!;
    const hammer = profileOf(DEMOLISHER, 'Heavy thunder hammer');
    const use = { operative: demo, target: foe, weaponName: 'Heavy thunder hammer' };
    expect(effectiveRules(ctx, state, hammer, use).some((r) => r.id === 'Brutal')).toBe(true);
    expect(effectiveRules(ctx, state, hammer, { ...use, retaliating: true }).some((r) => r.id === 'Brutal')).toBe(false);
    expect(effectiveRules(ctx, state, hammer, use).some((r) => r.id === 'Ceaseless')).toBe(false);
    demo.actionsThisActivation = ['Charge'];
    expect(effectiveRules(ctx, state, hammer, use).some((r) => r.id === 'Ceaseless')).toBe(true);
  });

  it('DEMOLISHER › Aggressive Force: "Normal and Critical Dmg of 3 or more inflicts 1 less damage on it"', () => {
    const { ctx, state } = setup();
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHER)]!;
    const foe = state.operatives[opWith(state, 'p2', BOMBARD)]!;
    state.sequence = fightSequence({
      attackerId: foe.id,
      defenderId: demo.id,
      attackerWeapon: 'Fists',
      attacker: 'p2',
      defender: 'p1',
    });
    const before = demo.wounds;
    inflictDamage(ctx, state, demo, 4, 'attack');
    expect(before - demo.wounds).toBe(3);
    // "…of 3 or more" — a 2-damage dice is untouched.
    const mid = demo.wounds;
    inflictDamage(ctx, state, demo, 2, 'attack');
    expect(mid - demo.wounds).toBe(2);
    expect(ability(DEMOLISHER, 'deathwatch.demolisher-veteran.aggressive-force')).toContain(
      'isn’t cumulative with the Shield that Slays strategy ploy',
    );
  });

  it('DISRUPTOR › Advanced Omni-Scrambler: a STRATEGIC GAMBIT that locks one enemy until D6 enemies have activated', () => {
    const { ctx, state } = setup({ script: [3] });
    const disruptor = state.operatives[opWith(state, 'p1', DISRUPTOR)]!;
    const victim = state.operatives[opWith(state, 'p2', MARKSMAN)]!;
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(options.map((o) => o.id)).toContain(OMNI_SCRAMBLER_GAMBIT);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: OMNI_SCRAMBLER_GAMBIT, data: { operativeId: victim.id } }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'deathwatch.scrambled' && e.operativeId === victim.id)).toBe(true);
    const blocked = ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[victim.id]!, action: 'Shoot', allowed: true });
    expect(blocked.allowed).toBe(false);
    // "Your opponent has activated a number of enemy operatives equal to the result of the D6."
    let n = 0;
    for (const eid of s.teams.p2.operativeIds) {
      if (eid === victim.id || n >= 3) continue;
      s.operatives[eid]!.expended = true;
      n++;
    }
    const freed = ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[victim.id]!, action: 'Shoot', allowed: true });
    expect(freed.allowed).toBe(true);
    expect(disruptor.datacardId).toBe(DISRUPTOR);
  });

  it('DISRUPTOR › Auspex Triangulation: "The Advanced Auspex Scan firefight ploy costs you 0CP"', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    let s = activate(ctx, state, shooter);
    // Spend the WATCH SERGEANT's once-per-battle firefight discount first, so the CP delta
    // below is Auspex Triangulation's alone.
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.transhuman-physiology' }, ctx).state;
    const before = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.advanced-auspex-scan', data: { targetId: enemy } }, ctx).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP spent, 1CP refunded

    // "This operative isn't within control range of enemy operatives."
    expect(ability(DISRUPTOR, 'deathwatch.disruptor-veteran.auspex-triangulation')).toContain(
      'isn’t within control range of enemy operatives',
    );
    s.teams.p1.ploysUsedTP = [];
    s.operatives[opWith(s, 'p1', DISRUPTOR)]!.pos = { ...s.operatives[enemy]!.pos };
    const engagedCp = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.advanced-auspex-scan', data: { targetId: enemy } }, ctx).state;
    expect(s.teams.p1.cp).toBe(engagedCp - 1);
  });

  it('HEADTAKER › Clandestine Headtaker: "can perform the Charge action while it has a Conceal order"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', HEADTAKER);
    const enemy = opWith(state, 'p2', MARKSMAN);
    state.operatives[id]!.pos = { x: 14, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    const s = activate(ctx, state, id, 'conceal');
    const path = { points: [{ x: 16.3, y: 11 }] };
    expect(act(ctx, s, id, 'Charge', { path }).reason).toMatch(/Conceal order/);
    const out = act(ctx, s, id, HEADTAKER_CHARGE, { path });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[id]!.pos.x).toBeCloseTo(16.3);
  });

  it('HEADTAKER › Clandestine Headtaker: an unseen victim eats a second strike "before your opponent"', () => {
    const map = testMap({ features: [heavyBlock('divider', 14, 0, 2, 22)] });
    const { ctx, state } = setup({ map });
    const id = opWith(state, 'p1', HEADTAKER);
    const enemy = opWith(state, 'p2', MARKSMAN);
    state.operatives[id]!.pos = { x: 10, y: 11 };
    state.operatives[enemy]!.pos = { x: 20, y: 11 };
    const s = activate(ctx, state, id); // the wall hides it from every enemy right now
    expect(s.effects.some((e) => e.rule === 'deathwatch.unseenBy' && e.operativeId === id)).toBe(true);
    const ht = s.operatives[id]!;
    const victim = s.operatives[enemy]!;
    ht.pos = { x: 18.6, y: 11 };
    const knives = profileOf(HEADTAKER, 'Combat knives');
    const seq = fightSequence({ attackerId: id, defenderId: enemy, attackerWeapon: 'Combat knives' });
    seq.attackerPool.dice = [
      { id: 1, value: 6, state: 'struck', rolled: true },
      { id: 2, value: 4, state: 'normal', rolled: true },
    ];
    seq.attackerPool.nextId = 3;
    s.sequence = seq;
    const before = victim.wounds;
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(ht, victim, 'Combat knives', knives, 'melee'),
      crit: true,
      struck: victim,
    });
    expect(before - victim.wounds).toBe(knives.dmgN);
    expect(seq.attackerPool.dice[1]!.state).toBe('struck');
  });

  it('HEADTAKER › Grav-chute and Grapnel Launcher is REMINDER-ONLY: the engine has no per-leg movement seam', () => {
    expect(ability(HEADTAKER, 'deathwatch.headtaker-veteran.grav-chute-and-grapnel-launcher')).toContain(
      'treat the vertical distance as 2"',
    );
    const map = testMap({ features: [vantagePlatform('tower', 16, 8, 6, 6, 3)] });
    const { ctx, state } = setup({ map });
    const id = opWith(state, 'p1', HEADTAKER);
    const op = state.operatives[id]!;
    op.pos = { x: 16.2, y: 11 };
    const v = validateMove(ctx, state, op, { points: [{ x: 17, y: 11 }], zs: [3] }, { action: 'Reposition' });
    expect(v.ok).toBe(true);
    // A 3" climb is still charged 3" — `onMoveRules` is declared but never emitted, so the
    // "treat the vertical distance as 2\"" grant cannot be expressed. Reported as a seam.
    expect(v.legs.find((l) => l.kind === 'climb')?.charged).toBe(3);
  });

  it('MARKSMAN › Vigilant Marksman: "can perform the Guard action … regardless of the killzone"', () => {
    const { ctx, state } = setup();
    expect(state.map.closeQuarters).toBe(false);
    const op = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const actions = availableActions(ctx, state, op);
    expect(actions.some((a) => a.def.id === 'Guard')).toBe(false); // the universal one is close-quarters only
    expect(actions.some((a) => a.def.id === VIGILANT_GUARD && a.ok)).toBe(true);
    const out = act(ctx, activate(ctx, state, op.id), op.id, VIGILANT_GUARD, {});
    expect(out.ok).toBe(true);
    // The reducer clears `onGuard` after any action whose id is not literally 'Guard', so the
    // module restores it at the end of the activation (see the module's engine-gap note).
    const ended = reduce(out.state, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(ended.operatives[op.id]!.onGuard).toBe(true);
  });

  it('MARKSMAN › Vigilant Marksman: a free Guard after a free Shoot on guard, once per turning point', () => {
    const { ctx, state } = setup({ map: testMap({ closeQuarters: true }) });
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    const op = state.operatives[id]!;
    const foe = state.operatives[enemy]!;
    const rifle = profileOf(MARKSMAN, 'Stalker bolt rifle', 'mobile');
    state.sequence = shootSequence({
      attackerId: id,
      targetId: enemy,
      weaponName: 'Stalker bolt rifle',
      profileName: 'mobile',
      free: true,
      attacker: 'p1',
      defender: 'p2',
    });
    op.onGuard = false;
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: attackCtx(op, foe, 'Stalker bolt rifle', rifle, 'ranged'), crit: false, struck: foe });
    expect(op.onGuard).toBe(true);
    op.onGuard = false;
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: attackCtx(op, foe, 'Stalker bolt rifle', rifle, 'ranged'), crit: false, struck: foe });
    expect(op.onGuard).toBe(false); // "once per turning point"
    expect(ability(MARKSMAN, 'deathwatch.marksman-veteran.vigilant-marksman')).toContain('it cannot counteract during that turning point');
  });

  it('WATCH SERGEANT › Adaptable Armoury is REMINDER-ONLY: the reducer caps equipment at four', () => {
    const { ctx, state } = setup();
    expect(ability(SERGEANT, 'deathwatch.watch-sergeant.adaptable-armoury')).toContain('one additional equipment option');
    const out = reduce(
      state,
      {
        t: 'SelectEquipment',
        player: 'p1',
        equipment: [
          'deathwatch.eq.digital-weapons',
          'deathwatch.eq.sanctus-v-bioscryer-cuffs',
          'deathwatch.eq.scrutavore-servo-thrall',
          'deathwatch.eq.ammunition-reserve',
          'eq.utilityGrenades',
        ],
      },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/four equipment options/);
  });
});

// ---------------------------------------------------------------------------
describe('DEATHWATCH ploys', () => {
  it('MISSION TACTICS: "Select Conceal or Engage" — Balanced against an enemy with that order', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const target = state.operatives[opWith(state, 'p2', MARKSMAN)]!;
    const rifle = profileOf(MARKSMAN, 'Stalker bolt rifle', 'mobile');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'deathwatch.sp.mission-tactics', data: { order: 'engage' } }, ctx).state;
    const use = { operative: s.operatives[shooter.id]!, target: s.operatives[target.id]!, weaponName: 'Stalker bolt rifle' };
    expect(effectiveRules(ctx, s, rifle, use).some((r) => r.id === 'Balanced')).toBe(true);
    s.operatives[target.id]!.order = 'conceal';
    expect(effectiveRules(ctx, s, rifle, use).some((r) => r.id === 'Balanced')).toBe(false);
  });

  it('THE SHIELD THAT SLAYS: "wholly within your opponent’s territory, Normal Dmg of 4 or more inflicts 1 less damage"', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'deathwatch.sp.the-shield-that-slays' }, ctx).state;
    const v = s.operatives[victim.id]!;
    v.pos = { x: 20, y: 11 }; // wholly within p2's territory (x >= 15)
    const seq = shootSequence({
      attackerId: shooter.id,
      targetId: v.id,
      weaponName: 'Heavy plasma incinerator',
      profileName: 'standard', // Normal Dmg 4
    });
    seq.attack.dice = [{ id: 1, value: 5, state: 'normal', rolled: true }];
    s.sequence = seq;
    const before = v.wounds;
    inflictDamage(ctx, s, v, 4, 'attack');
    expect(before - v.wounds).toBe(3);
    // Back in its own half the ploy does nothing.
    v.pos = { x: 5, y: 11 };
    const mid = v.wounds;
    inflictDamage(ctx, s, v, 4, 'attack');
    expect(mid - v.wounds).toBe(4);
  });

  it('THE LONG VIGIL: "wholly within your territory, you can re-roll one of your defence dice"', () => {
    const { ctx, state } = setup();
    const defender = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const plasma = profileOf(GUNNER, 'Heavy plasma incinerator', 'standard');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'deathwatch.sp.the-long-vigil' }, ctx).state;
    const d = s.operatives[defender.id]!;
    const grants = (): string[] =>
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(shooter, d, 'Heavy plasma incinerator', plasma, 'ranged'),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls.map((r) => r.id);
    d.pos = { x: 5, y: 11 };
    expect(grants()).toContain('deathwatch.theLongVigil');
    d.pos = { x: 20, y: 11 };
    expect(grants()).not.toContain('deathwatch.theLongVigil');
  });

  it('AND THEY SHALL KNOW NO FEAR: "ignore any changes to the stats … from being injured"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', SERGEANT)]!;
    const power = profileOf(SERGEANT, 'Power weapon');
    op.wounds = 5; // fewer than half of 15 — injured
    expect(moveOf(ctx, state, op)).toBe(4);
    expect(hitOf(ctx, state, op, power)).toBe(4);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'deathwatch.sp.and-they-shall-know-no-fear' }, ctx).state;
    expect(moveOf(ctx, s, s.operatives[op.id]!)).toBe(6);
    expect(hitOf(ctx, s, s.operatives[op.id]!, power)).toBe(3);
  });

  it('SUFFER NOT THE ALIEN: re-roll any attack dice, but only against a non-CHAOS, non-IMPERIUM operative', () => {
    const { ctx, state } = setup({ foe: kommandos as unknown as typeof deathwatch });
    const shooter = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const ork = state.operatives[opWith(state, 'p2', 'kommandos.boss-nob')]!;
    const friend = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const rifle = profileOf(MARKSMAN, 'Stalker bolt rifle', 'mobile');
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.suffer-not-the-alien' }, ctx).state;
    const grants = (target: OperativeState): string[] =>
      ctx.hooks.emit('onRollAttack', s, {
        state: s,
        ctx: attackCtx(s.operatives[shooter.id]!, target, 'Stalker bolt rifle', rifle, 'ranged'),
        dice: [],
        rerolls: [],
      }).rerolls.map((r) => r.id);
    expect(grants(s.operatives[ork.id]!)).toContain('deathwatch.sufferNotTheAlien');
    expect(grants(s.operatives[friend.id]!)).not.toContain('deathwatch.sufferNotTheAlien'); // IMPERIUM
    expect(rule('deathwatch.fp.suffer-not-the-alien')).toContain('doesn’t have the CHAOS or IMPERIUM keyword');
  });

  it('ADVANCED AUSPEX SCAN: "its ranged weapons have the Saturate weapon rule and enemy operatives cannot be obscured"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', MARKSMAN);
    const enemy = opWith(state, 'p2', MARKSMAN);
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.advanced-auspex-scan', data: { operativeId: id } }, ctx).state;
    const rifle = profileOf(MARKSMAN, 'Stalker bolt rifle', 'mobile');
    const use = { operative: s.operatives[id]!, target: s.operatives[enemy]!, weaponName: 'Stalker bolt rifle' };
    expect(effectiveRules(ctx, s, rifle, use).some((r) => r.id === 'Saturate')).toBe(true);
    const seq = shootSequence({ attackerId: id, targetId: enemy, weaponName: 'Stalker bolt rifle', attacker: 'p1', defender: 'p2' });
    seq.obscured = true;
    s.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[id]!, s.operatives[enemy]!, 'Stalker bolt rifle', rifle, 'ranged'),
      count: rifle.atk,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(false);
  });

  it('AUSPICATOR TRACKING: "when a friendly DEATHWATCH operative is counteracting … you can change its order"', () => {
    const { ctx, state } = setup();
    const ploy = deathwatch.ploys.find((p) => p.id === 'deathwatch.fp.auspicator-tracking')!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false); // nobody is counteracting
    const id = opWith(state, 'p1', MARKSMAN);
    state.operatives[id]!.order = 'conceal';
    state.opState['counteract'] = { operativeId: id, actionsUsed: 0 };
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: ploy.id }, ctx).state;
    expect(s.operatives[id]!.order).toBe('engage');
  });

  it('TRANSHUMAN PHYSIOLOGY: "retain one of your normal successes as a critical success instead"', () => {
    const { ctx, state } = setup();
    const defender = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const plasma = profileOf(GUNNER, 'Heavy plasma incinerator', 'standard');
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'deathwatch.fp.transhuman-physiology' }, ctx).state;
    const seq = shootSequence({ attackerId: shooter.id, targetId: defender.id, weaponName: 'Heavy plasma incinerator', profileName: 'standard' });
    seq.defence.dice = [
      { id: 1, value: 4, state: 'normal', rolled: true },
      { id: 2, value: 2, state: 'fail', rolled: true },
    ];
    s.sequence = seq;
    ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(shooter, s.operatives[defender.id]!, 'Heavy plasma incinerator', plasma, 'ranged'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice[0]!.state).toBe('crit');
  });
});

// ---------------------------------------------------------------------------
describe('DEATHWATCH faction equipment', () => {
  it('DIGITAL WEAPONS: "inflict 1 damage on the enemy operative in that sequence", once per turning point', () => {
    const { ctx, state } = setup({ equipment: ['deathwatch.eq.digital-weapons'] });
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHER)]!;
    const foe = state.operatives[opWith(state, 'p2', BOMBARD)]!;
    const hammer = profileOf(DEMOLISHER, 'Heavy thunder hammer');
    state.sequence = fightSequence({ attackerId: demo.id, defenderId: foe.id, attackerWeapon: 'Heavy thunder hammer' });
    const before = foe.wounds;
    const fire = (): void => {
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(demo, foe, 'Heavy thunder hammer', hammer, 'melee'),
        count: hammer.atk,
        mods: zeroStatMods(),
      });
    };
    fire();
    expect(before - foe.wounds).toBe(1);
    fire();
    expect(before - foe.wounds).toBe(1); // "Once per turning point"
    expect(rule('deathwatch.eq.digital-weapons')).toContain('at the start of the Roll Attack Dice step');
  });

  it('SANCTUS-V BIOSCRYER CUFFS: "regains up to D3 lost wounds" / removes APL changes / purges a token', () => {
    const { ctx, state } = setup({ equipment: ['deathwatch.eq.sanctus-v-bioscryer-cuffs'], script: [4] });
    const id = opWith(state, 'p1', MARKSMAN);
    state.operatives[id]!.wounds = 5;
    let s = activate(ctx, state, id);
    const healed = act(ctx, s, id, CUFFS_ACTION, { choice: 'wounds' });
    expect(healed.ok).toBe(true);
    expect(healed.state.operatives[id]!.wounds).toBe(7); // D6 of 4 -> D3 of 2

    // "Remove any changes to that friendly operative's APL stat."
    const other = opWith(state, 'p1', GUNNER);
    state.operatives[other]!.aplMods = [-1];
    s = activate(ctx, state, other);
    const cleared = act(ctx, s, other, CUFFS_ACTION, { choice: 'apl' });
    expect(cleared.state.operatives[other]!.aplMods).toEqual([]);
    // Nothing to purge -> the action is refused in `check`, never in `perform` (D-026).
    const idle = opWith(state, 'p1', SERGEANT);
    const s2 = activate(ctx, state, idle);
    expect(act(ctx, s2, idle, CUFFS_ACTION, {}).reason).toMatch(/nothing for the cuffs to purge/);
  });

  it('SCRUTAVORE SERVO-THRALL: "that operative can perform a mission action for 1 less AP", once per turning point', () => {
    const { ctx, state } = setup({ equipment: ['deathwatch.eq.scrutavore-servo-thrall'] });
    const op = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const cost = (): number =>
      ctx.hooks.emit('onActionCost', state, { state, operative: op, action: 'Operate Hatch', ap: 1 }).ap;
    expect(cost()).toBe(0);
    // A non-mission action is untouched.
    expect(ctx.hooks.emit('onActionCost', state, { state, operative: op, action: 'Shoot', ap: 1 }).ap).toBe(1);
    op.actionsThisActivation = ['Operate Hatch'];
    ctx.hooks.emit('onActivationEnd', state, { state, operative: op });
    expect(cost()).toBe(1);
    // "Having an enemy operative within its control range doesn't prevent that friendly
    // operative from performing that mission action" is REMINDER-ONLY: every mission action
    // refuses in its own `check` and `canPerformAction` can only forbid, never permit.
    expect(rule('deathwatch.eq.scrutavore-servo-thrall')).toContain(
      'Having an enemy operative within its control range doesn’t prevent',
    );
  });
});
