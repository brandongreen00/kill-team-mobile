/**
 * The Kill Team AI.
 *
 * Architecture (docs/AI.md):
 *   1. Candidate generation — `legal.ts` builds fully-parameterised, pre-validated intents;
 *      movement destinations come from the engine's 0.5" reachability field.
 *   2. Pruning — a cheap geometric `hint` keeps the best `beam` candidates.
 *   3. Search — one ply per action, applied through the REAL reducer on a forked RNG, so a
 *      simulated Shoot rolls real dice through the real sequence. `rollouts` samples per
 *      candidate give a Monte-Carlo estimate; the resulting state is scored by `eval.ts`.
 *   4. Reactive windows — `decide.ts`.
 *
 * The agent plays either side, any team, any map: nothing here is faction-specific. Team
 * modules feed it `aiHints` (roles, ploy/equipment values) through the hook registry.
 */
import type { GameContext } from '../core/context.ts';
import type { Intent } from '../core/intents.ts';
import { getAction } from '../core/actions.ts';
import { reduce } from '../core/reducer.ts';
import type { Rng } from '../core/rng.ts';
import { aliveOperatives } from '../core/state.ts';
import type { GameState, OperativeState, PlayerId } from '../core/types.ts';
import { shotPlans, shotValue } from './combat.ts';
import { decideOption, DEFAULT_POLICY, type DecisionPolicy } from './decide.ts';
import { evaluate, objectivesHeldFrom, positionContext, positionScore, roleOf } from './eval.ts';
import { enumerateCandidates, interruptCandidates } from './legal.ts';
import { agentConfig, type Agent, type AgentConfig, type Candidate, type Difficulty } from './types.ts';

interface PlanStep {
  intent: Intent;
  /** For re-validation right before dispatch. */
  operativeId?: string;
}

export interface TacticalAgentOptions {
  difficulty?: Difficulty;
  config?: Partial<AgentConfig>;
  policy?: DecisionPolicy;
  /** Label used in the RNG fork tag, so two agents in one game never share a stream. */
  tag?: string;
}

export class TacticalAgent implements Agent {
  readonly name: string;
  private readonly cfg: AgentConfig;
  private readonly policy: DecisionPolicy;
  private readonly tag: string;
  private plan: PlanStep[] = [];
  private planFor: string | null = null;
  /** Simulated reduce() calls in the current decision. */
  private nodes = 0;
  private deadline = 0;

  constructor(opts: TacticalAgentOptions = {}) {
    this.cfg = agentConfig(opts.difficulty ?? 'elite', opts.config ?? {});
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.tag = opts.tag ?? 'ai';
    this.name = `tactical-${this.cfg.difficulty}`;
  }

  reset(): void {
    this.plan = [];
    this.planFor = null;
  }

  act(ctx: GameContext, state: GameState, player: PlayerId): Intent | null {
    this.nodes = 0;
    this.deadline = Date.now() + this.cfg.timeBudgetMs;

    const pending = state.pending.find((d) => d.who === player);
    if (pending) {
      const choice = decideOption(ctx, state, pending, this.policy);
      return {
        t: 'ResolveDecision',
        decisionId: pending.id,
        optionId: choice.optionId,
        ...(choice.data ? { data: choice.data } : {}),
      };
    }

    const offer = state.opState['guardOffer'] as { player?: PlayerId } | undefined;
    if (offer?.player === player) return this.chooseInterrupt(ctx, state, player);

    const candidates = enumerateCandidates(ctx, state, player, {
      weights: this.cfg.weights,
      moveLimit: this.cfg.beam + 2,
    });
    if (candidates.length === 0) {
      this.plan = [];
      this.planFor = null;
      return null;
    }

    const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
    if (active && active.player === player) return this.continueActivation(ctx, state, player, active, candidates);

    const activations = candidates.filter((c) => c.kind === 'activate');
    if (activations.length > 0) return this.chooseActivation(ctx, state, player, activations);

    const counteracts = candidates.filter((c) => c.kind === 'counteract');
    if (counteracts.length > 0) return this.chooseCounteract(ctx, state, player, counteracts);

    const gambits = candidates.filter((c) => c.kind === 'gambit');
    if (gambits.length > 0) return this.chooseGambit(ctx, state, player, gambits);
    return candidates[0]!.intent;
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  /**
   * Choose which operative activates, and with which order, by planning the whole activation
   * for the most promising few and keeping the best plan for execution.
   */
  private chooseActivation(ctx: GameContext, state: GameState, player: PlayerId, activations: Candidate[]): Intent {
    const ready = aliveOperatives(state, player).filter((o) => o.ready);
    const shortlist = this.shortlistOperatives(ctx, state, ready);
    const rng = this.noiseStream(ctx, state, player, 'activate');

    let bestIntent: Intent = activations[0]!.intent;
    let bestPlan: PlanStep[] = [];
    let bestScore = -Infinity;

    for (const op of shortlist) {
      for (const order of this.ordersFor(ctx, state, op)) {
        const cand = activations.find(
          (c) => c.intent.t === 'ActivateOperative' && c.intent.operativeId === op.id && c.intent.order === order,
        );
        if (!cand) continue;
        const planned = this.planActivation(ctx, state, player, cand.intent);
        const score = planned.score + this.noise(rng);
        if (score > bestScore) {
          bestScore = score;
          bestIntent = cand.intent;
          bestPlan = planned.steps;
        }
        if (this.exhausted()) break;
      }
      if (this.exhausted()) break;
    }

    this.plan = bestPlan;
    this.planFor = bestIntent.t === 'ActivateOperative' ? bestIntent.operativeId : null;
    return bestIntent;
  }

  /** Cheap ranking so only the promising operatives get a full plan. */
  private shortlistOperatives(ctx: GameContext, state: GameState, ready: OperativeState[]): OperativeState[] {
    const depth = this.cfg.difficulty === 'recruit' ? 1 : this.cfg.difficulty === 'veteran' ? 3 : 4;
    const scored = ready.map((op) => {
      const shot = shotPlans(ctx, state, op)[0];
      const role = roleOf(ctx, state, op);
      let score = shot ? shotValue(shot) * 3 : 0;
      score += objectivesHeldFrom(ctx, state, op, op.pos) * 6;
      if (role === 'melee') score += 4;
      score += op.wounds * 0.2;
      return { op, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, depth).map((s) => s.op);
  }

  /**
   * Conceal is only worth considering for an operative that is not going to attack: an
   * operative with a Conceal order cannot Shoot (bar Silent weapons), Charge or go on Guard.
   */
  private ordersFor(ctx: GameContext, state: GameState, op: OperativeState): ('engage' | 'conceal')[] {
    if (this.cfg.difficulty === 'recruit') return ['engage'];
    const shot = shotPlans(ctx, state, op)[0];
    const enemies = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1');
    const wantsAttack = (shot && shotValue(shot) > 0.6) || roleOf(ctx, state, op) === 'melee';
    if (wantsAttack || enemies.length === 0) return ['engage'];
    return ['engage', 'conceal'];
  }

  /**
   * Greedy sequential search inside one activation: at each step, simulate the beam of
   * candidate actions through the real reducer and keep the best, stopping when no action
   * beats simply ending the activation.
   */
  private planActivation(
    ctx: GameContext,
    state: GameState,
    player: PlayerId,
    activate: Intent,
  ): { steps: PlanStep[]; score: number } {
    const opId = activate.t === 'ActivateOperative' ? activate.operativeId : '';
    const start = this.simulate(ctx, state, [activate], player, `plan:${opId}`);
    if (!start) return { steps: [], score: -Infinity };
    let current = start;
    const steps: PlanStep[] = [];
    let score = this.score(ctx, current, player);

    for (let depth = 0; depth < 4; depth++) {
      if (this.exhausted()) break;
      const options = enumerateCandidates(ctx, current, player, {
        weights: this.cfg.weights,
        moveLimit: this.cfg.beam + 2,
      }).filter((c) => c.kind === 'action' || c.kind === 'ploy');
      if (options.length === 0) break;
      const beam = this.beamOf(options);
      let bestScore = score;
      let bestIntent: Intent | null = null;
      let bestState: GameState | null = null;
      for (const cand of beam) {
        const outcome = this.evaluateCandidate(ctx, current, player, cand, `step${depth}:${opId}`);
        if (!outcome) continue;
        if (outcome.score > bestScore) {
          bestScore = outcome.score;
          bestIntent = cand.intent;
          bestState = outcome.state;
        }
        if (this.exhausted()) break;
      }
      if (!bestIntent || !bestState) break;
      steps.push({ intent: bestIntent, operativeId: opId });
      current = bestState;
      score = bestScore;
    }

    steps.push({ intent: { t: 'EndActivation', operativeId: opId }, operativeId: opId });
    return { steps, score };
  }

  /** Execute the cached plan, re-validating each step; replan if the world moved under it. */
  private continueActivation(
    ctx: GameContext,
    state: GameState,
    player: PlayerId,
    active: OperativeState,
    candidates: Candidate[],
  ): Intent {
    const endIntent: Intent = { t: 'EndActivation', operativeId: active.id };
    if (active.removed || active.incapacitated) {
      this.plan = [];
      return endIntent;
    }
    if (this.planFor === active.id) {
      while (this.plan.length > 0) {
        const step = this.plan.shift()!;
        if (this.stepStillLegal(ctx, state, step)) return step.intent;
      }
    }
    // No usable plan: pick the single best action available right now.
    const options = candidates.filter((c) => c.kind === 'action' || c.kind === 'ploy');
    if (options.length === 0) return endIntent;
    const rng = this.noiseStream(ctx, state, player, 'act');
    const baseline = this.score(ctx, state, player);
    let best: { intent: Intent; score: number } | null = null;
    for (const cand of this.beamOf(options)) {
      const outcome = this.evaluateCandidate(ctx, state, player, cand, `single:${active.id}`);
      if (!outcome) continue;
      const score = outcome.score + this.noise(rng);
      if (!best || score > best.score) best = { intent: cand.intent, score };
      if (this.exhausted()) break;
    }
    if (best && best.score > baseline) return best.intent;
    return endIntent;
  }

  private stepStillLegal(ctx: GameContext, state: GameState, step: PlanStep): boolean {
    const intent = step.intent;
    if (intent.t === 'EndActivation') return state.activeOperativeId === intent.operativeId;
    if (intent.t !== 'PerformAction') return true;
    const op = state.operatives[intent.operativeId];
    if (!op || op.removed || state.activeOperativeId !== op.id) return false;
    const def = getAction(intent.action);
    if (!def) return false;
    if (def.available && !def.available(ctx, state, op)) return false;
    const key = def.treatedAs ?? def.id;
    const counteracting = state.opState['counteract']?.['operativeId'] === op.id;
    if (!counteracting && op.actionsThisActivation.includes(key)) return false;
    if (!ctx.hooks.emit('canPerformAction', state, { state, operative: op, action: def.id, allowed: true }).allowed)
      return false;
    return def.check(ctx, state, op, intent.params ?? {}).ok;
  }

  // -------------------------------------------------------------------------
  // Counteract & interrupts
  // -------------------------------------------------------------------------

  /**
   * Counteracting is free, so the only real question is whether the operative's one 1AP action
   * is worth spending its once-per-turning-point counteract on. Declining burns the whole
   * team's counteracts for the turning point, so it is a last resort.
   */
  private chooseCounteract(ctx: GameContext, state: GameState, player: PlayerId, counteracts: Candidate[]): Intent {
    const decline = counteracts.find((c) => c.intent.t === 'DeclineCounteract');
    const options = counteracts.filter((c) => c.intent.t === 'Counteract');
    let best: { intent: Intent; score: number } | null = null;
    for (const cand of options.slice(0, this.cfg.beam)) {
      const sim = this.simulate(ctx, state, [cand.intent], player, 'counteract');
      if (!sim) continue;
      const inner = enumerateCandidates(ctx, sim, player, { weights: this.cfg.weights, moveLimit: 3 }).filter(
        (c) => c.kind === 'action',
      );
      let bestInner = this.score(ctx, sim, player);
      for (const step of this.beamOf(inner)) {
        const outcome = this.evaluateCandidate(ctx, sim, player, step, 'counteract-step');
        if (outcome && outcome.score > bestInner) bestInner = outcome.score;
        if (this.exhausted()) break;
      }
      if (!best || bestInner > best.score) best = { intent: cand.intent, score: bestInner };
      if (this.exhausted()) break;
    }
    const baseline = this.score(ctx, state, player);
    if (best && best.score >= baseline - 1e-9) return best.intent;
    return decline?.intent ?? best?.intent ?? { t: 'DeclineCounteract', player };
  }

  /** STRATEGIC GAMBITs: only worth using when the team module prices them above passing. */
  private chooseGambit(ctx: GameContext, state: GameState, player: PlayerId, gambits: Candidate[]): Intent {
    const pass = gambits.find((c) => c.intent.t === 'PassGambit');
    const baseline = this.score(ctx, state, player);
    let best: { intent: Intent; score: number } | null = null;
    for (const cand of this.beamOf(gambits.filter((c) => c.intent.t === 'UseGambit'))) {
      const outcome = this.evaluateCandidate(ctx, state, player, cand, 'gambit');
      if (!outcome) continue;
      const score = outcome.score + cand.hint;
      if (!best || score > best.score) best = { intent: cand.intent, score };
      if (this.exhausted()) break;
    }
    if (best && best.score > baseline) return best.intent;
    return pass?.intent ?? { t: 'PassGambit', player };
  }

  private chooseInterrupt(ctx: GameContext, state: GameState, player: PlayerId): Intent {
    const options = interruptCandidates(ctx, state, player);
    const attacks = options.filter((c) => c.intent.t === 'OnGuardInterrupt');
    let best: { intent: Intent; score: number } | null = null;
    const baseline = this.score(ctx, state, player);
    for (const cand of attacks.slice(0, this.cfg.beam)) {
      const outcome = this.evaluateCandidate(ctx, state, player, cand, 'interrupt');
      if (!outcome) continue;
      if (!best || outcome.score > best.score) best = { intent: cand.intent, score: outcome.score };
      if (this.exhausted()) break;
    }
    if (best && best.score > baseline) return best.intent;
    return { t: 'DeclineInterrupt', player };
  }

  // -------------------------------------------------------------------------
  // Search primitives
  // -------------------------------------------------------------------------

  private beamOf(options: Candidate[]): Candidate[] {
    const sorted = [...options].sort((a, b) => b.hint - a.hint);
    return sorted.slice(0, this.cfg.beam);
  }

  /** Simulate a candidate `rollouts` times (dice differ per rollout) and average the score. */
  private evaluateCandidate(
    ctx: GameContext,
    state: GameState,
    player: PlayerId,
    cand: Candidate,
    tag: string,
  ): { score: number; state: GameState } | null {
    const samples = Math.max(1, this.cfg.rollouts);
    let total = 0;
    let last: GameState | null = null;
    let taken = 0;
    for (let i = 0; i < samples; i++) {
      const sim = this.simulate(ctx, state, [cand.intent], player, `${tag}#${i}`);
      if (!sim) break;
      total += this.score(ctx, sim, player) + this.candidateBonus(ctx, sim, player, cand);
      last = sim;
      taken++;
      if (this.exhausted()) break;
    }
    if (!last || taken === 0) return null;
    return { score: total / taken, state: last };
  }

  /**
   * Positional value the state evaluation cannot see: what the operative can shoot from its
   * new position, and what can shoot back. Computed once per candidate, not per rollout.
   */
  private candidateBonus(ctx: GameContext, state: GameState, player: PlayerId, cand: Candidate): number {
    if (cand.intent.t !== 'PerformAction') return 0;
    const action = cand.intent.action;
    if (action !== 'Reposition' && action !== 'Dash' && action !== 'Fall Back' && action !== 'Charge') return 0;
    const op = state.operatives[cand.intent.operativeId];
    if (!op || op.removed) return 0;
    const pc = positionContext(ctx, state, op, this.cfg.weights);
    return 0.5 * positionScore(ctx, state, op, op.pos, op.z, pc, op.order);
  }

  private score(ctx: GameContext, state: GameState, player: PlayerId): number {
    return evaluate(ctx, state, player, this.cfg.weights, { fast: true });
  }

  /**
   * Apply intents to a COPY of the game through the real reducer, on a forked RNG so the
   * match dice stream is untouched, auto-answering any decision either side raises.
   */
  private simulate(
    ctx: GameContext,
    state: GameState,
    intents: Intent[],
    player: PlayerId,
    tag: string,
  ): GameState | null {
    const simCtx: GameContext = { ...ctx, rng: ctx.rng.fork(`${this.tag}:${player}:${tag}:${state.seq}`) };
    delete simCtx.terrainCache;
    let current = state;
    for (const intent of intents) {
      if (this.nodes++ > this.cfg.nodeBudget) return null;
      const out = reduce(current, intent, simCtx);
      if (!out.ok) return null;
      current = out.state;
      let guard = 0;
      while (current.pending.length > 0 && guard++ < 40) {
        const decision = current.pending[0]!;
        const choice = decideOption(simCtx, current, decision, this.policy);
        if (this.nodes++ > this.cfg.nodeBudget) return current;
        const res = reduce(
          current,
          {
            t: 'ResolveDecision',
            decisionId: decision.id,
            optionId: choice.optionId,
            ...(choice.data ? { data: choice.data } : {}),
          },
          simCtx,
        );
        if (!res.ok) break;
        current = res.state;
      }
    }
    return current;
  }

  private exhausted(): boolean {
    return this.nodes > this.cfg.nodeBudget || Date.now() > this.deadline;
  }

  /** Difficulty noise, drawn from a fork of the match RNG so replays stay byte-identical. */
  private noiseStream(ctx: GameContext, state: GameState, player: PlayerId, tag: string): Rng | null {
    if (this.cfg.noise <= 0) return null;
    return ctx.rng.fork(`${this.tag}:noise:${player}:${tag}:${state.seq}`);
  }

  private noise(rng: Rng | null): number {
    if (!rng) return 0;
    return (rng.next() - 0.5) * 2 * this.cfg.noise;
  }
}

/** Convenience factory used by the tests and the UI. */
export function makeAgent(difficulty: Difficulty = 'elite', opts: TacticalAgentOptions = {}): TacticalAgent {
  return new TacticalAgent({ difficulty, ...opts });
}
