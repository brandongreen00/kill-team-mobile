/**
 * Baseline agents: the soak drivers, and the bar the real AI has to clear.
 *
 * Both pick ONLY from fully-parameterised legal candidates (`enumerateCandidates`), so a
 * bot-vs-bot game must finish with `state.rejected.length === 0`.
 */
import type { GameContext } from '../core/context.ts';
import { defaultDecisionOption } from '../core/decisions.ts';
import type { Intent } from '../core/intents.ts';
import type { Rng } from '../core/rng.ts';
import { aliveOperatives } from '../core/state.ts';
import type { GameState, PlayerId } from '../core/types.ts';
import { shotPlans, shotValue } from './combat.ts';
import { objectivesHeldFrom } from './eval.ts';
import { enumerateCandidates, interruptCandidates } from './legal.ts';
import { DEFAULT_WEIGHTS, type Agent, type Candidate, type EvalWeights } from './types.ts';

/** A deterministic child stream, so the baseline's choices never disturb the match dice. */
function stream(ctx: GameContext, state: GameState, tag: string): Rng {
  return ctx.rng.fork(`${tag}:${state.seq}`);
}

function guardOfferFor(state: GameState, player: PlayerId): boolean {
  const offer = state.opState['guardOffer'] as { player?: PlayerId } | undefined;
  return offer?.player === player;
}

/**
 * Picks uniformly at random from the legal, parameterised candidates. Useful as a soak driver
 * (it visits states a purposeful agent never would) and as the weakest possible opponent.
 */
export class RandomLegalAgent implements Agent {
  readonly name = 'random';
  constructor(private readonly weights: EvalWeights = DEFAULT_WEIGHTS) {}

  act(ctx: GameContext, state: GameState, player: PlayerId): Intent | null {
    const rng = stream(ctx, state, `random:${player}`);
    const pending = state.pending.find((d) => d.who === player);
    if (pending) {
      const options = pending.options.filter((o) => !o.disabled);
      if (options.length === 0) return { t: 'PassDecision', decisionId: pending.id };
      const pick = options[Math.floor(rng.next() * options.length)] ?? options[0]!;
      return {
        t: 'ResolveDecision',
        decisionId: pending.id,
        optionId: pick.id,
        ...(pick.data ? { data: pick.data } : {}),
      };
    }
    if (guardOfferFor(state, player)) {
      const options = interruptCandidates(ctx, state, player);
      const pick = options[Math.floor(rng.next() * options.length)] ?? options[options.length - 1];
      return pick ? pick.intent : { t: 'DeclineInterrupt', player };
    }
    const candidates = enumerateCandidates(ctx, state, player, { weights: this.weights, moveLimit: 4, moveStep: 1 });
    if (candidates.length === 0) return null;
    // Bias very slightly away from ending an activation with AP left, or the random agent
    // barely ever does anything at all.
    const pool = candidates.filter((c) => c.kind !== 'end');
    const useable = pool.length > 0 && rng.next() < 0.8 ? pool : candidates;
    return (useable[Math.floor(rng.next() * useable.length)] ?? candidates[0]!).intent;
  }
}

/**
 * One-ply greedy: takes the highest immediate-value candidate (shooting, charging, objective
 * control), answers reactive windows with the engine's deterministic default policy, and never
 * looks past the action it is taking.
 */
export class GreedyAgent implements Agent {
  readonly name = 'greedy';
  constructor(private readonly weights: EvalWeights = DEFAULT_WEIGHTS) {}

  act(ctx: GameContext, state: GameState, player: PlayerId): Intent | null {
    const pending = state.pending.find((d) => d.who === player);
    if (pending) {
      const choice = defaultDecisionOption(pending);
      return {
        t: 'ResolveDecision',
        decisionId: pending.id,
        optionId: choice.optionId,
        ...(choice.data ? { data: choice.data } : {}),
      };
    }
    if (guardOfferFor(state, player)) {
      const options = interruptCandidates(ctx, state, player);
      const best = options.reduce<Candidate | null>((a, b) => (a && a.hint >= b.hint ? a : b), null);
      return best && best.hint > 8 ? best.intent : { t: 'DeclineInterrupt', player };
    }

    const candidates = enumerateCandidates(ctx, state, player, { weights: this.weights, moveLimit: 5, moveStep: 1 });
    if (candidates.length === 0) return null;

    const activations = candidates.filter((c) => c.kind === 'activate');
    if (activations.length > 0) return this.chooseActivation(ctx, state, activations);

    const counteracts = candidates.filter((c) => c.kind === 'counteract');
    if (counteracts.length > 0) {
      const act = counteracts.find((c) => c.intent.t === 'Counteract');
      return (act ?? counteracts[0]!).intent;
    }

    const gambits = candidates.filter((c) => c.kind === 'gambit');
    if (gambits.length > 0) {
      const best = gambits.reduce((a, b) => (a.hint >= b.hint ? a : b));
      return best.hint > 0 ? best.intent : { t: 'PassGambit', player };
    }

    const actions = candidates.filter((c) => c.kind === 'action' || c.kind === 'ploy');
    const best = actions.reduce<Candidate | null>((a, b) => (a && a.hint >= b.hint ? a : b), null);
    if (best && best.hint > 0) return best.intent;
    const end = candidates.find((c) => c.kind === 'end');
    return end ? end.intent : (candidates[0]!.intent ?? null);
  }

  /** Activate whoever has the best shot right now, otherwise whoever holds most objectives. */
  private chooseActivation(ctx: GameContext, state: GameState, activations: Candidate[]): Intent {
    let best = activations[0]!;
    let bestScore = -Infinity;
    for (const cand of activations) {
      const intent = cand.intent;
      if (intent.t !== 'ActivateOperative') continue;
      if (intent.order !== 'engage') continue; // greedy always wants to shoot and charge
      const op = state.operatives[intent.operativeId];
      if (!op) continue;
      const shot = shotPlans(ctx, state, op)[0];
      const score = (shot ? shotValue(shot) * 3 : 0) + objectivesHeldFrom(ctx, state, op, op.pos) * 5 + op.wounds * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best.intent;
  }
}

/** Convenience for tests: how many operatives each side still has. */
export function survivors(state: GameState): Record<PlayerId, number> {
  return { p1: aliveOperatives(state, 'p1').length, p2: aliveOperatives(state, 'p2').length };
}
