/**
 * The contract between "what the game state is" and "what the phone shows".
 *
 * Every screen in the battle is derived here, in one place, from `GameState`. That is the
 * rule the old shell broke: it spread the setup wizard, the activation panel and the board
 * across three tabs with no shared idea of what the player was in the middle of, so arming a
 * placement on one tab left the board on another with no way to know.
 *
 * A `CommandPlan` is the whole screen: what the sheet says, what the board is aimed at, and
 * what the next tap on the board means. `App` renders it and nothing else decides.
 */
import type { ArmedState } from '../Board.tsx';
import type { Detent } from '../Sheet.tsx';
import type { MoveAction } from '../../core/movement.ts';
import type { OperativeState, PlayerId, Vec2 } from '../../core/types.ts';

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** UI-only state: what the player has picked but not yet committed to the rules core. */
export interface UiState {
  /** The operative whose card/actions the sheet is showing (not necessarily the active one). */
  selectedId?: string;
  /** Deployment: which operative the next board tap places. */
  placingId?: string;
  /** A move being aimed: the action, and the destination under the finger. */
  move?: { action: MoveAction; dest?: Vec2; destZ?: number } | undefined;
  /** Shooting: which weapon the target list is for. */
  weaponName?: string;
  /** Targeting-line inspector: tap a shooter, then a target. */
  inspect?: { from?: string; to?: string } | undefined;
  /** Pass-and-play: which player has confirmed they are holding the device. */
  handedOverTo?: PlayerId | undefined;
  /** Equipment ticked on the loadout screen, before it is committed. */
  equipment?: string[] | undefined;
  /** The tac op picked on the loadout screen, before it is committed. */
  tacOpId?: string | undefined;
  /** A full-screen route over the battle. */
  route?: 'rosters' | 'log' | 'killzones' | 'menu' | undefined;
}

export const emptyUi: UiState = {};

/** One thing the player can do, rendered as a button. */
export interface CommandAction {
  id: string;
  label: string;
  onClick: () => void;
  /** 'primary' is the accented, full-width, single obvious next tap. One per screen. */
  tone?: 'primary' | 'default' | 'quiet' | 'danger';
  disabled?: boolean;
  /** Why it is disabled, or what the rule behind it says. */
  hint?: string;
  icon?: preact.ComponentChildren;
}

export interface CommandPlan {
  /** Stable id, e.g. `setup.deploy` — the e2e suite asserts on this. */
  id: string;
  /** Eyebrow: where you are in the game. */
  step: string;
  /** The one sentence that says what to do. */
  title: string;
  /** The rule behind it, in the rules' own words where possible. */
  help?: string;
  /** Shown as a highlighted strip in the peek while the board is armed. */
  armedNote?: string;
  /** Up to two actions in the peek; the rest belong in `body`. */
  actions: CommandAction[];
  /** Everything revealed when the sheet is expanded. */
  body?: preact.ComponentChildren;
  /** Where to point the board. Null leaves the player's own framing alone. */
  frame?: WorldRect | null;
  /** What the next board tap means. */
  armed?: ArmedState | null;
  /** Drawn under the operatives: drop zones, reachability, the planned path. */
  highlights?: preact.ComponentChildren;
  /** Operatives the current step invites a tap on. */
  targetIds?: string[];
  selectedId?: string | undefined;
  /** A pending decision blocks everything: dim the board, do not allow `rest`. */
  modal?: boolean;
  /** The detent this screen wants when it first appears. */
  detent?: Detent;
  /** Whose turn it is, for the top bar. */
  turnOf?: PlayerId | undefined;
}

export const rectOfPolys = (polys: readonly (readonly Vec2[])[]): WorldRect | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
};

/** A square window centred on an operative, `radius` inches to a side of it. */
export const rectAround = (op: OperativeState, radius: number): WorldRect => ({
  x: op.pos.x - radius,
  y: op.pos.y - radius,
  w: radius * 2,
  h: radius * 2,
});
