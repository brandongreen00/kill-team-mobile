/**
 * Core domain types for Kill Team 3rd edition (KT24).
 *
 * INVARIANTS (see CLAUDE.md §Architecture):
 *  - All distances are INCHES, floats. Base sizes are stored in mm and converted once.
 *  - Board origin is BOTTOM-LEFT, +x right along the long edge, +y up. z is elevation in inches.
 *  - Nothing in src/core may import DOM/React/IO. State changes only via reduce(state, intent).
 */

export const MM_PER_INCH = 25.4;

export type PlayerId = 'p1' | 'p2';

export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Segment {
  a: Vec2;
  b: Vec2;
}
export type Poly = Vec2[];

export const otherPlayer = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');

// ---------------------------------------------------------------------------
// Terrain (2.5D): every terrain part is an extruded polygon.
// ---------------------------------------------------------------------------

/**
 * Terrain types, Killzones page + Universal Equipment page.
 * Heavy      — obscures (core: "An operative is obscured if there's intervening Heavy terrain").
 * Light      — no additional rules beyond being terrain (cover only).
 * Blocking   — visibility cannot be drawn through it, and it's intervening.
 * Vantage    — upper levels; also counts as Light.
 * Accessible — operatives can move through it (+1"), measured from centre of base.
 * Insignificant — ignored for climbing/dropping.
 * Exposed    — never intervening.
 * Ceiling    — bases <=50mm round / 60x35 oval can move underneath.
 * Wall       — Gallowdark/Tomb World: no movement or visibility over/through; distances measured around.
 * Barred     — Volkus large-ruin unbroken windows: visibility only within 1" horizontally.
 * Obstructing / Protective / Portable — universal equipment types.
 * Hazardous  — Bheta-Decima ocean: no base may touch it.
 */
export type TerrainType =
  | 'Heavy'
  | 'Light'
  | 'Blocking'
  | 'Vantage'
  | 'Accessible'
  | 'Insignificant'
  | 'Exposed'
  | 'Ceiling'
  | 'Wall'
  | 'Barred'
  | 'Obstructing'
  | 'Protective'
  | 'Portable'
  | 'Hazardous';

export type PartRole =
  | 'floor'
  | 'wall'
  | 'door'
  | 'window'
  | 'rampart'
  | 'pillar'
  | 'hatch'
  | 'accessPoint'
  | 'breachWall'
  | 'teleportPad'
  | 'ledge'
  | 'stairs'
  | 'vent'
  | 'firestep'
  | 'rubble'
  | 'crate'
  | 'equipment';

export interface TerrainPart {
  id: string;
  featureId: string;
  /** World-space polygon (CCW), inches. */
  poly: Poly;
  /** Bottom / top elevation in inches. */
  z0: number;
  z1: number;
  types: TerrainType[];
  role?: PartRole;
  /** Doors, hatches and breach points toggle at runtime. */
  state?: 'open' | 'closed';
  /**
   * Does this part physically block a visibility line? Defaults to true for solid parts.
   * Floors of Vantage terrain block lines that pass through them; Exposed/Insignificant
   * decorations (fire steps, ramparts feet, ladders) generally do not.
   */
  blocksVisibility?: boolean;
  /** Can a base be placed on top of this part (Vantage floors, gantry floors, rubble)? */
  standable?: boolean;
  /** Does a base moving at ground level collide with this part? */
  solid?: boolean;
}

export interface TerrainFeature {
  id: string;
  /** e.g. 'volkus.strongholdA', 'gallowdark.wallA3', 'equipment.heavyBarricade' */
  kind: string;
  /** Card letter (A..N) where the source map card labels it. */
  label?: string;
  parts: TerrainPart[];
  placement: { x: number; y: number; rotDeg: number; flip: boolean };
  /** Connected gantries count as one terrain feature (Bheta-Decima). */
  groupId?: string;
  /** Set for equipment terrain placed during setup. */
  owner?: PlayerId;
}

export type KillzoneId = 'volkus' | 'bheta-decima' | 'gallowdark' | 'tomb-world';

export interface ObjectiveMarkerDef {
  id: string;
  /** Which player's home objective, or the centre one. */
  kind: 'p1' | 'p2' | 'centre';
  pos: Vec2;
  z: number;
  onFeatureId?: string;
  /** Bheta-Decima map 6: "BENEATH THERMOMETRIC CONDENSER". */
  note?: string;
}

export interface KillzoneMap {
  id: string;
  killzone: KillzoneId;
  name: string;
  board: { w: number; h: number; grid: 1 | 3.8125; border?: number };
  /** Gallowdark + Tomb World (owner decision, docs/DECISIONS.md D-002). */
  closeQuarters: boolean;
  dropZones: { p1: Poly[]; p2: Poly[] };
  territories: { p1: Poly[]; p2: Poly[] };
  killzoneEdges: { p1: Segment[]; p2: Segment[]; neutral: Segment[] };
  centreLine: Segment;
  flankLine: Segment;
  objectives: ObjectiveMarkerDef[];
  hazardous?: Poly[];
  features: TerrainFeature[];
  source: {
    card: string;
    pxPerInch: number;
    extractedAt: string;
    tool: string;
    qa?: Record<string, number | string | boolean>;
  };
}

// ---------------------------------------------------------------------------
// Datacards
// ---------------------------------------------------------------------------

export type BaseShape = { shape: 'round'; mm: number } | { shape: 'oval'; mm: [number, number] };

export type WeaponType = 'ranged' | 'melee';

/** A parsed universal or rare weapon rule. `x` carries the numeric parameter where one exists. */
export interface WeaponRule {
  id: WeaponRuleId;
  x?: number;
  /** Distance-prefixed forms, e.g. `1" Devastating 3` -> { id:'Devastating', x:3, dist:1 } */
  dist?: number;
  /** Restricted sub-forms: Heavy (Dash only) -> { id:'Heavy', only:'Dash' }. */
  only?: string;
  /** Verbatim token from the datacard, kept for display and lint. */
  raw: string;
}

export type WeaponRuleId =
  // 23 universal rules (Appendix › WEAPON RULES)
  | 'Accurate'
  | 'Balanced'
  | 'Blast'
  | 'Brutal'
  | 'Ceaseless'
  | 'Devastating'
  | 'Heavy'
  | 'Hot'
  | 'Lethal'
  | 'Limited'
  | 'Piercing'
  | 'PiercingCrits'
  | 'Punishing'
  | 'Range'
  | 'Relentless'
  | 'Rending'
  | 'Saturate'
  | 'Seek'
  | 'SeekLight'
  | 'Severe'
  | 'Shock'
  | 'Silent'
  | 'Stun'
  | 'Torrent'
  // rare rules provided by team modules; registry-checked, never a silent no-op
  | RareWeaponRuleId;

export type RareWeaponRuleId = string & { readonly __rare?: unique symbol };

export interface WeaponProfile {
  /** Secondary name in brackets, e.g. 'supercharge'. Empty for single-profile weapons. */
  name?: string;
  type: WeaponType;
  atk: number;
  hit: number;
  dmgN: number;
  dmgC: number;
  rules: WeaponRule[];
}

export interface Weapon {
  /** Primary name — rules referring to the primary name include all profiles. */
  name: string;
  profiles: WeaponProfile[];
}

export interface UniqueActionDef {
  id: string;
  name: string;
  ap: number;
  keywords?: string[]; // SUPPORT, PSYCHIC, ...
  text: string;
}

export interface AbilityDef {
  id: string;
  name: string;
  text: string;
}

export interface Datacard {
  id: string;
  teamId: string;
  name: string;
  keywords: string[];
  base: BaseShape;
  apl: number;
  move: number;
  save: number;
  wounds: number;
  weapons: Weapon[];
  abilities: AbilityDef[];
  uniqueActions: UniqueActionDef[];
  /** Model height in inches, derived from base class (docs/DECISIONS.md D-005). */
  height?: number;
  fluff?: string;
}

// ---------------------------------------------------------------------------
// Live game state
// ---------------------------------------------------------------------------

export type Order = 'engage' | 'conceal';

/** Duration for a temporary effect attached to an operative or player. */
export type EffectExpiry =
  | { kind: 'endOfTurningPoint' }
  | { kind: 'endOfBattle' }
  | { kind: 'endOfActivation'; operativeId: string }
  | { kind: 'endOfNextActivation'; operativeId: string; armed: boolean }
  | { kind: 'startOfNextTurningPoint' }
  | { kind: 'endOfAction' }
  | { kind: 'nActivations'; remaining: number };

export interface ActiveEffect {
  id: string;
  /** Hook/rule identifier the effect engine dispatches on. */
  rule: string;
  /** Where it came from, for the log and in-app rule tooltip. */
  source: { kind: 'ploy' | 'equipment' | 'ability' | 'weapon' | 'terrain' | 'op' | 'core'; id: string };
  sourceText?: string;
  player?: PlayerId;
  operativeId?: string;
  data?: Record<string, unknown>;
  expiry: EffectExpiry;
}

export interface OperativeState {
  id: string;
  player: PlayerId;
  datacardId: string;
  /** Display letter, unique within a team. */
  letter: string;
  pos: Vec2;
  z: number;
  /** Facing in degrees, used for oval bases. */
  rot: number;
  order: Order;
  ready: boolean;
  /** Expended = activated this turning point. */
  expended: boolean;
  counteractedThisTP: boolean;
  wounds: number;
  apSpent: number;
  /** Actions performed this activation, for action restrictions. */
  actionsThisActivation: string[];
  onGuard: boolean;
  /** Set when a Guard interrupt is used; blocks counteract for the TP. */
  guardSpentTP: number | null;
  carryingMarkerId?: string;
  /** APL modifiers pending, clamped to [-1, +1] when read. */
  aplMods: number[];
  /** Weapons whose Limited x uses have been consumed. */
  weaponUses: Record<string, number>;
  /** Set while the operative is in a Charge that made it the sole engager. */
  stickyEngagedWith: string[];
  /** Placement on a teleport pad means "not on the killzone floor". */
  onTeleportPadId?: string;
  removed?: boolean;
  incapacitated?: boolean;
}

export type MarkerKind =
  | 'objective'
  | 'ammoCache'
  | 'commsDevice'
  | 'mine'
  | 'smoke'
  | 'device'
  | 'intelligence'
  | 'retrieval'
  | 'banner'
  | 'martyr'
  | 'swept'
  | 'dominate'
  | 'orb'
  | 'energyCell'
  | 'download'
  | 'data'
  | 'reboot'
  | 'generic';

export interface MarkerState {
  id: string;
  kind: MarkerKind;
  /** 40mm for objectives, 20mm for everything else (core rules › Markers). */
  diameterMm: number;
  pos: Vec2;
  z: number;
  owner?: PlayerId;
  carriedBy?: string;
  /** Op-specific flags: used this TP, downloaded, inert, claimed by, etc. */
  flags: Record<string, string | number | boolean>;
}

export type PhaseId = 'setup' | 'strategy' | 'firefight' | 'endOfTP' | 'battleEnd';
export type StrategyStep = 'initiative' | 'ready' | 'gambit';
export type FirefightStep = 'determineOrder' | 'performActions' | 'expended';

export interface RollRecord {
  /** Monotonic index into the dice journal. */
  seq: number;
  kind: string;
  player?: PlayerId;
  results: number[];
  note?: string;
}

export interface LogEntry {
  seq: number;
  tp: number;
  kind: 'action' | 'dice' | 'score' | 'ploy' | 'system' | 'reject' | 'decision';
  player?: PlayerId;
  text: string;
  data?: Record<string, unknown>;
}

export interface TeamState {
  teamId: string;
  /** Operative ids in selection order. */
  operativeIds: string[];
  cp: number;
  vp: number;
  equipment: string[];
  archetypes: string[];
  tacOpId?: string;
  primaryOpId?: string;
  /** Per-TP VP breakdown keyed by op id. */
  vpByOp: Record<string, number[]>;
  /** Ploys used this turning point. */
  ploysUsedTP: string[];
  /** STRATEGIC GAMBITs used this turning point (including strategy ploys). */
  gambitsUsedTP: string[];
  /** Initiative cards held (Approved Ops). */
  initiativeCards: string[];
  /** Kill-team-wide equipment use counters (utility/explosive grenades). */
  equipmentUses: Record<string, number>;
  /** Starting size, for the kill op grade table. */
  startingSize: number;
  killGrade: number;
  passedGambit: boolean;
}

export interface SetupState {
  step:
    | 'chooseMission'
    | 'rollOff'
    | 'chooseDropZone'
    | 'selectOperatives'
    | 'selectEquipment'
    | 'selectTacOp'
    | 'placeEquipment'
    | 'deploy'
    | 'done';
  initiative?: PlayerId;
  /** Player -> drop zone key ('p1'|'p2' zone of the map). */
  dropZone: Partial<Record<PlayerId, 'p1' | 'p2'>>;
  revealed: Partial<Record<PlayerId, boolean>>;
  deployedCount: Partial<Record<PlayerId, number>>;
  equipmentPlaced: Partial<Record<PlayerId, number>>;
  /** Set by `SkipEquipmentPlacement`: that player is finished setting equipment up. */
  equipmentDone?: Partial<Record<PlayerId, boolean>>;
  /** Whose turn it is to act during an alternating setup step. */
  toAct?: PlayerId;
}

export interface PendingDecision {
  id: string;
  who: PlayerId;
  kind: string;
  prompt: string;
  options: DecisionOption[];
  /** Free-form payload the reducer needs to resume the interrupted sequence. */
  ctx?: Record<string, unknown>;
  /** If true the decision may be declined with a `pass` intent. */
  optional?: boolean;
  /** Rule text for the in-app tooltip. */
  sourceText?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  /** Extra structured payload (dice indices, target ids, ...). */
  data?: Record<string, unknown>;
  disabled?: boolean;
  reason?: string;
}

export interface GameState {
  /** 'sandbox' relaxes match-only guards for the measuring/dice tools. */
  mode: 'match' | 'sandbox';
  seed: number;
  rngCursor: number;
  map: KillzoneMap;
  missionPack: 'approved-ops-2025';
  critOpId?: string;
  turningPoint: number;
  maxTurningPoints: number;
  phase: PhaseId;
  strategyStep?: StrategyStep;
  firefightStep?: FirefightStep;
  initiative?: PlayerId;
  /** Whose activation it is. */
  activePlayer?: PlayerId;
  activeOperativeId?: string;
  /** Set while a Guard interrupt suspends an activation. */
  interrupted?: { operativeId: string; resumePlayer: PlayerId } | null;
  setup: SetupState;
  teams: Record<PlayerId, TeamState>;
  operatives: Record<string, OperativeState>;
  markers: Record<string, MarkerState>;
  effects: ActiveEffect[];
  /** Terrain state overrides (open doors/hatches/breaches, removed mines). */
  terrainState: Record<string, { state?: 'open' | 'closed'; removed?: boolean }>;
  /** Equipment terrain placed during setup, appended to map.features at compile time. */
  placedFeatures: TerrainFeature[];
  /** The in-flight Shoot/Fight sequence, if any (resumable across decisions). */
  sequence?: import('./sequences/types.ts').SequenceState | null;
  pending: PendingDecision[];
  log: LogEntry[];
  rolls: RollRecord[];
  /** Rejected intents — the AI acceptance tests assert this stays empty. */
  rejected: { intent: unknown; reason: string; seq: number }[];
  seq: number;
  winner?: PlayerId | 'draw';
  /** Op-specific scratch space, namespaced by op id. */
  opState: Record<string, Record<string, unknown>>;
  /** Activations completed this turning point (smoke duration counts these). */
  activationsThisTP: number;
}
