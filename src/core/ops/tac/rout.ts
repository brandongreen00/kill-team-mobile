/**
 * Seek & Destroy tac op — Rout.
 *
 * "Whenever a friendly operative incapacitates an enemy operative, if that friendly operative
 * is within 6" of your opponent's drop zone, you score 1VP; if this is true and that enemy
 * operative had a Wounds stat of 12 or more, you score 2VP instead."
 *
 * Kills are recorded as they happen (position of the killer included) and turned into VP at
 * the end of the turning point, which cannot change the total: the only limit is the op's own
 * 2VP-per-turning-point cap.
 */
import { baseGapToPoly } from '../../geometry.ts';
import { card } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  dropZoneOf,
  killRecordsInTP,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameState } from '../../types.ts';

const ID = 'tac.rout';
const PER_TP_CAP = 2;

interface RoutScratch extends Record<string, unknown> {
  processed: string[];
}

const scratch = (state: GameState): RoutScratch => opScratch<RoutScratch>(state, ID, () => ({ processed: [] }));

export const routOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Seek & Destroy',
  name: 'Rout',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    const s = scratch(state);
    const enemyDropZone = dropZoneOf(state, otherPlayer(player));
    for (const rec of killRecordsInTP(state, state.turningPoint)) {
      if (s.processed.includes(rec.key)) continue;
      s.processed.push(rec.key);
      if (rec.killerPlayer !== player || !rec.killerId || !rec.killerPos) continue;
      const killer = state.operatives[rec.killerId];
      const victim = state.operatives[rec.victimId];
      if (!killer || !victim) continue;
      const near = enemyDropZone.some(
        (poly) => baseGapToPoly(rec.killerPos!, card(ctx, killer).base, killer.rot, poly) <= 6 + 1e-6,
      );
      if (!near) continue;
      const want = card(ctx, victim).wounds >= 12 ? 2 : 1;
      const grant = Math.min(want, roomThisTP(state, player, ID, PER_TP_CAP));
      if (grant <= 0) continue;
      if (awardVP(ctx, state, player, ID, grant, `Rout: ${killer.letter} incapacitated ${victim.letter}`) > 0)
        revealTacOp(state, player, 'the first time you score VP from this op');
    }
  },
};
