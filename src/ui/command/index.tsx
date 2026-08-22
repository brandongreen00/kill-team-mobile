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
import type { GameState, PendingDecision, PlayerId } from '../../core/types.ts';
import { IconHandover } from '../icons.tsx';
import type { CommandPlan, UiState } from './types.ts';
import { allocatePlan } from './allocate.tsx';
import { deployPlan, dropZonePlan, placeEquipmentPlan, rollOffPlan, selectOperativesPlan, unknownSetupPlan } from './setup.tsx';
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

/**
 * `PendingDecision.kind` is an internal id. Uppercased into an eyebrow it reads as
 * "PRIMARYOP" — which tells a player nothing and looks like a broken build. Known kinds get
 * their printed name; anything else is at least de-camel-cased rather than shipped raw.
 */
const DECISION_LABEL: Record<string, string> = {
  primaryOp: 'Primary op',
  initiativeCard: 'Initiative card',
  chooseInitiative: 'Initiative',
  reroll: 'Re-roll',
  coverOrObscured: 'Cover or obscured',
  obscuredDiscard: 'Obscured',
  retention: 'Retain or discard',
  allocateDefence: 'Defence',
  strikeOrBlock: 'Strike or block',
  ploy: 'Firefight ploy',
  guardInterrupt: 'On Guard',
};

const decisionLabel = (kind: string): string =>
  DECISION_LABEL[kind] ?? kind.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Pass-and-play on one phone: who is expected to be holding it right now?
 *
 * The device is with whoever is acting — the operative's controller during their activation,
 * the player to act during setup. Anything a REACTIVE window asks is therefore, by
 * definition, asked of the other player: the defender allocating saves, the On Guard
 * interrupt, the opponent's secret primary op. Those are the moments the phone has to change
 * hands, and until now nothing said so after setup ended, because `handedOverTo` was cleared
 * at the reveal and never set again. Two people sharing one screen simply saw each other's
 * secret choices.
 */
export function deviceHolder(state: GameState): PlayerId {
  if (state.phase === 'setup') return state.setup.toAct ?? state.initiative ?? 'p1';
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && !active.removed) return active.player;
  return state.activePlayer ?? state.initiative ?? 'p1';
}

/**
 * The screen that stands between the two players. Returns null when the device is already in
 * the right hands, or when this is a sandbox game — one person driving both sides does not
 * want to confirm a handover every time a save is rolled.
 */
export function handoverGate(
  args: CommandArgs,
  who: PlayerId,
  step: string,
  help: string,
): CommandPlan | null {
  const { store, ui, setUi } = args;
  if (store.state.mode !== 'match') return null;
  const holder = ui.handedOverTo ?? deviceHolder(store.state);
  if (holder === who) return null;
  return {
    id: 'handover',
    step,
    title: `Hand the device to ${LABEL[who]}`,
    help,
    frame: null,
    modal: true,
    detent: 'rest',
    turnOf: who,
    actions: [
      {
        id: 'handover',
        label: `I am ${LABEL[who]}`,
        tone: 'primary',
        icon: <IconHandover size={20} />,
        onClick: () => setUi({ handedOverTo: who }),
      },
    ],
  };
}

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
  if (guard)
    return (
      handoverGate(
        args,
        guard.player,
        `Turning point ${state.turningPoint} · On Guard`,
        'Your opponent is mid-activation. This window is yours: only you should see which of your operatives is on guard.',
      ) ?? guardInterruptPlan(args, guard)
    );

  if (state.phase === 'setup') {
    switch (state.setup.step) {
      case 'rollOff':
        return rollOffPlan(args);
      case 'chooseDropZone':
        return dropZonePlan(args);
      case 'selectOperatives':
        return selectOperativesPlan(args);
      case 'placeEquipment':
        return placeEquipmentPlan(args);
      case 'deploy':
        return deployPlan(args);
      default:
        return unknownSetupPlan(state.setup.step);
    }
  }

  if (state.phase === 'strategy') return strategyPlan(args);
  if (state.phase === 'firefight') {
    // `removeIncapacitated` marks the record rather than deleting it and does not clear
    // `activeOperativeId`, so an operative killed by a counter-strike or an On Guard
    // interrupt kept its datacard and its full action list, every tap being rejected.
    const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
    return active && !active.removed ? activationPlan(args) : activateChoicePlan(args);
  }
  if (state.phase === 'endOfTP') return endOfTpPlan(args);
  return battleEndPlan(args);
}

/**
 * Reactive windows — rerolls, cover-vs-obscured, defence allocation, strike-or-block, On
 * Guard interrupts, ploy offers. The dice they are about are drawn on the board behind, so
 * the sheet sits at `half` and the board stays readable rather than being covered.
 */
function decisionPlan(args: CommandArgs, decision: PendingDecision): CommandPlan {
  const { store, ui, setUi } = args;
  const gate = handoverGate(args, decision.who, `${LABEL[decision.who]} decides · ${decisionLabel(decision.kind)}`, decision.prompt);
  if (gate) return { ...gate, id: 'decision.handover' };

  /**
   * Resolving hands the device back: the holder reverts to whoever is actually acting, so
   * the next reactive window for the other player asks for the phone again. Without the
   * clear, one handover during turning point 1 would silently make that player the assumed
   * holder for the rest of the battle.
   */
  const answer = (optionId: string, data?: Record<string, unknown>) => {
    store.dispatch({ t: 'ResolveDecision', decisionId: decision.id, optionId, ...(data ? { data } : {}) });
    if (ui.handedOverTo !== undefined) setUi({ handedOverTo: undefined });
  };

  // Defence allocation is the one window with a real, non-listable choice behind it, so it
  // gets a screen of its own instead of two buttons where the second one did nothing.
  if (decision.kind === 'allocateDefence')
    return allocatePlan(answer, decision, `${LABEL[decision.who]} decides · ${decisionLabel(decision.kind)}`, ui, setUi);

  const options = decision.options;
  // One obvious default: the engine marks it `auto`/`keep` where the rules have one.
  const preferred = options.find((o) => (o.id === 'auto' || o.id === 'keep') && !o.disabled) ?? options.find((o) => !o.disabled);

  return {
    id: `decision.${decision.kind}`,
    step: `${LABEL[decision.who]} decides · ${decisionLabel(decision.kind)}`,
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
        ? [
            {
              id: 'pass',
              label: 'Pass',
              tone: 'quiet' as const,
              onClick: () => {
                store.dispatch({ t: 'PassDecision', decisionId: decision.id });
                if (ui.handedOverTo !== undefined) setUi({ handedOverTo: undefined });
              },
            },
          ]
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
        {/* Shown, not hidden behind a disclosure labelled "Rule text" — which read as a
            placeholder someone forgot to fill in. On a screen asking for a secret,
            irreversible choice this is the only explanatory content there is. */}
        {decision.sourceText && <p class="rule-text printed">{decision.sourceText}</p>}
      </>
    ),
  };
}
