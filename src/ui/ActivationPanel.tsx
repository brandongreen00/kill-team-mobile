/**
 * The operative's action sheet: every action it could take right now, and — for those it
 * cannot — the rule that stops it. Faction rules, ploys, equipment and unique actions are
 * surfaced here too, with an "auto-applied" badge for passive ones.
 */
import { useState } from 'preact/hooks';
import { availableActions } from '../core/actions.ts';
import { validTargets } from '../core/sequences/shoot.ts';
import { aplOf, card, enemiesInControlRange, isInjured, weaponsOf } from '../core/state.ts';
import { whoActivates, counteractCandidates } from '../core/phases.ts';
import type { Store } from './store.ts';

export function ActivationPanel({ store }: { store: Store }) {
  const { state, ctx } = store;
  const [weapon, setWeapon] = useState<string>('');
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  const turn = whoActivates(state);

  if (state.phase !== 'firefight') {
    return (
      <section class="card">
        <h2>Firefight</h2>
        <p class="muted">
          {state.phase === 'strategy'
            ? `Strategy phase — ${state.strategyStep} step.`
            : state.phase === 'setup'
              ? 'Set up the battle first.'
              : 'The battle has ended.'}
        </p>
      </section>
    );
  }

  if (!active) {
    if (!turn) return <section class="card"><h2>Firefight</h2><p class="muted">All operatives are expended.</p></section>;
    if (turn.mode === 'counteract') {
      const candidates = counteractCandidates(ctx, state, turn.player);
      return (
        <section class="card">
          <h2>Counteract — {turn.player}</h2>
          <p class="muted">
            One free 1AP action (excluding Guard), moving no more than 2". Counteracting is not an
            activation, so action restrictions do not apply.
          </p>
          <div class="row">
            {candidates.map((op) => (
              <button key={op.id} onClick={() => store.dispatch({ t: 'Counteract', player: turn.player, operativeId: op.id })}>
                {op.letter}
              </button>
            ))}
            <button onClick={() => store.dispatch({ t: 'DeclineCounteract', player: turn.player })}>Decline</button>
          </div>
        </section>
      );
    }
    const ready = Object.values(state.operatives).filter((o) => o.player === turn.player && o.ready && !o.removed);
    return (
      <section class="card">
        <h2>Activate — {turn.player}</h2>
        <p class="muted">Choose an operative and its order. It keeps that order until it is next activated.</p>
        {ready.map((op) => (
          <div key={op.id} class="row" style={{ marginBottom: 6 }}>
            <strong style={{ minWidth: 28 }}>{op.letter}</strong>
            <span class="muted">{card(ctx, op).name}</span>
            <div class="spacer" />
            <button onClick={() => store.dispatch({ t: 'ActivateOperative', player: turn.player, operativeId: op.id, order: 'engage' })}>
              Engage
            </button>
            <button onClick={() => store.dispatch({ t: 'ActivateOperative', player: turn.player, operativeId: op.id, order: 'conceal' })}>
              Conceal
            </button>
          </div>
        ))}
      </section>
    );
  }

  const dc = card(ctx, active);
  const apl = aplOf(ctx, state, active);
  const actions = availableActions(ctx, state, active);
  const ranged = weaponsOf(ctx, state, active, 'ranged');
  const melee = weaponsOf(ctx, state, active, 'melee');
  const engagedWith = enemiesInControlRange(ctx, state, active);
  const shootWeapon = weapon || ranged[0]?.name || '';
  const targets = shootWeapon ? validTargets(ctx, state, active, shootWeapon) : [];

  const perform = (action: string, params?: Record<string, unknown>) =>
    store.dispatch({ t: 'PerformAction', operativeId: active.id, action, params: params as never });

  return (
    <section class="card">
      <h2>
        {active.letter} — {dc.name}
      </h2>
      <div class="row" style={{ marginBottom: 8 }}>
        <span class="tag">AP {active.apSpent}/{apl}</span>
        <span class="tag">{active.wounds}/{dc.wounds} wounds</span>
        <span class="tag">{active.order}</span>
        {isInjured(ctx, active) && <span class="tag" style={{ color: 'var(--danger)' }}>injured</span>}
        {active.onGuard && <span class="tag">on Guard</span>}
        {engagedWith.length > 0 && <span class="tag">engaged ×{engagedWith.length}</span>}
      </div>

      <div class="row">
        {actions.map(({ def, ap, ok, reason }) => (
          <button
            key={def.id}
            disabled={!ok || def.id === 'Shoot' || def.id === 'Fight'}
            title={reason ?? def.sourceText}
            onClick={() => perform(def.id)}
          >
            {def.name} <span class="muted">{ap}AP</span>
          </button>
        ))}
      </div>

      {ranged.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h2>Shoot</h2>
          <div class="row">
            <select value={shootWeapon} onChange={(e) => setWeapon((e.target as HTMLSelectElement).value)}>
              {ranged.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div class="row" style={{ marginTop: 6 }}>
            {targets.length === 0 && <span class="muted">No valid targets.</span>}
            {targets.map(({ target, check }) => (
              <button
                key={target.id}
                onClick={() => perform('Shoot', { weaponName: shootWeapon, targetId: target.id })}
                title={`${check.distance.toFixed(1)}" · ${check.inCover ? 'in cover' : 'no cover'}${
                  check.obscured ? ' · obscured' : ''
                }`}
              >
                🎯 {target.letter}
                {check.obscured ? ' (obscured)' : check.inCover ? ' (cover)' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {melee.length > 0 && engagedWith.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h2>Fight</h2>
          <div class="row">
            {engagedWith.map((e) => (
              <button
                key={e.id}
                onClick={() => perform('Fight', { meleeWeaponName: melee[0]!.name, targetId: e.id })}
              >
                ⚔ {e.letter}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="row" style={{ marginTop: 10 }}>
        <button class="primary" onClick={() => store.dispatch({ t: 'EndActivation', operativeId: active.id })}>
          End activation
        </button>
      </div>

      {dc.abilities.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary class="muted">Abilities ({dc.abilities.length}) — auto-applied</summary>
          {dc.abilities.map((a) => (
            <p key={a.id} class="muted">
              <strong>{a.name}.</strong> {a.text}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
