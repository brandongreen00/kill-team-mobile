/**
 * Infiltration tac op — Track Enemy.
 *
 * "An enemy operative is being tracked if it's a valid target for a friendly operative within
 * 6" of it. That friendly operative must have a Conceal order, cannot be a valid target for
 * the enemy operative it's attempting to track, and cannot be within control range of enemy
 * operatives."
 */
import { aliveOperatives, gapBetween } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  isEngagedWithEnemy,
  isValidTargetFor,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameContext } from '../../context.ts';
import type { GameState, OperativeState, PlayerId } from '../../types.ts';

const ID = 'tac.trackEnemy';
const PER_TP_CAP = 2;

export function trackedEnemies(ctx: GameContext, state: GameState, player: PlayerId): OperativeState[] {
  const watchers = aliveOperatives(state, player).filter(
    (o) => o.order === 'conceal' && !isEngagedWithEnemy(ctx, state, o),
  );
  return aliveOperatives(state, otherPlayer(player)).filter((enemy) =>
    watchers.some(
      (w) =>
        gapBetween(ctx, w, enemy) <= 6 + 1e-6 &&
        isValidTargetFor(ctx, state, w, enemy) &&
        !isValidTargetFor(ctx, state, enemy, w),
    ),
  );
}

export const trackEnemyOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Infiltration',
  name: 'Track Enemy',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const tracked = trackedEnemies(ctx, state, player).length;
    if (tracked === 0) return;
    const want = tracked >= 2 ? 2 : state.turningPoint >= 4 ? 2 : 1;
    const grant = Math.min(want, roomThisTP(state, player, ID, PER_TP_CAP));
    if (grant <= 0) return;
    if (awardVP(ctx, state, player, ID, grant, `Track Enemy: ${tracked} enemy operative(s) being tracked`) > 0)
      revealTacOp(state, player, 'the first time you score VP from this op');
  },
};
