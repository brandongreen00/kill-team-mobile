/**
 * App shell. One responsive codebase: phone portrait uses the bottom tab bar and keeps the
 * board on its own full-height page; desktop (>=900px) shows board + rails together.
 *
 * The dice/decision surface is deliberately available on BOTH layouts: on a phone the
 * decision panel docks under the board so a reactive window never hides the dice. The same
 * dock carries the tap-to-move controls and the deployment hint, because anything that says
 * "tap the board" must be visible WHILE the board is.
 *
 * What the rail shows follows the battle: killzone picking only exists before the battle
 * starts, the setup wizard only during setup, the action sheet only during the firefight.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useIsDesktop } from './useMedia.ts';
import { Board } from './Board.tsx';
import { SequenceOverlay } from './SequenceOverlay.tsx';
import { DecisionPanel } from './DecisionPanel.tsx';
import { ActivationPanel } from './ActivationPanel.tsx';
import { Setup, placeAt } from './flow/Setup.tsx';
import { TargetingInspector } from './TargetingInspector.tsx';
import { MapBrowser } from './MapBrowser.tsx';
import { RosterBuilder } from './roster/RosterBuilder.tsx';
import { DropZoneHighlight, MoveControls, MoveOverlay, type MovePlan } from './MovePlanner.tsx';
import { Store, setStore } from './store.ts';
import { createGameContext } from '../core/game.ts';
import { SeededRng } from '../core/rng.ts';
import { createBattle } from '../core/init.ts';
import { gambitOptions } from '../core/phases.ts';
import { loadMaps, loadTeams, type TeamData } from './data.ts';
import type { MoveAction } from '../core/movement.ts';
import type { GameState, KillzoneMap, PlayerId } from '../core/types.ts';
import { playerLabel } from '../core/types.ts';

type Tab = 'board' | 'play' | 'log' | 'roster';

const TAB_ICON: Record<Tab, string> = { board: '🗺', play: '⚔', log: '📜', roster: '📋' };
const TAB_LABEL: Record<Tab, string> = { board: 'Board', play: 'Play', log: 'Log', roster: 'Rosters' };

export function App() {
  const [maps, setMaps] = useState<KillzoneMap[]>([]);
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [store, setLocalStore] = useState<Store | null>(null);
  const [, force] = useState(0);
  const [tab, setTab] = useState<Tab>('board');
  const isDesktop = useIsDesktop();
  const [placement, setPlacement] = useState<{ operativeId: string; player: PlayerId } | null>(null);
  /** The armed tap-to-move plan; board taps append waypoints while it is set. */
  const [movePlan, setMovePlan] = useState<MovePlan | null>(null);
  /** Targeting-line inspector: tap a shooter, then a target. */
  const [inspect, setInspect] = useState<{ from?: string; to?: string }>({});

  useEffect(() => {
    void (async () => {
      const [m, t] = await Promise.all([loadMaps(), loadTeams()]);
      setMaps(m);
      setTeams(t);
      // A fully wired context: ops, equipment, the initiative-card flow and — so a roster's
      // kill team actually plays by its own rules — every implemented team module.
      const { BATCH_1 } = await import('../teams/index.ts');
      const ctx = createGameContext({
        rng: new SeededRng(1),
        maps: m,
        datacards: t.flatMap((team) => team.datacards ?? []),
        teams: BATCH_1,
      });
      const map = m[0] ?? fallbackMap();
      const s = new Store(createBattle(ctx, { map, seed: 1, mode: 'match' }), ctx);
      setStore(s);
      setLocalStore(s);
      s.subscribe(() => force((n) => n + 1));
    })();
  }, []);

  if (!store) {
    return (
      <>
        <header class="topbar">
          <h1>Kill Team</h1>
        </header>
        <main class="page">
          <div class="card">
            <h2>Loading</h2>
          </div>
        </main>
      </>
    );
  }

  const state: GameState = store.state;
  const decision = state.pending[0];
  const inBattle = state.phase !== 'setup';

  // A reactive window must be answered before anything else: jump to it on a phone.
  useEffect(() => {
    if (decision && tab === 'log') setTab('board');
  }, [decision?.id]);

  // The plan belongs to the operative that armed it: if the activation moved on, disarm.
  useEffect(() => {
    if (movePlan && state.activeOperativeId !== movePlan.operativeId) setMovePlan(null);
  }, [state.activeOperativeId]);

  const pickMap = (id: string) => {
    const map = maps.find((m) => m.id === id);
    if (!map) return;
    store.reset(createBattle(store.ctx, { map, seed: state.seed, mode: state.mode }));
  };

  /** "Tap the board" only works while the board is on screen — switch a phone to it. */
  const showBoard = () => {
    if (!isDesktop) setTab('board');
  };

  const armPlacement = (p: { operativeId: string; player: PlayerId } | null) => {
    setPlacement(p);
    if (p) showBoard();
  };

  const armMove = (operativeId: string, action: MoveAction) => {
    setMovePlan({ operativeId, action, points: [] });
    showBoard();
  };

  const boardPane = (
    <div class="board-wrap">
      <Board
        state={state}
        overlays={
          <>
            <SequenceOverlay state={state} decision={decision} />
            {placement && <DropZoneHighlight state={state} player={placement.player} />}
            {movePlan && <MoveOverlay ctx={store.ctx} state={state} plan={movePlan} />}
          </>
        }
        selectedId={movePlan?.operativeId ?? inspect.from}
        onOperativeClick={(op) => {
          if (movePlan || placement) return; // aiming taps never re-target the inspector
          setInspect((cur) => (cur.from && cur.from !== op.id ? { from: cur.from, to: op.id } : { from: op.id }));
        }}
        onBoardClick={(world) => {
          if (placement) {
            if (placeAt(store, placement, world)) setPlacement(null);
            return;
          }
          if (movePlan) {
            setMovePlan({ ...movePlan, points: [...movePlan.points, world] });
            return;
          }
          setInspect({});
        }}
      />
    </div>
  );

  const playPane = (
    <>
      {decision && <DecisionPanel store={store} decision={decision} />}
      {inspect.from && inspect.to && state.operatives[inspect.from] && state.operatives[inspect.to] && (
        <TargetingInspector
          ctx={store.ctx}
          state={state}
          shooter={state.operatives[inspect.from]!}
          target={state.operatives[inspect.to]!}
          onClose={() => setInspect({})}
        />
      )}
      {movePlan && isDesktop && <MoveControls store={store} plan={movePlan} onChange={setMovePlan} />}
      <Setup store={store} teams={teams} pendingPlacement={placement} setPendingPlacement={armPlacement} />
      {state.phase === 'strategy' && <StrategyPanel store={store} />}
      <ActivationPanel
        key={state.activeOperativeId ?? 'none'}
        store={store}
        movePlan={movePlan}
        onArmMove={armMove}
      />
      {inBattle && <BattleCard store={store} />}
      {/* Picking a killzone resets the battle, so the browser only exists before rosters are
          locked in — never while a game is being set up on the table, never during one. */}
      {state.phase === 'setup' && (state.setup.step === 'rollOff' || state.setup.step === 'chooseDropZone') && (
        <MapBrowser ctx={store.ctx} maps={maps} selectedId={state.map.id} onPick={(m) => pickMap(m.id)} />
      )}
    </>
  );

  /** The builder outside a battle: prepare and save kill teams before you sit down to play. */
  const rosterPane = (
    <RosterBuilder
      teams={teams}
      title="Roster builder"
      onCancel={() => setTab(isDesktop ? 'play' : 'board')}
    />
  );

  const logPane = <LogPanel state={state} />;

  /** Whatever the board needs answered right now, docked under it on a phone. */
  const boardDock = decision ? (
    <DecisionPanel store={store} decision={decision} />
  ) : movePlan ? (
    <MoveControls store={store} plan={movePlan} onChange={setMovePlan} />
  ) : placement ? (
    <section class="card">
      <h2>Deploy</h2>
      <p class="muted">
        Tap inside your highlighted drop zone to place{' '}
        <strong>{state.operatives[placement.operativeId]?.name}</strong>.
      </p>
      {store.lastError && <p class="err">✖ {store.lastError}</p>}
      <div class="row">
        <button onClick={() => setPlacement(null)}>Cancel</button>
      </div>
    </section>
  ) : null;

  return (
    <>
      <header class="topbar">
        <h1>Kill Team</h1>
        <span class="tag">{state.map.name}</span>
        <div class="spacer" />
        {decision && <span class="tag" style={{ color: 'var(--accent)' }}>decision: {playerLabel(decision.who)}</span>}
        {isDesktop && (
          <button onClick={() => setTab(tab === 'roster' ? 'play' : 'roster')} aria-pressed={tab === 'roster'}>
            {tab === 'roster' ? '← Back to the battle' : '📋 Rosters'}
          </button>
        )}
      </header>

      {/* Only one layout mounts at a time: the board is expensive, and two live copies
          would also make every DOM query ambiguous. */}
      {tab === 'roster' ? (
        <main class="page">{rosterPane}</main>
      ) : isDesktop ? (
        <div class="layout">
          <aside class="page">{playPane}</aside>
          {boardPane}
          <aside class="page">{logPane}</aside>
        </div>
      ) : (
        <>
          {tab === 'board' && boardPane}
          {tab === 'board' && boardDock && <div class="page dock">{boardDock}</div>}
          {tab === 'play' && <main class="page">{playPane}</main>}
          {tab === 'log' && <main class="page">{logPane}</main>}
        </>
      )}

      {!isDesktop && (
      <nav class="m-tabs" role="tablist">
        {(['board', 'play', 'roster', 'log'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            <span aria-hidden="true">{TAB_ICON[t]}</span>
            <span>{TAB_LABEL[t]}</span>
          </button>
        ))}
      </nav>
      )}
    </>
  );
}

/** Scoreboard + the one flow control the current phase actually needs. */
function BattleCard({ store }: { store: Store }) {
  const { state } = store;
  const anyReady = Object.values(state.operatives).some((o) => o.ready && !o.removed);
  return (
    <section class="card">
      <h2>Battle</h2>
      <div class="row">
        <span class="tag">TP {Math.max(1, state.turningPoint)}/{state.maxTurningPoints}</span>
        <span class="tag">{state.phase === 'battleEnd' ? 'battle over' : `${state.phase} phase`}</span>
        {state.initiative && state.phase !== 'battleEnd' && (
          <span class="tag">initiative: {playerLabel(state.initiative)}</span>
        )}
      </div>
      <div class="row" style={{ marginTop: 8 }}>
        {(['p1', 'p2'] as PlayerId[]).map((p) => (
          <span key={p} class="tag">
            {playerLabel(p)} · {state.teams[p].vp} VP · {state.teams[p].cp} CP
          </span>
        ))}
      </div>
      {state.phase === 'firefight' && (
        <div class="row" style={{ marginTop: 8 }}>
          <button
            disabled={anyReady}
            title={anyReady ? 'Operatives still have activations left this turning point' : undefined}
            onClick={() => store.dispatch({ t: 'AdvancePhase' })}
          >
            End turning point
          </button>
        </div>
      )}
      {state.phase === 'endOfTP' && (
        <div class="row" style={{ marginTop: 8 }}>
          <button class="primary" onClick={() => store.dispatch({ t: 'AdvancePhase' })}>
            Start turning point {state.turningPoint + 1}
          </button>
        </div>
      )}
      {state.phase === 'battleEnd' && (
        <p style={{ marginTop: 8 }}>
          <strong>
            {state.winner && state.winner !== 'draw'
              ? `${playerLabel(state.winner)} wins ${state.teams[state.winner].vp} VP to ${
                  state.teams[state.winner === 'p1' ? 'p2' : 'p1'].vp
                } VP.`
              : `A draw — ${state.teams.p1.vp} VP each.`}
          </strong>
        </p>
      )}
    </section>
  );
}

/** The Strategy phase, step by step — roll off, ready up, then alternate gambits. */
function StrategyPanel({ store }: { store: Store }) {
  const { state, ctx } = store;
  if (state.phase !== 'strategy') return null;
  const rolled = state.log.some((l) => l.tp === state.turningPoint && l.text.startsWith('Initiative roll-off'));
  return (
    <section class="card">
      <h2>Strategy — turning point {state.turningPoint}</h2>
      {state.strategyStep === 'initiative' && (
        <>
          <p class="muted">Roll off for initiative; initiative cards can change the result.</p>
          <div class="row">
            <button class={rolled ? undefined : 'primary'} onClick={() => store.dispatch({ t: 'RollOff', kind: 'initiative' })}>
              🎲 Roll off
            </button>
            <button
              class={rolled ? 'primary' : undefined}
              disabled={!rolled}
              title={rolled ? undefined : 'Roll off for initiative first'}
              onClick={() => store.dispatch({ t: 'AdvancePhase' })}
            >
              Continue to Ready step
            </button>
          </div>
        </>
      )}
      {state.strategyStep === 'ready' && (
        <>
          <p class="muted">All operatives ready up, and each player gains command points.</p>
          <div class="row">
            <button class="primary" onClick={() => store.dispatch({ t: 'AdvancePhase' })}>
              Continue to Gambits
            </button>
          </div>
        </>
      )}
      {state.strategyStep === 'gambit' && (
        <>
          <p class="muted">
            Starting with {playerLabel(state.initiative ?? 'p1')}, alternate using a strategic gambit or
            passing until both players pass.
          </p>
          {(['p1', 'p2'] as PlayerId[]).map((p) => {
            const options = gambitOptions(ctx, state, p);
            return (
              <div key={p} class="row" style={{ marginTop: 6 }}>
                <strong style={{ minWidth: 70 }}>{playerLabel(p)}</strong>
                <span class="tag">{state.teams[p].cp} CP</span>
                {state.teams[p].passedGambit ? (
                  <span class="tag">passed</span>
                ) : (
                  <>
                    {options.map((o) => (
                      <button
                        key={o.id}
                        title={o.sourceText}
                        onClick={() => store.dispatch({ t: 'UseGambit', player: p, gambitId: o.id })}
                      >
                        {o.label}
                      </button>
                    ))}
                    <button onClick={() => store.dispatch({ t: 'PassGambit', player: p })}>Pass</button>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

/** The battle log, kept scrolled to the newest entry unless the reader scrolled back up. */
function LogPanel({ state }: { state: GameState }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.log.length]);
  return (
    <section class="card">
      <h2>Battle log</h2>
      <div
        class="log"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {state.log.length === 0 && <p class="muted">Nothing has happened yet.</p>}
        {state.log.slice(-250).map((l) => (
          <div key={l.seq} class={l.kind}>
            <span class="muted">TP{l.tp}</span> {l.text}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Used only until `pnpm maps:extract` has produced data/maps — keeps the app usable. */
function fallbackMap(): KillzoneMap {
  const rect = (x: number, y: number, w: number, h: number) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  return {
    id: 'placeholder',
    killzone: 'volkus',
    name: 'No killzone data — run pnpm maps:extract',
    board: { w: 30, h: 22, grid: 1 },
    closeQuarters: false,
    dropZones: { p1: [rect(0, 0, 6, 22)], p2: [rect(24, 0, 6, 22)] },
    territories: { p1: [rect(0, 0, 15, 22)], p2: [rect(15, 0, 15, 22)] },
    killzoneEdges: { p1: [], p2: [], neutral: [] },
    centreLine: { a: { x: 15, y: 0 }, b: { x: 15, y: 22 } },
    flankLine: { a: { x: 0, y: 11 }, b: { x: 30, y: 11 } },
    objectives: [{ id: 'centre', kind: 'centre', pos: { x: 15, y: 11 }, z: 0 }],
    features: [],
    source: { card: 'none', pxPerInch: 24, extractedAt: '', tool: 'fallback' },
  };
}
