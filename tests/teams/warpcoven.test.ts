/**
 * WARPCOVEN — Thousand Sons. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/warpcoven/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions } from '../../src/core/actions.ts';
import { HookRegistry } from '../../src/core/hooks.ts';
import { counteractCandidates, whoActivates } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aplOf, hitOf, inflictDamage, markerController, moveOf, saveOf } from '../../src/core/state.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor, type RosterPickIn } from '../../src/teams/selection.ts';
import {
  BOONS,
  BOON_NAME,
  BOON_TEXT,
  ASTARTES_FIGHT,
  ASTARTES_SHOOT,
  CAPRICIOUS_DASH,
  FLIGHT_REPOSITION,
  MUTANT_PICK_UP,
  SAVAGE_BRUTALITY_FIGHT,
  boonOf,
  setBoon,
  warpcoven,
} from '../../src/teams/warpcoven/index.ts';
import { activate, battle, opWith, settle, teamContext } from './harness.ts';

const DATA = teamData('warpcoven');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const card = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const ability = (cardId: string, abilityId: string): string =>
  card(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string): string =>
  card(cardId).uniqueActions.find((a) => a.id === actionId)!.text;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = card(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

const DESTINY = 'warpcoven.sorcerer-of-destiny';
const TEMPYRION = 'warpcoven.sorcerer-of-tempyrion';
const WARPFIRE = 'warpcoven.sorcerer-of-warpfire';
const GUNNER = 'warpcoven.rubric-marine-gunner';
const RUBRIC_ICON = 'warpcoven.rubric-marine-icon-bearer';
const RUBRIC_WARRIOR = 'warpcoven.rubric-marine-warrior';
const CHAMPION = 'warpcoven.tzaangor-champion';
const HORN = 'warpcoven.tzaangor-horn-bearer';
const TZ_ICON = 'warpcoven.tzaangor-icon-bearer';
const TZ_WARRIOR = 'warpcoven.tzaangor-warrior';

type Spec = string | [string, string];
const picks = (...specs: Spec[]): RosterPickIn[] =>
  specs.map((s) => (typeof s === 'string' ? { datacardId: s } : { datacardId: s[0], loadoutIds: [s[1]] }));

/** Sorcerers + rubricae (the printed default roster). */
const SORCERERS: Spec[] = [DESTINY, TEMPYRION, WARPFIRE, RUBRIC_WARRIOR, RUBRIC_ICON];
/**
 * The Tzaangor half of the list. NOT a legal kill team — the printed ^3 footnote caps the
 * half-selection group at one selection, so a real roster can only field two TZAANGOR. This is
 * a rule-test fixture whose only job is to put those four datacards on the table; the shared
 * `tests/teams/selection.test.ts` pins the legal rosters.
 */
const HERD: Spec[] = [DESTINY, CHAMPION, HORN, TZ_ICON, [TZ_WARRIOR, 'warpcoven.g1e10.opt2']];

function setup(
  opts: { p1?: Spec[]; p2?: Spec[]; equipment?: string[]; seed?: number; script?: number[] } = {},
): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([warpcoven], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const state = battle({
    ctx,
    p1: { module: warpcoven, picks: picks(...(opts.p1 ?? SORCERERS)), ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: warpcoven, picks: picks(...(opts.p2 ?? SORCERERS)) },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
  return { ctx, state };
}

const op = (state: GameState, player: 'p1' | 'p2', cardId: string): OperativeState =>
  state.operatives[opWith(state, player, cardId)]!;

/** A shoot sequence parked at Resolve Attack Dice, so `onDamage` sees the retained dice. */
function fakeShoot(
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  weaponName: string,
  dice: ('crit' | 'normal')[],
): void {
  state.sequence = {
    kind: 'shoot',
    step: 'resolve',
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
    attack: { dice: dice.map((s, i) => ({ id: i + 1, value: s === 'crit' ? 6 : 4, state: s, rolled: true })), nextId: dice.length + 1 },
    defence: { dice: [], nextId: 1 },
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: attacker.player,
    defender: target.player,
    free: false,
  };
}

/** A fight sequence in its Resolve step, for the per-strike damage rules. */
function fakeFight(state: GameState, attacker: OperativeState, defender: OperativeState, weaponName: string): void {
  state.sequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerWeapon: weaponName,
    defenderCanRetaliate: false,
    attackerPool: { dice: [], nextId: 1 },
    defenderPool: { dice: [], nextId: 1 },
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
  };
}

// ---------------------------------------------------------------------------
describe('WARPCOVEN data (pinned against data/teams/warpcoven.json)', () => {
  it('has 10 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(10);
    for (const id of [DESTINY, TEMPYRION, WARPFIRE])
      expect(card(id)).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 15, base: { shape: 'round', mm: 32 } });
    for (const id of [GUNNER, RUBRIC_ICON, RUBRIC_WARRIOR])
      expect(card(id)).toMatchObject({ apl: 3, move: 5, save: 2, wounds: 14, base: { shape: 'round', mm: 32 } });
    expect(card(CHAMPION)).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 10 });
    for (const id of [HORN, TZ_ICON, TZ_WARRIOR])
      expect(card(id)).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 9 });
    expect(card(WARPFIRE).keywords).toEqual([
      'WARPCOVEN',
      'CHAOS',
      'HERETIC ASTARTES',
      'PSYKER',
      'SORCERER',
      'WARPFIRE',
    ]);
    expect(card(TZ_WARRIOR).keywords).toEqual(['WARPCOVEN', 'CHAOS', 'TZAANGOR', 'WARRIOR']);
    // notes[]: "no datacard in this team carries the LEADER keyword".
    expect(DATA.datacards.some((c) => c.keywords.includes('LEADER'))).toBe(false);
    expect(DATA.selection.leader.count).toBe(0);
  });

  it('pins every weapon profile of the SORCERER WARPFIRE and the RUBRIC MARINE GUNNER', () => {
    const flat = (id: string) =>
      card(id).weapons.flatMap((w) =>
        w.profiles.map((p) =>
          [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
        ),
      );
    expect(flat(WARPFIRE)).toEqual([
      'Firestorm||ranged|5|4|2|3|PSYCHIC+Saturate+Seek Light+Torrent 2"',
      'Inferno bolt pistol||ranged|4|3|3|4|Range 8"+Piercing 1',
      'Mindburn||ranged|5|4|1|1|PSYCHIC+Lethal 5++Saturate+Seek Light+Mindburn*',
      'Warpflame pistol||ranged|4|2|3|3|Range 6"+Piercing 1+Torrent 1"',
      'Force stave||melee|4|3|4|6|PSYCHIC+Shock',
      'Prosperine khopesh||melee|5|3|4|6|Lethal 5+',
    ]);
    expect(flat(GUNNER)).toEqual([
      'Soulreaper cannon|focused|ranged|5|3|4|5|Piercing 1',
      'Soulreaper cannon|sweeping|ranged|4|3|4|5|Piercing 1+Torrent 1"',
      'Warpflamer||ranged|4|2|4|4|Range 8"+Saturate+Piercing 1+Torrent 2"',
      'Fists||melee|3|3|3|4|',
    ]);
    expect(profileOf(TZ_WARRIOR, 'Tzaangor blade & shield').rules.map((r) => r.id)).toContain('Shield');
    expect(profileOf(DESTINY, 'Doombolt').rules.map((r) => r.raw)).toEqual(['PSYCHIC', 'Devastating 2', 'Lethal 5+']);
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 6 unique actions, 11 abilities and 3 rare rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Boons of Tzeentch', 'Astartes']);
    expect(warpcoven.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(warpcoven.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(warpcoven.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'PROTECTED BY FATE',
      'RAVAGE DESTINY',
      'RECONSTITUTION RITUAL',
      'TEMPORAL FLUX',
      'ALIGHT',
      'BRAYHORN',
    ]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(11);
    expect(DATA.rareWeaponRules).toEqual(['Mindburn', 'PSYCHIC', 'Shield']);
  });

  it('the printed selection requirements: a custom SORCERER constraint, two maxItem caps and a half-selection group', () => {
    const kinds = DATA.selection.constraints.map((c) => c.kind);
    expect(kinds).toEqual(['custom', 'uniqueExcept', 'maxItem', 'maxItem', 'halfSelection']);
    expect(DATA.selection.constraints[0]).toMatchObject({
      text: 'You must select at least one friendly SORCERER operative.',
    });
    expect(
      DATA.selection.constraints
        .filter((c) => c.kind === 'maxItem')
        .map((c) => (c as unknown as { item: string }).item),
    ).toEqual([
      'warpflame pistol',
      'soulreaper cannon',
    ]);
    // "These operatives count as half a selection each…" — the Tzaangor footnote group.
    expect(DATA.selection.constraints[4]).toMatchObject({ kind: 'halfSelection', group: '^3', max: 1 });
    // `defaultRoster` produces a legal 5-operative kill team that already includes a SORCERER.
    const roster = defaultRoster(DATA);
    expect(validateRosterFor(DATA, roster).ok).toBe(true);
    expect(roster.some((p) => card(p.datacardId).keywords.includes('SORCERER'))).toBe(true);
    // footnote ^1 resolved: every SORCERER carries a force stave and its PSYCHIC weapons.
    const sorcererWeapons = validateRosterFor(DATA, picks(DESTINY)).weapons[0]!;
    expect(sorcererWeapons).toContain('Force stave');
    expect(sorcererWeapons).toContain('Doombolt');
  });
});

// ---------------------------------------------------------------------------
describe('Boons of Tzeentch — "you must select a BOON OF TZEENTCH (below) for it to have for the battle"', () => {
  it('slices all nine printed boons out of the one faction rule', () => {
    expect(BOONS).toHaveLength(9);
    for (const boon of BOONS) expect(BOON_TEXT[boon].length).toBeGreaterThan(20);
    expect(BOON_TEXT['time-walk']).toBe('Add 1" to this operative’s Move stat.');
    expect(BOON_TEXT['twist-of-fate']).toContain('PSYCHIC ranged weapons have the Piercing Crits 1 weapon rule');
    expect(text('warpcoven.rule.boons-of-tzeentch')).toContain(
      'You cannot select each BOON OF TZEENTCH more than once per battle',
    );
    for (const boon of BOONS) expect(text('warpcoven.rule.boons-of-tzeentch')).toContain(BOON_NAME[boon]);
  });

  it('"You cannot select each BOON OF TZEENTCH more than once per battle" and only SORCERERs have one', () => {
    const { state } = setup();
    const a = op(state, 'p1', DESTINY);
    const b = op(state, 'p1', TEMPYRION);
    expect(setBoon(state, a.id, 'time-walk').ok).toBe(true);
    expect(setBoon(state, b.id, 'time-walk')).toMatchObject({ ok: false });
    expect(setBoon(state, b.id, 'warp-swell').ok).toBe(true);
    expect(setBoon(state, op(state, 'p1', RUBRIC_WARRIOR).id, 'time-walk')).toMatchObject({ ok: false });
    expect(boonOf(state, a)).toBe('time-walk');
  });

  it('Incorporeal Sight: "ranged weapons have the Saturate weapon rule… enemy operatives cannot be obscured"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    const doombolt = profileOf(DESTINY, 'Doombolt');
    expect(
      effectiveRules(ctx, state, doombolt, { operative: sorcerer, target, weaponName: 'Doombolt' }).some(
        (r) => r.id === 'Saturate',
      ),
    ).toBe(false);
    setBoon(state, sorcerer.id, 'incorporeal-sight');
    expect(
      effectiveRules(ctx, state, doombolt, { operative: sorcerer, target, weaponName: 'Doombolt' }).some(
        (r) => r.id === 'Saturate',
      ),
    ).toBe(true);
    fakeShoot(state, sorcerer, target, 'Doombolt', ['normal']);
    (state.sequence as { obscured: boolean }).obscured = true;
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: {
        attacker: sorcerer,
        defender: target,
        weaponName: 'Doombolt',
        profile: doombolt,
        rules: doombolt.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: true,
        vantageAccurate: 0,
        distance: 5,
      },
      count: doombolt.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect((state.sequence as { obscured: boolean }).obscured).toBe(false);
  });

  it('Time-Walk: "Add 1\\" to this operative’s Move stat"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    expect(moveOf(ctx, state, sorcerer)).toBe(6);
    setBoon(state, sorcerer.id, 'time-walk');
    expect(moveOf(ctx, state, sorcerer)).toBe(7);
  });

  it('Warp Swell: "Add 1 to the Normal Dmg stat of this operative’s melee weapons"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const victim = op(state, 'p2', RUBRIC_WARRIOR);
    setBoon(state, sorcerer.id, 'warp-swell');
    fakeFight(state, sorcerer, victim, 'Force stave');
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, profileOf(DESTINY, 'Force stave').dmgN, 'attack');
    expect(before - victim.wounds).toBe(5); // 4 Normal Dmg + 1
    // A critical strike (6 Critical Dmg) is untouched.
    const mid = victim.wounds;
    inflictDamage(ctx, state, victim, profileOf(DESTINY, 'Force stave').dmgC, 'attack');
    expect(mid - victim.wounds).toBe(6);
  });

  it('Mutant Appendage: Pick Up Marker while engaged, and one such action for 1 less AP per activation', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    sorcerer.pos = { x: 10, y: 11 };
    enemy.pos = { x: 8.2, y: 11 };
    state.markers['relic'] = {
      id: 'relic',
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 10.9, y: 11 },
      z: 0,
      flags: { pickUpAllowed: true },
    };
    expect(markerController(ctx, state, state.markers['relic']!)).toBe('p1');
    setBoon(state, sorcerer.id, 'mutant-appendage');
    const s = activate(ctx, state, sorcerer.id);
    const universal = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'Pick Up Marker', params: { markerId: 'relic' } }, ctx);
    expect(universal.ok).toBe(false);
    expect(universal.reason).toMatch(/control range of an enemy operative/);
    // "Once per activation, this operative can perform … for 1 less AP."
    expect(actionCost(ctx, s, s.operatives[sorcerer.id]!, availableActions(ctx, s, s.operatives[sorcerer.id]!).find((a) => a.def.id === MUTANT_PICK_UP)!.def)).toBe(0);
    const out = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: MUTANT_PICK_UP, params: { markerId: 'relic' } }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[sorcerer.id]!.carryingMarkerId).toBe('relic');
    expect(out.state.operatives[sorcerer.id]!.apSpent).toBe(0);
  });

  it('Twist of Fate and Astral Bombardment change only this operative’s PSYCHIC ranged weapons', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    const doombolt = profileOf(DESTINY, 'Doombolt');
    const pistol = profileOf(DESTINY, 'Inferno bolt pistol');
    setBoon(state, sorcerer.id, 'twist-of-fate');
    expect(
      effectiveRules(ctx, state, doombolt, { operative: sorcerer, target, weaponName: 'Doombolt' }).some(
        (r) => r.id === 'PiercingCrits' && r.x === 1,
      ),
    ).toBe(true);
    expect(
      effectiveRules(ctx, state, pistol, { operative: sorcerer, target, weaponName: 'Inferno bolt pistol' }).some(
        (r) => r.id === 'PiercingCrits',
      ),
    ).toBe(false); // an inferno bolt pistol is not PSYCHIC

    // "If you select a doombolt, it has the 2" Devastating 2 weapon rule instead of Devastating 2."
    const other = op(state, 'p1', TEMPYRION);
    setBoon(state, other.id, 'astral-bombardment', { weapon: 'Fluxblast' });
    const flux = effectiveRules(ctx, state, profileOf(TEMPYRION, 'Fluxblast'), {
      operative: other,
      target,
      weaponName: 'Fluxblast',
    });
    expect(flux.some((r) => r.id === 'Devastating' && r.x === 1)).toBe(true);
    const destinyStore = state.opState['warpcoven.boons'] as Record<string, { boon: string; weapon?: string }>;
    destinyStore[sorcerer.id] = { boon: 'astral-bombardment', weapon: 'Doombolt' };
    const bolt = effectiveRules(ctx, state, doombolt, { operative: sorcerer, target, weaponName: 'Doombolt' }).filter(
      (r) => r.id === 'Devastating',
    );
    expect(bolt).toHaveLength(1);
    expect(bolt[0]).toMatchObject({ id: 'Devastating', x: 2, dist: 2 });
  });

  it('Master of the Immaterium: "Add 3\\" to the distance requirements of this operative’s PSYCHIC actions"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    enemy.pos = { x: 20.5, y: 11 }; // 10.5" centre-to-centre, ~9.24" base to base
    const s = activate(ctx, state, sorcerer.id);
    const params = { targetOperativeId: enemy.id };
    const before = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-destiny.act.ravage-destiny', params }, ctx);
    expect(before.ok).toBe(false);
    expect(before.reason).toMatch(/more than 9" away/);
    setBoon(s, sorcerer.id, 'master-of-the-immaterium');
    const after = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-destiny.act.ravage-destiny', params }, ctx);
    expect(after.ok).toBe(true);
  });

  it('Immaterial Flight: "remove it from the killzone and set it back up wholly within … its Move stat", once per turning point', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    sorcerer.pos = { x: 10, y: 11 };
    setBoon(state, sorcerer.id, 'immaterial-flight');
    let s = activate(ctx, state, sorcerer.id);
    const tooFar = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: FLIGHT_REPOSITION, params: { targetPos: { x: 18, y: 11 } } }, ctx);
    expect(tooFar.ok).toBe(false);
    expect(tooFar.reason).toMatch(/6" FLY cannot reach/);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: FLIGHT_REPOSITION, params: { targetPos: { x: 15.5, y: 11 } } }, ctx).state;
    expect(s.operatives[sorcerer.id]!.pos).toMatchObject({ x: 15.5, y: 11 });
    // "Once per turning point" and it counts as the Reposition action (treatedAs).
    expect(s.operatives[sorcerer.id]!.actionsThisActivation).toContain('Reposition');
    const again = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: FLIGHT_REPOSITION, params: { targetPos: { x: 12, y: 11 } } }, ctx);
    expect(again.ok).toBe(false);
  });

  it('Echoes from the Warp is reminder-only — the reducer allows a counteracting operative exactly one action', () => {
    expect(BOON_TEXT['echoes-from-the-warp']).toContain('it can perform an additional 1AP action for free');
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    setBoon(state, sorcerer.id, 'echoes-from-the-warp');
    for (const id of state.teams.p1.operativeIds) {
      state.operatives[id]!.ready = false;
      state.operatives[id]!.expended = true;
      state.operatives[id]!.order = 'engage';
    }
    let s = reduce(state, { t: 'Counteract', player: 'p1', operativeId: sorcerer.id }, ctx).state;
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'Dash', params: { path: { points: [{ x: sorcerer.pos.x + 1, y: sorcerer.pos.y }] } } }, ctx).state;
    const second = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'Reposition', params: { path: { points: [{ x: sorcerer.pos.x + 2, y: sorcerer.pos.y }] } } }, ctx);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/only perform one action/);
  });
});

// ---------------------------------------------------------------------------
describe('Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('is a second Shoot/Fight action, and never one of each', () => {
    const { ctx, state } = setup();
    const shooter = op(state, 'p1', RUBRIC_WARRIOR);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    shooter.pos = { x: 10, y: 11 };
    enemy.pos = { x: 16, y: 11 };
    const s = activate(ctx, state, shooter.id);
    const early = reduce(s, { t: 'PerformAction', operativeId: shooter.id, action: ASTARTES_SHOOT, params: { weaponName: 'Inferno boltgun', targetId: enemy.id } }, ctx);
    expect(early.reason).toMatch(/second Shoot action/);
    expect(
      reduce(s, { t: 'PerformAction', operativeId: shooter.id, action: ASTARTES_FIGHT, params: {} }, ctx).reason,
    ).toMatch(/second Fight action/);
    // "EITHER two Shoot actions OR two Fight actions."
    s.operatives[shooter.id]!.actionsThisActivation = ['Shoot', 'Fight'];
    expect(
      reduce(s, { t: 'PerformAction', operativeId: shooter.id, action: ASTARTES_SHOOT, params: { weaponName: 'Inferno boltgun', targetId: enemy.id } }, ctx).reason,
    ).toMatch(/either two Shoot actions or two Fight actions/);
    expect(
      reduce(s, { t: 'PerformAction', operativeId: shooter.id, action: ASTARTES_FIGHT, params: {} }, ctx).reason,
    ).toMatch(/either two Shoot actions or two Fight actions/);
  });

  it('"1 additional AP must be spent for the second action" when a soulreaper cannon or warpflamer is selected for both', () => {
    const { ctx, state } = setup({ p1: [DESTINY, [GUNNER, 'warpcoven.g1e4.opt1'], RUBRIC_ICON, RUBRIC_WARRIOR, TEMPYRION] });
    const gunner = op(state, 'p1', GUNNER);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    gunner.pos = { x: 10, y: 11 };
    enemy.pos = { x: 14, y: 11 };
    enemy.wounds = 60; // this test is about AP, not about killing the target
    for (const id of state.teams.p2.operativeIds) if (id !== enemy.id) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, gunner.id);
    s = settle(ctx, reduce(s, { t: 'PerformAction', operativeId: gunner.id, action: 'Shoot', params: { weaponName: 'Warpflamer', targetId: enemy.id } }, ctx).state);
    const apAfterFirst = s.operatives[gunner.id]!.apSpent;
    s = settle(ctx, reduce(s, { t: 'PerformAction', operativeId: gunner.id, action: ASTARTES_SHOOT, params: { weaponName: 'Warpflamer', targetId: enemy.id } }, ctx).state);
    expect(s.operatives[gunner.id]!.apSpent - apAfterFirst).toBe(2); // 1AP + 1 additional
    expect(text('warpcoven.rule.astartes')).toContain('1 additional AP must be spent for the second action');
  });

  it('"You cannot select the same PSYCHIC ranged weapon more than once per activation"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    enemy.pos = { x: 14, y: 11 };
    enemy.wounds = 60;
    for (const id of state.teams.p2.operativeIds) if (id !== enemy.id) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, sorcerer.id);
    s = settle(ctx, reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'Shoot', params: { weaponName: 'Doombolt', targetId: enemy.id } }, ctx).state);
    const again = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: ASTARTES_SHOOT, params: { weaponName: 'Doombolt', targetId: enemy.id } }, ctx);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/same PSYCHIC ranged weapon more than once per activation/);
  });

});

// ---------------------------------------------------------------------------
/** The printed clause, read from the JSON like every other quote in this file. */
const COUNTERACT_CLAUSE =
  'Each friendly WARPCOVEN HERETIC ASTARTES operative can counteract regardless of its order.';

describe(`Astartes — "${COUNTERACT_CLAUSE}"`, () => {
  /** "each of their operatives that is expended" — the state a counteract turn starts from. */
  function expendAll(state: GameState, player: 'p1' | 'p2'): void {
    for (const id of state.teams[player].operativeIds) {
      const o = state.operatives[id]!;
      o.ready = false;
      o.expended = true;
      o.order = 'engage';
    }
  }

  it('a Conceal operative of ours IS a counteract candidate, and an Engage one still is', () => {
    expect(text('warpcoven.rule.astartes')).toContain(COUNTERACT_CLAUSE);
    const { ctx, state } = setup();
    expendAll(state, 'p1');
    const concealed = op(state, 'p1', DESTINY);
    concealed.order = 'conceal';
    const engaged = op(state, 'p1', RUBRIC_WARRIOR);
    const ids = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(concealed.id); // "regardless of its order"
    expect(ids).toContain(engaged.id); // the printed Engage default is only widened, never removed
  });

  it('widens the ORDER only — expended, once per turning point and the On Guard lockout still apply', () => {
    const { ctx, state } = setup();
    expendAll(state, 'p1');
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.order = 'conceal';
    const notExpended = op(state, 'p1', DESTINY);
    notExpended.expended = false;
    notExpended.ready = true;
    // "each of their operatives … can counteract ONCE during the turning point"
    const alreadyCounteracted = op(state, 'p1', TEMPYRION);
    alreadyCounteracted.counteractedThisTP = true;
    // On Guard: "that friendly operative cannot counteract during the turning point"
    const onGuardSpent = op(state, 'p1', WARPFIRE);
    onGuardSpent.guardSpentTP = state.turningPoint;
    const stillEligible = op(state, 'p1', RUBRIC_WARRIOR);
    const ids = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(ids).not.toContain(notExpended.id);
    expect(ids).not.toContain(alreadyCounteracted.id);
    expect(ids).not.toContain(onGuardSpent.id);
    expect(ids).toContain(stillEligible.id);
  });

  it('is scoped as printed — WARPCOVEN HERETIC ASTARTES, and friendly only', () => {
    const { ctx, state } = setup({ p1: HERD });
    expendAll(state, 'p1');
    expendAll(state, 'p2');
    const sorcerer = op(state, 'p1', DESTINY);
    const tzaangor = op(state, 'p1', TZ_WARRIOR);
    sorcerer.order = 'conceal';
    tzaangor.order = 'conceal';
    const mine = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(mine).toContain(sorcerer.id);
    // TZAANGOR datacards carry WARPCOVEN but not HERETIC ASTARTES, so they keep the Engage default.
    expect(card(TZ_WARRIOR).keywords).not.toContain('HERETIC ASTARTES');
    expect(mine).not.toContain(tzaangor.id);

    // "friendly": both sides here are Warpcoven, so p2's Conceal SORCERER is widened by p2's own
    // copy of the rule. Rebuilding the registry from p1's registration alone stands in for an
    // opposing team that does not print this clause — it must keep the Engage default.
    const enemy = op(state, 'p2', DESTINY);
    enemy.order = 'conceal';
    expect(counteractCandidates(ctx, state, 'p2').map((o) => o.id)).toContain(enemy.id);
    const p1Only = new HookRegistry();
    warpcoven.register(p1Only, 'p1', ctx);
    ctx.hooks = p1Only;
    expect(counteractCandidates(ctx, state, 'p2').map((o) => o.id)).not.toContain(enemy.id);
  });

  it('the counteract turn is offered, and a Conceal operative counteracts through the reducer', () => {
    const { ctx, state } = setup();
    expendAll(state, 'p1');
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.order = 'conceal';
    // p1 has no ready operatives and p2 does, so p1's turn is the counteract turn — offered only
    // because the Conceal operatives are candidates.
    expect(whoActivates(state, ctx)).toEqual({ player: 'p1', mode: 'counteract' });
    const sorcerer = op(state, 'p1', DESTINY);
    const out = reduce(state, { t: 'Counteract', player: 'p1', operativeId: sorcerer.id }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[sorcerer.id]!.counteractedThisTP).toBe(true);
    expect(out.state.rejected.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('WARPCOVEN datacard abilities', () => {
  it('Mindburn: "worsen the Hit stat of its weapons by 1 (this isn’t cumulative with being injured)"', () => {
    const { ctx, state } = setup();
    const warpfire = op(state, 'p1', WARPFIRE);
    const victim = op(state, 'p2', RUBRIC_WARRIOR);
    const mindburn = profileOf(WARPFIRE, 'Mindburn');
    const boltgun = profileOf(RUBRIC_WARRIOR, 'Inferno boltgun');
    expect(hitOf(ctx, state, victim, boltgun)).toBe(3);
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: {
        attacker: warpfire,
        defender: victim,
        weaponName: 'Mindburn',
        profile: mindburn,
        rules: mindburn.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 6,
      },
      crit: true,
      struck: victim,
    });
    expect(state.effects.some((e) => e.rule === 'warpcoven.mindburn' && e.operativeId === victim.id)).toBe(true);
    expect(hitOf(ctx, state, victim, boltgun)).toBe(4);
    // "this isn’t cumulative with being injured" — an injured operative is already worsened by 1.
    victim.wounds = 3;
    expect(hitOf(ctx, state, victim, boltgun)).toBe(4);
    expect(ability(WARPFIRE, 'warpcoven.sorcerer-of-warpfire.mindburn')).toContain('isn’t cumulative with being injured');
  });

  it('Sorcerous Automata: "subtract 1 from its APL stat … unless a friendly WARPCOVEN SORCERER operative is within 9\\""', () => {
    const { ctx, state } = setup();
    const rubric = op(state, 'p1', RUBRIC_WARRIOR);
    rubric.pos = { x: 10, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (id !== rubric.id) state.operatives[id]!.pos = { x: 2, y: 21 };
    const far = activate(ctx, state, rubric.id);
    expect(aplOf(ctx, far, far.operatives[rubric.id]!)).toBe(2); // 3 - 1

    const near = { ...state };
    near.operatives[opWith(near, 'p1', DESTINY)]!.pos = { x: 14, y: 11 };
    const withSorcerer = activate(ctx, near, rubric.id);
    expect(aplOf(ctx, withSorcerer, withSorcerer.operatives[rubric.id]!)).toBe(3);
  });

  it('Icon Bearer: "whenever determining control of a marker, treat this operative’s APL stat as 1 higher"', () => {
    const { ctx, state } = setup({ p1: HERD });
    const icon = op(state, 'p1', TZ_ICON);
    icon.pos = { x: 15, y: 11 };
    for (const id of [...state.teams.p1.operativeIds, ...state.teams.p2.operativeIds])
      if (id !== icon.id) state.operatives[id]!.pos = { x: 2, y: 21 };
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 15, y: 11 }, z: 0, flags: {} };
    const ev = ctx.hooks.emit('onMarkerControl', state, { state, markerId: 'obj', aplByPlayer: { p1: 2, p2: 0 } });
    expect(ev.aplByPlayer.p1).toBe(3);
    expect(ability(TZ_ICON, 'warpcoven.tzaangor-icon-bearer.icon-bearer')).toContain('treat this operative’s APL stat as 1 higher');
  });

  it('Slow and Purposeful: "if it hasn’t performed the Charge or Reposition action … its ranged weapons have the Ceaseless weapon rule"', () => {
    const { ctx, state } = setup();
    const rubric = op(state, 'p1', RUBRIC_WARRIOR);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    const boltgun = profileOf(RUBRIC_WARRIOR, 'Inferno boltgun');
    const rules = () => effectiveRules(ctx, state, boltgun, { operative: rubric, target, weaponName: 'Inferno boltgun' });
    expect(rules().some((r) => r.id === 'Ceaseless')).toBe(true);
    rubric.actionsThisActivation = ['Reposition'];
    expect(rules().some((r) => r.id === 'Ceaseless')).toBe(false);
    // "or if it's a counteraction"
    state.opState['counteract'] = { operativeId: rubric.id, actionsUsed: 0 };
    expect(rules().some((r) => r.id === 'Ceaseless')).toBe(true);
  });

  it('Savage Brutality: "it can immediately perform a free Fight action afterwards… takes precedence over action restrictions"', () => {
    const { ctx, state } = setup({ p1: HERD });
    const champion = op(state, 'p1', CHAMPION);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    champion.pos = { x: 12, y: 11 };
    enemy.pos = { x: 12.9, y: 11 };
    for (const id of state.teams.p2.operativeIds) if (id !== enemy.id) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, champion.id);
    const before = reduce(s, { t: 'PerformAction', operativeId: champion.id, action: SAVAGE_BRUTALITY_FIGHT, params: { targetId: enemy.id } }, ctx);
    expect(before.reason).toMatch(/follows the first Fight action/);
    s.operatives[champion.id]!.actionsThisActivation = ['Fight'];
    s.operatives[champion.id]!.apSpent = 2; // both AP already spent — the extra Fight is free
    const free = availableActions(ctx, s, s.operatives[champion.id]!).find((a) => a.def.id === SAVAGE_BRUTALITY_FIGHT);
    expect(free?.ap).toBe(0);
    expect(free?.ok).toBe(true);
    expect(ability(CHAMPION, 'warpcoven.tzaangor-champion.savage-brutality')).toContain(
      'takes precedence over action restrictions',
    );
  });

  it('Herd Banner: "an attack dice inflicts Normal Dmg of 3 or more … subtract 1 from that inflicted damage"', () => {
    const { ctx, state } = setup({ p1: HERD });
    const icon = op(state, 'p1', TZ_ICON);
    const victim = op(state, 'p1', CHAMPION);
    const shooter = op(state, 'p2', RUBRIC_WARRIOR);
    icon.pos = { x: 10, y: 11 };
    victim.pos = { x: 12, y: 11 };
    fakeShoot(state, shooter, victim, 'Inferno boltgun', ['normal']);
    const before = victim.wounds;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(before - victim.wounds).toBe(2);
    // Out of range: "visible to and within 3\" of this operative".
    icon.pos = { x: 2, y: 11 };
    const mid = victim.wounds;
    inflictDamage(ctx, state, victim, 3, 'attack');
    expect(mid - victim.wounds).toBe(3);
  });

  it('Relic Hunters: "for 1 less AP if that friendly operative is within your opponent’s territory", once per battle', () => {
    const { ctx, state } = setup({ p1: HERD });
    const warrior = op(state, 'p1', TZ_WARRIOR);
    const place = availableActions(ctx, state, warrior).find((a) => a.def.id === 'Place Marker')!.def;
    warrior.pos = { x: 5, y: 11 }; // own territory
    expect(actionCost(ctx, state, warrior, place)).toBe(1);
    warrior.pos = { x: 20, y: 11 }; // "within your opponent's territory"
    expect(actionCost(ctx, state, warrior, place)).toBe(0);
    // "Once per battle" — spent once the discounted action has actually been performed.
    warrior.actionsThisActivation = ['Place Marker'];
    ctx.hooks.emit('onActivationEnd', state, { state, operative: warrior });
    warrior.actionsThisActivation = [];
    expect(actionCost(ctx, state, warrior, place)).toBe(1);
  });

  it('Shield: "This operative has a 4+ Save stat, and … each of your blocks can be allocated to block two unresolved successes"', () => {
    const { ctx, state } = setup({ p1: HERD });
    const warrior = op(state, 'p1', TZ_WARRIOR);
    expect(card(TZ_WARRIOR).save).toBe(5);
    expect(saveOf(ctx, state, warrior)).toBe(4);
    const shield = profileOf(TZ_WARRIOR, 'Tzaangor blade & shield');
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: warrior,
        defender: op(state, 'p2', RUBRIC_WARRIOR),
        weaponName: 'Tzaangor blade & shield',
        profile: shield,
        rules: shield.rules,
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
});

// ---------------------------------------------------------------------------
describe('WARPCOVEN ploys', () => {
  it('AETHERIAL WARDING: "weapons with the Piercing 1 weapon rule have the Piercing Crits 1 weapon rule instead"', () => {
    const { ctx, state } = setup();
    const shooter = op(state, 'p2', RUBRIC_WARRIOR);
    const target = op(state, 'p1', RUBRIC_WARRIOR);
    const boltgun = profileOf(RUBRIC_WARRIOR, 'Inferno boltgun');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'warpcoven.sp.aetherial-warding' }, ctx).state;
    const rules = effectiveRules(ctx, s, boltgun, {
      operative: s.operatives[shooter.id]!,
      target: s.operatives[target.id]!,
      weaponName: 'Inferno boltgun',
    });
    expect(rules.some((r) => r.id === 'Piercing')).toBe(false);
    expect(rules.some((r) => r.id === 'PiercingCrits' && r.x === 1)).toBe(true);
  });

  it('FATE ITSELF IS MY WEAPON: reserves two D6 and spends one to replace a rolled dice', () => {
    // The gambit's own 2D6 are the first two scripted results (5 and 4 — combined 9, so the
    // other reserved dice is kept), then the shooting sequence rolls four 2s.
    const { ctx, state } = setup({ script: [5, 4, 2, 2, 2, 2, 1, 1, 1] });
    const shooter = op(state, 'p1', DESTINY);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    shooter.pos = { x: 10, y: 11 };
    target.pos = { x: 14, y: 11 };
    for (const id of state.teams.p2.operativeIds) if (id !== target.id) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'warpcoven.sp.fate-itself-is-my-weapon' }, ctx).state;
    const reserve = s.effects.find((e) => e.rule === 'warpcoven.fateDice')!;
    expect(reserve.data?.['dice']).toEqual([5, 4]);
    s = activate(ctx, s, shooter.id);
    s = reduce(s, { t: 'PerformAction', operativeId: shooter.id, action: 'Shoot', params: { weaponName: 'Doombolt', targetId: target.id } }, ctx).state;
    const seq = s.sequence as { attack: { dice: { value: number; state: string; note?: string }[] } } | null;
    const replaced = seq?.attack.dice.find((d) => d.note === 'Fate Itself Is My Weapon');
    expect(replaced?.value).toBe(5); // the best reserved dice turned a fail into a success
    expect(replaced?.state).toBe('crit'); // Doombolt has Lethal 5+
    expect(text('warpcoven.sp.fate-itself-is-my-weapon')).toContain('You cannot use more than one reserved dice per sequence');
  });

  it('BROTHERHOOD OF SORCERERS: "Balanced …, or Ceaseless if another friendly WARPCOVEN SORCERER operative is within 9\\""', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const brother = op(state, 'p1', TEMPYRION);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    brother.pos = { x: 2, y: 21 };
    for (const id of state.teams.p1.operativeIds) if (id !== sorcerer.id) state.operatives[id]!.pos = { x: 2, y: 21 };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'warpcoven.sp.brotherhood-of-sorcerers' }, ctx).state;
    const stave = profileOf(DESTINY, 'Force stave');
    const alone = effectiveRules(ctx, s, stave, { operative: s.operatives[sorcerer.id]!, target: s.operatives[target.id]!, weaponName: 'Force stave' });
    expect(alone.some((r) => r.id === 'Balanced')).toBe(true);
    expect(alone.some((r) => r.id === 'Ceaseless')).toBe(false);
    s.operatives[brother.id]!.pos = { x: 14, y: 11 };
    const together = effectiveRules(ctx, s, stave, { operative: s.operatives[sorcerer.id]!, target: s.operatives[target.id]!, weaponName: 'Force stave' });
    expect(together.some((r) => r.id === 'Ceaseless')).toBe(true);
    // "…SORCERER operatives' PSYCHIC weapons" — a khopesh is not PSYCHIC.
    const khopesh = profileOf(DESTINY, 'Prosperine khopesh');
    expect(
      effectiveRules(ctx, s, khopesh, { operative: s.operatives[sorcerer.id]!, target: s.operatives[target.id]!, weaponName: 'Prosperine khopesh' }).some(
        (r) => r.id === 'Ceaseless' || r.id === 'Balanced',
      ),
    ).toBe(false);
  });

  it('SAVAGE HERD: Accurate 1 always, and Severe while "fighting … within 6\\" of a friendly WARPCOVEN SORCERER"', () => {
    const { ctx, state } = setup({ p1: HERD });
    const champion = op(state, 'p1', CHAMPION);
    const sorcerer = op(state, 'p1', DESTINY);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    champion.pos = { x: 10, y: 11 };
    sorcerer.pos = { x: 2, y: 21 };
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'warpcoven.sp.savage-herd' }, ctx).state;
    const axe = profileOf(CHAMPION, 'Greataxe');
    const use = { operative: s.operatives[champion.id]!, target: s.operatives[target.id]!, weaponName: 'Greataxe' };
    expect(effectiveRules(ctx, s, axe, use).some((r) => r.id === 'Accurate' && r.x === 1)).toBe(true);
    expect(effectiveRules(ctx, s, axe, use).some((r) => r.id === 'Severe')).toBe(false);
    s.operatives[sorcerer.id]!.pos = { x: 13, y: 11 };
    expect(effectiveRules(ctx, s, axe, use).some((r) => r.id === 'Severe')).toBe(true);
    // The raw scrape runs the next page section into the last ploy of each section; the shared
    // normaliser (`trimTrailingSection`) cuts it, so the quoted text really is just this ploy.
    expect(text('warpcoven.sp.savage-herd')).toContain('also have the Severe weapon rule');
    expect(text('warpcoven.sp.savage-herd')).not.toContain('ALL IS DUST');
    expect(text('warpcoven.fp.mutant-herd')).not.toContain('ENSORCELLED ROUNDS');
  });

  it('ALL IS DUST: "That attack dice inflicts 1 damage instead" for a friendly RUBRIC MARINE', () => {
    const { ctx, state } = setup();
    const victim = op(state, 'p1', RUBRIC_WARRIOR);
    const shooter = op(state, 'p2', RUBRIC_WARRIOR);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'warpcoven.fp.all-is-dust' }, ctx).state;
    fakeShoot(s, s.operatives[shooter.id]!, s.operatives[victim.id]!, 'Inferno boltgun', ['normal']);
    const before = s.operatives[victim.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[victim.id]!, 3, 'attack');
    expect(before - s.operatives[victim.id]!.wounds).toBe(1);
    // One attack dice only, and the ploy is once per turning point.
    const mid = s.operatives[victim.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[victim.id]!, 3, 'attack');
    expect(mid - s.operatives[victim.id]!.wounds).toBe(3);
  });

  it('CAPRICIOUS PLAN: "a free Dash action (even if it’s performed an action that prevents it…), or you can change its order"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    sorcerer.pos = { x: 10, y: 11 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, sorcerer.id);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'Dash', params: { path: { points: [{ x: 12, y: 11 }] } } }, ctx).state;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'warpcoven.fp.capricious-plan', data: { operativeId: sorcerer.id } }, ctx).state;
    const out = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: CAPRICIOUS_DASH, params: { path: { points: [{ x: 14, y: 11 }] } } }, ctx);
    expect(out.ok).toBe(true);
    expect(out.state.operatives[sorcerer.id]!.pos).toMatchObject({ x: 14, y: 11 });
    expect(out.state.operatives[sorcerer.id]!.apSpent).toBe(1); // the second Dash is free

    // "…or you can change its order instead."
    const order = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'warpcoven.fp.capricious-plan', data: { operativeId: sorcerer.id, mode: 'order' } }, ctx).state;
    expect(order.operatives[sorcerer.id]!.order).toBe('conceal');
  });

  it('PSYCHIC CABAL: shares a PSYCHIC ranged weapon and locks the donor out of it for the turning point', () => {
    const { ctx, state } = setup();
    const receiver = op(state, 'p1', DESTINY);
    const donor = op(state, 'p1', TEMPYRION);
    receiver.pos = { x: 10, y: 11 };
    donor.pos = { x: 14, y: 11 };
    let s = activate(ctx, state, receiver.id);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'warpcoven.fp.psychic-cabal', data: { donorId: donor.id, choice: 'Fluxblast' } }, ctx).state;
    const granted = (s.operatives[receiver.id] as { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(granted.map((w) => w.name)).toContain('Fluxblast');
    const donorWeapons = ctx.hooks.emit('availableWeapons', s, {
      state: s,
      operative: s.operatives[donor.id]!,
      weapons: ['Fluxblast', 'Force stave'],
    }).weapons;
    expect(donorWeapons).not.toContain('Fluxblast');
    expect(text('warpcoven.fp.psychic-cabal')).toContain('cannot use the selected weapon during this turning point');
  });

  it('MUTANT HERD records the paired activation (the engine alternates activations strictly)', () => {
    const { ctx, state } = setup({ p1: HERD });
    const first = op(state, 'p1', CHAMPION);
    const partner = op(state, 'p1', TZ_WARRIOR);
    first.pos = { x: 10, y: 11 };
    partner.pos = { x: 11.5, y: 11 };
    for (const id of state.teams.p1.operativeIds)
      if (id !== first.id && id !== partner.id) state.operatives[id]!.pos = { x: 2, y: 21 };
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'warpcoven.fp.mutant-herd', data: { operativeId: first.id } }, ctx).state;
    const eff = s.effects.find((e) => e.rule === 'warpcoven.mutantHerd');
    expect(eff?.operativeId).toBe(first.id);
    expect(eff?.data?.['partnerId']).toBe(partner.id);
    // Each firefight ploy names the operative whose window it is.
    const usable = (id: string, st: GameState) => warpcoven.ploys.find((p) => p.id === id)!.usable!(st, 'p1');
    expect(usable('warpcoven.fp.mutant-herd', s).ok).toBe(true);
    const noHerd = setup().state; // the sorcerer roster has no TZAANGOR and no RUBRIC MARINE pair
    expect(usable('warpcoven.fp.mutant-herd', noHerd).ok).toBe(false);
    expect(usable('warpcoven.fp.psychic-cabal', noHerd).ok).toBe(true);
    expect(usable('warpcoven.fp.psychic-cabal', s).ok).toBe(false); // only one SORCERER in the herd
  });
});

// ---------------------------------------------------------------------------
describe('WARPCOVEN faction equipment', () => {
  it('ENSORCELLED ROUNDS: "inferno boltguns, inferno bolt pistols and autopistols have the Devastating 1 weapon rule"', () => {
    const { ctx, state } = setup({ equipment: ['warpcoven.eq.ensorcelled-rounds'] });
    const shooter = op(state, 'p1', RUBRIC_WARRIOR);
    const target = op(state, 'p2', RUBRIC_WARRIOR);
    const boltgun = profileOf(RUBRIC_WARRIOR, 'Inferno boltgun');
    expect(
      effectiveRules(ctx, state, boltgun, { operative: shooter, target, weaponName: 'Inferno boltgun' }).some(
        (r) => r.id === 'Devastating' && r.x === 1,
      ),
    ).toBe(true);
    const stave = profileOf(DESTINY, 'Force stave');
    expect(
      effectiveRules(ctx, state, stave, { operative: op(state, 'p1', DESTINY), target, weaponName: 'Force stave' }).some(
        (r) => r.id === 'Devastating',
      ),
    ).toBe(false);
  });

  it('DAEMONMAW WEAPONS: +1 Atk on RUBRIC MARINE melee weapons and Accurate 1 while retaliating', () => {
    const { ctx, state } = setup({ equipment: ['warpcoven.eq.daemonmaw-weapons'] });
    const rubric = op(state, 'p1', RUBRIC_WARRIOR);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    const fists = profileOf(RUBRIC_WARRIOR, 'Fists');
    const attack = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: {
        attacker: rubric,
        defender: enemy,
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
      count: fists.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(attack.count).toBe(fists.atk + 1);
    expect(
      effectiveRules(ctx, state, fists, { operative: rubric, target: enemy, weaponName: 'Fists', retaliating: true }).some(
        (r) => r.id === 'Accurate' && r.x === 1,
      ),
    ).toBe(true);
    expect(
      effectiveRules(ctx, state, fists, { operative: rubric, target: enemy, weaponName: 'Fists' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
  });

  it('ARCANE ROBES: "that attack dice inflicts Normal Dmg instead", once per turning point', () => {
    const { ctx, state } = setup({ equipment: ['warpcoven.eq.arcane-robes'] });
    const sorcerer = op(state, 'p1', DESTINY);
    const shooter = op(state, 'p2', RUBRIC_WARRIOR);
    fakeShoot(state, shooter, sorcerer, 'Inferno boltgun', ['crit']);
    const before = sorcerer.wounds;
    inflictDamage(ctx, state, sorcerer, 4, 'attack'); // Critical Dmg 4, Normal Dmg 3
    expect(before - sorcerer.wounds).toBe(3);
    const mid = sorcerer.wounds;
    inflictDamage(ctx, state, sorcerer, 4, 'attack');
    expect(mid - sorcerer.wounds).toBe(4); // "Once per turning point"
  });

  it('SORCEROUS SCROLLS: "select a different BOON OF TZEENTCH for it to have until the end of the battle"', () => {
    const { ctx, state } = setup({ equipment: ['warpcoven.eq.sorcerous-scrolls'] });
    const sorcerer = op(state, 'p1', DESTINY);
    setBoon(state, sorcerer.id, 'time-walk');
    const s = activate(ctx, state, sorcerer.id);
    const decision = s.pending.find((d) => d.kind === 'warpcoven.sorcerousScrolls');
    expect(decision).toBeDefined();
    expect(decision!.options[0]!.id).toBe('decline');
    expect(decision!.options.map((o) => o.id)).not.toContain('time-walk'); // "a DIFFERENT boon"
    const after = reduce(s, { t: 'ResolveDecision', decisionId: decision!.id, optionId: 'warp-swell' }, ctx).state;
    expect(boonOf(after, after.operatives[sorcerer.id]!)).toBe('warp-swell');
    // "Once per battle" — no second offer.
    const again = activate(ctx, after, opWith(after, 'p1', TEMPYRION));
    expect(again.pending.some((d) => d.kind === 'warpcoven.sorcerousScrolls')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('WARPCOVEN unique actions', () => {
  it('PROTECTED BY FATE 1AP: "whenever an operative is shooting that selected operative, you can re-roll any of your defence dice"', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', DESTINY);
    const friend = op(state, 'p1', RUBRIC_WARRIOR);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    let s = activate(ctx, state, sorcerer.id);
    const selfTarget = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-destiny.act.protected-by-fate', params: {} }, ctx);
    expect(selfTarget.ok).toBe(false);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-destiny.act.protected-by-fate', params: { targetOperativeId: friend.id } }, ctx).state;
    const boltgun = profileOf(RUBRIC_WARRIOR, 'Inferno boltgun');
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: {
        attacker: s.operatives[enemy.id]!,
        defender: s.operatives[friend.id]!,
        weaponName: 'Inferno boltgun',
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
    expect(ev.rerolls.some((r) => r.id === 'warpcoven.protectedByFate' && r.mode === 'any')).toBe(true);
  });

  it('RAVAGE DESTINY 1AP: "your opponent must re-roll their attack dice results of 6" and −1 APL for marker control', () => {
    // The sorcerer's Doombolt is irrelevant here: the enemy shoots and rolls 6,6,2,2, and the
    // forced re-rolls come back 1 and 1.
    const { ctx, state } = setup({ script: [6, 6, 2, 2, 1, 1, 3, 3, 3, 3, 3] });
    const sorcerer = op(state, 'p1', DESTINY);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    const victim = op(state, 'p1', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    enemy.pos = { x: 14, y: 11 };
    victim.pos = { x: 16, y: 15 };
    for (const id of state.teams.p1.operativeIds)
      if (id !== sorcerer.id && id !== victim.id) state.operatives[id]!.pos = { x: 2, y: 21 };
    for (const id of state.teams.p2.operativeIds) if (id !== enemy.id) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, sorcerer.id);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-destiny.act.ravage-destiny', params: { targetOperativeId: enemy.id } }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'warpcoven.ravageDestiny' && e.operativeId === enemy.id)).toBe(true);
    s = reduce(s, { t: 'EndActivation', operativeId: sorcerer.id }, ctx).state;
    s = activate(ctx, s, enemy.id);
    s = reduce(s, { t: 'PerformAction', operativeId: enemy.id, action: 'Shoot', params: { weaponName: 'Inferno boltgun', targetId: victim.id } }, ctx).state;
    expect(s.rolls.some((r) => r.kind === 'ravageDestiny')).toBe(true);
    const seq = s.sequence as { attack: { dice: { value: number }[] } } | null;
    expect(seq?.attack.dice.filter((d) => d.value === 6)).toHaveLength(0);

    // "whenever determining control of a marker, treat that enemy operative's APL stat as 1 lower"
    s.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { ...s.operatives[enemy.id]!.pos }, z: 0, flags: {} };
    const ev = ctx.hooks.emit('onMarkerControl', s, { state: s, markerId: 'obj', aplByPlayer: { p1: 0, p2: 3 } });
    expect(ev.aplByPlayer.p2).toBe(2);
  });

  it('RECONSTITUTION RITUAL 1AP: "regains up to 2D3 lost wounds", once per turning point for the whole kill team', () => {
    // D3 = "roll a D6 and halve the result, rounding up": 4 -> 2 and 5 -> 3.
    const { ctx, state } = setup({ script: [4, 5] });
    const sorcerer = op(state, 'p1', TEMPYRION);
    const patient = op(state, 'p1', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    patient.pos = { x: 13, y: 11 };
    patient.wounds = 4;
    let s = activate(ctx, state, sorcerer.id);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-tempyrion.act.reconstitution-ritual', params: { targetOperativeId: patient.id } }, ctx).state;
    expect(s.operatives[patient.id]!.wounds).toBe(9); // 4 + (2 + 3)
    // "…or if a FRIENDLY OPERATIVE has already performed this action during this turning point."
    s.operatives[sorcerer.id]!.actionsThisActivation = []; // past the universal action restriction
    const again = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-tempyrion.act.reconstitution-ritual', params: { targetOperativeId: patient.id } }, ctx);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already performed this action during this turning point/);
  });

  it('TEMPORAL FLUX 1AP: the marked operative is set back up by the marker at the end of its next activation', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', TEMPYRION);
    const friend = op(state, 'p1', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    friend.pos = { x: 13, y: 11 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    let s = activate(ctx, state, sorcerer.id);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-tempyrion.act.temporal-flux', params: { targetOperativeId: friend.id } }, ctx).state;
    expect(s.markers['warpcoven.temporalFlux.p1']).toBeDefined();
    // "…or if your Temporal Flux marker is currently in the killzone."
    s.operatives[sorcerer.id]!.actionsThisActivation = []; // past the universal action restriction
    expect(
      reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-tempyrion.act.temporal-flux', params: { targetOperativeId: friend.id } }, ctx).reason,
    ).toMatch(/already in the killzone/);
    s = reduce(s, { t: 'EndActivation', operativeId: sorcerer.id }, ctx).state;
    s = activate(ctx, s, friend.id);
    s.operatives[friend.id]!.pos = { x: 16, y: 11 }; // still wholly within 6" of the marker
    s = reduce(s, { t: 'EndActivation', operativeId: friend.id }, ctx).state;
    expect(s.operatives[friend.id]!.pos.x).toBeCloseTo(13, 1);
    expect(s.markers['warpcoven.temporalFlux.p1']).toBeUndefined();
  });

  it('ALIGHT 1AP: "that friendly operative’s weapons have the Ceaseless weapon rule" against an Alight token', () => {
    const { ctx, state } = setup();
    const sorcerer = op(state, 'p1', WARPFIRE);
    const enemy = op(state, 'p2', RUBRIC_WARRIOR);
    const ally = op(state, 'p1', RUBRIC_WARRIOR);
    sorcerer.pos = { x: 10, y: 11 };
    enemy.pos = { x: 14, y: 11 };
    let s = activate(ctx, state, sorcerer.id);
    s = reduce(s, { t: 'PerformAction', operativeId: sorcerer.id, action: 'warpcoven.sorcerer-of-warpfire.act.alight', params: { targetOperativeId: enemy.id } }, ctx).state;
    const boltgun = profileOf(RUBRIC_WARRIOR, 'Inferno boltgun');
    const rules = effectiveRules(ctx, s, boltgun, {
      operative: s.operatives[ally.id]!,
      target: s.operatives[enemy.id]!,
      weaponName: 'Inferno boltgun',
    });
    expect(rules.filter((r) => r.id === 'Ceaseless').some((r) => r.raw?.includes('Alight'))).toBe(true);
    expect(actionOf(WARPFIRE, 'warpcoven.sorcerer-of-warpfire.act.alight')).toContain('Alight tokens');
  });

  it('BRAYHORN 0AP: "add 1\\" to the Move stat of friendly WARPCOVEN TZAANGOR operatives"', () => {
    const { ctx, state } = setup({ p1: HERD });
    const horn = op(state, 'p1', HORN);
    const champion = op(state, 'p1', CHAMPION);
    expect(moveOf(ctx, state, champion)).toBe(6);
    let s = activate(ctx, state, horn.id);
    s = reduce(s, { t: 'PerformAction', operativeId: horn.id, action: 'warpcoven.tzaangor-horn-bearer.act.brayhorn' }, ctx).state;
    expect(moveOf(ctx, s, s.operatives[champion.id]!)).toBe(7);
    // Not a TZAANGOR: the SORCERER is unaffected.
    expect(moveOf(ctx, s, s.operatives[opWith(s, 'p1', DESTINY)]!)).toBe(6);
    expect(card(HORN).uniqueActions[0]!.ap).toBe(0);
  });
});
