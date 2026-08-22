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
import { availableActions } from '../../core/actions.ts';
import { moveBudget, moveOptionsFor, reachableCells, validateMove, type MoveAction } from '../../core/movement.ts';
import { validTargets } from '../../core/sequences/shoot.ts';
import { aplOf, card, enemiesInControlRange, isInjured, weaponsOf } from '../../core/state.ts';
import { counteractCandidates, gambitOptions, whoActivates } from '../../core/phases.ts';
import { otherPlayer, type OperativeState, type PlayerId, type Vec2 } from '../../core/types.ts';
import type { Store } from '../store.ts';
import { IconCheck, IconConceal, IconEngage, IconMelee, IconMove, IconTarget, IconUndo } from '../icons.tsx';
import type { CommandAction, CommandPlan, UiState } from './types.ts';
import { rectAround } from './types.ts';

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
    return advance(
      'Initiative step',
      'Roll off for initiative, then play or pass initiative cards until both players have passed.',
    );
  }
  if (step === 'ready') {
    return advance(
      'Ready step',
      'Every operative is readied and gains a command point. From the second turning point the player without initiative gains two.',
    );
  }

  // Gambit: alternating, so only the player to act is offered anything.
  const toAct: PlayerId = state.teams.p1.passedGambit ? 'p2' : (state.initiative ?? 'p1');
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
      frame: null,
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
      frame: null,
      detent: candidates.length > 0 ? 'half' : 'rest',
      turnOf: turn.player,
      targetIds: candidates.map((o) => o.id),
      armed: { onOperative: (op) => store.dispatch({ t: 'Counteract', player: turn.player, operativeId: op.id }) },
      actions: [
        { id: 'decline', label: 'Decline', tone: candidates.length > 0 ? 'default' : 'primary', onClick: () => store.dispatch({ t: 'DeclineCounteract', player: turn.player }) },
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
    title: `${LABEL[turn.player]} — choose an operative`,
    help: 'Tap one of your ringed operatives on the killzone, or pick it from the list below.',
    frame: null,
    detent: 'rest',
    turnOf: turn.player,
    targetIds: ready.map((o) => o.id),
    armed: { onOperative: (op) => (op.player === turn.player && op.ready ? setUi({ selectedId: op.id }) : undefined) },
    actions: [],
    body: <OperativeList store={store} ops={ready} onPick={(op) => setUi({ selectedId: op.id })} verb="Activate" />,
  };
}

/* -------------------------------------------------- the active operative */

export function activationPlan({ store, ui, setUi }: PlayArgs): CommandPlan {
  const { state, ctx } = store;
  const op = state.operatives[state.activeOperativeId!]!;
  const dc = card(ctx, op);
  const apl = aplOf(ctx, state, op);
  const left = apl - op.apSpent;

  // --- a move being aimed -------------------------------------------------
  if (ui.move) return movePlan({ store, ui, setUi }, op, ui.move.action);

  // --- a shot being aimed -------------------------------------------------
  const ranged = weaponsOf(ctx, state, op, 'ranged');
  const melee = weaponsOf(ctx, state, op, 'melee');
  const engaged = enemiesInControlRange(ctx, state, op);
  const actions = availableActions(ctx, state, op);

  if (ui.weaponName) return shootPlan({ store, ui, setUi }, op, ui.weaponName);

  const perform = (action: string, params?: Record<string, unknown>) => {
    store.dispatch({ t: 'PerformAction', operativeId: op.id, action, params: params as never });
  };

  const rows: CommandAction[] = actions
    .filter((a) => a.def.id !== 'Shoot' && a.def.id !== 'Fight')
    .map(({ def, ap, ok, reason }) => ({
      id: def.id,
      label: `${def.name} · ${ap}AP`,
      disabled: !ok,
      hint: reason ?? def.sourceText,
      icon: isMoveAction(def.id) ? <IconMove size={20} /> : undefined,
      onClick: () => (isMoveAction(def.id) ? setUi({ move: { action: def.id } }) : perform(def.id)),
    }));

  const shootRow = actions.find((a) => a.def.id === 'Shoot');
  const fightRow = actions.find((a) => a.def.id === 'Fight');

  return {
    id: 'firefight.act',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`,
    title: `${op.letter} — ${dc.name}`,
    help: `${left} of ${apl} AP left. Choose an action; a move or a shot is then aimed on the killzone.`,
    frame: rectAround(op, 10),
    detent: 'half',
    turnOf: op.player,
    selectedId: op.id,
    actions: [
      {
        id: 'end',
        label: left > 0 ? `End activation (${left}AP unspent)` : 'End activation',
        tone: 'primary',
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
          <ApPips spent={op.apSpent} total={apl} />
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
          {rows.map((a) => (
            <button key={a.id} disabled={a.disabled} title={a.hint} onClick={a.onClick}>
              {a.icon}
              <span style={{ flex: 1, textAlign: 'left' }}>{a.label}</span>
            </button>
          ))}
        </div>

        <Datacard store={store} op={op} />
      </>
    ),
  };
}

/* ------------------------------------------------------------ aiming a move */

function movePlan({ store, ui, setUi }: PlayArgs, op: OperativeState, action: MoveAction): CommandPlan {
  const { state, ctx } = store;
  const dc = card(ctx, op);
  const opts = moveOptionsFor(action);
  const budget = moveBudget(ctx, state, op, opts);
  const points = ui.move?.dest ? [ui.move.dest] : [];
  const path = { points };
  const check = points.length > 0 ? validateMove(ctx, state, op, path, opts) : null;

  const cells = reachableCells(ctx, state, op, budget, 0.5);
  const cancel = () => setUi({ move: undefined });

  return {
    id: 'firefight.move',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`,
    title: `${action} ${op.letter}`,
    help: `Up to ${budget.toFixed(0)}". Tap where ${op.letter} should end up; drag to adjust, two fingers to pan. The shaded area is everywhere it can legally reach.`,
    armedNote: check
      ? check.ok
        ? `${check.total.toFixed(1)}" of ${budget.toFixed(0)}"`
        : (check.reason ?? 'that move is not legal')
      : 'Tap the killzone to choose a destination',
    frame: rectAround(op, Math.max(8, budget + 3)),
    detent: 'rest',
    turnOf: op.player,
    selectedId: op.id,
    armed: {
      base: dc.base,
      rotDeg: op.rot,
      legal: (world: Vec2) => {
        const v = validateMove(ctx, state, op, { points: [world] }, opts);
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
          <line
            x1={op.pos.x}
            y1={op.pos.y}
            x2={ui.move.dest.x}
            y2={ui.move.dest.y}
            stroke={check?.ok ? '#62d08a' : '#ff6b5c'}
            stroke-width={0.08}
            stroke-dasharray="0.3 0.2"
          />
        )}
      </g>
    ),
    actions: [
      {
        id: 'confirm-move',
        label: check?.ok ? `${action} ${check.total.toFixed(1)}"` : action,
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
            <IconCheck size={16} /> {check.total.toFixed(1)}" of {budget.toFixed(0)}" — {check.legs.length} leg
            {check.legs.length === 1 ? '' : 's'}
          </p>
        )}
      </div>
    ),
  };
}

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
  const chosen = targets.find((t) => t.target.id === ui.inspect?.to);

  return {
    id: 'firefight.shoot',
    step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`,
    title: chosen ? `Shoot ${chosen.target.letter}` : 'Pick a target',
    help: chosen
      ? `${chosen.check.distance.toFixed(1)}" · ${chosen.check.obscured ? 'obscured' : chosen.check.inCover ? 'in cover' : 'no cover'}`
      : 'Tap an outlined enemy on the killzone, or pick one from the list.',
    frame: rectAround(op, 14),
    detent: 'rest',
    turnOf: op.player,
    selectedId: op.id,
    targetIds: targets.map((t) => t.target.id),
    armed: {
      onOperative: (t) => (targets.some((v) => v.target.id === t.id) ? setUi({ inspect: { from: op.id, to: t.id } }) : undefined),
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
          setUi({ weaponName: undefined, inspect: undefined });
        },
      },
      { id: 'cancel-shoot', label: 'Cancel', tone: 'quiet', onClick: () => setUi({ weaponName: undefined, inspect: undefined }) },
    ],
    body: (
      <div class="actions">
        <p class="section-title">Targets</p>
        {targets.length === 0 && <p class="dim">Nothing is visible to this weapon.</p>}
        {targets.map(({ target, check }) => (
          <button
            key={target.id}
            aria-pressed={target.id === chosen?.target.id}
            onClick={() => setUi({ inspect: { from: op.id, to: target.id } })}
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

export function endOfTpPlan({ store }: PlayArgs): CommandPlan {
  const { state } = store;
  return {
    id: 'endOfTP',
    step: `Turning point ${state.turningPoint}`,
    title: 'End of the turning point',
    help: 'Victory points are scored, then the next turning point begins.',
    frame: null,
    detent: 'rest',
    actions: [{ id: 'advance', label: 'Next turning point', tone: 'primary', onClick: () => store.dispatch({ t: 'AdvancePhase' }) }],
  };
}

export function battleEndPlan({ store }: PlayArgs): CommandPlan {
  const { state } = store;
  const winner = state.winner;
  return {
    id: 'battleEnd',
    step: 'Battle over',
    title:
      winner === 'draw' ? 'A draw' : winner ? `${LABEL[winner]} wins` : 'The battle has ended',
    help: `P1 ${state.teams.p1.vp}VP · P2 ${state.teams.p2.vp}VP`,
    frame: null,
    detent: 'half',
    actions: [],
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
