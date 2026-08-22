/**
 * App shell.
 *
 * One stage: the killzone, with a command sheet over the bottom of it. There is no tab bar.
 * The old shell had four tabs (Board / Play / Rosters / Log) and the game's own instructions
 * straddled two of them — "tap the board to place A" was printed on the Play tab while the
 * board lived on the Board tab, with nothing on the board to say what was armed or that a
 * tap had been rejected. Tabs are for peer destinations you choose between; a battle is a
 * wizard followed by a turn loop, where at every moment there is exactly one thing to do.
 * So `commandPlan()` derives that one thing from state, the sheet shows it, and the board is
 * always underneath it.
 *
 * The things that genuinely are separate destinations — the roster workbench, the battle
 * log, the killzone browser — are routes over the top, reached from the menu and dismissed
 * with one back button.
 *
 * Desktop (>= 900px) mounts the same components in three columns instead: sheet content
 * becomes a left rail, the log a right one, and nothing overlays the board.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useIsDesktop } from './useMedia.ts';
import { Board } from './Board.tsx';
import { Sheet, type Detent } from './Sheet.tsx';
import { SequenceOverlay } from './SequenceOverlay.tsx';
import { TargetingInspector } from './TargetingInspector.tsx';
import { MapBrowser } from './MapBrowser.tsx';
import { RosterBuilder } from './roster/RosterBuilder.tsx';
import { Store, setStore } from './store.ts';
import { commandPlan } from './command/index.tsx';
import { emptyUi, type CommandAction, type CommandPlan, type UiState } from './command/types.ts';
import { applyLoadouts } from '../teams/selection.ts';
import { createGameContext } from '../core/game.ts';
import { SeededRng } from '../core/rng.ts';
import { createBattle } from '../core/init.ts';
import { loadMaps, loadTeams, type TeamData } from './data.ts';
import { IconAlert, IconBack, IconLog, IconMap, IconMenu, IconRoster, IconTarget } from './icons.tsx';
import type { GameState, KillzoneMap, PlayerId } from '../core/types.ts';

const PLAYER_LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };
/** How long a rejection stays on screen. Long enough to read a sentence. */
const TOAST_MS = 4200;

export function App() {
  const [maps, setMaps] = useState<KillzoneMap[]>([]);
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [store, setLocalStore] = useState<Store | null>(null);
  const [, force] = useState(0);
  const [ui, setUiState] = useState<UiState>(emptyUi);
  const [detent, setDetent] = useState<Detent>('rest');
  const [sheetRest, setSheetRest] = useState(140);
  const [toasts, setToasts] = useState<{ id: number; text: string; count: number }[]>([]);
  const isDesktop = useIsDesktop();

  const setUi = useCallback((patch: Partial<UiState>) => setUiState((s) => ({ ...s, ...patch })), []);

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

  // --- rejections become sentences -------------------------------------
  // Every hook below runs on every render, store or no store: an early return above a hook
  // is a hooks-order bug, and the old shell had one.
  //
  // ONE toast at a time, and a repeat of the same reason refreshes it with a count rather
  // than stacking. Aiming into an illegal spot four times in a row is one piece of news, not
  // four, and four stacked toasts covered the very sheet the player was reading.
  const lastToastSeq = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const rejection = store?.lastRejection;
    if (!rejection || rejection.seq === lastToastSeq.current) return;
    lastToastSeq.current = rejection.seq;
    setToasts((t) => {
      const cur = t[0];
      return cur && cur.text === rejection.reason
        ? [{ ...cur, count: cur.count + 1 }]
        : [{ id: rejection.seq, text: rejection.reason, count: 1 }];
    });
    // The timer must NOT be an effect cleanup: the next rejection re-runs the effect, and
    // cancelling the previous toast's timer there is what left them on screen for ever.
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToasts([]), TOAST_MS);
  }, [store?.lastRejection?.seq]);

  useEffect(() => () => (toastTimer.current ? clearTimeout(toastTimer.current) : undefined), []);

  const plan: CommandPlan | null = useMemo(
    () => (store ? commandPlan({ store, teams, ui, setUi }) : null),
    // The store mutates in place and notifies through `force`, so the render counter is part
    // of the key: without it the plan would be computed from a stale state object.
    [store, teams, ui, setUi, store?.state],
  );

  // A new screen picks its own detent; the player may then drag it wherever they like.
  const planId = plan?.id;
  useEffect(() => {
    if (plan?.detent) setDetent(plan.detent);
  }, [planId]);

  // A screen that arms the board must not be covered by its own sheet.
  const armedKey = plan?.armed ? `${plan.id}:armed` : null;
  useEffect(() => {
    if (armedKey) setDetent('rest');
  }, [armedKey]);

  if (!store || !plan) {
    return (
      <>
        <header class="topbar">
          <h1>Kill Team</h1>
        </header>
        <main class="stage">
          <div class="overlay-body">
            <p class="muted">Loading the killzone…</p>
          </div>
        </main>
      </>
    );
  }

  const state: GameState = store.state;
  const decision = state.pending[0];

  const pickMap = (id: string) => {
    const map = maps.find((m) => m.id === id);
    if (!map) return;
    store.reset(createBattle(store.ctx, { map, seed: state.seed, mode: state.mode }));
    setUiState(emptyUi);
  };

  const board = (
    <div class="board-pane">
      <Board
        state={state}
        ctx={store.ctx}
        frame={plan.frame ?? null}
        // Flip the zoom cluster away from whatever the board is currently aimed at.
        controlsSide={plan.frame && plan.frame.x + plan.frame.w / 2 > state.map.board.w / 2 ? 'left' : 'right'}
        armed={plan.armed ?? null}
        highlights={plan.highlights}
        overlays={<SequenceOverlay state={state} decision={decision} />}
        selectedId={plan.selectedId ?? ui.inspect?.from}
        targetIds={plan.targetIds}
        onOperativeClick={(op) => {
          // Unarmed, tapping two operatives opens the targeting-line inspector — the
          // "why can't I see him?" question, answered without spending an action.
          setUiState((s) => {
            const cur = s.inspect ?? {};
            return { ...s, inspect: cur.from && cur.from !== op.id ? { from: cur.from, to: op.id } : { from: op.id } };
          });
        }}
        onBoardClick={() => setUi({ inspect: undefined })}
      />
    </div>
  );

  const peek = (
    <div class="prompt">
      <span class="prompt-step">{plan.step}</span>
      <h2 class="prompt-title">{plan.title}</h2>
      {plan.armedNote && (
        <div class="armed-banner">
          <IconTarget size={18} />
          <span>{plan.armedNote}</span>
        </div>
      )}
      {plan.actions.length > 0 && (
        <div class={plan.actions.length === 2 ? 'actions two-up' : 'actions'}>
          {plan.actions.map((a) => (
            <ActionButton key={a.id} action={a} />
          ))}
        </div>
      )}
    </div>
  );

  const sheetBody = (
    <>
      {plan.help && <p class="prompt-help">{plan.help}</p>}
      {ui.inspect?.from && ui.inspect.to && state.operatives[ui.inspect.from] && state.operatives[ui.inspect.to] && (
        <TargetingInspector
          ctx={store.ctx}
          state={state}
          shooter={state.operatives[ui.inspect.from]!}
          target={state.operatives[ui.inspect.to]!}
          onClose={() => setUi({ inspect: undefined })}
        />
      )}
      {plan.body}
    </>
  );

  const logPane = (
    <section>
      <p class="section-title">Battle log</p>
      <div class="log">
        {state.log.length === 0 && <p class="dim">Nothing has happened yet.</p>}
        {state.log
          .slice(-250)
          .reverse()
          .map((l) => (
            <div key={l.seq} class={l.kind}>
              <span class="tp">TP{l.tp}</span>
              <span>{l.text}</span>
            </div>
          ))}
      </div>
    </section>
  );

  /** The roster builder, wired to the battle when setup is asking for a kill team. */
  const selectingFor: PlayerId | null =
    state.phase === 'setup' && state.setup.step === 'selectOperatives'
      ? ((['p1', 'p2'] as PlayerId[]).find((p) => state.teams[p].operativeIds.length === 0) ?? null)
      : null;

  const rosterRoute =
    selectingFor !== null ? (
      <RosterBuilder
        // A fresh builder per player: pass-and-play must never show one player the other's picks.
        key={selectingFor}
        teams={teams}
        title={`Select operatives — ${PLAYER_LABEL[selectingFor]}`}
        confirmLabel={`Lock in ${PLAYER_LABEL[selectingFor]}'s kill team`}
        onCancel={() => setUi({ route: undefined })}
        onConfirm={({ teamId, picks, weapons }) => {
          const ok = store.dispatch({
            t: 'SelectRoster',
            player: selectingFor,
            teamId,
            operatives: picks.map((p, i) => ({
              datacardId: p.datacardId,
              ...(p.loadoutIds?.[0] ? { loadoutId: p.loadoutIds[0] } : p.loadoutId ? { loadoutId: p.loadoutId } : {}),
              weapons: weapons[i] ?? [],
            })),
          });
          // The reducer keeps no loadout of its own, so the resolved weapons are recorded in
          // the op-state scratch space the team modules read (`selection.applyLoadouts`).
          if (ok) applyLoadouts(store.state, store.state.teams[selectingFor].operativeIds, weapons);
          setUi({ route: undefined, handedOverTo: undefined });
        }}
      />
    ) : (
      <RosterBuilder teams={teams} title="Roster workbench" onCancel={() => setUi({ route: undefined })} />
    );

  const route = ui.route && (
    <div class="overlay-page" role="dialog" aria-modal="true" aria-label={ROUTE_LABEL[ui.route]}>
      <div class="overlay-head">
        <button class="icon-only ghost" aria-label="Back" onClick={() => setUi({ route: undefined })}>
          <IconBack size={24} />
        </button>
        <h2>{ROUTE_LABEL[ui.route]}</h2>
      </div>
      {ui.route === 'rosters' ? (
        rosterRoute
      ) : (
        <div class="overlay-body">
          {ui.route === 'log' && logPane}
          {ui.route === 'killzones' && (
            <MapBrowser ctx={store.ctx} maps={maps} selectedId={state.map.id} onPick={(m) => pickMap(m.id)} />
          )}
          {ui.route === 'menu' && (
            <div class="actions">
              <button onClick={() => setUi({ route: 'rosters' })}>
                <IconRoster size={20} />
                <span style={{ flex: 1, textAlign: 'left' }}>Rosters</span>
              </button>
              <button onClick={() => setUi({ route: 'log' })}>
                <IconLog size={20} />
                <span style={{ flex: 1, textAlign: 'left' }}>Battle log</span>
              </button>
              <button disabled={state.phase !== 'setup'} title={state.phase !== 'setup' ? 'The battle has begun' : undefined} onClick={() => setUi({ route: 'killzones' })}>
                <IconMap size={20} />
                <span style={{ flex: 1, textAlign: 'left' }}>Killzone — {state.map.name}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const topbar = (
    <header class="topbar">
      <h1>Kill Team</h1>
      <div class="spacer" />
      <div class="scoreline">
        {(['p1', 'p2'] as PlayerId[]).map((p) => (
          <span
            key={p}
            class={`team-chip is-${p}${plan.turnOf === p ? ' is-active' : ''}`}
            aria-label={`${PLAYER_LABEL[p]}: ${state.teams[p].vp} victory points, ${state.teams[p].cp} command points${plan.turnOf === p ? ' — to act' : ''}`}
          >
            <i class="dot" />
            {state.teams[p].vp}VP · {state.teams[p].cp}CP
          </span>
        ))}
      </div>
      <button class="icon-only ghost" aria-label="Menu" onClick={() => setUi({ route: 'menu' })}>
        <IconMenu size={24} />
      </button>
    </header>
  );

  const toastLayer = toasts.length > 0 && (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class="toast is-danger">
          <IconAlert size={20} />
          <span>{t.text}</span>
          {t.count > 1 && <span class="toast-count">×{t.count}</span>}
        </div>
      ))}
    </div>
  );

  if (isDesktop) {
    return (
      <>
        {topbar}
        <div class="desktop-layout">
          <aside class="rail">
            {peek}
            {sheetBody}
          </aside>
          <main class="stage">{board}</main>
          <aside class="rail right">{logPane}</aside>
        </div>
        {toastLayer}
        {route}
      </>
    );
  }

  return (
    <>
      {topbar}
      <main class="stage" style={{ '--sheet-rest': `${sheetRest}px` } as unknown as string}>
        {board}
        <Sheet
          detent={detent}
          onDetent={setDetent}
          modal={plan.modal ?? false}
          onRestHeight={setSheetRest}
          peek={peek}
          label={plan.title}
        >
          {sheetBody}
        </Sheet>
      </main>
      {toastLayer}
      {route}
    </>
  );
}

const ROUTE_LABEL: Record<NonNullable<UiState['route']>, string> = {
  rosters: 'Rosters',
  log: 'Battle log',
  killzones: 'Killzones',
  menu: 'Menu',
};

function ActionButton({ action }: { action: CommandAction }) {
  const cls = action.tone === 'primary' ? 'primary' : action.tone === 'quiet' ? 'quiet' : action.tone === 'danger' ? 'danger' : '';
  return (
    <button class={cls} disabled={action.disabled} title={action.hint} onClick={action.onClick}>
      {action.icon}
      <span>{action.label}</span>
    </button>
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
