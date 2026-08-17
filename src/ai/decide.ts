/**
 * Reactive-window policy: how the AI answers a `PendingDecision`.
 *
 * The engine blocks on these (CLAUDE.md architecture rule #3) and `defaultDecisionOption` in
 * `src/core/decisions.ts` is a deterministic baseline. This module improves on it where the
 * choice actually matters: cover-vs-obscured, Command Re-roll CP economy, retention, and
 * strike-or-block ordering. Every returned option id is one the decision actually offers, so
 * `ResolveDecision` can never be rejected.
 */
import { successes, type Die, type DicePool } from '../core/dice.ts';
import { initiativeResult } from '../core/ops/initiativeCards.ts';
import type { GameContext } from '../core/context.ts';
import { defaultDecisionOption } from '../core/decisions.ts';
import { effectiveRules } from '../core/sequences/shoot.ts';
import { sideWeapon } from '../core/sequences/fight.ts';
import { findProfile, weaponsOf } from '../core/state.ts';
import { otherPlayer, type GameState, type PendingDecision, type PlayerId, type WeaponProfile } from '../core/types.ts';
import type { FightSequence, ShootSequence } from '../core/sequences/types.ts';
import { shootEstimate } from './combat.ts';

export interface DecisionPolicy {
  /** Minimum expected damage swing that justifies spending 1CP on a re-roll. */
  cpRerollThreshold: number;
  /** Never drop below this many CP on a re-roll. */
  cpFloor: number;
}

export const DEFAULT_POLICY: DecisionPolicy = { cpRerollThreshold: 0.6, cpFloor: 0 };

export interface DecisionChoice {
  optionId: string;
  data?: Record<string, unknown>;
}

export function decideOption(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  policy: DecisionPolicy = DEFAULT_POLICY,
): DecisionChoice {
  const enabled = decision.options.filter((o) => !o.disabled);
  const has = (id: string): boolean => enabled.some((o) => o.id === id);
  const fallback = (): DecisionChoice => {
    const d = defaultDecisionOption(decision);
    if (d.optionId === 'keep' || d.optionId === 'skip' || has(d.optionId)) return d;
    return { optionId: enabled[0]?.id ?? 'skip' };
  };

  switch (decision.kind) {
    case 'coverOrObscured':
      return { optionId: chooseCoverOrObscured(ctx, state) };
    case 'reroll':
      return chooseReroll(ctx, state, decision, policy) ?? fallback();
    case 'retention':
      return chooseRetention(ctx, state, decision) ?? fallback();
    case 'obscuredDiscard':
      // Every crit becomes a normal, so all remaining successes are worth the same: discard a
      // normal, matching the engine default.
      return fallback();
    case 'allocateDefence':
      // `allocateSavesOptimally` is exactly optimal; there is nothing to improve on.
      return { optionId: has('auto') ? 'auto' : (enabled[0]?.id ?? 'auto') };
    case 'strikeOrBlock':
      return chooseStrikeOrBlock(ctx, state, decision) ?? fallback();
    case 'initiativeCard':
      return chooseInitiativeCard(state, decision);
    case 'chooseInitiative':
      // Activating first sets the tempo and takes contested objectives before the opponent
      // can react. (Known weakness — see docs/AI.md: sometimes activating LAST is stronger.)
      return { optionId: has(decision.who) ? decision.who : (enabled[0]?.id ?? decision.who) };
    case 'primaryOp': {
      // Chosen as a turning-point-1 gambit, before anything is scored: take the crit op, the
      // one op both players can score every turning point.
      const crit = enabled.find((o) => o.id.startsWith('crit.'));
      return { optionId: (crit ?? enabled[0])?.id ?? 'pass' };
    }
    default:
      return fallback();
  }
}

// ---------------------------------------------------------------------------

/**
 * Initiative cards: "each player alternates either using an initiative card to alter their
 * roll result or passing". Spend a card only when it actually flips the roll-off, and spend
 * the smallest one that does — cards are scarce (one per turning point, to the loser).
 */
function chooseInitiativeCard(state: GameState, decision: PendingDecision): DecisionChoice {
  const me = decision.who;
  const them = otherPlayer(me);
  const mine = initiativeResult(state, me);
  const theirs = initiativeResult(state, them);
  // A tie is won by the player who does not currently have initiative.
  const winningAlready = mine > theirs || (mine === theirs && state.initiative !== me);
  const pass = decision.options.find((o) => o.id === 'pass');
  if (winningAlready) return { optionId: pass?.id ?? 'pass' };

  const needed = theirs - mine + (state.initiative === me ? 1 : 0);
  let best: { id: string; delta: number } | null = null;
  for (const option of decision.options) {
    if (option.disabled || option.id === 'pass') continue;
    const delta = Number(option.data?.['delta'] ?? NaN);
    if (!Number.isFinite(delta) || delta <= 0) continue;
    if (delta < needed) continue;
    if (!best || delta < best.delta) best = { id: option.id, delta };
  }
  if (best) return { optionId: best.id, data: { cardId: best.id.split('|')[0] } };
  // No modifier is big enough: a re-roll is the only way back into it.
  const reroll = decision.options.find((o) => !o.disabled && o.id.endsWith('|reroll'));
  if (reroll && theirs - mine >= 2) return { optionId: reroll.id, data: { cardId: reroll.id.split('|')[0] } };
  return { optionId: pass?.id ?? 'pass' };
}

function shootSeq(state: GameState): ShootSequence | null {
  return state.sequence?.kind === 'shoot' ? state.sequence : null;
}

function fightSeq(state: GameState): FightSequence | null {
  return state.sequence?.kind === 'fight' ? state.sequence : null;
}

/**
 * Cover vs obscured: obscured costs the attacker a success AND every crit, a cover save only
 * retains one normal success. Usually obscured wins, but not against a single-die weapon or
 * when Piercing has already stripped the defence pool — so both are actually priced.
 */
function chooseCoverOrObscured(ctx: GameContext, state: GameState): 'cover' | 'obscured' {
  const seq = shootSeq(state);
  if (!seq) return 'obscured';
  const attacker = state.operatives[seq.attackerId];
  const target = state.operatives[seq.targetId];
  if (!attacker || !target) return 'obscured';
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
  const profile = w ? findProfile(w, seq.profileName) : undefined;
  if (!profile) return 'obscured';
  const rules = effectiveRules(ctx, state, profile);
  const common = { attacker, target, profile, rules };
  const withCover = shootEstimate(ctx, state, {
    ...common,
    check: { inCover: true, obscured: false, vantageAccurate: seq.vantageAccurate, vantageImprovedCover: seq.vantageImprovedCover },
  });
  const withObscured = shootEstimate(ctx, state, {
    ...common,
    check: { inCover: false, obscured: true, vantageAccurate: seq.vantageAccurate, vantageImprovedCover: false },
  });
  return withObscured.effective <= withCover.effective ? 'obscured' : 'cover';
}

function poolOf(state: GameState, decision: PendingDecision): { pool: DicePool; profile?: WeaponProfile; defence: boolean } | null {
  const seq = state.sequence;
  if (!seq) return null;
  if (seq.kind === 'shoot') {
    const isDefence = decision.who === seq.defender && seq.step === 'defenceRerolls';
    return { pool: isDefence ? seq.defence : seq.attack, defence: isDefence };
  }
  const side = (decision.ctx?.['side'] ?? 'attacker') as 'attacker' | 'defender';
  return { pool: side === 'attacker' ? seq.attackerPool : seq.defenderPool, defence: false };
}

/** Expected damage swing of turning one failed die into a success, for this pool. */
function damagePerSuccess(ctx: GameContext, state: GameState, decision: PendingDecision): number {
  const seq = state.sequence;
  if (!seq) return 1;
  if (seq.kind === 'shoot') {
    const attacker = state.operatives[seq.attackerId];
    const w = attacker ? weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName) : undefined;
    const profile = w ? findProfile(w, seq.profileName) : undefined;
    return profile ? profile.dmgN : 1;
  }
  const side = (decision.ctx?.['side'] ?? 'attacker') as 'attacker' | 'defender';
  return sideWeapon(ctx, state, seq, side).profile.dmgN;
}

function chooseReroll(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  policy: DecisionPolicy,
): DecisionChoice | null {
  const found = poolOf(state, decision);
  if (!found) return null;
  const { pool } = found;
  const hit = Number(decision.ctx?.['hit'] ?? 4);
  const cp = Number(decision.ctx?.['cp'] ?? 0);
  const mode = String(decision.ctx?.['mode'] ?? 'one');
  const live = pool.dice.filter((d) => d.rolled && d.state !== 'discarded');
  const fails = live.filter((d) => d.state === 'fail');
  const pSuccess = Math.max(0, 7 - hit) / 6;

  if (cp > 0) {
    // Command Re-roll: one die, 1CP. Only worth it when the swing beats the CP.
    const team = state.teams[decision.who];
    if (team.cp - cp < policy.cpFloor) return { optionId: 'keep' };
    if (fails.length === 0) return { optionId: 'keep' };
    const gain = pSuccess * damagePerSuccess(ctx, state, decision);
    if (gain < policy.cpRerollThreshold) return { optionId: 'keep' };
    const worst = fails.reduce((a, b) => (a.value <= b.value ? a : b));
    const id = `die:${worst.id}`;
    return decision.options.some((o) => o.id === id) ? { optionId: id, data: { dieId: worst.id } } : { optionId: 'keep' };
  }

  if (fails.length === 0) return { optionId: 'keep' };

  if (mode === 'value') {
    // Re-roll the failing value with the most dice on it.
    const counts = new Map<number, number>();
    for (const d of fails) counts.set(d.value, (counts.get(d.value) ?? 0) + 1);
    let bestValue = -1;
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount || (count === bestCount && value < bestValue)) {
        bestValue = value;
        bestCount = count;
      }
    }
    const id = `value:${bestValue}`;
    if (decision.options.some((o) => o.id === id)) return { optionId: id, data: { value: bestValue } };
    return { optionId: 'keep' };
  }

  if (decision.options.some((o) => o.id === 'allFails')) {
    return { optionId: 'allFails', data: { dieIds: fails.map((d) => d.id) } };
  }
  const worst = fails.reduce((a, b) => (a.value <= b.value ? a : b));
  const id = `die:${worst.id}`;
  return decision.options.some((o) => o.id === id) ? { optionId: id, data: { dieId: worst.id } } : { optionId: 'keep' };
}

/**
 * Only one retention option is ever applied per sequence, so pick the one worth the most
 * damage: Severe/Rending upgrade a normal to a crit (dmgC − dmgN); Punishing adds a normal.
 */
function chooseRetention(ctx: GameContext, state: GameState, decision: PendingDecision): DecisionChoice | null {
  const seq = state.sequence;
  if (!seq) return null;
  let profile: WeaponProfile | undefined;
  if (seq.kind === 'shoot') {
    const attacker = state.operatives[seq.attackerId];
    const w = attacker ? weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName) : undefined;
    profile = w ? findProfile(w, seq.profileName) : undefined;
  } else {
    const side = (decision.ctx?.['side'] ?? 'attacker') as 'attacker' | 'defender';
    profile = sideWeapon(ctx, state, seq, side).profile;
  }
  if (!profile) return null;
  const upgrade = profile.dmgC - profile.dmgN;
  const options = decision.options.filter((o) => !o.disabled).map((o) => o.id);
  const scored: { id: string; value: number }[] = [];
  if (options.includes('severe')) scored.push({ id: 'severe', value: upgrade });
  if (options.includes('rending')) scored.push({ id: 'rending', value: upgrade });
  if (options.includes('punishing')) scored.push({ id: 'punishing', value: profile.dmgN });
  if (scored.length === 0) return { optionId: 'skip' };
  scored.sort((a, b) => b.value - a.value);
  return { optionId: scored[0]!.id };
}

/**
 * Strike or block. "Starting with the attacker, the players alternate resolving one of their
 * successful unblocked attack dice." Strike when it finishes the enemy or when their
 * remaining dice cannot kill us; block their best die when it can.
 */
function chooseStrikeOrBlock(ctx: GameContext, state: GameState, decision: PendingDecision): DecisionChoice | null {
  const seq = fightSeq(state);
  if (!seq) return null;
  const side = (decision.ctx?.['side'] ?? 'attacker') as 'attacker' | 'defender';
  const mine = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
  const theirs = side === 'attacker' ? seq.defenderPool : seq.attackerPool;
  const me = side === 'attacker' ? state.operatives[seq.attackerId] : state.operatives[seq.defenderId];
  const them = side === 'attacker' ? state.operatives[seq.defenderId] : state.operatives[seq.attackerId];
  if (!me || !them) return null;
  const myProfile = sideWeapon(ctx, state, seq, side).profile;
  const theirProfile = sideWeapon(ctx, state, seq, side === 'attacker' ? 'defender' : 'attacker').profile;

  const myDice = successes(mine);
  const theirDice = successes(theirs);
  if (myDice.length === 0) return null;
  const best = pickBest(myDice);
  const strikeId = `strike:${best.id}`;
  const strikeDamage = best.state === 'crit' ? myProfile.dmgC : myProfile.dmgN;
  const canStrike = decision.options.some((o) => o.id === strikeId && !o.disabled);

  // Killing blow: always take it.
  if (canStrike && strikeDamage >= them.wounds) return { optionId: strikeId, data: { dieId: best.id } };

  const incoming = theirDice.reduce((sum, d) => sum + (d.state === 'crit' ? theirProfile.dmgC : theirProfile.dmgN), 0);
  if (incoming >= me.wounds && theirDice.length > 0) {
    // We die if we let them resolve everything — block their biggest die if we legally can.
    const theirBest = pickBest(theirDice);
    const blockCandidates = decision.options.filter((o) => o.id.startsWith('block:') && !o.disabled);
    const blocker =
      theirBest.state === 'crit'
        ? myDice.find((d) => d.state === 'crit') ?? myDice.find((d) => d.state === 'normal')
        : myDice.find((d) => d.state === 'normal') ?? myDice.find((d) => d.state === 'crit');
    if (blocker) {
      const blockId = `block:${blocker.id}`;
      if (blockCandidates.some((o) => o.id === blockId))
        return { optionId: blockId, data: { dieId: blocker.id, blockTargetId: theirBest.id } };
    }
  }
  if (canStrike) return { optionId: strikeId, data: { dieId: best.id } };
  return null;
}

function pickBest(dice: Die[]): Die {
  return dice.find((d) => d.state === 'crit') ?? dice[0]!;
}
