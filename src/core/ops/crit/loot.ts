/**
 * Crit op 2 — Loot.
 *
 * "Whenever a friendly operative performs the Loot action, you score 1VP (to a maximum of 2VP
 * per turning point)."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import {
  activeControls,
  awardVP,
  missionActionCheck,
  registerSharedOpHooks,
  roomThisTP,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';

const ID = 'crit.loot';
const PER_TP_CAP = 2;

registerAction({
  id: 'Loot',
  name: 'Loot',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Loot').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    if (marker.flags['lootedTP'] === state.turningPoint)
      return { ok: false, reason: 'that objective marker has already been looted during this turning point' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.flags['lootedTP'] = state.turningPoint;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} loots ${marker.id}` });
    awardVP(ctx, state, op.player, ID, Math.min(1, roomThisTP(state, op.player, ID, PER_TP_CAP)), 'Loot');
    return { ok: true };
  },
});

export const lootOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Loot',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
};
