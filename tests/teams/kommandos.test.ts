/**
 * KOMMANDOS. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/kommandos/
 */
import { describe, expect, it } from 'vitest';
import { availableActions, getAction } from '../../src/core/actions.ts';
import { createGameContext } from '../../src/core/game.ts';
import { reduce } from '../../src/core/reducer.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { aplOf, inflictDamage } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { celestianInsidiants } from '../../src/teams/celestian-insidiants/index.ts';
import { EXPLOSIVE_SHOOT, KRUMPIN_TIME_FIGHT, THROAT_SLITTAS_CHARGE, kommandos } from '../../src/teams/kommandos/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { activate, battle, mapById, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('kommandos');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;

const EVERY_ROLE = [
  'kommandos.boss-nob',
  'kommandos.bomb-squig',
  'kommandos.boy',
  'kommandos.breacha-boy',
  'kommandos.burna-boy',
  'kommandos.comms-boy',
  'kommandos.dakka-boy',
  'kommandos.grot',
  'kommandos.rokkit-boy',
  'kommandos.slasha-boy',
  'kommandos.snipa-boy',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([kommandos, celestianInsidiants], { seed: 9 });
  const state = battle({
    ctx,
    p1: { module: kommandos, equipment, picks: rosterIncluding(kommandos, EVERY_ROLE) },
    p2: { module: celestianInsidiants },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const data = cardId.startsWith('kommandos') ? DATA : teamData('celestian-insidiants');
  const w = data.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return (w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0])!;
};

// ---------------------------------------------------------------------------
describe('KOMMANDOS data (pinned against data/teams/kommandos.json)', () => {
  it('has 11 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(11);
    const nob = DATA.datacards.find((c) => c.id === 'kommandos.boss-nob')!;
    expect(nob).toMatchObject({ apl: 3, move: 6, save: 5, wounds: 14, base: { shape: 'round', mm: 32 } });
    expect(nob.keywords).toEqual(['KOMMANDO', 'ORK', 'LEADER', 'BOSS NOB']);
    for (const id of ['kommandos.bomb-squig', 'kommandos.grot']) {
      expect(DATA.datacards.find((c) => c.id === id)!).toMatchObject({ wounds: 5, base: { shape: 'round', mm: 25 } });
    }
    for (const card of DATA.datacards.filter(
      (c) => !['kommandos.boss-nob', 'kommandos.bomb-squig', 'kommandos.grot'].includes(c.id),
    )) {
      expect(card).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 10, base: { shape: 'round', mm: 32 } });
    }
  });

  it('pins every weapon profile of the SNIPA BOY and the BOMB SQUIG', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat('kommandos.snipa-boy')).toEqual([
      'Scoped big shoota|concealed|ranged|5|3|3|3|Devastating 2+Heavy+Silent+Concealed Position*',
      'Scoped big shoota|stationary|ranged|5|3|3|3|Devastating 2+Heavy',
      'Scoped big shoota|sweeping|ranged|5|3|3|4|Heavy (Dash only)+Torrent 1"',
      'Fists||melee|3|3|3|4|',
    ]);
    expect(flat('kommandos.bomb-squig')).toEqual([
      'Explosives||ranged|6|4|4|5|Blast 1"+Limited 1+Explosive*',
      'Bite||melee|3|4|4|5|',
    ]);
  });

  it('exposes 1 faction rule, 4 strategy ploys, 4 firefight ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Throat Slittas']);
    expect(kommandos.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(kommandos.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(kommandos.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual(['ConcealedPosition', 'Explosive']);
  });
});

// ---------------------------------------------------------------------------
describe('Throat Slittas — "can perform the Charge action while it has a Conceal order"', () => {
  it('charges from Conceal, and the universal Charge still refuses', () => {
    const { ctx, state } = setup();
    const boy = opWith(state, 'p1', 'kommandos.boy');
    const foe = opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior');
    state.operatives[boy]!.pos = { x: 12, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    for (const id of state.teams.p2.operativeIds) if (id !== foe) state.operatives[id]!.pos = { x: 27, y: 21 };
    const s = activate(ctx, state, boy, 'conceal');
    const normal = reduce(
      s,
      { t: 'PerformAction', operativeId: boy, action: 'Charge', params: { path: { points: [{ x: 14.6, y: 11 }] } } },
      ctx,
    );
    expect(normal.ok).toBe(false);
    expect(normal.reason).toMatch(/Conceal/);

    const slittas = reduce(
      s,
      { t: 'PerformAction', operativeId: boy, action: THROAT_SLITTAS_CHARGE, params: { path: { points: [{ x: 14.6, y: 11 }] } } },
      ctx,
    );
    expect(slittas.ok, slittas.reason).toBe(true);
    // treatedAs: 'Charge' — the restriction key is shared with the universal action.
    expect(slittas.state.operatives[boy]!.actionsThisActivation).toContain('Charge');
  });

  it('is not available to a BOMB SQUIG — "(excluding BOMB SQUIG)"', () => {
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', 'kommandos.bomb-squig')]!;
    expect(getAction(THROAT_SLITTAS_CHARGE)!.available!(ctx, state, squig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('KOMMANDOS strategy ploys', () => {
  it('DAKKA! DAKKA! DAKKA!: "ranged weapons have the Punishing weapon rule"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'kommandos.sp.dakka-dakka-dakka' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'kommandos.boy')]!;
    const slugga = profileOf('kommandos.boy', 'Slugga');
    expect(
      effectiveRules(ctx, s, slugga, { operative: shooter, weaponName: 'Slugga' }).some((r) => r.id === 'Punishing'),
    ).toBe(true);
    const choppa = profileOf('kommandos.boy', 'Choppa');
    expect(
      effectiveRules(ctx, s, choppa, { operative: shooter, weaponName: 'Choppa' }).some((r) => r.id === 'Punishing'),
    ).toBe(false);
  });

  it('WAAAGH!: "melee weapons have the Balanced weapon rule"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'kommandos.sp.waaagh' }, ctx).state;
    const fighter = s.operatives[opWith(s, 'p1', 'kommandos.boy')]!;
    const choppa = profileOf('kommandos.boy', 'Choppa');
    expect(
      effectiveRules(ctx, s, choppa, { operative: fighter, weaponName: 'Choppa' }).some((r) => r.id === 'Balanced'),
    ).toBe(true);
  });

  it('SKULK ABOUT: "retain one of your defence dice as a normal success without rolling it (in addition to a cover save, if any)"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'kommandos.sp.skulk-about' }, ctx).state;
    const target = s.operatives[opWith(s, 'p1', 'kommandos.boy')]!;
    target.order = 'conceal';
    const shooter = s.operatives[opWith(s, 'p2', 'celestian-insidiants.insidiant-warrior')]!;
    const pistol = profileOf('celestian-insidiants.insidiant-warrior', 'Bolt pistol');
    s.sequence = shootStub(shooter.id, target.id);
    const base = {
      state: s,
      ctx: {
        attacker: shooter,
        defender: target,
        weaponName: 'Bolt pistol',
        profile: pistol,
        rules: pistol.rules,
        type: 'ranged' as const,
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 6,
      },
      count: 3,
      coverSaveAsCrit: false,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    };
    const noCover = ctx.hooks.emit('onDefenceDice', s, { ...base, coverSave: false, extraCoverSaves: 0 });
    expect(noCover.coverSave).toBe(true);
    const inCover = ctx.hooks.emit('onDefenceDice', s, { ...base, coverSave: true, extraCoverSaves: 0 });
    expect(inCover.extraCoverSaves).toBe(1);
  });

  it('SSSSHHHH!: a free Dash for hidden operatives, and "You cannot use this ploy during the first turning point"', () => {
    const { ctx, state } = setup();
    const ploy = kommandos.ploys.find((p) => p.id === 'kommandos.sp.sssshhhh')!;
    expect(ploy.usable!({ ...state, turningPoint: 1 }, 'p1').ok).toBe(false);
    expect(ploy.usable!({ ...state, turningPoint: 2 }, 'p1').ok).toBe(true);

    const s: GameState = { ...state, turningPoint: 2 };
    for (const id of s.teams.p1.operativeIds) s.operatives[id]!.order = 'conceal';
    for (const id of s.teams.p2.operativeIds) s.operatives[id]!.pos = { x: 27, y: 21 };
    const out = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: 'kommandos.sp.sssshhhh' }, ctx);
    const boy = out.state.operatives[opWith(out.state, 'p1', 'kommandos.boy')]!;
    expect(boy.aplMods).toContain(1);
    expect(aplOf(ctx, out.state, boy)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('KOMMANDOS firefight ploys', () => {
  it('JUST A SCRATCH: "Ignore that inflicted damage" — but not for a BOMB SQUIG or GROT', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'kommandos.fp.just-a-scratch' }, ctx).state;
    const grot = s.operatives[opWith(s, 'p1', 'kommandos.grot')]!;
    const grotBefore = grot.wounds;
    inflictDamage(ctx, s, grot, 3, 'attack');
    expect(grot.wounds).toBe(grotBefore - 3);

    const boy = s.operatives[opWith(s, 'p1', 'kommandos.boy')]!;
    const before = boy.wounds;
    inflictDamage(ctx, s, boy, 4, 'attack');
    expect(boy.wounds).toBe(before);
  });

  it('KRUMP ’EM!: "It can immediately perform a free Fight action"', () => {
    const { ctx, state } = setup();
    const boy = opWith(state, 'p1', 'kommandos.boy');
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'kommandos.fp.krump-em', data: { operativeId: boy } }, ctx);
    const op = out.state.operatives[boy]!;
    expect(aplOf(ctx, out.state, op)).toBe(3);
    op.apSpent = 2;
    const dash = availableActions(ctx, out.state, op).find((a) => a.def.id === 'Dash');
    expect(dash?.reason ?? '').toMatch(/must be Fight/);
  });

  it('KUNNIN’ BUT BRUTAL: "Treat that normal success as a critical success instead"', () => {
    const { ctx, state } = setup();
    const boy = state.operatives[opWith(state, 'p1', 'kommandos.boy')]!;
    const foe = state.operatives[opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior')]!;
    boy.order = 'conceal';
    boy.actionsThisActivation = ['Charge'];
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'kommandos.fp.kunnin-but-brutal' }, ctx).state;
    const b = s.operatives[boy.id]!;
    b.order = 'conceal';
    b.actionsThisActivation = ['Charge'];
    s.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: b.id,
      defenderId: foe.id,
      attackerWeapon: 'Choppa',
      attackerPool: { dice: [{ id: 1, value: 4, state: 'normal', rolled: true }], nextId: 2 },
      defenderPool: { dice: [], nextId: 1 },
      defenderCanRetaliate: false,
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
    const choppa = profileOf('kommandos.boy', 'Choppa');
    effectiveRules(ctx, s, choppa, { operative: b, target: s.operatives[foe.id]!, weaponName: 'Choppa' });
    expect(s.sequence.kind === 'fight' && s.sequence.attackerPool.dice[0]!.state).toBe('crit');
  });

  it('SHAKE IT OFF: "you can ignore any changes to its APL stat"', () => {
    const { ctx, state } = setup();
    const boy = opWith(state, 'p1', 'kommandos.boy');
    state.operatives[boy]!.aplMods.push(-1);
    expect(aplOf(ctx, state, state.operatives[boy]!)).toBe(1);
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'kommandos.fp.shake-it-off', data: { operativeId: boy } }, ctx).state;
    expect(aplOf(ctx, s, s.operatives[boy]!)).toBe(2);
    // A later change is ignored too: `aplOf` reads `op.aplMods` directly (the engine never
    // emits onStatMod for APL), so the effect clears them whenever the operative acts.
    s.operatives[boy]!.aplMods.push(-1);
    const activated = activate(ctx, s, boy);
    expect(aplOf(ctx, activated, activated.operatives[boy]!)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('KOMMANDOS faction equipment', () => {
  it('CHOPPAS: "Friendly KOMMANDO operatives … have the following melee weapon", never replacing a better one', () => {
    const { ctx, state } = setup(['kommandos.eq.choppas']);
    const burna = opWith(state, 'p1', 'kommandos.burna-boy');
    const s = activate(ctx, state, burna);
    const granted = (id: string): string[] =>
      ((s.operatives[id] as { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).map((w) => w.name);
    expect(granted(burna)).toContain('Choppa');
    // "some operatives already have this weapon but with better stats; in that instance, use
    // the better version" — the BOY keeps its own Choppa (ATK 4).
    expect(granted(opWith(s, 'p1', 'kommandos.boy'))).not.toContain('Choppa');
    // "(excluding BOMB SQUIG and GROT)"
    expect(granted(opWith(s, 'p1', 'kommandos.grot'))).not.toContain('Choppa');
  });

  it('DYNAMITE is "Once per battle" and HARPOON "Once per turning point"', () => {
    const { ctx, state } = setup(['kommandos.eq.dynamite', 'kommandos.eq.harpoon']);
    const boy = opWith(state, 'p1', 'kommandos.boy');
    const s = activate(ctx, state, boy);
    const names = (): string[] =>
      ctx.hooks.emit('availableWeapons', s, {
        state: s,
        operative: s.operatives[boy]!,
        weapons: ['Slugga', 'Dynamite', 'Harpoon'],
      }).weapons;
    expect(names()).toEqual(['Slugga', 'Dynamite', 'Harpoon']);
    s.opState['teamOnceBattle'] = { 'kommandos.dynamite:p1': true };
    s.opState['teamOnce'] = { 'kommandos.harpoon:p1': `${s.turningPoint}` };
    expect(names()).toEqual(['Slugga']);
  });

  it('COLLAPSIBLE STOCKS: "Remove the Range weapon rule from … Shokka pistol, Slugga"', () => {
    const { ctx, state } = setup(['kommandos.eq.collapsible-stocks']);
    const comms = state.operatives[opWith(state, 'p1', 'kommandos.comms-boy')]!;
    const shokka = profileOf('kommandos.comms-boy', 'Shokka pistol');
    expect(
      effectiveRules(ctx, state, shokka, { operative: comms, weaponName: 'Shokka pistol' }).some((r) => r.id === 'Range'),
    ).toBe(false);
    const boy = state.operatives[opWith(state, 'p1', 'kommandos.boy')]!;
    const slugga = profileOf('kommandos.boy', 'Slugga');
    expect(
      effectiveRules(ctx, state, slugga, { operative: boy, weaponName: 'Slugga' }).some((r) => r.id === 'Range'),
    ).toBe(false);
    // Other weapons keep theirs.
    const knives = profileOf('kommandos.slasha-boy', 'Throwing knives');
    expect(
      effectiveRules(ctx, state, knives, { operative: boy, weaponName: 'Throwing knives' }).some((r) => r.id === 'Range'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('KOMMANDOS unique actions and abilities', () => {
  it('Krumpin’ Time: "This operative can perform two Fight actions during its activation"', () => {
    const { ctx, state } = setup();
    const nob = opWith(state, 'p1', 'kommandos.boss-nob');
    const foe = opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior');
    state.operatives[nob]!.pos = { x: 15, y: 11 };
    state.operatives[foe]!.pos = { x: 15.9, y: 11 };
    const s = activate(ctx, state, nob);
    const first = reduce(
      s,
      { t: 'PerformAction', operativeId: nob, action: KRUMPIN_TIME_FIGHT, params: { meleeWeaponName: 'Big choppa', targetId: foe } },
      ctx,
    );
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/second Fight action/);
    expect(availableActions(ctx, s, s.operatives[nob]!).some((a) => a.def.id === KRUMPIN_TIME_FIGHT)).toBe(true);
  });

  it('GET IT DUN! 1AP: "add 1 to its APL stat" for another KOMMANDO within 6"', () => {
    const { ctx, state } = setup();
    const nob = opWith(state, 'p1', 'kommandos.boss-nob');
    const boy = opWith(state, 'p1', 'kommandos.boy');
    state.operatives[nob]!.pos = { x: 12, y: 11 };
    state.operatives[boy]!.pos = { x: 15, y: 11 };
    let s = activate(ctx, state, nob);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: nob, action: 'kommandos.boss-nob.act.get-it-dun', params: { targetOperativeId: boy } },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[boy]!)).toBe(3);
  });

  it('Stoopid: "This operative cannot perform any actions other than Charge, Dash, Fight, Reposition and Shoot"', () => {
    const { ctx, state } = setup();
    const squig = state.operatives[opWith(state, 'p1', 'kommandos.bomb-squig')]!;
    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: squig,
      action: 'Pick Up Marker',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
    const allowed = ctx.hooks.emit('canPerformAction', state, { state, operative: squig, action: 'Charge', allowed: true });
    expect(allowed.allowed).toBe(true);
    // "whenever you determine this operative's order, you cannot select Conceal"
    const s = activate(ctx, state, squig.id, 'conceal');
    expect(s.operatives[squig.id]!.order).toBe('engage');
  });

  it('Explosive: the BOMB SQUIG shoots "while within control range of an enemy operative", itself the primary target', () => {
    const { ctx, state } = setup();
    const squig = opWith(state, 'p1', 'kommandos.bomb-squig');
    const foe = opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior');
    state.operatives[squig]!.pos = { x: 15, y: 11 };
    state.operatives[foe]!.pos = { x: 15.7, y: 11 };
    for (const id of state.teams.p1.operativeIds) if (id !== squig) state.operatives[id]!.pos = { x: 2, y: 2 };
    const s = activate(ctx, state, squig, 'engage');
    // The universal Shoot action refuses while engaged.
    const normal = reduce(
      s,
      { t: 'PerformAction', operativeId: squig, action: 'Shoot', params: { weaponName: 'Explosives', targetId: foe } },
      ctx,
    );
    expect(normal.ok).toBe(false);
    const out = reduce(
      s,
      { t: 'PerformAction', operativeId: squig, action: EXPLOSIVE_SHOOT, params: { weaponName: 'Explosives' } },
      ctx,
    );
    expect(out.ok, out.reason).toBe(true);
    expect(out.state.log.some((l) => l.text.includes('shoots') && l.text.includes('Explosives'))).toBe(true);
  });

  it('Boom!: "If any result is a 4+, this operative performs a free Shoot action with its explosives"', () => {
    const ctx = teamContext([kommandos, celestianInsidiants], { script: [5, 5] });
    const state = battle({
      ctx,
      p1: { module: kommandos, picks: rosterIncluding(kommandos, EVERY_ROLE) },
      p2: { module: celestianInsidiants },
    });
    const squig = state.operatives[opWith(state, 'p1', 'kommandos.bomb-squig')]!;
    const foe = state.operatives[opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior')]!;
    squig.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.6, y: 11 };
    const before = foe.wounds;
    inflictDamage(ctx, state, squig, 99, 'attack');
    expect(foe.wounds).toBeLessThan(before);
  });

  it('Sneaky Zogger: a GROT in cover "cannot be selected as a valid target … except being within 2\\""', () => {
    const { ctx, state } = setup();
    const grot = state.operatives[opWith(state, 'p1', 'kommandos.grot')]!;
    const shooter = state.operatives[opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior')]!;
    grot.pos = { x: 15, y: 11 };
    shooter.pos = { x: 15.5, y: 11 };
    const close = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: grot,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
    });
    expect(close.valid).toBe(true); // within 2"
    expect(rule('kommandos.rule.throat-slittas')).toContain('Charge action while it has a Conceal order');
  });

  it('Concealed Position: the concealed profile is refused after the SNIPA BOY has shot once', () => {
    const { ctx, state } = setup();
    const sniper = state.operatives[opWith(state, 'p1', 'kommandos.snipa-boy')]!;
    const foe = state.operatives[opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior')]!;
    const concealed = profileOf('kommandos.snipa-boy', 'Scoped big shoota', 'concealed');
    state.opState['kommandos.shot'] = { [sniper.id]: true };
    const ev = ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: {
        attacker: sniper,
        defender: foe,
        weaponName: 'Scoped big shoota',
        profile: concealed,
        rules: concealed.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      allowed: true,
      dryRun: false,
    });
    expect(ev.allowed).toBe(false);
  });

  it('Dat All You Got?: "you can inflict D3 damage on the enemy operative in that sequence"', () => {
    const ctx = teamContext([kommandos, celestianInsidiants], { script: [3] });
    const state = battle({
      ctx,
      p1: { module: kommandos, picks: rosterIncluding(kommandos, EVERY_ROLE) },
      p2: { module: celestianInsidiants },
    });
    const slasha = state.operatives[opWith(state, 'p1', 'kommandos.slasha-boy')]!;
    const foe = state.operatives[opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior')]!;
    state.sequence = {
      kind: 'fight',
      step: 'resolve',
      attackerId: slasha.id,
      defenderId: foe.id,
      attackerWeapon: 'Twin choppas',
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
      defenderCanRetaliate: false,
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
    const twin = profileOf('kommandos.slasha-boy', 'Twin choppas');
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: {
        attacker: slasha,
        defender: foe,
        weaponName: 'Twin choppas',
        profile: twin,
        rules: twin.rules,
        type: 'melee',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 0,
      },
      crit: false,
      struck: foe,
    });
    expect(foe.wounds).toBeLessThan(before);
  });

  it('I Got a Plan, Ladz: "the Pick Up Marker, Place Marker or a mission action for 1 less AP", once per activation', () => {
    const { ctx, state } = setup();
    const comms = state.operatives[opWith(state, 'p1', 'kommandos.comms-boy')]!;
    const first = ctx.hooks.emit('onActionCost', state, { state, operative: comms, action: 'Pick Up Marker', ap: 1 });
    expect(first.ap).toBe(0);
    const second = ctx.hooks.emit('onActionCost', state, { state, operative: comms, action: 'Place Marker', ap: 1 });
    expect(second.ap).toBe(1);
  });

  it('Taktical Wot-notz: a KOMMANDO BOY performs the Stun Grenade action once per turning point', () => {
    const { ctx, state } = setup();
    const boy = opWith(state, 'p1', 'kommandos.boy');
    const foe = opWith(state, 'p2', 'celestian-insidiants.insidiant-warrior');
    state.operatives[boy]!.pos = { x: 12, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    const s = activate(ctx, state, boy);
    const out = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: boy,
        action: 'Stun Grenade (Taktical Wot-notz)',
        params: { targetOperativeId: foe },
      },
      ctx,
    );
    expect(out.ok, out.reason).toBe(true);
    // "doesn't count towards their action limits" — the kill team's grenade uses are untouched.
    expect(out.state.teams.p1.equipmentUses['used:eq.utilityGrenades:stun'] ?? 0).toBe(0);
    const again = ctx.hooks.emit('canPerformAction', out.state, {
      state: out.state,
      operative: out.state.operatives[boy]!,
      action: 'Stun Grenade (Taktical Wot-notz)',
      allowed: true,
    });
    expect(again.allowed).toBe(false);
  });
});

function shootStub(attackerId: string, targetId: string): GameState['sequence'] {
  return {
    kind: 'shoot',
    step: 'rollDefence',
    attackerId,
    targetId,
    queue: [],
    resolvedTargets: [],
    weaponName: 'Bolt pistol',
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
}

// ---------------------------------------------------------------------------
describe('KOMMANDOS bot-vs-bot soak (zero rejected intents)', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const map = mapById(mapId);
      const ctx = createGameContext({
        rng: new SeededRng(52),
        datacards: [...kommandos.datacards, ...celestianInsidiants.datacards],
        maps: [map],
        teams: [kommandos, celestianInsidiants],
      });
      for (const mod of [kommandos, celestianInsidiants]) for (const eq of mod.equipmentDefs) ctx.equipment.set(eq.id, eq);
      const result = playGame({
        ctx,
        map,
        seed: 52,
        critOpId: 'crit.secure',
        rosters: {
          p1: {
            teamId: kommandos.id,
            operatives: defaultRoster(kommandos.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: kommandos.equipment.slice(0, 3).map((e) => e.id),
          },
          p2: {
            teamId: celestianInsidiants.id,
            operatives: defaultRoster(celestianInsidiants.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: celestianInsidiants.equipment.slice(0, 2).map((e) => e.id),
          },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
    }, 60_000);
  }
});
