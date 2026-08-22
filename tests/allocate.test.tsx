/**
 * @vitest-environment jsdom
 *
 * The manual defence allocator's legality model, and the screen built on it.
 *
 * The screen exists because "Allocate manually" used to run the automatic allocation (D-053),
 * so the thing worth pinning is that its idea of what may be blocked agrees with the engine's:
 * anything `allocateSavesOptimally` chooses must be reachable by hand, and nothing the rules
 * forbid may be.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { allocateSavesOptimally } from '../src/core/dice.ts';
import { allocatePlan, canBlock } from '../src/ui/command/allocate.tsx';
import type { PendingDecision } from '../src/core/types.ts';
import type { UiState } from '../src/ui/command/types.ts';

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


/** Two crits and two normals coming in, against two normal saves. */
const decision = (): PendingDecision => ({
  id: 'alloc-1',
  who: 'p2',
  kind: 'allocateDefence',
  prompt: 'Allocate defence dice',
  optional: true,
  options: [
    { id: 'auto', label: 'Auto-allocate', data: { unblockedCrits: 1, unblockedNormals: 2, damage: 10 } },
    { id: 'manual', label: 'Allocate manually' },
  ],
  ctx: {
    alloc: { unblockedCrits: 1, unblockedNormals: 2, damage: 10 },
    brutal: false,
    atkCrits: 2,
    atkNormals: 2,
    defCrits: 0,
    defNormals: 2,
    dmgN: 3,
    dmgC: 4,
  },
});

describe('the manual allocation screen', () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  /**
   * The plan is a pure function of (decision, ui), so a harness has to hold the ui and
   * re-render on every change — which is exactly what `App` does.
   */
  function mount(answer: (optionId: string, data?: Record<string, unknown>) => void) {
    let ui: UiState = {};
    const draw = () => {
      const plan = allocatePlan(answer, decision(), 'step', ui, (next) => {
        ui = { ...ui, ...next };
        draw();
      });
      act(() =>
        render(
          <>
            <div class="prompt">
              {plan.armedNote && <div class="armed-banner">{plan.armedNote}</div>}
              {plan.actions.map((a) => (
                <button key={a.id} class={a.tone === 'primary' ? 'primary' : ''} onClick={a.onClick}>
                  {a.label}
                </button>
              ))}
            </div>
            {plan.body}
          </>,
          host,
        ),
      );
    };
    draw();
  }

  const chips = () => [...host.querySelectorAll('.hit-chip')] as HTMLButtonElement[];
  const banner = () => host.querySelector('.armed-banner')?.textContent ?? '';

  it('draws one chip per incoming hit, criticals first, and seeds the engine’s own allocation', () => {
    mount(() => undefined);

    // 2 crits + 2 normals.
    expect(chips()).toHaveLength(4);
    expect(chips()[0]!.classList.contains('is-crit')).toBe(true);
    expect(chips()[3]!.classList.contains('is-crit')).toBe(false);
    // Two normal saves block one crit, which is what `allocateSavesOptimally` chooses: one
    // crit saved, nothing else. The screen opens on that, so manual is a change FROM the
    // safe answer rather than a blank slate.
    expect(chips().filter((c) => c.classList.contains('is-blocked-hit'))).toHaveLength(1);
    expect(banner()).toContain('10 damage');
    expect(banner()).toContain('the best you can do');
  });

  it('commits the allocation the player actually built, not the automatic one', () => {
    // This is the whole point: 'manual' used to carry no data, so `resolveDecision` fell back
    // to the auto allocation and the player's choice was silently discarded.
    const answered: { optionId: string; data?: Record<string, unknown> }[] = [];
    mount((optionId, data) => answered.push({ optionId, ...(data ? { data } : {}) }));

    // Un-save the crit and save a normal success instead — legal (one normal blocks one
    // normal), and worse, which the screen has to say out loud rather than quietly fix.
    act(() => chips()[0]!.click());
    act(() => chips()[2]!.click());
    expect(banner()).toContain('auto-allocating would take 10');

    const commit = [...host.querySelectorAll('button.primary')][0] as HTMLButtonElement;
    act(() => commit.click());
    expect(answered).toHaveLength(1);
    expect(answered[0]!.optionId).toBe('manual');
    expect(answered[0]!.data).toEqual({ unblockedCrits: 2, unblockedNormals: 1 });
  });

  it('refuses a save the rules cannot pay for', () => {
    mount(() => undefined);
    // Both normal saves are already spent blocking the crit; saving a normal hit as well is
    // not reachable, so that chip is disabled rather than silently doing nothing.
    expect(chips()[2]!.disabled).toBe(true);
  });
});
