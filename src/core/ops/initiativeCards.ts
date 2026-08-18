/**
 * Approved Ops initiative cards.
 *
 * "To determine initiative during each turning point (including the first), the players roll
 * off (but don't re-roll ties). Starting with the loser of the roll-off, each player alternates
 * either using an initiative card to alter their roll result or passing, until they both pass
 * in succession. If player(s) would use their kill team's rules to affect the roll-off, they
 * must do so before playing initiative cards, starting with the player that's losing the roll
 * off... The winner of the roll-off decides who has initiative. Excluding the fourth turning
 * point, the loser of the roll-off gains an initiative card equal to the turning point number.
 * If the roll-off is a tie, the player who doesn't currently have initiative is the winner."
 */
import type { GameContext } from '../context.ts';
import { log, recordRoll } from '../state.ts';
import { opScratch, pushOpDecision, PLAYERS } from './common.ts';
import { INITIATIVE_CARD_TEXT } from './text.ts';
import type { GameState, PendingDecision, PlayerId } from '../types.ts';
import { otherPlayer, playerLabel } from '../types.ts';

export const REROLL_CARD = 'ic.reroll';
export const INITIATIVE_CARDS = INITIATIVE_CARD_TEXT.cards;

export const cardById = (id: string) => INITIATIVE_CARDS.find((c) => c.id === id);

/** "the loser of the roll-off gains an initiative card equal to the turning point number". */
export const cardForTurningPoint = (tp: number): string | undefined =>
  INITIATIVE_CARD_TEXT.cardForTurningPoint[String(tp)];

interface InitiativeScratch extends Record<string, unknown> {
  tp: number;
  /** The raw dice, before any modifier. */
  base: Record<string, number>;
  /** Kill-team rule modifiers, applied before cards. */
  teamMod: Record<string, number>;
  /** Card modifiers played so far. */
  cardMod: Record<string, number>;
  passes: number;
  toAct?: PlayerId;
  step: 'cards' | 'chooseInitiative' | 'done';
}

const scratch = (state: GameState): InitiativeScratch =>
  opScratch<InitiativeScratch>(state, 'initiative', () => ({
    tp: 0,
    base: {},
    teamMod: {},
    cardMod: {},
    passes: 0,
    step: 'done',
  }));

export function initiativeResult(state: GameState, player: PlayerId): number {
  const s = scratch(state);
  return (s.base[player] ?? 0) + (s.teamMod[player] ?? 0) + (s.cardMod[player] ?? 0);
}

/** Who is currently losing? A tie goes to the player without initiative, so they are winning. */
export function rollOffLoser(state: GameState): PlayerId {
  const p1 = initiativeResult(state, 'p1');
  const p2 = initiativeResult(state, 'p2');
  if (p1 === p2) return state.initiative ?? 'p1';
  return p1 > p2 ? 'p2' : 'p1';
}

export const rollOffWinner = (state: GameState): PlayerId => otherPlayer(rollOffLoser(state));

/** "The player with initiative selects one drop zone. Their opponent... gains the Re-roll card." */
export function grantSetupRerollCard(state: GameState, player: PlayerId): void {
  const cards = state.teams[player].initiativeCards;
  if (cards.includes(REROLL_CARD)) return;
  cards.push(REROLL_CARD);
  log(state, { kind: 'system', player, text: `${playerLabel(player)} gains the Re-roll initiative card` });
}

function cardDecision(state: GameState, player: PlayerId): void {
  const held = state.teams[player].initiativeCards;
  const options = held.flatMap((id) => {
    const card = cardById(id);
    if (!card) return [];
    if (card.kind === 'reroll')
      return [{ id: `${id}|reroll`, label: `${card.name}: re-roll your initiative roll`, data: { cardId: id } }];
    const m = card.magnitude ?? 0;
    return [
      { id: `${id}|+${m}`, label: `${card.name}: +${m}`, data: { cardId: id, delta: m } },
      { id: `${id}|-${m}`, label: `${card.name}: -${m}`, data: { cardId: id, delta: -m } },
    ];
  });
  pushOpDecision(state, {
    id: `initiative-${player}-tp${state.turningPoint}-${scratch(state).passes}-${
      state.teams[player].initiativeCards.length
    }`,
    who: player,
    kind: 'initiativeCard',
    prompt: `Initiative (${initiativeResult(state, 'p1')} vs ${initiativeResult(state, 'p2')}): play an initiative card or pass`,
    sourceText: INITIATIVE_CARD_TEXT.rules,
    optional: true,
    options: [...options, { id: 'pass', label: 'Pass' }],
  });
}

/** Alternate to the next player, or finish once both have passed in succession. */
function advance(ctx: GameContext, state: GameState): void {
  const s = scratch(state);
  if (s.passes >= 2) {
    finishRollOff(ctx, state);
    return;
  }
  const next = otherPlayer(s.toAct ?? 'p1');
  s.toAct = next;
  if (state.teams[next].initiativeCards.length === 0) {
    // Nothing to play — an automatic pass, so the sequence cannot stall.
    s.passes += 1;
    advance(ctx, state);
    return;
  }
  cardDecision(state, next);
}

/**
 * Roll off for initiative and open the initiative-card window. Replaces the plain roll-off in
 * `phases.rollInitiative` for Approved Ops battles.
 */
export function beginInitiative(ctx: GameContext, state: GameState): void {
  const s = scratch(state);
  s.tp = state.turningPoint;
  s.passes = 0;
  s.cardMod = {};
  s.step = 'cards';
  const a = ctx.rng.d6();
  const b = ctx.rng.d6();
  s.base = { p1: a, p2: b };
  s.teamMod = {
    p1: ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p1', mod: 0, rerollOffered: false }).mod,
    p2: ctx.hooks.emit('initiativeRollModifiers', state, { state, player: 'p2', mod: 0, rerollOffered: false }).mod,
  };
  recordRoll(state, 'initiative', [a, b], undefined, `TP${state.turningPoint}`);
  log(state, {
    kind: 'dice',
    text: `Initiative roll-off: P1 ${initiativeResult(state, 'p1')} vs P2 ${initiativeResult(state, 'p2')}`,
  });
  // "Starting with the loser of the roll-off..."
  const loser = rollOffLoser(state);
  s.toAct = otherPlayer(loser);
  s.passes = 0;
  advance(ctx, state);
}

/** The winner decides who has initiative; then the loser gains this turning point's card. */
function finishRollOff(ctx: GameContext, state: GameState): void {
  const s = scratch(state);
  s.step = 'chooseInitiative';
  const winner = rollOffWinner(state);
  pushOpDecision(state, {
    id: `chooseInitiative-tp${state.turningPoint}`,
    who: winner,
    kind: 'chooseInitiative',
    prompt: 'You won the roll-off — decide who has initiative',
    sourceText: 'The winner of the roll-off decides who has initiative.',
    options: PLAYERS.map((p) => ({ id: p, label: p === winner ? 'Take initiative' : 'Give initiative to your opponent' })),
  });
  void ctx;
}

function completeInitiative(state: GameState, choice: PlayerId): void {
  const s = scratch(state);
  const loser = rollOffLoser(state);
  state.initiative = choice;
  log(state, { kind: 'system', text: `${choice} has initiative` });
  const card = state.turningPoint < 4 ? cardForTurningPoint(state.turningPoint) : undefined;
  if (card) {
    state.teams[loser].initiativeCards.push(card);
    log(state, {
      kind: 'system',
      player: loser,
      text: `Loses the roll-off and gains the ${cardById(card)?.name ?? card} initiative card`,
    });
  }
  s.step = 'done';
  s.toAct = undefined;
}

/** Resolve an initiative decision. Returns false if this decision is not ours. */
export function resolveInitiativeDecision(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  const s = scratch(state);
  if (decision.kind === 'chooseInitiative') {
    completeInitiative(state, optionId === 'p2' ? 'p2' : 'p1');
    return true;
  }
  if (decision.kind !== 'initiativeCard') return false;
  const player = decision.who;
  if (optionId === 'pass' || optionId === 'keep') {
    s.passes += 1;
    log(state, { kind: 'decision', player, text: 'passes on initiative cards' });
    advance(ctx, state);
    return true;
  }
  const cardId = String(data?.['cardId'] ?? optionId.split('|')[0]);
  const card = cardById(cardId);
  const held = state.teams[player].initiativeCards;
  const idx = held.indexOf(cardId);
  if (!card || idx < 0) return false;
  held.splice(idx, 1);
  if (card.kind === 'reroll') {
    const v = ctx.rng.d6();
    recordRoll(state, 'initiative-reroll', [v], player, 'Re-roll initiative card');
    s.base[player] = v;
    // "the new result supersedes their modification(s) used so far"
    s.cardMod[player] = 0;
    log(state, { kind: 'dice', player, text: `Re-roll initiative card: new result ${v}` });
  } else {
    const delta = Number(data?.['delta'] ?? (optionId.includes('-') ? -(card.magnitude ?? 0) : (card.magnitude ?? 0)));
    s.cardMod[player] = (s.cardMod[player] ?? 0) + delta;
    log(state, {
      kind: 'decision',
      player,
      text: `${card.name} initiative card: ${delta > 0 ? '+' : ''}${delta} (result ${initiativeResult(state, player)})`,
    });
  }
  s.passes = 0;
  advance(ctx, state);
  return true;
}
