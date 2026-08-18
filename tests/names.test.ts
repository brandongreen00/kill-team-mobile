/**
 * Operative display names — what panels, buttons and the battle log call an operative.
 *
 * The UI never asks the player to pick "C" from the alphabet: SelectRoster derives a
 * unique-within-team name for every operative from its datacard, keeping the letter as the
 * board-token glyph and as the suffix that separates duplicates.
 */
import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { makeCard, testContext, testMap } from './fixtures.ts';

describe('operative display names', () => {
  it('keeps distinct card names as they are, and letter-suffixes duplicates', () => {
    const ctx = testContext();
    let s = createBattle(ctx, { map: testMap(), seed: 1 });
    s = reduce(
      s,
      {
        t: 'SelectRoster',
        player: 'p1',
        teamId: 'test',
        operatives: [
          { datacardId: 'test.trooper' },
          { datacardId: 'test.trooper' },
          { datacardId: 'test.heavyGunner' },
        ],
      },
      ctx,
    ).state;
    expect(s.operatives['p1-0']!.name).toBe('TROOPER A');
    expect(s.operatives['p1-1']!.name).toBe('TROOPER B');
    expect(s.operatives['p1-2']!.name).toBe('HEAVY GUNNER');
    // The letters stay — they are what the board tokens draw.
    expect(s.operatives['p1-0']!.letter).toBe('A');
    expect(s.operatives['p1-2']!.letter).toBe('C');
  });

  it('strips leading words every card in the roster shares (usually the team name)', () => {
    const ctx = testContext();
    ctx.datacards.set('t.sgt', makeCard({ id: 't.sgt', name: 'Kasrkin Sergeant' }));
    ctx.datacards.set('t.trp', makeCard({ id: 't.trp', name: 'Kasrkin Trooper' }));
    let s = createBattle(ctx, { map: testMap(), seed: 1 });
    s = reduce(
      s,
      {
        t: 'SelectRoster',
        player: 'p1',
        teamId: 'test',
        operatives: [{ datacardId: 't.sgt' }, { datacardId: 't.trp' }, { datacardId: 't.trp' }],
      },
      ctx,
    ).state;
    expect(s.operatives['p1-0']!.name).toBe('Sergeant');
    expect(s.operatives['p1-1']!.name).toBe('Trooper B');
    expect(s.operatives['p1-2']!.name).toBe('Trooper C');
  });

  it('never strips a roster of identical single-card names down to nothing', () => {
    const ctx = testContext();
    ctx.datacards.set('t.w', makeCard({ id: 't.w', name: 'Space Marine Warrior' }));
    let s = createBattle(ctx, { map: testMap(), seed: 1 });
    s = reduce(
      s,
      { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: [{ datacardId: 't.w' }, { datacardId: 't.w' }] },
      ctx,
    ).state;
    expect(s.operatives['p1-0']!.name).toBe('Warrior A');
    expect(s.operatives['p1-1']!.name).toBe('Warrior B');
  });
});
