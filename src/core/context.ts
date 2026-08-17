/**
 * The injected environment the reducer runs in: static data, RNG, and the hook registry.
 * Nothing here is stored on GameState (which must stay serialisable).
 */
import { HookRegistry, type TeamModule } from './hooks.ts';
import type { Rng } from './rng.ts';
import { buildTerrainIndex, type TerrainIndex } from './terrain.ts';
import type { Datacard, GameState, KillzoneMap, PlayerId, Vec2 } from './types.ts';

export interface PlaceEquipmentIntent {
  player: PlayerId;
  equipmentId: string;
  itemIndex: number;
  pos: Vec2;
  rotDeg?: number;
  z?: number;
}

export interface OpDef {
  id: string;
  kind: 'crit' | 'tac' | 'kill' | 'primary';
  name: string;
  archetype?: string;
  text: string;
  /** Registers scoring + mission actions. */
  register?(reg: HookRegistry, player: PlayerId): void;
}

export interface EquipmentDef {
  id: string;
  name: string;
  text: string;
  /** 'universal' options are available to every kill team. */
  scope: 'universal' | 'faction';
  teamId?: string;
  register?(reg: HookRegistry, player: PlayerId): void;
}

export interface GameContext {
  datacards: Map<string, Datacard>;
  maps: Map<string, KillzoneMap>;
  teams: Map<string, TeamModule>;
  ops: Map<string, OpDef>;
  equipment: Map<string, EquipmentDef>;
  rng: Rng;
  hooks: HookRegistry;
  /**
   * Integration seams filled in by the equipment and ops layers. The reducer stays the single
   * entry point; these keep it from importing every rule module directly.
   */
  placeEquipment?: (ctx: GameContext, state: GameState, intent: PlaceEquipmentIntent) => { ok: boolean; reason?: string };
  playInitiativeCard?: (ctx: GameContext, state: GameState, player: PlayerId, cardId: string) => { ok: boolean; reason?: string };
  scoreEndOfTurningPoint?: (ctx: GameContext, state: GameState) => void;
  scoreEndOfBattle?: (ctx: GameContext, state: GameState) => void;
  /** Cached terrain index, invalidated when the map object or terrain state changes. */
  terrainCache?: { map: KillzoneMap; key: string; index: TerrainIndex };
}

export function makeContext(init: Partial<GameContext> & { rng: Rng }): GameContext {
  return {
    datacards: init.datacards ?? new Map(),
    maps: init.maps ?? new Map(),
    teams: init.teams ?? new Map(),
    ops: init.ops ?? new Map(),
    equipment: init.equipment ?? new Map(),
    hooks: init.hooks ?? new HookRegistry(),
    rng: init.rng,
  };
}

/** Terrain index for the current state, rebuilt whenever terrain state changes. */
export function terrain(ctx: GameContext, state: GameState): TerrainIndex {
  const key = `${state.map.id}|${state.map.features.length}|${JSON.stringify(state.terrainState)}|${state.placedFeatures.length}`;
  if (ctx.terrainCache?.key === key && ctx.terrainCache.map === state.map) return ctx.terrainCache.index;
  const index = buildTerrainIndex(state.map, state);
  ctx.terrainCache = { map: state.map, key, index };
  return index;
}

/**
 * Rebuild the hook registry for the current battle: core rules are registered by the
 * modules that own them, then killzone rules, then each player's team + equipment + ops.
 */
export function rebuildHooks(ctx: GameContext, state: GameState): void {
  const reg = new HookRegistry();
  for (const player of ['p1', 'p2'] as PlayerId[]) {
    const team = ctx.teams.get(state.teams[player].teamId);
    team?.register(reg, player);
    for (const eqId of state.teams[player].equipment) {
      ctx.equipment.get(eqId)?.register?.(reg, player);
    }
    const tacOp = state.teams[player].tacOpId ? ctx.ops.get(state.teams[player].tacOpId!) : undefined;
    tacOp?.register?.(reg, player);
    if (state.critOpId) ctx.ops.get(state.critOpId)?.register?.(reg, player);
  }
  ctx.hooks = reg;
}
