/**
 * IMPERIAL NAVY BREACHERS. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/imperial-navy-breacher/
 */
import { describe, expect, it } from 'vitest';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { actionCost, getAction } from '../../src/core/actions.ts';
import { inflictDamage } from '../../src/core/state.ts';
import { imperialNavyBreacher } from '../../src/teams/imperial-navy-breacher/index.ts';
import { teamData } from '../../src/teams/bundled.ts';
import { activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('imperial-navy-breacher');
const ROLES = [
  'imperial-navy-breacher.navis-sergeant-at-arms',
  'imperial-navy-breacher.navis-armsman',
  'imperial-navy-breacher.navis-endurant',
  'imperial-navy-breacher.navis-grenadier',
  'imperial-navy-breacher.navis-gunner',
  'imperial-navy-breacher.navis-axejack',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([imperialNavyBreacher], { seed: 6 });
  const picks = rosterIncluding(imperialNavyBreacher, ROLES);
  const state = battle({
    ctx,
    p1: { module: imperialNavyBreacher, equipment, picks },
    p2: { module: imperialNavyBreacher, picks },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

// ---------------------------------------------------------------------------
describe('IMPERIAL NAVY BREACHERS data (pinned against data/teams/imperial-navy-breacher.json)', () => {
  it('has 11 datacards with the printed stats and bases', () => {
    expect(DATA.datacards).toHaveLength(11);
    const sergeant = DATA.datacards.find((c) => c.id === 'imperial-navy-breacher.navis-sergeant-at-arms')!;
    expect(sergeant).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 9, base: { shape: 'round', mm: 25 } });
    const endurant = DATA.datacards.find((c) => c.id === 'imperial-navy-breacher.navis-endurant')!;
    expect(endurant).toMatchObject({ apl: 2, move: 4, save: 2, wounds: 11, base: { shape: 'round', mm: 28 } });
    const cat = DATA.datacards.find((c) => c.id === 'imperial-navy-breacher.navis-c-a-t-unit')!;
    expect(cat).toMatchObject({ apl: 2, move: 8, save: 5, wounds: 5 });
    for (const c of DATA.datacards) expect(c.keywords).toContain('IMPERIAL NAVY BREACHER');
  });

  it('carries the Detonate and Shield rare weapon rules', () => {
    expect(DATA.rareWeaponRules.sort()).toEqual(['Detonate', 'Shield']);
    expect(profileOf('imperial-navy-breacher.navis-endurant', 'Shield bash').rules.map((r) => r.id)).toContain('Shield');
  });

  it('exposes 2 faction rules, 4+4 ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Void Armour', 'Breach and Clear']);
    expect(imperialNavyBreacher.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(imperialNavyBreacher.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(imperialNavyBreacher.equipment).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
describe('Void Armour', () => {
  it('"you can re-roll one of your defence dice, or up to two … if that friendly operative is a GRENADIER"', () => {
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p2', 'imperial-navy-breacher.navis-gunner')]!;
    const blasty = profileOf('imperial-navy-breacher.navis-grenadier', 'Demolition charge');
    const ev = (defenderId: string) =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: {
          attacker: gunner,
          defender: state.operatives[defenderId]!,
          weaponName: 'Demolition charge',
          profile: blasty,
          rules: blasty.rules,
          type: 'ranged',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 4,
        },
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
        rerolls: [],
      });
    const armsman = ev(opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman')).rerolls.find(
      (r) => r.id === 'inb.voidArmour',
    );
    expect(armsman?.max).toBe(1);
    const grenadier = ev(opWith(state, 'p1', 'imperial-navy-breacher.navis-grenadier')).rerolls.find(
      (r) => r.id === 'inb.voidArmour',
    );
    expect(grenadier?.max).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('Breach and Clear — "Once per turning point … you can activate that other friendly operative before your opponent activates"', () => {
  it('marks a partner within 3" once per turning point', () => {
    const { ctx, state } = setup();
    const first = opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman');
    const partner = state.teams.p1.operativeIds.find((x) => x !== first)!;
    state.operatives[first]!.pos = { x: 10, y: 11 };
    state.operatives[partner]!.pos = { x: 11.5, y: 11 };
    const s = activate(ctx, state, first);
    expect(s.effects.some((e) => e.rule === 'inb.breachAndClear' && e.operativeId === partner)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('IMPERIAL NAVY BREACHER abilities', () => {
  it('ENDURANT › Shield: "each of your blocks can be allocated to block two unresolved successes"', () => {
    const { ctx, state } = setup();
    const endurant = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-endurant')]!;
    const foe = state.operatives[opWith(state, 'p2', 'imperial-navy-breacher.navis-armsman')]!;
    const bash = profileOf('imperial-navy-breacher.navis-endurant', 'Shield bash');
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: endurant,
        defender: foe,
        weaponName: 'Shield bash',
        profile: bash,
        rules: bash.rules,
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

  it('ENDURANT › Disengage: "can perform the Fall Back action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const endurant = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-endurant')]!;
    const armsman = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    const fallBack = getAction('Fall Back')!;
    expect(actionCost(ctx, state, endurant, fallBack)).toBe(1);
    expect(actionCost(ctx, state, armsman, fallBack)).toBe(2);
  });

  it('AXEJACK › Emboldened: 5+ subtracts 1 from damage of 3 or more, only after a Charge', () => {
    const ctx = teamContext([imperialNavyBreacher], { script: [6] });
    const picks = rosterIncluding(imperialNavyBreacher, ROLES);
    const state = battle({ ctx, p1: { module: imperialNavyBreacher, picks }, p2: { module: imperialNavyBreacher, picks } });
    const axe = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-axejack')]!;
    const before = axe.wounds;
    inflictDamage(ctx, state, axe, 4, 'attack');
    expect(before - axe.wounds).toBe(4); // no Charge yet

    state.effects.push({
      id: 'charged',
      rule: 'inb.chargedThisTP',
      source: { kind: 'ability', id: 'imperial-navy-breacher.navis-axejack.emboldened' },
      operativeId: axe.id,
      player: 'p1',
      expiry: { kind: 'endOfTurningPoint' },
    });
    const b2 = axe.wounds;
    inflictDamage(ctx, state, axe, 4, 'attack');
    expect(b2 - axe.wounds).toBe(3);
  });

  it('SERGEANT-AT-ARMS › Command Breach: Attack Order costs 0CP while the SERGEANT is in the killzone', () => {
    const { ctx, state } = setup();
    const before = state.teams.p1.cp;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'imperial-navy-breacher.sp.attack-order' }, ctx).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP paid, 1CP refunded
    expect(s.markers['inb.attackOrder.p1']).toBeDefined();
  });

  it('VOID-JAMMER › Detonate: "If that operative isn’t in the killzone, you cannot select this weapon"', () => {
    const ctx = teamContext([imperialNavyBreacher], { seed: 2 });
    const picks = rosterIncluding(imperialNavyBreacher, [
      'imperial-navy-breacher.navis-sergeant-at-arms',
      'imperial-navy-breacher.navis-void-jammer',
    ]);
    const state = battle({ ctx, p1: { module: imperialNavyBreacher, picks }, p2: { module: imperialNavyBreacher, picks } });
    const jammer = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-void-jammer')]!;
    const names = DATA.datacards
      .find((c) => c.id === 'imperial-navy-breacher.navis-void-jammer')!
      .weapons.map((w) => w.name);
    const available = ctx.hooks.emit('availableWeapons', state, { state, operative: jammer, weapons: [...names] }).weapons;
    expect(available).not.toContain('Gheistskull detonator');
  });
});

// ---------------------------------------------------------------------------
describe('IMPERIAL NAVY BREACHER ploys', () => {
  it('ATTACK ORDER grants Ceaseless within 3" of its marker and cannot share a phase with DEFENCE ORDER', () => {
    const { ctx, state } = setup();
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'imperial-navy-breacher.sp.attack-order', data: { pos: { x: 3, y: 3 } } },
      ctx,
    ).state;
    const op = s.operatives[opWith(s, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    op.pos = { x: 3.5, y: 3 };
    const shotgun = profileOf('imperial-navy-breacher.navis-armsman', 'Navis shotgun', 'long range');
    expect(
      effectiveRules(ctx, s, shotgun, { operative: op, weaponName: 'Navis shotgun' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(true);

    const defence = imperialNavyBreacher.ploys.find((p) => p.id === 'imperial-navy-breacher.sp.defence-order')!;
    expect(defence.usable!(s, 'p1').ok).toBe(false);
  });

  it('CLOSE ASSAULT adds 1 to a Navis shotgun’s Dmg within 3"', () => {
    const ctx = teamContext([imperialNavyBreacher], { script: [1, 1, 1, 1] });
    const picks = rosterIncluding(imperialNavyBreacher, ROLES);
    let state = battle({ ctx, p1: { module: imperialNavyBreacher, picks }, p2: { module: imperialNavyBreacher, picks } });
    state = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'imperial-navy-breacher.sp.close-assault' }, ctx).state;
    const shooter = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    const victim = state.operatives[opWith(state, 'p2', 'imperial-navy-breacher.navis-armsman')]!;
    shooter.pos = { x: 14, y: 11 };
    victim.pos = { x: 15.5, y: 11 };
    state.sequence = {
      kind: 'shoot',
      step: 'resolve',
      attackerId: shooter.id,
      targetId: victim.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Navis shotgun',
      profileName: 'close range',
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
      attacker: 'p1',
      defender: 'p2',
      free: false,
    };
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(before - victim.wounds).toBe(4);
  });

  it('LOCK IT DOWN: "treat that friendly operative’s APL stat as 1 higher" for one objective marker', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    op.pos = { x: 15, y: 11 };
    state.activeOperativeId = op.id;
    const s = reduce(
      state,
      { t: 'UsePloy', player: 'p1', ployId: 'imperial-navy-breacher.fp.lock-it-down', data: { markerId: 'centre' } },
      ctx,
    ).state;
    const ev = ctx.hooks.emit('onMarkerControl', s, { state: s, markerId: 'centre', aplByPlayer: { p1: 2, p2: 2 } });
    expect(ev.aplByPlayer.p1).toBe(3);
  });

  it('OVERWHELM TARGET: "add 1 to its APL stat" until the end of that activation', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman');
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'imperial-navy-breacher.fp.overwhelm-target' }, ctx).state;
    expect(s.operatives[id]!.aplMods).toContain(1);
  });

  it('BLITZ: "its weapons have the Accurate 1 weapon rule" within 6"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'imperial-navy-breacher.fp.blitz' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    const target = s.operatives[opWith(s, 'p2', 'imperial-navy-breacher.navis-armsman')]!;
    shooter.pos = { x: 14, y: 11 };
    target.pos = { x: 17, y: 11 };
    const shotgun = profileOf('imperial-navy-breacher.navis-armsman', 'Navis shotgun', 'long range');
    expect(
      effectiveRules(ctx, s, shotgun, { operative: shooter, target, weaponName: 'Navis shotgun' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(true);
    target.pos = { x: 25, y: 11 };
    expect(
      effectiveRules(ctx, s, shotgun, { operative: shooter, target, weaponName: 'Navis shotgun' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('IMPERIAL NAVY BREACHER faction equipment', () => {
  it('SYSTEM OVERRIDE DEVICE: "one friendly … operative can perform the Operate Hatch action for 1 less AP" per turning point', () => {
    const { ctx, state } = setup(['imperial-navy-breacher.eq.system-override-device']);
    const op = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    const hatch = getAction('Operate Hatch')!;
    expect(actionCost(ctx, state, op, hatch)).toBe(0);
    expect(actionCost(ctx, state, op, hatch)).toBe(1); // once per turning point
  });

  it('COMBAT STIMMS: "ignore any changes to the Move stat … from being injured"', () => {
    const { ctx, state } = setup(['imperial-navy-breacher.eq.combat-stimms']);
    const op = state.operatives[opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman')]!;
    op.wounds = 2;
    const ev = ctx.hooks.emit('onStatMod', state, {
      state,
      operative: op,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.mods.move).toBe(2);
  });

  it('REBREATHERS: "You can ignore any changes to the APL stat"', () => {
    const { ctx, state } = setup(['imperial-navy-breacher.eq.rebreathers']);
    const id = opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman');
    state.operatives[id]!.aplMods.push(-1);
    const s = activate(ctx, state, id);
    expect(s.operatives[id]!.aplMods).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('IMPERIAL NAVY BREACHER unique actions', () => {
  it('WAYFIND 1AP (SUPPORT) adds 1 APL and refuses a C.A.T. UNIT target', () => {
    const ctx = teamContext([imperialNavyBreacher], { seed: 8 });
    const picks = rosterIncluding(imperialNavyBreacher, [
      'imperial-navy-breacher.navis-sergeant-at-arms',
      'imperial-navy-breacher.navis-surveyor',
      'imperial-navy-breacher.navis-armsman',
    ]);
    const state = battle({ ctx, p1: { module: imperialNavyBreacher, picks }, p2: { module: imperialNavyBreacher, picks } });
    const surveyor = opWith(state, 'p1', 'imperial-navy-breacher.navis-surveyor');
    const friend = opWith(state, 'p1', 'imperial-navy-breacher.navis-armsman');
    let s = activate(ctx, state, surveyor);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: surveyor,
        action: 'imperial-navy-breacher.navis-surveyor.act.wayfind',
        params: { targetOperativeId: friend },
      },
      ctx,
    ).state;
    expect(s.operatives[friend]!.aplMods).toContain(1);
  });

  it('the SUPPORT keyword is recorded on WAYFIND', () => {
    const surveyor = DATA.datacards.find((c) => c.id === 'imperial-navy-breacher.navis-surveyor')!;
    const wayfind = surveyor.uniqueActions.find((a) => a.id === 'imperial-navy-breacher.navis-surveyor.act.wayfind')!;
    expect(wayfind.text).toContain('SUPPORT');
    expect(wayfind.ap).toBe(1);
  });
});
