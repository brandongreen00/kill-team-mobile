/**
 * Seek & Destroy tac op — Sweep & Clear.
 *
 * "When an enemy operative that contests an objective marker is incapacitated, that objective
 * marker gains one of your Swept tokens (if it doesn't already have one) until the Ready step
 * of the next Strategy phase." / Clear 1AP: "An objective marker the active operative controls
 * is cleared for the turning point."
 */
import { registerAction } from '../../actions.ts';
import { log, markerContestedBy, markerController } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  activeControls,
  awardVP,
  contestedByPlayer,
  killRecords,
  missionActionCheck,
  objectiveMarkers,
  objectiveOwner,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  targetObjective,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameContext } from '../../context.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'tac.sweepAndClear';
const PER_TP_CAP = 2;
const sweptFlag = (player: string): string => `swept:${player}`;
const clearedFlag = (player: string): string => `cleared:${player}`;

interface SweepScratch extends Record<string, unknown> {
  processed: string[];
}

const scratch = (state: GameState): SweepScratch => opScratch<SweepScratch>(state, ID, () => ({ processed: [] }));

registerAction({
  id: 'Clear',
  name: 'Clear',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Clear').text,
  available: (_ctx, state, op) => state.teams[op.player].tacOpId === ID,
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
    marker.flags[clearedFlag(op.player)] = state.turningPoint;
    revealTacOp(state, op.player, 'a friendly operative performed the Clear action');
    log(state, { kind: 'action', player: op.player, text: `${op.letter} clears ${marker.id}` });
    return { ok: true };
  },
});

/** Swept tokens from this turning point's kills. */
function collectSwept(ctx: GameContext, state: GameState, player: PlayerId): void {
  const s = scratch(state);
  for (const rec of killRecords(state)) {
    if (s.processed.includes(rec.key)) continue;
    s.processed.push(rec.key);
    if (rec.victimPlayer === player) continue;
    const victim = state.operatives[rec.victimId];
    if (!victim) continue;
    const marker = objectiveMarkers(state).find((m) => markerContestedBy(ctx, state, m, victim));
    if (!marker) continue;
    marker.flags[sweptFlag(player)] = rec.tp;
    revealTacOp(state, player, 'an enemy operative was incapacitated while contesting an objective marker');
  }
}

export const sweepAndClearOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Seek & Destroy',
  name: 'Sweep & Clear',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    collectSwept(ctx, state, player);
    if (state.turningPoint < 2) return;
    const enemy = otherPlayer(player);
    const swept = (id: string): boolean => state.markers[id]?.flags[sweptFlag(player)] === state.turningPoint;
    let vp = 0;
    // "if at least one objective marker (excluding your objective marker) is cleared and enemy
    // operatives do not contest that marker, you score 1VP. If that marker also has one of your
    // Swept tokens, you score 2VP instead."
    const cleared = objectiveMarkers(state).filter(
      (m) =>
        objectiveOwner(state, m) !== player &&
        m.flags[clearedFlag(player)] === state.turningPoint &&
        !contestedByPlayer(ctx, state, m, enemy),
    );
    if (cleared.length > 0) vp += cleared.some((m) => swept(m.id)) ? 2 : 1;
    // "If friendly operatives control an objective marker that has one of your Swept tokens..."
    if (objectiveMarkers(state).some((m) => swept(m.id) && markerController(ctx, state, m) === player)) vp += 1;
    const grant = Math.min(vp, roomThisTP(state, player, ID, PER_TP_CAP));
    if (grant > 0) awardVP(ctx, state, player, ID, grant, 'Sweep & Clear');
  },
};
