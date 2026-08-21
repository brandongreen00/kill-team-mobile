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
import { deathKorps } from './death-korps/index.ts';
import { exactionSquad } from './exaction-squad/index.ts';
import { novitiates } from './novitiates/index.ts';
import { sanctifiers } from './sanctifiers/index.ts';
import { ratlings } from './ratlings/index.ts';
import { inquisitorialAgent } from './inquisitorial-agent/index.ts';
import { elucidianStarstrider } from './elucidian-starstrider/index.ts';
import { spectreSquad } from './spectre-squad/index.ts';
import { bladesOfKhaine } from './blades-of-khaine/index.ts';
import { corsairVoidscarred } from './corsair-voidscarred/index.ts';
import { voidDancerTroupe } from './void-dancer-troupe/index.ts';
import { exoditeDragonMasters } from './exodite-dragon-masters/index.ts';
import { handOfTheArchon } from './hand-of-the-archon/index.ts';
import { mandrakes } from './mandrakes/index.ts';
import { hearthkynSalvager } from './hearthkyn-salvager/index.ts';
import { hernkynYaegir } from './hernkyn-yaegir/index.ts';
import { canoptekCircle } from './canoptek-circle/index.ts';
import { raveners } from './raveners/index.ts';
import { wyrmblade } from './wyrmblade/index.ts';
import { broodBrother } from './brood-brother/index.ts';
import { vespidStingwings } from './vespid-stingwings/index.ts';
import { xv26StealthBattlesuits } from './xv26-stealth-battlesuits/index.ts';
import { wreckaKrew } from './wrecka-krew/index.ts';
import { farstalkerKinband } from './farstalker-kinband/index.ts';

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

/** Phase 6 batch 3 — Imperium, non-Astartes. */
export const BATCH_3: KtTeamModule[] = [
  deathKorps,
  exactionSquad,
  novitiates,
  sanctifiers,
  ratlings,
  inquisitorialAgent,
  elucidianStarstrider,
  spectreSquad,
];

/** Phase 6 batch 4 — Aeldari, Drukhari, Leagues of Votann. */
export const BATCH_4: KtTeamModule[] = [
  bladesOfKhaine,
  corsairVoidscarred,
  voidDancerTroupe,
  exoditeDragonMasters,
  handOfTheArchon,
  mandrakes,
  hearthkynSalvager,
  hernkynYaegir,
];

/** Phase 6 batch 5 — Necron, Tyranid, T'au, Ork. */
export const BATCH_5: KtTeamModule[] = [
  canoptekCircle,
  raveners,
  wyrmblade,
  broodBrother,
  vespidStingwings,
  xv26StealthBattlesuits,
  wreckaKrew,
  farstalkerKinband,
];

/** Every implemented kill team, in batch order. */
export const ALL_TEAM_MODULES: KtTeamModule[] = [
  ...BATCH_1,
  ...BATCH_2,
  ...BATCH_3,
  ...BATCH_4,
  ...BATCH_5,
];

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
  deathKorps,
  exactionSquad,
  novitiates,
  sanctifiers,
  ratlings,
  inquisitorialAgent,
  elucidianStarstrider,
  spectreSquad,
  bladesOfKhaine,
  corsairVoidscarred,
  voidDancerTroupe,
  exoditeDragonMasters,
  handOfTheArchon,
  mandrakes,
  hearthkynSalvager,
  hernkynYaegir,
  canoptekCircle,
  raveners,
  wyrmblade,
  broodBrother,
  vespidStingwings,
  xv26StealthBattlesuits,
  wreckaKrew,
  farstalkerKinband,
};
export type { KtTeamModule } from './helpers.ts';
export { defaultRoster, validateRosterFor, type RosterPickIn, type RosterValidation } from './selection.ts';
export { TEAM_DATA, teamData, type TeamData } from './data.ts';
