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
import { validateMove } from '../src/core/movement.ts';
import { inControlRange } from '../src/core/state.ts';
import { ScriptedRng } from '../src/core/rng.ts';
import { parseWeaponRules } from '../src/core/weaponRules.ts';
import { addRolled, retentionOptions, type DicePool } from '../src/core/dice.ts';
import { makeCard, rect, testMap } from './fixtures.ts';
import { buildTerrainIndex } from '../src/core/terrain.ts';
import { coverAndObscured, withinControlRange } from '../src/core/visibility.ts';
import { checkTarget } from '../src/core/sequences/shoot.ts';
import type { GameContext } from '../src/core/context.ts';
import type { Datacard, GameState, PendingDecision, TerrainFeature } from '../src/core/types.ts';

/** A battle on the open test killzone, with the cards and rosters the test needs. */
function battle(
  cards: Datacard[],
  script: number[],
  p1Cards: string | string[],
  p2Cards: string | string[],
): { s: GameState; ctx: GameContext } {
  const p1 = (Array.isArray(p1Cards) ? p1Cards : [p1Cards]).map((datacardId) => ({ datacardId }));
  const p2 = (Array.isArray(p2Cards) ? p2Cards : [p2Cards]).map((datacardId) => ({ datacardId }));
  const ctx = createGameContext({ rng: new ScriptedRng(script), maps: [testMap()], datacards: cards });
  let s = createBattle(ctx, { map: testMap(), seed: 7, critOpId: undefined });
  s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: p1 }, ctx).state;
  s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: p2 }, ctx).state;
  s.setup.dropZone = { p1: 'p1', p2: 'p2' };
  s.teams.p1.operativeIds.forEach((id, i) => {
    s = reduce(s, { t: 'DeployOperative', player: 'p1', operativeId: id, pos: { x: 3, y: 5 + i * 4 } }, ctx).state;
  });
  s.teams.p2.operativeIds.forEach((id, i) => {
    s = reduce(s, { t: 'DeployOperative', player: 'p2', operativeId: id, pos: { x: 27, y: 5 + i * 4 } }, ctx).state;
  });
  s = reduce(s, { t: 'FinishSetup' }, ctx).state;
  // Into line of sight and range, past the drop zones the setup step insists on.
  s.teams.p1.operativeIds.forEach((id, i) => {
    s.operatives[id]!.pos = { x: 10, y: 5 + i * 4 };
  });
  s.teams.p2.operativeIds.forEach((id, i) => {
    s.operatives[id]!.pos = { x: 16, y: 5 + i * 4 };
  });
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
  pick: (d: PendingDecision) => string | undefined,
  limit = 40,
): GameState {
  let s = s0;
  let guard = 0;
  while (s.pending.length > 0 && guard++ < limit) {
    const d = s.pending[0]!;
    const chosen = pick(d) ?? d.options.find((o) => !o.disabled)?.id ?? 'keep';
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
    st = drain(st, ctx, (d) => {
      if (d.kind !== 'reroll') return undefined;
      const all = d.options.find((o) => o.id === 'allFails');
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
    st = drain(st, ctx, (d) => (d.kind === 'reroll' ? 'keep' : undefined));
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

describe('Command Re-roll is exempt from the once-per-turning-point ploy cap', () => {
  it('"other than Command Re-roll, each player cannot use each ploy more than once per turning point"', () => {
    const dummy = makeCard({ id: 'test.dummy', name: 'DUMMY' });
    const { s, ctx } = battle(
      [dummy],
      Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 2 : 5)),
      ['test.dummy', 'test.dummy'],
      ['test.dummy', 'test.dummy'],
    );
    s.teams.p1.cp = 5;
    const [a1, a2] = s.teams.p1.operativeIds as [string, string];
    const [b1, b2] = s.teams.p2.operativeIds as [string, string];

    const shoot = (st: GameState, shooterId: string, targetId: string, useCommandReroll: boolean) => {
      let next = reduce(st, { t: 'ActivateOperative', player: 'p1', operativeId: shooterId, order: 'engage' }, ctx).state;
      next = reduce(
        next,
        { t: 'PerformAction', operativeId: shooterId, action: 'Shoot', params: { weaponName: 'lasgun', targetId } },
        ctx,
      ).state;
      let offered = false;
      let used = false;
      next = drain(next, ctx, (d) => {
        if (d.kind !== 'reroll') return undefined;
        // The ploy IS the decision: its prompt is the grant's label, and its options are the
        // dice you would re-roll with it.
        const isCommandReroll = /Command Re-roll/i.test(d.prompt);
        if (!isCommandReroll) return 'keep';
        offered = true;
        if (!useCommandReroll || used) return 'keep';
        used = true;
        return d.options.find((o) => o.id !== 'keep')?.id ?? 'keep';
      });
      next = reduce(next, { t: 'EndActivation', operativeId: shooterId }, ctx).state;
      return { st: next, offered };
    };

    let st = s;
    const first = shoot(st, a1, b1, true);
    st = first.st;
    expect(first.offered).toBe(true);
    const cpAfter = st.teams.p1.cp;
    expect(cpAfter).toBeLessThan(5);
    // The ploy must NOT have been recorded against the once-per-turning-point list.
    expect(st.teams.p1.ploysUsedTP.filter((p) => p.startsWith('commandReroll'))).toEqual([]);

    // A second operative, same turning point: the ploy is offered again.
    st.activePlayer = 'p1';
    const second = shoot(st, a2, b2, false);
    expect(second.offered).toBe(true);
  });
});

describe('control range is not drawn through a solid floor', () => {
  const roof = (kind: string): TerrainFeature => ({
    id: 'bld',
    kind,
    label: 'BLD',
    placement: { x: 12, y: 11, rotDeg: 0, flip: false },
    parts: [
      {
        id: 'bld.floor',
        featureId: 'bld',
        poly: rect(9, 8, 6, 6),
        // As every extracted upper level is: a plane, so z1 - z0 is ZERO, not its height.
        z0: 3,
        z1: 3,
        types: ['Ceiling', 'Vantage', 'Light'],
        role: 'floor',
        standable: true,
        solid: false,
      },
    ],
  });

  const bodies = () => {
    const above = { id: 'a', pos: { x: 12, y: 11 }, z: 3, base: { shape: 'round' as const, mm: 32 }, rot: 0, height: 1.6 };
    const below = { id: 'b', pos: { x: 12, y: 11.5 }, z: 0, base: { shape: 'round' as const, mm: 32 }, rot: 0, height: 1.6 };
    return { above, below };
  };

  it('"something is within an operative\'s control range if it\'s visible to and within 1\"" — an upper level in the way is not see-through', () => {
    // The old test dropped every part thinner than 2" from control-range visibility. z1 - z0
    // is the part's THICKNESS, and every extracted floor is a zero-thickness plane, so all of
    // them were ignored — on every killzone, not just where the rule is printed.
    const index = buildTerrainIndex(testMap({ features: [roof('test.building')] }));
    const { above, below } = bodies();
    expect(withinControlRange(index, above, below)).toBe(false);
  });

  it('Killzones § Stronghold: "for the purposes of control range, ignore the door and parts of this terrain feature less than 2\" high"', () => {
    // The exemption is real, but it is printed for the Volkus strongholds and it is about
    // HEIGHT above the killzone floor, not the thickness of a part.
    const low: TerrainFeature = {
      id: 'sh',
      kind: 'volkus.strongholdA',
      label: 'A',
      placement: { x: 12, y: 11, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'sh.step',
          featureId: 'sh',
          poly: rect(11.5, 8, 1, 6),
          z0: 0,
          z1: 1.5, // under 2" high: ignored for control range
          types: ['Heavy'],
          role: 'wall',
        },
      ],
    };
    const index = buildTerrainIndex(testMap({ features: [low] }));
    const a = { id: 'a', pos: { x: 11, y: 11 }, z: 0, base: { shape: 'round' as const, mm: 32 }, rot: 0, height: 1.6 };
    const b = { id: 'b', pos: { x: 12.6, y: 11 }, z: 0, base: { shape: 'round' as const, mm: 32 }, rot: 0, height: 1.6 };
    expect(withinControlRange(index, a, b)).toBe(true);
  });
});

describe('the floor you are standing on is not intervening terrain', () => {
  it('"anything at least one of these lines cross is intervening" — a targeting line along a floor does not cross it', () => {
    // Both operatives on one Vantage/Ceiling roof. `segmentCrossesPoly` returns true when
    // EITHER endpoint is inside the polygon, so the roof counted as intervening — and, being
    // within 1" of the target (they are standing on it), as cover. Every operative on an
    // upper level was permanently in cover from every other operative on it.
    const deck: TerrainFeature = {
      id: 'deck',
      kind: 'test.deck',
      label: 'D',
      placement: { x: 12, y: 11, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'deck.floor',
          featureId: 'deck',
          poly: rect(8, 6, 8, 10),
          z0: 3,
          z1: 3,
          types: ['Ceiling', 'Vantage', 'Light'],
          role: 'floor',
          standable: true,
          solid: false,
        },
      ],
    };
    const index = buildTerrainIndex(testMap({ features: [deck] }));
    const base = { shape: 'round' as const, mm: 32 };
    const a = { id: 'a', pos: { x: 10, y: 8 }, z: 3, base, rot: 0, height: 1.6 };
    const b = { id: 'b', pos: { x: 10, y: 14 }, z: 3, base, rot: 0, height: 1.6 };
    const res = coverAndObscured(index, a, b);
    expect(res.inCover).toBe(false);
    expect(res.obscured).toBe(false);
  });
});

describe('denying cover for TARGETING does not delete the cover save', () => {
  /** A Conceal target hugging a Light block, shot from far enough that cover is not denied. */
  const scene = (shooterZ: number) => {
    const block: TerrainFeature = {
      id: 'lb',
      kind: 'test.light',
      label: 'L',
      placement: { x: 18.8, y: 11, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'lb.body',
          featureId: 'lb',
          poly: rect(18.5, 9.5, 0.6, 3),
          z0: 0,
          z1: 1.2,
          types: ['Light'],
          role: 'wall',
        },
      ],
    };
    const index = buildTerrainIndex(testMap({ features: [block] }));
    const base = { shape: 'round' as const, mm: 32 };
    const shooter = { id: 'a', pos: { x: 4, y: 11 }, z: shooterZ, base, rot: 0, height: 1.6 };
    const target = { id: 'b', pos: { x: 19.9, y: 11 }, z: 0, base, rot: 0, height: 1.6 };
    return { index, shooter, target };
  };

  it('Seek: "it doesn\'t remove their cover save (if any)"', () => {
    const { index, shooter, target } = scene(0);
    const plain = coverAndObscured(index, shooter, target);
    expect(plain.inCover).toBe(true);
    const seek = coverAndObscured(index, shooter, target, { ignoreCoverTerrain: 'light' });
    // Targetable now...
    expect(seek.inCoverForTargeting).toBe(false);
    // ...but the save survives.
    expect(seek.inCover).toBe(true);
  });

  it('Vantage: "it doesn\'t remove their cover save, and the defender can retain it as a critical success instead"', () => {
    const { index, shooter, target } = scene(4);
    const res = coverAndObscured(index, shooter, target, { vantageDeniesLightCover: true });
    expect(res.inCoverForTargeting).toBe(false);
    expect(res.inCover).toBe(true);
  });

  it('Vantage: "for the purposes of OBSCURED, ignore Heavy terrain connected to Vantage terrain" — cover from it stands', () => {
    // Driven through `checkTarget`, because the defect was in how the filter was WIRED: it
    // was handed to `interveningParts` as a global exclusion, so the Heavy part vanished from
    // the cover loop too and the target lost a cover save the rules never took away.
    const gantry: TerrainFeature = {
      id: 'g',
      kind: 'test.gantry',
      label: 'G',
      placement: { x: 8, y: 11, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'g.floor',
          featureId: 'g',
          poly: rect(5, 8, 4, 6),
          z0: 4,
          z1: 4,
          types: ['Vantage', 'Light'],
          role: 'floor',
          standable: true,
          solid: false,
        },
        {
          id: 'g.pillar',
          featureId: 'g',
          poly: rect(11.5, 9.5, 0.8, 3),
          z0: 0,
          z1: 2.5,
          types: ['Heavy'],
          role: 'pillar',
        },
      ],
    };
    const dummy = makeCard({ id: 'test.dummy', name: 'DUMMY' });
    const { s, ctx } = battle([dummy], [4, 4, 4, 4, 4, 4], 'test.dummy', 'test.dummy');
    s.map = testMap({ features: [gantry] });
    const a = s.operatives[s.teams.p1.operativeIds[0]!]!;
    const b = s.operatives[s.teams.p2.operativeIds[0]!]!;
    a.pos = { x: 8.5, y: 11 }; // at the deck edge, so it can see down past its own floor
    a.z = 4;
    b.pos = { x: 13, y: 11 }; // hugging the pillar, so the pillar is its cover
    b.z = 0;
    b.order = 'engage';
    const card = ctx.datacards.get('test.dummy')!;
    const profile = card.weapons[0]!.profiles[0]!;
    const check = checkTarget(ctx, s, a, b, profile, profile.rules);
    expect(check.valid).toBe(true);
    // The pillar is Heavy and within 1" of the target, so it is cover and NOT obscuring.
    expect(check.obscured).toBe(false);
    expect(check.inCover).toBe(true);
  });
});


describe('a move is checked against enemy operatives along its whole length', () => {
  const scene = () => {
    const dummy = makeCard({ id: 'test.dummy', name: 'DUMMY' });
    const { s, ctx } = battle([dummy], [4, 4, 4, 4], ['test.dummy', 'test.dummy'], 'test.dummy');
    const [a, mate] = s.teams.p1.operativeIds as [string, string];
    const foe = s.teams.p2.operativeIds[0]!;
    s.operatives[a]!.pos = { x: 10, y: 11 };
    s.operatives[foe]!.pos = { x: 13, y: 11 };
    s.operatives[mate]!.pos = { x: 3, y: 3 }; // out of the way until a test moves it
    return { s, ctx, a, mate, foe };
  };

  it('Bases: "friendly operatives can move through other friendly operatives … but not through enemy operatives"', () => {
    const { s, ctx, a } = scene();
    const v = validateMove(ctx, s, s.operatives[a]!, { points: [{ x: 16, y: 11 }] }, { action: 'Reposition' });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/base|control range/);
  });

  it('Reposition: "it cannot move within control range of an enemy operative"', () => {
    const { s, ctx, a } = scene();
    // Round the enemy but still inside its 1" control range at the closest point.
    const v = validateMove(
      ctx,
      s,
      s.operatives[a]!,
      { points: [{ x: 13, y: 12.6 }, { x: 16, y: 12.6 }] },
      { action: 'Reposition' },
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('control range');
  });

  it('Reposition: "…unless one or more other friendly operatives are already within control range of that enemy operative"', () => {
    const { s, ctx, a, mate, foe } = scene();
    s.operatives[mate]!.pos = { x: 14.3, y: 11 }; // already engaged with the enemy
    expect(inControlRange(ctx, s, s.operatives[mate]!, s.operatives[foe]!)).toBe(true);
    const v = validateMove(
      ctx,
      s,
      s.operatives[a]!,
      { points: [{ x: 13, y: 12.6 }, { x: 16, y: 13.5 }] },
      { action: 'Reposition' },
    );
    // Allowed to pass through now — and it does not finish in control range.
    expect(v.reason ?? '').not.toContain('control range');
  });

  it('Charge "may move within control range of an enemy operative"', () => {
    const { s, ctx, a } = scene();
    const v = validateMove(
      ctx,
      s,
      s.operatives[a]!,
      { points: [{ x: 13, y: 12.4 }] },
      { action: 'Charge', bonusInches: 2, mayEnterEnemyControlRange: true, mustFinishEngaged: true },
    );
    expect(v.ok).toBe(true);
  });
});

describe('the Fight sequence', () => {
  const fighters = (attackerRules: string, defenderRules = '') => {
    const mk = (id: string, rules: string) =>
      makeCard({
        id,
        name: id.toUpperCase(),
        weapons: [
          {
            name: 'blade',
            profiles: [{ type: 'melee', atk: 3, hit: 4, dmgN: 2, dmgC: 3, rules: parseWeaponRules(rules) }],
          },
        ],
      });
    return [mk('test.att', attackerRules), mk('test.def', defenderRules)];
  };

  const engage = (script: number[], attackerRules: string, defenderRules = '') => {
    const { s, ctx } = battle(fighters(attackerRules, defenderRules), script, 'test.att', 'test.def');
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    s.operatives[a]!.pos = { x: 12, y: 11 };
    s.operatives[b]!.pos = { x: 13.3, y: 11 };
    let st = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    st = reduce(
      st,
      { t: 'PerformAction', operativeId: a, action: 'Fight', params: { weaponName: 'blade', targetId: b } },
      ctx,
    ).state;
    return { st, ctx, a, b };
  };

  it('Stun: "if you retain any critical successes, subtract 1 from the APL stat of the operative this weapon is being used against"', () => {
    // Attacker rolls 6,6,6 — three critical successes with a Stun weapon. In a Fight, Stun
    // was never implemented at all: fight.ts contained no reference to the rule.
    let { st, ctx, b } = engage([6, 6, 6, 1, 1, 1], 'Stun');
    st = drain(st, ctx, (d) => (d.kind === 'reroll' || d.kind === 'retention' ? 'keep' : undefined), 60);
    expect(st.operatives[b]!.aplMods).toContain(-1);
  });

  it('"you can still block even if your opponent has no unresolved successes remaining"', () => {
    // The defender rolls nothing; the attacker still gets the choice not to strike.
    let { st, ctx } = engage([6, 6, 6, 1, 1, 1], '');
    // Answer the re-roll / retention offers until the strike-or-block window opens.
    let guard = 0;
    while (st.pending.length > 0 && st.pending[0]!.kind !== 'strikeOrBlock' && guard++ < 20) {
      const d = st.pending[0]!;
      st = reduce(st, { t: 'ResolveDecision', decisionId: d.id, optionId: 'keep' }, ctx).state;
      if (st.pending[0]?.id === d.id) {
        st = reduce(st, { t: 'ResolveDecision', decisionId: d.id, optionId: 'skip' }, ctx).state;
      }
    }
    const decision = st.pending.find((p) => p.kind === 'strikeOrBlock');
    expect(decision).toBeDefined();
    expect(decision!.options.some((o) => o.id.startsWith('block:'))).toBe(true);
  });

  it('re-rolls "alternate … starting with the player with initiative"', () => {
    // p2 has initiative, and p1 is the one who declared the Fight. Both weapons have
    // Balanced, so both players have a grant to spend.
    const { s, ctx } = battle(fighters('Balanced', 'Balanced'), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 'test.att', 'test.def');
    s.initiative = 'p2';
    const a = s.teams.p1.operativeIds[0]!;
    const b = s.teams.p2.operativeIds[0]!;
    s.operatives[a]!.pos = { x: 12, y: 11 };
    s.operatives[b]!.pos = { x: 13.3, y: 11 };
    let st = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    st = reduce(
      st,
      { t: 'PerformAction', operativeId: a, action: 'Fight', params: { weaponName: 'blade', targetId: b } },
      ctx,
    ).state;
    const first = st.pending.find((p) => p.kind === 'reroll');
    expect(first).toBeDefined();
    expect(first!.who).toBe('p2'); // the player with initiative, not the attacker
  });
});

describe('obscured takes precedence over the retention rules', () => {
  it('Punishing is not offered while obscured — "all the attacker\'s critical successes are retained as normal successes and cannot be changed to critical successes"', () => {
    const pool: DicePool = { dice: [], nextId: 1 };
    addRolled(pool, [6, 4, 1], 4);
    const rules = parseWeaponRules('Punishing, Severe, Rending');
    expect(retentionOptions(pool, rules, false).map((o) => o.id).sort()).toEqual(['punishing', 'rending']);
    // Obscured leaves no retained critical success for any of the three to key off.
    expect(retentionOptions(pool, rules, true)).toEqual([]);
  });
});

describe('Torrent secondaries are each "a valid target as normal"', () => {
  it('a secondary in the open does not inherit the primary\'s cover (that clause is Blast\'s)', () => {
    const barricade: TerrainFeature = {
      id: 'bar',
      kind: 'test.light',
      label: 'B',
      placement: { x: 15, y: 11, rotDeg: 0, flip: false },
      parts: [
        {
          id: 'bar.body',
          featureId: 'bar',
          poly: rect(14.8, 9.8, 0.4, 2.6),
          z0: 0,
          z1: 1.2,
          types: ['Light'],
          role: 'wall',
        },
      ],
    };
    const flamer = makeCard({
      id: 'test.torrent',
      name: 'TORRENT',
      weapons: [
        {
          name: 'flamer',
          profiles: [{ type: 'ranged', atk: 2, hit: 4, dmgN: 2, dmgC: 3, rules: parseWeaponRules('Torrent 3"') }],
        },
      ],
    });
    const dummy = makeCard({ id: 'test.dummy', name: 'DUMMY' });
    const { s, ctx } = battle([flamer, dummy], Array.from({ length: 60 }, () => 4), 'test.torrent', ['test.dummy', 'test.dummy']);
    s.map = testMap({ features: [barricade] });
    const a = s.teams.p1.operativeIds[0]!;
    const [primary, secondary] = s.teams.p2.operativeIds as [string, string];
    s.operatives[a]!.pos = { x: 6, y: 11 };
    s.operatives[primary]!.pos = { x: 16, y: 11 }; // hugging the barricade: in cover
    s.operatives[secondary]!.pos = { x: 16, y: 13.6 }; // clear of it, within 3" of the primary
    // Engage orders, so being in cover does not make the primary an illegal target.
    s.operatives[primary]!.order = 'engage';
    s.operatives[secondary]!.order = 'engage';
    let st = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
    st = reduce(
      st,
      { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'flamer', targetId: primary } },
      ctx,
    ).state;
    expect(st.sequence?.kind).toBe('shoot');
    const seq = st.sequence as { inCover: boolean; queue: string[]; spread?: string };
    expect(seq.inCover).toBe(true); // the primary is behind the barricade
    expect(seq.spread).toBe('torrent');
    expect(seq.queue).toContain(secondary);

    // Drive the sequence to the secondary and check it is judged on its own.
    let guard = 0;
    while (st.pending.length > 0 && guard++ < 60) {
      const d = st.pending[0]!;
      const opt = d.options.find((o) => !o.disabled)!;
      st = reduce(st, { t: 'ResolveDecision', decisionId: d.id, optionId: opt.id, ...(opt.data ? { data: opt.data } : {}) }, ctx).state;
      const cur = st.sequence;
      if (cur?.kind === 'shoot' && cur.targetId === secondary) {
        expect(cur.inCover).toBe(false);
        return;
      }
    }
    throw new Error('the sequence never reached the secondary target');
  });
});
