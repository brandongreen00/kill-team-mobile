/**
 * EXODITE DRAGON MASTERS. Every test quotes the printed rule it pins, read out of
 * `data/teams/exodite-dragon-masters.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/exodite-dragon-masters/
 */
import { describe, expect, it } from 'vitest';
import rawJson from '../../data/teams/exodite-dragon-masters.json';
import { availableActions, getAction } from '../../src/core/actions.ts';
import type { GameContext } from '../../src/core/context.ts';
import { countCrits } from '../../src/core/dice.ts';
import { endTurningPoint, readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { advanceFight, startFight } from '../../src/core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import { aliveOperatives, hitOf, inflictDamage, markerController, moveOf, weaponsOf } from '../../src/core/state.ts';
import type { GameState, OperativeState, TerrainFeature, Vec2, WeaponProfile } from '../../src/core/types.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import { teamData } from '../../src/teams/data.ts';
import {
  ABILITY,
  ACT_CLEANSING,
  ACT_WAILS,
  ACT_WINDS_GRACE,
  CARD,
  CLANBLADE_UPGRADES,
  EARTHEN_WRATH_WEAPON,
  EQ,
  FIGHT_REACH,
  FP,
  GUARD_NEXUS,
  KW,
  LEYSTALKER_UPGRADES,
  RULE,
  SONG_OF_RENEWAL,
  SP,
  SPEED_LABEL,
  SPRINT,
  SPRINT_MOONSONG,
  SPRINT_NOMAD,
  SPRINT_RIDING,
  STONESINGER_UPGRADES,
  TURN,
  UPGRADE_TEXT,
  baseSpeedOf,
  exoditeDragonMasters,
  hasUpgrade,
  setSpeed,
  setUpgrades,
  sowTheSeeds,
  speedOf,
  sprintAllowance,
  upgradesOf,
  type Upgrade,
} from '../../src/teams/exodite-dragon-masters/index.ts';
import { kasrkin } from '../../src/teams/kasrkin/index.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { heavyBlock, rect, testMap, vantagePlatform } from '../fixtures.ts';
import { act, activate, battle, mapById, opWith, realMaps, teamContext } from './harness.ts';

const DATA = teamData('exodite-dragon-masters');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

/** p1 positions: well apart, so no rule fires on an unrelated neighbour. */
const P1: Vec2[] = [
  { x: 4, y: 3 },
  { x: 4, y: 9 },
  { x: 4, y: 15 },
  { x: 9, y: 19 },
  { x: 13, y: 19 },
];
const P2: Vec2[] = [
  { x: 26, y: 3 },
  { x: 26, y: 7 },
  { x: 26, y: 11 },
  { x: 26, y: 15 },
  { x: 26, y: 19 },
  { x: 22, y: 19 },
];

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  mirror?: boolean;
  features?: TerrainFeature[];
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const foe = opts.mirror ? exoditeDragonMasters : kasrkin;
  const ctx = teamContext([exoditeDragonMasters, kasrkin], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const map = opts.features ? testMap({ features: opts.features }) : testMap();
  const state = battle({
    ctx,
    map,
    p1: { module: exoditeDragonMasters, ...(opts.equipment ? { equipment: opts.equipment } : {}), positions: P1 },
    p2: { module: foe, positions: P2 },
  });
  return { ctx, state };
}

const clanbladeOf = (s: GameState): string => opWith(s, 'p1', CARD.clanblade);
const leystalkerOf = (s: GameState): string => opWith(s, 'p1', CARD.leystalker);
const stonesingerOf = (s: GameState): string => opWith(s, 'p1', CARD.stonesinger);
const drakolitheOf = (s: GameState): string => opWith(s, 'p1', CARD.drakolithe);

const place = (state: GameState, id: string, x: number, y: number, rot = 0): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  op.rot = rot;
  return op;
};

/** Park everyone except the named operatives on the top edge, clear of every test line. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 2 + (n % 9) * 3, y: 20.9 };
    op.z = 0;
    n++;
  }
}

/** A Heavy piece that is intervening for cover/obscured but does not block visibility. */
function coverPiece(id: string, x: number, y: number, w: number, h: number, z1: number): TerrainFeature {
  return {
    id,
    kind: 'test.cover',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      {
        id: `${id}.body`,
        featureId: id,
        poly: rect(x, y, w, h),
        z0: 0,
        z1,
        types: ['Heavy'],
        role: 'rubble',
        blocksVisibility: false,
        solid: false,
      },
    ],
  };
}

/** A tall Blocking curtain: it denies control-range visibility without blocking movement. */
function curtain(id: string, x: number, y: number, w: number, h: number): TerrainFeature {
  return {
    id,
    kind: 'test.curtain',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      { id: `${id}.body`, featureId: id, poly: rect(x, y, w, h), z0: 0, z1: 3, types: ['Blocking'], role: 'wall' },
    ],
  };
}

/** An opposing operative with a weapon it can shoot across the board, and that weapon's name. */
function shooter(ctx: GameContext, state: GameState): { id: string; weapon: string } {
  for (const id of state.teams.p2.operativeIds) {
    const clean = weaponsOf(ctx, state, state.operatives[id]!, 'ranged').find((w) =>
      w.profiles.every(
        (pr) => !pr.rules.some((r) => r.id === 'Range' || r.id === 'Heavy' || r.id === 'ConcealedPosition'),
      ),
    );
    if (clean) return { id, weapon: clean.name };
  }
  throw new Error('no opposing operative has an unrestricted ranged weapon');
}

const sprint = (ctx: GameContext, state: GameState, id: string, to: Vec2, action = SPRINT) =>
  act(ctx, state, id, action, { targetPos: to });

/** Resolve pending decisions with the least-committal option until `stop` holds. */
function resolveUntil(ctx: GameContext, state: GameState, stop: (s: GameState) => boolean): GameState {
  let s = state;
  let guard = 0;
  while (!stop(s) && s.pending.length > 0 && guard++ < 40) {
    const d = s.pending[0]!;
    const pick = d.options.find((o) => o.id === 'keep') ?? d.options.find((o) => !o.disabled)!;
    s = reduce(
      s,
      { t: 'ResolveDecision', decisionId: d.id, optionId: pick.id, ...(pick.data ? { data: pick.data } : {}) },
      ctx,
    ).state;
  }
  return s;
}

const defenceRolled = (s: GameState): boolean =>
  s.sequence?.kind === 'shoot' && (s.sequence as ShootSequence).defence.dice.length > 0;

// ---------------------------------------------------------------------------
describe('EXODITE DRAGON MASTERS data (pinned against data/teams/exodite-dragon-masters.json)', () => {
  it('has 4 datacards: three MOUNTED APL 4 / M 12" / Sv 3+ / W 24 on 75x42 ovals and the DRAKOLITHE', () => {
    expect(DATA.datacards).toHaveLength(4);
    for (const id of [CARD.clanblade, CARD.leystalker, CARD.stonesinger]) {
      const card = DATA.datacards.find((c) => c.id === id)!;
      expect(card).toMatchObject({ apl: 4, move: 12, save: 3, wounds: 24 });
      expect(card.base).toEqual({ shape: 'oval', mm: [75, 42] });
      expect(card.keywords).toEqual(expect.arrayContaining([KW, 'AELDARI', 'MOUNTED']));
    }
    const drak = DATA.datacards.find((c) => c.id === CARD.drakolithe)!;
    expect(drak).toMatchObject({ apl: 2, move: 8, save: 5, wounds: 7 });
    expect(drak.base).toEqual({ shape: 'round', mm: 32 });
    expect(drak.keywords).not.toContain('MOUNTED');
    expect(DATA.datacards.filter((c) => c.keywords.includes('PSYKER')).map((c) => c.id)).toEqual([CARD.stonesinger]);
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(CARD.clanblade, 'Solar carbine')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 3 });
    expect(profileOf(CARD.clanblade, 'Moonblades')).toMatchObject({ atk: 5, hit: 3, dmgN: 4, dmgC: 6 });
    expect(profileOf(CARD.clanblade, 'Drakesteed fangs & talons')).toMatchObject({ atk: 6, hit: 3, dmgN: 3, dmgC: 5 });
    expect(profileOf(CARD.leystalker, 'Long rifle', 'mobile')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 3 });
    expect(profileOf(CARD.leystalker, 'Long rifle', 'stationary')).toMatchObject({ atk: 4, hit: 2, dmgN: 3, dmgC: 3 });
    expect(profileOf(CARD.stonesinger, 'Venomcrest spit').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Severe',
      'Torrent 2"',
    ]);
    expect(profileOf(CARD.drakolithe, 'Fangs & talons')).toMatchObject({ atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
  });

  it('the two rare weapon rules are Aimed (long rifle, stationary) and PSYCHIC (stone stave)', () => {
    expect(DATA.rareWeaponRules).toEqual(['Aimed', 'PSYCHIC']);
    expect(profileOf(CARD.leystalker, 'Long rifle', 'stationary').rules.map((r) => r.id)).toContain('Aimed');
    expect(profileOf(CARD.stonesinger, 'Stone stave').rules.map((r) => r.id)).toContain('PSYCHIC');
  });

  it('Aimed resolves to the LEYSTALKER’s own datacard ability, not the shared registry (D-033)', () => {
    expect(rareWeaponRuleText('Aimed', DATA.id)).toBe(abilityText(CARD.leystalker, ABILITY.aimed));
    expect(rareWeaponRuleText('Aimed', DATA.id)).toContain('it cannot move more than 3" during an activation');
  });

  it('notes[] records that no datacard carries the LEADER keyword, and none does', () => {
    expect(NOTES).toEqual([
      'no datacard in this team carries the LEADER keyword — the leader is not marked on the source page',
    ]);
    expect(DATA.datacards.every((c) => !c.keywords.includes('LEADER'))).toBe(true);
    expect(DATA.selection.leader.count).toBe(0);
    expect(DATA.selection.list.every((e) => !e.isLeader)).toBe(true);
  });

  it('defaultRoster is legal and fields the printed fixed five (all four datacards)', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(5);
    expect(validateRosterFor(DATA, picks).errors).toEqual([]);
    const counts = picks.reduce<Record<string, number>>((a, p) => ({ ...a, [p.datacardId]: (a[p.datacardId] ?? 0) + 1 }), {});
    expect(counts).toEqual({
      [CARD.clanblade]: 1,
      [CARD.leystalker]: 1,
      [CARD.stonesinger]: 1,
      [CARD.drakolithe]: 2,
    });
    expect(DATA.selection.constraints).toEqual([]);
  });

  it('has 3 faction rules, 4 + 4 ploys, 4 equipment, 8 abilities and 1 printed unique action', () => {
    expect(DATA.factionRules.map((r) => r.id)).toEqual([RULE.agility, RULE.cavalry, RULE.speed]);
    expect(DATA.strategyPloys.map((p) => p.id)).toEqual([SP.windSwift, SP.draconicFury, SP.sinuousFlux, SP.rideThemDown]);
    expect(DATA.firefightPloys.map((p) => p.id)).toEqual([FP.survivalistSpirit, FP.leap, FP.feralHunger, FP.ridingMastery]);
    expect(DATA.equipment.map((e) => e.id)).toEqual([EQ.dragonscaleMesh, EQ.clanTalismans, EQ.lileathan, EQ.spiritStones]);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(8);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.id)).toEqual([SONG_OF_RENEWAL]);
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(p.cp).toBe(1);
  });

  it('every ploy and equipment option has an aiHints value, and every datacard a role', () => {
    const hints = exoditeDragonMasters.aiHints!;
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) expect(hints.ployValue![p.id]).toBeGreaterThan(0);
    for (const e of DATA.equipment) expect(hints.equipmentValue![e.id]).toBeGreaterThan(0);
    for (const c of DATA.datacards) expect(hints.roles![c.id]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('the fifteen Upgrade rules, sliced out of Mercurial Speed', () => {
  it('slices five upgrades per MOUNTED datacard, each keeping its printed rule and dropping the flavour', () => {
    expect([...CLANBLADE_UPGRADES, ...LEYSTALKER_UPGRADES, ...STONESINGER_UPGRADES]).toHaveLength(15);
    const whole = ruleText(RULE.speed);
    for (const name of [...CLANBLADE_UPGRADES, ...LEYSTALKER_UPGRADES, ...STONESINGER_UPGRADES] as Upgrade[]) {
      expect(UPGRADE_TEXT[name].length).toBeGreaterThan(40);
      expect(whole).toContain(UPGRADE_TEXT[name]);
      // The flavour paragraph is dropped: no upgrade text starts with prose about dragons.
      expect(UPGRADE_TEXT[name]).not.toContain('The mythic weapons after which moonblades');
    }
    expect(UPGRADE_TEXT['SPECTRAL NIMBUS']).toBe(
      'Once per turning point, when this operative is fighting or retaliating, after your opponent rolls their attack dice, but before re-rolls, you can use this rule. If you do, your opponent cannot retain attack dice results of less than 6 as critical successes during that sequence (e.g. as a result of the Lethal, Rending or Severe weapon rules).',
    );
  });

  it('FATED SHOT’s printed effect list is present (not truncated at the colon)', () => {
    expect(UPGRADE_TEXT['FATED SHOT']).toContain('Enemy operatives cannot be obscured.');
    expect(UPGRADE_TEXT['FATED SHOT']).toContain('doesn’t prevent that enemy operative from being selected');
  });

  it('setUpgrades enforces "up to two DIFFERENT" rules from that operative’s own menu (D-017)', () => {
    const { state } = setup();
    const clan = clanbladeOf(state);
    expect(abilityText(CARD.clanblade, ABILITY.clanbladeUpgrades)).toContain('select up to two different');
    expect(setUpgrades(state, clan, ['MOONSONG CULL', 'BLADED STANCE']).ok).toBe(true);
    expect(upgradesOf(state, state.operatives[clan]!)).toEqual(['MOONSONG CULL', 'BLADED STANCE']);
    expect(setUpgrades(state, clan, ['MOONSONG CULL', 'MOONSONG CULL']).ok).toBe(false);
    expect(setUpgrades(state, clan, ['MOONSONG CULL', 'BLADED STANCE', 'SPECTRAL NIMBUS']).ok).toBe(false);
    expect(setUpgrades(state, clan, ['FATED SHOT']).reason).toContain('not one of this operative');
    // Nothing applies until it is called.
    const other = stonesingerOf(state);
    expect(hasUpgrade(state, state.operatives[other]!, 'EARTHEN WRATH')).toBe(false);
  });

  it('EARTHEN WRATH’s weapon is parsed out of the printed table, not retyped', () => {
    expect(EARTHEN_WRATH_WEAPON.name).toBe('Earthen Wrath');
    expect(EARTHEN_WRATH_WEAPON.profiles[0]).toMatchObject({ type: 'ranged', atk: 4, hit: 3, dmgN: 4, dmgC: 3 });
    expect(EARTHEN_WRATH_WEAPON.profiles[0]!.rules.map((r) => r.raw)).toEqual([
      'Devastating 2',
      'Saturate',
      'Earthen Wrath*',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('Drakesteed Agility', () => {
  it('MOUNTED operatives cannot Charge, Dash, Fall Back or Reposition; the DRAKOLITHE can', () => {
    expect(ruleText(RULE.agility)).toContain(
      'EXODITE DRAGON MASTER MOUNTED operatives cannot perform the Charge, Dash, Fall Back or Reposition actions',
    );
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const s = activate(ctx, state, clan);
    const banned = availableActions(ctx, s, s.operatives[clan]!).filter((a) =>
      ['Charge', 'Dash', 'Fall Back', 'Reposition'].includes(a.def.id),
    );
    expect(banned.length).toBe(4);
    expect(banned.every((a) => !a.ok)).toBe(true);
    const drak = drakolitheOf(state);
    const s2 = activate(ctx, state, drak);
    expect(availableActions(ctx, s2, s2.operatives[drak]!).find((a) => a.def.id === 'Reposition')!.ok).toBe(true);
  });

  it('SPRINT moves directly forwards, rounding the increment up, and is 0AP', () => {
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    const out = sprint(ctx, s, clan, { x: 8.5, y: 3 });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[clan]!.pos.x).toBeCloseTo(8.5);
    expect(s.operatives[clan]!.apSpent).toBe(0);
    // "increments are always rounded up to the nearest inch" — 4.5" costs 5".
    expect(sprintAllowance(s, s.operatives[clan]!)).toEqual({ forwards: 4, backwards: 3 });
    expect(getAction(SPRINT)!.ap).toBe(0);
  });

  it('SPRINT refuses more than 9" forwards or 3" backwards per activation', () => {
    expect(ruleText(RULE.agility)).toContain('It cannot move more than 9" forwards or 3" backwards per activation');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    expect(sprint(ctx, s, clan, { x: 14, y: 3 }).ok).toBe(false);
    expect(sprint(ctx, s, clan, { x: 13, y: 3 }).ok).toBe(true);
    // Backwards is capped at 3".
    expect(sprint(ctx, s, clan, { x: 0.5, y: 3 }).ok).toBe(false);
    expect(sprint(ctx, s, clan, { x: 2, y: 3 }).ok).toBe(true);
  });

  it('SPRINT may pivot up to 45° once, and refuses a larger turn', () => {
    expect(ruleText(RULE.agility)).toContain('you can pivot the active operative up to 45°');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    // 82° off the facing: more than the printed pivot allows.
    expect(sprint(ctx, s, clan, { x: 4.5, y: 6.5 }).ok).toBe(false);
    const out = sprint(ctx, s, clan, { x: 7, y: 6 });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[clan]!.rot).toBeCloseTo(45);
  });

  it('SPRINT cannot climb, but treats terrain under 2" tall as Accessible (+1")', () => {
    expect(ruleText(RULE.agility)).toContain('cannot climb or finish the move on Vantage terrain higher than 2"');
    const high = setup({ features: [vantagePlatform('high', 7, 1, 4, 4, 3)] });
    const clanA = clanbladeOf(high.state);
    const sA = activate(high.ctx, high.state, clanA);
    place(sA, clanA, 4, 3, 0);
    expect(sprint(high.ctx, sA, clanA, { x: 8, y: 3 }).reason).toContain('cannot climb');

    const low = setup({ features: [heavyBlock('low', 6, 2, 2, 2, 1.5)] });
    const clanB = clanbladeOf(low.state);
    let sB = activate(low.ctx, low.state, clanB);
    place(sB, clanB, 4, 3, 0);
    const out = sprint(low.ctx, sB, clanB, { x: 10, y: 3 });
    expect(out.ok).toBe(true);
    sB = out.state;
    // 6" moved, +1" because it crossed the sub-2" piece as Accessible terrain.
    expect(sprintAllowance(sB, sB.operatives[clanB]!).forwards).toBe(2);
  });

  it('SPRINT is treated as Reposition, or as Charge when it ends within control range', () => {
    expect(ruleText(RULE.agility)).toContain(
      'this action is treated as the Reposition action, or the Charge action if the active operative ends the action within control range of an enemy operative',
    );
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 4, 3, 0);
    place(state, foe, 20, 3);
    let s = activate(ctx, state, clan);
    s = sprint(ctx, s, clan, { x: 9, y: 3 }).state;
    expect(s.operatives[clan]!.actionsThisActivation).toContain('Reposition');
    expect(s.operatives[clan]!.actionsThisActivation).toContain(SPRINT);

    const b = setup();
    const clan2 = clanbladeOf(b.state);
    const foe2 = b.state.teams.p2.operativeIds[0]!;
    isolate(b.state, [clan2, foe2]);
    place(b.state, clan2, 4, 3, 0);
    place(b.state, foe2, 10, 3);
    let s2 = activate(b.ctx, b.state, clan2);
    s2 = sprint(b.ctx, s2, clan2, { x: 7, y: 3 }).state;
    expect(s2.operatives[clan2]!.actionsThisActivation).toContain('Charge');
  });

  it('SPRINT is capped at 12" per turning point across both activations', () => {
    expect(ruleText(RULE.agility)).toContain('it cannot move more than 12" per turning point');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    s = sprint(ctx, s, clan, { x: 13, y: 3 }).state; // 9"
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    expect(s.operatives[clan]!.ready).toBe(true); // Draconic Cavalry Tactics
    s = activate(ctx, s, clan);
    expect(sprintAllowance(s, s.operatives[clan]!).forwards).toBe(3);
    expect(sprint(ctx, s, clan, { x: 17, y: 3 }).ok).toBe(false);
    expect(sprint(ctx, s, clan, { x: 16, y: 3 }).ok).toBe(true);
  });

  it('TURN pivots up to 45° for 1AP, is treated as the Dash action, and needs an explicit pivot', () => {
    expect(ruleText(RULE.agility)).toContain('Pivot the active operative up to 45°');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    // `src/ai/legal.ts` probes unique actions with no data, which must not burn 1AP.
    expect(act(ctx, s, clan, TURN, {}).ok).toBe(false);
    expect(act(ctx, s, clan, TURN, { data: { pivotDeg: 60 } }).ok).toBe(false);
    const out = act(ctx, s, clan, TURN, { data: { pivotDeg: 45 } });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[clan]!.rot).toBeCloseTo(45);
    expect(s.operatives[clan]!.apSpent).toBe(1);
    expect(s.operatives[clan]!.actionsThisActivation).toContain('Dash');
  });
});

// ---------------------------------------------------------------------------
describe('Draconic Cavalry Tactics', () => {
  it('a MOUNTED operative is activated twice per turning point and is only then expended', () => {
    expect(ruleText(RULE.cavalry)).toContain(
      'is activated twice per turning point (it’s only expended after the second activation)',
    );
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    expect(s.operatives[clan]!.ready).toBe(true);
    expect(s.operatives[clan]!.expended).toBe(false);
    s = activate(ctx, s, clan);
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    expect(s.operatives[clan]!.ready).toBe(false);
    expect(s.operatives[clan]!.expended).toBe(true);
    // A DRAKOLITHE is not MOUNTED: one activation.
    const drak = drakolitheOf(s);
    let t = activate(ctx, s, drak);
    t = reduce(t, { t: 'EndActivation', operativeId: drak }, ctx).state;
    expect(t.operatives[drak]!.expended).toBe(true);
  });

  it('caps a MOUNTED operative at 3AP per activation and its APL stat per turning point', () => {
    expect(ruleText(RULE.cavalry)).toContain(
      'You cannot spend more than 3AP for it per activation, or more than its APL stat per turning point',
    );
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    s.operatives[clan]!.apSpent = 3;
    const blocked = availableActions(ctx, s, s.operatives[clan]!).find((a) => a.def.id === TURN)!;
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('3AP');
    // Second activation: the APL 4 turning-point budget has 1AP left after a 3AP first one.
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    s = activate(ctx, s, clan);
    expect(availableActions(ctx, s, s.operatives[clan]!).find((a) => a.def.id === TURN)!.ok).toBe(true);
    s.operatives[clan]!.apSpent = 1;
    const capped = availableActions(ctx, s, s.operatives[clan]!).find((a) => a.def.id === TURN)!;
    expect(capped.ok).toBe(false);
    expect(capped.reason).toContain('APL stat');
  });

  it('a MOUNTED operative cannot be in cover from terrain under 2" tall, but Heavy terrain 3" tall still covers it', () => {
    expect(ruleText(RULE.cavalry)).toContain(
      'cannot be in cover from or obscured by Light terrain, terrain parts less than 2" tall or terrain that’s not wholly intervening',
    );
    const rifle = profileOf(CARD.clanblade, 'Solar carbine');
    const cover = (z1: number): boolean => {
      const { ctx, state } = setup({ features: [coverPiece('screen', 14, 3, 1, 4, z1)] });
      const clan = clanbladeOf(state);
      const foe = state.teams.p2.operativeIds[0]!;
      isolate(state, [clan, foe]);
      place(state, clan, 13, 5, 90); // long axis along y, so its base stops 0.17" short
      place(state, foe, 22, 5);
      return checkTarget(ctx, state, state.operatives[foe]!, state.operatives[clan]!, rifle, []).inCover;
    };
    // A 3"-tall wholly-intervening Heavy piece still covers it; the same piece 1.5" tall does not.
    expect(cover(3)).toBe(true);
    expect(cover(1.5)).toBe(false);
  });

  it('Fight (Cavalry Reach) reaches an enemy the ordinary Fight cannot, and stands down when it can', () => {
    expect(ruleText(RULE.cavalry)).toContain(
      'the distance requirements of its control range can be changed to 1" horizontally and 4" vertically',
    );
    const { ctx, state } = setup({ features: [curtain('screen', 7.6, 2, 0.2, 4)] });
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 6, 4, 0);
    place(state, foe, 8.6, 4);
    const s = activate(ctx, state, clan);
    // The curtain denies the core control range (which needs visibility), so the ordinary
    // Fight is illegal and the widened one applies.
    expect(getAction('Fight')!.check(ctx, s, s.operatives[clan]!, { targetId: foe }).ok).toBe(false);
    const reach = getAction(FIGHT_REACH)!;
    expect(reach.check(ctx, s, s.operatives[clan]!, { targetId: foe }).ok).toBe(true);
    // "…4" vertically" is a limit, not a licence.
    s.operatives[foe]!.z = 5;
    expect(reach.check(ctx, s, s.operatives[clan]!, { targetId: foe }).ok).toBe(false);
    // Once the ordinary Fight is legal, the widened action stands down.
    s.operatives[foe]!.z = 0;
    s.terrainState['screen.body'] = { removed: true };
    delete ctx.terrainCache;
    expect(getAction('Fight')!.check(ctx, s, s.operatives[clan]!, { targetId: foe }).ok).toBe(true);
    expect(reach.check(ctx, s, s.operatives[clan]!, { targetId: foe }).ok).toBe(false);
  });

  it('REMINDER-ONLY: the reserve deployment clause has no engine state to hold it', () => {
    // "Each friendly EXODITE DRAGON MASTER MOUNTED operative thereafter must be set up in
    //  reserve: place it to one side instead of in the killzone." There is no off-killzone
    //  reserve state (an operative is either deployed or `removed`) and no decision channel at
    //  deployment, so no handler is registered — see the module notes.
    expect(ruleText(RULE.cavalry)).toContain('must be set up in reserve: place it to one side instead of in the killzone');
    expect(ruleText(RULE.cavalry)).toContain('In the first Firefight phase');
  });
});

// ---------------------------------------------------------------------------
describe('Mercurial Speed', () => {
  it('starts the battle with SPEED 3- and is set by the distance the Sprint moved', () => {
    expect(ruleText(RULE.speed)).toContain('it starts the battle with SPEED 3-');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    expect(speedOf(state, state.operatives[clan]!)).toBe('low');
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    s = sprint(ctx, s, clan, { x: 8, y: 3 }).state; // 4"
    expect(speedOf(s, s.operatives[clan]!)).toBe('mid');

    const b = setup();
    const clan2 = clanbladeOf(b.state);
    let s2 = activate(b.ctx, b.state, clan2);
    place(s2, clan2, 4, 3, 0);
    s2 = sprint(b.ctx, s2, clan2, { x: 11, y: 3 }).state; // 7"
    expect(speedOf(s2, s2.operatives[clan2]!)).toBe('high');
  });

  it('a backwards Sprint, and ending an activation without one, leave SPEED 3-', () => {
    expect(ruleText(RULE.speed)).toContain('It ends its activation without performing the Sprint action');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 8, 3, 0);
    setSpeed(s, s.operatives[clan]!, 'high');
    s = sprint(ctx, s, clan, { x: 6, y: 3 }).state; // 2" backwards
    expect(speedOf(s, s.operatives[clan]!)).toBe('low');

    setSpeed(s, s.operatives[clan]!, 'high');
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    s = activate(ctx, s, clan);
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    expect(baseSpeedOf(s, s.operatives[clan]!)).toBe('low');
  });

  it('SPEED 4+ retains a defence dice as a normal success without rolling it; SPEED 7+ as a critical', () => {
    expect(ruleText(RULE.speed)).toContain(
      'you can retain one of your defence dice as a normal success without rolling it; if it has SPEED 7+, you can retain one as a critical success instead',
    );
    for (const [speed, want] of [
      ['mid', 'normal'],
      ['high', 'crit'],
    ] as const) {
      const { ctx, state } = setup({ script: [6, 6, 6, 6, 1, 1, 1, 1, 1, 1] });
      const clan = clanbladeOf(state);
      const { id: foe, weapon: gun } = shooter(ctx, state);
      isolate(state, [clan, foe]);
      place(state, clan, 12, 5, 0);
      place(state, foe, 20, 5);
      setSpeed(state, state.operatives[clan]!, speed);
      const s = activate(ctx, state, foe);
      const out = act(ctx, s, foe, 'Shoot', { weaponName: gun, targetId: clan });
      expect(out.ok).toBe(true);
      const resolved = resolveUntil(ctx, out.state, defenceRolled);
      const seq = resolved.sequence as ShootSequence | null;
      const auto = (seq?.defence.dice ?? []).filter((d) => !d.rolled && d.note?.startsWith('Mercurial Speed'));
      expect(auto).toHaveLength(1);
      expect(auto[0]!.state).toBe(want);
    }
  });

  it('the three SPEED levels are distinct, so SPEED 7+ does not satisfy a "SPEED 4+" rule', () => {
    // SINUOUS FLUX prints "SPEED 4+ or SPEED 7+"; WIND-SWIFT PRECISION prints only "SPEED 4+".
    expect(ruleText(SP.sinuousFlux)).toContain('SPEED 4+ or SPEED 7+');
    expect(ruleText(SP.windSwift)).toContain('if it has SPEED 4+, its ranged weapons have the Balanced weapon rule');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    state.teams.p1.gambitsUsedTP.push(SP.windSwift);
    const profile = profileOf(CARD.clanblade, 'Solar carbine');
    setSpeed(state, state.operatives[clan]!, 'mid');
    expect(
      effectiveRules(ctx, state, profile, { operative: state.operatives[clan]!, weaponName: 'Solar carbine' }).map((r) => r.id),
    ).toContain('Balanced');
    setSpeed(state, state.operatives[clan]!, 'high');
    expect(
      effectiveRules(ctx, state, profile, { operative: state.operatives[clan]!, weaponName: 'Solar carbine' }).map((r) => r.id),
    ).not.toContain('Balanced');
    expect(SPEED_LABEL).toEqual({ low: 'SPEED 3-', mid: 'SPEED 4+', high: 'SPEED 7+' });
  });
});

// ---------------------------------------------------------------------------
describe('datacard abilities', () => {
  it('Scaleshield worsens Piercing by 1 when no attack dice were retained as critical successes', () => {
    expect(abilityText(CARD.clanblade, ABILITY.scaleshield)).toContain('worsen the x of the Piercing weapon rule by 1');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 12, 5, 0);
    place(state, foe, 20, 5);
    const profile = { ...profileOf(CARD.clanblade, 'Solar carbine'), rules: [{ id: 'Piercing' as const, x: 2, raw: 'Piercing 2' }] };
    const seq: ShootSequence = {
      kind: 'shoot',
      step: 'rollDefence',
      attackerId: foe,
      targetId: clan,
      queue: [],
      resolvedTargets: [],
      weaponName: 'x',
      secondary: false,
      pointBlank: false,
      inCover: false,
      obscured: false,
      coverChoiceMade: true,
      vantageAccurate: 0,
      vantageImprovedCover: false,
      attack: { dice: [{ id: 1, value: 4, state: 'normal', rolled: true }], nextId: 2 },
      defence: { dice: [], nextId: 1 },
      usedRerolls: [],
      usedRetention: [],
      damage: 0,
      useCounted: false,
      attacker: 'p2',
      defender: 'p1',
      free: false,
    };
    state.sequence = seq;
    const rules = () =>
      effectiveRules(ctx, state, profile, {
        operative: state.operatives[foe]!,
        target: state.operatives[clan]!,
        weaponName: 'x',
      });
    expect(rules().find((r) => r.id === 'Piercing')?.x).toBe(1);
    // "Note that Piercing 1 would therefore be ignored."
    profile.rules = [{ id: 'Piercing' as const, x: 1, raw: 'Piercing 1' }];
    expect(rules().some((r) => r.id === 'Piercing')).toBe(false);
    // A retained critical success switches it off.
    profile.rules = [{ id: 'Piercing' as const, x: 2, raw: 'Piercing 2' }];
    seq.attack.dice[0]!.state = 'crit';
    expect(countCrits(seq.attack)).toBe(1);
    expect(rules().find((r) => r.id === 'Piercing')?.x).toBe(2);
  });

  it('Aimed refuses the long rifle after moving more than 3", and never prevents the Guard action', () => {
    expect(abilityText(CARD.leystalker, ABILITY.aimed)).toContain(
      'This weapon rule has no effect on preventing the Guard action',
    );
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [ley, foe]);
    place(state, ley, 6, 5, 0);
    place(state, foe, 20, 5);
    let s = activate(ctx, state, ley);
    const shootParams = { weaponName: 'Long rifle', profileName: 'stationary', targetId: foe };
    expect(getAction('Shoot')!.check(ctx, s, s.operatives[ley]!, shootParams).ok).toBe(true);
    s = sprint(ctx, s, ley, { x: 11, y: 5 }).state; // 5" > 3"
    const refused = getAction('Shoot')!.check(ctx, s, s.operatives[ley]!, shootParams);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('Aimed');
    // The mobile profile carries no Aimed and is still usable.
    expect(
      getAction('Shoot')!.check(ctx, s, s.operatives[ley]!, { ...shootParams, profileName: 'mobile' }).ok,
    ).toBe(true);
  });

  it('Aimed caps the Sprint at 3" once the long rifle has been used this activation', () => {
    // "…and it cannot move more than 3" during an activation in which it used this weapon."
    // The Sprint owns its own allowance, so the cap is the ledger the shot already spent.
    expect(abilityText(CARD.leystalker, ABILITY.aimed)).toContain('it cannot move more than 3" during an activation');
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [ley, foe]);
    place(state, ley, 6, 5, 0);
    place(state, foe, 22, 5);
    let s = activate(ctx, state, ley);
    s = sprint(ctx, s, ley, { x: 9, y: 5 }).state; // exactly 3" — still legal for Aimed
    expect(sprintAllowance(s, s.operatives[ley]!).forwards).toBe(6);
    const shot = act(ctx, s, ley, 'Shoot', { weaponName: 'Long rifle', profileName: 'stationary', targetId: foe });
    expect(shot.ok).toBe(true);
    s = shot.state;
    // Having used it, the 3" of Sprint it has already spent is all it gets this activation.
    expect(sprintAllowance(s, s.operatives[ley]!)).toEqual({ forwards: 0, backwards: 0 });
  });

  it('Implacable Darkscale cancels the injured Hit change on the drakesteed fangs & talons only', () => {
    expect(abilityText(CARD.leystalker, ABILITY.implacable)).toContain(
      'ignore any changes to this operative’s drakesteed fangs & talons weapon’s Hit stat from being injured',
    );
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [ley, foe]);
    place(state, ley, 12, 5, 0);
    place(state, foe, 13, 5);
    state.operatives[ley]!.wounds = 5; // injured (24 wounds)
    const fangs = profileOf(CARD.leystalker, 'Drakesteed fangs & talons');
    const blade = profileOf(CARD.leystalker, 'Hunting blade');
    startFight(ctx, state, state.operatives[ley]!, 'Drakesteed fangs & talons', undefined, foe);
    expect(hitOf(ctx, state, state.operatives[ley]!, fangs)).toBe(fangs.hit);
    state.sequence = null;
    startFight(ctx, state, state.operatives[ley]!, 'Hunting blade', undefined, foe);
    expect(hitOf(ctx, state, state.operatives[ley]!, blade)).toBe(blade.hit + 1);
  });

  it('Preternatural Evasion sets the DRAKOLITHE’s SPEED from the distance to its previous location', () => {
    expect(abilityText(CARD.drakolithe, ABILITY.preternatural)).toContain(
      'if it ends that action more than 2" from its previous location, it has SPEED 4+',
    );
    const { ctx, state } = setup();
    const drak = drakolitheOf(state);
    isolate(state, [drak]);
    place(state, drak, 6, 5);
    let s = activate(ctx, state, drak);
    s = act(ctx, s, drak, 'Reposition', { path: { points: [{ x: 10, y: 5 }] } }).state; // 4" > 2"
    expect(speedOf(s, s.operatives[drak]!)).toBe('mid');
    s = act(ctx, s, drak, 'Dash', { path: { points: [{ x: 13, y: 5 }] } }).state;
    // "…if it ends more than 5" from its previous location, it has SPEED 7+ instead."
    const b = setup();
    const drak2 = drakolitheOf(b.state);
    isolate(b.state, [drak2]);
    place(b.state, drak2, 4, 5);
    let s2 = activate(b.ctx, b.state, drak2);
    s2 = act(b.ctx, s2, drak2, 'Reposition', { path: { points: [{ x: 11, y: 5 }] } }).state; // 7"
    expect(speedOf(s2, s2.operatives[drak2]!)).toBe('high');
    s2 = reduce(s2, { t: 'EndActivation', operativeId: drak2 }, b.ctx).state;
    // "Whenever this operative ends its activation, if it didn't gain SPEED 4+ or SPEED 7+
    //  during that activation, it has SPEED 3-." — it did, so it keeps it.
    expect(speedOf(s2, s2.operatives[drak2]!)).toBe('high');
    s2.operatives[drak2]!.ready = true;
    s2.operatives[drak2]!.expended = false;
    let s3 = activate(b.ctx, s2, drak2);
    s3 = reduce(s3, { t: 'EndActivation', operativeId: drak2 }, b.ctx).state;
    expect(speedOf(s3, s3.operatives[drak2]!)).toBe('low');
  });

  it('Beast restricts the DRAKOLITHE to its printed action list and needs a live LEYSTALKER for markers', () => {
    expect(abilityText(CARD.drakolithe, ABILITY.beast)).toContain(
      'cannot perform any actions other than Charge, Dash, Fall Back, Fight, Guard, Pick Up Marker, Place Marker, Reposition and mission actions',
    );
    const { ctx, state } = setup();
    const drak = drakolitheOf(state);
    const s = activate(ctx, state, drak);
    const actions = availableActions(ctx, s, s.operatives[drak]!);
    expect(actions.find((a) => a.def.id === 'Shoot')!.ok).toBe(false);
    expect(actions.find((a) => a.def.id === 'Reposition')!.ok).toBe(true);
    // "…unless there's a friendly LEYSTALKER operative that isn't incapacitated."
    const ley = leystalkerOf(s);
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[drak]!, action: 'Pick Up Marker', allowed: true })
        .allowed,
    ).toBe(true);
    s.operatives[ley]!.removed = true;
    expect(
      ctx.hooks.emit('canPerformAction', s, { state: s, operative: s.operatives[drak]!, action: 'Pick Up Marker', allowed: true })
        .allowed,
    ).toBe(false);
  });

  it('REMINDER-ONLY: Beast’s "cannot use any weapons that aren’t on its datacard" has no seam', () => {
    // `weaponsOf` appends `grantedWeapons` AFTER the `availableWeapons` hook, so a team cannot
    // remove a weapon another rule granted — the Sanctifiers CHERUB gap. Nothing grants the
    // DRAKOLITHE a weapon today, so the clause currently bites on nothing.
    expect(abilityText(CARD.drakolithe, ABILITY.beast)).toContain('It cannot use any weapons that aren’t on its datacard');
  });
});

// ---------------------------------------------------------------------------
describe('unique actions', () => {
  it('SONG OF RENEWAL heals 2D3, refuses inside control range and only once per turning point', () => {
    const printed = DATA.datacards.find((c) => c.id === CARD.stonesinger)!.uniqueActions[0]!;
    expect(printed.ap).toBe(1);
    expect(printed.text).toContain('That operative regains up to 2D3 lost wounds');
    const { ctx, state } = setup({ script: [3, 3, 3, 3, 3, 3] });
    const song = getAction(SONG_OF_RENEWAL)!;
    const stone = stonesingerOf(state);
    const clan = clanbladeOf(state);
    isolate(state, [stone, clan]);
    place(state, stone, 10, 5, 0);
    place(state, clan, 14, 5, 0);
    state.operatives[clan]!.wounds = 10;
    let s = activate(ctx, state, stone);
    const out = act(ctx, s, stone, SONG_OF_RENEWAL, { targetOperativeId: clan });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[clan]!.wounds).toBeGreaterThan(10);
    expect(song.check(ctx, s, s.operatives[stone]!, { targetOperativeId: clan }).reason).toContain('once per turning point');
    // "…cannot perform this action while within control range of an enemy operative"
    const b = setup();
    const stone2 = stonesingerOf(b.state);
    const foe = b.state.teams.p2.operativeIds[0]!;
    isolate(b.state, [stone2, foe]);
    place(b.state, stone2, 10, 5, 0);
    place(b.state, foe, 11.5, 5);
    expect(song.check(b.ctx, b.state, b.state.operatives[stone2]!, {}).reason).toContain('control range');
  });

  it('SONG OF RENEWAL’s alternative heals every friendly EXODITE DRAGON MASTER operative D3', () => {
    const printed = DATA.datacards.find((c) => c.id === CARD.stonesinger)!.uniqueActions[0]!;
    expect(printed.text).toContain('each friendly EXODITE DRAGON MASTER operative can regain up to D3 lost wounds');
    const { ctx, state } = setup({ script: [5, 5, 5, 5, 5, 5, 5, 5] });
    const stone = stonesingerOf(state);
    for (const id of state.teams.p1.operativeIds) state.operatives[id]!.wounds = 3;
    let s = activate(ctx, state, stone);
    s = act(ctx, s, stone, SONG_OF_RENEWAL, { choice: 'all' }).state;
    for (const id of s.teams.p1.operativeIds) expect(s.operatives[id]!.wounds).toBeGreaterThan(3);
  });

  it('WAILS OF THE WORLD slows non-MOUNTED enemies by 2" and leaves MOUNTED ones alone', () => {
    expect(UPGRADE_TEXT['WAILS OF THE WORLD']).toContain('MOUNTED operatives are unaffected');
    const { ctx, state } = setup({ script: [3, 3, 3, 3, 3, 3, 3, 3] });
    const stone = stonesingerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [stone, foe]);
    place(state, stone, 10, 5, 0);
    place(state, foe, 16, 5);
    setUpgrades(state, stone, ['WAILS OF THE WORLD']);
    const before = moveOf(ctx, state, state.operatives[foe]!);
    let s = activate(ctx, state, stone);
    const out = act(ctx, s, stone, ACT_WAILS, { targetOperativeId: foe });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(moveOf(ctx, s, s.operatives[foe]!)).toBe(before - 2);
    // A MOUNTED operative is unaffected by both halves.
    const mirror = setup({ mirror: true, script: [3, 3, 3, 3, 3, 3] });
    const stone2 = stonesingerOf(mirror.state);
    const foeM = opWith(mirror.state, 'p2', CARD.clanblade);
    isolate(mirror.state, [stone2, foeM]);
    place(mirror.state, stone2, 10, 5, 0);
    place(mirror.state, foeM, 16, 5, 0);
    setUpgrades(mirror.state, stone2, ['WAILS OF THE WORLD']);
    const woundsBefore = mirror.state.operatives[foeM]!.wounds;
    let m = activate(mirror.ctx, mirror.state, stone2);
    m = act(mirror.ctx, m, stone2, ACT_WAILS, { targetOperativeId: foeM }).state;
    expect(moveOf(mirror.ctx, m, m.operatives[foeM]!)).toBe(12);
    expect(m.operatives[foeM]!.wounds).toBe(woundsBefore);
  });

  it('CLEANSING OF THE PALE MOON removes one thing the opponent applied, more than once per turning point', () => {
    expect(UPGRADE_TEXT['CLEANSING OF THE PALE MOON']).toContain('it can perform this action more than once per turning point');
    const { ctx, state } = setup();
    const stone = stonesingerOf(state);
    const clan = clanbladeOf(state);
    isolate(state, [stone, clan]);
    place(state, stone, 10, 5, 0);
    place(state, clan, 14, 5, 0);
    setUpgrades(state, stone, ['CLEANSING OF THE PALE MOON']);
    state.effects.push({
      id: 'foo',
      rule: 'someEnemyToken',
      source: { kind: 'ability', id: 'x' },
      operativeId: clan,
      player: 'p2',
      expiry: { kind: 'endOfBattle' },
    });
    let s = activate(ctx, state, stone);
    const out = act(ctx, s, stone, ACT_CLEANSING, { targetOperativeId: clan });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.effects.some((e) => e.rule === 'someEnemyToken')).toBe(false);
    // A -1 APL is the other printed example. Action restrictions still forbid a repeat within
    // one activation, so this is the STONESINGER's second activation of the turning point.
    s.operatives[clan]!.aplMods.push(-1);
    s = reduce(s, { t: 'EndActivation', operativeId: stone }, ctx).state;
    s = activate(ctx, s, stone);
    const again = act(ctx, s, stone, ACT_CLEANSING, { targetOperativeId: clan });
    expect(again.ok).toBe(true);
    expect(again.state.operatives[clan]!.aplMods).toEqual([]);
  });

  it('WIND’S GRACE raises the selected operative’s SPEED by one level', () => {
    expect(UPGRADE_TEXT[ACT_WINDS_GRACE]).toContain('that selected operative’s SPEED is one higher');
    const { ctx, state } = setup();
    const stone = stonesingerOf(state);
    const clan = clanbladeOf(state);
    isolate(state, [stone, clan]);
    place(state, stone, 10, 5, 0);
    place(state, clan, 14, 5, 0);
    setUpgrades(state, stone, [ACT_WINDS_GRACE]);
    let s = activate(ctx, state, stone);
    s = act(ctx, s, stone, ACT_WINDS_GRACE, { targetOperativeId: clan }).state;
    expect(speedOf(s, s.operatives[clan]!)).toBe('mid');
    setSpeed(s, s.operatives[clan]!, 'mid');
    expect(speedOf(s, s.operatives[clan]!)).toBe('high');
  });

  it('SOW THE SEEDS contests an objective marker with an APL of 1 from anywhere', () => {
    expect(UPGRADE_TEXT['SOW THE SEEDS']).toContain('treated as contesting that marker with an APL of 1');
    const { ctx, state } = setup();
    const stone = stonesingerOf(state);
    setUpgrades(state, stone, ['SOW THE SEEDS']);
    state.markers['obj'] = { id: 'obj', kind: 'objective', diameterMm: 40, pos: { x: 15, y: 11 }, z: 0, flags: {} };
    isolate(state, []);
    expect(markerController(ctx, state, state.markers['obj']!)).toBe(null);
    sowTheSeeds(state, stone, 'obj');
    expect(markerController(ctx, state, state.markers['obj']!)).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
describe('Clanblade Upgrades', () => {
  it('SPECTRAL NIMBUS strips Lethal / Rending / Severe from the enemy’s melee weapon, once per turning point', () => {
    const { ctx, state } = setup({ mirror: true });
    const clan = clanbladeOf(state);
    const foe = opWith(state, 'p2', CARD.clanblade);
    isolate(state, [clan, foe]);
    place(state, clan, 10, 5, 0);
    place(state, foe, 12, 5, 0);
    setUpgrades(state, clan, ['SPECTRAL NIMBUS']);
    startFight(ctx, state, state.operatives[foe]!, 'Moonblades', undefined, clan);
    (state.sequence as FightSequence).step = 'rollAttack';
    const moonblades = profileOf(CARD.clanblade, 'Moonblades');
    const rules = effectiveRules(ctx, state, moonblades, {
      operative: state.operatives[foe]!,
      target: state.operatives[clan]!,
      weaponName: 'Moonblades',
    });
    expect(moonblades.rules.map((r) => r.id)).toContain('Lethal');
    expect(rules.map((r) => r.id)).not.toContain('Lethal');
  });

  it('FOCUSED REFLECTION reflects one damage per critical success used to block, within 6"', () => {
    expect(UPGRADE_TEXT['FOCUSED REFLECTION']).toContain('inflict 1 damage on that enemy operative for each critical success');
    const { ctx, state } = setup({ script: [6, 4, 4, 4, 6, 6, 6] });
    const clan = clanbladeOf(state);
    const { id: foe, weapon: gun } = shooter(ctx, state);
    isolate(state, [clan, foe]);
    place(state, clan, 12, 5, 0);
    place(state, foe, 16, 5);
    setUpgrades(state, clan, ['FOCUSED REFLECTION']);
    const before = state.operatives[foe]!.wounds;
    let s = activate(ctx, state, foe);
    const shot = act(ctx, s, foe, 'Shoot', { weaponName: gun, targetId: clan });
    expect(shot.ok).toBe(true);
    s = shot.state;
    let guard = 0;
    while (s.pending.length > 0 && guard++ < 20) {
      const d = s.pending[0]!;
      const pick = d.options.find((o) => !o.disabled)!;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: pick.id, ...(pick.data ? { data: pick.data } : {}) }, ctx).state;
    }
    expect(s.operatives[foe]!.wounds).toBeLessThan(before);
  });

  it('SPEARTIP OF THE CLAN adds 1 damage to the first normal strike at SPEED 4+', () => {
    expect(UPGRADE_TEXT['SPEARTIP OF THE CLAN']).toContain(
      'If it has SPEED 4+, the first time you strike with a normal success during that sequence, inflict 1 additional damage',
    );
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 10, 5, 0);
    place(state, foe, 12, 5);
    setUpgrades(state, clan, ['SPEARTIP OF THE CLAN']);
    setSpeed(state, state.operatives[clan]!, 'mid');
    startFight(ctx, state, state.operatives[clan]!, 'Moonblades', undefined, foe);
    const seq = state.sequence as FightSequence;
    seq.attackerPool.dice.push({ id: 1, value: 4, state: 'normal', rolled: true });
    seq.step = 'resolve';
    const before = state.operatives[foe]!.wounds;
    advanceFight(ctx, state);
    let s = state;
    const d = s.pending[0]!;
    const strike = d.options.find((o) => o.id.startsWith('strike:'))!;
    s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: strike.id, ...(strike.data ? { data: strike.data } : {}) }, ctx).state;
    // Moonblades Normal Dmg 4, plus the printed additional 1.
    expect(before - s.operatives[foe]!.wounds).toBe(profileOf(CARD.clanblade, 'Moonblades').dmgN + 1);
  });

  it('BLADED STANCE resolves the CLANBLADE’s success first; "must be used to block" is unenforceable', () => {
    expect(UPGRADE_TEXT['BLADED STANCE']).toContain('you can resolve one of your successes before the normal order');
    const { ctx, state } = setup({ script: Array.from({ length: 24 }, () => 6) });
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 10, 5, 0);
    place(state, foe, 12, 5);
    setUpgrades(state, clan, ['BLADED STANCE']);
    const foeMelee = weaponsOf(ctx, state, state.operatives[foe]!, 'melee')[0]!.name;
    const started = startFight(ctx, state, state.operatives[foe]!, foeMelee, undefined, clan);
    expect(started.ok).toBe(true);
    const seq = state.sequence as FightSequence;
    seq.defenderWeapon = 'Moonblades';
    advanceFight(ctx, state);
    expect(seq.turn).toBe('defender'); // the retaliating CLANBLADE resolves first
    // The engine builds the strike/block options, so "that success must be used to block"
    // cannot be forced — the strike options are still offered.
    const resolved = resolveUntil(ctx, state, (x) => x.pending[0]?.kind === 'strikeOrBlock');
    const decision = resolved.pending[0]!;
    expect(decision.kind).toBe('strikeOrBlock');
    expect(decision.options.filter((o) => o.id.startsWith('strike:')).length).toBeGreaterThan(0);
  });

  it('MOONSONG CULL only unlocks its free Sprint after a forward Sprint and a Fight kill', () => {
    expect(UPGRADE_TEXT['MOONSONG CULL']).toContain('it can immediately perform a free Sprint action forwards');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 8, 5, 0);
    place(state, foe, 18, 5);
    setUpgrades(state, clan, ['MOONSONG CULL']);
    let s = activate(ctx, state, clan);
    const free = getAction(SPRINT_MOONSONG)!;
    expect(free.check(ctx, s, s.operatives[clan]!, {}).reason).toContain('has not performed the Sprint action');
    const out = sprint(ctx, s, clan, { x: 12.5, y: 5 });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(free.check(ctx, s, s.operatives[clan]!, {}).reason).toContain('incapacitated an enemy operative');
    // Kill it inside a fight, then the window opens once it is no longer engaged.
    s.operatives[foe]!.pos = { x: 14.5, y: 5 };
    const fight = startFight(ctx, s, s.operatives[clan]!, 'Moonblades', undefined, foe);
    expect(fight.ok).toBe(true);
    inflictDamage(ctx, s, s.operatives[foe]!, 99, 'attack');
    s.operatives[clan]!.actionsThisActivation.push('Fight');
    s.operatives[foe]!.removed = true;
    s.sequence = null;
    expect(free.check(ctx, s, s.operatives[clan]!, {}).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Leystalker Upgrades', () => {
  it('NOMAD EXECUTIONER lets the Sprint continue after a Shoot with the remaining move distance', () => {
    expect(UPGRADE_TEXT['NOMAD EXECUTIONER']).toContain('it can perform the Shoot action during that action');
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [ley, foe]);
    place(state, ley, 6, 5, 0);
    place(state, foe, 22, 5);
    setUpgrades(state, ley, ['NOMAD EXECUTIONER']);
    let s = activate(ctx, state, ley);
    const cont = getAction(SPRINT_NOMAD)!;
    expect(cont.check(ctx, s, s.operatives[ley]!, {}).ok).toBe(false);
    s = sprint(ctx, s, ley, { x: 9, y: 5 }).state; // 3"
    // "…for that Shoot action, this operative's SPEED is whatever it had before beginning the
    //  Sprint action."
    expect(speedOf(s, s.operatives[ley]!)).toBe('low');
    s = act(ctx, s, ley, 'Shoot', { weaponName: 'Long rifle', profileName: 'mobile', targetId: foe }).state;
    let guard = 0;
    while (s.pending.length > 0 && guard++ < 20) {
      const d = s.pending[0]!;
      const pick = d.options.find((o) => !o.disabled)!;
      s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: pick.id, ...(pick.data ? { data: pick.data } : {}) }, ctx).state;
    }
    expect(cont.check(ctx, s, s.operatives[ley]!, { targetPos: { x: 13, y: 5 } }).ok).toBe(true);
    s = act(ctx, s, ley, SPRINT_NOMAD, { targetPos: { x: 13, y: 5 } }).state;
    expect(s.operatives[ley]!.pos.x).toBeCloseTo(13);
  });

  it('ELUSIVE PHANTASM takes a free ≤3" Sprint at the end of the Firefight phase without changing SPEED', () => {
    expect(UPGRADE_TEXT['ELUSIVE PHANTASM']).toContain('it cannot move more than 3" during that action and its SPEED remains the same');
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    isolate(state, [ley]);
    place(state, ley, 6, 5, 0);
    setUpgrades(state, ley, ['ELUSIVE PHANTASM']);
    setSpeed(state, state.operatives[ley]!, 'high');
    endTurningPoint(ctx, state);
    expect(state.operatives[ley]!.pos.x).toBeCloseTo(9);
    expect(baseSpeedOf(state, state.operatives[ley]!)).toBe('high');
  });

  it('FATED SHOT clears obscured once per turning point when a long rifle profile is selected', () => {
    expect(UPGRADE_TEXT['FATED SHOT']).toContain('Once per turning point');
    const { ctx, state } = setup({ features: [coverPiece('screen', 15, 2, 1, 6, 4)] });
    const ley = leystalkerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [ley, foe]);
    place(state, ley, 8, 5, 0);
    place(state, foe, 22, 5);
    // Without the rule the shot is obscured by the intervening Heavy piece.
    const plain = checkTarget(
      ctx,
      state,
      state.operatives[ley]!,
      state.operatives[foe]!,
      profileOf(CARD.leystalker, 'Long rifle', 'mobile'),
      [],
    );
    expect(plain.obscured).toBe(true);
    setUpgrades(state, ley, ['FATED SHOT']);
    let s = activate(ctx, state, ley);
    const out = act(ctx, s, ley, 'Shoot', { weaponName: 'Long rifle', profileName: 'mobile', targetId: foe });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.log.some((l) => l.text.includes('Fated Shot'))).toBe(true);
    expect(s.log.some((l) => l.text.includes('cannot be obscured'))).toBe(true);
  });

  it('NEXUS SENTINEL grants the Guard action off a close-quarters map, once per turning point, at SPEED 3-', () => {
    expect(UPGRADE_TEXT['NEXUS SENTINEL']).toContain('can perform the Guard action during its activation regardless of the killzone');
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    isolate(state, [ley]);
    place(state, ley, 8, 5, 0);
    setUpgrades(state, ley, ['NEXUS SENTINEL']);
    expect(state.map.closeQuarters).toBe(false);
    let s = activate(ctx, state, ley);
    expect(availableActions(ctx, s, s.operatives[ley]!).find((a) => a.def.id === 'Guard')).toBeUndefined();
    const out = act(ctx, s, ley, GUARD_NEXUS, {});
    expect(out.ok).toBe(true);
    s = out.state;
    // The reducer clears `onGuard` after any action whose id is not literally `Guard`, so the
    // granted Guard re-arms itself at the end of the activation.
    s = reduce(s, { t: 'EndActivation', operativeId: ley }, ctx).state;
    expect(s.operatives[ley]!.onGuard).toBe(true);
    s = activate(ctx, s, ley);
    setSpeed(s, s.operatives[ley]!, 'mid');
    expect(getAction(GUARD_NEXUS)!.check(ctx, s, s.operatives[ley]!, {}).reason).toContain('SPEED 3-');
  });

  it('NEXUS SENTINEL does not worsen the Hit stat for a point-blank shot', () => {
    expect(UPGRADE_TEXT['NEXUS SENTINEL']).toContain('don’t worsen the Hit stat of its weapons as a result of performing a point-blank shot');
    const { ctx, state } = setup();
    const ley = leystalkerOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [ley, foe]);
    place(state, ley, 10, 5, 0);
    place(state, foe, 11.5, 5);
    setUpgrades(state, ley, ['NEXUS SENTINEL']);
    const mobile = profileOf(CARD.leystalker, 'Long rifle', 'mobile');
    state.sequence = {
      kind: 'shoot',
      step: 'rollAttack',
      attackerId: ley,
      targetId: foe,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Long rifle',
      profileName: 'mobile',
      secondary: false,
      pointBlank: true,
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
    // The point-blank penalty is passed as `extraHitMod = -1`; the ability cancels it.
    expect(hitOf(ctx, state, state.operatives[ley]!, mobile, -1)).toBe(mobile.hit);
  });

  it('GLOAMING MANTLE auto-retains beyond 8", or upgrades a cover save to a critical success', () => {
    expect(UPGRADE_TEXT['GLOAMING MANTLE']).toContain('from more than 8" away');
    const { ctx, state } = setup({ script: [1, 1, 1, 1, 1, 1, 1, 1] });
    const ley = leystalkerOf(state);
    const { id: foe, weapon: gun } = shooter(ctx, state);
    isolate(state, [ley, foe]);
    place(state, ley, 6, 5, 0);
    place(state, foe, 24, 5);
    setUpgrades(state, ley, ['GLOAMING MANTLE']);
    let s = activate(ctx, state, foe);
    const shot = act(ctx, s, foe, 'Shoot', { weaponName: gun, targetId: ley });
    expect(shot.ok).toBe(true);
    s = resolveUntil(ctx, shot.state, defenceRolled);
    const seq = s.sequence as ShootSequence | null;
    const auto = (seq?.defence.dice ?? []).filter((d) => !d.rolled && d.note === 'Gloaming Mantle');
    expect(auto.length).toBe(1);
    expect(auto[0]!.state).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
describe('ploys', () => {
  it('DRACONIC FURY grants Balanced at SPEED 4+ and Ceaseless at SPEED 7+', () => {
    expect(ruleText(SP.draconicFury)).toContain('If it has SPEED 7+, its melee weapons have the Ceaseless weapon rule');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    state.teams.p1.gambitsUsedTP.push(SP.draconicFury);
    const moonblades = profileOf(CARD.clanblade, 'Moonblades');
    const rules = () =>
      effectiveRules(ctx, state, moonblades, { operative: state.operatives[clan]!, weaponName: 'Moonblades' }).map((r) => r.id);
    expect(rules()).not.toContain('Balanced');
    setSpeed(state, state.operatives[clan]!, 'mid');
    expect(rules()).toContain('Balanced');
    setSpeed(state, state.operatives[clan]!, 'high');
    expect(rules()).toContain('Ceaseless');
  });

  it('SINUOUS FLUX removes every attack re-roll from a shot beyond 6" at SPEED 4+ or 7+', () => {
    expect(ruleText(SP.sinuousFlux)).toContain('your opponent cannot re-roll their attack dice');
    const { ctx, state } = setup({ script: [1, 1, 1, 1, 1, 1, 1, 1] });
    const clan = clanbladeOf(state);
    const { id: foe, weapon: gun } = shooter(ctx, state);
    isolate(state, [clan, foe]);
    place(state, clan, 8, 5, 0);
    place(state, foe, 22, 5);
    state.teams.p1.gambitsUsedTP.push(SP.sinuousFlux);
    setSpeed(state, state.operatives[clan]!, 'high');
    state.teams.p2.cp = 3;
    let s = activate(ctx, state, foe);
    const shot = act(ctx, s, foe, 'Shoot', { weaponName: gun, targetId: clan });
    expect(shot.ok).toBe(true);
    s = shot.state;
    expect(s.pending.filter((d) => d.kind === 'reroll' && d.who === 'p2')).toHaveLength(0);
  });

  it('RIDE THEM DOWN inflicts 1 damage after a 4" Sprint, and D3 for a CLANBLADE', () => {
    expect(ruleText(SP.rideThemDown)).toContain('you can inflict D3 damage on one enemy operative within its control range instead');
    const { ctx, state } = setup({ script: [2, 2, 2, 2] });
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 6, 5, 0);
    place(state, foe, 12, 5);
    state.teams.p1.gambitsUsedTP.push(SP.rideThemDown);
    const before = state.operatives[foe]!.wounds;
    let s = activate(ctx, state, clan);
    s = sprint(ctx, s, clan, { x: 9.8, y: 5 }).state; // touching the foe's base, not inside it
    expect(before - s.operatives[foe]!.wounds).toBeGreaterThanOrEqual(1);
  });

  it('SURVIVALIST SPIRIT ignores the injured change to weapon stats until the next activation', () => {
    expect(ruleText(FP.survivalistSpirit)).toContain('you can ignore any changes to that operative’s weapon stats from being injured');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    isolate(state, [clan]);
    place(state, clan, 8, 5, 0);
    state.operatives[clan]!.wounds = 5;
    const moonblades = profileOf(CARD.clanblade, 'Moonblades');
    let s = activate(ctx, state, clan);
    expect(hitOf(ctx, s, s.operatives[clan]!, moonblades)).toBe(moonblades.hit + 1);
    s.teams.p1.cp = 3;
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.survivalistSpirit }, ctx).state;
    expect(hitOf(ctx, s, s.operatives[clan]!, moonblades)).toBe(moonblades.hit);
    // The Move change is not a weapon stat, so it stays.
    expect(moveOf(ctx, s, s.operatives[clan]!)).toBe(10);
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    s = activate(ctx, s, clan);
    expect(hitOf(ctx, s, s.operatives[clan]!, moonblades)).toBe(moonblades.hit + 1);
  });

  it('LEAP replaces the Sprint move with a ≤1" set-up, 3" of allowance and SPEED 3-', () => {
    expect(ruleText(FP.leap)).toContain('treated as having moved 3" for the purposes of its movement allowance and has SPEED 3-');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    isolate(state, [clan]);
    place(state, clan, 8, 5, 0);
    setSpeed(state, state.operatives[clan]!, 'high');
    state.teams.p1.cp = 3;
    let s = activate(ctx, state, clan);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.leap }, ctx).state;
    const out = sprint(ctx, s, clan, { x: 20, y: 5 });
    expect(out.ok).toBe(true);
    s = out.state;
    expect(s.operatives[clan]!.pos.x).toBeLessThanOrEqual(9 + 1e-6);
    expect(speedOf(s, s.operatives[clan]!)).toBe('low');
    expect(sprintAllowance(s, s.operatives[clan]!).forwards).toBe(6);
  });

  it('FERAL HUNGER grants "re-roll any of your attack dice" against a wounded enemy', () => {
    expect(ruleText(FP.feralHunger)).toContain('You can re-roll any of your attack dice');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 10, 5, 0);
    place(state, foe, 12, 5);
    state.teams.p1.ploysUsedTP.push(FP.feralHunger);
    const fangs = profileOf(CARD.clanblade, 'Drakesteed fangs & talons');
    const rules = () =>
      effectiveRules(ctx, state, fangs, {
        operative: state.operatives[clan]!,
        target: state.operatives[foe]!,
        weaponName: 'Drakesteed fangs & talons',
      }).map((r) => r.id);
    expect(rules()).not.toContain('Relentless'); // not wounded yet
    state.operatives[foe]!.wounds -= 1;
    expect(rules()).toContain('Relentless');
  });

  it('RIDING MASTERY lets the Sprint continue after a marker action', () => {
    expect(ruleText(FP.ridingMastery)).toContain('any remaining move distance it had from that Sprint action can be used after it does so');
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    isolate(state, [clan]);
    place(state, clan, 6, 5, 0);
    state.teams.p1.cp = 3;
    state.markers['obj'] = {
      id: 'obj',
      kind: 'objective',
      diameterMm: 40,
      pos: { x: 10, y: 5 },
      z: 0,
      flags: { pickUpAllowed: true },
    };
    let s = activate(ctx, state, clan);
    s = reduce(s, { t: 'UsePloy', player: 'p1', ployId: FP.ridingMastery }, ctx).state;
    s = sprint(ctx, s, clan, { x: 9, y: 5 }).state;
    const cont = getAction(SPRINT_RIDING)!;
    expect(cont.check(ctx, s, s.operatives[clan]!, {}).reason).toContain('marker or mission action');
    s = act(ctx, s, clan, 'Pick Up Marker', { markerId: 'obj' }).state;
    expect(cont.check(ctx, s, s.operatives[clan]!, { targetPos: { x: 12, y: 5 } }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('faction equipment', () => {
  it('DRAGONSCALE MESH retains one normal defence success as a critical success, once per turning point', () => {
    expect(ruleText(EQ.dragonscaleMesh)).toContain('you can retain one of your normal successes as a critical success instead');
    const { ctx, state } = setup({ equipment: [EQ.dragonscaleMesh], script: [1, 1, 1, 1, 4, 4, 4, 4] });
    const clan = clanbladeOf(state);
    const { id: foe, weapon: gun } = shooter(ctx, state);
    isolate(state, [clan, foe]);
    place(state, clan, 12, 5, 0);
    place(state, foe, 20, 5);
    let s = activate(ctx, state, foe);
    const shot = act(ctx, s, foe, 'Shoot', { weaponName: gun, targetId: clan });
    expect(shot.ok).toBe(true);
    s = resolveUntil(ctx, shot.state, (x) => x.log.some((l) => l.text.includes('Dragonscale Mesh')));
    expect(s.log.some((l) => l.text.includes('Dragonscale Mesh'))).toBe(true);
  });

  it('CLAN TALISMANS discards a fail to retain another as a normal success — shooting and fighting alike', () => {
    expect(ruleText(EQ.clanTalismans)).toContain('if you roll two or more fails, you can discard one of them to retain another as a normal success instead');
    const { ctx, state } = setup({ equipment: [EQ.clanTalismans], script: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 12, 5, 0);
    place(state, foe, 18, 5);
    let s = activate(ctx, state, clan);
    const shot = act(ctx, s, clan, 'Shoot', { weaponName: 'Solar carbine', targetId: foe });
    expect(shot.ok).toBe(true);
    s = resolveUntil(ctx, shot.state, (x) => x.log.some((l) => l.text.includes('Clan Talismans')));
    expect(s.log.some((l) => l.text.includes('Clan Talismans'))).toBe(true);
  });

  it('LILEATHAN CRYSTAL MATRICES gives the solar carbine Piercing 1 until the end of the activation', () => {
    expect(ruleText(EQ.lileathan)).toContain('that weapon has the Piercing 1 weapon rule');
    const { ctx, state } = setup({ equipment: [EQ.lileathan], script: [1, 1, 1, 1, 1, 1, 1, 1] });
    const clan = clanbladeOf(state);
    const foe = state.teams.p2.operativeIds[0]!;
    isolate(state, [clan, foe]);
    place(state, clan, 12, 5, 0);
    place(state, foe, 18, 5);
    let s = activate(ctx, state, clan);
    const shot = act(ctx, s, clan, 'Shoot', { weaponName: 'Solar carbine', targetId: foe });
    expect(shot.ok).toBe(true);
    s = shot.state;
    const carbine = profileOf(CARD.clanblade, 'Solar carbine');
    expect(
      effectiveRules(ctx, s, carbine, { operative: s.operatives[clan]!, weaponName: 'Solar carbine' }).map((r) => r.id),
    ).toContain('Piercing');
  });

  it('SPIRIT STONES gains 1CP whenever a MOUNTED operative is incapacitated', () => {
    expect(ruleText(EQ.spiritStones)).toContain('you gain 1CP');
    const { ctx, state } = setup({ equipment: [EQ.spiritStones] });
    const clan = clanbladeOf(state);
    const drak = drakolitheOf(state);
    const cp = state.teams.p1.cp;
    inflictDamage(ctx, state, state.operatives[drak]!, 99, 'other');
    expect(state.teams.p1.cp).toBe(cp); // the DRAKOLITHE is not MOUNTED
    inflictDamage(ctx, state, state.operatives[clan]!, 99, 'other');
    expect(state.teams.p1.cp).toBe(cp + 1);
  });
});

// ---------------------------------------------------------------------------
describe('EARTHEN WRATH', () => {
  it('grants the ranged weapon only while the upgrade is selected, with Lethal 5+ against a target in cover', () => {
    expect(UPGRADE_TEXT['EARTHEN WRATH']).toContain('If the target is in cover, this weapon has the Lethal 5+ weapon rule');
    const { ctx, state } = setup();
    const stone = stonesingerOf(state);
    const names = () =>
      ctx.hooks
        .emit('availableWeapons', state, {
          state,
          operative: state.operatives[stone]!,
          weapons: ctx.datacards.get(state.operatives[stone]!.datacardId)!.weapons.map((w) => w.name),
        })
        .weapons.concat(
          ((state.operatives[stone] as OperativeState & { grantedWeapons?: { name: string }[] }).grantedWeapons ?? []).map(
            (w) => w.name,
          ),
        );
    expect(names()).not.toContain('Earthen Wrath');
    setUpgrades(state, stone, ['EARTHEN WRATH']);
    expect(names()).toContain('Earthen Wrath');
    const profile = EARTHEN_WRATH_WEAPON.profiles[0]!;
    state.sequence = {
      kind: 'shoot',
      step: 'rollAttack',
      attackerId: stone,
      targetId: state.teams.p2.operativeIds[0]!,
      queue: [],
      resolvedTargets: [],
      weaponName: 'Earthen Wrath',
      secondary: false,
      pointBlank: false,
      inCover: true,
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
    expect(
      effectiveRules(ctx, state, profile, { operative: state.operatives[stone]!, weaponName: 'Earthen Wrath' }).map((r) => r.id),
    ).toContain('Lethal');
  });
});

// ---------------------------------------------------------------------------
describe('turning-point upkeep', () => {
  it('the Ready step resets the Sprint allowance, the activation count and the AP budget', () => {
    const { ctx, state } = setup();
    const clan = clanbladeOf(state);
    let s = activate(ctx, state, clan);
    place(s, clan, 4, 3, 0);
    s = sprint(ctx, s, clan, { x: 13, y: 3 }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    s = activate(ctx, s, clan);
    s = reduce(s, { t: 'EndActivation', operativeId: clan }, ctx).state;
    expect(s.operatives[clan]!.expended).toBe(true);
    s.turningPoint = 2;
    readyStep(ctx, s);
    expect(sprintAllowance(s, s.operatives[clan]!)).toEqual({ forwards: 9, backwards: 3 });
    let t = activate(ctx, s, clan);
    t = reduce(t, { t: 'EndActivation', operativeId: clan }, ctx).state;
    expect(t.operatives[clan]!.ready).toBe(true); // two activations again
  });
});

// ---------------------------------------------------------------------------
describe('bot-vs-bot soak (zero rejected intents)', () => {
  const maps = (): string[] => {
    const all = realMaps();
    const volkus = all.find((m) => m.killzone === 'volkus');
    const gallowdark = all.find((m) => m.killzone === 'gallowdark');
    return [volkus?.id ?? all[0]!.id, gallowdark?.id ?? all[1]!.id];
  };
  const pairings: { foe: typeof kasrkin; label: string }[] = [
    { foe: kasrkin, label: 'kasrkin' },
    // A mirror runs the double activation, the Sprint ledger and the MOUNTED cover/obscured
    // denial for BOTH players at once.
    { foe: exoditeDragonMasters, label: 'exodite-dragon-masters' },
  ];
  for (const [n, mapId] of maps().entries()) {
    const { foe, label } = pairings[n % pairings.length]!;
    it(`exodite-dragon-masters vs ${label} on ${mapId}`, () => {
      clearDeployCache();
      clearMoveCache();
      const seed = 4100 + n;
      const ctx = teamContext([exoditeDragonMasters, foe], { seed });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const result = playGame({
        ctx,
        map,
        seed,
        rosters: {
          p1: {
            teamId: exoditeDragonMasters.id,
            operatives: defaultRoster(exoditeDragonMasters.data).map((p) => ({ datacardId: p.datacardId })),
            equipment: exoditeDragonMasters.equipment.slice(0, 2).map((e) => e.id),
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
    });
  }
});
