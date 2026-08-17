/**
 * The Approved Ops setup wizard (Appendix › GAME SEQUENCE steps 1–3):
 *   killzone + map → crit op → roll-off → drop zone → rosters (secret) → equipment (secret)
 *   → tac op (secret) → equipment placement (alternating, item by item)
 *   → deployment (one third of the kill team at a time, alternating, wholly within the drop
 *     zone, Conceal order).
 *
 * Secret steps get a hand-over screen so pass-and-play does not leak information.
 */
import { useState } from 'preact/hooks';
import type { Store } from '../store.ts';
import type { TeamData, TeamSummary } from '../data.ts';
import type { PlayerId, Vec2 } from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { RosterBuilder } from '../roster/RosterBuilder.tsx';
import { applyLoadouts } from '../../teams/selection.ts';

export interface SetupProps {
  store: Store;
  /** The picker's rows; a team's full JSON is fetched by the builder through `loadTeam`. */
  teams: (TeamSummary | TeamData)[];
  loadTeam?: (id: string) => Promise<TeamData | null>;
  /** Board click plumbing so operatives are placed by tapping the map. */
  pendingPlacement: { operativeId: string; player: PlayerId } | null;
  setPendingPlacement: (p: { operativeId: string; player: PlayerId } | null) => void;
}

const PLAYERS: PlayerId[] = ['p1', 'p2'];
const LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };

export function Setup({ store, teams, loadTeam, pendingPlacement, setPendingPlacement }: SetupProps) {
  const { state, ctx } = store;
  const [handedOver, setHandedOver] = useState<PlayerId | null>(null);
  /** `state.setup.step` is nudged directly for the reveal (the reducer has no intent for it). */
  const [, force] = useState(0);
  const step = state.setup.step;

  if (state.phase !== 'setup') return null;

  // --- roll-off ----------------------------------------------------------
  if (step === 'rollOff') {
    return (
      <section class="card">
        <h2>Roll off</h2>
        <p class="muted">The winner decides who has initiative; the initiative player then picks a drop zone.</p>
        <button class="primary" onClick={() => store.dispatch({ t: 'RollOff', kind: 'initiative' })}>
          🎲 Roll off
        </button>
      </section>
    );
  }

  // --- drop zone ---------------------------------------------------------
  if (step === 'chooseDropZone') {
    const chooser = state.setup.toAct ?? 'p1';
    return (
      <section class="card">
        <h2>Drop zone — {LABEL[chooser]}</h2>
        <p class="muted">
          The opponent receives the Re-roll initiative card. Each player selects a different drop zone,
          starting with the player with initiative.
        </p>
        <div class="row">
          <button onClick={() => store.dispatch({ t: 'ChooseInitiative', player: chooser, choice: chooser })}>
            Take initiative
          </button>
          <button
            onClick={() => store.dispatch({ t: 'ChooseInitiative', player: chooser, choice: otherPlayer(chooser) })}
          >
            Give initiative to {LABEL[otherPlayer(chooser)]}
          </button>
        </div>
        <div class="row" style={{ marginTop: 8 }}>
          <button class="primary" onClick={() => store.dispatch({ t: 'ChooseDropZone', player: chooser, zone: 'p1' })}>
            Take the orange drop zone
          </button>
          <button class="primary" onClick={() => store.dispatch({ t: 'ChooseDropZone', player: chooser, zone: 'p2' })}>
            Take the grey drop zone
          </button>
        </div>
      </section>
    );
  }

  // --- secret selections -------------------------------------------------
  if (step === 'selectOperatives') {
    const next = PLAYERS.find((p) => state.teams[p].operativeIds.length === 0);
    if (!next) {
      return (
        <section class="card">
          <h2>Reveal</h2>
          <p class="muted">Both kill teams are selected. Reveal them simultaneously.</p>
          <div class="row">
            {PLAYERS.map((p) => (
              <span key={p} class="tag">
                {LABEL[p]}: {teams.find((t) => t.id === state.teams[p].teamId)?.name ?? state.teams[p].teamId} ·{' '}
                {state.teams[p].operativeIds.length} operatives
              </span>
            ))}
          </div>
          <div class="row" style={{ marginTop: 8 }}>
            <button
              class="primary"
              onClick={() => {
                state.setup.step = 'deploy';
                force((n) => n + 1);
              }}
            >
              Reveal and continue
            </button>
          </div>
        </section>
      );
    }
    if (handedOver !== next) {
      return (
        <section class="card">
          <h2>Secret — {LABEL[next]}</h2>
          <p class="muted">Hand the device to {LABEL[next]}, then tap below. Kill teams are selected secretly.</p>
          <button class="primary" onClick={() => setHandedOver(next)}>
            I am {LABEL[next]}
          </button>
        </section>
      );
    }
    return (
      <RosterBuilder
        // A fresh builder per player: pass-and-play must never show one player the other's picks.
        key={next}
        teams={teams}
        loadTeam={loadTeam}
        title={`Select operatives — ${LABEL[next]}`}
        confirmLabel={`Lock in ${LABEL[next]}'s kill team`}
        onConfirm={({ teamId, picks, weapons, datacards }) => {
          // The context only carries the implemented teams' datacards up front, so the
          // chosen team's (REQUISITIONED borrowings included) are registered here — before
          // `SelectRoster` asks the reducer to resolve them.
          for (const card of datacards) ctx.datacards.set(card.id, card);
          const ok = store.dispatch({
            t: 'SelectRoster',
            player: next,
            teamId,
            operatives: picks.map((p, i) => ({
              datacardId: p.datacardId,
              ...(p.loadoutIds?.[0] ? { loadoutId: p.loadoutIds[0] } : p.loadoutId ? { loadoutId: p.loadoutId } : {}),
              weapons: weapons[i] ?? [],
            })),
          });
          // The reducer keeps no loadout of its own, so the resolved weapons are recorded in the
          // op-state scratch space the team modules read (`selection.applyLoadouts`).
          if (ok) applyLoadouts(store.state, store.state.teams[next].operativeIds, weapons);
          setHandedOver(null);
        }}
      />
    );
  }

  // --- deployment --------------------------------------------------------
  const deployer = deployTurn(store);
  const undeployed = Object.values(state.operatives).filter((o) => o.player === deployer && o.pos.x < -50);

  return (
    <section class="card">
      <h2>Deploy — {LABEL[deployer]}</h2>
      <p class="muted">
        Alternate setting up one third of your kill team (rounding up), starting with the player with
        initiative. Operatives must be set up wholly within your drop zone and given a Conceal order.
      </p>
      {pendingPlacement ? (
        <p>
          Tap the board to place <strong>{state.operatives[pendingPlacement.operativeId]?.letter}</strong>.{' '}
          <button onClick={() => setPendingPlacement(null)}>Cancel</button>
        </p>
      ) : (
        <div class="row">
          {undeployed.map((op) => (
            <button key={op.id} onClick={() => setPendingPlacement({ operativeId: op.id, player: deployer })}>
              Place {op.letter}
            </button>
          ))}
          {undeployed.length === 0 && (
            <button class="primary" onClick={() => store.dispatch({ t: 'FinishSetup' })}>
              Begin the battle
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Alternating deployment in thirds, rounding up. */
export function deployTurn(store: Store): PlayerId {
  const { state } = store;
  const init = state.initiative ?? 'p1';
  const other = otherPlayer(init);
  const done = (p: PlayerId) => state.setup.deployedCount[p] ?? 0;
  const size = (p: PlayerId) => state.teams[p].operativeIds.length;
  const third = (p: PlayerId) => Math.ceil(size(p) / 3);
  if (size(init) === 0) return init;
  const initBatches = Math.floor(done(init) / Math.max(1, third(init)));
  const otherBatches = Math.floor(done(other) / Math.max(1, third(other)));
  if (done(init) >= size(init)) return other;
  if (done(other) >= size(other)) return init;
  return initBatches <= otherBatches ? init : other;
}

/** Board click handler used while a placement is armed. */
export function placeAt(store: Store, placement: { operativeId: string; player: PlayerId }, world: Vec2): boolean {
  return store.dispatch({
    t: 'DeployOperative',
    player: placement.player,
    operativeId: placement.operativeId,
    pos: world,
  });
}
