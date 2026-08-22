/**
 * HUNTER CLADE. Every test quotes the printed rule it pins, read out of
 * `data/teams/hunter-clade.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/hunter-clade/
 */
import { describe, expect, it } from 'vitest';
import { getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { ScriptedRng } from '../../src/core/rng.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  hitOf,
  inflictDamage,
  markerController,
  moveOf,
  saveOf,
} from '../../src/core/state.ts';
import { heavyBlock, testMap, vantagePlatform } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/hunter-clade.json';
import { selectionEntries, teamData } from '../../src/teams/data.ts';
import {
  defaultRoster,
  entryId,
  validateRosterFor,
  weaponsForPick,
  type RosterPickIn,
} from '../../src/teams/selection.ts';
import {
  AB,
  ACT,
  CARD,
  CONTROL_EDICT_DECISION,
  DEPRECATION,
  EQ,
  FIGHT_ACCELERANT,
  FP,
  IMPERATIVES,
  IMPERATIVE_LABEL,
  IMPERATIVE_TEXT,
  KW,
  OMNISSIAH_TEXT,
  OPTIMISATION,
  REMINDER_ONLY,
  RULE,
  SP,
  deprecationOf,
  hunterClade,
  imperativeGambitId,
  imperativeOf,
  omnissiahOf,
  primaryMode,
  setPrimaryMode,
} from '../../src/teams/hunter-clade/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, teamContext } from './harness.ts';

const DATA = teamData('hunter-clade');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;
const RAW = rawJson as unknown as {
  selection: { list: { role: string; loadouts: { id: string; label: string; weapons: string[]; choiceGroups?: string[][] }[]; alwaysWeapons: string[] }[] };
};

const EPS = 1e-6;

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

// ---------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------

const ENTRIES = selectionEntries(DATA);

/** A pick for one printed selection row, taking its nth option (as `defaultRoster` does). */
function pick(role: string, nth = 0): RosterPickIn {
  const index = ENTRIES.findIndex((e) => e.role === role);
  const entry = ENTRIES[index]!;
  const at = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[nth % xs.length]);
  return {
    datacardId: entry.datacardId,
    entryId: entryId(DATA, index),
    loadoutIds: [
      ...(entry.loadouts.length > 0 ? [at(entry.loadouts)!.id] : []),
      ...entry.optionGroups.map((g) => at(g.choices)?.id).filter((x): x is string => Boolean(x)),
      ...entry.fixedChoiceGroups.map((g) => at(g.choices)?.id).filter((x): x is string => Boolean(x)),
    ],
  };
}

/**
 * A legal kill team that fields the widest slice of the datacards the printed constraints allow —
 * `defaultRoster` reaches only 6 of the 14 (D-042), and never a VANGUARD or a RUSTSTALKER.
 */
const COVERAGE: RosterPickIn[] = [
  pick('SKITARII VANGUARD ALPHA'),
  pick('WARRIOR INFILTRATOR', 0),
  pick('WARRIOR INFILTRATOR', 1),
  pick('WARRIOR SICARIAN', 0),
  pick('WARRIOR SICARIAN', 1),
  pick('SKITARII RANGER DIKTAT'),
  pick('SKITARII RANGER GUNNER'),
  pick('SKITARII RANGER SURVEYOR'),
  pick('RANGER WARRIOR'),
  pick('VANGUARD WARRIOR'),
];

/** The same shape with the SICARIAN RUSTSTALKER PRINCEPS leading, for the RUSTSTALKER rules. */
const RUSTSTALKER_LED: RosterPickIn[] = [
  pick('SICARIAN RUSTSTALKER PRINCEPS'),
  pick('WARRIOR SICARIAN', 0),
  pick('WARRIOR SICARIAN', 1),
  pick('WARRIOR INFILTRATOR', 0),
  pick('SKITARII RANGER DIKTAT'),
  pick('SKITARII RANGER GUNNER'),
  pick('SKITARII RANGER SURVEYOR'),
  pick('RANGER WARRIOR'),
  pick('VANGUARD WARRIOR'),
  pick('VANGUARD WARRIOR'),
];

/** …and with the SKITARII RANGER ALPHA leading, for Canticle of Elimination. */
const RANGER_LED: RosterPickIn[] = [
  pick('SKITARII RANGER ALPHA'),
  pick('RANGER WARRIOR'),
  pick('SKITARII RANGER DIKTAT'),
  pick('SKITARII RANGER GUNNER'),
  pick('SKITARII RANGER SURVEYOR'),
  pick('VANGUARD WARRIOR'),
  pick('WARRIOR INFILTRATOR', 0),
  pick('WARRIOR INFILTRATOR', 1),
  pick('WARRIOR SICARIAN', 0),
  pick('WARRIOR SICARIAN', 1),
];

/** …and with the SICARIAN INFILTRATOR PRINCEPS leading, for Canticle of Shroudpsalm. */
const INFILTRATOR_LED: RosterPickIn[] = [
  pick('SICARIAN INFILTRATOR PRINCEPS'),
  pick('WARRIOR INFILTRATOR', 0),
  pick('WARRIOR INFILTRATOR', 1),
  pick('WARRIOR INFILTRATOR', 0),
  pick('SKITARII RANGER DIKTAT'),
  pick('SKITARII RANGER GUNNER'),
  pick('SKITARII RANGER SURVEYOR'),
  pick('RANGER WARRIOR'),
  pick('VANGUARD WARRIOR'),
  pick('VANGUARD WARRIOR'),
];

/** …and a VANGUARD-heavy one, for the VANGUARD DIKTAT's SIGNAL and the VANGUARD SURVEYOR's SPOT. */
const VANGUARD_LED: RosterPickIn[] = [
  pick('SKITARII RANGER ALPHA'),
  pick('SKITARII VANGUARD DIKTAT'),
  pick('SKITARII VANGUARD SURVEYOR'),
  pick('VANGUARD WARRIOR'),
  pick('VANGUARD WARRIOR'),
  pick('RANGER WARRIOR'),
  pick('RANGER WARRIOR'),
  pick('SKITARII RANGER GUNNER'),
  pick('WARRIOR INFILTRATOR', 0),
  pick('WARRIOR SICARIAN', 0),
];

interface SetupOpts {
  picks?: RosterPickIn[];
  foePicks?: RosterPickIn[];
  equipment?: string[];
  script?: number[];
  seed?: number;
}

/** Both sides are Hunter Clade, so every rule can be tested from either seat. */
function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([hunterClade], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.picks ?? COVERAGE;
  const state = battle({
    ctx,
    p1: { module: hunterClade, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: hunterClade, picks: opts.foePicks ?? picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Move everything else far away so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.1 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    n++;
  }
}

function shootSeqOf(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
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
    free: false,
    ...over,
  };
}

function fightSeqOf(
  over: Partial<FightSequence> &
    Pick<FightSequence, 'attackerId' | 'defenderId' | 'attackerWeapon' | 'attacker' | 'defender'>,
): FightSequence {
  return {
    kind: 'fight',
    step: 'resolve',
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    defenderCanRetaliate: true,
    free: false,
    hatchway: false,
    ...over,
  };
}

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
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

/** Use the STRATEGIC GAMBIT for real, so `gambitsUsedTP` and the effect are both exercised. */
function useImperative(ctx: GameContext, state: GameState, player: PlayerId, imp: (typeof IMPERATIVES)[number]): GameState {
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  const out = reduce(state, { t: 'UseGambit', player, gambitId: imperativeGambitId(imp) }, ctx);
  expect(out.ok).toBe(true);
  const s = out.state;
  s.phase = 'firefight';
  s.firefightStep = 'performActions';
  return s;
}

function useGambitPloy(ctx: GameContext, state: GameState, player: PlayerId, ployId: string): GameState {
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  const out = reduce(state, { t: 'UseGambit', player, gambitId: ployId }, ctx);
  expect(out.ok).toBe(true);
  const s = out.state;
  s.phase = 'firefight';
  s.firefightStep = 'performActions';
  return s;
}

// ===========================================================================
describe('HUNTER CLADE data (pinned against data/teams/hunter-clade.json)', () => {
  it('is the Adeptus Mechanicus kill team with 14 datacards, 1 faction rule, 4+4 ploys, 4 equipment', () => {
    expect(DATA.id).toBe('hunter-clade');
    expect(DATA.name).toBe('Hunter Clade');
    expect(DATA.faction).toBe('Adeptus Mechanicus');
    expect(DATA.sourceUrl).toBe('https://wahapedia.ru/kill-team3/kill-teams/hunter-clade/');
    expect(DATA.datacards).toHaveLength(14);
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE.doctrina]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual([
      SP.debilitatingIrradiation,
      SP.neurostaticInterference,
      SP.scoutingProtocol,
      SP.accelerantAgents,
    ]);
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual([
      FP.controlEdict,
      FP.scrapcodeOverload,
      FP.commandOverride,
      FP.omnissiahsImperative,
    ]);
    expect(DATA.equipment.map((e) => e.id)).toEqual([
      EQ.radBombardment,
      EQ.redundancySystems,
      EQ.refractorField,
      EQ.extremisMindLink,
    ]);
    // Every ploy costs 1CP.
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(p.cp).toBe(1);
  });

  it('prints NO rare weapon rules', () => {
    expect(DATA.rareWeaponRules).toEqual([]);
  });

  it('every datacard is HUNTER CLADE IMPERIUM ADEPTUS MECHANICUS with APL 2 and Move 6"', () => {
    for (const card of DATA.datacards) {
      expect(card.keywords.slice(0, 3)).toEqual(['HUNTER CLADE', 'IMPERIUM', 'ADEPTUS MECHANICUS']);
      expect(card).toMatchObject({ apl: 2, move: 6, save: 4 });
    }
    // The four LEADERs are the four PRINCEPS/ALPHA rows.
    expect(DATA.datacards.filter((c) => c.keywords.includes('LEADER')).map((c) => c.id).sort()).toEqual(
      [CARD.infiltratorPrinceps, CARD.rangerAlpha, CARD.ruststalkerPrinceps, CARD.vanguardAlpha].sort(),
    );
  });

  it('pins wounds and bases: SICARIAN 40mm (11/10 wounds), SKITARII 25mm (8/7 wounds)', () => {
    const w = (id: string): { wounds: number; mm: number | [number, number] } => {
      const c = DATA.datacards.find((x) => x.id === id)!;
      return { wounds: c.wounds, mm: c.base.mm };
    };
    expect(w(CARD.ruststalkerPrinceps)).toEqual({ wounds: 11, mm: 40 });
    expect(w(CARD.infiltratorPrinceps)).toEqual({ wounds: 11, mm: 40 });
    expect(w(CARD.infiltratorWarrior)).toEqual({ wounds: 10, mm: 40 });
    expect(w(CARD.ruststalkerWarrior)).toEqual({ wounds: 10, mm: 40 });
    expect(w(CARD.rangerAlpha)).toEqual({ wounds: 8, mm: 25 });
    expect(w(CARD.vanguardAlpha)).toEqual({ wounds: 8, mm: 25 });
    for (const id of [
      CARD.rangerDiktat,
      CARD.rangerGunner,
      CARD.rangerSurveyor,
      CARD.rangerWarrior,
      CARD.vanguardDiktat,
      CARD.vanguardGunner,
      CARD.vanguardSurveyor,
      CARD.vanguardWarrior,
    ])
      expect(w(id)).toEqual({ wounds: 7, mm: 25 });
  });

  it('pins the GUNNER weapon profiles: plasma caliver and transuranic arquebus each have two', () => {
    const caliver = DATA.datacards.find((c) => c.id === CARD.rangerGunner)!.weapons.find((w) => w.name === 'Plasma caliver')!;
    expect(caliver.profiles.map((p) => p.name)).toEqual(['standard', 'supercharge']);
    expect(caliver.profiles[1]).toMatchObject({ atk: 4, hit: 3, dmgN: 5, dmgC: 6 });
    expect(caliver.profiles[1]!.rules.map((r) => r.raw)).toEqual(['Hot', 'Lethal 5+', 'Piercing 1']);
    const arquebus = DATA.datacards
      .find((c) => c.id === CARD.vanguardGunner)!
      .weapons.find((w) => w.name === 'Transuranic arquebus')!;
    expect(arquebus.profiles.map((p) => p.name)).toEqual(['mobile', 'stationary']);
    expect(arquebus.profiles[1]).toMatchObject({ atk: 4, hit: 2, dmgN: 4, dmgC: 3 });
    expect(arquebus.profiles[1]!.rules.map((r) => r.raw)).toEqual(['Devastating 3', 'Heavy', 'Piercing 1', 'Severe']);
  });

  it('pins the SKITARII rifles and the SICARIAN melee weapons', () => {
    expect(profileOf(CARD.rangerWarrior, 'Galvanic rifle')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(CARD.rangerWarrior, 'Galvanic rifle').rules.map((r) => r.raw)).toEqual([
      'Heavy (Reposition only)',
      'Piercing Crits 1',
    ]);
    expect(profileOf(CARD.vanguardWarrior, 'Radium carbine')).toMatchObject({ atk: 4, hit: 3, dmgN: 2, dmgC: 4 });
    expect(profileOf(CARD.ruststalkerPrinceps, 'Chordclaw & transonic blades')).toMatchObject({
      atk: 5,
      hit: 3,
      dmgN: 4,
      dmgC: 6,
    });
    expect(profileOf(CARD.ruststalkerWarrior, 'Transonic blades').rules.map((r) => r.raw)).toEqual(['Rending']);
  });

  it('has 20 printed datacard abilities (8 distinct) and 4 unique actions (SIGNAL ×2, SPOT ×2)', () => {
    const abilities = DATA.datacards.flatMap((c) => c.abilities);
    expect(abilities).toHaveLength(20);
    expect(new Set(abilities.map((a) => a.name)).size).toBe(8);
    const actions = DATA.datacards.flatMap((c) => c.uniqueActions);
    expect(actions.map((a) => a.id).sort()).toEqual(
      [ACT.rangerSignal, ACT.rangerSpot, ACT.vanguardSignal, ACT.vanguardSpot].sort(),
    );
    for (const a of actions) expect(a.ap).toBe(1);
  });

  it('every id the module names exists in the JSON', () => {
    for (const id of Object.values(CARD)) expect(DATA.datacards.some((c) => c.id === id)).toBe(true);
    for (const id of Object.values(AB))
      expect(DATA.datacards.some((c) => c.abilities.some((a) => a.id === id))).toBe(true);
    for (const id of Object.values(ACT))
      expect(DATA.datacards.some((c) => c.uniqueActions.some((a) => a.id === id))).toBe(true);
  });

  it("notes[] records the one thing the scraper flagged (the WARRIOR SICARIAN row's missing datacard link)", () => {
    expect(NOTES).toHaveLength(1);
    expect(NOTES[0]).toContain("selection entry 'WARRIOR SICARIAN' has no datacard link");
  });

  // ---- DATA BUGS ---------------------------------------------------------
  it('DATA BUG: both GUNNER rows print "Arc rifle, plasma caliver or transuranic arquebus" as ONE loadout', () => {
    for (const role of ['SKITARII RANGER GUNNER', 'SKITARII VANGUARD GUNNER']) {
      const row = RAW.selection.list.find((r) => r.role === role)!;
      expect(row.loadouts).toHaveLength(1);
      // The label carries all three alternatives, the `weapons` array is EMPTY, and the split
      // survives only in an unread `choiceGroups`.
      expect(row.loadouts[0]!.label).toBe('Arc rifle, plasma caliver or transuranic arquebus');
      expect(row.loadouts[0]!.weapons).toEqual([]);
      expect(row.loadouts[0]!.choiceGroups).toEqual([['Arc rifle', 'Plasma caliver', 'Transuranic arquebus']]);
      // …and all three land in `alwaysWeapons`, which `weaponsForPick` reads unconditionally.
      expect(row.alwaysWeapons).toEqual(['Arc rifle', 'Plasma caliver', 'Transuranic arquebus']);
    }
    const index = ENTRIES.findIndex((e) => e.role === 'SKITARII RANGER GUNNER');
    expect(weaponsForPick(DATA, ENTRIES[index]!, pick('SKITARII RANGER GUNNER'))).toEqual([
      'Arc rifle',
      'Plasma caliver',
      'Transuranic arquebus',
      'Gun butt',
    ]);
  });

  it('DATA BUG: SPOT is truncated to its lead-in on BOTH SURVEYOR datacards', () => {
    for (const [cardId, actionId] of [
      [CARD.rangerSurveyor, ACT.rangerSpot],
      [CARD.vanguardSurveyor, ACT.vanguardSpot],
    ] as const) {
      const printed = actionOf(cardId, actionId).text;
      expect(printed).toContain('you can use this effect. If you do:');
      // The bullet list that should follow the colon is absent: the next sentence is the
      // action's own restriction, not an effect.
      const after = printed.slice(printed.indexOf('If you do:') + 'If you do:'.length).trim();
      expect(after).toBe('This operative cannot perform this action while within control range of an enemy operative.');
      expect(REMINDER_ONLY[`${actionId}.effect`]).toBeDefined();
    }
  });

  it('the section overrun is trimmed at load, so the last ploy of each section quotes only itself', () => {
    expect(ruleText(SP.accelerantAgents)).not.toContain('Firefight Ploys');
    expect(ruleText(SP.accelerantAgents).endsWith('one of them can be free.')).toBe(true);
    expect(ruleText(FP.omnissiahsImperative)).not.toContain('Faction Equipment');
  });
});

// ===========================================================================
describe('selection requirements', () => {
  it('defaultRoster is legal — 10 operatives — but fields only 6 of the 14 datacards (D-042)', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(10);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    const fielded = new Set(picks.map((p) => p.datacardId));
    expect([...fielded].sort()).toEqual(
      [
        CARD.infiltratorPrinceps,
        CARD.infiltratorWarrior,
        CARD.rangerDiktat,
        CARD.rangerGunner,
        CARD.rangerSurveyor,
        CARD.rangerWarrior,
      ].sort(),
    );
    // Never fielded: every VANGUARD, every RUSTSTALKER, the RANGER ALPHA.
    expect(DATA.datacards.map((c) => c.id).filter((id) => !fielded.has(id)).sort()).toEqual(
      [
        CARD.ruststalkerPrinceps,
        CARD.rangerAlpha,
        CARD.vanguardAlpha,
        CARD.ruststalkerWarrior,
        CARD.vanguardDiktat,
        CARD.vanguardGunner,
        CARD.vanguardSurveyor,
        CARD.vanguardWarrior,
      ].sort(),
    );
  });

  it('the printed constraints are exactly the eight the page prints', () => {
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['GUNNER', 'WARRIOR'] },
      { kind: 'maxCount', role: 'DIKTAT', max: 1 },
      { kind: 'maxCount', role: 'SURVEYOR', max: 1 },
      { kind: 'maxCount', role: 'SICARIAN', max: 5 },
      { kind: 'maxItem', item: 'arc rifle', max: 1 },
      { kind: 'maxItem', item: 'plasma caliver', max: 1 },
      { kind: 'maxItem', item: 'transuranic arquebus', max: 1 },
      { kind: 'groupCap', group: '*', max: 7 },
    ]);
    expect(DATA.selection.rawText).toContain(
      'Other than GUNNER and WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
    expect(DATA.selection.rawText).toContain(
      'Your kill team can only include up to one DIKTAT operative, up to one SURVEYOR operative and up to five SICARIAN operatives.',
    );
  });

  it('uniqueExcept exempts the prefixed GUNNER and WARRIOR rows (D-037/D-038) but nothing else', () => {
    // Four WARRIOR INFILTRATORs is legal — the printed rows are prefixed and the list has no row
    // named exactly "WARRIOR", so the keyword fallback fires.
    expect(validateRosterFor(DATA, defaultRoster(DATA)).ok).toBe(true);
    expect(defaultRoster(DATA).filter((p) => p.datacardId === CARD.infiltratorWarrior)).toHaveLength(4);
    // Two SKITARII RANGER DIKTATs is not.
    const dup = [
      pick('SICARIAN INFILTRATOR PRINCEPS'),
      pick('SKITARII RANGER DIKTAT'),
      pick('SKITARII RANGER DIKTAT'),
      pick('RANGER WARRIOR'),
      pick('RANGER WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('WARRIOR SICARIAN'),
    ];
    expect(validateRosterFor(DATA, dup).codes).toContain('unique');
  });

  it('the DIKTAT, SURVEYOR and SICARIAN caps all fire through the keyword fallback (D-029)', () => {
    const base = (...rows: [string, number][]): RosterPickIn[] => rows.flatMap(([r, n]) => Array.from({ length: n }, (_, i) => pick(r, i)));
    // No row is named exactly DIKTAT / SURVEYOR / SICARIAN — they are datacard KEYWORDS.
    for (const role of ['DIKTAT', 'SURVEYOR', 'SICARIAN'])
      expect(ENTRIES.some((e) => e.role === role)).toBe(false);
    const twoDiktats = [
      pick('SICARIAN INFILTRATOR PRINCEPS'),
      ...base(['SKITARII RANGER DIKTAT', 1], ['SKITARII VANGUARD DIKTAT', 1], ['RANGER WARRIOR', 2], ['VANGUARD WARRIOR', 3], ['WARRIOR SICARIAN', 2]),
    ];
    expect(validateRosterFor(DATA, twoDiktats).errors.join(' ')).toContain('more than 1 DIKTAT');
    const twoSurveyors = [
      pick('SICARIAN INFILTRATOR PRINCEPS'),
      ...base(['SKITARII RANGER SURVEYOR', 1], ['SKITARII VANGUARD SURVEYOR', 1], ['RANGER WARRIOR', 2], ['VANGUARD WARRIOR', 3], ['WARRIOR SICARIAN', 2]),
    ];
    expect(validateRosterFor(DATA, twoSurveyors).errors.join(' ')).toContain('more than 1 SURVEYOR');
    const sixSicarians = [
      pick('SICARIAN INFILTRATOR PRINCEPS'),
      ...base(['WARRIOR INFILTRATOR', 3], ['WARRIOR SICARIAN', 2], ['RANGER WARRIOR', 2], ['VANGUARD WARRIOR', 2]),
    ];
    expect(validateRosterFor(DATA, sixSicarians).errors.join(' ')).toContain('more than 5 SICARIAN');
  });

  it('the weapon caps fire — and the GUNNER data bug makes TWO GUNNERs illegal, which the card allows', () => {
    const two = [
      pick('SICARIAN INFILTRATOR PRINCEPS'),
      pick('SKITARII RANGER GUNNER'),
      pick('SKITARII VANGUARD GUNNER'),
      pick('SKITARII RANGER DIKTAT'),
      pick('SKITARII RANGER SURVEYOR'),
      pick('RANGER WARRIOR'),
      pick('RANGER WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('WARRIOR SICARIAN'),
    ];
    const v = validateRosterFor(DATA, two);
    expect(v.ok).toBe(false);
    // All THREE caps break at once, because each GUNNER resolves with all three weapons.
    expect(v.errors.filter((e) => e.includes('can only include up to 1'))).toHaveLength(3);
    // The printed footnote cap of 7 starred operatives is exactly 5 SICARIAN + 2 GUNNER, which is
    // why the loadout bug matters: with one GUNNER the cap can never be reached.
    expect(DATA.selection.footnotes['*']).toBe('You cannot select more than seven of these operatives combined.');
    expect(ENTRIES.filter((e) => e.footnoteGroup === '*').map((e) => e.role)).toEqual([
      'WARRIOR INFILTRATOR',
      'WARRIOR SICARIAN',
      'SKITARII RANGER GUNNER',
      'SKITARII VANGUARD GUNNER',
    ]);
  });

  it('the GUNNER exemption itself fires: two RANGER GUNNERs break only the weapon caps', () => {
    const two = [
      pick('SICARIAN INFILTRATOR PRINCEPS'),
      pick('SKITARII RANGER GUNNER'),
      pick('SKITARII RANGER GUNNER'),
      pick('SKITARII RANGER DIKTAT'),
      pick('SKITARII RANGER SURVEYOR'),
      pick('RANGER WARRIOR'),
      pick('RANGER WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('VANGUARD WARRIOR'),
      pick('WARRIOR SICARIAN'),
    ];
    const codes = validateRosterFor(DATA, two).codes;
    expect(codes).not.toContain('unique'); // "Other than GUNNER and WARRIOR operatives…"
    expect(codes.filter((c) => c === 'maxItem')).toHaveLength(3);
  });

  it('the groupCap is checked (8 starred operatives is refused)', () => {
    const eight = [
      pick('SKITARII RANGER ALPHA'),
      pick('WARRIOR INFILTRATOR', 0),
      pick('WARRIOR INFILTRATOR', 1),
      pick('WARRIOR INFILTRATOR', 0),
      pick('WARRIOR INFILTRATOR', 1),
      pick('WARRIOR SICARIAN', 0),
      pick('WARRIOR SICARIAN', 1),
      pick('WARRIOR SICARIAN', 0),
      pick('SKITARII RANGER GUNNER'),
      pick('RANGER WARRIOR'),
    ];
    expect(validateRosterFor(DATA, eight).codes).toContain('groupCap');
  });

  it('every coverage roster used by these tests is legal, and together they field all 14 datacards', () => {
    const fielded = new Set<string>();
    for (const roster of [COVERAGE, RUSTSTALKER_LED, RANGER_LED, INFILTRATOR_LED, VANGUARD_LED, defaultRoster(DATA)]) {
      const v = validateRosterFor(DATA, roster);
      expect(v.errors).toEqual([]);
      for (const p of roster) fielded.add(p.datacardId);
    }
    // 13 of the 14: the SKITARII VANGUARD GUNNER can never join a roster that already has the
    // RANGER GUNNER, because the loadout bug gives every GUNNER all three capped weapons.
    expect(fielded.size).toBe(13);
    expect(fielded.has(CARD.vanguardGunner)).toBe(false);
  });

  it("`loadoutMode: 'either'` is not honoured by the shared validator — an ALPHA must take BOTH branches", () => {
    const index = ENTRIES.findIndex((e) => e.role === 'SKITARII RANGER ALPHA');
    const entry = ENTRIES[index]!;
    expect(entry.loadoutMode).toBe('either');
    expect(entry.loadouts.map((l) => l.label)).toEqual([
      'Galvanic rifle; gun butt',
      'Master-crafted radium pistol; power weapon',
    ]);
    // Taking only the printed "Galvanic rifle; gun butt" branch is reported as two missing choices.
    const loadoutOnly: RosterPickIn = {
      datacardId: entry.datacardId,
      entryId: entryId(DATA, index),
      loadoutIds: [entry.loadouts[0]!.id],
    };
    expect(validateRosterFor(DATA, [loadoutOnly]).codes.filter((c) => c === 'loadout')).toHaveLength(2);
    // …so the legal pick carries four weapons instead of the printed two.
    expect(weaponsForPick(DATA, entry, pick('SKITARII RANGER ALPHA'))).toEqual([
      'Arc pistol',
      'Galvanic rifle',
      'Arc maul',
      'Gun butt',
    ]);
  });
});

// ===========================================================================
describe('Doctrina Imperatives (faction rule)', () => {
  it('the five DOCTRINA IMPERATIVEs are sliced out of the printed faction rule, never retyped', () => {
    const printed = ruleText(RULE.doctrina);
    for (const imp of IMPERATIVES) {
      expect(printed).toContain(IMPERATIVE_TEXT[imp]);
      expect(IMPERATIVE_TEXT[imp].startsWith(IMPERATIVE_LABEL[imp])).toBe(true);
      expect(printed).toContain(OPTIMISATION[imp]);
      expect(printed).toContain(DEPRECATION[imp]);
    }
    expect(OPTIMISATION.protector).toBe(
      'Optimisation: Friendly HUNTER CLADE operatives’ ranged weapons have the Ceaseless weapon rule.',
    );
    expect(DEPRECATION.neutral).toBe('Deprecation: None.');
  });

  it('is ONE STRATEGIC GAMBIT with a five-way choice: five options, and none afterwards', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    for (const imp of IMPERATIVES) expect(ids).toContain(imperativeGambitId(imp));
    const after = useImperative(ctx, state, 'p1', 'protector');
    after.phase = 'strategy';
    after.strategyStep = 'gambit';
    const left = gambitOptions(ctx, after, 'p1').map((o) => o.id);
    expect(left.filter((id) => id.startsWith(`${RULE.doctrina}:`))).toEqual([]);
    // …and it costs no CP: it is the faction rule, not one of the four strategy ploys.
    expect(after.teams.p1.cp).toBe(state.teams.p1.cp);
  });

  it('Protector: ranged weapons gain Ceaseless and melee Hit is worsened by 1', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'protector');
    const id = opWith(s, 'p1', CARD.rangerWarrior);
    const op = s.operatives[id]!;
    expect(imperativeOf(s, op, 'p1')).toBe('protector');
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    expect(
      effectiveRules(ctx, s, rifle, { operative: op, weaponName: 'Galvanic rifle' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(true);
    // The Deprecation only bites while the operative is rolling MELEE attack dice.
    const butt = profileOf(CARD.rangerWarrior, 'Gun butt');
    const foe = s.operatives[opWith(s, 'p2', CARD.rangerWarrior)]!;
    expect(hitOf(ctx, s, op, butt)).toBe(butt.hit);
    s.sequence = fightSeqOf({
      attackerId: op.id,
      defenderId: foe.id,
      attackerWeapon: 'Gun butt',
      attacker: 'p1',
      defender: 'p2',
    });
    expect(hitOf(ctx, s, op, butt)).toBe(butt.hit + 1); // worsened by 1
  });

  it('"This isn\'t cumulative with being injured" — an injured operative takes only the injured penalty', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'protector');
    const id = opWith(s, 'p1', CARD.rangerWarrior);
    const op = s.operatives[id]!;
    const foe = s.operatives[opWith(s, 'p2', CARD.rangerWarrior)]!;
    const butt = profileOf(CARD.rangerWarrior, 'Gun butt');
    s.sequence = fightSeqOf({
      attackerId: op.id,
      defenderId: foe.id,
      attackerWeapon: 'Gun butt',
      attacker: 'p1',
      defender: 'p2',
    });
    op.wounds = 3; // fewer than half of 7 — injured
    expect(DEPRECATION.protector).toContain('This isn’t cumulative with being injured.');
    expect(hitOf(ctx, s, op, butt)).toBe(butt.hit + 1); // the injured -1 only, not -2
  });

  it('Conqueror: melee weapons gain Ceaseless and ranged Hit is worsened by 1', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'conqueror');
    const id = opWith(s, 'p1', CARD.rangerWarrior);
    const op = s.operatives[id]!;
    const butt = profileOf(CARD.rangerWarrior, 'Gun butt');
    expect(effectiveRules(ctx, s, butt, { operative: op, weaponName: 'Gun butt' }).some((r) => r.id === 'Ceaseless')).toBe(
      true,
    );
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    expect(hitOf(ctx, s, op, rifle)).toBe(rifle.hit);
    s.sequence = shootSeqOf({
      attackerId: op.id,
      targetId: opWith(s, 'p2', CARD.rangerWarrior),
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Galvanic rifle',
    });
    expect(hitOf(ctx, s, op, rifle)).toBe(rifle.hit + 1);
    // …and the ranged weapon does NOT gain Ceaseless under Conqueror.
    expect(effectiveRules(ctx, s, rifle, { operative: op, weaponName: 'Galvanic rifle' }).some((r) => r.id === 'Ceaseless')).toBe(
      false,
    );
  });

  it('Bulwark: "Normal Dmg of 3 or more inflicts 1 less damage" — once per normal success', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'bulwark');
    const target = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    const shooter = s.operatives[opWith(s, 'p2', CARD.rangerGunner)]!;
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle'); // dmgN 4 / dmgC 5
    s.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      attack: pool([4, 5], 3), // two normal successes
    });
    const before = target.wounds;
    inflictDamage(ctx, s, target, 2 * arc.dmgN);
    expect(before - target.wounds).toBe(2 * arc.dmgN - 2); // 8 -> 6
    // A Normal Dmg of 2 is untouched.
    const carbine = profileOf(CARD.vanguardWarrior, 'Radium carbine'); // dmgN 2
    const shooter2 = s.operatives[opWith(s, 'p2', CARD.vanguardWarrior)]!;
    s.sequence = shootSeqOf({
      attackerId: shooter2.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Radium carbine',
      attack: pool([4], 3),
    });
    const mid = target.wounds;
    inflictDamage(ctx, s, target, carbine.dmgN);
    expect(mid - target.wounds).toBe(carbine.dmgN);
  });

  it('Bulwark Deprecation subtracts 1" from Move; Aggressor adds 1"', () => {
    const { ctx, state } = setup();
    const bulwark = useImperative(ctx, state, 'p1', 'bulwark');
    const id = opWith(bulwark, 'p1', CARD.rangerWarrior);
    expect(moveOf(ctx, bulwark, bulwark.operatives[id]!)).toBe(5);
    const { ctx: ctx2, state: state2 } = setup();
    const aggressor = useImperative(ctx2, state2, 'p1', 'aggressor');
    const id2 = opWith(aggressor, 'p1', CARD.rangerWarrior);
    expect(moveOf(ctx2, aggressor, aggressor.operatives[id2]!)).toBe(7);
    expect(OPTIMISATION.aggressor).toContain('Add 1" to the Move stat');
  });

  it('Aggressor Deprecation worsens the Save stat by 1', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'aggressor');
    const op = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    expect(saveOf(ctx, s, op)).toBe(5); // printed 4+, worsened by 1
  });

  it('Neutral changes nothing at all ("Optimisation: None. Deprecation: None.")', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'neutral');
    const op = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    expect(imperativeOf(s, op, 'p1')).toBe('neutral');
    expect(moveOf(ctx, s, op)).toBe(6);
    expect(saveOf(ctx, s, op)).toBe(4);
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    expect(
      effectiveRules(ctx, s, rifle, { operative: op, weaponName: 'Galvanic rifle' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(false);
  });

  it('the imperative lasts "until the Ready step of the next Strategy phase"', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'aggressor');
    const op = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    expect(moveOf(ctx, s, op)).toBe(7);
    const next = reduce(reduce(s, { t: 'AdvancePhase' }, ctx).state, { t: 'AdvancePhase' }, ctx).state;
    expect(next.effects.some((e) => e.rule === 'hunter-clade.imperative')).toBe(false);
    expect(moveOf(ctx, next, next.operatives[op.id]!)).toBe(6);
  });

  it('the Primary Mode is a pure setter (D-017) and waives the Deprecation once per battle', () => {
    const { ctx, state } = setup();
    expect(primaryMode(state, 'p1')).toBeUndefined();
    setPrimaryMode(state, 'p1', 'aggressor');
    expect(primaryMode(state, 'p1')).toBe('aggressor');
    const s = useImperative(ctx, state, 'p1', 'aggressor');
    const op = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    // Optimisation still applies; the Save Deprecation is ignored.
    expect(moveOf(ctx, s, op)).toBe(7);
    expect(saveOf(ctx, s, op)).toBe(4);
    expect(deprecationOf(s, op, 'p1')).toBeUndefined();
    expect(ruleText(RULE.doctrina)).toContain(
      'Once per battle, when you select the DOCTRINA IMPERATIVE that’s your kill team’s Primary Mode, you can ignore its Deprecation rule.',
    );
  });

  it('the Primary Mode waiver is once per BATTLE — the second selection deprecates as normal', () => {
    const { ctx, state } = setup();
    setPrimaryMode(state, 'p1', 'aggressor');
    let s = useImperative(ctx, state, 'p1', 'aggressor');
    expect(saveOf(ctx, s, s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!)).toBe(4);
    s = reduce(reduce(s, { t: 'AdvancePhase' }, ctx).state, { t: 'AdvancePhase' }, ctx).state;
    s = useImperative(ctx, s, 'p1', 'aggressor');
    expect(saveOf(ctx, s, s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!)).toBe(5);
  });

  it('a DOCTRINA IMPERATIVE reaches only "friendly HUNTER CLADE operatives"', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'aggressor');
    const mine = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    const theirs = s.operatives[opWith(s, 'p2', CARD.rangerWarrior)]!;
    expect(moveOf(ctx, s, mine)).toBe(7);
    expect(moveOf(ctx, s, theirs)).toBe(6);
    expect(imperativeOf(s, theirs, 'p1')).toBe('aggressor'); // the reader is scoped by player…
    expect(imperativeOf(s, theirs, 'p2')).toBeUndefined(); // …and p2 selected nothing
  });

  it('Bulwark also reduces a melee strike of Normal Dmg 3 or more', () => {
    const { ctx, state } = setup({ picks: RUSTSTALKER_LED, foePicks: RUSTSTALKER_LED });
    const s = useImperative(ctx, state, 'p1', 'bulwark');
    const target = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    const striker = s.operatives[opWith(s, 'p2', CARD.ruststalkerWarrior)]!;
    const blades = profileOf(CARD.ruststalkerWarrior, 'Transonic blades'); // dmgN 4 / dmgC 6
    s.sequence = fightSeqOf({
      attackerId: striker.id,
      defenderId: target.id,
      attackerWeapon: 'Transonic blades',
      attacker: 'p2',
      defender: 'p1',
    });
    const before = target.wounds;
    inflictDamage(ctx, s, target, blades.dmgN);
    expect(before - target.wounds).toBe(blades.dmgN - 1);
    // A critical strike is Critical Dmg, not Normal Dmg — untouched.
    const mid = target.wounds;
    inflictDamage(ctx, s, target, blades.dmgC);
    expect(mid - target.wounds).toBe(blades.dmgC);
  });

  it('without a Primary Mode nothing is waived', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'aggressor');
    const op = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    expect(deprecationOf(s, op, 'p1')).toBe('aggressor');
    expect(saveOf(ctx, s, op)).toBe(5);
    expect(REMINDER_ONLY[`${RULE.doctrina}.primaryMode`]).toContain('no decision channel');
  });
});

// ===========================================================================
describe('datacard abilities', () => {
  it('Canticle of Destruction: the first critical strike of a nearby RUSTSTALKER inflicts 1 more', () => {
    const { ctx, state } = setup({ picks: RUSTSTALKER_LED, foePicks: RUSTSTALKER_LED });
    const princeps = place(state, opWith(state, 'p1', CARD.ruststalkerPrinceps), 10, 10);
    const striker = place(state, opWith(state, 'p1', CARD.ruststalkerWarrior), 11, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 11.6, 10);
    isolate(state, [princeps.id, striker.id, foe.id]);
    expect(abilityText(CARD.ruststalkerPrinceps, AB.canticleOfDestruction)).toContain('inflict 1 additional damage');
    state.sequence = fightSeqOf({
      attackerId: striker.id,
      defenderId: foe.id,
      attackerWeapon: 'Chordclaw & transonic razor',
      attacker: 'p1',
      defender: 'p2',
    });
    const blades = profileOf(CARD.ruststalkerWarrior, 'Chordclaw & transonic razor');
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(striker, foe, blades, 'Chordclaw & transonic razor', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(before - foe.wounds).toBe(1);
    // "the first time you strike with a critical success during that sequence" — only once.
    const mid = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(striker, foe, blades, 'Chordclaw & transonic razor', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(mid - foe.wounds).toBe(0);
  });

  it('Canticle of Destruction needs the PRINCEPS within 3" of the RUSTSTALKER', () => {
    const { ctx, state } = setup({ picks: RUSTSTALKER_LED, foePicks: RUSTSTALKER_LED });
    const princeps = place(state, opWith(state, 'p1', CARD.ruststalkerPrinceps), 2, 2);
    const striker = place(state, opWith(state, 'p1', CARD.ruststalkerWarrior), 15, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 15.6, 10);
    isolate(state, [princeps.id, striker.id, foe.id]);
    state.sequence = fightSeqOf({
      attackerId: striker.id,
      defenderId: foe.id,
      attackerWeapon: 'Transonic blades',
      attacker: 'p1',
      defender: 'p2',
    });
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(striker, foe, profileOf(CARD.ruststalkerWarrior, 'Transonic blades'), 'Transonic blades', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBe(before);
  });

  it('Wasteland Stalker: an additional cover save, or one retained as a critical success', () => {
    const { ctx, state } = setup({ picks: RUSTSTALKER_LED, foePicks: RUSTSTALKER_LED });
    const target = state.operatives[opWith(state, 'p1', CARD.ruststalkerWarrior)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.rangerGunner)]!;
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle');
    expect(abilityText(CARD.ruststalkerWarrior, AB.wastelandStalkerWarrior)).toContain(
      'you can retain one additional cover save, or you can retain one cover save as a critical success instead',
    );
    // No retained crits: take the extra cover save.
    state.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      step: 'rollDefence',
      inCover: true,
      attack: pool([4, 5], 3),
    });
    let ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, arc, 'Arc rifle'),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(1);
    expect(ev.coverSaveAsCrit).toBe(false);
    // A retained critical success: take the crit cover save instead (only a crit blocks a crit).
    (state.sequence as ShootSequence).attack = pool([6, 4], 3);
    ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, arc, 'Arc rifle'),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.coverSaveAsCrit).toBe(true);
    // "This isn't cumulative with improved cover saves from Vantage terrain."
    (state.sequence as ShootSequence).vantageImprovedCover = true;
    ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, arc, 'Arc rifle'),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.coverSaveAsCrit).toBe(false);
    expect(ev.extraCoverSaves).toBe(0);
  });

  it('Canticle of Shroudpsalm: a concealed INFILTRATOR in cover within 3" cannot be a valid target', () => {
    const ctx = teamContext([hunterClade], { seed: 9 });
    const map = testMap({ features: [heavyBlock('cov', 15.2, 9, 1, 4, 1.2)] });
    ctx.maps.set(map.id, map);
    const state = battle({
      ctx,
      map,
      p1: { module: hunterClade, picks: INFILTRATOR_LED },
      p2: { module: hunterClade, picks: INFILTRATOR_LED },
    });
    const princeps = place(state, opWith(state, 'p1', CARD.infiltratorPrinceps), 13, 11);
    const hidden = place(state, opWith(state, 'p1', CARD.infiltratorWarrior), 14, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.rangerGunner), 22, 11);
    isolate(state, [princeps.id, hidden.id, shooter.id]);
    hidden.order = 'conceal';
    expect(abilityText(CARD.infiltratorPrinceps, AB.canticleOfShroudpsalm)).toContain(
      'taking precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"',
    );
    const emit = (): { valid: boolean; reason?: string } => {
      const ev = ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: shooter,
        target: hidden,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
      });
      return { valid: ev.valid, ...(ev.reason ? { reason: ev.reason } : {}) };
    };
    // In cover, concealed and within 3" of the PRINCEPS: not a valid target.
    expect(emit()).toMatchObject({ valid: false });
    expect(emit().reason).toContain('Canticle of Shroudpsalm');
    // An Engage order lifts it.
    hidden.order = 'engage';
    expect(emit().valid).toBe(true);
    hidden.order = 'conceal';
    // "…except being within 2"".
    place(state, shooter.id, 15.5, 11);
    expect(emit().valid).toBe(true);
    // And with the PRINCEPS more than 3" away it is silent.
    place(state, shooter.id, 22, 11);
    place(state, princeps.id, 2, 2);
    expect(emit().valid).toBe(true);
  });

  it('Canticle of Elimination: friendly RANGER ranged weapons within 3" of the ALPHA gain Punishing', () => {
    const { ctx, state } = setup({ picks: RANGER_LED, foePicks: RANGER_LED });
    const alpha = place(state, opWith(state, 'p1', CARD.rangerAlpha), 10, 10);
    const ranger = place(state, opWith(state, 'p1', CARD.rangerWarrior), 11, 10);
    isolate(state, [alpha.id, ranger.id]);
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    const has = (op: OperativeState): boolean =>
      effectiveRules(ctx, state, rifle, { operative: op, weaponName: 'Galvanic rifle' }).some((r) => r.id === 'Punishing');
    expect(has(ranger)).toBe(true);
    // The ALPHA is itself a RANGER 0" from itself.
    expect(has(alpha)).toBe(true);
    // Out of range: nothing.
    place(state, ranger.id, 20, 10);
    expect(has(ranger)).toBe(false);
    // A melee weapon never gains it.
    const butt = profileOf(CARD.rangerWarrior, 'Gun butt');
    place(state, ranger.id, 11, 10);
    expect(
      effectiveRules(ctx, state, butt, { operative: ranger, weaponName: 'Gun butt' }).some((r) => r.id === 'Punishing'),
    ).toBe(false);
  });

  it('Targeting Protocol: Lethal 5+ when it has not moved, or on a counteraction', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.rangerDiktat);
    const op = state.operatives[id]!;
    const rifle = profileOf(CARD.rangerDiktat, 'Galvanic rifle');
    const lethal = (): boolean =>
      effectiveRules(ctx, state, rifle, { operative: op, weaponName: 'Galvanic rifle' }).some(
        (r) => r.id === 'Lethal' && r.x === 5,
      );
    expect(lethal()).toBe(true);
    op.actionsThisActivation = ['Reposition'];
    expect(lethal()).toBe(false);
    // "or if it's a counteraction"
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    expect(lethal()).toBe(true);
    delete state.opState['counteract'];
    // "ranged weapons on its datacard" — a melee weapon never gains it.
    const butt = profileOf(CARD.rangerDiktat, 'Gun butt');
    op.actionsThisActivation = [];
    expect(
      effectiveRules(ctx, state, butt, { operative: op, weaponName: 'Gun butt' }).some((r) => r.id === 'Lethal'),
    ).toBe(false);
  });

  it('Rad-Saturation worsens an enemy Hit stat within 2" of a friendly VANGUARD, but not when injured', () => {
    const { ctx, state } = setup();
    const vanguard = place(state, opWith(state, 'p1', CARD.vanguardWarrior), 10, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 12, 10);
    isolate(state, [vanguard.id, foe.id]);
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    expect(abilityText(CARD.vanguardWarrior, `${CARD.vanguardWarrior}.rad-saturation`)).toContain(
      'worsen the Hit stat of that enemy operative’s weapons by 1',
    );
    expect(hitOf(ctx, state, foe, rifle)).toBe(rifle.hit + 1);
    // Out of 2": no penalty.
    place(state, foe.id, 16, 10);
    expect(hitOf(ctx, state, foe, rifle)).toBe(rifle.hit);
    // Injured and irradiated: only one penalty.
    place(state, foe.id, 12, 10);
    foe.wounds = 3;
    expect(hitOf(ctx, state, foe, rifle)).toBe(rifle.hit + 1);
  });

  it('Canticle of the Glow: -1 Atk on a rad-saturated enemy within 3" of the VANGUARD ALPHA', () => {
    const { ctx, state } = setup();
    const alpha = place(state, opWith(state, 'p1', CARD.vanguardAlpha), 10, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 11.5, 10);
    isolate(state, [alpha.id, foe.id]);
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    const target = state.operatives[opWith(state, 'p1', CARD.rangerWarrior)]!;
    const emit = () =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(foe, target, rifle, 'Galvanic rifle'),
        count: rifle.atk,
        mods: zeroStatMods(),
      });
    // The ALPHA is itself a VANGUARD, so it also rad-saturates the enemy within 2".
    expect(emit().mods.atk).toBe(-1);
    // Out of 3" of the ALPHA (and out of everyone's 2"): no change.
    place(state, foe.id, 20, 10);
    expect(emit().mods.atk).toBe(0);
  });

  it('Control Protocol: COMMAND OVERRIDE costs 0CP when the LEADER can see the operative', () => {
    const { ctx, state } = setup();
    const alpha = place(state, opWith(state, 'p1', CARD.vanguardAlpha), 10, 10);
    const other = place(state, opWith(state, 'p1', CARD.rangerWarrior), 12, 10);
    isolate(state, [alpha.id, other.id]);
    expect(abilityText(CARD.vanguardAlpha, `${CARD.vanguardAlpha}.control-protocol`)).toContain(
      'You can use the Command Override firefight ploy for 0CP',
    );
    const s = activate(ctx, state, other.id);
    const cp = s.teams.p1.cp;
    const after = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.commandOverride, data: { imperative: 'bulwark' } }, ctx);
    expect(after.ok).toBe(true);
    expect(after.state.teams.p1.cp).toBe(cp); // 1CP charged, 1CP refunded
    expect(imperativeOf(after.state, after.state.operatives[other.id]!, 'p1')).toBe('bulwark');
  });

  it('all 20 printed ability instances are covered by the eight bound rules', () => {
    const bound = new Set([
      'Canticle of Destruction',
      'Wasteland Stalker',
      'Control Protocol',
      'Canticle of Shroudpsalm',
      'Canticle of Elimination',
      'Targeting Protocol',
      'Canticle of the Glow',
      'Rad-Saturation',
    ]);
    const instances = DATA.datacards.flatMap((c) => c.abilities);
    expect(instances.filter((a) => !bound.has(a.name))).toEqual([]);
    expect(instances).toHaveLength(20);
    // …and the shared rules really are shared: the module tests them off the datacard, not off a
    // hard-coded card list.
    expect(instances.filter((a) => a.name === 'Targeting Protocol')).toHaveLength(5);
    expect(instances.filter((a) => a.name === 'Rad-Saturation')).toHaveLength(5);
    expect(instances.filter((a) => a.name === 'Control Protocol')).toHaveLength(4);
    expect(instances.filter((a) => a.name === 'Wasteland Stalker')).toHaveLength(2);
  });
});

// ===========================================================================
describe('strategy ploys', () => {
  it('DEBILITATING IRRADIATION subtracts 1 from the Normal Dmg stat, to a minimum of 3', () => {
    const { ctx, state } = setup();
    const s = useGambitPloy(ctx, state, 'p1', SP.debilitatingIrradiation);
    const target = place(s, opWith(s, 'p1', CARD.vanguardWarrior), 10, 10);
    const shooter = place(s, opWith(s, 'p2', CARD.rangerGunner), 11.5, 10);
    isolate(s, [target.id, shooter.id]);
    expect(ruleText(SP.debilitatingIrradiation)).toContain(
      'subtract 1 from the Normal Dmg stat of its weapons (to a minimum of 3)',
    );
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle'); // dmgN 4
    s.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      attack: pool([4], 3),
    });
    const before = target.wounds;
    inflictDamage(ctx, s, target, arc.dmgN);
    expect(before - target.wounds).toBe(arc.dmgN - 1);
    // A Normal Dmg of 3 is already at the printed minimum.
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle'); // dmgN 3
    const shooter2 = place(s, opWith(s, 'p2', CARD.rangerWarrior), 11.5, 11);
    s.sequence = shootSeqOf({
      attackerId: shooter2.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Galvanic rifle',
      attack: pool([4], 3),
    });
    const mid = target.wounds;
    inflictDamage(ctx, s, target, rifle.dmgN);
    expect(mid - target.wounds).toBe(rifle.dmgN);
  });

  it('DEBILITATING IRRADIATION needs the shooter to be under the Rad-Saturation rule', () => {
    const { ctx, state } = setup();
    const s = useGambitPloy(ctx, state, 'p1', SP.debilitatingIrradiation);
    const target = place(s, opWith(s, 'p1', CARD.vanguardWarrior), 10, 10);
    const shooter = place(s, opWith(s, 'p2', CARD.rangerGunner), 20, 10); // more than 2" from any VANGUARD
    isolate(s, [target.id, shooter.id]);
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle');
    s.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      attack: pool([4], 3),
    });
    const before = target.wounds;
    inflictDamage(ctx, s, target, arc.dmgN);
    expect(before - target.wounds).toBe(arc.dmgN);
  });

  it('NEUROSTATIC INTERFERENCE strips the opponent\'s attack-dice re-rolls within 6" of an INFILTRATOR', () => {
    const { ctx, state } = setup({ picks: INFILTRATOR_LED, foePicks: INFILTRATOR_LED });
    const s = useGambitPloy(ctx, state, 'p1', SP.neurostaticInterference);
    const infiltrator = place(s, opWith(s, 'p1', CARD.infiltratorWarrior), 10, 10);
    const shooter = place(s, opWith(s, 'p2', CARD.rangerGunner), 14, 10);
    const target = place(s, opWith(s, 'p1', CARD.rangerWarrior), 18, 10);
    isolate(s, [infiltrator.id, shooter.id, target.id]);
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle');
    const emit = () =>
      ctx.hooks.emit('onRollAttack', s, {
        state: s,
        ctx: attackCtx(shooter, target, arc, 'Arc rifle'),
        dice: [3, 4, 5, 6],
        rerolls: [{ id: 'x', label: 'Balanced', mode: 'one', max: 1, player: 'p2' }],
      });
    expect(emit().rerolls).toEqual([]);
    // Out of 6": untouched.
    place(s, infiltrator.id, 2, 2);
    expect(emit().rerolls).toHaveLength(1);
  });

  it('NEUROSTATIC INTERFERENCE reaches shooting only — the melee half is reminder-only (D-031)', () => {
    expect(ruleText(SP.neurostaticInterference)).toContain('is shooting, fighting or retaliating');
    expect(REMINDER_ONLY[`${SP.neurostaticInterference}.melee`]).toContain('D-031');
  });

  it('SCOUTING PROTOCOL grants a free Dash to each concealed RANGER more than 6" from enemies', () => {
    const { ctx, state } = setup({ picks: RANGER_LED, foePicks: RANGER_LED });
    state.turningPoint = 2;
    for (const id of state.teams.p1.operativeIds) place(state, id, 4, 4);
    for (const id of state.teams.p2.operativeIds) place(state, id, 26, 18);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.order = 'conceal';
    const s = useGambitPloy(ctx, state, 'p1', SP.scoutingProtocol);
    const rangers = state.teams.p1.operativeIds
      .map((id) => s.operatives[id]!)
      .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes('RANGER'));
    expect(rangers.length).toBeGreaterThan(0);
    for (const o of rangers) expect(s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === o.id)).toBe(true);
    // The free action is restricted to a Dash.
    const one = rangers[0]!;
    const activated = activate(ctx, s, one.id, 'conceal');
    const op = activated.operatives[one.id]!;
    op.apSpent = 2; // its own AP is gone; only the bonus AP is left
    expect(
      ctx.hooks.emit('canPerformAction', activated, { state: activated, operative: op, action: 'Dash', allowed: true })
        .allowed,
    ).toBe(true);
    expect(
      ctx.hooks.emit('canPerformAction', activated, { state: activated, operative: op, action: 'Shoot', allowed: true })
        .allowed,
    ).toBe(false);
  });

  it('SCOUTING PROTOCOL cannot be used during the first turning point', () => {
    const { ctx, state } = setup();
    state.turningPoint = 1;
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(ruleText(SP.scoutingProtocol)).toContain('You cannot use this ploy during the first turning point.');
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SP.scoutingProtocol);
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: SP.scoutingProtocol }, ctx).ok).toBe(false);
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(SP.scoutingProtocol);
  });

  it('ACCELERANT AGENTS lets a RUSTSTALKER perform two Fight actions, one of them free', () => {
    const { ctx, state } = setup({ picks: RUSTSTALKER_LED, foePicks: RUSTSTALKER_LED });
    const s = useGambitPloy(ctx, state, 'p1', SP.accelerantAgents);
    const meId = opWith(s, 'p1', CARD.ruststalkerWarrior);
    const me = place(s, meId, 10, 10);
    const foe = place(s, opWith(s, 'p2', CARD.rangerWarrior), 11.4, 10);
    isolate(s, [me.id, foe.id]);
    expect(ruleText(SP.accelerantAgents)).toBe(
      'During each friendly HUNTER CLADE RUSTSTALKER operative’s activation, it can perform two Fight actions, and one of them can be free.',
    );
    const cur = activate(ctx, s, meId);
    expect(cur.effects.some((e) => e.rule === 'hunter-clade.accelerantAgents' && e.operativeId === meId)).toBe(true);
    // "one of them can be free" — D-015's extra AP, restricted to a Fight.
    expect(cur.operatives[meId]!.aplMods).toContain(1);
    const def = getAction(FIGHT_ACCELERANT)!;
    // Before the first Fight the extra action is refused.
    expect(def.check(ctx, cur, cur.operatives[meId]!, { targetId: foe.id }).ok).toBe(false);
    cur.operatives[meId]!.actionsThisActivation = ['Fight']; // the first Fight has happened
    // A second universal Fight is refused by the action restriction…
    expect(act(ctx, cur, meId, 'Fight', { targetId: foe.id }).ok).toBe(false);
    // …and `Fight (Accelerant Agents)` is the printed second one, resolving as a real fight.
    expect(def.available!(ctx, cur, cur.operatives[meId]!)).toBe(true);
    const out = act(ctx, cur, meId, FIGHT_ACCELERANT, { targetId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.sequence?.kind === 'fight' || out.state.pending.length > 0).toBe(true);
  });

  it('`Fight (Accelerant Agents)` is refused without the gambit, and before the first Fight', () => {
    const { ctx, state } = setup({ picks: RUSTSTALKER_LED, foePicks: RUSTSTALKER_LED });
    const meId = opWith(state, 'p1', CARD.ruststalkerWarrior);
    const me = place(state, meId, 10, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 11.4, 10);
    isolate(state, [me.id, foe.id]);
    const def = getAction(FIGHT_ACCELERANT)!;
    const s = activate(ctx, state, meId);
    expect(def.available!(ctx, s, s.operatives[meId]!)).toBe(false);
    expect(def.check(ctx, s, s.operatives[meId]!, { targetId: foe.id }).ok).toBe(false);
  });
});

// ===========================================================================
describe('firefight ploys', () => {
  it('CONTROL EDICT pairs a LEADER with a nearby ready operative and activates them in succession', () => {
    const { ctx, state } = setup();
    const leader = place(state, opWith(state, 'p1', CARD.vanguardAlpha), 10, 10);
    const partner = place(state, opWith(state, 'p1', CARD.rangerWarrior), 12, 10);
    isolate(state, [leader.id, partner.id]);
    expect(ruleText(FP.controlEdict)).toContain(
      'When that first friendly operative you activate is expended, you can activate the other friendly operative before your opponent activates.',
    );
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.controlEdict, data: { leaderId: leader.id, operativeId: partner.id } }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'hunter-clade.controlEdictPair')).toBe(true);
    s = activate(ctx, s, leader.id);
    s = reduce(s, { t: 'EndActivation', operativeId: leader.id }, ctx).state;
    // The reducer handed the turn to p2; the ploy raises its own decision to take it back.
    expect(s.activePlayer).toBe('p2');
    const decision = s.pending.find((d) => d.kind === CONTROL_EDICT_DECISION);
    expect(decision).toBeDefined();
    s = reduce(
      s,
      { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'activate:engage', data: { operativeId: partner.id, order: 'engage' } },
      ctx,
    ).state;
    expect(s.activePlayer).toBe('p1');
    expect(s.activeOperativeId).toBe(partner.id);
    expect(s.operatives[partner.id]!.order).toBe('engage');
    expect(s.operatives[partner.id]!.apSpent).toBe(0);
  });

  it('CONTROL EDICT can be declined, leaving the opponent to activate as normal', () => {
    const { ctx, state } = setup();
    const leader = place(state, opWith(state, 'p1', CARD.vanguardAlpha), 10, 10);
    const partner = place(state, opWith(state, 'p1', CARD.rangerWarrior), 12, 10);
    isolate(state, [leader.id, partner.id]);
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.controlEdict, data: { leaderId: leader.id, operativeId: partner.id } }, ctx).state;
    s = activate(ctx, s, leader.id);
    s = reduce(s, { t: 'EndActivation', operativeId: leader.id }, ctx).state;
    const decision = s.pending.find((d) => d.kind === CONTROL_EDICT_DECISION)!;
    s = reduce(s, { t: 'ResolveDecision', decisionId: decision.id, optionId: 'decline' }, ctx).state;
    expect(s.activePlayer).toBe('p2');
    expect(s.activeOperativeId).toBeUndefined();
  });

  it('CONTROL EDICT: "you cannot select more than one HUNTER CLADE SICARIAN operative"', () => {
    const { ctx, state } = setup({ picks: INFILTRATOR_LED, foePicks: INFILTRATOR_LED });
    const leader = place(state, opWith(state, 'p1', CARD.infiltratorPrinceps), 10, 10);
    const sicarian = place(state, opWith(state, 'p1', CARD.infiltratorWarrior), 11, 10);
    const skitarii = place(state, opWith(state, 'p1', CARD.rangerWarrior), 11, 11);
    isolate(state, [leader.id, sicarian.id, skitarii.id]);
    expect(ruleText(FP.controlEdict)).toContain(
      'Whenever you use this ploy, you cannot select more than one HUNTER CLADE SICARIAN operative.',
    );
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.controlEdict, data: { leaderId: leader.id, operativeId: sicarian.id } }, ctx).state;
    const pair = s.effects.find((e) => e.rule === 'hunter-clade.controlEdictPair')!;
    const ids = pair.data!['ids'] as string[];
    // The SICARIAN PRINCEPS + SICARIAN WARRIOR pair is refused; the SKITARII partner is taken.
    expect(ids).toContain(leader.id);
    expect(ids).not.toContain(sicarian.id);
    expect(ids).toContain(skitarii.id);
  });

  it("CONTROL EDICT's `usable` refuses it when no ready operative is within 3\" of a ready LEADER", () => {
    const { ctx, state } = setup();
    const leader = place(state, opWith(state, 'p1', CARD.vanguardAlpha), 2, 2);
    for (const id of state.teams.p1.operativeIds) if (id !== leader.id) place(state, id, 20, 18);
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.controlEdict }, ctx).ok).toBe(false);
  });

  it('SCRAPCODE OVERLOAD treats the contesting enemy total APL as 1 lower', () => {
    const { ctx, state } = setup({ picks: INFILTRATOR_LED, foePicks: INFILTRATOR_LED });
    // The INFILTRATOR sits within 3" of the contesting enemy but out of the marker's own control
    // range, so the ploy — not the INFILTRATOR's APL — is what flips control.
    const infiltrator = place(state, opWith(state, 'p1', CARD.infiltratorWarrior), 14.5, 11);
    const mine = place(state, opWith(state, 'p1', CARD.rangerWarrior), 10.5, 11);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 11.5, 11);
    isolate(state, [infiltrator.id, mine.id, foe.id]);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 11, y: 11 }, z: 0, flags: {} };
    // Equal APL: nobody controls it.
    expect(markerController(ctx, state, state.markers['obj']!)).toBeNull();
    expect(ruleText(FP.scrapcodeOverload)).toContain(
      'treat the total APL stat of enemy operatives that contest it as 1 lower',
    );
    let s = activate(ctx, state, infiltrator.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.scrapcodeOverload }, ctx).state;
    expect(markerController(ctx, s, s.markers['obj']!)).toBe('p1');
  });

  it('SCRAPCODE OVERLOAD ends "until the start of that friendly operative\'s next activation"', () => {
    const { ctx, state } = setup({ picks: INFILTRATOR_LED, foePicks: INFILTRATOR_LED });
    const infiltrator = place(state, opWith(state, 'p1', CARD.infiltratorWarrior), 14.5, 11);
    isolate(state, [infiltrator.id]);
    expect(ruleText(FP.scrapcodeOverload)).toContain("Until the start of that friendly operative’s next activation");
    let s = activate(ctx, state, infiltrator.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.scrapcodeOverload }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'hunter-clade.scrapcode')).toBe(true);
    // Ending THIS activation does not end it…
    s = reduce(s, { t: 'EndActivation', operativeId: infiltrator.id }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'hunter-clade.scrapcode')).toBe(true);
    // …its NEXT activation does.
    s.operatives[infiltrator.id]!.ready = true;
    s.operatives[infiltrator.id]!.expended = false;
    s = activate(ctx, s, infiltrator.id);
    expect(s.effects.some((e) => e.rule === 'hunter-clade.scrapcode')).toBe(false);
  });

  it('COMMAND OVERRIDE gives ONE operative a different imperative from the kill team', () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'protector');
    const target = state.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    const other = state.operatives[opWith(s, 'p1', CARD.rangerDiktat)]!;
    isolate(s, []); // keep every LEADER far away, so Control Protocol does not refund
    const active = activate(ctx, s, target.id);
    const after = reduce(active, { t: 'UsePloy', player: 'p1', ployId: FP.commandOverride, data: { imperative: 'conqueror' } }, ctx).state;
    expect(imperativeOf(after, after.operatives[target.id]!, 'p1')).toBe('conqueror');
    expect(imperativeOf(after, after.operatives[other.id]!, 'p1')).toBe('protector');
    // Its Deprecation applies too — a COMMAND OVERRIDE is not the kill team's Primary Mode.
    expect(deprecationOf(after, after.operatives[target.id]!, 'p1')).toBe('conqueror');
  });

  it("OMNISSIAH'S IMPERATIVE — Protector: the operative's ranged weapons gain Severe", () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'protector');
    const id = opWith(s, 'p1', CARD.rangerWarrior);
    const active = activate(ctx, s, id);
    const after = reduce(active, { t: 'UsePloy', player: 'p1', ployId: FP.omnissiahsImperative }, ctx).state;
    expect(omnissiahOf(after, after.operatives[id]!, 'p1')).toBe('protector');
    expect(OMNISSIAH_TEXT.protector).toBe('Protector: This operative’s ranged weapons have the Severe weapon rule.');
    const rifle = profileOf(CARD.rangerWarrior, 'Galvanic rifle');
    expect(
      effectiveRules(ctx, after, rifle, { operative: after.operatives[id]!, weaponName: 'Galvanic rifle' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(true);
  });

  it("OMNISSIAH'S IMPERATIVE — Bulwark: Save improved by 1 and one additional defence dice", () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'bulwark');
    const id = opWith(s, 'p1', CARD.rangerWarrior);
    const active = activate(ctx, s, id);
    const after = reduce(active, { t: 'UsePloy', player: 'p1', ployId: FP.omnissiahsImperative }, ctx).state;
    const op = after.operatives[id]!;
    // Printed Save 4+, improved by 1 (Bulwark's own Deprecation is the -1" Move, not the Save).
    expect(saveOf(ctx, after, op)).toBe(3);
    expect(OMNISSIAH_TEXT.bulwark).toContain("Improve this operative’s Save stat by 1");
    const shooter = after.operatives[opWith(after, 'p2', CARD.rangerGunner)]!;
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle');
    after.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: op.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      step: 'rollDefence',
      attack: pool([4], 3),
    });
    const ev = ctx.hooks.emit('onDefenceDice', after, {
      state: after,
      ctx: attackCtx(shooter, op, arc, 'Arc rifle'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(4);
  });

  it("OMNISSIAH'S IMPERATIVE — Conqueror and Aggressor are reminder-only, with their engine reasons", () => {
    expect(OMNISSIAH_TEXT.conqueror).toContain('you can immediately resolve another (before your opponent)');
    expect(OMNISSIAH_TEXT.aggressor).toContain('ignore the first vertical distance of 2"');
    expect(REMINDER_ONLY[`${FP.omnissiahsImperative}.conqueror`]).toContain('seq.turn');
    expect(REMINDER_ONLY[`${FP.omnissiahsImperative}.aggressor`]).toContain('onMoveRules');
    expect(OMNISSIAH_TEXT.neutral).toBe('Neutral: None.');
  });

  it('COMMAND OVERRIDE and OMNISSIAH\'S IMPERATIVE are refused outside their printed windows', () => {
    const { ctx, state } = setup();
    expect(ruleText(FP.commandOverride)).toContain(
      'Use this firefight ploy when you activate a friendly HUNTER CLADE operative.',
    );
    // Nothing is activating and no friendly operative is being shot.
    expect(state.activeOperativeId).toBeUndefined();
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.commandOverride }, ctx).ok).toBe(false);
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.omnissiahsImperative }, ctx).ok).toBe(false);
  });

  it("OMNISSIAH'S IMPERATIVE's second window: an enemy shooting a friendly operative", () => {
    const { ctx, state } = setup();
    const s = useImperative(ctx, state, 'p1', 'protector');
    const target = s.operatives[opWith(s, 'p1', CARD.rangerWarrior)]!;
    const shooter = s.operatives[opWith(s, 'p2', CARD.rangerGunner)]!;
    expect(ruleText(FP.omnissiahsImperative)).toContain(
      'Alternatively, use it when an enemy operative is shooting a friendly HUNTER CLADE operative, at the end of the Roll Attack Dice step.',
    );
    s.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      attack: pool([4], 3),
    });
    const after = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.omnissiahsImperative }, ctx);
    expect(after.ok).toBe(true);
    expect(omnissiahOf(after.state, after.state.operatives[target.id]!, 'p1')).toBe('protector');
  });
});

// ===========================================================================
describe('faction equipment', () => {
  it('RAD BOMBARDMENT is a once-per-battle STRATEGIC GAMBIT, never in the first turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.radBombardment, EQ.refractorField] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    state.turningPoint = 1;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(EQ.radBombardment);
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.radBombardment);
    const after = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.radBombardment }, ctx).state;
    after.phase = 'strategy';
    after.strategyStep = 'gambit';
    after.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, after, 'p1').map((o) => o.id)).not.toContain(EQ.radBombardment);
  });

  it('RAD BOMBARDMENT: on a 4+ subtract 1 APL, on a 6 also inflict D3 damage', () => {
    const { ctx, state } = setup({ equipment: [EQ.radBombardment] });
    // Scripted from here on: a 6 for the first victim, a D3 of 2 (a scripted 3 or 4), then a 3.
    ctx.rng = new ScriptedRng([6, 3, 3]);
    state.turningPoint = 2;
    const foes = state.teams.p2.operativeIds.map((id) => state.operatives[id]!).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const o of foes) place(state, o.id, 2, 2);
    const a = place(state, foes[0]!.id, 11, 11);
    const b = place(state, foes[1]!.id, 11.4, 11);
    for (const id of state.teams.p1.operativeIds) place(state, id, 25, 18);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 11.2, y: 11 }, z: 0, flags: {} };
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const woundsA = a.wounds;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.radBombardment, data: { markerId: 'obj' } }, ctx).state;
    expect(ruleText(EQ.radBombardment)).toContain('on a 6, also inflict D3 damage on it (roll separately for each)');
    expect(s.operatives[a.id]!.wounds).toBe(woundsA - 2);
    expect(s.effects.some((e) => e.rule === 'hunter-clade.radBombardmentApl' && e.operativeId === a.id)).toBe(true);
    // The 3 fails the 4+.
    expect(s.effects.some((e) => e.rule === 'hunter-clade.radBombardmentApl' && e.operativeId === b.id)).toBe(false);
    // The APL loss "until the end of its next activation" rides `onStatMod`, not `aplMods`.
    expect(aplOf(ctx, s, s.operatives[a.id]!)).toBe(1);
    expect(s.operatives[a.id]!.aplMods).toEqual([]);
  });

  it('RAD BOMBARDMENT subtracts 1 from the roll for an operative underneath Vantage terrain', () => {
    const ctx = teamContext([hunterClade], { seed: 3 });
    const map = testMap({ features: [vantagePlatform('v', 9, 9, 5, 5)] });
    ctx.maps.set(map.id, map);
    const state = battle({
      ctx,
      map,
      p1: { module: hunterClade, picks: COVERAGE, equipment: [EQ.radBombardment] },
      p2: { module: hunterClade, picks: COVERAGE },
    });
    ctx.rng = new ScriptedRng([4]); // 4 - 1 (Vantage) = 3, which fails the printed 4+
    state.turningPoint = 2;
    const victim = place(state, state.teams.p2.operativeIds[0]!, 11, 11);
    for (const id of state.teams.p2.operativeIds.slice(1)) place(state, id, 27, 20);
    for (const id of state.teams.p1.operativeIds) place(state, id, 2, 2);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 11, y: 11 }, z: 0, flags: {} };
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(ruleText(EQ.radBombardment)).toContain(
      "subtract 1 if any part of that enemy operative’s base is underneath Vantage terrain",
    );
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.radBombardment, data: { markerId: 'obj' } }, ctx).state;
    expect(s.rolls.some((r) => r.kind === 'radBombardment')).toBe(true);
    expect(s.effects.some((e) => e.rule === 'hunter-clade.radBombardmentApl' && e.operativeId === victim.id)).toBe(false);
  });

  it('REDUNDANCY SYSTEMS restores D3+2 lost wounds once per turning point', () => {
    const { ctx, state } = setup({ equipment: [EQ.redundancySystems] });
    ctx.rng = new ScriptedRng([6]); // a D3 of 3
    const id = opWith(state, 'p1', CARD.rangerWarrior);
    const op = place(state, id, 10, 10);
    isolate(state, [id]);
    op.wounds = 2; // 5 lost of 7
    expect(ruleText(EQ.redundancySystems)).toContain('that friendly operative regains up to D3+2 lost wounds');
    const s = activate(ctx, state, id);
    expect(s.operatives[id]!.wounds).toBe(7); // 3+2 = 5, capped at the printed 7
    // Once per turning point.
    const other = opWith(s, 'p1', CARD.rangerDiktat);
    s.operatives[other]!.wounds = 1;
    const s2 = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    s2.activePlayer = 'p1';
    const s3 = activate(ctx, s2, other);
    expect(s3.operatives[other]!.wounds).toBe(1);
  });

  it('REDUNDANCY SYSTEMS does nothing within control range of an enemy operative', () => {
    const { ctx, state } = setup({ equipment: [EQ.redundancySystems] });
    ctx.rng = new ScriptedRng([6]);
    const id = opWith(state, 'p1', CARD.rangerWarrior);
    const op = place(state, id, 10, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 10.6, 10);
    isolate(state, [id, foe.id]);
    op.wounds = 2;
    const s = activate(ctx, state, id);
    expect(s.operatives[id]!.wounds).toBe(2);
  });

  it('REFRACTOR FIELD worsens Piercing by 1, so Piercing 1 gives a defence dice back', () => {
    const { ctx, state } = setup({ equipment: [EQ.refractorField] });
    const target = state.operatives[opWith(state, 'p1', CARD.rangerWarrior)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.rangerGunner)]!;
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle'); // Piercing 1
    expect(ruleText(EQ.refractorField)).toContain('Note that Piercing 1 would therefore be ignored');
    state.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      step: 'rollDefence',
      attack: pool([4], 3),
    });
    const emit = () =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, target, arc, 'Arc rifle'),
        count: 2, // 3 - Piercing 1
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    expect(emit().count).toBe(3);
    // Once per turning point: a second SEQUENCE against another target gets nothing.
    const other = state.operatives[opWith(state, 'p1', CARD.rangerDiktat)]!;
    state.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: other.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      step: 'rollDefence',
      attack: pool([4], 3),
    });
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: { ...attackCtx(shooter, other, arc, 'Arc rifle'), secondary: false },
      count: arc.atk,
      mods: zeroStatMods(),
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, other, arc, 'Arc rifle'),
      count: 2,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(2);
  });

  it('REFRACTOR FIELD holds "until the end of that sequence", covering a Blast secondary', () => {
    const { ctx, state } = setup({ equipment: [EQ.refractorField] });
    const shooter = state.operatives[opWith(state, 'p2', CARD.rangerGunner)]!;
    const arc = profileOf(CARD.rangerGunner, 'Arc rifle');
    const first = state.operatives[opWith(state, 'p1', CARD.rangerWarrior)]!;
    const second = state.operatives[opWith(state, 'p1', CARD.rangerDiktat)]!;
    const seq = shootSeqOf({
      attackerId: shooter.id,
      targetId: first.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Arc rifle',
      step: 'rollAttack',
      attack: pool([4], 3),
    });
    state.sequence = seq;
    // The primary target's attack dice open the sequence…
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: { ...attackCtx(shooter, first, arc, 'Arc rifle'), secondary: false },
      count: arc.atk,
      mods: zeroStatMods(),
    });
    const roll = (target: OperativeState): number => {
      seq.targetId = target.id;
      seq.step = 'rollDefence';
      return ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, target, arc, 'Arc rifle'),
        count: 2,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).count;
    };
    expect(roll(first)).toBe(3);
    // …and the Blast secondary of the SAME sequence shares the single use.
    seq.secondary = true;
    expect(roll(second)).toBe(3);
    // A NEW sequence in the same turning point gets nothing: the use is spent.
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: { ...attackCtx(shooter, first, arc, 'Arc rifle'), secondary: false },
      count: arc.atk,
      mods: zeroStatMods(),
    });
    seq.secondary = false;
    expect(roll(first)).toBe(2);
  });

  it('REFRACTOR FIELD is silent against a weapon with no Piercing', () => {
    const { ctx, state } = setup({ equipment: [EQ.refractorField] });
    const target = state.operatives[opWith(state, 'p1', CARD.rangerWarrior)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.vanguardWarrior)]!;
    const carbine = profileOf(CARD.vanguardWarrior, 'Radium carbine');
    state.sequence = shootSeqOf({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Radium carbine',
      step: 'rollDefence',
      attack: pool([4], 3),
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, carbine, 'Radium carbine'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(3);
  });

  it('EXTREMIS MIND-LINK refunds CONTROL EDICT once per battle; the rest of it is reminder-only', () => {
    const { ctx, state } = setup({ equipment: [EQ.extremisMindLink] });
    const leader = place(state, opWith(state, 'p1', CARD.vanguardAlpha), 10, 10);
    const partner = place(state, opWith(state, 'p1', CARD.rangerWarrior), 12, 10);
    isolate(state, [leader.id, partner.id]);
    const cp = state.teams.p1.cp;
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.controlEdict }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp); // charged then refunded
    // Once per battle: a second use in a later turning point costs the printed 1CP.
    s.teams.p1.ploysUsedTP = [];
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.controlEdict }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp - 1);
    expect(REMINDER_ONLY[`${EQ.extremisMindLink}.simultaneous`]).toContain('single `activeOperativeId`');
  });
});

// ===========================================================================
describe('unique actions', () => {
  it('SIGNAL adds 1 to the APL stat of one other friendly HUNTER CLADE operative within 6"', () => {
    const { ctx, state } = setup();
    const meId = opWith(state, 'p1', CARD.rangerDiktat);
    const me = place(state, meId, 10, 10);
    const mate = place(state, opWith(state, 'p1', CARD.rangerWarrior), 14, 10);
    isolate(state, [me.id, mate.id]);
    expect(actionOf(CARD.rangerDiktat, ACT.rangerSignal).text).toContain('add 1 to its APL stat');
    const s = activate(ctx, state, meId);
    const out = act(ctx, s, meId, ACT.rangerSignal, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === 'hunter-clade.signal' && e.operativeId === mate.id)).toBe(true);
  });

  it('SIGNAL refuses itself, an enemy, an operative out of 6" and one within enemy control range', () => {
    const { ctx, state } = setup();
    const meId = opWith(state, 'p1', CARD.rangerDiktat);
    const me = place(state, meId, 10, 10);
    const far = place(state, opWith(state, 'p1', CARD.rangerWarrior), 25, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 20, 18);
    isolate(state, [me.id, far.id, foe.id]);
    const def = getAction(ACT.rangerSignal)!;
    expect(def.check(ctx, state, me, { targetOperativeId: me.id }).ok).toBe(false);
    expect(def.check(ctx, state, me, { targetOperativeId: foe.id }).ok).toBe(false);
    expect(def.check(ctx, state, me, { targetOperativeId: far.id }).ok).toBe(false);
    expect(def.check(ctx, state, me, {}).ok).toBe(false);
    // "This operative cannot perform this action while within control range of an enemy operative."
    place(state, foe.id, 10.6, 10);
    place(state, far.id, 12, 10);
    expect(def.check(ctx, state, me, { targetOperativeId: far.id }).reason).toContain('control range');
  });

  it('SPOT marks an enemy — and its printed effect list is missing from the source data', () => {
    const { ctx, state } = setup();
    const meId = opWith(state, 'p1', CARD.rangerSurveyor);
    const me = place(state, meId, 10, 10);
    const foe = place(state, opWith(state, 'p2', CARD.rangerWarrior), 16, 10);
    isolate(state, [me.id, foe.id]);
    const s = activate(ctx, state, meId);
    const out = act(ctx, s, meId, ACT.rangerSpot, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === 'hunter-clade.spot' && e.operativeId === foe.id)).toBe(true);
    expect(out.state.log.some((l) => l.text.includes('the printed effect list is missing from the source data'))).toBe(
      true,
    );
    // Nothing reads the mark, because the printed data does not say what it does.
    expect(actionOf(CARD.rangerSurveyor, ACT.rangerSpot).text.trimEnd().endsWith('an enemy operative.')).toBe(true);
  });

  it('both SIGNALs and both SPOTs are registered, one per datacard', () => {
    for (const [actionId, cardId] of [
      [ACT.rangerSignal, CARD.rangerDiktat],
      [ACT.vanguardSignal, CARD.vanguardDiktat],
      [ACT.rangerSpot, CARD.rangerSurveyor],
      [ACT.vanguardSpot, CARD.vanguardSurveyor],
    ] as const) {
      const def = getAction(actionId);
      expect(def).toBeDefined();
      expect(def!.ap).toBe(1);
      const { ctx, state } = setup({ picks: COVERAGE, foePicks: COVERAGE });
      // `available` gates each action to its own datacard.
      const wrong = state.operatives[opWith(state, 'p1', CARD.rangerWarrior)]!;
      expect(def!.available!(ctx, state, wrong)).toBe(false);
      expect(cardId).toBeTruthy();
    }
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and
   * offers anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.rangerSignal, CARD.rangerDiktat],
      [ACT.rangerSpot, CARD.rangerSurveyor],
      [ACT.vanguardSignal, CARD.vanguardDiktat],
      [ACT.vanguardSpot, CARD.vanguardSurveyor],
    ];
    const rosterFor = (cardId: string): RosterPickIn[] =>
      cardId === CARD.vanguardDiktat || cardId === CARD.vanguardSurveyor ? VANGUARD_LED : COVERAGE;
    const tried = new Map<string, number>();
    for (const [actionId, cardId] of owners) {
      const base = setup({ picks: rosterFor(cardId), foePicks: rosterFor(cardId), seed: 5 });
      const opId = opWith(base.state, 'p1', cardId);
      const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
      const foes = base.state.teams.p2.operativeIds;
      let n = 0;
      for (const id of [...mates, ...foes]) place(base.state, id, 2 + (n++ % 12) * 1.6, 1);
      place(base.state, opId, 8, 11);
      place(base.state, mates[0]!, 8, 12.2); // a friendly well within 6"
      place(base.state, foes[0]!, 11, 11); // a visible enemy
      const op = base.state.operatives[opId]!;
      op.order = 'engage';
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
    // Every one of the four was actually reachable, so none of the assertions above was vacuous.
    expect(owners.filter(([id]) => !tried.has(id)).map(([id]) => id)).toEqual([]);
  });
});

// ===========================================================================
describe('AI hints', () => {
  it('names a role for all 14 datacards, a value for all 8 ploys and all 4 equipment options', () => {
    const hints = hunterClade.aiHints!;
    expect(Object.keys(hints.roles ?? {}).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys])
      expect(hints.ployValue?.[p.id], p.id).toBeGreaterThan(0);
    for (const e of DATA.equipment) expect(hints.equipmentValue?.[e.id], e.id).toBeGreaterThan(0);
    // The DOCTRINA IMPERATIVE gambits are priced above every ploy, or the AI would leave the
    // faction rule switched off for the whole turning point.
    const ployMax = Math.max(...[...DATA.strategyPloys, ...DATA.firefightPloys].map((p) => hints.ployValue![p.id]!));
    expect(hints.ployValue![imperativeGambitId('protector')]!).toBeGreaterThan(ployMax);
    for (const imp of IMPERATIVES) expect(hints.ployValue![imperativeGambitId(imp)]).toBeGreaterThan(0);
  });

  it('exposes the four faction equipment options as EquipmentDefs', () => {
    expect(hunterClade.equipmentDefs.map((e) => e.id)).toEqual(DATA.equipment.map((e) => e.id));
    for (const e of hunterClade.equipmentDefs) expect(e.teamId).toBe('hunter-clade');
  });

  it('the module keyword matches every datacard', () => {
    expect(KW).toBe('HUNTER CLADE');
    for (const c of DATA.datacards) expect(c.keywords).toContain(KW);
  });

  it('REMINDER_ONLY names seven printed clauses, each against a rule that really is printed', () => {
    const owners = [
      RULE.doctrina,
      SP.neurostaticInterference,
      FP.omnissiahsImperative,
      FP.omnissiahsImperative,
      EQ.extremisMindLink,
      ACT.rangerSpot,
      ACT.vanguardSpot,
    ];
    expect(Object.keys(REMINDER_ONLY)).toHaveLength(owners.length);
    for (const key of Object.keys(REMINDER_ONLY)) {
      const ruleId = key.slice(0, key.lastIndexOf('.'));
      expect(owners, key).toContain(ruleId);
      expect(REMINDER_ONLY[key]!.length).toBeGreaterThan(60); // an actual engine reason, not a shrug
    }
  });
});

// ===========================================================================
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. The shared ring
  // in tests/teams/soak.test.ts covers the batch; this mirror exercises the DOCTRINA IMPERATIVE
  // gambits, CONTROL EDICT's own decision kind and the RAD BOMBARDMENT gambit on both an open and
  // a Close Quarters killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([hunterClade], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: { teamId: 'hunter-clade', operatives: roster(), equipment: [EQ.radBombardment, EQ.redundancySystems] },
          p2: { teamId: 'hunter-clade', operatives: roster(), equipment: [EQ.refractorField, EQ.extremisMindLink] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // The faction rule was actually switched on at least once.
      expect(result.state.log.some((l) => /DOCTRINA IMPERATIVE/.test(l.text))).toBe(true);
    }, 120000);
  }
});
