/**
 * KASRKIN. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/kasrkin/
 */
import { describe, expect, it } from 'vitest';
import { reduce } from '../../src/core/reducer.ts';
import { canSelectWeapon } from '../../src/core/sequences/shoot.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { availableActions } from '../../src/core/actions.ts';
import { apBudgetOf, aplOf, freeApOf, inflictDamage, markerController } from '../../src/core/state.ts';
import { kasrkin, SKILLS, skillGambitId } from '../../src/teams/kasrkin/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { activate, battle, opWith, rosterIncluding, teamContext, yieldGambitTurn } from './harness.ts';
import type { GameState } from '../../src/core/types.ts';

const DATA = teamData('kasrkin');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;

const EVERY_ROLE = [
  'kasrkin.sergeant',
  'kasrkin.combat-medic',
  'kasrkin.demo-trooper',
  'kasrkin.gunner',
  'kasrkin.recon-trooper',
  'kasrkin.sharpshooter',
  'kasrkin.trooper',
  'kasrkin.vox-trooper',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([kasrkin], { seed: 5 });
  const picks = rosterIncluding(kasrkin, EVERY_ROLE);
  const state = battle({
    ctx,
    p1: { module: kasrkin, equipment, picks },
    p2: { module: kasrkin, picks },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string) => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

// ---------------------------------------------------------------------------
describe('KASRKIN data (pinned against data/teams/kasrkin.json)', () => {
  it('has 8 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(8);
    const sergeant = DATA.datacards.find((c) => c.id === 'kasrkin.sergeant')!;
    expect(sergeant).toMatchObject({ apl: 3, move: 6, save: 4, wounds: 9, base: { shape: 'round', mm: 28 } });
    expect(sergeant.keywords).toEqual(['KASRKIN', 'IMPERIUM', 'ASTRA MILITARUM', 'LEADER', 'SERGEANT']);
    for (const card of DATA.datacards.filter((c) => c.id !== 'kasrkin.sergeant')) {
      expect(card).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 8, base: { shape: 'round', mm: 28 } });
    }
  });

  it('pins every weapon profile of the GUNNER', () => {
    const gunner = DATA.datacards.find((c) => c.id === 'kasrkin.gunner')!;
    const flat = gunner.weapons.flatMap((w) =>
      w.profiles.map((p) => [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC].join('|')),
    );
    expect(flat).toEqual([
      'Flamer||ranged|4|2|3|3',
      'Grenade launcher|frag|ranged|4|3|2|4',
      'Grenade launcher|krak|ranged|4|3|4|5',
      'Hot-shot volley gun|focused|ranged|5|3|3|4',
      'Hot-shot volley gun|sweeping|ranged|4|3|3|4',
      'Meltagun||ranged|4|3|6|3',
      'Plasma gun|standard|ranged|4|3|4|6',
      'Plasma gun|supercharge|ranged|4|3|5|6',
      'Gun butt||melee|3|4|2|3',
    ]);
    expect(profileOf('kasrkin.sharpshooter', 'Hot-shot marksman rifle', 'concealed').rules.map((r) => r.id)).toContain(
      'ConcealedPosition',
    );
  });

  it('exposes 2 faction rules, 4 strategy ploys, 4 firefight ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Skill at Arms', 'Rapid Fire']);
    expect(kasrkin.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(kasrkin.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(kasrkin.equipment).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
describe('Skill at Arms — "STRATEGIC GAMBIT. Select a SKILL AT ARMS for friendly KASRKIN operatives to have"', () => {
  it('offers all four skills as gambits and, with the SERGEANT in the killzone, allows a second, different one', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    const skillIds = options.filter((o) => o.id.startsWith('kasrkin.rule.skill-at-arms:')).map((o) => o.id);
    expect(skillIds).toHaveLength(4);

    // Veteran Leadership: "you can select one additional SKILL AT ARMS but they cannot be the same".
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: skillGambitId('light-em-up') }, ctx).state;
    const after = ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options;
    const second = after.filter((o) => o.id.startsWith('kasrkin.rule.skill-at-arms:'));
    expect(second.map((o) => o.id)).not.toContain(skillGambitId('light-em-up'));
    expect(second.length).toBe(3);

    // "each player alternates either using a STRATEGIC GAMBIT or passing": the second SKILL AT
    // ARMS is a second gambit, so p2 takes their turn in between.
    s = reduce(yieldGambitTurn(ctx, s, 'p1'), { t: 'UseGambit', player: 'p1', gambitId: skillGambitId('strike-fast') }, ctx).state;
    const third = ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options;
    expect(third.filter((o) => o.id.startsWith('kasrkin.rule.skill-at-arms:'))).toHaveLength(0);
  });

  it('Light ’Em Up: "Friendly KASRKIN operatives’ ranged weapons have the Severe weapon rule"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'kasrkin.trooper')]!;
    const target = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const profile = profileOf('kasrkin.trooper', 'Hot-shot lasgun');
    const before = effectiveRules(ctx, state, profile, { operative: shooter, target, weaponName: 'Hot-shot lasgun' });
    expect(before.some((r) => r.id === 'Severe')).toBe(false);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: skillGambitId('light-em-up') }, ctx).state;
    const after = effectiveRules(ctx, s, profile, {
      operative: s.operatives[shooter.id]!,
      target: s.operatives[target.id]!,
      weaponName: 'Hot-shot lasgun',
    });
    expect(after.some((r) => r.id === 'Severe')).toBe(true);
  });

  it('Strike Fast: "add 1\\" to its Move stat" during the Reposition action only', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: skillGambitId('strike-fast') }, ctx).state;
    const op = s.operatives[opWith(s, 'p1', 'kasrkin.trooper')]!;
    expect(moveBudget(ctx, s, op, { action: 'Reposition' })).toBeCloseTo(7);
    expect(moveBudget(ctx, s, op, { action: 'Dash' })).toBeCloseTo(3);
  });

  it('For Cadia!: "Add 1 to the Atk stat of … melee weapons (to a maximum of 4)"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: skillGambitId('for-cadia') }, ctx).state;
    const attacker = s.operatives[opWith(s, 'p1', 'kasrkin.trooper')]!;
    const gunButt = profileOf('kasrkin.trooper', 'Gun butt');
    const ev = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: {
        attacker,
        weaponName: 'Gun butt',
        profile: gunButt,
        rules: gunButt.rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      count: gunButt.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.count).toBe(4);
    // A 4-attack weapon stays at 4 — "to a maximum of 4".
    const power = profileOf('kasrkin.sergeant', 'Power weapon');
    const capped = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: {
        attacker,
        weaponName: 'Power weapon',
        profile: power,
        rules: power.rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      count: power.atk,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(capped.count).toBe(4);
  });

  it('Ice In Your Veins: "the first time an attack dice inflicts Normal Dmg of 3 or more … that dice inflicts 1 less damage"', () => {
    const { ctx, state } = setup();
    let s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: skillGambitId('ice-in-your-veins') }, ctx).state;
    const victim = s.operatives[opWith(s, 'p1', 'kasrkin.trooper')]!;
    const shooter = s.operatives[opWith(s, 'p2', 'kasrkin.trooper')]!;
    // Pretend a hot-shot lasgun (Normal Dmg 3) sequence is in flight.
    s.sequence = {
      kind: 'shoot',
      step: 'resolve',
      attackerId: shooter.id,
      targetId: victim.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Hot-shot lasgun',
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
    inflictDamage(ctx, s, victim, 3, 'attack');
    expect(before - victim.wounds).toBe(2); // 3 - 1
    // "the FIRST time … during that sequence"
    inflictDamage(ctx, s, victim, 3, 'attack');
    expect(victim.wounds).toBe(before - 5);
  });
});

// ---------------------------------------------------------------------------
describe('Rapid Fire — "can perform two Shoot actions … but a bolt pistol, hot-shot lasgun or hot-shot laspistol must be selected for both"', () => {
  it('is only the SECOND Shoot of an activation, never after moving, and only with the three named weapons', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'kasrkin.trooper');
    const enemy = opWith(state, 'p2', 'kasrkin.trooper');
    const s = activate(ctx, state, id);
    const first = reduce(
      s,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Rapid Fire)', params: { weaponName: 'Hot-shot lasgun', targetId: enemy } },
      ctx,
    );
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/second Shoot action/);

    const moved = { ...s };
    moved.operatives[id]!.actionsThisActivation = ['Reposition', 'Shoot'];
    const afterMove = reduce(
      moved,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Rapid Fire)', params: { weaponName: 'Hot-shot lasgun', targetId: enemy } },
      ctx,
    );
    expect(afterMove.reason).toMatch(/did not move/);

    const stood = { ...s };
    stood.operatives[id]!.actionsThisActivation = ['Shoot'];
    const wrongWeapon = reduce(
      stood,
      { t: 'PerformAction', operativeId: id, action: 'Shoot (Rapid Fire)', params: { weaponName: 'Gun butt', targetId: enemy } },
      ctx,
    );
    expect(wrongWeapon.reason).toMatch(/bolt pistol, hot-shot lasgun or hot-shot laspistol/);
    // The action really is registered and available to KASRKIN operatives.
    expect(availableActions(ctx, stood, stood.operatives[id]!).some((a) => a.def.id === 'Shoot (Rapid Fire)')).toBe(true);
  });

  it('the rule text is quoted verbatim on the action', () => {
    expect(rule('kasrkin.rule.rapid-fire')).toContain('two Shoot actions');
  });
});

// ---------------------------------------------------------------------------
describe('KASRKIN ploys', () => {
  it('ELIMINATION PATTERN gives hot-shot weapons Piercing Crits 1, or Piercing 1 for a volley gun', () => {
    const { ctx, state } = setup();
    // "against an operative that … is being scanned (see RECON-TROOPER)"
    const recon = opWith(state, 'p1', 'kasrkin.recon-trooper');
    const enemyId = opWith(state, 'p2', 'kasrkin.trooper');
    state.operatives[recon]!.pos = { x: 14, y: 11 };
    state.operatives[enemyId]!.pos = { x: 17, y: 11 };
    let s = activate(ctx, state, recon);
    s = reduce(s, { t: 'PerformAction', operativeId: recon, action: 'kasrkin.recon-trooper.act.auspex-scan' }, ctx).state;
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: 'kasrkin.sp.elimination-pattern' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'kasrkin.trooper')]!;
    const target = s.operatives[enemyId]!;
    const lasgun = profileOf('kasrkin.trooper', 'Hot-shot lasgun');
    const rules = effectiveRules(ctx, s, lasgun, { operative: shooter, target, weaponName: 'Hot-shot lasgun' });
    expect(rules.some((r) => r.id === 'PiercingCrits' && r.x === 1)).toBe(true);

    const volley = profileOf('kasrkin.gunner', 'Hot-shot volley gun', 'focused');
    const volleyRules = effectiveRules(ctx, s, volley, {
      operative: shooter,
      target,
      weaponName: 'Hot-shot volley gun',
    });
    expect(volleyRules.some((r) => r.id === 'Piercing' && r.x === 1)).toBe(true);
  });

  it('CLEARANCE SWEEP places a marker that grants Ceaseless within 5" horizontally, removed in the next Ready step', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'kasrkin.trooper')]!;
    const target = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    shooter.pos = { x: 14, y: 11 };
    target.pos = { x: 16, y: 11 };
    const s = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'kasrkin.sp.clearance-sweep', data: { pos: { x: 15, y: 11 } } },
      ctx,
    ).state;
    expect(s.markers['kasrkin.clearanceSweep.p1']).toBeDefined();
    const lasgun = profileOf('kasrkin.trooper', 'Hot-shot lasgun');
    const rules = effectiveRules(ctx, s, lasgun, {
      operative: s.operatives[shooter.id]!,
      target: s.operatives[target.id]!,
      weaponName: 'Hot-shot lasgun',
    });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);

    ctx.hooks.emit('onReadyStep', s, { state: s, player: 'p1', cp: 1 });
    expect(s.markers['kasrkin.clearanceSweep.p1']).toBeUndefined();
  });

  it('RELOCATE cannot be used in the first turning point and is free for the RECON-TROOPER', () => {
    const { ctx, state } = setup();
    const ploy = kasrkin.ploys.find((p) => p.id === 'kasrkin.sp.relocate')!;
    expect(ploy.usable!({ ...state, turningPoint: 1 }, 'p1').ok).toBe(false);
    expect(ploy.usable!({ ...state, turningPoint: 2 }, 'p1').ok).toBe(true);

    // "The Relocate strategy ploy costs you 0CP if this operative is the selected … operative."
    const recon = opWith(state, 'p1', 'kasrkin.recon-trooper');
    let s = { ...state, turningPoint: 2 };
    for (const e of s.teams.p2.operativeIds) s.operatives[e]!.pos = { x: 29, y: 20 };
    const cpBefore = s.teams.p1.cp;
    s = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: 'kasrkin.sp.relocate', data: { operativeId: recon } }, ctx).state;
    expect(s.teams.p1.cp).toBe(cpBefore); // 1CP spent, 1CP refunded
    // "…can immediately perform a free Dash action in an order of your choice." The Dash is one
    // AP outside the APL budget, not an APL stat change (docs/DECISIONS.md D-100): the ploy
    // buys a move, and moving up the board does not make a Kasrkin better at holding ground, so
    // `aplOf` — the stat marker control is totalled from — is untouched.
    expect(rule('kasrkin.sp.relocate')).toContain('can immediately perform a free Dash action');
    const trooper = s.operatives[recon]!;
    const apl = aplOf(ctx, s, trooper);
    expect(trooper.aplMods).toEqual([]);
    expect(freeApOf(s, trooper)).toBe(1);
    expect(apBudgetOf(ctx, s, trooper)).toBe(apl + 1);
    // One window, not a standing bonus: the AP goes away with the activation it is spent in.
    let after = activate(ctx, s, recon);
    after = reduce(after, { t: 'EndActivation', operativeId: recon }, ctx).state;
    expect(freeApOf(after, after.operatives[recon]!)).toBe(0);
    expect(apBudgetOf(ctx, after, after.operatives[recon]!)).toBe(apl);
  });

  it('SEIZE THE INITIATIVE cannot be used by the player with initiative and grants a free non-move action', () => {
    const { ctx, state } = setup();
    const ploy = kasrkin.ploys.find((p) => p.id === 'kasrkin.fp.seize-the-initiative')!;
    expect(ploy.usable!({ ...state, initiative: 'p1' }, 'p1').ok).toBe(false);
    expect(ploy.usable!({ ...state, initiative: 'p2' }, 'p1').ok).toBe(true);

    const s2 = { ...state, initiative: 'p2' as const };
    const target = opWith(s2, 'p1', 'kasrkin.trooper');
    const out = reduce(s2, { t: 'UsePloy', player: 'p1', ployId: ploy.id, data: { operativeId: target } }, ctx);
    expect(out.ok).toBe(true);
    const op = out.state.operatives[target]!;
    // "One friendly KASRKIN operative can immediately perform a 1AP action for free." Free means
    // outside the APL budget (docs/DECISIONS.md D-100): the APL stat stays where it was and the
    // operative simply has one AP more than its APL to spend this activation. Modelled as an APL
    // change instead, a Kasrkin already carrying a +1 from another rule would be handed nothing
    // at all by this ploy, because "the total can never be more than -1 or +1 from its normal
    // APL" would eat it.
    expect(rule('kasrkin.fp.seize-the-initiative')).toContain('can immediately perform a 1AP action for free');
    expect(op.aplMods).toEqual([]);
    expect(aplOf(ctx, out.state, op)).toBe(2); // the printed APL, unmoved
    expect(freeApOf(out.state, op)).toBe(1);
    expect(apBudgetOf(ctx, out.state, op)).toBe(3);
    // "but it cannot move during that action"
    op.apSpent = 2;
    const move = availableActions(ctx, out.state, op).find((a) => a.def.id === 'Dash');
    expect(move?.reason ?? '').toMatch(/cannot move/);
  });

  it('GIVE NO GROUND makes a 2-APL tie a friendly marker control', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'kasrkin.fp.give-no-ground' }, ctx).state;
    const ev = ctx.hooks.emit('onMarkerControl', s, {
      state: s,
      markerId: 'centre',
      aplByPlayer: { p1: 2, p2: 2 },
    });
    expect(ev.forced).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
describe('KASRKIN faction equipment', () => {
  it('FOREGRIP: Accurate 1 within 3", excluding weapons with "pistol" in their name', () => {
    const { ctx, state } = setup(['kasrkin.eq.foregrip']);
    const shooter = state.operatives[opWith(state, 'p1', 'kasrkin.trooper')]!;
    const target = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    shooter.pos = { x: 14, y: 11 };
    target.pos = { x: 15.5, y: 11 };
    const lasgun = profileOf('kasrkin.trooper', 'Hot-shot lasgun');
    expect(
      effectiveRules(ctx, state, lasgun, { operative: shooter, target, weaponName: 'Hot-shot lasgun' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(true);
    const pistol = profileOf('kasrkin.demo-trooper', 'Hot-shot laspistol');
    expect(
      effectiveRules(ctx, state, pistol, { operative: shooter, target, weaponName: 'Hot-shot laspistol' }).some(
        (r) => r.id === 'Accurate',
      ),
    ).toBe(false);
  });

  it('LONG-RANGE SCOPE: hot-shot weapons gain Saturate beyond 6"', () => {
    const { ctx, state } = setup(['kasrkin.eq.long-range-scope']);
    const shooter = state.operatives[opWith(state, 'p1', 'kasrkin.trooper')]!;
    const target = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const lasgun = profileOf('kasrkin.trooper', 'Hot-shot lasgun');
    shooter.pos = { x: 4, y: 11 };
    target.pos = { x: 20, y: 11 };
    expect(
      effectiveRules(ctx, state, lasgun, { operative: shooter, target, weaponName: 'Hot-shot lasgun' }).some(
        (r) => r.id === 'Saturate',
      ),
    ).toBe(true);
    target.pos = { x: 8, y: 11 };
    expect(
      effectiveRules(ctx, state, lasgun, { operative: shooter, target, weaponName: 'Hot-shot lasgun' }).some(
        (r) => r.id === 'Saturate',
      ),
    ).toBe(false);
  });

  it('COMBAT DAGGERS: "Friendly KASRKIN operatives have the following melee weapon: Combat dagger 3 / 4+ / 3/4"', () => {
    const { ctx, state } = setup(['kasrkin.eq.combat-daggers']);
    const id = opWith(state, 'p1', 'kasrkin.trooper');
    const s = activate(ctx, state, id);
    const granted = (s.operatives[id] as { grantedWeapons?: { name: string }[] }).grantedWeapons ?? [];
    expect(granted.map((w) => w.name)).toContain('Combat dagger');
  });

  it('RELICS OF CADIA is once per turning point and needs two or more fails', () => {
    expect(rule('kasrkin.eq.relics-of-cadia')).toContain('Once per turning point');
    expect(rule('kasrkin.eq.relics-of-cadia')).toContain('two or more fails');
  });
});

// ---------------------------------------------------------------------------
describe('KASRKIN unique actions', () => {
  it('TACTICAL COMMAND 0AP grants a SKILL AT ARMS to one friendly operative, never the same one twice', () => {
    const { ctx, state } = setup();
    const sergeant = opWith(state, 'p1', 'kasrkin.sergeant');
    const trooper = opWith(state, 'p1', 'kasrkin.trooper');
    let s = activate(ctx, state, sergeant);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: sergeant,
        action: 'kasrkin.sergeant.act.tactical-command',
        params: { targetOperativeId: trooper, choice: 'for-cadia' },
      },
      ctx,
    ).state;
    expect(s.effects.some((e) => e.rule === 'kasrkin.skillAtArms' && e.operativeId === trooper)).toBe(true);
  });

  it('AUSPEX SCAN 1AP marks enemies within 8" as being scanned and denies obscured', () => {
    const { ctx, state } = setup();
    const recon = opWith(state, 'p1', 'kasrkin.recon-trooper');
    const enemy = opWith(state, 'p2', 'kasrkin.trooper');
    state.operatives[recon]!.pos = { x: 14, y: 11 };
    state.operatives[enemy]!.pos = { x: 18, y: 11 };
    let s = activate(ctx, state, recon);
    s = reduce(s, { t: 'PerformAction', operativeId: recon, action: 'kasrkin.recon-trooper.act.auspex-scan' }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'kasrkin.scanSource' && e.operativeId === recon)).toBe(true);
    const ev = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: s.operatives[recon]!,
      target: s.operatives[enemy]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('all');
  });

  it('BATTLE COMMS 1AP adds 1 to another friendly operative’s APL', () => {
    const { ctx, state } = setup();
    const vox = opWith(state, 'p1', 'kasrkin.vox-trooper');
    const friend = opWith(state, 'p1', 'kasrkin.trooper');
    let s = activate(ctx, state, vox);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: vox, action: 'kasrkin.vox-trooper.act.battle-comms', params: { targetOperativeId: friend } },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[friend]!)).toBe(3);
  });

  it('MEDIKIT 0AP restores 2D3 lost wounds', () => {
    const ctx = teamContext([kasrkin], { script: [2, 4] });
    const state = battle({ ctx, p1: { module: kasrkin }, p2: { module: kasrkin } });
    const medic = opWith(state, 'p1', 'kasrkin.combat-medic');
    const patient = opWith(state, 'p1', 'kasrkin.trooper');
    state.operatives[patient]!.wounds = 2;
    let s = activate(ctx, state, medic);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: medic, action: 'kasrkin.combat-medic.act.medikit', params: { targetOperativeId: patient } },
      ctx,
    ).state;
    expect(s.operatives[patient]!.wounds).toBeGreaterThan(2);
    expect(s.operatives[patient]!.wounds).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
describe('KASRKIN abilities', () => {
  it('Medic!: a friendly KASRKIN operative within 3" is left on 1 wound instead of being incapacitated', () => {
    const { ctx, state } = setup();
    const medic = state.operatives[opWith(state, 'p1', 'kasrkin.combat-medic')]!;
    const victim = state.operatives[opWith(state, 'p1', 'kasrkin.trooper')]!;
    medic.pos = { x: 10, y: 11 };
    victim.pos = { x: 11, y: 11 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 29, y: 21 };
    inflictDamage(ctx, state, victim, 20, 'attack');
    expect(victim.incapacitated).toBeFalsy();
    expect(victim.wounds).toBe(1);
    // "Subtract 1 from this and that operative's APL stats"
    expect(medic.aplMods).toContain(-1);
    expect(victim.aplMods).toContain(-1);
  });

  it('Blast Padding: the DEMO-TROOPER re-rolls a defence die against Blast/Torrent weapons', () => {
    const { ctx, state } = setup();
    const demo = state.operatives[opWith(state, 'p1', 'kasrkin.demo-trooper')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'kasrkin.gunner')]!;
    const frag = profileOf('kasrkin.gunner', 'Grenade launcher', 'frag');
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: demo,
        weaponName: 'Grenade launcher',
        profile: frag,
        rules: frag.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 5,
      },
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.rerolls.some((r) => r.id === 'kasrkin.blastPadding')).toBe(true);
  });

  it('Concealed Position: "only the first time it\'s performing the Shoot action during the battle" — the concealed profile alone', () => {
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', 'kasrkin.sharpshooter')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kasrkin.trooper')]!;
    const rifle = DATA.datacards
      .find((c) => c.id === 'kasrkin.sharpshooter')!
      .weapons.find((w) => w.name === 'Hot-shot marksman rifle')!;
    // The rule sits on the `concealed` profile alone — mobile and stationary are unrestricted.
    const carries = (n: string): boolean =>
      rifle.profiles.find((p) => p.name === n)!.rules.some((r) => r.id === 'ConcealedPosition');
    expect(carries('concealed')).toBe(true);
    expect(carries('mobile')).toBe(false);
    expect(carries('stationary')).toBe(false);

    const ask = (profileName: string) =>
      canSelectWeapon(ctx, state, sniper, 'Hot-shot marksman rifle', profileName, foe.id);

    // Before it has shot, every profile is selectable.
    expect(ask('concealed').ok).toBe(true);
    expect(ask('mobile').ok).toBe(true);

    state.opState['kasrkin.shot'] = { [sniper.id]: true };

    // After its first Shoot only the concealed profile is refused; the rifle itself is NOT lost.
    expect(ask('concealed').ok).toBe(false);
    expect(ask('concealed').reason).toContain('Concealed Position');
    expect(ask('mobile').ok).toBe(true);
    expect(ask('stationary').ok).toBe(true);
    const available = ctx.hooks.emit('availableWeapons', state, {
      state,
      operative: sniper,
      weapons: ['Hot-shot marksman rifle', 'Gun butt'],
    }).weapons;
    expect(available).toContain('Hot-shot marksman rifle');
  });
});
