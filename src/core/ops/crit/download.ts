/**
 * Crit op 7 — Download.
 *
 * "One centre or opponent's objective marker the active operative controls is downloaded."
 * "At the end of each turning point after the first, if friendly operatives control more
 * objective markers than enemy operatives do, you score 1VP. Ignore downloaded objective
 * markers when determining this."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  activeControls,
  awardVP,
  controlledObjectives,
  missionActionCheck,
  objectiveOwner,
  registerSharedOpHooks,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';

const ID = 'crit.download';

registerAction({
  id: 'Download',
  name: 'Download',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Download').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op, { fromTP: 3 });
    if (!guard.ok) return guard;
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    const owner = objectiveOwner(state, marker);
    if (owner === op.player) return { ok: false, reason: "only a centre or opponent's objective marker can be downloaded" };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    if (marker.flags['downloaded'])
      return { ok: false, reason: 'that objective marker has already been downloaded during the battle' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.flags['downloaded'] = true;
    marker.flags['downloadedBy'] = op.player;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} downloads ${marker.id}` });
    const vp = state.turningPoint >= 4 ? 2 : 1;
    awardVP(ctx, state, op.player, ID, vp, `Download in turning point ${state.turningPoint}`);
    return { ok: true };
  },
});

export const downloadOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Download',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const live = (m: { flags: Record<string, string | number | boolean> }) => m.flags['downloaded'] !== true;
    const mine = controlledObjectives(ctx, state, player, live).length;
    const theirs = controlledObjectives(ctx, state, otherPlayer(player), live).length;
    if (mine > theirs)
      awardVP(ctx, state, player, ID, 1, 'Download: controlling more (not downloaded) objective markers');
  },
};
