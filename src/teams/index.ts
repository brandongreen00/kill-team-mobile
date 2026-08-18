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
import { hierotekCircle } from './hierotek-circle/index.ts';
import { scoutSquad } from './scout-squad/index.ts';
import { murderwing } from './murderwing/index.ts';
import { phobosStrikeTeam } from './phobos-strike-team/index.ts';
import { deathwatch } from './deathwatch/index.ts';
import { wolfScouts } from './wolf-scouts/index.ts';
import { legionary } from './legionary/index.ts';
import { nemesisClaw } from './nemesis-claw/index.ts';
import { warpcoven } from './warpcoven/index.ts';

/** Phase 5 batch 1. */
export const BATCH_1: KtTeamModule[] = [
  kasrkin,
  angelOfDeath,
  plagueMarines,
  imperialNavyBreacher,
  celestianInsidiants,
  kommandos,
  pathfinders,
  hierotekCircle,
];

/** Phase 6 batch 2 — Astartes and Heretic Astartes. */
export const BATCH_2: KtTeamModule[] = [
  scoutSquad,
  murderwing,
  phobosStrikeTeam,
  deathwatch,
  wolfScouts,
  legionary,
  nemesisClaw,
  warpcoven,
];

/** Every implemented kill team, in batch order. */
export const ALL_TEAM_MODULES: KtTeamModule[] = [...BATCH_1, ...BATCH_2];

export const TEAM_MODULES: Map<string, KtTeamModule> = new Map(ALL_TEAM_MODULES.map((m) => [m.id, m]));

export function teamModule(id: string): KtTeamModule {
  const m = TEAM_MODULES.get(id);
  if (!m) throw new Error(`No team module '${id}' — implemented teams: ${[...TEAM_MODULES.keys()].join(', ')}`);
  return m;
}

export {
  kasrkin,
  angelOfDeath,
  plagueMarines,
  imperialNavyBreacher,
  celestianInsidiants,
  kommandos,
  pathfinders,
  hierotekCircle,
  scoutSquad,
  murderwing,
  phobosStrikeTeam,
  deathwatch,
  wolfScouts,
  legionary,
  nemesisClaw,
  warpcoven,
};
export type { KtTeamModule } from './helpers.ts';
export { defaultRoster, validateRosterFor, type RosterPickIn, type RosterValidation } from './selection.ts';
export { TEAM_DATA, teamData, type TeamData } from './data.ts';
