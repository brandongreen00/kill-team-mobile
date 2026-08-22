/**
 * VESPID STINGWINGS — T'au Empire.
 * https://wahapedia.ru/kill-team3/kill-teams/vespid-stingwings/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read
 * out of `data/teams/vespid-stingwings.json` and is never retyped here.
 *
 * Three faction rules, and each one is a different shape:
 *
 *  · **Communion** is a per-player point pool (the Hearthkyn Grudge / Novitiate Faith / Hernkyn
 *    Resourceful shape) that FOUR clauses read: a Shoot-targeting lock, a Charge end-position
 *    lock, a toll on Pick Up Marker and mission actions, and an attack-dice re-roll. The pool is
 *    gained in the Ready step and is the thing nine other rules on this team touch.
 *
 *  · **Neutron Charge** is one `onWeaponRules` grant keyed on "moved or used FLY this turning
 *    point", which is recorded as an effect at the end of each activation.
 *
 *  · **Fly** is a remove-and-set-up-again move. `onMoveRules.teleport` is declared but NEVER
 *    emitted (docs/TEAM-STATUS.md § Known engine gaps), so FLY is four sibling `ActionDef`s, each
 *    `treatedAs` its universal action — D-021, the Hearthkyn JUMP PACK WARRIOR and Sanctifiers
 *    CHERUB precedents, whose printed text is word-for-word the same shape as this one.
 *    **Only that half of Fly is reachable**: "whenever a friendly operative performs an action in
 *    which it moves, it can FLY" cannot be offered as an option *inside* the universal move
 *    actions (or inside a move another rule grants), because `validateMove` keeps its legs to
 *    itself and the one hook that carries `teleport` is never emitted.
 *
 * Three rare weapon rules, all defined on this team's own datacards (D-033): `NeutronFragment`
 * (LONGSTING), `NeutronBombardment` (SKYBLAST) and `Skytorch` (SWARMGUARD).
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { countCrits, lethalThreshold, piercingValue, rerollDie } from '../../core/dice.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  baseRadius,
  baseWhollyWithin,
  dist,
  distancePointToSegment,
  norm,
  segmentCrossesPoly,
  sub,
} from '../../core/geometry.ts';
import { advanceShoot, startShoot } from '../../core/sequences/shoot.ts';
import {
  aliveOperatives,
  body,
  findProfile,
  hitOf,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  modelHeight,
  moveOf,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, hasType, surfaceAt, wallRouteDistance } from '../../core/terrain.ts';
import { coverAndObscured, isVisible, withinControlRange, type Body } from '../../core/visibility.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PlayerId,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  chosenOperative,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  hasEquipment,
  ruleTag,
  uniqueAction,
  useOncePerSequence,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('vespid-stingwings');
const KW = 'VESPID STINGWING';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const STRAIN_LEADER = 'vespid-stingwings.strain-leader';
export const OVERSIGHT_DRONE = 'vespid-stingwings.oversight-drone';
export const LONGSTING = 'vespid-stingwings.longsting';
export const SHADESTRAIN = 'vespid-stingwings.shadestrain';
export const SKYBLAST = 'vespid-stingwings.skyblast';
export const SWARMGUARD = 'vespid-stingwings.swarmguard';
export const WARRIOR = 'vespid-stingwings.warrior';

export const RULE_COMMUNION = 'vespid-stingwings.rule.communion';
export const RULE_NEUTRON_CHARGE = 'vespid-stingwings.rule.neutron-charge';
export const RULE_FLY = 'vespid-stingwings.rule.fly';

export const SP_HARDENED = 'vespid-stingwings.sp.hardened-exoskeleton';
export const SP_AERIAL_AGILITY = 'vespid-stingwings.sp.aerial-agility';
export const SP_AIRBORNE_PREDATORS = 'vespid-stingwings.sp.airborne-predators';
export const SP_STING = 'vespid-stingwings.sp.sting';
export const FP_OCELLI = 'vespid-stingwings.fp.ocelli';
export const FP_DARTING_FLIGHT = 'vespid-stingwings.fp.darting-flight';
export const FP_NEUTRON_OVERLOAD = 'vespid-stingwings.fp.neutron-overload';
export const FP_VICIOUS_VENOM = 'vespid-stingwings.fp.vicious-venom';

export const EQ_NEUROSTIMULANT = 'vespid-stingwings.eq.neurostimulant';
export const EQ_CONVERGENCE = 'vespid-stingwings.eq.convergence-stimulant';
export const EQ_ACCELERANT = 'vespid-stingwings.eq.accelerant-stimulant';
export const EQ_AGGRESSION = 'vespid-stingwings.eq.aggression-stimulant';

export const AB_COMMUNION_HELM = 'vespid-stingwings.strain-leader.communion-helm';
export const AB_COMMUNE = 'vespid-stingwings.strain-leader.commune';
export const AB_EVASIVE_DRONE = 'vespid-stingwings.oversight-drone.evasive-drone';
export const AB_NEUTRON_FRAGMENT = 'vespid-stingwings.longsting.neutron-fragment';
export const AB_GHOST_RIG = 'vespid-stingwings.shadestrain.ghost-rig';
export const AB_CAMOUFLAGED = 'vespid-stingwings.shadestrain.camouflaged';
export const AB_NEUTRON_BOMBARDMENT = 'vespid-stingwings.skyblast.neutron-bombardment';
export const AB_NEUTRON_FALLOUT = 'vespid-stingwings.skyblast.neutron-fallout';
export const AB_SKYTORCH = 'vespid-stingwings.swarmguard.skytorch';
export const AB_WARRIOR_INSTINCTS = 'vespid-stingwings.warrior.warrior-instincts';

export const ACT_AERIAL_GUIDANCE = 'vespid-stingwings.oversight-drone.act.aerial-guidance';
export const ACT_SKYTORCH_ASSAULT = 'vespid-stingwings.swarmguard.act.skytorch-assault';

/** The four FLY siblings (D-021): each `treatedAs` the universal move action it replaces. */
export const FLY_REPOSITION = 'Reposition (Vespid FLY)';
export const FLY_DASH = 'Dash (Vespid FLY)';
export const FLY_FALL_BACK = 'Fall Back (Vespid FLY)';
export const FLY_CHARGE = 'Charge (Vespid FLY)';

/** Effects and per-player scratch space (never module-level state — architecture rule 7). */
const COMMUNION = 'vespid-stingwings.communion';
const HELM_USED = 'vespid-stingwings.helmUsed';
const COMMUNE_PLOY = 'vespid-stingwings.communePloy';
const SEQ_SPEND = 'vespid-stingwings.seqSpend';
const SKYTORCH_ARMED = 'vespid-stingwings.skytorchArmed';
const CONVERGENCE_USED = 'vespid-stingwings.convergenceUsed';

/** "…it can FLY" — recorded so OCELLI, AIRBORNE PREDATORS and Neutron Charge can read it. */
const FLEW = 'vespid-stingwings.flew';
/** Neutron Charge: "…until the end of the turning point". */
const CHARGED = 'vespid-stingwings.neutronCharged';
export const NEUTRON_FRAGMENT_TOKEN = 'vespid-stingwings.neutronFragment';
const OCELLI_EFFECT = 'vespid-stingwings.ocelli';
const DARTING_BONUS = 'vespid-stingwings.dartingFlight';
const DARTING_LOCK = 'vespid-stingwings.dartingLock';
const OVERLOAD_ARMED = 'vespid-stingwings.neutronOverload';
const VENOM_ARMED = 'vespid-stingwings.viciousVenom';
/** SKYTORCH ASSAULT's torch zone, kept for the UI (the Murderwing BOOST ZONE shape). */
export const TORCH_ZONE = 'vespid-stingwings.torchZone';

export const FALLOUT_MARKER = (player: PlayerId, n: number): string => `vespid-stingwings.fallout.${player}.${n}`;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const MOVE_KEYS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/** "Neutron weapons are any weapons that have the word 'neutron' in their name." */
export const isNeutronWeapon = (name: string): boolean => /neutron/i.test(name);
const isClaws = (name: string): boolean => name.trim().toLowerCase() === 'claws';

const isDrone = (op: OperativeState): boolean => op.datacardId === OVERSIGHT_DRONE;

function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

const engagedNow = (T: TeamHooks, state: GameState, op: OperativeState): boolean =>
  aliveOperatives(state, otherPlayer(op.player)).some((e) => inCR(T, state, op, e));

/** Only true while this operative is the one activating — "during its activation". */
const activeNow = (state: GameState, op: OperativeState): boolean => state.activeOperativeId === op.id;

const movedThisActivation = (op: OperativeState): boolean =>
  op.actionsThisActivation.some((a) => MOVE_KEYS.includes(a));

const flewThisActivation = (state: GameState, op: OperativeState): boolean =>
  Boolean(effectOn(state, op.id, FLEW));

/** "…moves or uses FLY … until the end of the turning point." */
const chargedThisTP = (state: GameState, op: OperativeState): boolean =>
  Boolean(effectOn(state, op.id, CHARGED)) || (activeNow(state, op) && movedThisActivation(op));

// ---------------------------------------------------------------------------
// Communion — the point pool every other rule reads
// ---------------------------------------------------------------------------

interface Pool {
  points: number;
}

function pool(state: GameState, player: PlayerId): Pool {
  const b = bucket(state, COMMUNION) as Record<string, Pool>;
  b[player] = b[player] ?? { points: 0 };
  return b[player]!;
}

export const communionPoints = (state: GameState, player: PlayerId): number => pool(state, player).points;

export function setCommunionPoints(state: GameState, player: PlayerId, n: number): void {
  pool(state, player).points = Math.max(0, n);
}

/**
 * "Whenever you would perform the Pick Up Marker or a mission action (excluding Operate Hatch)
 * with a friendly VESPID STINGWING operative, you must also spend 1 of your Communion points."
 *
 * Nothing runs at the end of an ACTION, so the point cannot be taken out of the pool at the moment
 * the action resolves. Instead the qualifying actions an operative has already performed this
 * activation are PLEDGED against the pool — every reader subtracts them, so the arithmetic every
 * other Communion clause sees is exact — and the pledge is settled at `onActivationEnd`.
 */
const isCommunionTolled = (action: string): boolean =>
  action === 'Pick Up Marker' || (getAction(action)?.type === 'mission' && action !== 'Operate Hatch');

function tolledSoFar(state: GameState, player: PlayerId): number {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!active || active.player !== player) return 0;
  return active.actionsThisActivation.filter(isCommunionTolled).length;
}

/**
 * Tolls that need no point from the pool: CONVERGENCE STIMULANT's once-per-turning-point use, and
 * the STRAIN LEADER's Communion Helm while it has not already been spent this activation.
 */
const tollWaivers = (state: GameState, player: PlayerId): number =>
  (convergenceAvailable(state, player) ? 1 : 0) + (helmFreeSpend(state, player) ? 1 : 0);

function pledged(state: GameState, player: PlayerId): number {
  return Math.max(0, tolledSoFar(state, player) - tollWaivers(state, player));
}

const nextTollIsFree = (state: GameState, player: PlayerId): boolean =>
  tolledSoFar(state, player) < tollWaivers(state, player);

/** Communion points that are not already promised to an action performed this activation. */
export const availableCommunion = (state: GameState, player: PlayerId): number =>
  Math.max(0, pool(state, player).points - pledged(state, player));

/**
 * CONVERGENCE STIMULANT: "Once per turning point, a friendly VESPID STINGWING operative can
 * perform the Pick Up Marker or a mission action without you spending a Communion point."
 */
function convergenceAvailable(state: GameState, player: PlayerId): boolean {
  if (!hasEquipment(state, player, EQ_CONVERGENCE)) return false;
  return bucket(state, CONVERGENCE_USED)[player] !== `${state.turningPoint}`;
}

/** "Once during each of this operative's activations, you can spend 1 Communion point for free." */
function helmFreeSpend(state: GameState, player: PlayerId): OperativeState | undefined {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!active || active.player !== player || active.datacardId !== STRAIN_LEADER) return undefined;
  const stamp = `${state.turningPoint}:${state.activationsThisTP}:${active.id}`;
  return bucket(state, HELM_USED)[player] === stamp ? undefined : active;
}

/** The per-sequence ledger Warrior Instincts reads ("if you don't spend Communion points"). */
function sequenceStamp(state: GameState): string {
  const seq = state.sequence;
  if (!seq) return 'none';
  const target = seq.kind === 'shoot' ? seq.targetId : seq.defenderId;
  return `${seq.kind}:${seq.attackerId}:${target}`;
}

export function communionSpentThisSequence(state: GameState, player: PlayerId): boolean {
  const b = bucket(state, SEQ_SPEND) as Record<string, string | undefined>;
  return b[player] === sequenceStamp(state) && sequenceStamp(state) !== 'none';
}

/**
 * Can a Communion point be spent right now? The STRAIN LEADER's Communion Helm pays for one spend
 * during each of its activations, so an empty pool is not always a refusal.
 */
export const canSpendCommunion = (state: GameState, player: PlayerId): boolean =>
  availableCommunion(state, player) > 0 || helmFreeSpend(state, player) !== undefined;

/** Spend one Communion point. Returns false when the pool cannot pay. */
function spendCommunion(state: GameState, player: PlayerId, note: string, stamp?: string): boolean {
  const helm = helmFreeSpend(state, player);
  if (helm) {
    bucket(state, HELM_USED)[player] = `${state.turningPoint}:${state.activationsThisTP}:${helm.id}`;
    log(state, { kind: 'system', player, text: `Communion Helm: ${note} (1 Communion point spent for free)` });
  } else {
    if (availableCommunion(state, player) <= 0) return false;
    pool(state, player).points -= 1;
    log(state, {
      kind: 'system',
      player,
      text: `Communion: ${note} (1 point spent, ${pool(state, player).points} left)`,
    });
  }
  (bucket(state, SEQ_SPEND) as Record<string, string>)[player] = stamp ?? sequenceStamp(state);
  return true;
}

/**
 * "…it can only target the closest enemy operative within 8" of it (excluding enemy operatives
 * within control range of other friendly VESPID STINGWING operatives)". Undefined when there is
 * no such operative, in which case the rule places no restriction at all.
 */
export function communionTarget(
  T: TeamHooks,
  state: GameState,
  shooter: OperativeState,
): OperativeState | undefined {
  const friends = T.friendlies(state, KW).filter((f) => f.id !== shooter.id);
  return aliveOperatives(state, otherPlayer(shooter.player))
    .filter((e) => T.gap(shooter, e) <= 8 + EPS)
    .filter((e) => !friends.some((f) => inCR(T, state, f, e)))
    .sort((a, b) => T.gap(shooter, a) - T.gap(shooter, b) || (byId(a, b) as number))[0];
}

/**
 * "…it must end the action within control range of the closest enemy operative it can." The set of
 * enemies it CAN reach is approximated as those within the operative's FLY allowance plus a control
 * range, which is the same measurement the set-up test uses.
 */
export function communionChargeTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  reach: number,
): OperativeState | undefined {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return undefined;
  const friends = aliveOperatives(state, op.player).filter((f) => f.id !== op.id);
  const gap = (e: OperativeState): number => {
    const ec = ctx.datacards.get(e.datacardId);
    return ec ? dist(op.pos, e.pos) - baseRadius(c.base) - baseRadius(ec.base) : Infinity;
  };
  return aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => gap(e) <= reach + 1 + EPS)
    .filter((e) => !friends.some((f) => inControlRange(ctx, state, f, e)))
    .sort((a, b) => gap(a) - gap(b) || (byId(a, b) as number))[0];
}

// ---------------------------------------------------------------------------
// FLY — the remove-and-set-up-again move (D-021)
// ---------------------------------------------------------------------------

type FlyMode = 'Reposition' | 'Dash' | 'Fall Back' | 'Charge';

/** Can this operative legally be set up here? */
function placeable(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
): { ok: boolean; reason?: string; z?: number } {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const r = baseRadius(c.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, c.base, op.rot))
    return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, modelHeight(c)))
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (dist(pos, other.pos) - r - baseRadius(oc.base) < -1e-4)
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true, z };
}

/** The distance an operative may be set up wholly within when it FLIES. */
export function flyAllowance(ctx: GameContext, state: GameState, op: OperativeState, mode: FlyMode): number {
  // "…wholly within a distance equal to its Move stat (or 3" if it was a Dash)… Note that it
  //  gains no additional distance when performing the Charge action."
  let max = mode === 'Dash' ? 3 : moveOf(ctx, state, op);
  // ACCELERANT STIMULANT: "…performs the Charge or Dash action, it can move an additional 1".
  //  If it uses FLY for this action, you can set it back up 1" further away."
  if (
    (mode === 'Charge' || mode === 'Dash') &&
    op.datacardId !== OVERSIGHT_DRONE &&
    hasEquipment(state, op.player, EQ_ACCELERANT)
  )
    max += 1;
  // DARTING FLIGHT: "…it can move an additional D3", or be set up an additional D3" away if it
  //  uses FLY."
  const darting = mode === 'Reposition' ? effectOn(state, op.id, DARTING_BONUS) : undefined;
  if (darting) max += Number(darting.data?.['inches'] ?? 0);
  return max;
}

/**
 * "…remove it from the killzone and set it back up wholly within a distance equal to its Move stat
 * horizontally of its original location (in a killzone that uses the close quarters rules … this
 * distance cannot be measured over or through Wall terrain, and that operative cannot be set up on
 * the other side of an access point…). It must be set up in a location it can be placed, and unless
 * it's the Charge action, it cannot be set up within control range of an enemy operative."
 */
export function flyDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2 | undefined,
  mode: FlyMode,
  maxOverride?: number,
): { ok: boolean; reason?: string; pos?: Vec2; z?: number } {
  if (!pos) return { ok: false, reason: 'select a location to be set up in' };
  if (dist(op.pos, pos) < 0.01) return { ok: false, reason: 'select a different location to be set up in' };
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const max = maxOverride ?? flyAllowance(ctx, state, op, mode);
  const travelled = state.map.closeQuarters ? wallRouteDistance(index, op.pos, pos) : dist(op.pos, pos);
  if (travelled + baseRadius(c.base) > max + EPS)
    return { ok: false, reason: `it can only FLY wholly within ${max}"` };
  if (
    state.map.closeQuarters &&
    index.parts.some((p) => p.role === 'accessPoint' && segmentCrossesPoly(op.pos, pos, p.poly))
  )
    return { ok: false, reason: 'it cannot FLY through an open hatchway' };
  const spot = placeable(ctx, state, op, pos);
  if (!spot.ok) return { ok: false, reason: spot.reason ?? 'it must be set up in a location it can be placed' };
  const landed: Body = { id: op.id, pos, z: spot.z ?? 0, rot: op.rot, base: c.base, height: modelHeight(c) };
  const engagedThere = aliveOperatives(state, otherPlayer(op.player)).filter((e) =>
    withinControlRange(index, landed, body(ctx, e)),
  );
  if (mode === 'Charge' && engagedThere.length === 0)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };
  if (mode !== 'Charge' && engagedThere.length > 0)
    return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
  return { ok: true, pos, z: spot.z ?? 0 };
}

/** Remove and set up again, moving anything it carries with it. */
function doFly(ctx: GameContext, state: GameState, op: OperativeState, to: Vec2, z: number, label: string): void {
  effect(state, {
    rule: FLEW,
    source: { kind: 'ability', id: RULE_FLY },
    sourceText: text(RULE_FLY),
    operativeId: op.id,
    player: op.player,
    data: { from: { ...op.pos }, to: { ...to } },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  op.pos = { ...to };
  op.z = z;
  op.onGuard = false;
  if (op.carryingMarkerId) {
    const m = state.markers[op.carryingMarkerId];
    if (m) {
      m.pos = { ...op.pos };
      m.z = op.z;
    }
  }
  log(state, { kind: 'action', player: op.player, text: `${op.letter} FLIES (${label})`, data: { operativeId: op.id } });
}

function flyAction(id: string, name: string, mode: FlyMode, ap: number): ActionDef {
  return {
    id,
    name,
    ap,
    type: 'unique',
    treatedAs: mode,
    sourceText: text(RULE_FLY),
    available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
    check(ctx, state, op, params) {
      const engaged = aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e));
      const did = (a: string): boolean => op.actionsThisActivation.includes(a);
      if (mode === 'Reposition') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Fall Back') || did('Charge'))
          return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      } else if (mode === 'Dash') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Charge')) return { ok: false, reason: 'already performed Charge this activation' };
      } else if (mode === 'Fall Back') {
        if (!engaged) return { ok: false, reason: 'no enemy operative within control range' };
        if (did('Reposition') || did('Charge'))
          return { ok: false, reason: 'already performed Reposition or Charge this activation' };
      } else {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (engaged) return { ok: false, reason: 'already within control range of an enemy operative' };
        if (did('Reposition') || did('Dash') || did('Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      const d = flyDestination(ctx, state, op, params.targetPos, mode);
      if (!d.ok) return { ok: false, reason: d.reason ?? 'it cannot FLY there' };
      if (mode === 'Charge') {
        const toll = communionChargeToll(ctx, state, op, d.pos!);
        if (toll.needsPoint && !canSpendCommunion(state, op.player)) return { ok: false, reason: toll.reason! };
      }
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      const d = flyDestination(ctx, state, op, params.targetPos, mode);
      if (!d.ok || !d.pos) return { ok: false, reason: d.reason ?? 'it cannot FLY there' };
      if (mode === 'Charge') {
        const toll = communionChargeToll(ctx, state, op, d.pos);
        if (toll.needsPoint && !spendCommunion(state, op.player, `${op.letter} charges ${toll.other}`))
          return { ok: false, reason: toll.reason! };
      }
      doFly(ctx, state, op, d.pos, d.z ?? 0, name);
      if (mode === 'Charge') {
        op.stickyEngagedWith = aliveOperatives(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
      }
      return { ok: true };
    },
  };
}

/**
 * "Whenever a friendly VESPID STINGWING operative (excluding DRONE) performs the Charge action, it
 * must end the action within control range of the closest enemy operative it can unless you spend
 * 1 of your Communion points."
 *
 * Only reachable for the FLY Charge, whose destination this module owns. The universal Charge
 * carries its path inside `ActionParams` and no hook is shown it (see REMINDER_ONLY).
 */
function communionChargeToll(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  landing: Vec2,
): { needsPoint: boolean; reason?: string; other?: string } {
  if (op.datacardId === OVERSIGHT_DRONE) return { needsPoint: false };
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { needsPoint: false };
  const required = communionChargeTarget(ctx, state, op, flyAllowance(ctx, state, op, 'Charge'));
  if (!required) return { needsPoint: false };
  const index = terrain(ctx, state);
  const landed: Body = { id: op.id, pos: landing, z: surfaceAt(index, landing), rot: op.rot, base: c.base, height: modelHeight(c) };
  if (withinControlRange(index, landed, body(ctx, required))) return { needsPoint: false };
  return {
    needsPoint: true,
    other: required.letter,
    reason: `Communion: it must end the Charge within control range of ${required.letter} unless you spend a Communion point`,
  };
}

// ---------------------------------------------------------------------------
// SKYTORCH ASSAULT — the torch zone
// ---------------------------------------------------------------------------

/** The `skytorch` profile of the SWARMGUARD's flamer, read off the datacard. */
function skytorchProfile(ctx: GameContext, state: GameState, op: OperativeState) {
  for (const w of weaponsOf(ctx, state, op, 'ranged')) {
    const profile = w.profiles.find((p) => p.rules.some((r) => r.id === 'Skytorch'));
    if (profile) return { weapon: w, profile };
  }
  return undefined;
}

/**
 * "The torch zone is the horizontal area between the operative's current and previous location. A
 * 28mm round Skytorch marker can be temporarily placed underneath this operative before it moves to
 * help determine this." — the swept area of its own base (the Murderwing BOOST ZONE measurement).
 * "…excluding operatives wholly underneath Vantage terrain."
 */
export function torchZoneVictims(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  from: Vec2,
  to: Vec2,
): OperativeState[] {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return [];
  const index = terrain(ctx, state);
  const swept = baseRadius(c.base);
  return aliveOperatives(state)
    .filter((o) => o.id !== op.id)
    .filter((o) => {
      const oc = ctx.datacards.get(o.datacardId);
      if (!oc) return false;
      if (distancePointToSegment(o.pos, from, to) > swept + baseRadius(oc.base) + EPS) return false;
      const overhead = index.parts
        .filter((p) => hasType(p, 'Vantage') && p.z0 > o.z + 0.05)
        .map((p) => p.poly);
      return !(overhead.length > 0 && baseWhollyWithin(o.pos, oc.base, o.rot, overhead));
    })
    // "Roll each sequence separately in order of furthest operative to closest."
    .sort((a, b) => dist(to, b.pos) - dist(to, a.pos) || (byId(a, b) as number));
}

/**
 * The destination of the SKYTORCH ASSAULT's free Reposition. The UI supplies one; when it does not
 * (the AI only ever offers `targetPos = op.pos`) a deterministic, logged default is used — a
 * straight line toward the closest enemy operative, at the longest legal distance (D-016).
 */
export function skytorchDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  requested: Vec2 | undefined,
): { ok: boolean; reason?: string; pos?: Vec2; z?: number; max: number } {
  // "During that action, it must FLY and can move an additional 2"."
  const max = flyAllowance(ctx, state, op, 'Reposition') + 2;
  if (requested && dist(op.pos, requested) >= 0.01) {
    return { ...flyDestination(ctx, state, op, requested, 'Reposition', max), max };
  }
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard', max };
  const foe = aliveOperatives(state, otherPlayer(op.player))
    .slice()
    .sort((a, b) => dist(op.pos, a.pos) - dist(op.pos, b.pos) || (byId(a, b) as number))[0];
  if (!foe) return { ok: false, reason: 'no enemy operative to sweep towards', max };
  const dir = norm(sub(foe.pos, op.pos));
  const reach = max - baseRadius(c.base);
  for (let d = Math.floor(reach * 2) / 2; d >= 0.5; d -= 0.5) {
    const p = { x: op.pos.x + dir.x * d, y: op.pos.y + dir.y * d };
    const attempt = flyDestination(ctx, state, op, p, 'Reposition', max);
    if (attempt.ok) return { ...attempt, max };
  }
  return { ok: false, reason: 'there is nowhere it can FLY to', max };
}

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Communion
  // =========================================================================
  /*
   * "In the Ready step of each Strategy phase, you gain D3 Communion points, plus 1 if a friendly
   *  OVERSIGHT DRONE operative is in the killzone."
   *
   * NEUROSTIMULANT: "…when determining how many Communion points to gain, you can roll two D3 and
   *  select one D3 to use." Selecting the higher is strictly optimal, so it needs no policy.
   */
  reg.on('onReadyStep', T.bind(RULE_COMMUNION, 10), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const rolls = [T.ctx.rng.d3()];
    if (hasEquipment(ev.state, T.player, EQ_NEUROSTIMULANT)) rolls.push(T.ctx.rng.d3());
    recordRoll(ev.state, 'communion', rolls, T.player, rolls.length > 1 ? 'NEUROSTIMULANT: two D3' : 'Communion D3');
    const d3 = Math.max(...rolls);
    const drone = T.friendlies(ev.state).some((o) => o.datacardId === OVERSIGHT_DRONE);
    const gain = d3 + (drone ? 1 : 0);
    setCommunionPoints(ev.state, T.player, communionPoints(ev.state, T.player) + gain);
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Communion: +${gain} point${gain === 1 ? '' : 's'} (D3 ${d3}${drone ? ' +1 OVERSIGHT DRONE' : ''}) → ${communionPoints(ev.state, T.player)}`,
    });
  });

  /*
   * "Whenever a friendly VESPID STINGWING operative is performing the Shoot action, it can only
   *  target the closest enemy operative within 8" of it (excluding enemy operatives within control
   *  range of other friendly VESPID STINGWING operatives) unless you spend 1 of your Communion
   *  points. For weapons with the Blast and Torrent weapon rules, only the first target must be
   *  selected in this way."
   *
   * `onSelectWeapon` is the seam: it is emitted exactly once per shot for the PRIMARY target, from
   * the Shoot action's `check` as a dry run and again from `startShoot` (D-032). That makes the
   * Blast/Torrent carve-out hold by construction — a secondary target is never passed through it —
   * and lets the AI see the refusal before it commits an intent (D-026). A dry run never spends.
   */
  reg.on('onSelectWeapon', T.bind(RULE_COMMUNION, 12), (ev) => {
    const shooter = ev.ctx.attacker;
    const intended = ev.ctx.defender;
    if (!T.mineKw(shooter, KW) || !intended) return;
    if (isDrone(shooter)) return; // "OVERSIGHT DRONE operatives aren't affected by the following"
    if (bucket(ev.state, SKYTORCH_ARMED)[shooter.id]) return; // Skytorch: "don't select a valid target"
    const required = communionTarget(T, ev.state, shooter);
    if (!required || required.id === intended.id) return;
    if (!canSpendCommunion(ev.state, T.player)) {
      ev.allowed = false;
      ev.reason = `Communion: it can only target ${required.letter} unless you spend a Communion point`;
      return;
    }
    if (ev.dryRun) return;
    // `startShoot` emits this BEFORE `state.sequence` exists, so the sequence the spend belongs to
    // is named explicitly — Warrior Instincts reads exactly this ledger.
    spendCommunion(
      ev.state,
      T.player,
      `${shooter.letter} shoots ${intended.letter} instead of ${required.letter}`,
      `shoot:${shooter.id}:${intended.id}`,
    );
  });

  /*
   * "Whenever you would perform the Pick Up Marker or a mission action (excluding Operate Hatch)
   *  with a friendly VESPID STINGWING operative, you must also spend 1 of your Communion points to
   *  do so."
   */
  reg.on('canPerformAction', T.bind(RULE_COMMUNION, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || isDrone(ev.operative) || !isCommunionTolled(ev.action)) return;
    if (nextTollIsFree(ev.state, T.player) || availableCommunion(ev.state, T.player) > 0) return;
    ev.allowed = false;
    ev.reason = 'Communion: you have no Communion point to spend on that action';
  });

  // Settle the pledge (see `pledged`): the points leave the pool at the end of the activation.
  reg.on('onActivationEnd', T.bind(RULE_COMMUNION, 12), (ev) => {
    if (ev.operative.player !== T.player || isDrone(ev.operative)) return;
    let owed = ev.operative.actionsThisActivation.filter(isCommunionTolled).length;
    if (owed === 0) return;
    if (convergenceAvailable(ev.state, T.player)) {
      bucket(ev.state, CONVERGENCE_USED)[T.player] = `${ev.state.turningPoint}`;
      owed -= 1;
      log(ev.state, {
        kind: 'system',
        player: T.player,
        text: `CONVERGENCE STIMULANT: ${ev.operative.letter} performs a Pick Up Marker / mission action for no Communion point`,
      });
    }
    // `onActivationEnd` fires before the reducer clears `activeOperativeId`, so the STRAIN LEADER's
    // Communion Helm can still pay for one of these — if it was not already spent on a shot.
    const helm = helmFreeSpend(ev.state, T.player);
    if (owed > 0 && helm) {
      bucket(ev.state, HELM_USED)[T.player] = `${ev.state.turningPoint}:${ev.state.activationsThisTP}:${helm.id}`;
      owed -= 1;
      log(ev.state, { kind: 'system', player: T.player, text: `Communion Helm: ${helm.letter} spends 1 point for free` });
    }
    if (owed <= 0) return;
    setCommunionPoints(ev.state, T.player, communionPoints(ev.state, T.player) - owed);
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Communion: ${owed} point${owed === 1 ? '' : 's'} spent on ${ev.operative.letter}'s marker/mission actions → ${communionPoints(ev.state, T.player)}`,
    });
  });

  /*
   * "Whenever a friendly VESPID STINGWING operative is shooting, you can spend 1 (and only 1) of
   *  your Communion points to re-roll one of your attack dice."
   *
   * A `RerollGrant` can only be priced in CP, so the re-roll is taken inside the hook (the
   * Warpcoven RAVAGE DESTINY / Mandrakes Omen shape) on this stated D-022 policy: spend once per
   * shooting sequence, on the lowest failed attack dice, but NEVER for a WARRIOR's neutron blaster
   * — Warrior Instincts pays that operative Accurate 1 for not spending, and the Accurate has
   * already been applied by the time this window opens.
   */
  reg.on('onRollAttack', T.bind(RULE_COMMUNION, 14), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.ctx) return;
    const shooter = ev.ctx.attacker;
    if (!T.mineKw(shooter, KW) || isDrone(shooter)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attacker !== T.player) return;
    if (shooter.datacardId === WARRIOR && isNeutronWeapon(ev.ctx.weaponName)) return;
    if (availableCommunion(ev.state, T.player) <= 0) return; // never burn the Helm's free spend here
    const fails = seq.attack.dice.filter((d) => d.rolled && d.state === 'fail');
    if (fails.length === 0) return;
    if (!useOncePerSequence(ev.state, `${RULE_COMMUNION}.reroll.${T.player}`)) return;
    if (!spendCommunion(ev.state, T.player, `${shooter.letter} re-rolls one attack dice`)) return;
    const worst = fails.slice().sort((a, b) => a.value - b.value || a.id - b.id)[0]!;
    const hit = hitOf(T.ctx, ev.state, shooter, ev.ctx.profile, seq.pointBlank ? -1 : 0);
    const lethal = lethalThreshold(ev.ctx.rules);
    const value = T.ctx.rng.d6();
    recordRoll(ev.state, 'reroll', [value], T.player, 'Communion');
    rerollDie(worst, value, hit, lethal !== undefined ? { lethal } : {});
    log(ev.state, { kind: 'dice', player: T.player, text: `Communion re-roll: ${worst.value} (${worst.state})` });
  });

  // =========================================================================
  // Neutron Charge
  // =========================================================================
  /*
   * "Whenever a friendly VESPID STINGWING operative moves or uses FLY, its neutron weapons have the
   *  Piercing 1 weapon rule until the end of the turning point."
   */
  reg.on('onWeaponRules', T.bind(RULE_NEUTRON_CHARGE, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !isNeutronWeapon(ev.weaponName)) return;
    if (!chargedThisTP(ev.state, ev.operative)) return;
    if (ev.rules.some((r) => r.id === 'Piercing')) return;
    ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (Neutron Charge)'));
  });

  // "…until the end of the turning point" outlives the activation it happened in.
  reg.on('onActivationEnd', T.bind(RULE_NEUTRON_CHARGE, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    if (!movedThisActivation(op) || effectOn(ev.state, op.id, CHARGED)) return;
    effect(ev.state, {
      rule: CHARGED,
      source: { kind: 'ability', id: RULE_NEUTRON_CHARGE },
      sourceText: text(RULE_NEUTRON_CHARGE),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  // =========================================================================
  // STRAIN LEADER
  // =========================================================================
  /*
   * Commune: "When selecting your operatives for the battle, also select one VESPID STINGWING
   *  strategy ploy. Whenever this operative is in the killzone and isn't within control range of
   *  enemy operatives, that ploy costs you 0CP."
   *
   * Select Operatives has no decision channel, so the ploy is chosen through the pure setter
   * `setCommunePloy` (D-017) and nothing applies until it is called. The reducer charges the CP
   * before any hook sees the ploy, so "costs you 0CP" is a refund.
   */
  reg.on('onPloyUsed', T.bindText(AB_COMMUNE, abilityText(STRAIN_LEADER, AB_COMMUNE), 12), (ev) => {
    if (ev.player !== T.player || ev.kind !== 'strategy') return;
    if (communePloy(ev.state, T.player) !== ev.ployId) return;
    const leader = T.friendlies(ev.state).find((o) => o.datacardId === STRAIN_LEADER);
    if (!leader || engagedNow(T, ev.state, leader)) return;
    const cost = DATA.strategyPloys.find((p) => p.id === ev.ployId)?.cp ?? 0;
    if (cost <= 0) return;
    ev.state.teams[T.player].cp += cost;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Commune: that ploy costs 0CP (${cost}CP refunded)` });
  });

  // =========================================================================
  // OVERSIGHT DRONE › Evasive Drone
  // =========================================================================
  const droneBind = (priority: number) => T.bindText(AB_EVASIVE_DRONE, abilityText(OVERSIGHT_DRONE, AB_EVASIVE_DRONE), priority);

  // "This operative cannot perform any actions other than Aerial Guidance, Charge, Dash, Fall Back,
  //  Fight and Reposition." (Its own FLY siblings ARE those actions — D-021's `treatedAs`.)
  const DRONE_ACTIONS = new Set([
    ACT_AERIAL_GUIDANCE,
    'Charge',
    'Dash',
    'Fall Back',
    'Fight',
    'Reposition',
    FLY_REPOSITION,
    FLY_DASH,
    FLY_FALL_BACK,
    FLY_CHARGE,
  ]);
  reg.on('canPerformAction', droneBind(12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== OVERSIGHT_DRONE) return;
    if (DRONE_ACTIONS.has(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'Evasive Drone: it can only perform Aerial Guidance, Charge, Dash, Fall Back, Fight and Reposition';
  });

  // "Whenever determining control of an objective marker, treat this operative's APL stat as 1
  //  lower. Note this isn't a change to its APL stat, so any changes are cumulative with this."
  reg.on('onMarkerControl', droneBind(12), (ev) => {
    const ctx = T.ctx;
    const marker = ev.state.markers[ev.markerId];
    if (!ctx || !marker || marker.kind !== 'objective') return;
    for (const drone of T.friendlies(ev.state).filter((o) => o.datacardId === OVERSIGHT_DRONE)) {
      if (!markerContestedBy(ctx, ev.state, marker, drone)) continue;
      ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - 1);
    }
  });

  /*
   * "Whenever this operative has a Conceal order and is in cover, it cannot be selected as a valid
   *  target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except being
   *  within 2"."
   *
   * `onValidTarget` is emitted before the core computes cover, so cover is recomputed here with the
   * DEFAULT options — which is what "taking precedence over Seek and Vantage" means (the Ratlings
   * SHIFTY precedent).
   */
  reg.on('onValidTarget', droneBind(25), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== OVERSIGHT_DRONE || target.order !== 'conceal') return;
    if (!T.ctx || T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    if (!coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, ev.attacker), body(T.ctx, target)).inCover) return;
    ev.valid = false;
    ev.reason = 'Evasive Drone: a concealed OVERSIGHT DRONE in cover cannot be selected';
  });

  // "Whenever an operative is shooting this operative, ignore the Piercing weapon rule." Bound at a
  // high priority so it also strips a Piercing granted by another rule (this team's Neutron Charge).
  reg.on('onWeaponRules', droneBind(45), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player === T.player) return;
    if (!ev.target || ev.target.player !== T.player || ev.target.datacardId !== OVERSIGHT_DRONE) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing');
  });

  /*
   * AERIAL GUIDANCE: "Until the start of this operative's next activation, whenever another
   *  friendly VESPID STINGWING operative within 6" of this operative is shooting an enemy operative
   *  visible to this operative, that friendly operative's ranged weapons have the Lethal 5+ and
   *  Saturate weapon rules. This has no effect while this operative is within control range of an
   *  enemy operative."
   */
  reg.on('onWeaponRules', T.bindText(ACT_AERIAL_GUIDANCE, actionText(OVERSIGHT_DRONE, ACT_AERIAL_GUIDANCE), 14), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !T.ctx) return;
    const shooter = ev.operative;
    if (shooter.datacardId === OVERSIGHT_DRONE) return; // "another friendly … operative"
    const drone = T.friendlies(ev.state).find(
      (o) => o.datacardId === OVERSIGHT_DRONE && effectOn(ev.state, o.id, ACT_AERIAL_GUIDANCE),
    );
    if (!drone || engagedNow(T, ev.state, drone)) return;
    if (T.gap(shooter, drone) > supportRange(T, ev.state, drone) + EPS) return;
    if (!ev.target || ev.target.player === T.player) return;
    if (!isVisible(terrain(T.ctx, ev.state), body(T.ctx, drone), body(T.ctx, ev.target)).visible) return;
    if (!ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5))
      ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (AERIAL GUIDANCE)'));
    if (!ev.rules.some((r) => r.id === 'Saturate')) ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (AERIAL GUIDANCE)'));
  });

  // "Until the start of this operative's next activation" — the engine has no such expiry, so the
  // effect is dropped at the start of that operative's next activation (the Hernkyn Intrepid shape).
  reg.on('onActivationStart', T.bindText(`${ACT_AERIAL_GUIDANCE}.expiry`, actionText(OVERSIGHT_DRONE, ACT_AERIAL_GUIDANCE), 5), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === ACT_AERIAL_GUIDANCE && e.operativeId === ev.operative.id);
  });

  // =========================================================================
  // LONGSTING › Neutron Fragment (rare weapon rule, printed as a datacard ability)
  // =========================================================================
  /*
   * "If the target of this weapon isn't incapacitated but you resolve any attack dice, the target
   *  gains one of your Neutron Fragment tokens. Whenever an operative that has one of your Neutron
   *  Fragment tokens is activated, inflict D3 damage on it for each Neutron Fragment token it has
   *  (roll separately for each)."
   */
  reg.on('onStrikeResolved', T.bindText(AB_NEUTRON_FRAGMENT, abilityText(LONGSTING, AB_NEUTRON_FRAGMENT), 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'NeutronFragment')) return;
    const victim = ev.struck;
    if (victim.incapacitated || victim.removed) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.attack.dice.some((d) => d.state === 'crit' || d.state === 'normal' || d.state === 'struck')) return;
    addFragment(ev.state, victim, T.player);
  });

  reg.on('onActivationStart', T.bindText(`${AB_NEUTRON_FRAGMENT}.tick`, abilityText(LONGSTING, AB_NEUTRON_FRAGMENT), 6), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    const tokens = fragmentTokens(ev.state, ev.operative.id, T.player);
    if (tokens === 0) return;
    for (let i = 0; i < tokens; i++) {
      const d3 = ctx.rng.d3();
      recordRoll(ev.state, 'neutronFragment', [d3], T.player, `${ev.operative.letter}`);
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Neutron Fragment: ${d3} damage to ${ev.operative.letter}`,
      });
      inflictDamage(ctx, ev.state, ev.operative, d3, 'other');
      if (ev.operative.incapacitated) break;
    }
  });

  // =========================================================================
  // SHADESTRAIN
  // =========================================================================
  /*
   * Ghost Rig: "While this operative has a Conceal order, your opponent cannot select it as a valid
   *  target unless it's within 6" of the operative trying to target it. Note that this rule has no
   *  effect if this operative isn't selected as the valid target, e.g. if it's a secondary target
   *  from the Blast weapon rule."
   *
   * Blast secondaries never re-run `checkTarget`, so that half of the note holds by construction.
   */
  reg.on('onValidTarget', T.bindText(AB_GHOST_RIG, abilityText(SHADESTRAIN, AB_GHOST_RIG), 24), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== SHADESTRAIN || target.order !== 'conceal') return;
    if (T.gap(ev.attacker, target) <= 6 + EPS) return;
    ev.valid = false;
    ev.reason = 'Ghost Rig: it cannot be selected unless it is within 6"';
  });

  /*
   * Camouflaged: "Whenever an operative is shooting this operative, ignore the Piercing weapon rule
   *  and all cover saves are retained as critical successes. This rule has no effect if this
   *  operative isn't selected as the valid target, e.g. if it's a secondary target from the Blast
   *  weapon rule."
   *
   * `onDefenceDice` is the one seam that carries `ctx.secondary`, so the printed carve-out is
   * exact here. The core computes the pool as `3 − Piercing` one line above the emit, so ignoring
   * Piercing is adding the difference back.
   */
  reg.on('onDefenceDice', T.bindText(AB_CAMOUFLAGED, abilityText(SHADESTRAIN, AB_CAMOUFLAGED), 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== SHADESTRAIN) return;
    if (ev.ctx.type !== 'ranged' || ev.ctx.secondary) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    const crits = countCrits(seq.attack);
    const back = piercingValue(ev.ctx.rules, crits) - piercingValue(ev.ctx.rules.filter((r) => r.id !== 'Piercing'), crits);
    if (back > 0) ev.count += back;
    ev.coverSaveAsCrit = true;
  });

  // =========================================================================
  // SKYBLAST
  // =========================================================================
  /*
   * Neutron Bombardment (rare weapon rule): "Place one of your Neutron Fallout markers within the
   *  primary target's control range." — the position is the primary target's own location, the
   *  deterministic default D-016 asks for.
   */
  reg.on('onStrikeResolved', T.bindText(AB_NEUTRON_BOMBARDMENT, abilityText(SKYBLAST, AB_NEUTRON_BOMBARDMENT), 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || ev.ctx.secondary) return;
    if (!ev.ctx.rules.some((r) => r.id === 'NeutronBombardment')) return;
    placeFallout(ev.state, T.player, ev.struck.pos, ev.struck.z);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Neutron Bombardment: a Neutron Fallout marker is placed within ${ev.struck.letter}'s control range`,
    });
  });

  /*
   * Neutron Fallout: "Once during each enemy operative's activation, as soon as it's within 2" of
   *  one of your Neutron Fallout markers, inflict D3 damage on that operative (multiple markers
   *  aren't cumulative)."
   *
   * There is no marker-trigger hook (`checkMines` is core-only inside `applyMove` and emits
   * nothing), so "as soon as it's within 2"" is tested at both ends of the enemy activation.
   */
  const falloutBind = T.bindText(AB_NEUTRON_FALLOUT, abilityText(SKYBLAST, AB_NEUTRON_FALLOUT), 12);
  const falloutTick = (state: GameState, op: OperativeState): void => {
    const ctx = T.ctx;
    if (!ctx || op.player === T.player || op.removed || op.incapacitated) return;
    const near = falloutMarkers(state, T.player).some((m) => T.markerGap(op, m) <= 2 + EPS);
    if (!near) return;
    const key = `${AB_NEUTRON_FALLOUT}.${T.player}.${op.id}`;
    const b = bucket(state, 'vespid-stingwings.falloutOnce');
    const stamp = `${state.turningPoint}:${state.activationsThisTP}`;
    if (b[key] === stamp) return;
    b[key] = stamp;
    const d3 = ctx.rng.d3();
    recordRoll(state, 'neutronFallout', [d3], T.player, op.letter);
    log(state, { kind: 'action', player: T.player, text: `Neutron Fallout: ${d3} damage to ${op.letter}` });
    inflictDamage(ctx, state, op, d3, 'other');
  };
  reg.on('onActivationStart', falloutBind, (ev) => falloutTick(ev.state, ev.operative));
  reg.on('onActivationEnd', falloutBind, (ev) => falloutTick(ev.state, ev.operative));

  // =========================================================================
  // SWARMGUARD › Skytorch (rare weapon rule)
  // =========================================================================
  /*
   * "An operative can only use this weapon during the Skytorch Assault action."
   *
   * A PROFILE-level restriction (the flamer's `standard` profile stays legal), which is exactly
   * what `onSelectWeapon` exists for (D-032). The dry run from the Shoot action's `check` sees the
   * same answer, so the AI never offers a shot the sequence would then refuse.
   */
  reg.on('onSelectWeapon', T.bindText(AB_SKYTORCH, abilityText(SWARMGUARD, AB_SKYTORCH), 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Skytorch')) return;
    if (bucket(ev.state, SKYTORCH_ARMED)[ev.ctx.attacker.id]) return;
    ev.allowed = false;
    ev.reason = 'Skytorch: this weapon can only be used during the Skytorch Assault action';
  });

  // =========================================================================
  // WARRIOR › Warrior Instincts
  // =========================================================================
  /*
   * "Whenever this operative is shooting, if you don't spend Communion points during that sequence,
   *  its neutron blaster has the Accurate 1 weapon rule until the end of that sequence."
   *
   * `onWeaponRules` is re-emitted on every read, so the grant simply disappears the moment a
   * Communion point is spent in that sequence.
   */
  reg.on('onWeaponRules', T.bindText(AB_WARRIOR_INSTINCTS, abilityText(WARRIOR, AB_WARRIOR_INSTINCTS), 12), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (ev.operative.datacardId !== WARRIOR) return;
    if (ev.weaponName.trim().toLowerCase() !== 'neutron blaster') return;
    if (communionSpentThisSequence(ev.state, T.player)) return;
    if (ev.rules.some((r) => r.id === 'Accurate')) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Warrior Instincts)'));
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- HARDENED EXOSKELETON (strategy) -----------------------------------
  /*
   * "Whenever a friendly VESPID STINGWING operative (excluding OVERSIGHT DRONE) is fighting or
   *  retaliating, Normal Dmg of 4 or more inflicts 1 less damage on it."
   *
   * A fight inflicts one attack dice at a time, so the striking profile is re-derived from
   * `state.sequence` (`onDamage` always carries `ctx: null`). A normal strike is identified by its
   * damage matching the weapon's Normal Dmg — which cannot be told from a critical when a weapon's
   * two Dmg stats are equal (the Death Korps Bruiser read).
   */
  reg.on('onDamage', T.bind(SP_HARDENED, 22), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_HARDENED) || ev.kind !== 'attack' || !T.ctx) return;
    const victim = ev.target;
    if (!T.mineKw(victim, KW) || victim.datacardId === OVERSIGHT_DRONE) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const striking = seq.turn;
    const strikerId = striking === 'attacker' ? seq.attackerId : seq.defenderId;
    const victimId = striking === 'attacker' ? seq.defenderId : seq.attackerId;
    if (strikerId === victim.id || victimId !== victim.id) return;
    const profile = fightProfile(T.ctx, ev.state, seq, striking);
    if (!profile || profile.dmgN < 4 || ev.amount !== profile.dmgN) return;
    ev.amount -= 1;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `HARDENED EXOSKELETON: Normal Dmg ${profile.dmgN} inflicts 1 less on ${victim.letter}`,
    });
  });

  // ---- AERIAL AGILITY (strategy) -----------------------------------------
  /*
   * "Whenever an operative is shooting a friendly VESPID STINGWING operative while counteracting,
   *  or during an activation in which that shooting operative moved or was set up, roll one D6
   *  whenever an attack dice would inflict Normal Dmg: on a 5+, ignore that inflicted damage. You
   *  cannot ignore more than one attack dice per Shoot action sequence this way."
   *
   * A shoot inflicts its unblocked dice as ONE aggregated total, so the D6 is rolled once per
   * sequence while any normal success is unblocked, and a 5+ removes exactly one Normal Dmg.
   */
  reg.on('onDamage', T.bind(SP_AERIAL_AGILITY, 22), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_AERIAL_AGILITY) || ev.kind !== 'attack' || !T.ctx) return;
    const victim = ev.target;
    if (!T.mineKw(victim, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== victim.id) return;
    const shooter = ev.state.operatives[seq.attackerId];
    if (!shooter || shooter.player === T.player) return;
    const counteracting = (ev.state.opState['counteract'] as Record<string, unknown> | undefined)?.['operativeId'] === shooter.id;
    if (!counteracting && !(activeNow(ev.state, shooter) && movedThisActivation(shooter))) return;
    if (seq.attack.dice.filter((d) => d.state === 'normal').length === 0) return;
    const profile = shootProfile(T.ctx, ev.state, seq);
    if (!profile || profile.dmgN <= 0) return;
    if (!useOncePerSequence(ev.state, `${SP_AERIAL_AGILITY}.${T.player}`)) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'aerialAgility', [roll], T.player, victim.letter);
    if (roll < 5) {
      log(ev.state, { kind: 'dice', player: T.player, text: `AERIAL AGILITY: rolled ${roll} — the damage stands` });
      return;
    }
    ev.amount = Math.max(0, ev.amount - profile.dmgN);
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `AERIAL AGILITY: rolled ${roll} — one attack dice's ${profile.dmgN} damage is ignored`,
    });
  });

  // ---- AIRBORNE PREDATORS (strategy) -------------------------------------
  // "Whenever a friendly VESPID STINGWING operative moves or uses FLY during its activation, its
  //  weapons have the Balanced weapon rule until the end of that activation."
  reg.on('onWeaponRules', T.bind(SP_AIRBORNE_PREDATORS, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_AIRBORNE_PREDATORS) || !T.mineKw(ev.operative, KW)) return;
    if (!activeNow(ev.state, ev.operative) || !movedThisActivation(ev.operative)) return;
    if (ev.rules.some((r) => r.id === 'Balanced')) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (AIRBORNE PREDATORS)'));
  });

  // ---- STING (strategy) ---------------------------------------------------
  // "Improve the Hit stat of friendly VESPID STINGWING operatives' claws by 1, and those weapons
  //  have the Lethal 5+ and Shock weapon rules."
  reg.on('onWeaponRules', T.bind(SP_STING, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_STING) || !T.mineKw(ev.operative, KW)) return;
    if (!isClaws(ev.weaponName)) return;
    if (!ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (STING)'));
    if (!ev.rules.some((r) => r.id === 'Shock')) ev.rules.push(ruleTag('Shock', undefined, 'Shock (STING)'));
  });
  // `StatMods.hit` from `onCollectAttackDice` is dead, so the Hit change goes through `onStatMod`,
  // which `hitOf` consults. `onStatMod` carries no weapon, so the sequence's own weapon is read.
  reg.on('onStatMod', T.bind(SP_STING, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_STING) || !T.mineKw(ev.operative, KW)) return;
    const name = fightWeaponName(ev.state, ev.operative);
    if (!name || !isClaws(name)) return;
    ev.mods.hit += 1;
  });

  // ---- OCELLI (firefight) -------------------------------------------------
  /*
   * "Use this firefight ploy when a friendly VESPID STINGWING operative performs the Shoot action
   *  during an activation in which it's used FLY. Until the end of that action, it gains all
   *  benefits from the first and second main features of Vantage terrain. When determining the
   *  height difference between operatives for Vantage terrain rules, treat that friendly operative
   *  as being 3" higher than it currently is (but not when determining the distance for Communion)."
   *
   * The Core Book's Vantage entry is not in this repo, so "the first and second main features"
   * cannot be resolved from a printed source. The two granted here are the two the engine can
   * express exactly: Light terrain cannot give the target cover (which is also what makes a
   * Conceal-order target in Light cover selectable), and Accurate 1/2. The third Vantage feature —
   * "ignore Heavy terrain connected to Vantage terrain" for obscured — is deliberately NOT granted,
   * because `onValidTarget` cannot scope an obscured-ignore to connected parts and clearing
   * `seq.obscured` outright would over-deliver. Reported for owner confirmation.
   *
   * "Until the end of that ACTION" is bounded to the activation (the Blades of Khaine treatment):
   * the reducer pushes the action's restriction key only after the sequence has fully resolved.
   */
  reg.on('onPloyUsed', T.bind(FP_OCELLI, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_OCELLI) return;
    const candidates = T.friendlies(ev.state, KW).filter((o) => activeNow(ev.state, o) && flewThisActivation(ev.state, o));
    const chosen = chosenOperative(ev.state, ev.data, candidates);
    if (!chosen) return;
    effect(ev.state, {
      rule: OCELLI_EFFECT,
      source: { kind: 'ploy', id: FP_OCELLI },
      sourceText: text(FP_OCELLI),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: chosen.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `OCELLI: ${chosen.letter} is treated as 3" higher` });
  });

  reg.on('onValidTarget', T.bind(FP_OCELLI, 22), (ev) => {
    if (ev.attacker.player !== T.player || !effectOn(ev.state, ev.attacker.id, OCELLI_EFFECT)) return;
    if (ocelliDrop(ev.attacker, ev.target) < 2 - EPS) return;
    if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
  });

  reg.on('onWeaponRules', T.bind(FP_OCELLI, 22), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player || !ev.target) return;
    if (!effectOn(ev.state, ev.operative.id, OCELLI_EFFECT)) return;
    // Vantage Accurate applies "shooting an operative that has an Engage order".
    if (ev.target.order !== 'engage') return;
    const drop = ocelliDrop(ev.operative, ev.target);
    const x = drop >= 4 - EPS ? 2 : drop >= 2 - EPS ? 1 : 0;
    if (x === 0 || ev.rules.some((r) => r.id === 'Accurate' && (r.x ?? 1) >= x)) return;
    ev.rules.push(ruleTag('Accurate', x, `Accurate ${x} (OCELLI)`));
  });

  // ---- DARTING FLIGHT (firefight) ----------------------------------------
  /*
   * "Use this firefight ploy when a friendly VESPID STINGWING operative performs the Reposition
   *  action. Until the end of that action, it can move an additional D3", or be set up an
   *  additional D3" away if it uses FLY. In either case, it cannot perform Shoot or Fight actions
   *  for the rest of the turning point."
   */
  reg.on('onPloyUsed', T.bind(FP_DARTING_FLIGHT, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_DARTING_FLIGHT || !T.ctx) return;
    const candidates = T.friendlies(ev.state, KW).filter((o) => activeNow(ev.state, o));
    const chosen = chosenOperative(ev.state, ev.data, candidates) ?? T.friendlies(ev.state, KW)[0];
    if (!chosen) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'dartingFlight', [d3], T.player, chosen.letter);
    effect(ev.state, {
      rule: DARTING_BONUS,
      source: { kind: 'ploy', id: FP_DARTING_FLIGHT },
      sourceText: text(FP_DARTING_FLIGHT),
      operativeId: chosen.id,
      player: T.player,
      data: { inches: d3 },
      expiry: { kind: 'endOfActivation', operativeId: chosen.id },
    });
    effect(ev.state, {
      rule: DARTING_LOCK,
      source: { kind: 'ploy', id: FP_DARTING_FLIGHT },
      sourceText: text(FP_DARTING_FLIGHT),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `DARTING FLIGHT: ${chosen.letter} may move an additional ${d3}"` });
  });

  reg.on('onMoveDistance', T.bind(FP_DARTING_FLIGHT, 22), (ev) => {
    if (ev.operative.player !== T.player || ev.action !== 'Reposition') return;
    const eff = effectOn(ev.state, ev.operative.id, DARTING_BONUS);
    if (!eff) return;
    ev.inches += Number(eff.data?.['inches'] ?? 0);
  });

  reg.on('canPerformAction', T.bind(FP_DARTING_FLIGHT, 22), (ev) => {
    if (ev.operative.player !== T.player || !effectOn(ev.state, ev.operative.id, DARTING_LOCK)) return;
    const key = getAction(ev.action)?.treatedAs ?? ev.action;
    if (key !== 'Shoot' && key !== 'Fight' && ev.action !== ACT_SKYTORCH_ASSAULT) return;
    ev.allowed = false;
    ev.reason = 'DARTING FLIGHT: it cannot perform Shoot or Fight actions for the rest of the turning point';
  });

  // ---- NEUTRON OVERLOAD (firefight) --------------------------------------
  /*
   * "Use this firefight ploy when you resolve a critical success for a friendly VESPID STINGWING
   *  operative that's shooting with a neutron weapon during an activation in which it's moved or
   *  used FLY. If the target is within 4" of it, inflict D3 additional damage."
   *
   * `resolveAttackDice` runs to completion inside `advanceShoot` and no ploy window opens there, so
   * the ploy is declared in advance and fires on its printed trigger (the Mandrakes SHADOW'S BITE /
   * Celestian GLORIOUS MARTYRDOM shape).
   */
  reg.on('onPloyUsed', T.bind(FP_NEUTRON_OVERLOAD, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_NEUTRON_OVERLOAD) return;
    effect(ev.state, {
      rule: OVERLOAD_ARMED,
      source: { kind: 'ploy', id: FP_NEUTRON_OVERLOAD },
      sourceText: text(FP_NEUTRON_OVERLOAD),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  reg.on('onStrikeResolved', T.bind(FP_NEUTRON_OVERLOAD, 24), (ev) => {
    const ctx = T.ctx;
    if (!ctx || !ev.crit || ev.ctx.type !== 'ranged') return;
    const shooter = ev.ctx.attacker;
    if (!T.mineKw(shooter, KW) || !isNeutronWeapon(ev.ctx.weaponName)) return;
    if (!ev.state.effects.some((e) => e.rule === OVERLOAD_ARMED && e.player === T.player)) return;
    if (!(activeNow(ev.state, shooter) && (movedThisActivation(shooter) || flewThisActivation(ev.state, shooter)))) return;
    if (T.gap(shooter, ev.struck) > 4 + EPS) return; // "If the target is within 4" of it"
    dropEffects(ev.state, (e) => e.rule === OVERLOAD_ARMED && e.player === T.player);
    const d3 = ctx.rng.d3();
    recordRoll(ev.state, 'neutronOverload', [d3], T.player, ev.struck.letter);
    log(ev.state, { kind: 'ploy', player: T.player, text: `NEUTRON OVERLOAD: ${d3} additional damage to ${ev.struck.letter}` });
    inflictDamage(ctx, ev.state, ev.struck, d3, 'other');
  });

  // ---- VICIOUS VENOM (firefight) -----------------------------------------
  /*
   * "Use this firefight ploy when a friendly VESPID STINGWING operative (excluding OVERSIGHT DRONE)
   *  is fighting and you strike with a critical success. Inflict D3 additional damage."
   *
   * `advanceFight` resolves a whole fight inside the Fight action, so this is declared in advance
   * too and fires on the printed trigger. "is fighting" is the operative that performed the Fight
   * action, so a retaliating strike does not trigger it.
   */
  reg.on('onPloyUsed', T.bind(FP_VICIOUS_VENOM, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_VICIOUS_VENOM) return;
    effect(ev.state, {
      rule: VENOM_ARMED,
      source: { kind: 'ploy', id: FP_VICIOUS_VENOM },
      sourceText: text(FP_VICIOUS_VENOM),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  reg.on('onStrikeResolved', T.bind(FP_VICIOUS_VENOM, 24), (ev) => {
    const ctx = T.ctx;
    if (!ctx || !ev.crit || ev.ctx.type !== 'melee') return;
    const striker = ev.ctx.attacker;
    if (!T.mineKw(striker, KW) || striker.datacardId === OVERSIGHT_DRONE) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== striker.id) return; // "is fighting", not retaliating
    if (!ev.state.effects.some((e) => e.rule === VENOM_ARMED && e.player === T.player)) return;
    dropEffects(ev.state, (e) => e.rule === VENOM_ARMED && e.player === T.player);
    const d3 = ctx.rng.d3();
    recordRoll(ev.state, 'viciousVenom', [d3], T.player, ev.struck.letter);
    log(ev.state, { kind: 'ploy', player: T.player, text: `VICIOUS VENOM: ${d3} additional damage to ${ev.struck.letter}` });
    inflictDamage(ctx, ev.state, ev.struck, d3, 'other');
  });
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // NEUROSTIMULANT and CONVERGENCE STIMULANT are read by the Communion economy above.

  // ACCELERANT STIMULANT: "Whenever a friendly VESPID STINGWING operative (excluding OVERSIGHT
  //  DRONE) performs the Charge or Dash action, it can move an additional 1". If it uses FLY for
  //  this action, you can set it back up 1" further away." (the FLY half is in `flyAllowance`).
  reg.on('onMoveDistance', T.bind(EQ_ACCELERANT, 30), (ev) => {
    if (ev.operative.player !== T.player || !T.kw(ev.operative, KW)) return;
    if (ev.operative.datacardId === OVERSIGHT_DRONE) return;
    if (!hasEquipment(ev.state, T.player, EQ_ACCELERANT)) return;
    if (ev.action !== 'Charge' && ev.action !== 'Dash') return;
    ev.inches += 1;
  });

  // AGGRESSION STIMULANT: "Whenever a friendly VESPID STINGWING operative (excluding OVERSIGHT
  //  DRONE) is fighting, its melee weapons have the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bind(EQ_AGGRESSION, 30), (ev) => {
    if (ev.type !== 'melee' || ev.retaliating) return; // "is fighting", not retaliating
    if (!T.mineKw(ev.operative, KW) || ev.operative.datacardId === OVERSIGHT_DRONE) return;
    if (!hasEquipment(ev.state, T.player, EQ_AGGRESSION)) return;
    if (ev.rules.some((r) => r.id === 'Ceaseless')) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (AGGRESSION STIMULANT)'));
  });
}

// ---------------------------------------------------------------------------
// Small readers the hooks share
// ---------------------------------------------------------------------------

const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

/** SUPPORT: 6" plus a Comms Device, through the shared `onSupportDistance` seam. */
function supportRange(T: TeamHooks, state: GameState, op: OperativeState): number {
  if (!T.ctx) return 6;
  return T.ctx.hooks.emit('onSupportDistance', state, { state, operative: op, inches: 6 }).inches;
}

/** OCELLI: "treat that friendly operative as being 3" higher than it currently is". */
const ocelliDrop = (shooter: OperativeState, target: OperativeState): number => shooter.z + 3 - target.z;

function fightWeaponName(state: GameState, op: OperativeState): string | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  if (seq.attackerId === op.id) return seq.attackerWeapon;
  if (seq.defenderId === op.id) return seq.defenderWeapon;
  return undefined;
}

function fightProfile(
  ctx: GameContext,
  state: GameState,
  seq: FightSequence,
  side: 'attacker' | 'defender',
): WeaponProfile | undefined {
  const op = side === 'attacker' ? state.operatives[seq.attackerId] : state.operatives[seq.defenderId];
  const name = side === 'attacker' ? seq.attackerWeapon : seq.defenderWeapon;
  const profileName = side === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
  if (!op || !name) return undefined;
  const w = weaponsOf(ctx, state, op, 'melee').find((x) => x.name === name);
  return w ? findProfile(w, profileName) : undefined;
}

function shootProfile(ctx: GameContext, state: GameState, seq: ShootSequence): WeaponProfile | undefined {
  const attacker = state.operatives[seq.attackerId];
  if (!attacker) return undefined;
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
  return w ? findProfile(w, seq.profileName) : undefined;
}

// ---------------------------------------------------------------------------
// Tokens and markers
// ---------------------------------------------------------------------------

/** Neutron Fragment tokens stack, so the count lives in the effect's `data` (the Grudge shape). */
export function fragmentTokens(state: GameState, operativeId: string, player: PlayerId): number {
  const e = state.effects.find(
    (x) => x.rule === NEUTRON_FRAGMENT_TOKEN && x.operativeId === operativeId && x.player === player,
  );
  return Number(e?.data?.['count'] ?? 0);
}

export function addFragment(state: GameState, victim: OperativeState, player: PlayerId): void {
  const existing = state.effects.find(
    (x) => x.rule === NEUTRON_FRAGMENT_TOKEN && x.operativeId === victim.id && x.player === player,
  );
  if (existing) existing.data = { ...(existing.data ?? {}), count: Number(existing.data?.['count'] ?? 0) + 1 };
  else
    effect(state, {
      rule: NEUTRON_FRAGMENT_TOKEN,
      source: { kind: 'ability', id: AB_NEUTRON_FRAGMENT },
      sourceText: abilityText(LONGSTING, AB_NEUTRON_FRAGMENT),
      operativeId: victim.id,
      player,
      data: { count: 1 },
      expiry: { kind: 'endOfBattle' },
    });
  log(state, {
    kind: 'action',
    player,
    text: `${victim.letter} gains a Neutron Fragment token (${fragmentTokens(state, victim.id, player)})`,
  });
}

export const falloutMarkers = (state: GameState, player: PlayerId) =>
  Object.values(state.markers).filter((m) => m.id.startsWith(`vespid-stingwings.fallout.${player}.`));

export function placeFallout(state: GameState, player: PlayerId, pos: Vec2, z: number): string {
  const n = falloutMarkers(state, player).length + 1;
  const id = FALLOUT_MARKER(player, n);
  state.markers[id] = { id, kind: 'generic', diameterMm: 20, pos: { ...pos }, z, owner: player, flags: {} };
  return id;
}

// ---------------------------------------------------------------------------
// Commune — the pure setter (D-017)
// ---------------------------------------------------------------------------

export const communePloy = (state: GameState, player: PlayerId): string | undefined =>
  bucket(state, COMMUNE_PLOY)[player] as string | undefined;

/**
 * "When selecting your operatives for the battle, also select one VESPID STINGWING strategy ploy."
 * Select Operatives has no decision channel, so this is a pure setter and nothing applies until it
 * is called (D-017 — the Angels of Death CHAPTER TACTICS precedent).
 */
export function setCommunePloy(state: GameState, player: PlayerId, ployId: string): void {
  if (!DATA.strategyPloys.some((p) => p.id === ployId))
    throw new Error(`'${ployId}' is not a VESPID STINGWING strategy ploy`);
  bucket(state, COMMUNE_PLOY)[player] = ployId;
  log(state, { kind: 'system', player, text: `Commune: ${DATA.strategyPloys.find((p) => p.id === ployId)!.name} costs 0CP` });
}

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

function actions(): ActionDef[] {
  return [
    flyAction(FLY_REPOSITION, 'Reposition (Vespid FLY)', 'Reposition', 1),
    flyAction(FLY_DASH, 'Dash (Vespid FLY)', 'Dash', 1),
    flyAction(FLY_FALL_BACK, 'Fall Back (Vespid FLY)', 'Fall Back', 2),
    flyAction(FLY_CHARGE, 'Charge (Vespid FLY)', 'Charge', 1),

    // ---- AERIAL GUIDANCE — OVERSIGHT DRONE -------------------------------
    uniqueAction(DATA, OVERSIGHT_DRONE, ACT_AERIAL_GUIDANCE, {
      check(ctx, state, op) {
        // "This operative cannot perform this action while within control range of an enemy operative."
        if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
          return { ok: false, reason: 'within control range of an enemy operative' };
        return { ok: true };
      },
      perform(_ctx, state, op) {
        effect(state, {
          rule: ACT_AERIAL_GUIDANCE,
          source: { kind: 'ability', id: ACT_AERIAL_GUIDANCE },
          sourceText: actionText(OVERSIGHT_DRONE, ACT_AERIAL_GUIDANCE),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter} performs AERIAL GUIDANCE` });
        return { ok: true };
      },
    }),

    // ---- SKYTORCH ASSAULT — SWARMGUARD -----------------------------------
    uniqueAction(DATA, SWARMGUARD, ACT_SKYTORCH_ASSAULT, {
      check(ctx, state, op, params) {
        // "This operative cannot perform this action while it has a Conceal order, or while within
        //  control range of an enemy operative."
        if (op.order === 'conceal') return { ok: false, reason: 'it has a Conceal order' };
        if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
          return { ok: false, reason: 'within control range of an enemy operative' };
        const did = (a: string): boolean => op.actionsThisActivation.includes(a);
        if (did('Reposition') || did('Fall Back') || did('Charge'))
          return { ok: false, reason: 'it has already performed a move action this activation' };
        if (did('Shoot')) return { ok: false, reason: 'it has already performed the Shoot action this activation' };
        if (!skytorchProfile(ctx, state, op)) return { ok: false, reason: 'it has no flamer (skytorch)' };
        const d = skytorchDestination(ctx, state, op, params.targetPos);
        return d.ok ? { ok: true } : { ok: false, reason: d.reason ?? 'it cannot FLY there' };
      },
      perform(ctx, state, op, params) {
        const found = skytorchProfile(ctx, state, op);
        if (!found) return { ok: false, reason: 'it has no flamer (skytorch)' };
        const d = skytorchDestination(ctx, state, op, params.targetPos);
        if (!d.ok || !d.pos) return { ok: false, reason: d.reason ?? 'it cannot FLY there' };
        const from = { ...op.pos };
        // "Perform a free Reposition action with this operative. During that action, it must FLY
        //  and can move an additional 2"."
        doFly(ctx, state, op, d.pos, d.z ?? 0, 'SKYTORCH ASSAULT');
        // Both free actions still count for action restrictions; the only channel by which one
        // action is seen as another is `actionsThisActivation` (the Exodite SPRINT precedent).
        op.actionsThisActivation.push('Reposition', 'Shoot');
        const victims = torchZoneVictims(ctx, state, op, from, d.pos);
        effect(state, {
          rule: TORCH_ZONE,
          source: { kind: 'ability', id: AB_SKYTORCH },
          sourceText: abilityText(SWARMGUARD, AB_SKYTORCH),
          operativeId: op.id,
          player: op.player,
          data: { from, to: { ...d.pos }, victims: victims.map((v) => v.id) },
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        const first = victims[0];
        if (!first) {
          log(state, { kind: 'action', player: op.player, text: `${op.letter} sweeps an empty torch zone` });
          return { ok: true };
        }
        // "…don't select a valid target. Instead, shoot against each operative within its torch
        //  zone…; they aren't in cover or obscured. Roll each sequence separately in order of
        //  furthest operative to closest." (the Sanctifiers' Wreathed shape)
        bucket(state, SKYTORCH_ARMED)[op.id] = true;
        const r = startShoot(ctx, state, op, found.weapon.name, found.profile.name, first.id, { pointBlank: true });
        if (!r.ok) {
          delete bucket(state, SKYTORCH_ARMED)[op.id];
          return { ok: true };
        }
        const seq = shootSeq(state);
        if (seq) {
          seq.queue = victims.slice(1).map((v) => v.id);
          seq.pointBlank = false; // the Skytorch prints no Hit penalty
          seq.inCover = false;
          seq.obscured = false;
          seq.coverChoiceMade = true;
        }
        advanceShoot(ctx, state);
        delete bucket(state, SKYTORCH_ARMED)[op.id];
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Clauses with no honest expression on the current hook surface
// ---------------------------------------------------------------------------

export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE_FLY}.inline`]:
    '"whenever a friendly operative performs an action in which it moves, it can FLY" cannot be offered INSIDE a universal move action: onMoveRules (which carries `teleport`) is declared but never emitted, so FLY is four sibling ActionDefs instead (D-021)',
  [`${RULE_COMMUNION}.charge`]:
    'the Charge end-position toll is enforced for Charge (FLY), whose destination this module owns; the universal Charge carries its path in ActionParams and no hook is shown it',
  [`${AB_EVASIVE_DRONE}.head`]:
    '"the round disc at the top of the miniature is its head" is a model-height statement; the head point comes from MODEL_HEIGHT_BY_BASE / Datacard.height and no seam changes it mid-battle',
  [`${FP_OCELLI}.obscured`]:
    'the Vantage "ignore Heavy terrain connected to Vantage terrain" feature cannot be scoped through onValidTarget, and clearing seq.obscured outright would over-deliver',
  [`${AB_GHOST_RIG}.secondary`]:
    'a Torrent secondary target re-runs checkTarget and onValidTarget carries no `secondary` flag, so Ghost Rig also filters those (the Blast half of the printed note holds by construction)',
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const vespidStingwings = defineTeam({
  id: 'vespid-stingwings',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "…when a friendly VESPID STINGWING operative performs the Shoot action during an activation
    //  in which it's used FLY."
    [FP_OCELLI]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && flewThisActivation(state, active)
        ? { ok: true }
        : { ok: false, reason: 'only during an activation in which a friendly operative has used FLY' };
    },
    // "…when a friendly VESPID STINGWING operative performs the Reposition action."
    [FP_DARTING_FLIGHT]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player) return { ok: false, reason: 'only during a friendly activation' };
      return active.actionsThisActivation.includes('Reposition') || active.apSpent < 2
        ? { ok: true }
        : { ok: false, reason: 'that operative can no longer perform the Reposition action' };
    },
    // "…when you resolve a critical success for a friendly VESPID STINGWING operative that's
    //  shooting with a neutron weapon during an activation in which it's moved or used FLY."
    [FP_NEUTRON_OVERLOAD]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'only during a friendly operative’s activation' };
      if (!movedThisActivation(active) && !flewThisActivation(state, active))
        return { ok: false, reason: 'that operative has not moved or used FLY this activation' };
      return { ok: true };
    },
    // "…when a friendly VESPID STINGWING operative (excluding OVERSIGHT DRONE) is fighting and you
    //  strike with a critical success."
    [FP_VICIOUS_VENOM]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && active.datacardId !== OVERSIGHT_DRONE
        ? { ok: true }
        : { ok: false, reason: 'only during a friendly VESPID STINGWING operative’s activation' };
    },
  },
  aiHints: {
    roles: {
      [STRAIN_LEADER]: 'leader',
      [OVERSIGHT_DRONE]: 'support',
      [LONGSTING]: 'sniper',
      [SHADESTRAIN]: 'scout',
      [SKYBLAST]: 'gunner',
      [SWARMGUARD]: 'gunner',
      [WARRIOR]: 'objective',
    },
    ployValue: {
      [SP_HARDENED]: 0.5,
      [SP_AERIAL_AGILITY]: 0.6,
      [SP_AIRBORNE_PREDATORS]: 0.7,
      [SP_STING]: 0.4,
      [FP_OCELLI]: 0.5,
      [FP_DARTING_FLIGHT]: 0.2,
      [FP_NEUTRON_OVERLOAD]: 0.6,
      [FP_VICIOUS_VENOM]: 0.4,
    },
    equipmentValue: {
      [EQ_NEUROSTIMULANT]: 0.6,
      [EQ_CONVERGENCE]: 0.4,
      [EQ_ACCELERANT]: 0.5,
      [EQ_AGGRESSION]: 0.4,
    },
  },
});

export default vespidStingwings;
