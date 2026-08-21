/**
 * VESPID STINGWINGS. Every test quotes the printed rule it pins, read out of
 * `data/teams/vespid-stingwings.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/vespid-stingwings/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import {
  aliveOperatives,
  hitOf,
  inflictDamage,
  markerController,
  moveOf,
  statMods,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/vespid-stingwings.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB_CAMOUFLAGED,
  AB_COMMUNE,
  AB_EVASIVE_DRONE,
  AB_GHOST_RIG,
  AB_NEUTRON_BOMBARDMENT,
  AB_NEUTRON_FALLOUT,
  AB_NEUTRON_FRAGMENT,
  AB_SKYTORCH,
  AB_WARRIOR_INSTINCTS,
  ACT_AERIAL_GUIDANCE,
  ACT_SKYTORCH_ASSAULT,
  EQ_ACCELERANT,
  EQ_AGGRESSION,
  EQ_CONVERGENCE,
  EQ_NEUROSTIMULANT,
  FLY_CHARGE,
  FLY_DASH,
  FLY_FALL_BACK,
  FLY_REPOSITION,
  FP_DARTING_FLIGHT,
  FP_NEUTRON_OVERLOAD,
  FP_OCELLI,
  FP_VICIOUS_VENOM,
  LONGSTING,
  OVERSIGHT_DRONE,
  REMINDER_ONLY,
  RULE_COMMUNION,
  RULE_FLY,
  RULE_NEUTRON_CHARGE,
  SHADESTRAIN,
  SKYBLAST,
  SP_AERIAL_AGILITY,
  SP_AIRBORNE_PREDATORS,
  SP_HARDENED,
  SP_STING,
  STRAIN_LEADER,
  SWARMGUARD,
  TORCH_ZONE,
  WARRIOR,
  addFragment,
  availableCommunion,
  communionPoints,
  communionTarget,
  falloutMarkers,
  fragmentTokens,
  isNeutronWeapon,
  setCommunePloy,
  setCommunionPoints,
  skytorchDestination,
  torchZoneVictims,
  vespidStingwings,
} from '../../src/teams/vespid-stingwings/index.ts';
import { act, activate, battle, opWith, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap, vantagePlatform } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('vespid-stingwings');
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
  script?: number[];
  seed?: number;
  map?: ReturnType<typeof testMap>;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([vespidStingwings], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  if (opts.map) ctx.maps.set(opts.map.id, opts.map);
  const picks = defaultRoster(DATA);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: vespidStingwings, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: vespidStingwings, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number, z = 0): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = z;
  return op;
};

/** Move everything else far away so a distance rule is tested in isolation. */
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
    step: 'rollDefence',
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
  over: Partial<AttackContext> = {},
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('VESPID STINGWINGS data (pinned against data/teams/vespid-stingwings.json)', () => {
  it('has 7 datacards, all APL 2 VESPID STINGWING / T’AU EMPIRE', () => {
    expect(DATA.datacards).toHaveLength(7);
    for (const c of DATA.datacards) {
      expect(c.apl).toBe(2);
      expect(c.keywords).toContain('VESPID STINGWING');
      expect(c.keywords).toContain('T’AU EMPIRE');
    }
    // Six 28mm Vespids at M6"; the drone is a 25mm M8" Save 2+ with 5 wounds.
    for (const c of DATA.datacards.filter((x) => x.id !== OVERSIGHT_DRONE))
      expect(c).toMatchObject({ base: { shape: 'round', mm: 28 }, move: 6 });
    expect(DATA.datacards.find((c) => c.id === OVERSIGHT_DRONE)).toMatchObject({
      base: { shape: 'round', mm: 25 },
      move: 8,
      save: 2,
      wounds: 5,
    });
    expect(DATA.datacards.find((c) => c.id === STRAIN_LEADER)).toMatchObject({ wounds: 10, save: 5 });
    expect(DATA.datacards.find((c) => c.id === SHADESTRAIN)).toMatchObject({ wounds: 9, save: 3 });
  });

  it('exposes 3 faction rules, 4+4 ploys, 4 equipment options, 10 abilities and 2 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Communion', 'Neutron Charge', 'Fly']);
    expect(vespidStingwings.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(vespidStingwings.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(vespidStingwings.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(10);
    const acts = DATA.datacards.flatMap((c) => c.uniqueActions);
    expect(acts.map((a) => a.id)).toEqual([ACT_AERIAL_GUIDANCE, ACT_SKYTORCH_ASSAULT]);
    // Both unique actions print an AP cost, so the 0AP scraper gap does not bite this team.
    expect(acts.map((a) => a.ap)).toEqual([1, 2]);
    expect(NOTES).toEqual([]);
  });

  it('no ploy or equipment id carries a glued-on "1CP", and every ploy costs 1CP', () => {
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) {
      expect(p.cp).toBe(1);
      expect(p.id).not.toMatch(/1cp$/i);
      expect(p.name).not.toMatch(/1CP$/);
    }
  });

  it('pins every weapon profile the rules read', () => {
    expect(profileOf(STRAIN_LEADER, 'Neutron blaster')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 3 });
    expect(profileOf(WARRIOR, 'Neutron blaster')).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 3 });
    expect(profileOf(WARRIOR, 'Neutron blaster').rules.map((r) => r.raw)).toEqual(['Devastating 2']);
    expect(profileOf(OVERSIGHT_DRONE, 'Ram')).toMatchObject({ atk: 3, hit: 5, dmgN: 1, dmgC: 2 });
    expect(profileOf(SHADESTRAIN, 'Neutron sting').rules.map((r) => r.raw)).toEqual(['Range 8"', 'Devastating 2']);
    expect(profileOf(SHADESTRAIN, 'Neutron grenade').rules.map((r) => r.raw)).toEqual([
      'Range 6"',
      'Blast 2"',
      'Devastating 2',
      'Limited 1',
      'Saturate',
    ]);
    expect(profileOf(SKYBLAST, 'Neutron grenade launcher')).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 3 });
    // Claws are identical on all six Vespids — the weapon STING improves.
    for (const c of DATA.datacards.filter((x) => x.id !== OVERSIGHT_DRONE))
      expect(profileOf(c.id, 'Claws')).toMatchObject({ type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4 });
  });

  /**
   * docs/TEAM-DATA.md § 7: the old `public/legacy/factions.js` carried these weapons WITHOUT their
   * rare rules ("neutron fragment" on both rail-rifle profiles, "skytorch" on the flamer). The new
   * data restores them, which is what makes Neutron Fragment and Skytorch reachable at all.
   */
  it('the Longsting’s two rail-rifle profiles and the Swarmguard’s flamer carry the rare rules the old app lost', () => {
    const rifle = DATA.datacards.find((c) => c.id === LONGSTING)!.weapons.find((w) => w.name === 'Neutron rail rifle')!;
    expect(rifle.profiles.map((p) => p.name)).toEqual(['standard', 'aimed']);
    expect(profileOf(LONGSTING, 'Neutron rail rifle', 'standard')).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 4 });
    expect(profileOf(LONGSTING, 'Neutron rail rifle', 'standard').rules.map((r) => r.raw)).toEqual([
      'Devastating 2',
      'Neutron Fragment*',
    ]);
    expect(profileOf(LONGSTING, 'Neutron rail rifle', 'aimed')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 4 });
    expect(profileOf(LONGSTING, 'Neutron rail rifle', 'aimed').rules.map((r) => r.raw)).toEqual([
      'Devastating 2',
      'Heavy (Dash only)',
      'Lethal 5+',
      'Neutron Fragment*',
    ]);
    const flamer = DATA.datacards.find((c) => c.id === SWARMGUARD)!.weapons.find((w) => w.name === 'Flamer')!;
    expect(flamer.profiles.map((p) => p.name)).toEqual(['standard', 'skytorch']);
    expect(profileOf(SWARMGUARD, 'Flamer', 'standard').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Saturate',
      'Torrent 2"',
    ]);
    expect(profileOf(SWARMGUARD, 'Flamer', 'skytorch').rules.map((r) => r.raw)).toEqual([
      'Saturate',
      'Torrent 0"',
      'Skytorch*',
    ]);
  });

  it('the three rare weapon rules resolve to this team’s own datacard abilities (D-033)', () => {
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['NeutronBombardment', 'NeutronFragment', 'Skytorch']);
    expect(rareWeaponRuleText('NeutronFragment', 'vespid-stingwings')).toBe(
      abilityText(LONGSTING, AB_NEUTRON_FRAGMENT),
    );
    expect(rareWeaponRuleText('NeutronBombardment', 'vespid-stingwings')).toBe(
      abilityText(SKYBLAST, AB_NEUTRON_BOMBARDMENT),
    );
    expect(rareWeaponRuleText('Skytorch', 'vespid-stingwings')).toBe(abilityText(SWARMGUARD, AB_SKYTORCH));
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(ruleText(SP_STING).endsWith('the Lethal 5+ and Shock weapon rules.')).toBe(true);
    // The raw committed bytes still carry the overrun — that is the data problem, not the module.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect((rawJson as { firefightPloys: { text: string }[] }).firefightPloys[3]!.text).toContain('Faction Equipment');
  });

  it('the printed marker guide names every token the module owns', () => {
    for (const token of ['Neutron Fragment token', 'Neutron Fallout marker', 'Skytorch marker', 'Communion point token'])
      expect(DATA.markerGuide).toContain(token);
  });
});

// ---------------------------------------------------------------------------
describe('VESPID STINGWINGS selection', () => {
  it('prints one constraint — "Other than WARRIOR operatives … only include each operative once"', () => {
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['WARRIOR'] }]);
    expect(DATA.selection.rawText).toContain(
      'Other than WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
    expect(DATA.selection.totalOperatives).toBe(11);
  });

  it('defaultRoster is a legal 11-operative kill team that fields ALL SEVEN datacards', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(11);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(new Set(picks.map((p) => p.datacardId))).toEqual(new Set(DATA.datacards.map((c) => c.id)));
    expect(picks.filter((p) => p.datacardId === WARRIOR)).toHaveLength(5);
  });

  it('the shared validator enforces uniqueExcept: a second LONGSTING is illegal, a second WARRIOR is not', () => {
    const base = defaultRoster(DATA);
    const longsting = base.find((p) => p.datacardId === LONGSTING)!;
    const twoLongstings = base.map((p, i) => (p.datacardId === WARRIOR && i === base.length - 1 ? longsting : p));
    expect(validateRosterFor(DATA, twoLongstings).ok).toBe(false);
    expect(validateRosterFor(DATA, base).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Communion (faction rule)', () => {
  it('"you gain D3 Communion points, plus 1 if a friendly OVERSIGHT DRONE operative is in the killzone"', () => {
    expect(ruleText(RULE_COMMUNION)).toContain(
      'In the Ready step of each Strategy phase, you gain D3 Communion points, plus 1 if a friendly OVERSIGHT DRONE operative is in the killzone',
    );
    // ScriptedRng feeds the D3s: a 5 halves to 3.
    const { ctx, state } = setup({ script: [5, 5] });
    readyStep(ctx, state);
    expect(communionPoints(state, 'p1')).toBe(4); // D3 3 + 1 for the drone
  });

  it('the +1 needs a live OVERSIGHT DRONE', () => {
    const { ctx, state } = setup({ script: [5, 5] });
    for (const p of ['p1', 'p2'] as PlayerId[]) state.operatives[opWith(state, p, OVERSIGHT_DRONE)]!.removed = true;
    readyStep(ctx, state);
    expect(communionPoints(state, 'p1')).toBe(3);
  });

  it('NEUROSTIMULANT: "you can roll two D3 and select one D3 to use"', () => {
    expect(ruleText(EQ_NEUROSTIMULANT)).toContain('you can roll two D3 and select one D3 to use');
    // p1 has the equipment and rolls 1 then 5 (D3 1, then D3 3): the higher is taken.
    const { ctx, state } = setup({ equipment: [EQ_NEUROSTIMULANT], script: [1, 5, 1, 1] });
    readyStep(ctx, state);
    expect(communionPoints(state, 'p1')).toBe(4); // max(1, 3) + 1 drone
    expect(communionPoints(state, 'p2')).toBe(2); // one D3 only: 1 + 1 drone
  });

  it('"it can only target the closest enemy operative within 8" of it … unless you spend 1"', () => {
    expect(ruleText(RULE_COMMUNION)).toContain(
      'it can only target the closest enemy operative within 8" of it (excluding enemy operatives within control range of other friendly VESPID STINGWING operatives) unless you spend 1 of your Communion points',
    );
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const near = opWith(state, 'p2', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [shooter, near, far]);
    place(state, shooter, 10, 11);
    place(state, near, 14, 11);
    place(state, far, 16, 11);
    const T = hooksFor(ctx, 'p1');
    expect(communionTarget(T, state, state.operatives[shooter]!)!.id).toBe(near);

    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, shooter);
    const refused = act(ctx, s, shooter, 'Shoot', { weaponName: 'Neutron blaster', targetId: far });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('Communion');
    // The closest one is always legal without spending.
    const allowed = act(ctx, s, shooter, 'Shoot', { weaponName: 'Neutron blaster', targetId: near });
    expect(allowed.ok).toBe(true);
    expect(communionPoints(allowed.state, 'p1')).toBe(0);
  });

  it('spending 1 Communion point unlocks the further target, and the dry-run check never spends', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const near = opWith(state, 'p2', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [shooter, near, far]);
    place(state, shooter, 10, 11);
    place(state, near, 14, 11);
    place(state, far, 16, 11);
    setCommunionPoints(state, 'p1', 2);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, shooter);
    // `availableActions` runs the Shoot check (and the dry-run emit) many times; nothing is spent.
    availableActions(ctx, s, s.operatives[shooter]!);
    expect(communionPoints(s, 'p1')).toBe(2);
    const out = act(ctx, s, shooter, 'Shoot', { weaponName: 'Neutron blaster', targetId: far });
    expect(out.ok).toBe(true);
    expect(communionPoints(out.state, 'p1')).toBe(1);
  });

  it('"excluding enemy operatives within control range of other friendly VESPID STINGWING operatives"', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const friend = opWith(state, 'p1', SKYBLAST);
    const near = opWith(state, 'p2', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [shooter, friend, near, far]);
    place(state, shooter, 10, 11);
    place(state, near, 13, 11);
    place(state, friend, 14.5, 11); // within control range of the near enemy
    place(state, far, 17.5, 11);
    const T = hooksFor(ctx, 'p1');
    expect(communionTarget(T, state, state.operatives[shooter]!)!.id).toBe(far);
  });

  it('with no enemy operative within 8" the rule places no restriction at all', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [shooter, far]);
    place(state, shooter, 4, 11);
    place(state, far, 20, 11);
    const T = hooksFor(ctx, 'p1');
    expect(communionTarget(T, state, state.operatives[shooter]!)).toBeUndefined();
  });

  it('"you must also spend 1 of your Communion points" to Pick Up Marker, and it is settled at the end of the activation', () => {
    expect(ruleText(RULE_COMMUNION)).toContain(
      'Whenever you would perform the Pick Up Marker or a mission action (excluding Operate Hatch) with a friendly VESPID STINGWING operative, you must also spend 1 of your Communion points to do so.',
    );
    const { ctx, state } = setup();
    const carrier = opWith(state, 'p1', WARRIOR);
    isolate(state, [carrier]);
    place(state, carrier, 15, 11);
    state.markers['loot'] = {
      id: 'loot',
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 15, y: 11 },
      z: 0,
      flags: { pickUpAllowed: true },
    };
    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, carrier);
    const refused = act(ctx, s, carrier, 'Pick Up Marker', { markerId: 'loot' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('Communion');

    setCommunionPoints(s, 'p1', 1);
    const done = act(ctx, s, carrier, 'Pick Up Marker', { markerId: 'loot' });
    expect(done.ok).toBe(true);
    // The pledge is visible immediately even though the pool is settled at the activation boundary.
    expect(availableCommunion(done.state, 'p1')).toBe(0);
    const ended = reduce(done.state, { t: 'EndActivation', operativeId: carrier }, ctx).state;
    expect(communionPoints(ended, 'p1')).toBe(0);
  });

  it('CONVERGENCE STIMULANT pays for the first such action each turning point', () => {
    expect(ruleText(EQ_CONVERGENCE)).toContain(
      'Once per turning point, a friendly VESPID STINGWING operative can perform the Pick Up Marker or a mission action without you spending a Communion point',
    );
    const { ctx, state } = setup({ equipment: [EQ_CONVERGENCE] });
    const carrier = opWith(state, 'p1', WARRIOR);
    isolate(state, [carrier]);
    place(state, carrier, 15, 11);
    state.markers['loot'] = {
      id: 'loot',
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 15, y: 11 },
      z: 0,
      flags: { pickUpAllowed: true },
    };
    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, carrier);
    const done = act(ctx, s, carrier, 'Pick Up Marker', { markerId: 'loot' });
    expect(done.ok).toBe(true); // free, even with an empty pool
    const ended = reduce(done.state, { t: 'EndActivation', operativeId: carrier }, ctx).state;
    expect(communionPoints(ended, 'p1')).toBe(0);
  });

  it('Communion Helm: "Once during each of this operative’s activations, you can spend 1 Communion point for free"', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1, 1, 1] });
    const leader = opWith(state, 'p1', STRAIN_LEADER);
    const near = opWith(state, 'p2', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [leader, near, far]);
    place(state, leader, 10, 11);
    place(state, near, 13, 11);
    place(state, far, 16, 11);
    setCommunionPoints(state, 'p1', 1);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, leader);
    const out = act(ctx, s, leader, 'Shoot', { weaponName: 'Neutron blaster', targetId: far });
    expect(out.ok).toBe(true);
    expect(communionPoints(out.state, 'p1')).toBe(1); // the helm paid for it
  });

  it('the Communion Helm lets the STRAIN LEADER spend with an EMPTY pool', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1, 1, 1] });
    const leader = opWith(state, 'p1', STRAIN_LEADER);
    const near = opWith(state, 'p2', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [leader, near, far]);
    place(state, leader, 10, 11);
    place(state, near, 13, 11);
    place(state, far, 16, 11);
    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    const s = activate(ctx, state, leader);
    const out = act(ctx, s, leader, 'Shoot', { weaponName: 'Neutron blaster', targetId: far });
    expect(out.ok).toBe(true);
    expect(out.state.log.some((l) => l.text.includes('Communion Helm'))).toBe(true);
    // …and only once per activation: a WARRIOR gets no such licence.
    const warrior = opWith(state, 'p1', WARRIOR);
    place(out.state, warrior, 10, 11);
    let s2 = reduce(out.state, { t: 'EndActivation', operativeId: leader }, ctx).state;
    s2.activePlayer = 'p1';
    s2 = activate(ctx, s2, warrior);
    expect(act(ctx, s2, warrior, 'Shoot', { weaponName: 'Neutron blaster', targetId: far }).ok).toBe(false);
  });

  it('"you can spend 1 (and only 1) of your Communion points to re-roll one of your attack dice"', () => {
    expect(ruleText(RULE_COMMUNION)).toContain(
      'you can spend 1 (and only 1) of your Communion points to re-roll one of your attack dice',
    );
    // Attack dice 1,1,2,5 → the lowest fail is re-rolled into a 6.
    const { ctx, state } = setup({ script: [1, 1, 2, 5, 6, 6, 6, 6, 6, 6] });
    const shooter = opWith(state, 'p1', SKYBLAST);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [shooter, foe]);
    place(state, shooter, 12, 11);
    place(state, foe, 16, 11);
    setCommunionPoints(state, 'p1', 1);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, shooter);
    const out = act(ctx, s, shooter, 'Shoot', { weaponName: 'Neutron grenade launcher', targetId: foe });
    expect(out.ok).toBe(true);
    expect(communionPoints(out.state, 'p1')).toBe(0);
    // "1 (and only 1)": the window is re-opened for every re-roll grant, and only one point goes.
    expect(out.state.rolls.filter((r) => r.note === 'Communion')).toHaveLength(1);
  });

  it('CONVERGENCE STIMULANT is once per turning point — the second tolled action costs a point', () => {
    const { ctx, state } = setup({ equipment: [EQ_CONVERGENCE] });
    const first = opWith(state, 'p1', WARRIOR);
    const second = state.teams.p1.operativeIds.filter((id) => state.operatives[id]!.datacardId === WARRIOR)[1]!;
    isolate(state, [first, second]);
    place(state, first, 15, 11);
    place(state, second, 20, 11);
    for (const [id, n] of [[first, 'a'], [second, 'b']] as const) {
      state.markers[`loot${n}`] = {
        id: `loot${n}`,
        kind: 'generic',
        diameterMm: 20,
        pos: { ...state.operatives[id]!.pos },
        z: 0,
        flags: { pickUpAllowed: true },
      };
    }
    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, first);
    s = act(ctx, s, first, 'Pick Up Marker', { markerId: 'loota' }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: first }, ctx).state;
    s.activePlayer = 'p1';
    s = activate(ctx, s, second);
    const refused = act(ctx, s, second, 'Pick Up Marker', { markerId: 'lootb' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('Communion');
  });
});

// ---------------------------------------------------------------------------
describe('Neutron Charge (faction rule)', () => {
  it('"Neutron weapons are any weapons that have the word ‘neutron’ in their name"', () => {
    expect(ruleText(RULE_NEUTRON_CHARGE)).toContain(
      'Neutron weapons are any weapons that have the word ‘neutron’ in their name',
    );
    expect(isNeutronWeapon('Neutron blaster')).toBe(true);
    expect(isNeutronWeapon('Neutron grenade launcher')).toBe(true);
    expect(isNeutronWeapon('Flamer')).toBe(false);
    expect(isNeutronWeapon('Claws')).toBe(false);
  });

  it('"…moves or uses FLY, its neutron weapons have the Piercing 1 weapon rule until the end of the turning point"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const profile = profileOf(WARRIOR, 'Neutron blaster');
    const before = effectiveRules(ctx, state, profile, { operative: shooter, weaponName: 'Neutron blaster' });
    expect(before.some((r) => r.id === 'Piercing')).toBe(false);

    state.activeOperativeId = shooter.id;
    shooter.actionsThisActivation.push('Reposition');
    const after = effectiveRules(ctx, state, profile, { operative: shooter, weaponName: 'Neutron blaster' });
    expect(after.find((r) => r.id === 'Piercing')).toMatchObject({ x: 1 });
    // Claws are not a neutron weapon.
    const claws = effectiveRules(ctx, state, profileOf(WARRIOR, 'Claws'), {
      operative: shooter,
      weaponName: 'Claws',
    });
    expect(claws.some((r) => r.id === 'Piercing')).toBe(false);
  });

  it('the charge outlives the activation it happened in (end of the turning point)', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    isolate(state, [op]);
    place(state, op, 8, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    s = act(ctx, s, op, 'Reposition', { path: { points: [{ x: 10, y: 11 }] } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: op }, ctx).state;
    const shooter = s.operatives[op]!;
    expect(s.activeOperativeId).toBeUndefined();
    const rules = effectiveRules(ctx, s, profileOf(WARRIOR, 'Neutron blaster'), {
      operative: shooter,
      weaponName: 'Neutron blaster',
    });
    expect(rules.find((r) => r.id === 'Piercing')).toMatchObject({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('Fly (faction rule) — four sibling ActionDefs (D-021)', () => {
  it('is registered as Reposition/Dash/Fall Back/Charge siblings, each treatedAs its universal action', () => {
    expect(ruleText(RULE_FLY)).toContain(
      'remove it from the killzone and set it back up wholly within a distance equal to its Move stat',
    );
    expect(getAction(FLY_REPOSITION)).toMatchObject({ treatedAs: 'Reposition', ap: 1 });
    expect(getAction(FLY_DASH)).toMatchObject({ treatedAs: 'Dash', ap: 1 });
    expect(getAction(FLY_FALL_BACK)).toMatchObject({ treatedAs: 'Fall Back', ap: 2 });
    expect(getAction(FLY_CHARGE)).toMatchObject({ treatedAs: 'Charge', ap: 1 });
    expect(getAction(FLY_REPOSITION)!.sourceText).toBe(ruleText(RULE_FLY));
  });

  it('"set it back up wholly within a distance equal to its Move stat horizontally of its original location"', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    isolate(state, [op]);
    place(state, op, 8, 11);
    const move = moveOf(ctx, state, state.operatives[op]!);
    expect(move).toBe(6);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    // Wholly within 6" of (8,11): a 28mm base has a 0.551" radius, so 5.4" is legal and 6" is not.
    const tooFar = act(ctx, s, op, FLY_REPOSITION, { targetPos: { x: 14, y: 11 } });
    expect(tooFar.ok).toBe(false);
    expect(tooFar.reason).toContain('wholly within 6"');
    const ok = act(ctx, s, op, FLY_REPOSITION, { targetPos: { x: 13.4, y: 11 } });
    expect(ok.ok).toBe(true);
    expect(ok.state.operatives[op]!.pos).toMatchObject({ x: 13.4, y: 11 });
    expect(ok.state.operatives[op]!.actionsThisActivation).toContain('Reposition');
  });

  it('"or 3" if it was a Dash"', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    isolate(state, [op]);
    place(state, op, 8, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    expect(act(ctx, s, op, FLY_DASH, { targetPos: { x: 11.5, y: 11 } }).ok).toBe(false);
    expect(act(ctx, s, op, FLY_DASH, { targetPos: { x: 10.4, y: 11 } }).ok).toBe(true);
  });

  it('"unless it’s the Charge action, it cannot be set up within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [op, foe]);
    place(state, op, 8, 11);
    place(state, foe, 12, 11);
    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    const blocked = act(ctx, s, op, FLY_REPOSITION, { targetPos: { x: 10.5, y: 11 } });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('control range');
    // The Charge variant must finish engaged and gains no additional distance.
    const charged = act(ctx, s, op, FLY_CHARGE, { targetPos: { x: 10.5, y: 11 } });
    expect(charged.ok).toBe(true);
    expect(charged.state.operatives[op]!.actionsThisActivation).toContain('Charge');
  });

  it('the Communion Charge toll is enforced for Charge (FLY): the closest enemy it can reach, or a point', () => {
    expect(ruleText(RULE_COMMUNION)).toContain(
      'it must end the action within control range of the closest enemy operative it can unless you spend 1 of your Communion points',
    );
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    const near = opWith(state, 'p2', WARRIOR);
    const far = opWith(state, 'p2', SKYBLAST);
    isolate(state, [op, near, far]);
    place(state, op, 8, 11);
    place(state, near, 11, 11);
    place(state, far, 8, 15);
    setCommunionPoints(state, 'p1', 0);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    const wrong = act(ctx, s, op, FLY_CHARGE, { targetPos: { x: 8, y: 13.5 } });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain('Communion');
    setCommunionPoints(s, 'p1', 1);
    const paid = act(ctx, s, op, FLY_CHARGE, { targetPos: { x: 8, y: 13.5 } });
    expect(paid.ok).toBe(true);
    expect(communionPoints(paid.state, 'p1')).toBe(0);
  });

  it('"Note that it gains no additional distance when performing the Charge action"', () => {
    expect(ruleText(RULE_FLY)).toContain('Note that it gains no additional distance when performing the Charge action.');
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [op, foe]);
    place(state, op, 8, 11);
    place(state, foe, 15.2, 11); // 6.1" of base-to-base gap: inside a walking Charge's 6+2"
    setCommunionPoints(state, 'p1', 3);
    state.activePlayer = 'p1';
    const s = activate(ctx, state, op);
    const out = act(ctx, s, op, FLY_CHARGE, { targetPos: { x: 14.2, y: 11 } });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('wholly within 6"');
  });

  it('the Fall Back sibling needs an enemy within control range and cannot land in one', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [op, foe]);
    place(state, op, 12, 11);
    place(state, foe, 20, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    expect(act(ctx, s, op, FLY_FALL_BACK, { targetPos: { x: 9, y: 11 } }).reason).toContain('control range');
    place(s, foe, 12.9, 11);
    const out = act(ctx, s, op, FLY_FALL_BACK, { targetPos: { x: 8, y: 11 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[op]!.actionsThisActivation).toContain('Fall Back');
  });

  it('the inline half of Fly is reminder-only: onMoveRules is declared but never emitted', () => {
    expect(ruleText(RULE_FLY)).toContain('Whenever a friendly VESPID STINGWING operative performs an action in which it moves, it can FLY');
    expect(REMINDER_ONLY[`${RULE_FLY}.inline`]).toContain('onMoveRules');
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('HARDENED EXOSKELETON: "Normal Dmg of 4 or more inflicts 1 less damage on it"', () => {
    expect(ruleText(SP_HARDENED)).toContain(
      'Whenever a friendly VESPID STINGWING operative (excluding OVERSIGHT DRONE) is fighting or retaliating, Normal Dmg of 4 or more inflicts 1 less damage on it',
    );
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', LONGSTING)]!;
    state.teams.p1.gambitsUsedTP.push(SP_HARDENED);
    // A fight in which the enemy is striking with a Normal Dmg 4 weapon.
    const claws = { ...profileOf(LONGSTING, 'Claws'), dmgN: 4 };
    foe.weaponUses = {};
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: foe.id,
      defenderId: mine.id,
      attackerWeapon: 'Claws',
      defenderWeapon: 'Claws',
      defenderCanRetaliate: true,
      attackerPool: newPool(),
      defenderPool: newPool(),
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
      attackerAssists: 0,
      defenderAssists: 0,
      attacker: 'p2',
      defender: 'p1',
      free: false,
      hatchway: false,
    };
    // The printed Claws are Normal Dmg 3 — below the threshold, so nothing changes.
    const before = mine.wounds;
    inflictDamage(ctx, state, mine, 3, 'attack');
    expect(mine.wounds).toBe(before - 3);
    // Raise the striking weapon's Normal Dmg to 4 by giving the enemy a 4-damage melee profile.
    ctx.datacards.set(foe.datacardId, {
      ...ctx.datacards.get(foe.datacardId)!,
      weapons: [{ name: 'Claws', profiles: [claws] }],
    });
    const before4 = mine.wounds;
    inflictDamage(ctx, state, mine, 4, 'attack');
    expect(mine.wounds).toBe(before4 - 3); // 4 → 3
  });

  it('AERIAL AGILITY: "roll one D6 whenever an attack dice would inflict Normal Dmg: on a 5+, ignore that inflicted damage"', () => {
    expect(ruleText(SP_AERIAL_AGILITY)).toContain(
      'roll one D6 whenever an attack dice would inflict Normal Dmg: on a 5+, ignore that inflicted damage',
    );
    const { ctx, state } = setup({ script: [5] });
    const mine = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    state.teams.p1.gambitsUsedTP.push(SP_AERIAL_AGILITY);
    state.activeOperativeId = foe.id;
    foe.actionsThisActivation.push('Reposition'); // "…in which that shooting operative moved"
    const seq = shootSeq({
      attackerId: foe.id,
      targetId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Neutron blaster',
      attack: pool([6, 4, 2, 2], 4),
    });
    state.sequence = seq;
    const before = mine.wounds;
    inflictDamage(ctx, state, mine, 6, 'attack'); // 1 crit (3) + 1 normal (3)
    expect(mine.wounds).toBe(before - 3); // the normal dice's 3 damage is ignored
  });

  it('AERIAL AGILITY does nothing when the shooting operative neither counteracted nor moved', () => {
    const { ctx, state } = setup({ script: [5] });
    const mine = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    state.teams.p1.gambitsUsedTP.push(SP_AERIAL_AGILITY);
    state.activeOperativeId = foe.id;
    state.sequence = shootSeq({
      attackerId: foe.id,
      targetId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Neutron blaster',
      attack: pool([6, 4, 2, 2], 4),
    });
    const before = mine.wounds;
    inflictDamage(ctx, state, mine, 6, 'attack');
    expect(mine.wounds).toBe(before - 6);
  });

  it('AIRBORNE PREDATORS: "its weapons have the Balanced weapon rule until the end of that activation"', () => {
    expect(ruleText(SP_AIRBORNE_PREDATORS)).toContain(
      'Whenever a friendly VESPID STINGWING operative moves or uses FLY during its activation, its weapons have the Balanced weapon rule until the end of that activation',
    );
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    state.teams.p1.gambitsUsedTP.push(SP_AIRBORNE_PREDATORS);
    const read = () =>
      effectiveRules(ctx, state, profileOf(WARRIOR, 'Neutron blaster'), {
        operative: op,
        weaponName: 'Neutron blaster',
      }).some((r) => r.id === 'Balanced');
    expect(read()).toBe(false);
    state.activeOperativeId = op.id;
    op.actionsThisActivation.push('Dash');
    expect(read()).toBe(true);
    // "until the end of that activation" — it stands down once the operative is no longer active.
    state.activeOperativeId = undefined as unknown as string | undefined;
    expect(read()).toBe(false);
  });

  it('STING: "Improve the Hit stat of … claws by 1, and those weapons have the Lethal 5+ and Shock weapon rules"', () => {
    expect(ruleText(SP_STING)).toContain(
      'Improve the Hit stat of friendly VESPID STINGWING operatives’ claws by 1, and those weapons have the Lethal 5+ and Shock weapon rules',
    );
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    state.teams.p1.gambitsUsedTP.push(SP_STING);
    const claws = profileOf(WARRIOR, 'Claws');
    const granted = effectiveRules(ctx, state, claws, { operative: mine, weaponName: 'Claws' });
    expect(granted.find((r) => r.id === 'Lethal')).toMatchObject({ x: 5 });
    expect(granted.some((r) => r.id === 'Shock')).toBe(true);
    // The Hit change rides `onStatMod` (StatMods.hit from onCollectAttackDice is dead).
    expect(statMods(ctx, state, mine).hit).toBe(0);
    state.sequence = {
      kind: 'fight',
      step: 'rollAttack',
      attackerId: mine.id,
      defenderId: foe.id,
      attackerWeapon: 'Claws',
      defenderWeapon: 'Claws',
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
    };
    expect(statMods(ctx, state, mine).hit).toBe(1);
    expect(hitOf(ctx, state, mine, claws)).toBe(3); // printed 4+, improved by 1
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('OCELLI treats the operative as 3" higher and denies the target Light cover', () => {
    expect(ruleText(FP_OCELLI)).toContain(
      'treat that friendly operative as being 3" higher than it currently is (but not when determining the distance for Communion)',
    );
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [op, foe]);
    place(state, op, 8, 11);
    place(state, foe, 14, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    s = act(ctx, s, op, FLY_REPOSITION, { targetPos: { x: 9, y: 11 } }).state;
    const used = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP_OCELLI }, ctx);
    expect(used.ok).toBe(true);
    const ev = ctx.hooks.emit('onValidTarget', used.state, {
      state: used.state,
      attacker: used.state.operatives[op]!,
      target: used.state.operatives[foe]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('light');
    // It also grants the Vantage Accurate against an Engage-order target 3" lower.
    const rules = effectiveRules(ctx, used.state, profileOf(WARRIOR, 'Neutron blaster'), {
      operative: used.state.operatives[op]!,
      target: used.state.operatives[foe]!,
      weaponName: 'Neutron blaster',
    });
    expect(rules.find((r) => r.id === 'Accurate')).toMatchObject({ x: 1 });
  });

  it('OCELLI’s 3" lift is explicitly NOT applied to the Communion distance', () => {
    // Communion measures a horizontal base-to-base gap, so the height lift cannot reach it.
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [shooter, foe]);
    place(state, shooter, 10, 11, 0);
    place(state, foe, 15, 11, 0);
    const T = hooksFor(ctx, 'p1');
    const flat = communionTarget(T, state, state.operatives[shooter]!)!.id;
    place(state, shooter, 10, 11, 3);
    expect(communionTarget(T, state, state.operatives[shooter]!)!.id).toBe(flat);
    expect(REMINDER_ONLY[`${FP_OCELLI}.obscured`]).toContain('Vantage');
  });

  it('DARTING FLIGHT adds D3" and locks Shoot and Fight for the rest of the turning point', () => {
    expect(ruleText(FP_DARTING_FLIGHT)).toContain(
      'it can move an additional D3", or be set up an additional D3" away if it uses FLY. In either case, it cannot perform Shoot or Fight actions for the rest of the turning point',
    );
    const { ctx, state } = setup({ script: [5] }); // D3 = 3
    const op = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [op, foe]);
    place(state, op, 8, 11);
    place(state, foe, 20, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP_DARTING_FLIGHT, data: { operativeId: op } }, ctx).state;
    // 6" Move + 3" = 9": (16.4, 11) is 8.4" away and legal, wholly within 9".
    const out = act(ctx, s, op, FLY_REPOSITION, { targetPos: { x: 16.4, y: 11 } });
    expect(out.ok).toBe(true);
    const shoot = availableActions(ctx, out.state, out.state.operatives[op]!).find((a) => a.def.id === 'Shoot')!;
    expect(shoot.ok).toBe(false);
    expect(shoot.reason).toContain('DARTING FLIGHT');
  });

  it('DARTING FLIGHT also adds its D3" to a WALKING Reposition, through onMoveDistance', () => {
    const { ctx, state } = setup({ script: [5] }); // D3 = 3
    const op = opWith(state, 'p1', WARRIOR);
    isolate(state, [op]);
    place(state, op, 8, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    // 6" alone is not enough for a 9" walk.
    expect(act(ctx, s, op, 'Reposition', { path: { points: [{ x: 17, y: 11 }] } }).ok).toBe(false);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP_DARTING_FLIGHT, data: { operativeId: op } }, ctx).state;
    expect(act(ctx, s, op, 'Reposition', { path: { points: [{ x: 17, y: 11 }] } }).ok).toBe(true);
  });

  it('NEUTRON OVERLOAD: "If the target is within 4" of it, inflict D3 additional damage"', () => {
    expect(ruleText(FP_NEUTRON_OVERLOAD)).toContain('If the target is within 4" of it, inflict D3 additional damage');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 12, 11);
    place(state, foe.id, 14, 11);
    state.activeOperativeId = shooter.id;
    shooter.actionsThisActivation.push('Reposition');
    state.teams.p1.ploysUsedTP.push(FP_NEUTRON_OVERLOAD);
    ctx.hooks.emit('onPloyUsed', state, {
      state,
      player: 'p1',
      ployId: FP_NEUTRON_OVERLOAD,
      kind: 'firefight',
    });
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, foe, profileOf(WARRIOR, 'Neutron blaster'), 'Neutron blaster'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBeLessThan(before);
    expect(state.rolls.some((r) => r.kind === 'neutronOverload')).toBe(true);
  });

  it('VICIOUS VENOM fires when the operative is FIGHTING, not when it retaliates', () => {
    expect(ruleText(FP_VICIOUS_VENOM)).toContain(
      'Use this firefight ploy when a friendly VESPID STINGWING operative (excluding OVERSIGHT DRONE) is fighting and you strike with a critical success. Inflict D3 additional damage.',
    );
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const fight = (attackerId: string, defenderId: string) => ({
      kind: 'fight' as const,
      step: 'resolve' as const,
      attackerId,
      defenderId,
      attackerWeapon: 'Claws',
      defenderWeapon: 'Claws',
      defenderCanRetaliate: true,
      attackerPool: newPool(),
      defenderPool: newPool(),
      turn: 'attacker' as const,
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
      attackerAssists: 0,
      defenderAssists: 0,
      attacker: 'p1' as PlayerId,
      defender: 'p2' as PlayerId,
      free: false,
      hatchway: false,
    });
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP_VICIOUS_VENOM, kind: 'firefight' });
    // Retaliating (our operative is the fight's DEFENDER): nothing happens.
    state.sequence = { ...fight(foe.id, mine.id), attacker: 'p2', defender: 'p1' };
    const retaliateBefore = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(mine, foe, profileOf(WARRIOR, 'Claws'), 'Claws', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBe(retaliateBefore);
    // Fighting: the D3 lands.
    state.sequence = fight(mine.id, foe.id);
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(mine, foe, profileOf(WARRIOR, 'Claws'), 'Claws', 'melee'),
      crit: true,
      struck: foe,
    });
    expect(foe.wounds).toBeLessThan(retaliateBefore);
  });

  it('every ploy has an aiHints value and every datacard a role', () => {
    const ids = vespidStingwings.ploys.map((p) => p.id);
    for (const id of ids) expect(vespidStingwings.aiHints?.ployValue?.[id]).toBeTypeOf('number');
    for (const c of DATA.datacards) expect(vespidStingwings.aiHints?.roles?.[c.id]).toBeTypeOf('string');
    for (const e of DATA.equipment) expect(vespidStingwings.aiHints?.equipmentValue?.[e.id]).toBeTypeOf('number');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('ACCELERANT STIMULANT: "it can move an additional 1"… you can set it back up 1" further away"', () => {
    expect(ruleText(EQ_ACCELERANT)).toContain(
      'performs the Charge or Dash action, it can move an additional 1". If it uses FLY for this action, you can set it back up 1" further away',
    );
    const { ctx, state } = setup({ equipment: [EQ_ACCELERANT] });
    const op = opWith(state, 'p1', WARRIOR);
    isolate(state, [op]);
    place(state, op, 8, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, op);
    // Dash is 3" + 1" = 4": (11.4, 11) is 3.4" away, wholly within 4".
    expect(act(ctx, s, op, FLY_DASH, { targetPos: { x: 11.4, y: 11 } }).ok).toBe(true);
    // The walking Dash gets the same inch through onMoveDistance.
    const dash = act(ctx, s, op, 'Dash', { path: { points: [{ x: 11.9, y: 11 }] } });
    expect(dash.ok).toBe(true);
  });

  it('AGGRESSION STIMULANT: Ceaseless while FIGHTING, not while retaliating, and never for the drone', () => {
    expect(ruleText(EQ_AGGRESSION)).toContain(
      'Whenever a friendly VESPID STINGWING operative (excluding OVERSIGHT DRONE) is fighting, its melee weapons have the Ceaseless weapon rule',
    );
    const { ctx, state } = setup({ equipment: [EQ_AGGRESSION] });
    const mine = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const drone = state.operatives[opWith(state, 'p1', OVERSIGHT_DRONE)]!;
    const claws = profileOf(WARRIOR, 'Claws');
    expect(
      effectiveRules(ctx, state, claws, { operative: mine, weaponName: 'Claws' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(true);
    expect(
      effectiveRules(ctx, state, claws, { operative: mine, weaponName: 'Claws', retaliating: true }).some(
        (r) => r.id === 'Ceaseless',
      ),
    ).toBe(false);
    expect(
      effectiveRules(ctx, state, profileOf(OVERSIGHT_DRONE, 'Ram'), { operative: drone, weaponName: 'Ram' }).some(
        (r) => r.id === 'Ceaseless',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('STRAIN LEADER', () => {
  it('Commune is a pure setter (D-017) and refunds the chosen ploy’s CP', () => {
    expect(abilityText(STRAIN_LEADER, AB_COMMUNE)).toContain(
      'When selecting your operatives for the battle, also select one VESPID STINGWING strategy ploy. Whenever this operative is in the killzone and isn’t within control range of enemy operatives, that ploy costs you 0CP.',
    );
    const { ctx, state } = setup();
    isolate(state, [opWith(state, 'p1', STRAIN_LEADER)]);
    state.teams.p1.cp = 3;
    // Nothing applies until the setter is called.
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP_STING }, ctx).state;
    expect(s.teams.p1.cp).toBe(2);
    s.teams.p1.gambitsUsedTP = [];
    setCommunePloy(s, 'p1', SP_HARDENED);
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: SP_HARDENED }, ctx).state;
    expect(s.teams.p1.cp).toBe(2); // charged 1CP, refunded 1CP
  });

  it('Commune does nothing while the STRAIN LEADER is within control range of an enemy operative', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1, 1, 1] });
    const leader = opWith(state, 'p1', STRAIN_LEADER);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [leader, foe]);
    place(state, leader, 12, 11);
    place(state, foe, 12.9, 11);
    state.teams.p1.cp = 3;
    setCommunePloy(state, 'p1', SP_HARDENED);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP_HARDENED }, ctx).state;
    expect(s.teams.p1.cp).toBe(2);
  });

  it('setCommunePloy refuses anything that is not a VESPID STINGWING strategy ploy', () => {
    const { state } = setup();
    expect(() => setCommunePloy(state, 'p1', FP_OCELLI)).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('OVERSIGHT DRONE › Evasive Drone', () => {
  const droneText = () => abilityText(OVERSIGHT_DRONE, AB_EVASIVE_DRONE);

  it('"cannot perform any actions other than Aerial Guidance, Charge, Dash, Fall Back, Fight and Reposition"', () => {
    expect(droneText()).toContain(
      'This operative cannot perform any actions other than Aerial Guidance, Charge, Dash, Fall Back, Fight and Reposition.',
    );
    const { ctx, state } = setup();
    const drone = opWith(state, 'p1', OVERSIGHT_DRONE);
    isolate(state, [drone]);
    place(state, drone, 12, 11);
    state.activePlayer = 'p1';
    const s = activate(ctx, state, drone);
    const acts = availableActions(ctx, s, s.operatives[drone]!);
    const byIdOf = (id: string) => acts.find((a) => a.def.id === id);
    expect(byIdOf('Shoot')?.ok).toBe(false);
    expect(byIdOf('Shoot')?.reason).toContain('Evasive Drone');
    expect(byIdOf('Pick Up Marker')?.ok).toBe(false);
    // Its own FLY siblings ARE the permitted actions (D-021's `treatedAs`).
    expect(byIdOf(FLY_REPOSITION)?.reason ?? '').not.toContain('Evasive Drone');
    expect(byIdOf(ACT_AERIAL_GUIDANCE)?.reason ?? '').not.toContain('Evasive Drone');
  });

  it('"treat this operative’s APL stat as 1 lower" when determining control of an objective marker', () => {
    expect(droneText()).toContain(
      'Whenever determining control of an objective marker, treat this operative’s APL stat as 1 lower.',
    );
    const { ctx, state } = setup();
    const drone = opWith(state, 'p1', OVERSIGHT_DRONE);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [drone, foe]);
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, drone, marker.pos.x + 0.5, marker.pos.y);
    place(state, foe, marker.pos.x - 0.5, marker.pos.y);
    // APL 2 vs APL 2 would be a tie; the drone counts as 1, so the enemy controls it.
    expect(markerController(ctx, state, marker)).toBe('p2');
  });

  it('"while it has a Conceal order and is in cover, it cannot be selected as a valid target … except being within 2""', () => {
    expect(droneText()).toContain(
      'it cannot be selected as a valid target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"',
    );
    const light = heavyBlock('lightA', 14, 9, 1, 4, 1);
    light.parts[0]!.types = ['Light'];
    const { ctx, state } = setup({ map: testMap({ features: [light] }) });
    const drone = state.operatives[opWith(state, 'p1', OVERSIGHT_DRONE)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    drone.order = 'conceal';
    const emit = () =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: foe,
        target: drone,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      });
    isolate(state, [drone.id, foe.id]);
    place(state, drone.id, 13.2, 11); // behind the Light terrain, in cover from it
    place(state, foe.id, 22, 11);
    expect(emit().valid).toBe(false);
    // "…except being within 2""
    place(state, foe.id, 15.4, 11);
    expect(emit().valid).toBe(true);
    // …and only while it has a Conceal order.
    place(state, foe.id, 22, 11);
    drone.order = 'engage';
    expect(emit().valid).toBe(true);
    expect(REMINDER_ONLY[`${AB_EVASIVE_DRONE}.head`]).toContain('head');
  });

  it('"Whenever an operative is shooting this operative, ignore the Piercing weapon rule"', () => {
    expect(droneText()).toContain('Whenever an operative is shooting this operative, ignore the Piercing weapon rule.');
    const { ctx, state } = setup();
    const drone = state.operatives[opWith(state, 'p1', OVERSIGHT_DRONE)]!;
    const shooter = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    // Neutron Charge would grant Piercing 1; against the drone it is ignored.
    state.activeOperativeId = shooter.id;
    shooter.actionsThisActivation.push('Reposition');
    const other = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const profile = profileOf(WARRIOR, 'Neutron blaster');
    expect(
      effectiveRules(ctx, state, profile, { operative: shooter, target: other, weaponName: 'Neutron blaster' }).some(
        (r) => r.id === 'Piercing',
      ),
    ).toBe(true);
    expect(
      effectiveRules(ctx, state, profile, { operative: shooter, target: drone, weaponName: 'Neutron blaster' }).some(
        (r) => r.id === 'Piercing',
      ),
    ).toBe(false);
  });

  it('AERIAL GUIDANCE grants Lethal 5+ and Saturate within 6", and not while the drone is engaged', () => {
    const printed = actionOf(OVERSIGHT_DRONE, ACT_AERIAL_GUIDANCE);
    expect(printed.ap).toBe(1);
    expect(printed.text).toContain(
      'whenever another friendly VESPID STINGWING operative within 6" of this operative is shooting an enemy operative visible to this operative, that friendly operative’s ranged weapons have the Lethal 5+ and Saturate weapon rules',
    );
    const { ctx, state } = setup();
    const drone = opWith(state, 'p1', OVERSIGHT_DRONE);
    const shooter = opWith(state, 'p1', WARRIOR);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [drone, shooter, foe]);
    place(state, drone, 12, 11);
    place(state, shooter, 14, 11);
    place(state, foe, 18, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, drone);
    const out = act(ctx, s, drone, ACT_AERIAL_GUIDANCE, {});
    expect(out.ok).toBe(true);
    s = out.state;
    const read = () =>
      effectiveRules(ctx, s, profileOf(WARRIOR, 'Neutron blaster'), {
        operative: s.operatives[shooter]!,
        target: s.operatives[foe]!,
        weaponName: 'Neutron blaster',
      });
    expect(read().find((r) => r.id === 'Lethal')).toMatchObject({ x: 5 });
    expect(read().some((r) => r.id === 'Saturate')).toBe(true);
    // "This has no effect while this operative is within control range of an enemy operative."
    place(s, foe, 12.8, 11);
    expect(read().some((r) => r.id === 'Saturate')).toBe(false);
  });

  it('AERIAL GUIDANCE cannot be performed while within control range of an enemy operative', () => {
    expect(actionOf(OVERSIGHT_DRONE, ACT_AERIAL_GUIDANCE).text).toContain(
      'This operative cannot perform this action while within control range of an enemy operative.',
    );
    const { ctx, state } = setup();
    const drone = opWith(state, 'p1', OVERSIGHT_DRONE);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [drone, foe]);
    place(state, drone, 12, 11);
    place(state, foe, 12.8, 11);
    state.activePlayer = 'p1';
    const s = activate(ctx, state, drone);
    expect(act(ctx, s, drone, ACT_AERIAL_GUIDANCE, {}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('LONGSTING › Neutron Fragment (rare weapon rule)', () => {
  it('"the target gains one of your Neutron Fragment tokens" when any attack dice is resolved', () => {
    expect(abilityText(LONGSTING, AB_NEUTRON_FRAGMENT)).toContain(
      'If the target of this weapon isn’t incapacitated but you resolve any attack dice, the target gains one of your Neutron Fragment tokens.',
    );
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', LONGSTING)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    state.sequence = shootSeq({
      attackerId: sniper.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Neutron rail rifle',
      attack: pool([6, 2, 2, 2], 4),
    });
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(sniper, foe, profileOf(LONGSTING, 'Neutron rail rifle', 'standard'), 'Neutron rail rifle'),
      crit: true,
      struck: foe,
    });
    expect(fragmentTokens(state, foe.id, 'p1')).toBe(1);
  });

  it('"inflict D3 damage on it for each Neutron Fragment token it has (roll separately for each)"', () => {
    expect(abilityText(LONGSTING, AB_NEUTRON_FRAGMENT)).toContain(
      'inflict D3 damage on it for each Neutron Fragment token it has (roll separately for each)',
    );
    const { ctx, state } = setup({ script: [5, 5] }); // two D3s of 3
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [foe]);
    addFragment(state, state.operatives[foe]!, 'p1');
    addFragment(state, state.operatives[foe]!, 'p1');
    expect(fragmentTokens(state, foe, 'p1')).toBe(2);
    const before = state.operatives[foe]!.wounds;
    state.activePlayer = 'p2';
    const s = activate(ctx, state, foe);
    expect(s.operatives[foe]!.wounds).toBe(before - 6);
    expect(s.rolls.filter((r) => r.kind === 'neutronFragment')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('SHADESTRAIN', () => {
  it('Ghost Rig: "your opponent cannot select it as a valid target unless it’s within 6" of the operative trying to target it"', () => {
    expect(abilityText(SHADESTRAIN, AB_GHOST_RIG)).toContain(
      'While this operative has a Conceal order, your opponent cannot select it as a valid target unless it’s within 6" of the operative trying to target it.',
    );
    const { ctx, state } = setup();
    const shade = state.operatives[opWith(state, 'p1', SHADESTRAIN)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [shade.id, foe.id]);
    shade.order = 'conceal';
    const emit = () =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: foe,
        target: shade,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      });
    place(state, shade.id, 10, 11);
    place(state, foe.id, 20, 11);
    expect(emit().valid).toBe(false);
    place(state, foe.id, 14, 11); // ~3" base-to-base
    expect(emit().valid).toBe(true);
    shade.order = 'engage';
    place(state, foe.id, 20, 11);
    expect(emit().valid).toBe(true);
    expect(REMINDER_ONLY[`${AB_GHOST_RIG}.secondary`]).toContain('Torrent');
  });

  it('Camouflaged: "ignore the Piercing weapon rule and all cover saves are retained as critical successes"', () => {
    expect(abilityText(SHADESTRAIN, AB_CAMOUFLAGED)).toContain(
      'Whenever an operative is shooting this operative, ignore the Piercing weapon rule and all cover saves are retained as critical successes.',
    );
    const { ctx, state } = setup();
    const shade = state.operatives[opWith(state, 'p1', SHADESTRAIN)]!;
    const shooter = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const profile = profileOf(WARRIOR, 'Neutron blaster');
    const rules = [...profile.rules, { id: 'Piercing' as const, x: 1, raw: 'Piercing 1' }];
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: shade.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Neutron blaster',
      attack: pool([2, 2, 2, 2], 4),
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: { ...attackCtx(shooter, shade, profile, 'Neutron blaster'), rules },
      count: 2, // 3 − Piercing 1
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(3);
    expect(ev.coverSaveAsCrit).toBe(true);
  });

  it('Camouflaged has "no effect if this operative isn’t selected as the valid target" (a Blast secondary)', () => {
    expect(abilityText(SHADESTRAIN, AB_CAMOUFLAGED)).toContain(
      'This rule has no effect if this operative isn’t selected as the valid target, e.g. if it’s a secondary target from the Blast weapon rule.',
    );
    const { ctx, state } = setup();
    const shade = state.operatives[opWith(state, 'p1', SHADESTRAIN)]!;
    const shooter = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const profile = profileOf(WARRIOR, 'Neutron blaster');
    const rules = [...profile.rules, { id: 'Piercing' as const, x: 1, raw: 'Piercing 1' }];
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: shade.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Neutron blaster',
      secondary: true,
      attack: pool([2, 2, 2, 2], 4),
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: { ...attackCtx(shooter, shade, profile, 'Neutron blaster', 'ranged', { secondary: true }), rules },
      count: 2,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(2);
    expect(ev.coverSaveAsCrit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('SKYBLAST', () => {
  it('Neutron Bombardment: "Place one of your Neutron Fallout markers within the primary target’s control range"', () => {
    expect(abilityText(SKYBLAST, AB_NEUTRON_BOMBARDMENT)).toBe(
      'Place one of your Neutron Fallout markers within the primary target’s control range.',
    );
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', SKYBLAST)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [gunner.id, foe.id]);
    place(state, gunner.id, 12, 11);
    place(state, foe.id, 16, 11);
    expect(falloutMarkers(state, 'p1')).toHaveLength(0);
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(gunner, foe, profileOf(SKYBLAST, 'Neutron grenade launcher'), 'Neutron grenade launcher'),
      crit: false,
      struck: foe,
    });
    expect(falloutMarkers(state, 'p1')).toHaveLength(1);
    expect(falloutMarkers(state, 'p1')[0]!.pos).toMatchObject({ x: 16, y: 11 });
  });

  it('Neutron Fallout: "Once during each enemy operative’s activation, as soon as it’s within 2" … inflict D3 damage"', () => {
    expect(abilityText(SKYBLAST, AB_NEUTRON_FALLOUT)).toContain(
      'Once during each enemy operative’s activation, as soon as it’s within 2" of one of your Neutron Fallout markers, inflict D3 damage on that operative (multiple markers aren’t cumulative)',
    );
    const { ctx, state } = setup({ script: [5, 5, 5] });
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [foe]);
    place(state, foe, 15, 11);
    state.markers['vespid-stingwings.fallout.p1.1'] = {
      id: 'vespid-stingwings.fallout.p1.1',
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 15.5, y: 11 },
      z: 0,
      owner: 'p1',
      flags: {},
    };
    const before = state.operatives[foe]!.wounds;
    state.activePlayer = 'p2';
    let s = activate(ctx, state, foe);
    expect(s.operatives[foe]!.wounds).toBe(before - 3);
    // "Once during each enemy operative's activation" — the end-of-activation check adds nothing.
    s = reduce(s, { t: 'EndActivation', operativeId: foe }, ctx).state;
    expect(s.operatives[foe]!.wounds).toBe(before - 3);
  });
});

// ---------------------------------------------------------------------------
describe('SWARMGUARD › Skytorch and SKYTORCH ASSAULT', () => {
  it('"An operative can only use this weapon during the Skytorch Assault action"', () => {
    expect(abilityText(SWARMGUARD, AB_SKYTORCH)).toContain(
      'An operative can only use this weapon during the Skytorch Assault action.',
    );
    const { ctx, state } = setup();
    const guard = opWith(state, 'p1', SWARMGUARD);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [guard, foe]);
    place(state, guard, 12, 11);
    place(state, foe, 15, 11);
    setCommunionPoints(state, 'p1', 3);
    state.activePlayer = 'p1';
    const s = activate(ctx, state, guard);
    const refused = act(ctx, s, guard, 'Shoot', {
      weaponName: 'Flamer',
      profileName: 'skytorch',
      targetId: foe,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('Skytorch');
    // The `standard` profile of the same weapon stays legal — a PROFILE-level restriction (D-032).
    expect(act(ctx, s, guard, 'Shoot', { weaponName: 'Flamer', profileName: 'standard', targetId: foe }).ok).toBe(true);
  });

  it('SKYTORCH ASSAULT: "Perform a free Reposition action … it must FLY and can move an additional 2""', () => {
    const printed = actionOf(SWARMGUARD, ACT_SKYTORCH_ASSAULT);
    expect(printed.ap).toBe(2);
    expect(printed.text).toContain(
      'Perform a free Reposition action with this operative. During that action, it must FLY and can move an additional 2". Then perform a free Shoot action. You can only select a flamer (skytorch) for that Shoot action.',
    );
    const { ctx, state } = setup();
    const guard = opWith(state, 'p1', SWARMGUARD);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [guard, foe]);
    place(state, guard, 10, 11);
    place(state, foe, 13, 11);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, guard);
    const d = skytorchDestination(ctx, s, s.operatives[guard]!, undefined);
    expect(d.max).toBe(8); // Move 6" + 2"
    const out = act(ctx, s, guard, ACT_SKYTORCH_ASSAULT, { targetPos: { x: 15.5, y: 11 } });
    expect(out.ok).toBe(true);
    s = settle(ctx, out.state);
    expect(s.operatives[guard]!.pos.x).toBeCloseTo(15.5);
    // Both free actions count for action restrictions.
    expect(s.operatives[guard]!.actionsThisActivation).toEqual(
      expect.arrayContaining(['Reposition', 'Shoot', ACT_SKYTORCH_ASSAULT]),
    );
    // The operative it swept over was shot: the torch zone became the target queue.
    expect(s.operatives[foe]!.wounds).toBeLessThan(9);
    const zone = s.effects.find((e) => e.rule === TORCH_ZONE);
    expect(zone?.data?.['victims']).toEqual([foe]);
  });

  it('takes a deterministic, logged destination when the caller supplies none (D-016)', () => {
    const { ctx, state } = setup();
    const guard = opWith(state, 'p1', SWARMGUARD);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [guard, foe]);
    place(state, guard, 10, 11);
    place(state, foe, 20, 11);
    state.activePlayer = 'p1';
    const s = activate(ctx, state, guard);
    // `src/ai/legal.ts` only ever offers `targetPos = op.pos`, so the default has to be legal.
    const d = skytorchDestination(ctx, s, s.operatives[guard]!, { x: 10, y: 11 });
    expect(d.ok).toBe(true);
    expect(d.pos!.x).toBeGreaterThan(10);
    expect(act(ctx, s, guard, ACT_SKYTORCH_ASSAULT, { targetPos: { x: 10, y: 11 } }).ok).toBe(true);
  });

  it('"Torrent 0" means you cannot select secondary targets outside of its torch zone"', () => {
    expect(abilityText(SWARMGUARD, AB_SKYTORCH)).toContain(
      'Torrent 0" means you cannot select secondary targets outside of its torch zone, but this weapon still has the Torrent weapon rule for all other rules purposes',
    );
    // The printed profile keeps Torrent, with x = 0 — the engine's own secondary scan therefore
    // finds nothing, and the torch zone is pushed into the queue instead.
    expect(profileOf(SWARMGUARD, 'Flamer', 'skytorch').rules.find((r) => r.id === 'Torrent')).toMatchObject({ x: 0 });
  });

  it('"The torch zone is the horizontal area between the operative’s current and previous location"', () => {
    expect(abilityText(SWARMGUARD, AB_SKYTORCH)).toContain(
      'The torch zone is the horizontal area between the operative’s current and previous location.',
    );
    const { ctx, state } = setup();
    const guard = state.operatives[opWith(state, 'p1', SWARMGUARD)]!;
    const onLine = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    const offLine = state.operatives[opWith(state, 'p2', SKYBLAST)]!;
    isolate(state, [guard.id, onLine.id, offLine.id]);
    place(state, guard.id, 16, 11);
    place(state, onLine.id, 13, 11);
    place(state, offLine.id, 13, 16);
    const victims = torchZoneVictims(ctx, state, guard, { x: 10, y: 11 }, { x: 16, y: 11 });
    expect(victims.map((v) => v.id)).toEqual([onLine.id]);
  });

  it('"excluding operatives wholly underneath Vantage terrain"', () => {
    expect(abilityText(SWARMGUARD, AB_SKYTORCH)).toContain('excluding operatives wholly underneath Vantage terrain');
    const map = testMap({ features: [vantagePlatform('gantry', 12, 9, 4, 4, 3)] });
    const { ctx, state } = setup({ map });
    const guard = state.operatives[opWith(state, 'p1', SWARMGUARD)]!;
    const sheltered = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [guard.id, sheltered.id]);
    place(state, guard.id, 16, 11);
    place(state, sheltered.id, 14, 11, 0); // on the floor, wholly under the gantry
    expect(torchZoneVictims(ctx, state, guard, { x: 10, y: 11 }, { x: 16, y: 11 })).toEqual([]);
  });

  it('cannot be performed with a Conceal order or while engaged', () => {
    expect(actionOf(SWARMGUARD, ACT_SKYTORCH_ASSAULT).text).toContain(
      'This operative cannot perform this action while it has a Conceal order, or while within control range of an enemy operative.',
    );
    const { ctx, state } = setup();
    const guard = opWith(state, 'p1', SWARMGUARD);
    const foe = opWith(state, 'p2', WARRIOR);
    isolate(state, [guard, foe]);
    place(state, guard, 10, 11);
    place(state, foe, 20, 11);
    state.activePlayer = 'p1';
    const concealed = activate(ctx, state, guard, 'conceal');
    expect(act(ctx, concealed, guard, ACT_SKYTORCH_ASSAULT, { targetPos: { x: 14, y: 11 } }).ok).toBe(false);
    place(state, foe, 10.9, 11);
    const engaged = activate(ctx, state, guard);
    expect(act(ctx, engaged, guard, ACT_SKYTORCH_ASSAULT, { targetPos: { x: 14, y: 11 } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('WARRIOR › Warrior Instincts', () => {
  it('"if you don’t spend Communion points during that sequence, its neutron blaster has the Accurate 1 weapon rule"', () => {
    expect(abilityText(WARRIOR, AB_WARRIOR_INSTINCTS)).toContain(
      'Whenever this operative is shooting, if you don’t spend Communion points during that sequence, its neutron blaster has the Accurate 1 weapon rule until the end of that sequence.',
    );
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', WARRIOR)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 12, 11);
    place(state, foe.id, 16, 11);
    setCommunionPoints(state, 'p1', 2);
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Neutron blaster',
    });
    const read = () =>
      effectiveRules(ctx, state, profileOf(WARRIOR, 'Neutron blaster'), {
        operative: shooter,
        target: foe,
        weaponName: 'Neutron blaster',
      }).find((r) => r.id === 'Accurate');
    expect(read()).toMatchObject({ x: 1 });
    // Only its neutron blaster.
    expect(
      effectiveRules(ctx, state, profileOf(WARRIOR, 'Claws'), { operative: shooter, weaponName: 'Claws' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
  });

  it('the Accurate 1 disappears the moment a Communion point is spent in that sequence', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', WARRIOR);
    const near = opWith(state, 'p2', SKYBLAST);
    const far = opWith(state, 'p2', LONGSTING);
    isolate(state, [shooter, near, far]);
    place(state, shooter, 10, 11);
    place(state, near, 13, 11);
    place(state, far, 16, 11);
    setCommunionPoints(state, 'p1', 2);
    state.activePlayer = 'p1';
    let s = activate(ctx, state, shooter);
    // Shooting the FURTHER enemy spends a Communion point at weapon selection, so the shot loses
    // Warrior Instincts before the attack dice are collected.
    const out = act(ctx, s, shooter, 'Shoot', { weaponName: 'Neutron blaster', targetId: far });
    expect(out.ok).toBe(true);
    expect(communionPoints(out.state, 'p1')).toBe(1);
    expect(out.state.log.some((l) => /Accurate/.test(l.text))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('reminder-only clauses are declared, not silently registered', () => {
  it('lists every clause with no honest expression on the current hook surface', () => {
    expect(Object.keys(REMINDER_ONLY).sort()).toEqual(
      [
        `${AB_EVASIVE_DRONE}.head`,
        `${AB_GHOST_RIG}.secondary`,
        `${FP_OCELLI}.obscured`,
        `${RULE_COMMUNION}.charge`,
        `${RULE_FLY}.inline`,
      ].sort(),
    );
    for (const reason of Object.values(REMINDER_ONLY)) expect(reason.length).toBeGreaterThan(20);
  });
});
