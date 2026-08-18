/**
 * NEMESIS CLAW — Chaos Space Marines (Night Lords).
 * https://wahapedia.ru/kill-team3/kill-teams/nemesis-claw/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/nemesis-claw.json`, never retyped.
 *
 * Reminder-only clauses (see docs/TEAM-STATUS.md — each is named next to the rule it belongs
 * to, with the engine reason):
 *  - Prescience › Foreboding ("skip that activation") — the engine cannot refuse an activation.
 *  - RETURN TO DARKNESS's "must end that move with Heavy terrain within its control range…"
 *    and "cannot end that move closer to enemy operatives" — `onMoveRules` is declared but
 *    never emitted and no hook constrains a move's END position.
 *  - FLAYED SKIN ("cannot re-roll their attack dice results of 1") — a `RerollGrant` has no
 *    way to exclude a die value.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { ruleOf, successes } from '../../core/dice.ts';
import { HookRegistry, type HookEvents } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import {
  aliveOperatives,
  body,
  gapBetween,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  recordRoll,
} from '../../core/state.ts';
import { baseDistanceToPart, hasType } from '../../core/terrain.ts';
import { isVisible } from '../../core/visibility.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type { BaseShape, Datacard, GameState, MarkerState, OperativeState, PlayerId, Vec2 } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  aplOf,
  bucket,
  catalogueCard,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  FREE_ACTION_RULE,
  gambitUsed,
  giveToken,
  grantFreeAction,
  hasEquipment,
  hasToken,
  notEngaged,
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

const DATA = teamData('nemesis-claw');
const KW = 'NEMESIS CLAW';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// Datacards the rules name.
const VISIONARY = 'nemesis-claw.night-lord-visionary';
const FEARMONGER = 'nemesis-claw.night-lord-fearmonger';
const SCREECHER = 'nemesis-claw.night-lord-screecher';
const SKINTHIEF = 'nemesis-claw.night-lord-skinthief';
const VENTRILOKAR = 'nemesis-claw.night-lord-ventrilokar';
const WARRIOR = 'nemesis-claw.night-lord-warrior';

// Rule ids (printed text lives in the JSON; these are the keys into it).
const R_ASTARTES = 'nemesis-claw.rule.astartes';
const R_MIDNIGHT = 'nemesis-claw.rule.in-midnight-clad';
const SP_COME_FOR_YOU = 'nemesis-claw.sp.we-have-come-for-you';
const SP_BLACK_HUNT = 'nemesis-claw.sp.the-black-hunt';
const SP_PREYSIGHT = 'nemesis-claw.sp.preysight';
const SP_RETURN_TO_DARKNESS = 'nemesis-claw.sp.return-to-darkness';
const FP_VOX_SCREAM = 'nemesis-claw.fp.vox-scream';
const FP_DEATH_TO_FALSE_EMPEROR = 'nemesis-claw.fp.death-to-the-false-emperor';
const FP_PROCLIVITY = 'nemesis-claw.fp.proclivity-for-murder';
const FP_DIRTY_FIGHTER = 'nemesis-claw.fp.dirty-fighter';
const EQ_FLAYED_SKIN = 'nemesis-claw.eq.flayed-skin';
const EQ_CHAIN_SNARE = 'nemesis-claw.eq.chain-snare';
const EQ_GRISLY_TROPHY = 'nemesis-claw.eq.grisly-trophy';
const EQ_COMMS_JAMMERS = 'nemesis-claw.eq.comms-jammers';

const A_PRESCIENCE = 'nemesis-claw.night-lord-visionary.prescience';
const A_TERRORCHEM = 'nemesis-claw.night-lord-fearmonger.terrorchem';
/** Printed on the datacard under the POISON OBJECTIVE heading; see the data note in the module docs. */
const A_TERRORCHEM_DAMAGE = 'nemesis-claw.night-lord-fearmonger.poison-objective';
const A_SCREECHER = 'nemesis-claw.night-lord-screecher.screecher';
const A_APPETITE = 'nemesis-claw.night-lord-screecher.appetite-for-cruelty';
const A_FLAY = 'nemesis-claw.night-lord-skinthief.flay-them-alive';
const A_TYRANT = 'nemesis-claw.night-lord-skinthief.tyrant-of-the-skinning-pits';
const A_ICON_BEARER = 'nemesis-claw.night-lord-ventrilokar.icon-bearer';
const A_CRUEL_TORMENTER = 'nemesis-claw.night-lord-warrior.cruel-tormenter';

const ACT_PREMONITION = 'nemesis-claw.night-lord-visionary.act.premonition';
const ACT_POISON_OBJECTIVE = 'nemesis-claw.night-lord-fearmonger.act.poison-objective';
const ACT_MIMICRY = 'nemesis-claw.night-lord-ventrilokar.act.disconcerting-mimicry';

/** "…gains one of your Terrorchem tokens" — a token is an effect on the operative holding it. */
export const TERRORCHEM = 'nemesisClaw.terrorchem';
/** "…gains one of your Grisly Trophy tokens". */
export const GRISLY_TROPHY_TOKEN = 'nemesisClaw.grislyTrophy';
/** Flay Them Alive's "cannot control markers or perform the Pick Up Marker or mission actions". */
const FLAYED = 'nemesisClaw.flayThemAlive';
/** DIRTY FIGHTER armed on a retaliating operative for the current fight. */
const DIRTY_FIGHTER = 'nemesisClaw.dirtyFighter';
/** DEATH TO THE FALSE EMPEROR armed for one sequence / the current activation. */
const FALSE_EMPEROR = 'nemesisClaw.deathToTheFalseEmperor';
/** The last ranged weapon fired this activation, so Astartes can validate the pair. */
const LAST_RANGED = 'nemesisClaw.lastRangedWeapon';
/** Prescience points, per player. */
const PRESCIENCE = 'nemesisClaw.prescience';
/** The friendly operative that most recently incapacitated an enemy in its control range. */
const LAST_KILL = 'nemesisClaw.lastKill';
/** POISON OBJECTIVE stamps the objective marker with the owning player. */
const MARKER_FLAG = 'nemesisClaw.terrorchem';

const ASTARTES_WEAPONS = /^(bolt pistol|boltgun|scoped bolt pistol)$/i;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? { shape: 'round', mm: 32 };

/** "a wounded enemy operative" — fewer than its starting wounds. */
function isWoundedOp(T: TeamHooks, op: OperativeState): boolean {
  const card = T.card(op);
  return card !== undefined && op.wounds < card.wounds;
}

/** Mutual visibility, the shape "visible to" is used in every one of these rules. */
function sees(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  const index = terrain(T.ctx, state);
  return isVisible(index, body(T.ctx, a), body(T.ctx, b)).visible;
}

/**
 * Lethal is stored as `x` and `ruleOf` keeps the LARGEST x, so a granted "Lethal 4+" would be
 * ignored next to a printed "Lethal 5+". Normalise to the best (lowest) threshold instead.
 */
function grantLethal(rules: HookEvents['onWeaponRules']['rules'], x: number): HookEvents['onWeaponRules']['rules'] {
  const best = Math.min(x, ...rules.filter((r) => r.id === 'Lethal').map((r) => r.x ?? 6));
  return [...rules.filter((r) => r.id !== 'Lethal'), ruleTag('Lethal', best, `Lethal ${best}+`)];
}

/** Prescience points are a pure per-player count in `state.opState` (read-only: no mutation). */
export function prescience(state: GameState, player: PlayerId): number {
  return Number((state.opState[PRESCIENCE] as Record<string, unknown> | undefined)?.[player] ?? 0);
}
function setPrescience(state: GameState, player: PlayerId, n: number): void {
  bucket(state, PRESCIENCE)[player] = Math.max(0, n);
}
/** "You cannot gain or spend your Prescience points if this operative is incapacitated." */
function visionaryAlive(T: TeamHooks, state: GameState): boolean {
  return T.friendlies(state).some((o) => o.datacardId === VISIONARY && !o.incapacitated && !o.removed);
}

/** The operative that is currently resolving an attack (the striker in a fight). */
function currentAttacker(state: GameState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  const id = seq.kind === 'shoot' ? seq.attackerId : seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
  return state.operatives[id];
}

/** Normal Dmg of the weapon currently inflicting damage (Portent ignores one dice's worth). */
function currentNormalDamage(T: TeamHooks, state: GameState): number {
  const seq = state.sequence;
  if (!seq) return 0;
  const holder = currentAttacker(state);
  if (!holder) return 0;
  const attackerSide = seq.kind === 'fight' && seq.turn === 'defender';
  const name = seq.kind === 'shoot' ? seq.weaponName : attackerSide ? (seq.defenderWeapon ?? '') : seq.attackerWeapon;
  const profileName =
    seq.kind === 'shoot' ? seq.profileName : attackerSide ? seq.defenderProfile : seq.attackerProfile;
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
  return profile?.dmgN ?? 0;
}

// ---------------------------------------------------------------------------
// In Midnight Clad
// ---------------------------------------------------------------------------

/**
 * "It's more than 8" from enemy operatives it's visible to." and
 * "It's within 1" of Heavy terrain that's not lower than it, or any part of its base is
 *  underneath Vantage terrain."
 */
export function inMidnightClad(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  const index = terrain(T.ctx, state);
  const me = body(T.ctx, op);
  for (const e of T.enemies(state)) {
    if (T.gap(op, e) > 8 + 1e-6) continue;
    if (isVisible(index, body(T.ctx, e), me).visible || isVisible(index, me, body(T.ctx, e)).visible) return false;
  }
  const base = baseOf(T, op);
  for (const part of index.parts) {
    if (hasType(part, 'Heavy') && part.z1 >= op.z - 1e-6) {
      if (baseDistanceToPart(op.pos, base, op.rot, part) <= 1 + 1e-6) return true;
    }
    // "any part of its base is underneath Vantage terrain"
    if (hasType(part, 'Vantage') && part.z0 > op.z + 1e-6) {
      if (baseDistanceToPart(op.pos, base, op.rot, part) <= 1e-6) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Astartes: "Each friendly NEMESIS CLAW operative can counteract regardless of its
  //      order." (the two Shoot / two Fight actions are registered below) -----------------
  // `counteractCandidates` (`src/core/phases.ts`) emits `onCounteract` for every expended,
  // not-yet-counteracted operative with `allowed: o.order === 'engage'` as the DEFAULT, so this
  // handler WIDENS eligibility to a Conceal order. The order is the only condition the clause
  // lifts: expended, "can counteract once during the turning point" (`counteractedThisTP`) and
  // On Guard's "that friendly operative cannot counteract during the turning point"
  // (`guardSpentTP`) are filtered by the core outside this hook and are left alone. Scoped to
  // the printed keyword, so every enemy keeps the core's printed Engage-order default.
  reg.on('onCounteract', T.bind(R_ASTARTES, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    ev.allowed = true;
  });

  // Astartes: remember the ranged weapon used, so the second Shoot can be checked against it.
  reg.on('onCollectAttackDice', T.bind(R_ASTARTES, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: R_ASTARTES },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  // ---- In Midnight Clad ---------------------------------------------------
  // The obscured verdict is a field of the shoot sequence, decided in the Select Valid Target
  // step. `onCollectAttackDice` is the first hook emitted after it, and it still precedes the
  // retention / obscured-discard steps that read `seq.obscured`, so the rule takes full effect.
  reg.on('onCollectAttackDice', T.bind(R_MIDNIGHT, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (ev.ctx.attacker.player === T.player) return; // "Whenever an ENEMY operative is shooting"
    const seq = shootSeq(ev.state);
    if (!seq || seq.obscured) return;
    if (seq.attackerId !== ev.ctx.attacker.id || seq.targetId !== target.id) return;
    if (!inMidnightClad(T, ev.state, target)) return;
    seq.obscured = true;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `In Midnight Clad: ${target.letter} is obscured`,
      data: { operativeId: target.id },
    });
  });

  // ---- Terrorchem (rare weapon rule + FEARMONGER ability) -----------------
  reg.on('onStrikeResolved', T.bind(A_TERRORCHEM, 12), (ev) => {
    if (!ev.ctx.rules.some((r) => r.id === 'Terrorchem')) return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (!critDamageFromCrits(ev, ev.state)) return;
    giveToken(ev.state, ev.struck, TERRORCHEM, {
      sourceId: A_TERRORCHEM,
      sourceText: shortQuote(abilityText(FEARMONGER, A_TERRORCHEM)),
      player: T.player,
    });
  });

  // FEARMONGER › the token's own effect (printed on the datacard under a POISON OBJECTIVE
  // heading): "Whenever an operative that has one of your Terrorchem tokens is activated,
  // inflict D3 damage on it."
  reg.on('onActivationStart', T.bind(A_TERRORCHEM_DAMAGE, 13), (ev) => {
    if (!hasToken(ev.state, ev.operative.id, TERRORCHEM, T.player)) return;
    if (!T.ctx) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'terrorchem', [d3], T.player, `Terrorchem D3 vs ${ev.operative.letter}`);
    inflictDamage(T.ctx, ev.state, ev.operative, d3, 'other');
  });

  // ---- SCREECHER › Screecher ---------------------------------------------
  // "your opponent cannot re-roll their attack dice": the three re-roll weapon rules are
  // stripped from the enemy's weapon (this reaches fights and retaliations too, which have no
  // re-roll hook), and every granted re-roll is dropped from the shooting window.
  // Priority 45: after team rules (10), ploys (20) and equipment (30), so a re-roll granted by
  // one of those is stripped too.
  reg.on('onWeaponRules', T.bind(A_SCREECHER, 45), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!screecherNear(T, ev.state, ev.operative)) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Balanced' && r.id !== 'Ceaseless' && r.id !== 'Relentless');
  });
  reg.on('onRollAttack', T.bind(A_SCREECHER, 45), (ev) => {
    if (ev.ctx.attacker.player === T.player) return;
    if (!screecherNear(T, ev.state, ev.ctx.attacker)) return;
    ev.rerolls = [];
  });

  // ---- SCREECHER › Appetite for Cruelty -----------------------------------
  reg.on('onWeaponRules', T.bind(A_APPETITE, 12), (ev) => {
    if (ev.retaliating) return; // "Whenever this operative is FIGHTING against…"
    if (ev.operative.datacardId !== SCREECHER || ev.operative.player !== T.player) return;
    if (ev.weaponName.toLowerCase() !== 'lightning claws') return;
    const target = ev.target;
    if (!target || target.player === T.player || !isWoundedOp(T, target)) return;
    ev.rules = grantLethal(ev.rules, 4);
  });

  // ---- SKINTHIEF › Flay Them Alive ---------------------------------------
  reg.on('onIncapacitated', T.bind(A_FLAY, 12), (ev) => {
    const victim = ev.operative;
    if (victim.player === T.player || !T.ctx) return;
    const killer = currentAttacker(ev.state);
    if (!killer || killer.player !== T.player || killer.datacardId !== SKINTHIEF) return;
    if (!inControlRange(T.ctx, ev.state, killer, victim)) return;
    if (usedThisTP(ev.state, `nemesisClaw.flay:${killer.id}`)) return;
    // "select one other enemy operative visible to and within 6" of either this operative or
    //  the incapacitated enemy operative"
    const candidates = T.enemies(ev.state)
      .filter((o) => o.id !== victim.id && !o.incapacitated)
      .filter(
        (o) =>
          (T.gap(killer, o) <= 6 + 1e-6 && sees(T, ev.state, killer, o)) ||
          (T.gap(victim, o) <= 6 + 1e-6 && sees(T, ev.state, victim, o)),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosen = candidates[0];
    if (!chosen) return;
    useOncePerTP(ev.state, `nemesisClaw.flay:${killer.id}`);
    effect(ev.state, {
      rule: FLAYED,
      source: { kind: 'ability', id: A_FLAY },
      sourceText: shortQuote(abilityText(SKINTHIEF, A_FLAY)),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'startOfNextTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Flay Them Alive: ${chosen.letter} cannot control markers or perform mission actions`,
      data: { operativeId: chosen.id },
    });
  });
  // "…that other enemy operative cannot control markers…"
  reg.on('onMarkerControl', T.bind(A_FLAY, 13), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    for (const e of T.enemies(ev.state)) {
      if (!effectOn(ev.state, e.id, FLAYED)) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, e)) continue;
      ev.aplByPlayer[e.player] = Math.max(0, ev.aplByPlayer[e.player] - aplOf(T.ctx, ev.state, e));
    }
  });
  // "…or perform the Pick Up Marker or mission actions."
  reg.on('canPerformAction', T.bind(A_FLAY, 13), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, FLAYED)) return;
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    ev.allowed = false;
    ev.reason = 'Flay Them Alive: it cannot perform the Pick Up Marker or mission actions';
  });

  // ---- SKINTHIEF › Tyrant of the Skinning Pits ----------------------------
  // A fight resolves one success at a time, so `amount` here is one dice's Normal/Critical Dmg.
  reg.on('onDamage', T.bind(A_TYRANT, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.datacardId !== SKINTHIEF || ev.target.player !== T.player) return;
    if (!fightSeq(ev.state)) return; // "Whenever this operative is fighting or retaliating"
    if (ev.amount < 3) return;
    ev.amount -= 1;
  });

  // ---- VENTRILOKAR › Icon Bearer -----------------------------------------
  reg.on('onMarkerControl', T.bind(A_ICON_BEARER, 12), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    const bearer = T.friendlies(ev.state).find(
      (o) => o.datacardId === VENTRILOKAR && markerContestedBy(T.ctx!, ev.state, marker, o),
    );
    if (!bearer) return;
    ev.aplByPlayer[T.player] += 1; // "treat this operative's APL stat as 1 higher"
  });

  // ---- WARRIOR › Cruel Tormenter -----------------------------------------
  reg.on('onWeaponRules', T.bind(A_CRUEL_TORMENTER, 12), (ev) => {
    if (ev.operative.datacardId !== WARRIOR || ev.operative.player !== T.player) return;
    const target = ev.target;
    if (!target || target.player === T.player) return;
    const card = T.card(target);
    if (!card) return;
    const injured = target.wounds < card.wounds / 2;
    if (!injured && card.wounds > 7) return;
    ev.rules = grantLethal(ev.rules, 5);
  });

  // ---- VISIONARY › Prescience --------------------------------------------
  // "In the Ready step of each Strategy phase, you gain D3 Prescience points."
  reg.on('onReadyStep', T.bind(A_PRESCIENCE, 12), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!visionaryAlive(T, ev.state)) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'prescience', [d3], T.player, 'Prescience D3');
    setPrescience(ev.state, T.player, prescience(ev.state, T.player) + d3);
    log(ev.state, { kind: 'system', player: T.player, text: `Prescience: +${d3} points` });
  });
  // "At the end of each turning point, discard your Prescience points."
  reg.on('onEndOfTP', T.bind(A_PRESCIENCE, 12), (ev) => {
    setPrescience(ev.state, T.player, 0);
  });
  // Portent: "Whenever an attack dice inflicts Normal Dmg on this operative, you can spend 1 of
  // your Prescience points to ignore that inflicted damage." Auto-use policy (D-022): only when
  // the damage would incapacitate the VISIONARY or the weapon's Normal Dmg is 3 or more.
  reg.on('onDamage', T.bind(A_PRESCIENCE, 13), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.datacardId !== VISIONARY || ev.target.player !== T.player) return;
    if (!visionaryAlive(T, ev.state) || prescience(ev.state, T.player) < 1) return;
    if (usedThisTP(ev.state, `nemesisClaw.portent:${T.player}`)) return; // "not more than once per TP"
    const dmgN = currentNormalDamage(T, ev.state);
    if (dmgN <= 0 || ev.amount < dmgN) return;
    // "Whenever an attack dice inflicts NORMAL Dmg on this operative": a shoot inflicts every
    // unblocked dice at once, so at least one of them must be a normal success; a fight
    // resolves one dice, whose damage is then exactly the Normal Dmg.
    const seq = shootSeq(ev.state);
    if (seq ? !seq.attack.dice.some((d) => d.state === 'normal') : ev.amount !== dmgN) return;
    if (dmgN < 3 && ev.target.wounds - ev.amount > 0) return;
    useOncePerTP(ev.state, `nemesisClaw.portent:${T.player}`);
    setPrescience(ev.state, T.player, prescience(ev.state, T.player) - 1);
    ev.amount -= dmgN;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Portent: ${ev.target.letter} ignores ${dmgN} damage (1 Prescience point spent)`,
    });
  });

  // ---- PROCLIVITY FOR MURDER / CHAIN SNARE bookkeeping --------------------
  // "after a friendly NEMESIS CLAW operative incapacitates an enemy operative within its
  //  control range" — recorded here so the ploy's `usable` can mirror the printed trigger.
  reg.on('onIncapacitated', T.bind(FP_PROCLIVITY, 14), (ev) => {
    if (ev.operative.player === T.player || !T.ctx) return;
    const killer = currentAttacker(ev.state);
    if (!killer || !T.mineKw(killer, KW)) return;
    if (!inControlRange(T.ctx, ev.state, killer, ev.operative)) return;
    bucket(ev.state, LAST_KILL)[T.player] = { operativeId: killer.id, tp: ev.state.turningPoint };
  });

  // ---- POISON OBJECTIVE's trigger ----------------------------------------
  // "The first time an enemy operative that doesn't have one of your Terrorchem tokens
  //  contests that objective marker, that operative gains that Terrorchem token, then inflict
  //  2D3 damage on it (if it's during an action, at the end of that action)."
  const poisonCheck = (state: GameState): void => checkPoisonedObjectives(T, state);
  reg.on('onActivationStart', T.bind(ACT_POISON_OBJECTIVE, 14), (ev) => poisonCheck(ev.state));
  reg.on('onActivationEnd', T.bind(ACT_POISON_OBJECTIVE, 14), (ev) => poisonCheck(ev.state));
  reg.on('onEndOfTP', T.bind(ACT_POISON_OBJECTIVE, 14), (ev) => poisonCheck(ev.state));
}

/** "if you inflict damage with any critical successes (including as a result of Devastating)" */
function critDamageFromCrits(ev: HookEvents['onStrikeResolved'], state: GameState): boolean {
  const dev = ruleOf(ev.ctx.rules, 'Devastating');
  const devastating = dev !== undefined && (dev.x ?? 0) > 0;
  const seq = shootSeq(state);
  if (seq) {
    // Devastating fires on RETAINED crits, blocked or not.
    const retainedCrits = seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'blocked').length;
    if (devastating && retainedCrits > 0) return true;
    return ev.crit && ev.ctx.profile.dmgC > 0;
  }
  if (!ev.crit) return false;
  return ev.ctx.profile.dmgC > 0 || devastating;
}

function screecherNear(T: TeamHooks, state: GameState, enemy: OperativeState): boolean {
  return T.friendlies(state).some((o) => o.datacardId === SCREECHER && !o.incapacitated && T.gap(o, enemy) <= 3 + 1e-6);
}

function checkPoisonedObjectives(T: TeamHooks, state: GameState): void {
  if (!T.ctx) return;
  for (const marker of Object.values(state.markers)) {
    if (marker.flags[MARKER_FLAG] !== T.player) continue;
    for (const e of T.enemies(state)) {
      if (hasToken(state, e.id, TERRORCHEM, T.player)) continue;
      if (!markerContestedBy(T.ctx, state, marker, e)) continue;
      delete marker.flags[MARKER_FLAG]; // "that operative gains THAT Terrorchem token"
      giveToken(state, e, TERRORCHEM, {
        sourceId: ACT_POISON_OBJECTIVE,
        sourceText: shortQuote(actionText(FEARMONGER, ACT_POISON_OBJECTIVE)),
        player: T.player,
      });
      const damage = T.ctx.rng.d3() + T.ctx.rng.d3();
      recordRoll(state, 'poisonObjective', [damage], T.player, 'POISON OBJECTIVE 2D3');
      inflictDamage(T.ctx, state, e, damage, 'other');
      log(state, {
        kind: 'action',
        player: T.player,
        text: `POISON OBJECTIVE: ${e.letter} takes ${damage} damage from the poisoned objective`,
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- WE HAVE COME FOR YOU (strategy, 1CP) -------------------------------
  // "when it ends its move during that action, you can inflict D3 damage on one enemy
  //  operative within its control range". The engine has no post-action hook, so the damage is
  //  resolved at the end of that activation (reported as a timing approximation).
  reg.on('onActivationEnd', T.bind(SP_COME_FOR_YOU, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_COME_FOR_YOU)) return;
    if (!T.mineKw(ev.operative, KW) || !T.ctx) return;
    if (ev.operative.actionsThisActivation[0] !== 'Charge') return;
    const victims = T.enemies(ev.state)
      .filter((e) => inControlRange(T.ctx!, ev.state, ev.operative, e))
      .sort((a, b) => a.wounds - b.wounds || (a.id < b.id ? -1 : 1));
    const victim = victims[0];
    if (!victim) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'weHaveComeForYou', [d3], T.player, `WE HAVE COME FOR YOU vs ${victim.letter}`);
    inflictDamage(T.ctx, ev.state, victim, d3, 'other');
    log(ev.state, { kind: 'ploy', player: T.player, text: `We Have Come For You: ${d3} damage to ${victim.letter}` });
  });

  // ---- THE BLACK HUNT (strategy, 1CP) -------------------------------------
  // "you can re-roll one of your attack dice" is exactly the Balanced weapon rule, and granting
  // it reaches shooting, fighting AND retaliating (the fight sequence has no re-roll hook).
  reg.on('onWeaponRules', T.bind(SP_BLACK_HUNT, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_BLACK_HUNT)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const target = ev.target;
    if (!target || target.player === T.player || !isWoundedOp(T, target)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (THE BLACK HUNT)'));
  });

  // ---- PREYSIGHT (strategy, 1CP) ------------------------------------------
  // "you can use this rule" — auto-used only where the Range 6" half costs nothing, i.e. when
  // the intended target is already within 6" (D-022 policy).
  reg.on('onWeaponRules', T.bind(SP_PREYSIGHT, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_PREYSIGHT)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    const target = ev.target;
    if (!target || T.gap(ev.operative, target) > 6 + 1e-6) return;
    ev.rules.push(ruleTag('Range', 6, 'Range 6"'), ruleTag('SeekLight', undefined, 'Seek Light'));
  });

  // ---- RETURN TO DARKNESS (strategy, 1CP) ---------------------------------
  reg.on('onPloyUsed', T.bind(SP_RETURN_TO_DARKNESS, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP_RETURN_TO_DARKNESS) return;
    const op = chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW));
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: SP_RETURN_TO_DARKNESS,
      sourceText: shortQuote(text(SP_RETURN_TO_DARKNESS)),
      threshold: currentApl(T, ev.state, op),
      only: ['Fall Back', 'Reposition'],
    });
  });
  // "it cannot move more than 4" during that action"
  reg.on('onMoveDistance', T.bind(SP_RETURN_TO_DARKNESS, 21), (ev) => {
    if (ev.action !== 'Reposition' && ev.action !== 'Fall Back') return;
    if (effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE)?.source.id !== SP_RETURN_TO_DARKNESS) return;
    ev.inches = Math.min(ev.inches, 4);
  });

  // ---- VOX SCREAM (firefight, 1CP) ----------------------------------------
  reg.on('onPloyUsed', T.bind(FP_VOX_SCREAM, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_VOX_SCREAM || !T.ctx) return;
    const ready = T.enemies(ev.state).filter((o) => o.ready);
    const eligible = ready
      .filter((o) => T.friendlies(ev.state, KW).some((f) => sees(T, ev.state, f, o)))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const target = chosenOperative(ev.state, ev.data, eligible);
    if (!target) return;
    // "If there are no other enemy operatives eligible to be activated, this ploy has no effect."
    if (ready.length <= 1) {
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Vox Scream has no effect (no other enemy can activate)' });
      return;
    }
    const roll = T.ctx.rng.d6();
    const apl = aplOf(T.ctx, ev.state, target);
    recordRoll(ev.state, 'voxScream', [roll], T.player, `VOX SCREAM vs ${target.letter} (APL ${apl})`);
    if (roll <= apl) {
      // "this ploy isn't used, the CP spent on it is refunded and you cannot use this ploy
      //  again during this turning point" — the reducer already banked the once-per-TP entry.
      ev.state.teams[T.player].cp += 1;
      log(ev.state, { kind: 'ploy', player: T.player, text: `Vox Scream fails (${roll} vs APL ${apl}) — 1CP refunded` });
      return;
    }
    // "your opponent cannot activate it during this activation": the engine cannot refuse an
    // activation, so the lost tempo is modelled as -1 APL on that activation (same substitution
    // as the Hierotek Circle's VISION OF MADNESS).
    target.aplMods.push(-1);
    effect(ev.state, {
      rule: 'nemesisClaw.voxScream',
      source: { kind: 'ploy', id: FP_VOX_SCREAM },
      sourceText: shortQuote(text(FP_VOX_SCREAM)),
      operativeId: target.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Vox Scream stuns ${target.letter} (${roll} vs APL ${apl})` });
  });

  // ---- DEATH TO THE FALSE EMPEROR (firefight, 1CP) ------------------------
  reg.on('onPloyUsed', T.bind(FP_DEATH_TO_FALSE_EMPEROR, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_DEATH_TO_FALSE_EMPEROR) return;
    const seq = ev.state.sequence;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    let mine: string | undefined;
    let foe: string | undefined;
    if (seq) {
      const a = ev.state.operatives[seq.attackerId];
      const b = ev.state.operatives[seq.kind === 'shoot' ? seq.targetId : seq.defenderId];
      if (a && T.mineKw(a, KW)) {
        mine = a.id;
        foe = b?.id;
      } else if (b && T.mineKw(b, KW)) {
        mine = b.id;
        foe = a?.id;
      }
    }
    mine ??= active && T.mineKw(active, KW) ? active.id : undefined;
    effect(ev.state, {
      rule: FALSE_EMPEROR,
      source: { kind: 'ploy', id: FP_DEATH_TO_FALSE_EMPEROR },
      sourceText: shortQuote(text(FP_DEATH_TO_FALSE_EMPEROR)),
      player: T.player,
      ...(mine ? { operativeId: mine } : {}),
      data: { ...(foe ? { foe } : {}) },
      expiry: { kind: 'endOfActivation', operativeId: active?.id ?? mine ?? 'none' },
    });
  });
  reg.on('onWeaponRules', T.bind(FP_DEATH_TO_FALSE_EMPEROR, 21), (ev) => {
    if (!ployUsed(ev.state, T.player, FP_DEATH_TO_FALSE_EMPEROR)) return;
    const armed = ev.state.effects.find((e) => e.rule === FALSE_EMPEROR && e.player === T.player);
    if (!armed) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (armed.operativeId && armed.operativeId !== ev.operative.id) return;
    const target = ev.target;
    if (!target || target.player === T.player) return;
    const foe = armed.data?.['foe'];
    if (typeof foe === 'string' && foe !== target.id) return;
    const kws = (T.card(target)?.keywords ?? []).map((k) => k.toUpperCase());
    if (!kws.includes('IMPERIUM')) return;
    if (kws.includes('ADEPTUS ASTARTES')) ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (DEATH TO THE FALSE EMPEROR)'));
    else ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (DEATH TO THE FALSE EMPEROR)'));
  });

  // ---- PROCLIVITY FOR MURDER (firefight, 1CP) -----------------------------
  reg.on('onPloyUsed', T.bind(FP_PROCLIVITY, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_PROCLIVITY) return;
    const killerId = (bucket(ev.state, LAST_KILL)[T.player] as { operativeId?: string } | undefined)?.operativeId;
    const candidates = T.friendlies(ev.state, KW);
    const op =
      candidates.find((o) => o.id === killerId) ?? chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: FP_PROCLIVITY,
      sourceText: shortQuote(text(FP_PROCLIVITY)),
      threshold: currentApl(T, ev.state, op),
      only: ['Charge', 'Dash', PROCLIVITY_CHARGE, PROCLIVITY_DASH],
    });
  });
  // "(for the former, it cannot move more than 3")"
  reg.on('onMoveDistance', T.bind(FP_PROCLIVITY, 21), (ev) => {
    if (ev.action !== 'Charge') return;
    if (effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE)?.source.id !== FP_PROCLIVITY) return;
    ev.inches = Math.min(ev.inches, 3);
  });

  // ---- DIRTY FIGHTER (firefight, 1CP) -------------------------------------
  reg.on('onPloyUsed', T.bind(FP_DIRTY_FIGHTER, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_DIRTY_FIGHTER) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defender !== T.player) return;
    seq.turn = 'defender'; // "You can resolve one of your successes before the normal order."
    effect(ev.state, {
      rule: DIRTY_FIGHTER,
      source: { kind: 'ploy', id: FP_DIRTY_FIGHTER },
      sourceText: shortQuote(text(FP_DIRTY_FIGHTER)),
      operativeId: seq.defenderId,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? seq.attackerId },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Dirty Fighter: the retaliating operative resolves first' });
  });
  // "If you do, you cannot resolve any other successes during that sequence."
  const spendDirtyFighter = (state: GameState, resolverId: string): void => {
    const seq = fightSeq(state);
    if (!seq || seq.defenderId !== resolverId) return;
    if (!effectOn(state, seq.defenderId, DIRTY_FIGHTER)) return;
    dropEffects(state, (e) => e.rule === DIRTY_FIGHTER && e.operativeId === seq.defenderId);
    let discarded = 0;
    for (const die of successes(seq.defenderPool)) {
      die.state = 'discarded';
      die.note = 'Dirty Fighter';
      discarded++;
    }
    if (discarded > 0)
      log(state, { kind: 'dice', player: T.player, text: `Dirty Fighter discards ${discarded} unresolved successes` });
  };
  reg.on('onStrikeResolved', T.bind(FP_DIRTY_FIGHTER, 21), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    spendDirtyFighter(ev.state, ev.ctx.attacker.id);
  });
  reg.on('onBlockAllocation', T.bind(FP_DIRTY_FIGHTER, 21), (ev) => {
    spendDirtyFighter(ev.state, ev.ctx.attacker.id);
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- FLAYED SKIN --------------------------------------------------------
  // Reminder-only: "your opponent cannot re-roll their attack dice results of 1" needs a
  // per-value exclusion on a RerollGrant, which the dice engine does not have.

  // ---- CHAIN SNARE --------------------------------------------------------
  // The roll is made when the snared operative is activated, not when it declares the Fall
  // Back: `canPerformAction` is emitted by `availableActions` (a pure query the UI and the AI
  // both run), and rolling there would consume the match's dice stream outside the reducer and
  // break replay (architecture rule 2). The handler below therefore only READS the result.
  reg.on('onActivationStart', T.bind(EQ_CHAIN_SNARE, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_CHAIN_SNARE)) return;
    if (ev.operative.player === T.player || !T.ctx) return;
    if (usedThisTP(ev.state, `nemesisClaw.chainSnare:${T.player}`)) return;
    const foe = ev.operative;
    // "while within control range of a friendly NEMESIS CLAW operative, if no other enemy
    //  operatives are within that friendly operative's control range"
    const snarer = T.friendlies(ev.state, KW).find(
      (o) =>
        inControlRange(T.ctx!, ev.state, o, foe) &&
        T.enemies(ev.state).every((e) => e.id === foe.id || !inControlRange(T.ctx!, ev.state, o, e)),
    );
    if (!snarer) return;
    // "roll two D6, or one D6 if that enemy operative has a higher Wounds stat than that
    //  friendly operative"
    const dice = (T.card(foe)?.wounds ?? 0) > (T.card(snarer)?.wounds ?? 0) ? 1 : 2;
    const results: number[] = [];
    for (let i = 0; i < dice; i++) results.push(T.ctx.rng.d6());
    recordRoll(ev.state, 'chainSnare', results, T.player, `CHAIN SNARE ${dice}D6 vs ${foe.letter}`);
    if (!results.some((r) => r >= 4)) return;
    bucket(ev.state, 'nemesisClaw.chainSnare')[`${foe.id}:tp${ev.state.turningPoint}`] = true;
    useOncePerTP(ev.state, `nemesisClaw.chainSnare:${T.player}`);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Chain Snare bites into ${foe.letter} — it cannot Fall Back during this activation`,
    });
  });
  reg.on('canPerformAction', T.bind(EQ_CHAIN_SNARE, 30), (ev) => {
    if (ev.action !== 'Fall Back') return;
    const snared = (ev.state.opState['nemesisClaw.chainSnare'] ?? {}) as Record<string, unknown>;
    if (snared[`${ev.operative.id}:tp${ev.state.turningPoint}`] !== true) return;
    ev.allowed = false;
    ev.reason = 'Chain Snare: that operative cannot Fall Back during this activation';
  });

  // ---- GRISLY TROPHY ------------------------------------------------------
  reg.on('onIncapacitated', T.bind(EQ_GRISLY_TROPHY, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_GRISLY_TROPHY)) return;
    if (ev.operative.player === T.player) return;
    if (usedThisBattle(ev.state, `nemesisClaw.grisly:${T.player}`)) return;
    // "when a friendly NEMESIS CLAW operative incapacitates an enemy operative within 2" of it"
    const holder = currentAttacker(ev.state);
    if (!holder || !T.mineKw(holder, KW) || holder.incapacitated) return;
    if (T.gap(holder, ev.operative) > 2 + 1e-6) return;
    useOncePerBattle(ev.state, `nemesisClaw.grisly:${T.player}`);
    giveToken(ev.state, holder, GRISLY_TROPHY_TOKEN, {
      sourceId: EQ_GRISLY_TROPHY,
      sourceText: shortQuote(text(EQ_GRISLY_TROPHY)),
      player: T.player,
    });
  });
  reg.on('onCollectAttackDice', T.bind(EQ_GRISLY_TROPHY, 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_GRISLY_TROPHY)) return;
    const foe = ev.ctx.attacker;
    if (foe.player === T.player) return;
    const near = T.friendlies(ev.state, KW).some(
      (o) =>
        hasToken(ev.state, o.id, GRISLY_TROPHY_TOKEN, T.player) &&
        T.gap(o, foe) <= 2 + 1e-6 &&
        (sees(T, ev.state, o, foe) || sees(T, ev.state, foe, o)),
    );
    if (!near) return;
    ev.count = Math.max(0, ev.count - 1); // "subtract 1 from the Atk stat of that operative's weapons"
  });

  // ---- COMMS JAMMERS ------------------------------------------------------
  // "that enemy operative's APL stat cannot be added to" — every positive APL modifier on the
  // operative is cancelled while it is within 3". ("Note that this doesn't affect APL stats
  // that have already been changed" is not modelled: an ActiveEffect carries no timestamp.)
  reg.on('onStatMod', T.bind(EQ_COMMS_JAMMERS, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_COMMS_JAMMERS)) return;
    if (ev.operative.player === T.player) return;
    const plus = ev.operative.aplMods.filter((m) => m > 0).reduce((a, b) => a + b, 0);
    if (plus <= 0) return;
    if (!T.friendlies(ev.state, KW).some((o) => T.gap(o, ev.operative) <= 3 + 1e-6)) return;
    ev.mods.apl -= plus;
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const MIMICRY_OPTIONS = ['apl', 'order', 'dash'] as const;
type MimicryOption = (typeof MIMICRY_OPTIONS)[number];

const mimicryUsed = (state: GameState, player: PlayerId, option: MimicryOption): boolean =>
  usedThisBattle(state, `nemesisClaw.mimicry:${player}:${option}`);

function nextMimicryOption(state: GameState, player: PlayerId, wanted?: string): MimicryOption | undefined {
  if (wanted && (MIMICRY_OPTIONS as readonly string[]).includes(wanted)) {
    const opt = wanted as MimicryOption;
    if (!mimicryUsed(state, player, opt)) return opt;
    return undefined;
  }
  return MIMICRY_OPTIONS.find((o) => !mimicryUsed(state, player, o));
}

function objectiveFor(state: GameState, markerId: string | undefined): MarkerState | undefined {
  const marker = markerId ? state.markers[markerId] : undefined;
  return marker && marker.kind === 'objective' ? marker : undefined;
}

function actions(data: typeof DATA) {
  return [
    // PREMONITION 1AP — VISIONARY (PSYCHIC)
    uniqueAction(data, VISIONARY, ACT_PREMONITION, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (usedThisTP(state, `nemesisClaw.premonition:${op.id}`))
          return { ok: false, reason: 'this operative cannot perform this action more than once per turning point' };
        if (prescience(state, op.player) < 1) return { ok: false, reason: 'no Prescience points to spend' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        useOncePerTP(state, `nemesisClaw.premonition:${op.id}`);
        setPrescience(state, op.player, prescience(state, op.player) - 1);
        state.teams[op.player].cp += 1;
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: PREMONITION — 1 Prescience point spent, +1CP` });
        return { ok: true };
      },
    }),

    // POISON OBJECTIVE 1AP — FEARMONGER
    uniqueAction(data, FEARMONGER, ACT_POISON_OBJECTIVE, {
      // The whole selection is validated HERE, never in perform (docs/DECISIONS.md D-026).
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const marker = objectiveFor(state, params.markerId);
        if (!marker) return { ok: false, reason: 'select one objective marker this operative controls' };
        if (markerController(ctx, state, marker) !== op.player)
          return { ok: false, reason: 'your operatives do not control that objective marker' };
        // "It cannot be an objective marker within control range of an enemy operative…"
        const contested = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1').some((e) =>
          markerContestedBy(ctx, state, marker, e),
        );
        if (contested) return { ok: false, reason: 'that objective marker is within an enemy operative’s control range' };
        // "…or one that already has one of your Terrorchem tokens."
        if (marker.flags[MARKER_FLAG] === op.player)
          return { ok: false, reason: 'that objective marker already has one of your Terrorchem tokens' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const marker = state.markers[params.markerId!]!;
        marker.flags[MARKER_FLAG] = op.player;
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: POISON OBJECTIVE — the ${marker.id} objective marker gains a Terrorchem token`,
        });
        return { ok: true };
      },
    }),

    // DISCONCERTING MIMICRY 1AP — VENTRILOKAR (PSYCHIC)
    uniqueAction(data, VENTRILOKAR, ACT_MIMICRY, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative within 6"' };
        if (gapBetween(ctx, op, target) > 6 + 1e-6) return { ok: false, reason: 'that operative is not within 6"' };
        if (!nextMimicryOption(state, op.player, params.choice))
          return { ok: false, reason: 'you can only select each option once per battle' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const option = nextMimicryOption(state, op.player, params.choice)!;
        useOncePerBattle(state, `nemesisClaw.mimicry:${op.player}:${option}`);
        if (option === 'apl') {
          // "Until the end of its next activation, subtract 1 from its APL stat."
          target.aplMods.push(-1);
          effect(state, {
            rule: 'nemesisClaw.mimicryApl',
            source: { kind: 'ability', id: ACT_MIMICRY },
            sourceText: shortQuote(actionText(VENTRILOKAR, ACT_MIMICRY)),
            operativeId: target.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
          });
        } else if (option === 'order') {
          target.order = target.order === 'engage' ? 'conceal' : 'engage'; // "Change its order."
        } else {
          mimicryDash(ctx, state, op, target, params.targetPos);
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: DISCONCERTING MIMICRY (${option}) on ${target.letter}`,
        });
        return { ok: true };
      },
    }),
  ];
}

/**
 * "Perform a free Dash action with it (specify the location for your opponent to move it to)."
 * With no location supplied the deterministic default drives it away from the nearest friendly
 * operative; an illegal destination is simply not taken (the action still completes — D-026).
 */
function mimicryDash(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  target: OperativeState,
  wanted: Vec2 | undefined,
): void {
  const away = { x: target.pos.x - op.pos.x, y: target.pos.y - op.pos.y };
  const len = Math.hypot(away.x, away.y) || 1;
  const candidates: Vec2[] = [];
  if (wanted) candidates.push(wanted);
  for (const d of [3, 2, 1]) {
    candidates.push({ x: target.pos.x + (away.x / len) * d, y: target.pos.y + (away.y / len) * d });
    candidates.push({ x: target.pos.x - (away.y / len) * d, y: target.pos.y + (away.x / len) * d });
    candidates.push({ x: target.pos.x + (away.y / len) * d, y: target.pos.y - (away.x / len) * d });
  }
  for (const dest of candidates) {
    const v = validateMove(ctx, state, target, { points: [dest] }, { action: 'Dash', noClimb: true, mustNotFinishEngaged: true });
    if (!v.ok) continue;
    target.pos = { ...v.endPos };
    target.z = v.endZ;
    log(state, { kind: 'action', player: op.player, text: `${target.letter} performs a free Dash (Disconcerting Mimicry)` });
    return;
  }
  log(state, { kind: 'action', player: op.player, text: `${target.letter} has no legal Dash destination` });
}

// ---------------------------------------------------------------------------
// Astartes: the second Shoot / second Fight action
// ---------------------------------------------------------------------------

/**
 * "During each friendly NEMESIS CLAW operative's activation, it can perform either two Shoot
 * actions or two Fight actions. If it's two Shoot actions, a bolt pistol, boltgun or scoped
 * bolt pistol must be selected for at least one of them."
 *
 * Action restrictions forbid repeating an action, so the second one is its own ActionDef that
 * resolves through the universal action (docs/DECISIONS.md D-021).
 */
export const ASTARTES_SHOOT = 'Shoot (Astartes, Nemesis Claw)';
export const ASTARTES_FIGHT = 'Fight (Astartes, Nemesis Claw)';

const isNemesisClaw = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);

registerAction({
  id: ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text(R_ASTARTES),
  available: (ctx, _state, op) => isNemesisClaw(ctx, op),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    const second = params.weaponName ?? '';
    if (!ASTARTES_WEAPONS.test(first) && !ASTARTES_WEAPONS.test(second))
      return { ok: false, reason: 'a bolt pistol, boltgun or scoped bolt pistol must be selected for at least one of them' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text(R_ASTARTES),
  available: (ctx, _state, op) => isNemesisClaw(ctx, op),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    if (op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// PROCLIVITY FOR MURDER's free Charge / Dash
// ---------------------------------------------------------------------------

/**
 * "That friendly operative can immediately perform a free Charge or Dash action …, even if
 * it's performed an action that prevents it from performing those actions." `canPerformAction`
 * can only forbid, so the carve-out is its own ActionDef (D-021); `treatedAs` keeps the action
 * restriction shared with the universal action, so it can never be used twice.
 */
export const PROCLIVITY_CHARGE = 'Charge (Proclivity for Murder)';
export const PROCLIVITY_DASH = 'Dash (Proclivity for Murder)';

const hasProclivity = (state: GameState, op: OperativeState): boolean =>
  effectOn(state, op.id, FREE_ACTION_RULE)?.source.id === FP_PROCLIVITY;

registerAction({
  id: PROCLIVITY_CHARGE,
  name: 'Charge (Proclivity for Murder)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: text(FP_PROCLIVITY),
  available: (ctx, state, op) => isNemesisClaw(ctx, op) && hasProclivity(state, op),
  check(ctx, state, op, params) {
    if (!hasProclivity(state, op)) return { ok: false, reason: 'PROCLIVITY FOR MURDER has not been used' };
    if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
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

registerAction({
  id: PROCLIVITY_DASH,
  name: 'Dash (Proclivity for Murder)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Dash',
  sourceText: text(FP_PROCLIVITY),
  available: (ctx, state, op) => isNemesisClaw(ctx, op) && hasProclivity(state, op),
  check(ctx, state, op, params) {
    if (!hasProclivity(state, op)) return { ok: false, reason: 'PROCLIVITY FOR MURDER has not been used' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, { action: 'Dash', noClimb: true, mustNotFinishEngaged: true });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  perform: (ctx, state, op, params) => getAction('Dash')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------

export const nemesisClaw = defineTeam({
  id: 'nemesis-claw',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy when your opponent would activate an enemy operative that's
    //  visible to a friendly NEMESIS CLAW operative."
    [FP_VOX_SCREAM]: (state, player) =>
      aliveOperatives(state, player === 'p1' ? 'p2' : 'p1').some((o) => o.ready)
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative is ready to be activated' },
    // "…against an enemy operative that has the IMPERIUM keyword."
    [FP_DEATH_TO_FALSE_EMPEROR]: (state, player) =>
      aliveOperatives(state, player === 'p1' ? 'p2' : 'p1').some((o) =>
        (catalogueCard(o.datacardId)?.keywords ?? []).map((k) => k.toUpperCase()).includes('IMPERIUM'),
      )
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative has the IMPERIUM keyword' },
    // "Use this firefight ploy after a friendly NEMESIS CLAW operative incapacitates an enemy
    //  operative within its control range."
    [FP_PROCLIVITY]: (state, player) => {
      const last = bucket(state, LAST_KILL)[player] as { operativeId?: string; tp?: number } | undefined;
      const op = last?.operativeId ? state.operatives[last.operativeId] : undefined;
      return op && !op.removed && last?.tp === state.turningPoint && state.activeOperativeId === op.id
        ? { ok: true }
        : { ok: false, reason: 'no friendly NEMESIS CLAW operative has just incapacitated an enemy in its control range' };
    },
    // "Use this firefight ploy when a friendly NEMESIS CLAW operative is retaliating, at the
    //  start of the Resolve Attack Dice step."
    [FP_DIRTY_FIGHTER]: (state, player) =>
      state.sequence?.kind === 'fight' && state.sequence.defender === player
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative is retaliating right now' },
  },
  aiHints: {
    roles: {
      [VISIONARY]: 'leader',
      [FEARMONGER]: 'support',
      'nemesis-claw.night-lord-gunner': 'gunner',
      'nemesis-claw.night-lord-heavy-gunner': 'gunner',
      [SCREECHER]: 'melee',
      [SKINTHIEF]: 'melee',
      [VENTRILOKAR]: 'objective',
      [WARRIOR]: 'objective',
    },
    ployValue: {
      [SP_COME_FOR_YOU]: 0.5,
      [SP_BLACK_HUNT]: 0.6,
      [SP_PREYSIGHT]: 0.4,
      [SP_RETURN_TO_DARKNESS]: 0.4,
      [FP_VOX_SCREAM]: 0.5,
      [FP_DEATH_TO_FALSE_EMPEROR]: 0.7,
      [FP_PROCLIVITY]: 0.6,
      [FP_DIRTY_FIGHTER]: 0.4,
    },
    equipmentValue: {
      [EQ_FLAYED_SKIN]: 0.4,
      [EQ_CHAIN_SNARE]: 0.5,
      [EQ_GRISLY_TROPHY]: 0.6,
      [EQ_COMMS_JAMMERS]: 0.5,
    },
  },
});

export default nemesisClaw;
