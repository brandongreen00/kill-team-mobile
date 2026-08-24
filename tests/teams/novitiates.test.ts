/**
 * NOVITIATES. Every test quotes the printed rule it pins, read out of
 * `data/teams/novitiates.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/novitiates/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, actionCost, getAction } from '../../src/core/actions.ts';
import { reduce } from '../../src/core/reducer.ts';
import { apBudgetOf, aplOf, freeApOf, inflictDamage, markerController } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { moveBudget } from '../../src/core/movement.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import type { DicePool, Die, DieState } from '../../src/core/dice.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import {
  ABSOLUTION_FIGHTS,
  ACTS_OF_FAITH,
  ACT_DECISION,
  BLAZE_DECISION,
  BLAZE_TOKEN,
  C,
  EQ,
  FP,
  SP,
  WHIP_FIGHT,
  faithPoints,
  gainFaith,
  novitiates,
} from '../../src/teams/novitiates/index.ts';
import { plagueMarines } from '../../src/teams/plague-marines/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';

const DATA = teamData('novitiates');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, id: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === id)!.text;
const actionText = (cardId: string, id: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === id)!.text;

const ACTS = 'novitiates.rule.acts-of-faith';

/**
 * `defaultRoster` fills the nine list slots with the first repeatable row it can, which for
 * this team is four MILITANTs. `rosterIncluding` swaps the trailing ones out, so each roster
 * below names the SUPERIOR (or the leader would be swapped away) plus what the rules need.
 */
const CORE = [
  C.superior,
  C.condemnor,
  C.dialogus,
  C.duellist,
  C.exactor,
  C.hospitaller,
  C.penitent,
  C.preceptor,
  C.pronatus,
];
/** …and a second roster for the two the default roster leaves out. */
const FLAME = [C.superior, C.condemnor, C.dialogus, C.duellist, C.exactor, C.hospitaller, C.purgatus, C.reliquarius];

function setup(opts: { equipment?: string[]; roles?: string[]; script?: number[]; seed?: number } = {}): {
  ctx: ReturnType<typeof teamContext>;
  state: GameState;
} {
  const ctx = teamContext([novitiates, plagueMarines], {
    ...(opts.script ? { script: opts.script } : {}),
    seed: opts.seed ?? 7,
  });
  const state = battle({
    ctx,
    p1: {
      module: novitiates,
      picks: rosterIncluding(novitiates, opts.roles ?? CORE),
      ...(opts.equipment ? { equipment: opts.equipment } : {}),
    },
    p2: { module: plagueMarines },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const teamId = cardId.startsWith('novitiates') ? 'novitiates' : 'plague-marines';
  const data = teamId === 'novitiates' ? DATA : teamData('plague-marines');
  const w = data.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return (w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0])!;
};

function pool(dice: [number, DieState][]): DicePool {
  const out: Die[] = dice.map(([value, state], i) => ({ id: i + 1, value, state, rolled: true }));
  return { dice: out, nextId: out.length + 1 };
}

function makeShoot(
  state: GameState,
  spec: {
    attackerId: string;
    targetId: string;
    weaponName: string;
    attack?: DicePool;
    defence?: DicePool;
    step?: ShootSequence['step'];
    obscured?: boolean;
    damage?: number;
  },
): ShootSequence {
  const seq: ShootSequence = {
    kind: 'shoot',
    step: spec.step ?? 'attackRerolls',
    attackerId: spec.attackerId,
    targetId: spec.targetId,
    queue: [],
    resolvedTargets: [],
    weaponName: spec.weaponName,
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: spec.obscured ?? false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: spec.attack ?? pool([]),
    defence: spec.defence ?? pool([]),
    usedRerolls: [],
    usedRetention: [],
    damage: spec.damage ?? 0,
    useCounted: false,
    attacker: state.operatives[spec.attackerId]!.player,
    defender: state.operatives[spec.targetId]!.player,
    free: false,
  };
  state.sequence = seq;
  return seq;
}

function makeFight(
  state: GameState,
  spec: {
    attackerId: string;
    defenderId: string;
    attackerWeapon: string;
    defenderWeapon?: string;
    attackerPool?: DicePool;
    defenderPool?: DicePool;
    step?: FightSequence['step'];
    turn?: 'attacker' | 'defender';
  },
): FightSequence {
  const seq: FightSequence = {
    kind: 'fight',
    step: spec.step ?? 'attackerRerolls',
    attackerId: spec.attackerId,
    defenderId: spec.defenderId,
    attackerWeapon: spec.attackerWeapon,
    ...(spec.defenderWeapon ? { defenderWeapon: spec.defenderWeapon } : {}),
    defenderCanRetaliate: Boolean(spec.defenderWeapon),
    attackerPool: spec.attackerPool ?? pool([]),
    defenderPool: spec.defenderPool ?? pool([]),
    turn: spec.turn ?? 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: state.operatives[spec.attackerId]!.player,
    defender: state.operatives[spec.defenderId]!.player,
    free: false,
    hatchway: false,
  };
  state.sequence = seq;
  return seq;
}

function actx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  type: 'ranged' | 'melee',
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

/** Answer the ACT OF FAITH window with `optionId`, without advancing the sequence further. */
function answer(
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  kind: string,
  optionId: string,
): GameState {
  const d = state.pending.find((x) => x.kind === kind);
  expect(d, `a ${kind} decision is pending`).toBeDefined();
  const option = d!.options.find((o) => o.id === optionId);
  return reduce(
    state,
    { t: 'ResolveDecision', decisionId: d!.id, optionId, ...(option?.data ? { data: option.data } : {}) },
    ctx,
  ).state;
}

// ---------------------------------------------------------------------------
describe('NOVITIATES data (pinned against data/teams/novitiates.json)', () => {
  it('has 12 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(12);
    const superior = DATA.datacards.find((c) => c.id === C.superior)!;
    expect(superior).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 9, base: { shape: 'round', mm: 32 } });
    expect(superior.keywords).toEqual(['NOVITIATE', 'IMPERIUM', 'ADEPTA SORORITAS', 'LEADER', 'SUPERIOR']);
    for (const card of DATA.datacards.filter((c) => c.id !== C.superior)) {
      expect(card, card.id).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 7, base: { shape: 'round', mm: 28 } });
      expect(card.keywords.slice(0, 3)).toEqual(['NOVITIATE', 'IMPERIUM', 'ADEPTA SORORITAS']);
    }
    expect(DATA.datacards.find((c) => c.id === C.hospitaller)!.keywords).toContain('MEDIC');
  });

  it('pins every weapon profile the team rules read', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat(C.superior)).toEqual([
      'Plasma pistol|standard|ranged|4|3|3|5|Range 8"+Piercing 1',
      'Plasma pistol|supercharge|ranged|4|3|4|5|Range 8"+Hot+Lethal 5++Piercing 1',
      'Relic bolt pistol||ranged|4|3|3|5|Range 8"+Lethal 5+',
      'Relic boltgun||ranged|4|3|3|5|Lethal 5+',
      'Gun butt||melee|3|3|2|3|',
      'Power weapon||melee|4|3|4|6|Lethal 5+',
    ]);
    expect(flat(C.condemnor)).toEqual([
      'Condemnor stakethrower||ranged|4|3|3|3|Devastating 2+Piercing Crits 1+Silent+Anti-PSYKER*',
      'Null rod||melee|4|4|3|3|Shock+Anti-PSYKER*',
    ]);
    expect(flat(C.duellist)).toEqual([
      'Autopistol||ranged|4|4|2|3|Range 8"',
      'Duelling blades||melee|4|3|4|5|Ceaseless+Riposte*',
    ]);
    expect(flat(C.penitent)).toEqual([
      'Autopistol||ranged|4|4|2|3|Range 8"',
      'Penitent eviscerator||melee|4|4|5|6|Brutal+Zealous Rage*',
    ]);
    expect(flat(C.purgatus)).toEqual([
      'Ministorum flamer||ranged|4|2|4|4|Range 8"+Saturate+Torrent 2"',
      'Gun butt||melee|3|4|2|3|',
    ]);
    expect(flat(C.exactor)).toEqual([
      'Neural whips|ranged|ranged|5|3|2|3|Range 3"+Lethal 5++Stun',
      'Neural whips|melee|melee|5|3|2|3|Lethal 5++Shock',
    ]);
  });

  it('exposes 1 faction rule, 4 strategy ploys, 4 firefight ploys, 4 equipment and 3 rare rules', () => {
    expect(DATA.factionRules.map((r) => r.id)).toEqual([ACTS]);
    expect(novitiates.ploys.filter((p) => p.kind === 'strategy').map((p) => p.id)).toEqual([
      SP.ardentVengeance,
      SP.defendersOfTheFaith,
      SP.blessedRejuvenation,
      SP.righteousAdvance,
    ]);
    expect(novitiates.ploys.filter((p) => p.kind === 'firefight').map((p) => p.id)).toEqual([
      FP.gloriousMartyrdom,
      FP.blazingInferno,
      FP.blindingAura,
      FP.guidedByFaith,
    ]);
    expect(novitiates.equipment.map((e) => e.id)).toEqual([
      EQ.iconOfFaith,
      EQ.sanctifiedRounds,
      EQ.autoChastisers,
      EQ.holyEmbrocations,
    ]);
    expect(DATA.rareWeaponRules).toEqual(['AntiPSYKER', 'Riposte', 'ZealousRage']);
    // 14 datacard abilities and 5 unique actions across the 12 datacards.
    expect(DATA.datacards.reduce((n, c) => n + c.abilities.length, 0)).toBe(14);
    expect(DATA.datacards.reduce((n, c) => n + c.uniqueActions.length, 0)).toBe(5);
  });

  it('pins the printed selection rules and produces a legal default kill team', () => {
    expect(DATA.selection.leader.role).toBe('SUPERIOR');
    expect(DATA.selection.totalOperatives).toBe(10);
    expect(DATA.selection.groups[1]!.count).toBe(9);
    // "Other than MILITANT and PURGATUS operatives, your kill team can only include each
    //  operative on this list once. Your kill team can only include up to two PURGATUS."
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['MILITANT', 'PURGATUS'] },
      { kind: 'maxCount', role: 'PURGATUS', max: 2 },
    ]);
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(10);
    const validation = validateRosterFor(DATA, picks);
    expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(picks[0]!.datacardId).toBe(C.superior);
  });

  it('the shared validator enforces both printed selection constraints', () => {
    const militants = (n: number) => Array.from({ length: n }, () => ({ datacardId: C.militant }));
    // "Your kill team can only include up to two PURGATUS operatives."
    const threePurgatus = validateRosterFor(DATA, [
      { datacardId: C.superior },
      { datacardId: C.purgatus },
      { datacardId: C.purgatus },
      { datacardId: C.purgatus },
      ...militants(6),
    ]);
    expect(threePurgatus.errors.some((e) => /more than 2 PURGATUS/.test(e))).toBe(true);
    // "Other than MILITANT and PURGATUS operatives, your kill team can only include each
    //  operative on this list once."
    const twoCondemnor = validateRosterFor(DATA, [
      { datacardId: C.superior },
      { datacardId: C.condemnor },
      { datacardId: C.condemnor },
      ...militants(7),
    ]);
    expect(twoCondemnor.errors.some((e) => /CONDEMNOR selected 2 times/.test(e))).toBe(true);
    // Two MILITANTs are fine — the printed exception.
    const legal = validateRosterFor(DATA, [{ datacardId: C.superior }, ...militants(9)]);
    expect(legal.errors.some((e) => /only include each operative/.test(e))).toBe(false);
  });

  it('slices the three ACTS OF FAITH out of the one printed faction rule', () => {
    expect(ACTS_OF_FAITH.map((a) => `${a.name}:${a.cost}`)).toEqual([
      'GUIDANCE:1',
      'BLESSING:2',
      'INTERVENTION:3',
    ]);
    for (const act of ACTS_OF_FAITH) expect(rule(ACTS)).toContain(act.effect);
    expect(ACTS_OF_FAITH.find((a) => a.id === 'guidance')!.effect).toBe('You can re-roll one of your dice.');
    expect(rule(ACTS)).toContain('You cannot use more than one ACT OF FAITH per sequence');
  });

  it('has complete aiHints — a role per datacard, a value per ploy and per equipment option', () => {
    const hints = novitiates.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual(novitiates.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual(novitiates.equipment.map((e) => e.id).sort());
  });
});

// ---------------------------------------------------------------------------
describe('Acts of Faith — the faith-point economy', () => {
  it('"In the Ready step … you gain a number of Faith points equal to half the number of friendly NOVITIATE operatives that haven\'t been incapacitated (rounding up)"', () => {
    const { ctx, state } = setup();
    expect(rule(ACTS)).toContain('rounding up');
    expect(faithPoints(state, 'p1')).toBe(0);
    const ev = ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(ev.cp).toBe(1); // the rule grants Faith points, not CP
    expect(faithPoints(state, 'p1')).toBe(5); // 10 operatives → ceil(10/2)
    // Three casualties leaves seven standing → ceil(7/2) = 4.
    for (const id of state.teams.p1.operativeIds.slice(0, 3)) state.operatives[id]!.incapacitated = true;
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(faithPoints(state, 'p1')).toBe(9);
  });

  it('GUIDANCE (1 Faith point): "You can re-roll one of your dice" while a friendly NOVITIATE is shooting', () => {
    const { ctx, state } = setup({ script: [6] });
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 3, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([
        [1, 'fail'],
        [5, 'normal'],
      ]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    const decision = state.pending.find((d) => d.kind === ACT_DECISION);
    expect(decision, 'the Roll Attack Dice step opens the ACT OF FAITH window').toBeDefined();
    expect(decision!.options.map((o) => o.id)).toEqual(['guidance', 'intervention', 'blessing', 'decline']);
    const out = answer(ctx, state, ACT_DECISION, 'guidance');
    expect(faithPoints(out, 'p1')).toBe(2);
    const seqOut = out.sequence as ShootSequence;
    expect(seqOut.attack.dice[0]!.value).toBe(6); // the fail was re-rolled into a 6
    expect(seqOut.attack.dice[0]!.state).toBe('crit');
  });

  it('BLESSING (2 Faith points): "You can retain one of your normal successes as a critical success instead"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 2, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([
        [4, 'normal'],
        [1, 'fail'],
      ]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    // INTERVENTION costs 3 and is not affordable, so it is not offered.
    const decision = state.pending.find((d) => d.kind === ACT_DECISION)!;
    expect(decision.options.map((o) => o.id)).toEqual(['guidance', 'blessing', 'decline']);
    const out = answer(ctx, state, ACT_DECISION, 'blessing');
    expect(faithPoints(out, 'p1')).toBe(0);
    expect((out.sequence as ShootSequence).attack.dice[0]!.state).toBe('crit');
  });

  it('INTERVENTION (3 Faith points): "You can retain one of your fails as a normal success instead of discarding it"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 3, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([
        [2, 'fail'],
        [3, 'fail'],
      ]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    const out = answer(ctx, state, ACT_DECISION, 'intervention');
    expect(faithPoints(out, 'p1')).toBe(0);
    const dice = (out.sequence as ShootSequence).attack.dice;
    expect(dice.filter((d) => d.state === 'normal')).toHaveLength(1);
  });

  it('"You cannot use more than one ACT OF FAITH per sequence" — the window is offered once', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 6, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([[1, 'fail']]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    const emit = (s: GameState): void => {
      ctx.hooks.emit('onRollAttack', s, {
        state: s,
        ctx: actx(s.operatives[shooter.id]!, s.operatives[foe.id]!, 'Autopistol', autogun, 'ranged'),
        dice: [],
        rerolls: [],
      });
    };
    emit(state);
    const out = answer(ctx, state, ACT_DECISION, 'guidance');
    emit(out);
    expect(out.pending.filter((d) => d.kind === ACT_DECISION)).toHaveLength(0);
  });

  it('"…or an operative is shooting it, in the … Roll Defence Dice step" opens the window for the defender', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', C.militant)]!;
    const shooter = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 3, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: target.id,
      weaponName: 'Bolt pistol',
      defence: pool([
        [1, 'fail'],
        [5, 'normal'],
      ]),
      step: 'defenceRerolls',
    });
    const pistol = profileOf('plague-marines.icon-bearer', 'Bolt pistol');
    ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: actx(shooter, target, 'Bolt pistol', pistol, 'ranged'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    const decision = state.pending.find((d) => d.kind === ACT_DECISION);
    expect(decision).toBeDefined();
    expect(decision!.who).toBe('p1');
    // AUTO-CHASTISERS is only offered "in the Roll Attack Dice step", so never here.
    expect(decision!.options.some((o) => o.id.startsWith('chastise:'))).toBe(false);
    const out = answer(ctx, state, ACT_DECISION, 'intervention');
    expect((out.sequence as ShootSequence).defence.dice.filter((d) => d.state === 'normal')).toHaveLength(2);
  });

  it('"…fighting or retaliating, in the Roll Attack Dice … step" opens the window in a fight', () => {
    const { ctx, state } = setup();
    const fighter = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 3, 'test');
    makeFight(state, {
      attackerId: fighter.id,
      defenderId: foe.id,
      attackerWeapon: 'Duelling blades',
      defenderWeapon: 'Plague knife',
      attackerPool: pool([
        [1, 'fail'],
        [4, 'normal'],
      ]),
    });
    const blades = profileOf(C.duellist, 'Duelling blades');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: actx(fighter, foe, 'Duelling blades', blades, 'melee'),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(state.pending.find((d) => d.kind === ACT_DECISION)).toBeDefined();
    const out = answer(ctx, state, ACT_DECISION, 'intervention');
    expect((out.sequence as FightSequence).attackerPool.dice.filter((d) => d.state === 'normal')).toHaveLength(2);
  });

  it('an ACT OF FAITH that cannot land on a die costs nothing (obscured forbids retaining crits)', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 2, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([[4, 'normal']]),
      obscured: true,
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    const out = answer(ctx, state, ACT_DECISION, 'blessing');
    expect(faithPoints(out, 'p1')).toBe(2);
    expect((out.sequence as ShootSequence).attack.dice[0]!.state).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
describe('NOVITIATES strategy ploys', () => {
  it('ARDENT VENGEANCE: "against an expended enemy operative, that friendly operative\'s weapons have the Punishing weapon rule"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.ardentVengeance }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', C.militant)]!;
    const foe = s.operatives[opWith(s, 'p2', 'plague-marines.icon-bearer')]!;
    const autogun = profileOf(C.militant, 'Autopistol');
    const ready = effectiveRules(ctx, s, autogun, { operative: shooter, target: foe, weaponName: 'Autopistol' });
    expect(ready.some((r) => r.id === 'Punishing')).toBe(false);
    foe.expended = true;
    const spent = effectiveRules(ctx, s, autogun, { operative: shooter, target: foe, weaponName: 'Autopistol' });
    expect(spent.some((r) => r.id === 'Punishing')).toBe(true);
  });

  it('DEFENDERS OF THE FAITH: "halve the damage inflicted (rounding up and to a minimum of 2) … from one success"', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!;
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective');
    expect(objective, 'the test map has an objective marker').toBeDefined();
    victim.pos = { x: objective!.pos.x + 0.3, y: objective!.pos.y };
    foe.pos = { x: objective!.pos.x + 1.2, y: objective!.pos.y };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.defendersOfTheFaith }, ctx).state;
    const v = s.operatives[victim.id]!;
    makeFight(s, {
      attackerId: foe.id,
      defenderId: v.id,
      attackerWeapon: 'Flail of Corruption',
      defenderWeapon: 'Autopistol',
    });
    const before = v.wounds;
    // Flail of Corruption: Normal Dmg 5 → halved and rounded up is 3.
    const flail = profileOf('plague-marines.fighter', 'Flail of Corruption');
    inflictDamage(ctx, s, v, flail.dmgN, 'attack');
    expect(before - v.wounds).toBe(Math.max(2, Math.ceil(flail.dmgN / 2)));
    // "…from ONE success": the second success in the same sequence is unaffected.
    const mid = v.wounds;
    inflictDamage(ctx, s, v, flail.dmgN, 'attack');
    expect(mid - v.wounds).toBe(flail.dmgN);
  });

  it('BLESSED REJUVENATION: "Whenever you spend Faith points … can regain up to D3 lost wounds"', () => {
    const { ctx, state } = setup({ script: [6, 6] });
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    shooter.wounds = 3;
    gainFaith(state, 'p1', 3, 'test');
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: SP.blessedRejuvenation }, ctx).state;
    makeShoot(s, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([[1, 'fail']]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: actx(s.operatives[shooter.id]!, s.operatives[foe.id]!, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    s = answer(ctx, s, ACT_DECISION, 'guidance');
    // "at the end of that action" — bounded to the activation (no end-of-action hook).
    expect(s.operatives[shooter.id]!.wounds).toBe(3);
    s.pending = [];
    s.sequence = null;
    s = activate(ctx, s, shooter.id);
    s = reduce(s, { t: 'EndActivation', operativeId: shooter.id }, ctx).state;
    expect(s.operatives[shooter.id]!.wounds).toBeGreaterThan(3);
  });

  it('RIGHTEOUS ADVANCE: "Up to one third … can immediately perform a free Dash action", never in the first turning point', () => {
    const { ctx, state } = setup();
    expect(rule(SP.righteousAdvance)).toContain('You cannot use this ploy during the first turning point.');
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const tp1 = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(tp1.some((o) => o.id === SP.righteousAdvance)).toBe(false);
    state.turningPoint = 2;
    const tp2 = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(tp2.some((o) => o.id === SP.righteousAdvance)).toBe(true);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.righteousAdvance }, ctx).state;
    const granted = s.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(granted).toHaveLength(3); // 10 NOVITIATE operatives → floor(10/3)
    const op = s.operatives[granted[0]!.operativeId!]!;
    // "…can immediately perform a free Dash action" grants AP, not APL: the stat is unchanged
    // and the budget is one higher (docs/DECISIONS.md D-100).
    const printedApl = DATA.datacards.find((c) => c.id === op.datacardId)?.apl ?? 2;
    expect(aplOf(ctx, s, op)).toBe(printedApl);
    expect(freeApOf(s, op)).toBe(1);
    expect(apBudgetOf(ctx, s, op)).toBe(printedApl + 1);
  });
});

// ---------------------------------------------------------------------------
describe('NOVITIATES firefight ploys', () => {
  it('GLORIOUS MARTYRDOM: "For each enemy operative visible to and within 2\\" of it, you gain 1 Faith point and inflict D3 damage"', () => {
    const { ctx, state } = setup({ script: [6, 6] });
    const martyr = state.operatives[opWith(state, 'p1', C.militant)]!;
    const near = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const far = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!;
    martyr.pos = { x: 15, y: 11 };
    near.pos = { x: 16.2, y: 11 };
    far.pos = { x: 25, y: 11 };
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.gloriousMartyrdom }, ctx).state;
    const nearWounds = s.operatives[near.id]!.wounds;
    const farWounds = s.operatives[far.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[martyr.id]!, 99, 'attack');
    expect(faithPoints(s, 'p1')).toBe(1);
    expect(s.operatives[near.id]!.wounds).toBeLessThan(nearWounds);
    expect(s.operatives[far.id]!.wounds).toBe(farWounds);
  });

  it('Inspirational Example "has no effect when using the Glorious Martyrdom firefight ploy"', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6] });
    const superior = state.operatives[opWith(state, 'p1', C.superior)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    superior.pos = { x: 15, y: 11 };
    foe.pos = { x: 16.2, y: 11 };
    foe.wounds = 1; // the D3 will incapacitate it
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.gloriousMartyrdom }, ctx).state;
    inflictDamage(ctx, s, s.operatives[superior.id]!, 99, 'attack');
    expect(s.operatives[foe.id]!.incapacitated).toBe(true);
    // 1 Faith point from Glorious Martyrdom only — Inspirational Example is suppressed.
    expect(faithPoints(s, 'p1')).toBe(1);
  });

  it('BLAZING INFERNO: a Ministorum flamer crit gives "one of your Blaze tokens", and the token burns on activation', () => {
    const { ctx, state } = setup({ roles: FLAME, script: [6, 6, 6] });
    const purgatus = state.operatives[opWith(state, 'p1', C.purgatus)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    let s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.blazingInferno }, ctx).state;
    makeShoot(s, {
      attackerId: purgatus.id,
      targetId: foe.id,
      weaponName: 'Ministorum flamer',
      damage: 4,
    });
    const flamer = profileOf(C.purgatus, 'Ministorum flamer');
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: actx(s.operatives[purgatus.id]!, s.operatives[foe.id]!, 'Ministorum flamer', flamer, 'ranged'),
      crit: true,
      struck: s.operatives[foe.id]!,
    });
    expect(s.effects.some((e) => e.rule === BLAZE_TOKEN && e.operativeId === foe.id && e.player === 'p1')).toBe(true);
    s.sequence = null;
    const before = s.operatives[foe.id]!.wounds;
    s = activate(ctx, s, foe.id);
    expect(s.operatives[foe.id]!.wounds).toBeLessThan(before);
    const decision = s.pending.find((d) => d.kind === BLAZE_DECISION);
    expect(decision, 'the controlling player is offered the -1 APL trade').toBeDefined();
    expect(decision!.who).toBe('p2');
    const out = answer(ctx, s, BLAZE_DECISION, 'remove');
    expect(out.effects.some((e) => e.rule === BLAZE_TOKEN && e.operativeId === foe.id)).toBe(false);
    expect(aplOf(ctx, out, out.operatives[foe.id]!)).toBe(2); // PLAGUE MARINE APL 3, -1
  });

  it('BLINDING AURA: "while that friendly operative is more than 2\\" from that enemy operative, your opponent cannot select it as a valid target"', () => {
    const { ctx, state } = setup();
    const ward = state.operatives[opWith(state, 'p1', C.militant)]!;
    const enemy = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    ward.pos = { x: 15, y: 11 };
    enemy.pos = { x: 21, y: 11 };
    state.activeOperativeId = enemy.id;
    state.activePlayer = 'p2';
    const s = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: FP.blindingAura, data: { operativeId: ward.id, enemyId: enemy.id } },
      ctx,
    ).state;
    const far = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: s.operatives[enemy.id]!,
      target: s.operatives[ward.id]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(far.valid).toBe(false);
    s.operatives[ward.id]!.pos = { x: 20.5, y: 11 }; // within 2"
    const near = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: s.operatives[enemy.id]!,
      target: s.operatives[ward.id]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(near.valid).toBe(true);
  });

  it('GUIDED BY FAITH: "whenever that operative is shooting an operative within 6\\" of it, that weapon has the Seek Light weapon rule"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const close = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const away = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!;
    shooter.pos = { x: 15, y: 11 };
    close.pos = { x: 19, y: 11 };
    away.pos = { x: 26, y: 11 };
    let s = activate(ctx, state, shooter.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.guidedByFaith }, ctx).state;
    const autogun = profileOf(C.militant, 'Autopistol');
    const sh = s.operatives[shooter.id]!;
    expect(
      effectiveRules(ctx, s, autogun, { operative: sh, target: s.operatives[close.id]!, weaponName: 'Autopistol' }).some(
        (r) => r.id === 'SeekLight',
      ),
    ).toBe(true);
    expect(
      effectiveRules(ctx, s, autogun, { operative: sh, target: s.operatives[away.id]!, weaponName: 'Autopistol' }).some(
        (r) => r.id === 'SeekLight',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('NOVITIATES faction equipment', () => {
  it('ICON OF FAITH: "you can use up to two ACTS OF FAITH during a sequence, but each one must be different"', () => {
    const { ctx, state } = setup({ equipment: [EQ.iconOfFaith] });
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 6, 'test');
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([
        [1, 'fail'],
        [4, 'normal'],
      ]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    let s = answer(ctx, state, ACT_DECISION, 'intervention');
    const second = s.pending.find((d) => d.kind === ACT_DECISION);
    expect(second, 'a second, different ACT OF FAITH is offered').toBeDefined();
    expect(second!.options.map((o) => o.id)).not.toContain('intervention');
    s = answer(ctx, s, ACT_DECISION, 'blessing');
    expect(faithPoints(s, 'p1')).toBe(1); // 6 - 3 - 2
    expect((s.sequence as ShootSequence).attack.dice.filter((d) => d.state === 'crit')).toHaveLength(1);
  });

  it('SANCTIFIED ROUNDS: "if you spend a Faith point, that weapon has the Piercing Crits 1 weapon rule until the end of that sequence"', () => {
    const { ctx, state } = setup({ equipment: [EQ.sanctifiedRounds] });
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 3, 'test');
    makeShoot(state, { attackerId: shooter.id, targetId: foe.id, weaponName: 'Autopistol' });
    const autogun = profileOf(C.militant, 'Autopistol');
    expect(
      effectiveRules(ctx, state, autogun, { operative: shooter, target: foe, weaponName: 'Autopistol' }).some(
        (r) => r.id === 'PiercingCrits',
      ),
    ).toBe(false);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(faithPoints(state, 'p1')).toBe(2);
    const rules = effectiveRules(ctx, state, autogun, { operative: shooter, target: foe, weaponName: 'Autopistol' });
    expect(rules.some((r) => r.id === 'PiercingCrits' && r.x === 1)).toBe(true);
    // A weapon the equipment does not name is untouched.
    const blades = profileOf(C.duellist, 'Duelling blades');
    expect(
      effectiveRules(ctx, state, blades, { operative: shooter, target: foe, weaponName: 'Duelling blades' }).some(
        (r) => r.id === 'PiercingCrits',
      ),
    ).toBe(false);
  });

  it('AUTO-CHASTISERS: "inflict 1-3 damage on that friendly operative … use one ACT OF FAITH for free"', () => {
    const { ctx, state } = setup({ equipment: [EQ.autoChastisers] });
    const shooter = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    makeShoot(state, {
      attackerId: shooter.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([[1, 'fail']]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(shooter, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    const decision = state.pending.find((d) => d.kind === ACT_DECISION)!;
    // With 0 Faith points held, only the Auto-chastisers options remain.
    expect(decision.options.map((o) => o.id)).toEqual([
      'chastise:guidance',
      'chastise:intervention',
      'chastise:blessing',
      'decline',
    ]);
    const before = state.operatives[shooter.id]!.wounds;
    const out = answer(ctx, state, ACT_DECISION, 'chastise:intervention');
    expect(before - out.operatives[shooter.id]!.wounds).toBe(3);
    expect(faithPoints(out, 'p1')).toBe(0); // the ACT OF FAITH was free
    expect((out.sequence as ShootSequence).attack.dice[0]!.state).toBe('normal');
  });

  it('HOLY EMBROCATIONS: "ignore any changes to the Move stat of friendly NOVITIATE operatives from being injured"', () => {
    const plain = setup();
    const injuredId = opWith(plain.state, 'p1', C.militant);
    plain.state.operatives[injuredId]!.wounds = 3; // fewer than half of 7 → injured
    expect(moveBudget(plain.ctx, plain.state, plain.state.operatives[injuredId]!, { action: 'Reposition' })).toBeCloseTo(4);

    const kitted = setup({ equipment: [EQ.holyEmbrocations] });
    const id = opWith(kitted.state, 'p1', C.militant);
    kitted.state.operatives[id]!.wounds = 3;
    expect(moveBudget(kitted.ctx, kitted.state, kitted.state.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(6);
  });
});

// ---------------------------------------------------------------------------
describe('NOVITIATES datacard abilities', () => {
  it('Inspirational Example: "you gain 1 Faith point, or 2 … if that enemy operative had a Wounds stat of 12 or more"', () => {
    const { ctx, state } = setup();
    expect(ability(C.superior, 'novitiates.superior.inspirational-example')).toContain('Wounds stat of 12 or more');
    const superior = state.operatives[opWith(state, 'p1', C.superior)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!; // 14 wounds
    makeFight(state, {
      attackerId: superior.id,
      defenderId: foe.id,
      attackerWeapon: 'Power weapon',
    });
    inflictDamage(ctx, state, foe, 99, 'attack');
    expect(faithPoints(state, 'p1')).toBe(2);
  });

  it('Unflinching Example: "incapacitates a ready enemy operative within its control range"', () => {
    const { ctx, state } = setup();
    const preceptor = state.operatives[opWith(state, 'p1', C.preceptor)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    preceptor.pos = { x: 15, y: 11 };
    foe.pos = { x: 25, y: 11 }; // outside control range
    makeFight(state, { attackerId: preceptor.id, defenderId: foe.id, attackerWeapon: 'Mace of the Righteous' });
    inflictDamage(ctx, state, foe, 99, 'attack');
    expect(faithPoints(state, 'p1')).toBe(0);

    const other = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!;
    other.pos = { x: 15.9, y: 11 };
    makeFight(state, { attackerId: preceptor.id, defenderId: other.id, attackerWeapon: 'Mace of the Righteous' });
    inflictDamage(ctx, state, other, 99, 'attack');
    expect(faithPoints(state, 'p1')).toBe(2); // 14 wounds → 2 Faith points
  });

  it('Glorious Hymnal: "Whenever a friendly NOVITIATE operative is within 3\\" of this operative … the Severe weapon rule"', () => {
    const { ctx, state } = setup();
    const preceptor = state.operatives[opWith(state, 'p1', C.preceptor)]!;
    const friend = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    preceptor.pos = { x: 15, y: 11 };
    friend.pos = { x: 22, y: 11 };
    const autogun = profileOf(C.militant, 'Autopistol');
    expect(
      effectiveRules(ctx, state, autogun, { operative: friend, target: foe, weaponName: 'Autopistol' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(false);
    friend.pos = { x: 17.5, y: 11 };
    expect(
      effectiveRules(ctx, state, autogun, { operative: friend, target: foe, weaponName: 'Autopistol' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(true);
  });

  it('Null Rod: "PSYCHIC ranged weapons cannot inflict damage on this operative"', () => {
    const { ctx, state } = setup();
    const condemnor = state.operatives[opWith(state, 'p1', C.condemnor)]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    makeShoot(state, { attackerId: psyker.id, targetId: condemnor.id, weaponName: 'Entropy' });
    const before = condemnor.wounds;
    inflictDamage(ctx, state, condemnor, 4, 'attack');
    expect(condemnor.wounds).toBe(before);
  });

  it('Null Rod: an operative within 6" "cannot perform PSYCHIC actions" or "use PSYCHIC ranged weapons"', () => {
    const { ctx, state } = setup();
    const condemnor = state.operatives[opWith(state, 'p1', C.condemnor)]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    condemnor.pos = { x: 2, y: 2 };
    psyker.pos = { x: 20, y: 18 };
    const far = ctx.hooks.emit('availableWeapons', state, {
      state,
      operative: psyker,
      weapons: ['Entropy', 'Plague wind', 'Corrupted staff'],
    }).weapons;
    expect(far).toContain('Entropy');

    condemnor.pos = { x: 17, y: 18 };
    const near = ctx.hooks.emit('availableWeapons', state, {
      state,
      operative: psyker,
      weapons: ['Entropy', 'Plague wind', 'Corrupted staff'],
    }).weapons;
    expect(near).toEqual(['Corrupted staff']);
    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: psyker,
      action: 'plague-marines.malignant-plaguecaster.act.poisonous-miasma',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
  });

  it('Null Rod: "PSYCHIC melee weapons have no weapon rules and cannot have Dmg stats higher than 3/4"', () => {
    const { ctx, state } = setup();
    const condemnor = state.operatives[opWith(state, 'p1', C.condemnor)]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    condemnor.pos = { x: 15, y: 11 };
    psyker.pos = { x: 18, y: 11 };
    const staff = profileOf('plague-marines.malignant-plaguecaster', 'Corrupted staff');
    expect(effectiveRules(ctx, state, staff, { operative: psyker, target: condemnor, weaponName: 'Corrupted staff' })).toEqual([]);
    makeFight(state, {
      attackerId: psyker.id,
      defenderId: condemnor.id,
      attackerWeapon: 'Corrupted staff',
    });
    const before = condemnor.wounds;
    inflictDamage(ctx, state, condemnor, staff.dmgC, 'attack');
    expect(before - condemnor.wounds).toBeLessThanOrEqual(4);
  });

  it('Anti-PSYKER: "add 1 to both Dmg stats of this weapon and it has the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup();
    expect(ability(C.condemnor, 'novitiates.condemnor.anti-psyker')).toContain('add 1 to both Dmg stats');
    const condemnor = state.operatives[opWith(state, 'p1', C.condemnor)]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    const plain = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const stake = profileOf(C.condemnor, 'Condemnor stakethrower');
    expect(
      effectiveRules(ctx, state, stake, { operative: condemnor, target: psyker, weaponName: 'Condemnor stakethrower' })
        .some((r) => r.id === 'Lethal' && r.x === 5),
    ).toBe(true);
    expect(
      effectiveRules(ctx, state, stake, { operative: condemnor, target: plain, weaponName: 'Condemnor stakethrower' })
        .some((r) => r.id === 'Lethal'),
    ).toBe(false);
    // "+1 to both Dmg stats" lands where the damage is inflicted (D-019), once per success.
    makeShoot(state, {
      attackerId: condemnor.id,
      targetId: psyker.id,
      weaponName: 'Condemnor stakethrower',
      attack: pool([[6, 'crit']]),
    });
    const before = psyker.wounds;
    inflictDamage(ctx, state, psyker, stake.dmgC, 'attack');
    expect(before - psyker.wounds).toBe(stake.dmgC + 1);
  });

  it('Riposte: "Whenever you block with a critical success, you can also inflict damage equal to the weapon\'s Critical Dmg stat"', () => {
    const { ctx, state } = setup();
    const duellist = state.operatives[opWith(state, 'p1', C.duellist)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    duellist.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.9, y: 11 };
    makeFight(state, {
      attackerId: foe.id,
      defenderId: duellist.id,
      attackerWeapon: 'Plague knife',
      defenderWeapon: 'Duelling blades',
      attackerPool: pool([[5, 'normal']]),
      defenderPool: pool([[6, 'crit']]),
      step: 'resolve',
      turn: 'defender',
    });
    const before = state.operatives[foe.id]!.wounds;
    state.pending.push({
      id: 'sb1',
      who: 'p1',
      kind: 'strikeOrBlock',
      prompt: 'Resolve one success: strike or block (1 left)',
      options: [
        { id: 'block:1', label: 'Block with the critical success', data: { dieId: 1, mode: 'block' } },
      ],
      ctx: { side: 'defender' },
    });
    const out = reduce(state, { t: 'ResolveDecision', decisionId: 'sb1', optionId: 'block:1', data: { dieId: 1, mode: 'block' } }, ctx).state;
    const blades = profileOf(C.duellist, 'Duelling blades');
    expect(before - out.operatives[foe.id]!.wounds).toBe(blades.dmgC);
  });

  it('Medic!: "that friendly operative isn\'t incapacitated, has 1 wound remaining" — once per turning point', () => {
    const { ctx, state } = setup();
    const hospitaller = state.operatives[opWith(state, 'p1', C.hospitaller)]!;
    const victim = state.operatives[opWith(state, 'p1', C.militant)]!;
    const other = state.operatives[opWith(state, 'p1', C.preceptor)]!;
    hospitaller.pos = { x: 15, y: 11 };
    victim.pos = { x: 17, y: 11 };
    other.pos = { x: 17.5, y: 11 };
    for (const e of state.teams.p2.operativeIds) state.operatives[e]!.pos = { x: 28, y: 20 };
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(victim.incapacitated).toBe(false);
    expect(victim.wounds).toBe(1);
    // "Subtract 1 from this and that operative's APL stats until the end of their next activations."
    expect(aplOf(ctx, state, hospitaller)).toBe(1);
    // "The FIRST time during each turning point…"
    inflictDamage(ctx, state, other, 99, 'attack');
    expect(other.incapacitated).toBe(true);
  });

  it('Militant Faith: "the Faith points spent on that ACT OF FAITH are refunded" when an enemy is incapacitated', () => {
    const { ctx, state } = setup();
    const militant = state.operatives[opWith(state, 'p1', C.militant)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    gainFaith(state, 'p1', 3, 'test');
    makeShoot(state, {
      attackerId: militant.id,
      targetId: foe.id,
      weaponName: 'Autopistol',
      attack: pool([
        [1, 'fail'],
        [2, 'fail'],
      ]),
    });
    const autogun = profileOf(C.militant, 'Autopistol');
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx(militant, foe, 'Autopistol', autogun, 'ranged'),
      dice: [],
      rerolls: [],
    });
    const s = answer(ctx, state, ACT_DECISION, 'intervention');
    expect(faithPoints(s, 'p1')).toBe(0);
    inflictDamage(ctx, s, s.operatives[foe.id]!, 99, 'attack');
    expect(faithPoints(s, 'p1')).toBe(3);
  });

  it('Zealous Rage: "Whenever this operative is fighting with this weapon, it has the Ceaseless weapon rule"', () => {
    const { ctx, state } = setup();
    const penitent = state.operatives[opWith(state, 'p1', C.penitent)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const evis = profileOf(C.penitent, 'Penitent eviscerator');
    const fighting = effectiveRules(ctx, state, evis, {
      operative: penitent,
      target: foe,
      weaponName: 'Penitent eviscerator',
    });
    expect(fighting.some((r) => r.id === 'Ceaseless')).toBe(true);
    const retaliating = effectiveRules(ctx, state, evis, {
      operative: penitent,
      target: foe,
      weaponName: 'Penitent eviscerator',
      retaliating: true,
    });
    expect(retaliating.some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('Absolution Through Destruction: "it can immediately perform a free Fight action afterwards … over action restrictions"', () => {
    const { ctx, state } = setup();
    const penitent = state.operatives[opWith(state, 'p1', C.penitent)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    penitent.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.8, y: 11 };
    const s = activate(ctx, state, penitent.id);
    const p = s.operatives[penitent.id]!;
    const first = getAction(ABSOLUTION_FIGHTS[0]!)!;
    expect(first.check(ctx, s, p, {}).ok, 'not available before a Fight action').toBe(false);
    p.actionsThisActivation = ['Fight'];
    expect(first.check(ctx, s, p, {}).ok).toBe(true);
    // "a free Fight action"
    expect(availableActions(ctx, s, p).find((a) => a.def.id === ABSOLUTION_FIGHTS[0])?.ap).toBe(0);
    // "…you cannot perform more than two Fight actions in succession as a result of this rule."
    p.actionsThisActivation = ['Fight', ABSOLUTION_FIGHTS[0]!];
    expect(getAction(ABSOLUTION_FIGHTS[1]!)!.check(ctx, s, p, {}).ok).toBe(false);
  });

  it('Relic Seeker: "it can perform the Pick Up Marker, Place Marker or a mission action for 1 less AP", once per activation', () => {
    const { ctx, state } = setup();
    const pronatus = state.operatives[opWith(state, 'p1', C.pronatus)]!;
    expect(actionCost(ctx, state, pronatus, getAction('Pick Up Marker')!)).toBe(0);
    expect(actionCost(ctx, state, pronatus, getAction('Shoot')!)).toBe(1);
    pronatus.actionsThisActivation = ['Pick Up Marker'];
    expect(actionCost(ctx, state, pronatus, getAction('Place Marker')!)).toBe(1);
  });

  it('Divine Acquisition: "you gain a number of Faith points equal to the turning point number", once per turning point', () => {
    const { ctx, state } = setup();
    const pronatus = state.operatives[opWith(state, 'p1', C.pronatus)]!;
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    pronatus.pos = { x: objective.pos.x + 0.3, y: objective.pos.y };
    for (const e of state.teams.p2.operativeIds) state.operatives[e]!.pos = { x: 28, y: 20 };
    expect(markerController(ctx, state, objective)).toBe('p1');
    state.turningPoint = 3;
    pronatus.actionsThisActivation = ['Operate Hatch']; // a mission action
    ctx.hooks.emit('onActivationEnd', state, { state, operative: pronatus });
    expect(faithPoints(state, 'p1')).toBe(3);
    ctx.hooks.emit('onActivationEnd', state, { state, operative: pronatus });
    expect(faithPoints(state, 'p1')).toBe(3);
  });

  it('Purge with Flame: "you can use the inferno firefight ploy for 0CP if this is the specified friendly NOVITIATE operative"', () => {
    expect(ability(C.purgatus, 'novitiates.purgatus.purge-with-flame')).toContain('Once per turning point');
    const { ctx, state } = setup({ roles: FLAME });
    const purgatus = state.operatives[opWith(state, 'p1', C.purgatus)]!;
    const militant = state.operatives[opWith(state, 'p1', C.militant)]!;
    const cp = state.teams.p1.cp;
    const named = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: FP.blazingInferno, data: { operativeId: purgatus.id } },
      ctx,
    ).state;
    expect(named.teams.p1.cp).toBe(cp); // 1CP charged, then refunded
    // "…if this is the specified friendly NOVITIATE operative": any other operative pays.
    const other = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: FP.blazingInferno, data: { operativeId: militant.id } },
      ctx,
    ).state;
    expect(other.teams.p1.cp).toBe(cp - 1);
  });

  it('Icon Bearer: "Whenever determining control of a marker, treat this operative\'s APL stat as 1 higher"', () => {
    const { ctx, state } = setup({ roles: FLAME });
    const reliquarius = state.operatives[opWith(state, 'p1', C.reliquarius)]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!; // APL 3
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    for (const id of [...state.teams.p1.operativeIds, ...state.teams.p2.operativeIds])
      state.operatives[id]!.pos = { x: 28, y: 20 };
    reliquarius.pos = { x: objective.pos.x + 0.3, y: objective.pos.y };
    foe.pos = { x: objective.pos.x - 0.3, y: objective.pos.y };
    // RELIQUARIUS APL 2 + 1 = 3, which ties the PLAGUE MARINE's 3 → nobody controls it.
    expect(markerController(ctx, state, objective)).toBe(null);
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: objective.id,
      aplByPlayer: { p1: 0, p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('NOVITIATES unique actions', () => {
  it('STIRRING RHETORIC 1AP: "add 1 to its APL stat (to a maximum of 3 …)"', () => {
    const { ctx, state } = setup();
    const dialogus = opWith(state, 'p1', C.dialogus);
    const friend = opWith(state, 'p1', C.militant);
    state.operatives[dialogus]!.pos = { x: 15, y: 11 };
    state.operatives[friend]!.pos = { x: 18, y: 11 };
    expect(actionText(C.dialogus, 'novitiates.dialogus.act.stirring-rhetoric')).toContain('SUPPORT');
    let s = activate(ctx, state, dialogus);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: dialogus,
        action: 'novitiates.dialogus.act.stirring-rhetoric',
        params: { targetOperativeId: friend },
      },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[friend]!)).toBe(3);
  });

  it('AUTO-BROADCASTER 0AP places the marker, and "your opponent cannot re-roll their attack dice" within 3" of it', () => {
    const { ctx, state } = setup();
    const dialogus = opWith(state, 'p1', C.dialogus);
    state.operatives[dialogus]!.pos = { x: 15, y: 11 };
    let s = activate(ctx, state, dialogus);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: dialogus,
        action: 'novitiates.dialogus.act.auto-broadcaster',
        params: { markerPos: { x: 20, y: 11 } },
      },
      ctx,
    ).state;
    const marker = s.markers['novitiates.broadcaster.p1'];
    expect(marker, 'the Auto-broadcaster marker is in the killzone').toBeDefined();
    expect(marker!.pos).toEqual({ x: 20, y: 11 });
    // 0AP: "AUTO-BROADCASTER 0AP"
    expect(s.operatives[dialogus]!.apSpent).toBe(0);

    const enemy = s.operatives[opWith(s, 'p2', 'plague-marines.icon-bearer')]!;
    enemy.pos = { x: 21, y: 11 };
    const boltgun = profileOf('plague-marines.icon-bearer', 'Bolt pistol');
    const ev = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: actx(enemy, s.operatives[dialogus]!, 'Bolt pistol', boltgun, 'ranged'),
      dice: [],
      rerolls: [{ id: 'balanced', label: 'Balanced', mode: 'one', max: 1, player: 'p2' }],
    });
    expect(ev.rerolls).toEqual([]);
  });

  it('WHIP INTO FRENZY 1AP: "add 1\\" to its Move stat, it can perform two Fight actions … and one of them can be free"', () => {
    const { ctx, state } = setup();
    const exactor = opWith(state, 'p1', C.exactor);
    const target = opWith(state, 'p1', C.penitent);
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    state.operatives[exactor]!.pos = { x: 15, y: 11 };
    state.operatives[target]!.pos = { x: 17, y: 11 };
    foe.pos = { x: 17.8, y: 11 };
    const baseMove = moveBudget(ctx, state, state.operatives[target]!, { action: 'Reposition' });
    let s = activate(ctx, state, exactor);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: exactor,
        action: 'novitiates.exactor.act.whip-into-frenzy',
        params: { targetOperativeId: target },
      },
      ctx,
    ).state;
    expect(moveBudget(ctx, s, s.operatives[target]!, { action: 'Reposition' })).toBeCloseTo(baseMove + 1);
    const t = s.operatives[target]!;
    const whip = getAction(WHIP_FIGHT)!;
    expect(whip.check(ctx, s, t, { targetId: foe.id }).ok, 'the first Fight is the universal one').toBe(false);
    t.actionsThisActivation = ['Fight'];
    expect(whip.check(ctx, s, t, { targetId: foe.id }).ok).toBe(true);
    expect(availableActions(ctx, s, t).find((a) => a.def.id === WHIP_FIGHT)?.ap).toBe(0);
  });

  it('CHIRURGEON\'S TOOLS 1AP: "regain up to 2D3 lost wounds", not on an operative Medic! was used on', () => {
    const { ctx, state } = setup({ script: [6, 6] });
    const hospitaller = opWith(state, 'p1', C.hospitaller);
    const patient = opWith(state, 'p1', C.militant);
    state.operatives[hospitaller]!.pos = { x: 15, y: 11 };
    state.operatives[patient]!.pos = { x: 15.7, y: 11 };
    state.operatives[patient]!.wounds = 1;
    let s = activate(ctx, state, hospitaller);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: hospitaller,
        action: 'novitiates.hospitaller.act.chirurgeons-tools',
        params: { targetOperativeId: patient },
      },
      ctx,
    ).state;
    expect(s.operatives[patient]!.wounds).toBe(7); // 1 + 2D3, capped at the printed 7
  });

  it('RAISE ICON 1AP: "You gain 1 Faith point … also … equal to the turning point number" if it controls an objective', () => {
    const { ctx, state } = setup({ roles: FLAME });
    const reliquarius = opWith(state, 'p1', C.reliquarius);
    const objective = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    state.operatives[reliquarius]!.pos = { x: objective.pos.x + 0.3, y: objective.pos.y };
    state.turningPoint = 2;
    let s = activate(ctx, state, reliquarius);
    s = reduce(s, { t: 'PerformAction', operativeId: reliquarius, action: 'novitiates.reliquarius.act.raise-icon' }, ctx).state;
    expect(faithPoints(s, 'p1')).toBe(3); // 1 + turning point 2
    // "This operative cannot perform this action more than once per turning point."
    const again = reduce(s, { t: 'PerformAction', operativeId: reliquarius, action: 'novitiates.reliquarius.act.raise-icon' }, ctx);
    expect(again.ok).toBe(false);
  });

  it('every unique action refuses to be performed "while within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    const ids = [
      [C.dialogus, 'novitiates.dialogus.act.stirring-rhetoric'],
      [C.dialogus, 'novitiates.dialogus.act.auto-broadcaster'],
      [C.exactor, 'novitiates.exactor.act.whip-into-frenzy'],
      [C.hospitaller, 'novitiates.hospitaller.act.chirurgeons-tools'],
      [C.reliquarius, 'novitiates.reliquarius.act.raise-icon'],
    ] as const;
    for (const [cardId, actionId] of ids) {
      const printed = DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
      expect(printed.text, actionId).toContain('control range of an enemy operative');
    }
    const dialogus = state.operatives[opWith(state, 'p1', C.dialogus)]!;
    const enemy = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    dialogus.pos = { x: 15, y: 11 };
    enemy.pos = { x: 15.6, y: 11 };
    const s = activate(ctx, state, dialogus.id);
    const def = getAction('novitiates.dialogus.act.auto-broadcaster')!;
    expect(def.check(ctx, s, s.operatives[dialogus.id]!, {}).ok).toBe(false);
  });
});
