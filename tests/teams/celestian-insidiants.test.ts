/**
 * CELESTIAN INSIDIANTS. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/celestian-insidiants/
 */
import { describe, expect, it } from 'vitest';
import { availableActions } from '../../src/core/actions.ts';
import { createGameContext } from '../../src/core/game.ts';
import { reduce } from '../../src/core/reducer.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { aplOf, inflictDamage, markerController } from '../../src/core/state.ts';
import { effectiveRules, startShoot } from '../../src/core/sequences/shoot.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import {
  BENEDICTIONS,
  INSPIRING,
  MARTYRDOM_DECISION,
  SUSPICION,
  celestianInsidiants,
  isInspiring,
  makeInspiring,
  nullRange,
} from '../../src/teams/celestian-insidiants/index.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import { plagueMarines } from '../../src/teams/plague-marines/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { activate, battle, mapById, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('celestian-insidiants');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, id: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === id)!.text;

const EVERY_ROLE = [
  'celestian-insidiants.insidiant-superior',
  'celestian-insidiants.insidiant-abjuror',
  'celestian-insidiants.insidiant-censor',
  'celestian-insidiants.insidiant-cremator',
  'celestian-insidiants.insidiant-denuncia',
  'celestian-insidiants.insidiant-mortisanctus',
  'celestian-insidiants.insidiant-reliquarius',
  'celestian-insidiants.insidiant-warrior',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([celestianInsidiants, plagueMarines], { seed: 7 });
  const state = battle({
    ctx,
    p1: { module: celestianInsidiants, equipment, picks: rosterIncluding(celestianInsidiants, EVERY_ROLE) },
    p2: { module: plagueMarines },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const teamId = cardId.split('.')[0]!;
  const data = teamId === 'celestian-insidiants' ? DATA : teamData('plague-marines');
  const w = data.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return (w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0])!;
};

// ---------------------------------------------------------------------------
describe('CELESTIAN INSIDIANTS data (pinned against data/teams/celestian-insidiants.json)', () => {
  it('has 8 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(8);
    const superior = DATA.datacards.find((c) => c.id === 'celestian-insidiants.insidiant-superior')!;
    expect(superior).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 10, base: { shape: 'round', mm: 32 } });
    expect(superior.keywords).toEqual([
      'CELESTIAN INSIDIANT',
      'IMPERIUM',
      'ADEPTA SORORITAS',
      'LEADER',
      'SUPERIOR',
    ]);
    const abjuror = DATA.datacards.find((c) => c.id === 'celestian-insidiants.insidiant-abjuror')!;
    expect(abjuror).toMatchObject({ apl: 2, move: 6, save: 2, wounds: 11 });
    for (const card of DATA.datacards.filter(
      (c) => !['celestian-insidiants.insidiant-superior', 'celestian-insidiants.insidiant-abjuror'].includes(c.id),
    )) {
      expect(card).toMatchObject({ apl: 2, move: 6, save: 3, wounds: 9, base: { shape: 'round', mm: 32 } });
    }
  });

  it('pins every weapon profile of the SUPERIOR and the ABJUROR', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat('celestian-insidiants.insidiant-superior')).toEqual([
      'Inferno pistol||ranged|4|3|4|2|Range 3"+Devastating 3+Piercing 2',
      'Relic bolt pistol||ranged|4|3|3|5|Range 8"+Lethal 5+',
      'Relic condemnor stakethrower||ranged|4|3|2|2|Devastating 2+Lethal 5++Piercing Crits 1+Silent+Anti-PSYKER*',
      'Null mace||melee|4|3|4|4|Shock+Anti-PSYKER*',
    ]);
    expect(flat('celestian-insidiants.insidiant-abjuror')).toEqual([
      'Blessed sword & praesidium protectiva|defensive|melee|4|3|4|6|Shield*',
      'Blessed sword & praesidium protectiva|offensive|melee|4|3|4|6|Lethal 5+',
    ]);
  });

  it('exposes 4 faction rules, 4 strategy ploys, 4 firefight ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual([
      'Martyrdom',
      'Benedictions',
      'Weapons of the Witch Hunters',
      'Inspiration',
    ]);
    expect(celestianInsidiants.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(celestianInsidiants.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(celestianInsidiants.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual(['AntiPSYKER', 'Shield']);
  });
});

// ---------------------------------------------------------------------------
describe('Inspiration — "Whenever a friendly CELESTIAN INSIDIANT operative … becomes INSPIRING"', () => {
  it('"Incapacitates an enemy operative that has a Wounds stat of 6 or more" makes the killer INSPIRING', () => {
    const { ctx, state } = setup();
    const warrior = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const victim = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: warrior.id,
      defenderId: victim.id,
      attackerWeapon: 'Null mace',
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
      defenderCanRetaliate: false,
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
    expect(isInspiring(state, warrior)).toBe(false);
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(isInspiring(state, warrior)).toBe(true);
  });

  it('"Performs the Charge action, before it moves, it becomes INSPIRING" — and INSPIRING grants Severe', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const target = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const pistol = profileOf('celestian-insidiants.insidiant-warrior', 'Bolt pistol');
    expect(
      effectiveRules(ctx, state, pistol, { operative: op, target, weaponName: 'Bolt pistol' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(false);

    op.actionsThisActivation = ['Charge'];
    expect(isInspiring(state, op)).toBe(true);
    expect(
      effectiveRules(ctx, state, pistol, { operative: op, target, weaponName: 'Bolt pistol' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Martyrdom + Benedictions', () => {
  it('"select one other friendly CELESTIAN INSIDIANT operative … gains one BENEDICTION" is a decision, and Ardour adds 1 APL', () => {
    const { ctx, state } = setup();
    const martyr = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const friend = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-reliquarius')]!;
    martyr.pos = { x: 6, y: 11 };
    friend.pos = { x: 8, y: 11 };
    makeInspiring(state, martyr, 'test', 'test');

    inflictDamage(ctx, state, martyr, 99, 'attack');
    const decision = state.pending.find((d) => d.kind === MARTYRDOM_DECISION);
    expect(decision, 'Martyrdom raises a BENEDICTION decision').toBeDefined();
    // "You cannot select this BENEDICTION for a SUPERIOR operative."
    const superiorId = opWith(state, 'p1', 'celestian-insidiants.insidiant-superior');
    expect(decision!.options.some((o) => o.id === `${superiorId}|ardour`)).toBe(false);
    expect(BENEDICTIONS).toEqual(['ardour', 'wrath', 'restoration', 'exigence']);

    const out = reduce(state, { t: 'ResolveDecision', decisionId: decision!.id, optionId: `${friend.id}|ardour` }, ctx);
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[friend.id]!)).toBe(3);
  });

  it('Restoration: "That operative regains up to D3+2 lost wounds"', () => {
    const ctx = teamContext([celestianInsidiants, plagueMarines], { script: [3] });
    const state = battle({
      ctx,
      p1: { module: celestianInsidiants, picks: rosterIncluding(celestianInsidiants, EVERY_ROLE) },
      p2: { module: plagueMarines },
    });
    const martyr = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const friend = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-censor')]!;
    friend.wounds = 2;
    makeInspiring(state, martyr, 'test', 'test');
    inflictDamage(ctx, state, martyr, 99, 'attack');
    const decision = state.pending.find((d) => d.kind === MARTYRDOM_DECISION)!;
    const out = reduce(state, { t: 'ResolveDecision', decisionId: decision.id, optionId: `${friend.id}|restoration` }, ctx);
    expect(out.state.operatives[friend.id]!.wounds).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
describe('Weapons of the Witch Hunters', () => {
  it('"PSYCHIC ranged weapons cannot inflict damage on friendly CELESTIAN INSIDIANT operatives"', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    state.sequence = {
      kind: 'shoot',
      step: 'resolve',
      attackerId: psyker.id,
      targetId: victim.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Entropy',
      secondary: false,
      pointBlank: false,
      inCover: false,
      obscured: false,
      coverChoiceMade: true,
      vantageAccurate: 0,
      vantageImprovedCover: false,
      attack: { dice: [], nextId: 1 },
      defence: { dice: [], nextId: 1 },
      usedRerolls: [],
      usedRetention: [],
      damage: 0,
      useCounted: false,
      attacker: 'p2',
      defender: 'p1',
      free: false,
    };
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, 4, 'attack');
    expect(victim.wounds).toBe(before);
  });

  it('an operative within 3" "cannot perform PSYCHIC actions" or "use PSYCHIC ranged weapons"', () => {
    const { ctx, state } = setup();
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    const censor = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-censor')]!;
    psyker.pos = { x: 15, y: 11 };
    censor.pos = { x: 30, y: 2 };
    const far = ctx.hooks.emit('availableWeapons', state, {
      state,
      operative: psyker,
      weapons: ['Entropy', 'Plague wind', 'Corrupted staff'],
    }).weapons;
    expect(far).toContain('Entropy');

    censor.pos = { x: 17, y: 11 }; // within 3"
    const near = ctx.hooks.emit('availableWeapons', state, {
      state,
      operative: psyker,
      weapons: ['Entropy', 'Plague wind', 'Corrupted staff'],
    }).weapons;
    expect(near).not.toContain('Entropy');
    expect(near).toContain('Corrupted staff'); // a melee PSYCHIC weapon is still usable

    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: psyker,
      action: 'plague-marines.malignant-plaguecaster.act.poisonous-miasma',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
  });

  it('"PSYCHIC melee weapons have no weapon rules and cannot have Dmg stats higher than 3/4"', () => {
    const { ctx, state } = setup();
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    const censor = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-censor')]!;
    psyker.pos = { x: 15, y: 11 };
    censor.pos = { x: 17, y: 11 };
    const staff = profileOf('plague-marines.malignant-plaguecaster', 'Corrupted staff');
    const rules = effectiveRules(ctx, state, staff, { operative: psyker, target: censor, weaponName: 'Corrupted staff' });
    expect(rules).toEqual([]);
  });

  it('Anti-PSYKER: "against an operative that has the PSYKER keyword … it has the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup();
    const warrior = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    const plain = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const mace = profileOf('celestian-insidiants.insidiant-warrior', 'Null mace');
    const vsPsyker = effectiveRules(ctx, state, mace, { operative: warrior, target: psyker, weaponName: 'Null mace' });
    expect(vsPsyker.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
    const vsPlain = effectiveRules(ctx, state, mace, { operative: warrior, target: plain, weaponName: 'Null mace' });
    expect(vsPlain.some((r) => r.id === 'Lethal')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('CELESTIAN INSIDIANTS strategy ploys', () => {
  it('SUSPECT & ELIMINATE: Suspicion tokens give friendly weapons "the Punishing weapon rule"', () => {
    const { ctx, state } = setup();
    const enemy = opWith(state, 'p2', 'plague-marines.icon-bearer');
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'celestian-insidiants.sp.suspect-eliminate', data: { operativeId: enemy } },
      ctx,
    ).state;
    expect(s.effects.some((e) => e.rule === SUSPICION && e.operativeId === enemy)).toBe(true);
    const shooter = s.operatives[opWith(s, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const pistol = profileOf('celestian-insidiants.insidiant-warrior', 'Bolt pistol');
    const rules = effectiveRules(ctx, s, pistol, {
      operative: shooter,
      target: s.operatives[enemy]!,
      weaponName: 'Bolt pistol',
    });
    expect(rules.some((r) => r.id === 'Punishing')).toBe(true);
  });

  it('SUFFERING & SACRIFICE: "a wounded friendly … operative … has the Balanced weapon rule"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'celestian-insidiants.sp.suffering-sacrifice' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const target = s.operatives[opWith(s, 'p2', 'plague-marines.icon-bearer')]!;
    const pistol = profileOf('celestian-insidiants.insidiant-warrior', 'Bolt pistol');
    const healthy = effectiveRules(ctx, s, pistol, { operative: shooter, target, weaponName: 'Bolt pistol' });
    expect(healthy.some((r) => r.id === 'Balanced')).toBe(false);
    shooter.wounds -= 1;
    const wounded = effectiveRules(ctx, s, pistol, { operative: shooter, target, weaponName: 'Bolt pistol' });
    expect(wounded.some((r) => r.id === 'Balanced')).toBe(true);
  });

  it('WRATHFUL DETERMINATION: "you can re-roll one of your defence dice" for an Engage operative', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'celestian-insidiants.sp.wrathful-determination' }, ctx).state;
    const target = s.operatives[opWith(s, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const shooter = s.operatives[opWith(s, 'p2', 'plague-marines.icon-bearer')]!;
    const boltgun = profileOf('plague-marines.icon-bearer', 'Bolt pistol');
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: {
        attacker: shooter,
        defender: target,
        weaponName: 'Bolt pistol',
        profile: boltgun,
        rules: boltgun.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 6,
      },
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.rerolls.some((r) => r.id === 'celestian.wrathfulDetermination')).toBe(true);
  });

  it('HOLY RESILIENCE: "Normal and Critical Dmg of 4 or more inflicts 1 less damage" on an INSPIRING operative', () => {
    const { ctx, state } = setup();
    const victim = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    makeInspiring(state, victim, 'test', 'test');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'celestian-insidiants.sp.holy-resilience' }, ctx).state;
    const v = s.operatives[victim.id]!;
    s.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: foe.id,
      defenderId: v.id,
      attackerWeapon: 'Plague knife',
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
      defenderCanRetaliate: true,
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
    const before = v.wounds;
    inflictDamage(ctx, s, v, 5, 'attack');
    expect(before - v.wounds).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('CELESTIAN INSIDIANTS firefight ploys', () => {
  it('UNSHAKEABLE PURSUIT: "add 1\\" to its Move stat" while INSPIRING, and Move changes are ignored', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    op.wounds = 3; // injured: -2" Move
    let s = activate(ctx, state, op.id);
    expect(moveBudget(ctx, s, s.operatives[op.id]!, { action: 'Reposition' })).toBeCloseTo(4);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'celestian-insidiants.fp.unshakeable-pursuit' }, ctx).state;
    expect(moveBudget(ctx, s, s.operatives[op.id]!, { action: 'Reposition' })).toBeCloseTo(6);
    makeInspiring(s, s.operatives[op.id]!, 'test', 'test');
    expect(moveBudget(ctx, s, s.operatives[op.id]!, { action: 'Reposition' })).toBeCloseTo(7);
  });

  it('FERVENT HATE: Ceaseless against a non-IMPERIUM operative, Relentless if it is also CHAOS/PSYKER', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'celestian-insidiants.fp.fervent-hate' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const chaos = s.operatives[opWith(s, 'p2', 'plague-marines.icon-bearer')]!;
    const psyker = s.operatives[opWith(s, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    const pistol = profileOf('celestian-insidiants.insidiant-warrior', 'Bolt pistol');
    expect(
      effectiveRules(ctx, s, pistol, { operative: shooter, target: chaos, weaponName: 'Bolt pistol' }).map((r) => r.id),
    ).toContain('Relentless');
    expect(
      effectiveRules(ctx, s, pistol, { operative: shooter, target: psyker, weaponName: 'Bolt pistol' }).map((r) => r.id),
    ).toContain('Relentless');
  });

  it('FAITH & FURY: "also inflict D3 damage on each other enemy operative visible to and within 2\\""', () => {
    const ctx = teamContext([celestianInsidiants, plagueMarines], { script: [3, 3, 3, 3] });
    const state = battle({
      ctx,
      p1: { module: celestianInsidiants, picks: rosterIncluding(celestianInsidiants, EVERY_ROLE) },
      p2: { module: plagueMarines },
    });
    const fighter = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const struck = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const bystander = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!;
    fighter.pos = { x: 15, y: 11 };
    struck.pos = { x: 15.9, y: 11 };
    bystander.pos = { x: 16.2, y: 11 };
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'celestian-insidiants.fp.faith-fury' }, ctx).state;
    const before = s.operatives[bystander.id]!.wounds;
    const mace = profileOf('celestian-insidiants.insidiant-warrior', 'Null mace');
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: {
        attacker: s.operatives[fighter.id]!,
        defender: s.operatives[struck.id]!,
        weaponName: 'Null mace',
        profile: mace,
        rules: mace.rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      crit: true,
      struck: s.operatives[struck.id]!,
    });
    expect(s.operatives[bystander.id]!.wounds).toBeLessThan(before);
  });

  it('GLORY TO THE MARTYRS is used "when a friendly … operative is incapacitated while fighting or retaliating"', () => {
    expect(rule('celestian-insidiants.fp.glory-to-the-martyrs')).toContain('incapacitated while fighting or retaliating');
    expect(rule('celestian-insidiants.fp.glory-to-the-martyrs')).toContain('one of your unresolved successes');
    const { ctx, state } = setup();
    const martyr = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    foe.wounds = 2;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'celestian-insidiants.fp.glory-to-the-martyrs' }, ctx).state;
    const m = s.operatives[martyr.id]!;
    const f = s.operatives[foe.id]!;
    s.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: f.id,
      defenderId: m.id,
      attackerWeapon: 'Plague knife',
      defenderWeapon: 'Null mace',
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [{ id: 1, value: 5, state: 'normal', rolled: true }], nextId: 2 },
      defenderCanRetaliate: true,
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
    inflictDamage(ctx, s, m, 99, 'attack');
    expect(f.wounds).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
describe('CELESTIAN INSIDIANTS faction equipment', () => {
  it('PSYK-OUT GRENADES gives the kill team two stun grenades and adds damage to a stun test', () => {
    const { ctx, state } = setup(['celestian-insidiants.eq.psyk-out-grenades']);
    expect(state.teams.p1.equipmentUses['eq.utilityGrenades:stun']).toBe(2);
    expect(state.teams.p1.equipmentUses['eq.utilityGrenades:smoke']).toBe(0);
    const thrower = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const psyker = state.operatives[opWith(state, 'p2', 'plague-marines.malignant-plaguecaster')]!;
    const plain = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    // "if the result is a 3+, also inflict damage … equal to the dice result halved (rounding
    // up). If that first operative has the PSYKER keyword, inflict damage … equal to the dice
    // result instead."
    expect(
      ctx.hooks.emit('onStunTest', state, { state, thrower, target: plain, roll: 5, damage: 0 }).damage,
    ).toBe(3);
    expect(
      ctx.hooks.emit('onStunTest', state, { state, thrower, target: psyker, roll: 5, damage: 0 }).damage,
    ).toBe(5);
    expect(ctx.hooks.emit('onStunTest', state, { state, thrower, target: plain, roll: 2, damage: 0 }).damage).toBe(0);
  });

  it('SAINTLY RELICS: "if any result is a 6, ignore the damage inflicted from that attack dice"', () => {
    const ctx = teamContext([celestianInsidiants, plagueMarines], { script: [6, 6, 6, 6] });
    const state = battle({
      ctx,
      p1: {
        module: celestianInsidiants,
        equipment: ['celestian-insidiants.eq.saintly-relics'],
        picks: rosterIncluding(celestianInsidiants, EVERY_ROLE),
      },
      p2: { module: plagueMarines },
    });
    const victim = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, 4, 'attack');
    expect(victim.wounds).toBe(before);
  });

  it('AUTO-FLAGELLATOR: "you can use this rule" is offered as a decision when an operative is activated', () => {
    const { ctx, state } = setup(['celestian-insidiants.eq.auto-flagellator']);
    const id = opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior');
    const s = activate(ctx, state, id);
    const decision = s.pending.find((d) => d.kind === 'celestian.autoFlagellator');
    expect(decision).toBeDefined();
    expect(decision!.options.map((o) => o.id)).toEqual(['use', 'decline']);
    const out = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'use' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[id]!.wounds).toBeLessThan(9);
  });

  it('VOCIFERA MORTIS lets Martyrdom select an operative "that isn’t visible to or within 6\\"" — once per battle', () => {
    const { ctx, state } = setup(['celestian-insidiants.eq.vocifera-mortis']);
    const martyr = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const far = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-censor')]!;
    martyr.pos = { x: 2, y: 2 };
    far.pos = { x: 26, y: 20 };
    makeInspiring(state, martyr, 'test', 'test');
    inflictDamage(ctx, state, martyr, 99, 'attack');
    const decision = state.pending.find((d) => d.kind === MARTYRDOM_DECISION)!;
    expect(decision.options.some((o) => o.id === `${far.id}|wrath`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('CELESTIAN INSIDIANTS unique actions and abilities', () => {
  it('SPIRITUAL MENTOR 1AP: "That operative becomes INSPIRING", once per turning point', () => {
    const { ctx, state } = setup();
    const superior = opWith(state, 'p1', 'celestian-insidiants.insidiant-superior');
    const friend = opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior');
    state.operatives[superior]!.pos = { x: 10, y: 11 };
    state.operatives[friend]!.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, superior);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: superior,
        action: 'celestian-insidiants.insidiant-superior.act.spiritual-mentor',
        params: { targetOperativeId: friend },
      },
      ctx,
    ).state;
    expect(isInspiring(s, s.operatives[friend]!)).toBe(true);
    expect(s.effects.some((e) => e.rule === INSPIRING && e.operativeId === friend)).toBe(true);
  });

  it('NULLIFYING RITUAL 1AP: "Add 1 to this operative’s null range (to a maximum of 5\\")"', () => {
    const { ctx, state } = setup();
    const censor = opWith(state, 'p1', 'celestian-insidiants.insidiant-censor');
    expect(nullRange(state, state.operatives[censor]!)).toBe(1);
    let s = activate(ctx, state, censor);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: censor, action: 'celestian-insidiants.insidiant-censor.act.nullifying-ritual' },
      ctx,
    ).state;
    expect(nullRange(s, s.operatives[censor]!)).toBe(2);
    // "or more than once per turning point"
    const again = reduce(
      s,
      { t: 'PerformAction', operativeId: censor, action: 'celestian-insidiants.insidiant-censor.act.nullifying-ritual' },
      ctx,
    );
    expect(again.ok).toBe(false);
  });

  it('Null Field: "subtract 2\\" from the Move stat … and worsen the Hit stat of its weapons by 1"', () => {
    const { ctx, state } = setup();
    const censor = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-censor')]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    censor.pos = { x: 15, y: 11 };
    foe.pos = { x: 25, y: 11 };
    const away = moveBudget(ctx, state, foe, { action: 'Reposition' });
    foe.pos = { x: 15.8, y: 11 }; // within the 1" null range
    const mods = ctx.hooks.emit('onStatMod', state, {
      state,
      operative: foe,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    }).mods;
    expect(mods.move).toBe(-2);
    expect(mods.hit).toBe(-1);
    // "An operative's Move stat can never be changed to less than 4"."
    expect(moveBudget(ctx, state, foe, { action: 'Reposition' })).toBeCloseTo(Math.max(4, away - 2));
  });

  it('SPEAK OF HER DEEDS 1AP: the INSPIRING operative "is no longer INSPIRING" and another gains a BENEDICTION', () => {
    const { ctx, state } = setup();
    const denuncia = opWith(state, 'p1', 'celestian-insidiants.insidiant-denuncia');
    const source = opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior');
    const target = opWith(state, 'p1', 'celestian-insidiants.insidiant-reliquarius');
    for (const [id, x] of [
      [denuncia, 10],
      [source, 12],
      [target, 13],
    ] as [string, number][]) {
      state.operatives[id]!.pos = { x, y: 11 };
    }
    makeInspiring(state, state.operatives[source]!, 'test', 'test');
    let s = activate(ctx, state, denuncia);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: denuncia,
        action: 'celestian-insidiants.insidiant-denuncia.act.speak-of-her-deeds',
        params: { targetOperativeId: target, choice: 'ardour' },
      },
      ctx,
    ).state;
    expect(isInspiring(s, s.operatives[source]!)).toBe(false);
    expect(aplOf(ctx, s, s.operatives[target]!)).toBe(3);
  });

  it('Shield: "each of your blocks can be allocated to block two unresolved successes (instead of one)"', () => {
    const { ctx, state } = setup();
    const abjuror = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-abjuror')]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    const defensive = profileOf('celestian-insidiants.insidiant-abjuror', 'Blessed sword & praesidium protectiva', 'defensive');
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: abjuror,
        defender: foe,
        weaponName: 'Blessed sword & praesidium protectiva',
        profile: defensive,
        rules: defensive.rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      brutal: false,
      blocks: 1,
      normalsCanBlockCrits: false,
    });
    expect(ev.blocks).toBe(2);
  });

  it('Holy Defender: the ABJUROR "becomes the valid target … instead", once per turning point', () => {
    const { ctx, state } = setup();
    const abjuror = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-abjuror')]!;
    const ward = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    abjuror.pos = { x: 15, y: 11 };
    ward.pos = { x: 15.9, y: 11 };
    ward.order = 'engage';
    shooter.pos = { x: 20, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (![abjuror.id, ward.id].includes(id)) state.operatives[id]!.pos = { x: 2, y: 2 };
    const r = startShoot(ctx, state, shooter, 'Bolt pistol', undefined, ward.id);
    expect(r.ok, r.reason).toBe(true);
    const seq = state.sequence!;
    expect(seq.kind === 'shoot' ? seq.targetId : '').toBe(abjuror.id);
  });

  it('Zealous Ultimatum is a once-per-battle STRATEGIC GAMBIT whose ultimatum the OPPONENT accepts or declines', () => {
    const { ctx, state } = setup();
    const mortisanctus = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-mortisanctus')]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    mortisanctus.pos = { x: 15, y: 11 };
    foe.pos = { x: 19, y: 11 };
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(options.some((o) => o.id === 'celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum')).toBe(true);
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'celestian-insidiants.insidiant-mortisanctus.zealous-ultimatum' },
      ctx,
    ).state;
    const decision = s.pending.find((d) => d.kind === 'celestian.ultimatum');
    expect(decision).toBeDefined();
    expect(decision!.who).toBe('p2'); // "Your opponent must accept or decline that ultimatum"
    const out = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'accept' }, ctx);
    expect(out.state.effects.some((e) => e.rule === 'celestian.ultimatum' && e.data?.['accepted'] === true)).toBe(true);
  });

  it('Virge of Admonition Icon Bearer: "treat this operative’s APL stat as 1 higher" for marker control', () => {
    const { ctx, state } = setup();
    expect(ability('celestian-insidiants.insidiant-censor', 'celestian-insidiants.insidiant-censor.virge-of-admonition-icon-bearer')).toContain(
      'treat this operative’s APL stat as 1 higher',
    );
    const censor = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-censor')]!;
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    censor.pos = { ...marker.pos };
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.fighter')]!;
    foe.pos = { ...marker.pos, x: marker.pos.x + 0.6 };
    for (const id of [...state.teams.p1.operativeIds, ...state.teams.p2.operativeIds]) {
      if (id !== censor.id && id !== foe.id) state.operatives[id]!.pos = { x: 2, y: 2 };
    }
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: marker.id,
      aplByPlayer: { p1: 2, p2: 2 },
    });
    expect(ev.aplByPlayer.p1).toBe(3);
    foe.pos = { x: 26, y: 20 };
    expect(markerController(ctx, state, marker)).toBe('p1');
  });

  it('Inspired Strikes: "add 1 to the Critical Dmg stat of weapons on its datacard" while INSPIRING', () => {
    const { ctx, state } = setup();
    const warrior = state.operatives[opWith(state, 'p1', 'celestian-insidiants.insidiant-warrior')]!;
    const foe = state.operatives[opWith(state, 'p2', 'plague-marines.icon-bearer')]!;
    makeInspiring(state, warrior, 'test', 'test');
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: warrior.id,
      defenderId: foe.id,
      attackerWeapon: 'Null mace',
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
      defenderCanRetaliate: true,
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
    const before = foe.wounds;
    inflictDamage(ctx, state, foe, 4, 'attack'); // the null mace's Critical Dmg
    expect(before - foe.wounds).toBe(5);
  });

  it('Holy Example: a firefight ploy "costs 0CP" once per turning point while the SUPERIOR is INSPIRING', () => {
    const { ctx, state } = setup();
    const superior = opWith(state, 'p1', 'celestian-insidiants.insidiant-superior');
    makeInspiring(state, state.operatives[superior]!, 'test', 'test');
    const before = state.teams.p1.cp;
    const s = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: 'celestian-insidiants.fp.fervent-hate', data: { operativeId: superior } },
      ctx,
    ).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP spent, 1CP refunded
  });
});

// ---------------------------------------------------------------------------
describe('CELESTIAN INSIDIANTS bot-vs-bot soak (zero rejected intents)', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const map = mapById(mapId);
      const ctx = createGameContext({
        rng: new SeededRng(41),
        datacards: [...celestianInsidiants.datacards, ...kasrkin.datacards],
        maps: [map],
        teams: [celestianInsidiants, kasrkin],
      });
      for (const mod of [celestianInsidiants, kasrkin]) for (const eq of mod.equipmentDefs) ctx.equipment.set(eq.id, eq);
      const result = playGame({
        ctx,
        map,
        seed: 41,
        critOpId: 'crit.secure',
        rosters: {
          p1: {
            teamId: celestianInsidiants.id,
            operatives: defaultRoster(celestianInsidiants.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: celestianInsidiants.equipment.slice(0, 3).map((e) => e.id),
          },
          p2: {
            teamId: kasrkin.id,
            operatives: defaultRoster(kasrkin.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: kasrkin.equipment.slice(0, 2).map((e) => e.id),
          },
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
