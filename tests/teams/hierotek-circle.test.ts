/**
 * HIEROTEK CIRCLE. Every test quotes the printed rule it pins.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/hierotek-circle/
 */
import { describe, expect, it } from 'vitest';
import { createGameContext } from '../../src/core/game.ts';
import { reduce } from '../../src/core/reducer.ts';
import { SeededRng, ScriptedRng } from '../../src/core/rng.ts';
import { aplOf, inflictDamage, markerController } from '../../src/core/state.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import { martyrsOp, martyrTokens } from '../../src/core/ops/tac/martyrs.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { pathfinders } from '../../src/teams/pathfinders/index.ts';
import {
  REANIMATION_DECISION,
  hierotekCircle,
  magnifyProxy,
  reanimationMarkers,
} from '../../src/teams/hierotek-circle/index.ts';
import { teamData } from '../../src/teams/bundled.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import { activate, battle, mapById, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameState, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('hierotek-circle');
const rule = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;

const EVERY_ROLE = [
  'hierotek-circle.chronomancer',
  'hierotek-circle.plasmacyte-accelerator',
  'hierotek-circle.plasmacyte-reanimator',
  'hierotek-circle.apprentek',
  'hierotek-circle.deathmark',
  'hierotek-circle.immortal-despotek',
  'hierotek-circle.immortal-guardian',
];

function setup(equipment: string[] = [], opts: { script?: number[] } = {}): {
  ctx: ReturnType<typeof teamContext>;
  state: GameState;
} {
  const ctx = teamContext([hierotekCircle, pathfinders], opts.script ? { script: opts.script } : { seed: 17 });
  const state = battle({
    ctx,
    p1: { module: hierotekCircle, equipment, picks: rosterIncluding(hierotekCircle, EVERY_ROLE) },
    p2: { module: pathfinders },
  });
  return { ctx, state };
}

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const data = cardId.startsWith('hierotek') ? DATA : teamData('pathfinders');
  const w = data.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return (w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0])!;
};

// ---------------------------------------------------------------------------
describe('HIEROTEK CIRCLE data (pinned against data/teams/hierotek-circle.json)', () => {
  it('has 9 datacards with the printed stats, bases and keywords', () => {
    expect(DATA.datacards).toHaveLength(9);
    const chrono = DATA.datacards.find((c) => c.id === 'hierotek-circle.chronomancer')!;
    expect(chrono).toMatchObject({ apl: 3, move: 6, save: 3, wounds: 14, base: { shape: 'round', mm: 40 } });
    expect(chrono.keywords).toEqual(['HIEROTEK CIRCLE', 'NECRON', 'LEADER', 'CRYPTEK', 'CHRONOMANCER']);
    expect(DATA.datacards.find((c) => c.id === 'hierotek-circle.technomancer')!.base).toMatchObject({
      shape: 'round',
      mm: 50,
    });
    for (const id of ['hierotek-circle.plasmacyte-accelerator', 'hierotek-circle.plasmacyte-reanimator']) {
      expect(DATA.datacards.find((c) => c.id === id)!).toMatchObject({ apl: 2, move: 7, save: 5, wounds: 5 });
    }
    expect(DATA.datacards.find((c) => c.id === 'hierotek-circle.deathmark')!).toMatchObject({
      apl: 2,
      move: 5,
      save: 3,
      wounds: 10,
    });
  });

  it('pins every weapon profile of the CHRONOMANCER and the DEATHMARK', () => {
    const flat = (id: string): string[] =>
      DATA.datacards
        .find((c) => c.id === id)!
        .weapons.flatMap((w) =>
          w.profiles.map((p) =>
            [w.name, p.name ?? '', p.type, p.atk, p.hit, p.dmgN, p.dmgC, p.rules.map((r) => r.raw).join('+')].join('|'),
          ),
        );
    expect(flat('hierotek-circle.chronomancer')).toEqual([
      'Aeonstave|ranged|ranged|5|3|3|3|Blast 2"+Lethal 5++Stun+Magnify*',
      'Aeonstave|melee|melee|4|4|3|4|Lethal 5++Shock',
      'Entropic lance|ranged|ranged|4|3|5|3|Devastating 3+Piercing 1+Magnify*',
      'Entropic lance|melee|melee|4|4|3|6|',
    ]);
    expect(flat('hierotek-circle.deathmark')).toEqual([
      'Synaptic disintegrator||ranged|4|2|4|3|Devastating 2+Heavy (Dash only)+Piercing 1+Severe',
      'Fists||melee|3|3|3|4|',
    ]);
  });

  it('exposes 3 faction rules, 4 strategy ploys, 4 firefight ploys and 4 equipment options', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Reanimation Protocols', 'Magnify', 'Living Metal']);
    expect(hierotekCircle.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(hierotekCircle.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(hierotekCircle.equipment).toHaveLength(4);
    expect(DATA.rareWeaponRules).toEqual(['Magnify']);
  });
});

// ---------------------------------------------------------------------------
describe('Reanimation Protocols', () => {
  it('"place one of your Reanimation markers within its control range" the first time each operative is incapacitated', () => {
    const { ctx, state } = setup();
    const guardian = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    inflictDamage(ctx, state, guardian, 99, 'attack');
    const markers = reanimationMarkers(state, 'p1');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.flags['forOperative']).toBe(guardian.id);
    // "…also removing any tokens and rules effects it had."
    expect(state.effects.some((e) => e.operativeId === guardian.id)).toBe(false);
  });

  it('the Ready step offers a marker to roll for; "on a 3+, an operative is REANIMATED" with 1 wound', () => {
    // D6 for the reanimation roll, then Living Metal's D3.
    const { ctx, state } = setup([], { script: Array<number>(40).fill(5) });
    const guardian = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    guardian.pos = { x: 8, y: 6 };
    inflictDamage(ctx, state, guardian, 99, 'attack');
    guardian.removed = true;
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    const decision = state.pending.find((d) => d.kind === REANIMATION_DECISION);
    expect(decision, 'the Ready step raises a Reanimation decision').toBeDefined();
    const option = decision!.options.find((o) => o.id.endsWith('|engage'))!;
    const out = reduce(state, { t: 'ResolveDecision', decisionId: decision!.id, optionId: option.id }, ctx);
    const revived = out.state.operatives[guardian.id]!;
    expect(revived.removed).toBe(false);
    expect(revived.ready).toBe(true);
    expect(revived.order).toBe('engage');
    expect(revived.wounds).toBeGreaterThanOrEqual(1); // 1 wound, then Living Metal's D3+1
    expect(reanimationMarkers(out.state, 'p1')).toHaveLength(0);
  });

  it('"on a 1-2, leave that Reanimation marker in the killzone and repeat this process with a different one"', () => {
    const { ctx, state } = setup([], { script: Array<number>(40).fill(1) });
    const a = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    const b = state.operatives[opWith(state, 'p1', 'hierotek-circle.deathmark')]!;
    for (const op of [a, b]) {
      inflictDamage(ctx, state, op, 99, 'attack');
      op.removed = true;
    }
    expect(reanimationMarkers(state, 'p1')).toHaveLength(2);
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    const first = state.pending.find((d) => d.kind === REANIMATION_DECISION)!;
    const out = reduce(state, { t: 'ResolveDecision', decisionId: first.id, optionId: first.options[0]!.id }, ctx);
    // The roll failed, so a second marker is offered — and never the same one twice.
    const second = out.state.pending.find((d) => d.kind === REANIMATION_DECISION);
    expect(second).toBeDefined();
    expect(second!.options.every((o) => !o.id.startsWith(first.options[0]!.id.split('|')[0]!))).toBe(true);
    expect(reanimationMarkers(out.state, 'p1')).toHaveLength(2);
  });

  it('the Martyrs tac op cannot score twice for one operative that was REANIMATED', () => {
    const map = mapById('volkus-1');
    const ctx = createGameContext({
      rng: new ScriptedRng(Array<number>(60).fill(5)),
      datacards: [...hierotekCircle.datacards, ...pathfinders.datacards],
      maps: [map],
      teams: [hierotekCircle, pathfinders],
    });
    const state = battle({
      ctx,
      p1: { module: hierotekCircle, picks: rosterIncluding(hierotekCircle, EVERY_ROLE) },
      p2: { module: pathfinders },
    });
    const withOp = reduce(state, { t: 'SelectTacOp', player: 'p1', tacOpId: 'tac.martyrs' }, ctx);
    expect(withOp.ok, withOp.reason).toBe(true);
    Object.assign(state, withOp.state);
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    const victim = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    victim.pos = { ...marker.pos };

    inflictDamage(ctx, state, victim, 99, 'attack');
    martyrsOp.scoreEndOfTP!(ctx, state, 'p1');
    expect(martyrTokens(state, marker.id, 'p1')).toBe(1);

    // Reanimate it onto the same objective and kill it again.
    victim.removed = true;
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    const decision = state.pending.find((d) => d.kind === REANIMATION_DECISION)!;
    const s = reduce(state, { t: 'ResolveDecision', decisionId: decision.id, optionId: decision.options[0]!.id }, ctx).state;
    const back = s.operatives[victim.id]!;
    expect(back.removed).toBe(false);
    back.pos = { ...marker.pos };
    inflictDamage(ctx, s, back, 99, 'attack');
    martyrsOp.scoreEndOfTP!(ctx, s, 'p1');
    // "…this is only the first time each operative is incapacitated."
    expect(martyrTokens(s, marker.id, 'p1')).toBe(1);
  });

  it('Living Metal: "each friendly HIEROTEK CIRCLE operative regains up to D3+1 lost wounds"', () => {
    const { ctx, state } = setup([], { script: Array<number>(40).fill(3) });
    const op = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    op.wounds = 4;
    ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(op.wounds).toBe(7); // 4 + (D3=2) + 1
  });
});

// ---------------------------------------------------------------------------
describe('Magnify — "treat that operative as the active operative for … a valid target, cover and obscured"', () => {
  it('finds an APPRENTEK/CRYPTEK proxy with an Engage order and grants Ceaseless', () => {
    const { ctx, state } = setup();
    const chrono = state.operatives[opWith(state, 'p1', 'hierotek-circle.chronomancer')]!;
    const apprentek = state.operatives[opWith(state, 'p1', 'hierotek-circle.apprentek')]!;
    const foe = state.operatives[opWith(state, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    chrono.pos = { x: 10, y: 11 };
    apprentek.pos = { x: 14, y: 11 };
    foe.pos = { x: 20, y: 11 };
    apprentek.order = 'engage';
    const T = makeTeamHooks(hierotekCircle.data, 'p1', ctx);
    expect(magnifyProxy(T, state, chrono, foe)?.id).toBe(apprentek.id);

    const lance = profileOf('hierotek-circle.chronomancer', 'Entropic lance', 'ranged');
    const rules = effectiveRules(ctx, state, lance, { operative: chrono, target: foe, weaponName: 'Entropic lance' });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);

    // "…isn't within control range of enemy operatives"
    foe.pos = { x: 14.6, y: 11 };
    const blocked = effectiveRules(ctx, state, lance, { operative: chrono, target: foe, weaponName: 'Entropic lance' });
    expect(blocked.some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('a weapon without Magnify never gains it', () => {
    const { ctx, state } = setup();
    const deathmark = state.operatives[opWith(state, 'p1', 'hierotek-circle.deathmark')]!;
    const foe = state.operatives[opWith(state, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    const disintegrator = profileOf('hierotek-circle.deathmark', 'Synaptic disintegrator');
    const rules = effectiveRules(ctx, state, disintegrator, {
      operative: deathmark,
      target: foe,
      weaponName: 'Synaptic disintegrator',
    });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('HIEROTEK CIRCLE ploys', () => {
  it('RELENTLESS ONSLAUGHT: "Balanced weapon rule" only within 8"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'hierotek-circle.sp.relentless-onslaught' }, ctx).state;
    const shooter = s.operatives[opWith(s, 'p1', 'hierotek-circle.deathmark')]!;
    const foe = s.operatives[opWith(s, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    shooter.pos = { x: 10, y: 11 };
    foe.pos = { x: 16, y: 11 };
    const gun = profileOf('hierotek-circle.deathmark', 'Synaptic disintegrator');
    expect(
      effectiveRules(ctx, s, gun, { operative: shooter, target: foe, weaponName: 'Synaptic disintegrator' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(true);
    foe.pos = { x: 25, y: 11 };
    expect(
      effectiveRules(ctx, s, gun, { operative: shooter, target: foe, weaponName: 'Synaptic disintegrator' }).some(
        (r) => r.id === 'Balanced',
      ),
    ).toBe(false);
  });

  it('UNDYING ANDROIDS: "if you cannot retain any cover saves, you can retain one of your defence dice"', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'hierotek-circle.sp.undying-androids' }, ctx).state;
    const target = s.operatives[opWith(s, 'p1', 'hierotek-circle.immortal-guardian')]!;
    const shooter = s.operatives[opWith(s, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    s.sequence = {
      kind: 'shoot',
      step: 'rollDefence',
      attackerId: shooter.id,
      targetId: target.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Pulse carbine',
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
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: {
        attacker: shooter,
        defender: target,
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
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
      rerolls: [],
    });
    expect(ev.coverSave).toBe(true);
  });

  it('METHODICAL ELIMINATION: "Accurate 1"; "Accurate 2" when it has not moved or is retaliating', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'hierotek-circle.sp.methodical-elimination' }, ctx).state;
    const op = s.operatives[opWith(s, 'p1', 'hierotek-circle.immortal-guardian')]!;
    const bayonet = profileOf('hierotek-circle.immortal-guardian', 'Bayonet');
    const still = effectiveRules(ctx, s, bayonet, { operative: op, weaponName: 'Bayonet' });
    expect(still.find((r) => r.id === 'Accurate')?.x).toBe(2);
    op.actionsThisActivation = ['Charge'];
    const moved = effectiveRules(ctx, s, bayonet, { operative: op, weaponName: 'Bayonet' });
    expect(moved.find((r) => r.id === 'Accurate')?.x).toBe(1);
    const retaliating = effectiveRules(ctx, s, bayonet, { operative: op, weaponName: 'Bayonet', retaliating: true });
    expect(retaliating.find((r) => r.id === 'Accurate')?.x).toBe(2);
  });

  it('COMMAND UNDERLINGS: "can immediately perform a free Dash action" near a CRYPTEK', () => {
    const { ctx, state } = setup();
    const chrono = state.operatives[opWith(state, 'p1', 'hierotek-circle.chronomancer')]!;
    const guardian = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    chrono.pos = { x: 10, y: 11 };
    guardian.pos = { x: 14, y: 11 };
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: 'hierotek-circle.sp.command-underlings' }, ctx);
    expect(out.state.operatives[guardian.id]!.aplMods).toContain(1);
  });

  it('CORTICAL CONTROL: "ignore the distance requirement" of a SUPPORT unique action', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hierotek-circle.fp.cortical-control' }, ctx).state;
    const chrono = s.operatives[opWith(s, 'p1', 'hierotek-circle.chronomancer')]!;
    const ev = ctx.hooks.emit('onSupportDistance', s, { state: s, operative: chrono, inches: 6 });
    expect(ev.inches).toBeGreaterThan(100);
  });

  it('LIVING LIGHTNING: the tesla carbine loses its 2" Devastating band and gains "Blast 2\\""', () => {
    const { ctx, state } = setup();
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hierotek-circle.fp.living-lightning' }, ctx).state;
    const immortal = s.operatives[opWith(s, 'p1', 'hierotek-circle.immortal-guardian')]!;
    const tesla = profileOf('hierotek-circle.immortal-guardian', 'Tesla carbine');
    const rules = effectiveRules(ctx, s, tesla, { operative: immortal, weaponName: 'Tesla carbine' });
    expect(rules.some((r) => r.id === 'Blast' && r.x === 2)).toBe(true);
    expect(rules.find((r) => r.id === 'Devastating')?.dist).toBeUndefined();
  });

  it('DIMENSIONAL AMBUSH lets a DEATHMARK "perform the Guard action regardless of the killzone"', () => {
    const { ctx, state } = setup();
    const deathmark = state.operatives[opWith(state, 'p1', 'hierotek-circle.deathmark')]!;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hierotek-circle.fp.dimensional-ambush' }, ctx).state;
    const ev = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[deathmark.id]!,
      action: 'Guard',
      allowed: false,
      reason: 'Guard is a Close Quarters action',
    });
    expect(ev.allowed).toBe(true);
  });

  it('REANIMATED FUNCTION: "treat that Reanimation marker as a friendly … operative that has an APL stat of 1"', () => {
    const { ctx, state } = setup();
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    const victim = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    victim.pos = { ...marker.pos };
    inflictDamage(ctx, state, victim, 99, 'attack');
    victim.removed = true;
    const s = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'hierotek-circle.fp.reanimated-function' }, ctx).state;
    const ev = ctx.hooks.emit('onMarkerControl', s, {
      state: s,
      markerId: marker.id,
      aplByPlayer: { p1: 0, p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('HIEROTEK CIRCLE faction equipment', () => {
  it('PHASE SHIFTER: "worsen the x of the Piercing weapon rule by 1", once per turning point', () => {
    const { ctx, state } = setup(['hierotek-circle.eq.phase-shifter']);
    const chrono = state.operatives[opWith(state, 'p1', 'hierotek-circle.chronomancer')]!;
    const foe = state.operatives[opWith(state, 'p2', 'pathfinders.marksman-pathfinder')]!;
    const rifle = profileOf('pathfinders.marksman-pathfinder', 'Marksman rail rifle', 'standard');
    const emit = () =>
      ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: {
          attacker: foe,
          defender: chrono,
          weaponName: 'Marksman rail rifle',
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
        count: 2,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
        rerolls: [],
      });
    expect(emit().count).toBe(3);
    expect(emit().count).toBe(2); // once per turning point
  });

  it('TESSERACT CUBE: "on a 4+, you gain 1CP"', () => {
    const { ctx, state } = setup(['hierotek-circle.eq.tesseract-cube'], { script: Array<number>(40).fill(5) });
    const ev = ctx.hooks.emit('onReadyStep', state, { state, player: 'p1', cp: 1 });
    expect(ev.cp).toBe(2);
  });

  it('TESLA WEAVE: "inflict D3+1 damage" when an enemy ends a Charge in control range', () => {
    const { ctx, state } = setup(['hierotek-circle.eq.tesla-weave'], { script: Array<number>(40).fill(3) });
    const guardian = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    const charger = state.operatives[opWith(state, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    guardian.pos = { x: 15, y: 11 };
    charger.pos = { x: 15.7, y: 11 };
    charger.actionsThisActivation = ['Charge'];
    const before = charger.wounds;
    ctx.hooks.emit('onActivationEnd', state, { state, operative: charger });
    expect(before - charger.wounds).toBe(3); // D3=2, +1
  });

  it('MAGNIFICATION CONDUITS widens the Magnify proxy to another HIEROTEK CIRCLE operative', () => {
    const { ctx, state } = setup(['hierotek-circle.eq.magnification-conduits']);
    const chrono = state.operatives[opWith(state, 'p1', 'hierotek-circle.chronomancer')]!;
    const guardian = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    const foe = state.operatives[opWith(state, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    // No APPRENTEK or CRYPTEK is available as a proxy — the conduits let any other operative do it.
    for (const id of state.teams.p1.operativeIds) {
      const o = state.operatives[id]!;
      if (o.id !== chrono.id && o.id !== guardian.id) o.removed = true;
    }
    chrono.pos = { x: 10, y: 11 };
    guardian.pos = { x: 14, y: 11 };
    guardian.order = 'engage';
    foe.pos = { x: 20, y: 11 };
    const T = makeTeamHooks(hierotekCircle.data, 'p1', ctx);
    expect(magnifyProxy(T, state, chrono, foe)?.id).toBe(guardian.id);
    expect(rule('hierotek-circle.eq.magnification-conduits')).toContain('Once per turning point');
  });
});

// ---------------------------------------------------------------------------
describe('HIEROTEK CIRCLE unique actions and abilities', () => {
  it('INTERSTITIAL COMMAND 1AP: "That selected operative can immediately perform a 1AP action for free"', () => {
    const { ctx, state } = setup();
    const chrono = opWith(state, 'p1', 'hierotek-circle.chronomancer');
    const guardian = opWith(state, 'p1', 'hierotek-circle.immortal-guardian');
    state.operatives[chrono]!.pos = { x: 10, y: 11 };
    state.operatives[guardian]!.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, chrono);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: chrono,
        action: 'hierotek-circle.chronomancer.act.interstitial-command',
        params: { targetOperativeId: guardian },
      },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[guardian]!)).toBe(3);
  });

  it('Apprentek Assistance: the APPRENTEK performs a CRYPTEK action "once per turning point"', () => {
    const { ctx, state } = setup();
    const apprentek = opWith(state, 'p1', 'hierotek-circle.apprentek');
    const guardian = opWith(state, 'p1', 'hierotek-circle.immortal-guardian');
    state.operatives[apprentek]!.pos = { x: 10, y: 11 };
    state.operatives[guardian]!.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, apprentek);
    const first = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: apprentek,
        action: 'hierotek-circle.chronomancer.act.interstitial-command',
        params: { targetOperativeId: guardian },
      },
      ctx,
    );
    expect(first.ok, first.reason).toBe(true);
    s = first.state;
    const again = ctx.hooks.emit('canPerformAction', s, {
      state: s,
      operative: s.operatives[apprentek]!,
      action: 'hierotek-circle.chronomancer.act.chronometron',
      allowed: true,
    });
    expect(again.allowed).toBe(false);
  });

  it('CHRONOMETRON 1AP: "subtract 1 from the Atk stat of an operative’s weapons whenever it’s shooting that operative"', () => {
    const { ctx, state } = setup();
    const chrono = opWith(state, 'p1', 'hierotek-circle.chronomancer');
    const guardian = opWith(state, 'p1', 'hierotek-circle.immortal-guardian');
    state.operatives[chrono]!.pos = { x: 10, y: 11 };
    state.operatives[guardian]!.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, chrono);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: chrono,
        action: 'hierotek-circle.chronomancer.act.chronometron',
        params: { targetOperativeId: guardian },
      },
      ctx,
    ).state;
    const foe = s.operatives[opWith(s, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    const carbine = profileOf('pathfinders.shas-la-pathfinder', 'Pulse carbine');
    const ev = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: {
        attacker: foe,
        defender: s.operatives[guardian]!,
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
    expect(ev.count).toBe(3);
  });

  it('ACCELERATE 1AP: "add 1 to its APL stat" for a DEATHMARK or IMMORTAL', () => {
    const { ctx, state } = setup();
    const plasmacyte = opWith(state, 'p1', 'hierotek-circle.plasmacyte-accelerator');
    const deathmark = opWith(state, 'p1', 'hierotek-circle.deathmark');
    state.operatives[plasmacyte]!.pos = { x: 10, y: 11 };
    state.operatives[deathmark]!.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, plasmacyte);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: plasmacyte,
        action: 'hierotek-circle.plasmacyte-accelerator.act.accelerate',
        params: { targetOperativeId: deathmark },
      },
      ctx,
    ).state;
    expect(aplOf(ctx, s, s.operatives[deathmark]!)).toBe(3);
  });

  it('REANIMATE 2AP: "on a 3+, a friendly operative is REANIMATED", set up expended', () => {
    const { ctx, state } = setup([], { script: [6, 1, 1, 1, 1] });
    const reanimator = opWith(state, 'p1', 'hierotek-circle.plasmacyte-reanimator');
    const victim = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    victim.pos = { x: 12, y: 11 };
    state.operatives[reanimator]!.pos = { x: 13, y: 11 };
    inflictDamage(ctx, state, victim, 99, 'attack');
    victim.removed = true;
    let s = activate(ctx, state, reanimator);
    s = reduce(
      s,
      { t: 'PerformAction', operativeId: reanimator, action: 'hierotek-circle.plasmacyte-reanimator.act.reanimate' },
      ctx,
    ).state;
    expect(s.operatives[victim.id]!.removed).toBe(false);
    expect(s.operatives[victim.id]!.expended).toBe(true);
  });

  it('Steadfast: "you can treat this operative’s APL stat as 3" when determining control', () => {
    const { ctx, state } = setup();
    const marker = Object.values(state.markers).find((m) => m.kind === 'objective')!;
    const immortal = state.operatives[opWith(state, 'p1', 'hierotek-circle.immortal-guardian')]!;
    immortal.pos = { ...marker.pos };
    immortal.aplMods.push(-1);
    for (const id of [...state.teams.p1.operativeIds, ...state.teams.p2.operativeIds])
      if (id !== immortal.id) state.operatives[id]!.pos = { x: 2, y: 2 };
    const ev = ctx.hooks.emit('onMarkerControl', state, {
      state,
      markerId: marker.id,
      aplByPlayer: { p1: aplOf(ctx, state, immortal), p2: 0 },
    });
    expect(ev.aplByPlayer.p1).toBe(3);
    expect(markerController(ctx, state, marker)).toBe('p1');
  });

  it('Deathmarked: the target "gains one of your DEATHMARKed tokens" and DEATHMARKs then have Seek', () => {
    const { ctx, state } = setup();
    const deathmark = state.operatives[opWith(state, 'p1', 'hierotek-circle.deathmark')]!;
    const foe = state.operatives[opWith(state, 'p2', 'pathfinders.shas-la-pathfinder')]!;
    const gun = profileOf('hierotek-circle.deathmark', 'Synaptic disintegrator');
    state.sequence = {
      kind: 'shoot',
      step: 'resolve',
      attackerId: deathmark.id,
      targetId: foe.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Synaptic disintegrator',
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
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: {
        attacker: deathmark,
        defender: foe,
        weaponName: 'Synaptic disintegrator',
        profile: gun,
        rules: gun.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 10,
      },
      crit: false,
      struck: foe,
    });
    expect(state.effects.some((e) => e.rule === 'hierotek.deathmarked' && e.operativeId === foe.id)).toBe(true);
    const rules = effectiveRules(ctx, state, gun, {
      operative: deathmark,
      target: foe,
      weaponName: 'Synaptic disintegrator',
    });
    expect(rules.some((r) => r.id === 'Seek')).toBe(true);
  });

  it('Scuttler: a PLASMACYTE "can perform the Fall Back action for 1 less AP" and is action-restricted', () => {
    const { ctx, state } = setup();
    const plasmacyte = state.operatives[opWith(state, 'p1', 'hierotek-circle.plasmacyte-accelerator')]!;
    const cost = ctx.hooks.emit('onActionCost', state, { state, operative: plasmacyte, action: 'Fall Back', ap: 2 });
    expect(cost.ap).toBe(1);
    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: plasmacyte,
      action: 'hierotek-circle.chronomancer.act.chronometron',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
  });

  it('REINFORCE METAL 1AP: "whenever an attack dice inflicts damage of 3 or more … subtract 1"', () => {
    const { ctx, state } = setup();
    const techno = state.operatives[state.teams.p1.operativeIds[0]!]!;
    techno.datacardId = 'hierotek-circle.technomancer';
    const guardian = opWith(state, 'p1', 'hierotek-circle.immortal-guardian');
    techno.pos = { x: 10, y: 11 };
    state.operatives[guardian]!.pos = { x: 13, y: 11 };
    let s = activate(ctx, state, techno.id);
    s = reduce(
      s,
      {
        t: 'PerformAction',
        operativeId: techno.id,
        action: 'hierotek-circle.technomancer.act.reinforce-metal',
        params: { targetOperativeId: guardian },
      },
      ctx,
    ).state;
    const target = s.operatives[guardian]!;
    const before = target.wounds;
    inflictDamage(ctx, s, target, 4, 'attack');
    expect(before - target.wounds).toBe(3);
  });
});


// ---------------------------------------------------------------------------
describe('HIEROTEK CIRCLE bot-vs-bot soak (zero rejected intents)', () => {
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full game on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const map = mapById(mapId);
      const ctx = createGameContext({
        rng: new SeededRng(74),
        datacards: [...hierotekCircle.datacards, ...pathfinders.datacards],
        maps: [map],
        teams: [hierotekCircle, pathfinders],
      });
      for (const mod of [hierotekCircle, pathfinders]) for (const eq of mod.equipmentDefs) ctx.equipment.set(eq.id, eq);
      const result = playGame({
        ctx,
        map,
        seed: 74,
        critOpId: 'crit.secure',
        rosters: {
          p1: {
            teamId: hierotekCircle.id,
            operatives: defaultRoster(hierotekCircle.data).map((p: { datacardId: string }) => ({ datacardId: p.datacardId })),
            equipment: hierotekCircle.equipment.slice(0, 4).map((e) => e.id),
          },
          p2: {
            teamId: pathfinders.id,
            operatives: defaultRoster(pathfinders.data).map((p: { datacardId: string }) => ({ datacardId: p.datacardId })),
            equipment: pathfinders.equipment.slice(0, 2).map((e) => e.id),
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
