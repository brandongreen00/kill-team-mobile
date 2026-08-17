/**
 * Security tac op — Martyrs.
 *
 * "Whenever a friendly operative is incapacitated while contesting an objective marker, that
 * marker gains one of your Martyr tokens... this is only the first time each operative is
 * incapacitated."
 */
import { markerContestedBy, markerController } from '../../state.ts';
import {
  awardVP,
  contestedByPlayer,
  killRecords,
  objectiveMarkers,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameContext } from '../../context.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'tac.martyrs';
const PER_TP_CAP = 2;
const tokenFlag = (player: string): string => `martyr:${player}`;

interface MartyrScratch extends Record<string, unknown> {
  /** Operatives that have already produced a Martyr token (once each per battle). */
  tokened: string[];
  processed: string[];
}

const scratch = (state: GameState): MartyrScratch =>
  opScratch<MartyrScratch>(state, ID, () => ({ tokened: [], processed: [] }));

export const martyrTokens = (state: GameState, markerId: string, player: PlayerId): number =>
  Number(state.markers[markerId]?.flags[tokenFlag(player)] ?? 0);

/** Turn this player's kill records into Martyr tokens. Idempotent per record. */
function collectTokens(ctx: GameContext, state: GameState, player: PlayerId): void {
  const s = scratch(state);
  for (const rec of killRecords(state)) {
    if (rec.victimPlayer !== player) continue;
    if (s.processed.includes(rec.key)) continue;
    s.processed.push(rec.key);
    if (s.tokened.includes(rec.victimId)) continue;
    const victim = state.operatives[rec.victimId];
    if (!victim) continue;
    const marker = objectiveMarkers(state).find((m) => markerContestedBy(ctx, state, m, victim));
    if (!marker) continue;
    s.tokened.push(rec.victimId);
    marker.flags[tokenFlag(player)] = martyrTokens(state, marker.id, player) + 1;
    revealTacOp(state, player, 'a friendly operative was incapacitated while contesting an objective marker');
  }
}

export const martyrsOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Security',
  name: 'Martyrs',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    collectTokens(ctx, state, player);
    if (state.turningPoint < 2) return;
    // "you can remove any of those tokens. For each token you remove, you score 1VP; if
    // friendly operatives also control that marker, you score 2VP instead." Removing from
    // controlled markers first is strictly best, so it is resolved that way.
    const candidates = objectiveMarkers(state)
      .filter((m) => martyrTokens(state, m.id, player) > 0 && contestedByPlayer(ctx, state, m, player))
      .map((m) => ({ marker: m, value: markerController(ctx, state, m) === player ? 2 : 1 }))
      .sort((a, b) => b.value - a.value);
    for (const { marker, value } of candidates) {
      let tokens = martyrTokens(state, marker.id, player);
      while (tokens > 0 && roomThisTP(state, player, ID, PER_TP_CAP) >= value) {
        tokens -= 1;
        marker.flags[tokenFlag(player)] = tokens;
        awardVP(ctx, state, player, ID, value, `Martyrs: token removed from ${marker.id}`);
      }
    }
  },
};
