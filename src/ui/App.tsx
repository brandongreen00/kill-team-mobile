/**
 * App shell. One responsive codebase: phone portrait uses the bottom tab bar, desktop
 * (>=900px) uses the three-column layout.
 */
import { useEffect, useState } from 'preact/hooks';
import { Board } from './Board.tsx';
import { Store, setStore } from './store.ts';
import { makeContext } from '../core/context.ts';
import { SeededRng } from '../core/rng.ts';
import { createBattle } from '../core/init.ts';
import { loadMaps } from './data.ts';
import type { GameState, KillzoneMap } from '../core/types.ts';

type Tab = 'board' | 'play' | 'log';

export function App() {
  const [maps, setMaps] = useState<KillzoneMap[]>([]);
  const [store, setLocalStore] = useState<Store | null>(null);
  const [, force] = useState(0);
  const [tab, setTab] = useState<Tab>('board');

  useEffect(() => {
    loadMaps().then((m) => {
      setMaps(m);
      if (m.length > 0) {
        const ctx = makeContext({ rng: new SeededRng(1) });
        for (const map of m) ctx.maps.set(map.id, map);
        const s = new Store(createBattle(ctx, { map: m[0]!, seed: 1, mode: 'sandbox' }), ctx);
        setStore(s);
        setLocalStore(s);
        s.subscribe(() => force((n) => n + 1));
      }
    });
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
            <p class="muted">
              Preparing killzone data. If no maps appear, run <code>pnpm maps:extract</code> to generate{' '}
              <code>data/maps</code> from the official Approved Ops cards.
            </p>
          </div>
        </main>
      </>
    );
  }

  const state: GameState = store.state;

  const pickMap = (id: string) => {
    const map = maps.find((m) => m.id === id);
    if (!map) return;
    store.reset(createBattle(store.ctx, { map, seed: state.seed, mode: state.mode }));
  };

  return (
    <>
      <header class="topbar">
        <h1>Kill Team</h1>
        <span class="tag">{state.map.name}</span>
        <div class="spacer" />
        <span class="tag">TP {Math.max(1, state.turningPoint)}</span>
      </header>

      <div class="board-wrap" style={{ display: tab === 'board' ? 'grid' : 'none' }}>
        <Board state={state} />
      </div>

      <main class="page" style={{ display: tab === 'board' ? 'none' : 'block' }}>
        {tab === 'play' && (
          <>
            <div class="card">
              <h2>Killzone</h2>
              <select value={state.map.id} onChange={(e) => pickMap((e.target as HTMLSelectElement).value)}>
                {maps.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <p class="muted">
                {state.map.board.w}" × {state.map.board.h}" · {state.map.features.length} terrain features ·{' '}
                {state.map.closeQuarters ? 'Close Quarters' : 'open killzone'}
              </p>
            </div>
            <div class="card">
              <h2>Score</h2>
              <div class="row">
                <span class="tag">P1 {state.teams.p1.vp} VP · {state.teams.p1.cp} CP</span>
                <span class="tag">P2 {state.teams.p2.vp} VP · {state.teams.p2.cp} CP</span>
              </div>
            </div>
          </>
        )}
        {tab === 'log' && (
          <div class="card">
            <h2>Battle log</h2>
            <div class="log">
              {state.log.length === 0 && <p class="muted">Nothing has happened yet.</p>}
              {state.log.slice(-200).map((l) => (
                <div key={l.seq} class={l.kind}>
                  <span class="muted">TP{l.tp}</span> {l.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <nav class="m-tabs" role="tablist">
        {(['board', 'play', 'log'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            <span aria-hidden="true">{t === 'board' ? '🗺' : t === 'play' ? '⚔' : '📜'}</span>
            <span>{t === 'board' ? 'Board' : t === 'play' ? 'Play' : 'Log'}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
