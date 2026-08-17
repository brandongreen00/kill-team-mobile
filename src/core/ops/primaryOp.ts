/**
 * The primary op.
 *
 * "As a STRATEGIC GAMBIT in the first turning point, each player secretly selects one of their
 * three ops (1.crit, 2.kill or 3.tac) to be their primary op... At the end of the battle, the
 * players reveal their primary ops simultaneously. They score additional VP equal to half of
 * what they scored from that op (rounding up)."
 *
 * The bonus is recorded under its own id so the source op's 6VP cap does not swallow it.
 */
import { log } from '../state.ts';
import { END_OF_BATTLE_SLOT, awardVP, primaryOpChoices, vpFromOp } from './common.ts';
import type { GameContext } from '../context.ts';
import type { GameState, PendingDecision, PlayerId } from '../types.ts';

export const PRIMARY_BONUS_ID = 'primary';

export function selectPrimaryOp(state: GameState, player: PlayerId, opId: string): boolean {
  if (!primaryOpChoices(state, player).includes(opId)) return false;
  state.teams[player].primaryOpId = opId;
  log(state, { kind: 'system', player, text: 'Primary op selected (secret)' });
  return true;
}

export function resolvePrimaryOpDecision(
  state: GameState,
  decision: PendingDecision,
  optionId: string,
): boolean {
  if (decision.kind !== 'primaryOp') return false;
  return selectPrimaryOp(state, decision.who, optionId);
}

/** "score additional VP equal to half of what they scored from that op (rounding up)". */
export function scorePrimaryOp(ctx: GameContext, state: GameState, player: PlayerId): number {
  const opId = state.teams[player].primaryOpId;
  if (!opId) return 0;
  const scored = vpFromOp(state, player, opId);
  const bonus = Math.ceil(scored / 2);
  if (bonus <= 0) return 0;
  return awardVP(
    ctx,
    state,
    player,
    PRIMARY_BONUS_ID,
    bonus,
    `Primary op ${opId} scored ${scored}VP — half, rounding up`,
    END_OF_BATTLE_SLOT,
  );
}
