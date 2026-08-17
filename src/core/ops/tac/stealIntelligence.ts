/**
 * Infiltration tac op — Steal Intelligence.
 *
 * "Whenever an enemy operative is incapacitated, before it's removed from the killzone, place
 * one of your Intelligence mission markers within its control range... each friendly operative
 * can carry up to two Intelligence mission markers, or one and one other marker."
 *
 * The core Pick Up Marker action allows one carried marker, so the second carry is offered as
 * a separate mission action treated as Pick Up Marker (see docs/OPS.md).
 */
import { registerAction } from '../../actions.ts';
import { log, markerContestedBy } from '../../state.ts';
import {
  END_OF_BATTLE_SLOT,
  awardVP,
  binding,
  isEngagedWithEnemy,
  registerSharedOpHooks,
  revealTacOp,
  type OpModule,
} from '../common.ts';
import { opText } from '../text.ts';
import type { GameState, MarkerState, PlayerId } from '../../types.ts';

const ID = 'tac.stealIntelligence';

export const intelligenceMarkers = (state: GameState, player: PlayerId): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.kind === 'intelligence' && m.owner === player);

export const carriedIntelligence = (state: GameState, player: PlayerId): MarkerState[] =>
  intelligenceMarkers(state, player).filter((m) => {
    const carrier = m.carriedBy ? state.operatives[m.carriedBy] : undefined;
    return !!carrier && !carrier.removed && carrier.player === player;
  });

const carriedBy = (state: GameState, operativeId: string): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.carriedBy === operativeId);

registerAction({
  id: 'Pick Up Intelligence',
  name: 'Pick Up Intelligence',
  ap: 1,
  type: 'mission',
  treatedAs: 'Pick Up Marker',
  sourceText:
    'Friendly operatives can perform the Pick Up Marker action on your Intelligence mission markers, and for the purposes of that action’s conditions, ignore the first Intelligence mission marker the active operative is carrying.',
  available: (_ctx, state, op) => state.teams[op.player].tacOpId === ID,
  check(ctx, state, op, params) {
    if (isEngagedWithEnemy(ctx, state, op))
      return { ok: false, reason: 'within control range of an enemy operative' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker || marker.kind !== 'intelligence' || marker.owner !== op.player)
      return { ok: false, reason: 'select one of your Intelligence mission markers' };
    if (marker.carriedBy) return { ok: false, reason: 'that marker is already being carried' };
    if (!markerContestedBy(ctx, state, marker, op))
      return { ok: false, reason: 'the active operative does not control that marker' };
    const held = carriedBy(state, op.id);
    const ignorable = held.filter((m) => m.kind === 'intelligence').length > 0 ? 1 : 0;
    if (held.length - ignorable >= 1) return { ok: false, reason: 'already carrying a marker' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.carriedBy = op.id;
    marker.pos = { ...op.pos };
    marker.z = op.z;
    if (!op.carryingMarkerId) op.carryingMarkerId = marker.id;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} picks up an Intelligence marker` });
    return { ok: true };
  },
});

export const stealIntelligenceOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Infiltration',
  name: 'Steal Intelligence',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
    reg.on('onIncapacitated', binding(`${ID}.place`, opText(ID), player, 60), (ev, b) => {
      if (ev.prevented) return;
      const owner = b.player;
      if (!owner || ev.operative.player === owner) return;
      if (ev.state.teams[owner].tacOpId !== ID) return;
      const id = `intel-${ev.state.seq++}`;
      ev.state.markers[id] = {
        id,
        kind: 'intelligence',
        diameterMm: 20,
        pos: { ...ev.operative.pos },
        z: ev.operative.z,
        owner,
        flags: { pickUpAllowed: true },
      };
      revealTacOp(ev.state, owner, 'an enemy operative was incapacitated');
      log(ev.state, {
        kind: 'action',
        player: owner,
        text: `An Intelligence mission marker is placed where ${ev.operative.letter} fell`,
      });
      // A carrier that dies drops everything it was holding (the core rules only move the one
      // marker recorded on the operative).
      for (const m of carriedBy(ev.state, ev.operative.id)) {
        m.carriedBy = undefined as unknown as string | undefined;
        m.pos = { ...ev.operative.pos };
        m.z = ev.operative.z;
      }
    });
    // Extra carried Intelligence markers ride along with their carrier.
    reg.on('onActivationEnd', binding(`${ID}.carry`, opText(ID), player, 60), (ev) => {
      for (const m of carriedBy(ev.state, ev.operative.id)) {
        m.pos = { ...ev.operative.pos };
        m.z = ev.operative.z;
      }
    });
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    if (carriedIntelligence(state, player).length > 0)
      awardVP(ctx, state, player, ID, 1, 'Steal Intelligence: carrying Intelligence markers');
  },
  scoreEndOfBattle(ctx, state, player) {
    const n = carriedIntelligence(state, player).length;
    if (n > 0)
      awardVP(ctx, state, player, ID, n, `Steal Intelligence: carrying ${n} marker(s)`, END_OF_BATTLE_SLOT);
  },
};
