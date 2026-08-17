/**
 * Parameterised legal-intent enumeration.
 *
 * `reducer.legalIntents()` lists the SHAPES a player may submit, but emits `PerformAction`
 * without params — a Shoot with no weapon or a Reposition with no path is rejected. The AI's
 * acceptance bar is zero rejected intents, so this module builds fully-parameterised
 * candidates and re-runs the engine's own `check()` (and `validateMove`) on each one before
 * it is ever offered to an agent.
 */
import { actionCost, allActions, availableActions, getAction, type ActionDef } from '../core/actions.ts';
import type { GameContext } from '../core/context.ts';
import { terrain } from '../core/context.ts';
import type { ActionParams, Intent } from '../core/intents.ts';
import { counteractCandidates, gambitOptions, guardInterruptCandidates, whoActivates } from '../core/phases.ts';
import {
  aliveOperatives,
  aplOf,
  card,
  enemiesInControlRange,
  gapBetween,
  markerController,
} from '../core/state.ts';
import type { GameState, OperativeState, PlayerId } from '../core/types.ts';
import { otherPlayer } from '../core/types.ts';
import { fightPlans, fightValue, shotPlans, shotValue } from './combat.ts';
import { cheapPositionScore, positionContext, roleOf, type PositionContext } from './eval.ts';
import { chargeRing, chargeTargets, generateMoves, type MoveAction } from './moves.ts';
import type { Candidate, EvalWeights } from './types.ts';

export interface EnumerateOptions {
  weights: EvalWeights;
  /** Validated destinations kept per movement action. */
  moveLimit?: number;
}

/** Actions the AI never chooses on its own initiative (they have no scoring model yet). */
const SKIP_ACTIONS = new Set<string>([]);

/**
 * Everything `player` can legally do right now, with params filled in.
 * Pending decisions are NOT enumerated here — `decide.ts` owns reactive windows.
 */
export function enumerateCandidates(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  opts: EnumerateOptions,
): Candidate[] {
  const out: Candidate[] = [];

  if (state.pending.length > 0) return out;

  if (state.phase === 'strategy' && state.strategyStep === 'gambit') {
    for (const g of gambitOptions(ctx, state, player)) {
      out.push({
        intent: { t: 'UseGambit', player, gambitId: g.id },
        kind: 'gambit',
        hint: gambitHint(ctx, state, player, g.id),
        label: `gambit ${g.label}`,
      });
    }
    out.push({ intent: { t: 'PassGambit', player }, kind: 'gambit', hint: 0, label: 'pass gambit' });
    return out;
  }

  if (state.phase !== 'firefight') return out;

  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && active.player === player && !active.removed) {
    const counteracting = state.opState['counteract']?.['operativeId'] === active.id;
    out.push(...actionCandidates(ctx, state, active, { counteracting, ...opts }));
    out.push({ intent: { t: 'EndActivation', operativeId: active.id }, kind: 'end', hint: 0, label: 'end activation' });
    out.push(...ployCandidates(ctx, state, player));
    return out;
  }
  if (active && (active.player !== player || active.removed)) {
    // Our own operative died mid-activation: the only sane move is to end it.
    if (active.player === player) {
      out.push({ intent: { t: 'EndActivation', operativeId: active.id }, kind: 'end', hint: 0, label: 'end activation' });
    }
    return out;
  }

  const turn = whoActivates(state);
  if (!turn || turn.player !== player) return out;

  if (turn.mode === 'activate') {
    for (const op of aliveOperatives(state, player).filter((o) => o.ready)) {
      for (const order of ['engage', 'conceal'] as const) {
        out.push({
          intent: { t: 'ActivateOperative', player, operativeId: op.id, order },
          kind: 'activate',
          hint: 0,
          label: `activate ${op.letter} (${order})`,
        });
      }
    }
    out.push(...ployCandidates(ctx, state, player));
    return out;
  }

  for (const op of counteractCandidates(ctx, state, player)) {
    out.push({
      intent: { t: 'Counteract', player, operativeId: op.id },
      kind: 'counteract',
      hint: 0,
      label: `counteract with ${op.letter}`,
    });
  }
  out.push({ intent: { t: 'DeclineCounteract', player }, kind: 'counteract', hint: 0, label: 'decline counteract' });
  return out;
}

export interface ActionOptions extends EnumerateOptions {
  counteracting?: boolean;
}

/**
 * Fully-parameterised actions for the active operative. Every candidate has already passed
 * the engine's `def.check()` with the exact params that will be submitted.
 */
export function actionCandidates(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  opts: ActionOptions,
): Candidate[] {
  const out: Candidate[] = [];
  const counteracting = opts.counteracting ?? false;
  const defs = counteracting ? counteractActionDefs(ctx, state, op) : availableActions(ctx, state, op).filter((a) => a.ok).map((a) => a.def);
  const pc = positionContext(ctx, state, op, opts.weights);
  const moveLimit = opts.moveLimit ?? 6;
  const hardCap = counteracting ? 2 : undefined;

  for (const def of defs) {
    if (SKIP_ACTIONS.has(def.id)) continue;
    switch (def.id) {
      case 'Reposition':
      case 'Dash':
      case 'Fall Back':
      case 'Charge':
        out.push(...moveCandidates(ctx, state, op, def, def.id as MoveAction, pc, moveLimit, hardCap));
        break;
      case 'Shoot':
        out.push(...shootCandidates(ctx, state, op, def));
        break;
      case 'Fight':
        out.push(...meleeCandidates(ctx, state, op, def));
        break;
      case 'Hatchway Fight':
        out.push(...hatchwayCandidates(ctx, state, op, def));
        break;
      case 'Guard':
        push(out, ctx, state, op, def, {}, 'action', guardHint(ctx, state, op), 'guard');
        break;
      case 'Pick Up Marker':
        for (const marker of Object.values(state.markers)) {
          if (!marker.flags['pickUpAllowed']) continue;
          if (markerController(ctx, state, marker) !== op.player) continue;
          push(out, ctx, state, op, def, { markerId: marker.id }, 'action', 14, `pick up ${marker.kind}`);
        }
        break;
      case 'Place Marker':
        if (op.carryingMarkerId)
          push(out, ctx, state, op, def, { markerPos: { ...op.pos } }, 'action', 2, 'place marker');
        break;
      case 'Operate Hatch':
      case 'Breach': {
        const index = terrain(ctx, state);
        for (const part of index.parts) {
          if (part.role !== 'accessPoint') continue;
          push(out, ctx, state, op, def, { partId: part.id }, 'action', 3, `${def.name} ${part.id}`);
        }
        break;
      }
      default:
        // Unique/mission actions registered by team or op modules: offered with no params.
        push(out, ctx, state, op, def, {}, 'action', 1, def.name);
        break;
    }
  }
  return out;
}

/**
 * Counteract: "one free 1AP action excluding Guard", and action restrictions do not apply
 * because counteracting isn't an activation. `availableActions` doesn't model that, so the
 * legality set is rebuilt here to match what the reducer will accept.
 */
function counteractActionDefs(ctx: GameContext, state: GameState, op: OperativeState): ActionDef[] {
  return allActions().filter((def) => {
    if (def.id === 'Guard') return false;
    if (def.ap !== 1) return false;
    if (def.available && !def.available(ctx, state, op)) return false;
    return ctx.hooks.emit('canPerformAction', state, { state, operative: op, action: def.id, allowed: true }).allowed;
  });
}

function push(
  out: Candidate[],
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  def: ActionDef,
  params: ActionParams,
  kind: Candidate['kind'],
  hint: number,
  label: string,
): void {
  const check = def.check(ctx, state, op, params);
  if (!check.ok) return;
  out.push({
    intent: { t: 'PerformAction', operativeId: op.id, action: def.id, params },
    kind,
    hint,
    label,
  });
}

function moveCandidates(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  def: ActionDef,
  action: MoveAction,
  pc: PositionContext,
  limit: number,
  hardCap?: number,
): Candidate[] {
  const extraTargets = pc.objectives.map((m) => m.pos);
  if (action === 'Charge') {
    for (const enemy of chargeTargets(ctx, state, op)) extraTargets.push(...chargeRing(ctx, state, op, enemy));
  }
  const moves = generateMoves(ctx, state, op, action, {
    limit,
    ...(hardCap !== undefined ? { hardCap } : {}),
    extraTargets,
    rank: (pos) => cheapPositionScore(ctx, state, op, pos, pc),
  });
  const out: Candidate[] = [];
  for (const move of moves) {
    const params: ActionParams = { path: move.path };
    const check = def.check(ctx, state, op, params);
    if (!check.ok) continue;
    out.push({
      intent: { t: 'PerformAction', operativeId: op.id, action: def.id, params },
      kind: 'action',
      hint: cheapPositionScore(ctx, state, op, move.pos, pc),
      label: `${action} to ${move.pos.x.toFixed(1)},${move.pos.y.toFixed(1)}`,
    });
  }
  return out;
}

function shootCandidates(ctx: GameContext, state: GameState, op: OperativeState, def: ActionDef): Candidate[] {
  const out: Candidate[] = [];
  for (const plan of shotPlans(ctx, state, op).slice(0, 6)) {
    const params: ActionParams = {
      weaponName: plan.weaponName,
      ...(plan.profileName ? { profileName: plan.profileName } : {}),
      targetId: plan.targetId,
    };
    const check = def.check(ctx, state, op, params);
    if (!check.ok) continue;
    out.push({
      intent: { t: 'PerformAction', operativeId: op.id, action: 'Shoot', params },
      kind: 'action',
      hint: 10 * shotValue(plan),
      label: `shoot ${plan.targetId} with ${plan.weaponName}`,
    });
  }
  return out;
}

function meleeCandidates(ctx: GameContext, state: GameState, op: OperativeState, def: ActionDef): Candidate[] {
  const targets = enemiesInControlRange(ctx, state, op);
  const out: Candidate[] = [];
  for (const plan of fightPlans(ctx, state, op, targets).slice(0, 4)) {
    const params: ActionParams = {
      meleeWeaponName: plan.weaponName,
      ...(plan.profileName ? { meleeProfileName: plan.profileName } : {}),
      targetId: plan.targetId,
    };
    const check = def.check(ctx, state, op, params);
    if (!check.ok) continue;
    out.push({
      intent: { t: 'PerformAction', operativeId: op.id, action: def.id, params },
      kind: 'action',
      hint: 10 * fightValue(plan),
      label: `fight ${plan.targetId}`,
    });
  }
  return out;
}

function hatchwayCandidates(ctx: GameContext, state: GameState, op: OperativeState, def: ActionDef): Candidate[] {
  const out: Candidate[] = [];
  const enemies = aliveOperatives(state, otherPlayer(op.player)).filter((e) => gapBetween(ctx, op, e) <= 2 + 1e-6);
  for (const plan of fightPlans(ctx, state, op, enemies).slice(0, 3)) {
    const params: ActionParams = {
      meleeWeaponName: plan.weaponName,
      ...(plan.profileName ? { meleeProfileName: plan.profileName } : {}),
      targetId: plan.targetId,
    };
    const check = def.check(ctx, state, op, params);
    if (!check.ok) continue;
    out.push({
      intent: { t: 'PerformAction', operativeId: op.id, action: def.id, params },
      kind: 'action',
      hint: 10 * fightValue(plan),
      label: `hatchway fight ${plan.targetId}`,
    });
  }
  return out;
}

/**
 * Firefight ploys the team module offers. Legality mirrors the reducer exactly (CP, once per
 * turning point, the ploy's own `usable`), and value comes from `aiHints.ployValue`.
 */
export function ployCandidates(ctx: GameContext, state: GameState, player: PlayerId): Candidate[] {
  const team = state.teams[player];
  const module = ctx.teams.get(team.teamId);
  if (!module) return [];
  const out: Candidate[] = [];
  for (const ply of module.ploys) {
    if (ply.kind !== 'firefight') continue;
    if (team.cp < ply.cp) continue;
    if (team.ploysUsedTP.includes(ply.id)) continue;
    const usable = ply.usable?.(state, player);
    if (usable && !usable.ok) continue;
    const value = module.aiHints?.ployValue?.[ply.id];
    if (value === undefined || value <= 0) continue;
    out.push({
      intent: { t: 'UsePloy', player, ployId: ply.id },
      kind: 'ploy',
      hint: value,
      label: `ploy ${ply.name}`,
    });
  }
  return out;
}

function gambitHint(ctx: GameContext, state: GameState, player: PlayerId, gambitId: string): number {
  const module = ctx.teams.get(state.teams[player].teamId);
  return module?.aiHints?.ployValue?.[gambitId] ?? 1;
}

/** Guard is only worth an AP when an enemy is likely to walk into the interrupt. */
function guardHint(ctx: GameContext, state: GameState, op: OperativeState): number {
  let near = 0;
  for (const e of aliveOperatives(state, otherPlayer(op.player))) {
    const gap = gapBetween(ctx, op, e);
    if (gap <= 8) near += 1;
  }
  return near > 0 ? 6 : 0;
}

/** On Guard interrupt options for `player`, or an empty list. */
export function interruptCandidates(ctx: GameContext, state: GameState, player: PlayerId): Candidate[] {
  const offer = state.opState['guardOffer'] as { player?: PlayerId } | undefined;
  if (!offer || offer.player !== player) return [];
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  const out: Candidate[] = [];
  if (active && !active.removed) {
    for (const guard of guardInterruptCandidates(state, player)) {
      for (const plan of shotPlans(ctx, state, guard).slice(0, 2)) {
        out.push({
          intent: {
            t: 'OnGuardInterrupt',
            player,
            operativeId: guard.id,
            action: 'Shoot',
            params: {
              weaponName: plan.weaponName,
              ...(plan.profileName ? { profileName: plan.profileName } : {}),
              targetId: plan.targetId,
            },
          },
          kind: 'interrupt',
          hint: 10 * shotValue(plan),
          label: `interrupt: ${guard.letter} shoots`,
        });
      }
      const melee = enemiesInControlRange(ctx, state, guard);
      for (const plan of fightPlans(ctx, state, guard, melee).slice(0, 1)) {
        out.push({
          intent: {
            t: 'OnGuardInterrupt',
            player,
            operativeId: guard.id,
            action: 'Fight',
            params: {
              meleeWeaponName: plan.weaponName,
              ...(plan.profileName ? { meleeProfileName: plan.profileName } : {}),
              targetId: plan.targetId,
            },
          },
          kind: 'interrupt',
          hint: 10 * fightValue(plan),
          label: `interrupt: ${guard.letter} fights`,
        });
      }
    }
  }
  out.push({ intent: { t: 'DeclineInterrupt', player }, kind: 'interrupt', hint: 0, label: 'decline interrupt' });
  return out;
}

export { roleOf, aplOf, actionCost, getAction };
