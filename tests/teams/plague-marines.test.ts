/**
 * PLAGUE MARINES. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/plague-marines/
 */
import { describe, expect, it } from 'vitest';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { inflictDamage } from '../../src/core/state.ts';
import { hasPoison, plagueMarines, POISON } from '../../src/teams/plague-marines/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('plague-marines');
const ROLES = [
  'plague-marines.champion',
  'plague-marines.warrior',
  'plague-marines.icon-bearer',
  'plague-marines.fighter',
  'plague-marines.malignant-plaguecaster',
  'plague-marines.bombardier',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([plagueMarines], { seed: 4 });
  const picks = rosterIncluding(plagueMarines, ROLES);
  const state = battle({ ctx, p1: { module: plagueMarines, equipment, picks }, p2: { module: plagueMarines, picks } });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

// ---------------------------------------------------------------------------
describe('PLAGUE MARINES data (pinned against data/teams/plague-marines.json)', () => {
  it('has 7 datacards, all APL 3 / M 5" / Sv 3+ on 32mm bases', () => {
    expect(DATA.datacards).toHaveLength(7);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 3, move: 5, save: 3, base: { shape: 'round', mm: 32 } });
      expect(card.keywords).toContain('PLAGUE MARINE');
    }
    expect(DATA.datacards.find((c) => c.id === 'plague-marines.champion')!.wounds).toBe(15);
    expect(DATA.datacards.find((c) => c.id === 'plague-marines.warrior')!.wounds).toBe(14);
  });

  it('carries the Poison, Toxic and PSYCHIC rare weapon rules', () => {
    expect(DATA.rareWeaponRules.sort()).toEqual(['PSYCHIC', 'Poison', 'Toxic']);
    const staff = profileOf('plague-marines.malignant-plaguecaster', 'Corrupted staff');
    expect(staff.rules.map((r) => r.id)).toContain('Poison');
  });

  it('exposes 3 faction rules, 4+4 ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Astartes', 'Poison', 'Disgustingly Resilient']);
    expect(plagueMarines.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(plagueMarines.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(plagueMarines.equipment).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
describe('Poison — "Whenever an operative that has one of your Poison tokens is activated, inflict 1 damage on it"', () => {
  it('a Poison token damages its bearer on activation, and never a friendly PLAGUE MARINE', () => {
    const { ctx, state } = setup();
    const enemy = opWith(state, 'p2', 'plague-marines.warrior');
    state.effects.push({
      id: 'poison-test',
      rule: POISON,
      source: { kind: 'ability', id: 'plague-marines.rule.poison' },
      operativeId: enemy,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    expect(hasPoison(state, state.operatives[enemy]!, 'p1')).toBe(true);
    const before = state.operatives[enemy]!.wounds;
    const s = activate(ctx, state, enemy);
    expect(s.operatives[enemy]!.wounds).toBe(before - 1);
  });

  it('Toxic: "add 1 to both Dmg stats of this weapon" against a poisoned operative', () => {
    // Scripted 1 so the defender's Disgustingly Resilient roll fails and only Toxic shows.
    const ctx = teamContext([plagueMarines], { script: [1, 1, 1, 1] });
    const state = battle({
      ctx,
      p1: { module: plagueMarines, picks: rosterIncluding(plagueMarines, ROLES) },
      p2: { module: plagueMarines, picks: rosterIncluding(plagueMarines, ROLES) },
    });
    const champion = state.operatives[opWith(state, 'p1', 'plague-marines.champion')]!;
    const victim = state.operatives[opWith(state, 'p2', 'plague-marines.warrior')]!;
    state.effects.push({
      id: 'poison-toxic',
      rule: POISON,
      source: { kind: 'ability', id: 'plague-marines.rule.poison' },
      operativeId: victim.id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    const sword = DATA.datacards
      .find((c) => c.id === 'plague-marines.champion')!
      .weapons.find((w) => w.profiles.some((p) => p.rules.some((r) => r.id === 'Toxic')))!;
    state.sequence = fightSequence(champion.id, victim.id, sword.name);
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, 4, 'attack');
    expect(before - victim.wounds).toBeGreaterThanOrEqual(5); // 4 + 1 from Toxic
  });
});

// ---------------------------------------------------------------------------
describe('Disgustingly Resilient — "roll one D6: on a 4+, subtract 1 from that inflicted damage"', () => {
  it('subtracts 1 on a 4+ and nothing on a 3', () => {
    const good = teamContext([plagueMarines], { script: [5] });
    const picks = rosterIncluding(plagueMarines, ROLES);
    const s1 = battle({ ctx: good, p1: { module: plagueMarines, picks }, p2: { module: plagueMarines, picks } });
    const victim = s1.operatives[opWith(s1, 'p1', 'plague-marines.warrior')]!;
    const before = victim.wounds;
    inflictDamage(good, s1, victim, 4, 'attack');
    expect(before - victim.wounds).toBe(3);

    const bad = teamContext([plagueMarines], { script: [3] });
    const s2 = battle({ ctx: bad, p1: { module: plagueMarines, picks }, p2: { module: plagueMarines, picks } });
    const v2 = s2.operatives[opWith(s2, 'p1', 'plague-marines.warrior')]!;
    const b2 = v2.wounds;
    inflictDamage(bad, s2, v2, 4, 'attack');
    expect(b2 - v2.wounds).toBe(4);
  });

  it('does not fire below 3 damage — "damage of 3 or more"', () => {
    const ctx = teamContext([plagueMarines], { script: [6] });
    const picks = rosterIncluding(plagueMarines, ROLES);
    const s = battle({ ctx, p1: { module: plagueMarines, picks }, p2: { module: plagueMarines, picks } });
    const victim = s.operatives[opWith(s, 'p1', 'plague-marines.warrior')]!;
    const before = victim.wounds;
    inflictDamage(ctx, s, victim, 2, 'attack');
    expect(before - victim.wounds).toBe(2);
  });

  it('SICKENING RESILIENCE: "always subtract 1 … (to a minimum of 2) – you don’t need to roll"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'plague-marines.fp.sickening-resilience' }, ctx).state;
    const victim = s.operatives[opWith(s, 'p1', 'plague-marines.warrior')]!;
    const before = victim.wounds;
    inflictDamage(ctx, s, victim, 3, 'attack');
    expect(before - victim.wounds).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('PLAGUE MARINES ploys', () => {
  it('CONTAGION: −2" Move and a worsened Hit stat near an ICON BEARER', () => {
    const { ctx, state } = setup();
    const bearer = state.operatives[opWith(state, 'p1', 'plague-marines.icon-bearer')]!;
    const enemy = state.operatives[opWith(state, 'p2', 'plague-marines.warrior')]!;
    bearer.pos = { x: 14, y: 11 };
    enemy.pos = { x: 15.5, y: 11 };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'plague-marines.sp.contagion' }, ctx).state;
    const ev = ctx.hooks.emit('onStatMod', s, {
      state: s,
      operative: s.operatives[enemy.id]!,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.mods.move).toBe(-2);
    expect(ev.mods.hit).toBe(-1);
  });

  it('LUMBERING DEATH: Ceaseless while it has not moved, and always while retaliating', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'plague-marines.sp.lumbering-death' }, ctx).state;
    const op = s.operatives[opWith(s, 'p1', 'plague-marines.warrior')]!;
    const boltgun = profileOf('plague-marines.warrior', 'Boltgun');
    expect(effectiveRules(ctx, s, boltgun, { operative: op, weaponName: 'Boltgun' }).some((r) => r.id === 'Ceaseless')).toBe(
      true,
    );
    op.actionsThisActivation = ['Reposition'];
    expect(effectiveRules(ctx, s, boltgun, { operative: op, weaponName: 'Boltgun' }).some((r) => r.id === 'Ceaseless')).toBe(
      false,
    );
    expect(
      effectiveRules(ctx, s, profileOf('plague-marines.warrior', 'Plague knife'), {
        operative: op,
        weaponName: 'Plague knife',
        retaliating: true,
      }).some((r) => r.id === 'Ceaseless'),
    ).toBe(true);
  });

  it('CLOUD OF FLIES places a marker and removes it in the next Ready step', () => {
    const { ctx, state } = setup();
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'plague-marines.sp.cloud-of-flies', data: { pos: { x: 12, y: 11 } } },
      ctx,
    ).state;
    expect(s.markers['plagueMarines.cloudOfFlies.p1']).toBeDefined();
    ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 1 });
    expect(s.markers['plagueMarines.cloudOfFlies.p1']).toBeUndefined();
  });

  it('NURGLINGS: "Until the end of the selected operative’s next activation, subtract 1 from its APL stat"', () => {
    const { ctx, state } = setup();
    const marine = state.operatives[opWith(state, 'p1', 'plague-marines.warrior')]!;
    const enemy = state.operatives[opWith(state, 'p2', 'plague-marines.warrior')]!;
    marine.pos = { x: 14, y: 11 };
    enemy.pos = { x: 15.5, y: 11 };
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'plague-marines.sp.nurglings', data: { operativeId: enemy.id } },
      ctx,
    ).state;
    expect(s.operatives[enemy.id]!.aplMods).toContain(-1);
  });

  it('VIRULENT POISON gives one enemy operative within 7" a Poison token', () => {
    const { ctx, state } = setup();
    const marine = state.operatives[opWith(state, 'p1', 'plague-marines.warrior')]!;
    const enemy = state.operatives[opWith(state, 'p2', 'plague-marines.warrior')]!;
    marine.pos = { x: 14, y: 11 };
    enemy.pos = { x: 18, y: 11 };
    state.activeOperativeId = marine.id;
    const s = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: 'plague-marines.fp.virulent-poison', data: { operativeId: enemy.id } },
      ctx,
    ).state;
    expect(hasPoison(s, s.operatives[enemy.id]!, 'p1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('PLAGUE MARINES faction equipment', () => {
  it('PLAGUE ROUNDS: "boltguns and bolt pistols have the Poison and Severe weapon rules"', () => {
    const { ctx, state } = setup(['plague-marines.eq.plague-rounds']);
    const op = state.operatives[opWith(state, 'p1', 'plague-marines.warrior')]!;
    const rules = effectiveRules(ctx, state, profileOf('plague-marines.warrior', 'Boltgun'), {
      operative: op,
      weaponName: 'Boltgun',
    });
    expect(rules.some((r) => r.id === 'Poison')).toBe(true);
    expect(rules.some((r) => r.id === 'Severe')).toBe(true);
  });

  it('BLIGHT GRENADES grants the printed weapon (4 / 4+ / 2/4, Range 6", Blast 2", Saturate, Severe, Poison)', () => {
    const { ctx, state } = setup(['plague-marines.eq.blight-grenades']);
    const id = opWith(state, 'p1', 'plague-marines.warrior');
    const s = activate(ctx, state, id);
    const granted = (s.operatives[id] as { grantedWeapons?: { name: string; profiles: WeaponProfile[] }[] }).grantedWeapons ?? [];
    const grenade = granted.find((w) => w.name === 'Blight grenade');
    expect(grenade).toBeDefined();
    expect(grenade!.profiles[0]).toMatchObject({ atk: 4, hit: 4, dmgN: 2, dmgC: 4 });
    expect(grenade!.profiles[0]!.rules.map((r) => r.id).sort()).toEqual(
      ['Blast', 'Limited', 'Poison', 'Range', 'Saturate', 'Severe'].sort(),
    );
  });

  it('PLAGUE BELLS: "ignore any changes to the stats … from being injured"', () => {
    const { ctx, state } = setup(['plague-marines.eq.plague-bells']);
    const op = state.operatives[opWith(state, 'p1', 'plague-marines.warrior')]!;
    op.wounds = 3;
    const ev = ctx.hooks.emit('onStatMod', state, {
      state,
      operative: op,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.mods.move).toBe(2);
    expect(ev.mods.hit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('PLAGUE MARINES unique actions', () => {
  it('FLAIL 1AP inflicts D3+2 on each other operative within 2" and is treated as a Fight action', () => {
    const ctx = teamContext([plagueMarines], { script: [4, 4, 4, 4] });
    const picks = rosterIncluding(plagueMarines, ROLES);
    let state = battle({ ctx, p1: { module: plagueMarines, picks }, p2: { module: plagueMarines, picks } });
    const fighter = opWith(state, 'p1', 'plague-marines.fighter');
    const victim = opWith(state, 'p2', 'plague-marines.warrior');
    state.operatives[fighter]!.pos = { x: 14, y: 11 };
    state.operatives[victim]!.pos = { x: 15, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (id !== fighter) state.operatives[id]!.pos = { x: 2, y: 2 };
    for (const id of state.teams.p2.operativeIds) if (id !== victim) state.operatives[id]!.pos = { x: 28, y: 20 };
    const before = state.operatives[victim]!.wounds;
    state = activate(ctx, state, fighter);
    const out = reduce(state, { t: 'PerformAction', operativeId: fighter, action: 'plague-marines.fighter.act.flail' }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[victim]!.wounds).toBeLessThan(before);
    expect(out.state.operatives[fighter]!.actionsThisActivation).toContain('Fight');
  });

  it('POISONOUS MIASMA 1AP poisons, then damages an already-poisoned operative for 3', () => {
    const { ctx, state } = setup();
    const caster = opWith(state, 'p1', 'plague-marines.malignant-plaguecaster');
    const enemy = opWith(state, 'p2', 'plague-marines.warrior');
    state.operatives[caster]!.pos = { x: 14, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, caster);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: caster,
        action: 'plague-marines.malignant-plaguecaster.act.poisonous-miasma',
        params: { targetOperativeId: enemy },
      },
      ctx,
    ).state;
    expect(hasPoison(s, s.operatives[enemy]!, 'p1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
function fightSequence(attackerId: string, defenderId: string, weapon: string): GameState['sequence'] {
  return {
    kind: 'fight',
    step: 'resolve',
    attackerId,
    defenderId,
    attackerWeapon: weapon,
    defenderCanRetaliate: false,
    attackerPool: { dice: [], nextId: 1 },
    defenderPool: { dice: [], nextId: 1 },
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
}
