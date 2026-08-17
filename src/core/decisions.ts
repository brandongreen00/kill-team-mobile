/**
 * Resolving PendingDecisions — the reactive-window machinery.
 * Every interactive choice (rerolls, retention, allocation, strike/block, cover-vs-obscured,
 * On Guard interrupts, ploy offers) comes back through here.
 */
import { applyObscured, applyRetention, classify, rerollDie, successes, type DicePool } from './dice.ts';
import type { GameContext } from './context.ts';
import { findProfile, hitOf, log, recordRoll, saveOf, weaponsOf } from './state.ts';
import { advanceShoot, applyAllocation, effectiveRules } from './sequences/shoot.ts';
import { advanceFight, resolveFightDie, sideWeapon } from './sequences/fight.ts';
import type { GameState, PendingDecision } from './types.ts';
import type { FightSequence, ShootSequence } from './sequences/types.ts';

export function takeDecision(state: GameState, decisionId: string): PendingDecision | undefined {
  const idx = state.pending.findIndex((d) => d.id === decisionId);
  if (idx < 0) return undefined;
  const [d] = state.pending.splice(idx, 1);
  return d;
}

export function resolveDecision(
  ctx: GameContext,
  state: GameState,
  decisionId: string,
  optionId: string,
  data?: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  const decision = state.pending.find((d) => d.id === decisionId);
  if (!decision) return { ok: false, reason: `no pending decision '${decisionId}'` };
  const option = decision.options.find((o) => o.id === optionId);
  if (!option && optionId !== 'keep' && optionId !== 'skip' && optionId !== 'pass')
    return { ok: false, reason: `option '${optionId}' is not available` };
  if (option?.disabled) return { ok: false, reason: option.reason ?? 'option not available' };

  takeDecision(state, decisionId);
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) } as Record<string, unknown>;
  log(state, { kind: 'decision', player: decision.who, text: `${decision.kind}: ${option?.label ?? optionId}` });

  switch (decision.kind) {
    case 'coverOrObscured': {
      const seq = state.sequence as ShootSequence | undefined;
      if (seq?.kind === 'shoot') {
        if (optionId === 'cover') seq.obscured = false;
        else seq.inCover = false;
        seq.coverChoiceMade = true;
      }
      break;
    }
    case 'reroll':
      applyReroll(ctx, state, decision, optionId, payload);
      break;
    case 'retention':
      applyRetentionDecision(state, decision, optionId, payload);
      break;
    case 'obscuredDiscard': {
      const seq = state.sequence as ShootSequence | undefined;
      if (seq?.kind === 'shoot') applyObscured(seq.attack, Number(payload['dieId'] ?? NaN) || undefined);
      break;
    }
    case 'allocateDefence': {
      const seq = state.sequence as ShootSequence | undefined;
      if (seq?.kind === 'shoot') {
        const alloc = (decision.ctx?.['alloc'] ?? {}) as { unblockedCrits?: number; unblockedNormals?: number };
        if (optionId === 'manual' && typeof payload['unblockedCrits'] === 'number') {
          applyAllocation(seq, payload['unblockedCrits'] as number, (payload['unblockedNormals'] as number) ?? 0);
        } else {
          applyAllocation(seq, alloc.unblockedCrits ?? 0, alloc.unblockedNormals ?? 0);
        }
        seq.step = 'resolve';
      }
      break;
    }
    case 'strikeOrBlock': {
      const seq = state.sequence as FightSequence | undefined;
      if (seq?.kind === 'fight') {
        const side = (decision.ctx?.['side'] ?? 'attacker') as 'attacker' | 'defender';
        const [mode, idStr] = optionId.split(':');
        resolveFightDie(
          ctx,
          state,
          seq,
          side,
          Number(idStr),
          mode === 'block' ? 'block' : 'strike',
          typeof payload['blockTargetId'] === 'number' ? (payload['blockTargetId'] as number) : undefined,
        );
      }
      break;
    }
    default: {
      // Ops own several decision kinds (the secret TP1 primary op, Stake Claim, Reboot
      // numbers, Envoy, Flank). Without this the primary-op prompt would block the reducer.
      let handled = false;
      for (const handler of ctx.decisionHandlers ?? []) {
        if (handler(ctx, state, decision, optionId, payload)) {
          handled = true;
          break;
        }
      }
      if (!handled) handled = ctx.resolveOpDecision?.(ctx, state, decisionId, optionId, payload) ?? false;
      if (!handled) {
        log(state, { kind: 'system', text: `decision '${decision.kind}' had no handler — recorded only` });
      }
      break;
    }
  }

  // Continue whatever sequence is in flight.
  if (state.sequence?.kind === 'shoot') advanceShoot(ctx, state);
  else if (state.sequence?.kind === 'fight') advanceFight(ctx, state);
  return { ok: true };
}

function poolFor(state: GameState, decision: PendingDecision): { pool: DicePool; hit: number } | null {
  const hit = Number(decision.ctx?.['hit'] ?? 4);
  const seq = state.sequence;
  if (!seq) return null;
  if (seq.kind === 'shoot') {
    const isDefence = decision.who === seq.defender && seq.step === 'defenceRerolls';
    return { pool: isDefence ? seq.defence : seq.attack, hit };
  }
  const side = (decision.ctx?.['side'] ?? 'attacker') as 'attacker' | 'defender';
  return { pool: side === 'attacker' ? seq.attackerPool : seq.defenderPool, hit };
}

function applyReroll(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  payload: Record<string, unknown>,
): void {
  if (optionId === 'keep') return;
  const found = poolFor(state, decision);
  if (!found) return;
  const { pool, hit } = found;
  const cp = Number(decision.ctx?.['cp'] ?? 0);
  if (cp > 0) {
    const team = state.teams[decision.who];
    if (team.cp < cp) return;
    team.cp -= cp;
    team.ploysUsedTP.push(String(decision.ctx?.['grantId'] ?? 'commandReroll'));
    log(state, { kind: 'ploy', player: decision.who, text: `Command Re-roll (${cp}CP)` });
  }

  let ids: number[] = [];
  if (optionId.startsWith('value:')) {
    const v = Number(optionId.slice(6));
    ids = pool.dice.filter((d) => d.rolled && d.value === v && d.state !== 'discarded').map((d) => d.id);
  } else if (optionId === 'allFails') {
    ids = (payload['dieIds'] as number[]) ?? pool.dice.filter((d) => d.state === 'fail').map((d) => d.id);
  } else if (optionId.startsWith('die:')) {
    ids = [Number(optionId.slice(4))];
  } else if (typeof payload['dieId'] === 'number') {
    ids = [payload['dieId'] as number];
  }

  const rolled: number[] = [];
  for (const id of ids) {
    const die = pool.dice.find((d) => d.id === id);
    if (!die || !die.rolled) continue;
    const v = ctx.rng.d6();
    rolled.push(v);
    rerollDie(die, v, hit);
  }
  if (rolled.length > 0) {
    recordRoll(state, 'reroll', rolled, decision.who, String(decision.ctx?.['grantId'] ?? ''));
    log(state, {
      kind: 'dice',
      player: decision.who,
      text: `Re-rolled ${rolled.length} dice → ${rolled.join(', ')}`,
      data: { dieIds: ids, results: rolled },
    });
  }
}

function applyRetentionDecision(
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  payload: Record<string, unknown>,
): void {
  if (optionId === 'skip') return;
  const seq = state.sequence;
  if (!seq) return;
  const pool =
    seq.kind === 'shoot'
      ? seq.attack
      : (decision.ctx?.['side'] ?? 'attacker') === 'attacker'
        ? seq.attackerPool
        : seq.defenderPool;
  applyRetention(pool, optionId as 'severe' | 'rending' | 'punishing', payload['dieId'] as number | undefined);
  log(state, { kind: 'dice', player: decision.who, text: `Applied ${optionId}` });
}

/**
 * Default answers used by the AI and by "auto-resolve" mode. Chooses the option that is
 * best for the deciding player under a simple, deterministic policy.
 */
export function defaultDecisionOption(decision: PendingDecision): { optionId: string; data?: Record<string, unknown> } {
  switch (decision.kind) {
    case 'coverOrObscured':
      // Obscured costs the attacker a success AND all crits — usually stronger than a
      // single cover save.
      return { optionId: 'obscured' };
    case 'reroll': {
      const mode = decision.ctx?.['mode'];
      const cp = Number(decision.ctx?.['cp'] ?? 0);
      if (cp > 0) return { optionId: 'keep' }; // spend CP only when the AI decides to
      if (mode === 'value') {
        const first = decision.options.find((o) => o.id.startsWith('value:1')) ?? decision.options[0];
        return { optionId: first?.id ?? 'keep' };
      }
      const allFails = decision.options.find((o) => o.id === 'allFails');
      if (allFails) return { optionId: allFails.id };
      const fail = decision.options.find((o) => o.label.includes('fail'));
      return { optionId: fail?.id ?? 'keep' };
    }
    case 'retention': {
      const best =
        decision.options.find((o) => o.id === 'severe') ??
        decision.options.find((o) => o.id === 'rending') ??
        decision.options.find((o) => o.id === 'punishing');
      return { optionId: best?.id ?? 'skip' };
    }
    case 'obscuredDiscard': {
      const normal = decision.options.find((o) => o.label.startsWith('Normal'));
      return { optionId: normal?.id ?? decision.options[0]?.id ?? 'skip' };
    }
    case 'allocateDefence':
      return { optionId: 'auto' };
    case 'strikeOrBlock': {
      const strike = decision.options.find((o) => o.id.startsWith('strike:') && o.label.includes('critical'));
      return { optionId: strike?.id ?? decision.options.find((o) => !o.disabled)?.id ?? 'skip' };
    }
    default:
      return { optionId: decision.options.find((o) => !o.disabled)?.id ?? 'skip' };
  }
}
