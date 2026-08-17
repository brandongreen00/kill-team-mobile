/**
 * The kill op — every player scores from it, so it is not selected.
 *
 * "You start without a kill grade. As enemy operatives are incapacitated, your kill grade goes
 * up until it reaches 5. Whenever you move to a new kill grade, you score 1VP. At the end of
 * the battle, if your kill grade is higher than your opponent's, you score 1VP."
 *
 * Grades are recomputed at the end of each turning point from the operatives that have been
 * incapacitated. That cannot change any total (each new grade is worth exactly 1VP and the
 * op's 6VP cap is never reached before grade 5 + the end-of-battle point), it only moves the
 * log line to the end of the turning point.
 */
import { END_OF_BATTLE_SLOT, awardVP, ignoredForKillOp, killOpStartingSize, KILL_OP_ID } from './common.ts';
import { killGradeFor } from './killGrade.ts';
import { KILL_OP_TEXT } from './text.ts';
import type { GameContext } from '../context.ts';
import type { OpModule } from './common.ts';
import type { GameState, PlayerId } from '../types.ts';
import { otherPlayer } from '../types.ts';

/** Enemy operatives incapacitated so far, ignoring those "ignored for the kill op". */
export function incapacitatedEnemies(ctx: GameContext, state: GameState, player: PlayerId): number {
  const enemy = otherPlayer(player);
  return state.teams[enemy].operativeIds.filter((id) => {
    const op = state.operatives[id];
    if (!op || (!op.removed && !op.incapacitated)) return false;
    return !ignoredForKillOp(ctx, state, op);
  }).length;
}

export function updateKillGrade(ctx: GameContext, state: GameState, player: PlayerId): void {
  const startingSize = killOpStartingSize(ctx, state, otherPlayer(player));
  const grade = killGradeFor(startingSize, incapacitatedEnemies(ctx, state, player));
  const team = state.teams[player];
  while (team.killGrade < grade) {
    team.killGrade += 1;
    awardVP(ctx, state, player, KILL_OP_ID, 1, `Kill op: reached kill grade ${team.killGrade}`);
  }
}

export const killOp: OpModule = {
  id: KILL_OP_ID,
  kind: 'kill',
  name: KILL_OP_TEXT.name,
  text: KILL_OP_TEXT.text,
  scoreEndOfTP(ctx, state, player) {
    updateKillGrade(ctx, state, player);
  },
  scoreEndOfBattle(ctx, state, player) {
    updateKillGrade(ctx, state, player);
    if (state.teams[player].killGrade > state.teams[otherPlayer(player)].killGrade)
      awardVP(
        ctx,
        state,
        player,
        KILL_OP_ID,
        1,
        `Kill op: kill grade ${state.teams[player].killGrade} beats ${state.teams[otherPlayer(player)].killGrade}`,
        END_OF_BATTLE_SLOT,
      );
  },
};
