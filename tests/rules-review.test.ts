/**
 * Rules-review regressions (2026-08-23).
 *
 * Each test quotes the rule it pins and fails against the code as it stood before this
 * review. They are grouped by the sequence they belong to rather than by the file that was
 * wrong, because several of these were one defect showing up in two places.
 */
import { describe, expect, it } from 'vitest';
import { createGameContext } from '../src/core/game.ts';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { ScriptedRng } from '../src/core/rng.ts';
import { parseWeaponRules } from '../src/core/weaponRules.ts';
import { makeCard, testMap } from './fixtures.ts';
import type { GameContext } from '../src/core/context.ts';
import type { Datacard, GameState } from '../src/core/types.ts';

/** A two-a-side battle on the open test killzone, with the cards the test needs. */
function battle(cards: Datacard[], script: number[], p1Card: string, p2Card: string): { s: GameState; ctx: GameContext } {
  const ctx = createGameContext({ rng: new ScriptedRng(script), maps: [testMap()], datacards: cards });
  let s = createBattle(ctx, { map: testMap(), seed: 7, critOpId: undefined });
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: [{ datacardId: p1Card }] }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: [{ datacardId: p2Card }] }, ctx).state;
  s.setup.dropZone = { p1: 'p1', p2: 'p2' };
  s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: s.teams.p1.operativeIds[0]!, pos: { x: 3, y: 11 } }, ctx).state;
  s = reduce(s, { t: 'DeployOperative', player: 'p2', operativeId: s.teams.p2.operativeIds[0]!, pos: { x: 27, y: 11 } }, ctx).state;
  s = reduce(s, { t: 'FinishSetup' }, ctx).state;
  // Into line of sight and range, past the drop zones the setup step insists on.
  s.operatives[s.teams.p1.operativeIds[0]!]!.pos = { x: 10, y: 11 };
  s.operatives[s.teams.p2.operativeIds[0]!]!.pos = { x: 16, y: 11 };
  s.initiative = 'p1';
  s.phase = 'firefight';
  s.activePlayer = 'p1';
  for (const op of Object.values(s.operatives)) op.ready = true;
  return { s, ctx };
}

/** Answer decisions with a caller-supplied policy; falls back to the first enabled option. */
function drain(
  s0: GameState,
  ctx: GameContext,
  pick: (kind: string, options: { id: string; label: string; disabled?: boolean }[]) => string | undefined,
  limit = 40,
): GameState {
  let s = s0;
  let guard = 0;
  while (s.pending.length > 0 && guard++ < limit) {
    const d = s.pending[0]!;
    const chosen = pick(d.kind, d.options) ?? d.options.find((o) => !o.disabled)?.id ?? 'keep';
    const opt = d.options.find((o) => o.id === chosen);
    s = reduce(
      s,
      { t: 'ResolveDecision', decisionId: d.id, optionId: chosen, ...(opt?.data ? { data: opt.data } : {}) },
      ctx,
    ).state;
  }
  return s;
}

describe('re-rolling a dice keeps the weapon that rolled it', () => {
  it('Lethal x+: "your successes equal to or greater than x are critical successes" — a RE-ROLLED result is graded the same way', () => {
    const shooter = makeCard({
      id: 'test.lethal',
      name: 'LETHAL SHOOTER',
      weapons: [
        {
          name: 'reaper',
          profiles: [
            {
              type: 'ranged',
              atk: 2,
              hit: 4,
              dmgN: 1,
              dmgC: 6,
              rules: parseWeaponRules('Lethal 5+, Relentless'),
            },
          ],
        },
      ],
    });
    const dummy = makeCard({ id: 'test.dummy', name: 'DUMMY' });
    // Attack 2,2 (both fail) -> Relentless re-rolls both -> 5,5. Lethal 5+ makes those two
    // CRITICAL successes, 6 damage each. Defence 1,1,1 blocks nothing.
    const { s, ctx } = battle([shooter, dummy], [2, 2, 5, 5, 1, 1, 1, 1, 1, 1], 'test.lethal', 'test.dummy');
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    let st = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    st = reduce(
      st,
      { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'reaper', targetId: b } },
      ctx,
    ).state;
    // Take the Relentless re-roll of both fails; decline every other offer, including the
    // Command Re-roll that would otherwise spend a good dice.
    let taken = false;
    st = drain(st, ctx, (kind, options) => {
      if (kind !== 'reroll') return undefined;
      const all = options.find((o) => o.id === 'allFails');
      if (all && !taken) {
        taken = true;
        return all.id;
      }
      return 'keep';
    });
    const target = st.operatives[b]!;
    // Two critical successes at 6 damage each. Graded as normal successes it would be 2.
    expect(10 - target.wounds).toBe(12);
    expect(st.rejected).toHaveLength(0);
  });
});

describe('Devastating x fires on retained CRITICAL successes only', () => {
  it('"each retained critical success immediately inflicts x damage" — a blocked NORMAL success is not a critical success', () => {
    const shooter = makeCard({
      id: 'test.dev',
      name: 'DEVASTATOR',
      weapons: [
        {
          name: 'shredder',
          profiles: [
            { type: 'ranged', atk: 2, hit: 4, dmgN: 1, dmgC: 1, rules: parseWeaponRules('Devastating 2') },
          ],
        },
      ],
    });
    const dummy = makeCard({ id: 'test.dummy', name: 'DUMMY' });
    // Attack 4,4 -> two NORMAL successes, zero crits. Defence 4,4,4 vs Save 4+ -> two blocks,
    // which stop both normals. Devastating has no retained critical success to fire on, so
    // the target takes nothing at all.
    const { s, ctx } = battle([shooter, dummy], [4, 4, 4, 4, 4, 6, 6, 6, 6], 'test.dev', 'test.dummy');
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    let st = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    st = reduce(
      st,
      { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'shredder', targetId: b } },
      ctx,
    ).state;
    st = drain(st, ctx, (kind) => (kind === 'reroll' ? 'keep' : undefined));
    expect(10 - st.operatives[b]!.wounds).toBe(0);
    expect(st.rejected).toHaveLength(0);
  });
});

describe('a retaliating operative fights with a melee weapon', () => {
  it('"both players select one melee weapon to use that their operative has" — not the first profile on the card', () => {
    // 15 weapons across 12 kill teams (the Aeonstave, the Triskele, the Brazier of holy fire,
    // …) list their ranged profile first. `findProfile(w, undefined)` returns profiles[0], so
    // the defender retaliated in melee with a RANGED stat line and ranged weapon rules.
    const twoProfile = makeCard({
      id: 'test.stave',
      name: 'STAVE BEARER',
      weapons: [
        {
          name: 'aeonstave',
          profiles: [
            { type: 'ranged', name: 'blast', atk: 5, hit: 3, dmgN: 3, dmgC: 3, rules: parseWeaponRules('Range 8"') },
            { type: 'melee', name: 'strike', atk: 2, hit: 5, dmgN: 4, dmgC: 5, rules: [] },
          ],
        },
      ],
    });
    const attacker = makeCard({ id: 'test.brawler', name: 'BRAWLER' });
    const { s, ctx } = battle([attacker, twoProfile], [4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 'test.brawler', 'test.stave');
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    // Base to base, so the Fight is legal.
    s.operatives[a]!.pos = { x: 12, y: 11 };
    s.operatives[b]!.pos = { x: 13.3, y: 11 };
    let st = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    st = reduce(
      st,
      { t: 'PerformAction', operativeId: a, action: 'Fight', params: { weaponName: 'fists', targetId: b } },
      ctx,
    ).state;
    const seq = st.sequence;
    expect(seq?.kind).toBe('fight');
    // The melee profile's Atk is 2; the ranged profile's is 5.
    expect(seq && seq.kind === 'fight' ? seq.defenderPool.dice.length : -1).toBe(2);
  });
});
