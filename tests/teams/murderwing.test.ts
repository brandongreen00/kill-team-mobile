/**
 * MURDERWING. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/murderwing/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { counteractCandidates } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { aplOf, hitOf, inflictDamage, markerController, moveOf } from '../../src/core/state.ts';
import { zeroStatMods, type RerollGrant } from '../../src/core/hooks.ts';
import {
  ASTARTES_FIGHT,
  ASTARTES_SHOOT,
  BOOST_CHARGE,
  BOOST_FALL_BACK,
  BOOST_REPOSITION,
  CHAOS_CHAMPION_GAMBIT,
  boostZoneOf,
  damnationPoints,
  descentCandidates,
  inBoostZone,
  murderwing,
} from '../../src/teams/murderwing/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { teamData } from '../../src/teams/data.ts';
import { act, activate, battle, mapById, opWith, realMaps, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap, vantagePlatform } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, KillzoneMap, OperativeState, Vec2 } from '../../src/core/types.ts';

const DATA = teamData('murderwing');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const ability = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const uniqueText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const LORD = 'murderwing.chaos-lord';
const CHAMPION = 'murderwing.champion';
const CURSECLAW = 'murderwing.curseclaw';
const DEPREDATOR = 'murderwing.depredator';
const HUNTMASTER = 'murderwing.huntmaster';
const RAPTOR = 'murderwing.raptor';
const SHRIEKER = 'murderwing.shrieker';
const SKYSEAR = 'murderwing.skysear';
const WARP_TALON = 'murderwing.warp-talon';

/** Every datacard, so any rule test can reach the operative it needs. */
const EVERY_ROLE = [LORD, CHAMPION, CURSECLAW, DEPREDATOR, HUNTMASTER, RAPTOR, SHRIEKER, SKYSEAR, WARP_TALON];
const PICKS = EVERY_ROLE.map((datacardId) => ({ datacardId }));

interface Setup {
  ctx: GameContext;
  state: GameState;
}

function setup(opts: { equipment?: string[]; script?: number[]; map?: KillzoneMap; seed?: number } = {}): Setup {
  const ctx = teamContext([murderwing], {
    ...(opts.script ? { script: opts.script } : {}),
    seed: opts.seed ?? 7,
  });
  const map = opts.map ?? testMap();
  ctx.maps.set(map.id, map);
  const state = battle({
    ctx,
    map,
    p1: { module: murderwing, picks: PICKS, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: murderwing, picks: PICKS },
  });
  state.teams.p1.cp = 6;
  state.teams.p2.cp = 6;
  return { ctx, state };
}

/** Park every operative in the far top-left corner, then place the ones a test cares about. */
function park(state: GameState): void {
  let n = 0;
  for (const op of Object.values(state.operatives)) {
    op.pos = { x: 0.8 + (n % 2) * 1.6, y: 21.2 - Math.floor(n / 2) * 1.4 };
    op.z = 0;
    n++;
  }
}

function place(state: GameState, id: string, pos: Vec2, z = 0): OperativeState {
  const op = state.operatives[id]!;
  op.pos = { ...pos };
  op.z = z;
  return op;
}

const profileOf = (cardId: string, weapon: string, profile?: string) => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

// ---------------------------------------------------------------------------
describe('MURDERWING data (pinned against data/teams/murderwing.json)', () => {
  it('has 9 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(9);
    const lord = DATA.datacards.find((c) => c.id === LORD)!;
    expect(lord).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 15, base: { shape: 'round', mm: 40 } });
    expect(lord.keywords).toEqual(['MURDERWING', 'CHAOS', 'HERETIC ASTARTES', 'LEADER', 'LORD']);
    for (const c of DATA.datacards.filter((x) => x.id !== LORD)) {
      expect(c).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 14, base: { shape: 'round', mm: 32 } });
      expect(c.keywords.slice(0, 3)).toEqual(['MURDERWING', 'CHAOS', 'HERETIC ASTARTES']);
    }
  });

  it('pins the CHAOS LORD and SKYSEAR weapon profiles', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) => w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')));
    expect(flat(LORD)).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Plasma pistol|standard|ranged|4|3|3|5',
      'Plasma pistol|supercharge|ranged|4|3|4|5',
      'Lightning claw||melee|5|3|4|5',
      'Power fist||melee|4|3|5|7',
      'Power weapon||melee|5|3|4|6',
      'Relic lightning claws||melee|5|3|4|6',
    ]);
    expect(flat(SKYSEAR)).toEqual([
      'Bolt pistol||ranged|4|3|3|4',
      'Flamer||ranged|4|2|3|3',
      'Meltagun||ranged|4|3|6|3',
      'Plasma gun|standard|ranged|4|3|4|6',
      'Plasma gun|supercharge|ranged|4|3|5|6',
      'Fists||melee|4|3|3|4',
    ]);
    expect(profileOf(WARP_TALON, 'Lightning claws').rules.map((r) => r.id)).toEqual(['Ceaseless', 'Lethal', 'Rending']);
  });

  it('exposes 3 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment and no rare weapon rules', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Jump Pack', 'Boost Actions', 'Astartes']);
    expect(murderwing.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(murderwing.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(murderwing.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual([]);
    // aiHints are a deliverable: without ployValue the AI never uses a firefight ploy.
    for (const p of murderwing.ploys) expect(murderwing.aiHints?.ployValue?.[p.id]).toBeGreaterThan(0);
    for (const e of murderwing.equipment) expect(murderwing.aiHints?.equipmentValue?.[e.id]).toBeGreaterThan(0);
    for (const c of DATA.datacards) expect(murderwing.aiHints?.roles?.[c.id]).toBeTruthy();
  });

  it('the printed selection list builds a legal 6-operative kill team', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(6);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(DATA.selection.totalOperatives).toBe(6);
  });
});

// ---------------------------------------------------------------------------
describe('Jump Pack — "it can do a BOOST for that increment … remove it from the killzone and set it back up wholly within x" horizontally"', () => {
  it('removes the operative and sets it back up within x" horizontally of its original location', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    let s = activate(ctx, state, id);
    const out = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 10, y: 5 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[id]!.pos).toEqual({ x: 10, y: 5 });
    expect(rule('murderwing.rule.jump-pack')).toContain('set it back up wholly within x" horizontally of its original location');
  });

  it('"it\'s added to the total move distance used for that action" — a BOOST beyond the Move stat is refused', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    const s = activate(ctx, state, id);
    expect(moveOf(ctx, s, s.operatives[id]!)).toBe(6);
    expect(act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 12, y: 5 } }).ok).toBe(false);
    expect(act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).ok).toBe(true);
    expect(rule('murderwing.rule.jump-pack')).toContain('move plus BOOST cannot exceed the action’s move allowance');
  });

  it('"If it would BOOST during the Charge action, don\'t add the additional 2""', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 13, y: 5 });
    const s = activate(ctx, state, id);
    // A normal Charge is Move + 2 = 8"; the BOOST variant gets only the 6" Move stat.
    expect(moveBudget(ctx, s, s.operatives[id]!, { action: 'Charge', bonusInches: 2 })).toBe(8);
    const far = act(ctx, s, id, BOOST_CHARGE, { targetPos: { x: 11.7, y: 5 } });
    expect(far.ok).toBe(false);
    expect(far.reason).toContain('6" move allowance');
    expect(rule('murderwing.rule.jump-pack')).toContain('don’t add the additional 2"');
  });

  it('"unless it\'s the Charge action, it cannot be set up within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 10.4, y: 5 });
    let s = activate(ctx, state, id);
    const bad = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 9.2, y: 5 } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('control range');
    // The Charge variant must finish there instead.
    const good = act(ctx, s, id, BOOST_CHARGE, { targetPos: { x: 9.2, y: 5 } });
    expect(good.ok).toBe(true);
    expect(good.state.operatives[id]!.pos.x).toBeCloseTo(9.2, 5);
  });

  it('"as long as no part of its base is underneath Vantage terrain" — and it cannot be set up underneath one either', () => {
    const map = testMap({ features: [vantagePlatform('vp', 8, 3, 5, 5, 3)] });
    const { ctx, state } = setup({ map });
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    // Standing on the killzone floor, underneath the platform.
    place(state, id, { x: 10, y: 5 }, 0);
    let s = activate(ctx, state, id);
    const under = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 15, y: 5 } });
    expect(under.ok).toBe(false);
    expect(under.reason).toContain('underneath Vantage terrain');

    // From clear ground, a destination explicitly underneath the platform is refused too.
    place(state, id, { x: 16, y: 5 }, 0);
    s = activate(ctx, state, id);
    const landing = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 }, data: { z: 0 } });
    expect(landing.ok).toBe(false);
    expect(landing.reason).toContain('underneath Vantage terrain');
  });

  it('is treated as the Reposition / Fall Back / Charge action for AP and action restrictions', () => {
    expect(getAction(BOOST_REPOSITION)).toMatchObject({ ap: 1, treatedAs: 'Reposition' });
    expect(getAction(BOOST_FALL_BACK)).toMatchObject({ ap: 2, treatedAs: 'Fall Back' });
    expect(getAction(BOOST_CHARGE)).toMatchObject({ ap: 1, treatedAs: 'Charge' });
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 9, y: 5 } }).state;
    expect(s.operatives[id]!.actionsThisActivation).toContain('Reposition');
    expect(act(ctx, s, id, 'Reposition', { path: { points: [{ x: 11, y: 5 }] } }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Boost Actions — "the horizontal area between … its current location and the location from which it used BOOST"', () => {
  it('an enemy operative between the two locations is within the BOOST ZONE', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', CURSECLAW);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 8, y: 5 });
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).state;
    expect(boostZoneOf(s, id)).toMatchObject({ from: { x: 5, y: 5 }, to: { x: 11, y: 5 }, action: 'Reposition' });
    expect(inBoostZone(ctx, s, s.operatives[id]!, s.operatives[foeId]!)).toBe(true);
    expect(rule('murderwing.rule.boost-actions')).toContain(
      'the horizontal area between a friendly MURDERWING operative’s current location and the location from which it used BOOST',
    );
  });

  it('"Enemy operatives with any part of their base underneath Vantage terrain are not within … BOOST ZONEs"', () => {
    const map = testMap({ features: [vantagePlatform('vp', 7, 3, 3, 4, 3)] });
    const { ctx, state } = setup({ map });
    park(state);
    const id = opWith(state, 'p1', CURSECLAW);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 8.2, y: 5 }, 0); // on the floor, under the platform
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).state;
    expect(boostZoneOf(s, id)).toBeTruthy();
    expect(inBoostZone(ctx, s, s.operatives[id]!, s.operatives[foeId]!)).toBe(false);
  });

  it('"Each operative cannot perform more than one BOOST action per activation/counteraction"', () => {
    const { ctx, state } = setup({ equipment: ['murderwing.eq.bladefins'] });
    park(state);
    const id = opWith(state, 'p1', HUNTMASTER);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 8, y: 5 });
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).state;
    const first = act(ctx, s, id, 'murderwing.huntmaster.act.strike-from-above', { targetOperativeId: foeId });
    expect(first.ok).toBe(true);
    const second = act(ctx, first.state, id, 'SLICE FROM ABOVE', { targetOperativeId: foeId });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('more than one BOOST action');
  });

  it('a BOOST action cannot be performed without a BOOST — "it performs this action during the … action after setting up from a BOOST"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', HUNTMASTER);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 7, y: 5 });
    const s = activate(ctx, state, id);
    const out = act(ctx, s, id, 'murderwing.huntmaster.act.strike-from-above', { targetOperativeId: foeId });
    expect(out.ok).toBe(false);
    expect(uniqueText(HUNTMASTER, 'murderwing.huntmaster.act.strike-from-above')).toContain(
      'it performs this action during the Fall Back or Reposition action after setting up from a BOOST',
    );
  });
});

// ---------------------------------------------------------------------------
describe('Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('allows a second Shoot action only when a bolt pistol is selected for at least one of them', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', SKYSEAR);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 10, y: 5 });
    let s = activate(ctx, state, id);
    // The second Shoot is not offered before the first one happened.
    expect(getAction(ASTARTES_SHOOT)!.check(ctx, s, s.operatives[id]!, { weaponName: 'Bolt pistol', targetId: foeId }).ok).toBe(
      false,
    );
    s = settle(ctx, act(ctx, s, id, 'Shoot', { weaponName: 'Flamer', targetId: foeId }).state);
    // First shot was a flamer, so the second must be the bolt pistol.
    expect(getAction(ASTARTES_SHOOT)!.check(ctx, s, s.operatives[id]!, { weaponName: 'Flamer', targetId: foeId }).reason).toContain(
      'bolt pistol',
    );
    const ok = act(ctx, s, id, ASTARTES_SHOOT, { weaponName: 'Bolt pistol', targetId: foeId });
    expect(ok.ok).toBe(true);
    expect(rule('murderwing.rule.astartes')).toContain('a bolt pistol must be selected for at least one of them');
  });

  it('allows a second Fight action, but never one Shoot and one Fight', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', WARP_TALON);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    let s = activate(ctx, state, id);
    s = settle(ctx, act(ctx, s, id, 'Fight', { meleeWeaponName: 'Lightning claws', targetId: foeId }).state);
    if (!s.operatives[foeId]!.removed) {
      const again = getAction(ASTARTES_FIGHT)!.check(ctx, s, s.operatives[id]!, {
        meleeWeaponName: 'Lightning claws',
        targetId: foeId,
      });
      expect(again.ok).toBe(true);
    }
    // Having fought, the Astartes SHOOT half is closed.
    expect(
      getAction(ASTARTES_SHOOT)!.check(ctx, s, s.operatives[id]!, { weaponName: 'Bolt pistol', targetId: foeId }).reason,
    ).toContain('either two Shoot actions or two Fight actions');
  });

  it('ENGINE GAP — "Each friendly MURDERWING operative can counteract regardless of its order" is not implemented', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', RAPTOR);
    for (const op of Object.values(state.operatives)) {
      op.ready = false;
      op.expended = true;
      op.order = 'conceal';
    }
    // `counteractCandidates` filters on `order === 'engage'` BEFORE emitting `onCounteract`,
    // and the hook can only forbid — so a Conceal-order MURDERWING operative can never be
    // offered. Pinned here so the seam is visible if the engine ever gains one.
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).not.toContain(id);
    state.operatives[id]!.order = 'engage';
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id)).toContain(id);
    expect(rule('murderwing.rule.astartes')).toContain('can counteract regardless of its order');
  });
});

// ---------------------------------------------------------------------------
describe('CHAOS LORD — Path to Damnation / Boons of Damnation', () => {
  it('"This operative starts the battle with 1 Damnation point"', () => {
    const { state } = setup();
    expect(damnationPoints(state, opWith(state, 'p1', LORD))).toBe(1);
    expect(ability(LORD, 'murderwing.chaos-lord.path-to-damnation')).toContain(
      'This operative starts the battle with 1 Damnation point',
    );
  });

  it('Boon: "you can ignore an amount of damage equal to this operative\'s Damnation points"; Higher gains a point', () => {
    const { ctx, state } = setup({ script: [4] }); // D6 4 > 1 Damnation point → "Higher"
    const lord = state.operatives[opWith(state, 'p1', LORD)]!;
    state.sequence = null;
    const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: lord, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(3); // 4 − 1 Damnation point
    expect(damnationPoints(state, lord.id)).toBe(2); // "then this operative gains 1 Damnation point"
    expect(ability(LORD, 'murderwing.chaos-lord.boons-of-damnation')).toContain(
      'you can ignore an amount of damage equal to this operative’s Damnation points',
    );
  });

  it('"Equal: Do not resolve the rule" — and damage under 3 never triggers a Boon', () => {
    const { ctx, state } = setup({ script: [1] }); // D6 1 equals 1 Damnation point
    const lord = state.operatives[opWith(state, 'p1', LORD)]!;
    const equal = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: lord, amount: 5, kind: 'attack' });
    expect(equal.amount).toBe(5);
    expect(damnationPoints(state, lord.id)).toBe(1);
    const small = ctx.hooks.emit('onDamage', state, { state, ctx: null, target: lord, amount: 2, kind: 'attack' });
    expect(small.amount).toBe(2);
    expect(ability(LORD, 'murderwing.chaos-lord.path-to-damnation')).toContain('Equal: Do not resolve the rule');
  });

  it('Boon: "when … you strike with an attack dice, you can inflict an amount of additional damage equal to … Damnation points"', () => {
    const { ctx, state } = setup({ script: [5] });
    park(state);
    const lordId = opWith(state, 'p1', LORD);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, lordId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.4, y: 5 });
    const s = activate(ctx, state, lordId);
    const started = getAction('Fight')!.perform(ctx, s, s.operatives[lordId]!, {
      meleeWeaponName: 'Power weapon',
      targetId: foeId,
    });
    expect(started.ok).toBe(true);
    const ev = ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target: s.operatives[foeId]!, amount: 4, kind: 'attack' });
    expect(ev.amount).toBe(5); // 4 + 1 Damnation point
  });
});

// ---------------------------------------------------------------------------
describe('CHAMPION — Chaos Champion / Path to Glory', () => {
  it('the STRATEGIC GAMBIT places the Challenge token and grants the chosen melee weapon rule', () => {
    const { ctx, state } = setup();
    park(state);
    const champId = opWith(state, 'p1', CHAMPION);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, champId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const options: { id: string }[] = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] })
      .options;
    expect(options.map((o) => o.id)).toContain(CHAOS_CHAMPION_GAMBIT);

    const profile = profileOf(CHAMPION, 'Power weapon');
    const before = effectiveRules(ctx, state, profile, {
      operative: state.operatives[champId]!,
      target: state.operatives[foeId]!,
      weaponName: 'Power weapon',
    });
    expect(before.some((r) => r.id === 'Shock')).toBe(false);

    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: CHAOS_CHAMPION_GAMBIT, data: { operativeId: foeId, choice: 'Shock' } },
      ctx,
    ).state;
    const after = effectiveRules(ctx, s, profile, {
      operative: s.operatives[champId]!,
      target: s.operatives[foeId]!,
      weaponName: 'Power weapon',
    });
    expect(after.some((r) => r.id === 'Shock')).toBe(true);
    // Not against an operative without the token.
    const other = s.operatives[opWith(s, 'p2', SKYSEAR)]!;
    const none = effectiveRules(ctx, s, profile, {
      operative: s.operatives[champId]!,
      target: other,
      weaponName: 'Power weapon',
    });
    expect(none.some((r) => r.id === 'Shock')).toBe(false);
    expect(ability(CHAMPION, CHAOS_CHAMPION_GAMBIT)).toContain('Balanced, Brutal, Punishing, Severe, Shock');
  });

  it('Path to Glory: "Whenever this operative incapacitates an enemy operative that has your Challenge token, you gain 1CP"', () => {
    const { ctx, state } = setup();
    park(state);
    const champId = opWith(state, 'p1', CHAMPION);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, champId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    let s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: CHAOS_CHAMPION_GAMBIT, data: { operativeId: foeId } },
      ctx,
    ).state;
    s = activate(ctx, s, champId);
    const started = getAction('Fight')!.perform(ctx, s, s.operatives[champId]!, {
      meleeWeaponName: 'Power weapon',
      targetId: foeId,
    });
    expect(started.ok).toBe(true);
    const cpBefore = s.teams.p1.cp;
    inflictDamage(ctx, s, s.operatives[foeId]!, 99, 'attack');
    expect(s.teams.p1.cp).toBe(cpBefore + 1);
    expect(ability(CHAMPION, 'murderwing.champion.path-to-glory')).toContain('you gain 1CP');
  });
});

// ---------------------------------------------------------------------------
describe('CURSECLAW — Frenzied Attack / SNATCH', () => {
  it('"If this operative is incapacitated during the Fight action, you can strike … with one of your unresolved successes"', () => {
    const { ctx, state } = setup();
    park(state);
    const clawId = opWith(state, 'p1', CURSECLAW);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, clawId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    let s = activate(ctx, state, foeId);
    const started = getAction('Fight')!.perform(ctx, s, s.operatives[foeId]!, {
      meleeWeaponName: 'Chainsword',
      targetId: clawId,
    });
    expect(started.ok).toBe(true);
    const seq = s.sequence!;
    if (seq.kind !== 'fight') throw new Error('expected a fight');
    // Guarantee the CURSECLAW holds an unresolved success and dies.
    seq.defenderPool.dice = [{ id: 1, value: 6, state: 'crit', rolled: true }];
    const foeWounds = s.operatives[foeId]!.wounds;
    inflictDamage(ctx, s, s.operatives[clawId]!, 99, 'attack');
    // Mutated claws crit for 5.
    expect(s.operatives[foeId]!.wounds).toBe(foeWounds - profileOf(CURSECLAW, 'Mutated claws').dmgC);
    expect(ability(CURSECLAW, 'murderwing.curseclaw.frenzied-attack')).toContain(
      'before this operative is removed from the killzone',
    );
  });

  it('SNATCH: "If your result is higher, remove that enemy operative … and set it back up within this operative\'s BOOST ZONE or control range"', () => {
    // The BOOST costs no dice; SNATCH then rolls 6 (mine) vs 1 (theirs) — both Wounds 14.
    const { ctx, state } = setup({ script: [6, 1] });
    park(state);
    const clawId = opWith(state, 'p1', CURSECLAW);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, clawId, { x: 5, y: 5 });
    place(state, foeId, { x: 8, y: 5 });
    let s = activate(ctx, state, clawId);
    s = act(ctx, s, clawId, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).state;
    const before = { ...s.operatives[foeId]!.pos };
    const out = act(ctx, s, clawId, 'murderwing.curseclaw.act.snatch', { targetOperativeId: foeId });
    expect(out.ok).toBe(true);
    const after = out.state.operatives[foeId]!.pos;
    expect(after).not.toEqual(before);
    // "cannot be set up further away from this operative than where it began"
    const claw = out.state.operatives[clawId]!;
    const d = (p: Vec2): number => Math.hypot(p.x - claw.pos.x, p.y - claw.pos.y);
    expect(d(after)).toBeLessThanOrEqual(d(before) + 1e-6);
    expect(uniqueText(CURSECLAW, 'murderwing.curseclaw.act.snatch')).toContain(
      'cannot be set up further away from this operative than where it began',
    );
  });
});

// ---------------------------------------------------------------------------
describe('DEPREDATOR — Horrifying Dismemberment / CARVING BLOW', () => {
  it('"select one other enemy operative visible to and within 3" … Subtract 1 from that … APL stat"', () => {
    const { ctx, state } = setup();
    park(state);
    const depId = opWith(state, 'p1', DEPREDATOR);
    const foeId = opWith(state, 'p2', RAPTOR);
    const otherId = opWith(state, 'p2', SKYSEAR);
    place(state, depId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    place(state, otherId, { x: 7.6, y: 5 });
    let s = activate(ctx, state, depId);
    const started = getAction('Fight')!.perform(ctx, s, s.operatives[depId]!, {
      meleeWeaponName: 'Great chainaxe',
      targetId: foeId,
    });
    expect(started.ok).toBe(true);
    expect(aplOf(ctx, s, s.operatives[otherId]!)).toBe(3);
    inflictDamage(ctx, s, s.operatives[foeId]!, 99, 'attack');
    expect(aplOf(ctx, s, s.operatives[otherId]!)).toBe(2);
    expect(ability(DEPREDATOR, 'murderwing.depredator.horrifying-dismemberment')).toContain(
      'Subtract 1 from that enemy operative’s APL stat until the end of its next activation',
    );
  });

  it('CARVING BLOW: "Inflict 2D3 damage on each other operative visible to and within 2""', () => {
    const { ctx, state } = setup({ script: [4, 4, 4, 4] }); // D3 = ceil(4/2) = 2 each
    park(state);
    const depId = opWith(state, 'p1', DEPREDATOR);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, depId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.4, y: 5 });
    let s = activate(ctx, state, depId);
    const before = s.operatives[foeId]!.wounds;
    const out = act(ctx, s, depId, 'murderwing.depredator.act.carving-blow', {});
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foeId]!.wounds).toBe(before - 4);
    expect(uniqueText(DEPREDATOR, 'murderwing.depredator.act.carving-blow')).toContain(
      'Inflict 2D3 damage on each other operative visible to and within 2" of this operative',
    );
  });

  it('CARVING BLOW: "cannot perform this action while it has a Conceal order"', () => {
    const { ctx, state } = setup();
    park(state);
    const depId = opWith(state, 'p1', DEPREDATOR);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, depId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.4, y: 5 });
    const s = activate(ctx, state, depId, 'conceal');
    const out = act(ctx, s, depId, 'murderwing.depredator.act.carving-blow', {});
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('Conceal order');
  });
});

// ---------------------------------------------------------------------------
describe('HUNTMASTER — Pinned Prey / STRIKE FROM ABOVE', () => {
  it('"If any result is a 4+, that enemy operative cannot perform that action during that activation"', () => {
    const { ctx, state } = setup({ script: [5, 5] });
    park(state);
    const huntId = opWith(state, 'p1', HUNTMASTER);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, huntId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    const s = activate(ctx, state, foeId);
    const fallBack = availableActions(ctx, s, s.operatives[foeId]!).find((a) => a.def.id === 'Fall Back')!;
    expect(fallBack.ok).toBe(false);
    expect(fallBack.reason).toContain('Pinned Prey');
    expect(ability(HUNTMASTER, 'murderwing.huntmaster.pinned-prey')).toContain(
      'that enemy operative cannot perform that action during that activation/counteraction',
    );
  });

  it('Pinned Prey does nothing when another enemy operative is also within the HUNTMASTER\'s control range', () => {
    const { ctx, state } = setup({ script: [5, 5] });
    park(state);
    const huntId = opWith(state, 'p1', HUNTMASTER);
    const foeId = opWith(state, 'p2', RAPTOR);
    const otherId = opWith(state, 'p2', SKYSEAR);
    place(state, huntId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    place(state, otherId, { x: 5, y: 6.2 });
    const s = activate(ctx, state, foeId);
    const fallBack = availableActions(ctx, s, s.operatives[foeId]!).find((a) => a.def.id === 'Fall Back')!;
    expect(fallBack.ok).toBe(true);
    expect(ability(HUNTMASTER, 'murderwing.huntmaster.pinned-prey')).toContain(
      'if no other enemy operatives are within this operative’s control range',
    );
  });

  it('STRIKE FROM ABOVE: "Inflict 2D3+1 damage on one enemy operative within this operative\'s BOOST ZONE"', () => {
    const { ctx, state } = setup({ script: [6, 6] }); // D3 = 3 each → 2D3+1 = 7
    park(state);
    const huntId = opWith(state, 'p1', HUNTMASTER);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, huntId, { x: 5, y: 5 });
    place(state, foeId, { x: 8, y: 5 });
    let s = activate(ctx, state, huntId);
    s = act(ctx, s, huntId, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).state;
    const before = s.operatives[foeId]!.wounds;
    const out = act(ctx, s, huntId, 'murderwing.huntmaster.act.strike-from-above', { targetOperativeId: foeId });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foeId]!.wounds).toBe(before - 7);
  });
});

// ---------------------------------------------------------------------------
describe('RAPTOR — Thrill of Flight', () => {
  it('"You can remove any changes to its APL stat" and "ignore any changes to its stats from being injured"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    const raptor = state.operatives[id]!;
    raptor.aplMods.push(-1);
    raptor.wounds = 6; // fewer than half of 14 → injured
    let s = activate(ctx, state, id);
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(2);
    expect(moveOf(ctx, s, s.operatives[id]!)).toBe(4); // 6 − 2 injured
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 8, y: 5 } }).state;
    expect(aplOf(ctx, s, s.operatives[id]!)).toBe(3);
    expect(moveOf(ctx, s, s.operatives[id]!)).toBe(6);
    expect(hitOf(ctx, s, s.operatives[id]!, profileOf(RAPTOR, 'Chainsword'))).toBe(3);
    expect(ability(RAPTOR, 'murderwing.raptor.thrill-of-flight')).toContain(
      'You can ignore any changes to its stats from being injured',
    );
  });
});

// ---------------------------------------------------------------------------
describe('SHRIEKER — Modified Vox-casters / SHRIEK', () => {
  it('"your opponent must spend 1 additional AP for that enemy operative to perform the Pick Up Marker and mission actions"', () => {
    const { ctx, state } = setup();
    park(state);
    const shriekId = opWith(state, 'p1', SHRIEKER);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, shriekId, { x: 5, y: 5 });
    place(state, foeId, { x: 10, y: 5 }); // base-to-base 3.7" away
    const cost = (s: GameState, id: string): number =>
      ctx.hooks.emit('onActionCost', s, { state: s, operative: s.operatives[id]!, action: 'Pick Up Marker', ap: 1 }).ap;
    expect(cost(state, foeId)).toBe(1);
    place(state, foeId, { x: 7, y: 5 }); // base gap 1.4" → within 3"
    expect(cost(state, foeId)).toBe(2);
    expect(ability(SHRIEKER, 'murderwing.shrieker.modified-vox-casters')).toContain(
      'must spend 1 additional AP for that enemy operative to perform the Pick Up Marker and mission actions',
    );
  });

  it('"treat the total APL stat of enemy operatives that contest it as 1 lower"', () => {
    const { ctx, state } = setup();
    park(state);
    const shriekId = opWith(state, 'p1', SHRIEKER);
    const mineId = opWith(state, 'p1', SKYSEAR);
    const foeId = opWith(state, 'p2', RAPTOR);
    const foe2Id = opWith(state, 'p2', SKYSEAR);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 15, y: 11 }, z: 0, flags: {} };
    place(state, foeId, { x: 15, y: 12 });
    place(state, foe2Id, { x: 15, y: 10 });
    place(state, mineId, { x: 14, y: 11 });
    place(state, shriekId, { x: 25, y: 20 });
    // 6 enemy APL vs 3 friendly APL — the enemy controls it.
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p2');
    place(state, shriekId, { x: 15, y: 13.4 }); // within 3" of one contesting enemy
    expect(
      ctx.hooks.emit('onMarkerControl', state, { state, markerId: 'obj', aplByPlayer: { p1: 3, p2: 6 } }).aplByPlayer.p2,
    ).toBe(5);
  });

  it('SHRIEK: "Inflict D3 damage on the selected operative and subtract 1 from its APL stat"', () => {
    const { ctx, state } = setup({ script: [6] }); // D3 = 3
    park(state);
    const shriekId = opWith(state, 'p1', SHRIEKER);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, shriekId, { x: 5, y: 5 });
    place(state, foeId, { x: 10, y: 5 });
    let s = activate(ctx, state, shriekId);
    const before = s.operatives[foeId]!.wounds;
    const out = act(ctx, s, shriekId, 'murderwing.shrieker.act.shriek', { targetOperativeId: foeId });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foeId]!.wounds).toBe(before - 3);
    expect(aplOf(ctx, out.state, out.state.operatives[foeId]!)).toBe(2);
  });

  it('SHRIEK: "Alternatively, select one enemy operative within this operative\'s BOOST ZONE (at which point this becomes a BOOST action)"', () => {
    const map = testMap({ features: [heavyBlock('wall', 7.6, 3, 1, 4, 3)] });
    const { ctx, state } = setup({ map, equipment: ['murderwing.eq.bladefins'], script: [6] });
    park(state);
    const id = opWith(state, 'p1', SHRIEKER);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 4, y: 5 });
    place(state, foeId, { x: 7, y: 5 });
    let s = activate(ctx, state, id);
    const boost = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 10, y: 5 } });
    expect(boost.ok).toBe(true);
    s = boost.state;
    // The wall now hides the target, so only the BOOST ZONE clause is left…
    expect(inBoostZone(ctx, s, s.operatives[id]!, s.operatives[foeId]!)).toBe(true);
    const out = act(ctx, s, id, 'murderwing.shrieker.act.shriek', { targetOperativeId: foeId });
    expect(out.ok).toBe(true);
    // …and it spent this activation's one BOOST action.
    const second = act(ctx, out.state, id, 'SLICE FROM ABOVE', { targetOperativeId: foeId });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('more than one BOOST action');
    expect(uniqueText(SHRIEKER, 'murderwing.shrieker.act.shriek')).toContain(
      'at which point this becomes a BOOST action',
    );
  });

  it('SHRIEK: "If enemy operatives are within control range of this operative, you cannot select an enemy operative that isn\'t"', () => {
    const { ctx, state } = setup();
    park(state);
    const shriekId = opWith(state, 'p1', SHRIEKER);
    const nearId = opWith(state, 'p2', RAPTOR);
    const farId = opWith(state, 'p2', SKYSEAR);
    place(state, shriekId, { x: 5, y: 5 });
    place(state, nearId, { x: 6.2, y: 5 });
    place(state, farId, { x: 9, y: 5 });
    const s = activate(ctx, state, shriekId);
    const out = act(ctx, s, shriekId, 'murderwing.shrieker.act.shriek', { targetOperativeId: farId });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('within this operative’s control range');
  });
});

// ---------------------------------------------------------------------------
describe('WARP TALON — Slice the Veil (reminder only)', () => {
  it('is not bound to any hook: the engine has no reserve state and no set-up decision channel', () => {
    const { state } = setup();
    const id = opWith(state, 'p1', WARP_TALON);
    // Nothing puts it "in the warp": it is deployed like any other operative.
    expect(state.operatives[id]!.removed).toBeFalsy();
    expect(state.effects.filter((e) => e.rule.includes('warp'))).toHaveLength(0);
    expect(ability(WARP_TALON, 'murderwing.warp-talon.slice-the-veil')).toContain(
      'you can set it up in the warp instead: place it to one side instead of in the killzone',
    );
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  it('PREDATORS ABOVE: "…at least 2" higher than the killzone floor, its weapons have the Balanced weapon rule"', () => {
    const map = testMap({ features: [vantagePlatform('vp', 8, 3, 6, 6, 3)] });
    const { ctx, state } = setup({ map });
    park(state);
    const id = opWith(state, 'p1', SKYSEAR);
    place(state, id, { x: 10, y: 5 }, 3);
    const profile = profileOf(SKYSEAR, 'Bolt pistol');
    const rules = (s: GameState) =>
      effectiveRules(ctx, s, profile, { operative: s.operatives[id]!, weaponName: 'Bolt pistol' });
    expect(rules(state).some((r) => r.id === 'Balanced')).toBe(false);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'murderwing.sp.predators-above' }, ctx).state;
    expect(rules(s).some((r) => r.id === 'Balanced')).toBe(true);
    // On the floor it is off again…
    s.operatives[id]!.z = 0;
    s.operatives[id]!.pos = { x: 20, y: 5 };
    expect(rules(s).some((r) => r.id === 'Balanced')).toBe(false);
    expect(rule('murderwing.sp.predators-above')).toContain('its weapons have the Balanced weapon rule');
  });

  it('PREDATORS ABOVE: "…does a BOOST, its weapons have the Balanced weapon rule until the end of that activation"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'murderwing.sp.predators-above' }, ctx).state;
    const profile = profileOf(SKYSEAR, 'Bolt pistol');
    const rules = (x: GameState) =>
      effectiveRules(ctx, x, profile, { operative: x.operatives[id]!, weaponName: 'Bolt pistol' });
    s = activate(ctx, s, id);
    expect(rules(s).some((r) => r.id === 'Balanced')).toBe(false);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 9, y: 5 } }).state;
    expect(rules(s).some((r) => r.id === 'Balanced')).toBe(true);
  });

  it('CULL THE WEAK: Punishing when the target "is at least 2" lower" or "its APL stat is less than normal"', () => {
    const map = testMap({ features: [vantagePlatform('vp', 3, 3, 6, 6, 3)] });
    const { ctx, state } = setup({ map });
    park(state);
    const id = opWith(state, 'p1', SKYSEAR);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 5, y: 5 }, 3);
    place(state, foeId, { x: 12, y: 5 }, 0);
    const profile = profileOf(SKYSEAR, 'Bolt pistol');
    const rules = (s: GameState) =>
      effectiveRules(ctx, s, profile, {
        operative: s.operatives[id]!,
        target: s.operatives[foeId]!,
        weaponName: 'Bolt pistol',
      });
    expect(rules(state).some((r) => r.id === 'Punishing')).toBe(false);
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'murderwing.sp.cull-the-weak' }, ctx).state;
    expect(rules(s).some((r) => r.id === 'Punishing')).toBe(true);

    // Level ground, full APL → no Punishing; a −1 APL target brings it back.
    s.operatives[id]!.z = 0;
    expect(rules(s).some((r) => r.id === 'Punishing')).toBe(false);
    s.operatives[foeId]!.aplMods.push(-1);
    expect(rules(s).some((r) => r.id === 'Punishing')).toBe(true);
    expect(rule('murderwing.sp.cull-the-weak')).toContain('Its APL stat is less than normal');
  });

  it('NIGHTMARE ON HIGH: "…that did a BOOST during this turning point, you can re-roll one of your defence dice"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 15, y: 5 });
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'murderwing.sp.nightmare-on-high' }, ctx).state;
    const grants = (x: GameState): RerollGrant[] =>
      ctx.hooks.emit('onDefenceDice', x, {
        state: x,
        ctx: {
          attacker: x.operatives[foeId]!,
          defender: x.operatives[id]!,
          weaponName: 'Bolt pistol',
          profile: profileOf(SKYSEAR, 'Bolt pistol'),
          rules: [],
          type: 'ranged',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 10,
        },
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls;
    expect(grants(s)).toHaveLength(0);
    s = activate(ctx, s, id);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 9, y: 5 } }).state;
    expect(grants(s).map((g) => g.id)).toContain('murderwing.nightmareOnHigh');
    expect(rule('murderwing.sp.nightmare-on-high')).toContain('you can re-roll one of your defence dice');
  });

  it('INSTIL FEAR: "Whenever a friendly MURDERWING operative is fighting, Normal Dmg of 3 or more inflicts 1 less damage on it"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', DEPREDATOR); // Great chainaxe: Normal Dmg 5
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'murderwing.sp.instil-fear' }, ctx).state;
    s = activate(ctx, s, id);
    const started = getAction('Fight')!.perform(ctx, s, s.operatives[id]!, {
      meleeWeaponName: 'Chainsword',
      targetId: foeId,
    });
    expect(started.ok).toBe(true);
    const ev = ctx.hooks.emit('onDamage', s, { state: s, ctx: null, target: s.operatives[id]!, amount: 5, kind: 'attack' });
    expect(ev.amount).toBe(4);
    expect(rule('murderwing.sp.instil-fear')).toContain('Normal Dmg of 3 or more inflicts 1 less damage on it');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  it('MALICIOUS NARCISSISM is only usable "if only one friendly MURDERWING operative is ready", and blocks counteracting', () => {
    const { ctx, state } = setup();
    const ploy = murderwing.ploys.find((p) => p.id === 'murderwing.fp.malicious-narcissism')!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false); // nine are ready
    const keepId = opWith(state, 'p1', RAPTOR);
    for (const op of Object.values(state.operatives)) {
      if (op.player !== 'p1' || op.id === keepId) continue;
      op.ready = false;
      op.expended = true;
      op.order = 'engage';
    }
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'murderwing.fp.malicious-narcissism' }, ctx).state;
    // "you cannot counteract until that friendly MURDERWING operative is expended"
    expect(counteractCandidates(ctx, s, 'p1')).toHaveLength(0);
    s.operatives[keepId]!.expended = true;
    s.operatives[keepId]!.ready = false;
    expect(counteractCandidates(ctx, s, 'p1').length).toBeGreaterThan(0);
    expect(rule('murderwing.fp.malicious-narcissism')).toContain(
      'you cannot counteract until that friendly MURDERWING operative is expended',
    );
  });

  it('MURDEROUS DESCENT: "immediately perform a free Charge action … It must end that action within control range of that enemy operative"', () => {
    const map = testMap({ features: [vantagePlatform('vp', 8, 3, 5, 5, 3)] });
    const { ctx, state } = setup({ map });
    park(state);
    const diverId = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, diverId, { x: 10, y: 5 }, 3);
    place(state, foeId, { x: 12, y: 5 }, 0);
    let s = activate(ctx, state, foeId);
    const ploy = murderwing.ploys.find((p) => p.id === 'murderwing.fp.murderous-descent')!;
    expect(ploy.usable!(s, 'p1').ok).toBe(false); // it has not moved yet
    s.operatives[foeId]!.actionsThisActivation.push('Reposition');
    expect(descentCandidates(s, 'p1').map((o) => o.id)).toEqual([diverId]);
    const cp = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'murderwing.fp.murderous-descent' }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp - 1);
    const diver = s.operatives[diverId]!;
    const gap = Math.hypot(diver.pos.x - 12, diver.pos.y - 5) - (32 / 25.4 / 2) * 2;
    expect(gap).toBeLessThanOrEqual(1 + 1e-6);
    expect(rule('murderwing.fp.murderous-descent')).toContain('immediately perform a free Charge action');
  });

  it('MURDEROUS DESCENT: "If this isn\'t possible, the interruption is cancelled and this rule hasn\'t been used"', () => {
    const { ctx, state } = setup();
    park(state);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, foeId, { x: 12, y: 5 });
    let s = activate(ctx, state, foeId);
    s.operatives[foeId]!.actionsThisActivation.push('Reposition');
    const cp = s.teams.p1.cp;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'murderwing.fp.murderous-descent' }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp); // refunded
    expect(s.teams.p1.ploysUsedTP).not.toContain('murderwing.fp.murderous-descent');
  });

  it('LONG FORGOTTEN HONOUR: "end that sequence (any remaining attack dice are discarded) and immediately perform a free Fall Back action up to 3""', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', WARP_TALON);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    let s = activate(ctx, state, id);
    const started = getAction('Fight')!.perform(ctx, s, s.operatives[id]!, {
      meleeWeaponName: 'Lightning claws',
      targetId: foeId,
    });
    expect(started.ok).toBe(true);
    const seq = s.sequence!;
    if (seq.kind !== 'fight') throw new Error('expected a fight');
    seq.attackerPool.dice = [{ id: 1, value: 6, state: 'crit', rolled: true }];
    const ploy = murderwing.ploys.find((p) => p.id === 'murderwing.fp.long-forgotten-honour')!;
    expect(ploy.usable!(s, 'p1').ok).toBe(true);
    const before = { ...s.operatives[id]!.pos };
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'murderwing.fp.long-forgotten-honour' }, ctx).state;
    expect(s.sequence).toBeNull();
    expect(s.pending.filter((p) => p.kind === 'strikeOrBlock')).toHaveLength(0);
    const moved = Math.hypot(s.operatives[id]!.pos.x - before.x, s.operatives[id]!.pos.y - before.y);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(3 + 1e-6);
    expect(rule('murderwing.fp.long-forgotten-honour')).toContain('immediately perform a free Fall Back action up to 3"');
  });

  it('WINGS OF DARKNESS: "an additional 3" away during that BOOST … but it cannot perform the Shoot, Fight or Carving Blow action"', () => {
    const { ctx, state } = setup();
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    const ploy = murderwing.ploys.find((p) => p.id === 'murderwing.fp.wings-of-darkness')!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false); // "You cannot use this ploy during the first turning point."
    state.turningPoint = 2;
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    let s = activate(ctx, state, id);
    expect(act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 13, y: 5 } }).ok).toBe(false);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'murderwing.fp.wings-of-darkness' }, ctx).state;
    const out = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 14, y: 5 } }); // 9" = 6 + 3
    expect(out.ok).toBe(true);
    const shoot = availableActions(ctx, out.state, out.state.operatives[id]!).find((a) => a.def.id === 'Shoot')!;
    expect(shoot.ok).toBe(false);
    expect(shoot.reason).toContain('Wings of Darkness');
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('BLADEFINS: "SLICE FROM ABOVE 1AP … Inflict D3+1 damage on one enemy operative within this operative\'s BOOST ZONE"', () => {
    const { ctx, state } = setup({ equipment: ['murderwing.eq.bladefins'], script: [6] }); // D3 = 3
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 8, y: 5 });
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BOOST_REPOSITION, { targetPos: { x: 11, y: 5 } }).state;
    const before = s.operatives[foeId]!.wounds;
    const out = act(ctx, s, id, 'SLICE FROM ABOVE', { targetOperativeId: foeId });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foeId]!.wounds).toBe(before - 4);
    expect(rule('murderwing.eq.bladefins')).toContain('Inflict D3+1 damage on one enemy operative within this operative’s BOOST ZONE');
  });

  it('BLADEFINS is not available to a kill team that did not select it', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', RAPTOR);
    expect(getAction('SLICE FROM ABOVE')!.available!(ctx, state, state.operatives[id]!)).toBe(false);
  });

  it('CLAWED ARMOUR: "CLAWED CHARGE 0AP … Inflict 1 damage on one enemy operative within this operative\'s control range"', () => {
    const { ctx, state } = setup({ equipment: ['murderwing.eq.clawed-armour'] });
    park(state);
    const id = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 10.4, y: 5 });
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BOOST_CHARGE, { targetPos: { x: 9.2, y: 5 } }).state;
    const before = s.operatives[foeId]!.wounds;
    const out = act(ctx, s, id, 'CLAWED CHARGE', { targetOperativeId: foeId });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[foeId]!.wounds).toBe(before - 1);
    expect(getAction('CLAWED CHARGE')!.ap).toBe(0);
    // "it performs this action during the Charge action after setting up from a BOOST"
    expect(rule('murderwing.eq.clawed-armour')).toContain('during the Charge action after setting up from a BOOST');
  });

  it('WARP FUEL: "One of those friendly operatives can immediately perform a free Reposition or Charge action, but cannot use more than 3" of move distance"', () => {
    const { ctx, state } = setup({ equipment: ['murderwing.eq.warp-fuel'] });
    park(state);
    const mineId = opWith(state, 'p1', RAPTOR);
    const foeId = opWith(state, 'p2', SKYSEAR);
    place(state, mineId, { x: 5, y: 5 });
    place(state, foeId, { x: 6.2, y: 5 });
    let s = activate(ctx, state, foeId);
    s = act(ctx, s, foeId, 'Fall Back', { path: { points: [{ x: 11, y: 5 }] } }).state;
    expect(s.operatives[foeId]!.actionsThisActivation).toContain('Fall Back');
    s = reduce(s, { t: 'EndActivation', operativeId: foeId }, ctx).state;
    // The grant is one extra AP restricted to Reposition/Charge (docs/DECISIONS.md D-015).
    s = activate(ctx, s, mineId);
    const mine = s.operatives[mineId]!;
    expect(aplOf(ctx, s, mine)).toBe(4);
    mine.apSpent = 3; // spending the bonus AP now
    expect(moveBudget(ctx, s, mine, { action: 'Reposition' })).toBe(3);
    expect(rule('murderwing.eq.warp-fuel')).toContain('cannot use more than 3" of move distance');
  });

  it('VOX-CASTERS: "Each enemy operative within 3" of this operative takes a stun test … on a 3+, subtract 1 from its APL stat"', () => {
    const { ctx, state } = setup({ equipment: ['murderwing.eq.vox-casters'], script: [5, 1] });
    park(state);
    const id = opWith(state, 'p1', SHRIEKER);
    const aId = opWith(state, 'p2', RAPTOR);
    const bId = opWith(state, 'p2', SKYSEAR);
    place(state, id, { x: 5, y: 5 });
    place(state, aId, { x: 7, y: 5 });
    place(state, bId, { x: 5, y: 7 });
    let s = activate(ctx, state, id);
    const out = act(ctx, s, id, 'VOX-CRY', {});
    expect(out.ok).toBe(true);
    const stunned = [aId, bId].map((x) => aplOf(ctx, out.state, out.state.operatives[x]!)).sort();
    expect(stunned).toEqual([2, 3]); // one 5 (stunned), one 1 (not)
  });

  it('VOX-CRY: "An operative cannot perform this action while it has a Conceal order"', () => {
    const { ctx, state } = setup({ equipment: ['murderwing.eq.vox-casters'] });
    park(state);
    const id = opWith(state, 'p1', SHRIEKER);
    const foeId = opWith(state, 'p2', RAPTOR);
    place(state, id, { x: 5, y: 5 });
    place(state, foeId, { x: 7, y: 5 });
    const s = activate(ctx, state, id, 'conceal');
    const out = act(ctx, s, id, 'VOX-CRY', {});
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('Conceal order');
  });
});

// ---------------------------------------------------------------------------
describe('bot-vs-bot: MURDERWING produces no rejected intents', () => {
  const maps = (): string[] => {
    const all = realMaps();
    const volkus = all.find((m) => m.killzone === 'volkus');
    const gallowdark = all.find((m) => m.killzone === 'gallowdark');
    const fallback = all.slice(0, 2);
    return [volkus?.id ?? fallback[0]!.id, gallowdark?.id ?? fallback[1]!.id];
  };

  for (const [n, mapId] of maps().entries()) {
    it(`plays a full four-turning-point game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const foe = kasrkin;
      const seed = 4242 + n;
      const ctx = teamContext([murderwing, foe], { seed });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const result = playGame({
        ctx,
        map,
        seed,
        rosters: {
          p1: {
            teamId: murderwing.id,
            operatives: defaultRoster(murderwing.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: murderwing.equipment.slice(0, 2).map((e) => e.id),
          },
          p2: {
            teamId: foe.id,
            operatives: defaultRoster(foe.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: foe.equipment.slice(0, 2).map((e) => e.id),
          },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
    }, 120_000);
  }
});
