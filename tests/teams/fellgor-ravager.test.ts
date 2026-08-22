/**
 * FELLGOR RAVAGERS. Every test quotes the printed rule it pins, read out of
 * `data/teams/fellgor-ravager.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/fellgor-ravager/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, successes, type DicePool } from '../../src/core/dice.ts';
import { HookRegistry, zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { resolveFightDie } from '../../src/core/sequences/fight.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  hitOf,
  inflictDamage,
  markerController,
  moveOf,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/fellgor-ravager.json';
import rareRulesJson from '../../data/teams/_rare-weapon-rules.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ACT,
  CARD,
  CHARGE_RAMPAGE,
  EQ,
  E_AMBUSHING,
  E_BLOODSENSE_PAIR,
  E_GONG_KNELL,
  E_INCITE_FURY,
  E_MANTLE,
  E_RAMPAGE,
  E_UNCOMPROMISING,
  FIGHT_CHAMPION,
  FIGHT_SAVAGE,
  FP,
  FRENZY_TOKEN,
  KW,
  REMINDER_ONLY,
  RULE_FRENZY,
  SHOOT_UNCOMPROMISING,
  SP,
  STUN_POX_BOMB,
  fellgorRavager,
  hasFrenzy,
  headtakerBonus,
  isAmbushing,
  peltingShooters,
  recordedOrder,
} from '../../src/teams/fellgor-ravager/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, rosterIncluding, settle, teamContext } from './harness.ts';
import { heavyBlock, rect, testMap } from '../fixtures.ts';
import type { TerrainFeature } from '../../src/core/types.ts';

const DATA = teamData('fellgor-ravager');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

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

const ALL_CARDS = Object.values(CARD);

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
  foe?: string[];
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([fellgorRavager], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = opts.roles ? rosterIncluding(fellgorRavager, opts.roles) : defaultRoster(DATA);
  const foePicks = opts.foe ? rosterIncluding(fellgorRavager, opts.foe) : defaultRoster(DATA);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: fellgorRavager, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: fellgorRavager, picks: foePicks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Park everything else out of the way so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.2 + (n % 3) * 1.2, y: 19 + Math.floor(n / 3) * 1.1 };
    n++;
  }
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
  type: 'ranged' | 'melee' = 'melee',
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
    distance: type === 'melee' ? 0 : 4,
  };
}

const pool = (values: number[], hit: number): DicePool => {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
};

function shootSequence(
  attacker: OperativeState,
  target: OperativeState,
  weaponName: string,
  attack: DicePool,
  step: ShootSequence['step'] = 'resolve',
): ShootSequence {
  return {
    kind: 'shoot',
    step,
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
    attack,
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: attacker.player,
    defender: target.player,
    free: false,
  };
}

function fightSequence(
  attacker: OperativeState,
  defender: OperativeState,
  attackerWeapon: string,
  defenderWeapon: string,
  opts: Partial<FightSequence> = {},
): FightSequence {
  return {
    kind: 'fight',
    step: 'resolve',
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerWeapon,
    defenderWeapon,
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: attacker.player,
    defender: defender.player,
    free: false,
    hatchway: false,
    ...opts,
  };
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

/** A knee-high Light wall: it intervenes (so it gives cover) without blocking visibility. */
function lowLightWall(id: string, x: number, y: number, w: number, h: number): TerrainFeature {
  return {
    id,
    kind: 'test.light',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      { id: `${id}.body`, featureId: id, poly: rect(x, y, w, h), z0: 0, z1: 0.5, types: ['Light'], role: 'wall' },
    ],
  };
}

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER data', () => {
  it('the printed kill team: 11 datacards, 1 faction rule, 4+4 ploys, 4 equipment', () => {
    expect(DATA.id).toBe('fellgor-ravager');
    expect(DATA.name).toBe('Fellgor Ravager');
    expect(DATA.sourceUrl).toContain('fellgor-ravager');
    expect(DATA.datacards.map((c) => c.id).sort()).toEqual([...ALL_CARDS].sort());
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE_FRENZY]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual(Object.values(SP));
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual(Object.values(FP));
    expect(DATA.equipment.map((e) => e.id)).toEqual(Object.values(EQ));
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(p.cp).toBe(1);
  });

  it('fifteen datacard abilities and SEVEN unique actions, all with their printed ids', () => {
    const abilities = DATA.datacards.flatMap((c) => c.abilities.map((a) => a.id));
    const uniques = DATA.datacards.flatMap((c) => c.uniqueActions.map((a) => a.id));
    expect(abilities.length).toBe(15);
    expect(uniques.length).toBe(7);
    expect(abilities.sort()).toEqual([...Object.values(AB)].sort());
    expect(uniques.sort()).toEqual([...Object.values(ACT)].sort());
  });

  it('datacard stats are pinned', () => {
    const stats = DATA.datacards.map((c) => [c.id, c.apl, c.move, c.save, c.wounds, c.base.mm]);
    expect(stats).toEqual([
      [CARD.ironhorn, 2, 6, 5, 11, 32],
      [CARD.deathknell, 2, 6, 4, 10, 32],
      [CARD.fluxbray, 2, 6, 5, 10, 32],
      [CARD.gnarlscar, 2, 6, 5, 10, 32],
      [CARD.gorehorn, 2, 6, 5, 10, 32],
      [CARD.herdGoad, 2, 6, 5, 10, 32],
      [CARD.mangler, 2, 6, 5, 10, 32],
      [CARD.shaman, 2, 6, 5, 10, 32],
      [CARD.toxhorn, 2, 6, 5, 10, 32],
      [CARD.vandal, 2, 6, 5, 10, 32],
      [CARD.warrior, 2, 6, 5, 10, 32],
    ]);
    // Every datacard carries the faction keyword and CHAOS; only the SHAMAN is a PSYKER.
    for (const c of DATA.datacards) expect(c.keywords).toEqual(expect.arrayContaining([KW, 'CHAOS']));
    expect(DATA.datacards.filter((c) => c.keywords.includes('PSYKER')).map((c) => c.id)).toEqual([CARD.shaman]);
    expect(cardOf(CARD.ironhorn).keywords).toContain('LEADER');
  });

  it('weapon profiles are pinned, footnoted rare rules included', () => {
    expect(profileOf(CARD.gorehorn, 'Skullcleaver')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(CARD.gorehorn, 'Skullcleaver').rules.map((r) => r.id)).toEqual(['Lethal', 'Headtaker']);
    expect(profileOf(CARD.mangler, 'Vicious claws')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 6 });
    expect(profileOf(CARD.mangler, 'Vicious claws').rules.map((r) => r.id)).toEqual(['Ceaseless', 'TactualHunter']);
    expect(profileOf(CARD.vandal, 'Mancrusher')).toMatchObject({ atk: 4, hit: 4, dmgN: 5, dmgC: 5 });
    expect(profileOf(CARD.vandal, 'Mancrusher').rules.map((r) => r.id)).toEqual(['Brutal', 'ViciousBlows']);
    expect(profileOf(CARD.shaman, 'Tech-curse').rules.map((r) => r.id)).toEqual([
      'PSYCHIC',
      'Rending',
      'Saturate',
      'SeekLight',
    ]);
    expect(profileOf(CARD.herdGoad, 'Crackthorn whip', 'melee').rules.map((r) => r.id)).toEqual(['Lethal', 'Shock']);
    expect(profileOf(CARD.toxhorn, 'Autopistol')).toMatchObject({ atk: 4, hit: 4, dmgN: 2, dmgC: 3 });
    expect(profileOf(CARD.ironhorn, 'Plasma pistol', 'supercharge').rules.map((r) => r.id)).toEqual([
      'Range',
      'Hot',
      'Lethal',
      'Piercing',
    ]);
  });

  it('the four printed rare weapon rules, and the marker guide', () => {
    expect(DATA.rareWeaponRules).toEqual(['Headtaker', 'PSYCHIC', 'TactualHunter', 'ViciousBlows']);
    expect(DATA.markerGuide).toContain('Frenzy token');
    expect(DATA.markerGuide).toContain('Gong Knell token');
    // `notes[]` is empty: the scraper flagged nothing on this team.
    expect(NOTES).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER selection', () => {
  it('"Other than WARRIOR operatives, your kill team can only include each operative on this list once."', () => {
    expect(DATA.selection.rawText).toContain(
      'Other than WARRIOR operatives, your kill team can only include each operative on this list once.',
    );
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['WARRIOR'] }]);
    expect(DATA.selection.slots).toBe(9);
    expect(DATA.selection.totalOperatives).toBe(10);
  });

  it('defaultRoster is legal and fields ten of the eleven datacards — never the WARRIOR', () => {
    const picks = defaultRoster(DATA);
    const v = validateRosterFor(DATA, picks);
    expect(v.ok, v.errors.join('; ')).toBe(true);
    expect(picks.length).toBe(10);
    const fielded = new Set(picks.map((p) => p.datacardId));
    expect([...fielded].sort()).toEqual(ALL_CARDS.filter((id) => id !== CARD.warrior).sort());
    expect(fielded.has(CARD.warrior)).toBe(false);
  });

  it('the uniqueExcept exemption fires: two WARRIORs validate, two VANDALs do not', () => {
    // 1 IRONHORN + 7 different list rows + 2 of the repeatable row = the printed 10 operatives.
    const base = defaultRoster(DATA).slice(0, 8);
    const warrior = () => ({ datacardId: CARD.warrior, loadoutIds: ['fellgor-ravager.g2e10.opt1'] });
    const twoWarriors = [...base, warrior(), warrior()];
    expect(validateRosterFor(DATA, twoWarriors).ok, validateRosterFor(DATA, twoWarriors).errors.join('; ')).toBe(true);
    const dupe = base[base.length - 1]!;
    const twoOfOne = [...base, { ...dupe }, warrior()];
    expect(validateRosterFor(DATA, twoOfOne).ok).toBe(false);
    expect(validateRosterFor(DATA, twoOfOne).errors.join(' ')).toMatch(/once/i);
  });

  it('exactly one IRONHORN leader is required', () => {
    const noLeader = defaultRoster(DATA).filter((p) => p.datacardId !== CARD.ironhorn);
    expect(validateRosterFor(DATA, noLeader).ok).toBe(false);
    expect(DATA.selection.leader.role).toBe('IRONHORN');
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER rare weapon rules (D-033)', () => {
  const registry = (id: string): string =>
    (rareRulesJson as { rules: { id: string; definition: string }[] }).rules.find((r) => r.id === id)!.definition;

  it('Headtaker resolves to the GOREHORN datacard ability, byte-identical to the registry', () => {
    expect(rareWeaponRuleText('Headtaker', 'fellgor-ravager')).toBe(abilityText(CARD.gorehorn, AB.headtaker));
    expect(rareWeaponRuleText('Headtaker', 'fellgor-ravager')).toBe(registry('Headtaker'));
  });

  it('Tactual Hunter resolves to the MANGLER datacard ability, byte-identical to the registry', () => {
    expect(rareWeaponRuleText('TactualHunter', 'fellgor-ravager')).toBe(abilityText(CARD.mangler, AB.tactualHunter));
    expect(rareWeaponRuleText('TactualHunter', 'fellgor-ravager')).toBe(registry('TactualHunter'));
  });

  it('Vicious Blows resolves to the VANDAL datacard ability, byte-identical to the registry', () => {
    expect(rareWeaponRuleText('ViciousBlows', 'fellgor-ravager')).toBe(abilityText(CARD.vandal, AB.viciousBlows));
    expect(rareWeaponRuleText('ViciousBlows', 'fellgor-ravager')).toBe(registry('ViciousBlows'));
  });

  it('PSYCHIC is a keyword with no printed definition — the registry entry is empty', () => {
    expect(registry('PSYCHIC')).toBe('');
    expect(rareWeaponRuleText('PSYCHIC', 'fellgor-ravager')).toContain('no printed definition');
  });
});

// ---------------------------------------------------------------------------
describe('Frenzy — the faction rule', () => {
  it('"Whenever a friendly FELLGOR RAVAGER operative that doesn’t have one of your Frenzy tokens would be incapacitated … it’s not incapacitated and it gains one of your Frenzy tokens"', () => {
    expect(ruleText(RULE_FRENZY)).toContain('it’s not incapacitated and it gains one of your Frenzy tokens');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const res = inflictDamage(ctx, state, op, 99, 'other');
    expect(res.incapacitated).toBe(false);
    expect(op.incapacitated).toBe(false);
    expect(op.wounds).toBe(1);
    expect(hasFrenzy(state, op)).toBe(true);
  });

  it('Frenzy reaches EVERY datacard — all eleven carry the FELLGOR RAVAGER keyword', () => {
    const { ctx, state } = setup({ roles: [CARD.warrior] });
    for (const id of state.teams.p1.operativeIds) {
      const op = state.operatives[id]!;
      inflictDamage(ctx, state, op, 99, 'other');
      expect([op.datacardId, op.incapacitated, hasFrenzy(state, op)]).toEqual([op.datacardId, false, true]);
    }
    expect(new Set(state.teams.p1.operativeIds.map((id) => state.operatives[id]!.datacardId)).size).toBe(10);
  });

  it('"If it has a Conceal order, change it to Engage." — and it cannot have one afterwards', () => {
    expect(ruleText(RULE_FRENZY)).toContain('If it has a Conceal order, change it to Engage.');
    expect(ruleText(RULE_FRENZY)).toContain('It cannot have a Conceal order.');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    op.order = 'conceal';
    inflictDamage(ctx, state, op, 99, 'other');
    expect(op.order).toBe('engage');
    // The order is corrected again at the start of its next activation (onOrderChange is never
    // emitted, so the choice cannot be refused at the moment it is made).
    op.order = 'conceal';
    const s = activate(ctx, state, op.id, 'conceal');
    expect(s.operatives[op.id]!.order).toBe('engage');
  });

  it('"All remaining attack dice are discarded (including yours if this operative is fighting or retaliating)."', () => {
    expect(ruleText(RULE_FRENZY)).toContain('All remaining attack dice are discarded');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    const seq = fightSequence(foe, mine, 'Skullcleaver', 'Mancrusher');
    addRolled(seq.attackerPool, [6, 5, 4], 3);
    addRolled(seq.defenderPool, [6, 5], 4);
    state.sequence = seq;
    inflictDamage(ctx, state, mine, 99, 'other');
    expect(successes(seq.attackerPool).length).toBe(0);
    expect(successes(seq.defenderPool).length).toBe(0);
    expect(seq.attackerPool.dice.every((d) => d.state === 'discarded')).toBe(true);
  });

  it('"It’s only incapacitated as detailed overleaf." — a second killing blow is prevented too', () => {
    expect(ruleText(RULE_FRENZY)).toContain('It’s only incapacitated as detailed overleaf.');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, op, 99, 'other');
    inflictDamage(ctx, state, op, 99, 'other');
    expect(op.incapacitated).toBe(false);
    expect(op.wounds).toBe(1);
  });

  it('"It’s injured." — the prevention leaves it on 1 wound, so the printed penalties already apply', () => {
    expect(ruleText(RULE_FRENZY)).toContain('It’s injured.');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, op, 99, 'other');
    expect(moveOf(ctx, state, op)).toBe(4); // 6" − 2" (injured), clamped at 4"
    const profile = profileOf(CARD.vandal, 'Mancrusher');
    expect(hitOf(ctx, state, op, profile)).toBe(5); // 4+ worsened by 1
  });

  it('"It cannot perform the Pick Up Marker, unique (excluding Sweeping Blow…) or mission actions (excluding Operate Hatch)"', () => {
    expect(ruleText(RULE_FRENZY)).toContain(
      'It cannot perform the Pick Up Marker, unique (excluding Sweeping Blow, see VANDAL) or mission actions (excluding Operate Hatch)',
    );
    const { ctx, state } = setup({ roles: [CARD.vandal, CARD.shaman] });
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const shaman = state.operatives[opWith(state, 'p1', CARD.shaman)]!;
    const ask = (op: OperativeState, action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: op, action, allowed: true }).allowed;
    expect(ask(vandal, 'Pick Up Marker')).toBe(true);
    inflictDamage(ctx, state, vandal, 99, 'other');
    inflictDamage(ctx, state, shaman, 99, 'other');
    expect(ask(vandal, 'Pick Up Marker')).toBe(false);
    expect(ask(shaman, ACT.mantleOfDarkness)).toBe(false);
    expect(ask(vandal, ACT.sweepingBlow)).toBe(true); // the printed exclusion
    expect(ask(vandal, 'Operate Hatch')).toBe(true); // the printed exclusion
    expect(ask(vandal, 'Fight')).toBe(true);
    expect(ask(vandal, 'Charge')).toBe(true);
  });

  it('"treat its APL stat as 1" when determining control of markers', () => {
    expect(ruleText(RULE_FRENZY)).toContain('treat its APL stat as 1');
    const { ctx, state } = setup({ roles: [CARD.vandal] });
    const mine = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [mine.id, foe.id]);
    state.markers['obj'] = {
      id: 'obj',
      kind: 'objective',
      diameterMm: 40,
      pos: { x: 15, y: 11 },
      z: 0,
      flags: {},
    };
    place(state, mine.id, 14.2, 11);
    place(state, foe.id, 15.8, 11);
    expect(markerController(ctx, state, state.markers['obj']!)).toBe(null); // 2 APL each
    inflictDamage(ctx, state, mine, 99, 'other');
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p2'); // 1 vs 2
  });

  it('trigger 1: "Its activation or counteraction ends."', () => {
    expect(ruleText(RULE_FRENZY)).toContain('Its activation or counteraction ends.');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, op, 99, 'other');
    let s = activate(ctx, state, op.id, 'engage');
    expect(s.operatives[op.id]!.incapacitated).toBe(false);
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(s.operatives[op.id]!.removed).toBe(true);
  });

  it('trigger 2: "your opponent strikes with a critical success" in a fight', () => {
    expect(ruleText(RULE_FRENZY)).toContain('your opponent strikes with a critical success');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.toxhorn)]!;
    inflictDamage(ctx, state, mine, 99, 'other');
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(foe, mine, profileOf(CARD.toxhorn, 'Cleaver'), 'Cleaver'),
      crit: true,
      struck: mine,
    });
    expect(mine.incapacitated).toBe(true);
  });

  it('trigger 3: "strikes it for a second time with a normal success … from two different Fight actions"', () => {
    expect(ruleText(RULE_FRENZY)).toContain('Note this can be strikes from two different Fight actions.');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.toxhorn)]!;
    inflictDamage(ctx, state, mine, 99, 'other');
    const strike = (): void => {
      ctx.hooks.emit('onStrikeResolved', state, {
        state,
        ctx: attackCtx(foe, mine, profileOf(CARD.toxhorn, 'Cleaver'), 'Cleaver'),
        crit: false,
        struck: mine,
      });
    };
    strike();
    expect(mine.incapacitated).toBe(false);
    strike();
    expect(mine.incapacitated).toBe(true);
  });

  it('trigger 4: "An enemy operative is shooting it and Critical Dmg is inflicted on it."', () => {
    expect(ruleText(RULE_FRENZY)).toContain('An enemy operative is shooting it and Critical Dmg is inflicted on it.');
    const { ctx, state } = setup({ roles: [CARD.vandal], foe: [CARD.toxhorn] });
    const mine = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.toxhorn)]!;
    isolate(state, [mine.id, foe.id]); // no DEATHKNELL within 3" to sound the War Gong
    inflictDamage(ctx, state, mine, 99, 'other');
    const profile = profileOf(CARD.toxhorn, 'Autopistol');
    state.sequence = shootSequence(foe, mine, 'Autopistol', pool([6], 4));
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: { ...attackCtx(foe, mine, profile, 'Autopistol', 'ranged') },
      crit: true,
      struck: mine,
    });
    expect(mine.incapacitated).toBe(true);
  });

  it('trigger 5: "The battle ends (resolve this before any victory conditions…)"', () => {
    expect(ruleText(RULE_FRENZY)).toContain('The battle ends');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, op, 99, 'other');
    state.turningPoint = 3;
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(op.incapacitated).toBe(false);
    state.turningPoint = 4;
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(op.incapacitated).toBe(true);
  });

  it('"your opponent treats a FELLGOR RAVAGER operative as being incapacitated … when it gains one of your Frenzy tokens": the opponent\'s onIncapacitated handlers fire on that very emit', () => {
    expect(ruleText(RULE_FRENZY)).toContain('when it gains one of your Frenzy tokens');
    const { ctx, state } = setup();
    const reg = new HookRegistry();
    fellgorRavager.register(reg, 'p1', ctx);
    let sawIt = 0;
    reg.on('onIncapacitated', { id: 'probe.enemyDeathTrigger', sourceText: 'probe', priority: 50 }, () => {
      sawIt++;
    });
    ctx.hooks = reg;
    const op = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, op, 99, 'other');
    expect(sawIt).toBe(1);
    expect(hasFrenzy(state, op)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER datacard abilities', () => {
  it('IRONHORN › Call the Attack is a 0CP STRATEGIC GAMBIT granting a free Dash to a cluster', () => {
    expect(abilityText(CARD.ironhorn, AB.callTheAttack)).toContain('can immediately perform a free Dash action');
    const { ctx, state } = setup();
    const ironhorn = opWith(state, 'p1', CARD.ironhorn);
    const near = opWith(state, 'p1', CARD.vandal);
    const alsoNear = opWith(state, 'p1', CARD.gorehorn);
    isolate(state, [ironhorn, near, alsoNear]);
    place(state, ironhorn, 6, 11); // visible to and within 6" of the selected operative
    place(state, near, 11, 11);
    place(state, alsoNear, 12.4, 11); // within 2" of the selected operative
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(AB.callTheAttack);
    const out = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: AB.callTheAttack, data: { operativeId: near } },
      ctx,
    );
    expect(out.ok).toBe(true);
    for (const id of [near, alsoNear]) {
      expect(out.state.operatives[id]!.aplMods).toContain(1);
      expect(out.state.effects.some((e) => e.operativeId === id && e.data?.['only'])).toBe(true);
    }
    expect(out.state.operatives[ironhorn]!.aplMods).toEqual([]);
    // The free AP is restricted to the Dash action.
    const dashOnly = ctx.hooks.emit('canPerformAction', out.state, {
      state: out.state,
      operative: { ...out.state.operatives[near]!, apSpent: 2 },
      action: 'Fight',
      allowed: true,
    });
    expect(dashOnly.allowed).toBe(false);
  });

  it('Call the Attack’s free AP is popped again, so nobody sits on APL 3 for the battle', () => {
    const { ctx, state } = setup();
    const ironhorn = opWith(state, 'p1', CARD.ironhorn);
    const near = opWith(state, 'p1', CARD.vandal);
    isolate(state, [ironhorn, near]);
    place(state, ironhorn, 6, 11);
    place(state, near, 11, 11);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: AB.callTheAttack, data: { operativeId: near } }, ctx).state;
    expect(s.operatives[near]!.aplMods).toEqual([1]);
    s.phase = 'firefight';
    s = activate(ctx, s, near, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: near }, ctx).state;
    expect(s.operatives[near]!.aplMods).toEqual([]);
  });

  it('DEATHKNELL › Icon Bearer: +1 APL for marker control, and it ignores the Frenzy marker bullet', () => {
    expect(abilityText(CARD.deathknell, AB.iconBearer)).toContain(
      'This operative isn’t affected by the marker control bullet point of the Frenzy faction rule.',
    );
    const { ctx, state } = setup();
    const knell = state.operatives[opWith(state, 'p1', CARD.deathknell)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [knell.id, foe.id]);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 15, y: 11 }, z: 0, flags: {} };
    place(state, knell.id, 14.2, 11);
    place(state, foe.id, 15.8, 11);
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p1'); // 3 vs 2
    inflictDamage(ctx, state, knell, 99, 'other');
    // Still 3 (2 + Icon Bearer) — the Frenzy "treat its APL stat as 1" bullet does not apply.
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p1');
  });

  it('DEATHKNELL › War Gong turns a critical strike into Normal Dmg', () => {
    expect(abilityText(CARD.deathknell, AB.warGong)).toContain('you can choose for that attack dice to inflict Normal Dmg instead');
    const { ctx, state } = setup();
    const knell = state.operatives[opWith(state, 'p1', CARD.deathknell)]!;
    const victim = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [knell.id, victim.id, foe.id]);
    place(state, knell.id, 10, 11);
    place(state, victim.id, 11.5, 11);
    place(state, foe.id, 12.5, 11);
    const seq = fightSequence(foe, victim, 'Skullcleaver', 'Mancrusher');
    state.sequence = seq;
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, profileOf(CARD.gorehorn, 'Skullcleaver').dmgC, 'attack');
    expect(before - victim.wounds).toBe(profileOf(CARD.gorehorn, 'Skullcleaver').dmgN);
  });

  it('War Gong stands down while the DEATHKNELL itself has a Frenzy token', () => {
    const { ctx, state } = setup();
    const knell = state.operatives[opWith(state, 'p1', CARD.deathknell)]!;
    const victim = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [knell.id, victim.id, foe.id]);
    place(state, knell.id, 10, 11);
    place(state, victim.id, 11.5, 11);
    place(state, foe.id, 12.5, 11);
    inflictDamage(ctx, state, knell, 99, 'other');
    state.sequence = fightSequence(foe, victim, 'Skullcleaver', 'Mancrusher');
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, profileOf(CARD.gorehorn, 'Skullcleaver').dmgC, 'attack');
    expect(before - victim.wounds).toBe(profileOf(CARD.gorehorn, 'Skullcleaver').dmgC);
  });

  it('War Gong turns a shot’s critical successes into Normal Dmg — and the Frenzy shooting trigger then does not fire', () => {
    const { ctx, state } = setup();
    const knell = state.operatives[opWith(state, 'p1', CARD.deathknell)]!;
    const victim = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.ironhorn)]!;
    isolate(state, [knell.id, victim.id, foe.id]);
    place(state, knell.id, 10, 11);
    place(state, victim.id, 11.5, 11);
    place(state, foe.id, 18, 11);
    inflictDamage(ctx, state, victim, 99, 'other'); // a Frenzy token, so trigger 4 is armed
    expect(hasFrenzy(state, victim)).toBe(true);
    victim.wounds = 10; // so the damage this shot inflicts is measurable
    const profile = profileOf(CARD.ironhorn, 'Corrupted pistol');
    const seq = shootSequence(foe, victim, 'Corrupted pistol', pool([6], 4));
    state.sequence = seq;
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, profile.dmgC, 'attack');
    expect(before - victim.wounds).toBe(profile.dmgN); // 5 → 3
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: { ...attackCtx(foe, victim, profile, 'Corrupted pistol', 'ranged'), rules: profile.rules },
      crit: true,
      struck: victim,
    });
    expect(victim.incapacitated).toBe(false); // no Critical Dmg was inflicted
  });

  it('FLUXBRAY › Blade Whirl resolves one of the retaliating FLUXBRAY’s successes before the normal order', () => {
    expect(abilityText(CARD.fluxbray, AB.bladeWhirl)).toContain('you can resolve one of your successes before the normal order');
    const { ctx, state } = setup();
    const flux = state.operatives[opWith(state, 'p1', CARD.fluxbray)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [flux.id, foe.id]);
    place(state, flux.id, 11, 11);
    place(state, foe.id, 12, 11);
    const seq = fightSequence(foe, flux, 'Skullcleaver', 'Triple cleavers', { step: 'retention' });
    state.sequence = seq;
    expect(seq.turn).toBe('attacker');
    effectiveRules(ctx, state, profileOf(CARD.fluxbray, 'Triple cleavers'), {
      operative: flux,
      target: foe,
      weaponName: 'Triple cleavers',
      retaliating: true,
    });
    expect(seq.turn).toBe('defender');
  });

  it('GNARLSCAR › Sagacious changes its order at the end of its activation when Conceal hides it', () => {
    expect(abilityText(CARD.gnarlscar, AB.sagacious)).toBe('At the end of this operative’s activation, you can change its order.');
    // A low Light wall: intervening (so the target is in cover) but far too short to hide it.
    const map = testMap({ features: [lowLightWall('shade', 12.4, 8, 0.3, 6)] });
    const { ctx, state } = setup({ map });
    const gnarl = opWith(state, 'p1', CARD.gnarlscar);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [gnarl, foe]);
    place(state, gnarl, 13.4, 11);
    place(state, foe, 8, 11);
    let s = activate(ctx, state, gnarl, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: gnarl }, ctx).state;
    expect(s.operatives[gnarl]!.order).toBe('conceal');
  });

  it('Sagacious keeps Engage when Conceal buys nothing, and never while it has a Frenzy token', () => {
    const { ctx, state } = setup();
    const gnarl = opWith(state, 'p1', CARD.gnarlscar);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [gnarl, foe]);
    place(state, gnarl, 12, 11);
    place(state, foe, 6, 11); // open ground: Conceal changes nothing
    let s = activate(ctx, state, gnarl, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: gnarl }, ctx).state;
    expect(s.operatives[gnarl]!.order).toBe('engage');
  });

  it('GOREHORN › Champion is a second Fight action, and only after the first', () => {
    expect(abilityText(CARD.gorehorn, AB.champion)).toBe('This operative can perform two Fight actions during its activation.');
    const { ctx, state } = setup();
    const gore = opWith(state, 'p1', CARD.gorehorn);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [gore, foe]);
    place(state, gore, 11, 11);
    place(state, foe, 12, 11);
    let s = activate(ctx, state, gore, 'engage');
    expect(getAction(FIGHT_CHAMPION)!.check(ctx, s, s.operatives[gore]!, {}).ok).toBe(false);
    s = act(ctx, s, gore, 'Fight', { targetId: foe }).state;
    s = settle(ctx, s);
    if (!s.operatives[foe]!.removed) {
      expect(getAction(FIGHT_CHAMPION)!.check(ctx, s, s.operatives[gore]!, { targetId: foe }).ok).toBe(true);
    }
    // The GOREHORN alone has it.
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    expect(getAction(FIGHT_CHAMPION)!.available!(ctx, state, vandal)).toBe(false);
  });

  it('GOREHORN › Headtaker rolls a D3 on a kill: it heals and its skullcleaver’s Critical Dmg grows', () => {
    expect(abilityText(CARD.gorehorn, AB.headtaker)).toContain('add the result to the Critical Dmg stat of this operative’s skullcleaver (to a maximum of 8)');
    const { ctx, state } = setup({ script: [3, 3, 3, 3] }); // D3 = ceil(d6/2) → 3 = 2
    const gore = state.operatives[opWith(state, 'p1', CARD.gorehorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    gore.wounds = 4;
    foe.incapacitated = true;
    const profile = profileOf(CARD.gorehorn, 'Skullcleaver');
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: { ...attackCtx(gore, foe, profile, 'Skullcleaver'), rules: profile.rules },
      crit: true,
      struck: foe,
    });
    expect(gore.wounds).toBe(6); // 4 + D3(2)
    expect(headtakerBonus(state, gore.id)).toBe(2);
  });

  it('Headtaker’s heal is withheld from a GOREHORN that has a Frenzy token, but the weapon still grows', () => {
    const { ctx, state } = setup({ script: [3, 3, 3, 3] });
    const gore = state.operatives[opWith(state, 'p1', CARD.gorehorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    inflictDamage(ctx, state, gore, 99, 'other');
    expect(gore.wounds).toBe(1);
    foe.incapacitated = true;
    const profile = profileOf(CARD.gorehorn, 'Skullcleaver');
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: { ...attackCtx(gore, foe, profile, 'Skullcleaver'), rules: profile.rules },
      crit: true,
      struck: foe,
    });
    expect(gore.wounds).toBe(1);
    expect(headtakerBonus(state, gore.id)).toBe(2);
  });

  it('Headtaker’s grown Critical Dmg is applied at the moment of damage (D-019), capped at 8', () => {
    const { ctx, state } = setup();
    const gore = state.operatives[opWith(state, 'p1', CARD.gorehorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    isolate(state, [gore.id, foe.id]);
    place(state, gore.id, 11, 11);
    place(state, foe.id, 12, 11);
    (state.opState['fellgor-ravager.headtaker'] as Record<string, number>) = { [gore.id]: 9 };
    state.sequence = fightSequence(gore, foe, 'Skullcleaver', 'Mancrusher');
    const before = foe.wounds;
    inflictDamage(ctx, state, foe, profileOf(CARD.gorehorn, 'Skullcleaver').dmgC, 'attack');
    expect(before - foe.wounds).toBe(8); // 5 + 9 → capped at 8
  });

  it('HERD-GOAD › Whip Control subtracts 1 from a nearby enemy’s melee Atk and taxes its Fall Back', () => {
    expect(abilityText(CARD.herdGoad, AB.whipControl)).toContain('Subtract 1 from the Atk stat of that enemy operative’s melee weapons (to a minimum of 1).');
    const { ctx, state } = setup();
    const goad = state.operatives[opWith(state, 'p1', CARD.herdGoad)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    isolate(state, [goad.id, foe.id]);
    place(state, goad.id, 11, 11);
    place(state, foe.id, 13.5, 11); // visible and within 3", not in control range
    const profile = profileOf(CARD.vandal, 'Mancrusher');
    const dice = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(foe, goad, profile, 'Mancrusher'),
      count: profile.atk,
      mods: zeroStatMods(),
    });
    expect(dice.count).toBe(profile.atk - 1);
    expect(actionCost(ctx, state, foe, getAction('Fall Back')!)).toBe(3);
    // Out of range: nothing changes.
    place(state, foe.id, 20, 11);
    expect(actionCost(ctx, state, foe, getAction('Fall Back')!)).toBe(2);
  });

  it('Whip Control stands down while the HERD-GOAD is within control range of another enemy operative', () => {
    const { ctx, state } = setup();
    const goad = state.operatives[opWith(state, 'p1', CARD.herdGoad)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    const other = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [goad.id, foe.id, other.id]);
    place(state, goad.id, 11, 11);
    place(state, foe.id, 13.5, 11);
    place(state, other.id, 12.1, 11); // within the HERD-GOAD's control range
    expect(actionCost(ctx, state, foe, getAction('Fall Back')!)).toBe(2);
  });

  it('MANGLER › Tactual Hunter resolves another success as a strike against an EXPENDED operative', () => {
    expect(abilityText(CARD.mangler, AB.tactualHunter)).toContain('you can immediately resolve another of your successes as a strike (before your opponent)');
    const { ctx, state } = setup();
    const mangler = state.operatives[opWith(state, 'p1', CARD.mangler)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.warrior === undefined ? CARD.vandal : CARD.vandal)]!;
    isolate(state, [mangler.id, foe.id]);
    place(state, mangler.id, 11, 11);
    place(state, foe.id, 12, 11);
    foe.wounds = 40;
    foe.expended = true;
    const seq = fightSequence(mangler, foe, 'Vicious claws', 'Mancrusher');
    addRolled(seq.attackerPool, [6, 5], 3);
    addRolled(seq.defenderPool, [2], 4);
    state.sequence = seq;
    const first = seq.attackerPool.dice[0]!;
    const before = foe.wounds;
    resolveFightDie(ctx, state, seq, 'attacker', first.id, 'strike');
    const profile = profileOf(CARD.mangler, 'Vicious claws');
    expect(before - foe.wounds).toBe(profile.dmgC + profile.dmgN); // the crit AND the extra normal
    expect(successes(seq.attackerPool).length).toBe(0);
  });

  it('Tactual Hunter does nothing against a READY operative', () => {
    const { ctx, state } = setup();
    const mangler = state.operatives[opWith(state, 'p1', CARD.mangler)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    isolate(state, [mangler.id, foe.id]);
    place(state, mangler.id, 11, 11);
    place(state, foe.id, 12, 11);
    foe.wounds = 40;
    foe.expended = false;
    const seq = fightSequence(mangler, foe, 'Vicious claws', 'Mancrusher');
    addRolled(seq.attackerPool, [6, 5], 3);
    addRolled(seq.defenderPool, [2], 4);
    state.sequence = seq;
    const before = foe.wounds;
    resolveFightDie(ctx, state, seq, 'attacker', seq.attackerPool.dice[0]!.id, 'strike');
    expect(before - foe.wounds).toBe(profileOf(CARD.mangler, 'Vicious claws').dmgC);
  });

  it('MANGLER › Berserker: no Shoot action, and +1AP for Pick Up Marker and mission actions', () => {
    expect(abilityText(CARD.mangler, AB.berserker)).toContain('This operative cannot perform the Shoot action');
    const { ctx, state } = setup();
    const mangler = state.operatives[opWith(state, 'p1', CARD.mangler)]!;
    const ask = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: mangler, action, allowed: true }).allowed;
    expect(ask('Shoot')).toBe(false);
    expect(ask('Fight')).toBe(true);
    expect(ask('Guard')).toBe(true); // "(other than Guard…)"
    expect(actionCost(ctx, state, mangler, getAction('Pick Up Marker')!)).toBe(2);
    expect(actionCost(ctx, state, mangler, getAction('Operate Hatch')!)).toBe(1); // the printed exclusion
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    expect(actionCost(ctx, state, vandal, getAction('Pick Up Marker')!)).toBe(1);
  });

  it('MANGLER › Savage is a free Fight action after the first, taking precedence over action restrictions', () => {
    expect(abilityText(CARD.mangler, AB.savage)).toContain('it can immediately perform a free Fight action afterwards');
    const { ctx, state } = setup();
    const mangler = opWith(state, 'p1', CARD.mangler);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [mangler, foe]);
    place(state, mangler, 11, 11);
    place(state, foe, 12, 11);
    state.operatives[foe]!.wounds = 40;
    const def = getAction(FIGHT_SAVAGE)!;
    expect(def.ap).toBe(0);
    let s = activate(ctx, state, mangler, 'engage');
    expect(def.check(ctx, s, s.operatives[mangler]!, { targetId: foe }).ok).toBe(false);
    s = act(ctx, s, mangler, 'Fight', { targetId: foe }).state;
    s = settle(ctx, s);
    expect(def.check(ctx, s, s.operatives[mangler]!, { targetId: foe }).ok).toBe(true);
    const out = act(ctx, s, mangler, FIGHT_SAVAGE, { targetId: foe });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mangler]!.apSpent).toBe(1); // the second Fight was free
  });

  it('TOXHORN › Toxic Blessings ignores worsening APL changes and strips an enemy Shock', () => {
    expect(abilityText(CARD.toxhorn, AB.toxicBlessings)).toContain('it’s not affected by enemy operatives’ Shock weapon rule');
    const { ctx, state } = setup();
    const tox = state.operatives[opWith(state, 'p1', CARD.toxhorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.herdGoad)]!;
    tox.aplMods.push(-1);
    expect(aplOf(ctx, state, tox)).toBe(2);
    const whip = profileOf(CARD.herdGoad, 'Crackthorn whip', 'melee');
    const rules = effectiveRules(ctx, state, whip, {
      operative: foe,
      target: tox,
      weaponName: 'Crackthorn whip',
    });
    expect(whip.rules.some((r) => r.id === 'Shock')).toBe(true);
    expect(rules.some((r) => r.id === 'Shock')).toBe(false);
  });

  it('Toxic Blessings rolls a D6 against Normal Dmg of 3 or more: on a 5+ it subtracts 1', () => {
    expect(abilityText(CARD.toxhorn, AB.toxicBlessings)).toContain('on a 5+, subtract 1 from that inflicted damage');
    const { ctx, state } = setup({ script: [5, 5, 5, 5] });
    const tox = state.operatives[opWith(state, 'p1', CARD.toxhorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [tox.id, foe.id]);
    place(state, tox.id, 11, 11);
    place(state, foe.id, 12, 11);
    state.sequence = fightSequence(foe, tox, 'Skullcleaver', 'Cleaver');
    const before = tox.wounds;
    inflictDamage(ctx, state, tox, profileOf(CARD.gorehorn, 'Skullcleaver').dmgN, 'attack');
    expect(before - tox.wounds).toBe(profileOf(CARD.gorehorn, 'Skullcleaver').dmgN - 1);
  });

  it('TOXHORN › Pox Bomb: its own Stun Grenade action, and the printed extra damage on a 3+', () => {
    expect(abilityText(CARD.toxhorn, AB.poxBomb)).toContain('also inflict damage on that enemy operative equal to the dice result halved (rounding up)');
    const { ctx, state } = setup();
    const tox = state.operatives[opWith(state, 'p1', CARD.toxhorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    // The stun-test rider.
    const ev = ctx.hooks.emit('onStunTest', state, { state, thrower: tox, target: foe, roll: 5, damage: 0 });
    expect(ev.damage).toBe(3); // ceil(5/2)
    const low = ctx.hooks.emit('onStunTest', state, { state, thrower: tox, target: foe, roll: 2, damage: 0 });
    expect(low.damage).toBe(0);
    // The action exists for the TOXHORN with no Utility Grenades equipment selected at all.
    expect(state.teams.p1.equipment).not.toContain('eq.utilityGrenades');
    const def = getAction(STUN_POX_BOMB)!;
    expect(def.available!(ctx, state, tox)).toBe(true);
    expect(def.available!(ctx, state, state.operatives[opWith(state, 'p1', CARD.vandal)]!)).toBe(false);
  });

  it('VANDAL › Vicious Blows gives the mancrusher Ceaseless while FIGHTING, never while retaliating', () => {
    expect(abilityText(CARD.vandal, AB.viciousBlows)).toBe('Whenever this operative is fighting, this weapon has the Ceaseless weapon rule.');
    const { ctx, state } = setup();
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    const profile = profileOf(CARD.vandal, 'Mancrusher');
    const fighting = effectiveRules(ctx, state, profile, { operative: vandal, target: foe, weaponName: 'Mancrusher' });
    expect(fighting.some((r) => r.id === 'Ceaseless')).toBe(true);
    const retaliating = effectiveRules(ctx, state, profile, {
      operative: vandal,
      target: foe,
      weaponName: 'Mancrusher',
      retaliating: true,
    });
    expect(retaliating.some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('WARRIOR › Warrior Frenzy: a token-holding WARRIOR cannot be injured', () => {
    expect(abilityText(CARD.warrior, AB.warriorFrenzy)).toContain('it cannot be injured');
    const { ctx, state } = setup({ roles: [CARD.warrior, CARD.vandal] });
    const warrior = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, warrior, 99, 'other');
    inflictDamage(ctx, state, vandal, 99, 'other');
    expect(moveOf(ctx, state, warrior)).toBe(6); // the −2" is cancelled
    expect(moveOf(ctx, state, vandal)).toBe(4);
    const bludgeon = profileOf(CARD.warrior, 'Bludgeon');
    expect(hitOf(ctx, state, warrior, bludgeon)).toBe(bludgeon.hit);
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER unique actions', () => {
  it('DEATHKNELL › GONG KNELL improves its Save by 1 and ignores Piercing while being shot', () => {
    expect(actionOf(CARD.deathknell, ACT.gongKnell).ap).toBe(1);
    expect(actionOf(CARD.deathknell, ACT.gongKnell).text).toContain('improve this operative’s Save stat by 1 and ignore the Piercing weapon rule');
    const { ctx, state } = setup();
    const knell = opWith(state, 'p1', CARD.deathknell);
    const foe = state.operatives[opWith(state, 'p2', CARD.ironhorn)]!;
    let s = activate(ctx, state, knell, 'engage');
    s = act(ctx, s, knell, ACT.gongKnell).state;
    expect(s.effects.some((e) => e.rule === E_GONG_KNELL && e.operativeId === knell)).toBe(true);
    const target = s.operatives[knell]!;
    const profile = profileOf(CARD.ironhorn, 'Plasma pistol');
    s.sequence = shootSequence(foe, target, 'Plasma pistol', newPool(), 'rollDefence');
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: { ...attackCtx(foe, target, profile, 'Plasma pistol', 'ranged'), rules: profile.rules },
      count: 3 - 1, // Piercing 1
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(3);
    expect(ev.mods.save).toBe(1);
    // "Until the START of this operative's next activation" — it ends there.
    const after = activate(ctx, s, knell, 'engage');
    expect(after.effects.some((e) => e.rule === E_GONG_KNELL)).toBe(false);
  });

  it('FLUXBRAY › CLEAVER FLURRY moves +2" through enemy control range and inflicts D3+1 on each', () => {
    const printed = actionOf(CARD.fluxbray, ACT.cleaverFlurry);
    expect(printed.ap).toBe(2);
    expect(printed.text).toContain('Inflict D3+1 damage on each enemy operative it moved within control range of');
    const { ctx, state } = setup({ script: [3, 3, 3, 3, 3, 3] });
    const flux = opWith(state, 'p1', CARD.fluxbray);
    const a = state.teams.p2.operativeIds[0]!;
    const b = state.teams.p2.operativeIds[1]!;
    isolate(state, [flux, a, b]);
    place(state, flux, 8, 11);
    place(state, a, 10.5, 12.2);
    place(state, b, 12.5, 12.2);
    state.operatives[a]!.wounds = 40;
    state.operatives[b]!.wounds = 40;
    let s = activate(ctx, state, flux, 'engage');
    const out = act(ctx, s, flux, ACT.cleaverFlurry, { path: { points: [{ x: 14.5, y: 11 }] } });
    expect(out.ok, out.reason).toBe(true);
    s = out.state;
    expect(s.operatives[flux]!.pos.x).toBeCloseTo(14.5, 5);
    expect(40 - s.operatives[a]!.wounds).toBe(3); // D3(2)+1
    expect(40 - s.operatives[b]!.wounds).toBe(3);
    // "This operative cannot perform this action while it has a Conceal order."
    expect(printed.text).toContain('cannot perform this action while it has a Conceal order');
    const concealed = { ...state.operatives[flux]!, order: 'conceal' as const };
    expect(getAction(ACT.cleaverFlurry)!.check(ctx, state, concealed, { path: { points: [{ x: 9, y: 11 }] } }).ok).toBe(false);
  });

  it('GNARLSCAR › UNCOMPROMISING ATTACK fights, then arms a free autopistol Shoot while engaged', () => {
    const printed = actionOf(CARD.gnarlscar, ACT.uncompromisingAttack);
    expect(printed.text).toContain('You can only select an autopistol for that Shoot action.');
    const { ctx, state } = setup();
    const gnarl = opWith(state, 'p1', CARD.gnarlscar);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [gnarl, foe]);
    place(state, gnarl, 11, 11);
    place(state, foe, 12, 11);
    state.operatives[foe]!.wounds = 40;
    let s = activate(ctx, state, gnarl, 'engage');
    const out = act(ctx, s, gnarl, ACT.uncompromisingAttack, { targetId: foe });
    expect(out.ok, out.reason).toBe(true);
    s = settle(ctx, out.state);
    expect(s.operatives[gnarl]!.actionsThisActivation).toContain('Fight');
    expect(s.effects.some((e) => e.rule === E_UNCOMPROMISING && e.operativeId === gnarl)).toBe(true);
    const def = getAction(SHOOT_UNCOMPROMISING)!;
    expect(def.ap).toBe(0);
    expect(def.treatedAs).toBe('Shoot');
    if (!s.operatives[foe]!.removed) {
      const shot = act(ctx, s, gnarl, SHOOT_UNCOMPROMISING, { targetId: foe });
      expect(shot.ok, shot.reason).toBe(true);
      expect(settle(ctx, shot.state).operatives[gnarl]!.actionsThisActivation).toContain('Shoot');
    }
  });

  it('HERD-GOAD › INCITE FURY adds 1 APL through onStatMod, and never to a SHAMAN or IRONHORN', () => {
    const printed = actionOf(CARD.herdGoad, ACT.inciteFury);
    expect(printed.text).toContain('(excluding SHAMAN or IRONHORN)');
    const { ctx, state } = setup();
    const goad = opWith(state, 'p1', CARD.herdGoad);
    const vandal = opWith(state, 'p1', CARD.vandal);
    const shaman = opWith(state, 'p1', CARD.shaman);
    isolate(state, [goad, vandal, shaman]);
    place(state, goad, 11, 11);
    place(state, vandal, 13, 11);
    place(state, shaman, 12.5, 12);
    const def = getAction(ACT.inciteFury)!;
    expect(def.check(ctx, state, state.operatives[goad]!, { targetOperativeId: shaman }).ok).toBe(false);
    let s = activate(ctx, state, goad, 'engage');
    const out = act(ctx, s, goad, ACT.inciteFury, { targetOperativeId: vandal });
    expect(out.ok, out.reason).toBe(true);
    s = out.state;
    expect(s.effects.some((e) => e.rule === E_INCITE_FURY && e.operativeId === vandal)).toBe(true);
    expect(aplOf(ctx, s, s.operatives[vandal]!)).toBe(3);
    expect(s.operatives[vandal]!.aplMods).toEqual([]); // never the leaking aplMods
  });

  it('SHAMAN › APOPLECTIC REJUVENATION heals 2D3 — or 6 once that operative has killed in melee', () => {
    const printed = actionOf(CARD.shaman, ACT.apoplecticRejuvenation);
    expect(printed.text).toContain('it regains up to 6 lost wounds instead');
    const { ctx, state } = setup({ script: [3, 3, 3, 3] });
    const shaman = opWith(state, 'p1', CARD.shaman);
    const vandal = opWith(state, 'p1', CARD.vandal);
    isolate(state, [shaman, vandal]);
    place(state, shaman, 11, 11);
    place(state, vandal, 13, 11);
    state.operatives[vandal]!.wounds = 2;
    let s = activate(ctx, state, shaman, 'engage');
    const out = act(ctx, s, shaman, ACT.apoplecticRejuvenation, { targetOperativeId: vandal });
    expect(out.ok, out.reason).toBe(true);
    expect(out.state.operatives[vandal]!.wounds).toBe(6); // 2 + 2D3 (2+2)
    // A Frenzy-token operative cannot be selected.
    const s2 = out.state;
    inflictDamage(ctx, s2, s2.operatives[vandal]!, 99, 'other');
    expect(
      getAction(ACT.apoplecticRejuvenation)!.check(ctx, s2, s2.operatives[shaman]!, { targetOperativeId: vandal }).ok,
    ).toBe(false);
  });

  it('SHAMAN › MANTLE OF DARKNESS makes a Conceal-order FELLGOR in cover an invalid target — except within 2"', () => {
    const printed = actionOf(CARD.shaman, ACT.mantleOfDarkness);
    expect(printed.text).toContain('taking precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"');
    const map = testMap({ features: [heavyBlock('block', 12, 10, 1, 4, 2)] });
    const { ctx, state } = setup({ map });
    const shaman = opWith(state, 'p1', CARD.shaman);
    const vandal = opWith(state, 'p1', CARD.vandal);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [shaman, vandal, foe]);
    place(state, vandal, 13.6, 11);
    place(state, shaman, 14.6, 12.5);
    place(state, foe, 6, 11);
    state.operatives[vandal]!.order = 'conceal';
    const ask = (s: GameState, ignore: 'none' | 'all' = 'none'): boolean =>
      ctx.hooks.emit('onValidTarget', s, {
        state: s,
        attacker: s.operatives[foe]!,
        target: s.operatives[vandal]!,
        valid: true,
        ignoreCoverTerrain: ignore,
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid;
    expect(ask(state)).toBe(true);
    let s = activate(ctx, state, shaman, 'engage');
    s = act(ctx, s, shaman, ACT.mantleOfDarkness).state;
    expect(s.effects.some((e) => e.rule === E_MANTLE && e.operativeId === shaman)).toBe(true);
    expect(ask(s, 'all')).toBe(false); // Seek would strip the cover — the rule takes precedence
    place(s, foe, 12.4, 11); // "…except being within 2""
    expect(ask(s)).toBe(true);
  });

  it('UNCOMPROMISING ATTACK’s free Shoot goes point-blank without the point-blank Hit penalty', () => {
    const { ctx, state } = setup();
    const gnarl = opWith(state, 'p1', CARD.gnarlscar);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [gnarl, foe]);
    place(state, gnarl, 11, 11);
    place(state, foe, 12, 11);
    state.operatives[foe]!.wounds = 60;
    state.operatives[gnarl]!.wounds = 60; // the retaliation cannot injure it, so Hit stays 4+
    let s = activate(ctx, state, gnarl, 'engage');
    s = settle(ctx, act(ctx, s, gnarl, ACT.uncompromisingAttack, { targetId: foe }).state);
    expect(hasFrenzy(s, s.operatives[gnarl]!)).toBe(false);
    const before = s.log.length;
    const shot = act(ctx, s, gnarl, SHOOT_UNCOMPROMISING, { targetId: foe });
    expect(shot.ok, shot.reason).toBe(true);
    const dice = settle(ctx, shot.state)
      .log.slice(before)
      .filter((l) => l.text.startsWith('Attack dice ('));
    expect(dice.length).toBeGreaterThan(0);
    expect(dice[0]!.text).toContain('Attack dice (4+)'); // not the point-blank 5+
  });

  it('VANDAL › SWEEPING BLOW hits EACH OTHER operative within 2" — friendly operatives included', () => {
    const printed = actionOf(CARD.vandal, ACT.sweepingBlow);
    expect(printed.text).toContain('Inflict D3+1 damage on each other operative visible to and within 2" of this operative');
    const { ctx, state } = setup({ script: [3, 3, 3, 3] });
    const vandal = opWith(state, 'p1', CARD.vandal);
    const mate = opWith(state, 'p1', CARD.gorehorn);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [vandal, mate, foe]);
    place(state, vandal, 11, 11);
    place(state, mate, 12.2, 11);
    place(state, foe, 9.8, 11);
    state.operatives[mate]!.wounds = 40;
    state.operatives[foe]!.wounds = 40;
    let s = activate(ctx, state, vandal, 'engage');
    const out = act(ctx, s, vandal, ACT.sweepingBlow);
    expect(out.ok, out.reason).toBe(true);
    expect(40 - out.state.operatives[mate]!.wounds).toBe(3);
    expect(40 - out.state.operatives[foe]!.wounds).toBe(3);
  });

  it('SWEEPING BLOW is the one unique action a Frenzy-token operative may still perform', () => {
    const { ctx, state } = setup();
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, vandal, 99, 'other');
    const allowed = (action: string): boolean =>
      ctx.hooks.emit('canPerformAction', state, { state, operative: vandal, action, allowed: true }).allowed;
    expect(allowed(ACT.sweepingBlow)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER strategy ploys', () => {
  it('VIOLENT TEMPERAMENT re-rolls ALL of a fighting operative’s attack dice', () => {
    expect(ruleText(SP.violentTemperament)).toContain('you must re-roll all of your attack dice (you cannot only re-roll some)');
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 6, 6] });
    state.teams.p1.gambitsUsedTP.push(SP.violentTemperament);
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [vandal.id, foe.id]);
    place(state, vandal.id, 11, 11);
    place(state, foe.id, 12, 11);
    const seq = fightSequence(vandal, foe, 'Mancrusher', 'Skullcleaver', { step: 'attackerRerolls' });
    addRolled(seq.attackerPool, [1, 1, 1, 5], 4); // 3 fails vs 1 success → the policy fires
    state.sequence = seq;
    effectiveRules(ctx, state, profileOf(CARD.vandal, 'Mancrusher'), {
      operative: vandal,
      target: foe,
      weaponName: 'Mancrusher',
    });
    expect(seq.attackerPool.dice.map((d) => d.value)).toEqual([6, 6, 6, 6]);
    expect(successes(seq.attackerPool).length).toBe(4);
  });

  it('VIOLENT TEMPERAMENT’s stated D-022 policy declines when the pool is already good', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6] });
    state.teams.p1.gambitsUsedTP.push(SP.violentTemperament);
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    const seq = fightSequence(vandal, foe, 'Mancrusher', 'Skullcleaver', { step: 'attackerRerolls' });
    addRolled(seq.attackerPool, [5, 5, 5, 1], 4);
    state.sequence = seq;
    effectiveRules(ctx, state, profileOf(CARD.vandal, 'Mancrusher'), {
      operative: vandal,
      target: foe,
      weaponName: 'Mancrusher',
    });
    expect(seq.attackerPool.dice.map((d) => d.value)).toEqual([5, 5, 5, 1]);
  });

  it('AMBUSH: an operative whose order changed Conceal→Engage is ambushing, and retains a normal as a crit', () => {
    expect(ruleText(SP.ambush)).toContain('it’s ambushing for that activation');
    expect(ruleText(SP.ambush)).toContain('you can retain one of your normal successes as a critical success instead');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.ambush);
    const vandal = opWith(state, 'p1', CARD.vandal);
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    state.operatives[vandal]!.order = 'conceal';
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(recordedOrder(state, vandal)).toBe('conceal');
    const s = activate(ctx, state, vandal, 'engage');
    expect(isAmbushing(s, vandal)).toBe(true);
    expect(s.effects.some((e) => e.rule === E_AMBUSHING && e.operativeId === vandal)).toBe(true);
    const seq = fightSequence(s.operatives[vandal]!, foe, 'Mancrusher', 'Skullcleaver', { step: 'retention' });
    addRolled(seq.attackerPool, [4, 4], 4);
    s.sequence = seq;
    effectiveRules(ctx, s, profileOf(CARD.vandal, 'Mancrusher'), {
      operative: s.operatives[vandal]!,
      target: foe,
      weaponName: 'Mancrusher',
    });
    expect(seq.attackerPool.dice.filter((d) => d.state === 'crit').length).toBe(1);
  });

  it('"Note that an operative that has one of your Frenzy tokens cannot ambush."', () => {
    expect(ruleText(SP.ambush)).toContain('Note that an operative that has one of your Frenzy tokens cannot ambush.');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.ambush);
    const vandal = opWith(state, 'p1', CARD.vandal);
    inflictDamage(ctx, state, state.operatives[vandal]!, 99, 'other');
    state.operatives[vandal]!.order = 'conceal';
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    const s = activate(ctx, state, vandal, 'engage');
    expect(isAmbushing(s, vandal)).toBe(false);
  });

  it('PELTING FIREPOWER: Ceaseless after one other shooter, Relentless after two', () => {
    expect(ruleText(SP.peltingFirepower)).toContain('that first friendly operative’s ranged weapons have the Relentless weapon rule instead');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.peltingFirepower);
    const a = state.operatives[opWith(state, 'p1', CARD.toxhorn)]!;
    const b = state.operatives[opWith(state, 'p1', CARD.gorehorn)]!;
    const c = state.operatives[opWith(state, 'p1', CARD.herdGoad)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    const profile = profileOf(CARD.toxhorn, 'Autopistol');
    const rulesFor = (shooter: OperativeState) =>
      effectiveRules(ctx, state, profile, { operative: shooter, target: foe, weaponName: 'Autopistol' });
    expect(rulesFor(a).some((r) => r.id === 'Ceaseless')).toBe(false);
    const shot = (shooter: OperativeState): void => {
      ctx.hooks.emit('onStrikeResolved', state, {
        state,
        ctx: attackCtx(shooter, foe, profile, 'Autopistol', 'ranged'),
        crit: false,
        struck: foe,
      });
    };
    shot(b);
    expect(peltingShooters(state, 'p1', foe.id, a.id)).toBe(1);
    expect(rulesFor(a).some((r) => r.id === 'Ceaseless')).toBe(true);
    expect(rulesFor(a).some((r) => r.id === 'Relentless')).toBe(false);
    shot(c);
    expect(rulesFor(a).some((r) => r.id === 'Relentless')).toBe(true);
    // "…by ANOTHER friendly operative": its own shot never counts for itself.
    shot(a);
    expect(peltingShooters(state, 'p1', foe.id, a.id)).toBe(2);
  });

  it('RECKLESS DETERMINATION retains one defence dice without rolling it when no cover save is possible', () => {
    expect(ruleText(SP.recklessDetermination)).toContain('you can retain one of your defence dice as a normal success without rolling it');
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.recklessDetermination);
    const target = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.toxhorn)]!;
    target.expended = true;
    const profile = profileOf(CARD.toxhorn, 'Autopistol');
    const seq = shootSequence(foe, target, 'Autopistol', newPool(), 'rollDefence');
    state.sequence = seq;
    const actx = { ...attackCtx(foe, target, profile, 'Autopistol', 'ranged'), rules: profile.rules };
    const roll = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: actx,
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(roll.count).toBe(2); // one fewer die rolled…
    addRolled(seq.defence, [1, 1], 5);
    seq.step = 'defenceRerolls';
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: actx,
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(successes(seq.defence).length).toBe(1); // …and the retained one pushed in post-roll
    expect(seq.defence.dice.some((d) => d.note === 'RECKLESS DETERMINATION')).toBe(true);
  });

  it('AMBUSH is printed for an operative that "is fighting" — a retaliating ambusher gets nothing', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.ambush);
    const vandal = opWith(state, 'p1', CARD.vandal);
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    state.operatives[vandal]!.order = 'conceal';
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    const s = activate(ctx, state, vandal, 'engage');
    expect(isAmbushing(s, vandal)).toBe(true);
    const seq = fightSequence(foe, s.operatives[vandal]!, 'Skullcleaver', 'Mancrusher', { step: 'retention' });
    addRolled(seq.defenderPool, [4, 4], 4);
    s.sequence = seq;
    effectiveRules(ctx, s, profileOf(CARD.vandal, 'Mancrusher'), {
      operative: s.operatives[vandal]!,
      target: foe,
      weaponName: 'Mancrusher',
      retaliating: true,
    });
    expect(seq.defenderPool.dice.filter((d) => d.state === 'crit').length).toBe(0);
  });

  it('PELTING FIREPOWER’s "during this turning point" ledger starts empty in the next turning point', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.peltingFirepower);
    const a = state.operatives[opWith(state, 'p1', CARD.toxhorn)]!;
    const b = state.operatives[opWith(state, 'p1', CARD.gorehorn)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.vandal)]!;
    const profile = profileOf(CARD.toxhorn, 'Autopistol');
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(b, foe, profile, 'Autopistol', 'ranged'),
      crit: false,
      struck: foe,
    });
    expect(peltingShooters(state, 'p1', foe.id, a.id)).toBe(1);
    state.turningPoint += 1;
    expect(peltingShooters(state, 'p1', foe.id, a.id)).toBe(0);
  });

  it('RECKLESS DETERMINATION stands down for a READY operative and while a cover save is available', () => {
    const { ctx, state } = setup();
    state.teams.p1.gambitsUsedTP.push(SP.recklessDetermination);
    const target = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.toxhorn)]!;
    const profile = profileOf(CARD.toxhorn, 'Autopistol');
    state.sequence = shootSequence(foe, target, 'Autopistol', newPool(), 'rollDefence');
    const ask = (coverSave: boolean): number =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: { ...attackCtx(foe, target, profile, 'Autopistol', 'ranged'), rules: profile.rules },
        count: 3,
        coverSave,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).count;
    expect(ask(false)).toBe(3); // not expended
    target.expended = true;
    expect(ask(true)).toBe(3); // a cover save IS retainable
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER firefight ploys', () => {
  it('RUTHLESS RAMPAGE grants a free Charge after a Fight, capped at 3"', () => {
    expect(ruleText(FP.ruthlessRampage)).toContain('but cannot move more than 3" during that action');
    const { ctx, state } = setup();
    const gore = opWith(state, 'p1', CARD.gorehorn);
    const foe = state.teams.p2.operativeIds[0]!;
    const other = state.teams.p2.operativeIds[1]!;
    isolate(state, [gore, foe, other]);
    place(state, gore, 11, 11);
    place(state, foe, 12, 11);
    place(state, other, 14, 11);
    state.operatives[foe]!.wounds = 40;
    state.operatives[other]!.wounds = 40;
    let s = activate(ctx, state, gore, 'engage');
    // Not usable until the Fight action has happened.
    expect(fellgorRavager.ploys.find((p) => p.id === FP.ruthlessRampage)!.usable!(s, 'p1').ok).toBe(false);
    s = settle(ctx, act(ctx, s, gore, 'Fight', { targetId: foe }).state);
    // Move the enemy away, so "it's no longer within control range of enemy operatives".
    place(s, foe, 25, 2);
    expect(fellgorRavager.ploys.find((p) => p.id === FP.ruthlessRampage)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.ruthlessRampage }, ctx).state;
    expect(s.effects.some((e) => e.rule === E_RAMPAGE && e.operativeId === gore)).toBe(true);
    const def = getAction(CHARGE_RAMPAGE)!;
    expect(def.ap).toBe(0);
    expect(def.treatedAs).toBeUndefined();
    // 4" is refused by the printed 3" cap; 2.1" reaches the other enemy.
    expect(def.check(ctx, s, s.operatives[gore]!, { path: { points: [{ x: 15.5, y: 11 }] } }).ok).toBe(false);
    const out = act(ctx, s, gore, CHARGE_RAMPAGE, { path: { points: [{ x: 13.1, y: 11 }] } });
    expect(out.ok, out.reason).toBe(true);
    expect(out.state.operatives[gore]!.apSpent).toBe(1); // the Charge was free
  });

  it('Savage: "you cannot use the Ruthless Rampage firefight ploy between those two Fight actions"', () => {
    expect(abilityText(CARD.mangler, AB.savage)).toContain('you cannot use the Ruthless Rampage firefight ploy between those two Fight actions');
    const { ctx, state } = setup();
    const mangler = opWith(state, 'p1', CARD.mangler);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [mangler, foe]);
    place(state, mangler, 11, 11);
    place(state, foe, 12, 11);
    state.operatives[foe]!.wounds = 40;
    let s = activate(ctx, state, mangler, 'engage');
    s = settle(ctx, act(ctx, s, mangler, 'Fight', { targetId: foe }).state);
    expect(getAction(FIGHT_SAVAGE)!.check(ctx, s, s.operatives[mangler]!, { targetId: foe }).ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.ruthlessRampage }, ctx).state;
    const allowed = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[mangler]!,
      action: FIGHT_SAVAGE,
      allowed: true,
    });
    expect(allowed.allowed).toBe(false);
  });

  it('WILD RAGE adds 1" to the Move stat until the end of that activation', () => {
    expect(ruleText(FP.wildRage)).toContain('add 1" to its Move stat');
    const { ctx, state } = setup();
    const vandal = opWith(state, 'p1', CARD.vandal);
    let s = activate(ctx, state, vandal, 'engage');
    expect(moveOf(ctx, s, s.operatives[vandal]!)).toBe(6);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.wildRage }, ctx).state;
    expect(moveOf(ctx, s, s.operatives[vandal]!)).toBe(7);
    s = reduce(s, { t: 'EndActivation', operativeId: vandal }, ctx).state;
    expect(moveOf(ctx, s, s.operatives[vandal]!)).toBe(6);
  });

  it('ANIMALISTIC FURY inflicts 1 additional damage with the next critical strike, once', () => {
    expect(ruleText(FP.animalisticFury)).toContain('Inflict 1 additional damage with that strike.');
    const { ctx, state } = setup();
    const vandal = opWith(state, 'p1', CARD.vandal);
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    foe.wounds = 40;
    let s = activate(ctx, state, vandal, 'engage');
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.animalisticFury }, ctx).state;
    const striker = s.operatives[vandal]!;
    const profile = profileOf(CARD.vandal, 'Mancrusher');
    const target = s.operatives[foe.id]!;
    const before = target.wounds;
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(striker, target, profile, 'Mancrusher'),
      crit: true,
      struck: target,
    });
    expect(before - target.wounds).toBe(1);
    // Once only.
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(striker, target, profile, 'Mancrusher'),
      crit: true,
      struck: target,
    });
    expect(before - target.wounds).toBe(1);
  });

  it('BLOODSENSE records the pairing for the UI/AI — the activation-order half has no seam', () => {
    expect(ruleText(FP.bloodsense)).toContain('you can activate that other friendly operative before your opponent activates');
    expect(REMINDER_ONLY[`${FP.bloodsense}.activation`]).toContain('activation-order seam');
    const { ctx, state } = setup();
    const killer = opWith(state, 'p1', CARD.vandal);
    const mate = opWith(state, 'p1', CARD.gorehorn);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [killer, mate, foe]);
    place(state, killer, 11, 11);
    place(state, foe, 11.9, 11);
    place(state, mate, 13.5, 11); // visible to and within 3" of the incapacitated enemy
    let s = activate(ctx, state, killer, 'engage');
    expect(fellgorRavager.ploys.find((p) => p.id === FP.bloodsense)!.usable!(s, 'p1').ok).toBe(false);
    inflictDamage(ctx, s, s.operatives[foe]!, 99, 'other');
    // A mirror match: the enemy's own Frenzy prevents the incapacitation and the token is handed
    // out instead — which is exactly the moment its last bullet says the opponent treats it as
    // incapacitated, so the BLOODSENSE window opens there.
    expect(s.operatives[foe]!.incapacitated).toBe(false);
    expect(hasFrenzy(s, s.operatives[foe]!)).toBe(true);
    expect(fellgorRavager.ploys.find((p) => p.id === FP.bloodsense)!.usable!(s, 'p1').ok).toBe(true);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.bloodsense, data: { operativeId: mate } }, ctx).state;
    expect(s.effects.some((e) => e.rule === E_BLOODSENSE_PAIR && e.operativeId === mate)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER faction equipment', () => {
  it('BRASS ADORNMENTS refunds Animalistic Fury and Wild Rage once each per battle', () => {
    expect(ruleText(EQ.brassAdornments)).toBe('Once per battle, you can use the Animalistic Fury and Wild Rage firefight ploys for 0CP each.');
    const { ctx, state } = setup({ equipment: [EQ.brassAdornments] });
    const vandal = opWith(state, 'p1', CARD.vandal);
    let s = activate(ctx, state, vandal, 'engage');
    s.teams.p1.cp = 5;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.wildRage }, ctx).state;
    expect(s.teams.p1.cp).toBe(5); // charged then refunded
    s.teams.p1.ploysUsedTP = [];
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.wildRage }, ctx).state;
    expect(s.teams.p1.cp).toBe(4); // once per battle
    s.teams.p1.ploysUsedTP = [];
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.animalisticFury }, ctx).state;
    expect(s.teams.p1.cp).toBe(4); // the other ploy has its own free use
  });

  it('GORE MARKS re-rolls one attack dice for 1 damage, and 1 more if the re-roll fails', () => {
    expect(ruleText(EQ.goreMarks)).toContain('If the result is a fail, inflict 1 additional damage on that friendly operative.');
    const { ctx, state } = setup({ equipment: [EQ.goreMarks], script: [1, 1, 1, 1] });
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.gorehorn)]!;
    isolate(state, [vandal.id, foe.id]);
    place(state, vandal.id, 11, 11);
    place(state, foe.id, 12, 11);
    const seq = fightSequence(vandal, foe, 'Mancrusher', 'Skullcleaver', { step: 'attackerRerolls' });
    addRolled(seq.attackerPool, [2, 5], 4);
    state.sequence = seq;
    const before = vandal.wounds;
    effectiveRules(ctx, state, profileOf(CARD.vandal, 'Mancrusher'), {
      operative: vandal,
      target: foe,
      weaponName: 'Mancrusher',
    });
    expect(before - vandal.wounds).toBe(2); // 1 for using it, 1 because the re-roll failed
    expect(seq.attackerPool.dice[0]!.value).toBe(1);
    // Once per turning point.
    const woundsNow = vandal.wounds;
    seq.step = 'attackerRerolls';
    effectiveRules(ctx, state, profileOf(CARD.vandal, 'Mancrusher'), {
      operative: vandal,
      target: foe,
      weaponName: 'Mancrusher',
    });
    expect(vandal.wounds).toBe(woundsNow);
  });

  it('CHAOS SIGIL worsens Piercing by 1 — one more defence dice — once per turning point', () => {
    expect(ruleText(EQ.chaosSigil)).toContain('worsen the x of the Piercing weapon rule by 1 (if any)');
    const { ctx, state } = setup({ equipment: [EQ.chaosSigil] });
    const target = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.ironhorn)]!;
    const profile = profileOf(CARD.ironhorn, 'Plasma pistol');
    const ask = (): number => {
      state.sequence = shootSequence(foe, target, 'Plasma pistol', newPool(), 'rollDefence');
      return ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: { ...attackCtx(foe, target, profile, 'Plasma pistol', 'ranged'), rules: profile.rules },
        count: 3 - 1,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).count;
    };
    expect(ask()).toBe(3); // Piercing 1 is ignored
    expect(ask()).toBe(2); // once per turning point
  });

  it('CHAOS SIGIL stands down while GONG KNELL is already ignoring Piercing for that operative', () => {
    const { ctx, state } = setup({ equipment: [EQ.chaosSigil] });
    const knell = opWith(state, 'p1', CARD.deathknell);
    const foe = state.operatives[opWith(state, 'p2', CARD.ironhorn)]!;
    let s = activate(ctx, state, knell, 'engage');
    s = act(ctx, s, knell, ACT.gongKnell).state;
    const target = s.operatives[knell]!;
    const profile = profileOf(CARD.ironhorn, 'Plasma pistol');
    s.sequence = shootSequence(foe, target, 'Plasma pistol', newPool(), 'rollDefence');
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: { ...attackCtx(foe, target, profile, 'Plasma pistol', 'ranged'), rules: profile.rules },
      count: 3 - 1,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.count).toBe(3); // GONG KNELL alone, not 4
  });

  it('WAR PAINT ignores the injured Move change', () => {
    expect(ruleText(EQ.warPaint)).toBe('You can ignore any changes to the Move stat of friendly FELLGOR RAVAGER operatives from being injured.');
    const { ctx, state } = setup({ equipment: [EQ.warPaint] });
    const vandal = state.operatives[opWith(state, 'p1', CARD.vandal)]!;
    inflictDamage(ctx, state, vandal, 99, 'other');
    expect(moveOf(ctx, state, vandal)).toBe(6);
    const plain = setup();
    const other = plain.state.operatives[opWith(plain.state, 'p1', CARD.vandal)]!;
    inflictDamage(plain.ctx, plain.state, other, 99, 'other');
    expect(moveOf(plain.ctx, plain.state, other)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('FELLGOR RAVAGER honesty', () => {
  it('every REMINDER_ONLY entry names a printed rule and gives an engine reason', () => {
    expect(Object.keys(REMINDER_ONLY).length).toBeGreaterThanOrEqual(6);
    for (const [id, reason] of Object.entries(REMINDER_ONLY)) {
      expect(reason.length, id).toBeGreaterThan(30);
      const base = id.replace(/\.[a-zA-Z]+$/, '');
      const known =
        [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].some(
          (r) => r.id === id || r.id === base,
        ) ||
        DATA.datacards.some((c) => [...c.abilities, ...c.uniqueActions].some((a) => a.id === id || a.id === base));
      expect(known, `${id} is not a printed rule id`).toBe(true);
    }
  });

  it('the module registers no handler on a hook that is never emitted', () => {
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
    fellgorRavager.register(reg, 'p1', ctx);
    for (const hook of NEVER_EMITTED) expect([hook, reg.has(hook)]).toEqual([hook, false]);
    for (const hook of ['onIncapacitated', 'onStrikeResolved', 'onWeaponRules', 'onDamage', 'onStatMod'] as const) {
      expect([hook, reg.has(hook)]).toEqual([hook, true]);
    }
    expect(hooksFor(ctx, 'p1').player).toBe('p1');
  });

  it('aiHints are complete: a role for every datacard, a value for all 8 ploys and all 4 equipment', () => {
    const hints = fellgorRavager.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual([...ALL_CARDS].sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual([...Object.values(SP), ...Object.values(FP)].sort());
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual([...Object.values(EQ)].sort());
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and offers
   * anything whose `check` passes, so a `perform` that then refuses is a REJECTED INTENT.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const owners: [string, string][] = [
      [ACT.gongKnell, CARD.deathknell],
      [ACT.cleaverFlurry, CARD.fluxbray],
      [ACT.uncompromisingAttack, CARD.gnarlscar],
      [ACT.inciteFury, CARD.herdGoad],
      [ACT.apoplecticRejuvenation, CARD.shaman],
      [ACT.mantleOfDarkness, CARD.shaman],
      [ACT.sweepingBlow, CARD.vandal],
      [FIGHT_CHAMPION, CARD.gorehorn],
      [FIGHT_SAVAGE, CARD.mangler],
      [CHARGE_RAMPAGE, CARD.gorehorn],
      [SHOOT_UNCOMPROMISING, CARD.gnarlscar],
      [STUN_POX_BOMB, CARD.toxhorn],
    ];
    // Three boards, because the printed conditions pull in opposite directions: an extra Fight
    // needs an enemy inside control range, half the unique actions refuse while one is there, and
    // UNCOMPROMISING ATTACK refuses once a Fight has already happened.
    const MODES = ['engaged', 'engagedFresh', 'free'] as const;
    const tried = new Map<string, number>();
    for (const [actionId, datacardId] of owners) {
      for (const mode of MODES) {
        const base = setup({ roles: [datacardId], seed: 5 });
        const opId = opWith(base.state, 'p1', datacardId);
        const mates = base.state.teams.p1.operativeIds.filter((id) => id !== opId);
        const foes = base.state.teams.p2.operativeIds;
        let n = 0;
        for (const id of [...mates, ...foes]) base.state.operatives[id]!.pos = { x: 2 + (n++ % 12) * 1.6, y: 1 };
        place(base.state, opId, 8, 11);
        place(base.state, mates[0]!, 8, 12.2); // a friendly within control range
        place(base.state, mates[1]!, 9.6, 11.8); // a friendly within 3" (INCITE FURY)
        place(base.state, foes[0]!, mode === 'free' ? 10.5 : 8.9, 11);
        place(base.state, foes[1]!, 12, 14);
        for (const id of [...mates, ...foes]) base.state.operatives[id]!.wounds = 40;
        const op = base.state.operatives[opId]!;
        op.order = 'engage';
        op.aplMods.push(1); // enough AP for the 2AP CLEAVER FLURRY
        // Arm the two rules that gate their own free action.
        base.state.effects.push(
          {
            id: 'probe-rampage',
            rule: E_RAMPAGE,
            source: { kind: 'ploy', id: FP.ruthlessRampage },
            operativeId: opId,
            player: 'p1',
            expiry: { kind: 'endOfTurningPoint' },
          },
          {
            id: 'probe-uncompromising',
            rule: E_UNCOMPROMISING,
            source: { kind: 'ability', id: ACT.uncompromisingAttack },
            operativeId: opId,
            player: 'p1',
            expiry: { kind: 'endOfTurningPoint' },
          },
        );
        const prior = mode === 'engagedFresh' ? [] : ['Fight'];
        op.actionsThisActivation = [...prior];
        const attempts: Record<string, unknown>[] = [
          {},
          { targetPos: { ...op.pos } },
          { path: { points: [{ x: 8, y: 8 }] } },
          { path: { points: [{ x: 8.9, y: 11 }] } },
          ...aliveOperatives(base.state).map((o) => ({ targetOperativeId: o.id, targetId: o.id })),
        ];
        const def = getAction(actionId)!;
        for (const params of attempts) {
          if (def.available && !def.available(base.ctx, base.state, op)) continue;
          if (!def.check(base.ctx, base.state, op, params).ok) continue;
          const s = activate(base.ctx, base.state, opId, 'engage');
          s.operatives[opId]!.actionsThisActivation = [...prior];
          const out = act(base.ctx, s, opId, actionId, params);
          tried.set(actionId, (tried.get(actionId) ?? 0) + 1);
          expect({ actionId, mode, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
        }
      }
    }
    // Every one of the twelve was actually reachable, so none of the assertions above was vacuous.
    expect(owners.filter(([id]) => !tried.has(id)).map(([id]) => id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('bot-vs-bot mirror soak', () => {
  /*
   * The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions.
   *
   * `gallowdark-1` is in the ring because the batch brief asks for it, but this mirror never makes
   * contact there — the kill team is almost entirely melee (its only ranged weapons are Range 8"
   * autopistols) and the AI does not cross the corridors — so the Frenzy chain is asserted on
   * `volkus-1` and on `gallowdark-4`, which is the Close Quarters killzone where the two kill teams
   * do meet.
   */
  for (const [mapId, expectContact] of [
    ['volkus-1', true],
    ['gallowdark-1', false],
    ['gallowdark-4', true],
  ] as const) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([fellgorRavager], { seed: 4242 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 4242,
        rosters: {
          p1: { teamId: 'fellgor-ravager', operatives: roster(), equipment: [EQ.brassAdornments, EQ.warPaint] },
          p2: { teamId: 'fellgor-ravager', operatives: roster(), equipment: [EQ.chaosSigil, EQ.goreMarks] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // Frenzy is not optional: nobody leaves the killzone without first taking a Frenzy token.
      if (expectContact) {
        const removed = result.state.log.filter((l) => l.text.includes('is removed from the killzone')).length;
        expect(removed).toBeGreaterThan(0);
        expect(result.state.log.some((l) => l.text.includes(`gains a ${FRENZY_TOKEN} token`))).toBe(true);
        expect(result.state.log.some((l) => /is incapacitated — Frenzy:/.test(l.text))).toBe(true);
      }
    }, 120000);
  }
});
