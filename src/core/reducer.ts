/**
 * `reduce(state, intent, ctx)` — the ONLY way GameState changes.
 * Illegal intents are rejected into state.rejected + the log; nothing throws.
 */
import { actionCost, availableActions, getAction } from './actions.ts';
import { resolveDecision } from './decisions.ts';
import { rebuildHooks, terrain, type GameContext } from './context.ts';
import { inControlRange,
  aliveOperatives,
  aplOf,
  apBudgetOf,
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
  counteractActionsAllowed,
  counteractCandidates,
  determineWinner,
  endTurningPoint,
  expireActivationEffects,
  gambitOptions,
  gambitToAct,
  guardInterruptCandidates,
  readyStep,
  rollInitiative,
  tickSmoke,
  whoActivates,
} from './phases.ts';
import { advanceShoot, startShoot } from './sequences/shoot.ts';
import { advanceFight, startFight } from './sequences/fight.ts';
import { baseWhollyWithin, baseGap, basesOverlap } from './geometry.ts';
import { baseTouchesHazardous, occupancyCapExceeded, surfaceAt } from './terrain.ts';
import type { Intent } from './intents.ts';
import type { GameState, KillzoneMap, OperativeState, PlayerId, Vec2 } from './types.ts';
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
      // Approved Ops owns the per-turning-point roll-off: `beginInitiative` rolls, opens the
      // initiative-card window and ends with the WINNER deciding who has initiative. Rolling
      // here as well meant one RollOff intent consumed four dice, recorded two initiative
      // rolls, and spent the once-per-battle roll-off modifiers (Rune of Prophecy, Mastermind)
      // on the throw that was then discarded — and because the phantom roll overwrote
      // `state.initiative`, the real roll-off's tie-break read the phantom's winner instead of
      // whoever held initiative last turning point.
      if (next.phase !== 'setup' && ctx.beginInitiative) {
        ctx.beginInitiative(ctx, next);
        return ok(next);
      }
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
      // "the initiative player picks a drop zone, opponent gets the Re-roll initiative card"
      ctx.grantSetupRerollCard?.(next, otherPlayer(intent.player));
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
      if (next.teams.p1.tacOpId && next.teams.p2.tacOpId) ctx.initOps?.(ctx, next);
      return ok(next);
    }

    case 'BeginDeployment': {
      // The reveal. Until this existed the UI reached in and assigned `setup.step` itself,
      // which meant the transition was invisible to the log, to a replay and to any other
      // view of the same state.
      if (next.setup.step !== 'selectOperatives') return fail('kill teams are not being selected');
      const empty = (['p1', 'p2'] as PlayerId[]).filter((p) => next.teams[p].operativeIds.length === 0);
      if (empty.length > 0) return fail(`${empty.join(' and ')} has not selected a kill team`);
      next.setup.revealed = { p1: true, p2: true };
      log(next, { kind: 'system', text: 'Both kill teams are revealed' });
      // Equipment that occupies space on the killzone — barricades, ladders, portable
      // cover — is set up BEFORE operatives are, and until now nothing ever set this step,
      // so a player who bought a barricade simply never got to place it and the item stayed
      // in limbo for the whole battle.
      const setter = ctx.equipmentToAct?.(next) ?? null;
      next.setup.step = setter ? 'placeEquipment' : 'deploy';
      if (setter) next.setup.toAct = setter;
      return ok(next);
    }

    case 'DeployOperative': {
      const op = next.operatives[intent.operativeId];
      if (!op) return fail('no such operative');
      if (op.player !== intent.player) return fail('not your operative');
      const rot = intent.rotDeg ?? 0;
      const legal = canDeployAt(ctx, next, op, intent.pos, rot, intent.z);
      if (!legal.ok) return fail(legal.reason ?? 'that operative cannot be set up there');
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

    case 'PlaceEquipment': {
      if (!ctx.placeEquipment) return fail('equipment placement is not available in this build');
      const res = ctx.placeEquipment(ctx, next, intent);
      if (!res.ok) return fail(res.reason ?? 'that equipment cannot be set up there');
      // `placeEquipment` already counted it. Counting again here doubled the tally the setup
      // screen shows, so "1 of 2 set up" jumped straight past the second item.
      advanceEquipmentStep(ctx, next);
      return ok(next);
    }

    case 'SkipEquipmentPlacement': {
      next.setup.equipmentDone = { ...(next.setup.equipmentDone ?? {}), [intent.player]: true };
      advanceEquipmentStep(ctx, next);
      log(next, { kind: 'system', player: intent.player, text: 'no more equipment to set up' });
      return ok(next);
    }

    case 'PlayInitiativeCard': {
      if (!ctx.playInitiativeCard) return fail('initiative cards are not available in this build');
      if (!next.teams[intent.player].initiativeCards.includes(intent.cardId))
        return fail(`you do not hold the '${intent.cardId}' initiative card`);
      const res = ctx.playInitiativeCard(ctx, next, intent.player, intent.cardId);
      if (!res.ok) return fail(res.reason ?? 'that initiative card cannot be played now');
      next.teams[intent.player].initiativeCards = next.teams[intent.player].initiativeCards.filter(
        (c) => c !== intent.cardId,
      );
      return ok(next);
    }

    case 'PassInitiativeCards': {
      next.opState['initiativeCards'] = {
        ...(next.opState['initiativeCards'] ?? {}),
        [`passed:${intent.player}`]: true,
      };
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
      // "Starting with the player who has initiative, each player alternates either using a
      // STRATEGIC GAMBIT or passing. The players repeat this process until they have both
      // passed in succession." The order lived only in `gambitToAct`, which the UI consulted
      // and nothing else did, so an out-of-turn gambit was simply applied.
      if (gambitToAct(next) !== intent.player) return fail('it is not your turn to use a STRATEGIC GAMBIT');
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
      ctx.hooks.emit('onPloyUsed', next, {
        state: next,
        player: intent.player,
        ployId: intent.gambitId,
        kind: 'strategy',
        ...(intent.data ? { data: intent.data } : {}),
      });
      return ok(next);
    }

    case 'PassGambit': {
      if (gambitToAct(next) !== intent.player) return fail('it is not your turn to use a STRATEGIC GAMBIT');
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
      const turn = whoActivates(next, ctx);
      if (!turn || turn.player !== intent.player || turn.mode !== 'activate')
        return fail('it is not your activation');
      const op = next.operatives[intent.operativeId];
      if (!op || op.player !== intent.player) return fail('no such friendly operative');
      if (!op.ready || op.removed) return fail('that operative is not ready');
      op.order = intent.order; // "Select the operative's order... It has this order until it's next activated."
      op.onGuard = false;
      op.apSpent = 0;
      op.actionsThisActivation = [];
      op.weaponsUsedThisActivation = [];
      delete next.opState['guardInterruptUsedFor'];
      delete next.opState['counteractDeclined'];
      next.activeOperativeId = op.id;
      next.activePlayer = intent.player;
      next.firefightStep = 'performActions';
      ctx.hooks.emit('onActivationStart', next, { state: next, operative: op });
      log(next, { kind: 'action', player: intent.player, text: `${op.letter} activates (${intent.order})` });
      return ok(next);
    }

    case 'Counteract': {
      const turn = whoActivates(next, ctx);
      if (!turn || turn.player !== intent.player || turn.mode !== 'counteract')
        return fail('you cannot counteract right now');
      const candidates = counteractCandidates(ctx, next, intent.player);
      const op = candidates.find((o) => o.id === intent.operativeId);
      if (!op) return fail('that operative cannot counteract');
      op.counteractedThisTP = true;
      op.apSpent = 0;
      // "Counteracting isn't an activation... action restrictions won't apply."
      op.actionsThisActivation = [];
      op.weaponsUsedThisActivation = [];
      delete next.opState['guardInterruptUsedFor'];
      delete next.opState['counteractDeclined'];
      next.activeOperativeId = op.id;
      next.activePlayer = intent.player;
      // `movedInches` accumulates across the whole counteraction: the 2" cap is on the
      // counteraction, not on each action in it (see `counteractMoveLeft`).
      next.opState['counteract'] = { operativeId: op.id, actionsUsed: 0, movedInches: 0 };
      log(next, { kind: 'action', player: intent.player, text: `${op.letter} counteracts` });
      return ok(next);
    }

    case 'DeclineCounteract': {
      next.activePlayer = otherPlayer(intent.player);
      // Only THIS window is declined. Marking every operative as having counteracted — which
      // is what this did — gave up every counteract for the rest of the turning point, though
      // the only budget the rule imposes is one per operative, spent by counteracting.
      next.opState['counteractDeclined'] = { player: intent.player, at: next.activationsThisTP };
      log(next, { kind: 'action', player: intent.player, text: 'declines to counteract this window' });
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
      const counteract = next.opState['counteract'];
      const counteracting = counteract?.['operativeId'] === op.id;
      if (!counteracting && op.actionsThisActivation.includes(restrictionKey))
        return fail(`action restrictions: ${restrictionKey} was already performed this activation`);
      const ap = counteracting ? 0 : actionCost(ctx, next, op, def);
      if (counteracting && def.ap !== 1) return fail('a counteraction must be a 1AP action');
      if (counteracting && def.id === 'Guard') return fail('a counteraction cannot be the Guard action');
      // "you can select an expended friendly operative with an Engage order to perform a
      // 1AP action (excluding Guard) for free" — ONE action, not an unlimited free turn. A team
      // rule may raise the allowance (Deathwatch's Veteran Astartes grants a second); the
      // CONSTRAINTS that come with such a grant are the granting rule's own job, through
      // `canPerformAction` below, because a counteraction deliberately skips action restrictions.
      if (counteracting && Number(counteract?.['actionsUsed'] ?? 0) >= counteractActionsAllowed(ctx, next, op))
        return fail('a counteracting operative can only perform one action');
      // `apBudgetOf`, not `aplOf`: a granted free action adds AP without being an APL stat
      // change, so it is not subject to the +-1 clamp (D-100).
      if (!counteracting && op.apSpent + ap > apBudgetOf(ctx, next, op))
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
        // check() said yes and perform() said no: that is an ActionDef contract violation,
        // not a caller mistake. Name it, so it shows up as a bug rather than as a generic
        // rejected intent in a soak report.
        log(reverted, {
          kind: 'system',
          text: `action contract: ${def.id}.check accepted but perform failed — ${res.reason ?? 'no reason given'}`,
          data: { action: def.id, contractViolation: true },
        });
        reject(reverted, intent, res.reason ?? `${def.name} could not be completed`);
        return { state: reverted, ok: false, reason: res.reason };
      }
      op.apSpent += ap;
      op.actionsThisActivation.push(restrictionKey);
      if (counteracting && counteract) counteract['actionsUsed'] = Number(counteract['actionsUsed'] ?? 0) + 1;
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
      // "Counteracting isn't an activation, it's instead of activating" — so it does not
      // count toward the activation clock a smoke grenade's duration is measured in.
      if (!counteracting) {
        next.activationsThisTP += 1;
        tickSmoke(next);
      }
      delete next.opState['counteract'];
      removeIncapacitated(ctx, next);
      next.activePlayer = otherPlayer(op.player);
      log(next, { kind: 'action', player: op.player, text: `${op.letter} is expended` });
      if (!counteracting && whoActivates(next, ctx) === null) advanceTurningPoint(ctx, next);
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
      // "ONCE DURING EACH ENEMY OPERATIVE'S ACTIVATION, after that enemy operative performs an
      // action, you can interrupt that activation…" The only bookkeeping was per operative, so
      // a three-strong overwatch net fired three free Shoots into one 2AP activation.
      if (next.opState['guardInterruptUsedFor']?.['operativeId'] === interrupted.id)
        return fail('the On Guard window for this activation has already been used');
      next.opState['guardInterruptUsedFor'] = { operativeId: interrupted.id };
      op.onGuard = false;
      op.guardSpentTP = next.turningPoint; // "cannot counteract during the turning point"
      const params = intent.params ?? {};
      if (intent.action === 'Shoot') {
        const weapon = params.weaponName ?? '';
        const targetId = params.targetId ?? interrupted.id;
        // Point-blank is a CONTROL RANGE question, not a distance one: "visible to and within
        // 1"". Measuring raw base-to-base let an on-guard operative shoot point-blank through
        // a Gallowdark wall — they are 0.365" thick, so almost any pair hugging opposite faces
        // is inside 1" — and a point-blank shot skips the Conceal-in-cover target check too.
        const targetOp = next.operatives[targetId];
        const pointBlank = Boolean(targetOp) && inControlRange(ctx, next, op, targetOp!);
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
      // "Once during each enemy operative's activation" — the window is spent either way.
      delete next.opState['guardOffer'];
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
      ctx.hooks.emit('onPloyUsed', next, {
        state: next,
        player: intent.player,
        ployId: ply.id,
        kind: ply.kind === 'strategy' ? 'strategy' : 'firefight',
        ...(intent.data ? { data: intent.data } : {}),
      });
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

/**
 * Is this a legal place to set up that operative? Core Rules › SET UP OPERATIVES.
 *
 * Extracted from the `DeployOperative` case so that a UI drawing a placement ghost gets the
 * SAME answer, in the SAME words, as the intent it is about to send — and gets it without
 * cloning the whole GameState through `reduce` on every frame of a drag.
 */
export function canDeployAt(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
  rotDeg = 0,
  z?: number,
): { ok: boolean; reason?: string } {
  const zoneKey = state.setup.dropZone[op.player] ?? op.player;
  const zone = state.map.dropZones[zoneKey];
  const dc = card(ctx, op);
  if (!baseWhollyWithin(pos, dc.base, rotDeg, zone))
    return { ok: false, reason: 'operatives must be set up wholly within your drop zone' };
  const index = terrain(ctx, state);
  if (baseTouchesHazardous(index, pos, dc.base, rotDeg))
    return { ok: false, reason: 'a base cannot touch a hazardous area' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id || other.pos.x < -50) continue;
    const oc = card(ctx, other);
    // `basesOverlap`, NOT `baseGap(...) < -1e-4`. `baseGap` clamps at zero
    // (geometry.ts › baseGap), so that comparison can never be true. Deployment was moved to
    // this spelling first and movement followed in W-34 (docs/DECISIONS.md D-102), so the two
    // finally agree about one rule.
    if (basesOverlap(pos, dc.base, rotDeg, other.pos, oc.base, other.rot))
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  // "…an enemy operative cannot be prevented from moving onto OR BEING SET UP ON the other
  // side": the Stronghold H cap binds every way an operative arrives, not just a move.
  const at = z ?? surfaceAt(index, pos);
  const overfull = occupancyCapExceeded(index, aliveOperatives(state), op.id, op.player, pos, at);
  if (overfull)
    return {
      ok: false,
      reason: `no more than ${overfull.maxOperatives} friendly operative can be on the highest upper level of that terrain feature at once`,
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------

function ok(state: GameState): ReduceOutcome {
  return { state, ok: true };
}

/**
 * The map is immutable for the whole battle — terrain changes go to `state.terrainState`
 * and equipment to `state.placedFeatures` — so cloning it on every intent is pure waste
 * (it was 36% of CPU in a profiled game) AND it defeated the terrain-index cache, which
 * keys on map identity. Share the reference instead.
 */
function clone(state: GameState): GameState {
  const { map, ...rest } = state;
  const next = structuredClone(rest) as Omit<GameState, 'map'> & { map: KillzoneMap };
  next.map = map;
  return next as GameState;
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
  // "Once during each enemy operative's activation" — do not re-offer a window already spent.
  if (state.opState['guardInterruptUsedFor']?.['operativeId'] === active.id) return;
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
      // The turning point rolls over HERE, not when the firefight phase ended. See
      // `advanceTurningPoint`.
      state.turningPoint += 1;
      state.phase = 'strategy';
      state.strategyStep = 'initiative';
      state.activeOperativeId = undefined as unknown as string | undefined;
      log(state, { kind: 'system', text: `Turning point ${state.turningPoint}` });
      return;
    }
    case 'battleEnd':
      return;
  }
}

/**
 * End of the firefight phase: score the turning point, then STOP on `endOfTP`.
 *
 * This used to set `state.phase = 'endOfTP'` and then overwrite it with `'strategy'` a few
 * lines later, in the same call. The phase therefore never existed for a single moment that
 * anything could observe, so the end-of-turning-point screen was unreachable and the only
 * scoring the game does — up to 6VP a side, per turning point — landed silently: the score
 * in the top bar simply changed while the player was looking at the next initiative roll.
 *
 * `AdvancePhase` out of `endOfTP` is what now rolls the turning point over, and
 * `src/ai/runner` already dispatches exactly that, so bot-driven games walk through the new
 * stop unchanged.
 */
function advanceTurningPoint(ctx: GameContext, state: GameState): void {
  // The score is read while the turning point's effects are still live — see `endTurningPoint`.
  endTurningPoint(ctx, state, ctx.scoreEndOfTurningPoint);
  if (state.turningPoint >= (state.maxTurningPoints || MAX_TURNING_POINTS)) {
    state.phase = 'battleEnd';
    ctx.scoreEndOfBattle?.(ctx, state);
    state.winner = determineWinner(state);
    log(state, {
      kind: 'system',
      text: `Battle ends — P1 ${state.teams.p1.vp}VP, P2 ${state.teams.p2.vp}VP (${state.winner})`,
    });
    return;
  }
  state.phase = 'endOfTP';
  state.activeOperativeId = undefined as unknown as string | undefined;
}

/**
 * Pass the equipment turn on, and leave the step once neither player has anything left.
 *
 * Deployment can only start after this: an operative set up first would be standing where a
 * barricade is about to go.
 */
function advanceEquipmentStep(ctx: GameContext, state: GameState): void {
  if (state.setup.step !== 'placeEquipment') return;
  const next = ctx.equipmentToAct?.(state) ?? null;
  if (!next) {
    state.setup.step = 'deploy';
    // Deployment starts with the player who has initiative, whoever placed the last item.
    state.setup.toAct = state.initiative ?? 'p1';
    return;
  }
  // `equipmentToAct` alternates on the placed counts, so it hands the turn back to the same
  // player when the other has nothing left — which is the rule, not a stuck turn.
  state.setup.toAct = next;
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
    const turn = whoActivates(state, ctx);
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
