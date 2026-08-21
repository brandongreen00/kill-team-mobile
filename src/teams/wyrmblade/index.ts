/**
 * WYRMBLADE — Genestealer Cults.
 * https://wahapedia.ru/kill-team3/kill-teams/wyrmblade/
 *
 * Nine datacards, three faction rules, twelve abilities and four unique actions. Every hook
 * carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read out of
 * `data/teams/wyrmblade.json` at module load and is NEVER retyped here.
 *
 * Three shapes drive the module:
 *
 *  - **Cult Ambush** asks whether an operative's "order was changed from Conceal to Engage at
 *    the start of that activation, or it wasn't visible to enemy operatives at the start of
 *    that activation". The reducer assigns `op.order = intent.order` BEFORE it emits
 *    `onActivationStart`, so the previous order is gone by the time any hook runs. The module
 *    therefore keeps its own shadow of every friendly operative's order (`recordOrders`),
 *    refreshed at every moment the engine does expose — Ready step, Gambit step, deploy, and
 *    each activation boundary — never for the operative that is currently active, whose
 *    pre-activation order must survive until its `onActivationStart` reads it. THE DAY IS AT
 *    HAND, COILED SERPENT and Heavy Weapon Bipod all read the same per-activation flag.
 *  - **Familiar Territory is reminder-only.** There is no off-killzone reserve state in this
 *    engine (an operative is either deployed or `removed`) and no decision channel during
 *    deployment, and every clause of the rule hangs off being "set up in HIDING" — the same
 *    gap Murderwing's SLICE THE VEIL and the Exodite Draconic Cavalry Tactics reserve half
 *    reported. No handler is registered: a declared-but-inert hook is the silent no-op
 *    CLAUDE.md architecture rule 5 forbids.
 *  - **Free actions that the universal action forbids are their own 0AP `ActionDef`s**
 *    (docs/DECISIONS.md D-021), each capping its own move in `check` with `MoveOptions.hardCap`
 *    and then delegating to the universal action's `perform` (whose own budget is a superset,
 *    so `perform` can never refuse what `check` allowed — D-026).
 *
 * Reminder-only / partial clauses, each named next to the rule it belongs to and listed in
 * `REMINDER_ONLY` (see docs/TEAM-STATUS.md):
 *  - Familiar Territory, entirely (no reserve state, no deployment decision channel).
 *  - A PLAN GENERATIONS IN THE MAKING and the ICON BEARER's Overthrow the Oppressors — a free
 *    action performed by an operative that has already been incapacitated. `onIncapacitated
 *    .freeActions` is declared but never consumed and the operative is removed inside the
 *    action that killed it (the Kommandos Boom! / Sanctifiers RELIQUANT / Hearthkyn WORTH IT
 *    gap, docs/DECISIONS.md D-024).
 *  - UNQUESTIONING LOYALTY's Fight half — only `startShoot` has a target-substitution seam
 *    (`onSelectTarget`); nothing is emitted before `startFight` picks its enemy.
 *  - Bladed Stance's "that success must be used to block" — the engine builds the strike/block
 *    options itself (the Celestian / Elucidian / Spectre / Corsair / Exodite precedent).
 *  - EXPLOSIVE TRAPS' "You cannot also select that equipment as normal" — the reducer commits
 *    the equipment list before `onSelectEquipment` is emitted and the hook has no veto; the
 *    printed CAP of two mines is honoured instead (see `ensureTraps`).
 *  - Group Activation's back-to-back activation — no activation-order seam; the pairing is
 *    recorded as an effect for the UI/AI (the Breach and Clear partial).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { successes, type DicePool } from '../../core/dice.ts';
import {
  baseRadius,
  dist,
  distancePointToPoly,
  distancePointToSegment,
  norm,
  pointInPoly,
  sub,
} from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { advanceFight, resolveFightDie, startFight } from '../../core/sequences/fight.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  inControlRange,
  log,
  markerContestedBy,
  weaponsOf,
} from '../../core/state.ts';
import { baseDistanceToPart, hasType } from '../../core/terrain.ts';
import { interveningParts, isVisible } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import type { ActionParams, MovePath } from '../../core/intents.ts';
import type {
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  Order,
  PlayerId,
  Vec2,
  Weapon,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData, type TeamRuleText } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  gambitUsed,
  giveToken,
  grantFreeAction,
  grantedWeapons,
  hasEquipment,
  hasToken,
  makeTeamHooks,
  placeTeamMarker,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('wyrmblade');
const KW = 'WYRMBLADE';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionTextOf = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const LEADER = 'wyrmblade.neophyte-leader';
export const KELERMORPH = 'wyrmblade.kelermorph';
export const LOCUS = 'wyrmblade.locus';
export const GUNNER = 'wyrmblade.neophyte-gunner';
export const HEAVY_GUNNER = 'wyrmblade.neophyte-heavy-gunner';
export const ICON_BEARER = 'wyrmblade.neophyte-icon-bearer';
export const SANCTUS_SNIPER = 'wyrmblade.sanctus-sniper';
export const SANCTUS_TALON = 'wyrmblade.sanctus-talon';
export const WARRIOR = 'wyrmblade.neophyte-warrior';

export const R_FAMILIAR = 'wyrmblade.rule.familiar-territory';
export const R_CULT_AGENT = 'wyrmblade.rule.cult-agent';
export const R_CULT_AMBUSH = 'wyrmblade.rule.cult-ambush';

export const SP_DAY = 'wyrmblade.sp.the-day-is-at-hand';
export const SP_CROSSFIRE = 'wyrmblade.sp.crossfire';
export const SP_SHADOWS = 'wyrmblade.sp.one-with-the-shadows';
export const SP_DIVERT = 'wyrmblade.sp.divert-and-disappear';
export const FP_SLINK = 'wyrmblade.fp.slink-into-darkness';
export const FP_COILED = 'wyrmblade.fp.coiled-serpent';
export const FP_LOYALTY = 'wyrmblade.fp.unquestioning-loyalty';
export const FP_PLAN = 'wyrmblade.fp.a-plan-generations-in-the-making';

export const EQ_BLASTING = 'wyrmblade.eq.blasting-charges';
export const EQ_KNIVES = 'wyrmblade.eq.cult-knives';
export const EQ_TRAPS = 'wyrmblade.eq.explosive-traps';
export const EQ_SPOTLIGHTS = 'wyrmblade.eq.spotlights';

export const AB_SHADOW_VECTOR = `${LEADER}.shadow-vector`;
export const AB_HYPERSENSE = `${KELERMORPH}.hypersense`;
export const AB_GUNSLINGER = `${KELERMORPH}.expert-gunslinger`;
export const AB_HEROIC = `${KELERMORPH}.heroic-inspiration`;
export const AB_SWORDSMAN = `${LOCUS}.expert-swordsman`;
export const AB_BLADED_STANCE = `${LOCUS}.bladed-stance`;
export const AB_QUICKSILVER = `${LOCUS}.quicksilver-strike`;
export const AB_BIPOD = `${HEAVY_GUNNER}.heavy-weapon-bipod`;
export const AB_ICON = `${ICON_BEARER}.icon-bearer`;
export const AB_OVERTHROW = `${ICON_BEARER}.overthrow-the-oppressors`;
export const AB_CREEPING = `${SANCTUS_TALON}.creeping-shadow`;
export const AB_GROUP = `${WARRIOR}.group-activation`;

export const ACT_TARGET_VULN = `${SANCTUS_SNIPER}.act.target-vulnerability`;
export const ACT_SNIPER_SOULSIGHT = `${SANCTUS_SNIPER}.act.familiars-soulsight`;
export const ACT_TALON_SOULSIGHT = `${SANCTUS_TALON}.act.familiars-soulsight`;
export const ACT_ASSASSINATE = `${SANCTUS_TALON}.act.assassinate`;

/** Extra `ActionDef`s that carry what a universal action forbids (docs/DECISIONS.md D-021). */
export const SHOOT_GUNSLINGER = 'Shoot (Expert Gunslinger)';
export const FIGHT_SWORDSMAN = 'Fight (Expert Swordsman)';
export const CHARGE_SWORDSMAN = 'Charge (Expert Swordsman)';
export const CHARGE_QUICKSILVER = 'Charge (Quicksilver Strike)';
export const CHARGE_CREEPING = 'Charge (Creeping Shadow)';
export const DASH_CREEPING = 'Dash (Creeping Shadow)';
export const FALL_BACK_CREEPING = 'Fall Back (Creeping Shadow)';

/** Effect / scratch keys — all namespaced, never module-level state (architecture rule 7). */
export const SOULSIGHT_TOKEN = 'wyrmblade.soulsight';
const E_AMBUSH = 'wyrmblade.ambush';
const E_DAY = 'wyrmblade.dayIsAtHand';
const E_COILED = 'wyrmblade.coiledSerpent';
const E_LOYALTY = 'wyrmblade.unquestioningLoyalty';
const E_TARGET_VULN = 'wyrmblade.targetVulnerability';
const E_QUICKSILVER = 'wyrmblade.quicksilverMark';
const E_ASSASSINATE = 'wyrmblade.assassinate';
const E_GROUP = 'wyrmblade.groupActivation';
const E_PLAN = 'wyrmblade.aPlanReminder';
const E_DIVERT = 'wyrmblade.divert';
const E_DIVERT_APL = 'wyrmblade.divertApl';

const ORDERS_KEY = 'wyrmblade.orders';
const CROSSFIRE_KEY = 'wyrmblade.shotThisTP';
const KILLS_KEY = 'wyrmblade.killsTP';
const TRAPS_KEY = 'wyrmblade.traps';
const COILED_NOTE = 'Coiled Serpent';

export const TRAP_MARKER = (player: PlayerId, i: number): string => `wyrmblade.trap.${player}.${i}`;

/**
 * Printed clauses this module does NOT implement, with the engine reason. Exported so the
 * tests can pin them and docs/TEAM-STATUS.md can quote them.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [R_FAMILIAR]:
    'there is no off-killzone reserve state (an operative is either deployed or removed) and no decision channel during deployment, so nothing can be "set up in HIDING"',
  [FP_PLAN]:
    'no intent performs an action outside an activation, onIncapacitated.freeActions is never consumed, and the operative is removed inside the action that killed it (D-024)',
  [AB_OVERTHROW]:
    'both branches are a free action taken by an already-incapacitated operative — the same D-024 gap as A PLAN GENERATIONS IN THE MAKING',
  [`${FP_LOYALTY}.fight`]:
    'only startShoot has a target-substitution seam (onSelectTarget); nothing is emitted before startFight selects its enemy',
  [`${AB_BLADED_STANCE}.block`]:
    'the engine builds the strike/block options itself, so "that success must be used to block" cannot be enforced',
  [`${EQ_TRAPS}.exclusive`]:
    'the reducer commits the equipment list before onSelectEquipment is emitted and the hook has no veto; the printed cap of two mines is enforced instead',
  [`${AB_GROUP}.order`]:
    'there is no activation-order seam — EndActivation hands the turn to the opponent after onActivationEnd and nothing runs later',
};

// ---------------------------------------------------------------------------
// Equipment weapons — the printed tables, with their `WR` row sliced out of the text
// ---------------------------------------------------------------------------

/**
 * "Once per turning point, a friendly WYRMBLADE NEOPHYTE operative can use the following
 *  ranged weapon: Blasting charge — ATK 4, HIT 4+, DMG 3/5, WR Range 4", Blast 1", Saturate."
 *
 * The scraper captured the stat line into `equipment[].weapons` but left `rules: []` (a weapon
 * table printed inside an equipment entry — the sixth team to hit this), so the printed `WR`
 * row is sliced out of the equipment text and parsed by the core parser (the Mandrakes BONE
 * DARTS / Elucidian PRIVATEER SUPPORT ASSETS precedent). The profile is cloned, never shared
 * with the catalogue (docs/DECISIONS.md D-019).
 */
function weaponFromEquipment(equipmentId: string, withRules: boolean): Weapon {
  const holder = DATA.equipment.find((e) => e.id === equipmentId) as TeamRuleText & { weapons?: Weapon[] };
  const w = (holder?.weapons ?? [])[0];
  if (!w) throw new Error(`No weapon table in ${equipmentId}`);
  let rules = w.profiles[0]?.rules ?? [];
  if (withRules) {
    const after = text(equipmentId).split(/\n\s*WR\s*\n/)[1];
    const line = (after ?? '').split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
    rules = parseWeaponRules(line);
    if (rules.length === 0) throw new Error(`Empty WR row for '${w.name}' in ${equipmentId}`);
  }
  return {
    name: w.name,
    profiles: w.profiles.map((p) => ({ ...structuredClone(p), rules: structuredClone(rules) })),
  };
}

export const BLASTING_CHARGE: Weapon = weaponFromEquipment(EQ_BLASTING, true);
/** "Friendly WYRMBLADE NEOPHYTE operatives have the following melee weapon: Cult knife." */
export const CULT_KNIFE: Weapon = weaponFromEquipment(EQ_KNIVES, false);

const sameWeapon = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/** "the Shoot or Fight action", including this module's own D-021 siblings. */
const isShootOrFight = (action: string): boolean => /^(Shoot|Fight)\b/.test(action);

function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/** The operative that just incapacitated `victim`, read from the in-flight sequence. */
function incapacitatorOf(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const ids = seq.kind === 'shoot' ? [seq.attackerId] : [seq.attackerId, seq.defenderId];
  return ids
    .map((id) => state.operatives[id])
    .find((o): o is OperativeState => o !== undefined && o.player !== victim.player);
}

// ---------------------------------------------------------------------------
// Cult Ambush — the shadow order ledger
// ---------------------------------------------------------------------------

/**
 * The order each friendly operative had BEFORE its next activation.
 *
 * `ActivateOperative` overwrites `op.order` before `onActivationStart` is emitted, so the
 * previous order has to be shadowed. The active operative is deliberately skipped: its
 * pre-activation order must survive until its own `onActivationStart` reads it, and
 * `onActivationEnd` then force-records the order it ends with (which is what it will carry
 * into its next activation, SLINK INTO DARKNESS included).
 */
function recordOrders(T: TeamHooks, state: GameState, force?: string): void {
  const b = bucket(state, ORDERS_KEY);
  for (const op of T.friendlies(state)) {
    if (op.id === state.activeOperativeId && op.id !== force) continue;
    b[op.id] = op.order;
  }
}

export function recordedOrder(state: GameState, operativeId: string): Order | undefined {
  const v = bucket(state, ORDERS_KEY)[operativeId];
  return v === 'engage' || v === 'conceal' ? v : undefined;
}

/** The per-activation Cult Ambush verdict: was the order flipped, was the operative unseen? */
export interface AmbushFlags {
  changed: boolean;
  unseen: boolean;
}

export function ambushFlags(state: GameState, operativeId: string): AmbushFlags {
  const eff = effectOn(state, operativeId, E_AMBUSH);
  return {
    changed: eff?.data?.['changed'] === true,
    unseen: eff?.data?.['unseen'] === true,
  };
}

/** "…if its order was changed from Conceal to Engage at the start of that activation." */
export const orderFlipped = (state: GameState, operativeId: string): boolean =>
  ambushFlags(state, operativeId).changed;

// ---------------------------------------------------------------------------
// EXPLOSIVE TRAPS — two real Mines markers, placed as equipment would be
// ---------------------------------------------------------------------------

const MARKER_R = baseRadius({ shape: 'round', mm: 20 });

/** How far inside `poly` the point sits (negative when outside) — `distancePointToPoly` is 0 inside. */
function insideBy(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    best = Math.min(best, distancePointToSegment(p, poly[j]!, poly[i]!));
  return pointInPoly(p, poly) ? best : -best;
}

export function trapMarkers(state: GameState, player: PlayerId): MarkerState[] {
  return Object.values(state.markers)
    .filter((m) => m.owner === player && m.flags['wyrmbladeTrap'] === true)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * "This equipment allows you to select two mines (see universal equipment)."
 *
 * Equipment is placed during setup, which has no decision channel and no team seam, so the
 * markers are created the first time the module sees a deployed friendly operative (the Phobos
 * `ensureTeamMarkers` / Hernkyn Minefield precedent). Each position is a deterministic, logged
 * default (D-016): the first lattice point, ordered outwards from the drop zone, that satisfies
 * the universal Mines placement constraints — "wholly within your territory and more than 2"
 * from other markers, access points and Accessible terrain".
 *
 * "You cannot also select that equipment as normal (i.e. to give you three)" cannot be REFUSED
 * (the reducer commits the equipment list before `onSelectEquipment` and the hook has no veto),
 * so the printed CAP is honoured instead: the universal Mines option contributes its own marker
 * and this equipment tops the kill team up to two, never three.
 */
function ensureTraps(T: TeamHooks, state: GameState): void {
  const made = bucket(state, TRAPS_KEY);
  if (made[`made:${T.player}`]) return;
  if (!hasEquipment(state, T.player, EQ_TRAPS)) return;
  const anchor = T.friendlies(state).find((o) => o.pos.x > -50);
  if (!anchor) return;
  made[`made:${T.player}`] = true;

  const universal = hasEquipment(state, T.player, 'eq.mines') ? 1 : 0;
  const want = Math.max(0, 2 - universal);
  const zoneKey = state.setup.dropZone[T.player] ?? T.player;
  const territory = state.map.territories[zoneKey] ?? [];
  const avoid: Vec2[][] = [];
  const solid: Vec2[][] = [];
  if (T.ctx) {
    for (const part of terrain(T.ctx, state).parts) {
      if (hasType(part, 'Accessible') || part.role === 'accessPoint') avoid.push(part.poly);
      else if (part.solid !== false && part.z0 <= EPS) solid.push(part.poly);
    }
  }
  const others = Object.values(state.markers).map((m) => ({
    pos: m.pos,
    r: baseRadius({ shape: 'round', mm: m.diameterMm }),
  }));

  const lattice: Vec2[] = [];
  for (let x = 1; x <= state.map.board.w - 1; x += 1)
    for (let y = 1; y <= state.map.board.h - 1; y += 1) lattice.push({ x, y });
  lattice.sort((a, b) => dist(a, anchor.pos) - dist(b, anchor.pos) || a.x - b.x || a.y - b.y);

  const placed: Vec2[] = [];
  const legal = (p: Vec2): boolean => {
    // "wholly within your territory" — inside a territory polygon and a marker radius clear of
    // its edges (`distancePointToPoly` is 0 for a point INSIDE, so the edges are measured here).
    if (territory.length > 0 && !territory.some((poly) => insideBy(p, poly) >= MARKER_R - EPS)) return false;
    for (const q of placed) if (dist(p, q) - 2 * MARKER_R <= 2 + EPS) return false;
    for (const m of others) if (dist(p, m.pos) - MARKER_R - m.r <= 2 + EPS) return false;
    for (const poly of avoid) if (distancePointToPoly(p, poly) - MARKER_R <= 2 + EPS) return false;
    for (const poly of solid) if (pointInPoly(p, poly)) return false;
    return true;
  };

  const record = (bucket(state, TRAPS_KEY)['pos'] ?? {}) as Record<string, Vec2>;
  for (let i = 0; i < want; i++) {
    const pos = lattice.find((p) => legal(p));
    if (!pos) break;
    placed.push(pos);
    const id = TRAP_MARKER(T.player, i);
    placeTeamMarker(state, { id, kind: 'mine', player: T.player, pos, flags: { wyrmbladeTrap: true } });
    record[id] = { ...pos };
  }
  bucket(state, TRAPS_KEY)['pos'] = record;
  log(state, {
    kind: 'action',
    player: T.player,
    text: `EXPLOSIVE TRAPS: ${placed.length} Mines marker${placed.length === 1 ? '' : 's'} set up`,
    data: { count: placed.length, source: EQ_TRAPS },
  });
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Familiar Territory — REMINDER-ONLY (see REMINDER_ONLY / the module docblock)
  // =========================================================================
  // No hook is registered: `onDeploy` fires only AFTER a legal drop-zone placement, there is
  // no reserve state to place an operative into, and every clause of the rule (emerging,
  // the Reposition it is treated as, the WARRIOR's Group Activation waiver, and the
  // incapacitation at the end of TP2) hangs off that first, unmodellable choice.

  // =========================================================================
  // Cult Agent
  // =========================================================================
  // "Whenever an operative is shooting a friendly WYRMBLADE CULT AGENT operative: Ignore the
  //  Piercing and Saturate weapon rules."
  //
  // `piercingValue` is computed from the sequence's effective rules one line above the
  // `onDefenceDice` emit, so the rules themselves are where the clause has to land. Piercing
  // Crits x is the crit-only form of the same appendix entry and is ignored with it.
  reg.on('onWeaponRules', T.bind(R_CULT_AGENT, 12), (ev) => {
    if (ev.type !== 'ranged') return;
    const target = ev.target;
    if (!target || !T.mineKw(target, KW) || !T.kw(target, 'CULT AGENT')) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing' && r.id !== 'PiercingCrits' && r.id !== 'Saturate');
  });

  // "If you can retain any cover saves, you can retain one additional cover save, or you can
  //  retain one cover save as a critical success instead. This isn't cumulative with improved
  //  cover saves from Vantage terrain."
  //
  // The additional-save branch is taken deterministically (the Camo Cloaks / Corsair MISTFIELD
  // precedent — there is no decision channel inside `onDefenceDice`, and a second retained
  // normal success is never worse than promoting one). Vantage's own improved cover save is
  // added by the core one line later, so the clause stands down when it applies.
  reg.on('onDefenceDice', T.bind(R_CULT_AGENT, 12), (ev) => {
    if (!ev.coverSave) return; // the second, post-roll emit passes coverSave: false
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || !T.kw(target, 'CULT AGENT')) return;
    const seq = shootSeq(ev.state);
    if (seq?.vantageImprovedCover) return; // "isn't cumulative with … Vantage terrain"
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // =========================================================================
  // Cult Ambush — the shadow order ledger, then the grant
  // =========================================================================
  const ledger = T.bind(R_CULT_AMBUSH, 4);
  reg.on('onReadyStep', ledger, (ev) => {
    if (ev.player === T.player) recordOrders(T, ev.state);
  });
  reg.on('gambitOptions', ledger, (ev) => {
    if (ev.player === T.player) recordOrders(T, ev.state);
  });
  reg.on('onDeploy', ledger, (ev) => {
    if (ev.operative.player === T.player) recordOrders(T, ev.state, ev.operative.id);
  });
  reg.on('onActivationEnd', ledger, (ev) => {
    if (ev.operative.player === T.player) recordOrders(T, ev.state, ev.operative.id);
  });

  // "…if its order was changed from Conceal to Engage at the start of that activation, or it
  //  wasn't visible to enemy operatives at the start of that activation."
  reg.on('onActivationStart', T.bind(R_CULT_AMBUSH, 5), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    const before = recordedOrder(ev.state, op.id);
    const changed = before === 'conceal' && op.order === 'engage';
    const foes = T.enemies(ev.state).filter((e) => e.pos.x > -50);
    const unseen = foes.every((e) => !visibleTo(T, ev.state, e, op));
    effect(ev.state, {
      rule: E_AMBUSH,
      source: { kind: 'core', id: R_CULT_AMBUSH },
      sourceText: shortQuote(text(R_CULT_AMBUSH)),
      operativeId: op.id,
      player: T.player,
      data: { changed, unseen },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    recordOrders(T, ev.state);
  });

  // "…that friendly operative's weapons have the Ceaseless weapon rule." Bound at 10 so the
  // HEAVY GUNNER's Heavy Weapon Bipod (14) sees the grant it upgrades.
  reg.on('onWeaponRules', T.bind(R_CULT_AMBUSH, 10), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    // "…is shooting or fighting DURING ITS ACTIVATION" — never while retaliating.
    if (ev.retaliating || ev.state.activeOperativeId !== op.id) return;
    const flags = ambushFlags(ev.state, op.id);
    if (!flags.changed && !flags.unseen) return;
    if (!ev.rules.some((r) => r.id === 'Ceaseless')) ev.rules.push(ruleTag('Ceaseless'));
  });

  // =========================================================================
  // NEOPHYTE LEADER › Shadow Vector
  // =========================================================================
  // "Once per turning point, you can use the Slink Into Darkness or Coiled Serpent firefight
  //  ploy for 0CP if the specified friendly WYRMBLADE operative is a NEOPHYTE visible to this
  //  operative."
  //
  // The reducer deducts CP before `onPloyUsed` fires, so a 0CP clause is a refund (the
  // Celestian Holy Example / Corsair Prowling Raiders precedent).
  reg.on('onPloyUsed', T.bind(AB_SHADOW_VECTOR, 30), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.ployId !== FP_SLINK && ev.ployId !== FP_COILED) return;
    const specified = specifiedOperative(T, ev.state, ev.data);
    if (!specified || !T.kw(specified, 'NEOPHYTE')) return;
    const leader = T.friendlies(ev.state).find(
      (o) => o.datacardId === LEADER && o.id !== specified.id && visibleTo(T, ev.state, o, specified),
    );
    if (!leader) return;
    if (!useOncePerTP(ev.state, `wyrmblade.shadowVector:${T.player}`)) return;
    const ploy = DATA.firefightPloys.find((p) => p.id === ev.ployId);
    ev.state.teams[T.player].cp += ploy?.cp ?? 1;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Shadow Vector: ${ploy?.name ?? ev.ployId} costs 0CP`,
      data: { operativeId: leader.id },
    });
  });

  // =========================================================================
  // KELERMORPH › Hypersense (rare weapon rule)
  // =========================================================================
  // "Whenever this operative is shooting with this weapon profile, enemy operatives cannot be
  //  obscured." The obscured verdict is a field of the shoot sequence decided in Select Valid
  //  Target; `onCollectAttackDice` is the first hook after it and still precedes the retention
  //  and obscured-discard steps that read it (the Nemesis Claw In Midnight Clad seam).
  reg.on('onCollectAttackDice', T.bind(AB_HYPERSENSE, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Hypersense')) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.obscured) return;
    seq.obscured = false;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Hypersense: ${ev.ctx.defender?.letter ?? 'the target'} cannot be obscured`,
    });
  });

  // =========================================================================
  // KELERMORPH › Heroic Inspiration
  // =========================================================================
  // "…if this operative has incapacitated an enemy operative during this turning point"
  reg.on('onIncapacitated', T.bind(AB_HEROIC, 20), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const killer = incapacitatorOf(ev.state, ev.operative);
    if (!killer || killer.player !== T.player) return;
    bucket(ev.state, KILLS_KEY)[killer.id] = ev.state.turningPoint;
  });

  // "Whenever a friendly WYRMBLADE NEOPHYTE operative visible to and within 3" of this
  //  operative is shooting, fighting or retaliating, … that friendly operative's weapons have
  //  the Severe weapon rule." `onWeaponRules` is read by BOTH sequences (and by `sideWeapon`
  //  for the retaliating side), so all three modes are live.
  reg.on('onWeaponRules', T.bind(AB_HEROIC, 12), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW) || !T.kw(op, 'NEOPHYTE')) return;
    const kills = bucket(ev.state, KILLS_KEY);
    const near = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === KELERMORPH &&
        o.id !== op.id &&
        kills[o.id] === ev.state.turningPoint &&
        T.gap(o, op) <= 3 + EPS &&
        visibleTo(T, ev.state, o, op),
    );
    if (!near) return;
    if (!ev.rules.some((r) => r.id === 'Severe')) ev.rules.push(ruleTag('Severe'));
  });

  // =========================================================================
  // LOCUS › Bladed Stance
  // =========================================================================
  // "Whenever this operative is fighting or retaliating, you can resolve one of your successes
  //  before the normal order." The attacker already resolves first, so only the retaliating
  //  half changes anything; the defender's pool is collected in the same step, so the turn is
  //  flipped as it is built (the Exaction Squad Repress / Corsair Bladed Stance precedent).
  //  "If you do, that success must be used to block" is unenforceable — see REMINDER_ONLY.
  reg.on('onCollectAttackDice', T.bind(AB_BLADED_STANCE, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== LOCUS) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return;
    seq.turn = 'defender';
  });

  // =========================================================================
  // LOCUS › Quicksilver Strike
  // =========================================================================
  // "Once per turning point, after an enemy operative performs an action in which it moves or
  //  is set up, you can interrupt to use this rule."
  //
  // Nothing runs after an action (`offerGuardInterrupt` is the only thing that does and it
  // emits nothing), so the interrupt is taken at the last moment the engine exposes — that
  // enemy's `onActivationEnd` — and the free Charge is `Charge (Quicksilver Strike)` on the
  // LOCUS's own next activation (the Spectre Squad Elite Fieldcraft precedent). Everything
  // else is exact: the 3" cap, the order change, the once-per-turning-point allowance and
  // "it must end that move within control range of THAT enemy operative", which the action's
  // own `check` measures against the marked enemy.
  reg.on('onActivationEnd', T.bind(AB_QUICKSILVER, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    if (!foe.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a))) return;
    const locus = T.friendlies(ev.state).find((o) => o.datacardId === LOCUS && !o.incapacitated);
    if (!locus) return;
    if (usedThisTP(ev.state, `wyrmblade.quicksilver:${locus.id}`)) return;
    if (effectOn(ev.state, locus.id, E_QUICKSILVER)) return;
    // "If this isn't possible, the interruption is cancelled and this rule hasn't been used" —
    // so the allowance is claimed by the action, not here.
    effect(ev.state, {
      rule: E_QUICKSILVER,
      source: { kind: 'ability', id: AB_QUICKSILVER },
      sourceText: shortQuote(abilityText(LOCUS, AB_QUICKSILVER)),
      operativeId: locus.id,
      player: T.player,
      data: { enemyId: foe.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  // =========================================================================
  // NEOPHYTE HEAVY GUNNER › Heavy Weapon Bipod
  // =========================================================================
  // "Whenever this operative is shooting with a weapon from its datacard, if it hasn't moved
  //  during the activation, or if it's a counteraction, that weapon has the Ceaseless weapon
  //  rule; if the weapon already has that weapon rule (i.e. from the Cult Ambush faction
  //  rule), it has the Relentless weapon rule."
  reg.on('onWeaponRules', T.bind(AB_BIPOD, 14), (ev) => {
    const op = ev.operative;
    if (ev.type !== 'ranged' || op.player !== T.player || op.datacardId !== HEAVY_GUNNER) return;
    // "a weapon from its datacard" — never a granted Blasting charge.
    if (!cardOf(HEAVY_GUNNER).weapons.some((w) => sameWeapon(w.name, ev.weaponName))) return;
    const counteracting = ev.state.opState['counteract']?.['operativeId'] === op.id;
    if (!counteracting && op.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a))) return;
    if (ev.rules.some((r) => r.id === 'Ceaseless')) {
      if (!ev.rules.some((r) => r.id === 'Relentless')) ev.rules.push(ruleTag('Relentless'));
    } else {
      ev.rules.push(ruleTag('Ceaseless'));
    }
  });

  // =========================================================================
  // NEOPHYTE ICON BEARER › Icon Bearer
  // =========================================================================
  // "Whenever determining control of a marker, treat this operative's APL stat as 1 higher.
  //  Note this isn't a change to its APL stat, so any changes are cumulative with this."
  reg.on('onMarkerControl', T.bind(AB_ICON, 12), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const bearers = T.friendlies(ev.state).filter(
      (o) => o.datacardId === ICON_BEARER && contests(T, ev.state, o, marker),
    );
    ev.aplByPlayer[T.player] += bearers.length;
  });

  // =========================================================================
  // NEOPHYTE ICON BEARER › Overthrow the Oppressors — REMINDER-ONLY
  // =========================================================================
  // Both branches are a free action taken by an operative that has already been incapacitated
  // (D-024). The effect below carries the printed text so the UI can prompt a human; no rule
  // reads it, and nothing is granted.
  reg.on('onIncapacitated', T.bind(AB_OVERTHROW, 40), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW) || !T.kw(victim, 'NEOPHYTE') || !victim.ready) return;
    const bearer = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === ICON_BEARER &&
        o.id !== victim.id &&
        T.gap(o, victim) <= 6 + EPS &&
        visibleTo(T, ev.state, o, victim),
    );
    if (!bearer) return;
    if (!useOncePerTP(ev.state, `wyrmblade.overthrow:${T.player}`)) return;
    effect(ev.state, {
      rule: E_PLAN,
      source: { kind: 'ability', id: AB_OVERTHROW },
      sourceText: shortQuote(abilityText(ICON_BEARER, AB_OVERTHROW)),
      operativeId: victim.id,
      player: T.player,
      data: { reminderOnly: true, iconBearerId: bearer.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Overthrow the Oppressors is available for ${victim.letter} (reminder only — no free-action-on-death seam)`,
    });
  });

  // =========================================================================
  // NEOPHYTE WARRIOR › Group Activation — PARTIAL
  // =========================================================================
  // "Whenever this operative is expended, you must then activate one other ready friendly
  //  WYRMBLADE WARRIOR operative (if able) before your opponent activates."
  //
  // `EndActivation` hands the turn to the opponent right after `onActivationEnd` and nothing
  // runs later, so the pairing is recorded as an effect the UI/AI reads — the same partial as
  // the Breachers' Breach and Clear, the Pathfinders' and Death Korps' Group Activation and
  // the Warpcoven's MUTANT HERD.
  reg.on('onActivationEnd', T.bind(AB_GROUP, 20), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== WARRIOR) return;
    if (effectOn(ev.state, op.id, E_GROUP)) return; // "you cannot activate more than two in succession"
    const partner = T.friendlies(ev.state).find((o) => o.datacardId === WARRIOR && o.id !== op.id && o.ready);
    if (!partner) return;
    effect(ev.state, {
      rule: E_GROUP,
      source: { kind: 'ability', id: AB_GROUP },
      sourceText: shortQuote(abilityText(WARRIOR, AB_GROUP)),
      operativeId: partner.id,
      player: T.player,
      data: { afterOperativeId: op.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Group Activation: ${partner.letter} activates next`,
      data: { operativeId: partner.id },
    });
  });

  // =========================================================================
  // SANCTUS × 2 › FAMILIAR'S SOULSIGHT — the token's two effects
  // =========================================================================
  // SNIPER: "Whenever this operative is shooting an enemy operative that has one of your
  //  Soulsight tokens, all profiles of this operative's Sanctus sniper rifle have the Saturate
  //  weapon rule and that enemy operative cannot be obscured."
  reg.on('onWeaponRules', T.bind(ACT_SNIPER_SOULSIGHT, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== SANCTUS_SNIPER || ev.type !== 'ranged') return;
    if (!sameWeapon(ev.weaponName, 'Sanctus sniper rifle')) return;
    if (!ev.target || !hasToken(ev.state, ev.target.id, SOULSIGHT_TOKEN, T.player)) return;
    if (!ev.rules.some((r) => r.id === 'Saturate')) ev.rules.push(ruleTag('Saturate'));
  });
  reg.on('onCollectAttackDice', T.bind(ACT_SNIPER_SOULSIGHT, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (ev.ctx.type !== 'ranged' || op.player !== T.player || op.datacardId !== SANCTUS_SNIPER) return;
    if (!sameWeapon(ev.ctx.weaponName, 'Sanctus sniper rifle')) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.obscured) return;
    if (!hasToken(ev.state, seq.targetId, SOULSIGHT_TOKEN, T.player)) return;
    seq.obscured = false;
    log(ev.state, { kind: 'action', player: T.player, text: `Soulsight: ${op.letter}'s target cannot be obscured` });
  });

  // TALON: "Whenever this operative is fighting or retaliating against an enemy operative that
  //  has one of your Soulsight tokens, its Sanctus bio-dagger has the Brutal and Balanced
  //  weapon rules." Both modes are live — `sideWeapon` emits `onWeaponRules` per side.
  reg.on('onWeaponRules', T.bind(ACT_TALON_SOULSIGHT, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== SANCTUS_TALON || ev.type !== 'melee') return;
    if (!sameWeapon(ev.weaponName, 'Sanctus bio-dagger')) return;
    if (!ev.target || !hasToken(ev.state, ev.target.id, SOULSIGHT_TOKEN, T.player)) return;
    if (!ev.rules.some((r) => r.id === 'Brutal')) ev.rules.push(ruleTag('Brutal'));
    if (!ev.rules.some((r) => r.id === 'Balanced')) ev.rules.push(ruleTag('Balanced'));
  });

  // =========================================================================
  // SANCTUS SNIPER › TARGET VULNERABILITY
  // =========================================================================
  // "Until the end of this operative's activation, the stationary profile of its Sanctus
  //  sniper rifle has the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind(ACT_TARGET_VULN, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== SANCTUS_SNIPER) return;
    if (!sameWeapon(ev.weaponName, 'Sanctus sniper rifle') || ev.profile.name !== 'stationary') return;
    if (!effectOn(ev.state, op.id, E_TARGET_VULN)) return;
    if (!ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+'));
  });

  // =========================================================================
  // SANCTUS TALON › ASSASSINATE's extra strike
  // =========================================================================
  // "The first time you strike during that action, you can immediately resolve another of your
  //  successes as a strike (before your opponent)."
  //
  // `resolveFightDie` flips `seq.turn` to the opponent immediately after emitting
  // `onStrikeResolved`, so the extra strike is resolved from inside the hook by re-entering
  // `resolveFightDie` for the same side (the Void Dancer CEGORACH'S JEST precedent of reaching
  // into the live FightSequence). The outer call then hands the turn to the opponent as usual,
  // which is exactly "before your opponent".
  reg.on('onStrikeResolved', T.bind(ACT_ASSASSINATE, 12), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || !T.ctx) return;
    const striker = ev.ctx.attacker;
    if (striker.player !== T.player || seq.attackerId !== striker.id) return;
    const armed = effectOn(ev.state, striker.id, E_ASSASSINATE);
    if (!armed || armed.data?.['enemyId'] !== seq.defenderId) return;
    dropEffects(ev.state, (e) => e === armed); // "the FIRST time you strike during that action"
    const mine = successes(seq.attackerPool);
    const next = mine.find((d) => d.state === 'crit') ?? mine[0];
    if (!next) return;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `ASSASSINATE: ${striker.letter} immediately resolves another success as a strike`,
    });
    resolveFightDie(T.ctx, ev.state, seq, 'attacker', next.id, 'strike');
  });

  // =========================================================================
  // aplMods upkeep for DIVERT AND DISAPPEAR's free actions (docs/DECISIONS.md D-015)
  // =========================================================================
  // `grantFreeAction` pushes a +1 onto `op.aplMods` and an `endOfActivation` effect;
  // `expireActivationEffects` drops the effect but never the `aplMods` entry, so without this
  // upkeep every operative the ploy touched would sit one APL higher for the rest of the
  // battle (the Ratlings Scarper / Death Korps REGROUP / Corsair Aeldari Raiders precedent).
  const upkeep = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (eff.source.id !== SP_DIVERT) continue;
      const at = op.aplMods.lastIndexOf(1);
      if (at >= 0) op.aplMods.splice(at, 1);
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onActivationEnd', T.bindText('wyrmblade.aplUpkeep', text(SP_DIVERT), 90), (ev) => {
    if (ev.operative.player === T.player) upkeep(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('wyrmblade.aplUpkeep', text(SP_DIVERT), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) upkeep(ev.state, o);
  });
}

/** "…contesting it" — the core's own test: visible to and within 1" of the marker. */
function contests(T: TeamHooks, state: GameState, op: OperativeState, marker: MarkerState): boolean {
  if (!T.ctx) return T.markerGap(op, marker) <= 1 + EPS;
  return markerContestedBy(T.ctx, state, marker, op);
}

/** "the specified friendly WYRMBLADE operative" of a firefight ploy (D-016). */
function specifiedOperative(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): OperativeState | undefined {
  const named = data?.['operativeId'];
  if (typeof named === 'string') {
    const found = state.operatives[named];
    if (found && found.player === T.player && !found.removed) return found;
  }
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && active.player === T.player) return active;
  const seq = state.sequence;
  if (seq) {
    const ids = seq.kind === 'shoot' ? [seq.attackerId, seq.targetId] : [seq.attackerId, seq.defenderId];
    const mine = ids.map((id) => state.operatives[id]).find((o) => o?.player === T.player);
    if (mine) return mine;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // THE DAY IS AT HAND (STRATEGIC GAMBIT)
  // =========================================================================
  // "Whenever a friendly WYRMBLADE operative is activated, if its order is changed from Conceal
  //  to Engage, until the end of that activation: Its ranged weapons have the Rending weapon
  //  rule. Add 1 to the Atk stat of its melee weapons (to a maximum of 5)."
  reg.on('onActivationStart', T.bind(SP_DAY, 12), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW) || !gambitUsed(ev.state, T.player, SP_DAY)) return;
    if (!orderFlipped(ev.state, op.id)) return;
    effect(ev.state, {
      rule: E_DAY,
      source: { kind: 'ploy', id: SP_DAY },
      sourceText: shortQuote(text(SP_DAY)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `THE DAY IS AT HAND: ${op.letter} strikes from concealment` });
  });
  reg.on('onWeaponRules', T.bind(SP_DAY, 20), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, E_DAY)) return;
    if (!ev.rules.some((r) => r.id === 'Rending')) ev.rules.push(ruleTag('Rending'));
  });
  reg.on('onCollectAttackDice', T.bind(SP_DAY, 20), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.ctx.attacker.player !== T.player) return;
    if (!effectOn(ev.state, ev.ctx.attacker.id, E_DAY)) return;
    if (ev.count + ev.mods.atk >= 5) return; // "(to a maximum of 5)"
    ev.mods.atk += 1;
  });

  // =========================================================================
  // CROSSFIRE (STRATEGIC GAMBIT)
  // =========================================================================
  // "Whenever a friendly WYRMBLADE operative is shooting an operative that another friendly
  //  WYRMBLADE operative has already shot during this turning point, that first friendly
  //  operative's ranged weapons have the Accurate 1 weapon rule."
  //
  // The ledger is written as the attack dice are collected, which is AFTER `onWeaponRules` has
  // run for this shot — and the reader excludes the current shooter anyway, so a lone operative
  // can never set up its own crossfire.
  reg.on('onCollectAttackDice', T.bind(SP_CROSSFIRE, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    if (!target) return;
    const b = bucket(ev.state, CROSSFIRE_KEY);
    const key = `${ev.state.turningPoint}:${target.id}`;
    const shooters = new Set((b[key] as string[] | undefined) ?? []);
    shooters.add(ev.ctx.attacker.id);
    b[key] = [...shooters].sort();
  });
  reg.on('onWeaponRules', T.bind(SP_CROSSFIRE, 20), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!gambitUsed(ev.state, T.player, SP_CROSSFIRE)) return;
    const shooters = (bucket(ev.state, CROSSFIRE_KEY)[`${ev.state.turningPoint}:${ev.target.id}`] as
      | string[]
      | undefined) ?? [];
    if (!shooters.some((id) => id !== ev.operative.id && ev.state.operatives[id]?.player === T.player)) return;
    if (!ev.rules.some((r) => r.id === 'Accurate')) ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1'));
  });

  // =========================================================================
  // ONE WITH THE SHADOWS (STRATEGIC GAMBIT)
  // =========================================================================
  // "Whenever an operative is shooting a friendly WYRMBLADE operative that has a Conceal order,
  //  if Light terrain is intervening, that friendly operative is obscured (unless the
  //  intervening Light terrain is within 1" of either operative)."
  reg.on('onCollectAttackDice', T.bind(SP_SHADOWS, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || target.order !== 'conceal') return;
    if (!gambitUsed(ev.state, T.player, SP_SHADOWS)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.obscured || seq.targetId !== target.id) return;
    if (!lightIntervenes(T, ev.state, ev.ctx.attacker, target)) return;
    seq.obscured = true;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `ONE WITH THE SHADOWS: ${target.letter} is obscured by Light terrain`,
      data: { operativeId: target.id },
    });
  });

  // =========================================================================
  // DIVERT AND DISAPPEAR (STRATEGIC GAMBIT)
  // =========================================================================
  // "Up to three friendly WYRMBLADE operatives can immediately perform a free Dash or Charge
  //  action in an order of your choice (choose separately for each, and for the latter, it
  //  cannot move more than 3"). If a WYRMBLADE CULT AGENT operative is selected for this ploy,
  //  it counts as two operatives, and it can perform a free Fall Back action instead (it cannot
  //  move more than 3"); if it does, subtract 1 from its APL stat until the end of its next
  //  activation."
  //
  // D-015: a "free action" is one extra AP restricted to the named actions, landing on that
  // operative's next activation because a STRATEGIC GAMBIT is used in the Strategy phase. The
  // three selections are D-016's deterministic, logged default. A CULT AGENT is offered the
  // Fall Back branch only when the printed conditions leave it no alternative — Dash and Charge
  // both refuse an operative already within an enemy's control range, and Fall Back requires
  // exactly that — so the −1 APL is only ever paid when the rule is actually being used.
  reg.on('onPloyUsed', T.bind(SP_DIVERT, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP_DIVERT) return;
    const named = (ev.data?.['operativeIds'] as string[] | undefined) ?? [];
    const pool = [
      ...named.map((id) => ev.state.operatives[id]).filter((o): o is OperativeState => Boolean(o)),
      ...T.friendlies(ev.state, KW).sort(byId),
    ].filter((o, i, xs) => xs.findIndex((x) => x.id === o.id) === i && T.mineKw(o, KW));

    let budget = 3;
    for (const op of pool) {
      const agent = T.kw(op, 'CULT AGENT');
      const cost = agent ? 2 : 1; // "it counts as two operatives"
      if (cost > budget) continue;
      if (effectOn(ev.state, op.id, FREE_ACTION_RULE)) continue; // APL changes clamp to ±1
      const engaged = T.enemies(ev.state).some((e) => inCR(T, ev.state, op, e));
      const fallBack = agent && engaged;
      if (!agent && engaged) continue; // Dash and Charge both refuse an engaged operative
      budget -= cost;
      grantFreeAction(ev.state, op, {
        sourceId: SP_DIVERT,
        sourceText: shortQuote(text(SP_DIVERT)),
        threshold: currentApl(T, ev.state, op),
        kind: 'ploy',
        only: fallBack ? ['Fall Back'] : ['Dash', 'Charge'],
      });
      effect(ev.state, {
        rule: E_DIVERT,
        source: { kind: 'ploy', id: SP_DIVERT },
        sourceText: shortQuote(text(SP_DIVERT)),
        operativeId: op.id,
        player: T.player,
        data: { fallBack },
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
      if (budget <= 0) break;
    }
  });
  // "…it cannot move more than 3"" — the cap rides the granted AP, so it only bites while the
  // operative is spending it.
  reg.on('onMoveDistance', T.bind(SP_DIVERT, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    if (ev.action !== 'Charge' && ev.action !== 'Fall Back') return;
    const grant = effectOn(ev.state, op.id, FREE_ACTION_RULE);
    if (!grant || grant.source.id !== SP_DIVERT) return;
    if (op.apSpent < Number(grant.data?.['threshold'] ?? 0)) return;
    ev.inches = Math.min(ev.inches, 3);
  });
  // "…if it does, subtract 1 from its APL stat until the end of its next activation." The free
  // action is D-015's extra AP inside the operative's own activation, so the printed penalty —
  // which the card lands on that same activation — would cancel the grant and the rule would do
  // nothing at all. It is armed at the end of the activation the Fall Back was spent in and
  // runs through the following one instead (reported as a partial).
  reg.on('onActivationEnd', T.bind(SP_DIVERT, 30), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const div = effectOn(ev.state, op.id, E_DIVERT);
    if (!div || div.data?.['fallBack'] !== true) return;
    if (!op.actionsThisActivation.some((a) => a === 'Fall Back')) return;
    effect(ev.state, {
      rule: E_DIVERT_APL,
      source: { kind: 'ploy', id: SP_DIVERT },
      sourceText: shortQuote(text(SP_DIVERT)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
    });
  });
  reg.on('onStatMod', T.bind(SP_DIVERT, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, E_DIVERT_APL)) ev.mods.apl -= 1;
  });

  // =========================================================================
  // SLINK INTO DARKNESS
  // =========================================================================
  // "Use this firefight ploy at the end of a friendly WYRMBLADE operative's activation. If that
  //  operative has an Engage order, change it to Conceal. You cannot use this ploy for each
  //  friendly operative more than once per battle."
  reg.on('onPloyUsed', T.bind(FP_SLINK, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_SLINK) return;
    const op = specifiedOperative(T, ev.state, ev.data);
    if (!op || !T.mineKw(op, KW) || op.order !== 'engage') return;
    if (!useOncePerBattle(ev.state, `wyrmblade.slink:${op.id}`)) return;
    op.order = 'conceal';
    log(ev.state, { kind: 'ploy', player: T.player, text: `SLINK INTO DARKNESS: ${op.letter} changes to Conceal` });
  });

  // =========================================================================
  // COILED SERPENT
  // =========================================================================
  // "Use this firefight ploy when a friendly WYRMBLADE operative is shooting or fighting, after
  //  rolling your attack dice. If that friendly operative's order was changed from Conceal to
  //  Engage at the start of that activation and this is the first time it's performed either the
  //  Shoot or Fight action during that activation, you can retain one of your normal successes
  //  as a critical success instead. Note this ploy cannot come into effect more than once per
  //  activation."
  //
  // `enumerateCandidates` offers no ploy while a decision is pending, so the ploy is DECLARED
  // in advance and lands at the retention step — the one post-roll moment BOTH sequences share
  // (`advanceShoot` calls `effectiveRules` at the top of every pass and `advanceFight`'s
  // retention case calls `sideWeapon` per side, each immediately before `retentionOptions`).
  // That makes shooting AND fighting live despite D-031; only the moment of declaration moves
  // (the Exodite FERAL HUNGER shape).
  reg.on('onPloyUsed', T.bind(FP_COILED, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_COILED) return;
    const op = specifiedOperative(T, ev.state, ev.data);
    if (!op || !T.mineKw(op, KW)) return;
    effect(ev.state, {
      rule: E_COILED,
      source: { kind: 'ploy', id: FP_COILED },
      sourceText: shortQuote(text(FP_COILED)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind(FP_COILED, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !T.mineKw(op, KW) || ev.retaliating) return;
    const armed = effectOn(ev.state, op.id, E_COILED);
    if (!armed || armed.data?.['spent'] === true) return;
    if (!orderFlipped(ev.state, op.id)) return;
    // "the first time it's performed either the Shoot or Fight action during that activation" —
    // the restriction key is pushed only AFTER the action resolves, so mid-sequence this is 0.
    if (op.actionsThisActivation.some(isShootOrFight)) return;
    const seq = ev.state.sequence;
    if (!seq || seq.step !== 'retention') return;
    let pool: DicePool;
    if (seq.kind === 'shoot') {
      if (seq.attackerId !== op.id) return;
      // Obscured "takes precedence": every crit is turned back into a normal one step later.
      if (seq.obscured) return;
      pool = seq.attack;
    } else if (seq.attackerId === op.id) {
      pool = seq.attackerPool;
    } else {
      return;
    }
    const die = pool.dice.find((d) => d.state === 'normal');
    if (!die) return;
    die.state = 'crit';
    die.note = COILED_NOTE;
    armed.data = { ...(armed.data ?? {}), spent: true };
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `COILED SERPENT: ${op.letter} retains a normal success as a critical success`,
    });
  });

  // =========================================================================
  // UNQUESTIONING LOYALTY
  // =========================================================================
  // "Use this firefight ploy when a friendly WYRMBLADE CULT AGENT or WYRMBLADE LEADER operative
  //  is selected as the valid target of a Shoot action or to fight against during the Fight
  //  action. Select one other friendly WYRMBLADE NEOPHYTE operative (excluding LEADER) visible
  //  to and within 3" of that first friendly operative to become the valid target … instead
  //  (even if it wouldn't normally be valid for this). … If it's the Shoot action, that other
  //  operative is only in cover or obscured if the original target was. This ploy has no effect
  //  if it's the Shoot action and the ranged weapon has the Blast or Torrent weapon rule."
  //
  // The Shoot half is exact through `onSelectTarget`, whose substitute inherits the original's
  // cover/obscured by construction. The Fight half is reminder-only (see REMINDER_ONLY).
  reg.on('onPloyUsed', T.bind(FP_LOYALTY, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_LOYALTY) return;
    effect(ev.state, {
      rule: E_LOYALTY,
      source: { kind: 'ploy', id: FP_LOYALTY },
      sourceText: shortQuote(text(FP_LOYALTY)),
      player: T.player,
      ...(typeof ev.data?.['substituteId'] === 'string' ? { data: { substituteId: ev.data['substituteId'] } } : {}),
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onSelectTarget', T.bind(FP_LOYALTY, 12), (ev) => {
    const shielded = ev.target;
    if (shielded.player !== T.player || !T.kw(shielded, KW)) return;
    if (!T.kw(shielded, 'CULT AGENT') && !T.kw(shielded, 'LEADER')) return;
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    const armed = ev.state.effects.find((e) => e.rule === E_LOYALTY && e.player === T.player);
    if (!armed) return;
    const sub = loyaltySubstitute(T, ev.state, shielded, armed.data?.['substituteId']);
    if (!sub) return;
    dropEffects(ev.state, (e) => e === armed);
    ev.redirectTo = sub.id;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `UNQUESTIONING LOYALTY: ${sub.letter} becomes the target instead of ${shielded.letter}`,
    });
  });

  // =========================================================================
  // A PLAN GENERATIONS IN THE MAKING — REMINDER-ONLY
  // =========================================================================
  // "It can perform a free mission action before it's removed from the killzone." No intent
  // performs an action outside an activation, `onIncapacitated.freeActions` is never consumed
  // and the operative is removed inside the action that killed it (D-024). The effect records
  // the printed text for the UI; nothing reads it.
  reg.on('onPloyUsed', T.bind(FP_PLAN, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_PLAN) return;
    const victim = T.friendlies(ev.state).find((o) => o.incapacitated && T.kw(o, 'NEOPHYTE'));
    effect(ev.state, {
      rule: E_PLAN,
      source: { kind: 'ploy', id: FP_PLAN },
      sourceText: shortQuote(text(FP_PLAN)),
      player: T.player,
      ...(victim ? { operativeId: victim.id } : {}),
      data: { reminderOnly: true },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: 'A PLAN GENERATIONS IN THE MAKING: reminder only — the engine cannot perform an action for an incapacitated operative',
    });
  });
}

/** "one other friendly WYRMBLADE NEOPHYTE operative (excluding LEADER) visible to and within 3"." */
export function loyaltySubstitute(
  T: TeamHooks,
  state: GameState,
  shielded: OperativeState,
  namedId?: unknown,
): OperativeState | undefined {
  const candidates = T.friendlies(state, KW)
    .filter(
      (o) =>
        o.id !== shielded.id &&
        T.kw(o, 'NEOPHYTE') &&
        !T.kw(o, 'LEADER') &&
        T.gap(o, shielded) <= 3 + EPS &&
        visibleTo(T, state, o, shielded),
    )
    .sort(byId);
  if (typeof namedId === 'string') {
    const named = candidates.find((o) => o.id === namedId);
    if (named) return named;
  }
  return candidates[0];
}

/** "if Light terrain is intervening … unless the intervening Light terrain is within 1" of either". */
function lightIntervenes(T: TeamHooks, state: GameState, shooter: OperativeState, target: OperativeState): boolean {
  if (!T.ctx) return false;
  const index = terrain(T.ctx, state);
  const a = body(T.ctx, shooter);
  const b = body(T.ctx, target);
  for (const part of interveningParts(index, a, b).any) {
    if (!hasType(part, 'Light')) continue;
    if (baseDistanceToPart(a.pos, a.base, a.rot, part) <= 1 + EPS) continue;
    if (baseDistanceToPart(b.pos, b.base, b.rot, part) <= 1 + EPS) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // BLASTING CHARGES / CULT KNIVES — granted weapons
  // =========================================================================
  // `weaponsOf` reads `grantedWeapons` AFTER `availableWeapons`, so the granted set is kept
  // equal to exactly the legal one on every read (the Elucidian PRIVATEER SUPPORT ASSETS /
  // Mandrakes BONE DARTS shape): the UI, the AI's shot plans and `startShoot` can never
  // disagree, and the AI can never be offered a charge the sequence would then refuse.
  reg.on('availableWeapons', T.bindText(EQ_BLASTING, text(EQ_BLASTING), 30), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
    const has = grantedWeapons(op).some((w) => sameWeapon(w.name, BLASTING_CHARGE.name));
    const seq = shootSeq(ev.state);
    const inFlight = seq?.attackerId === op.id && sameWeapon(seq.weaponName, BLASTING_CHARGE.name);
    const want =
      hasEquipment(ev.state, T.player, EQ_BLASTING) &&
      T.kw(op, KW) &&
      T.kw(op, 'NEOPHYTE') &&
      !op.incapacitated &&
      (inFlight || !usedThisTP(ev.state, `wyrmblade.blastingCharge:${T.player}`));
    if (want && !has) holder.grantedWeapons = [...grantedWeapons(op), structuredClone(BLASTING_CHARGE)];
    else if (!want && has)
      holder.grantedWeapons = grantedWeapons(op).filter((w) => !sameWeapon(w.name, BLASTING_CHARGE.name));
  });
  reg.on('onSelectWeapon', T.bindText(EQ_BLASTING, text(EQ_BLASTING), 30), (ev) => {
    if (!sameWeapon(ev.ctx.weaponName, BLASTING_CHARGE.name)) return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ_BLASTING)) {
      ev.allowed = false;
      ev.reason = 'your kill team has not selected BLASTING CHARGES';
      return;
    }
    if (usedThisTP(ev.state, `wyrmblade.blastingCharge:${T.player}`)) {
      ev.allowed = false;
      ev.reason = 'a Blasting charge can only be used once per turning point';
      return;
    }
    if (ev.dryRun) return; // D-032: a `check` must never mutate
    useOncePerTP(ev.state, `wyrmblade.blastingCharge:${T.player}`);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `BLASTING CHARGES: ${ev.ctx.attacker.letter} throws this turning point's charge`,
    });
  });

  reg.on('availableWeapons', T.bindText(EQ_KNIVES, text(EQ_KNIVES), 30), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
    const has = grantedWeapons(op).some((w) => sameWeapon(w.name, CULT_KNIFE.name));
    const want =
      hasEquipment(ev.state, T.player, EQ_KNIVES) && T.kw(op, KW) && T.kw(op, 'NEOPHYTE') && !op.incapacitated;
    if (want && !has) holder.grantedWeapons = [...grantedWeapons(op), structuredClone(CULT_KNIFE)];
    else if (!want && has)
      holder.grantedWeapons = grantedWeapons(op).filter((w) => !sameWeapon(w.name, CULT_KNIFE.name));
  });

  // =========================================================================
  // EXPLOSIVE TRAPS
  // =========================================================================
  reg.on('onDeploy', T.bindText(EQ_TRAPS, text(EQ_TRAPS), 30), (ev) => {
    if (ev.operative.player === T.player) ensureTraps(T, ev.state);
  });
  reg.on('onActivationStart', T.bindText(EQ_TRAPS, text(EQ_TRAPS), 30), (ev) => {
    if (ev.operative.player === T.player) ensureTraps(T, ev.state);
  });
  // "…and friendly WYRMBLADE operatives are ignored for your mines' effects (i.e. they cannot
  //  trigger or take damage from them). This takes precedence over the normal mines rules."
  //
  // `checkMines` lives inside `applyMove` (`src/core/actions.ts`), is hard-wired to
  // `kind: 'mine'` and any player, and emits no marker-trigger hook — the gap every team mine
  // has reported. It DOES route its damage through `inflictDamage`, so `onDamage` is the one
  // seam: the damage is zeroed and the marker this player owns is put back exactly where it
  // was, which is both printed halves. An enemy's own Mines marker is untouched (nothing of
  // this player's is missing), so a WYRMBLADE operative still takes damage from it.
  reg.on('onDamage', T.bindText(EQ_TRAPS, text(EQ_TRAPS), 8), (ev) => {
    if (ev.kind !== 'mine' || !T.mineKw(ev.target, KW)) return;
    if (!hasEquipment(ev.state, T.player, EQ_TRAPS)) return;
    const record = (bucket(ev.state, TRAPS_KEY)['pos'] ?? {}) as Record<string, Vec2>;
    const missing = Object.keys(record)
      .sort()
      .find((id) => !ev.state.markers[id]);
    if (!missing) return; // not one of ours — the printed immunity is only for "YOUR mines"
    placeTeamMarker(ev.state, {
      id: missing,
      kind: 'mine',
      player: T.player,
      pos: record[missing]!,
      flags: { wyrmbladeTrap: true },
    });
    ev.amount = 0;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `EXPLOSIVE TRAPS: ${ev.target.letter} is ignored for your mines' effects`,
      data: { markerId: missing },
    });
  });

  // =========================================================================
  // SPOTLIGHTS
  // =========================================================================
  // "Whenever a friendly WYRMBLADE operative is shooting, the target cannot be obscured if it's
  //  visible to and within 6" of a friendly WYRMBLADE NEOPHYTE operative that isn't within
  //  control range of enemy operatives."
  reg.on('onCollectAttackDice', T.bindText(EQ_SPOTLIGHTS, text(EQ_SPOTLIGHTS), 30), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    if (!hasEquipment(ev.state, T.player, EQ_SPOTLIGHTS)) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.obscured) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target) return;
    const lamp = T.friendlies(ev.state, KW).find(
      (o) =>
        T.kw(o, 'NEOPHYTE') &&
        T.gap(o, target) <= 6 + EPS &&
        visibleTo(T, ev.state, o, target) &&
        !T.enemies(ev.state).some((e) => inCR(T, ev.state, o, e)),
    );
    if (!lamp) return;
    seq.obscured = false;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `SPOTLIGHTS: ${lamp.letter} reveals ${target.letter} — it cannot be obscured`,
    });
  });
}

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

const enemiesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, otherPlayer(op.player)).sort(byId);

const notEngagedHere = (
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
): { ok: boolean; reason?: string } =>
  enemiesInControlRange(ctx, state, op).length > 0
    ? { ok: false, reason: 'this operative cannot perform this action while within control range of an enemy operative' }
    : { ok: true };

/** "Select one enemy operative visible to this operative." */
function soulsightTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const wanted = params.targetOperativeId ?? params.targetId;
  const index = terrain(ctx, state);
  const visible = enemiesOf(state, op).filter((e) => isVisible(index, body(ctx, op), body(ctx, e)).visible);
  if (typeof wanted === 'string') return visible.find((e) => e.id === wanted);
  return visible[0];
}

/**
 * ASSASSINATE's charge: "Perform a free Charge action with this operative, but don't exceed its
 * Move stat (i.e. don't add 2"), and it must end that move within control range of that enemy
 * operative."
 *
 * A caller-supplied `params.path` is used when there is one (the UI can route around terrain);
 * `src/ai/legal.ts` builds movement params only for the four universal move ids, so otherwise
 * the path is a deterministic, logged default (D-016): a straight line stopping just inside the
 * target's control range. Either way it is validated with `bonusInches: 0` in `check`, and the
 * universal Charge's own `perform` then re-validates it against a strictly larger budget, so a
 * `perform` can never refuse what `check` allowed.
 */
function assassinatePath(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  enemy: OperativeState,
  params?: ActionParams,
): { path: MovePath } | undefined {
  const chargeOpts = {
    action: 'Charge' as const,
    bonusInches: 0,
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
  };
  const landsOnTarget = (path: MovePath): boolean => {
    const v = validateMove(ctx, state, op, path, chargeOpts);
    if (!v.ok) return false;
    return inControlRange(ctx, state, { ...op, pos: v.endPos, z: v.endZ }, enemy);
  };
  if (params?.path) return landsOnTarget(params.path) ? { path: params.path } : undefined;
  const dir = norm(sub(enemy.pos, op.pos));
  if (dir.x === 0 && dir.y === 0) return undefined;
  const rA = baseRadius(ctx.datacards.get(op.datacardId)?.base ?? { shape: 'round', mm: 32 });
  const rB = baseRadius(ctx.datacards.get(enemy.datacardId)?.base ?? { shape: 'round', mm: 32 });
  const centres = dist(op.pos, enemy.pos);
  const stop = rA + rB + 0.75; // comfortably inside the 1" control range
  const travel = centres - stop;
  if (travel <= 0) return undefined;
  const path: MovePath = { points: [{ x: op.pos.x + dir.x * travel, y: op.pos.y + dir.y * travel }] };
  return landsOnTarget(path) ? { path } : undefined;
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- SANCTUS SNIPER › TARGET VULNERABILITY ----------------------------
    uniqueAction(data, SANCTUS_SNIPER, ACT_TARGET_VULN, {
      check: (ctx, state, op) => notEngagedHere(ctx, state, op),
      perform(_ctx, state, op) {
        effect(state, {
          rule: E_TARGET_VULN,
          source: { kind: 'ability', id: ACT_TARGET_VULN },
          sourceText: shortQuote(actionTextOf(SANCTUS_SNIPER, ACT_TARGET_VULN)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter} finds a target vulnerability (stationary profile gains Lethal 5+)`,
        });
        return { ok: true };
      },
    }),

    // ---- SANCTUS SNIPER / SANCTUS TALON › FAMILIAR'S SOULSIGHT ------------
    soulsightAction(data, SANCTUS_SNIPER, ACT_SNIPER_SOULSIGHT),
    soulsightAction(data, SANCTUS_TALON, ACT_TALON_SOULSIGHT),

    // ---- SANCTUS TALON › ASSASSINATE --------------------------------------
    uniqueAction(data, SANCTUS_TALON, ACT_ASSASSINATE, {
      check(ctx, state, op, params) {
        // "This operative cannot perform this action while it has an Engage order, or while
        //  within control range of an enemy operative."
        if (op.order === 'engage')
          return { ok: false, reason: 'this operative cannot perform this action while it has an Engage order' };
        const engaged = notEngagedHere(ctx, state, op);
        if (!engaged.ok) return engaged;
        const enemy = assassinateTarget(ctx, state, op, params);
        if (!enemy) return { ok: false, reason: 'select one enemy operative this operative isn’t visible to' };
        if (!assassinatePath(ctx, state, op, enemy, params))
          return { ok: false, reason: 'no legal Charge ends within control range of that enemy operative' };
        if (weaponsOf(ctx, state, op, 'melee').length === 0) return { ok: false, reason: 'no melee weapon' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        const enemy = assassinateTarget(ctx, state, op, params)!;
        const move = assassinatePath(ctx, state, op, enemy, params)!;
        const charge = getAction('Charge')!.perform(ctx, state, op, move);
        if (!charge.ok) return charge;
        // "a free Charge action" / "a free Fight action" — free of AP, but still those actions
        // for the purposes of action restrictions.
        if (!op.actionsThisActivation.includes('Charge')) op.actionsThisActivation.push('Charge');
        effect(state, {
          rule: E_ASSASSINATE,
          source: { kind: 'ability', id: ACT_ASSASSINATE },
          sourceText: shortQuote(actionTextOf(SANCTUS_TALON, ACT_ASSASSINATE)),
          operativeId: op.id,
          player: op.player,
          data: { enemyId: enemy.id },
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        const weapon =
          weaponsOf(ctx, state, op, 'melee').find((w) => sameWeapon(w.name, 'Sanctus bio-dagger')) ??
          weaponsOf(ctx, state, op, 'melee')[0]!;
        const fight = startFight(ctx, state, op, weapon.name, undefined, enemy.id, { free: true });
        if (!fight.ok) return fight;
        if (!op.actionsThisActivation.includes('Fight')) op.actionsThisActivation.push('Fight');
        advanceFight(ctx, state);
        return { ok: true };
      },
    }),
  ];
}

/** "Select one enemy operative this operative isn't visible to." */
function assassinateTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const wanted = params.targetOperativeId ?? params.targetId;
  const index = terrain(ctx, state);
  const hidden = enemiesOf(state, op).filter((e) => !isVisible(index, body(ctx, op), body(ctx, e)).visible);
  const pool = typeof wanted === 'string' ? hidden.filter((e) => e.id === wanted) : hidden;
  return pool.find((e) => assassinatePath(ctx, state, op, e, params) !== undefined);
}

function soulsightAction(data: typeof DATA, cardId: string, actionId: string): ActionDef {
  return uniqueAction(data, cardId, actionId, {
    check(ctx, state, op, params) {
      const engaged = notEngagedHere(ctx, state, op);
      if (!engaged.ok) return engaged;
      if (!soulsightTarget(ctx, state, op, params))
        return { ok: false, reason: 'select one enemy operative visible to this operative' };
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      const enemy = soulsightTarget(ctx, state, op, params)!;
      // "…until this action is performed again by a friendly operative (whichever comes first)"
      clearSoulsight(state, op.player);
      giveToken(state, enemy, SOULSIGHT_TOKEN, {
        sourceId: actionId,
        sourceText: shortQuote(actionTextOf(cardId, actionId)),
        player: op.player,
        expiry: { kind: 'endOfBattle' }, // "Until the end of the battle…"
      });
      return { ok: true };
    },
  });
}

/** Drops only THIS player's Soulsight token, so a mirror match keeps the two apart. */
export function clearSoulsight(state: GameState, player: PlayerId): void {
  state.effects = state.effects.filter((e) => !(e.rule === SOULSIGHT_TOKEN && e.player === player));
}

// ---------------------------------------------------------------------------
// D-021 carve-outs: actions the universal ones forbid
// ---------------------------------------------------------------------------

/**
 * KELERMORPH › Expert Gunslinger — "This operative can perform two Shoot actions during its
 * activation." Action restrictions forbid repeating an action, so the second Shoot is its own
 * action with its own restriction key and resolves through the universal Shoot.
 */
registerAction({
  id: SHOOT_GUNSLINGER,
  name: SHOOT_GUNSLINGER,
  ap: 1,
  type: 'unique',
  sourceText: abilityText(KELERMORPH, AB_GUNSLINGER),
  available: (_ctx, _state, op) => op.datacardId === KELERMORPH,
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Expert Gunslinger is the second Shoot action of an activation' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

/** LOCUS › Expert Swordsman — "This operative can perform two Fight actions during its activation." */
registerAction({
  id: FIGHT_SWORDSMAN,
  name: FIGHT_SWORDSMAN,
  ap: 1,
  type: 'unique',
  sourceText: abilityText(LOCUS, AB_SWORDSMAN),
  available: (_ctx, _state, op) => op.datacardId === LOCUS,
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Expert Swordsman is the second Fight action of an activation' };
    // `src/ai/legal.ts` offers friendly ids to any non-universal action, and the universal
    // Fight's own `perform` takes `params.targetId` on trust — so the enemy check lives here
    // (docs/DECISIONS.md D-026: whatever `check` accepts, `perform` must be able to complete).
    if (params.targetId) {
      const foe = state.operatives[params.targetId];
      if (!foe || foe.removed || foe.player === op.player)
        return { ok: false, reason: 'select an enemy operative within control range' };
    }
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

/**
 * A free Charge / Dash / Fall Back that a universal action would refuse. The distance cap lives
 * in `check` through `MoveOptions.hardCap`; `perform` then delegates to the universal action,
 * whose own budget is a superset, so it can never refuse what `check` allowed (D-026).
 */
function freeMove(spec: {
  id: string;
  delegate: 'Charge' | 'Dash' | 'Fall Back';
  sourceText: string;
  datacardId: string;
  cap?: number;
  bonusInches?: number;
  gate(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): { ok: boolean; reason?: string };
  before?(ctx: GameContext, state: GameState, op: OperativeState): void;
}): ActionDef {
  const opts = {
    Charge: { action: 'Charge' as const, mayEnterEnemyControlRange: true, mustFinishEngaged: true },
    Dash: { action: 'Dash' as const, noClimb: true, mustNotFinishEngaged: true },
    'Fall Back': { action: 'Fall Back' as const, mayEnterEnemyControlRange: true, mustNotFinishEngaged: true },
  }[spec.delegate];
  return {
    id: spec.id,
    name: spec.id,
    ap: 0, // "a free … action"
    type: 'unique',
    sourceText: spec.sourceText,
    available: (_ctx, _state, op) => op.datacardId === spec.datacardId,
    check(ctx, state, op, params) {
      const gate = spec.gate(ctx, state, op, params);
      if (!gate.ok) return gate;
      if (!params.path) return { ok: false, reason: 'no path supplied' };
      const v = validateMove(ctx, state, op, params.path, {
        ...opts,
        ...(spec.bonusInches !== undefined ? { bonusInches: spec.bonusInches } : {}),
        ...(spec.cap !== undefined ? { hardCap: spec.cap } : {}),
      });
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform(ctx, state, op, params) {
      spec.before?.(ctx, state, op);
      return getAction(spec.delegate)!.perform(ctx, state, op, params);
    },
  };
}

/**
 * LOCUS › Expert Swordsman — "Whenever this operative ends the Fight action, if it's no longer
 * within control range of enemy operatives, it can immediately perform a free Charge action
 * (even if it's already performed the Charge action during that activation), but it cannot move
 * more than 3" during that action. Doing so doesn't prevent it from performing the Dash action
 * afterwards during that activation."
 *
 * Nothing runs at the end of an action, so the grant is offered as its own 0AP action for the
 * rest of the activation, gated on exactly the printed conditions. Its restriction key is its
 * own id and it carries no `treatedAs`, which is what makes both printed carve-outs work: it
 * can be taken after a Charge, and the universal Dash's `did(op, 'Charge')` test does not see it.
 */
registerAction(
  freeMove({
    id: CHARGE_SWORDSMAN,
    delegate: 'Charge',
    sourceText: abilityText(LOCUS, AB_SWORDSMAN),
    datacardId: LOCUS,
    cap: 3,
    bonusInches: 2,
    gate(ctx, state, op) {
      if (!op.actionsThisActivation.some((a) => a === 'Fight' || a === FIGHT_SWORDSMAN))
        return { ok: false, reason: 'this operative has not ended the Fight action this activation' };
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'still within control range of an enemy operative' };
      if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
      // Only "even if it's already performed the Charge action" is lifted; the universal
      // action's other restrictions still apply.
      if (['Reposition', 'Dash', 'Fall Back'].some((a) => op.actionsThisActivation.includes(a)))
        return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      return { ok: true };
    },
  }),
);

/**
 * LOCUS › Quicksilver Strike — the free Charge, taken on the LOCUS's own next activation (see
 * the `onActivationEnd` arming above). "you can change its order to do so", "it cannot move more
 * than 3"", and "it must end that move within control range of that enemy operative".
 */
registerAction({
  ...freeMove({
    id: CHARGE_QUICKSILVER,
    delegate: 'Charge',
    sourceText: abilityText(LOCUS, AB_QUICKSILVER),
    datacardId: LOCUS,
    cap: 3,
    bonusInches: 2,
    gate(ctx, state, op, params) {
      const mark = effectOn(state, op.id, E_QUICKSILVER);
      const enemyId = mark?.data?.['enemyId'];
      if (typeof enemyId !== 'string') return { ok: false, reason: 'Quicksilver Strike has not been triggered' };
      const enemy = state.operatives[enemyId];
      if (!enemy || enemy.removed) return { ok: false, reason: 'that enemy operative has left the killzone' };
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'already within control range of an enemy operative' };
      if (!params.path) return { ok: false, reason: 'no path supplied' };
      const v = validateMove(ctx, state, op, params.path, {
        action: 'Charge',
        bonusInches: 2,
        hardCap: 3,
        mayEnterEnemyControlRange: true,
        mustFinishEngaged: true,
      });
      if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
      const landed: OperativeState = { ...op, pos: v.endPos, z: v.endZ };
      if (!inControlRange(ctx, state, landed, enemy))
        return { ok: false, reason: 'it must end that move within control range of that enemy operative' };
      return { ok: true };
    },
    before(_ctx, state, op) {
      op.order = 'engage'; // "you can change its order to do so"
      dropEffects(state, (e) => e.rule === E_QUICKSILVER && e.operativeId === op.id);
      useOncePerTP(state, `wyrmblade.quicksilver:${op.id}`);
      log(state, { kind: 'action', player: op.player, text: `Quicksilver Strike: ${op.letter} interrupts and charges` });
    },
  }),
});

/**
 * SANCTUS TALON › Creeping Shadow — "This operative can perform the Charge action while it has a
 * Conceal order." The universal Charge refuses a Conceal order and `canPerformAction` can only
 * forbid, so the permission needs its own action (the Kommandos Throat Slittas precedent).
 */
registerAction({
  id: CHARGE_CREEPING,
  name: CHARGE_CREEPING,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(SANCTUS_TALON, AB_CREEPING),
  available: (_ctx, _state, op) => op.datacardId === SANCTUS_TALON,
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'already within control range of an enemy operative' };
    if (['Reposition', 'Dash', 'Fall Back'].some((a) => op.actionsThisActivation.includes(a)))
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Charge',
      bonusInches: 2,
      mayEnterEnemyControlRange: true,
      mustFinishEngaged: true,
    });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

/**
 * SANCTUS TALON › Creeping Shadow — "Whenever this operative performs the Fight action, it can
 * immediately perform a free Dash or Fall Back action afterwards (for the latter, it cannot move
 * more than 3"), even if it's performed an action that prevents it from performing those
 * actions." One of the two, once per activation.
 */
const creepingGate = (op: OperativeState): { ok: boolean; reason?: string } => {
  if (!op.actionsThisActivation.some((a) => a === 'Fight' || a === 'Hatchway Fight'))
    return { ok: false, reason: 'this operative has not performed the Fight action this activation' };
  if (op.actionsThisActivation.some((a) => a === DASH_CREEPING || a === FALL_BACK_CREEPING))
    return { ok: false, reason: 'Creeping Shadow grants one free Dash or Fall Back per activation' };
  return { ok: true };
};

registerAction(
  freeMove({
    id: DASH_CREEPING,
    delegate: 'Dash',
    sourceText: abilityText(SANCTUS_TALON, AB_CREEPING),
    datacardId: SANCTUS_TALON,
    gate(ctx, state, op) {
      const gate = creepingGate(op);
      if (!gate.ok) return gate;
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      return { ok: true };
    },
  }),
);
registerAction(
  freeMove({
    id: FALL_BACK_CREEPING,
    delegate: 'Fall Back',
    sourceText: abilityText(SANCTUS_TALON, AB_CREEPING),
    datacardId: SANCTUS_TALON,
    cap: 3,
    gate(ctx, state, op) {
      const gate = creepingGate(op);
      if (!gate.ok) return gate;
      if (enemiesInControlRange(ctx, state, op).length === 0)
        return { ok: false, reason: 'no enemy operative within control range' };
      return { ok: true };
    },
  }),
);

// ---------------------------------------------------------------------------

export const wyrmblade = defineTeam({
  id: 'wyrmblade',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy at the end of a friendly WYRMBLADE operative's activation… You
    //  cannot use this ploy for each friendly operative more than once per battle."
    [FP_SLINK]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player || active.order !== 'engage')
        return { ok: false, reason: 'only at the end of a friendly WYRMBLADE operative’s activation' };
      if (usedThisBattle(state, `wyrmblade.slink:${active.id}`))
        return { ok: false, reason: 'this ploy has already been used for that operative' };
      return { ok: true };
    },
    // "…when a friendly WYRMBLADE operative is shooting or fighting, after rolling your attack
    //  dice. If that friendly operative's order was changed from Conceal to Engage…" Declared in
    //  advance (see the retention handler), so the window is the whole activation up to its
    //  first Shoot or Fight.
    [FP_COILED]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'only during a friendly WYRMBLADE operative’s activation' };
      if (!orderFlipped(state, active.id))
        return { ok: false, reason: 'that operative’s order was not changed from Conceal to Engage' };
      if (active.actionsThisActivation.some(isShootOrFight) && !state.sequence)
        return { ok: false, reason: 'it has already performed the Shoot or Fight action this activation' };
      return { ok: true };
    },
    // "…when a friendly WYRMBLADE CULT AGENT or WYRMBLADE LEADER operative is selected as the
    //  valid target of a Shoot action…" Declared in advance, so the window is any moment a legal
    //  shielded/substitute pair exists. `usable` gets no GameContext, so the printed visibility
    //  test is left to `onSelectTarget`, which has one.
    [FP_LOYALTY]: (state, player) => {
      const T = makeTeamHooks(DATA, player);
      const shielded = T.friendlies(state, KW).filter((o) => T.kw(o, 'CULT AGENT') || T.kw(o, 'LEADER'));
      const ok = shielded.some((s) =>
        T.friendlies(state, KW).some(
          (o) => o.id !== s.id && T.kw(o, 'NEOPHYTE') && !T.kw(o, 'LEADER') && T.gap(o, s) <= 3 + EPS,
        ),
      );
      return ok
        ? { ok: true }
        : { ok: false, reason: 'no friendly NEOPHYTE is within 3" of a CULT AGENT or LEADER operative' };
    },
    // "…when a friendly WYRMBLADE NEOPHYTE operative is incapacitated."
    [FP_PLAN]: (state, player) =>
      aliveOperatives(state, player).some((o) => o.incapacitated)
        ? { ok: true }
        : { ok: false, reason: 'no friendly WYRMBLADE NEOPHYTE operative has just been incapacitated' },
  },
  aiHints: {
    roles: {
      [LEADER]: 'leader',
      [KELERMORPH]: 'gunner',
      [LOCUS]: 'melee',
      [GUNNER]: 'gunner',
      [HEAVY_GUNNER]: 'gunner',
      [ICON_BEARER]: 'objective',
      [SANCTUS_SNIPER]: 'sniper',
      [SANCTUS_TALON]: 'melee',
      [WARRIOR]: 'objective',
    },
    ployValue: {
      [SP_DAY]: 0.7,
      [SP_CROSSFIRE]: 0.6,
      [SP_SHADOWS]: 0.5,
      [SP_DIVERT]: 0.5,
      [FP_SLINK]: 0.4,
      [FP_COILED]: 0.7,
      [FP_LOYALTY]: 0.5,
      // Reminder-only (D-024): never worth CP to a bot.
      [FP_PLAN]: 0,
    },
    equipmentValue: {
      [EQ_BLASTING]: 0.7,
      [EQ_KNIVES]: 0.6,
      [EQ_TRAPS]: 0.3,
      [EQ_SPOTLIGHTS]: 0.5,
    },
  },
});

/** Re-exported so the tests can assert against the same helper the rules use. */
export { ployUsed, gambitUsed };

export default wyrmblade;
