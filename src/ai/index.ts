/**
 * The AI package: legal-intent enumeration, evaluation, search, and the bot-vs-bot runner.
 * See docs/AI.md.
 */
export { TacticalAgent, makeAgent, type TacticalAgentOptions } from './agent.ts';
export { GreedyAgent, RandomLegalAgent, survivors } from './baseline.ts';
export {
  fightEstimate,
  fightPlans,
  fightValue,
  healthFraction,
  operativeValue,
  shootEstimate,
  shotPlans,
  shotValue,
  type FightEstimate,
  type FightPlan,
  type ShotEstimate,
  type ShotPlan,
} from './combat.ts';
export { DEFAULT_POLICY, decideOption, type DecisionChoice, type DecisionPolicy } from './decide.ts';
export { resetAiCaches } from './caches.ts';
export { clearDeployCache, deployPosition, deployPositions } from './deploy.ts';
export { evaluate, positionScore, roleOf, snapshot, threatScore, type Role } from './eval.ts';
export { actionCandidates, enumerateCandidates, interruptCandidates, ployCandidates } from './legal.ts';
export { chargeRing, chargeTargets, clearMoveCache, generateMoves, moveOptionsFor, type MoveCandidate } from './moves.ts';
export { actorFor, playGame, type GameResult, type PlayGameOptions, type RosterSpec } from './runner.ts';
export {
  agentConfig,
  DEFAULT_WEIGHTS,
  DIFFICULTY_PRESETS,
  type Agent,
  type AgentConfig,
  type Candidate,
  type Difficulty,
  type EvalWeights,
} from './types.ts';
