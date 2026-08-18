/**
 * MURDERWING — Chaos Space Marines. https://wahapedia.ru/kill-team3/kill-teams/murderwing/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/murderwing.json`, never retyped.
 *
 * The team is built around one idea the engine had no vocabulary for: the **BOOST**. The
 * printed Jump Pack rule folds it into the middle of a move action ("at the start of any
 * straight-line increment … it can do a BOOST for that increment"), and `validateMove` has
 * no per-increment seam — nor is `onMoveRules` ever emitted. So a BOOST is modelled the way
 * every other "a rule grants an action the universal one forbids" is modelled in this repo
 * (docs/DECISIONS.md D-021): three sibling `ActionDef`s — `Reposition (BOOST)`,
 * `Fall Back (BOOST)` and `Charge (BOOST)` — each `treatedAs` its universal action, so AP,
 * action restrictions and the Reposition/Dash/Fall Back exclusions are all shared with it.
 * The boosted distance is charged against the same move allowance the universal action would
 * have had, and the Charge variant does not get the printed +2".
 *
 * That in turn gives BOOST ZONE a real definition: the swept area between where the operative
 * used the BOOST and where it came down, recorded as an effect for the rest of the activation.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { successes } from '../../core/dice.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { moveBudget } from '../../core/movement.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  card,
  enemiesInControlRange,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  modelHeight,
  recordRoll,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, hasType, surfaceAt } from '../../core/terrain.ts';
import { isVisible } from '../../core/visibility.ts';
import { baseGap, baseGapToPoly, baseRadius, dist, distancePointToSegment, segmentCrossesPoly } from '../../core/geometry.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence } from '../../core/sequences/types.ts';
import type { Datacard, GameState, OperativeState, PlayerId, Vec2, WeaponProfile } from '../../core/types.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  bucket,
  catalogueCard,
  chosenOperative,
  currentApl,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  horizontal,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerSequence,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('murderwing');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

export const KW = 'MURDERWING';

// ---------------------------------------------------------------------------
// Effect / scratch keys
// ---------------------------------------------------------------------------

/** The BOOST ZONE of the BOOST this operative did during this activation. */
const BOOST = 'murderwing.boost';
/** "…or that did a BOOST during this turning point" (NIGHTMARE ON HIGH). */
const BOOSTED_TP = 'murderwing.boostedTP';
/** "Each operative cannot perform more than one BOOST action per activation/counteraction." */
const BOOST_ACTION_USED = 'murderwing.boostActionUsed';
/** The CHAMPION's Challenge token, held by an enemy operative. */
const CHALLENGE = 'murderwing.challenge';
/** RAPTOR › Thrill of Flight: "ignore any changes to its stats from being injured". */
const IGNORE_INJURED = 'murderwing.ignoreInjured';
/** WINGS OF DARKNESS: the +3" is armed by the ploy and consumed by the next BOOST. */
const WINGS_ARMED = 'murderwing.wingsArmed';
/** WINGS OF DARKNESS: "…cannot perform the Shoot, Fight or Carving Blow action". */
const WINGS_SPENT = 'murderwing.wingsSpent';
/** WARP FUEL: the free action's 3" move cap. */
const WARP_FUEL_MOVE = 'murderwing.warpFuelMove';
/** MALICIOUS NARCISSISM: "you cannot counteract until that friendly … operative is expended". */
const NARCISSISM = 'murderwing.maliciousNarcissism';
/** HUNTMASTER › Pinned Prey: that enemy operative cannot perform the Fall Back action. */
const PINNED = 'murderwing.pinned';
/** The last ranged weapon fired this activation, so the Astartes second Shoot can be checked. */
const LAST_RANGED = 'murderwing.lastRanged';
/** CHAOS LORD › Path to Damnation points, by operative id. */
const DAMNATION = 'murderwing.damnation';
/** "It was wounded at the start of the activation/counteraction" (CULL THE WEAK). */
const WOUNDED_AT_START = 'murderwing.woundedAtStart';
/** WARP FUEL: friendlies inside the enemy's control range when it activated. */
const CR_AT_START = 'murderwing.crAtStart';

/** "…ends the Charge, Dash, Fall Back or Reposition action" (MURDEROUS DESCENT). */
const DESCENT_TRIGGERS = ['Charge', 'Dash', 'Fall Back', 'Reposition'];

const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

// ---------------------------------------------------------------------------
// Geometry helpers the Jump Pack needs
// ---------------------------------------------------------------------------

/**
 * "…as long as no part of its base is underneath Vantage terrain" / "cannot be set up with any
 * part of its base underneath Vantage terrain" / "Enemy operatives with any part of their base
 * underneath Vantage terrain are not within … BOOST ZONEs."
 */
export function underVantage(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  at?: { pos: Vec2; z: number },
): boolean {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  const pos = at?.pos ?? op.pos;
  const z = at?.z ?? op.z;
  return index.parts.some(
    (part) => hasType(part, 'Vantage') && part.z0 > z + 0.05 && baseGapToPoly(pos, c.base, op.rot, part.poly) <= 1e-6,
  );
}

/** Can this operative legally be set up here? (Set-up legality, not a move.) */
function canPlaceAt(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
  z: number,
): { ok: boolean; reason?: string } {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, modelHeight(c)))
    return { ok: false, reason: 'it cannot be set up inside terrain' };
  if (baseTouchesHazardous(index, pos, c.base, op.rot)) return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const r = baseRadius(c.base);
  const { w, h } = state.map.board;
  if (pos.x - r < -1e-6 || pos.y - r < -1e-6 || pos.x + r > w + 1e-6 || pos.y + r > h + 1e-6)
    return { ok: false, reason: 'bases cannot be over the edge of the killzone' };
  if (z > 1e-6 && Math.abs(surfaceAt(index, pos, z + 0.05) - z) > 0.05)
    return { ok: false, reason: 'it can only be set up on the killzone floor or on Vantage terrain' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    if (Math.abs(other.z - z) > 1) continue;
    if (baseGap(pos, c.base, op.rot, other.pos, card(ctx, other).base, other.rot) < -1e-4)
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true };
}

/** Enemy operatives whose control range covers `op` if it stood at `pos`/`z`. */
function enemiesAt(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2, z: number): OperativeState[] {
  const ghost: OperativeState = { ...op, pos, z };
  return aliveOperatives(state)
    .filter((e) => e.player !== op.player)
    .filter((e) => inControlRange(ctx, state, ghost, e));
}

// ---------------------------------------------------------------------------
// Jump Pack — the BOOST itself (faction rule 1)
// ---------------------------------------------------------------------------

export type BoostBase = 'Reposition' | 'Fall Back' | 'Charge';

interface BoostPlan {
  ok: boolean;
  reason?: string;
  dest?: Vec2;
  destZ?: number;
  inches?: number;
  extra?: boolean;
}

/**
 * Jump Pack: "remove it from the killzone and set it back up wholly within x" horizontally of
 * its original location. X is a distance of your choice (rounded up to the nearest inch…), but
 * it's added to the total move distance used for that action… If it would BOOST during the
 * Charge action, don't add the additional 2" to its move allowance."
 *
 * Pure: `check` and `perform` both run this, so whatever `check` accepts `perform` completes
 * (docs/DECISIONS.md D-026).
 */
function planBoost(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  base: BoostBase,
): BoostPlan {
  const dest = params.targetPos;
  if (!dest) return { ok: false, reason: 'select the location to BOOST to' };
  if (underVantage(ctx, state, op))
    return { ok: false, reason: 'it cannot BOOST while part of its base is underneath Vantage terrain' };

  const inches = Math.ceil(dist(op.pos, dest) - 1e-9);
  if (inches < 1) return { ok: false, reason: 'a BOOST must move the operative at least 1"' };

  // "…in other words, move plus BOOST cannot exceed the action's move allowance", and the
  // Charge action's additional 2" is not added.
  const extra = Boolean(effectOn(state, op.id, WINGS_ARMED));
  const budget = moveBudget(ctx, state, op, { action: base }) + (extra ? 3 : 0);
  if (inches > budget + 1e-6)
    return { ok: false, reason: `a ${inches}" BOOST exceeds this action's ${budget}" move allowance` };

  // The UI supplies an explicit elevation when the player means to come down UNDER a Vantage
  // level rather than on top of it; otherwise the highest standable surface is used.
  const explicitZ = typeof params.data?.['z'] === 'number' ? (params.data['z'] as number) : undefined;
  const destZ = explicitZ ?? surfaceAt(terrain(ctx, state), dest);
  if (underVantage(ctx, state, op, { pos: dest, z: destZ }))
    return { ok: false, reason: 'it cannot be set up with any part of its base underneath Vantage terrain' };
  const place = canPlaceAt(ctx, state, op, dest, destZ);
  if (!place.ok) return { ok: false, reason: place.reason ?? 'it cannot be set up there' };

  const engagedAtEnd = enemiesAt(ctx, state, op, dest, destZ);
  if (base !== 'Charge' && engagedAtEnd.length > 0)
    return { ok: false, reason: 'unless it’s the Charge action, it cannot be set up within control range of an enemy operative' };
  if (base === 'Charge' && engagedAtEnd.length === 0)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };

  // "In a killzone that uses the close quarters rules … the x" cannot be measured over or
  // through Wall terrain, and that operative cannot be set up on the other side of an access
  // point — in other words, it cannot BOOST through an open hatchway."
  if (state.map.closeQuarters) {
    const index = terrain(ctx, state);
    const blocked = index.walls.some((wpart) => segmentCrossesPoly(op.pos, dest, wpart.poly));
    if (blocked) return { ok: false, reason: 'a BOOST cannot be measured over or through Wall terrain' };
  }

  return { ok: true, dest, destZ, inches, extra };
}

function applyBoost(ctx: GameContext, state: GameState, op: OperativeState, plan: BoostPlan, base: BoostBase): void {
  const from: Vec2 = { ...op.pos };
  op.pos = { ...plan.dest! };
  op.z = plan.destZ!;
  op.onGuard = false;
  if (op.carryingMarkerId) {
    const m = state.markers[op.carryingMarkerId];
    if (m) {
      m.pos = { ...op.pos };
      m.z = op.z;
    }
  }
  // "If it moves within control range of an enemy operative that no other friendly operatives
  // are within control range of, it cannot leave that operative's control range."
  if (base === 'Charge') {
    const sticky = enemiesInControlRange(ctx, state, op).filter(
      (e) =>
        !aliveOperatives(state, op.player).some(
          (f) => f.id !== op.id && enemiesInControlRange(ctx, state, f).some((x) => x.id === e.id),
        ),
    );
    op.stickyEngagedWith = sticky.map((e) => e.id);
  }

  dropEffects(state, (e) => e.rule === BOOST && e.operativeId === op.id);
  effect(state, {
    rule: BOOST,
    source: { kind: 'core', id: 'murderwing.rule.jump-pack' },
    sourceText: shortQuote(text('murderwing.rule.jump-pack')),
    operativeId: op.id,
    player: op.player,
    data: { from, to: { ...op.pos }, action: base },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  if (!state.effects.some((e) => e.rule === BOOSTED_TP && e.operativeId === op.id))
    effect(state, {
      rule: BOOSTED_TP,
      source: { kind: 'core', id: 'murderwing.rule.jump-pack' },
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfTurningPoint' },
    });

  // WINGS OF DARKNESS: the +3" is spent here, and the restriction is armed.
  if (plan.extra) {
    dropEffects(state, (e) => e.rule === WINGS_ARMED && e.operativeId === op.id);
    effect(state, {
      rule: WINGS_SPENT,
      source: { kind: 'ploy', id: 'murderwing.fp.wings-of-darkness' },
      sourceText: shortQuote(text('murderwing.fp.wings-of-darkness')),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  }

  // RAPTOR › Thrill of Flight: "Whenever this operative does a BOOST during its activation."
  if (op.datacardId === 'murderwing.raptor') {
    op.aplMods = [];
    if (!effectOn(state, op.id, IGNORE_INJURED))
      effect(state, {
        rule: IGNORE_INJURED,
        source: { kind: 'ability', id: 'murderwing.raptor.thrill-of-flight' },
        sourceText: shortQuote(abilityText('murderwing.raptor', 'murderwing.raptor.thrill-of-flight')),
        operativeId: op.id,
        player: op.player,
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
  }

  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.name} does a BOOST (${plan.inches}") during the ${base} action`,
    data: { operativeId: op.id, action: base, inches: plan.inches },
  });
}

export const BOOST_REPOSITION = 'Reposition (BOOST)';
export const BOOST_FALL_BACK = 'Fall Back (BOOST)';
export const BOOST_CHARGE = 'Charge (BOOST)';

function registerBoostAction(id: string, name: string, ap: number, base: BoostBase): void {
  registerAction({
    id,
    name,
    ap,
    type: 'unique',
    treatedAs: base,
    sourceText: text('murderwing.rule.jump-pack'),
    available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
    check(ctx, state, op, params) {
      if (base === 'Reposition') {
        if (enemiesInControlRange(ctx, state, op).length > 0)
          return { ok: false, reason: 'within control range of an enemy operative' };
        if (did(op, 'Fall Back') || did(op, 'Charge'))
          return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      } else if (base === 'Fall Back') {
        if (enemiesInControlRange(ctx, state, op).length === 0)
          return { ok: false, reason: 'no enemy operative within control range' };
        if (did(op, 'Reposition') || did(op, 'Charge'))
          return { ok: false, reason: 'already performed Reposition or Charge this activation' };
      } else {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (enemiesInControlRange(ctx, state, op).length > 0)
          return { ok: false, reason: 'already within control range of an enemy operative' };
        if (did(op, 'Reposition') || did(op, 'Dash') || did(op, 'Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      const plan = planBoost(ctx, state, op, params, base);
      return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'that BOOST is not possible' };
    },
    perform(ctx, state, op, params) {
      const plan = planBoost(ctx, state, op, params, base);
      if (!plan.ok) return { ok: false, reason: plan.reason };
      applyBoost(ctx, state, op, plan, base);
      return { ok: true };
    },
  });
}

registerBoostAction(BOOST_REPOSITION, 'Reposition (BOOST)', 1, 'Reposition');
registerBoostAction(BOOST_FALL_BACK, 'Fall Back (BOOST)', 2, 'Fall Back');
registerBoostAction(BOOST_CHARGE, 'Charge (BOOST)', 1, 'Charge');

// ---------------------------------------------------------------------------
// Boost Actions (faction rule 2) — the BOOST ZONE
// ---------------------------------------------------------------------------

export interface BoostZone {
  from: Vec2;
  to: Vec2;
  action: string;
}

export function boostZoneOf(state: GameState, operativeId: string): BoostZone | undefined {
  const eff = effectOn(state, operativeId, BOOST);
  const from = eff?.data?.['from'] as Vec2 | undefined;
  const to = eff?.data?.['to'] as Vec2 | undefined;
  if (!from || !to) return undefined;
  return { from, to, action: String(eff?.data?.['action'] ?? '') };
}

/**
 * "Most BOOST actions affect enemy operatives within a friendly MURDERWING operative's BOOST
 * ZONE. This is the horizontal area between a friendly MURDERWING operative's current location
 * and the location from which it used BOOST. A marker the same size as the operative's base can
 * be temporarily placed to help determine this."
 */
export function inBoostZone(ctx: GameContext, state: GameState, booster: OperativeState, enemy: OperativeState): boolean {
  const zone = boostZoneOf(state, booster.id);
  if (!zone) return false;
  if (underVantage(ctx, state, enemy)) return false; // "…are not within … BOOST ZONEs"
  const swept = baseRadius(card(ctx, booster).base) + baseRadius(card(ctx, enemy).base);
  return distancePointToSegment(enemy.pos, zone.from, zone.to) <= swept + 1e-6;
}

/** The shared legality of every BOOST action. */
function boostActionCheck(
  state: GameState,
  op: OperativeState,
  during: BoostBase[],
): { ok: boolean; reason?: string } {
  const zone = boostZoneOf(state, op.id);
  if (!zone)
    return { ok: false, reason: 'this operative performs this action during a move action, after setting up from a BOOST' };
  if (!during.includes(zone.action as BoostBase))
    return { ok: false, reason: `it performs this action during the ${during.join(' or ')} action` };
  if (effectOn(state, op.id, BOOST_ACTION_USED))
    return { ok: false, reason: 'each operative cannot perform more than one BOOST action per activation/counteraction' };
  return { ok: true };
}

function markBoostAction(state: GameState, op: OperativeState, sourceId: string): void {
  effect(state, {
    rule: BOOST_ACTION_USED,
    source: { kind: 'core', id: sourceId },
    sourceText: shortQuote(text('murderwing.rule.boost-actions')),
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
}

/** Enemy operatives inside this operative's BOOST ZONE, in a deterministic order. */
function boostZoneEnemies(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state)
    .filter((e) => e.player !== op.player && !e.incapacitated && inBoostZone(ctx, state, op, e))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Astartes (faction rule 3) — the second Shoot / Fight action
// ---------------------------------------------------------------------------

export const ASTARTES_SHOOT = 'Shoot (Murderwing Astartes)';
export const ASTARTES_FIGHT = 'Fight (Murderwing Astartes)';

const isBoltPistol = (name: string): boolean => name.trim().toLowerCase() === 'bolt pistol';

registerAction({
  id: ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text('murderwing.rule.astartes'),
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    if (did(op, 'Fight')) return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    if (!did(op, 'Shoot')) return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    // "If it's two Shoot actions, a bolt pistol must be selected for at least one of them."
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    if (!isBoltPistol(first) && !isBoltPistol(params.weaponName ?? ''))
      return { ok: false, reason: 'a bolt pistol must be selected for at least one of them' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text('murderwing.rule.astartes'),
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    if (did(op, 'Shoot')) return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    if (!did(op, 'Fight')) return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    // CARVING BLOW: "…or during the same activation in which it performed … two Fight actions
    // (and vice versa)."
    if (did(op, 'CARVING BLOW'))
      return { ok: false, reason: 'it performed the Carving Blow action during this activation' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// CHAOS LORD — Path to Damnation / Boons of Damnation
// ---------------------------------------------------------------------------

export function damnationPoints(state: GameState, operativeId: string): number {
  const v = bucket(state, DAMNATION)[operativeId];
  // "This operative starts the battle with 1 Damnation point."
  return typeof v === 'number' ? v : 1;
}

function setDamnation(state: GameState, operativeId: string, n: number): void {
  bucket(state, DAMNATION)[operativeId] = n;
}

/**
 * "Once per action, you can attempt to use one Boon of Damnation when it specifies. If you do,
 * roll one D6 and compare the result to the number of Damnation points this operative has;
 * Higher: Resolve the rule, then this operative gains 1 Damnation point. Equal: Do not resolve
 * the rule. Less: Inflict damage on this operative equal to its number of Damnation points and
 * do not resolve the rule. If this operative has 6 Damnation points, resolve the rule without
 * rolling."
 *
 * "You can attempt" is a player choice with no decision channel, so the module takes the
 * deterministic policy of attempting whenever the attempt is not odds-against — the D6 beats
 * p points on 6−p results and falls short on p−1, so it attempts at 3 or fewer points, and
 * at 6 (where the boon resolves without a roll).
 */
function attemptBoon(T: TeamHooks, state: GameState, op: OperativeState, what: string): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const pts = damnationPoints(state, op.id);
  if (pts > 3 && pts < 6) return false;
  if (!useOncePerSequence(state, `murderwing.damnation:${op.id}`)) return false;
  if (pts >= 6) {
    log(state, { kind: 'action', player: op.player, text: `${op.name}: ${what} resolves (6 Damnation points)` });
    return true;
  }
  const roll = ctx.rng.d6();
  recordRoll(state, 'damnation', [roll], op.player, `Path to Damnation (${pts} points)`);
  if (roll > pts) {
    setDamnation(state, op.id, pts + 1);
    log(state, { kind: 'action', player: op.player, text: `${op.name}: ${what} — ${roll} beats ${pts}, +1 Damnation point` });
    return true;
  }
  if (roll === pts) {
    log(state, { kind: 'action', player: op.player, text: `${op.name}: ${what} — ${roll} equals ${pts}, no effect` });
    return false;
  }
  log(state, { kind: 'action', player: op.player, text: `${op.name}: ${what} — ${roll} is less than ${pts}` });
  inflictDamage(ctx, state, op, pts, 'other');
  return false;
}

// ---------------------------------------------------------------------------
// Small readers shared by several rules
// ---------------------------------------------------------------------------

function meleeProfileOf(T: TeamHooks, op: OperativeState, weaponName?: string, profileName?: string): WeaponProfile | undefined {
  const weapons = T.card(op)?.weapons ?? [];
  const w = weapons.find((x) => x.name === weaponName) ?? weapons.find((x) => x.profiles.some((p) => p.type === 'melee'));
  if (!w) return undefined;
  return w.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? w.profiles[0];
}

const hasChallengeToken = (state: GameState, op: OperativeState, player: PlayerId): boolean =>
  state.effects.some((e) => e.rule === CHALLENGE && e.operativeId === op.id && e.player === player);

/** "It was wounded at the start of the activation/counteraction" (CULL THE WEAK). */
const woundedAtStart = (state: GameState, op: OperativeState): boolean =>
  Boolean(bucket(state, WOUNDED_AT_START)[op.id]);

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Astartes: "Each friendly MURDERWING operative can counteract regardless of its order."
  // `counteractCandidates` emits `onCounteract` for every expended, not-yet-counteracted
  // operative with `allowed: o.order === 'engage'` as the DEFAULT, so this widens it rather than
  // narrowing. Everything else the core checks — expended, once per turning point, and the On
  // Guard lockout ("that friendly operative cannot counteract during the turning point") — is
  // untouched, as is MALICIOUS NARCISSISM's later veto (priority 21, so it still wins).
  reg.on('onCounteract', T.bind('murderwing.rule.astartes', 12), (ev) => {
    if (T.mineKw(ev.operative, KW)) ev.allowed = true;
  });

  // ---- Astartes: remember the ranged weapon, for the second Shoot ---------
  reg.on('onCollectAttackDice', T.bind('murderwing.rule.astartes', 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: 'murderwing.rule.astartes' },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  // ---- Per-activation bookkeeping ---------------------------------------
  reg.on('onActivationStart', T.bind('murderwing.sp.cull-the-weak', 8), (ev) => {
    // CULL THE WEAK reads "wounded at the start of the activation/counteraction"; snapshot the
    // whole killzone once per activation (the engine has no counteract hook).
    const snap = bucket(ev.state, WOUNDED_AT_START);
    for (const o of aliveOperatives(ev.state)) snap[o.id] = o.wounds < (T.card(o)?.wounds ?? o.wounds);
  });

  // ---- HUNTMASTER › Pinned Prey -----------------------------------------
  reg.on('onActivationStart', T.bind('murderwing.huntmaster.pinned-prey', 12), (ev) => {
    const enemy = ev.operative;
    const ctx = T.ctx;
    if (!ctx || enemy.player === T.player) return;
    const hunt = T.friendlies(ev.state).find((o) => {
      if (o.datacardId !== 'murderwing.huntmaster') return false;
      const engaged = enemiesInControlRange(ctx, ev.state, o);
      // "…if no other enemy operatives are within this operative's control range"
      return engaged.length === 1 && engaged[0]!.id === enemy.id;
    });
    if (!hunt) return;
    // "roll two D6, or one D6 if that enemy operative has a higher Wounds stat than this operative"
    const n = (T.card(enemy)?.wounds ?? 0) > (T.card(hunt)?.wounds ?? 0) ? 1 : 2;
    const results = ctx.rng.roll(n);
    recordRoll(ev.state, 'pinnedPrey', results, T.player, `Pinned Prey vs ${enemy.name}`);
    if (!results.some((r) => r >= 4)) return;
    effect(ev.state, {
      rule: PINNED,
      source: { kind: 'ability', id: 'murderwing.huntmaster.pinned-prey' },
      sourceText: shortQuote(abilityText('murderwing.huntmaster', 'murderwing.huntmaster.pinned-prey')),
      operativeId: enemy.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: enemy.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Pinned Prey: ${enemy.name} cannot Fall Back` });
  });
  reg.on('canPerformAction', T.bind('murderwing.huntmaster.pinned-prey', 12), (ev) => {
    if (ev.operative.player === T.player) return;
    if (ev.action !== 'Fall Back' && ev.action !== BOOST_FALL_BACK) return;
    if (!effectOn(ev.state, ev.operative.id, PINNED)) return;
    ev.allowed = false;
    ev.reason = 'Pinned Prey: that operative cannot perform that action during that activation';
  });

  // ---- WARP FUEL bookkeeping: who was engaging the enemy when it activated?
  reg.on('onActivationStart', T.bind('murderwing.eq.warp-fuel', 9), (ev) => {
    const ctx = T.ctx;
    if (!ctx || ev.operative.player === T.player) return;
    const snap = bucket(ev.state, CR_AT_START);
    snap[ev.operative.id] = enemiesInControlRange(ctx, ev.state, ev.operative)
      .filter((f) => f.player === T.player && T.kw(f, KW))
      .map((f) => f.id);
  });

  // ---- CHAOS LORD › Boons of Damnation ----------------------------------
  // "When an attack dice inflicts damage of 3 or more on this operative, you can ignore an
  //  amount of damage equal to this operative's Damnation points."
  reg.on('onDamage', T.bind('murderwing.chaos-lord.boons-of-damnation', 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount < 3) return;
    if (ev.target.player !== T.player || ev.target.datacardId !== 'murderwing.chaos-lord') return;
    const pts = damnationPoints(ev.state, ev.target.id);
    if (!attemptBoon(T, ev.state, ev.target, 'Boon of Damnation (ignore damage)')) return;
    ev.amount = Math.max(0, ev.amount - pts);
  });
  // "When this operative is fighting or retaliating and you strike with an attack dice, you can
  //  inflict an amount of additional damage equal to this operative's Damnation points."
  reg.on('onDamage', T.bind('murderwing.chaos-lord.boons-of-damnation', 13), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const lordId = [seq.attackerId, seq.defenderId].find((id) => {
      const o = ev.state.operatives[id];
      return o?.player === T.player && o.datacardId === 'murderwing.chaos-lord';
    });
    if (!lordId) return;
    const lord = ev.state.operatives[lordId]!;
    if (ev.target.id === lord.id || ev.target.player === T.player) return; // the lord must be striking
    const pts = damnationPoints(ev.state, lord.id);
    if (!attemptBoon(T, ev.state, lord, 'Boon of Damnation (additional damage)')) return;
    ev.amount += pts;
  });

  // ---- CHAMPION › Chaos Champion ----------------------------------------
  // The Challenge token is placed by the STRATEGIC GAMBIT (see `gambits` below).
  reg.on('onWeaponRules', T.bind('murderwing.champion.chaos-champion', 12), (ev) => {
    if (ev.type !== 'melee') return;
    if (!T.mine(ev.operative) || ev.operative.datacardId !== 'murderwing.champion') return;
    if (!ev.target || !hasChallengeToken(ev.state, ev.target, T.player)) return;
    const chosen = String(bucket(ev.state, 'murderwing.challengeRule')[T.player] ?? 'Balanced');
    ev.rules.push(ruleTag(chosen, undefined, `${chosen} (Chaos Champion)`));
  });

  // ---- CHAMPION › Path to Glory -----------------------------------------
  reg.on('onIncapacitated', T.bind('murderwing.champion.path-to-glory', 12), (ev) => {
    const victim = ev.operative;
    if (victim.player === T.player) return;
    if (!hasChallengeToken(ev.state, victim, T.player)) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const ids = seq.kind === 'fight' ? [seq.attackerId, seq.defenderId] : [seq.attackerId];
    const champ = ids
      .map((id) => ev.state.operatives[id])
      .find((o) => o?.player === T.player && o.datacardId === 'murderwing.champion');
    if (!champ || champ.id === victim.id) return;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Path to Glory: ${champ.name} gains 1CP` });
  });

  // ---- CURSECLAW › Frenzied Attack --------------------------------------
  reg.on('onIncapacitated', T.bind('murderwing.curseclaw.frenzied-attack', 11), (ev) => {
    const victim = ev.operative;
    const ctx = T.ctx;
    if (!ctx || victim.player !== T.player || victim.datacardId !== 'murderwing.curseclaw') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === victim.id ? 'attacker' : seq.defenderId === victim.id ? 'defender' : undefined;
    if (!side) return;
    if (!useOncePerSequence(ev.state, `murderwing.frenzied:${victim.id}`)) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const die = successes(pool).find((d) => d.state === 'crit') ?? successes(pool)[0];
    if (!die) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    if (!foe || foe.removed || foe.incapacitated) return;
    const profile = meleeProfileOf(
      T,
      victim,
      side === 'attacker' ? seq.attackerWeapon : seq.defenderWeapon,
      side === 'attacker' ? seq.attackerProfile : seq.defenderProfile,
    );
    if (!profile) return;
    const crit = die.state === 'crit';
    die.state = 'struck';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Frenzied Attack: ${victim.name} strikes ${foe.name} for ${crit ? profile.dmgC : profile.dmgN}`,
    });
    inflictDamage(ctx, ev.state, foe, crit ? profile.dmgC : profile.dmgN, 'attack');
  });

  // ---- DEPREDATOR › Horrifying Dismemberment ----------------------------
  reg.on('onIncapacitated', T.bind('murderwing.depredator.horrifying-dismemberment', 12), (ev) => {
    const victim = ev.operative;
    const ctx = T.ctx;
    if (!ctx || victim.player === T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (victim.id !== seq.attackerId && victim.id !== seq.defenderId) return;
    const dep = [seq.attackerId, seq.defenderId]
      .map((id) => ev.state.operatives[id])
      .find((o) => o?.player === T.player && o.datacardId === 'murderwing.depredator');
    if (!dep) return;
    const index = terrain(ctx, ev.state);
    const near = (a: OperativeState, b: OperativeState): boolean =>
      T.gap(a, b) <= 3 + 1e-6 && isVisible(index, body(ctx, a), body(ctx, b)).visible;
    const pick = T.enemies(ev.state)
      .filter((e) => e.id !== victim.id && !e.incapacitated && (near(dep, e) || near(victim, e)))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!pick) return;
    pick.aplMods.push(-1);
    effect(ev.state, {
      rule: 'murderwing.dismembered',
      source: { kind: 'ability', id: 'murderwing.depredator.horrifying-dismemberment' },
      sourceText: shortQuote(abilityText('murderwing.depredator', 'murderwing.depredator.horrifying-dismemberment')),
      operativeId: pick.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: pick.id, armed: false },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Horrifying Dismemberment: ${pick.name} −1 APL` });
  });

  // ---- RAPTOR › Thrill of Flight (the injured half) ----------------------
  reg.on('onStatMod', T.bind('murderwing.raptor.thrill-of-flight', 12), (ev) => {
    if (!T.mine(ev.operative)) return;
    if (!effectOn(ev.state, ev.operative.id, IGNORE_INJURED)) return;
    const c = T.card(ev.operative);
    if (!c || ev.operative.wounds >= c.wounds / 2) return; // not injured
    ev.mods.move += 2; // cancels "subtract 2\" from the Move stat of injured operatives"
    ev.mods.hit += 1; // cancels "worsen the Hit stat of their weapons by 1"
  });

  // ---- SHRIEKER › Modified Vox-casters ----------------------------------
  reg.on('onActionCost', T.bind('murderwing.shrieker.modified-vox-casters', 12), (ev) => {
    if (ev.operative.player === T.player) return;
    const isMission = ev.action === 'Pick Up Marker' || getAction(ev.action)?.type === 'mission';
    if (!isMission) return;
    const near = T.friendlies(ev.state).some(
      (o) => o.datacardId === 'murderwing.shrieker' && T.gap(o, ev.operative) <= 3 + 1e-6,
    );
    if (near) ev.ap += 1;
  });
  reg.on('onMarkerControl', T.bind('murderwing.shrieker.modified-vox-casters', 12), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const foe = T.player === 'p1' ? 'p2' : 'p1';
    const shriekers = T.friendlies(ev.state).filter((o) => o.datacardId === 'murderwing.shrieker');
    if (shriekers.length === 0) return;
    const contesting = T.enemies(ev.state).filter((e) => markerContestedBy(ctx, ev.state, marker, e));
    if (contesting.length === 0) return;
    if (!contesting.some((e) => shriekers.some((s) => T.gap(s, e) <= 3 + 1e-6))) return;
    // "Note this isn't a change to the APL stat, so any changes are cumulative with this."
    ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });

  // ---- WARP TALON › Slice the Veil --------------------------------------
  // REMINDER ONLY. "When setting up this operative before the battle, you can set it up in the
  // warp instead: place it to one side instead of in the killzone." There is no decision
  // channel during Select Operatives / deployment (docs/TEAM-STATUS.md § Known engine gaps) and
  // no off-killzone reserve state at all: an operative is either deployed or `removed`. The
  // whole ability — the warp marker, the second-Firefight-phase set-up, the "obscured to
  // operatives more than 3\" from it" window and the MALICIOUS NARCISSISM carve-out — hangs off
  // that first choice, so nothing of it can be bound to a hook that would ever fire.
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- PREDATORS ABOVE (strategy, 1CP) ----------------------------------
  reg.on('onWeaponRules', T.bind('murderwing.sp.predators-above', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'murderwing.sp.predators-above')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const high = ev.operative.z >= 2 - 1e-6;
    const boosted = Boolean(effectOn(ev.state, ev.operative.id, BOOST));
    if (!high && !boosted) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Predators Above)'));
  });

  // ---- CULL THE WEAK (strategy, 1CP) ------------------------------------
  reg.on('onWeaponRules', T.bind('murderwing.sp.cull-the-weak', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'murderwing.sp.cull-the-weak')) return;
    if (!T.mineKw(ev.operative, KW) || !ev.target || !T.ctx) return;
    const target = ev.target;
    const lower = ev.operative.z - target.z >= 2 - 1e-6;
    const aplDown = aplOf(T.ctx, ev.state, target) < (T.card(target)?.apl ?? 0);
    if (!lower && !aplDown && !woundedAtStart(ev.state, target)) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Cull the Weak)'));
  });

  // ---- NIGHTMARE ON HIGH (strategy, 1CP) --------------------------------
  reg.on('onDefenceDice', T.bind('murderwing.sp.nightmare-on-high', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'murderwing.sp.nightmare-on-high')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const high = target.z >= 2 - 1e-6;
    const boosted = ev.state.effects.some((e) => e.rule === BOOSTED_TP && e.operativeId === target.id);
    if (!high && !boosted) return;
    ev.rerolls.push({
      id: 'murderwing.nightmareOnHigh',
      label: 'Nightmare on High: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('murderwing.sp.nightmare-on-high')),
    });
  });

  // ---- INSTIL FEAR (strategy, 1CP) --------------------------------------
  // "Whenever a friendly MURDERWING operative is fighting, Normal Dmg of 3 or more inflicts 1
  //  less damage on it."
  reg.on('onDamage', T.bind('murderwing.sp.instil-fear', 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, 'murderwing.sp.instil-fear')) return;
    if (!T.mineKw(ev.target, KW)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== ev.target.id) return; // "is fighting", not retaliating
    const foe = ev.state.operatives[seq.defenderId];
    if (!foe) return;
    const profile = meleeProfileOf(T, foe, seq.defenderWeapon, seq.defenderProfile);
    if (!profile || profile.dmgN < 3) return;
    ev.amount = Math.max(0, ev.amount - 1);
  });

  // ---- MALICIOUS NARCISSISM (firefight, 1CP) ----------------------------
  reg.on('onPloyUsed', T.bind('murderwing.fp.malicious-narcissism', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'murderwing.fp.malicious-narcissism') return;
    const ready = T.friendlies(ev.state, KW).filter((o) => o.ready);
    const chosen = chosenOperative(ev.state, ev.data, ready);
    if (!chosen) return;
    effect(ev.state, {
      rule: NARCISSISM,
      source: { kind: 'ploy', id: 'murderwing.fp.malicious-narcissism' },
      sourceText: shortQuote(text('murderwing.fp.malicious-narcissism')),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Malicious Narcissism: ${chosen.name} delays its activation`,
    });
  });
  // "Note that you cannot counteract until that friendly MURDERWING operative is expended."
  reg.on('onCounteract', T.bind('murderwing.fp.malicious-narcissism', 21), (ev) => {
    if (ev.operative.player !== T.player) return;
    const held = ev.state.effects.find((e) => e.rule === NARCISSISM && e.player === T.player);
    if (!held?.operativeId) return;
    const holder = ev.state.operatives[held.operativeId];
    if (!holder || holder.removed || holder.expended) return;
    ev.allowed = false;
    ev.reason = 'you cannot counteract until that friendly MURDERWING operative is expended';
  });

  // ---- MURDEROUS DESCENT (firefight, 1CP) -------------------------------
  reg.on('onPloyUsed', T.bind('murderwing.fp.murderous-descent', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'murderwing.fp.murderous-descent') return;
    const ctx = T.ctx;
    const enemy = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const cancel = (): void => {
      // "If this isn't possible, the interruption is cancelled and this rule hasn't been used."
      const team = ev.state.teams[T.player];
      team.cp += 1;
      team.ploysUsedTP = team.ploysUsedTP.filter((p) => p !== 'murderwing.fp.murderous-descent');
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Murderous Descent: not possible — this rule hasn’t been used' });
    };
    if (!ctx || !enemy || enemy.player === T.player) return cancel();
    const candidates = descentCandidates(ev.state, T.player).filter((o) => o.id !== enemy.id);
    const diver = chosenOperative(ev.state, ev.data, candidates);
    if (!diver) return cancel();
    const spot = chargeSpotNear(ctx, ev.state, diver, enemy);
    if (!spot) return cancel();
    diver.pos = { ...spot.pos };
    diver.z = spot.z;
    diver.onGuard = false;
    diver.stickyEngagedWith = [enemy.id];
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Murderous Descent: ${diver.name} interrupts ${enemy.name} with a free Charge`,
    });
  });

  // ---- LONG FORGOTTEN HONOUR (firefight, 1CP) ---------------------------
  reg.on('onPloyUsed', T.bind('murderwing.fp.long-forgotten-honour', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'murderwing.fp.long-forgotten-honour') return;
    const ctx = T.ctx;
    const seq = fightSeq(ev.state);
    if (!ctx || !seq) return;
    const mineId = [seq.attackerId, seq.defenderId].find((id) => {
      const o = ev.state.operatives[id];
      return o?.player === T.player && T.kw(o, KW);
    });
    if (!mineId) return;
    const me = ev.state.operatives[mineId]!;
    const foe = ev.state.operatives[mineId === seq.attackerId ? seq.defenderId : seq.attackerId];
    // "Instead of striking or blocking, end that sequence (any remaining attack dice are
    //  discarded)".
    for (const pool of [seq.attackerPool, seq.defenderPool])
      for (const d of pool.dice) if (d.state === 'crit' || d.state === 'normal') d.state = 'discarded';
    seq.step = 'done';
    ev.state.pending = ev.state.pending.filter((p) => p.kind !== 'strikeOrBlock');
    ev.state.sequence = null;
    // "…and immediately perform a free Fall Back action up to 3\" with that operative".
    const spot = foe ? retreatSpot(ctx, ev.state, me, foe, 3) : undefined;
    if (spot) {
      me.pos = { ...spot.pos };
      me.z = spot.z;
      me.stickyEngagedWith = [];
    }
    me.onGuard = false;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Long Forgotten Honour: ${me.name} ends the fight and falls back`,
    });
  });

  // ---- WINGS OF DARKNESS (firefight, 1CP) -------------------------------
  reg.on('onPloyUsed', T.bind('murderwing.fp.wings-of-darkness', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'murderwing.fp.wings-of-darkness') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const pool = T.friendlies(ev.state, KW);
    const chosen =
      active && active.player === T.player && T.kw(active, KW) ? active : chosenOperative(ev.state, ev.data, pool);
    if (!chosen) return;
    effect(ev.state, {
      rule: WINGS_ARMED,
      source: { kind: 'ploy', id: 'murderwing.fp.wings-of-darkness' },
      sourceText: shortQuote(text('murderwing.fp.wings-of-darkness')),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Wings of Darkness: ${chosen.name} can BOOST an additional 3"`,
    });
  });
  // "…but it cannot perform the Shoot, Fight or Carving Blow action until the next turning point."
  reg.on('canPerformAction', T.bind('murderwing.fp.wings-of-darkness', 21), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, WINGS_SPENT)) return;
    if (!['Shoot', 'Fight', ASTARTES_SHOOT, ASTARTES_FIGHT, 'CARVING BLOW'].includes(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'Wings of Darkness: it cannot Shoot, Fight or perform Carving Blow until the next turning point';
  });
}

/**
 * MURDEROUS DESCENT: "…within 3" horizontally and more than 2" lower than a friendly
 * MURDERWING operative". Runs without a GameContext (the ploy's `usable` gets none), so base
 * sizes come from the static datacard catalogue.
 */
export function descentCandidates(state: GameState, player: PlayerId): OperativeState[] {
  const enemy = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!enemy || enemy.removed || enemy.player === player) return [];
  if (!enemy.actionsThisActivation.some((a) => DESCENT_TRIGGERS.includes(a))) return [];
  const reach = state.map.closeQuarters ? 2 : 3;
  return aliveOperatives(state, player)
    .filter((o) => (catalogueCard(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => o.z - enemy.z > 2 + 1e-6)
    .filter((o) => horizontal(o.pos, enemy.pos) <= reach + 1e-6)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** A legal spot within control range of `enemy`, inside a Charge's move allowance. */
function chargeSpotNear(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  enemy: OperativeState,
): { pos: Vec2; z: number } | undefined {
  const budget = moveBudget(ctx, state, op, { action: 'Charge', bonusInches: 2 });
  const radius = baseRadius(card(ctx, op).base) + baseRadius(card(ctx, enemy).base) + 0.5;
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    const pos = { x: enemy.pos.x + Math.cos(angle) * radius, y: enemy.pos.y + Math.sin(angle) * radius };
    if (dist(op.pos, pos) > budget + 1e-6) continue;
    const z = surfaceAt(terrain(ctx, state), pos);
    if (!canPlaceAt(ctx, state, op, pos, z).ok) continue;
    if (enemiesAt(ctx, state, op, pos, z).some((e) => e.id === enemy.id)) return { pos, z };
  }
  return undefined;
}

/** A legal spot up to `inches` directly away from `foe` and out of every control range. */
function retreatSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  foe: OperativeState,
  inches: number,
): { pos: Vec2; z: number } | undefined {
  const away = { x: op.pos.x - foe.pos.x, y: op.pos.y - foe.pos.y };
  const len = Math.hypot(away.x, away.y) || 1;
  for (const step of [inches, inches - 0.5, inches - 1, inches - 1.5, inches - 2]) {
    if (step <= 0) break;
    const pos = { x: op.pos.x + (away.x / len) * step, y: op.pos.y + (away.y / len) * step };
    const z = surfaceAt(terrain(ctx, state), pos);
    if (!canPlaceAt(ctx, state, op, pos, z).ok) continue;
    if (enemiesAt(ctx, state, op, pos, z).length > 0) continue;
    return { pos, z };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // BLADEFINS / CLAWED ARMOUR / VOX-CASTERS each grant a unique action; the actions are
  // registered below and gated on the equipment through their `available` predicate. These
  // bindings put the printed text on the rules panel.
  for (const id of ['murderwing.eq.bladefins', 'murderwing.eq.clawed-armour', 'murderwing.eq.vox-casters']) {
    reg.on('canPerformAction', T.bind(id, 30), (ev) => {
      if (ev.operative.player !== T.player) return;
      if (ev.action !== EQUIPMENT_ACTION[id]) return;
      if (!hasEquipment(ev.state, T.player, id)) {
        ev.allowed = false;
        ev.reason = 'your kill team did not select that equipment';
      }
    });
  }

  // ---- WARP FUEL --------------------------------------------------------
  // "Once per turning point, when an enemy operative ends the Fall Back action during its
  //  activation, if at least one friendly MURDERWING operative was within its control range at
  //  the start of that action, you can use this rule. One of those friendly operatives can
  //  immediately perform a free Reposition or Charge action, but cannot use more than 3\" of
  //  move distance."
  reg.on('onActivationEnd', T.bind('murderwing.eq.warp-fuel', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'murderwing.eq.warp-fuel')) return;
    const enemy = ev.operative;
    if (enemy.player === T.player) return;
    if (!did(enemy, 'Fall Back')) return;
    const ids = (bucket(ev.state, CR_AT_START)[enemy.id] ?? []) as string[];
    const pool = ids
      .map((id) => ev.state.operatives[id])
      .filter((o): o is OperativeState => Boolean(o) && !o!.removed && !o!.incapacitated);
    if (pool.length === 0) return;
    if (!useOncePerTP(ev.state, `murderwing.warpFuel:${T.player}`)) return;
    const chosen = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
    // The bonus AP is the LAST one the operative spends, so the 3" cap applies from there on.
    const threshold = currentApl(T, ev.state, chosen);
    grantFreeAction(ev.state, chosen, {
      sourceId: 'murderwing.eq.warp-fuel',
      sourceText: shortQuote(text('murderwing.eq.warp-fuel')),
      kind: 'equipment',
      threshold,
      only: ['Reposition', 'Charge', BOOST_REPOSITION, BOOST_CHARGE],
    });
    effect(ev.state, {
      rule: WARP_FUEL_MOVE,
      source: { kind: 'equipment', id: 'murderwing.eq.warp-fuel' },
      sourceText: shortQuote(text('murderwing.eq.warp-fuel')),
      operativeId: chosen.id,
      player: T.player,
      data: { threshold },
      expiry: { kind: 'endOfNextActivation', operativeId: chosen.id, armed: false },
    });
  });
  // "…but cannot use more than 3\" of move distance."
  reg.on('onMoveDistance', T.bind('murderwing.eq.warp-fuel', 31), (ev) => {
    if (ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, WARP_FUEL_MOVE);
    if (!eff) return;
    if (ev.operative.apSpent < Number(eff.data?.['threshold'] ?? 0)) return;
    ev.inches = Math.min(ev.inches, 3);
  });
}

const EQUIPMENT_ACTION: Record<string, string> = {
  'murderwing.eq.bladefins': 'SLICE FROM ABOVE',
  'murderwing.eq.clawed-armour': 'CLAWED CHARGE',
  'murderwing.eq.vox-casters': 'VOX-CRY',
};

// ---------------------------------------------------------------------------
// STRATEGIC GAMBITs: the four strategy ploys plus the CHAMPION's Chaos Champion
// ---------------------------------------------------------------------------

export const CHAOS_CHAMPION_GAMBIT = 'murderwing.champion.chaos-champion';
/** "…you can select one of the following weapon rules for this operative's melee weapons." */
export const CHALLENGE_RULES = ['Balanced', 'Brutal', 'Punishing', 'Severe', 'Shock'] as const;

function gambits(reg: HookRegistry, T: TeamHooks): void {
  defaultGambits(reg, T);
  reg.on('gambitOptions', T.bind(CHAOS_CHAMPION_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === 'murderwing.champion')) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: CHAOS_CHAMPION_GAMBIT,
      label: 'Chaos Champion: place your Challenge token',
      sourceText: shortQuote(abilityText('murderwing.champion', CHAOS_CHAMPION_GAMBIT)),
    });
  });
  reg.on('onPloyUsed', T.bind(CHAOS_CHAMPION_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== CHAOS_CHAMPION_GAMBIT) return;
    // "Remove your Challenge token from the enemy operative that has it (if any), then select
    //  one enemy operative to gain your Challenge token."
    dropEffects(ev.state, (e) => e.rule === CHALLENGE && e.player === T.player);
    const target = chosenOperative(ev.state, ev.data, T.enemies(ev.state));
    if (!target) return;
    effect(ev.state, {
      rule: CHALLENGE,
      source: { kind: 'ability', id: CHAOS_CHAMPION_GAMBIT },
      sourceText: shortQuote(abilityText('murderwing.champion', CHAOS_CHAMPION_GAMBIT)),
      operativeId: target.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    const wanted = String(ev.data?.['choice'] ?? '');
    const rule = (CHALLENGE_RULES as readonly string[]).includes(wanted) ? wanted : 'Balanced';
    bucket(ev.state, 'murderwing.challengeRule')[T.player] = rule;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Chaos Champion: ${target.name} gains the Challenge token (${rule})`,
    });
  });
}

// ---------------------------------------------------------------------------
// Datacard unique actions
// ---------------------------------------------------------------------------

function actions(data: TeamData): ActionDef[] {
  return [
    // SNATCH 1AP — CURSECLAW (BOOST action)
    uniqueAction(data, 'murderwing.curseclaw', 'murderwing.curseclaw.act.snatch', {
      check: (ctx, state, op, params) => {
        const gate = boostActionCheck(state, op, ['Reposition', 'Fall Back']);
        if (!gate.ok) return gate;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative within this operative’s BOOST ZONE' };
        if (!inBoostZone(ctx, state, op, target))
          return { ok: false, reason: 'that operative is not within this operative’s BOOST ZONE' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        markBoostAction(state, op, 'murderwing.curseclaw.act.snatch');
        // "Both players roll one D6 and add their respective operative's Wounds stat."
        const mine = ctx.rng.d6();
        const theirs = ctx.rng.d6();
        recordRoll(state, 'snatch', [mine, theirs], op.player, 'SNATCH');
        const myScore = mine + card(ctx, op).wounds;
        const theirScore = theirs + card(ctx, target).wounds;
        if (myScore <= theirScore) {
          log(state, { kind: 'action', player: op.player, text: `${op.name}: SNATCH fails (${myScore} vs ${theirScore})` });
          return { ok: true };
        }
        const began = dist(op.pos, target.pos);
        const reach = Math.min(began, baseRadius(card(ctx, op).base) + baseRadius(card(ctx, target).base) + 0.6);
        let moved = false;
        for (let i = 0; i < 24 && !moved; i++) {
          const angle = (i / 24) * Math.PI * 2;
          const pos = { x: op.pos.x + Math.cos(angle) * reach, y: op.pos.y + Math.sin(angle) * reach };
          const z = surfaceAt(terrain(ctx, state), pos);
          if (!canPlaceAt(ctx, state, target, pos, z).ok) continue;
          target.pos = pos;
          target.z = z;
          moved = true;
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: moved
            ? `${op.name}: SNATCH drags ${target.name} in (${myScore} vs ${theirScore})`
            : `${op.name}: SNATCH wins but ${target.name} has nowhere it can be placed`,
        });
        return { ok: true };
      },
    }),

    // CARVING BLOW 1AP — DEPREDATOR
    uniqueAction(data, 'murderwing.depredator', 'murderwing.depredator.act.carving-blow', {
      check: (ctx, state, op) => {
        if (op.order === 'conceal')
          return { ok: false, reason: 'it cannot perform this action while it has a Conceal order' };
        if (did(op, 'SLICE FROM ABOVE') || did(op, 'CLAWED CHARGE'))
          return { ok: false, reason: 'it performed the Slice From Above or Clawed Charge action this activation' };
        if (did(op, 'Fight') && did(op, ASTARTES_FIGHT))
          return { ok: false, reason: 'it performed two Fight actions this activation' };
        if (carvingBlowVictims(ctx, state, op).length === 0)
          return { ok: false, reason: 'no other operative is visible to and within 2" of this operative' };
        return { ok: true };
      },
      perform: (ctx, state, op) => {
        // "Inflict 2D3 damage on each other operative visible to and within 2" of this operative
        //  in an order of your choice (roll separately for each)."
        for (const victim of carvingBlowVictims(ctx, state, op)) {
          const a = ctx.rng.d3();
          const b = ctx.rng.d3();
          recordRoll(state, 'carvingBlow', [a, b], op.player, `CARVING BLOW vs ${victim.name}`);
          inflictDamage(ctx, state, victim, a + b, 'other');
        }
        log(state, { kind: 'action', player: op.player, text: `${op.name}: CARVING BLOW` });
        return { ok: true };
      },
    }),

    // STRIKE FROM ABOVE 1AP — HUNTMASTER (BOOST action)
    uniqueAction(data, 'murderwing.huntmaster', 'murderwing.huntmaster.act.strike-from-above', {
      check: (ctx, state, op, params) => {
        const gate = boostActionCheck(state, op, ['Reposition', 'Fall Back']);
        if (!gate.ok) return gate;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative within this operative’s BOOST ZONE' };
        if (!inBoostZone(ctx, state, op, target))
          return { ok: false, reason: 'that operative is not within this operative’s BOOST ZONE' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        markBoostAction(state, op, 'murderwing.huntmaster.act.strike-from-above');
        const a = ctx.rng.d3();
        const b = ctx.rng.d3();
        recordRoll(state, 'strikeFromAbove', [a, b], op.player, 'STRIKE FROM ABOVE 2D3+1');
        inflictDamage(ctx, state, target, a + b + 1, 'other');
        log(state, { kind: 'action', player: op.player, text: `${op.name}: STRIKE FROM ABOVE hits ${target.name}` });
        return { ok: true };
      },
    }),

    // SHRIEK 1AP — SHRIEKER (a BOOST action only when the target is in the BOOST ZONE)
    uniqueAction(data, 'murderwing.shrieker', 'murderwing.shrieker.act.shriek', {
      check: (ctx, state, op, params) => {
        if (op.order === 'conceal')
          return { ok: false, reason: 'it cannot perform this action while it has a Conceal order' };
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative' };
        // "If enemy operatives are within control range of this operative, you cannot select an
        //  enemy operative that isn't."
        const engaged = enemiesInControlRange(ctx, state, op);
        if (engaged.length > 0 && !engaged.some((e) => e.id === target.id))
          return { ok: false, reason: 'you cannot select an enemy operative that isn’t within this operative’s control range' };
        // "Select one enemy operative that's visible to and within 6\" of this operative.
        //  Alternatively, select one enemy operative within this operative's BOOST ZONE (at
        //  which point this becomes a BOOST action)."
        if (shriekMode(ctx, state, op, target) === 'normal') return { ok: true };
        if (inBoostZone(ctx, state, op, target)) return boostActionCheck(state, op, ['Reposition', 'Fall Back']);
        return { ok: false, reason: 'that operative is not visible to and within 6" of this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        if (shriekMode(ctx, state, op, target) !== 'normal') markBoostAction(state, op, 'murderwing.shrieker.act.shriek');
        const d3 = ctx.rng.d3();
        recordRoll(state, 'shriek', [d3], op.player, `SHRIEK vs ${target.name}`);
        inflictDamage(ctx, state, target, d3, 'other');
        applyAplPenalty(state, target, op.player, 'murderwing.shrieker.act.shriek');
        log(state, { kind: 'action', player: op.player, text: `${op.name}: SHRIEK — ${target.name} takes ${d3} and −1 APL` });
        return { ok: true };
      },
    }),
  ];
}

/** SHRIEK targets the ordinary 6" way when it can — that leaves the BOOST action slot free. */
function shriekMode(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  target: OperativeState,
): 'normal' | 'boost' | undefined {
  const near = baseGap(op.pos, card(ctx, op).base, op.rot, target.pos, card(ctx, target).base, target.rot) <= 6 + 1e-6;
  if (near && isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible) return 'normal';
  return inBoostZone(ctx, state, op, target) ? 'boost' : undefined;
}

/** "…each other operative visible to and within 2" of this operative" — friend and foe alike. */
function carvingBlowVictims(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  return aliveOperatives(state)
    .filter((o) => o.id !== op.id && !o.incapacitated)
    .filter(
      (o) =>
        baseGap(op.pos, card(ctx, op).base, op.rot, o.pos, card(ctx, o).base, o.rot) <= 2 + 1e-6 &&
        isVisible(index, body(ctx, op), body(ctx, o)).visible,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** "…subtract 1 from its APL stat until the end of its next activation." */
function applyAplPenalty(state: GameState, target: OperativeState, player: PlayerId, sourceId: string): void {
  target.aplMods.push(-1);
  effect(state, {
    rule: 'murderwing.aplPenalty',
    source: { kind: 'ability', id: sourceId },
    operativeId: target.id,
    player,
    expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
  });
}

// ---------------------------------------------------------------------------
// Faction-equipment unique actions
// ---------------------------------------------------------------------------

const murderwingOperative = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);

/** BLADEFINS › "SLICE FROM ABOVE 1AP — BOOST action. Inflict D3+1 damage on one enemy operative
 *  within this operative's BOOST ZONE." */
registerAction({
  id: 'SLICE FROM ABOVE',
  name: 'SLICE FROM ABOVE',
  ap: 1,
  type: 'unique',
  sourceText: text('murderwing.eq.bladefins'),
  available: (ctx, state, op) =>
    murderwingOperative(ctx, op) && hasEquipment(state, op.player, 'murderwing.eq.bladefins'),
  check(ctx, state, op, params) {
    const gate = boostActionCheck(state, op, ['Reposition', 'Fall Back']);
    if (!gate.ok) return gate;
    const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select one enemy operative within this operative’s BOOST ZONE' };
    if (!inBoostZone(ctx, state, op, target))
      return { ok: false, reason: 'that operative is not within this operative’s BOOST ZONE' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const target = state.operatives[params.targetOperativeId!]!;
    markBoostAction(state, op, 'murderwing.eq.bladefins');
    const d3 = ctx.rng.d3();
    recordRoll(state, 'sliceFromAbove', [d3], op.player, 'SLICE FROM ABOVE D3+1');
    inflictDamage(ctx, state, target, d3 + 1, 'other');
    log(state, { kind: 'action', player: op.player, text: `${op.name}: SLICE FROM ABOVE hits ${target.name}` });
    return { ok: true };
  },
});

/** CLAWED ARMOUR › "CLAWED CHARGE 0AP — BOOST action. Inflict 1 damage on one enemy operative
 *  within this operative's control range, then the Charge action ends." */
registerAction({
  id: 'CLAWED CHARGE',
  name: 'CLAWED CHARGE',
  ap: 0,
  type: 'unique',
  sourceText: text('murderwing.eq.clawed-armour'),
  available: (ctx, state, op) =>
    murderwingOperative(ctx, op) && hasEquipment(state, op.player, 'murderwing.eq.clawed-armour'),
  check(ctx, state, op, params) {
    const gate = boostActionCheck(state, op, ['Charge']);
    if (!gate.ok) return gate;
    const engaged = enemiesInControlRange(ctx, state, op);
    if (engaged.length === 0) return { ok: false, reason: 'no enemy operative within control range' };
    const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : engaged[0];
    if (!target || !engaged.some((e) => e.id === target.id))
      return { ok: false, reason: 'select one enemy operative within this operative’s control range' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const engaged = enemiesInControlRange(ctx, state, op);
    const target = (params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined) ?? engaged[0]!;
    markBoostAction(state, op, 'murderwing.eq.clawed-armour');
    inflictDamage(ctx, state, target, 1, 'other');
    log(state, { kind: 'action', player: op.player, text: `${op.name}: CLAWED CHARGE hits ${target.name}` });
    return { ok: true };
  },
});

/** VOX-CASTERS › "VOX-CRY 1AP — Each enemy operative within 3" of this operative takes a stun
 *  test. For an operative to take a stun test, roll one D6: on a 3+, subtract 1 from its APL
 *  stat until the end of its next activation." */
registerAction({
  id: 'VOX-CRY',
  name: 'VOX-CRY',
  ap: 1,
  type: 'unique',
  sourceText: text('murderwing.eq.vox-casters'),
  available: (ctx, state, op) =>
    murderwingOperative(ctx, op) && hasEquipment(state, op.player, 'murderwing.eq.vox-casters'),
  check(ctx, state, op) {
    if (op.order === 'conceal')
      return { ok: false, reason: 'it cannot perform this action while it has a Conceal order' };
    if (voxCryTargets(ctx, state, op).length === 0)
      return { ok: false, reason: 'no enemy operative is within 3" of this operative' };
    return { ok: true };
  },
  perform(ctx, state, op) {
    for (const target of voxCryTargets(ctx, state, op)) {
      const roll = ctx.rng.d6();
      recordRoll(state, 'stunTest', [roll], op.player, `VOX-CRY vs ${target.name}`);
      const ev = ctx.hooks.emit('onStunTest', state, { state, thrower: op, target, roll, damage: 0 });
      if (ev.damage > 0) inflictDamage(ctx, state, target, ev.damage, 'other');
      if (ev.roll < 3) continue;
      applyAplPenalty(state, target, op.player, 'murderwing.eq.vox-casters');
      log(state, { kind: 'action', player: op.player, text: `VOX-CRY stuns ${target.name} (−1 APL)` });
    }
    return { ok: true };
  },
});

function voxCryTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state)
    .filter((o) => o.player !== op.player && !o.incapacitated)
    .filter((o) => baseGap(op.pos, card(ctx, op).base, op.rot, o.pos, card(ctx, o).base, o.rot) <= 3 + 1e-6)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------

export const murderwing = defineTeam({
  id: 'murderwing',
  rules,
  ploys,
  equipment,
  actions,
  gambits,
  ployUsable: {
    // "Use this firefight ploy when it's your turn to activate with a friendly operative, if
    //  only one friendly MURDERWING operative is ready."
    'murderwing.fp.malicious-narcissism': (state, player) => {
      const ready = aliveOperatives(state, player).filter(
        (o) => o.ready && (catalogueCard(o.datacardId)?.keywords ?? []).includes(KW),
      );
      return ready.length === 1
        ? { ok: true }
        : { ok: false, reason: 'only one friendly MURDERWING operative may be ready' };
    },
    // "Use this firefight ploy when an enemy operative ends the Charge, Dash, Fall Back or
    //  Reposition action within 3" horizontally and more than 2" lower than a friendly
    //  MURDERWING operative."
    'murderwing.fp.murderous-descent': (state, player) =>
      descentCandidates(state, player).length > 0
        ? { ok: true }
        : { ok: false, reason: 'no friendly MURDERWING operative is looking down on that enemy operative' },
    // "Use this firefight ploy when a friendly MURDERWING operative is fighting or retaliating,
    //  when you resolve a critical success."
    'murderwing.fp.long-forgotten-honour': (state, player) => {
      const seq = fightSeq(state);
      if (!seq) return { ok: false, reason: 'no fight is in progress' };
      const side =
        state.operatives[seq.attackerId]?.player === player
          ? 'attacker'
          : state.operatives[seq.defenderId]?.player === player
            ? 'defender'
            : undefined;
      if (!side) return { ok: false, reason: 'no friendly operative is in that fight' };
      const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
      return successes(pool).some((d) => d.state === 'crit')
        ? { ok: true }
        : { ok: false, reason: 'you have no unresolved critical success' };
    },
    // "You cannot use this ploy during the first turning point."
    'murderwing.fp.wings-of-darkness': (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
  },
  aiHints: {
    roles: {
      'murderwing.chaos-lord': 'leader',
      'murderwing.champion': 'melee',
      'murderwing.curseclaw': 'melee',
      'murderwing.depredator': 'melee',
      'murderwing.huntmaster': 'melee',
      'murderwing.raptor': 'objective',
      'murderwing.shrieker': 'support',
      'murderwing.skysear': 'gunner',
      'murderwing.warp-talon': 'melee',
    },
    ployValue: {
      'murderwing.sp.predators-above': 0.6,
      'murderwing.sp.cull-the-weak': 0.6,
      'murderwing.sp.nightmare-on-high': 0.4,
      'murderwing.sp.instil-fear': 0.5,
      'murderwing.fp.malicious-narcissism': 0.3,
      'murderwing.fp.murderous-descent': 0.7,
      'murderwing.fp.long-forgotten-honour': 0.5,
      'murderwing.fp.wings-of-darkness': 0.4,
      [CHAOS_CHAMPION_GAMBIT]: 0.5,
    },
    equipmentValue: {
      'murderwing.eq.bladefins': 0.5,
      'murderwing.eq.clawed-armour': 0.5,
      'murderwing.eq.warp-fuel': 0.4,
      'murderwing.eq.vox-casters': 0.6,
    },
  },
});

export default murderwing;
