/**
 * ANGELS OF DEATH. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/angel-of-death/
 */
import { describe, expect, it } from 'vitest';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { actionCost, getAction } from '../../src/core/actions.ts';
import { counteractCandidates, whoActivates } from '../../src/core/phases.ts';
import { HookRegistry } from '../../src/core/hooks.ts';
import { inflictDamage } from '../../src/core/state.ts';
import {
  angelOfDeath,
  CHAPTER_TACTICS,
  doctrineGambitId,
  setChapterTactics,
  setVeteranTactic,
} from '../../src/teams/angel-of-death/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('angel-of-death');
const ROLES = [
  'angel-of-death.intercessor-sergeant',
  'angel-of-death.intercessor-warrior',
  'angel-of-death.assault-intercessor-warrior',
  'angel-of-death.eliminator-sniper',
  'angel-of-death.heavy-intercessor-gunner',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([angelOfDeath], { seed: 9 });
  const picks = rosterIncluding(angelOfDeath, ROLES);
  const state = battle({ ctx, p1: { module: angelOfDeath, equipment, picks }, p2: { module: angelOfDeath, picks } });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

// ---------------------------------------------------------------------------
describe('ANGELS OF DEATH data (pinned against data/teams/angel-of-death.json)', () => {
  it('has 9 datacards with the printed stats and bases', () => {
    expect(DATA.datacards).toHaveLength(9);
    const captain = DATA.datacards.find((c) => c.id === 'angel-of-death.space-marine-captain')!;
    expect(captain).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 15, base: { shape: 'round', mm: 40 } });
    const heavy = DATA.datacards.find((c) => c.id === 'angel-of-death.heavy-intercessor-gunner')!;
    expect(heavy).toMatchObject({ apl: 3, move: 5, save: 3, wounds: 18, base: { shape: 'round', mm: 40 } });
    const sniper = DATA.datacards.find((c) => c.id === 'angel-of-death.eliminator-sniper')!;
    expect(sniper).toMatchObject({ apl: 3, move: 7, save: 3, wounds: 12 });
    for (const c of DATA.datacards) expect(c.keywords).toContain('ANGEL OF DEATH');
  });

  it('exposes 2 faction rules, 4+4 ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Chapter Tactics', 'Astartes']);
    expect(angelOfDeath.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(angelOfDeath.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(angelOfDeath.equipment).toHaveLength(4);
    expect(CHAPTER_TACTICS).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
describe('Chapter Tactics — "select a primary and secondary CHAPTER TACTIC … to gain for the battle"', () => {
  it('nothing applies until the tactics are chosen', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', 'angel-of-death.assault-intercessor-warrior')]!;
    const chainsword = profileOf('angel-of-death.assault-intercessor-warrior', 'Chainsword');
    expect(
      effectiveRules(ctx, state, chainsword, { operative: op, weaponName: 'Chainsword' }).some((r) => r.id === 'Rending'),
    ).toBe(false);
  });

  it('AGGRESSIVE: "This operative’s melee weapons have the Rending weapon rule"', () => {
    const { ctx, state } = setup();
    setChapterTactics(state, 'p1', 'aggressive', 'hardy');
    const op = state.operatives[opWith(state, 'p1', 'angel-of-death.assault-intercessor-warrior')]!;
    const chainsword = profileOf('angel-of-death.assault-intercessor-warrior', 'Chainsword');
    expect(
      effectiveRules(ctx, state, chainsword, { operative: op, weaponName: 'Chainsword' }).some((r) => r.id === 'Rending'),
    ).toBe(true);
    // Ranged weapons are unaffected.
    const pistol = profileOf('angel-of-death.assault-intercessor-warrior', 'Heavy bolt pistol');
    expect(
      effectiveRules(ctx, state, pistol, { operative: op, weaponName: 'Heavy bolt pistol' }).some((r) => r.id === 'Rending'),
    ).toBe(false);
  });

  it('MOBILE: "This operative can perform the Fall Back action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', 'angel-of-death.intercessor-warrior')]!;
    const fallBack = getAction('Fall Back')!;
    expect(actionCost(ctx, state, op, fallBack)).toBe(2);
    setChapterTactics(state, 'p1', 'mobile', 'hardy');
    expect(actionCost(ctx, state, op, fallBack)).toBe(1);
  });

  it('DUELLER: "each of your normal successes can block one unresolved critical success (unless … Brutal)"', () => {
    const { ctx, state } = setup();
    setChapterTactics(state, 'p1', 'dueller', 'hardy');
    const me = state.operatives[opWith(state, 'p1', 'angel-of-death.intercessor-warrior')]!;
    const them = state.operatives[opWith(state, 'p2', 'angel-of-death.intercessor-warrior')]!;
    const fists = profileOf('angel-of-death.intercessor-warrior', 'Fists');
    const evt = (brutal: boolean) =>
      ctx.hooks.emit('onBlockAllocation', state, {
        state,
        ctx: {
          attacker: me,
          defender: them,
          weaponName: 'Fists',
          profile: fists,
          rules: fists.rules,
          type: 'melee',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 0,
        },
        brutal,
        blocks: 1,
        normalsCanBlockCrits: false,
      });
    expect(evt(false).normalsCanBlockCrits).toBe(true);
    expect(evt(true).normalsCanBlockCrits).toBe(false);
  });

  it('RESOLUTE: "You can ignore any changes to this operative’s APL stat"', () => {
    const { ctx, state } = setup();
    setChapterTactics(state, 'p1', 'resolute', 'hardy');
    const id = opWith(state, 'p1', 'angel-of-death.intercessor-warrior');
    state.operatives[id]!.aplMods.push(-1);
    const s = activate(ctx, state, id);
    expect(s.operatives[id]!.aplMods).toEqual([]);
  });

  it('STEALTHY: "you can retain one additional cover save"', () => {
    const { ctx, state } = setup();
    setChapterTactics(state, 'p1', 'stealthy', 'hardy');
    const target = state.operatives[opWith(state, 'p1', 'angel-of-death.intercessor-warrior')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'angel-of-death.intercessor-warrior')]!;
    const rifle = profileOf('angel-of-death.intercessor-warrior', 'Bolt rifle');
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: target,
        weaponName: 'Bolt rifle',
        profile: rifle,
        rules: rifle.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: true,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(1);
  });

  it('CHAPTER VETERAN grants one extra tactic to one operative only', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'angel-of-death.intercessor-sergeant');
    setVeteranTactic(state, 'p1', id, 'aggressive');
    const sword = profileOf('angel-of-death.intercessor-sergeant', 'Chainsword');
    expect(
      effectiveRules(ctx, state, sword, { operative: state.operatives[id]!, weaponName: 'Chainsword' }).some(
        (r) => r.id === 'Rending',
      ),
    ).toBe(true);
    const other = state.operatives[opWith(state, 'p1', 'angel-of-death.intercessor-warrior')]!;
    expect(
      effectiveRules(ctx, state, profileOf('angel-of-death.intercessor-warrior', 'Fists'), {
        operative: other,
        weaponName: 'Fists',
      }).some((r) => r.id === 'Rending'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('offers a second Shoot only after a first, and refuses to mix Shoot with Fight', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'angel-of-death.intercessor-warrior');
    const enemy = opWith(state, 'p2', 'angel-of-death.intercessor-warrior');
    const s = activate(ctx, state, id);
    const early = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Astartes)', params: { weaponName: 'Bolt rifle', targetId: enemy } },
      ctx,
    );
    expect(early.reason).toMatch(/second Shoot action/);

    const mixed = { ...s };
    mixed.operatives[id]!.actionsThisActivation = ['Shoot', 'Fight'];
    const bad = reduce(mixed, { t: 'PerformAction', operativeId: id, action: 'Fight (Astartes)', params: {} }, ctx);
    expect(bad.reason).toMatch(/either two Shoot actions or two Fight actions/);
  });

  it('"a bolt weapon must be selected for at least one of them"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'angel-of-death.eliminator-sniper');
    const enemy = opWith(state, 'p2', 'angel-of-death.intercessor-warrior');
    const s = activate(ctx, state, id);
    s.operatives[id]!.actionsThisActivation = ['Shoot'];
    // No bolt weapon recorded and Fists is not a bolt weapon → refused.
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Astartes)', params: { weaponName: 'Fists', targetId: enemy } },
      ctx,
    );
    expect(out.reason).toMatch(/bolt weapon/);
  });

  it('"Each friendly ANGEL OF DEATH operative can counteract regardless of its order"', () => {
    const { ctx, state } = setup();
    // Every friendly operative is expended on a Conceal order; the enemy still has activations left.
    for (const id of state.teams['p1'].operativeIds) {
      const op = state.operatives[id]!;
      op.ready = false;
      op.expended = true;
      op.order = 'conceal';
    }
    // Core default is "expended and has an Engage order", so without Astartes p1 would have no
    // counteract at all here and the turn would pass straight back to p2.
    expect(whoActivates(state, ctx)).toEqual({ player: 'p1', mode: 'counteract' });

    const conceal = state.operatives[opWith(state, 'p1', 'angel-of-death.intercessor-warrior')]!;
    const engage = state.operatives[opWith(state, 'p1', 'angel-of-death.assault-intercessor-warrior')]!;
    const spent = state.operatives[opWith(state, 'p1', 'angel-of-death.eliminator-sniper')]!;
    const guarded = state.operatives[opWith(state, 'p1', 'angel-of-death.heavy-intercessor-gunner')]!;
    const enemy = state.operatives[opWith(state, 'p2', 'angel-of-death.intercessor-warrior')]!;
    engage.order = 'engage';
    spent.counteractedThisTP = true; // "can counteract once during the turning point"
    guarded.guardSpentTP = state.turningPoint; // "cannot counteract during the turning point" after On Guard
    enemy.ready = false;
    enemy.expended = true;
    enemy.order = 'conceal';

    const mine = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(mine).toContain(conceal.id); // widened by Astartes — a Conceal order is no bar
    expect(mine).toContain(engage.id); // the printed default is untouched
    expect(mine).not.toContain(spent.id); // once per turning point still holds
    expect(mine).not.toContain(guarded.id); // the On Guard lockout still holds
    expect(mine).not.toContain(enemy.id); // "EACH FRIENDLY ANGEL OF DEATH operative"

    // Scope check: p1's own binding leaves an enemy operative at the core default.
    const p1Only = new HookRegistry();
    angelOfDeath.register(p1Only, 'p1', ctx);
    expect(p1Only.emit('onCounteract', state, { state, operative: enemy, allowed: false }).allowed).toBe(false);
    expect(p1Only.emit('onCounteract', state, { state, operative: conceal, allowed: false }).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ANGELS OF DEATH ploys and equipment', () => {
  it('COMBAT DOCTRINE offers one gambit per doctrine and grants Balanced in that band', () => {
    const { ctx, state } = setup();
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(options.filter((o) => o.id.startsWith('angel-of-death.sp.combat-doctrine:'))).toHaveLength(3);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: doctrineGambitId('devastator') }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'angel-of-death.intercessor-warrior')]!;
    const target = s.operatives[opWith(s, 'p2', 'angel-of-death.intercessor-warrior')]!;
    shooter.pos = { x: 4, y: 11 };
    target.pos = { x: 20, y: 11 };
    const rifle = profileOf('angel-of-death.intercessor-warrior', 'Bolt rifle');
    expect(
      effectiveRules(ctx, s, rifle, { operative: shooter, target, weaponName: 'Bolt rifle' }).some((r) => r.id === 'Balanced'),
    ).toBe(true);
    // "Devastator Doctrine: Shooting an operative MORE THAN 6" from it."
    target.pos = { x: 8, y: 11 };
    expect(
      effectiveRules(ctx, s, rifle, { operative: shooter, target, weaponName: 'Bolt rifle' }).some((r) => r.id === 'Balanced'),
    ).toBe(false);
  });

  it('AND THEY SHALL KNOW NO FEAR ignores the injured stat changes', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'angel-of-death.intercessor-warrior');
    state.operatives[id]!.wounds = 3; // fewer than half of 14
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'angel-of-death.sp.and-they-shall-know-no-fear' }, ctx).state;
    const ev = ctx.hooks.emit('onStatMod', s, {
      state: s,
      operative: s.operatives[id]!,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.mods.move).toBe(2);
    expect(ev.mods.hit).toBe(1);
  });

  it('SHOCK ASSAULT gives the melee weapon Shock after a Charge', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'angel-of-death.fp.shock-assault' }, ctx).state;
    const op = s.operatives[opWith(s, 'p1', 'angel-of-death.assault-intercessor-warrior')]!;
    const sword = profileOf('angel-of-death.assault-intercessor-warrior', 'Chainsword');
    expect(effectiveRules(ctx, s, sword, { operative: op, weaponName: 'Chainsword' }).some((r) => r.id === 'Shock')).toBe(
      false,
    );
    op.actionsThisActivation = ['Charge'];
    expect(effectiveRules(ctx, s, sword, { operative: op, weaponName: 'Chainsword' }).some((r) => r.id === 'Shock')).toBe(
      true,
    );
  });

  it('AUSPEX: "enemy operatives within 8" of that friendly operative cannot be obscured"', () => {
    const { ctx, state } = setup(['angel-of-death.eq.auspex']);
    const shooter = state.operatives[opWith(state, 'p1', 'angel-of-death.intercessor-warrior')]!;
    const target = state.operatives[opWith(state, 'p2', 'angel-of-death.intercessor-warrior')]!;
    shooter.pos = { x: 12, y: 11 };
    target.pos = { x: 16, y: 11 };
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('all');
  });

  it('Iron Halo: "Once per battle, when an attack dice inflicts Normal Dmg on this operative, you can ignore that inflicted damage"', () => {
    const ctx = teamContext([angelOfDeath], { seed: 3 });
    const picks = rosterIncluding(angelOfDeath, ['angel-of-death.space-marine-captain', 'angel-of-death.intercessor-warrior']);
    const state = battle({ ctx, p1: { module: angelOfDeath, picks }, p2: { module: angelOfDeath, picks } });
    const captain = state.operatives[opWith(state, 'p1', 'angel-of-death.space-marine-captain')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'angel-of-death.intercessor-warrior')]!;
    state.sequence = {
      kind: 'shoot',
      step: 'resolve',
      attackerId: shooter.id,
      targetId: captain.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Bolt rifle',
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
    const dmgN = profileOf('angel-of-death.intercessor-warrior', 'Bolt rifle').dmgN;
    const before = captain.wounds;
    inflictDamage(ctx, state, captain, dmgN, 'attack');
    expect(captain.wounds).toBe(before); // ignored
    inflictDamage(ctx, state, captain, dmgN, 'attack');
    expect(captain.wounds).toBe(before - dmgN); // once per battle
  });
});
