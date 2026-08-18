/**
 * Crit op 4 — Orb.
 *
 * "At the start of the battle, the centre objective marker has the Orb token."
 * "At the end of each turning point after the first, for each objective marker that friendly
 * operatives control that doesn't have the Orb token, you score 1VP."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import {
  activeControls,
  awardVP,
  controlledObjectives,
  missionActionCheck,
  objectiveMarkers,
  objectiveSide,
  registerSharedOpHooks,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameState, MarkerState } from '../../types.ts';

const ID = 'crit.orb';

export const orbMarker = (state: GameState): MarkerState | undefined =>
  objectiveMarkers(state).find((m) => m.flags['orb'] === true);

registerAction({
  id: 'Move Orb',
  name: 'Move Orb',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Move Orb').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    const orb = orbMarker(state);
    if (!orb) return { ok: false, reason: 'the Orb token is not on an objective marker' };
    if (!activeControls(ctx, state, op, orb))
      return { ok: false, reason: "it doesn't control the objective marker that has the Orb token" };
    if (objectiveSide(state, orb) === 'centre') {
      // "move it to either player's objective marker (your choice)"
      const dest = params.choice ? state.markers[params.choice] : undefined;
      if (!dest || dest.kind !== 'objective' || objectiveSide(state, dest) === 'centre')
        return { ok: false, reason: "select a player's objective marker to move the Orb token to" };
    }
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const orb = orbMarker(state)!;
    const dest =
      objectiveSide(state, orb) === 'centre'
        ? state.markers[params.choice!]!
        : objectiveMarkers(state).find((m) => objectiveSide(state, m) === 'centre');
    if (!dest) return { ok: false, reason: 'there is no centre objective marker to move the Orb token to' };
    delete orb.flags['orb'];
    dest.flags['orb'] = true;
    log(state, { kind: 'action', player: op.player, text: `${op.name} moves the Orb token to ${dest.id}` });
    return { ok: true };
  },
});

export const orbOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Orb',
  text: opText(ID),
  init(_ctx, state) {
    const centre = objectiveMarkers(state).find((m) => objectiveSide(state, m) === 'centre');
    if (centre) centre.flags['orb'] = true;
  },
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const held = controlledObjectives(ctx, state, player, (m) => m.flags['orb'] !== true).length;
    if (held > 0) awardVP(ctx, state, player, ID, held, `Orb: ${held} controlled marker(s) without the Orb token`);
  },
};
