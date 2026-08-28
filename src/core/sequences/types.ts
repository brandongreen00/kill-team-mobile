/** Serialisable state for the in-flight Shoot / Fight sequence. */
import type { DicePool } from '../dice.ts';
import type { PlayerId } from '../types.ts';

export type ShootStep =
  | 'start'
  | 'coverChoice'
  | 'rollAttack'
  | 'attackRerolls'
  | 'retention'
  | 'obscuredDiscard'
  | 'rollDefence'
  | 'defenceRerolls'
  | 'allocate'
  | 'resolve'
  | 'nextTarget'
  | 'done';

export interface ShootSequence {
  kind: 'shoot';
  step: ShootStep;
  attackerId: string;
  /** The primary target; Blast/Torrent secondaries are queued behind it. */
  targetId: string;
  queue: string[];
  /**
   * Which weapon rule filled `queue`. Blast: "Secondary targets are in cover and obscured if
   * the primary target was." Torrent prints no such clause, so its secondaries are checked
   * for themselves.
   */
  spread?: 'blast' | 'torrent';
  resolvedTargets: string[];
  weaponName: string;
  profileName?: string;
  /** True while resolving a secondary Blast/Torrent target. */
  secondary: boolean;
  pointBlank: boolean;
  /** Snapshot of the visibility verdict for this sequence. */
  inCover: boolean;
  obscured: boolean;
  coverChoiceMade: boolean;
  vantageAccurate: number;
  vantageImprovedCover: boolean;
  attack: DicePool;
  defence: DicePool;
  /** Reroll grants already used this pool, so each is offered once. */
  usedRerolls: string[];
  /** Retention options already applied. */
  usedRetention: string[];
  /** Cumulative damage for the log/animation. */
  damage: number;
  /** Set when the weapon has Limited x and the use has been counted. */
  useCounted: boolean;
  attacker: PlayerId;
  defender: PlayerId;
  /** Free action from an On Guard interrupt: no AP is spent. */
  free: boolean;
}

export type FightStep =
  | 'start'
  | 'rollAttack'
  | 'attackerRerolls'
  | 'defenderRerolls'
  | 'retention'
  | 'resolve'
  | 'done';

export interface FightSequence {
  kind: 'fight';
  step: FightStep;
  attackerId: string;
  defenderId: string;
  attackerWeapon: string;
  attackerProfile?: string;
  defenderWeapon?: string;
  defenderProfile?: string;
  /** "If a rule says an operative cannot retaliate... attack dice cannot be collected." */
  defenderCanRetaliate: boolean;
  attackerPool: DicePool;
  defenderPool: DicePool;
  /** Whose turn it is to resolve a die. */
  turn: 'attacker' | 'defender';
  usedRerolls: string[];
  /** Which sides have run out of re-roll grants, for the alternating window. */
  rerollsDone?: { attacker: boolean; defender: boolean };
  usedRetention: string[];
  /** Shock: "The first time you strike with a critical success in each sequence..." */
  shockUsed: { attacker: boolean; defender: boolean };
  attackerAssists: number;
  defenderAssists: number;
  attacker: PlayerId;
  defender: PlayerId;
  free: boolean;
  /** Hatchway Fight treats the operatives as within each other's control range. */
  hatchway: boolean;
}

export type SequenceState = ShootSequence | FightSequence;
