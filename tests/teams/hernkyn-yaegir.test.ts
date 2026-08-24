/**
 * HERNKYN YAEGIR (Leagues of Votann). Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/hernkyn-yaegir/
 */
import { describe, expect, it } from 'vitest';
import { getAction } from '../../src/core/actions.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { apBudgetOf, aplOf, freeApOf, hitOf, inflictDamage } from '../../src/core/state.ts';
import type { AttackContext } from '../../src/core/hooks.ts';
import { zeroStatMods } from '../../src/core/hooks.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import {
  A,
  C,
  EQ,
  FALLEN_KIN_MARKER,
  FP,
  KW,
  MINEFIELD_MARKER,
  PLASMA_KNIFE_WEAPON,
  RULE,
  SP,
  STALKER_CHARGE,
  abilityText,
  hernkynYaegir,
  minefieldMarkers,
  profileOf,
  resourcefulPoints,
} from '../../src/teams/hernkyn-yaegir/index.ts';
import { rareRuleTextFor } from '../../src/teams/helpers.ts';
import { act, activate, battle, opWith, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';

const DATA = teamData('hernkyn-yaegir');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string => abilityText(cardId, abilityId);

const ENEMY = 'kasrkin.trooper';

interface SetupOpts {
  picks?: string[];
  equipment?: string[];
  map?: KillzoneMap;
  seed?: number;
  cp?: number;
  tp?: number;
}

function setup(opts: SetupOpts = {}): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([hernkynYaegir, kasrkin], { seed: opts.seed ?? 7 });
  const picks = opts.picks ? opts.picks.map((datacardId) => ({ datacardId })) : defaultRoster(hernkynYaegir.data);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: hernkynYaegir, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: kasrkin },
  });
  state.teams.p1.cp = opts.cp ?? 6;
  state.teams.p2.cp = opts.cp ?? 6;
  state.turningPoint = opts.tp ?? 1;
  return { ctx, state };
}

const mapWithHeavy = (): KillzoneMap => testMap({ features: [heavyBlock('heavyA', 10, 9, 4, 4, 3)] });

/** Park a player's operatives out of the way, keeping the named ones where they are. */
function banish(state: GameState, player: PlayerId, keep: string[] = []): void {
  state.teams[player].operativeIds.forEach((id, i) => {
    if (keep.includes(id)) return;
    state.operatives[id]!.pos = { x: player === 'p1' ? 0.6 : 29.4, y: 0.6 + i * 1.6 };
  });
}

const ready = (ctx: ReturnType<typeof teamContext>, state: GameState, player: PlayerId): void => {
  ctx.hooks.emit('onReadyStep', state, { state, player, cp: 1 });
};

const gambit = (ctx: ReturnType<typeof teamContext>, state: GameState, id: string, player: PlayerId = 'p1'): GameState => {
  state.phase = 'strategy';
  state.strategyStep = 'gambit';
  return reduce(state, { t: 'UseGambit', player, gambitId: id }, ctx).state;
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
  opts: {
    profileName?: string;
    step?: string;
    inCover?: boolean;
    obscured?: boolean;
    vantageImprovedCover?: boolean;
    dice?: { value: number; state: 'crit' | 'normal' | 'fail' }[];
  } = {},
): void {
  state.sequence = {
    kind: 'shoot',
    step: (opts.step ?? 'done') as never,
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName,
    ...(opts.profileName ? { profileName: opts.profileName } : {}),
    secondary: false,
    pointBlank: false,
    inCover: opts.inCover ?? false,
    obscured: opts.obscured ?? false,
    coverChoiceMade: true,
    vantageAccurate: 0,
    vantageImprovedCover: opts.vantageImprovedCover ?? false,
    attack: {
      dice: (opts.dice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.dice ?? []).length + 1,
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
    attackerDice?: { value: number; state: 'crit' | 'normal' }[];
    defenderDice?: { value: number; state: 'crit' | 'normal' }[];
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
    attackerPool: {
      dice: (opts.attackerDice ?? []).map((d, i) => ({ id: i + 1, value: d.value, state: d.state, rolled: true })),
      nextId: (opts.attackerDice ?? []).length + 1,
    },
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

// ---------------------------------------------------------------------------
describe('HERNKYN YAEGIR data (pinned against data/teams/hernkyn-yaegir.json)', () => {
  it('has 8 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(8);
    const theyn = DATA.datacards.find((c) => c.id === C.theyn)!;
    expect(theyn).toMatchObject({ apl: 2, move: 5, save: 4, wounds: 9, base: { shape: 'round', mm: 28 } });
    expect(theyn.keywords).toEqual(['HERNKYN YAEGIR', 'LEAGUES OF VOTANN', 'LEADER', 'THEYN']);
    for (const card of DATA.datacards.filter((c) => c.id !== C.theyn)) {
      expect(card).toMatchObject({ apl: 2, move: 5, save: 4, wounds: 8, base: { shape: 'round', mm: 28 } });
      expect(card.keywords.slice(0, 2)).toEqual([KW, 'LEAGUES OF VOTANN']);
    }
  });

  it('pins every weapon profile of the THEYN, GUNNER, RIFLEKYN, TRACKER, BLADEKYN and BOMBAST', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')),
        );
    expect(flat(C.theyn)).toEqual([
      'Bolt revolver||ranged|4|3|3|5',
      'Bolt shotgun|short range|ranged|4|3|4|4',
      'Bolt shotgun|long range|ranged|4|5|2|2',
      'Plasma Knife||melee|4|3|3|5',
    ]);
    expect(flat(C.gunner)).toEqual([
      'APM launcher|armour piercing|ranged|5|4|4|5',
      'APM launcher|breaching|ranged|5|4|3|5',
      'APM launcher|high explosive|ranged|5|4|2|4',
      'Fists||melee|3|4|2|3',
    ]);
    expect(flat(C.riflekyn)).toEqual([
      'Magna-coil rifle|concealed|ranged|4|2|3|3',
      'Magna-coil rifle|mobile|ranged|4|3|3|4',
      'Magna-coil rifle|stationary|ranged|4|2|3|3',
      'Fists||melee|3|4|2|3',
    ]);
    expect(flat(C.tracker)).toEqual([
      'SiNR handbow||ranged|4|4|3|5',
      'Throwing hatchet||ranged|4|3|3|5',
      'Hatchet||melee|4|3|4|5',
    ]);
    expect(flat(C.bladekyn)).toEqual([
      'Throwing plasma knife||ranged|4|3|3|5',
      'Dual plasma knives||melee|4|3|3|5',
    ]);
    expect(profileOf(C.bombast, 'Wroughtlock revolvers').rules.map((r) => r.raw)).toEqual([
      'Range 9"',
      'Ceaseless',
      'Lethal 5+',
    ]);
  });

  it('carries the two rare weapon rules on the profiles that print them', () => {
    expect(DATA.rareWeaponRules).toEqual(['Bipod', 'ConcealedPosition']);
    for (const name of ['armour piercing', 'breaching', 'high explosive'])
      expect(profileOf(C.gunner, 'APM launcher', name).rules.map((r) => r.id)).toContain('Bipod');
    expect(profileOf(C.riflekyn, 'Magna-coil rifle', 'concealed').rules.map((r) => r.id)).toContain('ConcealedPosition');
    // "…sits on ONE profile": the mobile and stationary profiles stay legal all battle.
    for (const name of ['mobile', 'stationary'])
      expect(profileOf(C.riflekyn, 'Magna-coil rifle', name).rules.map((r) => r.id)).not.toContain('ConcealedPosition');
  });

  it('exposes 2 faction rules, 4+4 ploys, 4 equipment, 14 abilities and no unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Resourceful', 'Dauntless Explorers']);
    expect(hernkynYaegir.ploys.filter((p) => p.kind === 'strategy').map((p) => p.name)).toEqual([
      'HIDDEN ENGAGEMENT',
      'MASTERFUL BLADEWORK',
      'TOUGH SURVIVALISTS',
      'IN POSITION',
    ]);
    expect(hernkynYaegir.ploys.filter((p) => p.kind === 'firefight').map((p) => p.name)).toEqual([
      'STURDY',
      'BONDS THAT BIND',
      'NO KIN LEFT BEHIND',
      'STALWART DEFENCE',
    ]);
    expect(hernkynYaegir.equipment.map((e) => e.id)).toEqual([
      EQ.plasmaKnives,
      EQ.stabilisedBoltShells,
      EQ.firestormBoltShells,
      EQ.kvCeramideUndersuit,
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(14);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(0);
  });

  it('the printed default roster is legal, and every datacard, ploy and equipment has an AI hint', () => {
    const picks = defaultRoster(hernkynYaegir.data);
    expect(hernkynYaegir.validateRoster(picks).ok).toBe(true);
    // "1 HERNKYN YAEGIR THEYN operative" + "9 HERNKYN YAEGIR operatives selected from the list"
    expect(picks).toHaveLength(10);
    expect(picks[0]!.datacardId).toBe(C.theyn);
    // "Other than WARRIOR operatives, your kill team can only include each operative once."
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['WARRIOR'] }]);
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p.datacardId, (counts.get(p.datacardId) ?? 0) + 1);
    expect(counts.get(C.warrior)).toBe(3);
    for (const card of DATA.datacards) expect(hernkynYaegir.aiHints?.roles?.[card.id]).toBeDefined();
    for (const ploy of hernkynYaegir.ploys) expect(hernkynYaegir.aiHints?.ployValue?.[ploy.id]).toBeGreaterThan(0);
    for (const eq of hernkynYaegir.equipment) expect(hernkynYaegir.aiHints?.equipmentValue?.[eq.id]).toBeGreaterThan(0);
  });

  it('trims the scraper section overrun off IN POSITION and STALWART DEFENCE', () => {
    expect(rule(SP.inPosition)).toContain('cannot be selected as a valid target');
    expect(rule(SP.inPosition)).not.toContain('Firefight Ploys');
    expect(rule(FP.stalwartDefence)).toContain('can perform a free Shoot action');
    expect(rule(FP.stalwartDefence)).not.toContain('Faction Equipment');
  });

  it('resolves both rare weapon rules from this team\'s own printed datacard abilities (D-033)', () => {
    expect(rareRuleTextFor(DATA, 'Bipod')).toBe(ability(C.gunner, A.bipod));
    expect(rareRuleTextFor(DATA, 'ConcealedPosition')).toBe(ability(C.riflekyn, A.concealedPosition));
    // Bipod is printed by no other kill team, so the shared registry entry is this one.
    expect(rareRuleTextFor(DATA, 'Bipod')).toContain('Note this operative isn’t restricted from moving after shooting');
  });

  it('recovers the PLASMA KNIVES weapon rules from the printed WR row (the scraper dropped them)', () => {
    const scraped = (DATA.equipment.find((e) => e.id === EQ.plasmaKnives) as unknown as {
      weapons: { profiles: { rules: unknown[] }[] }[];
    }).weapons[0]!.profiles[0]!;
    expect(scraped.rules).toEqual([]); // the data bug
    expect(rule(EQ.plasmaKnives)).toContain('Lethal 5+');
    expect(PLASMA_KNIFE_WEAPON.profiles[0]!.rules.map((r) => r.raw)).toEqual(['Lethal 5+']);
    expect(PLASMA_KNIFE_WEAPON.profiles[0]).toMatchObject({ atk: 3, hit: 4, dmgN: 3, dmgC: 5, type: 'melee' });
  });
});

// ---------------------------------------------------------------------------
describe('Resourceful — the point economy', () => {
  it('"5+ operatives → 2 Resourceful points, 1-4 → 1", in each Strategy phase after the first', () => {
    expect(rule(RULE.resourceful)).toContain('you gain Resourceful points determined by the number of friendly');
    const big = setup({ picks: [C.bladekyn, C.bombast, C.gunner, C.riflekyn, C.tracker], tp: 2 });
    ready(big.ctx, big.state, 'p1');
    expect(resourcefulPoints(big.state, 'p1')).toBe(2);

    const small = setup({ picks: [C.bladekyn, C.bombast], tp: 2 });
    ready(small.ctx, small.state, 'p1');
    expect(resourcefulPoints(small.state, 'p1')).toBe(1);
  });

  it('"In the Ready step of each Strategy phase AFTER THE FIRST" — nothing is gained in turning point 1', () => {
    const { ctx, state } = setup({ picks: [C.bladekyn, C.bombast], tp: 1 });
    ready(ctx, state, 'p1');
    expect(resourcefulPoints(state, 'p1')).toBe(0);
  });

  it('"…that aren\'t within control range of enemy operatives" — engaged operatives do not count', () => {
    const { ctx, state } = setup({ picks: [C.bladekyn, C.bombast, C.gunner, C.riflekyn, C.tracker], tp: 2 });
    // Push four of the five into an enemy's control range: 1-4 free operatives -> 1 point.
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    foe.pos = { x: 10, y: 10 };
    for (const id of state.teams.p1.operativeIds.slice(0, 4)) state.operatives[id]!.pos = { x: 10.6, y: 10 };
    ready(ctx, state, 'p1');
    expect(resourcefulPoints(state, 'p1')).toBe(1);
  });

  it('THEYN › Veteran Adventurer: "…you gain 1 Resourceful point."', () => {
    expect(ability(C.theyn, A.veteranAdventurer)).toContain('you gain 1 Resourceful point');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], tp: 2 });
    ready(ctx, state, 'p1');
    expect(resourcefulPoints(state, 'p1')).toBe(2); // 1 (1-4 operatives) + 1 (THEYN)

    // "…if this operative is in the killzone and isn't within control range of enemy operatives"
    const engaged = setup({ picks: [C.theyn, C.bladekyn], tp: 2 });
    const theyn = engaged.state.operatives[opWith(engaged.state, 'p1', C.theyn)]!;
    engaged.state.operatives[opWith(engaged.state, 'p2', ENEMY)]!.pos = { x: theyn.pos.x + 0.5, y: theyn.pos.y };
    ready(engaged.ctx, engaged.state, 'p1');
    expect(resourcefulPoints(engaged.state, 'p1')).toBe(1);
  });

  it('"At the end of each turning point, discard your Resourceful points."', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], tp: 2 });
    ready(ctx, state, 'p1');
    expect(resourcefulPoints(state, 'p1')).toBeGreaterThan(0);
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(resourcefulPoints(state, 'p1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Resourceful — spending a point', () => {
  it('"add 1 to that friendly operative\'s APL stat until the end of its activation"', () => {
    expect(rule(RULE.resourceful)).toContain('add 1 to that friendly operative’s APL stat until the end of its activation');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], tp: 2 });
    ready(ctx, state, 'p1');
    const before = resourcefulPoints(state, 'p1');
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    expect(aplOf(ctx, state, op)).toBe(2);
    const s = activate(ctx, state, op.id);
    expect(resourcefulPoints(s, 'p1')).toBe(before - 1);
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(3);
    // "until the end of its activation"
    const done = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(aplOf(ctx, done, done.operatives[op.id]!)).toBe(2);
  });

  it('"When it\'s activated … it regains up to D3+1 lost wounds" — taken when 3 or more are lost', () => {
    expect(rule(RULE.resourceful)).toContain('it regains up to D3+1 lost wounds');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], tp: 2 });
    ready(ctx, state, 'p1');
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    op.wounds = 3; // 5 lost of 8
    const s = activate(ctx, state, op.id);
    const healed = s.operatives[op.id]!;
    expect(healed.wounds).toBeGreaterThanOrEqual(5); // D3+1 is at least 2
    expect(healed.wounds).toBeLessThanOrEqual(7);
    expect(aplOf(ctx, s, healed)).toBe(2); // the point bought wounds, not APL
  });

  it('WARRIOR › Intrepid: "it regains up to 4 instead" and the APL "lasts until the start of its next activation"', () => {
    expect(ability(C.warrior, A.intrepid)).toContain('it regains up to 4 instead');
    const heal = setup({ picks: [C.theyn, C.warrior], tp: 2 });
    ready(heal.ctx, heal.state, 'p1');
    const warrior = heal.state.operatives[opWith(heal.state, 'p1', C.warrior)]!;
    warrior.wounds = 2; // 6 lost
    const s = activate(heal.ctx, heal.state, warrior.id);
    expect(s.operatives[warrior.id]!.wounds).toBe(6); // exactly 4, never a D3+1 roll

    const apl = setup({ picks: [C.theyn, C.warrior], tp: 2 });
    ready(apl.ctx, apl.state, 'p1');
    const w2 = apl.state.operatives[opWith(apl.state, 'p1', C.warrior)]!;
    let s2 = activate(apl.ctx, apl.state, w2.id);
    expect(aplOf(apl.ctx, s2, s2.operatives[w2.id]!)).toBe(3);
    s2 = reduce(s2, { t: 'EndActivation', operativeId: w2.id }, apl.ctx).state;
    // Still +1 after its activation ends — it lasts until the START of its next activation.
    expect(aplOf(apl.ctx, s2, s2.operatives[w2.id]!)).toBe(3);
  });

  it('"if it\'s not within control range of enemy operatives" — an engaged operative spends nothing', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], tp: 2 });
    ready(ctx, state, 'p1');
    const before = resourcefulPoints(state, 'p1');
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    state.operatives[opWith(state, 'p2', ENEMY)]!.pos = { x: op.pos.x + 0.5, y: op.pos.y };
    const s = activate(ctx, state, op.id);
    expect(resourcefulPoints(s, 'p1')).toBe(before);
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2);
  });

  it('"1 of your Resourceful points during EACH activation" — a second activation spends a second point', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn, C.gunner, C.riflekyn, C.tracker], tp: 2 });
    ready(ctx, state, 'p1'); // 5 operatives -> 2 points, +1 from the THEYN's Veteran Adventurer
    expect(resourcefulPoints(state, 'p1')).toBe(3);
    const a = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    const b = state.operatives[opWith(state, 'p1', C.tracker)]!;
    let s = activate(ctx, state, a.id);
    expect(resourcefulPoints(s, 'p1')).toBe(2);
    s = reduce(s, { t: 'EndActivation', operativeId: a.id }, ctx).state;
    s.activePlayer = 'p1';
    s = activate(ctx, s, b.id);
    expect(resourcefulPoints(s, 'p1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Dauntless Explorers', () => {
  it('"STRATEGIC GAMBIT in the first turning point" — offered in TP1 only', () => {
    expect(rule(RULE.dauntlessExplorers)).toContain('STRATEGIC GAMBIT in the first turning point');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], tp: 1 });
    const options = (s: GameState): string[] =>
      ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options.map((o) => o.id);
    expect(options(state)).toContain(RULE.dauntlessExplorers);
    state.turningPoint = 2;
    expect(options(state)).not.toContain(RULE.dauntlessExplorers);
  });

  it('"Each friendly HERNKYN YAEGIR operative wholly within your drop zone can immediately perform a free Reposition action"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn, C.gunner] });
    const inside = state.operatives[opWith(state, 'p1', C.theyn)]!;
    inside.pos = { x: 3, y: 11 }; // drop zone is rect(0,0,6,22)
    const outside = state.operatives[opWith(state, 'p1', C.gunner)]!;
    outside.pos = { x: 12, y: 11 };
    const s = gambit(ctx, state, RULE.dauntlessExplorers);
    const grants = s.effects.filter((e) => e.rule === 'teamFreeAction' && e.player === 'p1');
    expect(grants.map((g) => g.operativeId)).toContain(inside.id);
    expect(grants.map((g) => g.operativeId)).not.toContain(outside.id);
    expect(grants[0]!.data?.['only']).toEqual(['Reposition']);
    // "can immediately perform a FREE Reposition action" — free AP (D-100), so the APL stat is
    // untouched and the operative simply has one more AP than its datacard gives it.
    expect(s.operatives[inside.id]!.aplMods).toEqual([]);
    expect(aplOf(ctx, s, s.operatives[inside.id]!)).toBe(2);
    expect(apBudgetOf(ctx, s, s.operatives[inside.id]!)).toBe(3);
  });

  it('the free-action engine refuses anything but a Reposition once the bonus AP is being spent', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 3, y: 11 };
    const s = gambit(ctx, state, RULE.dauntlessExplorers);
    const op = s.operatives[opWith(s, 'p1', C.bladekyn)]!;
    op.apSpent = 2; // its own 2AP are gone; the bonus AP is next
    const ev = ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Shoot', allowed: true });
    expect(ev.allowed).toBe(false);
    expect(ctx.hooks.emit('canPerformAction', s, { state: s, operative: op, action: 'Reposition', allowed: true }).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('THEYN › Outright Conviction', () => {
  it('"it\'s not incapacitated, has 1 wound remaining" — once during the battle', () => {
    expect(ability(C.theyn, A.outrightConviction)).toContain('it’s not incapacitated, has 1 wound remaining');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const theyn = state.operatives[opWith(state, 'p1', C.theyn)]!;
    inflictDamage(ctx, state, theyn, 99);
    expect(theyn.incapacitated).toBeFalsy();
    expect(theyn.wounds).toBe(1);

    // "The FIRST time this operative would be incapacitated during the battle" — and the shield
    // that follows it only covers the remainder of that action.
    state.effects = state.effects.filter((e) => e.rule !== 'hy.outrightConviction.shield');
    state.sequence = undefined;
    inflictDamage(ctx, state, theyn, 99);
    expect(theyn.incapacitated).toBe(true);
  });

  it('"cannot be incapacitated for the remainder of the action"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const theyn = state.operatives[opWith(state, 'p1', C.theyn)]!;
    inflictDamage(ctx, state, theyn, 99);
    expect(theyn.wounds).toBe(1);
    inflictDamage(ctx, state, theyn, 5); // still inside the same action
    expect(theyn.incapacitated).toBeFalsy();
  });

  it('"All remaining attack dice are discarded (including yours if this operative is fighting or retaliating)"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const theyn = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeFight(state, foe.id, theyn.id, 'Gun butt', {
      attackerDice: [
        { value: 6, state: 'crit' },
        { value: 4, state: 'normal' },
      ],
      defenderDice: [{ value: 5, state: 'normal' }],
    });
    inflictDamage(ctx, state, theyn, 99);
    const seq = state.sequence as { attackerPool: { dice: { state: string }[] }; defenderPool: { dice: { state: string }[] } };
    expect(seq.attackerPool.dice.every((d) => d.state === 'discarded')).toBe(true);
    expect(seq.defenderPool.dice.every((d) => d.state === 'discarded')).toBe(true);
  });

  it('no further attack damage from that same sequence reaches the THEYN', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const theyn = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, theyn.id, 'Hot-shot lasgun');
    inflictDamage(ctx, state, theyn, 99);
    expect(theyn.wounds).toBe(1);
    inflictDamage(ctx, state, theyn, 4, 'attack'); // the discarded dice, landing late
    expect(theyn.wounds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('BLADEKYN', () => {
  it('Stalker: "This operative can perform the Charge action while it has a Conceal order."', () => {
    expect(ability(C.bladekyn, A.stalker)).toContain('can perform the Charge action while it has a Conceal order');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    banish(state, 'p2', [foe.id]);
    op.pos = { x: 8, y: 11 };
    foe.pos = { x: 11, y: 11 };
    const s = activate(ctx, state, op.id, 'conceal');
    const path = { points: [{ x: 10.1, y: 11 }] };
    expect(getAction('Charge')!.check(ctx, s, s.operatives[op.id]!, { path }).reason).toContain('Conceal');
    expect(getAction(STALKER_CHARGE)!.check(ctx, s, s.operatives[op.id]!, { path }).ok).toBe(true);
    // Only a BLADEKYN has it, and it is treated as a Charge for action restrictions.
    expect(getAction(STALKER_CHARGE)!.treatedAs).toBe('Charge');
    expect(getAction(STALKER_CHARGE)!.available!(ctx, s, s.operatives[opWith(s, 'p1', C.theyn)]!)).toBe(false);
  });

  it('Irrepressible Hardiness: "you can strike the enemy operative in that sequence with one of your unresolved successes"', () => {
    expect(ability(C.bladekyn, A.irrepressibleHardiness)).toContain('strike the enemy operative in that sequence');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const before = foe.wounds;
    fakeFight(state, foe.id, op.id, 'Gun butt', {
      defenderWeapon: 'Dual plasma knives',
      defenderDice: [
        { value: 6, state: 'crit' },
        { value: 4, state: 'normal' },
      ],
    });
    inflictDamage(ctx, state, op, 99);
    // The critical success is spent first: Dual plasma knives 3/5.
    expect(before - foe.wounds).toBe(5);
    const seq = state.sequence as { defenderPool: { dice: { state: string }[] } };
    expect(seq.defenderPool.dice[0]!.state).toBe('struck');
  });
});

// ---------------------------------------------------------------------------
describe('BOMBAST', () => {
  it('Wroughtlock Negotiation: "STRATEGIC GAMBIT … a free Shoot action (you can change its order to Engage)"', () => {
    expect(ability(C.bombast, A.wroughtlockNegotiation)).toContain('free Shoot action');
    const { ctx, state } = setup({ picks: [C.theyn, C.bombast] });
    const op = state.operatives[opWith(state, 'p1', C.bombast)]!;
    op.order = 'conceal';
    const s = gambit(ctx, state, A.wroughtlockNegotiation);
    expect(s.operatives[op.id]!.order).toBe('engage');
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === op.id);
    expect(grant?.data?.['only']).toEqual(['Shoot']);
    expect(s.teams.p1.gambitsUsedTP).toContain(A.wroughtlockNegotiation);
  });

  it('Brazen Killer: "if the result is higher than that other enemy operative\'s APL stat, subtract 1 from its APL"', () => {
    expect(ability(C.bombast, A.brazenKiller)).toContain('subtract 1 from its APL stat until the end of its next activation');
    const { ctx, state } = setup({ picks: [C.theyn, C.bombast], seed: 3 });
    const bombast = state.operatives[opWith(state, 'p1', C.bombast)]!;
    const victim = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const other = state.operatives[state.teams.p2.operativeIds[1]!]!;
    banish(state, 'p2', [victim.id, other.id]);
    bombast.pos = { x: 8, y: 11 };
    victim.pos = { x: 14, y: 11 };
    other.pos = { x: 15, y: 11 }; // within 2" of the victim
    fakeShoot(state, bombast.id, victim.id, 'Wroughtlock revolvers');
    inflictDamage(ctx, state, victim, 99);
    // Some D6 beats an APL of 2 or it does not; either way the roll happened for that operative.
    expect(state.rolls.some((r) => r.kind === 'brazen-killer')).toBe(true);
    if (other.aplMods.includes(-1)) expect(aplOf(ctx, state, other)).toBe(1);
  });

  it('Brazen Killer needs the wroughtlock revolvers to be the weapon in that sequence', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bombast] });
    const bombast = state.operatives[opWith(state, 'p1', C.bombast)]!;
    const victim = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const other = state.operatives[state.teams.p2.operativeIds[1]!]!;
    victim.pos = { x: 14, y: 11 };
    other.pos = { x: 15, y: 11 };
    fakeShoot(state, bombast.id, victim.id, 'Fists');
    inflictDamage(ctx, state, victim, 99);
    expect(state.rolls.some((r) => r.kind === 'brazen-killer')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('GUNNER › Bipod (rare weapon rule)', () => {
  const bipodRules = (ctx: ReturnType<typeof teamContext>, state: GameState, op: OperativeState, name: string) =>
    effectiveRules(ctx, state, profileOf(C.gunner, 'APM launcher', name), {
      operative: op,
      weaponName: 'APM launcher',
    }).map((r) => r.id);

  it('"if it hasn\'t moved during the activation … this weapon has the Ceaseless weapon rule"', () => {
    expect(ability(C.gunner, A.bipod)).toContain('this weapon has the Ceaseless weapon rule');
    const { ctx, state } = setup({ picks: [C.theyn, C.gunner] });
    const op = state.operatives[opWith(state, 'p1', C.gunner)]!;
    expect(bipodRules(ctx, state, op, 'armour piercing')).toContain('Ceaseless');
    op.actionsThisActivation = ['Reposition'];
    expect(bipodRules(ctx, state, op, 'armour piercing')).not.toContain('Ceaseless');
  });

  it('"or if it\'s a counteraction" — Ceaseless even after a move', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.gunner] });
    const op = state.operatives[opWith(state, 'p1', C.gunner)]!;
    op.actionsThisActivation = ['Reposition'];
    state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
    expect(bipodRules(ctx, state, op, 'high explosive')).toContain('Ceaseless');
  });

  it('is per-weapon: a profile without the Bipod rule gains nothing', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.gunner] });
    const op = state.operatives[opWith(state, 'p1', C.gunner)]!;
    const rules = effectiveRules(ctx, state, profileOf(C.gunner, 'Fists'), { operative: op, weaponName: 'Fists' });
    expect(rules.map((r) => r.id)).not.toContain('Ceaseless');
  });
});

// ---------------------------------------------------------------------------
describe('IRONBRAEK › Minefield and HY-Pex Mines', () => {
  it('sets up five Minefield markers, three of them HY-Pex mines, honouring the printed distances', () => {
    expect(ability(C.ironbraek, A.minefield)).toContain('You have five Minefield markers for the battle');
    const { ctx, state } = setup({ picks: [C.theyn, C.ironbraek] });
    const op = state.operatives[opWith(state, 'p1', C.ironbraek)]!;
    const s = activate(ctx, state, op.id);
    const markers = minefieldMarkers(s, 'p1');
    expect(markers).toHaveLength(5);
    expect(markers.filter((m) => m.flags['mine'] === true)).toHaveLength(3);
    expect(markers.every((m) => m.flags['flipped'] === false)).toBe(true);
    // "more than 6\" from your opponent's drop zone" (rect(24,0,6,22)) and from each other.
    for (const m of markers) expect(m.pos.x).toBeLessThan(24 - 6);
    for (const a of markers)
      for (const b of markers)
        if (a.id !== b.id) expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThan(6);
    // "more than 2\" from other markers" — the map's three objective markers.
    for (const m of markers)
      for (const o of s.map.objectives) expect(Math.hypot(m.pos.x - o.pos.x, m.pos.y - o.pos.y)).toBeGreaterThan(2);
  });

  it('"inflict 3 damage on that enemy operative and roll one D6: if the result is less than that … Save stat"', () => {
    expect(ability(C.ironbraek, A.hyPexMines)).toContain('inflict 3 damage on that enemy operative');
    const { ctx, state } = setup({ picks: [C.theyn, C.ironbraek] });
    const opId = opWith(state, 'p1', C.ironbraek);
    let s = activate(ctx, state, opId);
    const marker = minefieldMarkers(s, 'p1').find((m) => m.flags['mine'] === true)!;
    const foe = s.operatives[opWith(s, 'p2', ENEMY)]!;
    banish(s, 'p1', [foe.id]);
    banish(s, 'p2', [foe.id]);
    s.operatives[opId]!.pos = { x: 0.6, y: 0.6 };
    foe.pos = { ...marker.pos };
    const before = foe.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: opId }, ctx).state;
    expect(s.markers[marker.id]!.flags['flipped']).toBe(true);
    expect(before - s.operatives[foe.id]!.wounds).toBeGreaterThanOrEqual(3);
    expect(s.rolls.some((r) => r.kind === 'hy-pex')).toBe(true);
    // "Regardless, that marker isn't removed."
    expect(s.markers[marker.id]).toBeDefined();
  });

  it('"If it\'s a blank, there\'s no effect" — and a marker within a friendly operative\'s control range never flips', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.ironbraek] });
    const opId = opWith(state, 'p1', C.ironbraek);
    let s = activate(ctx, state, opId);
    const blank = minefieldMarkers(s, 'p1').find((m) => m.flags['mine'] !== true)!;
    const guarded = minefieldMarkers(s, 'p1').find((m) => m.flags['mine'] === true)!;
    const foe = s.operatives[opWith(s, 'p2', ENEMY)]!;
    const other = s.operatives[s.teams.p2.operativeIds.find((id) => id !== foe.id)!]!;
    banish(s, 'p2', [foe.id, other.id]);
    foe.pos = { ...blank.pos };
    other.pos = { ...guarded.pos };
    // A friendly HERNKYN YAEGIR operative stands on the guarded marker, so it never flips.
    s.operatives[opId]!.pos = { ...guarded.pos };
    const before = foe.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: opId }, ctx).state;
    expect(s.markers[blank.id]!.flags['flipped']).toBe(true);
    expect(s.operatives[foe.id]!.wounds).toBe(before);
    expect(s.markers[guarded.id]!.flags['flipped']).toBe(false);
  });

  it('places nothing until the IRONBRAEK is actually on the board, and nothing at all without one', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.ironbraek] });
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: -100, y: -100 };
    ctx.hooks.emit('onDeploy', state, { state, operative: state.operatives[state.teams.p1.operativeIds[0]!]! });
    expect(minefieldMarkers(state, 'p1')).toHaveLength(0);

    const none = setup({ picks: [C.theyn, C.bladekyn] });
    const s = activate(none.ctx, none.state, opWith(none.state, 'p1', C.bladekyn));
    expect(minefieldMarkers(s, 'p1')).toHaveLength(0);
  });

  it('"you can reset one of your flipped Minefield markers that\'s within its control range"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.ironbraek], tp: 2 });
    const opId = opWith(state, 'p1', C.ironbraek);
    const s = activate(ctx, state, opId);
    const marker = minefieldMarkers(s, 'p1')[0]!;
    marker.flags['flipped'] = true;
    s.operatives[opId]!.pos = { ...marker.pos };
    ready(ctx, s, 'p1');
    expect(s.markers[marker.id]!.flags['flipped']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RIFLEKYN', () => {
  it('Concealed Position: "can only use this weapon the first time it\'s performing the Shoot action"', () => {
    expect(ability(C.riflekyn, A.concealedPosition)).toContain(
      'can only use this weapon the first time it’s performing the Shoot action',
    );
    const { ctx, state } = setup({ picks: [C.theyn, C.riflekyn] });
    const op = state.operatives[opWith(state, 'p1', C.riflekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const gate = (profile: string) =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, foe, 'Magna-coil rifle', profileOf(C.riflekyn, 'Magna-coil rifle', profile)),
        allowed: true,
        dryRun: true,
      });
    expect(gate('concealed').allowed).toBe(true);
    // The operative has now shot once.
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(op, foe, 'Magna-coil rifle', profileOf(C.riflekyn, 'Magna-coil rifle', 'concealed')),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(gate('concealed').allowed).toBe(false);
    // Per PROFILE, not per weapon: the mobile and stationary profiles are untouched.
    expect(gate('mobile').allowed).toBe(true);
    expect(gate('stationary').allowed).toBe(true);
  });

  it('the Shoot action\'s own check refuses the concealed profile, so the AI never commits the intent (D-032)', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.riflekyn] });
    const op = state.operatives[opWith(state, 'p1', C.riflekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    banish(state, 'p2', [foe.id]);
    op.pos = { x: 8, y: 11 };
    foe.pos = { x: 16, y: 11 };
    const s = activate(ctx, state, op.id);
    const params = { weaponName: 'Magna-coil rifle', profileName: 'concealed', targetId: foe.id };
    expect(getAction('Shoot')!.check(ctx, s, s.operatives[op.id]!, params).ok).toBe(true);
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[op.id]!, foe, 'Magna-coil rifle', profileOf(C.riflekyn, 'Magna-coil rifle', 'concealed')),
      count: 4,
      mods: zeroStatMods(),
    });
    const refused = getAction('Shoot')!.check(ctx, s, s.operatives[op.id]!, params);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('Concealed Position');
  });

  it('Weavewërke Cloak: "Ignore the Saturate weapon rule" and "retain one additional cover save"', () => {
    expect(ability(C.riflekyn, A.weavewerkeCloak)).toContain('Ignore the Saturate weapon rule');
    const { ctx, state } = setup({ picks: [C.theyn, C.riflekyn] });
    const op = state.operatives[opWith(state, 'p1', C.riflekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, op.id, 'Hot-shot lasgun', { step: 'rollDefence', inCover: true });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(foe, op, 'Hot-shot lasgun', profileOf(C.riflekyn, 'Fists')),
      count: 3,
      coverSave: false, // Saturate denied the cover save
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.coverSave).toBe(true);
    expect(ev.extraCoverSaves).toBe(1);
  });

  it('"This isn\'t cumulative with improved cover saves from Vantage terrain."', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.riflekyn] });
    const op = state.operatives[opWith(state, 'p1', C.riflekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, op.id, 'Hot-shot lasgun', { step: 'rollDefence', inCover: true, vantageImprovedCover: true });
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(foe, op, 'Hot-shot lasgun', profileOf(C.riflekyn, 'Fists')),
      count: 3,
      coverSave: true,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('TRACKER', () => {
  it('Pan Spectral Visor: Seek Light within 6", and "that operative cannot be obscured"', () => {
    expect(ability(C.tracker, A.panSpectralVisor)).toContain('cannot be obscured');
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker] });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.pos = { x: 10, y: 11 };
    foe.pos = { x: 14, y: 11 };
    const profile = profileOf(C.tracker, 'SiNR handbow');
    const near = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: 'SiNR handbow' });
    expect(near.map((r) => r.id)).toContain('SeekLight');

    fakeShoot(state, op.id, foe.id, 'SiNR handbow', { obscured: true });
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(op, foe, 'SiNR handbow', profile),
      count: 4,
      mods: zeroStatMods(),
    });
    expect((state.sequence as { obscured: boolean }).obscured).toBe(false);

    // "…an operative within 6\" of it" — beyond that, nothing.
    foe.pos = { x: 20, y: 11 };
    const far = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: 'SiNR handbow' });
    expect(far.map((r) => r.id)).not.toContain('SeekLight');
  });

  it('Tracker: "shooting against or fighting against an expended operative within 6" … the Punishing weapon rule"', () => {
    expect(ability(C.tracker, A.tracker)).toContain('this operative’s weapons have the Punishing weapon rule');
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker] });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.pos = { x: 10, y: 11 };
    foe.pos = { x: 14, y: 11 };
    const ranged = () =>
      effectiveRules(ctx, state, profileOf(C.tracker, 'SiNR handbow'), {
        operative: op,
        target: foe,
        weaponName: 'SiNR handbow',
      }).map((r) => r.id);
    expect(ranged()).not.toContain('Punishing');
    foe.expended = true;
    expect(ranged()).toContain('Punishing');
    // "or fighting against" — `onWeaponRules` is read by `fight.ts` too.
    const melee = effectiveRules(ctx, state, profileOf(C.tracker, 'Hatchet'), {
      operative: op,
      target: foe,
      weaponName: 'Hatchet',
    });
    expect(melee.map((r) => r.id)).toContain('Punishing');
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('HIDDEN ENGAGEMENT: "if it\'s in cover from the target\'s perspective … the Balanced weapon rule"', () => {
    expect(rule(SP.hiddenEngagement)).toContain('in cover from the target’s perspective');
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker], map: mapWithHeavy() });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.pos = { x: 14.6, y: 11 }; // touching the Heavy block at x 10..14, y 9..13
    foe.pos = { x: 5, y: 11 };
    const rules = () =>
      effectiveRules(ctx, state, profileOf(C.tracker, 'SiNR handbow'), {
        operative: op,
        target: foe,
        weaponName: 'SiNR handbow',
      }).map((r) => r.id);
    expect(rules()).not.toContain('Balanced');
    state.teams.p1.gambitsUsedTP.push(SP.hiddenEngagement);
    expect(rules()).toContain('Balanced');
  });

  it('MASTERFUL BLADEWORK: "+1 to the Atk stat of its melee weapons (to a maximum of 4)" and Balanced', () => {
    expect(rule(SP.masterfulBladework)).toContain('add 1 to the Atk stat of its melee weapons (to a maximum of 4)');
    const { ctx, state } = setup({ picks: [C.theyn, C.bombast] });
    const op = state.operatives[opWith(state, 'p1', C.bombast)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    state.teams.p1.gambitsUsedTP.push(SP.masterfulBladework);
    fakeFight(state, op.id, foe.id, 'Fists');
    const ev = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(op, foe, 'Fists', profileOf(C.bombast, 'Fists'), 'melee'),
      count: 3,
      mods: zeroStatMods(),
    });
    expect(ev.count).toBe(4); // Fists are Atk 3
    const rules = effectiveRules(ctx, state, profileOf(C.bombast, 'Fists'), { operative: op, weaponName: 'Fists' });
    expect(rules.map((r) => r.id)).toContain('Balanced');
  });

  it('"if the weapon already has that weapon rule, it has the Ceaseless weapon rule instead of Balanced"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn], equipment: [EQ.plasmaKnives] });
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    state.teams.p1.gambitsUsedTP.push(SP.masterfulBladework);
    // Dual plasma knives already print Ceaseless; add Balanced to a weapon that already has it
    // through the PLASMA KNIVES equipment on a THEYN, whose own Plasma Knife is the better one.
    const theyn = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const rules = effectiveRules(ctx, state, profileOf(C.theyn, 'Plasma Knife'), {
      operative: theyn,
      weaponName: 'Plasma Knife',
    }).map((r) => r.id);
    expect(rules).toContain('Balanced'); // from the equipment
    expect(rules).toContain('Ceaseless'); // the ploy upgraded its own grant
    expect(op.id).not.toBe(theyn.id);
  });

  it('MASTERFUL BLADEWORK reaches a retaliating operative only with a Conceal order', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bombast] });
    const op = state.operatives[opWith(state, 'p1', C.bombast)]!;
    state.teams.p1.gambitsUsedTP.push(SP.masterfulBladework);
    const rules = (retaliating: boolean) =>
      ctx.hooks
        .emit('onWeaponRules', state, {
          state,
          operative: op,
          weaponName: 'Fists',
          profile: profileOf(C.bombast, 'Fists'),
          type: 'melee',
          retaliating,
          rules: [],
        })
        .rules.map((r) => r.id);
    op.order = 'engage';
    expect(rules(true)).not.toContain('Balanced');
    op.order = 'conceal';
    expect(rules(true)).toContain('Balanced');
  });

  it('TOUGH SURVIVALISTS: "halve that inflicted damage (rounding up, to a minimum of 2)", once each per turning point', () => {
    expect(rule(SP.toughSurvivalists)).toContain('halve that inflicted damage (rounding up, to a minimum of 2)');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    state.teams.p1.gambitsUsedTP.push(SP.toughSurvivalists);
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    inflictDamage(ctx, state, op, 5, 'attack');
    expect(op.wounds).toBe(5); // 8 - ceil(5/2) = 8 - 3
    inflictDamage(ctx, state, op, 4, 'attack');
    expect(op.wounds).toBe(1); // "the FIRST time … during the turning point" is spent
  });

  it('TOUGH SURVIVALISTS is not spent on damage it could not shrink (minimum 2)', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    state.teams.p1.gambitsUsedTP.push(SP.toughSurvivalists);
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    inflictDamage(ctx, state, op, 2, 'attack'); // halving 2 gives 2 — nothing to save
    expect(op.wounds).toBe(6);
    inflictDamage(ctx, state, op, 6, 'attack');
    expect(op.wounds).toBe(3); // still available: 6 -> 3
  });

  it('IN POSITION: a concealed operative in cover "cannot be selected as a valid target … except being within 2""', () => {
    expect(rule(SP.inPosition)).toContain('taking precedence over all other rules');
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker], map: mapWithHeavy() });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.order = 'conceal';
    op.pos = { x: 9.4, y: 11 };
    foe.pos = { x: 20, y: 11 };
    state.teams.p1.gambitsUsedTP.push(SP.inPosition);
    const check = (): boolean =>
      ctx.hooks.emit('onValidTarget', state, {
        state,
        attacker: foe,
        target: op,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid;
    expect(check()).toBe(false);
    foe.pos = { x: 10.5, y: 11 }; // "…except being within 2""
    expect(check()).toBe(true);
  });

  it('IN POSITION takes "precedence over all other rules (e.g. Seek, Vantage terrain)"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker], map: mapWithHeavy() });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.order = 'conceal';
    op.pos = { x: 9.4, y: 11 };
    foe.pos = { x: 20, y: 11 };
    state.teams.p1.gambitsUsedTP.push(SP.inPosition);
    // A Seek weapon arrives with `ignoreCoverTerrain: 'all'`; the ploy recomputes cover with the
    // DEFAULT options, so the operative still cannot be selected.
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: foe,
      target: op,
      valid: true,
      ignoreCoverTerrain: 'all',
      forceVisible: true,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('STURDY: "Change the attacker\'s retained critical successes to normal successes."', () => {
    expect(rule(FP.sturdy)).toContain('Change the attacker’s retained critical successes to normal successes');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, op.id, 'Hot-shot lasgun', {
      step: 'retention',
      dice: [
        { value: 6, state: 'crit' },
        { value: 6, state: 'crit' },
        { value: 4, state: 'normal' },
      ],
    });
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.sturdy }, ctx).state;
    const dice = (s.sequence as { attack: { dice: { state: string }[] } }).attack.dice;
    expect(dice.filter((d) => d.state === 'crit')).toHaveLength(0);
    expect(dice.filter((d) => d.state === 'normal')).toHaveLength(3);
  });

  it('STURDY cannot be used once the defence dice have been collected', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, op.id, 'Hot-shot lasgun', { dice: [{ value: 6, state: 'crit' }] });
    (state.sequence as { defence: { dice: unknown[] } }).defence.dice.push({ id: 1, value: 4, state: 'normal', rolled: true });
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.sturdy }, ctx);
    expect(out.ok).toBe(false);
  });

  it('BONDS THAT BIND records the pairing, and refuses a BOMBAST that has used Wroughtlock Negotiation', () => {
    expect(rule(FP.bondsThatBind)).toContain('you can activate that other friendly operative before your opponent activates');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn, C.bombast] });
    const first = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const partner = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    const bombast = state.operatives[opWith(state, 'p1', C.bombast)]!;
    first.pos = { x: 8, y: 11 };
    partner.pos = { x: 9.5, y: 11 };
    bombast.pos = { x: 9.6, y: 11 };
    let s = activate(ctx, state, first.id);
    s.teams.p1.gambitsUsedTP.push(A.wroughtlockNegotiation);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.bondsThatBind, data: { operativeId: bombast.id } }, ctx).state;
    const eff = s.effects.find((e) => e.rule === 'hy.bondsThatBind');
    expect(eff).toBeDefined();
    // The BOMBAST is excluded, so the deterministic default lands on the BLADEKYN.
    expect(eff!.operativeId).toBe(partner.id);
  });

  it('NO KIN LEFT BEHIND places the Fallen Kin marker within the incapacitated operative\'s control range', () => {
    expect(rule(FP.noKinLeftBehind)).toContain('place it within that operative’s control range');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    const op = state.operatives[opWith(state, 'p1', C.bladekyn)]!;
    op.pos = { x: 12, y: 7 };
    op.incapacitated = true;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: FP.noKinLeftBehind }, ctx).state;
    const marker = s.markers[FALLEN_KIN_MARKER('p1')];
    expect(marker).toBeDefined();
    expect(marker!.pos).toEqual({ x: 12, y: 7 });
  });

  it('"…you can retain one of your fails as a normal success instead of discarding it" (shooting)', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker] });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.pos = { x: 12, y: 7 };
    state.markers[FALLEN_KIN_MARKER('p1')] = {
      id: FALLEN_KIN_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 12.5, y: 7 },
      z: 0,
      owner: 'p1',
      flags: { fallenKin: true },
    };
    const profile = profileOf(C.tracker, 'SiNR handbow'); // 3/5 — a fail is worth 3, a crit +2
    fakeShoot(state, op.id, foe.id, 'SiNR handbow', {
      dice: [
        { value: 5, state: 'normal' },
        { value: 2, state: 'fail' },
      ],
    });
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(op, foe, 'SiNR handbow', profile),
      dice: [],
      rerolls: [],
    });
    const dice = (state.sequence as { attack: { dice: { state: string }[] } }).attack.dice;
    expect(dice.filter((d) => d.state === 'normal')).toHaveLength(2);
    expect(dice.filter((d) => d.state === 'fail')).toHaveLength(0);
  });

  it('"…or retain one of your normal successes as a critical success instead" when that is worth more', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker] });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.pos = { x: 12, y: 7 };
    state.markers[FALLEN_KIN_MARKER('p1')] = {
      id: FALLEN_KIN_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 12.5, y: 7 },
      z: 0,
      owner: 'p1',
      flags: { fallenKin: true },
    };
    // 2/9 is not a printed profile — it is built here only to make the crit branch strictly
    // better than the fail branch, which is the deterministic tie-break the module states.
    const profile: WeaponProfile = { type: 'ranged', atk: 4, hit: 3, dmgN: 2, dmgC: 9, rules: [] };
    fakeShoot(state, op.id, foe.id, 'SiNR handbow', {
      dice: [
        { value: 5, state: 'normal' },
        { value: 2, state: 'fail' },
      ],
    });
    ctx.hooks.emit('onRollAttack', state, { state, ctx: attackCtx(op, foe, 'SiNR handbow', profile), dice: [], rerolls: [] });
    const dice = (state.sequence as { attack: { dice: { state: string }[] } }).attack.dice;
    expect(dice.filter((d) => d.state === 'crit')).toHaveLength(1);
    expect(dice.filter((d) => d.state === 'fail')).toHaveLength(1);
  });

  it('the Fallen Kin aura only reaches operatives within 3" of the marker', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker] });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    op.pos = { x: 12, y: 7 };
    state.markers[FALLEN_KIN_MARKER('p1')] = {
      id: FALLEN_KIN_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 20, y: 7 },
      z: 0,
      owner: 'p1',
      flags: { fallenKin: true },
    };
    fakeShoot(state, op.id, foe.id, 'SiNR handbow', { dice: [{ value: 2, state: 'fail' }] });
    ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(op, foe, 'SiNR handbow', profileOf(C.tracker, 'SiNR handbow')),
      dice: [],
      rerolls: [],
    });
    expect((state.sequence as { attack: { dice: { state: string }[] } }).attack.dice[0]!.state).toBe('fail');
  });

  it('STALWART DEFENCE grants the free Shoot and locks the target to that enemy operative', () => {
    expect(rule(FP.stalwartDefence)).toContain('You cannot select any other enemy operative as a valid target');
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker, C.gunner] });
    const anchor = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const shooter = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const enemy = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const other = state.operatives[state.teams.p2.operativeIds[1]!]!;
    banish(state, 'p1', [anchor.id, shooter.id]);
    banish(state, 'p2', [enemy.id, other.id]);
    anchor.pos = { x: 10, y: 11 };
    enemy.pos = { x: 10.6, y: 11 };
    shooter.pos = { x: 13, y: 11 };
    other.pos = { x: 20, y: 11 };
    let s = activate(ctx, state, enemy.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.stalwartDefence }, ctx).state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === shooter.id);
    expect(grant?.data?.['only']).toEqual(['Shoot']);
    const lockOn = s.operatives[shooter.id]!;
    lockOn.apSpent = 2; // spending the bonus AP
    const valid = (target: OperativeState): boolean =>
      ctx.hooks.emit('onValidTarget', s, {
        state: s,
        attacker: lockOn,
        target,
        valid: true,
        ignoreCoverTerrain: 'none',
        forceVisible: false,
        ignoreFriendlyControlRange: false,
      }).valid;
    expect(valid(s.operatives[enemy.id]!)).toBe(true);
    expect(valid(s.operatives[other.id]!)).toBe(false);
    // "It can target that enemy operative even though it's within control range of a friendly."
    const ev = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: lockOn,
      target: s.operatives[enemy.id]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.ignoreFriendlyControlRange).toBe(true);
  });

  it('STALWART DEFENCE refuses a Blast or x" Devastating x weapon for that free Shoot', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.gunner] });
    const anchor = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const shooter = state.operatives[opWith(state, 'p1', C.gunner)]!;
    const enemy = state.operatives[opWith(state, 'p2', ENEMY)]!;
    banish(state, 'p2', [enemy.id]);
    anchor.pos = { x: 10, y: 11 };
    enemy.pos = { x: 10.6, y: 11 };
    shooter.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, enemy.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.stalwartDefence }, ctx).state;
    const op = s.operatives[shooter.id]!;
    op.apSpent = 2;
    const gate = (profileName: string) =>
      ctx.hooks.emit('onSelectWeapon', s, {
        state: s,
        ctx: attackCtx(op, s.operatives[enemy.id]!, 'APM launcher', profileOf(C.gunner, 'APM launcher', profileName)),
        allowed: true,
        dryRun: true,
      });
    expect(gate('breaching').allowed).toBe(false); // Blast 2"
    expect(gate('armour piercing').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('PLASMA KNIVES grants the printed melee weapon to operatives that do not already carry one', () => {
    expect(rule(EQ.plasmaKnives)).toContain('Friendly HERNKYN YAEGIR operatives have the following melee weapon');
    const { ctx, state } = setup({ picks: [C.theyn, C.gunner], equipment: [EQ.plasmaKnives] });
    const gunner = state.operatives[opWith(state, 'p1', C.gunner)]!;
    const names = ctx.hooks
      .emit('availableWeapons', state, { state, operative: gunner, weapons: [] })
      .weapons;
    void names;
    const granted = (gunner as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(granted.map((w) => w.name)).toContain('Plasma Knife');
  });

  it('"…some operatives already have this weapon but with better stats; use the better version, and that weapon has the Balanced weapon rule"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.gunner], equipment: [EQ.plasmaKnives] });
    const theyn = state.operatives[opWith(state, 'p1', C.theyn)]!;
    ctx.hooks.emit('availableWeapons', state, { state, operative: theyn, weapons: [] });
    const granted = (theyn as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(granted).toHaveLength(0); // it keeps its own Atk 4 / Hit 3+ version
    const rules = effectiveRules(ctx, state, profileOf(C.theyn, 'Plasma Knife'), {
      operative: theyn,
      weaponName: 'Plasma Knife',
    });
    expect(rules.map((r) => r.id)).toContain('Balanced');
  });

  it('STABILISED BOLT SHELLS: "improve the Hit stat of that weapon by 1 and add 1 to both of its Dmg stats", twice per TP', () => {
    expect(rule(EQ.stabilisedBoltShells)).toContain('Up to twice per turning point');
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.stabilisedBoltShells] });
    const op = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const profile = profileOf(C.theyn, 'Bolt shotgun', 'long range'); // Hit 5+, 2/2
    const arm = (): void => {
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, foe, 'Bolt shotgun', profile),
        allowed: true,
        dryRun: false,
      });
    };
    arm();
    fakeShoot(state, op.id, foe.id, 'Bolt shotgun', {
      profileName: 'long range',
      dice: [
        { value: 5, state: 'normal' },
        { value: 6, state: 'crit' },
      ],
    });
    expect(hitOf(ctx, state, op, profile)).toBe(4); // 5+ improved by 1
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: foe, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(6); // +1 per unblocked attack dice (D-019)
  });

  it('STABILISED BOLT SHELLS is limited to two uses per turning point and to the long range profile', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.stabilisedBoltShells] });
    const op = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const arm = (profileName: string): boolean => {
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: attackCtx(op, foe, 'Bolt shotgun', profileOf(C.theyn, 'Bolt shotgun', profileName)),
        allowed: true,
        dryRun: false,
      });
      fakeShoot(state, op.id, foe.id, 'Bolt shotgun', { profileName });
      return hitOf(ctx, state, op, profileOf(C.theyn, 'Bolt shotgun', profileName)) < profileOf(C.theyn, 'Bolt shotgun', profileName).hit;
    };
    expect(arm('short range')).toBe(false); // wrong profile
    expect(arm('long range')).toBe(true);
    expect(arm('long range')).toBe(true);
    expect(arm('long range')).toBe(false); // "Up to twice per turning point"
  });

  it('a dry run never claims a use (D-032: the Shoot action\'s check must not mutate)', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.stabilisedBoltShells] });
    const op = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const profile = profileOf(C.theyn, 'Bolt shotgun', 'long range');
    for (let i = 0; i < 5; i++)
      ctx.hooks.emit('onSelectWeapon', state, { state, ctx: attackCtx(op, foe, 'Bolt shotgun', profile), allowed: true, dryRun: true });
    fakeShoot(state, op.id, foe.id, 'Bolt shotgun', { profileName: 'long range' });
    expect(hitOf(ctx, state, op, profile)).toBe(5); // nothing was armed
  });

  it('FIRESTORM BOLT SHELLS: "that weapon has the Blast 1" weapon rule", once per turning point', () => {
    expect(rule(EQ.firestormBoltShells)).toContain('Once per turning point');
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.firestormBoltShells] });
    const op = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const profile = profileOf(C.theyn, 'Bolt shotgun', 'short range');
    ctx.hooks.emit('onSelectWeapon', state, { state, ctx: attackCtx(op, foe, 'Bolt shotgun', profile), allowed: true, dryRun: false });
    const rules = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: 'Bolt shotgun' });
    expect(rules.some((r) => r.id === 'Blast' && r.x === 1)).toBe(true);
    // A second selection in the same turning point finds no allowance left and disarms.
    ctx.hooks.emit('onSelectWeapon', state, { state, ctx: attackCtx(op, foe, 'Bolt shotgun', profile), allowed: true, dryRun: false });
    const again = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: 'Bolt shotgun' });
    expect(again.some((r) => r.id === 'Blast')).toBe(false);
  });

  it('FIRESTORM BOLT SHELLS queues the Blast 1" secondary targets `startShoot` could not see', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.firestormBoltShells] });
    const op = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    const near = state.operatives[state.teams.p2.operativeIds[1]!]!;
    banish(state, 'p2', [foe.id, near.id]);
    op.pos = { x: 8, y: 11 };
    foe.pos = { x: 15, y: 11 };
    near.pos = { x: 16, y: 11 }; // within 1" of the primary target
    const profile = profileOf(C.theyn, 'Bolt shotgun', 'short range');
    ctx.hooks.emit('onSelectWeapon', state, { state, ctx: attackCtx(op, foe, 'Bolt shotgun', profile), allowed: true, dryRun: false });
    fakeShoot(state, op.id, foe.id, 'Bolt shotgun', { profileName: 'short range', step: 'rollAttack' });
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(op, foe, 'Bolt shotgun', profile),
      count: 4,
      mods: zeroStatMods(),
    });
    expect((state.sequence as { queue: string[] }).queue).toEqual([near.id]);
  });

  it('KV-CERAMIDE UNDERSUIT: "you can re-roll one of your defence dice" against a Blast or Torrent weapon', () => {
    expect(rule(EQ.kvCeramideUndersuit)).toContain('you can re-roll one of your defence dice');
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.kvCeramideUndersuit] });
    const op = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, op.id, 'Frag grenade', { step: 'defenceRerolls' });
    const blast = { ...profileOf(C.theyn, 'Bolt shotgun', 'short range'), rules: [{ id: 'Blast' as const, x: 2, raw: 'Blast 2"' }] };
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(foe, op, 'Frag grenade', blast),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.rerolls.map((r) => r.id)).toContain('hy.undersuit');
  });

  it('"…aren\'t affected by the x" Devastating x weapon rule unless they are the target during that sequence"', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.warrior], equipment: [EQ.kvCeramideUndersuit] });
    const target = state.operatives[opWith(state, 'p1', C.theyn)]!;
    const bystander = state.operatives[opWith(state, 'p1', C.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    fakeShoot(state, foe.id, target.id, 'Magna-coil rifle');
    const dev = (op: OperativeState): number =>
      ctx.hooks.emit('onDamage', state, { state, ctx: null, target: op, amount: 3, kind: 'devastating' }).amount;
    expect(dev(target)).toBe(3); // it IS the target
    expect(dev(bystander)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('The kill team plays', () => {
  it('a HERNKYN YAEGIR operative can Shoot, and no intent is rejected on the way', () => {
    const { ctx, state } = setup({ picks: [C.theyn, C.tracker] });
    const op = state.operatives[opWith(state, 'p1', C.tracker)]!;
    const foe = state.operatives[opWith(state, 'p2', ENEMY)]!;
    banish(state, 'p2', [foe.id]);
    op.pos = { x: 8, y: 11 };
    foe.pos = { x: 12, y: 11 };
    const s = activate(ctx, state, op.id);
    const out = act(ctx, s, op.id, 'Shoot', { weaponName: 'SiNR handbow', targetId: foe.id });
    expect(out.ok).toBe(true);
    expect(out.state.rejected).toHaveLength(0);
    expect(out.state.sequence?.kind).toBe('shoot');
  });

  it('Dauntless Explorers’ free AP is a third AP to spend, and it expires with the activation', () => {
    expect(rule(RULE.dauntlessExplorers)).toContain('can immediately perform a free Reposition action');
    const { ctx, state } = setup({ picks: [C.theyn, C.bladekyn] });
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 3, y: 11 };
    let s = gambit(ctx, state, RULE.dauntlessExplorers);
    const op = s.operatives[opWith(s, 'p1', C.bladekyn)]!;
    // "can immediately perform a free Reposition action": AP, not APL. Nothing is written to
    // `aplMods`, so nothing can be left behind there either.
    expect(op.aplMods).toEqual([]);
    expect(freeApOf(s, op)).toBe(1);
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    s.activePlayer = 'p1';
    s = activate(ctx, s, op.id);
    expect(apBudgetOf(ctx, s, s.operatives[op.id]!)).toBe(3);
    // Its own 2AP gone, the free Reposition still passes the reducer's AP gate.
    s.operatives[op.id]!.apSpent = 2;
    const moved = act(ctx, s, op.id, 'Reposition', { path: { points: [{ x: 5, y: 11 }] } });
    expect(moved.ok).toBe(true);
    s = moved.state;
    expect(s.operatives[op.id]!.apSpent).toBe(3);
    // "Immediately", during that turning point's activation — and then it is gone.
    s = reduce(s, { t: 'EndActivation', operativeId: op.id }, ctx).state;
    expect(freeApOf(s, s.operatives[op.id]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[op.id]!)).toBe(2);
    expect(aplOf(ctx, s, s.operatives[op.id]!)).toBe(2);
  });
});
