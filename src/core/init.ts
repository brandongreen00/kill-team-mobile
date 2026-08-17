/** Battle construction: a fresh GameState for a map + crit op + seed. */
import type { GameContext } from './context.ts';
import { rebuildHooks } from './context.ts';
import { MAX_TURNING_POINTS } from './phases.ts';
import type { GameState, KillzoneMap, MarkerState, PlayerId, TeamState } from './types.ts';

function emptyTeam(): TeamState {
  return {
    teamId: '',
    operativeIds: [],
    cp: 0,
    vp: 0,
    equipment: [],
    archetypes: [],
    vpByOp: {},
    ploysUsedTP: [],
    gambitsUsedTP: [],
    initiativeCards: [],
    equipmentUses: {},
    startingSize: 0,
    killGrade: 0,
    passedGambit: false,
  };
}

export interface NewBattleOptions {
  map: KillzoneMap;
  critOpId?: string;
  seed: number;
  mode?: 'match' | 'sandbox';
  maxTurningPoints?: number;
}

export function createBattle(ctx: GameContext, opts: NewBattleOptions): GameState {
  const markers: Record<string, MarkerState> = {};
  for (const obj of opts.map.objectives) {
    markers[obj.id] = {
      id: obj.id,
      kind: 'objective',
      diameterMm: 40, // core rules › Markers: "Objective markers are 40mm in diameter."
      pos: { ...obj.pos },
      z: obj.z,
      flags: {},
    };
  }
  const state: GameState = {
    mode: opts.mode ?? 'match',
    seed: opts.seed,
    rngCursor: 0,
    map: opts.map,
    missionPack: 'approved-ops-2025',
    ...(opts.critOpId ? { critOpId: opts.critOpId } : {}),
    turningPoint: 0,
    maxTurningPoints: opts.maxTurningPoints ?? MAX_TURNING_POINTS,
    phase: 'setup',
    setup: {
      step: 'rollOff',
      dropZone: {},
      revealed: {},
      deployedCount: {},
      equipmentPlaced: {},
    },
    teams: { p1: emptyTeam(), p2: emptyTeam() },
    operatives: {},
    markers,
    effects: [],
    terrainState: {},
    placedFeatures: [],
    sequence: null,
    pending: [],
    log: [],
    rolls: [],
    rejected: [],
    seq: 1,
    opState: {},
    activationsThisTP: 0,
  };
  // Each player gains 2CP at Select Operatives (Appendix › GAME SEQUENCE step 2).
  state.teams.p1.cp = 2;
  state.teams.p2.cp = 2;
  rebuildHooks(ctx, state);
  return state;
}

export const PLAYERS: PlayerId[] = ['p1', 'p2'];
