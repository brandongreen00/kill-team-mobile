import { it } from 'vitest';
import { GreedyAgent, RandomLegalAgent } from '../../src/ai/baseline.ts';
import { TacticalAgent } from '../../src/ai/agent.ts';
import { playGame } from '../../src/ai/runner.ts';
import { AI_ROSTER, aiContext, arenaMap, corridorMap, SCORING_OP_ID } from './fixtures.ts';
import type { Agent } from '../../src/ai/types.ts';
import type { PlayerId } from '../../src/core/types.ts';

const mk: Record<string, () => Agent> = {
  random: () => new RandomLegalAgent(),
  greedy: () => new GreedyAgent(),
  tactical: () => new TacticalAgent({ difficulty: 'veteran' }),
  elite: () => new TacticalAgent({ difficulty: 'elite' }),
  recruit: () => new TacticalAgent({ difficulty: 'recruit' }),
};

const hero = process.env['HERO'] ?? 'tactical';
const foe = process.env['FOE'] ?? 'greedy';
const games = Number(process.env['GAMES'] ?? 20);

it('probe', () => {
  let win = 0;
  let loss = 0;
  let draw = 0;
  let ms = 0;
  let vpFor = 0;
  let vpAgainst = 0;
  const maps = [arenaMap(), corridorMap()];
  for (let g = 0; g < games; g++) {
    const heroSide: PlayerId = g % 2 === 0 ? 'p1' : 'p2';
    const foeSide: PlayerId = heroSide === 'p1' ? 'p2' : 'p1';
    const ctx = aiContext(1);
    const agents = { [heroSide]: mk[hero]!(), [foeSide]: mk[foe]!() } as Record<PlayerId, Agent>;
    const t0 = Date.now();
    const r = playGame({
      ctx,
      map: maps[g % maps.length]!,
      seed: 1000 + g,
      critOpId: SCORING_OP_ID,
      rosters: { p1: AI_ROSTER, p2: AI_ROSTER },
      agents,
    });
    ms += Date.now() - t0;
    vpFor += r.vp[heroSide];
    vpAgainst += r.vp[foeSide];
    if (r.error || r.rejected.length > 0) console.log(`game ${g}: err=${r.error} rejected=${r.rejected.length}`);
    if (process.env['DEBUG'])
      console.log(`g${g} map=${r.state.map.id} vp=${r.vp[heroSide]}:${r.vp[foeSide]} alive=${r.survivors[heroSide]}/${r.survivors[foeSide]} w=${r.winner}`);
    if (r.winner === heroSide) win++;
    else if (r.winner === foeSide) loss++;
    else draw++;
  }
  console.log(
    `${hero} vs ${foe}: ${win}W ${draw}D ${loss}L over ${games} — win rate ${((100 * win) / games).toFixed(0)}% ` +
      `(score rate ${((100 * (win + 0.5 * draw)) / games).toFixed(0)}%), avg VP ${(vpFor / games).toFixed(1)}:${(vpAgainst / games).toFixed(1)}, ` +
      `${Math.round(ms / games)}ms/game`,
  );
}, 280000);
