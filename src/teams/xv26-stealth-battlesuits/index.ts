/**
 * XV26 STEALTH BATTLESUITS — T'au Empire.
 * https://wahapedia.ru/kill-team3/kill-teams/xv26-stealth-battlesuits/
 *
 * Every printed string is read from `data/teams/xv26-stealth-battlesuits.json` — never retyped.
 *
 * Two faction rules carry the team:
 *   · **Kauyon** grades Accurate x by how deep into YOUR half the target is standing
 *     (`kauyonAccurate`, which the SHAS'VRE's For the Greater Good then tops up), and
 *   · **Stealth Fields** makes a Conceal-order battlesuit unselectable beyond 3" and discounts
 *     its Fall Back.
 *
 * SAVIOUR PROTOCOLS is word-for-word the Pathfinders' ploy (only the team keyword differs), so
 * it reuses batch 1's `onSelectTarget` seam unchanged.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import {
  EXPLOSIVE_ID,
  grenadeAllowance,
  grenadeWeapon,
  withGrenadeBudgetIgnored,
} from '../../core/equipment/grenades.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseGapToPoly, baseWhollyWithin, baseWithin, dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  aliveOperatives,
  body,
  inControlRange,
  log,
  markerContestedBy,
  moveOf,
  recordRoll,
} from '../../core/state.ts';
import { checkTarget } from '../../core/sequences/shoot.ts';
import { isVisible } from '../../core/visibility.ts';
import type { ShootSequence } from '../../core/sequences/types.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PendingDecision,
  PlayerId,
  Poly,
  Vec2,
  WeaponProfile,
  WeaponRule,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  makeTeamHooks,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  posFromData,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('xv26-stealth-battlesuits');
const EPS = 1e-6;

export const KW = 'XV26 STEALTH BATTLESUIT';
const DRONE = 'DRONE';

// ---------------------------------------------------------------------------
// Printed text (read, never retyped)
// ---------------------------------------------------------------------------

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const SHAS_VRE = 'xv26-stealth-battlesuits.shas-vre';
export const DESIGNATOR = 'xv26-stealth-battlesuits.designator';
export const INFILTRATOR = 'xv26-stealth-battlesuits.infiltrator';
export const LIBERATOR = 'xv26-stealth-battlesuits.liberator';
export const LODESTAR = 'xv26-stealth-battlesuits.lodestar';
export const NEUTRALISER = 'xv26-stealth-battlesuits.neutraliser';
export const MV15_GUN_DRONE = 'xv26-stealth-battlesuits.mv15-gun-drone';
export const MV75_MARKER_DRONE = 'xv26-stealth-battlesuits.mv75-marker-drone';

export const RULE = {
  kauyon: 'xv26-stealth-battlesuits.rule.kauyon',
  stealthFields: 'xv26-stealth-battlesuits.rule.stealth-fields',
} as const;

export const SP = {
  patientHunters: 'xv26-stealth-battlesuits.sp.patient-hunters',
  prepareAmbush: 'xv26-stealth-battlesuits.sp.prepare-ambush',
  bondsOfUnity: 'xv26-stealth-battlesuits.sp.bonds-of-unity',
  holowaveCountermeasures: 'xv26-stealth-battlesuits.sp.holowave-countermeasures',
} as const;

export const FP = {
  vectoredRetroThrusters: 'xv26-stealth-battlesuits.fp.vectored-retro-thrusters',
  engageJetPack: 'xv26-stealth-battlesuits.fp.engage-jet-pack',
  ghostshroud: 'xv26-stealth-battlesuits.fp.ghostshroud',
  saviourProtocols: 'xv26-stealth-battlesuits.fp.saviour-protocols',
} as const;

export const EQ = {
  multitrackers: 'xv26-stealth-battlesuits.eq.xv26-multitrackers',
  blacksunFilters: 'xv26-stealth-battlesuits.eq.advanced-blacksun-filters',
  counterNetworkJammers: 'xv26-stealth-battlesuits.eq.counter-network-jammers',
  hardwiredTargetLocks: 'xv26-stealth-battlesuits.eq.hardwired-target-locks',
} as const;

export const AB = {
  droneController: 'xv26-stealth-battlesuits.shas-vre.xv26-drone-controller',
  forTheGreaterGood: 'xv26-stealth-battlesuits.shas-vre.for-the-greater-good',
  markerlightDesignator: 'xv26-stealth-battlesuits.designator.markerlight',
  markerlightDrone: 'xv26-stealth-battlesuits.mv75-marker-drone.markerlight',
  covertProtocols: 'xv26-stealth-battlesuits.infiltrator.covert-protocols',
  grenadier: 'xv26-stealth-battlesuits.liberator.grenadier',
  electrochaffLauncher: 'xv26-stealth-battlesuits.lodestar.electrochaff-launcher',
  homingBeacon: 'xv26-stealth-battlesuits.lodestar.homing-beacon',
  multispectrum: 'xv26-stealth-battlesuits.neutraliser.multispectrum-sensor-package',
  droneGun: 'xv26-stealth-battlesuits.mv15-gun-drone.drone',
  droneMarker: 'xv26-stealth-battlesuits.mv75-marker-drone.drone',
} as const;

export const ACT = {
  focusedMarkerligh: 'xv26-stealth-battlesuits.designator.act.focused-markerligh',
  systemJam: 'xv26-stealth-battlesuits.neutraliser.act.system-jam',
  photonGrenadeLauncher: 'xv26-stealth-battlesuits.mv15-gun-drone.act.photon-grenade-launcher',
} as const;

/** The two STRATEGIC GAMBITs this team prints outside its four strategy ploys. */
export const DRONE_CONTROLLER_GAMBIT = 'xv26-stealth-battlesuits.gambit.drone-controller';
export const JAMMERS_GAMBIT = 'xv26-stealth-battlesuits.gambit.counter-network-jammers';

/** The counteraction carve-out HARDWIRED TARGET LOCKS needs (docs/DECISIONS.md D-021). */
export const HARDWIRED_SHOOT = 'Shoot (Hardwired Target Locks)';
/** VECTORED RETRO-THRUSTERS' second half, on the CHARGING enemy operative (D-021). */
export const THRUSTER_REPOSITION = 'Reposition (Vectored Retro-Thrusters)';
/** LIBERATOR › Grenadier's own Smoke/Stun Grenade actions (the Hearthkyn GRENADIER shape). */
export const GRENADIER_SMOKE = 'Smoke Grenade (Grenadier)';
export const GRENADIER_STUN = 'Stun Grenade (Grenadier)';

/** Effect / scratch keys. */
const E = {
  ambushSeek: 'xv26.ambushSeek',
  bondsApl: 'xv26.bondsApl',
  bondsHit: 'xv26.bondsHit',
  bondsMove: 'xv26.bondsMove',
  jetPack: 'xv26.jetPack',
  jammersMarker: 'xv26.jammersMarker',
  multitracker: 'xv26.multitracker',
  droneControlled: 'xv26.droneControlled',
  focusedMarkerlight: 'xv26.focusedMarkerlight',
  focusedMarkerlightLive: 'xv26.focusedMarkerlightLive',
  electrochaff: 'xv26.electrochaff',
  systemJam: 'xv26.systemJam',
  photonGrenade: 'xv26.photonGrenade',
} as const;

export const BONDS_DECISION = 'xv26.bondsOfUnity';

const AMBUSH_MARKER = (player: PlayerId): string => `xv26.ambush.${player}`;
const BEACON_MARKER = (player: PlayerId): string => `xv26.homingBeacon.${player}`;

/**
 * Clauses of a printed rule that the hook surface cannot express. Exported so the tests can
 * assert the list has not silently grown, and so docs/TEAM-STATUS.md is checkable.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [FP.engageJetPack]:
    '"you can ignore the vertical distance they move during one climb and one drop" — `onMoveRules` carries ' +
    '`ignoreClimbCost`/`ignoreDropInches` but is DECLARED AND NEVER EMITTED, and `onMoveDistance` only scales the ' +
    'whole allowance (validateMove keeps its legs to itself). The ploy records an effect for the UI and nothing else.',
  [`${FP.vectoredRetroThrusters}.enemyReposition`]:
    '"that enemy operative can immediately perform a free Reposition action using any remaining move distance it ' +
    'had from that first Charge action" — implemented as an extra AP on the OPPONENT\'s operative restricted to ' +
    '`Reposition (Vectored Retro-Thrusters)`, so a human opponent can take it; `src/ai/legal.ts` never builds ' +
    'movement params for a non-universal action id, so an AI opponent never does (docs/DECISIONS.md D-021).',
  [`${AB.multispectrum}.changeOrder`]:
    '"…can immediately do one of the following: … Change its order." — only the free Dash branch is offered. ' +
    'There is no intent that changes an order outside an activation and `onOrderChange` is declared and never ' +
    'emitted, so the alternative has no channel; the Dash branch\'s own "(in an order of your choice)" is moot ' +
    'because D-013 defers the free action to that operative\'s next activation, where the order is chosen anyway.',
  [`${AB.multispectrum}.endOfMove`]:
    '"Each friendly operative that performs the Dash action cannot end that move within 3" of an enemy operative" — ' +
    'no hook constrains where a move ENDS; the predicate is exported as `multispectrumDashEndLegal` for the UI.',
  [`${AB.droneGun}.head`]:
    '"Whenever determining what\'s visible to this operative, the round disc at the top of the miniature is its ' +
    'head" — `body()`/`modelHeight` are core and derive the head point from the base class (D-005); a datacard may ' +
    'override `height` but the printed cards do not.',
  [`${AB.droneGun}.ops`]:
    '"This operative is ignored for your opponent\'s kill/elimination op … escape/survive" — `src/core/ops/**` owns ' +
    'those and emits nothing a team rule can answer (the Spectre Squad Expendable gap).',
  [`${AB.droneGun}.meleeWeapons`]:
    '"This operative cannot use any weapons that aren\'t on its datacard" — enforced for RANGED weapons through ' +
    '`onSelectWeapon`; `weaponsOf` appends `grantedWeapons` after `availableWeapons`, so a granted MELEE weapon has ' +
    'no seam (the Sanctifiers CHERUB / Exodite Beast gap). Nothing grants a DRONE a weapon today.',
  [`${AB.homingBeacon}.droneExclusion`]:
    '"Operatives (excluding DRONE) can perform the Pick Up Marker action on that marker" — `canPerformAction` is not ' +
    'told which marker, so the exclusion rides the Drone rule\'s own action list (which already omits Pick Up ' +
    'Marker) and is therefore enforced for XV26 DRONEs only.',
};

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape =>
  T.card(op)?.base ?? { shape: 'round', mm: 32 };

const isDrone = (T: TeamHooks, op: OperativeState): boolean => T.kw(op, DRONE);

/** Friendly XV26 STEALTH BATTLESUIT operative, the scope almost every rule is written in. */
const mineKw = (T: TeamHooks, op: OperativeState): boolean => T.mineKw(op, KW);

/** Friendly XV26 STEALTH BATTLESUIT operative "(excluding DRONE)". */
const mineSuit = (T: TeamHooks, op: OperativeState): boolean => mineKw(T, op) && !isDrone(T, op);

function visibleBetween(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, a), body(T.ctx, b)).visible;
}

const territoryOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.territories[state.setup.dropZone[player] ?? player] ?? [];
const dropZoneOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

function gapToPolys(pos: Vec2, rot: number, base: BaseShape, polys: Poly[]): number {
  if (polys.length === 0) return Infinity;
  return Math.min(...polys.map((p) => baseGapToPoly(pos, base, rot, p)));
}

/** "Within X" for an area: any part of the base inside it, or within X of it. */
function withinOf(pos: Vec2, rot: number, base: BaseShape, polys: Poly[], inches: number): boolean {
  if (baseWithin(pos, base, rot, polys)) return true;
  return gapToPolys(pos, rot, base, polys) <= inches + EPS;
}

const markerOf = (state: GameState, id: string): MarkerState | undefined => state.markers[id];

// ---------------------------------------------------------------------------
// Kauyon
// ---------------------------------------------------------------------------

/**
 * "X is determined by that enemy operative's location:
 *    Within 3" of your territory → Accurate 1
 *    Within your territory       → Accurate 2
 *    Within 3" of your drop zone → Accurate 3"
 *
 * The three rows are nested (a target within 3" of the drop zone is also inside the territory),
 * so the deepest row that applies is the one used.
 *
 * For the Greater Good then tops it up: "add 1 to the result if 2 or more friendly XV26 STEALTH
 * BATTLESUIT operatives (excluding DRONE) are incapacitated (to a maximum of Accurate 3). Note
 * that you must have a minimum of Accurate 1 to use this rule."
 */
export function kauyonAccurate(T: TeamHooks, state: GameState, target: OperativeState): number {
  const base = baseOf(T, target);
  const territory = territoryOf(state, T.player);
  const drop = dropZoneOf(state, T.player);
  let x = 0;
  if (withinOf(target.pos, target.rot, base, drop, 3)) x = 3;
  else if (baseWithin(target.pos, base, target.rot, territory)) x = 2;
  else if (withinOf(target.pos, target.rot, base, territory, 3)) x = 1;
  if (x >= 1 && greaterGoodActive(T, state)) x = Math.min(3, x + 1);
  return x;
}

/** For the Greater Good's condition: the SHAS'VRE in the killzone and 2+ suits incapacitated. */
export function greaterGoodActive(T: TeamHooks, state: GameState): boolean {
  const shasVre = T.friendlies(state).some((o) => o.datacardId === SHAS_VRE);
  if (!shasVre) return false;
  let down = 0;
  for (const id of state.teams[T.player].operativeIds) {
    const op = state.operatives[id];
    if (!op || (!op.removed && !op.incapacitated)) continue;
    if (isDrone(T, op) || !T.kw(op, KW)) continue;
    down++;
  }
  return down >= 2;
}

// ---------------------------------------------------------------------------
// Markerlight
// ---------------------------------------------------------------------------

/** A weapon-independent target check: "an enemy operative is a valid target for this operative". */
const MARKERLIGHT_PROFILE: WeaponProfile = { type: 'ranged', atk: 0, hit: 6, dmgN: 0, dmgC: 0, rules: [] };

/**
 * "Whenever an enemy operative is a valid target for this operative, or is visible to this
 * operative and within 2" of your Ambush marker (see Prepare Ambush strategy ploy), it's marked."
 *
 * "Note that an operative can be a valid target for this operative even if this operative isn't
 * the active operative" — so the engine's own Select Valid Target test is run from the
 * MARKERLIGHT carrier's position, with a rules-free ranged profile (the carrier's validity does
 * not depend on a weapon; the MV75 MARKER DRONE has no ranged weapon at all).
 */
export function isMarked(T: TeamHooks, state: GameState, target: OperativeState): boolean {
  if (!T.ctx || target.player === T.player) return false;
  const ambush = markerOf(state, AMBUSH_MARKER(T.player));
  for (const carrier of T.friendlies(state)) {
    if (carrier.datacardId !== DESIGNATOR && carrier.datacardId !== MV75_MARKER_DRONE) continue;
    if (ambush && T.markerGap(target, ambush) <= 2 + EPS && visibleBetween(T, state, carrier, target)) return true;
    const chk = checkTarget(T.ctx, state, carrier, target, MARKERLIGHT_PROFILE, MARKERLIGHT_PROFILE.rules);
    if (chk.valid) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drone
// ---------------------------------------------------------------------------

/** "This operative cannot perform any actions other than …" — the printed list, per DRONE. */
const DRONE_ACTIONS: Record<string, string[]> = {
  [MV15_GUN_DRONE]: ['Charge', 'Dash', 'Fall Back', 'Fight', ACT.photonGrenadeLauncher, 'Reposition', 'Shoot'],
  [MV75_MARKER_DRONE]: ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'Shoot'],
};

/**
 * XV26 Drone Controller: "ignore the first two bullet points of its Drone rule (this takes
 * precedence over that rule)" — the action restriction and the objective-control APL penalty.
 */
const droneRuleSuspended = (state: GameState, op: OperativeState): boolean =>
  effectOn(state, op.id, E.droneControlled) !== undefined;

/** The first two bullet points of the printed Drone rule, sliced out for the gambit's tooltip. */
export const DRONE_FIRST_TWO_BULLETS: string = abilityText(MV15_GUN_DRONE, AB.droneGun)
  .split(/\n\s*\n/)
  .filter((s) => s.trim().length > 0)
  .slice(0, 2)
  .join(' ');

// ---------------------------------------------------------------------------
// Faction rules and datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Kauyon (faction rule) + For the Greater Good (SHAS'VRE)
  // =========================================================================
  reg.on('onWeaponRules', T.bind(RULE.kauyon, 12), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating || !mineKw(T, ev.operative)) return;
    const target = ev.target;
    if (!target || target.player === T.player) return;
    const x = kauyonAccurate(T, ev.state, target);
    if (x <= 0) return;
    ev.rules.push(ruleTag('Accurate', x, `Accurate ${x} (Kauyon)`));
  });

  // =========================================================================
  // Stealth Fields (faction rule)
  // =========================================================================
  /*
   * "Whenever a friendly XV26 STEALTH BATTLESUIT operative has a Conceal order, it cannot be
   *  visible to enemy operatives more than 3" from it (this takes precedence over all other
   *  rules)."
   *
   * PARTIAL: `onValidTarget` is the Select Valid Target step, which is where the rule bites for
   * shooting (and, through `checkTarget`, for every team rule that asks whether a battlesuit is a
   * valid target). Bare `isVisible` reads elsewhere in the engine are core-only and see no hook,
   * so a rule phrased "visible to" rather than "a valid target for" still sees the battlesuit.
   * Registered at a high priority so "this takes precedence over all other rules" holds.
   */
  reg.on('onValidTarget', T.bind(RULE.stealthFields, 60), (ev) => {
    if (!mineKw(T, ev.target) || ev.target.order !== 'conceal') return;
    if (ev.attacker.player === T.player) return; // "…to ENEMY operatives"
    const viewer = ev.viewFrom ?? ev.attacker;
    if (T.gap(viewer, ev.target) <= 3 + EPS) return;
    ev.forceVisible = false;
    ev.valid = false;
    ev.reason = 'Stealth Fields: not visible to enemy operatives more than 3" away';
  });

  // "…it can perform the Fall Back action for 1 less AP."
  reg.on('onActionCost', T.bind(RULE.stealthFields, 12), (ev) => {
    if (!mineKw(T, ev.operative) || ev.operative.order !== 'conceal') return;
    if (ev.action === 'Fall Back') ev.ap = Math.max(0, ev.ap - 1);
  });

  // =========================================================================
  // SHAS'VRE › XV26 Drone Controller (STRATEGIC GAMBIT — offered in `gambits`)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(AB.droneController, 13), (ev) => {
    if (ev.player !== T.player || ev.ployId !== DRONE_CONTROLLER_GAMBIT) return;
    const drones = T.friendlies(ev.state, DRONE).filter((o) => DRONE_ACTIONS[o.datacardId] !== undefined);
    const drone = chosenOperative(ev.state, ev.data, drones);
    if (!drone) return;
    effect(ev.state, {
      rule: E.droneControlled,
      source: { kind: 'ability', id: AB.droneController },
      sourceText: shortQuote(abilityText(SHAS_VRE, AB.droneController)),
      operativeId: drone.id,
      player: T.player,
      // "Until the end of that operative's next activation."
      expiry: { kind: 'endOfNextActivation', operativeId: drone.id, armed: false },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `XV26 Drone Controller: ${drone.letter} ignores the first two bullets of its Drone rule`,
    });
  });

  // =========================================================================
  // DESIGNATOR / MV75 MARKER DRONE › Markerlight
  // =========================================================================
  reg.on('onWeaponRules', T.bind(AB.markerlightDesignator, 13), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating || !mineKw(T, ev.operative)) return;
    if (!ev.target || !isMarked(T, ev.state, ev.target)) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Markerlight)'));
  });

  // =========================================================================
  // INFILTRATOR › Covert Protocols
  // =========================================================================
  // "This operative can counteract regardless of its order" (docs/DECISIONS.md D-028).
  reg.on('onCounteract', T.bind(AB.covertProtocols, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== INFILTRATOR) return;
    ev.allowed = true;
    delete ev.reason;
  });
  // "…but if it has a Conceal order during that counteraction, it cannot perform any actions
  //  other than Pick Up Marker, Place Marker or mission actions."
  reg.on('canPerformAction', T.bind(AB.covertProtocols, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== INFILTRATOR) return;
    if (!counteracting(ev.state, ev.operative) || ev.operative.order !== 'conceal') return;
    if (['Pick Up Marker', 'Place Marker'].includes(ev.action)) return;
    if (getAction(ev.action)?.type === 'mission') return;
    // HARDWIRED TARGET LOCKS changes the order to Engage *before* the counteraction, so its
    // carve-out is not a Conceal-order counteraction and this clause does not reach it.
    if (ev.action === HARDWIRED_SHOOT) return;
    ev.allowed = false;
    ev.reason = 'Covert Protocols: a Conceal-order counteraction is limited to marker and mission actions';
  });

  // =========================================================================
  // LIBERATOR › Grenadier  (the Hearthkyn Salvager GRENADIER shape)
  // =========================================================================
  const armGrenadier = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === LIBERATOR)) {
      grantWeapon(o, structuredClone(grenadeWeapon('frag')));
      grantWeapon(o, structuredClone(grenadeWeapon('krak')));
    }
  };
  reg.on('onDeploy', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.operative.player === T.player) armGrenadier(ev.state);
  });
  reg.on('onActivationStart', T.bind(AB.grenadier, 12), (ev) => armGrenadier(ev.state));
  reg.on('onReadyStep', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.player === T.player) armGrenadier(ev.state);
  });
  // The universal Explosive Grenades limiter runs at priority 10 on this hook and refuses a
  // grenade the kill team has spent; the LIBERATOR is exempt, so it is re-allowed afterwards.
  reg.on('onSelectWeapon', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== LIBERATOR) return;
    if (!isGrenade(ev.ctx.weaponName)) return;
    ev.allowed = true;
    delete ev.reason;
  });
  // "Doing so doesn't count towards any limited uses you have" — the equipment's spender runs at
  // priority 10 on `onCollectAttackDice`, so its increment is handed straight back.
  reg.on('onCollectAttackDice', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== LIBERATOR) return;
    if (!isGrenade(ev.ctx.weaponName) || ev.ctx.secondary) return;
    const choice = /krak/i.test(ev.ctx.weaponName) ? 'krak' : 'frag';
    if (grenadeAllowance(ev.state, T.player, EXPLOSIVE_ID, choice) <= 0) return;
    const uses = ev.state.teams[T.player].equipmentUses;
    const key = `used:${EXPLOSIVE_ID}:${choice}`;
    uses[key] = Math.max(0, (uses[key] ?? 0) - 1);
  });
  // "Whenever this operative is using a frag or krak grenade, improve the Hit stat of that weapon
  //  by 1." `StatMods.hit` from `onCollectAttackDice` is dead — `hitOf` reads only `onStatMod`.
  reg.on('onStatMod', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== LIBERATOR) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !isGrenade(seq.weaponName)) return;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // LODESTAR › Electrochaff Launcher
  // =========================================================================
  /*
   * "Once per turning point, when an enemy operative is performing the Shoot action and your
   *  opponent selects a valid target (excluding DRONE), you can use this rule, providing this
   *  operative isn't within control range of enemy operatives."
   *
   * The Select Weapon emit from `startShoot` is the one moment the engine offers before the
   * target is locked in, and it carries the intended target. D-032: the dry run must not mutate.
   * "You can use this rule" is auto-used on a stated policy (D-022): only when the intended
   * target would actually gain from it — visible to and within 3" of the LODESTAR and more than
   * 2" from the shooter.
   */
  reg.on('onSelectWeapon', T.bind(AB.electrochaffLauncher, 14), (ev) => {
    if (ev.dryRun) return;
    if (ev.ctx.attacker.player === T.player) return;
    const target = ev.ctx.defender;
    if (!target || !mineKw(T, target) || isDrone(T, target)) return;
    if (usedThisTP(ev.state, `${AB.electrochaffLauncher}:${T.player}`)) return;
    const lodestar = electrochaffSource(T, ev.state, ev.ctx.attacker, target);
    if (!lodestar) return;
    useOncePerTP(ev.state, `${AB.electrochaffLauncher}:${T.player}`);
    effect(ev.state, {
      rule: E.electrochaff,
      source: { kind: 'ability', id: AB.electrochaffLauncher },
      sourceText: shortQuote(abilityText(LODESTAR, AB.electrochaffLauncher)),
      operativeId: lodestar.id,
      player: T.player,
      data: { attackerId: ev.ctx.attacker.id },
      // "Until the end of that action" — bounded to the shooting operative's activation, which
      // is the tightest expiry the engine enforces (`endOfAction` is only swept at end of TP).
      expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Electrochaff Launcher: ${lodestar.letter} blankets ${target.letter}`,
    });
  });
  // "…That friendly operative is obscured." `onCollectAttackDice` is the first hook after the
  // Select Valid Target step and still precedes retention and the obscured discard.
  reg.on('onCollectAttackDice', T.bind(AB.electrochaffLauncher, 14), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.obscured || ev.ctx.type !== 'ranged') return;
    if (!electrochaffApplies(T, ev.state, ev.ctx.attacker, ev.ctx.defender)) return;
    seq.obscured = true;
    log(ev.state, { kind: 'action', player: T.player, text: 'Electrochaff Launcher: the target is obscured' });
  });
  // "…Ignore the Piercing weapon rule." (the MV4 Shield Drone shape: give the dice back.)
  reg.on('onDefenceDice', T.bind(AB.electrochaffLauncher, 15), (ev) => {
    if (ev.count <= 0) return;
    if (!electrochaffApplies(T, ev.state, ev.ctx.attacker, ev.ctx.defender)) return;
    const piercing = ev.ctx.rules.find((r) => r.id === 'Piercing');
    if (piercing) ev.count += piercing.x ?? 1;
  });

  // =========================================================================
  // LODESTAR › Homing Beacon
  // =========================================================================
  const armBeacon = (state: GameState): void => {
    const lodestar = T.friendlies(state).find((o) => o.datacardId === LODESTAR);
    if (lodestar) placeBeacon(T, state, lodestar);
  };
  reg.on('onDeploy', T.bind(AB.homingBeacon, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    armBeacon(ev.state);
  });
  reg.on('onActivationStart', T.bind(AB.homingBeacon, 12), (ev) => armBeacon(ev.state));
  reg.on('onReadyStep', T.bind(AB.homingBeacon, 12), (ev) => {
    if (ev.player === T.player) armBeacon(ev.state);
  });
  /*
   * "The first time an enemy operative performs the Pick Up Marker action on your Homing Beacon
   *  marker, discard that marker (remove it from the battle)."
   *
   * Nothing runs at the end of an action, so the discard lands at the next activation boundary —
   * the marker is already off the board (carried) in the meantime, so no control is scored from
   * it in between.
   */
  reg.on('onActivationEnd', T.bind(AB.homingBeacon, 13), (ev) => {
    const marker = markerOf(ev.state, BEACON_MARKER(T.player));
    if (!marker?.carriedBy) return;
    const carrier = ev.state.operatives[marker.carriedBy];
    if (!carrier || carrier.player === T.player) return;
    carrier.carryingMarkerId = undefined as unknown as string | undefined;
    removeMarker(ev.state, marker.id);
    bucket(ev.state, 'xv26.beacon')[T.player] = 'discarded';
    log(ev.state, { kind: 'action', player: T.player, text: 'Homing Beacon is discarded' });
  });
  /*
   * "In the Ready step of each Strategy phase, when you gain CP, if your Homing Beacon marker is
   *  in the killzone, roll one D6 if it's more than 6" from your drop zone; roll two D6 instead
   *  if it's within your opponent's territory; roll three D6 instead if it's within 6" of your
   *  opponent's drop zone. If any result is a 4+, you gain one additional CP."
   */
  reg.on('onReadyStep', T.bind(AB.homingBeacon, 14), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const marker = markerOf(ev.state, BEACON_MARKER(T.player));
    if (!marker) return;
    const n = beaconDice(ev.state, T.player, marker);
    if (n <= 0) return;
    const results: number[] = [];
    for (let i = 0; i < n; i++) results.push(T.ctx.rng.d6());
    recordRoll(ev.state, 'homingBeacon', results, T.player, `Homing Beacon ${n}D6 (4+)`);
    if (!results.some((r) => r >= 4)) return;
    ev.cp += 1;
    log(ev.state, { kind: 'system', player: T.player, text: `Homing Beacon: +1CP (${results.join(', ')})` });
  });

  // =========================================================================
  // NEUTRALISER › Multispectrum Sensor Package (SUPPORT)
  // =========================================================================
  /*
   * "Once per turning point, when an enemy operative within 8" of this operative is activated,
   *  you can use this rule. If you do, each friendly XV26 STEALTH BATTLESUIT operative within 3"
   *  of this operative can immediately do one of the following: Perform a free Dash action (in an
   *  order of your choice) / Change its order."
   *
   * "Note that a Comms Device from universal equipment only affects the second distance of this
   *  rule" — so `supportDistance` widens the 3" and the 8" stays literal.
   *
   * The free Dash is AP granted outside the APL budget (D-100), landing on each friendly
   * operative's OWN next activation rather than during the enemy's (D-013); the alternative
   * ("change its order") is taken for an operative that could not use a Dash at all, so the rule
   * always does something.
   */
  reg.on('onActivationStart', T.bind(AB.multispectrum, 13), (ev) => {
    if (ev.operative.player === T.player) return;
    const sensor = T.friendlies(ev.state).find(
      (o) => o.datacardId === NEUTRALISER && T.gap(o, ev.operative) <= 8 + EPS,
    );
    if (!sensor) return;
    if (!useOncePerTP(ev.state, `${AB.multispectrum}:${T.player}`)) return;
    const range = T.ctx ? supportDistance(T.ctx, ev.state, sensor, 3) : 3;
    for (const mate of T.friendlies(ev.state, KW)) {
      if (T.gap(sensor, mate) > range + EPS) continue;
      grantFreeAction(ev.state, mate, {
        sourceId: AB.multispectrum,
        sourceText: shortQuote(abilityText(NEUTRALISER, AB.multispectrum)),
        threshold: currentApl(T, ev.state, mate),
        kind: 'ability',
        only: ['Dash'],
      });
    }
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Multispectrum Sensor Package: ${sensor.letter} reacts to ${ev.operative.letter}`,
    });
  });

  // =========================================================================
  // MV15 GUN DRONE / MV75 MARKER DRONE › Drone
  // =========================================================================
  reg.on('canPerformAction', T.bind(AB.droneGun, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const allowed = DRONE_ACTIONS[ev.operative.datacardId];
    if (!allowed || droneRuleSuspended(ev.state, ev.operative)) return;
    if (allowed.includes(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'a DRONE cannot perform that action';
  });
  reg.on('onMarkerControl', T.bind(AB.droneGun, 13), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker || marker.kind !== 'objective') return;
    for (const o of T.friendlies(ev.state)) {
      if (!DRONE_ACTIONS[o.datacardId] || droneRuleSuspended(ev.state, o)) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, o)) continue;
      ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - 1);
    }
  });
  // "This operative cannot use any weapons that aren't on its datacard" — reachable for ranged
  // weapons only (`weaponsOf` appends `grantedWeapons` after `availableWeapons`).
  reg.on('onSelectWeapon', T.bind(AB.droneGun, 13), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !DRONE_ACTIONS[op.datacardId]) return;
    const card = T.card(op);
    if (!card || card.weapons.some((w) => w.name === ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'a DRONE cannot use a weapon that is not on its datacard';
  });

  // =========================================================================
  // An unspent free action does not survive the turning point
  // =========================================================================
  // The free AP rides an `endOfActivation` effect, so a grant spent inside its own operative's
  // activation is dropped by the engine at EndActivation (D-100) and needs no help here. Both of
  // this team's grants can land on an operative that is NOT the one activating, though —
  // Multispectrum fires on an ENEMY's activation and Vectored Retro-Thrusters interrupts one —
  // and an operative already expended this turning point has no activation left to spend the AP
  // in. "…can IMMEDIATELY perform a free action" is that moment only, so the Ready step of the
  // next turning point clears whatever was never taken, on either side of the table.
  const dropUnspentGrant = (state: GameState, op: OperativeState): void => {
    for (const eff of state.effects.filter((e) => e.rule === FREE_ACTION_RULE && e.operativeId === op.id)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bindText('xv26.freeActionUpkeep', text(RULE.stealthFields), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of aliveOperatives(ev.state)) dropUnspentGrant(ev.state, o);
  });
}

/** Every rule of this team that hands out a `grantFreeAction`, for the Ready-step clean-up. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set<string>([
  AB.multispectrum,
  FP.vectoredRetroThrusters,
  `${FP.vectoredRetroThrusters}.enemy`,
]);

const isGrenade = (name: string): boolean => /^(frag|krak) grenade$/i.test(name.trim());

const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

/** The LODESTAR whose Electrochaff Launcher can cover this shot, if any. */
function electrochaffSource(
  T: TeamHooks,
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
): OperativeState | undefined {
  if (!T.ctx) return undefined;
  const ctx = T.ctx;
  return T.friendlies(state).find(
    (o) =>
      o.datacardId === LODESTAR &&
      // "providing this operative isn't within control range of enemy operatives"
      aliveOperatives(state, otherPlayer(T.player)).every((e) => !inControlRange(ctx, state, o, e)) &&
      T.gap(o, target) <= 3 + EPS &&
      visibleBetween(T, state, o, target) &&
      T.gap(attacker, target) > 2 + EPS,
  );
}

/** The per-shot test the two Electrochaff effects share. */
function electrochaffApplies(
  T: TeamHooks,
  state: GameState,
  attacker: OperativeState,
  target: OperativeState | undefined,
): boolean {
  if (!target || !mineKw(T, target) || attacker.player === T.player) return false;
  const live = state.effects.find((e) => e.rule === E.electrochaff && e.player === T.player);
  if (!live || live.data?.['attackerId'] !== attacker.id) return false;
  const lodestar = live.operativeId ? state.operatives[live.operativeId] : undefined;
  if (!lodestar || lodestar.removed) return false;
  return (
    T.gap(lodestar, target) <= 3 + EPS &&
    visibleBetween(T, state, lodestar, target) &&
    T.gap(attacker, target) > 2 + EPS
  );
}

/** "This operative is carrying your Homing Beacon marker." */
function placeBeacon(T: TeamHooks, state: GameState, lodestar: OperativeState): void {
  const id = BEACON_MARKER(T.player);
  if (state.markers[id]) return;
  // "…discard that marker (remove it from the battle)" — it never comes back.
  if (bucket(state, 'xv26.beacon')[T.player] === 'discarded') return;
  if (lodestar.carryingMarkerId) return;
  const marker = placeTeamMarker(state, {
    id,
    kind: 'generic',
    player: T.player,
    pos: { ...lodestar.pos },
    z: lodestar.z,
    flags: { pickUpAllowed: true, homingBeacon: true },
  });
  marker.carriedBy = lodestar.id;
  lodestar.carryingMarkerId = marker.id;
  log(state, { kind: 'action', player: T.player, text: `${lodestar.letter} carries the Homing Beacon marker` });
}

/**
 * How many D6 the Homing Beacon rolls in the Ready step, or 0 for none:
 * "roll one D6 if it's more than 6" from your drop zone; roll two D6 instead if it's within your
 * opponent's territory; roll three D6 instead if it's within 6" of your opponent's drop zone."
 */
export function beaconDice(state: GameState, player: PlayerId, marker: MarkerState): number {
  const base: BaseShape = { shape: 'round', mm: marker.diameterMm };
  const foe = otherPlayer(player);
  if (withinOf(marker.pos, 0, base, dropZoneOf(state, foe), 6)) return 3;
  if (baseWithin(marker.pos, base, 0, territoryOf(state, foe))) return 2;
  if (!withinOf(marker.pos, 0, base, dropZoneOf(state, player), 6)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // PATIENT HUNTERS (strategy)
  // =========================================================================
  // "…is shooting against or fighting against an expended enemy operative, that friendly
  //  operative's weapons have the Balanced weapon rule and its ranged weapons have the Saturate
  //  weapon rule." `onWeaponRules` is read by BOTH sequences, so shooting and fighting are live;
  //  retaliating is not printed and is therefore excluded.
  reg.on('onWeaponRules', T.bind(SP.patientHunters, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.patientHunters)) return;
    if (ev.retaliating || !mineKw(T, ev.operative)) return;
    const target = ev.target;
    if (!target || target.player === T.player || !target.expended) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Patient Hunters)'));
    if (ev.type === 'ranged') ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Patient Hunters)'));
  });

  // =========================================================================
  // PREPARE AMBUSH (strategy)
  // =========================================================================
  // "Place one of your Ambush markers wholly within your territory and more than 2" from enemy
  //  operatives." A position the player did not supply is a deterministic, logged default (D-016).
  reg.on('onPloyUsed', T.bind(SP.prepareAmbush, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.prepareAmbush) return;
    const fallback = defaultAmbushPos(T, ev.state);
    const wanted = posFromData(ev.data, fallback);
    const pos = ambushPosLegal(T, ev.state, wanted) ? wanted : fallback;
    removeMarker(ev.state, AMBUSH_MARKER(T.player));
    placeTeamMarker(ev.state, {
      id: AMBUSH_MARKER(T.player),
      kind: 'generic',
      player: T.player,
      pos,
      flags: { ambush: true, placedTP: ev.state.turningPoint },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Prepare Ambush: marker at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
    });
  });
  /*
   * "Whenever a friendly XV26 STEALTH BATTLESUIT operative is shooting an enemy operative that's
   *  within 2" of that marker, you can use this rule. If you do, remove that marker and that
   *  friendly operative's ranged weapons have the Seek weapon rule until the end of the action."
   *
   * Seek is read by `checkTarget`, which `startShoot` runs against the rules it collected BEFORE
   * `onSelectWeapon` fires — so the grant has to be made here, from a pure policy, and only the
   * *claim* (removing the marker) happens at the Select Weapon emit. The policy (D-022) is
   * "spend the marker only when cover is actually costing the shot", tested with the engine's own
   * `checkTarget` against the rules minus this grant.
   */
  reg.on('onWeaponRules', T.bind(SP.prepareAmbush, 21), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating || !mineKw(T, ev.operative)) return;
    if (effectOn(ev.state, ev.operative.id, E.ambushSeek)) {
      ev.rules.push(ruleTag('Seek', undefined, SEEK_RAW));
      return;
    }
    if (!ambushSeekWanted(T, ev.state, ev.operative, ev.target, ev.profile, ev.rules)) return;
    ev.rules.push(ruleTag('Seek', undefined, SEEK_RAW));
  });
  reg.on('onSelectWeapon', T.bind(SP.prepareAmbush, 21), (ev) => {
    if (ev.dryRun || ev.ctx.type !== 'ranged') return;
    const shooter = ev.ctx.attacker;
    if (!mineKw(T, shooter) || effectOn(ev.state, shooter.id, E.ambushSeek)) return;
    const without = ev.ctx.rules.filter((r) => r.raw !== SEEK_RAW);
    if (!ambushSeekWanted(T, ev.state, shooter, ev.ctx.defender, ev.ctx.profile, without)) return;
    removeMarker(ev.state, AMBUSH_MARKER(T.player));
    effect(ev.state, {
      rule: E.ambushSeek,
      source: { kind: 'ploy', id: SP.prepareAmbush },
      sourceText: shortQuote(text(SP.prepareAmbush)),
      operativeId: shooter.id,
      player: T.player,
      // "until the end of the action" — bounded to the activation, the tightest expiry the
      // engine actually sweeps (an operative performs one Shoot action per activation).
      expiry: { kind: 'endOfActivation', operativeId: shooter.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Prepare Ambush: ${shooter.letter}'s weapons have Seek` });
  });
  // "In the Ready step of the next Strategy phase, if that marker is still in the killzone,
  //  remove that marker."
  reg.on('onReadyStep', T.bind(SP.prepareAmbush, 22), (ev) => {
    if (ev.player !== T.player) return;
    const marker = markerOf(ev.state, AMBUSH_MARKER(T.player));
    if (!marker) return;
    if (Number(marker.flags['placedTP'] ?? 0) >= ev.state.turningPoint) return;
    removeMarker(ev.state, marker.id);
    log(ev.state, { kind: 'system', player: T.player, text: 'Prepare Ambush: the Ambush marker is removed' });
  });

  // =========================================================================
  // BONDS OF UNITY (strategy)
  // =========================================================================
  /*
   * "Whenever a friendly XV26 STEALTH BATTLESUIT operative is activated (excluding DRONE), if
   *  it's visible to and within 6" of another friendly XV26 STEALTH BATTLESUIT operative
   *  (excluding DRONE), you can ignore any changes to that first friendly operative's APL stat
   *  and select one of the following: …"
   *
   * The APL half is free, so it is always used (D-022): `op.aplMods` is cleared at the moment of
   * activation (the Kommandos SHAKE IT OFF / Breachers REBREATHERS precedent, because `aplOf`
   * reads `aplMods` directly) and hook-borne APL changes are zeroed for the activation. The
   * "select one of the following" is a real PendingDecision through `decisionHandlers`.
   */
  reg.on('onActivationStart', T.bind(SP.bondsOfUnity, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.bondsOfUnity)) return;
    const op = ev.operative;
    if (!mineSuit(T, op)) return;
    if (!bondsPartner(T, ev.state, op)) return;
    if (op.aplMods.length > 0) {
      op.aplMods.length = 0;
      log(ev.state, { kind: 'ploy', player: T.player, text: `Bonds of Unity: ${op.letter} ignores APL changes` });
    }
    effect(ev.state, {
      rule: E.bondsApl,
      source: { kind: 'ploy', id: SP.bondsOfUnity },
      sourceText: shortQuote(text(SP.bondsOfUnity)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    // The two options only do anything while the operative is injured.
    if (!isInjuredOp(T, op)) return;
    if (ev.state.pending.some((p) => p.kind === BONDS_DECISION)) return;
    ev.state.pending.push({
      id: `bonds-${ev.state.seq++}`,
      who: T.player,
      kind: BONDS_DECISION,
      prompt: `Bonds of Unity: which injury change does ${op.letter} ignore?`,
      sourceText: shortQuote(text(SP.bondsOfUnity)),
      options: [
        { id: 'hit', label: 'Ignore the injured Hit stat change', data: { operativeId: op.id } },
        { id: 'move', label: 'Ignore the injured Move stat change', data: { operativeId: op.id } },
      ],
    });
  });
  reg.on('onStatMod', T.bind(SP.bondsOfUnity, 90), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, E.bondsApl)) ev.mods.apl = 0;
    if (!isInjuredOp(T, ev.operative)) return;
    // `hitOf` adds +1 (worse) and `moveOf` subtracts 2" for an injured operative; cancelling
    // them is exactly "ignore any changes … from being injured".
    if (effectOn(ev.state, ev.operative.id, E.bondsHit)) ev.mods.hit += 1;
    if (effectOn(ev.state, ev.operative.id, E.bondsMove)) ev.mods.move += 2;
  });

  // =========================================================================
  // HOLOWAVE COUNTERMEASURES (strategy)
  // =========================================================================
  /*
   * "Whenever an operative is shooting a friendly XV26 STEALTH BATTLESUIT operative more than 6"
   *  from it, in the Roll Attack Dice step, the attacker must discard one of their unresolved
   *  normal successes (or one of their critical successes if there are none). This isn't
   *  cumulative with being obscured."
   *
   * `effectiveRules` is re-emitted at the top of every `advanceShoot` pass, so a handler gated on
   * `seq.step === 'retention'` is a real post-roll seam inside the Roll Attack Dice step (the
   * Hearthkyn Grudge / Void-dancer WRAITHBONE TALISMAN precedent). It fires once per target, so a
   * Blast/Torrent secondary is charged its own discard, as printed.
   */
  reg.on('onWeaponRules', T.bind(SP.holowaveCountermeasures, 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.holowaveCountermeasures)) return;
    if (ev.type !== 'ranged') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'retention' || seq.attackerId !== ev.operative.id) return;
    if (seq.obscured) return; // "This isn't cumulative with being obscured."
    const target = ev.state.operatives[seq.targetId];
    if (!target || !mineKw(T, target)) return;
    if (T.gap(ev.operative, target) <= 6 + EPS) return;
    if (!useOncePerSequence(ev.state, `${SP.holowaveCountermeasures}:${T.player}`)) return;
    const die =
      seq.attack.dice.find((d) => d.state === 'normal') ?? seq.attack.dice.find((d) => d.state === 'crit');
    if (!die) return;
    die.state = 'discarded';
    die.note = 'Holowave Countermeasures';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Holowave Countermeasures: ${ev.operative.letter} discards one success`,
    });
  });

  // =========================================================================
  // VECTORED RETRO-THRUSTERS (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy when an enemy operative ends the Charge action within control range
   *  of a friendly XV26 STEALTH BATTLESUIT operative (excluding DRONE). Interrupt that action to
   *  use this rule. If you do, that friendly operative can immediately perform a free Fall Back
   *  action, but it cannot move more than 3" during that action. Then, that enemy operative can
   *  immediately perform a free Reposition action using any remaining move distance it had from
   *  that first Charge action…"
   *
   * Nothing runs after an action, so the interrupt is taken from the `UsePloy` intent instead;
   * both free actions are AP granted outside the APL budget (D-100), so neither operative's APL
   * stat moves. The friendly's lands on its own next activation (the standard D-013 deferral);
   * the charging enemy is still mid-activation, so its `Reposition (Vectored Retro-Thrusters)`
   * is genuinely immediate.
   */
  reg.on('onPloyUsed', T.bind(FP.vectoredRetroThrusters, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.vectoredRetroThrusters) return;
    const pair = thrusterPair(T, ev.state);
    if (!pair) return;
    grantFreeAction(ev.state, pair.friendly, {
      sourceId: FP.vectoredRetroThrusters,
      sourceText: shortQuote(text(FP.vectoredRetroThrusters)),
      threshold: currentApl(T, ev.state, pair.friendly),
      only: ['Fall Back'],
    });
    const left = Math.max(0, chargeAllowance(T, ev.state, pair.enemy) - chargeInches(ev.state, pair.enemy));
    grantFreeAction(ev.state, pair.enemy, {
      sourceId: `${FP.vectoredRetroThrusters}.enemy`,
      sourceText: shortQuote(text(FP.vectoredRetroThrusters)),
      threshold: currentApl(T, ev.state, pair.enemy),
      only: [THRUSTER_REPOSITION],
    });
    bucket(ev.state, 'xv26.thrusters')[pair.enemy.id] = left;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Vectored Retro-Thrusters: ${pair.friendly.letter} disengages, ${pair.enemy.letter} may Reposition ${left.toFixed(1)}"`,
    });
  });
  // "…but it cannot move more than 3" during that action."
  reg.on('onMoveDistance', T.bind(FP.vectoredRetroThrusters, 21), (ev) => {
    if (ev.action !== 'Fall Back') return;
    if (effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE)?.source.id !== FP.vectoredRetroThrusters) return;
    ev.inches = Math.min(ev.inches, 3);
  });
  // "…using any remaining move distance it had from that first Charge action."
  reg.on('onMoveDistance', T.bind(FP.vectoredRetroThrusters, 22), (ev) => {
    if (ev.action !== THRUSTER_REPOSITION) return;
    const left = bucket(ev.state, 'xv26.thrusters')[ev.operative.id];
    if (typeof left !== 'number') return;
    ev.inches = Math.min(ev.inches, left);
  });

  // =========================================================================
  // ENGAGE JET PACK (firefight) — REMINDER ONLY, see REMINDER_ONLY above
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.engageJetPack, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.engageJetPack) return;
    const candidates = T.friendlies(ev.state, KW).filter((o) => !isDrone(T, o));
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    // `onMoveRules` (which carries `ignoreClimbCost`/`ignoreDropInches`) is declared and never
    // emitted, so the permission is recorded for the UI rather than registered as a no-op.
    effect(ev.state, {
      rule: E.jetPack,
      source: { kind: 'ploy', id: FP.engageJetPack },
      sourceText: shortQuote(text(FP.engageJetPack)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Engage Jet Pack: ${op.letter} ignores the vertical distance of one climb and one drop (reminder)`,
    });
  });

  // =========================================================================
  // GHOSTSHROUD (firefight)
  // =========================================================================
  // "Use this firefight ploy at the end of a friendly XV26 STEALTH BATTLESUIT operative's
  //  activation. If that operative has an Engage order, change it to Conceal. You cannot use this
  //  ploy for each friendly operative more than once per battle."
  reg.on('onPloyUsed', T.bind(FP.ghostshroud, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.ghostshroud) return;
    const op = ghostshroudTarget(T, ev.state, ev.data);
    if (!op) return;
    useOncePerBattle(ev.state, `${FP.ghostshroud}:${op.id}`);
    op.order = 'conceal';
    log(ev.state, { kind: 'ploy', player: T.player, text: `Ghostshroud: ${op.letter} changes its order to Conceal` });
  });

  // =========================================================================
  // SAVIOUR PROTOCOLS (firefight)
  // =========================================================================
  /*
   * Word-for-word the Pathfinders' ploy bar the team keyword, so it reuses batch 1's
   * `onSelectTarget` seam: "Select one friendly DRONE operative visible to and within 3" of that
   * first friendly operative to become the valid target instead (even if it wouldn't normally be
   * valid for this). That friendly DRONE operative is only in cover or obscured if the original
   * target was." — `startShoot` carries the original cover/obscured verdict onto the substitute.
   *
   * `ploysUsedTP` stays true for the whole turning point, so the redirect is claimed once (the
   * Pathfinders guard); one use of the ploy is one substitution.
   */
  reg.on('onSelectTarget', T.bind(FP.saviourProtocols, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.saviourProtocols)) return;
    if (!mineSuit(T, ev.target)) return;
    // "This ploy has no effect if the ranged weapon has the Blast or Torrent weapon rule."
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (usedThisTP(ev.state, `${FP.saviourProtocols}:${T.player}`)) return;
    const drone = T.friendlies(ev.state, DRONE).find(
      (o) => !o.incapacitated && T.gap(o, ev.target) <= 3 + EPS && visibleBetween(T, ev.state, ev.target, o),
    );
    if (!drone) return;
    useOncePerTP(ev.state, `${FP.saviourProtocols}:${T.player}`);
    ev.redirectTo = drone.id;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Saviour Protocols: ${drone.letter} takes the hit` });
  });
}

const SEEK_RAW = 'Seek (Prepare Ambush)';

function isInjuredOp(T: TeamHooks, op: OperativeState): boolean {
  const card: Datacard | undefined = T.card(op);
  return card !== undefined && op.wounds < card.wounds / 2;
}

/** "…visible to and within 6" of another friendly XV26 operative (excluding DRONE)". */
function bondsPartner(T: TeamHooks, state: GameState, op: OperativeState): OperativeState | undefined {
  return T.friendlies(state, KW).find(
    (o) => o.id !== op.id && !isDrone(T, o) && T.gap(o, op) <= 6 + EPS && visibleBetween(T, state, op, o),
  );
}

/** "…wholly within your territory and more than 2" from enemy operatives." */
export function ambushPosLegal(T: TeamHooks, state: GameState, pos: Vec2): boolean {
  const base: BaseShape = { shape: 'round', mm: 20 };
  if (!baseWhollyWithin(pos, base, 0, territoryOf(state, T.player), 12)) return false;
  return T.enemies(state).every((e) => markerGapTo(T, e, pos) > 2 + EPS);
}

const markerGapTo = (T: TeamHooks, op: OperativeState, pos: Vec2): number =>
  T.markerGap(op, { id: 'probe', kind: 'generic', diameterMm: 20, pos, z: 0, flags: {} });

/**
 * A deterministic, logged default (D-016): the lattice point closest to the enemy that still
 * satisfies both printed constraints, so the marker is placed where an ambush would be sprung.
 */
export function defaultAmbushPos(T: TeamHooks, state: GameState): Vec2 {
  const board = state.map.board;
  let best: Vec2 | undefined;
  let bestScore = Infinity;
  const enemies = T.enemies(state);
  for (let x = 0.5; x < board.w; x += 0.5) {
    for (let y = 0.5; y < board.h; y += 0.5) {
      const p = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      if (!ambushPosLegal(T, state, p)) continue;
      const score = enemies.length === 0 ? p.x + p.y : Math.min(...enemies.map((e) => dist(e.pos, p)));
      if (score < bestScore - 1e-9) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best ?? { x: board.w / 4, y: board.h / 2 };
}

/**
 * "You can use this rule" — the stated policy (D-022): spend the Ambush marker only when cover is
 * actually costing the shot, which is the only thing Seek changes.
 */
function ambushSeekWanted(
  T: TeamHooks,
  state: GameState,
  shooter: OperativeState,
  target: OperativeState | undefined,
  profile: WeaponProfile,
  rules: WeaponRule[],
): boolean {
  if (!T.ctx || !target || target.player === T.player) return false;
  if (!gambitUsed(state, T.player, SP.prepareAmbush)) return false;
  const marker = markerOf(state, AMBUSH_MARKER(T.player));
  if (!marker) return false;
  if (T.markerGap(target, marker) > 2 + EPS) return false;
  const chk = checkTarget(T.ctx, state, shooter, target, profile, rules);
  return chk.inCover || (!chk.valid && (chk.reason ?? '').includes('cover'));
}

/** The enemy that just charged, and the battlesuit it ended within control range of. */
function thrusterPair(
  T: TeamHooks,
  state: GameState,
): { enemy: OperativeState; friendly: OperativeState } | undefined {
  if (!T.ctx) return undefined;
  const ctx = T.ctx;
  for (const enemy of T.enemies(state)) {
    if (!enemy.actionsThisActivation.includes('Charge')) continue;
    const friendly = T.friendlies(state, KW).find((o) => !isDrone(T, o) && inControlRange(ctx, state, o, enemy));
    if (friendly) return { enemy, friendly };
  }
  return undefined;
}

/** Charge allowance = Move stat + the universal Charge's printed additional 2". */
function chargeAllowance(T: TeamHooks, state: GameState, op: OperativeState): number {
  return (T.ctx ? moveOf(T.ctx, state, op) : (T.card(op)?.move ?? 6)) + 2;
}

/** The inches `applyMove` logged for this operative's Charge in this activation. */
function chargeInches(state: GameState, op: OperativeState): number {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.kind !== 'action' || entry.data?.['operativeId'] !== op.id) continue;
    if (entry.data['action'] !== 'Charge') continue;
    const inches = entry.data['inches'];
    return typeof inches === 'number' ? inches : 0;
  }
  return 0;
}

/** "…at the end of a friendly XV26 STEALTH BATTLESUIT operative's activation." */
function ghostshroudTarget(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): OperativeState | undefined {
  const eligible = T.friendlies(state, KW).filter(
    (o) => o.order === 'engage' && !usedThisBattle(state, `${FP.ghostshroud}:${o.id}`),
  );
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && eligible.some((o) => o.id === active.id)) return active;
  return chosenOperative(state, data, eligible);
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // XV26 MULTITRACKERS
  // =========================================================================
  /*
   * "Once per turning point, when a friendly XV26 STEALTH BATTLESUIT operative is performing the
   *  Shoot action and you select a burst cannon (sweeping), you can use this rule. If you do,
   *  until the end of that action, that weapon has the Torrent 2" weapon rule."
   *
   * `startShoot` builds `seq.queue` from the rules it read BEFORE `onSelectWeapon` fires (the
   * Hernkyn FIRESTORM BOLT SHELLS finding), so the upgrade has to be granted from `onWeaponRules`
   * on a pure policy and only CLAIMED once the sequence is live. The policy (D-022) is "spend the
   * turning point's use only when Torrent 2" catches an operative Torrent 1" would miss".
   */
  reg.on('onWeaponRules', T.bind(EQ.multitrackers, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.multitrackers)) return;
    if (!isSweepingBurstCannon(ev.weaponName, ev.profile)) return;
    if (!mineKw(T, ev.operative)) return;
    const live = effectOn(ev.state, ev.operative.id, E.multitracker) !== undefined;
    if (!live && usedThisTP(ev.state, `${EQ.multitrackers}:${T.player}`)) return;
    if (!live && !multitrackerWanted(T, ev.state, ev.target)) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Torrent');
    ev.rules.push(ruleTag('Torrent', 2, 'Torrent 2" (XV26 Multitrackers)'));
  });
  reg.on('onCollectAttackDice', T.bind(EQ.multitrackers, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.multitrackers)) return;
    if (ev.ctx.secondary || !mineKw(T, ev.ctx.attacker)) return;
    if (!isSweepingBurstCannon(ev.ctx.weaponName, ev.ctx.profile)) return;
    if (effectOn(ev.state, ev.ctx.attacker.id, E.multitracker)) return;
    if (!multitrackerWanted(T, ev.state, ev.ctx.defender)) return;
    if (!useOncePerTP(ev.state, `${EQ.multitrackers}:${T.player}`)) return;
    effect(ev.state, {
      rule: E.multitracker,
      source: { kind: 'equipment', id: EQ.multitrackers },
      sourceText: shortQuote(text(EQ.multitrackers)),
      operativeId: ev.ctx.attacker.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `XV26 Multitrackers: ${ev.ctx.attacker.letter}'s burst cannon has Torrent 2"`,
    });
  });

  // =========================================================================
  // ADVANCED BLACKSUN FILTERS
  // =========================================================================
  /*
   * "Whenever a friendly XV26 STEALTH BATTLESUIT operative is shooting an operative that's
   *  obscured, you don't have to discard one success as a result of that rule. All other effects
   *  of obscured apply as normal."
   *
   * The obscured discard is a whole step of `advanceShoot`, so the equipment does what the step
   * would have done minus the discard — retain every critical success as a normal success — and
   * moves the sequence on. `seq.obscured` deliberately stays true, because every OTHER effect of
   * obscured (the retention restrictions, the AttackContext other rules read) applies as normal.
   */
  reg.on('onWeaponRules', T.bind(EQ.blacksunFilters, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.blacksunFilters)) return;
    if (ev.type !== 'ranged' || ev.retaliating || !mineKw(T, ev.operative)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'obscuredDiscard' || seq.attackerId !== ev.operative.id) return;
    for (const d of seq.attack.dice) {
      if (d.state !== 'crit') continue;
      d.state = 'normal';
      d.note = 'obscured: crit -> normal';
    }
    seq.step = 'rollDefence';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: 'Advanced Blacksun Filters: no success is discarded for obscured',
    });
  });

  // =========================================================================
  // COUNTER-NETWORK JAMMERS (STRATEGIC GAMBIT — offered in `gambits`)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(EQ.counterNetworkJammers, 30), (ev) => {
    if (ev.player !== T.player || ev.ployId !== JAMMERS_GAMBIT) return;
    const marker = jammersMarker(T, ev.state, ev.data);
    if (!marker) return;
    dropEffects(ev.state, (e) => e.rule === E.jammersMarker && e.player === T.player);
    effect(ev.state, {
      rule: E.jammersMarker,
      source: { kind: 'equipment', id: EQ.counterNetworkJammers },
      sourceText: shortQuote(text(EQ.counterNetworkJammers)),
      player: T.player,
      data: { markerId: marker.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Counter-network Jammers: ${marker.kind} marker ${marker.id} is jammed`,
    });
  });
  // "…treat the total APL stat of enemy operatives that contest it as 1 lower if at least one of
  //  those enemy operatives is within 3" of friendly XV26 STEALTH BATTLESUIT operatives."
  reg.on('onMarkerControl', T.bind(EQ.counterNetworkJammers, 31), (ev) => {
    if (!T.ctx) return;
    const ctx = T.ctx;
    const live = effectFor(ev.state, T.player, E.jammersMarker);
    if (!live || live.data?.['markerId'] !== ev.markerId) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const foe = otherPlayer(T.player);
    const contesting = aliveOperatives(ev.state, foe).filter((o) => markerContestedBy(ctx, ev.state, marker, o));
    if (contesting.length === 0) return;
    const near = contesting.some((e) => T.friendlies(ev.state, KW).some((f) => T.gap(f, e) <= 3 + EPS));
    if (!near) return;
    ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });

  // =========================================================================
  // HARDWIRED TARGET LOCKS
  // =========================================================================
  /*
   * "Whenever you would counteract, you can do so with one friendly XV26 STEALTH BATTLESUIT
   *  operative that has a Conceal order and is more than 3" from enemy operatives, but before it
   *  counteracts, you must change its order to Engage and it cannot perform any actions other
   *  than Shoot during that counteraction."
   *
   * `onCounteract` widens the candidate list (D-028). The order change cannot happen at the
   * `Counteract` intent (the reducer emits nothing there and `onCounteract` is a pure query the
   * AI runs many times), so it rides `Shoot (Hardwired Target Locks)` — a `treatedAs: 'Shoot'`
   * ActionDef (D-021) that flips the order in `perform`, exactly the Spectre Squad Elite
   * Fieldcraft shape.
   */
  reg.on('onCounteract', T.bind(EQ.hardwiredTargetLocks, 30), (ev) => {
    if (ev.operative.player !== T.player || ev.allowed) return;
    if (!hardwiredEligible(T, ev.state, ev.operative)) return;
    ev.allowed = true;
    delete ev.reason;
  });
  reg.on('canPerformAction', T.bind(EQ.hardwiredTargetLocks, 31), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId === INFILTRATOR) return;
    if (!counteracting(ev.state, ev.operative) || ev.operative.order !== 'conceal') return;
    if (!mineKw(T, ev.operative)) return;
    if (ev.action === HARDWIRED_SHOOT) return;
    ev.allowed = false;
    ev.reason = 'Hardwired Target Locks: this counteraction can only be the Shoot action';
  });
}

const isSweepingBurstCannon = (weaponName: string, profile: WeaponProfile): boolean =>
  /burst cannon/i.test(weaponName) && (profile.name ?? '') === 'sweeping';

/** Torrent 2" only pays for itself when it reaches an operative Torrent 1" would not. */
function multitrackerWanted(T: TeamHooks, state: GameState, target: OperativeState | undefined): boolean {
  if (!target || target.player === T.player) return false;
  return T.enemies(state).some(
    (o) => o.id !== target.id && T.gap(target, o) > 1 + EPS && T.gap(target, o) <= 2 + EPS,
  );
}

/** Objective and mission markers, which is what "one objective marker or mission marker" means. */
const MISSION_MARKER_KINDS: ReadonlySet<string> = new Set([
  'objective',
  'device',
  'intelligence',
  'retrieval',
  'banner',
  'martyr',
  'swept',
  'dominate',
  'orb',
  'energyCell',
  'download',
  'data',
  'reboot',
]);

function jammersMarker(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): MarkerState | undefined {
  const eligible = Object.values(state.markers)
    .filter((m) => MISSION_MARKER_KINDS.has(m.kind) && !m.carriedBy)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const chosen = typeof data?.['markerId'] === 'string' ? eligible.find((m) => m.id === data['markerId']) : undefined;
  if (chosen) return chosen;
  if (!T.ctx) return eligible[0];
  const ctx = T.ctx;
  const foe = otherPlayer(T.player);
  // Deterministic default (D-016): the marker the opponent contests hardest.
  let best: MarkerState | undefined;
  let bestScore = -1;
  for (const m of eligible) {
    const score = aliveOperatives(state, foe).filter((o) => markerContestedBy(ctx, state, m, o)).length;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best ?? eligible[0];
}

/** "…that has a Conceal order and is more than 3" from enemy operatives." */
function hardwiredEligible(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!hasEquipment(state, T.player, EQ.hardwiredTargetLocks)) return false;
  if (!mineKw(T, op) || op.order !== 'conceal') return false;
  return T.enemies(state).every((e) => T.gap(op, e) > 3 + EPS);
}

// ---------------------------------------------------------------------------
// STRATEGIC GAMBITs — the four strategy ploys plus two printed elsewhere
// ---------------------------------------------------------------------------

function gambits(reg: HookRegistry, T: TeamHooks): void {
  for (const ploy of T.data.strategyPloys) {
    reg.on('gambitOptions', T.bind(ploy.id, 20), (ev) => {
      if (ev.player !== T.player) return;
      if (ev.state.teams[T.player].cp < ploy.cp) return;
      ev.options.push({ id: ploy.id, label: `${ploy.name} (${ploy.cp}CP)`, sourceText: shortQuote(ploy.text) });
    });
  }
  // SHAS'VRE › XV26 Drone Controller: "STRATEGIC GAMBIT whenever this operative is in the
  // killzone." Its own 0CP gambit (the Sanctifiers Ministorum Sermon / Mandrakes shape).
  reg.on('gambitOptions', T.bind(AB.droneController, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === SHAS_VRE)) return;
    if (!T.friendlies(ev.state, DRONE).some((o) => DRONE_ACTIONS[o.datacardId] !== undefined)) return;
    ev.options.push({
      id: DRONE_CONTROLLER_GAMBIT,
      label: 'XV26 Drone Controller',
      sourceText: shortQuote(abilityText(SHAS_VRE, AB.droneController)),
    });
  });
  // COUNTER-NETWORK JAMMERS is printed "STRATEGIC GAMBIT." inside a faction equipment option.
  reg.on('gambitOptions', T.bind(EQ.counterNetworkJammers, 16), (ev) => {
    if (ev.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ.counterNetworkJammers)) return;
    if (!Object.values(ev.state.markers).some((m) => MISSION_MARKER_KINDS.has(m.kind) && !m.carriedBy)) return;
    ev.options.push({
      id: JAMMERS_GAMBIT,
      label: 'Counter-network Jammers',
      sourceText: shortQuote(text(EQ.counterNetworkJammers)),
    });
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** Enemy operatives visible to this operative, in a stable order (D-026: `check` decides). */
function visibleEnemies(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

const pickEnemy = (
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosen?: string,
): OperativeState | undefined => {
  const enemies = visibleEnemies(ctx, state, op);
  return enemies.find((e) => e.id === chosen) ?? enemies[0];
};

function actions(data: TeamData): ActionDef[] {
  const out: ActionDef[] = [];

  // FOCUSED MARKERLIGH 1AP — DESIGNATOR (the printed name; see the data problems in the report)
  out.push(
    uniqueAction(data, DESIGNATOR, ACT.focusedMarkerligh, {
      check: (ctx, state, op, params) => {
        // "This operative cannot perform this action while within control range of an enemy."
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pickEnemy(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = pickEnemy(ctx, state, op, params.targetOperativeId)!;
        effect(state, {
          rule: E.focusedMarkerlight,
          source: { kind: 'ability', id: ACT.focusedMarkerligh },
          sourceText: shortQuote(uniqueActionText(DESIGNATOR, ACT.focusedMarkerligh)),
          operativeId: target.id,
          player: op.player,
          // "Once during this turning point, when a friendly … operative is shooting that enemy
          //  operative, you can use this effect."
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: FOCUSED MARKERLIGH on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // SYSTEM JAM 2AP — NEUTRALISER
  out.push(
    uniqueAction(data, NEUTRALISER, ACT.systemJam, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pickEnemy(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = pickEnemy(ctx, state, op, params.targetOperativeId)!;
        target.aplMods.push(-1);
        effect(state, {
          rule: E.systemJam,
          source: { kind: 'ability', id: ACT.systemJam },
          sourceText: shortQuote(uniqueActionText(NEUTRALISER, ACT.systemJam)),
          operativeId: target.id,
          player: op.player,
          // "Until the end of that operative's next activation, subtract 1 from its APL stat."
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SYSTEM JAM on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // PHOTON GRENADE LAUNCHER 1AP — MV15 GUN DRONE
  out.push(
    uniqueAction(data, MV15_GUN_DRONE, ACT.photonGrenadeLauncher, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pickEnemy(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = pickEnemy(ctx, state, op, params.targetOperativeId)!;
        const roll = ctx.rng.d6();
        recordRoll(state, 'photonGrenadeLauncher', [roll], op.player, 'PHOTON GRENADE LAUNCHER 3+');
        if (roll >= 3) {
          effect(state, {
            rule: E.photonGrenade,
            source: { kind: 'ability', id: ACT.photonGrenadeLauncher },
            sourceText: shortQuote(uniqueActionText(MV15_GUN_DRONE, ACT.photonGrenadeLauncher)),
            operativeId: target.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
          });
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: PHOTON GRENADE LAUNCHER on ${target.letter} (${roll})`,
        });
        return { ok: true };
      },
    }),
  );

  return out;
}

const uniqueActionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// D-021 carve-outs registered once at module load
// ---------------------------------------------------------------------------

/**
 * HARDWIRED TARGET LOCKS' counteraction: "before it counteracts, you must change its order to
 * Engage and it cannot perform any actions other than Shoot during that counteraction."
 */
registerAction({
  id: HARDWIRED_SHOOT,
  name: HARDWIRED_SHOOT,
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: text(EQ.hardwiredTargetLocks),
  available: (ctx, state, op) =>
    state.teams[op.player].equipment.includes(EQ.hardwiredTargetLocks) &&
    (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW) &&
    op.order === 'conceal' &&
    state.opState['counteract']?.['operativeId'] === op.id,
  check(ctx, state, op, params) {
    const order = op.order;
    op.order = 'engage';
    try {
      return getAction('Shoot')!.check(ctx, state, op, params);
    } finally {
      op.order = order;
    }
  },
  perform(ctx, state, op, params) {
    if (op.order === 'conceal') {
      op.order = 'engage';
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter} changes its order to Engage (Hardwired Target Locks)`,
      });
    }
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

/**
 * VECTORED RETRO-THRUSTERS' second half: the charging enemy's free Reposition, "even if it's
 * performed an action that prevents it from performing the Reposition action" — so it carries no
 * `treatedAs` and repeats the universal Reposition's remaining conditions itself.
 */
registerAction({
  id: THRUSTER_REPOSITION,
  name: THRUSTER_REPOSITION,
  ap: 1,
  type: 'unique',
  sourceText: text(FP.vectoredRetroThrusters),
  available: (_ctx, state, op) =>
    typeof (state.opState['xv26.thrusters'] as Record<string, unknown> | undefined)?.[op.id] === 'number',
  check(ctx, state, op, params) {
    if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
      return { ok: false, reason: 'within control range of an enemy operative' };
    return getAction('Reposition')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    const res = getAction('Reposition')!.perform(ctx, state, op, params);
    if (res.ok) delete bucket(state, 'xv26.thrusters')[op.id];
    return res;
  },
});

/**
 * LIBERATOR › Grenadier: "This operative can use frag, krak, smoke and stun grenades." The
 * universal Smoke/Stun Grenade actions are gated on the Utility Grenades equipment, so the
 * LIBERATOR gets its own pair (the Kommandos Taktical Wot-notz / Hearthkyn GRENADIER shape).
 */
function grenadierGrenade(id: string, name: string, delegate: string): void {
  registerAction({
    id,
    name,
    ap: 1,
    type: 'unique',
    sourceText: abilityText(LIBERATOR, AB.grenadier),
    available: (_ctx, _state, op) => op.datacardId === LIBERATOR,
    check(ctx, state, op, params) {
      if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
        return { ok: false, reason: 'within control range of an enemy operative' };
      const relaxed = withGrenadeBudgetIgnored(state, op.player);
      return getAction(delegate)!.check(ctx, relaxed, op, params);
    },
    perform(ctx, state, op, params) {
      const uses = { ...state.teams[op.player].equipmentUses };
      state.teams[op.player].equipmentUses = {
        ...withGrenadeBudgetIgnored(state, op.player).teams[op.player].equipmentUses,
      };
      const res = getAction(delegate)!.perform(ctx, state, op, params);
      state.teams[op.player].equipmentUses = uses;
      return res;
    },
  });
}

grenadierGrenade(GRENADIER_SMOKE, 'Smoke Grenade (Grenadier)', 'Smoke Grenade');
grenadierGrenade(GRENADIER_STUN, 'Stun Grenade (Grenadier)', 'Stun Grenade');

// ---------------------------------------------------------------------------
// FOCUSED MARKERLIGH's effect + SYSTEM JAM / PHOTON GRENADE LAUNCHER stat changes
// ---------------------------------------------------------------------------

function actionEffects(reg: HookRegistry, T: TeamHooks): void {
  /*
   * FOCUSED MARKERLIGH: "Once during this turning point, when a friendly XV26 STEALTH BATTLESUIT
   *  operative is shooting that enemy operative, you can use this effect. If you do, improve the
   *  Hit stat of ranged weapons on that friendly operative's datacard by 1 until the end of that
   *  action."
   *
   * The once-per-turning-point use is CLAIMED at `onCollectAttackDice` (the sequence is live and
   * the emit happens once per target) and the improvement itself rides `onStatMod`, which is the
   * only hook `hitOf` consults. Auto-used on the first friendly shot at that operative (D-022).
   */
  reg.on('onCollectAttackDice', T.bind(ACT.focusedMarkerligh, 14), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.secondary || !mineKw(T, ev.ctx.attacker)) return;
    const target = ev.ctx.defender;
    if (!target) return;
    const mark = effectOn(ev.state, target.id, E.focusedMarkerlight);
    if (!mark || mark.player !== T.player) return;
    if (effectOn(ev.state, ev.ctx.attacker.id, E.focusedMarkerlightLive)) return;
    if (!useOncePerTP(ev.state, `${ACT.focusedMarkerligh}:${T.player}:${target.id}`)) return;
    effect(ev.state, {
      rule: E.focusedMarkerlightLive,
      source: { kind: 'ability', id: ACT.focusedMarkerligh },
      sourceText: shortQuote(uniqueActionText(DESIGNATOR, ACT.focusedMarkerligh)),
      operativeId: ev.ctx.attacker.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Focused Markerligh: ${ev.ctx.attacker.letter} improves its Hit stat by 1`,
    });
  });
  reg.on('onStatMod', T.bind(ACT.focusedMarkerligh, 15), (ev) => {
    if (ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!effectOn(ev.state, ev.operative.id, E.focusedMarkerlightLive)) return;
    ev.mods.hit += 1;
  });

  // SYSTEM JAM: "Whenever this operative has a Conceal order, you must spend 1 additional AP to
  //  perform this action."
  reg.on('onActionCost', T.bind(ACT.systemJam, 14), (ev) => {
    if (ev.operative.player !== T.player || ev.action !== ACT.systemJam) return;
    if (ev.operative.order !== 'conceal') return;
    ev.ap += 1;
  });

  // PHOTON GRENADE LAUNCHER: "subtract 2" from its Move stat".
  reg.on('onStatMod', T.bind(ACT.photonGrenadeLauncher, 14), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, E.photonGrenade);
    if (!eff || eff.player !== T.player) return;
    ev.mods.move -= 2;
  });
}

// ---------------------------------------------------------------------------
// BONDS OF UNITY — the team's own PendingDecision kind
// ---------------------------------------------------------------------------

function decisionHandler(
  _ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== BONDS_DECISION) return false;
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const op = state.operatives[String(payload['operativeId'] ?? '')];
  if (!op) return true;
  const rule = (option?.id ?? 'hit') === 'move' ? E.bondsMove : E.bondsHit;
  effect(state, {
    rule,
    source: { kind: 'ploy', id: SP.bondsOfUnity },
    sourceText: shortQuote(text(SP.bondsOfUnity)),
    operativeId: op.id,
    player: decision.who,
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'ploy',
    player: decision.who,
    text: `Bonds of Unity: ${op.letter} ignores its injured ${rule === E.bondsMove ? 'Move' : 'Hit'} change`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Exported predicates the UI needs for the reminder-only clauses
// ---------------------------------------------------------------------------

/**
 * "Each friendly operative that performs the Dash action cannot end that move within 3" of an
 * enemy operative" — no hook constrains where a move ENDS, so the predicate is exported for the
 * UI (the Ratlings `scarperEndPositionLegal` / Corsair `eruditeEndPositionLegal` precedent).
 */
export function multispectrumDashEndLegal(T: TeamHooks, state: GameState, op: OperativeState, end: Vec2): boolean {
  const probe: OperativeState = { ...op, pos: end };
  return T.enemies(state).every((e) => T.gap(probe, e) > 3 + EPS);
}

// ---------------------------------------------------------------------------

export const xv26StealthBattlesuits = defineTeam({
  id: 'xv26-stealth-battlesuits',
  rules: (reg, T) => {
    rules(reg, T);
    actionEffects(reg, T);
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  gambits,
  actions,
  ployUsable: {
    // "Use this firefight ploy when an enemy operative ends the Charge action within control
    //  range of a friendly XV26 STEALTH BATTLESUIT operative (excluding DRONE)."
    [FP.vectoredRetroThrusters]: (state, player) => {
      // No `GameContext` here, so control range is approximated by the base gap the catalogue
      // knows; `thrusterPair` re-tests it exactly when the ploy resolves.
      const T = makeTeamHooks(DATA, player);
      const ok = aliveOperatives(state, otherPlayer(player)).some(
        (enemy) =>
          enemy.actionsThisActivation.includes('Charge') &&
          aliveOperatives(state, player).some(
            (o) => T.kw(o, KW) && !T.kw(o, DRONE) && T.gap(o, enemy) <= 1 + EPS,
          ),
      );
      return ok
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative has ended the Charge action within control range' };
    },
    // "Use this firefight ploy when a friendly XV26 STEALTH BATTLESUIT operative (excluding
    //  DRONE) is activated or counteracts."
    [FP.engageJetPack]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative is activating or counteracting' };
    },
    // "You cannot use this ploy for each friendly operative more than once per battle."
    [FP.ghostshroud]: (state, player) => {
      const any = aliveOperatives(state, player).some(
        (o) => o.order === 'engage' && !usedThisBattle(state, `${FP.ghostshroud}:${o.id}`),
      );
      return any
        ? { ok: true }
        : { ok: false, reason: 'every friendly operative with an Engage order has already used Ghostshroud' };
    },
  },
  aiHints: {
    roles: {
      [SHAS_VRE]: 'leader',
      [DESIGNATOR]: 'support',
      [INFILTRATOR]: 'scout',
      [LIBERATOR]: 'gunner',
      [LODESTAR]: 'support',
      [NEUTRALISER]: 'support',
      [MV15_GUN_DRONE]: 'gunner',
      [MV75_MARKER_DRONE]: 'scout',
    },
    ployValue: {
      [SP.patientHunters]: 0.6,
      [SP.prepareAmbush]: 0.5,
      [SP.bondsOfUnity]: 0.4,
      [SP.holowaveCountermeasures]: 0.6,
      [FP.vectoredRetroThrusters]: 0.4,
      // Reminder-only: `onMoveRules` is never emitted, so the AI must never spend CP on it.
      [FP.engageJetPack]: 0,
      [FP.ghostshroud]: 0.4,
      [FP.saviourProtocols]: 0.6,
    },
    equipmentValue: {
      [EQ.multitrackers]: 0.4,
      [EQ.blacksunFilters]: 0.6,
      [EQ.counterNetworkJammers]: 0.5,
      [EQ.hardwiredTargetLocks]: 0.5,
    },
  },
});

export default xv26StealthBattlesuits;
