/**
 * HEARTHKYN SALVAGERS — Leagues of Votann.
 * https://wahapedia.ru/kill-team3/kill-teams/hearthkyn-salvager/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read
 * out of `data/teams/hearthkyn-salvager.json` and is never retyped here.
 *
 * The team is a token economy built on ONE faction rule — Grudge. A Grudge token is a per-player
 * effect on the enemy operative that carries it (`giveToken`/`hasToken`/`removeToken`, the shape
 * the Plague Marines' Poison, the Nemesis Claw's Terrorchem and the Exaction Squad's Marked for
 * Justice established), except that an operative can hold MORE than one — the printed marker guide
 * lists "Grudge tokens (Values 1 & 2)" — so the count lives in the effect's `data.count`.
 *
 * Two rare weapon rules are printed on datacards rather than in the shared registry (D-033):
 * `Beam` (the GUNNER's EtaCarn plasma beamer) and `Force Impact` (the JUMP PACK WARRIOR's plasma
 * weapon). Both resolve to this team's own text through `rareRuleTextFor`.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { successes, type DicePool } from '../../core/dice.ts';
import {
  EXPLOSIVE_ID,
  grenadeAllowance,
  grenadeWeapon,
  withGrenadeBudgetIgnored,
} from '../../core/equipment/grenades.ts';
import {
  baseRadius,
  dist,
  distancePointToSegment,
  dot,
  norm,
  segmentCrossesPoly,
  sub,
} from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  findProfile,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  modelHeight,
  moveOf,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import {
  baseBlockedByTerrain,
  baseTouchesHazardous,
  hasType,
  surfaceAt,
  wallRouteDistance,
} from '../../core/terrain.ts';
import { isVisible, withinControlRange, type Body } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import { validateMove } from '../../core/movement.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  Datacard,
  GameState,
  MarkerKind,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  centroidOf,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  gambitUsed,
  giveToken,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  hasToken,
  notEngaged,
  ployUsed,
  posFromData,
  removeToken,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('hearthkyn-salvager');
const KW = 'HEARTHKYN SALVAGER';
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

export const THEYN = 'hearthkyn-salvager.theyn';
export const DOZR = 'hearthkyn-salvager.d-zr';
export const FIELD_MEDIC = 'hearthkyn-salvager.field-medic';
export const GRENADIER = 'hearthkyn-salvager.grenadier';
export const GUNNER = 'hearthkyn-salvager.gunner';
export const JUMP_PACK_WARRIOR = 'hearthkyn-salvager.jump-pack-warrior';
export const KINLYNK = 'hearthkyn-salvager.kinlynk';
export const KOGNITAAR = 'hearthkyn-salvager.kognit-ar';
export const LOKATR = 'hearthkyn-salvager.lok-tr';
export const LUGGER = 'hearthkyn-salvager.lugger';
export const WARRIOR = 'hearthkyn-salvager.warrior';

export const RULE_GRUDGE = 'hearthkyn-salvager.rule.grudge';

const SP_NEED_KEEPS = 'hearthkyn-salvager.sp.need-keeps';
const SP_WROUGHT_DEFENCE = 'hearthkyn-salvager.sp.wrought-defence';
const SP_TOIL_EARNS = 'hearthkyn-salvager.sp.toil-earns';
const SP_PROXIMATE_FIREPOWER = 'hearthkyn-salvager.sp.proximate-firepower';
const FP_ANCESTORS = 'hearthkyn-salvager.fp.the-ancestors-are-watching';
const FP_STURDY = 'hearthkyn-salvager.fp.sturdy';
const FP_WORTH_IT = 'hearthkyn-salvager.fp.worth-it';
const FP_ENGAGE_TO_ACQUIRE = 'hearthkyn-salvager.fp.engage-to-acquire';

const EQ_PLASMA_KNIVES = 'hearthkyn-salvager.eq.plasma-knives';
const EQ_EXCAVATION_TOOLS = 'hearthkyn-salvager.eq.excavation-tools';
const EQ_CLIMBING_RIGS = 'hearthkyn-salvager.eq.climbing-rigs';
const EQ_WRIT_OF_CLAIM = 'hearthkyn-salvager.eq.writ-of-claim';

const AB_EYE = 'hearthkyn-salvager.theyn.eye-of-the-ancestors';
const AB_WEAVEFIELD = 'hearthkyn-salvager.theyn.weavefield-crest';
const AB_BRAWLER = 'hearthkyn-salvager.d-zr.brawler';
const AB_MEDIC = 'hearthkyn-salvager.field-medic.medic';
const AB_GRENADIER = 'hearthkyn-salvager.grenadier.grenadier';
const AB_BEAM = 'hearthkyn-salvager.gunner.beam';
const AB_JUMP_PACK = 'hearthkyn-salvager.jump-pack-warrior.jump-pack';
const AB_FORCE_IMPACT = 'hearthkyn-salvager.jump-pack-warrior.force-impact';
const AB_TACTICIAN = 'hearthkyn-salvager.kognit-ar.tactician';
const AB_WELL_SUPPLIED = 'hearthkyn-salvager.lugger.well-supplied';
const AB_IVE_GOT_IT = 'hearthkyn-salvager.lugger.ive-got-it';
const AB_SECURE_SALVAGE = 'hearthkyn-salvager.warrior.secure-salvage';

const ACT_KNUX = 'hearthkyn-salvager.d-zr.act.knux-smash';
const ACT_MEDIKIT = 'hearthkyn-salvager.field-medic.act.medikit';
const ACT_UTILITY_GRENADE = 'hearthkyn-salvager.grenadier.act.v-yr-3-utility-grenade';
const ACT_SIGNAL = 'hearthkyn-salvager.kinlynk.act.signal';
const ACT_SYSTEM_JAM = 'hearthkyn-salvager.kinlynk.act.system-jam';
const ACT_APPRAISAL = 'hearthkyn-salvager.kognit-ar.act.accelerated-appraisal';
const ACT_SPOT = 'hearthkyn-salvager.lok-tr.act.spot';
const ACT_SCAN = 'hearthkyn-salvager.lok-tr.act.pan-spectral-scan';

/** Tokens the printed marker guide names, held as per-player effects on their bearer. */
export const GRUDGE_TOKEN = 'hearthkyn-salvager.grudge';
export const SYSTEM_JAM_TOKEN = 'hearthkyn-salvager.systemJam';
export const SPOT_TOKEN = 'hearthkyn-salvager.spot';

const NEED_KEEPS_EFFECT = 'hearthkyn-salvager.needKeeps';
const TOIL_EARNS_EFFECT = 'hearthkyn-salvager.toilEarns';
const STURDY_ARMED = 'hearthkyn-salvager.sturdyArmed';
const ACQUIRE_ARMED = 'hearthkyn-salvager.engageToAcquire';
const MEDIC_SHIELD = 'hearthkyn-salvager.medicShield';
const MEDIC_APL = 'hearthkyn-salvager.medicApl';
const KNUX_APL = 'hearthkyn-salvager.knuxApl';
const KNUX_CHARGE_READY = 'hearthkyn-salvager.knuxChargeReady';
const SIGNAL_EFFECT = 'hearthkyn-salvager.signal';

const GRUDGE_NOTE = 'Grudge';
const STURDY_NOTE = 'Sturdy';
const WROUGHT_NOTE = 'Wrought Defence';

export const ATTACK_MARKER = (player: PlayerId): string => `hearthkyn-salvager.attack.${player}`;
export const DEFENCE_MARKER = (player: PlayerId): string => `hearthkyn-salvager.defence.${player}`;
export const SCAN_MARKER = (player: PlayerId): string => `hearthkyn-salvager.scan.${player}`;
export const UTILITY_MARKER_PREFIX = 'hearthkyn-salvager.utility.';

export const KNUX_CHARGE = 'Charge (Knux Smash)';
export const EXCAVATION_PICK_UP = 'Pick Up Marker (Excavation Tools)';
export const FLY_REPOSITION = 'Reposition (Jump Pack)';
export const FLY_DASH = 'Dash (Jump Pack)';
export const FLY_FALL_BACK = 'Fall Back (Jump Pack)';
export const FLY_CHARGE = 'Charge (Jump Pack)';
export const GRENADIER_SMOKE = 'Smoke Grenade (Grenadier)';
export const GRENADIER_STUN = 'Stun Grenade (Grenadier)';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isGrenade = (name: string): boolean => /^(frag|krak) grenade$/i.test(name.trim());
const isMissionAction = (id: string): boolean => getAction(id)?.type === 'mission';

function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/**
 * "one objective marker or one of your mission markers" — objective markers plus the marker kinds
 * the mission (crit/tac op) layer places, restricted to this player's own where a kind is owned.
 * Equipment markers (smoke, mine) and this team's own rule markers are deliberately excluded.
 */
const MISSION_MARKER_KINDS = new Set<MarkerKind>([
  'ammoCache',
  'commsDevice',
  'device',
  'intelligence',
  'retrieval',
  'banner',
  'martyr',
  'dominate',
  'orb',
  'energyCell',
  'download',
  'data',
  'reboot',
]);

function claimableMarkers(T: TeamHooks, state: GameState): MarkerState[] {
  return Object.values(state.markers)
    .filter(
      (m) =>
        m.kind === 'objective' ||
        (MISSION_MARKER_KINDS.has(m.kind) && (m.owner === undefined || m.owner === T.player)),
    )
    .sort(byId);
}

/** Does this operative contest an objective marker or one of the player's mission markers? */
function contestsClaimable(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  return claimableMarkers(T, state).some((m) => markerContestedBy(T.ctx!, state, m, op));
}

/** The weapon profile of the attack currently being resolved against `victim`, if any. */
function incomingProfile(
  T: TeamHooks,
  state: GameState,
  victim: OperativeState,
): { profile: WeaponProfile; melee: boolean } | undefined {
  const seq = state.sequence;
  if (!seq || !T.ctx) return undefined;
  if (seq.kind === 'shoot') {
    if (seq.targetId !== victim.id) return undefined;
    const attacker = state.operatives[seq.attackerId];
    if (!attacker) return undefined;
    const w = weaponsOf(T.ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
    const profile = w ? findProfile(w, seq.profileName) : undefined;
    return profile ? { profile, melee: false } : undefined;
  }
  const side = seq.defenderId === victim.id ? 'attacker' : seq.attackerId === victim.id ? 'defender' : undefined;
  if (!side) return undefined;
  return { profile: sideWeapon(T.ctx, state, seq, side).profile, melee: true };
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
// Grudge — the faction rule's token economy
// ---------------------------------------------------------------------------

/** How many of `player`'s Grudge tokens this operative physically holds. */
export function grudgeTokens(state: GameState, operativeId: string, player: PlayerId): number {
  const eff = state.effects.find(
    (e) => e.rule === GRUDGE_TOKEN && e.operativeId === operativeId && e.player === player,
  );
  return eff ? Number(eff.data?.['count'] ?? 1) : 0;
}

/** "…that enemy operative gains one of your Grudge tokens for the battle." */
export function giveGrudge(state: GameState, target: OperativeState, player: PlayerId): void {
  const existing = state.effects.find(
    (e) => e.rule === GRUDGE_TOKEN && e.operativeId === target.id && e.player === player,
  );
  if (existing) {
    existing.data = { ...(existing.data ?? {}), count: Number(existing.data?.['count'] ?? 1) + 1 };
    log(state, {
      kind: 'action',
      player,
      text: `${target.letter} gains a ${GRUDGE_TOKEN} token (${existing.data['count']})`,
    });
    return;
  }
  giveToken(state, target, GRUDGE_TOKEN, {
    sourceId: RULE_GRUDGE,
    sourceText: shortQuote(text(RULE_GRUDGE)),
    player,
    expiry: { kind: 'endOfBattle' }, // "…for the battle"
  });
  const created = state.effects.find(
    (e) => e.rule === GRUDGE_TOKEN && e.operativeId === target.id && e.player === player,
  );
  if (created) created.data = { count: 1 };
}

/**
 * Grudge tokens counted for a shot/fight, including TOIL EARNS' "treat it as having one
 * additional Grudge token" while the enemy is within 3" of the selected marker.
 */
export function effectiveGrudge(T: TeamHooks, state: GameState, enemy: OperativeState): number {
  let n = grudgeTokens(state, enemy.id, T.player);
  const toil = effectFor(state, T.player, TOIL_EARNS_EFFECT);
  const markerId = toil?.data?.['markerId'];
  const marker = typeof markerId === 'string' ? state.markers[markerId] : undefined;
  if (marker && T.markerGap(enemy, marker) <= 3 + EPS) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Grudge (faction rule) ---------------------------------------------
  // "Whenever an enemy operative incapacitates a friendly HEARTHKYN SALVAGER operative, that
  //  enemy operative gains one of your Grudge tokens for the battle."
  // Bound at 20 so Medic!'s prevention (11) and the DÔZR's dying strike (12) have already run.
  reg.on('onIncapacitated', T.bind(RULE_GRUDGE, 20), (ev) => {
    if (ev.prevented || !T.mineKw(ev.operative, KW)) return;
    const killer = incapacitatorOf(ev.state, ev.operative);
    if (!killer || killer.player === T.player) return;
    giveGrudge(ev.state, killer, T.player);
  });

  /*
   * "Whenever a friendly HEARTHKYN SALVAGER operative is shooting against, fighting against or
   *  retaliating against an enemy operative, for each of your Grudge tokens that enemy operative
   *  has, you can retain one of your normal successes as a critical success instead (including any
   *  normal successes already retained as a result of the Accurate weapon rule)."
   *
   * The retention step has no hook of its own (`onAttackDiceRetained` is declared but never
   * emitted), so the promotion rides the `onWeaponRules` emit that BOTH sequences make while
   * `step === 'retention'`: `advanceShoot` calls `effectiveRules` at the top of every iteration,
   * and `advanceFight`'s retention case calls `sideWeapon` per side — in each case immediately
   * before `retentionOptions` is computed, which is exactly where the printed rule sits.
   *
   * It is free and strictly beneficial (a critical success is never worse than a normal one), so
   * it is auto-used under docs/DECISIONS.md D-022. The count of dice already promoted is read back
   * off the die notes, so a re-entry after a retention decision promotes nothing further.
   */
  reg.on('onWeaponRules', T.bind(RULE_GRUDGE, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    const seq = ev.state.sequence;
    if (!seq || seq.step !== 'retention') return;
    let pool: DicePool;
    if (seq.kind === 'shoot') {
      if (seq.attackerId !== ev.operative.id) return;
      // Obscured "takes precedence over all other rules": crits cannot be retained.
      if (seq.obscured) return;
      pool = seq.attack;
    } else if (seq.attackerId === ev.operative.id) {
      pool = seq.attackerPool;
    } else if (seq.defenderId === ev.operative.id) {
      pool = seq.defenderPool;
    } else {
      return;
    }
    const tokens = effectiveGrudge(T, ev.state, ev.target);
    if (tokens <= 0) return;
    let left = tokens - pool.dice.filter((d) => d.note === GRUDGE_NOTE).length;
    let promoted = 0;
    for (const die of pool.dice) {
      if (left <= 0) break;
      if (die.state !== 'normal') continue;
      die.state = 'crit';
      die.note = GRUDGE_NOTE;
      left--;
      promoted++;
    }
    if (promoted > 0)
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `Grudge: ${promoted} normal success${promoted > 1 ? 'es' : ''} retained as critical`,
      });
  });

  // ---- THEYN › Eye of the Ancestors (STRATEGIC GAMBIT) -------------------
  reg.on('gambitOptions', T.bind(AB_EYE, 15), (ev) => {
    if (ev.player !== T.player) return;
    // "STRATEGIC GAMBIT if this operative is in the killzone."
    if (!T.friendlies(ev.state).some((o) => o.datacardId === THEYN)) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({ id: AB_EYE, label: 'Eye of the Ancestors', sourceText: shortQuote(abilityText(THEYN, AB_EYE)) });
  });
  reg.on('onPloyUsed', T.bind(AB_EYE, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== AB_EYE) return;
    // "…or up to two enemy operatives if three or more friendly HEARTHKYN SALVAGER operatives
    //  are incapacitated."
    const lost = ev.state.teams[T.player].operativeIds.length - T.friendlies(ev.state).length;
    const wanted = lost >= 3 ? 2 : 1;
    const foes = [...T.enemies(ev.state)].sort(byId);
    const named = chosenOperative(ev.state, ev.data, foes);
    const picks = [named, ...foes.filter((o) => o.id !== named?.id)]
      .filter((o): o is OperativeState => o !== undefined)
      .slice(0, wanted);
    for (const foe of picks) giveGrudge(ev.state, foe, T.player);
  });

  // ---- THEYN › Weavefield Crest ------------------------------------------
  /**
   * "Once per battle, when an attack dice inflicts Normal Dmg on this operative, you can ignore
   * that inflicted damage."
   *
   * `onDamage` carries `ctx: null` (the core always passes null), so the striking profile comes
   * from the in-flight sequence. A shoot aggregates every unblocked dice into one call, so one
   * normal success's worth — the profile's Normal Dmg — is what gets ignored.
   *
   * Once-per-battle, so under D-022 it is spent on a stated policy: only when the damage would
   * incapacitate the THEYN, or when a single normal success is worth 3 or more.
   */
  reg.on('onDamage', T.bind(AB_WEAVEFIELD, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.datacardId !== THEYN || ev.target.player !== T.player) return;
    const incoming = incomingProfile(T, ev.state, ev.target);
    if (!incoming) return;
    const slice = normalDamageSlice(ev.state, incoming, ev.amount);
    if (slice <= 0) return;
    if (slice < 3 && ev.amount < ev.target.wounds) return;
    if (!useOncePerBattle(ev.state, `hearthkyn-salvager.weavefield:${ev.target.id}`)) return;
    ev.amount = Math.max(0, ev.amount - slice);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Weavefield Crest: ${ev.target.letter} ignores ${slice} damage`,
    });
  });

  // ---- DÔZR › Brawler ----------------------------------------------------
  /**
   * "Whenever this operative is fighting or retaliating: Enemy operatives cannot assist."
   *
   * `onFightAssist` fires inside `startFight` before `state.sequence` exists, so it cannot tell
   * WHICH fight the assists belong to. The assists are cancelled where they are spent instead:
   * `rollSide` passes `assists + mods.hit` to `hitOf`, so subtracting the recorded assist count
   * from `mods.hit` is exactly equivalent, and by then both fighters are known.
   */
  reg.on('onCollectAttackDice', T.bind(AB_BRAWLER, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.ctx.attacker.player === T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === ev.ctx.attacker.id ? 'attacker' : seq.defenderId === ev.ctx.attacker.id ? 'defender' : undefined;
    if (!side) return;
    const foeId = side === 'attacker' ? seq.defenderId : seq.attackerId;
    const foe = ev.state.operatives[foeId];
    if (!foe || foe.player !== T.player || foe.datacardId !== DOZR) return;
    const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
    if (assists > 0) {
      ev.mods.hit -= assists;
      log(ev.state, { kind: 'dice', player: T.player, text: `Brawler: enemy operatives cannot assist (-${assists})` });
    }
  });
  // "If it's incapacitated, you can strike the enemy operative in that sequence with one of your
  //  unresolved successes before it's removed from the killzone."
  reg.on('onIncapacitated', T.bind(AB_BRAWLER, 12), (ev) => {
    if (ev.prevented || !T.ctx) return;
    const dozr = ev.operative;
    if (dozr.player !== T.player || dozr.datacardId !== DOZR) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === dozr.id ? 'attacker' : seq.defenderId === dozr.id ? 'defender' : undefined;
    if (!side) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const die = successes(pool).sort((a, b) => (a.state === b.state ? 0 : a.state === 'crit' ? -1 : 1))[0];
    if (!die) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    if (!foe || foe.removed) return;
    const { profile } = sideWeapon(T.ctx, ev.state, seq, side);
    const dmg = die.state === 'crit' ? profile.dmgC : profile.dmgN;
    die.state = 'struck';
    die.note = 'Brawler';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Brawler: ${dozr.letter} strikes ${foe.letter} for ${dmg} before being removed`,
    });
    inflictDamage(T.ctx, ev.state, foe, dmg, 'attack');
  });
  // "Normal Dmg of 4 or more inflicts 1 less damage on it."
  reg.on('onDamage', T.bind(AB_BRAWLER, 13), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.player !== T.player || ev.target.datacardId !== DOZR) return;
    const incoming = incomingProfile(T, ev.state, ev.target);
    if (!incoming || !incoming.melee) return; // "whenever this operative is fighting or retaliating"
    if (incoming.profile.dmgN < 4) return;
    if (ev.amount !== incoming.profile.dmgN) return; // one NORMAL success's damage
    ev.amount = Math.max(0, ev.amount - 1);
  });

  // ---- FIELD MEDIC › Medic! ----------------------------------------------
  reg.on('onIncapacitated', T.bind(AB_MEDIC, 11), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW)) return;
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === FIELD_MEDIC &&
        o.id !== victim.id && // "another friendly HEARTHKYN SALVAGER operative"
        !o.incapacitated && // "You cannot use this rule if this operative is incapacitated"
        T.gap(o, victim) <= 3 + EPS &&
        visibleTo(T, ev.state, o, victim) &&
        // "providing neither this nor that operative is within control range of an enemy operative"
        T.enemies(ev.state).every((e) => !inCR(T, ev.state, e, o) && !inCR(T, ev.state, e, victim)),
    );
    if (!medic) return;
    // "…or if it's a Shoot action and this operative would be a primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    // "The first time during each turning point that another friendly … would be incapacitated"
    if (!useOncePerTP(ev.state, `hearthkyn-salvager.medic:${medic.id}`)) return;

    ev.prevented = true;
    victim.wounds = 1; // "that friendly operative isn't incapacitated, has 1 wound remaining"
    medicTargets(ev.state)[medic.id] = victim.id;
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: AB_MEDIC },
      sourceText: shortQuote(abilityText(FIELD_MEDIC, AB_MEDIC)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next
    //  activations respectively."
    for (const o of [medic, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: MEDIC_APL,
        source: { kind: 'ability', id: AB_MEDIC },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    // "After that action, that friendly operative can immediately perform a free Dash action" and
    // "if this rule was used during that friendly operative's activation, that activation ends" —
    // so from here the Dash is the only action it may still perform. It rides free AP (D-100)
    // rather than +1 APL, which matters here more than anywhere: the same rule has just
    // subtracted 1 from that operative's APL stat, and an APL-based free action would have been
    // spent undoing that debuff instead of making the Dash happen.
    // REMINDER ONLY: "must end that move within this operative's control range" has no seam.
    grantFreeAction(ev.state, victim, {
      sourceId: AB_MEDIC,
      sourceText: shortQuote(abilityText(FIELD_MEDIC, AB_MEDIC)),
      threshold: ev.state.activeOperativeId === victim.id ? victim.apSpent : currentApl(T, ev.state, victim),
      kind: 'ability',
      only: ['Dash', FLY_DASH],
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Medic!: ${victim.letter} stays on 1 wound` });
  });
  // "…and cannot be incapacitated for the remainder of the action."
  reg.on('onIncapacitated', T.bind(AB_MEDIC, 10), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, MEDIC_SHIELD)) return;
    ev.prevented = true;
    if (ev.operative.wounds <= 0) ev.operative.wounds = 1;
  });
  // `endOfAction` effects are only swept at the end of a turning point, so the shield is dropped
  // at the activation boundary instead — tighter than the engine's own expiry.
  reg.on('onActivationEnd', T.bind(AB_MEDIC, 12), (ev) => {
    dropEffects(ev.state, (e) => e.rule === MEDIC_SHIELD && e.player === T.player);
  });
  // "It cannot be an operative that the Medic! rule was used on during this turning point."
  reg.on('onReadyStep', T.bind(AB_MEDIC, 13), (ev) => {
    if (ev.player !== T.player) return;
    ev.state.opState['hearthkyn-salvager.medicTarget'] = {};
  });

  // ---- GRENADIER › Grenadier ---------------------------------------------
  // "This operative can use frag, krak, smoke and stun grenades." The two utility grenades are
  // ActionDefs gated on the universal equipment, so the GRENADIER gets its own pair (below); the
  // two explosive grenades are weapons, granted here.
  const armGrenadier = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === GRENADIER)) {
      grantWeapon(o, structuredClone(grenadeWeapon('frag')));
      grantWeapon(o, structuredClone(grenadeWeapon('krak')));
    }
  };
  reg.on('onDeploy', T.bind(AB_GRENADIER, 12), (ev) => {
    if (ev.operative.player === T.player) armGrenadier(ev.state);
  });
  reg.on('onActivationStart', T.bind(AB_GRENADIER, 12), (ev) => armGrenadier(ev.state));
  reg.on('onReadyStep', T.bind(AB_GRENADIER, 12), (ev) => {
    if (ev.player === T.player) armGrenadier(ev.state);
  });
  // The universal Explosive Grenades limiter (priority 10 on the same hook) refuses a grenade the
  // kill team has spent; the GRENADIER is exempt, so it is re-allowed at a later priority.
  reg.on('onSelectWeapon', T.bind(AB_GRENADIER, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== GRENADIER) return;
    if (!isGrenade(ev.ctx.weaponName)) return;
    ev.allowed = true;
    delete ev.reason;
  });
  // "Doing so doesn't count towards any limited uses you have" — the equipment's spender runs at
  // priority 10 on this hook, so its increment is handed straight back.
  reg.on('onCollectAttackDice', T.bind(AB_GRENADIER, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== GRENADIER) return;
    if (!isGrenade(ev.ctx.weaponName) || ev.ctx.secondary) return;
    const choice = /krak/i.test(ev.ctx.weaponName) ? 'krak' : 'frag';
    if (grenadeAllowance(ev.state, T.player, EXPLOSIVE_ID, choice) <= 0) return;
    const uses = ev.state.teams[T.player].equipmentUses;
    const key = `used:${EXPLOSIVE_ID}:${choice}`;
    uses[key] = Math.max(0, (uses[key] ?? 0) - 1);
  });
  // "Whenever this operative is using a frag or krak grenade, improve the Hit stat of that weapon
  //  by 1." `StatMods.hit` from `onCollectAttackDice` is dead — `hitOf` reads only `onStatMod`.
  reg.on('onStatMod', T.bind(AB_GRENADIER, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== GRENADIER) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !isGrenade(seq.weaponName)) return;
    ev.mods.hit += 1;
  });

  // ---- GUNNER › Beam (rare weapon rule) ----------------------------------
  /**
   * "Whenever this operative is shooting with this weapon, each retained critical success
   * immediately inflicts D3 damage on each other operative along one (and only one) beam line
   * (roll separately for each operative), but the target isn't affected."
   *
   * Fired at the Roll Defence Dice step, which is where `countCrits(seq.attack)` is exactly the
   * RETAINED critical count (after obscured, before blocking) — the core's own Devastating code
   * reads it one step later, by which point blocking has erased the crit/normal identity. The
   * beam line is the ray from the shooter through the target's centre (D-016: the printed
   * "one (and only one)" is the player's choice, so the deterministic default is taken).
   */
  reg.on('onDefenceDice', T.bind(AB_BEAM, 12), (ev) => {
    if (!T.ctx) return;
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Beam')) return;
    const seq = shootSeq(ev.state);
    const target = ev.ctx.defender;
    if (!seq || seq.step !== 'rollDefence' || !target) return;
    if (!useOncePerSequence(ev.state, `hearthkyn-salvager.beam:${T.player}`)) return;
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    if (crits === 0) return;
    const victims = beamVictims(T, ev.state, ev.ctx.attacker, target);
    for (let i = 0; i < crits; i++) {
      for (const victim of victims) {
        if (victim.removed) continue;
        const d3 = T.ctx.rng.d3();
        recordRoll(ev.state, 'beam', [d3], T.player, `Beam vs ${victim.letter}`);
        inflictDamage(T.ctx, ev.state, victim, d3, 'devastating');
      }
    }
    if (victims.length > 0)
      log(ev.state, {
        kind: 'dice',
        player: T.player,
        text: `Beam: ${crits} critical success${crits > 1 ? 'es' : ''} along the beam line (${victims.map((v) => v.letter).join(', ')})`,
      });
  });

  // ---- JUMP PACK WARRIOR › Force Impact (rare weapon rule) ---------------
  // "Whenever this operative is fighting with this weapon, if it's performed the Charge action
  //  during the activation, this weapon has the Brutal weapon rule."
  reg.on('onWeaponRules', T.bind(AB_FORCE_IMPACT, 12), (ev) => {
    if (ev.type !== 'melee' || ev.operative.player !== T.player) return;
    if (!ev.profile.rules.some((r) => r.id === 'ForceImpact')) return;
    if (!chargedThisActivation(ev.operative)) return;
    ev.rules.push(ruleTag('Brutal', undefined, 'Brutal (Force Impact)'));
  });

  // ---- KOGNITÂAR › Tactician (STRATEGIC GAMBIT) --------------------------
  for (const which of ['attack', 'defence'] as const) {
    reg.on('gambitOptions', T.bind(AB_TACTICIAN, 15), (ev) => {
      if (ev.player !== T.player) return;
      if (!T.friendlies(ev.state).some((o) => o.datacardId === KOGNITAAR)) return;
      ev.options.push({
        id: `${AB_TACTICIAN}:${which}`,
        label: `Tactician: place your ${which === 'attack' ? 'Attack' : 'Defence'} marker`,
        sourceText: shortQuote(abilityText(KOGNITAAR, AB_TACTICIAN)),
      });
    });
  }
  reg.on('onPloyUsed', T.bind(AB_TACTICIAN, 16), (ev) => {
    if (ev.player !== T.player) return;
    const which = ev.ployId === `${AB_TACTICIAN}:attack` ? 'attack' : ev.ployId === `${AB_TACTICIAN}:defence` ? 'defence' : undefined;
    if (!which) return;
    const pos = posFromData(ev.data, centroidOf(T.friendlies(ev.state, KW), { x: ev.state.map.board.w / 2, y: ev.state.map.board.h / 2 }));
    placeTacticianMarker(ev.state, T.player, which, pos, T.ctx);
  });
  // "Whenever a friendly HEARTHKYN SALVAGER operative is shooting against, fighting against or
  //  retaliating against an enemy operative that's within 3" of your Attack marker, that friendly
  //  operative's weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(AB_TACTICIAN, 13), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    const marker = ev.state.markers[ATTACK_MARKER(T.player)];
    if (!marker || T.markerGap(ev.target, marker) > 3 + EPS) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Tactician)'));
  });
  // "Whenever an enemy operative is shooting a friendly HEARTHKYN SALVAGER operative that's
  //  within 3" of your Defence marker, you can re-roll one of your defence dice."
  reg.on('onDefenceDice', T.bind(AB_TACTICIAN, 14), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || ev.ctx.attacker.player === T.player) return;
    const marker = ev.state.markers[DEFENCE_MARKER(T.player)];
    if (!marker || T.markerGap(target, marker) > 3 + EPS) return;
    ev.rerolls.push({
      id: 'hearthkyn-salvager.tactician',
      label: 'Tactician: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(abilityText(KOGNITAAR, AB_TACTICIAN)),
    });
  });
  // "In the Ready step of the next Strategy phase, remove that marker."
  reg.on('onReadyStep', T.bind(AB_TACTICIAN, 15), (ev) => {
    if (ev.player !== T.player) return;
    for (const id of [ATTACK_MARKER(T.player), DEFENCE_MARKER(T.player)]) {
      const marker = ev.state.markers[id];
      if (!marker) continue;
      if (Number(marker.flags['placedTP'] ?? 0) >= ev.state.turningPoint) continue;
      delete ev.state.markers[id];
    }
  });

  // ---- LUGGER › Well Supplied --------------------------------------------
  // REMINDER ONLY. "You can select one additional equipment option." The reducer refuses a fifth
  // option (`SelectEquipment`) before `onSelectEquipment` is emitted, so no hook can widen the
  // cap — the same wall the Deathwatch's Adaptable Armoury and the Ratlings' Munitorum Contacts
  // hit. Reported; no handler is registered, because one would be a silent no-op.

  // ---- LUGGER › I've Got It ----------------------------------------------
  // "Once during each of this operative's activations, it can perform a mission action for 1
  //  less AP." `onActionCost` is a pure query the UI/AI run many times, so "once" is read off
  //  `actionsThisActivation` rather than stamped.
  reg.on('onActionCost', T.bind(AB_IVE_GOT_IT, 12), (ev) => {
    if (ev.operative.datacardId !== LUGGER || ev.operative.player !== T.player) return;
    if (!isMissionAction(ev.action)) return;
    if (ev.operative.actionsThisActivation.some((a) => isMissionAction(a))) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- WARRIOR › Secure Salvage ------------------------------------------
  /**
   * "Whenever an enemy operative is shooting against, fighting against or retaliating against this
   * operative, if this operative contests an objective marker or one of your mission markers, in
   * the Resolve Attack Dice step, you can subtract 1 from the damage inflicted on it from one
   * success."
   *
   * One success's damage minus one is the whole attack's damage minus one, so the subtraction is
   * applied once per sequence at `onDamage` (which is where the Resolve Attack Dice step lands).
   */
  reg.on('onDamage', T.bind(AB_SECURE_SALVAGE, 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (ev.target.player !== T.player || ev.target.datacardId !== WARRIOR) return;
    if (!incomingProfile(T, ev.state, ev.target)) return;
    if (!contestsClaimable(T, ev.state, ev.target)) return;
    if (!useOncePerSequence(ev.state, `hearthkyn-salvager.secureSalvage:${ev.target.id}`)) return;
    ev.amount -= 1;
    log(ev.state, { kind: 'action', player: T.player, text: `Secure Salvage: ${ev.target.letter} takes 1 less damage` });
  });

  // ---- KINLYNK › SYSTEM JAM (the action's lasting half) ------------------
  // "When an enemy operative that has one of your System Jam tokens is activated, remove that
  //  token." (Its "cannot be activated until each enemy operative without one is expended" half
  //  has no seam — see the module footer.)
  reg.on('onActivationStart', T.bind(ACT_SYSTEM_JAM, 12), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!hasToken(ev.state, ev.operative.id, SYSTEM_JAM_TOKEN, T.player)) return;
    removeToken(ev.state, ev.operative.id, SYSTEM_JAM_TOKEN);
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.letter} shakes off the System Jam token` });
  });

  // ---- LOKÂTR › PAN SPECTRAL SCAN (the action's lasting effect) ----------
  // "Whenever a friendly HEARTHKYN SALVAGER operative is shooting an enemy operative that's
  //  within 3" of that marker, that friendly operative's ranged weapons have the Accurate 1 and
  //  Saturate weapon rules."
  reg.on('onWeaponRules', T.bind(ACT_SCAN, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    const marker = ev.state.markers[SCAN_MARKER(T.player)];
    if (!marker || T.markerGap(ev.target, marker) > 3 + EPS) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (PAN SPECTRAL SCAN)'), ruleTag('Saturate', undefined, 'Saturate (PAN SPECTRAL SCAN)'));
  });
  // "When this operative is next activated, is incapacitated or performs this action again
  //  (whichever comes first), remove that marker."
  reg.on('onActivationStart', T.bind(ACT_SCAN, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== LOKATR) return;
    delete ev.state.markers[SCAN_MARKER(T.player)];
  });
  reg.on('onIncapacitated', T.bind(ACT_SCAN, 13), (ev) => {
    if (ev.prevented || ev.operative.player !== T.player || ev.operative.datacardId !== LOKATR) return;
    delete ev.state.markers[SCAN_MARKER(T.player)];
  });

  // ---- GRENADIER › VÂYR-3 UTILITY GRENADE (the marker's effect + timer) --
  // "Whenever an operative is within 3" of that Utility Grenade marker, its controlling player
  //  must spend 1 additional AP for that operative to perform the Pick Up Marker and mission
  //  actions."
  reg.on('onActionCost', T.bind(ACT_UTILITY_GRENADE, 13), (ev) => {
    if (ev.action !== 'Pick Up Marker' && ev.action !== EXCAVATION_PICK_UP && !isMissionAction(ev.action)) return;
    const near = utilityMarkers(ev.state, T.player).some((m) => T.markerGap(ev.operative, m) <= 3 + EPS);
    if (near) ev.ap += 1;
  });
  // "In the Ready step of the next Strategy phase, roll one D3."
  reg.on('onReadyStep', T.bind(ACT_UTILITY_GRENADE, 14), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    for (const marker of utilityMarkers(ev.state, T.player)) {
      if (marker.flags['armed']) continue;
      const d3 = T.ctx.rng.d3();
      recordRoll(ev.state, 'utilityGrenade', [d3], T.player, 'VÂYR-3 UTILITY GRENADE duration');
      marker.flags['armed'] = true;
      marker.flags['activationsLeft'] = d3;
    }
  });
  // "Remove that Utility Grenade marker after a number of activations equal to the result have
  //  been completed…"
  reg.on('onActivationEnd', T.bind(ACT_UTILITY_GRENADE, 15), (ev) => {
    for (const marker of utilityMarkers(ev.state, T.player)) {
      if (!marker.flags['armed']) continue;
      const left = Number(marker.flags['activationsLeft'] ?? 0) - 1;
      if (left <= 0) delete ev.state.markers[marker.id];
      else marker.flags['activationsLeft'] = left;
    }
  });
  // "…or at the end of the turning point (whichever comes first)."
  reg.on('onEndOfTP', T.bind(ACT_UTILITY_GRENADE, 16), (ev) => {
    for (const marker of utilityMarkers(ev.state, T.player)) {
      if (marker.flags['armed']) delete ev.state.markers[marker.id];
    }
  });

  // ---- KNUX SMASH's free Charge: clear the grant when the activation ends -
  reg.on('onActivationEnd', T.bind(ACT_KNUX, 13), (ev) => {
    dropEffects(ev.state, (e) => e.rule === KNUX_CHARGE_READY && e.operativeId === ev.operative.id);
  });
}

/** "Once per battle" bookkeeping for MEDIKIT: who Medic! saved this turning point. */
function medicTargets(state: GameState): Record<string, string> {
  return bucket(state, 'hearthkyn-salvager.medicTarget') as Record<string, string>;
}

const utilityMarkers = (state: GameState, player: PlayerId): MarkerState[] =>
  Object.values(state.markers)
    .filter((m) => m.id.startsWith(`${UTILITY_MARKER_PREFIX}${player}.`))
    .sort(byId);

const chargedThisActivation = (op: OperativeState): boolean =>
  op.actionsThisActivation.includes('Charge') || op.actionsThisActivation.includes(FLY_CHARGE) || op.actionsThisActivation.includes(KNUX_CHARGE);

/** How much of an aggregated damage total is attributable to ONE normal success. */
function normalDamageSlice(
  state: GameState,
  incoming: { profile: WeaponProfile; melee: boolean },
  amount: number,
): number {
  const dmgN = incoming.profile.dmgN;
  if (dmgN <= 0) return 0;
  if (incoming.melee) {
    // A fight resolves one die at a time, so the amount IS the die's damage.
    return amount === dmgN ? dmgN : 0;
  }
  // A shoot aggregates every unblocked dice into one call: require an unblocked normal success.
  const seq = shootSeq(state);
  if (!seq || !seq.attack.dice.some((d) => d.state === 'normal')) return 0;
  return Math.min(dmgN, amount);
}

/** The KOGNITÂAR's Attack / Defence marker; only one of the two may be in the killzone. */
export function placeTacticianMarker(
  state: GameState,
  player: PlayerId,
  which: 'attack' | 'defence',
  pos: Vec2,
  ctx?: GameContext,
): MarkerState {
  delete state.markers[ATTACK_MARKER(player)];
  delete state.markers[DEFENCE_MARKER(player)];
  const id = which === 'attack' ? ATTACK_MARKER(player) : DEFENCE_MARKER(player);
  const marker: MarkerState = {
    id,
    kind: 'generic',
    diameterMm: 20,
    pos: { ...pos },
    z: ctx ? surfaceAt(terrain(ctx, state), pos) : 0,
    owner: player,
    flags: { placedTP: state.turningPoint, tactician: which },
  };
  state.markers[id] = marker;
  log(state, {
    kind: 'action',
    player,
    text: `Tactician: ${which === 'attack' ? 'Attack' : 'Defence'} marker placed`,
  });
  return marker;
}

/**
 * "An operative is along a beam line if a targeting line can be drawn from this operative to its
 * base, and that line crosses the base of the original target but doesn't cross Heavy terrain."
 *
 * The chosen line is the ray from the shooter's centre through the target's centre (the printed
 * "one (and only one) beam line" is the attacker's choice, so a deterministic default is taken —
 * D-016). An operative is on it when the ray passes through its base and it lies beyond the
 * target, and the segment from the shooter to it crosses no Heavy terrain.
 */
export function beamVictims(
  T: TeamHooks,
  state: GameState,
  shooter: OperativeState,
  target: OperativeState,
): OperativeState[] {
  if (!T.ctx) return [];
  const delta = sub(target.pos, shooter.pos);
  if (Math.hypot(delta.x, delta.y) < 1e-6) return [];
  const dir = norm(delta);
  const far = { x: shooter.pos.x + dir.x * 200, y: shooter.pos.y + dir.y * 200 };
  const heavy = terrain(T.ctx, state).parts.filter((p) => hasType(p, 'Heavy'));
  const targetProj = dot(sub(target.pos, shooter.pos), dir);
  return aliveOperatives(state)
    .filter((o) => {
      if (o.id === shooter.id || o.id === target.id) return false;
      const card = T.card(o);
      if (!card) return false;
      if (dot(sub(o.pos, shooter.pos), dir) < targetProj - EPS) return false;
      if (distancePointToSegment(o.pos, shooter.pos, far) > baseRadius(card.base) + EPS) return false;
      return !heavy.some((p) => segmentCrossesPoly(shooter.pos, o.pos, p.poly));
    })
    .sort(byId);
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- NEED KEEPS (strategy) ---------------------------------------------
  // "Select one objective marker or one of your mission markers."
  reg.on('onPloyUsed', T.bind(SP_NEED_KEEPS, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP_NEED_KEEPS) return;
    selectMarkerForPloy(T, ev.state, ev.data, NEED_KEEPS_EFFECT, SP_NEED_KEEPS);
  });
  // "Whenever determining control of that marker, treat the total APL stat of friendly HEARTHKYN
  //  SALVAGER operatives that contest it as 1 higher if at least one friendly HEARTHKYN SALVAGER
  //  operative contests that marker."
  reg.on('onMarkerControl', T.bind(SP_NEED_KEEPS, 21), (ev) => {
    if (!T.ctx) return;
    if (ploySelectedMarker(T, ev.state, NEED_KEEPS_EFFECT) !== ev.markerId) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const contested = T.friendlies(ev.state, KW).some((o) => markerContestedBy(T.ctx!, ev.state, marker, o));
    if (contested) ev.aplByPlayer[T.player] += 1;
  });
  // "Whenever a friendly HEARTHKYN SALVAGER operative is within 3" of that marker, add 1 to the
  //  Atk stat of its melee weapons (to a maximum of 4)…"
  reg.on('onCollectAttackDice', T.bind(SP_NEED_KEEPS, 22), (ev) => {
    if (ev.ctx.type !== 'melee' || !T.mineKw(ev.ctx.attacker, KW)) return;
    if (!nearNeedKeeps(T, ev.state, ev.ctx.attacker)) return;
    if (ev.ctx.profile.atk >= 4) return; // "…if the weapon already has an Atk stat of 4"
    ev.count = Math.min(4, ev.count + 1);
  });
  // "…if the weapon already has an Atk stat of 4, it has the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(SP_NEED_KEEPS, 22), (ev) => {
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    if (ev.profile.atk < 4) return;
    if (!nearNeedKeeps(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (NEED KEEPS)'));
  });

  // ---- WROUGHT DEFENCE (strategy) ----------------------------------------
  /**
   * "Whenever an operative is shooting a friendly HEARTHKYN SALVAGER operative, if you rolled one
   * or less successes (including any re-rolls), you can retain one of your fails as a normal
   * success instead of discarding it."
   *
   * The defence pool has no retention step of its own, so it is promoted at the `defenceRerolls`
   * emit (the Ratlings' IMPROVISED ARMOUR precedent) — and only on the pass where every re-roll
   * grant has already been offered, which is what "including any re-rolls" requires. Bound at 25
   * so the KOGNITÂAR's own Tactician grant (14) is already in `ev.rerolls`.
   */
  reg.on('onDefenceDice', T.bind(SP_WROUGHT_DEFENCE, 25), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_WROUGHT_DEFENCE)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (ev.rerolls.some((g) => !seq.usedRerolls.includes(g.id))) return; // a re-roll is still on offer
    if (successes(seq.defence).length > 1) return; // "one or less successes"
    const die = seq.defence.dice
      .filter((d) => d.state === 'fail' && d.note !== WROUGHT_NOTE)
      .sort((a, b) => b.value - a.value)[0];
    if (!die) return;
    die.state = 'normal';
    die.note = WROUGHT_NOTE;
    log(ev.state, { kind: 'dice', player: T.player, text: 'WROUGHT DEFENCE: a fail is retained as a normal success' });
  });

  // ---- TOIL EARNS (strategy) ---------------------------------------------
  // "Select one objective marker or one of your mission markers. Whenever an enemy operative is
  //  within 3" of that marker, treat it as having one additional Grudge token." (`effectiveGrudge`)
  reg.on('onPloyUsed', T.bind(SP_TOIL_EARNS, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP_TOIL_EARNS) return;
    selectMarkerForPloy(T, ev.state, ev.data, TOIL_EARNS_EFFECT, SP_TOIL_EARNS);
  });

  // ---- PROXIMATE FIREPOWER (strategy) ------------------------------------
  /**
   * "Whenever a friendly HEARTHKYN SALVAGER operative is shooting an enemy operative within 6" of
   * it, improve the Hit stat of that friendly operative's ranged weapons by 1 (to a maximum of
   * 3+). This can allow you to apply or remove the Hit stat change during an action (this takes
   * precedence over the core rules)."
   *
   * `onStatMod` is re-emitted on every `hitOf` call, so the "apply or remove during an action"
   * clause needs no extra machinery. `StatMods.hit` from `onCollectAttackDice` is dead.
   */
  reg.on('onStatMod', T.bind(SP_PROXIMATE_FIREPOWER, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_PROXIMATE_FIREPOWER)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target || T.gap(ev.operative, target) > 6 + EPS) return;
    const profile = profileOfShot(T, ev.state, ev.operative, seq);
    if (!profile) return;
    const card = T.card(ev.operative);
    const injured = card !== undefined && ev.operative.wounds < card.wounds / 2;
    // "(to a maximum of 3+)" measured against the stat as it would otherwise be.
    const current = profile.hit - ev.mods.hit + (injured ? 1 : 0);
    ev.mods.hit += Math.max(0, Math.min(1, current - 3));
  });

  // ---- THE ANCESTORS ARE WATCHING (firefight) ----------------------------
  // "Until the end of that activation, that operative can perform either a free Shoot or a free
  //  Fight action." — D-100: one free AP restricted to the two named actions, granted outside the
  //  APL budget so the operative gets the extra action even when a rule has already moved its APL.
  reg.on('onPloyUsed', T.bind(FP_ANCESTORS, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_ANCESTORS) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = active && T.mineKw(active, KW) ? active : chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW));
    if (!op) return;
    // "Until the end of THAT ACTIVATION" — the free AP is the last one spent (its `threshold` is
    // the operative's whole APL), so the operative keeps every AP of its own for whatever it
    // likes, and the effect expires with the activation the ploy named.
    grantFreeAction(ev.state, op, {
      sourceId: FP_ANCESTORS,
      sourceText: shortQuote(text(FP_ANCESTORS)),
      threshold: currentApl(T, ev.state, op),
      only: ['Shoot', 'Fight'],
    });
  });

  // ---- STURDY (firefight) ------------------------------------------------
  /**
   * "Use this firefight ploy when an operative is shooting a friendly HEARTHKYN SALVAGER
   * operative, when you collect your defence dice. Change the attacker's retained critical
   * successes to normal successes (any weapon rules they've already resolved aren't affected,
   * e.g. Piercing Crits)."
   *
   * Armed by the ploy and consumed by the FIRST Roll Defence Dice step after it (the Phobos
   * Transhuman Physiology precedent), so it cannot leak into every later shot of the turning
   * point. Piercing/Piercing Crits are computed one line above the emit, so the printed carve-out
   * for already-resolved weapon rules falls out of the engine's own ordering.
   */
  reg.on('onPloyUsed', T.bind(FP_STURDY, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_STURDY) return;
    bucket(ev.state, STURDY_ARMED)[T.player] = true;
  });
  reg.on('onDefenceDice', T.bind(FP_STURDY, 21), (ev) => {
    const armed = bucket(ev.state, STURDY_ARMED);
    if (!armed[T.player]) return;
    const seq = shootSeq(ev.state);
    const target = ev.ctx.defender;
    if (!seq || seq.step !== 'rollDefence' || !target || !T.mineKw(target, KW)) return;
    delete armed[T.player];
    let n = 0;
    for (const die of seq.attack.dice) {
      if (die.state !== 'crit') continue;
      die.state = 'normal';
      die.note = STURDY_NOTE;
      n++;
    }
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `STURDY: ${n} critical success${n === 1 ? '' : 'es'} become normal successes`,
    });
  });

  // ---- WORTH IT (firefight) ----------------------------------------------
  /**
   * REMINDER ONLY. "Use this firefight ploy when a friendly HEARTHKYN SALVAGER operative is
   * incapacitated. It can perform a free mission action before it's removed from the killzone."
   *
   * There is no intent for performing an action outside an activation, `onIncapacitated.freeActions`
   * is declared but never consumed, and `removeIncapacitatedAfterAction` clears the operative at
   * the end of the action that killed it — so the window the ploy names does not exist. The ploy
   * records the operative for the UI (the Exaction Squad's EXECUTION ORDER shape) and is reported.
   */
  reg.on('onPloyUsed', T.bind(FP_WORTH_IT, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_WORTH_IT) return;
    const dying = T.friendlies(ev.state, KW).find((o) => o.incapacitated);
    effect(ev.state, {
      rule: 'hearthkyn-salvager.worthIt',
      source: { kind: 'ploy', id: FP_WORTH_IT },
      sourceText: shortQuote(text(FP_WORTH_IT)),
      player: T.player,
      ...(dying ? { operativeId: dying.id } : {}),
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `WORTH IT: ${dying ? dying.letter : 'an incapacitated operative'} may perform a free mission action`,
    });
  });

  // ---- ENGAGE TO ACQUIRE (firefight) -------------------------------------
  /**
   * "Use this firefight ploy after rolling your attack dice for a friendly HEARTHKYN SALVAGER
   * operative, if it's shooting against or fighting against an enemy operative that controls an
   * objective marker or one of your mission markers. You can re-roll any of your attack dice."
   *
   * PARTIAL: `onRollAttack` is emitted by `shoot.ts` only (D-031), so the shooting half is exact
   * and the fighting half is unreachable.
   */
  reg.on('onPloyUsed', T.bind(FP_ENGAGE_TO_ACQUIRE, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_ENGAGE_TO_ACQUIRE) return;
    bucket(ev.state, ACQUIRE_ARMED)[T.player] = true;
  });
  reg.on('onRollAttack', T.bind(FP_ENGAGE_TO_ACQUIRE, 21), (ev) => {
    if (!bucket(ev.state, ACQUIRE_ARMED)[T.player]) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    if (!target || !controlsClaimable(T, ev.state, target)) return;
    ev.rerolls.push({
      id: 'hearthkyn-salvager.engageToAcquire',
      label: 'ENGAGE TO ACQUIRE: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text(FP_ENGAGE_TO_ACQUIRE)),
    });
  });
  reg.on('onActivationEnd', T.bind(FP_ENGAGE_TO_ACQUIRE, 22), (ev) => {
    if (ev.operative.player !== T.player) return;
    delete bucket(ev.state, ACQUIRE_ARMED)[T.player];
  });
}

/** The marker a NEED KEEPS / TOIL EARNS ploy named, from the intent's `data` or a logged default. */
function selectMarkerForPloy(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
  rule: string,
  sourceId: string,
): MarkerState | undefined {
  const candidates = claimableMarkers(T, state);
  if (candidates.length === 0) return undefined;
  const named = typeof data?.['markerId'] === 'string' ? candidates.find((m) => m.id === data['markerId']) : undefined;
  // D-016: the deterministic default is the marker closest to the friendly kill team's centre.
  const centre = centroidOf(T.friendlies(state, KW), { x: state.map.board.w / 2, y: state.map.board.h / 2 });
  const marker =
    named ?? [...candidates].sort((a, b) => dist(a.pos, centre) - dist(b.pos, centre) || (a.id < b.id ? -1 : 1))[0];
  if (!marker) return undefined;
  dropEffects(state, (e) => e.rule === rule && e.player === T.player);
  effect(state, {
    rule,
    source: { kind: 'ploy', id: sourceId },
    sourceText: shortQuote(text(sourceId)),
    player: T.player,
    data: { markerId: marker.id },
    expiry: { kind: 'endOfTurningPoint' },
  });
  log(state, { kind: 'ploy', player: T.player, text: `${sourceId.split('.').pop()}: ${marker.id}` });
  return marker;
}

const ploySelectedMarker = (T: TeamHooks, state: GameState, rule: string): string | undefined => {
  const id = effectFor(state, T.player, rule)?.data?.['markerId'];
  return typeof id === 'string' ? id : undefined;
};

function nearNeedKeeps(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const id = ploySelectedMarker(T, state, NEED_KEEPS_EFFECT);
  const marker = id ? state.markers[id] : undefined;
  return marker !== undefined && T.markerGap(op, marker) <= 3 + EPS;
}

function controlsClaimable(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  return claimableMarkers(T, state).some(
    (m) => markerContestedBy(T.ctx!, state, m, op) && markerController(T.ctx!, state, m) === op.player,
  );
}

/** The profile of the shot currently in flight, for the rules that need one at `onStatMod`. */
function profileOfShot(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
  seq: ShootSequence,
): WeaponProfile | undefined {
  if (!T.ctx) return undefined;
  const w = weaponsOf(T.ctx, state, op, 'ranged').find((x) => x.name === seq.weaponName);
  return w ? findProfile(w, seq.profileName) : undefined;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/**
 * "Friendly HEARTHKYN SALVAGER operatives have the following melee weapon." The printed table
 * gives Plasma Knives 3 / 4+ / 3-5 with `WR Lethal 5+`, but the scraper leaves `rules: []` on the
 * equipment weapon (a data problem, reported), so the WR row is sliced back out of the printed
 * text rather than retyped.
 */
export const PLASMA_KNIVES: Weapon = (() => {
  const entry = DATA.equipment.find((e) => e.id === EQ_PLASMA_KNIVES) as unknown as {
    text: string;
    weapons?: Weapon[];
  };
  const weapon = structuredClone(entry.weapons?.[0]) as Weapon;
  const profile = weapon.profiles[0];
  const wr = /\bWR\s*\n+\s*(.+?)\s*$/.exec(entry.text.trim());
  if (profile && profile.rules.length === 0 && wr?.[1]) profile.rules = parseWeaponRules(wr[1]);
  return weapon;
})();

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- PLASMA KNIVES -----------------------------------------------------
  // "Note that the FIELD MEDIC operative already has this weapon but with better stats; in that
  //  instance, use the better version." — the FIELD MEDIC's own Plasma Knife is Atk 4, so it is
  //  simply not granted the equipment copy.
  const armKnives = (state: GameState): void => {
    if (!hasEquipment(state, T.player, EQ_PLASMA_KNIVES)) return;
    for (const o of T.friendlies(state, KW)) {
      if (o.datacardId === FIELD_MEDIC) continue;
      grantWeapon(o, structuredClone(PLASMA_KNIVES));
    }
  };
  reg.on('onDeploy', T.bind(EQ_PLASMA_KNIVES, 30), (ev) => {
    if (ev.operative.player === T.player) armKnives(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ_PLASMA_KNIVES, 30), (ev) => armKnives(ev.state));
  reg.on('onReadyStep', T.bind(EQ_PLASMA_KNIVES, 30), (ev) => {
    if (ev.player === T.player) armKnives(ev.state);
  });

  // ---- EXCAVATION TOOLS --------------------------------------------------
  // "Friendly HEARTHKYN SALVAGER operatives can perform the Pick Up Marker action for 1 less AP…"
  reg.on('onActionCost', T.bind(EQ_EXCAVATION_TOOLS, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_EXCAVATION_TOOLS) || !T.mineKw(ev.operative, KW)) return;
    if (ev.action !== 'Pick Up Marker' && ev.action !== EXCAVATION_PICK_UP) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  // "…and don't have to control the marker to do so (taking precedence over that action's
  //  conditions – they only need to contest the marker)." The control test lives inside the
  //  universal action's own `check`, so the permitted form is its own ActionDef (D-021).

  // ---- CLIMBING RIGS -----------------------------------------------------
  // REMINDER ONLY. "When that operative is climbing up, you can treat the vertical distance as 2"
  // … When that operative is dropping, ignore the vertical distance." Both are per-LEG changes
  // inside `validateMove`, which keeps its `legs` to itself: `onMoveRules` is declared but never
  // emitted and `onMoveDistance` only scales the whole allowance. Reported as the seam this team
  // needs; no handler is registered, because one would be a silent no-op.

  // ---- WRIT OF CLAIM -----------------------------------------------------
  // REMINDER ONLY. "…after rolling off to decide initiative, you can use this rule. If you do,
  // you can re-roll your dice." `rollInitiative` reads only `initiativeRollModifiers.mod`;
  // `rerollOffered` is passed in and never consulted (the same gap the Phobos Strike Team's
  // Tactical Advantage reported). Reported; no handler is registered.
}

/** The three clauses this hook surface cannot express, with the reason, for the UI and the docs. */
export const REMINDER_ONLY: Record<string, string> = {
  [AB_WELL_SUPPLIED]: 'the reducer caps equipment at four options before onSelectEquipment is emitted',
  [EQ_CLIMBING_RIGS]: 'onMoveRules is declared but never emitted, so a move leg’s climb/drop cost cannot be changed',
  [EQ_WRIT_OF_CLAIM]: 'initiativeRollModifiers.rerollOffered is never consulted by rollInitiative',
  [ACT_SPOT]: 'the printed effect list is truncated out of the JSON (the text ends at "If you do:")',
  [FP_WORTH_IT]: 'no intent performs an action outside an activation, and onIncapacitated.freeActions is never consumed',
  [`${ACT_SYSTEM_JAM}.order`]: 'nothing hooks the choice of which operative activates next',
};

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

const enemiesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, otherPlayer(op.player)).sort(byId);
const friendliesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .sort(byId);
const hasKw = (ctx: GameContext, op: OperativeState, kw: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(kw);

/** "It must be visible to this operative, or on Vantage terrain of a terrain feature that's
 *  visible to this operative" — the marker is tested as a 20mm body on the surface beneath it. */
function markerVisibleFrom(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2): boolean {
  const index = terrain(ctx, state);
  const marker: Body = {
    id: 'marker',
    pos,
    z: surfaceAt(index, pos),
    rot: 0,
    base: { shape: 'round', mm: 20 },
    height: 0.2,
  };
  return isVisible(index, body(ctx, op), marker).visible;
}

/** A location an operative can legally be placed in. */
function placeable(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
): { ok: boolean; reason?: string; z?: number } {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const r = baseRadius(card.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, card.base, op.rot)) return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, card.base, op.rot, z, modelHeight(card)))
    return { ok: false, reason: 'it must be in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    const gap = Math.hypot(pos.x - other.pos.x, pos.y - other.pos.y) - r - baseRadius(oc.base);
    if (gap < -1e-4) return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true, z };
}

interface KnuxPlan {
  ok: boolean;
  reason?: string;
  victim?: OperativeState;
  pos?: Vec2;
  z?: number;
}

/**
 * KNUX SMASH 1AP: "Select one enemy operative within this operative's control range. You can move
 * that enemy operative up to 3" to a location it can be placed."
 *
 * Pure and shared by `check` and `perform` (D-026). With no position supplied the enemy is not
 * moved, which the printed rule explicitly allows ("even if you don't move it") and which is
 * always legal — so `check` can never accept something `perform` refuses.
 */
function planKnux(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): KnuxPlan {
  const foes = enemiesOf(state, op).filter((e) => inControlRange(ctx, state, op, e));
  const victim = foes.find((e) => e.id === (params.targetOperativeId ?? params.targetId)) ?? foes[0];
  // "This operative cannot perform this action unless an enemy operative is within its control range."
  if (!victim) return { ok: false, reason: 'no enemy operative within this operative’s control range' };
  const wanted = params.targetPos;
  if (!wanted || Math.hypot(wanted.x - victim.pos.x, wanted.y - victim.pos.y) < 1e-6)
    return { ok: true, victim, pos: { ...victim.pos }, z: victim.z };
  if (dist(victim.pos, wanted) > 3 + EPS) return { ok: false, reason: 'you can move that enemy operative up to 3"' };
  const spot = placeable(ctx, state, victim, wanted);
  if (!spot.ok) return { ok: false, reason: spot.reason ?? 'it must be a location it can be placed' };
  return { ok: true, victim, pos: { ...wanted }, z: spot.z ?? victim.z };
}

function actions(data: typeof DATA): ActionDef[] {
  const out: ActionDef[] = [];

  // KNUX SMASH — DÔZR
  out.push(
    uniqueAction(data, DOZR, ACT_KNUX, {
      check: (ctx, state, op, params) => {
        const plan = planKnux(ctx, state, op, params);
        return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'not possible' };
      },
      perform: (ctx, state, op, params) => {
        const plan = planKnux(ctx, state, op, params);
        if (!plan.ok || !plan.victim || !plan.pos) return { ok: false, reason: plan.reason ?? 'not possible' };
        const victim = plan.victim;
        victim.pos = { ...plan.pos };
        victim.z = plan.z ?? victim.z;
        // "Then inflict D3+1 damage on it (even if you don't move it); if the D3 result is a 3,
        //  also subtract 1 from that enemy operative's APL stat until the end of its next
        //  activation."
        const d3 = ctx.rng.d3();
        recordRoll(state, 'knuxSmash', [d3], op.player, 'KNUX SMASH D3+1');
        if (d3 === 3) {
          victim.aplMods.push(-1);
          effect(state, {
            rule: KNUX_APL,
            source: { kind: 'ability', id: ACT_KNUX },
            sourceText: shortQuote(actionTextOf(DOZR, ACT_KNUX)),
            operativeId: victim.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
          });
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: KNUX SMASH on ${victim.letter} (${d3}+1 damage)`,
        });
        // "This operative can then immediately perform a free Charge action (even if it's already
        //  performed the Charge action during that activation), but cannot move more than 3"
        //  during that action." — its own ActionDef, so action restrictions do not refuse it.
        effect(state, {
          rule: KNUX_CHARGE_READY,
          source: { kind: 'ability', id: ACT_KNUX },
          sourceText: shortQuote(actionTextOf(DOZR, ACT_KNUX)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        // D-100: the free AP is granted on top of the APL budget and is the LAST one the
        // operative spends, so its own AP stays its own. The printed "immediately" is therefore
        // relaxed to "before this activation ends".
        grantFreeAction(state, op, {
          sourceId: ACT_KNUX,
          sourceText: shortQuote(actionTextOf(DOZR, ACT_KNUX)),
          threshold: aplOf(ctx, state, op),
          kind: 'ability',
          only: [KNUX_CHARGE],
        });
        inflictDamage(ctx, state, victim, d3 + 1, 'attack');
        return { ok: true };
      },
    }),
  );

  // MEDIKIT — FIELD MEDIC
  out.push(
    uniqueAction(data, FIELD_MEDIC, ACT_MEDIKIT, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return medikitTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly HEARTHKYN SALVAGER operative within control range' };
      },
      perform: (ctx, state, op, params) => {
        const target = medikitTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        const heal = ctx.rng.d3() + ctx.rng.d3(); // "regain up to 2D3 lost wounds"
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: MEDIKIT restores ${heal} wounds to ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // VÂYR-3 UTILITY GRENADE — GRENADIER
  out.push(
    uniqueAction(data, GRENADIER, ACT_UTILITY_GRENADE, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const pos = params.markerPos ?? params.targetPos;
        if (!pos) return { ok: false, reason: 'select where to place the Utility Grenade marker' };
        if (dist(op.pos, pos) > 6 + EPS) return { ok: false, reason: 'the marker must be placed within 6" of this operative' };
        if (!markerVisibleFrom(ctx, state, op, pos)) return { ok: false, reason: 'that location is not visible to this operative' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const pos = (params.markerPos ?? params.targetPos)!;
        const id = `${UTILITY_MARKER_PREFIX}${op.player}.${state.seq++}`;
        state.markers[id] = {
          id,
          kind: 'generic',
          diameterMm: 20,
          pos: { ...pos },
          z: surfaceAt(terrain(ctx, state), pos),
          owner: op.player,
          flags: { utilityGrenade: true, armed: false },
        };
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: VÂYR-3 UTILITY GRENADE` });
        return { ok: true };
      },
    }),
  );

  // SIGNAL — KINLYNK
  out.push(
    uniqueAction(data, KINLYNK, ACT_SIGNAL, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return signalTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly HEARTHKYN SALVAGER operative in the killzone' };
      },
      perform: (ctx, state, op, params) => {
        const target = signalTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        target.aplMods.push(1); // "Until the end of that operative's next activation, add 1 to its APL stat."
        effect(state, {
          rule: SIGNAL_EFFECT,
          source: { kind: 'ability', id: ACT_SIGNAL },
          sourceText: shortQuote(actionTextOf(KINLYNK, ACT_SIGNAL)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
        return { ok: true };
      },
    }),
  );

  // SYSTEM JAM — KINLYNK
  out.push(
    uniqueAction(data, KINLYNK, ACT_SYSTEM_JAM, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return systemJamTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative that’s a valid target and has no System Jam token' };
      },
      perform: (ctx, state, op, params) => {
        const target = systemJamTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        giveToken(state, target, SYSTEM_JAM_TOKEN, {
          sourceId: ACT_SYSTEM_JAM,
          sourceText: shortQuote(actionTextOf(KINLYNK, ACT_SYSTEM_JAM)),
          player: op.player,
          expiry: { kind: 'endOfBattle' }, // "Until the end of the battle"
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SYSTEM JAM on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // ACCELERATED APPRAISAL — KOGNITÂAR
  out.push(
    uniqueAction(data, KOGNITAAR, ACT_APPRAISAL, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (ctx, state, op, params) => {
        // "If your Attack or Defence marker is in the killzone, remove it. Place your Attack or
        //  Defence marker in the killzone."
        const which = params.choice === 'defence' ? 'defence' : 'attack';
        const pos = params.markerPos ?? params.targetPos ?? { ...op.pos };
        placeTacticianMarker(state, op.player, which, pos, ctx);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: ACCELERATED APPRAISAL (${which})` });
        return { ok: true };
      },
    }),
  );

  // SPOT — LOKÂTR
  out.push(
    uniqueAction(data, LOKATR, ACT_SPOT, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return visibleEnemy(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (_ctx, state, op, params) => {
        const target = visibleEnemy(_ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        // DATA-BLOCKED: the printed effect list is truncated out of the JSON — the text ends at
        // "If you do:" with nothing after it — so the token is placed and NOTHING is applied.
        giveToken(state, target, SPOT_TOKEN, {
          sourceId: ACT_SPOT,
          sourceText: shortQuote(actionTextOf(LOKATR, ACT_SPOT)),
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' }, // "Until the end of the turning point"
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SPOT on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // PAN SPECTRAL SCAN — LOKÂTR
  out.push(
    uniqueAction(data, LOKATR, ACT_SCAN, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (ctx, state, op, params) => {
        // "…or performs this action again (whichever comes first), remove that marker."
        const id = SCAN_MARKER(op.player);
        delete state.markers[id];
        const pos = params.markerPos ?? params.targetPos ?? { ...op.pos };
        state.markers[id] = {
          id,
          kind: 'generic',
          diameterMm: 20,
          pos: { ...pos },
          z: surfaceAt(terrain(ctx, state), pos),
          owner: op.player,
          flags: { panSpectralScan: true },
        };
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: PAN SPECTRAL SCAN` });
        return { ok: true };
      },
    }),
  );

  return out;
}

function medikitTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const mates = friendliesOf(state, op)
    .filter((o) => hasKw(ctx, o, KW))
    .filter((o) => inControlRange(ctx, state, op, o))
    // "It cannot be an operative that the Medic! rule was used on during this turning point."
    .filter((o) => !Object.values(medicTargets(state)).includes(o.id));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function signalTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const mates = friendliesOf(state, op).filter((o) => hasKw(ctx, o, KW));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function visibleEnemy(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const foes = enemiesOf(state, op).filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible);
  return foes.find((e) => e.id === chosen) ?? foes[0];
}

/** "Select one enemy operative that's a valid target for this operative and that doesn't have one
 *  of your System Jam tokens." The KINLYNK's own ranged weapon supplies the target check. */
function systemJamTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const weapon = weaponsOf(ctx, state, op, 'ranged')[0];
  const profile = weapon ? findProfile(weapon) : undefined;
  if (!weapon || !profile) return undefined;
  const foes = enemiesOf(state, op)
    .filter((e) => !hasToken(state, e.id, SYSTEM_JAM_TOKEN, op.player))
    .filter((e) => {
      const rules = effectiveRules(ctx, state, profile, { operative: op, target: e, weaponName: weapon.name });
      return checkTarget(ctx, state, op, e, profile, rules).valid;
    });
  return foes.find((e) => e.id === chosen) ?? foes[0];
}

// ---------------------------------------------------------------------------
// Actions the universal ones forbid (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/**
 * EXCAVATION TOOLS: "…and don't have to control the marker to do so (taking precedence over that
 * action's conditions – they only need to contest the marker)."
 */
registerAction({
  id: EXCAVATION_PICK_UP,
  name: EXCAVATION_PICK_UP,
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: text(EQ_EXCAVATION_TOOLS),
  available: (ctx, state, op) =>
    state.teams[op.player].equipment.includes(EQ_EXCAVATION_TOOLS) && hasKw(ctx, op, KW),
  check(ctx, state, op, params) {
    if (!state.teams[op.player].equipment.includes(EQ_EXCAVATION_TOOLS))
      return { ok: false, reason: 'your kill team has not selected Excavation Tools' };
    if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker) return { ok: false, reason: 'no such marker' };
    if (!marker.flags['pickUpAllowed']) return { ok: false, reason: 'this marker cannot be picked up' };
    if (!markerContestedBy(ctx, state, marker, op)) return { ok: false, reason: 'it does not contest that marker' };
    return { ok: true };
  },
  perform: (ctx, state, op, params) => getAction('Pick Up Marker')!.perform(ctx, state, op, params),
});

/**
 * KNUX SMASH's free Charge. Its own id — not `treatedAs: 'Charge'` — because the printed rule
 * lifts exactly one restriction ("even if it's already performed the Charge action during that
 * activation"); every other Charge condition is re-applied here, plus the printed 3" cap.
 */
registerAction({
  id: KNUX_CHARGE,
  name: KNUX_CHARGE,
  ap: 1,
  type: 'unique',
  sourceText: actionTextOf(DOZR, ACT_KNUX),
  available: (_ctx, state, op) =>
    state.effects.some((e) => e.rule === KNUX_CHARGE_READY && e.operativeId === op.id),
  check(ctx, state, op, params) {
    const r = knuxCharge(ctx, state, op, params, false);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'not possible' };
  },
  perform(ctx, state, op, params) {
    return knuxCharge(ctx, state, op, params, true);
  },
});

function knuxCharge(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  apply: boolean,
): { ok: boolean; reason?: string } {
  if (!state.effects.some((e) => e.rule === KNUX_CHARGE_READY && e.operativeId === op.id))
    return { ok: false, reason: 'this operative has not performed KNUX SMASH this activation' };
  if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
  if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
    return { ok: false, reason: 'already within control range of an enemy operative' };
  if (['Reposition', 'Dash', 'Fall Back'].some((a) => op.actionsThisActivation.includes(a)))
    return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const counteracting = state.opState['counteract']?.['operativeId'] === op.id;
  const v = validateMove(ctx, state, op, params.path, {
    action: 'Charge',
    bonusInches: 2,
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
    hardCap: counteracting ? 2 : 3, // "cannot move more than 3" during that action"
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  if (!apply) return { ok: true };
  op.pos = { ...v.endPos };
  op.z = v.endZ;
  if (params.path.endRot !== undefined) op.rot = params.path.endRot;
  op.onGuard = false;
  op.stickyEngagedWith = aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => inControlRange(ctx, state, op, e))
    .map((e) => e.id);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} performs ${KNUX_CHARGE} (${v.total}")`,
    data: { operativeId: op.id, action: KNUX_CHARGE, inches: v.total },
  });
  return { ok: true };
}

/**
 * JUMP PACK WARRIOR › Jump Pack. "Whenever this operative performs an action in which it moves,
 * it can FLY. If it does, don't move it. Instead, remove it from the killzone and set it back up
 * wholly within a distance equal to its Move stat (or 3" if it was a Dash) horizontally of its
 * original location."
 *
 * `onMoveRules.teleport` is declared but never emitted, so FLY is four sibling `ActionDef`s, each
 * `treatedAs` its universal action (D-021 — the Sanctifiers' CHERUB Fly precedent).
 */
function flyDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2 | undefined,
  mode: 'Reposition' | 'Dash' | 'Fall Back' | 'Charge',
): { ok: boolean; reason?: string; pos?: Vec2; z?: number } {
  if (!pos) return { ok: false, reason: 'select a location to be set up in' };
  if (dist(op.pos, pos) < 0.01) return { ok: false, reason: 'select a different location to be set up in' };
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  // "Note that it gains no additional distance when performing the Charge action."
  const max = mode === 'Dash' ? 3 : moveOf(ctx, state, op);
  // Close quarters: "this distance cannot be measured over or through Wall terrain".
  const travelled = state.map.closeQuarters ? wallRouteDistance(index, op.pos, pos) : dist(op.pos, pos);
  // "…set it back up WHOLLY WITHIN a distance equal to its Move stat horizontally".
  if (travelled + baseRadius(card.base) > max + EPS) return { ok: false, reason: `it can only FLY wholly within ${max}"` };
  // "…and that operative cannot be set up on the other side of an access point — in other words
  //  it cannot FLY through an open hatchway."
  if (
    state.map.closeQuarters &&
    index.parts.some((p) => p.role === 'accessPoint' && segmentCrossesPoly(op.pos, pos, p.poly))
  )
    return { ok: false, reason: 'it cannot FLY through an access point' };
  const spot = placeable(ctx, state, op, pos);
  if (!spot.ok) return { ok: false, reason: spot.reason ?? 'it must be set up in a location it can be placed' };
  const landed: Body = { id: op.id, pos, z: spot.z ?? 0, rot: op.rot, base: card.base, height: modelHeight(card) };
  const engagedThere = aliveOperatives(state, otherPlayer(op.player)).some((e) =>
    withinControlRange(index, landed, body(ctx, e)),
  );
  if (mode === 'Charge' && !engagedThere)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };
  // "unless it's the CHARGE action, it cannot be set up within control range of an enemy operative"
  if (mode !== 'Charge' && engagedThere)
    return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
  return { ok: true, pos, z: spot.z ?? 0 };
}

function flyAction(id: string, name: string, mode: 'Reposition' | 'Dash' | 'Fall Back' | 'Charge', ap: number): ActionDef {
  return {
    id,
    name,
    ap,
    type: 'unique',
    treatedAs: mode,
    sourceText: abilityText(JUMP_PACK_WARRIOR, AB_JUMP_PACK),
    available: (_ctx, _state, op) => op.datacardId === JUMP_PACK_WARRIOR,
    check(ctx, state, op, params) {
      const engaged = aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e));
      const did = (a: string): boolean => op.actionsThisActivation.includes(a);
      if (mode === 'Reposition') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Fall Back') || did('Charge')) return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      } else if (mode === 'Dash') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Charge')) return { ok: false, reason: 'already performed Charge this activation' };
      } else if (mode === 'Fall Back') {
        if (!engaged) return { ok: false, reason: 'no enemy operative within control range' };
        if (did('Reposition') || did('Charge')) return { ok: false, reason: 'already performed Reposition or Charge this activation' };
      } else {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (engaged) return { ok: false, reason: 'already within control range of an enemy operative' };
        if (did('Reposition') || did('Dash') || did('Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      const d = flyDestination(ctx, state, op, params.targetPos, mode);
      return d.ok ? { ok: true } : { ok: false, reason: d.reason ?? 'it cannot FLY there' };
    },
    perform(ctx, state, op, params) {
      const d = flyDestination(ctx, state, op, params.targetPos, mode);
      if (!d.ok || !d.pos) return { ok: false, reason: d.reason ?? 'it cannot FLY there' };
      op.pos = { ...d.pos };
      op.z = d.z ?? 0;
      op.onGuard = false;
      if (op.carryingMarkerId) {
        const m = state.markers[op.carryingMarkerId];
        if (m) {
          m.pos = { ...op.pos };
          m.z = op.z;
        }
      }
      if (mode === 'Charge') {
        op.stickyEngagedWith = aliveOperatives(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
      }
      log(state, { kind: 'action', player: op.player, text: `${op.letter} FLIES (${name})` });
      return { ok: true };
    },
  };
}

registerAction(flyAction(FLY_REPOSITION, 'Reposition (Jump Pack)', 'Reposition', 1));
registerAction(flyAction(FLY_DASH, 'Dash (Jump Pack)', 'Dash', 1));
registerAction(flyAction(FLY_FALL_BACK, 'Fall Back (Jump Pack)', 'Fall Back', 2));
registerAction(flyAction(FLY_CHARGE, 'Charge (Jump Pack)', 'Charge', 1));

/**
 * GRENADIER › "This operative can use … smoke and stun grenades." The universal Smoke/Stun
 * Grenade actions are gated on the Utility Grenades equipment, so the GRENADIER gets its own
 * pair (the Kommandos' Taktical Wot-notz shape). "Doing so doesn't count towards any limited
 * uses you have" — the kill team's grenade budget is restored after the delegated perform.
 */
function grenadierGrenade(id: string, name: string, delegate: string): void {
  registerAction({
    id,
    name,
    ap: 1,
    type: 'unique',
    sourceText: abilityText(GRENADIER, AB_GRENADIER),
    available: (_ctx, _state, op) => op.datacardId === GRENADIER,
    check(ctx, state, op, params) {
      if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
        return { ok: false, reason: 'within control range of an enemy operative' };
      // The delegated universal action gets the final say, with its kill-team budget ignored.
      const relaxed = withGrenadeBudgetIgnored(state, op.player);
      return getAction(delegate)!.check(ctx, relaxed, op, params);
    },
    perform(ctx, state, op, params) {
      const uses = { ...state.teams[op.player].equipmentUses };
      // The universal action refuses when the kill team has no allowance at all, so it is floored
      // for the duration of this action and restored immediately afterwards.
      state.teams[op.player].equipmentUses = { ...withGrenadeBudgetIgnored(state, op.player).teams[op.player].equipmentUses };
      const res = getAction(delegate)!.perform(ctx, state, op, params);
      state.teams[op.player].equipmentUses = uses;
      return res;
    },
  });
}

grenadierGrenade(GRENADIER_SMOKE, 'Smoke Grenade (Grenadier)', 'Smoke Grenade');
grenadierGrenade(GRENADIER_STUN, 'Stun Grenade (Grenadier)', 'Stun Grenade');

// ---------------------------------------------------------------------------

export const hearthkynSalvager = defineTeam({
  id: 'hearthkyn-salvager',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy during a friendly HEARTHKYN SALVAGER operative's activation."
    [FP_ANCESTORS]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'only during a friendly HEARTHKYN SALVAGER operative’s activation' };
    },
    // "…when an operative is shooting a friendly HEARTHKYN SALVAGER operative, when you collect
    //  your defence dice."
    [FP_STURDY]: (state, player) => {
      const seq = state.sequence;
      return seq?.kind === 'shoot' && seq.defender === player && seq.attacker !== player
        ? { ok: true }
        : { ok: false, reason: 'only while a friendly operative is being shot' };
    },
    // "…when a friendly HEARTHKYN SALVAGER operative is incapacitated."
    [FP_WORTH_IT]: (state, player) =>
      aliveOperatives(state, player).some((o) => o.incapacitated)
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative has just been incapacitated' },
    // "…after rolling your attack dice for a friendly HEARTHKYN SALVAGER operative."
    [FP_ENGAGE_TO_ACQUIRE]: (state, player) => {
      const seq = state.sequence;
      const ok = Boolean(seq) && (seq!.kind === 'shoot' ? seq!.attacker === player : seq!.attacker === player || seq!.defender === player);
      return ok ? { ok: true } : { ok: false, reason: 'only after rolling your attack dice' };
    },
  },
  aiHints: {
    roles: {
      [THEYN]: 'leader',
      [DOZR]: 'melee',
      [FIELD_MEDIC]: 'support',
      [GRENADIER]: 'gunner',
      [GUNNER]: 'gunner',
      [JUMP_PACK_WARRIOR]: 'melee',
      [KINLYNK]: 'support',
      [KOGNITAAR]: 'support',
      [LOKATR]: 'scout',
      [LUGGER]: 'objective',
      [WARRIOR]: 'objective',
    },
    ployValue: {
      [SP_NEED_KEEPS]: 0.6,
      [SP_WROUGHT_DEFENCE]: 0.5,
      [SP_TOIL_EARNS]: 0.5,
      [SP_PROXIMATE_FIREPOWER]: 0.7,
      [FP_ANCESTORS]: 0.7,
      [FP_STURDY]: 0.6,
      [FP_WORTH_IT]: 0.1,
      [FP_ENGAGE_TO_ACQUIRE]: 0.5,
    },
    equipmentValue: {
      [EQ_PLASMA_KNIVES]: 0.6,
      [EQ_EXCAVATION_TOOLS]: 0.5,
      [EQ_CLIMBING_RIGS]: 0.2,
      [EQ_WRIT_OF_CLAIM]: 0.2,
    },
  },
});

export default hearthkynSalvager;
