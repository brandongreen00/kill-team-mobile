/**
 * Crit op 1 — Secure.
 *
 * "One objective marker the active operative controls is secured by your kill team until the
 * enemy kill team secures that objective marker."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
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

const ID = 'crit.secure';

registerAction({
  id: 'Secure',
  name: 'Secure',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Secure').text,
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
    marker.flags['secured'] = op.player;
    log(state, { kind: 'action', player: op.player, text: `${op.name} secures ${marker.id}` });
    return { ok: true };
  },
});

export const secureOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Secure',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const secured = objectiveMarkers(state).filter((m) => m.flags['secured'] === player).length;
    const enemy = objectiveMarkers(state).filter((m) => m.flags['secured'] === otherPlayer(player)).length;
    if (secured > 0) awardVP(ctx, state, player, ID, 1, 'Secure: objective markers secured');
    if (secured > enemy) awardVP(ctx, state, player, ID, 1, 'Secure: more markers secured than the enemy');
  },
};
