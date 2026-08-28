/**
 * RAVENERS — Tyranids. https://wahapedia.ru/kill-team3/kill-teams/raveners/
 *
 * Rule text is read from `data/teams/raveners.json` and never retyped; every hook carries a
 * short verbatim quote of the printed rule in its `RuleBinding`.
 *
 * Six datacards, three faction rules, nine datacard abilities, two printed unique actions and
 * one MORE unique action printed inside a faction rule (BURROW, whose AP is glued to its name —
 * see the data notes below). Everything hangs off three shapes:
 *
 *  - **Your TUNNEL.** The Tunnel faction rule places up to five numbered markers (0…4) and
 *    defines the TUNNEL as "your Tunnel markers and the area between your sequentially numbered
 *    markers". That is modelled as a capsule chain: `tunnelGap` is the base-to-tunnel distance,
 *    min over (base ↔ each marker) and (base ↔ each sequential marker-to-marker segment, minus
 *    the marker radius). **Eleven rules read it.** Distances are plain Euclidean, which is what
 *    the printed "in a killzone that uses the close quarters rules … can be measured through
 *    Wall terrain" asks for — the clause is satisfied by construction. For an oval base the
 *    corridor test uses centre-distance minus the base's max radius (the Mandrakes `withinShadow`
 *    approximation); every RAVENER base is 40mm round, so it is exact for the friendly half.
 *
 *  - **Underground.** There is no reserve / off-killzone operative state in the engine — but
 *    Burrow does not need one, because it prints "In the Firefight phase, friendly RAVENER
 *    operatives set up underground are **activated and can counteract as normal**". So an
 *    underground operative stays `removed: false` (it activates through the ordinary alternating
 *    order) and is instead **moved off the killzone floor** to a parking spot at negative
 *    coordinates — literally "place it to one side instead of in the killzone". Everything the
 *    engine measures in inches (control range, marker contesting, assists, Blast footprints,
 *    territory and drop-zone tests, ops) then answers "no" without a single extra hook, and
 *    `canPerformAction` supplies the one printed restriction — "it cannot perform any actions
 *    other than Burrow" — plus the FELLTALON's printed override for TOXIC LUNGE. The one thing
 *    the parking spot cannot express is a Range-less weapon shooting it across the void, so
 *    `onValidTarget` refuses an underground operative as a target. The spot is `x > -50` because
 *    `FinishSetup` treats `pos.x < -50` as "not deployed".
 *    *Which* operatives start underground is the Select Operatives gap every batch has hit:
 *    there is no decision channel there, so it goes through the pure setter `setUnderground`
 *    (docs/DECISIONS.md D-017). Nothing starts underground until it is called, which makes the
 *    printed "your first two operatives must be set up as normal, each other … can be set up
 *    underground" inert in AI-driven games — but the BURROW action itself is fully live in both
 *    directions from turning point 1.
 *
 *  - **Predatory Instincts.** Two Fight actions per activation (a second `Fight (Predatory
 *    Instincts)` ActionDef, the Plague Marines Astartes shape) and "can counteract regardless of
 *    its order" through the widened `onCounteract` seam (D-028). Its other two clauses are
 *    reminder-only and named in `REMINDER_ONLY`.
 *
 * Rare weapon rules: `Poison` and `Crush`, both resolved through `rareRuleTextFor` (D-033) —
 * the Raveners print Poison differently from the Plague Marines (critical successes only, no
 * friendly carve-out, D3 damage rather than 1), and the shared registry stores the Plague
 * Marines' wording.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { hasRule } from '../../core/dice.ts';
import {
  baseGap,
  baseRadius,
  basesOverlap,
  dist,
  distancePointToSegment,
  mmToInches,
} from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import type { ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  inflictDamage,
  isWounded,
  log,
  markerContestedBy,
  modelHeight,
  recordRoll,
  removeIncapacitated,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous } from '../../core/terrain.ts';
import type {
  BaseShape,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { vantageAccurate, withinControlRange } from '../../core/visibility.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  bucket,
  catalogueCard,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  giveToken,
  grantFreeAction,
  hasEquipment,
  hasToken,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA: TeamData = teamData('raveners');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

export const KW = 'RAVENER';
const EPS = 1e-6;
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

export const CARD = {
  prime: 'raveners.prime',
  felltalon: 'raveners.felltalon',
  tremorscythe: 'raveners.tremorscythe',
  venomspitter: 'raveners.venomspitter',
  warrior: 'raveners.warrior',
  wrecker: 'raveners.wrecker',
} as const;

export const RULE = {
  burrow: 'raveners.rule.burrow',
  tunnel: 'raveners.rule.tunnel',
  instincts: 'raveners.rule.predatory-instincts',
} as const;

export const AB = {
  crest: 'raveners.prime.neuropredatory-crest',
  synapticLink: 'raveners.prime.synaptic-link',
  poisonFelltalon: 'raveners.felltalon.poison',
  poisonVenomspitter: 'raveners.venomspitter.poison',
  ambush: 'raveners.tremorscythe.subterranean-ambush',
  hypersensory: 'raveners.tremorscythe.hypersensory-hunter',
  instinctive: 'raveners.warrior.instinctive-behaviour',
  carapace: 'raveners.wrecker.reinforced-carapace',
  crush: 'raveners.wrecker.crush',
} as const;

export const ACT = {
  toxicLunge: 'raveners.felltalon.act.toxic-lunge',
  distend: 'raveners.venomspitter.act.distend-dorsal-sac',
} as const;

export const SP = {
  deathFromBelow: 'raveners.sp.death-from-below',
  whipcordEmergence: 'raveners.sp.whipcord-emergence',
  writheOutOfSight: 'raveners.sp.writhe-out-of-sight',
  tunnelLurkers: 'raveners.sp.tunnel-lurkers',
} as const;

export const FP = {
  slitheringEvasion: 'raveners.fp.slithering-evasion',
  subterraneanHorror: 'raveners.fp.subterranean-horror',
  burrowingStrike: 'raveners.fp.burrowing-strike',
  deathFrenzy: 'raveners.fp.death-frenzy',
} as const;

export const EQ = {
  chromatospore: 'raveners.eq.chromatospore-camouflage',
  acidBlood: 'raveners.eq.acid-blood',
  metamorphicFlesh: 'raveners.eq.metamorphic-flesh',
  heightenedSenses: 'raveners.eq.heightened-senses',
} as const;

/** Action ids. BURROW is printed inside the Burrow faction rule, not on a datacard. */
export const BURROW = 'Burrow';
export const FIGHT_AGAIN = 'Fight (Predatory Instincts)';
export const CHANGE_ORDER = 'Change Order (Predatory Instincts)';
export const CHARGE_HYPERSENSORY = 'Charge (Hypersensory Hunter)';
export const CHARGE_SLITHERING = 'Charge (Slithering Evasion)';

/** The two extra STRATEGIC GAMBITs this team offers beside its four strategy ploys. */
export const TUNNEL_GAMBIT = 'raveners.gambit.tunnel';
export const SYNAPTIC_GAMBIT = AB.synapticLink;

/** Tokens and effects (never module-level mutable state — architecture rule 7). */
export const POISON_TOKEN = 'raveners.poison';
export const UNDERGROUND = 'raveners.underground';
export const DISTEND = 'raveners.distendDorsalSac';
export const SLITHERING = 'raveners.slitheringEvasion';
export const AMBUSH_TOKEN = 'raveners.subterraneanAmbush';
const HORROR_ARMED = 'raveners.subterraneanHorror';
const BURROW_STRIKE_SPENT = 'raveners.burrowingStrikeSpent';
const ACTIVATION_MARK = 'raveners.activationMark';
const BURROWED_TP = 'raveners.burrowedTP';
const FELL_BACK_TP = 'raveners.fellBackTP';

/**
 * Printed clauses this module does NOT implement, with the engine reason. Exported so the
 * tests can pin every one of them (docs/TEAM-STATUS.md is only worth anything if it is honest).
 */
export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE.burrow}.setup`]:
    'Select Operatives has no decision channel, so which operatives start underground goes through the pure setter setUnderground (D-017) and nothing starts underground in an AI-driven game',
  [`${RULE.tunnel}.hazardous`]:
    'the Restricted Movement rule reads map.hazardous inside validateMove/DeployOperative and no hook can add a hazardous area, so "parts of a Tunnel marker touching a hazardous area are treated as a hazardous area" has no seam',
  [`${RULE.instincts}.orderFirst`]:
    'onOrderChange is declared but never emitted and the Counteract intent carries no order, so "you can change its order FIRST" (and then still act) has no seam; the "instead of performing an action" half IS live as Change Order (Predatory Instincts)',
  [`${RULE.instincts}.freeBurrow`]:
    'the reducer hard-codes one action per counteraction with no hook ("a counteracting operative can only perform one action"), so the ADDITIONAL free Burrow during a counteraction is unreachable — the Deathwatch Veteran Astartes gap',
  [AB.ambush]:
    'every clause hangs off interrupting an enemy activation and the engine has no activation-order seam (nothing runs after an action); its only enforceable clause is the target lock, which is a pure penalty, so the trigger is recorded as a Subterranean Ambush token for the UI and nothing is enforced',
  [`${AB.crest}.rerollFight`]:
    'fight.ts emits no onRollAttack (D-031), so "your opponent cannot re-roll their attack dice" is exact when that operative SHOOTS and unreachable when it fights or retaliates; the defence-dice half is complete',
  [EQ.heightenedSenses]:
    'initiativeRollModifiers is emitted BEFORE the D6 and rerollOffered is never consulted by rollInitiative, so an initiative re-roll cannot be expressed',
  [`${SP.writheOutOfSight}.fallBack`]:
    'a granted free action is ONE AP outside the APL budget (docs/DECISIONS.md D-100) and Fall Back costs 2AP, so the grant cannot pay for the printed free Fall Back; the free Reposition and the free Burrow are live',
};

// ---------------------------------------------------------------------------
// Your TUNNEL
// ---------------------------------------------------------------------------

const MARKER_MM = 20;
const MARKER_R = mmToInches(MARKER_MM) / 2;
export const MAX_TUNNEL_MARKERS = 5;

export const tunnelMarkerId = (player: PlayerId, n: number): string => `raveners.tunnel.${player}.${n}`;

const baseOf = (op: OperativeState): BaseShape => catalogueCard(op.datacardId)?.base ?? DEFAULT_BASE;

/** Your Tunnel markers, in printed numeric order, with their numbers. */
export function tunnelMarkers(state: GameState, player: PlayerId): { n: number; marker: MarkerState }[] {
  const out: { n: number; marker: MarkerState }[] = [];
  for (let n = 0; n < MAX_TUNNEL_MARKERS; n++) {
    const marker = state.markers[tunnelMarkerId(player, n)];
    if (marker) out.push({ n, marker });
  }
  return out;
}

/**
 * "Your Tunnel markers and the area between your sequentially numbered markers … create your
 * TUNNEL." Base-to-TUNNEL distance in inches; 0 while the operative is on it.
 */
export function tunnelGapAt(state: GameState, player: PlayerId, pos: Vec2, base: BaseShape, rot = 0): number {
  const entries = tunnelMarkers(state, player);
  if (entries.length === 0) return Infinity;
  let best = Infinity;
  for (const { marker } of entries) {
    best = Math.min(best, baseGap(pos, base, rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0));
  }
  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i]!;
    const b = entries[i + 1]!;
    if (b.n !== a.n + 1) continue; // "markers 1 and 3 are not sequential"
    const d = distancePointToSegment(pos, a.marker.pos, b.marker.pos) - baseRadius(base) - MARKER_R;
    best = Math.min(best, Math.max(0, d));
  }
  return best;
}

export const tunnelGap = (state: GameState, player: PlayerId, op: OperativeState): number =>
  tunnelGapAt(state, player, op.pos, baseOf(op), op.rot);

export const onTunnel = (state: GameState, player: PlayerId, op: OperativeState): boolean =>
  tunnelGap(state, player, op) <= EPS;

/**
 * "At the end of the Set Up Operatives step, place your Tunnel marker numbered '0' on the
 * killzone floor, wholly within your drop zone and touching your killzone edge."
 *
 * There is no decision channel at deployment, so the position is a deterministic, logged default
 * (D-016): walk the player's killzone edge (the nearest board side when a map records no edge
 * segments), step MARKER_R inwards so the marker's own edge TOUCHES that killzone edge, keep the
 * spots where the whole marker is still inside the drop zone, and take the middle-most one.
 */
export function ensureTunnelStart(state: GameState, player: PlayerId): MarkerState | undefined {
  const existing = state.markers[tunnelMarkerId(player, 0)];
  if (existing) return existing;
  const zoneKey = state.setup.dropZone[player] ?? player;
  const zone = state.map.dropZones[zoneKey] ?? [];
  if (zone.length === 0) return undefined;
  const { w, h } = state.map.board;

  let lo = { x: Infinity, y: Infinity };
  let hi = { x: -Infinity, y: -Infinity };
  for (const poly of zone) {
    for (const p of poly) {
      lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) };
      hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) };
    }
  }
  const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };

  const edges = state.map.killzoneEdges[zoneKey] ?? [];
  const segments: { a: Vec2; b: Vec2 }[] =
    edges.length > 0
      ? edges.map((s) => ({ a: s.a, b: s.b }))
      : [nearestBoardSide(mid, { w, h }, lo, hi)];

  // "wholly within your drop zone" — the whole 20mm marker inside one drop-zone polygon.
  const inside = (p: Vec2): boolean =>
    zone.some((poly) => {
      if (!pointInside(p, poly)) return false;
      let d = Infinity;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        d = Math.min(d, distancePointToSegment(p, poly[j]!, poly[i]!));
      }
      return d >= MARKER_R - 1e-3;
    });

  let best: Vec2 | undefined;
  let bestKey = Infinity;
  for (const seg of segments) {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // Inward normal: perpendicular to the edge, pointing at the drop zone.
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * (mid.x - seg.a.x) + ny * (mid.y - seg.a.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let t = 0; t <= 1 + 1e-9; t += 0.02) {
      const p = { x: seg.a.x + dx * t + nx * MARKER_R, y: seg.a.y + dy * t + ny * MARKER_R };
      const q = { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
      if (q.x < MARKER_R - 1e-6 || q.y < MARKER_R - 1e-6 || q.x > w - MARKER_R + 1e-6 || q.y > h - MARKER_R + 1e-6)
        continue;
      if (!inside(q)) continue;
      const key = Math.abs(t - 0.5);
      if (key < bestKey) {
        bestKey = key;
        best = q;
      }
    }
  }
  const pos = best ?? mid;
  const marker: MarkerState = {
    id: tunnelMarkerId(player, 0),
    kind: 'generic',
    diameterMm: MARKER_MM,
    pos,
    z: 0,
    owner: player,
    flags: { tunnel: 0 },
  };
  state.markers[marker.id] = marker;
  log(state, {
    kind: 'system',
    player,
    text: `Tunnel marker 0 placed at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
    data: { markerId: marker.id },
  });
  return marker;
}

/** The board side nearest the drop zone, for maps whose `killzoneEdges` are empty. */
function nearestBoardSide(
  mid: Vec2,
  board: { w: number; h: number },
  lo: Vec2,
  hi: Vec2,
): { a: Vec2; b: Vec2 } {
  const sides: { d: number; a: Vec2; b: Vec2 }[] = [
    { d: mid.x, a: { x: 0, y: lo.y }, b: { x: 0, y: hi.y } },
    { d: board.w - mid.x, a: { x: board.w, y: lo.y }, b: { x: board.w, y: hi.y } },
    { d: mid.y, a: { x: lo.x, y: 0 }, b: { x: hi.x, y: 0 } },
    { d: board.h - mid.y, a: { x: lo.x, y: board.h }, b: { x: hi.x, y: board.h } },
  ];
  sides.sort((p, q) => p.d - q.d);
  const first = sides[0]!;
  return { a: first.a, b: first.b };
}

function pointInside(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y + 1e-12) + pi.x)
      inside = !inside;
  }
  return inside;
}

/**
 * "…place your next numbered Tunnel marker on the killzone floor wholly within 5" of your
 * preceding Tunnel marker." Both markers are 20mm, so "wholly within" is
 * `dist(centres) + r_new − r_preceding ≤ 5` — i.e. `dist ≤ 5` (the Wolf Scouts STORM shape).
 */
export function tunnelStepLegal(from: Vec2, to: Vec2): boolean {
  return dist(from, to) + MARKER_R - MARKER_R <= 5 + EPS;
}

function placeNextTunnelMarker(state: GameState, player: PlayerId, want?: Vec2): MarkerState | undefined {
  const entries = tunnelMarkers(state, player);
  const last = entries[entries.length - 1];
  if (!last) return undefined;
  if (entries.length >= MAX_TUNNEL_MARKERS) return undefined;
  const n = last.n + 1;
  const { w, h } = state.map.board;
  const clamp = (p: Vec2): Vec2 => ({
    x: Math.min(Math.max(p.x, MARKER_R), w - MARKER_R),
    y: Math.min(Math.max(p.y, MARKER_R), h - MARKER_R),
  });
  let pos: Vec2 | undefined;
  if (want && tunnelStepLegal(last.marker.pos, clamp(want))) pos = clamp(want);
  if (!pos) {
    // D-016: no decision channel for a position, so head 5" toward the enemy centroid (the
    // board centre when no enemy is in the killzone), backing off until it fits on the board.
    const foes = aliveOperatives(state, otherPlayer(player)).filter((o) => o.pos.x >= 0 && o.pos.y >= 0);
    const aim =
      foes.length > 0
        ? foes.reduce((a, o) => ({ x: a.x + o.pos.x / foes.length, y: a.y + o.pos.y / foes.length }), { x: 0, y: 0 })
        : { x: w / 2, y: h / 2 };
    const dx = aim.x - last.marker.pos.x;
    const dy = aim.y - last.marker.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    for (let step = 5; step >= 0; step -= 0.5) {
      const candidate = clamp({
        x: last.marker.pos.x + (dx / len) * step,
        y: last.marker.pos.y + (dy / len) * step,
      });
      if (tunnelStepLegal(last.marker.pos, candidate)) {
        pos = candidate;
        break;
      }
    }
  }
  if (!pos) return undefined;
  const marker: MarkerState = {
    id: tunnelMarkerId(player, n),
    kind: 'generic',
    diameterMm: MARKER_MM,
    pos,
    z: 0,
    owner: player,
    flags: { tunnel: n },
  };
  state.markers[marker.id] = marker;
  log(state, {
    kind: 'ploy',
    player,
    text: `Tunnel marker ${n} placed at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
    data: { markerId: marker.id },
  });
  return marker;
}

// ---------------------------------------------------------------------------
// Underground
// ---------------------------------------------------------------------------

/** "Place it to one side instead of in the killzone" — off the floor, but still deployed. */
const parkingSpot = (index: number): Vec2 => ({ x: -20, y: -20 - index * 2.5 });

export const isUnderground = (state: GameState, op: OperativeState): boolean =>
  state.effects.some((e) => e.rule === UNDERGROUND && e.operativeId === op.id);

export const undergroundOperatives = (state: GameState, player: PlayerId): OperativeState[] =>
  aliveOperatives(state, player).filter((o) => isUnderground(state, o));

function goUnderground(state: GameState, op: OperativeState, sourceId: string): void {
  if (isUnderground(state, op)) return;
  const index = undergroundOperatives(state, op.player).length;
  op.pos = parkingSpot(index);
  op.z = 0;
  op.onGuard = false;
  op.stickyEngagedWith = [];
  effect(state, {
    rule: UNDERGROUND,
    source: { kind: 'ability', id: sourceId },
    sourceText: shortQuote(text(RULE.burrow)),
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfBattle' },
  });
  log(state, { kind: 'action', player: op.player, text: `${op.letter} is now underground`, data: { operativeId: op.id } });
}

function comeUp(state: GameState, op: OperativeState, pos: Vec2): void {
  dropEffects(state, (e) => e.rule === UNDERGROUND && e.operativeId === op.id);
  op.pos = { ...pos };
  op.z = 0;
}

/**
 * "When setting up a RAVENER kill team before the battle, your first two operatives must be set
 * up as normal. Each other friendly RAVENER operative thereafter can be set up underground."
 *
 * A pure setter (docs/DECISIONS.md D-017): the Set Up Operatives step has no decision channel,
 * and burying operatives silently would be worse than burying none. Returns the ids actually
 * placed underground.
 */
export function setUnderground(state: GameState, player: PlayerId, operativeIds: string[]): string[] {
  const team = aliveOperatives(state, player);
  const allowed = Math.max(0, team.length - 2); // "your first two operatives must be set up as normal"
  const done: string[] = [];
  for (const id of operativeIds) {
    if (done.length >= allowed) break;
    const op = state.operatives[id];
    if (!op || op.player !== player || op.removed) continue;
    if (!(catalogueCard(op.datacardId)?.keywords ?? []).includes(KW)) continue;
    goUnderground(state, op, RULE.burrow);
    done.push(id);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Placement for the BURROW action's re-emergence
// ---------------------------------------------------------------------------

function placeable(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
): { ok: boolean; reason?: string } {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const r = baseRadius(c.base);
  const { w, h } = state.map.board;
  if (pos.x - r < -EPS || pos.y - r < -EPS || pos.x + r > w + EPS || pos.y + r > h + EPS)
    return { ok: false, reason: 'bases cannot be over the edge of the killzone' };
  const index = terrain(ctx, state);
  if (baseTouchesHazardous(index, pos, c.base, op.rot))
    return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const blocked = baseBlockedByTerrain(index, pos, c.base, op.rot, 0, modelHeight(c));
  if (blocked) return { ok: false, reason: `it cannot be placed on ${blocked.types.join('+')} terrain` };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id || isUnderground(state, other)) continue;
    if (Math.abs(other.z) > 1) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (basesOverlap(pos, c.base, op.rot, other.pos, oc.base, other.rot))
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true };
}

const RING_STEPS = [0, 0.6, 1.2, 1.8];

/**
 * "Set it up on your TUNNEL in a location it can be placed (… it can be set up within control
 * range of enemy operatives)." `check` and `perform` share this resolver so nothing `check`
 * accepts can be refused later (docs/DECISIONS.md D-026).
 */
export function emergeSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  want?: Vec2,
): { ok: boolean; reason?: string; pos?: Vec2 } {
  const base = ctx.datacards.get(op.datacardId)?.base ?? DEFAULT_BASE;
  const onIt = (p: Vec2): boolean => tunnelGapAt(state, op.player, p, base, op.rot) <= EPS;
  if (want) {
    if (!onIt(want)) return { ok: false, reason: 'it must be set up on your TUNNEL' };
    const p = placeable(ctx, state, op, want);
    return p.ok ? { ok: true, pos: want } : { ok: false, reason: p.reason ?? 'it cannot be placed there' };
  }
  // Deterministic default (D-016): the highest-numbered Tunnel marker first — the newest tunnel
  // mouth, furthest into the killzone — then rings around it.
  const entries = tunnelMarkers(state, op.player);
  if (entries.length === 0) return { ok: false, reason: 'you have no Tunnel markers' };
  for (let i = entries.length - 1; i >= 0; i--) {
    const centre = entries[i]!.marker.pos;
    for (const radius of RING_STEPS) {
      for (let a = 0; a < 360; a += radius === 0 ? 360 : 30) {
        const rad = (a * Math.PI) / 180;
        const p = { x: centre.x + Math.cos(rad) * radius, y: centre.y + Math.sin(rad) * radius };
        if (!onIt(p)) continue;
        if (placeable(ctx, state, op, p).ok) return { ok: true, pos: p };
      }
    }
  }
  return { ok: false, reason: 'there is no location on your TUNNEL it can be placed in' };
}

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

const isRavener = (op: OperativeState): boolean =>
  (catalogueCard(op.datacardId)?.keywords ?? []).includes(KW);

const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

/** "…has performed the Burrow action during that turning point." */
const burrowedThisTP = (state: GameState, op: OperativeState): boolean =>
  (bucket(state, BURROWED_TP) as Record<string, number>)[op.id] === state.turningPoint;

/** "…an enemy operative that performed the Fall Back action during this turning point." */
const fellBackThisTP = (state: GameState, op: OperativeState): boolean =>
  did(op, 'Fall Back') || (bucket(state, FELL_BACK_TP) as Record<string, number>)[op.id] === state.turningPoint;

/** "…currently benefitting from the effects of its Distend Dorsal Sac action." */
export function distendActive(state: GameState, op: OperativeState): boolean {
  const eff = effectOn(state, op.id, DISTEND);
  return Boolean(eff) && !eff!.data?.['shot'];
}

const VENOM_BOLT = 'venom bolt';
const sameName = (a: string | undefined, b: string): boolean => (a ?? '').trim().toLowerCase() === b;

// ---------------------------------------------------------------------------
// Faction rules, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // Tunnel
  // =========================================================================
  // "At the end of the Set Up Operatives step, place your Tunnel marker numbered '0'…"
  // `onDeploy` is the only hook the setup step emits; the activation-start binding is an
  // idempotent safety net for callers that place operatives without the reducer.
  reg.on('onDeploy', T.bind(RULE.tunnel, 8), (ev) => {
    if (ev.operative.player === T.player) ensureTunnelStart(ev.state, T.player);
  });
  reg.on('onActivationStart', T.bind(RULE.tunnel, 4), (ev) => {
    if (ev.operative.player === T.player) ensureTunnelStart(ev.state, T.player);
  });

  // "As a STRATEGIC GAMBIT in the first four turning points, you can place your next numbered
  //  Tunnel marker… Once you have placed five Tunnel markers, don't place any more."
  reg.on('gambitOptions', T.bind(RULE.tunnel, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint > 4) return;
    if (tunnelMarkers(ev.state, T.player).length >= MAX_TUNNEL_MARKERS) return;
    ev.options.push({ id: TUNNEL_GAMBIT, label: 'Tunnel: place your next Tunnel marker (0CP)', sourceText: shortQuote(text(RULE.tunnel)) });
  });
  reg.on('onPloyUsed', T.bind(RULE.tunnel, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== TUNNEL_GAMBIT) return;
    ensureTunnelStart(ev.state, T.player);
    const want = ev.data?.['pos'] as Vec2 | undefined;
    placeNextTunnelMarker(ev.state, T.player, want && typeof want.x === 'number' ? want : undefined);
  });

  // =========================================================================
  // Burrow
  // =========================================================================
  // "Whenever a friendly RAVENER operative is underground, it cannot perform any actions other
  //  than Burrow." The FELLTALON's TOXIC LUNGE prints its own override.
  reg.on('canPerformAction', T.bind(RULE.burrow, 8), (ev) => {
    if (!mine(ev.operative) || !isUnderground(ev.state, ev.operative)) return;
    if (ev.action === BURROW) return;
    if (ev.action === ACT.toxicLunge && ev.operative.datacardId === CARD.felltalon) return;
    ev.allowed = false;
    ev.reason = 'it is underground — it cannot perform any actions other than Burrow';
  });
  // An operative that is not in the killzone cannot be shot at.
  reg.on('onValidTarget', T.bind(RULE.burrow, 8), (ev) => {
    if (!mine(ev.target) || !isUnderground(ev.state, ev.target)) return;
    ev.valid = false;
    ev.reason = 'that operative is underground, not in the killzone';
  });
  // "At the end of the battle, each friendly RAVENER operative that's underground is
  //  incapacitated." `endTurningPoint` runs before the battle-end scoring, which is where the
  //  kill grade is read from.
  reg.on('onEndOfTP', T.bind(RULE.burrow, 8), (ev) => {
    if (ev.state.turningPoint < (ev.state.maxTurningPoints || 4)) return;
    let any = false;
    for (const op of undergroundOperatives(ev.state, T.player)) {
      if (op.incapacitated) continue;
      op.incapacitated = true;
      any = true;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `${op.letter} is still underground at the end of the battle and is incapacitated`,
      });
    }
    // `endTurningPoint` runs `removeIncapacitated` BEFORE this emit, so the casualties are swept
    // here or the end-of-battle op scoring would still see them in play.
    if (any && T.ctx) removeIncapacitated(T.ctx, ev.state);
  });

  // =========================================================================
  // Predatory Instincts
  // =========================================================================
  // "Each friendly RAVENER operative can counteract regardless of its order." `onCounteract` is
  // emitted with `allowed = (order === 'engage')` as the DEFAULT (D-028), so this widens it and
  // leaves expended / once-per-TP / the On Guard lockout to the core.
  reg.on('onCounteract', T.bind(RULE.instincts, 12), (ev) => {
    if (!mine(ev.operative)) return;
    ev.allowed = true;
  });
  // The second Fight is `Fight (Predatory Instincts)`; the order change is
  // `Change Order (Predatory Instincts)`. Both are ActionDefs registered below.

  // =========================================================================
  // Rare weapon rule › Poison  (FELLTALON, VENOMSPITTER)
  // =========================================================================
  // "In the Resolve Attack Dice step, if you inflict damage with any critical successes, the
  //  operative this weapon is being used against gains one of your Poison tokens."
  // `onStrikeResolved` is emitted by BOTH sequences — shoot.ts passes `crit: unblockedCrits > 0`
  // at the end of Resolve Attack Dice, fight.ts passes the struck die's crit-ness.
  // The FELLTALON and the VENOMSPITTER print the identical ability text, so one binding (keyed
  // on the weapon carrying the rule, not on the datacard) covers both.
  reg.on('onStrikeResolved', T.bind(AB.poisonFelltalon, 12), (ev) => {
    if (!ev.crit) return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Poison')) return;
    giveToken(ev.state, ev.struck, POISON_TOKEN, {
      sourceId: AB.poisonFelltalon,
      sourceText: shortQuote(abilityText(CARD.felltalon, AB.poisonFelltalon)),
      player: T.player,
    });
  });
  // "Whenever an operative that has one of your Poison tokens is activated, inflict D3 damage."
  reg.on('onActivationStart', T.bind(AB.poisonFelltalon, 13), (ev) => {
    if (!hasToken(ev.state, ev.operative.id, POISON_TOKEN, T.player)) return;
    if (!T.ctx) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'ravenersPoison', [d3], T.player, 'Poison D3');
    inflictDamage(T.ctx, ev.state, ev.operative, d3, 'other');
  });

  // =========================================================================
  // Rare weapon rule › Crush  (WRECKER)
  // =========================================================================
  // "Whenever you strike, you and your opponent roll-off, adding 1 to your result if the
  //  operative this weapon is being used against has a Wounds stat of 9 or less. If you win,
  //  inflict additional damage equal to the difference (to a maximum of 3)."
  reg.on('onStrikeResolved', T.bind(AB.crush, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Crush')) return;
    const bonus = (T.card(ev.struck)?.wounds ?? 99) <= 9 ? 1 : 0;
    const ours = T.ctx.rng.d6();
    const theirs = T.ctx.rng.d6();
    recordRoll(ev.state, 'crush', [ours, theirs], T.player, `Crush roll-off${bonus ? ' (+1)' : ''}`);
    const diff = ours + bonus - theirs;
    if (diff <= 0) return;
    const extra = Math.min(3, diff);
    log(ev.state, { kind: 'dice', player: T.player, text: `Crush: ${ours}${bonus ? '+1' : ''} vs ${theirs} — ${extra} additional damage` });
    inflictDamage(T.ctx, ev.state, ev.struck, extra, 'other');
  });

  // =========================================================================
  // PRIME › Neuropredatory Crest
  // =========================================================================
  const primeNear = (state: GameState, foe: OperativeState): boolean =>
    T.friendlies(state).some(
      (o) => o.datacardId === CARD.prime && !o.incapacitated && !isUnderground(state, o) && T.gap(o, foe) <= 3 + EPS,
    );

  // "Whenever determining control of a marker, treat the total APL stat of enemy operatives that
  //  contest it as 1 lower if at least one of those enemy operatives is within 3" of this
  //  operative. Note this isn't a change to the APL stat, so any changes are cumulative."
  reg.on('onMarkerControl', T.bind(AB.crest, 12), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const foe = otherPlayer(T.player);
    const contesting = T.enemies(ev.state).filter((o) => markerContestedBy(T.ctx!, ev.state, marker, o));
    if (contesting.length === 0) return;
    if (!contesting.some((o) => primeNear(ev.state, o))) return;
    ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });

  // "Your opponent must spend 1 additional AP for that enemy operative to perform the Pick Up
  //  Marker and mission actions."
  reg.on('onActionCost', T.bind(AB.crest, 12), (ev) => {
    const op = ev.operative;
    if (op.player === T.player) return;
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    if (!primeNear(ev.state, op)) return;
    ev.ap += 1;
  });

  // "Your opponent cannot re-roll their attack or defence dice for that operative."
  // Attack dice: `onRollAttack` is emitted by shoot.ts ONLY (D-031), so the fighting/retaliating
  // half is unreachable — recorded in REMINDER_ONLY. Defence dice are shoot-only anyway.
  reg.on('onRollAttack', T.bind(AB.crest, 45), (ev) => {
    const shooter = ev.ctx.attacker;
    if (shooter.player === T.player) return;
    if (!primeNear(ev.state, shooter)) return;
    if (ev.rerolls.length === 0) return;
    ev.rerolls.length = 0;
    log(ev.state, { kind: 'dice', player: T.player, text: `Neuropredatory Crest: ${shooter.letter} cannot re-roll its attack dice` });
  });
  reg.on('onDefenceDice', T.bind(AB.crest, 45), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player === T.player) return;
    if (!primeNear(ev.state, target)) return;
    if (ev.rerolls.length === 0) return;
    ev.rerolls.length = 0;
    log(ev.state, { kind: 'dice', player: T.player, text: `Neuropredatory Crest: ${target.letter} cannot re-roll its defence dice` });
  });

  // =========================================================================
  // PRIME › Synaptic Link — "STRATEGIC GAMBIT if this operative isn't incapacitated."
  // =========================================================================
  reg.on('gambitOptions', T.bindText(AB.synapticLink, abilityText(CARD.prime, AB.synapticLink), 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.prime && !o.incapacitated)) return;
    ev.options.push({
      id: SYNAPTIC_GAMBIT,
      label: 'Synaptic Link (0CP)',
      sourceText: shortQuote(abilityText(CARD.prime, AB.synapticLink)),
    });
  });
  reg.on('onPloyUsed', T.bindText(AB.synapticLink, abilityText(CARD.prime, AB.synapticLink), 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SYNAPTIC_GAMBIT || !T.ctx) return;
    const prime = T.friendlies(ev.state).find((o) => o.datacardId === CARD.prime && !o.incapacitated);
    if (!prime) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'synapticLink', [roll], T.player, `Synaptic Link vs TP${ev.state.turningPoint}`);
    if (roll >= 2 * ev.state.turningPoint) {
      ev.state.teams[T.player].cp += 1;
      log(ev.state, { kind: 'ploy', player: T.player, text: `Synaptic Link: ${roll} is twice the turning point or higher — gain 1CP` });
    } else if (roll < ev.state.turningPoint) {
      log(ev.state, { kind: 'ploy', player: T.player, text: `Synaptic Link: ${roll} is less than the turning point — ${roll} damage` });
      inflictDamage(T.ctx, ev.state, prime, roll, 'other');
    } else {
      log(ev.state, { kind: 'ploy', player: T.player, text: `Synaptic Link: ${roll} — nothing happens` });
    }
  });

  // =========================================================================
  // TREMORSCYTHE › Subterranean Ambush — REMINDER-ONLY (see REMINDER_ONLY)
  // =========================================================================
  // The trigger IS detectable, so it is recorded as the printed Subterranean Ambush token for
  // the UI; nothing is enforced, because every clause hangs off an activation interrupt.
  reg.on('onActivationStart', T.bindText(AB.ambush, abilityText(CARD.tremorscythe, AB.ambush), 5), (ev) => {
    if (ev.operative.player === T.player) return;
    dropEffects(ev.state, (e) => e.rule === ACTIVATION_MARK && e.operativeId === ev.operative.id);
    effect(ev.state, {
      rule: ACTIVATION_MARK,
      source: { kind: 'ability', id: AB.ambush },
      operativeId: ev.operative.id,
      player: T.player,
      data: { seq: ev.state.seq },
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
  });
  reg.on('onActivationEnd', T.bindText(AB.ambush, abilityText(CARD.tremorscythe, AB.ambush), 20), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || ev.state.phase !== 'firefight') return;
    if (biggestMove(ev.state, foe) <= 2 + EPS) return;
    if (tunnelGap(ev.state, T.player, foe) > 2 + EPS) return;
    const scythe = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CARD.tremorscythe &&
        isUnderground(ev.state, o) &&
        (o.ready || !o.counteractedThisTP),
    );
    if (!scythe) return;
    if (!useOncePerTP(ev.state, `raveners.ambush:${T.player}`)) return;
    effect(ev.state, {
      rule: AMBUSH_TOKEN,
      source: { kind: 'ability', id: AB.ambush },
      sourceText: shortQuote(abilityText(CARD.tremorscythe, AB.ambush)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Subterranean Ambush: ${foe.letter} ended a move within 2" of your TUNNEL (the interrupt itself is not modelled)`,
      data: { operativeId: foe.id, reminderOnly: true },
    });
  });

  // =========================================================================
  // WARRIOR › Instinctive Behaviour
  // =========================================================================
  // "Whenever this operative is shooting against, fighting against or retaliating against a
  //  wounded enemy operative, or an enemy operative that performed the Fall Back action during
  //  this turning point, this operative's weapons have the Lethal 5+ weapon rule."
  // `onWeaponRules` is read by BOTH sequences (shoot's `effectiveRules` and fight's `sideWeapon`
  // for the attacker AND the retaliating defender), so all three modes are live.
  reg.on('onWeaponRules', T.bindText(AB.instinctive, abilityText(CARD.warrior, AB.instinctive), 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.warrior) return;
    const foe = ev.target;
    if (!foe || foe.player === T.player) return;
    const wounded = T.ctx ? isWounded(T.ctx, foe) : foe.wounds < (T.card(foe)?.wounds ?? foe.wounds);
    if (!wounded && !fellBackThisTP(ev.state, foe)) return;
    if (ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+'));
  });
  // The per-turning-point Fall Back ledger the clause above reads.
  reg.on('onActivationEnd', T.bindText(AB.instinctive, abilityText(CARD.warrior, AB.instinctive), 4), (ev) => {
    if (!did(ev.operative, 'Fall Back')) return;
    (bucket(ev.state, FELL_BACK_TP) as Record<string, number>)[ev.operative.id] = ev.state.turningPoint;
  });

  // =========================================================================
  // WRECKER › Reinforced Carapace
  // =========================================================================
  // "Normal and Critical Dmg of 4 or more inflicts 1 less damage on this operative."
  // `onDamage` always carries `ctx: null`, so the striking profile is re-derived from
  // `state.sequence` (the Hearthkyn Weavefield Crest shape). A shoot inflicts one aggregated
  // total, so the reduction is counted per unblocked attack dice.
  reg.on('onDamage', T.bindText(AB.carapace, abilityText(CARD.wrecker, AB.carapace), 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== CARD.wrecker) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    if (seq.kind === 'fight') {
      // One strike, one dice: `ev.amount` IS the weapon's Normal or Critical Dmg.
      if (ev.amount >= 4) ev.amount -= 1;
      return;
    }
    if (seq.targetId !== target.id) return;
    const attacker = ev.state.operatives[seq.attackerId];
    const weapon = attacker ? T.card(attacker)?.weapons.find((w) => w.name === seq.weaponName) : undefined;
    const profile = weapon?.profiles.find((p) => (p.name ?? '') === (seq.profileName ?? '')) ?? weapon?.profiles[0];
    if (!profile) return;
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
    const reduction = (profile.dmgC >= 4 ? crits : 0) + (profile.dmgN >= 4 ? normals : 0);
    if (reduction > 0) ev.amount = Math.max(0, ev.amount - reduction);
  });
}

/** The largest single move (in inches) this operative made during its activation. */
function biggestMove(state: GameState, op: OperativeState): number {
  const start = effectOn(state, op.id, ACTIVATION_MARK)?.data?.['seq'];
  if (typeof start !== 'number') return 0;
  let best = 0;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.seq < start) break;
    if (entry.kind !== 'action' || entry.data?.['operativeId'] !== op.id) continue;
    const inches = entry.data?.['inches'];
    if (typeof inches === 'number') best = Math.max(best, inches);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // DEATH FROM BELOW (strategy)
  // =========================================================================
  // "Whenever a friendly RAVENER operative is FIGHTING: Balanced if it's performed the Burrow
  //  action during that activation/counteraction; Ceaseless if it's on your TUNNEL."
  reg.on('onWeaponRules', T.bind(SP.deathFromBelow, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.deathFromBelow)) return;
    if (ev.type !== 'melee' || ev.retaliating || !mine(ev.operative)) return; // "is fighting"
    if (did(ev.operative, BURROW)) ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Death From Below)'));
    if (onTunnel(ev.state, T.player, ev.operative))
      ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Death From Below)'));
  });

  // =========================================================================
  // WHIPCORD EMERGENCE (strategy)
  // =========================================================================
  // "Whenever an operative is shooting a friendly RAVENER operative: re-roll ONE defence dice if
  //  that friendly operative has performed the Burrow action during that turning point; re-roll
  //  ANY of your defence dice if it's on your TUNNEL."
  reg.on('onDefenceDice', T.bind(SP.whipcordEmergence, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.whipcordEmergence)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !mine(target)) return;
    if (onTunnel(ev.state, T.player, target)) {
      ev.rerolls.push({
        id: 'raveners.whipcord.any',
        label: 'Whipcord Emergence: re-roll any of your defence dice',
        mode: 'any',
        player: T.player,
        sourceText: shortQuote(text(SP.whipcordEmergence)),
      });
    } else if (burrowedThisTP(ev.state, target)) {
      ev.rerolls.push({
        id: 'raveners.whipcord.one',
        label: 'Whipcord Emergence: re-roll one of your defence dice',
        mode: 'one',
        max: 1,
        player: T.player,
        sourceText: shortQuote(text(SP.whipcordEmergence)),
      });
    }
  });

  // =========================================================================
  // WRITHE OUT OF SIGHT (strategy)
  // =========================================================================
  // "Select one friendly RAVENER operative in the killzone. That friendly operative can
  //  immediately perform a free Burrow action. If it's within 2" of your TUNNEL, it can
  //  immediately perform a free Fall Back or Reposition action before it does so."
  // One AP outside that operative's APL budget (docs/DECISIONS.md D-100), restricted to the
  // named actions and landing on its next activation. Nothing sweeps the grant afterwards:
  // this is a STRATEGIC GAMBIT, so it is used before anybody has activated in the turning
  // point and the recipient's own activation is always still to come — `expireActivationEffects`
  // takes the AP back when that activation ends.
  reg.on('onPloyUsed', T.bind(SP.writheOutOfSight, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.writheOutOfSight) return;
    const candidates = T.friendlies(ev.state, KW).filter((o) => !isUnderground(ev.state, o));
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    const near = tunnelGap(ev.state, T.player, op) <= 2 + EPS;
    grantFreeAction(ev.state, op, {
      sourceId: SP.writheOutOfSight,
      sourceText: shortQuote(text(SP.writheOutOfSight)),
      threshold: currentApl(T, ev.state, op),
      only: near ? [BURROW, 'Reposition', 'Fall Back'] : [BURROW],
    });
  });

  // =========================================================================
  // TUNNEL LURKERS (strategy)
  // =========================================================================
  // "Whenever a friendly RAVENER operative is on your TUNNEL it's in cover, unless it's within
  //  2" of the active operative. Treat this as cover provided by Light terrain (therefore it's
  //  affected by rules that prevent this, e.g. Seek Light and Vantage terrain)."
  //
  // `onValidTarget` has no "force cover" field, so the rule lands at its two printed
  // consequences: a Conceal-order target stops being valid, and a cover save is retained.
  const lurkerCover = (
    state: GameState,
    attacker: OperativeState,
    target: OperativeState,
    ignoreCoverTerrain: 'none' | 'light' | 'all',
  ): boolean => {
    if (!gambitUsed(state, T.player, SP.tunnelLurkers)) return false;
    if (!mine(target) || !onTunnel(state, T.player, target)) return false;
    // "…unless it's within 2" of the active operative" — the same 2" denial the core applies.
    const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
    const near = active && active.player !== target.player ? active : attacker;
    if (T.gap(near, target) <= 2 + EPS) return false;
    // "…affected by rules that prevent this, e.g. Seek Light and Vantage terrain."
    if (ignoreCoverTerrain !== 'none') return false;
    if (T.ctx) {
      const index = terrain(T.ctx, state);
      const from = body(T.ctx, attacker);
      const to = body(T.ctx, target);
      // The core's own `vantageDeniesLightCover` predicate.
      if (from.z - to.z >= 2 - EPS && target.order === 'conceal' && vantageAccurate(index, from, to) > 0) return false;
    }
    return true;
  };
  reg.on('onValidTarget', T.bind(SP.tunnelLurkers, 21), (ev) => {
    if (ev.target.order !== 'conceal') return; // an Engage target in cover is still valid
    if (!lurkerCover(ev.state, ev.viewFrom ?? ev.attacker, ev.target, ev.ignoreCoverTerrain)) return;
    ev.valid = false;
    ev.reason = 'target has a Conceal order and is in cover (Tunnel Lurkers)';
  });
  reg.on('onDefenceDice', T.bind(SP.tunnelLurkers, 21), (ev) => {
    if (ev.count <= 0 || ev.ctx.type !== 'ranged') return; // the Roll Defence Dice emit only
    const target = ev.ctx.defender;
    if (!target) return;
    if (hasRule(ev.ctx.rules, 'Saturate')) return; // Saturate denies a cover save
    if (!lurkerCover(ev.state, ev.ctx.attacker, target, hasRule(ev.ctx.rules, 'Seek') ? 'all' : hasRule(ev.ctx.rules, 'SeekLight') ? 'light' : 'none'))
      return;
    ev.coverSave = true;
  });

  // =========================================================================
  // SLITHERING EVASION (firefight)
  // =========================================================================
  // "…during a friendly RAVENER operative's activation or counteraction, before or after it
  //  performs an action. During that activation/counteraction, that operative can: perform the
  //  Fall Back action for 1 less AP; perform the Charge action while within control range of an
  //  enemy operative…"
  reg.on('onPloyUsed', T.bind(FP.slitheringEvasion, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.slitheringEvasion) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = active && mine(active) ? active : chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW));
    if (!op) return;
    effect(ev.state, {
      rule: SLITHERING,
      source: { kind: 'ploy', id: FP.slitheringEvasion },
      sourceText: shortQuote(text(FP.slitheringEvasion)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onActionCost', T.bind(FP.slitheringEvasion, 20), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, SLITHERING)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  // The Charge half is `Charge (Slithering Evasion)` (D-021), registered below.

  // =========================================================================
  // SUBTERRANEAN HORROR (firefight)
  // =========================================================================
  // "…when an enemy operative is performing the Fight action and selects a friendly RAVENER
  //  operative on your TUNNEL to fight against. In the Resolve Attack Dice step of that
  //  sequence, you resolve the first attack dice (i.e. defender instead of attacker)."
  //
  // `advanceFight` runs a whole fight inside the Fight action, so the ploy is declared in
  // advance (the Mandrakes SHADOW'S BITE shape) and fires as the attacker's pool is collected.
  reg.on('onPloyUsed', T.bind(FP.subterraneanHorror, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.subterraneanHorror) return;
    const seq = ev.state.sequence;
    if (seq?.kind === 'fight' && seq.defender === T.player) {
      const defender = ev.state.operatives[seq.defenderId];
      if (defender && mine(defender) && onTunnel(ev.state, T.player, defender)) {
        seq.turn = 'defender';
        log(ev.state, { kind: 'ploy', player: T.player, text: `Subterranean Horror: ${defender.letter} resolves the first attack dice` });
        return;
      }
    }
    effect(ev.state, {
      rule: HORROR_ARMED,
      source: { kind: 'ploy', id: FP.subterraneanHorror },
      sourceText: shortQuote(text(FP.subterraneanHorror)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onCollectAttackDice', T.bind(FP.subterraneanHorror, 20), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'fight') return;
    if (ev.ctx.attacker.id !== seq.attackerId) return; // the attacker's own pool
    const defender = ev.state.operatives[seq.defenderId];
    if (!defender || !mine(defender) || !onTunnel(ev.state, T.player, defender)) return;
    const armed = ev.state.effects.find((e) => e.rule === HORROR_ARMED && e.player === T.player);
    if (!armed) return;
    dropEffects(ev.state, (e) => e === armed);
    seq.turn = 'defender';
    log(ev.state, { kind: 'ploy', player: T.player, text: `Subterranean Horror: ${defender.letter} resolves the first attack dice` });
  });

  // =========================================================================
  // BURROWING STRIKE (firefight) — fired from inside the Burrow action, below.
  // =========================================================================

  // =========================================================================
  // DEATH FRENZY (firefight)
  // =========================================================================
  // "…when a friendly RAVENER operative is incapacitated. Before that operative is removed from
  //  the killzone, inflict D3 damage on each enemy operative within its control range (roll
  //  separately for each). If that friendly operative is a VENOMSPITTER that's currently
  //  benefitting from the effects of its Distend Dorsal Sac action, inflict 2D3 damage instead."
  reg.on('onIncapacitated', T.bind(FP.deathFrenzy, 20), (ev) => {
    if (ev.prevented || !T.ctx) return;
    if (!mine(ev.operative) || isUnderground(ev.state, ev.operative)) return;
    if (!ployUsed(ev.state, T.player, FP.deathFrenzy)) return;
    if (!useOncePerTP(ev.state, `raveners.deathFrenzy:${T.player}:${ev.operative.id}`)) return;
    const doubled = ev.operative.datacardId === CARD.venomspitter && distendActive(ev.state, ev.operative);
    const index = terrain(T.ctx, ev.state);
    for (const foe of T.enemies(ev.state)) {
      if (foe.incapacitated) continue;
      if (!withinControlRange(index, body(T.ctx, ev.operative), body(T.ctx, foe))) continue;
      const dice = doubled ? [T.ctx.rng.d3(), T.ctx.rng.d3()] : [T.ctx.rng.d3()];
      const dmg = dice.reduce((a, b) => a + b, 0);
      recordRoll(ev.state, 'deathFrenzy', dice, T.player, `Death Frenzy vs ${foe.letter}`);
      inflictDamage(T.ctx, ev.state, foe, dmg, 'other');
    }
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // CHROMATOSPORE CAMOUFLAGE — "if you can retain any cover saves, you can retain one
  // additional cover save. This isn't cumulative with improved cover saves from Vantage."
  reg.on('onDefenceDice', T.bind(EQ.chromatospore, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.chromatospore)) return;
    if (ev.count <= 0 || !ev.coverSave || ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !mine(target)) return;
    if (shootSeq(ev.state)?.vantageImprovedCover) return;
    ev.extraCoverSaves += 1;
  });

  // ACID BLOOD — "Whenever a friendly RAVENER operative is fighting or retaliating, whenever an
  // attack dice inflicts damage on it, roll one D6: on a 5+, inflict 1 damage on the enemy
  // operative in that sequence."
  reg.on('onDamage', T.bind(EQ.acidBlood, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.acidBlood)) return;
    if (ev.kind !== 'attack' || !T.ctx) return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'fight') return;
    if (!mine(ev.target)) return;
    const foeId = ev.target.id === seq.defenderId ? seq.attackerId : seq.defenderId;
    if (ev.target.id !== seq.defenderId && ev.target.id !== seq.attackerId) return;
    const foe = ev.state.operatives[foeId];
    if (!foe || foe.removed || foe.incapacitated) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'acidBlood', [roll], T.player, 'Acid Blood 5+');
    if (roll < 5) return;
    log(ev.state, { kind: 'action', player: T.player, text: `Acid Blood: ${roll} — 1 damage to ${foe.letter}` });
    inflictDamage(T.ctx, ev.state, foe, 1, 'other');
  });

  // METAMORPHIC FLESH — "Whenever a friendly RAVENER operative is activated, it regains up to
  // D3 lost wounds." Auto-used at the maximum (D-022: it is free and never a downside).
  reg.on('onActivationStart', T.bind(EQ.metamorphicFlesh, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.metamorphicFlesh)) return;
    if (!mine(ev.operative) || !T.ctx) return;
    const max = T.card(ev.operative)?.wounds ?? ev.operative.wounds;
    if (ev.operative.wounds >= max) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'metamorphicFlesh', [d3], T.player, 'Metamorphic Flesh D3');
    const healed = Math.min(d3, max - ev.operative.wounds);
    ev.operative.wounds += healed;
    log(ev.state, { kind: 'action', player: T.player, text: `Metamorphic Flesh: ${ev.operative.letter} regains ${healed} wounds` });
  });

  // HEIGHTENED SENSES is REMINDER-ONLY — `initiativeRollModifiers` is emitted before the D6 and
  // `rerollOffered` is never consulted, so an initiative re-roll has no expression at all.
}

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

function toxicLungeTargets(state: GameState, op: OperativeState): OperativeState[] {
  const under = isUnderground(state, op);
  const foes = aliveOperatives(state, otherPlayer(op.player)).filter((o) => !o.incapacitated);
  const base = baseOf(op);
  return foes
    .filter((foe) =>
      under
        ? // "Alternatively, if this operative is underground, select one enemy operative on
          //  your TUNNEL."
          tunnelGapAt(state, op.player, foe.pos, baseOf(foe), foe.rot) <= EPS
        : baseGap(op.pos, base, op.rot, foe.pos, baseOf(foe), foe.rot) <= 2 + EPS,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function actions(data: TeamData): ActionDef[] {
  return [
    // TOXIC LUNGE 1AP — FELLTALON
    uniqueAction(data, CARD.felltalon, ACT.toxicLunge, {
      check: (_ctx, state, op, params) => {
        if (effectOn(state, op.id, BURROW_STRIKE_SPENT))
          return { ok: false, reason: 'you cannot use Burrowing Strike and Toxic Lunge in the same activation' };
        const options = toxicLungeTargets(state, op);
        if (options.length === 0)
          return {
            ok: false,
            reason: isUnderground(state, op)
              ? 'no enemy operative is on your TUNNEL'
              : 'no enemy operative is within 2"',
          };
        const wanted = params.targetOperativeId;
        if (wanted && !options.some((o) => o.id === wanted))
          return { ok: false, reason: 'that enemy operative cannot be selected' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const options = toxicLungeTargets(state, op);
        const target = options.find((o) => o.id === params.targetOperativeId) ?? options[0]!;
        const d3 = ctx.rng.d3();
        recordRoll(state, 'toxicLunge', [d3], op.player, `TOXIC LUNGE vs ${target.letter}`);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: TOXIC LUNGE on ${target.letter} (${d3}+2)` });
        giveToken(state, target, POISON_TOKEN, {
          sourceId: ACT.toxicLunge,
          sourceText: shortQuote(actionText(CARD.felltalon, ACT.toxicLunge)),
          player: op.player,
        });
        inflictDamage(ctx, state, target, d3 + 2, 'other');
        // "…(and vice versa)" — Burrowing Strike is then locked out for this activation.
        effect(state, {
          rule: BURROW_STRIKE_SPENT,
          source: { kind: 'ability', id: ACT.toxicLunge },
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        return { ok: true };
      },
    }),

    // DISTEND DORSAL SAC 1AP — VENOMSPITTER
    uniqueAction(data, CARD.venomspitter, ACT.distend, {
      check: (_ctx, state, op) =>
        isUnderground(state, op)
          ? { ok: false, reason: 'it is underground — it cannot perform any actions other than Burrow' }
          : { ok: true },
      perform: (_ctx, state, op) => {
        // "…until it performs this action again…" — the old effect is replaced.
        dropEffects(state, (e) => e.rule === DISTEND && e.operativeId === op.id);
        effect(state, {
          rule: DISTEND,
          source: { kind: 'ability', id: ACT.distend },
          sourceText: shortQuote(actionText(CARD.venomspitter, ACT.distend)),
          operativeId: op.id,
          player: op.player,
          data: { shot: false },
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: DISTEND DORSAL SAC` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// BURROW — printed inside the Burrow faction rule, not on a datacard
// ---------------------------------------------------------------------------

const BURROW_TEXT = text(RULE.burrow);

/** Which half of the action this is: emerge (underground) or submerge (in the killzone). */
function burrowMode(state: GameState, op: OperativeState, choice?: string): 'emerge' | 'submerge' {
  if (isUnderground(state, op)) return 'emerge';
  if (choice === 'emerge' || choice === 'submerge') return choice;
  return 'submerge';
}

function burrowingStrike(ctx: GameContext, state: GameState, op: OperativeState): void {
  if (!ployUsed(state, op.player, FP.burrowingStrike)) return;
  if (effectOn(state, op.id, BURROW_STRIKE_SPENT)) return;
  effect(state, {
    rule: BURROW_STRIKE_SPENT,
    source: { kind: 'ploy', id: FP.burrowingStrike },
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  const index = terrain(ctx, state);
  for (const foe of aliveOperatives(state, otherPlayer(op.player))) {
    if (foe.incapacitated) continue;
    if (!withinControlRange(index, body(ctx, op), body(ctx, foe))) continue;
    const d3 = ctx.rng.d3();
    recordRoll(state, 'burrowingStrike', [d3], op.player, `Burrowing Strike vs ${foe.letter}`);
    log(state, { kind: 'ploy', player: op.player, text: `Burrowing Strike: ${d3}+1 damage to ${foe.letter}` });
    inflictDamage(ctx, state, foe, d3 + 1, 'other');
  }
}

registerAction({
  id: BURROW,
  name: 'Burrow',
  ap: 1,
  type: 'unique',
  sourceText: BURROW_TEXT,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    // "An operative cannot perform this action while carrying a marker."
    if (op.carryingMarkerId) return { ok: false, reason: 'an operative cannot perform this action while carrying a marker' };
    if (burrowMode(state, op, params.choice) === 'emerge') {
      const spot = emergeSpot(ctx, state, op, params.targetPos);
      return spot.ok ? { ok: true } : { ok: false, reason: spot.reason ?? 'it cannot be set up on your TUNNEL' };
    }
    if (!onTunnel(state, op.player, op)) return { ok: false, reason: 'it must be in the killzone and on your TUNNEL' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const mode = burrowMode(state, op, params.choice);
    if (mode === 'emerge') {
      const spot = emergeSpot(ctx, state, op, params.targetPos);
      if (!spot.ok || !spot.pos) return { ok: false, reason: spot.reason ?? 'it cannot be set up on your TUNNEL' };
      comeUp(state, op, spot.pos);
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter} burrows up onto your TUNNEL at (${spot.pos.x.toFixed(1)}, ${spot.pos.y.toFixed(1)})`,
        data: { operativeId: op.id, action: BURROW },
      });
      // "Until the end of the activation/counteraction, subtract 2" from its Move stat."
      effect(state, {
        rule: 'raveners.burrowMove',
        source: { kind: 'ability', id: RULE.burrow },
        sourceText: shortQuote(BURROW_TEXT),
        operativeId: op.id,
        player: op.player,
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
      // "…or AFTER setting it up on your TUNNEL, inflict D3+1 damage…"
      burrowingStrike(ctx, state, op);
    } else {
      // "…BEFORE that operative is removed from the killzone, inflict D3+1 damage…"
      burrowingStrike(ctx, state, op);
      goUnderground(state, op, RULE.burrow);
      // "…until it performs the Burrow action" ends Distend Dorsal Sac.
      dropEffects(state, (e) => e.rule === DISTEND && e.operativeId === op.id);
    }
    (bucket(state, BURROWED_TP) as Record<string, number>)[op.id] = state.turningPoint;
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Predatory Instincts — the second Fight and the counteraction order change
// ---------------------------------------------------------------------------

const INSTINCTS_TEXT = text(RULE.instincts);

registerAction({
  id: FIGHT_AGAIN,
  name: 'Fight (Predatory Instincts)',
  ap: 1,
  type: 'unique',
  sourceText: INSTINCTS_TEXT,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    if (counteracting(state, op)) return { ok: false, reason: 'Predatory Instincts is two Fight actions during an ACTIVATION' };
    if (!did(op, 'Fight')) return { ok: false, reason: 'this is the second Fight action of an activation' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

registerAction({
  id: CHANGE_ORDER,
  name: 'Change Order (Predatory Instincts)',
  ap: 1,
  type: 'unique',
  sourceText: INSTINCTS_TEXT,
  available: (ctx, state, op) =>
    (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW) && counteracting(state, op),
  check(_ctx, state, op) {
    if (!counteracting(state, op)) return { ok: false, reason: 'only while counteracting' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.order = op.order === 'engage' ? 'conceal' : 'engage';
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} changes its order to ${op.order} instead of performing an action`,
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Two Charge carve-outs (D-021): the universal Charge refuses both, and
// `canPerformAction` can only forbid, never permit.
// ---------------------------------------------------------------------------

function chargeMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: Parameters<ActionDef['check']>[3],
): { ok: boolean; reason?: string } {
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const v = validateMove(ctx, state, op, params.path, {
    action: 'Charge',
    bonusInches: 2,
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
  });
  return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
}

const chargeRestrictions = (op: OperativeState): { ok: boolean; reason?: string } =>
  ['Reposition', 'Dash', 'Fall Back'].some((a) => did(op, a))
    ? { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' }
    : { ok: true };

registerAction({
  id: CHARGE_HYPERSENSORY,
  name: 'Charge (Hypersensory Hunter)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(CARD.tremorscythe, AB.hypersensory),
  available: (_ctx, _state, op) => op.datacardId === CARD.tremorscythe,
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
    if (!did(op, BURROW))
      return { ok: false, reason: 'it must have performed the Burrow action during the same activation/counteraction' };
    if (aliveOperatives(state, otherPlayer(op.player)).some((e) => withinControlRange(terrain(ctx, state), body(ctx, op), body(ctx, e))))
      return { ok: false, reason: 'already within control range of an enemy operative' };
    const r = chargeRestrictions(op);
    if (!r.ok) return r;
    return chargeMove(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

registerAction({
  id: CHARGE_SLITHERING,
  name: 'Charge (Slithering Evasion)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: text(FP.slitheringEvasion),
  available: (ctx, state, op) =>
    (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW) &&
    state.effects.some((e) => e.rule === SLITHERING && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === SLITHERING && e.operativeId === op.id))
      return { ok: false, reason: 'Slithering Evasion has not been used for this operative' };
    if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
    const r = chargeRestrictions(op);
    if (!r.ok) return r;
    // "…but then normal requirements for that move apply" — everything except the printed
    // "if it's already within control range of an enemy operative" ban.
    return chargeMove(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const raveners = defineTeam({
  id: 'raveners',
  rules: (reg, T) => {
    rules(reg, T);

    // Burrow: "Until the end of the activation/counteraction, subtract 2" from its Move stat."
    reg.on('onStatMod', T.bind(RULE.burrow, 12), (ev) => {
      if (ev.operative.player !== T.player) return;
      if (effectOn(ev.state, ev.operative.id, 'raveners.burrowMove')) ev.mods.move -= 2;
    });

    // DISTEND DORSAL SAC — "all profiles of its venom bolt have the Lethal 5+ weapon rule, have
    // 1 added to their Atk stat and the Range 8" weapon rule removed" (D-019: the shared profile
    // is never rewritten).
    reg.on('onWeaponRules', T.bindText(ACT.distend, actionText(CARD.venomspitter, ACT.distend), 12), (ev) => {
      if (ev.operative.player !== T.player || !sameName(ev.weaponName, VENOM_BOLT)) return;
      if (!distendActive(ev.state, ev.operative)) return;
      for (let i = ev.rules.length - 1; i >= 0; i--) if (ev.rules[i]!.id === 'Range') ev.rules.splice(i, 1);
      if (!ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+'));
    });
    reg.on('onCollectAttackDice', T.bindText(ACT.distend, actionText(CARD.venomspitter, ACT.distend), 12), (ev) => {
      if (ev.ctx.attacker.player !== T.player || !sameName(ev.ctx.weaponName, VENOM_BOLT)) return;
      if (!distendActive(ev.state, ev.ctx.attacker)) return;
      ev.count += 1;
      // "Until this operative HAS SHOT with its venom bolt" — the benefit covers the whole
      // action (Blast secondaries included) and is spent at the end of the activation.
      const eff = effectOn(ev.state, ev.ctx.attacker.id, DISTEND);
      if (eff) eff.data = { ...(eff.data ?? {}), fired: true };
    });
    reg.on('onActivationEnd', T.bindText(ACT.distend, actionText(CARD.venomspitter, ACT.distend), 12), (ev) => {
      if (ev.operative.player !== T.player) return;
      const eff = effectOn(ev.state, ev.operative.id, DISTEND);
      if (eff?.data?.['fired']) eff.data = { ...eff.data, shot: true };
    });
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    [FP.burrowingStrike]: (state, player) => {
      if (state.phase === 'strategy') return { ok: false, reason: 'you cannot use this ploy in the Strategy phase' };
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (active && active.player === player && active.datacardId === CARD.felltalon && effectOn(state, active.id, BURROW_STRIKE_SPENT))
        return { ok: false, reason: 'not during a FELLTALON activation in which it performs the Toxic Lunge action' };
      return { ok: true };
    },
    [FP.subterraneanHorror]: (state, player) => {
      const ready = aliveOperatives(state, player).some(
        (o) => isRavener(o) && !isUnderground(state, o) && onTunnel(state, player, o),
      );
      return ready ? { ok: true } : { ok: false, reason: 'no friendly RAVENER operative is on your TUNNEL' };
    },
    [FP.slitheringEvasion]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && isRavener(active)
        ? { ok: true }
        : { ok: false, reason: 'use it during a friendly RAVENER operative’s activation or counteraction' };
    },
  },
  aiHints: {
    roles: {
      [CARD.prime]: 'leader',
      [CARD.felltalon]: 'melee',
      [CARD.tremorscythe]: 'scout',
      [CARD.venomspitter]: 'gunner',
      [CARD.warrior]: 'objective',
      [CARD.wrecker]: 'melee',
    },
    ployValue: {
      [SP.deathFromBelow]: 0.6,
      [SP.whipcordEmergence]: 0.5,
      [SP.writheOutOfSight]: 0.35,
      [SP.tunnelLurkers]: 0.6,
      [FP.slitheringEvasion]: 0.45,
      [FP.subterraneanHorror]: 0.55,
      [FP.burrowingStrike]: 0.5,
      [FP.deathFrenzy]: 0.45,
    },
    equipmentValue: {
      [EQ.chromatospore]: 0.6,
      [EQ.acidBlood]: 0.5,
      [EQ.metamorphicFlesh]: 0.65,
      [EQ.heightenedSenses]: 0.05,
    },
  },
});

export default raveners;
