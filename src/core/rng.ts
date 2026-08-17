/**
 * Seeded, injectable RNG + dice journal.
 *
 * Every random number in the game comes from here so a battle replays byte-identically
 * from (rosters, map, seed, intents[]). `tools/lint/no_math_random.mjs` fails CI if
 * `Math.random` appears anywhere outside this file and UI-only animation code.
 */

export interface Rng {
  /** Uniform integer in [1, sides]. */
  die(sides: number): number;
  /** n D6, returned in roll order. */
  roll(n: number): number[];
  d6(): number;
  /** D3 = D6 halved, rounding up (core rules › Dice). */
  d3(): number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** How many raw draws have been consumed — this is the replay cursor. */
  cursor(): number;
  /** Fork a deterministic child stream (used for AI rollouts so they can't disturb the match). */
  fork(tag: string): Rng;
}

/** mulberry32 — small, fast, good enough for dice; identical across engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** splitmix32 hash used to derive fork seeds from a string tag. */
export function hashString(s: string, seed = 0x9e3779b9): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

export class SeededRng implements Rng {
  private readonly gen: () => number;
  private count = 0;
  readonly seed: number;

  constructor(seed: number, skip = 0) {
    this.seed = seed >>> 0;
    this.gen = mulberry32(this.seed);
    for (let i = 0; i < skip; i++) this.gen();
    this.count = skip;
  }

  next(): number {
    this.count++;
    return this.gen();
  }

  die(sides: number): number {
    return 1 + Math.floor(this.next() * sides);
  }

  d6(): number {
    return this.die(6);
  }

  /** "Whenever you roll a D3, roll a D6 and halve the result, rounding up." */
  d3(): number {
    return Math.ceil(this.d6() / 2);
  }

  roll(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.d6());
    return out;
  }

  cursor(): number {
    return this.count;
  }

  fork(tag: string): Rng {
    return new SeededRng(hashString(tag, this.seed ^ (this.count * 0x27d4eb2d)));
  }
}

/** Deterministic RNG that replays a fixed script — used by tests to pin dice. */
export class ScriptedRng implements Rng {
  private i = 0;
  constructor(
    private readonly script: number[],
    private readonly fallback: Rng = new SeededRng(1),
  ) {}

  private take(): number | undefined {
    if (this.i < this.script.length) return this.script[this.i++];
    return undefined;
  }

  die(sides: number): number {
    const v = this.take();
    if (v === undefined) return this.fallback.die(sides);
    return Math.min(Math.max(v, 1), sides);
  }
  d6(): number {
    return this.die(6);
  }
  d3(): number {
    return Math.ceil(this.d6() / 2);
  }
  roll(n: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(this.d6());
    return out;
  }
  next(): number {
    return (this.die(6) - 1) / 6;
  }
  cursor(): number {
    return this.i;
  }
  fork(tag: string): Rng {
    return this.fallback.fork(tag);
  }
}

/** A dice journal entry as recorded on GameState.rolls. */
export interface JournalledRoll {
  kind: string;
  results: number[];
  note?: string;
}

/**
 * Wraps an Rng and appends every roll to a journal so the log can explain any dice
 * result after the fact ("audit any roll", MEGAPROMPT §4).
 */
export class JournallingRng implements Rng {
  readonly journal: JournalledRoll[] = [];
  private kind = 'misc';
  private note: string | undefined;

  constructor(private readonly inner: Rng) {}

  /** Label the rolls that follow, e.g. `rng.as('attack', 'lasgun')`. */
  as(kind: string, note?: string): this {
    this.kind = kind;
    this.note = note;
    return this;
  }

  private record(results: number[]): void {
    this.journal.push({ kind: this.kind, results, ...(this.note ? { note: this.note } : {}) });
  }

  die(sides: number): number {
    const v = this.inner.die(sides);
    this.record([v]);
    return v;
  }
  d6(): number {
    const v = this.inner.d6();
    this.record([v]);
    return v;
  }
  d3(): number {
    const v = this.inner.d3();
    this.record([v]);
    return v;
  }
  roll(n: number): number[] {
    const v = this.inner.roll(n);
    this.record(v);
    return v;
  }
  next(): number {
    return this.inner.next();
  }
  cursor(): number {
    return this.inner.cursor();
  }
  fork(tag: string): Rng {
    return this.inner.fork(tag);
  }
}
