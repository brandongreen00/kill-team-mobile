/**
 * RAVENERS. Every test quotes the printed rule it pins, read out of
 * `data/teams/raveners.json` — never retyped.
 * Source: https://wahapedia.ru/kill-team3/kill-teams/raveners/
 */
import { describe, expect, it } from 'vitest';
import { actionCost, availableActions, getAction } from '../../src/core/actions.ts';
import { addRolled, newPool, type DicePool } from '../../src/core/dice.ts';
import { zeroStatMods, type AttackContext } from '../../src/core/hooks.ts';
import { counteractCandidates, gambitOptions } from '../../src/core/phases.ts';
import { reduce } from '../../src/core/reducer.ts';
import { effectiveRules, checkTarget } from '../../src/core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../src/core/sequences/types.ts';
import {
  aliveOperatives,
  apBudgetOf,
  aplOf,
  freeApOf,
  inflictDamage,
  markerController,
  moveOf,
} from '../../src/core/state.ts';
import { rareWeaponRuleText } from '../../src/core/weaponRules.ts';
import type { GameContext } from '../../src/core/context.ts';
import type { GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../src/core/types.ts';
import rawJson from '../../data/teams/raveners.json';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor } from '../../src/teams/selection.ts';
import { makeTeamHooks } from '../../src/teams/helpers.ts';
import {
  AB,
  ACT,
  BURROW,
  CARD,
  CHANGE_ORDER,
  CHARGE_HYPERSENSORY,
  CHARGE_SLITHERING,
  DISTEND,
  EQ,
  FIGHT_AGAIN,
  FP,
  KW,
  MAX_TUNNEL_MARKERS,
  POISON_TOKEN,
  REMINDER_ONLY,
  RULE,
  SP,
  SYNAPTIC_GAMBIT,
  TUNNEL_GAMBIT,
  UNDERGROUND,
  distendActive,
  emergeSpot,
  ensureTunnelStart,
  isUnderground,
  onTunnel,
  raveners,
  setUnderground,
  tunnelGap,
  tunnelMarkerId,
  tunnelMarkers,
  tunnelStepLegal,
} from '../../src/teams/raveners/index.ts';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { act, activate, battle, mapById, opWith, teamContext } from './harness.ts';

const DATA = teamData('raveners');
/** `TeamData` does not surface `notes[]`, so the committed bytes are read straight from the file. */
const NOTES = (rawJson as { notes: string[] }).notes;

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
}

/** Both sides are Raveners, so every rule can be tested from either seat. */
function setup(opts: SetupOpts = {}): { ctx: GameContext; state: GameState } {
  const ctx = teamContext([raveners], opts.script ? { script: opts.script } : { seed: opts.seed ?? 7 });
  const picks = defaultRoster(DATA);
  const state = battle({
    ctx,
    p1: { module: raveners, picks, ...(opts.equipment ? { equipment: opts.equipment } : {}) },
    p2: { module: raveners, picks },
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
    op.pos = { x: 1.2 + (n % 3) * 1.1, y: 19 + Math.floor(n / 3) * 1.1 };
    n++;
  }
}

/** A hand-placed Tunnel marker chain, so the geometry tests do not depend on the gambit. */
function tunnelAt(state: GameState, player: PlayerId, points: Vec2[]): void {
  points.forEach((pos, n) => {
    state.markers[tunnelMarkerId(player, n)] = {
      id: tunnelMarkerId(player, n),
      kind: 'generic',
      diameterMm: 20,
      pos,
      z: 0,
      owner: player,
      flags: { tunnel: n },
    };
  });
}

const hooksFor = (ctx: GameContext, player: PlayerId) => makeTeamHooks(DATA, player, ctx);

function pool(values: number[], hit: number): DicePool {
  const p = newPool();
  addRolled(p, values, hit);
  return p;
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

function shootSeq(
  over: Partial<ShootSequence> &
    Pick<ShootSequence, 'attackerId' | 'targetId' | 'attacker' | 'defender' | 'weaponName'>,
): ShootSequence {
  return {
    kind: 'shoot',
    step: 'resolve',
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

function fightSeq(
  over: Partial<FightSequence> &
    Pick<FightSequence, 'attackerId' | 'defenderId' | 'attackerWeapon' | 'attacker' | 'defender'>,
): FightSequence {
  return {
    kind: 'fight',
    step: 'resolve',
    attackerPool: newPool(),
    defenderPool: newPool(),
    turn: 'attacker',
    usedRerolls: [],
    usedRetention: [],
    shockUsed: { attacker: false, defender: false },
    attackerAssists: 0,
    defenderAssists: 0,
    defenderCanRetaliate: true,
    free: false,
    hatchway: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('RAVENERS data (pinned against data/teams/raveners.json)', () => {
  it('has 6 datacards — APL 3, Move 7", 40mm bases, all RAVENER GREAT DEVOURER TYRANID', () => {
    expect(DATA.datacards).toHaveLength(6);
    for (const card of DATA.datacards) {
      expect(card).toMatchObject({ apl: 3, move: 7, base: { shape: 'round', mm: 40 } });
      expect(card.keywords.slice(0, 3)).toEqual(['RAVENER', 'GREAT DEVOURER', 'TYRANID']);
    }
    // The PRIME is the only LEADER, the only 21-wound operative; the WRECKER the only Save 4+.
    expect(DATA.datacards.filter((c) => c.keywords.includes('LEADER')).map((c) => c.id)).toEqual([CARD.prime]);
    expect(DATA.datacards.filter((c) => c.wounds !== 20).map((c) => c.id)).toEqual([CARD.prime]);
    expect(DATA.datacards.find((c) => c.id === CARD.prime)!.wounds).toBe(21);
    expect(DATA.datacards.filter((c) => c.save !== 5).map((c) => c.id)).toEqual([CARD.wrecker]);
    expect(DATA.datacards.find((c) => c.id === CARD.wrecker)!.save).toBe(4);
  });

  it('exposes 3 faction rules, 4+4 ploys, 4 equipment options, 9 abilities and 2 unique actions', () => {
    expect(DATA.factionRules.map((r) => r.name)).toEqual(['Burrow', 'Tunnel', 'Predatory Instincts']);
    expect(raveners.ploys.filter((p) => p.kind === 'strategy')).toHaveLength(4);
    expect(raveners.ploys.filter((p) => p.kind === 'firefight')).toHaveLength(4);
    expect(raveners.equipment).toHaveLength(4);
    expect(DATA.datacards.flatMap((c) => c.abilities)).toHaveLength(9);
    expect(DATA.datacards.flatMap((c) => c.uniqueActions)).toHaveLength(2);
    expect(new Set(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.ap))).toEqual(new Set([1]));
    expect(NOTES).toEqual([]);
    // Every ploy costs 1CP; the two extra STRATEGIC GAMBITs this module offers cost nothing.
    expect(new Set(raveners.ploys.map((p) => p.cp))).toEqual(new Set([1]));
  });

  it('pins the weapon profiles the rules read', () => {
    expect(profileOf(CARD.prime, 'Tail blade')).toMatchObject({ type: 'ranged', atk: 4, hit: 3, dmgN: 3, dmgC: 4 });
    expect(profileOf(CARD.prime, 'Tail blade').rules.map((r) => r.raw)).toEqual(['Range 3"', 'Rending', 'Silent']);
    expect(profileOf(CARD.felltalon, 'Toxic glands').rules.map((r) => r.raw)).toEqual(['Range 6"', 'Silent', 'Poison*']);
    expect(profileOf(CARD.felltalon, 'Toxic scythes').rules.map((r) => r.raw)).toEqual([
      'Lethal 5+',
      'Shock',
      'Poison*',
    ]);
    const venom = DATA.datacards.find((c) => c.id === CARD.venomspitter)!.weapons.find((w) => w.name === 'Venom bolt')!;
    expect(venom.profiles.map((p) => p.name)).toEqual(['blast', 'focused']);
    expect(profileOf(CARD.venomspitter, 'Venom bolt', 'blast').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Blast 2"',
      'Poison*',
    ]);
    expect(profileOf(CARD.venomspitter, 'Venom bolt', 'focused').rules.map((r) => r.raw)).toEqual([
      'Range 8"',
      'Piercing 1',
      'Poison*',
    ]);
    expect(profileOf(CARD.wrecker, 'Scything talons & crushing claws').rules.map((r) => r.raw)).toEqual(['Crush*']);
    expect(profileOf(CARD.wrecker, 'Bone mace').rules.map((r) => r.raw)).toEqual(['Range 3"', 'Piercing 1', 'Silent']);
    // Every melee profile is ATK 5 / HIT 3+ / DMG 4/5.
    for (const card of DATA.datacards) {
      for (const w of card.weapons)
        for (const p of w.profiles) if (p.type === 'melee') expect(p).toMatchObject({ atk: 5, hit: 3, dmgN: 4, dmgC: 5 });
    }
  });

  it('the two rare weapon rules are Crush and Poison, resolved against THIS team’s own wording (D-033)', () => {
    expect(DATA.rareWeaponRules.slice().sort()).toEqual(['Crush', 'Poison']);
    expect(rareWeaponRuleText('Crush', 'raveners')).toBe(abilityText(CARD.wrecker, AB.crush));
    expect(rareWeaponRuleText('Poison', 'raveners')).toBe(abilityText(CARD.felltalon, AB.poisonFelltalon));
    // DATA PROBLEM: the shared registry stores the PLAGUE MARINES wording for Poison — "any
    // successes", a friendly carve-out and 1 damage — where the Raveners print critical
    // successes, no carve-out and D3. D-033 is what keeps a Ravener player off that text.
    const shared = (rawJson as unknown as { id: string }).id; // keep the raw import used
    expect(shared).toBe('raveners');
    expect(abilityText(CARD.felltalon, AB.poisonFelltalon)).toContain('any critical successes');
    expect(abilityText(CARD.felltalon, AB.poisonFelltalon)).toContain('inflict D3 damage on it');
    expect(abilityText(CARD.felltalon, AB.poisonFelltalon)).not.toContain('excluding friendly');
    // Both POISON datacards print the identical text.
    expect(abilityText(CARD.venomspitter, AB.poisonVenomspitter)).toBe(abilityText(CARD.felltalon, AB.poisonFelltalon));
  });

  it('the ploy section overrun is trimmed at load (the last ploy of each section)', () => {
    expect(DATA.strategyPloys[3]!.text).not.toContain('Firefight Ploys');
    expect(DATA.firefightPloys[3]!.text).not.toContain('Faction Equipment');
    expect(DATA.strategyPloys[3]!.text.endsWith('e.g. Seek Light and Vantage terrain).')).toBe(true);
    // The raw committed bytes still carry the overrun — the data problem, not the module.
    expect((rawJson as { strategyPloys: { text: string }[] }).strategyPloys[3]!.text).toContain('Firefight Ploys');
    expect((rawJson as { firefightPloys: { text: string }[] }).firefightPloys[3]!.text).toContain('Faction Equipment');
  });

  it('DATA PROBLEM: BURROW is a unique action printed inside a faction rule with its AP glued on', () => {
    // "BURROW1AP" — no id, no name, no `ap`, unlike a datacard's `uniqueActions[]` entries.
    expect(ruleText(RULE.burrow)).toContain('BURROW1AP');
    expect(DATA.datacards.flatMap((c) => c.uniqueActions).map((a) => a.id)).toEqual([ACT.toxicLunge, ACT.distend]);
    // The module registers it as a real 1AP ActionDef anyway.
    expect(getAction(BURROW)).toMatchObject({ ap: 1, type: 'unique' });
  });

  it('selection: "Other than WARRIOR operatives … only include each operative once" is the only constraint', () => {
    expect(DATA.selection.constraints).toEqual([{ kind: 'uniqueExcept', roles: ['WARRIOR'] }]);
    expect(DATA.selection.rawText).toContain('Other than WARRIOR operatives');
    const picks = defaultRoster(DATA);
    expect(validateRosterFor(DATA, picks).ok).toBe(true);
    expect(picks.map((p) => p.datacardId)).toEqual([
      CARD.prime,
      CARD.felltalon,
      CARD.tremorscythe,
      CARD.venomspitter,
      CARD.warrior,
    ]);
    // …which means `defaultRoster` NEVER fields the WRECKER, so Crush and Reinforced Carapace
    // are unexercised by any defaultRoster-driven soak.
    expect(picks.some((p) => p.datacardId === CARD.wrecker)).toBe(false);
    // Two WARRIORs are legal; two WRECKERs are not.
    expect(
      validateRosterFor(DATA, [
        { datacardId: CARD.prime },
        { datacardId: CARD.warrior },
        { datacardId: CARD.warrior },
        { datacardId: CARD.warrior },
        { datacardId: CARD.warrior },
      ]).ok,
    ).toBe(true);
    expect(
      validateRosterFor(DATA, [
        { datacardId: CARD.prime },
        { datacardId: CARD.wrecker },
        { datacardId: CARD.wrecker },
        { datacardId: CARD.warrior },
        { datacardId: CARD.warrior },
      ]).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Tunnel', () => {
  it('places Tunnel marker 0 "on the killzone floor, wholly within your drop zone and touching your killzone edge"', () => {
    const { state } = setup();
    expect(ruleText(RULE.tunnel)).toContain('wholly within your drop zone and touching your killzone edge');
    ensureTunnelStart(state, 'p1');
    const m = state.markers[tunnelMarkerId('p1', 0)]!;
    expect(m).toBeDefined();
    expect(m.z).toBe(0);
    expect(m.diameterMm).toBe(20);
    // The test map's p1 drop zone is x in [0,6]; the marker sits wholly inside it and its edge
    // touches the board boundary (no killzoneEdges are recorded on the synthetic map).
    expect(m.pos.x).toBeGreaterThanOrEqual(20 / 25.4 / 2 - 1e-9);
    expect(m.pos.x).toBeLessThanOrEqual(6 - 20 / 25.4 / 2 + 1e-9);
    expect(Math.min(m.pos.x, m.pos.y, 30 - m.pos.x, 22 - m.pos.y)).toBeLessThanOrEqual(20 / 25.4 / 2 + 0.05);
  });

  it('on a real Approved Ops map the marker touches the printed killzone edge, inside the drop zone', () => {
    const { state } = setup();
    const map = mapById('volkus-1');
    (state as { map: typeof map }).map = map;
    state.setup.dropZone = { p1: 'p1', p2: 'p2' };
    const m = ensureTunnelStart(state, 'p1')!;
    const edge = map.killzoneEdges.p1[0]!;
    const r = 20 / 25.4 / 2;
    // Its own edge touches the killzone edge: centre exactly one marker radius away.
    const d =
      Math.abs(
        (edge.b.y - edge.a.y) * (m.pos.x - edge.a.x) - (edge.b.x - edge.a.x) * (m.pos.y - edge.a.y),
      ) / Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
    expect(d).toBeCloseTo(r, 3);
    // …and the whole marker is inside the printed drop zone.
    const zone = map.dropZones.p1[0]!;
    const xs = zone.map((p) => p.x);
    const ys = zone.map((p) => p.y);
    expect(m.pos.x - r).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
    expect(m.pos.x + r).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
    expect(m.pos.y - r).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
    expect(m.pos.y + r).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
  });

  it('is placed automatically when an operative deploys, and again as a safety net at activation', () => {
    const { ctx, state } = setup();
    expect(state.markers[tunnelMarkerId('p1', 0)]).toBeUndefined();
    const after = activate(ctx, state, state.teams.p1.operativeIds[0]!);
    expect(after.markers[tunnelMarkerId('p1', 0)]).toBeDefined();
  });

  it('the STRATEGIC GAMBIT places the next numbered marker "wholly within 5" of your preceding Tunnel marker"', () => {
    const { ctx, state } = setup();
    ensureTunnelStart(state, 'p1');
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(TUNNEL_GAMBIT);
    const next = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: TUNNEL_GAMBIT }, ctx).state;
    const markers = tunnelMarkers(next, 'p1');
    expect(markers.map((m) => m.n)).toEqual([0, 1]);
    expect(tunnelStepLegal(markers[0]!.marker.pos, markers[1]!.marker.pos)).toBe(true);
    // It costs no CP — it is a faction rule, not one of the four strategy ploys.
    expect(next.teams.p1.cp).toBe(state.teams.p1.cp);
  });

  it('honours the supplied position, and refuses one more than 5" from the preceding marker', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 3, y: 11 }]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const good = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: TUNNEL_GAMBIT, data: { pos: { x: 7, y: 11 } } }, ctx).state;
    expect(good.markers[tunnelMarkerId('p1', 1)]!.pos).toEqual({ x: 7, y: 11 });
    expect(tunnelStepLegal({ x: 3, y: 11 }, { x: 9, y: 11 })).toBe(false);
  });

  it('"Once you have placed five Tunnel markers, don’t place any more", and only in the first four turning points', () => {
    const { ctx, state } = setup();
    expect(MAX_TUNNEL_MARKERS).toBe(5);
    tunnelAt(state, 'p1', [
      { x: 3, y: 11 },
      { x: 6, y: 11 },
      { x: 9, y: 11 },
      { x: 12, y: 11 },
      { x: 15, y: 11 },
    ]);
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(TUNNEL_GAMBIT);
    const fresh = setup();
    ensureTunnelStart(fresh.state, 'p1');
    fresh.state.phase = 'strategy';
    fresh.state.strategyStep = 'gambit';
    fresh.state.turningPoint = 5;
    expect(gambitOptions(fresh.ctx, fresh.state, 'p1').map((o) => o.id)).not.toContain(TUNNEL_GAMBIT);
  });

  it('"Operative B is on your TUNNEL as it’s touching one of your Tunnel markers"', () => {
    const { state } = setup();
    tunnelAt(state, 'p1', [{ x: 10, y: 11 }]);
    const op = place(state, state.teams.p1.operativeIds[0]!, 10.5, 11);
    expect(onTunnel(state, 'p1', op)).toBe(true);
    place(state, op.id, 14, 11);
    expect(onTunnel(state, 'p1', op)).toBe(false);
    expect(tunnelGap(state, 'p1', op)).toBeCloseTo(4 - 40 / 25.4 / 2 - 20 / 25.4 / 2, 3);
  });

  it('"operative A is on your TUNNEL as it’s on the area between markers 0 and 1"', () => {
    const { state } = setup();
    tunnelAt(state, 'p1', [
      { x: 6, y: 11 },
      { x: 11, y: 11 },
    ]);
    const op = place(state, state.teams.p1.operativeIds[0]!, 8.5, 11);
    isolate(state, [op.id]);
    expect(onTunnel(state, 'p1', op)).toBe(true);
    // Sideways off the corridor by more than the base + marker radius: no longer on it.
    place(state, op.id, 8.5, 13);
    expect(onTunnel(state, 'p1', op)).toBe(false);
  });

  it('"markers 1 and 3 are not sequential, so the area between those markers is not part of your TUNNEL"', () => {
    const { state } = setup();
    // Markers 0 and 2 exist, 1 does not: nothing joins them.
    tunnelAt(state, 'p1', [{ x: 6, y: 11 }]);
    state.markers[tunnelMarkerId('p1', 2)] = {
      id: tunnelMarkerId('p1', 2),
      kind: 'generic',
      diameterMm: 20,
      pos: { x: 16, y: 11 },
      z: 0,
      owner: 'p1',
      flags: { tunnel: 2 },
    };
    const op = place(state, state.teams.p1.operativeIds[0]!, 11, 11);
    isolate(state, [op.id]);
    expect(tunnelMarkers(state, 'p1').map((m) => m.n)).toEqual([0, 2]);
    expect(onTunnel(state, 'p1', op)).toBe(false);
  });

  it('the TUNNEL is measured through Wall terrain by construction, and the hazardous clause is reminder-only', () => {
    expect(ruleText(RULE.tunnel)).toContain('can be measured through Wall terrain');
    expect(ruleText(RULE.tunnel)).toContain('treated as a hazardous area');
    expect(REMINDER_ONLY[`${RULE.tunnel}.hazardous`]).toContain('no hook can add a hazardous area');
  });
});

// ---------------------------------------------------------------------------
describe('Burrow', () => {
  it('setUnderground is a pure setter and honours "your first two operatives must be set up as normal"', () => {
    const { state } = setup();
    expect(ruleText(RULE.burrow)).toContain('your first two operatives must be set up as normal');
    const ids = state.teams.p1.operativeIds;
    const done = setUnderground(state, 'p1', [...ids]);
    expect(done).toHaveLength(ids.length - 2); // 5 operatives → at most 3 underground
    for (const id of done) expect(isUnderground(state, state.operatives[id]!)).toBe(true);
    expect(REMINDER_ONLY[`${RULE.burrow}.setup`]).toContain('no decision channel');
  });

  it('"operatives set up underground are activated and can counteract as normal" — it is not removed', () => {
    const { ctx, state } = setup();
    const id = state.teams.p1.operativeIds[1]!;
    setUnderground(state, 'p1', [id]);
    const op = state.operatives[id]!;
    expect(op.removed).toBeUndefined();
    expect(aliveOperatives(state, 'p1').map((o) => o.id)).toContain(id);
    expect(op.pos.x).toBeLessThan(0); // "place it to one side instead of in the killzone"
    expect(op.pos.x).toBeGreaterThan(-50); // FinishSetup treats pos.x < -50 as "not deployed"
    const after = activate(ctx, state, id);
    expect(after.activeOperativeId).toBe(id);
  });

  it('"it cannot perform any actions other than Burrow" while underground', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.warrior);
    setUnderground(state, 'p1', [id]);
    const s = activate(ctx, state, id);
    const offered = availableActions(ctx, s, s.operatives[id]!).filter((a) => a.ok).map((a) => a.def.id);
    expect(offered).toEqual([BURROW]);
  });

  it('the FELLTALON’s printed override — "can perform this action while underground" — survives the ban', () => {
    const { ctx, state } = setup();
    expect(actionOf(CARD.felltalon, ACT.toxicLunge).text).toContain(
      'can perform this action while underground (this takes precedence over the normal Burrow rules)',
    );
    const id = opWith(state, 'p1', CARD.felltalon);
    tunnelAt(state, 'p1', [{ x: 10, y: 11 }]);
    const foe = place(state, state.teams.p2.operativeIds[0]!, 10.4, 11);
    isolate(state, [foe.id]);
    setUnderground(state, 'p1', [id]);
    const s = activate(ctx, state, id);
    const offered = availableActions(ctx, s, s.operatives[id]!).filter((a) => a.ok).map((a) => a.def.id);
    expect(offered).toContain(ACT.toxicLunge);
  });

  it('an underground operative is not in the killzone, so it cannot be selected as a valid target', () => {
    const { ctx, state } = setup();
    const shooter = place(state, opWith(state, 'p2', CARD.prime), 12, 11);
    const hider = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    hider.order = 'engage';
    place(state, hider.id, 15, 11);
    isolate(state, [shooter.id, hider.id]);
    const profile = profileOf(CARD.prime, 'Tail blade');
    const rules = effectiveRules(ctx, state, profile, { operative: shooter, target: hider, weaponName: 'Tail blade' });
    expect(checkTarget(ctx, state, shooter, hider, profile, rules).valid).toBe(true);
    setUnderground(state, 'p1', [hider.id]);
    expect(checkTarget(ctx, state, shooter, hider, profile, rules).valid).toBe(false);
  });

  it('BURROW: "if this operative is underground, set it up on your TUNNEL"; −2" Move until the end of the activation', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.warrior);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    isolate(state, [id]);
    setUnderground(state, 'p1', [id]);
    let s = activate(ctx, state, id);
    expect(moveOf(ctx, s, s.operatives[id]!)).toBe(7);
    const out = act(ctx, s, id, BURROW);
    expect(out.ok).toBe(true);
    s = out.state;
    const op = s.operatives[id]!;
    expect(isUnderground(s, op)).toBe(false);
    expect(onTunnel(s, 'p1', op)).toBe(true);
    expect(moveOf(ctx, s, op)).toBe(5); // "subtract 2\" from its Move stat"
  });

  it('BURROW: "if this operative is in the killzone and on your TUNNEL, remove it from the killzone"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.warrior);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    place(state, id, 12, 11);
    isolate(state, [id]);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, BURROW).state;
    expect(isUnderground(s, s.operatives[id]!)).toBe(true);
    // Off the TUNNEL the action is refused.
    const other = setup();
    tunnelAt(other.state, 'p1', [{ x: 3, y: 11 }]);
    const id2 = opWith(other.state, 'p1', CARD.warrior);
    place(other.state, id2, 20, 3);
    const s2 = activate(other.ctx, other.state, id2);
    expect(act(other.ctx, s2, id2, BURROW).ok).toBe(false);
  });

  it('"An operative cannot perform this action while carrying a marker."', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.warrior);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    place(state, id, 12, 11);
    const op = state.operatives[id]!;
    op.carryingMarkerId = 'centre';
    expect(getAction(BURROW)!.check(ctx, state, op, {}).ok).toBe(false);
    expect(getAction(BURROW)!.check(ctx, state, op, {}).reason).toContain('carrying a marker');
  });

  it('"At the end of the battle, each friendly RAVENER operative that’s underground is incapacitated"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.warrior);
    setUnderground(state, 'p1', [id]);
    state.turningPoint = 3;
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(state.operatives[id]!.incapacitated).toBeFalsy();
    state.turningPoint = state.maxTurningPoints;
    ctx.hooks.emit('onEndOfTP', state, { state });
    expect(state.operatives[id]!.incapacitated).toBe(true);
  });

  it('emergeSpot refuses a location that is not on your TUNNEL and finds one that is', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.warrior);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    isolate(state, [id]);
    setUnderground(state, 'p1', [id]);
    const op = state.operatives[id]!;
    expect(emergeSpot(ctx, state, op, { x: 25, y: 3 }).ok).toBe(false);
    const chosen = emergeSpot(ctx, state, op);
    expect(chosen.ok).toBe(true);
    expect(chosen.pos).toEqual({ x: 12, y: 11 });
  });
});

// ---------------------------------------------------------------------------
describe('Predatory Instincts', () => {
  it('"During each friendly RAVENER operative’s activation, it can perform two Fight actions"', () => {
    const { ctx, state } = setup();
    const me = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    const foe = place(state, state.teams.p2.operativeIds[0]!, 12.9, 11);
    isolate(state, [me.id, foe.id]);
    const def = getAction(FIGHT_AGAIN)!;
    expect(def.check(ctx, state, me, { targetId: foe.id }).ok).toBe(false); // no first Fight yet
    me.actionsThisActivation.push('Fight');
    expect(def.check(ctx, state, me, { targetId: foe.id }).ok).toBe(true);
    // Its own restriction key, so a THIRD Fight is refused by the reducer.
    expect(def.treatedAs).toBeUndefined();
    expect(ruleText(RULE.instincts)).toContain('it can perform two Fight actions');
  });

  it('"Each friendly RAVENER operative can counteract regardless of its order"', () => {
    const { ctx, state } = setup();
    for (const o of aliveOperatives(state, 'p1')) {
      o.order = 'conceal';
      o.expended = true;
      o.ready = false;
    }
    // `counteractCandidates` emits `onCounteract` with `allowed = (order === 'engage')` as the
    // DEFAULT (D-028), so a team rule can widen it rather than only narrow it.
    expect(counteractCandidates(ctx, state, 'p1').map((o) => o.id).sort()).toEqual(
      [...state.teams.p1.operativeIds].sort(),
    );
  });

  it('"…or change its order instead of performing an action" is a 1AP counteraction action', () => {
    const { ctx, state } = setup();
    const id = state.teams.p1.operativeIds[0]!;
    const op = state.operatives[id]!;
    op.order = 'conceal';
    const def = getAction(CHANGE_ORDER)!;
    expect(def.check(ctx, state, op, {}).ok).toBe(false);
    state.opState['counteract'] = { operativeId: id, actionsUsed: 0 };
    expect(def.ap).toBe(1); // "a counteraction must be a 1AP action"
    expect(def.check(ctx, state, op, {}).ok).toBe(true);
    def.perform(ctx, state, op, {});
    expect(op.order).toBe('engage');
  });

  it('"you can change its order FIRST" and the additional free Burrow are reminder-only', () => {
    expect(ruleText(RULE.instincts)).toContain('You can change its order first');
    expect(ruleText(RULE.instincts)).toContain('it can perform a free Burrow action');
    expect(REMINDER_ONLY[`${RULE.instincts}.orderFirst`]).toContain('onOrderChange');
    expect(REMINDER_ONLY[`${RULE.instincts}.freeBurrow`]).toContain('one action per counteraction');
  });
});

// ---------------------------------------------------------------------------
describe('Poison (rare weapon rule)', () => {
  it('"if you inflict damage with any critical successes, [it] gains one of your Poison tokens"', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', CARD.felltalon)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const profile = profileOf(CARD.felltalon, 'Toxic glands');
    const actx = attackCtx(shooter, foe, profile, 'Toxic glands');
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: actx, crit: false, struck: foe });
    expect(state.effects.some((e) => e.rule === POISON_TOKEN && e.operativeId === foe.id)).toBe(false);
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: actx, crit: true, struck: foe });
    expect(state.effects.some((e) => e.rule === POISON_TOKEN && e.operativeId === foe.id && e.player === 'p1')).toBe(true);
  });

  it('a weapon without the Poison rule never hands out a token', () => {
    const { ctx, state } = setup();
    const shooter = state.operatives[opWith(state, 'p1', CARD.prime)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const profile = profileOf(CARD.prime, 'Tail blade');
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, foe, profile, 'Tail blade'),
      crit: true,
      struck: foe,
    });
    expect(state.effects.some((e) => e.rule === POISON_TOKEN)).toBe(false);
  });

  it('"Whenever an operative that has one of your Poison tokens is activated, inflict D3 damage on it"', () => {
    const { ctx, state } = setup({ script: [5] }); // d3 = ceil(5/2) = 3
    const shooter = state.operatives[opWith(state, 'p1', CARD.felltalon)]!;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    ctx.hooks.emit('onStrikeResolved', state, {
      state,
      ctx: attackCtx(shooter, foe, profileOf(CARD.felltalon, 'Toxic scythes'), 'Toxic scythes', 'melee'),
      crit: true,
      struck: foe,
    });
    const before = foe.wounds;
    const after = activate(ctx, state, foe.id);
    expect(after.operatives[foe.id]!.wounds).toBe(before - 3);
  });
});

// ---------------------------------------------------------------------------
describe('Crush (rare weapon rule) and Reinforced Carapace', () => {
  const crushCtx = (state: GameState, wrecker: OperativeState, foe: OperativeState): AttackContext =>
    attackCtx(wrecker, foe, profileOf(CARD.wrecker, 'Scything talons & crushing claws'), 'Scything talons & crushing claws', 'melee');

  it('"If you win, inflict additional damage equal to the difference between the dice results"', () => {
    const { ctx, state } = setup({ script: [6, 2] });
    const wrecker = state.operatives[state.teams.p1.operativeIds[1]!]!;
    wrecker.datacardId = CARD.wrecker;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    const before = foe.wounds;
    ctx.hooks.emit('onStrikeResolved', state, { state, ctx: crushCtx(state, wrecker, foe), crit: false, struck: foe });
    expect(before - foe.wounds).toBe(3); // difference 4, "to a maximum of 3 additional damage"
  });

  it('a tie or a loss inflicts nothing, and W ≤ 9 adds 1 to your result', () => {
    const lose = setup({ script: [2, 5] });
    const w1 = lose.state.operatives[lose.state.teams.p1.operativeIds[1]!]!;
    w1.datacardId = CARD.wrecker;
    const f1 = lose.state.operatives[lose.state.teams.p2.operativeIds[0]!]!;
    const before1 = f1.wounds;
    lose.ctx.hooks.emit('onStrikeResolved', lose.state, { state: lose.state, ctx: crushCtx(lose.state, w1, f1), crit: true, struck: f1 });
    expect(f1.wounds).toBe(before1);
    // A 20-wound RAVENER never gets the +1; the rule's own text names the threshold.
    expect(abilityText(CARD.wrecker, AB.crush)).toContain('Wounds stat of 9 or less');
    const tie = setup({ script: [4, 4] });
    const w2 = tie.state.operatives[tie.state.teams.p1.operativeIds[1]!]!;
    w2.datacardId = CARD.wrecker;
    const f2 = tie.state.operatives[tie.state.teams.p2.operativeIds[0]!]!;
    const before2 = f2.wounds;
    tie.ctx.hooks.emit('onStrikeResolved', tie.state, { state: tie.state, ctx: crushCtx(tie.state, w2, f2), crit: false, struck: f2 });
    expect(f2.wounds).toBe(before2);
  });

  it('Reinforced Carapace: "Normal and Critical Dmg of 4 or more inflicts 1 less damage" — one strike, one dice', () => {
    const { ctx, state } = setup();
    const wrecker = state.operatives[state.teams.p1.operativeIds[1]!]!;
    wrecker.datacardId = CARD.wrecker;
    const foe = state.operatives[state.teams.p2.operativeIds[0]!]!;
    state.sequence = fightSeq({
      attackerId: foe.id,
      defenderId: wrecker.id,
      attackerWeapon: 'Scything talons',
      attacker: 'p2',
      defender: 'p1',
    });
    const before = wrecker.wounds;
    inflictDamage(ctx, state, wrecker, 5, 'attack'); // a Critical Dmg 5 strike
    expect(before - wrecker.wounds).toBe(4);
    const mid = wrecker.wounds;
    inflictDamage(ctx, state, wrecker, 3, 'attack'); // Dmg 3 is untouched
    expect(mid - wrecker.wounds).toBe(3);
  });

  it('Reinforced Carapace reduces a SHOOT’s aggregated total once per unblocked attack dice', () => {
    const { ctx, state } = setup();
    const wrecker = state.operatives[state.teams.p1.operativeIds[1]!]!;
    wrecker.datacardId = CARD.wrecker;
    const shooter = state.operatives[opWith(state, 'p2', CARD.prime)]!;
    // Tail blade: Normal Dmg 3, Critical Dmg 4 — only the crits are reduced.
    const seq = shootSeq({
      attackerId: shooter.id,
      targetId: wrecker.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Tail blade',
    });
    addRolled(seq.attack, [6, 6, 4], 3); // 2 crits + 1 normal
    state.sequence = seq;
    const before = wrecker.wounds;
    inflictDamage(ctx, state, wrecker, 2 * 4 + 1 * 3, 'attack');
    expect(before - wrecker.wounds).toBe(11 - 2); // −1 per Critical Dmg 4 dice
  });
});

// ---------------------------------------------------------------------------
describe('PRIME › Neuropredatory Crest and Synaptic Link', () => {
  it('"treat the total APL stat of enemy operatives that contest it as 1 lower"', () => {
    const { ctx, state } = setup();
    // The PRIME is within 3\" of the contesting enemy but does NOT contest the marker itself.
    const prime = place(state, opWith(state, 'p1', CARD.prime), 15, 13.6);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 15, 11.3);
    isolate(state, [prime.id, foe.id]);
    const marker = state.markers['centre'] ?? Object.values(state.markers)[0]!;
    marker.pos = { x: 15, y: 11 };
    // The lone contesting enemy (APL 3) is beaten down to 2 — still uncontested, so it holds it.
    expect(markerController(ctx, state, marker)).toBe('p2');
    const ev = ctx.hooks.emit('onMarkerControl', state, { state, markerId: marker.id, aplByPlayer: { p1: 0, p2: 3 } });
    expect(ev.aplByPlayer.p2).toBe(2);
    // Out of 3\" it is untouched.
    place(state, prime.id, 4, 3);
    const far = ctx.hooks.emit('onMarkerControl', state, { state, markerId: marker.id, aplByPlayer: { p1: 0, p2: 3 } });
    expect(far.aplByPlayer.p2).toBe(3);
  });

  it('"Your opponent must spend 1 additional AP … for the Pick Up Marker and mission actions"', () => {
    const { ctx, state } = setup();
    const prime = place(state, opWith(state, 'p1', CARD.prime), 15, 12);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 15, 11);
    isolate(state, [prime.id, foe.id]);
    expect(actionCost(ctx, state, foe, getAction('Pick Up Marker')!)).toBe(2);
    expect(actionCost(ctx, state, foe, getAction('Reposition')!)).toBe(1); // not a mission action
    place(state, prime.id, 25, 3);
    expect(actionCost(ctx, state, foe, getAction('Pick Up Marker')!)).toBe(1);
  });

  it('"Your opponent cannot re-roll their attack or defence dice for that operative"', () => {
    const { ctx, state } = setup();
    const prime = place(state, opWith(state, 'p1', CARD.prime), 15, 12);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 15, 11);
    isolate(state, [prime.id, foe.id]);
    const profile = profileOf(CARD.warrior, 'Pincer tail');
    const actx = attackCtx(foe, prime, profile, 'Pincer tail');
    const attack = ctx.hooks.emit('onRollAttack', state, {
      state,
      ctx: actx,
      dice: [],
      rerolls: [{ id: 'balanced', label: 'Balanced', mode: 'one', max: 1 }],
    });
    expect(attack.rerolls).toHaveLength(0);
    const defence = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(prime, foe, profileOf(CARD.prime, 'Tail blade'), 'Tail blade'),
      count: 0,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [{ id: 'commandReroll:defence', label: 'Command Re-roll', mode: 'one', max: 1, player: 'p2' }],
    });
    expect(defence.rerolls).toHaveLength(0);
  });

  it('the fighting/retaliating half of that re-roll ban is unreachable (D-031)', () => {
    expect(abilityText(CARD.prime, AB.crest)).toContain('cannot re-roll their attack or defence dice');
    expect(REMINDER_ONLY[`${AB.crest}.rerollFight`]).toContain('fight.ts emits no onRollAttack');
  });

  it('Synaptic Link: "Twice as high or higher, you gain 1CP"', () => {
    const { ctx, state } = setup({ script: [4] });
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    state.turningPoint = 2;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).toContain(SYNAPTIC_GAMBIT);
    const cp = state.teams.p1.cp;
    const next = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: SYNAPTIC_GAMBIT }, ctx).state;
    expect(next.teams.p1.cp).toBe(cp + 1);
  });

  it('Synaptic Link: "Less, inflict damage on this operative equal to the result" / "Any other result, nothing happens"', () => {
    const hurt = setup({ script: [2] });
    hurt.state.phase = 'strategy';
    hurt.state.strategyStep = 'gambit';
    hurt.state.turningPoint = 3;
    const prime = hurt.state.operatives[opWith(hurt.state, 'p1', CARD.prime)]!;
    const before = prime.wounds;
    const next = reduce(hurt.state, { t: 'UseGambit', player: 'p1', gambitId: SYNAPTIC_GAMBIT }, hurt.ctx).state;
    expect(next.operatives[prime.id]!.wounds).toBe(before - 2);
    const nothing = setup({ script: [3] });
    nothing.state.phase = 'strategy';
    nothing.state.strategyStep = 'gambit';
    nothing.state.turningPoint = 3; // 3 is neither < 3 nor >= 6
    const cp = nothing.state.teams.p1.cp;
    const p2 = nothing.state.operatives[opWith(nothing.state, 'p1', CARD.prime)]!;
    const w = p2.wounds;
    const after = reduce(nothing.state, { t: 'UseGambit', player: 'p1', gambitId: SYNAPTIC_GAMBIT }, nothing.ctx).state;
    expect(after.teams.p1.cp).toBe(cp);
    expect(after.operatives[p2.id]!.wounds).toBe(w);
  });

  it('Synaptic Link is not offered once the PRIME is incapacitated', () => {
    const { ctx, state } = setup();
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    state.operatives[opWith(state, 'p1', CARD.prime)]!.incapacitated = true;
    expect(gambitOptions(ctx, state, 'p1').map((o) => o.id)).not.toContain(SYNAPTIC_GAMBIT);
  });
});

// ---------------------------------------------------------------------------
describe('TREMORSCYTHE', () => {
  it('Subterranean Ambush is reminder-only but its printed trigger is recorded as a token', () => {
    const { ctx, state } = setup();
    const scythe = opWith(state, 'p1', CARD.tremorscythe);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    setUnderground(state, 'p1', [scythe]);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 20, 11);
    isolate(state, [foe.id]);
    let s = activate(ctx, state, foe.id);
    s = act(ctx, s, foe.id, 'Reposition', { path: { points: [{ x: 13.5, y: 11 }] } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'raveners.subterraneanAmbush' && e.operativeId === foe.id)).toBe(true);
    expect(REMINDER_ONLY[AB.ambush]).toContain('activation-order seam');
  });

  it('the token is not placed when the enemy moved 2" or less', () => {
    const { ctx, state } = setup();
    const scythe = opWith(state, 'p1', CARD.tremorscythe);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    setUnderground(state, 'p1', [scythe]);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 14, 11);
    isolate(state, [foe.id]);
    let s = activate(ctx, state, foe.id);
    s = act(ctx, s, foe.id, 'Reposition', { path: { points: [{ x: 13.5, y: 11 }] } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    expect(s.effects.some((e) => e.rule === 'raveners.subterraneanAmbush')).toBe(false);
  });

  it('Hypersensory Hunter: "can perform the Charge action while it has a Conceal order if it performed the Burrow action"', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.tremorscythe);
    const op = place(state, id, 12, 11);
    op.order = 'conceal';
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 15, 11);
    isolate(state, [id, foe.id]);
    const def = getAction(CHARGE_HYPERSENSORY)!;
    const params = { path: { points: [{ x: 14.2, y: 11 }] } };
    expect(def.check(ctx, state, op, params).ok).toBe(false);
    expect(def.check(ctx, state, op, params).reason).toContain('Burrow action');
    op.actionsThisActivation.push(BURROW);
    expect(def.check(ctx, state, op, params).ok).toBe(true);
    expect(def.treatedAs).toBe('Charge'); // action restrictions stay shared with the universal Charge
    // The universal Charge still refuses a Conceal order.
    expect(getAction('Charge')!.check(ctx, state, op, params).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('WARRIOR › Instinctive Behaviour', () => {
  const lethal = (rules: { id: string; x?: number }[]): boolean =>
    rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) === 5);

  it('grants Lethal 5+ against a WOUNDED enemy when shooting', () => {
    const { ctx, state } = setup();
    const warrior = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.warrior)]!;
    const profile = profileOf(CARD.warrior, 'Pincer tail');
    expect(lethal(effectiveRules(ctx, state, profile, { operative: warrior, target: foe, weaponName: 'Pincer tail' }))).toBe(false);
    foe.wounds -= 1; // "a wounded enemy operative"
    expect(lethal(effectiveRules(ctx, state, profile, { operative: warrior, target: foe, weaponName: 'Pincer tail' }))).toBe(true);
  });

  it('is live when fighting AND when retaliating — `onWeaponRules` is read by both sequences', () => {
    const { ctx, state } = setup();
    const warrior = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.warrior)]!;
    foe.wounds -= 1;
    const melee = profileOf(CARD.warrior, 'Scything talons');
    expect(
      lethal(effectiveRules(ctx, state, melee, { operative: warrior, target: foe, weaponName: 'Scything talons' })),
    ).toBe(true);
    expect(
      lethal(
        effectiveRules(ctx, state, melee, {
          operative: warrior,
          target: foe,
          weaponName: 'Scything talons',
          retaliating: true,
        }),
      ),
    ).toBe(true);
    expect(abilityText(CARD.warrior, AB.instinctive)).toContain('shooting against, fighting against or retaliating against');
  });

  it('"…or an enemy operative that performed the Fall Back action during this turning point"', () => {
    const { ctx, state } = setup();
    const warrior = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const me = place(state, warrior.id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 12.9, 11);
    isolate(state, [me.id, foe.id]);
    const profile = profileOf(CARD.warrior, 'Scything talons');
    const read = (): boolean =>
      lethal(effectiveRules(ctx, state, profile, { operative: warrior, target: state.operatives[foe.id]!, weaponName: 'Scything talons' }));
    expect(read()).toBe(false);
    let s = activate(ctx, state, foe.id);
    s = act(ctx, s, foe.id, 'Fall Back', { path: { points: [{ x: 18, y: 11 }] } }).state;
    s = reduce(s, { t: 'EndActivation', operativeId: foe.id }, ctx).state;
    // The per-turning-point ledger survives the end of that operative's activation.
    expect(
      lethal(
        effectiveRules(ctx, s, profile, {
          operative: s.operatives[warrior.id]!,
          target: s.operatives[foe.id]!,
          weaponName: 'Scything talons',
        }),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Unique actions', () => {
  it('TOXIC LUNGE: "Select one enemy operative within 2"… Inflict D3+2 damage … and it gains one of your Poison tokens"', () => {
    const { ctx, state } = setup({ script: [3] }); // d3 = 2
    const id = opWith(state, 'p1', CARD.felltalon);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 14.5, 11);
    isolate(state, [id, foe.id]);
    const def = getAction(ACT.toxicLunge)!;
    // 40mm bases: base-to-base 2.5 − 1.575 = 0.93", inside 2".
    expect(def.check(ctx, state, me, { targetOperativeId: foe.id }).ok).toBe(true);
    const before = state.operatives[foe.id]!.wounds;
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, ACT.toxicLunge, { targetOperativeId: foe.id }).state;
    expect(s.operatives[foe.id]!.wounds).toBe(before - 4);
    expect(s.effects.some((e) => e.rule === POISON_TOKEN && e.operativeId === foe.id)).toBe(true);
  });

  it('TOXIC LUNGE refuses an enemy out of range, and every legality lives in `check` (D-026)', () => {
    const { ctx, state } = setup();
    const me = place(state, opWith(state, 'p1', CARD.felltalon), 5, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 25, 11);
    isolate(state, [me.id, foe.id]);
    const def = getAction(ACT.toxicLunge)!;
    expect(def.check(ctx, state, me, { targetOperativeId: foe.id }).ok).toBe(false);
    expect(def.check(ctx, state, me, {}).ok).toBe(false);
    expect(def.check(ctx, state, me, {}).reason).toContain('within 2"');
  });

  it('TOXIC LUNGE while underground: "select one enemy operative on your TUNNEL"', () => {
    const { ctx, state } = setup({ script: [1] });
    const id = opWith(state, 'p1', CARD.felltalon);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 12.4, 11);
    isolate(state, [foe.id]);
    setUnderground(state, 'p1', [id]);
    const me = state.operatives[id]!;
    expect(onTunnel(state, 'p1', state.operatives[foe.id]!)).toBe(true);
    expect(getAction(ACT.toxicLunge)!.check(ctx, state, me, {}).ok).toBe(true);
    // An enemy off the TUNNEL is not selectable.
    place(state, foe.id, 25, 3);
    expect(getAction(ACT.toxicLunge)!.check(ctx, state, me, {}).ok).toBe(false);
  });

  it('DISTEND DORSAL SAC: Lethal 5+, +1 Atk and the Range 8" rule removed on ALL venom bolt profiles', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.venomspitter);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, ACT.distend).state;
    const op = s.operatives[id]!;
    expect(distendActive(s, op)).toBe(true);
    for (const name of ['blast', 'focused']) {
      const profile = profileOf(CARD.venomspitter, 'Venom bolt', name);
      const rules = effectiveRules(ctx, s, profile, { operative: op, weaponName: 'Venom bolt' });
      expect(rules.some((r) => r.id === 'Lethal' && r.x === 5)).toBe(true);
      expect(rules.some((r) => r.id === 'Range')).toBe(false);
      // D-019: the shared datacard profile is never rewritten.
      expect(profile.rules.some((r) => r.id === 'Range')).toBe(true);
    }
    const foe = s.operatives[s.teams.p2.operativeIds[0]!]!;
    const dice = ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(op, foe, profileOf(CARD.venomspitter, 'Venom bolt', 'focused'), 'Venom bolt'),
      count: 4,
      mods: zeroStatMods(),
    });
    expect(dice.count).toBe(5); // "have 1 added to their Atk stat"
  });

  it('DISTEND DORSAL SAC ends when the operative performs the Burrow action', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.venomspitter);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    place(state, id, 12, 11);
    isolate(state, [id]);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, ACT.distend).state;
    expect(distendActive(s, s.operatives[id]!)).toBe(true);
    s = act(ctx, s, id, BURROW).state;
    expect(s.effects.some((e) => e.rule === DISTEND && e.operativeId === id)).toBe(false);
  });

  it('DISTEND DORSAL SAC lasts "until this operative has shot with its venom bolt" and no longer', () => {
    const { ctx, state } = setup();
    const id = opWith(state, 'p1', CARD.venomspitter);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, ACT.distend).state;
    const op = s.operatives[id]!;
    const foe = s.operatives[s.teams.p2.operativeIds[0]!]!;
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(op, foe, profileOf(CARD.venomspitter, 'Venom bolt', 'blast'), 'Venom bolt'),
      count: 4,
      mods: zeroStatMods(),
    });
    // The whole Shoot action (Blast secondaries included) keeps the benefit…
    expect(distendActive(s, op)).toBe(true);
    s = reduce(s, { t: 'EndActivation', operativeId: id }, ctx).state;
    // …and it is spent at the end of that activation.
    expect(distendActive(s, s.operatives[id]!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Strategy ploys', () => {
  const useGambit = (ctx: GameContext, state: GameState, id: string, data?: Record<string, unknown>): GameState => {
    state.phase = 'strategy';
    state.strategyStep = 'gambit';
    const out = reduce(state, { t: 'UseGambit', player: 'p1', gambitId: id, ...(data ? { data } : {}) }, ctx);
    const s = out.state;
    s.phase = 'firefight';
    s.firefightStep = 'performActions';
    return s;
  };

  it('DEATH FROM BELOW: Balanced after a Burrow this activation, Ceaseless while on your TUNNEL', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const op = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    isolate(state, [op.id]);
    const s = useGambit(ctx, state, SP.deathFromBelow);
    const me = s.operatives[op.id]!;
    const melee = profileOf(CARD.warrior, 'Scything talons');
    let rules = effectiveRules(ctx, s, melee, { operative: me, weaponName: 'Scything talons' });
    expect(rules.some((r) => r.id === 'Ceaseless')).toBe(true);
    expect(rules.some((r) => r.id === 'Balanced')).toBe(false);
    me.actionsThisActivation.push(BURROW);
    rules = effectiveRules(ctx, s, melee, { operative: me, weaponName: 'Scything talons' });
    expect(rules.some((r) => r.id === 'Balanced')).toBe(true);
    // "Whenever a friendly RAVENER operative is FIGHTING" — not while retaliating.
    rules = effectiveRules(ctx, s, melee, { operative: me, weaponName: 'Scything talons', retaliating: true });
    expect(rules.some((r) => r.id === 'Ceaseless' || r.id === 'Balanced')).toBe(false);
  });

  it('WHIPCORD EMERGENCE: re-roll ONE defence dice after a Burrow this TP, ANY while on your TUNNEL', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const target = place(state, opWith(state, 'p1', CARD.warrior), 20, 3);
    // NOT a PRIME: an enemy PRIME within 3" would itself forbid the re-roll (Neuropredatory Crest).
    const shooter = place(state, opWith(state, 'p2', CARD.venomspitter), 22, 3);
    isolate(state, [target.id, shooter.id]);
    let s = useGambit(ctx, state, SP.whipcordEmergence);
    const roll = (st: GameState) =>
      ctx.hooks.emit('onDefenceDice', st, {
        state: st,
        ctx: attackCtx(
          st.operatives[shooter.id]!,
          st.operatives[target.id]!,
          profileOf(CARD.venomspitter, 'Venom bolt', 'focused'),
          'Venom bolt',
        ),
        count: 0,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).rerolls;
    expect(roll(s)).toHaveLength(0);
    // A Burrow this turning point → one dice.
    s.operatives[target.id]!.actionsThisActivation = [];
    s.opState['raveners.burrowedTP'] = { [target.id]: s.turningPoint };
    expect(roll(s).map((g) => g.mode)).toEqual(['one']);
    // On your TUNNEL → any dice.
    place(s, target.id, 12, 11);
    expect(roll(s).map((g) => g.mode)).toEqual(['any']);
  });

  it('WRITHE OUT OF SIGHT grants a free Burrow (and a free Reposition within 2" of your TUNNEL)', () => {
    expect(ruleText(SP.writheOutOfSight)).toContain('can immediately perform a free Burrow action');
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const op = place(state, opWith(state, 'p1', CARD.warrior), 13, 11);
    isolate(state, [op.id]);
    const s = useGambit(ctx, state, SP.writheOutOfSight, { operativeId: op.id });
    const me = s.operatives[op.id]!;
    // A free action is an action, not an APL stat change: the printed APL 3 is untouched and
    // the operative has a fourth AP to spend on the named actions (docs/DECISIONS.md D-100).
    expect(me.aplMods).toEqual([]);
    expect(aplOf(ctx, s, me)).toBe(3);
    expect(freeApOf(s, me)).toBe(1);
    expect(apBudgetOf(ctx, s, me)).toBe(4);
    const eff = s.effects.find((e) => e.rule === 'teamFreeAction' && e.operativeId === me.id)!;
    expect(eff.data?.['only']).toEqual([BURROW, 'Reposition', 'Fall Back']);
    // The ploy is a STRATEGIC GAMBIT, so the AP waits for the operative's own activation and
    // expires with it — this module does not have to take it back.
    const after = reduce(activate(ctx, s, me.id), { t: 'EndActivation', operativeId: me.id }, ctx).state;
    expect(freeApOf(after, after.operatives[me.id]!)).toBe(0);
    expect(apBudgetOf(ctx, after, after.operatives[me.id]!)).toBe(3);
    // "it can immediately perform a free Fall Back" is one AP against a 2AP action.
    expect(REMINDER_ONLY[`${SP.writheOutOfSight}.fallBack`]).toContain('Fall Back costs 2AP');
  });

  it('TUNNEL LURKERS: a Conceal-order operative on your TUNNEL stops being a valid target', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const target = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    target.order = 'conceal';
    const shooter = place(state, opWith(state, 'p2', CARD.prime), 12, 15);
    isolate(state, [target.id, shooter.id]);
    const profile = profileOf(CARD.venomspitter, 'Venom bolt', 'focused');
    const rules = effectiveRules(ctx, state, profile, { operative: shooter, target, weaponName: 'Venom bolt' });
    expect(checkTarget(ctx, state, shooter, target, profile, rules).valid).toBe(true);
    const s = useGambit(ctx, state, SP.tunnelLurkers);
    s.activeOperativeId = shooter.id;
    const after = checkTarget(ctx, s, s.operatives[shooter.id]!, s.operatives[target.id]!, profile, rules);
    expect(after.valid).toBe(false);
    expect(after.reason).toContain('Tunnel Lurkers');
  });

  it('TUNNEL LURKERS: "unless it’s within 2" of the active operative", and it grants a cover save', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const target = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    target.order = 'conceal';
    const shooter = place(state, opWith(state, 'p2', CARD.prime), 12, 15);
    isolate(state, [target.id, shooter.id]);
    const s = useGambit(ctx, state, SP.tunnelLurkers);
    s.activeOperativeId = shooter.id;
    const cover = (st: GameState) =>
      ctx.hooks.emit('onDefenceDice', st, {
        state: st,
        ctx: attackCtx(st.operatives[shooter.id]!, st.operatives[target.id]!, profileOf(CARD.prime, 'Tail blade'), 'Tail blade'),
        count: 3,
        coverSave: false,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).coverSave;
    expect(cover(s)).toBe(true);
    place(s, shooter.id, 13.2, 11); // base-to-base under 2"
    expect(cover(s)).toBe(false);
  });

  it('TUNNEL LURKERS is Light cover, so Seek Light takes it away', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const target = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    target.order = 'conceal';
    const shooter = place(state, opWith(state, 'p2', CARD.venomspitter), 12, 15);
    isolate(state, [target.id, shooter.id]);
    const s = useGambit(ctx, state, SP.tunnelLurkers);
    s.activeOperativeId = shooter.id;
    const seek = { ...profileOf(CARD.venomspitter, 'Venom bolt', 'focused') };
    seek.rules = [...seek.rules, { id: 'SeekLight', raw: 'Seek Light' }];
    const rules = effectiveRules(ctx, s, seek, { operative: s.operatives[shooter.id]!, target: s.operatives[target.id]!, weaponName: 'Venom bolt' });
    expect(checkTarget(ctx, s, s.operatives[shooter.id]!, s.operatives[target.id]!, seek, rules).valid).toBe(true);
    expect(ruleText(SP.tunnelLurkers)).toContain('e.g. Seek Light and Vantage terrain');
  });
});

// ---------------------------------------------------------------------------
describe('Firefight ploys', () => {
  const usePloy = (ctx: GameContext, state: GameState, id: string, data?: Record<string, unknown>): GameState =>
    reduce(state, { t: 'UsePloy', player: 'p1', ployId: id, ...(data ? { data } : {}) }, ctx).state;

  it('SLITHERING EVASION: "Perform the Fall Back action for 1 less AP"', () => {
    const { ctx, state } = setup();
    const me = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 12.9, 11);
    isolate(state, [me.id, foe.id]);
    expect(actionCost(ctx, state, me, getAction('Fall Back')!)).toBe(2);
    let s = activate(ctx, state, me.id);
    s = usePloy(ctx, s, FP.slitheringEvasion);
    expect(actionCost(ctx, s, s.operatives[me.id]!, getAction('Fall Back')!)).toBe(1);
  });

  it('SLITHERING EVASION: "Perform the Charge action while within control range of an enemy operative"', () => {
    const { ctx, state } = setup();
    const me = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 12.9, 11);
    const other = place(state, opWith(state, 'p2', CARD.prime), 17, 11);
    isolate(state, [me.id, foe.id, other.id]);
    const params = { path: { points: [{ x: 15.4, y: 11 }] } };
    // The universal Charge refuses: "already within control range of an enemy operative".
    expect(getAction('Charge')!.check(ctx, state, me, params).ok).toBe(false);
    let s = activate(ctx, state, me.id);
    s = usePloy(ctx, s, FP.slitheringEvasion);
    const def = getAction(CHARGE_SLITHERING)!;
    expect(def.available!(ctx, s, s.operatives[me.id]!)).toBe(true);
    expect(def.check(ctx, s, s.operatives[me.id]!, params).ok).toBe(true);
    expect(def.treatedAs).toBe('Charge');
  });

  it('SUBTERRANEAN HORROR: "you resolve the first attack dice (i.e. defender instead of attacker)"', () => {
    const { ctx, state } = setup();
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const me = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 12.9, 11);
    isolate(state, [me.id, foe.id]);
    let s = usePloy(ctx, state, FP.subterraneanHorror);
    expect(s.effects.some((e) => e.rule === 'raveners.subterraneanHorror')).toBe(true);
    const seq = fightSeq({
      attackerId: foe.id,
      defenderId: me.id,
      attackerWeapon: 'Scything talons',
      attacker: 'p2',
      defender: 'p1',
    });
    s.sequence = seq;
    ctx.hooks.emit('onCollectAttackDice', s, {
      state: s,
      ctx: attackCtx(s.operatives[foe.id]!, s.operatives[me.id]!, profileOf(CARD.warrior, 'Scything talons'), 'Scything talons', 'melee'),
      count: 5,
      mods: zeroStatMods(),
    });
    expect(seq.turn).toBe('defender');
    expect(s.effects.some((e) => e.rule === 'raveners.subterraneanHorror')).toBe(false);
  });

  it('SUBTERRANEAN HORROR is unusable while no friendly RAVENER is on your TUNNEL', () => {
    const { state } = setup();
    const ploy = raveners.ploys.find((p) => p.id === FP.subterraneanHorror)!;
    expect(ploy.usable!(state, 'p1').ok).toBe(false);
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
  });

  it('BURROWING STRIKE: "inflict D3+1 damage on each enemy operative within its control range"', () => {
    const { ctx, state } = setup({ script: [5] }); // d3 = 3
    tunnelAt(state, 'p1', [{ x: 12, y: 11 }]);
    const me = place(state, opWith(state, 'p1', CARD.warrior), 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 13.5, 11);
    isolate(state, [me.id, foe.id]);
    let s = activate(ctx, state, me.id);
    s = usePloy(ctx, s, FP.burrowingStrike);
    const before = s.operatives[foe.id]!.wounds;
    s = act(ctx, s, me.id, BURROW).state;
    expect(isUnderground(s, s.operatives[me.id]!)).toBe(true);
    expect(s.operatives[foe.id]!.wounds).toBe(before - 4);
  });

  it('BURROWING STRIKE: "You cannot use this ploy in the Strategy phase", or with a FELLTALON’s Toxic Lunge', () => {
    const { ctx, state } = setup();
    const ploy = raveners.ploys.find((p) => p.id === FP.burrowingStrike)!;
    state.phase = 'strategy';
    expect(ploy.usable!(state, 'p1').ok).toBe(false);
    state.phase = 'firefight';
    expect(ploy.usable!(state, 'p1').ok).toBe(true);
    // "…and vice versa": Toxic Lunge locks Burrowing Strike out of that activation.
    const id = opWith(state, 'p1', CARD.felltalon);
    const me = place(state, id, 12, 11);
    const foe = place(state, opWith(state, 'p2', CARD.warrior), 13.5, 11);
    isolate(state, [id, foe.id]);
    let s = activate(ctx, state, id);
    s = act(ctx, s, id, ACT.toxicLunge, { targetOperativeId: foe.id }).state;
    expect(ploy.usable!(s, 'p1').ok).toBe(false);
    expect(getAction(ACT.toxicLunge)!.check(ctx, s, s.operatives[id]!, { targetOperativeId: foe.id }).ok).toBe(false);
  });

  it('DEATH FRENZY: D3 damage to each enemy in control range, 2D3 for a VENOMSPITTER benefitting from Distend Dorsal Sac', () => {
    const plain = setup({ script: [5] });
    const me = place(plain.state, opWith(plain.state, 'p1', CARD.warrior), 12, 11);
    const foe = place(plain.state, opWith(plain.state, 'p2', CARD.warrior), 13.5, 11);
    isolate(plain.state, [me.id, foe.id]);
    let s = reduce(plain.state, { t: 'UsePloy', player: 'p1', ployId: FP.deathFrenzy }, plain.ctx).state;
    const before = s.operatives[foe.id]!.wounds;
    inflictDamage(plain.ctx, s, s.operatives[me.id]!, 999, 'other');
    expect(s.operatives[foe.id]!.wounds).toBe(before - 3);

    const buffed = setup({ script: [5, 5] });
    const vid = opWith(buffed.state, 'p1', CARD.venomspitter);
    const v = place(buffed.state, vid, 12, 11);
    const f2 = place(buffed.state, opWith(buffed.state, 'p2', CARD.warrior), 13.5, 11);
    isolate(buffed.state, [vid, f2.id]);
    let s2 = activate(buffed.ctx, buffed.state, vid);
    s2 = act(buffed.ctx, s2, vid, ACT.distend).state;
    s2 = reduce(s2, { t: 'UsePloy', player: 'p1', ployId: FP.deathFrenzy }, buffed.ctx).state;
    const b2 = s2.operatives[f2.id]!.wounds;
    inflictDamage(buffed.ctx, s2, s2.operatives[vid]!, 999, 'other');
    expect(s2.operatives[f2.id]!.wounds).toBe(b2 - 6);
    expect(v.id).toBe(vid);
  });
});

// ---------------------------------------------------------------------------
describe('Faction equipment', () => {
  it('CHROMATOSPORE CAMOUFLAGE: "you can retain one additional cover save", never with Vantage’s improved one', () => {
    const { ctx, state } = setup({ equipment: [EQ.chromatospore] });
    const target = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.prime)]!;
    const emit = (over: Partial<ShootSequence> = {}) => {
      state.sequence = shootSeq({
        attackerId: shooter.id,
        targetId: target.id,
        attacker: 'p2',
        defender: 'p1',
        weaponName: 'Tail blade',
        ...over,
      });
      return ctx.hooks.emit('onDefenceDice', state, {
        state,
        ctx: attackCtx(shooter, target, profileOf(CARD.prime, 'Tail blade'), 'Tail blade'),
        count: 3,
        coverSave: true,
        coverSaveAsCrit: false,
        extraCoverSaves: 0,
        mods: zeroStatMods(),
        rerolls: [],
      }).extraCoverSaves;
    };
    expect(emit()).toBe(1);
    expect(emit({ vantageImprovedCover: true })).toBe(0);
  });

  it('CHROMATOSPORE CAMOUFLAGE does nothing when no cover save can be retained', () => {
    const { ctx, state } = setup({ equipment: [EQ.chromatospore] });
    const target = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const shooter = state.operatives[opWith(state, 'p2', CARD.prime)]!;
    const ev = ctx.hooks.emit('onDefenceDice', state, {
      state,
      ctx: attackCtx(shooter, target, profileOf(CARD.prime, 'Tail blade'), 'Tail blade'),
      count: 3,
      coverSave: false,
      coverSaveAsCrit: false,
      extraCoverSaves: 0,
      mods: zeroStatMods(),
      rerolls: [],
    });
    expect(ev.extraCoverSaves).toBe(0);
  });

  it('ACID BLOOD: "roll one D6: on a 5+, inflict 1 damage on the enemy operative in that sequence"', () => {
    const { ctx, state } = setup({ equipment: [EQ.acidBlood], script: [5] });
    const me = state.operatives[opWith(state, 'p1', CARD.warrior)]!;
    const foe = state.operatives[opWith(state, 'p2', CARD.warrior)]!;
    state.sequence = fightSeq({
      attackerId: foe.id,
      defenderId: me.id,
      attackerWeapon: 'Scything talons',
      attacker: 'p2',
      defender: 'p1',
    });
    const before = foe.wounds;
    inflictDamage(ctx, state, me, 4, 'attack');
    expect(foe.wounds).toBe(before - 1);
  });

  it('ACID BLOOD does nothing on a 4 or less, and never outside a fight', () => {
    const low = setup({ equipment: [EQ.acidBlood], script: [4] });
    const me = low.state.operatives[opWith(low.state, 'p1', CARD.warrior)]!;
    const foe = low.state.operatives[opWith(low.state, 'p2', CARD.warrior)]!;
    low.state.sequence = fightSeq({
      attackerId: foe.id,
      defenderId: me.id,
      attackerWeapon: 'Scything talons',
      attacker: 'p2',
      defender: 'p1',
    });
    const before = foe.wounds;
    inflictDamage(low.ctx, low.state, me, 4, 'attack');
    expect(foe.wounds).toBe(before);
    // A shoot is not "fighting or retaliating".
    const shot = setup({ equipment: [EQ.acidBlood], script: [6] });
    const m2 = shot.state.operatives[opWith(shot.state, 'p1', CARD.warrior)]!;
    const f2 = shot.state.operatives[opWith(shot.state, 'p2', CARD.warrior)]!;
    shot.state.sequence = shootSeq({
      attackerId: f2.id,
      targetId: m2.id,
      attacker: 'p2',
      defender: 'p1',
      weaponName: 'Pincer tail',
    });
    const b2 = f2.wounds;
    inflictDamage(shot.ctx, shot.state, m2, 3, 'attack');
    expect(f2.wounds).toBe(b2);
  });

  it('METAMORPHIC FLESH: "Whenever a friendly RAVENER operative is activated, it regains up to D3 lost wounds"', () => {
    const { ctx, state } = setup({ equipment: [EQ.metamorphicFlesh], script: [5] }); // d3 = 3
    const id = opWith(state, 'p1', CARD.warrior);
    state.operatives[id]!.wounds = 10;
    let s = activate(ctx, state, id);
    expect(s.operatives[id]!.wounds).toBe(13);
    // "up to" — it never overshoots the starting wounds.
    const full = setup({ equipment: [EQ.metamorphicFlesh], script: [5] });
    const id2 = opWith(full.state, 'p1', CARD.warrior);
    full.state.operatives[id2]!.wounds = 19;
    s = activate(full.ctx, full.state, id2);
    expect(s.operatives[id2]!.wounds).toBe(20);
  });

  it('HEIGHTENED SENSES is reminder-only: an initiative re-roll has no expression', () => {
    expect(ruleText(EQ.heightenedSenses)).toContain('you can re-roll your dice');
    expect(REMINDER_ONLY[EQ.heightenedSenses]).toContain('rerollOffered is never consulted');
  });
});

// ---------------------------------------------------------------------------
describe('AI hints', () => {
  it('every datacard has a role, every ploy a value and every equipment option a value', () => {
    const hints = raveners.aiHints!;
    expect(Object.keys(hints.roles!).sort()).toEqual(DATA.datacards.map((c) => c.id).sort());
    expect(Object.keys(hints.ployValue!).sort()).toEqual(raveners.ploys.map((p) => p.id).sort());
    expect(Object.keys(hints.equipmentValue!).sort()).toEqual(DATA.equipment.map((e) => e.id).sort());
    // HEIGHTENED SENSES is reminder-only, so the AI is told not to spend a slot on it.
    expect(hints.equipmentValue![EQ.heightenedSenses]).toBeLessThan(0.1);
  });

  it('the module exposes the printed keyword and the effect ids the UI reads', () => {
    expect(KW).toBe('RAVENER');
    expect(UNDERGROUND).toBe('raveners.underground');
    expect(POISON_TOKEN).toBe('raveners.poison');
    expect(pool([6], 3).dice[0]!.state).toBe('crit'); // the shared dice helper behaves as expected
  });
});


// ---------------------------------------------------------------------------
describe('bot-vs-bot mirror soak', () => {
  // The bar (CLAUDE.md §Architecture 1): zero rejected intents and no exceptions. The shared
  // ring in tests/teams/soak.test.ts covers the batch; this mirror exercises the Tunnel gambit,
  // the Burrow action and the two extra STRATEGIC GAMBITs on both an open and a Close Quarters
  // killzone.
  for (const mapId of ['volkus-1', 'gallowdark-1']) {
    it(`plays a full battle on ${mapId} with no rejected intents`, () => {
      clearDeployCache();
      clearMoveCache();
      const ctx = teamContext([raveners], { seed: 5150 });
      const map = mapById(mapId);
      ctx.maps.set(map.id, map);
      const roster = () => defaultRoster(DATA).map((p) => ({ datacardId: p.datacardId }));
      const result = playGame({
        ctx,
        map,
        seed: 5150,
        rosters: {
          p1: { teamId: 'raveners', operatives: roster(), equipment: [EQ.chromatospore, EQ.acidBlood] },
          p2: { teamId: 'raveners', operatives: roster(), equipment: [EQ.metamorphicFlesh, EQ.heightenedSenses] },
        },
        agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
        maxIntents: 4000,
      });
      expect(result.rejected).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.state.phase).toBe('battleEnd');
      // Both players' Tunnel markers were laid down, and the Burrow action was used.
      expect(Object.keys(result.state.markers).filter((k) => k.startsWith('raveners.tunnel.p1.')).length).toBeGreaterThan(1);
      expect(result.state.log.some((l) => /burrows up|is now underground/.test(l.text))).toBe(true);
    }, 120000);
  }
});
