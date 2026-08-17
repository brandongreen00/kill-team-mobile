/**
 * Crit op 6 — Energy Cells.
 *
 * "Operatives can perform the Pick Up Marker action upon each objective marker in the
 * following turning points: 2, but you must spend an additional 2AP (that action cannot be
 * free and its AP cannot be reduced). 3, but you must spend an additional 1AP... 4 (as
 * normal). Whenever an operative is carrying an objective marker, that operative cannot be
 * removed and set up again more than 6" away."
 */
import { dist } from '../../geometry.ts';
import { otherPlayer } from '../../types.ts';
import {
  END_OF_BATTLE_SLOT,
  awardVP,
  binding,
  controlledObjectives,
  objectiveMarkers,
  registerSharedOpHooks,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameState, MarkerState } from '../../types.ts';

const ID = 'crit.energyCells';

/** Additional AP for the Pick Up Marker action, by turning point. */
export const energyCellSurcharge = (tp: number): number => (tp === 2 ? 2 : tp === 3 ? 1 : 0);

/**
 * The hook that prices the action does not know which marker is being picked up, so the
 * surcharge is applied when the nearest pick-up-able marker is an objective marker
 * (documented in docs/OPS.md).
 */
function nearestPickUpMarker(state: GameState, pos: { x: number; y: number }): MarkerState | undefined {
  let best: MarkerState | undefined;
  let bestD = Infinity;
  for (const m of Object.values(state.markers)) {
    if (!m.flags['pickUpAllowed'] || m.carriedBy) continue;
    const d = dist(pos, m.pos);
    if (d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

export const energyCellsOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Energy Cells',
  text: opText(ID),
  init(_ctx, state) {
    // Not until the second turning point.
    for (const m of objectiveMarkers(state)) m.flags['pickUpAllowed'] = false;
  },
  register(reg, player) {
    registerSharedOpHooks(reg, player);
    reg.on('onReadyStep', binding(`${ID}.enable`, opText(ID), player, 10), (ev, b) => {
      if (b.player !== ev.player) return;
      for (const m of objectiveMarkers(ev.state)) m.flags['pickUpAllowed'] = ev.state.turningPoint >= 2;
    });
    reg.on('onActionCost', binding(`${ID}.cost`, opText(ID), player, 90), (ev, b) => {
      if (b.player !== ev.operative.player) return;
      if (ev.action !== 'Pick Up Marker') return;
      const tp = ev.state.turningPoint;
      if (tp < 2) return;
      const nearest = nearestPickUpMarker(ev.state, ev.operative.pos);
      if (!nearest || nearest.kind !== 'objective') return;
      // "that action cannot be free and its AP cannot be reduced"
      ev.ap = Math.max(1, ev.ap) + energyCellSurcharge(tp);
    });
    reg.on('onSetUpAgain', binding(`${ID}.setUp`, opText(ID), player, 10), (ev, b) => {
      if (b.player !== ev.operative.player) return;
      const carried = ev.operative.carryingMarkerId
        ? ev.state.markers[ev.operative.carryingMarkerId]
        : undefined;
      if (!carried || carried.kind !== 'objective') return;
      if (ev.maxInches > 6) {
        ev.maxInches = 6;
        ev.reason = 'an operative carrying an objective marker cannot be set up again more than 6" away';
      }
    });
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const mine = controlledObjectives(ctx, state, player).length;
    const theirs = controlledObjectives(ctx, state, otherPlayer(player)).length;
    if (mine > theirs) awardVP(ctx, state, player, ID, 1, 'Energy Cells: controlling more objective markers');
  },
  scoreEndOfBattle(ctx, state, player) {
    const carried = objectiveMarkers(state).filter((m) => {
      const carrier = m.carriedBy ? state.operatives[m.carriedBy] : undefined;
      return carrier && !carrier.removed && carrier.player === player;
    }).length;
    if (carried > 0)
      awardVP(
        ctx,
        state,
        player,
        ID,
        carried,
        `Energy Cells: carrying ${carried} objective marker(s) at the end of the battle`,
        END_OF_BATTLE_SLOT,
      );
  },
};
