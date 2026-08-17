/**
 * Data loading. Everything is bundled at build time — the app NEVER fetches Wahapedia
 * (scraping and map extraction are build-time tools).
 *
 * Team data is big: 48 kill teams is ~2.4 MB of JSON. The board never needs any of it, and
 * the roster builder needs exactly one team at a time, so it is fetched per team through
 * `import.meta.glob`'s lazy mode (one chunk per file). What the app loads up front is
 * `data/teams/_index.json` — id, name, faction and archetypes, enough to draw the team
 * picker — and `loadTeam` pulls the rest when a team is chosen.
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

/** A team as the picker knows it before its datacards are fetched. */
export interface TeamSummary {
  id: string;
  name: string;
  faction?: string;
  archetypes?: string[];
}

const teamPath = (id: string): string => `../../data/teams/${id}.json`;
const cache = new Map<string, TeamData>();

/** Every kill team's name/faction/archetypes — the picker's whole diet (~5 kB). */
export async function loadTeamIndex(): Promise<TeamSummary[]> {
  const mod = (await import('../../data/teams/_index.json')) as {
    default: { teams: TeamSummary[] };
  };
  return [...mod.default.teams].sort((a, b) => a.name.localeCompare(b.name));
}

/** One kill team's full JSON, fetched on demand and remembered. */
export async function loadTeam(id: string): Promise<TeamData | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const load = teamModules[teamPath(id)];
  if (!load) return null;
  const mod = (await load()) as { default: TeamData };
  if (!mod.default?.id) return null;
  cache.set(id, mod.default);
  return mod.default;
}

/** Every kill team's full JSON. Used by tests and tooling — not by the app's first paint. */
export async function loadTeams(): Promise<TeamData[]> {
  const out: TeamData[] = [];
  for (const path of Object.keys(teamModules).sort()) {
    if (path.includes('_rare-weapon-rules') || path.includes('_index')) continue;
    const mod = (await teamModules[path]!()) as { default: TeamData };
    if (mod.default?.id) {
      cache.set(mod.default.id, mod.default);
      out.push(mod.default);
    }
  }
  return out;
}
