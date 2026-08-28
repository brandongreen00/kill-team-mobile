/**
 * Turning-point structure: Strategy phase (Initiative → Ready → Gambit) then Firefight
 * phase (alternating activations, counteracts, On Guard interrupts), repeated until the
 * mission pack ends the battle (Approved Ops: after four turning points).
 */
import type { GameContext } from './context.ts';
import { aliveOperatives, log, recordRoll, removeIncapacitated } from './state.ts';
import type { GameState, OperativeState, PlayerId } from './types.ts';
import { otherPlayer } from './types.ts';

export const MAX_TURNING_POINTS = 4;

// ---------------------------------------------------------------------------
// Strategy phase
// ---------------------------------------------------------------------------

/**
 * 1. Initiative — "the players roll-off and the winner decides who has initiative. However,
 * if the roll-off is a tie, the player who didn't have initiative in the previous turning
 * point decides who has initiative."
 *
 * Approved Ops adds initiative cards: starting with the roll-off loser, players alternate
 * playing a card or passing until both pass.
 */
export function rollInitiative(ctx: GameContext, state: GameState): { p1: number; p2: number; winner: PlayerId | null } {
  const modP1 = ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p1', mod: 0, rerollOffered: false }).mod;
  const modP2 = ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p2', mod: 0, rerollOffered: false }).mod;
  const a = ctx.rng.d6();
  const b = ctx.rng.d6();
  recordRoll(state, 'initiative', [a, b], undefined, `TP${state.turningPoint}`);
  const p1 = a + modP1;
  const p2 = b + modP2;
  log(state, { kind: 'dice', text: `Initiative roll-off: P1 ${a}${modP1 ? `${modP1 > 0 ? '+' : ''}${modP1}` : ''} vs P2 ${b}${modP2 ? `${modP2 > 0 ? '+' : ''}${modP2}` : ''}` });
  if (p1 === p2) return { p1, p2, winner: null };
  return { p1, p2, winner: p1 > p2 ? 'p1' : 'p2' };
}

/**
 * 2. Ready — "Each player gains 1 Command point (CP). In each turning point after the first,
 * the player who doesn't have initiative gains 2CP instead. Each player readies all friendly
 * operatives."
 */
export function readyStep(ctx: GameContext, state: GameState): void {
  for (const player of ['p1', 'p2'] as PlayerId[]) {
    const base = state.turningPoint > 1 && state.initiative !== player ? 2 : 1;
    const ev = ctx.hooks.emit('onReadyStep', state, { state, player, cp: base });
    state.teams[player].cp += ev.cp;
    state.teams[player].ploysUsedTP = [];
    state.teams[player].gambitsUsedTP = [];
    state.teams[player].passedGambit = false;
  }
  for (const op of aliveOperatives(state)) {
    op.ready = true;
    op.expended = false;
    op.counteractedThisTP = false;
    op.apSpent = 0;
    op.actionsThisActivation = [];
    op.weaponsUsedThisActivation = [];
    // "It's the start of the next turning point" ends Guard.
    op.onGuard = false;
    op.guardSpentTP = null;
  }
  state.activationsThisTP = 0;
  log(state, { kind: 'system', text: `Ready step — CP: P1 ${state.teams.p1.cp}, P2 ${state.teams.p2.cp}` });
}

/**
 * 3. Gambit — "Starting with the player who has initiative, each player alternates either
 * using a STRATEGIC GAMBIT or passing... until they have both passed in succession."
 */
export function gambitOptions(ctx: GameContext, state: GameState, player: PlayerId) {
  const ev = ctx.hooks.emit('gambitOptions', state, { state, player, options: [] });
  const used = state.teams[player].gambitsUsedTP;
  return ev.options.filter((o) => !used.includes(o.id));
}

export function bothPassedGambit(state: GameState): boolean {
  return state.teams.p1.passedGambit && state.teams.p2.passedGambit;
}

// ---------------------------------------------------------------------------
// Firefight phase
// ---------------------------------------------------------------------------

export function readyOperatives(state: GameState, player: PlayerId) {
  return aliveOperatives(state, player).filter((o) => o.ready);
}

/**
 * Whose turn is it to activate? "The player who has initiative activates a ready friendly
 * operative. Once that activation ends, their opponent activates one of their ready friendly
 * operatives... alternating until all of one player's operatives are expended, in which case
 * they can counteract between their opponent's remaining activations."
 */
export function whoActivates(
  state: GameState,
  ctx?: GameContext,
): { player: PlayerId; mode: 'activate' | 'counteract' } | null {
  const init = state.initiative ?? 'p1';
  const next = state.activePlayer ?? init;
  const hasReady = (p: PlayerId) => readyOperatives(state, p).length > 0;
  if (hasReady(next)) return { player: next, mode: 'activate' };
  const other = otherPlayer(next);
  if (hasReady(other)) {
    // The player with no ready operatives may counteract between their opponent's activations.
    // With a context, ask `counteractCandidates` so rules that widen eligibility ("can
    // counteract regardless of its order") are honoured here too; without one, fall back to
    // the printed default so the pure/UI callers keep working.
    const canCounteract = ctx
      ? counteractCandidates(ctx, state, next).length > 0
      : aliveOperatives(state, next).some((o) => o.expended && o.order === 'engage' && !o.counteractedThisTP);
    if (canCounteract && !counteractDeclinedHere(state, next)) return { player: next, mode: 'counteract' };
    return { player: other, mode: 'activate' };
  }
  return null;
}

/**
 * Has this player already passed on THIS counteract window?
 *
 * Declining used to mark every one of the player's operatives as having counteracted, which
 * only `readyStep` clears — so passing on one window silently gave up every counteract for the
 * rest of the turning point. The only per-turning-point budget the rule imposes is per
 * operative, and it is spent by actually counteracting. A window is identified by the number
 * of activations that have happened, which `EndActivation` increments, so the next window
 * opens by itself.
 */
export function counteractDeclinedHere(state: GameState, player: PlayerId): boolean {
  const d = state.opState['counteractDeclined'];
  return d?.['player'] === player && d?.['at'] === state.activationsThisTP;
}

/**
 * Counteract: "each of their operatives that is expended and has an Engage order can
 * counteract once during the turning point."
 *
 * The Engage-order requirement is the hook's DEFAULT, not a pre-filter, so a team rule can
 * widen it — "This operative can counteract regardless of its order" is printed on the
 * Astartes faction rule of seven kill teams. Filtering before the emit made every one of
 * those clauses unreachable, because `onCounteract` could then only ever narrow the list the
 * core had already computed (docs/TEAM-STATUS.md § Engine seams added for team rules).
 */
/**
 * Whose turn is it to set up an operative?
 *
 * Core Rules › SET UP OPERATIVES: "Starting with the player that has initiative, players
 * alternate setting up one third of their kill team (rounding up), until all operatives from
 * both kill teams have been set up."
 *
 * The reducer does not enforce this — `DeployOperative` checks ownership, drop zone, hazardous
 * terrain and base overlap and nothing about turn order — so this is the one place the order
 * is written down, and both the UI and any driver read it from here rather than reinventing it.
 * Returns null once every operative is on the killzone.
 */
export function deployToAct(state: GameState): PlayerId | null {
  const init = state.initiative ?? 'p1';
  const other = otherPlayer(init);
  const done = (p: PlayerId) => state.setup.deployedCount[p] ?? 0;
  const size = (p: PlayerId) => state.teams[p].operativeIds.length;
  const third = (p: PlayerId) => Math.max(1, Math.ceil(size(p) / 3));
  if (done(init) >= size(init) && done(other) >= size(other)) return null;
  if (size(init) === 0) return init;
  if (done(init) >= size(init)) return other;
  if (done(other) >= size(other)) return init;
  return Math.floor(done(init) / third(init)) <= Math.floor(done(other) / third(other)) ? init : other;
}

/** How many more that player sets up before the turn passes. */
export function deployBatchRemaining(state: GameState, player: PlayerId): number {
  const size = state.teams[player].operativeIds.length;
  const done = state.setup.deployedCount[player] ?? 0;
  const third = Math.max(1, Math.ceil(size / 3));
  return Math.max(0, Math.min(size, (Math.floor(done / third) + 1) * third) - done);
}

/**
 * Whose turn is it to use a STRATEGIC GAMBIT or pass?
 *
 * Core Rules › STRATEGIC GAMBIT: "Starting with the player who has initiative, each player
 * alternates either using a STRATEGIC GAMBIT or passing... until they have both passed in
 * succession." The reducer enforces no alternation, so — as with deployment — the order lives
 * here. Returns null once both have passed.
 */
export function gambitToAct(state: GameState): PlayerId | null {
  if (bothPassedGambit(state)) return null;
  const init = state.initiative ?? 'p1';
  const other = otherPlayer(init);
  if (state.teams[init].passedGambit) return other;
  if (state.teams[other].passedGambit) return init;
  // Neither has passed: the initiative player leads, then they alternate by gambits used.
  return state.teams[init].gambitsUsedTP.length <= state.teams[other].gambitsUsedTP.length ? init : other;
}

export function counteractCandidates(ctx: GameContext, state: GameState, player: PlayerId) {
  return aliveOperatives(state, player)
    .filter((o) => o.expended && !o.counteractedThisTP)
    .filter(
      (o) => ctx.hooks.emit('onCounteract', state, { state, operative: o, allowed: o.order === 'engage' }).allowed,
    )
    // "That friendly operative cannot counteract during the turning point" after On Guard.
    .filter((o) => o.guardSpentTP !== state.turningPoint);
}

/**
 * How many actions the operative currently counteracting is allowed.
 *
 * Core rules: "you can select one of their expended operatives with an Engage order to perform
 * a 1AP action (excluding Guard) for free" — ONE action, which is the default here. A team rule
 * may raise it: Deathwatch's Veteran Astartes prints "Whenever it does, it can perform an
 * additional 1AP action for free during that counteraction".
 *
 * Asked at the moment of the action rather than stored at the start of the counteraction, so a
 * ploy used mid-counteraction is honoured. Exported because the reducer, the AI's legal-intent
 * enumeration and the UI must all read one answer rather than three copies of the number.
 */
export function counteractActionsAllowed(ctx: GameContext, state: GameState, op: OperativeState): number {
  return ctx.hooks.emit('counteractActions', state, { state, operative: op, actions: 1 }).actions;
}

/**
 * The inches of movement left in this counteraction.
 *
 * "That operative cannot move more than 2\", or must be set up wholly within 2\" if it's removed
 * and set up again, while counteracting (this is not a change to its Move stat, and takes
 * precedence over all other rules)." The cap is on the COUNTERACTION, not on each action in it,
 * so with two actions granted a flat 2" per action would let an operative Reposition 2" and then
 * Dash 2". What has already been spent is accumulated on the counteract state by `applyMove`.
 */
export function counteractMoveLeft(state: GameState, op: OperativeState): number {
  const c = state.opState['counteract'];
  if (c?.['operativeId'] !== op.id) return Infinity;
  return Math.max(0, COUNTERACT_MOVE_CAP - Number(c['movedInches'] ?? 0));
}

/** "That operative cannot move more than 2\" … while counteracting". */
export const COUNTERACT_MOVE_CAP = 2;

/**
 * On Guard: "Once during each enemy operative's activation, after that enemy operative
 * performs an action, you can interrupt that activation and select one friendly operative
 * on guard to perform the Fight or Shoot action for free."
 */
export function guardInterruptCandidates(state: GameState, defender: PlayerId) {
  return aliveOperatives(state, defender).filter((o) => o.onGuard);
}

// ---------------------------------------------------------------------------
// End of turning point
// ---------------------------------------------------------------------------

/**
 * End of the turning point, in the order the rules resolve it.
 *
 * `scoreEndOfTurningPoint` is passed in and called BETWEEN the `onEndOfTP` emit and the expiry
 * sweep. It used to run after `endTurningPoint` had already returned, so every effect with
 * `expiry.kind === 'endOfTurningPoint'` — 119 of them across `src/` — was gone before the crit
 * op read marker control. Marker control is decided by total contesting APL, and APL modifiers
 * reach `aplOf` through `onStatMod` hooks that read `state.effects`, so a ploy bought precisely
 * to win the end-of-turning-point control check expired a few lines before the check ran.
 * Tempestus Aquilons' DROP AND SECURE had already been given `endOfBattle` expiry to work
 * around this, with a comment naming the ordering.
 */
export function endTurningPoint(
  ctx: GameContext,
  state: GameState,
  score?: (ctx: GameContext, state: GameState) => void,
): void {
  removeIncapacitated(ctx, state);
  ctx.hooks.emit('onEndOfTP', state, { state });
  score?.(ctx, state);
  expireEffects(state);
  log(state, { kind: 'system', text: `End of turning point ${state.turningPoint}` });
}

export function expireEffects(state: GameState): void {
  state.effects = state.effects.filter((e) => {
    switch (e.expiry.kind) {
      case 'endOfTurningPoint':
      case 'startOfNextTurningPoint':
      case 'endOfAction':
        return false;
      case 'nActivations':
        return e.expiry.remaining > 0;
      default:
        return true;
    }
  });
}

/** Called when an activation ends, to expire per-activation effects. */
export function expireActivationEffects(state: GameState, operativeId: string): void {
  state.effects = state.effects.filter((e) => {
    if (e.expiry.kind === 'endOfActivation' && e.expiry.operativeId === operativeId) return false;
    if (e.expiry.kind === 'endOfNextActivation' && e.expiry.operativeId === operativeId) {
      if (e.expiry.armed) {
        if (e.operativeId) {
          // fall through: the effect is removed below
        }
        return false;
      }
      e.expiry.armed = true;
      return true;
    }
    if (e.expiry.kind === 'nActivations') {
      e.expiry.remaining -= 1;
      return e.expiry.remaining > 0;
    }
    return true;
  });
}

/** Smoke markers last "a number of activations equal to that D3... or the end of the TP". */
export function tickSmoke(state: GameState): void {
  for (const marker of Object.values(state.markers)) {
    if (marker.kind !== 'smoke') continue;
    const left = Number(marker.flags['activationsLeft'] ?? 0);
    if (left <= 1) delete state.markers[marker.id];
    else marker.flags['activationsLeft'] = left - 1;
  }
}

export function battleShouldEnd(state: GameState): boolean {
  return state.turningPoint > state.maxTurningPoints;
}

export function determineWinner(state: GameState): PlayerId | 'draw' {
  const a = state.teams.p1.vp;
  const b = state.teams.p2.vp;
  if (a === b) return 'draw';
  return a > b ? 'p1' : 'p2';
}
