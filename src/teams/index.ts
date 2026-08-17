/**
 * The kill-team modules. Each is a `TeamModule` that registers its faction rules, ploys,
 * equipment, unique actions and abilities as hooks (`src/core/hooks.ts`), plus a pure
 * `validateRoster` driven by the printed selection requirements.
 */
import type { KtTeamModule } from './helpers.ts';
import { kasrkin } from './kasrkin/index.ts';
import { angelOfDeath } from './angel-of-death/index.ts';
import { plagueMarines } from './plague-marines/index.ts';
import { imperialNavyBreacher } from './imperial-navy-breacher/index.ts';
import { celestianInsidiants } from './celestian-insidiants/index.ts';
import { kommandos } from './kommandos/index.ts';
import { pathfinders } from './pathfinders/index.ts';

/** Phase 5 batch 1. */
export const BATCH_1: KtTeamModule[] = [
  kasrkin,
  angelOfDeath,
  plagueMarines,
  imperialNavyBreacher,
  celestianInsidiants,
  kommandos,
  pathfinders,
];

export const TEAM_MODULES: Map<string, KtTeamModule> = new Map(BATCH_1.map((m) => [m.id, m]));

export function teamModule(id: string): KtTeamModule {
  const m = TEAM_MODULES.get(id);
  if (!m) throw new Error(`No team module '${id}' — implemented teams: ${[...TEAM_MODULES.keys()].join(', ')}`);
  return m;
}

export { kasrkin, angelOfDeath, plagueMarines, imperialNavyBreacher, celestianInsidiants, kommandos, pathfinders };
export type { KtTeamModule } from './helpers.ts';
export { defaultRoster, validateRosterFor, type RosterPickIn, type RosterValidation } from './selection.ts';
export { TEAM_DATA, teamData, type TeamData } from './data.ts';
