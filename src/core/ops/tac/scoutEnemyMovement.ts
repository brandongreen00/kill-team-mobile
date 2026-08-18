/**
 * Recon tac op — Scout Enemy Movement.
 *
 * "Select one ready enemy operative visible to and more than 6" from the active operative.
 * That enemy operative is now monitored until the Ready step of the next Strategy phase."
 */
import { registerAction } from '../../actions.ts';
import { terrain } from '../../context.ts';
import { aliveOperatives, body, gapBetween, log } from '../../state.ts';
import { isVisible } from '../../visibility.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  isEngagedWithEnemy,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'tac.scoutEnemyMovement';
const PER_TP_CAP = 2;

interface ScoutScratch extends Record<string, unknown> {
  /** operative id -> the turning point it is monitored in. */
  monitored: Record<string, number>;
}

const scratch = (state: GameState): ScoutScratch =>
  opScratch<ScoutScratch>(state, ID, () => ({ monitored: {} }));

export const isMonitored = (state: GameState, operativeId: string): boolean =>
  scratch(state).monitored[operativeId] === state.turningPoint;

registerAction({
  id: 'Scout',
  name: 'Scout',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Scout').text,
  available: (_ctx, state, op) => state.teams[op.player].tacOpId === ID,
  check(ctx, state, op, params) {
    if (op.order === 'engage') return { ok: false, reason: 'cannot perform this action with an Engage order' };
    if (state.turningPoint < 2) return { ok: false, reason: 'cannot be performed during the first turning point' };
    if (isEngagedWithEnemy(ctx, state, op))
      return { ok: false, reason: 'within control range of an enemy operative' };
    const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select an enemy operative' };
    if (!target.ready) return { ok: false, reason: 'that enemy operative is not ready' };
    if (gapBetween(ctx, op, target) <= 6)
      return { ok: false, reason: 'the enemy operative must be more than 6" from the active operative' };
    if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
      return { ok: false, reason: 'that enemy operative is not visible' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const target = state.operatives[params.targetOperativeId!]!;
    scratch(state).monitored[target.id] = state.turningPoint;
    revealTacOp(state, op.player, 'a friendly operative performed the Scout action');
    log(state, { kind: 'action', player: op.player, text: `${op.name} scouts ${target.name} (monitored)` });
    return { ok: true };
  },
});

export const scoutEnemyMovementOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Recon',
  name: 'Scout Enemy Movement',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const index = terrain(ctx, state);
    const friends = aliveOperatives(state, player);
    const seen = aliveOperatives(state, otherPlayer(player)).filter(
      (enemy) =>
        isMonitored(state, enemy.id) &&
        friends.some((f) => isVisible(index, body(ctx, f), body(ctx, enemy)).visible),
    ).length;
    const grant = Math.min(seen, roomThisTP(state, player, ID, PER_TP_CAP));
    if (grant > 0)
      awardVP(ctx, state, player, ID, grant, `Scout Enemy Movement: ${seen} monitored operative(s) visible`);
  },
};

export function monitoredIds(state: GameState, player: PlayerId): string[] {
  void player;
  return Object.entries(scratch(state).monitored)
    .filter(([, tp]) => tp === state.turningPoint)
    .map(([id]) => id);
}
