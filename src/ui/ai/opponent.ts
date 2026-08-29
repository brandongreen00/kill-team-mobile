/**
 * Who is sitting in each seat.
 *
 * The app was pass-and-play only: `commandPlan` asks "whose turn is it?" and then shows that
 * player the controls, on the assumption that a human is holding the phone for both sides.
 * An AI opponent is therefore not a rules change at all — the kernel already takes every
 * intent through one channel and `src/ai/**` already plays whole games through it — it is one
 * new fact the UI needs: **this seat is not a person**.
 *
 * That fact lives here rather than on `GameState` for two reasons. `mode: 'match' | 'sandbox'`
 * is the only seat-ish field the core has, and flipping a solo game to `sandbox` to silence
 * the hand-over screen would also unlock `MoveOperativeFree` — a rules hole opened to fix a
 * presentation problem. And a replay is `(rosters, map, seed, intents[])`: who *authored* an
 * intent changes nothing about how it replays, so the core has no business knowing.
 *
 * It does not live in `UiState` either: `pickMap` resets that wholesale (`App.tsx`), so
 * choosing a different killzone would silently hand the AI's seat back to a second human who
 * is not in the room. It is stored the way saved rosters are, in `localStorage`, behind the
 * same try/catch that Safari private mode needs.
 */
import type { Difficulty } from '../../ai/types.ts';
import type { PlayerId } from '../../core/types.ts';

export type Seat = 'human' | 'ai';

export interface OpponentConfig {
  p1: Seat;
  p2: Seat;
  /** Applies to every AI seat. One battle, one strength. */
  difficulty: Difficulty;
  /**
   * The kill team the AI fields. Undefined means "pick one from the battle seed", which is
   * what makes a run of solo games play differently. When both seats are driven this names
   * Player 2's team only, so a watched battle is still two different kill teams.
   */
  teamId?: string;
}

export const OPPONENT_KEY = 'kt24.opponent.v1';

/** Two people and one phone: what the app did before there was an AI, and still the default. */
export const PASS_AND_PLAY: OpponentConfig = { p1: 'human', p2: 'human', difficulty: 'veteran' };

export const isAi = (opponent: OpponentConfig, player: PlayerId): boolean => opponent[player] === 'ai';
export const isHuman = (opponent: OpponentConfig, player: PlayerId): boolean => opponent[player] === 'human';
/** True when nobody is holding the phone — both seats are driven, and the flow beats are too. */
export const isWatching = (opponent: OpponentConfig): boolean => opponent.p1 === 'ai' && opponent.p2 === 'ai';
/** True when exactly one side is a person: the solo game this whole module exists for. */
export const isSolo = (opponent: OpponentConfig): boolean => (opponent.p1 === 'ai') !== (opponent.p2 === 'ai');

/**
 * Does this battle need a hand-over screen?
 *
 * Only when there are two people. The hand-over is not politeness, it is secrecy: kill teams,
 * equipment and tac ops are chosen in secret and reactive windows belong to the *other*
 * player, so the app names who should be holding the phone before it shows any of them. With
 * one person in the room there is nobody to hide the screen from — and asking them to confirm
 * they are themselves, before every save they roll, is the friction this shell exists to
 * remove. (`mode: 'sandbox'` already stood down for the same reason; this is the same rule
 * stated in terms of the seats rather than of a core field.)
 */
export const needsHandover = (opponent: OpponentConfig): boolean => opponent.p1 === 'human' && opponent.p2 === 'human';

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  recruit: 'Recruit',
  veteran: 'Veteran',
  elite: 'Elite',
};

/**
 * What each difficulty actually changes, in the player's terms rather than in node budgets.
 * The numbers behind these are `DIFFICULTY_PRESETS` (docs/AI.md §6).
 */
export const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  recruit: 'Plays honestly but shallowly, and misjudges by a wide margin. A first game.',
  veteran: 'Plans each activation to the end and prices every shot. The default.',
  elite: 'The same plan with a wider search and no misjudgement. Slower to move.',
};

const DIFFICULTIES: readonly Difficulty[] = ['recruit', 'veteran', 'elite'];

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Safari private mode throws on access.
  }
}

const isSeat = (v: unknown): v is Seat => v === 'human' || v === 'ai';

/** Never throws and never returns a half-valid config: anything unrecognised is pass-and-play. */
export function readOpponent(): OpponentConfig {
  const s = storage();
  if (!s) return { ...PASS_AND_PLAY };
  try {
    const raw = JSON.parse(s.getItem(OPPONENT_KEY) ?? 'null') as Partial<OpponentConfig> | null;
    if (!raw || !isSeat(raw.p1) || !isSeat(raw.p2)) return { ...PASS_AND_PLAY };
    return {
      p1: raw.p1,
      p2: raw.p2,
      difficulty: DIFFICULTIES.includes(raw.difficulty as Difficulty) ? (raw.difficulty as Difficulty) : 'veteran',
      ...(typeof raw.teamId === 'string' && raw.teamId ? { teamId: raw.teamId } : {}),
    };
  } catch {
    return { ...PASS_AND_PLAY };
  }
}

export function writeOpponent(config: OpponentConfig): OpponentConfig {
  try {
    storage()?.setItem(OPPONENT_KEY, JSON.stringify(config));
  } catch {
    /* quota or private mode — the choice still holds for this battle */
  }
  return config;
}
