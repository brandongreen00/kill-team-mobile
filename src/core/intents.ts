/**
 * The single input channel into the rules core.
 *
 * UI and AI both submit `Intent`s; `reduce(state, intent, ctx)` is the ONLY way state
 * changes. Illegal intents are rejected into `state.rejected` + the log, never thrown
 * (AI acceptance tests assert `state.rejected.length === 0`).
 */
import type { Order, PlayerId, Vec2 } from './types.ts';

/** A movement path: straight-line increments, each rounded up to the nearest inch. */
export interface MovePath {
  /** Waypoints in order, starting at the operative's current position (exclusive). */
  points: Vec2[];
  /** Elevation the operative ends at; the engine verifies it against the terrain. */
  endZ?: number;
  /** Optional facing for oval bases. */
  endRot?: number;
}

export type Intent =
  // ---- setup -------------------------------------------------------------
  | { t: 'NewBattle'; mapId: string; critOpId: string; seed: number; mode?: 'match' | 'sandbox' }
  | { t: 'RollOff'; kind: 'initiative' | 'generic' }
  | { t: 'ChooseInitiative'; player: PlayerId; choice: PlayerId }
  | { t: 'ChooseDropZone'; player: PlayerId; zone: 'p1' | 'p2' }
  | { t: 'SelectRoster'; player: PlayerId; teamId: string; operatives: RosterPick[] }
  | { t: 'SelectEquipment'; player: PlayerId; equipment: string[] }
  | { t: 'SelectTacOp'; player: PlayerId; tacOpId: string }
  | { t: 'PlaceEquipment'; player: PlayerId; equipmentId: string; itemIndex: number; pos: Vec2; rotDeg?: number; z?: number }
  | { t: 'SkipEquipmentPlacement'; player: PlayerId }
  | { t: 'DeployOperative'; player: PlayerId; operativeId: string; pos: Vec2; rotDeg?: number; z?: number }
  | { t: 'FinishSetup' }
  // ---- strategy phase ----------------------------------------------------
  | { t: 'PlayInitiativeCard'; player: PlayerId; cardId: string }
  | { t: 'PassInitiativeCards'; player: PlayerId }
  | { t: 'UseGambit'; player: PlayerId; gambitId: string; data?: Record<string, unknown> }
  | { t: 'PassGambit'; player: PlayerId }
  | { t: 'SelectPrimaryOp'; player: PlayerId; opId: string }
  // ---- firefight phase ---------------------------------------------------
  | { t: 'ActivateOperative'; player: PlayerId; operativeId: string; order: Order }
  | { t: 'Counteract'; player: PlayerId; operativeId: string }
  | { t: 'DeclineCounteract'; player: PlayerId }
  | { t: 'PerformAction'; operativeId: string; action: string; params?: ActionParams }
  | { t: 'EndActivation'; operativeId: string }
  // ---- reactive windows --------------------------------------------------
  | { t: 'ResolveDecision'; decisionId: string; optionId: string; data?: Record<string, unknown> }
  | { t: 'PassDecision'; decisionId: string }
  | { t: 'UsePloy'; player: PlayerId; ployId: string; data?: Record<string, unknown> }
  | { t: 'OnGuardInterrupt'; player: PlayerId; operativeId: string; action: 'Shoot' | 'Fight'; params?: ActionParams }
  | { t: 'DeclineInterrupt'; player: PlayerId }
  // ---- flow --------------------------------------------------------------
  | { t: 'AdvancePhase' }
  | { t: 'Concede'; player: PlayerId }
  // ---- sandbox / tools ---------------------------------------------------
  | { t: 'MoveOperativeFree'; operativeId: string; pos: Vec2; z?: number; rotDeg?: number };

export interface RosterPick {
  /** Datacard id from data/teams/<slug>.json. */
  datacardId: string;
  /** Chosen loadout id where the selection rules offer a choice. */
  loadoutId?: string;
  /** Explicit weapon names where a list entry fixes them. */
  weapons?: string[];
}

export interface ActionParams {
  /** Reposition / Dash / Fall Back / Charge / Move With Barricade. */
  path?: MovePath;
  /** Shoot. */
  weaponName?: string;
  profileName?: string;
  targetId?: string;
  /** Fight. */
  meleeWeaponName?: string;
  meleeProfileName?: string;
  /** Pick Up / Place Marker. */
  markerId?: string;
  markerPos?: Vec2;
  /** Operate Hatch / Breach. */
  partId?: string;
  /** Unique/mission actions. */
  targetOperativeId?: string;
  targetPos?: Vec2;
  choice?: string;
  data?: Record<string, unknown>;
}

/** Result of a reduce() call: the new state plus what happened. */
export interface ReduceResult {
  state: import('./types.ts').GameState;
  ok: boolean;
  reason?: string;
}
