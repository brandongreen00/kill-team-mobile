/**
 * ELUCIDIAN STARSTRIDER. Every test quotes the printed rule it pins, read out of
 * `data/teams/elucidian-starstrider.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/elucidian-starstrider/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { counteractCandidates, endTurningPoint, gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aplOf, hitOf, inflictDamage, moveOf, weaponsOf } from '../../src/core/state.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { entryId, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import {
  ACT,
  C,
  CLAIM_MARKER,
  PSA_WEAPONS,
  SHOOT_UNCOMPROMISING,
  WARRANTS,
  WARRANT_RULE,
  elucidianStarstrider as ES,
  isPsaWeapon,
  psaAvailableTo,
  psaUsedThisTP,
  useWarrantOfTrade,
  voltagheistMode,
  warrantAllowance,
  warrantsUsed,
} from '../../src/teams/elucidian-starstrider/index.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import { heavyBlock, testMap, vantagePlatform } from '../fixtures.ts';
import { activate, battle, opWith, settle, teamContext } from './harness.ts';

const DATA = teamData('elucidian-starstrider');

const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const uniqueActionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const RULE = {
  warrant: 'elucidian-starstrider.rule.warrant-of-trade',
  psa: 'elucidian-starstrider.rule.privateer-support-assets',
};
const SP = {
  lethalProximity: 'elucidian-starstrider.sp.lethal-proximity',
  stakeClaim: 'elucidian-starstrider.sp.stake-claim',
  undauntedExplorers: 'elucidian-starstrider.sp.undaunted-explorers',
  quickMarch: 'elucidian-starstrider.sp.quick-march',
};
const FP = {
  combinedArms: 'elucidian-starstrider.fp.combined-arms',
  survivalist: 'elucidian-starstrider.fp.survivalist',
  greatEndurance: 'elucidian-starstrider.fp.great-endurance',
  wellDrilled: 'elucidian-starstrider.fp.well-drilled',
};
const EQ = {
  armouredUndersuit: 'elucidian-starstrider.eq.armoured-undersuit',
  hotShot: 'elucidian-starstrider.eq.hot-shot-capacitor-packs',
  uplink: 'elucidian-starstrider.eq.improved-coordinates-uplink',
  rapidGunnery: 'elucidian-starstrider.eq.rapid-gunnery',
};
const AB = {
  digitalLasers: `${C.vhane}.digital-lasers`,
  merciless: `${C.vhane}.merciless`,
  disruptionField: `${C.vhane}.disruption-field`,
  reputation: `${C.vhane}.reputation-to-maintain`,
  beast: `${C.canid}.beast`,
  loyalCompanion: `${C.canid}.loyal-companion`,
  rapidReflexes: `${C.executioner}.rapid-reflexes`,
  bladedStance: `${C.executioner}.bladed-stance`,
  zealot: `${C.executioner}.zealot`,
  missionary: `${C.lectroMaester}.missionary-of-the-martian-creed`,
  voltaghiestArray: `${C.lectroMaester}.voltaghiest-array`,
  medic: `${C.rejuvenatAdept}.medic`,
  normaliserHelm: `${C.rejuvenatAdept}.normaliser-helm`,
  disciplinarian: `${C.voidmaster}.disciplinarian`,
  hardy: `${C.voidmaster}.hardy`,
  crewmen: `${C.voidsman}.crewmen`,
};

/**
 * The printed kill team: "Every ELUCIDIAN STARSTRIDER operative in the following list" — one of
 * each named role plus four VOIDSMEN. `defaultRoster` cannot produce it (see the data problems
 * in the report), so every test builds it from the printed selection list.
 */
function printedRoster(): RosterPickIn[] {
  const out: RosterPickIn[] = [];
  const leaderRows = DATA.selection.leaderList.length;
  DATA.selection.list.forEach((entry, i) => {
    for (let n = 0; n < entry.count; n++)
      out.push({
        datacardId: entry.datacardId,
        entryId: entryId(DATA, leaderRows + i),
        weapons: [...entry.fixedWeapons],
      });
  });
  return out;
}

/** Ten operatives per side, spread out so nobody starts inside anyone's control range. */
const column = (x: number) => Array.from({ length: 10 }, (_, i) => ({ x, y: 1 + i * 2 }));

function setup(
  opts: { equipment?: string[]; script?: number[]; seed?: number; map?: ReturnType<typeof testMap> } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([ES], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  if (opts.map) ctx.maps.set(opts.map.id, opts.map);
  const picks = printedRoster();
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: ES, picks, positions: column(3), ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: ES, picks, positions: column(27) },
  });
  state.teams.p1.cp = 10;
  state.teams.p2.cp = 10;
  return { ctx, state };
}

const T = (state: GameState, ctx: ReturnType<typeof teamContext>, player: PlayerId = 'p1') =>
  makeTeamHooks(DATA, player, ctx);

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  type: 'ranged' | 'melee' = 'ranged',
  rules = profile.rules,
): AttackContext {
  return {
    attacker,
    defender,
    weaponName,
    profile,
    rules,
    type,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    vantageAccurate: 0,
    distance: 4,
  };
}

/** A shoot sequence parked mid-flight, so rules that read `state.sequence` can be pinned. */
function fakeShoot(
  state: GameState,
  attackerId: string,
  targetId: string,
  weaponName: string,
  dice: { value: number; state: 'crit' | 'normal' | 'fail' }[],
  opts: { profileName?: string; defence?: { value: number; state: 'crit' | 'normal' | 'fail' }[] } = {},
): void {
  state.sequence = {
    kind: 'shoot',
    step: 'defenceRerolls',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(opts.profileName ? { profileName: opts.profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: {
      dice: dice.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: dice.length + 1,
    },
    defence: {
      dice: (opts.defence ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.defence ?? []).length + 1,
    },
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[targetId]!.player,
    free: false,
  };
}

function fakeFight(
  state: GameState,
  attackerId: string,
  defenderId: string,
  attackerWeapon: string,
  opts: {
    defenderWeapon?: string;
    defenderDice?: { value: number; state: 'crit' | 'normal' }[];
    attackerDice?: { value: number; state: 'crit' | 'normal' }[];
  } = {},
): void {
  state.sequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId,
    defenderId,
    attackerWeapon,
    ...(opts.defenderWeapon ? { defenderWeapon: opts.defenderWeapon } : {}),
    defenderCanRetaliate: true,
    attackerPool: {
      dice: (opts.attackerDice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.attackerDice ?? []).length + 1,
    },
    defenderPool: {
      dice: (opts.defenderDice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.defenderDice ?? []).length + 1,
    },
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[defenderId]!.player,
    free: false,
    hatchway: false,
  };
}

/** Park every operative of a player far away, keeping the named ones where they are. */
function banish(state: GameState, player: PlayerId, keep: string[] = []): void {
  state.teams[player].operativeIds.forEach((id, i) => {
    if (keep.includes(id)) return;
    state.operatives[id]!.pos = { x: player === 'p1' ? 0.6 : 29.4, y: 0.6 + i * 2 };
  });
}

const nth = (state: GameState, player: PlayerId, datacardId: string, index: number): string =>
  state.teams[player].operativeIds.filter((id) => state.operatives[id]!.datacardId === datacardId)[index]!;


/** Write directly into a namespaced scratch bucket, the way the module reads it back. */
function setScratch(state: GameState, key: string, entries: Record<string, unknown>): void {
  state.opState[key] = { ...((state.opState[key] as Record<string, unknown> | undefined) ?? {}), ...entries };
}

const useGambit = (ctx: ReturnType<typeof teamContext>, state: GameState, gambitId: string, data?: Record<string, unknown>): GameState =>
  reduce(state, { t: 'UseGambit', player: 'p1', gambitId, ...(data ? { data } : {}) }, ctx).state;

// ---------------------------------------------------------------------------
describe('ELUCIDIAN STARSTRIDER data (pinned against data/teams/elucidian-starstrider.json)', () => {
  it('has 7 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(7);
    expect(DATA.datacards.find((c) => c.id === C.vhane)).toMatchObject({
      apl: 3,
      move: 6,
      save: 4,
      wounds: 8,
      base: { shape: 'round', mm: 25 },
    });
    expect(DATA.datacards.find((c) => c.id === C.vhane)!.keywords).toEqual([
      'ELUCIDIAN STARSTRIDER',
      'IMPERIUM',
      'LEADER',
      'ELUCIA VHANE',
    ]);
    expect(DATA.datacards.find((c) => c.id === C.canid)).toMatchObject({ apl: 2, move: 8, save: 5, wounds: 7 });
    expect(DATA.datacards.find((c) => c.id === C.executioner)).toMatchObject({ apl: 3, move: 6, save: 5, wounds: 8 });
    expect(DATA.datacards.find((c) => c.id === C.lectroMaester)).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 8 });
    expect(DATA.datacards.find((c) => c.id === C.rejuvenatAdept)).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 8 });
    expect(DATA.datacards.find((c) => c.id === C.rejuvenatAdept)!.keywords).toContain('MEDIC');
    expect(DATA.datacards.find((c) => c.id === C.voidmaster)).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 8 });
    expect(DATA.datacards.find((c) => c.id === C.voidsman)).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 7 });
    // The NAVIS keyword is what PRIVATEER SUPPORT ASSETS, Disciplinarian and Crewmen key on.
    expect(DATA.datacards.filter((c) => c.keywords.includes('NAVIS')).map((c) => c.id)).toEqual([
      C.voidmaster,
      C.voidsman,
    ]);
    for (const card of DATA.datacards) expect(card.base).toEqual({ shape: 'round', mm: 25 });
  });

  it('pins every weapon profile on every datacard', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat(C.vhane)).toEqual([
      'Heirloom relic pistol||ranged|4|3|4|5|Range 8"+Piercing Crits 1+Seek Light',
      'Monomolecular cane-rapier||melee|4|3|3|6|Lethal 5+',
    ]);
    expect(flat(C.canid)).toEqual(['Vicious bite||melee|4|3|3|4|Rending']);
    expect(flat(C.executioner)).toEqual([
      'Dartmask||ranged|4|3|1|1|Range 6"+Lethal 5++Silent+Stun',
      'Power weapon||melee|5|3|4|6|Lethal 5+',
    ]);
    expect(flat(C.lectroMaester)).toEqual([
      'Voltaic pistol||ranged|4|3|4|4|Range 8"+1" Devastating 1+Rending',
      'Gun butt||melee|3|4|2|3|',
    ]);
    expect(flat(C.rejuvenatAdept)).toEqual([
      'Laspistol||ranged|4|4|2|3|Range 8"',
      'Scalpel claw||melee|3|4|3|4|Rending',
    ]);
    expect(flat(C.voidmaster)).toEqual([
      'Artificer shotgun|close range|ranged|4|3|4|4|Range 6"',
      'Artificer shotgun|long range|ranged|4|5|2|2|',
      'Relic laspistol||ranged|4|3|2|4|Range 8"+Lethal 5+',
      'Gun butt||melee|3|4|2|3|',
    ]);
    expect(flat(C.voidsman)).toEqual([
      'Lasgun||ranged|4|4|2|3|',
      'Rotor cannon|focused|ranged|5|4|4|5|Heavy (Dash only)+Rending',
      'Rotor cannon|sweeping|ranged|4|4|4|5|Heavy (Dash only)+Rending+Torrent 1"',
      'Gun butt||melee|3|4|2|3|',
    ]);
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 16 abilities and 5 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Warrant of Trade', 'Privateer Support Assets']);
    expect(ES.ploys.filter((p) => p.kind === 'strategy').map((p) => p.name)).toEqual([
      'LETHAL PROXIMITY',
      'STAKE CLAIM',
      'UNDAUNTED EXPLORERS',
      'QUICK MARCH',
    ]);
    expect(ES.ploys.filter((p) => p.kind === 'firefight').map((p) => p.name)).toEqual([
      'COMBINED ARMS',
      'SURVIVALIST',
      'GREAT ENDURANCE',
      'WELL-DRILLED',
    ]);
    expect(ES.equipment.map((e) => e.name)).toEqual([
      'ARMOURED UNDERSUIT',
      'HOT SHOT CAPACITOR PACKS',
      'IMPROVED COORDINATES UPLINK',
      'RAPID GUNNERY',
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(16);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'GATHER',
      'TRAINED ASSASSIN',
      'CALIBRATE VOLTAGHEIST',
      'HEALING SERUM',
      'UNCOMPROMISING FIRE',
    ]);
    expect(DATA.rareWeaponRules).toEqual([]);
    // The unique actions' printed AP costs, which the ActionDefs are built from.
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.ap)).toEqual([1, 1, 0, 1, 1]);
  });

  it('the printed 10-operative kill team is legal, and every datacard/ploy/equipment has an AI hint', () => {
    const picks = printedRoster();
    expect(picks).toHaveLength(10); // "Every ELUCIDIAN STARSTRIDER operative in the following list"
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(ES.validateRoster(picks).ok).toBe(true);
    // The shared validator has no branch for a `kind: 'every'` group, so `defaultRoster` fills
    // the ten slots from the first repeatable row instead of taking one of each — reported as a
    // data problem, not pinned here beyond "it still produces a roster the validator accepts".
    expect(defaultRoster(DATA)).toHaveLength(10);
    expect(ES.validateRoster(defaultRoster(DATA)).ok).toBe(true);
    for (const card of DATA.datacards) expect(ES.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of ES.ploys) expect(ES.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of ES.equipment) expect(ES.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('Warrant of Trade — "Up to four times per battle, you can use a WARRANT OF TRADE rule"', () => {
  it('slices all seven sub-rules out of the one printed faction rule', () => {
    expect(WARRANTS).toEqual(['consideration', 'coordinate', 'coerce', 'explore', 'bribe', 'seize', 'adaptable-terms']);
    expect(WARRANT_RULE.consideration).toContain('Select one additional equipment option');
    expect(WARRANT_RULE.coordinate).toContain('You gain 1 additional CP');
    expect(WARRANT_RULE.coerce).toContain('Your opponent must set up all of their operatives before you set up any');
    expect(WARRANT_RULE.explore).toContain('Perform a free Reposition action with D3 friendly');
    expect(WARRANT_RULE.bribe).toContain('You can skip that activation');
    expect(WARRANT_RULE.seize).toContain('You can re-roll your dice');
    expect(WARRANT_RULE['adaptable-terms']).toContain('Select a new tac op or a new primary op');
    for (const w of WARRANTS) expect(rule(RULE.warrant)).toContain(WARRANT_RULE[w]);
  });

  it('caps at four uses and refuses the same rule twice — "you cannot use the same WARRANT OF TRADE rule more than once per battle"', () => {
    expect(rule(RULE.warrant)).toContain('you cannot use the same WARRANT OF TRADE rule more than once per battle');
    const { state } = setup();
    expect(warrantAllowance(state, 'p1')).toBe(4);
    expect(useWarrantOfTrade(state, 'p1', 'coerce')).toBe(true);
    expect(useWarrantOfTrade(state, 'p1', 'coerce')).toBe(false); // not twice
    expect(useWarrantOfTrade(state, 'p1', 'bribe')).toBe(true);
    expect(useWarrantOfTrade(state, 'p1', 'seize')).toBe(true);
    expect(useWarrantOfTrade(state, 'p1', 'consideration')).toBe(true);
    expect(warrantsUsed(state, 'p1')).toHaveLength(4);
    expect(useWarrantOfTrade(state, 'p1', 'adaptable-terms')).toBe(false); // "up to four times per battle"
  });

  it('Coordinate: "You gain 1 additional CP"', () => {
    const { state } = setup();
    const before = state.teams.p1.cp;
    expect(useWarrantOfTrade(state, 'p1', 'coordinate')).toBe(true);
    expect(state.teams.p1.cp).toBe(before + 1);
    expect(state.teams.p2.cp).toBe(10);
  });

  it('Explore: "STRATEGIC GAMBIT in the first turning point" — a free Reposition with D3 operatives wholly within your drop zone', () => {
    const { ctx, state } = setup({ script: [3] }); // D6 3 → D3 2
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const explore = 'elucidian-starstrider.warrant.explore';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(explore);
    const after = useGambit(ctx, state, explore);
    expect(warrantsUsed(after, 'p1')).toEqual(['explore']);
    const granted = after.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(granted).toHaveLength(2);
    expect(granted.every((e) => (e.data?.['only'] as string[]).includes('Reposition'))).toBe(true);
    // Not offered again once used, and never after the first turning point.
    expect(gambitOptions(ctx, after, 'p1').map((o) => o.id)).not.toContain(explore);
    const tp2 = { ...after, turningPoint: 2 };
    expect(gambitOptions(ctx, tp2, 'p1').map((o) => o.id)).not.toContain(explore);
  });

  it('Reputation to Maintain: "up to five uses per battle, instead of four", or 1 additional CP', () => {
    expect(ability(C.vhane, AB.reputation)).toContain('up to five uses per battle, instead of four');
    // Branch 1: the printed four are not yet spent, so the CP is taken.
    const a = setup();
    const vhane = a.state.operatives[opWith(a.state, 'p1', C.vhane)]!;
    const foe = a.state.operatives[opWith(a.state, 'p2', C.voidsman)]!;
    fakeFight(a.state, vhane.id, foe.id, 'Monomolecular cane-rapier');
    const cp = a.state.teams.p1.cp;
    inflictDamage(a.ctx, a.state, foe, 99, 'attack');
    expect(a.state.teams.p1.cp).toBe(cp + 1);
    expect(warrantAllowance(a.state, 'p1')).toBe(4);

    // Branch 2: all four uses spent, so the fifth use is taken instead.
    const b = setup();
    for (const w of ['coerce', 'bribe', 'seize', 'consideration'] as const) useWarrantOfTrade(b.state, 'p1', w);
    const v2 = b.state.operatives[opWith(b.state, 'p1', C.vhane)]!;
    const f2 = b.state.operatives[opWith(b.state, 'p2', C.voidsman)]!;
    fakeFight(b.state, v2.id, f2.id, 'Monomolecular cane-rapier');
    inflictDamage(b.ctx, b.state, f2, 99, 'attack');
    expect(warrantAllowance(b.state, 'p1')).toBe(5);
    expect(useWarrantOfTrade(b.state, 'p1', 'adaptable-terms')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Privateer Support Assets', () => {
  it('pins the five printed weapons, with the weapon rules parsed out of the printed WR rows', () => {
    const flat = PSA_WEAPONS.map((w) =>
      [w.name, w.profiles[0]!.atk, w.profiles[0]!.hit, w.profiles[0]!.dmgN, w.profiles[0]!.dmgC,
        w.profiles[0]!.rules.map((r) => r.raw).join('+')].join('|'),
    );
    expect(flat).toEqual([
      'Archeotech beam|4|3|6|7|Heavy (Reposition only)+Piercing 2+Silent',
      'Plasma battery|5|4|5|6|Heavy (Reposition only)+Lethal 5++Piercing 1+Silent',
      'Macrocannon|5|4|4|5|Heavy (Reposition only)+Piercing Crits 1+Saturate+Silent+Torrent 2"',
      'Guided shell|5|4|3|4|Blast 2"+Heavy (Reposition only)+Silent',
      'Cluster bomb|5|4|2|3|Blast 3"+Heavy (Reposition only)+Silent',
    ]);
    // The scraper left `rules: []` on the parsed table, so this is the check that the WR rows
    // really were sliced out of the printed text rather than retyped.
    const table = (DATA.factionRules.find((r) => r.id === RULE.psa) as { weapons?: { profiles: { rules: unknown[] }[] }[] }).weapons!;
    expect(table.every((w) => w.profiles.every((p) => p.rules.length === 0))).toBe(true);
  });

  it('"a friendly ELUCIDIAN STARSTRIDER NAVIS or ELUCIDIAN STARSTRIDER ELUCIA VHANE operative" gets them; nobody else does', () => {
    expect(rule(RULE.psa)).toContain('ELUCIDIAN STARSTRIDER NAVIS or ELUCIDIAN STARSTRIDER ELUCIA VHANE operative');
    const { ctx, state } = setup();
    const named = (id: string): string[] => weaponsOf(ctx, state, state.operatives[id]!, 'ranged').map((w) => w.name);
    expect(named(opWith(state, 'p1', C.vhane))).toEqual(
      expect.arrayContaining(PSA_WEAPONS.map((w) => w.name)),
    );
    expect(named(opWith(state, 'p1', C.voidmaster))).toEqual(expect.arrayContaining(['Macrocannon']));
    expect(named(opWith(state, 'p1', C.voidsman))).toEqual(expect.arrayContaining(['Macrocannon']));
    // Not the LECTRO-MAESTER, the REJUVENAT ADEPT or the DEATH CULT EXECUTIONER.
    for (const card of [C.lectroMaester, C.rejuvenatAdept, C.executioner])
      expect(named(opWith(state, 'p1', card)).some(isPsaWeapon)).toBe(false);
    // CANID › Beast: "It cannot use any weapons that aren't on its datacard."
    expect(ability(C.canid, AB.beast)).toContain('cannot use any weapons that aren’t on its datacard');
    const canid = state.operatives[opWith(state, 'p1', C.canid)]!;
    expect(weaponsOf(ctx, state, canid).map((w) => w.name)).toEqual(['Vicious bite']);
  });

  it('"Once per Firefight phase" and "You cannot use each PRIVATEER SUPPORT ASSET more than once per battle"', () => {
    expect(rule(RULE.psa)).toContain('Once per Firefight phase');
    expect(rule(RULE.psa)).toContain('You cannot use each PRIVATEER SUPPORT ASSET more than once per battle');
    const { ctx, state } = setup();
    const vhane = opWith(state, 'p1', C.vhane);
    const foe = opWith(state, 'p2', C.voidsman);
    banish(state, 'p1', [vhane]);
    banish(state, 'p2', [foe]);
    state.operatives[vhane]!.pos = { x: 12, y: 11 };
    state.operatives[foe]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, vhane);
    s = reduce(s, { t: 'PerformAction', operativeId: vhane, action: 'Shoot', params: { weaponName: 'Archeotech beam', targetId: foe } }, ctx).state;
    s = settle(ctx, s);
    expect(s.rejected).toEqual([]);
    expect(psaUsedThisTP(s, 'p1')).toBe(true);
    // No further asset this Firefight phase, for anybody.
    const master = s.operatives[opWith(s, 'p1', C.voidmaster)]!;
    expect(psaAvailableTo(T(s, ctx), s, master)).toEqual([]);
    expect(weaponsOf(ctx, s, master, 'ranged').some((w) => isPsaWeapon(w.name))).toBe(false);
    // Next turning point: everything but the Archeotech beam is back.
    s.turningPoint = 2;
    expect(psaAvailableTo(T(s, ctx), s, master)).toEqual([
      'Plasma battery',
      'Macrocannon',
      'Guided shell',
      'Cluster bomb',
    ]);
  });

  it('RAPID GUNNERY: "you can select one that’s already been used during the battle" — once per battle', () => {
    expect(rule(EQ.rapidGunnery)).toContain('you can select one that’s already been used during the battle');
    const { ctx, state } = setup({ equipment: [EQ.rapidGunnery] });
    const master = state.operatives[opWith(state, 'p1', C.voidmaster)]!;
    const hooks = T(state, ctx);
    // Pretend the Macrocannon has fired: with RAPID GUNNERY it is still selectable.
    setScratch(state, 'es.psaUsed', { 'p1:macrocannon': true });
    expect(psaAvailableTo(hooks, state, master)).toContain('Macrocannon');
    // Once the RAPID GUNNERY charge is spent it is not.
    setScratch(state, 'teamOnceBattle', { 'es.rapidGunnery:p1': true });
    expect(psaAvailableTo(hooks, state, master)).not.toContain('Macrocannon');
    // A player without the equipment never gets the re-use.
    const plain = setup();
    setScratch(plain.state, 'es.psaUsed', { 'p1:macrocannon': true });
    expect(psaAvailableTo(T(plain.state, plain.ctx), plain.state, plain.state.operatives[opWith(plain.state, 'p1', C.voidmaster)]!)).not.toContain(
      'Macrocannon',
    );
  });

  it('"the target has a cover save if any part of its base is underneath Vantage terrain"', () => {
    expect(rule(RULE.psa)).toContain('the target has a cover save if any part of its base is underneath Vantage terrain');
    const map = testMap({ features: [vantagePlatform('gantry', 16, 9, 4, 4, 3)] });
    const { ctx, state } = setup({ map });
    const vhane = state.operatives[opWith(state, 'p1', C.vhane)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const beam = PSA_WEAPONS.find((w) => w.name === 'Archeotech beam')!.profiles[0]!;
    const emit = () =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(vhane, foe, 'Archeotech beam', beam),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    foe.pos = { x: 18, y: 11 }; // underneath the gantry
    foe.z = 0;
    expect(emit().coverSave).toBe(true);
    foe.pos = { x: 24, y: 11 }; // out from under it
    expect(emit().coverSave).toBe(false);
    // A normal weapon is untouched by the rule (it keeps the sequence's own cover verdict).
    const pistol = profileOf(C.vhane, 'Heirloom relic pistol');
    foe.pos = { x: 18, y: 11 };
    expect(
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(vhane, foe, 'Heirloom relic pistol', pistol),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).coverSave,
    ).toBe(false);
  });

  it('IMPROVED COORDINATES UPLINK: "the target cannot be obscured and that weapon has the Saturate weapon rule"', () => {
    expect(rule(EQ.uplink)).toContain('the target cannot be obscured and that weapon has the Saturate weapon rule');
    const { ctx, state } = setup({ equipment: [EQ.uplink] });
    const vhane = state.operatives[opWith(state, 'p1', C.vhane)]!;
    const spotter = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const beam = PSA_WEAPONS.find((w) => w.name === 'Archeotech beam')!.profiles[0]!;
    foe.pos = { x: 20, y: 11 };
    spotter.pos = { x: 18, y: 11 }; // a friendly NAVIS operative within 6" of the target
    const rules = () => effectiveRules(ctx, state, beam, { operative: vhane, target: foe, weaponName: 'Archeotech beam' });
    expect(rules().some((r) => r.id === 'Saturate')).toBe(true);
    fakeShoot(state, vhane.id, foe.id, 'Archeotech beam', [{ value: 5, state: 'normal' }]);
    (state.sequence as { obscured: boolean }).obscured = true;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(vhane, foe, 'Archeotech beam', beam),
      count: 4,
      mods: zeroStatMods(),
    });
    expect((state.sequence as { obscured: boolean }).obscured).toBe(false);
    // No NAVIS operative within 6" of the target: nothing applies.
    spotter.pos = { x: 3, y: 3 };
    expect(rules().some((r) => r.id === 'Saturate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('LETHAL PROXIMITY: Balanced "shooting an operative within 6\\" of it (excluding PRIVATEER SUPPORT ASSET weapons)"', () => {
    expect(rule(SP.lethalProximity)).toContain('excluding PRIVATEER SUPPORT ASSET weapons');
    const { ctx, state } = setup();
    const s = useGambit(ctx, state, SP.lethalProximity);
    const shooter = s.operatives[opWith(s, 'p1', C.voidsman)]!;
    const foe = s.operatives[opWith(s, 'p2', C.voidsman)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    shooter.pos = { x: 12, y: 11 };
    foe.pos = { x: 16, y: 11 };
    expect(
      effectiveRules(ctx, s, lasgun, { operative: shooter, target: foe, weaponName: 'Lasgun' }).some((r) => r.id === 'Balanced'),
    ).toBe(true);
    foe.pos = { x: 22, y: 11 }; // beyond 6"
    expect(
      effectiveRules(ctx, s, lasgun, { operative: shooter, target: foe, weaponName: 'Lasgun' }).some((r) => r.id === 'Balanced'),
    ).toBe(false);
    // The exclusion.
    foe.pos = { x: 16, y: 11 };
    const beam = PSA_WEAPONS.find((w) => w.name === 'Archeotech beam')!.profiles[0]!;
    expect(
      effectiveRules(ctx, s, beam, { operative: shooter, target: foe, weaponName: 'Archeotech beam' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(false);
  });

  it('STAKE CLAIM places the Claim marker, promotes one attack dice within 3" of it, and removes it at the end of the turning point', () => {
    expect(rule(SP.stakeClaim)).toContain('retain one of your fails as a normal success instead of discarding it');
    const { ctx, state } = setup();
    let s = useGambit(ctx, state, SP.stakeClaim, { pos: { x: 18, y: 11 } });
    const marker = s.markers[CLAIM_MARKER('p1')]!;
    expect(marker.pos).toEqual({ x: 18, y: 11 });
    const shooter = s.operatives[opWith(s, 'p1', C.voidsman)]!;
    const foe = s.operatives[opWith(s, 'p2', C.voidsman)]!;
    foe.pos = { x: 19, y: 11 }; // within 3" of the marker
    shooter.pos = { x: 12, y: 11 };
    const lasgun = profileOf(C.voidsman, 'Lasgun'); // Dmg 2/3
    fakeShoot(s, shooter.id, foe.id, 'Lasgun', [{ value: 1, state: 'fail' }, { value: 5, state: 'normal' }]);
    ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(shooter, foe, 'Lasgun', lasgun),
      dice: [],
      rerolls: [],
    });
    // dmgN 2 beats (dmgC - dmgN) = 1, so the fail becomes a normal success.
    expect((s.sequence as { attack: { dice: { state: string }[] } }).attack.dice[0]!.state).toBe('normal');
    endTurningPoint(ctx, s);
    expect(s.markers[CLAIM_MARKER('p1')]).toBeUndefined();
  });

  it('UNDAUNTED EXPLORERS: "halve that inflicted damage (rounding up, to a minimum of 2)", once per operative per turning point', () => {
    expect(rule(SP.undauntedExplorers)).toContain('rounding up, to a minimum of 2');
    const { ctx, state } = setup();
    const s = useGambit(ctx, state, SP.undauntedExplorers);
    // A VOIDSMAN, not the VOIDMASTER, so the VOIDMASTER's own Hardy does not absorb the hit.
    const victim = s.operatives[opWith(s, 'p1', C.voidsman)]!;
    const shooter = s.operatives[opWith(s, 'p2', C.voidsman)]!;
    fakeShoot(s, shooter.id, victim.id, 'Rotor cannon', [{ value: 5, state: 'normal' }], { profileName: 'focused' });
    const before = victim.wounds;
    inflictDamage(ctx, s, victim, 4, 'attack'); // Normal Dmg 4 → halved to 2
    expect(before - victim.wounds).toBe(2);
    // "The FIRST time … during the turning point" — the second hit lands in full.
    const mid = victim.wounds;
    inflictDamage(ctx, s, victim, 4, 'attack');
    expect(mid - victim.wounds).toBe(4);
  });

  it('QUICK MARCH: "add 1\\" to its Move stat", and never to an operative that could use a PRIVATEER SUPPORT ASSET', () => {
    expect(rule(SP.quickMarch)).toContain('add 1" to its Move stat until the end of that activation');
    expect(rule(SP.quickMarch)).toContain('cannot use a PRIVATEER SUPPORT ASSET during that activation');
    const { ctx, state } = setup();
    const s = useGambit(ctx, state, SP.quickMarch);
    const dce = s.operatives[opWith(s, 'p1', C.executioner)]!;
    const master = s.operatives[opWith(s, 'p1', C.voidmaster)]!;
    expect(moveBudget(ctx, s, dce, { action: 'Reposition' })).toBeCloseTo(7); // 6" + 1"
    expect(moveBudget(ctx, s, dce, { action: 'Dash' })).toBeCloseTo(3); // "the Reposition action" only
    // The VOIDMASTER is not nominated by the deterministic default, so it keeps its asset.
    expect(moveBudget(ctx, s, master, { action: 'Reposition' })).toBeCloseTo(6);
    expect(psaAvailableTo(T(s, ctx), s, master).length).toBe(5);
    // Nominating it explicitly does apply the +1" and does cost it the asset once it repositions.
    const s2 = useGambit(ctx, setup().state, SP.quickMarch, { operativeIds: [master.id] });
    const m2 = s2.operatives[master.id]!;
    expect(moveBudget(ctx, s2, m2, { action: 'Reposition' })).toBeCloseTo(7);
    m2.actionsThisActivation = ['Reposition'];
    expect(psaAvailableTo(T(s2, ctx), s2, m2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('COMBINED ARMS re-rolls "if it’s shooting an enemy operative that’s been shot by another friendly … operative during this turning point"', () => {
    expect(rule(FP.combinedArms)).toContain('You cannot use this ploy while shooting with a PRIVATEER SUPPORT ASSET');
    const { ctx, state } = setup();
    const first = state.operatives[nth(state, 'p1', C.voidsman, 0)]!;
    const second = state.operatives[nth(state, 'p1', C.voidsman, 1)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidmaster)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    // The ploy is not usable until somebody has shot that operative this turning point.
    expect(ES.ploys.find((p) => p.id === FP.combinedArms)!.usable!(state, 'p1').ok).toBe(false);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(first, foe, 'Lasgun', lasgun),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(ES.ploys.find((p) => p.id === FP.combinedArms)!.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.combinedArms }, ctx).state;
    fakeShoot(s, second.id, foe.id, 'Lasgun', [{ value: 2, state: 'fail' }]);
    const grants = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(second, foe, 'Lasgun', lasgun),
      dice: [],
      rerolls: [],
    }).rerolls;
    expect(grants.map((g) => g.id)).toContain('es.combinedArms');
    expect(grants.find((g) => g.id === 'es.combinedArms')!.mode).toBe('any');
    // The same shooter alone does not qualify, and a PRIVATEER SUPPORT ASSET never does.
    const t = setup();
    const solo = t.state.operatives[nth(t.state, 'p1', C.voidsman, 0)]!;
    const foe2 = t.state.operatives[opWith(t.state, 'p2', C.voidmaster)]!;
    t.ctx.hooks.emit('onCollectAttackDice', t.state, {
      state: t.state,
      ctx: attackCtx(solo, foe2, 'Lasgun', lasgun),
      count: 4,
      mods: zeroStatMods(),
    });
    const u = reduce(t.state, { t: 'UsePloy', player: 'p1', ployId: FP.combinedArms }, t.ctx).state;
    fakeShoot(u, solo.id, foe2.id, 'Lasgun', [{ value: 2, state: 'fail' }]);
    expect(
      t.ctx.hooks
        .emit('onRollAttack', u, { state: u, ctx: attackCtx(solo, foe2, 'Lasgun', lasgun), dice: [], rerolls: [] })
        .rerolls.map((g) => g.id),
    ).not.toContain('es.combinedArms');
  });

  it('SURVIVALIST: "regains up to D3+2 lost wounds and … you can ignore any changes to its APL stat"', () => {
    expect(rule(FP.survivalist)).toContain('regains up to D3+2 lost wounds');
    const { ctx, state } = setup({ script: [5] }); // D6 5 → D3 3 → 5 wounds
    const id = opWith(state, 'p1', C.voidmaster);
    state.operatives[id]!.wounds = 2;
    let s = activate(ctx, state, id);
    s.operatives[id]!.aplMods.push(-1); // a Stun the ploy will ignore
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(1);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.survivalist }, ctx).state;
    expect(s.operatives[id]!.wounds).toBe(7);
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(2);
    s.operatives[id]!.aplMods.push(-1);
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(2); // still ignored during that activation
  });

  it('GREAT ENDURANCE: "Until the end of the activation, add 1 to its APL stat" (NAVIS only)', () => {
    expect(rule(FP.greatEndurance)).toContain('add 1 to its APL stat');
    const { ctx, state } = setup();
    const master = opWith(state, 'p1', C.voidmaster);
    let s = activate(ctx, state, master);
    expect(aplOf(ctx, s, s.operatives[master]!)).toBe(2);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.greatEndurance }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[master]!)).toBe(3);
    // Not offered while a non-NAVIS operative is the active one.
    const t = setup();
    const canid = opWith(t.state, 'p1', C.canid);
    const u = activate(t.ctx, t.state, canid);
    expect(ES.ploys.find((p) => p.id === FP.greatEndurance)!.usable!(u, 'p1').ok).toBe(false);
  });

  it('WELL-DRILLED records the pairing: "you can activate that other friendly operative before your opponent activates"', () => {
    expect(rule(FP.wellDrilled)).toContain('you can activate that other friendly operative before your opponent activates');
    const { ctx, state } = setup();
    const master = opWith(state, 'p1', C.voidmaster);
    const mate = nth(state, 'p1', C.voidsman, 0);
    state.operatives[master]!.pos = { x: 10, y: 11 };
    state.operatives[mate]!.pos = { x: 12, y: 11 }; // visible to and within 3"
    let s = activate(ctx, state, master);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.wellDrilled }, ctx).state;
    const eff = s.effects.find((e) => e.rule === 'es.wellDrilled');
    expect(eff?.data).toEqual({ firstId: master, otherId: mate });
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('ARMOURED UNDERSUIT: "retain one of your defence dice results of 4 as a normal success" (5+ Save, excluding CANID)', () => {
    expect(rule(EQ.armouredUndersuit)).toContain('retain one of your defence dice results of 4 as a normal success');
    const { ctx, state } = setup({ equipment: [EQ.armouredUndersuit] });
    const target = state.operatives[opWith(state, 'p1', C.voidsman)]!; // 5+ Save
    const shooter = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    fakeShoot(state, shooter.id, target.id, 'Lasgun', [{ value: 5, state: 'normal' }], {
      defence: [{ value: 4, state: 'fail' }, { value: 2, state: 'fail' }],
    });
    const emit = (defender: OperativeState) =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, defender, 'Lasgun', lasgun),
        count: 0,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    emit(target);
    const dice = (state.sequence as { defence: { dice: { state: string; value: number }[] } }).defence.dice;
    expect(dice[0]!.state).toBe('normal'); // the 4
    expect(dice[1]!.state).toBe('fail'); // the 2 is untouched
    // "(excluding CANID)" — a 4+ Save operative is out of scope too (ELUCIA VHANE is 4+).
    const canid = state.operatives[opWith(state, 'p1', C.canid)]!;
    fakeShoot(state, shooter.id, canid.id, 'Lasgun', [{ value: 5, state: 'normal' }], {
      defence: [{ value: 4, state: 'fail' }],
    });
    emit(canid);
    expect((state.sequence as { defence: { dice: { state: string }[] } }).defence.dice[0]!.state).toBe('fail');
  });

  it('HOT SHOT CAPACITOR PACKS: "add 1 to both Dmg stats of that weapon and it has the Hot and Piercing Crits 1 weapon rules"', () => {
    expect(rule(EQ.hotShot)).toContain('it has the Hot and Piercing Crits 1 weapon rules');
    const { ctx, state } = setup({ equipment: [EQ.hotShot] });
    const shooter = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    const before = effectiveRules(ctx, state, lasgun, { operative: shooter, target: foe, weaponName: 'Lasgun' });
    expect(before.some((r) => r.id === 'Hot')).toBe(false);
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, foe, 'Lasgun', lasgun),
      allowed: true,
      dryRun: false,
    });
    const after = effectiveRules(ctx, state, lasgun, { operative: shooter, target: foe, weaponName: 'Lasgun' });
    expect(after.some((r) => r.id === 'Hot')).toBe(true);
    expect(after.some((r) => r.id === 'PiercingCrits' && r.x === 1)).toBe(true);
    // "+1 to both Dmg stats" lands per unblocked dice, at onDamage (D-019).
    fakeShoot(state, shooter.id, foe.id, 'Lasgun', [
      { value: 5, state: 'normal' },
      { value: 6, state: 'crit' },
    ]);
    const wounds = foe.wounds;
    inflictDamage(ctx, state, foe, lasgun.dmgN + lasgun.dmgC, 'attack');
    expect(wounds - foe.wounds).toBe(lasgun.dmgN + lasgun.dmgC + 2);
  });

  it('HOT SHOT CAPACITOR PACKS is "Up to twice per turning point" and only on a laspistol, lasgun or relic laspistol', () => {
    expect(rule(EQ.hotShot)).toContain('Up to twice per turning point');
    const { ctx, state } = setup({ equipment: [EQ.hotShot] });
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    const arm = (op: OperativeState, weapon: string, profile: WeaponProfile) =>
      ctx.hooks.emit('onSelectWeapon', state, { state, ctx: attackCtx(op, foe, weapon, profile), allowed: true, dryRun: false });
    const armed = () => state.effects.filter((e) => e.rule === 'es.hotShot').length;
    arm(state.operatives[nth(state, 'p1', C.voidsman, 0)]!, 'Lasgun', lasgun);
    arm(state.operatives[nth(state, 'p1', C.voidsman, 1)]!, 'Lasgun', lasgun);
    expect(armed()).toBe(2);
    arm(state.operatives[nth(state, 'p1', C.voidsman, 2)]!, 'Lasgun', lasgun);
    expect(armed()).toBe(2); // the third is refused
    // Not a weapon the rule names.
    const master = state.operatives[opWith(state, 'p1', C.voidmaster)]!;
    state.turningPoint = 2;
    arm(master, 'Artificer shotgun', profileOf(C.voidmaster, 'Artificer shotgun', 'close range'));
    expect(armed()).toBe(2);
    arm(master, 'Relic laspistol', profileOf(C.voidmaster, 'Relic laspistol'));
    expect(armed()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('ELUCIA VHANE', () => {
  it('Digital Lasers: "inflict 1 damage on the enemy operative in that sequence" when it performs the Fight action', () => {
    expect(ability(C.vhane, AB.digitalLasers)).toContain('inflict 1 damage on the enemy operative in that sequence');
    const { ctx, state } = setup();
    const vhane = state.operatives[opWith(state, 'p1', C.vhane)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const rapier = profileOf(C.vhane, 'Monomolecular cane-rapier');
    fakeFight(state, vhane.id, foe.id, 'Monomolecular cane-rapier');
    const before = foe.wounds;
    const emit = () =>
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: attackCtx(vhane, foe, 'Monomolecular cane-rapier', rapier, 'melee'),
        count: 4,
        mods: zeroStatMods(),
      });
    emit();
    expect(before - foe.wounds).toBe(1);
    emit();
    expect(before - foe.wounds).toBe(1); // once per sequence
  });

  it('Merciless: Balanced "against an enemy operative that was already wounded", Ceaseless if it already has Balanced', () => {
    expect(ability(C.vhane, AB.merciless)).toContain('if the weapon already has that weapon rule, it has the Ceaseless weapon rule instead of Balanced');
    const { ctx, state } = setup();
    const vhane = state.operatives[opWith(state, 'p1', C.vhane)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const pistol = profileOf(C.vhane, 'Heirloom relic pistol');
    const rapier = profileOf(C.vhane, 'Monomolecular cane-rapier');
    const ranged = () =>
      effectiveRules(ctx, state, pistol, { operative: vhane, target: foe, weaponName: 'Heirloom relic pistol' });
    expect(ranged().some((r) => r.id === 'Balanced')).toBe(false);
    foe.wounds -= 1; // "already wounded when the action started"
    expect(ranged().some((r) => r.id === 'Balanced')).toBe(true);
    // "shooting against, fighting against or retaliating against": `onWeaponRules` is emitted by
    // both sequences, so the melee half is live too.
    expect(
      effectiveRules(ctx, state, rapier, { operative: vhane, target: foe, weaponName: 'Monomolecular cane-rapier' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(true);
    // Already Balanced → Ceaseless instead.
    const s = useGambit(ctx, state, SP.lethalProximity);
    const v2 = s.operatives[vhane.id]!;
    const f2 = s.operatives[foe.id]!;
    v2.pos = { x: 12, y: 11 };
    f2.pos = { x: 15, y: 11 };
    f2.wounds -= 1;
    const rules = effectiveRules(ctx, s, pistol, { operative: v2, target: f2, weaponName: 'Heirloom relic pistol' });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
  });

  it('Disruption Field and Rapid Reflexes: "Whenever an operative is shooting this operative, ignore the Piercing weapon rule"', () => {
    expect(ability(C.vhane, AB.disruptionField)).toContain('ignore the Piercing weapon rule');
    expect(ability(C.executioner, AB.rapidReflexes)).toContain('ignore the Piercing weapon rule');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', C.vhane)]!;
    const battery = PSA_WEAPONS.find((w) => w.name === 'Plasma battery')!.profiles[0]!; // Piercing 1
    const macro = PSA_WEAPONS.find((w) => w.name === 'Macrocannon')!.profiles[0]!; // Piercing Crits 1
    const rules = (target: OperativeState, profile: WeaponProfile, name: string) =>
      effectiveRules(ctx, state, profile, { operative: shooter, target, weaponName: name }).map((r) => r.id);
    for (const cardId of [C.vhane, C.executioner]) {
      const shielded = state.operatives[opWith(state, 'p1', cardId)]!;
      expect(rules(shielded, battery, 'Plasma battery')).not.toContain('Piercing');
      // The printed clause names the Piercing rule only: Piercing Crits x is a different rule.
      expect(rules(shielded, macro, 'Macrocannon')).toContain('PiercingCrits');
    }
    const other = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    expect(rules(other, battery, 'Plasma battery')).toContain('Piercing');
  });
});

// ---------------------------------------------------------------------------
describe('CANID', () => {
  it('Beast: "cannot perform any actions other than Charge, Dash, Fall Back, Fight, Gather, Guard, Reposition, Pick Up Marker and Place Marker"', () => {
    const { ctx, state } = setup();
    const canid = opWith(state, 'p1', C.canid);
    const s = activate(ctx, state, canid);
    const menu = availableActions(ctx, s, s.operatives[canid]!);
    const allowed = menu.filter((a) => a.ok).map((a) => a.def.id);
    expect(allowed).toContain('Reposition');
    expect(allowed).toContain(ACT.gather);
    expect(allowed).not.toContain('Shoot');
    expect(menu.find((a) => a.def.id === 'Shoot')!.reason).toMatch(/Beast/);
    // The other datacards are untouched.
    const master = opWith(state, 'p1', C.voidmaster);
    const t = activate(ctx, state, master);
    expect(availableActions(ctx, t, t.operatives[master]!).find((a) => a.def.id === 'Shoot')!.reason).toBeUndefined();
  });

  it('Loyal Companion: a free Charge when "an enemy operative ends the Charge action … within 3\\" of this operative"', () => {
    expect(ability(C.canid, AB.loyalCompanion)).toContain('this operative can immediately perform a free Charge action');
    const { ctx, state } = setup();
    const canid = state.operatives[opWith(state, 'p1', C.canid)]!;
    const buddy = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.executioner)]!;
    banish(state, 'p1', [canid.id, buddy.id]);
    banish(state, 'p2', [foe.id]);
    canid.pos = { x: 13, y: 11 };
    buddy.pos = { x: 15, y: 11 };
    foe.pos = { x: 16, y: 11 }; // within the buddy's control range
    foe.actionsThisActivation = ['Charge'];
    ctx.hooks.emit('onActivationEnd', state, { state, operative: foe });
    const grant = state.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === canid.id);
    expect(grant).toBeDefined();
    expect(grant!.data?.['only']).toEqual(['Charge']);
    // Not while the CANID is itself within control range of an enemy operative.
    const t = setup();
    const c2 = t.state.operatives[opWith(t.state, 'p1', C.canid)]!;
    const b2 = t.state.operatives[opWith(t.state, 'p1', C.voidsman)]!;
    const f2 = t.state.operatives[opWith(t.state, 'p2', C.executioner)]!;
    banish(t.state, 'p1', [c2.id, b2.id]);
    banish(t.state, 'p2', [f2.id]);
    c2.pos = { x: 15.4, y: 11 };
    b2.pos = { x: 15, y: 11 };
    f2.pos = { x: 16, y: 11 };
    f2.actionsThisActivation = ['Charge'];
    t.ctx.hooks.emit('onActivationEnd', t.state, { state: t.state, operative: f2 });
    expect(t.state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === c2.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('DEATH CULT EXECUTIONER', () => {
  it('Bladed Stance: "you can resolve one of your successes before the normal order" while retaliating', () => {
    expect(ability(C.executioner, AB.bladedStance)).toContain('resolve one of your successes before the normal order');
    const { ctx, state } = setup();
    const dce = state.operatives[opWith(state, 'p1', C.executioner)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidmaster)]!;
    fakeFight(state, foe.id, dce.id, 'Gun butt', { defenderWeapon: 'Power weapon' });
    expect((state.sequence as { turn: string }).turn).toBe('attacker');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(dce, foe, 'Power weapon', profileOf(C.executioner, 'Power weapon'), 'melee'),
      count: 5,
      mods: zeroStatMods(),
    });
    expect((state.sequence as { turn: string }).turn).toBe('defender');
  });

  it('Zealot: "you can strike the enemy operative … with one of your unresolved successes before this operative is removed"', () => {
    expect(ability(C.executioner, AB.zealot)).toContain('before this operative is removed from the killzone');
    const { ctx, state } = setup();
    const dce = state.operatives[opWith(state, 'p1', C.executioner)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidmaster)]!;
    banish(state, 'p1', [dce.id]);
    banish(state, 'p2', [foe.id]);
    dce.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.8, y: 11 };
    fakeFight(state, foe.id, dce.id, 'Gun butt', {
      defenderWeapon: 'Power weapon',
      defenderDice: [{ value: 6, state: 'crit' }],
    });
    const foeWounds = foe.wounds;
    inflictDamage(ctx, state, dce, dce.wounds, 'attack');
    expect(dce.incapacitated).toBe(true);
    // Power weapon Critical Dmg 6.
    expect(foeWounds - foe.wounds).toBe(profileOf(C.executioner, 'Power weapon').dmgC);
  });

  it('TRAINED ASSASSIN 1AP: "Change this operative’s order", but not while within control range of an enemy', () => {
    expect(uniqueActionText(C.executioner, ACT.trainedAssassin)).toContain('Change this operative’s order');
    const { ctx, state } = setup();
    const dce = opWith(state, 'p1', C.executioner);
    banish(state, 'p2');
    let s = activate(ctx, state, dce, 'engage');
    const out = reduce(s, { t: 'PerformAction', operativeId: dce, action: ACT.trainedAssassin }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[dce]!.order).toBe('conceal');
    // Engaged: refused.
    const foe = out.state.operatives[opWith(out.state, 'p2', C.voidsman)]!;
    foe.pos = { x: out.state.operatives[dce]!.pos.x + 0.8, y: out.state.operatives[dce]!.pos.y };
    s = out.state;
    expect(getAction(ACT.trainedAssassin)!.check(ctx, s, s.operatives[dce]!, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('LECTRO-MAESTER', () => {
  it('Missionary of the Martian Creed: "the Pick Up Marker, Place Marker or a mission action for 1 less AP", once per activation', () => {
    expect(ability(C.lectroMaester, AB.missionary)).toContain('for 1 less AP');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', C.lectroMaester)]!;
    expect(actionCost(ctx, state, op, getAction('Pick Up Marker')!)).toBe(0);
    expect(actionCost(ctx, state, op, getAction('Reposition')!)).toBe(1);
    op.actionsThisActivation = ['Pick Up Marker'];
    expect(actionCost(ctx, state, op, getAction('Place Marker')!)).toBe(1); // "Once during each … activation"
    // Only this datacard.
    const other = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    expect(actionCost(ctx, state, other, getAction('Pick Up Marker')!)).toBe(1);
  });

  it('Voltaghiest Array: "you can re-roll one of your defence dice" within 4"', () => {
    expect(ability(C.lectroMaester, AB.voltaghiestArray)).toContain('you can re-roll one of your defence dice');
    const { ctx, state } = setup();
    const maester = state.operatives[opWith(state, 'p1', C.lectroMaester)]!;
    const target = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    const grants = () =>
      ctx.hooks
        .emit('onDefenceDice', state, {
          state,
          ctx: attackCtx(shooter, target, 'Lasgun', lasgun),
          count: 3,
          coverSave: false,
          coverSaveAsCrit: false,
          extraCoverSaves: 0,
          mods: zeroStatMods(),
          rerolls: [],
        })
        .rerolls.map((g) => g.id);
    maester.pos = { x: 10, y: 11 };
    target.pos = { x: 12, y: 11 };
    expect(grants()).toContain('es.voltaghiestArray');
    target.pos = { x: 18, y: 11 };
    expect(grants()).not.toContain('es.voltaghiestArray');
  });

  it('CALIBRATE VOLTAGHEIST 0AP › Charge: "This operative’s voltaic pistol has the Lethal 4+ weapon rule"', () => {
    expect(uniqueActionText(C.lectroMaester, ACT.calibrate)).toContain('voltaic pistol has the Lethal 4+ weapon rule');
    expect(DATA.datacards.find((c) => c.id === C.lectroMaester)!.uniqueActions[0]!.ap).toBe(0);
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.lectroMaester);
    banish(state, 'p2');
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'PerformAction', operativeId: id, action: ACT.calibrate, params: { choice: 'charge' } }, ctx).state;
    expect(voltagheistMode(s, s.operatives[id]!)).toBe('charge');
    const pistol = profileOf(C.lectroMaester, 'Voltaic pistol');
    const foe = s.operatives[opWith(s, 'p2', C.voidsman)]!;
    const rules = effectiveRules(ctx, s, pistol, { operative: s.operatives[id]!, target: foe, weaponName: 'Voltaic pistol' });
    expect(rules.some((r) => r.id === 'Lethal' && r.x === 4)).toBe(true);
    // "…until the start of this operative's next activation."
    const later = activate(ctx, s, id);
    expect(voltagheistMode(later, later.operatives[id]!)).toBeUndefined();
  });

  it('CALIBRATE VOLTAGHEIST › Field: "inflict D6 damage on that enemy operative" within 4"', () => {
    expect(uniqueActionText(C.lectroMaester, ACT.calibrate)).toContain('inflict D6 damage on that enemy operative');
    const { ctx, state } = setup({ script: [5] });
    const id = opWith(state, 'p1', C.lectroMaester);
    banish(state, 'p2');
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'PerformAction', operativeId: id, action: ACT.calibrate, params: { choice: 'field' } }, ctx).state;
    expect(voltagheistMode(s, s.operatives[id]!)).toBe('field');
    const maester = s.operatives[id]!;
    const foe = s.operatives[opWith(s, 'p2', C.voidsman)]!;
    maester.pos = { x: 14, y: 11 };
    foe.pos = { x: 16, y: 11 };
    foe.actionsThisActivation = ['Reposition'];
    const before = foe.wounds;
    ctx.hooks.emit('onActivationEnd', s, { state: s, operative: foe });
    expect(before - foe.wounds).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('REJUVENAT ADEPT', () => {
  it('Medic!: "that friendly operative isn’t incapacitated, has 3 wounds remaining", once per turning point', () => {
    expect(ability(C.rejuvenatAdept, AB.medic)).toContain('has 3 wounds remaining');
    const { ctx, state } = setup();
    const adept = state.operatives[opWith(state, 'p1', C.rejuvenatAdept)]!;
    const victim = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    const other = state.operatives[nth(state, 'p1', C.voidsman, 1)]!;
    banish(state, 'p2');
    adept.pos = { x: 10, y: 11 };
    victim.pos = { x: 12, y: 11 };
    other.pos = { x: 12, y: 13 };
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(victim.incapacitated).toBe(false);
    expect(victim.wounds).toBe(3);
    expect(state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === victim.id)).toBe(true);
    // "The FIRST time during each turning point" — the next one is not saved.
    inflictDamage(ctx, state, other, 99, 'attack');
    expect(other.incapacitated).toBe(true);
  });

  it('Normaliser Helm: "ignore any changes to that operative’s stats from being injured" within 6"', () => {
    expect(ability(C.rejuvenatAdept, AB.normaliserHelm)).toContain('ignore any changes to that operative’s stats from being injured');
    const { ctx, state } = setup();
    const adept = state.operatives[opWith(state, 'p1', C.rejuvenatAdept)]!;
    const hurt = state.operatives[opWith(state, 'p1', C.voidmaster)]!;
    hurt.wounds = 3; // fewer than half of 8 → injured
    const shotgun = profileOf(C.voidmaster, 'Artificer shotgun', 'close range');
    adept.pos = { x: 10, y: 11 };
    hurt.pos = { x: 14, y: 11 };
    expect(moveOf(ctx, state, hurt)).toBe(6);
    expect(hitOf(ctx, state, hurt, shotgun)).toBe(3);
    adept.pos = { x: 1, y: 1 }; // more than 6" away
    expect(moveOf(ctx, state, hurt)).toBe(4); // "Subtract 2\" from the Move stat", floored at 4"
    expect(hitOf(ctx, state, hurt, shotgun)).toBe(4);
  });

  it('HEALING SERUM 1AP: "one friendly … operative within this operative’s control range to regain up to D3+3 lost wounds"', () => {
    expect(uniqueActionText(C.rejuvenatAdept, ACT.healingSerum)).toContain('regain up to D3+3 lost wounds');
    const { ctx, state } = setup({ script: [3] }); // D6 3 → D3 2 → 5 wounds
    const adept = opWith(state, 'p1', C.rejuvenatAdept);
    const patient = opWith(state, 'p1', C.voidsman);
    banish(state, 'p2');
    state.operatives[adept]!.pos = { x: 12, y: 11 };
    state.operatives[patient]!.pos = { x: 12.8, y: 11 };
    state.operatives[patient]!.wounds = 1;
    const far = state.operatives[nth(state, 'p1', C.voidsman, 1)]!;
    far.pos = { x: 20, y: 3 };
    let s = activate(ctx, state, adept);
    // D-026: everything `perform` needs is validated in `check`.
    expect(getAction(ACT.healingSerum)!.check(ctx, s, s.operatives[adept]!, { targetOperativeId: far.id }).ok).toBe(false);
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: adept, action: ACT.healingSerum, params: { targetOperativeId: patient } },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.state.operatives[patient]!.wounds).toBe(6);
    expect(out.state.rejected).toEqual([]);
    // "It cannot be an operative that the Medic! rule was used on during this turning point."
    s = out.state;
    setScratch(s, 'es.medicUsed', { [patient]: s.turningPoint });
    expect(getAction(ACT.healingSerum)!.check(ctx, s, s.operatives[adept]!, { targetOperativeId: patient }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('VOIDMASTER and VOIDSMAN', () => {
  it('Disciplinarian (SUPPORT): "another friendly NAVIS operative … within 3\\" … Balanced (excluding PRIVATEER SUPPORT ASSET weapons)"', () => {
    expect(ability(C.voidmaster, AB.disciplinarian)).toContain('SUPPORT.');
    expect(ability(C.voidmaster, AB.disciplinarian)).toContain('excluding PRIVATEER SUPPORT ASSET weapons');
    const { ctx, state } = setup();
    const master = state.operatives[opWith(state, 'p1', C.voidmaster)]!;
    const mate = state.operatives[opWith(state, 'p1', C.voidsman)]!;
    const foe = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    const lasgun = profileOf(C.voidsman, 'Lasgun');
    master.pos = { x: 10, y: 11 };
    mate.pos = { x: 12, y: 11 };
    const rules = (op: OperativeState, profile: WeaponProfile, name: string) =>
      effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: name }).map((r) => r.id);
    expect(rules(mate, lasgun, 'Lasgun')).toContain('Balanced');
    // "another" — never the VOIDMASTER itself.
    expect(rules(master, profileOf(C.voidmaster, 'Relic laspistol'), 'Relic laspistol')).not.toContain('Balanced');
    // The exclusion.
    const beam = PSA_WEAPONS.find((w) => w.name === 'Archeotech beam')!.profiles[0]!;
    expect(rules(mate, beam, 'Archeotech beam')).not.toContain('Balanced');
    mate.pos = { x: 18, y: 11 }; // beyond 3"
    expect(rules(mate, lasgun, 'Lasgun')).not.toContain('Balanced');
  });

  it('Hardy: "when an attack dice inflicts Normal Dmg on this operative, you can ignore that inflicted damage" — once per battle', () => {
    expect(ability(C.voidmaster, AB.hardy)).toContain('Once per battle');
    const { ctx, state } = setup();
    const master = state.operatives[opWith(state, 'p1', C.voidmaster)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.voidsman)]!;
    fakeShoot(state, shooter.id, master.id, 'Rotor cannon', [{ value: 5, state: 'normal' }], { profileName: 'focused' });
    const before = master.wounds;
    inflictDamage(ctx, state, master, 4, 'attack'); // Normal Dmg 4 → ignored
    expect(before - master.wounds).toBe(0);
    const mid = master.wounds;
    inflictDamage(ctx, state, master, 4, 'attack');
    expect(mid - master.wounds).toBe(4); // once per battle
  });

  it('Crewmen: "you can counteract with one friendly VOIDSMAN operative that has a Conceal order … using a PRIVATEER SUPPORT ASSET"', () => {
    expect(ability(C.voidsman, AB.crewmen)).toContain('you cannot perform any actions other than Shoot');
    const { ctx, state } = setup();
    const voidsmanId = opWith(state, 'p1', C.voidsman);
    for (const id of state.teams.p1.operativeIds) {
      const op = state.operatives[id]!;
      op.ready = false;
      op.expended = true;
      op.order = 'conceal';
    }
    // Only the VOIDSMEN are widened; a conceal DEATH CULT EXECUTIONER still cannot counteract.
    const ids = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(voidsmanId);
    expect(ids).not.toContain(opWith(state, 'p1', C.executioner));
    // Once a PRIVATEER SUPPORT ASSET has been used this turning point, the widening is gone.
    setScratch(state, 'teamOnce', { 'es.psaPhase:p1': `${state.turningPoint}` });
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(voidsmanId);
    delete (state.opState['teamOnce'] as Record<string, unknown>)[`es.psaPhase:p1`];
    // While counteracting it may only Shoot, and only with a PRIVATEER SUPPORT ASSET.
    state.opState['counteract'] = { operativeId: voidsmanId, actionsUsed: 0 };
    state.activeOperativeId = voidsmanId;
    const op = state.operatives[voidsmanId]!;
    const can = (action: string) =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action, allowed: true }).allowed;
    expect(can('Shoot')).toBe(true);
    expect(can('Reposition')).toBe(false);
    expect(weaponsOf(ctx, state, op, 'ranged').map((w) => w.name).every(isPsaWeapon)).toBe(true);
  });

  it('UNCOMPROMISING FIRE 1AP: "two free Shoot actions … relic laspistol for one action and its artificer shotgun (close range) for the other"', () => {
    expect(uniqueActionText(C.voidmaster, ACT.uncompromisingFire)).toContain(
      'relic laspistol for one action and its artificer shotgun (close range) for the other',
    );
    // Every attack dice fails, so the first shot cannot incapacitate the target and the second
    // free Shoot still has one.
    const { ctx, state } = setup({ script: Array.from({ length: 40 }, () => 1) });
    const master = opWith(state, 'p1', C.voidmaster);
    const foe = opWith(state, 'p2', C.voidsman);
    banish(state, 'p1', [master]);
    banish(state, 'p2', [foe]);
    state.operatives[master]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 17, y: 11 };
    let s = activate(ctx, state, master, 'engage');
    const first = reduce(s, { t: 'PerformAction', operativeId: master, action: ACT.uncompromisingFire, params: { targetId: foe } }, ctx);
    expect(first.ok).toBe(true);
    s = settle(ctx, first.state);
    expect(s.log.some((l) => l.text.includes('Relic laspistol'))).toBe(true);
    // The second free Shoot is its own 0AP action, offered only now.
    const menu = availableActions(ctx, s, s.operatives[master]!);
    expect(menu.find((a) => a.def.id === SHOOT_UNCOMPROMISING)?.ok).toBe(true);
    expect(menu.find((a) => a.def.id === SHOOT_UNCOMPROMISING)?.ap).toBe(0);
    // "…or during an activation in which it performed the Shoot action (or vice versa)."
    expect(menu.find((a) => a.def.id === 'Shoot')!.ok).toBe(false);
    const second = reduce(s, { t: 'PerformAction', operativeId: master, action: SHOOT_UNCOMPROMISING, params: { targetId: foe } }, ctx);
    expect(second.ok).toBe(true);
    s = settle(ctx, second.state);
    expect(s.log.some((l) => l.text.includes('Artificer shotgun'))).toBe(true);
    expect(s.rejected).toEqual([]);
    expect(availableActions(ctx, s, s.operatives[master]!).find((a) => a.def.id === SHOOT_UNCOMPROMISING)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('CANID › GATHER', () => {
  it('GATHER 1AP: "Perform a free Dash or Reposition action … a free Pick Up Marker or Place Marker action"', () => {
    expect(uniqueActionText(C.canid, ACT.gather)).toContain('Perform a free Dash or Reposition action with this operative');
    const { ctx, state } = setup();
    const canid = opWith(state, 'p1', C.canid);
    banish(state, 'p2');
    let s = activate(ctx, state, canid);
    const out = reduce(s, { t: 'PerformAction', operativeId: canid, action: ACT.gather }, ctx);
    expect(out.ok).toBe(true);
    s = out.state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === canid);
    expect(grant?.data?.['only']).toEqual(['Dash', 'Reposition', 'Pick Up Marker', 'Place Marker']);
    expect(aplOf(ctx, s, s.operatives[canid]!)).toBe(3); // 2 APL + the free action
    // Once the CANID's own AP is spent, the bonus AP is restricted to those four actions.
    s.operatives[canid]!.apSpent = 2;
    const menu = availableActions(ctx, s, s.operatives[canid]!);
    expect(menu.find((a) => a.def.id === 'Reposition')!.ok).toBe(true);
    expect(menu.find((a) => a.def.id === 'Fight')!.ok).toBe(false);
    // While engaged there is no Dash or Reposition to make free, so the action is refused.
    const t = setup();
    const c2 = t.state.operatives[opWith(t.state, 'p1', C.canid)]!;
    const f2 = t.state.operatives[opWith(t.state, 'p2', C.voidsman)]!;
    f2.pos = { x: c2.pos.x + 0.8, y: c2.pos.y };
    expect(getAction(ACT.gather)!.check(t.ctx, t.state, c2, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('terrain interaction', () => {
  it('a PRIVATEER SUPPORT ASSET still needs a valid target: "you must still select a valid target as normal"', () => {
    expect(rule(RULE.psa)).toContain('you must still select a valid target as normal');
    const map = testMap({ features: [heavyBlock('wall', 14, 8, 2, 6, 4)] });
    const { ctx, state } = setup({ map });
    const vhane = opWith(state, 'p1', C.vhane);
    const foe = opWith(state, 'p2', C.voidsman);
    banish(state, 'p1', [vhane]);
    banish(state, 'p2', [foe]);
    state.operatives[vhane]!.pos = { x: 10, y: 11 };
    state.operatives[foe]!.pos = { x: 20, y: 11 }; // behind the wall
    const s = activate(ctx, state, vhane);
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: vhane, action: 'Shoot', params: { weaponName: 'Archeotech beam', targetId: foe } },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not visible|valid target/);
    // …and the asset was NOT spent, because the action was cancelled and reverted.
    expect(psaUsedThisTP(out.state, 'p1')).toBe(false);
  });
});
