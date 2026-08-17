/**
 * LEGIONARY (Chaos Space Marines). Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/legionary/
 */
import { describe, expect, it } from 'vitest';
import { availableActions } from '../../src/core/actions.ts';
import { resolveDecision } from '../../src/core/decisions.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { hitOf, inflictDamage, saveOf } from '../../src/core/state.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import type { GameState, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import {
  ASTARTES_FIGHT,
  ASTARTES_SHOOT,
  GRISLY_MARKER,
  MARKS,
  MARK_RULE,
  legionary,
  markOf,
  setMarkOfChaos,
  talismanGambitId,
} from '../../src/teams/legionary/index.ts';
import { activate, battle, opWith, rosterIncluding, settle, teamContext } from './harness.ts';

const DATA = teamData('legionary');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const EVERY_ROLE = [
  'legionary.aspiring-champion',
  'legionary.chosen',
  'legionary.anointed',
  'legionary.balefire-acolyte',
  'legionary.butcher',
  'legionary.gunner',
  'legionary.heavy-gunner',
  'legionary.icon-bearer',
  'legionary.shrivetalon',
  'legionary.warrior',
];

function setup(
  opts: { equipment?: string[]; script?: number[]; seed?: number } = {},
): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([legionary], opts.script ? { script: opts.script } : { seed: opts.seed ?? 9 });
  const picks = rosterIncluding(legionary, EVERY_ROLE);
  const state = battle({
    ctx,
    p1: { module: legionary, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: legionary, picks },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
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
  dice: { value: number; state: 'crit' | 'normal' | 'fail' }[],
  profileName?: string,
): void {
  state.sequence = {
    kind: 'shoot',
    step: 'done',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(profileName ? { profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: false,
    obscured: false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: false,
    attack: { dice: dice.map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })), nextId: dice.length + 1 },
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
  opts: { defenderWeapon?: string; defenderDice?: { value: number; state: 'crit' | 'normal' }[] } = {},
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
    turn: 'attacker',
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
    state.operatives[id]!.pos = { x: player === 'p1' ? 1 : 29, y: 1 + i * 0.6 };
  });
}

// ---------------------------------------------------------------------------
describe('LEGIONARY data (pinned against data/teams/legionary.json)', () => {
  it('has 10 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(10);
    const champion = DATA.datacards.find((c) => c.id === 'legionary.aspiring-champion')!;
    expect(champion).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 15, base: { shape: 'round', mm: 32 } });
    expect(champion.keywords).toEqual(['LEGIONARY', 'CHAOS', 'HERETIC ASTARTES', 'LEADER', 'ASPIRING CHAMPION']);
    expect(DATA.datacards.find((c) => c.id === 'legionary.chosen')!.wounds).toBe(15);
    for (const card of DATA.datacards.filter((c) => !c.keywords.includes('LEADER'))) {
      expect(card).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 14, base: { shape: 'round', mm: 32 } });
    }
    expect(DATA.datacards.find((c) => c.id === 'legionary.balefire-acolyte')!.keywords).toContain('PSYKER');
  });

  it('pins every weapon profile of the ASPIRING CHAMPION and the HEAVY GUNNER', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) => w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')));
    expect(flat('legionary.aspiring-champion')).toEqual([
      'Plasma pistol|standard|ranged|4|3|3|5',
      'Plasma pistol|supercharge|ranged|4|3|4|5',
      'Tainted bolt pistol||ranged|4|3|3|5',
      'Power fist||melee|5|4|5|7',
      'Power maul||melee|5|3|4|6',
      'Power weapon||melee|5|3|4|6',
      'Tainted chainsword||melee|5|3|4|5',
    ]);
    expect(flat('legionary.heavy-gunner')).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Heavy bolter|focused|ranged|5|3|4|5',
      'Heavy bolter|sweeping|ranged|4|3|4|5',
      'Missile launcher|frag|ranged|4|3|3|5',
      'Missile launcher|krak|ranged|4|3|5|7',
      'Reaper chaincannon|focused|ranged|5|3|3|4',
      'Reaper chaincannon|sweeping|ranged|4|3|3|4',
      'Fists||melee|4|3|3|4',
    ]);
    // The two rare weapon rules this team uses sit on the BALEFIRE ACOLYTE's weapons.
    expect(profileOf('legionary.balefire-acolyte', 'Life siphon').rules.map((r) => r.id)).toEqual([
      'PSYCHIC',
      'Saturate',
      'SiphonLife',
    ]);
    expect(profileOf('legionary.balefire-acolyte', 'Fell dagger').rules.map((r) => r.id)).toContain('SiphonLife');
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 11 abilities and 1 unique action', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Marks of Chaos', 'Astartes']);
    expect(legionary.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(legionary.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(legionary.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(11);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual(['GRISLY MARK']);
    expect(DATA.rareWeaponRules).toEqual(['PSYCHIC', 'SiphonLife']);
  });

  it('the printed default roster is legal, and every datacard has an AI role', () => {
    const picks = defaultRoster(legionary.data);
    expect(legionary.validateRoster(picks).ok).toBe(true);
    expect(picks).toHaveLength(6); // "1 LEGIONARY operative … 5 LEGIONARY operatives"
    for (const card of DATA.datacards) expect(legionary.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of legionary.ploys) expect(legionary.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of legionary.equipment) expect(legionary.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('Marks of Chaos — "you must select one of the following keywords for it to have for that battle"', () => {
  it('nothing applies until a keyword is selected, and a BALEFIRE ACOLYTE "cannot have the KHORNE keyword"', () => {
    expect(rule('legionary.rule.marks-of-chaos')).toContain('a BALEFIRE ACOLYTE operative cannot have the KHORNE keyword');
    const { state } = setup();
    const acolyte = opWith(state, 'p1', 'legionary.balefire-acolyte');
    const butcher = opWith(state, 'p1', 'legionary.butcher');
    expect(markOf(state, state.operatives[butcher]!)).toBeUndefined();
    expect(setMarkOfChaos(state, 'p1', acolyte, 'KHORNE')).toBe(false);
    expect(markOf(state, state.operatives[acolyte]!)).toBeUndefined();
    expect(setMarkOfChaos(state, 'p1', acolyte, 'TZEENTCH')).toBe(true);
    expect(markOf(state, state.operatives[acolyte]!)).toBe('TZEENTCH');
    expect(MARKS).toEqual(['KHORNE', 'NURGLE', 'SLAANESH', 'TZEENTCH', 'UNDIVIDED']);
  });

  it('KHORNE › Wrathful Onslaught: "This operative’s melee weapons have the Severe weapon rule"', () => {
    expect(MARK_RULE.KHORNE).toContain('melee weapons have the Severe weapon rule');
    const { ctx, state } = setup();
    const butcher = state.operatives[opWith(state, 'p1', 'legionary.butcher')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.butcher')]!;
    const axe = profileOf('legionary.butcher', 'Double-handed chainaxe');
    const pistol = profileOf('legionary.butcher', 'Bolt pistol');
    setMarkOfChaos(state, 'p1', butcher.id, 'KHORNE');
    const melee = effectiveRules(ctx, state, axe, { operative: butcher, target: foe, weaponName: 'Double-handed chainaxe' });
    expect(melee.some((r) => r.id === 'Severe')).toBe(true);
    // "melee weapons" only.
    const ranged = effectiveRules(ctx, state, pistol, { operative: butcher, target: foe, weaponName: 'Bolt pistol' });
    expect(ranged.some((r) => r.id === 'Severe')).toBe(false);
  });

  it('TZEENTCH › Empyreal Guidance: "This operative’s ranged weapons have the Severe weapon rule"', () => {
    expect(MARK_RULE.TZEENTCH).toContain('ranged weapons have the Severe weapon rule');
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', 'legionary.gunner')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.gunner')]!;
    setMarkOfChaos(state, 'p1', gunner.id, 'TZEENTCH');
    const meltagun = profileOf('legionary.gunner', 'Meltagun');
    expect(
      effectiveRules(ctx, state, meltagun, { operative: gunner, target: foe, weaponName: 'Meltagun' }).some(
        (r) => r.id === 'Severe',
      ),
    ).toBe(true);
  });

  it('SLAANESH › Unnatural Agility: "Add 1\\" to this operative’s Move stat"', () => {
    expect(MARK_RULE.SLAANESH).toContain('Add 1" to this operative’s Move stat');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'legionary.warrior');
    expect(moveBudget(ctx, state, state.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(6);
    setMarkOfChaos(state, 'p1', id, 'SLAANESH');
    expect(moveBudget(ctx, state, state.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(7);
  });

  it('UNDIVIDED › Vicious Reavers: Ceaseless "against an enemy operative within 6\\" of it"', () => {
    expect(MARK_RULE.UNDIVIDED).toContain('within 6" of it, this operative’s weapons have the Ceaseless weapon rule');
    const { ctx, state } = setup();
    const gunner = state.operatives[opWith(state, 'p1', 'legionary.gunner')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.gunner')]!;
    setMarkOfChaos(state, 'p1', gunner.id, 'UNDIVIDED');
    const bolter = profileOf('legionary.gunner', 'Bolt pistol');
    gunner.pos = { x: 14, y: 11 };
    foe.pos = { x: 18, y: 11 };
    expect(
      effectiveRules(ctx, state, bolter, { operative: gunner, target: foe, weaponName: 'Bolt pistol' }).some(
        (r) => r.id === 'Ceaseless',
      ),
    ).toBe(true);
    foe.pos = { x: 24, y: 11 };
    expect(
      effectiveRules(ctx, state, bolter, { operative: gunner, target: foe, weaponName: 'Bolt pistol' }).some(
        (r) => r.id === 'Ceaseless',
      ),
    ).toBe(false);
  });

  it('NURGLE › Disgusting Vigour: "Whenever Normal Dmg of 3 or more is inflicted … on a 5+, subtract 1"', () => {
    expect(MARK_RULE.NURGLE).toContain('roll one D6: on a 5+, subtract 1 from that inflicted damage');
    const { ctx, state } = setup({ script: [5, 1] });
    const victim = state.operatives[opWith(state, 'p1', 'legionary.warrior')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    setMarkOfChaos(state, 'p1', victim.id, 'NURGLE');
    // A boltgun (Normal Dmg 3) with one unblocked normal success.
    fakeShoot(state, shooter.id, victim.id, 'Boltgun', [{ value: 4, state: 'normal' }]);
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(before - victim.wounds).toBe(2); // rolled a 5 → 3 − 1
    const mid = victim.wounds;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(mid - victim.wounds).toBe(3); // rolled a 1 → no reduction
  });
});

// ---------------------------------------------------------------------------
describe('Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('the second Shoot needs a bolt pistol, boltgun or tainted bolt pistol, and never mixes with a Fight', () => {
    expect(rule('legionary.rule.astartes')).toContain(
      'a bolt pistol, boltgun or tainted bolt pistol must be selected for at least one of them',
    );
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'legionary.icon-bearer'); // Boltgun; fists
    const enemy = opWith(state, 'p2', 'legionary.warrior');
    const s = activate(ctx, state, id);
    expect(availableActions(ctx, s, s.operatives[id]!).some((a) => a.def.id === ASTARTES_SHOOT)).toBe(true);
    expect(availableActions(ctx, s, s.operatives[id]!).some((a) => a.def.id === ASTARTES_FIGHT)).toBe(true);

    const first = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: ASTARTES_SHOOT, params: { weaponName: 'Boltgun', targetId: enemy } },
      ctx,
    );
    expect(first.reason).toMatch(/second Shoot action/);

    const shot = { ...s };
    shot.operatives[id]!.actionsThisActivation = ['Shoot', 'Fight'];
    expect(
      reduce(shot, { t: 'PerformAction', operativeId: id, action: ASTARTES_SHOOT, params: { weaponName: 'Boltgun', targetId: enemy } }, ctx)
        .reason,
    ).toMatch(/two Shoot actions or two Fight actions/);

    const gunnerId = opWith(state, 'p1', 'legionary.gunner');
    const g = activate(ctx, state, gunnerId);
    g.operatives[gunnerId]!.actionsThisActivation = ['Shoot'];
    expect(
      reduce(g, { t: 'PerformAction', operativeId: gunnerId, action: ASTARTES_SHOOT, params: { weaponName: 'Flamer', targetId: enemy } }, ctx)
        .reason,
    ).toMatch(/bolt pistol, boltgun or tainted bolt pistol/);
  });

  it('the second Shoot really resolves through the universal Shoot action', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'legionary.icon-bearer');
    const enemy = opWith(state, 'p2', 'legionary.warrior');
    banish(state, 'p1', [id]);
    banish(state, 'p2', [enemy]);
    state.operatives[id]!.pos = { x: 14, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, id);
    s = reduce(s, { t: 'PerformAction', operativeId: id, action: 'Shoot', params: { weaponName: 'Boltgun', targetId: enemy } }, ctx).state;
    s = settle(ctx, s);
    const second = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: ASTARTES_SHOOT, params: { weaponName: 'Boltgun', targetId: enemy } },
      ctx,
    );
    expect(second.ok).toBe(true);
    expect(second.state.operatives[id]!.actionsThisActivation).toEqual(['Shoot', ASTARTES_SHOOT]);
    expect(second.state.rejected).toEqual([]);
  });

  it('"Each friendly LEGIONARY operative can counteract regardless of its order" — the hook grants it', () => {
    expect(rule('legionary.rule.astartes')).toContain('can counteract regardless of its order');
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', 'legionary.warrior')]!;
    op.order = 'conceal';
    const ev = ctx.hooks.emit('onCounteract', state, { state, operative: op, allowed: false });
    expect(ev.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('LEGIONARY strategy ploys', () => {
  it('IMPLACABLE: "weapons with the Piercing 1 weapon rule have the Piercing Crits 1 weapon rule instead"', () => {
    expect(rule('legionary.sp.implacable')).toContain('have the Piercing Crits 1 weapon rule instead');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p2', 'legionary.gunner')]!;
    const target = state.operatives[opWith(state, 'p1', 'legionary.warrior')]!;
    const plasma = profileOf('legionary.gunner', 'Plasma gun', 'standard');
    const before = effectiveRules(ctx, state, plasma, { operative: shooter, target, weaponName: 'Plasma gun' });
    expect(before.some((r) => r.id === 'Piercing' && r.x === 1)).toBe(true);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.implacable' }, ctx).state;
    const after = effectiveRules(ctx, s, plasma, {
      operative: s.operatives[shooter.id]!,
      target: s.operatives[target.id]!,
      weaponName: 'Plasma gun',
    });
    expect(after.some((r) => r.id === 'Piercing')).toBe(false);
    expect(after.some((r) => r.id === 'PiercingCrits' && r.x === 1)).toBe(true);
  });

  it('IMPLACABLE: "ignore any changes to the stats of friendly LEGIONARY NURGLE operatives from being injured"', () => {
    expect(rule('legionary.sp.implacable')).toContain('from being injured');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'legionary.warrior');
    state.operatives[id]!.wounds = 5; // 5 < 14/2 → injured
    expect(moveBudget(ctx, state, state.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(4);
    setMarkOfChaos(state, 'p1', id, 'NURGLE');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.implacable' }, ctx).state;
    expect(moveBudget(ctx, s, s.operatives[id]!, { action: 'Reposition' })).toBeCloseTo(6);
    expect(hitOf(ctx, s, s.operatives[id]!, profileOf('legionary.warrior', 'Boltgun'))).toBe(3);
  });

  it('QUICKSILVER SPEED: a moved LEGIONARY fighting worsens "the Hit stat of the enemy operative’s melee weapons by 1"', () => {
    expect(rule('legionary.sp.quicksilver-speed')).toContain('worsen the Hit stat of the enemy operative’s melee weapons by 1');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', 'legionary.shrivetalon')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.butcher')]!;
    const axe = profileOf('legionary.butcher', 'Double-handed chainaxe');
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.quicksilver-speed' }, ctx).state;
    fakeFight(s, mine.id, foe.id, 'Flensing blades', { defenderWeapon: 'Double-handed chainaxe' });
    expect(hitOf(ctx, s, s.operatives[foe.id]!, axe)).toBe(4); // it has not moved yet
    s.operatives[mine.id]!.actionsThisActivation = ['Charge'];
    expect(hitOf(ctx, s, s.operatives[foe.id]!, axe)).toBe(5);
    // "In all cases for this ploy, this isn't cumulative with being injured."
    s.operatives[foe.id]!.wounds = 4;
    expect(hitOf(ctx, s, s.operatives[foe.id]!, axe)).toBe(5);
  });

  it('QUICKSILVER SPEED: an operative shooting a moved SLAANESH operative more than 6" away is worsened by 1', () => {
    expect(rule('legionary.sp.quicksilver-speed')).toContain('more than 6" from it');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', 'legionary.warrior')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    const boltgun = profileOf('legionary.warrior', 'Boltgun');
    setMarkOfChaos(state, 'p1', mine.id, 'SLAANESH');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.quicksilver-speed' }, ctx).state;
    s.operatives[mine.id]!.actionsThisActivation = ['Reposition'];
    s.operatives[mine.id]!.pos = { x: 4, y: 11 };
    s.operatives[foe.id]!.pos = { x: 24, y: 11 };
    fakeShoot(s, foe.id, mine.id, 'Boltgun', []);
    expect(hitOf(ctx, s, s.operatives[foe.id]!, boltgun)).toBe(4);
    s.operatives[foe.id]!.pos = { x: 8, y: 11 }; // within 6" — no longer applies
    expect(hitOf(ctx, s, s.operatives[foe.id]!, boltgun)).toBe(3);
  });

  it('FICKLE FATES: "shooting a ready enemy operative … ranged weapons have the Balanced weapon rule"', () => {
    expect(rule('legionary.sp.fickle-fates')).toContain('ranged weapons have the Balanced weapon rule');
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'legionary.warrior')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    const boltgun = profileOf('legionary.warrior', 'Boltgun');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.fickle-fates' }, ctx).state;
    const use = { operative: s.operatives[shooter.id]!, target: s.operatives[foe.id]!, weaponName: 'Boltgun' };
    expect(effectiveRules(ctx, s, boltgun, use).some((r) => r.id === 'Balanced')).toBe(true);
    s.operatives[foe.id]!.ready = false;
    expect(effectiveRules(ctx, s, boltgun, use).some((r) => r.id === 'Balanced')).toBe(false);
  });

  it('FICKLE FATES: a ready TZEENTCH defender "can retain one of your fails as a normal success"', () => {
    expect(rule('legionary.sp.fickle-fates')).toContain('you can retain one of your fails as a normal success instead');
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', 'legionary.warrior')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    setMarkOfChaos(state, 'p1', target.id, 'TZEENTCH');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.fickle-fates' }, ctx).state;
    const boltgun = profileOf('legionary.warrior', 'Boltgun');
    fakeShoot(s, shooter.id, target.id, 'Boltgun', []);
    const seq = s.sequence as { defence: { dice: { id: number; value: number; state: string; rolled: boolean }[]; nextId: number } };
    seq.defence.dice = [
      { id: 1, value: 6, state: 'crit', rolled: true },
      { id: 2, value: 1, state: 'fail', rolled: true },
    ];
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[shooter.id]!, s.operatives[target.id]!, 'Boltgun', boltgun),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.rerolls.some((r) => r.id === 'legionary.fickleFates' && r.mode === 'fails')).toBe(true);
  });

  it('BLOOD FOR THE BLOOD GOD: "the first time you strike during that sequence, inflict 1 additional damage"', () => {
    expect(rule('legionary.sp.blood-for-the-blood-god')).toContain('inflict 1 additional damage (to a maximum of 7)');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', 'legionary.shrivetalon')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.blood-for-the-blood-god' }, ctx).state;
    fakeFight(s, mine.id, foe.id, 'Flensing blades');
    const victim = s.operatives[foe.id]!;
    const before = victim.wounds;
    inflictDamage(ctx, s, victim, 3, 'attack');
    expect(before - victim.wounds).toBe(4);
    const mid = victim.wounds;
    inflictDamage(ctx, s, victim, 3, 'attack'); // "the FIRST time you strike during that sequence"
    expect(mid - victim.wounds).toBe(3);
  });

  it('BLOOD FOR THE BLOOD GOD: "Add 1 to both Dmg stats of friendly LEGIONARY KHORNE operatives’ melee weapons"', () => {
    expect(rule('legionary.sp.blood-for-the-blood-god')).toContain('Add 1 to both Dmg stats');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', 'legionary.butcher')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    setMarkOfChaos(state, 'p1', mine.id, 'KHORNE');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'legionary.sp.blood-for-the-blood-god' }, ctx).state;
    fakeFight(s, mine.id, foe.id, 'Double-handed chainaxe');
    const victim = s.operatives[foe.id]!;
    const before = victim.wounds;
    inflictDamage(ctx, s, victim, 5, 'attack');
    // KHORNE gets the Dmg bump, and the "(excluding KHORNE)" first-strike bonus does not stack.
    expect(before - victim.wounds).toBe(6);
  });
});

// ---------------------------------------------------------------------------
describe('LEGIONARY firefight ploys', () => {
  it('each mark-specific ploy is unusable without an operative that has the keyword', () => {
    const { state } = setup();
    const usable = (id: string): boolean => legionary.ploys.find((p) => p.id === id)!.usable!(state, 'p1').ok;
    expect(usable('legionary.fp.unending-bloodshed')).toBe(false);
    setMarkOfChaos(state, 'p1', opWith(state, 'p1', 'legionary.butcher'), 'KHORNE');
    expect(usable('legionary.fp.unending-bloodshed')).toBe(true);
    expect(usable('legionary.fp.sickening-captivation')).toBe(false);
  });

  it('UNENDING BLOODSHED: "You can strike the enemy operative … with one of your unresolved successes"', () => {
    expect(rule('legionary.fp.unending-bloodshed')).toContain('before it’s removed from the killzone');
    const { ctx, state } = setup();
    const mine = state.operatives[opWith(state, 'p1', 'legionary.butcher')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    setMarkOfChaos(state, 'p1', mine.id, 'KHORNE');
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'legionary.fp.unending-bloodshed' }, ctx).state;
    // The KHORNE operative retaliates with its chainaxe (Critical Dmg 7) and is then killed.
    fakeFight(s, foe.id, mine.id, 'Boltgun', {
      defenderWeapon: 'Double-handed chainaxe',
      defenderDice: [{ value: 6, state: 'crit' }],
    });
    const enemy = s.operatives[foe.id]!;
    const before = enemy.wounds;
    inflictDamage(ctx, s, s.operatives[mine.id]!, 40, 'attack');
    expect(s.operatives[mine.id]!.incapacitated).toBe(true);
    expect(before - enemy.wounds).toBe(7);
  });

  it('MALIGNANT AURA: a NURGLE operative’s ranged weapons gain "the Piercing 1 weapon rule" within 3"', () => {
    expect(rule('legionary.fp.malignant-aura')).toContain('ranged weapons have the Piercing 1 weapon rule');
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', 'legionary.gunner');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    setMarkOfChaos(state, 'p1', mine, 'NURGLE');
    state.operatives[mine]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, mine);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'legionary.fp.malignant-aura' }, ctx).state;
    const flamer = profileOf('legionary.gunner', 'Flamer');
    const use = { operative: s.operatives[mine]!, target: s.operatives[foe]!, weaponName: 'Flamer' };
    expect(effectiveRules(ctx, s, flamer, use).some((r) => r.id === 'Piercing' && r.x === 1)).toBe(true);
    s.operatives[foe]!.pos = { x: 22, y: 11 }; // "an enemy operative within 3" of it"
    expect(effectiveRules(ctx, s, flamer, use).some((r) => r.id === 'Piercing')).toBe(false);
  });

  it('SICKENING CAPTIVATION: "Select one enemy operative visible to and within 4\\" … subtract 1 from its APL stat"', () => {
    expect(rule('legionary.fp.sickening-captivation')).toContain('subtract 1 from its APL stat');
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', 'legionary.shrivetalon');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    setMarkOfChaos(state, 'p1', mine, 'SLAANESH');
    banish(state, 'p2', [foe]);
    state.operatives[mine]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, mine);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'legionary.fp.sickening-captivation', data: { operativeId: foe } }, ctx).state;
    expect(s.operatives[foe]!.aplMods).toContain(-1);
  });

  it('MUTABILITY AND CHANGE: "add 1 to its APL stat, but it cannot perform the same action more than once"', () => {
    expect(rule('legionary.fp.mutability-and-change')).toContain('it cannot perform the same action more than once');
    const { ctx, state } = setup();
    const mine = opWith(state, 'p1', 'legionary.gunner');
    setMarkOfChaos(state, 'p1', mine, 'TZEENTCH');
    let s = activate(ctx, state, mine);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'legionary.fp.mutability-and-change' }, ctx).state;
    expect(s.operatives[mine]!.aplMods).toContain(1);
    const second = availableActions(ctx, s, s.operatives[mine]!).find((a) => a.def.id === ASTARTES_SHOOT);
    expect(second?.reason ?? '').toMatch(/same action more than once/);
  });
});

// ---------------------------------------------------------------------------
describe('LEGIONARY faction equipment', () => {
  it('WARDED ARMOUR is a STRATEGIC GAMBIT that changes "that operative’s Save stat to 2+"', () => {
    expect(rule('legionary.eq.warded-armour')).toContain('change that operative’s Save stat to 2+');
    const { ctx, state } = setup({ equipment: ['legionary.eq.warded-armour'] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const id = opWith(state, 'p1', 'legionary.warrior');
    expect(gambitOptions(ctx, state, 'p1').some((o) => o.id === 'legionary.eq.warded-armour')).toBe(true);
    expect(saveOf(ctx, state, state.operatives[id]!)).toBe(3);
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'legionary.eq.warded-armour', data: { operativeId: id } },
      ctx,
    ).state;
    expect(saveOf(ctx, s, s.operatives[id]!)).toBe(2);
  });

  it('MALEFIC BLADES: "Friendly LEGIONARY operatives have the following melee weapon … Malefic blade 5 / 3+ / 3/4"', () => {
    expect(rule('legionary.eq.malefic-blades')).toContain('Malefic blade');
    const { ctx, state } = setup({ equipment: ['legionary.eq.malefic-blades'] });
    const id = opWith(state, 'p1', 'legionary.gunner');
    const s = activate(ctx, state, id);
    const granted = (s.operatives[id] as { grantedWeapons?: { name: string; profiles: WeaponProfile[] }[] }).grantedWeapons ?? [];
    const blade = granted.find((w) => w.name === 'Malefic blade');
    expect(blade).toBeDefined();
    expect(blade!.profiles[0]).toMatchObject({ type: 'melee', atk: 5, hit: 3, dmgN: 3, dmgC: 4 });
  });

  it('TAINTED ROUNDS: "Once per turning point … that weapon has the Rending weapon rule"', () => {
    expect(rule('legionary.eq.tainted-rounds')).toContain('Once per turning point');
    const { ctx, state } = setup({ equipment: ['legionary.eq.tainted-rounds'] });
    const shooter = opWith(state, 'p1', 'legionary.icon-bearer'); // Boltgun; fists
    const foe = opWith(state, 'p2', 'legionary.warrior');
    banish(state, 'p1', [shooter]);
    banish(state, 'p2', [foe]);
    state.operatives[shooter]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, shooter);
    const shot = reduce(
      s,
      { t: 'PerformAction', operativeId: shooter, action: 'Shoot', params: { weaponName: 'Boltgun', targetId: foe } },
      ctx,
    );
    expect(shot.ok).toBe(true);
    s = shot.state;
    expect(s.effects.some((e) => e.rule === 'legionary.taintedRounds' && e.operativeId === shooter)).toBe(true);
    const boltgun = profileOf('legionary.icon-bearer', 'Boltgun');
    const rules = effectiveRules(ctx, s, boltgun, {
      operative: s.operatives[shooter]!,
      target: s.operatives[foe]!,
      weaponName: 'Boltgun',
    });
    expect(rules.some((r) => r.id === 'Rending')).toBe(true);
    // Not the bolt pistol — the rule names the weapon it was used on.
    const pistol = profileOf('legionary.icon-bearer', 'Bolt pistol');
    expect(
      effectiveRules(ctx, s, pistol, { operative: s.operatives[shooter]!, target: s.operatives[foe]!, weaponName: 'Bolt pistol' }).some(
        (r) => r.id === 'Rending',
      ),
    ).toBe(false);
  });

  it('CHAOS TALISMANS: "inflict D3 damage on that friendly operative to discard one of them and retain the other"', () => {
    expect(rule('legionary.eq.chaos-talismans')).toContain('retain the other as a normal success instead');
    const { ctx, state } = setup({ equipment: ['legionary.eq.chaos-talismans'], script: [2] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const shooter = opWith(state, 'p1', 'legionary.warrior');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    setMarkOfChaos(state, 'p1', shooter, 'KHORNE');
    expect(gambitOptions(ctx, state, 'p1').filter((o) => o.id.startsWith('legionary.eq.chaos-talismans:'))).toHaveLength(5);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: talismanGambitId('KHORNE') }, ctx).state;

    fakeShoot(s, shooter, foe, 'Boltgun', [
      { value: 2, state: 'fail' },
      { value: 1, state: 'fail' },
      { value: 5, state: 'normal' },
    ]);
    const boltgun = profileOf('legionary.warrior', 'Boltgun');
    ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: attackCtx(s.operatives[shooter]!, s.operatives[foe]!, 'Boltgun', boltgun),
      dice: [],
      rerolls: [],
    });
    const decision = s.pending.find((d) => d.kind === 'legionary.chaosTalismans');
    expect(decision).toBeDefined();
    const wounds = s.operatives[shooter]!.wounds;
    resolveDecision(ctx, s, decision!.id, 'accept');
    const dice = (s.sequence as { attack: { dice: { state: string }[] } }).attack.dice;
    expect(dice.filter((d) => d.state === 'discarded')).toHaveLength(1);
    expect(dice.filter((d) => d.state === 'normal')).toHaveLength(2);
    expect(s.operatives[shooter]!.wounds).toBeLessThan(wounds);
  });
});

// ---------------------------------------------------------------------------
describe('LEGIONARY datacard abilities', () => {
  it('In the Eyes of the Gods: "if it incapacitates an enemy operative, add 1 to its APL stat"', () => {
    expect(ability('legionary.aspiring-champion', 'legionary.aspiring-champion.in-the-eyes-of-the-gods')).toContain(
      'add 1 to its APL stat until the end of that activation',
    );
    const { ctx, state } = setup();
    const champion = opWith(state, 'p1', 'legionary.aspiring-champion');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    state.activeOperativeId = champion;
    fakeFight(state, champion, foe, 'Power fist');
    inflictDamage(ctx, state, state.operatives[foe]!, 40, 'attack');
    expect(state.operatives[foe]!.incapacitated).toBe(true);
    expect(state.operatives[champion]!.aplMods).toContain(1);
    expect(state.effects.some((e) => e.rule === 'legionary.inTheEyesOfTheGods')).toBe(true);
  });

  it('Daemonic Aura: "on a 3+, that enemy operative cannot perform that action during that activation"', () => {
    expect(ability('legionary.chosen', 'legionary.chosen.daemonic-aura')).toContain('on a 3+, that enemy operative cannot perform that action');
    const { ctx, state } = setup({ script: [5] });
    const chosen = opWith(state, 'p1', 'legionary.chosen');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    banish(state, 'p1', [chosen]);
    banish(state, 'p2', [foe]);
    state.operatives[chosen]!.pos = { x: 15, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    const s = activate(ctx, state, foe);
    expect(s.effects.some((e) => e.rule === 'legionary.daemonicAura' && e.operativeId === foe)).toBe(true);
    const fallBack = availableActions(ctx, s, s.operatives[foe]!).find((a) => a.def.id === 'Fall Back');
    expect(fallBack?.reason ?? '').toMatch(/Daemonic Aura/);
  });

  it('Soul Gorge: "it regains up to D3+1 lost wounds" after incapacitating an enemy in a fight', () => {
    expect(ability('legionary.chosen', 'legionary.chosen.soul-gorge')).toContain('regains up to D3+1 lost wounds');
    const { ctx, state } = setup({ script: [4] }); // D3 = 2
    const chosen = opWith(state, 'p1', 'legionary.chosen');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    state.operatives[chosen]!.wounds = 6;
    fakeFight(state, chosen, foe, 'Daemon blade');
    inflictDamage(ctx, state, state.operatives[foe]!, 40, 'attack');
    expect(state.operatives[chosen]!.wounds).toBe(9); // 6 + (D3 2 + 1)
  });

  it('Unleash Daemon: a once-per-battle choice that bans mission actions, softens Dmg 4+ and upgrades the claw', () => {
    const printed = ability('legionary.anointed', 'legionary.anointed.unleash-daemon');
    expect(printed).toContain('Normal and Critical Dmg of 4 or more inflicts 1 less damage on this operative');
    expect(printed).toContain('Its daemonic claw has the Ceaseless and Lethal 5+ weapon rules');
    const { ctx, state } = setup();
    const anointed = opWith(state, 'p1', 'legionary.anointed');
    banish(state, 'p2');
    let s = activate(ctx, state, anointed);
    const decision = s.pending.find((d) => d.kind === 'legionary.unleashDaemon');
    expect(decision).toBeDefined();
    expect(decision!.options[0]!.id).toBe('no'); // nothing applies until it is chosen
    s = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'yes' }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'legionary.unleashed' && e.operativeId === anointed)).toBe(true);

    // "This operative cannot perform the Pick Up Marker or mission actions (excluding Operate Hatch)."
    const pickUp = availableActions(ctx, s, s.operatives[anointed]!).find((a) => a.def.id === 'Pick Up Marker');
    expect(pickUp?.reason ?? '').toMatch(/Unleash Daemon/);

    // "Its daemonic claw has the Ceaseless and Lethal 5+ weapon rules."
    const claw = profileOf('legionary.anointed', 'Daemonic claw');
    const rules = effectiveRules(ctx, s, claw, { operative: s.operatives[anointed]!, weaponName: 'Daemonic claw' });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
    expect(rules.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);

    // "Normal and Critical Dmg of 4 or more inflicts 1 less damage on this operative."
    const foe = opWith(state, 'p2', 'legionary.butcher');
    fakeFight(s, foe, anointed, 'Double-handed chainaxe'); // Normal Dmg 5
    const before = s.operatives[anointed]!.wounds;
    inflictDamage(ctx, s, s.operatives[anointed]!, 5, 'attack');
    expect(before - s.operatives[anointed]!.wounds).toBe(4);
  });

  it('Siphon Life: a nominated friendly LEGIONARY "regains 1 lost wound, or D3 … if it was a critical success"', () => {
    expect(ability('legionary.balefire-acolyte', 'legionary.balefire-acolyte.siphon-life')).toContain(
      'regains 1 lost wound, or D3 lost wounds if it was a critical success',
    );
    const { ctx, state } = setup({ script: [4] }); // the crit's D3 = 2
    const acolyte = state.operatives[opWith(state, 'p1', 'legionary.balefire-acolyte')]!;
    const patient = state.operatives[opWith(state, 'p1', 'legionary.butcher')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    banish(state, 'p1', [acolyte.id, patient.id]);
    acolyte.pos = { x: 12, y: 11 };
    patient.pos = { x: 14, y: 11 };
    patient.wounds = 5;
    const siphon = profileOf('legionary.balefire-acolyte', 'Life siphon');

    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(acolyte, foe, 'Life siphon', siphon),
      count: siphon.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    const nomination = state.effects.find((e) => e.rule === 'legionary.siphonLife');
    expect(nomination?.data?.['targetId']).toBe(patient.id);

    fakeShoot(state, acolyte.id, foe.id, 'Life siphon', [
      { value: 6, state: 'crit' },
      { value: 4, state: 'normal' },
    ]);
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(acolyte, foe, 'Life siphon', siphon),
      crit: true,
      struck: foe,
    });
    expect(patient.wounds).toBe(8); // 5 + D3(2) for the crit + 1 for the normal
  });

  it('Devastating Onslaught: "enemy operatives cannot assist" and a free Charge of no more than 2"', () => {
    const printed = ability('legionary.butcher', 'legionary.butcher.devastating-onslaught');
    expect(printed).toContain('enemy operatives cannot assist');
    expect(printed).toContain('it cannot move more than 2"');
    const { ctx, state } = setup();
    const butcher = state.operatives[opWith(state, 'p1', 'legionary.butcher')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    banish(state, 'p1', [butcher.id]);
    banish(state, 'p2', [foe.id]);
    butcher.pos = { x: 15, y: 11 };
    foe.pos = { x: 16, y: 11 };
    const assists = ctx.hooks.emit('onFightAssist', state, { state, operative: foe, assists: 2 });
    expect(assists.assists).toBe(0);

    ctx.hooks.emit('onActivationEnd', state, { state, operative: foe });
    expect(butcher.aplMods).toContain(1);
    butcher.apSpent = 3; // the granted AP is the last one it spends
    expect(moveBudget(ctx, state, butcher, { action: 'Charge', bonusInches: 2 })).toBeCloseTo(2);
  });

  it('Icon Bearer: "treat this operative’s APL stat as 1 higher" whenever determining control of a marker', () => {
    expect(ability('legionary.icon-bearer', 'legionary.icon-bearer.icon-bearer')).toContain('treat this operative’s APL stat as 1 higher');
    const { ctx, state } = setup();
    const bearer = state.operatives[opWith(state, 'p1', 'legionary.icon-bearer')]!;
    bearer.pos = { x: 15, y: 11 };
    const ev = ctx.hooks.emit('onMarkerControl', state, { state, markerId: 'centre', aplByPlayer: { p1: 3, p2: 3 } });
    expect(ev.aplByPlayer.p1).toBe(4);
  });

  it('Favoured of the Dark Gods: taints one objective marker in the Ready step and gains 1CP', () => {
    expect(ability('legionary.icon-bearer', 'legionary.icon-bearer.favoured-of-the-dark-gods')).toContain(
      'that objective marker is tainted for the battle and you gain 1CP',
    );
    const { ctx, state } = setup();
    const bearer = state.operatives[opWith(state, 'p1', 'legionary.icon-bearer')]!;
    banish(state, 'p1', [bearer.id]);
    banish(state, 'p2');
    bearer.pos = { x: 15, y: 11 };
    const ev = ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(ev.cp).toBe(2);
    expect(state.markers['centre']!.flags['legionaryTainted']).toBe('p1');
    // "if any operative … has tainted an objective marker, you cannot taint that objective marker"
    const again = ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(again.cp).toBe(1);
  });

  it('Vicious Reflexes: "whenever this operative is retaliating, you resolve the first attack dice"', () => {
    expect(ability('legionary.shrivetalon', 'legionary.shrivetalon.vicious-reflexes')).toContain(
      'you resolve the first attack dice',
    );
    const { ctx, state } = setup();
    const shrive = state.operatives[opWith(state, 'p1', 'legionary.shrivetalon')]!;
    const foe = state.operatives[opWith(state, 'p2', 'legionary.butcher')]!;
    fakeFight(state, foe.id, shrive.id, 'Double-handed chainaxe', { defenderWeapon: 'Flensing blades' });
    const blades = profileOf('legionary.shrivetalon', 'Flensing blades');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shrive, foe, 'Flensing blades', blades, 'melee'),
      count: blades.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect((state.sequence as { turn: string }).turn).toBe('defender');
  });

  it('Horrifying Dismemberment: another enemy within 3" has "1 subtracted from its APL stat"', () => {
    expect(ability('legionary.shrivetalon', 'legionary.shrivetalon.horrifying-dismemberment')).toContain(
      'Subtract 1 from that enemy operative’s APL stat until the end of its next activation',
    );
    const { ctx, state } = setup();
    const shrive = state.operatives[opWith(state, 'p1', 'legionary.shrivetalon')]!;
    const victim = state.operatives[opWith(state, 'p2', 'legionary.warrior')]!;
    const other = state.operatives[opWith(state, 'p2', 'legionary.gunner')]!;
    banish(state, 'p2', [victim.id, other.id]);
    shrive.pos = { x: 15, y: 11 };
    victim.pos = { x: 16, y: 11 };
    other.pos = { x: 17.5, y: 11 };
    fakeFight(state, shrive.id, victim.id, 'Flensing blades');
    inflictDamage(ctx, state, victim, 40, 'attack');
    expect(other.aplMods).toContain(-1);
  });

  it('Infernal Pact: "Once per battle, when a friendly LEGIONARY WARRIOR operative is activated … change that operative’s Marks of Chaos keyword"', () => {
    expect(ability('legionary.warrior', 'legionary.warrior.infernal-pact')).toContain('change that operative’s Marks of Chaos keyword');
    const { ctx, state } = setup();
    const warrior = opWith(state, 'p1', 'legionary.warrior');
    setMarkOfChaos(state, 'p1', warrior, 'UNDIVIDED');
    banish(state, 'p2');
    let s = activate(ctx, state, warrior);
    const decision = s.pending.find((d) => d.kind === 'legionary.infernalPact');
    expect(decision).toBeDefined();
    s = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'KHORNE' }, ctx).state;
    expect(markOf(s, s.operatives[warrior]!)).toBe('KHORNE');
    // "Once per battle" — the offer is not made again.
    s.operatives[warrior]!.ready = true;
    s.activeOperativeId = undefined;
    s.activePlayer = 'p1';
    const again = activate(ctx, s, warrior);
    expect(again.pending.some((d) => d.kind === 'legionary.infernalPact')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('GRISLY MARK 2AP — "Place your Grisly marker within this operative’s control range"', () => {
  it('places the marker once per battle and never while within control range of an enemy', () => {
    const printed = DATA.datacards
      .find((c) => c.id === 'legionary.shrivetalon')!
      .uniqueActions.find((a) => a.id === 'legionary.shrivetalon.act.grisly-mark')!;
    expect(printed.ap).toBe(2);
    expect(printed.text).toContain('cannot perform it while within control range of an enemy operative');

    const { ctx, state } = setup();
    const shrive = opWith(state, 'p1', 'legionary.shrivetalon');
    const enemy = opWith(state, 'p2', 'legionary.warrior');
    banish(state, 'p2', [enemy]);
    state.operatives[shrive]!.pos = { x: 12, y: 11 };
    // "…cannot perform it while within control range of an enemy operative."
    state.operatives[enemy]!.pos = { x: 12.6, y: 11 };
    let s = activate(ctx, state, shrive);
    const engaged = reduce(s, { t: 'PerformAction', operativeId: shrive, action: 'legionary.shrivetalon.act.grisly-mark' }, ctx);
    expect(engaged.ok).toBe(false);
    expect(engaged.reason).toMatch(/control range of an enemy operative/);
    s.operatives[enemy]!.pos = { x: 29, y: 1 };
    const out = reduce(s, { t: 'PerformAction', operativeId: shrive, action: 'legionary.shrivetalon.act.grisly-mark' }, ctx);
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.markers[GRISLY_MARKER('p1')]).toBeDefined();

    // "This operative cannot perform this action more than once per battle."
    s.operatives[shrive]!.actionsThisActivation = [];
    s.operatives[shrive]!.apSpent = 0;
    const twice = reduce(s, { t: 'PerformAction', operativeId: shrive, action: 'legionary.shrivetalon.act.grisly-mark' }, ctx);
    expect(twice.ok).toBe(false);
    expect(twice.reason).toMatch(/already placed its Grisly marker this battle/);
  });
});

// ---------------------------------------------------------------------------
describe('CHAOS TALISMANS inside a live Shoot action', () => {
  it('offers its choice mid-sequence, costs D3 wounds, and the action still finishes', () => {
    // Boltgun, Hit 3+: two 1s (fails) and two 5s (normal successes), then the D3 for the damage.
    const { ctx, state } = setup({ equipment: ['legionary.eq.chaos-talismans'], script: [1, 1, 5, 5, 4] });
    const shooter = opWith(state, 'p1', 'legionary.icon-bearer');
    const foe = opWith(state, 'p2', 'legionary.warrior');
    setMarkOfChaos(state, 'p1', shooter, 'KHORNE');
    banish(state, 'p1', [shooter]);
    banish(state, 'p2', [foe]);
    state.operatives[shooter]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 18, y: 11 };
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: talismanGambitId('KHORNE') }, ctx).state;
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    s = activate(ctx, s, shooter);
    const wounds = s.operatives[shooter]!.wounds;
    s = reduce(s, { t: 'PerformAction', operativeId: shooter, action: 'Shoot', params: { weaponName: 'Boltgun', targetId: foe } }, ctx).state;
    expect(s.pending.some((d) => d.kind === 'legionary.chaosTalismans')).toBe(true);
    s = settle(ctx, s, (kind) => (kind === 'legionary.chaosTalismans' ? 'accept' : undefined));
    expect(s.pending).toEqual([]);
    expect(s.rejected).toEqual([]);
    expect(s.operatives[shooter]!.wounds).toBeLessThan(wounds);
    expect(s.sequence).toBeFalsy();
  });
});
