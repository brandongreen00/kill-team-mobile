/**
 * Universal, mission and free actions.
 *
 * Core rules › Actions: "Each action costs Action points (AP), and you cannot spend more AP
 * during an operative's activation than its Action point limit (APL)... an operative cannot
 * perform the same action more than once during its activation — this is known as action
 * restrictions... If an action is declared or begun but it's not possible to complete, the
 * action is cancelled. Revert back to the game state before that action."
 */
import { baseGap, dist } from './geometry.ts';
import { terrain, type GameContext } from './context.ts';
import {
  moveBudget,
  moveOptionsFor,
  validateMove,
  type MoveAction,
  type MoveOptions,
  type MoveValidation,
} from './movement.ts';
import {
  aliveOperatives,
  aplOf,
  card,
  enemiesInControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  recordRoll,
  settleZ,
  weaponsOf,
} from './state.ts';
import { startShoot, advanceShoot, canSelectWeapon } from './sequences/shoot.ts';
import { startFight, advanceFight } from './sequences/fight.ts';
import { hasType } from './terrain.ts';
import type { ActionParams, MovePath } from './intents.ts';
import type { GameState, OperativeState, PlayerId } from './types.ts';
import { otherPlayer } from './types.ts';

export interface ActionDef {
  id: string;
  name: string;
  ap: number;
  type: 'universal' | 'mission' | 'unique' | 'free';
  /** Killzone gating: only offered when the predicate passes. */
  available?(ctx: GameContext, state: GameState, op: OperativeState): boolean;
  /**
   * Legality check that does not change state.
   *
   * CONTRACT: whatever `check` accepts, `perform` must be able to complete. A `perform`
   * failure is a rules-legitimate cancel-and-revert ("If an action is declared or begun but
   * it's not possible to complete, the action is cancelled") — but the reducer ALSO records
   * it as a rejected intent, so a caller that trusted `check` (the AI, the UI's action
   * sheet) gets a rejection it could not have predicted. Validate the selection here, not
   * in `perform`. The reducer logs a distinct 'action contract' entry when this is violated.
   */
  check(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): { ok: boolean; reason?: string };
  /** Perform it. May start a sequence and raise decisions. */
  perform(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): { ok: boolean; reason?: string };
  /** Actions "treated as" another action for restriction purposes (Guard -> Shoot). */
  treatedAs?: string;
  sourceText: string;
}

const registry = new Map<string, ActionDef>();

export function registerAction(def: ActionDef): void {
  registry.set(def.id, def);
}
export function getAction(id: string): ActionDef | undefined {
  return registry.get(id);
}
export function allActions(): ActionDef[] {
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// shared conditions
// ---------------------------------------------------------------------------

const engaged = (ctx: GameContext, state: GameState, op: OperativeState): boolean =>
  enemiesInControlRange(ctx, state, op).length > 0;

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

/**
 * "That operative cannot move more than 2\", or must be set up wholly within 2\" if it's
 * removed and set up again, while counteracting (this is not a change to its Move stat, and
 * takes precedence over all other rules)."
 */
function withCounteractCap(state: GameState, op: OperativeState, opts: MoveOptions): MoveOptions {
  const counteracting = state.opState['counteract']?.['operativeId'] === op.id;
  return counteracting ? { ...opts, hardCap: 2 } : opts;
}

function moveCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  opts: MoveOptions,
): { ok: boolean; reason?: string } {
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const v = validateMove(ctx, state, op, params.path, withCounteractCap(state, op, opts));
  return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
}

/**
 * The exact validation the reducer will run for a movement action, for the board's
 * tap-to-move preview: what this returns as ok, `PerformAction` accepts.
 */
export function previewMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  action: MoveAction,
  path: MovePath,
): MoveValidation {
  return validateMove(ctx, state, op, path, withCounteractCap(state, op, moveOptionsFor(action)));
}

/** The inches available to a movement action right now (counteract cap applied). */
export function moveBudgetFor(ctx: GameContext, state: GameState, op: OperativeState, action: MoveAction): number {
  const opts = withCounteractCap(state, op, moveOptionsFor(action));
  const budget = moveBudget(ctx, state, op, opts);
  return opts.hardCap !== undefined ? Math.min(budget, opts.hardCap) : budget;
}

function applyMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  opts: MoveOptions,
  label: string,
): { ok: boolean; reason?: string } {
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const v = validateMove(ctx, state, op, params.path, withCounteractCap(state, op, opts));
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  op.pos = { ...v.endPos };
  op.z = v.endZ;
  if (params.path.endRot !== undefined) op.rot = params.path.endRot;
  op.onGuard = false;
  // A carried marker moves with its operative.
  if (op.carryingMarkerId) {
    const m = state.markers[op.carryingMarkerId];
    if (m) {
      m.pos = { ...op.pos };
      m.z = op.z;
    }
  }
  checkMines(ctx, state, op);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.name} performs ${label} (${v.total}")`,
    data: { operativeId: op.id, action: label, inches: v.total, legs: v.legs.length },
  });
  return { ok: true };
}

/** Mines: "The first time that marker is within an operative's control range, remove that
 *  marker and inflict D3+3 damage on that operative." */
function checkMines(ctx: GameContext, state: GameState, op: OperativeState): void {
  for (const marker of Object.values(state.markers)) {
    if (marker.kind !== 'mine') continue;
    if (marker.flags['triggered']) continue;
    if (!markerContestedBy(ctx, state, marker, op)) continue;
    marker.flags['triggered'] = true;
    const d3 = ctx.rng.d3();
    recordRoll(state, 'mine', [d3], op.player, 'Mines D3+3');
    delete state.markers[marker.id];
    inflictDamage(ctx, state, op, d3 + 3, 'mine');
    log(state, { kind: 'action', player: op.player, text: `${op.name} triggers Mines: ${d3}+3 damage` });
  }
}

// ---------------------------------------------------------------------------
// Universal actions
// ---------------------------------------------------------------------------

registerAction({
  id: 'Reposition',
  name: 'Reposition',
  ap: 1,
  type: 'universal',
  sourceText:
    'REPOSITION 1AP: Move the active operative up to its Move stat to a location it can be placed... An operative cannot perform this action while within control range of an enemy operative, or during the same activation in which it performed the Fall Back or Charge action.',
  check(ctx, state, op, params) {
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    if (did(op, 'Fall Back') || did(op, 'Charge'))
      return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
    return moveCheck(ctx, state, op, params, { action: 'Reposition', mustNotFinishEngaged: true });
  },
  perform(ctx, state, op, params) {
    return applyMove(ctx, state, op, params, { action: 'Reposition', mustNotFinishEngaged: true }, 'Reposition');
  },
});

registerAction({
  id: 'Dash',
  name: 'Dash',
  ap: 1,
  type: 'universal',
  sourceText:
    'DASH 1AP: The same as the Reposition action, except... it can move up to 3" instead. In addition, it cannot climb during this move, but it can drop and jump.',
  check(ctx, state, op, params) {
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    if (did(op, 'Charge')) return { ok: false, reason: 'already performed Charge this activation' };
    return moveCheck(ctx, state, op, params, { action: 'Dash', noClimb: true, mustNotFinishEngaged: true });
  },
  perform(ctx, state, op, params) {
    return applyMove(ctx, state, op, params, { action: 'Dash', noClimb: true, mustNotFinishEngaged: true }, 'Dash');
  },
});

registerAction({
  id: 'Fall Back',
  name: 'Fall Back',
  ap: 2,
  type: 'universal',
  sourceText:
    'FALL BACK 2AP: The same as the Reposition action, except the active operative can move within control range of an enemy operative, but cannot finish the move there. An operative cannot perform this action unless an enemy operative is within its control range.',
  check(ctx, state, op, params) {
    if (!engaged(ctx, state, op)) return { ok: false, reason: 'no enemy operative within control range' };
    if (did(op, 'Reposition') || did(op, 'Charge'))
      return { ok: false, reason: 'already performed Reposition or Charge this activation' };
    return moveCheck(ctx, state, op, params, {
      action: 'Fall Back',
      mayEnterEnemyControlRange: true,
      mustNotFinishEngaged: true,
    });
  },
  perform(ctx, state, op, params) {
    return applyMove(
      ctx,
      state,
      op,
      params,
      { action: 'Fall Back', mayEnterEnemyControlRange: true, mustNotFinishEngaged: true },
      'Fall Back',
    );
  },
});

registerAction({
  id: 'Charge',
  name: 'Charge',
  ap: 1,
  type: 'universal',
  sourceText:
    'CHARGE 1AP: The same as the Reposition action, except the active operative can move an additional 2". It can move, and must finish the move, within control range of an enemy operative... An operative cannot perform this action while it has a Conceal order, if it\'s already within control range of an enemy operative, or during the same activation in which it performed the Reposition, Dash or Fall Back action.',
  check(ctx, state, op, params) {
    if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
    if (engaged(ctx, state, op)) return { ok: false, reason: 'already within control range of an enemy operative' };
    if (did(op, 'Reposition') || did(op, 'Dash') || did(op, 'Fall Back'))
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
    return moveCheck(ctx, state, op, params, {
      action: 'Charge',
      bonusInches: 2,
      mayEnterEnemyControlRange: true,
      mustFinishEngaged: true,
    });
  },
  perform(ctx, state, op, params) {
    const r = applyMove(
      ctx,
      state,
      op,
      params,
      { action: 'Charge', bonusInches: 2, mayEnterEnemyControlRange: true, mustFinishEngaged: true },
      'Charge',
    );
    if (!r.ok) return r;
    // "If it moves within control range of an enemy operative that no other friendly
    // operatives are within control range of, it cannot leave that operative's control range."
    const sticky = enemiesInControlRange(ctx, state, op).filter(
      (e) => !aliveOperatives(state, op.player).some((f) => f.id !== op.id && enemiesInControlRange(ctx, state, f).some((x) => x.id === e.id)),
    );
    op.stickyEngagedWith = sticky.map((e) => e.id);
    return r;
  },
});

registerAction({
  id: 'Pick Up Marker',
  name: 'Pick Up Marker',
  ap: 1,
  type: 'universal',
  sourceText:
    'PICK UP MARKER 1AP: Remove a marker the active operative controls that the Pick Up Marker action can be performed upon... An operative cannot perform this action while within control range of an enemy operative, or while it\'s already carrying a marker.',
  check(ctx, state, op, params) {
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker) return { ok: false, reason: 'no such marker' };
    if (!marker.flags['pickUpAllowed']) return { ok: false, reason: 'this marker cannot be picked up' };
    if (markerController(ctx, state, marker) !== op.player)
      return { ok: false, reason: 'your operatives do not control that marker' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.carriedBy = op.id;
    marker.pos = { ...op.pos };
    marker.z = op.z;
    op.carryingMarkerId = marker.id;
    log(state, { kind: 'action', player: op.player, text: `${op.name} picks up the ${marker.kind} marker` });
    return { ok: true };
  },
});

registerAction({
  id: 'Place Marker',
  name: 'Place Marker',
  ap: 1,
  type: 'universal',
  sourceText:
    'PLACE MARKER 1AP: Place a marker the active operative is carrying within its control range. If an operative carrying a marker is incapacitated, it must perform this action before being removed from the killzone, but does so for 0AP.',
  check(ctx, state, op, params) {
    if (!op.carryingMarkerId) return { ok: false, reason: 'not carrying a marker' };
    if (did(op, 'Pick Up Marker') && !op.incapacitated)
      return { ok: false, reason: 'already performed Pick Up Marker this activation' };
    // "Place a marker the active operative is carrying within its control range."
    if (params.markerPos) {
      const c = card(ctx, op);
      const gap = baseGap(op.pos, c.base, op.rot, params.markerPos, { shape: 'round', mm: 20 }, 0);
      if (gap > 1 + 1e-6) return { ok: false, reason: 'the marker must be placed within control range' };
    }
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[op.carryingMarkerId!]!;
    marker.carriedBy = undefined as unknown as string | undefined;
    marker.pos = params.markerPos ? { ...params.markerPos } : { ...op.pos };
    marker.z = op.z;
    op.carryingMarkerId = undefined as unknown as string | undefined;
    log(state, { kind: 'action', player: op.player, text: `${op.name} places the ${marker.kind} marker` });
    return { ok: true };
  },
});

registerAction({
  id: 'Shoot',
  name: 'Shoot',
  ap: 1,
  type: 'universal',
  sourceText:
    'SHOOT 1AP: Shoot with the active operative by following the sequence... An operative cannot perform this action while it has a Conceal order, or while within control range of an enemy operative.',
  check(ctx, state, op, params) {
    const silent = params.weaponName
      ? weaponsOf(ctx, state, op, 'ranged')
          .find((w) => w.name === params.weaponName)
          ?.profiles.some((p) => p.rules.some((r) => r.id === 'Silent'))
      : false;
    if (op.order === 'conceal' && !silent) return { ok: false, reason: 'cannot Shoot with a Conceal order' };
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    if (!params.weaponName || !params.targetId) return { ok: false, reason: 'weapon and target required' };
    // Heavy: "cannot use this weapon in an activation in which it moved".
    const w = weaponsOf(ctx, state, op, 'ranged').find((x) => x.name === params.weaponName);
    const profile = w?.profiles.find((p) => (p.name ?? '') === (params.profileName ?? '')) ?? w?.profiles[0];
    const heavy = profile?.rules.find((r) => r.id === 'Heavy');
    if (heavy) {
      const moved = op.actionsThisActivation.some((a) =>
        ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'].includes(a),
      );
      if (moved && !(heavy.only && op.actionsThisActivation.every((a) => a === heavy.only || !isMove(a))))
        return { ok: false, reason: `${w!.name} is Heavy — it cannot be used in an activation in which the operative moved` };
    }
    // A rule may forbid THIS profile (the rare `Concealed Position` weapon rule). Asked here as
    // well as in the sequence so the refusal is visible before the intent is committed.
    return canSelectWeapon(ctx, state, op, params.weaponName, params.profileName, params.targetId);
  },
  perform(ctx, state, op, params) {
    const r = startShoot(ctx, state, op, params.weaponName!, params.profileName, params.targetId!);
    if (!r.ok) return r;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

const isMove = (a: string): boolean =>
  ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'].includes(a);

registerAction({
  id: 'Fight',
  name: 'Fight',
  ap: 1,
  type: 'universal',
  sourceText:
    'FIGHT 1AP: Fight with the active operative by following the sequence... An operative cannot perform this action unless an enemy operative is within its control range.',
  check(ctx, state, op, params) {
    if (!engaged(ctx, state, op)) return { ok: false, reason: 'no enemy operative within control range' };
    if (!params.meleeWeaponName && weaponsOf(ctx, state, op, 'melee').length === 0)
      return { ok: false, reason: 'operative has no melee weapon' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = params.meleeWeaponName ?? weaponsOf(ctx, state, op, 'melee')[0]!.name;
    const targetId = params.targetId ?? enemiesInControlRange(ctx, state, op)[0]?.id;
    if (!targetId) return { ok: false, reason: 'no enemy operative within control range' };
    const r = startFight(ctx, state, op, weapon, params.meleeProfileName, targetId);
    if (!r.ok) return r;
    advanceFight(ctx, state);
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Close Quarters actions (Gallowdark + Tomb World — docs/DECISIONS.md D-002)
// ---------------------------------------------------------------------------

registerAction({
  id: 'Guard',
  name: 'Guard',
  ap: 1,
  type: 'universal',
  treatedAs: 'Shoot',
  sourceText:
    'GUARD 1AP: The operative goes on guard until any of the following are true: It performs any action, moves or is set up... This action is treated as a Shoot action. An operative cannot perform this action while it has a Conceal order, or while it\'s within control range of an enemy operative.',
  available: (_ctx, state) => state.map.closeQuarters,
  check(ctx, state, op) {
    if (!state.map.closeQuarters) return { ok: false, reason: 'Guard is a Close Quarters action' };
    if (op.order === 'conceal') return { ok: false, reason: 'cannot go on Guard with a Conceal order' };
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.onGuard = true;
    log(state, { kind: 'action', player: op.player, text: `${op.name} goes on Guard` });
    return { ok: true };
  },
});

registerAction({
  id: 'Hatchway Fight',
  name: 'Hatchway Fight',
  ap: 1,
  type: 'universal',
  treatedAs: 'Fight',
  sourceText:
    'HATCHWAY FIGHT 1AP: Fight with the active operative. In the Select Enemy Operative step, instead select an enemy operative within 2" of, and on the other side of, an open hatchway\'s access point the active operative is touching.',
  available: (_ctx, state) => state.map.closeQuarters,
  check(ctx, state, op, params) {
    if (!state.map.closeQuarters) return { ok: false, reason: 'Hatchway Fight is a Close Quarters action' };
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    const ap = touchingOpenAccessPoint(ctx, state, op);
    if (!ap) return { ok: false, reason: 'base is not touching an open hatchway’s access point' };
    if (!params.targetId) return { ok: false, reason: 'select an enemy operative across the hatchway' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = params.meleeWeaponName ?? weaponsOf(ctx, state, op, 'melee')[0]?.name;
    if (!weapon) return { ok: false, reason: 'operative has no melee weapon' };
    const r = startFight(ctx, state, op, weapon, params.meleeProfileName, params.targetId!, { hatchway: true });
    if (!r.ok) return r;
    advanceFight(ctx, state);
    return { ok: true };
  },
});

function touchingOpenAccessPoint(ctx: GameContext, state: GameState, op: OperativeState) {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  return index.parts.find(
    (p) =>
      p.role === 'accessPoint' &&
      p.state === 'open' &&
      baseGap(op.pos, c.base, op.rot, { x: (p.bounds.min.x + p.bounds.max.x) / 2, y: (p.bounds.min.y + p.bounds.max.y) / 2 }, { shape: 'round', mm: 20 }, 0) <= 0.6,
  );
}

registerAction({
  id: 'Operate Hatch',
  name: 'Operate Hatch',
  ap: 1,
  type: 'mission',
  sourceText:
    'OPERATE HATCH 1AP: Open or close a hatchway that\'s access point is within the operative\'s control range... An operative cannot perform this action while within control range of an enemy operative, or if that hatchway is open and its access point is within an enemy operative\'s control range.',
  available: (ctx, state) => terrain(ctx, state).parts.some((p) => p.role === 'accessPoint' && p.feature.kind.includes('hatch') !== false),
  check(ctx, state, op, params) {
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    const index = terrain(ctx, state);
    const part = params.partId ? index.byId.get(params.partId) : undefined;
    if (!part || part.role !== 'accessPoint') return { ok: false, reason: 'no hatchway access point selected' };
    const c = card(ctx, op);
    const centre = { x: (part.bounds.min.x + part.bounds.max.x) / 2, y: (part.bounds.min.y + part.bounds.max.y) / 2 };
    if (baseGap(op.pos, c.base, op.rot, centre, { shape: 'round', mm: 20 }, 0) > 1 + 1e-6)
      return { ok: false, reason: 'the access point is not within control range' };
    if (part.state === 'open') {
      const enemyNear = aliveOperatives(state, otherPlayer(op.player)).some((e) => {
        const ec = card(ctx, e);
        return baseGap(e.pos, ec.base, e.rot, centre, { shape: 'round', mm: 20 }, 0) <= 1 + 1e-6;
      });
      if (enemyNear) return { ok: false, reason: 'the open access point is within an enemy operative’s control range' };
    }
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const index = terrain(ctx, state);
    const part = index.byId.get(params.partId!)!;
    const next = part.state === 'open' ? 'closed' : 'open';
    state.terrainState[part.id] = { ...(state.terrainState[part.id] ?? {}), state: next };
    // The hatch part moves with its access point.
    for (const sibling of part.feature.parts) {
      if (sibling.role === 'hatch') state.terrainState[sibling.id] = { state: next };
    }
    log(state, { kind: 'action', player: op.player, text: `${op.name} ${next === 'open' ? 'opens' : 'closes'} a hatchway` });
    return { ok: true };
  },
});

registerAction({
  id: 'Breach',
  name: 'Breach',
  ap: 2,
  type: 'mission',
  sourceText:
    'BREACH 2AP: Open a closed breach point thats access point is within the operative\'s control range... Roll one D6 separately for each operative that\'s on the other side of the access point and has that access point within its control range: on a 4+, subtract 1 from that operative\'s APL stat until the end of its next activation and inflict damage on it equal to the dice result halved (rounding up).',
  available: (ctx, state) => terrain(ctx, state).parts.some((p) => p.role === 'breachWall'),
  check(ctx, state, op, params) {
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    const index = terrain(ctx, state);
    const part = params.partId ? index.byId.get(params.partId) : undefined;
    if (!part || part.role !== 'accessPoint') return { ok: false, reason: 'no breach point selected' };
    if (part.state === 'open') return { ok: false, reason: 'that breach point is already open' };
    // "It cannot perform this action for less than 2AP during an activation/counteraction in
    // which it performed the Charge or Shoot action (or vice versa)."
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const index = terrain(ctx, state);
    const part = index.byId.get(params.partId!)!;
    state.terrainState[part.id] = { state: 'open' };
    for (const sibling of part.feature.parts) {
      if (sibling.role === 'breachWall') state.terrainState[sibling.id] = { state: 'open' };
    }
    const centre = { x: (part.bounds.min.x + part.bounds.max.x) / 2, y: (part.bounds.min.y + part.bounds.max.y) / 2 };
    for (const other of aliveOperatives(state)) {
      if (other.id === op.id) continue;
      const oc = card(ctx, other);
      if (baseGap(other.pos, oc.base, other.rot, centre, { shape: 'round', mm: 20 }, 0) > 1 + 1e-6) continue;
      const roll = ctx.rng.d6();
      recordRoll(state, 'breach', [roll], op.player, `concussion vs ${other.name}`);
      if (roll >= 4) {
        other.aplMods.push(-1);
        state.effects.push({
          id: `breach${state.seq++}`,
          rule: 'breachConcussion',
          source: { kind: 'terrain', id: part.id },
          operativeId: other.id,
          expiry: { kind: 'endOfNextActivation', operativeId: other.id, armed: false },
        });
        inflictDamage(ctx, state, other, Math.ceil(roll / 2), 'other');
      }
    }
    log(state, { kind: 'action', player: op.player, text: `${op.name} breaches a breach point` });
    return { ok: true };
  },
});

/** AP cost after hook modifiers; "the minimum is always 0AP". */
export function actionCost(ctx: GameContext, state: GameState, op: OperativeState, action: ActionDef): number {
  const ev = ctx.hooks.emit('onActionCost', state, { state, operative: op, action: action.id, ap: action.ap });
  return Math.max(0, ev.ap);
}

/** Every action this operative could legally perform right now, with reasons for those it can't. */
export function availableActions(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
): { def: ActionDef; ap: number; ok: boolean; reason?: string }[] {
  const out: { def: ActionDef; ap: number; ok: boolean; reason?: string }[] = [];
  const apl = aplOf(ctx, state, op);
  for (const def of allActions()) {
    if (def.available && !def.available(ctx, state, op)) continue;
    const ap = actionCost(ctx, state, op, def);
    const restrictionKey = def.treatedAs ?? def.id;
    let ok = true;
    let reason: string | undefined;
    if (op.actionsThisActivation.includes(restrictionKey)) {
      ok = false;
      reason = `already performed ${restrictionKey} this activation`;
    } else if (op.apSpent + ap > apl) {
      ok = false;
      reason = `not enough AP (${apl - op.apSpent} left, needs ${ap})`;
    } else {
      const hookEv = ctx.hooks.emit('canPerformAction', state, { state, operative: op, action: def.id, allowed: true });
      if (!hookEv.allowed) {
        ok = false;
        reason = hookEv.reason ?? 'not allowed';
      }
    }
    out.push({ def, ap, ok, ...(reason ? { reason } : {}) });
  }
  return out;
}
