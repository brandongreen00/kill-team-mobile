/**
 * HEARTHKYN SALVAGERS. Every test quotes the printed rule it pins, read out of
 * `data/teams/hearthkyn-salvager.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/hearthkyn-salvager/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addAutoNormal, addRolled, newPool, successes, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import {
  aliveOperatives,
  apBudgetOf,
  aplOf,
  freeApOf,
  hitOf,
  inflictDamage,
  markerController,
  statMods,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/hearthkyn-salvager.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  ATTACK_MARKER,
  DEFENCE_MARKER,
  DOZR,
  EXCAVATION_PICK_UP,
  FIELD_MEDIC,
  FLY_CHARGE,
  FLY_REPOSITION,
  GRENADIER,
  GRENADIER_SMOKE,
  GRUDGE_TOKEN,
  GUNNER,
  JUMP_PACK_WARRIOR,
  KINLYNK,
  KNUX_CHARGE,
  KOGNITAAR,
  LOKATR,
  LUGGER,
  PLASMA_KNIVES,
  REMINDER_ONLY,
  RULE_GRUDGE,
  SCAN_MARKER,
  SPOT_TOKEN,
  SYSTEM_JAM_TOKEN,
  THEYN,
  WARRIOR,
  beamVictims,
  effectiveGrudge,
  giveGrudge,
  grudgeTokens,
  hearthkynSalvager,
  placeTacticianMarker,
} from '../../src/teams/hearthkyn-salvager/index.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import { act, activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('hearthkyn-salvager');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

/** Ten of the eleven datacards fit in a kill team; the rest are swapped in where a rule needs them. */
const ROLES = [
  THEYN,
  DOZR,
  FIELD_MEDIC,
  GRENADIER,
  GUNNER,
  JUMP_PACK_WARRIOR,
  KINLYNK,
  KOGNITAAR,
  LOKATR,
  LUGGER,
];

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
  const ctx = teamContext([hearthkynSalvager], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = rosterIncluding(hearthkynSalvager, opts.roles ?? ROLES);
  const state = battle({
    ctx,
    p1: { module: hearthkynSalvager, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: hearthkynSalvager, picks },
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

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function shootSeq(over: Partial<ShootSequence> & Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>): ShootSequence {
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
describe('HEARTHKYN SALVAGER data (pinned against data/teams/hearthkyn-salvager.json)', () => {
  it('has 11 datacards, all APL 2 / Save 3+ on 28mm bases, W 8 bar the 9-wound THEYN', () => {
    expect(DATA.datacards).toHaveLength(11);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 2, save: 3, base: { shape: 'round', mm: 28 } });
      expect(card.keywords).toContain('HEARTHKYN SALVAGER');
      expect(card.keywords).toContain('LEAGUES OF VOTANN');
    }
    expect(DATA.datacards.find((c) => c.id === THEYN)).toMatchObject({ wounds: 9, move: 5 });
    expect(DATA.datacards.filter((c) => c.wounds !== 8).map((c) => c.id)).toEqual([THEYN]);
    // "Whenever this operative performs an action in which it moves, it can FLY." — M 8".
    expect(DATA.datacards.filter((c) => c.move !== 5).map((c) => c.id)).toEqual([JUMP_PACK_WARRIOR]);
    expect(DATA.datacards.find((c) => c.id === JUMP_PACK_WARRIOR)!.move).toBe(8);
  });

  it('exposes 1 faction rule, 4+4 ploys, 4 equipment options, 12 abilities and 8 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Grudge']);
    expect(hearthkynSalvager.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(hearthkynSalvager.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(hearthkynSalvager.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(12);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(8);
    // Every unique action is priced at 1AP on the page, and the scraper flagged nothing.
    expect(new Set(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.ap))).toEqual(new Set([1]));
    expect(NOTES).toEqual([]);
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(THEYN, 'Concussion gauntlet')).toMatchObject({ atk: 4, hit: 4, dmgN: 5, dmgC: 7 });
    expect(profileOf(THEYN, 'Concussion gauntlet').rules.map((r) => r.id)).toEqual(['Brutal', 'Shock']);
    expect(profileOf(DOZR, 'Concussion knux')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 4 });
    expect(profileOf(FIELD_MEDIC, 'Plasma Knife')).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 5 });
    // Magna rail rifle: Critical Dmg BELOW Normal Dmg, which is how KT24 prints a Devastating gun.
    expect(profileOf(GUNNER, 'Magna rail rifle')).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 2 });
    expect(profileOf(GUNNER, 'Magna rail rifle').rules.map((r) => r.id)).toEqual(['Devastating', 'Heavy', 'Piercing']);
    const rotary = DATA.datacards.find((c) => c.id === GUNNER)!.weapons.find((w) => w.name === 'HYLas rotary cannon')!;
    expect(rotary.profiles.map((p) => p.name)).toEqual(['focused', 'sweeping']);
    expect(profileOf(GRENADIER, 'C8 HX charge').rules.map((r) => r.id)).toEqual([
      'Range',
      'Blast',
      'Heavy',
      'Limited',
      'Piercing',
      'Saturate',
    ]);
  });

  it('the two rare weapon rules are Beam (EtaCarn plasma beamer) and Force Impact (plasma weapon)', () => {
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['Beam', 'ForceImpact']);
    expect(profileOf(GUNNER, 'EtaCarn plasma beamer').rules.map((r) => r.raw)).toEqual(['Piercing 1', 'Beam*']);
    expect(profileOf(JUMP_PACK_WARRIOR, 'Plasma weapon').rules.map((r) => r.raw)).toEqual([
      'Lethal 5+',
      'Force Impact*',
    ]);
    // D-033: the rare rule resolves against THIS team's own datacard ability, not the registry.
    expect(rareWeaponRuleText('Beam', 'hearthkyn-salvager')).toBe(abilityText(GUNNER, 'hearthkyn-salvager.gunner.beam'));
    expect(rareWeaponRuleText('ForceImpact', 'hearthkyn-salvager')).toBe(
      abilityText(JUMP_PACK_WARRIOR, 'hearthkyn-salvager.jump-pack-warrior.force-impact'),
    );
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('(this takes precedence over the core rules).')).toBe(true);
    // The raw committed bytes still carry the overrun — this is the data problem, not the module.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
  });

  it('DATA PROBLEM: SPOT’s printed effect list is truncated out of the JSON', () => {
    const spot = actionOf(LOKATR, 'hearthkyn-salvager.lok-tr.act.spot');
    expect(spot.text).toContain('you can use this effect. If you do:');
    // Nothing follows the colon except the action's own restriction line.
    const after = spot.text.split('If you do:')[1]!.trim();
    expect(after).toBe('This operative cannot perform this action while within control range of an enemy operative.');
    expect(REMINDER_ONLY['hearthkyn-salvager.lok-tr.act.spot']).toContain('truncated');
  });

  it('DATA PROBLEM: the PLASMA KNIVES equipment weapon parses with rules: [] — the module recovers Lethal 5+', () => {
    const raw = (rawJson as { equipment: { id: string; weapons?: { profiles: { rules: unknown[] }[] }[] }[] }).equipment.find(
      (e) => e.id === 'hearthkyn-salvager.eq.plasma-knives',
    )!;
    expect(raw.weapons![0]!.profiles[0]!.rules).toEqual([]);
    expect(ruleText('hearthkyn-salvager.eq.plasma-knives')).toContain('Lethal 5+');
    // Sliced back out of the printed WR row rather than retyped.
    expect(PLASMA_KNIVES.profiles[0]).toMatchObject({ atk: 3, hit: 4, dmgN: 3, dmgC: 5 });
    expect(PLASMA_KNIVES.profiles[0]!.rules).toEqual([{ id: 'Lethal', x: 5, raw: 'Lethal 5+' }]);
  });
});

// ---------------------------------------------------------------------------
describe('HEARTHKYN SALVAGER selection', () => {
  it('prints uniqueExcept, "up to three GUNNER operatives" and "(each must have a different option)"', () => {
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['GUNNER', 'WARRIOR'] },
      { kind: 'maxCount', role: 'GUNNER', max: 3 },
      { kind: 'distinctOptions', role: 'GUNNER' },
    ]);
    expect(DATA.selection.rawText).toContain(
      'Your kill team can only include up to three GUNNER operatives (each must have a different option).',
    );
  });

  it('defaultRoster is a legal 10-operative kill team with three GUNNERs on three different options', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(10);
    expect(picks[0]!.datacardId).toBe(THEYN);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    const gunners = picks.filter((p) => p.datacardId === GUNNER);
    expect(gunners).toHaveLength(3);
    expect(new Set(gunners.map((g) => g.loadoutIds?.[0]))).toHaveLength(3);
  });

  /**
   * The printed exemption is "Other than GUNNER and WARRIOR operatives"; the list prints WARRIOR
   * and JUMP PACK WARRIOR as two different rows, and the JUMP PACK WARRIOR datacard does NOT carry
   * the WARRIOR keyword. `validateRosterFor`'s `uniqueExcept` matches space-separated ROLE tokens
   * (D-037), which reads "JUMP PACK WARRIOR" as exempt — see the report. Only the data facts are
   * pinned here, so a fix in the shared validator does not have to touch this test.
   */
  it('WARRIOR and JUMP PACK WARRIOR are two different rows, and only one of them has the WARRIOR keyword', () => {
    const roles = DATA.selection.list.map((e) => e.role);
    expect(roles).toContain('WARRIOR');
    expect(roles).toContain('JUMP PACK WARRIOR');
    expect(DATA.datacards.find((c) => c.id === WARRIOR)!.keywords).toContain('WARRIOR');
    expect(DATA.datacards.find((c) => c.id === JUMP_PACK_WARRIOR)!.keywords).not.toContain('WARRIOR');
    expect(DATA.selection.rawText).toContain(
      'Other than GUNNER and WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
  });

  it('the shared validator enforces the GUNNER cap (maxCount) and distinctOptions', () => {
    const base = defaultRoster(DATA).filter((p) => p.datacardId !== GUNNER);
    const gunner = { datacardId: GUNNER, entryId: 'hearthkyn-salvager.sel4.gunner' };
    const four = validateRosterFor(DATA, [
      ...base,
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt1'] },
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt2'] },
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt3'] },
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt4'] },
    ]);
    expect(four.codes).toContain('maxCount');
    const sameOption = validateRosterFor(DATA, [
      ...base,
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt1'] },
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt1'] },
      { ...gunner, loadoutIds: ['hearthkyn-salvager.g2e4.opt3'] },
    ]);
    expect(sameOption.codes).toContain('distinctOptions');
  });
});

// ---------------------------------------------------------------------------
describe('Grudge — "Whenever an enemy operative incapacitates a friendly HEARTHKYN SALVAGER operative, that enemy operative gains one of your Grudge tokens for the battle"', () => {
  it('the killer gains a token, and a second kill stacks it (the marker guide prints values 1 & 2)', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const killer = state.operatives[opWith(state, 'p2', DOZR)]!;
    isolate(state, [victim.id, killer.id]);
    place(state, victim.id, 10, 10);
    place(state, killer.id, 10.6, 10);
    expect(startFight(ctx, state, killer, 'Concussion knux', undefined, victim.id).ok).toBe(true);
    // The fight is not resolved; the incapacitation is driven directly so the killer is known.
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(grudgeTokens(state, killer.id, 'p1')).toBe(1);
    const second = state.operatives[opWith(state, 'p1', KINLYNK)]!;
    place(state, second.id, 10.4, 10.4);
    inflictDamage(ctx, state, second, 99, 'attack');
    expect(grudgeTokens(state, killer.id, 'p1')).toBe(2);
    expect(ruleText(RULE_GRUDGE)).toContain('gains one of your Grudge tokens for the battle');
  });

  it('"you can retain one of your normal successes as a critical success instead" — one per token, when shooting', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    giveGrudge(state, foe, 'p1');
    giveGrudge(state, foe, 'p1');
    const profile = profileOf(LUGGER, 'Autoch-pattern bolter');
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autoch-pattern bolter',
      attack: pool([4, 4, 4, 2], 4),
    });
    effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Autoch-pattern bolter' });
    const dice = (state.sequence as ShootSequence).attack.dice;
    expect(dice.filter((d) => d.state === 'crit')).toHaveLength(2);
    expect(dice.filter((d) => d.state === 'normal')).toHaveLength(1);
    // Re-entering the retention step after a decision promotes nothing further.
    effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Autoch-pattern bolter' });
    expect(dice.filter((d) => d.state === 'crit')).toHaveLength(2);
  });

  it('and when fighting AND retaliating — `onWeaponRules` is emitted by both sides of a fight', () => {
    const { ctx, state } = setup();
    const attacker = state.operatives[opWith(state, 'p2', DOZR)]!;
    const defender = state.operatives[opWith(state, 'p1', THEYN)]!;
    isolate(state, [attacker.id, defender.id]);
    place(state, attacker.id, 10, 10);
    place(state, defender.id, 10.6, 10);
    giveGrudge(state, attacker, 'p1'); // the retaliating THEYN holds a grudge against its attacker
    expect(startFight(ctx, state, attacker, 'Concussion knux', undefined, defender.id).ok).toBe(true);
    const seq = state.sequence as FightSequence;
    seq.attackerPool = pool([5, 3, 2], 3);
    seq.defenderPool = pool([4, 4, 2], 4);
    seq.step = 'retention';
    advanceFight(ctx, state);
    // The THEYN is the DEFENDER, so its promotion is the retaliating half of the printed rule.
    expect(seq.defenderPool.dice.filter((d) => d.note === 'Grudge')).toHaveLength(1);
    expect(seq.attackerPool.dice.filter((d) => d.note === 'Grudge')).toHaveLength(0);
  });

  it('obscured takes precedence: a Grudge token cannot promote a normal success', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    giveGrudge(state, foe, 'p1');
    const profile = profileOf(LUGGER, 'Autoch-pattern bolter');
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autoch-pattern bolter',
      attack: pool([4, 4], 4),
      obscured: true,
    });
    effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Autoch-pattern bolter' });
    expect((state.sequence as ShootSequence).attack.dice.every((d) => d.state === 'normal')).toBe(true);
  });

  it('"(including any normal successes already retained as a result of the Accurate weapon rule)"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    giveGrudge(state, foe, 'p1');
    const profile = profileOf(LUGGER, 'Autoch-pattern bolter'); // Accurate 1
    expect(profile.rules.map((r) => r.id)).toContain('Accurate');
    const attack = newPool();
    addAutoNormal(attack, 1, 'Accurate'); // the auto-retained, never-rolled success
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autoch-pattern bolter',
      attack,
    });
    effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Autoch-pattern bolter' });
    expect(attack.dice[0]).toMatchObject({ state: 'crit', rolled: false, note: 'Grudge' });
  });

  it('a Grudge token lasts "for the battle"', () => {
    const { state } = setup();
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    giveGrudge(state, foe, 'p1');
    const token = state.effects.find((e) => e.rule === GRUDGE_TOKEN && e.operativeId === foe.id)!;
    expect(token.expiry).toEqual({ kind: 'endOfBattle' });
    expect(token.player).toBe('p1');
    // …and it is the opponent's ledger only: p2 holds no Grudge against its own operative.
    expect(grudgeTokens(state, foe.id, 'p2')).toBe(0);
  });

  it('a friendly operative killed by its own team’s Blast hands out no Grudge token', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const shooter = state.operatives[opWith(state, 'p1', GRENADIER)]!;
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: victim.id,
      attacker: 'p1',
      defender: 'p1',
      weaponName: 'C8 HX charge',
    });
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(aliveOperatives(state, 'p2').every((o) => grudgeTokens(state, o.id, 'p1') === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('NEED KEEPS: "treat the total APL stat of friendly HEARTHKYN SALVAGER operatives that contest it as 1 higher"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const theirs = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [mine.id, theirs.id]);
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, mine.id, marker.pos.x - 0.8, marker.pos.y);
    place(state, theirs.id, marker.pos.x + 0.8, marker.pos.y);
    expect(markerController(ctx, state, marker)).toBeNull(); // APL 2 vs APL 2
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const out = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'hearthkyn-salvager.sp.need-keeps', data: { markerId: marker.id } },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(markerController(ctx, out.state, out.state.markers[marker.id]!)).toBe('p1');
  });

  it('NEED KEEPS: within 3" of that marker, +1 Atk on melee weapons — and Balanced when the weapon is already Atk 4', () => {
    const { ctx, state } = setup();
    const dozr = state.operatives[opWith(state, 'p1', DOZR)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, dozr.id, marker.pos.x + 1, marker.pos.y);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'hearthkyn-salvager.sp.need-keeps', data: { markerId: marker.id } },
      ctx,
    ).state;
    // Concussion knux is Atk 4 already → Balanced, not a fifth dice.
    const knux = profileOf(DOZR, 'Concussion knux');
    const rules = effectiveRules(ctx, s, knux, { operative: s.operatives[dozr.id]!, target: foe, weaponName: 'Concussion knux' });
    expect(rules.some((r) => r.id === 'Balanced')).toBe(true);
    const collected = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[dozr.id]!, foe, knux, 'Concussion knux', 'melee'),
      count: knux.atk,
      mods: zeroStatMods(),
    });
    expect(collected.count).toBe(4);
    // Fists are Atk 3 → the +1 applies instead.
    const fists = profileOf(LUGGER, 'Fists');
    const bumped = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[dozr.id]!, foe, fists, 'Fists', 'melee'),
      count: fists.atk,
      mods: zeroStatMods(),
    });
    expect(bumped.count).toBe(4);
    expect(ruleText('hearthkyn-salvager.sp.need-keeps')).toContain('(to a maximum of 4)');
  });

  it('WROUGHT DEFENCE: "if you rolled one or less successes … retain one of your fails as a normal success"', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const shooter = state.operatives[opWith(state, 'p2', LUGGER)]!;
    state.teams.p1.gambitsUsedTP.push('hearthkyn-salvager.sp.wrought-defence');
    state.teams.p1.cp = 0; // no Command Re-roll on offer, so this is the final defenceRerolls pass
    const profile = profileOf(LUGGER, 'Autoch-pattern bolter');
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autoch-pattern bolter',
      step: 'defenceRerolls',
      defence: pool([4, 2, 1], 3),
    });
    state.sequence = seq;
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Autoch-pattern bolter'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(successes(seq.defence)).toHaveLength(2);
    expect(seq.defence.dice.find((d) => d.note === 'Wrought Defence')!.value).toBe(2);
  });

  it('WROUGHT DEFENCE does nothing when two successes were already rolled', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const shooter = state.operatives[opWith(state, 'p2', LUGGER)]!;
    state.teams.p1.gambitsUsedTP.push('hearthkyn-salvager.sp.wrought-defence');
    state.teams.p1.cp = 0;
    const profile = profileOf(LUGGER, 'Autoch-pattern bolter');
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autoch-pattern bolter',
      step: 'defenceRerolls',
      defence: pool([4, 5, 1], 3),
    });
    state.sequence = seq;
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, profile, 'Autoch-pattern bolter'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(seq.defence.dice.some((d) => d.note === 'Wrought Defence')).toBe(false);
  });

  it('TOIL EARNS: "whenever an enemy operative is within 3" of that marker, treat it as having one additional Grudge token"', () => {
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, foe.id, marker.pos.x + 1, marker.pos.y);
    const T = hooksFor(ctx, 'p1');
    expect(effectiveGrudge(T, state, foe)).toBe(0);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'hearthkyn-salvager.sp.toil-earns', data: { markerId: marker.id } },
      ctx,
    ).state;
    expect(effectiveGrudge(hooksFor(ctx, 'p1'), s, s.operatives[foe.id]!)).toBe(1);
    // …and it stacks with a real token.
    giveGrudge(s, s.operatives[foe.id]!, 'p1');
    expect(effectiveGrudge(hooksFor(ctx, 'p1'), s, s.operatives[foe.id]!)).toBe(2);
  });

  it('PROXIMATE FIREPOWER: +1 Hit within 6", capped at 3+, and nothing beyond 6"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const theyn = state.operatives[opWith(state, 'p1', THEYN)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    place(state, shooter.id, 10, 10);
    place(state, theyn.id, 10, 12);
    place(state, foe.id, 14, 10);
    state.teams.p1.gambitsUsedTP.push('hearthkyn-salvager.sp.proximate-firepower');
    const bolter = profileOf(LUGGER, 'Autoch-pattern bolter'); // Hit 4+
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autoch-pattern bolter',
      step: 'rollAttack',
    });
    expect(hitOf(ctx, state, shooter, bolter)).toBe(3);
    place(state, foe.id, 20, 10); // more than 6" away
    expect(hitOf(ctx, state, shooter, bolter)).toBe(4);
    // The THEYN's Autoch-pattern bolt pistol is already 3+ — "(to a maximum of 3+)" gives nothing.
    const pistol = profileOf(THEYN, 'Autoch-pattern bolt pistol');
    expect(pistol.hit).toBe(3);
    place(state, foe.id, 14, 12);
    state.sequence = shootSeq({
      attackerId: theyn.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autoch-pattern bolt pistol',
      step: 'rollAttack',
    });
    expect(hitOf(ctx, state, theyn, pistol)).toBe(3);
  });

  it('a ploy that names a marker takes it from the intent’s data, or a logged deterministic default (D-016)', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    for (const op of aliveOperatives(state, 'p1')) op.pos = { x: 21, y: 11 };
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'hearthkyn-salvager.sp.toil-earns' }, ctx);
    expect(out.ok).toBe(true);
    // The closest objective marker to the friendly kill team's centre is the p2 objective (22,11).
    const chosen = out.state.effects.find((e) => e.rule === 'hearthkyn-salvager.toilEarns')!;
    expect(out.state.markers[String(chosen.data!['markerId'])]!.pos).toEqual({ x: 22, y: 11 });
    expect(out.state.log.some((l) => l.text.includes('toil-earns'))).toBe(true);
  });

  it('all four strategy ploys are offered as STRATEGIC GAMBITs', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    state.teams.p1.cp = 6;
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    for (const ploy of DATA.strategyPloys) expect(ids).toContain(ploy.id);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('THE ANCESTORS ARE WATCHING: "that operative can perform either a free Shoot or a free Fight action"', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', LUGGER);
    let s = activate(ctx, state, op);
    s.teams.p1.cp = 3;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'hearthkyn-salvager.fp.the-ancestors-are-watching' }, ctx).state;
    const me = s.operatives[op]!;
    // "a FREE Shoot or a free Fight action" — D-100: free AP, not an APL stat change, so the APL
    // stat is untouched and the activation is one AP longer than the datacard.
    expect(me.aplMods).toEqual([]);
    expect(aplOf(ctx, s, me)).toBe(2);
    expect(freeApOf(s, me)).toBe(1);
    expect(apBudgetOf(ctx, s, me)).toBe(3);
    // Once its own AP is spent, the bonus AP is restricted to the two named actions.
    me.apSpent = 2;
    const actions = availableActions(ctx, s, me);
    expect(actions.find((a) => a.def.id === 'Reposition')!.reason).toBe('the free action must be Shoot or Fight');
    // And the third AP is genuinely there to spend: the reducer's AP gate reads `apBudgetOf`.
    expect(actions.find((a) => a.def.id === 'Shoot')!.reason).not.toBe('not enough AP');
    // "Until the end of THAT ACTIVATION" — and no further.
    const ended = reduce(s, { t: 'EndActivation', operativeId: op }, ctx).state;
    expect(freeApOf(ended, ended.operatives[op]!)).toBe(0);
    expect(apBudgetOf(ctx, ended, ended.operatives[op]!)).toBe(2);
    expect(ruleText('hearthkyn-salvager.fp.the-ancestors-are-watching')).toContain('free Shoot or a free Fight action');
  });

  it('STURDY: "change the attacker’s retained critical successes to normal successes", once, on the next shot only', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    state.teams.p1.cp = 3;
    const profile = profileOf(GUNNER, 'HYLas auto rifle');
    // "Use this firefight ploy WHEN an operative is shooting a friendly … operative" — the ploy's
    // own `usable` refuses it outside that window, so the sequence is set up first.
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: target.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'HYLas auto rifle',
      step: 'rollDefence',
      attack: pool([6, 6, 4, 1], 4),
    });
    const used = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hearthkyn-salvager.fp.sturdy' }, ctx);
    expect(used.ok).toBe(true);
    const s = used.state;
    const seq = s.sequence as ShootSequence;
    const emit = (): void => {
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(shooter, target, profile, 'HYLas auto rifle'),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      });
    };
    emit();
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(0);
    expect(seq.attack.dice.filter((d) => d.state === 'normal')).toHaveLength(3);
    // A second shot in the same turning point gets nothing: the ploy was consumed.
    seq.attack = pool([6, 6], 4);
    emit();
    expect(seq.attack.dice.filter((d) => d.state === 'crit')).toHaveLength(2);
  });

  it('ENGAGE TO ACQUIRE offers a re-roll-any only against an enemy that controls a marker', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [shooter.id, foe.id]);
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, shooter.id, 14, 4);
    place(state, foe.id, 25, 25);
    state.teams.p1.cp = 3;
    const profile = profileOf(LUGGER, 'Autoch-pattern bolter');
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Autoch-pattern bolter',
      step: 'attackRerolls',
    });
    const used = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hearthkyn-salvager.fp.engage-to-acquire' }, ctx);
    expect(used.ok).toBe(true);
    const s = used.state;
    const away = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(shooter, foe, profile, 'Autoch-pattern bolter'),
      dice: [],
      rerolls: [],
    });
    expect(away.rerolls).toHaveLength(0);
    // Now put the enemy in control of an objective marker.
    place(s, foe.id, marker.pos.x + 0.5, marker.pos.y);
    const on = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(shooter, s.operatives[foe.id]!, profile, 'Autoch-pattern bolter'),
      dice: [],
      rerolls: [],
    });
    expect(on.rerolls.map((r) => r.mode)).toEqual(['any']);
  });

  it('WORTH IT is reminder-only: it records the operative and applies nothing', () => {
    const { ctx, state } = setup();
    const dying = state.operatives[opWith(state, 'p1', LUGGER)]!;
    dying.incapacitated = true;
    state.teams.p1.cp = 3;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hearthkyn-salvager.fp.worth-it' }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'hearthkyn-salvager.worthIt' && e.operativeId === dying.id)).toBe(true);
    expect(dying.apSpent).toBe(0);
    expect(ruleText('hearthkyn-salvager.fp.worth-it')).toContain('free mission action before it’s removed');
    expect(REMINDER_ONLY['hearthkyn-salvager.fp.worth-it']).toContain('outside an activation');
  });

  it('every ploy has an aiHints value, or the AI never uses a firefight ploy', () => {
    const values = hearthkynSalvager.aiHints!.ployValue!;
    for (const ploy of hearthkynSalvager.ploys) expect(typeof values[ploy.id]).toBe('number');
    const eq = hearthkynSalvager.aiHints!.equipmentValue!;
    for (const item of hearthkynSalvager.equipment) expect(typeof eq[item.id]).toBe('number');
    const roles = hearthkynSalvager.aiHints!.roles!;
    for (const card of DATA.datacards) expect(roles[card.id]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  const EQ_KNIVES = 'hearthkyn-salvager.eq.plasma-knives';
  const EQ_TOOLS = 'hearthkyn-salvager.eq.excavation-tools';

  it('PLASMA KNIVES arms the kill team — but not the FIELD MEDIC, which "already has this weapon but with better stats"', () => {
    const { ctx, state } = setup({ equipment: [EQ_KNIVES] });
    const lugger = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const medic = state.operatives[opWith(state, 'p1', FIELD_MEDIC)]!;
    const s = activate(ctx, state, lugger.id);
    const names = (op: OperativeState): string[] =>
      ((op as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).map((w) => w.name);
    expect(names(s.operatives[lugger.id]!)).toContain('Plasma Knives');
    expect(names(s.operatives[medic.id]!)).not.toContain('Plasma Knives');
    expect(ruleText(EQ_KNIVES)).toContain('use the better version');
  });

  it('EXCAVATION TOOLS: Pick Up Marker for 1 less AP, and its own action that only needs to CONTEST the marker', () => {
    const { ctx, state } = setup({ equipment: [EQ_TOOLS] });
    const mine = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [mine.id, foe.id]);
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    marker.flags['pickUpAllowed'] = true;
    // Both contest the 40mm objective marker without being within each other's control range.
    place(state, mine.id, marker.pos.x - 2, marker.pos.y);
    place(state, foe.id, marker.pos.x + 2, marker.pos.y); // contested, so neither side controls it
    expect(markerController(ctx, state, marker)).toBeNull();
    expect(actionCost(ctx, state, mine, getAction('Pick Up Marker')!)).toBe(0);
    expect(getAction('Pick Up Marker')!.check(ctx, state, mine, { markerId: marker.id }).ok).toBe(false);
    expect(getAction(EXCAVATION_PICK_UP)!.check(ctx, state, mine, { markerId: marker.id }).ok).toBe(true);
    expect(ruleText(EQ_TOOLS)).toContain('they only need to contest the marker');
  });

  it('the Excavation Tools action is not offered without the equipment', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', LUGGER)]!;
    expect(getAction(EXCAVATION_PICK_UP)!.available!(ctx, state, mine)).toBe(false);
    expect(actionCost(ctx, state, mine, getAction('Pick Up Marker')!)).toBe(1);
  });

  it('CLIMBING RIGS and WRIT OF CLAIM are reminder-only, with the engine reason recorded', () => {
    expect(ruleText('hearthkyn-salvager.eq.climbing-rigs')).toContain('treat the vertical distance as 2"');
    expect(ruleText('hearthkyn-salvager.eq.writ-of-claim')).toContain('you can re-roll your dice');
    expect(REMINDER_ONLY['hearthkyn-salvager.eq.climbing-rigs']).toContain('onMoveRules');
    expect(REMINDER_ONLY['hearthkyn-salvager.eq.writ-of-claim']).toContain('rerollOffered');
  });
});

// ---------------------------------------------------------------------------
describe('THEYN abilities', () => {
  it('Eye of the Ancestors is a STRATEGIC GAMBIT that hands out one Grudge token', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain('hearthkyn-salvager.theyn.eye-of-the-ancestors');
    const foe = opWith(state, 'p2', LUGGER);
    const out = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'hearthkyn-salvager.theyn.eye-of-the-ancestors', data: { operativeId: foe } },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(grudgeTokens(out.state, foe, 'p1')).toBe(1);
    // A faction ability is not a ploy, so it costs no CP.
    expect(out.state.teams.p1.cp).toBe(state.teams.p1.cp);
  });

  it('"…or up to two enemy operatives if three or more friendly HEARTHKYN SALVAGER operatives are incapacitated"', () => {
    const { ctx, state } = setup();
    for (const id of state.teams.p1.operativeIds.slice(-3)) {
      const op = state.operatives[id]!;
      op.removed = true;
      op.incapacitated = true;
    }
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'hearthkyn-salvager.theyn.eye-of-the-ancestors' }, ctx);
    const marked = aliveOperatives(out.state, 'p2').filter((o) => grudgeTokens(out.state, o.id, 'p1') > 0);
    expect(marked).toHaveLength(2);
  });

  it('the gambit is not offered when the THEYN is not in the killzone ("if this operative is in the killzone")', () => {
    const { ctx, state } = setup();
    const theyn = state.operatives[opWith(state, 'p1', THEYN)]!;
    theyn.removed = true;
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain('hearthkyn-salvager.theyn.eye-of-the-ancestors');
  });

  it('Weavefield Crest ignores one normal success’s damage, once per battle', () => {
    const { ctx, state } = setup();
    const theyn = state.operatives[opWith(state, 'p1', THEYN)]!;
    const shooter = state.operatives[opWith(state, 'p2', GUNNER)]!;
    isolate(state, [theyn.id]); // no FIELD MEDIC within 3", so Medic! cannot fire instead
    place(state, theyn.id, 14, 4);
    // The first GUNNER's option is the EtaCarn plasma beamer: Normal Dmg 5.
    const profile = profileOf(GUNNER, 'EtaCarn plasma beamer');
    expect(profile.dmgN).toBe(5);
    const makeSeq = (): void => {
      state.sequence = shootSeq({
        attackerId: shooter.id,
        targetId: theyn.id,
        attacker: 'p2',
        defender: 'p1',
        weaponName: 'EtaCarn plasma beamer',
        step: 'resolve',
        attack: pool([4, 4], 4),
      });
    };
    makeSeq();
    inflictDamage(ctx, state, theyn, 10, 'attack');
    expect(theyn.wounds).toBe(9 - 5); // 10 damage, one normal success (5) ignored
    makeSeq();
    inflictDamage(ctx, state, theyn, 5, 'attack'); // "Once per battle" — nothing left to ignore
    expect(theyn.wounds).toBeLessThanOrEqual(0);
    expect(abilityText(THEYN, 'hearthkyn-salvager.theyn.weavefield-crest')).toContain('Once per battle');
  });
});

// ---------------------------------------------------------------------------
describe('DÔZR › Brawler', () => {
  it('"Enemy operatives cannot assist" — the assist Hit bonus is cancelled', () => {
    const { ctx, state } = setup();
    const dozr = state.operatives[opWith(state, 'p1', DOZR)]!;
    const attacker = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const helper = state.operatives[opWith(state, 'p2', KINLYNK)]!;
    isolate(state, [dozr.id, attacker.id, helper.id]);
    place(state, dozr.id, 10, 10);
    place(state, attacker.id, 10.6, 10);
    place(state, helper.id, 10, 10.6);
    expect(startFight(ctx, state, attacker, 'Fists', undefined, dozr.id).ok).toBe(true);
    const seq = state.sequence as FightSequence;
    expect(seq.attackerAssists).toBe(1);
    const mods = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(attacker, dozr, profileOf(LUGGER, 'Fists'), 'Fists', 'melee'),
      count: 3,
      mods: zeroStatMods(),
    });
    expect(mods.mods.hit).toBe(-1); // exactly cancels the +1 assist `rollSide` would apply
  });

  it('"Normal Dmg of 4 or more inflicts 1 less damage on it" in a fight', () => {
    const { ctx, state } = setup();
    const dozr = state.operatives[opWith(state, 'p1', DOZR)]!;
    const attacker = state.operatives[opWith(state, 'p2', THEYN)]!;
    isolate(state, [dozr.id, attacker.id]);
    place(state, dozr.id, 10, 10);
    place(state, attacker.id, 10.6, 10);
    expect(startFight(ctx, state, attacker, 'Concussion gauntlet', undefined, dozr.id).ok).toBe(true);
    const before = dozr.wounds;
    inflictDamage(ctx, state, dozr, 5, 'attack'); // the gauntlet's Normal Dmg is 5
    expect(before - dozr.wounds).toBe(4);
    expect(abilityText(DOZR, 'hearthkyn-salvager.d-zr.brawler')).toContain('Normal Dmg of 4 or more');
  });

  it('"If it’s incapacitated, you can strike the enemy operative in that sequence with one of your unresolved successes"', () => {
    const { ctx, state } = setup();
    const dozr = state.operatives[opWith(state, 'p1', DOZR)]!;
    const attacker = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [dozr.id, attacker.id]);
    place(state, dozr.id, 10, 10);
    place(state, attacker.id, 10.6, 10);
    expect(startFight(ctx, state, attacker, 'Fists', undefined, dozr.id).ok).toBe(true);
    const seq = state.sequence as FightSequence;
    seq.defenderPool = pool([6, 3], 3); // one critical success left unresolved
    const foeWounds = attacker.wounds;
    inflictDamage(ctx, state, dozr, 99, 'attack');
    expect(dozr.incapacitated).toBe(true);
    // Concussion knux Critical Dmg is 4.
    expect(foeWounds - attacker.wounds).toBe(4);
    expect(seq.defenderPool.dice.find((d) => d.note === 'Brawler')!.state).toBe('struck');
  });
});

// ---------------------------------------------------------------------------
describe('FIELD MEDIC › Medic! and MEDIKIT', () => {
  function medicPair(): { ctx: GameContext; state: GameState; medic: OperativeState; victim: OperativeState } {
    const { ctx, state } = setup();
    const medic = state.operatives[opWith(state, 'p1', FIELD_MEDIC)]!;
    const victim = state.operatives[opWith(state, 'p1', LUGGER)]!;
    isolate(state, [medic.id, victim.id]);
    place(state, medic.id, 10, 10);
    place(state, victim.id, 12, 10);
    return { ctx, state, medic, victim };
  }

  it('prevents the incapacitation, leaves 1 wound and subtracts 1 APL from both operatives', () => {
    const { ctx, state, medic, victim } = medicPair();
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(victim.incapacitated).toBe(false);
    expect(victim.wounds).toBe(1);
    expect(medic.aplMods).toContain(-1);
    expect(victim.aplMods).toContain(-1);
    // "After that action, that friendly operative can immediately perform a free Dash action."
    expect(state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === victim.id)).toBe(true);
  });

  it('is once per turning point, and does not fire while an enemy is within control range', () => {
    const { ctx, state, medic, victim } = medicPair();
    inflictDamage(ctx, state, victim, 99, 'attack');
    const second = state.operatives[opWith(state, 'p1', KINLYNK)]!;
    place(state, second.id, 11, 10);
    inflictDamage(ctx, state, second, 99, 'attack');
    expect(second.incapacitated).toBe(true);
    // …and with an enemy in control range it never fires at all.
    const { ctx: c2, state: s2, victim: v2 } = medicPair();
    const foe = s2.operatives[opWith(s2, 'p2', LUGGER)]!;
    place(s2, foe.id, 12.6, 10);
    inflictDamage(c2, s2, v2, 99, 'attack');
    expect(v2.incapacitated).toBe(true);
    void medic;
  });

  it('MEDIKIT restores 2D3 wounds and refuses an operative Medic! already saved this turning point', () => {
    const { ctx, state, medic, victim } = medicPair();
    victim.wounds = 2;
    const def = getAction('hearthkyn-salvager.field-medic.act.medikit')!;
    place(state, victim.id, 10.6, 10); // within control range
    expect(def.check(ctx, state, medic, { targetOperativeId: victim.id }).ok).toBe(true);
    let s = activate(ctx, state, medic.id);
    const out = act(ctx, s, medic.id, def.id, { targetOperativeId: victim.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[victim.id]!.wounds).toBeGreaterThan(2);
    // Now mark the victim as a Medic! save and the action must refuse it.
    s = out.state;
    (s.opState['hearthkyn-salvager.medicTarget'] as Record<string, string>) = { [medic.id]: victim.id };
    expect(def.check(ctx, s, s.operatives[medic.id]!, { targetOperativeId: victim.id }).ok).toBe(false);
    expect(actionOf(FIELD_MEDIC, def.id).text).toContain('regain up to 2D3 lost wounds');
  });
});

// ---------------------------------------------------------------------------
describe('GRENADIER', () => {
  it('"can use frag, krak, smoke and stun grenades" without the universal equipment', () => {
    const { ctx, state } = setup();
    const grenadier = state.operatives[opWith(state, 'p1', GRENADIER)]!;
    const s = activate(ctx, state, grenadier.id);
    const carried = (s.operatives[grenadier.id] as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(carried.map((w) => w.name).sort()).toEqual(['Frag grenade', 'Krak grenade']);
    // The universal Smoke Grenade action is gated on the equipment; the GRENADIER's own is not.
    expect(getAction('Smoke Grenade')!.available!(ctx, s, s.operatives[grenadier.id]!)).toBe(false);
    expect(getAction(GRENADIER_SMOKE)!.available!(ctx, s, s.operatives[grenadier.id]!)).toBe(true);
    expect(getAction(GRENADIER_SMOKE)!.check(ctx, s, s.operatives[grenadier.id]!, { targetPos: { x: grenadier.pos.x + 2, y: grenadier.pos.y } }).ok).toBe(true);
  });

  it('"Whenever this operative is using a frag or krak grenade, improve the Hit stat of that weapon by 1"', () => {
    const { ctx, state } = setup();
    const grenadier = state.operatives[opWith(state, 'p1', GRENADIER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const s = activate(ctx, state, grenadier.id);
    const me = s.operatives[grenadier.id]!;
    const frag = ((me as OperativeState & { grantedWeapons?: { name: string; profiles: WeaponProfile[] }[] }).grantedWeapons ?? []).find(
      (w) => w.name === 'Frag grenade',
    )!;
    s.sequence = shootSeq({
      attackerId: me.id,
      targetId: foe.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'Frag grenade',
      step: 'rollAttack',
    });
    expect(statMods(ctx, s, me).hit).toBe(1);
    expect(hitOf(ctx, s, me, frag.profiles[0]!)).toBe(frag.profiles[0]!.hit - 1);
    // Its own bolt pistol gets nothing.
    (s.sequence as ShootSequence).weaponName = 'Autoch-pattern bolt pistol';
    expect(statMods(ctx, s, me).hit).toBe(0);
  });

  it('VÂYR-3 UTILITY GRENADE places a marker within 6" and taxes Pick Up Marker within 3" of it', () => {
    const { ctx, state } = setup();
    const grenadier = state.operatives[opWith(state, 'p1', GRENADIER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [grenadier.id, foe.id]);
    place(state, grenadier.id, 10, 10);
    const def = getAction('hearthkyn-salvager.grenadier.act.v-yr-3-utility-grenade')!;
    expect(def.check(ctx, state, grenadier, { markerPos: { x: 22, y: 10 } }).ok).toBe(false); // > 6"
    const s = activate(ctx, state, grenadier.id);
    const out = act(ctx, s, grenadier.id, def.id, { markerPos: { x: 13, y: 10 } });
    expect(out.ok).toBe(true);
    const marker = Object.values(out.state.markers).find((m) => m.flags['utilityGrenade'])!;
    expect(marker).toBeDefined();
    place(out.state, foe.id, 14, 10); // within 3" of the marker
    expect(actionCost(ctx, out.state, out.state.operatives[foe.id]!, getAction('Pick Up Marker')!)).toBe(2);
    place(out.state, foe.id, 25, 10);
    expect(actionCost(ctx, out.state, out.state.operatives[foe.id]!, getAction('Pick Up Marker')!)).toBe(1);
  });

  it('the Utility Grenade marker is armed by a D3 in the Ready step and removed after that many activations', () => {
    const { ctx, state } = setup({ script: [4] }); // D3 = ceil(4/2) = 2
    const grenadier = state.operatives[opWith(state, 'p1', GRENADIER)]!;
    const s = activate(ctx, state, grenadier.id);
    const out = act(ctx, s, grenadier.id, 'hearthkyn-salvager.grenadier.act.v-yr-3-utility-grenade', {
      markerPos: { x: grenadier.pos.x + 2, y: grenadier.pos.y },
    });
    const marker = Object.values(out.state.markers).find((m) => m.flags['utilityGrenade'])!;
    ctx.hooks.emit('onReadyStep', out.state, { state: out.state, player: 'p1', cp: 1 });
    expect(marker.flags['armed']).toBe(true);
    expect(marker.flags['activationsLeft']).toBe(2);
    const other = out.state.operatives[opWith(out.state, 'p1', LUGGER)]!;
    ctx.hooks.emit('onActivationEnd', out.state, { state: out.state, operative: other });
    expect(out.state.markers[marker.id]).toBeDefined();
    ctx.hooks.emit('onActivationEnd', out.state, { state: out.state, operative: other });
    expect(out.state.markers[marker.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('GUNNER › Beam (rare weapon rule)', () => {
  it('"each retained critical success immediately inflicts D3 damage on each other operative along one beam line"', () => {
    const { ctx, state } = setup({ script: [3, 5] }); // D3 = 2, then D3 = 3
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const target = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const behind = state.operatives[opWith(state, 'p2', KINLYNK)]!;
    const aside = state.operatives[opWith(state, 'p2', KOGNITAAR)]!;
    isolate(state, [gunner.id, target.id, behind.id, aside.id]);
    place(state, gunner.id, 6, 10);
    place(state, target.id, 12, 10);
    place(state, behind.id, 18, 10); // on the beam line, beyond the target
    place(state, aside.id, 18, 16); // off the line
    const T = hooksFor(ctx, 'p1');
    expect(beamVictims(T, state, gunner, target).map((o) => o.id)).toEqual([behind.id]);

    const profile = profileOf(GUNNER, 'EtaCarn plasma beamer');
    const seq = shootSeq({
      attackerId: gunner.id,
      targetId: target.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'EtaCarn plasma beamer',
      step: 'rollDefence',
      attack: pool([6, 4, 2], 4),
    });
    state.sequence = seq;
    const wounds = { target: target.wounds, behind: behind.wounds };
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(gunner, target, profile, 'EtaCarn plasma beamer'),
      count: 2,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(target.wounds).toBe(wounds.target); // "but the target isn’t affected"
    expect(wounds.behind - behind.wounds).toBe(2); // one retained crit → one D3
    expect(aside.wounds).toBe(8);
  });

  it('no retained critical success means no beam at all', () => {
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const target = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const behind = state.operatives[opWith(state, 'p2', KINLYNK)]!;
    isolate(state, [gunner.id, target.id, behind.id]);
    place(state, gunner.id, 6, 10);
    place(state, target.id, 12, 10);
    place(state, behind.id, 18, 10);
    const profile = profileOf(GUNNER, 'EtaCarn plasma beamer');
    state.sequence = shootSeq({
      attackerId: gunner.id,
      targetId: target.id,
      attacker: 'p1',
      defender: 'p2',
      weaponName: 'EtaCarn plasma beamer',
      step: 'rollDefence',
      attack: pool([4, 4], 4),
    });
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(gunner, target, profile, 'EtaCarn plasma beamer'),
      count: 2,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(behind.wounds).toBe(8);
  });
});

// ---------------------------------------------------------------------------
describe('JUMP PACK WARRIOR', () => {
  it('Force Impact: "if it’s performed the Charge action during the activation, this weapon has the Brutal weapon rule"', () => {
    const { ctx, state } = setup();
    const jpw = state.operatives[opWith(state, 'p1', JUMP_PACK_WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    const plasma = profileOf(JUMP_PACK_WARRIOR, 'Plasma weapon');
    const before = effectiveRules(ctx, state, plasma, { operative: jpw, target: foe, weaponName: 'Plasma weapon' });
    expect(before.some((r) => r.id === 'Brutal')).toBe(false);
    jpw.actionsThisActivation.push('Charge');
    const after = effectiveRules(ctx, state, plasma, { operative: jpw, target: foe, weaponName: 'Plasma weapon' });
    expect(after.some((r) => r.id === 'Brutal')).toBe(true);
  });

  it('Jump Pack is four FLY actions; it is set up wholly within its Move stat and not in enemy control range', () => {
    const { ctx, state } = setup();
    const jpw = state.operatives[opWith(state, 'p1', JUMP_PACK_WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [jpw.id, foe.id]);
    place(state, jpw.id, 10, 10);
    place(state, foe.id, 24, 10);
    const fly = getAction(FLY_REPOSITION)!;
    expect(fly.available!(ctx, state, jpw)).toBe(true);
    // Move 8", 28mm base → wholly within 8" means centre-to-centre 8 - 0.551 = 7.449".
    expect(fly.check(ctx, state, jpw, { targetPos: { x: 17.9, y: 10 } }).ok).toBe(false);
    expect(fly.check(ctx, state, jpw, { targetPos: { x: 17, y: 10 } }).ok).toBe(true);
    // A Charge that ends out of control range is refused; a Reposition into control range too.
    expect(getAction(FLY_CHARGE)!.check(ctx, state, jpw, { targetPos: { x: 17, y: 10 } }).ok).toBe(false);
    expect(fly.check(ctx, state, jpw, { targetPos: { x: 23.3, y: 10 } }).ok).toBe(false);
    const s = activate(ctx, state, jpw.id);
    const out = act(ctx, s, jpw.id, FLY_REPOSITION, { targetPos: { x: 17, y: 10 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[jpw.id]!.pos).toEqual({ x: 17, y: 10 });
    // `treatedAs: 'Reposition'` keeps the action restriction shared with the universal action.
    expect(availableActions(ctx, out.state, out.state.operatives[jpw.id]!).find((a) => a.def.id === 'Reposition')!.ok).toBe(false);
  });

  it('the AI’s no-position probe is refused rather than rejected (D-026)', () => {
    const { ctx, state } = setup();
    const jpw = state.operatives[opWith(state, 'p1', JUMP_PACK_WARRIOR)]!;
    for (const id of [FLY_REPOSITION, FLY_CHARGE]) {
      expect(getAction(id)!.check(ctx, state, jpw, {}).ok).toBe(false);
      expect(getAction(id)!.check(ctx, state, jpw, { targetPos: { ...jpw.pos } }).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('KOGNITÂAR › Tactician and ACCELERATED APPRAISAL', () => {
  it('the Attack marker gives Balanced against an enemy within 3" of it', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    place(state, foe.id, 20, 10);
    placeTacticianMarker(state, 'p1', 'attack', { x: 21, y: 10 }, ctx);
    const bolter = profileOf(LUGGER, 'Autoch-pattern bolter');
    const rules = effectiveRules(ctx, state, bolter, { operative: shooter, target: foe, weaponName: 'Autoch-pattern bolter' });
    expect(rules.some((r) => r.id === 'Balanced')).toBe(true);
    place(state, foe.id, 5, 5);
    expect(
      effectiveRules(ctx, state, bolter, { operative: shooter, target: foe, weaponName: 'Autoch-pattern bolter' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(false);
  });

  it('the Defence marker offers a defence-dice re-roll, and only one marker is ever in the killzone', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const shooter = state.operatives[opWith(state, 'p2', LUGGER)]!;
    place(state, mine.id, 10, 10);
    placeTacticianMarker(state, 'p1', 'attack', { x: 10, y: 10 }, ctx);
    placeTacticianMarker(state, 'p1', 'defence', { x: 10, y: 10 }, ctx);
    expect(state.markers[ATTACK_MARKER('p1')]).toBeUndefined();
    expect(state.markers[DEFENCE_MARKER('p1')]).toBeDefined();
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autoch-pattern bolter',
      step: 'defenceRerolls',
    });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, mine, profileOf(LUGGER, 'Autoch-pattern bolter'), 'Autoch-pattern bolter'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.rerolls.map((r) => r.id)).toContain('hearthkyn-salvager.tactician');
  });

  it('"In the Ready step of the next Strategy phase, remove that marker"', () => {
    const { ctx, state } = setup();
    placeTacticianMarker(state, 'p1', 'attack', { x: 10, y: 10 }, ctx);
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(state.markers[ATTACK_MARKER('p1')]).toBeDefined(); // same turning point
    state.turningPoint += 1;
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(state.markers[ATTACK_MARKER('p1')]).toBeUndefined();
  });

  it('ACCELERATED APPRAISAL removes the marker in the killzone and places one', () => {
    const { ctx, state } = setup();
    const kog = state.operatives[opWith(state, 'p1', KOGNITAAR)]!;
    isolate(state, [kog.id]);
    place(state, kog.id, 10, 10);
    placeTacticianMarker(state, 'p1', 'attack', { x: 4, y: 4 }, ctx);
    const s = activate(ctx, state, kog.id);
    const out = act(ctx, s, kog.id, 'hearthkyn-salvager.kognit-ar.act.accelerated-appraisal', {
      choice: 'defence',
      markerPos: { x: 12, y: 12 },
    });
    expect(out.ok).toBe(true);
    expect(out.state.markers[ATTACK_MARKER('p1')]).toBeUndefined();
    expect(out.state.markers[DEFENCE_MARKER('p1')]!.pos).toEqual({ x: 12, y: 12 });
  });
});

// ---------------------------------------------------------------------------
describe('KINLYNK unique actions', () => {
  it('SIGNAL adds 1 to another friendly operative’s APL until the end of its next activation', () => {
    const { ctx, state } = setup();
    const kin = state.operatives[opWith(state, 'p1', KINLYNK)]!;
    const mate = state.operatives[opWith(state, 'p1', LUGGER)]!;
    isolate(state, [kin.id]);
    place(state, kin.id, 10, 10);
    const s = activate(ctx, state, kin.id);
    const out = act(ctx, s, kin.id, 'hearthkyn-salvager.kinlynk.act.signal', { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mate.id]!.aplMods).toContain(1);
    expect(actionOf(KINLYNK, 'hearthkyn-salvager.kinlynk.act.signal').text).toContain('add 1 to its APL stat');
  });

  it('SYSTEM JAM tokens a valid target, refuses a second token, and the token is removed when that operative activates', () => {
    const { ctx, state } = setup();
    const kin = state.operatives[opWith(state, 'p1', KINLYNK)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [kin.id, foe.id]);
    place(state, kin.id, 10, 10);
    place(state, foe.id, 16, 10);
    const def = getAction('hearthkyn-salvager.kinlynk.act.system-jam')!;
    const s = activate(ctx, state, kin.id);
    const out = act(ctx, s, kin.id, def.id, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === SYSTEM_JAM_TOKEN && e.operativeId === foe.id)).toBe(true);
    // "…that doesn't have one of your System Jam tokens" — a second one is refused on that target.
    const only = aliveOperatives(out.state, 'p2').filter((o) => o.id !== foe.id);
    for (const o of only) o.removed = true;
    expect(def.check(ctx, out.state, out.state.operatives[kin.id]!, { targetOperativeId: foe.id }).ok).toBe(false);
    // "When an enemy operative that has one of your System Jam tokens is activated, remove it."
    const after = activate(ctx, out.state, foe.id);
    expect(after.effects.some((e) => e.rule === SYSTEM_JAM_TOKEN && e.operativeId === foe.id)).toBe(false);
  });

  it('SYSTEM JAM’s activation-order clause is reminder-only', () => {
    expect(actionOf(KINLYNK, 'hearthkyn-salvager.kinlynk.act.system-jam').text).toContain(
      'it cannot be activated until each enemy operative without one is expended',
    );
    expect(REMINDER_ONLY['hearthkyn-salvager.kinlynk.act.system-jam.order']).toContain('which operative activates next');
  });
});

// ---------------------------------------------------------------------------
describe('LOKÂTR unique actions', () => {
  it('SPOT places the token — and applies nothing, because its effect list is missing from the data', () => {
    const { ctx, state } = setup();
    const lok = state.operatives[opWith(state, 'p1', LOKATR)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [lok.id, foe.id]);
    place(state, lok.id, 10, 10);
    place(state, foe.id, 16, 10);
    const s = activate(ctx, state, lok.id);
    const out = act(ctx, s, lok.id, 'hearthkyn-salvager.lok-tr.act.spot', { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === SPOT_TOKEN && e.operativeId === foe.id)).toBe(true);
    // Nothing changes for a shot at the spotted operative: there is no printed effect to apply.
    const bolter = profileOf(LUGGER, 'Autoch-pattern bolter');
    const shooter = out.state.operatives[opWith(out.state, 'p1', LUGGER)]!;
    const rules = effectiveRules(ctx, out.state, bolter, {
      operative: shooter,
      target: out.state.operatives[foe.id]!,
      weaponName: 'Autoch-pattern bolter',
    });
    expect(rules.map((r) => r.id)).toEqual(bolter.rules.map((r) => r.id));
  });

  it('PAN SPECTRAL SCAN gives Accurate 1 and Saturate within 3" of the marker, and is removed on the LOKÂTR’s next activation', () => {
    const { ctx, state } = setup();
    const lok = state.operatives[opWith(state, 'p1', LOKATR)]!;
    const shooter = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [lok.id, foe.id]);
    place(state, lok.id, 10, 10);
    place(state, foe.id, 20, 10);
    let s = activate(ctx, state, lok.id);
    const out = act(ctx, s, lok.id, 'hearthkyn-salvager.lok-tr.act.pan-spectral-scan', { markerPos: { x: 21, y: 10 } });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.markers[SCAN_MARKER('p1')]).toBeDefined();
    const bolter = profileOf(LUGGER, 'Autoch-pattern bolter');
    const rules = effectiveRules(ctx, s, bolter, {
      operative: s.operatives[shooter.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Autoch-pattern bolter',
    });
    expect(rules.filter((r) => r.id === 'Accurate')).toHaveLength(2); // the bolter's own + the scan's
    expect(rules.some((r) => r.id === 'Saturate')).toBe(true);
    // "When this operative is next activated … remove that marker."
    s = reduce(s, { t: 'EndActivation', operativeId: lok.id }, ctx).state;
    s.activePlayer = 'p1';
    s.operatives[lok.id]!.ready = true;
    s = activate(ctx, s, lok.id);
    expect(s.markers[SCAN_MARKER('p1')]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('DÔZR › KNUX SMASH', () => {
  function smashSetup(script?: number[]): { ctx: GameContext; state: GameState; dozr: OperativeState; foe: OperativeState } {
    const { ctx, state } = setup(script ? { script } : {});
    const dozr = state.operatives[opWith(state, 'p1', DOZR)]!;
    const foe = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [dozr.id, foe.id]);
    place(state, dozr.id, 10, 10);
    place(state, foe.id, 10.6, 10);
    return { ctx, state, dozr, foe };
  }

  it('"cannot perform this action unless an enemy operative is within its control range"', () => {
    const { ctx, state, dozr, foe } = smashSetup();
    const def = getAction('hearthkyn-salvager.d-zr.act.knux-smash')!;
    expect(def.check(ctx, state, dozr, {}).ok).toBe(true);
    place(state, foe.id, 25, 25);
    expect(def.check(ctx, state, dozr, {}).ok).toBe(false);
  });

  it('moves the enemy up to 3", inflicts D3+1 and subtracts 1 APL when the D3 result is a 3', () => {
    const { ctx, state, dozr, foe } = smashSetup([5]); // D3 = ceil(5/2) = 3
    const s = activate(ctx, state, dozr.id);
    const before = foe.wounds;
    const out = act(ctx, s, dozr.id, 'hearthkyn-salvager.d-zr.act.knux-smash', {
      targetOperativeId: foe.id,
      targetPos: { x: 13, y: 10 },
    });
    expect(out.ok).toBe(true);
    const moved = out.state.operatives[foe.id]!;
    expect(moved.pos).toEqual({ x: 13, y: 10 });
    expect(before - moved.wounds).toBe(4); // D3 (3) + 1
    expect(moved.aplMods).toContain(-1);
  });

  it('a move of more than 3" is refused, and no position at all leaves the enemy in place', () => {
    const { ctx, state, dozr, foe } = smashSetup([2]);
    const def = getAction('hearthkyn-salvager.d-zr.act.knux-smash')!;
    expect(def.check(ctx, state, dozr, { targetOperativeId: foe.id, targetPos: { x: 16, y: 10 } }).ok).toBe(false);
    const s = activate(ctx, state, dozr.id);
    const out = act(ctx, s, dozr.id, 'hearthkyn-salvager.d-zr.act.knux-smash', { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foe.id]!.pos).toEqual({ x: 10.6, y: 10 });
  });

  it('the free Charge is its own action, is capped at 3" and only exists after KNUX SMASH', () => {
    const { ctx, state, dozr, foe } = smashSetup([2]);
    expect(getAction(KNUX_CHARGE)!.available!(ctx, state, dozr)).toBe(false);
    let s = activate(ctx, state, dozr.id);
    // Charge first, so the printed "even if it's already performed the Charge action" bites.
    s.operatives[dozr.id]!.actionsThisActivation.push('Charge');
    const out = act(ctx, s, dozr.id, 'hearthkyn-salvager.d-zr.act.knux-smash', {
      targetOperativeId: foe.id,
      targetPos: { x: 13, y: 10 },
    });
    expect(out.ok).toBe(true);
    s = out.state;
    const me = s.operatives[dozr.id]!;
    expect(getAction(KNUX_CHARGE)!.available!(ctx, s, me)).toBe(true);
    expect(getAction(KNUX_CHARGE)!.check(ctx, s, me, { path: { points: [{ x: 12.3, y: 10 }] } }).ok).toBe(true);
    expect(getAction(KNUX_CHARGE)!.check(ctx, s, me, { path: { points: [{ x: 14, y: 14 }] } }).ok).toBe(false);
    expect(actionOf(DOZR, 'hearthkyn-salvager.d-zr.act.knux-smash').text).toContain('cannot move more than 3"');
  });
});

// ---------------------------------------------------------------------------
describe('LUGGER and WARRIOR abilities', () => {
  it('I’ve Got It: "once during each of this operative’s activations, it can perform a mission action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const lugger = state.operatives[opWith(state, 'p1', LUGGER)]!;
    const mission = getAction('Operate Hatch')!;
    expect(mission.type).toBe('mission');
    expect(actionCost(ctx, state, lugger, mission)).toBe(0);
    lugger.actionsThisActivation.push('Operate Hatch');
    expect(actionCost(ctx, state, lugger, mission)).toBe(1); // "once during each … activations"
    // and it never touches a universal action.
    expect(actionCost(ctx, state, lugger, getAction('Reposition')!)).toBe(1);
  });

  it('Well Supplied is reminder-only — the reducer refuses a fifth equipment option before any hook', () => {
    const { ctx, state } = setup();
    const five = ['a', 'b', 'c', 'd', 'e'];
    const out = reduce(state, { t: 'SelectEquipment', player: 'p1', equipment: five }, ctx);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('you can select up to four equipment options');
    expect(abilityText(LUGGER, 'hearthkyn-salvager.lugger.well-supplied')).toContain('one additional equipment option');
    expect(REMINDER_ONLY['hearthkyn-salvager.lugger.well-supplied']).toContain('caps equipment at four');
  });

  it('Secure Salvage: "subtract 1 from the damage inflicted on it from one success" while it contests a marker', () => {
    const ctx = teamContext([hearthkynSalvager], { seed: 7 });
    const picks = rosterIncluding(hearthkynSalvager, [THEYN, WARRIOR, LUGGER, GUNNER]);
    const state = battle({ ctx, p1: { module: hearthkynSalvager, picks }, p2: { module: hearthkynSalvager, picks } });
    const warrior = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const shooter = state.operatives[opWith(state, 'p2', LUGGER)]!;
    isolate(state, [warrior.id, shooter.id]);
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    place(state, warrior.id, marker.pos.x + 0.6, marker.pos.y);
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: warrior.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autoch-pattern bolter',
      step: 'resolve',
      attack: pool([4, 4], 4),
    });
    inflictDamage(ctx, state, warrior, 6, 'attack');
    expect(warrior.wounds).toBe(8 - 5);
    // Away from the marker it is worth nothing.
    place(state, warrior.id, 2, 2);
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: warrior.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Autoch-pattern bolter',
      step: 'resolve',
      attack: pool([4, 4], 4),
    });
    const before = warrior.wounds;
    inflictDamage(ctx, state, warrior, 2, 'attack');
    expect(before - warrior.wounds).toBe(2);
  });
});
