/**
 * DEATH KORPS — Astra Militarum. https://wahapedia.ru/kill-team3/kill-teams/death-korps/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is read
 * from `data/teams/death-korps.json`, never retyped.
 *
 * The one faction rule, Guardsmen Orders, is a MENU: the four GUARDSMAN ORDERs are printed as
 * `\nTake Aim!\n…` blocks inside it and have no id of their own, so their text is **sliced out
 * of** the printed rule at module load (`ORDER_TEXT` below) rather than being retyped — the
 * same treatment the Kasrkin SKILL AT ARMS and the Legionary Marks of Chaos menus needed
 * (`src/teams/legionary/index.ts`). The four heading strings are the only retyped bytes, and
 * they exist solely as slice anchors.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { successes } from '../../core/dice.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseGap, baseGapToPoly, baseWhollyWithin } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { advanceShoot, startShoot } from '../../core/sequences/shoot.ts';
import { resolveFightDie } from '../../core/sequences/fight.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aplOf,
  body,
  inControlRange,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import { hasType } from '../../core/terrain.ts';
import { isVisible } from '../../core/visibility.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PendingDecision,
  PlayerId,
  Vec2,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  chosenOperative,
  currentApl,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  enemiesInControlRange,
  gambitUsed,
  gambitsWithPrefix,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  makeTeamHooks,
  notEngaged,
  ployUsed,
  posFromData,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('death-korps');
const KW = 'DEATH KORPS';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

/** The weapon table printed underneath an equipment option (HAND AXES' Hand axe). */
function printedWeapon(ruleId: string, name: string): Weapon {
  const holder = DATA.equipment.find((r) => r.id === ruleId) as unknown as { weapons?: Weapon[] } | undefined;
  const w = holder?.weapons?.find((x) => x.name === name);
  if (!w) throw new Error(`No printed weapon '${name}' on '${ruleId}' in data/teams/death-korps.json`);
  return w;
}

// Datacard ids the rules name.
export const C = {
  watchmaster: 'death-korps.watchmaster',
  bruiser: 'death-korps.bruiser',
  confidant: 'death-korps.confidant',
  gunner: 'death-korps.gunner',
  medic: 'death-korps.medic',
  sapper: 'death-korps.sapper',
  sniper: 'death-korps.sniper',
  spotter: 'death-korps.spotter',
  trooper: 'death-korps.trooper',
  veteran: 'death-korps.veteran',
  voxOperator: 'death-korps.vox-operator',
  zealot: 'death-korps.zealot',
} as const;

const RULE = { orders: 'death-korps.rule.guardsmen-orders' } as const;

const SP = {
  siegeWarfare: 'death-korps.sp.siege-warfare',
  takeCover: 'death-korps.sp.take-cover',
  clearTheLine: 'death-korps.sp.clear-the-line',
  regroup: 'death-korps.sp.regroup',
} as const;

const FP = {
  inspirationalLeadership: 'death-korps.fp.inspirational-leadership',
  combinedArms: 'death-korps.fp.combined-arms',
  inLifeShame: 'death-korps.fp.in-life-shame',
  inDeathAtonement: 'death-korps.fp.in-death-atonement',
} as const;

const EQ = {
  chronometer: 'death-korps.eq.chronometer',
  commBeads: 'death-korps.eq.comm-beads',
  handAxes: 'death-korps.eq.hand-axes',
  gasBombardment: 'death-korps.eq.gas-bombardment',
} as const;

const A = {
  adaptiveOrders: `${C.watchmaster}.adaptive-orders`,
  bringItDown: `${C.watchmaster}.bring-it-down`,
  bruiser: `${C.bruiser}.bruiser`,
  secondInCommand: `${C.confidant}.second-in-command`,
  directive: `${C.confidant}.directive`,
  medic: `${C.medic}.medic`,
  mineLayer: `${C.sapper}.mine-layer`,
  detonate: `${C.sapper}.detonate`,
  concealedPosition: `${C.sniper}.concealed-position`,
  groupActivation: `${C.trooper}.group-activation`,
  veteranGuardsman: `${C.veteran}.veteran-guardsman`,
  bionics: `${C.veteran}.bionics`,
  relayOrders: `${C.voxOperator}.relay-orders`,
  emperorProtects: `${C.zealot}.the-emperor-protects`,
  upliftingPrimer: `${C.zealot}.uplifting-primer`,
} as const;

const ACT = {
  medikit: `${C.medic}.act.medikit`,
  spot: `${C.spotter}.act.spot`,
  signal: `${C.voxOperator}.act.signal`,
} as const;

const MOVES = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? { shape: 'round', mm: 25 };

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/** "wholly within your territory". */
function whollyInTerritory(T: TeamHooks, state: GameState, op: OperativeState, player: PlayerId): boolean {
  return baseWhollyWithin(op.pos, baseOf(T, op), op.rot, state.map.territories[player]);
}

/** The weapon profile currently inflicting damage (the striking side, in a fight). */
function damageProfile(T: TeamHooks, state: GameState): WeaponProfile | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') {
    const holder = state.operatives[seq.attackerId];
    const w = holder ? T.card(holder)?.weapons.find((x) => x.name === seq.weaponName) : undefined;
    return w?.profiles.find((p) => (p.name ?? '') === (seq.profileName ?? '')) ?? w?.profiles[0];
  }
  if (seq.kind !== 'fight') return undefined;
  const strikerId = seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
  const holder = state.operatives[strikerId];
  const name = strikerId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const w = holder ? T.card(holder)?.weapons.find((x) => x.name === name) : undefined;
  const pn = strikerId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  return w?.profiles.find((p) => (p.name ?? '') === (pn ?? '')) ?? w?.profiles[0];
}

/** A strategy ploy is normally used as a STRATEGIC GAMBIT, but `UsePloy` also accepts it. */
const strategyUsed = (state: GameState, player: PlayerId, id: string): boolean =>
  gambitUsed(state, player, id) || ployUsed(state, player, id);

// ---------------------------------------------------------------------------
// Guardsmen Orders (the one faction rule)
// ---------------------------------------------------------------------------

export const ORDERS = ['take-aim', 'fix-bayonets', 'dig-in', 'move-move-move'] as const;
export type GuardsmanOrder = (typeof ORDERS)[number];

/** Slice anchors — the four headings exactly as the faction rule prints them. */
const ORDER_HEADING: Record<GuardsmanOrder, string> = {
  'take-aim': 'Take Aim!',
  'fix-bayonets': 'Fix Bayonets!',
  'dig-in': 'Dig In!',
  'move-move-move': 'Move! Move! Move!',
};

export const ORDER_LABEL: Record<GuardsmanOrder, string> = ORDER_HEADING;

/**
 * The four GUARDSMAN ORDERs, sliced out of the printed Guardsmen Orders faction rule (each is
 * printed as a `\n<heading>\n` block with no id of its own).
 */
export const ORDER_TEXT: Record<GuardsmanOrder, string> = (() => {
  const printed = text(RULE.orders);
  const out = {} as Record<GuardsmanOrder, string>;
  ORDERS.forEach((order, i) => {
    const start = printed.indexOf(`\n${ORDER_HEADING[order]}\n`);
    const next = ORDERS[i + 1];
    const endAt = next ? printed.indexOf(`\n${ORDER_HEADING[next]}\n`) : -1;
    out[order] = start < 0 ? ORDER_HEADING[order] : printed.slice(start + 1, endAt < 0 ? printed.length : endAt).trim();
  });
  return out;
})();

const ORDER_SET: ReadonlySet<string> = new Set(ORDERS);
const ORDER_EFFECT = 'death-korps.guardsmanOrder';
/** Guards `receiveOrder` against re-entering the VOX-OPERATOR's relay. */
const RELAYING = 'death-korps.relaying';

export const orderGambitId = (order: GuardsmanOrder): string => `${RULE.orders}:${order}`;

/** Every GUARDSMAN ORDER this operative is currently benefiting from. */
export function ordersOn(state: GameState, op: OperativeState, player: PlayerId): GuardsmanOrder[] {
  return state.effects
    .filter((e) => e.rule === ORDER_EFFECT && e.operativeId === op.id && e.player === player)
    .map((e) => String(e.data?.['order'] ?? ''))
    .filter((o): o is GuardsmanOrder => ORDER_SET.has(o));
}

export function hasOrder(state: GameState, op: OperativeState, order: GuardsmanOrder, player: PlayerId): boolean {
  return ordersOn(state, op, player).includes(order);
}

function addOrder(T: TeamHooks, state: GameState, op: OperativeState, order: GuardsmanOrder): void {
  effect(state, {
    rule: ORDER_EFFECT,
    source: { kind: 'ability', id: RULE.orders },
    sourceText: shortQuote(ORDER_TEXT[order]),
    operativeId: op.id,
    player: T.player,
    data: { order },
    // "apply its rules until the end of the turning point"
    expiry: { kind: 'endOfTurningPoint' },
  });
}

/**
 * "Whenever a friendly operative receives a GUARDSMAN ORDER, apply its rules until the end of
 * the turning point. Operatives cannot benefit from more than one GUARDSMAN ORDER at once;
 * they only benefit from the most recent order they received during the turning point."
 */
export function receiveOrder(T: TeamHooks, state: GameState, op: OperativeState, order: GuardsmanOrder): void {
  if (!T.mineKw(op, KW) || op.removed) return;
  dropEffects(state, (e) => e.rule === ORDER_EFFECT && e.operativeId === op.id && e.player === T.player);
  addOrder(T, state, op, order);
  log(state, {
    kind: 'action',
    player: T.player,
    text: `${op.name} receives the ${ORDER_LABEL[order]} order`,
    data: { operativeId: op.id, order },
  });
  maybeRelay(T, state, op, order);
}

/** IN LIFE, SHAME: "It receives every GUARDSMAN ORDER." */
export function receiveEveryOrder(T: TeamHooks, state: GameState, op: OperativeState): void {
  if (!T.mineKw(op, KW) || op.removed) return;
  dropEffects(state, (e) => e.rule === ORDER_EFFECT && e.operativeId === op.id && e.player === T.player);
  for (const order of ORDERS) addOrder(T, state, op, order);
  log(state, { kind: 'ploy', player: T.player, text: `${op.name} receives every GUARDSMAN ORDER`, data: { operativeId: op.id } });
}

/**
 * VOX-OPERATOR › Relay Orders. "Once per turning point, when this operative receives a
 * GUARDSMAN ORDER, if it's not within control range of enemy operatives, it can relay that
 * order. Whenever an order is relayed, all friendly DEATH KORPS operatives in the killzone
 * receive that order, then subtract 1 from this operative's APL stat until the end of its next
 * activation."
 *
 * "It can relay" is optional, so it is auto-used on a stated, deterministic policy (D-022): it
 * relays only when at least one other friendly DEATH KORPS operative in the killzone does not
 * already have that order, i.e. only when relaying actually widens it.
 */
function maybeRelay(T: TeamHooks, state: GameState, op: OperativeState, order: GuardsmanOrder): void {
  if (op.datacardId !== C.voxOperator) return;
  if (bucket(state, RELAYING)[T.player]) return;
  if (T.ctx && enemiesInControlRange(T.ctx, state, op).length > 0) return;
  const others = T.friendlies(state, KW).filter((o) => o.id !== op.id && !hasOrder(state, o, order, T.player));
  if (others.length === 0) return;
  if (!useOncePerTP(state, `death-korps.relay:${op.id}`)) return;
  bucket(state, RELAYING)[T.player] = true;
  for (const o of others) receiveOrder(T, state, o, order);
  delete bucket(state, RELAYING)[T.player];
  effect(state, {
    rule: 'death-korps.relayApl',
    source: { kind: 'ability', id: A.relayOrders },
    sourceText: shortQuote(abilityText(C.voxOperator, A.relayOrders)),
    operativeId: op.id,
    player: T.player,
    expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
  });
  log(state, {
    kind: 'action',
    player: T.player,
    text: `${op.name} relays the ${ORDER_LABEL[order]} order to the whole kill team (-1 APL)`,
  });
}

/** Who may issue an order as a STRATEGIC GAMBIT right now. */
function gambitIssuers(T: TeamHooks, state: GameState): OperativeState[] {
  const out = T.friendlies(state).filter((o) => o.datacardId === C.watchmaster);
  // Second in Command: "this operative can issue a GUARDSMAN ORDER as a STRATEGIC GAMBIT
  // (even though it's not a WATCHMASTER operative)".
  if (secondInCommandUsed(state, T.player)) out.push(...T.friendlies(state).filter((o) => o.datacardId === C.confidant));
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * "Whenever it does, select one GUARDSMAN ORDER for all friendly DEATH KORPS operatives within
 * 6" of it to receive."
 *
 * COMM-BEADS: "instead of each friendly DEATH KORPS operative within 6" of it receiving that
 * order, you can select one friendly DEATH KORPS operative to receive that order." That is a
 * strict NARROWING, so it is never auto-used: it fires only when the intent's `data` names the
 * operative (D-016), and the deterministic default is the printed 6" version.
 */
function issueOrder(
  T: TeamHooks,
  state: GameState,
  issuer: OperativeState,
  order: GuardsmanOrder,
  data?: Record<string, unknown>,
): void {
  bucket(state, 'death-korps.lastIssuer')[T.player] = issuer.id;
  const named = data?.['commBeadsOperativeId'];
  if (hasEquipment(state, T.player, EQ.commBeads) && typeof named === 'string') {
    const one = T.friendlies(state, KW).find((o) => o.id === named);
    if (one) {
      log(state, { kind: 'action', player: T.player, text: `Comm-beads: only ${one.name} receives that order` });
      receiveOrder(T, state, one, order);
      return;
    }
  }
  const range = T.ctx ? supportDistance(T.ctx, state, issuer, 6) : 6;
  for (const o of T.friendlies(state, KW)) if (T.gap(issuer, o) <= range + EPS) receiveOrder(T, state, o, order);
}

/** The order a ploy/gambit's `data` names, with a deterministic, logged default (D-016). */
function orderFromData(data: Record<string, unknown> | undefined): GuardsmanOrder {
  const v = data?.['order'];
  return typeof v === 'string' && ORDER_SET.has(v) ? (v as GuardsmanOrder) : 'take-aim';
}

// ---------------------------------------------------------------------------
// CONFIDANT › Second in Command — a pure setter (D-017)
// ---------------------------------------------------------------------------

const SECOND_IN_COMMAND = 'death-korps.secondInCommand';

export const secondInCommandUsed = (state: GameState, player: PlayerId): boolean =>
  Boolean(bucket(state, SECOND_IN_COMMAND)[player]);

/**
 * "If a friendly WATCHMASTER operative is incapacitated and removed from the killzone, you can
 * use this rule. If you do, until the end of the battle, this operative can issue a GUARDSMAN
 * ORDER as a STRATEGIC GAMBIT."
 *
 * Using it permanently switches Directive off ("if you haven't used the Second in Command rule
 * during the battle"), so it is a real trade rather than a free upgrade — it is therefore NOT
 * auto-used (D-022 only auto-uses what costs nothing) and is exposed as a pure setter the UI
 * calls, the same shape as the Legionary `setMarkOfChaos` / Phobos `setCustomWeaponRules`
 * precedent (D-017). Nothing applies until it is called.
 */
export function useSecondInCommand(state: GameState, player: PlayerId): boolean {
  const mine = Object.values(state.operatives).filter((o) => o.player === player && !o.removed);
  if (!mine.some((o) => o.datacardId === C.confidant)) return false;
  // "If a friendly WATCHMASTER operative is incapacitated and removed from the killzone".
  const watchmasterGone = Object.values(state.operatives).some(
    (o) => o.player === player && o.datacardId === C.watchmaster && o.removed,
  );
  if (!watchmasterGone) return false;
  if (secondInCommandUsed(state, player)) return false;
  bucket(state, SECOND_IN_COMMAND)[player] = true;
  log(state, {
    kind: 'system',
    player,
    text: 'Second in Command: the CONFIDANT can issue a GUARDSMAN ORDER as a STRATEGIC GAMBIT',
  });
  return true;
}

// ---------------------------------------------------------------------------
// VETERAN › Veteran Guardsman — a real decision
// ---------------------------------------------------------------------------

const VETERAN_ORDER_DECISION = 'death-korps.veteranOrder';

/** The team's own decision kinds, claimed through `GameContext.decisionHandlers`. */
function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== VETERAN_ORDER_DECISION) return false;
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const op = state.operatives[String(payload['operativeId'] ?? '')];
  const order = String(payload['order'] ?? '');
  if (op && !op.removed && ORDER_SET.has(order)) {
    receiveOrder(makeTeamHooks(DATA, op.player, ctx), state, op, order as GuardsmanOrder);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The Mine marker (SAPPER › Mine Layer) and Detonate
// ---------------------------------------------------------------------------

export const MINE_MARKER = (player: PlayerId): string => `death-korps.mine.${player}`;

const markerBody = (marker: MarkerState) => ({
  id: marker.id,
  pos: marker.pos,
  z: marker.z,
  rot: 0,
  base: { shape: 'round' as const, mm: marker.diameterMm },
  height: 0.2,
});

const hasDetonate = (card: Datacard | undefined, weaponName?: string): Weapon | undefined =>
  (card?.weapons ?? []).find(
    (w) =>
      (weaponName === undefined || w.name === weaponName) &&
      w.profiles.some((p) => p.rules.some((r) => r.id === 'Detonate')),
  );

/**
 * "This operative is carrying your Mine marker."
 *
 * The engine creates markers at battle setup only for the map's objectives and for universal
 * equipment, so the team marker is created the first time the module sees the battle (deploy,
 * or the first activation for tests/AI games that place operatives directly). `pickUpAllowed`
 * is deliberately NOT set: only the SAPPER may pick this one up, so it has its own Pick Up /
 * Place actions below. This matches the Phobos Strike Team carried-marker precedent.
 */
function ensureMineMarker(T: TeamHooks, state: GameState): void {
  const made = bucket(state, 'death-korps.markerMade');
  if (made[T.player]) return;
  const carrier = T.friendlies(state).find((o) => o.datacardId === C.sapper);
  if (carrier && !carrier.carryingMarkerId && !state.markers[MINE_MARKER(T.player)]) {
    state.markers[MINE_MARKER(T.player)] = {
      id: MINE_MARKER(T.player),
      kind: 'generic',
      diameterMm: 20,
      pos: { ...carrier.pos },
      z: carrier.z,
      owner: T.player,
      carriedBy: carrier.id,
      flags: {},
    };
    carrier.carryingMarkerId = MINE_MARKER(T.player);
    made[T.player] = true;
    return;
  }
  if (T.friendlies(state).length > 0) made[T.player] = true;
}

/** Deployment moves an operative without `applyMove`, so a carried marker is re-synced here. */
function syncMineMarker(T: TeamHooks, state: GameState): void {
  const marker = state.markers[MINE_MARKER(T.player)];
  if (!marker?.carriedBy) return;
  const carrier = state.operatives[marker.carriedBy];
  if (!carrier) return;
  marker.pos = { ...carrier.pos };
  marker.z = carrier.z;
}

/** Set while `Shoot (Remote Detonator)` is starting its sequence — see `availableWeapons`. */
const DETONATING = 'death-korps.detonating';

// ---------------------------------------------------------------------------
// GAS BOMBARDMENT marker
// ---------------------------------------------------------------------------

export const GAS_MARKER = (player: PlayerId): string => `death-korps.gas.${player}`;

/** "it cannot be placed underneath Vantage terrain" */
function underVantage(ctx: GameContext, state: GameState, pos: Vec2, z: number): boolean {
  return terrain(ctx, state).parts.some(
    (part) =>
      hasType(part, 'Vantage') &&
      part.z0 > z + 0.05 &&
      baseGapToPoly(pos, { shape: 'round', mm: 20 }, 0, part.poly) <= EPS,
  );
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

const MEDIC_SHIELD = 'death-korps.medicShield';
const MEDIC_APL = 'death-korps.medicApl';
const BRING_IT_DOWN = 'death-korps.bringItDown';
const SPOT_EFFECT = 'death-korps.spot';
const SIGNAL_EFFECT = 'death-korps.signal';
const GROUP_ACTIVATION = 'death-korps.groupActivation';
const DIRECTIVE = 'death-korps.directive';

const medicUsedOn = (state: GameState, victimId: string): boolean =>
  Number(bucket(state, 'death-korps.medicUsed')[victimId]) === state.turningPoint;

/** Enemies our team has already shot this turning point, by shooter (COMBINED ARMS). */
function shotBy(state: GameState, player: PlayerId, targetId: string): string[] {
  const b = bucket(state, 'death-korps.shotBy');
  const key = `${player}:${state.turningPoint}:${targetId}`;
  const list = (b[key] ?? []) as string[];
  b[key] = list;
  return list;
}

/** COMBINED ARMS' condition, shared by `ployUsable` and the re-roll grant. */
function combinedArmsReady(T: TeamHooks, state: GameState): boolean {
  const seq = shootSeq(state);
  if (!seq) return false;
  const attacker = state.operatives[seq.attackerId];
  const target = state.operatives[seq.targetId];
  if (!attacker || !target || !T.mineKw(attacker, KW)) return false;
  return shotBy(state, T.player, target.id).some((id) => id !== attacker.id);
}

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Guardsmen Orders: the STRATEGIC GAMBIT ------------------------------
  // One gambit per order, so the choice is the player's and is recorded in `gambitsUsedTP`,
  // never picked silently (the Kasrkin SKILL AT ARMS precedent).
  for (const order of ORDERS) {
    reg.on('gambitOptions', T.bind(RULE.orders, 15), (ev) => {
      if (ev.player !== T.player) return;
      if (gambitIssuers(T, ev.state).length === 0) return;
      // Guardsmen Orders is ONE STRATEGIC GAMBIT with a four-way choice, not four gambits:
      // the per-order ids exist only so the choice is the player's and lands in
      // `gambitsUsedTP` (the Kasrkin SKILL AT ARMS precedent), so once one has been issued
      // this turning point the rest are withdrawn.
      if (gambitsWithPrefix(ev.state, T.player, `${RULE.orders}:`).length > 0) return;
      ev.options.push({
        id: orderGambitId(order),
        label: `GUARDSMAN ORDER: ${ORDER_LABEL[order]}`,
        sourceText: shortQuote(ORDER_TEXT[order]),
      });
    });
  }
  reg.on('onPloyUsed', T.bind(RULE.orders, 16), (ev) => {
    if (ev.player !== T.player || !ev.ployId.startsWith(`${RULE.orders}:`)) return;
    const order = ev.ployId.slice(RULE.orders.length + 1) as GuardsmanOrder;
    if (!ORDER_SET.has(order)) return;
    const issuer = chosenOperative(ev.state, ev.data, gambitIssuers(T, ev.state));
    if (!issuer) return;
    issueOrder(T, ev.state, issuer, order, ev.data);
  });

  // Take Aim! — "Ranged weapons of operatives that received this order (excluding mortar
  // barrage and remote detonator) have the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bindText(`${RULE.orders}.take-aim`, ORDER_TEXT['take-aim'], 11), (ev) => {
    if (ev.type !== 'ranged') return;
    if (!hasOrder(ev.state, ev.operative, 'take-aim', T.player)) return;
    const name = ev.weaponName.toLowerCase();
    if (name === 'mortar barrage' || name === 'remote detonator') return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Take Aim!)'));
  });

  // Fix Bayonets! — "Melee weapons of operatives that received this order have the Ceaseless
  // weapon rule."
  reg.on('onWeaponRules', T.bindText(`${RULE.orders}.fix-bayonets`, ORDER_TEXT['fix-bayonets'], 11), (ev) => {
    if (ev.type !== 'melee') return;
    if (!hasOrder(ev.state, ev.operative, 'fix-bayonets', T.player)) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Fix Bayonets!)'));
  });

  // Dig In! — "Whenever an operative is shooting a friendly operative that's received this
  // order, if you can retain any cover saves, you can re-roll any of your defence dice results
  // of one result (e.g. results of 2)."
  reg.on('onDefenceDice', T.bindText(`${RULE.orders}.dig-in`, ORDER_TEXT['dig-in'], 11), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !hasOrder(ev.state, target, 'dig-in', T.player)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id || !seq.inCover) return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return; // no cover save to retain
    ev.rerolls.push({
      id: 'death-korps.digIn',
      label: 'Dig In!: re-roll your defence dice of one result',
      mode: 'value',
      player: T.player,
      sourceText: shortQuote(ORDER_TEXT['dig-in']),
    });
  });

  // Move! Move! Move! — "Whenever an operative that's received this order is performing the
  // Reposition action, add 1" to its Move stat."
  reg.on('onMoveDistance', T.bindText(`${RULE.orders}.move-move-move`, ORDER_TEXT['move-move-move'], 11), (ev) => {
    if (ev.action !== 'Reposition') return;
    if (!hasOrder(ev.state, ev.operative, 'move-move-move', T.player)) return;
    ev.inches += 1;
  });

  // ---- WATCHMASTER › Adaptive Orders ---------------------------------------
  // "If this operative doesn't issue a GUARDSMAN ORDER as a STRATEGIC GAMBIT, you can use the
  //  Inspirational Leadership firefight ploy for 0CP during this operative's activation."
  //  CP is deducted before `onPloyUsed` fires, so the discount can only be a refund.
  reg.on('onPloyUsed', T.bind(A.adaptiveOrders, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.inspirationalLeadership) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || active.player !== T.player || active.datacardId !== C.watchmaster) return;
    // "doesn't issue a GUARDSMAN ORDER as a STRATEGIC GAMBIT" — this WATCHMASTER specifically.
    if (
      gambitsWithPrefix(ev.state, T.player, `${RULE.orders}:`).length > 0 &&
      bucket(ev.state, 'death-korps.lastIssuer')[T.player] === active.id
    )
      return;
    const cp = DATA.firefightPloys.find((p) => p.id === FP.inspirationalLeadership)?.cp ?? 0;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Adaptive Orders: Inspirational Leadership costs 0CP' });
  });

  // ---- WATCHMASTER › Bring it Down! ---------------------------------------
  reg.on('gambitOptions', T.bind(A.bringItDown, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === C.watchmaster)) return; // "if this operative is in the killzone"
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: A.bringItDown,
      label: 'Bring it Down! (STRATEGIC GAMBIT)',
      sourceText: shortQuote(abilityText(C.watchmaster, A.bringItDown)),
    });
  });
  reg.on('onPloyUsed', T.bind(A.bringItDown, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== A.bringItDown) return;
    const target = chosenOperative(ev.state, ev.data, T.enemies(ev.state));
    if (!target) return;
    dropEffects(ev.state, (e) => e.rule === BRING_IT_DOWN && e.player === T.player);
    effect(ev.state, {
      rule: BRING_IT_DOWN,
      source: { kind: 'ability', id: A.bringItDown },
      sourceText: shortQuote(abilityText(C.watchmaster, A.bringItDown)),
      operativeId: target.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Bring it Down!: ${target.name} is marked` });
  });
  // "Whenever a friendly DEATH KORPS operative is shooting against, fighting against or
  //  retaliating against that enemy operative, that friendly operative's weapons have the
  //  Punishing weapon rule." `onWeaponRules` is emitted by BOTH sequences, so all three halves
  //  are live.
  reg.on('onWeaponRules', T.bind(A.bringItDown, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!ev.state.effects.some((e) => e.rule === BRING_IT_DOWN && e.player === T.player && e.operativeId === ev.target!.id))
      return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Bring it Down!)'));
  });

  // ---- BRUISER › Bruiser ---------------------------------------------------
  // "Once per turning point, when this operative is fighting or retaliating, in the Resolve
  //  Attack Dice step, you can ignore the damage inflicted on it from one normal success."
  //
  //  `onDamage` carries the amount but not which die inflicted it, so a normal success is
  //  identified by the striking weapon's Normal Dmg. When a weapon's Normal and Critical Dmg
  //  are equal the two cannot be told apart — the damage ignored is identical either way.
  reg.on('onDamage', T.bind(A.bruiser, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.player !== T.player || ev.target.datacardId !== C.bruiser) return;
    const seq = fightSeq(ev.state);
    if (!seq) return; // "when this operative is fighting or retaliating"
    const profile = damageProfile(T, ev.state);
    if (!profile || ev.amount !== profile.dmgN) return;
    if (!useOncePerTP(ev.state, `death-korps.bruiser:${ev.target.id}`)) return;
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.target.name} shrugs off a normal success (Bruiser)` });
    ev.amount = 0;
  });
  // "If this operative is incapacitated during the Fight action, you can strike the enemy
  //  operative in that sequence with one of your unresolved successes before this operative is
  //  removed from the killzone." Free and strictly beneficial, so it is auto-used (D-022);
  //  `resolveFightDie` itself ends the sequence once either operative is incapacitated.
  reg.on('onIncapacitated', T.bind(A.bruiser, 13), (ev) => {
    const op = ev.operative;
    if (ev.prevented || op.player !== T.player || op.datacardId !== C.bruiser) return;
    const seq = fightSeq(ev.state);
    if (!seq || !T.ctx) return;
    const side = seq.attackerId === op.id ? 'attacker' : seq.defenderId === op.id ? 'defender' : undefined;
    if (!side) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const mine = successes(pool);
    const die = mine.find((d) => d.state === 'crit') ?? mine[0];
    if (!die) return;
    log(ev.state, { kind: 'action', player: T.player, text: `${op.name} strikes once more before falling (Bruiser)` });
    resolveFightDie(T.ctx, ev.state, seq, side, die.id, 'strike');
  });

  // ---- CONFIDANT › Directive ----------------------------------------------
  // "Whenever this operative is activated, if you haven't used the Second in Command rule
  //  during the battle, you can select one other ready friendly DEATH KORPS operative visible
  //  to and within 6" of it. When this operative is expended, activate that other friendly
  //  operative before your opponent activates."
  //
  //  PARTIAL: `EndActivation` hands the turn to the opponent AFTER `onActivationEnd` is
  //  emitted and there is no seam that runs later, so the pairing is recorded as an effect the
  //  UI/AI reads — the same partial as the Breachers' Breach and Clear, the Pathfinders' Group
  //  Activation and the Warpcoven's MUTANT HERD. Reported as a seam.
  reg.on('onActivationStart', T.bind(A.directive, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.confidant) return;
    if (secondInCommandUsed(ev.state, T.player)) return;
    const range = T.ctx ? supportDistance(T.ctx, ev.state, op, 6) : 6;
    const pick = T.friendlies(ev.state, KW).find(
      (o) => o.id !== op.id && o.ready && T.gap(op, o) <= range + EPS && visibleTo(T, ev.state, op, o),
    );
    if (!pick) return;
    effect(ev.state, {
      rule: DIRECTIVE,
      source: { kind: 'ability', id: A.directive },
      sourceText: shortQuote(abilityText(C.confidant, A.directive)),
      operativeId: pick.id,
      player: T.player,
      data: { confidantId: op.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Directive: ${pick.name} activates after ${op.name}`,
      data: { operativeId: pick.id },
    });
  });

  // ---- MEDIC › Medic! ------------------------------------------------------
  reg.on('onIncapacitated', T.bind(A.medic, 12), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW)) return;
    if (effectOn(ev.state, victim.id, MEDIC_SHIELD)) {
      // "…and cannot be incapacitated for the remainder of the action."
      ev.prevented = true;
      if (victim.wounds <= 0) victim.wounds = 1;
      return;
    }
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === C.medic &&
        o.id !== victim.id &&
        !o.incapacitated && // "You cannot use this rule if this operative is incapacitated"
        T.gap(o, victim) <= 3 + EPS &&
        visibleTo(T, ev.state, o, victim) &&
        T.enemies(ev.state).every((e) => T.gap(e, o) > 1 + EPS && T.gap(e, victim) > 1 + EPS),
    );
    if (!medic) return;
    // "…or if it's a Shoot action and this operative would be a primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    if (!useOncePerTP(ev.state, `death-korps.medic:${medic.id}`)) return;

    ev.prevented = true;
    victim.wounds = 1; // "has 1 wound remaining"
    bucket(ev.state, 'death-korps.medicUsed')[victim.id] = ev.state.turningPoint;
    // Nothing expires an `endOfAction` effect, so the shield is pinned to the activation in
    // flight — the smallest window the engine actually closes.
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: A.medic },
      sourceText: shortQuote(abilityText(C.medic, A.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? victim.id },
    });
    // "…and if this rule was used during that friendly operative's activation, that activation
    //  ends" — modelled as spending the rest of its AP, leaving only the granted Dash.
    const victimIsActive = ev.state.activeOperativeId === victim.id;
    if (victimIsActive) victim.apSpent = currentApl(T, ev.state, victim);
    // "After that action, that friendly operative can immediately perform a free Dash action,
    //  but must end that move within this operative's control range." The end-position half is
    //  REMINDER-ONLY (no seam constrains where a move ends); the free Dash itself is granted.
    // D-015 lands the free action on the next AP the operative spends; when that is a whole
    // activation away the -1 APL below is already in force, so the threshold drops with it and
    // the operative really does get one ordinary AP plus the Dash.
    grantFreeAction(ev.state, victim, {
      sourceId: A.medic,
      sourceText: shortQuote(abilityText(C.medic, A.medic)),
      kind: 'ability',
      threshold: victimIsActive ? currentApl(T, ev.state, victim) : Math.max(0, currentApl(T, ev.state, victim) - 1),
      only: ['Dash'],
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next
    //  activations respectively." Both go through `onStatMod` so they expire with the effect
    // instead of leaking a permanent `aplMods` entry. When the rule fired during the victim's
    // OWN activation its -1 is deferred to the next one, so it cannot cancel the free Dash it
    // has just been granted (the Phobos Helix Adept precedent).
    effect(ev.state, {
      rule: MEDIC_APL,
      source: { kind: 'ability', id: A.medic },
      operativeId: medic.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: medic.id, armed: false },
    });
    effect(ev.state, {
      rule: MEDIC_APL,
      source: { kind: 'ability', id: A.medic },
      operativeId: victim.id,
      player: T.player,
      ...(victimIsActive ? { data: { pending: true } } : {}),
      expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Medic! ${medic.name} keeps ${victim.name} on 1 wound` });
  });
  reg.on('onActivationStart', T.bind(A.medic, 14), (ev) => {
    if (ev.operative.player !== T.player) return;
    const data = effectOn(ev.state, ev.operative.id, MEDIC_APL)?.data;
    if (data?.['pending']) delete data['pending'];
  });

  // ---- SAPPER › Mine Layer -------------------------------------------------
  const markerUpkeep = (state: GameState): void => {
    ensureMineMarker(T, state);
    syncMineMarker(T, state);
  };
  reg.on('onDeploy', T.bind(A.mineLayer, 11), (ev) => {
    if (ev.operative.player === T.player) markerUpkeep(ev.state);
  });
  reg.on('onActivationStart', T.bind(A.mineLayer, 11), (ev) => markerUpkeep(ev.state));
  reg.on('onReadyStep', T.bind(A.mineLayer, 11), (ev) => {
    if (ev.player === T.player) markerUpkeep(ev.state);
  });
  // The universal Place Marker action cannot express "it can immediately perform a free Dash
  // action", so the Mine marker gets its own Pick Up / Place actions (below) and the universal
  // one is refused while it is being carried.
  reg.on('canPerformAction', T.bind(A.mineLayer, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.action !== 'Place Marker') return;
    if (ev.operative.carryingMarkerId !== MINE_MARKER(T.player)) return;
    ev.allowed = false;
    ev.reason = 'use this operative’s own Place Marker action for the Mine marker';
  });

  // ---- SAPPER › Detonate (rare weapon rule) --------------------------------
  // "Don't select a valid target." The weapon can therefore never be used through the universal
  // Shoot action; it is withdrawn from the weapon list except while `Shoot (Remote Detonator)`
  // is starting or resolving its own sequence.
  reg.on('availableWeapons', T.bind(A.detonate, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const detonator = hasDetonate(T.card(ev.operative));
    if (!detonator) return;
    if (bucket(ev.state, DETONATING)[ev.operative.id]) return;
    const seq = shootSeq(ev.state);
    if (seq && seq.attackerId === ev.operative.id && seq.weaponName === detonator.name) return;
    ev.weapons = ev.weapons.filter((n) => n !== detonator.name);
  });
  // The Detonate shot goes through the engine's point-blank path (the only way to shoot an
  // operative that is not a valid target); the point-blank Hit penalty is cancelled here
  // because Detonate does not print one.
  reg.on('onStatMod', T.bind(A.detonate, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !seq.pointBlank) return;
    if (!hasDetonate(T.card(ev.operative), seq.weaponName)) return;
    ev.mods.hit += 1;
  });
  // "In a killzone that uses the close quarters rules (e.g. Killzone: Tomb World), this weapon
  //  has the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind(A.detonate, 14), (ev) => {
    if (!ev.state.map.closeQuarters || ev.operative.player !== T.player) return;
    if (!ev.profile.rules.some((r) => r.id === 'Detonate')) return;
    if (ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Detonate, close quarters)'));
  });
  // "Each of those operatives cannot be in cover or obscured."
  reg.on('onCollectAttackDice', T.bind(A.detonate, 15), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || !hasDetonate(T.card(ev.ctx.attacker), seq.weaponName)) return;
    seq.inCover = false;
    seq.obscured = false;
  });

  // ---- SNIPER › Concealed Position (rare weapon rule) ----------------------
  // "This operative can only use this weapon the first time it's performing the Shoot action
  //  during the battle."  The restriction is per PROFILE (the long-las has three), so the
  //  profile-level `onSelectWeapon` seam carries it. `availableWeapons` ALSO swaps the card
  //  weapon for a copy without the Concealed Position profile once the operative has shot, so
  //  neither the AI nor the action sheet can offer a profile the shot would then refuse.
  reg.on('availableWeapons', T.bind(A.concealedPosition, 11), (ev) => {
    if (ev.operative.player !== T.player || !hasShot(ev.state, ev.operative.id)) return;
    const seq = shootSeq(ev.state);
    if (seq && seq.attackerId === ev.operative.id) return; // never withdraw mid-sequence
    for (const w of T.card(ev.operative)?.weapons ?? []) {
      const open = w.profiles.filter((p) => !p.rules.some((r) => r.id === 'ConcealedPosition'));
      if (open.length === w.profiles.length) continue;
      ev.weapons = ev.weapons.filter((n) => n !== w.name);
      if (open.length > 0) grantWeapon(ev.operative, { name: w.name, profiles: structuredClone(open) });
    }
  });
  reg.on('onSelectWeapon', T.bind(A.concealedPosition, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (!hasShot(ev.state, ev.ctx.attacker.id)) return;
    ev.allowed = false;
    ev.reason = 'Concealed Position: only the first Shoot action of the battle';
  });
  reg.on('onCollectAttackDice', T.bind(A.concealedPosition, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    markShot(ev.state, ev.ctx.attacker.id);
  });

  // ---- TROOPER › Group Activation -----------------------------------------
  // "Whenever this operative is expended, you must then activate one other ready friendly
  //  DEATH KORPS TROOPER operative (if able) before your opponent activates."
  //  PARTIAL, for the same reason as Directive: the pairing is recorded as an effect.
  reg.on('onActivationEnd', T.bind(A.groupActivation, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.trooper) return;
    if (effectOn(ev.state, op.id, `${GROUP_ACTIVATION}.used`)) return;
    const other = T.friendlies(ev.state).find((o) => o.id !== op.id && o.ready && o.datacardId === C.trooper);
    if (!other) return;
    for (const [rule, id] of [
      [GROUP_ACTIVATION, other.id],
      [`${GROUP_ACTIVATION}.used`, other.id],
    ] as const) {
      effect(ev.state, {
        rule,
        source: { kind: 'ability', id: A.groupActivation },
        sourceText: shortQuote(abilityText(C.trooper, A.groupActivation)),
        operativeId: id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
    }
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Group Activation: ${other.name} activates next`,
      data: { operativeId: other.id },
    });
  });

  // ---- VETERAN › Veteran Guardsman ----------------------------------------
  // "Whenever this operative is activated, it can receive one GUARDSMAN ORDER." A finite menu
  // of options the player picks, so it is a real PendingDecision answered through
  // `decisionHandlers` (the Celestian BENEDICTION precedent).
  reg.on('onActivationStart', T.bind(A.veteranGuardsman, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.veteran) return;
    ev.state.pending.push({
      id: `dkVeteranOrder-${ev.state.seq++}`,
      who: T.player,
      kind: VETERAN_ORDER_DECISION,
      prompt: `${op.name}: Veteran Guardsman — receive one GUARDSMAN ORDER`,
      sourceText: shortQuote(abilityText(C.veteran, A.veteranGuardsman)),
      optional: true,
      options: [
        ...ORDERS.map((order) => ({
          id: order,
          label: ORDER_LABEL[order],
          data: { operativeId: op.id, order },
        })),
        { id: 'none', label: 'No order', data: { operativeId: op.id } },
      ],
    });
  });

  // ---- VETERAN › Bionics ---------------------------------------------------
  // "Normal Dmg of 3 or more inflicts 1 less damage on this operative."
  reg.on('onDamage', T.bind(A.bionics, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.player !== T.player || ev.target.datacardId !== C.veteran) return;
    const profile = damageProfile(T, ev.state);
    if (!profile || profile.dmgN < 3 || ev.amount !== profile.dmgN) return;
    ev.amount = Math.max(0, ev.amount - 1);
  });

  // ---- ZEALOT › The Emperor Protects ---------------------------------------
  reg.on('onDefenceDice', T.bind(A.emperorProtects, 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== C.zealot) return;
    if (!shootSeq(ev.state)) return; // "Whenever an operative is shooting this operative"
    ev.rerolls.push({
      id: 'death-korps.emperorProtects',
      label: 'The Emperor Protects: re-roll any of your defence dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(abilityText(C.zealot, A.emperorProtects)),
    });
  });

  // ---- ZEALOT › Uplifting Primer -------------------------------------------
  // "SUPPORT. Whenever a friendly DEATH KORPS operative is within 3" of this operative, that
  //  friendly operative's weapons have the Severe weapon rule."
  reg.on('onWeaponRules', T.bind(A.upliftingPrimer, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    const near = T.friendlies(ev.state).some((z) => {
      if (z.datacardId !== C.zealot) return false;
      const range = T.ctx ? supportDistance(T.ctx, ev.state, z, 3) : 3;
      return T.gap(z, ev.operative) <= range + EPS;
    });
    if (!near) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Uplifting Primer)'));
  });

  // ---- SPOTTER › SPOT, VOX-OPERATOR › SIGNAL, GAS BOMBARDMENT ---------------
  // The APL stat changes all ride `onStatMod`, which `aplOf` consults, so they expire with
  // their effect instead of leaking a permanent `aplMods` entry.
  reg.on('onStatMod', T.bind(ACT.signal, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, SIGNAL_EFFECT)) ev.mods.apl += 1;
  });
  reg.on('onStatMod', T.bind(A.medic, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, MEDIC_APL);
    if (eff && !eff.data?.['pending']) ev.mods.apl -= 1;
  });
  reg.on('onStatMod', T.bind(A.relayOrders, 14), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, 'death-korps.relayApl')) ev.mods.apl -= 1;
  });

  // ---- COMBINED ARMS bookkeeping ------------------------------------------
  // "…an enemy operative that's been shot by another friendly DEATH KORPS operative during
  //  this turning point."
  reg.on('onCollectAttackDice', T.bind(FP.combinedArms, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    if (!target) return;
    const list = shotBy(ev.state, T.player, target.id);
    if (!list.includes(ev.ctx.attacker.id)) list.push(ev.ctx.attacker.id);
  });

  // ---- free-action bookkeeping --------------------------------------------
  // `grantFreeAction` models the free action as one extra AP (D-015) by pushing a +1 into
  // `aplMods` that the engine never pops. REGROUP and the CHRONOMETER hand that grant to the
  // WHOLE kill team, so without this every Death Korps operative would sit on APL 3 for the
  // rest of the battle. The grant is un-done once its window has closed. Reported as a seam.
  const clearSpentGrants = (state: GameState, op: OperativeState): void => {
    const eff = effectOn(state, op.id, FREE_ACTION_RULE);
    if (!eff || !FREE_ACTION_SOURCES.has(eff.source.id)) return;
    const at = op.aplMods.lastIndexOf(1);
    if (at >= 0) op.aplMods.splice(at, 1);
    dropEffects(state, (e) => e === eff);
  };
  reg.on('onActivationEnd', T.bindText('death-korps.freeAction', text(SP.regroup), 90), (ev) => {
    if (ev.operative.player === T.player) clearSpentGrants(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('death-korps.freeAction', text(SP.regroup), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) clearSpentGrants(ev.state, o);
  });
}

/** Every rule of this team that hands out a `grantFreeAction`, for the clean-up above. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set<string>([SP.regroup, EQ.chronometer, A.medic, A.mineLayer]);

function hasShot(state: GameState, id: string): boolean {
  return Boolean((state.opState['death-korps.shot'] as Record<string, boolean> | undefined)?.[id]);
}
function markShot(state: GameState, id: string): void {
  const b = (state.opState['death-korps.shot'] ?? {}) as Record<string, boolean>;
  b[id] = true;
  state.opState['death-korps.shot'] = b;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- SIEGE WARFARE (strategy) -------------------------------------------
  reg.on('onWeaponRules', T.bind(SP.siegeWarfare, 20), (ev) => {
    if (!strategyUsed(ev.state, T.player, SP.siegeWarfare)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Siege Warfare)'));
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Siege Warfare)'));
  });

  // ---- TAKE COVER (strategy) ----------------------------------------------
  // "…if you can retain any cover saves, improve that friendly operative's Save stat by 1."
  // `ev.mods.save` is read at the Roll Defence Dice step, where `ev.coverSave` is exactly
  // "you can retain a cover save".
  reg.on('onDefenceDice', T.bind(SP.takeCover, 20), (ev) => {
    if (!strategyUsed(ev.state, T.player, SP.takeCover)) return;
    if (!ev.coverSave) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!shootSeq(ev.state)) return; // "Whenever an operative is shooting a friendly … operative"
    ev.mods.save += 1;
  });

  // ---- CLEAR THE LINE (strategy) ------------------------------------------
  reg.on('onWeaponRules', T.bind(SP.clearTheLine, 20), (ev) => {
    if (!strategyUsed(ev.state, T.player, SP.clearTheLine)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Clear the Line)'));
    // "Whenever a friendly DEATH KORPS operative is fighting wholly within your territory, or
    //  whenever it's retaliating, its melee weapons also have the Severe weapon rule."
    if (!ev.retaliating && !whollyInTerritory(T, ev.state, ev.operative, T.player)) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Clear the Line)'));
  });

  // ---- REGROUP (strategy) -------------------------------------------------
  // REMINDER-ONLY clause: "but each that does so must end that move closer to that operative."
  // No hook constrains where a move ENDS — `onMoveDistance` carries only the allowance — so the
  // free Dash is granted without that restriction. Reported as a seam.
  reg.on('onPloyUsed', T.bind(SP.regroup, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.regroup) return;
    // "Select one friendly DEATH KORPS operative that's more than 3" from enemy operatives."
    const leaders = T.friendlies(ev.state, KW).filter((o) => T.enemies(ev.state).every((e) => T.gap(o, e) > 3 + EPS));
    const leader = chosenOperative(ev.state, ev.data, leaders);
    if (!leader) return;
    // "Note that a Comms Device from universal equipment only affects the second distance."
    const range = T.ctx ? supportDistance(T.ctx, ev.state, leader, 5) : 5;
    const movers = T.friendlies(ev.state, KW).filter(
      (o) =>
        o.id !== leader.id &&
        T.gap(o, leader) <= range + EPS &&
        T.enemies(ev.state).every((e) => T.gap(o, e) > 1 + EPS),
    );
    const order = ev.data?.['orderChoice'];
    for (const o of movers) {
      if (order === 'engage' || order === 'conceal') o.order = order; // "in an order of your choice"
      grantFreeAction(ev.state, o, {
        sourceId: SP.regroup,
        sourceText: shortQuote(text(SP.regroup)),
        threshold: currentApl(T, ev.state, o),
        only: ['Dash'],
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Regroup: ${movers.length} operative(s) rally on ${leader.name}`,
    });
  });

  // ---- INSPIRATIONAL LEADERSHIP (firefight) --------------------------------
  reg.on('onPloyUsed', T.bind(FP.inspirationalLeadership, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.inspirationalLeadership) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || active.player !== T.player) return;
    const order = orderFromData(ev.data);
    issueOrder(T, ev.state, active, order, ev.data);
  });

  // ---- COMBINED ARMS (firefight) ------------------------------------------
  // `ploysUsedTP` stays true for the whole turning point, so the ploy arms a one-shot flag
  // instead: it applies to the sequence it was used in, once.
  reg.on('onPloyUsed', T.bind(FP.combinedArms, 19), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.combinedArms) return;
    bucket(ev.state, 'death-korps.combinedArmsArmed')[T.player] = true;
  });
  reg.on('onRollAttack', T.bind(FP.combinedArms, 20), (ev) => {
    const armed = bucket(ev.state, 'death-korps.combinedArmsArmed');
    if (!armed[T.player]) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    if (!combinedArmsReady(T, ev.state)) return;
    delete armed[T.player];
    ev.rerolls.push({
      id: 'death-korps.combinedArms',
      label: 'Combined Arms: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text(FP.combinedArms)),
    });
  });

  // ---- IN LIFE, SHAME (firefight) -----------------------------------------
  reg.on('onPloyUsed', T.bind(FP.inLifeShame, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.inLifeShame) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active) return;
    receiveEveryOrder(T, ev.state, active);
  });

  // ---- IN DEATH, ATONEMENT (firefight) ------------------------------------
  // REMINDER-ONLY. "Before it's removed from the killzone, it can immediately perform one free
  // action and you can change its order to do so." There is no intent for performing an action
  // outside an activation and an incapacitated operative is removed inside the action that
  // killed it — `onIncapacitated.freeActions` is emitted but never consumed, the same gap the
  // Kommandos' Boom! hit (docs/DECISIONS.md D-024). The trigger window IS enforced (see
  // `ployUsable`), so the ploy can only ever be paid for at the printed moment.
  reg.on('onPloyUsed', T.bind(FP.inDeathAtonement, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.inDeathAtonement) return;
    const dying = T.friendlies(ev.state, KW).find((o) => o.incapacitated && !o.removed && o.ready);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `In Death, Atonement: ${dying?.name ?? 'that operative'} performs one free action before it is removed (resolve at the table — the engine has no free-action-on-death seam)`,
    });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/** "HAND AXES — Hand axe 3 / 4+ / 3/4" (death-korps.json › equipment). */
const HAND_AXE: Weapon = printedWeapon(EQ.handAxes, 'Hand axe');

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- CHRONOMETER ---------------------------------------------------------
  // "Once per battle STRATEGIC GAMBIT in the first or second turning point."
  // REMINDER-ONLY clause: "but each that does so must end that move closer to an opponent's
  // drop zone or killzone edge" — the same missing end-of-move seam as REGROUP.
  reg.on('gambitOptions', T.bind(EQ.chronometer, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.chronometer)) return;
    if (ev.state.turningPoint > 2) return;
    if (usedThisBattle(ev.state, `death-korps.chronometer:${T.player}`)) return;
    // "You cannot use this STRATEGIC GAMBIT and the Regroup strategy ploy during the same
    //  turning point."
    if (strategyUsed(ev.state, T.player, SP.regroup)) return;
    ev.options.push({
      id: EQ.chronometer,
      label: 'Chronometer (STRATEGIC GAMBIT)',
      sourceText: shortQuote(text(EQ.chronometer)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.chronometer, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.chronometer) return;
    useOncePerBattle(ev.state, `death-korps.chronometer:${T.player}`);
    const order = ev.data?.['orderChoice'];
    const movers = T.friendlies(ev.state, KW).filter((o) => whollyInTerritory(T, ev.state, o, T.player));
    for (const o of movers) {
      if (order === 'engage' || order === 'conceal') o.order = order; // "in an order of your choice"
      grantFreeAction(ev.state, o, {
        sourceId: EQ.chronometer,
        sourceText: shortQuote(text(EQ.chronometer)),
        kind: 'equipment',
        threshold: currentApl(T, ev.state, o),
        only: ['Dash'],
      });
    }
    log(ev.state, { kind: 'ploy', player: T.player, text: `Chronometer: ${movers.length} operative(s) advance` });
  });

  // ---- COMM-BEADS ----------------------------------------------------------
  // Read by `issueOrder`; nothing to register. (Registering a hook here would be a no-op.)

  // ---- HAND AXES -----------------------------------------------------------
  const giveAxes = (state: GameState): void => {
    if (!hasEquipment(state, T.player, EQ.handAxes)) return;
    for (const o of T.friendlies(state, KW)) grantWeapon(o, structuredClone(HAND_AXE));
  };
  reg.on('onDeploy', T.bind(EQ.handAxes, 30), (ev) => {
    if (ev.operative.player === T.player) giveAxes(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.handAxes, 31), (ev) => {
    if (ev.operative.player === T.player) giveAxes(ev.state);
  });

  // ---- GAS BOMBARDMENT -----------------------------------------------------
  reg.on('gambitOptions', T.bind(EQ.gasBombardment, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.gasBombardment)) return;
    if (usedThisBattle(ev.state, `death-korps.gas:${T.player}`)) return;
    ev.options.push({
      id: EQ.gasBombardment,
      label: 'Gas Bombardment (STRATEGIC GAMBIT)',
      sourceText: shortQuote(text(EQ.gasBombardment)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.gasBombardment, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.gasBombardment) return;
    useOncePerBattle(ev.state, `death-korps.gas:${T.player}`);
    // D-016: the position comes from the intent's `data`; the deterministic default is the
    // centroid of the enemy kill team, nudged off any Vantage overhang.
    const enemies = T.enemies(ev.state);
    const fallback: Vec2 =
      enemies.length > 0
        ? enemies.reduce((a, o) => ({ x: a.x + o.pos.x / enemies.length, y: a.y + o.pos.y / enemies.length }), { x: 0, y: 0 })
        : { x: ev.state.map.board.w / 2, y: ev.state.map.board.h / 2 };
    let pos = posFromData(ev.data, fallback);
    // "it cannot be placed underneath Vantage terrain"
    if (T.ctx && underVantage(T.ctx, ev.state, pos, 0)) {
      const clear = enemies.find((o) => !underVantage(T.ctx!, ev.state, o.pos, o.z));
      if (!clear) return;
      pos = { ...clear.pos };
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Gas marker moved: it cannot be placed underneath Vantage terrain' });
    }
    ev.state.markers[GAS_MARKER(T.player)] = {
      id: GAS_MARKER(T.player),
      kind: 'generic',
      diameterMm: 20,
      pos,
      z: 0,
      owner: T.player,
      flags: { placedTP: ev.state.turningPoint },
    };
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Gas Bombardment: the Gas marker is placed' });
  });
  // "Whenever an operative is within 3" of that marker, subtract 1 from its APL stat… Note that
  //  an operative's APL stat is only changed while it's within 3" of that marker."
  reg.on('onStatMod', T.bind(EQ.gasBombardment, 32), (ev) => {
    const marker = ev.state.markers[GAS_MARKER(T.player)];
    if (!marker) return;
    if (T.markerGap(ev.operative, marker) > 3 + EPS) return;
    ev.mods.apl -= 1;
  });
  // "In the Ready step of the next Strategy phase, remove that marker."
  reg.on('onReadyStep', T.bind(EQ.gasBombardment, 33), (ev) => {
    if (ev.player !== T.player) return;
    const marker = ev.state.markers[GAS_MARKER(T.player)];
    if (!marker) return;
    if (Number(marker.flags['placedTP'] ?? 0) >= ev.state.turningPoint) return;
    removeMarker(ev.state, marker.id);
    log(ev.state, { kind: 'system', player: T.player, text: 'The Gas marker is removed' });
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

function actions(data: typeof DATA) {
  return [
    // MEDIKIT 1AP — MEDIC
    uniqueAction(data, C.medic, ACT.medikit, {
      // "Select one friendly DEATH KORPS operative within this operative's control range to
      //  regain up to 2D3 lost wounds. It cannot be an operative that the Medic! rule was used
      //  on during this turning point."
      // Validated HERE, not in perform (D-026): a perform failure is reverted AND recorded as
      // a rejected intent.
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player)
          return { ok: false, reason: 'select one friendly DEATH KORPS operative' };
        if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
          return { ok: false, reason: 'select one friendly DEATH KORPS operative' };
        if (!inControlRange(ctx, state, op, target))
          return { ok: false, reason: 'that operative is not within this operative’s control range' };
        if (medicUsedOn(state, target.id))
          return { ok: false, reason: 'the Medic! rule was used on that operative during this turning point' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const heal = ctx.rng.d3() + ctx.rng.d3(); // "regain up to 2D3 lost wounds"
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: MEDIKIT restores ${heal} wounds to ${target.name}`,
        });
        return { ok: true };
      },
    }),

    // SPOT 1AP — SPOTTER
    uniqueAction(data, C.spotter, ACT.spot, {
      // "SUPPORT. Select one enemy operative visible to this operative."
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative' };
        if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
          return { ok: false, reason: 'that operative is not visible to this operative' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        dropEffects(state, (e) => e.rule === SPOT_EFFECT && e.player === op.player);
        effect(state, {
          rule: SPOT_EFFECT,
          source: { kind: 'ability', id: ACT.spot },
          sourceText: shortQuote(actionText(C.spotter, ACT.spot)),
          operativeId: target.id,
          player: op.player,
          data: { spotterId: op.id },
          // "Until the end of the turning point"
          expiry: { kind: 'endOfTurningPoint' },
        });
        // The printed effect list is MISSING from data/teams/death-korps.json (the text ends
        // at "…you can use this effect. If you do:"), so the Spot token is placed and nothing
        // reads it — registering a hook here would be a silent no-op. Reported as a data bug.
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: SPOT — ${target.name} is spotted (the printed effect list is missing from the source data)`,
        });
        return { ok: true };
      },
    }),

    // SIGNAL 1AP — VOX-OPERATOR
    uniqueAction(data, C.voxOperator, ACT.signal, {
      // "SUPPORT. Select one other friendly DEATH KORPS operative visible to and within 6" of
      //  this operative."
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one OTHER friendly DEATH KORPS operative' };
        if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
          return { ok: false, reason: 'select one OTHER friendly DEATH KORPS operative' };
        const range = supportDistance(ctx, state, op, 6);
        const c = ctx.datacards.get(op.datacardId);
        const ct = ctx.datacards.get(target.datacardId);
        if (!c || !ct) return { ok: false, reason: 'unknown datacard' };
        if (baseGap(op.pos, c.base, op.rot, target.pos, ct.base, target.rot) > range + EPS)
          return { ok: false, reason: `that operative is more than ${range}" away` };
        if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
          return { ok: false, reason: 'that operative is not visible to this operative' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        dropEffects(state, (e) => e.rule === SIGNAL_EFFECT && e.operativeId === target.id);
        effect(state, {
          rule: SIGNAL_EFFECT,
          source: { kind: 'ability', id: ACT.signal },
          sourceText: shortQuote(actionText(C.voxOperator, ACT.signal)),
          operativeId: target.id,
          player: op.player,
          // "Until the end of that operative's next activation, add 1 to its APL stat."
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: SIGNAL — ${target.name} +1 APL` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// The Mine marker's own Pick Up / Place actions, and the Detonate shot
// ---------------------------------------------------------------------------

export const PICK_UP_MINE = 'Pick Up Marker (Krieg Mine)';
export const PLACE_MINE = 'Place Marker (Krieg Mine)';
export const DETONATE_SHOOT = 'Shoot (Remote Detonator)';

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

/** "Place a marker the active operative is carrying within its control range." */
function minePlacement(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  requested: Vec2 | undefined,
): { ok: boolean; reason?: string; pos?: Vec2 } {
  const pos = requested ?? { ...op.pos };
  const probe: MarkerState = { id: 'probe', kind: 'generic', diameterMm: 20, pos, z: op.z, flags: {} };
  if (!markerContestedBy(ctx, state, probe, op))
    return { ok: false, reason: 'the marker must be placed within control range' };
  return { ok: true, pos };
}

registerAction({
  id: PICK_UP_MINE,
  name: PICK_UP_MINE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: abilityText(C.sapper, A.mineLayer),
  available: (_ctx, _state, op) => op.datacardId === C.sapper,
  check(ctx, state, op) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = state.markers[MINE_MARKER(op.player)];
    if (!marker) return { ok: false, reason: 'your Mine marker is not in the killzone' };
    if (marker.carriedBy) return { ok: false, reason: 'that marker is already being carried' };
    if (!markerContestedBy(ctx, state, marker, op))
      return { ok: false, reason: 'that marker is not within this operative’s control range' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    const marker = state.markers[MINE_MARKER(op.player)]!;
    marker.carriedBy = op.id;
    marker.pos = { ...op.pos };
    marker.z = op.z;
    op.carryingMarkerId = marker.id;
    log(state, { kind: 'action', player: op.player, text: `${op.name} picks up the Mine marker` });
    return { ok: true };
  },
});

registerAction({
  id: PLACE_MINE,
  name: PLACE_MINE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Place Marker',
  sourceText: abilityText(C.sapper, A.mineLayer),
  available: (_ctx, _state, op) => op.datacardId === C.sapper,
  check(ctx, state, op, params) {
    if (op.carryingMarkerId !== MINE_MARKER(op.player)) return { ok: false, reason: 'not carrying the Mine marker' };
    if (did(op, 'Pick Up Marker')) return { ok: false, reason: 'already performed Pick Up Marker this activation' };
    const pos = minePlacement(ctx, state, op, params.markerPos);
    if (!pos.ok) return pos;
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const marker = state.markers[op.carryingMarkerId!]!;
    const pos = minePlacement(ctx, state, op, params.markerPos);
    if (!pos.ok) return pos;
    marker.carriedBy = undefined;
    marker.pos = { ...pos.pos! };
    marker.z = op.z;
    op.carryingMarkerId = undefined;
    log(state, { kind: 'action', player: op.player, text: `${op.name} places the Mine marker` });
    // "…and whenever it performs the Place Marker action on that marker, it can immediately
    //  perform a free Dash action."
    grantFreeAction(state, op, {
      sourceId: A.mineLayer,
      sourceText: shortQuote(abilityText(C.sapper, A.mineLayer)),
      kind: 'ability',
      threshold: aplOf(ctx, state, op),
      only: ['Dash'],
    });
    return { ok: true };
  },
});

/**
 * SAPPER › Detonate (rare weapon rule): "Don't select a valid target. Instead, shoot against
 * each operative within 2" of your Mine marker, unless Heavy terrain is wholly intervening
 * between that operative and that marker… Roll each sequence separately in an order of your
 * choice… At the end of the action, remove your Mine marker from the killzone."
 *
 * The victims are queued exactly as Blast secondaries are, so the whole shoot sequence (dice,
 * re-rolls, decisions) is the engine's own. Only "in an order of your choice" is deterministic
 * (lowest operative id first). This mirrors the Phobos Strike Team implementation.
 */
registerAction({
  id: DETONATE_SHOOT,
  name: DETONATE_SHOOT,
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(C.sapper, A.detonate),
  available: (ctx, _state, op) => Boolean(hasDetonate(ctx.datacards.get(op.datacardId))),
  check(ctx, state, op, params) {
    // The weapon must be named explicitly: this action blows up everything around the marker,
    // friendly operatives included, so it is never something a bare `{}` probe should select.
    if (!params.weaponName) return { ok: false, reason: 'select the weapon that has the Detonate weapon rule' };
    const weapon = hasDetonate(ctx.datacards.get(op.datacardId), params.weaponName);
    if (!weapon) return { ok: false, reason: 'select a weapon that has the Detonate weapon rule' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    const profile = weapon.profiles[0]!;
    const limited = profile.rules.find((r) => r.id === 'Limited');
    if (limited && (op.weaponUses[weapon.name] ?? 0) >= (limited.x ?? 1))
      return { ok: false, reason: `${weapon.name} has already been used` };
    const heavy = profile.rules.find((r) => r.id === 'Heavy');
    if (heavy) {
      const moved = op.actionsThisActivation.some((a) => MOVES.includes(a));
      if (moved && !(heavy.only && op.actionsThisActivation.every((a) => a === heavy.only || !MOVES.includes(a))))
        return { ok: false, reason: `${weapon.name} is Heavy — it cannot be used in an activation in which it moved` };
    }
    // "This weapon cannot be selected if your Mine marker isn't in the killzone."
    const marker = state.markers[MINE_MARKER(op.player)];
    if (!marker) return { ok: false, reason: 'your Mine marker isn’t in the killzone' };
    if (detonateVictims(ctx, state, marker).length === 0)
      return { ok: false, reason: 'no operative is within 2" of your Mine marker' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = hasDetonate(ctx.datacards.get(op.datacardId), params.weaponName)!;
    const marker = state.markers[MINE_MARKER(op.player)]!;
    const victims = detonateVictims(ctx, state, marker);
    const primary = victims[0]!;
    // Point-blank is the engine's "not a valid target" path; its Hit penalty is cancelled by
    // the Detonate stat hook. The flag lets `availableWeapons` hand the weapon back for the
    // length of this call — it is withdrawn from the universal Shoot action otherwise.
    bucket(state, DETONATING)[op.id] = true;
    const r = startShoot(ctx, state, op, weapon.name, params.profileName, primary.id, { pointBlank: true });
    delete bucket(state, DETONATING)[op.id];
    if (!r.ok) return r;
    const seq = state.sequence as ShootSequence;
    seq.queue = victims.slice(1).map((o) => o.id);
    seq.inCover = false;
    seq.obscured = false;
    seq.coverChoiceMade = true;
    // "At the end of the action, remove your Mine marker from the killzone."
    if (marker.carriedBy) {
      const carrier = state.operatives[marker.carriedBy];
      if (carrier) carrier.carryingMarkerId = undefined;
    }
    removeMarker(state, marker.id);
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

/**
 * "…each operative within 2" of your Mine marker, unless Heavy terrain is wholly intervening
 * between that operative and that marker."
 */
function detonateVictims(ctx: GameContext, state: GameState, marker: MarkerState): OperativeState[] {
  const index = terrain(ctx, state);
  const mb = markerBody(marker);
  return Object.values(state.operatives)
    .filter((o) => !o.removed)
    .filter((o) => {
      const c = ctx.datacards.get(o.datacardId);
      if (!c) return false;
      const gap = baseGap(o.pos, c.base, o.rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0);
      if (gap > 2 + EPS) return false;
      const vis = isVisible(index, mb, body(ctx, o));
      if (!vis.visible && vis.blockedBy?.types.includes('Heavy')) return false;
      return true;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------

export const deathKorps = defineTeam({
  id: 'death-korps',
  rules: (reg, T) => {
    rules(reg, T);
    // Veteran Guardsman raises its own decision kind; the handler is installed once per
    // GameContext (`decisionHandler` is a stable reference).
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  gambits: (reg, T) => {
    defaultGambits(reg, T);
    // "You cannot use this ploy and the Chronometer faction equipment STRATEGIC GAMBIT during
    //  the same turning point."
    reg.on('gambitOptions', T.bind(SP.regroup, 60), (ev) => {
      if (ev.player !== T.player) return;
      if (!gambitUsed(ev.state, T.player, EQ.chronometer)) return;
      ev.options = ev.options.filter((o) => o.id !== SP.regroup);
    });
  },
  ployUsable: {
    // "You cannot use this ploy and the Chronometer faction equipment STRATEGIC GAMBIT during
    //  the same turning point."
    [SP.regroup]: (state, player) =>
      gambitUsed(state, player, EQ.chronometer)
        ? { ok: false, reason: 'the Chronometer STRATEGIC GAMBIT was used this turning point' }
        : { ok: true },
    // "Use this firefight ploy during a friendly DEATH KORPS WATCHMASTER or DEATH KORPS
    //  CONFIDANT operative's activation, before or after it performs an action."
    [FP.inspirationalLeadership]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player) return { ok: false, reason: 'no friendly operative is activating' };
      if (active.datacardId !== C.watchmaster && active.datacardId !== C.confidant)
        return { ok: false, reason: 'use this ploy during a WATCHMASTER or CONFIDANT activation' };
      return { ok: true };
    },
    // "Use this firefight ploy after rolling your attack dice for a friendly DEATH KORPS
    //  operative, if it's shooting an enemy operative that's been shot by another friendly
    //  DEATH KORPS operative during this turning point."
    [FP.combinedArms]: (state, player) => {
      const seq = state.sequence;
      if (seq?.kind !== 'shoot' || seq.attacker !== player)
        return { ok: false, reason: 'use this ploy while a friendly operative is shooting' };
      if (!shotBy(state, player, seq.targetId).some((id) => id !== seq.attackerId))
        return { ok: false, reason: 'that enemy operative has not been shot by another friendly operative this turning point' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly DEATH KORPS operative is activated and given an
    //  Engage order."
    [FP.inLifeShame]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player) return { ok: false, reason: 'no friendly operative is activating' };
      if (active.order !== 'engage') return { ok: false, reason: 'that operative was not given an Engage order' };
      return { ok: true };
    },
    // "Use this firefight ploy when a ready friendly DEATH KORPS operative is incapacitated, if
    //  it isn't within control range of enemy operatives."
    [FP.inDeathAtonement]: (state, player) => {
      const dying = Object.values(state.operatives).filter(
        (o) => o.player === player && o.ready && o.incapacitated && !o.removed,
      );
      if (dying.length === 0) return { ok: false, reason: 'no ready friendly operative has just been incapacitated' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [C.watchmaster]: 'leader',
      [C.bruiser]: 'melee',
      [C.confidant]: 'support',
      [C.gunner]: 'gunner',
      [C.medic]: 'support',
      [C.sapper]: 'objective',
      [C.sniper]: 'sniper',
      [C.spotter]: 'support',
      [C.trooper]: 'objective',
      [C.veteran]: 'melee',
      [C.voxOperator]: 'support',
      [C.zealot]: 'objective',
    },
    ployValue: {
      [SP.siegeWarfare]: 0.7,
      [SP.takeCover]: 0.5,
      [SP.clearTheLine]: 0.5,
      [SP.regroup]: 0.4,
      [FP.inspirationalLeadership]: 0.6,
      [FP.combinedArms]: 0.7,
      [FP.inLifeShame]: 0.5,
      [FP.inDeathAtonement]: 0.1,
    },
    equipmentValue: {
      [EQ.chronometer]: 0.4,
      [EQ.commBeads]: 0.3,
      [EQ.handAxes]: 0.6,
      [EQ.gasBombardment]: 0.5,
    },
  },
});

export default deathKorps;
