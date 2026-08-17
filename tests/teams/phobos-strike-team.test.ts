/**
 * PHOBOS STRIKE TEAM. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/phobos-strike-team/
 */
import { describe, expect, it } from 'vitest';
import { availableActions } from '../../src/core/actions.ts';
import { counteractCandidates } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { hitOf, inflictDamage, moveOf } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { ShootSequence } from '../../src/core/sequences/types.ts';
import { teamData } from '../../src/teams/data.ts';
import {
  EXPLOSIVES_MARKER,
  HAYWIRE_MARKER,
  customWeaponRules,
  phobosStrikeTeam,
  setCustomWeaponRules,
  useCommsArray,
} from '../../src/teams/phobos-strike-team/index.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import { act, activate, battle, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { testMap } from '../fixtures.ts';

const DATA = teamData('phobos-strike-team');

const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const card = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const ability = (cardId: string, abilityId: string): string =>
  card(cardId).abilities.find((a) => a.id === abilityId)!.text;
const uniqueActionText = (cardId: string, actionId: string): string =>
  card(cardId).uniqueActions.find((a) => a.id === actionId)!.text;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = card(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

const C = {
  infiltratorSergeant: 'phobos-strike-team.infiltrator-sergeant',
  commsman: 'phobos-strike-team.infiltrator-commsman',
  helixAdept: 'phobos-strike-team.infiltrator-helix-adept',
  saboteur: 'phobos-strike-team.infiltrator-saboteur',
  veteran: 'phobos-strike-team.infiltrator-veteran',
  voxbreaker: 'phobos-strike-team.infiltrator-voxbreaker',
  infiltratorWarrior: 'phobos-strike-team.infiltrator-warrior',
  incursorSergeant: 'phobos-strike-team.incursor-sergeant',
  marksman: 'phobos-strike-team.incursor-marksman',
  minelayer: 'phobos-strike-team.incursor-minelayer',
  incursorWarrior: 'phobos-strike-team.incursor-warrior',
  reiverSergeant: 'phobos-strike-team.reiver-sergeant',
  reiverWarrior: 'phobos-strike-team.reiver-warrior',
};

const R = {
  omniScrambler: 'phobos-strike-team.rule.omni-scrambler',
  terror: 'phobos-strike-team.rule.terror',
  astartes: 'phobos-strike-team.rule.astartes',
  multiSpectrum: 'phobos-strike-team.rule.multi-spectrum-array',
  guerrillaWarfare: 'phobos-strike-team.sp.guerrilla-warfare',
  knowNoFear: 'phobos-strike-team.sp.and-they-shall-know-no-fear',
  deadlyShots: 'phobos-strike-team.sp.deadly-shots',
  lethalAssaults: 'phobos-strike-team.sp.lethal-assaults',
  patientAmbush: 'phobos-strike-team.fp.patient-ambush',
  criticalShot: 'phobos-strike-team.fp.critical-shot',
  transhuman: 'phobos-strike-team.fp.transhuman-physiology',
  stealthAssault: 'phobos-strike-team.fp.stealth-assault',
  puritySeals: 'phobos-strike-team.eq.purity-seals',
  additionalGrenades: 'phobos-strike-team.eq.additional-utility-grenades',
  combatBlades: 'phobos-strike-team.eq.combat-blades',
  specialAmmo: 'phobos-strike-team.eq.special-issue-ammunition',
};

interface Setup {
  ctx: ReturnType<typeof teamContext>;
  state: GameState;
}

/** A battle with both sides fielding the named datacards. */
function setup(opts: { cards?: string[]; equipment?: string[]; script?: number[]; closeQuarters?: boolean } = {}): Setup {
  const ctx = teamContext([phobosStrikeTeam], {
    seed: 7,
    ...(opts.script ? { script: opts.script } : {}),
  });
  const picks = rosterIncluding(phobosStrikeTeam, opts.cards ?? []);
  const map = opts.closeQuarters ? testMap({ id: 'test-cq', closeQuarters: true }) : undefined;
  const state = battle({
    ctx,
    ...(map ? { map } : {}),
    p1: { module: phobosStrikeTeam, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: phobosStrikeTeam, picks },
  });
  return { ctx, state };
}

/** A shoot sequence in flight, so a rule that reads `state.sequence` can be exercised. */
function fakeShoot(
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  weaponName: string,
  over: Partial<ShootSequence> = {},
): ShootSequence {
  const seq: ShootSequence = {
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
  };
  state.sequence = seq;
  return seq;
}

const attackCtx = (attacker: OperativeState, profile: WeaponProfile, weaponName: string, defender?: OperativeState) => ({
  attacker,
  ...(defender ? { defender } : {}),
  weaponName,
  profile,
  rules: profile.rules,
  type: profile.type,
  secondary: false,
  pointBlank: false,
  inCover: false,
  obscured: false,
  vantageAccurate: 0,
  distance: 4,
});

const zero = () => ({ hit: 0, save: 0, apl: 0, move: 0, atk: 0 });

// ---------------------------------------------------------------------------
describe('PHOBOS STRIKE TEAM data (pinned against data/teams/phobos-strike-team.json)', () => {
  it('has 13 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(13);
    for (const id of [C.infiltratorSergeant, C.incursorSergeant, C.reiverSergeant]) {
      expect(card(id)).toMatchObject({ apl: 3, move: 7, save: 3, wounds: 13, base: { shape: 'round', mm: 32 } });
      expect(card(id).keywords).toContain('LEADER');
    }
    for (const c of DATA.datacards.filter((x) => !x.keywords.includes('LEADER'))) {
      expect(c).toMatchObject({ apl: 3, move: 7, save: 3, wounds: 12, base: { shape: 'round', mm: 32 } });
    }
    expect(card(C.marksman).keywords).toEqual([
      'PHOBOS STRIKE TEAM',
      'IMPERIUM',
      'ADEPTUS ASTARTES',
      'INCURSOR',
      'MARKSMAN',
    ]);
  });

  it('pins the weapon profiles the rules name', () => {
    expect(profileOf(C.infiltratorSergeant, 'Marksman bolt carbine')).toMatchObject({
      type: 'ranged',
      atk: 4,
      hit: 3,
      dmgN: 3,
      dmgC: 4,
    });
    expect(profileOf(C.marksman, 'Stalker marksman bolt carbine')).toMatchObject({ atk: 4, hit: 2, dmgN: 3, dmgC: 4 });
    expect(profileOf(C.minelayer, 'Occulus bolt carbine').rules.map((r) => r.id)).toEqual(['Saturate']);
    expect(profileOf(C.veteran, 'Custom bolt carbine').rules.map((r) => r.id)).toEqual(['Custom']);
    const detonator = profileOf(C.saboteur, 'Remote detonator');
    expect(detonator).toMatchObject({ atk: 4, hit: 2, dmgN: 5, dmgC: 6 });
    expect(detonator.rules.map((r) => r.raw)).toEqual([
      'Heavy (Dash only)',
      'Limited 1',
      'Piercing 1',
      'Silent',
      'Detonate*',
    ]);
    expect(profileOf(C.reiverWarrior, 'Combat knife')).toMatchObject({ type: 'melee', atk: 5, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(C.reiverWarrior, 'Special issue bolt pistol').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Piercing 1',
    ]);
  });

  it('exposes 4 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 2 rare rules and 2 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual([
      'Omni-Scrambler',
      'Terror',
      'Astartes',
      'Multi-Spectrum Array',
    ]);
    expect(phobosStrikeTeam.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(phobosStrikeTeam.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(phobosStrikeTeam.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual(['Custom', 'Detonate']);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual(['HELIX GAUNTLET', 'AUSPEX SCAN']);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(18);
    // The AI needs a value for all eight ploys or it never uses a firefight ploy at all.
    expect(Object.keys(phobosStrikeTeam.aiHints!.ployValue!)).toHaveLength(8);
    expect(Object.keys(phobosStrikeTeam.aiHints!.roles!)).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
describe('Omni-Scrambler — "that enemy operative cannot be activated or perform actions until…"', () => {
  it('is offered as a STRATEGIC GAMBIT and jams the selected enemy operative', () => {
    expect(rule(R.omniScrambler)).toContain('STRATEGIC GAMBIT if a friendly INFILTRATOR operative is in the killzone');
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(options.map((o) => o.id)).toContain(R.omniScrambler);

    const enemy = opWith(state, 'p2', C.commsman);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: R.omniScrambler, data: { operativeId: enemy } }, ctx)
      .state;
    const jam = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[enemy]!,
      action: 'Shoot',
      allowed: true,
    });
    expect(jam.allowed).toBe(false);
    expect(jam.reason).toMatch(/Omni-Scrambler/);
  });

  it('releases the operative once it is "the last enemy operative to be activated"', () => {
    expect(rule(R.omniScrambler)).toContain('It’s the last enemy operative to be activated');
    const { ctx, state } = setup();
    const enemy = opWith(state, 'p2', C.commsman);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: R.omniScrambler, data: { operativeId: enemy } }, ctx)
      .state;
    for (const id of s.teams.p2.operativeIds) if (id !== enemy) s.operatives[id]!.ready = false;
    const free = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[enemy]!,
      action: 'Shoot',
      allowed: true,
    });
    expect(free.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Terror — "your opponent must spend 1 additional AP … and treat the total APL stat … as 1 lower"', () => {
  it('adds 1AP to an enemy operative’s Pick Up Marker within 3" of friendly REIVER operatives', () => {
    expect(rule(R.terror)).toContain('1 additional AP for that enemy operative to perform the Pick Up Marker');
    const { ctx, state } = setup({ cards: [C.reiverWarrior] });
    const reiver = state.operatives[opWith(state, 'p1', C.reiverWarrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    reiver.pos = { x: 14, y: 11 };
    foe.pos = { x: 16, y: 11 };
    expect(ctx.hooks.emit('onActionCost', state, { state, operative: foe, action: 'Pick Up Marker', ap: 1 }).ap).toBe(2);
    // Out of range again.
    foe.pos = { x: 24, y: 11 };
    expect(ctx.hooks.emit('onActionCost', state, { state, operative: foe, action: 'Pick Up Marker', ap: 1 }).ap).toBe(1);
  });

  it('drops the contesting enemy total APL by 1 when determining control of a marker', () => {
    expect(rule(R.terror)).toContain('treat the total APL stat of enemy operatives that contest it as 1 lower');
    const { ctx, state } = setup({ cards: [C.reiverWarrior] });
    const reiver = state.operatives[opWith(state, 'p1', C.reiverWarrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    foe.pos = { x: 15, y: 11.3 }; // contesting the centre objective
    reiver.pos = { x: 13, y: 11 };
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 0, p2: 3 },
    });
    expect(ev.aplByPlayer.p2).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Astartes — "either two Shoot actions or two Fight actions … can counteract regardless of its order"', () => {
  it('offers a Conceal-order PHOBOS STRIKE TEAM operative the counteract, and only ours', () => {
    expect(rule(R.astartes)).toContain('Each friendly PHOBOS STRIKE TEAM operative can counteract regardless of its order.');
    // p2 is KASRKIN, so the enemy side genuinely does not print the clause.
    const ctx = teamContext([phobosStrikeTeam, kasrkin], { seed: 7 });
    const state = battle({
      ctx,
      p1: { module: phobosStrikeTeam, picks: rosterIncluding(phobosStrikeTeam, [C.commsman, C.reiverWarrior]) },
      p2: { module: kasrkin },
    });
    for (const op of Object.values(state.operatives)) {
      op.ready = false;
      op.expended = true;
      op.order = 'conceal';
    }
    const concealed = opWith(state, 'p1', C.commsman);
    const engaged = opWith(state, 'p1', C.reiverWarrior);
    state.operatives[engaged]!.order = 'engage';

    // The clause widens the core's Engage-order default: a Conceal PHOBOS STRIKE TEAM operative
    // is a counteract candidate, and an Engage-order one still is.
    const ids = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(concealed);
    expect(ids).toContain(engaged);

    // It widens the ORDER only. "Each of their operatives that is expended and has an Engage
    // order can counteract once during the turning point" — the once-per-turning-point limit,
    // the expended requirement and the On Guard lockout are untouched.
    state.operatives[concealed]!.counteractedThisTP = true;
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(concealed);
    state.operatives[concealed]!.counteractedThisTP = false;
    state.operatives[concealed]!.expended = false;
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(concealed);
    state.operatives[concealed]!.expended = true;
    state.operatives[concealed]!.guardSpentTP = state.turningPoint;
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(concealed);
    state.operatives[concealed]!.guardSpentTP = null;
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).toContain(concealed);

    // "friendly PHOBOS STRIKE TEAM" is ours alone: an enemy KASRKIN operative on a Conceal
    // order is not a candidate.
    expect(counteractCandidates(ctx, state, 'p2')).toEqual([]);
    expect(
      ctx.hooks.emit('onCounteract', state, {
        state,
        operative: state.operatives[state.teams.p2.operativeIds[0]!]!,
        allowed: false,
      }).allowed,
    ).toBe(false);
  });

  it('registers a second Shoot action that needs a bolt weapon for at least one of the two', () => {
    expect(rule(R.astartes)).toContain('a bolt weapon must be selected for at least one of them');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.saboteur);
    let s = activate(ctx, state, id);
    expect(availableActions(ctx, s, s.operatives[id]!).some((a) => a.def.id === 'Shoot (Phobos Astartes)')).toBe(true);

    const first = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Phobos Astartes)', params: { weaponName: 'Remote detonator' } },
      ctx,
    );
    expect(first.reason).toMatch(/second Shoot action/);

    s.operatives[id]!.actionsThisActivation = ['Shoot'];
    const noBolt = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Phobos Astartes)', params: { weaponName: 'Remote detonator' } },
      ctx,
    );
    expect(noBolt.reason).toMatch(/bolt weapon must be selected/);

    s.operatives[id]!.actionsThisActivation = ['Fight'];
    const bothKinds = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: id,
        action: 'Shoot (Phobos Astartes)',
        params: { weaponName: 'Marksman bolt carbine' },
      },
      ctx,
    );
    expect(bothKinds.reason).toMatch(/either two Shoot actions or two Fight actions/);
  });
});

// ---------------------------------------------------------------------------
describe('Multi-Spectrum Array — "Whenever a friendly INCURSOR operative is shooting, enemy operatives cannot be obscured"', () => {
  it('clears obscured for an INCURSOR’s shot and leaves an INFILTRATOR’s alone', () => {
    expect(rule(R.multiSpectrum)).toContain('enemy operatives cannot be obscured');
    const { ctx, state } = setup({ cards: [C.incursorWarrior] });
    const incursor = state.operatives[opWith(state, 'p1', C.incursorWarrior)]!;
    const infiltrator = state.operatives[opWith(state, 'p1', C.commsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;

    const seq = fakeShoot(state, incursor, foe, 'Occulus bolt carbine', { obscured: true, step: 'rollAttack' });
    const occulus = profileOf(C.incursorWarrior, 'Occulus bolt carbine');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(incursor, occulus, 'Occulus bolt carbine', foe),
      count: 4,
      mods: zero(),
    });
    expect(seq.obscured).toBe(false);

    const seq2 = fakeShoot(state, infiltrator, foe, 'Marksman bolt carbine', { obscured: true, step: 'rollAttack' });
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(infiltrator, carbine, 'Marksman bolt carbine', foe),
      count: 4,
      mods: zero(),
    });
    expect(seq2.obscured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('SERGEANT › Tactical Advantage', () => {
  it('refunds the Patient Ambush firefight ploy once per battle', () => {
    expect(ability(C.infiltratorSergeant, `${C.infiltratorSergeant}.tactical-advantage`)).toContain(
      'the Patient Ambush firefight ploy for 0CP if this operative is ready and not within control range of enemy operatives',
    );
    const { ctx, state } = setup();
    const before = state.teams.p1.cp;
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: R.patientAmbush }, ctx).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP spent, 1CP refunded

    // "You can do each of the following once per battle."
    s.teams.p1.ploysUsedTP = [];
    s.turningPoint = 2;
    s.activePlayer = 'p1';
    const after = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: R.patientAmbush }, ctx).state;
    expect(s.teams.p1.cp).toBe(after - 1);
  });
});

// ---------------------------------------------------------------------------
describe('INFILTRATOR COMMSMAN abilities', () => {
  it('Strategic Oversight: "roll one D6: on a 4+, you gain one additional CP"', () => {
    expect(ability(C.commsman, `${C.commsman}.strategic-oversight`)).toContain('on a 4+, you gain one additional CP');
    const hit = setup({ script: [4] });
    expect(hit.ctx.hooks.emit('onReadyStep', hit.state, { state: hit.state, player: 'p1', cp: 1 }).cp).toBe(2);
    const miss = setup({ script: [3] });
    expect(miss.ctx.hooks.emit('onReadyStep', miss.state, { state: miss.state, player: 'p1', cp: 1 }).cp).toBe(1);
  });

  it('Comms Array: "you can change one strategy ploy you’ve used this turning point (it doesn’t cost you any CP)"', () => {
    expect(ability(C.commsman, `${C.commsman}.comms-array`)).toContain(
      'you can change one strategy ploy you’ve used this turning point',
    );
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: R.deadlyShots }, ctx).state;
    const cp = s.teams.p1.cp;
    expect(useCommsArray(s, 'p1', R.deadlyShots, R.lethalAssaults)).toBe(true);
    expect(s.teams.p1.gambitsUsedTP).toEqual([R.lethalAssaults]);
    expect(s.teams.p1.cp).toBe(cp); // "it doesn't cost you any CP to do so"
    // "Once per turning point."
    expect(useCommsArray(s, 'p1', R.lethalAssaults, R.deadlyShots)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('INFILTRATOR HELIX ADEPT', () => {
  it('Medic!: "that friendly operative isn’t incapacitated, has D3 wounds remaining"', () => {
    expect(ability(C.helixAdept, `${C.helixAdept}.medic`)).toContain('has D3 wounds remaining');
    const { ctx, state } = setup({ script: [5] }); // D3 = ceil(5/2) = 3
    const medic = state.operatives[opWith(state, 'p1', C.helixAdept)]!;
    const victim = state.operatives[opWith(state, 'p1', C.commsman)]!;
    medic.pos = { x: 10, y: 11 };
    victim.pos = { x: 11, y: 11 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 29, y: 21 };

    inflictDamage(ctx, state, victim, 30, 'attack');
    expect(victim.incapacitated).toBeFalsy();
    expect(victim.wounds).toBe(3);
    // "Subtract 1 from this … operative's APL stat"
    expect(medic.aplMods).toContain(-1);
    // "that friendly operative can immediately perform a free Dash action"
    expect(victim.aplMods).toContain(1);
    expect(state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === victim.id)).toBe(true);
  });

  it('HELIX GAUNTLET 1AP restores D3+3 lost wounds to a friendly operative within control range', () => {
    expect(uniqueActionText(C.helixAdept, `${C.helixAdept}.act.helix-gauntlet`)).toContain(
      'regain up to D3+3 lost wounds',
    );
    const { ctx, state } = setup({ script: [3] }); // D3 = 2, so 5 wounds
    const adept = opWith(state, 'p1', C.helixAdept);
    const patient = opWith(state, 'p1', C.commsman);
    state.operatives[adept]!.pos = { x: 10, y: 11 };
    state.operatives[patient]!.pos = { x: 10.7, y: 11 };
    state.operatives[patient]!.wounds = 4;
    let s = activate(ctx, state, adept);
    const far = act(ctx, s, adept, `${C.helixAdept}.act.helix-gauntlet`, {
      targetOperativeId: opWith(s, 'p2', C.commsman),
    });
    expect(far.ok).toBe(false);

    s = act(ctx, s, adept, `${C.helixAdept}.act.helix-gauntlet`, { targetOperativeId: patient }).state;
    expect(s.operatives[patient]!.wounds).toBe(9);
  });
});

// ---------------------------------------------------------------------------
describe('INFILTRATOR SABOTEUR — Plant Explosives and Detonate', () => {
  it('Plant Explosives: the SABOTEUR carries the Explosives marker and gets a free Dash when it places it', () => {
    expect(ability(C.saboteur, `${C.saboteur}.plant-explosives`)).toContain(
      'it can immediately perform a free Dash action',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.saboteur);
    let s = activate(ctx, state, id);
    expect(s.operatives[id]!.carryingMarkerId).toBe(EXPLOSIVES_MARKER('p1'));

    // The universal Place Marker is refused so the ability's own placement is used.
    const universal = act(ctx, s, id, 'Place Marker', { markerPos: { ...s.operatives[id]!.pos } });
    expect(universal.ok).toBe(false);

    const out = act(ctx, s, id, 'Place Marker (Explosives)', { markerPos: { ...s.operatives[id]!.pos } });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.markers[EXPLOSIVES_MARKER('p1')]!.carriedBy).toBeUndefined();
    expect(s.operatives[id]!.aplMods).toContain(1);
    expect(
      s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === id && (e.data?.['only'] as string[]).includes('Dash')),
    ).toBe(true);
  });

  it('Detonate: "shoot against each operative within 2\\" of your Explosives marker" and remove the marker', () => {
    expect(ability(C.saboteur, `${C.saboteur}.detonate`)).toContain(
      'shoot against each operative within 2" of your Explosives marker',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.saboteur);
    let s = activate(ctx, state, id);
    // Drop the marker in the middle of two enemy operatives.
    const marker = s.markers[EXPLOSIVES_MARKER('p1')]!;
    marker.carriedBy = undefined;
    marker.pos = { x: 20, y: 11 };
    s.operatives[id]!.carryingMarkerId = undefined;
    const a = opWith(s, 'p2', C.commsman);
    const b = opWith(s, 'p2', C.helixAdept);
    s.operatives[a]!.pos = { x: 20, y: 11.6 };
    s.operatives[b]!.pos = { x: 20.9, y: 11 };
    for (const other of s.teams.p2.operativeIds) if (other !== a && other !== b) s.operatives[other]!.pos = { x: 29, y: 2 };
    const woundsBefore = [s.operatives[a]!.wounds, s.operatives[b]!.wounds];

    const out = act(ctx, s, id, 'Shoot (Detonate)', { weaponName: 'Remote detonator' });
    expect(out.ok).toBe(true);
    s = settle(ctx, out.state);
    expect(s.operatives[a]!.wounds).toBeLessThan(woundsBefore[0]!);
    expect(s.operatives[b]!.wounds).toBeLessThan(woundsBefore[1]!);
    // "At the end of the action, remove your Explosives marker from the killzone."
    expect(s.markers[EXPLOSIVES_MARKER('p1')]).toBeUndefined();
  });

  it('Detonate: "This weapon cannot be selected if your Explosives marker isn’t in the killzone"', () => {
    expect(ability(C.saboteur, `${C.saboteur}.detonate`)).toContain(
      'This weapon cannot be selected if your Explosives marker isn’t in the killzone',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.saboteur);
    const s = activate(ctx, state, id);
    const withMarker = ctx.hooks.emit('availableWeapons', s, {
      state: s,
      operative: s.operatives[id]!,
      weapons: ['Marksman bolt carbine', 'Remote detonator', 'Fists'],
    }).weapons;
    expect(withMarker).toContain('Remote detonator');

    delete s.markers[EXPLOSIVES_MARKER('p1')];
    s.operatives[id]!.carryingMarkerId = undefined;
    const without = ctx.hooks.emit('availableWeapons', s, {
      state: s,
      operative: s.operatives[id]!,
      weapons: ['Marksman bolt carbine', 'Remote detonator', 'Fists'],
    }).weapons;
    expect(without).not.toContain('Remote detonator');
    expect(act(ctx, s, id, 'Shoot (Detonate)', { weaponName: 'Remote detonator' }).ok).toBe(false);
  });

  it('Detonate: "In a killzone that uses the close quarters rules … this weapon has the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup({ closeQuarters: true });
    const shooter = state.operatives[opWith(state, 'p1', C.saboteur)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    const detonator = profileOf(C.saboteur, 'Remote detonator');
    const rules = effectiveRules(ctx, state, detonator, {
      operative: shooter,
      target: foe,
      weaponName: 'Remote detonator',
    });
    expect(rules.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('INFILTRATOR VETERAN › Custom (rare weapon rule)', () => {
  it('"select up to two of the following weapon rules for this weapon to have for the battle"', () => {
    expect(ability(C.veteran, `${C.veteran}.custom`)).toContain(
      'select up to two of the following weapon rules for this weapon to have for the battle: Balanced, Lethal 5+, Piercing Crits 1, Rending, Saturate',
    );
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.veteran)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    const custom = profileOf(C.veteran, 'Custom bolt carbine');
    const use = { operative: shooter, target: foe, weaponName: 'Custom bolt carbine' };

    // Nothing applies until the choice is made (Select Operatives has no decision channel).
    expect(effectiveRules(ctx, state, custom, use).map((r) => r.id)).toEqual(['Custom']);

    expect(setCustomWeaponRules(state, 'p1', ['Balanced', 'Rending'])).toBe(true);
    expect(customWeaponRules(state, 'p1')).toEqual(['Balanced', 'Rending']);
    const after = effectiveRules(ctx, state, custom, use).map((r) => r.id);
    expect(after).toContain('Balanced');
    expect(after).toContain('Rending');

    // "up to two" — three is refused rather than silently truncated.
    expect(setCustomWeaponRules(state, 'p1', ['Balanced', 'Rending', 'Saturate'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('INFILTRATOR VOXBREAKER', () => {
  it('Voxbreak: "your opponent cannot re-roll their attack or defence dice for that operative"', () => {
    expect(ability(C.voxbreaker, `${C.voxbreaker}.voxbreak`)).toContain(
      'your opponent cannot re-roll their attack or defence dice for that operative',
    );
    const { ctx, state } = setup();
    const vox = state.operatives[opWith(state, 'p1', C.voxbreaker)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    vox.pos = { x: 14, y: 11 };
    foe.pos = { x: 17, y: 11 };
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    const grant = { id: 'balanced', label: 'Balanced', mode: 'one' as const, max: 1 };

    const jammed = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(foe, carbine, 'Marksman bolt carbine', vox),
      dice: [],
      rerolls: [{ ...grant }],
    });
    expect(jammed.rerolls).toHaveLength(0);

    foe.pos = { x: 24, y: 11 }; // more than 6" away
    const free = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(foe, carbine, 'Marksman bolt carbine', vox),
      dice: [],
      rerolls: [{ ...grant }],
    });
    expect(free.rerolls).toHaveLength(1);
  });

  it('AUSPEX SCAN 1AP denies obscured within 8" and gives INCURSORs Seek Light', () => {
    expect(uniqueActionText(C.voxbreaker, `${C.voxbreaker}.act.auspex-scan`)).toContain(
      'that enemy operative cannot be obscured; if that friendly operative is an INCURSOR, its ranged weapons also have the Seek Light weapon rule',
    );
    const { ctx, state } = setup({ cards: [C.voxbreaker, C.incursorWarrior] });
    const vox = opWith(state, 'p1', C.voxbreaker);
    const incursor = state.operatives[opWith(state, 'p1', C.incursorWarrior)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    state.operatives[vox]!.pos = { x: 14, y: 11 };
    foe.pos = { x: 18, y: 11 };

    let s = activate(ctx, state, vox);
    s = act(ctx, s, vox, `${C.voxbreaker}.act.auspex-scan`).state;
    expect(s.effects.some((e) => e.rule === 'phobos.auspexScan' && e.operativeId === vox)).toBe(true);

    const occulus = profileOf(C.incursorWarrior, 'Occulus bolt carbine');
    const rules = effectiveRules(ctx, s, occulus, {
      operative: s.operatives[incursor.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Occulus bolt carbine',
    });
    expect(rules.some((r) => r.id === 'SeekLight')).toBe(true);

    const seq = fakeShoot(s, s.operatives[incursor.id]!, s.operatives[foe.id]!, 'Occulus bolt carbine', {
      obscured: true,
      step: 'rollAttack',
    });
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[incursor.id]!, occulus, 'Occulus bolt carbine', s.operatives[foe.id]!),
      count: 4,
      mods: zero(),
    });
    expect(seq.obscured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('WARRIOR › Vanguard', () => {
  it('"can perform the Pick Up Marker or a mission action for 1 less AP", once per turning point', () => {
    expect(ability(C.infiltratorWarrior, `${C.infiltratorWarrior}.vanguard`)).toContain(
      'can perform the Pick Up Marker or a mission action for 1 less AP',
    );
    const { ctx, state } = setup({ cards: [C.infiltratorWarrior] });
    const warrior = state.operatives[opWith(state, 'p1', C.infiltratorWarrior)]!;
    expect(ctx.hooks.emit('onActionCost', state, { state, operative: warrior, action: 'Pick Up Marker', ap: 1 }).ap).toBe(
      0,
    );
    // Someone else on the team does not get it.
    const other = state.operatives[opWith(state, 'p1', C.commsman)]!;
    expect(ctx.hooks.emit('onActionCost', state, { state, operative: other, action: 'Pick Up Marker', ap: 1 }).ap).toBe(1);

    // "Once per turning point" — spent when the activation that used it ends.
    warrior.actionsThisActivation = ['Pick Up Marker'];
    ctx.hooks.emit('onActivationEnd', state, { state, operative: warrior });
    expect(ctx.hooks.emit('onActionCost', state, { state, operative: warrior, action: 'Pick Up Marker', ap: 1 }).ap).toBe(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
describe('INCURSOR MARKSMAN › Track Target', () => {
  it('"can perform the Guard action regardless of the killzone … while it has a Conceal order"', () => {
    expect(ability(C.marksman, `${C.marksman}.track-target`)).toContain(
      'It can perform the Guard action while it has a Conceal order',
    );
    const { ctx, state } = setup({ cards: [C.marksman] });
    const id = opWith(state, 'p1', C.marksman);
    let s = activate(ctx, state, id, 'conceal');
    const actions = availableActions(ctx, s, s.operatives[id]!);
    // The universal Guard is a Close Quarters action and this killzone is not one.
    expect(actions.some((a) => a.def.id === 'Guard')).toBe(false);
    const track = actions.find((a) => a.def.id === 'Guard (Track Target)');
    expect(track?.ok).toBe(true);

    const guarded = act(ctx, s, id, 'Guard (Track Target)');
    expect(guarded.ok, guarded.reason).toBe(true);
    // PARTIAL, and a tripwire: `PerformAction` clears `onGuard` for every action whose id is
    // not literally 'Guard' (src/core/reducer.ts), and `offerGuardInterrupt` is gated on
    // `map.closeQuarters`, so the guard state itself needs an engine seam. Reported.
    expect(guarded.state.operatives[id]!.onGuard).toBe(false);
  });

  it('"you must change its order to Engage" when the free interrupt shot is resolved', () => {
    expect(ability(C.marksman, `${C.marksman}.track-target`)).toContain('you must change its order to Engage');
    const { ctx, state } = setup({ cards: [C.marksman] });
    const marksman = state.operatives[opWith(state, 'p1', C.marksman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    marksman.order = 'conceal';
    const stalker = profileOf(C.marksman, 'Stalker marksman bolt carbine');
    fakeShoot(state, marksman, foe, 'Stalker marksman bolt carbine', { free: true, step: 'rollAttack' });
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(marksman, stalker, 'Stalker marksman bolt carbine', foe),
      count: 4,
      mods: zero(),
    });
    expect(marksman.order).toBe('engage');
  });
});

// ---------------------------------------------------------------------------
describe('INCURSOR MINELAYER — Haywire Mine and Proximity Mine', () => {
  it('Haywire Mine: "that marker cannot be placed within an enemy operative’s control range"', () => {
    expect(ability(C.minelayer, `${C.minelayer}.haywire-mine`)).toContain(
      'that marker cannot be placed within an enemy operative’s control range',
    );
    const { ctx, state } = setup({ cards: [C.minelayer] });
    const id = opWith(state, 'p1', C.minelayer);
    state.operatives[id]!.pos = { x: 14, y: 11 };
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    foe.pos = { x: 15.4, y: 11 };
    let s = activate(ctx, state, id);
    expect(s.operatives[id]!.carryingMarkerId).toBe(HAYWIRE_MARKER('p1'));

    const blocked = act(ctx, s, id, 'Place Marker (Haywire Mine)', { markerPos: { x: 14.8, y: 11 } });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/enemy operative/);

    const ok = act(ctx, s, id, 'Place Marker (Haywire Mine)', { markerPos: { x: 12.6, y: 11 } });
    expect(ok.ok, ok.reason).toBe(true);
    s = ok.state;
    expect(s.markers[HAYWIRE_MARKER('p1')]!.pos.x).toBeCloseTo(12.6);
  });

  it('Proximity Mine: "remove that marker, subtract 1 from that operative’s APL stat … and inflict 2D3+3 damage"', () => {
    expect(ability(C.minelayer, `${C.minelayer}.proximity-mine`)).toContain(
      'subtract 1 from that operative’s APL stat until the end of its next activation, and inflict 2D3+3 damage on it',
    );
    const { ctx, state } = setup({ cards: [C.minelayer] });
    const id = opWith(state, 'p1', C.minelayer);
    let s = activate(ctx, state, id);
    const marker = s.markers[HAYWIRE_MARKER('p1')]!;
    marker.carriedBy = undefined;
    marker.pos = { x: 18, y: 11 };
    s.operatives[id]!.carryingMarkerId = undefined;
    s.operatives[id]!.pos = { x: 10, y: 11 };
    const victim = s.operatives[opWith(s, 'p2', C.commsman)]!;
    victim.pos = { x: 18.4, y: 11 };
    const before = victim.wounds;

    ctx.hooks.emit('onActivationStart', s, { state: s, operative: victim });
    expect(s.markers[HAYWIRE_MARKER('p1')]).toBeUndefined();
    expect(before - victim.wounds).toBeGreaterThanOrEqual(5);
    expect(victim.aplMods).toContain(-1);
  });
});

// ---------------------------------------------------------------------------
describe('REIVER › Grav-chute and Grapnel Launcher (reminder-only)', () => {
  it('"you can treat the vertical distance as 2\\"" has no seam: onMoveRules is never emitted', () => {
    expect(ability(C.reiverSergeant, `${C.reiverSergeant}.grav-chute-and-grapnel-launcher`)).toContain(
      'you can treat the vertical distance as 2"',
    );
    expect(ability(C.reiverWarrior, `${C.reiverWarrior}.grav-chute-and-grapnel-launcher`)).toContain(
      'Whenever this operative is dropping, ignore the vertical distance',
    );
    // Nothing in the module registers against the dead hook — a handler there would be a
    // silent no-op (docs/TEAM-STATUS.md § Known engine gaps).
    const { ctx } = setup({ cards: [C.reiverWarrior] });
    expect(ctx.hooks.has('onMoveRules')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('PHOBOS STRIKE TEAM strategy ploys', () => {
  it('GUERRILLA WARFARE grants a 1AP unique action that changes the operative’s order', () => {
    expect(rule(R.guerrillaWarfare)).toContain('Change this operative’s order');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.commsman);
    let s = activate(ctx, state, id, 'conceal');
    expect(availableActions(ctx, s, s.operatives[id]!).some((a) => a.def.id === 'phobos-strike-team.act.guerrilla-warfare')).toBe(
      false,
    );

    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: R.guerrillaWarfare }, ctx).state;
    s = act(ctx, s, id, 'phobos-strike-team.act.guerrilla-warfare').state;
    expect(s.operatives[id]!.order).toBe('engage');
  });

  it('AND THEY SHALL KNOW NO FEAR ignores the injured Move and Hit changes', () => {
    expect(rule(R.knowNoFear)).toContain('ignore any changes to the stats of friendly PHOBOS STRIKE TEAM operatives');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.commsman)]!;
    op.wounds = 4; // fewer than half of 12 — injured
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    expect(moveOf(ctx, state, op)).toBeCloseTo(5);
    expect(hitOf(ctx, state, op, carbine)).toBe(4);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: R.knowNoFear }, ctx).state;
    const injured = s.operatives[op.id]!;
    expect(moveOf(ctx, s, injured)).toBeCloseTo(7);
    expect(hitOf(ctx, s, injured, carbine)).toBe(3);
  });

  it('DEADLY SHOTS gives Balanced when the operative has not moved, or against an exposed target beyond 6"', () => {
    expect(rule(R.deadlyShots)).toContain(
      'during an activation in which it hasn’t performed the Charge, Fall Back or Reposition action',
    );
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.commsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    shooter.pos = { x: 14, y: 11 };
    foe.pos = { x: 17, y: 11 };
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    const use = { operative: shooter, target: foe, weaponName: 'Marksman bolt carbine' };
    expect(effectiveRules(ctx, state, carbine, use).some((r) => r.id === 'Balanced')).toBe(false);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: R.deadlyShots }, ctx).state;
    const a = s.operatives[shooter.id]!;
    const b = s.operatives[foe.id]!;
    expect(effectiveRules(ctx, s, carbine, { ...use, operative: a, target: b }).some((r) => r.id === 'Balanced')).toBe(
      true,
    );

    // Moved, and the target is within 6" — neither branch applies.
    a.actionsThisActivation = ['Reposition'];
    expect(effectiveRules(ctx, s, carbine, { ...use, operative: a, target: b }).some((r) => r.id === 'Balanced')).toBe(
      false,
    );
    // Moved, but the target is not in cover and more than 6" away.
    b.pos = { x: 24, y: 11 };
    expect(effectiveRules(ctx, s, carbine, { ...use, operative: a, target: b }).some((r) => r.id === 'Balanced')).toBe(
      true,
    );
  });

  it('LETHAL ASSAULTS gives melee weapons Balanced, and Lethal 5+ after a Charge', () => {
    expect(rule(R.lethalAssaults)).toContain('its melee weapons have the Balanced weapon rule');
    expect(rule(R.lethalAssaults)).toContain('its melee weapons also have the Lethal 5+ weapon rule');
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: R.lethalAssaults }, ctx).state;
    const fighter = s.operatives[opWith(s, 'p1', C.commsman)]!;
    const foe = s.operatives[opWith(s, 'p2', C.commsman)]!;
    const fists = profileOf(C.commsman, 'Fists');
    const use = { operative: fighter, target: foe, weaponName: 'Fists' };
    const before = effectiveRules(ctx, s, fists, use);
    expect(before.some((r) => r.id === 'Balanced')).toBe(true);
    expect(before.some((r) => r.id === 'Lethal')).toBe(false);

    fighter.actionsThisActivation = ['Charge'];
    const charged = effectiveRules(ctx, s, fists, use);
    expect(charged.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);

    // "Whenever a friendly … operative is fighting" — the retaliating half is not covered.
    expect(effectiveRules(ctx, s, fists, { ...use, retaliating: true }).some((r) => r.id === 'Balanced')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('PHOBOS STRIKE TEAM firefight ploys', () => {
  it('PATIENT AMBUSH: "You can skip that activation" — the turn passes and the operative stays ready', () => {
    expect(rule(R.patientAmbush)).toContain('You can skip that activation');
    const { ctx, state } = setup();
    const ploy = phobosStrikeTeam.ploys.find((p) => p.id === R.patientAmbush)!;
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    expect(ploy.usable!({ ...state, activePlayer: 'p2' }, 'p1').ok).toBe(false);

    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: R.patientAmbush }, ctx).state;
    expect(s.activePlayer).toBe('p2');
    expect(s.teams.p1.operativeIds.every((id) => s.operatives[id]!.ready)).toBe(true);
  });

  it('CRITICAL SHOT: "Inflict D3 additional damage" on a critical success with a bolt weapon', () => {
    expect(rule(R.criticalShot)).toContain('Inflict D3 additional damage');
    const { ctx, state } = setup({ script: [5] }); // D3 = 3
    const shooter = state.operatives[opWith(state, 'p1', C.commsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    fakeShoot(state, shooter, foe, 'Marksman bolt carbine', {
      attack: { dice: [{ id: 1, value: 6, state: 'crit', rolled: true }], nextId: 2 },
    });
    const ploy = phobosStrikeTeam.ploys.find((p) => p.id === R.criticalShot)!;
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: R.criticalShot }, ctx).state;
    const target = s.operatives[foe.id]!;
    expect(ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target, amount: 3, kind: 'attack' }).amount).toBe(6);
    // The ploy stays in `ploysUsedTP` all turning point; the bonus must not repeat.
    expect(ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target, amount: 3, kind: 'attack' }).amount).toBe(3);
  });

  it('TRANSHUMAN PHYSIOLOGY: "retain one of your normal successes as a critical success instead"', () => {
    expect(rule(R.transhuman)).toContain('You can retain one of your normal successes as a critical success instead');
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    const mine = state.operatives[opWith(state, 'p1', C.commsman)]!;
    fakeShoot(state, foe, mine, 'Marksman bolt carbine', {
      defence: {
        dice: [
          { id: 1, value: 4, state: 'normal', rolled: true },
          { id: 2, value: 5, state: 'normal', rolled: true },
        ],
        nextId: 3,
      },
    });
    // The ploy is used in the Roll Defence Dice step, so it promotes as it resolves.
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: R.transhuman }, ctx).state;
    const seq = s.sequence as ShootSequence;
    expect(seq.defence.dice.filter((d) => d.state === 'crit')).toHaveLength(1);

    // "one of your normal successes" — never a second, even though the ploy stays in
    // `ploysUsedTP` for the rest of the turning point.
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[foe.id]!, carbine, 'Marksman bolt carbine', s.operatives[mine.id]!),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zero(),
      rerolls: [],
    });
    expect(seq.defence.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('STEALTH ASSAULT is gated to the printed window (its extra dice resolution is reminder-only)', () => {
    expect(rule(R.stealthAssault)).toContain('you can immediately resolve another of your attack dice');
    expect(rule(R.stealthAssault)).toContain('The operative cannot have performed any other actions');
    const { ctx, state } = setup();
    const ploy = phobosStrikeTeam.ploys.find((p) => p.id === R.stealthAssault)!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false);

    const me = state.operatives[opWith(state, 'p1', C.commsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    me.actionsThisActivation = ['Charge', 'Fight'];
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: me.id,
      defenderId: foe.id,
      attackerWeapon: 'Fists',
      defenderCanRetaliate: true,
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
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
    };
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    me.actionsThisActivation = ['Charge', 'Fight', 'Dash'];
    expect(ploy.usable!(state, 'p1').ok).toBe(false);
    // No hook runs after `resolveFightDie` flips `seq.turn`, so the extra resolution is a seam.
    expect(ctx.hooks.has('onStrikeResolved')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('PHOBOS STRIKE TEAM faction equipment', () => {
  it('PURITY SEALS: once per turning point, two or more fails can be swapped for a normal success', () => {
    expect(rule(R.puritySeals)).toContain('if you roll two or more fails, you can discard one of them');
    const { ctx, state } = setup({ equipment: [R.puritySeals] });
    const shooter = state.operatives[opWith(state, 'p1', C.commsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    fakeShoot(state, shooter, foe, 'Marksman bolt carbine', {
      attack: {
        dice: [
          { id: 1, value: 1, state: 'fail', rolled: true },
          { id: 2, value: 2, state: 'fail', rolled: true },
        ],
        nextId: 3,
      },
    });
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    const payload = () => ({
      state,
      ctx: attackCtx(shooter, carbine, 'Marksman bolt carbine', foe),
      dice: [],
      rerolls: [],
    });
    expect(ctx.hooks.emit('onRollAttack', state, payload()).rerolls.some((r) => r.id === 'phobos.puritySeals')).toBe(true);
    // "Once per turning point."
    expect(ctx.hooks.emit('onRollAttack', state, payload()).rerolls.some((r) => r.id === 'phobos.puritySeals')).toBe(
      false,
    );
  });

  it('ADDITIONAL UTILITY GRENADES: "select four utility grenades … not also select that equipment as normal"', () => {
    expect(rule(R.additionalGrenades)).toContain('select four utility grenades from the utility grenades equipment');
    const { state } = setup({ equipment: [R.additionalGrenades] });
    expect(state.teams.p1.equipment).toContain('eq.utilityGrenades');
    expect(state.teams.p1.equipmentUses['eq.utilityGrenades:smoke']).toBe(2);
    expect(state.teams.p1.equipmentUses['eq.utilityGrenades:stun']).toBe(2);
  });

  it('COMBAT BLADES: "Friendly PHOBOS STRIKE TEAM operatives have the following melee weapon: Combat blade 5 / 3+ / 3/4"', () => {
    expect(rule(R.combatBlades)).toContain('Combat blade');
    const { ctx, state } = setup({ equipment: [R.combatBlades] });
    const id = opWith(state, 'p1', C.commsman);
    const s = activate(ctx, state, id);
    const granted = (s.operatives[id] as { grantedWeapons?: { name: string; profiles: WeaponProfile[] }[] })
      .grantedWeapons!;
    const blade = granted.find((w) => w.name === 'Combat blade')!;
    expect(blade.profiles[0]).toMatchObject({ type: 'melee', atk: 5, hit: 3, dmgN: 3, dmgC: 4 });
  });

  it('SPECIAL ISSUE AMMUNITION: one carbine gains Piercing 1 until the end of the turning point', () => {
    expect(rule(R.specialAmmo)).toContain('that weapon has the Piercing 1 weapon rule');
    const { ctx, state } = setup({ equipment: [R.specialAmmo] });
    const shooter = state.operatives[opWith(state, 'p1', C.commsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.commsman)]!;
    const carbine = profileOf(C.commsman, 'Marksman bolt carbine');
    const use = { operative: shooter, target: foe, weaponName: 'Marksman bolt carbine' };
    expect(effectiveRules(ctx, state, carbine, use).some((r) => r.id === 'Piercing')).toBe(false);

    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, carbine, 'Marksman bolt carbine', foe),
      allowed: true,
    });
    expect(effectiveRules(ctx, state, carbine, use).some((r) => r.id === 'Piercing' && r.x === 1)).toBe(true);
    // Another operative's weapon is untouched — the rule names the weapon that was selected.
    const other = state.operatives[opWith(state, 'p1', C.helixAdept)]!;
    expect(
      effectiveRules(ctx, state, carbine, { ...use, operative: other }).some((r) => r.id === 'Piercing'),
    ).toBe(false);
  });
});


