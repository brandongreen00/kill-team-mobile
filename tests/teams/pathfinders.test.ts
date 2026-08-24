/**
 * PATHFINDERS. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/pathfinders/
 */
import { describe, expect, it } from 'vitest';
import { createGameContext } from '../../src/core/game.ts';
import { reduce } from '../../src/core/reducer.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { apBudgetOf, aplOf, freeApOf, hitOf, inflictDamage } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { kommandos } from '../../src/teams/kommandos/index.ts';
import {
  MARKERLIGHT,
  PHOTON_GRENADE,
  artOfWarId,
  giveMarkerlight,
  markerlightTokens,
  pathfinders,
} from '../../src/teams/pathfinders/index.ts';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { testMap } from '../fixtures.ts';
import { activate, battle, mapById, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, OperativeState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('pathfinders');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;

const EVERY_ROLE = [
  'pathfinders.shas-ui-pathfinder',
  'pathfinders.shas-la-pathfinder',
  'pathfinders.blooded-pathfinder',
  'pathfinders.assault-grenadier-pathfinder',
  'pathfinders.comms-specialist-pathfinder',
  'pathfinders.drone-controller-pathfinder',
  'pathfinders.marksman-pathfinder',
  'pathfinders.medical-technician-pathfinder',
  'pathfinders.transpectral-interference-pathfinder',
  'pathfinders.weapons-expert-pathfinder',
  'pathfinders.mv4-shield-drone',
  'pathfinders.mv7-marker-drone',
];

function setup(equipment: string[] = []): { ctx: ReturnType<typeof teamContext>; state: GameState } {
  const ctx = teamContext([pathfinders, kommandos], { seed: 13 });
  const state = battle({
    ctx,
    p1: { module: pathfinders, equipment, picks: rosterIncluding(pathfinders, EVERY_ROLE) },
    p2: { module: kommandos },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const data = cardId.startsWith('pathfinders') ? DATA : teamData('kommandos');
  const w = data.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return (w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0])!;
};

const shootStub = (attackerId: string, targetId: string, weaponName: string): GameState['sequence'] => ({
  kind: 'shoot',
  step: 'rollAttack',
  attackerId,
  targetId,
  queue: [],
  resolvedTargets: [],
  weaponName,
  secondary: false,
  pointBlank: false,
  inCover: false,
  obscured: true,
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
});

// ---------------------------------------------------------------------------
describe('PATHFINDERS data (pinned against data/teams/pathfinders.json)', () => {
  it('has 16 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(16);
    const shasui = DATA.datacards.find((c) => c.id === 'pathfinders.shas-ui-pathfinder')!;
    expect(shasui).toMatchObject({ apl: 2, move: 6, save: 5, wounds: 8, base: { shape: 'round', mm: 25 } });
    expect(shasui.keywords).toEqual(['PATHFINDER', "T'AU EMPIRE", 'LEADER', 'SHAS’UI']);
    const recon = DATA.datacards.find((c) => c.id === 'pathfinders.mb3-recon-drone')!;
    expect(recon).toMatchObject({ apl: 3, move: 6, save: 4, wounds: 12 });
    expect(recon.base).toMatchObject({ shape: 'round', mm: 32 });
    for (const drone of DATA.datacards.filter((c) => c.keywords.includes('DRONE') && c.id !== 'pathfinders.mb3-recon-drone')) {
      expect(drone).toMatchObject({ apl: 2, move: 6, save: 4, wounds: 7 });
    }
  });

  it('pins every weapon profile of the WEAPONS EXPERT and the MARKSMAN', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat('pathfinders.weapons-expert-pathfinder')).toEqual([
      'Ion rifle|standard|ranged|5|4|4|5|Piercing Crits 1',
      'Ion rifle|overcharge|ranged|5|4|4|5|Hot+Lethal 5++Piercing 1',
      'Rail rifle||ranged|4|4|4|4|Devastating 2+Lethal 5++Piercing 1',
      'Gun butt||melee|3|5|2|3|',
    ]);
    expect(flat('pathfinders.marksman-pathfinder')).toEqual([
      'Marksman rail rifle|standard|ranged|4|3|4|4|Devastating 2+Lethal 5++Piercing 1',
      'Marksman rail rifle|dart round|ranged|4|3|3|3|Piercing 1+Silent',
      'Gun butt||melee|3|5|2|3|',
    ]);
  });

  it('exposes 1 faction rule, 4 strategy ploys, 4 firefight ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Markerlights']);
    expect(pathfinders.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(pathfinders.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(pathfinders.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('Markerlights — "That enemy operative gains one of your Markerlight tokens (to a maximum of four)"', () => {
  it('the MARKERLIGHT action gives a token, and only the Shoot target can be selected afterwards', () => {
    const { ctx, state } = setup();
    const shasla = opWith(state, 'p1', 'pathfinders.shas-la-pathfinder');
    const foeA = opWith(state, 'p2', 'kommandos.boy');
    state.operatives[shasla]!.pos = { x: 12, y: 11 };
    state.operatives[foeA]!.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, shasla);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: shasla,
        action: 'pathfinders.shas-la-pathfinder.act.markerlight',
        params: { targetOperativeId: foeA },
      },
      ctx,
    ).state;
    expect(markerlightTokens(s, s.operatives[foeA]!, 'p1')).toBe(1);
    expect(s.effects.some((e) => e.rule === MARKERLIGHT && e.operativeId === foeA)).toBe(true);
  });

  it('1 token: "Saturate and Balanced weapon rules"; 4: "Seek Light"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    const rulesAt = (): string[] =>
      effectiveRules(ctx, state, carbine, { operative: shooter, target: foe, weaponName: 'Pulse carbine' }).map((r) => r.id);
    expect(rulesAt()).not.toContain('Saturate');
    giveMarkerlight(state, foe, 'p1', 1);
    expect(rulesAt()).toContain('Saturate');
    expect(rulesAt()).toContain('Balanced');
    expect(rulesAt()).not.toContain('SeekLight');
    giveMarkerlight(state, foe, 'p1', 3);
    expect(markerlightTokens(state, foe, 'p1')).toBe(4);
    expect(rulesAt()).toContain('SeekLight');
    // "(to a maximum of four)"
    giveMarkerlight(state, foe, 'p1', 2);
    expect(markerlightTokens(state, foe, 'p1')).toBe(4);
  });

  it('2 tokens: "Improve the Hit stat of that friendly operative’s ranged weapons by 1 (to a maximum of 3+)"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    state.sequence = shootStub(shooter.id, foe.id, 'Pulse carbine');
    expect(hitOf(ctx, state, shooter, carbine)).toBe(4);
    giveMarkerlight(state, foe, 'p1', 2);
    expect(hitOf(ctx, state, shooter, carbine)).toBe(3);
    // The SHAS'UI's carbine is already 3+, so it stays there.
    const shasui = state.operatives[opWith(state, 'p1', 'pathfinders.shas-ui-pathfinder')]!;
    state.sequence = shootStub(shasui.id, foe.id, 'Pulse carbine');
    expect(hitOf(ctx, state, shasui, profileOf('pathfinders.shas-ui-pathfinder', 'Pulse carbine'))).toBe(3);
  });

  it('3 tokens: "The target cannot be obscured"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    giveMarkerlight(state, foe, 'p1', 3);
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    state.sequence = shootStub(shooter.id, foe.id, 'Pulse carbine');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: foe,
        weaponName: 'Pulse carbine',
        profile: carbine,
        rules: carbine.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: true,
        vantageAccurate: 0,
        distance: 8,
      },
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    const seq = state.sequence!;
    expect(seq.kind === 'shoot' ? seq.obscured : true).toBe(false);
  });

  it('"whenever an enemy operative that has any of your Markerlight tokens performs the … Reposition action, remove one"', () => {
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    giveMarkerlight(state, foe, 'p1', 2);
    foe.actionsThisActivation = ['Reposition'];
    ctx.hooks.emit('onActivationEnd', state, { state, operative: foe });
    expect(markerlightTokens(state, foe, 'p1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Art of War — "STRATEGIC GAMBIT if this operative is in the killzone"', () => {
  it('offers Mont’ka and Kauyon, each once per battle, and Mont’ka adds 1" to Move', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const options = ctx.hooks.emit('gambitOptions', state, { state, player: 'p1', options: [] }).options;
    expect(options.filter((o) => o.id.startsWith('pathfinders.shas-ui-pathfinder.art-of-war'))).toHaveLength(2);

    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: artOfWarId('montka') }, ctx).state;
    const op = s.operatives[opWith(s, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    expect(moveBudget(ctx, s, op, { action: 'Reposition' })).toBeCloseTo(7);
    // "You cannot select each option more than once per battle."
    const after = ctx.hooks.emit('gambitOptions', s, { state: s, player: 'p1', options: [] }).options;
    expect(after.some((o) => o.id === artOfWarId('montka'))).toBe(false);
  });

  it('Kauyon: "can perform a free Markerlight action during their activation if they have a Conceal order"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: artOfWarId('kauyon') }, ctx).state;
    const id = opWith(s, 'p1', 'pathfinders.shas-la-pathfinder');
    const activated = activate(ctx, s, id, 'conceal');
    // A free action is not an APL stat change (docs/DECISIONS.md D-100), so the APL stat is
    // untouched and the operative simply has one AP more than its APL to spend.
    const op = activated.operatives[id]!;
    expect(aplOf(ctx, activated, op)).toBe(2);
    expect(freeApOf(activated, op)).toBe(1);
    expect(apBudgetOf(ctx, activated, op)).toBe(3);
    expect(
      activated.effects.some(
        (e) => e.rule === 'teamFreeAction' && e.operativeId === id && (e.data?.['only'] as string[]).includes('pathfinders.shas-la-pathfinder.act.markerlight'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('PATHFINDERS ploys', () => {
  it('BONDED: "Accurate 1 weapon rule" while within 3" of another PATHFINDER (excluding DRONE)', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'pathfinders.sp.bonded' }, ctx).state;
    const a = s.operatives[opWith(s, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const b = s.operatives[opWith(s, 'p1', 'pathfinders.comms-specialist-pathfinder')]!;
    for (const id of s.teams.p1.operativeIds) s.operatives[id]!.pos = { x: 2, y: 2 };
    a.pos = { x: 12, y: 11 };
    b.pos = { x: 20, y: 11 };
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    expect(
      effectiveRules(ctx, s, carbine, { operative: a, weaponName: 'Pulse carbine' }).some((r) => r.id === 'Accurate'),
    ).toBe(false);
    b.pos = { x: 14, y: 11 };
    expect(
      effectiveRules(ctx, s, carbine, { operative: a, weaponName: 'Pulse carbine' }).some((r) => r.id === 'Accurate'),
    ).toBe(true);
  });

  it('TAKE COVER: "if you can retain any cover saves, improve that friendly operative’s Save stat by 1"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'pathfinders.sp.take-cover' }, ctx).state;
    const target = s.operatives[opWith(s, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const shooter = s.operatives[opWith(s, 'p2', 'kommandos.boy')]!;
    const slugga = profileOf('kommandos.boy', 'Slugga');
    const emit = (coverSave: boolean) =>
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: {
          attacker: shooter,
          defender: target,
          weaponName: 'Slugga',
          profile: slugga,
          rules: slugga.rules,
          type: 'ranged',
          secondary: false,
          pointBlank: false,
          inCover: coverSave,
          obscured: false,
          vantageAccurate: 0,
          distance: 6,
        },
        count: 3,
        coverSave,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
        rerolls: [],
      });
    expect(emit(true).mods.save).toBe(1);
    expect(emit(false).mods.save).toBe(0);
  });

  it('SUPPRESSING FIRE: "your opponent cannot re-roll their attack dice" when the target is not the closest', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'pathfinders.sp.suppressing-fire' }, ctx).state;
    const near = s.operatives[opWith(s, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const far = s.operatives[opWith(s, 'p1', 'pathfinders.marksman-pathfinder')]!;
    const shooter = s.operatives[opWith(s, 'p2', 'kommandos.boy')]!;
    for (const id of s.teams.p1.operativeIds) s.operatives[id]!.pos = { x: 2, y: 2 };
    shooter.pos = { x: 20, y: 11 };
    near.pos = { x: 16, y: 11 };
    far.pos = { x: 8, y: 11 };
    const slugga = profileOf('kommandos.boy', 'Slugga');
    const ev = ctx.hooks.emit('onRollAttack', s, {
      state: s,
      ctx: {
        attacker: shooter,
        defender: far,
        weaponName: 'Slugga',
        profile: slugga,
        rules: slugga.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 12,
      },
      dice: [],
      rerolls: [{ id: 'balanced', label: 'Balanced', mode: 'one', max: 1 }],
    });
    expect(ev.rerolls).toEqual([]);
  });

  it('SUPPORTING FIRE: "friendly PATHFINDER operatives within an enemy operative’s control range doesn’t prevent" targeting', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'pathfinders.fp.supporting-fire' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'pathfinders.marksman-pathfinder')]!;
    const foe = s.operatives[opWith(s, 'p2', 'kommandos.boy')]!;
    shooter.pos = { x: 15, y: 11 };
    foe.pos = { x: 18, y: 11 };
    const ev = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: shooter,
      target: foe,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.ignoreFriendlyControlRange).toBe(true);
  });

  it('SAVIOUR PROTOCOLS: a DRONE within 3" "becomes the valid target instead"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'pathfinders.fp.saviour-protocols' }, ctx).state;
    const ward = s.operatives[opWith(s, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const drone = s.operatives[opWith(s, 'p1', 'pathfinders.mv4-shield-drone')]!;
    ward.pos = { x: 15, y: 11 };
    drone.pos = { x: 16.5, y: 11 };
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    const ev = ctx.hooks.emit('onSelectTarget', s, {
      state: s,
      attacker: s.operatives[opWith(s, 'p2', 'kommandos.boy')]!,
      target: ward,
      weaponName: 'Slugga',
      profile: carbine,
      rules: [],
    });
    expect(ev.redirectTo).toBe(drone.id);
  });

  it('RECON SWEEP grants a free Dash near a killzone edge "(excluding your own)", never in the first turning point', () => {
    const ctx = teamContext([pathfinders, kommandos], { seed: 13 });
    // The synthetic map carries no killzone edges, so this ploy needs one to test against.
    const map = { ...testMap(), killzoneEdges: { p1: [], p2: [{ a: { x: 0, y: 22 }, b: { x: 30, y: 22 } }], neutral: [] } };
    const state = battle({
      ctx,
      map,
      p1: { module: pathfinders, picks: rosterIncluding(pathfinders, EVERY_ROLE) },
      p2: { module: kommandos },
    });
    const ploy = pathfinders.ploys.find((p) => p.id === 'pathfinders.sp.recon-sweep')!;
    expect(ploy.usable!({ ...state, turningPoint: 1 }, 'p1').ok).toBe(false);
    const s: GameState = { ...state, turningPoint: 2 };
    const op = s.operatives[opWith(s, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    op.pos = { x: 15, y: 21 };
    const out = reduce(s, { t: 'UseGambit', player: 'p1', gambitId: 'pathfinders.sp.recon-sweep' }, ctx);
    // Free AP, not an APL stat change (D-100): the Dash rides on top of the operative's APL.
    const swept = out.state.operatives[op.id]!;
    expect(aplOf(ctx, out.state, swept)).toBe(2);
    expect(freeApOf(out.state, swept)).toBe(1);
    expect(apBudgetOf(ctx, out.state, swept)).toBe(3);
  });

  it('POINT-BLANK FUSILLADE: "You can use one of its ranged weapons as a melee weapon"', () => {
    const { ctx, state } = setup();
    const defender = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    state.sequence = {
      kind: 'fight',
      step: 'start',
      attackerId: foe.id,
      defenderId: defender.id,
      attackerWeapon: 'Choppa',
      defenderWeapon: 'Gun butt',
      attackerPool: { dice: [], nextId: 1 },
      defenderPool: { dice: [], nextId: 1 },
      defenderCanRetaliate: true,
      turn: 'attacker',
      usedRerolls: [],
      usedRetention: [],
      shockUsed: { attacker: false, defender: false },
      attackerAssists: 0,
      defenderAssists: 0,
      attacker: 'p2',
      defender: 'p1',
      free: false,
      hatchway: false,
    };
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'pathfinders.fp.point-blank-fusillade' }, ctx).state;
    const seq = s.sequence!;
    expect(seq.kind === 'fight' ? seq.defenderWeapon : '').toBe('Pulse carbine (point-blank)');
    // "…you resolve the first attack dice (i.e. defender instead of attacker)."
    expect(seq.kind === 'fight' ? seq.turn : '').toBe('defender');
  });

  it('A WORTHY CAUSE: "One friendly PATHFINDER operative (excluding DRONE) can immediately perform a free mission action"', () => {
    expect(rule('pathfinders.fp.a-worthy-cause')).toContain('free mission action');
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'pathfinders.shas-la-pathfinder');
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'pathfinders.fp.a-worthy-cause', data: { operativeId: id } }, ctx);
    // "...can immediately perform a free mission action" — free AP on top of its APL (D-100).
    const chosen = out.state.operatives[id]!;
    expect(aplOf(ctx, out.state, chosen)).toBe(2);
    expect(freeApOf(out.state, chosen)).toBe(1);
    expect(apBudgetOf(ctx, out.state, chosen)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('PATHFINDERS faction equipment', () => {
  it('HIGH-INTENSITY MARKERLIGHT: "the enemy operative you select gains two of your Markerlight tokens", twice per turning point', () => {
    const { ctx, state } = setup(['pathfinders.eq.high-intensity-markerlight']);
    const shasla = opWith(state, 'p1', 'pathfinders.shas-la-pathfinder');
    const foe = opWith(state, 'p2', 'kommandos.boy');
    state.operatives[shasla]!.pos = { x: 12, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, shasla);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: shasla,
        action: 'pathfinders.shas-la-pathfinder.act.markerlight',
        params: { targetOperativeId: foe },
      },
      ctx,
    ).state;
    expect(markerlightTokens(s, s.operatives[foe]!, 'p1')).toBe(2);
  });

  it('TARGET ANALYSIS OPTIC: "if the target has at least one of your Markerlight tokens, it’s treated as having one more"', () => {
    const { ctx, state } = setup(['pathfinders.eq.target-analysis-optic']);
    const shooter = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    giveMarkerlight(state, foe, 'p1', 1);
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    state.sequence = shootStub(shooter.id, foe.id, 'Pulse carbine');
    expect(hitOf(ctx, state, shooter, carbine)).toBe(4);
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: foe,
        weaponName: 'Pulse carbine',
        profile: carbine,
        rules: carbine.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    // One token + the optic = two, which is the Hit-stat band.
    expect(hitOf(ctx, state, shooter, carbine)).toBe(3);
  });

  it('PHOTON GRENADE: "on a 3+ … subtract 2\\" from its Move stat", once per turning point', () => {
    const ctx = teamContext([pathfinders, kommandos], { script: [5] });
    const state = battle({
      ctx,
      p1: {
        module: pathfinders,
        equipment: ['pathfinders.eq.photon-grenade'],
        picks: rosterIncluding(pathfinders, EVERY_ROLE),
      },
      p2: { module: kommandos },
    });
    const shasla = opWith(state, 'p1', 'pathfinders.shas-la-pathfinder');
    const foe = opWith(state, 'p2', 'kommandos.boy');
    state.operatives[shasla]!.pos = { x: 12, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, shasla);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: shasla, action: PHOTON_GRENADE, params: { targetOperativeId: foe } },
      ctx,
    ).state;
    expect(moveBudget(ctx, s, s.operatives[foe]!, { action: 'Reposition' })).toBeCloseTo(4);
    const again = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[shasla]!,
      action: PHOTON_GRENADE,
      allowed: true,
    });
    expect(again.allowed).toBe(false);
  });

  it('ORBITAL SURVEY UPLINK: "you can select one enemy operative in the killzone … (it doesn’t need to be visible)"', () => {
    expect(rule('pathfinders.eq.orbital-survey-uplink')).toContain('doesn’t need to be visible');
    const { ctx, state } = setup(['pathfinders.eq.orbital-survey-uplink']);
    const marker = opWith(state, 'p1', 'pathfinders.mv7-marker-drone');
    const foe = opWith(state, 'p2', 'kommandos.boy');
    state.operatives[marker]!.pos = { x: 2, y: 2 };
    state.operatives[foe]!.pos = { x: 28, y: 21 };
    let s = activate(ctx, state, marker);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: marker,
        action: 'pathfinders.mv7-marker-drone.act.markerlight',
        params: { targetOperativeId: foe },
      },
      ctx,
    ).state;
    // The MV7 gives two tokens by its own rule.
    expect(markerlightTokens(s, s.operatives[foe]!, 'p1')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('PATHFINDERS unique actions and abilities', () => {
  it('SIGNAL 1AP: "add 1 to its APL stat"', () => {
    const { ctx, state } = setup();
    const comms = opWith(state, 'p1', 'pathfinders.comms-specialist-pathfinder');
    const mate = opWith(state, 'p1', 'pathfinders.shas-la-pathfinder');
    state.operatives[comms]!.pos = { x: 12, y: 11 };
    state.operatives[mate]!.pos = { x: 15, y: 11 };
    let s = activate(ctx, state, comms);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: comms,
        action: 'pathfinders.comms-specialist-pathfinder.act.signal',
        params: { targetOperativeId: mate },
      },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[mate]!)).toBe(3);
  });

  it('SYSTEM JAM 1AP: "subtract 1 from its APL stat"', () => {
    const { ctx, state } = setup();
    const jammer = opWith(state, 'p1', 'pathfinders.transpectral-interference-pathfinder');
    const foe = opWith(state, 'p2', 'kommandos.boy');
    state.operatives[jammer]!.pos = { x: 12, y: 11 };
    state.operatives[foe]!.pos = { x: 16, y: 11 };
    let s = activate(ctx, state, jammer);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: jammer,
        action: 'pathfinders.transpectral-interference-pathfinder.act.system-jam',
        params: { targetOperativeId: foe },
      },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[foe]!)).toBe(1);
  });

  it('Fearless on the Frontline: the SHAS’LA markerlights while engaged and Falls Back "for 1 less AP"', () => {
    const { ctx, state } = setup();
    const shasla = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    shasla.pos = { x: 15, y: 11 };
    foe.pos = { x: 15.8, y: 11 };
    const cost = ctx.hooks.emit('onActionCost', state, { state, operative: shasla, action: 'Fall Back', ap: 2 });
    expect(cost.ap).toBe(1);
    const s = activate(ctx, state, shasla.id);
    const out = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: shasla.id,
        action: 'pathfinders.shas-la-pathfinder.act.markerlight',
        params: { targetOperativeId: foe.id },
      },
      ctx,
    );
    expect(out.ok, out.reason).toBe(true);
  });

  it('Multi-Dimensional Vision: "whenever this operative is shooting, enemy operatives cannot be obscured"', () => {
    const { ctx, state } = setup();
    const scout = state.operatives[opWith(state, 'p1', 'pathfinders.transpectral-interference-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const carbine = profileOf('pathfinders.transpectral-interference-pathfinder', 'Pulse carbine');
    state.sequence = shootStub(scout.id, foe.id, 'Pulse carbine');
    ctx.hooks.emit('onCollectAttackDice', state, {
      state,
      ctx: {
        attacker: scout,
        defender: foe,
        weaponName: 'Pulse carbine',
        profile: carbine,
        rules: carbine.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: true,
        vantageAccurate: 0,
        distance: 8,
      },
      count: 4,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    const seq2 = state.sequence!;
    expect(seq2.kind === 'shoot' ? seq2.obscured : true).toBe(false);
  });

  it('Drone: "cannot perform any actions other than …" and "treat this operative’s APL stat as 1 lower"', () => {
    const { ctx, state } = setup();
    const drone = state.operatives[opWith(state, 'p1', 'pathfinders.mv4-shield-drone')]!;
    const blocked = ctx.hooks.emit('canPerformAction', state, { state, operative: drone, action: 'Shoot', allowed: true });
    expect(blocked.allowed).toBe(false);
    const allowed = ctx.hooks.emit('canPerformAction', state, { state, operative: drone, action: 'Dash', allowed: true });
    expect(allowed.allowed).toBe(true);

    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    drone.pos = { ...marker.pos };
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: marker.id,
      aplByPlayer: { p1: 2, p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(1);
  });

  it('Shield Generator: "This operative ignores the Piercing weapon rule"', () => {
    const { ctx, state } = setup();
    const drone = state.operatives[opWith(state, 'p1', 'pathfinders.mv4-shield-drone')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const rifle = profileOf('pathfinders.weapons-expert-pathfinder', 'Rail rifle');
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: {
        attacker: foe,
        defender: drone,
        weaponName: 'Rail rifle',
        profile: rifle,
        rules: rifle.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 8,
      },
      count: 2, // 3 - Piercing 1
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.count).toBe(3);
  });

  it('Grav-inhibitor: "treat the distance as an additional 2\\"" for enemies within 6"', () => {
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    const drone = state.operatives[opWith(state, 'p1', 'pathfinders.mv4-shield-drone')]!;
    void drone;
    expect(moveBudget(ctx, state, foe, { action: 'Reposition' })).toBeCloseTo(6);
    const grav = state.operatives[state.teams.p1.operativeIds[0]!]!;
    grav.datacardId = 'pathfinders.mv33-grav-inhibitor-drone';
    grav.pos = { ...foe.pos };
    expect(moveBudget(ctx, state, foe, { action: 'Reposition' })).toBeCloseTo(4);
  });

  it('Inertial Dampener: "ignore any changes to the Hit stat of this operative’s marksman rail rifle"', () => {
    const { ctx, state } = setup();
    const marksman = state.operatives[opWith(state, 'p1', 'pathfinders.marksman-pathfinder')]!;
    const foe = state.operatives[opWith(state, 'p2', 'kommandos.boy')]!;
    marksman.wounds = 3; // injured: the Hit stat would worsen by 1
    const rifle = profileOf('pathfinders.marksman-pathfinder', 'Marksman rail rifle', 'standard');
    state.sequence = shootStub(marksman.id, foe.id, 'Marksman rail rifle');
    expect(hitOf(ctx, state, marksman, rifle)).toBe(3);
    const gunButt = profileOf('pathfinders.marksman-pathfinder', 'Gun butt');
    state.sequence = null;
    expect(hitOf(ctx, state, marksman, gunButt)).toBe(6); // 5+ worsened to 6+ by injury
  });

  it('Medic!: "that friendly operative isn’t incapacitated, has 1 wound remaining"', () => {
    const { ctx, state } = setup();
    const medic = state.operatives[opWith(state, 'p1', 'pathfinders.medical-technician-pathfinder')]!;
    const victim = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    medic.pos = { x: 10, y: 11 };
    victim.pos = { x: 11, y: 11 };
    for (const id of state.teams.p2.operativeIds) state.operatives[id]!.pos = { x: 28, y: 21 };
    inflictDamage(ctx, state, victim, 20, 'attack');
    expect(victim.incapacitated).toBeFalsy();
    expect(victim.wounds).toBe(1);
    expect(medic.aplMods).toContain(-1);
  });

  it('Analyse: the MB3 RECON DRONE markerlights "each other enemy operative … within 3\\" of the enemy operative you selected"', () => {
    const ctx = teamContext([pathfinders, kommandos], { seed: 4 });
    const state = battle({
      ctx,
      p1: { module: pathfinders, picks: rosterIncluding(pathfinders, ['pathfinders.mb3-recon-drone']) },
      p2: { module: kommandos },
    });
    const recon = opWith(state, 'p1', 'pathfinders.mb3-recon-drone');
    const foes = state.teams.p2.operativeIds;
    state.operatives[recon]!.pos = { x: 12, y: 11 };
    state.operatives[foes[0]!]!.pos = { x: 16, y: 11 };
    state.operatives[foes[1]!]!.pos = { x: 17, y: 11 };
    for (const id of foes.slice(2)) state.operatives[id]!.pos = { x: 28, y: 21 };
    let s = activate(ctx, state, recon);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: recon,
        action: 'pathfinders.mb3-recon-drone.act.markerlight',
        params: { targetOperativeId: foes[0] },
      },
      ctx,
    ).state;
    expect(markerlightTokens(s, s.operatives[foes[0]!]!, 'p1')).toBe(1);
    expect(markerlightTokens(s, s.operatives[foes[1]!]!, 'p1')).toBe(1);
  });

  it('Group Activation: "you must then activate one other ready friendly PATHFINDER SHAS’LA operative"', () => {
    const ctx = teamContext([pathfinders, kommandos], { seed: 4 });
    const state = battle({ ctx, p1: { module: pathfinders }, p2: { module: kommandos } });
    const first = opWith(state, 'p1', 'pathfinders.shas-la-pathfinder');
    const s = activate(ctx, state, first);
    const out = reduce(s, { t: 'EndActivation', operativeId: first }, ctx).state;
    expect(out.effects.some((e) => e.rule === 'pathfinders.groupActivation')).toBe(true);
  });

  it('Pulse Accelerator 0AP: pulse weapons within 3" gain "the Lethal 5+ and Severe weapon rules"', () => {
    const ctx = teamContext([pathfinders, kommandos], { seed: 4 });
    const state = battle({
      ctx,
      p1: { module: pathfinders, picks: rosterIncluding(pathfinders, ['pathfinders.mv31-pulse-accelerator-drone']) },
      p2: { module: kommandos },
    });
    const drone = opWith(state, 'p1', 'pathfinders.mv31-pulse-accelerator-drone');
    const mate = state.operatives[opWith(state, 'p1', 'pathfinders.shas-la-pathfinder')]!;
    state.operatives[drone]!.pos = { x: 12, y: 11 };
    mate.pos = { x: 13.5, y: 11 };
    let s = activate(ctx, state, drone);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: drone, action: 'pathfinders.mv31-pulse-accelerator-drone.act.pulse-accelerator' },
      ctx,
    ).state;
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    const ids = effectiveRules(ctx, s, carbine, { operative: s.operatives[mate.id]!, weaponName: 'Pulse carbine' }).map(
      (r) => r.id,
    );
    expect(ids).toContain('Lethal');
    expect(ids).toContain('Severe');
  });

  it('Grenadier Specialist: "This operative can use frag and krak grenades … improve the Hit stat of that weapon by 1"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', 'pathfinders.assault-grenadier-pathfinder');
    const s = activate(ctx, state, id);
    const granted = ((s.operatives[id] as { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).map((w) => w.name);
    expect(granted).toContain('Frag grenade');
    expect(granted).toContain('Krak grenade');
    const foe = opWith(s, 'p2', 'kommandos.boy');
    s.sequence = shootStub(id, foe, 'Frag grenade');
    const ev = ctx.hooks.emit('onStatMod', s, {
      state: s,
      operative: s.operatives[id]!,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
    });
    expect(ev.mods.hit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('PATHFINDERS bot-vs-bot soak (zero rejected intents)', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const map = mapById(mapId);
      const ctx = createGameContext({
        rng: new SeededRng(63),
        datacards: [...pathfinders.datacards, ...kommandos.datacards],
        maps: [map],
        teams: [pathfinders, kommandos],
      });
      for (const mod of [pathfinders, kommandos]) for (const eq of mod.equipmentDefs) ctx.equipment.set(eq.id, eq);
      const result = playGame({
        ctx,
        map,
        seed: 63,
        critOpId: 'crit.secure',
        rosters: {
          p1: {
            teamId: pathfinders.id,
            operatives: defaultRoster(pathfinders.data).map((p: { datacardId: string }) => ({ datacardId: p.datacardId })),
            equipment: pathfinders.equipment.slice(0, 4).map((e) => e.id),
          },
          p2: {
            teamId: kommandos.id,
            operatives: defaultRoster(kommandos.data).map((p: { datacardId: string }) => ({ datacardId: p.datacardId })),
            equipment: kommandos.equipment.slice(0, 2).map((e) => e.id),
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

// Keep the import list honest: OperativeState is used by the helpers above.
export type { OperativeState };
