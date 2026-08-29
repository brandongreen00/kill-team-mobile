/**
 * A battle built exactly the way the app builds one.
 *
 * `src/ui/App.tsx` loads the bundled map and team JSON, wires a context carrying every team
 * module and every datacard, and hands the resulting `GameState` to a `Store`. These tests
 * drive the AI opponent through that same `Store`, so what they pin is the app's channel —
 * `store.dispatch` → `reduce` — and not the private one `playGame` uses.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGameContext } from '../src/core/game.ts';
import { createBattle } from '../src/core/init.ts';
import { SeededRng } from '../src/core/rng.ts';
import type { KillzoneMap } from '../src/core/types.ts';
import { ALL_TEAM_MODULES } from '../src/teams/index.ts';
import type { TeamData } from '../src/ui/data.ts';
import { Store } from '../src/ui/store.ts';

const TEAMS_ROOT = join(process.cwd(), 'data/teams');
const MAPS_ROOT = join(process.cwd(), 'data/maps');

/** Every bundled kill team, in the order `loadTeams()` returns them. */
export function bundledTeams(): TeamData[] {
  const out: TeamData[] = [];
  for (const file of readdirSync(TEAMS_ROOT).sort()) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const data = JSON.parse(readFileSync(join(TEAMS_ROOT, file), 'utf8')) as TeamData;
    if (data?.id) out.push(data);
  }
  return out;
}

/** Every extracted killzone, sorted by id so a choice is deterministic. */
export function bundledMaps(): KillzoneMap[] {
  const out: KillzoneMap[] = [];
  for (const killzone of readdirSync(MAPS_ROOT).sort()) {
    let files: string[];
    try {
      files = readdirSync(join(MAPS_ROOT, killzone)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const map = JSON.parse(readFileSync(join(MAPS_ROOT, killzone, file), 'utf8')) as KillzoneMap;
      if (map?.id) out.push(map);
    }
  }
  return out;
}

export interface AppBattle {
  store: Store;
  teams: TeamData[];
  maps: KillzoneMap[];
}

export function appBattle(opts: { seed?: number; mapId?: string; critOpId?: string } = {}): AppBattle {
  const seed = opts.seed ?? 1;
  const teams = bundledTeams();
  const maps = bundledMaps();
  const ctx = createGameContext({
    rng: new SeededRng(seed),
    maps,
    datacards: teams.flatMap((t) => t.datacards ?? []),
    teams: ALL_TEAM_MODULES,
  });
  const map = (opts.mapId ? maps.find((m) => m.id === opts.mapId) : maps[0]) ?? maps[0];
  if (!map) throw new Error('no bundled maps');
  const state = createBattle(ctx, {
    map,
    seed,
    mode: 'match',
    critOpId: opts.critOpId ?? 'crit.secure',
  });
  return { store: new Store(state, ctx), teams, maps };
}
