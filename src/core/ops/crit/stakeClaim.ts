/**
 * Crit op 5 — Stake Claim.
 *
 * "At the start of the Gambit step of each Strategy phase after the first, starting with the
 * player with initiative, each player must select both one objective marker and one of the
 * following claims for that turning point... Each player cannot select each objective marker
 * more than once per battle."
 *
 * The selection is raised as a PendingDecision for each player (so pass-and-play can hide it)
 * at the Ready step, which is the last moment before the Gambit step: the reducer blocks every
 * other intent until both are answered.
 */
import { log, markerController } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  contestedByPlayer,
  controlledObjectives,
  objectiveMarkers,
  opScratch,
  pushOpDecision,
  registerSharedOpHooks,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameState, PlayerId } from '../../types.ts';

const ID = 'crit.stakeClaim';

export type ClaimKind = 'control' | 'uncontested';

interface ClaimScratch extends Record<string, unknown> {
  /** player -> marker ids already claimed this battle. */
  used: Record<string, string[]>;
  /** player -> this turning point's claim. */
  claim: Record<string, { markerId: string; kind: ClaimKind; tp: number } | undefined>;
}

const scratch = (state: GameState): ClaimScratch =>
  opScratch<ClaimScratch>(state, ID, () => ({ used: { p1: [], p2: [] }, claim: {} }));

export const claimOf = (state: GameState, player: PlayerId) => scratch(state).claim[player];

function raiseClaimDecision(state: GameState, player: PlayerId): void {
  if (state.turningPoint < 2) return;
  const s = scratch(state);
  const used = s.used[player] ?? [];
  const options = objectiveMarkers(state)
    .filter((m) => !used.includes(m.id))
    .flatMap((m) => [
      {
        id: `${m.id}|control`,
        label: `${m.id}: friendly operatives will control it at the end of this turning point`,
        data: { markerId: m.id, kind: 'control' },
      },
      {
        id: `${m.id}|uncontested`,
        label: `${m.id}: enemy operatives won't contest it at the end of this turning point`,
        data: { markerId: m.id, kind: 'uncontested' },
      },
    ]);
  if (options.length === 0) return;
  pushOpDecision(state, {
    id: `stakeClaim-${player}-tp${state.turningPoint}`,
    who: player,
    kind: 'stakeClaim',
    prompt: 'Stake Claim: select an objective marker and a claim for this turning point',
    sourceText:
      'Each player cannot select each objective marker more than once per battle (so they must select each objective marker once during the battle).',
    options,
  });
}

export const stakeClaimOp: OpModule = {
  id: ID,
  kind: 'crit',
  name: 'Stake Claim',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
    reg.on(
      'onReadyStep',
      { id: `${ID}.select`, sourceText: opText(ID), player, priority: 10 },
      (ev, b) => {
        if (b.player !== ev.player) return;
        raiseClaimDecision(ev.state, ev.player);
      },
    );
  },
  resolveDecision(_ctx, state, decision, _optionId, data) {
    if (decision.kind !== 'stakeClaim') return false;
    const markerId = String(data?.['markerId'] ?? '');
    const kind = (data?.['kind'] === 'uncontested' ? 'uncontested' : 'control') as ClaimKind;
    if (!state.markers[markerId]) return false;
    const s = scratch(state);
    s.claim[decision.who] = { markerId, kind, tp: state.turningPoint };
    s.used[decision.who] = [...(s.used[decision.who] ?? []), markerId];
    log(state, { kind: 'system', player: decision.who, text: 'Stake Claim selected (secret)' });
    return true;
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const mine = controlledObjectives(ctx, state, player).length;
    const theirs = controlledObjectives(ctx, state, otherPlayer(player)).length;
    if (mine > theirs) awardVP(ctx, state, player, ID, 1, 'Stake Claim: controlling more objective markers');
    const claim = claimOf(state, player);
    if (!claim || claim.tp !== state.turningPoint) return;
    const marker = state.markers[claim.markerId];
    if (!marker) return;
    const ok =
      claim.kind === 'control'
        ? markerController(ctx, state, marker) === player
        : !contestedByPlayer(ctx, state, marker, otherPlayer(player));
    if (ok) awardVP(ctx, state, player, ID, 1, `Stake Claim: the ${claim.kind} claim on ${marker.id} is true`);
  },
};
