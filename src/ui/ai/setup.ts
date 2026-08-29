/**
 * Setup, for a seat nobody is sitting in.
 *
 * The AI package cannot do any of this. `actorFor` returns null for `phase === 'setup'` and
 * `legalIntents` enumerates no setup intent at all, so `Agent.act` is never even consulted
 * before the first activation — every bot game in `tests/soak` gets through setup because
 * `playGame` scripts it by hand. This module is the app's equivalent, with two differences
 * from the runner's script that both matter:
 *
 * - **It goes through `BeginDeployment`.** The runner deploys straight out of
 *   `selectOperatives`, which works only because `DeployOperative` does not check the step —
 *   so `setup.revealed` is never written and `setup.step` never becomes `placeEquipment`,
 *   which is the only way a barricade or a ladder ever reaches the killzone.
 * - **It uses the printed deployment order.** The runner alternates one operative at a time;
 *   the rule (and `deployToAct`) is alternating *thirds*, rounding up.
 *
 * Every step reads the same selector the human's screen reads — `deployToAct`,
 * `equipmentToAct`, `state.initiative` — so the two sides of a solo battle cannot disagree
 * about whose turn it is.
 */
import { equipmentToAct } from '../../core/equipment/index.ts';
import { deployToAct } from '../../core/phases.ts';
import { canDeployAt } from '../../core/reducer.ts';
import type { GameState, PlayerId } from '../../core/types.ts';
import { PLAYERS } from '../../core/ops/common.ts';
import { deployPositions } from '../../ai/deploy.ts';
import type { Store } from '../store.ts';
import type { TeamData } from '../data.ts';
import { AI_DISPATCH, aiEquipmentIds, aiSelectRoster, aiTacOpId, chooseAiTeamId, playableTeams } from './roster.ts';
import { isAi, isWatching, type OpponentConfig } from './opponent.ts';

/** What the AI owes during setup, if anything. Cheap: no roster is built to answer it. */
export interface SetupTurn {
  player: PlayerId;
  note: string;
}

/**
 * Whose setup intent is next, when that seat is an AI.
 *
 * The three steps with no owner — the roll-off, the reveal, and beginning the battle — are
 * deliberately NOT claimed while a person is in the game. They are the beats where a solo
 * player looks at the board and presses on; taking them away would turn setup into a cutscene.
 * With both seats driven there is nobody to press them, so the driver takes them too.
 */
export function aiSetupTurn(state: GameState, opponent: OpponentConfig): SetupTurn | null {
  if (state.phase !== 'setup') return null;
  const watching = isWatching(opponent);
  const mine = (player: PlayerId, note: string): SetupTurn | null => (isAi(opponent, player) ? { player, note } : null);
  const shared = (note: string): SetupTurn | null =>
    watching ? { player: state.initiative ?? state.setup.toAct ?? 'p1', note } : null;

  switch (state.setup.step) {
    case 'rollOff':
      return shared('rolls off for initiative');

    case 'chooseDropZone': {
      if (state.initiative === undefined) return mine(state.setup.toAct ?? 'p1', 'is deciding who has initiative');
      return mine(state.initiative, 'is picking a drop zone');
    }

    case 'selectOperatives': {
      const unrostered = PLAYERS.find((p) => state.teams[p].operativeIds.length === 0);
      if (unrostered) return mine(unrostered, 'is choosing its kill team');
      // `SelectTacOp` is the only caller of `ctx.initOps`, and only once BOTH teams have one,
      // so a seat that skips this stops the other player's ops initialising too.
      const owing = PLAYERS.find((p) => !state.teams[p].tacOpId);
      if (owing) return mine(owing, 'is choosing equipment and a tac op');
      return shared('reveals both kill teams');
    }

    case 'placeEquipment': {
      const who = equipmentToAct(state);
      return who ? mine(who, 'is setting up its equipment') : shared('finishes setting up equipment');
    }

    case 'deploy': {
      const who = deployToAct(state);
      return who ? mine(who, 'is deploying') : shared('begins the battle');
    }

    default:
      return null;
  }
}

export interface SetupDeps {
  store: Store;
  teams: TeamData[];
  opponent: OpponentConfig;
}

/**
 * Which kill team this AI seat fields.
 *
 * `opponent.teamId` is one field for what the player thinks of as one thing — "the AI's kill
 * team" — so with both seats driven it names Player 2's and lets Player 1's come from the
 * seed, rather than turning every watched battle into a mirror match.
 */
export function aiTeamIdFor(state: GameState, teams: TeamData[], opponent: OpponentConfig, player: PlayerId): string | undefined {
  const named: PlayerId = isAi(opponent, 'p2') ? 'p2' : 'p1';
  // The choice is persisted, so it can outlive the data it names — a team renamed or dropped
  // from `data/teams` would otherwise stop every future battle dead at Select Operatives, with
  // the picker still showing "chosen for you" as though nothing were wrong.
  if (player === named && opponent.teamId && playableTeams(teams).some((t) => t.id === opponent.teamId))
    return opponent.teamId;
  return chooseAiTeamId(teams, state.seed + (player === 'p2' ? 1 : 0));
}

/**
 * Dispatch exactly one setup intent for the seat `aiSetupTurn` named. Returns an error
 * sentence when it could not — never a silent no-op, because a setup that stops moving is a
 * battle that can never start and the screen behind it says nothing.
 */
export function aiSetupStep(deps: SetupDeps, turn: SetupTurn): string | null {
  const { store, teams, opponent } = deps;
  const { state } = store;
  const player = turn.player;
  const seed = state.seed;

  const send = (ok: boolean, what: string): string | null =>
    ok ? null : `the AI could not ${what}: ${store.lastRejection?.reason ?? 'the reducer refused it'}`;

  switch (state.setup.step) {
    case 'rollOff':
      return send(store.dispatch({ t: 'RollOff', kind: 'initiative' }, AI_DISPATCH), 'roll off');

    case 'chooseDropZone': {
      if (state.initiative === undefined) {
        // `decide.ts`'s `chooseInitiative` policy, applied to the one place the rules ask for
        // it outside a PendingDecision: take it. (docs/AI.md §8 lists this as a known weakness
        // — activating last is often stronger — and it is the same weakness either way.)
        return send(store.dispatch({ t: 'ChooseInitiative', player, choice: player }, AI_DISPATCH), 'choose initiative');
      }
      return send(store.dispatch({ t: 'ChooseDropZone', player, zone: player }, AI_DISPATCH), 'pick a drop zone');
    }

    case 'selectOperatives': {
      if (state.teams[player].operativeIds.length === 0) {
        const teamId = aiTeamIdFor(state, teams, opponent, player);
        if (!teamId) return 'the AI has no kill team it can field — no bundled team data';
        return aiSelectRoster(store, teams, player, teamId)
          ? null
          : `the AI could not field ${teamId}: ${store.lastRejection?.reason ?? 'the roster did not validate'}`;
      }
      if (!state.teams[player].tacOpId) {
        const equipment = aiEquipmentIds(store.ctx, seed + (player === 'p2' ? 7 : 0));
        if (equipment.length > 0 && !store.dispatch({ t: 'SelectEquipment', player, equipment }, AI_DISPATCH))
          return send(false, 'select equipment');
        const tacOpId = aiTacOpId(state, player, seed);
        if (!tacOpId) return 'no tac op is available to the AI';
        return send(store.dispatch({ t: 'SelectTacOp', player, tacOpId }, AI_DISPATCH), 'select a tac op');
      }
      const ok = store.dispatch({ t: 'BeginDeployment' }, AI_DISPATCH);
      // The same boundary the human's "Reveal and deploy" marks: a roster or a tac op cannot
      // be taken back from the deployment screen, because that is a different battle.
      if (ok) store.commitHistory();
      return send(ok, 'reveal the kill teams');
    }

    case 'placeEquipment': {
      // The AI only ever takes equipment that needs no setting up (see `aiEquipmentIds`), so
      // this is a safety net rather than a planner: say so and move the step on.
      if (equipmentToAct(state) === null) return send(store.dispatch({ t: 'AdvancePhase' }, AI_DISPATCH), 'leave equipment set-up');
      return send(store.dispatch({ t: 'SkipEquipmentPlacement', player }, AI_DISPATCH), 'skip equipment set-up');
    }

    case 'deploy': {
      if (deployToAct(state) === null) return send(store.dispatch({ t: 'FinishSetup' }, AI_DISPATCH), 'begin the battle');
      const op = state.teams[player].operativeIds
        .map((id) => state.operatives[id])
        .find((o) => o !== undefined && !o.removed && o.pos.x < -50);
      if (!op) return `${player} has nothing left to deploy but is still to act`;
      // `deployPosition` checks the drop zone, hazardous areas and base overlap; `canDeployAt`
      // also enforces the Stronghold occupancy cap. Walk the ranked list rather than
      // dispatching the head and having it refused.
      for (const pos of deployPositions(store.ctx, state, op, 32)) {
        if (!canDeployAt(store.ctx, state, op, pos, op.rot).ok) continue;
        return send(store.dispatch({ t: 'DeployOperative', player, operativeId: op.id, pos }, AI_DISPATCH), `deploy ${op.letter}`);
      }
      return `${op.letter} has nowhere legal to deploy in the ${state.setup.dropZone[player] ?? player} drop zone`;
    }

    default:
      return `the AI has no answer for the setup step '${state.setup.step}'`;
  }
}
