/**
 * Bot-vs-bot soak for every implemented kill team.
 *
 * Each team plays a full four-turning-point game against the next team in its batch's ring on
 * TWO real Approved Ops maps, driven by the shared `RandomLegalAgent`/`GreedyAgent` from
 * `src/ai`. The bar (CLAUDE.md §Architecture 1): **zero rejected intents and no exceptions**.
 *
 * Batches ring separately so a batch's teams are soaked against the faction patterns they
 * share, and so a new batch's failures are never masked by an older batch's pairing.
 */
import { describe, expect, it } from 'vitest';
import { GreedyAgent, RandomLegalAgent, clearDeployCache, clearMoveCache, playGame } from '../../src/ai/index.ts';
import { BATCH_1, BATCH_2, BATCH_3, BATCH_4 } from '../../src/teams/index.ts';
import { defaultRoster } from '../../src/teams/selection.ts';
import type { KtTeamModule } from '../../src/teams/helpers.ts';
import { mapById, realMaps, teamContext } from './harness.ts';

/** Two maps from different killzones, so both the open and the Close Quarters rules run. */
const MAPS = (): string[] => {
  const all = realMaps();
  const volkus = all.find((m) => m.killzone === 'volkus');
  const gallowdark = all.find((m) => m.killzone === 'gallowdark');
  const fallback = all.slice(0, 2);
  return [volkus?.id ?? fallback[0]!.id, gallowdark?.id ?? fallback[1]!.id];
};

function soak(mine: KtTeamModule, foe: KtTeamModule, mapId: string, seed: number): void {
  // The AI's deployment/move caches are module-level; a game must not inherit another's.
  clearDeployCache();
  clearMoveCache();
  const ctx = teamContext([mine, foe], { seed });
  const map = mapById(mapId);
  ctx.maps.set(map.id, map);
  const result = playGame({
    ctx,
    map,
    seed,
    rosters: {
      p1: {
        teamId: mine.id,
        operatives: defaultRoster(mine.data).map((p) => ({ datacardId: p.datacardId })),
        equipment: mine.equipment.slice(0, 2).map((e) => e.id),
      },
      p2: {
        teamId: foe.id,
        operatives: defaultRoster(foe.data).map((p) => ({ datacardId: p.datacardId })),
        equipment: foe.equipment.slice(0, 2).map((e) => e.id),
      },
    },
    agents: { p1: new GreedyAgent(), p2: new RandomLegalAgent() },
    maxIntents: 4000,
  });
  expect(result.rejected).toEqual([]);
  expect(result.error).toBeUndefined();
  expect(result.state.phase).toBe('battleEnd');
}

const BATCHES: { name: string; modules: KtTeamModule[]; seedBase: number }[] = [
  { name: 'batch-1', modules: BATCH_1, seedBase: 1000 },
  { name: 'batch-2', modules: BATCH_2, seedBase: 2000 },
  { name: 'batch-3', modules: BATCH_3, seedBase: 3000 },
  { name: 'batch-4', modules: BATCH_4, seedBase: 4000 },
];

for (const batch of BATCHES) {
  describe(`${batch.name} kill teams: bot-vs-bot soak (zero rejected intents)`, () => {
    const maps = MAPS();
    for (let i = 0; i < batch.modules.length; i++) {
      const mine = batch.modules[i]!;
      const foe = batch.modules[(i + 1) % batch.modules.length]!;
      for (const [n, mapId] of maps.entries()) {
        it(`${mine.id} vs ${foe.id} on ${mapId}`, () => {
          soak(mine, foe, mapId, batch.seedBase + i * 10 + n);
        });
      }
    }
  });
}
