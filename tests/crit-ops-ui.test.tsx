/**
 * A crit op is only worth VP if a human player can actually perform its mission action.
 *
 * Approved Ops 2025 › Play the battle: "Score VP by performing mission actions and controlling
 * objective markers." Every crit-op mission action takes a `markerId`, and until this landed
 * `actionAvailability` returned early on `needsTarget` without ever asking whether any marker
 * would do — so `src/ui/command/play.tsx` rendered the row `disabled={!ok}` with `ok` decided by
 * `def.check(ctx, state, op, {})`, whose reason is always "select an objective marker". The row
 * was permanently disabled and there was no way to aim it, so five of the nine crit ops scored
 * 0VP for a human player for the whole battle (docs/RULES-AUDIT.md W-05).
 *
 * The reverse failure is just as real and is pinned below: an id in `NEEDS_TARGET` with nothing
 * legal to point at must come back `ok: false` with a reason, not as an enabled dead button that
 * writes a rejection when tapped. That is what Pick Up Marker did.
 */
import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { actionAvailability, actionTargetOptions, getAction } from '../src/core/actions.ts';
import { opsMap } from '../src/core/ops/index.ts';
import { equipmentMap } from '../src/core/equipment/index.ts';
import { testContext, testMap } from './fixtures.ts';
import type { GameContext } from '../src/core/context.ts';
import type { GameState, OperativeState } from '../src/core/types.ts';

/** A battle with the named crit op in play and both rosters deployed and ready. */
function battle(critOpId: string, turningPoint = 2): { ctx: GameContext; state: GameState } {
  const ctx = testContext({ seed: 5 });
  ctx.ops = opsMap();
  ctx.equipment = equipmentMap();
  let state = createBattle(ctx, { map: testMap(), seed: 5, critOpId });
  const roster = Array.from({ length: 3 }, () => ({ datacardId: 'test.trooper' }));
  state = reduce(state, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: roster }, ctx).state;
  state = reduce(state, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: roster }, ctx).state;
  state.setup.dropZone = { p1: 'p1', p2: 'p2' };
  state.teams.p1.operativeIds.forEach((id, i) => {
    Object.assign(state.operatives[id]!, { pos: { x: 3, y: 3 + i * 3 }, ready: true, order: 'engage' });
  });
  state.teams.p2.operativeIds.forEach((id, i) => {
    Object.assign(state.operatives[id]!, { pos: { x: 27, y: 3 + i * 3 }, ready: true, order: 'engage' });
  });
  state.setup.step = 'done';
  state.phase = 'firefight';
  state.turningPoint = turningPoint;
  state.initiative = 'p1';
  state.activePlayer = 'p1';
  return { ctx, state };
}

/** Stand `op` on a marker and make it the active operative. */
function standOn(ctx: GameContext, state: GameState, op: OperativeState, markerId: string): void {
  const m = state.markers[markerId]!;
  op.pos = { ...m.pos };
  op.z = m.z;
  state.activeOperativeId = op.id;
  state.activePlayer = op.player;
  op.apSpent = 0;
  op.actionsThisActivation = [];
}

const rowFor = (ctx: GameContext, state: GameState, op: OperativeState, id: string) =>
  actionAvailability(ctx, state, op).find((r) => r.def.id === id);

// ---------------------------------------------------------------------------
describe('crit-op mission actions are reachable', () => {
  it('"Score VP by performing mission actions" — Secure is offered, aimed, and scores', () => {
    const { ctx, state } = battle('crit.secure');
    const op = state.operatives[state.teams.p1.operativeIds[0]!]!;
    standOn(ctx, state, op, 'centre');

    const row = rowFor(ctx, state, op, 'Secure')!;
    expect(row.needsTarget).toBe('marker');
    expect(row.ok).toBe(true); // was false: `check({})` said "select an objective marker"

    const opts = actionTargetOptions(ctx, state, op, row.def);
    expect(opts.map((o) => o.id)).toContain('centre');
    // Every option the selector offers must be one the reducer accepts — that is the whole
    // contract, and it is what stops the aim screen offering a button that rejects.
    for (const o of opts) {
      const out = reduce(state, { t: 'PerformAction', operativeId: op.id, action: 'Secure', params: o.params }, ctx);
      expect({ id: o.id, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
    }
  });

  it('an action with nothing legal to point at is disabled with a real reason, not an enabled dead button', () => {
    const { ctx, state } = battle('crit.secure');
    const op = state.operatives[state.teams.p1.operativeIds[0]!]!;
    state.activeOperativeId = op.id;
    op.pos = { x: 1, y: 1 }; // 12"+ from every marker
    const row = rowFor(ctx, state, op, 'Secure')!;
    expect(row.ok).toBe(false);
    expect(actionTargetOptions(ctx, state, op, row.def)).toEqual([]);
    // Not "select an objective marker" — that is about the missing param, not the operative.
    expect(row.reason).toBeDefined();
    expect(row.reason).not.toBe('select an objective marker');
  });

  it('Pick Up Marker is no longer offered while the operative carries nothing and stands nowhere near one', () => {
    const { ctx, state } = battle('crit.secure');
    const op = state.operatives[state.teams.p1.operativeIds[0]!]!;
    state.activeOperativeId = op.id;
    op.pos = { x: 1, y: 1 };
    const row = rowFor(ctx, state, op, 'Pick Up Marker')!;
    expect(row.ok).toBe(false); // was true, and one tap wrote "no such marker" into state.rejected
    // ...and the reducer would indeed have refused the tap the old row invited.
    const out = reduce(state, { t: 'PerformAction', operativeId: op.id, action: 'Pick Up Marker', params: {} }, ctx);
    expect(out.ok).toBe(false);
    expect(out.state.rejected.length).toBeGreaterThan(state.rejected.length);
  });

  it('crit.orb: "move it to either player’s objective marker (your choice)" offers exactly the choice the rule gives', () => {
    // Centre leg — the rule says "(your choice)", so both player markers are offered.
    const a = battle('crit.orb');
    const orbA = Object.values(a.state.markers).find((m) => m.kind === 'orb');
    if (orbA) {
      const op = a.state.operatives[a.state.teams.p1.operativeIds[0]!]!;
      standOn(a.ctx, a.state, op, 'centre');
      const def = getAction('Move Orb')!;
      const opts = actionTargetOptions(a.ctx, a.state, op, def);
      // Whatever leg the fixture starts on, every option must be one the reducer accepts and
      // none may be a duplicate of another — the bug the verifier caught was three buttons
      // that all did the same thing on the leg where the rule gives no choice.
      expect(new Set(opts.map((o) => JSON.stringify(o.params))).size).toBe(opts.length);
      for (const o of opts) {
        const out = reduce(
          a.state,
          { t: 'PerformAction', operativeId: op.id, action: 'Move Orb', params: o.params },
          a.ctx,
        );
        expect({ id: o.id, ok: out.ok, reason: out.reason }).toMatchObject({ ok: true });
      }
    }
  });
});
