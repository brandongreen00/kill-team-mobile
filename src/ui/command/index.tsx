/**
 * The router: GameState in, one `CommandPlan` out.
 *
 * This is the single place that answers "what is the player supposed to do right now?", and
 * it is why the phone shell needs no tabs. Every screen in the battle is a branch here, so a
 * state that has no screen is impossible to reach by accident — it falls through to a loud
 * placeholder instead of an empty panel.
 */
import type { Store } from '../store.ts';
import type { TeamData } from '../data.ts';
import type { PendingDecision, PlayerId } from '../../core/types.ts';
import { IconHandover } from '../icons.tsx';
import type { CommandPlan, UiState } from './types.ts';
import { deployPlan, dropZonePlan, rollOffPlan, selectOperativesPlan, unknownSetupPlan } from './setup.tsx';
import {
  activateChoicePlan,
  activationPlan,
  battleEndPlan,
  endOfTpPlan,
  guardInterruptPlan,
  guardOffer,
  strategyPlan,
} from './play.tsx';

const LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };

export interface CommandArgs {
  store: Store;
  teams: TeamData[];
  ui: UiState;
  setUi: (next: Partial<UiState>) => void;
}

export function commandPlan(args: CommandArgs): CommandPlan {
  const { store } = args;
  const { state } = store;

  // A reactive window outranks everything: the rules block on it, so the screen does too.
  const decision = state.pending[0];
  if (decision) return decisionPlan(args, decision);

  // On Guard is second, and it is a special case worth stating: it is NOT a PendingDecision,
  // the reducer does not block on it, so if this branch did not exist the active player would
  // simply carry on and the opponent's interrupt would never happen.
  const guard = guardOffer(store);
  if (guard) return guardInterruptPlan(args, guard);

  if (state.phase === 'setup') {
    switch (state.setup.step) {
      case 'rollOff':
        return rollOffPlan(args);
      case 'chooseDropZone':
        return dropZonePlan(args);
      case 'selectOperatives':
        return selectOperativesPlan(args);
      case 'deploy':
        return deployPlan(args);
      default:
        return unknownSetupPlan(state.setup.step);
    }
  }

  if (state.phase === 'strategy') return strategyPlan(args);
  if (state.phase === 'firefight') {
    return state.activeOperativeId && state.operatives[state.activeOperativeId]
      ? activationPlan(args)
      : activateChoicePlan(args);
  }
  if (state.phase === 'endOfTP') return endOfTpPlan(args);
  return battleEndPlan(args);
}

/**
 * Reactive windows — rerolls, cover-vs-obscured, defence allocation, strike-or-block, On
 * Guard interrupts, ploy offers. The dice they are about are drawn on the board behind, so
 * the sheet sits at `half` and the board stays readable rather than being covered.
 */
function decisionPlan({ store, ui, setUi }: CommandArgs, decision: PendingDecision): CommandPlan {
  const mine = ui.handedOverTo === undefined || ui.handedOverTo === decision.who;
  const answer = (optionId: string) => store.dispatch({ t: 'ResolveDecision', decisionId: decision.id, optionId });

  if (!mine) {
    return {
      id: 'decision.handover',
      step: 'Reactive window',
      title: `Hand the device to ${LABEL[decision.who]}`,
      help: decision.prompt,
      frame: null,
      modal: true,
      detent: 'rest',
      turnOf: decision.who,
      actions: [
        {
          id: 'handover',
          label: `I am ${LABEL[decision.who]}`,
          tone: 'primary',
          icon: <IconHandover size={20} />,
          onClick: () => setUi({ handedOverTo: decision.who }),
        },
      ],
    };
  }

  const options = decision.options;
  // One obvious default: the engine marks it `auto`/`keep` where the rules have one.
  const preferred = options.find((o) => (o.id === 'auto' || o.id === 'keep') && !o.disabled) ?? options.find((o) => !o.disabled);

  return {
    id: `decision.${decision.kind}`,
    step: `${LABEL[decision.who]} decides · ${decision.kind}`,
    title: decision.prompt,
    frame: null,
    modal: true,
    detent: 'half',
    turnOf: decision.who,
    actions: [
      ...(preferred
        ? [{ id: preferred.id, label: preferred.label, tone: 'primary' as const, onClick: () => answer(preferred.id) }]
        : []),
      ...(decision.optional
        ? [{ id: 'pass', label: 'Pass', tone: 'quiet' as const, onClick: () => store.dispatch({ t: 'PassDecision', decisionId: decision.id }) }]
        : []),
    ],
    body: (
      <>
        <div class="actions">
          {options
            .filter((o) => o.id !== preferred?.id)
            .map((o) => (
              // The reason goes IN the row. `title` is invisible on a touch screen, and a
              // greyed option with no explanation is the same dead end as a silent rejection.
              <button key={o.id} class={o.disabled ? 'is-blocked' : undefined} disabled={o.disabled} onClick={() => answer(o.id)}>
                <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                  <span class="entry-name">{o.label}</span>
                  {o.disabled && o.reason && <span class="entry-meta why">{o.reason}</span>}
                </span>
              </button>
            ))}
        </div>
        {decision.sourceText && (
          <details class="disclosure">
            <summary>Rule text</summary>
            <p class="rule-text">{decision.sourceText}</p>
          </details>
        )}
      </>
    ),
  };
}
