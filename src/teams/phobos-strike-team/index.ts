/**
 * PHOBOS STRIKE TEAM — Space Marines.
 * https://wahapedia.ru/kill-team3/kill-teams/phobos-strike-team/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/phobos-strike-team.json`, never retyped.
 *
 * Designer's note (the ASTARTES faction rule): "A bolt weapon is any ranged weapon that
 * includes 'bolt' in its name, e.g. marksman bolt carbine, special issue bolt pistol, etc."
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { baseGap } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { advanceShoot, startShoot } from '../../core/sequences/shoot.ts';
import type { ShootSequence } from '../../core/sequences/types.ts';
import {
  aplOf,
  body,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import type {
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  Weapon,
  WeaponRule,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { isVisible } from '../../core/visibility.ts';
import { teamData } from '../data.ts';
import {
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  enemiesInControlRange,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  notEngaged,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  bucket,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('phobos-strike-team');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

const KW = 'PHOBOS STRIKE TEAM';
const EPS = 1e-6;

// Datacard ids the rules name.
const C = {
  infiltratorSergeant: 'phobos-strike-team.infiltrator-sergeant',
  commsman: 'phobos-strike-team.infiltrator-commsman',
  helixAdept: 'phobos-strike-team.infiltrator-helix-adept',
  saboteur: 'phobos-strike-team.infiltrator-saboteur',
  veteran: 'phobos-strike-team.infiltrator-veteran',
  voxbreaker: 'phobos-strike-team.infiltrator-voxbreaker',
  infiltratorWarrior: 'phobos-strike-team.infiltrator-warrior',
  incursorSergeant: 'phobos-strike-team.incursor-sergeant',
  marksman: 'phobos-strike-team.incursor-marksman',
  minelayer: 'phobos-strike-team.incursor-minelayer',
  incursorWarrior: 'phobos-strike-team.incursor-warrior',
  reiverSergeant: 'phobos-strike-team.reiver-sergeant',
  reiverWarrior: 'phobos-strike-team.reiver-warrior',
} as const;

/** The three LEADER datacards, which all print the same Tactical Advantage ability. */
const SERGEANTS: string[] = [C.infiltratorSergeant, C.incursorSergeant, C.reiverSergeant];
/** The three datacards that print the Vanguard ability. */
const VANGUARD_CARDS: string[] = [C.infiltratorWarrior, C.incursorWarrior, C.reiverWarrior];
/** The two datacards that print Grav-chute and Grapnel Launcher. */
export const GRAV_CHUTE_CARDS: string[] = [C.reiverSergeant, C.reiverWarrior];

const A = {
  tacticalAdvantage: `${C.infiltratorSergeant}.tactical-advantage`,
  strategicOversight: `${C.commsman}.strategic-oversight`,
  commsArray: `${C.commsman}.comms-array`,
  medic: `${C.helixAdept}.medic`,
  plantExplosives: `${C.saboteur}.plant-explosives`,
  detonate: `${C.saboteur}.detonate`,
  custom: `${C.veteran}.custom`,
  voxbreak: `${C.voxbreaker}.voxbreak`,
  vanguard: `${C.infiltratorWarrior}.vanguard`,
  trackTarget: `${C.marksman}.track-target`,
  haywireMine: `${C.minelayer}.haywire-mine`,
  proximityMine: `${C.minelayer}.proximity-mine`,
  gravChute: `${C.reiverSergeant}.grav-chute-and-grapnel-launcher`,
} as const;

const RULE = {
  omniScrambler: 'phobos-strike-team.rule.omni-scrambler',
  terror: 'phobos-strike-team.rule.terror',
  astartes: 'phobos-strike-team.rule.astartes',
  multiSpectrum: 'phobos-strike-team.rule.multi-spectrum-array',
} as const;

const SP = {
  guerrillaWarfare: 'phobos-strike-team.sp.guerrilla-warfare',
  knowNoFear: 'phobos-strike-team.sp.and-they-shall-know-no-fear',
  deadlyShots: 'phobos-strike-team.sp.deadly-shots',
  lethalAssaults: 'phobos-strike-team.sp.lethal-assaults',
} as const;

const FP = {
  patientAmbush: 'phobos-strike-team.fp.patient-ambush',
  criticalShot: 'phobos-strike-team.fp.critical-shot',
  transhuman: 'phobos-strike-team.fp.transhuman-physiology',
  stealthAssault: 'phobos-strike-team.fp.stealth-assault',
} as const;

const EQ = {
  puritySeals: 'phobos-strike-team.eq.purity-seals',
  additionalGrenades: 'phobos-strike-team.eq.additional-utility-grenades',
  combatBlades: 'phobos-strike-team.eq.combat-blades',
  specialAmmo: 'phobos-strike-team.eq.special-issue-ammunition',
} as const;

const ACT = {
  helixGauntlet: `${C.helixAdept}.act.helix-gauntlet`,
  auspexScan: `${C.voxbreaker}.act.auspex-scan`,
} as const;

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

/** The five move actions, for Heavy and for "an activation in which it moved". */
const MOVES = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/** ASTARTES: "A bolt weapon is any ranged weapon that includes 'bolt' in its name." */
export const isBoltWeapon = (name: string): boolean => name.toLowerCase().includes('bolt');

/** SPECIAL ISSUE AMMUNITION names its three carbines explicitly. */
const AMMO_WEAPONS = ['bolt carbine', 'marksman bolt carbine', 'occulus bolt carbine'];

const hasDetonate = (card: Datacard | undefined, weaponName?: string): Weapon | undefined =>
  (card?.weapons ?? []).find(
    (w) =>
      (weaponName === undefined || w.name === weaponName) &&
      w.profiles.some((p) => p.rules.some((r) => r.id === 'Detonate')),
  );

const markerBody = (marker: MarkerState) => ({
  id: marker.id,
  pos: marker.pos,
  z: marker.z,
  rot: 0,
  base: { shape: 'round' as const, mm: marker.diameterMm },
  height: 0.2,
});

// ---------------------------------------------------------------------------
// The two markers the team carries into the killzone
// ---------------------------------------------------------------------------

export const EXPLOSIVES_MARKER = (player: PlayerId): string => `phobos.explosives.${player}`;
export const HAYWIRE_MARKER = (player: PlayerId): string => `phobos.haywireMine.${player}`;

/**
 * Plant Explosives: "This operative is carrying your Explosives marker."
 * Haywire Mine:     "This operative is carrying your Haywire Mine marker."
 *
 * The engine creates markers at battle setup only for the map's objectives and for universal
 * equipment, so the two team markers are created the first time the module sees the battle
 * (deploy, or the first activation for tests/AI games that place operatives directly). The
 * `pickUpAllowed` flag is deliberately NOT set: only the printed operative may pick these up,
 * so each has its own Pick Up / Place action below.
 */
function ensureTeamMarkers(T: TeamHooks, state: GameState): void {
  const made = bucket(state, 'phobos.markersMade');
  if (made[T.player]) return;
  const carriers: [string, string][] = [
    [C.saboteur, EXPLOSIVES_MARKER(T.player)],
    [C.minelayer, HAYWIRE_MARKER(T.player)],
  ];
  let any = false;
  for (const [datacardId, markerId] of carriers) {
    const carrier = T.friendlies(state).find((o) => o.datacardId === datacardId);
    if (!carrier || carrier.carryingMarkerId || state.markers[markerId]) continue;
    state.markers[markerId] = {
      id: markerId,
      kind: 'generic',
      diameterMm: 20,
      pos: { ...carrier.pos },
      z: carrier.z,
      owner: T.player,
      carriedBy: carrier.id,
      flags: {},
    };
    carrier.carryingMarkerId = markerId;
    any = true;
  }
  // Only latch once operatives are on the board; before that there is nothing to carry.
  if (any || T.friendlies(state).length > 0) made[T.player] = true;
}

/** Deployment moves an operative without `applyMove`, so a carried marker is re-synced here. */
function syncCarriedMarkers(T: TeamHooks, state: GameState): void {
  for (const id of [EXPLOSIVES_MARKER(T.player), HAYWIRE_MARKER(T.player)]) {
    const marker = state.markers[id];
    if (!marker?.carriedBy) continue;
    const carrier = state.operatives[marker.carriedBy];
    if (!carrier) continue;
    marker.pos = { ...carrier.pos };
    marker.z = carrier.z;
  }
}

// ---------------------------------------------------------------------------
// INFILTRATOR VETERAN › Custom (rare weapon rule)
// ---------------------------------------------------------------------------

/** The five options the Custom rule prints, as weapon-rule tokens. */
export const CUSTOM_OPTIONS = ['Balanced', 'Lethal 5+', 'Piercing Crits 1', 'Rending', 'Saturate'] as const;
export type CustomOption = (typeof CUSTOM_OPTIONS)[number];

const CUSTOM_TAG: Record<CustomOption, () => WeaponRule> = {
  Balanced: () => ruleTag('Balanced', undefined, 'Balanced (Custom)'),
  'Lethal 5+': () => ruleTag('Lethal', 5, 'Lethal 5+ (Custom)'),
  'Piercing Crits 1': () => ruleTag('PiercingCrits', 1, 'Piercing Crits 1 (Custom)'),
  Rending: () => ruleTag('Rending', undefined, 'Rending (Custom)'),
  Saturate: () => ruleTag('Saturate', undefined, 'Saturate (Custom)'),
};

/**
 * "At the end of the Select Operatives step, if this operative is selected for deployment,
 * select up to two of the following weapon rules for this weapon to have for the battle."
 *
 * The engine has no decision channel during Select Operatives (docs/TEAM-STATUS.md § Known
 * engine gaps), so the choice is made through this pure setter — the same shape as the Angels
 * of Death `setChapterTactics` precedent (docs/DECISIONS.md D-017). Nothing applies until it
 * is called; more than two selections are refused rather than silently truncated.
 */
export function setCustomWeaponRules(state: GameState, player: PlayerId, options: CustomOption[]): boolean {
  const picked = [...new Set(options)].filter((o) => CUSTOM_OPTIONS.includes(o));
  if (picked.length !== options.length || picked.length > 2) return false;
  bucket(state, 'phobos.custom')[player] = picked;
  log(state, { kind: 'system', player, text: `Custom: ${picked.join(', ') || 'nothing selected'}` });
  return true;
}

export function customWeaponRules(state: GameState, player: PlayerId): CustomOption[] {
  const v = bucket(state, 'phobos.custom')[player];
  return Array.isArray(v) ? (v as CustomOption[]) : [];
}

// ---------------------------------------------------------------------------
// INFILTRATOR COMMSMAN › Comms Array
// ---------------------------------------------------------------------------

/**
 * "Once per turning point, during a friendly PHOBOS STRIKE TEAM operative's activation or
 * counteraction, before or after it performs an action, if this operative is in the killzone,
 * you can change one strategy ploy you've used this turning point (it doesn't cost you any CP
 * to do so)."
 *
 * There is no hook for "before or after an operative performs an action" and no intent for
 * re-writing `gambitsUsedTP`, so the mechanical effect is exposed as a pure setter the UI
 * calls (same precedent as `setCustomWeaponRules`). Everything the rule constrains — the
 * COMMSMAN being in the killzone, once per turning point, the ploy having been used this
 * turning point, no CP — is enforced here.
 */
export function useCommsArray(state: GameState, player: PlayerId, usedPloyId: string, newPloyId: string): boolean {
  const commsman = Object.values(state.operatives).some(
    (o) => !o.removed && o.player === player && o.datacardId === C.commsman,
  );
  if (!commsman) return false;
  const team = state.teams[player];
  const at = team.gambitsUsedTP.indexOf(usedPloyId);
  if (at < 0) return false;
  if (!DATA.strategyPloys.some((p) => p.id === newPloyId)) return false;
  if (team.gambitsUsedTP.includes(newPloyId)) return false;
  if (!useOncePerTP(state, `phobos.commsArray:${player}`)) return false;
  team.gambitsUsedTP[at] = newPloyId;
  log(state, {
    kind: 'ploy',
    player,
    text: `Comms Array: ${usedPloyId} changed to ${newPloyId} (0CP)`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Omni-Scrambler
// ---------------------------------------------------------------------------

const SCRAMBLED = 'phobos.scrambled';

/** Enemies the STRATEGIC GAMBIT may select. */
function scramblerTargets(T: TeamHooks, state: GameState): OperativeState[] {
  const enemies = T.enemies(state);
  if (!T.ctx) return enemies;
  const index = terrain(T.ctx, state);
  const infiltrators = T.friendlies(state, 'INFILTRATOR');
  const voxbreakers = T.friendlies(state, 'VOXBREAKER');
  return enemies.filter(
    (e) =>
      infiltrators.some((i) => isVisible(index, body(T.ctx!, i), body(T.ctx!, e)).visible) ||
      voxbreakers.some((v) => T.gap(v, e) <= 6 + EPS),
  );
}

/** Is this operative still locked down by our Omni-Scrambler? */
function scrambled(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const eff = state.effects.find(
    (e) => e.rule === SCRAMBLED && e.operativeId === op.id && e.player === T.player,
  );
  if (!eff) return false;
  const enemies = T.enemies(state);
  // "Your opponent has activated a number of enemy operatives equal to the number of friendly
  //  INFILTRATOR operatives in the killzone when this STRATEGIC GAMBIT was used."
  const activated = enemies.filter((o) => !o.ready && o.id !== op.id).length;
  if (activated >= Number(eff.data?.['threshold'] ?? 0)) return false;
  // "It's the last enemy operative to be activated."
  return enemies.some((o) => o.id !== op.id && o.ready);
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

const MEDIC_APL = 'phobos.medicApl';
const MEDIC_SHIELD = 'phobos.medicShield';
const AUSPEX_SOURCE = 'phobos.auspexScan';
const LAST_RANGED = 'phobos.lastRangedWeapon';

const medicUsedOn = (state: GameState, victimId: string): boolean =>
  Number(bucket(state, 'phobos.medicUsed')[victimId]) === state.turningPoint;

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- the two carried markers -------------------------------------------
  const markerUpkeep = (state: GameState): void => {
    ensureTeamMarkers(T, state);
    syncCarriedMarkers(T, state);
  };
  reg.on('onDeploy', T.bind(A.plantExplosives, 11), (ev) => {
    if (ev.operative.player === T.player) markerUpkeep(ev.state);
  });
  reg.on('onActivationStart', T.bind(A.plantExplosives, 11), (ev) => markerUpkeep(ev.state));
  reg.on('onReadyStep', T.bind(A.plantExplosives, 11), (ev) => {
    if (ev.player === T.player) markerUpkeep(ev.state);
  });

  // ---- Omni-Scrambler (faction rule) --------------------------------------
  // "STRATEGIC GAMBIT if a friendly INFILTRATOR operative is in the killzone."
  reg.on('gambitOptions', T.bind(RULE.omniScrambler, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (T.friendlies(ev.state, 'INFILTRATOR').length === 0) return;
    if (scramblerTargets(T, ev.state).length === 0) return;
    ev.options.push({
      id: RULE.omniScrambler,
      label: 'Omni-Scrambler (STRATEGIC GAMBIT)',
      sourceText: shortQuote(text(RULE.omniScrambler)),
    });
  });
  reg.on('onPloyUsed', T.bind(RULE.omniScrambler, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== RULE.omniScrambler) return;
    const target = chosenOperative(ev.state, ev.data, scramblerTargets(T, ev.state));
    if (!target) return;
    const threshold = T.friendlies(ev.state, 'INFILTRATOR').length;
    effect(ev.state, {
      rule: SCRAMBLED,
      source: { kind: 'ability', id: RULE.omniScrambler },
      sourceText: shortQuote(text(RULE.omniScrambler)),
      operativeId: target.id,
      player: T.player,
      data: { threshold },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Omni-Scrambler: ${target.letter} is jammed until ${threshold} enemy operatives have activated`,
    });
  });
  reg.on('canPerformAction', T.bind(RULE.omniScrambler, 17), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!scrambled(T, ev.state, ev.operative)) return;
    ev.allowed = false;
    ev.reason = 'Omni-Scrambler: that operative cannot perform actions yet';
  });

  // ---- Terror (faction rule) ----------------------------------------------
  // "…your opponent must spend 1 additional AP for that enemy operative to perform the Pick Up
  //  Marker and mission actions."
  reg.on('onActionCost', T.bind(RULE.terror, 12), (ev) => {
    if (ev.operative.player === T.player) return;
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    if (!T.friendlies(ev.state, 'REIVER').some((r) => T.gap(r, ev.operative) <= 3 + EPS)) return;
    ev.ap += 1;
  });
  // "Whenever determining control of a marker, treat the total APL stat of enemy operatives
  //  that contest it as 1 lower if at least one of those enemy operatives is within 3" of
  //  friendly REIVER operatives."
  reg.on('onMarkerControl', T.bind(RULE.terror, 13), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || !T.ctx) return;
    const reivers = T.friendlies(ev.state, 'REIVER');
    if (reivers.length === 0) return;
    const contesting = T.enemies(ev.state).filter((e) => markerContestedBy(T.ctx!, ev.state, marker, e));
    if (!contesting.some((e) => reivers.some((r) => T.gap(r, e) <= 3 + EPS))) return;
    const foe = otherPlayer(T.player);
    ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });

  // ---- Astartes (faction rule) --------------------------------------------
  // "Each friendly PHOBOS STRIKE TEAM operative can counteract regardless of its order."
  //
  // `counteractCandidates` (`src/core/phases.ts`) emits `onCounteract` for every expended,
  // not-yet-counteracted operative with `allowed: o.order === 'engage'` as the DEFAULT, so this
  // handler WIDENS that default rather than narrowing it. It widens the ORDER requirement only:
  // expended, once per turning point and the On Guard lockout ("that friendly operative cannot
  // counteract during the turning point") stay the core's job, and this must not touch them.
  // Scope is exactly as printed — friendly (ours) and PHOBOS STRIKE TEAM.
  reg.on('onCounteract', T.bind(RULE.astartes, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    ev.allowed = true;
  });
  // The second Shoot/Fight action is registered below; remember the ranged weapon used so the
  // "a bolt weapon must be selected for at least one of them" clause can be checked.
  reg.on('onCollectAttackDice', T.bind(RULE.astartes, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: RULE.astartes },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  // ---- Multi-Spectrum Array (faction rule) --------------------------------
  // "Whenever a friendly INCURSOR operative is shooting, enemy operatives cannot be obscured."
  reg.on('onCollectAttackDice', T.bind(RULE.multiSpectrum, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, 'INCURSOR')) return;
    const seq = shootSeq(ev.state);
    if (seq && seq.obscured) seq.obscured = false;
  });

  // ---- SERGEANTs › Tactical Advantage -------------------------------------
  // "You can use a firefight ploy for 0CP if this is the specified PHOBOS STRIKE TEAM
  //  operative … or the Patient Ambush firefight ploy for 0CP if this operative is ready and
  //  not within control range of enemy operatives."  CP is deducted before `onPloyUsed`
  //  fires, so the discount can only be a refund (docs/TEAM-STATUS.md).
  reg.on('onPloyUsed', T.bind(A.tacticalAdvantage, 12), (ev) => {
    if (ev.player !== T.player || ev.kind !== 'firefight') return;
    const sergeants = T.friendlies(ev.state).filter((o) => SERGEANTS.includes(o.datacardId));
    if (sergeants.length === 0) return;
    const named = ev.data?.['operativeId'];
    let sergeant = typeof named === 'string' ? sergeants.find((s) => s.id === named) : undefined;
    if (!sergeant && ev.ployId === FP.patientAmbush)
      sergeant = sergeants.find(
        (s) => s.ready && T.enemies(ev.state).every((e) => T.gap(s, e) > 1 + EPS),
      );
    if (!sergeant) return;
    if (!useOncePerBattle(ev.state, `phobos.tacticalAdvantage:${sergeant.id}`)) return;
    const cp = DATA.firefightPloys.find((p) => p.id === ev.ployId)?.cp ?? 0;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Tactical Advantage: ${sergeant.letter} makes that firefight ploy cost 0CP`,
    });
  });

  // ---- INFILTRATOR COMMSMAN › Strategic Oversight -------------------------
  // "In the Ready step of each Strategy phase, when you gain CP … roll one D6: on a 4+, you
  //  gain one additional CP."
  reg.on('onReadyStep', T.bind(A.strategicOversight, 12), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const commsman = T.friendlies(ev.state).find(
      (o) => o.datacardId === C.commsman && T.enemies(ev.state).every((e) => T.gap(o, e) > 1 + EPS),
    );
    if (!commsman) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'strategicOversight', [roll], T.player, 'Strategic Oversight 4+');
    if (roll >= 4) ev.cp += 1;
  });

  // ---- INFILTRATOR HELIX ADEPT › Medic! -----------------------------------
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
        o.datacardId === C.helixAdept &&
        o.id !== victim.id &&
        !o.incapacitated &&
        T.gap(o, victim) <= 3 + EPS &&
        visibleTo(T, ev.state, o, victim) &&
        T.enemies(ev.state).every((e) => T.gap(e, o) > 1 + EPS && T.gap(e, victim) > 1 + EPS),
    );
    if (!medic) return;
    // "You cannot use this rule … if it's a Shoot action and this operative would be a primary
    //  or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    if (!useOncePerTP(ev.state, `phobos.medic:${medic.id}`)) return;

    ev.prevented = true;
    const wounds = T.ctx ? T.ctx.rng.d3() : 1; // "has D3 wounds remaining"
    recordRoll(ev.state, 'medic', [wounds], T.player, 'Medic! D3 wounds remaining');
    victim.wounds = wounds;
    bucket(ev.state, 'phobos.medicUsed')[victim.id] = ev.state.turningPoint;
    // "…cannot be incapacitated for the remainder of the action." Nothing expires an
    // `endOfAction` effect (`expireEffects` only runs at the end of the turning point), so the
    // shield is pinned to the activation in flight instead — the smallest window the engine
    // actually closes.
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: A.medic },
      sourceText: shortQuote(abilityText(C.helixAdept, A.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? victim.id },
    });
    // "After that action, that friendly operative can immediately perform a free Dash action."
    // "…and if this rule was used during that friendly operative's activation, that activation
    //  ends" — modelled as spending the rest of its AP, leaving only the granted Dash.
    if (ev.state.activeOperativeId === victim.id) victim.apSpent = currentApl(T, ev.state, victim);
    grantFreeAction(ev.state, victim, {
      sourceId: A.medic,
      sourceText: shortQuote(abilityText(C.helixAdept, A.medic)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, victim),
      only: ['Dash'],
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next
    //  activations respectively." The medic's lands now; the victim's is deferred to the start
    //  of its next activation so it does not cancel the free Dash it has just been granted.
    medic.aplMods.push(-1);
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
      data: { pending: true },
      expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Medic! ${medic.letter} keeps ${victim.letter} on ${wounds} wounds`,
    });
  });
  reg.on('onActivationStart', T.bind(A.medic, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    const data = effectOn(ev.state, ev.operative.id, MEDIC_APL)?.data;
    if (!data || !data['pending']) return;
    delete data['pending'];
    ev.operative.aplMods.push(-1);
  });

  // ---- INFILTRATOR SABOTEUR › Detonate (rare weapon rule) -----------------
  // "This weapon cannot be selected if your Explosives marker isn't in the killzone."
  reg.on('availableWeapons', T.bind(A.detonate, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const detonator = hasDetonate(T.card(ev.operative));
    if (!detonator) return;
    if (ev.state.markers[EXPLOSIVES_MARKER(T.player)]) return;
    // Never withdraw the weapon while its own sequence is still resolving.
    const seq = shootSeq(ev.state);
    if (seq && seq.weaponName === detonator.name && seq.attackerId === ev.operative.id) return;
    ev.weapons = ev.weapons.filter((n) => n !== detonator.name);
  });
  // "Don't select a valid target" — the Detonate shot goes through the engine's point-blank
  // path (the only way to shoot an operative that is not a valid target); the point-blank Hit
  // penalty is cancelled here because Detonate does not print one.
  reg.on('onStatMod', T.bind(A.detonate, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !seq.pointBlank) return;
    if (!hasDetonate(T.card(ev.operative), seq.weaponName)) return;
    ev.mods.hit += 1;
  });
  // "In a killzone that uses the close quarters rules … this weapon has the Lethal 5+ weapon
  //  rule."
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

  // ---- INFILTRATOR VETERAN › Custom (rare weapon rule) --------------------
  reg.on('onWeaponRules', T.bind(A.custom, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ev.profile.rules.some((r) => r.id === 'Custom')) return;
    for (const option of customWeaponRules(ev.state, T.player)) ev.rules.push(CUSTOM_TAG[option]());
  });

  // ---- INFILTRATOR VOXBREAKER › Voxbreak ----------------------------------
  // "Whenever an enemy operative is within 6" of this operative, your opponent cannot re-roll
  //  their attack or defence dice for that operative." Priority 40 so it strips grants pushed
  //  by team rules, ploys and equipment alike.
  const jammed = (state: GameState, op: OperativeState | undefined): boolean =>
    Boolean(op) &&
    op!.player !== T.player &&
    T.friendlies(state).some((v) => v.datacardId === C.voxbreaker && T.gap(v, op!) <= 6 + EPS);
  reg.on('onRollAttack', T.bindText(`${A.voxbreak}.attack`, abilityText(C.voxbreaker, A.voxbreak), 40), (ev) => {
    if (!jammed(ev.state, ev.ctx.attacker)) return;
    ev.rerolls = ev.rerolls.filter((r) => r.player === T.player);
  });
  reg.on('onDefenceDice', T.bindText(`${A.voxbreak}.defence`, abilityText(C.voxbreaker, A.voxbreak), 40), (ev) => {
    if (!jammed(ev.state, ev.ctx.defender)) return;
    ev.rerolls = ev.rerolls.filter((r) => r.player === T.player);
  });

  // ---- WARRIORs › Vanguard ------------------------------------------------
  // "Once per turning point, one friendly PHOBOS STRIKE TEAM operative with this rule can
  //  perform the Pick Up Marker or a mission action for 1 less AP."
  reg.on('onActionCost', T.bind(A.vanguard, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!VANGUARD_CARDS.includes(ev.operative.datacardId)) return;
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    if (usedThisTP(ev.state, `phobos.vanguard:${T.player}`)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  reg.on('onActivationEnd', T.bind(A.vanguard, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!VANGUARD_CARDS.includes(ev.operative.datacardId)) return;
    const spent = ev.operative.actionsThisActivation.some(
      (a) => a === 'Pick Up Marker' || getAction(a)?.type === 'mission',
    );
    if (spent) useOncePerTP(ev.state, `phobos.vanguard:${T.player}`);
  });

  // ---- INCURSOR MARKSMAN › Track Target -----------------------------------
  // "…but when you perform the free Shoot or Fight action during the interruption, you must
  //  change its order to Engage."  The free interrupt sequence is the only signal the engine
  //  gives, so the order is changed as its dice are collected.
  reg.on('onCollectAttackDice', T.bind(A.trackTarget, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.marksman || op.order !== 'conceal') return;
    const seq = ev.state.sequence;
    if (!seq || !seq.free || seq.attackerId !== op.id) return;
    op.order = 'engage';
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${op.letter} changes its order to Engage (Track Target)`,
    });
  });

  // ---- INCURSOR MINELAYER › Proximity Mine --------------------------------
  // "The first time your Haywire Mine marker is within another operative's control range,
  //  remove that marker, subtract 1 from that operative's APL stat until the end of its next
  //  activation, and inflict 2D3+3 damage on it."
  //
  // PARTIAL: nothing in the engine reports a completed move leg (`checkMines` in
  // `src/core/actions.ts` is core-only and hard-codes the universal Mines marker), so the mine
  // is sprung at the activation boundaries — the damage and the APL loss land, but "end its
  // action" cannot be honoured. Reported as a seam.
  const springMine = (state: GameState): void => {
    if (!T.ctx) return;
    const marker = state.markers[HAYWIRE_MARKER(T.player)];
    if (!marker || marker.carriedBy) return;
    const layer = T.friendlies(state).find((o) => o.datacardId === C.minelayer);
    const victim = [...T.friendlies(state), ...T.enemies(state)]
      .filter((o) => o.id !== layer?.id) // "this operative is ignored for these effects"
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .find((o) => markerContestedBy(T.ctx!, state, marker, o));
    if (!victim) return;
    removeMarker(state, marker.id);
    const damage = T.ctx.rng.d3() + T.ctx.rng.d3() + 3;
    recordRoll(state, 'haywireMine', [damage], T.player, 'Proximity Mine 2D3+3');
    victim.aplMods.push(-1);
    effect(state, {
      rule: 'phobos.proximityMine',
      source: { kind: 'ability', id: A.proximityMine },
      sourceText: shortQuote(abilityText(C.minelayer, A.proximityMine)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
    });
    log(state, {
      kind: 'action',
      player: T.player,
      text: `${victim.letter} sets off the Haywire Mine (${damage} damage, -1 APL)`,
    });
    inflictDamage(T.ctx, state, victim, damage, 'mine');
  };
  reg.on('onActivationStart', T.bind(A.proximityMine, 14), (ev) => springMine(ev.state));
  reg.on('onActivationEnd', T.bind(A.proximityMine, 15), (ev) => springMine(ev.state));

  // ---- INCURSOR MINELAYER › Haywire Mine ----------------------------------
  // "(if this operative is incapacitated while carrying that marker and that marker cannot be
  //  placed, it's removed with this operative)"
  reg.on('onIncapacitated', T.bind(A.haywireMine, 16), (ev) => {
    const op = ev.operative;
    if (ev.prevented || op.player !== T.player || op.datacardId !== C.minelayer) return;
    if (op.carryingMarkerId !== HAYWIRE_MARKER(T.player)) return;
    if (!T.enemies(ev.state).some((e) => T.gap(e, op) <= 2 + EPS)) return;
    removeMarker(ev.state, op.carryingMarkerId);
    op.carryingMarkerId = undefined;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${op.letter}'s Haywire Mine marker cannot be placed and is removed with it`,
    });
  });
  // The universal Place Marker action cannot express "cannot be placed within an enemy
  // operative's control range", so the two carried markers get their own placement actions
  // (below) and the universal one is refused while they are being carried.
  reg.on('canPerformAction', T.bind(A.haywireMine, 17), (ev) => {
    if (ev.operative.player !== T.player || ev.action !== 'Place Marker') return;
    const carried = ev.operative.carryingMarkerId;
    if (carried !== HAYWIRE_MARKER(T.player) && carried !== EXPLOSIVES_MARKER(T.player)) return;
    ev.allowed = false;
    ev.reason = 'use this operative’s own Place Marker action for that marker';
  });

  // ---- INFILTRATOR VOXBREAKER › AUSPEX SCAN (unique action) ---------------
  // "…whenever a friendly PHOBOS STRIKE TEAM operative is shooting an enemy operative within
  //  8" of this operative, that enemy operative cannot be obscured; if that friendly operative
  //  is an INCURSOR, its ranged weapons also have the Seek Light weapon rule."
  const scannedBy = (state: GameState, target: OperativeState): boolean =>
    state.effects.some((e) => {
      if (e.rule !== AUSPEX_SOURCE || e.player !== T.player) return false;
      const scanner = e.operativeId ? state.operatives[e.operativeId] : undefined;
      return Boolean(scanner) && !scanner!.removed && T.gap(scanner!, target) <= 8 + EPS;
    });
  reg.on('onCollectAttackDice', T.bindText(ACT.auspexScan, actionText(C.voxbreaker, ACT.auspexScan), 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const seq = shootSeq(ev.state);
    const target = ev.ctx.defender;
    if (!seq || !target || !scannedBy(ev.state, target)) return;
    seq.obscured = false;
  });
  reg.on('onWeaponRules', T.bindText(ACT.auspexScan, actionText(C.voxbreaker, ACT.auspexScan), 13), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, 'INCURSOR') || !ev.target) return;
    if (!scannedBy(ev.state, ev.target)) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (AUSPEX SCAN)'));
  });
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- GUERRILLA WARFARE (strategy) --------------------------------------
  // The unique action it hands out is registered globally below and gated on the gambit.

  // ---- AND THEY SHALL KNOW NO FEAR (strategy) ----------------------------
  // "You can ignore any changes to the stats of friendly PHOBOS STRIKE TEAM operatives from
  //  being injured (including their weapons' stats)."
  reg.on('onStatMod', T.bind(SP.knowNoFear, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.knowNoFear)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2; // cancels the injured -2" Move
    ev.mods.hit += 1; // cancels the injured Hit worsening
  });

  // ---- DEADLY SHOTS (strategy) -------------------------------------------
  reg.on('onWeaponRules', T.bind(SP.deadlyShots, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.deadlyShots)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    // "…during an activation in which it hasn't performed the Charge, Fall Back or Reposition
    //  action, or against an operative that isn't in cover and is more than 6" from it"
    const stillStanding = !['Charge', 'Fall Back', 'Reposition'].some((a) =>
      ev.operative.actionsThisActivation.includes(a),
    );
    let farAndExposed = false;
    if (ev.target) {
      const seq = shootSeq(ev.state);
      const inCover = seq && seq.targetId === ev.target.id ? seq.inCover : false;
      farAndExposed = !inCover && T.gap(ev.operative, ev.target) > 6 + EPS;
    }
    if (!stillStanding && !farAndExposed) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Deadly Shots)'));
  });

  // ---- LETHAL ASSAULTS (strategy) ----------------------------------------
  reg.on('onWeaponRules', T.bind(SP.lethalAssaults, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.lethalAssaults)) return;
    if (ev.type !== 'melee' || ev.retaliating || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Lethal Assaults)'));
    // "If that friendly operative is doing so during an activation in which it performed the
    //  Charge action, its melee weapons also have the Lethal 5+ weapon rule."
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    if (ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Lethal Assaults)'));
  });

  // ---- PATIENT AMBUSH (firefight) ----------------------------------------
  // "Use this firefight ploy when it's your turn to activate a friendly operative. You can
  //  skip that activation." The engine has no skip intent, so the activation is handed to the
  //  opponent — every ready operative keeps its ready status.
  reg.on('onPloyUsed', T.bind(FP.patientAmbush, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.patientAmbush) return;
    ev.state.activePlayer = otherPlayer(T.player);
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Patient Ambush: that activation is skipped' });
  });

  // ---- CRITICAL SHOT (firefight) -----------------------------------------
  // "Use this firefight ploy when you resolve a critical success for a friendly PHOBOS STRIKE
  //  TEAM operative that's shooting with a bolt weapon. Inflict D3 additional damage."
  //
  // `ploysUsedTP` stays true for the whole turning point, so the ploy arms a one-shot flag
  // instead: it applies to the sequence it was used in, once.
  reg.on('onPloyUsed', T.bind(FP.criticalShot, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.criticalShot) return;
    bucket(ev.state, 'phobos.criticalShotArmed')[T.player] = true;
  });
  reg.on('onDamage', T.bind(FP.criticalShot, 21), (ev) => {
    const armed = bucket(ev.state, 'phobos.criticalShotArmed');
    if (ev.kind !== 'attack' || !armed[T.player]) return;
    const seq = shootSeq(ev.state);
    if (!seq || !isBoltWeapon(seq.weaponName)) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || !T.mineKw(attacker, KW)) return;
    if (!seq.attack.dice.some((d) => d.state === 'crit')) return;
    delete armed[T.player];
    const extra = T.ctx ? T.ctx.rng.d3() : 2;
    recordRoll(ev.state, 'criticalShot', [extra], T.player, 'Critical Shot D3');
    ev.amount += extra;
  });

  // ---- TRANSHUMAN PHYSIOLOGY (firefight) ---------------------------------
  // "…in the Roll Defence Dice step. You can retain one of your normal successes as a critical
  //  success instead." Applied to the sequence the ploy was used in, once — the defence dice
  //  are normally already rolled, so the promotion happens as the ploy resolves.
  reg.on('onPloyUsed', T.bind(FP.transhuman, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.transhuman) return;
    const seq = shootSeq(ev.state);
    if (seq && seq.defender === T.player && promoteNormal(seq)) return;
    bucket(ev.state, 'phobos.transhumanArmed')[T.player] = true;
  });
  reg.on('onDefenceDice', T.bind(FP.transhuman, 21), (ev) => {
    const armed = bucket(ev.state, 'phobos.transhumanArmed');
    if (!armed[T.player]) return;
    const target = ev.ctx.defender;
    const seq = shootSeq(ev.state);
    if (!seq || !target || !T.mineKw(target, KW) || seq.targetId !== target.id) return;
    if (!promoteNormal(seq)) return;
    delete armed[T.player];
  });

  // ---- STEALTH ASSAULT (firefight) ---------------------------------------
  // "After doing so, you can immediately resolve another of your attack dice (before your
  //  opponent)." REMINDER-ONLY: `resolveFightDie` flips `seq.turn` after `onStrikeResolved`
  //  fires and nothing runs afterwards, so a rule cannot keep the turn. Reported as a seam.
}

/** "You can retain one of your normal successes as a critical success instead." */
function promoteNormal(seq: ShootSequence): boolean {
  const normal = seq.defence.dice.find((d) => d.state === 'normal');
  if (!normal) return false;
  normal.state = 'crit';
  normal.note = 'Transhuman Physiology';
  return true;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/** "COMBAT BLADES — Combat blade 5 / 3+ / 3/4" (phobos-strike-team.json › equipment). */
const COMBAT_BLADE: Weapon = (
  DATA.equipment.find((e) => e.id === EQ.combatBlades) as unknown as { weapons: Weapon[] }
).weapons[0]!;

/** The universal Utility Grenades equipment this option borrows (src/core/equipment/grenades.ts). */
const UTILITY_GRENADES = 'eq.utilityGrenades';

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- PURITY SEALS ------------------------------------------------------
  // "Once per turning point, when a friendly PHOBOS STRIKE TEAM operative is shooting,
  //  fighting or retaliating, if you roll two or more fails, you can discard one of them to
  //  retain another as a normal success instead."
  //  PARTIAL: `onRollAttack` is only emitted by the shoot sequence, so the fighting and
  //  retaliating half has no seam. Reported.
  reg.on('onRollAttack', T.bind(EQ.puritySeals, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.puritySeals)) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    if (usedThisTP(ev.state, `phobos.puritySeals:${T.player}`)) return;
    const seq = ev.state.sequence;
    const pool = seq?.kind === 'shoot' ? seq.attack : seq?.kind === 'fight' ? seq.attackerPool : undefined;
    if (!pool || pool.dice.filter((d) => d.state === 'fail').length < 2) return;
    useOncePerTP(ev.state, `phobos.puritySeals:${T.player}`);
    ev.rerolls.push({
      id: 'phobos.puritySeals',
      label: 'Purity Seals: discard one fail to retain another as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(EQ.puritySeals)),
    });
  });

  // ---- ADDITIONAL UTILITY GRENADES ---------------------------------------
  // "This equipment allows you to select four utility grenades from the utility grenades
  //  equipment (see universal equipment). You cannot also select that equipment as normal
  //  (i.e. to give you six)."
  reg.on('onSelectEquipment', T.bind(EQ.additionalGrenades, 30), (ev) => {
    if (ev.player !== T.player || !ev.equipment.includes(EQ.additionalGrenades)) return;
    const team = ev.state.teams[T.player];
    if (!team.equipment.includes(UTILITY_GRENADES)) team.equipment.push(UTILITY_GRENADES);
    // Four grenades in total, never six: the allowance is set, not added to.
    team.equipmentUses[`${UTILITY_GRENADES}:smoke`] = 2;
    team.equipmentUses[`${UTILITY_GRENADES}:stun`] = 2;
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: 'Additional Utility Grenades: four utility grenades (2 smoke, 2 stun)',
    });
  });

  // ---- COMBAT BLADES -----------------------------------------------------
  const giveBlades = (state: GameState): void => {
    if (!hasEquipment(state, T.player, EQ.combatBlades)) return;
    for (const o of T.friendlies(state, KW)) grantWeapon(o, structuredClone(COMBAT_BLADE));
  };
  reg.on('onDeploy', T.bind(EQ.combatBlades, 30), (ev) => {
    if (ev.operative.player === T.player) giveBlades(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.combatBlades, 31), (ev) => {
    if (ev.operative.player === T.player) giveBlades(ev.state);
  });

  // ---- SPECIAL ISSUE AMMUNITION ------------------------------------------
  // "Once per turning point, when a friendly … operative is performing the Shoot action and you
  //  select a bolt carbine, marksman bolt carbine or occulus bolt carbine, you can use this
  //  rule. If you do, until the end of the turning point, that weapon has the Piercing 1
  //  weapon rule."
  reg.on('onSelectWeapon', T.bind(EQ.specialAmmo, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    if (!hasEquipment(ev.state, T.player, EQ.specialAmmo)) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    if (!AMMO_WEAPONS.includes(ev.ctx.weaponName.toLowerCase())) return;
    if (!useOncePerTP(ev.state, `phobos.specialAmmo:${T.player}`)) return;
    bucket(ev.state, 'phobos.specialAmmoOn')[T.player] = {
      tp: ev.state.turningPoint,
      weapon: ev.ctx.weaponName,
      operativeId: ev.ctx.attacker.id,
    };
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Special Issue Ammunition: ${ev.ctx.weaponName} has Piercing 1 this turning point`,
    });
  });
  reg.on('onWeaponRules', T.bind(EQ.specialAmmo, 31), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    const on = bucket(ev.state, 'phobos.specialAmmoOn')[T.player] as
      | { tp: number; weapon: string; operativeId: string }
      | undefined;
    if (!on || on.tp !== ev.state.turningPoint) return;
    if (on.operativeId !== ev.operative.id || on.weapon !== ev.weaponName) return;
    if (ev.rules.some((r) => r.id === 'Piercing')) return;
    ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (Special Issue Ammunition)'));
  });
}

// ---------------------------------------------------------------------------
// Datacard unique actions
// ---------------------------------------------------------------------------

function actions(data: typeof DATA) {
  return [
    // HELIX GAUNTLET 1AP — INFILTRATOR HELIX ADEPT
    uniqueAction(data, C.helixAdept, ACT.helixGauntlet, {
      // "Select one friendly PHOBOS STRIKE TEAM operative within this operative's control range
      //  to regain up to D3+3 lost wounds. It cannot be an operative that the Medic! rule was
      //  used on during this turning point."
      // Validated HERE, not in perform: a perform failure is reverted AND recorded as a
      // rejected intent (docs/DECISIONS.md D-026).
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player)
          return { ok: false, reason: 'select one friendly PHOBOS STRIKE TEAM operative' };
        if (!inControlRange(ctx, state, op, target))
          return { ok: false, reason: 'that operative is not within this operative’s control range' };
        if (medicUsedOn(state, target.id))
          return { ok: false, reason: 'the Medic! rule was used on that operative during this turning point' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const heal = ctx.rng.d3() + 3;
        recordRoll(state, 'helixGauntlet', [heal], op.player, 'HELIX GAUNTLET D3+3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: HELIX GAUNTLET restores ${heal} wounds to ${target.letter}`,
        });
        return { ok: true };
      },
    }),

    // AUSPEX SCAN 1AP — INFILTRATOR VOXBREAKER
    uniqueAction(data, C.voxbreaker, ACT.auspexScan, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === AUSPEX_SOURCE && e.operativeId === op.id);
        effect(state, {
          rule: AUSPEX_SOURCE,
          source: { kind: 'ability', id: ACT.auspexScan },
          sourceText: shortQuote(actionText(C.voxbreaker, ACT.auspexScan)),
          operativeId: op.id,
          player: op.player,
          // "Until the start of this operative's next activation or until it's incapacitated."
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: AUSPEX SCAN (enemies within 8" cannot be obscured)`,
        });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// ASTARTES — the second Shoot / Fight action
// ---------------------------------------------------------------------------

/**
 * "During each friendly PHOBOS STRIKE TEAM operative's activation, it can perform either two
 * Shoot actions or two Fight actions. If it's two Shoot actions, a bolt weapon must be selected
 * for at least one of them."
 *
 * Action restrictions forbid repeating an action, so the second is its own registered action
 * with its own restriction key. The id is team-scoped: `registerAction` is a single global
 * registry and every Astartes kill team ships this rule.
 */
export const ASTARTES_SHOOT = 'Shoot (Phobos Astartes)';
export const ASTARTES_FIGHT = 'Fight (Phobos Astartes)';

const isPst = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);
const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

registerAction({
  id: ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text(RULE.astartes),
  available: (ctx, _state, op) => isPst(ctx, op),
  check(ctx, state, op, params) {
    if (did(op, 'Fight')) return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    if (!did(op, 'Shoot')) return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    if (!isBoltWeapon(first) && !isBoltWeapon(params.weaponName ?? ''))
      return { ok: false, reason: 'a bolt weapon must be selected for at least one of them' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text(RULE.astartes),
  available: (ctx, _state, op) => isPst(ctx, op),
  check(ctx, state, op, params) {
    if (did(op, 'Shoot')) return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    if (!did(op, 'Fight')) return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// GUERRILLA WARFARE — the unique action the strategy ploy hands out
// ---------------------------------------------------------------------------

export const GUERRILLA_WARFARE_ACTION = 'phobos-strike-team.act.guerrilla-warfare';

registerAction({
  id: GUERRILLA_WARFARE_ACTION,
  name: 'GUERRILLA WARFARE',
  ap: 1,
  type: 'unique',
  sourceText: text(SP.guerrillaWarfare),
  available: (ctx, state, op) => isPst(ctx, op) && gambitUsed(state, op.player, SP.guerrillaWarfare),
  check(ctx, state, op) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.order = op.order === 'conceal' ? 'engage' : 'conceal';
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter}: GUERRILLA WARFARE — order changed to ${op.order}`,
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// INCURSOR MARKSMAN › Track Target — Guard regardless of the killzone or order
// ---------------------------------------------------------------------------

/**
 * "This operative can perform the Guard action regardless of the killzone (see close quarters
 * rules, Kill Team Core Book). It can perform the Guard action while it has a Conceal order."
 *
 * The universal Guard action is gated on `map.closeQuarters` and refuses a Conceal order, and
 * `canPerformAction` can only forbid, never permit (docs/DECISIONS.md D-021), so the grant is
 * its own action treated as a Shoot action, exactly like the universal one.
 */
export const TRACK_TARGET_GUARD = 'Guard (Track Target)';

registerAction({
  id: TRACK_TARGET_GUARD,
  name: 'Guard (Track Target)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(C.marksman, A.trackTarget),
  available: (_ctx, _state, op) => op.datacardId === C.marksman,
  check(ctx, state, op) {
    if (state.opState['counteract']?.['operativeId'] === op.id)
      return { ok: false, reason: 'a counteraction cannot be the Guard action' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.onGuard = true;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} goes on Guard (Track Target)` });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// The two carried markers: Pick Up / Place, and the Detonate shot
// ---------------------------------------------------------------------------

interface CarriedMarkerSpec {
  pickUpId: string;
  placeId: string;
  datacardId: string;
  markerId: (player: PlayerId) => string;
  sourceText: string;
  /** Haywire Mine: "that marker cannot be placed within an enemy operative's control range". */
  keepAwayFromEnemies?: boolean;
  /** Plant Explosives: "…it can immediately perform a free Dash action". */
  freeDash?: boolean;
}

function registerCarriedMarker(spec: CarriedMarkerSpec): void {
  registerAction({
    id: spec.pickUpId,
    name: spec.pickUpId,
    ap: 1,
    type: 'unique',
    treatedAs: 'Pick Up Marker',
    sourceText: spec.sourceText,
    available: (_ctx, _state, op) => op.datacardId === spec.datacardId,
    check(ctx, state, op) {
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
      const marker = state.markers[spec.markerId(op.player)];
      if (!marker) return { ok: false, reason: 'that marker is not in the killzone' };
      if (marker.carriedBy) return { ok: false, reason: 'that marker is already being carried' };
      if (!markerContestedBy(ctx, state, marker, op))
        return { ok: false, reason: 'that marker is not within this operative’s control range' };
      return { ok: true };
    },
    perform(_ctx, state, op) {
      const marker = state.markers[spec.markerId(op.player)]!;
      marker.carriedBy = op.id;
      marker.pos = { ...op.pos };
      marker.z = op.z;
      op.carryingMarkerId = marker.id;
      log(state, { kind: 'action', player: op.player, text: `${op.letter} picks up the ${marker.id} marker` });
      return { ok: true };
    },
  });

  registerAction({
    id: spec.placeId,
    name: spec.placeId,
    ap: 1,
    type: 'unique',
    treatedAs: 'Place Marker',
    sourceText: spec.sourceText,
    available: (_ctx, _state, op) => op.datacardId === spec.datacardId,
    check(ctx, state, op, params) {
      const markerId = spec.markerId(op.player);
      if (op.carryingMarkerId !== markerId) return { ok: false, reason: 'not carrying that marker' };
      if (did(op, 'Pick Up Marker') && !op.incapacitated)
        return { ok: false, reason: 'already performed Pick Up Marker this activation' };
      const pos = placementPos(ctx, state, op, params.markerPos);
      if (!pos.ok) return pos;
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      const marker = state.markers[op.carryingMarkerId!]!;
      const pos = placementPos(ctx, state, op, params.markerPos);
      if (!pos.ok) return pos;
      marker.carriedBy = undefined;
      marker.pos = { ...pos.pos! };
      marker.z = op.z;
      op.carryingMarkerId = undefined;
      log(state, { kind: 'action', player: op.player, text: `${op.letter} places the ${marker.id} marker` });
      if (spec.freeDash) {
        grantFreeAction(state, op, {
          sourceId: spec.placeId,
          sourceText: shortQuote(spec.sourceText),
          kind: 'ability',
          threshold: aplOf(ctx, state, op),
          only: ['Dash'],
        });
      }
      return { ok: true };
    },
  });

  /** "Place a marker the active operative is carrying within its control range." */
  function placementPos(
    ctx: GameContext,
    state: GameState,
    op: OperativeState,
    requested: Vec2 | undefined,
  ): { ok: boolean; reason?: string; pos?: Vec2 } {
    const pos = requested ?? { ...op.pos };
    const probe: MarkerState = { id: 'probe', kind: 'generic', diameterMm: 20, pos, z: op.z, flags: {} };
    if (!markerContestedBy(ctx, state, probe, op))
      return { ok: false, reason: 'the marker must be placed within control range' };
    if (spec.keepAwayFromEnemies) {
      const foe = otherPlayer(op.player);
      const blocked = Object.values(state.operatives).some(
        (e) => !e.removed && e.player === foe && markerContestedBy(ctx, state, probe, e),
      );
      if (blocked) return { ok: false, reason: 'that marker cannot be placed within an enemy operative’s control range' };
    }
    return { ok: true, pos };
  }
}

registerCarriedMarker({
  pickUpId: 'Pick Up Marker (Explosives)',
  placeId: 'Place Marker (Explosives)',
  datacardId: C.saboteur,
  markerId: EXPLOSIVES_MARKER,
  sourceText: abilityText(C.saboteur, A.plantExplosives),
  freeDash: true,
});

registerCarriedMarker({
  pickUpId: 'Pick Up Marker (Haywire Mine)',
  placeId: 'Place Marker (Haywire Mine)',
  datacardId: C.minelayer,
  markerId: HAYWIRE_MARKER,
  sourceText: abilityText(C.minelayer, A.haywireMine),
  keepAwayFromEnemies: true,
});

/**
 * INFILTRATOR SABOTEUR › Detonate (rare weapon rule): "Don't select a valid target. Instead,
 * shoot against each operative within 2" of your Explosives marker, unless Heavy terrain is
 * wholly intervening between that operative and that marker… Roll each sequence separately in
 * an order of your choice… At the end of the action, remove your Explosives marker."
 *
 * The victims are queued exactly as Blast secondaries are, so the whole shoot sequence (dice,
 * rerolls, decisions) is the engine's own.
 */
export const DETONATE_SHOOT = 'Shoot (Detonate)';

registerAction({
  id: DETONATE_SHOOT,
  name: 'Shoot (Detonate)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(C.saboteur, A.detonate),
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
      const moved = op.actionsThisActivation.some((a) =>
        ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'].includes(a),
      );
      if (moved && !(heavy.only && op.actionsThisActivation.every((a) => a === heavy.only || !MOVES.includes(a))))
        return { ok: false, reason: `${weapon.name} is Heavy — it cannot be used in an activation in which it moved` };
    }
    // "This weapon cannot be selected if your Explosives marker isn't in the killzone."
    const marker = state.markers[EXPLOSIVES_MARKER(op.player)];
    if (!marker) return { ok: false, reason: 'your Explosives marker isn’t in the killzone' };
    if (detonateVictims(ctx, state, marker).length === 0)
      return { ok: false, reason: 'no operative is within 2" of your Explosives marker' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = hasDetonate(ctx.datacards.get(op.datacardId), params.weaponName)!;
    const marker = state.markers[EXPLOSIVES_MARKER(op.player)]!;
    const victims = detonateVictims(ctx, state, marker);
    const primary = victims[0]!;
    // Point-blank is the engine's "not a valid target" path; its Hit penalty is cancelled by
    // the Detonate stat hook.
    const r = startShoot(ctx, state, op, weapon.name, params.profileName, primary.id, { pointBlank: true });
    if (!r.ok) return r;
    const seq = state.sequence as ShootSequence;
    seq.queue = victims.slice(1).map((o) => o.id);
    seq.inCover = false;
    seq.obscured = false;
    seq.coverChoiceMade = true;
    // "At the end of the action, remove your Explosives marker from the killzone."
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
 * "…each operative within 2" of your Explosives marker, unless Heavy terrain is wholly
 * intervening between that operative and that marker."
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

export const phobosStrikeTeam = defineTeam({
  id: 'phobos-strike-team',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy when it's your turn to activate a friendly operative."
    [FP.patientAmbush]: (state, player) => {
      if (state.phase !== 'firefight' || state.activeOperativeId)
        return { ok: false, reason: 'use this ploy when it is your turn to activate a friendly operative' };
      if (state.activePlayer !== player)
        return { ok: false, reason: 'it is not your turn to activate a friendly operative' };
      if (!Object.values(state.operatives).some((o) => !o.removed && o.player === player && o.ready))
        return { ok: false, reason: 'you have no ready operatives to skip' };
      return { ok: true };
    },
    // "Use this firefight ploy when you resolve a critical success for a friendly … operative
    //  that's shooting with a bolt weapon."
    [FP.criticalShot]: (state) =>
      state.sequence?.kind === 'shoot' && isBoltWeapon(state.sequence.weaponName)
        ? { ok: true }
        : { ok: false, reason: 'use this ploy while shooting with a bolt weapon' },
    // "Use this firefight ploy when an operative is shooting a friendly … operative, in the
    //  Roll Defence Dice step."
    [FP.transhuman]: (state, player) =>
      state.sequence?.kind === 'shoot' && state.sequence.defender === player
        ? { ok: true }
        : { ok: false, reason: 'use this ploy when an operative is shooting one of yours' },
    // "…that has a Conceal order is activated, is given an Engage order, performs the Charge
    //  and then the Fight action… The operative cannot have performed any other actions."
    [FP.stealthAssault]: (state, player) => {
      const seq = state.sequence;
      if (seq?.kind !== 'fight' || seq.attacker !== player)
        return { ok: false, reason: 'use this ploy while a friendly operative is fighting' };
      const attacker = state.operatives[seq.attackerId];
      if (!attacker || !attacker.actionsThisActivation.includes('Charge'))
        return { ok: false, reason: 'that operative did not perform the Charge action' };
      if (attacker.actionsThisActivation.some((a) => a !== 'Charge' && a !== 'Fight'))
        return { ok: false, reason: 'the operative cannot have performed any other actions' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [C.infiltratorSergeant]: 'leader',
      [C.incursorSergeant]: 'leader',
      [C.reiverSergeant]: 'leader',
      [C.commsman]: 'support',
      [C.helixAdept]: 'support',
      [C.saboteur]: 'gunner',
      [C.veteran]: 'gunner',
      [C.voxbreaker]: 'scout',
      [C.infiltratorWarrior]: 'objective',
      [C.marksman]: 'sniper',
      [C.minelayer]: 'objective',
      [C.incursorWarrior]: 'objective',
      [C.reiverWarrior]: 'melee',
    },
    ployValue: {
      [SP.guerrillaWarfare]: 0.4,
      [SP.knowNoFear]: 0.5,
      [SP.deadlyShots]: 0.7,
      [SP.lethalAssaults]: 0.6,
      [FP.patientAmbush]: 0.2,
      [FP.criticalShot]: 0.6,
      [FP.transhuman]: 0.6,
      [FP.stealthAssault]: 0.1,
    },
    equipmentValue: {
      [EQ.puritySeals]: 0.5,
      [EQ.additionalGrenades]: 0.4,
      [EQ.combatBlades]: 0.6,
      [EQ.specialAmmo]: 0.5,
    },
  },
});

export default phobosStrikeTeam;
