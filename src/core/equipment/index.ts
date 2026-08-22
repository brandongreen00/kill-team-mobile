/**
 * Universal equipment: the registry, the per-item set-up rules, and the SUPPORT-distance seam.
 *
 * Game sequence step 3: "Each player alternates setting up an item of equipment that's set up
 * before the battle (ladders, etc.), starting with the player with initiative. Note: it's item
 * by item, not option by option."
 *
 * `placeEquipment(ctx, state, intent)` is the reducer-facing entry point for the
 * `PlaceEquipment` intent (declared in src/core/intents.ts).
 */
import { terrain, type GameContext, type EquipmentDef } from '../context.ts';
import { basePerimeter, baseGap } from '../geometry.ts';
import { surfaceAt } from '../terrain.ts';
import { log } from '../state.ts';
import type { Intent } from '../intents.ts';
import { otherPlayer } from '../types.ts';
import type { GameState, MarkerState, OperativeState, PlayerId, Poly, Vec2 } from '../types.ts';

import {
  MARKER_MM,
  accessPointParts,
  accessibleParts,
  allPointsWithin,
  allPointsWithinDistance,
  buildEquipmentFeature,
  doorParts,
  inches,
  polyGap,
  rectPoly,
  tallParts,
  type EquipmentItem,
  type EquipmentModule,
  type PlacementConstraint,
} from './kit.ts';
import { ammoCacheEquipment } from './ammoCache.ts';
import { commsDeviceEquipment, minesEquipment, commsDeviceBonus } from './markers.ts';
import {
  heavyBarricadeEquipment,
  laddersEquipment,
  lightBarricadesEquipment,
  razorWireEquipment,
} from './barricades.ts';
import { portableBarricadeEquipment } from './portableBarricade.ts';
import { explosiveGrenadesEquipment, utilityGrenadesEquipment } from './grenades.ts';
import { breachingChargeEquipment } from './breachingCharge.ts';

export * from './kit.ts';
export * from './text.ts';
export { commsDeviceBonus } from './markers.ts';
export {
  selectExplosiveGrenades,
  selectUtilityGrenades,
  grenadesLeft,
  grenadeWeapon,
  grantGrenades,
  GRENADE_WEAPON_NAMES,
} from './grenades.ts';
export { connectedBarricade, portableBarricadeOf, PORTABLE_KIND } from './portableBarricade.ts';
export { breachingChargeUsed } from './breachingCharge.ts';

/** The eleven universal equipment options. */
export const ALL_EQUIPMENT: EquipmentModule[] = [
  ammoCacheEquipment,
  razorWireEquipment,
  commsDeviceEquipment,
  minesEquipment,
  lightBarricadesEquipment,
  heavyBarricadeEquipment,
  laddersEquipment,
  portableBarricadeEquipment,
  utilityGrenadesEquipment,
  explosiveGrenadesEquipment,
  breachingChargeEquipment,
];

export const equipmentById = (id: string): EquipmentModule | undefined => ALL_EQUIPMENT.find((e) => e.id === id);

/** For `makeContext({ equipment: equipmentMap() })`. */
export const equipmentMap = (): Map<string, EquipmentDef> =>
  new Map<string, EquipmentDef>(ALL_EQUIPMENT.map((e) => [e.id, e]));

export const equipmentItems = (equipmentId: string): EquipmentItem[] => equipmentById(equipmentId)?.items ?? [];

/** Every item both players still have to set up before the battle. */
export function pendingEquipmentItems(
  state: GameState,
  player: PlayerId,
): { equipmentId: string; itemIndex: number; item: EquipmentItem }[] {
  const out: { equipmentId: string; itemIndex: number; item: EquipmentItem }[] = [];
  for (const equipmentId of state.teams[player].equipment) {
    equipmentItems(equipmentId).forEach((item, itemIndex) => {
      if (!isItemPlaced(state, player, equipmentId, itemIndex)) out.push({ equipmentId, itemIndex, item });
    });
  }
  return out;
}

/**
 * Whose turn is it to set up a piece of equipment?
 *
 * Approved Ops › SET UP EQUIPMENT: "Starting with the player that has initiative, players
 * alternate setting up their equipment, one piece at a time, until both players have set up
 * all of their equipment." Returns null once neither player has anything left — which is the
 * signal the reducer uses to move on to deployment.
 *
 * `setup.equipmentDone` is how a player says "I have nothing I can or want to set up": some
 * items (a ladder that needs a wall to lean on) can have no legal position on some killzones,
 * and without an out the setup step would be unleaveable.
 */
export function equipmentToAct(state: GameState): PlayerId | null {
  const init = state.initiative ?? 'p1';
  const other = otherPlayer(init);
  const left = (p: PlayerId): number =>
    state.setup.equipmentDone?.[p] ? 0 : pendingEquipmentItems(state, p).length;
  if (left(init) === 0 && left(other) === 0) return null;
  if (left(init) === 0) return other;
  if (left(other) === 0) return init;
  const done = (p: PlayerId): number => state.setup.equipmentPlaced[p] ?? 0;
  return done(init) <= done(other) ? init : other;
}

export const equipmentEntityId = (player: PlayerId, equipmentId: string, itemIndex: number): string =>
  `equip.${player}.${equipmentId}.${itemIndex}`;

export function isItemPlaced(state: GameState, player: PlayerId, equipmentId: string, itemIndex: number): boolean {
  const id = equipmentEntityId(player, equipmentId, itemIndex);
  return !!state.markers[id] || state.placedFeatures.some((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// Set-up legality
// ---------------------------------------------------------------------------

const zoneOf = (state: GameState, player: PlayerId): 'p1' | 'p2' => state.setup.dropZone[player] ?? player;
const territoryOf = (state: GameState, player: PlayerId): Poly[] => state.map.territories[zoneOf(state, player)] ?? [];
const dropZoneOf = (state: GameState, player: PlayerId): Poly[] => state.map.dropZones[zoneOf(state, player)] ?? [];

/**
 * Killzone: Bheta-Decima — "equipment can be set up on Vantage terrain and within 2" of
 * Accessible terrain", the gantries being the whole board.
 */
export const bhetaDecimaException = (state: GameState): boolean => state.map.killzone === 'bheta-decima';

/** The polygon(s) an item occupies at a candidate position. */
export function itemFootprint(item: EquipmentItem, pos: Vec2, rotDeg: number): Poly {
  if (item.kind === 'marker') return basePerimeter(pos, { shape: 'round', mm: MARKER_MM }, 0, 16);
  const fp = item.footprintMm ?? { w: 20, d: 10, h: 10 };
  return rectPoly(pos, inches(fp.w), inches(fp.d), rotDeg);
}

export interface PlacementResult {
  ok: boolean;
  reason?: string;
}

/**
 * Per-item set-up legality. Every option has its own list of constraints — they are NOT the
 * same (the heavy barricade is placed relative to the drop zone, ladders lean on terrain,
 * mines keep away from other markers, ...).
 */
export function validateEquipmentPlacement(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  equipmentId: string,
  itemIndex: number,
  pos: Vec2,
  rotDeg = 0,
): PlacementResult {
  const equipment = equipmentById(equipmentId);
  if (!equipment) return { ok: false, reason: `unknown equipment '${equipmentId}'` };
  if (!state.teams[player].equipment.includes(equipmentId))
    return { ok: false, reason: `${equipment.name} was not selected by ${player}` };
  const items = equipmentItems(equipmentId);
  const item = items[itemIndex];
  if (!item) return { ok: false, reason: `${equipment.name} has no item ${itemIndex}` };
  if (isItemPlaced(state, player, equipmentId, itemIndex))
    return { ok: false, reason: 'that item has already been set up' };

  const poly = itemFootprint(item, pos, rotDeg);
  const index = terrain(ctx, state);
  const selfId = equipmentEntityId(player, equipmentId, itemIndex);

  for (const constraint of item.constraints) {
    const fail = checkConstraint(constraint, { ctx, state, player, poly, pos, index, selfId });
    if (fail) return { ok: false, reason: fail };
  }
  // A base cannot be placed over the edge of the killzone.
  const { w, h } = state.map.board;
  if (poly.some((p) => p.x < -1e-6 || p.y < -1e-6 || p.x > w + 1e-6 || p.y > h + 1e-6))
    return { ok: false, reason: 'equipment must be set up inside the killzone' };
  return { ok: true };
}

interface ConstraintCtx {
  ctx: GameContext;
  state: GameState;
  player: PlayerId;
  poly: Poly;
  pos: Vec2;
  index: ReturnType<typeof terrain>;
  selfId: string;
}

function checkConstraint(constraint: PlacementConstraint, c: ConstraintCtx): string | undefined {
  const { state, player, poly, pos, index, selfId } = c;
  switch (constraint) {
    case 'whollyWithinTerritory':
      return allPointsWithin(poly, territoryOf(state, player))
        ? undefined
        : 'it must be set up wholly within your territory';
    case 'whollyWithin4OfDropZone':
      return allPointsWithinDistance(poly, dropZoneOf(state, player), 4)
        ? undefined
        : 'it must be set up wholly within 4" of your drop zone';
    case 'onKillzoneFloor': {
      if (bhetaDecimaException(state)) return undefined;
      const onFloor = [pos, ...poly].every((p) => surfaceAt(index, p) <= 1e-6);
      return onFloor ? undefined : 'it must be set up on the killzone floor';
    }
    case 'moreThan2FromEquipmentTerrain': {
      for (const feature of state.placedFeatures) {
        if (feature.id === selfId) continue;
        if (feature.parts.some((p) => polyGap(poly, p.poly) <= 2 + 1e-6))
          return 'it must be more than 2" from other equipment terrain features';
      }
      return undefined;
    }
    case 'moreThan2FromAccessPoints':
      return accessPointParts(index).some((p) => polyGap(poly, p.poly) <= 2 + 1e-6)
        ? 'it must be more than 2" from access points'
        : undefined;
    case 'moreThan2FromAccessible':
      if (bhetaDecimaException(state)) return undefined;
      return accessibleParts(index).some((p) => polyGap(poly, p.poly) <= 2 + 1e-6)
        ? 'it must be more than 2" from Accessible terrain'
        : undefined;
    case 'moreThan2FromMarkers': {
      for (const marker of Object.values(state.markers)) {
        if (marker.id === selfId) continue;
        const gap = baseGap(pos, { shape: 'round', mm: MARKER_MM }, 0, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0);
        if (gap <= 2 + 1e-6) return 'it must be more than 2" from other markers';
      }
      return undefined;
    }
    case 'moreThan1FromDoorsAndAccessPoints':
      return [...doorParts(index), ...accessPointParts(index)].some((p) => polyGap(poly, p.poly) <= 1 + 1e-6)
        ? 'it must be more than 1" from doors and access points'
        : undefined;
    case 'uprightAgainstTerrain2Tall':
      return tallParts(index).some((p) => polyGap(poly, p.poly) <= 0.25 + 1e-6)
        ? undefined
        : 'it must be set up upright against terrain that\'s at least 2" tall';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export type PlaceEquipmentIntent = Extract<Intent, { t: 'PlaceEquipment' }>;

/**
 * Apply a `PlaceEquipment` intent. Wire this into the reducer:
 * `case 'PlaceEquipment': { const r = placeEquipment(ctx, next, intent); return r.ok ? ok(next) : fail(r.reason!); }`
 */
export function placeEquipment(
  ctx: GameContext,
  state: GameState,
  intent: PlaceEquipmentIntent,
): PlacementResult {
  const { player, equipmentId, itemIndex, pos } = intent;
  const rotDeg = intent.rotDeg ?? 0;
  const check = validateEquipmentPlacement(ctx, state, player, equipmentId, itemIndex, pos, rotDeg);
  if (!check.ok) return check;
  const item = equipmentItems(equipmentId)[itemIndex]!;
  const id = equipmentEntityId(player, equipmentId, itemIndex);
  const equipment = equipmentById(equipmentId)!;

  if (item.kind === 'marker') {
    const marker: MarkerState = {
      id,
      kind: item.markerKind ?? 'generic',
      diameterMm: MARKER_MM,
      pos: { ...pos },
      z: intent.z ?? 0,
      owner: player,
      flags: {},
    };
    state.markers[id] = marker;
  } else {
    state.placedFeatures.push(
      buildEquipmentFeature({ id, kind: item.featureKind ?? `equipment.${equipmentId}`, owner: player, pos, rotDeg, item }),
    );
  }
  state.setup.equipmentPlaced[player] = (state.setup.equipmentPlaced[player] ?? 0) + 1;
  // The terrain index is keyed by `placedFeatures.length`, which cannot see a feature that was
  // removed and re-added (Move With Barricade), so drop the cache explicitly.
  ctx.terrainCache = undefined as unknown as GameContext['terrainCache'];
  log(state, { kind: 'system', player, text: `${equipment.name} set up (item ${itemIndex + 1})` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// SUPPORT distances (Comms Device)
// ---------------------------------------------------------------------------

/**
 * The distance requirement of a SUPPORT rule that refers to friendly operatives, after
 * equipment: "add 3" to the distance requirements of its SUPPORT rules".
 */
export function supportDistance(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  baseInches: number,
): number {
  const withComms = baseInches + commsDeviceBonus(ctx, state, op);
  return ctx.hooks.emit('onSupportDistance', state, { state, operative: op, inches: withComms }).inches;
}
