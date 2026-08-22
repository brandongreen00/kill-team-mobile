/**
 * The manual defence allocator's legality model.
 *
 * The screen exists because "Allocate manually" used to run the automatic allocation (D-053),
 * so the thing worth pinning is that its idea of what may be blocked agrees with the engine's:
 * anything `allocateSavesOptimally` chooses must be reachable by hand, and nothing the rules
 * forbid may be.
 */
import { describe, expect, it } from 'vitest';
import { allocateSavesOptimally } from '../src/core/dice.ts';
import { canBlock } from '../src/ui/command/allocate.tsx';

const ctx = (o: Partial<Parameters<typeof canBlock>[0]> = {}) => ({
  atkCrits: 0,
  atkNormals: 0,
  defCrits: 0,
  defNormals: 0,
  dmgN: 3,
  dmgC: 4,
  brutal: false,
  ...o,
});

describe('manual defence allocation', () => {
  it('lets a critical success block either kind, and a normal success only a normal', () => {
    // "A normal success can block a normal success. Two normal successes can block a critical
    // success. A critical success can block a normal success or a critical success."
    expect(canBlock(ctx({ atkCrits: 1, defCrits: 1 }), 1, 0)).toBe(true);
    expect(canBlock(ctx({ atkNormals: 1, defCrits: 1 }), 0, 1)).toBe(true);
    expect(canBlock(ctx({ atkNormals: 1, defNormals: 1 }), 0, 1)).toBe(true);
    // One normal cannot stop a crit; two can.
    expect(canBlock(ctx({ atkCrits: 1, defNormals: 1 }), 1, 0)).toBe(false);
    expect(canBlock(ctx({ atkCrits: 1, defNormals: 2 }), 1, 0)).toBe(true);
  });

  it('spends each defence die once', () => {
    // Two normal saves can stop one crit OR two normals — never both.
    const c = ctx({ atkCrits: 1, atkNormals: 2, defNormals: 2 });
    expect(canBlock(c, 1, 0)).toBe(true);
    expect(canBlock(c, 0, 2)).toBe(true);
    expect(canBlock(c, 1, 1)).toBe(false);
  });

  it('takes normal successes out of the pool entirely under Brutal', () => {
    // "Only critical successes can be retained as blocks."
    expect(canBlock(ctx({ atkNormals: 1, defNormals: 3, brutal: true }), 0, 1)).toBe(false);
    expect(canBlock(ctx({ atkNormals: 1, defCrits: 1, brutal: true }), 0, 1)).toBe(true);
  });

  it('refuses to block more dice than were thrown', () => {
    expect(canBlock(ctx({ atkCrits: 1, defCrits: 5 }), 2, 0)).toBe(false);
    expect(canBlock(ctx({ atkNormals: 1, defCrits: 5 }), 0, 2)).toBe(false);
    expect(canBlock(ctx({ defCrits: 5 }), -1, 0)).toBe(false);
  });

  it('can always reach the engine’s own optimal allocation by hand', () => {
    for (let atkCrits = 0; atkCrits <= 4; atkCrits++)
      for (let atkNormals = 0; atkNormals <= 4; atkNormals++)
        for (let defCrits = 0; defCrits <= 3; defCrits++)
          for (let defNormals = 0; defNormals <= 3; defNormals++)
            for (const brutal of [false, true]) {
              const best = allocateSavesOptimally(atkCrits, atkNormals, defCrits, defNormals, 3, 4, brutal);
              const c = ctx({ atkCrits, atkNormals, defCrits, defNormals, brutal });
              const blockedCrits = atkCrits - best.unblockedCrits;
              const blockedNormals = atkNormals - best.unblockedNormals;
              expect(
                canBlock(c, blockedCrits, blockedNormals),
                `optimal ${blockedCrits}c/${blockedNormals}n unreachable for ${JSON.stringify(c)}`,
              ).toBe(true);
            }
  });

  it('never claims a better allocation than the engine found', () => {
    // If the allocator says a split is legal, it cannot beat the optimum — that would mean the
    // engine's auto-allocation was leaving damage on the table.
    for (let atkCrits = 0; atkCrits <= 3; atkCrits++)
      for (let atkNormals = 0; atkNormals <= 3; atkNormals++)
        for (let defCrits = 0; defCrits <= 3; defCrits++)
          for (let defNormals = 0; defNormals <= 3; defNormals++) {
            const c = ctx({ atkCrits, atkNormals, defCrits, defNormals });
            const best = allocateSavesOptimally(atkCrits, atkNormals, defCrits, defNormals, 3, 4, false);
            for (let bc = 0; bc <= atkCrits; bc++)
              for (let bn = 0; bn <= atkNormals; bn++) {
                if (!canBlock(c, bc, bn)) continue;
                const damage = (atkCrits - bc) * 4 + (atkNormals - bn) * 3;
                expect(damage).toBeGreaterThanOrEqual(best.damage);
              }
          }
  });
});
