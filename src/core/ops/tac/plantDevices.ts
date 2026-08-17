/**
 * Infiltration tac op — Plant Devices.
 *
 * "One objective marker the active operative controls gains one of your Device tokens."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  activeControls,
  awardVP,
  contestedByPlayer,
  missionActionCheck,
  objectiveMarkers,
  objectiveOwner,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';

const ID = 'tac.plantDevices';
const PER_TP_CAP = 2;
const flag = (player: string): string => `device:${player}`;

registerAction({
  id: 'Plant Device',
  name: 'Plant Device',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Plant Device').text,
  available: (_ctx, state, op) => state.teams[op.player].tacOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    if (marker.flags[flag(op.player)])
      return { ok: false, reason: 'that objective marker already has one of your Device tokens' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.flags[flag(op.player)] = true;
    revealTacOp(state, op.player, 'a friendly operative performed the Plant Device action');
    log(state, { kind: 'action', player: op.player, text: `${op.letter} plants a Device token on ${marker.id}` });
    return { ok: true };
  },
});

export const plantDevicesOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Infiltration',
  name: 'Plant Devices',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const enemy = otherPlayer(player);
    let vp = 0;
    for (const marker of objectiveMarkers(state)) {
      if (!marker.flags[flag(player)]) continue;
      if (objectiveOwner(state, marker) === enemy) vp += 1;
      else if (contestedByPlayer(ctx, state, marker, enemy)) vp += 1;
    }
    const grant = Math.min(vp, roomThisTP(state, player, ID, PER_TP_CAP));
    if (grant > 0) awardVP(ctx, state, player, ID, grant, 'Plant Devices');
  },
};
