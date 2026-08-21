/**
 * BROOD BROTHERS. Every test quotes the printed rule it pins, read out of
 * `data/teams/brood-brother.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/brood-brother/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, successes, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { advanceShoot, effectiveRules, startShoot } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, aplOf, hitOf, inflictDamage, markerController, moveOf } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/brood-brother.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ACT,
  AGITATOR,
  ASSASSIN_CHARGE,
  COMMANDER,
  CROSSFIRE_TOKEN,
  CULT_KNIFE,
  EQ,
  EXPLOSIVES_MARKER,
  FIST_FIGHT,
  FIST_SHOOT,
  FP,
  GUNNER,
  ICONWARD,
  JAM_TOKEN,
  JAM_VISIBLE,
  KNIFE_FIGHTER,
  MAGUS,
  MEDIC,
  MIND_CONTROL_TOKEN,
  PATRIARCH,
  PRIMUS,
  PSYCHIC_FAMILIAR,
  REMINDER_ONLY,
  RULE_CROSSFIRE,
  SAPPER,
  SNIPER,
  SP,
  SPIRITUAL_TEXT,
  TROOPER,
  VETERAN,
  VOX_OPERATOR,
  broodBrother,
  crossfireTokens,
  explosivesUses,
  giveCrossfire,
  jamRemaining,
  removeCrossfire,
  spiritualGambitId,
} from '../../src/teams/brood-brother/index.ts';
import { act, activate, battle, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import { HookRegistry } from '../../src/core/hooks.ts';

const DATA = teamData('brood-brother');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([broodBrother], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.roles ? rosterIncluding(broodBrother, opts.roles) : defaultRoster(DATA);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: broodBrother, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: broodBrother, picks },
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
    op.pos = { x: 1.5 + (n % 3) * 1.2, y: 20 + Math.floor(n / 3) * 1.2 };
    n++;
  }
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

/** A low Heavy block that puts an operative standing at (12,11) in cover from (20,11). */
const coverMap = (): KillzoneMap => testMap({ features: [heavyBlock('cov', 12.8, 10.2, 0.5, 1.6, 0.6)] });

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function shootSeqOf(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'retention',
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
    free: false,
    ...over,
  };
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
  type: 'ranged' | 'melee' = 'ranged',
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

// ---------------------------------------------------------------------------
describe('BROOD BROTHER data (pinned against data/teams/brood-brother.json)', () => {
  it('has 15 datacards, every one of them BROOD BROTHER TYRANID GENESTEALER CULT', () => {
    expect(DATA.datacards).toHaveLength(15);
    for (const card of DATA.datacards) {
      expect(card.keywords.slice(0, 3)).toEqual(['BROOD BROTHER', 'TYRANID', 'GENESTEALER CULT']);
      expect(card.move).toBe(6);
    }
    // The BROODCOVEN trio are the only 32mm+ bases and the only Save 4+ operatives.
    expect(DATA.datacards.filter((c) => c.save === 4).map((c) => c.id)).toEqual([MAGUS, PATRIARCH, PRIMUS]);
    expect(DATA.datacards.find((c) => c.id === PATRIARCH)).toMatchObject({
      apl: 4,
      wounds: 21,
      base: { shape: 'round', mm: 50 },
    });
    expect(DATA.datacards.find((c) => c.id === MAGUS)).toMatchObject({ apl: 3, wounds: 9, base: { shape: 'round', mm: 32 } });
    expect(DATA.datacards.find((c) => c.id === PRIMUS)).toMatchObject({ apl: 3, wounds: 9 });
    expect(DATA.datacards.find((c) => c.id === PSYCHIC_FAMILIAR)).toMatchObject({ apl: 2, wounds: 3, save: 5 });
    expect(DATA.datacards.find((c) => c.id === COMMANDER)!.wounds).toBe(8);
  });

  it('BROODGUARD is on the twelve rank-and-file datacards and BROODCOVEN on the other three', () => {
    const guard = DATA.datacards.filter((c) => c.keywords.includes('BROODGUARD')).map((c) => c.id);
    const coven = DATA.datacards.filter((c) => c.keywords.includes('BROODCOVEN')).map((c) => c.id);
    expect(guard).toHaveLength(11);
    expect(guard).toContain(COMMANDER);
    expect(guard).not.toContain(PSYCHIC_FAMILIAR); // Small: not BROODGUARD, so no CULT KNIVES
    expect(coven).toEqual([MAGUS, PATRIARCH, PRIMUS]);
    expect(DATA.datacards.filter((c) => c.keywords.includes('LEADER')).map((c) => c.id)).toEqual([
      COMMANDER,
      MAGUS,
      PATRIARCH,
      PRIMUS,
    ]);
    expect(DATA.datacards.filter((c) => c.keywords.includes('PSYKER')).map((c) => c.id)).toEqual([MAGUS, PATRIARCH]);
  });

  it('exposes 1 faction rule, 4+4 ploys, 4 equipment options, 22 abilities and 9 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Crossfire']);
    expect(broodBrother.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(broodBrother.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(broodBrother.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(22);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(9);
    // Every ploy costs 1CP and no ploy name or id has "1CP" glued onto it (the known scraper bug).
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) {
      expect(p.cp).toBe(1);
      expect(p.id).not.toMatch(/1cp$/i);
      expect(p.name).not.toMatch(/1CP$/);
    }
    expect(NOTES).toEqual([]);
  });

  it('prices the nine unique actions as printed (JAM is the only 2AP one)', () => {
    const priced = DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => [a.name, a.ap] as const);
    expect(new Map(priced).get('JAM')).toBe(2);
    expect(new Map(priced).get('MIND CONTROL')).toBe(2);
    expect(priced.filter(([, ap]) => ap === 1)).toHaveLength(7);
    expect(priced.some(([, ap]) => ap === 0)).toBe(false);
  });

  it('pins the weapon profiles the rules read', () => {
    const rifle = DATA.datacards.find((c) => c.id === SNIPER)!.weapons.find((w) => w.name === 'Sniper rifle')!;
    expect(rifle.profiles.map((p) => p.name)).toEqual(['concealed', 'mobile', 'stationary']);
    expect(profileOf(SNIPER, 'Sniper rifle', 'concealed').rules.map((r) => r.raw)).toEqual([
      'Devastating 3',
      'Heavy',
      'Silent',
      'Concealed Position*',
    ]);
    expect(profileOf(GUNNER, 'Plasma gun', 'supercharge').rules.map((r) => r.id)).toEqual(['Hot', 'Lethal', 'Piercing']);
    // Meltagun: Critical Dmg BELOW Normal Dmg, which is how KT24 prints a Devastating gun.
    expect(profileOf(GUNNER, 'Meltagun')).toMatchObject({ dmgN: 6, dmgC: 3 });
    expect(profileOf(SAPPER, 'Demolition charge').rules.map((r) => r.id)).toEqual([
      'Range',
      'Blast',
      'Heavy',
      'Limited',
      'Piercing',
      'Saturate',
    ]);
    expect(profileOf(MEDIC, 'Gene-needler')).toMatchObject({ atk: 1, dmgN: 5, dmgC: 7 });
    expect(profileOf(PATRIARCH, 'Claws')).toMatchObject({ atk: 5, hit: 3, dmgN: 5, dmgC: 6 });
    expect(profileOf(MAGUS, 'Force stave').rules.map((r) => r.id)).toEqual(['PSYCHIC', 'Shock']);
  });

  it('the two rare weapon rules are ConcealedPosition and PSYCHIC, resolved against this team (D-033)', () => {
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['ConcealedPosition', 'PSYCHIC']);
    // The SNIPER prints its own "Concealed Position" ability, which wins over the shared registry.
    expect(rareWeaponRuleText('ConcealedPosition', 'brood-brother')).toBe(
      abilityText(SNIPER, AB.concealedPosition),
    );
    // PSYCHIC is a weapon keyword with no printed definition anywhere; nothing on this team reads it.
    expect(rareWeaponRuleText('PSYCHIC', 'brood-brother')).toContain('PSYCHIC');
    expect(DATA.datacards.flatMap((c) => c.abilities).some((a) => a.name.toLowerCase() === 'psychic')).toBe(false);
  });

  it('DATA PROBLEM: the section overrun leaves a POPULATED weapons array on two ploys', () => {
    // Trimmed at load, so the modules and the app quote the right text…
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    // …but the committed bytes still carry the overrun, and — the Spectre Squad shape — the CULT
    // KNIVES weapon table is copied onto both ploys as a populated `weapons` array that
    // `trimTrailingSection` cannot repair.
    const raw = rawJson as {
      strategyPloys: { text: string; weapons?: { name: string }[] }[];
      firefightPloys: { text: string; weapons?: { name: string }[] }[];
    };
    expect(raw.strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect(raw.firefightPloys[3]!.text).toContain('Faction Equipment');
    expect(raw.strategyPloys[3]!.weapons?.[0]?.name).toBe('Cult knife');
    expect(raw.firefightPloys[3]!.weapons?.[0]?.name).toBe('Cult knife');
  });

  it('DATA PROBLEM: CONSPIRE’s printed text has lost its leading character', () => {
    expect(actionOf(PRIMUS, ACT.conspire).text.startsWith('ou gain 1CP.')).toBe(true);
  });

  it('NOT a data problem: the CULT KNIVES table prints no WR column, so rules: [] is correct', () => {
    expect(ruleText(EQ.cultKnives)).toContain('NAME');
    expect(ruleText(EQ.cultKnives)).not.toContain('WR');
    expect(CULT_KNIFE.profiles[0]).toMatchObject({ type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4, rules: [] });
  });
});

// ---------------------------------------------------------------------------
describe('BROOD BROTHER selection', () => {
  it('prints uniqueExcept TROOPER, the ^1 group cap, the BROODCOVEN cap and TWO custom constraints', () => {
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['TROOPER'] },
      { kind: 'groupCap', group: '^1', max: 3 },
      { kind: 'maxCount', role: 'BROODCOVEN', max: 1 },
      {
        kind: 'custom',
        text: 'If one of these operatives is selected for deployment, your COMMANDER operative loses the LEADER keyword for the battle.',
        hook: 'brood-brother.if-one-of-these-operatives-is',
      },
      { kind: 'maxItem', item: 'times', max: 3 },
      {
        kind: 'custom',
        text: 'Note that ‘counts as’ selections still apply; for example, if you select a PATRIARCH operative, you could not do this.',
        hook: 'brood-brother.note-that-counts-as-selections-still',
      },
    ]);
  });

  it('DATA PROBLEM: the maxItem "item" is the literal word "times", so the constraint is inert', () => {
    const cap = DATA.selection.constraints.find((c) => c.kind === 'maxItem') as unknown as { item: string; max: number };
    expect(cap.item).toBe('times');
    expect(DATA.selection.footnotes['^3']!.startsWith('Up to three times, instead of selecting')).toBe(true);
    // No weapon is called "times", so the enforced count is always 0 — harmless but dead.
    const weapons = DATA.datacards.flatMap((c) => c.weapons).map((w) => w.name.toLowerCase());
    expect(weapons).not.toContain('times');
    expect(validateRosterFor(DATA, defaultRoster(DATA)).codes).not.toContain('maxItem');
  });

  it('defaultRoster is a legal 13-operative kill team that never fields six of the fifteen datacards', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(13);
    expect(DATA.selection.totalOperatives).toBe(13);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(picks[0]!.datacardId).toBe(COMMANDER);
    const fielded = new Set(picks.map((p) => p.datacardId));
    expect(DATA.datacards.map((c) => c.id).filter((id) => !fielded.has(id))).toEqual([
      SNIPER,
      VETERAN,
      VOX_OPERATOR,
      MAGUS,
      PATRIARCH,
      PRIMUS,
    ]);
  });

  it('the shared validator enforces the ^1 group cap and the BROODCOVEN cap (D-029 keyword fallback)', () => {
    const base = defaultRoster(DATA).filter((p) => p.datacardId !== GUNNER);
    const gunner = { datacardId: GUNNER };
    const four = validateRosterFor(DATA, [...base, gunner, gunner, gunner, gunner]);
    expect(four.codes).toContain('groupCap');
    // BROODCOVEN is a datacard keyword, not a selection role: the D-029 fallback catches it.
    expect(DATA.selection.list.some((e) => e.role === 'BROODCOVEN')).toBe(false);
    const twoCoven = validateRosterFor(DATA, [...defaultRoster(DATA).slice(0, 11), { datacardId: MAGUS }, { datacardId: PRIMUS }]);
    expect(twoCoven.codes).toContain('maxCount');
  });

  it('"Other than TROOPER operatives … each option on this list once" lets TROOPERs repeat', () => {
    expect(DATA.selection.rawText).toContain(
      'Other than TROOPER operatives, your kill team can only include each option on this list once.',
    );
    expect(defaultRoster(DATA).filter((p) => p.datacardId === TROOPER).length).toBeGreaterThan(1);
    const base = defaultRoster(DATA).filter((p) => p.datacardId !== GUNNER);
    expect(validateRosterFor(DATA, [...base, { datacardId: ICONWARD }, { datacardId: ICONWARD }]).codes).toContain(
      'unique',
    );
  });

  it('DATA PROBLEM: the BROODCOVEN rows are isLeader, so no legal roster can field them at all', () => {
    // The printed list is "1 COMMANDER operative" PLUS "3 BROOD BROTHER operatives selected from
    // the following list: … MAGUS (counts as two selections)^2 …", and the ^2 footnote exists
    // precisely because both can be in the same kill team: "If one of these operatives is selected
    // for deployment, your COMMANDER operative loses the LEADER keyword for the battle."
    expect(DATA.selection.footnotes['^2']).toContain('your COMMANDER operative loses the LEADER keyword');
    const base = defaultRoster(DATA);
    const picks = base.filter((_, i) => i !== 1 && i !== 2);
    picks.splice(1, 0, { datacardId: MAGUS });
    const v = validateRosterFor(DATA, picks);
    // `leaderList` and `list` BOTH mark MAGUS/PATRIARCH/PRIMUS `isLeader`, so the shared validator
    // counts two leaders and refuses — MAGUS, PATRIARCH and PRIMUS are unfieldable.
    expect(v.codes).toContain('leaderCount');
    expect(v.errors.join(' ')).toContain('exactly 1 COMMANDER operative (found 2)');
    for (const id of [MAGUS, PATRIARCH, PRIMUS]) {
      expect(DATA.selection.list.find((e) => e.datacardId === id)!.isLeader).toBe(true);
    }
    // …and the LEADER-keyword clause itself is a kind:'custom' constraint, which is the one
    // constraint kind the shared validator does not enforce (D-036).
    expect(REMINDER_ONLY['brood-brother.selection.leaderKeyword']).toContain('custom');
  });

  it('the ^3 footnote’s free-ploy option has no constraint entry at all', () => {
    expect(DATA.selection.footnotes['^3']).toContain('you can select one BROOD BROTHER ploy to cost you 0CP');
    expect(DATA.selection.constraints.some((c) => JSON.stringify(c).includes('0CP'))).toBe(false);
    expect(REMINDER_ONLY['brood-brother.selection.freePloy']).toContain('no constraint entry');
  });
});

// ---------------------------------------------------------------------------
describe('Crossfire (the faction rule)', () => {
  const quote = () => ruleText(RULE_CROSSFIRE);

  it('"…after resolving all of your attack dice, if that enemy operative isn’t incapacitated it gains one of your Crossfire tokens"', () => {
    expect(quote()).toContain('it gains one of your Crossfire tokens');
    const { ctx, state } = setup({ script: [1, 1, 1, 1, 6, 6, 6] });
    const shooter = opWith(state, 'p1', TROOPER);
    const foe = opWith(state, 'p2', TROOPER);
    isolate(state, [shooter, foe]);
    place(state, shooter, 6, 6);
    place(state, foe, 12, 6);
    expect(startShoot(ctx, state, state.operatives[shooter]!, 'Lasgun', undefined, foe).ok).toBe(true);
    advanceShoot(ctx, state);
    const done = settle(ctx, state); // the Command Re-roll window is offered and declined
    expect(done.sequence).toBeNull(); // the sequence ran to completion
    expect(crossfireTokens(done, foe, 'p1')).toBe(1);
  });

  it('an incapacitated target gains nothing', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', TROOPER);
    const foe = opWith(state, 'p2', TROOPER);
    isolate(state, [shooter, foe]);
    place(state, shooter, 6, 6);
    place(state, foe, 14, 6);
    state.operatives[foe]!.wounds = 1;
    inflictDamage(ctx, state, state.operatives[foe]!, 5);
    const seq = shootSeqOf({ attackerId: shooter, targetId: foe, attacker: 'p1', defender: 'p2', weaponName: 'Lasgun', step: 'resolve' });
    state.sequence = seq;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(state.operatives[shooter]!, state.operatives[foe]!, profileOf(TROOPER, 'Lasgun'), 'Lasgun'),
      crit: false,
      struck: state.operatives[foe]!,
    });
    expect(crossfireTokens(state, foe, 'p1')).toBe(0);
  });

  it('tokens stack — the marker guide prints "Crossfire Tokens (Values 1 & 2)"', () => {
    expect(DATA.markerGuide).toContain('Crossfire Tokens (Values 1 & 2)');
    const { state } = setup();
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    giveCrossfire(state, foe, 'p1');
    giveCrossfire(state, foe, 'p1');
    expect(crossfireTokens(state, foe.id, 'p1')).toBe(2);
    expect(crossfireTokens(state, foe.id, 'p2')).toBe(0); // tokens are per player
    removeCrossfire(state, foe.id, 'p1');
    expect(crossfireTokens(state, foe.id, 'p1')).toBe(1);
    removeCrossfire(state, foe.id, 'p1');
    expect(state.effects.some((e) => e.rule === CROSSFIRE_TOKEN)).toBe(false);
  });

  it('"…you can remove any of those tokens. For each that you do, you can re-roll one of your attack dice" — offered when shooting', () => {
    expect(quote()).toContain('you can re-roll one of your attack dice');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [shooter.id, foe.id]);
    const seq = shootSeqOf({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Lasgun',
      step: 'attackRerolls',
      attack: pool([1, 2, 5, 6], 4),
    });
    state.sequence = seq;
    const profile = profileOf(TROOPER, 'Lasgun');
    const none = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(shooter, foe, profile, 'Lasgun'),
      dice: [],
      rerolls: [],
    });
    expect(none.rerolls.filter((g) => g.id.startsWith(`${RULE_CROSSFIRE}:reroll`))).toHaveLength(0);
    giveCrossfire(state, foe, 'p1');
    const offered = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(shooter, foe, profile, 'Lasgun'),
      dice: [],
      rerolls: [],
    });
    expect(offered.rerolls.map((g) => g.id)).toContain(`${RULE_CROSSFIRE}:reroll:1`);
  });

  it('the token is spent only when the re-roll is actually taken, and a decline stops the offers', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    giveCrossfire(state, foe, 'p1');
    giveCrossfire(state, foe, 'p1');
    const profile = profileOf(TROOPER, 'Lasgun');
    const seq = shootSeqOf({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Lasgun',
      step: 'attackRerolls',
      attack: pool([1, 2, 5, 6], 4),
    });
    state.sequence = seq;
    const emit = () =>
      ctx.hooks.emit('onRollAttack', state, {
        state,
        ctx: attackCtx(shooter, foe, profile, 'Lasgun'),
        dice: [],
        rerolls: [],
      });
    emit(); // offers cf:1
    expect(seq.usedRerolls.some((id) => id.startsWith(`${RULE_CROSSFIRE}:gen:`))).toBe(true);
    seq.usedRerolls.push(`${RULE_CROSSFIRE}:reroll:1`); // the engine raises the decision
    seq.attack.dice[0]!.rerolledFrom = 1; // …and the player takes it
    emit();
    expect(crossfireTokens(state, foe.id, 'p1')).toBe(1);
    expect(seq.usedRerolls).toContain(`${RULE_CROSSFIRE}:reroll:1`);
    // Second offer declined: no new re-rolled dice, so the token stays and nothing more is offered.
    seq.usedRerolls.push(`${RULE_CROSSFIRE}:reroll:2`);
    const after = emit();
    expect(crossfireTokens(state, foe.id, 'p1')).toBe(1);
    expect(after.rerolls.filter((g) => g.id.startsWith(`${RULE_CROSSFIRE}:reroll`))).toHaveLength(0);
  });

  it('the fight half grants a token once the attacker has resolved all of its dice', () => {
    const { ctx, state } = setup();
    const me = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 6, 6);
    place(state, foe.id, 6.6, 6);
    startFight(ctx, state, me, 'Bayonet', undefined, foe.id);
    const seq = state.sequence as FightSequence;
    seq.attackerPool = pool([6], 4);
    seq.defenderPool = pool([1], 4);
    seq.attackerPool.dice[0]!.state = 'struck'; // its last die has just been resolved
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(me, foe, profileOf(TROOPER, 'Bayonet'), 'Bayonet', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(crossfireTokens(state, foe.id, 'p1')).toBe(1);
  });

  it('REMINDER ONLY: the re-roll half cannot reach fighting or retaliating (D-031)', () => {
    expect(quote()).toContain('shooting against, fighting against or retaliating against');
    expect(REMINDER_ONLY[`${RULE_CROSSFIRE}.fightReroll`]).toContain('D-031');
  });
});

// ---------------------------------------------------------------------------
describe('BROOD BROTHER datacard abilities', () => {
  it('COMMANDER › Coordinate: "STRATEGIC GAMBIT … Select one enemy operative to gain one of your Crossfire tokens"', () => {
    expect(abilityText(COMMANDER, AB.coordinate)).toContain('STRATEGIC GAMBIT if this operative is in the killzone');
    const { ctx, state } = setup();
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(AB.coordinate);
    const foe = opWith(state, 'p2', TROOPER);
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: AB.coordinate, data: { operativeId: foe } }, ctx);
    expect(crossfireTokens(out.state, foe, 'p1')).toBe(1);
  });

  it('AGITATOR › Devoted: "…you can ignore the damage inflicted on it from one normal success"', () => {
    expect(abilityText(AGITATOR, AB.devoted)).toContain('ignore the damage inflicted on it from one normal success');
    const { ctx, state } = setup({ roles: [AGITATOR] });
    const ag = state.operatives[opWith(state, 'p1', AGITATOR)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [ag.id, foe.id]);
    place(state, ag.id, 6, 6);
    place(state, foe.id, 6.6, 6);
    startFight(ctx, state, foe, 'Bayonet', undefined, ag.id);
    const before = ag.wounds;
    const dmgN = profileOf(TROOPER, 'Bayonet').dmgN;
    inflictDamage(ctx, state, ag, dmgN); // one normal success — ignored
    expect(ag.wounds).toBe(before);
    inflictDamage(ctx, state, ag, dmgN); // once per turning point
    expect(ag.wounds).toBe(before - dmgN);
  });

  it('AGITATOR › Psiren Caster offers a re-roll against an enemy within 6" — when SHOOTING only (D-031)', () => {
    expect(abilityText(AGITATOR, AB.psirenCaster)).toContain('within 6" of this operative');
    const { ctx, state } = setup({ roles: [AGITATOR] });
    const ag = state.operatives[opWith(state, 'p1', AGITATOR)]!;
    const shooter = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [ag.id, shooter.id, foe.id]);
    place(state, shooter.id, 6, 6);
    place(state, foe.id, 14, 6);
    place(state, ag.id, 1, 1); // far from the target
    const profile = profileOf(TROOPER, 'Lasgun');
    const far = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(shooter, foe, profile, 'Lasgun'),
      dice: [],
      rerolls: [],
    });
    expect(far.rerolls.some((g) => g.id.startsWith(AB.psirenCaster))).toBe(false);
    place(state, ag.id, 13, 6);
    const near = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(shooter, foe, profile, 'Lasgun'),
      dice: [],
      rerolls: [],
    });
    expect(near.rerolls.some((g) => g.id.startsWith(AB.psirenCaster))).toBe(true);
    expect(REMINDER_ONLY[AB.psirenCaster]).toContain('D-031');
  });

  it('ICONWARD › Cult Icon: "treat the total APL stat of friendly BROOD BROTHER operatives … as 1 higher"', () => {
    expect(abilityText(ICONWARD, AB.cultIcon)).toContain('as 1 higher');
    const { ctx, state } = setup({ roles: [ICONWARD] });
    const icon = state.operatives[opWith(state, 'p1', ICONWARD)]!;
    const mine = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [icon.id, mine.id, foe.id]);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 10, y: 6 }, z: 0, flags: {} };
    place(state, mine.id, 10, 6.6);
    place(state, foe.id, 10, 5.4);
    place(state, icon.id, 20, 20); // out of the 4" band: equal APL, nobody controls
    expect(markerController(ctx, state, state.markers['obj']!)).toBeNull();
    place(state, icon.id, 12, 6);
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p1');
  });

  it('ICONWARD › Broodmind Devotion is REMINDER ONLY — a free action on death has no seam', () => {
    expect(abilityText(ICONWARD, AB.broodmindDevotion)).toContain('it can perform a 1AP action for free');
    expect(REMINDER_ONLY[AB.broodmindDevotion]).toContain('onIncapacitated.freeActions');
  });

  it('KNIFE FIGHTER › Assassin: "can perform the Charge action while it has a Conceal order"', () => {
    expect(abilityText(KNIFE_FIGHTER, AB.assassin)).toBe(
      'This operative can perform the Charge action while it has a Conceal order.',
    );
    const { ctx, state } = setup({ roles: [KNIFE_FIGHTER] });
    const kf = state.operatives[opWith(state, 'p1', KNIFE_FIGHTER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [kf.id, foe.id]);
    place(state, kf.id, 6, 6);
    place(state, foe.id, 9, 6);
    kf.order = 'conceal';
    const path = { points: [{ x: 8.2, y: 6 }] };
    expect(getAction('Charge')!.check(ctx, state, kf, { path }).ok).toBe(false);
    expect(getAction(ASSASSIN_CHARGE)!.check(ctx, state, kf, { path }).ok).toBe(true);
    expect(getAction(ASSASSIN_CHARGE)!.treatedAs).toBe('Charge');
  });

  it('KNIFE FIGHTER › Counterattack: "whenever your opponent resolves a normal success, inflict 1 damage"', () => {
    expect(abilityText(KNIFE_FIGHTER, AB.counterattack)).toContain('inflict 1 damage on the enemy operative');
    const { ctx, state } = setup({ roles: [KNIFE_FIGHTER] });
    const kf = state.operatives[opWith(state, 'p1', KNIFE_FIGHTER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [kf.id, foe.id]);
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(foe, kf, profileOf(TROOPER, 'Bayonet'), 'Bayonet', 'melee'),
      crit: false,
      struck: kf,
    });
    expect(foe.wounds).toBe(before - 1);
    // A critical success is not a normal success.
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(foe, kf, profileOf(TROOPER, 'Bayonet'), 'Bayonet', 'melee'),
      crit: true,
      struck: kf,
    });
    expect(foe.wounds).toBe(before - 1);
    expect(REMINDER_ONLY[`${AB.counterattack}.block`]).toContain('onBlockAllocation');
  });

  it('MEDIC › Medic!: the victim stays on 1 wound, both lose 1 APL, and only once per turning point', () => {
    expect(abilityText(MEDIC, AB.medic)).toContain('isn’t incapacitated and has 1 wound remaining');
    const { ctx, state } = setup({ roles: [MEDIC] });
    const medic = state.operatives[opWith(state, 'p1', MEDIC)]!;
    const victim = state.operatives[opWith(state, 'p1', TROOPER)]!;
    isolate(state, [medic.id, victim.id]);
    place(state, medic.id, 6, 6);
    place(state, victim.id, 8, 6);
    inflictDamage(ctx, state, victim, 99);
    expect(victim.incapacitated).toBeFalsy();
    expect(victim.wounds).toBe(1);
    expect(aplOf(ctx, state, medic)).toBe(1);
    const other = state.operatives[opWith(state, 'p1', ICONWARD)]!;
    place(state, other.id, 7, 6);
    inflictDamage(ctx, state, other, 99);
    expect(other.incapacitated).toBe(true); // "The first time during each turning point"
    expect(REMINDER_ONLY[`${AB.medic}.dashEnd`]).toContain('end-region');
  });

  it('SAPPER › Final Defiance resolves a free EXPLOSIVES before the SAPPER is removed', () => {
    expect(abilityText(SAPPER, AB.finalDefiance)).toContain('free Explosives unique action');
    const { ctx, state } = setup({ roles: [SAPPER] });
    const sapper = state.operatives[opWith(state, 'p1', SAPPER)]!;
    isolate(state, [sapper.id]);
    place(state, sapper.id, 8, 6);
    inflictDamage(ctx, state, sapper, 99);
    expect(sapper.incapacitated).toBe(true);
    expect(state.markers[EXPLOSIVES_MARKER('p1')]).toBeDefined(); // the FIRST use places the marker
    expect(explosivesUses(state, sapper.id)).toBe(1);
  });

  it('SAPPER › Grenadier: frag and krak are granted, cost the kill team nothing and Hit is improved by 1', () => {
    expect(abilityText(SAPPER, AB.grenadier)).toContain('improve the Hit stat of that weapon by 1');
    const { ctx, state } = setup({ roles: [SAPPER] });
    const sapper = state.operatives[opWith(state, 'p1', SAPPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [sapper.id, foe.id]);
    place(state, sapper.id, 6, 6);
    place(state, foe.id, 12, 6);
    const s = activate(ctx, state, sapper.id);
    const armed = s.operatives[sapper.id]! as OperativeState & { grantedWeapons?: { name: string }[] };
    expect(armed.grantedWeapons?.map((w) => w.name)).toEqual(
      expect.arrayContaining(['Frag grenade', 'Krak grenade']),
    );
    const profile: WeaponProfile = { type: 'ranged', atk: 4, hit: 4, dmgN: 2, dmgC: 4, rules: [] };
    s.sequence = shootSeqOf({
      attackerId: sapper.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Frag grenade',
    });
    expect(hitOf(ctx, s, armed, profile)).toBe(3);
  });

  it('SNIPER › Concealed Position gates the CONCEALED profile only, and only before the first Shoot', () => {
    expect(abilityText(SNIPER, AB.concealedPosition)).toContain('the first time it’s performing the Shoot action');
    const { ctx, state } = setup({ roles: [SNIPER] });
    const sniper = state.operatives[opWith(state, 'p1', SNIPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [sniper.id, foe.id]);
    const concealed = profileOf(SNIPER, 'Sniper rifle', 'concealed');
    const mobile = profileOf(SNIPER, 'Sniper rifle', 'mobile');
    const ask = (profile: WeaponProfile, dryRun: boolean) =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(sniper, foe, profile, 'Sniper rifle'),
        allowed: true,
        dryRun,
      }).allowed;
    expect(ask(concealed, true)).toBe(true);
    // The dry run must not mutate: the profile is still legal afterwards (D-032).
    expect(ask(concealed, true)).toBe(true);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(sniper, foe, mobile, 'Sniper rifle'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(ask(concealed, false)).toBe(false);
    expect(ask(mobile, false)).toBe(true); // the other two profiles stay legal
  });

  it('TROOPER and PSYCHIC FAMILIAR › Group Activation record the pairing (PARTIAL — activation order)', () => {
    expect(abilityText(TROOPER, AB.trooperGroupActivation)).toContain('you must then activate one other ready friendly');
    const { ctx, state } = setup();
    const first = opWith(state, 'p1', TROOPER);
    let s = activate(ctx, state, first);
    s = reduce(s, { t: 'EndActivation', operativeId: first }, ctx).state;
    const paired = s.effects.find((e) => e.rule === 'brood-brother.groupActivation');
    expect(paired).toBeDefined();
    expect(s.operatives[paired!.operativeId!]!.datacardId).toBe(TROOPER);
    // PARTIAL: the turn still passes to the opponent — the reducer sets `activePlayer` after the
    // hook, so nothing can keep it.
    expect(s.activePlayer).toBe('p2');
    expect(REMINDER_ONLY[AB.trooperGroupActivation]).toContain('activePlayer');
  });

  it('VETERAN › Resilient: "Normal Dmg of 3 or more inflicts 1 less damage on this operative"', () => {
    expect(abilityText(VETERAN, AB.resilient)).toBe('Normal Dmg of 3 or more inflicts 1 less damage on this operative.');
    const { ctx, state } = setup({ roles: [VETERAN, KNIFE_FIGHTER] });
    const vet = state.operatives[opWith(state, 'p1', VETERAN)]!;
    const foe = state.operatives[opWith(state, 'p2', KNIFE_FIGHTER)]!;
    isolate(state, [vet.id, foe.id]);
    place(state, vet.id, 6, 6);
    place(state, foe.id, 6.6, 6);
    startFight(ctx, state, foe, 'Poisoned fighting knives', undefined, vet.id);
    const knives = profileOf(KNIFE_FIGHTER, 'Poisoned fighting knives');
    expect(knives.dmgN).toBe(3);
    const before = vet.wounds;
    inflictDamage(ctx, state, vet, knives.dmgN);
    expect(vet.wounds).toBe(before - (knives.dmgN - 1));
  });

  it('VETERAN › Bodyguard refunds Unquestioning Loyalty when the VETERAN is the shield', () => {
    expect(abilityText(VETERAN, AB.bodyguard)).toContain('for 0CP');
    const { ctx, state } = setup({ roles: [VETERAN] });
    const boss = state.operatives[opWith(state, 'p1', COMMANDER)]!;
    const vet = state.operatives[opWith(state, 'p1', VETERAN)]!;
    isolate(state, [boss.id, vet.id]);
    place(state, boss.id, 6, 6);
    place(state, vet.id, 7.5, 6);
    state.teams.p1.cp = 3;
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.unquestioningLoyalty }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.cp).toBe(3); // 1CP charged, 1CP refunded
  });

  it('PSYCHIC FAMILIAR › Small: no off-datacard weapons, no unique actions, Fall Back for 1 less AP', () => {
    const printed = abilityText(PSYCHIC_FAMILIAR, AB.small);
    expect(printed).toContain('cannot use any weapons that aren’t on its datacard, or perform unique actions');
    expect(printed).toContain('can perform the Fall Back action for 1 less AP');
    const { ctx, state } = setup({ roles: [PSYCHIC_FAMILIAR, MEDIC] });
    const fam = state.operatives[opWith(state, 'p1', PSYCHIC_FAMILIAR)]!;
    expect(actionCost(ctx, state, fam, getAction('Fall Back')!)).toBe(1);
    const medikit = availableActions(ctx, state, fam).find((a) => a.def.id === ACT.medikit);
    expect(medikit === undefined || medikit.ok === false).toBe(true);
    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: fam,
      action: ACT.medikit,
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    const off = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(fam, foe, profileOf(TROOPER, 'Lasgun'), 'Lasgun'),
      allowed: true,
      dryRun: false,
    });
    expect(off.allowed).toBe(false);
  });

  it('PSYCHIC FAMILIAR › Small: "whenever this operative is in cover, it cannot be selected as a valid target"', () => {
    expect(abilityText(PSYCHIC_FAMILIAR, AB.small)).toContain(
      'it cannot be selected as a valid target, taking precedence over all other rules',
    );
    const { ctx, state } = setup({ roles: [PSYCHIC_FAMILIAR], map: coverMap() });
    const fam = state.operatives[opWith(state, 'p1', PSYCHIC_FAMILIAR)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [fam.id, foe.id]);
    const ask = (target: OperativeState) =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: foe,
        target,
        valid: true,
        ignoreCoverTerrain: 'all', // even Seek, which "takes precedence over all other rules" beats
        forceVisible: false,
      });
    place(state, fam.id, 12, 11);
    place(state, foe.id, 20, 11);
    expect(ask(fam).valid).toBe(false);
    // "…except being within 2"": cover is denied within 2" of the shooter, so it is a target again.
    place(state, foe.id, 13.4, 11);
    expect(ask(fam).valid).toBe(true);
    // Out of cover it is an ordinary target.
    place(state, fam.id, 8, 11);
    place(state, foe.id, 20, 11);
    expect(ask(fam).valid).toBe(true);
  });

  it('PSYCHIC FAMILIAR › Elusive is REMINDER ONLY — mission actions and move rules have no seam', () => {
    expect(abilityText(PSYCHIC_FAMILIAR, AB.elusive)).toContain(
      'can perform mission actions while within control range of an enemy operative',
    );
    expect(REMINDER_ONLY[AB.elusive]).toContain('missionActionAllowed');
    expect(REMINDER_ONLY[AB.elusive]).toContain('onMoveRules');
  });

  it('MAGUS › Spiritual Leader offers its three printed options as STRATEGIC GAMBITs', () => {
    const printed = abilityText(MAGUS, AB.spiritualLeader);
    expect(printed).toContain('Select one of the following for friendly BROOD BROTHER operatives to have');
    // The three options are sliced out of the printed text — they have no ids of their own.
    expect(SPIRITUAL_TEXT.piercing).toBe(
      'Whenever an operative is shooting a friendly BROOD BROTHER operative, ignore the Piercing weapon rule.',
    );
    expect(SPIRITUAL_TEXT.injured).toContain('from being injured');
    expect(SPIRITUAL_TEXT.apl).toContain('the APL stat');
    for (const t of Object.values(SPIRITUAL_TEXT)) expect(printed).toContain(t);
    const { ctx, state } = setup({ roles: [MAGUS] });
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(spiritualGambitId('piercing'));
    expect(ids).toContain(spiritualGambitId('injured'));
    expect(ids).toContain(spiritualGambitId('apl'));
  });

  it('Spiritual Leader › Piercing: "ignore the Piercing weapon rule"', () => {
    const { ctx, state } = setup({ roles: [MAGUS] });
    const mine = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const melta = profileOf(GUNNER, 'Meltagun');
    expect(melta.rules.map((r) => r.id)).toContain('Piercing');
    const before = effectiveRules(ctx, state, melta, { operative: foe, target: mine, weaponName: 'Meltagun' });
    expect(before.some((r) => r.id === 'Piercing')).toBe(true);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: spiritualGambitId('piercing') }, ctx).state;
    const after = effectiveRules(ctx, s, melta, { operative: foe, target: mine, weaponName: 'Meltagun' });
    expect(after.some((r) => r.id === 'Piercing')).toBe(false);
  });

  it('Spiritual Leader › Injured cancels the injured Hit and Move penalties', () => {
    const { ctx, state } = setup({ roles: [MAGUS] });
    const op = state.operatives[opWith(state, 'p1', TROOPER)]!;
    op.wounds = 2; // fewer than half of 7 → injured
    const lasgun = profileOf(TROOPER, 'Lasgun');
    expect(hitOf(ctx, state, op, lasgun)).toBe(lasgun.hit + 1);
    expect(moveOf(ctx, state, op)).toBe(4);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: spiritualGambitId('injured') }, ctx).state;
    const injured = s.operatives[op.id]!;
    expect(hitOf(ctx, s, injured, lasgun)).toBe(lasgun.hit);
    expect(moveOf(ctx, s, injured)).toBe(6);
  });

  it('Spiritual Leader › APL: "you can ignore any changes to the APL stat"', () => {
    const { ctx, state } = setup({ roles: [MAGUS] });
    const op = state.operatives[opWith(state, 'p1', TROOPER)]!;
    op.aplMods.push(-1);
    expect(aplOf(ctx, state, op)).toBe(1);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: spiritualGambitId('apl') }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2);
  });

  it('Spiritual Leader lapses when the MAGUS is incapacitated ("whichever comes first")', () => {
    const { ctx, state } = setup({ roles: [MAGUS] });
    const magus = state.operatives[opWith(state, 'p1', MAGUS)]!;
    const op = state.operatives[opWith(state, 'p1', TROOPER)]!;
    op.aplMods.push(-1);
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: spiritualGambitId('apl') }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2);
    s.operatives[magus.id]!.removed = true;
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(1);
  });

  it('PATRIARCH › Alpha Predator: Piercing is ignored, and the second activation is granted', () => {
    const printed = abilityText(PATRIARCH, AB.alphaPredator);
    expect(printed).toContain('ignore the Piercing weapon rule');
    expect(printed).toContain('You can activate this operative twice during the turning point');
    const { ctx, state } = setup({ roles: [PATRIARCH] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    const foe = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const melta = profileOf(GUNNER, 'Meltagun');
    const rules = effectiveRules(ctx, state, melta, { operative: foe, target: pat, weaponName: 'Meltagun' });
    expect(rules.some((r) => r.id === 'Piercing')).toBe(false);
    let s = activate(ctx, state, pat.id);
    s = reduce(s, { t: 'EndActivation', operativeId: pat.id }, ctx).state;
    expect(s.operatives[pat.id]!.ready).toBe(true); // "it stays ready"
    s = activate(ctx, s, pat.id);
    s = reduce(s, { t: 'EndActivation', operativeId: pat.id }, ctx).state;
    expect(s.operatives[pat.id]!.ready).toBe(false); // …but never a third time
  });

  it('PATRIARCH › Alpha Predator caps it at 4AP and 9" of movement per turning point', () => {
    expect(abilityText(PATRIARCH, AB.alphaPredator)).toContain('it cannot move more than 9"');
    const { ctx, state } = setup({ roles: [PATRIARCH] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    isolate(state, [pat.id]);
    place(state, pat.id, 6, 6);
    let s = activate(ctx, state, pat.id);
    const first = act(ctx, s, pat.id, 'Reposition', { path: { points: [{ x: 12, y: 6 }] } });
    expect(first.ok).toBe(true);
    s = first.state;
    // 6" spent; the remaining allowance is 3", so a 4" Dash is refused.
    const second = act(ctx, s, pat.id, 'Dash', { path: { points: [{ x: 15.5, y: 6 }] } });
    expect(second.ok).toBe(false);
    // 4AP cap: APL 4 means it can spend 4 in one activation and then nothing more.
    s.operatives[pat.id]!.apSpent = 4;
    const capped = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[pat.id]!,
      action: 'Dash',
      allowed: true,
    });
    expect(capped.allowed).toBe(false);
  });

  it('PATRIARCH › Monster: no off-datacard weapons, and only INTO SHADOW / MIND CONTROL among unique actions', () => {
    const printed = abilityText(PATRIARCH, AB.monster);
    expect(printed).toContain('or perform unique actions (excluding Into Shadow and Mind Control)');
    const { ctx, state } = setup({ roles: [PATRIARCH] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    const ask = (action: string) =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: pat, action, allowed: true }).allowed;
    expect(ask(ACT.intoShadow)).toBe(true);
    expect(ask(ACT.mindControl)).toBe(true);
    expect(ask(ACT.conspire)).toBe(false);
    expect(ask('Reposition')).toBe(true); // universal actions are untouched
  });

  it('PATRIARCH › Monster: Conceal + Light terrain is targetable but KEEPS its cover save', () => {
    expect(abilityText(PATRIARCH, AB.monster)).toContain('it doesn’t remove its cover save');
    const { ctx, state } = setup({ roles: [PATRIARCH] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    pat.order = 'conceal';
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: foe,
      target: pat,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('light');
    pat.order = 'engage';
    const engaged = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: foe,
      target: pat,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(engaged.ignoreCoverTerrain).toBe('none');
  });

  it('PRIMUS › Fist of the Patriarch: a second Shoot OR a second Fight, never both', () => {
    expect(abilityText(PRIMUS, AB.fistOfThePatriarch)).toBe(
      'This operative can either perform two Shoot or two Fight actions during its activation.',
    );
    const { ctx, state } = setup({ roles: [PRIMUS] });
    const primus = state.operatives[opWith(state, 'p1', PRIMUS)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [primus.id, foe.id]);
    place(state, primus.id, 6, 6);
    place(state, foe.id, 12, 6);
    const params = { weaponName: 'Scoped needle pistol', targetId: foe.id };
    // Not before a first Shoot has happened.
    expect(getAction(FIST_SHOOT)!.check(ctx, state, primus, params).ok).toBe(false);
    primus.actionsThisActivation.push('Shoot');
    expect(getAction(FIST_SHOOT)!.check(ctx, state, primus, params).ok).toBe(true);
    primus.actionsThisActivation.push(FIST_FIGHT);
    expect(getAction(FIST_SHOOT)!.check(ctx, state, primus, params).reason).toContain('not both');
  });

  it('PRIMUS › Mastermind adds 1 to the initiative roll-off once per battle (the re-roll is unreachable)', () => {
    expect(abilityText(PRIMUS, AB.mastermind)).toContain('Add 1 to your dice result.');
    const { ctx, state } = setup({ roles: [PRIMUS] });
    state.phase = 'strategy';
    state.turningPoint = 2;
    const first = ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p1', mod: 0, rerollOffered: false });
    expect(first.mod).toBe(1);
    const second = ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p1', mod: 0, rerollOffered: false });
    expect(second.mod).toBe(0); // "you cannot select each option more than once per battle"
    expect(REMINDER_ONLY[`${AB.mastermind}.reroll`]).toContain('rerollOffered');
  });
});

// ---------------------------------------------------------------------------
describe('BROOD BROTHER unique actions', () => {
  it('MEDIKIT: "…to regain up to 2D3 lost wounds" within control range', () => {
    expect(actionOf(MEDIC, ACT.medikit).text).toContain('regain up to 2D3 lost wounds');
    const { ctx, state } = setup({ roles: [MEDIC], script: [6, 6] });
    const medic = state.operatives[opWith(state, 'p1', MEDIC)]!;
    const hurt = state.operatives[opWith(state, 'p1', TROOPER)]!;
    isolate(state, [medic.id, hurt.id]);
    place(state, medic.id, 6, 6);
    place(state, hurt.id, 6.7, 6);
    hurt.wounds = 1;
    const s = activate(ctx, state, medic.id);
    const out = act(ctx, s, medic.id, ACT.medikit, { targetOperativeId: hurt.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[hurt.id]!.wounds).toBe(7); // 1 + 2D3, capped at its 7 wounds
  });

  it('EXPLOSIVES places the marker first and detonates 2D6 second, twice per battle at most', () => {
    const printed = actionOf(SAPPER, ACT.explosives).text;
    expect(printed).toContain('place your Explosives marker within its control range');
    expect(printed).toContain('inflict 2D6 damage on each operative within 2" of that marker');
    const { ctx, state } = setup({ roles: [SAPPER], script: [6, 6] });
    const sapper = state.operatives[opWith(state, 'p1', SAPPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [sapper.id, foe.id]);
    place(state, sapper.id, 6, 6);
    place(state, foe.id, 20, 6);
    let s = activate(ctx, state, sapper.id);
    s = act(ctx, s, sapper.id, ACT.explosives, {}).state;
    expect(s.markers[EXPLOSIVES_MARKER('p1')]).toBeDefined();
    expect(s.markers[EXPLOSIVES_MARKER('p1')]!.pos).toEqual({ x: 6, y: 6 });
    s = reduce(s, { t: 'EndActivation', operativeId: sapper.id }, ctx).state;
    // The SAPPER steps away from its own charge; the victim wanders onto it.
    place(s, sapper.id, 12, 6);
    place(s, foe.id, 6.8, 6);
    s.operatives[sapper.id]!.ready = true;
    s = activate(ctx, s, sapper.id);
    const boom = act(ctx, s, sapper.id, ACT.explosives, {});
    expect(boom.ok).toBe(true);
    expect(boom.state.operatives[foe.id]!.incapacitated || boom.state.operatives[foe.id]!.removed).toBe(true);
    expect(explosivesUses(boom.state, sapper.id)).toBe(2);
    expect(getAction(ACT.explosives)!.check(ctx, boom.state, boom.state.operatives[sapper.id]!, {}).ok).toBe(false);
  });

  it('EXPLOSIVES and the Charge/Dash/Fall Back exclusion work in both directions', () => {
    expect(actionOf(SAPPER, ACT.explosives).text).toContain(
      'during an activation in which it performed the Charge, Dash or Fall Back action (or vice versa)',
    );
    const { ctx, state } = setup({ roles: [SAPPER] });
    const sapper = state.operatives[opWith(state, 'p1', SAPPER)]!;
    isolate(state, [sapper.id]);
    sapper.actionsThisActivation.push('Dash');
    expect(getAction(ACT.explosives)!.check(ctx, state, sapper, {}).ok).toBe(false);
    sapper.actionsThisActivation = [ACT.explosives];
    const back = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: sapper,
      action: 'Dash',
      allowed: true,
    });
    expect(back.allowed).toBe(false);
  });

  it('SIGNAL: "SUPPORT. … add 1 to its APL stat" for another BROODGUARD operative within 6"', () => {
    expect(actionOf(VOX_OPERATOR, ACT.signal).text).toContain('add 1 to its APL stat');
    const { ctx, state } = setup({ roles: [VOX_OPERATOR] });
    const vox = state.operatives[opWith(state, 'p1', VOX_OPERATOR)]!;
    const mate = state.operatives[opWith(state, 'p1', TROOPER)]!;
    isolate(state, [vox.id, mate.id]);
    place(state, vox.id, 6, 6);
    place(state, mate.id, 10, 6);
    const s = activate(ctx, state, vox.id);
    const out = act(ctx, s, vox.id, ACT.signal, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[mate.id]!)).toBe(3);
  });

  it('JAM stops the target performing actions, and the visible-only variant costs 1 more AP', () => {
    const printed = actionOf(VOX_OPERATOR, ACT.jam).text;
    expect(printed).toContain('cannot be activated or perform actions');
    expect(printed).toContain('visible to this operative instead if you spend 1 additional AP');
    expect(getAction(ACT.jam)!.ap).toBe(2);
    expect(getAction(JAM_VISIBLE)!.ap).toBe(3);
    expect(getAction(JAM_VISIBLE)!.treatedAs).toBe(ACT.jam);
    const { ctx, state } = setup({ roles: [VOX_OPERATOR], script: [3] });
    const vox = state.operatives[opWith(state, 'p1', VOX_OPERATOR)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    const otherFoe = state.operatives[opWith(state, 'p2', ICONWARD)] ?? foe;
    isolate(state, [vox.id, foe.id, otherFoe.id]);
    place(state, vox.id, 6, 6);
    place(state, foe.id, 12, 6);
    place(state, otherFoe.id, 14, 6);
    vox.aplMods.push(1);
    const s = activate(ctx, state, vox.id);
    const out = act(ctx, s, vox.id, ACT.jam, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(jamRemaining(out.state, foe.id)).toBe(3);
    const blocked = ctx.hooks.emit('canPerformAction', out.state, {
      state: out.state,
      operative: out.state.operatives[foe.id]!,
      action: 'Dash',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(REMINDER_ONLY[`${ACT.jam}.activation`]).toContain('cannot be activated');
  });

  it('TELEPATHIC OVERLOAD: "PSYCHIC. … subtract 1 from its APL stat"', () => {
    expect(actionOf(MAGUS, ACT.telepathicOverload).text.startsWith('PSYCHIC.')).toBe(true);
    const { ctx, state } = setup({ roles: [MAGUS] });
    const magus = state.operatives[opWith(state, 'p1', MAGUS)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [magus.id, foe.id]);
    place(state, magus.id, 6, 6);
    place(state, foe.id, 14, 6);
    const s = activate(ctx, state, magus.id);
    const out = act(ctx, s, magus.id, ACT.telepathicOverload, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[foe.id]!)).toBe(1);
  });

  it('MENTAL ONSLAUGHT inflicts 4 within 6", then keeps rolling until it fails or reaches 8 damage', () => {
    const printed = actionOf(MAGUS, ACT.mentalOnslaught).text;
    expect(printed).toContain('Inflict 2 damage on it, or 4 damage instead if it’s within 6"');
    expect(printed).toContain('until you inflict 8 damage on it during this action');
    const { ctx, state } = setup({ roles: [MAGUS], script: [6, 1] });
    const magus = state.operatives[opWith(state, 'p1', MAGUS)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [magus.id, foe.id]);
    place(state, magus.id, 6, 6);
    place(state, foe.id, 10, 6);
    foe.wounds = 20;
    const s = activate(ctx, state, magus.id);
    const out = act(ctx, s, magus.id, ACT.mentalOnslaught, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    // 4 damage, then a 6 beats APL 2 for another 4 (8 total, the printed cap), then it stops.
    expect(out.state.operatives[foe.id]!.wounds).toBe(12);
  });

  it('INTO SHADOW: "Change this operative’s order."', () => {
    expect(actionOf(PATRIARCH, ACT.intoShadow).text).toContain('Change this operative’s order');
    const { ctx, state } = setup({ roles: [PATRIARCH] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    isolate(state, [pat.id]);
    const s = activate(ctx, state, pat.id, 'engage');
    const out = act(ctx, s, pat.id, ACT.intoShadow, {});
    expect(out.ok).toBe(true);
    expect(out.state.operatives[pat.id]!.order).toBe('conceal');
  });

  it('MIND CONTROL rolls off with APL added; the second effect is reminder-only', () => {
    const printed = actionOf(PATRIARCH, ACT.mindControl).text;
    expect(printed).toContain('Both players roll one D6 and add their respective operative’s APL stat');
    const { ctx, state } = setup({ roles: [PATRIARCH], script: [6, 1] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [pat.id, foe.id]);
    place(state, pat.id, 6, 6);
    place(state, foe.id, 8, 6);
    const s = activate(ctx, state, pat.id);
    const out = act(ctx, s, pat.id, ACT.mindControl, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === MIND_CONTROL_TOKEN && e.operativeId === foe.id)).toBe(true);
    expect(out.state.operatives[foe.id]!.player).toBe('p2'); // it does NOT change sides
    expect(REMINDER_ONLY[`${ACT.mindControl}.control`]).toContain('cannot change sides');
  });

  it('CONSPIRE gains 1CP, once per turning point', () => {
    const { ctx, state } = setup({ roles: [PRIMUS] });
    const primus = state.operatives[opWith(state, 'p1', PRIMUS)]!;
    isolate(state, [primus.id]);
    const before = state.teams.p1.cp;
    const s = activate(ctx, state, primus.id);
    const out = act(ctx, s, primus.id, ACT.conspire, {});
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.cp).toBe(before + 1);
    expect(getAction(ACT.conspire)!.check(ctx, out.state, out.state.operatives[primus.id]!, {}).reason).toContain(
      'once per turning point',
    );
  });

  it('every unique action refuses within control range of an enemy operative, as printed', () => {
    const { ctx, state } = setup({ roles: [MEDIC, SAPPER, VOX_OPERATOR, MAGUS, PATRIARCH, PRIMUS] });
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    for (const [cardId, actionId] of [
      [MEDIC, ACT.medikit],
      [SAPPER, ACT.explosives],
      [VOX_OPERATOR, ACT.signal],
      [VOX_OPERATOR, ACT.jam],
      [MAGUS, ACT.telepathicOverload],
      [MAGUS, ACT.mentalOnslaught],
      [PATRIARCH, ACT.intoShadow],
      [PRIMUS, ACT.conspire],
    ] as const) {
      expect(actionOf(cardId, actionId).text).toContain('while within control range of an enemy operative');
      const op = state.operatives[opWith(state, 'p1', cardId)]!;
      isolate(state, [op.id, foe.id]);
      place(state, op.id, 6, 6);
      place(state, foe.id, 6.4, 6);
      const res = getAction(actionId)!.check(ctx, state, op, {});
      expect(res.ok, `${actionId} while engaged`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('BROOD BROTHER ploys', () => {
  it('PERVASIVE is REMINDER ONLY — a single climb leg cannot be discounted', () => {
    expect(ruleText(SP.pervasive)).toContain('ignore the first vertical distance of 2" they move during one climb');
    expect(REMINDER_ONLY[SP.pervasive]).toContain('onMoveRules');
  });

  it('UPRISING marks the target "as soon as it’s selected (instead of after resolving your attack dice)"', () => {
    expect(ruleText(SP.uprising)).toContain('as soon as it’s selected');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 6, 6);
    place(state, foe.id, 12, 6);
    state.teams.p1.cp = 4;
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.uprising }, ctx).state;
    // It had a Conceal order at the end of its previous activation…
    s.operatives[shooter.id]!.order = 'conceal';
    s = activate(ctx, s, shooter.id, 'conceal');
    s = reduce(s, { t: 'EndActivation', operativeId: shooter.id }, ctx).state;
    s.operatives[shooter.id]!.ready = true;
    // …and changes it to Engage at the start of this one.
    s = activate(ctx, s, shooter.id, 'engage');
    startShoot(ctx, s, s.operatives[shooter.id]!, 'Lasgun', undefined, foe.id);
    expect(crossfireTokens(s, foe.id, 'p1')).toBe(1); // before a single dice is rolled
    advanceShoot(ctx, s);
    expect(crossfireTokens(s, foe.id, 'p1')).toBe(1); // "instead of", not "as well as"
  });

  it('UPRISING has no effect when the operative was activated within control range of an enemy', () => {
    const { ctx, state } = setup();
    expect(ruleText(SP.uprising)).toContain('This ploy has no effect if that friendly operative was activated within');
    const shooter = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 6, 6);
    place(state, foe.id, 6.4, 6);
    state.teams.p1.cp = 4;
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.uprising }, ctx).state;
    s.operatives[shooter.id]!.order = 'conceal';
    s = activate(ctx, s, shooter.id, 'conceal');
    s = reduce(s, { t: 'EndActivation', operativeId: shooter.id }, ctx).state;
    s.operatives[shooter.id]!.ready = true;
    s = activate(ctx, s, shooter.id, 'engage');
    expect(s.effects.some((e) => e.rule === 'brood-brother.uprisingArmed')).toBe(false);
  });

  it('EMBEDDED: "…you can retain one additional cover save" when the cover is Heavy terrain', () => {
    expect(ruleText(SP.embedded)).toContain('as a result of Heavy terrain, you can retain one additional cover save');
    const { ctx, state } = setup({ map: coverMap() });
    const mine = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [mine.id, foe.id]);
    place(state, mine.id, 12, 11);
    place(state, foe.id, 20, 11);
    state.teams.p1.cp = 4;
    const ask = (st: GameState) => {
      st.sequence = shootSeqOf({
        attackerId: foe.id,
        targetId: mine.id,
        attacker: 'p2',
        defender: 'p1',
        weaponName: 'Lasgun',
        step: 'rollDefence',
        inCover: true,
      });
      return ctx.hooks.emit('onDefenceDice', st, {
        state: st,
        ctx: attackCtx(st.operatives[foe.id]!, st.operatives[mine.id]!, profileOf(TROOPER, 'Lasgun'), 'Lasgun'),
        count: 3,
        coverSave: true,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).extraCoverSaves;
    };
    expect(ask(state)).toBe(0);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.embedded }, ctx).state;
    expect(ask(s)).toBe(1);
  });

  it('CULT DEVOTION strikes with an unresolved success when a fighting operative is incapacitated', () => {
    const printed = ruleText(SP.cultDevotion);
    expect(printed).toContain('you can strike the enemy operative in that sequence');
    expect(printed).toContain('that friendly operative is removed from the killzone afterwards');
    const { ctx, state } = setup({ script: [6] });
    const me = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [me.id, foe.id]);
    place(state, me.id, 6, 6);
    place(state, foe.id, 6.6, 6);
    state.teams.p1.cp = 4;
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.cultDevotion }, ctx).state;
    startFight(ctx, s, s.operatives[me.id]!, 'Bayonet', undefined, foe.id);
    const seq = s.sequence as FightSequence;
    seq.attackerPool = pool([5, 5], 4);
    const before = s.operatives[foe.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[me.id]!, 99);
    expect(s.operatives[me.id]!.incapacitated).toBe(true);
    expect(s.operatives[foe.id]!.wounds).toBe(before - profileOf(TROOPER, 'Bayonet').dmgN);
  });

  it('RUTHLESS COORDINATION determines intervening from another friendly operative (viewFrom)', () => {
    const printed = ruleText(FP.ruthlessCoordination);
    expect(printed).toContain('determine visibility as normal');
    expect(printed).toContain('that isn’t itself within control range of enemy operatives');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const spotter = state.operatives[opWith(state, 'p1', ICONWARD)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    // Only these three are left in the killzone, so the deterministic spotter is unambiguous.
    for (const o of aliveOperatives(state)) if (![shooter.id, spotter.id, foe.id].includes(o.id)) o.removed = true;
    place(state, shooter.id, 6, 6);
    place(state, spotter.id, 8, 8);
    place(state, foe.id, 16, 6);
    state.teams.p1.cp = 4;
    const active = activate(ctx, state, shooter.id);
    const used = reduce(active, { t: 'UsePloy', player: 'p1', ployId: FP.ruthlessCoordination }, ctx);
    expect(used.ok).toBe(true);
    const s = used.state;
    const ev = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: s.operatives[shooter.id]!,
      target: s.operatives[foe.id]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.viewFrom?.id).toBe(spotter.id);
    expect(REMINDER_ONLY[`${FP.ruthlessCoordination}.vantage`]).toContain('Vantage');
  });

  it('UNQUESTIONING LOYALTY redirects the shot to a BROODGUARD operative within 3" of the LEADER', () => {
    const printed = ruleText(FP.unquestioningLoyalty);
    expect(printed).toContain('to become the valid target or to be fought against (as appropriate) instead');
    expect(printed).toContain('has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent');
    const { ctx, state } = setup();
    const boss = state.operatives[opWith(state, 'p1', COMMANDER)]!;
    const shield = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [boss.id, shield.id, foe.id]);
    place(state, boss.id, 12, 6);
    place(state, shield.id, 13, 6);
    place(state, foe.id, 4, 6);
    state.teams.p1.cp = 4;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.unquestioningLoyalty }, ctx).state;
    startShoot(ctx, s, s.operatives[foe.id]!, 'Lasgun', undefined, boss.id);
    expect((s.sequence as ShootSequence).targetId).toBe(shield.id);
    expect(REMINDER_ONLY[`${FP.unquestioningLoyalty}.fight`]).toContain('startFight');
  });

  it('IDOLISATION retains a fail as a normal success — and it works when FIGHTING too', () => {
    expect(ruleText(FP.idolisation)).toContain('retain one of your fails as a normal success instead of discarding it');
    const { ctx, state } = setup();
    const boss = state.operatives[opWith(state, 'p1', COMMANDER)]!;
    const grunt = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    isolate(state, [boss.id, grunt.id, foe.id]);
    place(state, boss.id, 6, 6);
    place(state, grunt.id, 6, 8);
    place(state, foe.id, 6.6, 8);
    state.teams.p1.cp = 4;
    startFight(ctx, state, state.operatives[grunt.id]!, 'Bayonet', undefined, foe.id);
    const started = state.sequence as FightSequence;
    started.attackerPool = pool([1, 1, 2], 4);
    started.step = 'attackerRerolls';
    expect(successes(started.attackerPool)).toHaveLength(0);
    // "Use this firefight ploy when a friendly BROOD BROTHER operative … is shooting, fighting or
    //  retaliating, in the Roll Attack Dice step."
    const used = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.idolisation }, ctx);
    expect(used.ok).toBe(true);
    const s = used.state;
    const seq = s.sequence as FightSequence;
    advanceFight(ctx, s);
    expect(seq.attackerPool.dice.some((d) => d.note === 'Idolisation' && d.state === 'normal')).toBe(true);
  });

  it('INSIDIOUS cannot be used in the first turning point and grants a free Dash (D-015 timing)', () => {
    expect(ruleText(FP.insidious)).toContain('You cannot use this ploy during the first turning point');
    const { ctx, state } = setup();
    state.teams.p1.cp = 4;
    const tp1 = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.insidious }, ctx);
    expect(tp1.ok).toBe(false);
    const later = { ...state, turningPoint: 2, activeOperativeId: undefined } as GameState;
    const out = reduce(later, { t: 'UsePloy', player: 'p1', ployId: FP.insidious }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === 'teamFreeAction')).toBe(true);
    expect(REMINDER_ONLY[`${FP.insidious}.timing`]).toContain('outside an activation');
  });

  it('every ploy has an aiHints ployValue, and every equipment option an equipmentValue', () => {
    const ploys = broodBrother.ploys.map((p) => p.id);
    expect(ploys).toHaveLength(8);
    for (const id of ploys) expect(broodBrother.aiHints?.ployValue?.[id]).toBeGreaterThan(0);
    for (const eq of broodBrother.equipment) expect(broodBrother.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
    for (const card of DATA.datacards) expect(broodBrother.aiHints?.roles?.[card.id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('BROOD BROTHER faction equipment', () => {
  it('CULT TALISMAN retains one normal defence success as a critical, once per turning point', () => {
    expect(ruleText(EQ.cultTalisman)).toContain('retain one of your normal successes as a critical success instead');
    const { ctx, state } = setup({ equipment: [EQ.cultTalisman] });
    const mine = state.operatives[opWith(state, 'p1', TROOPER)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    const seq = shootSeqOf({
      attackerId: foe.id,
      targetId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Lasgun',
      step: 'defenceRerolls',
      defence: pool([4, 2], 4),
    });
    state.sequence = seq;
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(foe, mine, profileOf(TROOPER, 'Lasgun'), 'Lasgun'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('CULT TALISMAN never applies to the PATRIARCH ("excluding PATRIARCH")', () => {
    expect(ruleText(EQ.cultTalisman)).toContain('(excluding PATRIARCH)');
    const { ctx, state } = setup({ equipment: [EQ.cultTalisman], roles: [PATRIARCH] });
    const pat = state.operatives[opWith(state, 'p1', PATRIARCH)]!;
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    const seq = shootSeqOf({
      attackerId: foe.id,
      targetId: pat.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Lasgun',
      step: 'defenceRerolls',
      defence: pool([4, 2], 4),
    });
    state.sequence = seq;
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(foe, pat, profileOf(TROOPER, 'Lasgun'), 'Lasgun'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice.filter((d) => d.state === 'crit')).toHaveLength(0);
  });

  it('COVERT GUISES rolls a D3 when revealed and is a first-turning-point STRATEGIC GAMBIT', () => {
    expect(ruleText(EQ.covertGuises)).toContain('After revealing this equipment option, roll one D3');
    const { ctx, state } = setup({ equipment: [EQ.covertGuises], script: [2] });
    expect(state.effects.some((e) => e.rule === 'brood-brother.covertGuisesD3')).toBe(true);
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.covertGuises);
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(EQ.covertGuises);
    expect(REMINDER_ONLY[`${EQ.covertGuises}.dropZone`]).toContain('end-region');
  });

  it('CULT KNIVES gives every BROODGUARD operative the printed melee weapon — and no one else', () => {
    expect(ruleText(EQ.cultKnives)).toContain('Friendly BROODGUARD operatives have the following melee weapon');
    const { ctx, state } = setup({ equipment: [EQ.cultKnives], roles: [PSYCHIC_FAMILIAR] });
    const trooper = state.operatives[opWith(state, 'p1', TROOPER)]! as OperativeState & {
      grantedWeapons?: { name: string }[];
    };
    const familiar = state.operatives[opWith(state, 'p1', PSYCHIC_FAMILIAR)]! as OperativeState & {
      grantedWeapons?: { name: string }[];
    };
    expect(trooper.grantedWeapons?.map((w) => w.name)).toContain('Cult knife');
    expect(familiar.grantedWeapons?.map((w) => w.name) ?? []).not.toContain('Cult knife');
    // …and Small refuses it even if something else hands it over.
    const foe = state.operatives[opWith(state, 'p2', TROOPER)]!;
    const ask = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(familiar, foe, CULT_KNIFE.profiles[0]!, 'Cult knife', 'melee'),
      allowed: true,
      dryRun: false,
    });
    expect(ask.allowed).toBe(false);
  });

  it('LOOKOUT: "Select one enemy operative visible to a friendly BROOD BROTHER operative to gain one of your Crossfire tokens"', () => {
    expect(ruleText(EQ.lookout)).toContain('to gain one of your Crossfire tokens');
    const { ctx, state } = setup({ equipment: [EQ.lookout] });
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.lookout);
    const foe = opWith(state, 'p2', TROOPER);
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.lookout, data: { operativeId: foe } }, ctx);
    expect(crossfireTokens(out.state, foe, 'p1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('BROOD BROTHER honesty', () => {
  it('every REMINDER_ONLY entry names a printed rule and gives an engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).length).toBeGreaterThanOrEqual(16);
    for (const [id, reason] of Object.entries(REMINDER_ONLY)) {
      expect(reason.length, id).toBeGreaterThan(30);
      if (id.startsWith('brood-brother.selection.')) continue;
      const base = id.replace(/\.[a-zA-Z]+$/, '');
      const known =
        [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].some(
          (r) => r.id === id || r.id === base,
        ) ||
        DATA.datacards.some((c) =>
          [...c.abilities, ...c.uniqueActions].some((a) => a.id === id || a.id === base),
        );
      expect(known, `${id} is not a printed rule id`).toBe(true);
    }
  });

  it('the team module registers no handler on a hook that is never emitted', () => {
    // "Declared but never emitted" (docs/TEAM-STATUS.md § Known engine gaps): a handler here would
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
    broodBrother.register(reg, 'p1', ctx);
    for (const hook of NEVER_EMITTED) expect([hook, reg.has(hook)]).toEqual([hook, false]);
    // …and the hooks it does use are live ones.
    for (const hook of ['onStrikeResolved', 'onRollAttack', 'onWeaponRules', 'onIncapacitated'] as const) {
      expect([hook, reg.has(hook)]).toEqual([hook, true]);
    }
    expect(hooksFor(ctx, 'p1').player).toBe('p1');
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and offers
   * anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.medikit, MEDIC],
      [ACT.explosives, SAPPER],
      [ACT.signal, VOX_OPERATOR],
      [ACT.jam, VOX_OPERATOR],
      [JAM_VISIBLE, VOX_OPERATOR],
      [ACT.telepathicOverload, MAGUS],
      [ACT.mentalOnslaught, MAGUS],
      [ACT.intoShadow, PATRIARCH],
      [ACT.mindControl, PATRIARCH],
      [ACT.conspire, PRIMUS],
    ];
    const tried = new Map<string, number>();
    for (const [actionId, datacardId] of owners) {
      const base = setup({ roles: [datacardId], seed: 5 });
      const opId = opWith(base.state, 'p1', datacardId);
      const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = base.state.teams.p2.operativeIds;
      // A board that makes every printed condition reachable at once: a friendly in control
      // range, a valid enemy target just outside it, and a visible enemy screened by a friendly.
      let n = 0;
      for (const id of [...mates, ...foes]) base.state.operatives[id]!.pos = { x: 2 + (n++ % 12) * 1.6, y: 1 };
      place(base.state, opId, 8, 11);
      place(base.state, mates[0]!, 8, 12.2); // within control range of the caster
      place(base.state, foes[0]!, 11, 11); // visible, within 2", a valid target, not engaged
      place(base.state, foes[1]!, 12, 14);
      place(base.state, mates[1]!, 12.6, 14); // screens foes[1] — visible but not a valid target
      const op = base.state.operatives[opId]!;
      op.order = 'engage';
      op.aplMods.push(1); // enough AP for the 3AP JAM variant
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
    // Every one of the ten was actually reachable on that board, so none of the assertions above
    // was vacuous.
    expect(owners.filter(([id]) => !tried.has(id)).map(([id]) => id)).toEqual([]);
  });
});
