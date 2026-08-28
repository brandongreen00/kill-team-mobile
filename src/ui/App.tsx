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
import { useWindowClass } from './useMedia.ts';
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
import { defaultCritOpId, loadMaps, loadTeams, type TeamData } from './data.ts';
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
  const windowClass = useWindowClass();
  const isDesktop = windowClass === 'desktop';
  const sideSheet = windowClass === 'side';

  const setUi = useCallback((patch: Partial<UiState>) => setUiState((s) => ({ ...s, ...patch })), []);

  useEffect(() => {
    void (async () => {
      const [m, t] = await Promise.all([loadMaps(), loadTeams()]);
      setMaps(m);
      setTeams(t);
      // A fully wired context: ops, equipment, the initiative-card flow and — so a roster's
      // kill team actually plays by its own rules — every implemented team module.
      // This registered only BATCH_1 for six batches, so 40 of the 48 selectable teams
      // fought whole battles with no faction rules, ploys, equipment or unique actions, and
      // said nothing about it: `rebuildHooks` optional-chains a module it cannot find.
      // `tests/wiring.test.ts` now pins that every selectable team has a module.
      const { ALL_TEAM_MODULES } = await import('../teams/index.ts');
      const ctx = createGameContext({
        rng: new SeededRng(1),
        maps: m,
        datacards: t.flatMap((team) => team.datacards ?? []),
        teams: ALL_TEAM_MODULES,
      });
      const map = m[0] ?? fallbackMap();
      const s = new Store(createBattle(ctx, { map, seed: 1, mode: 'match', critOpId: defaultCritOpId() }), ctx);
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
    // The store clears `lastRejection` the moment anything succeeds; the toast has to go with
    // it, or a refusal from the start of deployment is still pinned over the board a phase later.
    if (!rejection) {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToasts((t) => (t.length === 0 ? t : []));
      return;
    }
    if (rejection.seq === lastToastSeq.current) return;
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

  /**
   * A new screen picks its own detent; the player may then drag it wherever they like.
   *
   * ONE effect, because this used to be two — "the plan's detent" and "a screen that arms the
   * board must not be covered by its own sheet" — and the second ran after the first, so it
   * won every time. `firefight.activate` arms the board (tap one of your operatives) AND asks
   * for `half` (or pick it from the list), and was forced to `rest`: the list of operatives
   * rendered 75px below the bottom of the screen, so for the whole battle the only way to
   * activate anyone was to hit a 44px token on the board. Every activation, every turn.
   *
   * The plan's own detent is now authoritative. The no-cover rule survives as the DEFAULT for
   * an arming screen that does not state one.
   */
  const planId = plan?.id;
  const wantedDetent: Detent | undefined = plan?.detent ?? (plan?.armed ? 'rest' : undefined);
  const detentKey = `${planId}|${plan?.armed ? 'armed' : ''}`;
  useEffect(() => {
    if (wantedDetent) setDetent(wantedDetent);
  }, [detentKey]);

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
    store.reset(createBattle(store.ctx, { map, seed: state.seed, mode: state.mode, critOpId: defaultCritOpId() }));
    setUiState(emptyUi);
  };

  /**
   * Which side the zoom cluster floats on — decided by the KILLZONE, once, and then never
   * again for the rest of the battle.
   *
   * It used to be derived from the screen's framing, so it hopped corners between deploy and
   * activate and back again. Dodging the armed area is worth something, but not this: a
   * control that moves is a control you have to re-find every single time, which is exactly
   * the "where did that go?" feeling the overhaul exists to remove. So it still dodges — it
   * just dodges the drop zones, which are a property of the map and do not move.
   */
  const controlsSide: 'left' | 'right' = (() => {
    const mid = state.map.board.w / 2;
    let left = 0;
    let right = 0;
    for (const poly of [...state.map.dropZones.p1, ...state.map.dropZones.p2])
      for (const p of poly) (p.x < mid ? (left += 1) : (right += 1));
    // A tie means both edges are equally spoken for (zones up the left and right, or bands
    // across the top and bottom): fall back to the thumb side.
    return right > left ? 'left' : 'right';
  })();

  const board = (
    <div class="board-pane">
      <Board
        state={state}
        ctx={store.ctx}
        frame={plan.frame ?? null}
        controlsSide={controlsSide}
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
        <div class={`armed-banner${plan.armedTone === 'blocked' ? ' is-blocked' : ''}`}>
          {plan.armedTone === 'blocked' ? <IconAlert size={18} /> : <IconTarget size={18} />}
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
            /* WHOSE. Both kill teams letter their operatives A..I, so "H activates (engage)"
               twice in a row is two different operatives and the log had no way to say so —
               it read as a rules bug. Marked in text as well as colour, because colour alone
               is never the only signal here. */
            <div key={l.seq} class={l.player ? `${l.kind} is-${l.player}` : l.kind}>
              {/* Turning point 0 is setup, which is not a turning point. */}
              <span class="tp">{l.tp > 0 ? `TP${l.tp}` : 'SET'}</span>
              {l.player && <span class={`who is-${l.player}`}>{PLAYER_LABEL[l.player].replace('Player ', 'P')}</span>}
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
          if (!ok) return; // The reducer refused it: stay on the builder with the picks intact.
          applyLoadouts(store.state, store.state.teams[selectingFor].operativeIds, weapons);
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

  /**
   * The plan's stable id, published on the topbar.
   *
   * The whole shell is derived from one `CommandPlan`, so this single attribute says exactly
   * which screen is up — which is what the e2e suite and the screenshot capture need in order
   * to assert on a state rather than on a sentence that copy edits keep breaking.
   */
  const topbar = (
    <header class="topbar" data-screen={plan.id}>
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

  /**
   * Two live regions, mounted once at boot and never unmounted — a region that is added to
   * the DOM at the same time as its text is not announced by any screen reader.
   *
   * `status` carries what just changed (the current prompt, a placement, a rejection);
   * `log` carries the battle log so a blind player can follow dice they cannot see.
   */
  const announcer = (
    <>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {plan.armedNote ? `${plan.title}. ${plan.armedNote}` : plan.title}
      </div>
      <div class="sr-only" role="log" aria-live="polite">
        {state.log.slice(-1).map((l) => (
          <span key={l.seq}>{l.text}</span>
        ))}
      </div>
    </>
  );

  const toastLayer = toasts.length > 0 && (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} class="toast is-danger" onClick={() => setToasts([])} aria-label={`Dismiss: ${t.text}`}>
          <IconAlert size={20} />
          <span>
            {t.text}
            {t.count > 1 && <span class="toast-count"> — {t.count} times</span>}
          </span>
        </button>
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
        {announcer}
        {route}
      </>
    );
  }

  return (
    <>
      {topbar}
      <main
        class={`stage${sideSheet ? ' has-side-sheet' : ''}`}
        style={{ '--sheet-rest': `${sheetRest}px` } as unknown as string}
      >
        {board}
        <Sheet
          detent={detent}
          onDetent={setDetent}
          modal={plan.modal ?? false}
          onRestHeight={setSheetRest}
          peek={peek}
          label={plan.title}
          side={sideSheet}
        >
          {sheetBody}
        </Sheet>
      </main>
      {toastLayer}
      {announcer}
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

/**
 * The plan's action id is published on the button, for the same reason the topbar publishes
 * `data-screen`: a test or the `docs/ui-review` capture can press "confirm the move" without
 * matching a label that says `Normal Move — costs 4"` today and something else tomorrow.
 */
function ActionButton({ action }: { action: CommandAction }) {
  const cls = action.tone === 'primary' ? 'primary' : action.tone === 'quiet' ? 'quiet' : action.tone === 'danger' ? 'danger' : '';
  return (
    <button
      class={cls}
      data-action={action.id}
      disabled={action.disabled}
      title={action.hint}
      onClick={action.onClick}
    >
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
