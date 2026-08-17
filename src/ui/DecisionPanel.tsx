/**
 * The reactive-window surface. Every player choice the rules create arrives here as a
 * PendingDecision: rerolls (Ceaseless/Balanced/Relentless/Command Re-roll), cover-vs-obscured,
 * obscured discard, retention rules, defence allocation, strike-or-block, ploy offers.
 *
 * It is deliberately one component: the rules make no distinction between "a prompt during
 * my turn" and "a prompt during my opponent's turn", and neither does the engine.
 */
import type { Store } from './store.ts';
import type { PendingDecision, PlayerId } from '../core/types.ts';

export interface DecisionPanelProps {
  store: Store;
  decision: PendingDecision;
  /** Pass-and-play: hide the options when it is not this device-holder's decision. */
  viewer?: PlayerId | 'both';
}

const PLAYER_LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };

export function DecisionPanel({ store, decision, viewer = 'both' }: DecisionPanelProps) {
  const hidden = viewer !== 'both' && viewer !== decision.who;
  const answer = (optionId: string) => {
    store.dispatch({ t: 'ResolveDecision', decisionId: decision.id, optionId });
  };

  return (
    <section class="card decision" aria-live="polite">
      <h2>
        {PLAYER_LABEL[decision.who]} decides
        <span class="tag" style={{ marginLeft: 8 }}>
          {decision.kind}
        </span>
      </h2>
      <p>{decision.prompt}</p>
      {hidden ? (
        <p class="muted">Hand the device to {PLAYER_LABEL[decision.who]}.</p>
      ) : (
        <>
          <div class="row">
            {decision.options.map((o) => (
              <button
                key={o.id}
                onClick={() => answer(o.id)}
                disabled={o.disabled}
                title={o.reason ?? undefined}
                class={o.id === 'auto' || o.id === 'keep' ? 'primary' : undefined}
              >
                {o.label}
              </button>
            ))}
            {decision.optional && (
              <button onClick={() => store.dispatch({ t: 'PassDecision', decisionId: decision.id })}>Pass</button>
            )}
          </div>
          {decision.sourceText && (
            <details style={{ marginTop: 8 }}>
              <summary class="muted">Rule text</summary>
              <p class="muted">{decision.sourceText}</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
