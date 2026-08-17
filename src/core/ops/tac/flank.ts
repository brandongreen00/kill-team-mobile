/**
 * Recon tac op — Flank.
 *
 * "Divide the killzone into two flanks (left and right) by drawing an imaginary line that's
 * just like the centreline, except it runs from the centre of each player's killzone edge. An
 * operative contests a flank while both wholly within it and wholly within their opponent's
 * territory. Friendly operatives control a flank if the total APL stat of those contesting it
 * is greater than that of enemy operatives."
 *
 * The line is `map.flankLine`; "wholly within a flank" is every part of the base on one side
 * of it.
 */
import { basePerimeter, cross, sub } from '../../geometry.ts';
import { aliveOperatives, card } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  binding,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  roomThisTP,
  territoryOf,
  totalApl,
  whollyWithin,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameContext } from '../../context.ts';
import type { GameState, OperativeState, PlayerId, Vec2 } from '../../types.ts';

const ID = 'tac.flank';
const PER_TP_CAP = 2;
export const FLANKS = ['left', 'right'] as const;
export type Flank = (typeof FLANKS)[number];

interface FlankScratch extends Record<string, unknown> {
  revealed: Record<string, boolean>;
  /** player -> flank -> the last turning point it was controlled at the end of. */
  held: Record<string, Record<string, number>>;
}

const scratch = (state: GameState): FlankScratch =>
  opScratch<FlankScratch>(state, ID, () => ({ revealed: {}, held: {} }));

const REVEAL_GAMBIT = `${ID}:reveal`;

/** Which side of the flank line is a point on? >0 = 'left', <0 = 'right'. */
export function flankSide(state: GameState, p: Vec2): number {
  const { a, b } = state.map.flankLine;
  return cross(sub(b, a), sub(p, a));
}

export function whollyWithinFlank(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  flank: Flank,
): boolean {
  const pts: Vec2[] = [op.pos, ...basePerimeter(op.pos, card(ctx, op).base, op.rot, 24)];
  const want = flank === 'left' ? 1 : -1;
  return pts.every((p) => Math.sign(flankSide(state, p)) === want);
}

export function contestingFlank(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  flank: Flank,
): OperativeState[] {
  const enemyTerritory = territoryOf(state, otherPlayer(player));
  return aliveOperatives(state, player).filter(
    (o) => whollyWithinFlank(ctx, state, o, flank) && whollyWithin(ctx, o, enemyTerritory),
  );
}

export function controlsFlank(ctx: GameContext, state: GameState, player: PlayerId, flank: Flank): boolean {
  const mine = totalApl(ctx, state, contestingFlank(ctx, state, player, flank));
  const theirs = totalApl(ctx, state, contestingFlank(ctx, state, otherPlayer(player), flank));
  return mine > theirs;
}

export const flankOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Recon',
  name: 'Flank',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
    reg.on('gambitOptions', binding(`${ID}.reveal`, 'REVEAL: As a STRATEGIC GAMBIT.', player, 20), (ev, b) => {
      if (b.player !== ev.player) return;
      if (ev.state.teams[ev.player].tacOpId !== ID) return;
      if (scratch(ev.state).revealed[ev.player]) return;
      ev.options.push({
        id: REVEAL_GAMBIT,
        label: 'Reveal Flank (tac op)',
        sourceText: 'REVEAL: As a STRATEGIC GAMBIT.',
      });
    });
  },
  scoreEndOfTP(ctx, state, player) {
    const s = scratch(state);
    if (state.teams[player].gambitsUsedTP.includes(REVEAL_GAMBIT) && !s.revealed[player]) {
      s.revealed[player] = true;
      revealTacOp(state, player, 'revealed as a STRATEGIC GAMBIT');
    }
    if (!s.revealed[player] || state.turningPoint < 2) return;
    const held = (s.held[player] ??= {});
    let vp = 0;
    for (const flank of FLANKS) {
      if (!controlsFlank(ctx, state, player, flank)) continue;
      const heldLastTP = held[flank] === state.turningPoint - 1;
      vp += state.turningPoint >= 4 && heldLastTP ? 2 : 1;
      held[flank] = state.turningPoint;
    }
    const grant = Math.min(vp, roomThisTP(state, player, ID, PER_TP_CAP));
    if (grant > 0) awardVP(ctx, state, player, ID, grant, 'Flank: controlling flanks');
  },
};
