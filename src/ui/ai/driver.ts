/**
 * The AI opponent, driving the same `Store` a person does.
 *
 * There is no second channel and no privileged access: every intent below goes through
 * `store.dispatch`, which is `reduce(state, intent, ctx)` — architecture rule #1. The AI
 * package has played whole games this way since it was written (`src/ai/runner.ts`); what it
 * has never done is share a game with somebody else, and that is all this module adds.
 *
 * Two rules shape it.
 *
 * **Ask, then act — never act, then ask.** `aiTurn()` answers "does the AI owe the next
 * intent?" using selectors only: no enumeration, no search, no agent. `commandPlan` calls it
 * on every render to decide whether to show the board as playable or as the opponent's, and a
 * render that ran a 200ms search would be unusable. `step()` is the only thing that thinks,
 * and it is called once per dispatched intent — `TacticalAgent` shifts a step off its plan
 * queue *before* it validates it, so a second, speculative `act()` on the same state silently
 * throws away a planned action.
 *
 * **Beats with no owner belong to the person.** The roll-off, the ready step, the reveal, the
 * end-of-turning-point score: the rules give those to nobody in particular, and in a solo game
 * they are where the player looks at the board and decides they are ready. The driver only
 * takes them when there is nobody there to press them — both seats driven, i.e. watching.
 */
import type { GameContext } from '../../core/context.ts';
import type { Intent } from '../../core/intents.ts';
import { gambitToAct, whoActivates } from '../../core/phases.ts';
import type { GameState, PlayerId } from '../../core/types.ts';
import { makeAgent, type TacticalAgent } from '../../ai/agent.ts';
import { resetAiCaches } from '../../ai/caches.ts';
import type { Store } from '../store.ts';
import type { TeamData } from '../data.ts';
import { guardOffer } from '../command/play.tsx';
import { isAi, isWatching, type OpponentConfig } from './opponent.ts';
import { AI_DISPATCH } from './roster.ts';
import { aiSetupStep, aiSetupTurn } from './setup.ts';

/** Which part of the loop the AI is in, so a screen can frame the board for it. */
export type AiTurnKind = 'setup' | 'decision' | 'interrupt' | 'strategy' | 'firefight' | 'flow' | 'cleanup';

export interface AiTurn {
  player: PlayerId;
  /** A verb phrase that reads after the player's name: "Player 2 is deploying". */
  note: string;
  kind: AiTurnKind;
}

/**
 * Does an AI seat owe the next intent, and what is it doing?
 *
 * The branch order is `commandPlan`'s own — pending decision, On Guard, setup step, phase —
 * so the screen and the driver can never disagree about who is on the clock. Returning null
 * means "not the AI's move", which for a pass-and-play battle is always.
 */
export function aiTurn(ctx: GameContext, state: GameState, opponent: OpponentConfig): AiTurn | null {
  if (!isAi(opponent, 'p1') && !isAi(opponent, 'p2')) return null;
  if (state.phase === 'battleEnd') return null;
  const watching = isWatching(opponent);
  const mine = (player: PlayerId, note: string, kind: AiTurnKind): AiTurn | null =>
    isAi(opponent, player) ? { player, note, kind } : null;
  const shared = (note: string): AiTurn | null =>
    watching ? { player: state.initiative ?? 'p1', note, kind: 'flow' } : null;

  // A pending decision blocks every other intent in the reducer, so it blocks the driver too —
  // and only `pending[0]`, because that is the one the screen is showing. Answering a decision
  // further down the queue would resolve a window the player cannot see.
  const decision = state.pending[0];
  if (decision) return mine(decision.who, `is deciding: ${decision.prompt}`, 'decision');

  // On Guard is not a PendingDecision and the reducer does not block on it: if nobody answers
  // the window, the activation simply carries on past the interrupt.
  const offer = guardOffer(state);
  if (offer) return mine(offer.player, 'may interrupt with On Guard', 'interrupt');

  // An operative killed mid-activation — by a counter-strike, or by an On Guard shot — leaves
  // `activeOperativeId` pointing at a corpse. `removeIncapacitated` does not clear it and the
  // reducer never ends that activation, so it is never marked expended, the activation clock
  // never ticks it and `onActivationEnd` never fires. Whoever owns it, the driver ends it: in
  // a solo game the alternative is a battle that cannot continue once the surviving side has
  // no ready operatives left.
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active?.removed) return { player: active.player, note: `ends ${active.letter}'s activation`, kind: 'cleanup' };

  if (state.phase === 'setup') {
    const turn = aiSetupTurn(state, opponent);
    return turn ? { ...turn, kind: 'setup' } : null;
  }

  if (state.phase === 'strategy') {
    const step = state.strategyStep ?? 'initiative';
    if (step === 'gambit') {
      const who = gambitToAct(state);
      return who ? mine(who, 'is choosing a strategic gambit', 'strategy') : shared('ends the strategy phase');
    }
    return shared(step === 'initiative' ? 'rolls off for initiative' : 'readies up');
  }

  if (state.phase === 'firefight') {
    if (active) return mine(active.player, `is acting with ${active.letter}`, 'firefight');
    // `whoActivates` is asked WITH the context, as the reducer, `commandPlan` and the AI's own
    // enumerator all ask it: without one it cannot see a team rule that widens who may
    // counteract, and would name a player the reducer then refuses.
    const turn = whoActivates(state, ctx);
    if (!turn) return shared('ends the turning point');
    return mine(turn.player, turn.mode === 'counteract' ? 'may counteract' : 'is choosing an operative', 'firefight');
  }

  if (state.phase === 'endOfTP') return shared('scores the turning point');
  return null;
}

export interface AiDriverOptions {
  store: Store;
  teams: TeamData[];
  opponent: OpponentConfig;
}

export interface AiStepResult {
  /** True when an intent was dispatched and accepted. */
  acted: boolean;
  /** Set when the AI could not act. The battle stops here rather than spinning. */
  error?: string;
}

export class AiDriver {
  private agents: Partial<Record<PlayerId, TacticalAgent>> = {};
  /**
   * The last owner-less beat sent, as `phase|step|turningPoint|intent`.
   *
   * `AdvancePhase` and `RollOff` have no idempotence guard in the reducer — a second
   * `AdvancePhase` out of `endOfTP` rolls the turning point over *and* runs the ready step,
   * skipping the roll-off entirely — so the driver refuses to send the same beat twice for the
   * same key. The intent is part of the key because one step legitimately sends two different
   * beats: the roll-off, and then the `AdvancePhase` that leaves it.
   */
  private lastFlow: string | null = null;
  /** Set once the AI cannot act. Cleared by `newBattle()` and by a change of seating. */
  error: string | null = null;

  constructor(private opts: AiDriverOptions) {}

  /**
   * Swap the seating or the difficulty without losing the battle.
   *
   * Clearing `error` is the point as much as the seating is: the way out of `ai.error` is to
   * take the failing seat over, and a driver that stayed stuck would then refuse to play the
   * OTHER AI seat in a watched battle — the screen would flip straight back to the error.
   */
  configure(opponent: OpponentConfig, teams?: TeamData[]): void {
    const changed = opponent.difficulty !== this.opts.opponent.difficulty;
    this.opts = { ...this.opts, opponent, ...(teams ? { teams } : {}) };
    this.error = null;
    this.lastFlow = null;
    if (changed) this.agents = {};
    else this.reset();
  }

  get opponent(): OpponentConfig {
    return this.opts.opponent;
  }

  turn(): AiTurn | null {
    if (this.error) return null;
    return aiTurn(this.opts.store.ctx, this.opts.store.state, this.opts.opponent);
  }

  /**
   * Everything a long-lived app has to do that `playGame` does per process: drop the AI's
   * module-level caches (reachability fields keyed by map and position, damage estimates keyed
   * by datacard) and throw away any half-executed activation plan.
   */
  newBattle(): void {
    resetAiCaches();
    for (const agent of Object.values(this.agents)) agent?.reset();
    this.lastFlow = null;
    this.error = null;
  }

  /** A rules state the agent's cached plan can no longer be about — an undo, a rejection. */
  reset(): void {
    for (const agent of Object.values(this.agents)) agent?.reset();
    this.lastFlow = null;
  }

  private agentFor(player: PlayerId): TacticalAgent {
    const existing = this.agents[player];
    if (existing) return existing;
    // `enforceTimeBudget` stays off (its default): a clock-dependent cutoff would make the
    // same seed play differently on a slow phone, and a battle is supposed to replay
    // byte-identically from `(rosters, map, seed, intents[])`. The node budget is the limiter.
    const agent = makeAgent(this.opts.opponent.difficulty, { tag: `opponent:${player}` });
    this.agents[player] = agent;
    return agent;
  }

  private fail(message: string): AiStepResult {
    this.error = message;
    return { acted: false, error: message };
  }

  /** Dispatch at most one intent. Call it once per animation frame, not in a loop. */
  step(): AiStepResult {
    if (this.error) return { acted: false, error: this.error };
    const { store, opponent } = this.opts;
    const turn = this.turn();
    if (!turn) return { acted: false };

    if (turn.kind === 'setup') {
      const err = aiSetupStep({ store, teams: this.opts.teams, opponent }, { player: turn.player, note: turn.note });
      if (err) return this.fail(err);
      this.settle();
      return { acted: true };
    }

    if (turn.kind === 'cleanup') {
      const activeId = store.state.activeOperativeId;
      if (!activeId) return { acted: false };
      return this.send({ t: 'EndActivation', operativeId: activeId });
    }

    if (turn.kind === 'flow') return this.flow();

    const agent = this.agentFor(turn.player);
    let intent: Intent | null;
    try {
      intent = agent.act(store.ctx, store.state, turn.player);
    } catch (e) {
      return this.fail(`the AI failed while ${turn.note}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Every branch `aiTurn` routes here has at least one candidate by construction — a
    // decision has its options, a counteract window always offers "decline", an activation
    // always offers the ready operatives. A null here is a real defect, not a pass.
    if (!intent) return this.fail(`the AI found no legal move while it ${turn.note}`);
    return this.send(intent);
  }

  /**
   * The opponent has moved, so nothing before this can be taken back.
   *
   * The AI's own intents are dispatched with `undoable: false` and push no snapshot, but the
   * PLAYER's are still on the stack: without this, "Undo last placement" during alternating
   * deployment restores a state from before the AI's whole batch, rewinding its operatives off
   * the board and its `deployedCount` with them — and truncating `history`, so the battle no
   * longer replays. In a real game your opponent moving is exactly when your move stops being
   * takeable-back.
   */
  private settle(): void {
    this.opts.store.commitHistory();
  }

  private send(intent: Intent): AiStepResult {
    const { store } = this.opts;
    if (store.dispatch(intent, AI_DISPATCH)) {
      this.settle();
      return { acted: true };
    }
    const reason = store.lastRejection?.reason ?? 'the reducer refused it';
    // The toast layer reads `lastRejection` and phrases it as something the PLAYER did wrong.
    // This one is the AI's, and the screen says so instead.
    store.clearRejection();
    this.reset();
    return this.fail(`the AI's ${intent.t} was refused: ${reason}`);
  }

  /** The beats with no owner, taken only when both seats are driven. */
  private flow(): AiStepResult {
    const { state } = this.opts.store;
    const step = state.strategyStep ?? state.firefightStep ?? '-';
    // The same test the human's "Roll off" button uses. A second RollOff in one turning point
    // is accepted by the reducer: it spends two more dice, re-opens the initiative card window
    // and overwrites who has initiative.
    const needsRollOff =
      state.phase === 'strategy' &&
      (state.strategyStep ?? 'initiative') === 'initiative' &&
      !state.rolls.some((r) => r.kind === 'initiative' && r.note === `TP${state.turningPoint}`);
    const intent: Intent = needsRollOff ? { t: 'RollOff', kind: 'initiative' } : { t: 'AdvancePhase' };

    // Keyed on the intent as well as the state, because one step legitimately sends two
    // different beats: the roll-off, then the AdvancePhase that leaves it.
    const key = `${state.phase}|${step}|${state.turningPoint}|${intent.t}`;
    if (this.lastFlow === key) return this.fail(`the battle stopped moving in ${state.phase}/${step}`);
    this.lastFlow = key;
    return this.send(intent);
  }
}
