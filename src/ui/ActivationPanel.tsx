/**
 * The operative's action sheet: every action it could take right now, and — for those it
 * cannot — the rule that stops it. Movement actions arm the board's tap-to-move planner
 * instead of dispatching directly (a move needs a path; the planner collects it). Actions
 * that need a marker resolve it from the operative's surroundings, so a button tap either
 * works or is visibly disabled with its reason — never silently rejected.
 */
import { useState } from 'preact/hooks';
import { availableActions, type ActionDef } from '../core/actions.ts';
import { validTargets } from '../core/sequences/shoot.ts';
import { aplOf, card, enemiesInControlRange, isInjured, moveOf, weaponsOf } from '../core/state.ts';
import { whoActivates, counteractCandidates } from '../core/phases.ts';
import { playerLabel } from '../core/types.ts';
import type { MoveAction } from '../core/movement.ts';
import type { ActionParams } from '../core/intents.ts';
import { isMoveAction, type MovePlan } from './MovePlanner.tsx';
import type { Store } from './store.ts';

export interface ActivationPanelProps {
  store: Store;
  /** The armed tap-to-move plan, if any — the matching action button shows as pressed. */
  movePlan: MovePlan | null;
  /** Arm the tap-to-move planner for a movement action. */
  onArmMove: (operativeId: string, action: MoveAction) => void;
}

export function ActivationPanel({ store, movePlan, onArmMove }: ActivationPanelProps) {
  const { state, ctx } = store;
  const [weaponKey, setWeaponKey] = useState<string>('');
  /** Rejection from this sheet's own dispatches, shown inline where the tap happened. */
  const [err, setErr] = useState<string | null>(null);
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  const turn = whoActivates(state, ctx);

  if (state.phase !== 'firefight') return null;

  if (!active) {
    if (!turn)
      return (
        <section class="card">
          <h2>Firefight</h2>
          <p class="muted">All operatives are expended — end the turning point below.</p>
        </section>
      );
    if (turn.mode === 'counteract') {
      const candidates = counteractCandidates(ctx, state, turn.player);
      return (
        <section class="card">
          <h2>Counteract — {playerLabel(turn.player)}</h2>
          <p class="muted">
            One free 1AP action (excluding Guard), moving no more than 2". Counteracting is not an
            activation, so action restrictions do not apply.
          </p>
          <div class="row">
            {candidates.map((op) => (
              <button
                key={op.id}
                onClick={() => store.dispatch({ t: 'Counteract', player: turn.player, operativeId: op.id })}
              >
                {op.name}
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
        <h2>Activate — {playerLabel(turn.player)}</h2>
        <p class="muted">Choose an operative and its order. It keeps that order until it is next activated.</p>
        {ready.map((op) => (
          <div key={op.id} class="row" style={{ marginBottom: 6 }}>
            <span class="op-letter" aria-hidden="true">{op.letter}</span>
            <strong>{op.name}</strong>
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

  /** One entry per weapon profile, so frag/krak-style choices are actually choosable. */
  const shootChoices = ranged.flatMap((w) =>
    w.profiles.map((p) => ({
      weaponName: w.name,
      profileName: p.name || undefined,
      key: `${w.name}|${p.name ?? ''}`,
      label: p.name ? `${w.name} (${p.name})` : w.name,
    })),
  );
  const shootChoice = shootChoices.find((c) => c.key === weaponKey) ?? shootChoices[0];
  const targets = shootChoice ? validTargets(ctx, state, active, shootChoice.weaponName, shootChoice.profileName) : [];

  const perform = (action: string, params?: ActionParams): boolean => {
    const ok = store.dispatch({ t: 'PerformAction', operativeId: active.id, action, params: params as never });
    setErr(ok ? null : store.lastError);
    return ok;
  };

  /**
   * A movement action can be armed unless its pathless preconditions already fail
   * (Reposition while engaged, Charge with a Conceal order, …).
   */
  const moveBlock = (def: ActionDef): string | undefined => {
    const r = def.check(ctx, state, active, { path: { points: [] } });
    if (r.ok || r.reason === 'no movement declared' || r.reason === 'no path supplied') return undefined;
    return r.reason;
  };

  /** Find params that make a non-movement action legal: bare first, then each marker. */
  const resolveParams = (def: ActionDef): { params: ActionParams; reason?: undefined } | { params?: undefined; reason: string } => {
    const bare = def.check(ctx, state, active, {});
    if (bare.ok) return { params: {} };
    for (const m of Object.values(state.markers)) {
      if (def.check(ctx, state, active, { markerId: m.id }).ok) return { params: { markerId: m.id } };
    }
    return { reason: bare.reason ?? 'not possible right now' };
  };

  /**
   * Shoot/Fight and their team variants ("Shoot (Astartes)", "Fight (Savage Brutality)")
   * take a weapon + target, so they live in the targeting sections below, not the action
   * row. A target button uses the FIRST variant whose check passes — the plain action for
   * the first shot, the team's second-shot variant after it.
   */
  const isShootLike = (def: ActionDef) => def.id === 'Shoot' || def.name.startsWith('Shoot (');
  const isFightLike = (def: ActionDef) => def.id === 'Fight' || def.name.startsWith('Fight (');
  const shootVariants = actions.filter(({ def }) => isShootLike(def));
  const fightVariants = actions.filter(({ def }) => isFightLike(def));
  const rowActions = actions.filter(({ def }) => !isShootLike(def) && !isFightLike(def));

  const firstLegal = (
    variants: typeof actions,
    params: ActionParams,
  ): { use?: (typeof actions)[number]; reason?: string } => {
    let reason: string | undefined;
    for (const cand of variants) {
      if (!cand.ok) {
        reason ??= cand.reason;
        continue;
      }
      const chk = cand.def.check(ctx, state, active, params);
      if (chk.ok) return { use: cand };
      reason ??= chk.reason;
    }
    return { reason: reason ?? 'not possible right now' };
  };

  return (
    <section class="card">
      <h2>{active.name}</h2>
      <div class="row" style={{ marginBottom: 8 }}>
        <span class="op-letter" aria-hidden="true">{active.letter}</span>
        <span class="tag">AP {active.apSpent}/{apl}</span>
        <span class="tag">{active.wounds}/{dc.wounds} wounds</span>
        <span class="tag">{active.order}</span>
        <span class="tag">Move {moveOf(ctx, state, active)}"</span>
        {isInjured(ctx, active) && <span class="tag" style={{ color: 'var(--danger)' }}>injured</span>}
        {active.onGuard && <span class="tag">on Guard</span>}
        {engagedWith.length > 0 && <span class="tag">engaged ×{engagedWith.length}</span>}
      </div>

      <div class="row">
        {rowActions.map(({ def, ap, ok, reason }) => {
          if (isMoveAction(def.id)) {
            const block = ok ? moveBlock(def) : reason;
            const armed = movePlan?.operativeId === active.id && movePlan.action === def.id;
            return (
              <button
                key={def.id}
                disabled={!ok || !!block}
                aria-pressed={armed}
                class={armed ? 'primary' : undefined}
                title={block ?? reason ?? `${def.sourceText}`}
                onClick={() => onArmMove(active.id, def.id as MoveAction)}
              >
                {def.name} <span class="muted">{ap}AP</span>
              </button>
            );
          }
          const resolved = ok ? resolveParams(def) : { reason: reason ?? 'not possible right now' };
          return (
            <button
              key={def.id}
              disabled={!ok || resolved.params === undefined}
              title={resolved.reason ?? reason ?? def.sourceText}
              onClick={() => perform(def.id, resolved.params)}
            >
              {def.name} <span class="muted">{ap}AP</span>
            </button>
          );
        })}
      </div>

      {ranged.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h2>Shoot</h2>
          <div class="row">
            <select
              value={shootChoice?.key ?? ''}
              aria-label="Weapon to shoot with"
              onChange={(e) => setWeaponKey((e.target as HTMLSelectElement).value)}
            >
              {shootChoices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div class="row" style={{ marginTop: 6 }}>
            {targets.length === 0 && <span class="muted">No valid targets — check line of sight, order and range.</span>}
            {targets.map(({ target, check }) => {
              const params: ActionParams = {
                weaponName: shootChoice!.weaponName,
                ...(shootChoice!.profileName ? { profileName: shootChoice!.profileName } : {}),
                targetId: target.id,
              };
              const pick = firstLegal(shootVariants, params);
              return (
                <button
                  key={target.id}
                  disabled={!pick.use}
                  onClick={() => pick.use && perform(pick.use.def.id, params)}
                  title={
                    pick.use
                      ? `${check.distance.toFixed(1)}" · ${check.inCover ? 'in cover' : 'no cover'}${
                          check.obscured ? ' · obscured' : ''
                        }${pick.use.def.id !== 'Shoot' ? ` · ${pick.use.def.name}` : ''}`
                      : pick.reason
                  }
                >
                  🎯 {target.name}
                  {check.obscured ? ' (obscured)' : check.inCover ? ' (cover)' : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {melee.length > 0 && engagedWith.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h2>Fight</h2>
          <div class="row">
            {engagedWith.map((e) => {
              const params: ActionParams = { meleeWeaponName: melee[0]!.name, targetId: e.id };
              const pick = firstLegal(fightVariants, params);
              return (
                <button
                  key={e.id}
                  disabled={!pick.use}
                  title={pick.use ? (pick.use.def.id !== 'Fight' ? pick.use.def.name : undefined) : pick.reason}
                  onClick={() => pick.use && perform(pick.use.def.id, params)}
                >
                  ⚔ {e.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {err && <p class="err">✖ {err}</p>}

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
