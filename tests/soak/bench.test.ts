import { it } from 'vitest';
import { reachableCells } from '../../src/core/movement.ts';
import { createBattle } from '../../src/core/init.ts';
import { reduce } from '../../src/core/reducer.ts';
import { aiContext, arenaMap, AI_ROSTER } from './fixtures.ts';

it('bench', () => {
  const ctx = aiContext(1);
  let s = createBattle(ctx, { map: arenaMap(), seed: 1 });
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'ai.test', operatives: AI_ROSTER.operatives }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'ai.test', operatives: AI_ROSTER.operatives }, ctx).state;
  s.setup.dropZone = { p1: 'p1', p2: 'p2' };
  const id = s.teams.p1.operativeIds[0]!;
  s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: id, pos: { x: 3, y: 11 } }, ctx).state;
  const op = s.operatives[id]!;
  let t0 = Date.now();
  const f = reachableCells(ctx, s, op, 6);
  console.log('reachableCells 6in:', Date.now() - t0, 'ms, cells', f.size);
  t0 = Date.now();
  for (let i = 0; i < 5; i++) reachableCells(ctx, s, op, 6);
  console.log('x5:', Date.now() - t0, 'ms');
  t0 = Date.now();
  for (let i = 0; i < 200; i++) reduce(s, { t: 'AdvancePhase' }, ctx);
  console.log('200 reduce:', Date.now() - t0, 'ms');
}, 200000);
