/**
 * BLOODED. Every test quotes the printed rule it pins, read out of `data/teams/blooded.json`
 * — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/blooded/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, HookRegistry, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { advanceShoot, checkTarget, effectiveRules, startShoot } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  hitOf,
  inflictDamage,
  moveOf,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/blooded.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ACT,
  BLOODED_GAMBIT,
  BLOODED_TOKEN,
  CARD,
  CHARGE_WRETCHED,
  EQ,
  FP,
  GAZE,
  KW,
  REMINDER_ONLY,
  RULE_BLOODED,
  SP,
  STIMM_RULES,
  WHISPER_GAMBIT,
  assignBloodedToken,
  blooded,
  bloodedPool,
  gainBloodedToken,
  gazeFor,
  giveStimm,
  gloryKillTarget,
  hasBloodedToken,
  hasStimm,
  setGaze,
  stimmTaken,
  stimmText,
  tokenFor,
  whisperedTarget,
} from '../../src/teams/blooded/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';

const DATA = teamData('blooded');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const RAW = rawJson as { notes: string[]; selection: { constraints: { kind: string; [k: string]: unknown }[] } };

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
const cardOf = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = cardOf(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
  /**
   * Resolve a printed either/or option explicitly: datacard id → the weapon names the pick asks
   * for. A `choiceGroups` option ("Autopistol **or** laspistol; chainsword **or** power weapon")
   * gives an operative exactly one weapon per group, and `defaultRoster` takes the first of each —
   * so a rule test that needs the other alternative has to name it.
   */
  weapons?: Record<string, string[]>;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([blooded], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const base = opts.roles ? rosterIncluding(blooded, opts.roles) : defaultRoster(DATA);
  const want = opts.weapons;
  const picks = want ? base.map((p) => (want[p.datacardId] ? { ...p, weapons: want[p.datacardId]! } : p)) : base;
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: blooded, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: blooded, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Move everything else far away so a control-range / distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.5 + (n % 3) * 1.2, y: 19 + Math.floor(n / 3) * 1.2 };
    n++;
  }
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  over: Partial<AttackContext> = {},
): AttackContext {
  return {
    attacker,
    defender,
    weaponName: 'test',
    profile,
    rules: profile.rules,
    type: profile.type === 'melee' ? 'melee' : 'ranged',
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 1,
    ...over,
  };
}

/** A low Heavy block that puts an operative standing at (12,11) in cover from (20,11). */
const coverMap = (): KillzoneMap => testMap({ features: [heavyBlock('cov', 12.8, 10.2, 0.5, 1.6, 0.6)] });

/**
 * The CHIEFTAIN is the first operative of both kill teams, and its printed first option is
 * "Autopistol or laspistol; chainsword or power weapon" — one weapon per choice group, of which
 * `defaultRoster` takes the first. A rule test that fights with the power weapon asks for it.
 */
const CHIEFTAIN_POWER: Record<string, string[]> = { [CARD.chieftain]: ['Power weapon'] };

// ---------------------------------------------------------------------------
describe('BLOODED data', () => {
  it('is the Blooded kill team from the April ’26 book, with 13 datacards', () => {
    expect(DATA.id).toBe('blooded');
    expect(DATA.name).toBe('Blooded');
    expect(DATA.faction).toBe('Cultists');
    expect(DATA.datacards).toHaveLength(13);
    expect(DATA.datacards.every((c) => c.keywords.includes('BLOODED') && c.keywords.includes('CHAOS'))).toBe(true);
  });

  it('pins the CHIEFTAIN’s stats, base and keywords', () => {
    const c = cardOf(CARD.chieftain);
    expect([c.apl, c.move, c.save, c.wounds]).toEqual([2, 6, 5, 8]);
    expect(c.base).toEqual({ shape: 'round', mm: 25 });
    expect(c.keywords).toEqual(['BLOODED', 'CHAOS', 'LEADER', 'CHIEFTAIN']);
  });

  it('pins the OGRYN as the 40mm, 16-wound brute and the ENFORCER as the 32mm 4+ save', () => {
    const ogryn = cardOf(CARD.ogryn);
    expect([ogryn.apl, ogryn.move, ogryn.save, ogryn.wounds]).toEqual([2, 6, 5, 16]);
    expect(ogryn.base).toEqual({ shape: 'round', mm: 40 });
    const enforcer = cardOf(CARD.enforcer);
    expect([enforcer.save, enforcer.wounds]).toEqual([4, 9]);
    expect(enforcer.base).toEqual({ shape: 'round', mm: 32 });
  });

  it('pins the plasma gun’s two profiles and the supercharge Hot/Lethal 5+', () => {
    const std = profileOf(CARD.gunner, 'Plasma gun', 'standard');
    const sup = profileOf(CARD.gunner, 'Plasma gun', 'supercharge');
    expect([std.atk, std.hit, std.dmgN, std.dmgC]).toEqual([4, 4, 4, 6]);
    expect([sup.atk, sup.hit, sup.dmgN, sup.dmgC]).toEqual([4, 4, 5, 6]);
    expect(sup.rules.map((r) => r.id).sort()).toEqual(['Hot', 'Lethal', 'Piercing']);
  });

  it('pins the diabolyk bomb as Limited 1 with Blast 2" and Devastating 2', () => {
    const bomb = profileOf(CARD.brimstone, 'Diabolyk bomb');
    const ids = bomb.rules.map((r) => r.id);
    expect(ids).toContain('Limited');
    expect(ids).toContain('Blast');
    expect(ids).toContain('Devastating');
    expect(bomb.rules.find((r) => r.id === 'Limited')?.x).toBe(1);
  });

  it('pins the three rare weapon rules to the weapons that carry them', () => {
    expect(DATA.rareWeaponRules).toEqual(['BloodOffering', 'Shield', 'Stalk']);
    expect(profileOf(CARD.butcher, 'Power weapon & cleaver').rules.map((r) => r.id)).toContain('BloodOffering');
    expect(profileOf(CARD.trenchSweeper, 'Bayonet & shield').rules.map((r) => r.id)).toContain('Shield');
    expect(profileOf(CARD.flenser, 'Skinning blades').rules.map((r) => r.id)).toContain('Stalk');
  });

  it('has exactly one faction rule, 4 strategy ploys, 4 firefight ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE_BLOODED]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual(Object.values(SP));
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual(Object.values(FP));
    expect(DATA.equipment.map((e) => e.id)).toEqual(Object.values(EQ));
    expect(DATA.strategyPloys.every((p) => p.cp === 1)).toBe(true);
  });

  it('carries 21 datacard abilities and 4 unique actions, and every id the module names exists', () => {
    const abilities = DATA.datacards.flatMap((c) => c.abilities);
    const actions = DATA.datacards.flatMap((c) => c.uniqueActions);
    expect(abilities).toHaveLength(21);
    expect(actions).toHaveLength(4);
    for (const id of Object.values(AB)) expect(abilities.some((a) => a.id === id), id).toBe(true);
    for (const id of Object.values(ACT)) expect(actions.some((a) => a.id === id), id).toBe(true);
  });

  it('the section overrun is trimmed at load, so the last ploy quotes only its own text', () => {
    // `trimTrailingSection` (src/teams/data.ts) cuts the appended page section; the COMMITTED
    // JSON is still wrong, which is the known 48-of-48 scraper bug.
    expect(ruleText(SP.bitterDemise)).not.toContain('CALLOUS DISREGARD');
    expect(ruleText(FP.darkFavour)).not.toContain('CHAOS SIGIL');
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
  });
});

// ---------------------------------------------------------------------------
describe('Blooded (faction rule) — the token economy', () => {
  it('"You gain one Blooded token: In the Ready step of each Strategy phase."', () => {
    expect(ruleText(RULE_BLOODED)).toContain('In the Ready step of each Strategy phase.');
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'initiative';
    const before = bloodedPool(state, 'p1');
    const out = reduce(state, { t: 'AdvancePhase' }, ctx).state;
    expect(bloodedPool(out, 'p1')).toBe(before + 1);
    expect(bloodedPool(out, 'p2')).toBe(before + 1);
  });

  it('"The first time an enemy operative is incapacitated during each turning point."', () => {
    expect(ruleText(RULE_BLOODED)).toContain('The first time an enemy operative is incapacitated during each turning point.');
    const { ctx, state } = setup();
    const foes = state.teams.p2.operativeIds.map((id) => state.operatives[id]!);
    expect(bloodedPool(state, 'p1')).toBe(0);
    inflictDamage(ctx, state, foes[0]!, 99);
    expect(bloodedPool(state, 'p1')).toBe(1);
    inflictDamage(ctx, state, foes[1]!, 99); // "the FIRST time … during each turning point"
    expect(bloodedPool(state, 'p1')).toBe(1);
  });

  it('"The first time a friendly operative is incapacitated within 6" of an enemy operative"', () => {
    expect(ruleText(RULE_BLOODED)).toContain('within 6" of an enemy operative during each turning point');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 20, 11); // more than 6" away
    inflictDamage(ctx, state, me, 99);
    expect(bloodedPool(state, 'p1')).toBe(0);
    const me2 = state.operatives[state.teams.p1.operativeIds[2]!]!;
    place(state, me2.id, 17, 11); // within 6"
    inflictDamage(ctx, state, me2, 99);
    expect(bloodedPool(state, 'p1')).toBe(1);
  });

  it('"As a STRATEGIC GAMBIT, you can assign any of your unassigned Blooded tokens"', () => {
    expect(ruleText(RULE_BLOODED)).toContain('you can assign any of your unassigned Blooded tokens to friendly BLOODED operatives');
    const { ctx, state } = setup();
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(BLOODED_GAMBIT);
    gainBloodedToken(state, 'p1', 'test');
    gainBloodedToken(state, 'p1', 'test');
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(BLOODED_GAMBIT);
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: BLOODED_GAMBIT }, ctx).state;
    expect(bloodedPool(out, 'p1')).toBe(0);
    expect(out.teams.p1.operativeIds.filter((id) => hasBloodedToken(out, id, 'p1'))).toHaveLength(2);
  });

  it('"Each operative cannot have more than one of your Blooded tokens."', () => {
    expect(ruleText(RULE_BLOODED)).toContain('Each operative cannot have more than one of your Blooded tokens.');
    const { state } = setup();
    const op = state.operatives[state.teams.p1.operativeIds[0]!]!;
    gainBloodedToken(state, 'p1', 'test');
    gainBloodedToken(state, 'p1', 'test');
    expect(assignBloodedToken(state, op, 'p1')).toBe(true);
    expect(assignBloodedToken(state, op, 'p1')).toBe(false); // second one is refused
    expect(bloodedPool(state, 'p1')).toBe(1);
  });

  it('"if four or more friendly operatives … have one of your Blooded tokens, you can select one … under the GAZE OF THE GODS"', () => {
    expect(ruleText(RULE_BLOODED)).toContain('if four or more friendly operatives in the killzone have one of your Blooded tokens');
    const { ctx, state } = setup();
    for (let i = 0; i < 3; i++) gainBloodedToken(state, 'p1', 'test');
    const three = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: BLOODED_GAMBIT }, ctx).state;
    expect(three.effects.some((e) => e.rule === GAZE)).toBe(false); // three is not four
    three.teams.p1.gambitsUsedTP = [];
    gainBloodedToken(three, 'p1', 'test');
    const four = reduce(three, { t: 'UseGambit', player: 'p1', gambitId: BLOODED_GAMBIT }, ctx).state;
    expect(four.effects.filter((e) => e.rule === GAZE)).toHaveLength(1);
  });

  it('GAZE OF THE GODS lasts "until the end of the turning point"', () => {
    expect(ruleText(RULE_BLOODED)).toContain('until the end of the turning point');
    const { state } = setup();
    const op = state.operatives[state.teams.p1.operativeIds[0]!]!;
    setGaze(state, op, 'p1');
    expect(state.effects.find((e) => e.rule === GAZE)!.expiry).toEqual({ kind: 'endOfTurningPoint' });
  });

  it('"its weapons have the Accurate 1 weapon rule" — shooting, fighting AND retaliating', () => {
    expect(ruleText(RULE_BLOODED)).toContain('its weapons have the Accurate 1 weapon rule');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const lasgun = profileOf(CARD.trooper, 'Lasgun');
    const bayonet = profileOf(CARD.trooper, 'Bayonet');
    const has = (p: WeaponProfile, retaliating = false) =>
      effectiveRules(ctx, state, p, { operative: me, target: foe, weaponName: 'w', retaliating }).some(
        (r) => r.id === 'Accurate',
      );
    expect(has(lasgun)).toBe(false);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, me, 'p1');
    expect(has(lasgun)).toBe(true);
    expect(has(bayonet)).toBe(true);
    expect(has(bayonet, true)).toBe(true);
  });

  it('the GAZE promotion is SHOOTING-only, because fight.ts emits no onRollAttack (D-031)', () => {
    expect(REMINDER_ONLY[`${RULE_BLOODED}.gazeCritInFight`]).toContain('D-031');
    const { ctx } = setup();
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    expect(reg.has('onRollAttack')).toBe(true);
  });

  it('an enemy operative with a token gets nothing from MY registration', () => {
    const { ctx, state } = setup();
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, foe, 'p1'); // p1's token, physically on a p2 operative
    const rules = effectiveRules(ctx, state, profileOf(CARD.trooper, 'Lasgun'), { operative: foe, weaponName: 'w' });
    expect(rules.some((r) => r.id === 'Accurate')).toBe(false);
  });

  it('"you can retain one of your normal successes as a result of the Accurate 1 weapon rule as a critical success instead"', () => {
    expect(ruleText(RULE_BLOODED)).toContain('as a critical success instead');
    const { ctx, state } = setup({ roles: [CARD.trooper], script: [1, 1, 1, 1, 1, 1, 1, 1] });
    const me = state.operatives[opWith(state, 'p1', CARD.trooper)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 14, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, me, 'p1');
    setGaze(state, me, 'p1');
    const s = activate(ctx, state, me.id);
    expect(startShoot(ctx, s, s.operatives[me.id]!, 'Lasgun', undefined, foe.id).ok).toBe(true);
    advanceShoot(ctx, s);
    const auto = (s.sequence as ShootSequence).attack.dice.find((d) => !d.rolled);
    expect(auto?.note).toContain('GAZE OF THE GODS');
  });

  it('without the GAZE the Accurate die stays a normal success', () => {
    const { ctx, state } = setup({ roles: [CARD.trooper], script: [1, 1, 1, 1, 1, 1, 1, 1] });
    const me = state.operatives[opWith(state, 'p1', CARD.trooper)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 14, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, me, 'p1');
    const s = activate(ctx, state, me.id);
    startShoot(ctx, s, s.operatives[me.id]!, 'Lasgun', undefined, foe.id);
    advanceShoot(ctx, s);
    const seq = s.sequence as ShootSequence;
    expect(seq.attack.dice.find((d) => !d.rolled)?.state).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
describe('BLOODED strategy ploys', () => {
  it('GLORY KILL: "that shooting, fighting or retaliating operative’s weapons have the Ceaseless weapon rule, or Relentless if it has one of your Blooded tokens"', () => {
    expect(ruleText(SP.gloryKill)).toContain('have the Ceaseless weapon rule, or Relentless if it has one of your Blooded tokens');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const other = state.operatives[state.teams.p2.operativeIds[1]!]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.gloryKill, data: { operativeId: foe.id } }, ctx).state;
    expect(gloryKillTarget(s, 'p1')).toBe(foe.id);
    const bay = profileOf(CARD.trooper, 'Bayonet');
    const vs = (target: OperativeState) =>
      effectiveRules(ctx, s, bay, { operative: me, target, weaponName: 'Bayonet' }).map((r) => r.id);
    expect(vs(foe)).toContain('Ceaseless');
    expect(vs(other)).not.toContain('Ceaseless');
    gainBloodedToken(s, 'p1', 'test');
    assignBloodedToken(s, s.operatives[me.id]!, 'p1');
    expect(vs(foe)).toContain('Relentless');
  });

  it('GLORY KILL lasts "Until the end of the turning point"', () => {
    expect(ruleText(SP.gloryKill)).toContain('Until the end of the turning point');
    const { ctx, state } = setup();
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.gloryKill, data: { operativeId: foe.id } }, ctx).state;
    expect(gloryKillTarget(s, 'p1')).toBe(foe.id);
    s.turningPoint += 1;
    expect(gloryKillTarget(s, 'p1')).toBeUndefined();
  });

  it('RECKLESS ASPIRANT: Accurate 1 without a token, Punishing with one — wholly within the opponent’s territory', () => {
    expect(ruleText(SP.recklessAspirant)).toContain('its weapons have the Accurate 1 weapon rule');
    expect(ruleText(SP.recklessAspirant)).toContain('its weapons have the Punishing weapon rule');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.recklessAspirant }, ctx).state;
    const bay = profileOf(CARD.trooper, 'Bayonet');
    const ids = () => effectiveRules(ctx, s, bay, { operative: s.operatives[me.id]!, target: foe, weaponName: 'Bayonet' }).map((r) => r.id);
    place(s, me.id, 5, 11); // own territory
    expect(ids()).not.toContain('Accurate');
    place(s, me.id, 22, 11); // wholly within the opponent's half (territories split at x=15)
    expect(ids()).toContain('Accurate');
    expect(ids()).not.toContain('Punishing');
    gainBloodedToken(s, 'p1', 'test');
    assignBloodedToken(s, s.operatives[me.id]!, 'p1');
    expect(ids()).toContain('Punishing');
  });

  it('RECKLESS ASPIRANT’s Accurate half is "shooting or fighting", so a retaliation gets nothing', () => {
    expect(ruleText(SP.recklessAspirant)).toContain('is shooting or fighting');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.recklessAspirant }, ctx).state;
    place(s, me.id, 22, 11);
    const bay = profileOf(CARD.trooper, 'Bayonet');
    const retaliating = effectiveRules(ctx, s, bay, { operative: s.operatives[me.id]!, weaponName: 'Bayonet', retaliating: true });
    expect(retaliating.map((r) => r.id)).not.toContain('Accurate');
  });

  it('MALEVOLENT GRIT: "you can re-roll one of your defence dice"', () => {
    expect(ruleText(SP.malevolentGrit)).toContain('you can re-roll one of your defence dice');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.malevolentGrit }, ctx).state;
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    const emit = () =>
      reg.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(foe, s.operatives[me.id]!, profileOf(CARD.trooper, 'Lasgun')),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls;
    place(s, me.id, 5, 11);
    expect(emit().map((g) => g.id)).not.toContain('blooded.malevolentGrit');
    place(s, me.id, 22, 11); // "or is wholly within your opponent's territory"
    expect(emit().map((g) => g.id)).toContain('blooded.malevolentGrit');
  });

  it('BITTER DEMISE: "on a 3 (or 2+ if that friendly operative has one of your Blooded tokens)"', () => {
    expect(ruleText(SP.bitterDemise)).toContain('on a 3 (or 2+ if that friendly operative has one of your Blooded tokens)');
    // D3 = ceil(D6/2): a scripted 4 is a 2, which passes 2+ and fails 3.
    const { ctx, state } = setup({ script: [4] });
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 11.6, 11);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.bitterDemise }, ctx).state;
    gainBloodedToken(s, 'p1', 'test');
    assignBloodedToken(s, s.operatives[me.id]!, 'p1');
    const before = s.operatives[foe.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[me.id]!, 99);
    expect(s.operatives[foe.id]!.wounds).toBe(before - 2);
  });

  it('BITTER DEMISE needs the enemy "visible to and within 2"" of the dying operative', () => {
    expect(ruleText(SP.bitterDemise)).toContain('visible to and within 2" of that friendly operative');
    const { ctx, state } = setup({ script: [6] });
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 18, 11); // far outside 2"
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.bitterDemise }, ctx).state;
    const before = s.operatives[foe.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[me.id]!, 99);
    expect(s.operatives[foe.id]!.wounds).toBe(before);
  });

  it('all four strategy ploys are offered as STRATEGIC GAMBITs when the CP is there', () => {
    const { ctx, state } = setup();
    state.teams.p1.cp = 4;
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    for (const id of Object.values(SP)) expect(ids, id).toContain(id);
    state.teams.p1.cp = 0;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SP.gloryKill);
  });
});

// ---------------------------------------------------------------------------
describe('BLOODED firefight ploys', () => {
  it('CALLOUS DISREGARD: "Having other friendly BLOODED operatives within an enemy operative’s control range doesn’t prevent that enemy operative from being selected"', () => {
    expect(ruleText(FP.callousDisregard)).toContain('doesn’t prevent that enemy operative from being selected');
    const { ctx, state } = setup();
    const shooter = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const screen = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [shooter.id, screen.id, foe.id]);
    place(state, shooter.id, 8, 11);
    place(state, foe.id, 14, 11);
    place(state, screen.id, 14.7, 11); // within the target's control range
    const lasgun = profileOf(CARD.trooper, 'Lasgun');
    const check = () => checkTarget(ctx, state, state.operatives[shooter.id]!, state.operatives[foe.id]!, lasgun, lasgun.rules);
    expect(check().valid).toBe(false);
    expect(check().reason).toContain('control range');
    let s = activate(ctx, state, shooter.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.callousDisregard }, ctx).state;
    expect(checkTarget(ctx, s, s.operatives[shooter.id]!, s.operatives[foe.id]!, lasgun, lasgun.rules).valid).toBe(true);
  });

  it('CALLOUS DISREGARD: "whenever you discard an attack dice as a fail, inflict damage equal to the dice result on one friendly operative"', () => {
    expect(ruleText(FP.callousDisregard)).toContain('inflict damage equal to the dice result on one friendly operative of your choice within control range of the target');
    const { ctx, state } = setup({ script: [1, 1, 1, 1, 6, 6, 6] });
    const shooter = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const screen = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [shooter.id, screen.id, foe.id]);
    place(state, shooter.id, 8, 11);
    place(state, foe.id, 14, 11);
    place(state, screen.id, 14.7, 11);
    let s = activate(ctx, state, shooter.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.callousDisregard }, ctx).state;
    const before = s.operatives[screen.id]!.wounds;
    expect(startShoot(ctx, s, s.operatives[shooter.id]!, 'Autopistol', undefined, foe.id).ok).toBe(true);
    advanceShoot(ctx, s);
    s = settle(ctx, s); // the Command Re-roll offer sits between the attack roll and the defence
    // four scripted 1s are four fails, each inflicting its own result (1) on the screening friend
    expect(s.operatives[screen.id]!.wounds).toBe(before - 4);
  });

  it('MOMENT OF REPUTE: "add 1 to its APL stat" — only for an operative under the GAZE OF THE GODS', () => {
    expect(ruleText(FP.momentOfRepute)).toContain('add 1 to its APL stat');
    const { ctx, state } = setup();
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    let s = activate(ctx, state, me.id);
    const refused = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.momentOfRepute }, ctx);
    expect(refused.ok).toBe(false);
    setGaze(s, s.operatives[me.id]!, 'p1');
    const apl = aplOf(ctx, s, s.operatives[me.id]!);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.momentOfRepute }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[me.id]!)).toBe(apl + 1);
    // "Until the end of that operative's activation" — and never a leaked aplMods entry.
    s = reduce(s, { t: 'EndActivation', operativeId: me.id }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[me.id]!)).toBe(apl);
    expect(s.operatives[me.id]!.aplMods).toEqual([]);
  });

  it('REWARD EARNED: "Use this firefight ploy when an enemy operative is incapacitated by a friendly BLOODED operative within 2" of it that has one of your Blooded tokens. You gain one Blooded token."', () => {
    expect(ruleText(FP.rewardEarned)).toContain('You gain one Blooded token.');
    const { ctx, state } = setup({ weapons: CHIEFTAIN_POWER });
    const killer = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [killer.id, foe.id]);
    place(state, killer.id, 10, 11);
    place(state, foe.id, 11, 11);
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.rewardEarned }, ctx).ok).toBe(false);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, state.operatives[killer.id]!, 'p1');
    expect(startFight(ctx, state, state.operatives[killer.id]!, 'Power weapon', undefined, foe.id).ok).toBe(true);
    inflictDamage(ctx, state, state.operatives[foe.id]!, 99);
    const pool = bloodedPool(state, 'p1');
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.rewardEarned }, ctx);
    expect(out.ok).toBe(true);
    expect(bloodedPool(out.state, 'p1')).toBe(pool + 1);
  });

  it('DARK FAVOUR: "Select one other friendly BLOODED operative visible to and within 3" … to become the valid target … instead"', () => {
    expect(ruleText(FP.darkFavour)).toContain('to become the valid target or to be fought against (as appropriate) instead');
    const { ctx, state } = setup();
    const first = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const shield = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [first.id, shield.id, foe.id]);
    place(state, first.id, 10, 11);
    place(state, shield.id, 12, 11);
    place(state, foe.id, 20, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, state.operatives[first.id]!, 'p1');
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.darkFavour }, ctx).state;
    s = activate(ctx, s, foe.id);
    expect(startShoot(ctx, s, s.operatives[foe.id]!, 'Autopistol', undefined, first.id).ok).toBe(true);
    expect((s.sequence as ShootSequence).targetId).toBe(shield.id);
  });

  it('DARK FAVOUR "has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent weapon rule"', () => {
    expect(ruleText(FP.darkFavour)).toContain('has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent weapon rule');
    const { ctx, state } = setup({ roles: [CARD.gunner] });
    const first = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const shield = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gunner)]!;
    isolate(state, [first.id, shield.id, foe.id]);
    place(state, first.id, 10, 11);
    place(state, shield.id, 12, 11);
    place(state, foe.id, 14, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, state.operatives[first.id]!, 'p1');
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.darkFavour }, ctx).state;
    s = activate(ctx, s, foe.id);
    expect(startShoot(ctx, s, s.operatives[foe.id]!, 'Flamer', undefined, first.id).ok).toBe(true);
    expect((s.sequence as ShootSequence).targetId).toBe(first.id); // Torrent 2" — no effect
  });

  it('DARK FAVOUR’s Fight half is reminder-only — fight.ts emits no target-selection hook', () => {
    expect(ruleText(FP.darkFavour)).toContain('to be fought against');
    expect(REMINDER_ONLY[`${FP.darkFavour}.fight`]).toContain('no seam');
    const { ctx } = setup();
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    expect(reg.has('onSelectTarget')).toBe(true); // the Shoot half is live…
    expect(reg.has('onValidTarget')).toBe(true);
  });

  it('every firefight ploy carries a `usable` window, so the AI cannot spend CP on a dead ploy', () => {
    const ids = blooded.ploys.filter((p) => p.kind === 'firefight').map((p) => p.id);
    expect(ids.sort()).toEqual(Object.values(FP).sort());
    for (const p of blooded.ploys.filter((x) => x.kind === 'firefight')) expect(typeof p.usable, p.id).toBe('function');
  });
});

// ---------------------------------------------------------------------------
describe('BLOODED faction equipment', () => {
  it('CHAOS SIGIL: "The Reward Earned firefight ploy costs you 0CP."', () => {
    expect(ruleText(EQ.chaosSigil)).toContain('costs you 0CP');
    const { ctx, state } = setup({ equipment: [EQ.chaosSigil], weapons: CHIEFTAIN_POWER });
    const killer = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [killer.id, foe.id]);
    place(state, killer.id, 10, 11);
    place(state, foe.id, 11, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, state.operatives[killer.id]!, 'p1');
    expect(startFight(ctx, state, state.operatives[killer.id]!, 'Power weapon', undefined, foe.id).ok).toBe(true);
    inflictDamage(ctx, state, state.operatives[foe.id]!, 99);
    state.teams.p1.cp = 3;
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.rewardEarned }, ctx).state;
    expect(out.teams.p1.cp).toBe(3); // 1CP charged, 1CP refunded
  });

  it('SYMBOLS OF BLOODY WORSHIP: "it regains 1 lost wound" after an activation in which it dealt damage', () => {
    expect(ruleText(EQ.symbolsOfBloodyWorship)).toContain('it regains 1 lost wound');
    const { ctx, state } = setup({ equipment: [EQ.symbolsOfBloodyWorship], weapons: CHIEFTAIN_POWER });
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 11, 11);
    me.wounds = 3;
    let s = activate(ctx, state, me.id);
    expect(startFight(ctx, s, s.operatives[me.id]!, 'Power weapon', undefined, foe.id).ok).toBe(true);
    inflictDamage(ctx, s, s.operatives[foe.id]!, 1);
    s.sequence = null;
    s = reduce(s, { t: 'EndActivation', operativeId: me.id }, ctx).state;
    expect(s.operatives[me.id]!.wounds).toBe(4);
  });

  it('SYMBOLS OF BLOODY WORSHIP gives nothing to an operative that inflicted no damage', () => {
    const { ctx, state } = setup({ equipment: [EQ.symbolsOfBloodyWorship] });
    const me = state.operatives[state.teams.p1.operativeIds[0]!]!;
    me.wounds = 3;
    let s = activate(ctx, state, me.id);
    s = reduce(s, { t: 'EndActivation', operativeId: me.id }, ctx).state;
    expect(s.operatives[me.id]!.wounds).toBe(3);
  });

  it('WICKED BLADES: "Add 1 to both Dmg stats of each friendly BLOODED operative’s bayonet, bayonet & shield and improvised blade"', () => {
    expect(ruleText(EQ.wickedBlades)).toContain('bayonet, bayonet & shield and improvised blade');
    // Applied where the damage is inflicted, never by rewriting the shared profile (D-019).
    const bump = (weapon: string, equipment: string[], datacardId: string = CARD.trooper): number => {
      // The CHIEFTAIN's "chainsword or power weapon" group is asked for by name, so the power
      // weapon it fights with below is really on its card.
      const { ctx, state } = setup({ equipment, roles: [CARD.trooper], weapons: CHIEFTAIN_POWER });
      const me = state.operatives[opWith(state, 'p1', datacardId)]!;
      const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
      isolate(state, [me.id, foe.id]);
      place(state, me.id, 10, 11);
      place(state, foe.id, 11, 11);
      expect(startFight(ctx, state, state.operatives[me.id]!, weapon, undefined, foe.id).ok).toBe(true);
      const reg = new HookRegistry();
      blooded.register(reg, 'p1', ctx);
      return reg.emit('onDamage', state, {
        state,
        ctx: null,
        target: state.operatives[foe.id]!,
        amount: 2,
        kind: 'attack',
      }).amount;
    };
    expect(profileOf(CARD.trooper, 'Bayonet').dmgN).toBe(2); // the shared profile is untouched
    expect(bump('Bayonet', [])).toBe(2);
    expect(bump('Bayonet', [EQ.wickedBlades])).toBe(3);
    // …and only those three weapons: the CHIEFTAIN's power weapon is not one of them.
    expect(bump('Power weapon', [EQ.wickedBlades], CARD.chieftain)).toBe(2);
  });

  it('SINISTER TROPHIES is REMINDER ONLY and registers no handler', () => {
    expect(ruleText(EQ.sinisterTrophies)).toContain('cannot re-roll their attack dice results of 1');
    expect(REMINDER_ONLY[EQ.sinisterTrophies]).toBeDefined();
  });

  it('all four equipment options reach `equipmentDefs` with a faction scope', () => {
    expect(blooded.equipmentDefs.map((e) => e.id).sort()).toEqual(Object.values(EQ).sort());
    expect(blooded.equipmentDefs.every((e) => e.scope === 'faction' && e.teamId === 'blooded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('CHIEFTAIN', () => {
  it('Blooded Icon: "if this operative is within 6" of it, you can regain that token"', () => {
    expect(abilityText(CARD.chieftain, AB.bloodedIcon)).toContain('you can regain that token');
    const { ctx, state } = setup();
    const chief = state.operatives[opWith(state, 'p1', CARD.chieftain)]!;
    const mate = state.operatives[state.teams.p1.operativeIds[1]!]!;
    isolate(state, [chief.id, mate.id]);
    place(state, chief.id, 10, 11);
    place(state, mate.id, 13, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, mate, 'p1');
    expect(bloodedPool(state, 'p1')).toBe(0);
    inflictDamage(ctx, state, state.operatives[mate.id]!, 99);
    // one token back from Blooded Icon + one from "a friendly operative is incapacitated"? the
    // friendly is nowhere near an enemy, so only Blooded Icon fires.
    expect(bloodedPool(state, 'p1')).toBe(1);
    expect(hasBloodedToken(state, mate.id, 'p1')).toBe(false);
  });

  it('Blooded Icon is "Once per turning point"', () => {
    expect(abilityText(CARD.chieftain, AB.bloodedIcon)).toContain('Once per turning point');
    const { ctx, state } = setup();
    const chief = state.operatives[opWith(state, 'p1', CARD.chieftain)]!;
    const a = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const b = state.operatives[state.teams.p1.operativeIds[2]!]!;
    isolate(state, [chief.id, a.id, b.id]);
    place(state, chief.id, 10, 11);
    place(state, a.id, 11.5, 11);
    place(state, b.id, 13, 11);
    for (let i = 0; i < 2; i++) gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, a, 'p1');
    assignBloodedToken(state, b, 'p1');
    inflictDamage(ctx, state, state.operatives[a.id]!, 99);
    inflictDamage(ctx, state, state.operatives[b.id]!, 99);
    expect(bloodedPool(state, 'p1')).toBe(1);
  });

  it('Lead With Strength: "treat it as if it’s under the GAZE OF THE GODS"', () => {
    expect(abilityText(CARD.chieftain, AB.leadWithStrength)).toContain('treat it as if it’s under the GAZE OF THE GODS');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const chief = state.operatives[opWith(state, 'p1', CARD.chieftain)]!;
    place(state, chief.id, 5, 11); // own territory, no token
    expect(gazeFor(T, state, chief)).toBe(false);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, chief, 'p1');
    expect(gazeFor(T, state, chief)).toBe(true);
  });

  it('Lead With Strength also fires "wholly within your opponent’s territory"', () => {
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const chief = state.operatives[opWith(state, 'p1', CARD.chieftain)]!;
    place(state, chief.id, 22, 11);
    expect(gazeFor(T, state, chief)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('BRIMSTONE GRENADIER', () => {
  it('Grenadier: "This operative can use frag and krak grenades" without the equipment', () => {
    expect(abilityText(CARD.brimstone, AB.grenadier)).toContain('can use frag and krak grenades');
    const { ctx, state } = setup({ roles: [CARD.brimstone] });
    const g = state.operatives[opWith(state, 'p1', CARD.brimstone)]!;
    const s = activate(ctx, state, g.id);
    const names = (s.operatives[g.id] as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(names.map((w) => w.name).sort()).toEqual(['Frag grenade', 'Krak grenade']);
  });

  it('Grenadier: "improve the Hit stat of that weapon by 1"', () => {
    expect(abilityText(CARD.brimstone, AB.grenadier)).toContain('improve the Hit stat of that weapon by 1');
    const { ctx, state } = setup({ roles: [CARD.brimstone] });
    const g = state.operatives[opWith(state, 'p1', CARD.brimstone)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [g.id, foe.id]);
    place(state, g.id, 10, 11);
    place(state, foe.id, 13, 11);
    let s = activate(ctx, state, g.id);
    const frag = (s.operatives[g.id] as OperativeState & { grantedWeapons?: { name: string; profiles: WeaponProfile[] }[] })
      .grantedWeapons!.find((w) => w.name === 'Frag grenade')!;
    const base = hitOf(ctx, s, s.operatives[g.id]!, frag.profiles[0]!);
    startShoot(ctx, s, s.operatives[g.id]!, 'Frag grenade', undefined, foe.id);
    const improved = hitOf(ctx, s, s.operatives[g.id]!, frag.profiles[0]!);
    expect(improved).toBe(base - 1);
    s = settle(ctx, s);
  });

  it('Explosive Demise: "roll two D6, or one D6 if this operative is within control range of an enemy operative"', () => {
    expect(abilityText(CARD.brimstone, AB.explosiveDemise)).toContain('roll two D6, or one D6 if this operative is within control range of an enemy operative');
    const { ctx, state } = setup({ roles: [CARD.brimstone], script: [4, 1, 3] });
    const g = state.operatives[opWith(state, 'p1', CARD.brimstone)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [g.id, foe.id]);
    place(state, g.id, 10, 11);
    place(state, foe.id, 12.4, 11); // within 2", NOT within control range
    const before = state.operatives[foe.id]!.wounds;
    inflictDamage(ctx, state, state.operatives[g.id]!, 99);
    // 2D6 = [4,1] → a 4+ → the diabolyk bomb is unused → D6+2 = 3+2 = 5
    expect(state.operatives[foe.id]!.wounds).toBe(before - 5);
    expect(state.rolls.some((r) => r.kind === 'explosiveDemise' && r.results.length === 2)).toBe(true);
  });

  it('Explosive Demise rolls ONE D6 while within control range of an enemy operative', () => {
    const { ctx, state } = setup({ roles: [CARD.brimstone], script: [5, 6] });
    const g = state.operatives[opWith(state, 'p1', CARD.brimstone)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [g.id, foe.id]);
    place(state, g.id, 10, 11);
    place(state, foe.id, 10.9, 11); // inside control range
    inflictDamage(ctx, state, state.operatives[g.id]!, 99);
    const rolled = state.rolls.filter((r) => r.kind === 'explosiveDemise');
    expect(rolled[0]!.results).toHaveLength(1);
  });

  it('Explosive Demise inflicts nothing when neither D6 is a 4+', () => {
    const { ctx, state } = setup({ roles: [CARD.brimstone], script: [1, 2] });
    const g = state.operatives[opWith(state, 'p1', CARD.brimstone)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [g.id, foe.id]);
    place(state, g.id, 10, 11);
    place(state, foe.id, 12.4, 11);
    const before = state.operatives[foe.id]!.wounds;
    inflictDamage(ctx, state, state.operatives[g.id]!, 99);
    expect(state.operatives[foe.id]!.wounds).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('BUTCHER', () => {
  it('Unholy Sustenance: "it regains up to D3 lost wounds" when it incapacitates the enemy in that sequence', () => {
    expect(abilityText(CARD.butcher, AB.unholySustenance)).toContain('it regains up to D3 lost wounds');
    const { ctx, state } = setup({ roles: [CARD.butcher], script: [5] });
    const b = state.operatives[opWith(state, 'p1', CARD.butcher)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [b.id, foe.id]);
    place(state, b.id, 10, 11);
    place(state, foe.id, 11, 11);
    b.wounds = 2;
    startFight(ctx, state, b, 'Power weapon & cleaver', undefined, foe.id);
    inflictDamage(ctx, state, state.operatives[foe.id]!, 99);
    expect(state.operatives[b.id]!.wounds).toBe(5); // D3 of a scripted 5 is 3
  });

  it('Blood Offering: "the first time you strike with a critical success during that sequence, you gain one Blooded token"', () => {
    expect(abilityText(CARD.butcher, AB.bloodOffering)).toContain('you gain one Blooded token');
    const { ctx, state } = setup({ roles: [CARD.butcher] });
    const b = state.operatives[opWith(state, 'p1', CARD.butcher)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [b.id, foe.id]);
    place(state, b.id, 10, 11);
    place(state, foe.id, 11, 11);
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    startFight(ctx, state, b, 'Power weapon & cleaver', undefined, foe.id);
    const cleaver = profileOf(CARD.butcher, 'Power weapon & cleaver');
    const fire = () =>
      reg.emit('onStrikeResolved', state, {
        state,
        ctx: attackCtx(b, foe, cleaver, { type: 'melee' }),
        crit: true,
        struck: foe,
      });
    fire();
    expect(bloodedPool(state, 'p1')).toBe(1);
    fire(); // "the FIRST time … during that sequence"
    expect(bloodedPool(state, 'p1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('CORPSEMAN', () => {
  it('the three STIMM rules are sliced out of the one printed ability, never retyped', () => {
    for (const rule of STIMM_RULES) expect(abilityText(CARD.corpseman, AB.stimmRules)).toContain(stimmText(rule));
    expect(stimmText('Rejuvenated')).toContain('2D3 lost wounds');
    expect(stimmText('Enraged')).toContain('Relentless weapon rule');
    expect(stimmText('Fortified')).toContain('on a 5+, subtract 1 from that inflicted damage');
  });

  it('Enraged: "The operative’s melee weapons have the Relentless weapon rule."', () => {
    const { ctx, state } = setup({ roles: [CARD.corpseman] });
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const bay = profileOf(CARD.trooper, 'Bayonet');
    const ids = () => effectiveRules(ctx, state, bay, { operative: me, weaponName: 'Bayonet' }).map((r) => r.id);
    expect(ids()).not.toContain('Relentless');
    giveStimm(state, me, 'Enraged', 'p1');
    expect(ids()).toContain('Relentless');
    // …and not to its ranged weapons.
    const lasgun = profileOf(CARD.trooper, 'Lasgun');
    expect(effectiveRules(ctx, state, lasgun, { operative: me, weaponName: 'Lasgun' }).map((r) => r.id)).not.toContain('Relentless');
  });

  it('Fortified: "roll one D6: on a 5+, subtract 1 from that inflicted damage"', () => {
    const { ctx, state } = setup({ roles: [CARD.corpseman], script: [5] });
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 10, 11);
    place(state, foe.id, 11, 11);
    giveStimm(state, me, 'Fortified', 'p1');
    const club = profileOf(CARD.thug, 'Heavy club'); // Normal Dmg 4
    startFight(ctx, state, foe, 'Bayonet', undefined, me.id);
    const before = state.operatives[me.id]!.wounds;
    inflictDamage(ctx, state, state.operatives[me.id]!, club.dmgN, 'attack');
    expect(before - state.operatives[me.id]!.wounds).toBeLessThanOrEqual(club.dmgN);
  });

  it('Regular Dosage: the deterministic default hands one other operative a STIMM rule at deployment', () => {
    expect(abilityText(CARD.corpseman, AB.regularDosage)).toContain('(excluding Rejuvenated)');
    const { ctx, state } = setup({ roles: [CARD.corpseman] });
    const s = activate(ctx, state, opWith(state, 'p1', CARD.corpseman));
    const stimmed = s.teams.p1.operativeIds.filter((id) => hasStimm(s, id, 'Enraged'));
    expect(stimmed).toHaveLength(1);
    expect(s.operatives[stimmed[0]!]!.datacardId).not.toBe(CARD.corpseman);
  });

  it('STIMMS: "You cannot select each STIMM rule for each operative more than once per battle."', () => {
    expect(actionOf(CARD.corpseman, ACT.stimms).text).toContain('more than once per battle');
    const { state } = setup({ roles: [CARD.corpseman] });
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    expect(stimmTaken(state, me.id, 'Fortified')).toBe(false);
    giveStimm(state, me, 'Fortified', 'p1');
    expect(stimmTaken(state, me.id, 'Fortified')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ENFORCER', () => {
  it('Gruelling Disciplinarian: "you can ignore any changes to that operative’s stats from being injured"', () => {
    expect(abilityText(CARD.enforcer, AB.gruellingDisciplinarian)).toContain('ignore any changes to that operative’s stats from being injured');
    const { ctx, state } = setup({ roles: [CARD.enforcer] });
    const enf = state.operatives[opWith(state, 'p1', CARD.enforcer)]!;
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    isolate(state, [enf.id, me.id]);
    place(state, enf.id, 10, 11);
    place(state, me.id, 13, 11);
    me.wounds = 1; // injured
    const lasgun = profileOf(cardOf(me.datacardId).id, cardOf(me.datacardId).weapons[0]!.name);
    expect(moveOf(ctx, state, me)).toBe(4);
    expect(hitOf(ctx, state, me, lasgun)).toBe(lasgun.hit + 1);
    const s = activate(ctx, state, me.id);
    expect(moveOf(ctx, s, s.operatives[me.id]!)).toBe(cardOf(me.datacardId).move);
    expect(hitOf(ctx, s, s.operatives[me.id]!, lasgun)).toBe(lasgun.hit);
  });

  it('Gruelling Disciplinarian needs the ENFORCER "within 6"', () => {
    const { ctx, state } = setup({ roles: [CARD.enforcer] });
    const enf = state.operatives[opWith(state, 'p1', CARD.enforcer)]!;
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    isolate(state, [enf.id, me.id]);
    place(state, enf.id, 3, 3);
    place(state, me.id, 20, 20);
    me.wounds = 1;
    const s = activate(ctx, state, me.id);
    expect(moveOf(ctx, s, s.operatives[me.id]!)).toBe(4);
  });

  it('ENFORCE: "That operative can immediately perform a 1AP action for free, but it cannot move more than 2" during that action."', () => {
    expect(actionOf(CARD.enforcer, ACT.enforce).text).toContain('it cannot move more than 2" during that action');
    const { ctx, state } = setup({ roles: [CARD.enforcer] });
    const enf = state.operatives[opWith(state, 'p1', CARD.enforcer)]!;
    const me = state.operatives[state.teams.p1.operativeIds[1]!]!;
    isolate(state, [enf.id, me.id]);
    place(state, enf.id, 10, 11);
    place(state, me.id, 12, 11);
    let s = activate(ctx, state, enf.id);
    const out = act(ctx, s, enf.id, ACT.enforce, { targetOperativeId: me.id });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(aplOf(ctx, s, s.operatives[me.id]!)).toBe(cardOf(me.datacardId).apl + 1);
  });

  it('ENFORCE: "If the selected friendly operative is a COMMSMAN, it cannot perform the Sacrilegious Actuation or Signal actions."', () => {
    expect(actionOf(CARD.enforcer, ACT.enforce).text).toContain('it cannot perform the Sacrilegious Actuation or Signal actions');
    const { ctx, state } = setup({ roles: [CARD.enforcer, CARD.commsman] });
    const enf = state.operatives[opWith(state, 'p1', CARD.enforcer)]!;
    const comms = state.operatives[opWith(state, 'p1', CARD.commsman)]!;
    const mate = state.operatives[state.teams.p1.operativeIds.find((id) => id !== enf.id && id !== comms.id)!]!;
    isolate(state, [enf.id, comms.id, mate.id]);
    place(state, enf.id, 10, 11);
    place(state, comms.id, 12, 11);
    place(state, mate.id, 13.5, 11);
    let s = activate(ctx, state, enf.id);
    s = act(ctx, s, enf.id, ACT.enforce, { targetOperativeId: comms.id }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: enf.id }, ctx).state;
    s = activate(ctx, s, comms.id);
    const target = s.operatives[comms.id]!;
    target.apSpent = cardOf(CARD.commsman).apl; // now spending the free AP
    gainBloodedToken(s, 'p1', 'test');
    assignBloodedToken(s, target, 'p1');
    const refused = act(ctx, s, comms.id, ACT.sacrilegiousActuation, {});
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('ENFORCE');
  });
});

// ---------------------------------------------------------------------------
describe('FLENSER', () => {
  it('Stalk: "if Light or Heavy terrain is within its control range, this weapon has the Lethal 5+ weapon rule"', () => {
    expect(abilityText(CARD.flenser, AB.stalk)).toContain('this weapon has the Lethal 5+ weapon rule');
    const map = testMap({ features: [heavyBlock('wall', 12, 10, 1, 2, 2)] });
    const { ctx, state } = setup({ roles: [CARD.flenser], map });
    const f = state.operatives[opWith(state, 'p1', CARD.flenser)]!;
    const blades = profileOf(CARD.flenser, 'Skinning blades');
    const lethal = () =>
      effectiveRules(ctx, state, blades, { operative: state.operatives[f.id]!, weaponName: 'Skinning blades' }).some(
        (r) => r.id === 'Lethal',
      );
    place(state, f.id, 5, 5);
    expect(lethal()).toBe(false);
    place(state, f.id, 11.2, 11);
    expect(lethal()).toBe(true);
  });

  it('Wretched: "This operative can perform the Charge action while it has a Conceal order."', () => {
    expect(abilityText(CARD.flenser, AB.wretched)).toContain('can perform the Charge action while it has a Conceal order');
    const def = getAction(CHARGE_WRETCHED)!;
    expect(def.treatedAs).toBe('Charge');
    const { ctx, state } = setup({ roles: [CARD.flenser] });
    const f = state.operatives[opWith(state, 'p1', CARD.flenser)]!;
    const other = state.operatives[state.teams.p1.operativeIds[1]!]!;
    expect(def.available!(ctx, state, f)).toBe(true);
    expect(def.available!(ctx, state, other)).toBe(false);
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [f.id, foe.id]);
    place(state, f.id, 10, 11);
    place(state, foe.id, 13, 11);
    const s = activate(ctx, state, f.id, 'conceal');
    expect(getAction('Charge')!.check(ctx, s, s.operatives[f.id]!, { path: { points: [{ x: 12.2, y: 11 }] } }).ok).toBe(false);
    expect(def.check(ctx, s, s.operatives[f.id]!, { path: { points: [{ x: 12.2, y: 11 }] } }).ok).toBe(true);
  });

  it('Wretched: "you can strike the enemy operative in that sequence with one of your unresolved successes"', () => {
    expect(abilityText(CARD.flenser, AB.wretched)).toContain('with one of your unresolved successes before this operative is removed from the killzone');
    // The enemy CHIEFTAIN does the fighting, so its "chainsword or power weapon" group is asked
    // for by name.
    const { ctx, state } = setup({ roles: [CARD.flenser], weapons: CHIEFTAIN_POWER });
    const f = state.operatives[opWith(state, 'p1', CARD.flenser)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [f.id, foe.id]);
    place(state, f.id, 10, 11);
    place(state, foe.id, 11, 11);
    expect(startFight(ctx, state, state.operatives[foe.id]!, 'Power weapon', undefined, f.id).ok).toBe(true);
    const seq = state.sequence as FightSequence;
    addRolled(seq.defenderPool, [6], 3); // the FLENSER holds one unresolved critical success
    const before = state.operatives[foe.id]!.wounds;
    inflictDamage(ctx, state, state.operatives[f.id]!, 99);
    expect(state.operatives[foe.id]!.wounds).toBe(before - profileOf(CARD.flenser, 'Skinning blades').dmgC);
  });
});

// ---------------------------------------------------------------------------
describe('OGRYN', () => {
  it('Avalanche of Muscle: "you can inflict D3 damage on one enemy operative within its control range"', () => {
    expect(abilityText(CARD.ogryn, AB.avalancheOfMuscle)).toContain('inflict D3 damage on one enemy operative within its control range');
    const { ctx, state } = setup({ roles: [CARD.ogryn], script: [6] });
    const o = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [o.id, foe.id]);
    place(state, o.id, 10, 11);
    place(state, foe.id, 14, 11);
    let s = activate(ctx, state, o.id);
    const charged = act(ctx, s, o.id, 'Charge', { path: { points: [{ x: 13, y: 11 }] } });
    expect(charged.ok).toBe(true);
    s = charged.state;
    const before = s.operatives[foe.id]!.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: o.id }, ctx).state;
    expect(s.operatives[foe.id]!.wounds).toBe(before - 3);
  });

  it('Chem-enhanced: "You can ignore any changes to this operative’s APL stat"', () => {
    expect(abilityText(CARD.ogryn, AB.chemEnhanced)).toContain('ignore any changes to this operative’s APL stat');
    const { ctx, state } = setup({ roles: [CARD.ogryn] });
    const o = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const base = cardOf(CARD.ogryn).apl;
    o.aplMods.push(-1);
    expect(aplOf(ctx, state, o)).toBe(base);
    o.aplMods.push(1);
    expect(aplOf(ctx, state, o)).toBe(base);
  });

  it('Chem-enhanced: "it’s not affected by enemy operatives’ Shock and Stun weapon rules"', () => {
    expect(abilityText(CARD.ogryn, AB.chemEnhanced)).toContain('not affected by enemy operatives’ Shock and Stun weapon rules');
    const { ctx, state } = setup({ roles: [CARD.ogryn] });
    const o = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.ogryn)] ?? state.operatives[state.teams.p2.operativeIds[0]!]!;
    const maul = profileOf(CARD.ogryn, 'Power maul & mutant claw'); // Rending, Shock
    expect(maul.rules.map((r) => r.id)).toContain('Shock');
    const ids = effectiveRules(ctx, state, maul, { operative: foe, target: o, weaponName: 'Power maul & mutant claw' }).map((r) => r.id);
    expect(ids).not.toContain('Shock');
    expect(ids).toContain('Rending');
  });

  it('Brute: a Conceal-order OGRYN "cannot use Light terrain for cover" but "doesn’t remove its cover save"', () => {
    expect(abilityText(CARD.ogryn, AB.brute)).toContain('it cannot use Light terrain for cover');
    expect(abilityText(CARD.ogryn, AB.brute)).toContain('it doesn’t remove its cover save (if any)');
    const map = testMap({
      features: [
        {
          id: 'light',
          kind: 'test.light',
          label: 'LIGHT',
          placement: { x: 12.8, y: 10.2, rotDeg: 0, flip: false },
          parts: [
            {
              id: 'light.body',
              featureId: 'light',
              poly: [
                { x: 12.8, y: 10.2 },
                { x: 13.3, y: 10.2 },
                { x: 13.3, y: 11.8 },
                { x: 12.8, y: 11.8 },
              ],
              z0: 0,
              z1: 0.6,
              types: ['Light'],
              role: 'wall',
            },
          ],
        },
      ],
    });
    const { ctx, state } = setup({ roles: [CARD.ogryn], map });
    const o = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [o.id, foe.id]);
    place(state, o.id, 12, 11);
    place(state, foe.id, 20, 11);
    o.order = 'conceal';
    const lasgun = profileOf(CARD.trooper, 'Lasgun');
    const check = checkTarget(ctx, state, state.operatives[foe.id]!, state.operatives[o.id]!, lasgun, lasgun.rules);
    expect(check.valid).toBe(true); // Light cover no longer denies the shot
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    state.sequence = {
      kind: 'shoot',
      step: 'rollDefence',
      attackerId: foe.id,
      targetId: o.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Lasgun',
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
    } as ShootSequence;
    const ev = reg.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(state.operatives[foe.id]!, state.operatives[o.id]!, lasgun),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.coverSave).toBe(true);
  });

  it('Slow-witted: "You must spend 1 additional AP … (excluding Operate Hatch)"', () => {
    expect(abilityText(CARD.ogryn, AB.slowWitted)).toContain('excluding Operate Hatch');
    const { ctx, state } = setup({ roles: [CARD.ogryn] });
    const o = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const other = state.operatives[state.teams.p1.operativeIds[1]!]!;
    const pickUp = getAction('Pick Up Marker')!;
    const hatch = getAction('Operate Hatch')!;
    expect(actionCost(ctx, state, o, pickUp)).toBe(pickUp.ap + 1);
    expect(actionCost(ctx, state, other, pickUp)).toBe(pickUp.ap);
    expect(actionCost(ctx, state, o, hatch)).toBe(hatch.ap);
  });
});

// ---------------------------------------------------------------------------
describe('SHARPSHOOTER', () => {
  it('Camo Cloak: "you can retain one additional cover save"', () => {
    expect(abilityText(CARD.sharpshooter, AB.camoCloak)).toContain('you can retain one additional cover save');
    const { ctx, state } = setup({ roles: [CARD.sharpshooter] });
    const sniper = state.operatives[opWith(state, 'p1', CARD.sharpshooter)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    const emit = (coverSave: boolean) =>
      reg.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(foe, sniper, profileOf(CARD.trooper, 'Lasgun')),
        count: 3,
        coverSave,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).extraCoverSaves;
    expect(emit(false)).toBe(0); // "if you can retain any cover saves"
    expect(emit(true)).toBe(1);
  });

  it('A Name Whispered In Blood: "STRATEGIC GAMBIT in the first turning point"', () => {
    expect(abilityText(CARD.sharpshooter, AB.whisperedInBlood)).toContain('STRATEGIC GAMBIT in the first turning point');
    const { ctx, state } = setup({ roles: [CARD.sharpshooter] });
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(WHISPER_GAMBIT);
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(WHISPER_GAMBIT);
  });

  it('A Name Whispered In Blood: "treat this operative as if it has one of your Blooded tokens and is under the GAZE OF THE GODS"', () => {
    expect(abilityText(CARD.sharpshooter, AB.whisperedInBlood)).toContain('treat this operative as if it has one of your Blooded tokens and is under the GAZE OF THE GODS');
    const { ctx, state } = setup({ roles: [CARD.sharpshooter] });
    const T = hooksFor(ctx, 'p1');
    const sniper = state.operatives[opWith(state, 'p1', CARD.sharpshooter)]!;
    const marked = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const other = state.operatives[state.teams.p2.operativeIds[1]!]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: WHISPER_GAMBIT, data: { operativeId: marked.id } }, ctx).state;
    expect(whisperedTarget(s, 'p1')).toBe(marked.id);
    expect(tokenFor(T, s, s.operatives[sniper.id]!, marked)).toBe(true);
    expect(gazeFor(T, s, s.operatives[sniper.id]!, marked)).toBe(true);
    expect(tokenFor(T, s, s.operatives[sniper.id]!, other)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('THUG, TRENCH SWEEPER and TROOPER', () => {
  it('Tough: "Normal Dmg of 3 or more inflicts 1 less damage on it"', () => {
    expect(abilityText(CARD.thug, AB.tough)).toContain('Normal Dmg of 3 or more inflicts 1 less damage on it');
    const { ctx, state } = setup({ roles: [CARD.thug] });
    const thug = state.operatives[opWith(state, 'p1', CARD.thug)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.thug)] ?? state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [thug.id, foe.id]);
    place(state, thug.id, 10, 11);
    place(state, foe.id, 11, 11);
    startFight(ctx, state, state.operatives[foe.id]!, 'Heavy club', undefined, thug.id); // Normal Dmg 4
    const club = profileOf(CARD.thug, 'Heavy club');
    const before = state.operatives[thug.id]!.wounds;
    inflictDamage(ctx, state, state.operatives[thug.id]!, club.dmgN, 'attack');
    expect(before - state.operatives[thug.id]!.wounds).toBe(club.dmgN - 1);
  });

  it('Shield: "each of your blocks can be allocated to block two unresolved successes (instead of one)"', () => {
    expect(abilityText(CARD.trenchSweeper, AB.shield)).toContain('block two unresolved successes (instead of one)');
    const { ctx, state } = setup({ roles: [CARD.trenchSweeper] });
    const ts = state.operatives[opWith(state, 'p1', CARD.trenchSweeper)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    const shieldProfile = profileOf(CARD.trenchSweeper, 'Bayonet & shield');
    const ev = reg.emit('onBlockAllocation', state, {
      state,
      ctx: attackCtx(ts, foe, shieldProfile, { type: 'melee', rules: shieldProfile.rules }),
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev.blocks).toBe(2);
  });

  it('Shielding: "Subtract 2" from its Move stat" and a defence re-roll, taken on the printed activation', () => {
    expect(abilityText(CARD.trenchSweeper, AB.shielding)).toContain('Subtract 2" from its Move stat');
    const { ctx, state } = setup({ roles: [CARD.trenchSweeper] });
    const ts = state.operatives[opWith(state, 'p1', CARD.trenchSweeper)]!;
    isolate(state, [ts.id]);
    place(state, ts.id, 10, 11);
    for (const id of state.teams.p2.operativeIds) place(state, id, 28, 20); // nothing within reach
    const s = activate(ctx, state, ts.id);
    expect(moveOf(ctx, s, s.operatives[ts.id]!)).toBe(Math.max(4, cardOf(CARD.trenchSweeper).move - 2));
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    const ev = reg.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[state.teams.p2.operativeIds[0]!]!, s.operatives[ts.id]!, profileOf(CARD.trooper, 'Lasgun')),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.rerolls.map((g) => g.id)).toContain('blooded.shielding');
  });

  it('Shielding is NOT taken when an enemy is inside the operative’s Charge reach', () => {
    const { ctx, state } = setup({ roles: [CARD.trenchSweeper] });
    const ts = state.operatives[opWith(state, 'p1', CARD.trenchSweeper)]!;
    isolate(state, [ts.id]);
    place(state, ts.id, 10, 11);
    place(state, state.teams.p2.operativeIds[0]!, 13, 11);
    const s = activate(ctx, state, ts.id);
    expect(moveOf(ctx, s, s.operatives[ts.id]!)).toBe(cardOf(CARD.trenchSweeper).move);
  });

  it('Group Activation records the pairing: "you must then activate one other ready friendly BLOODED TROOPER operative"', () => {
    expect(abilityText(CARD.trooper, AB.groupActivation)).toContain('you must then activate one other ready friendly BLOODED TROOPER operative');
    const { ctx, state } = setup({ roles: [CARD.trooper] });
    const troopers = state.teams.p1.operativeIds.filter((id) => state.operatives[id]!.datacardId === CARD.trooper);
    expect(troopers.length).toBeGreaterThanOrEqual(1);
    const extra = state.teams.p1.operativeIds.find((id) => id !== troopers[0]!)!;
    state.operatives[extra]!.datacardId = CARD.trooper;
    let s = activate(ctx, state, troopers[0]!);
    s = reduce(s, { t: 'EndActivation', operativeId: troopers[0]! }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'blooded.groupActivation' && e.operativeId === extra)).toBe(true);
    expect(REMINDER_ONLY[`${AB.groupActivation}.order`]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('COMMSMAN unique actions', () => {
  it('SIGNAL: "add 1 to its APL stat" for one other BLOODED operative "(excluding OGRYN)"', () => {
    expect(actionOf(CARD.commsman, ACT.signal).text).toContain('(excluding OGRYN)');
    const { ctx, state } = setup({ roles: [CARD.commsman, CARD.ogryn] });
    const comms = state.operatives[opWith(state, 'p1', CARD.commsman)]!;
    const ogryn = state.operatives[opWith(state, 'p1', CARD.ogryn)]!;
    const mate = state.operatives[state.teams.p1.operativeIds.find((id) => id !== comms.id && id !== ogryn.id)!]!;
    isolate(state, [comms.id, ogryn.id, mate.id]);
    place(state, comms.id, 10, 11);
    place(state, ogryn.id, 12, 11);
    place(state, mate.id, 13, 11);
    const def = getAction(ACT.signal)!;
    expect(def.check(ctx, state, comms, { targetOperativeId: ogryn.id }).ok).toBe(true); // falls back to a legal target
    let s = activate(ctx, state, comms.id);
    const before = aplOf(ctx, s, s.operatives[mate.id]!);
    s = act(ctx, s, comms.id, ACT.signal, { targetOperativeId: mate.id }).state;
    expect(aplOf(ctx, s, s.operatives[mate.id]!)).toBe(before + 1);
    expect(s.operatives[mate.id]!.aplMods).toEqual([]); // rides onStatMod, never aplMods
  });

  it('SACRILEGIOUS ACTUATION: "You gain one Blooded token" — refused without a token of your own', () => {
    expect(actionOf(CARD.commsman, ACT.sacrilegiousActuation).text).toContain('if it doesn’t have one of your Blooded tokens');
    const { ctx, state } = setup({ roles: [CARD.commsman] });
    const comms = state.operatives[opWith(state, 'p1', CARD.commsman)]!;
    isolate(state, [comms.id]);
    place(state, comms.id, 10, 11);
    let s = activate(ctx, state, comms.id);
    expect(act(ctx, s, comms.id, ACT.sacrilegiousActuation, {}).ok).toBe(false);
    gainBloodedToken(s, 'p1', 'test');
    assignBloodedToken(s, s.operatives[comms.id]!, 'p1');
    const out = act(ctx, s, comms.id, ACT.sacrilegiousActuation, {});
    expect(out.ok).toBe(true);
    expect(bloodedPool(out.state, 'p1')).toBe(1);
  });

  it('both COMMSMAN actions are refused "while within control range of an enemy operative"', () => {
    for (const id of [ACT.signal, ACT.sacrilegiousActuation])
      expect(actionOf(CARD.commsman, id).text).toContain('cannot perform this action while within control range of an enemy operative');
    const { ctx, state } = setup({ roles: [CARD.commsman] });
    const comms = state.operatives[opWith(state, 'p1', CARD.commsman)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    isolate(state, [comms.id, foe.id]);
    place(state, comms.id, 10, 11);
    place(state, foe.id, 10.7, 11);
    gainBloodedToken(state, 'p1', 'test');
    assignBloodedToken(state, comms, 'p1');
    expect(getAction(ACT.sacrilegiousActuation)!.check(ctx, state, comms, {}).ok).toBe(false);
    expect(getAction(ACT.signal)!.check(ctx, state, comms, {}).ok).toBe(false);
  });

  it('STIMMS: "Select one friendly BLOODED operative within this operative’s control range"', () => {
    expect(actionOf(CARD.corpseman, ACT.stimms).text).toContain('within this operative’s control range');
    const { ctx, state } = setup({ roles: [CARD.corpseman] });
    const corp = state.operatives[opWith(state, 'p1', CARD.corpseman)]!;
    const mate = state.operatives[state.teams.p1.operativeIds.find((id) => id !== corp.id)!]!;
    isolate(state, [corp.id, mate.id]);
    place(state, corp.id, 10, 11);
    place(state, mate.id, 10.7, 11);
    mate.wounds = 1;
    let s = activate(ctx, state, corp.id);
    const out = act(ctx, s, corp.id, ACT.stimms, { targetOperativeId: mate.id, choice: 'Rejuvenated' });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mate.id]!.wounds).toBeGreaterThan(1);
    expect(stimmTaken(out.state, mate.id, 'Rejuvenated')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('rare weapon rules', () => {
  it('all three resolve against THIS team’s printed datacard abilities (D-033)', () => {
    expect(rareWeaponRuleText('BloodOffering', 'blooded')).toBe(abilityText(CARD.butcher, AB.bloodOffering));
    expect(rareWeaponRuleText('Shield', 'blooded')).toBe(abilityText(CARD.trenchSweeper, AB.shield));
    expect(rareWeaponRuleText('Stalk', 'blooded')).toBe(abilityText(CARD.flenser, AB.stalk));
  });

  it('the Blooded Shield text is the same rule the Imperial Navy Breachers print', () => {
    expect(abilityText(CARD.trenchSweeper, AB.shield)).toContain('block two unresolved successes');
  });
});

// ---------------------------------------------------------------------------
describe('BLOODED selection', () => {
  it('the printed default roster is legal and fields 12 operatives across the three groups', () => {
    const picks = defaultRoster(DATA);
    const v = validateRosterFor(DATA, picks);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(picks).toHaveLength(12);
  });

  it('`defaultRoster` never fields the SHARPSHOOTER, TRENCH SWEEPER or TROOPER (D-042)', () => {
    // First-legal-row-wins in printed order. The ^1 cap fills on the flamer, grenade-launcher and
    // meltagun GUNNER rows, so the plasma GUNNER (^1,2) and the SHARPSHOOTER (^1) are both skipped
    // and the THUG takes the last slot of the second group — the GUNNER datacard is still fielded.
    const fielded = new Set(defaultRoster(DATA).map((p) => p.datacardId));
    expect([...DATA.datacards.map((c) => c.id)].filter((id) => !fielded.has(id)).sort()).toEqual([
      CARD.sharpshooter,
      CARD.trenchSweeper,
      CARD.trooper,
    ].sort());
    expect(fielded.has(CARD.thug)).toBe(true);
  });

  it('"Other than TROOPER operatives, your kill team can only include each operative on this list once"', () => {
    expect(DATA.selection.rawText).toContain('Other than TROOPER operatives, your kill team can only include each operative on this list once.');
    const twoThugs = [
      { datacardId: CARD.chieftain, entryId: 'blooded.sel0.chieftain', loadoutIds: ['blooded.g1.opt1'] },
      ...Array.from({ length: 9 }, () => ({ datacardId: CARD.thug, entryId: 'blooded.sel11.thug' })),
      { datacardId: CARD.enforcer, entryId: 'blooded.sel14.enforcer' },
      { datacardId: CARD.ogryn, entryId: 'blooded.sel15.ogryn' },
    ];
    expect(validateRosterFor(DATA, twoThugs).codes).toContain('unique');
    const troopers = [
      { datacardId: CARD.chieftain, entryId: 'blooded.sel0.chieftain', loadoutIds: ['blooded.g1.opt1'] },
      ...Array.from({ length: 9 }, () => ({ datacardId: CARD.trooper, entryId: 'blooded.sel13.trooper' })),
      { datacardId: CARD.enforcer, entryId: 'blooded.sel14.enforcer' },
      { datacardId: CARD.ogryn, entryId: 'blooded.sel15.ogryn' },
    ];
    expect(validateRosterFor(DATA, troopers).errors).toEqual([]);
  });

  it('ENFORCER and OGRYN "(counts as two selections)"', () => {
    expect(DATA.selection.rawText).toContain('ENFORCER (counts as two selections)');
    const entries = [...DATA.selection.leaderList, ...DATA.selection.list];
    expect(entries.find((e) => e.role === 'ENFORCER')!.selectionCost).toBe(2);
    expect(entries.find((e) => e.role === 'OGRYN')!.selectionCost).toBe(2);
  });

  it('"^1 You cannot select more than three of these operatives combined" — counted by footnote membership, so the plasma-gun GUNNER is in it', () => {
    expect(DATA.selection.footnotes['^1']).toBe('You cannot select more than three of these operatives combined.');
    const entries = [...DATA.selection.leaderList, ...DATA.selection.list];
    // The plasma-gun row belongs to TWO printed footnotes and the scraper joins the markers into
    // one literal — the only row in all 48 teams with this shape. A `groupCap` matches MEMBERSHIP
    // of that list, not the whole string, so this row can no longer escape its own cap.
    expect(entries.find((e) => e.rawText.includes('plasma gun'))!.footnoteGroup).toBe('^1,2');
    expect(DATA.selection.constraints).toContainEqual({ kind: 'groupCap', group: '^1', max: 3 });
    const picks = defaultRoster(DATA);
    const inGroup1 = (ps: typeof picks): typeof picks =>
      ps.filter((p) => {
        const e = entries.find((x, i) => `blooded.sel${i}.${x.role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` === p.entryId);
        return e?.footnoteGroup?.startsWith('^1');
      });
    expect(inGroup1(picks).length).toBe(3); // "not more than three … combined", and three it is
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    // …and a fourth — the plasma-gun GUNNER itself, in place of the THUG — is now refused.
    const four = picks.map((p) =>
      p.entryId === 'blooded.sel11.thug' ? { datacardId: CARD.gunner, entryId: 'blooded.sel9.gunner' } : p,
    );
    expect(inGroup1(four).length).toBe(4);
    const v = validateRosterFor(DATA, four);
    expect(v.codes).toContain('groupCap');
    expect(v.errors.join(' ')).toContain('You cannot select more than three of these operatives combined.');
  });

  it('DATA PROBLEM: the `custom` and `exclusive` constraints are both unenforced', () => {
    const kinds = RAW.selection.constraints.map((c) => c.kind);
    expect(kinds).toContain('custom');
    expect(kinds).toContain('exclusive');
    expect(RAW.selection.constraints.find((c) => c.kind === 'custom')!['text']).toBe(
      'In other words, you can only have one operative with a plasma weapon.',
    );
    expect(RAW.selection.constraints.find((c) => c.kind === 'exclusive')!['text']).toBe(
      'You cannot select this option and this operative.',
    );
    // The plasma CHIEFTAIN plus the plasma GUNNER is exactly what the footnote forbids, and the
    // shared validator accepts it.
    const both = [
      { datacardId: CARD.chieftain, entryId: 'blooded.sel0.chieftain', loadoutIds: ['blooded.g1.opt4'] },
      { datacardId: CARD.gunner, entryId: 'blooded.sel9.gunner' },
      { datacardId: CARD.brimstone, entryId: 'blooded.sel1.brimstone-grenadier' },
      { datacardId: CARD.butcher, entryId: 'blooded.sel2.butcher' },
      { datacardId: CARD.commsman, entryId: 'blooded.sel3.commsman' },
      { datacardId: CARD.corpseman, entryId: 'blooded.sel4.corpseman' },
      { datacardId: CARD.flenser, entryId: 'blooded.sel5.flenser' },
      { datacardId: CARD.thug, entryId: 'blooded.sel11.thug' },
      { datacardId: CARD.trenchSweeper, entryId: 'blooded.sel12.trench-sweeper' },
      { datacardId: CARD.trooper, entryId: 'blooded.sel13.trooper' },
      { datacardId: CARD.enforcer, entryId: 'blooded.sel14.enforcer' },
      { datacardId: CARD.ogryn, entryId: 'blooded.sel15.ogryn' },
    ];
    const v = validateRosterFor(DATA, both);
    expect(v.errors).toEqual([]);
    expect(v.weapons[0]).toContain('Plasma pistol');
    expect(v.weapons[1]).toContain('Plasma gun');
    expect(REMINDER_ONLY['blooded.selection.custom']).toBeDefined();
    expect(REMINDER_ONLY['blooded.selection.exclusive']).toBeDefined();
  });

  it('the CHIEFTAIN’s first option is ONE option with two choice groups: "Autopistol or laspistol; chainsword or power weapon"', () => {
    const opt = DATA.selection.leaderList[0]!.loadouts[0]!;
    expect(opt.label).toBe('Autopistol or laspistol; chainsword or power weapon');
    expect(opt.weapons).toEqual([]); // the "or" alternatives are the choice groups, not weapons
    expect(opt.choiceGroups).toEqual([
      ['Autopistol', 'Laspistol'],
      ['Chainsword', 'Power weapon'],
    ]);
    // One weapon per group, never every alternative at once: the default takes the first of each…
    const v = validateRosterFor(DATA, defaultRoster(DATA));
    expect(v.weapons[0]).toEqual(['Autopistol', 'Chainsword']);
    // …and naming the other alternative on the pick takes that one instead.
    const other = defaultRoster(DATA).map((p, i) => (i === 0 ? { ...p, weapons: ['Laspistol', 'Power weapon'] } : p));
    const w = validateRosterFor(DATA, other);
    expect(w.errors).toEqual([]);
    expect(w.weapons[0]).toEqual(['Laspistol', 'Power weapon']);
  });

  it('`notes[]` is empty, so the scraper flagged none of the above', () => {
    expect(RAW.notes).toEqual([]);
  });

  it('DATA PROBLEM: `uniqueActions[].keywords` is ABSENT, though SIGNAL prints "SUPPORT."', () => {
    const raw = rawJson as { datacards: { uniqueActions: { id: string; text: string; keywords?: string[] }[] }[] };
    const actions = raw.datacards.flatMap((c) => c.uniqueActions);
    expect(actions).toHaveLength(4);
    for (const a of actions) expect(Object.keys(a), a.id).not.toContain('keywords');
    expect(actions.find((a) => a.id === ACT.signal)!.text.startsWith('SUPPORT.')).toBe(true);
  });

  it('DATA PROBLEM: `markerGuide` names a Blooded Icon Token that no printed rule places', () => {
    const guide = (DATA.markerGuide ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    expect(guide).toContain('Blooded Icon Token');
    // The CHIEFTAIN's Blooded Icon only REGAINS a Blooded token; it places nothing of its own.
    expect(abilityText(CARD.chieftain, AB.bloodedIcon)).not.toContain('Blooded Icon');
    // Every other named token IS a real state token this module writes.
    for (const name of ['Blooded Token', 'Enraged Stimm Token', 'Under The Gaze of The Gods Token', 'Shielding Token'])
      expect(guide).toContain(name);
  });
});

// ---------------------------------------------------------------------------
describe('BLOODED aiHints', () => {
  it('names a role for every datacard', () => {
    const roles = blooded.aiHints?.roles ?? {};
    for (const c of DATA.datacards) expect(Object.keys(roles), c.id).toContain(c.id);
  });

  it('prices all 8 ploys — without `ployValue` the AI never uses a firefight ploy', () => {
    const values = blooded.aiHints?.ployValue ?? {};
    for (const p of blooded.ploys) expect(Object.keys(values), p.id).toContain(p.id);
    expect(Object.values(values).every((v) => v > 0 && v <= 1)).toBe(true);
  });

  it('prices all 4 equipment options', () => {
    const values = blooded.aiHints?.equipmentValue ?? {};
    for (const e of DATA.equipment) expect(Object.keys(values), e.id).toContain(e.id);
  });
});

// ---------------------------------------------------------------------------
describe('BLOODED honesty', () => {
  it('every REMINDER_ONLY entry names a printed rule and gives an engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).length).toBeGreaterThanOrEqual(11);
    for (const [id, reason] of Object.entries(REMINDER_ONLY)) {
      expect(reason.length, id).toBeGreaterThan(30);
      if (id.startsWith('blooded.selection.')) continue;
      const base = id.replace(/\.[a-zA-Z]+$/, '');
      const known =
        [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].some(
          (r) => r.id === id || r.id === base,
        ) ||
        DATA.datacards.some((c) => [...c.abilities, ...c.uniqueActions].some((a) => a.id === id || a.id === base));
      expect(known, `${id} is not a printed rule id`).toBe(true);
    }
  });

  it('the team module registers no handler on a hook that is never emitted', () => {
    // "Declared but never emitted" (docs/TEAM-STATUS.md § Known engine gaps): a handler there would
    // be the silent no-op CLAUDE.md architecture rule 5 forbids.
    const NEVER_EMITTED = [
      'onBattleSetup',
      'onAttackDiceRetained',
      'onFreeActions',
      'onOrderChange',
      'onMoveRules',
      'onSetUpAgain',
    ] as const;
    const { ctx } = setup();
    const reg = new HookRegistry();
    blooded.register(reg, 'p1', ctx);
    for (const hook of NEVER_EMITTED) expect([hook, reg.has(hook)]).toEqual([hook, false]);
    for (const hook of ['onWeaponRules', 'onIncapacitated', 'onStrikeResolved', 'onBlockAllocation', 'onStatMod'] as const)
      expect([hook, reg.has(hook)]).toEqual([hook, true]);
    expect(hooksFor(ctx, 'p1').player).toBe('p1');
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and offers
   * anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.signal, CARD.commsman],
      [ACT.sacrilegiousActuation, CARD.commsman],
      [ACT.stimms, CARD.corpseman],
      [ACT.enforce, CARD.enforcer],
    ];
    const tried = new Map<string, number>();
    for (const [actionId, datacardId] of owners) {
      const base = setup({ roles: [datacardId], seed: 5 });
      const opId = opWith(base.state, 'p1', datacardId);
      const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = base.state.teams.p2.operativeIds;
      let n = 0;
      for (const id of [...mates, ...foes]) base.state.operatives[id]!.pos = { x: 2 + (n++ % 12) * 1.6, y: 1 };
      place(base.state, opId, 8, 11);
      place(base.state, mates[0]!, 8, 12.2); // within control range
      place(base.state, mates[1]!, 10, 11); // visible and within 3"
      place(base.state, foes[0]!, 12, 11);
      const op = base.state.operatives[opId]!;
      op.order = 'engage';
      gainBloodedToken(base.state, 'p1', 'test');
      assignBloodedToken(base.state, op, 'p1');
      const attempts: Record<string, unknown>[] = [
        {},
        { targetPos: { ...op.pos } },
        ...aliveOperatives(base.state).map((o) => ({ targetOperativeId: o.id, targetId: o.id })),
      ];
      const def = getAction(actionId)!;
      for (const params of attempts) {
        if (def.available && !def.available(base.ctx, base.state, op)) continue;
        if (!def.check(base.ctx, base.state, op, params).ok) continue;
        const s = activate(base.ctx, base.state, opId, 'engage');
        const out = act(base.ctx, s, opId, actionId, params);
        tried.set(actionId, (tried.get(actionId) ?? 0) + 1);
        expect({ actionId, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
    expect(owners.filter(([id]) => !tried.has(id)).map(([id]) => id)).toEqual([]);
  });

  it('the module exports the ids the UI and the tests hang off', () => {
    expect(KW).toBe('BLOODED');
    expect(BLOODED_TOKEN).toBe('blooded.token');
    expect(blooded.id).toBe('blooded');
    expect(blooded.datacards).toHaveLength(13);
    expect(pool([6], 3).dice[0]!.state).toBe('crit'); // the shared dice helper behaves as expected
  });
});

// ---------------------------------------------------------------------------
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. The shared ring
  // in tests/teams/soak.test.ts covers the batch; this mirror exercises the Blooded gambit, the
  // token economy and the four unique actions on both an open and a Close Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([blooded], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: { teamId: 'blooded', operatives: roster(), equipment: [EQ.wickedBlades, EQ.symbolsOfBloodyWorship] },
          p2: { teamId: 'blooded', operatives: roster(), equipment: [EQ.chaosSigil, EQ.sinisterTrophies] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // The token economy actually ran.
      expect(result.state.log.some((l) => /Blooded token/.test(l.text))).toBe(true);
    }, 120000);
  }
});
