/**
 * DEATH KORPS (Astra Militarum). Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/death-korps/
 */
import { describe, expect, it } from 'vitest';
import { availableActions } from '../../src/core/actions.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aplOf, inflictDamage, saveOf, weaponsOf } from '../../src/core/state.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import type { GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import {
  C,
  GAS_MARKER,
  MINE_MARKER,
  ORDERS,
  ORDER_LABEL,
  ORDER_TEXT,
  PICK_UP_MINE,
  PLACE_MINE,
  DETONATE_SHOOT,
  deathKorps,
  hasOrder,
  ordersOn,
  orderGambitId,
  secondInCommandUsed,
  useSecondInCommand,
} from '../../src/teams/death-korps/index.ts';
import { act, activate, battle, opWith, settle, teamContext } from './harness.ts';

const DATA = teamData('death-korps');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const SP = {
  siegeWarfare: 'death-korps.sp.siege-warfare',
  takeCover: 'death-korps.sp.take-cover',
  clearTheLine: 'death-korps.sp.clear-the-line',
  regroup: 'death-korps.sp.regroup',
};
const FP = {
  inspirationalLeadership: 'death-korps.fp.inspirational-leadership',
  combinedArms: 'death-korps.fp.combined-arms',
  inLifeShame: 'death-korps.fp.in-life-shame',
  inDeathAtonement: 'death-korps.fp.in-death-atonement',
};
const EQ = {
  chronometer: 'death-korps.eq.chronometer',
  commBeads: 'death-korps.eq.comm-beads',
  handAxes: 'death-korps.eq.hand-axes',
  gasBombardment: 'death-korps.eq.gas-bombardment',
};
const ACT = {
  medikit: `${C.medic}.act.medikit`,
  spot: `${C.spotter}.act.spot`,
  signal: `${C.voxOperator}.act.signal`,
};
const ORDERS_RULE = 'death-korps.rule.guardsmen-orders';

/** One of every datacard, in a column, so a rule test can place exactly what it needs. */
const EVERY_CARD = DATA.datacards.map((c) => c.id);
const column = (x: number): Vec2[] => EVERY_CARD.map((_, i) => ({ x, y: 1 + i * 1.7 }));

function setup(
  opts: { equipment?: string[]; script?: number[]; seed?: number } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([deathKorps], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = EVERY_CARD.map((id) => ({ datacardId: id }));
  const state = battle({
    ctx,
    p1: { module: deathKorps, picks, positions: column(3), ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: deathKorps, picks, positions: column(27) },
  });
  state.teams.p1.cp = 8;
  state.teams.p2.cp = 8;
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
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

/** A shoot sequence parked mid-flight, so a rule that reads `state.sequence` can be pinned. */
function fakeShoot(
  state: GameState,
  attackerId: string,
  targetId: string,
  weaponName: string,
  dice: { value: number; state: 'crit' | 'normal' | 'fail' }[] = [],
  opts: { inCover?: boolean; profileName?: string } = {},
): void {
  state.sequence = {
    kind: 'shoot',
    step: 'done',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(opts.profileName ? { profileName: opts.profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: opts.inCover ?? false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: {
      dice: dice.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: dice.length + 1,
    },
    defence: { dice: [], nextId: 1 },
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[targetId]!.player,
    free: false,
  };
}

function fakeFight(
  state: GameState,
  attackerId: string,
  defenderId: string,
  attackerWeapon: string,
  opts: {
    defenderWeapon?: string;
    defenderDice?: { value: number; state: 'crit' | 'normal' }[];
    turn?: 'attacker' | 'defender';
  } = {},
): void {
  state.sequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId,
    defenderId,
    attackerWeapon,
    ...(opts.defenderWeapon ? { defenderWeapon: opts.defenderWeapon } : {}),
    defenderCanRetaliate: true,
    attackerPool: { dice: [], nextId: 1 },
    defenderPool: {
      dice: (opts.defenderDice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.defenderDice ?? []).length + 1,
    },
    turn: opts.turn ?? 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    attacker: state.operatives[attackerId]!.player,
    defender: state.operatives[defenderId]!.player,
    free: false,
    hatchway: false,
  };
}

/** Park every operative of a player out of the way. */
function banish(state: GameState, player: PlayerId, keep: string[] = []): void {
  state.teams[player].operativeIds.forEach((id, i) => {
    if (keep.includes(id)) return;
    state.operatives[id]!.pos = { x: player === 'p1' ? 1 : 29, y: 1 + i * 0.4 };
  });
}

/**
 * Issue a GUARDSMAN ORDER as the STRATEGIC GAMBIT, with the WATCHMASTER stood next to the
 * operative the test cares about ("all friendly DEATH KORPS operatives within 6" of it").
 */
function issueTo(
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  order: (typeof ORDERS)[number],
  target: OperativeState,
): GameState {
  const wm = state.operatives[opWith(state, 'p1', C.watchmaster)]!;
  wm.pos = { x: target.pos.x, y: target.pos.y - 1.2 };
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  return reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId(order) }, ctx).state;
}

function defenceEvent(
  ctx: ReturnType<typeof teamContext>,
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  weaponName: string,
  profile: WeaponProfile,
  coverSave: boolean,
) {
  return ctx.hooks.emit('onDefenceDice', state, {
    state,
    ctx: { ...attackCtx(attacker, defender, weaponName, profile), inCover: coverSave },
    count: 3,
    coverSave,
    coverSaveAsCrit: false,
    extraCoverSaves: 0,
    mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    rerolls: [],
  });
}

// ---------------------------------------------------------------------------
describe('DEATH KORPS data (pinned against data/teams/death-korps.json)', () => {
  it('has 12 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(12);
    const wm = DATA.datacards.find((c) => c.id === C.watchmaster)!;
    expect(wm).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 8, base: { shape: 'round', mm: 25 } });
    expect(wm.keywords).toEqual(['DEATH KORPS', 'IMPERIUM', 'ASTRA MILITARUM', 'LEADER', 'WATCHMASTER']);
    for (const card of DATA.datacards.filter((c) => !c.keywords.includes('LEADER'))) {
      expect(card).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 7, base: { shape: 'round', mm: 25 } });
      expect(card.keywords.slice(0, 3)).toEqual(['DEATH KORPS', 'IMPERIUM', 'ASTRA MILITARUM']);
    }
  });

  it('pins every weapon profile of the WATCHMASTER, the GUNNER, the SNIPER, the SAPPER and the SPOTTER', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')),
        );
    expect(flat(C.watchmaster)).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Boltgun||ranged|4|3|3|4',
      'Plasma pistol|standard|ranged|4|4|3|5',
      'Plasma pistol|supercharge|ranged|4|4|4|5',
      'Relic laspistol||ranged|4|3|2|4',
      'Bayonet||melee|4|3|2|3',
      'Chainsword||melee|4|3|4|5',
      'Power weapon||melee|4|3|4|6',
    ]);
    expect(flat(C.gunner)).toEqual([
      'Flamer||ranged|4|2|3|3',
      'Grenade launcher|frag|ranged|4|4|2|4',
      'Grenade launcher|krak|ranged|4|4|4|5',
      'Meltagun||ranged|4|4|6|3',
      'Plasma gun|standard|ranged|4|4|4|6',
      'Plasma gun|supercharge|ranged|4|4|5|6',
      'Bayonet||melee|3|4|2|3',
    ]);
    expect(flat(C.sniper)).toEqual([
      'Long-las|concealed|ranged|4|2|3|3',
      'Long-las|mobile|ranged|4|3|3|4',
      'Long-las|stationary|ranged|4|2|3|3',
      'Bayonet||melee|3|4|2|3',
    ]);
    // The two rare weapon rules this team uses.
    expect(profileOf(C.sniper, 'Long-las', 'concealed').rules.map((r) => r.id)).toEqual([
      'Devastating',
      'Heavy',
      'Silent',
      'ConcealedPosition',
    ]);
    expect(profileOf(C.sapper, 'Remote detonator').rules.map((r) => r.id)).toEqual([
      'Heavy',
      'Limited',
      'Piercing',
      'Silent',
      'Detonate',
    ]);
    expect(profileOf(C.spotter, 'Mortar barrage').rules.map((r) => r.id)).toEqual(['Blast', 'Heavy', 'Silent']);
    expect(DATA.rareWeaponRules).toEqual(['ConcealedPosition', 'Detonate']);
  });

  it('exposes 1 faction rule, 4 strategy ploys, 4 firefight ploys, 4 equipment, 15 abilities and 3 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Guardsmen Orders']);
    expect(deathKorps.ploys.filter((p) => p.kind === 'strategy').map((p) => p.id)).toEqual([
      SP.siegeWarfare,
      SP.takeCover,
      SP.clearTheLine,
      SP.regroup,
    ]);
    expect(deathKorps.ploys.filter((p) => p.kind === 'firefight').map((p) => p.id)).toEqual([
      FP.inspirationalLeadership,
      FP.combinedArms,
      FP.inLifeShame,
      FP.inDeathAtonement,
    ]);
    expect(deathKorps.equipment.map((e) => e.id)).toEqual([
      EQ.chronometer,
      EQ.commBeads,
      EQ.handAxes,
      EQ.gasBombardment,
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(15);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual(['MEDIKIT', 'SPOT', 'SIGNAL']);
  });

  it('the printed default roster is legal, and every datacard/ploy/equipment has an AI hint', () => {
    const picks = defaultRoster(deathKorps.data);
    expect(deathKorps.validateRoster(picks).ok).toBe(true);
    // "1 DEATH KORPS WATCHMASTER operative … 4 TROOPER operatives … 9 DEATH KORPS operatives"
    expect(picks).toHaveLength(14);
    expect(picks.filter((p) => p.datacardId === C.watchmaster)).toHaveLength(1);
    for (const card of DATA.datacards) expect(deathKorps.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of deathKorps.ploys) expect(deathKorps.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of deathKorps.equipment) expect(deathKorps.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('Guardsmen Orders — "A friendly DEATH KORPS WATCHMASTER operative can issue a GUARDSMAN ORDER"', () => {
  it('slices the four orders out of the one printed faction rule and offers one gambit each', () => {
    expect(ORDERS).toEqual(['take-aim', 'fix-bayonets', 'dig-in', 'move-move-move']);
    expect(ORDER_TEXT['take-aim']).toContain(
      'Ranged weapons of operatives that received this order (excluding mortar barrage and remote detonator) have the Ceaseless weapon rule',
    );
    expect(ORDER_TEXT['fix-bayonets']).toContain('Melee weapons of operatives that received this order have the Ceaseless weapon rule');
    expect(ORDER_TEXT['dig-in']).toContain('you can re-roll any of your defence dice results of one result');
    expect(ORDER_TEXT['move-move-move']).toContain('add 1" to its Move stat');
    for (const order of ORDERS) expect(rule(ORDERS_RULE)).toContain(ORDER_TEXT[order]);

    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    for (const order of ORDERS) expect(ids).toContain(orderGambitId(order));
  });

  it('"select one GUARDSMAN ORDER for all friendly DEATH KORPS operatives within 6\\" of it to receive"', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const wm = state.operatives[opWith(state, 'p1', C.watchmaster)]!;
    const near = state.operatives[opWith(state, 'p1', C.bruiser)]!;
    const far = state.operatives[opWith(state, 'p1', C.zealot)]!;
    near.pos = { x: wm.pos.x, y: wm.pos.y + 4 };
    far.pos = { x: wm.pos.x, y: wm.pos.y + 12 };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('take-aim') }, ctx).state;
    expect(hasOrder(s, s.operatives[wm.id]!, 'take-aim', 'p1')).toBe(true);
    expect(hasOrder(s, s.operatives[near.id]!, 'take-aim', 'p1')).toBe(true);
    expect(hasOrder(s, s.operatives[far.id]!, 'take-aim', 'p1')).toBe(false);
    // "Operatives cannot benefit from more than one GUARDSMAN ORDER at once."
    expect(ordersOn(s, s.operatives[wm.id]!, 'p1')).toEqual(['take-aim']);
  });

  it('is ONE STRATEGIC GAMBIT with a four-way choice — the other three are withdrawn once used', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('take-aim') }, ctx).state;
    const ids = gambitOptions(ctx, s, 'p1').map((o) => o.id);
    for (const order of ORDERS) expect(ids).not.toContain(orderGambitId(order));
  });

  it('"they only benefit from the most recent order they received during the turning point"', () => {
    expect(rule(ORDERS_RULE)).toContain('they only benefit from the most recent order they received');
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('take-aim') }, ctx).state;
    // A second issue in the same turning point comes through Inspirational Leadership.
    const wm = s.operatives[opWith(s, 'p1', C.watchmaster)]!;
    s = activate(ctx, s, wm.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inspirationalLeadership, data: { order: 'fix-bayonets' } }, ctx).state;
    expect(ordersOn(s, s.operatives[wm.id]!, 'p1')).toEqual(['fix-bayonets']);
  });

  it('Take Aim!: Ceaseless on ranged weapons, "excluding mortar barrage and remote detonator"', () => {
    const { ctx, state } = setup();
    const spotter = state.operatives[opWith(state, 'p1', C.spotter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.spotter, 'Lasgun');
    const mortar = profileOf(C.spotter, 'Mortar barrage');
    const bayonet = profileOf(C.spotter, 'Bayonet');
    const has = (p: WeaponProfile, name: string): boolean =>
      effectiveRules(ctx, state, p, { operative: spotter, target: foe, weaponName: name }).some((r) => r.id === 'Ceaseless');
    expect(has(lasgun, 'Lasgun')).toBe(false);
    const s = issueTo(ctx, state, 'take-aim', spotter);
    const spotter2 = s.operatives[spotter.id]!;
    const foe2 = s.operatives[foe.id]!;
    const has2 = (p: WeaponProfile, name: string): boolean =>
      effectiveRules(ctx, s, p, { operative: spotter2, target: foe2, weaponName: name }).some((r) => r.id === 'Ceaseless');
    expect(has2(lasgun, 'Lasgun')).toBe(true);
    expect(has2(mortar, 'Mortar barrage')).toBe(false);
    expect(has2(bayonet, 'Bayonet')).toBe(false); // ranged weapons only
  });

  it('Fix Bayonets!: Ceaseless on melee weapons only', () => {
    const { ctx, state } = setup();
    const s = issueTo(ctx, state, 'fix-bayonets', state.operatives[opWith(state, 'p1', C.trooper)]!);
    const trooper = s.operatives[opWith(s, 'p1', C.trooper)]!;
    const foe = s.operatives[opWith(s, 'p2', C.trooper)]!;
    const bayonet = profileOf(C.trooper, 'Bayonet');
    const lasgun = profileOf(C.trooper, 'Lasgun');
    expect(
      effectiveRules(ctx, s, bayonet, { operative: trooper, target: foe, weaponName: 'Bayonet' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(true);
    expect(
      effectiveRules(ctx, s, lasgun, { operative: trooper, target: foe, weaponName: 'Lasgun' }).some((r) => r.id === 'Ceaseless'),
    ).toBe(false);
  });

  it('Dig In!: "if you can retain any cover saves, you can re-roll any of your defence dice results of one result"', () => {
    const { ctx, state } = setup();
    const s = issueTo(ctx, state, 'dig-in', state.operatives[opWith(state, 'p1', C.trooper)]!);
    const target = s.operatives[opWith(s, 'p1', C.trooper)]!;
    const shooter = s.operatives[opWith(s, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    fakeShoot(s, shooter.id, target.id, 'Lasgun', [], { inCover: true });
    const ev = defenceEvent(ctx, s, shooter, target, 'Lasgun', lasgun, true);
    const grant = ev.rerolls.find((r) => r.id === 'death-korps.digIn');
    expect(grant?.mode).toBe('value');
    // No cover save to retain → nothing offered.
    fakeShoot(s, shooter.id, target.id, 'Lasgun', [], { inCover: false });
    expect(defenceEvent(ctx, s, shooter, target, 'Lasgun', lasgun, false).rerolls).toHaveLength(0);
  });

  it('Move! Move! Move!: "add 1\\" to its Move stat" on the Reposition action only', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', C.trooper);
    expect(moveBudget(ctx, state, state.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(6);
    const s = issueTo(ctx, state, 'move-move-move', state.operatives[id]!);
    expect(moveBudget(ctx, s, s.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(7);
    expect(moveBudget(ctx, s, s.operatives[id]!, { action: 'Dash' })).toBeCloseTo(3);
  });

  it('COMM-BEADS: "instead of each friendly … within 6\\" … you can select one friendly … operative"', () => {
    expect(rule(EQ.commBeads)).toContain('you can select one friendly DEATH KORPS operative to receive that order');
    const { ctx, state } = setup({ equipment: [EQ.commBeads] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const wm = state.operatives[opWith(state, 'p1', C.watchmaster)]!;
    const near = state.operatives[opWith(state, 'p1', C.bruiser)]!;
    const far = state.operatives[opWith(state, 'p1', C.zealot)]!;
    near.pos = { x: wm.pos.x, y: wm.pos.y + 2 };
    far.pos = { x: wm.pos.x, y: wm.pos.y + 14 };
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('take-aim'), data: { commBeadsOperativeId: far.id } },
      ctx,
    ).state;
    expect(hasOrder(s, s.operatives[far.id]!, 'take-aim', 'p1')).toBe(true);
    expect(hasOrder(s, s.operatives[near.id]!, 'take-aim', 'p1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('WATCHMASTER and CONFIDANT', () => {
  it('Adaptive Orders: "you can use the Inspirational Leadership firefight ploy for 0CP"', () => {
    expect(ability(C.watchmaster, `${C.watchmaster}.adaptive-orders`)).toContain('for 0CP during this operative’s activation');
    const { ctx, state } = setup();
    const wm = opWith(state, 'p1', C.watchmaster);
    let s = activate(ctx, state, wm);
    const before = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inspirationalLeadership }, ctx).state;
    expect(s.teams.p1.cp).toBe(before); // 1CP charged, 1CP refunded
  });

  it('Adaptive Orders does not refund when the WATCHMASTER already issued an order as a STRATEGIC GAMBIT', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('take-aim') }, ctx).state;
    s.phase = 'firefight';
    s = activate(ctx, s, opWith(s, 'p1', C.watchmaster));
    const before = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inspirationalLeadership }, ctx).state;
    expect(s.teams.p1.cp).toBe(before - 1);
  });

  it('Bring it Down!: Punishing "shooting against, fighting against or retaliating against that enemy operative"', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const mark = state.operatives[opWith(state, 'p2', C.bruiser)]!;
    const other = state.operatives[opWith(state, 'p2', C.zealot)]!;
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: `${C.watchmaster}.bring-it-down`, data: { operativeId: mark.id } },
      ctx,
    ).state;
    const shooter = s.operatives[opWith(s, 'p1', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    const bayonet = profileOf(C.trooper, 'Bayonet');
    const punishing = (target: OperativeState, p: WeaponProfile, name: string, retaliating = false): boolean =>
      effectiveRules(ctx, s, p, { operative: shooter, target, weaponName: name, retaliating }).some((r) => r.id === 'Punishing');
    expect(punishing(s.operatives[mark.id]!, lasgun, 'Lasgun')).toBe(true);
    expect(punishing(s.operatives[mark.id]!, bayonet, 'Bayonet')).toBe(true);
    expect(punishing(s.operatives[mark.id]!, bayonet, 'Bayonet', true)).toBe(true);
    expect(punishing(s.operatives[other.id]!, lasgun, 'Lasgun')).toBe(false);
  });

  it('Bring it Down! is offered only "if this operative is in the killzone"', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(`${C.watchmaster}.bring-it-down`);
    state.operatives[opWith(state, 'p1', C.watchmaster)]!.removed = true;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(`${C.watchmaster}.bring-it-down`);
  });

  it('Second in Command is a pure setter, and only after the WATCHMASTER is removed', () => {
    expect(ability(C.confidant, `${C.confidant}.second-in-command`)).toContain(
      'this operative can issue a GUARDSMAN ORDER as a STRATEGIC GAMBIT',
    );
    const { ctx, state } = setup();
    expect(secondInCommandUsed(state, 'p1')).toBe(false);
    expect(useSecondInCommand(state, 'p1')).toBe(false); // the WATCHMASTER is still in the killzone
    state.operatives[opWith(state, 'p1', C.watchmaster)]!.removed = true;
    expect(useSecondInCommand(state, 'p1')).toBe(true);
    expect(useSecondInCommand(state, 'p1')).toBe(false); // once per battle
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    // The CONFIDANT can now issue as a STRATEGIC GAMBIT even with no WATCHMASTER alive.
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(orderGambitId('dig-in'));
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('dig-in') }, ctx).state;
    expect(hasOrder(s, s.operatives[opWith(s, 'p1', C.confidant)]!, 'dig-in', 'p1')).toBe(true);
  });

  it('Directive records the pairing (PARTIAL: the engine alternates activations strictly)', () => {
    const { ctx, state } = setup();
    const confidant = state.operatives[opWith(state, 'p1', C.confidant)]!;
    const pick = state.operatives[opWith(state, 'p1', C.trooper)]!;
    banish(state, 'p1', [confidant.id, pick.id]);
    confidant.pos = { x: 10, y: 2 };
    pick.pos = { x: 10, y: 5 };
    const s = activate(ctx, state, confidant.id);
    expect(s.effects.some((e) => e.rule === 'death-korps.directive' && e.operativeId === pick.id)).toBe(true);
  });

  it('Directive is switched off once Second in Command has been used', () => {
    const { ctx, state } = setup();
    state.operatives[opWith(state, 'p1', C.watchmaster)]!.removed = true;
    useSecondInCommand(state, 'p1');
    const confidant = state.operatives[opWith(state, 'p1', C.confidant)]!;
    const pick = state.operatives[opWith(state, 'p1', C.trooper)]!;
    banish(state, 'p1', [confidant.id, pick.id]);
    confidant.pos = { x: 10, y: 2 };
    pick.pos = { x: 10, y: 5 };
    const s = activate(ctx, state, confidant.id);
    expect(s.effects.some((e) => e.rule === 'death-korps.directive')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('BRUISER, VETERAN and ZEALOT', () => {
  it('Bruiser: "you can ignore the damage inflicted on it from one normal success", once per turning point', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.bruiser)]!;
    const foe = state.operatives[opWith(state, 'p2', C.bruiser)]!;
    fakeFight(state, foe.id, mine.id, 'Trench club', { defenderWeapon: 'Trench club' });
    const club = profileOf(C.bruiser, 'Trench club');
    expect(club.dmgN).toBe(3);
    const before = mine.wounds;
    inflictDamage(ctx, state, mine, club.dmgN, 'attack');
    expect(mine.wounds).toBe(before); // ignored
    inflictDamage(ctx, state, mine, club.dmgN, 'attack');
    expect(mine.wounds).toBe(before - 3); // once per turning point
  });

  it('Bruiser: "you can strike the enemy operative in that sequence with one of your unresolved successes"', () => {
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', C.bruiser)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    fakeFight(state, foe.id, mine.id, 'Bayonet', {
      defenderWeapon: 'Trench club',
      defenderDice: [{ value: 6, state: 'crit' }],
    });
    const foeWounds = foe.wounds;
    inflictDamage(ctx, state, mine, 99, 'attack'); // not a normal success, so Bruiser's first half stays unused
    expect(mine.incapacitated).toBe(true);
    expect(foe.wounds).toBe(foeWounds - profileOf(C.bruiser, 'Trench club').dmgC);
  });

  it('Bionics: "Normal Dmg of 3 or more inflicts 1 less damage on this operative"', () => {
    const { ctx, state } = setup();
    const veteran = state.operatives[opWith(state, 'p1', C.veteran)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const bayonet = profileOf(C.trooper, 'Bayonet'); // Normal Dmg 2
    const club = profileOf(C.bruiser, 'Trench club'); // Normal Dmg 3
    fakeShoot(state, foe.id, veteran.id, 'Bayonet');
    let before = veteran.wounds;
    inflictDamage(ctx, state, veteran, bayonet.dmgN, 'attack');
    expect(before - veteran.wounds).toBe(2); // Normal Dmg 2 — unchanged

    const bruiser = state.operatives[opWith(state, 'p2', C.bruiser)]!;
    fakeShoot(state, bruiser.id, veteran.id, 'Trench club');
    before = veteran.wounds;
    inflictDamage(ctx, state, veteran, club.dmgN, 'attack');
    expect(before - veteran.wounds).toBe(2); // Normal Dmg 3 → 1 less
  });

  it('Veteran Guardsman: "Whenever this operative is activated, it can receive one GUARDSMAN ORDER"', () => {
    const { ctx, state } = setup();
    const veteran = opWith(state, 'p1', C.veteran);
    let s = activate(ctx, state, veteran);
    const decision = s.pending.find((d) => d.kind === 'death-korps.veteranOrder');
    expect(decision?.options.map((o) => o.id)).toEqual([...ORDERS, 'none']);
    s = settle(ctx, s, () => 'dig-in');
    expect(hasOrder(s, s.operatives[veteran]!, 'dig-in', 'p1')).toBe(true);
  });

  it('Veteran Guardsman can decline the order', () => {
    const { ctx, state } = setup();
    const veteran = opWith(state, 'p1', C.veteran);
    const s = settle(ctx, activate(ctx, state, veteran), () => 'none');
    expect(ordersOn(s, s.operatives[veteran]!, 'p1')).toEqual([]);
  });

  it('The Emperor Protects: "you can re-roll any of your defence dice"', () => {
    const { ctx, state } = setup();
    const zealot = state.operatives[opWith(state, 'p1', C.zealot)]!;
    const trooper = state.operatives[opWith(state, 'p1', C.trooper)]!;
    const shooter = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    fakeShoot(state, shooter.id, zealot.id, 'Lasgun');
    expect(
      defenceEvent(ctx, state, shooter, zealot, 'Lasgun', lasgun, false).rerolls.map((r) => r.id),
    ).toContain('death-korps.emperorProtects');
    fakeShoot(state, shooter.id, trooper.id, 'Lasgun');
    expect(
      defenceEvent(ctx, state, shooter, trooper, 'Lasgun', lasgun, false).rerolls.map((r) => r.id),
    ).not.toContain('death-korps.emperorProtects');
  });

  it('Uplifting Primer: Severe "whenever a friendly DEATH KORPS operative is within 3\\" of this operative"', () => {
    const { ctx, state } = setup();
    const zealot = state.operatives[opWith(state, 'p1', C.zealot)]!;
    const trooper = state.operatives[opWith(state, 'p1', C.trooper)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    const severe = (): boolean =>
      effectiveRules(ctx, state, lasgun, { operative: trooper, target: foe, weaponName: 'Lasgun' }).some(
        (r) => r.id === 'Severe',
      );
    trooper.pos = { x: zealot.pos.x, y: zealot.pos.y + 2 };
    expect(severe()).toBe(true);
    trooper.pos = { x: zealot.pos.x, y: zealot.pos.y + 9 };
    expect(severe()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('MEDIC, VOX-OPERATOR and SPOTTER', () => {
  it('Medic!: the victim "isn’t incapacitated, has 1 wound remaining", and both lose 1 APL', () => {
    const { ctx, state } = setup();
    const medic = state.operatives[opWith(state, 'p1', C.medic)]!;
    const victim = state.operatives[opWith(state, 'p1', C.trooper)]!;
    banish(state, 'p2');
    victim.pos = { x: medic.pos.x, y: medic.pos.y + 2 };
    victim.wounds = 2;
    const r = inflictDamage(ctx, state, victim, 7, 'attack');
    expect(r.incapacitated).toBe(false);
    expect(victim.wounds).toBe(1);
    expect(aplOf(ctx, state, medic)).toBe(1);
    expect(state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === victim.id)).toBe(true);
  });

  it('Medic! "cannot be used … if this operative is within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    const medic = state.operatives[opWith(state, 'p1', C.medic)]!;
    const victim = state.operatives[opWith(state, 'p1', C.trooper)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    victim.pos = { x: medic.pos.x, y: medic.pos.y + 2 };
    foe.pos = { x: medic.pos.x + 0.5, y: medic.pos.y };
    victim.wounds = 2;
    expect(inflictDamage(ctx, state, victim, 7, 'attack').incapacitated).toBe(true);
  });

  it('MEDIKIT: "regain up to 2D3 lost wounds", and never on the Medic! target of this turning point', () => {
    const { ctx, state } = setup({ script: [5, 3] }); // D3 = D6 halved, rounding up → 3 + 2
    const medic = state.operatives[opWith(state, 'p1', C.medic)]!;
    const victim = state.operatives[opWith(state, 'p1', C.trooper)]!;
    banish(state, 'p2');
    victim.pos = { x: medic.pos.x + 0.6, y: medic.pos.y };
    victim.wounds = 1;
    let s = activate(ctx, state, medic.id);
    const r = act(ctx, s, medic.id, ACT.medikit, { targetOperativeId: victim.id });
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.operatives[victim.id]!.wounds).toBe(6); // 1 + (3 + 2)
    // "It cannot be an operative that the Medic! rule was used on during this turning point."
    expect(actionOf(C.medic, ACT.medikit)).toContain('cannot be an operative that the Medic! rule was used on');
  });

  it('MEDIKIT refuses an enemy target in `check`, not in `perform` (D-026)', () => {
    const { ctx, state } = setup();
    const medic = state.operatives[opWith(state, 'p1', C.medic)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    foe.pos = { x: medic.pos.x + 6, y: medic.pos.y };
    const s = activate(ctx, state, medic.id);
    const r = act(ctx, s, medic.id, ACT.medikit, { targetOperativeId: foe.id });
    expect(r.ok).toBe(false);
    expect(r.state.log.some((l) => l.data?.['contractViolation'])).toBe(false);
  });

  it('SIGNAL: "add 1 to its APL stat" for one other friendly operative within 6"', () => {
    const { ctx, state } = setup();
    const vox = state.operatives[opWith(state, 'p1', C.voxOperator)]!;
    const target = state.operatives[opWith(state, 'p1', C.trooper)]!;
    banish(state, 'p2');
    target.pos = { x: vox.pos.x, y: vox.pos.y + 3 };
    let s = activate(ctx, state, vox.id);
    s = act(ctx, s, vox.id, ACT.signal, { targetOperativeId: target.id }).state;
    expect(aplOf(ctx, s, s.operatives[target.id]!)).toBe(3);
    // "one OTHER friendly DEATH KORPS operative"
    expect(act(ctx, s, vox.id, ACT.signal, { targetOperativeId: vox.id }).ok).toBe(false);
  });

  it('Relay Orders: "all friendly DEATH KORPS operatives in the killzone receive that order", -1 APL', () => {
    expect(ability(C.voxOperator, `${C.voxOperator}.relay-orders`)).toContain(
      'all friendly DEATH KORPS operatives in the killzone receive that order',
    );
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const wm = state.operatives[opWith(state, 'p1', C.watchmaster)]!;
    const vox = state.operatives[opWith(state, 'p1', C.voxOperator)]!;
    const far = state.operatives[opWith(state, 'p1', C.zealot)]!;
    vox.pos = { x: wm.pos.x, y: wm.pos.y + 2 };
    far.pos = { x: wm.pos.x, y: wm.pos.y + 18 };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: orderGambitId('take-aim') }, ctx).state;
    expect(hasOrder(s, s.operatives[far.id]!, 'take-aim', 'p1')).toBe(true);
    expect(aplOf(ctx, s, s.operatives[vox.id]!)).toBe(1);
  });

  it('SPOT selects "one enemy operative visible to this operative" and refuses a friendly one', () => {
    const { ctx, state } = setup();
    const spotter = state.operatives[opWith(state, 'p1', C.spotter)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const friend = state.operatives[opWith(state, 'p1', C.trooper)]!;
    let s = activate(ctx, state, spotter.id);
    expect(act(ctx, s, spotter.id, ACT.spot, { targetOperativeId: friend.id }).ok).toBe(false);
    const r = act(ctx, s, spotter.id, ACT.spot, { targetOperativeId: foe.id });
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.effects.some((e) => e.rule === 'death-korps.spot' && e.operativeId === foe.id)).toBe(true);
    // The printed effect list is missing from the source data — see the data problems report.
    expect(actionOf(C.spotter, ACT.spot).trim()).toContain('you can use this effect. If you do:');
  });
});

// ---------------------------------------------------------------------------
describe('SAPPER — Mine Layer, Detonate; SNIPER — Concealed Position; TROOPER — Group Activation', () => {
  it('Mine Layer: "This operative is carrying your Mine marker", with its own Pick Up / Place actions', () => {
    const { ctx, state } = setup();
    const sapper = opWith(state, 'p1', C.sapper);
    const s = activate(ctx, state, sapper);
    const marker = s.markers[MINE_MARKER('p1')];
    expect(marker?.carriedBy).toBe(sapper);
    expect(s.operatives[sapper]!.carryingMarkerId).toBe(MINE_MARKER('p1'));
    const ids = availableActions(ctx, s, s.operatives[sapper]!).filter((a) => a.ok).map((a) => a.def.id);
    expect(ids).toContain(PLACE_MINE);
    // The universal Place Marker action is refused while the Mine marker is carried.
    expect(act(ctx, s, sapper, 'Place Marker', { markerPos: { ...s.operatives[sapper]!.pos } }).ok).toBe(false);
  });

  it('Mine Layer: "whenever it performs the Place Marker action on that marker, it can immediately perform a free Dash action"', () => {
    const { ctx, state } = setup();
    const sapper = opWith(state, 'p1', C.sapper);
    let s = activate(ctx, state, sapper);
    const r = act(ctx, s, sapper, PLACE_MINE, { markerPos: { ...s.operatives[sapper]!.pos } });
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.markers[MINE_MARKER('p1')]!.carriedBy).toBeUndefined();
    expect(s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === sapper)).toBe(true);
    // And it can be picked back up.
    expect(availableActions(ctx, s, s.operatives[sapper]!).some((a) => a.def.id === PICK_UP_MINE)).toBe(true);
  });

  it('Detonate: the weapon is never offered to the universal Shoot action ("Don’t select a valid target")', () => {
    const { ctx, state } = setup();
    const sapper = state.operatives[opWith(state, 'p1', C.sapper)]!;
    expect(DATA.datacards.find((c) => c.id === C.sapper)!.weapons.map((w) => w.name)).toContain('Remote detonator');
    expect(weaponsOf(ctx, state, sapper, 'ranged').map((w) => w.name)).not.toContain('Remote detonator');
  });

  it('Detonate: "shoot against each operative within 2\\" of your Mine marker" and remove the marker', () => {
    const { ctx, state } = setup({ seed: 3 });
    const sapper = state.operatives[opWith(state, 'p1', C.sapper)]!;
    const a = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const b = state.operatives[opWith(state, 'p2', C.bruiser)]!;
    const c = state.operatives[opWith(state, 'p2', C.zealot)]!;
    banish(state, 'p2', [a.id, b.id, c.id]);
    let s = activate(ctx, state, sapper.id);
    // Drop the marker in the middle of the board, two enemies beside it and one far away.
    const marker = s.markers[MINE_MARKER('p1')]!;
    marker.carriedBy = undefined;
    marker.pos = { x: 15, y: 11 };
    s.operatives[sapper.id]!.carryingMarkerId = undefined;
    s.operatives[a.id]!.pos = { x: 15, y: 12 };
    s.operatives[b.id]!.pos = { x: 16, y: 11 };
    s.operatives[c.id]!.pos = { x: 15, y: 20 };
    const woundsBefore = { a: s.operatives[a.id]!.wounds, c: s.operatives[c.id]!.wounds };
    const r = act(ctx, s, sapper.id, DETONATE_SHOOT, { weaponName: 'Remote detonator' });
    expect(r.ok).toBe(true);
    s = settle(ctx, r.state);
    expect(s.markers[MINE_MARKER('p1')]).toBeUndefined();
    expect(s.operatives[a.id]!.wounds).toBeLessThan(woundsBefore.a);
    expect(s.operatives[c.id]!.wounds).toBe(woundsBefore.c); // more than 2" away
  });

  it('Detonate: "cannot be selected if your Mine marker isn’t in the killzone"', () => {
    const { ctx, state } = setup();
    const sapper = opWith(state, 'p1', C.sapper);
    let s = activate(ctx, state, sapper);
    delete s.markers[MINE_MARKER('p1')];
    s.operatives[sapper]!.carryingMarkerId = undefined;
    const r = act(ctx, s, sapper, DETONATE_SHOOT, { weaponName: 'Remote detonator' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Mine marker');
  });

  it('Detonate: "in a killzone that uses the close quarters rules … this weapon has the Lethal 5+ weapon rule"', () => {
    const { ctx, state } = setup();
    const sapper = state.operatives[opWith(state, 'p1', C.sapper)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const det = profileOf(C.sapper, 'Remote detonator');
    const lethal = (): boolean =>
      effectiveRules(ctx, state, det, { operative: sapper, target: foe, weaponName: 'Remote detonator' }).some(
        (r) => r.id === 'Lethal' && r.x === 5,
      );
    expect(lethal()).toBe(false);
    state.map = { ...state.map, closeQuarters: true };
    expect(lethal()).toBe(true);
  });

  it('Concealed Position: "only … the first time it’s performing the Shoot action during the battle"', () => {
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', C.sniper)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    foe.pos = { x: 20, y: sniper.pos.y };
    const profiles = (): string[] =>
      weaponsOf(ctx, state, sniper, 'ranged')
        .filter((w) => w.name === 'Long-las')
        .flatMap((w) => w.profiles.map((p) => p.name ?? ''));
    expect(profiles()).toEqual(['concealed', 'mobile', 'stationary']);
    // One shot, then the concealed profile is gone but the rest of the weapon remains.
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(sniper, foe, 'Long-las', profileOf(C.sniper, 'Long-las', 'concealed')),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(profiles()).toEqual(['mobile', 'stationary']);
    const pick = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: attackCtx(sniper, foe, 'Long-las', profileOf(C.sniper, 'Long-las', 'concealed')),
      allowed: true,
      dryRun: false,
    });
    expect(pick.allowed).toBe(false);
  });

  it('Group Activation records the pairing (PARTIAL: the engine alternates activations strictly)', () => {
    const { ctx, state } = setup();
    const picks = [...EVERY_CARD, C.trooper].map((id) => ({ datacardId: id }));
    const s2 = battle({
      ctx,
      p1: { module: deathKorps, picks, positions: picks.map((_, i) => ({ x: 3, y: 1 + i * 1.6 })) },
      p2: { module: deathKorps, picks: EVERY_CARD.map((id) => ({ datacardId: id })), positions: column(27) },
    });
    const troopers = s2.teams.p1.operativeIds.filter((id) => s2.operatives[id]!.datacardId === C.trooper);
    expect(troopers.length).toBeGreaterThan(1);
    let s = activate(ctx, s2, troopers[0]!);
    s = reduce(s, { t: 'EndActivation', operativeId: troopers[0]! }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'death-korps.groupActivation' && e.operativeId === troopers[1]!)).toBe(true);
    void state;
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('SIEGE WARFARE: "ranged weapons have the Saturate and Accurate 1 weapon rules"', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.siegeWarfare }, ctx).state;
    const trooper = s.operatives[opWith(s, 'p1', C.trooper)]!;
    const foe = s.operatives[opWith(s, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    const rules = effectiveRules(ctx, s, lasgun, { operative: trooper, target: foe, weaponName: 'Lasgun' });
    expect(rules.some((r) => r.id === 'Saturate')).toBe(true);
    expect(rules.some((r) => r.id === 'Accurate' && r.x === 1)).toBe(true);
    // Melee is untouched.
    const bayonet = profileOf(C.trooper, 'Bayonet');
    expect(
      effectiveRules(ctx, s, bayonet, { operative: trooper, target: foe, weaponName: 'Bayonet' }).some(
        (r) => r.id === 'Saturate',
      ),
    ).toBe(false);
  });

  it('TAKE COVER: "if you can retain any cover saves, improve that friendly operative’s Save stat by 1"', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.takeCover }, ctx).state;
    const target = s.operatives[opWith(s, 'p1', C.trooper)]!;
    const shooter = s.operatives[opWith(s, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    expect(saveOf(ctx, s, target)).toBe(5);
    fakeShoot(s, shooter.id, target.id, 'Lasgun', [], { inCover: true });
    expect(defenceEvent(ctx, s, shooter, target, 'Lasgun', lasgun, true).mods.save).toBe(1);
    // No cover save to retain → no improvement.
    expect(defenceEvent(ctx, s, shooter, target, 'Lasgun', lasgun, false).mods.save).toBe(0);
  });

  it('CLEAR THE LINE: Accurate 1 always, Severe "wholly within your territory, or whenever it’s retaliating"', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SP.clearTheLine }, ctx).state;
    const trooper = s.operatives[opWith(s, 'p1', C.trooper)]!;
    const foe = s.operatives[opWith(s, 'p2', C.trooper)]!;
    const bayonet = profileOf(C.trooper, 'Bayonet');
    const rulesFor = (retaliating: boolean) =>
      effectiveRules(ctx, s, bayonet, { operative: trooper, target: foe, weaponName: 'Bayonet', retaliating });
    // p1's territory is x in [0, 15) on the test map.
    trooper.pos = { x: 5, y: 11 };
    expect(rulesFor(false).some((r) => r.id === 'Accurate' && r.x === 1)).toBe(true);
    expect(rulesFor(false).some((r) => r.id === 'Severe')).toBe(true);
    trooper.pos = { x: 22, y: 11 };
    expect(rulesFor(false).some((r) => r.id === 'Accurate' && r.x === 1)).toBe(true);
    expect(rulesFor(false).some((r) => r.id === 'Severe')).toBe(false);
    expect(rulesFor(true).some((r) => r.id === 'Severe')).toBe(true); // retaliating, anywhere
  });

  it('REGROUP: a free Dash for each friendly within 5" of the selected operative and not engaged', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const leader = state.operatives[opWith(state, 'p1', C.watchmaster)]!;
    const near = state.operatives[opWith(state, 'p1', C.bruiser)]!;
    const far = state.operatives[opWith(state, 'p1', C.zealot)]!;
    banish(state, 'p2');
    leader.pos = { x: 5, y: 11 };
    near.pos = { x: 8, y: 11 };
    far.pos = { x: 14, y: 11 };
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: SP.regroup, data: { operativeId: leader.id } },
      ctx,
    ).state;
    const granted = (id: string): boolean =>
      s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === id && e.source.id === SP.regroup);
    expect(granted(near.id)).toBe(true);
    expect(granted(far.id)).toBe(false);
    expect(granted(leader.id)).toBe(false); // "Each OTHER friendly … operative"
  });

  it('REGROUP and the CHRONOMETER STRATEGIC GAMBIT cannot be used in the same turning point', () => {
    expect(rule(SP.regroup)).toContain('You cannot use this ploy and the Chronometer faction equipment STRATEGIC GAMBIT during the same turning point');
    const { ctx, state } = setup({ equipment: [EQ.chronometer] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.chronometer }, ctx).state;
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(SP.regroup);
    expect(reduce(s, { t: 'UsePloy', player: 'p1', ployId: SP.regroup }, ctx).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('INSPIRATIONAL LEADERSHIP: only during a WATCHMASTER or CONFIDANT activation, and it issues an order', () => {
    const { ctx, state } = setup();
    const trooper = opWith(state, 'p1', C.trooper);
    let s = activate(ctx, state, trooper);
    expect(reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inspirationalLeadership }, ctx).ok).toBe(false);
    s = reduce(s, { t: 'EndActivation', operativeId: trooper }, ctx).state;
    const confidant = opWith(s, 'p1', C.confidant);
    s = activate(ctx, s, confidant);
    const r = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inspirationalLeadership, data: { order: 'dig-in' } }, ctx);
    expect(r.ok).toBe(true);
    expect(hasOrder(r.state, r.state.operatives[confidant]!, 'dig-in', 'p1')).toBe(true);
  });

  it('COMBINED ARMS: only "if it’s shooting an enemy operative that’s been shot by another friendly … operative"', () => {
    const { ctx, state } = setup();
    const first = state.operatives[opWith(state, 'p1', C.trooper)]!;
    const second = state.operatives[opWith(state, 'p1', C.bruiser)]!;
    const foe = state.operatives[opWith(state, 'p2', C.trooper)]!;
    const lasgun = profileOf(C.trooper, 'Lasgun');
    fakeShoot(state, second.id, foe.id, 'Lasgun');
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.combinedArms }, ctx).ok).toBe(false);
    // The first trooper shoots it, then the bruiser does.
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(first, foe, 'Lasgun', lasgun),
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.combinedArms }, ctx);
    expect(r.ok).toBe(true);
    const ev = ctx.hooks.emit('onRollAttack', r.state, {
      state: r.state,
      ctx: attackCtx(r.state.operatives[second.id]!, r.state.operatives[foe.id]!, 'Lasgun', lasgun),
      dice: [],
      rerolls: [],
    });
    expect(ev.rerolls.map((g) => g.id)).toContain('death-korps.combinedArms');
    // One use: `ploysUsedTP` stays true all turning point, so the grant is armed once.
    const again = ctx.hooks.emit('onRollAttack', r.state, {
      state: r.state,
      ctx: attackCtx(r.state.operatives[second.id]!, r.state.operatives[foe.id]!, 'Lasgun', lasgun),
      dice: [],
      rerolls: [],
    });
    expect(again.rerolls.map((g) => g.id)).not.toContain('death-korps.combinedArms');
  });

  it('IN LIFE, SHAME: "It receives every GUARDSMAN ORDER", overriding the one-order limit', () => {
    const { ctx, state } = setup();
    const trooper = opWith(state, 'p1', C.trooper);
    let s = activate(ctx, state, trooper, 'conceal');
    expect(reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inLifeShame }, ctx).ok).toBe(false);
    s = reduce(s, { t: 'EndActivation', operativeId: trooper }, ctx).state;
    const other = opWith(s, 'p1', C.bruiser);
    s = activate(ctx, s, other, 'engage');
    const r = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.inLifeShame }, ctx);
    expect(r.ok).toBe(true);
    expect(ordersOn(r.state, r.state.operatives[other]!, 'p1').sort()).toEqual([...ORDERS].sort());
  });

  it('IN DEATH, ATONEMENT is gated to its printed window (the free action itself is reminder-only)', () => {
    const { ctx, state } = setup();
    expect(reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.inDeathAtonement }, ctx).ok).toBe(false);
    const victim = state.operatives[opWith(state, 'p1', C.trooper)]!;
    victim.incapacitated = true;
    const r = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.inDeathAtonement }, ctx);
    expect(r.ok).toBe(true);
    expect(r.state.log.some((l) => l.text.includes('one free action before it is removed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('CHRONOMETER: "Once per battle STRATEGIC GAMBIT in the first or second turning point"', () => {
    const { ctx, state } = setup({ equipment: [EQ.chronometer] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    banish(state, 'p2');
    const mover = state.operatives[opWith(state, 'p1', C.trooper)]!;
    mover.pos = { x: 5, y: 11 };
    const outside = state.operatives[opWith(state, 'p1', C.zealot)]!;
    outside.pos = { x: 20, y: 11 };
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(EQ.chronometer);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: EQ.chronometer }, ctx).state;
    const granted = (id: string): boolean =>
      s.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === id && e.source.id === EQ.chronometer);
    expect(granted(mover.id)).toBe(true);
    expect(granted(outside.id)).toBe(false); // not "wholly within your territory"
    // Once per battle.
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(EQ.chronometer);
    // ...and not after the second turning point.
    const later = { ...state, turningPoint: 3 } as GameState;
    expect(gambitOptions(ctx, later, 'p1').map((o) => o.id)).not.toContain(EQ.chronometer);
  });

  it('HAND AXES: "Friendly DEATH KORPS operatives have the following melee weapon: Hand axe 3 / 4+ / 3/4"', () => {
    const { ctx, state } = setup({ equipment: [EQ.handAxes] });
    const trooper = opWith(state, 'p1', C.trooper);
    const s = activate(ctx, state, trooper);
    const axe = weaponsOf(ctx, s, s.operatives[trooper]!, 'melee').find((w) => w.name === 'Hand axe');
    expect(axe?.profiles[0]).toMatchObject({ type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4 });
    // The opponent has not taken it.
    expect(weaponsOf(ctx, s, s.operatives[opWith(s, 'p2', C.trooper)]!, 'melee').map((w) => w.name)).not.toContain('Hand axe');
  });

  it('GAS BOMBARDMENT: "-1 APL within 3\\" of that marker", removed in the next Ready step', () => {
    const { ctx, state } = setup({ equipment: [EQ.gasBombardment] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const victim = state.operatives[opWith(state, 'p2', C.trooper)]!;
    victim.pos = { x: 20, y: 11 };
    let s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: EQ.gasBombardment, data: { pos: { x: 20, y: 11 } } },
      ctx,
    ).state;
    expect(s.markers[GAS_MARKER('p1')]).toBeDefined();
    expect(aplOf(ctx, s, s.operatives[victim.id]!)).toBe(1);
    s.operatives[victim.id]!.pos = { x: 20, y: 20 };
    expect(aplOf(ctx, s, s.operatives[victim.id]!)).toBe(2); // "only changed while it's within 3" of that marker"
    // "In the Ready step of the next Strategy phase, remove that marker."
    s.turningPoint = 2;
    ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 1 });
    expect(s.markers[GAS_MARKER('p1')]).toBeUndefined();
    // Once per battle.
    s.phase = 'strategy';
    s.strategyStep = 'gambit';
    s.teams.p1.gambitsUsedTP = [];
    expect(gambitOptions(ctx, s, 'p1').map((o) => o.id)).not.toContain(EQ.gasBombardment);
  });

  it('the four GUARDSMAN ORDER labels come from the printed headings', () => {
    for (const order of ORDERS) expect(rule(ORDERS_RULE)).toContain(ORDER_LABEL[order]);
  });
});
