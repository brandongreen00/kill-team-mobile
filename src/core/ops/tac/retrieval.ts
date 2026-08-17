/**
 * Recon tac op — Retrieval.
 *
 * "If the active operative controls an objective marker that hasn't been searched by friendly
 * operatives, that operative is now carrying one of your Retrieval mission markers and that
 * objective marker has been searched by friendly operatives."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import {
  END_OF_BATTLE_SLOT,
  activeControls,
  awardVP,
  missionActionCheck,
  registerSharedOpHooks,
  revealTacOp,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameState, MarkerState, PlayerId } from '../../types.ts';

const ID = 'tac.retrieval';
const searchedFlag = (player: string): string => `searched:${player}`;

export const retrievalMarkers = (state: GameState, player: PlayerId): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.kind === 'retrieval' && m.owner === player);

export const carriedRetrieval = (state: GameState, player: PlayerId): MarkerState[] =>
  retrievalMarkers(state, player).filter((m) => {
    const carrier = m.carriedBy ? state.operatives[m.carriedBy] : undefined;
    return !!carrier && !carrier.removed && carrier.player === player;
  });

registerAction({
  id: 'Retrieve',
  name: 'Retrieve',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Retrieve').text,
  available: (_ctx, state, op) => state.teams[op.player].tacOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    if (marker.flags[searchedFlag(op.player)])
      return { ok: false, reason: 'that objective marker has already been searched by friendly operatives' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.flags[searchedFlag(op.player)] = true;
    const id = `retrieval-${state.seq++}`;
    state.markers[id] = {
      id,
      kind: 'retrieval',
      diameterMm: 20,
      pos: { ...op.pos },
      z: op.z,
      owner: op.player,
      carriedBy: op.id,
      flags: { pickUpAllowed: true },
    };
    op.carryingMarkerId = id;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} retrieves from ${marker.id}` });
    // "The first time each objective marker is searched by friendly operatives, you score 1VP."
    if (awardVP(ctx, state, op.player, ID, 1, `Retrieval: ${marker.id} searched`) > 0)
      revealTacOp(state, op.player, 'the first time you score VP from this op');
    return { ok: true };
  },
});

export const retrievalOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Recon',
  name: 'Retrieval',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfBattle(ctx, state, player) {
    const n = carriedRetrieval(state, player).length;
    if (n > 0)
      awardVP(ctx, state, player, ID, n, `Retrieval: carrying ${n} Retrieval marker(s)`, END_OF_BATTLE_SLOT);
  },
};
