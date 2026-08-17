/**
 * The effect/hook DSL. THE KERNEL KNOWS NO FACTION.
 *
 * Team rules, ploys, equipment, killzone rules and ops all register typed handlers
 * against named hook points. The kernel dispatches them in a deterministic order and
 * they mutate a per-hook event object; nothing else may reach into the sequences.
 *
 * Determinism: handlers are sorted by (priority, sourceId, bindingId). Where the rules
 * genuinely leave an ordering choice ("if multiple rules take effect at the same time,
 * the player with initiative decides"), the sequence raises a PendingDecision rather
 * than picking silently.
 *
 * Unknown hook names are a build error (`assertHookName`), never a silent no-op.
 */
import type {
  ActiveEffect,
  GameState,
  Order,
  OperativeState,
  PlayerId,
  TerrainPart,
  WeaponProfile,
  WeaponRule,
} from './types.ts';

// ---------------------------------------------------------------------------
// Hook names
// ---------------------------------------------------------------------------

export const HOOK_NAMES = [
  'onBattleSetup',
  'onSelectEquipment',
  'onDeploy',
  'initiativeRollModifiers',
  'onReadyStep',
  'gambitOptions',
  'onPloyUsed',
  'onActivationStart',
  'onActivationEnd',
  'onCounteract',
  'onActionCost',
  'canPerformAction',
  'onMoveDistance',
  'onMoveRules',
  'onSetUpAgain',
  'availableWeapons',
  'onWeaponRules',
  'onSelectWeapon',
  'onCollectAttackDice',
  'onSelectTarget',
  'onValidTarget',
  'onStunTest',
  'onRollAttack',
  'onAttackDiceRetained',
  'onDefenceDice',
  'onBlockAllocation',
  'onDamage',
  'onIncapacitated',
  'onFightAssist',
  'onStrikeResolved',
  'onOrderChange',
  'onMarkerControl',
  'onEndOfTP',
  'onScore',
  'onStatMod',
  'onFreeActions',
  'onSupportDistance',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

const HOOK_SET = new Set<string>(HOOK_NAMES);

export function assertHookName(name: string): asserts name is HookName {
  if (!HOOK_SET.has(name)) {
    throw new Error(
      `Unknown hook '${name}'. Add it to HOOK_NAMES in src/core/hooks.ts — hooks are never silent no-ops.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/** Rerolls a player may take on a dice pool. Each grant is offered as a decision. */
export interface RerollGrant {
  id: string;
  label: string;
  /** 'any' = pick any dice (Relentless), 'one' = pick one die (Balanced),
   *  'value' = re-roll all dice showing one chosen value (Ceaseless),
   *  'fails' = only failed dice. */
  mode: 'any' | 'one' | 'value' | 'fails';
  /** Maximum dice re-rolled; undefined = unlimited within the mode. */
  max?: number;
  sourceText?: string;
  /** CP cost, for Command Re-roll and CP-priced faction rerolls. */
  cp?: number;
  /** Which player may take it (defaults to the pool's owner). */
  player?: PlayerId;
}

export interface StatMods {
  /** Positive = improve (a 4+ Hit improved by 1 is 3+). */
  hit: number;
  save: number;
  apl: number;
  move: number;
  /** Extra attack dice. */
  atk: number;
}

export const zeroStatMods = (): StatMods => ({ hit: 0, save: 0, apl: 0, move: 0, atk: 0 });

export interface AttackContext {
  attacker: OperativeState;
  defender?: OperativeState;
  weaponName: string;
  profile: WeaponProfile;
  rules: WeaponRule[];
  type: 'ranged' | 'melee';
  /** True while resolving a secondary Blast/Torrent target. */
  secondary: boolean;
  /** Point-blank shot from an On Guard interrupt (Hit worsened by 1). */
  pointBlank: boolean;
  inCover: boolean;
  obscured: boolean;
  /** Vantage: Accurate 1 at >=2" lower, Accurate 2 at >=4" lower. */
  vantageAccurate: number;
  distance: number;
}

export interface HookEvents {
  onBattleSetup: { state: GameState };
  onSelectEquipment: { state: GameState; player: PlayerId; equipment: string[] };
  onDeploy: { state: GameState; operative: OperativeState; extraZones?: string[] };
  initiativeRollModifiers: { state: GameState; player: PlayerId; mod: number; rerollOffered: boolean };
  onReadyStep: { state: GameState; player: PlayerId; cp: number };
  gambitOptions: { state: GameState; player: PlayerId; options: { id: string; label: string; sourceText?: string }[] };
  /**
   * A ploy (or STRATEGIC GAMBIT) has just been paid for. This is where its immediate effect
   * happens — placing a marker, pushing an ActiveEffect, granting an operative a free action.
   * Ploys whose effect is a lasting modifier can instead read `ploysUsedTP`/`gambitsUsedTP`.
   */
  onPloyUsed: {
    state: GameState;
    player: PlayerId;
    ployId: string;
    kind: 'strategy' | 'firefight';
    data?: Record<string, unknown>;
  };
  onActivationStart: { state: GameState; operative: OperativeState };
  onActivationEnd: { state: GameState; operative: OperativeState };
  onCounteract: { state: GameState; operative: OperativeState; allowed: boolean; reason?: string };
  onActionCost: { state: GameState; operative: OperativeState; action: string; ap: number };
  canPerformAction: { state: GameState; operative: OperativeState; action: string; allowed: boolean; reason?: string };
  onMoveDistance: { state: GameState; operative: OperativeState; action: string; inches: number };
  onMoveRules: {
    state: GameState;
    operative: OperativeState;
    action: string;
    ignoreClimbCost: boolean;
    ignoreDropInches: number;
    mayMoveThroughEnemies: boolean;
    ignoreControlRange: boolean;
    /** e.g. FLY: remove and set up again. */
    teleport: boolean;
  };
  /** Rules that remove and set an operative up again (FLY, teleport, ops) may cap the distance. */
  onSetUpAgain: { state: GameState; operative: OperativeState; maxInches: number; reason?: string };
  availableWeapons: { state: GameState; operative: OperativeState; weapons: string[] };
  /**
   * The weapon rules in effect for one use of a weapon, after the killzone's own changes
   * (Condensed Environment). This is where "friendly X operatives' ranged weapons have the
   * Severe weapon rule" style team rules, ploys and equipment take effect: they push (or
   * remove) entries in `rules`. Emitted by `effectiveRules` on every read, so it is re-derived
   * at each step of the shoot/fight sequence and never goes stale.
   */
  onWeaponRules: {
    state: GameState;
    operative: OperativeState;
    /** The intended target, when the sequence knows one. */
    target?: OperativeState;
    weaponName: string;
    profile: WeaponProfile;
    type: 'ranged' | 'melee';
    /** True while the operative is the defender in a fight (retaliating). */
    retaliating: boolean;
    rules: WeaponRule[];
  };
  onSelectWeapon: { state: GameState; ctx: AttackContext; allowed: boolean; reason?: string };
  onCollectAttackDice: { state: GameState; ctx: AttackContext; count: number; mods: StatMods };
  /**
   * The Select Valid Target step, before the target is checked. A rule may substitute the
   * target — "…becomes the valid target instead (even if it wouldn't normally be valid for
   * this)" (Celestian Insidiants' HOLY DEFENDER, Pathfinders' SAVIOUR PROTOCOLS). The
   * substitute inherits the original's cover/obscured, exactly as those rules print it.
   */
  onSelectTarget: {
    state: GameState;
    attacker: OperativeState;
    target: OperativeState;
    weaponName: string;
    profile: WeaponProfile;
    rules: WeaponRule[];
    redirectTo?: string;
  };
  onValidTarget: {
    state: GameState;
    attacker: OperativeState;
    target: OperativeState;
    valid: boolean;
    reason?: string;
    /** Overrides discovered by rules (Seek, smoke, Bheta restrictions). */
    ignoreCoverTerrain: 'none' | 'light' | 'all';
    forceVisible: boolean;
    /**
     * "Having other friendly operatives within an enemy operative's control range doesn't
     * prevent that enemy operative from being selected" (Pathfinders' SUPPORTING FIRE).
     */
    ignoreFriendlyControlRange?: boolean;
    /**
     * Determine visibility, cover and obscured from THIS operative instead of the shooter —
     * "treat that operative as the active operative for the purposes of determining a valid
     * target, cover and obscured" (the Hierotek Circle's Magnify weapon rule).
     */
    viewFrom?: OperativeState;
  };
  /**
   * A stun test rolled by the Stun Grenade action, before its 3+ threshold is applied.
   * Rules that add to it (Celestian Insidiants' PSYK-OUT GRENADES) push into `damage`.
   */
  onStunTest: { state: GameState; thrower: OperativeState; target: OperativeState; roll: number; damage: number };
  onRollAttack: { state: GameState; ctx: AttackContext; dice: number[]; rerolls: RerollGrant[] };
  onAttackDiceRetained: {
    state: GameState;
    ctx: AttackContext;
    crits: number;
    normals: number;
    fails: number[];
    /** Rules the player may apply in an order of their choice. */
    options: { id: string; label: string; sourceText?: string }[];
  };
  onDefenceDice: {
    state: GameState;
    ctx: AttackContext;
    count: number;
    coverSave: boolean;
    /** Vantage: cover save retained as a critical success, or an additional one. */
    coverSaveAsCrit: boolean;
    extraCoverSaves: number;
    mods: StatMods;
    rerolls: RerollGrant[];
  };
  /**
   * How many of the opponent's unresolved successes one block discards. The core answer is
   * one; the rare `Shield` weapon rule makes it two ("each of your blocks can be allocated to
   * block two unresolved successes instead of one").
   */
  onBlockAllocation: {
    state: GameState;
    ctx: AttackContext;
    brutal: boolean;
    blocks: number;
    /** Dueller-style rules: "each of your normal successes can block one critical success". */
    normalsCanBlockCrits: boolean;
  };
  onDamage: {
    state: GameState;
    ctx: AttackContext | null;
    target: OperativeState;
    amount: number;
    kind: 'attack' | 'mortal' | 'devastating' | 'hazard' | 'mine' | 'other';
  };
  onIncapacitated: { state: GameState; operative: OperativeState; prevented: boolean; freeActions: string[] };
  onFightAssist: { state: GameState; operative: OperativeState; assists: number };
  onStrikeResolved: { state: GameState; ctx: AttackContext; crit: boolean; struck: OperativeState };
  onOrderChange: { state: GameState; operative: OperativeState; order: Order; allowed: boolean };
  onMarkerControl: { state: GameState; markerId: string; aplByPlayer: Record<PlayerId, number>; forced?: PlayerId };
  onEndOfTP: { state: GameState };
  onScore: { state: GameState; player: PlayerId; opId: string; vp: number };
  onStatMod: { state: GameState; operative: OperativeState; mods: StatMods };
  onFreeActions: { state: GameState; operative: OperativeState; actions: { id: string; label: string }[] };
  /**
   * The distance requirement of a SUPPORT rule that refers to friendly operatives, so
   * equipment (Comms Device: +3") can widen it.
   */
  onSupportDistance: { state: GameState; operative: OperativeState; inches: number };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RuleBinding {
  /** Which rule instance is speaking, for the log and the in-app tooltip. */
  id: string;
  /** Short verbatim quote of the printed rule. */
  sourceText: string;
  sourceUrl?: string;
  /** Lower runs first. Core rules use 0; team rules 10; ploys 20; equipment 30. */
  priority?: number;
  /** Which player's rule this is (used to scope "friendly"/"enemy" and ordering). */
  player?: PlayerId;
  /** Restricted to one operative (an ability or a temporary effect). */
  operativeId?: string;
}

export type HookHandler<K extends HookName> = (ev: HookEvents[K], binding: RuleBinding) => void;

interface Registration<K extends HookName = HookName> {
  hook: K;
  handler: HookHandler<K>;
  binding: RuleBinding;
  /** Optional cheap filter run before the handler. */
  when?: (state: GameState, binding: RuleBinding) => boolean;
}

export class HookRegistry {
  private readonly byHook = new Map<HookName, Registration[]>();

  on<K extends HookName>(
    hook: K,
    binding: RuleBinding,
    handler: HookHandler<K>,
    when?: (state: GameState, binding: RuleBinding) => boolean,
  ): this {
    assertHookName(hook);
    const list = this.byHook.get(hook) ?? [];
    list.push({ hook, handler: handler as HookHandler<HookName>, binding, when });
    this.byHook.set(hook, list);
    return this;
  }

  /** Deterministic dispatch: priority, then binding id. */
  emit<K extends HookName>(hook: K, state: GameState, ev: HookEvents[K]): HookEvents[K] {
    const list = this.byHook.get(hook);
    if (!list || list.length === 0) return ev;
    const sorted = [...list].sort((a, b) => {
      const pa = a.binding.priority ?? 0;
      const pb = b.binding.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.binding.id < b.binding.id ? -1 : a.binding.id > b.binding.id ? 1 : 0;
    });
    for (const reg of sorted) {
      if (reg.when && !reg.when(state, reg.binding)) continue;
      (reg.handler as HookHandler<K>)(ev, reg.binding);
    }
    return ev;
  }

  has(hook: HookName): boolean {
    return (this.byHook.get(hook)?.length ?? 0) > 0;
  }

  /** All bindings, for the "why did that happen?" panel. */
  bindings(): RuleBinding[] {
    const out: RuleBinding[] = [];
    for (const list of this.byHook.values()) for (const r of list) out.push(r.binding);
    return out;
  }

  merge(other: HookRegistry): this {
    for (const [hook, list] of other.byHook) {
      const mine = this.byHook.get(hook) ?? [];
      this.byHook.set(hook, [...mine, ...list]);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Team module contract
// ---------------------------------------------------------------------------

export interface PloyDef {
  id: string;
  name: string;
  kind: 'strategy' | 'firefight';
  cp: number;
  text: string;
  /** Extra legality beyond CP + once-per-TP. */
  usable?: (state: GameState, player: PlayerId) => { ok: boolean; reason?: string };
  /** Which decision windows offer it, e.g. ['onRollAttack']. Strategy ploys use the gambit step. */
  windows?: HookName[];
}

export interface TeamEquipmentDef {
  id: string;
  name: string;
  text: string;
  /** Extra weapons this equipment grants, keyed by datacard id or '*'. */
  grantsWeapons?: Record<string, string[]>;
  /** Kill-team-wide use budget (grenade-style). */
  uses?: number;
  /** Terrain or markers set up before the battle. */
  setup?: { kind: 'marker' | 'terrain'; count: number };
}

export interface TeamModule {
  id: string;
  /**
   * Registers all faction rules, ploys, equipment and unique actions as hooks.
   * Hook handlers are not given a GameContext, so `rebuildHooks` passes it here for the
   * module to capture: team rules need datacards (keywords, bases) and geometry.
   */
  register(reg: HookRegistry, player: PlayerId, ctx?: import('./context.ts').GameContext): void;
  ploys: PloyDef[];
  equipment: TeamEquipmentDef[];
  /** Light hints so the generic AI can use the team without team-specific AI code. */
  aiHints?: {
    roles?: Record<string, 'leader' | 'sniper' | 'gunner' | 'melee' | 'support' | 'objective' | 'scout'>;
    ployValue?: Record<string, number>;
    equipmentValue?: Record<string, number>;
  };
}

/** Helper for effects that expire, used by ploys and abilities alike. */
export function pushEffect(state: GameState, effect: ActiveEffect): void {
  state.effects.push(effect);
}

export function hasEffect(state: GameState, rule: string, opts: { operativeId?: string; player?: PlayerId } = {}): boolean {
  return state.effects.some(
    (e) =>
      e.rule === rule &&
      (opts.operativeId === undefined || e.operativeId === opts.operativeId) &&
      (opts.player === undefined || e.player === opts.player),
  );
}

export function effectsFor(state: GameState, operativeId: string): ActiveEffect[] {
  return state.effects.filter((e) => e.operativeId === operativeId);
}

/** Terrain parts a rule wants to ignore, e.g. "ignore Heavy terrain connected to Vantage". */
export type PartFilter = (part: TerrainPart) => boolean;
