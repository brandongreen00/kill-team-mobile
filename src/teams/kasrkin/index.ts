/**
 * KASRKIN — Astra Militarum. https://wahapedia.ru/kill-team3/kill-teams/kasrkin/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/kasrkin.json`, never retyped.
 *
 * Designer's note (kasrkin.json › selection.designerNotes): "Some KASRKIN rules refer to a
 * 'hot-shot weapon'. This is a ranged weapon that includes 'hot-shot' in its name."
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { log, recordRoll } from '../../core/state.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type { Datacard, GameState, OperativeState, PlayerId, Weapon } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  centroidOf,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  gambitsWithPrefix,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  horizontal,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  posFromData,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('kasrkin');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

// ---------------------------------------------------------------------------
// Skill at Arms (faction rule 1)
// ---------------------------------------------------------------------------

export const SKILLS = ['light-em-up', 'strike-fast', 'ice-in-your-veins', 'for-cadia'] as const;
export type Skill = (typeof SKILLS)[number];

export const SKILL_LABEL: Record<Skill, string> = {
  'light-em-up': 'Light ’Em Up',
  'strike-fast': 'Strike Fast',
  'ice-in-your-veins': 'Ice In Your Veins',
  'for-cadia': 'For Cadia!',
};

/** Quoted from the SKILL AT ARMS faction rule. */
export const SKILL_TEXT: Record<Skill, string> = {
  'light-em-up': 'Light ’Em Up: Friendly KASRKIN operatives’ ranged weapons have the Severe weapon rule.',
  'strike-fast':
    'Strike Fast: Whenever a friendly KASRKIN operative is performing the Reposition action, add 1" to its Move stat.',
  'ice-in-your-veins':
    'Ice In Your Veins: Whenever a friendly KASRKIN operative is fighting or retaliating, or an operative is shooting it, the first time an attack dice inflicts Normal Dmg of 3 or more on this operative during that sequence, that dice inflicts 1 less damage on it.',
  'for-cadia':
    'For Cadia!: Add 1 to the Atk stat of friendly KASRKIN operatives’ melee weapons (to a maximum of 4). Whenever a friendly KASRKIN operative is fighting, the first time you strike during that sequence, inflict 1 additional damage.',
};

export const SKILL_GAMBIT = 'kasrkin.rule.skill-at-arms';
export const skillGambitId = (s: Skill): string => `${SKILL_GAMBIT}:${s}`;

/** TACTICAL COMMAND grants a SKILL AT ARMS to one operative; that grant is an effect. */
const SKILL_EFFECT = 'kasrkin.skillAtArms';
/** RECON-TROOPER's AUSPEX SCAN: the scanning operative carries this effect. */
const SCAN_SOURCE = 'kasrkin.scanSource';
/** The last ranged weapon fired this activation, so Rapid Fire can validate the pair. */
const LAST_RANGED = 'kasrkin.lastRangedWeapon';
const RAPID_FIRE_WEAPONS = ['bolt pistol', 'hot-shot lasgun', 'hot-shot laspistol'];

export function hasSkill(T: TeamHooks, state: GameState, op: OperativeState, skill: Skill): boolean {
  if (!T.mineKw(op, 'KASRKIN')) return false;
  if (gambitUsed(state, T.player, skillGambitId(skill))) return true;
  return state.effects.some((e) => e.rule === SKILL_EFFECT && e.operativeId === op.id && e.data?.['skill'] === skill);
}

/**
 * SERGEANT › Veteran Leadership: "Whenever this operative is in the killzone and you use the
 * SKILL AT ARMS STRATEGIC GAMBIT, you can select one additional SKILL AT ARMS but they cannot
 * be the same."
 */
export function skillAllowance(T: TeamHooks, state: GameState): number {
  return T.friendlies(state).some((o) => o.datacardId === 'kasrkin.sergeant') ? 2 : 1;
}

export const isHotShot = (weaponName: string): boolean => weaponName.toLowerCase().includes('hot-shot');
const isPistol = (weaponName: string): boolean => weaponName.toLowerCase().includes('pistol');

/** "…or is being scanned (see RECON-TROOPER)". */
export function isScanned(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return state.effects.some((e) => {
    if (e.rule !== SCAN_SOURCE || e.player !== T.player) return false;
    const scanner = e.operativeId ? state.operatives[e.operativeId] : undefined;
    return Boolean(scanner) && !scanner!.removed && T.gap(scanner!, op) <= 8 + 1e-6;
  });
}

/** "an operative that cannot retain any cover saves or is being scanned" */
function noCoverOrScanned(T: TeamHooks, state: GameState, target: OperativeState): boolean {
  const seq = shootSeq(state);
  if (seq && seq.targetId === target.id && !seq.inCover) return true;
  return isScanned(T, state, target);
}

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

/** Normal Dmg of the weapon currently inflicting damage (Ice In Your Veins reads it). */
function currentNormalDamage(T: TeamHooks, state: GameState): number {
  const seq = state.sequence;
  if (!seq) return 0;
  const holder = state.operatives[seq.attackerId];
  if (!holder) return 0;
  const name = seq.kind === 'shoot' ? seq.weaponName : seq.attackerWeapon;
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const profileName = seq.kind === 'shoot' ? seq.profileName : seq.attackerProfile;
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
  return profile?.dmgN ?? 0;
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // SKILL AT ARMS — a STRATEGIC GAMBIT choice, offered as one gambit per skill so the choice
  // is the player's and is recorded in `gambitsUsedTP`, never picked silently.
  for (const skill of SKILLS) {
    reg.on('gambitOptions', T.bind(SKILL_GAMBIT, 15), (ev) => {
      if (ev.player !== T.player) return;
      const chosen = gambitsWithPrefix(ev.state, T.player, `${SKILL_GAMBIT}:`);
      if (chosen.length >= skillAllowance(T, ev.state)) return;
      if (chosen.includes(skillGambitId(skill))) return; // "they cannot be the same"
      ev.options.push({ id: skillGambitId(skill), label: `SKILL AT ARMS: ${SKILL_LABEL[skill]}`, sourceText: SKILL_TEXT[skill] });
    });
  }

  reg.on('onWeaponRules', T.bindText('kasrkin.skill.lightEmUp', SKILL_TEXT['light-em-up']), (ev) => {
    if (ev.type !== 'ranged') return;
    if (!hasSkill(T, ev.state, ev.operative, 'light-em-up')) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Light ’Em Up)'));
  });

  reg.on('onMoveDistance', T.bindText('kasrkin.skill.strikeFast', SKILL_TEXT['strike-fast']), (ev) => {
    if (ev.action !== 'Reposition') return;
    if (!hasSkill(T, ev.state, ev.operative, 'strike-fast')) return;
    ev.inches += 1;
  });

  reg.on('onDamage', T.bindText('kasrkin.skill.iceInYourVeins', SKILL_TEXT['ice-in-your-veins']), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!hasSkill(T, ev.state, ev.target, 'ice-in-your-veins')) return;
    if (currentNormalDamage(T, ev.state) < 3) return;
    if (!useOncePerSequence(ev.state, `kasrkin.ice:${ev.target.id}`)) return;
    ev.amount = Math.max(0, ev.amount - 1);
  });

  reg.on('onCollectAttackDice', T.bindText('kasrkin.skill.forCadia.atk', SKILL_TEXT['for-cadia']), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    if (!hasSkill(T, ev.state, ev.ctx.attacker, 'for-cadia')) return;
    ev.count = Math.min(4, ev.count + 1); // "(to a maximum of 4)"
  });
  reg.on('onDamage', T.bindText('kasrkin.skill.forCadia.strike', SKILL_TEXT['for-cadia']), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const striker = ev.state.operatives[seq.attackerId];
    if (!striker || striker.id === ev.target.id) return; // only the fighter, not the retaliator
    if (!hasSkill(T, ev.state, striker, 'for-cadia')) return;
    if (!useOncePerSequence(ev.state, `kasrkin.forCadia:${striker.id}`)) return;
    ev.amount += 1;
  });

  // Rapid Fire — remember the weapon used, so the second Shoot can be checked against it.
  reg.on('onCollectAttackDice', T.bind('kasrkin.rule.rapid-fire', 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, 'KASRKIN')) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: 'kasrkin.rule.rapid-fire' },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  // COMBAT MEDIC › Medic!
  reg.on('onIncapacitated', T.bind('kasrkin.combat-medic.medic', 12), (ev) => {
    const victim = ev.operative;
    if (!T.mineKw(victim, 'KASRKIN')) return;
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === 'kasrkin.combat-medic' &&
        o.id !== victim.id &&
        !o.incapacitated &&
        T.gap(o, victim) <= 3 + 1e-6 &&
        T.enemies(ev.state).every((e) => T.gap(e, o) > 1 && T.gap(e, victim) > 1),
    );
    if (!medic) return;
    // "You cannot use this rule … if it's a Shoot action and this operative would be a
    //  primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    if (!useOncePerTP(ev.state, `kasrkin.medic:${medic.id}`)) return;
    ev.prevented = true;
    victim.wounds = 1;
    medicTargets(ev.state)[medic.id] = victim.id;
    for (const o of [medic, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: 'kasrkin.medicApl',
        source: { kind: 'ability', id: 'kasrkin.combat-medic.medic' },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    log(ev.state, { kind: 'action', player: T.player, text: `Medic! ${medic.name} keeps ${victim.name} on 1 wound` });
  });

  // DEMO-TROOPER › Blast Padding
  reg.on('onDefenceDice', T.bind('kasrkin.demo-trooper.blast-padding', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.datacardId !== 'kasrkin.demo-trooper' || target.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (ev.ctx.profile.name === 'sweeping') return; // "excluding weapons that have a sweeping profile"
    ev.rerolls.push({
      id: 'kasrkin.blastPadding',
      label: 'Blast Padding: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(abilityText('kasrkin.demo-trooper', 'kasrkin.demo-trooper.blast-padding')),
    });
  });
  reg.on('onDamage', T.bind('kasrkin.demo-trooper.blast-padding', 13), (ev) => {
    if (ev.kind !== 'devastating') return;
    if (ev.target.datacardId !== 'kasrkin.demo-trooper' || ev.target.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId === ev.target.id) return; // "unless they are the target during that sequence"
    ev.amount = 0;
  });

  // SHARPSHOOTER › Camo Cloak
  reg.on('onDefenceDice', T.bind('kasrkin.sharpshooter.camo-cloak', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.datacardId !== 'kasrkin.sharpshooter' || target.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq?.inCover) return;
    ev.coverSave = true; // "Ignore the Saturate weapon rule."
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // SHARPSHOOTER › Concealed Position (rare weapon rule): "This operative can only use this
  // weapon the first time it's performing the Shoot action during the battle."
  //
  // The rule sits on the hot-shot marksman rifle's `concealed` PROFILE alone — its `mobile` and
  // `stationary` profiles carry no such restriction. `availableWeapons` is per WEAPON, so the
  // filter this used to be removed the whole rifle after the first shot and cost the Sharpshooter
  // both of its other profiles. `onSelectWeapon` is per profile, and since it is now also emitted
  // from the Shoot action's `check` the refusal reaches the AI before it commits an intent.
  reg.on('onSelectWeapon', T.bind('kasrkin.sharpshooter.concealed-position', 11), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (!hasShotBefore(ev.state, ev.ctx.attacker.id)) return;
    ev.allowed = false;
    ev.reason = 'Concealed Position: only the first Shoot action of the battle';
  });
  reg.on('onCollectAttackDice', T.bind('kasrkin.sharpshooter.concealed-position', 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    markShot(ev.state, ev.ctx.attacker.id);
  });

  // TROOPER › Adaptive Equipment
  reg.on('onActionCost', T.bind('kasrkin.trooper.adaptive-equipment', 12), (ev) => {
    if (!T.mineKw(ev.operative, 'TROOPER')) return;
    if (ev.action !== 'Smoke Grenade' && ev.action !== 'Stun Grenade') return;
    if (usedThisTP(ev.state, `kasrkin.adaptive:${T.player}:${ev.action}`)) return;
    ev.ap = 0; // "doesn't count towards their action limits"
  });
  reg.on('onActivationEnd', T.bind('kasrkin.trooper.adaptive-equipment', 13), (ev) => {
    if (!T.mineKw(ev.operative, 'TROOPER')) return;
    for (const action of ['Smoke Grenade', 'Stun Grenade'])
      if (ev.operative.actionsThisActivation.includes(action))
        useOncePerTP(ev.state, `kasrkin.adaptive:${T.player}:${action}`);
  });

  // RECON-TROOPER › Auspex Scan: "whenever a friendly KASRKIN operative is shooting an enemy
  // operative that's being scanned, that enemy operative cannot be obscured".
  reg.on('onValidTarget', T.bind('kasrkin.recon-trooper.act.auspex-scan', 12), (ev) => {
    if (ev.attacker.player !== T.player || !T.kw(ev.attacker, 'KASRKIN')) return;
    if (!isScanned(T, ev.state, ev.target)) return;
    ev.ignoreCoverTerrain = 'all';
  });
}

function medicTargets(state: GameState): Record<string, string> {
  const b = (state.opState['kasrkin.medicTarget'] ?? {}) as Record<string, string>;
  state.opState['kasrkin.medicTarget'] = b;
  return b;
}
function hasShotBefore(state: GameState, id: string): boolean {
  return Boolean((state.opState['kasrkin.shot'] as Record<string, boolean> | undefined)?.[id]);
}
function markShot(state: GameState, id: string): void {
  const b = (state.opState['kasrkin.shot'] ?? {}) as Record<string, boolean>;
  b[id] = true;
  state.opState['kasrkin.shot'] = b;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

const CLEARANCE_MARKER = (player: PlayerId): string => `kasrkin.clearanceSweep.${player}`;

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ELIMINATION PATTERN (strategy, 1CP)
  reg.on('onWeaponRules', T.bind('kasrkin.sp.elimination-pattern', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'kasrkin.sp.elimination-pattern')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, 'KASRKIN') || !isHotShot(ev.weaponName)) return;
    if (!ev.target || !noCoverOrScanned(T, ev.state, ev.target)) return;
    if (ev.weaponName.toLowerCase().includes('volley gun')) ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1'));
    else ev.rules.push(ruleTag('PiercingCrits', 1, 'Piercing Crits 1'));
  });

  // ENGAGE FROM COVER (strategy, 1CP)
  reg.on('onDefenceDice', T.bind('kasrkin.sp.engage-from-cover', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'kasrkin.sp.engage-from-cover')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, 'KASRKIN') || !ev.ctx.inCover) return;
    ev.rerolls.push({
      id: 'kasrkin.engageFromCover',
      label: 'Engage from Cover: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('kasrkin.sp.engage-from-cover')),
    });
  });

  // CLEARANCE SWEEP (strategy, 1CP)
  reg.on('onPloyUsed', T.bind('kasrkin.sp.clearance-sweep', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kasrkin.sp.clearance-sweep') return;
    const fallback = centroidOf(T.friendlies(ev.state, 'KASRKIN'), {
      x: ev.state.map.board.w / 2,
      y: ev.state.map.board.h / 2,
    });
    const pos = posFromData(ev.data, fallback);
    placeTeamMarker(ev.state, { id: CLEARANCE_MARKER(T.player), kind: 'generic', player: T.player, pos });
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Clearance Sweep marker placed' });
  });
  reg.on('onWeaponRules', T.bind('kasrkin.sp.clearance-sweep', 21), (ev) => {
    const marker = ev.state.markers[CLEARANCE_MARKER(T.player)];
    if (!marker || !ev.target) return;
    if (!T.mineKw(ev.operative, 'KASRKIN') || ev.type !== 'ranged') return;
    if (horizontal(ev.operative.pos, marker.pos) > 5 + 1e-6) return;
    if (horizontal(ev.target.pos, marker.pos) > 5 + 1e-6) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Clearance Sweep)'));
  });
  reg.on('onReadyStep', T.bind('kasrkin.sp.clearance-sweep', 22), (ev) => {
    // "In the Ready step of the next Strategy phase, remove that marker."
    if (ev.player === T.player) removeMarker(ev.state, CLEARANCE_MARKER(T.player));
  });

  // RELOCATE (strategy, 1CP) — "You cannot use this ploy during the first turning point."
  reg.on('onPloyUsed', T.bind('kasrkin.sp.relocate', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kasrkin.sp.relocate') return;
    const far = (o: OperativeState): boolean => T.enemies(ev.state).every((e) => T.gap(o, e) > 3 + 1e-6);
    const eligible = T.friendlies(ev.state, 'KASRKIN').filter(far);
    const leader = chosenOperative(ev.state, ev.data, eligible);
    if (!leader) return;
    // RECON-TROOPER › Reconnoitre Killzone: "The Relocate strategy ploy costs you 0CP if this
    // operative is the selected friendly KASRKIN operative."
    if (leader.datacardId === 'kasrkin.recon-trooper') {
      ev.state.teams[T.player].cp += 1;
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Reconnoitre Killzone: Relocate costs 0CP' });
    }
    for (const o of [leader, ...eligible.filter((x) => x.id !== leader.id && T.gap(x, leader) <= 3 + 1e-6)]) {
      grantFreeAction(ev.state, o, {
        sourceId: 'kasrkin.sp.relocate',
        sourceText: shortQuote(text('kasrkin.sp.relocate')),
        threshold: currentApl(T, ev.state, o),
        only: ['Dash'],
      });
    }
  });

  // SEIZE THE INITIATIVE (firefight, 1CP)
  reg.on('onPloyUsed', T.bind('kasrkin.fp.seize-the-initiative', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kasrkin.fp.seize-the-initiative') return;
    const op = chosenOperative(ev.state, ev.data, T.friendlies(ev.state, 'KASRKIN').filter((o) => o.ready));
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: 'kasrkin.fp.seize-the-initiative',
      sourceText: shortQuote(text('kasrkin.fp.seize-the-initiative')),
      threshold: currentApl(T, ev.state, op),
      noMove: true, // "but it cannot move during that action"
    });
  });

  // NEUTRALISE TARGET (firefight, 1CP)
  reg.on('onRollAttack', T.bind('kasrkin.fp.neutralise-target', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'kasrkin.fp.neutralise-target')) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, 'KASRKIN')) return;
    const target = ev.ctx.defender;
    if (!target || !noCoverOrScanned(T, ev.state, target)) return;
    ev.rerolls.push({
      id: 'kasrkin.neutraliseTarget',
      label: 'Neutralise Target: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text('kasrkin.fp.neutralise-target')),
    });
  });

  // COVER RETREAT (firefight, 1CP)
  reg.on('onPloyUsed', T.bind('kasrkin.fp.cover-retreat', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kasrkin.fp.cover-retreat') return;
    const falling = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const supporters = T.friendlies(ev.state, 'KASRKIN').filter(
      (o) =>
        o.id !== falling?.id &&
        (!falling || T.gap(o, falling) <= 6 + 1e-6) &&
        T.enemies(ev.state).every((e) => T.gap(o, e) > 1),
    );
    const op = chosenOperative(ev.state, ev.data, supporters);
    if (!op) return;
    op.order = 'engage'; // "(you can change its order to Engage to do so)"
    grantFreeAction(ev.state, op, {
      sourceId: 'kasrkin.fp.cover-retreat',
      sourceText: shortQuote(text('kasrkin.fp.cover-retreat')),
      threshold: currentApl(T, ev.state, op),
      only: ['Shoot'],
    });
  });

  // GIVE NO GROUND (firefight, 1CP)
  reg.on('onMarkerControl', T.bind('kasrkin.fp.give-no-ground', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'kasrkin.fp.give-no-ground')) return;
    const mine = ev.aplByPlayer[T.player];
    const theirs = ev.aplByPlayer[T.player === 'p1' ? 'p2' : 'p1'];
    if (mine === 2 && theirs === mine) ev.forced = T.player;
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/** "Combat dagger — ATK 3, HIT 4+, DMG 3/4" (kasrkin.json › equipment). */
const COMBAT_DAGGER: Weapon = {
  name: 'Combat dagger',
  profiles: [{ type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4, rules: [] }],
};

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // FOREGRIP
  reg.on('onWeaponRules', T.bind('kasrkin.eq.foregrip', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'kasrkin.eq.foregrip')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, 'KASRKIN')) return;
    if (isPistol(ev.weaponName)) return; // "excluding weapons that include 'pistol' in their name"
    if (!ev.target || T.gap(ev.operative, ev.target) > 3 + 1e-6) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Foregrip)'));
  });

  // RELICS OF CADIA
  reg.on('onRollAttack', T.bind('kasrkin.eq.relics-of-cadia', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'kasrkin.eq.relics-of-cadia')) return;
    if (!T.mineKw(ev.ctx.attacker, 'KASRKIN')) return;
    if (usedThisTP(ev.state, `kasrkin.relics:${T.player}`)) return;
    const seq = shootSeq(ev.state);
    const fails = seq ? seq.attack.dice.filter((d) => d.state === 'fail').length : 0;
    if (fails < 2) return; // "if you roll two or more fails"
    useOncePerTP(ev.state, `kasrkin.relics:${T.player}`);
    ev.rerolls.push({
      id: 'kasrkin.relicsOfCadia',
      label: 'Relics of Cadia: discard one fail to retain another as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('kasrkin.eq.relics-of-cadia')),
    });
  });

  // LONG-RANGE SCOPE
  reg.on('onWeaponRules', T.bind('kasrkin.eq.long-range-scope', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'kasrkin.eq.long-range-scope')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, 'KASRKIN') || !isHotShot(ev.weaponName)) return;
    if (!ev.target || T.gap(ev.operative, ev.target) <= 6 + 1e-6) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Long-range Scope)'));
  });

  // COMBAT DAGGERS
  const giveDaggers = (state: GameState): void => {
    if (!hasEquipment(state, T.player, 'kasrkin.eq.combat-daggers')) return;
    for (const o of T.friendlies(state, 'KASRKIN')) grantWeapon(o, structuredClone(COMBAT_DAGGER));
  };
  reg.on('onDeploy', T.bind('kasrkin.eq.combat-daggers', 30), (ev) => {
    if (ev.operative.player === T.player) giveDaggers(ev.state);
  });
  reg.on('onActivationStart', T.bind('kasrkin.eq.combat-daggers', 31), (ev) => {
    if (ev.operative.player === T.player) giveDaggers(ev.state);
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

function actions(data: typeof DATA) {
  return [
    // TACTICAL COMMAND 0AP — SERGEANT
    uniqueAction(data, 'kasrkin.sergeant', 'kasrkin.sergeant.act.tactical-command', {
      // "Select one friendly KASRKIN operative, then select one SKILL AT ARMS for that
      // operative to have... This can be in addition to any SKILL AT ARMS it already has,
      // but they cannot be the same."
      // Validated HERE rather than in perform: a perform failure is reverted AND recorded as
      // a rejected intent, so anything check accepts must be performable.
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const skill = params.choice as Skill | undefined;
        if (skill && !SKILLS.includes(skill)) return { ok: false, reason: `unknown SKILL AT ARMS '${skill}'` };
        const target = state.operatives[params.targetOperativeId ?? op.id];
        if (!target || target.removed || target.player !== op.player)
          return { ok: false, reason: 'select a friendly KASRKIN operative' };
        const chosen = (skill ?? 'light-em-up') as Skill;
        if (state.effects.some((e) => e.rule === SKILL_EFFECT && e.operativeId === target.id && e.data?.['skill'] === chosen))
          return { ok: false, reason: 'that operative already has that SKILL AT ARMS' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const skill = (params.choice ?? 'light-em-up') as Skill;
        const target = state.operatives[params.targetOperativeId ?? op.id]!;
        effect(state, {
          rule: SKILL_EFFECT,
          source: { kind: 'ability', id: 'kasrkin.sergeant.act.tactical-command' },
          sourceText: SKILL_TEXT[skill],
          operativeId: target.id,
          player: op.player,
          data: { skill },
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: TACTICAL COMMAND — ${target.name} gains ${SKILL_LABEL[skill]}`,
        });
        return { ok: true };
      },
    }),

    // MEDIKIT 0AP — COMBAT MEDIC
    uniqueAction(data, 'kasrkin.combat-medic', 'kasrkin.combat-medic.act.medikit', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.player !== op.player)
          return { ok: false, reason: 'select a friendly KASRKIN operative within control range' };
        if (medicTargets(state)[op.id] === target.id && usedThisTP(state, `kasrkin.medic:${op.id}`))
          return { ok: false, reason: 'the Medic! rule was used on that operative during this turning point' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        const heal = ctx.rng.d3() + ctx.rng.d3(); // "regain up to 2D3 lost wounds"
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.name}: MEDIKIT restores ${heal} wounds to ${target.name}` });
        return { ok: true };
      },
    }),

    // AUSPEX SCAN 1AP — RECON-TROOPER
    uniqueAction(data, 'kasrkin.recon-trooper', 'kasrkin.recon-trooper.act.auspex-scan', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === SCAN_SOURCE && e.operativeId === op.id);
        effect(state, {
          rule: SCAN_SOURCE,
          source: { kind: 'ability', id: 'kasrkin.recon-trooper.act.auspex-scan' },
          sourceText: shortQuote(cardOf('kasrkin.recon-trooper').uniqueActions[0]!.text),
          operativeId: op.id,
          player: op.player,
          // "Until the start of this operative's next activation or until it's incapacitated."
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: AUSPEX SCAN (enemies within 8" are being scanned)` });
        return { ok: true };
      },
    }),

    // BATTLE COMMS 1AP — VOX-TROOPER
    uniqueAction(data, 'kasrkin.vox-trooper', 'kasrkin.vox-trooper.act.battle-comms', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one OTHER friendly KASRKIN operative' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        // "add 1 to its APL stat (to a maximum of 3 after all APL stat changes)"
        target.aplMods.push(1);
        effect(state, {
          rule: 'kasrkin.battleComms',
          source: { kind: 'ability', id: 'kasrkin.vox-trooper.act.battle-comms' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: BATTLE COMMS — ${target.name} +1 APL` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Rapid Fire's second Shoot action
// ---------------------------------------------------------------------------

/**
 * "Each friendly KASRKIN operative that doesn't perform an action in which it moves during its
 * activation can perform two Shoot actions (excluding Guard) during that activation, but a
 * bolt pistol, hot-shot lasgun or hot-shot laspistol must be selected for both of those
 * actions."
 *
 * Action restrictions forbid repeating an action, so the second Shoot is registered as its own
 * action with its own restriction key; it resolves through the universal Shoot action so the
 * whole sequence (cover, rerolls, decisions) is identical.
 */
export const RAPID_FIRE_ACTION = 'Shoot (Rapid Fire)';

registerAction({
  id: RAPID_FIRE_ACTION,
  name: 'Shoot (Rapid Fire)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'kasrkin.rule.rapid-fire')!.text,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes('KASRKIN'),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Rapid Fire is the second Shoot action of an activation' };
    if (op.actionsThisActivation.some((a) => ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'].includes(a)))
      return { ok: false, reason: 'Rapid Fire needs an activation in which the operative did not move' };
    const first = effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'];
    if (typeof first === 'string' && !RAPID_FIRE_WEAPONS.includes(first.toLowerCase()))
      return { ok: false, reason: `${first} is not a bolt pistol, hot-shot lasgun or hot-shot laspistol` };
    if (!RAPID_FIRE_WEAPONS.includes((params.weaponName ?? '').toLowerCase()))
      return { ok: false, reason: 'a bolt pistol, hot-shot lasgun or hot-shot laspistol must be selected' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

// ---------------------------------------------------------------------------

export const kasrkin = defineTeam({
  id: 'kasrkin',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "You cannot use this ploy during the first turning point."
    'kasrkin.sp.relocate': (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
    // "You cannot use this ploy if you're the player with initiative."
    'kasrkin.fp.seize-the-initiative': (state, player) =>
      state.initiative === player
        ? { ok: false, reason: 'you cannot use this ploy if you have initiative' }
        : { ok: true },
  },
  aiHints: {
    roles: {
      'kasrkin.sergeant': 'leader',
      'kasrkin.combat-medic': 'support',
      'kasrkin.demo-trooper': 'objective',
      'kasrkin.gunner': 'gunner',
      'kasrkin.recon-trooper': 'scout',
      'kasrkin.sharpshooter': 'sniper',
      'kasrkin.trooper': 'objective',
      'kasrkin.vox-trooper': 'support',
    },
    ployValue: {
      'kasrkin.sp.elimination-pattern': 0.6,
      'kasrkin.sp.engage-from-cover': 0.5,
      'kasrkin.sp.clearance-sweep': 0.5,
      'kasrkin.sp.relocate': 0.4,
      'kasrkin.fp.seize-the-initiative': 0.6,
      'kasrkin.fp.neutralise-target': 0.7,
      'kasrkin.fp.cover-retreat': 0.4,
      'kasrkin.fp.give-no-ground': 0.5,
    },
    equipmentValue: {
      'kasrkin.eq.foregrip': 0.5,
      'kasrkin.eq.relics-of-cadia': 0.4,
      'kasrkin.eq.long-range-scope': 0.5,
      'kasrkin.eq.combat-daggers': 0.6,
    },
  },
});

export default kasrkin;
