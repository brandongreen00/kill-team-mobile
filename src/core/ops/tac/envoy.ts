/**
 * Security tac op — Envoy.
 *
 * "As a STRATEGIC GAMBIT in each turning point after the first, select one friendly operative
 * to be your envoy until the Ready step of the next Strategy phase. You cannot select an
 * operative you selected during a previous turning point or an operative that's ignored for
 * the kill op."
 */
import { aliveOperatives } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  binding,
  isEngagedWithEnemy,
  opScratch,
  registerSharedOpHooks,
  revealTacOp,
  territoryOf,
  whollyWithin,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'tac.envoy';
const GAMBIT_PREFIX = `${ID}:select:`;

interface EnvoyScratch extends Record<string, unknown> {
  /** player -> operative ids selected in previous turning points. */
  history: Record<string, string[]>;
  /** player -> the current envoy. */
  envoy: Record<string, string | undefined>;
  /** operative id -> wounds at the start of the turning point. */
  woundsAtTPStart: Record<string, number>;
}

const scratch = (state: GameState): EnvoyScratch =>
  opScratch<EnvoyScratch>(state, ID, () => ({ history: {}, envoy: {}, woundsAtTPStart: {} }));

export const envoyOf = (state: GameState, player: PlayerId): string | undefined => scratch(state).envoy[player];

/** The effect-based half of "ignored for the kill op" (hook handlers get no GameContext). */
const ignoredByEffect = (state: GameState, operativeId: string): boolean =>
  state.effects.some((e) => e.rule === 'ignoredForKillOp' && e.operativeId === operativeId);

export const envoyOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Security',
  name: 'Envoy',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
    reg.on('onReadyStep', binding(`${ID}.snapshot`, opText(ID), player, 10), (ev, b) => {
      if (b.player !== ev.player) return;
      const s = scratch(ev.state);
      s.envoy[ev.player] = undefined; // "until the Ready step of the next Strategy phase"
      for (const op of aliveOperatives(ev.state, ev.player)) s.woundsAtTPStart[op.id] = op.wounds;
    });
    reg.on('gambitOptions', binding(`${ID}.select`, opText(ID), player, 20), (ev, b) => {
      if (b.player !== ev.player) return;
      if (ev.state.teams[ev.player].tacOpId !== ID) return;
      if (ev.state.turningPoint < 2) return;
      const s = scratch(ev.state);
      const used = s.history[ev.player] ?? [];
      for (const op of aliveOperatives(ev.state, ev.player)) {
        if (used.includes(op.id) || ignoredByEffect(ev.state, op.id)) continue;
        ev.options.push({
          id: `${GAMBIT_PREFIX}${op.id}`,
          label: `Envoy: ${op.letter}`,
          sourceText: opText(ID),
        });
      }
    });
  },
  scoreEndOfTP(ctx, state, player) {
    const s = scratch(state);
    const picked = state.teams[player].gambitsUsedTP.find((g) => g.startsWith(GAMBIT_PREFIX));
    if (picked) {
      const id = picked.slice(GAMBIT_PREFIX.length);
      if (s.envoy[player] !== id) {
        s.envoy[player] = id;
        s.history[player] = [...(s.history[player] ?? []), id];
        revealTacOp(state, player, 'an envoy was selected');
      }
    }
    if (state.turningPoint < 2) return;
    const envoyId = s.envoy[player];
    const envoy = envoyId ? state.operatives[envoyId] : undefined;
    if (!envoy || envoy.removed) return;
    if (!whollyWithin(ctx, envoy, territoryOf(state, otherPlayer(player)))) return;
    if (isEngagedWithEnemy(ctx, state, envoy)) return;
    const unharmed = envoy.wounds >= (s.woundsAtTPStart[envoy.id] ?? envoy.wounds);
    awardVP(ctx, state, player, ID, unharmed ? 2 : 1, `Envoy: ${envoy.letter} in enemy territory`);
  },
};
