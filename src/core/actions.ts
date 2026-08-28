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
import { validateMove, type MoveLeg, type MoveOptions } from './movement.ts';
import { findProfile,
  aliveOperatives,
  aplOf,
  apBudgetOf,
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
import { effectiveRules, startShoot, advanceShoot, canSelectWeapon } from './sequences/shoot.ts';
import { startFight, advanceFight } from './sequences/fight.ts';
import { baseDistanceToPart, hasType, pointDistanceToPart } from './terrain.ts';
import { counteractMoveLeft } from './phases.ts';
import type { ActionParams } from './intents.ts';
import type { GameState, MarkerState, OperativeState, PlayerId, Vec2 } from './types.ts';
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
  // The cap is on the COUNTERACTION, not on each action in it. A flat 2" per action was only
  // ever right because a counteraction was only ever one action; the moment a rule grants a
  // second, Reposition 2" followed by Dash 2" moves 4".
  return counteracting ? { ...opts, hardCap: counteractMoveLeft(state, op) } : opts;
}

/**
 * Heavy, the half that was missing.
 *
 * Appendix › Heavy: "An operative cannot use this weapon in an activation or counteraction in
 * which it moved, AND IT CANNOT MOVE IN AN ACTIVATION OR COUNTERACTION IN WHICH IT USED THIS
 * WEAPON. If the rule is Heavy (x only), where x is a move action, only that move is allowed,
 * e.g. Heavy (Dash only)."
 *
 * Only the first clause existed, so shoot-and-scoot — fire from a vantage point for 1AP, then
 * Reposition back out of sight — was legal with all 127 Heavy profiles in the game.
 */
function heavyForbidsMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  action: MoveOptions['action'],
): string | undefined {
  const used = op.weaponsUsedThisActivation ?? [];
  if (used.length === 0) return undefined;
  for (const { weapon, profile: profileName } of used) {
    const w = weaponsOf(ctx, state, op, 'ranged').find((x) => x.name === weapon);
    // The PROFILE that was fired, not every profile the weapon has: a weapon whose second
    // profile is Heavy must not forbid a move because its first one was used.
    const profile = w ? findProfile(w, profileName) : undefined;
    if (!profile) continue;
    const heavy = effectiveRules(ctx, state, profile, { operative: op, weaponName: weapon }).find(
      (r) => r.id === 'Heavy',
    );
    if (!heavy) continue;
    if (heavy.only && heavy.only === action) continue; // "only that move is allowed"
    return `${weapon} is Heavy — it cannot move in an activation in which it used this weapon`;
  }
  return undefined;
}

function moveCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  opts: MoveOptions,
): { ok: boolean; reason?: string } {
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const heavy = heavyForbidsMove(ctx, state, op, opts.action);
  if (heavy) return { ok: false, reason: heavy };
  const v = validateMove(ctx, state, op, params.path, withCounteractCap(state, op, opts));
  return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
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
  const heavy = heavyForbidsMove(ctx, state, op, opts.action);
  if (heavy) return { ok: false, reason: heavy };
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
  checkMines(ctx, state, op, v.legs);
  // Spend against the counteraction's shared 2", not this action's own.
  const counteract = state.opState['counteract'];
  if (counteract?.['operativeId'] === op.id)
    counteract['movedInches'] = Number(counteract['movedInches'] ?? 0) + v.total;
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} performs ${label} (${v.total}")`,
    data: { operativeId: op.id, action: label, inches: v.total, legs: v.legs.length },
  });
  return { ok: true };
}

/** Mines: "The first time that marker is within an operative's control range, remove that
 *  marker and inflict D3+3 damage on that operative." */
/**
 * Mines, along the whole move rather than only where it stopped.
 *
 * `checkMines` was called once, after `op.pos` had been set to the end of the path, so a
 * Reposition straight over a mine did not fire it: the marker stayed on the board and could be
 * walked across again, all battle. The legs of the validated move are sampled at 0.2" — under
 * half the smallest base radius — so a base cannot step over one between two samples.
 */
function checkMines(ctx: GameContext, state: GameState, op: OperativeState, legs?: MoveLeg[]): void {
  const probes: { pos: Vec2; z: number }[] = [{ pos: op.pos, z: op.z }];
  for (const leg of legs ?? []) {
    const span = Math.hypot(leg.to.x - leg.from.x, leg.to.y - leg.from.y);
    const steps = Math.max(1, Math.ceil(span / 0.2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      probes.push({
        pos: { x: leg.from.x + (leg.to.x - leg.from.x) * t, y: leg.from.y + (leg.to.y - leg.from.y) * t },
        z: t < 1 ? leg.fromZ : leg.toZ,
      });
    }
  }
  for (const marker of Object.values(state.markers)) {
    if (marker.kind !== 'mine') continue;
    if (marker.flags['triggered']) continue;
    if (!probes.some((p) => markerContestedBy(ctx, state, marker, { ...op, pos: p.pos, z: p.z }))) continue;
    marker.flags['triggered'] = true;
    const d3 = ctx.rng.d3();
    recordRoll(state, 'mine', [d3], op.player, 'Mines D3+3');
    delete state.markers[marker.id];
    inflictDamage(ctx, state, op, d3 + 3, 'mine');
    log(state, { kind: 'action', player: op.player, text: `${op.letter} triggers Mines: ${d3}+3 damage` });
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
    // "Remove a marker THE ACTIVE OPERATIVE CONTROLS." Asking only whether the TEAM controls
    // it — a question answered by the total APL of everyone contesting it — let any operative
    // anywhere on the board lift a marker a team-mate was standing on, and `perform` then
    // teleported the marker to it.
    if (!markerContestedBy(ctx, state, marker, op))
      return { ok: false, reason: 'that marker is not within this operative\'s control range' };
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
    log(state, { kind: 'action', player: op.player, text: `${op.letter} picks up the ${marker.kind} marker` });
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
    log(state, { kind: 'action', player: op.player, text: `${op.letter} places the ${marker.kind} marker` });
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
    // Off `effectiveRules`, not the printed profile: a hook that grants or removes Heavy was
    // invisible to this test.
    const heavyRules = profile
      ? effectiveRules(ctx, state, profile, { operative: op, weaponName: params.weaponName! })
      : [];
    const heavy = heavyRules.find((r) => r.id === 'Heavy');
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
    log(state, { kind: 'action', player: op.player, text: `${op.letter} goes on Guard` });
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
    // "…instead select an enemy operative WITHIN 2" OF, AND ON THE OTHER SIDE OF, an open
    // hatchway's access point the active operative is touching." Neither half was checked, so
    // this was a 1AP Fight against any enemy anywhere on the board.
    const target = state.operatives[params.targetId];
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select an enemy operative across the hatchway' };
    const centre = { x: (ap.bounds.min.x + ap.bounds.max.x) / 2, y: (ap.bounds.min.y + ap.bounds.max.y) / 2 };
    const tc = card(ctx, target);
    if (baseGap(target.pos, tc.base, target.rot, centre, { shape: 'round', mm: 20 }, 0) > 2 + 1e-6)
      return { ok: false, reason: 'the enemy operative is more than 2" from the access point' };
    const side = acrossFrom(ap, centre);
    if (side(target.pos) === side(op.pos))
      return { ok: false, reason: 'the enemy operative is on the same side of the hatchway' };
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

// ---------------------------------------------------------------------------
// Killzone: Volkus (Cityfight)
// ---------------------------------------------------------------------------

/** The door part this operative's base is touching, if any. */
function touchingDoor(ctx: GameContext, state: GameState, op: OperativeState) {
  // "on the killzone floor" is a condition on the TARGET, but the extractor gives a door the
  // whole wall band (z 0..4 on a stronghold), so without this an operative standing on the
  // level-1 Vantage floor at z=3 registers as touching the doorway underneath it.
  if (op.z > 1e-6) return undefined;
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  return index.parts.find((p) => p.role === 'door' && baseDistanceToPart(op.pos, c.base, op.rot, p) <= 1e-6);
}

registerAction({
  id: 'Door Fight',
  name: 'Door Fight',
  ap: 1,
  type: 'universal',
  treatedAs: 'Fight',
  sourceText:
    'DOOR FIGHT 1AP: Fight with the active operative. In the Select Enemy Operative step, instead '
    + 'select an enemy operative on the killzone floor and within 2" of, and on the other side of, a '
    + 'door the active operative is touching. For the duration of that action, those operatives are '
    + 'treated as being within each other\u2019s control range. This action is treated as a Fight '
    + 'action. An operative cannot perform this action while within control range of an enemy '
    + 'operative, or if its base isn\u2019t touching a door.',
  // NOT `killzone === 'volkus'` alone: tests/fixtures.ts `testMap()` is killzone 'volkus' with no
  // terrain at all, and that predicate would offer Door Fight in every synthetic fixture in the
  // suite and hand the AI a candidate to probe on every board. Gate on the data actually holding
  // a door, the way Operate Hatch gates on an access point existing.
  available: (ctx, state) =>
    state.map.killzone === 'volkus' && terrain(ctx, state).parts.some((p) => p.role === 'door'),
  check(ctx, state, op, params) {
    if (state.map.killzone !== 'volkus')
      return { ok: false, reason: 'Door Fight is a Killzone: Volkus action' };
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    const door = touchingDoor(ctx, state, op);
    if (!door) return { ok: false, reason: 'its base isn’t touching a door' };
    if (!params.targetId) return { ok: false, reason: 'select an enemy operative through the door' };
    const target = state.operatives[params.targetId];
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select an enemy operative through the door' };
    if (target.z > 1e-6) return { ok: false, reason: 'the enemy operative is not on the killzone floor' };
    const tc = card(ctx, target);
    if (baseDistanceToPart(target.pos, tc.base, target.rot, door) > 2 + 1e-6)
      return { ok: false, reason: 'the enemy operative is more than 2" from the door' };
    const centre = { x: (door.bounds.min.x + door.bounds.max.x) / 2, y: (door.bounds.min.y + door.bounds.max.y) / 2 };
    const side = acrossFrom(door, centre);
    if (side(target.pos) === side(op.pos))
      return { ok: false, reason: 'the enemy operative is on the same side of the door' };
    if (weaponsOf(ctx, state, op, 'melee').length === 0)
      return { ok: false, reason: 'operative has no melee weapon' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = params.meleeWeaponName ?? weaponsOf(ctx, state, op, 'melee')[0]?.name;
    if (!weapon) return { ok: false, reason: 'operative has no melee weapon' };
    // "For the duration of that action, those operatives are treated as being within each
    // other's control range" — the same bypass Hatchway Fight uses.
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
  available: (ctx, state) =>
    terrain(ctx, state).parts.some((p) => p.role === 'accessPoint' && p.opensAs !== 'breachWall'),
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
    log(state, { kind: 'action', player: op.player, text: `${op.letter} ${next === 'open' ? 'opens' : 'closes'} a hatchway` });
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
  available: (ctx, state) =>
    terrain(ctx, state).parts.some(
      (p) => p.role === 'accessPoint' && p.opensAs === 'breachWall' && p.state !== 'open',
    ),
  check(ctx, state, op, params) {
    if (engaged(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    const index = terrain(ctx, state);
    const part = params.partId ? index.byId.get(params.partId) : undefined;
    if (!part || part.role !== 'accessPoint') return { ok: false, reason: 'no breach point selected' };
    if (part.opensAs !== 'breachWall') return { ok: false, reason: 'that access point is a hatchway, not a breach point' };
    if (part.state === 'open') return { ok: false, reason: 'that breach point is already open' };
    // "Open a closed breach point that's access point is WITHIN THE OPERATIVE'S CONTROL RANGE."
    const bc = card(ctx, op);
    const bCentre = { x: (part.bounds.min.x + part.bounds.max.x) / 2, y: (part.bounds.min.y + part.bounds.max.y) / 2 };
    if (baseGap(op.pos, bc.base, op.rot, bCentre, { shape: 'round', mm: 20 }, 0) > 1 + 1e-6)
      return { ok: false, reason: 'the breach point is not within control range' };
    // "It cannot perform this action for less than 2AP during an activation/counteraction in
    // which it performed the Charge or Shoot action (or vice versa)."
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const index = terrain(ctx, state);
    const part = index.byId.get(params.partId!)!;
    state.terrainState[part.id] = { state: 'open' };
    const centre = { x: (part.bounds.min.x + part.bounds.max.x) / 2, y: (part.bounds.min.y + part.bounds.max.y) / 2 };
    // "Roll one D6 separately for each operative that's ON THE OTHER SIDE of the access point
    // and has that access point within its control range." The side test was missing, so the
    // blast caught the breacher's own team standing behind it.
    const side = acrossFrom(part, centre);
    const mySide = side(op.pos);
    for (const other of aliveOperatives(state)) {
      if (other.id === op.id) continue;
      if (side(other.pos) === mySide) continue;
      const oc = card(ctx, other);
      if (baseGap(other.pos, oc.base, other.rot, centre, { shape: 'round', mm: 20 }, 0) > 1 + 1e-6) continue;
      const roll = ctx.rng.d6();
      recordRoll(state, 'breach', [roll], op.player, `concussion vs ${other.letter}`);
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
    log(state, { kind: 'action', player: op.player, text: `${op.letter} breaches a breach point` });
    return { ok: true };
  },
});

/**
 * Which side of a wall a point is on.
 *
 * An access point is a rectangle set into a wall; its LONG axis runs along the wall, so the
 * short axis is the direction that crosses it. Returns a sign, or 0 for a point on the line.
 */
function acrossFrom(part: { bounds: { min: Vec2; max: Vec2 } }, centre: Vec2): (p: Vec2) => number {
  const w = part.bounds.max.x - part.bounds.min.x;
  const h = part.bounds.max.y - part.bounds.min.y;
  return w >= h
    ? (p: Vec2) => Math.sign(p.y - centre.y) // wall runs along x, so crossing is in y
    : (p: Vec2) => Math.sign(p.x - centre.x);
}

/** AP cost after hook modifiers; "the minimum is always 0AP". */
export function actionCost(ctx: GameContext, state: GameState, op: OperativeState, action: ActionDef): number {
  const ev = ctx.hooks.emit('onActionCost', state, { state, operative: op, action: action.id, ap: action.ap });
  return Math.max(0, ev.ap);
}

/** Every action this operative could legally perform right now, with reasons for those it can't. */
/**
 * Which actions need something pointed at before they can be checked at all.
 *
 * `availableActions` deliberately does not run `def.check`, because most checks need params
 * the caller has not chosen yet. That leaves a trap for any UI that renders its result as a
 * menu: `Reposition` while engaged, `Fall Back` while not engaged, `Operate Hatch` with no
 * access point in range and `Breach` on an already-open point all come back `ok: true` and
 * are then rejected on dispatch. `actionAvailability` closes it.
 */
export type ActionTargetKind = 'point' | 'operative' | 'part' | 'marker' | 'markerChoice';

const NEEDS_TARGET: Record<string, ActionTargetKind> = {
  Reposition: 'point',
  Dash: 'point',
  'Fall Back': 'point',
  Charge: 'point',
  'Move With Barricade': 'point',
  Shoot: 'operative',
  Fight: 'operative',
  'Hatchway Fight': 'operative',
  'Operate Hatch': 'part',
  Breach: 'part',
  'Pick Up Marker': 'marker',
  'Place Marker': 'point',
  // Crit-op and tac-op mission actions. Each takes `markerId`, and until this landed the UI
  // rendered every one of them disabled: the branch below returns early on `needsTarget`, and
  // `play.tsx` had no way to aim one, so it fell through to `def.check(ctx, state, op, {})`,
  // whose reason is always "select an objective marker". Five of the nine crit ops therefore
  // scored 0VP for a human player for the whole battle (docs/RULES-AUDIT.md W-05).
  Secure: 'marker',
  Loot: 'marker',
  'Initiate Transmission': 'marker',
  Download: 'marker',
  'Compile Data': 'marker',
  'Send Data': 'marker',
  Reboot: 'marker',
  'Plant Device': 'marker',
  Retrieve: 'marker',
  Clear: 'marker',
  'Pick Up Intelligence': 'marker',
  // "If the centre objective marker has it, move it to either player's objective marker (your
  // choice)" — the param is `choice`, and on the other leg the rule gives no choice at all.
  'Move Orb': 'markerChoice',
};

/** A marker as the player sees it named. */
function markerLabel(m: MarkerState): string {
  const owner = m.owner ? ` (${m.owner})` : '';
  return m.kind === 'objective' ? `objective ${m.id}${owner}` : `${m.kind} ${m.id}${owner}`;
}

export interface ActionTargetOption {
  id: string;
  label: string;
  params: ActionParams;
}

/**
 * Every parameter set this action would accept right now, judged by the action's own `check`.
 *
 * The counterpart of `validTargets` for the parameterised actions. The UI must never decide
 * which markers an action considers — Download refuses your own objectives, Reboot wants an
 * inert one, Pick Up Intelligence an `intelligence` marker and Ammo Resupply an `ammoCache`.
 * Only `check` knows, and CLAUDE.md forbids the UI re-implementing a core selector.
 */
export function actionTargetOptions(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  def: ActionDef,
): ActionTargetOption[] {
  switch (NEEDS_TARGET[def.id]) {
    case 'marker':
      return Object.values(state.markers)
        .map((m) => ({ id: m.id, label: markerLabel(m), params: { markerId: m.id } as ActionParams }))
        .filter((o) => def.check(ctx, state, op, o.params).ok);
    case 'markerChoice': {
      // "If a player's objective marker has it, move it to the centre objective marker" — no
      // choice clause, unlike the centre leg's "(your choice)". `check` accepts `{}` on that
      // leg and IGNORES a `choice` param, so enumerating markers there would offer three
      // buttons that all do the same thing.
      if (def.check(ctx, state, op, {}).ok)
        return [{ id: '', label: 'the centre objective marker', params: {} }];
      const out: ActionTargetOption[] = [];
      for (const m of Object.values(state.markers)) {
        if (m.kind !== 'objective') continue;
        const params: ActionParams = { choice: m.id };
        if (def.check(ctx, state, op, params).ok) out.push({ id: m.id, label: markerLabel(m), params });
      }
      return out;
    }
    case 'part':
      return terrain(ctx, state)
        .parts.filter((part) => part.role === 'accessPoint')
        .map((part) => ({
          id: part.id,
          label: `access point ${part.id}`,
          params: { partId: part.id } as ActionParams,
        }))
        .filter((o) => def.check(ctx, state, op, o.params).ok);
    case 'operative':
      return aliveOperatives(state)
        .filter((o) => o.id !== op.id)
        .map((o) => ({
          id: o.id,
          label: o.letter,
          params: { targetOperativeId: o.id, targetId: o.id } as ActionParams,
        }))
        .filter((o) => def.check(ctx, state, op, o.params).ok);
    default:
      return [];
  }
}

/**
 * Why this action has no legal target, in the operative's terms rather than the parameter's.
 *
 * `check(ctx, state, op, {})` is the wrong thing to report: for Secure it says "select an
 * objective marker" when the truth is "the active operative does not control that objective
 * marker". Ask the nearest candidate of the right kind instead, and fall back to the bare form
 * only when the killzone holds no candidate at all.
 */
function noTargetReason(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  def: ActionDef,
  kind: ActionTargetKind,
): string {
  const near =
    kind === 'part'
      ? terrain(ctx, state)
          .parts.filter((part) => part.role === 'accessPoint')
          .map((part) => ({ params: { partId: part.id } as ActionParams, d: pointDistanceToPart(op.pos, part) }))
      : Object.values(state.markers).map((m) => ({
          params: (kind === 'markerChoice' ? { choice: m.id } : { markerId: m.id }) as ActionParams,
          d: dist(op.pos, m.pos),
        }));
  near.sort((a, b) => a.d - b.d);
  const first = near[0];
  const verdict = first ? def.check(ctx, state, op, first.params) : def.check(ctx, state, op, {});
  return verdict.reason ?? 'no legal target';
}

export interface ActionAvailability {
  def: ActionDef;
  ap: number;
  /** False only when the action is impossible whatever it is pointed at. */
  ok: boolean;
  reason?: string;
  /** Set when the action must be aimed before it can be dispatched. */
  needsTarget?: ActionTargetKind;
}

/**
 * Every action this operative could perform, with `def.check` actually run for the ones that
 * take no parameters — so a menu built from this never offers a control that the reducer will
 * reject for a reason the caller could have known.
 */
export function actionAvailability(ctx: GameContext, state: GameState, op: OperativeState): ActionAvailability[] {
  return availableActions(ctx, state, op).map((row) => {
    const needsTarget = NEEDS_TARGET[row.def.id];
    // An action that must be AIMED cannot be judged before it has been: `check` with empty
    // params always fails, and its reason is about the missing parameter, not about the
    // operative. Report it as needing a target and let the caller judge the aimed version
    // with `validateMove` / `validTargets`.
    //
    // Do NOT try to sort "it needs a target" from "it is genuinely impossible" by reading the
    // reason string. That was tried, and it disabled every weapon in the game for a whole
    // battle, because Shoot's reason is "weapon and target required" and the pattern did not
    // include it.
    // A marker / access-point action CAN be judged before it is aimed, by asking `check` about
    // every candidate. Doing so is what stops the ids added above from becoming enabled dead
    // buttons — the failure Pick Up Marker showed for the whole of this branch's life: it is
    // offered while the operative carries nothing and stands 12" from every marker, and one
    // click writes "no such marker" into `state.rejected`.
    //
    // `point` and `operative` keep the early return. Movement is judged by `validateMove` and
    // Shoot/Fight by `validTargets`, both of which the caller already runs, and enumerating
    // every operative through `Shoot.check` on each render is not worth its cost.
    if (needsTarget === 'marker' || needsTarget === 'markerChoice' || needsTarget === 'part') {
      const opts = actionTargetOptions(ctx, state, op, row.def);
      if (opts.length > 0) return { ...row, needsTarget };
      return { ...row, ok: false, needsTarget, reason: noTargetReason(ctx, state, op, row.def, needsTarget) };
    }
    if (needsTarget) return { ...row, needsTarget };
    if (!row.ok) return row;
    // A parameter-free action can be checked right now, and often fails: Guard while engaged,
    // Pass in the wrong step. Without this the caller offers a control the reducer rejects.
    const verdict = row.def.check(ctx, state, op, {});
    return verdict.ok ? row : { ...row, ok: false, ...(verdict.reason ? { reason: verdict.reason } : {}) };
  });
}

export function availableActions(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
): { def: ActionDef; ap: number; ok: boolean; reason?: string }[] {
  const out: { def: ActionDef; ap: number; ok: boolean; reason?: string }[] = [];
  // The AP an activation may spend: the APL stat plus any granted free AP (D-100).
  const apl = apBudgetOf(ctx, state, op);
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
