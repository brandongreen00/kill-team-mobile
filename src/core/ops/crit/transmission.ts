/**
 * Crit op 3 — Transmission.
 *
 * "One objective marker the active operative controls is transmitting until the start of the
 * next turning point."
 */
import { registerAction } from '../../actions.ts';
import { log, markerController } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  activeControls,
  awardVP,
  missionActionCheck,
  objectiveMarkers,
  registerSharedOpHooks,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';

const ID = 'crit.transmission';

registerAction({
  id: 'Initiate Transmission',
  name: 'Initiate Transmission',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Initiate Transmission').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    // "transmitting until the start of the next turning point"
    marker.flags['transmittingTP'] = state.turningPoint;
    log(state, { kind: 'action', player: op.player, text: `${op.name} initiates transmission at ${marker.id}` });
    return { ok: true };
  },
});

export const transmissionOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Transmission',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const transmitting = objectiveMarkers(state).filter((m) => m.flags['transmittingTP'] === state.turningPoint);
    const mine = transmitting.filter((m) => markerController(ctx, state, m) === player).length;
    const theirs = transmitting.filter((m) => markerController(ctx, state, m) === otherPlayer(player)).length;
    if (mine > 0) awardVP(ctx, state, player, ID, 1, 'Transmission: controlling a transmitting marker');
    if (mine > theirs)
      awardVP(ctx, state, player, ID, 1, 'Transmission: controlling more transmitting markers');
  },
};
