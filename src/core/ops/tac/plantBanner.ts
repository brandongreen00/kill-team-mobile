/**
 * Security tac op — Plant Banner.
 *
 * "Place your Banner mission marker within the active operative's control range, wholly within
 * your opponent's territory and more than 5" from a neutral killzone edge."
 */
import { registerAction } from '../../actions.ts';
import { baseGap } from '../../geometry.ts';
import { card, log, markerController } from '../../state.ts';
import { otherPlayer } from '../../types.ts';
import {
  awardVP,
  contestedByPlayer,
  distanceToSegments,
  markerWhollyWithin,
  missionActionCheck,
  registerSharedOpHooks,
  revealTacOp,
  territoryOf,
  type OpModule,
} from '../common.ts';
import { opText, printedAction } from '../text.ts';
import type { GameState, MarkerState, PlayerId } from '../../types.ts';

const ID = 'tac.plantBanner';

export const bannerOf = (state: GameState, player: PlayerId): MarkerState | undefined =>
  Object.values(state.markers).find((m) => m.kind === 'banner' && m.owner === player);

registerAction({
  id: 'Plant Banner',
  name: 'Plant Banner',
  ap: 1,
  type: 'mission',
  sourceText: printedAction(ID, 'Plant Banner').text,
  available: (_ctx, state, op) => state.teams[op.player].tacOpId === ID,
  check(ctx, state, op, params) {
    const guard = missionActionCheck(ctx, state, op);
    if (!guard.ok) return guard;
    if (bannerOf(state, op.player))
      return { ok: false, reason: 'a friendly operative has already performed this action during the battle' };
    const pos = params.markerPos ?? params.targetPos;
    if (!pos) return { ok: false, reason: 'select where to place the Banner mission marker' };
    const gap = baseGap(op.pos, card(ctx, op).base, op.rot, pos, { shape: 'round', mm: 20 }, 0);
    if (gap > 1 + 1e-6) return { ok: false, reason: "the marker must be within the operative's control range" };
    const banner: MarkerState = { id: 'x', kind: 'banner', diameterMm: 20, pos, z: op.z, flags: {} };
    if (!markerWhollyWithin(banner, territoryOf(state, otherPlayer(op.player))))
      return { ok: false, reason: "the marker must be wholly within your opponent's territory" };
    const neutral = state.map.killzoneEdges.neutral;
    if (neutral.length > 0 && distanceToSegments(pos, neutral) <= 5)
      return { ok: false, reason: 'the marker must be more than 5" from a neutral killzone edge' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const pos = (params.markerPos ?? params.targetPos)!;
    const id = `banner-${op.player}`;
    state.markers[id] = {
      id,
      kind: 'banner',
      diameterMm: 20,
      pos: { ...pos },
      z: op.z,
      owner: op.player,
      flags: { pickUpAllowed: true },
    };
    revealTacOp(state, op.player, 'the Plant Banner action was performed');
    log(state, { kind: 'action', player: op.player, text: `${op.letter} plants the Banner mission marker` });
    return { ok: true };
  },
});

export const plantBannerOp: OpModule = {
  id: ID,
  kind: 'tac',
  archetype: 'Security',
  name: 'Plant Banner',
  text: opText(ID),
  register(reg, player) {
    registerSharedOpHooks(reg, player);
  },
  scoreEndOfTP(ctx, state, player) {
    if (state.turningPoint < 2) return;
    const banner = bannerOf(state, player);
    // "must be in the killzone (not being carried) to score"
    if (!banner || banner.carriedBy) return;
    if (!markerWhollyWithin(banner, territoryOf(state, otherPlayer(player)))) return;
    if (markerController(ctx, state, banner) !== player) return;
    const contested = contestedByPlayer(ctx, state, banner, otherPlayer(player));
    awardVP(ctx, state, player, ID, contested ? 1 : 2, 'Plant Banner: banner held in enemy territory');
  },
};
