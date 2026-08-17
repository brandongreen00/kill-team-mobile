/**
 * AI package contracts.
 *
 * Every agent drives the game through `Intent`s only — the same channel the UI uses
 * (CLAUDE.md architecture rule #1). Agents never mutate `GameState` and never call
 * `Math.random`: all randomness comes from `ctx.rng` (rule #2), and rollouts use
 * `ctx.rng.fork(tag)` so a simulation can never disturb the match dice stream.
 */
import type { GameContext } from '../core/context.ts';
import type { Intent } from '../core/intents.ts';
import type { GameState, PlayerId } from '../core/types.ts';

/** Rollout budgets + noise, tuned per difficulty. */
export type Difficulty = 'recruit' | 'veteran' | 'elite';

export interface EvalWeights {
  /** Victory points are the only thing that actually wins a game. */
  vp: number;
  /** Objective markers currently controlled (a proxy for the VP they will pay). */
  objective: number;
  /** Per point of "operative value" still on the board. */
  operative: number;
  /** Per point of operative value weighted by remaining wounds. */
  wounds: number;
  /** Command points in hand. */
  cp: number;
  /** Carrying a mission marker. */
  carry: number;
  /** Expected damage this kill team could deal right now. */
  threat: number;
  /** Expected damage this kill team could take right now. */
  exposure: number;
  /** Gentle pull toward objectives so a stalled team still advances. */
  advance: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  vp: 120,
  objective: 22,
  operative: 6,
  wounds: 9,
  cp: 3,
  carry: 14,
  threat: 2.2,
  exposure: 2.6,
  advance: 0.9,
};

export interface AgentConfig {
  difficulty: Difficulty;
  /**
   * Hard cap on the work one decision may do, in abstract units: 1 per simulated `reduce`,
   * 8 per candidate enumeration, 3 per positional score. This is the PRIMARY limiter and it
   * is deterministic, so the same seed always produces the same game.
   */
  nodeBudget: number;
  /**
   * Wall-clock safety cap per decision, milliseconds. Only enforced when
   * `enforceTimeBudget` is set, because a clock-dependent cutoff would make replays
   * non-reproducible. The node budget is tuned so decisions stay well under it.
   */
  timeBudgetMs: number;
  /** Enforce `timeBudgetMs`. Off by default: determinism beats latency in tests and replays. */
  enforceTimeBudget: boolean;
  /** Monte-Carlo rollouts per candidate action. 0 = heuristic only. */
  rollouts: number;
  /** Candidate actions kept for simulation after the cheap pre-score. */
  beam: number;
  /** How many ready operatives get a full activation plan before one is chosen. */
  shortlist: number;
  /** Reachability-field resolution in inches (the engine's field is 0.5"). */
  moveStep: number;
  /** Score perturbation, in evaluation points. Drawn from `ctx.rng.fork()`. */
  noise: number;
  weights: EvalWeights;
}

export const DIFFICULTY_PRESETS: Record<Difficulty, Omit<AgentConfig, 'weights' | 'difficulty'>> = {
  // Recruit plays honestly but shallowly, and misjudges by a wide margin.
  recruit: { nodeBudget: 60, timeBudgetMs: 300, enforceTimeBudget: false, rollouts: 0, beam: 2, shortlist: 1, moveStep: 1, noise: 26 },
  veteran: { nodeBudget: 420, timeBudgetMs: 300, enforceTimeBudget: false, rollouts: 1, beam: 5, shortlist: 3, moveStep: 0.5, noise: 8 },
  elite: { nodeBudget: 900, timeBudgetMs: 300, enforceTimeBudget: false, rollouts: 2, beam: 6, shortlist: 3, moveStep: 0.5, noise: 0 },
};

export function agentConfig(difficulty: Difficulty = 'elite', over: Partial<AgentConfig> = {}): AgentConfig {
  return { difficulty, weights: { ...DEFAULT_WEIGHTS }, ...DIFFICULTY_PRESETS[difficulty], ...over };
}

/**
 * An agent answers "what do you do now?" for one player. The runner calls it whenever the
 * engine is waiting on that player — an activation, a counteract window, a gambit, a
 * PendingDecision or an On Guard interrupt. Returning `null` means "nothing to do", which
 * the runner turns into the flow intent that unsticks the phase.
 */
export interface Agent {
  readonly name: string;
  act(ctx: GameContext, state: GameState, player: PlayerId): Intent | null;
  /** Called once per game so stateful agents can reset. */
  reset?(): void;
}

/** A legal intent plus enough metadata to score it without re-deriving the params. */
export interface Candidate {
  intent: Intent;
  kind:
    | 'decision'
    | 'gambit'
    | 'ploy'
    | 'activate'
    | 'counteract'
    | 'action'
    | 'end'
    | 'interrupt'
    | 'flow';
  /** Cheap heuristic score, used to prune before simulation. */
  hint: number;
  label: string;
}
