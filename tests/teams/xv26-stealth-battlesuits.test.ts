/**
 * XV26 STEALTH BATTLESUITS. Every test quotes the printed rule it pins, read out of
 * `data/teams/xv26-stealth-battlesuits.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/xv26-stealth-battlesuits/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { selectExplosiveGrenades } from '../../src/core/equipment/grenades.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { counteractCandidates, gambitOptions, readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import {
  aliveOperatives,
  apBudgetOf,
  aplOf,
  freeApOf,
  hitOf,
  markerController,
  moveOf,
  statMods,
} from '../../src/core/state.ts';
import rawJson from '../../data/teams/xv26-stealth-battlesuits.json';
import { teamData } from '../../src/teams/data.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  AB,
  ACT,
  BONDS_DECISION,
  DESIGNATOR,
  DRONE_CONTROLLER_GAMBIT,
  EQ,
  FP,
  GRENADIER_SMOKE,
  GRENADIER_STUN,
  HARDWIRED_SHOOT,
  INFILTRATOR,
  JAMMERS_GAMBIT,
  KW,
  LIBERATOR,
  LODESTAR,
  MV15_GUN_DRONE,
  MV75_MARKER_DRONE,
  NEUTRALISER,
  REMINDER_ONLY,
  RULE,
  SHAS_VRE,
  SP,
  THRUSTER_REPOSITION,
  beaconDice,
  greaterGoodActive,
  isMarked,
  kauyonAccurate,
  multispectrumDashEndLegal,
  xv26StealthBattlesuits,
} from '../../src/teams/xv26-stealth-battlesuits/index.ts';
import { act, activate, battle, opWith, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('xv26-stealth-battlesuits');
const MODULE = xv26StealthBattlesuits;

/**
 * Only 7 of the 8 datacards fit in a kill team, so the rule tests field the fixed three plus
 * four of the list — with an explicit loadout, because a list row whose loadout is not named
 * resolves to its `alwaysWeapons` alone (the LIBERATOR would go to war with just its EMP bomb).
 */
const ENTRY: Record<string, string> = {
  [SHAS_VRE]: 'xv26-stealth-battlesuits.sel0.shas-vre',
  [MV75_MARKER_DRONE]: 'xv26-stealth-battlesuits.sel1.mv75-marker-drone',
  [MV15_GUN_DRONE]: 'xv26-stealth-battlesuits.sel2.mv15-gun-drone',
  [DESIGNATOR]: 'xv26-stealth-battlesuits.sel3.designator',
  [INFILTRATOR]: 'xv26-stealth-battlesuits.sel4.infiltrator',
  [LIBERATOR]: 'xv26-stealth-battlesuits.sel5.liberator',
  [LODESTAR]: 'xv26-stealth-battlesuits.sel6.lodestar',
  [NEUTRALISER]: 'xv26-stealth-battlesuits.sel7.neutraliser',
};
/** "Burst cannon; fists", the first of the two printed footnote options. */
const BURST_LOADOUT = 'xv26-stealth-battlesuits.fn1o1';
const ROLES = [DESIGNATOR, LIBERATOR, LODESTAR, NEUTRALISER];

function picksFor(list: string[]) {
  return [
    { datacardId: SHAS_VRE, entryId: ENTRY[SHAS_VRE]!, loadoutIds: ['xv26-stealth-battlesuits.g1.opt1'] },
    { datacardId: MV75_MARKER_DRONE, entryId: ENTRY[MV75_MARKER_DRONE]! },
    { datacardId: MV15_GUN_DRONE, entryId: ENTRY[MV15_GUN_DRONE]! },
    ...list.map((id) => ({ datacardId: id, entryId: ENTRY[id]!, loadoutIds: [BURST_LOADOUT] })),
  ];
}

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
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([MODULE], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = picksFor(opts.roles ?? ROLES);
  const state = battle({
    ctx,
    p1: { module: MODULE, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: MODULE, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Park everything not under test out of the way, so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    op.z = 0;
    n++;
  }
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function shootSeq(
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
    distance: 6,
  };
}

const ruleIds = (rules: { id: string }[]): string[] => rules.map((r) => r.id);
const accurateOf = (rules: { id: string; x?: number }[]): number | undefined =>
  rules.find((r) => r.id === 'Accurate')?.x;

// ===========================================================================
describe('XV26 STEALTH BATTLESUITS data (pinned against data/teams/xv26-stealth-battlesuits.json)', () => {
  it('has 8 datacards: six APL 3 / Save 3+ battlesuits on 32mm and two APL 2 / Save 4+ DRONEs on 28mm', () => {
    expect(DATA.datacards).toHaveLength(8);
    for (const card of DATA.datacards) {
      expect(card.keywords).toContain(KW);
      expect(card.keywords).toContain("T'AU EMPIRE");
      expect(card.move).toBe(6);
    }
    const suits = DATA.datacards.filter((c) => !c.keywords.includes('DRONE'));
    expect(suits.map((c) => c.id).sort()).toEqual(
      [SHAS_VRE, DESIGNATOR, INFILTRATOR, LIBERATOR, LODESTAR, NEUTRALISER].sort(),
    );
    for (const card of suits) expect(card).toMatchObject({ apl: 3, save: 3, base: { shape: 'round', mm: 32 } });
    expect(DATA.datacards.find((c) => c.id === SHAS_VRE)).toMatchObject({ wounds: 13 });
    expect(suits.filter((c) => c.wounds !== 12).map((c) => c.id)).toEqual([SHAS_VRE]);
    for (const id of [MV15_GUN_DRONE, MV75_MARKER_DRONE]) {
      expect(DATA.datacards.find((c) => c.id === id)).toMatchObject({
        apl: 2,
        save: 4,
        wounds: 7,
        base: { shape: 'round', mm: 28 },
      });
    }
    expect(DATA.datacards.find((c) => c.id === SHAS_VRE)!.keywords).toContain('LEADER');
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(SHAS_VRE, 'Burst cannon', 'focused')).toMatchObject({ atk: 5, hit: 4, dmgN: 3, dmgC: 4 });
    expect(ruleIds(profileOf(SHAS_VRE, 'Burst cannon', 'focused').rules)).toEqual(['Ceaseless']);
    // XV26 MULTITRACKERS upgrades exactly this profile's Torrent 1" to Torrent 2".
    expect(profileOf(SHAS_VRE, 'Burst cannon', 'sweeping')).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 4 });
    expect(profileOf(SHAS_VRE, 'Burst cannon', 'sweeping').rules).toContainEqual({
      id: 'Torrent',
      x: 1,
      raw: 'Torrent 1"',
    });
    expect(ruleIds(profileOf(SHAS_VRE, 'Fusion blaster', 'short range').rules)).toEqual([
      'Range',
      'Devastating',
      'Piercing',
    ]);
    expect(ruleIds(profileOf(SHAS_VRE, 'Fusion blaster', 'long range').rules)).toEqual(['Range', 'Piercing']);
    expect(profileOf(SHAS_VRE, 'Pulse pistol', 'point-blank')).toMatchObject({ type: 'melee', atk: 3, dmgN: 4 });
    expect(ruleIds(profileOf(LIBERATOR, 'EMP bomb').rules)).toEqual([
      'Range',
      'Blast',
      'Devastating',
      'Heavy',
      'Lethal',
      'Limited',
      'Saturate',
    ]);
    expect(profileOf(MV15_GUN_DRONE, 'Twin pulse carbine')).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 5 });
    expect(profileOf(MV75_MARKER_DRONE, 'Ram')).toMatchObject({ type: 'melee', atk: 3, hit: 5, dmgN: 2, dmgC: 3 });
  });

  it('exposes 2 faction rules, 4+4 ploys, 4 equipment options, 11 abilities, 3 unique actions and no rare rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Kauyon', 'Stealth Fields']);
    expect(MODULE.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(MODULE.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(MODULE.ploys.every((p) => p.cp === 1)).toBe(true);
    expect(MODULE.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(11);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(3);
    expect(DATA.rareWeaponRules).toEqual([]);
    expect((rawJson as { notes: string[] }).notes).toEqual([]);
  });

  it('prices the three unique actions 1AP / 2AP / 1AP as printed', () => {
    expect(actionOf(DESIGNATOR, ACT.focusedMarkerligh).ap).toBe(1);
    expect(actionOf(NEUTRALISER, ACT.systemJam).ap).toBe(2);
    expect(actionOf(MV15_GUN_DRONE, ACT.photonGrenadeLauncher).ap).toBe(1);
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    // The committed bytes still carry the overrun — the data problem, not the module.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect((rawJson as { firefightPloys: { text: string }[] }).firefightPloys[3]!.text).toContain('Faction Equipment');
  });

  it('no rule in this team ends at a colon with its effect list missing (the batch-3/4 data bug)', () => {
    const all = [
      ...DATA.factionRules,
      ...DATA.strategyPloys,
      ...DATA.firefightPloys,
      ...DATA.equipment,
      ...DATA.datacards.flatMap((c) => c.abilities),
      ...DATA.datacards.flatMap((c) => c.uniqueActions),
    ];
    for (const r of all) expect(r.text.trim().endsWith(':')).toBe(false);
  });

  it('DATA PROBLEM: the DESIGNATOR’s unique action is printed "FOCUSED MARKERLIGH", missing its final T', () => {
    expect(actionOf(DESIGNATOR, ACT.focusedMarkerligh).name).toBe('FOCUSED MARKERLIGH');
    expect(ACT.focusedMarkerligh.endsWith('focused-markerligh')).toBe(true);
  });

  it('"Your kill team can only include up to two fusion blasters." — a plural cap still matches', () => {
    expect(DATA.selection.constraints).toContainEqual({ kind: 'maxItem', item: 'fusion blasters', max: 2 });
    expect(DATA.selection.rawText).toContain('Your kill team can only include up to two fusion blasters.');
    // The datacards print the weapon SINGULAR, so an exact match made the cap dead. The validator
    // now tolerates the printed plural (docs/DECISIONS.md D-040).
    expect(DATA.datacards.flatMap((c) => c.weapons).some((w) => w.name === 'Fusion blaster')).toBe(true);
    expect(DATA.datacards.flatMap((c) => c.weapons).some((w) => w.name === 'fusion blasters')).toBe(false);
    const fusion = (id: string) => ({ datacardId: id, weapons: ['Fusion blaster'] });
    const picks = [
      { datacardId: SHAS_VRE, entryId: 'xv26-stealth-battlesuits.sel0.shas-vre' },
      { datacardId: MV75_MARKER_DRONE, entryId: 'xv26-stealth-battlesuits.sel1.mv75-marker-drone' },
      { datacardId: MV15_GUN_DRONE, entryId: 'xv26-stealth-battlesuits.sel2.mv15-gun-drone' },
      fusion(DESIGNATOR),
      fusion(INFILTRATOR),
      fusion(LIBERATOR),
      fusion(LODESTAR),
    ];
    const v = validateRosterFor(DATA, picks);
    expect(v.ok).toBe(false);
    expect(v.codes).toContain('maxItem');
    expect(v.errors.join(' ')).toContain('up to 2 fusion blasters');
  });

  it('"with pulse pistol and one of the following options" — the SHAS’VRE carries ONE of the two guns', () => {
    const leader = DATA.selection.leaderList[0]!;
    expect(leader.rawText).toContain('with pulse pistol and one of the following options');
    // The single printed option is "Burst cannon or fusion blaster" — a choice group, not two
    // weapons. The scraper still copies both alternatives into `alwaysWeapons`, but a weapon a
    // choice group OFFERS is no longer also treated as always available, so the leader no longer
    // goes to war carrying both heavy weapons at once.
    expect(leader.alwaysWeapons).toEqual(['Burst cannon', 'Fusion blaster']);
    expect(leader.loadouts[0]).toMatchObject({
      label: 'Burst cannon or fusion blaster',
      weapons: [],
      choiceGroups: [['Burst cannon', 'Fusion blaster']],
    });
    const v = validateRosterFor(DATA, defaultRoster(DATA));
    expect(v.ok).toBe(true);
    expect(v.weapons[0]).toEqual(['Burst cannon', 'Pulse pistol']);
    // The other alternative is reachable by naming it on the pick — and is still exactly one gun.
    const fusionLeader = defaultRoster(DATA).map((p, i) => (i === 0 ? { ...p, weapons: ['Fusion blaster'] } : p));
    const fv = validateRosterFor(DATA, fusionLeader);
    expect(fv.ok).toBe(true);
    expect(fv.weapons[0]).toEqual(['Fusion blaster', 'Pulse pistol']);
  });
});

// ===========================================================================
describe('XV26 STEALTH BATTLESUITS selection', () => {
  it('prints "Other than INFILTRATOR operatives, your kill team can only include each operative … once"', () => {
    expect(DATA.selection.constraints).toContainEqual({ kind: 'uniqueExcept', roles: ['INFILTRATOR'] });
    expect(DATA.selection.rawText).toContain(
      'Other than INFILTRATOR operatives, your kill team can only include each operative on this list once.',
    );
    expect(DATA.selection.totalOperatives).toBe(7);
  });

  it('defaultRoster is a legal 7-operative kill team — and fields only 5 of the 8 datacards', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(7);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    // The printed-order fill repeats INFILTRATOR, the first repeatable row, so three datacards
    // never appear in the default roster or in the shared soak. That is the printed default; a
    // coverage-maximising soak roster is a separate concern (docs/DECISIONS.md D-042).
    expect(picks.filter((p) => p.datacardId === INFILTRATOR)).toHaveLength(3);
    const fielded = new Set(picks.map((p) => p.datacardId));
    expect([...fielded].sort()).toEqual([SHAS_VRE, DESIGNATOR, INFILTRATOR, MV15_GUN_DRONE, MV75_MARKER_DRONE].sort());
    for (const missing of [LIBERATOR, LODESTAR, NEUTRALISER]) expect(fielded.has(missing)).toBe(false);
  });

  it('the uniqueness rule still bites every role but INFILTRATOR', () => {
    const picks = defaultRoster(DATA).map((p) =>
      p.datacardId === INFILTRATOR ? { ...p, datacardId: LODESTAR, entryId: undefined } : p,
    );
    expect(validateRosterFor(DATA, picks).ok).toBe(false);
  });
});

// ===========================================================================
describe('Kauyon (faction rule)', () => {
  const quote = () => ruleText(RULE.kauyon);

  it('"Within 3\\" of your territory — Accurate 1"', () => {
    expect(quote()).toContain('Within 3" of your territory');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 17, 11);
    expect(kauyonAccurate(T, state, enemy)).toBe(1);
  });

  it('"Within your territory — Accurate 2"', () => {
    expect(quote()).toContain('Within your territory');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 11, 11);
    expect(kauyonAccurate(T, state, enemy)).toBe(2);
  });

  it('"Within 3\\" of your drop zone — Accurate 3"', () => {
    expect(quote()).toContain('Within 3" of your drop zone');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 4, 11);
    expect(kauyonAccurate(T, state, enemy)).toBe(3);
  });

  it('an enemy in its own half is outside every band, so no Accurate is granted', () => {
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 26, 11);
    expect(kauyonAccurate(T, state, enemy)).toBe(0);
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 20, 11);
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Burst cannon',
    });
    expect(accurateOf(rules)).toBeUndefined();
  });

  it('"its ranged weapons have the Accurate X weapon rule" — the grant reaches the shoot sequence', () => {
    expect(quote()).toContain('its ranged weapons have the Accurate X weapon rule');
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 9, 5);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 11, 11);
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Burst cannon',
    });
    expect(accurateOf(rules)).toBe(2);
  });

  it('melee weapons get nothing — the rule names ranged weapons only', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 9, 5);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 11, 11);
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Fists'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Fists',
    });
    expect(accurateOf(rules)).toBeUndefined();
  });
});

// ===========================================================================
describe("SHAS'VRE › For the Greater Good", () => {
  const quote = () => abilityText(SHAS_VRE, AB.forTheGreaterGood);

  it('"add 1 to the result if 2 or more friendly … operatives (excluding DRONE) are incapacitated"', () => {
    expect(quote()).toContain('2 or more friendly XV26 STEALTH BATTLESUIT operatives (excluding DRONE)');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 17, 11);
    expect(greaterGoodActive(T, state)).toBe(false);
    expect(kauyonAccurate(T, state, enemy)).toBe(1);
    state.operatives[opWith(state, 'p1', LIBERATOR)]!.removed = true;
    expect(greaterGoodActive(T, state)).toBe(false); // one is not enough
    state.operatives[opWith(state, 'p1', LODESTAR)]!.removed = true;
    expect(greaterGoodActive(T, state)).toBe(true);
    expect(kauyonAccurate(T, state, enemy)).toBe(2);
  });

  it('"you must have a minimum of Accurate 1 to use this rule"', () => {
    expect(quote()).toContain('minimum of Accurate 1');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    state.operatives[opWith(state, 'p1', LIBERATOR)]!.removed = true;
    state.operatives[opWith(state, 'p1', LODESTAR)]!.removed = true;
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 26, 11);
    expect(greaterGoodActive(T, state)).toBe(true);
    expect(kauyonAccurate(T, state, enemy)).toBe(0);
  });

  it('"(to a maximum of Accurate 3)" and "if this operative is in the killzone"', () => {
    expect(quote()).toContain('to a maximum of Accurate 3');
    expect(quote()).toContain('if this operative is in the killzone');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    state.operatives[opWith(state, 'p1', LIBERATOR)]!.removed = true;
    state.operatives[opWith(state, 'p1', LODESTAR)]!.removed = true;
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 4, 11);
    expect(kauyonAccurate(T, state, enemy)).toBe(3); // 3 + 1, capped
    state.operatives[opWith(state, 'p1', SHAS_VRE)]!.removed = true;
    expect(greaterGoodActive(T, state)).toBe(false);
  });

  it('DRONEs are excluded from the incapacitated count', () => {
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    state.operatives[opWith(state, 'p1', MV15_GUN_DRONE)]!.removed = true;
    state.operatives[opWith(state, 'p1', MV75_MARKER_DRONE)]!.removed = true;
    expect(greaterGoodActive(T, state)).toBe(false);
  });
});

// ===========================================================================
describe('Stealth Fields (faction rule)', () => {
  const quote = () => ruleText(RULE.stealthFields);

  it('"it cannot be visible to enemy operatives more than 3\\" from it (this takes precedence…)"', () => {
    expect(quote()).toContain('it cannot be visible to enemy operatives more than 3" from it');
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 20, 11);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    target.order = 'conceal';
    isolate(state, [shooter.id, target.id]);
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: true,
    });
    expect(ev.valid).toBe(false);
    expect(ev.forceVisible).toBe(false);
    expect(ev.reason).toContain('Stealth Fields');
  });

  it('within 3" the battlesuit is a valid target again', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 14, 11);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    target.order = 'conceal';
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.valid).toBe(true);
  });

  it('an Engage order is untouched — the rule only names a Conceal order', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 20, 11);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    target.order = 'engage';
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.valid).toBe(true);
  });

  it('"it can perform the Fall Back action for 1 less AP"', () => {
    expect(quote()).toContain('it can perform the Fall Back action for 1 less AP');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    const fallBack = getAction('Fall Back')!;
    expect(fallBack.ap).toBe(2);
    op.order = 'engage';
    expect(actionCost(ctx, state, op, fallBack)).toBe(2);
    op.order = 'conceal';
    expect(actionCost(ctx, state, op, fallBack)).toBe(1);
  });
});

// ===========================================================================
describe('PATIENT HUNTERS (strategy ploy)', () => {
  const quote = () => ruleText(SP.patientHunters);

  it('"…shooting against or fighting against an expended enemy operative … Balanced … Saturate"', () => {
    expect(quote()).toContain('shooting against or fighting against an expended enemy operative');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.patientHunters);
    const shooter = state.operatives[opWith(state, 'p1', DESIGNATOR)]!;
    const enemy = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    enemy.expended = true;
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Burst cannon',
    });
    expect(ruleIds(rules)).toContain('Balanced');
    expect(ruleIds(rules)).toContain('Saturate');
  });

  it('a melee weapon gets Balanced only — "its RANGED weapons have the Saturate weapon rule"', () => {
    expect(quote()).toContain('its ranged weapons have the Saturate weapon rule');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.patientHunters);
    const fighter = state.operatives[opWith(state, 'p1', DESIGNATOR)]!;
    const enemy = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    enemy.expended = true;
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Fists'), {
      operative: fighter,
      target: enemy,
      weaponName: 'Fists',
    });
    expect(ruleIds(rules)).toContain('Balanced');
    expect(ruleIds(rules)).not.toContain('Saturate');
  });

  it('a ready enemy operative is not expended, so nothing is granted', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.patientHunters);
    const shooter = state.operatives[opWith(state, 'p1', DESIGNATOR)]!;
    const enemy = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    enemy.expended = false;
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Burst cannon',
    });
    expect(ruleIds(rules)).not.toContain('Balanced');
  });
});

// ===========================================================================
describe('PREPARE AMBUSH (strategy ploy)', () => {
  const quote = () => ruleText(SP.prepareAmbush);

  function useAmbush(ctx: GameContext, state: GameState, data?: Record<string, unknown>): GameState {
    state.teams.p1.gambitsUsedTP.push(SP.prepareAmbush);
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: SP.prepareAmbush,
      kind: 'strategy',
      ...(data ? { data } : {}),
    });
    return state;
  }

  it('"Place one of your Ambush markers wholly within your territory and more than 2\\" from enemy operatives"', () => {
    expect(quote()).toContain('wholly within your territory and more than 2" from enemy operatives');
    const { ctx, state } = setup();
    aliveOperatives(state, 'p2').forEach((e, i) => place(state, e.id, 27, 3 + i * 1.4));
    useAmbush(ctx, state);
    const marker = state.markers['xv26.ambush.p1'];
    expect(marker).toBeDefined();
    // wholly within p1's territory (x in [0,15]) and clear of every enemy operative
    expect(marker!.pos.x).toBeGreaterThan(0.4);
    expect(marker!.pos.x).toBeLessThan(15 - 0.39);
    const T = hooksFor(ctx, 'p1');
    for (const e of aliveOperatives(state, 'p2')) expect(T.markerGap(e, marker!)).toBeGreaterThan(2);
  });

  it('"…that friendly operative’s ranged weapons have the Seek weapon rule" — spent when cover denies the shot', () => {
    expect(quote()).toContain('ranged weapons have the Seek weapon rule until the end of the action');
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 3, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 26, 11);
    isolate(state, [shooter.id, enemy.id]);
    // The marker is planted while the enemy is still far away, as the placement rule demands;
    // the enemy then walks into its 2" radius.
    useAmbush(ctx, state, { pos: { x: 12, y: 12 } });
    expect(state.markers['xv26.ambush.p1']!.pos).toEqual({ x: 12, y: 12 });
    place(state, enemy.id, 12, 11);
    // No cover on the open test map, so the policy declines to spend the marker.
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'focused');
    let rules = effectiveRules(ctx, state, profile, { operative: shooter, target: enemy, weaponName: 'Burst cannon' });
    expect(ruleIds(rules)).not.toContain('Seek');
    expect(state.markers['xv26.ambush.p1']).toBeDefined();
    // Force the cover branch: a Conceal-order target in cover is not a valid target at all.
    ctx.hooks.on(
      'onValidTarget',
      { id: 'test.cover', sourceText: 'test', priority: 1 },
      (ev) => {
        if (ev.target.id === enemy.id) {
          ev.valid = false;
          ev.reason = 'target has a Conceal order and is in cover';
        }
      },
    );
    rules = effectiveRules(ctx, state, profile, { operative: shooter, target: enemy, weaponName: 'Burst cannon' });
    expect(ruleIds(rules)).toContain('Seek');
    // "If you do, remove that marker" — claimed at the (non-dry-run) Select Weapon emit.
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, enemy, profile, 'Burst cannon'),
      allowed: true,
      dryRun: false,
    });
    expect(state.markers['xv26.ambush.p1']).toBeUndefined();
    rules = effectiveRules(ctx, state, profile, { operative: shooter, target: enemy, weaponName: 'Burst cannon' });
    expect(ruleIds(rules)).toContain('Seek'); // still Seek for the rest of the action
  });

  it('a dry-run Select Weapon never removes the marker (docs/DECISIONS.md D-032)', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 3, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 26, 11);
    isolate(state, [shooter.id, enemy.id]);
    useAmbush(ctx, state, { pos: { x: 12, y: 12 } });
    place(state, enemy.id, 12, 11);
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, enemy, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), 'Burst cannon'),
      allowed: true,
      dryRun: true,
    });
    expect(state.markers['xv26.ambush.p1']).toBeDefined();
  });

  it('"In the Ready step of the next Strategy phase … remove that marker"', () => {
    expect(quote()).toContain('In the Ready step of the next Strategy phase');
    const { ctx, state } = setup();
    aliveOperatives(state, 'p2').forEach((e, i) => place(state, e.id, 27, 3 + i * 1.4));
    useAmbush(ctx, state, { pos: { x: 12, y: 12 } });
    expect(state.markers['xv26.ambush.p1']!.flags['placedTP']).toBe(1);
    readyStep(ctx, state); // same turning point: the marker stays
    expect(state.markers['xv26.ambush.p1']).toBeDefined();
    state.turningPoint = 2;
    readyStep(ctx, state);
    expect(state.markers['xv26.ambush.p1']).toBeUndefined();
  });
});

// ===========================================================================
describe('BONDS OF UNITY (strategy ploy)', () => {
  const quote = () => ruleText(SP.bondsOfUnity);

  function bonded(): { ctx: GameContext; state: GameState; op: OperativeState } {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.bondsOfUnity);
    const op = place(state, opWith(state, 'p1', LIBERATOR), 8, 11);
    place(state, opWith(state, 'p1', LODESTAR), 11, 11);
    return { ctx, state, op };
  }

  it('"you can ignore any changes to that first friendly operative’s APL stat"', () => {
    expect(quote()).toContain('you can ignore any changes to that first friendly operative’s APL stat');
    const { ctx, state, op } = bonded();
    op.aplMods.push(-1);
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    expect(op.aplMods).toEqual([]);
    expect(statMods(ctx, state, op).apl).toBe(0);
  });

  it('"if it’s visible to and within 6\\" of another friendly … operative (excluding DRONE)"', () => {
    expect(quote()).toContain('visible to and within 6" of another friendly XV26 STEALTH BATTLESUIT operative');
    const { ctx, state, op } = bonded();
    place(state, opWith(state, 'p1', LODESTAR), 25, 11); // partner too far away
    isolate(state, [op.id, opWith(state, 'p1', LODESTAR)]);
    op.aplMods.push(-1);
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    expect(op.aplMods).toEqual([-1]);
  });

  it('"Ignore any changes to the Hit stat … from being injured until the end of that activation"', () => {
    expect(quote()).toContain('Ignore any changes to the Hit stat of that first friendly operative’s weapons');
    const { ctx, state, op } = bonded();
    op.wounds = 4; // injured: fewer than half of 12
    const profile = profileOf(LIBERATOR, 'Burst cannon', 'focused');
    expect(hitOf(ctx, state, op, profile)).toBe(5);
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    const decision = state.pending.find((p) => p.kind === BONDS_DECISION)!;
    expect(decision.options.map((o) => o.id)).toEqual(['hit', 'move']);
    const next = reduce(state, { t: 'ResolveDecision', decisionId: decision.id, optionId: 'hit' }, ctx).state;
    expect(hitOf(ctx, next, next.operatives[op.id]!, profile)).toBe(4);
  });

  it('"Ignore any changes to that first friendly operative’s Move stat from being injured"', () => {
    expect(quote()).toContain('Ignore any changes to that first friendly operative’s Move stat from being injured');
    const { ctx, state, op } = bonded();
    op.wounds = 4;
    expect(moveOf(ctx, state, op)).toBe(4);
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    const decision = state.pending.find((p) => p.kind === BONDS_DECISION)!;
    const next = reduce(state, { t: 'ResolveDecision', decisionId: decision.id, optionId: 'move' }, ctx).state;
    expect(moveOf(ctx, next, next.operatives[op.id]!)).toBe(6);
  });

  it('a DRONE is excluded and an uninjured operative raises no choice', () => {
    expect(quote()).toContain('is activated (excluding DRONE)');
    const { ctx, state } = bonded();
    const drone = place(state, opWith(state, 'p1', MV75_MARKER_DRONE), 9, 11);
    drone.aplMods.push(-1);
    ctx.hooks.emit('onActivationStart', state, { state, operative: drone });
    expect(drone.aplMods).toEqual([-1]);
    const healthy = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: healthy });
    expect(state.pending.filter((p) => p.kind === BONDS_DECISION)).toHaveLength(0);
  });
});

// ===========================================================================
describe('HOLOWAVE COUNTERMEASURES (strategy ploy)', () => {
  const quote = () => ruleText(SP.holowaveCountermeasures);

  function shotAt(distanceX: number, obscured = false) {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.holowaveCountermeasures);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 5, 11);
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 5 + distanceX, 11);
    isolate(state, [target.id, shooter.id]);
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Burst cannon',
      profileName: 'focused',
      step: 'retention',
      obscured,
    });
    state.sequence = seq;
    return { ctx, state, seq, shooter, target };
  }

  it('"the attacker must discard one of their unresolved normal successes" beyond 6"', () => {
    expect(quote()).toContain('the attacker must discard one of their unresolved normal successes');
    const { ctx, state, seq, shooter, target } = shotAt(9);
    seq.attack = pool([6, 4, 4, 2], 4);
    effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target,
      weaponName: 'Burst cannon',
    });
    expect(seq.attack.dice.filter((d) => d.state === 'discarded')).toHaveLength(1);
    expect(seq.attack.dice.find((d) => d.state === 'discarded')!.value).toBe(4);
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('"(or one of their critical successes if there are none)"', () => {
    expect(quote()).toContain('or one of their critical successes if there are none');
    const { ctx, state, seq, shooter, target } = shotAt(9);
    seq.attack = pool([6, 6, 2], 4);
    effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target,
      weaponName: 'Burst cannon',
    });
    expect(seq.attack.dice.filter((d) => d.state === 'discarded')).toHaveLength(1);
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('"This isn’t cumulative with being obscured."', () => {
    expect(quote()).toContain('This isn’t cumulative with being obscured.');
    const { ctx, state, seq, shooter, target } = shotAt(9, true);
    seq.attack = pool([6, 4, 4, 2], 4);
    effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target,
      weaponName: 'Burst cannon',
    });
    expect(seq.attack.dice.filter((d) => d.state === 'discarded')).toHaveLength(0);
  });

  it('"more than 6\\" from it" — a closer shot is untouched, and the discard happens once', () => {
    expect(quote()).toContain('more than 6" from it');
    const near = shotAt(4);
    near.seq.attack = pool([4, 4], 4);
    effectiveRules(near.ctx, near.state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: near.shooter,
      target: near.target,
      weaponName: 'Burst cannon',
    });
    expect(near.seq.attack.dice.filter((d) => d.state === 'discarded')).toHaveLength(0);

    const far = shotAt(9);
    far.seq.attack = pool([4, 4, 4], 4);
    for (let i = 0; i < 3; i++) {
      effectiveRules(far.ctx, far.state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
        operative: far.shooter,
        target: far.target,
        weaponName: 'Burst cannon',
      });
    }
    expect(far.seq.attack.dice.filter((d) => d.state === 'discarded')).toHaveLength(1);
  });
});

// ===========================================================================
describe('VECTORED RETRO-THRUSTERS (firefight ploy)', () => {
  const quote = () => ruleText(FP.vectoredRetroThrusters);

  it('"that friendly operative can immediately perform a free Fall Back action, but it cannot move more than 3\\""', () => {
    expect(quote()).toContain('a free Fall Back action, but it cannot move more than 3"');
    const { ctx, state } = setup();
    const friendly = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 12.6, 11);
    isolate(state, [friendly.id, enemy.id]);
    enemy.actionsThisActivation.push('Charge');
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP.vectoredRetroThrusters, kind: 'firefight' });
    // "can immediately perform a free Fall Back action": AP outside the APL budget (D-100), so
    // the LIBERATOR's printed APL 3 is untouched and only its activation's budget grows.
    expect(friendly.aplMods).toEqual([]);
    expect(aplOf(ctx, state, friendly)).toBe(3);
    expect(freeApOf(state, friendly)).toBe(1);
    expect(apBudgetOf(ctx, state, friendly)).toBe(4);
    const ev = ctx.hooks.emit('onMoveDistance', state, {
      state,
      operative: friendly,
      action: 'Fall Back',
      inches: moveOf(ctx, state, friendly),
    });
    expect(ev.inches).toBe(3);
  });

  it('"…using any remaining move distance it had from that first Charge action" (D-021 carve-out)', () => {
    expect(quote()).toContain('using any remaining move distance it had from that first Charge action');
    const { ctx, state } = setup();
    const friendly = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 12.6, 11);
    isolate(state, [friendly.id, enemy.id]);
    enemy.actionsThisActivation.push('Charge');
    // `applyMove` records the validated distance of every move on the log.
    state.log.push({
      seq: state.seq++,
      tp: 1,
      kind: 'action',
      player: 'p2',
      text: 'charge',
      data: { operativeId: enemy.id, action: 'Charge', inches: 5 },
    });
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP.vectoredRetroThrusters, kind: 'firefight' });
    // The charging enemy's own free Reposition is likewise AP outside the APL budget (D-100) —
    // it is mid-activation, so this is the AP it spends on the carve-out action right now.
    expect(enemy.aplMods).toEqual([]);
    expect(aplOf(ctx, state, enemy)).toBe(3);
    expect(freeApOf(state, enemy)).toBe(1);
    expect(apBudgetOf(ctx, state, enemy)).toBe(4);
    const ev = ctx.hooks.emit('onMoveDistance', state, {
      state,
      operative: enemy,
      action: THRUSTER_REPOSITION,
      inches: 6,
    });
    expect(ev.inches).toBe(3); // 6" Move + 2" Charge bonus - 5" already moved
    expect(getAction(THRUSTER_REPOSITION)!.treatedAs).toBeUndefined();
  });

  it('"when an enemy operative ends the Charge action" gates the ploy', () => {
    expect(quote()).toContain('when an enemy operative ends the Charge action');
    const { state } = setup();
    const usable = MODULE.ploys.find((p) => p.id === FP.vectoredRetroThrusters)!.usable!;
    const friendly = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 12.6, 11);
    isolate(state, [friendly.id, enemy.id]);
    expect(usable(state, 'p1').ok).toBe(false);
    enemy.actionsThisActivation.push('Charge');
    expect(usable(state, 'p1').ok).toBe(true);
    // "…within control range of a friendly XV26 STEALTH BATTLESUIT operative (excluding DRONE)"
    place(state, friendly.id, 25, 3);
    expect(usable(state, 'p1').ok).toBe(false);
  });
});

// ===========================================================================
describe('ENGAGE JET PACK (firefight ploy) — reminder only', () => {
  it('"you can ignore the vertical distance they move during one climb and one drop" has no seam', () => {
    expect(ruleText(FP.engageJetPack)).toContain(
      'you can ignore the vertical distance they move during one climb and one drop',
    );
    expect(REMINDER_ONLY[FP.engageJetPack]).toContain('onMoveRules');
    // The AI must never spend CP on a ploy the engine cannot apply.
    expect(MODULE.aiHints!.ployValue![FP.engageJetPack]).toBe(0);
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    state.activeOperativeId = op.id;
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: FP.engageJetPack,
      kind: 'firefight',
      data: { operativeId: op.id },
    });
    expect(state.effects.some((e) => e.rule === 'xv26.jetPack' && e.operativeId === op.id)).toBe(true);
  });
});

// ===========================================================================
describe('GHOSTSHROUD (firefight ploy)', () => {
  const quote = () => ruleText(FP.ghostshroud);

  it('"If that operative has an Engage order, change it to Conceal"', () => {
    expect(quote()).toContain('If that operative has an Engage order, change it to Conceal');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    op.order = 'engage';
    state.activeOperativeId = op.id;
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP.ghostshroud, kind: 'firefight' });
    expect(op.order).toBe('conceal');
  });

  it('"You cannot use this ploy for each friendly operative more than once per battle."', () => {
    expect(quote()).toContain('You cannot use this ploy for each friendly operative more than once per battle');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    state.activeOperativeId = op.id;
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP.ghostshroud, kind: 'firefight' });
    op.order = 'engage';
    // A second use must find another operative, not this one.
    const other = state.operatives[opWith(state, 'p1', LODESTAR)]!;
    other.order = 'engage';
    state.activeOperativeId = op.id;
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP.ghostshroud, kind: 'firefight' });
    expect(op.order).toBe('engage');
    expect(aliveOperatives(state, 'p1').filter((o) => o.order === 'conceal')).toHaveLength(1);
  });
});

// ===========================================================================
describe('SAVIOUR PROTOCOLS (firefight ploy)', () => {
  const quote = () => ruleText(FP.saviourProtocols);

  it('"Select one friendly DRONE operative visible to and within 3\\" … to become the valid target instead"', () => {
    expect(quote()).toContain('to become the valid target instead (even if it wouldn’t normally be valid for this)');
    // Word-for-word the Pathfinders' ploy bar the team keyword, so it reuses `onSelectTarget`.
    expect(quote().replace(/XV26 STEALTH BATTLESUIT /g, '')).toBe(
      teamData('pathfinders')
        .firefightPloys.find((p) => p.id === 'pathfinders.fp.saviour-protocols')!
        .text.replace(/PATHFINDER /g, ''),
    );
    const { ctx, state } = setup();
    state.teams.p1.ploysUsedTP.push(FP.saviourProtocols);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    const drone = place(state, opWith(state, 'p1', MV75_MARKER_DRONE), 13.5, 11);
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 20, 11);
    isolate(state, [target.id, drone.id, shooter.id]);
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'focused');
    const ev = ctx.hooks.emit('onSelectTarget', state, {
      state,
      attacker: shooter,
      target,
      weaponName: 'Burst cannon',
      profile,
      rules: profile.rules,
    });
    expect(ev.redirectTo).toBe(drone.id);
  });

  it('"This ploy has no effect if the ranged weapon has the Blast or Torrent weapon rule."', () => {
    expect(quote()).toContain('This ploy has no effect if the ranged weapon has the Blast or Torrent weapon rule');
    const { ctx, state } = setup();
    state.teams.p1.ploysUsedTP.push(FP.saviourProtocols);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    place(state, opWith(state, 'p1', MV75_MARKER_DRONE), 13.5, 11);
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 20, 11);
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'sweeping'); // Torrent 1"
    const ev = ctx.hooks.emit('onSelectTarget', state, {
      state,
      attacker: shooter,
      target,
      weaponName: 'Burst cannon',
      profile,
      rules: profile.rules,
    });
    expect(ev.redirectTo).toBeUndefined();
  });

  it('a DRONE is never the "first friendly operative" the ploy protects', () => {
    expect(quote()).toContain('friendly XV26 STEALTH BATTLESUIT operative (excluding DRONE) is selected');
    const { ctx, state } = setup();
    state.teams.p1.ploysUsedTP.push(FP.saviourProtocols);
    const target = place(state, opWith(state, 'p1', MV15_GUN_DRONE), 12, 11);
    place(state, opWith(state, 'p1', MV75_MARKER_DRONE), 13, 11);
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 20, 11);
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'focused');
    const ev = ctx.hooks.emit('onSelectTarget', state, {
      state,
      attacker: shooter,
      target,
      weaponName: 'Burst cannon',
      profile,
      rules: profile.rules,
    });
    expect(ev.redirectTo).toBeUndefined();
  });
});

// ===========================================================================
describe('XV26 MULTITRACKERS (faction equipment)', () => {
  const quote = () => ruleText(EQ.multitrackers);

  function sweeping(gap: number) {
    const { ctx, state } = setup({ equipment: [EQ.multitrackers] });
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 5, 11);
    const target = place(state, opWith(state, 'p2', SHAS_VRE), 15, 11);
    const other = place(state, opWith(state, 'p2', LIBERATOR), 15 + gap, 11);
    isolate(state, [shooter.id, target.id, other.id]);
    return { ctx, state, shooter, target };
  }

  it('"…you select a burst cannon (sweeping) … that weapon has the Torrent 2\\" weapon rule"', () => {
    expect(quote()).toContain('you select a burst cannon (sweeping)');
    expect(quote()).toContain('that weapon has the Torrent 2" weapon rule');
    const { ctx, state, shooter, target } = sweeping(2.8); // ~1.5" base gap: caught by 2" only
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'sweeping');
    const rules = effectiveRules(ctx, state, profile, { operative: shooter, target, weaponName: 'Burst cannon' });
    expect(rules.find((r) => r.id === 'Torrent')).toMatchObject({ x: 2 });
    expect(rules.filter((r) => r.id === 'Torrent')).toHaveLength(1);
  });

  it('the focused profile is untouched — the rule names the sweeping profile', () => {
    const { ctx, state, shooter, target } = sweeping(2.8);
    const rules = effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target,
      weaponName: 'Burst cannon',
    });
    expect(ruleIds(rules)).not.toContain('Torrent');
  });

  it('"Once per turning point" — the use is claimed when the dice are collected', () => {
    expect(quote()).toContain('Once per turning point');
    const { ctx, state, shooter, target } = sweeping(2.8);
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'sweeping');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Burst cannon'),
      count: profile.atk,
      mods: zeroStatMods(),
    });
    expect(state.effects.some((e) => e.rule === 'xv26.multitracker')).toBe(true);
    // A second operative in the same turning point gets nothing.
    const second = place(state, opWith(state, 'p1', LIBERATOR), 5, 13);
    const rules = effectiveRules(ctx, state, profile, { operative: second, target, weaponName: 'Burst cannon' });
    expect(rules.find((r) => r.id === 'Torrent')).toMatchObject({ x: 1 });
  });

  it('the use is not spent when Torrent 2" would catch nobody Torrent 1" misses (D-022 policy)', () => {
    const { ctx, state, shooter, target } = sweeping(8);
    const profile = profileOf(DESIGNATOR, 'Burst cannon', 'sweeping');
    const rules = effectiveRules(ctx, state, profile, { operative: shooter, target, weaponName: 'Burst cannon' });
    expect(rules.find((r) => r.id === 'Torrent')).toMatchObject({ x: 1 });
  });
});

// ===========================================================================
describe('ADVANCED BLACKSUN FILTERS (faction equipment)', () => {
  it('"you don’t have to discard one success … All other effects of obscured apply as normal."', () => {
    const quote = ruleText(EQ.blacksunFilters);
    expect(quote).toContain('you don’t have to discard one success as a result of that rule');
    expect(quote).toContain('All other effects of obscured apply as normal');
    const { ctx, state } = setup({ equipment: [EQ.blacksunFilters] });
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 5, 11);
    const target = place(state, opWith(state, 'p2', SHAS_VRE), 12, 11);
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Burst cannon',
      profileName: 'focused',
      step: 'obscuredDiscard',
      obscured: true,
    });
    seq.attack = pool([6, 4, 4, 1], 4);
    state.sequence = seq;
    effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target,
      weaponName: 'Burst cannon',
    });
    expect(seq.attack.dice.filter((d) => d.state === 'discarded')).toHaveLength(0);
    // "All other effects of obscured apply as normal": every crit is retained as a normal.
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(0);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(3);
    expect(seq.step).toBe('rollDefence');
  });

  it('without the equipment the core obscured discard runs untouched', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p1', DESIGNATOR), 5, 11);
    const target = place(state, opWith(state, 'p2', SHAS_VRE), 12, 11);
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Burst cannon',
      profileName: 'focused',
      step: 'obscuredDiscard',
      obscured: true,
    });
    seq.attack = pool([6, 4, 4, 1], 4);
    state.sequence = seq;
    effectiveRules(ctx, state, profileOf(DESIGNATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target,
      weaponName: 'Burst cannon',
    });
    expect(seq.step).toBe('obscuredDiscard');
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });
});

// ===========================================================================
describe('COUNTER-NETWORK JAMMERS (faction equipment)', () => {
  const quote = () => ruleText(EQ.counterNetworkJammers);

  it('"STRATEGIC GAMBIT. Select one objective marker or mission marker."', () => {
    expect(quote()).toContain('STRATEGIC GAMBIT. Select one objective marker or mission marker.');
    const { ctx, state } = setup({ equipment: [EQ.counterNetworkJammers] });
    state.teams.p1.cp = 3;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(JAMMERS_GAMBIT);
    const without = setup();
    expect(gambitOptions(without.ctx, without.state, 'p1').map((o) => o.id)).not.toContain(JAMMERS_GAMBIT);
  });

  it('"treat the total APL stat of enemy operatives that contest it as 1 lower if at least one … is within 3\\""', () => {
    expect(quote()).toContain('treat the total APL stat of enemy operatives that contest it as 1 lower');
    const { ctx, state } = setup({ equipment: [EQ.counterNetworkJammers] });
    const marker = state.markers['centre']!;
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 15, 11.4);
    const mine = place(state, opWith(state, 'p1', LIBERATOR), 15, 14);
    isolate(state, [enemy.id, mine.id]);
    expect(markerController(ctx, state, marker)).toBe('p2');
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: JAMMERS_GAMBIT,
      kind: 'strategy',
      data: { markerId: 'centre' },
    });
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 0, p2: 3 },
    });
    expect(ev.aplByPlayer.p2).toBe(2);
  });

  it('"…if at least one of those enemy operatives is within 3\\" of friendly XV26 … operatives"', () => {
    const { ctx, state } = setup({ equipment: [EQ.counterNetworkJammers] });
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 15, 11.4);
    isolate(state, [enemy.id]);
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: JAMMERS_GAMBIT,
      kind: 'strategy',
      data: { markerId: 'centre' },
    });
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 0, p2: 3 },
    });
    expect(ev.aplByPlayer.p2).toBe(3); // no friendly battlesuit within 3"
  });
});

// ===========================================================================
describe('HARDWIRED TARGET LOCKS (faction equipment)', () => {
  const quote = () => ruleText(EQ.hardwiredTargetLocks);

  function counteractSetup() {
    const { ctx, state } = setup({ equipment: [EQ.hardwiredTargetLocks] });
    const op = place(state, opWith(state, 'p1', LIBERATOR), 8, 11);
    op.order = 'conceal';
    op.expended = true;
    op.ready = false;
    isolate(state, [op.id]);
    return { ctx, state, op };
  }

  it('"you can do so with one friendly … operative that has a Conceal order and is more than 3\\" from enemies"', () => {
    expect(quote()).toContain('that has a Conceal order and is more than 3" from enemy operatives');
    const { ctx, state, op } = counteractSetup();
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).toContain(op.id);
    // Within 3" of an enemy the widening stops.
    place(state, opWith(state, 'p2', SHAS_VRE), 10, 11);
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(op.id);
  });

  it('without the equipment a Conceal-order battlesuit cannot counteract at all', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    op.order = 'conceal';
    op.expended = true;
    isolate(state, [op.id]);
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(op.id);
  });

  it('"it cannot perform any actions other than Shoot during that counteraction"', () => {
    expect(quote()).toContain('it cannot perform any actions other than Shoot during that counteraction');
    const { ctx, state, op } = counteractSetup();
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    state.activeOperativeId = op.id;
    const offered = availableActions(ctx, state, op);
    const reposition = offered.find((a) => a.def.id === 'Reposition')!;
    expect(reposition.ok).toBe(false);
    expect(reposition.reason).toContain('Hardwired Target Locks');
    expect(offered.find((a) => a.def.id === HARDWIRED_SHOOT)).toBeDefined();
  });

  it('"before it counteracts, you must change its order to Engage" (D-021 carve-out)', () => {
    expect(quote()).toContain('you must change its order to Engage');
    const { ctx, state, op } = counteractSetup();
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    state.activeOperativeId = op.id;
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 14, 11);
    const def = getAction(HARDWIRED_SHOOT)!;
    expect(def.treatedAs).toBe('Shoot');
    expect(def.available!(ctx, state, op)).toBe(true);
    const res = def.perform(ctx, state, op, {
      weaponName: 'Burst cannon',
      profileName: 'focused',
      targetId: enemy.id,
    });
    expect(res.ok).toBe(true);
    expect(op.order).toBe('engage');
  });
});

// ===========================================================================
describe("SHAS'VRE › XV26 Drone Controller", () => {
  const quote = () => abilityText(SHAS_VRE, AB.droneController);

  it('"STRATEGIC GAMBIT whenever this operative is in the killzone" is offered as its own gambit', () => {
    expect(quote()).toContain('STRATEGIC GAMBIT whenever this operative is in the killzone');
    const { ctx, state } = setup();
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(DRONE_CONTROLLER_GAMBIT);
    state.operatives[opWith(state, 'p1', SHAS_VRE)]!.removed = true;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(DRONE_CONTROLLER_GAMBIT);
  });

  it('"ignore the first two bullet points of its Drone rule (this takes precedence over that rule)"', () => {
    expect(quote()).toContain('ignore the first two bullet points of its Drone rule');
    const { ctx, state } = setup();
    const drone = state.operatives[opWith(state, 'p1', MV75_MARKER_DRONE)]!;
    let ev = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: drone,
      action: 'Pick Up Marker',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: DRONE_CONTROLLER_GAMBIT,
      kind: 'strategy',
      data: { operativeId: drone.id },
    });
    ev = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: drone,
      action: 'Pick Up Marker',
      allowed: true,
    });
    expect(ev.allowed).toBe(true);
  });
});

// ===========================================================================
describe('Markerlight (DESIGNATOR and MV75 MARKER DRONE)', () => {
  const quote = () => abilityText(DESIGNATOR, AB.markerlightDesignator);

  it('both datacards print the identical rule', () => {
    expect(abilityText(MV75_MARKER_DRONE, AB.markerlightDrone)).toBe(quote());
  });

  it('"Whenever an enemy operative is a valid target for this operative … it’s marked" → Severe', () => {
    expect(quote()).toContain('Whenever an enemy operative is a valid target for this operative');
    expect(quote()).toContain('that friendly operative’s ranged weapons have the Severe weapon rule');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const designator = place(state, opWith(state, 'p1', DESIGNATOR), 10, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 14, 11);
    const shooter = place(state, opWith(state, 'p1', LIBERATOR), 6, 4);
    isolate(state, [designator.id, enemy.id, shooter.id]);
    expect(isMarked(T, state, enemy)).toBe(true);
    const rules = effectiveRules(ctx, state, profileOf(LIBERATOR, 'Burst cannon', 'focused'), {
      operative: shooter,
      target: enemy,
      weaponName: 'Burst cannon',
    });
    expect(ruleIds(rules)).toContain('Severe');
  });

  it('with no MARKERLIGHT carrier in the killzone nothing is marked', () => {
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    state.operatives[opWith(state, 'p1', DESIGNATOR)]!.removed = true;
    state.operatives[opWith(state, 'p1', MV75_MARKER_DRONE)]!.removed = true;
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 14, 11);
    expect(isMarked(T, state, enemy)).toBe(false);
  });

  it('"or is visible to this operative and within 2\\" of your Ambush marker"', () => {
    expect(quote()).toContain('within 2" of your Ambush marker (see Prepare Ambush strategy ploy)');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    // The MV75 MARKER DRONE would mark the enemy on its own, so this test uses the DESIGNATOR.
    state.operatives[opWith(state, 'p1', MV75_MARKER_DRONE)]!.removed = true;
    // The DESIGNATOR is engaged, so the enemy is NOT a valid target for it…
    const designator = place(state, opWith(state, 'p1', DESIGNATOR), 6, 11);
    const blocker = place(state, opWith(state, 'p2', LIBERATOR), 6.7, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 26, 11);
    isolate(state, [designator.id, blocker.id, enemy.id]);
    state.teams.p1.gambitsUsedTP.push(SP.prepareAmbush);
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: SP.prepareAmbush,
      kind: 'strategy',
      data: { pos: { x: 13, y: 12 } },
    });
    expect(state.markers['xv26.ambush.p1']!.pos).toEqual({ x: 13, y: 12 });
    expect(isMarked(T, state, enemy)).toBe(false);
    // …until it steps within 2" of the Ambush marker.
    place(state, enemy.id, 13, 11);
    expect(isMarked(T, state, enemy)).toBe(true);
  });
});

// ===========================================================================
describe('INFILTRATOR › Covert Protocols', () => {
  const quote = () => abilityText(INFILTRATOR, AB.covertProtocols);

  it('"This operative can counteract regardless of its order" (docs/DECISIONS.md D-028)', () => {
    expect(quote()).toContain('This operative can counteract regardless of its order');
    const { ctx, state } = setup({ roles: [INFILTRATOR, LIBERATOR, LODESTAR, NEUTRALISER] });
    const op = state.operatives[opWith(state, 'p1', INFILTRATOR)]!;
    op.order = 'conceal';
    op.expended = true;
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).toContain(op.id);
  });

  it('"…it cannot perform any actions other than Pick Up Marker, Place Marker or mission actions"', () => {
    expect(quote()).toContain('it cannot perform any actions other than Pick Up Marker, Place Marker or mission actions');
    const { ctx, state } = setup({ roles: [INFILTRATOR, LIBERATOR, LODESTAR, NEUTRALISER] });
    const op = state.operatives[opWith(state, 'p1', INFILTRATOR)]!;
    op.order = 'conceal';
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    const refuse = (action: string) =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action, allowed: true }).allowed;
    expect(refuse('Shoot')).toBe(false);
    expect(refuse('Reposition')).toBe(false);
    expect(refuse('Pick Up Marker')).toBe(true);
    expect(refuse('Place Marker')).toBe(true);
  });

  it('with an Engage order the counteraction is unrestricted', () => {
    const { ctx, state } = setup({ roles: [INFILTRATOR, LIBERATOR, LODESTAR, NEUTRALISER] });
    const op = state.operatives[opWith(state, 'p1', INFILTRATOR)]!;
    op.order = 'engage';
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    expect(
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action: 'Shoot', allowed: true }).allowed,
    ).toBe(true);
  });
});

// ===========================================================================
describe('LIBERATOR › Grenadier', () => {
  const quote = () => abilityText(LIBERATOR, AB.grenadier);

  it('"This operative can use frag, krak, smoke and stun grenades"', () => {
    expect(quote()).toContain('This operative can use frag, krak, smoke and stun grenades');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: op });
    const granted = (op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(granted.map((w) => w.name).sort()).toEqual(['Frag grenade', 'Krak grenade']);
    for (const id of [GRENADIER_SMOKE, GRENADIER_STUN]) {
      const def = getAction(id)!;
      expect(def.available!(ctx, state, op)).toBe(true);
      expect(def.available!(ctx, state, state.operatives[opWith(state, 'p1', LODESTAR)]!)).toBe(false);
    }
  });

  it('"Whenever this operative is using a frag or krak grenade, improve the Hit stat of that weapon by 1"', () => {
    expect(quote()).toContain('improve the Hit stat of that weapon by 1');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    const enemy = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    state.sequence = shootSeq({
      attackerId: op.id,
      targetId: enemy.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Frag grenade',
    });
    expect(statMods(ctx, state, op).hit).toBe(1);
    state.sequence = shootSeq({
      attackerId: op.id,
      targetId: enemy.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Burst cannon',
    });
    expect(statMods(ctx, state, op).hit).toBe(0);
  });

  it('"Doing so doesn’t count towards any limited uses you have"', () => {
    expect(quote()).toContain('Doing so doesn’t count towards any limited uses you have');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', LIBERATOR)]!;
    const enemy = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    const profile = { type: 'ranged' as const, atk: 4, hit: 3, dmgN: 2, dmgC: 4, rules: [] };
    // The refund only bites when the kill team also selected the universal grenades.
    selectExplosiveGrenades(state, 'p1', 1, 1);
    state.teams.p1.equipmentUses['used:eq.explosiveGrenades:frag'] = 1;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(op, enemy, profile, 'Frag grenade'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(state.teams.p1.equipmentUses['used:eq.explosiveGrenades:frag']).toBe(0);
  });
});

// ===========================================================================
describe('LODESTAR › Electrochaff Launcher', () => {
  const quote = () => abilityText(LODESTAR, AB.electrochaffLauncher);

  function chaff() {
    const { ctx, state } = setup();
    const lodestar = place(state, opWith(state, 'p1', LODESTAR), 8, 11);
    const target = place(state, opWith(state, 'p1', LIBERATOR), 10, 11);
    const shooter = place(state, opWith(state, 'p2', DESIGNATOR), 20, 11);
    isolate(state, [lodestar.id, target.id, shooter.id]);
    return { ctx, state, lodestar, target, shooter };
  }

  it('"Once per turning point, when an enemy operative is performing the Shoot action …"', () => {
    expect(quote()).toContain('Once per turning point, when an enemy operative is performing the Shoot action');
    const { ctx, state, target, shooter } = chaff();
    const profile = profileOf(DESIGNATOR, 'Fusion blaster', 'long range');
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Fusion blaster'),
      allowed: true,
      dryRun: false,
    });
    expect(state.effects.some((e) => e.rule === 'xv26.electrochaff')).toBe(true);
  });

  it('a dry run never claims the turning point’s use (D-032)', () => {
    const { ctx, state, target, shooter } = chaff();
    const profile = profileOf(DESIGNATOR, 'Fusion blaster', 'long range');
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Fusion blaster'),
      allowed: true,
      dryRun: true,
    });
    expect(state.effects.some((e) => e.rule === 'xv26.electrochaff')).toBe(false);
  });

  it('"Ignore the Piercing weapon rule" and "That friendly operative is obscured"', () => {
    expect(quote()).toContain('Ignore the Piercing weapon rule');
    expect(quote()).toContain('That friendly operative is obscured');
    const { ctx, state, target, shooter } = chaff();
    const profile = profileOf(DESIGNATOR, 'Fusion blaster', 'long range'); // Piercing 1
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Fusion blaster'),
      allowed: true,
      dryRun: false,
    });
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Fusion blaster',
      profileName: 'long range',
      step: 'rollAttack',
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Fusion blaster'),
      count: profile.atk,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(true);
    const def = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: { ...attackCtx(shooter, target, profile, 'Fusion blaster'), rules: profile.rules },
      count: 2, // 3 - Piercing 1
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(def.count).toBe(3);
  });

  it('"providing this operative isn’t within control range of enemy operatives"', () => {
    expect(quote()).toContain('providing this operative isn’t within control range of enemy operatives');
    const { ctx, state, lodestar, target, shooter } = chaff();
    place(state, opWith(state, 'p2', LIBERATOR), lodestar.pos.x + 0.7, lodestar.pos.y);
    const profile = profileOf(DESIGNATOR, 'Fusion blaster', 'long range');
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Fusion blaster'),
      allowed: true,
      dryRun: false,
    });
    expect(state.effects.some((e) => e.rule === 'xv26.electrochaff')).toBe(false);
  });

  it('a DRONE target is excluded', () => {
    expect(quote()).toContain('your opponent selects a valid target (excluding DRONE)');
    const { ctx, state, shooter } = chaff();
    const drone = place(state, opWith(state, 'p1', MV15_GUN_DRONE), 10, 11);
    const profile = profileOf(DESIGNATOR, 'Fusion blaster', 'long range');
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(shooter, drone, profile, 'Fusion blaster'),
      allowed: true,
      dryRun: false,
    });
    expect(state.effects.some((e) => e.rule === 'xv26.electrochaff')).toBe(false);
  });
});

// ===========================================================================
describe('LODESTAR › Homing Beacon', () => {
  const quote = () => abilityText(LODESTAR, AB.homingBeacon);

  it('"This operative is carrying your Homing Beacon marker."', () => {
    expect(quote()).toContain('This operative is carrying your Homing Beacon marker');
    const { ctx, state } = setup();
    const lodestar = state.operatives[opWith(state, 'p1', LODESTAR)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: lodestar });
    const marker = state.markers['xv26.homingBeacon.p1']!;
    expect(marker.carriedBy).toBe(lodestar.id);
    expect(lodestar.carryingMarkerId).toBe(marker.id);
    expect(marker.flags['pickUpAllowed']).toBe(true);
  });

  it('"roll one D6 … two D6 … three D6" by where the marker stands', () => {
    expect(quote()).toContain('roll one D6 if it’s more than 6" from your drop zone');
    expect(quote()).toContain('roll two D6 instead if it’s within your opponent’s territory');
    expect(quote()).toContain('roll three D6 instead if it’s within 6" of your opponent’s drop zone');
    const { state } = setup();
    const marker = { id: 'm', kind: 'generic' as const, diameterMm: 20, pos: { x: 3, y: 11 }, z: 0, flags: {} };
    expect(beaconDice(state, 'p1', marker)).toBe(0); // inside p1's own drop zone
    expect(beaconDice(state, 'p1', { ...marker, pos: { x: 13, y: 11 } })).toBe(1);
    expect(beaconDice(state, 'p1', { ...marker, pos: { x: 17, y: 11 } })).toBe(2);
    expect(beaconDice(state, 'p1', { ...marker, pos: { x: 26, y: 11 } })).toBe(3);
  });

  it('"If any result is a 4+, you gain one additional CP."', () => {
    expect(quote()).toContain('If any result is a 4+, you gain one additional CP');
    const { ctx, state } = setup({ script: [5, 5, 5, 5, 5, 5] });
    const lodestar = state.operatives[opWith(state, 'p1', LODESTAR)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: lodestar });
    state.markers['xv26.homingBeacon.p1']!.pos = { x: 26, y: 11 };
    const ev = ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(ev.cp).toBe(2);
    expect(state.rolls.find((r) => r.kind === 'homingBeacon')!.results).toHaveLength(3);
  });

  it('"The first time an enemy operative performs the Pick Up Marker action … discard that marker"', () => {
    expect(quote()).toContain('discard that marker (remove it from the battle)');
    const { ctx, state } = setup();
    const lodestar = state.operatives[opWith(state, 'p1', LODESTAR)]!;
    ctx.hooks.emit('onActivationStart', state, { state, operative: lodestar });
    const marker = state.markers['xv26.homingBeacon.p1']!;
    const thief = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    lodestar.carryingMarkerId = undefined;
    marker.carriedBy = thief.id;
    thief.carryingMarkerId = marker.id;
    ctx.hooks.emit('onActivationEnd', state, { state, operative: thief });
    expect(state.markers['xv26.homingBeacon.p1']).toBeUndefined();
    expect(thief.carryingMarkerId).toBeUndefined();
    // "remove it from the battle" — it never comes back.
    ctx.hooks.emit('onActivationStart', state, { state, operative: lodestar });
    expect(state.markers['xv26.homingBeacon.p1']).toBeUndefined();
  });
});

// ===========================================================================
describe('NEUTRALISER › Multispectrum Sensor Package', () => {
  const quote = () => abilityText(NEUTRALISER, AB.multispectrum);

  it('"…each friendly … operative within 3\\" of this operative can immediately … Perform a free Dash action"', () => {
    expect(quote()).toContain('Perform a free Dash action');
    const { ctx, state } = setup();
    const sensor = place(state, opWith(state, 'p1', NEUTRALISER), 12, 11);
    const near = place(state, opWith(state, 'p1', LIBERATOR), 14, 11);
    const far = place(state, opWith(state, 'p1', LODESTAR), 2, 2);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 17, 11);
    isolate(state, [sensor.id, near.id, far.id, enemy.id]);
    ctx.hooks.emit('onActivationStart', state, { state, operative: enemy });
    // The free Dash is AP outside the APL budget (D-100): the APL stat of a LIBERATOR that is
    // within 3" stays at its printed 3, and only its AP budget goes up.
    expect(freeApOf(state, near)).toBe(1);
    expect(near.aplMods).toEqual([]);
    expect(aplOf(ctx, state, near)).toBe(3);
    expect(apBudgetOf(ctx, state, near)).toBe(4);
    expect(freeApOf(state, far)).toBe(0);
    const ev = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: near,
      action: 'Shoot',
      allowed: true,
    });
    near.apSpent = 3;
    const after = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: near,
      action: 'Shoot',
      allowed: true,
    });
    expect(ev.allowed).toBe(true);
    expect(after.allowed).toBe(false); // the bonus AP is restricted to the Dash action
  });

  it('"Once per turning point, when an enemy operative within 8\\" of this operative is activated"', () => {
    expect(quote()).toContain('Once per turning point, when an enemy operative within 8" of this operative is activated');
    const { ctx, state } = setup();
    const sensor = place(state, opWith(state, 'p1', NEUTRALISER), 12, 11);
    const near = place(state, opWith(state, 'p1', LIBERATOR), 14, 11);
    const far = place(state, opWith(state, 'p2', SHAS_VRE), 27, 11);
    isolate(state, [sensor.id, near.id, far.id]);
    ctx.hooks.emit('onActivationStart', state, { state, operative: far });
    expect(freeApOf(state, near)).toBe(0); // more than 8" away
    const close = place(state, opWith(state, 'p2', LIBERATOR), 17, 11);
    ctx.hooks.emit('onActivationStart', state, { state, operative: close });
    expect(freeApOf(state, near)).toBe(1);
    // "Once per turning point": a second enemy activation grants nothing, and free AP sums rather
    // than clamping (D-100), so a second grant would show up here as a second point.
    ctx.hooks.emit('onActivationStart', state, { state, operative: close });
    expect(freeApOf(state, near)).toBe(1);
  });

  it('"cannot end that move within 3\\" of an enemy operative" is reminder-only, exported for the UI', () => {
    expect(quote()).toContain('cannot end that move within 3" of an enemy operative');
    expect(REMINDER_ONLY[`${AB.multispectrum}.endOfMove`]).toContain('no hook constrains where a move ENDS');
    const { ctx, state } = setup();
    const T = hooksFor(ctx, 'p1');
    const mine = place(state, opWith(state, 'p1', LIBERATOR), 8, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 14, 11);
    isolate(state, [mine.id, enemy.id]);
    expect(multispectrumDashEndLegal(T, state, mine, { x: 8, y: 11 } as Vec2)).toBe(true);
    expect(multispectrumDashEndLegal(T, state, mine, { x: 12.5, y: 11 } as Vec2)).toBe(false);
  });
});

// ===========================================================================
describe('Drone (MV15 GUN DRONE and MV75 MARKER DRONE)', () => {
  const quote = () => abilityText(MV15_GUN_DRONE, AB.droneGun);

  it('"This operative cannot perform any actions other than …" — the printed list, per DRONE', () => {
    expect(quote()).toContain(
      'This operative cannot perform any actions other than Charge, Dash, Fall Back, Fight, Photon Grenade Launcher, Reposition and Shoot',
    );
    expect(abilityText(MV75_MARKER_DRONE, AB.droneMarker)).toContain(
      'This operative cannot perform any actions other than Charge, Dash, Fall Back, Fight, Reposition and Shoot',
    );
    const { ctx, state } = setup();
    const gun = state.operatives[opWith(state, 'p1', MV15_GUN_DRONE)]!;
    const marker = state.operatives[opWith(state, 'p1', MV75_MARKER_DRONE)]!;
    const allowed = (op: OperativeState, action: string) =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action, allowed: true }).allowed;
    expect(allowed(gun, 'Shoot')).toBe(true);
    expect(allowed(gun, ACT.photonGrenadeLauncher)).toBe(true);
    expect(allowed(gun, 'Pick Up Marker')).toBe(false);
    expect(allowed(marker, ACT.photonGrenadeLauncher)).toBe(false);
  });

  it('"Whenever determining control of an objective marker, treat this operative’s APL stat as 1 lower"', () => {
    expect(quote()).toContain('treat this operative’s APL stat as 1 lower');
    const { ctx, state } = setup();
    const drone = place(state, opWith(state, 'p1', MV15_GUN_DRONE), 15, 11.4);
    isolate(state, [drone.id]);
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: 'centre',
      aplByPlayer: { p1: 2, p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(1);
  });

  it('"This operative cannot use any weapons that aren’t on its datacard" (ranged half)', () => {
    expect(quote()).toContain('This operative cannot use any weapons that aren’t on its datacard');
    expect(REMINDER_ONLY[`${AB.droneGun}.meleeWeapons`]).toContain('grantedWeapons');
    const { ctx, state } = setup();
    const drone = state.operatives[opWith(state, 'p1', MV15_GUN_DRONE)]!;
    const enemy = state.operatives[opWith(state, 'p2', SHAS_VRE)]!;
    const profile = { type: 'ranged' as const, atk: 4, hit: 3, dmgN: 2, dmgC: 4, rules: [] };
    const off = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(drone, enemy, profile, 'Frag grenade'),
      allowed: true,
      dryRun: true,
    });
    expect(off.allowed).toBe(false);
    const on = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(drone, enemy, profileOf(MV15_GUN_DRONE, 'Twin pulse carbine'), 'Twin pulse carbine'),
      allowed: true,
      dryRun: true,
    });
    expect(on.allowed).toBe(true);
  });

  it('the head and kill-op bullets have no seam and are recorded as reminder-only', () => {
    expect(quote()).toContain('the round disc at the top of the miniature is its head');
    expect(quote()).toContain('This operative is ignored for your opponent’s kill/elimination op');
    expect(REMINDER_ONLY[`${AB.droneGun}.head`]).toContain('modelHeight');
    expect(REMINDER_ONLY[`${AB.droneGun}.ops`]).toContain('src/core/ops/**');
  });
});

// ===========================================================================
describe('unique actions', () => {
  it('FOCUSED MARKERLIGH: "Select one enemy operative visible to this operative" and the once-per-TP effect', () => {
    const printed = actionOf(DESIGNATOR, ACT.focusedMarkerligh);
    expect(printed.text).toContain('Select one enemy operative visible to this operative');
    expect(printed.text).toContain('improve the Hit stat of ranged weapons on that friendly operative’s datacard by 1');
    const { ctx, state } = setup();
    const designator = place(state, opWith(state, 'p1', DESIGNATOR), 8, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 16, 11);
    const shooter = place(state, opWith(state, 'p1', LIBERATOR), 6, 11);
    isolate(state, [designator.id, enemy.id, shooter.id]);
    const def = getAction(ACT.focusedMarkerligh)!;
    expect(def.check(ctx, state, designator, { targetOperativeId: enemy.id }).ok).toBe(true);
    expect(def.perform(ctx, state, designator, { targetOperativeId: enemy.id }).ok).toBe(true);
    const profile = profileOf(LIBERATOR, 'Burst cannon', 'focused');
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: enemy.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Burst cannon',
      profileName: 'focused',
    });
    expect(statMods(ctx, state, shooter).hit).toBe(0);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, enemy, profile, 'Burst cannon'),
      count: profile.atk,
      mods: zeroStatMods(),
    });
    expect(statMods(ctx, state, shooter).hit).toBe(1);
  });

  it('FOCUSED MARKERLIGH: "cannot perform this action while within control range of an enemy operative"', () => {
    const printed = actionOf(DESIGNATOR, ACT.focusedMarkerligh);
    expect(printed.text).toContain('cannot perform this action while within control range of an enemy operative');
    const { ctx, state } = setup();
    const designator = place(state, opWith(state, 'p1', DESIGNATOR), 8, 11);
    place(state, opWith(state, 'p2', SHAS_VRE), 8.7, 11);
    const def = getAction(ACT.focusedMarkerligh)!;
    expect(def.check(ctx, state, designator, {}).ok).toBe(false);
  });

  it('SYSTEM JAM: "subtract 1 from its APL stat" and the Conceal-order AP surcharge', () => {
    const printed = actionOf(NEUTRALISER, ACT.systemJam);
    expect(printed.text).toContain('Until the end of that operative’s next activation, subtract 1 from its APL stat');
    expect(printed.text).toContain('you must spend 1 additional AP to perform this action');
    const { ctx, state } = setup();
    const jammer = place(state, opWith(state, 'p1', NEUTRALISER), 8, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 16, 11);
    isolate(state, [jammer.id, enemy.id]);
    const def = getAction(ACT.systemJam)!;
    expect(def.ap).toBe(2);
    jammer.order = 'engage';
    expect(actionCost(ctx, state, jammer, def)).toBe(2);
    jammer.order = 'conceal';
    expect(actionCost(ctx, state, jammer, def)).toBe(3);
    expect(def.check(ctx, state, jammer, { targetOperativeId: enemy.id }).ok).toBe(true);
    def.perform(ctx, state, jammer, { targetOperativeId: enemy.id });
    expect(enemy.aplMods).toEqual([-1]);
  });

  it('PHOTON GRENADE LAUNCHER: "on a 3+ … subtract 2\\" from its Move stat"', () => {
    const printed = actionOf(MV15_GUN_DRONE, ACT.photonGrenadeLauncher);
    expect(printed.text).toContain('roll one D6: on a 3+');
    expect(printed.text).toContain('subtract 2" from its Move stat');
    const { ctx, state } = setup({ script: [4] });
    const drone = place(state, opWith(state, 'p1', MV15_GUN_DRONE), 8, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 16, 11);
    isolate(state, [drone.id, enemy.id]);
    const def = getAction(ACT.photonGrenadeLauncher)!;
    expect(def.available!(ctx, state, drone)).toBe(true);
    expect(moveOf(ctx, state, enemy)).toBe(6);
    expect(def.perform(ctx, state, drone, { targetOperativeId: enemy.id }).ok).toBe(true);
    expect(moveOf(ctx, state, enemy)).toBe(4);
  });

  it('PHOTON GRENADE LAUNCHER: a failed roll changes nothing', () => {
    const { ctx, state } = setup({ script: [2] });
    const drone = place(state, opWith(state, 'p1', MV15_GUN_DRONE), 8, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 16, 11);
    isolate(state, [drone.id, enemy.id]);
    getAction(ACT.photonGrenadeLauncher)!.perform(ctx, state, drone, { targetOperativeId: enemy.id });
    expect(moveOf(ctx, state, enemy)).toBe(6);
  });
});

// ===========================================================================
describe('AI hints and the reminder-only ledger', () => {
  it('every datacard has a role, every ploy a value and every equipment option a value', () => {
    const hints = MODULE.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual(MODULE.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
  });

  it('the reminder-only ledger names exactly the clauses no hook can express', () => {
    expect(Object.keys(REMINDER_ONLY).sort()).toEqual(
      [
        FP.engageJetPack,
        `${FP.vectoredRetroThrusters}.enemyReposition`,
        `${AB.multispectrum}.changeOrder`,
        `${AB.multispectrum}.endOfMove`,
        `${AB.droneGun}.head`,
        `${AB.droneGun}.ops`,
        `${AB.droneGun}.meleeWeapons`,
        `${AB.homingBeacon}.droneExclusion`,
      ].sort(),
    );
  });

  it('the team registers no handler on a hook that is declared but never emitted', () => {
    const { ctx } = setup();
    for (const hook of ['onBattleSetup', 'onAttackDiceRetained', 'onFreeActions', 'onOrderChange', 'onMoveRules', 'onSetUpAgain'] as const) {
      expect(ctx.hooks.has(hook)).toBe(false);
    }
  });
});

// ===========================================================================
describe('an XV26 kill team plays through the reducer', () => {
  it('activates, shoots and ends the activation with no rejected intents', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p1', LIBERATOR), 12, 11);
    const enemy = place(state, opWith(state, 'p2', SHAS_VRE), 16, 11);
    isolate(state, [shooter.id, enemy.id]);
    let s = activate(ctx, state, shooter.id, 'engage');
    const out = act(ctx, s, shooter.id, 'Shoot', {
      weaponName: 'Burst cannon',
      profileName: 'focused',
      targetId: enemy.id,
    });
    s = out.state;
    let guard = 0;
    while (s.pending.length > 0 && guard++ < 40) {
      const d = s.pending[0]!;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: d.options[d.options.length - 1]!.id }, ctx)
        .state;
    }
    s = reduce(s, { t: 'EndActivation', operativeId: shooter.id }, ctx).state;
    expect(out.ok).toBe(true);
    expect(s.rejected).toEqual([]);
  });
});
