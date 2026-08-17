/**
 * NEMESIS CLAW. Every test quotes the printed rule it pins, read out of
 * `data/teams/nemesis-claw.json`.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/nemesis-claw/
 */
import { describe, expect, it } from 'vitest';
import { availableActions } from '../../src/core/actions.ts';
import { newPool, addRolled } from '../../src/core/dice.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { counteractCandidates, whoActivates } from '../../src/core/phases.ts';
import { aplOf, inflictDamage, markerController } from '../../src/core/state.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import { angelOfDeath } from '../../src/teams/angel-of-death/index.ts';
import { nemesisClaw, TERRORCHEM, GRISLY_TROPHY_TOKEN, prescience } from '../../src/teams/nemesis-claw/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import { activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';

const DATA = teamData('nemesis-claw');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const card = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const ability = (cardId: string, abilityId: string): string =>
  card(cardId).abilities.find((a) => a.id === abilityId)!.text;
const uniqueActionText = (cardId: string, actionId: string): string =>
  card(cardId).uniqueActions.find((a) => a.id === actionId)!.text;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = card(cardId).weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

const VISIONARY = 'nemesis-claw.night-lord-visionary';
const FEARMONGER = 'nemesis-claw.night-lord-fearmonger';
const GUNNER = 'nemesis-claw.night-lord-gunner';
const SCREECHER = 'nemesis-claw.night-lord-screecher';
const SKINTHIEF = 'nemesis-claw.night-lord-skinthief';
const VENTRILOKAR = 'nemesis-claw.night-lord-ventrilokar';
const WARRIOR = 'nemesis-claw.night-lord-warrior';

type Ctx = ReturnType<typeof teamContext>;

function setup(
  opts: { equipment?: string[]; include?: string[]; foe?: typeof kasrkin; script?: number[]; map?: ReturnType<typeof testMap> } = {},
): { ctx: Ctx; state: GameState } {
  const foe = opts.foe ?? kasrkin;
  const ctx = teamContext([nemesisClaw, foe], opts.script ? { script: opts.script } : { seed: 7 });
  const picks = opts.include ? rosterIncluding(nemesisClaw, opts.include) : defaultRoster(nemesisClaw.data);
  const state = battle({
    ctx,
    ...(opts.map ? { map: opts.map } : {}),
    p1: { module: nemesisClaw, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: foe },
  });
  return { ctx, state };
}

/** A shoot sequence in flight, so rules that read `state.sequence` can be exercised. */
function shootSequence(state: GameState, attacker: OperativeState, target: OperativeState, weaponName: string): ShootSequence {
  const seq: ShootSequence = {
    kind: 'shoot',
    step: 'rollAttack',
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
    attack: newPool(),
    defence: newPool(),
    usedRerolls: [],
    usedRetention: [],
    damage: 0,
    useCounted: false,
    attacker: attacker.player,
    defender: target.player,
    free: false,
  };
  state.sequence = seq;
  return seq;
}

function fightSequence(
  state: GameState,
  attacker: OperativeState,
  defender: OperativeState,
  weapons: { attacker: string; defender: string },
): FightSequence {
  const seq: FightSequence = {
    kind: 'fight',
    step: 'resolve',
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerWeapon: weapons.attacker,
    defenderWeapon: weapons.defender,
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
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
  state.sequence = seq;
  return seq;
}

function attackCtx(
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
    distance: 0,
  };
}

// ---------------------------------------------------------------------------
describe('NEMESIS CLAW data (pinned against data/teams/nemesis-claw.json)', () => {
  it('has 8 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(8);
    expect(card(VISIONARY)).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 15, base: { shape: 'round', mm: 32 } });
    expect(card(VISIONARY).keywords).toEqual([
      'NEMESIS CLAW',
      'CHAOS',
      'HERETIC ASTARTES',
      'PSYKER',
      'LEADER',
      'VISIONARY',
    ]);
    for (const c of DATA.datacards.filter((x) => x.id !== VISIONARY)) {
      expect(c).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 14, base: { shape: 'round', mm: 32 } });
      expect(c.keywords.slice(0, 3)).toEqual(['NEMESIS CLAW', 'CHAOS', 'HERETIC ASTARTES']);
    }
    expect(card(VENTRILOKAR).keywords).toContain('PSYKER');
  });

  it('pins every weapon profile of the FEARMONGER, including the Terrorchem* rare rule', () => {
    const flat = card(FEARMONGER).weapons.flatMap((w) =>
      w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')),
    );
    expect(flat).toEqual([
      'Scoped bolt pistol|short range|ranged|4|3|3|4',
      'Scoped bolt pistol|long range|ranged|4|3|3|4',
      'Terrorchem vial||ranged|5|3|2|0',
      'Tainted blade||melee|5|3|3|5',
    ]);
    expect(profileOf(FEARMONGER, 'Terrorchem vial').rules.map((r) => r.raw)).toEqual([
      'Range 6"',
      'Blast 2"',
      'Devastating 3',
      'Limited 1',
      'Saturate',
      'Terrorchem*',
    ]);
    expect(profileOf(FEARMONGER, 'Tainted blade').rules.map((r) => r.id)).toContain('Terrorchem');
    expect(DATA.rareWeaponRules).toEqual(['Terrorchem']);
  });

  it('pins the VISIONARY and SCREECHER weapons the rules name', () => {
    expect(profileOf(VISIONARY, 'Plasma pistol', 'supercharge')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(VISIONARY, 'Power fist')).toMatchObject({ atk: 5, hit: 4, dmgN: 5, dmgC: 7 });
    expect(profileOf(SCREECHER, 'Lightning claws')).toMatchObject({ atk: 5, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(SCREECHER, 'Lightning claws').rules.map((r) => r.raw)).toEqual(['Ceaseless', 'Lethal 5+']);
    expect(profileOf(SKINTHIEF, 'Nostraman chainglaive').rules.map((r) => r.id)).toEqual(['Rending']);
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys, 4 equipment, 9 abilities and 3 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Astartes', 'In Midnight Clad']);
    expect(nemesisClaw.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(nemesisClaw.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(nemesisClaw.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(9);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.name)).toEqual([
      'PREMONITION',
      'POISON OBJECTIVE',
      'DISCONCERTING MIMICRY',
    ]);
    // aiHints are a deliverable: without ployValue the AI never uses a firefight ploy.
    expect(Object.keys(nemesisClaw.aiHints?.ployValue ?? {})).toHaveLength(8);
    expect(Object.keys(nemesisClaw.aiHints?.equipmentValue ?? {})).toHaveLength(4);
    expect(Object.keys(nemesisClaw.aiHints?.roles ?? {})).toHaveLength(8);
  });

  it('the printed selection rules accept the default roster ("Other than WARRIOR operatives, your kill team can only include each operative on this list once")', () => {
    const picks = defaultRoster(nemesisClaw.data);
    expect(picks).toHaveLength(6);
    expect(nemesisClaw.validateRoster(picks).ok).toBe(true);
    expect(DATA.selection.rawText).toContain('Other than WARRIOR operatives');
    // Two WARRIORs are legal, two SCREECHERs are not.
    const warrior = (loadout: string) => ({
      datacardId: WARRIOR,
      entryId: 'nemesis-claw.sel7.warrior',
      loadoutIds: [loadout],
    });
    const twoWarriors = [...picks.slice(0, 4), warrior('nemesis-claw.g2e7.opt1'), warrior('nemesis-claw.g2e7.opt2')];
    expect(nemesisClaw.validateRoster(twoWarriors).ok).toBe(true);
    const twoScreechers = [...picks.slice(0, 4), { datacardId: SCREECHER }, { datacardId: SCREECHER }];
    expect(nemesisClaw.validateRoster(twoScreechers).codes).toContain('unique');
  });
});

// ---------------------------------------------------------------------------
describe('Astartes — "it can perform either two Shoot actions or two Fight actions"', () => {
  it('offers a second Shoot only after the first, and only if a bolt pistol, boltgun or scoped bolt pistol is selected for one of them', () => {
    expect(rule('nemesis-claw.rule.astartes')).toContain(
      'a bolt pistol, boltgun or scoped bolt pistol must be selected for at least one of them',
    );
    const { ctx, state } = setup();
    const gunner = opWith(state, 'p1', GUNNER);
    const enemy = opWith(state, 'p2', 'kasrkin.trooper');
    state.operatives[gunner]!.pos = { x: 14, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, gunner);

    const early = reduce(
      s,
      { t: 'PerformAction', operativeId: gunner, action: 'Shoot (Astartes, Nemesis Claw)', params: { weaponName: 'Bolt pistol', targetId: enemy } },
      ctx,
    );
    expect(early.ok).toBe(false);
    expect(early.reason).toMatch(/second Shoot action/);

    s.operatives[gunner]!.actionsThisActivation = ['Shoot'];
    s.effects.push({
      id: 'lastRanged',
      rule: 'nemesisClaw.lastRangedWeapon',
      source: { kind: 'core', id: 'nemesis-claw.rule.astartes' },
      operativeId: gunner,
      player: 'p1',
      data: { weapon: 'Flamer' },
      expiry: { kind: 'endOfActivation', operativeId: gunner },
    });
    const wrong = reduce(
      s,
      { t: 'PerformAction', operativeId: gunner, action: 'Shoot (Astartes, Nemesis Claw)', params: { weaponName: 'Meltagun', targetId: enemy } },
      ctx,
    );
    expect(wrong.reason).toMatch(/bolt pistol, boltgun or scoped bolt pistol/);

    const right = reduce(
      s,
      { t: 'PerformAction', operativeId: gunner, action: 'Shoot (Astartes, Nemesis Claw)', params: { weaponName: 'Bolt pistol', targetId: enemy } },
      ctx,
    );
    expect(right.ok).toBe(true);
    expect(availableActions(ctx, s, s.operatives[gunner]!).some((a) => a.def.id === 'Fight (Astartes, Nemesis Claw)')).toBe(
      true,
    );
  });

  it('a second Fight action cannot follow a Shoot action ("either two Shoot actions or two Fight actions")', () => {
    const { ctx, state } = setup();
    const screecher = opWith(state, 'p1', SCREECHER);
    const enemy = opWith(state, 'p2', 'kasrkin.trooper');
    state.operatives[screecher]!.pos = { x: 14, y: 11 };
    state.operatives[enemy]!.pos = { x: 15.2, y: 11 };
    const s = activate(ctx, state, screecher);
    s.operatives[screecher]!.actionsThisActivation = ['Shoot', 'Fight'];
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: screecher, action: 'Fight (Astartes, Nemesis Claw)', params: { meleeWeaponName: 'Lightning claws', targetId: enemy } },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/either two Shoot actions or two Fight actions/);
  });

  it('"Each friendly NEMESIS CLAW operative can counteract regardless of its order"', () => {
    expect(rule('nemesis-claw.rule.astartes')).toContain(
      'Each friendly NEMESIS CLAW operative can counteract regardless of its order.',
    );
    const { ctx, state } = setup();
    const conceal = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const engage = state.operatives[opWith(state, 'p1', SCREECHER)]!;
    const already = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const guardLocked = state.operatives[opWith(state, 'p1', FEARMONGER)]!;
    // Every NEMESIS CLAW operative is expended, so this is the counteract window.
    for (const id of state.teams.p1.operativeIds) {
      const o = state.operatives[id]!;
      o.expended = true;
      o.ready = false;
      o.counteractedThisTP = false;
      o.order = 'conceal';
    }
    engage.order = 'engage';
    // The conditions the clause does NOT lift: "can counteract once during the turning point",
    // and On Guard's "that friendly operative cannot counteract during the turning point".
    already.counteractedThisTP = true;
    guardLocked.guardSpentTP = state.turningPoint;

    const ids = counteractCandidates(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(conceal.id); // "regardless of its order" — a Conceal order is no bar
    expect(ids).toContain(engage.id); // and an Engage one counteracts as it always did
    expect(ids).not.toContain(already.id);
    expect(ids).not.toContain(guardLocked.id);

    // …so the counteract turn is actually offered, even with the whole team on Conceal.
    state.activePlayer = 'p1';
    expect(whoActivates(state, ctx)).toEqual({ player: 'p1', mode: 'counteract' });

    // The clause names friendly NEMESIS CLAW operatives only. The KASRKIN opposite print no
    // such rule, so an expended Conceal trooper keeps the core's printed Engage-order default.
    const trooper = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    trooper.expended = true;
    trooper.ready = false;
    trooper.counteractedThisTP = false;
    trooper.order = 'conceal';
    expect(counteractCandidates(ctx, state, 'p2').map((o) => o.id)).not.toContain(trooper.id);
    trooper.order = 'engage';
    expect(counteractCandidates(ctx, state, 'p2').map((o) => o.id)).toContain(trooper.id);
  });
});

// ---------------------------------------------------------------------------
describe('In Midnight Clad — "that friendly operative is obscured if both of the following are true"', () => {
  const map = () => testMap({ features: [heavyBlock('h1', 12, 12, 4, 2)] });

  it('obscures a NEMESIS CLAW operative within 1" of Heavy terrain while more than 8" from enemies it is visible to', () => {
    expect(rule('nemesis-claw.rule.in-midnight-clad')).toContain('It’s more than 8" from enemy operatives it’s visible to.');
    const { ctx, state } = setup({ map: map() });
    const target = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const shooter = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    target.pos = { x: 14, y: 11.5 }; // within 1" of the Heavy block at y=12
    shooter.pos = { x: 27, y: 11 };
    const seq = shootSequence(state, shooter, target, 'Hot-shot lasgun');
    const profile = profileOf(SKINTHIEF, 'Bolt pistol');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Hot-shot lasgun', profile, 'ranged'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(true);
  });

  it('does not obscure while an enemy it is visible to is within 8"', () => {
    const { ctx, state } = setup({ map: map() });
    const target = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const shooter = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    target.pos = { x: 14, y: 11.5 };
    shooter.pos = { x: 19, y: 11.5 }; // 5" away and visible
    const seq = shootSequence(state, shooter, target, 'Hot-shot lasgun');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, target, 'Hot-shot lasgun', profileOf(SKINTHIEF, 'Bolt pistol'), 'ranged'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(seq.obscured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('NEMESIS CLAW datacard abilities', () => {
  it('Terrorchem: "if you inflict damage with any critical successes … the operative this weapon is being used against gains one of your Terrorchem tokens"', () => {
    expect(ability(FEARMONGER, 'nemesis-claw.night-lord-fearmonger.terrorchem')).toContain(
      'including as a result of the Devastating weapon rule',
    );
    const { ctx, state } = setup();
    const fearmonger = state.operatives[opWith(state, 'p1', FEARMONGER)]!;
    const victim = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const blade = profileOf(FEARMONGER, 'Tainted blade');
    fightSequence(state, fearmonger, victim, { attacker: 'Tainted blade', defender: 'Gun butt' });
    // A normal success carries no Terrorchem token…
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(fearmonger, victim, 'Tainted blade', blade, 'melee'),
      crit: false,
      struck: victim,
    });
    expect(state.effects.some((e) => e.rule === TERRORCHEM && e.operativeId === victim.id)).toBe(false);
    // …a critical success does.
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(fearmonger, victim, 'Tainted blade', blade, 'melee'),
      crit: true,
      struck: victim,
    });
    expect(state.effects.some((e) => e.rule === TERRORCHEM && e.operativeId === victim.id)).toBe(true);
  });

  it('the Terrorchem vial tokens a target through Devastating alone, even though its Critical Dmg is 0', () => {
    const { ctx, state } = setup();
    const fearmonger = state.operatives[opWith(state, 'p1', FEARMONGER)]!;
    const victim = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const vial = profileOf(FEARMONGER, 'Terrorchem vial');
    const seq = shootSequence(state, fearmonger, victim, 'Terrorchem vial');
    addRolled(seq.attack, [6, 2], 3); // one retained critical success
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(fearmonger, victim, 'Terrorchem vial', vial, 'ranged'),
      crit: false, // the crit was blocked: only the Devastating damage landed
      struck: victim,
    });
    expect(state.effects.some((e) => e.rule === TERRORCHEM && e.operativeId === victim.id)).toBe(true);
  });

  it('"Whenever an operative that has one of your Terrorchem tokens is activated, inflict D3 damage on it"', () => {
    expect(ability(FEARMONGER, 'nemesis-claw.night-lord-fearmonger.poison-objective')).toBe(
      'Whenever an operative that has one of your Terrorchem tokens is activated, inflict D3 damage on it.',
    );
    const { ctx, state } = setup({ script: [4] }); // D3 = ceil(4/2) = 2
    const victim = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    state.effects.push({
      id: 'tok1',
      rule: TERRORCHEM,
      source: { kind: 'ability', id: 'nemesis-claw.night-lord-fearmonger.terrorchem' },
      operativeId: victim.id,
      player: 'p1',
      expiry: { kind: 'endOfBattle' },
    });
    const before = victim.wounds;
    const s = activate(ctx, state, victim.id);
    expect(before - s.operatives[victim.id]!.wounds).toBe(2);
  });

  it('Screecher: "Whenever an enemy operative within 3" of this operative is shooting, fighting or retaliating, your opponent cannot re-roll their attack dice"', () => {
    const { ctx, state } = setup();
    const screecher = state.operatives[opWith(state, 'p1', SCREECHER)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.gunner')]!;
    const me = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    screecher.pos = { x: 14, y: 11 };
    foe.pos = { x: 16, y: 11 };
    me.pos = { x: 18, y: 11 };
    const lasgun = profileOf(SKINTHIEF, 'Bolt pistol');
    const ev = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: attackCtx(foe, me, 'Hot-shot lasgun', lasgun, 'ranged'),
      dice: [],
      rerolls: [{ id: 'commandReroll:attack', label: 'Command Re-roll', mode: 'one', max: 1, player: 'p2' }],
    });
    expect(ev.rerolls).toHaveLength(0);
    // The re-roll weapon rules are stripped too, which is what reaches a fight.
    const claws = profileOf(SCREECHER, 'Lightning claws');
    const stripped = effectiveRules(ctx, state, claws, { operative: foe, target: me, weaponName: 'Lightning claws' });
    expect(stripped.some((r) => r.id === 'Ceaseless')).toBe(false);
    foe.pos = { x: 22, y: 11 }; // more than 3" away: unaffected
    expect(
      effectiveRules(ctx, state, claws, { operative: foe, target: me, weaponName: 'Lightning claws' }).some(
        (r) => r.id === 'Ceaseless',
      ),
    ).toBe(true);
  });

  it('Appetite for Cruelty: "this operative’s lightning claws have the Lethal 4+ weapon rule" against a wounded enemy', () => {
    const { ctx, state } = setup();
    const screecher = state.operatives[opWith(state, 'p1', SCREECHER)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const claws = profileOf(SCREECHER, 'Lightning claws');
    const healthy = effectiveRules(ctx, state, claws, { operative: screecher, target: foe, weaponName: 'Lightning claws' });
    expect(healthy.find((r) => r.id === 'Lethal')?.x).toBe(5);
    foe.wounds -= 1; // "a wounded enemy operative"
    const wounded = effectiveRules(ctx, state, claws, { operative: screecher, target: foe, weaponName: 'Lightning claws' });
    expect(wounded.find((r) => r.id === 'Lethal')?.x).toBe(4);
    // "Whenever this operative is FIGHTING against" — not while retaliating.
    const retaliating = effectiveRules(ctx, state, claws, {
      operative: screecher,
      target: foe,
      weaponName: 'Lightning claws',
      retaliating: true,
    });
    expect(retaliating.find((r) => r.id === 'Lethal')?.x).toBe(5);
  });

  it('Flay Them Alive: another enemy "cannot control markers or perform the Pick Up Marker or mission actions"', () => {
    const { ctx, state } = setup();
    const skinthief = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const victim = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const other = state.operatives[opWith(state, 'p2', 'kasrkin.gunner')]!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    skinthief.pos = { x: 14, y: 11 };
    victim.pos = { x: 15.4, y: 11 };
    other.pos = { x: 17, y: 11 };
    state.markers['centre']!.pos = { x: 17, y: 11 };
    fightSequence(state, skinthief, victim, { attacker: 'Nostraman chainglaive', defender: 'Gun butt' });
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(state.effects.some((e) => e.rule === 'nemesisClaw.flayThemAlive' && e.operativeId === other.id)).toBe(true);
    victim.removed = true; // "operatives that were incapacitated are removed after the action"

    const ev = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: other,
      action: 'Pick Up Marker',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
    // "cannot control markers": its APL no longer counts toward control of the marker it contests.
    state.sequence = null;
    expect(markerController(ctx, state, state.markers['centre']!)).not.toBe('p2');
  });

  it('Tyrant of the Skinning Pits: "Normal and Critical Dmg of 3 or more inflicts 1 less damage on it"', () => {
    const { ctx, state } = setup();
    const skinthief = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    fightSequence(state, foe, skinthief, { attacker: 'Gun butt', defender: 'Nostraman chainglaive' });
    const before = skinthief.wounds;
    inflictDamage(ctx, state, skinthief, 4, 'attack');
    expect(before - skinthief.wounds).toBe(3);
    // Damage of 2 is untouched.
    inflictDamage(ctx, state, skinthief, 2, 'attack');
    expect(before - skinthief.wounds).toBe(5);
  });

  it('Icon Bearer: "whenever determining control of a marker, treat this operative’s APL stat as 1 higher"', () => {
    const { ctx, state } = setup({ include: [VENTRILOKAR] });
    const bearer = state.operatives[opWith(state, 'p1', VENTRILOKAR)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.sergeant')]!;
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 2, y: 2 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    const marker = state.markers['centre']!;
    bearer.pos = { x: marker.pos.x + 1.2, y: marker.pos.y };
    foe.pos = { x: marker.pos.x - 1.2, y: marker.pos.y };
    // APL 3 each — the Icon Bearer's +1 breaks the tie.
    expect(aplOf(ctx, state, bearer)).toBe(3);
    expect(aplOf(ctx, state, foe)).toBe(3);
    expect(markerController(ctx, state, marker)).toBe('p1');
  });

  it('Cruel Tormenter: "this operative’s weapons have the Lethal 5+ weapon rule" against an injured enemy', () => {
    const { ctx, state } = setup({ include: [WARRIOR] });
    const warrior = state.operatives[opWith(state, 'p1', WARRIOR)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const chainsword = profileOf(WARRIOR, 'Chainsword');
    expect(
      effectiveRules(ctx, state, chainsword, { operative: warrior, target: foe, weaponName: 'Chainsword' }).some(
        (r) => r.id === 'Lethal',
      ),
    ).toBe(false);
    foe.wounds = 3; // 8 wounds, injured below 4
    const injured = effectiveRules(ctx, state, chainsword, { operative: warrior, target: foe, weaponName: 'Chainsword' });
    expect(injured.find((r) => r.id === 'Lethal')?.x).toBe(5);
  });

  it('Prescience: "you gain D3 Prescience points" in the Ready step and "discard your Prescience points" at the end of the turning point', () => {
    const { ctx, state } = setup({ script: [6] }); // D3 = 3
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(prescience(state, 'p1')).toBe(3);
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(prescience(state, 'p1')).toBe(0);
  });

  it('Portent: "you can spend 1 of your Prescience points to ignore that inflicted damage", once per turning point', () => {
    expect(ability(VISIONARY, 'nemesis-claw.night-lord-visionary.prescience')).toContain(
      'you can spend 1 of your Prescience points to ignore that inflicted damage',
    );
    const { ctx, state } = setup();
    const visionary = state.operatives[opWith(state, 'p1', VISIONARY)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.gunner')]!;
    state.opState['nemesisClaw.prescience'] = { p1: 2 };
    // A meltagun (Normal Dmg 6) shot at the VISIONARY: one unblocked normal success.
    const seq = shootSequence(state, foe, visionary, 'Meltagun');
    addRolled(seq.attack, [4], 3);
    const before = visionary.wounds;
    inflictDamage(ctx, state, visionary, 6, 'attack');
    expect(visionary.wounds).toBe(before); // the whole dice's Normal Dmg ignored
    expect(prescience(state, 'p1')).toBe(1);
    inflictDamage(ctx, state, visionary, 6, 'attack'); // "not more than once per turning point"
    expect(before - visionary.wounds).toBe(6);
    expect(prescience(state, 'p1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('NEMESIS CLAW unique actions', () => {
  it('PREMONITION 1AP: "Spend 1 of your Prescience points to gain 1CP", once per turning point and never while engaged', () => {
    const { ctx, state } = setup();
    const visionary = opWith(state, 'p1', VISIONARY);
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    state.operatives[visionary]!.pos = { x: 4, y: 4 };
    let s = activate(ctx, state, visionary);
    const dry = reduce(s, { t: 'PerformAction', operativeId: visionary, action: 'nemesis-claw.night-lord-visionary.act.premonition' }, ctx);
    expect(dry.ok).toBe(false);
    expect(dry.reason).toMatch(/Prescience/);

    s.opState['nemesisClaw.prescience'] = { p1: 2 };
    const cp = s.teams.p1.cp;
    s = reduce(s, { t: 'PerformAction', operativeId: visionary, action: 'nemesis-claw.night-lord-visionary.act.premonition' }, ctx).state;
    expect(s.teams.p1.cp).toBe(cp + 1);
    expect(prescience(s, 'p1')).toBe(1);
    // A second activation in the same turning point (action restrictions cleared) is refused.
    s.operatives[visionary]!.actionsThisActivation = [];
    s.operatives[visionary]!.apSpent = 0;
    const again = reduce(s, { t: 'PerformAction', operativeId: visionary, action: 'nemesis-claw.night-lord-visionary.act.premonition' }, ctx);
    expect(again.reason).toMatch(/once per turning point/);
  });

  it('POISON OBJECTIVE 1AP poisons an objective marker, and the first enemy to contest it gains the token and takes 2D3', () => {
    expect(uniqueActionText(FEARMONGER, 'nemesis-claw.night-lord-fearmonger.act.poison-objective')).toContain(
      'then inflict 2D3 damage on it',
    );
    const { ctx, state } = setup({ script: [6, 6] }); // 2D3 = 3 + 3
    const fearmonger = opWith(state, 'p1', FEARMONGER);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 2, y: 2 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    const marker = state.markers['centre']!;
    state.operatives[fearmonger]!.pos = { x: marker.pos.x + 1.2, y: marker.pos.y };
    let s = activate(ctx, state, fearmonger);
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: fearmonger, action: 'nemesis-claw.night-lord-fearmonger.act.poison-objective', params: { markerId: 'centre' } },
      ctx,
    );
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.markers['centre']!.flags['nemesisClaw.terrorchem']).toBe('p1');
    // A second attempt on the same marker is refused by `check` (D-026).
    s.operatives[fearmonger]!.actionsThisActivation = [];
    s.operatives[fearmonger]!.apSpent = 0;
    expect(
      reduce(s, { t: 'PerformAction', operativeId: fearmonger, action: 'nemesis-claw.night-lord-fearmonger.act.poison-objective', params: { markerId: 'centre' } }, ctx)
        .reason,
    ).toMatch(/already has one of your Terrorchem tokens/);

    const foe = opWith(s, 'p2', 'kasrkin.trooper');
    s.operatives[foe]!.pos = { x: marker.pos.x - 1.2, y: marker.pos.y };
    const before = s.operatives[foe]!.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: fearmonger }, ctx).state;
    expect(before - s.operatives[foe]!.wounds).toBe(6);
    expect(s.effects.some((e) => e.rule === TERRORCHEM && e.operativeId === foe)).toBe(true);
    expect(s.markers['centre']!.flags['nemesisClaw.terrorchem']).toBeUndefined();
  });

  it('DISCONCERTING MIMICRY 1AP: "select one of the following … you can only select each option once per battle"', () => {
    const { ctx, state } = setup({ include: [VENTRILOKAR] });
    const vent = opWith(state, 'p1', VENTRILOKAR);
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    const foe = opWith(state, 'p2', 'kasrkin.trooper');
    state.operatives[vent]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, vent);

    // "subtract 1 from its APL stat"
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: vent, action: 'nemesis-claw.night-lord-ventrilokar.act.disconcerting-mimicry', params: { targetOperativeId: foe, choice: 'apl' } },
      ctx,
    ).state;
    expect(s.operatives[foe]!.aplMods).toContain(-1);
    // "you can only select each option once per battle"
    s.operatives[vent]!.actionsThisActivation = [];
    s.operatives[vent]!.apSpent = 0;
    const repeat = reduce(
      s,
      { t: 'PerformAction', operativeId: vent, action: 'nemesis-claw.night-lord-ventrilokar.act.disconcerting-mimicry', params: { targetOperativeId: foe, choice: 'apl' } },
      ctx,
    );
    expect(repeat.reason).toMatch(/once per battle/);
    // "Change its order."
    const order = s.operatives[foe]!.order;
    s.operatives[vent]!.actionsThisActivation = [];
    s.operatives[vent]!.apSpent = 0;
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: vent, action: 'nemesis-claw.night-lord-ventrilokar.act.disconcerting-mimicry', params: { targetOperativeId: foe, choice: 'order' } },
      ctx,
    ).state;
    expect(s.operatives[foe]!.order).not.toBe(order);
    // "Select one enemy operative within 6" of this operative."
    s.operatives[foe]!.pos = { x: 26, y: 11 };
    s.operatives[vent]!.actionsThisActivation = [];
    s.operatives[vent]!.apSpent = 0;
    const tooFar = reduce(
      s,
      { t: 'PerformAction', operativeId: vent, action: 'nemesis-claw.night-lord-ventrilokar.act.disconcerting-mimicry', params: { targetOperativeId: foe, choice: 'dash' } },
      ctx,
    );
    expect(tooFar.reason).toMatch(/within 6"/);
  });
});

// ---------------------------------------------------------------------------
describe('NEMESIS CLAW ploys', () => {
  it('WE HAVE COME FOR YOU: "if the first action it performs during that activation is the Charge action … inflict D3 damage on one enemy operative within its control range"', () => {
    const { ctx, state } = setup({ script: [6] }); // D3 = 3
    const op = opWith(state, 'p1', SKINTHIEF);
    const foe = opWith(state, 'p2', 'kasrkin.trooper');
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    state.operatives[op]!.pos = { x: 14, y: 11 };
    state.operatives[foe]!.pos = { x: 15.4, y: 11 };
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'nemesis-claw.sp.we-have-come-for-you' }, ctx).state;
    s = activate(ctx, s, op);
    s.operatives[op]!.actionsThisActivation = ['Charge'];
    const before = s.operatives[foe]!.wounds;
    s = reduce(s, { t: 'EndActivation', operativeId: op }, ctx).state;
    expect(before - s.operatives[foe]!.wounds).toBe(3);
  });

  it('THE BLACK HUNT: "you can re-roll one of your attack dice" against a wounded enemy operative', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const glaive = profileOf(SKINTHIEF, 'Nostraman chainglaive');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'nemesis-claw.sp.the-black-hunt' }, ctx).state;
    const healthy = effectiveRules(ctx, s, glaive, {
      operative: s.operatives[op.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Nostraman chainglaive',
    });
    expect(healthy.some((r) => r.id === 'Balanced')).toBe(false);
    s.operatives[foe.id]!.wounds -= 1;
    const wounded = effectiveRules(ctx, s, glaive, {
      operative: s.operatives[op.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Nostraman chainglaive',
    });
    expect(wounded.some((r) => r.id === 'Balanced')).toBe(true);
  });

  it('PREYSIGHT: "that friendly operative’s ranged weapons have the Range 6” and Seek Light weapon rules"', () => {
    const { ctx, state } = setup();
    const op = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    op.pos = { x: 14, y: 11 };
    foe.pos = { x: 17, y: 11 };
    const pistol = profileOf(SKINTHIEF, 'Bolt pistol');
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'nemesis-claw.sp.preysight' }, ctx).state;
    const rules = effectiveRules(ctx, s, pistol, {
      operative: s.operatives[op.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Bolt pistol',
    });
    expect(rules.some((r) => r.id === 'SeekLight')).toBe(true);
    expect(rules.some((r) => r.id === 'Range' && r.x === 6)).toBe(true);
  });

  it('RETURN TO DARKNESS: a free Fall Back or Reposition action that "cannot move more than 4""', () => {
    const { ctx, state } = setup();
    const op = opWith(state, 'p1', SKINTHIEF);
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'nemesis-claw.sp.return-to-darkness', data: { operativeId: op } },
      ctx,
    ).state;
    const moved = s.operatives[op]!;
    expect(aplOf(ctx, s, moved)).toBe(4); // APL 3 + the free action
    expect(moveBudget(ctx, s, moved, { action: 'Reposition' })).toBeCloseTo(4);
    // Only Fall Back or Reposition may be paid for with the bonus AP.
    moved.apSpent = 3;
    const dash = availableActions(ctx, s, moved).find((a) => a.def.id === 'Dash');
    expect(dash?.reason ?? '').toMatch(/free action must be/);
  });

  it('VOX SCREAM: a result higher than the enemy operative’s APL stops its activation; otherwise "the CP spent on it is refunded"', () => {
    const win = setup({ script: [6] });
    const foe = opWith(win.state, 'p2', 'kasrkin.trooper');
    win.state.operatives[foe]!.pos = { x: 18, y: 11 };
    win.state.operatives[opWith(win.state, 'p1', SKINTHIEF)]!.pos = { x: 14, y: 11 };
    const cpBefore = win.state.teams.p1.cp;
    const after = reduce(win.state, { t: 'UsePloy', player: 'p1', ployId: 'nemesis-claw.fp.vox-scream' }, win.ctx).state;
    expect(after.teams.p1.cp).toBe(cpBefore - 1);
    expect(Object.values(after.operatives).some((o) => o.player === 'p2' && o.aplMods.includes(-1))).toBe(true);

    const lose = setup({ script: [1] });
    lose.state.operatives[opWith(lose.state, 'p1', SKINTHIEF)]!.pos = { x: 14, y: 11 };
    lose.state.operatives[opWith(lose.state, 'p2', 'kasrkin.trooper')]!.pos = { x: 18, y: 11 };
    const cp2 = lose.state.teams.p1.cp;
    const failed = reduce(lose.state, { t: 'UsePloy', player: 'p1', ployId: 'nemesis-claw.fp.vox-scream' }, lose.ctx).state;
    expect(failed.teams.p1.cp).toBe(cp2); // 1CP spent, 1CP refunded
    expect(failed.teams.p1.ploysUsedTP).toContain('nemesis-claw.fp.vox-scream'); // "cannot use this ploy again"
  });

  it('DEATH TO THE FALSE EMPEROR: Ceaseless against IMPERIUM, Relentless against IMPERIUM ADEPTUS ASTARTES', () => {
    const imperium = setup();
    const op = imperium.state.operatives[opWith(imperium.state, 'p1', SKINTHIEF)]!;
    const foe = imperium.state.operatives[opWith(imperium.state, 'p2', 'kasrkin.trooper')]!;
    imperium.state.activeOperativeId = op.id;
    const s = reduce(
      imperium.state,
      { t: 'UsePloy', player: 'p1', ployId: 'nemesis-claw.fp.death-to-the-false-emperor' },
      imperium.ctx,
    ).state;
    const glaive = profileOf(SKINTHIEF, 'Nostraman chainglaive');
    const rules = effectiveRules(imperium.ctx, s, glaive, {
      operative: s.operatives[op.id]!,
      target: s.operatives[foe.id]!,
      weaponName: 'Nostraman chainglaive',
    });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
    expect(rules.some((r) => r.id === 'Relentless')).toBe(false);

    const astartes = setup({ foe: angelOfDeath as unknown as typeof kasrkin });
    const op2 = astartes.state.operatives[opWith(astartes.state, 'p1', SKINTHIEF)]!;
    const foe2 = astartes.state.operatives[astartes.state.teams.p2.operativeIds[0]!]!;
    astartes.state.activeOperativeId = op2.id;
    const s2 = reduce(
      astartes.state,
      { t: 'UsePloy', player: 'p1', ployId: 'nemesis-claw.fp.death-to-the-false-emperor' },
      astartes.ctx,
    ).state;
    const rules2 = effectiveRules(astartes.ctx, s2, glaive, {
      operative: s2.operatives[op2.id]!,
      target: s2.operatives[foe2.id]!,
      weaponName: 'Nostraman chainglaive',
    });
    expect(rules2.some((r) => r.id === 'Relentless')).toBe(true);
  });

  it('PROCLIVITY FOR MURDER: only after a kill in control range, then a free Charge or Dash "for the former, it cannot move more than 3""', () => {
    const { ctx, state } = setup();
    const ploy = nemesisClaw.ploys.find((p) => p.id === 'nemesis-claw.fp.proclivity-for-murder')!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false);

    const killer = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const victim = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    killer.pos = { x: 14, y: 11 };
    victim.pos = { x: 15.4, y: 11 };
    let s = activate(ctx, state, killer.id);
    fightSequence(s, s.operatives[killer.id]!, s.operatives[victim.id]!, {
      attacker: 'Nostraman chainglaive',
      defender: 'Gun butt',
    });
    inflictDamage(ctx, s, s.operatives[victim.id]!, 99, 'attack');
    s.sequence = null;
    expect(ploy.usable!(s, 'p1').ok).toBe(true);

    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: 'nemesis-claw.fp.proclivity-for-murder' }, ctx).state;
    const op = s.operatives[killer.id]!;
    expect(aplOf(ctx, s, op)).toBe(4);
    expect(moveBudget(ctx, s, op, { action: 'Charge', bonusInches: 2 })).toBeCloseTo(3);
    // "even if it's performed an action that prevents it from performing those actions"
    op.actionsThisActivation = ['Fight'];
    op.apSpent = 3;
    expect(availableActions(ctx, s, op).some((a) => a.def.id === 'Charge (Proclivity for Murder)' && a.ok)).toBe(true);
  });

  it('DIRTY FIGHTER: the retaliating operative resolves first, then "you cannot resolve any other successes during that sequence"', () => {
    const { ctx, state } = setup();
    const me = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    me.pos = { x: 14, y: 11 };
    foe.pos = { x: 15.4, y: 11 };
    const ploy = nemesisClaw.ploys.find((p) => p.id === 'nemesis-claw.fp.dirty-fighter')!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false); // no fight in flight

    const seq = fightSequence(state, foe, me, { attacker: 'Gun butt', defender: 'Nostraman chainglaive' });
    addRolled(seq.defenderPool, [6, 5, 4], 3); // three successes for the retaliating SKINTHIEF
    addRolled(seq.attackerPool, [5, 5], 4);
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'nemesis-claw.fp.dirty-fighter' }, ctx).state;
    const live = s.sequence as FightSequence;
    expect(live.turn).toBe('defender');

    // Resolving one success discards the rest.
    live.defenderPool.dice[0]!.state = 'struck';
    ctx.hooks.emit('onStrikeResolved', s, {
      state: s,
      ctx: attackCtx(s.operatives[me.id]!, s.operatives[foe.id]!, 'Nostraman chainglaive', profileOf(SKINTHIEF, 'Nostraman chainglaive'), 'melee'),
      crit: true,
      struck: s.operatives[foe.id]!,
    });
    expect(live.defenderPool.dice.filter((d) => d.state === 'crit' || d.state === 'normal')).toHaveLength(0);
    expect(live.attackerPool.dice.filter((d) => d.state === 'normal')).toHaveLength(2); // the opponent still resolves theirs
  });
});

// ---------------------------------------------------------------------------
describe('NEMESIS CLAW faction equipment', () => {
  it('FLAYED SKIN is reminder-only: "your opponent cannot re-roll their attack dice results of 1" has no per-value seam', () => {
    expect(rule('nemesis-claw.eq.flayed-skin')).toContain('cannot re-roll their attack dice results of 1');
  });

  it('CHAIN SNARE: "If any result is a 4+, that enemy operative cannot perform that action", once per turning point', () => {
    const { ctx, state } = setup({ equipment: ['nemesis-claw.eq.chain-snare'], script: [4, 1] });
    const snarer = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const other = state.operatives[opWith(state, 'p2', 'kasrkin.gunner')]!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 2, y: 2 };
    snarer.pos = { x: 14, y: 11 };
    foe.pos = { x: 15.4, y: 11 };
    // The 2D6 is rolled as the snared operative is activated (the query path must stay pure).
    let s = activate(ctx, state, foe.id);
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[foe.id]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
    expect(ev.reason).toMatch(/Chain Snare/);
    expect(s.rolls.some((r) => r.kind === 'chainSnare' && r.results.length === 2)).toBe(true);
    // "you cannot use this rule again during this turning point"
    s.operatives[other.id]!.pos = { x: 15.4, y: 11 };
    s.operatives[foe.id]!.pos = { x: 28, y: 20 };
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    s = activate(ctx, s, other.id);
    const second = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[other.id]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(second.allowed).toBe(true);
    expect(s.rolls.filter((r) => r.kind === 'chainSnare')).toHaveLength(1);
  });

  it('GRISLY TROPHY: a kill within 2" earns the token, and enemies within 2" of the bearer lose 1 Atk', () => {
    const { ctx, state } = setup({ equipment: ['nemesis-claw.eq.grisly-trophy'] });
    const holder = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const victim = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'kasrkin.gunner')]!;
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 20 };
    holder.pos = { x: 14, y: 11 };
    victim.pos = { x: 15.4, y: 11 };
    fightSequence(state, holder, victim, { attacker: 'Nostraman chainglaive', defender: 'Gun butt' });
    inflictDamage(ctx, state, victim, 99, 'attack');
    expect(state.effects.some((e) => e.rule === GRISLY_TROPHY_TOKEN && e.operativeId === holder.id)).toBe(true);
    victim.removed = true;

    shooter.pos = { x: 15.4, y: 11 };
    const flamer = profileOf(GUNNER, 'Flamer');
    const ev = ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: attackCtx(shooter, holder, 'Flamer', flamer, 'ranged'),
      count: flamer.atk,
      mods: zeroStatMods(),
    });
    expect(ev.count).toBe(flamer.atk - 1);
    // "Once per battle"
    const second = state.operatives[opWith(state, 'p2', 'kasrkin.sergeant')]!;
    second.pos = { x: 15.4, y: 11 };
    fightSequence(state, holder, second, { attacker: 'Nostraman chainglaive', defender: 'Gun butt' });
    inflictDamage(ctx, state, second, 99, 'attack');
    expect(state.effects.filter((e) => e.rule === GRISLY_TROPHY_TOKEN)).toHaveLength(1);
  });

  it('COMMS JAMMERS: "that enemy operative’s APL stat cannot be added to" within 3"', () => {
    const { ctx, state } = setup({ equipment: ['nemesis-claw.eq.comms-jammers'] });
    const op = state.operatives[opWith(state, 'p1', SKINTHIEF)]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.pos = { x: 2, y: 2 };
    foe.aplMods.push(1);
    foe.pos = { x: 20, y: 11 };
    expect(aplOf(ctx, state, foe)).toBe(3); // out of range: the boost stands
    op.pos = { x: 22, y: 11 };
    expect(aplOf(ctx, state, foe)).toBe(2);
    // A penalty still applies while jammed.
    foe.aplMods.push(-1);
    expect(aplOf(ctx, state, foe)).toBe(1);
  });
});
