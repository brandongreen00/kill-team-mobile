/**
 * Seek & Destroy tac op — Dominate.
 *
 * "Each time a friendly operative incapacitates an enemy operative, that friendly operative
 * gains one of your Dominate tokens or two of your Dominate tokens if that enemy operative had
 * a Wounds stat of 12 or more."
 * "At the end of the third and fourth turning point, you can remove Dominate tokens from
 * friendly operatives that aren't incapacitated. For each you remove, you score 1VP."
 */
import { card } from '../../state.ts';
import {
  awardVP,
  killRecords,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameContext } from '../../context.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'tac.dominate';
const PER_TP_CAP = 3;

interface DominateScratch extends Record<string, unknown> {
  /** operative id -> Dominate tokens held. */
  tokens: Record<string, number>;
  processed: string[];
}

const scratch = (state: GameState): DominateScratch =>
  opScratch<DominateScratch>(state, ID, () => ({ tokens: {}, processed: [] }));

export const dominateTokens = (state: GameState, operativeId: string): number =>
  scratch(state).tokens[operativeId] ?? 0;

function collectTokens(ctx: GameContext, state: GameState, player: PlayerId): void {
  const s = scratch(state);
  for (const rec of killRecords(state)) {
    if (s.processed.includes(rec.key)) continue;
    s.processed.push(rec.key);
    if (rec.killerPlayer !== player || !rec.killerId) continue;
    const victim = state.operatives[rec.victimId];
    if (!victim) continue;
    const gain = card(ctx, victim).wounds >= 12 ? 2 : 1;
    s.tokens[rec.killerId] = (s.tokens[rec.killerId] ?? 0) + gain;
    revealTacOp(state, player, 'an enemy operative was incapacitated by a friendly operative');
  }
}

export const dominateOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Seek & Destroy',
  name: 'Dominate',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    collectTokens(ctx, state, player);
    if (state.turningPoint < 3) return;
    const s = scratch(state);
    for (const [operativeId, count] of Object.entries(s.tokens)) {
      const op = state.operatives[operativeId];
      if (!op || op.player !== player || op.removed || op.incapacitated) continue;
      let left = count;
      while (left > 0 && roomThisTP(state, player, ID, PER_TP_CAP) > 0) {
        left -= 1;
        s.tokens[operativeId] = left;
        awardVP(ctx, state, player, ID, 1, `Dominate: token removed from ${op.name}`);
      }
    }
  },
};
