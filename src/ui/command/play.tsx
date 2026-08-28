/**
 * The turn loop: strategy phase, activations, actions, and the two things the old build
 * could not do at all.
 *
 * 1. **You can move.** `PerformAction` needs a `MovePath`, and the old action sheet
 *    dispatched Reposition/Dash/Charge with no params, so every move was rejected — the app
 *    could not play a game of Kill Team. Here a move is aimed on the board: the reachable
 *    area is shaded from the engine's own flood fill, each tap adds a waypoint, the running
 *    distance is measured against the operative's budget, and the path is validated with the
 *    same `validateMove` the reducer will run before a single AP is spent.
 * 2. **Shooting tells you what you are about to do.** Picking a target shows cover,
 *    obscured, Vantage and the distance before you commit the AP, rather than a row of
 *    single-letter buttons.
 *
 * Nothing here decides a rule. Legality comes from `availableActions`, `validTargets`,
 * `reachableCells` and `validateMove`; the answers are only ever *rendered* here.
 */
import { actionAvailability, actionTargetOptions, getAction } from '../../core/actions.ts';
import type { ActionParams } from '../../core/intents.ts';
import {
  moveBudget,
  moveOptionsFor,
  reachableCells,
  routePath,
  validateMove,
  type MoveAction,
  type MoveValidation,
  type ReachCell,
} from '../../core/movement.ts';
import type { MovePath } from '../../core/intents.ts';
import { validTargets } from '../../core/sequences/shoot.ts';
import { basePerimeter } from '../../core/geometry.ts';
import { aliveOperatives, apBudgetOf, aplOf, card, enemiesInControlRange, isInjured, weaponsOf } from '../../core/state.ts';
import { counteractCandidates, gambitOptions, gambitToAct, whoActivates } from '../../core/phases.ts';
import { otherPlayer, type OperativeState, type PlayerId, type Vec2 } from '../../core/types.ts';
import { createBattle } from '../../core/init.ts';
import { defaultCritOpId } from '../data.ts';
import type { Store } from '../store.ts';
import { IconCheck, IconConceal, IconDice, IconEngage, IconMelee, IconMove, IconTarget, IconUndo } from '../icons.tsx';
import type { CommandPlan, UiState, WorldRect } from './types.ts';
import { rectAround, rectOfPolys } from './types.ts';

const LABEL: Record<PlayerId, string> = { p1: 'Player 1', p2: 'Player 2' };
const MOVE_ACTIONS: readonly MoveAction[] = ['Reposition', 'Dash', 'Fall Back', 'Charge'];
const isMoveAction = (id: string): id is MoveAction => (MOVE_ACTIONS as readonly string[]).includes(id);

export interface PlayArgs {
  store: Store;
  ui: UiState;
  setUi: (next: Partial<UiState>) => void;
}

/* ------------------------------------------------------------- strategy */

export function strategyPlan({ store }: PlayArgs): CommandPlan {
  const { state, ctx } = store;
  const step = state.strategyStep ?? 'initiative';
  const advance = (label: string, help: string): CommandPlan => ({
    id: `strategy.${step}`,
    step: `Turning point ${state.turningPoint} · Strategy`,
    title: label,
    help,
    frame: null,
    detent: 'rest',
    actions: [{ id: 'advance', label: 'Continue', tone: 'primary', onClick: () => store.dispatch({ t: 'AdvancePhase' }) }],
  });

  if (step === 'initiative') {
    // Roll off, for real. `AdvancePhase` just steps to `ready`: it never calls `RollOff`, so
    // initiative never changed hands after setup and `ctx.beginInitiative` — the whole
    // initiative-card window, including the Re-roll card granted during setup — never opened.
    const rolled = state.rolls.some((r) => r.kind === 'initiative' && r.note === `TP${state.turningPoint}`);
    return {
      id: 'strategy.initiative',
      step: `Turning point ${state.turningPoint} · Strategy`,
      title: rolled ? `${LABEL[state.initiative ?? 'p1']} has initiative` : 'Roll off for initiative',
      help: 'Roll off for initiative, then play or pass initiative cards until both players have passed.',
      frame: null,
      detent: 'rest',
      turnOf: state.initiative,
      actions: [
        rolled
          ? { id: 'advance', label: 'Continue', tone: 'primary', onClick: () => store.dispatch({ t: 'AdvancePhase' }) }
          : {
              id: 'roll',
              label: 'Roll off',
              tone: 'primary',
              icon: <IconDice size={20} />,
              onClick: () => store.dispatch({ t: 'RollOff', kind: 'initiative' }),
            },
      ],
    };
  }
  if (step === 'ready') {
    return advance(
      'Ready step',
      'Every operative is readied and gains a command point. From the second turning point the player without initiative gains two.',
    );
  }

  // Gambit: alternating, so only the player to act is offered anything. `gambitToAct` is the
  // core selector that quotes the printed rule — deriving it here got it wrong whenever
  // Player 2 held initiative, and the strategy phase then never ended.
  const toAct: PlayerId = gambitToAct(state) ?? state.initiative ?? 'p1';
  const options = gambitOptions(ctx, state, toAct);
  return {
    id: 'strategy.gambit',
    step: `Turning point ${state.turningPoint} · Strategy`,
    title: `${LABEL[toAct]} — strategic gambit`,
    help: 'Starting with the player who has initiative, alternate using a STRATEGIC GAMBIT or passing until both have passed in succession.',
    frame: null,
    detent: options.length > 0 ? 'half' : 'rest',
    turnOf: toAct,
    actions: [
      { id: 'pass', label: 'Pass', tone: options.length > 0 ? 'default' : 'primary', onClick: () => store.dispatch({ t: 'PassGambit', player: toAct }) },
    ],
    body:
      options.length > 0 ? (
        <div class="actions">
          <p class="section-title">Available gambits</p>
          {options.map((o: { id: string; name?: string; label?: string; cp?: number }) => (
            <button key={o.id} onClick={() => store.dispatch({ t: 'UseGambit', player: toAct, gambitId: o.id })}>
              {o.name ?? o.label ?? o.id}
              {typeof o.cp === 'number' && o.cp > 0 ? ` · ${o.cp}CP` : ''}
            </button>
          ))}
        </div>
      ) : (
        <p class="dim">No gambit is available to {LABEL[toAct]} this turning point.</p>
      ),
  };
}

/* ------------------------------------------------- choosing an operative */

export function activateChoicePlan({ store, ui, setUi }: PlayArgs): CommandPlan {
  const { state, ctx } = store;
  const turn = whoActivates(state, ctx);

  if (!turn) {
    return {
      id: 'firefight.expended',
      step: `Turning point ${state.turningPoint} · Firefight`,
      title: 'Every operative is expended',
      help: 'The turning point ends: score, then ready up for the next one.',
      frame: 'fit',
      detent: 'rest',
      actions: [{ id: 'advance', label: 'End the turning point', tone: 'primary', onClick: () => store.dispatch({ t: 'AdvancePhase' }) }],
    };
  }

  if (turn.mode === 'counteract') {
    const candidates = counteractCandidates(ctx, state, turn.player);
    return {
      id: 'firefight.counteract',
      step: `Turning point ${state.turningPoint} · Firefight`,
      title: `${LABEL[turn.player]} may counteract`,
      help: 'One free 1AP action (excluding Guard), moving no more than 2". Counteracting is not an activation, so action restrictions do not apply.',
      detent: candidates.length > 0 ? 'half' : 'rest',
      turnOf: turn.player,
      frame: framing(candidates),
      targetIds: candidates.map((o) => o.id),
      armed: {
        // Filter to the eligible list. Without it, tapping an enemy dispatched a Counteract
        // for it and produced a toast for a tap that should simply be inert.
        onOperative: (op) =>
          candidates.some((c) => c.id === op.id)
            ? store.dispatch({ t: 'Counteract', player: turn.player, operativeId: op.id })
            : undefined,
      },
      actions: [
        {
          id: 'decline',
          // "Not now" is the truth again: declining used to mark every one of that player's
          // operatives as having counteracted, forfeiting the rest of the turning point, and
          // this label was written around that. It declines this window only.
          label: 'Not now',
          tone: candidates.length > 0 ? 'quiet' : 'primary',
          onClick: () => store.dispatch({ t: 'DeclineCounteract', player: turn.player }),
        },
      ],
      body: <OperativeList store={store} ops={candidates} onPick={(op) => store.dispatch({ t: 'Counteract', player: turn.player, operativeId: op.id })} verb="Counteract" />,
    };
  }

  const ready = Object.values(state.operatives).filter((o) => o.player === turn.player && o.ready && !o.removed);
  const selected = ui.selectedId ? state.operatives[ui.selectedId] : undefined;
  const chosen = selected && selected.player === turn.player && selected.ready ? selected : undefined;

  if (chosen) {
    const dc = card(ctx, chosen);
    const activate = (order: 'engage' | 'conceal') => {
      store.dispatch({ t: 'ActivateOperative', player: turn.player, operativeId: chosen.id, order });
      setUi({ selectedId: undefined });
    };
    return {
      id: 'firefight.order',
      step: `Turning point ${state.turningPoint} · Firefight`,
      title: `${chosen.letter} — ${dc.name}`,
      help: 'Choose its order. It keeps that order until it is next activated. Engage can shoot, fight and be shot at; Conceal cannot be shot at while in cover, and cannot shoot.',
      frame: rectAround(chosen, 9),
      detent: 'half',
      turnOf: turn.player,
      selectedId: chosen.id,
      actions: [
        { id: 'engage', label: 'Engage', tone: 'primary', icon: <IconEngage size={20} />, onClick: () => activate('engage') },
        { id: 'conceal', label: 'Conceal', icon: <IconConceal size={20} />, onClick: () => activate('conceal') },
      ],
      body: (
        <>
          <Datacard store={store} op={chosen} />
          <div class="actions" style={{ marginTop: 12 }}>
            <button class="quiet" onClick={() => setUi({ selectedId: undefined })}>
              Choose a different operative
            </button>
          </div>
        </>
      ),
    };
  }

  return {
    id: 'firefight.activate',
    step: `Turning point ${state.turningPoint} · Firefight`,
    title: `${LABEL[turn.player]} activates`,
    help: 'Tap one of your ringed operatives on the killzone, or pick it from the list below.',
    armedNote: `${ready.length} ready · tap one on the killzone or pick it below`,
    // Both teams. You choose who to activate by looking at what the enemy is doing, and
    // framing only your own models put the opponent off screen for the whole battle.
    frame: framing(Object.values(state.operatives).filter((o) => !o.removed && o.pos.x > -50)),
    // `half`, not `rest`: at rest the sheet body is hidden, so this screen showed a single
    // line — "Player 1 activates" — and nothing to act on, every activation, all game.
    detent: 'half',
    turnOf: turn.player,
    targetIds: ready.map((o) => o.id),
    armed: { onOperative: (op) => (op.player === turn.player && op.ready ? setUi({ selectedId: op.id }) : undefined) },
    actions: [],
    body: <OperativeList store={store} ops={ready} onPick={(op) => setUi({ selectedId: op.id })} verb="Activate" />,
  };
}

/* ------------------------------------------------------- On Guard window */

/**
 * On Guard is NOT a `PendingDecision`: `offerGuardInterrupt` writes
 * `state.opState.guardOffer` and the reducer does not block on it. So the UI is the only
 * thing that enforces the window — which means it has to render it, and render nothing else
 * while it is open, or the active player simply walks past their opponent's interrupt.
 *
 * It is only ever raised on a Close Quarters killzone (Gallowdark / Tomb World, D-002).
 */
export interface GuardOffer {
  player: PlayerId;
  operativeIds: string[];
}

export function guardOffer(store: Store): GuardOffer | null {
  const raw = store.state.opState['guardOffer'] as GuardOffer | undefined;
  return raw && Array.isArray(raw.operativeIds) && raw.operativeIds.length > 0 ? raw : null;
}

export function guardInterruptPlan({ store, ui, setUi }: PlayArgs, offer: GuardOffer): CommandPlan {
  const { state, ctx } = store;
  const candidates = offer.operativeIds.map((id) => state.operatives[id]).filter((o): o is OperativeState => Boolean(o));
  const chosen = ui.selectedId ? candidates.find((o) => o.id === ui.selectedId) : undefined;
  // Closing the window hands the phone back: `handedOverTo` is the interrupting player only
  // for as long as the interrupt is open.
  const closeWindow = () => setUi({ selectedId: undefined, weaponName: undefined, handedOverTo: undefined });
  const decline = () => {
    store.dispatch({ t: 'DeclineInterrupt', player: offer.player });
    closeWindow();
  };
  const interrupt = (params: ActionParams, action: 'Shoot' | 'Fight') => {
    store.dispatch({ t: 'OnGuardInterrupt', player: offer.player, operativeId: chosen!.id, action, params });
    closeWindow();
  };

  if (chosen) {
    const ranged = weaponsOf(ctx, state, chosen, 'ranged');
    const melee = weaponsOf(ctx, state, chosen, 'melee');
    const engaged = enemiesInControlRange(ctx, state, chosen);
    const weapon = ui.weaponName ?? ranged[0]?.name;
    const targets = weapon ? validTargets(ctx, state, chosen, weapon) : [];
    return {
      id: 'firefight.guardInterrupt.target',
      step: `Turning point ${state.turningPoint} · On Guard`,
      title: `${chosen.letter} interrupts`,
      help: 'Select one friendly operative on guard to perform the Fight or Shoot action for free.',
      frame: rectAround(chosen, 12),
      detent: 'half',
      modal: true,
      turnOf: offer.player,
      selectedId: chosen.id,
      targetIds: [...targets.map((t) => t.target.id), ...engaged.map((e) => e.id)],
      actions: [
        { id: 'back', label: 'Choose a different operative', tone: 'quiet', onClick: () => setUi({ selectedId: undefined }) },
      ],
      body: (
        <>
          {weapon && targets.length > 0 && (
            <div class="actions">
              <p class="section-title">Shoot · {weapon}</p>
              {targets.map(({ target, check }) => (
                <button
                  key={target.id}
                  onClick={() => interrupt({ weaponName: weapon, targetId: target.id }, 'Shoot')}
                >
                  <IconTarget size={20} />
                  <span style={{ flex: 1, textAlign: 'left' }}>
                    {target.letter} — {card(ctx, target).name}
                  </span>
                  <span class="tag">{check.distance.toFixed(1)}"</span>
                </button>
              ))}
            </div>
          )}
          {melee.length > 0 && engaged.length > 0 && (
            <div class="actions">
              <p class="section-title">Fight</p>
              {engaged.map((e) => (
                <button
                  key={e.id}
                  onClick={() => interrupt({ meleeWeaponName: melee[0]!.name, targetId: e.id }, 'Fight')}
                >
                  <IconMelee size={20} />
                  <span style={{ flex: 1, textAlign: 'left' }}>
                    {e.letter} — {card(ctx, e).name}
                  </span>
                </button>
              ))}
            </div>
          )}
          {targets.length === 0 && engaged.length === 0 && (
            <p class="dim">{chosen.letter} has nothing it can shoot or fight from here.</p>
          )}
        </>
      ),
    };
  }

  return {
    id: 'firefight.guardInterrupt',
    step: `Turning point ${state.turningPoint} · On Guard`,
    title: `${LABEL[offer.player]} may interrupt`,
    help: 'Once during each enemy operative\u2019s activation, after that enemy performs an action, you can interrupt and select one friendly operative on guard to Shoot or Fight for free.',
    frame: null,
    detent: 'half',
    modal: true,
    turnOf: offer.player,
    targetIds: candidates.map((o) => o.id),
    armed: { onOperative: (op) => (candidates.some((c) => c.id === op.id) ? setUi({ selectedId: op.id }) : undefined) },
    actions: [{ id: 'decline-interrupt', label: 'Do not interrupt', tone: 'quiet', onClick: decline }],
    body: <OperativeList store={store} ops={candidates} onPick={(op) => setUi({ selectedId: op.id })} verb="Interrupt with" />,
  };
}

/* -------------------------------------------------- the active operative */

export function activationPlan({ store, ui, setUi }: PlayArgs): CommandPlan {
  const { state, ctx } = store;
  const op = state.operatives[state.activeOperativeId!]!;
  const dc = card(ctx, op);
  // The activation's AP budget, not the APL stat: a granted free action adds AP without
  // being an APL stat change (D-100). `Datacard` below still shows the STAT.
  const apl = apBudgetOf(ctx, state, op);
  const left = apl - op.apSpent;
  /**
   * A counteract is not an activation: the operative gets ONE free 1AP action other than
   * Guard, may move no more than 2", and action restrictions do not apply. Rendering the
   * normal activation sheet here lies about all three.
   */
  const counteracting = (state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId === op.id;

  // --- a move being aimed -------------------------------------------------
  if (ui.move) return movePlan({ store, ui, setUi }, op, ui.move.action);
  if (ui.aimAction) return aimPlan({ store, ui, setUi }, op, ui.aimAction);

  // --- a shot being aimed -------------------------------------------------
  const ranged = weaponsOf(ctx, state, op, 'ranged');
  const melee = weaponsOf(ctx, state, op, 'melee');
  const engaged = enemiesInControlRange(ctx, state, op);
  const actions = actionAvailability(ctx, state, op);

  if (ui.weaponName) return shootPlan({ store, ui, setUi }, op, ui.weaponName);

  const perform = (action: string, params?: Record<string, unknown>) => {
    store.dispatch({ t: 'PerformAction', operativeId: op.id, action, params: params as never });
  };

  const rows = actions
    .filter((a) => a.def.id !== 'Shoot' && a.def.id !== 'Fight')
    // "One free 1AP action, excluding Guard" — offering the rest would be offering rejections.
    .filter((a) => !counteracting || (a.ap === 1 && a.def.id !== 'Guard'));

  const shootRow = actions.find((a) => a.def.id === 'Shoot');
  const fightRow = actions.find((a) => a.def.id === 'Fight');

  return {
    id: counteracting ? 'firefight.counteracting' : 'firefight.act',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}${counteracting ? ' · Counteract' : ''}`,
    title: `${op.letter} — ${dc.name}`,
    help: counteracting
      ? 'Counteracting: one free 1AP action other than Guard, moving no more than 2". It is not an activation, so action restrictions do not apply.'
      : `${left} of ${apl} AP left. Choose an action; a move or a shot is then aimed on the killzone.`,
    frame: rectAround(op, 10),
    detent: 'half',
    turnOf: op.player,
    selectedId: op.id,
    actions: [
      {
        id: 'end',
        label: counteracting ? 'End counteract' : left > 0 ? `End activation — ${left}AP unspent` : 'End activation',
        // Quiet while AP remain: ending an activation cannot be undone (it is the point at
        // which the opponent activates), and it sits directly under a scrolling action list
        // where a mis-flick would land on it. It only becomes the obvious next tap once
        // there is genuinely nothing left to spend.
        tone: counteracting || left === 0 ? 'primary' : 'quiet',
        icon: <IconCheck size={20} />,
        onClick: () => {
          store.dispatch({ t: 'EndActivation', operativeId: op.id });
          setUi({ selectedId: undefined, move: undefined, weaponName: undefined });
        },
      },
    ],
    body: (
      <>
        <div class="row" style={{ marginBottom: 12 }}>
          {counteracting ? <span class="tag is-warn">free action</span> : <ApPips spent={op.apSpent} total={apl} />}
          <span class="tag">
            {op.wounds}/{dc.wounds} wounds
          </span>
          <span class="tag">{op.order === 'engage' ? 'Engage' : 'Conceal'}</span>
          {isInjured(ctx, op) && <span class="tag is-danger">injured</span>}
          {op.onGuard && <span class="tag is-warn">on Guard</span>}
          {engaged.length > 0 && <span class="tag is-warn">engaged ×{engaged.length}</span>}
        </div>

        {ranged.length > 0 && shootRow && (
          <div class="actions">
            <p class="section-title">Shoot</p>
            {ranged.map((w) => {
              const targets = validTargets(ctx, state, op, w.name);
              const blocked = !shootRow.ok || targets.length === 0;
              return (
                <button
                  key={w.name}
                  disabled={blocked}
                  title={shootRow.reason ?? (targets.length === 0 ? 'no valid targets' : undefined)}
                  onClick={() => setUi({ weaponName: w.name })}
                >
                  <IconTarget size={20} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{w.name}</span>
                  <span class="tag">{targets.length} target{targets.length === 1 ? '' : 's'}</span>
                </button>
              );
            })}
          </div>
        )}

        {melee.length > 0 && fightRow && engaged.length > 0 && (
          <div class="actions">
            <p class="section-title">Fight</p>
            {engaged.map((e) => (
              <button
                key={e.id}
                disabled={!fightRow.ok}
                title={fightRow.reason}
                onClick={() => perform('Fight', { meleeWeaponName: melee[0]!.name, targetId: e.id })}
              >
                <IconMelee size={20} />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {e.letter} — {card(ctx, e).name}
                </span>
              </button>
            ))}
          </div>
        )}

        <div class="actions">
          <p class="section-title">Actions</p>
          {rows.map(({ def, ap, ok, reason, needsTarget }) => (
            // An illegal action is NOT `disabled` + `title`: `title` does not exist on a
            // touch screen, so the reason is rendered in the row where a thumb can read it.
            <button
              key={def.id}
              class={ok ? undefined : 'is-blocked'}
              disabled={!ok}
              onClick={() => {
                if (isMoveAction(def.id)) return setUi({ move: { action: def.id } });
                // A mission action has to be told WHICH marker. One legal option needs no
                // screen; more than one is a real choice and gets the aim list.
                if (needsTarget && AIMED_KINDS.has(needsTarget)) {
                  const opts = actionTargetOptions(ctx, state, op, def);
                  if (opts.length === 1) return perform(def.id, opts[0]!.params as Record<string, unknown>);
                  return setUi({ aimAction: def.id });
                }
                return perform(def.id);
              }}
            >
              {isMoveAction(def.id) ? <IconMove size={20} /> : null}
              <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                <span class="entry-name">
                  {def.name} · {ap}AP
                </span>
                {!ok && reason && <span class="entry-meta why">{reason}</span>}
              </span>
            </button>
          ))}
        </div>

        <PloyList store={store} player={op.player} />

        <Datacard store={store} op={op} />
      </>
    ),
  };
}

/**
 * Firefight ploys. `UsePloy` is fully implemented in the reducer and every team module
 * registers four of them, and nothing in the UI offered a single one — so command points had
 * almost nothing to spend on for a whole battle.
 */
function PloyList({ store, player }: { store: Store; player: PlayerId }) {
  const { state, ctx } = store;
  const team = state.teams[player];
  const ploys = (ctx.teams.get(team.teamId)?.ploys ?? []).filter((p) => p.kind === 'firefight');
  if (ploys.length === 0) return null;
  return (
    <div class="actions">
      <p class="section-title">Firefight ploys · {team.cp} CP</p>
      {ploys.map((ply) => {
        const used = team.ploysUsedTP.includes(ply.id);
        const usable = ply.usable?.(state, player);
        const ok = !used && team.cp >= ply.cp && (usable?.ok ?? true);
        const why = used
          ? 'already used this turning point'
          : team.cp < ply.cp
            ? `needs ${ply.cp}CP, you have ${team.cp}`
            : (usable?.reason ?? '');
        return (
          <button
            key={ply.id}
            class={ok ? undefined : 'is-blocked'}
            disabled={!ok}
            onClick={() => store.dispatch({ t: 'UsePloy', player, ployId: ply.id })}
          >
            <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
              <span class="entry-name">
                {ply.name} · {ply.cp}CP
              </span>
              <span class={`entry-meta${ok ? '' : ' why'}`}>{ok ? ply.text : why}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ aiming a move */

/**
 * Actions the sheet cannot dispatch bare, because the reducer needs a marker or access point.
 *
 * Read from the core's own `actionAvailability`, never from a list kept here: which actions are
 * parameterised is a rules fact, and CLAUDE.md forbids the UI re-implementing a core selector.
 */
const AIMED_KINDS = new Set(['marker', 'markerChoice', 'part']);

function aimPlan({ store, ui, setUi }: PlayArgs, op: OperativeState, actionId: string): CommandPlan {
  const { state, ctx } = store;
  const def = getAction(actionId);
  const opts = def ? actionTargetOptions(ctx, state, op, def) : [];
  const cancel = () => setUi({ aimAction: undefined });
  return {
    id: 'firefight.aim',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`,
    title: `${def?.name ?? actionId} — choose a target`,
    help: def?.sourceText,
    frame: rectAround(op, 10),
    detent: 'half',
    turnOf: op.player,
    selectedId: op.id,
    actions: [{ id: 'cancel', label: 'Back', onClick: cancel }],
    body: (
      <div class="actions">
        {opts.length === 0 && <p class="entry-meta why">No legal target for this action right now.</p>}
        {opts.map((o) => (
          <button
            key={o.id || 'bare'}
            onClick={() => {
              store.dispatch({
                t: 'PerformAction',
                operativeId: op.id,
                action: actionId,
                params: o.params as never,
              });
              cancel();
            }}
          >
            <span style={{ flex: 1, textAlign: 'left' }}>{o.label}</span>
          </button>
        ))}
      </div>
    ),
  };
}

function movePlan({ store, ui, setUi }: PlayArgs, op: OperativeState, action: MoveAction): CommandPlan {
  const { state, ctx } = store;
  const dc = card(ctx, op);
  // "Counteracting: ... it cannot move more than 2\"." The reducer applies that cap via
  // `withCounteractCap`; without it here the preview shaded a full 6" of reachable board,
  // drew the ghost green at 5", and the dispatch was then refused.
  const counteracting = (state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId === op.id;
  const opts = moveOptionsFor(action, counteracting ? 2 : undefined);
  const budget = moveBudget(ctx, state, op, opts);

  const cells = reachableCells(ctx, state, op, budget, 0.5);

  /**
   * The path the operative would actually walk to reach `dest`.
   *
   * A single straight increment is preferred — it is the cheapest, because "increments are
   * always rounded up to the nearest inch" and one increment rounds up once. When the straight
   * line would cut through terrain the operative cannot move through, the route the engine's
   * own flood fill took to get there is used instead, so tapping a spot behind a wall walks
   * round the wall rather than being refused.
   */
  const planTo = (dest: Vec2): { path: MovePath; check: MoveValidation } => {
    const direct: MovePath = { points: [dest] };
    const straight = validateMove(ctx, state, op, direct, opts);
    if (straight.ok) return { path: direct, check: straight };
    let best: ReachCell | undefined;
    let bestD = Infinity;
    for (const cell of cells.values()) {
      const d = Math.hypot(cell.pos.x - dest.x, cell.pos.y - dest.y);
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (!best || bestD > 0.5) return { path: direct, check: straight };
    const routed = routePath(ctx, state, op, cells, best);
    if (!routed || routed.points.length < 2) return { path: direct, check: straight };
    const points = [...routed.points];
    points[points.length - 1] = { ...dest };
    const viaRoute: MovePath = { points, ...(routed.zs ? { zs: routed.zs } : {}) };
    const routedCheck = validateMove(ctx, state, op, viaRoute, opts);
    return routedCheck.ok ? { path: viaRoute, check: routedCheck } : { path: direct, check: straight };
  };

  const plan = ui.move?.dest ? planTo(ui.move.dest) : null;
  const path: MovePath = plan?.path ?? { points: [] };
  const check = plan?.check ?? null;
  const cancel = () => setUi({ move: undefined });

  return {
    id: 'firefight.move',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`,
    title: `${action} ${op.letter}`,
    help: `Up to ${budget.toFixed(0)}". Tap where ${op.letter} should end up; drag to adjust, two fingers to pan. The shading is roughly what is in range — the ghost turns red wherever it cannot actually finish.`,
    // `validateMove.total` is the CHARGED distance: every leg is rounded up to the inch, so it
    // is always a whole number. Showing only that reads as a bug ("I moved 4.2 and it says
    // 5"), so both numbers are shown and labelled.
    armedNote: check
      ? check.ok
        ? `${rawInches(check).toFixed(1)}" — costs ${check.total} of ${budget.toFixed(0)}"`
        : (check.reason ?? 'that move is not legal')
      : 'Tap the killzone to choose a destination',
    ...(check && !check.ok ? { armedTone: 'blocked' as const } : {}),
    frame: rectAround(op, Math.max(8, budget + 3)),
    detent: 'rest',
    turnOf: op.player,
    selectedId: op.id,
    armed: {
      base: dc.base,
      rotDeg: op.rot,
      legal: (world: Vec2) => {
        const v = planTo(world).check;
        return v.ok ? { ok: true } : { ok: false, ...(v.reason ? { reason: v.reason } : {}) };
      },
      commit: (world: Vec2) => setUi({ move: { action, dest: world } }),
    },
    highlights: (
      <g style={{ pointerEvents: 'none' }}>
        {/* The engine's own reachability field, cell by cell. They are drawn a hair larger
            than the 0.5" step so the squares merge into one readable area instead of a
            stipple; the colour comes from `.reach` in the stylesheet. */}
        <g class="reach">
          {[...cells.values()].map((c, i) => (
            <rect key={i} x={c.pos.x - 0.29} y={c.pos.y - 0.29} width={0.58} height={0.58} />
          ))}
        </g>
        {ui.move?.dest && (
          <>
            {/* The whole route, corner by corner — drawing a straight line to a destination
                the operative reaches by walking round a wall would misreport the distance. */}
            <polyline
              points={[op.pos, ...path.points].map((pt) => `${pt.x.toFixed(3)},${pt.y.toFixed(3)}`).join(' ')}
              fill="none"
              stroke={check?.ok ? '#5fd08a' : '#ff7a6b'}
              stroke-width={0.08}
              stroke-dasharray="0.3 0.2"
            />
            {/* The operative's real base where it would end up. A dashed line ending in mid
                air answers neither "where do I end up" nor "how far is that". */}
            <polygon
              points={basePerimeter(ui.move.dest, dc.base, op.rot)
                .map((pt) => `${pt.x.toFixed(3)},${pt.y.toFixed(3)}`)
                .join(' ')}
              fill={check?.ok ? '#5fd08a' : '#ff7a6b'}
              fill-opacity={0.34}
              stroke={check?.ok ? '#5fd08a' : '#ff7a6b'}
              stroke-width={0.07}
            />
          </>
        )}
      </g>
    ),
    actions: [
      {
        id: 'confirm-move',
        label: check?.ok ? `${action} — costs ${check.total}"` : action,
        tone: 'primary',
        disabled: !check?.ok,
        hint: check && !check.ok ? check.reason : 'Choose a destination first',
        icon: <IconMove size={20} />,
        onClick: () => {
          if (!check?.ok) return;
          store.dispatch({ t: 'PerformAction', operativeId: op.id, action, params: { path } });
          setUi({ move: undefined });
        },
      },
      { id: 'cancel-move', label: 'Cancel', tone: 'quiet', icon: <IconUndo size={20} />, onClick: cancel },
    ],
    body: (
      <div class="card">
        <h2>{action}</h2>
        <p class="rule-text">{ruleTextFor(action)}</p>
        {check && !check.ok && <p class="err">{check.reason}</p>}
        {check?.ok && (
          <p class="ok-line">
            <IconCheck size={16} /> {rawInches(check).toFixed(1)}" travelled — charged {check.total} of{' '}
            {budget.toFixed(0)}" (each leg rounds up to the inch)
          </p>
        )}
      </div>
    ),
  };
}

/**
 * A window containing every one of these operatives, with a couple of inches of context.
 * Null for an empty list, which leaves the player's own framing alone.
 */
function framing(ops: readonly OperativeState[]): WorldRect | null {
  const box = rectOfPolys(ops.map((o) => [o.pos]));
  if (!box) return null;
  const pad = 3;
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

/** The geometric distance, as opposed to what the rules charge for it. */
const rawInches = (v: { legs: { raw: number }[] }): number => v.legs.reduce((sum, leg) => sum + leg.raw, 0);

function ruleTextFor(action: MoveAction): string {
  switch (action) {
    case 'Reposition':
      return 'Move the active operative up to its Move stat. It cannot do this while within control range of an enemy operative, or in the same activation as Fall Back or Charge.';
    case 'Dash':
      return 'As Reposition, except up to 3". It cannot climb during this move, but it can drop and jump.';
    case 'Fall Back':
      return 'As Reposition, except it may move within control range of an enemy operative but cannot finish there. It requires an enemy operative within its control range.';
    case 'Charge':
      return 'Move up to its Move stat plus 2", and it must finish within control range of an enemy operative.';
  }
}

/* ----------------------------------------------------------- aiming a shot */

function shootPlan({ store, ui, setUi }: PlayArgs, op: OperativeState, weaponName: string): CommandPlan {
  const { state, ctx } = store;
  const targets = validTargets(ctx, state, op, weaponName);
  // Its OWN field. Reading the line-of-sight inspector's target here meant a model picked to
  // answer "can I see him?" arrived pre-armed as the thing about to be shot.
  const chosen = targets.find((t) => t.target.id === ui.shootTargetId);

  return {
    id: 'firefight.shoot',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`,
    title: chosen ? `Shoot ${chosen.target.letter}` : 'Pick a target',
    help: chosen
      ? `${chosen.check.distance.toFixed(1)}" · ${chosen.check.obscured ? 'obscured' : chosen.check.inCover ? 'in cover' : 'no cover'}`
      : 'Tap an outlined enemy on the killzone, or pick one from the list.',
    // The shooter AND everything it can shoot. A square around the shooter alone put every
    // target off screen — a screen headed "Pick a target", showing no targets, over a board
    // full of your own operatives.
    frame: framing([op, ...targets.map((t) => t.target)]) ?? rectAround(op, 14),
    // `half`, not `rest`. This screen's own help says "or pick one from the list", and at rest
    // the list is not on screen at all — the same trap the activation screen fell into.
    detent: 'half',
    turnOf: op.player,
    selectedId: op.id,
    targetIds: targets.map((t) => t.target.id),
    armed: {
      onOperative: (t) => (targets.some((v) => v.target.id === t.id) ? setUi({ shootTargetId: t.id }) : undefined),
      // A no-op point handler, so a tap on empty board is swallowed by the arm instead of
      // falling through to `onBoardClick` and clearing what the player has already picked.
      commit: () => undefined,
    },
    highlights: chosen ? (
      <line x1={op.pos.x} y1={op.pos.y} x2={chosen.target.pos.x} y2={chosen.target.pos.y} stroke="#ffc94a" stroke-width={0.07} stroke-dasharray="0.4 0.25" style={{ pointerEvents: 'none' }} />
    ) : null,
    actions: [
      {
        id: 'fire',
        label: chosen ? `Fire at ${chosen.target.letter}` : 'Pick a target',
        tone: 'primary',
        disabled: !chosen,
        icon: <IconTarget size={20} />,
        onClick: () => {
          if (!chosen) return;
          store.dispatch({ t: 'PerformAction', operativeId: op.id, action: 'Shoot', params: { weaponName, targetId: chosen.target.id } });
          setUi({ weaponName: undefined, shootTargetId: undefined });
        },
      },
      { id: 'cancel-shoot', label: 'Cancel', tone: 'quiet', onClick: () => setUi({ weaponName: undefined, shootTargetId: undefined }) },
    ],
    body: (
      <div class="actions">
        <p class="section-title">Targets</p>
        {targets.length === 0 && <p class="dim">Nothing is visible to this weapon.</p>}
        {targets.map(({ target, check }) => (
          <button
            key={target.id}
            aria-pressed={target.id === chosen?.target.id}
            onClick={() => setUi({ shootTargetId: target.id })}
          >
            <span style={{ flex: 1, textAlign: 'left' }}>
              {target.letter} — {card(ctx, target).name}
            </span>
            <span class="tag">{check.distance.toFixed(1)}"</span>
            {check.obscured && <span class="tag is-warn">obscured</span>}
            {check.inCover && !check.obscured && <span class="tag">cover</span>}
          </button>
        ))}
      </div>
    ),
  };
}

/* -------------------------------------------------------------- end states */

/**
 * The scoreboard between turning points.
 *
 * Scoring is the entire point of the game and it is the one thing that happens with nobody
 * touching the screen — every op resolves inside `endTurningPoint`. So this screen exists to
 * say what just happened, in the ops' own words, before the board moves on. It reads the
 * log rather than a diff of VP totals so that a 0VP turning point still gets an honest
 * answer ("nothing scored") instead of a blank panel.
 */
export function endOfTpPlan({ store }: PlayArgs): CommandPlan {
  const { state } = store;
  const last = state.turningPoint;
  const scored = state.log.filter((e) => e.kind === 'score' && e.tp === last);
  const forPlayer = (p: PlayerId) => scored.filter((e) => e.player === p);
  const shared = scored.filter((e) => !e.player);

  return {
    id: 'endOfTP',
    step: `Turning point ${last} of ${state.maxTurningPoints || 4}`,
    title:
      scored.length === 0
        ? 'Turning point over — nothing scored'
        : `Turning point over — P1 ${state.teams.p1.vp}VP · P2 ${state.teams.p2.vp}VP`,
    help: 'Victory points are scored at the end of every turning point. Check them, then begin the next one.',
    frame: 'fit',
    detent: 'half',
    actions: [{ id: 'advance', label: `Begin turning point ${last + 1}`, tone: 'primary', onClick: () => store.dispatch({ t: 'AdvancePhase' }) }],
    body: (
      <div>
        {(['p1', 'p2'] as PlayerId[]).map((p) => {
          const mine = forPlayer(p);
          return (
            <div key={p} class="card">
              <h2>{LABEL[p]}</h2>
              <div class="row">
                <span class="tag">{state.teams[p].vp} VP</span>
                <span class="tag">{state.teams[p].cp} CP</span>
                <span class="tag">
                  {aliveOperatives(state, p).length} of {state.teams[p].operativeIds.length} standing
                </span>
              </div>
              {mine.length > 0 ? (
                <ul class="score-list">
                  {mine.map((e) => (
                    <li key={e.seq}>{e.text}</li>
                  ))}
                </ul>
              ) : (
                <p class="dim" style={{ margin: 'var(--s2) 0 0' }}>
                  Nothing scored this turning point.
                </p>
              )}
            </div>
          );
        })}
        {shared.length > 0 && (
          <div class="card">
            <h2>Also this turning point</h2>
            <ul class="score-list">
              {shared.map((e) => (
                <li key={e.seq}>{e.text}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    ),
  };
}

export function battleEndPlan({ store, setUi }: PlayArgs): CommandPlan {
  const { state, ctx } = store;
  const winner = state.winner;
  return {
    id: 'battleEnd',
    step: 'Battle over',
    title:
      winner === 'draw' ? 'A draw' : winner ? `${LABEL[winner]} wins` : 'The battle has ended',
    help: `P1 ${state.teams.p1.vp}VP · P2 ${state.teams.p2.vp}VP`,
    frame: 'fit',
    detent: 'half',
    // Without this the battle's end was terminal: no action, and the only route that starts a
    // battle is disabled once setup is over.
    actions: [
      {
        id: 'new-battle',
        label: 'New battle',
        tone: 'primary',
        onClick: () => {
          store.reset(createBattle(ctx, { map: state.map, seed: state.seed + 1, mode: state.mode, critOpId: defaultCritOpId() }));
          setUi({ selectedId: undefined, placingId: undefined, move: undefined, weaponName: undefined, handedOverTo: undefined });
        },
      },
    ],
    body: (
      <div>
        {(['p1', 'p2'] as PlayerId[]).map((p) => (
          <div key={p} class="card">
            <h2>{LABEL[p]}</h2>
            <div class="row">
              <span class="tag">{state.teams[p].vp} VP</span>
              <span class="tag">{state.teams[p].cp} CP</span>
              <span class="tag">
                {Object.values(state.operatives).filter((o) => o.player === p && !o.removed).length} operatives left
              </span>
            </div>
          </div>
        ))}
      </div>
    ),
  };
}

/* -------------------------------------------------------------- fragments */

export function ApPips({ spent, total }: { spent: number; total: number }) {
  return (
    <span class="ap-pips" role="img" aria-label={`${total - spent} of ${total} action points left`}>
      {Array.from({ length: Math.max(total, spent) }, (_, i) => (
        <i key={i} class={i < spent ? 'spent' : ''} />
      ))}
    </span>
  );
}

function OperativeList({
  store,
  ops,
  onPick,
  verb,
}: {
  store: Store;
  ops: OperativeState[];
  onPick: (op: OperativeState) => void;
  verb: string;
}) {
  const { ctx, state } = store;
  if (ops.length === 0) return <p class="dim">None available.</p>;
  return (
    <div class="actions">
      <p class="section-title">{verb}</p>
      {ops.map((op) => {
        const dc = card(ctx, op);
        return (
          <button key={op.id} onClick={() => onPick(op)}>
            <span class={`letter op-chip-letter ${op.player === 'p2' ? 'is-p2' : ''}`} aria-hidden="true">
              {op.letter}
            </span>
            <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
              <span class="op-name">{dc.name}</span>
            </span>
            <span class="tag">
              {op.wounds}/{dc.wounds}
            </span>
            {enemiesInControlRange(ctx, state, op).length > 0 && <span class="tag is-warn">engaged</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Datacard({ store, op }: { store: Store; op: OperativeState }) {
  const { ctx, state } = store;
  const dc = card(ctx, op);
  const apl = aplOf(ctx, state, op);
  return (
    <div class="card">
      <h2>{dc.name}</h2>
      <div class="statline">
        <div class="stat">
          <span class="k">APL</span>
          <span class="v">{apl}</span>
        </div>
        <div class="stat">
          <span class="k">Move</span>
          <span class="v">{dc.move}"</span>
        </div>
        <div class="stat">
          <span class="k">Save</span>
          <span class="v">{dc.save}+</span>
        </div>
        <div class="stat">
          <span class="k">Wounds</span>
          <span class="v">
            {op.wounds}/{dc.wounds}
          </span>
        </div>
      </div>
      {dc.abilities.length > 0 && (
        <details class="disclosure">
          <summary>Abilities ({dc.abilities.length}) — applied automatically</summary>
          {dc.abilities.map((a) => (
            <p key={a.id} class="rule-text">
              <strong>{a.name}.</strong> {a.text}
            </p>
          ))}
        </details>
      )}
      <details class="disclosure">
        <summary>Weapons ({weaponsOf(ctx, state, op).length})</summary>
        {weaponsOf(ctx, state, op).map((w) => (
          <p key={w.name} class="rule-text">
            <strong>{w.name}.</strong>{' '}
            {w.profiles
              .map((pr) => `${pr.name ? `${pr.name}: ` : ''}${pr.type} A${pr.atk} ${pr.hit}+ ${pr.dmgN}/${pr.dmgC}`)
              .join(' · ')}
          </p>
        ))}
      </details>
    </div>
  );
}

export { otherPlayer };
