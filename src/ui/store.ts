/**
 * A tiny observable store. The UI never mutates GameState directly: it dispatches Intents
 * into the pure reducer and re-renders from the result.
 *
 * Two things beyond that, both of which exist because the reducer already knows the answer
 * and the old UI threw it away:
 *
 * - **Rejections are surfaced.** `reduce` returns a written-out reason for every illegal
 *   intent ("operatives must be set up wholly within your drop zone"). The old shell dropped
 *   it on the floor, so a tap that did nothing looked like a broken app. `lastRejection` is
 *   what the toast layer reads.
 * - **Setup is undoable.** A snapshot is taken before every intent tagged undoable, so a
 *   misplaced operative costs one tap rather than a restart. Snapshots are only offered where
 *   no dice have been rolled — undoing a roll would be cheating, not undo.
 */
import { reduce } from '../core/reducer.ts';
import type { GameContext } from '../core/context.ts';
import type { Intent } from '../core/intents.ts';
import type { GameState } from '../core/types.ts';

type Listener = () => void;

export interface Rejection {
  /** The reducer's own words. */
  reason: string;
  intent: Intent;
  /** Monotonic, so a toast can tell "the same rejection again" from "still the old one". */
  seq: number;
}

/** Intents a player may take back: none of them consume RNG, so undo is exact. */
const UNDOABLE = new Set<Intent['t']>(['DeployOperative', 'PlaceEquipment', 'SkipEquipmentPlacement']);

/** Deep-copies GameState. It is required to be JSON-serialisable, so this is total. */
const snapshot = (s: GameState): GameState =>
  typeof structuredClone === 'function' ? structuredClone(s) : (JSON.parse(JSON.stringify(s)) as GameState);

export class Store {
  private listeners = new Set<Listener>();
  /** Every intent applied, so a battle can be exported and replayed. */
  readonly history: Intent[] = [];
  /** States as they were before each undoable intent, newest last. */
  private undoStack: { state: GameState; historyLength: number; label: string }[] = [];
  private rejectionSeq = 0;
  lastRejection: Rejection | null = null;

  constructor(
    public state: GameState,
    public ctx: GameContext,
  ) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(intent: Intent): boolean {
    const before = UNDOABLE.has(intent.t) ? snapshot(this.state) : null;
    const out = reduce(this.state, intent, this.ctx);
    this.state = out.state;
    if (out.ok) {
      this.history.push(intent);
      if (before) {
        this.undoStack.push({ state: before, historyLength: this.history.length - 1, label: intent.t });
        // Deployment is at most ~24 placements; the cap is a memory guard, not a rule.
        if (this.undoStack.length > 32) this.undoStack.shift();
      }
    } else {
      this.rejectionSeq += 1;
      this.lastRejection = { reason: out.reason ?? 'that is not allowed', intent, seq: this.rejectionSeq };
    }
    this.emit();
    return out.ok;
  }

  /** True when there is something to take back. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Take back the most recent undoable intent. Returns false when there is nothing to undo. */
  undo(): boolean {
    const top = this.undoStack.pop();
    if (!top) return false;
    this.state = top.state;
    this.history.length = top.historyLength;
    this.clearRejection();
    this.emit();
    return true;
  }

  /**
   * Ask the reducer whether an intent WOULD be legal, without applying it or recording a
   * rejection. The reducer clones before it touches anything, so the live state is untouched;
   * the RNG is forked so a probe can never shift the match's dice stream.
   *
   * Only for intents that resolve without rolling: placement and the setup steps. Anything
   * that starts a sequence must be dispatched for real.
   */
  probe(intent: Intent): { ok: boolean; reason?: string } {
    const ctx: GameContext = { ...this.ctx, rng: this.ctx.rng.fork(`probe:${intent.t}`) };
    const out = reduce(this.state, intent, ctx);
    return out.ok ? { ok: true } : { ok: false, ...(out.reason ? { reason: out.reason } : {}) };
  }

  /** Dismiss the current rejection (the toast timed out, or the player moved on). */
  clearRejection(): void {
    if (!this.lastRejection) return;
    this.lastRejection = null;
    this.emit();
  }

  /** Replace the whole state (loading a save / starting a battle). */
  reset(state: GameState): void {
    this.state = state;
    this.history.length = 0;
    this.undoStack = [];
    this.lastRejection = null;
    this.emit();
  }

  /** Replay export: everything needed to reproduce this battle byte-identically. */
  exportReplay(): string {
    return JSON.stringify(
      { seed: this.state.seed, mapId: this.state.map.id, critOpId: this.state.critOpId, intents: this.history },
      null,
      2,
    );
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

let current: Store | null = null;
export const setStore = (s: Store): void => void (current = s);
export const getStore = (): Store | null => current;
