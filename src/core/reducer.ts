/**
 * `reduce(state, intent, ctx)` — the ONLY way GameState changes.
 * Illegal intents are rejected into state.rejected + the log; nothing throws.
 */
import { actionCost, availableActions, getAction } from './actions.ts';
import { resolveDecision } from './decisions.ts';
import { rebuildHooks, terrain, type GameContext } from './context.ts';
import {
  aliveOperatives,
  aplOf,
  card,
  log,
  recordRoll,
  reject,
  removeIncapacitated,
  settleZ,
} from './state.ts';
import {
  MAX_TURNING_POINTS,
  bothPassedGambit,
  counteractCandidates,
  determineWinner,
  endTurningPoint,
  expireActivationEffects,
  gambitOptions,
  guardInterruptCandidates,
  readyStep,
  rollInitiative,
  tickSmoke,
  whoActivates,
} from './phases.ts';
import { advanceShoot, startShoot } from './sequences/shoot.ts';
import { advanceFight, startFight } from './sequences/fight.ts';
import { baseWhollyWithin, baseGap } from './geometry.ts';
import { baseTouchesHazardous } from './terrain.ts';
import type { Intent } from './intents.ts';
import type { GameState, OperativeState, PlayerId } from './types.ts';
import { otherPlayer } from './types.ts';

export interface ReduceOutcome {
  state: GameState;
  ok: boolean;
  reason?: string;
}

export function reduce(state: GameState, intent: Intent, ctx: GameContext): ReduceOutcome {
  const next = clone(state);
  const fail = (reason: string): ReduceOutcome => {
    reject(next, intent, reason);
    return { state: next, ok: false, reason };
  };

  // A pending decision blocks everything except resolving it (and conceding).
  if (
    next.pending.length > 0 &&
    intent.t !== 'ResolveDecision' &&
    intent.t !== 'PassDecision' &&
    intent.t !== 'Concede' &&
    intent.t !== 'UsePloy'
  ) {
    return fail(`a decision is pending: ${next.pending[0]!.prompt}`);
  }

  switch (intent.t) {
    // ---- setup -----------------------------------------------------------
    case 'RollOff': {
      const r = rollInitiative(ctx, next);
      if (r.winner === null) {
        // Setup roll-off re-rolls ties; the per-TP roll-off does not (Approved Ops).
        if (next.phase === 'setup') return reduce(next, intent, ctx);
        const decider = next.initiative ? otherPlayer(next.initiative) : 'p1';
        next.initiative = decider;
        log(next, { kind: 'system', text: `Tie — the player without initiative (${decider}) decides` });
      } else {
        next.setup.toAct = r.winner;
        if (next.phase !== 'setup') next.initiative = r.winner;
        log(next, { kind: 'system', text: `${r.winner} wins the roll-off` });
      }
      if (next.phase === 'setup') next.setup.step = 'chooseDropZone';
      return ok(next);
    }

    case 'ChooseInitiative': {
      next.initiative = intent.choice;
      log(next, { kind: 'system', text: `${intent.choice} has initiative` });
      return ok(next);
    }

    case 'ChooseDropZone': {
      next.setup.dropZone[intent.player] = intent.zone;
      next.setup.dropZone[otherPlayer(intent.player)] = intent.zone === 'p1' ? 'p2' : 'p1';
      next.setup.step = 'selectOperatives';
      log(next, { kind: 'system', text: `${intent.player} takes the ${intent.zone} drop zone` });
      return ok(next);
    }

    case 'SelectRoster': {
      const team = next.teams[intent.player];
      team.teamId = intent.teamId;
      team.operativeIds = [];
      let letterIdx = 0;
      for (const pick of intent.operatives) {
        const dc = ctx.datacards.get(pick.datacardId);
        if (!dc) return fail(`unknown datacard '${pick.datacardId}'`);
        const id = `${intent.player}-${letterIdx}`;
        const op: OperativeState = {
          id,
          player: intent.player,
          datacardId: pick.datacardId,
          letter: letterFor(letterIdx++),
          pos: { x: -100, y: -100 },
          z: 0,
          rot: 0,
          order: 'conceal',
          ready: false,
          expended: false,
          counteractedThisTP: false,
          wounds: dc.wounds,
          apSpent: 0,
          actionsThisActivation: [],
          onGuard: false,
          guardSpentTP: null,
          aplMods: [],
          weaponUses: {},
          stickyEngagedWith: [],
        };
        next.operatives[id] = op;
        team.operativeIds.push(id);
      }
      team.startingSize = team.operativeIds.length;
      rebuildHooks(ctx, next);
      log(next, { kind: 'system', player: intent.player, text: `${intent.teamId}: ${team.operativeIds.length} operatives selected` });
      return ok(next);
    }

    case 'SelectEquipment': {
      if (intent.equipment.length > 4) return fail('you can select up to four equipment options');
      if (new Set(intent.equipment).size !== intent.equipment.length)
        return fail('each equipment option can only be selected once per player');
      for (const id of intent.equipment) if (!ctx.equipment.has(id)) return fail(`unknown equipment '${id}'`);
      next.teams[intent.player].equipment = [...intent.equipment];
      rebuildHooks(ctx, next);
      ctx.hooks.emit('onSelectEquipment', next, { state: next, player: intent.player, equipment: intent.equipment });
      return ok(next);
    }

    case 'SelectTacOp': {
      const op = ctx.ops.get(intent.tacOpId);
      if (!op || op.kind !== 'tac') return fail(`unknown tac op '${intent.tacOpId}'`);
      const archetypes = next.teams[intent.player].archetypes;
      if (op.archetype && archetypes.length > 0 && !archetypes.includes(op.archetype))
        return fail(`${op.name} is a ${op.archetype} tac op — your kill team does not have that archetype`);
      next.teams[intent.player].tacOpId = intent.tacOpId;
      rebuildHooks(ctx, next);
      return ok(next);
    }

    case 'DeployOperative': {
      const op = next.operatives[intent.operativeId];
      if (!op) return fail('no such operative');
      if (op.player !== intent.player) return fail('not your operative');
      const zoneKey = next.setup.dropZone[intent.player] ?? intent.player;
      const zone = next.map.dropZones[zoneKey];
      const dc = card(ctx, op);
      const rot = intent.rotDeg ?? 0;
      if (!baseWhollyWithin(intent.pos, dc.base, rot, zone))
        return fail('operatives must be set up wholly within your drop zone');
      const index = terrain(ctx, next);
      if (baseTouchesHazardous(index, intent.pos, dc.base, rot))
        return fail('a base cannot touch a hazardous area');
      for (const other of aliveOperatives(next)) {
        if (other.id === op.id || other.pos.x < -50) continue;
        const oc = card(ctx, other);
        if (baseGap(intent.pos, dc.base, rot, other.pos, oc.base, other.rot) < -1e-4)
          return fail('a base cannot be placed on another');
      }
      op.pos = { ...intent.pos };
      op.rot = rot;
      op.order = 'conceal'; // "must be given a Conceal order"
      if (intent.z !== undefined) op.z = intent.z;
      else settleZ(ctx, next, op);
      next.setup.deployedCount[intent.player] = (next.setup.deployedCount[intent.player] ?? 0) + 1;
      ctx.hooks.emit('onDeploy', next, { state: next, operative: op });
      log(next, { kind: 'action', player: intent.player, text: `${op.letter} deploys` });
      return ok(next);
    }

    case 'FinishSetup': {
      const missing = Object.values(next.operatives).filter((o) => o.pos.x < -50);
      if (missing.length > 0) return fail(`${missing.length} operatives are not deployed`);
      next.setup.step = 'done';
      next.phase = 'strategy';
      next.strategyStep = 'initiative';
      next.turningPoint = 1;
      log(next, { kind: 'system', text: 'Battle begins' });
      return ok(next);
    }

    // ---- strategy phase --------------------------------------------------
    case 'UseGambit': {
      const opts = gambitOptions(ctx, next, intent.player);
      if (!opts.some((o) => o.id === intent.gambitId))
        return fail(`'${intent.gambitId}' is not an available STRATEGIC GAMBIT right now`);
      const team = next.teams[intent.player];
      const ply = ctx.teams.get(team.teamId)?.ploys.find((p) => p.id === intent.gambitId);
      if (ply) {
        if (team.cp < ply.cp) return fail(`not enough CP (${ply.cp} required)`);
        team.cp -= ply.cp;
      }
      team.gambitsUsedTP.push(intent.gambitId);
      team.passedGambit = false;
      next.teams[otherPlayer(intent.player)].passedGambit = false;
      log(next, { kind: 'ploy', player: intent.player, text: `STRATEGIC GAMBIT: ${ply?.name ?? intent.gambitId}` });
      return ok(next);
    }

    case 'PassGambit': {
      next.teams[intent.player].passedGambit = true;
      if (bothPassedGambit(next)) {
        next.phase = 'firefight';
        next.firefightStep = 'determineOrder';
        next.activePlayer = next.initiative ?? 'p1';
        log(next, { kind: 'system', text: 'Firefight phase' });
      }
      return ok(next);
    }

    case 'SelectPrimaryOp': {
      next.teams[intent.player].primaryOpId = intent.opId;
      log(next, { kind: 'system', player: intent.player, text: 'Primary op selected (secret)' });
      return ok(next);
    }

    // ---- firefight phase -------------------------------------------------
    case 'ActivateOperative': {
      const turn = whoActivates(next);
      if (!turn || turn.player !== intent.player || turn.mode !== 'activate')
        return fail('it is not your activation');
      const op = next.operatives[intent.operativeId];
      if (!op || op.player !== intent.player) return fail('no such friendly operative');
      if (!op.ready || op.removed) return fail('that operative is not ready');
      op.order = intent.order; // "Select the operative's order... It has this order until it's next activated."
      op.onGuard = false;
      op.apSpent = 0;
      op.actionsThisActivation = [];
      next.activeOperativeId = op.id;
      next.activePlayer = intent.player;
      next.firefightStep = 'performActions';
      ctx.hooks.emit('onActivationStart', next, { state: next, operative: op });
      log(next, { kind: 'action', player: intent.player, text: `${op.letter} activates (${intent.order})` });
      return ok(next);
    }

    case 'Counteract': {
      const turn = whoActivates(next);
      if (!turn || turn.player !== intent.player || turn.mode !== 'counteract')
        return fail('you cannot counteract right now');
      const candidates = counteractCandidates(ctx, next, intent.player);
      const op = candidates.find((o) => o.id === intent.operativeId);
      if (!op) return fail('that operative cannot counteract');
      op.counteractedThisTP = true;
      op.apSpent = 0;
      // "Counteracting isn't an activation... action restrictions won't apply."
      op.actionsThisActivation = [];
      next.activeOperativeId = op.id;
      next.activePlayer = intent.player;
      next.opState['counteract'] = { operativeId: op.id };
      log(next, { kind: 'action', player: intent.player, text: `${op.letter} counteracts` });
      return ok(next);
    }

    case 'DeclineCounteract': {
      next.activePlayer = otherPlayer(intent.player);
      for (const o of aliveOperatives(next, intent.player)) o.counteractedThisTP = true;
      log(next, { kind: 'action', player: intent.player, text: 'declines to counteract' });
      return ok(next);
    }

    case 'PerformAction': {
      const op = next.operatives[intent.operativeId];
      if (!op) return fail('no such operative');
      if (next.activeOperativeId !== op.id) return fail('that operative is not the active operative');
      const def = getAction(intent.action);
      if (!def) return fail(`unknown action '${intent.action}'`);
      if (def.available && !def.available(ctx, next, op))
        return fail(`${def.name} is not available in this killzone (Close Quarters / terrain gated)`);
      const restrictionKey = def.treatedAs ?? def.id;
      const counteracting = next.opState['counteract']?.['operativeId'] === op.id;
      if (!counteracting && op.actionsThisActivation.includes(restrictionKey))
        return fail(`action restrictions: ${restrictionKey} was already performed this activation`);
      const ap = counteracting ? 0 : actionCost(ctx, next, op, def);
      if (counteracting && def.ap !== 1) return fail('a counteraction must be a 1AP action');
      if (counteracting && def.id === 'Guard') return fail('a counteraction cannot be the Guard action');
      if (!counteracting && op.apSpent + ap > aplOf(ctx, next, op))
        return fail(`not enough AP for ${def.name}`);
      const hookEv = ctx.hooks.emit('canPerformAction', next, { state: next, operative: op, action: def.id, allowed: true });
      if (!hookEv.allowed) return fail(hookEv.reason ?? `${def.name} is not allowed`);

      const before = clone(next);
      const check = def.check(ctx, next, op, intent.params ?? {});
      if (!check.ok) return fail(check.reason ?? `${def.name} is not possible`);
      const res = def.perform(ctx, next, op, intent.params ?? {});
      if (!res.ok) {
        // "If an action is declared or begun but it's not possible to complete, the action is
        // cancelled. Revert back to the game state before that action."
        const reverted = before;
        reject(reverted, intent, res.reason ?? `${def.name} could not be completed`);
        return { state: reverted, ok: false, reason: res.reason };
      }
      op.apSpent += ap;
      op.actionsThisActivation.push(restrictionKey);
      if (def.id !== 'Guard') op.onGuard = false;
      removeIncapacitatedAfterAction(ctx, next);
      offerGuardInterrupt(ctx, next, op);
      return ok(next);
    }

    case 'EndActivation': {
      const op = next.operatives[intent.operativeId];
      if (!op) return fail('no such operative');
      if (next.activeOperativeId !== op.id) return fail('that operative is not active');
      const counteracting = next.opState['counteract']?.['operativeId'] === op.id;
      op.expended = true;
      op.ready = false;
      ctx.hooks.emit('onActivationEnd', next, { state: next, operative: op });
      expireActivationEffects(next, op.id);
      next.activeOperativeId = undefined as unknown as string | undefined;
      next.activationsThisTP += 1;
      tickSmoke(next);
      delete next.opState['counteract'];
      removeIncapacitated(ctx, next);
      next.activePlayer = otherPlayer(op.player);
      log(next, { kind: 'action', player: op.player, text: `${op.letter} is expended` });
      if (!counteracting && whoActivates(next) === null) advanceTurningPoint(ctx, next);
      return ok(next);
    }

    // ---- reactive --------------------------------------------------------
    case 'ResolveDecision': {
      const r = resolveDecision(ctx, next, intent.decisionId, intent.optionId, intent.data);
      if (!r.ok) return fail(r.reason ?? 'could not resolve the decision');
      finishSequenceIfDone(ctx, next);
      return ok(next);
    }

    case 'PassDecision': {
      const d = next.pending.find((x) => x.id === intent.decisionId);
      if (!d) return fail('no such decision');
      if (!d.optional) return fail('that decision cannot be passed');
      const r = resolveDecision(ctx, next, intent.decisionId, 'keep');
      if (!r.ok) return fail(r.reason ?? 'could not pass');
      finishSequenceIfDone(ctx, next);
      return ok(next);
    }

    case 'OnGuardInterrupt': {
      const op = next.operatives[intent.operativeId];
      if (!op || op.player !== intent.player) return fail('no such friendly operative');
      if (!op.onGuard) return fail('that operative is not on guard');
      const interrupted = next.activeOperativeId ? next.operatives[next.activeOperativeId] : undefined;
      if (!interrupted || interrupted.player === intent.player) return fail('nothing to interrupt');
      op.onGuard = false;
      op.guardSpentTP = next.turningPoint; // "cannot counteract during the turning point"
      const params = intent.params ?? {};
      if (intent.action === 'Shoot') {
        const weapon = params.weaponName ?? '';
        const targetId = params.targetId ?? interrupted.id;
        const pointBlank = baseGap(
          op.pos,
          card(ctx, op).base,
          op.rot,
          next.operatives[targetId]!.pos,
          card(ctx, next.operatives[targetId]!).base,
          next.operatives[targetId]!.rot,
        ) <= 1;
        const r = startShoot(ctx, next, op, weapon, params.profileName, targetId, { pointBlank, free: true });
        if (!r.ok) return fail(r.reason ?? 'the interrupt shot is not possible');
        if (pointBlank) {
          next.effects.push({
            id: `pb${next.seq++}`,
            rule: 'cannotRetaliate',
            source: { kind: 'core', id: 'onGuard' },
            operativeId: op.id,
            expiry: { kind: 'endOfActivation', operativeId: interrupted.id },
          });
        }
        advanceShoot(ctx, next);
      } else {
        const weapon = params.meleeWeaponName ?? '';
        const targetId = params.targetId ?? interrupted.id;
        const r = startFight(ctx, next, op, weapon, params.meleeProfileName, targetId, { free: true });
        if (!r.ok) return fail(r.reason ?? 'the interrupt fight is not possible');
        advanceFight(ctx, next);
      }
      log(next, { kind: 'action', player: intent.player, text: `${op.letter} interrupts with On Guard` });
      return ok(next);
    }

    case 'DeclineInterrupt': {
      // "An enemy operative ends an action within its control range and you don't interrupt
      // that activation" ends Guard.
      const active = next.activeOperativeId ? next.operatives[next.activeOperativeId] : undefined;
      if (active) {
        for (const g of guardInterruptCandidates(next, intent.player)) {
          if (baseGap(g.pos, card(ctx, g).base, g.rot, active.pos, card(ctx, active).base, active.rot) <= 1) {
            g.onGuard = false;
            log(next, { kind: 'action', player: intent.player, text: `${g.letter} loses Guard` });
          }
        }
      }
      delete next.opState['guardOffer'];
      return ok(next);
    }

    case 'UsePloy': {
      const team = next.teams[intent.player];
      const module = ctx.teams.get(team.teamId);
      const ply = module?.ploys.find((p) => p.id === intent.ployId);
      if (!ply) return fail(`unknown ploy '${intent.ployId}'`);
      if (team.cp < ply.cp) return fail(`not enough CP (${ply.cp} required)`);
      if (team.ploysUsedTP.includes(ply.id)) return fail('each ploy can only be used once per turning point');
      const usable = ply.usable?.(next, intent.player);
      if (usable && !usable.ok) return fail(usable.reason ?? 'that ploy cannot be used right now');
      team.cp -= ply.cp;
      team.ploysUsedTP.push(ply.id);
      log(next, { kind: 'ploy', player: intent.player, text: `${ply.name} (${ply.cp}CP)` });
      return ok(next);
    }

    // ---- flow ------------------------------------------------------------
    case 'AdvancePhase': {
      advancePhase(ctx, next);
      return ok(next);
    }

    case 'Concede': {
      next.phase = 'battleEnd';
      next.winner = otherPlayer(intent.player);
      log(next, { kind: 'system', text: `${intent.player} concedes` });
      return ok(next);
    }

    case 'MoveOperativeFree': {
      if (next.mode !== 'sandbox') return fail('free movement is only available in sandbox mode');
      const op = next.operatives[intent.operativeId];
      if (!op) return fail('no such operative');
      op.pos = { ...intent.pos };
      if (intent.z !== undefined) op.z = intent.z;
      else settleZ(ctx, next, op);
      if (intent.rotDeg !== undefined) op.rot = intent.rotDeg;
      return ok(next);
    }

    default:
      return fail(`unhandled intent '${(intent as { t: string }).t}'`);
  }
}

// ---------------------------------------------------------------------------

function ok(state: GameState): ReduceOutcome {
  return { state, ok: true };
}

function clone(state: GameState): GameState {
  return structuredClone(state);
}

function letterFor(i: number): string {
  return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
}

function removeIncapacitatedAfterAction(ctx: GameContext, state: GameState): void {
  // "Any operatives that were incapacitated are removed after the active operative has
  // finished the action" — a Blast/Torrent action removes them only once fully resolved.
  if (state.sequence && state.sequence.step !== 'done') return;
  removeIncapacitated(ctx, state);
  state.sequence = null;
}

function finishSequenceIfDone(ctx: GameContext, state: GameState): void {
  if (state.sequence && state.sequence.step === 'done' && state.pending.length === 0) {
    removeIncapacitated(ctx, state);
    state.sequence = null;
    const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
    if (active) offerGuardInterrupt(ctx, state, active);
  }
}

/**
 * After an enemy operative performs an action, the opponent may interrupt with On Guard.
 * Recorded as a state flag so the UI/AI can offer it; DeclineInterrupt clears it.
 */
function offerGuardInterrupt(ctx: GameContext, state: GameState, active: OperativeState): void {
  if (!state.map.closeQuarters) return;
  if (state.sequence && state.sequence.step !== 'done') return;
  const defender = otherPlayer(active.player);
  const candidates = guardInterruptCandidates(state, defender);
  if (candidates.length === 0) return;
  state.opState['guardOffer'] = { player: defender, operativeIds: candidates.map((o) => o.id) };
}

function advancePhase(ctx: GameContext, state: GameState): void {
  switch (state.phase) {
    case 'setup':
      return;
    case 'strategy': {
      if (state.strategyStep === 'initiative') {
        state.strategyStep = 'ready';
        readyStep(ctx, state);
      } else if (state.strategyStep === 'ready') {
        state.strategyStep = 'gambit';
      } else {
        state.phase = 'firefight';
        state.firefightStep = 'determineOrder';
        state.activePlayer = state.initiative ?? 'p1';
      }
      return;
    }
    case 'firefight': {
      advanceTurningPoint(ctx, state);
      return;
    }
    case 'endOfTP': {
      state.phase = 'strategy';
      state.strategyStep = 'initiative';
      return;
    }
    case 'battleEnd':
      return;
  }
}

function advanceTurningPoint(ctx: GameContext, state: GameState): void {
  endTurningPoint(ctx, state);
  state.phase = 'endOfTP';
  if (state.turningPoint >= (state.maxTurningPoints || MAX_TURNING_POINTS)) {
    state.phase = 'battleEnd';
    state.winner = determineWinner(state);
    log(state, {
      kind: 'system',
      text: `Battle ends — P1 ${state.teams.p1.vp}VP, P2 ${state.teams.p2.vp}VP (${state.winner})`,
    });
    return;
  }
  state.turningPoint += 1;
  state.phase = 'strategy';
  state.strategyStep = 'initiative';
  state.activeOperativeId = undefined as unknown as string | undefined;
  log(state, { kind: 'system', text: `Turning point ${state.turningPoint}` });
}

/** Everything a player could legally do right now — the AI's action surface and the UI's menu. */
export function legalIntents(ctx: GameContext, state: GameState, player: PlayerId): Intent[] {
  const out: Intent[] = [];
  if (state.pending.length > 0) {
    for (const d of state.pending.filter((x) => x.who === player)) {
      for (const o of d.options.filter((x) => !x.disabled))
        out.push({ t: 'ResolveDecision', decisionId: d.id, optionId: o.id });
    }
    return out;
  }
  if (state.phase === 'strategy' && state.strategyStep === 'gambit') {
    for (const g of gambitOptions(ctx, state, player)) out.push({ t: 'UseGambit', player, gambitId: g.id });
    out.push({ t: 'PassGambit', player });
    return out;
  }
  if (state.phase === 'firefight') {
    const turn = whoActivates(state);
    if (turn?.player === player) {
      if (turn.mode === 'activate' && !state.activeOperativeId) {
        for (const op of aliveOperatives(state, player).filter((o) => o.ready)) {
          out.push({ t: 'ActivateOperative', player, operativeId: op.id, order: 'engage' });
          out.push({ t: 'ActivateOperative', player, operativeId: op.id, order: 'conceal' });
        }
      } else if (turn.mode === 'counteract') {
        for (const op of counteractCandidates(ctx, state, player))
          out.push({ t: 'Counteract', player, operativeId: op.id });
        out.push({ t: 'DeclineCounteract', player });
      }
    }
    const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
    if (active && active.player === player) {
      for (const a of availableActions(ctx, state, active).filter((x) => x.ok))
        out.push({ t: 'PerformAction', operativeId: active.id, action: a.def.id });
      out.push({ t: 'EndActivation', operativeId: active.id });
    }
  }
  return out;
}
