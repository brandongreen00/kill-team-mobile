/**
 * A tiny observable store. The UI never mutates GameState directly: it dispatches Intents
 * into the pure reducer and re-renders from the result.
 */
import { reduce } from '../core/reducer.ts';
import type { GameContext } from '../core/context.ts';
import type { Intent } from '../core/intents.ts';
import type { GameState } from '../core/types.ts';

type Listener = () => void;

export class Store {
  private listeners = new Set<Listener>();
  /** Every intent applied, so a battle can be exported and replayed. */
  readonly history: Intent[] = [];
  /** Why the most recent dispatch was rejected — surfaced inline next to the control that caused it. */
  lastError: string | null = null;

  constructor(
    public state: GameState,
    public ctx: GameContext,
  ) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(intent: Intent): boolean {
    const out = reduce(this.state, intent, this.ctx);
    this.state = out.state;
    this.lastError = out.ok ? null : (out.reason ?? 'that is not a legal move');
    if (out.ok) this.history.push(intent);
    for (const l of this.listeners) l();
    return out.ok;
  }

  /** Replace the whole state (loading a save / starting a battle). */
  reset(state: GameState): void {
    this.state = state;
    this.history.length = 0;
    this.lastError = null;
    for (const l of this.listeners) l();
  }

  /** Replay export: everything needed to reproduce this battle byte-identically. */
  exportReplay(): string {
    return JSON.stringify(
      { seed: this.state.seed, mapId: this.state.map.id, critOpId: this.state.critOpId, intents: this.history },
      null,
      2,
    );
  }
}

let current: Store | null = null;
export const setStore = (s: Store): void => void (current = s);
export const getStore = (): Store | null => current;
