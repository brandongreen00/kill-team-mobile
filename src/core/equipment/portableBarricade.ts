/**
 * 1X PORTABLE BARRICADE.
 *
 * "A portable barricade is Light, Protective and Portable terrain, except the feet which are
 * Insignificant and Exposed... Protective: While an operative is in cover from this terrain
 * feature, improve its Save stat by 1 (to a maximum of 2+). Portable: This terrain feature only
 * provides cover while an operative is connected to it and if the shield is intervening."
 *
 * MOVE WITH BARRICADE 1AP: "The same as the Reposition action, except the active operative can
 * move no more than its Move stat minus 2" and cannot climb, drop, jump... Before this operative
 * moves, remove the portable barricade it's connected to. After it moves, set up the portable
 * barricade so it's connected again, but [not] within 2" of other equipment terrain features,
 * access points or Accessible terrain. If this is not possible, the portable barricade is not
 * set up again."
 */
import { getAction, registerAction } from '../actions.ts';
import { terrain, type GameContext } from '../context.ts';
import { baseGapToPoly, polyCentroid, sub, dot } from '../geometry.ts';
import { validateMove } from '../movement.ts';
import { card, enemiesInControlRange, log } from '../state.ts';
import { accessPointParts, accessibleParts, buildEquipmentFeature, polyGap } from './kit.ts';
import { equipmentText } from './text.ts';
import type { EquipmentItem, EquipmentModule } from './kit.ts';
import type { GameState, OperativeState, Poly, TerrainFeature } from '../types.ts';

export const PORTABLE_ID = 'eq.portableBarricade';
export const PORTABLE_KIND = 'equipment.portableBarricade';

/** How close a base must be to the shield to count as connected to it. */
export const CONNECTED_INCHES = 0.25;

const item: EquipmentItem = {
  kind: 'terrain',
  featureKind: PORTABLE_KIND,
  footprintMm: { w: 20, d: 10, h: 40 },
  types: ['Light', 'Protective', 'Portable'],
  feet: true,
  constraints: [
    'whollyWithinTerritory',
    'onKillzoneFloor',
    'moreThan2FromEquipmentTerrain',
    'moreThan2FromAccessPoints',
    'moreThan2FromAccessible',
  ],
};

export const shieldPoly = (feature: TerrainFeature): Poly =>
  (feature.parts.find((p) => p.id.endsWith('.body')) ?? feature.parts[0]!).poly;

export function portableBarricadeOf(state: GameState, owner: string): TerrainFeature | undefined {
  return state.placedFeatures.find((f) => f.kind === PORTABLE_KIND && f.owner === owner);
}

/** "Operatives connected to the inside of it" — modelled as the base touching the shield. */
export function connectedBarricade(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
): TerrainFeature | undefined {
  return state.placedFeatures.find(
    (f) =>
      f.kind === PORTABLE_KIND &&
      baseGapToPoly(op.pos, card(ctx, op).base, op.rot, shieldPoly(f)) <= CONNECTED_INCHES + 1e-6,
  );
}

/** The re-placement rule after a Move With Barricade. */
export function barricadeSpotIsLegal(ctx: GameContext, state: GameState, poly: Poly, ownFeatureId: string): boolean {
  const index = terrain(ctx, state);
  for (const other of state.placedFeatures) {
    if (other.id === ownFeatureId) continue;
    if (other.parts.some((p) => polyGap(poly, p.poly) <= 2 + 1e-6)) return false;
  }
  for (const part of [...accessPointParts(index), ...accessibleParts(index)]) {
    if (polyGap(poly, part.poly) <= 2 + 1e-6) return false;
  }
  return true;
}

registerAction({
  id: 'Move With Barricade',
  name: 'Move With Barricade',
  ap: 1,
  type: 'unique',
  treatedAs: 'Reposition',
  sourceText: equipmentText(PORTABLE_ID),
  available: (ctx, state, op) =>
    state.teams[op.player].equipment.includes(PORTABLE_ID) && !!connectedBarricade(ctx, state, op),
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.actionsThisActivation.includes('Fall Back') || op.actionsThisActivation.includes('Charge'))
      return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
    if (!connectedBarricade(ctx, state, op))
      return { ok: false, reason: 'the operative is not connected to a portable barricade' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Move With Barricade',
      noClimb: true,
      mustNotFinishEngaged: true,
    });
    if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
    if (v.legs.some((l) => l.kind === 'drop' || l.kind === 'jump'))
      return { ok: false, reason: 'cannot climb, drop or jump while moving with the barricade' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const feature = connectedBarricade(ctx, state, op)!;
    const offset = { x: feature.placement.x - op.pos.x, y: feature.placement.y - op.pos.y };
    const rotDeg = feature.placement.rotDeg;
    const owner = feature.owner!;
    const id = feature.id;
    // "Before this operative moves, remove the portable barricade it's connected to."
    state.placedFeatures = state.placedFeatures.filter((f) => f.id !== id);
    const reposition = getAction('Reposition');
    if (!reposition) return { ok: false, reason: 'the Reposition action is not registered' };
    const moved = reposition.perform(ctx, state, op, params);
    if (!moved.ok) return moved;
    const pos = { x: op.pos.x + offset.x, y: op.pos.y + offset.y };
    const rebuilt = buildEquipmentFeature({ id, kind: PORTABLE_KIND, owner, pos, rotDeg, item });
    if (barricadeSpotIsLegal(ctx, state, shieldPoly(rebuilt), id)) {
      state.placedFeatures.push(rebuilt);
      log(state, { kind: 'action', player: op.player, text: `${op.letter} moves with the portable barricade` });
    } else {
      log(state, {
        kind: 'action',
        player: op.player,
        text: 'The portable barricade cannot be set up again and is removed',
      });
    }
    return { ok: true };
  },
});

export const portableBarricadeEquipment: EquipmentModule = {
  id: PORTABLE_ID,
  name: 'Portable Barricade',
  scope: 'universal',
  text: equipmentText(PORTABLE_ID),
  items: [item],
  register(reg, player) {
    reg.on(
      'onDefenceDice',
      { id: `${PORTABLE_ID}.protective`, sourceText: equipmentText(PORTABLE_ID), player, priority: 30 },
      (ev, b) => {
        const target = ev.ctx?.defender;
        if (!target || !ev.ctx.inCover) return;
        const feature = ev.state.placedFeatures.find((f) => f.kind === PORTABLE_KIND && f.owner === b.player);
        if (!feature) return;
        const poly = shieldPoly(feature);
        // Connected (approximated from the base centre, since the hook has no datacards) and
        // the shield is on the attacker's side of the operative.
        const centroid = polyCentroid(poly);
        const toShield = sub(centroid, target.pos);
        if (Math.hypot(toShield.x, toShield.y) > 1.5) return;
        if (dot(toShield, sub(ev.ctx.attacker.pos, target.pos)) <= 0) return;
        // "improve its Save stat by 1 (to a maximum of 2+)" — the save is clamped at 2 already.
        ev.mods.save += 1;
      },
    );
  },
};
