/**
 * WRECKA KREW. Every test quotes the printed rule it pins, read out of
 * `data/teams/wrecka-krew.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/wrecka-krew/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { createGameContext } from '../../src/core/game.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { advanceFight, sideWeapon, startFight } from '../../src/core/sequences/fight.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, aplOf, hitOf, inflictDamage, moveOf, saveOf, weaponsOf } from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/wrecka-krew.json';
import rareRulesJson from '../../data/teams/_rare-weapon-rules.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  AB_ARMOURED_UP,
  AB_BOOM,
  AB_DETONATE,
  AB_EXPENDABLE,
  AB_EXPLOSIVE,
  AB_KOMPETITIVE,
  AB_PULSA,
  AB_SALVO,
  AB_SHOKKWAVE,
  AB_SMASH,
  AB_STOOPID,
  ACT_BREAK_STUFF,
  BOMB_SQUIG,
  BOSS_NOB,
  DEMOLISHA,
  DEMOLITION_MARKER,
  EQ_DRILL_ROKKITS,
  EQ_ENGINE_OIL,
  EQ_EXTRA_ARMOUR,
  EQ_GLYPHS,
  EXPLOSIVE_SHOOT,
  FIGHTER,
  FP_DEMOLITION_JOB,
  FP_JUST_A_SCRATCH,
  FP_KABOOM,
  FP_PROPPA_SCRAP,
  GUNNER,
  KRUSHA,
  MAX_WRECKA_POINTS,
  PROPPA_SCRAP_FIGHT,
  whollyWithinMarker,
  PULSA_MARKER,
  PULSA_SHOOT,
  REMINDER_ONLY,
  ROKKITEER,
  RULE_RAMPAGE,
  RULE_TANKED_UP,
  SP_AMPED_UP,
  SP_DESTRUCTION,
  SP_TUFF_GITZ,
  SP_WAAAGH,
  gainWreckaPoints,
  isDrillRokkit,
  planBreakStuff,
  planSmash,
  pulsaPoints,
  wreckaKrew,
  wreckaPoints,
} from '../../src/teams/wrecka-krew/index.ts';
import { bucket } from '../../src/teams/helpers.ts';
import { act, activate, battle, mapById, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { heavyBlock, rect, testMap } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type {
  GameState,
  KillzoneMap,
  OperativeState,
  PlayerId,
  TerrainFeature,
  Vec2,
  WeaponProfile,
} from '../../src/core/types.ts';

const DATA = teamData('wrecka-krew');
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

const ALL_ROLES = [BOSS_NOB, BOMB_SQUIG, DEMOLISHA, FIGHTER, KRUSHA, GUNNER, ROKKITEER];

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([wreckaKrew], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = rosterIncluding(wreckaKrew, ALL_ROLES);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: wreckaKrew, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: wreckaKrew, picks },
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
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    n++;
  }
}

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function shootFixture(
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

function fightFixture(
  over: Partial<FightSequence> &
    Pick<FightSequence, 'attackerId' | 'defenderId' | 'attacker' | 'defender' | 'attackerWeapon'>,
): FightSequence {
  return {
    kind: 'fight',
    step: 'retention',
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    free: false,
    hatchway: false,
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

/** The rules a weapon has right now, straight through the engine's own emit. */
const rulesFor = (
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
  target?: OperativeState,
) => effectiveRules(ctx, state, profile, { operative: op, weaponName, ...(target ? { target } : {}) });

// ---------------------------------------------------------------------------
describe('WRECKA KREW data (pinned against data/teams/wrecka-krew.json)', () => {
  it('has 7 datacards, all APL 2 / Move 6" and every one an ORK WRECKA KREW', () => {
    expect(DATA.datacards).toHaveLength(7);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 2, move: 6 });
      expect(card.keywords).toContain('WRECKA KREW');
      expect(card.keywords).toContain('ORK');
    }
    expect(DATA.faction).toBe('Orks');
  });

  it('pins the bases, saves and wounds the rules read', () => {
    expect(DATA.datacards.find((c) => c.id === BOSS_NOB)).toMatchObject({
      base: { shape: 'round', mm: 40 },
      save: 4,
      wounds: 14,
    });
    expect(DATA.datacards.find((c) => c.id === BOMB_SQUIG)).toMatchObject({
      base: { shape: 'round', mm: 25 },
      save: 5,
      wounds: 5,
    });
    for (const id of [DEMOLISHA, FIGHTER, KRUSHA, GUNNER, ROKKITEER]) {
      expect(DATA.datacards.find((c) => c.id === id)).toMatchObject({
        base: { shape: 'round', mm: 32 },
        save: 4,
        wounds: 12,
      });
    }
    expect(DATA.datacards.find((c) => c.id === BOSS_NOB)!.keywords).toContain('LEADER');
  });

  it('exposes 2 faction rules, 4+4 ploys, 4 equipment options, 13 abilities and 1 unique action', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Wrecka Rampage', 'Tanked Up']);
    expect(wreckaKrew.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(wreckaKrew.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(wreckaKrew.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(13);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(1);
    expect(actionOf(FIGHTER, ACT_BREAK_STUFF)).toMatchObject({ name: 'Break Stuff', ap: 1 });
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(BOSS_NOB, 'Rokkit pistol')).toMatchObject({ atk: 6, hit: 5, dmgN: 4, dmgC: 5 });
    expect(profileOf(BOSS_NOB, 'Two rokkit pistols', 'focused')).toMatchObject({ atk: 6, hit: 4 });
    expect(profileOf(BOSS_NOB, 'Two rokkit pistols', 'focused').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Blast 1"',
      'Ceaseless',
    ]);
    expect(profileOf(BOSS_NOB, 'Two rokkit pistols', 'salvo').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Blast 1"',
      'Salvo*',
    ]);
    expect(profileOf(BOSS_NOB, 'Smash hammer').rules.map((r) => r.id)).toEqual(['Brutal']);
    expect(profileOf(KRUSHA, 'Knucklebustas').rules.map((r) => r.raw)).toEqual(['Brutal', 'Shock', 'Smash*']);
    expect(profileOf(GUNNER, '’Eavy rokkit launcha').rules.map((r) => r.raw)).toEqual([
      'Blast 1"',
      'Heavy (Dash only)',
    ]);
    expect(profileOf(ROKKITEER, 'Rokkit rack').rules.map((r) => r.raw)).toEqual([
      'Blast 2"',
      'Heavy (Reposition only)',
      'Limited 1',
      'Relentless',
    ]);
    expect(profileOf(BOMB_SQUIG, 'Explosives').rules.map((r) => r.raw)).toEqual([
      'Blast 1"',
      'Limited 1',
      'Explosive*',
    ]);
  });

  /**
   * `notes[]` records the two weapons that print a non-numeric DMG. Their damage is resolved by
   * their own rule, so a 0 that is never replaced would be a silently broken weapon — the rule
   * tests below pin what replaces each of them.
   */
  it('DATA: the two weapons printing a non-numeric DMG are recorded as 0/0 and resolved by a rule', () => {
    expect(NOTES).toHaveLength(2);
    expect(NOTES[0]).toContain("Tankhammer (detonate)' prints DMG '*'");
    expect(NOTES[1]).toContain("Pulsa rokkit' prints DMG '-'");
    expect(profileOf(DEMOLISHA, 'Tankhammer', 'detonate')).toMatchObject({ dmgN: 0, dmgC: 0, atk: 4, hit: 3 });
    expect(profileOf(DEMOLISHA, 'Tankhammer', 'detonate').rules.map((r) => r.raw)).toEqual([
      'Lethal 5+',
      'Limited 1',
      'Detonate*',
    ]);
    expect(profileOf(DEMOLISHA, 'Tankhammer', 'bash')).toMatchObject({ dmgN: 4, dmgC: 5 });
    expect(profileOf(ROKKITEER, 'Pulsa rokkit')).toMatchObject({ dmgN: 0, dmgC: 0, atk: 6, hit: 5 });
    expect(profileOf(ROKKITEER, 'Pulsa rokkit').rules.map((r) => r.raw)).toEqual([
      'Heavy (Reposition only)',
      'Limited 1',
      'Pulsa*',
    ]);
    // Both rules print the damage they inflict instead.
    expect(abilityText(DEMOLISHA, AB_DETONATE)).toContain('D6+6 damage');
    expect(abilityText(ROKKITEER, AB_PULSA)).toContain('inflict D3 damage');
  });

  it('prints FIVE rare weapon rules — the most of any kill team — and each resolves to its own datacard ability (D-033)', () => {
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['Detonate', 'Explosive', 'Pulsa', 'Salvo', 'Smash']);
    expect(rareWeaponRuleText('Detonate', 'wrecka-krew')).toBe(abilityText(DEMOLISHA, AB_DETONATE));
    expect(rareWeaponRuleText('Explosive', 'wrecka-krew')).toBe(abilityText(BOMB_SQUIG, AB_EXPLOSIVE));
    expect(rareWeaponRuleText('Pulsa', 'wrecka-krew')).toBe(abilityText(ROKKITEER, AB_PULSA));
    expect(rareWeaponRuleText('Salvo', 'wrecka-krew')).toBe(abilityText(BOSS_NOB, AB_SALVO));
    expect(rareWeaponRuleText('Smash', 'wrecka-krew')).toBe(abilityText(KRUSHA, AB_SMASH));
  });

  /**
   * Detonate and Salvo are printed DIFFERENTLY here from the shared registry — expected under
   * D-033, and reported. The registry's Detonate is a remote detonator fired at a Mine marker;
   * this team's is a melee profile that explodes on the first damage it would inflict.
   */
  it('DATA: this team’s Detonate and Salvo differ from the shared _rare-weapon-rules.json entries', () => {
    const registry = (rareRulesJson as { rules: { id: string; definition: string }[] }).rules;
    const shared = (id: string): string => registry.find((r) => r.id === id)!.definition;
    expect(shared('Detonate')).toContain('your Mine marker');
    expect(abilityText(DEMOLISHA, AB_DETONATE)).not.toContain('Mine marker');
    expect(rareWeaponRuleText('Detonate', 'wrecka-krew')).not.toBe(shared('Detonate'));
    // Salvo: the shared form has two primaries only; this team's adds the secondary sweep.
    expect(shared('Salvo')).not.toContain('secondary');
    expect(abilityText(BOSS_NOB, AB_SALVO)).toContain('then against all remaining secondary targets');
    expect(rareWeaponRuleText('Salvo', 'wrecka-krew')).not.toBe(shared('Salvo'));
    // The three others match the registry, which was sourced from this very team.
    expect(rareWeaponRuleText('Pulsa', 'wrecka-krew')).toBe(shared('Pulsa'));
    expect(rareWeaponRuleText('Smash', 'wrecka-krew')).toBe(shared('Smash'));
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('(roll separately for each).')).toBe(true);
    // The raw committed bytes still carry the overrun — that is the data problem, not the module.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect((rawJson as { firefightPloys: { text: string }[] }).firefightPloys[3]!.text).toContain('Faction Equipment');
  });

  it('DATA: no ploy has "1CP" glued onto its name or id, and no printed effect list is truncated', () => {
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) {
      expect(p.id).not.toMatch(/\d+cp$/i);
      expect(p.name).not.toMatch(/\d+CP$/);
      expect(p.text.trim()).not.toMatch(/(following effects|If you do):\s*$/);
    }
    for (const r of [...DATA.factionRules, ...DATA.equipment]) expect(r.text.trim()).not.toMatch(/:\s*$/);
    expect(actionOf(FIGHTER, ACT_BREAK_STUFF).text.trim()).not.toMatch(/:\s*$/);
  });
});

// ---------------------------------------------------------------------------
describe('WRECKA KREW selection', () => {
  it('prints exactly one constraint — the uniqueExcept sentence', () => {
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['BOMB SQUIG', 'BREAKA BOY FIGHTER', 'TANKBUSTA GUNNER'] },
    ]);
    expect(DATA.selection.rawText).toContain(
      'Other than BOMB SQUIG, BREAKA BOY FIGHTER and TANKBUSTA GUNNER operatives, your kill team can only include each operative on this list once.',
    );
  });

  it('defaultRoster is a legal 8-operative kill team that fields all 7 datacards', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(DATA.selection.totalOperatives);
    expect(picks).toHaveLength(8);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(new Set(picks.map((p) => p.datacardId))).toEqual(new Set(ALL_ROLES));
    expect(picks.filter((p) => p.datacardId === BOMB_SQUIG)).toHaveLength(2);
    expect(picks[0]!.datacardId).toBe(BOSS_NOB);
  });

  /**
   * The exemption names BREAKA BOY FIGHTER and TANKBUSTA GUNNER; the printed list rows are named
   * FIGHTER and GUNNER, so neither exact equality nor D-037's space-separated token fallback can
   * match (the fallback looks up a token of the ROW's name in the exempt set, and "FIGHTER" is not
   * in it). Only the data facts are pinned here — see the report.
   */
  it('DATA: the uniqueExcept roles are the long names while the list rows print the short ones', () => {
    const roles = DATA.selection.list.map((e) => e.role);
    expect(roles).toEqual(['BOMB SQUIG', 'BREAKA BOY DEMOLISHA', 'FIGHTER', 'KRUSHA', 'GUNNER', 'ROKKITEER']);
    const exempt = (DATA.selection.constraints[0] as { roles: string[] }).roles;
    expect(exempt).toContain('BREAKA BOY FIGHTER');
    expect(exempt).toContain('TANKBUSTA GUNNER');
    expect(roles).not.toContain('BREAKA BOY FIGHTER');
    expect(roles).not.toContain('TANKBUSTA GUNNER');
    // A second FIGHTER is therefore refused, though the printed sentence exempts it.
    const two = defaultRoster(DATA)
      .filter((p) => p.datacardId !== KRUSHA)
      .concat([{ datacardId: FIGHTER }]);
    const result = validateRosterFor(DATA, two);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain('unique');
    // …while a second BOMB SQUIG, whose row IS printed with the exempt name, is fine.
    expect(defaultRoster(DATA).filter((p) => p.datacardId === BOMB_SQUIG)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('Wrecka Rampage (faction rule)', () => {
  const RAMPAGE = ruleText(RULE_RAMPAGE);

  it('"For each attack dice result of 6 you retain, you gain one Wrecka point" — when shooting', () => {
    expect(RAMPAGE).toContain('For each attack dice result of 6 you retain, you gain one Wrecka point.');
    const { ctx, state } = setup();
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const profile = profileOf(BOSS_NOB, 'Rokkit pistol');
    state.sequence = shootFixture({
      attackerId: nob.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit pistol',
      attack: pool([6, 6, 5, 5], 5), // no fails, so nothing is spent back
    });
    rulesFor(ctx, state, nob, profile, 'Rokkit pistol', foe);
    expect(wreckaPoints(state, 'p1')).toBe(2);
  });

  it('the gain and the spend are live while RETALIATING — the fight sequence emits at its retention step', () => {
    expect(RAMPAGE).toContain('Whenever a friendly WRECKA KREW operative is shooting, fighting or retaliating');
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    place(state, foe.id, 10, 10);
    place(state, fighter.id, 11, 10);
    gainWreckaPoints(state, 'p1', 2, 'test');
    const seq = fightFixture({
      attackerId: foe.id,
      defenderId: fighter.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Knucklebustas',
      defenderWeapon: 'Smash hammer',
      attackerPool: pool([4, 4], 3),
      defenderPool: pool([6, 1, 2], 3),
    });
    state.sequence = seq;
    sideWeapon(ctx, state, seq, 'defender');
    // one 6 retained (+1), then two fails spent back down
    expect(seq.defenderPool.dice.filter((d) => d.note === 'Wrecka Rampage')).toHaveLength(2);
    expect(seq.defenderPool.dice.filter((d) => d.state === 'normal')).toHaveLength(2);
    expect(wreckaPoints(state, 'p1')).toBe(1); // 2 + 1 gained − 2 spent
  });

  it('"You can spend up to 2 of your Wrecka points… retain one of your fails as a normal success"', () => {
    expect(RAMPAGE).toContain('retain one of your fails as a normal success instead of discarding it');
    const { ctx, state } = setup();
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    gainWreckaPoints(state, 'p1', 5, 'test');
    const seq = shootFixture({
      attackerId: nob.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit pistol',
      attack: pool([1, 2, 3, 4], 5),
    });
    state.sequence = seq;
    rulesFor(ctx, state, nob, profileOf(BOSS_NOB, 'Rokkit pistol'), 'Rokkit pistol', foe);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(2);
    expect(wreckaPoints(state, 'p1')).toBe(3);
  });

  it('is idempotent across a retention re-entry — no third fail is converted', () => {
    const { ctx, state } = setup();
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    gainWreckaPoints(state, 'p1', 5, 'test');
    const seq = shootFixture({
      attackerId: nob.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit pistol',
      attack: pool([1, 2, 3, 4], 5),
    });
    state.sequence = seq;
    for (let i = 0; i < 3; i++) rulesFor(ctx, state, nob, profileOf(BOSS_NOB, 'Rokkit pistol'), 'Rokkit pistol', foe);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(2);
    expect(wreckaPoints(state, 'p1')).toBe(3);
  });

  it('"(unless it’s a BOMB SQUIG, then you cannot spend any)" — but a BOMB SQUIG still gains', () => {
    expect(RAMPAGE).toContain('unless it’s a BOMB SQUIG, then you cannot spend any');
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    gainWreckaPoints(state, 'p1', 3, 'test');
    const seq = shootFixture({
      attackerId: squig.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Explosives',
      attack: pool([6, 1, 2], 4),
    });
    state.sequence = seq;
    rulesFor(ctx, state, squig, profileOf(BOMB_SQUIG, 'Explosives'), 'Explosives', foe);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(0);
    expect(wreckaPoints(state, 'p1')).toBe(4); // gained, never spent
  });

  it('"You cannot have more than 6 Wrecka points at once."', () => {
    expect(RAMPAGE).toContain('You cannot have more than 6 Wrecka points at once.');
    const { state } = setup();
    gainWreckaPoints(state, 'p1', 10, 'test');
    expect(wreckaPoints(state, 'p1')).toBe(MAX_WRECKA_POINTS);
  });

  it('"unless you started the action with 6, in which case you can only spend them"', () => {
    expect(RAMPAGE).toContain('unless you started the action with 6, in which case you can only spend them');
    const { ctx, state } = setup();
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    gainWreckaPoints(state, 'p1', 6, 'test');
    bucket(state, 'wrecka-krew.actionStart')['p1'] = 6;
    const seq = shootFixture({
      attackerId: nob.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit pistol',
      attack: pool([6, 6, 1, 2], 5),
    });
    state.sequence = seq;
    rulesFor(ctx, state, nob, profileOf(BOSS_NOB, 'Rokkit pistol'), 'Rokkit pistol', foe);
    // The two 6s pay nothing (started at the cap); the two fails still cost 2 points.
    expect(seq.attack.dice.filter((d) => d.note === 'Wrecka point')).toHaveLength(0);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(2);
    expect(wreckaPoints(state, 'p1')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('Tanked Up (faction rule)', () => {
  const TANKED = ruleText(RULE_TANKED_UP);

  it('"the first time … performs either the Charge, Shoot or Fight action … add 1 to its APL stat"', () => {
    expect(TANKED).toContain('add 1 to its APL stat until the start of its next activation');
    const { ctx, state } = setup({ script: [4, 4, 4, 4, 4, 4, 1, 1, 1] });
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [gunner.id, foe.id]);
    place(state, gunner.id, 10, 10);
    place(state, foe.id, 16, 10);
    foe.wounds = 40;
    expect(aplOf(ctx, state, gunner)).toBe(2);
    let s = activate(ctx, state, gunner.id, 'engage');
    const out = act(ctx, s, gunner.id, 'Shoot', { weaponName: '’Eavy rokkit launcha', targetId: foe.id });
    s = settle(ctx, out.state);
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, s, s.operatives[gunner.id]!)).toBe(3);
  });

  it('does not fire for a Conceal order, nor for a BOMB SQUIG', () => {
    expect(TANKED).toContain('(excluding BOMB SQUIG) that has an Engage order');
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    place(state, gunner.id, 10, 10);
    place(state, foe.id, 11, 10);
    gunner.order = 'conceal';
    gunner.actionsThisActivation = ['Charge'];
    expect(aplOf(ctx, state, gunner)).toBe(2);
    gunner.order = 'engage';
    expect(aplOf(ctx, state, gunner)).toBe(3);
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    squig.order = 'engage';
    squig.actionsThisActivation = ['Charge'];
    expect(aplOf(ctx, state, squig)).toBe(2);
  });

  it('a RETALIATING operative is not performing an action, so it gains nothing', () => {
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [fighter.id, foe.id]);
    place(state, fighter.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    fighter.order = 'engage';
    startFight(ctx, state, foe, 'Knucklebustas', undefined, fighter.id);
    advanceFight(ctx, state);
    expect(aplOf(ctx, state, state.operatives[fighter.id]!)).toBe(2);
  });

  it('a Charge arms it too, and the grant survives the Ready step’s reset of actionsThisActivation', () => {
    expect(TANKED).toContain('performs either the Charge, Shoot or Fight action');
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    fighter.order = 'engage';
    fighter.actionsThisActivation = ['Charge'];
    state.activeOperativeId = fighter.id;
    expect(aplOf(ctx, state, fighter)).toBe(3);
    ctx.hooks.emit('onActivationEnd', state, { state, operative: fighter });
    fighter.actionsThisActivation = []; // what readyStep does
    expect(aplOf(ctx, state, fighter)).toBe(3);
  });

  it('"until the start of its next activation" — the grant is dropped when it activates again', () => {
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [fighter.id, foe.id]);
    place(state, fighter.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    let s = activate(ctx, state, fighter.id, 'engage');
    s = settle(ctx, act(ctx, s, fighter.id, 'Fight', { targetId: foe.id }).state);
    expect(aplOf(ctx, s, s.operatives[fighter.id]!)).toBe(3);
    s = reduce(s, { t: 'EndActivation', operativeId: fighter.id }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[fighter.id]!)).toBe(3); // still, between activations
    s.operatives[fighter.id]!.ready = true;
    s = activate(ctx, s, fighter.id, 'engage');
    expect(aplOf(ctx, s, s.operatives[fighter.id]!)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('WAAAGH!: "Friendly WRECKA KREW operatives’ melee weapons have the Balanced weapon rule."', () => {
    expect(ruleText(SP_WAAAGH)).toContain('melee weapons have the Balanced weapon rule');
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const hammer = profileOf(FIGHTER, 'Smash hammer');
    expect(rulesFor(ctx, state, fighter, hammer, 'Smash hammer').some((r) => r.id === 'Balanced')).toBe(false);
    state.teams.p1.gambitsUsedTP.push(SP_WAAAGH);
    expect(rulesFor(ctx, state, fighter, hammer, 'Smash hammer').some((r) => r.id === 'Balanced')).toBe(true);
    // Ranged weapons are untouched.
    const launcha = profileOf(GUNNER, 'Rokkit launcha');
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    expect(rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha').some((r) => r.id === 'Balanced')).toBe(false);
  });

  it('DESTRUCTION: "Friendly WRECKA KREW operatives’ ranged weapons have the Saturate weapon rule."', () => {
    expect(ruleText(SP_DESTRUCTION)).toContain('ranged weapons have the Saturate weapon rule');
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const launcha = profileOf(GUNNER, 'Rokkit launcha');
    expect(rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha').some((r) => r.id === 'Saturate')).toBe(false);
    state.teams.p1.gambitsUsedTP.push(SP_DESTRUCTION);
    expect(rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha').some((r) => r.id === 'Saturate')).toBe(true);
  });

  it('TUFF GITZ: an Engage-order defender is offered one defence-dice re-roll', () => {
    expect(ruleText(SP_TUFF_GITZ)).toContain('you can re-roll one of your defence dice');
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    state.teams.p1.gambitsUsedTP.push(SP_TUFF_GITZ);
    const seq = shootFixture({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Rokkit launcha',
      step: 'defenceRerolls',
    });
    state.sequence = seq;
    const emit = (order: 'engage' | 'conceal') => {
      target.order = order;
      return ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, target, profileOf(GUNNER, 'Rokkit launcha'), 'Rokkit launcha'),
        count: 0,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls;
    };
    expect(emit('engage').map((g) => g.id)).toContain('wrecka-krew.tuffGitz');
    expect(emit('conceal').map((g) => g.id)).not.toContain('wrecka-krew.tuffGitz');
  });

  it('AMPED UP: "can immediately regain up to D3+1 lost wounds (roll separately for each)"', () => {
    expect(ruleText(SP_AMPED_UP)).toContain('regain up to D3+1 lost wounds');
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 6, 6, 6, 6] }); // every D3 is 3
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const krusha = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    for (const op of aliveOperatives(state, 'p1')) op.order = 'conceal';
    fighter.order = 'engage';
    fighter.wounds = 2;
    krusha.order = 'conceal';
    krusha.wounds = 2;
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    nob.order = 'engage';
    nob.wounds = 13; // only 1 lost — "up to" caps the heal
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: SP_AMPED_UP, kind: 'strategy' });
    expect(fighter.wounds).toBe(6); // 2 + (3+1)
    expect(nob.wounds).toBe(14); // capped at the wounds actually lost
    expect(krusha.wounds).toBe(2); // Conceal order — no heal
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('JUST A SCRATCH ignores one attack dice’s Normal Dmg, once per turning point, never a BOMB SQUIG', () => {
    expect(ruleText(FP_JUST_A_SCRATCH)).toContain(
      'when an attack dice inflicts Normal Dmg on a friendly WRECKA KREW operative (excluding BOMB SQUIG)',
    );
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const foe = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    place(state, victim.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    state.teams.p1.ploysUsedTP.push(FP_JUST_A_SCRATCH);
    const seq = fightFixture({
      attackerId: foe.id,
      defenderId: victim.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Smash hammer',
      defenderWeapon: 'Knucklebustas',
      step: 'resolve',
    });
    state.sequence = seq;
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, profileOf(FIGHTER, 'Smash hammer').dmgN, 'attack');
    expect(victim.wounds).toBe(before); // the whole Normal Dmg is ignored
    inflictDamage(ctx, state, victim, profileOf(FIGHTER, 'Smash hammer').dmgN, 'attack');
    expect(victim.wounds).toBe(before - 5); // once per turning point
  });

  it('PROPPA SCRAP: "that operative can perform two FIGHT actions"', () => {
    expect(ruleText(FP_PROPPA_SCRAP)).toContain('that operative can perform two FIGHT actions');
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [fighter.id, foe.id]);
    place(state, fighter.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    foe.wounds = 40;
    fighter.wounds = 40;
    state.teams.p1.cp = 5;
    let s = activate(ctx, state, fighter.id, 'engage');
    const def = getAction(PROPPA_SCRAP_FIGHT)!;
    expect(def.check(ctx, s, s.operatives[fighter.id]!, {}).ok).toBe(false); // ploy not used
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP_PROPPA_SCRAP }, ctx).state;
    s = settle(ctx, act(ctx, s, fighter.id, 'Fight', { targetId: foe.id }).state);
    const second = act(ctx, s, fighter.id, PROPPA_SCRAP_FIGHT, { targetId: foe.id });
    s = settle(ctx, second.state);
    expect(second.ok).toBe(true);
    expect(s.operatives[fighter.id]!.actionsThisActivation).toEqual(['Fight', PROPPA_SCRAP_FIGHT]);
    expect(s.rejected).toHaveLength(0);
  });

  it('PROPPA SCRAP is only usable during a friendly BREAKA BOY or BOSS NOB activation', () => {
    const { ctx, state } = setup();
    const ploy = wreckaKrew.ploys.find((p) => p.id === FP_PROPPA_SCRAP)!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false);
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const s1 = activate(ctx, state, gunner.id, 'engage');
    expect(ploy.usable!(s1, 'p1').ok).toBe(false); // TANKBUSTA, not BREAKA BOY
    const krusha = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const s2 = activate(ctx, state, krusha.id, 'engage');
    expect(ploy.usable!(s2, 'p1').ok).toBe(true);
  });

  it('DEMOLITION JOB places its marker on the last Shoot/Fight target and hands out a FREE Wrecka spend within 3"', () => {
    expect(ruleText(FP_DEMOLITION_JOB)).toContain('you can spend a Wrecka point for free (even if you have none)');
    const { ctx, state } = setup({ script: [4, 4, 4, 4, 4, 4, 1, 1, 1, 1] });
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [gunner.id, foe.id]);
    place(state, gunner.id, 10, 10);
    place(state, foe.id, 16, 10);
    foe.wounds = 40;
    state.teams.p1.cp = 5;
    let s = activate(ctx, state, gunner.id, 'engage');
    s = settle(ctx, act(ctx, s, gunner.id, 'Shoot', { weaponName: '’Eavy rokkit launcha', targetId: foe.id }).state);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP_DEMOLITION_JOB }, ctx).state;
    const marker = s.markers[DEMOLITION_MARKER('p1')]!;
    expect(marker).toBeDefined();
    expect(marker.pos).toEqual(s.operatives[foe.id]!.pos);

    // Nothing held, but the enemy is within 3" of the marker, so one fail is still converted.
    expect(wreckaPoints(s, 'p1')).toBeGreaterThanOrEqual(0);
    bucket(s, 'wrecka-krew.points')['p1'] = 0;
    const nob = s.operatives[opWith(s, 'p1', BOSS_NOB)]!;
    const seq = shootFixture({
      attackerId: nob.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit pistol',
      attack: pool([1, 2, 3], 5),
    });
    s.sequence = seq;
    rulesFor(ctx, s, nob, profileOf(BOSS_NOB, 'Rokkit pistol'), 'Rokkit pistol', s.operatives[foe.id]!);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(1);
    expect(wreckaPoints(s, 'p1')).toBe(0);
  });

  it('DEMOLITION JOB: "In the Ready step of the next Strategy phase, remove that marker."', () => {
    expect(ruleText(FP_DEMOLITION_JOB)).toContain('In the Ready step of the next Strategy phase, remove that marker.');
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    bucket(state, 'wrecka-krew.lastAttack')['p1'] = {
      targetId: foe.id,
      stamp: `${state.turningPoint}:${state.activationsThisTP}:`,
    };
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP_DEMOLITION_JOB, kind: 'firefight' });
    expect(state.markers[DEMOLITION_MARKER('p1')]).toBeDefined();
    readyStep(ctx, state); // same turning point — the marker stays
    expect(state.markers[DEMOLITION_MARKER('p1')]).toBeDefined();
    state.turningPoint += 1;
    readyStep(ctx, state);
    expect(state.markers[DEMOLITION_MARKER('p1')]).toBeUndefined();
  });

  it('KABOOM! adds 1" to Blast and Severe against the primary target only', () => {
    expect(ruleText(FP_KABOOM)).toContain('add 1" to that weapon’s Blast and it has the Severe weapon rule');
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    state.activeOperativeId = gunner.id;
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP_KABOOM, kind: 'firefight' });
    const launcha = profileOf(GUNNER, 'Rokkit launcha');
    const primary = rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe);
    expect(primary.find((r) => r.id === 'Blast')!.x).toBe(2);
    expect(primary.some((r) => r.id === 'Severe')).toBe(true);
    state.sequence = shootFixture({
      attackerId: gunner.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit launcha',
      secondary: true,
      step: 'rollAttack',
    });
    const secondary = rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe);
    expect(secondary.find((r) => r.id === 'Blast')!.x).toBe(2);
    expect(secondary.some((r) => r.id === 'Severe')).toBe(false);
  });

  it('"Note that Severe doesn’t generate a Wrecka point (as it’s not a 6)" — the gain reads the DICE VALUE', () => {
    expect(ruleText(FP_KABOOM)).toContain('Note that Severe doesn’t generate a Wrecka point (as it’s not a 6).');
    const { ctx, state } = setup();
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const seq = shootFixture({
      attackerId: nob.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Rokkit pistol',
      attack: pool([5, 5, 1], 5),
    });
    // A 5 promoted to a critical success by Severe is still a 5.
    seq.attack.dice[0]!.state = 'crit';
    seq.attack.dice[0]!.note = 'Severe';
    state.sequence = seq;
    rulesFor(ctx, state, nob, profileOf(BOSS_NOB, 'Rokkit pistol'), 'Rokkit pistol', foe);
    expect(wreckaPoints(state, 'p1')).toBe(0);
  });

  it('KABOOM! is only usable before that operative’s Shoot action and needs a Blast weapon', () => {
    const { ctx, state } = setup();
    const ploy = wreckaKrew.ploys.find((p) => p.id === FP_KABOOM)!;
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    expect(ploy.usable!(activate(ctx, state, fighter.id, 'engage'), 'p1').ok).toBe(false); // no ranged weapon
    const s = activate(ctx, state, gunner.id, 'engage');
    expect(ploy.usable!(s, 'p1').ok).toBe(true);
    s.operatives[gunner.id]!.actionsThisActivation = ['Shoot'];
    expect(ploy.usable!(s, 'p1').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('DRILL ROKKITS: the weapon "loses the Blast weapon rule but has the Piercing 1 weapon rule"', () => {
    expect(ruleText(EQ_DRILL_ROKKITS)).toContain('loses the Blast weapon rule but has the Piercing 1 weapon rule');
    const { ctx, state } = setup({ equipment: [EQ_DRILL_ROKKITS] });
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [gunner.id, foe.id]);
    place(state, gunner.id, 10, 10);
    place(state, foe.id, 16, 10);
    const launcha = profileOf(GUNNER, 'Rokkit launcha');
    const rules = rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe);
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: { ...attackCtx(gunner, foe, launcha, 'Rokkit launcha'), rules },
      allowed: true,
      dryRun: false,
    });
    const after = rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe);
    expect(after.some((r) => r.id === 'Blast')).toBe(false);
    expect(after.find((r) => r.id === 'Piercing')!.x).toBe(1);
  });

  it('DRILL ROKKITS never claims its once-per-turning-point allowance on a dry run (D-032)', () => {
    const { ctx, state } = setup({ equipment: [EQ_DRILL_ROKKITS] });
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [gunner.id, foe.id]);
    place(state, gunner.id, 10, 10);
    place(state, foe.id, 16, 10);
    const launcha = profileOf(GUNNER, 'Rokkit launcha');
    const rules = rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe);
    for (let i = 0; i < 5; i++)
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: { ...attackCtx(gunner, foe, launcha, 'Rokkit launcha'), rules },
        allowed: true,
        dryRun: true,
      });
    expect(rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe).some((r) => r.id === 'Blast')).toBe(true);
  });

  it('"You cannot use this ploy and the Drill Rokkits rule during the same action" — KABOOM! locks it out', () => {
    expect(ruleText(FP_KABOOM)).toContain('You cannot use this ploy and the Drill Rokkits rule during the same action.');
    const { ctx, state } = setup({ equipment: [EQ_DRILL_ROKKITS] });
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [gunner.id, foe.id]);
    place(state, gunner.id, 10, 10);
    place(state, foe.id, 16, 10);
    state.activeOperativeId = gunner.id;
    ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: FP_KABOOM, kind: 'firefight' });
    const launcha = profileOf(GUNNER, 'Rokkit launcha');
    const rules = rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe);
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: { ...attackCtx(gunner, foe, launcha, 'Rokkit launcha'), rules },
      allowed: true,
      dryRun: false,
    });
    expect(rulesFor(ctx, state, gunner, launcha, 'Rokkit launcha', foe).some((r) => r.id === 'Blast')).toBe(true);
  });

  it('DRILL ROKKITS names only a rokkit launcha or an ’eavy rokkit launcha', () => {
    expect(ruleText(EQ_DRILL_ROKKITS)).toContain('you select a rokkit launcha or ’eavy rokkit launcha');
    expect(isDrillRokkit('Rokkit launcha')).toBe(true);
    expect(isDrillRokkit('’Eavy rokkit launcha')).toBe(true);
    expect(isDrillRokkit('Rokkit rack')).toBe(false);
    expect(isDrillRokkit('Pulsa rokkit')).toBe(false);
  });

  it('ENGINE OIL: "you can ignore any changes to that operative’s stats from being injured"', () => {
    expect(ruleText(EQ_ENGINE_OIL)).toContain('ignore any changes to that operative’s stats from being injured');
    const { ctx, state } = setup({ equipment: [EQ_ENGINE_OIL] });
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    fighter.wounds = 3; // injured (fewer than half of 12)
    const hammer = profileOf(FIGHTER, 'Smash hammer');
    expect(moveOf(ctx, state, fighter)).toBe(4);
    expect(hitOf(ctx, state, fighter, hammer)).toBe(4);
    const s = activate(ctx, state, fighter.id, 'engage');
    const live = s.operatives[fighter.id]!;
    expect(moveOf(ctx, s, live)).toBe(6);
    expect(hitOf(ctx, s, live, hammer)).toBe(3);
    // "Once per turning point": a second injured operative's activation gets nothing.
    const krusha = s.operatives[opWith(s, 'p1', KRUSHA)]!;
    krusha.wounds = 3;
    ctx.hooks.emit('onActivationStart', s, { state: s, operative: krusha });
    expect(moveOf(ctx, s, krusha)).toBe(4);
  });

  it('EXTRA ARMOUR: −1" Move and +1 Save, "This excludes BOMB SQUIG operatives"', () => {
    expect(ruleText(EQ_EXTRA_ARMOUR)).toContain(
      'Subtract 1" from the Move stat of friendly WRECKA KREW operatives and improve their Save stat by 1',
    );
    const { ctx, state } = setup({ equipment: [EQ_EXTRA_ARMOUR] });
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    expect(moveOf(ctx, state, fighter)).toBe(5);
    expect(saveOf(ctx, state, fighter)).toBe(3);
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    expect(moveOf(ctx, state, squig)).toBe(6);
    expect(saveOf(ctx, state, squig)).toBe(5);
    // The opponent has not taken the equipment.
    expect(saveOf(ctx, state, state.operatives[opWith(state, 'p2', FIGHTER)]!)).toBe(4);
  });

  it('EXTRA ARMOUR "isn’t cumulative with the Protective rule of a Portable Barricade"', () => {
    expect(ruleText(EQ_EXTRA_ARMOUR)).toContain(
      'isn’t cumulative with the Protective rule of a Portable Barricade from universal equipment',
    );
    const { ctx, state } = setup({ equipment: [EQ_EXTRA_ARMOUR] });
    const target = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const barricade: TerrainFeature = {
      id: 'p1.barricade',
      kind: 'equipment.portableBarricade',
      owner: 'p1',
      placement: { x: 0, y: 0, rotDeg: 0, flip: false },
      parts: [],
    };
    state.placedFeatures.push(barricade);
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: { ...attackCtx(shooter, target, profileOf(GUNNER, 'Rokkit launcha'), 'Rokkit launcha'), inCover: true },
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { ...zeroStatMods(), save: 1 }, // the barricade's Protective +1
      rerolls: [],
    });
    expect(ev.mods.save).toBe(0); // EXTRA ARMOUR's own +1 rides onStatMod, so only one applies
    expect(saveOf(ctx, state, target)).toBe(3);
  });

  it('GLYPHS names the first of Waaagh!/Destruction used, refunds it, then needs a Wrecka point', () => {
    expect(ruleText(EQ_GLYPHS)).toContain(
      'The first time you would use that ploy during the battle, it costs you 0CP; whenever you would use it thereafter, it costs you 0CP if you have any Wrecka points.',
    );
    const { ctx, state } = setup({ equipment: [EQ_GLYPHS] });
    const use = (id: string): void => {
      state.teams.p1.cp -= 1;
      ctx.hooks.emit('onPloyUsed', state, { state, player: 'p1', ployId: id, kind: 'strategy' });
    };
    state.teams.p1.cp = 5;
    use(SP_WAAAGH);
    expect(state.teams.p1.cp).toBe(5); // 1CP charged, 1CP refunded
    use(SP_DESTRUCTION);
    expect(state.teams.p1.cp).toBe(4); // a different ploy — no discount
    use(SP_WAAAGH);
    expect(state.teams.p1.cp).toBe(3); // no Wrecka points held
    gainWreckaPoints(state, 'p1', 1, 'test');
    use(SP_WAAAGH);
    expect(state.teams.p1.cp).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('WRECKA BOSS NOB', () => {
  it('Wrecka Boss: "Whenever this operative performs the Shoot or Fight action … you gain 1 Wrecka point"', () => {
    const text = abilityText(BOSS_NOB, 'wrecka-krew.boss-nob.wrecka-boss');
    expect(text).toContain('you gain 1 Wrecka point');
    // Six normal successes (5+), no 6s and no fails: the only point is the Wrecka Boss's own.
    const { ctx, state } = setup({ script: [5, 5, 5, 5, 5, 5, 6, 6, 6] });
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [nob.id, foe.id]);
    place(state, nob.id, 10, 10);
    place(state, foe.id, 14, 10);
    foe.wounds = 40;
    let s = activate(ctx, state, nob.id, 'engage');
    const out = act(ctx, s, nob.id, 'Shoot', { weaponName: 'Rokkit pistol', targetId: foe.id });
    s = settle(ctx, out.state);
    expect(out.ok).toBe(true);
    expect(wreckaPoints(s, 'p1')).toBe(1);
    // One point for the action itself; a Blast secondary must not pay a second time.
    expect(s.log.filter((e) => e.text.includes('Wrecka Boss'))).toHaveLength(1);
  });

  it('Salvo: the second primary is queued IN FRONT of the Blast secondaries, deduplicated', () => {
    const text = abilityText(BOSS_NOB, AB_SALVO);
    expect(text).toContain('Select up to two different valid targets');
    expect(text).toContain('Each target (primary and secondary) cannot be shot more than once during the action.');
    const { ctx, state } = setup();
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const a = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const b = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    const c = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [nob.id, a.id, b.id, c.id]);
    place(state, nob.id, 10, 10);
    place(state, a.id, 14, 10);
    place(state, b.id, 14, 14);
    place(state, c.id, 15.4, 14); // inside b's Blast 1"
    // The printed leader options are "Rokkit pistol; smash hammer" OR "Two rokkit pistols; choppa".
    (state.opState['loadout'] as Record<string, string[]>)[nob.id] = ['Two rokkit pistols', 'Choppa'];
    const profile = profileOf(BOSS_NOB, 'Two rokkit pistols', 'salvo');
    const seq = shootFixture({
      attackerId: nob.id,
      targetId: a.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Two rokkit pistols',
      profileName: 'salvo',
      step: 'rollAttack',
    });
    state.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: { ...attackCtx(nob, a, profile, 'Two rokkit pistols'), rules: profile.rules },
      count: profile.atk,
      mods: zeroStatMods(),
    });
    expect(seq.queue[0]).toBe(b.id); // the second PRIMARY first
    expect(seq.queue).toContain(c.id); // then its Blast secondary
    expect(new Set(seq.queue).size).toBe(seq.queue.length);
    expect(seq.queue).not.toContain(a.id);
  });
});

// ---------------------------------------------------------------------------
describe('WRECKA BOMB SQUIG', () => {
  it('Stoopid: the action ban and "you cannot select Conceal"', () => {
    const text = abilityText(BOMB_SQUIG, AB_STOOPID);
    expect(text).toContain('This operative cannot perform any actions other than Charge, Dash, Fight, Reposition and Shoot.');
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const s = activate(ctx, state, squig.id, 'conceal');
    expect(s.operatives[squig.id]!.order).toBe('engage');
    const offered = availableActions(ctx, s, s.operatives[squig.id]!);
    const guard = offered.find((a) => a.def.id === 'Pick Up Marker');
    expect(guard?.ok).toBe(false);
    expect(offered.find((a) => a.def.id === EXPLOSIVE_SHOOT)?.ok).toBe(true);
  });

  it('Explosive: "this operative is always the primary target and cannot be in cover or obscured"', () => {
    const text = abilityText(BOMB_SQUIG, AB_EXPLOSIVE);
    expect(text).toContain('this operative is always the primary target and cannot be in cover or obscured');
    const { ctx, state } = setup({ script: [1, 1, 1, 1, 1, 1, 6, 6, 6] });
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [squig.id, foe.id]);
    place(state, squig.id, 10, 10);
    place(state, foe.id, 10.9, 10); // engaged — the universal Shoot would refuse
    let s = activate(ctx, state, squig.id, 'engage');
    const out = act(ctx, s, squig.id, EXPLOSIVE_SHOOT, {});
    s = settle(ctx, out.state);
    expect(out.ok).toBe(true);
    expect(s.log.some((e) => e.text.includes(`${squig.letter} shoots ${squig.letter}`))).toBe(true);
    expect(s.rejected).toHaveLength(0);
  });

  it('the point-blank Hit penalty is cancelled, because Explosive does not print one', () => {
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const profile = profileOf(BOMB_SQUIG, 'Explosives');
    state.sequence = shootFixture({
      attackerId: squig.id,
      targetId: squig.id,
      attacker: 'p1',
      defender: 'p1',
      weaponName: 'Explosives',
      pointBlank: true,
      step: 'rollAttack',
    });
    // hitOf's `extraHitMod` of -1 is what shoot.ts passes for a point-blank shot.
    expect(hitOf(ctx, state, squig, profile, -1)).toBe(profile.hit);
  });

  it('the universal Shoot refuses the explosives against anybody but the bearer', () => {
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [squig.id, foe.id]);
    place(state, squig.id, 10, 10);
    place(state, foe.id, 14, 10);
    const s = activate(ctx, state, squig.id, 'engage');
    const check = getAction('Shoot')!.check(ctx, s, s.operatives[squig.id]!, {
      weaponName: 'Explosives',
      targetId: foe.id,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('always the primary target');
  });

  it('Boom!: "roll one D6, or two D6 if you wish. If any result is a 4+" — Blast damage, then removal', () => {
    const text = abilityText(BOMB_SQUIG, AB_BOOM);
    expect(text).toContain('If any result is a 4+');
    const { ctx, state } = setup({ script: [1, 5] });
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [squig.id, foe.id]);
    place(state, squig.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    const before = foe.wounds;
    inflictDamage(ctx, state, squig, 99, 'other');
    expect(squig.incapacitated).toBe(true);
    expect(foe.wounds).toBe(before - profileOf(BOMB_SQUIG, 'Explosives').dmgN);
  });

  it('Boom! does not fire "in a battle in which it hasn’t used its explosives" once they are used', () => {
    const { ctx, state } = setup({ script: [6, 6] });
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [squig.id, foe.id]);
    place(state, squig.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    squig.weaponUses['Explosives'] = 1;
    const before = foe.wounds;
    inflictDamage(ctx, state, squig, 99, 'other');
    expect(foe.wounds).toBe(before);
  });

  it('Expendable is op scoring — reported reminder-only, with the reason recorded next to the rule', () => {
    expect(abilityText(BOMB_SQUIG, AB_EXPENDABLE)).toContain('ignored for your opponent’s kill/elimination op');
    expect(REMINDER_ONLY[AB_EXPENDABLE]).toContain('src/core/ops/**');
  });
});

// ---------------------------------------------------------------------------
describe('BREAKA BOY DEMOLISHA', () => {
  it('Reckless Temperament: Normal Dmg of 4+ inflicts 1 less; the Critical half needs an Engage order', () => {
    const text = abilityText(DEMOLISHA, 'wrecka-krew.breaka-boy-demolisha.reckless-temperament');
    expect(text).toContain('Normal Dmg of 4 or more inflicts 1 less damage on this operative');
    const { ctx, state } = setup();
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHA)]!;
    const foe = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    place(state, demo.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    const hammer = profileOf(FIGHTER, 'Smash hammer'); // 5/6
    state.sequence = fightFixture({
      attackerId: foe.id,
      defenderId: demo.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Smash hammer',
      defenderWeapon: 'Tankhammer',
      step: 'resolve',
    });
    demo.order = 'conceal';
    demo.wounds = 12;
    inflictDamage(ctx, state, demo, hammer.dmgN, 'attack');
    expect(demo.wounds).toBe(12 - (hammer.dmgN - 1));
    // Critical Dmg with a Conceal order is untouched…
    demo.wounds = 12;
    inflictDamage(ctx, state, demo, hammer.dmgC, 'attack');
    expect(demo.wounds).toBe(12 - hammer.dmgC);
    // …and reduced with an Engage order.
    demo.order = 'engage';
    demo.wounds = 12;
    inflictDamage(ctx, state, demo, hammer.dmgC, 'attack');
    expect(demo.wounds).toBe(12 - (hammer.dmgC - 1));
  });

  it('Reckless Temperament counts a shoot per unblocked attack dice', () => {
    const { ctx, state } = setup();
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHA)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const launcha = profileOf(GUNNER, '’Eavy rokkit launcha'); // 4/5
    const seq = shootFixture({
      attackerId: shooter.id,
      targetId: demo.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: '’Eavy rokkit launcha',
      step: 'resolve',
      attack: pool([6, 5, 5, 1], 4),
    });
    state.sequence = seq;
    demo.order = 'engage';
    demo.wounds = 40;
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
    const raw = crits * launcha.dmgC + normals * launcha.dmgN;
    inflictDamage(ctx, state, demo, raw, 'attack');
    expect(demo.wounds).toBe(40 - (raw - crits - normals));
  });

  it('Detonate: D6+6 on a normal success, everything in the struck operative’s control range, and the action ends', () => {
    const text = abilityText(DEMOLISHA, AB_DETONATE);
    expect(text).toContain('inflict D6+6 damage on that enemy operative and each other operative within its control range');
    expect(text).toContain('Then the action ends and you gain 1 Wrecka point');
    // 4 attack dice for the Demolisha (a 3 is a normal success at 3+, and not a 6), 3 for the
    // retaliating Fists, then one D6 per victim.
    const { ctx, state } = setup({ script: [3, 1, 1, 1, 1, 1, 1, 2, 2, 2] });
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHA)]!;
    const foe = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const bystander = state.operatives[opWith(state, 'p2', ROKKITEER)]!;
    isolate(state, [demo.id, foe.id, bystander.id]);
    place(state, demo.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    place(state, bystander.id, 12.8, 10); // within the target's control range
    for (const op of [demo, foe, bystander]) op.wounds = 40;
    let s = activate(ctx, state, demo.id, 'engage');
    const out = act(ctx, s, demo.id, 'Fight', {
      targetId: foe.id,
      meleeWeaponName: 'Tankhammer',
      meleeProfileName: 'detonate',
    });
    s = settle(ctx, out.state);
    expect(out.ok).toBe(true);
    expect(s.operatives[foe.id]!.wounds).toBe(40 - (2 + 6));
    expect(s.operatives[bystander.id]!.wounds).toBe(40 - (2 + 6));
    expect(s.operatives[demo.id]!.wounds).toBe(40 - (2 + 6)); // it is inside the target's control range too
    expect(wreckaPoints(s, 'p1')).toBeGreaterThanOrEqual(1);
    expect(s.sequence).toBeNull();
    expect(s.rejected).toHaveLength(0);
  });

  it('Detonate: "or 2D6+6 damage if it’s a critical success"', () => {
    // A 6 is always a critical success; two D6 follow, one roll per victim.
    const { ctx, state } = setup({ script: [6, 1, 1, 1, 1, 1, 1, 4, 5] });
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHA)]!;
    const foe = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [demo.id, foe.id]);
    place(state, demo.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    foe.wounds = 40;
    demo.wounds = 40;
    let s = activate(ctx, state, demo.id, 'engage');
    s = settle(
      ctx,
      act(ctx, s, demo.id, 'Fight', {
        targetId: foe.id,
        meleeWeaponName: 'Tankhammer',
        meleeProfileName: 'detonate',
      }).state,
    );
    expect(s.operatives[foe.id]!.wounds).toBe(40 - (4 + 5 + 6));
  });

  it('Detonate is "the first time … during the battle" — a second detonate strike explodes nothing', () => {
    const { ctx, state } = setup({ script: [3, 1, 1, 1, 1, 1, 1, 2, 2, 3, 1, 1, 1, 1, 1, 1] });
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHA)]!;
    const foe = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [demo.id, foe.id]);
    place(state, demo.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    foe.wounds = 60;
    demo.wounds = 60;
    let s = activate(ctx, state, demo.id, 'engage');
    const fight = { targetId: foe.id, meleeWeaponName: 'Tankhammer', meleeProfileName: 'detonate' };
    s = settle(ctx, act(ctx, s, demo.id, 'Fight', fight).state);
    const after = s.operatives[foe.id]!.wounds;
    expect(after).toBeLessThan(60);
    s.operatives[demo.id]!.actionsThisActivation = [];
    s = settle(ctx, act(ctx, s, demo.id, 'Fight', fight).state);
    // The profile's own Dmg is 0/0, so without the rule the second strike inflicts nothing.
    expect(s.operatives[foe.id]!.wounds).toBe(after);
  });

  it('Detonate damage "cannot be ignored or reduced" — the restore is the LAST onDamage handler in the tree', () => {
    expect(abilityText(DEMOLISHA, AB_DETONATE)).toContain(
      'Damage from this weapon rule cannot be ignored or reduced.',
    );
    const { ctx, state } = setup({ script: [3, 1, 1, 1, 1, 1, 1, 1, 3, 3] });
    const demo = state.operatives[opWith(state, 'p1', DEMOLISHA)]!;
    const otherDemo = state.operatives[opWith(state, 'p2', DEMOLISHA)]!;
    isolate(state, [demo.id, otherDemo.id]);
    place(state, demo.id, 10, 10);
    place(state, otherDemo.id, 11.4, 10);
    otherDemo.order = 'engage';
    demo.wounds = 40;
    otherDemo.wounds = 40;
    state.teams.p2.ploysUsedTP.push(FP_JUST_A_SCRATCH);
    let s = activate(ctx, state, demo.id, 'engage');
    s = settle(
      ctx,
      act(ctx, s, demo.id, 'Fight', {
        targetId: otherDemo.id,
        meleeWeaponName: 'Tankhammer',
        meleeProfileName: 'detonate',
      }).state,
    );
    expect(s.operatives[otherDemo.id]!.wounds).toBe(40 - (3 + 6));

    // …and a rule that DOES reduce it is undone: the restore binds at priority 99, above every
    // other onDamage handler in the tree.
    ctx.hooks.on(
      'onDamage',
      { id: 'test.greedyReduction', sourceText: 'a rule that zeroes any damage', priority: 90 },
      (ev) => {
        ev.amount = 0;
      },
    );
    bucket(s, 'wrecka-krew.detonateDamage')[otherDemo.id] = { amount: 9, player: 'p1' };
    const before = s.operatives[otherDemo.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[otherDemo.id]!, 9, 'other');
    expect(s.operatives[otherDemo.id]!.wounds).toBe(before - 9);
    // Without the marker the same handler wins, which is what makes the restore a real seam.
    delete bucket(s, 'wrecka-krew.detonateDamage')[otherDemo.id];
    inflictDamage(ctx, s, s.operatives[otherDemo.id]!, 9, 'other');
    expect(s.operatives[otherDemo.id]!.wounds).toBe(before - 9);
  });
});

// ---------------------------------------------------------------------------
describe('BREAKA BOY KRUSHA', () => {
  it('Armoured Up: "your opponent cannot retain attack dice results of less than 6 as critical successes"', () => {
    const text = abilityText(KRUSHA, AB_ARMOURED_UP);
    expect(text).toContain('cannot retain attack dice results of less than 6 as critical successes');
    const { ctx, state } = setup();
    const krusha = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    const other = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const profile: WeaponProfile = {
      type: 'ranged',
      atk: 4,
      hit: 4,
      dmgN: 3,
      dmgC: 4,
      rules: [
        { id: 'Lethal', x: 5, raw: 'Lethal 5+' },
        { id: 'Rending', raw: 'Rending' },
        { id: 'Severe', raw: 'Severe' },
      ],
    };
    const vsKrusha = rulesFor(ctx, state, shooter, profile, 'test gun', krusha).map((r) => r.id);
    expect(vsKrusha).not.toContain('Lethal');
    expect(vsKrusha).not.toContain('Rending');
    expect(vsKrusha).not.toContain('Severe');
    const vsOther = rulesFor(ctx, state, shooter, profile, 'test gun', other).map((r) => r.id);
    expect(vsOther).toContain('Lethal');
  });

  it('Armoured Up is live while the KRUSHA is fighting or retaliating too (both sequences emit onWeaponRules)', () => {
    const { ctx, state } = setup();
    const krusha = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const foe = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    place(state, krusha.id, 10, 10);
    place(state, foe.id, 11.2, 10);
    const melee: WeaponProfile = {
      type: 'melee',
      atk: 4,
      hit: 3,
      dmgN: 4,
      dmgC: 5,
      rules: [
        { id: 'Brutal', raw: 'Brutal' },
        { id: 'Lethal', x: 5, raw: 'Lethal 5+' },
        { id: 'Severe', raw: 'Severe' },
      ],
    };
    // The KRUSHA is the defender (retaliating): `sideWeapon` passes it as the attacker's `target`.
    const retaliating = effectiveRules(ctx, state, melee, {
      operative: foe,
      target: krusha,
      weaponName: 'test hammer',
      retaliating: false,
    }).map((r) => r.id);
    expect(retaliating).toEqual(['Brutal']);
    // The KRUSHA is the defender of a fight it started: still its opponent's weapon.
    const fighting = effectiveRules(ctx, state, melee, {
      operative: foe,
      target: krusha,
      weaponName: 'test hammer',
      retaliating: true,
    }).map((r) => r.id);
    expect(fighting).toEqual(['Brutal']);
    // …and the KRUSHA's own weapon is untouched.
    const seq = fightFixture({
      attackerId: foe.id,
      defenderId: krusha.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Smash hammer',
      defenderWeapon: 'Knucklebustas',
    });
    state.sequence = seq;
    expect(sideWeapon(ctx, state, seq, 'defender').rules.map((r) => r.id)).toEqual(['Brutal', 'Shock', 'Smash']);
  });

  it('Smash: "move the enemy operative … up to 1"… Then move this operative … within that enemy operative’s control range"', () => {
    const text = abilityText(KRUSHA, AB_SMASH);
    expect(text).toContain('it must end the move further away from this operative');
    const { ctx, state } = setup();
    const krusha = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const foe = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    isolate(state, [krusha.id, foe.id]);
    place(state, krusha.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    const plan = planSmash(ctx, state, krusha, foe)!;
    expect(plan).toBeDefined();
    expect(plan.inches).toBe(1);
    expect(plan.foePos.x).toBeCloseTo(12.4, 5);
    expect(plan.selfPos.x).toBeCloseTo(11, 5);
  });

  it('Smash fires on the strike, through the Knucklebustas’ own weapon rule', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1] });
    const krusha = state.operatives[opWith(state, 'p1', KRUSHA)]!;
    const foe = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [krusha.id, foe.id]);
    place(state, krusha.id, 10, 10);
    place(state, foe.id, 11.4, 10);
    foe.wounds = 60;
    let s = activate(ctx, state, krusha.id, 'engage');
    s = settle(ctx, act(ctx, s, krusha.id, 'Fight', { targetId: foe.id, meleeWeaponName: 'Knucklebustas' }).state);
    expect(s.operatives[foe.id]!.pos.x).toBeGreaterThan(11.4);
    expect(s.log.some((e) => e.text.includes('Smash:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('TANKBUSTA GUNNER and ROKKITEER', () => {
  it('Kompetitive Streak: "if this operative shoots an enemy operative that another friendly operative has already shot"', () => {
    const text = abilityText(GUNNER, AB_KOMPETITIVE);
    expect(text).toContain('you gain 1 Wrecka point');
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const profile = profileOf(GUNNER, 'Rokkit launcha');
    const collect = (shooter: OperativeState, targetId: string): void => {
      const seq = shootFixture({
        attackerId: shooter.id,
        targetId,
        attacker: 'p1',
        defender: 'p2',
        weaponName: 'Rokkit launcha',
        step: 'rollAttack',
      });
      state.sequence = seq;
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: { ...attackCtx(shooter, state.operatives[targetId]!, profile, 'Rokkit launcha'), rules: profile.rules },
        count: profile.atk,
        mods: zeroStatMods(),
      });
    };
    collect(gunner, foe.id);
    const afterFirst = wreckaPoints(state, 'p1');
    collect(nob, foe.id); // the BOSS NOB's own ability pays here
    bucket(state, 'wrecka-krew.points')['p1'] = afterFirst;
    collect(gunner, foe.id);
    expect(wreckaPoints(state, 'p1')).toBe(afterFirst + 1);
  });

  it('Kompetitive Streak "can include any secondary targets when doing so (e.g. from the Blast weapon rule)"', () => {
    expect(abilityText(GUNNER, AB_KOMPETITIVE)).toContain(
      'but you can include any secondary targets when doing so (e.g. from the Blast weapon rule)',
    );
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const nob = state.operatives[opWith(state, 'p1', BOSS_NOB)]!;
    const shotAlready = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    const primary = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const profile = profileOf(GUNNER, '’Eavy rokkit launcha');
    const collect = (shooter: OperativeState, seq: ShootSequence): void => {
      state.sequence = seq;
      ctx.hooks.emit('onCollectAttackDice', state, {
        state,
        ctx: {
          ...attackCtx(shooter, state.operatives[seq.targetId]!, profile, '’Eavy rokkit launcha'),
          rules: profile.rules,
        },
        count: profile.atk,
        mods: zeroStatMods(),
      });
    };
    // The BOSS NOB shoots the FIGHTER first…
    collect(
      nob,
      shootFixture({
        attackerId: nob.id,
        targetId: shotAlready.id,
        attacker: 'p1',
        defender: 'p2',
        weaponName: '’Eavy rokkit launcha',
        step: 'rollAttack',
      }),
    );
    bucket(state, 'wrecka-krew.points')['p1'] = 0;
    // …and the GUNNER then shoots someone else with the FIGHTER only as a Blast SECONDARY.
    collect(
      gunner,
      shootFixture({
        attackerId: gunner.id,
        targetId: primary.id,
        attacker: 'p1',
        defender: 'p2',
        weaponName: '’Eavy rokkit launcha',
        step: 'rollAttack',
        queue: [shotAlready.id],
      }),
    );
    expect(wreckaPoints(state, 'p1')).toBe(1);
  });

  it('Pulsa: places the marker, "gains 1 additional Pulsa point for each success (to a maximum of 3)"', () => {
    const text = abilityText(ROKKITEER, AB_PULSA);
    expect(text).toContain('to a maximum of 3 additional points');
    // 6 attack dice at 5+: four successes → capped at +3; then a D3 per victim.
    const { ctx, state } = setup({ script: [6, 6, 6, 5, 1, 1, 2, 2, 2, 2] });
    const rokkiteer = state.operatives[opWith(state, 'p1', ROKKITEER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [rokkiteer.id, foe.id]);
    place(state, rokkiteer.id, 10, 10);
    place(state, foe.id, 16, 10);
    foe.wounds = 30;
    let s = activate(ctx, state, rokkiteer.id, 'engage');
    const out = act(ctx, s, rokkiteer.id, PULSA_SHOOT, { markerPos: { x: 16, y: 10 } });
    s = settle(ctx, out.state);
    expect(out.ok).toBe(true);
    const marker = s.markers[PULSA_MARKER('p1')]!;
    expect(pulsaPoints(marker)).toBe(4);
    expect(s.operatives[foe.id]!.wounds).toBeLessThan(30);
    expect(s.rejected).toHaveLength(0);
  });

  it('Pulsa damages every operative WHOLLY within x" of the marker and nobody else', () => {
    expect(abilityText(ROKKITEER, AB_PULSA)).toContain('inflict D3 damage on each operative wholly within x"');
    const { ctx, state } = setup();
    const inside = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    const outside = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    const marker = {
      id: PULSA_MARKER('p1'),
      kind: 'generic' as const,
      diameterMm: 20,
      pos: { x: 12, y: 10 },
      z: 0,
      owner: 'p1' as PlayerId,
      flags: { pulsaPoints: 2 },
    };
    const base = DATA.datacards.find((c) => c.id === KRUSHA)!.base;
    place(state, inside.id, 13.5, 10); // centre 1.5" away + 0.63 base − 0.39 marker = 1.74 ≤ 2
    place(state, outside.id, 14.5, 10); // 2.74 > 2
    expect(whollyWithinMarker(inside, base, marker, 2)).toBe(true);
    expect(whollyWithinMarker(outside, base, marker, 2)).toBe(false);
  });

  it('the pulsa rokkit is never fired through the universal Shoot action ("Don’t select a valid target")', () => {
    expect(abilityText(ROKKITEER, AB_PULSA)).toContain('Don’t select a valid target');
    const { ctx, state } = setup();
    const rokkiteer = state.operatives[opWith(state, 'p1', ROKKITEER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [rokkiteer.id, foe.id]);
    place(state, rokkiteer.id, 10, 10);
    place(state, foe.id, 16, 10);
    const s = activate(ctx, state, rokkiteer.id, 'engage');
    const check = getAction('Shoot')!.check(ctx, s, s.operatives[rokkiteer.id]!, {
      weaponName: 'Pulsa rokkit',
      targetId: foe.id,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('Pulsa');
  });

  it('Shokkwave: "subtract 2" from its Move stat and worsen the Hit stat of its weapons by 1" within x"', () => {
    const text = abilityText(ROKKITEER, AB_SHOKKWAVE);
    expect(text).toContain('This is cumulative with being injured.');
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p2', FIGHTER)]!;
    place(state, victim.id, 10, 10);
    state.markers[PULSA_MARKER('p1')] = {
      id: PULSA_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 12, y: 10 },
      z: 0,
      owner: 'p1',
      flags: { pulsaPoints: 3 },
    };
    const hammer = profileOf(FIGHTER, 'Smash hammer');
    expect(moveOf(ctx, state, victim)).toBe(4);
    expect(hitOf(ctx, state, victim, hammer)).toBe(4);
    // Move it out of the ring.
    place(state, victim.id, 20, 10);
    expect(moveOf(ctx, state, victim)).toBe(6);
    expect(hitOf(ctx, state, victim, hammer)).toBe(3);
  });

  it('Shokkwave: "In the Ready step of each Strategy phase, subtract 1… If a Pulsa marker ever has 0 points, remove it."', () => {
    const { ctx, state } = setup();
    state.markers[PULSA_MARKER('p1')] = {
      id: PULSA_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 12, y: 10 },
      z: 0,
      owner: 'p1',
      flags: { pulsaPoints: 2 },
    };
    readyStep(ctx, state);
    expect(pulsaPoints(state.markers[PULSA_MARKER('p1')])).toBe(1);
    readyStep(ctx, state);
    expect(state.markers[PULSA_MARKER('p1')]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('BREAK STUFF (the team’s only unique action)', () => {
  const equipmentFeature = (id: string, x: number, y: number): TerrainFeature => ({
    id,
    kind: 'equipment.lightBarricade',
    owner: 'p2',
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      {
        id: `${id}.body`,
        featureId: id,
        poly: rect(x, y, 2, 0.4),
        z0: 0,
        z1: 1,
        types: ['Light'],
        role: 'equipment',
      },
    ],
  });

  it('"If it’s an equipment terrain feature, remove it."', () => {
    expect(actionOf(FIGHTER, ACT_BREAK_STUFF).text).toContain('If it’s an equipment terrain feature, remove it.');
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    isolate(state, [fighter.id]);
    place(state, fighter.id, 10, 10);
    state.placedFeatures.push(equipmentFeature('p2.barricade', 10.7, 9.9));
    let s = activate(ctx, state, fighter.id, 'engage');
    const out = act(ctx, s, fighter.id, ACT_BREAK_STUFF, {});
    s = out.state;
    expect(out.ok).toBe(true);
    expect(s.terrainState['p2.barricade.body']?.removed).toBe(true);
    expect(s.rejected).toHaveLength(0);
  });

  it('otherwise it places a Breach marker within its control range', () => {
    expect(actionOf(FIGHTER, ACT_BREAK_STUFF).text).toContain('place one of your Breach markers');
    const map = testMap({ features: [heavyBlock('ruin', 11, 9, 3, 3)] });
    const { ctx, state } = setup({ map });
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    isolate(state, [fighter.id]);
    place(state, fighter.id, 10.4, 10);
    let s = activate(ctx, state, fighter.id, 'engage');
    const out = act(ctx, s, fighter.id, ACT_BREAK_STUFF, {});
    s = out.state;
    expect(out.ok).toBe(true);
    const marker = Object.values(s.markers).find((m) => m.id.startsWith('wrecka-krew.breach.p1.'));
    expect(marker).toBeDefined();
    expect(marker!.flags['featureId']).toBe('ruin');
  });

  it('refuses while engaged, and when no terrain feature is within control range', () => {
    expect(actionOf(FIGHTER, ACT_BREAK_STUFF).text).toContain(
      'cannot perform this action while within control range of an enemy operative, or if a terrain feature isn’t within its control range',
    );
    const map = testMap({ features: [heavyBlock('ruin', 11, 9, 3, 3)] });
    const { ctx, state } = setup({ map });
    const fighter = state.operatives[opWith(state, 'p1', FIGHTER)]!;
    const foe = state.operatives[opWith(state, 'p2', KRUSHA)]!;
    isolate(state, [fighter.id, foe.id]);
    place(state, fighter.id, 4, 4);
    place(state, foe.id, 24, 4);
    expect(planBreakStuff(ctx, state, fighter, {}).ok).toBe(false);
    place(state, fighter.id, 10.4, 10);
    expect(planBreakStuff(ctx, state, fighter, {}).ok).toBe(true);
    place(state, foe.id, 11.3, 10.9);
    expect(planBreakStuff(ctx, state, fighter, {}).reason).toContain('control range of an enemy operative');
  });

  it('its "treats … as Accessible terrain" grant is reminder-only, with the engine reason recorded', () => {
    expect(actionOf(FIGHTER, ACT_BREAK_STUFF).text).toContain('as Accessible terrain');
    expect(REMINDER_ONLY[`${ACT_BREAK_STUFF}.accessible`]).toContain('no runtime type override');
  });
});

// ---------------------------------------------------------------------------
describe('Honest coverage', () => {
  it('names every clause that has no honest expression on the hook surface, with its engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).sort()).toEqual(
      [
        AB_EXPENDABLE,
        `${AB_STOOPID}.weapons`,
        `${ACT_BREAK_STUFF}.accessible`,
        `${FP_DEMOLITION_JOB}.timing`,
        `${EQ_GLYPHS}.cost`,
      ].sort(),
    );
    for (const reason of Object.values(REMINDER_ONLY)) expect(reason.length).toBeGreaterThan(20);
  });

  it('"It cannot use any weapons that aren’t on its datacard" is a no-op by construction — nothing grants one', () => {
    expect(abilityText(BOMB_SQUIG, AB_STOOPID)).toContain('It cannot use any weapons that aren’t on its datacard.');
    expect(REMINDER_ONLY[`${AB_STOOPID}.weapons`]).toContain('grantedWeapons');
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', BOMB_SQUIG)]!;
    // No rule in this kill team grants a weapon, so the ban currently bites on nothing.
    expect(weaponsOf(ctx, state, squig).map((w) => w.name).sort()).toEqual(['Bite', 'Explosives']);
  });
});

// ---------------------------------------------------------------------------
describe('AI hints', () => {
  it('names a role for every datacard, a value for all 8 ploys and all 4 equipment options', () => {
    const hints = wreckaKrew.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual([...ALL_ROLES].sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual(wreckaKrew.ploys.map((p) => p.id).sort());
    for (const v of Object.values(hints.ployValue!)) expect(v).toBeGreaterThan(0);
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
  });

  it('a whole activation of every datacard produces no rejected intents (every unique action, no params)', () => {
    const { ctx, state } = setup({ seed: 3 });
    let s = state;
    const spread: Vec2[] = [
      { x: 8, y: 4 },
      { x: 8, y: 7 },
      { x: 8, y: 10 },
      { x: 8, y: 13 },
      { x: 8, y: 16 },
      { x: 6, y: 5 },
      { x: 6, y: 8 },
      { x: 6, y: 11 },
    ];
    s.teams.p1.operativeIds.forEach((id, i) => {
      const p = spread[i % spread.length]!;
      place(s, id, p.x, p.y);
    });
    s.teams.p2.operativeIds.forEach((id, i) => place(s, id, 22, 3 + i * 2));
    for (const id of s.teams.p1.operativeIds) {
      s = activate(ctx, s, id, 'engage');
      const op = s.operatives[id]!;
      for (const a of availableActions(ctx, s, op).filter((x) => x.ok && x.def.type === 'unique')) {
        const out = act(ctx, s, id, a.def.id, {});
        if (out.ok) s = settle(ctx, out.state);
      }
      s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    }
    expect(s.rejected.map((r) => r.reason)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('WRECKA KREW bot-vs-bot soak (zero rejected intents)', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full mirror game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const map = mapById(mapId);
      const ctx = createGameContext({
        rng: new SeededRng(41),
        datacards: wreckaKrew.datacards,
        maps: [map],
        teams: [wreckaKrew],
      });
      for (const eq of wreckaKrew.equipmentDefs) ctx.equipment.set(eq.id, eq);
      const roster = defaultRoster(wreckaKrew.data).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 41,
        critOpId: 'crit.secure',
        rosters: {
          p1: { teamId: wreckaKrew.id, operatives: roster, equipment: wreckaKrew.equipment.slice(0, 4).map((e) => e.id) },
          p2: { teamId: wreckaKrew.id, operatives: roster, equipment: wreckaKrew.equipment.slice(0, 2).map((e) => e.id) },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
    }, 60_000);
  }
});
