/**
 * CANOPTEK CIRCLE — Necrons. https://wahapedia.ru/kill-team3/kill-teams/canoptek-circle/
 * Every printed string quoted here is read from `data/teams/canoptek-circle.json`.
 *
 * The whole team hangs off one piece of board state: **your three OBELISK NODE markers** and the
 * OBELISK NODE MATRIX they project. Fourteen rules read `withinMatrix` / `matrixIntervenes`, so
 * the geometry lives in one place at the top of this file (the Wolf Scouts' per-player STORM
 * marker shape, generalised to three markers and an area rather than one marker and a radius).
 *
 * Rare weapon rule: `Dimensional Banishment` (Canoptek Tomb Crawler's transdimensional isolator).
 */
import { accessPointGap, getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { countCrits, piercingValue } from '../../core/dice.ts';
import { baseGap, baseRadius, baseWhollyWithin, basesOverlap, dist, distancePointToSegment, mmToInches, pointInPoly, segmentCrossesPoly, segmentsIntersect } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import {
  aliveOperatives,
  body,
  card as cardOf,
  enemiesInControlRange,
  inflictDamage,
  aplOf,
  log,
  modelHeight,
  moveOf,
  recordRoll,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseDistanceToPart, baseTouchesHazardous, surfaceAt } from '../../core/terrain.ts';
import { coverAndObscured, isVisible, withinControlRange, type Body } from '../../core/visibility.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Poly,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  centroidOf,
  currentApl,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  effectsOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  notEngaged,
  placeTeamMarker,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  useOncePerBattle,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('canoptek-circle');
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const card = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  card(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  card(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const KW = 'CANOPTEK CIRCLE';
const CANOPTEK = 'CANOPTEK';

export const CARD = {
  geomancer: 'canoptek-circle.geomancer',
  accelerator: 'canoptek-circle.macrocyte-accelerator',
  reanimator: 'canoptek-circle.macrocyte-reanimator',
  warrior: 'canoptek-circle.macrocyte-warrior',
  tombCrawler: 'canoptek-circle.tomb-crawler',
} as const;

export const RULE_MATRIX = 'canoptek-circle.rule.obelisk-node-matrix';

export const SP = {
  hypershielding: 'canoptek-circle.sp.hypershielding',
  cryptogravitic: 'canoptek-circle.sp.cryptogravitic-repulsion',
  transdynamic: 'canoptek-circle.sp.transdynamic-amplification',
  souldrain: 'canoptek-circle.sp.souldrain',
} as const;

export const FP = {
  shieldFlare: 'canoptek-circle.fp.shield-flare',
  nodalResponse: 'canoptek-circle.fp.nodal-response',
  animateNodes: 'canoptek-circle.fp.animate-obelisk-nodes',
  sacrificialThrall: 'canoptek-circle.fp.sacrificial-thrall',
} as const;

export const EQ = {
  matrixManipulator: 'canoptek-circle.eq.matrix-manipulator',
  nanoscarabCaskets: 'canoptek-circle.eq.nanoscarab-caskets',
  awakenedNodes: 'canoptek-circle.eq.awakened-obelisk-nodes',
  phaseShifter: 'canoptek-circle.eq.phase-shifter',
} as const;

export const AB = {
  obeliskNodeControl: 'canoptek-circle.geomancer.obelisk-node-control',
  reanimate: 'canoptek-circle.macrocyte-reanimator.reanimate',
  aggressiveDefence: 'canoptek-circle.macrocyte-warrior.aggressive-defence',
  expendableConstruct: 'canoptek-circle.macrocyte-warrior.expendable-construct',
  ceaselessScuttling: 'canoptek-circle.macrocyte-warrior.a-ceaseless-scuttling',
  dimensionalBanishment: 'canoptek-circle.tomb-crawler.dimensional-banishment',
  weaponSentinel: 'canoptek-circle.tomb-crawler.weapon-sentinel',
  steadfast: 'canoptek-circle.tomb-crawler.steadfast',
} as const;

export const ACT = {
  geomanticDisturbance: 'canoptek-circle.geomancer.act.geomantic-disturbance',
  canoptekControl: 'canoptek-circle.geomancer.act.canoptek-control',
  molecularBreach: 'canoptek-circle.geomancer.act.molecular-breach',
  overcharge: 'canoptek-circle.macrocyte-accelerator.act.overcharge',
  cranialOverload: 'canoptek-circle.macrocyte-accelerator.act.cranial-overload',
  nanoscarabBeam: 'canoptek-circle.macrocyte-reanimator.act.nanoscarab-beam',
} as const;

/** The two halves of the faction rule are separate 0CP STRATEGIC GAMBITs (the Wolf Scouts shape). */
export const PLACE_NODES_GAMBIT = RULE_MATRIX;
export const MOVE_NODES_GAMBIT = `${RULE_MATRIX}.move`;
export const SCUTTLING_GAMBIT = AB.ceaselessScuttling;

/** Effects (namespaced scratch — architecture rule 7 forbids module-level mutable state). */
export const EFF = {
  /** MATRIX MANIPULATOR: the GEOMANCER is your fourth OBELISK NODE marker for this activation. */
  manipulator: 'canoptek.matrixManipulator',
  /** MOLECULAR BREACH: the selected operative's next move action is a remove-and-set-up. */
  breach: 'canoptek.molecularBreach',
  /** CANOPTEK CONTROL: "during that action, it cannot move more than 2"". */
  controlCap: 'canoptek.canoptekControl',
  /** SACRIFICIAL THRALL, armed by the ploy and consumed by the next Shoot at the GEOMANCER. */
  thrall: 'canoptek.sacrificialThrall',
  /** SHIELD FLARE, armed by the ploy and consumed by the next attack dice that would land. */
  shieldFlare: 'canoptek.shieldFlare',
  /** SOULDRAIN: sticky for the activation once the enemy has been seen inside the MATRIX. */
  souldrain: 'canoptek.souldrain',
  /** Reanimate: "cannot be incapacitated for the remainder of the action". */
  reanimateShield: 'canoptek.reanimateShield',
  reanimateApl: 'canoptek.reanimateApl',
  overcharge: 'canoptek.overcharge',
  cranialOverload: 'canoptek.cranialOverload',
} as const;

/** Extra ActionDefs (D-021: `canPerformAction` can only forbid, never permit). */
export const BREACH_REPOSITION = 'Reposition (Molecular Breach)';
export const BREACH_DASH = 'Dash (Molecular Breach)';
export const BREACH_FALL_BACK = 'Fall Back (Molecular Breach)';
export const BREACH_CHARGE = 'Charge (Molecular Breach)';
export const NODE_OPERATE_HATCH = 'Operate Hatch (Obelisk Node Control)';

const OBELISK_FLAG = 'obeliskNode';
const MARKER_MM = 20; // "Objective markers are 40mm; all other markers 20mm" (core rules › Markers).
const MARKER_R = mmToInches(MARKER_MM) / 2;
/** "…within 6" horizontally of another of your OBELISK NODE markers". */
const MATRIX_LINK = 6;
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

export const obeliskMarkerId = (player: PlayerId, n: number): string => `canoptek-circle.obelisk.${player}.${n}`;

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? DEFAULT_BASE;

// ---------------------------------------------------------------------------
// OBELISK NODE MATRIX — the geometry every other rule on this team reads
// ---------------------------------------------------------------------------

export function obeliskMarkers(state: GameState, player: PlayerId): MarkerState[] {
  return Object.values(state.markers)
    .filter((m) => m.flags[OBELISK_FLAG] === true && m.owner === player)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The node POSITIONS the matrix is built from: your three OBELISK NODE markers, plus the
 * GEOMANCER while MATRIX MANIPULATOR is live ("a friendly CANOPTEK CIRCLE GEOMANCER operative
 * is treated as your fourth OBELISK NODE marker").
 */
export function matrixNodes(state: GameState, player: PlayerId): Vec2[] {
  const nodes = obeliskMarkers(state, player).map((m) => ({ ...m.pos }));
  const manip = effectFor(state, player, EFF.manipulator);
  const geo = manip?.operativeId ? state.operatives[manip.operativeId] : undefined;
  if (geo && !geo.removed && !geo.incapacitated) nodes.push({ ...geo.pos });
  return nodes;
}

export interface MatrixShape {
  nodes: Vec2[];
  /** Node pairs within 6" horizontally — "those markers and the area between them". */
  pairs: [Vec2, Vec2][];
  /** "If all three … fulfil this, it creates a larger combined OBELISK NODE MATRIX." */
  hull?: Poly;
}

/**
 * "Whenever one of your OBELISK NODE markers is within 6" horizontally of another of your
 * OBELISK NODE markers, those markers and the area between them create an OBELISK NODE MATRIX
 * above and below (in other words, their height in the killzone is irrelevant). If all three of
 * your OBELISK NODE markers fulfil this, it creates a larger combined OBELISK NODE MATRIX."
 *
 * MODELLING DECISION (reported): the printed component is a physical template (`markerGuide`
 * lists an "Obelisk Node Matrix template") whose dimensions are not in the data, so a linked
 * pair is modelled as the convex hull of the two 20mm marker discs — a capsule of the markers'
 * own radius around the segment between them — and the combined matrix as the convex hull of
 * every linked node. Height is ignored, exactly as printed.
 */
export function matrixShape(state: GameState, player: PlayerId): MatrixShape {
  const nodes = matrixNodes(state, player);
  const pairs: [Vec2, Vec2][] = [];
  const linked = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (dist(a, b) - 2 * MARKER_R > MATRIX_LINK + EPS) continue;
      pairs.push([a, b]);
      linked.add(i);
      linked.add(j);
    }
  }
  const shape: MatrixShape = { nodes, pairs };
  if (nodes.length >= 3 && linked.size === nodes.length) {
    const hull = convexHull(nodes);
    if (hull.length >= 3) shape.hull = hull;
  }
  return shape;
}

/** Gap in inches from a point to the matrix area — 0 when the point is inside it. */
export function matrixGapToPoint(state: GameState, player: PlayerId, p: Vec2): number {
  const shape = matrixShape(state, player);
  if (shape.pairs.length === 0) return Infinity;
  let best = Infinity;
  if (shape.hull) {
    if (pointInPoly(p, shape.hull)) return 0;
    for (let i = 0, j = shape.hull.length - 1; i < shape.hull.length; j = i++)
      best = Math.min(best, distancePointToSegment(p, shape.hull[j]!, shape.hull[i]!));
  }
  for (const [a, b] of shape.pairs) best = Math.min(best, distancePointToSegment(p, a, b));
  return Math.max(0, best - MARKER_R);
}

/** "…is within your OBELISK NODE MATRIX" for a base of this radius centred at `pos`. */
export function withinMatrixAt(state: GameState, player: PlayerId, pos: Vec2, radius: number): boolean {
  return matrixGapToPoint(state, player, pos) <= radius + EPS;
}

/** Is this operative within `T.player`'s OBELISK NODE MATRIX? (Friend or foe — nine rules ask.) */
export function withinMatrix(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (op.removed) return false;
  return withinMatrixAt(state, T.player, op.pos, baseRadius(baseOf(T, op)));
}

function segSegDistance(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number {
  if (segmentsIntersect(p1, p2, p3, p4)) return 0;
  return Math.min(
    distancePointToSegment(p1, p3, p4),
    distancePointToSegment(p2, p3, p4),
    distancePointToSegment(p3, p1, p2),
    distancePointToSegment(p4, p1, p2),
  );
}

/**
 * "…if your OBELISK NODE MATRIX is intervening" — the line between the two operatives crosses
 * the matrix area. Drawn centre to centre rather than from every point of the shooter's base to
 * every facing part of the target's (D-007), which is also why SHIELD FLARE prints "your
 * opponent determines intervening (i.e. where on their operative's base to draw the targeting
 * lines from)" — that choice has no channel here.
 */
export function matrixIntervenes(state: GameState, player: PlayerId, a: Vec2, b: Vec2): boolean {
  const shape = matrixShape(state, player);
  if (shape.pairs.length === 0) return false;
  if (shape.hull) {
    if (segmentCrossesPoly(a, b, shape.hull)) return true;
    if (pointInPoly(a, shape.hull) || pointInPoly(b, shape.hull)) return true;
  }
  return shape.pairs.some(([p, q]) => segSegDistance(a, b, p, q) <= MARKER_R + EPS);
}

/** Monotone chain — the node count is at most four, so this is a handful of comparisons. */
function convexHull(points: Vec2[]): Poly {
  const pts = [...points].sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

// ---------------------------------------------------------------------------
// Placing and moving the nodes
// ---------------------------------------------------------------------------

const territoryOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.territories[state.setup.dropZone[player] ?? player] ?? [];

const dropZoneOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

const markerWhollyWithin = (pos: Vec2, polys: Poly[]): boolean =>
  baseWhollyWithin(pos, { shape: 'round', mm: MARKER_MM }, 0, polys, 12);

/**
 * "…place your three OBELISK NODE markers wholly within your territory." A position the player
 * did not supply comes from a deterministic, logged default (D-016): a lattice over the
 * territory, taking the point nearest its centroid and then two more that are linked to it
 * (within 6") and as far apart as the territory allows, so the default placement always
 * projects a combined matrix.
 */
export function defaultNodePositions(state: GameState, player: PlayerId): Vec2[] {
  const polys = territoryOf(state, player);
  const legal: Vec2[] = [];
  const board = state.map.board;
  for (let x = 0.5; x < board.w; x += 0.5) {
    for (let y = 0.5; y < board.h; y += 0.5) {
      const p = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      if (markerWhollyWithin(p, polys)) legal.push(p);
    }
  }
  if (legal.length === 0) {
    const c = { x: state.map.board.w / 4, y: state.map.board.h / 2 };
    return [c, { x: c.x + 3, y: c.y }, { x: c.x, y: c.y + 3 }];
  }
  const centre = {
    x: legal.reduce((a, p) => a + p.x, 0) / legal.length,
    y: legal.reduce((a, p) => a + p.y, 0) / legal.length,
  };
  const first = [...legal].sort((a, b) => dist(a, centre) - dist(b, centre) || a.x - b.x || a.y - b.y)[0]!;
  const out = [first];
  while (out.length < 3) {
    let best: Vec2 | undefined;
    let bestScore = -1;
    for (const p of legal) {
      if (out.some((q) => dist(p, q) < 1)) continue;
      // Every node must stay linked to the first, or the matrix never forms.
      if (dist(p, first) - 2 * MARKER_R > MATRIX_LINK - 0.25) continue;
      const spread = Math.min(...out.map((q) => dist(p, q)));
      if (spread > bestScore) {
        bestScore = spread;
        best = p;
      }
    }
    if (!best) break;
    out.push(best);
  }
  while (out.length < 3) out.push({ ...first });
  return out;
}

export function placeObeliskNodes(state: GameState, player: PlayerId, positions: Vec2[], sourceId = RULE_MATRIX): void {
  for (const m of obeliskMarkers(state, player)) removeMarker(state, m.id);
  positions.slice(0, 3).forEach((pos, i) => {
    placeTeamMarker(state, {
      id: obeliskMarkerId(player, i + 1),
      kind: 'generic',
      player,
      pos: { ...pos },
      diameterMm: MARKER_MM,
      flags: { [OBELISK_FLAG]: true },
    });
  });
  log(state, {
    kind: 'ploy',
    player,
    text: `Obelisk Node markers placed at ${positions
      .slice(0, 3)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' · ')}`,
    data: { source: sourceId },
  });
}

/** Where the nodes drift when the player supplies no positions: the friendly centre of mass. */
function nodeDriftTarget(T: TeamHooks, state: GameState): Vec2 {
  const mates = T.friendlies(state, KW).filter((o) => !o.removed);
  return centroidOf(mates, { x: state.map.board.w / 2, y: state.map.board.h / 2 });
}

interface NodeMove {
  id: string;
  pos: Vec2;
}

function requestedMoves(data: Record<string, unknown> | undefined): NodeMove[] {
  const raw = data?.['nodes'];
  if (!Array.isArray(raw)) return [];
  const out: NodeMove[] = [];
  for (const entry of raw) {
    const e = entry as { id?: unknown; pos?: unknown };
    const pos = e.pos as Vec2 | undefined;
    if (typeof e.id === 'string' && pos && typeof pos.x === 'number' && typeof pos.y === 'number')
      out.push({ id: e.id, pos: { x: pos.x, y: pos.y } });
  }
  return out;
}

const towards = (from: Vec2, to: Vec2, inches: number): Vec2 => {
  const d = dist(from, to);
  if (d <= EPS || inches <= 0) return { ...from };
  const k = Math.min(1, inches / d);
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
};

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

const visibleTo = (T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean =>
  !T.ctx || isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;

const engagedNow = (T: TeamHooks, state: GameState, op: OperativeState): boolean =>
  Boolean(T.ctx) && enemiesInControlRange(T.ctx!, state, op).length > 0;

/** The weapon profile currently inflicting damage — `onDamage` always carries `ctx: null`. */
function damageProfile(
  ctx: GameContext,
  state: GameState,
  target: OperativeState,
): { profile: WeaponProfile; melee: boolean; striker: OperativeState } | undefined {
  const fight = fightSeq(state);
  if (fight) {
    const side = fight.defenderId === target.id ? 'attacker' : 'defender';
    const strikerId = side === 'attacker' ? fight.attackerId : fight.defenderId;
    const striker = state.operatives[strikerId];
    if (!striker) return undefined;
    const { profile } = sideWeapon(ctx, state, fight, side);
    return { profile, melee: true, striker };
  }
  const shoot = shootSeq(state);
  if (!shoot) return undefined;
  const attacker = state.operatives[shoot.attackerId];
  if (!attacker) return undefined;
  const weapon = cardOf(ctx, attacker).weapons.find((w) => w.name === shoot.weaponName);
  const profile =
    weapon?.profiles.find((p) => (p.name ?? '') === (shoot.profileName ?? '')) ?? weapon?.profiles[0];
  if (!profile) return undefined;
  return { profile, melee: false, striker: attacker };
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  obeliskNodeMatrix(reg, T);
  geomancer(reg, T);
  reanimator(reg, T);
  warrior(reg, T);
  tombCrawler(reg, T);
}

function obeliskNodeMatrix(reg: HookRegistry, T: TeamHooks): void {
  // ---- the two STRATEGIC GAMBITs (0CP, so they are their own gambit ids) ----
  reg.on('onPloyUsed', T.bind(RULE_MATRIX, 11), (ev) => {
    if (ev.player !== T.player || ev.ployId !== PLACE_NODES_GAMBIT) return;
    const supplied = (ev.data?.['positions'] as Vec2[] | undefined) ?? [];
    const legal = supplied.filter((p) => p && typeof p.x === 'number' && markerWhollyWithin(p, territoryOf(ev.state, T.player)));
    const positions = legal.length === 3 ? legal : defaultNodePositions(ev.state, T.player);
    placeObeliskNodes(ev.state, T.player, positions, PLACE_NODES_GAMBIT);
  });
  reg.on('onPloyUsed', T.bindText(MOVE_NODES_GAMBIT, text(RULE_MATRIX), 11), (ev) => {
    if (ev.player !== T.player || ev.ployId !== MOVE_NODES_GAMBIT) return;
    // "…you can move each of your OBELISK NODE markers up to 3" horizontally."
    const asked = requestedMoves(ev.data);
    const drift = nodeDriftTarget(T, ev.state);
    for (const marker of obeliskMarkers(ev.state, T.player)) {
      const want = asked.find((a) => a.id === marker.id)?.pos ?? drift;
      const capped = towards(marker.pos, want, 3);
      marker.pos = capped;
    }
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Obelisk Node markers move up to 3"' });
  });

  // ---- "Your OBELISK NODE markers control other markers within 1" of them that no enemy
  //       operatives contest (treat your OBELISK NODE markers as friendly operatives for this
  //       purpose). If more than one player would use their OBELISK NODE markers to control the
  //       same marker, no OBELISK NODE markers control it." -------------------------------
  reg.on('onMarkerControl', T.bind(RULE_MATRIX, 12), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || marker.flags[OBELISK_FLAG] === true || !T.ctx) return;
    const mine = nodeControls(T, ev.state, T.player, marker);
    if (!mine) return;
    // A mirror match registers this rule for both players; the opponent's own nodes cancel it.
    if (nodeControls(T, ev.state, otherPlayer(T.player), marker)) {
      ev.forced = undefined as unknown as PlayerId | undefined;
      return;
    }
    ev.forced = T.player;
  });

  // ---- "Whenever a friendly CANOPTEK CIRCLE operative is within your OBELISK NODE MATRIX:
  //       Weapons on its datacard have the Accurate 1 weapon rule." ---------------------
  reg.on('onWeaponRules', T.bind(RULE_MATRIX, 13), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    // "Weapons on its datacard" — a granted weapon (a grenade, say) is not one.
    if (!T.card(ev.operative)?.weapons.some((w) => w.name === ev.weaponName)) return;
    if (!withinMatrix(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Obelisk Node Matrix)'));
  });

  // ---- "Add 1 to its APL stat (to a maximum of 3)." --------------------------------
  reg.on('onStatMod', T.bind(RULE_MATRIX, 13), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    if (!withinMatrix(T, ev.state, op)) return;
    const base = T.card(op)?.apl ?? 2;
    const raw = op.aplMods.reduce((a, b) => a + b, 0) + ev.mods.apl;
    const now = Math.max(0, base + Math.max(-1, Math.min(1, raw)));
    if (now >= 3) return; // "(to a maximum of 3)" — the GEOMANCER is already APL 3.
    ev.mods.apl += 1;
  });
}

/** "…control other markers within 1" of them that no enemy operatives contest." */
function nodeControls(T: TeamHooks, state: GameState, player: PlayerId, marker: MarkerState): boolean {
  if (!T.ctx) return false;
  const nodes = matrixNodes(state, player);
  const near = nodes.some(
    (n) => baseGap(n, { shape: 'round', mm: MARKER_MM }, 0, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0) <= 1 + EPS,
  );
  if (!near) return false;
  const foe = otherPlayer(player);
  return !aliveOperatives(state, foe).some((o) => {
    const c = T.card(o)?.base ?? DEFAULT_BASE;
    return baseGap(o.pos, c, o.rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0) <= 1 + EPS;
  });
}

// ---- GEOMANCER -------------------------------------------------------------

function geomancer(reg: HookRegistry, T: TeamHooks): void {
  // Obelisk Node Control's mission-action half is REMINDER ONLY: the ops own those ActionDefs
  // and `markerContestedBy` emits nothing, so "determine control from one of your OBELISK NODE
  // markers instead" cannot reach `activeControls` (`src/core/ops/common.ts`). Its Operate
  // Hatch half is the `Operate Hatch (Obelisk Node Control)` ActionDef registered below.
  void reg;
  void T;
}

// ---- CANOPTEK MACROCYTE REANIMATOR › Reanimate ------------------------------

function reanimator(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onIncapacitated', T.bind(AB.reanimate, 11), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW) || !T.ctx) return;
    const reanim = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CARD.reanimator &&
        o.id !== victim.id && // "another friendly CANOPTEK CIRCLE operative"
        !o.incapacitated && // "You cannot use this rule if this operative is incapacitated"
        // "…visible to and within 6" of this operative, or if this and that operative are
        //  within your OBELISK NODE MATRIX"
        ((T.gap(o, victim) <= 6 + EPS && visibleTo(T, ev.state, o, victim)) ||
          (withinMatrix(T, ev.state, o) && withinMatrix(T, ev.state, victim))) &&
        // "providing neither this nor that operative is within control range of an enemy operative"
        !engagedNow(T, ev.state, o) &&
        !engagedNow(T, ev.state, victim),
    );
    if (!reanim) return;
    // "…or if it's a Shoot action and this operative would be a primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === reanim.id || seq.queue.includes(reanim.id))) return;
    // "Once per turning point".
    if (!useOncePerTP(ev.state, `canoptek.reanimate:${T.player}`)) return;

    ev.prevented = true;
    victim.wounds = 1; // "that friendly operative isn't incapacitated, has 1 wound remaining"
    reanimateTargets(ev.state)[victim.id] = true;
    effect(ev.state, {
      rule: EFF.reanimateShield,
      source: { kind: 'ability', id: AB.reanimate },
      sourceText: shortQuote(abilityText(CARD.reanimator, AB.reanimate)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next
    //  activations respectively."
    for (const o of [reanim, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: EFF.reanimateApl,
        source: { kind: 'ability', id: AB.reanimate },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    // "After that action, that friendly operative can immediately perform a free Dash action"
    // (D-013: it lands on the next AP it spends) and "if this rule was used during that friendly
    // operative's activation, that activation ends" — so from here the Dash is the only action it
    // may still perform. The free AP is deliberately NOT an APL change (D-100): were it one, the
    // −1 APL this same rule just applied would swallow it under the ±1 clamp and Reanimate would
    // hand out a Dash the operative could never take.
    // REMINDER ONLY: "but must end that action within this operative's control range or within
    // your OBELISK NODE MATRIX" — no hook constrains where a move ENDS. The predicate is
    // exported as `reanimateDashEndLegal` for the UI.
    grantFreeAction(ev.state, victim, {
      sourceId: AB.reanimate,
      sourceText: shortQuote(abilityText(CARD.reanimator, AB.reanimate)),
      threshold: ev.state.activeOperativeId === victim.id ? victim.apSpent : currentApl(T, ev.state, victim),
      kind: 'ability',
      only: ['Dash', BREACH_DASH],
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Reanimate: ${victim.letter} stays on 1 wound (${reanim.letter})`,
    });
  });
  // "…and cannot be incapacitated for the remainder of the action."
  reg.on('onIncapacitated', T.bind(AB.reanimate, 10), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, EFF.reanimateShield)) return;
    ev.prevented = true;
    if (ev.operative.wounds <= 0) ev.operative.wounds = 1;
  });
  // `endOfAction` effects are only swept at the end of a turning point, so the shield is
  // dropped at the activation boundary instead — tighter than the engine's own expiry.
  reg.on('onActivationEnd', T.bind(AB.reanimate, 12), (ev) => {
    void ev.operative;
    dropEffects(ev.state, (e) => e.rule === EFF.reanimateShield && e.player === T.player);
  });
  // NANOSCARAB BEAM: "It cannot be an operative that the Reanimate rule was used on during this
  // turning point" — the ledger is cleared in the Ready step of each Strategy phase.
  reg.on('onReadyStep', T.bind(AB.reanimate, 13), (ev) => {
    if (ev.player !== T.player) return;
    ev.state.opState['canoptek.reanimated'] = {};
  });
}

const reanimateTargets = (state: GameState): Record<string, unknown> => bucket(state, 'canoptek.reanimated');

export const reanimateUsedOn = (state: GameState, operativeId: string): boolean =>
  Boolean(reanimateTargets(state)[operativeId]);

/** The end-of-move constraint the engine cannot enforce, exported for the UI. */
export function reanimateDashEndLegal(
  T: TeamHooks,
  state: GameState,
  victim: OperativeState,
  reanim: OperativeState,
  end: Vec2,
): boolean {
  const probe: OperativeState = { ...victim, pos: end };
  return T.gap(probe, reanim) <= 1 + EPS || withinMatrix(T, state, probe);
}

// ---- CANOPTEK MACROCYTE WARRIOR --------------------------------------------

function warrior(reg: HookRegistry, T: TeamHooks): void {
  // Aggressive Defence: "If this operative is incapacitated by an enemy operative within 2" of
  // it, before this operative is removed from the killzone, roll one D3: on a 2+, inflict 1
  // damage on that enemy operative."
  reg.on('onIncapacitated', T.bind(AB.aggressiveDefence, 12), (ev) => {
    const op = ev.operative;
    if (ev.prevented || !T.ctx) return;
    if (op.player !== T.player || op.datacardId !== CARD.warrior) return;
    const killer = incapacitator(T, ev.state, op);
    if (!killer || killer.removed || T.gap(killer, op) > 2 + EPS) return;
    const roll = T.ctx.rng.d3();
    recordRoll(ev.state, 'aggressiveDefence', [roll], T.player, 'Aggressive Defence D3 2+');
    if (roll < 2) return;
    inflictDamage(T.ctx, ev.state, killer, 1, 'other');
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Aggressive Defence: ${op.letter} inflicts 1 damage on ${killer.letter}`,
    });
  });

  // Expendable Construct is REMINDER ONLY: every clause is op scoring ("your opponent's
  // kill/elimination op", "victory conditions and scoring VPs"), which lives in
  // `src/core/ops/**` and this module may not reach into.

  // A Ceaseless Scuttling — "As a STRATEGIC GAMBIT in each turning point after the first, if you
  // have less than three non-incapacitated friendly CANOPTEK CIRCLE WARRIOR operatives, you can
  // set up another one ready and with a Conceal order wholly within your drop zone."
  reg.on('onPloyUsed', T.bind(AB.ceaselessScuttling, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SCUTTLING_GAMBIT || !T.ctx) return;
    if (liveWarriors(T, ev.state).length >= 3) return;
    const spot = dropZoneSpot(T.ctx, ev.state, CARD.warrior, T.player);
    if (!spot) {
      log(ev.state, { kind: 'ploy', player: T.player, text: 'A Ceaseless Scuttling: no legal spot in the drop zone' });
      return;
    }
    const team = ev.state.teams[T.player];
    const i = team.operativeIds.length;
    const id = `${T.player}-scuttle-${i}`;
    const dc = T.ctx.datacards.get(CARD.warrior)!;
    const fresh: OperativeState = {
      id,
      player: T.player,
      datacardId: CARD.warrior,
      letter: String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : ''),
      pos: { ...spot },
      z: surfaceAt(terrain(T.ctx, ev.state), spot),
      rot: 0,
      order: 'conceal', // "…ready and with a Conceal order"
      ready: true,
      expended: false,
      counteractedThisTP: false,
      wounds: dc.wounds,
      apSpent: 0,
      actionsThisActivation: [],
      onGuard: false,
      guardSpentTP: null,
      aplMods: [],
      weaponUses: {},
      stickyEngagedWith: [],
    };
    ev.state.operatives[id] = fresh;
    team.operativeIds.push(id);
    // "(you can select its weapon options as normal)" — the deterministic default is the first
    // printed option, gauss scalpel; the UI passes `data.loadout` for the player's own choice.
    const loadout = (ev.state.opState['loadout'] ?? {}) as Record<string, string[]>;
    const asked = ev.data?.['loadout'];
    loadout[id] = Array.isArray(asked) && asked.every((w) => typeof w === 'string')
      ? (asked as string[])
      : ['Gauss scalpel', 'Claws & tail'];
    ev.state.opState['loadout'] = loadout;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `A Ceaseless Scuttling: ${fresh.letter} (WARRIOR) is set up in the drop zone`,
    });
  });
}

const liveWarriors = (T: TeamHooks, state: GameState): OperativeState[] =>
  aliveOperatives(state, T.player).filter((o) => o.datacardId === CARD.warrior && !o.incapacitated);

/** Who just incapacitated this operative — the other side of the in-flight sequence. */
function incapacitator(T: TeamHooks, state: GameState, victim: OperativeState): OperativeState | undefined {
  const fight = fightSeq(state);
  if (fight) {
    const id = fight.defenderId === victim.id ? fight.attackerId : fight.defenderId;
    return state.operatives[id];
  }
  const shoot = shootSeq(state);
  if (shoot) return state.operatives[shoot.attackerId];
  void T;
  return undefined;
}

function dropZoneSpot(
  ctx: GameContext,
  state: GameState,
  datacardId: string,
  player: PlayerId,
): Vec2 | undefined {
  const dc = ctx.datacards.get(datacardId);
  if (!dc) return undefined;
  const polys = dropZoneOf(state, player);
  if (polys.length === 0) return undefined;
  const index = terrain(ctx, state);
  const r = baseRadius(dc.base);
  const board = state.map.board;
  const candidates: Vec2[] = [];
  for (let x = 0.5; x < board.w; x += 0.5) {
    for (let y = 0.5; y < board.h; y += 0.5) {
      const p = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      if (!baseWhollyWithin(p, dc.base, 0, polys, 12)) continue;
      candidates.push(p);
    }
  }
  return candidates.find((p) => {
    if (baseTouchesHazardous(index, p, dc.base, 0)) return false;
    const z = surfaceAt(index, p);
    if (baseBlockedByTerrain(index, p, dc.base, 0, z, modelHeight(dc))) return false;
    return aliveOperatives(state).every((o) => {
      const oc = ctx.datacards.get(o.datacardId);
      return !oc || dist(p, o.pos) - r - baseRadius(oc.base) > -1e-4;
    });
  });
}

// ---- CANOPTEK TOMB CRAWLER --------------------------------------------------

function tombCrawler(reg: HookRegistry, T: TeamHooks): void {
  // Dimensional Banishment (rare weapon rule). "After this operative uses this weapon, if you
  // inflicted damage or retained any critical successes, if the target wasn't incapacitated,
  // roll 2D6: if the result is higher than the target's remaining wounds, the target is
  // incapacitated (taking precedence over rules that prevent incapacitation…) and your opponent
  // cannot place a Reanimation marker (HIEROTEK CIRCLE) for that operative."
  //
  // The retained crit count is stashed at the Roll Defence Dice step, which is the last moment
  // it exists: blocking overwrites `crit` with `blocked` and the core's own Devastating read
  // then cannot tell a blocked crit from a blocked normal.
  reg.on('onDefenceDice', T.bind(AB.dimensionalBanishment, 12), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    if (!isBanishment(ev.ctx.rules)) return;
    bucket(ev.state, 'canoptek.banish')[`${seq.attackerId}:${seq.targetId}`] = countCrits(seq.attack);
  });
  reg.on('onStrikeResolved', T.bind(AB.dimensionalBanishment, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.ctx) return;
    if (ev.ctx.attacker.player !== T.player || !isBanishment(ev.ctx.rules)) return;
    const struck = ev.struck;
    if (struck.incapacitated || struck.removed) return; // "if the target wasn't incapacitated"
    const seq = shootSeq(ev.state);
    const key = seq ? `${seq.attackerId}:${seq.targetId}` : '';
    const retainedCrits = Number(bucket(ev.state, 'canoptek.banish')[key] ?? 0);
    const unblocked = seq ? seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'normal').length : 0;
    if (unblocked === 0 && retainedCrits === 0) return; // "if you inflicted damage or retained any critical successes"
    const roll = T.ctx.rng.d6() + T.ctx.rng.d6();
    recordRoll(ev.state, 'dimensionalBanishment', [roll], T.player, 'Dimensional Banishment 2D6');
    if (roll <= struck.wounds) return;
    // "…taking precedence over rules that prevent incapacitation … and your opponent cannot
    //  place a Reanimation marker for that operative": `onIncapacitated` has no
    //  "unpreventable" flag and every death-trigger handler hangs off that one emit, so the
    //  incapacitation is applied WITHOUT emitting it. Reported as a seam.
    struck.wounds = 0;
    struck.incapacitated = true;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Dimensional Banishment (${roll}): ${struck.letter} is banished from the killzone`,
    });
  });

  // Weapon Sentinel — "Whenever your opponent is selecting a valid target, if this operative has
  // a Conceal order, it cannot use Light terrain for cover. While this can allow this operative
  // to be targeted (assuming it's visible), it doesn't remove its cover save (if any)."
  reg.on('onValidTarget', T.bind(AB.weaponSentinel, 12), (ev) => {
    if (ev.target.player !== T.player || ev.target.datacardId !== CARD.tombCrawler) return;
    if (ev.target.order !== 'conceal') return;
    if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
  });
  reg.on('onDefenceDice', T.bind(AB.weaponSentinel, 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== CARD.tombCrawler) return;
    if (target.order !== 'conceal' || ev.coverSave || !T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
    const attacker = ev.ctx.attacker;
    const seek = ev.ctx.rules.some((r) => r.id === 'Seek');
    const seekLight = ev.ctx.rules.some((r) => r.id === 'SeekLight');
    // Cover as the core would have found it WITHOUT this rule's Light carve-out: Seek, Seek
    // Light and the Vantage denial all still take the cover save away.
    const cover = coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, attacker), body(T.ctx, target), {
      ignoreCoverTerrain: seek ? 'all' : seekLight ? 'light' : 'none',
      vantageDeniesLightCover: ev.ctx.vantageAccurate > 0 && attacker.z - target.z >= 2 - EPS,
    });
    if (!cover.inCover) return;
    ev.coverSave = true; // "it doesn't remove its cover save (if any)"
  });

  // Steadfast — "Whenever determining control of a marker, you can treat this operative's APL
  // stat as 3. If you do, this takes precedence over all other rules, meaning any changes to its
  // APL stat are ignored for this."
  reg.on('onMarkerControl', T.bind(AB.steadfast, 13), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    for (const op of T.friendlies(ev.state)) {
      if (op.datacardId !== CARD.tombCrawler) continue;
      if (T.markerGap(op, marker) > 1 + EPS) continue;
      // "…this takes precedence over all other rules, meaning any changes to its APL stat are
      //  ignored for this" — the contested total already counted its live APL, so swap it for 3.
      ev.aplByPlayer[T.player] += 3 - currentApl(T, ev.state, op);
    }
  });
}

const isBanishment = (rules: { id: string }[]): boolean => rules.some((r) => r.id === 'DimensionalBanishment');

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  strategyPloys(reg, T);
  firefightPloys(reg, T);
}

function strategyPloys(reg: HookRegistry, T: TeamHooks): void {
  // ---- HYPERSHIELDING ------------------------------------------------------
  // "Whenever an operative is shooting a friendly CANOPTEK CIRCLE operative, if your OBELISK
  //  NODE MATRIX is intervening, or that friendly operative is within your OBELISK NODE MATRIX,
  //  you can re-roll any of your defence dice results of one result (e.g. results of 2)."
  reg.on('onDefenceDice', T.bind(SP.hypershielding, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.hypershielding)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!withinMatrix(T, ev.state, target) && !matrixIntervenes(ev.state, T.player, ev.ctx.attacker.pos, target.pos))
      return;
    ev.rerolls.push({
      id: 'canoptek.hypershielding',
      label: 'Hypershielding: re-roll any of your defence dice results of one result',
      mode: 'value',
      sourceText: shortQuote(text(SP.hypershielding)),
      player: T.player,
    });
  });

  // ---- CRYPTOGRAVITIC REPULSION -------------------------------------------
  // "Once per action, the first time an enemy operative would move within your OBELISK NODE
  //  MATRIX, the distance is treated as an additional 1"."
  //
  // PARTIAL: `onMoveDistance` scales the whole allowance and carries no path, so the extra inch
  // is charged to the move as a whole rather than at the moment of entry. It is only charged
  // when the mover is OUTSIDE the matrix and could reach it with the move it is about to make,
  // so a move that could never touch the matrix is never taxed; a move that could have entered
  // and did not still is.
  reg.on('onMoveDistance', T.bind(SP.cryptogravitic, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.cryptogravitic)) return;
    const op = ev.operative;
    if (op.player === T.player) return;
    const radius = baseRadius(T.card(op)?.base ?? DEFAULT_BASE);
    const gap = matrixGapToPoint(ev.state, T.player, op.pos) - radius;
    if (gap <= 0) return; // already within it — "would move within" has already happened
    if (gap > ev.inches + EPS) return; // it cannot reach the matrix with this move
    ev.inches = Math.max(0, ev.inches - 1);
  });

  // ---- TRANSDYNAMIC AMPLIFICATION -----------------------------------------
  // "Whenever a friendly CANOPTEK CIRCLE operative is shooting, if your OBELISK NODE MATRIX is
  //  intervening, or the target is within your OBELISK NODE MATRIX, that friendly operative's
  //  weapons have the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bind(SP.transdynamic, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.transdynamic)) return;
    if (ev.type !== 'ranged' || ev.retaliating || !T.mineKw(ev.operative, KW)) return;
    const target = ev.target;
    if (!target) return;
    if (!withinMatrix(T, ev.state, target) && !matrixIntervenes(ev.state, T.player, ev.operative.pos, target.pos))
      return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Transdynamic Amplification)'));
  });

  // ---- SOULDRAIN -----------------------------------------------------------
  // "Whenever an enemy operative is within your OBELISK NODE MATRIX, or whenever it's fighting
  //  or retaliating against a friendly CANOPTEK CIRCLE operative that's within your OBELISK NODE
  //  MATRIX, subtract 1 from both Dmg stats of that enemy operative's melee weapons (to a
  //  minimum of 2) until the end of the activation/counteraction."
  //
  // D-019: profiles are shared catalogue data, so the change is applied where the damage is
  // inflicted. A fight inflicts one attack dice at a time, so `ev.amount` IS one Dmg stat.
  reg.on('onActivationStart', T.bind(SP.souldrain, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.souldrain)) return;
    if (ev.operative.player === T.player) return;
    if (!withinMatrix(T, ev.state, ev.operative)) return;
    effect(ev.state, {
      rule: EFF.souldrain,
      source: { kind: 'ploy', id: SP.souldrain },
      sourceText: shortQuote(text(SP.souldrain)),
      operativeId: ev.operative.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
  });
  reg.on('onDamage', T.bind(SP.souldrain, 20), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    if (!gambitUsed(ev.state, T.player, SP.souldrain)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return; // melee weapons only
    const info = damageProfile(T.ctx, ev.state, ev.target);
    if (!info || !info.melee) return;
    const striker = info.striker;
    if (striker.player === T.player) return;
    const applies =
      withinMatrix(T, ev.state, striker) ||
      Boolean(effectOn(ev.state, striker.id, EFF.souldrain)) ||
      (T.mineKw(ev.target, KW) && withinMatrix(T, ev.state, ev.target));
    if (!applies) return;
    const stat = ev.amount;
    if (stat !== info.profile.dmgN && stat !== info.profile.dmgC) return;
    const reduced = Math.max(2, stat - 1); // "(to a minimum of 2)"
    if (reduced === stat) return;
    ev.amount = reduced;
  });
}

function firefightPloys(reg: HookRegistry, T: TeamHooks): void {
  // ---- SHIELD FLARE --------------------------------------------------------
  // "Use this firefight ploy when an attack dice inflicts Normal Dmg on a friendly CANOPTEK
  //  CIRCLE operative. If your OBELISK NODE MATRIX is intervening, or that friendly operative is
  //  within your OBELISK NODE MATRIX, ignore that inflicted damage."
  //
  // The engine opens no ploy window inside a sequence, so the ploy is declared in advance and
  // fires on its printed trigger (the Celestian GLORIOUS MARTYRDOM / Mandrakes SHADOW'S BITE
  // shape); the flag is consumed by the first attack dice that qualifies.
  reg.on('onPloyUsed', T.bind(FP.shieldFlare, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.shieldFlare) return;
    effect(ev.state, {
      rule: EFF.shieldFlare,
      source: { kind: 'ploy', id: FP.shieldFlare },
      sourceText: shortQuote(text(FP.shieldFlare)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onDamage', T.bind(FP.shieldFlare, 21), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    const victim = ev.target;
    if (!T.mineKw(victim, KW)) return;
    const armed = effectFor(ev.state, T.player, EFF.shieldFlare);
    if (!armed) return;
    const info = damageProfile(T.ctx, ev.state, victim);
    if (!info) return;
    if (
      !withinMatrix(T, ev.state, victim) &&
      !matrixIntervenes(ev.state, T.player, info.striker.pos, victim.pos)
    )
      return;
    const dmgN = info.profile.dmgN;
    if (info.melee) {
      if (ev.amount !== dmgN) return; // "an attack dice inflicts NORMAL Dmg"
      ev.amount = 0;
    } else {
      const seq = shootSeq(ev.state);
      const normals = seq ? seq.attack.dice.filter((d) => d.state === 'normal').length : 0;
      if (normals === 0 || ev.amount < dmgN) return;
      // A shoot inflicts one aggregated total, so exactly one attack dice's worth is removed
      // (the Mandrakes Oubliex read).
      ev.amount -= dmgN;
    }
    dropEffects(ev.state, (e) => e === armed);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Shield Flare: ${victim.letter} ignores ${dmgN} damage from one attack dice`,
    });
  });

  // ---- NODAL RESPONSE ------------------------------------------------------
  // "Use this firefight ploy during a friendly CANOPTEK CIRCLE operative's activation, before or
  //  after it performs an action. You can either change one of the strategy ploys you used
  //  during this turning point (only pay additional CP if that ploy costs more), or use a
  //  strategy ploy now (pay its CP cost as normal)."
  reg.on('onPloyUsed', T.bind(FP.nodalResponse, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.nodalResponse) return;
    const team = ev.state.teams[T.player];
    const ids = DATA.strategyPloys.map((p) => p.id);
    const used = ids.filter((id) => team.gambitsUsedTP.includes(id));
    const unused = ids.filter((id) => !used.includes(id));
    const askedId = ev.data?.['gambitId'];
    // D-016: a deterministic, logged default — the first printed strategy ploy not yet used.
    const pick = typeof askedId === 'string' && unused.includes(askedId) ? askedId : unused[0];
    const cp = (id: string): number => DATA.strategyPloys.find((p) => p.id === id)?.cp ?? 1;
    if (!pick) {
      team.cp += 1; // nothing to change to: the CP is handed back (it is charged before this hook)
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Nodal Response: no strategy ploy left to use — CP refunded' });
      return;
    }
    const askedSwap = ev.data?.['replaces'];
    const replaces = typeof askedSwap === 'string' && used.includes(askedSwap) ? askedSwap : undefined;
    // "only pay additional CP if that ploy costs more" / "pay its CP cost as normal"
    const price = replaces ? Math.max(0, cp(pick) - cp(replaces)) : cp(pick);
    if (team.cp < price) {
      team.cp += 1;
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Nodal Response: not enough CP — refunded' });
      return;
    }
    team.cp -= price;
    if (replaces) team.gambitsUsedTP = team.gambitsUsedTP.filter((id) => id !== replaces);
    team.gambitsUsedTP.push(pick);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Nodal Response: ${replaces ? `${nameOfPloy(replaces)} becomes ` : 'now using '}${nameOfPloy(pick)}`,
    });
  });

  // ---- ANIMATE OBELISK NODES ----------------------------------------------
  // "Use this firefight ploy when it's your turn to activate or counteract with a friendly
  //  operative. Move any number of your OBELISK NODE markers instead. They can move up to 6"
  //  horizontally combined, and distances are always rounded up to the nearest inch… You can
  //  also move them 0" (to effectively skip an activation). In any case, your opponent activates
  //  as normal afterwards."
  reg.on('onPloyUsed', T.bind(FP.animateNodes, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.animateNodes) return;
    const asked = requestedMoves(ev.data);
    const drift = nodeDriftTarget(T, ev.state);
    let budget = 6;
    for (const marker of obeliskMarkers(ev.state, T.player)) {
      if (budget <= 0) break;
      const want = asked.find((a) => a.id === marker.id)?.pos ?? drift;
      const need = dist(marker.pos, want);
      if (need <= EPS) continue;
      // "distances are always rounded up to the nearest inch (so if you move a marker 1.5",
      //  it's treated as moving it 2")".
      const spend = Math.min(Math.ceil(need), budget);
      marker.pos = towards(marker.pos, want, Math.min(need, spend));
      budget -= spend;
    }
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Animate Obelisk Nodes: the markers move instead' });
    // "…instead. In any case, your opponent activates as normal afterwards." (the Phobos
    // PATIENT AMBUSH shape — the engine has no skip-activation intent, so the turn is handed
    // over and every ready operative keeps its ready status).
    ev.state.activePlayer = otherPlayer(T.player);
  });

  // ---- SACRIFICIAL THRALL --------------------------------------------------
  // "Use this firefight ploy when a friendly CANOPTEK CIRCLE GEOMANCER operative is selected as
  //  the valid target of a Shoot action or to fight against during the Fight action. Select one
  //  other friendly CANOPTEK CIRCLE CANOPTEK operative visible to and within 3" of that first
  //  friendly operative to become the valid target or to be fought against (as appropriate)
  //  instead (even if it wouldn't normally be valid for this)."
  reg.on('onPloyUsed', T.bind(FP.sacrificialThrall, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.sacrificialThrall) return;
    effect(ev.state, {
      rule: EFF.thrall,
      source: { kind: 'ploy', id: FP.sacrificialThrall },
      sourceText: shortQuote(text(FP.sacrificialThrall)),
      player: T.player,
      ...(typeof ev.data?.['operativeId'] === 'string' ? { data: { operativeId: ev.data['operativeId'] } } : {}),
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onSelectTarget', T.bind(FP.sacrificialThrall, 21), (ev) => {
    if (ev.target.player !== T.player || ev.target.datacardId !== CARD.geomancer) return;
    const armed = effectFor(ev.state, T.player, EFF.thrall);
    if (!armed) return;
    // "This ploy has no effect if it's the Shoot action and the ranged weapon has the Blast or
    //  Torrent weapon rule."
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    const candidates = thrallCandidates(T, ev.state, ev.target);
    const asked = armed.data?.['operativeId'] as string | undefined;
    const thrall = candidates.find((o) => o.id === asked) ?? candidates[0];
    if (!thrall) return;
    ev.redirectTo = thrall.id;
    dropEffects(ev.state, (e) => e === armed);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Sacrificial Thrall: ${thrall.letter} is targeted instead of ${ev.target.letter}`,
    });
  });
  // REMINDER ONLY: the Fight half ("or to be fought against … treat that other operative as
  // being within the fighting operative's control range for the duration of that action").
  // `startFight` takes its defender straight from the intent and emits nothing before building
  // the sequence, so there is no target-substitution seam in melee — the same gap the Celestian
  // Insidiants' HOLY DEFENDER and the Elucidian Loyal Companion reported.
}

const nameOfPloy = (id: string): string =>
  [...DATA.strategyPloys, ...DATA.firefightPloys].find((p) => p.id === id)?.name ?? id;

export function thrallCandidates(T: TeamHooks, state: GameState, geo: OperativeState): OperativeState[] {
  return T.friendlies(state, CANOPTEK)
    .filter((o) => o.id !== geo.id && T.kw(o, KW) && T.gap(o, geo) <= 3 + EPS && visibleTo(T, state, geo, o))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- MATRIX MANIPULATOR --------------------------------------------------
  // "Once per battle, during a friendly CANOPTEK CIRCLE operative's activation or counteraction,
  //  you can use this rule. If you do, until the end of that activation/counteraction, a
  //  friendly CANOPTEK CIRCLE GEOMANCER operative is treated as your fourth OBELISK NODE marker."
  //
  // D-022: "you can use this rule" with no cost is auto-used on a stated deterministic policy —
  // here, at the start of a friendly activation, only when the GEOMANCER would actually link to
  // an existing node AND at least one friendly operative that is not already within the matrix
  // would be brought inside it. PARTIAL: `Counteract` emits no `onActivationStart`, so the
  // counteraction half of the window is unreachable.
  reg.on('onActivationStart', T.bind(EQ.matrixManipulator, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.matrixManipulator)) return;
    if (ev.operative.player !== T.player || !T.kw(ev.operative, KW)) return;
    if (usedThisBattle(ev.state, `canoptek.manipulator:${T.player}`)) return;
    const geo = T.friendlies(ev.state).find((o) => o.datacardId === CARD.geomancer);
    if (!geo) return;
    const linked = obeliskMarkers(ev.state, T.player).some((m) => dist(m.pos, geo.pos) - 2 * MARKER_R <= MATRIX_LINK + EPS);
    if (!linked) return;
    const before = T.friendlies(ev.state, KW).filter((o) => withinMatrix(T, ev.state, o)).length;
    const probe = effect(ev.state, {
      rule: EFF.manipulator,
      source: { kind: 'equipment', id: EQ.matrixManipulator },
      sourceText: shortQuote(text(EQ.matrixManipulator)),
      operativeId: geo.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
    const after = T.friendlies(ev.state, KW).filter((o) => withinMatrix(T, ev.state, o)).length;
    if (after <= before) {
      dropEffects(ev.state, (e) => e === probe);
      return;
    }
    useOncePerBattle(ev.state, `canoptek.manipulator:${T.player}`);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Matrix Manipulator: ${geo.letter} is your fourth Obelisk Node marker this activation`,
    });
  });

  // ---- NANOSCARAB CASKETS --------------------------------------------------
  // "Whenever a friendly CANOPTEK CIRCLE operative is activated, it regains up to D3 lost wounds."
  reg.on('onActivationStart', T.bind(EQ.nanoscarabCaskets, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.nanoscarabCaskets) || !T.ctx) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    const heal = T.ctx.rng.d3();
    recordRoll(ev.state, 'nanoscarabCaskets', [heal], T.player, 'Nanoscarab Caskets D3');
    const max = T.card(op)?.wounds ?? op.wounds;
    if (op.wounds >= max) return;
    op.wounds = Math.min(max, op.wounds + heal);
  });

  // ---- AWAKENED OBELISK NODES ---------------------------------------------
  // "After revealing this equipment option, roll one D3. You can use the Animate Obelisk Nodes
  //  firefight ploy for 0CP a number of times during the battle equal to the result."
  reg.on('onSelectEquipment', T.bind(EQ.awakenedNodes, 30), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!ev.equipment.includes(EQ.awakenedNodes)) return;
    const free = bucket(ev.state, 'canoptek.awakened');
    if (typeof free[T.player] === 'number') return;
    const roll = T.ctx.rng.d3();
    recordRoll(ev.state, 'awakenedObeliskNodes', [roll], T.player, 'Awakened Obelisk Nodes D3');
    free[T.player] = roll;
  });
  // CP is deducted before `onPloyUsed` fires, so "for 0CP" is a refund.
  reg.on('onPloyUsed', T.bind(EQ.awakenedNodes, 19), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.animateNodes) return;
    if (!hasEquipment(ev.state, T.player, EQ.awakenedNodes)) return;
    const free = bucket(ev.state, 'canoptek.awakened');
    const left = Number(free[T.player] ?? 0);
    if (left <= 0) return;
    free[T.player] = left - 1;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Awakened Obelisk Nodes: Animate Obelisk Nodes costs 0CP (${left - 1} free uses left)`,
    });
  });

  // ---- PHASE SHIFTER -------------------------------------------------------
  // "Once per turning point, when an operative is shooting a friendly CANOPTEK CIRCLE GEOMANCER
  //  operative, at the start of the Roll Defence Dice step, you can use this rule. If you do,
  //  worsen the x of the Piercing weapon rule by 1 (if any) until the end of that sequence. Note
  //  that Piercing 1 would therefore be ignored."
  reg.on('onDefenceDice', T.bind(EQ.phaseShifter, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.phaseShifter)) return;
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== CARD.geomancer) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    const crits = countCrits(seq.attack);
    const before = piercingValue(ev.ctx.rules, crits);
    const worsened = ev.ctx.rules
      .map((r) => (r.id === 'Piercing' ? { ...r, x: (r.x ?? 1) - 1 } : r))
      .filter((r) => !(r.id === 'Piercing' && (r.x ?? 0) <= 0));
    const after = piercingValue(worsened, crits);
    if (before <= after) return;
    if (!useOncePerTP(ev.state, `canoptek.phaseShifter:${T.player}`)) return;
    // The pool is `3 − Piercing`, so worsening Piercing by 1 is one more defence dice.
    ev.count += before - after;
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const enemiesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, otherPlayer(op.player));

const keywordsOf = (ctx: GameContext, op: OperativeState): string[] => ctx.datacards.get(op.datacardId)?.keywords ?? [];
const hasKw = (ctx: GameContext, op: OperativeState, kw: string): boolean =>
  keywordsOf(ctx, op).some((k) => k.toUpperCase() === kw.toUpperCase());

const seesAndWithin = (ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState, inches: number): boolean => {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  if (!ca || !cb) return false;
  if (baseGap(a.pos, ca.base, a.rot, b.pos, cb.base, b.rot) > inches + EPS) return false;
  return isVisible(terrain(ctx, state), body(ctx, a), body(ctx, b)).visible;
};

const sees = (ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean =>
  isVisible(terrain(ctx, state), body(ctx, a), body(ctx, b)).visible;

const inMatrix = (ctx: GameContext, state: GameState, player: PlayerId, op: OperativeState): boolean => {
  const c = ctx.datacards.get(op.datacardId);
  return withinMatrixAt(state, player, op.pos, baseRadius(c?.base ?? DEFAULT_BASE));
};

/** GEOMANTIC DISTURBANCE: "Select a point on a terrain feature … visible to and within 8"." */
export function disturbancePoint(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  asked?: Vec2,
): Vec2 | undefined {
  const index = terrain(ctx, state);
  const legal = (p: Vec2): boolean => {
    // "Select a point ON A TERRAIN FEATURE" — so the point sits on top of the part it is in.
    const on = index.parts.filter((part) => pointInPoly(p, part.poly));
    if (on.length === 0) return false;
    const c = ctx.datacards.get(op.datacardId);
    if (!c) return false;
    const gap = baseGap(op.pos, c.base, op.rot, p, { shape: 'round', mm: 1 }, 0);
    if (gap > 8 + EPS) return false;
    const z = Math.max(surfaceAt(index, p), ...on.map((part) => part.z1));
    const probe: Body = { id: 'point', pos: p, z, rot: 0, base: { shape: 'round', mm: 20 }, height: 0.4 };
    return isVisible(index, body(ctx, op), probe).visible;
  };
  if (asked && legal(asked)) return asked;
  // D-016: a deterministic, logged default — the legal point catching the most enemy operatives
  // and the fewest friendly ones. Only terrain within reach is considered, and only each part's
  // centre plus its vertices nudged inside it, so a `check` the AI runs many times stays cheap.
  const near = index.parts.filter(
    (part) =>
      part.bounds.min.x - 9 <= op.pos.x &&
      part.bounds.max.x + 9 >= op.pos.x &&
      part.bounds.min.y - 9 <= op.pos.y &&
      part.bounds.max.y + 9 >= op.pos.y,
  );
  const candidates: Vec2[] = [];
  for (const part of near) {
    const c = {
      x: (part.bounds.min.x + part.bounds.max.x) / 2,
      y: (part.bounds.min.y + part.bounds.max.y) / 2,
    };
    candidates.push(c);
    for (const v of part.poly) {
      const d = dist(v, c) || 1;
      candidates.push({ x: v.x + ((c.x - v.x) / d) * 0.1, y: v.y + ((c.y - v.y) / d) * 0.1 });
    }
  }
  let best: Vec2 | undefined;
  let bestScore = -Infinity;
  for (const raw of candidates.slice(0, 200)) {
    const p = { x: Math.round(raw.x * 100) / 100, y: Math.round(raw.y * 100) / 100 };
    if (!legal(p)) continue;
    const enemies = enemiesOf(state, op).filter((o) => dist(o.pos, p) <= 2 + EPS).length;
    const friends = aliveOperatives(state, op.player).filter((o) => dist(o.pos, p) <= 2 + EPS).length;
    const score = enemies * 2 - friends;
    if (score > bestScore || (score === bestScore && best && (p.x < best.x || (p.x === best.x && p.y < best.y)))) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** CANOPTEK CONTROL / MOLECULAR BREACH / OVERCHARGE — "…or within your OBELISK NODE MATRIX". */
function supportOrMatrixTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen: string | undefined,
  opts: { keyword?: string; range: number; excludeSelf: boolean; matrixKeyword?: string; matrixExcludesSelf: boolean },
): OperativeState | undefined {
  const inRange = aliveOperatives(state, op.player).filter((o) => {
    if (opts.excludeSelf && o.id === op.id) return false;
    if (opts.keyword && !hasKw(ctx, o, opts.keyword)) return false;
    return o.id === op.id || seesAndWithin(ctx, state, op, o, opts.range);
  });
  const viaMatrix = inMatrix(ctx, state, op.player, op)
    ? aliveOperatives(state, op.player).filter((o) => {
        if (opts.matrixExcludesSelf && o.id === op.id) return false;
        if (opts.matrixKeyword && !hasKw(ctx, o, opts.matrixKeyword)) return false;
        if (!hasKw(ctx, o, KW)) return false;
        if (!inMatrix(ctx, state, op.player, o)) return false;
        return o.id === op.id || sees(ctx, state, op, o);
      })
    : [];
  const all = [...inRange, ...viaMatrix].filter((o, i, xs) => xs.findIndex((x) => x.id === o.id) === i);
  all.sort((a, b) => (a.id < b.id ? -1 : 1));
  return all.find((o) => o.id === chosen) ?? all[0];
}

function actions(data: typeof DATA): ActionDef[] {
  const out: ActionDef[] = [];

  // ---- GEOMANCER › GEOMANTIC DISTURBANCE 1AP -------------------------------
  out.push(
    uniqueAction(data, CARD.geomancer, ACT.geomanticDisturbance, {
      check: (ctx, state, op, params) => {
        // "This operative cannot perform this action while it has a Conceal order, or while
        //  within control range of an enemy operative."
        if (op.order === 'conceal') return { ok: false, reason: 'this operative has a Conceal order' };
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return disturbancePoint(ctx, state, op, params.targetPos)
          ? { ok: true }
          : { ok: false, reason: 'select a point on a terrain feature visible to and within 8"' };
      },
      perform: (ctx, state, op, params) => {
        const point = disturbancePoint(ctx, state, op, params.targetPos)!;
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: GEOMANTIC DISTURBANCE at ${point.x.toFixed(1)},${point.y.toFixed(1)}`,
        });
        // "Separately roll 2D6 for each operative within 2" of that point. If the result is
        //  higher than that operative's remaining wounds, inflict damage on it equal to the
        //  difference."
        const victims = aliveOperatives(state)
          .filter((o) => {
            const c = ctx.datacards.get(o.datacardId);
            return c && baseGap(o.pos, c.base, o.rot, point, { shape: 'round', mm: 1 }, 0) <= 2 + EPS;
          })
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const victim of victims) {
          const roll = ctx.rng.d6() + ctx.rng.d6();
          recordRoll(state, 'geomanticDisturbance', [roll], op.player, `GEOMANTIC DISTURBANCE vs ${victim.letter}`);
          if (roll <= victim.wounds) continue;
          inflictDamage(ctx, state, victim, roll - victim.wounds, 'mortal');
        }
        return { ok: true };
      },
    }),
  );

  // ---- GEOMANCER › CANOPTEK CONTROL 1AP (SUPPORT) --------------------------
  out.push(
    uniqueAction(data, CARD.geomancer, ACT.canoptekControl, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        // "…or while counteracting."
        if (state.opState['counteract']?.['operativeId'] === op.id)
          return { ok: false, reason: 'this operative cannot perform this action while counteracting' };
        return canoptekControlTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly CANOPTEK operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = canoptekControlTarget(ctx, state, op, params.targetOperativeId)!;
        // Which AP the bonus lands on: the next one if the target is mid-activation, otherwise
        // the one after its own APL is spent.
        const threshold = state.activeOperativeId === target.id ? target.apSpent : aplOf(ctx, state, target);
        // "That selected operative can immediately perform a 1AP action for free" — free AP on
        // top of its APL budget, not an APL stat change (docs/DECISIONS.md D-100).
        grantFreeAction(state, target, {
          sourceId: ACT.canoptekControl,
          sourceText: shortQuote(actionText(CARD.geomancer, ACT.canoptekControl)),
          threshold,
          kind: 'ability',
        });
        // "…during that action, it cannot move more than 2", or must be set up wholly within 2"
        //  if it's removed and set up again."
        effect(state, {
          rule: EFF.controlCap,
          source: { kind: 'ability', id: ACT.canoptekControl },
          sourceText: shortQuote(actionText(CARD.geomancer, ACT.canoptekControl)),
          operativeId: target.id,
          player: op.player,
          data: { threshold },
          expiry: { kind: 'endOfActivation', operativeId: target.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: CANOPTEK CONTROL (${target.letter})` });
        return { ok: true };
      },
    }),
  );

  // ---- GEOMANCER › MOLECULAR BREACH 1AP (SUPPORT) --------------------------
  out.push(
    uniqueAction(data, CARD.geomancer, ACT.molecularBreach, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return molecularBreachTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly CANOPTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = molecularBreachTarget(ctx, state, op, params.targetOperativeId)!;
        dropEffects(state, (e) => e.rule === EFF.breach && e.player === op.player);
        effect(state, {
          rule: EFF.breach,
          source: { kind: 'ability', id: ACT.molecularBreach },
          sourceText: shortQuote(actionText(CARD.geomancer, ACT.molecularBreach)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfBattle' }, // "the NEXT time the selected operative performs an action in which it moves"
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: MOLECULAR BREACH on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // ---- ACCELERATOR › OVERCHARGE / CRANIAL OVERLOAD 1AP ---------------------
  out.push(
    uniqueAction(data, CARD.accelerator, ACT.overcharge, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return overchargeTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly CANOPTEK operative visible to and within 3"' };
      },
      perform: (ctx, state, op, params) => {
        const target = overchargeTarget(ctx, state, op, params.targetOperativeId)!;
        // "Until the end of that selected operative's next activation, add 1 to its APL stat."
        dropEffects(state, (e) => e.rule === EFF.overcharge && e.operativeId === target.id);
        target.aplMods.push(1);
        effect(state, {
          rule: EFF.overcharge,
          source: { kind: 'ability', id: ACT.overcharge },
          sourceText: shortQuote(actionText(CARD.accelerator, ACT.overcharge)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: OVERCHARGE (${target.letter} +1 APL)` });
        return { ok: true };
      },
    }),
    uniqueAction(data, CARD.accelerator, ACT.cranialOverload, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return cranialTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to and within 3"' };
      },
      perform: (ctx, state, op, params) => {
        const target = cranialTarget(ctx, state, op, params.targetOperativeId)!;
        // "Until the end of that enemy operative's next activation, subtract 1 from its APL stat."
        dropEffects(state, (e) => e.rule === EFF.cranialOverload && e.operativeId === target.id);
        target.aplMods.push(-1);
        effect(state, {
          rule: EFF.cranialOverload,
          source: { kind: 'ability', id: ACT.cranialOverload },
          sourceText: shortQuote(actionText(CARD.accelerator, ACT.cranialOverload)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: CRANIAL OVERLOAD (${target.letter} -1 APL)` });
        return { ok: true };
      },
    }),
  );

  // ---- REANIMATOR › NANOSCARAB BEAM 1AP ------------------------------------
  out.push(
    uniqueAction(data, CARD.reanimator, ACT.nanoscarabBeam, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        // "…or more than once per turning point."
        if (usedThisTP(state, `canoptek.nanoscarabBeam:${op.id}`))
          return { ok: false, reason: 'this operative has already performed this action this turning point' };
        return nanoscarabTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly CANOPTEK CIRCLE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = nanoscarabTarget(ctx, state, op, params.targetOperativeId)!;
        useOncePerTP(state, `canoptek.nanoscarabBeam:${op.id}`);
        const heal = ctx.rng.d3() + ctx.rng.d3() + ctx.rng.d3();
        recordRoll(state, 'nanoscarabBeam', [heal], op.player, 'NANOSCARAB BEAM 3D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: NANOSCARAB BEAM (+${heal} on ${target.letter})` });
        return { ok: true };
      },
    }),
  );

  // ---- MOLECULAR BREACH's four move variants (D-021) -----------------------
  out.push(
    breachAction(BREACH_REPOSITION, 'Reposition (Molecular Breach)', 'Reposition', 1),
    breachAction(BREACH_DASH, 'Dash (Molecular Breach)', 'Dash', 1),
    breachAction(BREACH_FALL_BACK, 'Fall Back (Molecular Breach)', 'Fall Back', 2),
    breachAction(BREACH_CHARGE, 'Charge (Molecular Breach)', 'Charge', 1),
  );

  // ---- Obelisk Node Control's Operate Hatch half (D-021) -------------------
  out.push(nodeOperateHatch());

  return out;
}

function canoptekControlTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string) {
  // "Select one friendly CANOPTEK operative visible to and within 6" of this operative.
  //  Alternatively, you can select one friendly CANOPTEK CIRCLE CANOPTEK operative that's
  //  visible to this operative and within your OBELISK NODE MATRIX (SUPPORT doesn't apply)."
  return supportOrMatrixTarget(ctx, state, op, chosen, {
    keyword: CANOPTEK,
    range: supportRange(ctx, state, op),
    excludeSelf: true,
    matrixKeyword: CANOPTEK,
    matrixExcludesSelf: true,
  });
}

function molecularBreachTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string) {
  return supportOrMatrixTarget(ctx, state, op, chosen, {
    keyword: KW,
    range: supportRange(ctx, state, op),
    excludeSelf: false,
    matrixKeyword: KW,
    matrixExcludesSelf: false,
  });
}

function nanoscarabTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string) {
  // "Select one friendly CANOPTEK CIRCLE operative visible to and within 6" of this operative.
  //  Alternatively, if this operative is within your OBELISK NODE MATRIX, you can select one
  //  OTHER friendly CANOPTEK CIRCLE operative within your OBELISK NODE MATRIX."
  const range = supportRange(ctx, state, op);
  const inRange = aliveOperatives(state, op.player).filter(
    (o) => hasKw(ctx, o, KW) && (o.id === op.id || seesAndWithin(ctx, state, op, o, range)),
  );
  const viaMatrix = inMatrix(ctx, state, op.player, op)
    ? aliveOperatives(state, op.player).filter(
        (o) => o.id !== op.id && hasKw(ctx, o, KW) && inMatrix(ctx, state, op.player, o),
      )
    : [];
  const all = [...inRange, ...viaMatrix]
    // "It cannot be an operative that the Reanimate rule was used on during this turning point."
    .filter((o) => !reanimateUsedOn(state, o.id))
    .filter((o, i, xs) => xs.findIndex((x) => x.id === o.id) === i)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return all.find((o) => o.id === chosen) ?? all[0];
}

function overchargeTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string) {
  // "Select one other friendly CANOPTEK operative visible to and within 3" of this operative.
  //  Alternatively, if this operative is within your OBELISK NODE MATRIX, you can select one
  //  other friendly CANOPTEK CIRCLE CANOPTEK operative within your OBELISK NODE MATRIX."
  const inRange = aliveOperatives(state, op.player).filter(
    (o) => o.id !== op.id && hasKw(ctx, o, CANOPTEK) && seesAndWithin(ctx, state, op, o, 3),
  );
  const viaMatrix = inMatrix(ctx, state, op.player, op)
    ? aliveOperatives(state, op.player).filter(
        (o) => o.id !== op.id && hasKw(ctx, o, CANOPTEK) && hasKw(ctx, o, KW) && inMatrix(ctx, state, op.player, o),
      )
    : [];
  const all = [...inRange, ...viaMatrix]
    .filter((o, i, xs) => xs.findIndex((x) => x.id === o.id) === i)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return all.find((o) => o.id === chosen) ?? all[0];
}

function cranialTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string) {
  const inRange = enemiesOf(state, op).filter((o) => seesAndWithin(ctx, state, op, o, 3));
  const viaMatrix = inMatrix(ctx, state, op.player, op)
    ? enemiesOf(state, op).filter((o) => inMatrix(ctx, state, op.player, o))
    : [];
  const all = [...inRange, ...viaMatrix]
    .filter((o, i, xs) => xs.findIndex((x) => x.id === o.id) === i)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return all.find((o) => o.id === chosen) ?? all[0];
}

/** SUPPORT: 6" plus a Comms Device, through the shared `onSupportDistance` seam. */
function supportRange(ctx: GameContext, state: GameState, op: OperativeState): number {
  return ctx.hooks.emit('onSupportDistance', state, { state, operative: op, inches: 6 }).inches;
}

// ---------------------------------------------------------------------------
// MOLECULAR BREACH — the remove-and-set-up move actions
// ---------------------------------------------------------------------------

const breachEffect = (state: GameState, op: OperativeState) => effectOn(state, op.id, EFF.breach);

/** "…it cannot move more than 2", or must be set up wholly within 2" if it's removed and set up again." */
function controlCapActive(state: GameState, op: OperativeState): boolean {
  const cap = effectOn(state, op.id, EFF.controlCap);
  if (!cap) return false;
  return op.apSpent >= Number(cap.data?.['threshold'] ?? 0);
}

function breachDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2 | undefined,
  mode: 'Reposition' | 'Dash' | 'Fall Back' | 'Charge',
): { ok: boolean; reason?: string; pos?: Vec2; z?: number } {
  if (!pos) return { ok: false, reason: 'select a location to be set up in' };
  if (dist(op.pos, pos) < 0.01) return { ok: false, reason: 'select a different location to be set up in' };
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  // "…wholly within a distance equal to its Move stat (or 3" if it was a Dash) horizontally of
  //  its original location… Note that it gains no additional distance when performing the
  //  Charge action." In a close-quarters killzone "this distance can be measured over and
  //  through Wall terrain", which a straight line already is.
  let max = mode === 'Dash' ? 3 : moveOf(ctx, state, op);
  if (controlCapActive(state, op)) max = Math.min(max, 2);
  if (dist(op.pos, pos) + baseRadius(c.base) > max + EPS)
    return { ok: false, reason: `it must be set up wholly within ${max}"` };
  const r = baseRadius(c.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, c.base, op.rot)) return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, modelHeight(c)))
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (basesOverlap(pos, c.base, op.rot, other.pos, oc.base, other.rot))
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  const landed: Body = { id: op.id, pos, z, rot: op.rot, base: c.base, height: modelHeight(c) };
  const engagedThere = aliveOperatives(state, otherPlayer(op.player)).some((e) =>
    withinControlRange(index, landed, body(ctx, e)),
  );
  // "…and unless it's the Charge action, it cannot be set up within control range of an enemy
  //  operative."
  if (mode === 'Charge' && !engagedThere)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };
  if (mode !== 'Charge' && engagedThere)
    return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
  return { ok: true, pos, z };
}

/**
 * MOLECULAR BREACH: "The next time the selected operative performs an action in which it moves,
 * don't move it. Instead, remove it from the killzone and set it back up…"
 *
 * `onMoveRules.teleport` is declared but NEVER emitted, so the substitution cannot be applied to
 * an in-flight universal move. It is four sibling `ActionDef`s instead, each `treatedAs` its
 * universal action (D-021 — the Sanctifiers' CHERUB Fly / Hearthkyn Jump Pack precedent). The
 * printed rule is mandatory and this is offered as a choice: forbidding the universal move
 * actions instead would immobilise the operative outright in AI-driven games, because
 * `src/ai/legal.ts` only builds movement params for the four universal ids.
 */
function breachAction(id: string, name: string, mode: 'Reposition' | 'Dash' | 'Fall Back' | 'Charge', ap: number): ActionDef {
  return {
    id,
    name,
    ap,
    type: 'unique',
    treatedAs: mode,
    sourceText: actionText(CARD.geomancer, ACT.molecularBreach),
    available: (_ctx, state, op) => Boolean(breachEffect(state, op)),
    check(ctx, state, op, params) {
      if (!breachEffect(state, op)) return { ok: false, reason: 'this operative has no Molecular Breach' };
      const engaged = enemiesInControlRange(ctx, state, op).length > 0;
      const did = (a: string): boolean => op.actionsThisActivation.includes(a);
      if (mode === 'Reposition') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Fall Back') || did('Charge')) return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      } else if (mode === 'Dash') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Charge')) return { ok: false, reason: 'already performed Charge this activation' };
      } else if (mode === 'Fall Back') {
        if (!engaged) return { ok: false, reason: 'no enemy operative within control range' };
        if (did('Reposition') || did('Charge')) return { ok: false, reason: 'already performed Reposition or Charge this activation' };
      } else {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (engaged) return { ok: false, reason: 'already within control range of an enemy operative' };
        if (did('Reposition') || did('Dash') || did('Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      const d = breachDestination(ctx, state, op, params.targetPos, mode);
      return d.ok ? { ok: true } : { ok: false, reason: d.reason ?? 'it cannot be set up there' };
    },
    perform(ctx, state, op, params) {
      const d = breachDestination(ctx, state, op, params.targetPos, mode);
      if (!d.ok || !d.pos) return { ok: false, reason: d.reason ?? 'it cannot be set up there' };
      op.pos = { ...d.pos };
      op.z = d.z ?? 0;
      op.onGuard = false;
      if (op.carryingMarkerId) {
        const m = state.markers[op.carryingMarkerId];
        if (m) {
          m.pos = { ...op.pos };
          m.z = op.z;
        }
      }
      if (mode === 'Charge') {
        op.stickyEngagedWith = enemiesInControlRange(ctx, state, op).map((e) => e.id);
      }
      dropEffects(state, (e) => e.rule === EFF.breach && e.operativeId === op.id); // "the NEXT time…"
      log(state, { kind: 'action', player: op.player, text: `${op.letter} MOLECULAR BREACHES (${name})` });
      return { ok: true };
    },
  };
}

/**
 * Obelisk Node Control: "Whenever this operative would perform the Operate Hatch action, you can
 * open or close a hatchway that's access point is within 1" of one of your OBELISK NODE markers
 * instead. Note that you must still fulfil the Operate Hatch action's conditions."
 */
function nodeOperateHatch(): ActionDef {
  const universal = (): ActionDef => getAction('Operate Hatch')!;
  return {
    id: NODE_OPERATE_HATCH,
    name: NODE_OPERATE_HATCH,
    ap: 1,
    type: 'unique',
    treatedAs: 'Operate Hatch',
    // Aimed at a hatchway, exactly as the universal action is. Without it the sheet had
    // nothing to aim and `src/ai/legal.ts` built no candidate, so the ability was unusable.
    needsTarget: 'part',
    sourceText: abilityText(CARD.geomancer, AB.obeliskNodeControl),
    available: (ctx, state, op) =>
      op.datacardId === CARD.geomancer && (universal().available?.(ctx, state, op) ?? true),
    check(ctx, state, op, params) {
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      const index = terrain(ctx, state);
      const part = params.partId ? index.byId.get(params.partId) : undefined;
      if (!part || part.role !== 'accessPoint') return { ok: false, reason: 'no hatchway access point selected' };
      // "…you must still fulfil the OPERATE HATCH action's conditions", and Operate Hatch is a
      // hatchway action: a Tomb World breach point has to be blown open with Breach.
      if (part.opensAs === 'breachWall')
        return { ok: false, reason: 'that access point is a breach point, not a hatchway' };
      const nodes = matrixNodes(state, op.player);
      // Measured to the access point itself, as every other access-point rule now is.
      const near = nodes.some((n) => baseDistanceToPart(n, { shape: 'round', mm: MARKER_MM }, 0, part) <= 1 + EPS);
      if (!near) return { ok: false, reason: 'no Obelisk Node marker within 1" of that access point' };
      if (part.state === 'open') {
        const enemyNear = aliveOperatives(state, otherPlayer(op.player)).some(
          (e) => accessPointGap(ctx, e, part) <= 1 + EPS,
        );
        if (enemyNear) return { ok: false, reason: 'the open access point is within an enemy operative’s control range' };
      }
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      return universal().perform(ctx, state, op, params as ActionParams);
    },
  };
}

// ---------------------------------------------------------------------------
// CANOPTEK CONTROL's 2" cap and the extra gambits
// ---------------------------------------------------------------------------

function extras(reg: HookRegistry, T: TeamHooks): void {
  // "…during that action, it cannot move more than 2"." (The "must be set up wholly within 2"
  //  if it's removed and set up again" half is honoured by `breachDestination`; `onSetUpAgain`
  //  is declared but never emitted, so there is no general seam for it.)
  reg.on('onMoveDistance', T.bind(ACT.canoptekControl, 14), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!controlCapActive(ev.state, ev.operative)) return;
    ev.inches = Math.min(ev.inches, 2);
  });
  // "That selected operative can immediately perform a 1AP action for free" — the free AP is
  // the last one it spends (D-100), so a 2AP action can never be paid for with it (the Corsair
  // Voidscarred Veteran Raider cap).
  reg.on('canPerformAction', T.bind(ACT.canoptekControl, 14), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!controlCapActive(ev.state, ev.operative)) return;
    const def = getAction(ev.action);
    if (def && def.ap > 1) {
      ev.allowed = false;
      ev.reason = 'the free Canoptek Control action must be a 1AP action';
    }
  });

  /*
   * A `grantFreeAction` grant expires at the end of the recipient's activation
   * (docs/DECISIONS.md D-100), which covers every grant that is actually spent. Both of this
   * team's grants can be made to an operative that is not activating: Reanimate fires whenever an
   * incapacitation is prevented — most often in the enemy's activation — and CANOPTEK CONTROL
   * names any friendly CANOPTEK operative visible to and within 6". If that operative is already
   * expended its activation never ends again, so nothing would clear the grant and it would still
   * be sitting there when the Ready step readied it next turning point. This sweep is that bound:
   * an unspent free action does not survive the turning point it was given in.
   */
  const dropStaleGrants = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bindText('canoptek.freeActionSweep', text(RULE_MATRIX), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) dropStaleGrants(ev.state, o);
  });
}

/** The two rules on this team that hand out a `grantFreeAction` bonus AP. */
const FREE_ACTION_SOURCES = new Set<string>([AB.reanimate, ACT.canoptekControl]);

function gambits(reg: HookRegistry, T: TeamHooks): void {
  defaultGambits(reg, T);

  // "As a STRATEGIC GAMBIT in the first turning point, place your three OBELISK NODE markers
  //  wholly within your territory."
  reg.on('gambitOptions', T.bind(RULE_MATRIX, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (obeliskMarkers(ev.state, T.player).length > 0) return;
    ev.options.push({
      id: PLACE_NODES_GAMBIT,
      label: 'Obelisk Node Matrix: place your three Obelisk Node markers',
      sourceText: shortQuote(text(RULE_MATRIX)),
    });
  });
  // "As a STRATEGIC GAMBIT in each turning point after the first, you can move each of your
  //  OBELISK NODE markers up to 3" horizontally."
  reg.on('gambitOptions', T.bindText(MOVE_NODES_GAMBIT, text(RULE_MATRIX), 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint <= 1) return;
    if (obeliskMarkers(ev.state, T.player).length === 0) return;
    ev.options.push({
      id: MOVE_NODES_GAMBIT,
      label: 'Obelisk Node Matrix: move each Obelisk Node marker up to 3"',
      sourceText: shortQuote(text(RULE_MATRIX)),
    });
  });
  // A Ceaseless Scuttling.
  reg.on('gambitOptions', T.bind(AB.ceaselessScuttling, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint <= 1) return;
    if (liveWarriors(T, ev.state).length >= 3) return;
    ev.options.push({
      id: SCUTTLING_GAMBIT,
      label: 'A Ceaseless Scuttling: set up another WARRIOR in your drop zone',
      sourceText: shortQuote(abilityText(CARD.warrior, AB.ceaselessScuttling)),
    });
  });
}

// ---------------------------------------------------------------------------

export const canoptekCircle = defineTeam({
  id: 'canoptek-circle',
  rareRules: ['DimensionalBanishment'],
  rules: (reg, T) => {
    rules(reg, T);
    extras(reg, T);
  },
  ploys,
  equipment,
  actions,
  gambits,
  ployUsable: {
    // "Use this firefight ploy during a friendly CANOPTEK CIRCLE operative's activation, before
    //  or after it performs an action" — and there must be a strategy ploy left to change to.
    [FP.nodalResponse]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'use it during a friendly CANOPTEK CIRCLE operative’s activation' };
      const used = state.teams[player].gambitsUsedTP;
      const spare = DATA.strategyPloys.some((p) => !used.includes(p.id) && state.teams[player].cp >= p.cp);
      return spare ? { ok: true } : { ok: false, reason: 'no strategy ploy left to use or change to' };
    },
    // "Use this firefight ploy when it's your turn to activate or counteract with a friendly
    //  operative."
    [FP.animateNodes]: (state, player) => {
      if (state.phase !== 'firefight') return { ok: false, reason: 'use it when it is your turn to activate' };
      if (state.activeOperativeId) return { ok: false, reason: 'an operative is already activated' };
      if ((state.activePlayer ?? player) !== player) return { ok: false, reason: 'it is not your turn to activate' };
      if (obeliskMarkers(state, player).length === 0) return { ok: false, reason: 'you have no Obelisk Node markers' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly CANOPTEK CIRCLE GEOMANCER operative is selected as
    //  the valid target of a Shoot action or to fight against during the Fight action."
    [FP.sacrificialThrall]: (state, player) => {
      const geo = aliveOperatives(state, player).find((o) => o.datacardId === CARD.geomancer);
      if (!geo) return { ok: false, reason: 'you have no GEOMANCER in the killzone' };
      const near = aliveOperatives(state, player).some(
        (o) => o.id !== geo.id && dist(o.pos, geo.pos) <= 3 + 1.6,
      );
      return near ? { ok: true } : { ok: false, reason: 'no other CANOPTEK operative within 3" of the GEOMANCER' };
    },
  },
  aiHints: {
    roles: {
      [CARD.geomancer]: 'leader',
      [CARD.accelerator]: 'support',
      [CARD.reanimator]: 'support',
      [CARD.warrior]: 'objective',
      [CARD.tombCrawler]: 'gunner',
    },
    ployValue: {
      [SP.hypershielding]: 0.5,
      [SP.cryptogravitic]: 0.3,
      [SP.transdynamic]: 0.6,
      [SP.souldrain]: 0.4,
      [FP.shieldFlare]: 0.5,
      [FP.nodalResponse]: 0.3,
      [FP.animateNodes]: 0.2,
      [FP.sacrificialThrall]: 0.4,
      // The 0CP faction gambits — without a value the AI would never place the nodes and every
      // other rule on the team would be switched off for the whole battle.
      [PLACE_NODES_GAMBIT]: 6,
      [MOVE_NODES_GAMBIT]: 1.5,
      [SCUTTLING_GAMBIT]: 3,
    },
    equipmentValue: {
      [EQ.matrixManipulator]: 0.5,
      [EQ.nanoscarabCaskets]: 0.7,
      [EQ.awakenedNodes]: 0.3,
      [EQ.phaseShifter]: 0.4,
    },
  },
});

export default canoptekCircle;

/** Reminder-only clauses, quoted for the UI and asserted by the tests. */
export const REMINDER_ONLY: Record<string, string> = {
  [AB.obeliskNodeControl]:
    'The mission-action half ("you can instead determine control from one of your OBELISK NODE markers") is reminder-only: the ops own those ActionDefs and `markerContestedBy` emits no hook, so nothing can substitute the marker an op checks. The Operate Hatch half IS implemented.',
  [AB.expendableConstruct]:
    'Reminder-only in full: every clause is op scoring (the opponent’s kill/elimination op, victory conditions, escape/survive counts), which lives in src/core/ops/** and a team module may not reach into.',
  [`${AB.reanimate}.dash`]:
    'Reminder-only clause: "must end that action within this operative’s control range or within your OBELISK NODE MATRIX" — no hook constrains where a move ENDS (`reanimateDashEndLegal` is exported for the UI).',
  [`${FP.sacrificialThrall}.fight`]:
    'Reminder-only clause: the Fight half. `startFight` takes its defender from the intent and emits nothing beforehand, so there is no melee target-substitution seam (the Celestian HOLY DEFENDER gap).',
};
