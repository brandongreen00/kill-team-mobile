/**
 * MANDRAKES — Aeldari / Drukhari, the shadow-things of Aelindrach.
 * https://wahapedia.ru/kill-team3/kill-teams/mandrakes/
 *
 * Six datacards, four faction rules, eight datacard abilities, three unique actions.
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read from `data/teams/mandrakes.json` at module load and NEVER retyped. The one printed
 * structure with no id of its own — the BONE DARTS weapon's `WR` row, which the scraper left
 * as `rules: []` — is sliced out of the equipment text and parsed by the core parser (the
 * Elucidian PRIVATEER SUPPORT ASSETS precedent).
 *
 * Everything hangs off one predicate, `withinShadow` (the Within Shadow faction rule), which
 * eleven other rules read. It is the Nemesis Claw `inMidnightClad` shape plus the Shadeweaver's
 * Shadow Portal markers.
 *
 * Reminder-only / partial clauses (each is named next to the rule it belongs to, with the
 * engine reason; see docs/TEAM-STATUS.md):
 *  - NOWHERE TO HIDE's "can move through parts of terrain features as if they were not there"
 *    — `onMoveRules` is declared but never emitted and `MoveOptions` has no terrain-ignoring
 *    field, so the permission has no seam. The Charge cap it prints IS enforced.
 *  - Haunting Focus' whole activation interrupt ("you can activate this operative first…") —
 *    there is no activation-order seam (the Murderwing MALICIOUS NARCISSISM gap).
 *  - Harrowing Whispers' "your opponent cannot activate it during this activation" — the
 *    engine cannot refuse an activation, so it is −1 APL (the VISION OF MADNESS substitution).
 *  - CREEPING HORROR's "and ends that action WITHIN SHADOW" — no hook constrains where a move
 *    ENDS (`onMoveDistance` only caps the allowance).
 *  - INESCAPABLE NIGHTMARE's fighting/retaliating half — `fight.ts` emits no `onRollAttack`
 *    (docs/DECISIONS.md D-031).
 *  - Part Collector's "before it moves" — `canPerformAction` is a pure query the AI runs many
 *    times per activation, so the 2D3 lands at the end of the enemy's activation instead.
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { addAutoNormal } from '../../core/dice.ts';
import { baseGapToPoly, baseRadius, dist } from '../../core/geometry.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import {
  aliveOperatives,
  body,
  findProfile,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
  settleZ,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, hasType, pointDistanceToPart, surfaceAt } from '../../core/terrain.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
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
import { teamData, type TeamRuleText } from '../data.ts';
import {
  aplOf,
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  effectsOn,
  FREE_ACTION_RULE,
  gambitUsed,
  giveToken,
  grantFreeAction,
  grantedWeapons,
  hasEquipment,
  hasToken,
  makeTeamHooks,
  otherPlayer,
  placeTeamMarker,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('mandrakes');
const KW = 'MANDRAKE';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
export const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Datacards, rule ids and the names of the states the rules create
// ---------------------------------------------------------------------------

export const NIGHTFIEND = 'mandrakes.nightfiend';
export const ABYSSAL = 'mandrakes.abyssal';
export const CHOOSER = 'mandrakes.chooser-of-the-flesh';
export const DIRGEMAW = 'mandrakes.dirgemaw';
export const SHADEWEAVER = 'mandrakes.shadeweaver';
export const WARRIOR = 'mandrakes.warrior';

export const RULE = {
  soulstrike: 'mandrakes.rule.soulstrike',
  shadowPassage: 'mandrakes.rule.shadow-passage',
  umbralEntities: 'mandrakes.rule.umbral-entities',
  withinShadow: 'mandrakes.rule.within-shadow',
} as const;

export const SP = {
  creepingHorror: 'mandrakes.sp.creeping-horror',
  gloamingShroud: 'mandrakes.sp.gloaming-shroud',
  bladeInTheDark: 'mandrakes.sp.blade-in-the-dark',
  inescapableNightmare: 'mandrakes.sp.inescapable-nightmare',
} as const;

export const FP = {
  slitherOutOfSight: 'mandrakes.fp.slither-out-of-sight',
  soulFeast: 'mandrakes.fp.soul-feast',
  nowhereToHide: 'mandrakes.fp.nowhere-to-hide',
  shadowsBite: 'mandrakes.fp.shadows-bite',
} as const;

export const EQ = {
  chainSnare: 'mandrakes.eq.chain-snare',
  shadowGlyph: 'mandrakes.eq.shadow-glyph',
  soulGem: 'mandrakes.eq.soul-gem',
  boneDarts: 'mandrakes.eq.bone-darts',
} as const;

export const AB = {
  harrowingWhispers: 'mandrakes.nightfiend.harrowing-whispers',
  oubliex: 'mandrakes.nightfiend.oubliex',
  balefire: 'mandrakes.abyssal.balefire',
  soulHarvest: 'mandrakes.chooser-of-the-flesh.soul-harvest',
  partCollector: 'mandrakes.chooser-of-the-flesh.part-collector',
  hauntingFocus: 'mandrakes.dirgemaw.haunting-focus',
  shadowPortal: 'mandrakes.shadeweaver.shadow-portal',
  shadowWarrior: 'mandrakes.warrior.shadow-warrior',
} as const;

export const ACT = {
  wreatheInBalefire: 'mandrakes.abyssal.act.wreathe-in-balefire',
  pareidolicProjection: 'mandrakes.dirgemaw.act.pareidolic-projection',
  weaveDarkness: 'mandrakes.shadeweaver.act.weave-darkness',
} as const;

/** "…gains one of your Balefire tokens" — a token is an effect on the operative holding it. */
export const BALEFIRE_TOKEN = 'mandrakes.balefire';
/** "…it gains your Haunting Focus token." */
export const HAUNTING_TOKEN = 'mandrakes.hauntingFocus';
/** PAREIDOLIC PROJECTION's worsened Hit / −2" Move. */
export const PAREIDOLIC_EFFECT = 'mandrakes.pareidolicProjection';
/** SHADOW GLYPH armed on one operative until the start of its next activation. */
export const SHADOW_GLYPH_EFFECT = 'mandrakes.shadowGlyph';
/** "…it cannot: Perform the Shoot or Fight action until the start of the next turning point." */
export const PASSAGE_LOCK = 'mandrakes.shadowPassageLock';
/** Oubliex is active (readied, or it killed with its huskblade). */
export const OUBLIEX_ACTIVE = 'mandrakes.oubliexActive';
/** NOWHERE TO HIDE, armed on the active operative for the rest of its activation. */
export const NOWHERE_EFFECT = 'mandrakes.nowhereToHide';
/** SHADOW'S BITE, declared in advance and fired on its printed trigger. */
export const SHADOWS_BITE_EFFECT = 'mandrakes.shadowsBite';
/** GLOAMING SHROUD / SOUL GEM bookkeeping keys. */
const SOUL_GEM_SEQ = 'mandrakes.soulGemSeq';
const AUTO_RETAIN = 'mandrakes.autoRetain';
/** Soul Harvest points, per player. */
const SOUL_HARVEST_POINTS = 'mandrakes.soulHarvest';
/** The Soul Harvest "+1 APL until the end of the battle" grant, so the APL mod can be found. */
export const SOUL_HARVEST_APL = 'mandrakes.soulHarvestApl';
/** Snapshot of who is WITHIN SHADOW, for the ctx-free `PloyDef.usable` callbacks and the UI. */
const SHADOW_SNAPSHOT = 'mandrakes.withinShadow';
/** The last sequence in which friendly attack dice inflicted damage (SOUL FEAST). */
const SOUL_FEAST_RECORD = 'mandrakes.soulFeast';
/** Shadow Portal markers carry this flag so they are never confused with an op's markers. */
const PORTAL_FLAG = 'mandrakesShadowPortal';
/** Weave Darkness smoke markers carry this flag so the module owns their lifecycle. */
const WEAVE_FLAG = 'mandrakesWeaveDarkness';

export const SOUL_HARVEST_DECISION = 'mandrakes.soulHarvest';

export const SHADOW_PASSAGE_ACTION = 'Reposition (SHADOW PASSAGE)';
export const BLADE_IN_THE_DARK_CHARGE = 'Charge (BLADE IN THE DARK)';

const HAUNTING_GAMBIT = 'mandrakes.gambit.haunting-focus';

const BALEBLAST = 'baleblast';
const HUSKBLADE = 'huskblade';
const BALEBLADE = 'baleblade';
const GLIMMERSTEEL = 'glimmersteel blade';

// ---------------------------------------------------------------------------
// BONE DARTS — the printed weapon, with its `WR` row sliced out of the equipment text
// ---------------------------------------------------------------------------

const boneDartHolder = DATA.equipment.find((e) => e.id === EQ.boneDarts) as TeamRuleText & { weapons?: Weapon[] };

/**
 * "Once per turning point, a friendly MANDRAKE operative can use the following ranged weapon:
 *  Bone dart — ATK 4, HIT 3+, DMG 2/4, WR Range 6", Rending, Silent."
 *
 * The scraper captured the stat line into `equipment[].weapons` but left `rules: []`, so the
 * printed `WR` row is sliced out of the equipment text and parsed by the core parser. The
 * profile is cloned, never shared with the catalogue (docs/DECISIONS.md D-019).
 */
export const BONE_DART: Weapon = (() => {
  const table = boneDartHolder?.weapons ?? [];
  const printed = text(EQ.boneDarts);
  const w = table[0];
  if (!w) throw new Error(`No Bone dart weapon table in ${EQ.boneDarts}`);
  const after = printed.split(/\n\s*WR\s*\n/)[1];
  const line = (after ?? '').split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  const rules = parseWeaponRules(line);
  if (rules.length === 0) throw new Error(`Empty WR row for '${w.name}' in ${EQ.boneDarts}`);
  return { name: w.name, profiles: w.profiles.map((p) => ({ ...structuredClone(p), rules: structuredClone(rules) })) };
})();

const isBoneDart = (name: string): boolean => name.trim().toLowerCase() === BONE_DART.name.toLowerCase();

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? { shape: 'round', mm: 32 };

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

function d6(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d6() ?? 4;
  recordRoll(state, 'mandrakes', [roll], T.player, note);
  return roll;
}

function d3(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d3() ?? 2;
  recordRoll(state, 'mandrakes', [roll], T.player, note);
  return roll;
}

/** A positional copy of an operative, so a rule can ask a core query about a location. */
const probeAt = (op: OperativeState, pos: Vec2, z: number): OperativeState => ({ ...op, pos: { ...pos }, z });

/** "the same weapon", case-insensitively, the way every printed rule names one. */
const named = (weaponName: string, want: string): boolean => weaponName.trim().toLowerCase() === want;

// ---------------------------------------------------------------------------
// WITHIN SHADOW — the faction rule eleven other rules read
// ---------------------------------------------------------------------------

/** Your Shadow Portal markers (SHADEWEAVER › Shadow Portal). */
export function portalMarkers(state: GameState, player: PlayerId): MarkerState[] {
  return Object.values(state.markers)
    .filter((m) => m.flags[PORTAL_FLAG] === true && m.owner === player)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Within Shadow: "An operative is WITHIN SHADOW if any of the following are true:
 *  · It's within 1" of Heavy terrain that's not lower than it.
 *  · Any part of its base is underneath Vantage terrain.
 *  · A Shadow Portal marker is within its control range (see SHADEWEAVER)."
 *
 * The first two clauses are the Nemesis Claw `inMidnightClad` shape. The parts loop is
 * bounds-rejected first because this predicate is read from `onStatMod`, which every
 * `hitOf`/`moveOf`/`aplOf`/`saveOf` call emits.
 */
export function withinShadow(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
  at?: { pos: Vec2; z: number },
): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const pos = at?.pos ?? op.pos;
  const z = at?.z ?? op.z;
  const base = baseOf(T, op);
  const r = baseRadius(base);
  const reach = 1 + r;
  const index = terrain(ctx, state);
  // A round base's gap to a polygon is exactly (centre distance − radius), so the 32-sample
  // perimeter walk is only needed for the oval bases other kill teams field. This predicate is
  // read from `onStatMod`, which every hitOf/moveOf/aplOf/saveOf call emits, so it has to be
  // cheap; the bounds test rejects almost every part before any geometry runs.
  const gapTo = (part: (typeof index.parts)[number]): number =>
    base.shape === 'round'
      ? Math.max(0, pointDistanceToPart(pos, part) - r)
      : baseGapToPoly(pos, base, op.rot, part.poly);
  for (const part of index.parts) {
    if (
      pos.x < part.bounds.min.x - reach ||
      pos.x > part.bounds.max.x + reach ||
      pos.y < part.bounds.min.y - reach ||
      pos.y > part.bounds.max.y + reach
    )
      continue;
    // "It's within 1" of Heavy terrain that's not lower than it."
    if (hasType(part, 'Heavy') && part.z1 >= z - EPS && gapTo(part) <= 1 + EPS) return true;
    // "Any part of its base is underneath Vantage terrain."
    if (hasType(part, 'Vantage') && part.z0 > z + EPS && gapTo(part) <= EPS) return true;
  }
  // "A Shadow Portal marker is within its control range (see SHADEWEAVER)."
  const portals = portalMarkers(state, T.player);
  if (portals.length === 0) return false;
  const probe = at ? probeAt(op, pos, z) : op;
  return portals.some(
    (m) =>
      dist(pos, m.pos) <= 1 + baseRadius(base) + baseRadius({ shape: 'round', mm: m.diameterMm }) + EPS &&
      markerContestedBy(ctx, state, m, probe),
  );
}

/**
 * A snapshot of who is WITHIN SHADOW right now, refreshed at every activation boundary and in
 * the Ready step. `PloyDef.usable` is handed a `GameState` and no `GameContext`, so SLITHER OUT
 * OF SIGHT cannot run the geometry itself; the snapshot is taken at exactly the moment the ploy
 * is legal ("at the end of any operative's activation"). The UI reads it too.
 */
export function shadowSnapshot(state: GameState, player: PlayerId): Record<string, boolean> {
  return (bucket(state, SHADOW_SNAPSHOT)[player] ?? {}) as Record<string, boolean>;
}

function refreshShadow(T: TeamHooks, state: GameState): void {
  const out: Record<string, boolean> = {};
  for (const o of T.friendlies(state)) out[o.id] = withinShadow(T, state, o);
  bucket(state, SHADOW_SNAPSHOT)[T.player] = out;
}

// ---------------------------------------------------------------------------
// Placement — "in a location it can be placed" / "not a valid target"
// ---------------------------------------------------------------------------

function canBePlacedAt(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
): { ok: boolean; reason?: string; z?: number } {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const r = baseRadius(c.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, c.base, op.rot))
    return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, body(ctx, op).height))
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (dist(pos, other.pos) - r - baseRadius(oc.base) < -1e-4)
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true, z };
}

/**
 * "Be a valid target for an enemy operative." Every enemy's ranged weapon profiles are put
 * through the engine's own Select Valid Target check against a positional copy of the
 * operative, so the answer is exactly the one a shot would get.
 */
function validTargetForAnyEnemy(ctx: GameContext, state: GameState, probe: OperativeState): boolean {
  for (const foe of aliveOperatives(state, otherPlayer(probe.player))) {
    for (const w of weaponsOf(ctx, state, foe, 'ranged')) {
      for (const profile of w.profiles) {
        if (profile.type !== 'ranged') continue;
        const rules = effectiveRules(ctx, state, profile, { operative: foe, target: probe, weaponName: w.name });
        if (checkTarget(ctx, state, foe, probe, profile, rules).valid) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SHADOW PASSAGE — the shared legality both the action and Shadow Portal read
// ---------------------------------------------------------------------------

const passageTeamKey = (player: PlayerId): string => `mandrakes.passage:${player}`;
const passageOpKey = (op: OperativeState): string => `mandrakes.passage.op:${op.id}`;

/** Is one of your Shadow Portal markers within this operative's control range at `pos`? */
function portalInRange(T: TeamHooks, state: GameState, op: OperativeState, at?: { pos: Vec2; z: number }): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const probe = at ? probeAt(op, at.pos, at.z) : op;
  return portalMarkers(state, T.player).some((m) => markerContestedBy(ctx, state, m, probe));
}

/**
 * Shadow Passage: "Once per turning point, one friendly MANDRAKE operative WITHIN SHADOW can
 * use a SHADOW PASSAGE when it performs the Reposition action."
 *
 * Shadow Portal widens it: "Each friendly MANDRAKE operative can use a SHADOW PASSAGE each
 * turning point (taking precedence over one operative once per turning point) if one of your
 * Shadow Portal markers is within that operative's control range when it's removed, and the
 * other is when it's set up."
 */
export function passageAllowance(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
  dest?: { pos: Vec2; z: number },
): { ok: boolean; viaPortal: boolean; reason?: string } {
  if (usedThisTP(state, passageOpKey(op)))
    return { ok: false, viaPortal: false, reason: 'that operative has already used a SHADOW PASSAGE this turning point' };
  const portalHere = portalInRange(T, state, op);
  const portalThere = dest !== undefined && portalInRange(T, state, op, dest);
  if (portalHere && portalThere) return { ok: true, viaPortal: true };
  if (usedThisTP(state, passageTeamKey(T.player)))
    return { ok: false, viaPortal: false, reason: 'a SHADOW PASSAGE has already been used this turning point' };
  return { ok: true, viaPortal: false };
}

// ---------------------------------------------------------------------------
// Damage bookkeeping — which attack dice inflicted this damage
// ---------------------------------------------------------------------------

interface DamageDice {
  profile: WeaponProfile;
  weaponName: string;
  attacker: OperativeState;
  type: 'ranged' | 'melee';
  normals: number;
  crits: number;
}

/**
 * A shoot inflicts one aggregated total, a fight inflicts one attack dice at a time, so the
 * dice behind an `onDamage` call are reconstructed from the live sequence (the Warpcoven
 * `damageDice` precedent — `inflictDamage` always emits `onDamage` with `ctx: null`).
 */
function damageDice(ctx: GameContext | undefined, state: GameState, target: OperativeState, amount: number): DamageDice | undefined {
  if (!ctx) return undefined;
  const shoot = shootSeq(state);
  if (shoot) {
    if (shoot.targetId !== target.id) return undefined;
    const attacker = state.operatives[shoot.attackerId];
    if (!attacker) return undefined;
    const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === shoot.weaponName);
    const profile = w ? findProfile(w, shoot.profileName) : undefined;
    if (!profile) return undefined;
    return {
      profile,
      weaponName: shoot.weaponName,
      attacker,
      type: 'ranged',
      normals: shoot.attack.dice.filter((d) => d.state === 'normal').length,
      crits: shoot.attack.dice.filter((d) => d.state === 'crit').length,
    };
  }
  const fight = fightSeq(state);
  if (!fight) return undefined;
  if (target.id !== fight.defenderId && target.id !== fight.attackerId) return undefined;
  const strikerId = target.id === fight.defenderId ? fight.attackerId : fight.defenderId;
  const striker = state.operatives[strikerId];
  if (!striker) return undefined;
  const name = strikerId === fight.attackerId ? fight.attackerWeapon : (fight.defenderWeapon ?? '');
  const profileName = strikerId === fight.attackerId ? fight.attackerProfile : fight.defenderProfile;
  const melee = weaponsOf(ctx, state, striker, 'melee');
  const w = melee.find((x) => x.name === name) ?? melee[0];
  const profile = w ? (findProfile(w, profileName) ?? w.profiles[0]) : undefined;
  if (!profile || !w) return undefined;
  const crit = profile.dmgC !== profile.dmgN && amount >= profile.dmgC;
  const normal = !crit && amount >= profile.dmgN;
  return { profile, weaponName: w.name, attacker: striker, type: 'melee', normals: normal ? 1 : 0, crits: crit ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Within Shadow — the snapshot the ctx-free `usable` callbacks and the UI read
  // =========================================================================
  const snapshotBind = T.bind(RULE.withinShadow, 5);
  reg.on('onActivationStart', snapshotBind, (ev) => {
    if (!T.ctx) return;
    void ev.operative;
    refreshShadow(T, ev.state);
  });
  reg.on('onActivationEnd', snapshotBind, (ev) => {
    if (!T.ctx) return;
    void ev.operative;
    refreshShadow(T, ev.state);
  });
  reg.on('onReadyStep', snapshotBind, (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    refreshShadow(T, ev.state);
  });

  // =========================================================================
  // Soulstrike (faction rule AND this team's only rare weapon rule)
  // =========================================================================
  /*
   * "*Soulstrike: Successful defence dice are determined differently. Each result that's equal
   *  to or less than the target's APL stat is a success and is retained. Each result that's
   *  higher than the target's APL stat is a fail and is discarded. Each result of 1 is always a
   *  critical success. Each other success is a normal success. Each result of 6 is always a
   *  fail."
   *
   * `addRolled(seq.defence, results, save)` classifies against the Save stat and takes no
   * `ClassifyOpts`, so there is no seam at the roll. The `onDefenceDice` emit in the
   * `defenceRerolls` step is the first hook that sees the rolled pool (the Ratlings IMPROVISED
   * ARMOUR / Elucidian ARMOURED UNDERSUIT precedent) and it re-emits after every re-roll, so
   * the re-classification is applied to re-rolled dice too. It is idempotent: every die is
   * decided from its own face value. Cover saves are retained WITHOUT being rolled, so they are
   * not "results" and are left alone.
   *
   * The target's APL is read live, which is the printed Designer's Note ("the APL stat at the
   * time the rule takes effect (i.e. including changes)").
   */
  reg.on('onDefenceDice', T.bind(RULE.soulstrike, 8), (ev) => {
    if (!T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Soulstrike')) return;
    if (ev.ctx.attacker.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || seq.targetId !== target.id) return;
    const apl = aplOf(T.ctx, ev.state, target);
    let changed = 0;
    for (const die of seq.defence.dice) {
      if (!die.rolled) continue; // a cover save is retained without being rolled
      const want =
        die.value === 6 ? 'fail' : die.value === 1 ? 'crit' : die.value <= apl ? 'normal' : 'fail';
      if (die.state === 'discarded' || die.state === 'blocked' || die.state === 'struck') continue;
      if (die.state === want) continue;
      die.state = want;
      die.note = 'Soulstrike';
      changed++;
    }
    if (changed > 0)
      log(ev.state, {
        kind: 'dice',
        player: seq.defender,
        text: `Soulstrike: defence dice are successes on ${apl} or less (${changed} re-read)`,
      });
  });

  // =========================================================================
  // Umbral Entities
  // =========================================================================
  // "Whenever an operative is shooting a friendly MANDRAKE operative, ignore the Piercing
  //  weapon rule."
  reg.on('onWeaponRules', T.bind(RULE.umbralEntities, 10), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating) return;
    const target = ev.target;
    if (!target || !T.mineKw(target, KW)) return;
    if (!ev.rules.some((r) => r.id === 'Piercing' || r.id === 'PiercingCrits')) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing' && r.id !== 'PiercingCrits');
  });
  // "Whenever a friendly MANDRAKE operative is WITHIN SHADOW, improve its Save stat by 1."
  reg.on('onStatMod', T.bind(RULE.umbralEntities, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!withinShadow(T, ev.state, ev.operative)) return;
    ev.mods.save += 1;
  });

  // =========================================================================
  // Shadow Passage — the Shoot/Fight lock the set-up imposes
  // =========================================================================
  // "…it cannot: Perform the Shoot or Fight action until the start of the next turning point."
  reg.on('canPerformAction', T.bind(RULE.shadowPassage, 10), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, PASSAGE_LOCK)) return;
    const key = getAction(ev.action)?.treatedAs ?? ev.action;
    if (key !== 'Shoot' && key !== 'Fight') return;
    ev.allowed = false;
    ev.reason = 'SHADOW PASSAGE: it cannot Shoot or Fight until the start of the next turning point';
  });

  // =========================================================================
  // NIGHTFIEND › Harrowing Whispers
  // =========================================================================
  /*
   * "Whenever your opponent would activate an enemy operative within 6" of this operative, you
   *  can roll one D6 (you cannot do so if you already interrupted that operative's activation
   *  with this rule or the DIRGEMAW operative's Haunting Focus additional rule during this
   *  turning point): if the result is higher than that enemy operative's APL stat, your opponent
   *  cannot activate it during this activation. If there are no other enemy operatives eligible
   *  to be activated, this rule has no effect."
   *
   * PARTIAL: the engine cannot refuse an activation, so a successful roll costs the operative
   * 1 APL for the activation instead (the Hierotek VISION OF MADNESS substitution, also used by
   * Nemesis Claw's VOX SCREAM and the Sanctifiers' Commanding Declamation).
   */
  reg.on('onActivationStart', T.bind(AB.harrowingWhispers, 12), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    const foe = ev.operative;
    if (foe.player === T.player) return;
    // "you cannot do so if you already interrupted that operative's activation with this rule
    //  or the DIRGEMAW operative's Haunting Focus additional rule during this turning point"
    if (usedThisTP(ev.state, interruptKey(T, foe))) return;
    const nightfiend = T.friendlies(ev.state).find(
      (o) => o.datacardId === NIGHTFIEND && !o.incapacitated && T.gap(o, foe) <= 6 + EPS,
    );
    if (!nightfiend) return;
    // "If there are no other enemy operatives eligible to be activated, this rule has no effect."
    const others = aliveOperatives(ev.state, foe.player).filter((o) => o.id !== foe.id && o.ready);
    if (others.length === 0) return;
    const roll = d6(T, ev.state, `Harrowing Whispers vs ${foe.letter}`);
    if (roll <= aplOf(ctx, ev.state, foe)) return;
    useOncePerTP(ev.state, interruptKey(T, foe));
    foe.aplMods.push(-1);
    effect(ev.state, {
      rule: 'mandrakes.harrowingWhispers',
      source: { kind: 'ability', id: AB.harrowingWhispers },
      sourceText: shortQuote(abilityText(NIGHTFIEND, AB.harrowingWhispers)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: foe.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Harrowing Whispers stalls ${foe.letter} (${roll} beats APL ${aplOf(ctx, ev.state, foe) + 1}) — modelled as −1 APL`,
      data: { operativeId: foe.id, reminderOnly: 'the printed rule refuses the activation outright' },
    });
  });
  // The −1 APL is pushed onto `aplMods`, which nothing pops; the effect above marks it.
  reg.on('onActivationEnd', T.bind(AB.harrowingWhispers, 90), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, 'mandrakes.harrowingWhispers')) return;
    const at = ev.operative.aplMods.lastIndexOf(-1);
    if (at >= 0) ev.operative.aplMods.splice(at, 1);
  });

  // =========================================================================
  // NIGHTFIEND › Oubliex
  // =========================================================================
  // "Whenever this operative is readied, or if this operative incapacitates an enemy operative
  //  with its huskblade, its oubliex becomes active."
  reg.on('onReadyStep', T.bind(AB.oubliex, 12), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) {
      if (o.datacardId !== NIGHTFIEND) continue;
      armOubliex(T, ev.state, o);
    }
  });
  reg.on('onIncapacitated', T.bind(AB.oubliex, 12), (ev) => {
    if (ev.operative.player === T.player) return;
    const dice = damageDice(T.ctx, ev.state, ev.operative, 0);
    const killer = dice?.attacker;
    if (!killer || killer.player !== T.player || killer.datacardId !== NIGHTFIEND) return;
    if (!named(dice.weaponName, HUSKBLADE)) return;
    armOubliex(T, ev.state, killer);
  });
  /*
   * "Whenever its oubliex is active and an attack dice would inflict damage on this operative,
   *  you can roll one D6: on a 5+, ignore the damage inflicted from that attack dice and its
   *  oubliex is no longer active."
   *
   * D-022 policy: the roll is free but the charge is not, so it is spent only against an attack
   * dice worth 3+ damage or one that would incapacitate (the Sanctifiers SAINTLY RELICS policy).
   * A shoot inflicts one aggregated total, so exactly ONE attack dice's worth is removed from it
   * (the critical dice's damage where a crit is unblocked, otherwise the normal dice's).
   */
  reg.on('onDamage', T.bind(AB.oubliex, 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== NIGHTFIEND) return;
    if (!effectOn(ev.state, target.id, OUBLIEX_ACTIVE)) return;
    const dice = damageDice(T.ctx, ev.state, target, ev.amount);
    if (!dice) return;
    const oneDie = dice.crits > 0 ? dice.profile.dmgC : dice.profile.dmgN;
    if (oneDie <= 0) return;
    if (oneDie < 3 && ev.amount < target.wounds) return; // policy: save it for a real blow
    const roll = d6(T, ev.state, `Oubliex vs ${ev.amount} damage on ${target.letter}`);
    if (roll < 5) return;
    dropEffects(ev.state, (e) => e.rule === OUBLIEX_ACTIVE && e.operativeId === target.id);
    ev.amount = Math.max(0, ev.amount - oneDie);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Oubliex (${roll}): ${target.letter} ignores one attack dice's ${oneDie} damage; the oubliex is no longer active`,
      data: { operativeId: target.id },
    });
  });

  // =========================================================================
  // ABYSSAL › Balefire
  // =========================================================================
  /*
   * "Whenever a friendly MANDRAKE operative is shooting an enemy operative that has one of your
   *  Balefire tokens, add 1 to both Dmg stats of that friendly operative's ranged weapons and
   *  they have the Saturate weapon rule. Whenever an operative is shooting a friendly MANDRAKE
   *  operative that has one of your Balefire tokens, subtract 1 from both Dmg stats of that
   *  operative's ranged weapons (to a minimum of 1)."
   *
   * The Dmg change lands where the damage is inflicted, never by rewriting a shared
   * `WeaponProfile` (docs/DECISIONS.md D-019). A shoot aggregates its dice, so the change is
   * applied per unblocked attack dice.
   */
  reg.on('onWeaponRules', T.bind(AB.balefire, 12), (ev) => {
    if (ev.type !== 'ranged' || ev.retaliating) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const target = ev.target;
    if (!target || target.player === T.player) return;
    if (!hasToken(ev.state, target.id, BALEFIRE_TOKEN, T.player)) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Balefire)'));
  });
  reg.on('onDamage', T.bind(AB.balefire, 13), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    const dice = damageDice(T.ctx, ev.state, ev.target, ev.amount);
    if (!dice || dice.type !== 'ranged') return;
    const shots = dice.crits + dice.normals;
    if (shots <= 0) return;
    // "…a friendly MANDRAKE operative is shooting an enemy operative that has one of your
    //  Balefire tokens" — add 1 to both Dmg stats.
    if (
      dice.attacker.player === T.player &&
      T.kw(dice.attacker, KW) &&
      ev.target.player !== T.player &&
      hasToken(ev.state, ev.target.id, BALEFIRE_TOKEN, T.player)
    ) {
      ev.amount += shots;
      return;
    }
    // "…an operative is shooting a friendly MANDRAKE operative that has one of your Balefire
    //  tokens" — subtract 1 from both Dmg stats (to a minimum of 1).
    if (
      ev.target.player === T.player &&
      T.kw(ev.target, KW) &&
      hasToken(ev.state, ev.target.id, BALEFIRE_TOKEN, T.player) &&
      dice.attacker.player !== T.player
    ) {
      const softened = dice.crits * Math.max(1, dice.profile.dmgC - 1) + dice.normals * Math.max(1, dice.profile.dmgN - 1);
      const printed = dice.crits * dice.profile.dmgC + dice.normals * dice.profile.dmgN;
      ev.amount = Math.max(0, ev.amount - (printed - softened));
    }
  });

  // =========================================================================
  // CHOOSER OF THE FLESH › Soul Harvest + Part Collector
  // =========================================================================
  // "Whenever an enemy operative is incapacitated as a result of this operative's Part Collector
  //  rule or baleblade, you gain 1 Soul Harvest point, or two if that enemy operative had an APL
  //  stat of 3 or more."
  reg.on('onIncapacitated', T.bind(AB.soulHarvest, 12), (ev) => {
    const ctx = T.ctx;
    if (!ctx || ev.operative.player === T.player) return;
    const byPartCollector = Boolean(bucket(ev.state, 'mandrakes.partCollectorKill')[ev.operative.id]);
    const dice = damageDice(ctx, ev.state, ev.operative, 0);
    const byBaleblade =
      dice !== undefined &&
      dice.attacker.player === T.player &&
      dice.attacker.datacardId === CHOOSER &&
      named(dice.weaponName, BALEBLADE);
    if (!byPartCollector && !byBaleblade) return;
    const gain = aplOf(ctx, ev.state, ev.operative) >= 3 ? 2 : 1;
    setSoulHarvest(ev.state, T.player, soulHarvest(ev.state, T.player) + gain);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Soul Harvest: +${gain} point (${soulHarvest(ev.state, T.player)} held)`,
    });
  });
  // "Whenever a friendly MANDRAKE operative is activated, you can spend 1 of your Soul Harvest
  //  points to either add 1 to its APL stat until the end of the battle, or have it regain up to
  //  2D3 lost wounds. Note you can spend your Soul Harvest points even if this operative is
  //  incapacitated."
  reg.on('onActivationStart', T.bind(AB.soulHarvest, 13), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (soulHarvest(ev.state, T.player) < 1) return;
    if (ev.state.pending.some((p) => p.kind === SOUL_HARVEST_DECISION)) return;
    ev.state.pending.push({
      id: `soulHarvest-${ev.state.seq++}`,
      who: T.player,
      kind: SOUL_HARVEST_DECISION,
      prompt: `Soul Harvest: spend 1 point on ${ev.operative.letter}?`,
      optional: true,
      sourceText: shortQuote(abilityText(CHOOSER, AB.soulHarvest)),
      options: [
        { id: 'keep', label: 'Keep your Soul Harvest points', data: { operativeId: ev.operative.id } },
        { id: 'apl', label: '+1 APL until the end of the battle', data: { operativeId: ev.operative.id } },
        { id: 'wounds', label: 'Regain up to 2D3 lost wounds', data: { operativeId: ev.operative.id } },
      ],
    });
  });

  /*
   * Part Collector: "Whenever an enemy operative performs the Fall Back action while within
   *  control range of this operative, you can use this rule. If you do, inflict 2D3 damage on
   *  that enemy operative before it moves."
   *
   * PARTIAL: `canPerformAction` is a pure query the AI runs many times per activation and
   * `onActionCost` is emitted by `availableActions` too, so neither can carry a state change.
   * Whether the Fall Back happened is read exactly off `actionsThisActivation` at the end of the
   * enemy's activation, with the control-range test snapshotted at its activation START — the
   * bounded shift the Ratlings' Early Warning and the Nemesis Claw CHAIN SNARE both take.
   * "Before it moves" is therefore not honoured.
   */
  reg.on('onActivationStart', T.bind(AB.partCollector, 12), (ev) => {
    const ctx = T.ctx;
    if (!ctx || ev.operative.player === T.player) return;
    const collector = T.friendlies(ev.state).find(
      (o) => o.datacardId === CHOOSER && !o.incapacitated && inControlRange(ctx, ev.state, o, ev.operative),
    );
    const store = bucket(ev.state, 'mandrakes.partCollector') as Record<string, string | undefined>;
    if (collector) store[ev.operative.id] = collector.id;
    else delete store[ev.operative.id];
  });
  reg.on('onActivationEnd', T.bind(AB.partCollector, 12), (ev) => {
    const ctx = T.ctx;
    if (!ctx || ev.operative.player === T.player) return;
    const store = bucket(ev.state, 'mandrakes.partCollector') as Record<string, string | undefined>;
    const collectorId = store[ev.operative.id];
    delete store[ev.operative.id];
    if (!collectorId) return;
    const collector = ev.state.operatives[collectorId];
    if (!collector || collector.removed || collector.incapacitated) return;
    const fellBack = ev.operative.actionsThisActivation.some((a) => (getAction(a)?.treatedAs ?? a) === 'Fall Back');
    if (!fellBack || ev.operative.removed || ev.operative.incapacitated) return;
    const damage = d3(T, ev.state, 'Part Collector 2D3') + d3(T, ev.state, 'Part Collector 2D3');
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Part Collector: ${collector.letter} tears ${damage} from ${ev.operative.letter}`,
    });
    bucket(ev.state, 'mandrakes.partCollectorKill')[ev.operative.id] = true;
    inflictDamage(ctx, ev.state, ev.operative, damage, 'other');
    delete (bucket(ev.state, 'mandrakes.partCollectorKill') as Record<string, unknown>)[ev.operative.id];
  });

  // =========================================================================
  // DIRGEMAW › Haunting Focus (the gambit is registered in `gambits`)
  // =========================================================================
  // "Select one enemy operative. Until the Ready step of the next Strategy phase, it gains your
  //  Haunting Focus token."
  //
  // REMINDER-ONLY: everything after that sentence — "you can activate this operative first",
  // the forced shoot/fight target and "after completing this operative's activation, your
  // opponent activates that enemy operative" — hangs off interrupting the activation order, and
  // the engine has no activation-order seam (the Murderwing MALICIOUS NARCISSISM / SLICE THE
  // VEIL gap). No handler is registered for it.
  reg.on('onPloyUsed', T.bind(AB.hauntingFocus, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== HAUNTING_GAMBIT) return;
    const foes = T.enemies(ev.state).filter((o) => !o.incapacitated);
    const foe = chosenOperative(ev.state, ev.data, foes);
    if (!foe) return;
    dropEffects(ev.state, (e) => e.rule === HAUNTING_TOKEN && e.player === T.player);
    giveToken(ev.state, foe, HAUNTING_TOKEN, {
      sourceId: AB.hauntingFocus,
      sourceText: shortQuote(abilityText(DIRGEMAW, AB.hauntingFocus)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Haunting Focus marks ${foe.letter} (the activation interrupt is reminder-only)`,
      data: { operativeId: foe.id, reminderOnly: 'no activation-order seam' },
    });
  });

  // =========================================================================
  // SHADEWEAVER › Shadow Portal (the markers are placed by the SHADOW PASSAGE action)
  // =========================================================================
  // "If this operative is incapacitated, remove your Weave Darkness marker from the killzone."
  reg.on('onIncapacitated', T.bind(ACT.weaveDarkness, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== SHADEWEAVER) return;
    if (T.friendlies(ev.state).some((o) => o.datacardId === SHADEWEAVER && o.id !== ev.operative.id && !o.incapacitated))
      return;
    for (const m of weaveMarkers(ev.state, T.player)) removeMarker(ev.state, m.id);
  });
  // A Weave Darkness marker is a smoke marker the module owns: the universal Utility Grenades
  // module arms every un-armed smoke marker in the Ready step and deletes every armed one at the
  // end of the turning point, so the flags are reset here (priority 25, after its priority 10).
  reg.on('onReadyStep', T.bind(ACT.weaveDarkness, 25), (ev) => {
    if (ev.player !== T.player) return;
    for (const m of weaveMarkers(ev.state, T.player)) {
      m.flags['armed'] = false;
      m.flags['activationsLeft'] = 9999;
    }
  });
  // "…except you don't remove it during the following turning point."
  reg.on('onEndOfTP', T.bind(ACT.weaveDarkness, 25), (ev) => {
    for (const m of weaveMarkers(ev.state, T.player)) {
      const placed = Number(m.flags['placedTP'] ?? 0);
      if (ev.state.turningPoint > placed) removeMarker(ev.state, m.id);
    }
  });

  // =========================================================================
  // WARRIOR › Shadow Warrior
  // =========================================================================
  // "Whenever this operative is WITHIN SHADOW, add 1 to the Critical Dmg stat of its
  //  glimmersteel blade." A fight strikes one attack dice at a time, so the critical strike is
  //  identified by its printed Critical Dmg (the Death Korps Bruiser precedent; dmgN 4 and
  //  dmgC 5 are distinct on this weapon, so the two can always be told apart).
  reg.on('onDamage', T.bind(AB.shadowWarrior, 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    const dice = damageDice(T.ctx, ev.state, ev.target, ev.amount);
    if (!dice || dice.type !== 'melee' || dice.crits !== 1) return;
    const striker = dice.attacker;
    if (striker.player !== T.player || striker.datacardId !== WARRIOR) return;
    if (!named(dice.weaponName, GLIMMERSTEEL)) return;
    if (!withinShadow(T, ev.state, striker)) return;
    ev.amount += 1;
  });

  // =========================================================================
  // PAREIDOLIC PROJECTION — the stat changes its token carries
  // =========================================================================
  // "…worsen the Hit stat of that enemy operative's weapons by 1 and subtract 2" from its Move
  //  stat (these aren't cumulative with being injured)."
  reg.on('onStatMod', T.bindText(ACT.pareidolicProjection, actionText(DIRGEMAW, ACT.pareidolicProjection), 12), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, PAREIDOLIC_EFFECT);
    if (!eff || eff.player !== T.player) return;
    const card = T.card(ev.operative);
    if (card && ev.operative.wounds < card.wounds / 2) return; // already injured — not cumulative
    ev.mods.hit -= 1;
    ev.mods.move -= 2;
  });

  // =========================================================================
  // WREATHE IN BALEFIRE / PAREIDOLIC PROJECTION — "until the start of its next activation,
  // until it's incapacitated" (the actor's, not the token-holder's)
  // =========================================================================
  const clearProjections = (state: GameState, actor: OperativeState): void => {
    if (actor.datacardId === ABYSSAL)
      dropEffects(state, (e) => e.rule === BALEFIRE_TOKEN && e.player === T.player);
    if (actor.datacardId === DIRGEMAW)
      dropEffects(state, (e) => e.rule === PAREIDOLIC_EFFECT && e.player === T.player);
  };
  reg.on('onActivationStart', T.bindText('mandrakes.projections', abilityText(ABYSSAL, AB.balefire), 6), (ev) => {
    if (ev.operative.player !== T.player) return;
    clearProjections(ev.state, ev.operative);
  });
  reg.on('onIncapacitated', T.bindText('mandrakes.projections', abilityText(ABYSSAL, AB.balefire), 6), (ev) => {
    if (ev.operative.player !== T.player) return;
    clearProjections(ev.state, ev.operative);
  });

  // =========================================================================
  // SOUL FEAST bookkeeping — "the number of your attack dice that inflicted damage"
  // =========================================================================
  reg.on('onDamage', T.bindText('mandrakes.soulFeastRecord', text(FP.soulFeast), 70), (ev) => {
    const ctx = T.ctx;
    if (!ctx || ev.kind !== 'attack' || ev.amount <= 0) return;
    const dice = damageDice(ctx, ev.state, ev.target, ev.amount);
    if (!dice) return;
    const friendly = dice.attacker;
    if (friendly.player !== T.player || !T.kw(friendly, KW)) return;
    if (ev.target.player === T.player) return;
    const store = bucket(ev.state, SOUL_FEAST_RECORD) as Record<string, unknown>;
    const prev = store[T.player] as { friendlyId?: string; enemyId?: string; dice?: number } | undefined;
    const same = prev?.friendlyId === friendly.id && prev?.enemyId === ev.target.id;
    const count = dice.type === 'ranged' ? dice.crits + dice.normals : (same ? Number(prev?.dice ?? 0) : 0) + 1;
    store[T.player] = {
      friendlyId: friendly.id,
      enemyId: ev.target.id,
      dice: count,
      apl: aplOf(ctx, ev.state, ev.target),
      gap: T.gap(friendly, ev.target),
    };
  });
  const clearSoulFeast = (state: GameState): void => {
    delete (bucket(state, SOUL_FEAST_RECORD) as Record<string, unknown>)[T.player];
  };
  reg.on('onActivationEnd', T.bindText('mandrakes.soulFeastRecord', text(FP.soulFeast), 91), (ev) => {
    void ev.operative;
    clearSoulFeast(ev.state);
  });
  reg.on('onEndOfTP', T.bindText('mandrakes.soulFeastRecord', text(FP.soulFeast), 91), (ev) => {
    clearSoulFeast(ev.state);
  });
}

const interruptKey = (T: TeamHooks, foe: OperativeState): string => `mandrakes.interrupt:${T.player}:${foe.id}`;

function armOubliex(T: TeamHooks, state: GameState, op: OperativeState): void {
  if (effectOn(state, op.id, OUBLIEX_ACTIVE)) return;
  effect(state, {
    rule: OUBLIEX_ACTIVE,
    source: { kind: 'ability', id: AB.oubliex },
    sourceText: shortQuote(abilityText(NIGHTFIEND, AB.oubliex)),
    operativeId: op.id,
    player: T.player,
    expiry: { kind: 'endOfBattle' },
  });
}

export function soulHarvest(state: GameState, player: PlayerId): number {
  return Number((state.opState[SOUL_HARVEST_POINTS] as Record<string, unknown> | undefined)?.[player] ?? 0);
}
function setSoulHarvest(state: GameState, player: PlayerId, n: number): void {
  bucket(state, SOUL_HARVEST_POINTS)[player] = Math.max(0, n);
}

function weaveMarkers(state: GameState, player: PlayerId): MarkerState[] {
  return Object.values(state.markers).filter((m) => m.flags[WEAVE_FLAG] === true && m.owner === player);
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // CREEPING HORROR (strategy)
  // =========================================================================
  /*
   * "After each enemy operative's activation, before the next operative is activated, one
   *  friendly MANDRAKE operative that has a Conceal order can perform a free Dash action if it
   *  starts and ends that action WITHIN SHADOW. You cannot use this ploy during the first
   *  turning point, and you cannot select each friendly operative for this ploy more than once
   *  per turning point."
   *
   * The free Dash is one AP outside that operative's APL budget (docs/DECISIONS.md D-100),
   * restricted to Dash and landing on its next activation — the ploy fires between activations,
   * so the recipient is never the operative on the board clock. PARTIAL — "and ends that action
   * WITHIN SHADOW" has no seam (no hook constrains where a move ENDS); the predicate is exported
   * as `creepingHorrorEndLegal` for the UI.
   */
  reg.on('onActivationEnd', T.bind(SP.creepingHorror, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.creepingHorror)) return;
    if (ev.operative.player === T.player) return;
    if (ev.state.turningPoint < 2) return;
    const candidate = T.friendlies(ev.state, KW)
      .filter((o) => o.order === 'conceal' && !o.incapacitated)
      .filter((o) => !usedThisTP(ev.state, `mandrakes.creeping:${o.id}`))
      .filter((o) => currentApl(T, ev.state, o) >= 1)
      .filter((o) => withinShadow(T, ev.state, o))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!candidate) return;
    useOncePerTP(ev.state, `mandrakes.creeping:${candidate.id}`);
    grantFreeAction(ev.state, candidate, {
      sourceId: SP.creepingHorror,
      sourceText: shortQuote(text(SP.creepingHorror)),
      threshold: currentApl(T, ev.state, candidate),
      only: ['Dash'],
    });
  });
  // The free AP expires with the activation it is spent in, which the core does by itself. But
  // this offer is made to an operative that is standing still between two activations, and one
  // that is already expended never ends another activation this turning point — so nothing
  // would take the AP back and it would still be there next turning point, long after "before
  // the next operative is activated". The Ready step is where that window closes.
  const dropStaleGrants = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (eff.source.id !== SP.creepingHorror) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bind(SP.creepingHorror, 92), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) dropStaleGrants(ev.state, o);
  });

  // =========================================================================
  // GLOAMING SHROUD (strategy)
  // =========================================================================
  /*
   * "Whenever an operative is shooting a friendly MANDRAKE operative that's WITHIN SHADOW, you
   *  can retain one of your defence dice as a normal success without rolling it (in addition to
   *  a cover save, if any)."
   *
   * There is no defence-retention hook, so one die fewer is rolled at the Roll Defence Dice step
   * and the retained die is pushed into the pool at the post-roll emit (the Elucidian ARMOURED
   * UNDERSUIT / Exodite precedent).
   */
  reg.on('onDefenceDice', T.bind(SP.gloamingShroud, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.gloamingShroud)) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id) return;
    if (!withinShadow(T, ev.state, target)) return;
    const key = `${T.player}:${target.id}`;
    const stamp = `${seq.attackerId}:${seq.targetId}:${seq.resolvedTargets.length}`;
    const b = bucket(ev.state, AUTO_RETAIN) as Record<string, string>;
    if (seq.step === 'rollDefence') {
      if (b[key] === stamp) return;
      ev.count = Math.max(0, ev.count - 1);
      return;
    }
    if (seq.step !== 'defenceRerolls' || b[key] === stamp) return;
    b[key] = stamp;
    addAutoNormal(seq.defence, 1, 'GLOAMING SHROUD');
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `GLOAMING SHROUD: ${target.letter} retains one defence dice as a normal success without rolling it`,
    });
  });

  // =========================================================================
  // BLADE IN THE DARK (strategy) — the Conceal-order Charge is its own ActionDef (D-021)
  // =========================================================================

  // =========================================================================
  // INESCAPABLE NIGHTMARE (strategy)
  // =========================================================================
  /*
   * "Whenever a friendly MANDRAKE operative is shooting, fighting or retaliating, if it's
   *  WITHIN SHADOW, you can re-roll one of your attack dice."
   *
   * PARTIAL: `fight.ts` builds its re-roll grants from Balanced/Ceaseless/Relentless plus the
   * Command Re-roll and emits no `onRollAttack` at all (docs/DECISIONS.md D-031), so the
   * fighting and retaliating halves are unreachable. Shooting is exact.
   */
  reg.on('onRollAttack', T.bind(SP.inescapableNightmare, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.inescapableNightmare)) return;
    const shooter = ev.ctx.attacker;
    if (!T.mineKw(shooter, KW)) return;
    if (!withinShadow(T, ev.state, shooter)) return;
    const grant: RerollGrant = {
      id: 'mandrakes.inescapableNightmare',
      label: 'INESCAPABLE NIGHTMARE: re-roll one of your attack dice',
      mode: 'one',
      max: 1,
      sourceText: shortQuote(text(SP.inescapableNightmare)),
      player: T.player,
    };
    ev.rerolls.push(grant);
  });

  // =========================================================================
  // SLITHER OUT OF SIGHT (firefight)
  // =========================================================================
  // "Use this firefight ploy at the end of any operative's activation. Select one friendly
  //  MANDRAKE operative that has an Engage order and is WITHIN SHADOW. Change that operative's
  //  order to Conceal."
  reg.on('onPloyUsed', T.bind(FP.slitherOutOfSight, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.slitherOutOfSight) return;
    const candidates = T.friendlies(ev.state, KW)
      .filter((o) => o.order === 'engage' && !o.incapacitated)
      .filter((o) => withinShadow(T, ev.state, o));
    const pick = chosenOperative(ev.state, ev.data, candidates);
    if (!pick) {
      // The `usable` guard reads a snapshot taken at the last activation boundary; if the
      // geometry has moved on, the CP is handed back (the Murderwing MURDEROUS DESCENT
      // precedent). The ploy stays in `ploysUsedTP` so it can never be retried in a loop.
      ev.state.teams[T.player].cp += 1;
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: 'SLITHER OUT OF SIGHT: no friendly MANDRAKE operative with an Engage order is WITHIN SHADOW — 1CP refunded',
      });
      return;
    }
    pick.order = 'conceal';
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `SLITHER OUT OF SIGHT: ${pick.letter} changes its order to Conceal`,
      data: { operativeId: pick.id },
    });
  });

  // =========================================================================
  // SOUL FEAST (firefight)
  // =========================================================================
  // "That friendly operative regains a number of lost wounds equal to that enemy operative's APL
  //  stat, multiplied by the number of your attack dice that inflicted damage during that
  //  sequence."
  reg.on('onPloyUsed', T.bind(FP.soulFeast, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.soulFeast) return;
    const rec = soulFeastRecord(ev.state, T.player);
    if (!rec) return;
    const op = ev.state.operatives[rec.friendlyId];
    const card = op ? T.card(op) : undefined;
    if (!op || !card || op.incapacitated || op.removed) return;
    const heal = Math.min(card.wounds - op.wounds, rec.apl * rec.dice);
    if (heal <= 0) return;
    op.wounds += heal;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `SOUL FEAST: ${op.letter} regains ${heal} lost wounds (APL ${rec.apl} × ${rec.dice} attack dice)`,
      data: { operativeId: op.id },
    });
  });

  // =========================================================================
  // NOWHERE TO HIDE (firefight)
  // =========================================================================
  /*
   * "Until the end of that activation, that operative can move through parts of terrain features
   *  as if they were not there, but it cannot move more than its Move stat if it's the Charge
   *  action and must end those moves in a location it can be placed."
   *
   * REMINDER-ONLY (the permission): `onMoveRules` is declared but NEVER emitted, and
   * `MoveOptions` has no terrain-ignoring field at all, so nothing in the engine can let a move
   * pass through terrain. The effect is recorded on the operative so the UI can show it and a
   * human can resolve the move by hand, and the ONE clause the engine can hold — the Charge cap
   * — is enforced through `onMoveDistance`. `aiHints.ployValue` is 0, so the AI never spends CP
   * on a ploy whose benefit it cannot use.
   */
  reg.on('onPloyUsed', T.bind(FP.nowhereToHide, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.nowhereToHide) return;
    const id = ev.state.activeOperativeId;
    const op = id ? ev.state.operatives[id] : undefined;
    if (!op || !T.mineKw(op, KW)) return;
    effect(ev.state, {
      rule: NOWHERE_EFFECT,
      source: { kind: 'ploy', id: FP.nowhereToHide },
      sourceText: shortQuote(text(FP.nowhereToHide)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `NOWHERE TO HIDE: ${op.letter} may move through terrain (resolve by hand — no engine seam)`,
      data: { operativeId: op.id, reminderOnly: 'onMoveRules is never emitted' },
    });
  });
  reg.on('onMoveDistance', T.bind(FP.nowhereToHide, 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, NOWHERE_EFFECT)) return;
    if ((getAction(ev.action)?.treatedAs ?? ev.action) !== 'Charge') return;
    const card = T.card(ev.operative);
    if (!card) return;
    ev.inches = Math.min(ev.inches, card.move); // "it cannot move more than its Move stat"
  });

  // =========================================================================
  // SHADOW'S BITE (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy when an enemy operative performs the Fight action during an
   *  activation in which it performed the Charge action, and selects a friendly MANDRAKE
   *  operative WITHIN SHADOW to fight against. In the Resolve Attack Dice step of that sequence,
   *  you resolve the first attack dice (i.e. defender instead of attacker)."
   *
   * `advanceFight` runs a whole fight inside the Fight action unless a decision pauses it, so a
   * reactive `UsePloy` can rarely land mid-sequence. The ploy is therefore DECLARED IN ADVANCE
   * and fires on its printed trigger (the Celestian GLORIOUS MARTYRDOM / BLAZING INFERNO shape):
   * it arms for the turning point and flips `seq.turn` as the defender's pool is collected —
   * the same flip the Exaction Squad's Repress uses.
   */
  reg.on('onPloyUsed', T.bind(FP.shadowsBite, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.shadowsBite) return;
    effect(ev.state, {
      rule: SHADOWS_BITE_EFFECT,
      source: { kind: 'ploy', id: FP.shadowsBite },
      sourceText: shortQuote(text(FP.shadowsBite)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onCollectAttackDice', T.bind(FP.shadowsBite, 20), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    if (!effectFor(ev.state, T.player, SHADOWS_BITE_EFFECT)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.turn === 'defender') return;
    const attacker = ev.state.operatives[seq.attackerId];
    const defender = ev.state.operatives[seq.defenderId];
    if (!attacker || !defender) return;
    if (attacker.player === T.player || !T.mineKw(defender, KW)) return;
    if (!attacker.actionsThisActivation.some((a) => (getAction(a)?.treatedAs ?? a) === 'Charge')) return;
    if (!withinShadow(T, ev.state, defender)) return;
    seq.turn = 'defender';
    dropEffects(ev.state, (e) => e.rule === SHADOWS_BITE_EFFECT && e.player === T.player);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `SHADOW'S BITE: ${defender.letter} resolves the first attack dice`,
      data: { operativeId: defender.id },
    });
  });
}

interface SoulFeastRecord {
  friendlyId: string;
  enemyId: string;
  dice: number;
  apl: number;
  gap: number;
}

export function soulFeastRecord(state: GameState, player: PlayerId): SoulFeastRecord | undefined {
  const rec = (state.opState[SOUL_FEAST_RECORD] as Record<string, unknown> | undefined)?.[player] as
    | SoulFeastRecord
    | undefined;
  return rec && rec.dice > 0 ? rec : undefined;
}

/**
 * CREEPING HORROR's unenforceable half: "if it starts AND ENDS that action WITHIN SHADOW".
 * Exported so the UI can grey out an illegal destination; no hook constrains where a move ends.
 */
export function creepingHorrorEndLegal(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
  dest: Vec2,
): boolean {
  if (!T.ctx) return true;
  const z = surfaceAt(terrain(T.ctx, state), dest);
  return withinShadow(T, state, op, { pos: dest, z });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // CHAIN SNARE
  // =========================================================================
  /*
   * "Whenever an enemy operative would perform the Fall Back action while within control range
   *  of a friendly MANDRAKE operative, if no other enemy operatives are within that friendly
   *  operative's control range, you can use this rule. If you do, roll two D6, or one D6 if that
   *  enemy operative has a higher Wounds stat than that friendly operative. If any result is a
   *  4+, that enemy operative cannot perform that action during that activation/counteraction
   *  (no AP are spent on it), and you cannot use this rule again during this turning point."
   *
   * `canPerformAction` is a pure query the AI runs many times per activation, so the roll is
   * made at the start of the enemy's activation and the ban is then enforced through
   * `canPerformAction` (the Nemesis Claw CHAIN SNARE precedent — the same printed rule).
   */
  reg.on('onActivationStart', T.bind(EQ.chainSnare, 30), (ev) => {
    const ctx = T.ctx;
    if (!ctx || !hasEquipment(ev.state, T.player, EQ.chainSnare)) return;
    if (ev.operative.player === T.player) return;
    if (usedThisTP(ev.state, `mandrakes.chainSnare:${T.player}`)) return;
    const foe = ev.operative;
    const snarer = T.friendlies(ev.state, KW).find(
      (o) =>
        !o.incapacitated &&
        inControlRange(ctx, ev.state, o, foe) &&
        T.enemies(ev.state).every((e) => e.id === foe.id || !inControlRange(ctx, ev.state, o, e)),
    );
    if (!snarer) return;
    const dice = (T.card(foe)?.wounds ?? 0) > (T.card(snarer)?.wounds ?? 0) ? 1 : 2;
    const results: number[] = [];
    for (let i = 0; i < dice; i++) results.push(ctx.rng.d6());
    recordRoll(ev.state, 'chainSnare', results, T.player, `CHAIN SNARE ${dice}D6 vs ${foe.letter}`);
    if (!results.some((r) => r >= 4)) return;
    bucket(ev.state, 'mandrakes.chainSnare')[`${foe.id}:tp${ev.state.turningPoint}`] = true;
    useOncePerTP(ev.state, `mandrakes.chainSnare:${T.player}`);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `CHAIN SNARE bites into ${foe.letter} — it cannot Fall Back during this activation`,
    });
  });
  reg.on('canPerformAction', T.bind(EQ.chainSnare, 30), (ev) => {
    if ((getAction(ev.action)?.treatedAs ?? ev.action) !== 'Fall Back') return;
    const snared = (ev.state.opState['mandrakes.chainSnare'] ?? {}) as Record<string, unknown>;
    if (snared[`${ev.operative.id}:tp${ev.state.turningPoint}`] !== true) return;
    ev.allowed = false;
    ev.reason = 'CHAIN SNARE: that operative cannot Fall Back during this activation';
  });

  // =========================================================================
  // SHADOW GLYPH
  // =========================================================================
  /*
   * "Once per turning point, when a friendly MANDRAKE operative is activated WITHIN SHADOW, you
   *  can use this rule. If you do, until the start of its next activation, while that operative
   *  has a Conceal order and is in cover, it cannot be selected as a valid target, taking
   *  precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"."
   *
   * D-022: the rule is free, so it is auto-used on the first qualifying activation of each
   * turning point and logged.
   */
  reg.on('onActivationStart', T.bind(EQ.shadowGlyph, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.shadowGlyph)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW)) return;
    dropEffects(ev.state, (e) => e.rule === SHADOW_GLYPH_EFFECT && e.operativeId === op.id);
    if (!withinShadow(T, ev.state, op)) return;
    if (!useOncePerTP(ev.state, `mandrakes.shadowGlyph:${T.player}`)) return;
    effect(ev.state, {
      rule: SHADOW_GLYPH_EFFECT,
      source: { kind: 'equipment', id: EQ.shadowGlyph },
      sourceText: shortQuote(text(EQ.shadowGlyph)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `SHADOW GLYPH: ${op.letter} fades from sight until the start of its next activation`,
      data: { operativeId: op.id },
    });
  });
  reg.on('onValidTarget', T.bind(EQ.shadowGlyph, 31), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    const target = ev.target;
    if (target.player !== T.player || !effectOn(ev.state, target.id, SHADOW_GLYPH_EFFECT)) return;
    if (target.order !== 'conceal') return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    // "while that operative … is in cover" — recomputed with the default options, because the
    // rule takes precedence over Seek and Vantage.
    const view = ev.viewFrom ?? ev.attacker;
    const cover = coverFrom(ctx, ev.state, view, target);
    if (!cover) return;
    ev.valid = false;
    ev.reason = 'SHADOW GLYPH: it has a Conceal order and is in cover';
  });

  // =========================================================================
  // SOUL GEM
  // =========================================================================
  /*
   * "Once per turning point, when a friendly MANDRAKE operative is performing the Shoot action
   *  and you select a baleblast, you can use this rule. If you do, until the end of that action,
   *  that weapon has the Blast 1" weapon rule."
   *
   * `startShoot` computes the weapon's effective rules BEFORE it emits `onSelectWeapon`, and the
   * Blast footprint is read off that snapshot, so the grant has to live in `onWeaponRules`; the
   * once-per-turning-point allowance is claimed in the real (non-dry-run) `onSelectWeapon` emit.
   *
   * D-022 policy, because a weapon-rule read cannot raise a decision and Blast catches FRIENDLY
   * operatives too: it is used only when the target has at least one other ENEMY operative
   * within 1" and visible to it, and no friendly operative in that footprint.
   *
   * The armed effect expires at the end of the ACTIVATION rather than at the end of the action —
   * nothing runs at the end of an action — which is the same thing in practice, because action
   * restrictions allow one Shoot action per activation and this team registers no second one.
   */
  reg.on('onWeaponRules', T.bind(EQ.soulGem, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.soulGem)) return;
    if (ev.type !== 'ranged' || !named(ev.weaponName, BALEBLAST)) return;
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    const armed = effectOn(ev.state, ev.operative.id, SOUL_GEM_SEQ);
    if (!armed && usedThisTP(ev.state, `mandrakes.soulGem:${T.player}`)) return;
    if (!armed && !soulGemHelps(T, ev.state, ev.operative, ev.target)) return;
    ev.rules.push(ruleTag('Blast', 1, 'Blast 1" (SOUL GEM)'));
  });
  reg.on('onSelectWeapon', T.bind(EQ.soulGem, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a query the AI runs many times per turn (D-032)
    if (!hasEquipment(ev.state, T.player, EQ.soulGem)) return;
    const shooter = ev.ctx.attacker;
    const target = ev.ctx.defender;
    if (!T.mineKw(shooter, KW) || !target) return;
    if (!named(ev.ctx.weaponName, BALEBLAST)) return;
    if (!soulGemHelps(T, ev.state, shooter, target)) return;
    if (!useOncePerTP(ev.state, `mandrakes.soulGem:${T.player}`)) return;
    effect(ev.state, {
      rule: SOUL_GEM_SEQ,
      source: { kind: 'equipment', id: EQ.soulGem },
      sourceText: shortQuote(text(EQ.soulGem)),
      operativeId: shooter.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: shooter.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `SOUL GEM: ${shooter.letter}'s baleblast has Blast 1" until the end of this action`,
      data: { operativeId: shooter.id },
    });
  });

  // =========================================================================
  // BONE DARTS
  // =========================================================================
  // "Once per turning point, a friendly MANDRAKE operative can use the following ranged weapon:
  //  Bone dart — ATK 4, HIT 3+, DMG 2/4, Range 6", Rending, Silent."
  //
  // `weaponsOf` reads `grantedWeapons` AFTER `availableWeapons`, so the granted set is kept
  // equal to exactly the legal one on every read (the Elucidian PRIVATEER SUPPORT ASSETS shape):
  // the UI, the AI's shot plans and `startShoot` can then never disagree.
  reg.on('availableWeapons', T.bind(EQ.boneDarts, 30), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
    const has = grantedWeapons(op).some((w) => isBoneDart(w.name));
    const seq = shootSeq(ev.state);
    const inFlight = seq?.attackerId === op.id && isBoneDart(seq.weaponName);
    const want =
      hasEquipment(ev.state, T.player, EQ.boneDarts) &&
      T.kw(op, KW) &&
      !op.incapacitated &&
      (inFlight || !usedThisTP(ev.state, `mandrakes.boneDarts:${T.player}`));
    // A fresh array is always assigned, never mutated in place, because the AI evaluates
    // hypothetical positions on a spread copy of the operative (the Elucidian note).
    if (want && !has) holder.grantedWeapons = [...grantedWeapons(op), structuredClone(BONE_DART)];
    else if (!want && has) holder.grantedWeapons = grantedWeapons(op).filter((w) => !isBoneDart(w.name));
  });
  reg.on('onSelectWeapon', T.bind(EQ.boneDarts, 30), (ev) => {
    if (!isBoneDart(ev.ctx.weaponName)) return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ.boneDarts)) {
      ev.allowed = false;
      ev.reason = 'your kill team has not selected BONE DARTS';
      return;
    }
    if (usedThisTP(ev.state, `mandrakes.boneDarts:${T.player}`)) {
      ev.allowed = false;
      ev.reason = 'a Bone dart can only be used once per turning point';
      return;
    }
    if (ev.dryRun) return; // D-032: a `check` must not mutate
    useOncePerTP(ev.state, `mandrakes.boneDarts:${T.player}`);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `BONE DARTS: ${ev.ctx.attacker.letter} throws this turning point's bone dart`,
    });
  });
}

/**
 * Cover from a viewer, computed with the DEFAULT options — which is exactly what "taking
 * precedence over all other rules (e.g. Seek, Vantage terrain)" means (the Ratlings SHIFTY
 * precedent).
 */
function coverFrom(ctx: GameContext, state: GameState, viewer: OperativeState, target: OperativeState): boolean {
  return coverAndObscured(terrain(ctx, state), body(ctx, viewer), body(ctx, target)).inCover;
}

/**
 * SOUL GEM's stated auto-use policy (D-022): Blast catches every operative near the target,
 * friendly ones included, so the gem is spent only when the footprint holds another ENEMY
 * operative and no friendly one.
 */
function soulGemHelps(T: TeamHooks, state: GameState, shooter: OperativeState, target: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx) return false;
  const index = terrain(ctx, state);
  let enemies = 0;
  for (const o of aliveOperatives(state)) {
    if (o.id === target.id || o.id === shooter.id) continue;
    if (T.gap(target, o) > 1 + EPS) continue;
    if (!isVisible(index, body(ctx, target), body(ctx, o)).visible) continue;
    if (o.player === shooter.player) return false;
    enemies++;
  }
  return enemies > 0;
}

// ---------------------------------------------------------------------------
// STRATEGIC GAMBITs
// ---------------------------------------------------------------------------

function gambits(reg: HookRegistry, T: TeamHooks): void {
  for (const ploy of T.data.strategyPloys) {
    reg.on('gambitOptions', T.bind(ploy.id, 20), (ev) => {
      if (ev.player !== T.player) return;
      if (ev.state.teams[T.player].cp < ploy.cp) return;
      // "You cannot use this ploy during the first turning point." (CREEPING HORROR)
      if (ploy.id === SP.creepingHorror && ev.state.turningPoint < 2) return;
      ev.options.push({ id: ploy.id, label: `${ploy.name} (${ploy.cp}CP)`, sourceText: shortQuote(ploy.text) });
    });
  }
  // DIRGEMAW › Haunting Focus is printed "STRATEGIC GAMBIT." on the datacard, not as one of the
  // four strategy ploys, so it is its own 0CP gambit (the Sanctifiers Ministorum Sermon shape).
  reg.on('gambitOptions', T.bind(AB.hauntingFocus, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === DIRGEMAW && !o.incapacitated)) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: HAUNTING_GAMBIT,
      label: 'Haunting Focus',
      sourceText: shortQuote(abilityText(DIRGEMAW, AB.hauntingFocus)),
    });
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function actions(data: typeof DATA): ActionDef[] {
  const defs: ActionDef[] = [];

  // =========================================================================
  // Reposition (SHADOW PASSAGE) — docs/DECISIONS.md D-021
  // =========================================================================
  /*
   * "…can use a SHADOW PASSAGE when it performs the Reposition action. If it does, don't move
   *  it. Instead, remove it from the killzone and set it back up WITHIN SHADOW in a location it
   *  can be placed. When you set it back up, it cannot: be within control range of an enemy
   *  operative; be a valid target for an enemy operative; perform the Shoot or Fight action
   *  until the start of the next turning point."
   *
   * The universal Reposition takes a `path`, so this cannot delegate to it: the passage is a
   * remove-and-set-up, and its destination comes from `params.targetPos`. `src/ai/legal.ts`
   * only ever offers `targetPos = op.pos` for a non-move action id, which the "select a
   * different location" test refuses, so the AI never uses it — D-021's stated consequence.
   */
  defs.push({
    id: SHADOW_PASSAGE_ACTION,
    name: SHADOW_PASSAGE_ACTION,
    ap: 1,
    type: 'unique',
    treatedAs: 'Reposition',
    sourceText: `${passageRule(data).name}: ${passageRule(data).text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
    check(ctx, state, op, params) {
      const T = hooksFor(ctx, op.player);
      // A SHADOW PASSAGE *is* the Reposition action, so the universal action's own restrictions
      // apply: not while engaged, and not after a Fall Back or a Charge this activation.
      if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
        return { ok: false, reason: 'within control range of an enemy operative' };
      if (op.actionsThisActivation.includes('Reposition'))
        return { ok: false, reason: 'action restrictions: Reposition was already performed this activation' };
      if (op.actionsThisActivation.includes('Charge') || op.actionsThisActivation.includes('Fall Back'))
        return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      if (!withinShadow(T, state, op)) return { ok: false, reason: 'that operative is not WITHIN SHADOW' };
      const pos = params.targetPos ?? params.markerPos;
      if (!pos) return { ok: false, reason: 'select where the SHADOW PASSAGE comes out' };
      if (dist(op.pos, pos) < 0.01) return { ok: false, reason: 'select a different location' };
      const dest = { pos, z: surfaceAt(terrain(ctx, state), pos) };
      const allowance = passageAllowance(T, state, op, dest);
      if (!allowance.ok) return { ok: false, reason: allowance.reason ?? 'no SHADOW PASSAGE is available' };
      if (!withinShadow(T, state, op, dest)) return { ok: false, reason: 'it must be set back up WITHIN SHADOW' };
      const placed = canBePlacedAt(ctx, state, op, pos);
      if (!placed.ok) return placed;
      const probe = probeAt(op, pos, dest.z);
      // "it cannot be within control range of an enemy operative"
      if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, probe, e)))
        return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
      // "it cannot be a valid target for an enemy operative"
      if (validTargetForAnyEnemy(ctx, state, probe))
        return { ok: false, reason: 'it cannot be set up as a valid target for an enemy operative' };
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      const T = hooksFor(ctx, op.player);
      const pos = (params.targetPos ?? params.markerPos)!;
      const before = { ...op.pos };
      const beforeZ = op.z;
      const placed = canBePlacedAt(ctx, state, op, pos);
      const dest = { pos, z: placed.z ?? 0 };
      const allowance = passageAllowance(T, state, op, dest);
      // Shadow Portal: "…you can use this rule. If you do, remove your Shadow Portal markers
      // from the killzone (if any), then place one of your Shadow Portal markers within this
      // operative's control range before it's removed and one within its control range after
      // it's set up." Free and strictly beneficial, so it is auto-used (D-022).
      const weaver = op.datacardId === SHADEWEAVER;
      if (weaver) for (const m of portalMarkers(state, op.player)) removeMarker(state, m.id);
      op.pos = { ...pos };
      op.z = dest.z;
      settleZ(ctx, state, op);
      op.onGuard = false;
      if (op.carryingMarkerId) {
        const m = state.markers[op.carryingMarkerId];
        if (m) {
          m.pos = { ...op.pos };
          m.z = op.z;
        }
      }
      useOncePerTP(state, passageOpKey(op));
      if (!allowance.viaPortal) useOncePerTP(state, passageTeamKey(op.player));
      if (weaver) {
        placeTeamMarker(state, {
          id: `mandrakes.portal.${op.player}.a`,
          kind: 'generic',
          player: op.player,
          pos: before,
          z: beforeZ,
          flags: { [PORTAL_FLAG]: true },
        });
        placeTeamMarker(state, {
          id: `mandrakes.portal.${op.player}.b`,
          kind: 'generic',
          player: op.player,
          pos: { ...op.pos },
          z: op.z,
          flags: { [PORTAL_FLAG]: true },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `Shadow Portal: ${op.letter} leaves a portal at each end of the SHADOW PASSAGE`,
        });
      }
      effect(state, {
        rule: PASSAGE_LOCK,
        source: { kind: 'core', id: RULE.shadowPassage },
        sourceText: shortQuote(text(RULE.shadowPassage)),
        operativeId: op.id,
        player: op.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter} takes a SHADOW PASSAGE${allowance.viaPortal ? ' through a Shadow Portal' : ''}`,
        data: { operativeId: op.id },
      });
      return { ok: true };
    },
  });

  // =========================================================================
  // Charge (BLADE IN THE DARK) — docs/DECISIONS.md D-021
  // =========================================================================
  // "Each friendly MANDRAKE operative can perform the Charge action while it has a Conceal order
  //  if it starts or ends that action WITHIN SHADOW."
  const bladeText = data.strategyPloys.find((p) => p.id === SP.bladeInTheDark)!;
  defs.push({
    id: BLADE_IN_THE_DARK_CHARGE,
    name: BLADE_IN_THE_DARK_CHARGE,
    ap: 1,
    type: 'unique',
    treatedAs: 'Charge',
    sourceText: `${bladeText.name}: ${bladeText.text.replace(/\s+/g, ' ').trim()}`,
    available: (ctx, state, op) =>
      (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW) &&
      state.teams[op.player].gambitsUsedTP.includes(SP.bladeInTheDark),
    check(ctx, state, op, params) {
      if (!state.teams[op.player].gambitsUsedTP.includes(SP.bladeInTheDark))
        return { ok: false, reason: 'BLADE IN THE DARK has not been used this turning point' };
      if (op.order !== 'conceal')
        return { ok: false, reason: 'this operative has an Engage order — use the universal Charge action' };
      const T = hooksFor(ctx, op.player);
      const path = params.path;
      const endPos = path?.points?.[path.points.length - 1];
      const startsIn = withinShadow(T, state, op);
      const endsIn =
        endPos !== undefined &&
        withinShadow(T, state, op, { pos: endPos, z: surfaceAt(terrain(ctx, state), endPos) });
      if (!startsIn && !endsIn)
        return { ok: false, reason: 'it must start or end that action WITHIN SHADOW' };
      return getAction('Charge')!.check(ctx, state, op, params);
    },
    perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
  });

  // =========================================================================
  // WREATHE IN BALEFIRE (ABYSSAL, 1AP)
  // =========================================================================
  defs.push(
    uniqueAction(data, ABYSSAL, ACT.wreatheInBalefire, {
      check(ctx, state, op, params) {
        // "This operative cannot perform this action while within control range of an enemy
        //  operative."
        if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
          return { ok: false, reason: 'within control range of an enemy operative' };
        const target = wreatheTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'select one operative visible to this operative that does not have one of your Balefire tokens' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        const T = hooksFor(ctx, op.player);
        const target = wreatheTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'no valid operative for WREATHE IN BALEFIRE' };
        // "…or until it performs this action again (whichever comes first)"
        dropEffects(state, (e) => e.rule === BALEFIRE_TOKEN && e.player === op.player);
        giveToken(state, target, BALEFIRE_TOKEN, {
          sourceId: ACT.wreatheInBalefire,
          sourceText: shortQuote(actionText(ABYSSAL, ACT.wreatheInBalefire)),
          player: T.player,
          expiry: { kind: 'endOfBattle' },
        });
        return { ok: true };
      },
    }),
  );

  // =========================================================================
  // PAREIDOLIC PROJECTION (DIRGEMAW, 1AP)
  // =========================================================================
  defs.push(
    uniqueAction(data, DIRGEMAW, ACT.pareidolicProjection, {
      check(ctx, state, op, params) {
        const target = pareidolicTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!target)
          return { ok: false, reason: 'select one enemy operative that is a valid target for this operative or is WITHIN SHADOW' };
        // "This operative cannot perform this action while within control range of an enemy
        //  operative, unless the only enemy operative it's within control range of is selected
        //  for this action."
        const engaged = aliveOperatives(state, otherPlayer(op.player)).filter((e) => inControlRange(ctx, state, op, e));
        if (engaged.length > 0 && !(engaged.length === 1 && engaged[0]!.id === target.id))
          return { ok: false, reason: 'within control range of an enemy operative' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        const T = hooksFor(ctx, op.player);
        const target = pareidolicTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'no valid target for PAREIDOLIC PROJECTION' };
        dropEffects(state, (e) => e.rule === PAREIDOLIC_EFFECT && e.player === op.player);
        effect(state, {
          rule: PAREIDOLIC_EFFECT,
          source: { kind: 'ability', id: ACT.pareidolicProjection },
          sourceText: shortQuote(actionText(DIRGEMAW, ACT.pareidolicProjection)),
          operativeId: target.id,
          player: T.player,
          expiry: { kind: 'endOfBattle' },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `PAREIDOLIC PROJECTION: ${target.letter}'s weapons are worsened by 1 and its Move by 2"`,
          data: { operativeId: target.id },
        });
        return { ok: true };
      },
    }),
  );

  // =========================================================================
  // WEAVE DARKNESS (SHADEWEAVER, 1AP)
  // =========================================================================
  /*
   * "Remove your Weave Darkness marker from the killzone (if any). Then place your Weave
   *  Darkness marker visible to this operative, or on Vantage terrain of a terrain feature
   *  visible to this operative. That marker creates an area of smoke with the same size and
   *  effects as a smoke grenade, except you don't remove it during the following turning point.
   *  If this operative is incapacitated, remove your Weave Darkness marker from the killzone."
   *
   * The marker is a real `kind: 'smoke'` marker, which is what `smokeAreas` reads, so it obscures
   * exactly as a smoke grenade does. The module owns its lifecycle (see the `onReadyStep` /
   * `onEndOfTP` handlers above): "you don't remove it during the following turning point" is read
   * as surviving the whole of that turning point and being removed at the end of it.
   */
  defs.push(
    uniqueAction(data, SHADEWEAVER, ACT.weaveDarkness, {
      check(ctx, state, op, params) {
        if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
          return { ok: false, reason: 'within control range of an enemy operative' };
        const pos = params.targetPos ?? params.markerPos;
        if (!pos) return { ok: false, reason: 'select where to place your Weave Darkness marker' };
        if (!markerVisibleTo(ctx, state, op, pos))
          return { ok: false, reason: 'the marker must be visible to this operative' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        const pos = (params.targetPos ?? params.markerPos)!;
        for (const m of weaveMarkers(state, op.player)) removeMarker(state, m.id);
        placeTeamMarker(state, {
          id: `mandrakes.weave.${op.player}`,
          kind: 'smoke',
          player: op.player,
          pos,
          z: surfaceAt(terrain(ctx, state), pos),
          flags: { [WEAVE_FLAG]: true, armed: false, activationsLeft: 9999, placedTP: state.turningPoint },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter} weaves darkness — an area of smoke that survives the following turning point`,
        });
        return { ok: true };
      },
    }),
  );

  return defs;
}

const passageRule = (data: typeof DATA): TeamRuleText =>
  data.factionRules.find((r) => r.id === RULE.shadowPassage)!;

/**
 * An `ActionDef` is handed a `GameContext` but no `TeamHooks`, so the facade `withinShadow` and
 * friends need is rebuilt from the catalogue. It is a pure view over `DATA` + `ctx`.
 */
function hooksFor(ctx: GameContext, player: PlayerId): TeamHooks {
  return makeTeamHooks(DATA, player, ctx);
}

/** "Select one operative visible to this operative that doesn't have one of your Balefire tokens." */
function wreatheTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  wanted: string | undefined,
): OperativeState | undefined {
  const index = terrain(ctx, state);
  const candidates = aliveOperatives(state)
    .filter((o) => o.id !== op.id)
    .filter((o) => !hasToken(state, o.id, BALEFIRE_TOKEN, op.player))
    .filter((o) => isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return candidates.find((o) => o.id === wanted) ?? candidates[0];
}

/** "Select one enemy operative that's a valid target for this operative or is WITHIN SHADOW." */
function pareidolicTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  wanted: string | undefined,
): OperativeState | undefined {
  const T = hooksFor(ctx, op.player);
  const candidates = aliveOperatives(state, otherPlayer(op.player))
    .filter(
      (foe) =>
        withinShadow(T, state, foe) ||
        // The printed carve-out below explicitly contemplates the enemy this operative is
        // engaged with, and `checkTarget` makes EVERY target invalid while the shooter is
        // engaged ("cannot Shoot while within control range of an enemy"), which is a
        // restriction on the Shoot action rather than on being a valid target. An enemy inside
        // control range is visible and within 1", where cover is denied anyway.
        inControlRange(ctx, state, op, foe) ||
        isTargetableBy(ctx, state, op, foe),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return candidates.find((o) => o.id === wanted) ?? candidates[0];
}

function isTargetableBy(ctx: GameContext, state: GameState, op: OperativeState, foe: OperativeState): boolean {
  for (const w of weaponsOf(ctx, state, op, 'ranged')) {
    for (const profile of w.profiles) {
      if (profile.type !== 'ranged') continue;
      const rules = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: w.name });
      if (checkTarget(ctx, state, op, foe, profile, rules).valid) return true;
    }
  }
  return false;
}

/** "…place your Weave Darkness marker visible to this operative, or on Vantage terrain of a
 *  terrain feature visible to this operative." */
function markerVisibleTo(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2): boolean {
  const index = terrain(ctx, state);
  const z = surfaceAt(index, pos);
  const markerBody = {
    id: `weave-probe`,
    pos,
    z,
    rot: 0,
    base: { shape: 'round' as const, mm: 20 },
    height: 0.2,
  };
  return isVisible(index, body(ctx, op), markerBody).visible;
}

// ---------------------------------------------------------------------------
// Soul Harvest — the team's own PendingDecision kind
// ---------------------------------------------------------------------------

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== SOUL_HARVEST_DECISION) return false;
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const op = state.operatives[String(payload['operativeId'] ?? '')];
  const player = decision.who;
  const chosen = option?.id ?? 'keep';
  if (chosen === 'keep' || !op || soulHarvest(state, player) < 1) return true;
  setSoulHarvest(state, player, soulHarvest(state, player) - 1);
  if (chosen === 'apl') {
    // "add 1 to its APL stat until the end of the battle"
    op.aplMods.push(1);
    state.effects.push({
      id: `soulHarvest${state.seq++}`,
      rule: SOUL_HARVEST_APL,
      source: { kind: 'ability', id: AB.soulHarvest },
      sourceText: shortQuote(abilityText(CHOOSER, AB.soulHarvest)),
      operativeId: op.id,
      player,
      expiry: { kind: 'endOfBattle' },
    });
    log(state, { kind: 'action', player, text: `Soul Harvest: ${op.letter} gains +1 APL for the battle` });
    return true;
  }
  // "or have it regain up to 2D3 lost wounds"
  const roll = ctx.rng.d3() + ctx.rng.d3();
  recordRoll(state, 'mandrakes', [roll], player, 'Soul Harvest 2D3');
  const card = ctx.datacards.get(op.datacardId);
  const heal = Math.min(roll, (card?.wounds ?? op.wounds) - op.wounds);
  op.wounds += Math.max(0, heal);
  log(state, { kind: 'action', player, text: `Soul Harvest: ${op.letter} regains ${Math.max(0, heal)} lost wounds` });
  return true;
}

// ---------------------------------------------------------------------------

export const mandrakes = defineTeam({
  id: 'mandrakes',
  rules: (reg, T) => {
    rules(reg, T);
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
    // "Use this firefight ploy at the end of any operative's activation. Select one friendly
    //  MANDRAKE operative that has an Engage order and is WITHIN SHADOW."
    [FP.slitherOutOfSight]: (state, player) => {
      const snap = shadowSnapshot(state, player);
      const any = aliveOperatives(state, player).some((o) => o.order === 'engage' && snap[o.id] === true);
      return any ? { ok: true } : { ok: false, reason: 'no friendly MANDRAKE operative with an Engage order is WITHIN SHADOW' };
    },
    // "…at the end of the Resolve Attack Dice step … an enemy operative within 6" of it … You
    //  cannot use this ploy if that friendly MANDRAKE operative is incapacitated."
    [FP.soulFeast]: (state, player) => {
      const rec = soulFeastRecord(state, player);
      if (!rec) return { ok: false, reason: 'no friendly attack dice have inflicted damage this activation' };
      if (rec.gap > 6 + EPS) return { ok: false, reason: 'that enemy operative is not within 6"' };
      const op = state.operatives[rec.friendlyId];
      if (!op || op.incapacitated || op.removed) return { ok: false, reason: 'that friendly operative is incapacitated' };
      return { ok: true };
    },
    // "Use this firefight ploy during a friendly MANDRAKE operative's activation, when it
    //  performs an action in which it moves."
    [FP.nowhereToHide]: (state, player) => {
      const id = state.activeOperativeId;
      const op = id ? state.operatives[id] : undefined;
      if (!op || op.player !== player) return { ok: false, reason: 'no friendly operative is activated' };
      return { ok: true };
    },
    // Declared in advance and fired on its printed trigger; it needs a live MANDRAKE to defend.
    [FP.shadowsBite]: (state, player) => {
      if (state.effects.some((e) => e.rule === SHADOWS_BITE_EFFECT && e.player === player))
        return { ok: false, reason: "SHADOW'S BITE is already declared" };
      return aliveOperatives(state, player).length > 0
        ? { ok: true }
        : { ok: false, reason: 'no friendly MANDRAKE operative is in the killzone' };
    },
  },
  aiHints: {
    roles: {
      [NIGHTFIEND]: 'leader',
      [ABYSSAL]: 'gunner',
      [CHOOSER]: 'melee',
      [DIRGEMAW]: 'support',
      [SHADEWEAVER]: 'scout',
      [WARRIOR]: 'objective',
    },
    ployValue: {
      [SP.creepingHorror]: 1.1,
      [SP.gloamingShroud]: 1.4,
      [SP.bladeInTheDark]: 0.9,
      [SP.inescapableNightmare]: 1.3,
      [HAUNTING_GAMBIT]: 0.6,
      [FP.slitherOutOfSight]: 1.0,
      [FP.soulFeast]: 1.5,
      // The terrain permission has no engine seam, so the ploy is all cost and no benefit here.
      [FP.nowhereToHide]: 0,
      [FP.shadowsBite]: 0.9,
    },
    equipmentValue: {
      [EQ.chainSnare]: 0.8,
      [EQ.shadowGlyph]: 1.2,
      [EQ.soulGem]: 0.7,
      [EQ.boneDarts]: 0.9,
    },
  },
});

export { withinShadow as isWithinShadow };
