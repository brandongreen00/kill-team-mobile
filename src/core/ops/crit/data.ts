/**
 * Crit op 8 — Data.
 *
 * "One objective marker the active operative controls gains 1 Data point. Use a dice as a
 * token to keep track of Data points at that objective marker." / "Remove all Data points from
 * an objective marker the active operative controls."
 */
import { registerAction } from '../../actions.ts';
import { log } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  activeControls,
  awardVP,
  missionActionCheck,
  opScratch,
  registerSharedOpHooks,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'crit.data';

interface DataScratch extends Record<string, unknown> {
  /** player -> compiles performed, indexed by turning point. */
  compiles: Record<string, number[]>;
}

const scratch = (state: GameState): DataScratch =>
  opScratch<DataScratch>(state, ID, () => ({ compiles: { p1: [], p2: [] } }));

export function compilesThisTP(state: GameState, player: PlayerId, tp = state.turningPoint): number {
  return scratch(state).compiles[player]?.[tp] ?? 0;
}

registerAction({
  id: 'Compile Data',
  name: 'Compile Data',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Compile Data').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    if (marker.flags['dataTP'] === state.turningPoint)
      return { ok: false, reason: 'that objective marker has already gained a Data point during this turning point' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.flags['data'] = Number(marker.flags['data'] ?? 0) + 1;
    marker.flags['dataTP'] = state.turningPoint;
    const s = scratch(state);
    const list = s.compiles[op.player] ?? [];
    list[state.turningPoint] = (list[state.turningPoint] ?? 0) + 1;
    s.compiles[op.player] = list;
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.name} compiles data at ${marker.id} (${marker.flags['data']} Data points)`,
    });
    return { ok: true };
  },
});

registerAction({
  id: 'Send Data',
  name: 'Send Data',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Send Data').text,
  available: (_ctx, state) => state.critOpId === ID,
  check(ctx, state, op, params) {
    if (state.turningPoint < 4)
      return { ok: false, reason: 'cannot be performed during the first, second or third turning point' };
    const guard = missionActionCheck(ctx, state, op, { fromTP: 4 });
    if (!guard.ok) return guard;
    const marker = targetObjective(state, params.markerId);
    if (!marker) return { ok: false, reason: 'select an objective marker' };
    if (!activeControls(ctx, state, op, marker))
      return { ok: false, reason: 'the active operative does not control that objective marker' };
    if (Number(marker.flags['data'] ?? 0) <= 0)
      return { ok: false, reason: "that objective marker doesn't have any Data points to remove" };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    const points = Number(marker.flags['data'] ?? 0);
    marker.flags['data'] = 0;
    log(state, { kind: 'action', player: op.player, text: `${op.name} sends ${points} Data point(s) from ${marker.id}` });
    awardVP(ctx, state, op.player, ID, points, `Send Data (${points} Data points)`);
    return { ok: true };
  },
});

export const dataOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Data',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    // "At the end of the second and third turning point..."
    if (state.turningPoint !== 2 && state.turningPoint !== 3) return;
    const mine = compilesThisTP(state, player);
    const theirs = compilesThisTP(state, otherPlayer(player));
    if (mine > theirs)
      awardVP(ctx, state, player, ID, 1, `Data: ${mine} Compile Data actions vs ${theirs}`);
  },
};
