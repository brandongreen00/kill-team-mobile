/**
 * Bot-vs-bot game driver.
 *
 * Owns only the FLOW intents that are not a player choice (the initiative roll-off, stepping
 * the strategy phase, ending a turning point). Everything else comes from an `Agent`, and
 * every intent goes through `reduce` — the runner never touches GameState directly.
 *
 * A game is fully determined by (rosters, map, seed, agent configs).
 */
import type { GameContext } from '../core/context.ts';
import { createBattle } from '../core/init.ts';
import type { Intent, RosterPick } from '../core/intents.ts';
import { whoActivates } from '../core/phases.ts';
import { reduce } from '../core/reducer.ts';
import { SeededRng } from '../core/rng.ts';
import { aliveOperatives } from '../core/state.ts';
import type { GameState, KillzoneMap, PlayerId } from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';
import { resetAiCaches } from './caches.ts';
import { deployPosition } from './deploy.ts';
import type { Agent } from './types.ts';

export interface RosterSpec {
  teamId: string;
  operatives: RosterPick[];
  equipment?: string[];
  tacOpId?: string;
}

export interface PlayGameOptions {
  ctx: GameContext;
  map: KillzoneMap;
  seed: number;
  critOpId?: string;
  rosters: Record<PlayerId, RosterSpec>;
  agents: Record<PlayerId, Agent>;
  maxTurningPoints?: number;
  /** Safety valve: abort a game that will not terminate. */
  maxIntents?: number;
  /** Observe every dispatched intent (used by the determinism test). */
  onIntent?: (intent: Intent, ok: boolean, state: GameState) => void;
}

export interface GameResult {
  state: GameState;
  winner: PlayerId | 'draw' | undefined;
  vp: Record<PlayerId, number>;
  survivors: Record<PlayerId, number>;
  rejected: GameState['rejected'];
  intents: number;
  turningPoints: number;
  elapsedMs: number;
  /** Set when the runner had to abort (never expected; the soak asserts it is undefined). */
  error?: string;
}

export function playGame(opts: PlayGameOptions): GameResult {
  const started = Date.now();
  const ctx = opts.ctx;
  // Module-level caches are keyed by ids that repeat across battles (operative ids, datacard
  // ids, map ids, positions). A stale entry from the previous game could answer a query in
  // this one, so every game starts from a clean slate.
  resetAiCaches();
  // A fresh, seeded stream per game: the same seed replays byte-identically.
  ctx.rng = new SeededRng(opts.seed);
  for (const p of ['p1', 'p2'] as PlayerId[]) opts.agents[p].reset?.();

  let state = createBattle(ctx, {
    map: opts.map,
    seed: opts.seed,
    ...(opts.critOpId ? { critOpId: opts.critOpId } : {}),
    ...(opts.maxTurningPoints !== undefined ? { maxTurningPoints: opts.maxTurningPoints } : {}),
  });

  let intents = 0;
  let error: string | undefined;

  const dispatch = (intent: Intent): boolean => {
    const out = reduce(state, intent, ctx);
    state = out.state;
    intents++;
    opts.onIntent?.(intent, out.ok, state);
    if (!out.ok && !error) error = `rejected ${intent.t}: ${out.reason ?? 'unknown'}`;
    return out.ok;
  };

  // ---- setup ------------------------------------------------------------
  dispatch({ t: 'RollOff', kind: 'initiative' });
  const chooser = state.setup.toAct ?? 'p1';
  dispatch({ t: 'ChooseDropZone', player: chooser, zone: chooser });
  for (const player of ['p1', 'p2'] as PlayerId[]) {
    const spec = opts.rosters[player];
    dispatch({ t: 'SelectRoster', player, teamId: spec.teamId, operatives: spec.operatives });
    if (spec.equipment && spec.equipment.length > 0) dispatch({ t: 'SelectEquipment', player, equipment: spec.equipment });
    if (spec.tacOpId) dispatch({ t: 'SelectTacOp', player, tacOpId: spec.tacOpId });
  }

  // Alternating deployment, starting with the roll-off winner.
  const order: PlayerId[] = [chooser, otherPlayer(chooser)];
  const queues: Record<PlayerId, string[]> = {
    p1: [...state.teams.p1.operativeIds],
    p2: [...state.teams.p2.operativeIds],
  };
  let guard = 0;
  while ((queues.p1.length > 0 || queues.p2.length > 0) && guard++ < 200) {
    for (const player of order) {
      const id = queues[player].shift();
      if (!id) continue;
      const op = state.operatives[id];
      if (!op) continue;
      const pos = deployPosition(ctx, state, op);
      if (!pos) {
        error ??= `no legal deployment position for ${id}`;
        continue;
      }
      dispatch({ t: 'DeployOperative', player, operativeId: id, pos });
    }
  }
  dispatch({ t: 'FinishSetup' });

  // ---- battle -----------------------------------------------------------
  const maxIntents = opts.maxIntents ?? 8000;
  const initiativeRolled = new Set<number>();
  let stalls = 0;

  while (state.phase !== 'battleEnd' && intents < maxIntents && !error) {
    const before = state.seq;
    const actor = actorFor(state);

    if (actor) {
      const intent = opts.agents[actor].act(ctx, state, actor);
      if (intent) {
        dispatch(intent);
      } else {
        // The agent has nothing to say: unstick the phase.
        if (!flowIntent(state, initiativeRolled, dispatch)) stalls++;
      }
    } else if (!flowIntent(state, initiativeRolled, dispatch)) {
      stalls++;
    }

    if (state.seq === before) stalls++;
    else stalls = 0;
    if (stalls > 6) {
      error ??= `stalled in ${state.phase}/${state.strategyStep ?? state.firefightStep ?? '-'}`;
      break;
    }
  }
  if (state.phase !== 'battleEnd' && !error) error = `did not reach battleEnd (${intents} intents)`;

  return {
    state,
    winner: state.winner,
    vp: { p1: state.teams.p1.vp, p2: state.teams.p2.vp },
    survivors: { p1: aliveOperatives(state, 'p1').length, p2: aliveOperatives(state, 'p2').length },
    rejected: state.rejected,
    intents,
    turningPoints: state.turningPoint,
    elapsedMs: Date.now() - started,
    ...(error ? { error } : {}),
  };
}

/** Which player, if any, the engine is waiting on. */
export function actorFor(state: GameState): PlayerId | null {
  if (state.phase === 'battleEnd' || state.phase === 'setup') return null;
  const pending = state.pending[0];
  if (pending) return pending.who;
  const offer = state.opState['guardOffer'] as { player?: PlayerId } | undefined;
  if (offer?.player && state.activeOperativeId) return offer.player;
  if (state.phase === 'strategy') {
    if (state.strategyStep !== 'gambit') return null;
    const init = state.initiative ?? 'p1';
    if (!state.teams[init].passedGambit) return init;
    const other = otherPlayer(init);
    if (!state.teams[other].passedGambit) return other;
    return null;
  }
  if (state.phase === 'firefight') {
    const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
    if (active) return active.player;
    return whoActivates(state)?.player ?? null;
  }
  return null;
}

/**
 * Flow intents: the per-turning-point initiative roll-off and the phase steps that are not a
 * player decision. Returns false when there was nothing to do.
 */
function flowIntent(
  state: GameState,
  initiativeRolled: Set<number>,
  dispatch: (intent: Intent) => boolean,
): boolean {
  if (state.phase === 'strategy') {
    if (state.strategyStep === 'initiative') {
      if (!initiativeRolled.has(state.turningPoint)) {
        initiativeRolled.add(state.turningPoint);
        return dispatch({ t: 'RollOff', kind: 'initiative' });
      }
      return dispatch({ t: 'AdvancePhase' });
    }
    return dispatch({ t: 'AdvancePhase' });
  }
  if (state.phase === 'firefight' || state.phase === 'endOfTP') return dispatch({ t: 'AdvancePhase' });
  return false;
}
