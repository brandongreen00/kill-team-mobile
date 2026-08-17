/** Scratch probe (not a test file): plays a few games and prints diagnostics. */
import { GreedyAgent, RandomLegalAgent } from '../../src/ai/baseline.ts';
import { TacticalAgent } from '../../src/ai/agent.ts';
import { playGame } from '../../src/ai/runner.ts';
import { AI_ROSTER, aiContext, arenaMap, closeQuartersMap, corridorMap, SCORING_OP_ID } from './fixtures.ts';

const maps = [arenaMap(), corridorMap(), closeQuartersMap()];
for (const map of maps) {
  for (const [name, mk] of [
    ['random', () => new RandomLegalAgent()],
    ['greedy', () => new GreedyAgent()],
    ['tactical', () => new TacticalAgent({ difficulty: 'elite' })],
  ] as const) {
    const ctx = aiContext(1);
    const t0 = Date.now();
    const r = playGame({
      ctx,
      map,
      seed: 7,
      critOpId: SCORING_OP_ID,
      rosters: { p1: AI_ROSTER, p2: AI_ROSTER },
      agents: { p1: mk(), p2: mk() },
    });
    console.log(
      `${map.id} ${name}: phase=${r.state.phase} tp=${r.turningPoints} vp=${r.vp.p1}:${r.vp.p2} ` +
        `alive=${r.survivors.p1}/${r.survivors.p2} intents=${r.intents} rejected=${r.rejected.length} ` +
        `err=${r.error ?? '-'} ${Date.now() - t0}ms`,
    );
    for (const rj of r.rejected.slice(0, 5)) console.log('   reject:', rj.reason, JSON.stringify(rj.intent).slice(0, 160));
  }
}
