/**
 * The op registry and the scoring entry points.
 *
 * Approved Ops: "Each player must score VP during the game from three different ops" — one
 * shared crit op, the kill op, and a secret tac op from one of their kill team's archetypes.
 *
 * Importing this module registers every op's mission actions with `src/core/actions.ts`; each
 * one is gated by `available()` so only the ops actually in play are ever offered.
 */
import { takeDecision } from '../decisions.ts';
import { log } from '../state.ts';
import type { GameContext, OpDef } from '../context.ts';
import type { GameState, PlayerId } from '../types.ts';

import { KILL_OP_ID, PLAYERS, opScratch, syncKillRecords, type OpModule } from './common.ts';
import { resolveInitiativeDecision } from './initiativeCards.ts';
import { killOp } from './killOp.ts';
import { resolvePrimaryOpDecision, scorePrimaryOp } from './primaryOp.ts';

import { secureOp } from './crit/secure.ts';
import { lootOp } from './crit/loot.ts';
import { transmissionOp } from './crit/transmission.ts';
import { orbOp } from './crit/orb.ts';
import { stakeClaimOp } from './crit/stakeClaim.ts';
import { energyCellsOp } from './crit/energyCells.ts';
import { downloadOp } from './crit/download.ts';
import { dataOp } from './crit/data.ts';
import { rebootOp } from './crit/reboot.ts';

import { plantDevicesOp } from './tac/plantDevices.ts';
import { stealIntelligenceOp } from './tac/stealIntelligence.ts';
import { trackEnemyOp } from './tac/trackEnemy.ts';
import { flankOp } from './tac/flank.ts';
import { retrievalOp } from './tac/retrieval.ts';
import { scoutEnemyMovementOp } from './tac/scoutEnemyMovement.ts';
import { plantBannerOp } from './tac/plantBanner.ts';
import { martyrsOp } from './tac/martyrs.ts';
import { envoyOp } from './tac/envoy.ts';
import { routOp } from './tac/rout.ts';
import { sweepAndClearOp } from './tac/sweepAndClear.ts';
import { dominateOp } from './tac/dominate.ts';

export * from './common.ts';
export * from './killGrade.ts';
export * from './initiativeCards.ts';
export { scorePrimaryOp, selectPrimaryOp, PRIMARY_BONUS_ID } from './primaryOp.ts';
export { KILL_GRADE_TABLE } from './killGrade.ts';
export { CRIT_OP_GROUPS, opText, printedOp } from './text.ts';

/** The nine crit ops, in card order. */
export const CRIT_OPS: OpModule[] = [
  secureOp,
  lootOp,
  transmissionOp,
  orbOp,
  stakeClaimOp,
  energyCellsOp,
  downloadOp,
  dataOp,
  rebootOp,
];

/** The twelve tac ops, three per archetype. */
export const TAC_OPS: OpModule[] = [
  plantDevicesOp,
  stealIntelligenceOp,
  trackEnemyOp,
  flankOp,
  retrievalOp,
  scoutEnemyMovementOp,
  plantBannerOp,
  martyrsOp,
  envoyOp,
  routOp,
  sweepAndClearOp,
  dominateOp,
];

export const ALL_OPS: OpModule[] = [...CRIT_OPS, ...TAC_OPS, killOp];

export const opById = (id: string): OpModule | undefined => ALL_OPS.find((o) => o.id === id);

/** For `makeContext({ ops: opsMap() })`. */
export const opsMap = (): Map<string, OpDef> => new Map<string, OpDef>(ALL_OPS.map((o) => [o.id, o]));

export const tacOpsForArchetypes = (archetypes: string[]): OpModule[] =>
  TAC_OPS.filter((o) => !o.archetype || archetypes.includes(o.archetype));

/** The three ops a player scores from: the shared crit op, the kill op and their tac op. */
export function activeOps(state: GameState, player: PlayerId): OpModule[] {
  const out: OpModule[] = [];
  const crit = state.critOpId ? opById(state.critOpId) : undefined;
  if (crit) out.push(crit);
  out.push(killOp);
  const tac = state.teams[player].tacOpId ? opById(state.teams[player].tacOpId!) : undefined;
  if (tac) out.push(tac);
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Battle setup, once the crit op and both tac ops are known (Orb token, Reboot numbers, ...). */
export function initOps(ctx: GameContext, state: GameState): void {
  const seen = new Set<string>();
  for (const player of PLAYERS) {
    for (const op of activeOps(state, player)) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      op.init?.(ctx, state);
    }
  }
}

/**
 * Score every op at the end of a turning point. Idempotent per turning point, so it is safe to
 * call from `phases.endTurningPoint` and again from a UI/AI driver.
 */
export function scoreEndOfTurningPoint(ctx: GameContext, state: GameState): void {
  const marker = opScratch<{ scoredTP: number }>(state, 'ops', () => ({ scoredTP: 0 }));
  if (marker.scoredTP >= state.turningPoint) return;
  marker.scoredTP = state.turningPoint;
  syncKillRecords(state);
  for (const player of PLAYERS) {
    for (const op of activeOps(state, player)) op.scoreEndOfTP?.(ctx, state, player);
  }
}

/** End-of-battle scoring, including the secret primary op bonus. */
export function scoreEndOfBattle(ctx: GameContext, state: GameState): void {
  scoreEndOfTurningPoint(ctx, state);
  const marker = opScratch<{ scoredTP: number; endScored?: boolean }>(state, 'ops', () => ({ scoredTP: 0 }));
  if (marker.endScored) return;
  marker.endScored = true;
  syncKillRecords(state);
  for (const player of PLAYERS) {
    for (const op of activeOps(state, player)) op.scoreEndOfBattle?.(ctx, state, player);
  }
  for (const player of PLAYERS) scorePrimaryOp(ctx, state, player);
  log(state, {
    kind: 'score',
    text: `Final score — P1 ${state.teams.p1.vp}VP, P2 ${state.teams.p2.vp}VP`,
  });
}

/**
 * Resolve a PendingDecision raised by an op (primary op, Stake Claim, Reboot, initiative
 * cards). `src/core/decisions.ts` should call this from its default branch; until it does,
 * drivers can call it directly.
 */
export function resolveOpDecision(
  ctx: GameContext,
  state: GameState,
  decisionId: string,
  optionId: string,
  data?: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  const decision = state.pending.find((d) => d.id === decisionId);
  if (!decision) return { ok: false, reason: `no pending decision '${decisionId}'` };
  const option = decision.options.find((o) => o.id === optionId);
  if (!option && optionId !== 'pass' && optionId !== 'keep')
    return { ok: false, reason: `option '${optionId}' is not available` };
  if (option?.disabled) return { ok: false, reason: option.reason ?? 'option not available' };
  takeDecision(state, decisionId);
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };

  if (decision.kind === 'initiativeCard' || decision.kind === 'chooseInitiative') {
    return resolveInitiativeDecision(ctx, state, decision, optionId, payload)
      ? { ok: true }
      : { ok: false, reason: 'could not resolve the initiative decision' };
  }
  if (decision.kind === 'primaryOp') {
    return resolvePrimaryOpDecision(state, decision, optionId)
      ? { ok: true }
      : { ok: false, reason: 'that op is not one of your three ops' };
  }
  for (const op of ALL_OPS) {
    if (op.resolveDecision?.(ctx, state, decision, optionId, payload)) return { ok: true };
  }
  return { ok: false, reason: `no op claimed the '${decision.kind}' decision` };
}

/** Deterministic answers for AI / auto-resolve mode. */
export function defaultOpDecision(decision: { kind: string; options: { id: string; disabled?: boolean }[] }): string {
  const first = decision.options.find((o) => !o.disabled)?.id ?? 'pass';
  if (decision.kind === 'initiativeCard') return 'pass';
  return first;
}
