import { it } from 'vitest';
import { GreedyAgent, RandomLegalAgent } from '../../src/ai/baseline.ts';
import { TacticalAgent } from '../../src/ai/agent.ts';
import { playGame } from '../../src/ai/runner.ts';
import { AI_ROSTER, aiContext, arenaMap, SCORING_OP_ID } from './fixtures.ts';

const mk = {
  random: () => new RandomLegalAgent(),
  greedy: () => new GreedyAgent(),
  tactical: () => new TacticalAgent({ difficulty: 'veteran' }),
} as const;

const which = (process.env['PROBE'] ?? 'random') as keyof typeof mk;

it('probe', () => {
  const ctx = aiContext(1);
  const t0 = Date.now();
  const r = playGame({
    ctx,
    map: arenaMap(),
    seed: 7,
    critOpId: SCORING_OP_ID,
    rosters: { p1: AI_ROSTER, p2: AI_ROSTER },
    agents: { p1: mk[which](), p2: mk[which]() },
  });
  const shots = r.state.log.filter((l) => l.text.includes('shoots')).length;
  const fights = r.state.log.filter((l) => l.text.includes('fights')).length;
  console.log(
    `${which}: phase=${r.state.phase} tp=${r.turningPoints} vp=${r.vp.p1}:${r.vp.p2} alive=${r.survivors.p1}/${r.survivors.p2} ` +
      `shots=${shots} fights=${fights} intents=${r.intents} rejected=${r.rejected.length} err=${r.error ?? '-'} ${Date.now() - t0}ms`,
  );
  for (const rj of r.rejected.slice(0, 5)) console.log('  reject:', rj.reason, JSON.stringify(rj.intent).slice(0, 160));
}, 280000);
