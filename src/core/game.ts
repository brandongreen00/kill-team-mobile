/**
 * The assembled game: a GameContext with every rule layer wired in.
 *
 * `src/core/reducer.ts` deliberately imports no rule modules — ops, equipment and teams
 * reach it through the seams on GameContext, which is what this factory fills in. That
 * keeps the reducer free of cycles (ops modules import state/actions, which the reducer
 * also imports) and lets a test build a stripped-down context when it wants one.
 */
import { makeContext, type GameContext, type PlaceEquipmentIntent } from './context.ts';
import { ALL_OPS, opsMap, initOps, resolveOpDecision, scoreEndOfBattle, scoreEndOfTurningPoint } from './ops/index.ts';
import { beginInitiative, grantSetupRerollCard } from './ops/initiativeCards.ts';
import { equipmentMap, placeEquipment } from './equipment/index.ts';
import type { TeamModule } from './hooks.ts';
import type { Rng } from './rng.ts';
import type { Datacard, GameState, KillzoneMap, PlayerId } from './types.ts';

export interface GameSetup {
  rng: Rng;
  datacards?: Iterable<Datacard>;
  maps?: Iterable<KillzoneMap>;
  teams?: Iterable<TeamModule>;
}

export function createGameContext(setup: GameSetup): GameContext {
  const ctx = makeContext({ rng: setup.rng });
  for (const dc of setup.datacards ?? []) ctx.datacards.set(dc.id, dc);
  for (const map of setup.maps ?? []) ctx.maps.set(map.id, map);
  for (const team of setup.teams ?? []) ctx.teams.set(team.id, team);

  ctx.ops = opsMap();
  ctx.equipment = equipmentMap();

  // --- seams the reducer and the decision layer call through ---------------
  ctx.scoreEndOfTurningPoint = (c, s) => scoreEndOfTurningPoint(c, s);
  ctx.scoreEndOfBattle = (c, s) => scoreEndOfBattle(c, s);
  ctx.resolveOpDecision = (c, s, id, optionId, data) => resolveOpDecision(c, s, id, optionId, data).ok;
  ctx.beginInitiative = (c, s) => beginInitiative(c, s);
  ctx.grantSetupRerollCard = (s: GameState, player: PlayerId) => grantSetupRerollCard(s, player);
  ctx.initOps = (c, s) => initOps(c, s);
  // Initiative cards are played through the decision channel (the rules make it an
  // alternating window, not a free action), so the PlayInitiativeCard intent resolves the
  // pending `initiativeCard` decision for that player.
  ctx.playInitiativeCard = (c, s, player, cardId) => {
    const decision = s.pending.find((d) => d.kind === 'initiativeCard' && d.who === player);
    if (!decision) return { ok: false, reason: 'there is no initiative-card window open for you' };
    if (!decision.options.some((o) => o.id === cardId && !o.disabled))
      return { ok: false, reason: `the ${cardId} card cannot be played now` };
    const handled = resolveOpDecision(c, s, decision.id, cardId);
    return handled.ok ? { ok: true } : { ok: false, ...(handled.reason ? { reason: handled.reason } : {}) };
  };
  ctx.placeEquipment = (c, s, intent: PlaceEquipmentIntent) =>
    placeEquipment(c, s, { t: 'PlaceEquipment', ...intent });

  return ctx;
}

/** Every op the setup wizard can offer, so the UI need not import the op modules itself. */
export const availableOps = () => ALL_OPS;
