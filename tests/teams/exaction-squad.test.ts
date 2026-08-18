/**
 * EXACTION SQUAD. Every test quotes the printed rule it pins, read out of
 * `data/teams/exaction-squad.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/exaction-squad/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../src/core/sequences/shoot.ts';
import { aliveOperatives, hitOf, inflictDamage, markerController, moveOf, saveOf } from '../../src/core/state.ts';
import { teamData } from '../../src/teams/data.ts';
import rawJson from '../../data/teams/exaction-squad.json';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import {
  APPREHEND_TOKEN,
  ATTACK_PATTERN_TEXT,
  CASTIGATOR,
  CHIRURGANT,
  GUNNER,
  LEASHMASTER,
  MALOCATOR,
  MARKSMAN,
  MARK_TOKEN,
  MASTIFF,
  NUNCIO_MARKER,
  PROCTOR,
  REVELATUM,
  SPOT_TOKEN,
  SUBDUCTOR,
  VERISCANT_TOKEN,
  VIGILANT,
  VIGILANT_SHOOT,
  VOX_SIGNIFIER,
  exactionSquad,
  markOf,
  patternsOf,
} from '../../src/teams/exaction-squad/index.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import { testMap } from '../fixtures.ts';
import { act, activate, battle, opWith, rosterIncluding, teamContext } from './harness.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence } from '../../src/core/sequences/types.ts';
import type { GameState, OperativeState, TerrainFeature, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('exaction-squad');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

/** Eleven of the twelve datacards fit in a kill team; GUNNER is swapped in where needed. */
const ROLES = [
  PROCTOR,
  CASTIGATOR,
  CHIRURGANT,
  LEASHMASTER,
  MASTIFF,
  MALOCATOR,
  MARKSMAN,
  REVELATUM,
  SUBDUCTOR,
  VIGILANT,
  VOX_SIGNIFIER,
];

const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;

interface SetupOpts {
  equipment?: string[];
  roles?: string[];
  script?: number[];
  seed?: number;
  positions?: Vec2[];
  foeIsKasrkin?: boolean;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const modules = opts.foeIsKasrkin ? [exactionSquad, kasrkin] : [exactionSquad];
  const ctx = teamContext(modules, opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = rosterIncluding(exactionSquad, opts.roles ?? ROLES);
  const state = battle({
    ctx,
    p1: {
      module: exactionSquad,
      picks,
      ...(opts.equipment ? { equipment: opts.equipment } : {}),
      ...(opts.positions ? { positions: opts.positions } : {}),
    },
    p2: opts.foeIsKasrkin ? { module: kasrkin } : { module: exactionSquad, picks },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Isolate two operatives so no third operative interferes with a control-range rule. */
function isolate(state: GameState, keep: string[]): void {
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 2 + (Number(op.id.replace(/\D/g, '')) % 5), y: 22 };
  }
}

// ---------------------------------------------------------------------------
describe('EXACTION SQUAD data (pinned against data/teams/exaction-squad.json)', () => {
  it('has 12 datacards, all APL 2 / M 6" / W 8 (bar the 9-wound PROCTOR) on 28mm bases', () => {
    expect(DATA.datacards).toHaveLength(12);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 2, move: 6 });
      expect(card.keywords).toContain('EXACTION SQUAD');
      expect(card.keywords).toContain('ADEPTUS ARBITES');
    }
    expect(DATA.datacards.find((c) => c.id === PROCTOR)).toMatchObject({ wounds: 9, save: 4, base: { shape: 'round', mm: 28 } });
    expect(DATA.datacards.find((c) => c.id === SUBDUCTOR)).toMatchObject({ wounds: 8, save: 3 });
    // The R-VR CYBER-MASTIFF is the only 25mm base in the team.
    expect(DATA.datacards.filter((c) => c.base.mm === 25).map((c) => c.id)).toEqual([MASTIFF]);
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(PROCTOR, 'Combat shotgun', 'close range')).toMatchObject({ atk: 4, hit: 2, dmgN: 4, dmgC: 4 });
    expect(profileOf(PROCTOR, 'Combat shotgun', 'long range')).toMatchObject({ atk: 4, hit: 4, dmgN: 2, dmgC: 2 });
    expect(profileOf(MASTIFF, 'Mechanical bite')).toMatchObject({ atk: 4, hit: 4, dmgN: 3, dmgC: 5 });
    const exec = DATA.datacards.find((c) => c.id === MARKSMAN)!.weapons.find((w) => w.name === 'Executioner shotgun')!;
    expect(exec.profiles.map((p) => p.name)).toEqual(['concealed', 'mobile', 'stationary']);
    expect(exec.profiles[0]!.rules.map((r) => r.id)).toContain('ConcealedPosition');
  });

  it('the two Repress weapons are the PROCTOR’s dominator maul and the SUBDUCTOR’s shock maul', () => {
    const repress = DATA.datacards
      .flatMap((c) => c.weapons.map((w) => ({ card: c.id, w })))
      .filter(({ w }) => w.profiles.some((p) => p.rules.some((r) => r.id === 'Repress')))
      .map(({ card, w }) => `${card}:${w.name}`);
    expect(repress).toEqual([
      `${PROCTOR}:Dominator maul & assault shield`,
      `${SUBDUCTOR}:Shock maul & assault shield`,
    ]);
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['ConcealedPosition', 'Repress']);
  });

  it('exposes 3 faction rules, 4+4 ploys, 4 equipment options and 8 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Ruthless Efficiency', 'Marked for Justice', 'Repress']);
    expect(exactionSquad.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(exactionSquad.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(exactionSquad.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(8);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(14);
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('Balanced weapon rule.')).toBe(true);
  });

  it('every printed AP cost is taken from the JSON — three unique actions are recorded as 0AP', () => {
    const byName = Object.fromEntries(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => [a.name, a.ap]));
    expect(byName).toEqual({
      'DEPLOY NUNCIO-AQUILA': 0,
      MEDIKIT: 1,
      'R-VR COMMAND': 0,
      APPREHEND: 0,
      VERISCANT: 1,
      OPTICS: 1,
      SPOT: 1,
      SIGNAL: 1,
    });
    // The scraper flagged only one of the three as unpriced on the page.
    expect(NOTES).toEqual(["R-VR Cyber-mastiff: unique action 'APPREHEND' has no AP cost on the page"]);
    expect(getAction('exaction-squad.r-vr-cyber-mastiff.act.apprehend')!.ap).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('EXACTION SQUAD selection', () => {
  it('defaultRoster is a legal 11-operative kill team (1 PROCTOR-EXACTANT + 10 from the list)', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(11);
    expect(picks[0]!.datacardId).toBe(PROCTOR);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(picks.filter((p) => p.datacardId === SUBDUCTOR)).toHaveLength(3);
  });

  it('prints uniqueExcept, two maxCounts and a distinctOptions constraint', () => {
    expect(DATA.selection.constraints).toEqual([
      { kind: 'uniqueExcept', roles: ['GUNNER', 'SUBDUCTOR', 'VIGILANT'] },
      { kind: 'maxCount', role: 'GUNNER', max: 2 },
      { kind: 'distinctOptions', role: 'GUNNER' },
      { kind: 'maxCount', role: 'SUBDUCTOR', max: 4 },
    ]);
  });

  it('the shared validator enforces the GUNNER cap and the distinctOptions constraint', () => {
    const base = defaultRoster(DATA).slice(0, 8);
    const gunner = { datacardId: GUNNER };
    const three = validateRosterFor(DATA, [
      ...base,
      { ...gunner, loadoutIds: ['exaction-squad.g2e11.opt1'] },
      { ...gunner, loadoutIds: ['exaction-squad.g2e11.opt2'] },
      { ...gunner, loadoutIds: ['exaction-squad.g2e11.opt3'] },
    ]);
    expect(three.codes).toContain('maxCount');
    const sameOption = validateRosterFor(DATA, [
      ...base,
      { ...gunner, loadoutIds: ['exaction-squad.g2e11.opt1'] },
      { ...gunner, loadoutIds: ['exaction-squad.g2e11.opt1'] },
      { datacardId: SUBDUCTOR },
    ]);
    expect(sameOption.codes).toContain('distinctOptions');
  });
});

// ---------------------------------------------------------------------------
describe('Ruthless Efficiency — "having other friendly EXACTION SQUAD operatives within an enemy operative’s control range doesn’t prevent that enemy operative from being selected"', () => {
  function screened(): { ctx: GameContext; state: GameState; shooter: string; foe: string; screen: string } {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', PROCTOR);
    const screen = opWith(state, 'p1', VOX_SIGNIFIER);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [shooter, screen, foe]);
    place(state, shooter, 6, 10);
    place(state, foe, 10, 10);
    place(state, screen, 10.9, 10); // within the target's control range
    return { ctx, state, shooter, foe, screen };
  }

  it('a friendly EXACTION SQUAD screen does not block the shot', () => {
    const { ctx, state, shooter, foe } = screened();
    const profile = profileOf(PROCTOR, 'Combat shotgun', 'close range');
    const a = state.operatives[shooter]!;
    const t = state.operatives[foe]!;
    const rules = effectiveRules(ctx, state, profile, { operative: a, target: t, weaponName: 'Combat shotgun' });
    expect(checkTarget(ctx, state, a, t, profile, rules).valid).toBe(true);
  });

  it('and a KASRKIN kill team, which prints no such rule, is still blocked by its own screen', () => {
    const ctx = teamContext([exactionSquad, kasrkin], { seed: 7 });
    const state = battle({ ctx, p1: { module: kasrkin }, p2: { module: exactionSquad } });
    const shooter = state.teams.p1.operativeIds[0]!;
    const screen = state.teams.p1.operativeIds[1]!;
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [shooter, screen, foe]);
    place(state, shooter, 6, 10);
    place(state, foe, 10, 10);
    place(state, screen, 10.9, 10);
    const a = state.operatives[shooter]!;
    const t = state.operatives[foe]!;
    const weapon = ctx.datacards.get(a.datacardId)!.weapons.find((w) => w.profiles.some((p) => p.type === 'ranged'))!;
    const profile = weapon.profiles.find((p) => p.type === 'ranged')!;
    const rules = effectiveRules(ctx, state, profile, { operative: a, target: t, weaponName: weapon.name });
    expect(checkTarget(ctx, state, a, t, profile, rules).reason).toBe('a friendly operative is within the target’s control range');
  });

  it('"(excluding with frag or krak grenades)" — a grenade shot is still blocked', () => {
    const { ctx, state, shooter, foe } = screened();
    // startShoot records the weapon at Select Weapon; the grenade carve-out reads it back.
    (state.opState['exaction-squad.shooting'] as Record<string, unknown>) = { [shooter]: 'Frag grenade' };
    const profile = profileOf(PROCTOR, 'Combat shotgun', 'close range');
    const a = state.operatives[shooter]!;
    const t = state.operatives[foe]!;
    const rules = effectiveRules(ctx, state, profile, { operative: a, target: t, weaponName: 'Frag grenade' });
    expect(checkTarget(ctx, state, a, t, profile, rules).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Marked for Justice — "Select one enemy operative to be your mark for the turning point"', () => {
  it('is offered as a STRATEGIC GAMBIT and marks an enemy operative', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain('exaction-squad.rule.marked-for-justice');
    const foe = opWith(state, 'p2', CASTIGATOR);
    const out = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'exaction-squad.rule.marked-for-justice', data: { operativeId: foe } },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(markOf(out.state, 'p1')!.id).toBe(foe);
    // A faction rule is not a ploy, so it costs no CP.
    expect(out.state.teams.p1.cp).toBe(state.teams.p1.cp);
  });

  it('"that friendly operative’s weapons have the Punishing weapon rule" — shooting, fighting and retaliating', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    const before = effectiveRules(ctx, state, profileOf(PROCTOR, 'Combat shotgun', 'close range'), {
      operative: shooter,
      target: foe,
      weaponName: 'Combat shotgun',
    });
    expect(before.some((r) => r.id === 'Punishing')).toBe(false);
    state.effects.push({
      id: 'mark-test',
      rule: MARK_TOKEN,
      source: { kind: 'ability', id: 'exaction-squad.rule.marked-for-justice' },
      operativeId: foe.id,
      player: 'p1',
      expiry: { kind: 'endOfTurningPoint' },
    });
    for (const [weapon, profile, retaliating] of [
      ['Combat shotgun', profileOf(PROCTOR, 'Combat shotgun', 'close range'), false],
      ['Repression baton', profileOf(PROCTOR, 'Repression baton'), false],
      ['Repression baton', profileOf(PROCTOR, 'Repression baton'), true],
    ] as [string, WeaponProfile, boolean][]) {
      const rules = effectiveRules(ctx, state, profile, {
        operative: shooter,
        target: foe,
        weaponName: weapon,
        retaliating,
      });
      expect(rules.some((r) => r.id === 'Punishing')).toBe(true);
    }
  });

  it('"Whenever your mark is incapacitated, you can select a new enemy operative to be your mark"', () => {
    const { ctx, state } = setup();
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [foe.id]); // no CHIRURGANT in range: the mark really is incapacitated
    state.effects.push({
      id: 'mark-test2',
      rule: MARK_TOKEN,
      source: { kind: 'ability', id: 'exaction-squad.rule.marked-for-justice' },
      operativeId: foe.id,
      player: 'p1',
      expiry: { kind: 'endOfTurningPoint' },
    });
    inflictDamage(ctx, state, foe, 99, 'attack');
    const mark = markOf(state, 'p1');
    expect(mark).toBeDefined();
    expect(mark!.id).not.toBe(foe.id);
  });
});

// ---------------------------------------------------------------------------
describe('Repress — "each of your blocks can be allocated to block two unresolved successes … if this operative is retaliating, you resolve the first attack dice"', () => {
  it('a block from a Repress weapon discards two successes instead of one', () => {
    const { ctx, state } = setup();
    const subductor = state.operatives[opWith(state, 'p1', SUBDUCTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    const maul = profileOf(SUBDUCTOR, 'Shock maul & assault shield');
    const ev = ctx.hooks.emit('onBlockAllocation', state, {
      state,
      ctx: {
        attacker: subductor,
        defender: foe,
        weaponName: 'Shock maul & assault shield',
        profile: maul,
        rules: maul.rules,
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
    expect(ruleText('exaction-squad.rule.repress')).toContain('block two unresolved successes');
  });

  it('a retaliating Repress operative resolves the first attack dice', () => {
    const { ctx, state } = setup({ seed: 3 });
    const attacker = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    const defender = state.operatives[opWith(state, 'p1', SUBDUCTOR)]!;
    isolate(state, [attacker.id, defender.id]);
    place(state, attacker.id, 10, 10);
    place(state, defender.id, 10.6, 10);
    expect(startFight(ctx, state, attacker, 'Excruciator maul', undefined, defender.id).ok).toBe(true);
    advanceFight(ctx, state);
    expect((state.sequence as FightSequence).turn).toBe('defender');
  });

  it('and an ordinary melee weapon leaves the attacker resolving first', () => {
    const { ctx, state } = setup({ seed: 3 });
    const attacker = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    const defender = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    isolate(state, [attacker.id, defender.id]);
    place(state, attacker.id, 10, 10);
    place(state, defender.id, 10.6, 10);
    expect(startFight(ctx, state, attacker, 'Excruciator maul', undefined, defender.id).ok).toBe(true);
    advanceFight(ctx, state);
    expect((state.sequence as FightSequence).turn).toBe('attacker');
  });
});

// ---------------------------------------------------------------------------
describe('PROCTOR-EXACTANT abilities', () => {
  it('Assault Shield: "If this operative has a dominator maul & assault shield, it has a 3+ Save stat"', () => {
    const shieldPicks = defaultRoster(DATA).map((p, i) =>
      i === 0 ? { ...p, loadoutIds: ['exaction-squad.g1.opt2'] } : p,
    );
    const ctx = teamContext([exactionSquad], { seed: 7 });
    const state = battle({ ctx, p1: { module: exactionSquad, picks: shieldPicks }, p2: { module: exactionSquad } });
    const shielded = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const plain = state.operatives[opWith(state, 'p2', PROCTOR)]!;
    expect(saveOf(ctx, state, shielded)).toBe(3);
    expect(saveOf(ctx, state, plain)).toBe(4); // combat shotgun; repression baton
  });

  it('Nuncio-aquila: "your opponent must spend 1 additional AP … to perform the Pick Up Marker and mission actions"', () => {
    const { ctx, state } = setup();
    const proctor = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [proctor.id, foe.id]);
    place(state, proctor.id, 10, 10);
    place(state, foe.id, 20, 10);
    const pickUp = getAction('Pick Up Marker')!;
    expect(actionCost(ctx, state, foe, pickUp)).toBe(1);
    place(state, foe.id, 12.5, 10); // within 3" of the PROCTOR (no marker in the killzone yet)
    expect(actionCost(ctx, state, foe, pickUp)).toBe(2);
    expect(abilityText(PROCTOR, 'exaction-squad.arbites-proctor-exactant.nuncio-aquila')).toContain(
      'must spend 1 additional AP',
    );
  });

  it('Nuncio-aquila: "treat the total APL stat of enemy operatives that contest it as 1 lower"', () => {
    const { ctx, state } = setup();
    const proctor = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const mine = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [proctor.id, mine.id, foe.id]);
    state.markers['obj-test'] = {
      id: 'obj-test',
      kind: 'objective',
      diameterMm: 40,
      pos: { x: 15, y: 10 },
      z: 0,
      flags: {},
    };
    place(state, foe.id, 15.9, 10);
    place(state, mine.id, 14.1, 10);
    place(state, proctor.id, 30, 20); // far away: APL 2 vs APL 2, nobody controls it
    expect(markerController(ctx, state, state.markers['obj-test']!)).toBeNull();
    place(state, proctor.id, 17.5, 10); // now within 3" of the contesting enemy
    expect(markerController(ctx, state, state.markers['obj-test']!)).toBe('p1');
  });

  it('DEPLOY NUNCIO-AQUILA places the marker within 6" horizontally and refuses a longer move', () => {
    const { ctx, state } = setup();
    const proctor = opWith(state, 'p1', PROCTOR);
    isolate(state, [proctor]);
    place(state, proctor, 10, 10);
    state.activeOperativeId = proctor;
    state.activePlayer = 'p1';
    const far = act(ctx, state, proctor, 'exaction-squad.arbites-proctor-exactant.act.deploy-nuncio-aquila', {
      markerPos: { x: 20, y: 10 },
    });
    expect(far.ok).toBe(false);
    const near = act(ctx, state, proctor, 'exaction-squad.arbites-proctor-exactant.act.deploy-nuncio-aquila', {
      markerPos: { x: 14, y: 10 },
    });
    expect(near.ok).toBe(true);
    expect(near.state.markers[NUNCIO_MARKER('p1')]!.pos).toEqual({ x: 14, y: 10 });
  });

  it('"If this operative is removed from the killzone, remove your Nuncio-aquila marker"', () => {
    const { ctx, state } = setup();
    const proctor = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    state.markers[NUNCIO_MARKER('p1')] = {
      id: NUNCIO_MARKER('p1'),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 5, y: 5 },
      z: 0,
      owner: 'p1',
      flags: {},
    };
    inflictDamage(ctx, state, proctor, 99, 'attack');
    expect(state.markers[NUNCIO_MARKER('p1')]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('CASTIGATOR abilities', () => {
  it('Engendered Focus: "You can ignore any changes to this operative’s stats … excluding its Save stat"', () => {
    const { ctx, state } = setup();
    const castigator = state.operatives[opWith(state, 'p1', CASTIGATOR)]!;
    const plain = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    // Injured worsens Hit by 1 and Move by 2 for an ordinary operative.
    castigator.wounds = 2;
    plain.wounds = 2;
    const maul = profileOf(CASTIGATOR, 'Excruciator maul');
    const baton = profileOf(VOX_SIGNIFIER, 'Repression baton');
    expect(hitOf(ctx, state, castigator, maul)).toBe(maul.hit);
    expect(hitOf(ctx, state, plain, baton)).toBe(baton.hit + 1);
    expect(moveOf(ctx, state, castigator)).toBe(6);
    expect(moveOf(ctx, state, plain)).toBe(4);
    // APL reductions are ignored too.
    castigator.aplMods.push(-1);
    plain.aplMods.push(-1);
    expect(availableActions(ctx, state, castigator).length).toBeGreaterThan(0);
    expect(saveOf(ctx, state, castigator)).toBe(4); // "excluding its Save stat"
  });

  it('Zealous Dedication: "on a 5+, subtract 1 from that inflicted damage" for damage of 3 or more', () => {
    const good = setup({ script: [5] });
    const castigator = good.state.operatives[opWith(good.state, 'p1', CASTIGATOR)]!;
    const before = castigator.wounds;
    inflictDamage(good.ctx, good.state, castigator, 4, 'attack');
    expect(before - castigator.wounds).toBe(3);

    const bad = setup({ script: [4] });
    const c2 = bad.state.operatives[opWith(bad.state, 'p1', CASTIGATOR)]!;
    const b2 = c2.wounds;
    inflictDamage(bad.ctx, bad.state, c2, 4, 'attack');
    expect(b2 - c2.wounds).toBe(4);

    // "damage of 3 or more" — a 2-damage hit never rolls.
    const small = setup({ script: [5] });
    const c3 = small.state.operatives[opWith(small.state, 'p1', CASTIGATOR)]!;
    const b3 = c3.wounds;
    inflictDamage(small.ctx, small.state, c3, 2, 'attack');
    expect(b3 - c3.wounds).toBe(2);
  });

  it('Castigator’s Arrest: a lone engaged enemy cannot Fall Back, two enemies lift it', () => {
    const { ctx, state } = setup();
    const castigator = opWith(state, 'p1', CASTIGATOR);
    const foe = opWith(state, 'p2', VOX_SIGNIFIER);
    const foe2 = opWith(state, 'p2', MALOCATOR);
    isolate(state, [castigator, foe, foe2]);
    place(state, castigator, 10, 10);
    place(state, foe, 10.6, 10);
    place(state, foe2, 25, 10);
    const blocked = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: state.operatives[foe]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(blocked.allowed).toBe(false);
    place(state, foe2, 9.4, 10); // a second enemy is now in the CASTIGATOR's control range
    const lifted = ctx.hooks.emit('canPerformAction', state, {
      state,
      operative: state.operatives[foe]!,
      action: 'Fall Back',
      allowed: true,
    });
    expect(lifted.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('CHIRURGANT — Medic! and MEDIKIT', () => {
  function medicSetup(): { ctx: GameContext; state: GameState; medic: string; victim: string } {
    const { ctx, state } = setup();
    const medic = opWith(state, 'p1', CHIRURGANT);
    const victim = opWith(state, 'p1', VOX_SIGNIFIER);
    isolate(state, [medic, victim]);
    place(state, medic, 10, 10);
    place(state, victim, 12, 10);
    return { ctx, state, medic, victim };
  }

  it('"that friendly operative isn’t incapacitated, has 1 wound remaining" and both lose 1 APL', () => {
    const { ctx, state, medic, victim } = medicSetup();
    const v = state.operatives[victim]!;
    inflictDamage(ctx, state, v, 99, 'attack');
    expect(v.incapacitated).toBeFalsy();
    expect(v.wounds).toBe(1);
    expect(v.aplMods).toContain(-1);
    expect(state.operatives[medic]!.aplMods).toContain(-1);
    // "After that action, that friendly operative can immediately perform a free Dash action."
    expect(state.effects.some((e) => e.rule === 'teamFreeAction' && e.operativeId === victim)).toBe(true);
  });

  it('"The first time during each turning point" — the second casualty is not saved', () => {
    const { ctx, state, victim } = medicSetup();
    const other = opWith(state, 'p1', MALOCATOR);
    place(state, other, 11, 11);
    inflictDamage(ctx, state, state.operatives[victim]!, 99, 'attack');
    inflictDamage(ctx, state, state.operatives[other]!, 99, 'attack');
    expect(state.operatives[other]!.incapacitated).toBe(true);
  });

  it('MEDIKIT restores 2D3 wounds to a friendly operative within control range', () => {
    const { ctx, state, medic, victim } = medicSetup();
    place(state, victim, 10.6, 10);
    state.operatives[victim]!.wounds = 2;
    state.activeOperativeId = medic;
    state.activePlayer = 'p1';
    const out = act(ctx, state, medic, 'exaction-squad.arbites-chirurgant.act.medikit', { targetOperativeId: victim });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[victim]!.wounds).toBeGreaterThan(2);
    expect(out.state.operatives[victim]!.wounds).toBeLessThanOrEqual(8);
  });

  it('"It cannot be an operative that the Medic! rule was used on during this turning point"', () => {
    const { ctx, state, medic, victim } = medicSetup();
    inflictDamage(ctx, state, state.operatives[victim]!, 99, 'attack');
    place(state, victim, 10.6, 10);
    state.activeOperativeId = medic;
    state.activePlayer = 'p1';
    const def = getAction('exaction-squad.arbites-chirurgant.act.medikit')!;
    const check = def.check(ctx, state, state.operatives[medic]!, { targetOperativeId: victim });
    expect(check.ok === false || state.operatives[victim]!.wounds === 1).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('LEASHMASTER and the R-VR CYBER-MASTIFF', () => {
  it('Handler: the ready CYBER-MASTIFF is paired with the LEASHMASTER’s activation', () => {
    const { ctx, state } = setup();
    const leash = opWith(state, 'p1', LEASHMASTER);
    const dog = opWith(state, 'p1', MASTIFF);
    const out = reduce(state, { t: 'ActivateOperative', player: 'p1', operativeId: leash, order: 'engage' }, ctx);
    expect(out.state.effects.some((e) => e.rule === 'exaction-squad.handlerPair' && e.operativeId === dog)).toBe(true);
  });

  it('Attack Pattern: a STRATEGIC GAMBIT in the first turning point that picks two of the three', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const ids = gambitOptions(ctx, state, 'p1')
      .map((o) => o.id)
      .filter((id) => id.startsWith('exaction-squad.arbites-leashmaster.attack-pattern'));
    expect(ids).toHaveLength(3);
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: ids[0]! }, ctx);
    const dog = out.state.operatives[opWith(out.state, 'p1', MASTIFF)]!;
    expect(patternsOf(out.state, dog)).toEqual(['Aggressive', 'Swift']);
    // …and it is gone from the gambit list once taken.
    expect(
      gambitOptions(ctx, out.state, 'p1').filter((o) => o.id.includes('attack-pattern')),
    ).toHaveLength(0);
    out.state.turningPoint = 2;
    expect(gambitOptions(ctx, out.state, 'p1').filter((o) => o.id.includes('attack-pattern'))).toHaveLength(0);
  });

  it('Aggressive/Swift/Defensive each do what the sliced menu text says', () => {
    const { ctx, state } = setup();
    const dog = state.operatives[opWith(state, 'p1', MASTIFF)]!;
    const bite = profileOf(MASTIFF, 'Mechanical bite');
    expect(ATTACK_PATTERN_TEXT.Aggressive).toContain('Relentless');
    expect(ATTACK_PATTERN_TEXT.Swift).toContain('2"');
    expect(ATTACK_PATTERN_TEXT.Defensive).toContain('Save');
    expect(moveOf(ctx, state, dog)).toBe(6);
    expect(saveOf(ctx, state, dog)).toBe(4);
    state.effects.push({
      id: 'pattern-test',
      rule: 'exaction-squad.attackPattern',
      source: { kind: 'ability', id: 'exaction-squad.arbites-leashmaster.attack-pattern' },
      operativeId: dog.id,
      player: 'p1',
      data: { patterns: ['Aggressive', 'Swift', 'Defensive'] },
      expiry: { kind: 'endOfBattle' },
    });
    expect(moveOf(ctx, state, dog)).toBe(8);
    expect(saveOf(ctx, state, dog)).toBe(3);
    const rules = effectiveRules(ctx, state, bite, { operative: dog, weaponName: 'Mechanical bite' });
    expect(rules.some((r) => r.id === 'Relentless')).toBe(true);
  });

  it('R-VR COMMAND: "change one of its attack pattern"', () => {
    const { ctx, state } = setup();
    const leash = opWith(state, 'p1', LEASHMASTER);
    const dog = state.operatives[opWith(state, 'p1', MASTIFF)]!;
    state.effects.push({
      id: 'pattern-test2',
      rule: 'exaction-squad.attackPattern',
      source: { kind: 'ability', id: 'exaction-squad.arbites-leashmaster.attack-pattern' },
      operativeId: dog.id,
      player: 'p1',
      data: { patterns: ['Aggressive', 'Swift'] },
      expiry: { kind: 'endOfBattle' },
    });
    state.activeOperativeId = leash;
    state.activePlayer = 'p1';
    const out = act(ctx, state, leash, 'exaction-squad.arbites-leashmaster.act.r-vr-command', {
      targetOperativeId: dog.id,
      choice: 'Swift',
    });
    expect(out.ok).toBe(true);
    expect(patternsOf(out.state, out.state.operatives[dog.id]!)).toEqual(['Aggressive', 'Defensive']);
  });

  it('Beast: "cannot perform any actions other than Apprehend, Charge, Dash, Fall Back, Fight, Guard, Reposition, Pick Up Marker and Place Marker"', () => {
    const { ctx, state } = setup();
    const dog = state.operatives[opWith(state, 'p1', MASTIFF)]!;
    const refused = ctx.hooks.emit('canPerformAction', state, { state, operative: dog, action: 'Shoot', allowed: true });
    expect(refused.allowed).toBe(false);
    for (const action of ['Charge', 'Dash', 'Fight', 'Reposition', 'Pick Up Marker', 'Place Marker']) {
      expect(ctx.hooks.emit('canPerformAction', state, { state, operative: dog, action, allowed: true }).allowed).toBe(true);
    }
    expect(
      ctx.hooks.emit('canPerformAction', state, {
        state,
        operative: dog,
        action: 'exaction-squad.r-vr-cyber-mastiff.act.apprehend',
        allowed: true,
      }).allowed,
    ).toBe(true);
  });

  it('APPREHEND: "worsen the Hit stat of that enemy operative’s weapons by 1 … it cannot perform the Fall Back action"', () => {
    const { ctx, state } = setup();
    const dog = opWith(state, 'p1', MASTIFF);
    const foe = opWith(state, 'p2', VOX_SIGNIFIER);
    isolate(state, [dog, foe]);
    place(state, dog, 10, 10);
    place(state, foe, 10.6, 10);
    state.activeOperativeId = dog;
    state.activePlayer = 'p1';
    const baton = profileOf(VOX_SIGNIFIER, 'Repression baton');
    expect(hitOf(ctx, state, state.operatives[foe]!, baton)).toBe(baton.hit);
    const out = act(ctx, state, dog, 'exaction-squad.r-vr-cyber-mastiff.act.apprehend', { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    const s = out.state;
    expect(s.effects.some((e) => e.rule === APPREHEND_TOKEN && e.operativeId === foe)).toBe(true);
    expect(hitOf(ctx, s, s.operatives[foe]!, baton)).toBe(baton.hit + 1);
    expect(ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[foe]!, action: 'Fall Back', allowed: true }).allowed).toBe(false);
    // "(this isn’t cumulative with being injured)"
    s.operatives[foe]!.wounds = 2;
    expect(hitOf(ctx, s, s.operatives[foe]!, baton)).toBe(baton.hit + 1);
    // "Until that enemy operative is no longer within this operative’s control range"
    place(s, foe, 20, 10);
    expect(hitOf(ctx, s, s.operatives[foe]!, baton)).toBe(baton.hit + 1); // injured only
    s.operatives[foe]!.wounds = 8;
    expect(hitOf(ctx, s, s.operatives[foe]!, baton)).toBe(baton.hit);
  });
});

// ---------------------------------------------------------------------------
describe('MALOCATOR, MARKSMAN, REVELATUM, SUBDUCTOR, VIGILANT and VOX-SIGNIFIER', () => {
  it('Acute Focus: "…the Pick Up Marker, Place Marker, Veriscant or a mission action for 1 less AP", once per activation', () => {
    const { ctx, state } = setup();
    const malocator = state.operatives[opWith(state, 'p1', MALOCATOR)]!;
    const other = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    const pickUp = getAction('Pick Up Marker')!;
    expect(actionCost(ctx, state, malocator, pickUp)).toBe(0);
    expect(actionCost(ctx, state, other, pickUp)).toBe(1);
    expect(actionCost(ctx, state, malocator, getAction('exaction-squad.arbites-malocator.act.veriscant')!)).toBe(0);
    malocator.actionsThisActivation.push('Pick Up Marker');
    expect(actionCost(ctx, state, malocator, pickUp)).toBe(1);
  });

  it('VERISCANT: "that friendly operative’s weapons have the Lethal 5+ and Severe weapon rules"', () => {
    const { ctx, state } = setup();
    const malocator = opWith(state, 'p1', MALOCATOR);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [malocator, foe]);
    place(state, malocator, 6, 10);
    place(state, foe, 12, 10);
    state.activeOperativeId = malocator;
    state.activePlayer = 'p1';
    const out = act(ctx, state, malocator, 'exaction-squad.arbites-malocator.act.veriscant', { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    const s = out.state;
    expect(s.effects.some((e) => e.rule === VERISCANT_TOKEN && e.operativeId === foe)).toBe(true);
    const shooter = s.operatives[opWith(s, 'p1', PROCTOR)]!;
    for (const [weapon, profile] of [
      ['Combat shotgun', profileOf(PROCTOR, 'Combat shotgun', 'close range')],
      ['Repression baton', profileOf(PROCTOR, 'Repression baton')],
    ] as [string, WeaponProfile][]) {
      const rules = effectiveRules(ctx, s, profile, { operative: shooter, target: s.operatives[foe]!, weaponName: weapon });
      expect(rules.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
      expect(rules.some((r) => r.id === 'Severe')).toBe(true);
    }
    // "…until the start of this operative's next activation"
    const after = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: malocator, order: 'engage' }, ctx).state;
    expect(after.effects.some((e) => e.rule === VERISCANT_TOKEN)).toBe(false);
  });

  it('Concealed Position: "this operative can only use this weapon the first time it’s performing the Shoot action"', () => {
    const { ctx, state } = setup();
    const marksman = state.operatives[opWith(state, 'p1', MARKSMAN)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    const concealed = profileOf(MARKSMAN, 'Executioner shotgun', 'concealed');
    const mobile = profileOf(MARKSMAN, 'Executioner shotgun', 'mobile');
    const emit = (profile: WeaponProfile) =>
      ctx.hooks.emit('onSelectWeapon', state, {
        state,
        ctx: {
          attacker: marksman,
          defender: foe,
          weaponName: 'Executioner shotgun',
          profile,
          rules: profile.rules,
          type: 'ranged',
          secondary: false,
          pointBlank: false,
          inCover: false,
          obscured: false,
          vantageAccurate: 0,
          distance: 5,
        },
        allowed: true,
      dryRun: false,
      });
    expect(emit(concealed).allowed).toBe(true);
    (state.opState['exaction-squad.hasShot'] as Record<string, unknown>) = { [marksman.id]: true };
    expect(emit(concealed).allowed).toBe(false);
    expect(emit(mobile).allowed).toBe(true); // the rule is per profile, not per weapon
  });

  it('OPTICS: Lethal 5+ on the concealed and stationary profiles only, and no obscured', () => {
    const { ctx, state } = setup();
    const marksman = opWith(state, 'p1', MARKSMAN);
    isolate(state, [marksman]);
    state.activeOperativeId = marksman;
    state.activePlayer = 'p1';
    const out = act(ctx, state, marksman, 'exaction-squad.arbites-marksman.act.optics', {});
    expect(out.ok).toBe(true);
    const s = out.state;
    const op = s.operatives[marksman]!;
    for (const name of ['concealed', 'stationary']) {
      const rules = effectiveRules(ctx, s, profileOf(MARKSMAN, 'Executioner shotgun', name), {
        operative: op,
        weaponName: 'Executioner shotgun',
      });
      expect(rules.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
    }
    const mobile = effectiveRules(ctx, s, profileOf(MARKSMAN, 'Executioner shotgun', 'mobile'), {
      operative: op,
      weaponName: 'Executioner shotgun',
    });
    expect(mobile.some((r) => r.id === 'Lethal')).toBe(false);
  });

  it('First in the Field: a STRATEGIC GAMBIT in TP1 granting a free Reposition inside the drop zone', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const revelatum = opWith(state, 'p1', REVELATUM);
    const zone = state.map.dropZones[state.setup.dropZone.p1 ?? 'p1']![0]!;
    const centre = zone.reduce((a, p) => ({ x: a.x + p.x / zone.length, y: a.y + p.y / zone.length }), { x: 0, y: 0 });
    place(state, revelatum, centre.x, centre.y);
    const options = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    expect(options).toContain('exaction-squad.arbites-revelatum.first-in-the-field');
    const out = reduce(
      state,
      { t: 'UseGambit', player: 'p1', gambitId: 'exaction-squad.arbites-revelatum.first-in-the-field' },
      ctx,
    );
    expect(out.ok).toBe(true);
    const grant = out.state.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === revelatum);
    expect(grant?.data?.['only']).toEqual(['Reposition']);
  });

  it('SPOT: "That friendly operative’s ranged weapons have the Seek Light weapon rule"', () => {
    const { ctx, state } = setup();
    const revelatum = opWith(state, 'p1', REVELATUM);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [revelatum, foe]);
    place(state, revelatum, 6, 10);
    place(state, foe, 12, 10);
    state.activeOperativeId = revelatum;
    state.activePlayer = 'p1';
    const out = act(ctx, state, revelatum, 'exaction-squad.arbites-revelatum.act.spot', { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    const s = out.state;
    expect(s.effects.some((e) => e.rule === SPOT_TOKEN && e.operativeId === foe)).toBe(true);
    const shooter = s.operatives[opWith(s, 'p1', PROCTOR)]!;
    const rules = effectiveRules(ctx, s, profileOf(PROCTOR, 'Combat shotgun', 'close range'), {
      operative: shooter,
      target: s.operatives[foe]!,
      weaponName: 'Combat shotgun',
    });
    expect(rules.some((r) => r.id === 'SeekLight')).toBe(true);
    // A melee weapon gets nothing — the clause is "ranged weapons".
    const melee = effectiveRules(ctx, s, profileOf(PROCTOR, 'Repression baton'), {
      operative: shooter,
      target: s.operatives[foe]!,
      weaponName: 'Repression baton',
    });
    expect(melee.some((r) => r.id === 'SeekLight')).toBe(false);
  });

  it('SPOT refuses an enemy more than 8" away ("visible to and within 8"")', () => {
    const { ctx, state } = setup();
    const revelatum = opWith(state, 'p1', REVELATUM);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [revelatum, foe]);
    place(state, revelatum, 4, 10);
    place(state, foe, 24, 10);
    const def = getAction('exaction-squad.arbites-revelatum.act.spot')!;
    expect(def.check(ctx, state, state.operatives[revelatum]!, {}).ok).toBe(false);
  });

  it('Stubborn Subjugator: "ignore any changes to the Hit stat of this operative’s melee weapons"', () => {
    const { ctx, state } = setup();
    const subductor = state.operatives[opWith(state, 'p1', SUBDUCTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [subductor.id, foe.id]);
    place(state, subductor.id, 10, 10);
    place(state, foe.id, 10.6, 10);
    subductor.wounds = 2; // injured: Hit would be worsened by 1
    const maul = profileOf(SUBDUCTOR, 'Shock maul & assault shield');
    const pistol = profileOf(SUBDUCTOR, 'Shotpistol');
    // Outside a fight the injured penalty stands — the rule is "melee weapons" only.
    expect(hitOf(ctx, state, subductor, pistol)).toBe(pistol.hit + 1);
    expect(startFight(ctx, state, subductor, 'Shock maul & assault shield', undefined, foe.id).ok).toBe(true);
    expect(hitOf(ctx, state, subductor, maul)).toBe(maul.hit);
  });

  it('Close Quarters Vigilance: the VIGILANT shoots while engaged, without the point-blank Hit penalty', () => {
    const { ctx, state } = setup();
    const vigilant = opWith(state, 'p1', VIGILANT);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [vigilant, foe]);
    place(state, vigilant, 10, 10);
    place(state, foe, 10.6, 10);
    state.activeOperativeId = vigilant;
    state.activePlayer = 'p1';
    // The universal Shoot action refuses while engaged.
    expect(getAction('Shoot')!.check(ctx, state, state.operatives[vigilant]!, { weaponName: 'Combat shotgun', targetId: foe }).ok).toBe(false);
    const def = getAction(VIGILANT_SHOOT)!;
    expect(def.treatedAs).toBe('Shoot');
    expect(def.check(ctx, state, state.operatives[vigilant]!, { weaponName: 'Combat shotgun', targetId: foe }).ok).toBe(true);
    const out = act(ctx, state, vigilant, VIGILANT_SHOOT, { weaponName: 'Combat shotgun', targetId: foe });
    expect(out.ok).toBe(true);
    const rolled = out.state.log.find((e) => e.data?.['pool'] === 'attack');
    expect(rolled?.data?.['hit']).toBe(profileOf(VIGILANT, 'Combat shotgun', 'close range').hit);
  });

  it('Close Quarters Vigilance: "…only if it hasn’t performed the Charge action during the activation"', () => {
    const { ctx, state } = setup();
    const vigilant = opWith(state, 'p1', VIGILANT);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [vigilant, foe]);
    place(state, vigilant, 10, 10);
    place(state, foe, 10.6, 10);
    state.operatives[vigilant]!.actionsThisActivation.push('Charge');
    const def = getAction(VIGILANT_SHOOT)!;
    expect(def.check(ctx, state, state.operatives[vigilant]!, { weaponName: 'Combat shotgun', targetId: foe }).ok).toBe(false);
    // …and it is only available to the VIGILANT.
    expect(def.available!(ctx, state, state.operatives[opWith(state, 'p1', PROCTOR)]!)).toBe(false);
  });

  it('SIGNAL: "Until the end of that operative’s next activation, add 1 to its APL stat"', () => {
    const { ctx, state } = setup();
    const vox = opWith(state, 'p1', VOX_SIGNIFIER);
    const mate = opWith(state, 'p1', SUBDUCTOR);
    isolate(state, [vox, mate]);
    place(state, vox, 8, 10);
    place(state, mate, 12, 10);
    state.activeOperativeId = vox;
    state.activePlayer = 'p1';
    const out = act(ctx, state, vox, 'exaction-squad.arbites-vox-signifier.act.signal', { targetOperativeId: mate });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mate]!.aplMods).toContain(1);
  });
});

// ---------------------------------------------------------------------------
describe('EXACTION SQUAD strategy ploys', () => {
  const useGambit = (ctx: GameContext, state: GameState, id: string): GameState => {
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: id }, ctx);
    expect(out.ok).toBe(true);
    out.state.phase = 'firefight';
    out.state.firefightStep = 'performActions';
    return out.state;
  };

  it('GUILT REVEALS ITSELF: a Conceal operative within 4" cannot be in cover, but keeps its cover save', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', PROCTOR);
    const foe = opWith(state, 'p2', CASTIGATOR);
    isolate(state, [shooter, foe]);
    place(state, shooter, 10, 10);
    place(state, foe, 13, 10);
    const s = useGambit(ctx, state, 'exaction-squad.sp.guilt-reveals-itself');
    const a = s.operatives[shooter]!;
    const t = s.operatives[foe]!;
    const ev = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: a,
      target: t,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('all');
    // Beyond 4" the ploy does nothing.
    place(s, foe, 20, 10);
    const far = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: a,
      target: s.operatives[foe]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(far.ignoreCoverTerrain).toBe('none');
    expect(ruleText('exaction-squad.sp.guilt-reveals-itself')).toContain('doesn’t remove their cover save');
  });

  it('GUILT REVEALS ITSELF: "it doesn’t remove their cover save (if any)" — the save is put back', () => {
    const lightWall: TerrainFeature = {
      id: 'light-wall',
      kind: 'test.light',
      label: 'LIGHT WALL',
      placement: { x: 12.5, y: 9, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'light-wall.body',
          featureId: 'light-wall',
          poly: [
            { x: 12.4, y: 9 },
            { x: 12.7, y: 9 },
            { x: 12.7, y: 11.5 },
            { x: 12.4, y: 11.5 },
          ],
          z0: 0,
          z1: 1,
          types: ['Light'],
          role: 'wall',
        },
      ],
    };
    const ctx = teamContext([exactionSquad], { seed: 7 });
    const map = testMap({ features: [lightWall] });
    const picks = rosterIncluding(exactionSquad, ROLES);
    const state = battle({ ctx, map, p1: { module: exactionSquad, picks }, p2: { module: exactionSquad, picks } });
    const shooter = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [shooter.id, foe.id]);
    place(state, shooter.id, 10, 10.2);
    place(state, foe.id, 13.5, 10.2); // base-to-base ≈ 2.4": inside 4", outside 2"
    const shotgun = profileOf(PROCTOR, 'Combat shotgun', 'close range');
    const rules = effectiveRules(ctx, state, shotgun, { operative: shooter, target: foe, weaponName: 'Combat shotgun' });
    // Without the ploy the target is in cover, so a Conceal order makes it an illegal target.
    foe.order = 'conceal';
    expect(checkTarget(ctx, state, shooter, foe, shotgun, rules).inCover).toBe(true);
    expect(checkTarget(ctx, state, shooter, foe, shotgun, rules).valid).toBe(false);

    const s = useGambit(ctx, state, 'exaction-squad.sp.guilt-reveals-itself');
    const withPloy = checkTarget(ctx, s, s.operatives[shooter.id]!, s.operatives[foe.id]!, shotgun, rules);
    expect(withPloy.valid).toBe(true); // "this can allow such operatives to be targeted"
    expect(withPloy.inCover).toBe(false);
    // …and the cover save is handed back at the Roll Defence Dice step.
    s.sequence = {
      kind: 'shoot',
      step: 'rollDefence',
      attackerId: shooter.id,
      targetId: foe.id,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Combat shotgun',
      profileName: 'close range',
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
    const ev = ctx.hooks.emit('onDefenceDice', s, {
      state: s,
      ctx: {
        attacker: s.operatives[shooter.id]!,
        defender: s.operatives[foe.id]!,
        weaponName: 'Combat shotgun',
        profile: shotgun,
        rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 2.4,
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

  it('INVIOLATE JURISDICTION: a defence re-roll while within 2" of an objective marker', () => {
    const { ctx, state } = setup();
    const target = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [target.id, foe.id]);
    place(state, target.id, 10, 10);
    place(state, foe.id, 20, 10);
    for (const m of Object.values(state.markers)) if (m.kind === 'objective') delete state.markers[m.id];
    const s = useGambit(ctx, state, 'exaction-squad.sp.inviolate-jurisdiction');
    const shotgun = profileOf(CASTIGATOR, 'Combat shotgun', 'close range');
    const emit = (st: GameState) =>
      ctx.hooks.emit('onDefenceDice', st, {
        state: st,
        ctx: {
          attacker: st.operatives[foe.id]!,
          defender: st.operatives[target.id]!,
          weaponName: 'Combat shotgun',
          profile: shotgun,
          rules: shotgun.rules,
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
        mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 },
        rerolls: [],
      });
    expect(emit(s).rerolls).toHaveLength(0);
    s.markers['obj-iv'] = { id: 'obj-iv', kind: 'objective', diameterMm: 40, pos: { x: 11, y: 10 }, z: 0, flags: {} };
    expect(emit(s).rerolls.map((g) => g.id)).toContain('exaction-squad.inviolateJurisdiction');
  });

  it('DISPENSE JUSTICE: Ceaseless while it hasn’t moved more than its Move stat, and nothing once it has', () => {
    const { ctx, state } = setup();
    const fighter = opWith(state, 'p1', CASTIGATOR);
    const s = useGambit(ctx, state, 'exaction-squad.sp.dispense-justice');
    const activated = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: fighter, order: 'engage' }, ctx).state;
    const maul = profileOf(CASTIGATOR, 'Excruciator maul');
    const op = activated.operatives[fighter]!;
    const rules = () => effectiveRules(ctx, activated, maul, { operative: op, weaponName: 'Excruciator maul' });
    expect(rules().some((r) => r.id === 'Ceaseless')).toBe(true);
    // A 7" move on a 6" Move stat: "if it hasn't moved more than its Move stat" no longer holds.
    activated.log.push({ seq: activated.seq++, tp: 1, kind: 'action', player: 'p1', text: 'move', data: { operativeId: fighter, inches: 7 } });
    expect(rules().some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('TERMINAL DECREE: Balanced within 6", or at any range for a GUNNER', () => {
    const { ctx, state } = setup({ roles: [...ROLES.slice(0, 10), GUNNER] });
    const shooter = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const gunner = state.operatives[opWith(state, 'p1', GUNNER)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    isolate(state, [shooter.id, gunner.id, foe.id]);
    place(state, shooter.id, 4, 10);
    place(state, gunner.id, 4, 12);
    place(state, foe.id, 20, 10);
    const s = useGambit(ctx, state, 'exaction-squad.sp.terminal-decree');
    const shotgun = profileOf(PROCTOR, 'Combat shotgun', 'long range');
    const far = effectiveRules(ctx, s, shotgun, { operative: s.operatives[shooter.id]!, target: s.operatives[foe.id]!, weaponName: 'Combat shotgun' });
    expect(far.some((r) => r.id === 'Balanced')).toBe(false);
    place(s, foe.id, 9, 10);
    const near = effectiveRules(ctx, s, shotgun, { operative: s.operatives[shooter.id]!, target: s.operatives[foe.id]!, weaponName: 'Combat shotgun' });
    expect(near.some((r) => r.id === 'Balanced')).toBe(true);
    place(s, foe.id, 25, 10);
    const stubber = profileOf(GUNNER, 'Heavy stubber', 'focused');
    const gunnerRules = effectiveRules(ctx, s, stubber, { operative: s.operatives[gunner.id]!, target: s.operatives[foe.id]!, weaponName: 'Heavy stubber' });
    expect(gunnerRules.some((r) => r.id === 'Balanced')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('EXACTION SQUAD firefight ploys', () => {
  const usePloy = (ctx: GameContext, state: GameState, id: string, data?: Record<string, unknown>) =>
    reduce(state, { t: 'UsePloy', player: 'p1', ployId: id, ...(data ? { data } : {}) }, ctx);

  it('LONG ARM OF THE EMPEROR’S LAW: "add 3" to x" on a Range x weapon', () => {
    const { ctx, state } = setup();
    const shooter = opWith(state, 'p1', PROCTOR);
    state.activeOperativeId = shooter;
    state.activePlayer = 'p1';
    const out = usePloy(ctx, state, 'exaction-squad.fp.long-arm-of-the-emperors-law');
    expect(out.ok).toBe(true);
    const s = out.state;
    const profile = profileOf(PROCTOR, 'Shotpistol');
    expect(profile.rules.find((r) => r.id === 'Range')!.x).toBe(8);
    const rules = effectiveRules(ctx, s, profile, { operative: s.operatives[shooter]!, weaponName: 'Shotpistol' });
    expect(rules.find((r) => r.id === 'Range')!.x).toBe(11);
    // D-019: the shared catalogue profile is never mutated.
    expect(profileOf(PROCTOR, 'Shotpistol').rules.find((r) => r.id === 'Range')!.x).toBe(8);
  });

  it('EXACT PUNISHMENT: a free Shoot or Fight, locked onto the enemy that attacked', () => {
    const { ctx, state } = setup();
    const friend = opWith(state, 'p1', PROCTOR);
    const foe = opWith(state, 'p2', CASTIGATOR);
    const other = opWith(state, 'p2', VOX_SIGNIFIER);
    isolate(state, [friend, foe, other]);
    place(state, friend, 10, 10);
    place(state, foe, 13, 10);
    place(state, other, 14, 12);
    const out = usePloy(ctx, state, 'exaction-squad.fp.exact-punishment', {
      operativeId: friend,
      targetOperativeId: foe,
    });
    expect(out.ok).toBe(true);
    const s = out.state;
    const grant = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === friend);
    expect(grant?.data?.['only']).toEqual(['Shoot', 'Fight', VIGILANT_SHOOT]);
    // "you cannot select any other enemy operative as a valid target … during that action"
    const op = s.operatives[friend]!;
    op.apSpent = Number(grant!.data!['threshold']);
    const blocked = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: op,
      target: s.operatives[other]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(blocked.valid).toBe(false);
    const allowed = ctx.hooks.emit('onValidTarget', s, {
      state: s,
      attacker: op,
      target: s.operatives[foe]!,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(allowed.valid).toBe(true);
  });

  it('BRUTAL BACKUP: "One other friendly EXACTION SQUAD operative can immediately perform a free Fight action"', () => {
    const { ctx, state } = setup();
    const active = opWith(state, 'p1', CASTIGATOR);
    const helper = opWith(state, 'p1', SUBDUCTOR);
    const foe = opWith(state, 'p2', VOX_SIGNIFIER);
    isolate(state, [active, helper, foe]);
    place(state, active, 10, 10);
    place(state, foe, 10.6, 10);
    place(state, helper, 11.2, 10);
    state.activeOperativeId = active;
    state.activePlayer = 'p1';
    const out = usePloy(ctx, state, 'exaction-squad.fp.brutal-backup');
    expect(out.ok).toBe(true);
    const grant = out.state.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === helper);
    expect(grant?.data?.['only']).toEqual(['Fight']);
    expect(out.state.operatives[helper]!.aplMods).toContain(1);
  });

  it('EXECUTION ORDER records the marked enemy (the interrupt itself is reminder-only)', () => {
    const { ctx, state } = setup();
    const foe = opWith(state, 'p2', CASTIGATOR);
    const out = usePloy(ctx, state, 'exaction-squad.fp.execution-order', { operativeId: foe });
    expect(out.ok).toBe(true);
    expect(out.state.effects.some((e) => e.rule === 'exaction-squad.executionOrder' && e.operativeId === foe)).toBe(true);
    expect(ruleText('exaction-squad.fp.execution-order')).toContain('you can interrupt that activation');
  });

  it('all eight ploys cost 1CP and every one carries an aiHints ployValue', () => {
    expect(exactionSquad.ploys.map((p) => p.cp)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    for (const ploy of exactionSquad.ploys) expect(exactionSquad.aiHints!.ployValue![ploy.id]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('EXACTION SQUAD faction equipment', () => {
  it('REINFORCED MIRROR-VISOR: APL reductions are ignored and enemy Shock is stripped', () => {
    const { ctx, state } = setup({ equipment: ['exaction-squad.eq.reinforced-mirror-visor'] });
    const mine = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    const foe = state.operatives[opWith(state, 'p2', PROCTOR)]!;
    mine.aplMods.push(-1);
    const mods = ctx.hooks.emit('onStatMod', state, { state, operative: mine, mods: { hit: 0, save: 0, apl: 0, move: 0, atk: 0 } });
    expect(mods.mods.apl).toBe(1);
    const maul = profileOf(PROCTOR, 'Dominator maul & assault shield');
    expect(maul.rules.some((r) => r.id === 'Shock')).toBe(true);
    const rules = effectiveRules(ctx, state, maul, {
      operative: foe,
      target: mine,
      weaponName: 'Dominator maul & assault shield',
    });
    expect(rules.some((r) => r.id === 'Shock')).toBe(false);
  });

  it('MANACLES: "roll two D6 … if any result is a 4+, that enemy operative cannot perform that action"', () => {
    const good = setup({ equipment: ['exaction-squad.eq.manacles'], script: [4, 1] });
    const jailer = opWith(good.state, 'p1', SUBDUCTOR);
    const foe = opWith(good.state, 'p2', VOX_SIGNIFIER);
    isolate(good.state, [jailer, foe]);
    place(good.state, jailer, 10, 10);
    place(good.state, foe, 10.6, 10);
    good.state.operatives[foe]!.ready = true;
    const s = activate(good.ctx, good.state, foe);
    expect(
      good.ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[foe]!, action: 'Fall Back', allowed: true }).allowed,
    ).toBe(false);

    const bad = setup({ equipment: ['exaction-squad.eq.manacles'], script: [3, 2] });
    const j2 = opWith(bad.state, 'p1', SUBDUCTOR);
    const f2 = opWith(bad.state, 'p2', VOX_SIGNIFIER);
    isolate(bad.state, [j2, f2]);
    place(bad.state, j2, 10, 10);
    place(bad.state, f2, 10.6, 10);
    const s2 = activate(bad.ctx, bad.state, f2);
    expect(
      bad.ctx.hooks.emit('canPerformAction', s2, { state: s2, operative: s2.operatives[f2]!, action: 'Fall Back', allowed: true }).allowed,
    ).toBe(true);
  });

  it('SPECIAL ISSUE SHELLS: Saturate against a target in cover, up to twice per turning point', () => {
    const { ctx, state } = setup({ equipment: ['exaction-squad.eq.special-issue-shells'] });
    const shooter = state.operatives[opWith(state, 'p1', PROCTOR)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    // The PROCTOR's shotgun is one of the four named weapons; the target's 4+ Save is not "3+ or
    // better", so with no cover in play the rule is declined and the budget is untouched.
    const shotgun = profileOf(PROCTOR, 'Combat shotgun', 'close range');
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: foe,
        weaponName: 'Combat shotgun',
        profile: shotgun,
        rules: shotgun.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 6,
      },
      allowed: true,
      dryRun: false,
    });
    expect(state.effects.some((e) => e.rule === 'exaction-squad.shells')).toBe(false);
    // A 3+ Save target (the SUBDUCTOR) takes the printed Piercing 1 branch.
    const armoured = state.operatives[opWith(state, 'p2', SUBDUCTOR)]!;
    ctx.hooks.emit('onSelectWeapon', state, {
      state,
      ctx: {
        attacker: shooter,
        defender: armoured,
        weaponName: 'Combat shotgun',
        profile: shotgun,
        rules: shotgun.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 6,
      },
      allowed: true,
      dryRun: false,
    });
    const eff = state.effects.find((e) => e.rule === 'exaction-squad.shells');
    expect(eff?.data?.['rule']).toBe('Piercing');
    const rules = effectiveRules(ctx, state, shotgun, { operative: shooter, target: armoured, weaponName: 'Combat shotgun' });
    expect(rules.some((r) => r.id === 'Piercing' && r.x === 1)).toBe(true);
    expect(ruleText('exaction-squad.eq.special-issue-shells')).toContain('Up to twice per turning point');
  });

  it('every equipment option carries an aiHints equipmentValue', () => {
    for (const eq of exactionSquad.equipment) expect(exactionSquad.aiHints!.equipmentValue![eq.id]).toBeGreaterThan(0);
    expect(Object.keys(exactionSquad.aiHints!.roles!)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
describe('EXACTION SQUAD reminder-only clauses are recorded, not faked', () => {
  it('STROBING PHOSPHOR-LUMEN registers no re-roll filter, because RerollGrant cannot exclude a value', () => {
    const { ctx, state } = setup({ equipment: ['exaction-squad.eq.strobing-phosphor-lumen'] });
    const mine = state.operatives[opWith(state, 'p1', VOX_SIGNIFIER)]!;
    const foe = state.operatives[opWith(state, 'p2', CASTIGATOR)]!;
    place(state, mine.id, 10, 10);
    place(state, foe.id, 11, 10);
    const shotgun = profileOf(CASTIGATOR, 'Combat shotgun', 'close range');
    const grants = [{ id: 'x:ceaseless', label: 'Ceaseless', mode: 'value' as const, player: 'p2' as const }];
    const ev = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: {
        attacker: foe,
        defender: mine,
        weaponName: 'Combat shotgun',
        profile: shotgun,
        rules: shotgun.rules,
        type: 'ranged',
        secondary: false,
        pointBlank: false,
        inCover: false,
        obscured: false,
        vantageAccurate: 0,
        distance: 1,
      },
      dice: [1, 1, 3, 6],
      rerolls: grants,
    });
    // Honest: the grant is untouched. The printed clause needs a value filter on RerollGrant.
    expect(ev.rerolls).toEqual(grants);
    expect(ruleText('exaction-squad.eq.strobing-phosphor-lumen')).toContain('cannot re-roll their attack dice results of 1');
  });

  it('EXECUTION ORDER’s interrupt is not simulated: no friendly operative is force-activated', () => {
    const { ctx, state } = setup();
    const before = aliveOperatives(state, 'p1').filter((o) => o.ready).length;
    const out = reduce(state, { t: 'UsePloy', player: 'p1', ployId: 'exaction-squad.fp.execution-order' }, ctx);
    expect(aliveOperatives(out.state, 'p1').filter((o) => o.ready).length).toBe(before);
  });

  it('Handler’s "complete their activations action by action in any order" is recorded, not enforced', () => {
    const { ctx, state } = setup();
    const leash = opWith(state, 'p1', LEASHMASTER);
    const dog = opWith(state, 'p1', MASTIFF);
    const out = reduce(state, { t: 'ActivateOperative', player: 'p1', operativeId: leash, order: 'engage' }, ctx);
    expect(out.state.activeOperativeId).toBe(leash);
    expect(out.state.operatives[dog]!.ready).toBe(true); // still a separate activation
    expect(abilityText(LEASHMASTER, 'exaction-squad.arbites-leashmaster.handler')).toContain('at the same time');
  });

  it('the printed AP of APPREHEND is taken from the data, which records 0 — see the report', () => {
    expect(actionOf(MASTIFF, 'exaction-squad.r-vr-cyber-mastiff.act.apprehend').ap).toBe(0);
    expect(NOTES[0]).toContain('no AP cost on the page');
  });
});

