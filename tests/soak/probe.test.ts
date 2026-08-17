import { it } from 'vitest';
import { GreedyAgent, RandomLegalAgent } from '../../src/ai/baseline.ts';
import { TacticalAgent } from '../../src/ai/agent.ts';
import { playGame } from '../../src/ai/runner.ts';
import { AI_ROSTER, aiContext, arenaMap, SCORING_OP_ID } from './fixtures.ts';
import type { Intent } from '../../src/core/intents.ts';

const mk = {
  random: () => new RandomLegalAgent(),
  greedy: () => new GreedyAgent(),
  tactical: () => new TacticalAgent({ difficulty: 'veteran' }),
  elite: () => new TacticalAgent({ difficulty: 'elite' }),
} as const;

const a = (process.env['P1'] ?? 'tactical') as keyof typeof mk;
const b = (process.env['P2'] ?? 'greedy') as keyof typeof mk;

it('probe', () => {
  let wins = { p1: 0, p2: 0, draw: 0 };
  const counts: Record<string, number> = {};
  let ms = 0;
  const games = Number(process.env['GAMES'] ?? 3);
  for (let g = 0; g < games; g++) {
    const ctx = aiContext(1);
    const t0 = Date.now();
    const r = playGame({
      ctx,
      map: arenaMap(),
      seed: 100 + g,
      critOpId: SCORING_OP_ID,
      rosters: { p1: AI_ROSTER, p2: AI_ROSTER },
      agents: { p1: mk[a](), p2: mk[b]() },
      onIntent: (i: Intent) => {
        if (i.t === 'PerformAction') counts[i.action] = (counts[i.action] ?? 0) + 1;
      },
    });
    ms += Date.now() - t0;
    if (r.winner === 'draw' || !r.winner) wins.draw++;
    else wins[r.winner]++;
    if (g === 0)
      console.log(
        `game0 ${a} vs ${b}: vp=${r.vp.p1}:${r.vp.p2} alive=${r.survivors.p1}/${r.survivors.p2} ` +
          `intents=${r.intents} rejected=${r.rejected.length} err=${r.error ?? '-'}`,
      );
  }
  console.log(`${a} vs ${b}: p1=${wins.p1} p2=${wins.p2} draw=${wins.draw} avg=${Math.round(ms / games)}ms/game`);
  console.log('actions:', JSON.stringify(counts));
}, 280000);
