/**
 * BATTLECLADE — Adeptus Mechanicus. https://wahapedia.ru/kill-team3/kill-teams/battleclade/
 * Every printed string quoted here is read from `data/teams/battleclade.json`.
 *
 * The team is one faction rule wide: **Noospheric Network**. A friendly SERVITOR spends 1AP to
 * TRANSFER POWER during its activation, and after that activation one OTHER friendly SERVITOR
 * NETWORK COUNTERACTs — "a counteraction, but the operative doesn't need to be expended with an
 * Engage order to do it", so a READY operative can counteract and still be activated later.
 *
 * `counteractCandidates` pre-filters on `o.expended` BEFORE emitting `onCounteract`, and
 * `whoActivates` only enters counteract mode when the player has no ready operatives, so the core
 * counteract channel cannot express either half. What the core DOES give is `state.opState`
 * `['counteract']`: while it names an operative, `PerformAction` charges 0AP, refuses anything but
 * one non-Guard 1AP action, and `withCounteractCap` hard-caps its movement at 2" — which is
 * exactly the printed "It can then perform a 1AP action for free, but cannot move more than 2"
 * during that action". So NETWORK COUNTERACT is a real `PendingDecision` raised at the end of the
 * activation (through `GameContext.decisionHandlers`, the Hierotek Reanimation Protocols shape);
 * resolving it hands the active slot to the chosen operative with `opState['counteract']` set, and
 * an `onActivationEnd` handler puts a ready operative back to ready afterwards.
 *
 * No rare weapon rules are printed on this team.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseGap, baseRadius, baseWhollyWithin, dist, distancePointToSegment } from '../../core/geometry.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  enemiesInControlRange,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import { isVisible } from '../../core/visibility.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  Order,
  PendingDecision,
  PlayerId,
  Poly,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  chosenOperative,
  currentApl,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  giveToken,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  hasToken,
  notEngaged,
  placeTeamMarker,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('battleclade');
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const card = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  card(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  card(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const KW = 'BATTLECLADE';
export const SERVITOR = 'SERVITOR';
export const TECH_PRIEST = 'TECH-PRIEST';
export const AUTO_PROXY = 'AUTO-PROXY';

export const CARD = {
  technoarcheologist: 'battleclade.technoarcheologist',
  autoProxy: 'battleclade.auto-proxy-servitor',
  breacher: 'battleclade.breacher-servitor',
  combat: 'battleclade.combat-servitor',
  gun: 'battleclade.gun-servitor',
  underseer: 'battleclade.servitor-underseer',
  technomedic: 'battleclade.technomedic-servitor',
} as const;

export const RULE_NETWORK = 'battleclade.rule.noospheric-network';

export const SP = {
  noosphericPossession: 'battleclade.sp.noospheric-possession',
  dutyOfReclamation: 'battleclade.sp.duty-of-reclamation',
  incantation: 'battleclade.sp.incantation-of-the-iron-soul',
  prioritisedAcquisition: 'battleclade.sp.prioritised-acquisition',
} as const;

export const FP = {
  systemExorcism: 'battleclade.fp.system-exorcism',
  remoteAccess: 'battleclade.fp.remote-access',
  autoFerric: 'battleclade.fp.auto-ferric-supplication',
  servileSurrogacy: 'battleclade.fp.servile-surrogacy',
} as const;

export const EQ = {
  covertGuises: 'battleclade.eq.covert-guises',
  electromanticCapacitors: 'battleclade.eq.electromantic-capacitors',
  concealedApparatus: 'battleclade.eq.concealed-apparatus',
  neurocyclicCells: 'battleclade.eq.neurocyclic-reserve-cells',
} as const;

export const AB = {
  seekerOfDivineArcana: 'battleclade.technoarcheologist.seeker-of-divine-arcana',
  achillanEye: 'battleclade.auto-proxy-servitor.achillan-eye',
  mechanosutureArray: 'battleclade.technomedic-servitor.mechanosuture-array',
} as const;

export const ACT = {
  omniscanner: 'battleclade.technoarcheologist.act.omniscanner',
  gaze: 'battleclade.auto-proxy-servitor.act.gaze-of-the-omnissiah',
  breach: 'battleclade.breacher-servitor.act.breach',
  datacoronal: 'battleclade.servitor-underseer.act.datacoronal-accumulator',
  networkOverride: 'battleclade.servitor-underseer.act.network-override',
  expedientRepair: 'battleclade.technomedic-servitor.act.expedient-repair',
} as const;

/** TRANSFER POWER is printed inside the faction rule, not as a datacard unique action. */
export const TRANSFER_POWER = 'Transfer Power';
/** REMOTE ACCESS's hatchway half (D-021 — `canPerformAction` can only forbid, never permit). */
export const REMOTE_OPERATE_HATCH = 'Operate Hatch (Remote Access)';
/**
 * "This operative can perform this action twice during its activation." The reducer refuses a
 * repeated restriction key BEFORE `canPerformAction` is emitted, and a hook can only forbid, so
 * the second use is its own `ActionDef` with its own key (D-021).
 */
export const NETWORK_OVERRIDE_AGAIN = 'battleclade.servitor-underseer.act.network-override.2';
/** Seeker of Divine Arcana is a STRATEGIC GAMBIT printed as a datacard ability. */
export const SEEKER_GAMBIT = AB.seekerOfDivineArcana;

/** The team's own decision kind, claimed through `GameContext.decisionHandlers`. */
export const NETWORK_DECISION = 'battleclade.networkCounteract';

export const OMNISCANNER_TOKEN = 'battleclade.omniscanner';
export const GAZE_TOKEN = 'battleclade.gazeOfTheOmnissiah';

export const EFF = {
  /** PRIORITISED ACQUISITION's chosen marker, per player. */
  prioritised: 'battleclade.prioritisedAcquisition',
  /** COVERT GUISES' revealed D3. */
  covertGuisesD3: 'battleclade.covertGuisesD3',
  /** AUTO-FERRIC SUPPLICATION, armed by the ploy and bound to the first matching sequence. */
  autoFerric: 'battleclade.autoFerricSupplication',
  /** SERVILE SURROGACY, armed by the ploy and consumed by the next Shoot at a TECH-PRIEST. */
  surrogacy: 'battleclade.servileSurrogacy',
  /** Mechanosuture Array: "cannot be incapacitated for the remainder of the action". */
  suture: 'battleclade.mechanosutureShield',
} as const;

/** Namespaced scratch (architecture rule 7 forbids module-level mutable state). */
const NC_QUEUE = 'battleclade.networkQueue';
const NC_ACTIVE = 'battleclade.networkActive';
const SUTURE_LEDGER = 'battleclade.sutureUsedOn';
const APPARATUS_BAG = 'battleclade.concealedApparatus';
const SEEKER_REPOSITION = 'battleclade.seekerReposition';

const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };
const MARKER_MM = 20; // "Objective markers are 40mm; all other markers 20mm" (core rules › Markers).

export const breachMarkerId = (player: PlayerId, n: number): string => `battleclade.breach.${player}.${n}`;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? DEFAULT_BASE;
const live = (o: OperativeState): boolean => !o.removed && !o.incapacitated;

const visibleTo = (T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean =>
  !T.ctx || isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;

const engagedNow = (T: TeamHooks, state: GameState, op: OperativeState): boolean =>
  Boolean(T.ctx) && enemiesInControlRange(T.ctx!, state, op).length > 0;

const hasKw = (ctx: GameContext, op: OperativeState, keyword: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

const gapOf = (ctx: GameContext, a: OperativeState, b: OperativeState): number => {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  return baseGap(a.pos, ca?.base ?? DEFAULT_BASE, a.rot, b.pos, cb?.base ?? DEFAULT_BASE, b.rot);
};

const seesOp = (ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean =>
  isVisible(terrain(ctx, state), body(ctx, a), body(ctx, b)).visible;

const dropZoneOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

/** "one of your mission markers" — a marker your team owns that is not an objective. */
export const missionMarkers = (state: GameState, player: PlayerId): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.owner === player && m.kind !== 'objective');

export const objectiveMarkers = (state: GameState): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.kind === 'objective');

/** "…contests an objective marker or one of your mission markers." */
export function contestsScoringMarker(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  const ctx = T.ctx;
  return [...objectiveMarkers(state), ...missionMarkers(state, op.player)].some((m) =>
    markerContestedBy(ctx, state, m, op),
  );
}

/** The weapon profile currently inflicting damage — `onDamage` always carries `ctx: null`. */
function damageProfile(
  ctx: GameContext,
  state: GameState,
): { profile: WeaponProfile; melee: boolean } | undefined {
  const fight = fightSeq(state);
  if (fight) {
    const attacker = state.operatives[fight.attackerId];
    if (!attacker) return undefined;
    // Only the dmg values are read, and the two sides' profiles are both melee; a fight
    // inflicts one attack dice at a time, so the split below is a single chunk either way.
    const weapon = ctx.datacards.get(attacker.datacardId)?.weapons.find((w) => w.name === fight.attackerWeapon);
    const profile = weapon?.profiles[0];
    return profile ? { profile, melee: true } : undefined;
  }
  const shoot = shootSeq(state);
  if (!shoot) return undefined;
  const attacker = state.operatives[shoot.attackerId];
  if (!attacker) return undefined;
  const weapon = ctx.datacards.get(attacker.datacardId)?.weapons.find((w) => w.name === shoot.weaponName);
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (shoot.profileName ?? '')) ?? weapon?.profiles[0];
  return profile ? { profile, melee: false } : undefined;
}

/**
 * The per-attack-dice damage amounts that add up to one `inflictDamage` call, so a rule printed
 * "whenever an attack dice inflicts damage of 3 or more" can be applied die by die. A fight
 * resolves one die at a time; a shoot aggregates every unblocked success into one call.
 */
export function attackDiceChunks(
  ctx: GameContext,
  state: GameState,
  amount: number,
  kind: string,
): number[] {
  if (kind !== 'attack' && kind !== 'devastating') return [];
  if (fightSeq(state)) return [amount];
  const seq = shootSeq(state);
  if (!seq) return [];
  if (kind === 'devastating') {
    const retained = seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'blocked').length;
    if (retained > 1 && amount % retained === 0) return Array.from({ length: retained }, () => amount / retained);
    return [amount];
  }
  const info = damageProfile(ctx, state);
  if (!info) return [amount];
  const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
  const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
  if (crits * info.profile.dmgC + normals * info.profile.dmgN !== amount) return [amount];
  return [
    ...Array.from({ length: crits }, () => info.profile.dmgC),
    ...Array.from({ length: normals }, () => info.profile.dmgN),
  ];
}

// ---------------------------------------------------------------------------
// Noospheric Network — TRANSFER POWER and NETWORK COUNTERACT
// ---------------------------------------------------------------------------

interface NcRequest {
  /** The operative whose activation armed it (excluded from its own offer). */
  by: string;
  /** NETWORK OVERRIDE names its operative; the faction rule offers every eligible one. */
  targetId?: string;
  /** The printed rule that armed it, for the log and the decision's tooltip. */
  source: string;
}

const ncQueue = (state: GameState, player: PlayerId): NcRequest[] => {
  const bag = bucket(state, NC_QUEUE);
  const list = (bag[player] as NcRequest[] | undefined) ?? [];
  bag[player] = list;
  return list;
};

export const queuedNetworkCounteracts = (state: GameState, player: PlayerId): NcRequest[] => [
  ...ncQueue(state, player),
];

function queueNetworkCounteract(state: GameState, player: PlayerId, req: NcRequest): void {
  ncQueue(state, player).push(req);
}

/**
 * "An operative cannot TRANSFER POWER or NETWORK COUNTERACT if it has an APL stat of less than 2
 * (e.g. if the stat has been changed to less than 2 by a rule)."
 */
export const aplAllowsNetwork = (T: TeamHooks, state: GameState, op: OperativeState): boolean =>
  currentApl(T, state, op) >= 2;

/**
 * "…one other friendly BATTLECLADE SERVITOR operative". "An operative that does NETWORK
 * COUNTERACT cannot do so again, or counteract, during the same turning point" — which is exactly
 * what `counteractedThisTP` means to `counteractCandidates`, so the flag is shared with the core.
 */
export function networkCounteractCandidates(
  T: TeamHooks,
  state: GameState,
  req: NcRequest,
): OperativeState[] {
  const pool = req.targetId
    ? [state.operatives[req.targetId]].filter((o): o is OperativeState => Boolean(o))
    : T.friendlies(state, SERVITOR);
  return pool
    .filter(
      (o) =>
        o.player === T.player &&
        o.id !== req.by &&
        live(o) &&
        T.kw(o, KW) &&
        T.kw(o, SERVITOR) &&
        !o.counteractedThisTP &&
        // "That friendly operative cannot counteract during the turning point" (Guard).
        o.guardSpentTP !== state.turningPoint &&
        aplAllowsNetwork(T, state, o),
    )
    .sort(byId);
}

/**
 * The decision. Counteract options come FIRST so the engine's own deterministic default
 * (`defaultDecisionOption` takes the first enabled option) uses the rule rather than declining —
 * NETWORK COUNTERACT is free once TRANSFER POWER has been paid for, so declining is never the
 * neutral answer.
 */
function offerNetworkCounteract(T: TeamHooks, state: GameState, req: NcRequest): boolean {
  const candidates = networkCounteractCandidates(T, state, req);
  if (candidates.length === 0) return false;
  const options: PendingDecision['options'] = [];
  for (const o of candidates) {
    for (const order of ['engage', 'conceal'] as const) {
      options.push({
        id: `${o.id}|${order}`,
        label: `NETWORK COUNTERACT with ${o.letter} (${order})`,
        data: { operativeId: o.id, order, source: req.source },
      });
    }
  }
  options.push({ id: 'decline', label: 'Do not NETWORK COUNTERACT' });
  state.pending.push({
    id: `battleclade-nc-${state.seq++}`,
    who: T.player,
    kind: NETWORK_DECISION,
    prompt: 'Noospheric Network: NETWORK COUNTERACT with one other friendly BATTLECLADE SERVITOR operative',
    sourceText: shortQuote(text(RULE_NETWORK)),
    optional: true,
    options,
  });
  return true;
}

/**
 * Hand the active slot to the counteracting operative. `opState['counteract']` is the core's own
 * counteraction state: `PerformAction` charges 0AP, allows exactly one non-Guard 1AP action, and
 * `withCounteractCap` hard-caps the move at 2".
 */
export function beginNetworkCounteract(state: GameState, op: OperativeState, order: Order, source: string): void {
  bucket(state, NC_ACTIVE)[op.id] = op.ready ? 'ready' : 'expended';
  op.order = order; // "Whenever you NETWORK COUNTERACT with a friendly operative, first select its order."
  op.counteractedThisTP = true;
  op.apSpent = 0;
  op.actionsThisActivation = [];
  state.activeOperativeId = op.id;
  state.activePlayer = op.player;
  state.opState['counteract'] = { operativeId: op.id, actionsUsed: 0 };
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} NETWORK COUNTERACTS (${order})`,
    data: { operativeId: op.id, source },
  });
}

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== NETWORK_DECISION) return false;
  const player = decision.who;
  if (optionId === 'decline' || optionId === 'skip' || optionId === 'pass') {
    log(state, { kind: 'ploy', player, text: 'Noospheric Network: declines to NETWORK COUNTERACT' });
    return true;
  }
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const op = state.operatives[String(payload['operativeId'] ?? '')];
  const order: Order = payload['order'] === 'conceal' ? 'conceal' : 'engage';
  const source = String(payload['source'] ?? RULE_NETWORK);
  // The activation that armed it may have ended the turning point, or a rule may already hold
  // the active slot; in either case the window the rule names is gone.
  if (!op || op.player !== player || !live(op) || op.counteractedThisTP) return true;
  if (state.phase !== 'firefight' || state.activeOperativeId) return true;
  if (aplOf(ctx, state, op) < 2) return true;
  beginNetworkCounteract(state, op, order, source);
  return true;
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  noosphericNetwork(reg, T);
  seekerOfDivineArcana(reg, T);
  achillanEye(reg, T);
  mechanosutureArray(reg, T);
}

function noosphericNetwork(reg: HookRegistry, T: TeamHooks): void {
  // A ready operative that NETWORK COUNTERACTs is put back to ready: "if they're ready when they
  // NETWORK COUNTERACT, they can still be activated as normal later in the turning point".
  // `EndActivation` sets `expended`/`ready` BEFORE emitting `onActivationEnd`, so this runs after.
  reg.on('onActivationEnd', T.bind(RULE_NETWORK, 9), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const bag = bucket(ev.state, NC_ACTIVE);
    const was = bag[op.id];
    if (was === undefined) return;
    delete bag[op.id];
    if (was === 'ready') {
      op.ready = true;
      op.expended = false;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `${op.letter} stays ready after NETWORK COUNTERACTING`,
      });
    }
  });

  // "After that activation, you can NETWORK COUNTERACT … before your opponent activates."
  // The queue also carries NETWORK OVERRIDE's requests, and a chained offer after each
  // counteraction lets two of them resolve in order.
  reg.on('onActivationEnd', T.bind(RULE_NETWORK, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (ev.state.pending.length > 0) return;
    const queue = ncQueue(ev.state, T.player);
    while (queue.length > 0) {
      const req = queue.shift()!;
      if (offerNetworkCounteract(T, ev.state, req)) return;
    }
  });

  // The queue never survives its turning point ("before your opponent activates").
  reg.on('onEndOfTP', T.bind(RULE_NETWORK, 11), (ev) => {
    bucket(ev.state, NC_QUEUE)[T.player] = [];
  });
}

/**
 * Seeker of Divine Arcana — "STRATEGIC GAMBIT. You can immediately change this operative's order
 * and/or it can immediately perform a free Omniscanner, Fall Back, Place Marker, Pick Up Marker,
 * Reposition or mission action."
 */
const SEEKER_ACTIONS = [ACT.omniscanner, 'Fall Back', 'Place Marker', 'Pick Up Marker', 'Reposition'];

function seekerOfDivineArcana(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onPloyUsed', T.bind(AB.seekerOfDivineArcana, 11), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SEEKER_GAMBIT) return;
    const arch = T.friendlies(ev.state).find((o) => o.datacardId === CARD.technoarcheologist && live(o));
    if (!arch) return;
    // "You can immediately change this operative's order" — D-016: the player's choice comes
    // through `data`, and the deterministic default is to leave the order alone.
    const asked = ev.data?.['order'];
    if (asked === 'engage' || asked === 'conceal') arch.order = asked;
    grantFreeAction(ev.state, arch, {
      sourceId: AB.seekerOfDivineArcana,
      sourceText: shortQuote(abilityText(CARD.technoarcheologist, AB.seekerOfDivineArcana)),
      threshold: currentApl(T, ev.state, arch),
      kind: 'ability',
      only: SEEKER_ACTIONS,
    });
    // COVERT GUISES: "Your TECHNOARCHEOLOGIST operative cannot perform more than one Reposition
    // action in the Strategy phase of the first turning point (i.e. as a result of the Seeker of
    // Divine Arcana rule as well)."
    bucket(ev.state, SEEKER_REPOSITION)[T.player] = ev.state.turningPoint;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Seeker of Divine Arcana: ${arch.letter} may change order and take a free action`,
    });
  });
  // "…or mission action": `grantFreeAction`'s `only` list is a plain name match, so the mission
  // actions (owned by src/core/ops/**) are re-allowed here, above the free-action engine's
  // priority 5. The engine's own restriction still refuses everything else.
  reg.on('canPerformAction', T.bind(AB.seekerOfDivineArcana, 6), (ev) => {
    if (ev.allowed || ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, 'teamFreeAction');
    if (!eff || eff.source.id !== AB.seekerOfDivineArcana) return;
    if (getAction(ev.action)?.type !== 'mission') return;
    ev.allowed = true;
    delete ev.reason;
  });
}

/**
 * Achillan Eye — "Whenever a friendly BATTLECLADE operative is shooting an enemy operative visible
 * to this operative, that friendly operative's ranged weapons have the Saturate weapon rule. This
 * rule has no effect if this operative is within control range of an enemy operative."
 */
function achillanEye(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onWeaponRules', T.bind(AB.achillanEye, 11), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const target = ev.target;
    if (!target || target.player === T.player) return;
    const eye = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CARD.autoProxy &&
        live(o) &&
        !engagedNow(T, ev.state, o) &&
        visibleTo(T, ev.state, o, target),
    );
    if (!eye) return;
    if (ev.rules.some((r) => r.id === 'Saturate')) return;
    ev.rules.push({ id: 'Saturate', raw: 'Saturate (Achillan Eye)' });
  });
}

/**
 * Mechanosuture Array — "Once per turning point, when another friendly BATTLECLADE operative would
 * be incapacitated while visible to and within 3" of this operative, you can use this rule …"
 */
function mechanosutureArray(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onIncapacitated', T.bind(AB.mechanosutureArray, 11), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW) || !T.ctx) return;
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CARD.technomedic &&
        o.id !== victim.id && // "another friendly BATTLECLADE operative"
        !o.incapacitated && // "You cannot use this rule if this operative is incapacitated"
        !o.removed &&
        T.gap(o, victim) <= 3 + EPS &&
        visibleTo(T, ev.state, o, victim) &&
        // "providing neither this nor that operative is within control range of an enemy operative"
        !engagedNow(T, ev.state, o) &&
        !engagedNow(T, ev.state, victim),
    );
    if (!medic) return;
    // "…or if it's a Shoot action and this operative would be a primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    if (!useOncePerTP(ev.state, `battleclade.suture:${T.player}`)) return;

    ev.prevented = true;
    victim.wounds = 1; // "that friendly operative isn't incapacitated, has 1 wound remaining"
    bucket(ev.state, SUTURE_LEDGER)[victim.id] = true;
    effect(ev.state, {
      rule: EFF.suture,
      source: { kind: 'ability', id: AB.mechanosutureArray },
      sourceText: shortQuote(abilityText(CARD.technomedic, AB.mechanosutureArray)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
    // "After that action, that friendly operative can immediately perform a free Dash action" —
    // D-015 — "…If this rule was used during that friendly operative's activation, that
    // activation ends", so from here the Dash is the only action it may still perform.
    // REMINDER ONLY: "but must end that move within this operative's control range" — no hook
    // constrains where a move ENDS (`sutureDashEndLegal` is exported for the UI).
    grantFreeAction(ev.state, victim, {
      sourceId: AB.mechanosutureArray,
      sourceText: shortQuote(abilityText(CARD.technomedic, AB.mechanosutureArray)),
      threshold: ev.state.activeOperativeId === victim.id ? victim.apSpent : currentApl(T, ev.state, victim),
      kind: 'ability',
      only: ['Dash'],
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Mechanosuture Array: ${victim.letter} stays on 1 wound (${medic.letter})`,
    });
  });
  // "…and cannot be incapacitated for the remainder of the action."
  reg.on('onIncapacitated', T.bind(AB.mechanosutureArray, 10), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, EFF.suture)) return;
    ev.prevented = true;
    if (ev.operative.wounds <= 0) ev.operative.wounds = 1;
  });
  // `endOfAction` effects are only swept at the end of a turning point, so the shield is dropped
  // at the activation boundary instead — tighter than the engine's own expiry.
  reg.on('onActivationEnd', T.bind(AB.mechanosutureArray, 12), (ev) => {
    void ev.operative;
    dropEffects(ev.state, (e) => e.rule === EFF.suture && e.player === T.player);
  });
  // EXPEDIENT REPAIR: "It cannot be an operative that the Mechanosuture Array rule was used on
  // during this turning point" — the ledger is cleared in the Ready step of each Strategy phase.
  reg.on('onReadyStep', T.bind(AB.mechanosutureArray, 13), (ev) => {
    if (ev.player !== T.player) return;
    ev.state.opState[SUTURE_LEDGER] = {};
  });
}

export const sutureUsedOn = (state: GameState, operativeId: string): boolean =>
  Boolean(bucket(state, SUTURE_LEDGER)[operativeId]);

/** The end-of-move constraint the engine cannot enforce, exported for the UI. */
export function sutureDashEndLegal(
  T: TeamHooks,
  victim: OperativeState,
  medic: OperativeState,
  end: Vec2,
): boolean {
  const probe: OperativeState = { ...victim, pos: end };
  return T.gap(probe, medic) <= 1 + EPS;
}

// ---------------------------------------------------------------------------
// Strategy ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  strategyPloys(reg, T);
  firefightPloys(reg, T);
}

function strategyPloys(reg: HookRegistry, T: TeamHooks): void {
  // ---- NOOSPHERIC POSSESSION ----------------------------------------------
  // "SUPPORT. Whenever a friendly BATTLECLADE SERVITOR operative is within 6" of a friendly
  //  BATTLECLADE AUTO-PROXY or BATTLECLADE SERVITOR UNDERSEER operative, that friendly SERVITOR
  //  operative's weapons have the Accurate 1 weapon rule."
  reg.on('onWeaponRules', T.bind(SP.noosphericPossession, 20), (ev) => {
    if (!T.ctx) return;
    if (!gambitUsedBy(ev.state, T.player, SP.noosphericPossession)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW) || !T.kw(op, SERVITOR)) return;
    if (!possessionAnchor(T, ev.state, op)) return;
    ev.rules.push({ id: 'Accurate', x: 1, raw: 'Accurate 1 (Noospheric Possession)' });
  });

  // ---- DUTY OF RECLAMATION ------------------------------------------------
  // "Once per action, you can use the Command Re-roll firefight ploy for 0CP if the attack or
  //  defence dice was rolled for a friendly BATTLECLADE operative that contests an objective
  //  marker or one of your mission markers."
  //
  // CP is charged from `decision.ctx.cp` when the re-roll is taken, so "for 0CP" is expressed by
  // zeroing the grant's price. When the core did not offer one at all (the team is out of CP, or
  // the ploy was already used this turning point) the free grant is pushed here instead.
  const freeCommandReroll = (state: GameState, grants: RerollGrant[], who: PlayerId, side: string): void => {
    const existing = grants.find((g) => g.id.startsWith('commandReroll'));
    if (existing) {
      existing.cp = 0;
      existing.label = `${existing.label.replace(' (1CP)', '')} — Duty of Reclamation (0CP)`;
      return;
    }
    grants.push({
      id: `commandReroll:${side}`,
      label: 'Command Re-roll — Duty of Reclamation (0CP): re-roll one of those dice',
      mode: 'one',
      max: 1,
      cp: 0,
      player: who,
      sourceText: shortQuote(text(SP.dutyOfReclamation)),
    });
  };
  reg.on('onRollAttack', T.bind(SP.dutyOfReclamation, 20), (ev) => {
    if (!gambitUsedBy(ev.state, T.player, SP.dutyOfReclamation)) return;
    const shooter = ev.ctx.attacker;
    if (!T.mineKw(shooter, KW) || !contestsScoringMarker(T, ev.state, shooter)) return;
    freeCommandReroll(ev.state, ev.rerolls, T.player, 'attack');
  });
  reg.on('onDefenceDice', T.bind(SP.dutyOfReclamation, 20), (ev) => {
    if (!gambitUsedBy(ev.state, T.player, SP.dutyOfReclamation)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    const defender = ev.ctx.defender;
    if (!defender || !T.mineKw(defender, KW) || !contestsScoringMarker(T, ev.state, defender)) return;
    freeCommandReroll(ev.state, ev.rerolls, T.player, 'defence');
  });

  // ---- INCANTATION OF THE IRON SOUL ---------------------------------------
  // "Whenever an attack dice inflicts damage of 3 or more on a friendly BATTLECLADE operative,
  //  roll one D6: on a 4+, subtract 1 from that inflicted damage."
  reg.on('onDamage', T.bind(SP.incantation, 20), (ev) => {
    if (!T.ctx) return;
    if (!gambitUsedBy(ev.state, T.player, SP.incantation)) return;
    if (!T.mineKw(ev.target, KW)) return;
    const chunks = attackDiceChunks(T.ctx, ev.state, ev.amount, ev.kind);
    let saved = 0;
    for (const chunk of chunks) {
      if (chunk < 3) continue;
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'incantationOfTheIronSoul', [roll], T.player, 'Incantation of the Iron Soul D6 4+');
      if (roll >= 4) saved += 1;
    }
    if (saved === 0) return;
    ev.amount = Math.max(0, ev.amount - saved);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Incantation of the Iron Soul: ${ev.target.letter} ignores ${saved} damage`,
    });
  });

  // ---- PRIORITISED ACQUISITION --------------------------------------------
  // "Select one objective marker or one of your mission markers."
  reg.on('onPloyUsed', T.bind(SP.prioritisedAcquisition, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.prioritisedAcquisition) return;
    const marker = prioritisedTarget(T, ev.state, ev.data);
    if (!marker) return;
    dropEffects(ev.state, (e) => e.rule === EFF.prioritised && e.player === T.player);
    effect(ev.state, {
      rule: EFF.prioritised,
      source: { kind: 'ploy', id: SP.prioritisedAcquisition },
      sourceText: shortQuote(text(SP.prioritisedAcquisition)),
      player: T.player,
      data: { markerId: marker.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Prioritised Acquisition: ${marker.id} is the prioritised marker`,
    });
  });
  // "Whenever determining control of that marker, treat the total APL stat of friendly BATTLECLADE
  //  operatives that contest it as 1 higher if at least one friendly BATTLECLADE operative
  //  contests that marker. Note this isn't a change to the APL stat, so any changes are cumulative
  //  with this."
  reg.on('onMarkerControl', T.bind(SP.prioritisedAcquisition, 21), (ev) => {
    if (!T.ctx) return;
    const ctx = T.ctx;
    if (prioritisedMarkerId(ev.state, T.player) !== ev.markerId) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const contesting = T.friendlies(ev.state, KW).some((o) => markerContestedBy(ctx, ev.state, marker, o));
    if (!contesting) return;
    ev.aplByPlayer[T.player] += 1;
  });
  // "Whenever a friendly BATTLECLADE operative is within 3" of that marker, add 1 to the Atk stat
  //  of its melee weapons (to a maximum of 4)."
  reg.on('onCollectAttackDice', T.bind(SP.prioritisedAcquisition, 21), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (!T.mineKw(op, KW)) return;
    const markerId = prioritisedMarkerId(ev.state, T.player);
    const marker = markerId ? ev.state.markers[markerId] : undefined;
    if (!marker) return;
    if (T.markerGap(op, marker) > 3 + EPS) return;
    if (ev.ctx.profile.atk >= 4) return; // "(to a maximum of 4)"
    ev.mods.atk += 1;
  });
}

/** A strategy ploy is used in the Gambit step, so it lands in `gambitsUsedTP`. */
const gambitUsedBy = (state: GameState, player: PlayerId, id: string): boolean =>
  state.teams[player].gambitsUsedTP.includes(id) || state.teams[player].ploysUsedTP.includes(id);

export const prioritisedMarkerId = (state: GameState, player: PlayerId): string | undefined => {
  const eff = effectFor(state, player, EFF.prioritised);
  const id = eff?.data?.['markerId'];
  return typeof id === 'string' ? id : undefined;
};

/**
 * "…within 6" of a friendly BATTLECLADE AUTO-PROXY or BATTLECLADE SERVITOR UNDERSEER operative."
 * SUPPORT, so the distance is measured from the anchor and a Comms Device it controls widens it.
 */
export function possessionAnchor(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
): OperativeState | undefined {
  if (!T.ctx) return undefined;
  const ctx = T.ctx;
  return T.friendlies(state, KW)
    .filter((o) => live(o) && (T.kw(o, AUTO_PROXY) || o.datacardId === CARD.underseer))
    .sort(byId)
    .find((anchor) => T.gap(anchor, op) <= supportDistance(ctx, state, anchor, 6) + EPS);
}

/** D-016: the player's marker comes through `data`; the default is the most contested one. */
function prioritisedTarget(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): MarkerState | undefined {
  const pool = [...objectiveMarkers(state), ...missionMarkers(state, T.player)];
  const asked = data?.['markerId'];
  if (typeof asked === 'string') {
    const found = pool.find((m) => m.id === asked);
    if (found) return found;
  }
  if (!T.ctx) return [...pool].sort(byId)[0];
  const ctx = T.ctx;
  const score = (m: MarkerState): number =>
    T.friendlies(state, KW).filter((o) => markerContestedBy(ctx, state, m, o)).length;
  return [...pool].sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1))[0];
}

// ---------------------------------------------------------------------------
// Firefight ploys
// ---------------------------------------------------------------------------

function firefightPloys(reg: HookRegistry, T: TeamHooks): void {
  // ---- SYSTEM EXORCISM ----------------------------------------------------
  // "Use this firefight ploy when you would activate a friendly BATTLECLADE operative. Remove one
  //  rules effect or stat change your opponent has applied to it (e.g. Poison token, -1APL, cannot
  //  be activated or perform actions, etc.), then activate it. This ploy cannot allow it to regain
  //  lost wounds or ignore the effects of being injured, remove mission pack rules."
  reg.on('onPloyUsed', T.bind(FP.systemExorcism, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.systemExorcism) return;
    const target = chosenOperative(ev.state, ev.data, exorcismCandidates(T, ev.state));
    if (!target) {
      log(ev.state, { kind: 'ploy', player: T.player, text: 'System Exorcism: nothing to remove' });
      return;
    }
    // A stated deterministic policy (D-022): the worst thing first — an APL penalty, then the
    // first effect the opponent put on it. Wounds and injury are never touched, and mission-pack
    // rules live in `src/core/ops/**` which this module never reaches into.
    const apl = target.aplMods.indexOf(-1);
    if (apl >= 0) {
      target.aplMods.splice(apl, 1);
      log(ev.state, { kind: 'ploy', player: T.player, text: `System Exorcism: ${target.letter} sheds -1 APL` });
      return;
    }
    // "…remove mission pack rules": an op's own effects (`source.kind === 'op'`) are left alone.
    const foreign = ev.state.effects.find(
      (e) => e.operativeId === target.id && e.player === otherPlayer(T.player) && e.source.kind !== 'op',
    );
    if (foreign) {
      dropEffects(ev.state, (e) => e === foreign);
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `System Exorcism: ${target.letter} sheds ${foreign.rule}`,
      });
    }
  });

  // ---- REMOTE ACCESS ------------------------------------------------------
  // The hatchway half is the `Operate Hatch (Remote Access)` ActionDef below (D-021).
  // The mission-action half is REMINDER ONLY — see REMINDER_ONLY.
  void reg;

  // ---- AUTO-FERRIC SUPPLICATION -------------------------------------------
  // "Use this firefight ploy when an operative is shooting a friendly BATTLECLADE TECH-PRIEST
  //  operative, at the start of the Roll Attack Dice step. Until the end of the sequence, ignore
  //  the Piercing weapon rule."
  reg.on('onPloyUsed', T.bind(FP.autoFerric, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.autoFerric) return;
    effect(ev.state, {
      rule: EFF.autoFerric,
      source: { kind: 'ploy', id: FP.autoFerric },
      sourceText: shortQuote(text(FP.autoFerric)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onWeaponRules', T.bind(FP.autoFerric, 21), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating) return;
    const target = ev.target;
    if (!target || target.player !== T.player || !T.kw(target, KW) || !T.kw(target, TECH_PRIEST)) return;
    const armed = effectFor(ev.state, T.player, EFF.autoFerric);
    if (!armed) return;
    const seq = shootSeq(ev.state);
    const stamp = seq ? `${seq.attackerId}:${seq.targetId}` : 'pending';
    const bound = armed.data?.['sequence'];
    // "Until the end of the sequence" — the ploy binds to the first sequence that matches it.
    if (typeof bound === 'string' && bound !== stamp) return;
    if (bound === undefined && seq) armed.data = { ...(armed.data ?? {}), sequence: stamp };
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing');
  });

  // ---- SERVILE SURROGACY --------------------------------------------------
  // "Use this firefight ploy when a friendly BATTLECLADE TECH-PRIEST operative is selected as the
  //  valid target of a Shoot action or to fight against during the Fight action. Select one
  //  friendly BATTLECLADE SERVITOR operative visible to and within 3" of that first friendly
  //  operative to become the valid target or to be fought against (as appropriate) instead (even
  //  if it wouldn't normally be valid for this)."
  reg.on('onPloyUsed', T.bind(FP.servileSurrogacy, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.servileSurrogacy) return;
    effect(ev.state, {
      rule: EFF.surrogacy,
      source: { kind: 'ploy', id: FP.servileSurrogacy },
      sourceText: shortQuote(text(FP.servileSurrogacy)),
      player: T.player,
      ...(typeof ev.data?.['operativeId'] === 'string' ? { data: { operativeId: ev.data['operativeId'] } } : {}),
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onSelectTarget', T.bind(FP.servileSurrogacy, 21), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || !T.kw(target, KW) || !T.kw(target, TECH_PRIEST)) return;
    const armed = effectFor(ev.state, T.player, EFF.surrogacy);
    if (!armed) return;
    // "This ploy has no effect if it's the Shoot action and the ranged weapon has the Blast or
    //  Torrent weapon rule."
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    const candidates = surrogacyCandidates(T, ev.state, target);
    const asked = armed.data?.['operativeId'] as string | undefined;
    const shield = candidates.find((o) => o.id === asked) ?? candidates[0];
    if (!shield) return;
    // "…that SERVITOR operative is only in cover or obscured if the original target was" — which
    // is exactly what `onSelectTarget`'s substitution already does.
    ev.redirectTo = shield.id;
    dropEffects(ev.state, (e) => e === armed);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Servile Surrogacy: ${shield.letter} is targeted instead of ${target.letter}`,
    });
  });
  // REMINDER ONLY: the Fight half ("or to be fought against … treat that SERVITOR operative as
  // being within the fighting operative's control range for the duration of that action").
}

/** SYSTEM EXORCISM: a friendly operative your opponent has actually put something on. */
export function exorcismCandidates(T: TeamHooks, state: GameState): OperativeState[] {
  const foe = otherPlayer(T.player);
  return T.friendlies(state, KW)
    .filter(
      (o) =>
        live(o) &&
        o.ready &&
        (o.aplMods.includes(-1) ||
          state.effects.some((e) => e.operativeId === o.id && e.player === foe && e.source.kind !== 'op')),
    )
    .sort(byId);
}

export function surrogacyCandidates(T: TeamHooks, state: GameState, priest: OperativeState): OperativeState[] {
  return T.friendlies(state, SERVITOR)
    .filter((o) => live(o) && T.kw(o, KW) && T.gap(o, priest) <= 3 + EPS && visibleTo(T, state, priest, o))
    .sort(byId);
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- COVERT GUISES -------------------------------------------------------
  // "After revealing this equipment option, roll one D3. As a STRATEGIC GAMBIT in the first turning
  //  point, a number of friendly BATTLECLADE operatives equal to the result that are wholly within
  //  your drop zone can immediately perform a free Reposition action…"
  reg.on('onSelectEquipment', T.bind(EQ.covertGuises, 30), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!ev.equipment.includes(EQ.covertGuises)) return;
    if (!useOncePerBattle(ev.state, `battleclade.covertGuises:${T.player}`)) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'covertGuises', [d3], T.player, 'COVERT GUISES D3');
    effect(ev.state, {
      rule: EFF.covertGuisesD3,
      source: { kind: 'equipment', id: EQ.covertGuises },
      sourceText: shortQuote(text(EQ.covertGuises)),
      player: T.player,
      data: { count: d3 },
      expiry: { kind: 'endOfBattle' },
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.covertGuises, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.covertGuises) return;
    const rolled = effectFor(ev.state, T.player, EFF.covertGuisesD3);
    const count = Number(rolled?.data?.['count'] ?? 1);
    const zones = dropZoneOf(ev.state, T.player);
    // "Your TECHNOARCHEOLOGIST operative cannot perform more than one Reposition action in the
    //  Strategy phase of the first turning point (i.e. as a result of the Seeker of Divine Arcana
    //  rule as well)."
    const seekerUsed = bucket(ev.state, SEEKER_REPOSITION)[T.player] === ev.state.turningPoint;
    const eligible = T.friendlies(ev.state, KW)
      .filter((o) => {
        if (!live(o)) return false;
        if (seekerUsed && o.datacardId === CARD.technoarcheologist) return false;
        const c = T.card(o);
        return c !== undefined && zones.length > 0 && baseWhollyWithin(o.pos, c.base, o.rot, zones);
      })
      .sort(byId)
      .slice(0, count);
    for (const op of eligible) {
      // REMINDER ONLY: "must end that move wholly within 3" of your drop zone" — `validateMove`
      // has no end-region option and `onMoveRules` is never emitted.
      grantFreeAction(ev.state, op, {
        sourceId: EQ.covertGuises,
        sourceText: shortQuote(text(EQ.covertGuises)),
        threshold: currentApl(T, ev.state, op),
        kind: 'equipment',
        only: ['Reposition'],
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Covert Guises: ${eligible.length} of ${count} BATTLECLADE operatives may Reposition for free`,
    });
  });

  // ---- ELECTROMANTIC CAPACITORS -------------------------------------------
  // "Friendly BATTLECLADE operatives' melee weapons have the Shock weapon rule. Whenever a friendly
  //  BATTLECLADE operative is retaliating, its melee weapons also have the Severe weapon rule."
  reg.on('onWeaponRules', T.bind(EQ.electromanticCapacitors, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.electromanticCapacitors)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    if (!ev.rules.some((r) => r.id === 'Shock')) ev.rules.push({ id: 'Shock', raw: 'Shock (Electromantic Capacitors)' });
    if (ev.retaliating && !ev.rules.some((r) => r.id === 'Severe'))
      ev.rules.push({ id: 'Severe', raw: 'Severe (Electromantic Capacitors)' });
  });

  // ---- CONCEALED APPARATUS -------------------------------------------------
  // "Once per battle, one COMBAT SERVITOR or GUN SERVITOR operative can use another weapon option
  //  on its datacard it didn't select for the battle."
  //
  // The loadout filter in `weaponsOf` runs AFTER `availableWeapons`, so a weapon the roster did not
  // select cannot be restored through that hook — `grantWeapon` (which bypasses the filter) is the
  // only channel. D-022: a free "you can use this rule" is auto-used on a stated deterministic
  // policy — the first such operative to activate, taking the first printed datacard weapon it did
  // not select. The grant is dropped again at the end of that activation, so it is one use.
  reg.on('onActivationStart', T.bind(EQ.concealedApparatus, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.concealedApparatus) || !T.ctx) return;
    const op = ev.operative;
    if (op.player !== T.player) return;
    if (op.datacardId !== CARD.combat && op.datacardId !== CARD.gun) return;
    const bag = bucket(ev.state, APPARATUS_BAG);
    if (bag[T.player] !== undefined) return;
    const spare = concealedApparatusWeapon(T.ctx, ev.state, op);
    if (!spare) return;
    bag[T.player] = op.id;
    bucket(ev.state, `${APPARATUS_BAG}.name`)[op.id] = spare.name;
    grantWeapon(op, structuredClone(spare));
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Concealed Apparatus: ${op.letter} assembles its ${spare.name}`,
    });
  });
  reg.on('onActivationEnd', T.bind(EQ.concealedApparatus, 31), (ev) => {
    const op = ev.operative as OperativeState & { grantedWeapons?: { name: string }[] };
    if (op.player !== T.player) return;
    if (bucket(ev.state, APPARATUS_BAG)[T.player] !== op.id) return;
    const spare = concealedApparatusName(ev.state, op.id);
    if (spare && op.grantedWeapons) op.grantedWeapons = op.grantedWeapons.filter((w) => w.name !== spare);
  });

  // ---- NEUROCYCLIC RESERVE CELLS ------------------------------------------
  // "Once per turning point whenever you TRANSFER POWER, you can use this rule. If you do, you can
  //  TRANSFER POWER for 0AP (this takes precedence over the normal Noospheric Network rules)."
  //
  // `actionCost` is a pure query the AI runs many times, so the once-per-turning-point stamp is
  // claimed in the action's `perform` — the reducer charges the cost it computed here.
  reg.on('onActionCost', T.bind(EQ.neurocyclicCells, 30), (ev) => {
    if (ev.action !== TRANSFER_POWER || ev.operative.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ.neurocyclicCells)) return;
    if (usedThisTP(ev.state, `battleclade.neurocyclic:${T.player}`)) return;
    ev.ap = 0;
  });
}

/** The datacard weapon this operative did NOT select for the battle. */
export function concealedApparatusWeapon(ctx: GameContext, state: GameState, op: OperativeState) {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return undefined;
  const loadout = ((state.opState['loadout'] ?? {}) as Record<string, string[]>)[op.id] ?? [];
  const chosen = new Set(loadout.map((n) => n.trim().toLowerCase()));
  if (chosen.size === 0) return undefined;
  return c.weapons.find((w) => !chosen.has(w.name.trim().toLowerCase()));
}

const concealedApparatusName = (state: GameState, operativeId: string): string | undefined => {
  const bag = bucket(state, `${APPARATUS_BAG}.name`);
  return typeof bag[operativeId] === 'string' ? (bag[operativeId] as string) : undefined;
};

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** OMNISCANNER: "one enemy operative visible to or within 8" of this operative". */
export function omniscannerTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, otherPlayer(op.player))
    .filter((o) => !o.incapacitated)
    .filter((o) => seesOp(ctx, state, op, o) || gapOf(ctx, op, o) <= 8 + EPS)
    .sort(byId);
}

/** GAZE OF THE OMNISSIAH: "one enemy operative visible to this operative". */
export function gazeTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, otherPlayer(op.player))
    .filter((o) => !o.incapacitated && seesOp(ctx, state, op, o))
    .sort(byId);
}

/** EXPEDIENT REPAIR: "one friendly BATTLECLADE operative within this operative's control range". */
export function repairTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, op.player)
    .filter(
      (o) =>
        !o.incapacitated &&
        hasKw(ctx, o, KW) &&
        gapOf(ctx, op, o) <= 1 + EPS &&
        // "It cannot be an operative that the Mechanosuture Array rule was used on during this
        //  turning point."
        !sutureUsedOn(state, o.id),
    )
    .sort(byId);
}

/** NETWORK OVERRIDE / DATACORONAL ACCUMULATOR: "this operative and/or a friendly AUTO-PROXY". */
export function networkAnchors(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return [
    op,
    ...aliveOperatives(state, op.player).filter(
      (o) => o.id !== op.id && !o.incapacitated && hasKw(ctx, o, KW) && hasKw(ctx, o, AUTO_PROXY),
    ),
  ];
}

/** "…friendly BATTLECLADE operatives within 6" of this operative and/or a friendly AUTO-PROXY." */
export function datacoronalNetwork(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const anchors = networkAnchors(ctx, state, op);
  return aliveOperatives(state, op.player)
    .filter((o) => !o.incapacitated && hasKw(ctx, o, KW))
    .filter((o) => anchors.some((a) => a.id === o.id || gapOf(ctx, a, o) <= supportDistance(ctx, state, a, 6) + EPS))
    .sort(byId);
}

/** NETWORK OVERRIDE: "one friendly BATTLECLADE SERVITOR operative within 6" of either…". */
export function overrideTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const anchors = networkAnchors(ctx, state, op);
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && !o.incapacitated && hasKw(ctx, o, KW) && hasKw(ctx, o, SERVITOR))
    .filter((o) => anchors.some((a) => gapOf(ctx, a, o) <= supportDistance(ctx, state, a, 6) + EPS))
    .sort(byId);
}

/** BREACH: the terrain feature within the operative's control range, and where the marker goes. */
export function breachSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
): { featureId: string; pos: Vec2 } | undefined {
  const index = terrain(ctx, state);
  const c = ctx.datacards.get(op.datacardId);
  const r = baseRadius(c?.base ?? DEFAULT_BASE);
  let best: { featureId: string; pos: Vec2; d: number } | undefined;
  for (const part of index.parts) {
    if (part.bounds.min.x - 2 > op.pos.x || part.bounds.max.x + 2 < op.pos.x) continue;
    if (part.bounds.min.y - 2 > op.pos.y || part.bounds.max.y + 2 < op.pos.y) continue;
    for (let i = 0, j = part.poly.length - 1; i < part.poly.length; j = i++) {
      const a = part.poly[j]!;
      const b = part.poly[i]!;
      const d = distancePointToSegment(op.pos, a, b);
      if (d - r > 1 + EPS) continue;
      const t = closestPointOnSegment(op.pos, a, b);
      if (!best || d < best.d) best = { featureId: part.featureId, pos: t, d };
    }
  }
  if (!best) return undefined;
  // "Place one of your Breach markers within this operative's control range as close as possible
  //  to a terrain feature within control range of it" — the marker sits on the operative's side of
  //  the wall, never further than 1" from its base.
  const away = dist(op.pos, best.pos);
  const limit = r + 1 - EPS;
  const pos =
    away <= limit
      ? best.pos
      : { x: op.pos.x + ((best.pos.x - op.pos.x) / away) * limit, y: op.pos.y + ((best.pos.y - op.pos.y) / away) * limit };
  return { featureId: best.featureId, pos };
}

function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  if (len <= EPS) return { ...a };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

const pick = (candidates: OperativeState[], chosen?: string): OperativeState | undefined =>
  candidates.find((o) => o.id === chosen) ?? candidates[0];

/** NETWORK OVERRIDE's legality and effect, shared by its two ActionDefs (D-021). */
const overrideCheck: ActionDef['check'] = (ctx, state, op, params) => {
  const eng = notEngaged(ctx, state, op);
  if (!eng.ok) return eng;
  return pick(overrideTargets(ctx, state, op), params.targetOperativeId)
    ? { ok: true }
    : { ok: false, reason: 'select one friendly BATTLECLADE SERVITOR operative within 6"' };
};

const overridePerform: ActionDef['perform'] = (ctx, state, op, params) => {
  const target = pick(overrideTargets(ctx, state, op), params.targetOperativeId)!;
  // D-016: the branch comes from the intent's `data`; the deterministic default is the
  // counteraction, which is the half the printed rule leads with — unless the named operative
  // cannot NETWORK COUNTERACT, in which case the free Dash is the only legal half left.
  const wantsDash =
    params.choice === 'dash' ||
    target.counteractedThisTP ||
    aplOf(ctx, state, target) < 2 ||
    target.guardSpentTP === state.turningPoint;
  if (wantsDash) {
    // "…or perform a free Dash action."
    grantFreeAction(state, target, {
      sourceId: ACT.networkOverride,
      sourceText: shortQuote(actionText(CARD.underseer, ACT.networkOverride)),
      threshold: state.activeOperativeId === target.id ? target.apSpent : aplOf(ctx, state, target),
      kind: 'ability',
      only: ['Dash'],
    });
  } else {
    // "…to immediately NETWORK COUNTERACT (you don't have to TRANSFER POWER to do so). Continue
    //  this operative's activation after doing so." The engine has one `activeOperativeId` and no
    //  nested activation, so the counteraction is queued and offered the moment this operative's
    //  activation ends — a reported timing shift, not a silently dropped clause.
    queueNetworkCounteract(state, op.player, { by: op.id, targetId: target.id, source: ACT.networkOverride });
  }
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter}: NETWORK OVERRIDE (${target.letter} ${wantsDash ? 'free Dash' : 'NETWORK COUNTERACT'})`,
  });
  return { ok: true };
};

function actions(data: typeof DATA): ActionDef[] {
  const out: ActionDef[] = [];

  // ---- TECHNOARCHEOLOGIST › OMNISCANNER 1AP --------------------------------
  out.push(
    uniqueAction(data, CARD.technoarcheologist, ACT.omniscanner, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(omniscannerTargets(ctx, state, op), params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to or within 8"' };
      },
      perform: (ctx, state, op, params) => {
        const foe = pick(omniscannerTargets(ctx, state, op), params.targetOperativeId)!;
        giveToken(state, foe, OMNISCANNER_TOKEN, {
          sourceId: ACT.omniscanner,
          sourceText: shortQuote(actionText(CARD.technoarcheologist, ACT.omniscanner)),
          player: op.player,
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: OMNISCANNER on ${foe.letter}` });
        return { ok: true };
      },
    }),
  );

  // ---- AUTO-PROXY › GAZE OF THE OMNISSIAH 1AP ------------------------------
  out.push(
    uniqueAction(data, CARD.autoProxy, ACT.gaze, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(gazeTargets(ctx, state, op), params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const foe = pick(gazeTargets(ctx, state, op), params.targetOperativeId)!;
        // DATA BUG: the printed effect list is missing — the text ends at "you can use this
        // effect. If you do:" with nothing after it. The token is placed (markerGuide names a
        // "Gaze of the Omnissiah token") and what it does is reminder-only. See REMINDER_ONLY.
        giveToken(state, foe, GAZE_TOKEN, {
          sourceId: ACT.gaze,
          sourceText: shortQuote(actionText(CARD.autoProxy, ACT.gaze)),
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' }, // "Until the end of the turning point"
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: GAZE OF THE OMNISSIAH on ${foe.letter}` });
        return { ok: true };
      },
    }),
  );

  // ---- BREACHER SERVITOR › BREACH 1AP --------------------------------------
  out.push(
    uniqueAction(data, CARD.breacher, ACT.breach, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return breachSpot(ctx, state, op)
          ? { ok: true }
          : { ok: false, reason: 'no terrain feature within this operative’s control range' };
      },
      perform: (ctx, state, op) => {
        const spot = breachSpot(ctx, state, op)!;
        const n = Object.values(state.markers).filter((m) => m.flags['battlecladeBreach'] === true && m.owner === op.player)
          .length;
        const marker = placeTeamMarker(state, {
          id: breachMarkerId(op.player, n + 1),
          kind: 'generic',
          player: op.player,
          pos: spot.pos,
          z: op.z,
          diameterMm: MARKER_MM,
          flags: { battlecladeBreach: true, featureId: spot.featureId },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: BREACH — a Breach marker is placed by ${spot.featureId}`,
          data: { markerId: marker.id },
        });
        return { ok: true };
      },
    }),
  );

  // ---- SERVITOR UNDERSEER › DATACORONAL ACCUMULATOR 1AP (SUPPORT) ----------
  out.push(
    uniqueAction(data, CARD.underseer, ACT.datacoronal, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (ctx, state, op) => {
        const network = datacoronalNetwork(ctx, state, op);
        const contested = new Set<string>();
        for (const marker of objectiveMarkers(state))
          for (const mate of network) if (markerContestedBy(ctx, state, marker, mate)) contested.add(marker.id);
        const roll = ctx.rng.d3();
        recordRoll(state, 'datacoronalAccumulator', [roll], op.player, 'DATACORONAL ACCUMULATOR D3');
        // "If the result is equal to or less than the number of objective markers those friendly
        //  operatives contest, you gain 1CP."
        if (roll <= contested.size) state.teams[op.player].cp += 1;
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: DATACORONAL ACCUMULATOR (D3 ${roll} vs ${contested.size} objective markers)`,
        });
        return { ok: true };
      },
    }),
  );

  // ---- SERVITOR UNDERSEER › NETWORK OVERRIDE 1AP (SUPPORT) -----------------
  out.push(
    uniqueAction(data, CARD.underseer, ACT.networkOverride, {
      check: overrideCheck,
      perform: overridePerform,
    }),
    // "This operative can perform this action twice during its activation" (D-021).
    {
      id: NETWORK_OVERRIDE_AGAIN,
      name: `${data.datacards.find((c) => c.id === CARD.underseer)!.uniqueActions.find((a) => a.id === ACT.networkOverride)!.name} (again)`,
      ap: 1,
      type: 'unique',
      sourceText: actionText(CARD.underseer, ACT.networkOverride),
      available: (_ctx, _state, op) =>
        op.datacardId === CARD.underseer && op.actionsThisActivation.includes(ACT.networkOverride),
      check: overrideCheck,
      perform: overridePerform,
    },
  );

  // ---- TECHNOMEDIC › EXPEDIENT REPAIR 1AP ----------------------------------
  out.push(
    uniqueAction(data, CARD.technomedic, ACT.expedientRepair, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(repairTargets(ctx, state, op), params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly BATTLECLADE operative within control range' };
      },
      perform: (ctx, state, op, params) => {
        const mate = pick(repairTargets(ctx, state, op), params.targetOperativeId)!;
        const heal = ctx.rng.d3() + 3;
        recordRoll(state, 'expedientRepair', [heal], op.player, 'EXPEDIENT REPAIR D3+3');
        const max = ctx.datacards.get(mate.datacardId)?.wounds ?? mate.wounds + heal;
        mate.wounds = Math.min(max, mate.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: EXPEDIENT REPAIR (+${heal} on ${mate.letter})`,
        });
        return { ok: true };
      },
    }),
  );

  // ---- Noospheric Network › TRANSFER POWER 1AP -----------------------------
  out.push(transferPowerAction());
  // ---- REMOTE ACCESS › the hatchway half (D-021) ---------------------------
  out.push(remoteOperateHatch());

  return out;
}

/**
 * "Once during each friendly BATTLECLADE SERVITOR operative's activation, before or after it
 * performs an action, you can spend 1AP to TRANSFER POWER."
 *
 * The engine's only channel for spending AP during an activation is an action, so TRANSFER POWER is
 * a 1AP `ActionDef` (the Raveners BURROW precedent for a rule printed inside a faction rule). The
 * reducer's own action restriction then enforces "once during each activation".
 */
function transferPowerAction(): ActionDef {
  return {
    id: TRANSFER_POWER,
    name: 'TRANSFER POWER',
    ap: 1,
    type: 'unique',
    sourceText: text(RULE_NETWORK),
    available: (ctx, _state, op) => hasKw(ctx, op, KW) && hasKw(ctx, op, SERVITOR),
    check(ctx, state, op) {
      // "…during each friendly BATTLECLADE SERVITOR operative's ACTIVATION" — a counteraction is
      // not an activation, and NETWORK COUNTERACT explicitly says so.
      if (state.opState['counteract']?.['operativeId'] === op.id)
        return { ok: false, reason: 'a counteraction is not an activation' };
      if (op.actionsThisActivation.includes(TRANSFER_POWER))
        return { ok: false, reason: 'this operative has already transferred power this activation' };
      // "An operative cannot TRANSFER POWER … if it has an APL stat of less than 2."
      if (aplOf(ctx, state, op) < 2) return { ok: false, reason: 'its APL stat is less than 2' };
      return { ok: true };
    },
    perform(ctx, state, op) {
      void ctx;
      queueNetworkCounteract(state, op.player, { by: op.id, source: RULE_NETWORK });
      // NEUROCYCLIC RESERVE CELLS: "Once per turning point whenever you TRANSFER POWER, you can
      // use this rule. If you do, you can TRANSFER POWER for 0AP." The cost hook already returned
      // 0 for this action; the once-per-turning-point stamp is claimed here so a legality query
      // never consumes it.
      if (
        state.teams[op.player].equipment.includes(EQ.neurocyclicCells) &&
        !usedThisTP(state, `battleclade.neurocyclic:${op.player}`)
      ) {
        useOncePerTP(state, `battleclade.neurocyclic:${op.player}`);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `Neurocyclic Reserve Cells: ${op.letter} TRANSFERS POWER for 0AP`,
        });
      }
      log(state, { kind: 'action', player: op.player, text: `${op.letter} TRANSFERS POWER` });
      return { ok: true };
    },
  };
}

/**
 * REMOTE ACCESS: "That operative doesn't require a hatchway's access point to be within its control
 * range to perform an Operate Hatch action. Instead, that access point must be within 4" of it."
 */
function remoteOperateHatch(): ActionDef {
  const universal = (): ActionDef => getAction('Operate Hatch')!;
  return {
    id: REMOTE_OPERATE_HATCH,
    name: REMOTE_OPERATE_HATCH,
    ap: 1,
    type: 'unique',
    treatedAs: 'Operate Hatch',
    sourceText: text(FP.remoteAccess),
    available: (ctx, state, op) =>
      hasKw(ctx, op, KW) &&
      hasKw(ctx, op, TECH_PRIEST) &&
      state.teams[op.player].ploysUsedTP.includes(FP.remoteAccess) &&
      !usedThisTP(state, `battleclade.remoteAccess:${op.player}`) &&
      (universal().available?.(ctx, state, op) ?? true),
    check(ctx, state, op, params) {
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      const index = terrain(ctx, state);
      const part = params.partId ? index.byId.get(params.partId) : undefined;
      if (!part || part.role !== 'accessPoint') return { ok: false, reason: 'no hatchway access point selected' };
      const c = ctx.datacards.get(op.datacardId);
      const centre = { x: (part.bounds.min.x + part.bounds.max.x) / 2, y: (part.bounds.min.y + part.bounds.max.y) / 2 };
      if (baseGap(op.pos, c?.base ?? DEFAULT_BASE, op.rot, centre, { shape: 'round', mm: MARKER_MM }, 0) > 4 + EPS)
        return { ok: false, reason: 'the access point is not within 4"' };
      if (part.state === 'open') {
        const enemyNear = aliveOperatives(state, otherPlayer(op.player)).some((e) => {
          const ec = ctx.datacards.get(e.datacardId);
          return (
            baseGap(e.pos, ec?.base ?? DEFAULT_BASE, e.rot, centre, { shape: 'round', mm: MARKER_MM }, 0) <= 1 + EPS
          );
        });
        if (enemyNear) return { ok: false, reason: 'the open access point is within an enemy operative’s control range' };
      }
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      useOncePerTP(state, `battleclade.remoteAccess:${op.player}`);
      return universal().perform(ctx, state, op, params);
    },
  };
}

// ---------------------------------------------------------------------------
// Extras: OMNISCANNER's Ceaseless, NETWORK OVERRIDE's second use, gambits
// ---------------------------------------------------------------------------

function extras(reg: HookRegistry, T: TeamHooks): void {
  // OMNISCANNER: "Whenever a friendly BATTLECLADE operative is shooting against, fighting against
  // or retaliating against an enemy operative that has one of your Omniscanner tokens, that
  // friendly operative's weapons have the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bind(ACT.omniscanner, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    const foe = ev.target ?? fightOpponent(T, ev.state, ev.operative);
    if (!foe || foe.player === T.player) return;
    if (!hasToken(ev.state, foe.id, OMNISCANNER_TOKEN, T.player)) return;
    if (ev.rules.some((r) => r.id === 'Ceaseless')) return;
    ev.rules.push({ id: 'Ceaseless', raw: 'Ceaseless (OMNISCANNER)' });
  });

}

/** The other side of an in-flight fight, so "fighting against or retaliating against" is covered. */
function fightOpponent(T: TeamHooks, state: GameState, op: OperativeState): OperativeState | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  if (seq.attackerId === op.id) return state.operatives[seq.defenderId];
  if (seq.defenderId === op.id) return state.operatives[seq.attackerId];
  return undefined;
}

function gambits(reg: HookRegistry, T: TeamHooks): void {
  defaultGambits(reg, T);

  // Seeker of Divine Arcana — a 0CP STRATEGIC GAMBIT printed as a datacard ability.
  reg.on('gambitOptions', T.bind(AB.seekerOfDivineArcana, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.technoarcheologist && live(o))) return;
    ev.options.push({
      id: SEEKER_GAMBIT,
      label: 'Seeker of Divine Arcana: change the TECHNOARCHEOLOGIST’s order and/or a free action',
      sourceText: shortQuote(abilityText(CARD.technoarcheologist, AB.seekerOfDivineArcana)),
    });
  });

  // COVERT GUISES — "As a STRATEGIC GAMBIT in the first turning point…".
  reg.on('gambitOptions', T.bind(EQ.covertGuises, 30), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (!hasEquipment(ev.state, T.player, EQ.covertGuises)) return;
    ev.options.push({
      id: EQ.covertGuises,
      label: 'Covert Guises: a free Reposition for BATTLECLADE operatives in your drop zone',
      sourceText: shortQuote(text(EQ.covertGuises)),
    });
  });
}

// ---------------------------------------------------------------------------

export const battleclade = defineTeam({
  id: 'battleclade',
  rules: (reg, T) => {
    rules(reg, T);
    extras(reg, T);
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  gambits,
  ployUsable: {
    // "Use this firefight ploy when you would activate a friendly BATTLECLADE operative."
    [FP.systemExorcism]: (state, player) => {
      if (state.phase !== 'firefight') return { ok: false, reason: 'use it when you would activate an operative' };
      if (state.activeOperativeId) return { ok: false, reason: 'an operative is already activated' };
      return { ok: true };
    },
    // "Use this firefight ploy during a friendly BATTLECLADE TECH-PRIEST operative's activation."
    [FP.remoteAccess]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'use it during a friendly BATTLECLADE TECH-PRIEST operative’s activation' };
      return { ok: true };
    },
    // "Use this firefight ploy when an operative is shooting a friendly BATTLECLADE TECH-PRIEST
    //  operative, at the start of the Roll Attack Dice step."
    [FP.autoFerric]: (state, player) => {
      const seq = state.sequence;
      if (!seq || seq.kind !== 'shoot') return { ok: false, reason: 'use it when an operative is shooting' };
      const target = state.operatives[seq.targetId];
      if (!target || target.player !== player)
        return { ok: false, reason: 'the target must be a friendly BATTLECLADE TECH-PRIEST operative' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly BATTLECLADE TECH-PRIEST operative is selected as the
    //  valid target of a Shoot action or to fight against during the Fight action."
    [FP.servileSurrogacy]: (state, player) => {
      const priests = aliveOperatives(state, player).filter((o) => !o.incapacitated);
      return priests.length > 1 ? { ok: true } : { ok: false, reason: 'no SERVITOR left to interpose' };
    },
  },
  aiHints: {
    roles: {
      [CARD.technoarcheologist]: 'leader',
      [CARD.underseer]: 'support',
      [CARD.autoProxy]: 'support',
      [CARD.breacher]: 'objective',
      [CARD.combat]: 'gunner',
      [CARD.gun]: 'gunner',
      [CARD.technomedic]: 'support',
    },
    ployValue: {
      [SP.noosphericPossession]: 0.6,
      [SP.dutyOfReclamation]: 0.4,
      [SP.incantation]: 0.5,
      [SP.prioritisedAcquisition]: 0.5,
      [FP.systemExorcism]: 0.3,
      [FP.remoteAccess]: 0.3,
      [FP.autoFerric]: 0.4,
      [FP.servileSurrogacy]: 0.5,
      // The 0CP gambits — without a value the AI would never use them.
      [SEEKER_GAMBIT]: 3,
      [EQ.covertGuises]: 2,
    },
    equipmentValue: {
      [EQ.covertGuises]: 0.4,
      [EQ.electromanticCapacitors]: 0.6,
      [EQ.concealedApparatus]: 0.3,
      [EQ.neurocyclicCells]: 0.5,
    },
  },
});

export default battleclade;

/** Reminder-only clauses, quoted for the UI and asserted by the tests. */
export const REMINDER_ONLY: Record<string, string> = {
  [ACT.gaze]:
    'BLOCKED BY THE DATA, not by the engine: the printed effect list is missing. The text ends at "whenever a friendly BATTLECLADE operative is shooting that enemy operative, you can use this effect. If you do:" and the next paragraph is the boilerplate control-range restriction — the seventh SPOT-shaped truncation (docs/TEAM-STATUS.md). The action, its target legality and the Gaze of the Omnissiah token are implemented; what the token DOES cannot be, because it is not in the source.',
  [`${ACT.breach}.accessible`]:
    'Reminder-only clause: "Whenever an operative is within 1" of that marker, it treats parts of that terrain feature that are no more than 1" thick as Accessible terrain." Terrain types are read straight off `TerrainPart.types` by `src/core/terrain.ts`; `onMoveRules` (which carries `ignoreClimbCost`) is declared but NEVER emitted, and nothing else can re-type a part per operative. The marker is placed and carries its `featureId` for the UI.',
  [`${FP.remoteAccess}.mission`]:
    'Reminder-only clause: "That operative doesn\'t require a marker to be within its control range to perform a mission action that usually requires this." Mission actions are ActionDefs owned by src/core/ops/**, each testing `markerContestedBy` inside its own `check`; a team module may not reach into them and there is no hook on that test. The Operate Hatch half IS implemented as `Operate Hatch (Remote Access)`.',
  [`${FP.servileSurrogacy}.fight`]:
    'Reminder-only clause: the Fight half ("or to be fought against … treat that SERVITOR operative as being within the fighting operative\'s control range for the duration of that action"). `startFight` takes its defender straight from the intent and emits nothing before building the sequence, so there is no melee target-substitution seam (the Celestian HOLY DEFENDER / Canoptek SACRIFICIAL THRALL gap). The Shoot half IS implemented through `onSelectTarget`.',
  [`${SP.dutyOfReclamation}.melee`]:
    'Partial: `onRollAttack` is emitted by `shoot.ts` only (D-031) and `onDefenceDice` likewise, so the 0CP Command Re-roll reaches a shooting attack pool and a shooting defence pool. `fight.ts` emits no hook at all around its two pools, so a fight\'s dice cannot be discounted. "Once per action" is bounded to once per pool per sequence, which is the finest grain the reroll machinery exposes.',
  [`${AB.mechanosutureArray}.dash`]:
    'Reminder-only clause: "but must end that move within this operative\'s control range" — no hook constrains where a move ENDS (`sutureDashEndLegal` is exported for the UI). The free Dash itself, the 1-wound save, the remainder-of-the-action shield and the end-of-activation clause are implemented.',
  [`${EQ.covertGuises}.dropZone`]:
    'Reminder-only clause: "must end that move wholly within 3" of your drop zone" — `validateMove` has no end-region option and `onMoveRules` is never emitted (the same gap brood-brother reported for its identically named equipment).',
  [`${AB.seekerOfDivineArcana}.endOfMove`]:
    'Reminder-only clause: "If it\'s the Fall Back or Reposition action and this operative isn\'t carrying a marker, it must end that move either within your drop zone …, or with an objective marker or one of your mission markers within its control range." Same end-of-move gap: nothing constrains where a move finishes.',
  [`${RULE_NETWORK}.transferPower`]:
    'Modelling note: the rule prints "before or after it performs an action, you can spend 1AP to TRANSFER POWER", i.e. it is explicitly NOT an action — but an activation\'s only AP-spending channel in the engine is `PerformAction`, so it is a 1AP `ActionDef` (the Raveners BURROW precedent for a rule printed inside a faction rule). Consequences: the reducer\'s own action restriction enforces "once during each activation" for free, and a rule that forbids ACTIONS would also forbid the transfer, which the printed text would not.',
  [`${RULE_NETWORK}.timing`]:
    'Modelling note, not a dropped clause: NETWORK OVERRIDE prints "immediately NETWORK COUNTERACT … Continue this operative\'s activation after doing so", but the engine has a single `activeOperativeId` and no nested activation, so an override-driven counteraction is queued and offered the moment the UNDERSEER\'s activation ends rather than mid-action. Everything else about it — the free 0AP 1AP-only non-Guard action, the 2" move cap, the order selection, and staying ready — is real. One knock-on: `EndActivation` runs `expireActivationEffects` on the counteracting operative, so a ready operative loses any endOfActivation effect meant for its real activation — the same behaviour a core counteraction already has.',
};
