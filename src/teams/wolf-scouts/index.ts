/**
 * WOLF SCOUTS — Space Marines (Space Wolves).
 * https://wahapedia.ru/kill-team3/kill-teams/wolf-scouts/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/wolf-scouts.json`, never retyped.
 *
 * The whole team hangs off one piece of state: **your Storm marker**. `Elemental Storm` (and
 * the RUNE PRIEST SKJALD's CALL THE STORM) places it; "within your STORM" is 6" horizontally
 * from it, and eight other rules read that. It is a per-player marker
 * (`wolf-scouts.storm.<player>`), so a Wolf Scouts mirror match keeps two of them.
 *
 * Rare weapon rule: `PSYCHIC` is a keyword with no printed definition of its own (see
 * `data/teams/_rare-weapon-rules.json` — the entry carries `referencedIn`, not a definition).
 * It has no behaviour to implement; it is READ by Hunting Astartes ("You cannot select two
 * PSYCHIC ranged weapons"), which is implemented below.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { countCrits, piercingValue, successes, type DicePool } from '../../core/dice.ts';
import { baseGap, baseRadius, dist, mmToInches } from '../../core/geometry.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { validTargets } from '../../core/sequences/shoot.ts';
import {
  aliveOperatives,
  card as cardOfOp,
  enemiesInControlRange,
  inControlRange,
  inflictDamage,
  log,
  recordRoll,
} from '../../core/state.ts';
import type { GameContext } from '../../core/context.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  WeaponRule,
} from '../../core/types.ts';
import { UNIVERSAL_WEAPON_RULES } from '../../core/weaponRules.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  centroidOf,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  isInjuredCard,
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
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('wolf-scouts');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const uniqueActionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const KW = 'WOLF SCOUT';
const FENRISIAN = 'FENRISIAN WOLF';

const PACK_LEADER = 'wolf-scouts.pack-leader';
const FANGBEARER = 'wolf-scouts.fangbearer';
const FROSTEYE = 'wolf-scouts.frosteye';
const GUNNER = 'wolf-scouts.gunner';
const HUNTER = 'wolf-scouts.hunter';
const RUNE_PRIEST = 'wolf-scouts.rune-priest-skjald';
const TRAPMASTER = 'wolf-scouts.trapmaster';
const FENRISIAN_WOLF = 'wolf-scouts.fenrisian-wolf';

export const ELEMENTAL_STORM_GAMBIT = 'wolf-scouts.rule.elemental-storm';
export const POUNCE_GAMBIT = 'wolf-scouts.fenrisian-wolf.pounce';

/** Effects (namespaced scratch — architecture rule 7 forbids module-level mutable state). */
const CALL_STORM_EFFECT = 'wolf-scouts.callTheStorm';
const HUNTERS_SENSES_EFFECT = 'wolf-scouts.huntersSenses';
const ACUTE_SENSES_EFFECT = 'wolf-scouts.acuteSenses';
const GRIZZLED_EFFECT = 'wolf-scouts.grizzledVeteran';
const POUNCE_EFFECT = 'wolf-scouts.pounce';
const COUNTERATTACK_EFFECT = 'wolf-scouts.counterattack';
/** The ranged weapon used by the FIRST Shoot of an activation (Hunting Astartes reads it). */
export const LAST_RANGED = 'wolf-scouts.lastRangedWeapon';

/** Extra ActionDefs (D-021: `canPerformAction` can only forbid, never permit). */
export const CHARGE_STORM = 'Charge (Elemental Storm)';
export const CHARGE_INSTINCT = 'Charge (Instinctive Predator)';
export const SHOOT_HUNTING = 'Shoot (Hunting Astartes)';
export const SHOOT_HUNTING_PLASMA = 'Shoot (Hunting Astartes, plasma)';
export const FIGHT_HUNTING = 'Fight (Hunting Astartes)';
export const FIGHT_COUNTERATTACK = 'Fight (Counterattack)';
export const GUARD_STORM_VEILED = 'Guard (Storm-veiled Execution)';
export const CHANGE_ORDER_COUNTERACT = 'Change Order (Hunting Astartes)';
export const PLACE_HAYWIRE = 'Place Marker (Haywire Mine)';

const MARKER_20: BaseShape = { shape: 'round', mm: 20 };
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

// ---------------------------------------------------------------------------
// STORM — "Whenever an operative is within 6" horizontally of your Storm marker,
//          it's within your STORM."
// ---------------------------------------------------------------------------

export const stormMarkerId = (player: PlayerId): string => `wolf-scouts.storm.${player}`;

export function stormMarkerOf(state: GameState, player: PlayerId): MarkerState | undefined {
  return state.markers[stormMarkerId(player)];
}

/** Base-to-marker, which is horizontal by construction (positions are 2D). */
function withinStormBase(state: GameState, player: PlayerId, pos: Vec2, base: BaseShape, rot: number): boolean {
  const m = stormMarkerOf(state, player);
  if (!m) return false;
  return baseGap(pos, base, rot, m.pos, { shape: 'round', mm: m.diameterMm }, 0) <= 6 + 1e-6;
}

/** "wholly within your STORM" — the furthest point of the base is still within 6". */
function whollyWithinStormBase(state: GameState, player: PlayerId, pos: Vec2, base: BaseShape): boolean {
  const m = stormMarkerOf(state, player);
  if (!m) return false;
  return dist(pos, m.pos) + baseRadius(base) - mmToInches(m.diameterMm) / 2 <= 6 + 1e-6;
}

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? DEFAULT_BASE;

/** Is this operative within MY storm? (`T.player`'s Storm marker, whoever the operative is.) */
export function withinStorm(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return withinStormBase(state, T.player, op.pos, baseOf(T, op), op.rot);
}

export function whollyWithinStorm(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return whollyWithinStormBase(state, T.player, op.pos, baseOf(T, op));
}

function placeStorm(state: GameState, player: PlayerId, pos: Vec2, sourceId: string): void {
  removeMarker(state, stormMarkerId(player));
  placeTeamMarker(state, { id: stormMarkerId(player), kind: 'generic', player, pos, flags: { storm: true } });
  log(state, {
    kind: 'ploy',
    player,
    text: `Storm marker placed at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`,
    data: { source: sourceId },
  });
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

/** "(excluding FENRISIAN WOLF)" — the shape half this team's rules are written in. */
const isScoutNotWolf = (T: TeamHooks, op: OperativeState): boolean => T.mineKw(op, KW) && !T.kw(op, FENRISIAN);

const isPlasma = (weaponName: string): boolean => /plasma (gun|pistol)/i.test(weaponName);

function weaponOn(ctx: GameContext | undefined, op: OperativeState, name: string) {
  return ctx?.datacards.get(op.datacardId)?.weapons.find((w) => w.name === name);
}

function isPsychicWeapon(ctx: GameContext, op: OperativeState, name: string): boolean {
  const w = weaponOn(ctx, op, name);
  return Boolean(w?.profiles.some((p) => p.rules.some((r) => r.id === 'PSYCHIC')));
}

/** A stable identity for "the remainder of that action" / "during that sequence". */
function sequenceStamp(state: GameState): string {
  const s = state.sequence;
  if (!s) return `none:${state.activeOperativeId ?? ''}:${state.turningPoint}:${state.activationsThisTP}`;
  const target = s.kind === 'shoot' ? s.targetId : s.defenderId;
  return `${s.kind}:${s.attackerId}:${target}`;
}

/** The weapon profile one side of a fight is using (for "…from one normal success"). */
function fightProfile(T: TeamHooks, state: GameState, seq: FightSequence, side: 'attacker' | 'defender') {
  const holder = state.operatives[side === 'attacker' ? seq.attackerId : seq.defenderId];
  if (!holder) return undefined;
  const name = side === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const profileName = side === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  return weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  elementalStorm(reg, T);
  huntingAstartes(reg, T);
  packLeader(reg, T);
  fangbearer(reg, T);
  frosteyeGunnerHunter(reg, T);
  runePriest(reg, T);
  trapmaster(reg, T);
  fenrisianWolf(reg, T);
}

// ---- Elemental Storm (faction rule 1) --------------------------------------

function elementalStorm(reg: HookRegistry, T: TeamHooks): void {
  // "STRATEGIC GAMBIT. Remove your Storm marker from the killzone (if any), then place it in
  //  the killzone." Costs no CP, so it is its own gambit option rather than a strategy ploy.
  reg.on('gambitOptions', T.bind(ELEMENTAL_STORM_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player) return;
    ev.options.push({
      id: ELEMENTAL_STORM_GAMBIT,
      label: 'Elemental Storm: place your Storm marker',
      sourceText: shortQuote(text(ELEMENTAL_STORM_GAMBIT)),
    });
  });
  reg.on('onPloyUsed', T.bind(ELEMENTAL_STORM_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== ELEMENTAL_STORM_GAMBIT) return;
    // D-016: a position the player did not supply comes from a deterministic, logged default.
    const fallback = centroidOf(T.friendlies(ev.state, KW), {
      x: ev.state.map.board.w / 2,
      y: ev.state.map.board.h / 2,
    });
    placeStorm(ev.state, T.player, posFromData(ev.data, fallback), ELEMENTAL_STORM_GAMBIT);
  });

  // "Each friendly WOLF SCOUT operative can perform the Charge action while it has a Conceal
  //  order if it ends that action within your STORM." — the `Charge (Elemental Storm)` action.
}

// ---- Hunting Astartes (faction rule 2) -------------------------------------

function huntingAstartes(reg: HookRegistry, T: TeamHooks): void {
  // Remember the ranged weapon used, so the second Shoot can enforce
  // "1 additional AP … if both actions are using a plasma gun or plasma pistol" and
  // "You cannot select two PSYCHIC ranged weapons."
  reg.on('onCollectAttackDice', T.bind('wolf-scouts.rule.hunting-astartes', 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: 'wolf-scouts.rule.hunting-astartes' },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  // "Each friendly WOLF SCOUT operative can counteract regardless of its order."
  //
  // `counteractCandidates` (`src/core/phases.ts`) emits `onCounteract` for every expended,
  // not-yet-counteracted operative with `allowed: o.order === 'engage'` as the DEFAULT, so this
  // handler WIDENS that list rather than only being able to narrow it. It therefore only ever
  // sets `true`: "expended", "once during the turning point" and the On Guard lockout stay the
  // core's conditions and keep applying.
  //
  // Scope is exactly as printed — friendly (`T.player`) operatives with the WOLF SCOUT keyword,
  // which every datacard on this team carries, FENRISIAN WOLF included. An enemy operative is
  // never touched here; a Wolf Scouts mirror match gets the same widening from the opponent's
  // own registration of this rule.
  reg.on('onCounteract', T.bind('wolf-scouts.rule.hunting-astartes', 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    ev.allowed = true;
  });

  // The rest of the clause — "Whenever it does so within your STORM, you can change its order
  // first, or change its order instead of performing an action" — is the
  // `Change Order (Hunting Astartes)` action registered below.
}

// ---- PACK LEADER -----------------------------------------------------------

function packLeader(reg: HookRegistry, T: TeamHooks): void {
  // Lupine Guile is reminder-only: `initiativeRollModifiers` is emitted BEFORE the dice are
  // rolled and `rerollOffered` is never read back, so there is nowhere to re-roll from.

  // Grizzled Veteran.
  reg.on('onIncapacitated', T.bind('wolf-scouts.pack-leader.grizzled-veteran', 11), (ev) => {
    const op = ev.operative;
    if (op.datacardId !== PACK_LEADER || op.player !== T.player || ev.prevented) return;
    const stamp = sequenceStamp(ev.state);
    const armed = effectOn(ev.state, op.id, GRIZZLED_EFFECT);
    // "…and cannot be incapacitated for the remainder of the action."
    if (armed) {
      if (armed.data?.['stamp'] !== stamp) return;
      ev.prevented = true;
      return;
    }
    // "The first time this operative would be incapacitated during the battle…"
    if (!useOncePerBattle(ev.state, `wolf-scouts.grizzled:${op.id}`)) return;
    ev.prevented = true; // the core then sets it to 1 wound
    effect(ev.state, {
      rule: GRIZZLED_EFFECT,
      source: { kind: 'ability', id: 'wolf-scouts.pack-leader.grizzled-veteran' },
      sourceText: shortQuote(abilityText(PACK_LEADER, 'wolf-scouts.pack-leader.grizzled-veteran')),
      operativeId: op.id,
      player: T.player,
      data: { stamp },
      expiry: ev.state.activeOperativeId
        ? { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId }
        : { kind: 'endOfTurningPoint' },
    });
    // "All remaining attack dice are discarded (including yours if this operative is fighting
    //  or retaliating)."
    discardRemainingAttackDice(ev.state);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Grizzled Veteran: ${op.letter} survives on 1 wound and the remaining attack dice are discarded`,
    });
  });
}

function discardRemainingAttackDice(state: GameState): void {
  const seq = state.sequence;
  if (!seq) return;
  const pools = seq.kind === 'shoot' ? [seq.attack] : [seq.attackerPool, seq.defenderPool];
  for (const pool of pools) {
    for (const die of pool.dice) {
      if (die.state === 'crit' || die.state === 'normal') {
        die.state = 'discarded';
        die.note = 'Grizzled Veteran';
      }
    }
  }
  if (seq.kind === 'fight') seq.step = 'done';
}

/** "You cannot use the Counterattack firefight ploy … at the end of that action." */
export function grizzledBlocks(state: GameState, player: PlayerId): boolean {
  return state.effects.some((e) => e.rule === GRIZZLED_EFFECT && e.player === player);
}

/** "…or inflict damage as a result of the Savage Fighters strategy ploy at the end of that action." */
function grizzledBlocksThisSequence(state: GameState, player: PlayerId): boolean {
  const stamp = sequenceStamp(state);
  return state.effects.some(
    (e) => e.rule === GRIZZLED_EFFECT && e.player === player && e.data?.['stamp'] === stamp,
  );
}

// ---- FANGBEARER › Spiritual Chirurgy ---------------------------------------

/**
 * "Note that friendly operatives have this rule if you SELECT this operative for the battle
 * (even if it's incapacitated later)" — so removed operatives still count.
 */
function fangbearerSelected(T: TeamHooks, state: GameState): boolean {
  return Object.values(state.operatives).some((o) => o.player === T.player && o.datacardId === FANGBEARER);
}

function fangbearer(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onStatMod', T.bind('wolf-scouts.fangbearer.spiritual-chirurgy', 12), (ev) => {
    const op = ev.operative;
    if (!isScoutNotWolf(T, op)) return;
    if (!isInjuredCard(T.card(op), op)) return;
    if (!fangbearerSelected(T, ev.state)) return;
    // The two stat changes an injured operative suffers, cancelled where the engine reads them:
    // `moveOf` subtracts 2 and `hitOf` worsens the Hit stat by 1 (that is the "weapons' stats"
    // half). Both consult `statMods`.
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });
}

// ---- FROSTEYE / GUNNER / HUNTER --------------------------------------------

function frosteyeGunnerHunter(reg: HookRegistry, T: TeamHooks): void {
  // FROSTEYE › HUNTER'S SENSES: the chosen rule, until the start of its next activation.
  reg.on('onWeaponRules', T.bind('wolf-scouts.frosteye.act.hunters-senses', 12), (ev) => {
    if (ev.operative.player !== T.player || ev.weaponName !== 'Instigator bolt carbine') return;
    const eff = effectOn(ev.state, ev.operative.id, HUNTERS_SENSES_EFFECT);
    const id = eff?.data?.['rule'];
    if (typeof id !== 'string') return;
    const x = eff?.data?.['x'];
    ev.rules.push(ruleTag(id, typeof x === 'number' ? x : undefined, `${id} (Hunter’s Senses)`));
  });

  // GUNNER › Tempest's Fury.
  reg.on('onWeaponRules', T.bind('wolf-scouts.gunner.tempests-fury', 12), (ev) => {
    if (ev.operative.datacardId !== GUNNER || ev.operative.player !== T.player) return;
    if (ev.weaponName !== 'Plasma gun') return;
    if (!withinStorm(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Tempest’s Fury)'));
    // "Its plasma gun (supercharge) doesn't have the Hot weapon rule."
    if (ev.profile.name === 'supercharge') ev.rules = ev.rules.filter((r) => r.id !== 'Hot');
  });

  // HUNTER › Fierce Temperament.
  reg.on('onWeaponRules', T.bind('wolf-scouts.hunter.fierce-temperament', 12), (ev) => {
    if (ev.operative.datacardId !== HUNTER || ev.operative.player !== T.player) return;
    if (!withinStorm(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Fierce Temperament)'));
  });

  // RUNE PRIEST SKJALD › CALL THE STORM (second mode): "whenever that friendly operative is
  // within your STORM and more than 3" from the active operative, it's obscured."
  //
  // `onValidTarget` has no way to FORCE obscured (only `ignoreCoverTerrain`/`forceVisible`), so
  // the flag is set on the live sequence before the steps that read it (retention and the
  // obscured discard both happen after Roll Attack Dice).
  reg.on('onCollectAttackDice', T.bind('wolf-scouts.rune-priest-skjald.act.call-the-storm', 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const seq = shootSeq(ev.state);
    const target = ev.ctx.defender;
    if (!seq || !target) return;
    if (!effectOn(ev.state, target.id, CALL_STORM_EFFECT)) return;
    if (!withinStorm(T, ev.state, target)) return;
    const active = ev.state.operatives[ev.state.activeOperativeId ?? ev.ctx.attacker.id] ?? ev.ctx.attacker;
    if (T.gap(target, active) <= 3 + 1e-6) return;
    seq.obscured = true;
  });
}

// ---- RUNE PRIEST SKJALD › Cast the Runes -----------------------------------

const runeStore = (state: GameState): Record<string, unknown> => bucket(state, 'wolf-scouts.runes');

function castTheRunes(T: TeamHooks, state: GameState): void {
  if (!T.ctx) return;
  const priest = Object.values(state.operatives).find(
    (o) => o.player === T.player && o.datacardId === RUNE_PRIEST,
  );
  if (!priest) return;
  if (!useOncePerBattle(state, `wolf-scouts.castTheRunes:${T.player}`)) return;
  const rolls = [T.ctx.rng.d6(), T.ctx.rng.d6(), T.ctx.rng.d6()];
  recordRoll(state, 'castTheRunes', rolls, T.player, 'Cast the Runes 3D6');
  const credits: Record<string, number> = {};
  let cp = 0;
  for (const r of rolls) {
    if (r >= 5) cp += 1; // "For each result of 5-6, you gain 1CP."
    else credits[String(r)] = (credits[String(r)] ?? 0) + 1; // "…once during the turning point that matches"
  }
  state.teams[T.player].cp += cp;
  runeStore(state)[T.player] = credits;
  log(state, {
    kind: 'ploy',
    player: T.player,
    text: `Cast the Runes: ${rolls.join(', ')} — +${cp}CP, free Command Re-rolls in TP ${Object.keys(credits).join('/') || '—'}`,
  });
}

export function runeCredits(state: GameState, player: PlayerId): Record<string, number> {
  return (runeStore(state)[player] as Record<string, number> | undefined) ?? {};
}

function takeRuneCredit(state: GameState, player: PlayerId): boolean {
  const credits = runeStore(state)[player] as Record<string, number> | undefined;
  if (!credits) return false;
  const key = String(state.turningPoint);
  const n = credits[key] ?? 0;
  if (n <= 0) return false;
  credits[key] = n - 1;
  return true;
}

/** "you can use the Command Re-roll firefight ploy for 0CP once during the turning point". */
function discountCommandReroll(
  T: TeamHooks,
  state: GameState,
  grants: RerollGrant[],
  fallbackId: string,
): void {
  const existing = grants.find((g) => g.id.startsWith('commandReroll') && (g.player ?? T.player) === T.player);
  if (existing && (existing.cp ?? 0) === 0) return;
  if ((runeCredits(state, T.player)[String(state.turningPoint)] ?? 0) <= 0) return;
  if (!useOncePerSequence(state, `wolf-scouts.runeReroll:${T.player}:${fallbackId}`)) return;
  if (!takeRuneCredit(state, T.player)) return;
  if (existing) {
    existing.cp = 0;
    existing.label = 'Command Re-roll (0CP, Cast the Runes): re-roll one of those dice';
  } else {
    grants.push({
      id: fallbackId,
      label: 'Command Re-roll (0CP, Cast the Runes): re-roll one of those dice',
      mode: 'one',
      cp: 0,
      player: T.player,
    });
  }
  log(state, { kind: 'ploy', player: T.player, text: 'Cast the Runes: Command Re-roll for 0CP' });
}

function runePriest(reg: HookRegistry, T: TeamHooks): void {
  // "After selecting this operative, before the battle, roll three D6…" — deployment is the
  // last pre-battle step the engine emits a hook for; the Ready step of the first turning
  // point is the belt-and-braces path for states that were set up without DeployOperative.
  reg.on('onDeploy', T.bind('wolf-scouts.rune-priest-skjald.cast-the-runes', 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    castTheRunes(T, ev.state);
  });
  reg.on('onReadyStep', T.bind('wolf-scouts.rune-priest-skjald.cast-the-runes', 11), (ev) => {
    if (ev.player !== T.player) return;
    castTheRunes(T, ev.state);
  });
  reg.on('onRollAttack', T.bind('wolf-scouts.rune-priest-skjald.cast-the-runes', 13), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    discountCommandReroll(T, ev.state, ev.rerolls, 'commandReroll:attack');
  });
  reg.on('onDefenceDice', T.bind('wolf-scouts.rune-priest-skjald.cast-the-runes', 13), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls' || seq.defender !== T.player) return;
    discountCommandReroll(T, ev.state, ev.rerolls, 'commandReroll:defence');
  });
}

// ---- TRAPMASTER › Haywire Mine ---------------------------------------------

export const haywireMarkerId = (player: PlayerId): string => `wolf-scouts.haywireMine.${player}`;

function ensureHaywireMarker(T: TeamHooks, state: GameState, op: OperativeState): void {
  if (op.datacardId !== TRAPMASTER || op.player !== T.player || op.removed) return;
  const id = haywireMarkerId(T.player);
  const existing = state.markers[id];
  if (existing) {
    // A carried marker rides with its operative; keep it in step outside `applyMove` too.
    if (existing.carriedBy === op.id) {
      existing.pos = { ...op.pos };
      existing.z = op.z;
    }
    return;
  }
  if (!useOncePerBattle(state, `wolf-scouts.haywire:${T.player}`)) return;
  const marker = placeTeamMarker(state, {
    id,
    kind: 'device',
    player: T.player,
    pos: { ...op.pos },
    z: op.z,
    flags: { pickUpAllowed: true, haywire: true },
  });
  marker.carriedBy = op.id;
  op.carryingMarkerId = marker.id;
  log(state, { kind: 'action', player: T.player, text: `${op.letter} is carrying your Haywire Mine marker` });
}

function trapmaster(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onDeploy', T.bind('wolf-scouts.trapmaster.haywire-mine', 11), (ev) => {
    ensureHaywireMarker(T, ev.state, ev.operative);
  });
  reg.on('onActivationStart', T.bind('wolf-scouts.trapmaster.haywire-mine', 11), (ev) => {
    ensureHaywireMarker(T, ev.state, ev.operative);
  });

  // It is YOUR marker: an enemy operative standing next to it does not get to pick it up.
  reg.on('onMarkerControl', T.bind('wolf-scouts.trapmaster.haywire-mine', 12), (ev) => {
    if (ev.markerId !== haywireMarkerId(T.player)) return;
    ev.forced = T.player;
  });

  // "…but that marker cannot be placed within another operative's control range" — the
  // universal Place Marker action cannot see that restriction, so it is refused in favour of
  // `Place Marker (Haywire Mine)`, which validates the position.
  reg.on('canPerformAction', T.bind('wolf-scouts.trapmaster.haywire-mine', 12), (ev) => {
    if (ev.action !== 'Place Marker') return;
    if (ev.operative.player !== T.player) return;
    if (ev.operative.carryingMarkerId !== haywireMarkerId(T.player)) return;
    ev.allowed = false;
    ev.reason = 'use Place Marker (Haywire Mine) — it cannot be placed within another operative’s control range';
  });

  // "(if this operative is incapacitated while carrying that marker and that marker cannot be
  //  placed, it's removed with this operative)"
  reg.on('onIncapacitated', T.bind('wolf-scouts.trapmaster.haywire-mine', 14), (ev) => {
    if (ev.prevented) return;
    const op = ev.operative;
    if (op.player !== T.player || op.carryingMarkerId !== haywireMarkerId(T.player)) return;
    const blocked = aliveOperatives(ev.state).some((o) => o.id !== op.id && T.gap(o, op) <= 1 + 1e-6);
    if (!blocked) return;
    removeMarker(ev.state, haywireMarkerId(T.player));
    op.carryingMarkerId = undefined as unknown as string | undefined;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${op.letter}: the Haywire Mine marker cannot be placed and is removed with it`,
    });
  });

  // Proximity Mine is reminder-only — see the module header note and the report: the engine
  // triggers markers of kind 'mine' inside `applyMove` with a hard-coded D3+3 and emits no
  // hook a team rule could own.
}

// ---- FENRISIAN WOLF --------------------------------------------------------

const WOLF_ALLOWED_ACTIONS = [
  'Charge',
  'Dash',
  'Fall Back',
  'Fight',
  'Guard',
  'Reposition',
  CHARGE_STORM,
  CHARGE_INSTINCT,
  FIGHT_HUNTING,
  FIGHT_COUNTERATTACK,
];

const POUNCE_ACTIONS = ['Charge', 'Fall Back', 'Reposition', CHARGE_STORM, CHARGE_INSTINCT];

function fenrisianWolf(reg: HookRegistry, T: TeamHooks): void {
  // Instinctive Predator: "This operative cannot perform any actions other than Charge, Dash,
  // Fall Back, Fight, Guard and Reposition."
  reg.on('canPerformAction', T.bind('wolf-scouts.fenrisian-wolf.instinctive-predator', 12), (ev) => {
    if (ev.operative.datacardId !== FENRISIAN_WOLF || ev.operative.player !== T.player) return;
    if (WOLF_ALLOWED_ACTIONS.includes(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'a FENRISIAN WOLF can only Charge, Dash, Fall Back, Fight, Guard and Reposition';
  });
  // "It cannot use any weapons that aren't on its datacard."
  reg.on('availableWeapons', T.bind('wolf-scouts.fenrisian-wolf.instinctive-predator', 13), (ev) => {
    if (ev.operative.datacardId !== FENRISIAN_WOLF || ev.operative.player !== T.player) return;
    const own = (T.card(ev.operative)?.weapons ?? []).map((w) => w.name);
    ev.weapons = ev.weapons.filter((n) => own.includes(n));
    // `weaponsOf` appends granted weapons AFTER this hook, so equipment grants are dropped here.
    const holder = ev.operative as OperativeState & { grantedWeapons?: unknown[] };
    if (holder.grantedWeapons && holder.grantedWeapons.length > 0) holder.grantedWeapons = [];
  });

  // Pounce: "Once per battle STRATEGIC GAMBIT."
  reg.on('gambitOptions', T.bind(POUNCE_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (usedThisBattle(ev.state, `wolf-scouts.pounce:${T.player}`)) return;
    const wolf = T.friendlies(ev.state).find((o) => o.datacardId === FENRISIAN_WOLF);
    // "If this operative's APL stat is 2 or more…"
    if (!wolf || currentApl(T, ev.state, wolf) < 2) return;
    ev.options.push({
      id: POUNCE_GAMBIT,
      label: 'Pounce: a free Charge, Fall Back or Reposition',
      sourceText: shortQuote(abilityText(FENRISIAN_WOLF, POUNCE_GAMBIT)),
    });
  });
  reg.on('onPloyUsed', T.bind(POUNCE_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== POUNCE_GAMBIT) return;
    const wolf = T.friendlies(ev.state).find((o) => o.datacardId === FENRISIAN_WOLF);
    if (!wolf || currentApl(T, ev.state, wolf) < 2) return;
    if (!useOncePerBattle(ev.state, `wolf-scouts.pounce:${T.player}`)) return;
    // D-015 defers the free action into the wolf's next activation, which is also where the
    // "-1 APL and it cannot perform any of the aforementioned actions" penalty lands. The two
    // cancel in APL terms, so the activation keeps two AP: the free one is restricted TO
    // Charge/Fall Back/Reposition, and the wolf's own AP is barred FROM them.
    const threshold = Math.max(0, currentApl(T, ev.state, wolf) - 1);
    wolf.aplMods.push(-1);
    effect(ev.state, {
      rule: POUNCE_EFFECT,
      source: { kind: 'ability', id: POUNCE_GAMBIT },
      sourceText: shortQuote(abilityText(FENRISIAN_WOLF, POUNCE_GAMBIT)),
      operativeId: wolf.id,
      player: T.player,
      data: { threshold },
      expiry: { kind: 'endOfActivation', operativeId: wolf.id },
    });
    grantFreeAction(ev.state, wolf, {
      sourceId: POUNCE_GAMBIT,
      sourceText: shortQuote(abilityText(FENRISIAN_WOLF, POUNCE_GAMBIT)),
      kind: 'ability',
      threshold,
      only: POUNCE_ACTIONS,
    });
  });
  reg.on('canPerformAction', T.bind(POUNCE_GAMBIT, 13), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, POUNCE_EFFECT);
    if (!eff) return;
    if (ev.operative.apSpent >= Number(eff.data?.['threshold'] ?? 0)) return; // the free action itself
    if (!POUNCE_ACTIONS.includes(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'Pounce: it cannot perform Charge, Fall Back or Reposition with its own AP';
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

const STORM_AT_START = 'wolf-scouts.stormAtActivationStart';

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // "…or was within your STORM at the start of the activation" (TEMPESTUOUS WRATH).
  reg.on('onActivationStart', T.bind('wolf-scouts.sp.tempestuous-wrath', 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    const store = bucket(ev.state, STORM_AT_START);
    store[ev.operative.id] = withinStorm(T, ev.state, ev.operative);
  });

  // ---- CLOAKED BY THE STORM (strategy, 1CP) -------------------------------
  reg.on('onDefenceDice', T.bind('wolf-scouts.sp.cloaked-by-the-storm', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'wolf-scouts.sp.cloaked-by-the-storm')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || !withinStorm(T, ev.state, target)) return;
    ev.rerolls.push({
      id: 'wolf-scouts.cloakedByTheStorm',
      label: 'Cloaked by the Storm: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('wolf-scouts.sp.cloaked-by-the-storm')),
    });
  });

  // ---- STORM'S BITE (strategy, 1CP) ---------------------------------------
  reg.on('onCollectAttackDice', T.bind('wolf-scouts.sp.storms-bite', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'wolf-scouts.sp.storms-bite')) return;
    if (ev.ctx.type !== 'melee') return;
    const enemy = ev.ctx.attacker;
    const mine = ev.ctx.defender;
    if (enemy.player === T.player) return;
    if (!mine || !T.mineKw(mine, KW)) return;
    if (!withinStorm(T, ev.state, enemy)) return;
    ev.count = Math.max(3, ev.count - 1); // "(to a minimum of 3)"
  });

  // ---- TEMPESTUOUS WRATH (strategy, 1CP) ----------------------------------
  reg.on('onWeaponRules', T.bind('wolf-scouts.sp.tempestuous-wrath', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'wolf-scouts.sp.tempestuous-wrath')) return;
    // "…is fighting or retaliating" — a melee weapon rule lookup only happens in a fight.
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    const atStart = Boolean(bucket(ev.state, STORM_AT_START)[ev.operative.id]);
    if (!withinStorm(T, ev.state, ev.operative) && !atStart) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Tempestuous Wrath)'));
  });

  // ---- SAVAGE FIGHTERS (strategy, 1CP) ------------------------------------
  reg.on('onStrikeResolved', T.bind('wolf-scouts.sp.savage-fighters', 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'wolf-scouts.sp.savage-fighters')) return;
    if (!T.ctx) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const retaliator = ev.state.operatives[seq.defenderId];
    const foe = ev.state.operatives[seq.attackerId];
    if (!retaliator || !foe) return;
    if (!T.mineKw(retaliator, KW)) return;
    // "…finishes retaliating, if it wasn't incapacitated"
    if (retaliator.incapacitated || retaliator.removed) return;
    const over =
      foe.incapacitated ||
      (successes(seq.attackerPool).length === 0 && successes(seq.defenderPool).length === 0);
    if (!over) return;
    if (grizzledBlocksThisSequence(ev.state, T.player)) return;
    if (!useOncePerSequence(ev.state, `wolf-scouts.savageFighters:${retaliator.id}`)) return;
    if (foe.removed) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'savageFighters', [d3], T.player, 'Savage Fighters D3+1');
    inflictDamage(T.ctx, ev.state, foe, d3 + 1, 'other');
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Savage Fighters: ${retaliator.letter} inflicts ${d3 + 1} damage on ${foe.letter}`,
    });
  });

  // ---- ACUTE SENSES (firefight, 1CP) --------------------------------------
  reg.on('onPloyUsed', T.bind('wolf-scouts.fp.acute-senses', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'wolf-scouts.fp.acute-senses') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates = active && T.mineKw(active, KW) ? [active] : T.friendlies(ev.state, KW);
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    effect(ev.state, {
      rule: ACUTE_SENSES_EFFECT,
      source: { kind: 'ploy', id: 'wolf-scouts.fp.acute-senses' },
      sourceText: shortQuote(text('wolf-scouts.fp.acute-senses')),
      operativeId: op.id,
      player: T.player,
      // "Until the end of that action" — the engine's tightest window for a ploy is the
      // activation it was used in (there is no end-of-action sweep).
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind('wolf-scouts.fp.acute-senses', 21), (ev) => {
    if (ev.type !== 'ranged') return;
    if (!effectOn(ev.state, ev.operative.id, ACUTE_SENSES_EFFECT)) return;
    // "…have the Range 6" and Seek Light weapon rules" — Range 6" REPLACES the weapon's own
    // Range (a longer one would win `ruleOf`'s "select which x to use" tie-break).
    ev.rules = ev.rules.filter((r) => r.id !== 'Range');
    ev.rules.push(ruleTag('Range', 6, 'Range 6" (Acute Senses)'));
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (Acute Senses)'));
  });
  reg.on('onCollectAttackDice', T.bind('wolf-scouts.fp.acute-senses', 25), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    if (!effectOn(ev.state, ev.ctx.attacker.id, ACUTE_SENSES_EFFECT)) return;
    seq.obscured = false; // "…and enemy operatives cannot be obscured"
  });

  // ---- TOUCHED BY LOKYAR (firefight, 1CP) ---------------------------------
  // "You can re-roll any of your attack dice" is the Relentless weapon rule, and
  // `effectiveRules` is re-derived at every step of the fight, so granting it after the dice
  // are rolled still produces the re-roll window (fight.ts emits no reroll hook of its own).
  reg.on('onWeaponRules', T.bind('wolf-scouts.fp.touched-by-lokyar', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'wolf-scouts.fp.touched-by-lokyar')) return;
    if (ev.type !== 'melee' || ev.retaliating) return;
    if (!isScoutNotWolf(T, ev.operative)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return; // "if it's fighting"
    // "…more than 5" from other friendly operatives"
    const alone = T.friendlies(ev.state).every((o) => o.id === ev.operative.id || T.gap(o, ev.operative) > 5 + 1e-6);
    if (!alone) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Touched by Lokyar)'));
  });

  // ---- COUNTERATTACK (firefight, 1CP) -------------------------------------
  reg.on('onPloyUsed', T.bind('wolf-scouts.fp.counterattack', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'wolf-scouts.fp.counterattack') return;
    // "…at the end of an enemy operative's activation, or after an enemy operative performs
    //  the Fight action" — that enemy is the one the free Fight must be made against.
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const foe = active && active.player !== T.player ? active : undefined;
    const engaged = T.friendlies(ev.state, KW).filter((o) =>
      foe ? T.gap(o, foe) <= 1 + 1e-6 : T.enemies(ev.state).some((e) => T.gap(o, e) <= 1 + 1e-6),
    );
    const op = chosenOperative(ev.state, ev.data, engaged);
    if (!op) return;
    effect(ev.state, {
      rule: COUNTERATTACK_EFFECT,
      source: { kind: 'ploy', id: 'wolf-scouts.fp.counterattack' },
      sourceText: shortQuote(text('wolf-scouts.fp.counterattack')),
      operativeId: op.id,
      player: T.player,
      ...(foe ? { data: { enemyId: foe.id } } : {}),
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    grantFreeAction(ev.state, op, {
      sourceId: 'wolf-scouts.fp.counterattack',
      sourceText: shortQuote(text('wolf-scouts.fp.counterattack')),
      threshold: currentApl(T, ev.state, op),
      only: [FIGHT_COUNTERATTACK],
    });
  });

  // ---- TRANSHUMAN PHYSIOLOGY (firefight, 1CP) -----------------------------
  reg.on('onDefenceDice', T.bind('wolf-scouts.fp.transhuman-physiology', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'wolf-scouts.fp.transhuman-physiology')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls' || seq.defender !== T.player) return;
    const target = ev.ctx.defender;
    if (!target || !isScoutNotWolf(T, target)) return;
    const die = seq.defence.dice.find((d) => d.state === 'normal');
    if (!die) return;
    if (!useOncePerTP(ev.state, `wolf-scouts.transhuman:${T.player}`)) return;
    die.state = 'crit';
    die.note = 'Transhuman Physiology';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: 'Transhuman Physiology: a normal success is retained as a critical success',
    });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/** "…if you roll two or more fails, you can discard one of them to retain another as a
 *  normal success instead." Strictly beneficial, so it is applied rather than offered. */
function wolfteeth(state: GameState, player: PlayerId, pool: DicePool): void {
  const fails = pool.dice.filter((d) => d.state === 'fail');
  if (fails.length < 2) return;
  if (!useOncePerTP(state, `wolf-scouts.wolfteeth:${player}`)) return;
  fails[0]!.state = 'discarded';
  fails[0]!.note = 'Wolfteeth Necklaces';
  fails[1]!.state = 'normal';
  fails[1]!.note = 'Wolfteeth Necklaces';
  log(state, {
    kind: 'dice',
    player,
    text: 'Wolfteeth Necklaces: a fail is discarded to retain another as a normal success',
  });
}

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- FROST WEAPONS ------------------------------------------------------
  reg.on('onWeaponRules', T.bind('wolf-scouts.eq.frost-weapons', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'wolf-scouts.eq.frost-weapons')) return;
    if (ev.weaponName !== 'Combat blade' || !T.mineKw(ev.operative, KW)) return;
    if (!whollyWithinStorm(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Frost Weapons)'));
  });

  // ---- WOLFTEETH NECKLACES ------------------------------------------------
  reg.on('onRollAttack', T.bind('wolf-scouts.eq.wolfteeth-necklaces', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'wolf-scouts.eq.wolfteeth-necklaces')) return;
    if (!isScoutNotWolf(T, ev.ctx.attacker)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    wolfteeth(ev.state, T.player, seq.attack);
  });
  // Fighting and retaliating: fight.ts offers its re-rolls without emitting a hook, but it
  // re-derives `effectiveRules` for each side after the dice are rolled, which is the only
  // seam a melee dice-pool rule has.
  reg.on('onWeaponRules', T.bind('wolf-scouts.eq.wolfteeth-necklaces', 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'wolf-scouts.eq.wolfteeth-necklaces')) return;
    if (ev.type !== 'melee' || !isScoutNotWolf(T, ev.operative)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.step === 'start' || seq.step === 'rollAttack') return;
    const side = ev.retaliating ? 'defender' : 'attacker';
    const owner = side === 'attacker' ? seq.attackerId : seq.defenderId;
    if (owner !== ev.operative.id) return;
    wolfteeth(ev.state, T.player, side === 'attacker' ? seq.attackerPool : seq.defenderPool);
  });

  // ---- RUNIC CHARMS -------------------------------------------------------
  reg.on('onDefenceDice', T.bind('wolf-scouts.eq.runic-charms', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'wolf-scouts.eq.runic-charms')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.defender !== T.player) return; // "at the start of the Roll Defence Dice step"
    const target = ev.ctx.defender;
    if (!target || !isScoutNotWolf(T, target)) return;
    if (!whollyWithinStorm(T, ev.state, target)) return;
    // "worsen the x of the Piercing weapon rule by 1 (if any) … Note that Piercing 1 would
    //  therefore be ignored." Piercing only ever costs the defender dice, so the worsening is
    //  applied to the dice count the step is about to use.
    const retainedCrits = countCrits(seq.attack);
    const before = piercingValue(ev.ctx.rules, retainedCrits);
    if (before <= 0) return;
    const worsened: WeaponRule[] = ev.ctx.rules
      .map((r) => (r.id === 'Piercing' ? { ...r, x: (r.x ?? 1) - 1 } : r))
      .filter((r) => !(r.id === 'Piercing' && (r.x ?? 0) <= 0));
    const after = piercingValue(worsened, retainedCrits);
    if (after >= before) return;
    if (!useOncePerTP(ev.state, `wolf-scouts.runicCharms:${T.player}`)) return;
    ev.count += before - after;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Runic Charms: Piercing worsened to ${after} (${before - after} defence dice back)`,
    });
  });

  // ---- TALISMANIC TROPHIES ------------------------------------------------
  reg.on('onDamage', T.bind('wolf-scouts.eq.talismanic-trophies', 30), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!hasEquipment(ev.state, T.player, 'wolf-scouts.eq.talismanic-trophies')) return;
    if (!isScoutNotWolf(T, ev.target)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (seq.attackerId !== ev.target.id && seq.defenderId !== ev.target.id) return;
    if (!whollyWithinStorm(T, ev.state, ev.target)) return;
    // "…you can subtract 1 from the damage inflicted on it from ONE NORMAL SUCCESS."
    const strikerSide = ev.target.id === seq.defenderId ? 'attacker' : 'defender';
    const profile = fightProfile(T, ev.state, seq, strikerSide);
    if (!profile || ev.amount !== profile.dmgN) return;
    if (!useOncePerSequence(ev.state, `wolf-scouts.talismanic:${ev.target.id}`)) return;
    ev.amount = Math.max(0, ev.amount - 1);
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const HEALING_BALMS = 'wolf-scouts.fangbearer.act.healing-balms';
const HUNTERS_SENSES = 'wolf-scouts.frosteye.act.hunters-senses';
const CALL_THE_STORM = 'wolf-scouts.rune-priest-skjald.act.call-the-storm';

const KNOWN_RULE_IDS = new Set<string>(UNIVERSAL_WEAPON_RULES);

function actions(data: typeof DATA) {
  return [
    // HEALING BALMS 1AP — FANGBEARER
    uniqueAction(data, FANGBEARER, HEALING_BALMS, {
      // D-026: the whole legality lives here, because `src/ai/legal.ts` re-runs only `check`.
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player)
          return { ok: false, reason: 'select one friendly WOLF SCOUT operative within control range' };
        if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
          return { ok: false, reason: 'select one friendly WOLF SCOUT operative within control range' };
        if (target.id !== op.id && !inControlRange(ctx, state, op, target))
          return { ok: false, reason: 'that operative is not within this operative’s control range' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const heal = ctx.rng.d3() + 3; // "regain up to D3+3 lost wounds"
        recordRoll(state, 'healingBalms', [heal], op.player, 'HEALING BALMS D3+3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: HEALING BALMS restores ${heal} wounds to ${target.letter}`,
        });
        return { ok: true };
      },
    }),

    // HUNTER'S SENSES 1AP — FROSTEYE
    //
    // DATA GAP: the printed list of selectable rules is missing from
    // `data/teams/wolf-scouts.json` (the text stops at the colon), so the menu cannot be
    // pinned. The action therefore requires an explicit `choice` naming a weapon rule the
    // engine knows, rather than inventing a default the source never printed.
    uniqueAction(data, FROSTEYE, HUNTERS_SENSES, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const choice = params.choice;
        if (!choice || !KNOWN_RULE_IDS.has(choice))
          return {
            ok: false,
            reason:
              'select one of the printed rules for the instigator bolt carbine (the list is missing from data/teams/wolf-scouts.json)',
          };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const choice = params.choice!;
        const x = (params.data?.['x'] as number | undefined) ?? undefined;
        dropEffects(state, (e) => e.rule === HUNTERS_SENSES_EFFECT && e.operativeId === op.id);
        effect(state, {
          rule: HUNTERS_SENSES_EFFECT,
          source: { kind: 'ability', id: HUNTERS_SENSES },
          sourceText: shortQuote(uniqueActionText(FROSTEYE, HUNTERS_SENSES)),
          operativeId: op.id,
          player: op.player,
          data: { rule: choice, ...(x !== undefined ? { x } : {}) },
          // "…to have until the start of its next activation."
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: HUNTER’S SENSES — instigator bolt carbine gains ${choice}`,
        });
        return { ok: true };
      },
    }),

    // CALL THE STORM 1AP — RUNE PRIEST SKJALD (PSYCHIC)
    uniqueAction(data, RUNE_PRIEST, CALL_THE_STORM, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (params.choice === 'obscure') {
          const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
          if (!target || target.removed || target.player !== op.player)
            return { ok: false, reason: 'select one friendly WOLF SCOUT operative' };
          if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
            return { ok: false, reason: 'select one friendly WOLF SCOUT operative' };
        }
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        // "…until it performs this action again (whichever comes first)."
        dropEffects(state, (e) => e.rule === CALL_STORM_EFFECT && e.player === op.player);
        if (params.choice === 'obscure') {
          const target = state.operatives[params.targetOperativeId!]!;
          effect(state, {
            rule: CALL_STORM_EFFECT,
            source: { kind: 'ability', id: CALL_THE_STORM },
            sourceText: shortQuote(uniqueActionText(RUNE_PRIEST, CALL_THE_STORM)),
            operativeId: target.id,
            player: op.player,
            // "Until the start of this operative's next activation, until it's incapacitated…"
            expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
          });
          log(state, {
            kind: 'action',
            player: op.player,
            text: `${op.letter}: CALL THE STORM — ${target.letter} is obscured within your STORM`,
          });
          return { ok: true };
        }
        placeStorm(state, op.player, params.targetPos ?? { ...op.pos }, CALL_THE_STORM);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: CALL THE STORM` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Extra ActionDefs
//
// D-021: a rule that GRANTS an action the universal one forbids is its own ActionDef pointing
// at the universal action through `treatedAs`, because `canPerformAction` can only forbid.
// ---------------------------------------------------------------------------

const cardBase = (ctx: GameContext, op: OperativeState): BaseShape => ctx.datacards.get(op.datacardId)?.base ?? DEFAULT_BASE;
const hasKw = (ctx: GameContext, op: OperativeState, kw: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(kw);

function chargeCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  path: Parameters<typeof validateMove>[3] | undefined,
): { ok: boolean; reason?: string; endPos?: Vec2 } {
  if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'already within control range of an enemy operative' };
  if (['Reposition', 'Dash', 'Fall Back'].some((a) => op.actionsThisActivation.includes(a)))
    return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
  if (!path) return { ok: false, reason: 'no path supplied' };
  const v = validateMove(ctx, state, op, path, {
    action: 'Charge',
    bonusInches: 2,
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  return { ok: true, endPos: v.endPos };
}

/** Elemental Storm: "…can perform the Charge action while it has a Conceal order if it ends
 *  that action within your STORM." */
registerAction({
  id: CHARGE_STORM,
  name: CHARGE_STORM,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: text(ELEMENTAL_STORM_GAMBIT),
  available: (ctx, _state, op) => hasKw(ctx, op, KW),
  check(ctx, state, op, params) {
    const r = chargeCheck(ctx, state, op, params.path);
    if (!r.ok || !r.endPos) return { ok: false, reason: r.reason ?? 'illegal move' };
    if (!withinStormBase(state, op.player, r.endPos, cardBase(ctx, op), params.path?.endRot ?? op.rot))
      return { ok: false, reason: 'it must end that action within your STORM' };
    return { ok: true };
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

/** FENRISIAN WOLF › Instinctive Predator: "…can perform the Charge action while it has a
 *  Conceal order." (No STORM condition.) */
registerAction({
  id: CHARGE_INSTINCT,
  name: CHARGE_INSTINCT,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(FENRISIAN_WOLF, 'wolf-scouts.fenrisian-wolf.instinctive-predator'),
  available: (_ctx, _state, op) => op.datacardId === FENRISIAN_WOLF,
  check(ctx, state, op, params) {
    const r = chargeCheck(ctx, state, op, params.path);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'illegal move' };
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

const HUNTING_TEXT = DATA.factionRules.find((r) => r.id === 'wolf-scouts.rule.hunting-astartes')!.text;

function huntingSecondShoot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: { weaponName?: string; profileName?: string; targetId?: string },
  wantPlasma: boolean,
): { ok: boolean; reason?: string } {
  if (!op.actionsThisActivation.includes('Shoot'))
    return { ok: false, reason: 'Hunting Astartes is the second Shoot action of an activation' };
  // "…it can perform EITHER two Shoot actions OR two Fight actions."
  if (op.actionsThisActivation.includes(FIGHT_HUNTING))
    return { ok: false, reason: 'this operative has already taken its second Fight action' };
  const other = wantPlasma ? SHOOT_HUNTING : SHOOT_HUNTING_PLASMA;
  if (op.actionsThisActivation.includes(other))
    return { ok: false, reason: 'this operative has already taken its second Shoot action' };
  const first = effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'];
  const firstName = typeof first === 'string' ? first : '';
  const second = params.weaponName ?? '';
  if (!second) return { ok: false, reason: 'weapon and target required' };
  // "You cannot select two PSYCHIC ranged weapons."
  if (firstName && isPsychicWeapon(ctx, op, firstName) && isPsychicWeapon(ctx, op, second))
    return { ok: false, reason: 'you cannot select two PSYCHIC ranged weapons' };
  // "1 additional AP must be spent for the second action if both actions are using a plasma
  //  gun or plasma pistol" — the 2AP variant of this action carries that cost.
  const bothPlasma = isPlasma(firstName) && isPlasma(second);
  if (bothPlasma !== wantPlasma)
    return {
      ok: false,
      reason: bothPlasma
        ? 'two plasma weapons cost 1 additional AP — use Shoot (Hunting Astartes, plasma)'
        : 'the 1 additional AP is only spent when both Shoot actions use a plasma gun or plasma pistol',
    };
  const base = getAction('Shoot')!.check(ctx, state, op, params);
  if (!base.ok) return base;
  // The universal Shoot leaves target validity to `startShoot`; validating it here keeps the
  // ActionDef contract (whatever `check` accepts, `perform` must complete).
  if (!validTargets(ctx, state, op, second, params.profileName).some((t) => t.target.id === params.targetId))
    return { ok: false, reason: 'not a valid target' };
  return { ok: true };
}

registerAction({
  id: SHOOT_HUNTING,
  name: SHOOT_HUNTING,
  ap: 1,
  type: 'unique',
  sourceText: HUNTING_TEXT,
  available: (ctx, _state, op) => hasKw(ctx, op, KW),
  check: (ctx, state, op, params) => huntingSecondShoot(ctx, state, op, params, false),
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: SHOOT_HUNTING_PLASMA,
  name: SHOOT_HUNTING_PLASMA,
  ap: 2,
  type: 'unique',
  sourceText: HUNTING_TEXT,
  available: (ctx, _state, op) => hasKw(ctx, op, KW),
  check: (ctx, state, op, params) => huntingSecondShoot(ctx, state, op, params, true),
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: FIGHT_HUNTING,
  name: FIGHT_HUNTING,
  ap: 1,
  type: 'unique',
  sourceText: HUNTING_TEXT,
  available: (ctx, _state, op) => hasKw(ctx, op, KW),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Hunting Astartes is the second Fight action of an activation' };
    if (op.actionsThisActivation.includes(SHOOT_HUNTING) || op.actionsThisActivation.includes(SHOOT_HUNTING_PLASMA))
      return { ok: false, reason: 'this operative has already taken its second Shoot action' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

/** Hunting Astartes: "…change its order instead of performing an action (for the latter,
 *  still treat it as having counteracted this turning point)." */
registerAction({
  id: CHANGE_ORDER_COUNTERACT,
  name: CHANGE_ORDER_COUNTERACT,
  ap: 1,
  type: 'unique',
  sourceText: HUNTING_TEXT,
  available: (ctx, state, op) =>
    hasKw(ctx, op, KW) && state.opState['counteract']?.['operativeId'] === op.id,
  check(ctx, state, op) {
    if (state.opState['counteract']?.['operativeId'] !== op.id)
      return { ok: false, reason: 'only while counteracting' };
    if (!withinStormBase(state, op.player, op.pos, cardBase(ctx, op), op.rot))
      return { ok: false, reason: 'it must be within your STORM to do so' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.order = op.order === 'engage' ? 'conceal' : 'engage';
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} changes its order to ${op.order} instead of performing an action`,
    });
    return { ok: true };
  },
});

/** FROSTEYE › Storm-veiled Execution: Guard "regardless of the killzone" and with a Conceal order. */
registerAction({
  id: GUARD_STORM_VEILED,
  name: GUARD_STORM_VEILED,
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot', // the universal Guard is "treated as a Shoot action"
  sourceText: abilityText(FROSTEYE, 'wolf-scouts.frosteye.storm-veiled-execution'),
  available: (_ctx, _state, op) => op.datacardId === FROSTEYE,
  check(ctx, state, op) {
    if (!withinStormBase(state, op.player, op.pos, cardBase(ctx, op), op.rot))
      return { ok: false, reason: 'it must be within your STORM' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.onGuard = true;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} goes on Guard (Storm-veiled Execution)` });
    return { ok: true };
  },
});

/** COUNTERATTACK's free Fight: "…but you cannot select any other enemy operative to fight
 *  against during that action." */
registerAction({
  id: FIGHT_COUNTERATTACK,
  name: FIGHT_COUNTERATTACK,
  ap: 1,
  type: 'unique',
  treatedAs: 'Fight',
  sourceText: DATA.firefightPloys.find((p) => p.id === 'wolf-scouts.fp.counterattack')!.text,
  available: (_ctx, state, op) =>
    state.effects.some((e) => e.rule === COUNTERATTACK_EFFECT && e.operativeId === op.id),
  check(ctx, state, op, params) {
    const eff = state.effects.find((e) => e.rule === COUNTERATTACK_EFFECT && e.operativeId === op.id);
    if (!eff) return { ok: false, reason: 'the Counterattack ploy was not used on this operative' };
    const enemyId = eff.data?.['enemyId'];
    if (typeof enemyId === 'string' && params.targetId && params.targetId !== enemyId)
      return { ok: false, reason: 'you cannot select any other enemy operative to fight against' };
    const targetId = params.targetId ?? (typeof enemyId === 'string' ? enemyId : undefined);
    if (!targetId) return { ok: false, reason: 'select the enemy operative that acted' };
    return getAction('Fight')!.check(ctx, state, op, { ...params, targetId });
  },
  perform(ctx, state, op, params) {
    const eff = state.effects.find((e) => e.rule === COUNTERATTACK_EFFECT && e.operativeId === op.id);
    const enemyId = eff?.data?.['enemyId'];
    const targetId = params.targetId ?? (typeof enemyId === 'string' ? enemyId : undefined);
    return getAction('Fight')!.perform(ctx, state, op, { ...params, ...(targetId ? { targetId } : {}) });
  },
});

/** TRAPMASTER › Haywire Mine: the placement restriction the universal action cannot express. */
registerAction({
  id: PLACE_HAYWIRE,
  name: PLACE_HAYWIRE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Place Marker',
  sourceText: abilityText(TRAPMASTER, 'wolf-scouts.trapmaster.haywire-mine'),
  available: (_ctx, _state, op) => op.carryingMarkerId === haywireMarkerId(op.player),
  check(ctx, state, op, params) {
    if (op.carryingMarkerId !== haywireMarkerId(op.player))
      return { ok: false, reason: 'not carrying your Haywire Mine marker' };
    if (op.actionsThisActivation.includes('Pick Up Marker') && !op.incapacitated)
      return { ok: false, reason: 'already performed Pick Up Marker this activation' };
    const pos = params.markerPos ?? params.targetPos;
    if (!pos) return { ok: false, reason: 'select where to place the Haywire Mine marker' };
    if (baseGap(op.pos, cardBase(ctx, op), op.rot, pos, MARKER_20, 0) > 1 + 1e-6)
      return { ok: false, reason: 'the marker must be placed within control range' };
    // "…but that marker cannot be placed within another operative's control range"
    for (const other of aliveOperatives(state)) {
      if (other.id === op.id) continue;
      if (baseGap(other.pos, cardOfOp(ctx, other).base, other.rot, pos, MARKER_20, 0) <= 1 + 1e-6)
        return { ok: false, reason: 'that marker cannot be placed within another operative’s control range' };
    }
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[op.carryingMarkerId!]!;
    const pos = (params.markerPos ?? params.targetPos)!;
    marker.carriedBy = undefined as unknown as string | undefined;
    marker.pos = { ...pos };
    marker.z = op.z;
    op.carryingMarkerId = undefined as unknown as string | undefined;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} places the Haywire Mine marker` });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------

export const wolfScouts = defineTeam({
  id: 'wolf-scouts',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // PACK LEADER › Grizzled Veteran: "You cannot use the Counterattack firefight ploy … at
    // the end of that action."
    'wolf-scouts.fp.counterattack': (state, player) =>
      grizzledBlocks(state, player)
        ? { ok: false, reason: 'Grizzled Veteran: you cannot use Counterattack at the end of that action' }
        : { ok: true },
  },
  aiHints: {
    roles: {
      [PACK_LEADER]: 'leader',
      [FANGBEARER]: 'support',
      [FROSTEYE]: 'sniper',
      [GUNNER]: 'gunner',
      [HUNTER]: 'objective',
      [RUNE_PRIEST]: 'support',
      [TRAPMASTER]: 'scout',
      [FENRISIAN_WOLF]: 'melee',
    },
    ployValue: {
      'wolf-scouts.sp.cloaked-by-the-storm': 0.5,
      'wolf-scouts.sp.storms-bite': 0.4,
      'wolf-scouts.sp.tempestuous-wrath': 0.6,
      'wolf-scouts.sp.savage-fighters': 0.5,
      'wolf-scouts.fp.acute-senses': 0.6,
      'wolf-scouts.fp.touched-by-lokyar': 0.5,
      'wolf-scouts.fp.counterattack': 0.7,
      'wolf-scouts.fp.transhuman-physiology': 0.6,
      // The two faction STRATEGIC GAMBITs are priced through the same table.
      [ELEMENTAL_STORM_GAMBIT]: 1.2,
      [POUNCE_GAMBIT]: 0.8,
    },
    equipmentValue: {
      'wolf-scouts.eq.frost-weapons': 0.5,
      'wolf-scouts.eq.wolfteeth-necklaces': 0.6,
      'wolf-scouts.eq.runic-charms': 0.5,
      'wolf-scouts.eq.talismanic-trophies': 0.5,
    },
  },
});

export default wolfScouts;

export { DATA as WOLF_SCOUTS_DATA };
