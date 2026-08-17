/**
 * App shell. One responsive codebase: phone portrait uses the bottom tab bar and keeps the
 * board on its own full-height page; desktop (>=900px) shows board + rails together.
 *
 * The dice/decision surface is deliberately available on BOTH layouts: on a phone the
 * decision panel docks under the board so a reactive window never hides the dice.
 */
import { useEffect, useState } from 'preact/hooks';
import { useIsDesktop } from './useMedia.ts';
import { Board } from './Board.tsx';
import { SequenceOverlay } from './SequenceOverlay.tsx';
import { DecisionPanel } from './DecisionPanel.tsx';
import { ActivationPanel } from './ActivationPanel.tsx';
import { Setup, placeAt } from './flow/Setup.tsx';
import { TargetingInspector } from './TargetingInspector.tsx';
import { MapBrowser } from './MapBrowser.tsx';
import { RosterBuilder } from './roster/RosterBuilder.tsx';
import { Store, setStore } from './store.ts';
import { createGameContext } from '../core/game.ts';
import { SeededRng } from '../core/rng.ts';
import { createBattle } from '../core/init.ts';
import { loadMaps, loadTeam, loadTeamIndex, type TeamSummary } from './data.ts';
import type { GameState, KillzoneMap, PlayerId } from '../core/types.ts';

type Tab = 'board' | 'play' | 'log' | 'roster';

const TAB_ICON: Record<Tab, string> = { board: '🗺', play: '⚔', log: '📜', roster: '📋' };
const TAB_LABEL: Record<Tab, string> = { board: 'Board', play: 'Play', log: 'Log', roster: 'Rosters' };

export function App() {
  const [maps, setMaps] = useState<KillzoneMap[]>([]);
  /** Name/faction only: a team's datacards arrive when the roster builder asks for them. */
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [store, setLocalStore] = useState<Store | null>(null);
  const [, force] = useState(0);
  const [tab, setTab] = useState<Tab>('board');
  const isDesktop = useIsDesktop();
  const [placement, setPlacement] = useState<{ operativeId: string; player: PlayerId } | null>(null);
  /** Targeting-line inspector: tap a shooter, then a target. */
  const [inspect, setInspect] = useState<{ from?: string; to?: string }>({});

  useEffect(() => {
    void (async () => {
      const [m, t] = await Promise.all([loadMaps(), loadTeamIndex()]);
      setMaps(m);
      setTeams(t);
      // Ops, equipment and the initiative-card flow — everything the killzone needs. NO team
      // data: the board renders without a single kill team's JSON, and a team's datacards are
      // registered when its roster is confirmed (`Setup`).
      const ctx = createGameContext({ rng: new SeededRng(1), maps: m });
      const map = m[0] ?? fallbackMap();
      const s = new Store(createBattle(ctx, { map, seed: 1, mode: 'match' }), ctx);
      setStore(s);
      setLocalStore(s);
      s.subscribe(() => force((n) => n + 1));

      // Then, off the critical path, the implemented kill teams' rule modules — so a
      // selected roster actually plays by its own faction rules, ploys and equipment.
      // `ctx.teams` / `ctx.datacards` are read at dispatch time, long after this resolves.
      const { BATCH_1, TEAM_DATA } = await import('../teams/index.ts');
      for (const team of BATCH_1) ctx.teams.set(team.id, team);
      for (const data of Object.values(TEAM_DATA)) for (const c of data.datacards) ctx.datacards.set(c.id, c);
      force((n) => n + 1);
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

  // A reactive window must be answered before anything else: jump to it on a phone.
  useEffect(() => {
    if (decision && tab === 'log') setTab('board');
  }, [decision?.id]);

  const pickMap = (id: string) => {
    const map = maps.find((m) => m.id === id);
    if (!map) return;
    store.reset(createBattle(store.ctx, { map, seed: state.seed, mode: state.mode }));
  };

  const boardPane = (
    <div class="board-wrap">
      <Board
        state={state}
        overlays={<SequenceOverlay state={state} decision={decision} />}
        selectedId={inspect.from}
        onOperativeClick={(op) => {
          setInspect((cur) => (cur.from && cur.from !== op.id ? { from: cur.from, to: op.id } : { from: op.id }));
        }}
        onBoardClick={(world) => {
          if (placement) {
            if (placeAt(store, placement, world)) setPlacement(null);
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
      <Setup
        store={store}
        teams={teams}
        loadTeam={loadTeam}
        pendingPlacement={placement}
        setPendingPlacement={setPlacement}
      />
      <ActivationPanel store={store} />
      <section class="card">
        <h2>Battle</h2>
        <div class="row">
          <span class="tag">TP {Math.max(1, state.turningPoint)}/{state.maxTurningPoints}</span>
          <span class="tag">{state.phase}</span>
          {state.initiative && <span class="tag">initiative: {state.initiative}</span>}
        </div>
        <div class="row" style={{ marginTop: 8 }}>
          {(['p1', 'p2'] as PlayerId[]).map((p) => (
            <span key={p} class="tag">
              {p.toUpperCase()} · {state.teams[p].vp} VP · {state.teams[p].cp} CP
            </span>
          ))}
        </div>
        <div class="row" style={{ marginTop: 8 }}>
          <button onClick={() => store.dispatch({ t: 'AdvancePhase' })}>Advance phase</button>
        </div>
      </section>
      <MapBrowser ctx={store.ctx} maps={maps} selectedId={state.map.id} onPick={(m) => pickMap(m.id)} />
    </>
  );

  /** The builder outside a battle: prepare and save kill teams before you sit down to play. */
  const rosterPane = (
    <RosterBuilder
      teams={teams}
      loadTeam={loadTeam}
      title="Roster builder"
      onCancel={() => setTab(isDesktop ? 'play' : 'board')}
    />
  );

  const logPane = (
    <section class="card">
      <h2>Battle log</h2>
      <div class="log">
        {state.log.length === 0 && <p class="muted">Nothing has happened yet.</p>}
        {state.log.slice(-250).map((l) => (
          <div key={l.seq} class={l.kind}>
            <span class="muted">TP{l.tp}</span> {l.text}
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <>
      <header class="topbar">
        <h1>Kill Team</h1>
        <span class="tag">{state.map.name}</span>
        <div class="spacer" />
        {decision && <span class="tag" style={{ color: 'var(--accent)' }}>decision: {decision.who}</span>}
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
          {tab === 'board' && decision && (
            <div class="page dock">
              <DecisionPanel store={store} decision={decision} />
            </div>
          )}
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
