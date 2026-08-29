/**
 * CANOPTEK CIRCLE. Every test quotes the printed rule it pins, read out of
 * `data/teams/canoptek-circle.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/canoptek-circle/
 */
import { describe, expect, it } from 'vitest';
import { actionTargetKind, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { gambitOptions, readyStep } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules } from '../../src/core/sequences/shoot.ts';
import {
  aliveOperatives,
  apBudgetOf,
  aplOf,
  freeApOf,
  inflictDamage,
  markerController,
  moveOf,
} from '../../src/core/state.ts';
import { moveBudget } from '../../src/core/movement.ts';
import { buildTerrainIndex } from '../../src/core/terrain.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import rawJson from '../../data/teams/canoptek-circle.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ACT,
  BREACH_REPOSITION,
  CARD,
  EQ,
  FP,
  MOVE_NODES_GAMBIT,
  NODE_OPERATE_HATCH,
  PLACE_NODES_GAMBIT,
  REMINDER_ONLY,
  RULE_MATRIX,
  SCUTTLING_GAMBIT,
  SP,
  canoptekCircle,
  disturbancePoint,
  matrixIntervenes,
  matrixShape,
  obeliskMarkers,
  placeObeliskNodes,
  withinMatrix,
} from '../../src/teams/canoptek-circle/index.ts';
import { act, activate, battle, mapById, opWith, settle, teamContext } from './harness.ts';
import { heavyBlock, testMap } from '../fixtures.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';

const DATA = teamData('canoptek-circle');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;
const EPS = 1e-6;

const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionOf = (cardId: string, actionId: string) =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!;
const profileOf = (cardId: string, weapon: string, profile?: string): WeaponProfile => {
  const w = DATA.datacards.find((c) => c.id === cardId)!.weapons.find((x) => x.name === weapon)!;
  return w.profiles.find((p) => (p.name ?? '') === (profile ?? '')) ?? w.profiles[0]!;
};

interface SetupOpts {
  equipment?: string[];
  script?: number[];
  seed?: number;
  map?: KillzoneMap;
}

function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([canoptekCircle], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const map = opts.map ?? testMap();
  ctx.maps.set(map.id, map);
  const state = battle({
    ctx,
    map,
    p1: { module: canoptekCircle, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: canoptekCircle },
  });
  return { ctx, state };
}

const place = (state: GameState, id: string, x: number, y: number): OperativeState => {
  const op = state.operatives[id]!;
  op.pos = { x, y };
  op.z = 0;
  return op;
};

/** Move everything else far away so a distance rule is tested in isolation. */
function isolate(state: GameState, keep: string[]): void {
  let n = 0;
  for (const op of aliveOperatives(state)) {
    if (keep.includes(op.id)) continue;
    op.pos = { x: 1.4 + (n % 3) * 2.4, y: 18 + Math.floor(n / 3) * 2.4 };
    n++;
  }
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

/** The nth operative with a datacard — the two TOMB CRAWLERs carry different weapon options. */
function opNth(state: GameState, player: PlayerId, datacardId: string, n: number): string {
  const ids = state.teams[player].operativeIds.filter((x) => state.operatives[x]!.datacardId === datacardId);
  return ids[n]!;
}

/** Three nodes in a row 4" apart — a matrix along y = 11 from x = 7 to x = 15. */
function line(state: GameState, player: PlayerId = 'p1'): void {
  placeObeliskNodes(state, player, [
    { x: 7, y: 11 },
    { x: 11, y: 11 },
    { x: 15, y: 11 },
  ]);
}

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
}

function shootSeq(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'rollDefence',
    queue: [],
    resolvedTargets: [],
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
    free: false,
    ...over,
  };
}

function fightSeqOf(
  over: Partial<FightSequence> &
    Pick<FightSequence, 'attackerId' | 'defenderId' | 'attacker' | 'defender' | 'attackerWeapon'>,
): FightSequence {
  return {
    kind: 'fight',
    step: 'resolve',
    defenderCanRetaliate: true,
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    free: false,
    hatchway: false,
    ...over,
  };
}

function attackCtx(
  attacker: OperativeState,
  defender: OperativeState,
  profile: WeaponProfile,
  weaponName: string,
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

const useGambit = (ctx: GameContext, state: GameState, player: PlayerId, gambitId: string, data?: Record<string, unknown>) =>
  reduce(state, { t: 'UseGambit', player, gambitId, ...(data ? { data } : {}) }, ctx).state;

const usePloy = (ctx: GameContext, state: GameState, player: PlayerId, ployId: string, data?: Record<string, unknown>) =>
  reduce(state, { t: 'UsePloy', player, ployId, ...(data ? { data } : {}) }, ctx);

// ===========================================================================
describe('CANOPTEK CIRCLE data (pinned against data/teams/canoptek-circle.json)', () => {
  it('has 5 datacards; the GEOMANCER is the APL 3 / W14 LEADER on a 50mm base', () => {
    expect(DATA.datacards).toHaveLength(5);
    for (const c of DATA.datacards) {
      expect(c.keywords).toContain('CANOPTEK CIRCLE');
      expect(c.keywords).toContain('NECRON');
    }
    expect(DATA.datacards.find((c) => c.id === CARD.geomancer)).toMatchObject({
      apl: 3,
      move: 6,
      save: 3,
      wounds: 14,
      base: { shape: 'round', mm: 50 },
    });
    expect(DATA.datacards.find((c) => c.id === CARD.geomancer)!.keywords).toEqual([
      'CANOPTEK CIRCLE',
      'NECRON',
      'LEADER',
      'CRYPTEK',
      'GEOMANCER',
    ]);
  });

  it('the CANOPTEK TOMB CRAWLER is W18, M5", Sv3+, APL 2 on a 50mm base', () => {
    // docs/TEAM-DATA.md §7 records the previous app carrying 21 wounds for this datacard; the
    // April '26 card in the JSON says 18, and every rule that reads a wound total reads this.
    expect(DATA.datacards.find((c) => c.id === CARD.tombCrawler)).toMatchObject({
      apl: 2,
      move: 5,
      save: 3,
      wounds: 18,
      base: { shape: 'round', mm: 50 },
    });
  });

  it('the three MACROCYTEs are APL 2 / M7" / Sv4+ / W7 on 28mm bases and all carry CANOPTEK', () => {
    for (const id of [CARD.accelerator, CARD.reanimator, CARD.warrior]) {
      expect(DATA.datacards.find((c) => c.id === id)).toMatchObject({
        apl: 2,
        move: 7,
        save: 4,
        wounds: 7,
        base: { shape: 'round', mm: 28 },
      });
      expect(DATA.datacards.find((c) => c.id === id)!.keywords).toContain('CANOPTEK');
      expect(DATA.datacards.find((c) => c.id === id)!.keywords).toContain('MACROCYTE');
    }
    // The GEOMANCER is a CRYPTEK, not a CANOPTEK — which is what makes it a legal SACRIFICIAL
    // THRALL protectee but never the thrall.
    expect(DATA.datacards.find((c) => c.id === CARD.geomancer)!.keywords).not.toContain('CANOPTEK');
    expect(DATA.datacards.find((c) => c.id === CARD.tombCrawler)!.keywords).toContain('CANOPTEK');
  });

  it('exposes 1 faction rule, 4+4 ploys, 4 equipment options, 8 abilities and 6 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Obelisk Node Matrix']);
    expect(canoptekCircle.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(canoptekCircle.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(canoptekCircle.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(8);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(6);
    // Every unique action is priced at 1AP on the page, and the scraper flagged nothing.
    expect(new Set(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.ap))).toEqual(new Set([1]));
    expect(NOTES).toEqual([]);
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(CARD.geomancer, 'Tremorglaive', 'part matter')).toMatchObject({ atk: 4, hit: 3, dmgN: 4, dmgC: 5 });
    expect(profileOf(CARD.geomancer, 'Tremorglaive', 'part matter').rules.map((r) => r.raw)).toEqual([
      'Piercing 1',
      'Piercing Crits 2',
    ]);
    expect(profileOf(CARD.geomancer, 'Tremorglaive', 'quake').rules.map((r) => r.raw)).toEqual([
      'Blast 2"',
      'Seek Light',
      'Stun',
    ]);
    expect(profileOf(CARD.geomancer, 'Tremorglaive', 'sweep')).toMatchObject({ type: 'melee', atk: 4, hit: 4, dmgN: 4, dmgC: 5 });
    expect(profileOf(CARD.tombCrawler, 'Twin gauss reapers', 'focused')).toMatchObject({ atk: 5, hit: 4, dmgN: 4, dmgC: 5 });
    expect(profileOf(CARD.tombCrawler, 'Twin gauss reapers', 'sweeping').rules.map((r) => r.raw)).toEqual([
      'Piercing 1',
      'Severe',
      'Torrent 1"',
    ]);
    expect(profileOf(CARD.tombCrawler, 'Transdimensional isolator')).toMatchObject({ atk: 5, hit: 4, dmgN: 5, dmgC: 6 });
    expect(profileOf(CARD.tombCrawler, 'Claws')).toMatchObject({ atk: 4, hit: 4, dmgN: 4, dmgC: 4 });
    expect(profileOf(CARD.warrior, 'Gauss scalpel').rules.map((r) => r.raw)).toEqual(['Piercing 1']);
    expect(
      DATA.datacards.find((c) => c.id === CARD.warrior)!.weapons.find((w) => w.name === 'Tesla caster')!.profiles.map((p) => p.name),
    ).toEqual(['focused', 'living lightning']);
    expect(profileOf(CARD.accelerator, 'Spark').rules.map((r) => r.raw)).toEqual(['Range 4"', 'Piercing 1']);
    expect(profileOf(CARD.reanimator, 'Atomiser beam').rules.map((r) => r.raw)).toEqual(['Range 6"', 'Lethal 5+']);
  });

  it('the one rare weapon rule is Dimensional Banishment, and it resolves to the TOMB CRAWLER’s own ability (D-033)', () => {
    expect(DATA.rareWeaponRules).toEqual(['DimensionalBanishment']);
    expect(profileOf(CARD.tombCrawler, 'Transdimensional isolator').rules.map((r) => r.raw)).toEqual([
      'Dimensional Banishment*',
    ]);
    expect(rareWeaponRuleText('DimensionalBanishment', 'canoptek-circle')).toBe(
      abilityText(CARD.tombCrawler, AB.dimensionalBanishment),
    );
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('until the end of the activation/counteraction.')).toBe(true);
    // The raw committed bytes still carry the overrun — the data problem, not the module.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect((rawJson as { firefightPloys: { text: string }[] }).firefightPloys[3]!.text).toContain('Faction Equipment');
  });

  it('no ploy has "1CP" glued onto its name or id, and no printed effect list is truncated', () => {
    for (const p of [...DATA.strategyPloys, ...DATA.firefightPloys]) {
      expect(p.name).not.toMatch(/\d\s*CP$/i);
      expect(p.id).not.toMatch(/\dcp$/i);
      expect(p.cp).toBe(1);
    }
    const bodies = [
      ...DATA.factionRules,
      ...DATA.strategyPloys,
      ...DATA.firefightPloys,
      ...DATA.equipment,
    ].map((r) => r.text);
    for (const c of DATA.datacards) for (const a of [...c.abilities, ...c.uniqueActions]) bodies.push(a.text);
    for (const t of bodies) expect(t.trim()).not.toMatch(/(following effects|If you do):$/i);
  });

  it('DATA PROBLEM (confirmed again): uniqueActions[].keywords is not emitted, though two actions print "SUPPORT."', () => {
    const raw = rawJson as { datacards: { uniqueActions: { name: string; text: string; keywords?: string[] }[] }[] };
    const all = raw.datacards.flatMap((c) => c.uniqueActions);
    expect(all.filter((a) => a.text.startsWith('SUPPORT.')).map((a) => a.name).sort()).toEqual([
      'CANOPTEK CONTROL',
      'MOLECULAR BREACH',
    ]);
    expect(all.every((a) => a.keywords === undefined || a.keywords.length === 0)).toBe(true);
  });

  it('every datacard has a selection row, and the markerGuide names the Obelisk Node marker', () => {
    const rows = [...DATA.selection.list, ...DATA.selection.leaderList];
    for (const c of DATA.datacards) expect(rows.some((r) => r.datacardId === c.id)).toBe(true);
    expect(DATA.markerGuide).toContain('Obelisk Node marker');
    expect(DATA.markerGuide).toContain('Obelisk Node Matrix template');
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE selection', () => {
  it('prints exactly one constraint — the transdimensional isolator cap', () => {
    expect(DATA.selection.constraints).toEqual([{ kind: 'maxItem', item: 'transdimensional isolator', max: 1 }]);
    expect(DATA.selection.rawText).toContain('* Your kill team can only include up to one transdimensional isolator.');
  });

  it('defaultRoster is a legal 8-operative kill team that fields ALL FIVE datacards and one isolator', () => {
    const picks = defaultRoster(DATA);
    expect(picks).toHaveLength(8);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(new Set(picks.map((p) => p.datacardId))).toEqual(new Set(Object.values(CARD)));
    const weapons = validateRosterFor(DATA, picks).weapons.flat();
    expect(weapons.filter((w) => w.toLowerCase() === 'transdimensional isolator')).toHaveLength(1);
  });

  it('the shared validator ENFORCES the maxItem cap (D-036) — two isolators is illegal', () => {
    const picks = defaultRoster(DATA).map((p) =>
      p.datacardId === CARD.tombCrawler ? { ...p, loadoutIds: ['canoptek-circle.g2.opt2'] } : p,
    );
    const check = validateRosterFor(DATA, picks);
    expect(check.ok).toBe(false);
    expect(check.codes).toContain('maxItem');
  });
});

// ===========================================================================
describe('Obelisk Node Matrix — "Whenever one of your OBELISK NODE markers is within 6" horizontally of another of your OBELISK NODE markers, those markers and the area between them create an OBELISK NODE MATRIX above and below"', () => {
  it('the TP1 STRATEGIC GAMBIT places three markers wholly within your territory', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(PLACE_NODES_GAMBIT);
    const after = useGambit(ctx, state, 'p1', PLACE_NODES_GAMBIT);
    const markers = obeliskMarkers(after, 'p1');
    expect(markers).toHaveLength(3);
    for (const m of markers) {
      expect(m.diameterMm).toBe(20);
      // "wholly within your territory" — p1's territory is x <= 15 on the test map.
      expect(m.pos.x + 20 / 25.4 / 2).toBeLessThanOrEqual(15 + EPS);
    }
    // The default placement links every node, so a combined matrix always forms.
    expect(matrixShape(after, 'p1').hull).toBeDefined();
    // It costs no CP and cannot be taken twice.
    expect(after.teams.p1.cp).toBe(state.teams.p1.cp);
    expect(gambitOptions(ctx, after, 'p1').map((o) => o.id)).not.toContain(PLACE_NODES_GAMBIT);
  });

  it('the placement gambit is offered in the first turning point only; the 3" move gambit only after it', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(MOVE_NODES_GAMBIT);
    line(state);
    state.turningPoint = 2;
    const ids = gambitOptions(ctx, state, 'p1').map((o) => o.id);
    expect(ids).toContain(MOVE_NODES_GAMBIT);
    expect(ids).not.toContain(PLACE_NODES_GAMBIT);
  });

  it('"you can move each of your OBELISK NODE markers up to 3" horizontally" — and no further', () => {
    const { ctx, state } = setup();
    line(state);
    state.turningPoint = 2;
    const before = obeliskMarkers(state, 'p1').map((m) => ({ ...m.pos }));
    const after = useGambit(ctx, state, 'p1', MOVE_NODES_GAMBIT, {
      nodes: obeliskMarkers(state, 'p1').map((m) => ({ id: m.id, pos: { x: m.pos.x, y: m.pos.y + 10 } })),
    });
    obeliskMarkers(after, 'p1').forEach((m, i) => {
      const d = Math.hypot(m.pos.x - before[i]!.x, m.pos.y - before[i]!.y);
      expect(d).toBeCloseTo(3, 5);
    });
  });

  it('two nodes 4" apart make a matrix; an operative between them is within it and one 7" off is not', () => {
    const { ctx, state } = setup();
    placeObeliskNodes(state, 'p1', [
      { x: 8, y: 11 },
      { x: 12, y: 11 },
    ]);
    const T = hooksFor(ctx, 'p1');
    const w = place(state, opWith(state, 'p1', CARD.warrior), 10, 11);
    expect(withinMatrix(T, state, w)).toBe(true);
    place(state, w.id, 10, 18);
    expect(withinMatrix(T, state, w)).toBe(false);
  });

  it('nodes more than 6" apart create no matrix at all', () => {
    const { ctx, state } = setup();
    placeObeliskNodes(state, 'p1', [
      { x: 2, y: 2 },
      { x: 12, y: 2 },
      { x: 2, y: 20 },
    ]);
    expect(matrixShape(state, 'p1').pairs).toHaveLength(0);
    const T = hooksFor(ctx, 'p1');
    const w = place(state, opWith(state, 'p1', CARD.warrior), 7, 2);
    expect(withinMatrix(T, state, w)).toBe(false);
  });

  it('"If all three of your OBELISK NODE markers fulfil this, it creates a larger combined OBELISK NODE MATRIX" — the interior counts', () => {
    const { ctx, state } = setup();
    placeObeliskNodes(state, 'p1', [
      { x: 8, y: 8 },
      { x: 13, y: 8 },
      { x: 10.5, y: 12 },
    ]);
    const shape = matrixShape(state, 'p1');
    expect(shape.pairs).toHaveLength(3);
    expect(shape.hull).toBeDefined();
    const T = hooksFor(ctx, 'p1');
    // A point inside the triangle but off every node-to-node line.
    const w = place(state, opWith(state, 'p1', CARD.warrior), 10.5, 9.4);
    expect(withinMatrix(T, state, w)).toBe(true);
  });

  it('"above and below (in other words, their height in the killzone is irrelevant)"', () => {
    const { ctx, state } = setup();
    line(state);
    const T = hooksFor(ctx, 'p1');
    const w = place(state, opWith(state, 'p1', CARD.warrior), 11, 11);
    w.z = 4;
    for (const m of obeliskMarkers(state, 'p1')) m.z = 0;
    expect(withinMatrix(T, state, w)).toBe(true);
  });

  it('"Weapons on its datacard have the Accurate 1 weapon rule" — only inside the matrix, and never a granted weapon', () => {
    const { ctx, state } = setup();
    line(state);
    const inside = place(state, opWith(state, 'p1', CARD.warrior), 11, 11);
    const profile = profileOf(CARD.warrior, 'Gauss scalpel');
    const rules = effectiveRules(ctx, state, profile, { operative: inside, weaponName: 'Gauss scalpel' });
    expect(rules.some((r) => r.id === 'Accurate' && r.x === 1)).toBe(true);
    // A weapon that is not on the datacard (a granted grenade) gets nothing.
    const granted = effectiveRules(ctx, state, profile, { operative: inside, weaponName: 'Frag grenade' });
    expect(granted.some((r) => r.id === 'Accurate')).toBe(false);
    place(state, inside.id, 3, 20);
    expect(
      effectiveRules(ctx, state, profile, { operative: inside, weaponName: 'Gauss scalpel' }).some((r) => r.id === 'Accurate'),
    ).toBe(false);
  });

  it('"Add 1 to its APL stat (to a maximum of 3)" — a WARRIOR goes 2 → 3, the APL 3 GEOMANCER stays 3', () => {
    const { ctx, state } = setup();
    line(state);
    const w = place(state, opWith(state, 'p1', CARD.warrior), 11, 11);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 9, 11);
    expect(aplOf(ctx, state, w)).toBe(3);
    expect(aplOf(ctx, state, geo)).toBe(3);
    // …and a stunned GEOMANCER is lifted back to 3 rather than left at 2.
    geo.aplMods.push(-1);
    expect(aplOf(ctx, state, geo)).toBe(3);
    place(state, w.id, 3, 20);
    expect(aplOf(ctx, state, w)).toBe(2);
  });

  it('"Your OBELISK NODE markers control other markers within 1" of them that no enemy operatives contest"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    placeObeliskNodes(state, 'p1', [
      { x: 15, y: 11 },
      { x: 12, y: 11 },
    ]);
    const centre = state.markers['centre']!;
    expect(markerController(ctx, state, centre)).toBe('p1');
    // "…that no enemy operatives contest."
    place(state, opWith(state, 'p2', CARD.warrior), 15.9, 11);
    expect(markerController(ctx, state, centre)).not.toBe('p1');
  });

  it('"If more than one player would use their OBELISK NODE markers to control the same marker, no OBELISK NODE markers control it"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    placeObeliskNodes(state, 'p1', [
      { x: 15, y: 11 },
      { x: 12, y: 11 },
    ]);
    placeObeliskNodes(state, 'p2', [
      { x: 15, y: 11.2 },
      { x: 18, y: 11 },
    ]);
    expect(markerController(ctx, state, state.markers['centre']!)).toBeNull();
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE strategy ploys', () => {
  it('HYPERSHIELDING — "you can re-roll any of your defence dice results of one result" while within the matrix', () => {
    const { ctx, state } = setup();
    line(state);
    const target = place(state, opWith(state, 'p1', CARD.warrior), 11, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    const grants = (s: GameState) =>
      ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(shooter, target, profileOf(CARD.warrior, 'Gauss scalpel'), 'Gauss scalpel'),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls;
    expect(grants(state)).toHaveLength(0); // the gambit has not been used
    const after = useGambit(ctx, state, 'p1', SP.hypershielding);
    const offered = grants(after);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ mode: 'value', player: 'p1' });
  });

  it('HYPERSHIELDING also fires on the "if your OBELISK NODE MATRIX is intervening" branch', () => {
    const { ctx, state } = setup();
    placeObeliskNodes(state, 'p1', [
      { x: 15, y: 8 },
      { x: 15, y: 13 },
    ]);
    const target = place(state, opWith(state, 'p1', CARD.warrior), 22, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.warrior), 8, 11);
    expect(withinMatrix(hooksFor(ctx, 'p1'), state, target)).toBe(false);
    expect(matrixIntervenes(state, 'p1', shooter.pos, target.pos)).toBe(true);
    const after = useGambit(ctx, state, 'p1', SP.hypershielding);
    const grants = ctx.hooks.emit('onDefenceDice', after, {
      state: after,
      ctx: attackCtx(shooter, target, profileOf(CARD.warrior, 'Gauss scalpel'), 'Gauss scalpel'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    }).rerolls;
    expect(grants).toHaveLength(1);
  });

  it('CRYPTOGRAVITIC REPULSION — "the distance is treated as an additional 1"" for an enemy that could reach the matrix', () => {
    const { ctx, state } = setup();
    line(state);
    const enemy = place(state, opWith(state, 'p2', CARD.warrior), 18, 11);
    const friend = place(state, opWith(state, 'p1', CARD.warrior), 18, 14);
    const budget = (s: GameState, id: string): number =>
      moveBudget(ctx, s, s.operatives[id]!, { action: 'Reposition' });
    const base = moveOf(ctx, state, enemy);
    expect(budget(state, enemy.id)).toBe(base);
    const after = useGambit(ctx, state, 'p1', SP.cryptogravitic);
    expect(budget(after, enemy.id)).toBe(base - 1);
    // A friendly operative is never taxed…
    expect(budget(after, friend.id)).toBe(moveOf(ctx, after, after.operatives[friend.id]!));
    // …nor is an enemy that could not reach the matrix with this move.
    place(after, enemy.id, 28, 20);
    expect(budget(after, enemy.id)).toBe(base);
    // …nor one already inside it ("would move WITHIN").
    place(after, enemy.id, 11, 11);
    expect(budget(after, enemy.id)).toBe(base);
  });

  it('TRANSDYNAMIC AMPLIFICATION — "that friendly operative’s weapons have the Ceaseless weapon rule"', () => {
    const { ctx, state } = setup();
    line(state);
    const shooter = place(state, opWith(state, 'p1', CARD.warrior), 3, 3);
    const target = place(state, opWith(state, 'p2', CARD.warrior), 11, 11);
    const profile = profileOf(CARD.warrior, 'Gauss scalpel');
    const use = { operative: shooter, target, weaponName: 'Gauss scalpel' };
    expect(effectiveRules(ctx, state, profile, use).some((r) => r.id === 'Ceaseless')).toBe(false);
    const after = useGambit(ctx, state, 'p1', SP.transdynamic);
    const use2 = { operative: after.operatives[shooter.id]!, target: after.operatives[target.id]!, weaponName: 'Gauss scalpel' };
    expect(effectiveRules(ctx, after, profile, use2).some((r) => r.id === 'Ceaseless')).toBe(true);
    // Not when the target is outside the matrix and nothing intervenes (the shooter is at
    // y = 3 and the matrix lies along y = 11, so the line never crosses it).
    place(after, target.id, 27, 3);
    expect(effectiveRules(ctx, after, profile, use2).some((r) => r.id === 'Ceaseless')).toBe(false);
  });

  it('SOULDRAIN — "subtract 1 from both Dmg stats of that enemy operative’s melee weapons (to a minimum of 2)"', () => {
    const { ctx, state } = setup();
    line(state);
    const foe = place(state, opWith(state, 'p2', CARD.tombCrawler), 11, 11);
    const mine = place(state, opWith(state, 'p1', CARD.warrior), 11.9, 11);
    const after = useGambit(ctx, state, 'p1', SP.souldrain);
    after.sequence = fightSeqOf({
      attackerId: foe.id,
      defenderId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Claws',
    });
    // Claws are 4/4, so a normal strike lands 3 instead of 4.
    const before = mine.wounds;
    inflictDamage(ctx, after, mine, profileOf(CARD.tombCrawler, 'Claws').dmgN, 'attack');
    expect(before - mine.wounds).toBe(3);
  });

  it('SOULDRAIN never reduces a Dmg stat below 2', () => {
    const { ctx, state } = setup();
    line(state);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 11, 11);
    const mine = place(state, opWith(state, 'p1', CARD.warrior), 11.6, 11);
    const after = useGambit(ctx, state, 'p1', SP.souldrain);
    const profile = profileOf(CARD.warrior, 'Claws & tail');
    profile.dmgN = 2; // pinning the floor, not the printed profile
    after.sequence = fightSeqOf({
      attackerId: foe.id,
      defenderId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Claws & tail',
    });
    const before = mine.wounds;
    inflictDamage(ctx, after, mine, 2, 'attack');
    expect(before - mine.wounds).toBe(2);
    profile.dmgN = 3;
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE firefight ploys', () => {
  it('SHIELD FLARE — "ignore that inflicted damage" for one attack dice of Normal Dmg in a fight', () => {
    const { ctx, state } = setup();
    line(state);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 11, 11);
    const mine = place(state, opWith(state, 'p1', CARD.warrior), 11.6, 11);
    const out = usePloy(ctx, state, 'p1', FP.shieldFlare);
    expect(out.ok).toBe(true);
    const s = out.state;
    s.sequence = fightSeqOf({
      attackerId: foe.id,
      defenderId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Claws & tail',
    });
    const dmgN = profileOf(CARD.warrior, 'Claws & tail').dmgN;
    const before = mine.wounds;
    inflictDamage(ctx, s, mine, dmgN, 'attack');
    expect(mine.wounds).toBe(before); // "ignore that inflicted damage"
    // Once only — the ploy is spent by the first dice it saves.
    inflictDamage(ctx, s, mine, dmgN, 'attack');
    expect(before - mine.wounds).toBe(dmgN);
  });

  it('SHIELD FLARE removes exactly one attack dice’s worth from a shoot’s aggregated total', () => {
    const { ctx, state } = setup();
    line(state);
    const shooter = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    const mine = place(state, opWith(state, 'p1', CARD.warrior), 11, 11);
    const s = usePloy(ctx, state, 'p1', FP.shieldFlare).state;
    const profile = profileOf(CARD.warrior, 'Gauss scalpel');
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Gauss scalpel',
      step: 'resolve',
    });
    seq.attack = pool([6, 5], 4); // one crit + one normal, both unblocked
    s.sequence = seq;
    const before = mine.wounds;
    inflictDamage(ctx, s, mine, profile.dmgC + profile.dmgN, 'attack');
    expect(before - mine.wounds).toBe(profile.dmgC);
  });

  it('NODAL RESPONSE — "or use a strategy ploy now (pay its CP cost as normal)"', () => {
    const { ctx, state } = setup();
    line(state);
    state.teams.p1.cp = 4;
    const geo = opWith(state, 'p1', CARD.geomancer);
    const s0 = activate(ctx, state, geo);
    const out = usePloy(ctx, s0, 'p1', FP.nodalResponse, { gambitId: SP.transdynamic });
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.gambitsUsedTP).toContain(SP.transdynamic);
    expect(out.state.teams.p1.cp).toBe(4 - 1 - 1); // the ploy, then the strategy ploy
  });

  it('NODAL RESPONSE — "change one of the strategy ploys you used during this turning point (only pay additional CP if that ploy costs more)"', () => {
    const { ctx, state } = setup();
    line(state);
    state.teams.p1.cp = 4;
    const s0 = useGambit(ctx, state, 'p1', SP.hypershielding);
    const cpAfterGambit = s0.teams.p1.cp;
    const s1 = activate(ctx, s0, opWith(s0, 'p1', CARD.geomancer));
    const out = usePloy(ctx, s1, 'p1', FP.nodalResponse, { gambitId: SP.souldrain, replaces: SP.hypershielding });
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.gambitsUsedTP).not.toContain(SP.hypershielding);
    expect(out.state.teams.p1.gambitsUsedTP).toContain(SP.souldrain);
    // Both cost 1CP, so only the ploy's own CP is spent.
    expect(out.state.teams.p1.cp).toBe(cpAfterGambit - 1);
  });

  it('NODAL RESPONSE is only usable during a friendly activation', () => {
    const { ctx, state } = setup();
    const usable = canoptekCircle.ploys.find((p) => p.id === FP.nodalResponse)!.usable!;
    expect(usable(state, 'p1').ok).toBe(false);
    const s = activate(ctx, state, opWith(state, 'p1', CARD.geomancer));
    expect(usable(s, 'p1').ok).toBe(true);
  });

  it('ANIMATE OBELISK NODES — "up to 6" horizontally combined … rounded up to the nearest inch", then the opponent activates', () => {
    const { ctx, state } = setup();
    line(state);
    state.activePlayer = 'p1';
    const before = obeliskMarkers(state, 'p1').map((m) => ({ ...m.pos }));
    const out = usePloy(ctx, state, 'p1', FP.animateNodes, {
      nodes: obeliskMarkers(state, 'p1').map((m) => ({ id: m.id, pos: { x: m.pos.x, y: m.pos.y + 2 } })),
    });
    expect(out.ok).toBe(true);
    const moved = obeliskMarkers(out.state, 'p1').map((m, i) =>
      Math.hypot(m.pos.x - before[i]!.x, m.pos.y - before[i]!.y),
    );
    // 2" each, rounded up to 2 each = 6" of the combined budget.
    expect(moved.map((d) => Math.round(d * 100) / 100)).toEqual([2, 2, 2]);
    // "In any case, your opponent activates as normal afterwards."
    expect(out.state.activePlayer).toBe('p2');
  });

  it('SACRIFICIAL THRALL — "Select one other friendly CANOPTEK CIRCLE CANOPTEK operative … to become the valid target … instead"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 12, 11);
    const thrall = place(state, opWith(state, 'p1', CARD.warrior), 13.5, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.tombCrawler), 22, 11);
    const s = usePloy(ctx, state, 'p1', FP.sacrificialThrall, { operativeId: thrall.id }).state;
    const out = act(ctx, activate(ctx, s, shooter.id), shooter.id, 'Shoot', {
      weaponName: 'Twin gauss reapers',
      profileName: 'focused',
      targetId: geo.id,
    });
    expect(out.ok).toBe(true);
    expect((out.state.sequence as ShootSequence).targetId).toBe(thrall.id);
  });

  it('SACRIFICIAL THRALL — "This ploy has no effect if it’s the Shoot action and the ranged weapon has the Blast or Torrent weapon rule"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 12, 11);
    place(state, opWith(state, 'p1', CARD.warrior), 13.5, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.tombCrawler), 22, 11);
    const s = usePloy(ctx, state, 'p1', FP.sacrificialThrall).state;
    const out = act(ctx, activate(ctx, s, shooter.id), shooter.id, 'Shoot', {
      weaponName: 'Twin gauss reapers',
      profileName: 'sweeping', // Torrent 1"
      targetId: geo.id,
    });
    expect(out.ok).toBe(true);
    expect((out.state.sequence as ShootSequence).targetId).toBe(geo.id);
  });

  it('SACRIFICIAL THRALL’s Fight half is reminder-only, and says so', () => {
    expect(ruleText(FP.sacrificialThrall)).toContain('to be fought against');
    expect(REMINDER_ONLY[`${FP.sacrificialThrall}.fight`]).toContain('no melee target-substitution seam');
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE faction equipment', () => {
  it('MATRIX MANIPULATOR — "a friendly CANOPTEK CIRCLE GEOMANCER operative is treated as your fourth OBELISK NODE marker", once per battle', () => {
    const { ctx, state } = setup({ equipment: [EQ.matrixManipulator] });
    // Three nodes, none within 6" of another: no matrix at all until the GEOMANCER joins in.
    placeObeliskNodes(state, 'p1', [
      { x: 6, y: 11 },
      { x: 14, y: 11 },
      { x: 2, y: 20 },
    ]);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const w = place(state, opWith(state, 'p1', CARD.warrior), 8, 11);
    const T = hooksFor(ctx, 'p1');
    expect(matrixShape(state, 'p1').pairs).toHaveLength(0);
    expect(withinMatrix(T, state, w)).toBe(false);
    const s = activate(ctx, state, geo.id);
    expect(matrixShape(s, 'p1').nodes).toHaveLength(4);
    expect(withinMatrix(hooksFor(ctx, 'p1'), s, s.operatives[w.id]!)).toBe(true);
  });

  it('MATRIX MANIPULATOR does not fire when the GEOMANCER would link to nothing', () => {
    const { ctx, state } = setup({ equipment: [EQ.matrixManipulator] });
    line(state);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 3, 20);
    const s = activate(ctx, state, geo.id);
    expect(matrixShape(s, 'p1').nodes).toHaveLength(3);
    expect(matrixShape(s, 'p1').hull).toBeUndefined();
  });

  it('NANOSCARAB CASKETS — "Whenever a friendly CANOPTEK CIRCLE operative is activated, it regains up to D3 lost wounds"', () => {
    const { ctx, state } = setup({ equipment: [EQ.nanoscarabCaskets], script: [6] }); // D3 from a 6 = 3
    const w = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    w.wounds = 2;
    const s = activate(ctx, state, w.id);
    expect(s.operatives[w.id]!.wounds).toBe(5);
    expect(s.rolls.some((r) => r.kind === 'nanoscarabCaskets')).toBe(true);
  });

  it('NANOSCARAB CASKETS never overheals past the datacard’s wounds', () => {
    const { ctx, state } = setup({ equipment: [EQ.nanoscarabCaskets], script: [6] });
    const w = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    w.wounds = 6;
    const s = activate(ctx, state, w.id);
    expect(s.operatives[w.id]!.wounds).toBe(7);
  });

  it('AWAKENED OBELISK NODES — "You can use the Animate Obelisk Nodes firefight ploy for 0CP a number of times … equal to the result"', () => {
    const { ctx, state } = setup({ equipment: [EQ.awakenedNodes], script: [5, 1, 1, 1, 1] }); // D3 from a 5 = 3
    expect(state.rolls.some((r) => r.kind === 'awakenedObeliskNodes')).toBe(true);
    line(state);
    state.activePlayer = 'p1';
    const cp = state.teams.p1.cp;
    const out = usePloy(ctx, state, 'p1', FP.animateNodes);
    expect(out.ok).toBe(true);
    // CP is charged before `onPloyUsed` fires, so "for 0CP" is a refund.
    expect(out.state.teams.p1.cp).toBe(cp);
  });

  it('PHASE SHIFTER — "worsen the x of the Piercing weapon rule by 1 (if any)", once per turning point, GEOMANCER only', () => {
    const { ctx, state } = setup({ equipment: [EQ.phaseShifter] });
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 12, 11);
    const warrior = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    const profile = profileOf(CARD.warrior, 'Gauss scalpel'); // Piercing 1
    const emit = (target: OperativeState, s: GameState): number => {
      s.sequence = shootSeq({
        attackerId: shooter.id,
        targetId: target.id,
        attacker: 'p2',
        defender: 'p1',
        weaponName: 'Gauss scalpel',
      });
      return ctx.hooks.emit('onDefenceDice', s, {
        state: s,
        ctx: attackCtx(shooter, target, profile, 'Gauss scalpel'),
        count: 3 - 1,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).count;
    };
    expect(emit(warrior, state)).toBe(2); // not a GEOMANCER
    expect(emit(geo, state)).toBe(3); // "Piercing 1 would therefore be ignored"
    expect(emit(geo, state)).toBe(2); // once per turning point
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE unique actions', () => {
  /** A low block from (11,10) to (13,12) — "a point on a terrain feature" needs one. */
  const terrainMap = (): KillzoneMap => testMap({ features: [heavyBlock('block', 11, 10, 2, 2, 0.5)] });

  it('GEOMANTIC DISTURBANCE — "Separately roll 2D6 for each operative within 2" of that point … inflict damage equal to the difference"', () => {
    // 2D6 = 6 + 6 = 12 against a 7-wound WARRIOR → 5 damage.
    const { ctx, state } = setup({ map: terrainMap(), script: [6, 6, 6, 6] });
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 8, 11);
    geo.order = 'engage';
    const victim = place(state, opWith(state, 'p2', CARD.warrior), 12, 13);
    const s = activate(ctx, state, geo.id, 'engage');
    const out = act(ctx, s, geo.id, ACT.geomanticDisturbance, { targetPos: { x: 12, y: 11 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[victim.id]!.wounds).toBe(7 - 5);
    expect(out.state.rolls.some((r) => r.kind === 'geomanticDisturbance')).toBe(true);
  });

  it('GEOMANTIC DISTURBANCE inflicts nothing when 2D6 does not beat the remaining wounds', () => {
    const { ctx, state } = setup({ map: terrainMap(), script: [1, 1, 1, 1] });
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 8, 11);
    const victim = place(state, opWith(state, 'p2', CARD.warrior), 12, 13);
    const s = activate(ctx, state, geo.id, 'engage');
    const out = act(ctx, s, geo.id, ACT.geomanticDisturbance, { targetPos: { x: 12, y: 11 } });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[victim.id]!.wounds).toBe(7);
  });

  it('GEOMANTIC DISTURBANCE — "cannot perform this action while it has a Conceal order, or while within control range of an enemy operative"', () => {
    const { ctx, state } = setup({ map: terrainMap() });
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 8, 11);
    const def = getAction(ACT.geomanticDisturbance)!;
    geo.order = 'conceal';
    expect(def.check(ctx, state, geo, { targetPos: { x: 12, y: 11 } }).ok).toBe(false);
    geo.order = 'engage';
    expect(def.check(ctx, state, geo, { targetPos: { x: 12, y: 11 } }).ok).toBe(true);
    place(state, opWith(state, 'p2', CARD.warrior), 9.6, 11);
    expect(def.check(ctx, state, geo, { targetPos: { x: 12, y: 11 } }).ok).toBe(false);
  });

  it('GEOMANTIC DISTURBANCE needs "a point on a terrain feature" — a bare killzone offers none', () => {
    const { ctx, state } = setup();
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 8, 11);
    geo.order = 'engage';
    expect(disturbancePoint(ctx, state, geo)).toBeUndefined();
    expect(getAction(ACT.geomanticDisturbance)!.check(ctx, state, geo, {}).ok).toBe(false);
    const withTerrain = setup({ map: terrainMap() });
    const geo2 = place(withTerrain.state, opWith(withTerrain.state, 'p1', CARD.geomancer), 8, 11);
    geo2.order = 'engage';
    expect(disturbancePoint(withTerrain.ctx, withTerrain.state, geo2)).toBeDefined();
  });

  it('CANOPTEK CONTROL — "That selected operative can immediately perform a 1AP action for free … it cannot move more than 2""', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    const s = activate(ctx, state, geo.id, 'engage');
    const out = act(ctx, s, geo.id, ACT.canoptekControl, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    const target = out.state.operatives[mate.id]!;
    // "…for free": AP on top of the APL budget, not an APL stat change (docs/DECISIONS.md D-100),
    // so the STAT stays where it was and only the budget the AP gate reads goes up.
    expect(aplOf(ctx, out.state, target)).toBe(2);
    expect(freeApOf(out.state, target)).toBe(1);
    expect(apBudgetOf(ctx, out.state, target)).toBe(3);
    // Once it is spending that bonus AP, its move is capped at 2".
    target.apSpent = 2;
    expect(moveBudget(ctx, out.state, target, { action: 'Reposition' })).toBe(2);
    expect(moveBudget(ctx, out.state, target, { action: 'Dash' })).toBe(2);
    // …and it must be a 1AP action.
    const ev = ctx.hooks.emit('canPerformAction', out.state, {
      state: out.state,
      operative: target,
      action: 'Fall Back',
      allowed: true,
    });
    expect(ev.allowed).toBe(false);
  });

  it('CANOPTEK CONTROL — "cannot perform this action … while counteracting"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    state.opState['counteract'] = { operativeId: geo.id, actionsUsed: 0 };
    expect(getAction(ACT.canoptekControl)!.check(ctx, state, geo, {}).ok).toBe(false);
  });

  it('MOLECULAR BREACH marks the operative, and its Reposition variant sets it up wholly within its Move stat', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    const s1 = activate(ctx, state, geo.id, 'engage');
    const marked = act(ctx, s1, geo.id, ACT.molecularBreach, { targetOperativeId: mate.id }).state;
    const def = getAction(BREACH_REPOSITION)!;
    const runner = marked.operatives[mate.id]!;
    expect(def.available!(ctx, marked, runner)).toBe(true);
    // Move 7", 28mm base (radius 0.55"): 6" away is wholly within, 7" is not.
    expect(def.check(ctx, marked, runner, { targetPos: { x: 13, y: 5 } }).ok).toBe(true);
    expect(def.check(ctx, marked, runner, { targetPos: { x: 13, y: 4 } }).ok).toBe(false);
    const moved = act(ctx, activate(ctx, marked, runner.id, 'engage'), runner.id, BREACH_REPOSITION, {
      targetPos: { x: 13, y: 5 },
    });
    expect(moved.ok).toBe(true);
    expect(moved.state.operatives[runner.id]!.pos).toMatchObject({ x: 13, y: 5 });
    // "The NEXT time the selected operative performs an action in which it moves" — spent.
    expect(def.available!(ctx, moved.state, moved.state.operatives[runner.id]!)).toBe(false);
  });

  it('MOLECULAR BREACH is treated as its universal action for action restrictions (D-021)', () => {
    expect(getAction(BREACH_REPOSITION)!.treatedAs).toBe('Reposition');
    expect(getAction('Dash (Molecular Breach)')!.treatedAs).toBe('Dash');
    expect(getAction('Fall Back (Molecular Breach)')!.ap).toBe(2);
    expect(getAction('Charge (Molecular Breach)')!.treatedAs).toBe('Charge');
  });

  it('OVERCHARGE — "Until the end of that selected operative’s next activation, add 1 to its APL stat"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const acc = place(state, opWith(state, 'p1', CARD.accelerator), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    const s = activate(ctx, state, acc.id, 'engage');
    const out = act(ctx, s, acc.id, ACT.overcharge, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[mate.id]!)).toBe(3);
  });

  it('CRANIAL OVERLOAD — "Until the end of that enemy operative’s next activation, subtract 1 from its APL stat"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const acc = place(state, opWith(state, 'p1', CARD.accelerator), 10, 11);
    // Within 3" but outside control range — the action refuses an engaged operative.
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 12.6, 11);
    const s = activate(ctx, state, acc.id, 'engage');
    const out = act(ctx, s, acc.id, ACT.cranialOverload, { targetOperativeId: foe.id });
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[foe.id]!)).toBe(1);
  });

  it('CRANIAL OVERLOAD reaches an enemy anywhere in the matrix ("Alternatively, if this operative is within your OBELISK NODE MATRIX…")', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    line(state);
    const acc = place(state, opWith(state, 'p1', CARD.accelerator), 8, 11);
    const far = place(state, opWith(state, 'p2', CARD.warrior), 14.5, 11);
    expect(withinMatrix(hooksFor(ctx, 'p1'), state, acc)).toBe(true);
    const s = activate(ctx, state, acc.id, 'engage');
    const out = act(ctx, s, acc.id, ACT.cranialOverload, { targetOperativeId: far.id });
    expect(out.ok).toBe(true);
    expect(aplOf(ctx, out.state, out.state.operatives[far.id]!)).toBe(1);
  });

  it('NANOSCARAB BEAM — "The selected operative regains up to 3D3 lost wounds", once per turning point', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 6, 6] }); // 3D3 = 3+3+3
    isolate(state, []);
    const rea = place(state, opWith(state, 'p1', CARD.reanimator), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    mate.wounds = 1;
    const s = activate(ctx, state, rea.id, 'engage');
    const out = act(ctx, s, rea.id, ACT.nanoscarabBeam, { targetOperativeId: mate.id });
    expect(out.ok).toBe(true);
    expect(out.state.operatives[mate.id]!.wounds).toBe(7);
    // "…or more than once per turning point."
    expect(getAction(ACT.nanoscarabBeam)!.check(ctx, out.state, out.state.operatives[rea.id]!, {}).ok).toBe(false);
  });

  it('every unique action refuses to be performed while within control range of an enemy operative', () => {
    const { ctx, state } = setup({ map: terrainMap() });
    isolate(state, []);
    const cardFor: Record<string, string> = {
      [ACT.geomanticDisturbance]: CARD.geomancer,
      [ACT.canoptekControl]: CARD.geomancer,
      [ACT.molecularBreach]: CARD.geomancer,
      [ACT.overcharge]: CARD.accelerator,
      [ACT.cranialOverload]: CARD.accelerator,
      [ACT.nanoscarabBeam]: CARD.reanimator,
    };
    for (const [actionId, datacardId] of Object.entries(cardFor)) {
      const op = place(state, opWith(state, 'p1', datacardId), 10, 11);
      op.order = 'engage';
      const foe = place(state, opWith(state, 'p2', CARD.warrior), 10.9, 11);
      void foe;
      expect(getAction(actionId)!.check(ctx, state, op, {}).ok).toBe(false);
      isolate(state, []);
    }
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE datacard abilities', () => {
  it('Reanimate — "that friendly operative isn’t incapacitated, has 1 wound remaining", once per turning point', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const rea = place(state, opWith(state, 'p1', CARD.reanimator), 10, 11);
    const victim = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBe(false);
    expect(victim.wounds).toBe(1);
    // "Subtract 1 from this and that operative's APL stats until the end of their next activations."
    expect(aplOf(ctx, state, rea)).toBe(1);
    expect(victim.aplMods).toContain(-1);
    // …and "that friendly operative can immediately perform a free Dash action", modelled as one
    // AP outside the APL budget restricted to Dash (docs/DECISIONS.md D-100). The two halves of
    // the rule do not cancel: the printed −1 really lowers the APL stat, and the free Dash is
    // still there on top of it. Were the Dash an APL change it would meet the −1 under "the total
    // can never be more than -1 or +1 from its normal APL" and the operative would be handed a
    // free action it could never perform.
    expect(aplOf(ctx, state, victim)).toBe(1);
    expect(freeApOf(state, victim)).toBe(1);
    expect(apBudgetOf(ctx, state, victim)).toBe(2);
    expect(state.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === victim.id)?.data?.['only'])
      .toContain('Dash');
    // "Once per turning point" — a second friendly dies for real.
    const other = place(state, opWith(state, 'p1', CARD.accelerator), 12, 11);
    other.wounds = 1;
    inflictDamage(ctx, state, other, 5, 'attack');
    expect(other.incapacitated).toBe(true);
  });

  it('Reanimate — "providing neither this nor that operative is within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    place(state, opWith(state, 'p1', CARD.reanimator), 10, 11);
    const victim = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    place(state, opWith(state, 'p2', CARD.warrior), 13.9, 11); // engaging the victim
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBe(true);
  });

  it('Reanimate — "You cannot use this rule … if it’s a Shoot action and this operative would be a primary or secondary target"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const rea = place(state, opWith(state, 'p1', CARD.reanimator), 10, 11);
    const victim = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    const shooter = place(state, opWith(state, 'p2', CARD.warrior), 22, 11);
    state.sequence = shootSeq({
      attackerId: shooter.id,
      targetId: victim.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Gauss scalpel',
      queue: [rea.id], // a secondary target
    });
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBe(true);
  });

  it('Reanimate’s "must end that action within this operative’s control range or within your OBELISK NODE MATRIX" is reminder-only', () => {
    expect(abilityText(CARD.reanimator, AB.reanimate)).toContain('free Dash action');
    expect(REMINDER_ONLY[`${AB.reanimate}.dash`]).toContain('no hook constrains where a move ENDS');
  });

  it('Aggressive Defence — "roll one D3: on a 2+, inflict 1 damage on that enemy operative"', () => {
    const { ctx, state } = setup({ script: [6] }); // D3 from a 6 = 3
    isolate(state, []);
    const warrior = place(state, opWith(state, 'p1', CARD.warrior), 10, 11);
    const killer = place(state, opWith(state, 'p2', CARD.warrior), 11, 11);
    // Move the REANIMATOR out of range so Reanimate does not prevent the incapacitation.
    place(state, opWith(state, 'p1', CARD.reanimator), 2, 20);
    state.sequence = fightSeqOf({
      attackerId: killer.id,
      defenderId: warrior.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Claws & tail',
    });
    warrior.wounds = 1;
    const before = killer.wounds;
    inflictDamage(ctx, state, warrior, 4, 'attack');
    expect(warrior.incapacitated).toBe(true);
    expect(before - killer.wounds).toBe(1);
  });

  it('Aggressive Defence does nothing on a 1, or when the killer is more than 2" away', () => {
    const { ctx, state } = setup({ script: [1] }); // D3 from a 1 = 1
    isolate(state, []);
    const warrior = place(state, opWith(state, 'p1', CARD.warrior), 10, 11);
    const killer = place(state, opWith(state, 'p2', CARD.warrior), 11, 11);
    place(state, opWith(state, 'p1', CARD.reanimator), 2, 20);
    state.sequence = fightSeqOf({
      attackerId: killer.id,
      defenderId: warrior.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Claws & tail',
    });
    warrior.wounds = 1;
    const before = killer.wounds;
    inflictDamage(ctx, state, warrior, 4, 'attack');
    expect(killer.wounds).toBe(before);
  });

  it('Expendable Construct is reminder-only — every clause is op scoring', () => {
    expect(abilityText(CARD.warrior, AB.expendableConstruct)).toContain('kill/elimination op');
    expect(REMINDER_ONLY[AB.expendableConstruct]).toContain('src/core/ops/**');
  });

  it('A Ceaseless Scuttling — "if you have less than three non-incapacitated friendly … WARRIOR operatives, you can set up another one"', () => {
    const { ctx, state } = setup();
    state.turningPoint = 2;
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    // Three WARRIORs are alive, so nothing is offered.
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SCUTTLING_GAMBIT);
    const dead = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    dead.incapacitated = true;
    dead.removed = true;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(SCUTTLING_GAMBIT);
    const before = state.teams.p1.operativeIds.length;
    const after = useGambit(ctx, state, 'p1', SCUTTLING_GAMBIT);
    expect(after.teams.p1.operativeIds).toHaveLength(before + 1);
    const fresh = after.operatives[after.teams.p1.operativeIds[before]!]!;
    expect(fresh).toMatchObject({ datacardId: CARD.warrior, ready: true, order: 'conceal', wounds: 7 });
    // "…wholly within your drop zone" — p1's drop zone is x <= 6 on the test map.
    expect(fresh.pos.x + 28 / 25.4 / 2).toBeLessThanOrEqual(6 + EPS);
    // "(you can select its weapon options as normal)" — the deterministic default is printed first.
    expect((after.opState['loadout'] as Record<string, string[]>)[fresh.id]).toEqual(['Gauss scalpel', 'Claws & tail']);
    // The engine treats it as any other operative: it activates and moves.
    after.phase = 'firefight';
    after.firefightStep = 'performActions';
    after.activePlayer = 'p1';
    const moved = act(ctx, activate(ctx, after, fresh.id, 'engage'), fresh.id, 'Reposition', {
      path: { points: [fresh.pos, { x: fresh.pos.x, y: fresh.pos.y + 2 }] },
    });
    expect(moved.ok).toBe(true);
  });

  it('A Ceaseless Scuttling is not offered in the first turning point', () => {
    const { ctx, state } = setup();
    const dead = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    dead.incapacitated = true;
    dead.removed = true;
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SCUTTLING_GAMBIT);
  });

  /**
   * Attack dice 5,2,2,2,2 vs Hit 4+ = one normal success; defence 1,1,1 = three fails; the
   * WARRIOR takes 5 of its 7 wounds and survives, which is what makes the 2D6 relevant
   * ("if the target wasn't incapacitated").
   */
  const banishScript = (d1: number, d2: number): number[] => [5, 2, 2, 2, 2, 1, 1, 1, d1, d2];

  it('Dimensional Banishment — "roll 2D6: if the result is higher than the target’s remaining wounds, the target is incapacitated"', () => {
    const { ctx, state } = setup({ script: banishScript(6, 6) }); // 2D6 = 12 vs 2 wounds left
    isolate(state, []);
    // The printed list gives only ONE operative the transdimensional isolator (maxItem 1), and
    // `defaultRoster` puts it on the second TOMB CRAWLER.
    const crawler = place(state, opNth(state, 'p1', CARD.tombCrawler, 1), 10, 11);
    const victim = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    // "…taking precedence over rules that prevent incapacitation": the enemy REANIMATOR is in
    // range and unengaged, so an ordinary incapacitation here would be prevented by Reanimate.
    place(state, opWith(state, 'p2', CARD.reanimator), 23, 11);
    const s = activate(ctx, state, crawler.id, 'engage');
    const out = act(ctx, s, crawler.id, 'Shoot', {
      weaponName: 'Transdimensional isolator',
      targetId: victim.id,
    });
    expect(out.ok).toBe(true);
    const done = settle(ctx, out.state);
    expect(done.rolls.some((r) => r.kind === 'dimensionalBanishment')).toBe(true);
    expect(done.operatives[victim.id]!.incapacitated || done.operatives[victim.id]!.removed).toBe(true);
  });

  it('Dimensional Banishment leaves the target alone when 2D6 does not beat its remaining wounds', () => {
    const { ctx, state } = setup({ script: banishScript(1, 1) }); // 2D6 = 2, not higher than 2
    isolate(state, []);
    const crawler = place(state, opNth(state, 'p1', CARD.tombCrawler, 1), 10, 11);
    const victim = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    const s = activate(ctx, state, crawler.id, 'engage');
    const out = act(ctx, s, crawler.id, 'Shoot', {
      weaponName: 'Transdimensional isolator',
      targetId: victim.id,
    });
    expect(out.ok).toBe(true);
    const done = settle(ctx, out.state);
    expect(done.rolls.some((r) => r.kind === 'dimensionalBanishment')).toBe(true);
    expect(done.operatives[victim.id]!.removed).toBeFalsy();
    expect(done.operatives[victim.id]!.wounds).toBe(2);
  });

  it('Weapon Sentinel — "if this operative has a Conceal order, it cannot use Light terrain for cover … it doesn’t remove its cover save"', () => {
    const { ctx, state } = setup();
    const crawler = state.operatives[opWith(state, 'p1', CARD.tombCrawler)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.warrior)]!;
    crawler.order = 'conceal';
    const ev = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: crawler,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(ev.ignoreCoverTerrain).toBe('light');
    crawler.order = 'engage';
    const engaged = ctx.hooks.emit('onValidTarget', state, {
      state,
      attacker: shooter,
      target: crawler,
      valid: true,
      ignoreCoverTerrain: 'none',
      forceVisible: false,
      ignoreFriendlyControlRange: false,
    });
    expect(engaged.ignoreCoverTerrain).toBe('none');
  });

  it('Steadfast — "you can treat this operative’s APL stat as 3 … any changes to its APL stat are ignored for this"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const crawler = place(state, opWith(state, 'p1', CARD.tombCrawler), 15, 11);
    crawler.aplMods.push(-1); // stunned: APL 1
    expect(aplOf(ctx, state, crawler)).toBe(1);
    // A mirror TOMB CRAWLER would claim Steadfast too, so the contester is an APL 2 WARRIOR.
    const contester = place(state, opWith(state, 'p2', CARD.warrior), 15, 12.2);
    expect(aplOf(ctx, state, contester)).toBe(2);
    // 3 (Steadfast) beats the enemy's 2 even though the crawler is on APL 1.
    expect(markerController(ctx, state, state.markers['centre']!)).toBe('p1');
  });

  it('Obelisk Node Control — the Operate Hatch half is a real action; the mission-action half is reminder-only', () => {
    expect(getAction(NODE_OPERATE_HATCH)).toBeDefined();
    expect(getAction(NODE_OPERATE_HATCH)!.treatedAs).toBe('Operate Hatch');
    expect(abilityText(CARD.geomancer, AB.obeliskNodeControl)).toContain('Operate Hatch');
    expect(REMINDER_ONLY[AB.obeliskNodeControl]).toContain('markerContestedBy');
  });

  it('the Operate Hatch variant refuses an access point that is not within 1" of an Obelisk Node marker', () => {
    const { ctx, state } = setup();
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const def = getAction(NODE_OPERATE_HATCH)!;
    expect(def.available!(ctx, state, geo)).toBe(false); // no hatchways on the test map
    expect(def.check(ctx, state, geo, { partId: 'nope' }).ok).toBe(false);
  });

  it('the Operate Hatch variant is a HATCHWAY action, and something can aim it', () => {
    // Two ways this was unusable. Delegating to the universal `Operate Hatch.perform` without
    // its `opensAs` guard would open a Tomb World BREACH POINT for 1AP; and the core's
    // NEEDS_TARGET table is keyed by action id, which the kernel cannot extend with a faction
    // id, so nothing built a `partId` for it — not the sheet's aim list, not `src/ai/legal.ts`.
    const def = getAction(NODE_OPERATE_HATCH)!;
    expect(def.needsTarget).toBe('part');
    expect(actionTargetKind(NODE_OPERATE_HATCH)).toBe('part');

    const { ctx, state } = setup({ map: mapById('tomb-world-2') });
    const geo = opWith(state, 'p1', CARD.geomancer);
    const breach = buildTerrainIndex(state.map, state).parts.find(
      (p) => p.role === 'accessPoint' && p.opensAs === 'breachWall',
    )!;
    expect(breach).toBeDefined();
    expect(def.check(ctx, state, state.operatives[geo]!, { partId: breach.id }).reason).toContain(
      'breach point, not a hatchway',
    );
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE aiHints', () => {
  it('names a role for every datacard', () => {
    const roles = canoptekCircle.aiHints?.roles ?? {};
    for (const c of DATA.datacards) expect(roles[c.id]).toBeDefined();
  });

  it('prices all 8 ploys (without which the AI never uses a firefight ploy) and the three 0CP faction gambits', () => {
    const values = canoptekCircle.aiHints?.ployValue ?? {};
    for (const p of canoptekCircle.ploys) expect(values[p.id]).toBeGreaterThan(0);
    for (const g of [PLACE_NODES_GAMBIT, MOVE_NODES_GAMBIT, SCUTTLING_GAMBIT]) expect(values[g]).toBeGreaterThan(0);
    // Placing the nodes switches on fourteen other rules, so it outranks every ploy.
    expect(values[PLACE_NODES_GAMBIT]!).toBeGreaterThan(Math.max(...canoptekCircle.ploys.map((p) => values[p.id] ?? 0)));
  });

  it('prices all 4 equipment options', () => {
    const values = canoptekCircle.aiHints?.equipmentValue ?? {};
    for (const e of canoptekCircle.equipment) expect(values[e.id]).toBeGreaterThan(0);
  });

  it('quotes the faction rule id the module binds against', () => {
    expect(DATA.factionRules[0]!.id).toBe(RULE_MATRIX);
    expect(ruleText(RULE_MATRIX)).toContain('OBELISK NODE MATRIX');
    expect(actionOf(CARD.geomancer, ACT.canoptekControl).ap).toBe(1);
  });
});

// ===========================================================================
describe('CANOPTEK CIRCLE — free-action lifetime and soak safety', () => {
  it('a free action lasts one activation: it expires with the activation it was spent in', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    const s1 = activate(ctx, state, geo.id, 'engage');
    const s2 = act(ctx, s1, geo.id, ACT.canoptekControl, { targetOperativeId: mate.id }).state;
    expect(freeApOf(s2, s2.operatives[mate.id]!)).toBe(1);
    expect(apBudgetOf(ctx, s2, s2.operatives[mate.id]!)).toBe(3);
    const s3 = reduce(s2, { t: 'EndActivation', operativeId: geo.id }, ctx).state;
    const s4 = activate(ctx, s3, mate.id, 'engage');
    const s5 = reduce(s4, { t: 'EndActivation', operativeId: mate.id }, ctx).state;
    // "…can immediately perform a 1AP action for free" is one action, not a permanent bonus.
    expect(freeApOf(s5, s5.operatives[mate.id]!)).toBe(0);
    expect(apBudgetOf(ctx, s5, s5.operatives[mate.id]!)).toBe(2);
    expect(aplOf(ctx, s5, s5.operatives[mate.id]!)).toBe(2);
  });

  it('a free action handed to an already-expended operative does not survive to the next turning point', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    // The recipient has already had its activation, so its activation never ends again this
    // turning point and nothing expires the grant on its own.
    let s = activate(ctx, state, mate.id, 'engage');
    s = reduce(s, { t: 'EndActivation', operativeId: mate.id }, ctx).state;
    s = activate(ctx, s, geo.id, 'engage');
    s = act(ctx, s, geo.id, ACT.canoptekControl, { targetOperativeId: mate.id }).state;
    expect(freeApOf(s, s.operatives[mate.id]!)).toBe(1);
    s = reduce(s, { t: 'EndActivation', operativeId: geo.id }, ctx).state;
    expect(freeApOf(s, s.operatives[mate.id]!)).toBe(1);
    // "…can IMMEDIATELY perform a 1AP action for free" — an unspent grant is spent or lost, and
    // must not be waiting for the operative when the Ready step readies it next turning point.
    s.turningPoint += 1;
    readyStep(ctx, s);
    expect(freeApOf(s, s.operatives[mate.id]!)).toBe(0);
    expect(apBudgetOf(ctx, s, s.operatives[mate.id]!)).toBe(2);
  });

  it('MOLECULAR BREACH is capped at 2" while the operative is spending a CANOPTEK CONTROL free action', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const geo = place(state, opWith(state, 'p1', CARD.geomancer), 10, 11);
    const mate = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    const s1 = activate(ctx, state, geo.id, 'engage');
    const s2 = act(ctx, s1, geo.id, ACT.molecularBreach, { targetOperativeId: mate.id }).state;
    const s3 = act(ctx, s2, geo.id, ACT.canoptekControl, { targetOperativeId: mate.id }).state;
    const runner = s3.operatives[mate.id]!;
    runner.apSpent = 2; // now spending the bonus AP
    const def = getAction(BREACH_REPOSITION)!;
    // "…or must be set up wholly within 2" if it's removed and set up again."
    expect(def.check(ctx, s3, runner, { targetPos: { x: 13, y: 12 } }).ok).toBe(true);
    expect(def.check(ctx, s3, runner, { targetPos: { x: 13, y: 15 } }).ok).toBe(false);
  });

  it('Reanimate also reaches "if this and that operative are within your OBELISK NODE MATRIX"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    line(state); // the matrix runs from (7,11) to (15,11)
    const rea = place(state, opWith(state, 'p1', CARD.reanimator), 7.2, 11);
    const victim = place(state, opWith(state, 'p1', CARD.warrior), 14.8, 11);
    // Further apart than 6", so only the matrix branch can save it.
    expect(hooksFor(ctx, 'p1').gap(rea, victim)).toBeGreaterThan(6);
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBe(false);
    expect(victim.wounds).toBe(1);
  });

  it('Reanimate — "You cannot use this rule if this operative is incapacitated"', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    const rea = place(state, opWith(state, 'p1', CARD.reanimator), 10, 11);
    rea.incapacitated = true;
    const victim = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    victim.wounds = 2;
    inflictDamage(ctx, state, victim, 5, 'attack');
    expect(victim.incapacitated).toBe(true);
  });

  it('NANOSCARAB BEAM — "It cannot be an operative that the Reanimate rule was used on during this turning point"', () => {
    const { ctx, state } = setup({ script: [6, 6, 6, 6, 6, 6] });
    isolate(state, []);
    const rea = place(state, opWith(state, 'p1', CARD.reanimator), 10, 11);
    const saved = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    saved.wounds = 2;
    inflictDamage(ctx, state, saved, 5, 'attack'); // Reanimate fires on `saved`
    expect(saved.wounds).toBe(1);
    const other = place(state, opWith(state, 'p1', CARD.accelerator), 13, 11);
    other.wounds = 3;
    const s = activate(ctx, state, rea.id, 'engage');
    const out = act(ctx, s, rea.id, ACT.nanoscarabBeam, { targetOperativeId: saved.id });
    expect(out.ok).toBe(true);
    // The saved WARRIOR is excluded, so the beam lands on the deterministic next candidate.
    expect(out.state.operatives[saved.id]!.wounds).toBe(1);
    expect(out.state.operatives[other.id]!.wounds).toBeGreaterThan(3);
  });

  it('SHIELD FLARE does nothing when the matrix neither intervenes nor contains the target', () => {
    const { ctx, state } = setup();
    isolate(state, []);
    placeObeliskNodes(state, 'p1', [
      { x: 2, y: 2 },
      { x: 5, y: 2 },
    ]);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    const mine = place(state, opWith(state, 'p1', CARD.warrior), 20.6, 11);
    const s = usePloy(ctx, state, 'p1', FP.shieldFlare).state;
    s.sequence = fightSeqOf({
      attackerId: foe.id,
      defenderId: mine.id,
      attacker: 'p2',
      defender: 'p1',
      attackerWeapon: 'Claws & tail',
    });
    const dmgN = profileOf(CARD.warrior, 'Claws & tail').dmgN;
    const before = s.operatives[mine.id]!.wounds;
    inflictDamage(ctx, s, s.operatives[mine.id]!, dmgN, 'attack');
    expect(before - s.operatives[mine.id]!.wounds).toBe(dmgN);
  });

  it('"your OBELISK NODE MATRIX is intervening" is false when the matrix lies behind the shooter', () => {
    const { ctx, state } = setup();
    line(state); // (7,11) → (15,11)
    expect(matrixIntervenes(state, 'p1', { x: 20, y: 11 }, { x: 25, y: 11 })).toBe(false);
    expect(matrixIntervenes(state, 'p1', { x: 11, y: 3 }, { x: 11, y: 19 })).toBe(true);
  });

  /**
   * D-026 / the #1 soak breaker: `src/ai/legal.ts` tries a small set of plausible params and
   * offers anything whose `check` passes, so a `perform` that then refuses is a rejected intent.
   */
  it('every unique action’s `perform` completes whatever its `check` accepted (D-026)', () => {
    const { ctx, state } = setup({ map: testMap({ features: [heavyBlock('block', 11, 10, 2, 2, 0.5)] }) });
    const owners: Record<string, string> = {
      [ACT.geomanticDisturbance]: CARD.geomancer,
      [ACT.canoptekControl]: CARD.geomancer,
      [ACT.molecularBreach]: CARD.geomancer,
      [ACT.overcharge]: CARD.accelerator,
      [ACT.cranialOverload]: CARD.accelerator,
      [ACT.nanoscarabBeam]: CARD.reanimator,
    };
    let attempted = 0;
    for (const [actionId, datacardId] of Object.entries(owners)) {
      const base = setup({ map: testMap({ features: [heavyBlock('block', 11, 10, 2, 2, 0.5)] }) });
      const opId = opWith(base.state, 'p1', datacardId);
      place(base.state, opId, 8, 11);
      for (const other of aliveOperatives(base.state)) {
        if (other.id === opId) continue;
        other.pos = { x: 10 + (Number(other.id.slice(-1)) % 4) * 1.4, y: 13 + (Number(other.id.slice(-1)) % 3) * 1.4 };
      }
      const op = base.state.operatives[opId]!;
      op.order = 'engage';
      const attempts: Record<string, unknown>[] = [
        {},
        { targetPos: { ...op.pos } },
        { targetPos: { x: 12, y: 11 } },
        ...aliveOperatives(base.state).map((o) => ({ targetOperativeId: o.id, targetId: o.id })),
      ];
      const def = getAction(actionId)!;
      for (const params of attempts) {
        if (!def.check(base.ctx, base.state, op, params).ok) continue;
        const s = activate(base.ctx, base.state, opId, 'engage');
        const out = act(base.ctx, s, opId, actionId, params);
        attempted++;
        expect({ actionId, params, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
    expect(attempted).toBeGreaterThan(6);
  });
});
