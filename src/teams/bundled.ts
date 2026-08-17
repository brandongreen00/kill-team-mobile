/**
 * The kill teams whose `TeamModule` is implemented, with their JSON bundled eagerly.
 *
 * A team module quotes its printed rule text straight out of `data/teams/<slug>.json`, so
 * those files have to be in the same chunk as the modules — but ONLY those files, and only on
 * the code path that actually plays a game. Keeping them here (rather than in `data.ts`,
 * which every roster-builder screen imports for its types and helpers) is what keeps the 48
 * teams' data out of the first paint: `src/ui/App.tsx` reaches `src/teams/index.ts` through a
 * dynamic import, so this module and its JSON are a lazily-fetched chunk.
 */
import kasrkinJson from '../../data/teams/kasrkin.json';
import angelOfDeathJson from '../../data/teams/angel-of-death.json';
import plagueMarinesJson from '../../data/teams/plague-marines.json';
import imperialNavyBreacherJson from '../../data/teams/imperial-navy-breacher.json';
import celestianInsidiantsJson from '../../data/teams/celestian-insidiants.json';
import kommandosJson from '../../data/teams/kommandos.json';
import pathfindersJson from '../../data/teams/pathfinders.json';
import hierotekCircleJson from '../../data/teams/hierotek-circle.json';
import { normaliseTeam, type TeamData } from './data.ts';
import type { Datacard } from '../core/types.ts';

export const TEAM_DATA: Record<string, TeamData> = {
  kasrkin: normaliseTeam(kasrkinJson),
  'angel-of-death': normaliseTeam(angelOfDeathJson),
  'plague-marines': normaliseTeam(plagueMarinesJson),
  'imperial-navy-breacher': normaliseTeam(imperialNavyBreacherJson),
  'celestian-insidiants': normaliseTeam(celestianInsidiantsJson),
  kommandos: normaliseTeam(kommandosJson),
  pathfinders: normaliseTeam(pathfindersJson),
  'hierotek-circle': normaliseTeam(hierotekCircleJson),
};

export function teamData(id: string): TeamData {
  const d = TEAM_DATA[id];
  if (!d) throw new Error(`Unknown kill team '${id}' — add data/teams/${id}.json to src/teams/bundled.ts`);
  return d;
}

export function teamDatacards(id: string): Datacard[] {
  return teamData(id).datacards;
}
