/**
 * Data loading. Everything is bundled at build time — the app NEVER fetches Wahapedia
 * (scraping and map extraction are build-time tools).
 */
import type { Datacard, KillzoneMap } from '../core/types.ts';

const mapModules = import.meta.glob('../../data/maps/**/*.json', { eager: false });
const teamModules = import.meta.glob('../../data/teams/*.json', { eager: false });

export async function loadMaps(): Promise<KillzoneMap[]> {
  const out: KillzoneMap[] = [];
  for (const path of Object.keys(mapModules).sort()) {
    const mod = (await mapModules[path]!()) as { default: KillzoneMap };
    if (mod.default?.id) out.push(mod.default);
  }
  return out;
}

export interface TeamData {
  id: string;
  name: string;
  faction?: string;
  archetypes?: string[];
  datacards: Datacard[];
  selection?: unknown;
  factionRules?: { id: string; name: string; text: string }[];
  strategyPloys?: { id: string; name: string; cp: number; text: string }[];
  firefightPloys?: { id: string; name: string; cp: number; text: string }[];
  equipment?: { id: string; name: string; text: string }[];
}

/**
 * The crit op a new battle starts with.
 *
 * Approved Ops picks one per mission; there is no mission-select screen yet, and with
 * `state.critOpId` unset every crit-op action is gated off and a THIRD of the game's scoring
 * is dead — so a battle starts with one rather than with none. `docs/PROGRESS.md` tracks the
 * picker as the fix.
 */
export const defaultCritOpId = (): string => 'crit.secure';

export async function loadTeams(): Promise<TeamData[]> {
  const out: TeamData[] = [];
  for (const path of Object.keys(teamModules).sort()) {
    if (path.includes('_rare-weapon-rules')) continue;
    const mod = (await teamModules[path]!()) as { default: TeamData };
    if (mod.default?.id) out.push(mod.default);
  }
  return out;
}
