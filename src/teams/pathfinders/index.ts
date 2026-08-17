/**
 * PATHFINDERS — T'au Empire. https://wahapedia.ru/kill-team3/kill-teams/pathfinders/
 * Rule text is read from `data/teams/pathfinders.json`.
 *
 * Everything on this team hangs off the Markerlights faction rule, so the token count is one
 * pure function (`markerlightTokens`) that the weapon rules, the Hit bonus, the obscured
 * carve-out and the equipment all read.
 */
import { allActions, registerAction } from '../../core/actions.ts';
import { terrain } from '../../core/context.ts';
import { grenadeWeapon } from '../../core/equipment/grenades.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { aliveOperatives, body, log, recordRoll } from '../../core/state.ts';
import { isVisible } from '../../core/visibility.ts';
import type { GameContext } from '../../core/context.ts';
import type { ShootSequence } from '../../core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, Weapon, WeaponProfile } from '../../core/types.ts';
import { teamData } from '../bundled.ts';
import {
  chosenOperative,
  currentApl,
  defineTeam,
  effect,
  effectOn,
  effectsOn,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  notEngaged,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('pathfinders');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const KW = 'PATHFINDER';
export const MARKERLIGHT = 'pathfinders.markerlight';
const MARKERLIGHT_TEXT = DATA.factionRules.find((r) => r.id === 'pathfinders.rule.markerlights')!.text;

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

// ---------------------------------------------------------------------------
// Markerlight tokens
// ---------------------------------------------------------------------------

/** "…gains one of your Markerlight tokens (to a maximum of four)." */
export function markerlightTokens(state: GameState, target: OperativeState, player: PlayerId): number {
  return effectsOn(state, target.id, MARKERLIGHT).filter((e) => e.player === player).length;
}

export function giveMarkerlight(state: GameState, target: OperativeState, player: PlayerId, n = 1): void {
  for (let i = 0; i < n; i++) {
    if (markerlightTokens(state, target, player) >= 4) return;
    effect(state, {
      rule: MARKERLIGHT,
      source: { kind: 'ability', id: 'pathfinders.rule.markerlights' },
      sourceText: shortQuote(MARKERLIGHT_TEXT),
      operativeId: target.id,
      player,
      expiry: { kind: 'endOfBattle' },
    });
  }
  log(state, {
    kind: 'action',
    player,
    text: `${target.letter} has ${markerlightTokens(state, target, player)} Markerlight token(s)`,
  });
}

function removeOneMarkerlight(state: GameState, target: OperativeState, player: PlayerId): void {
  const first = effectsOn(state, target.id, MARKERLIGHT).find((e) => e.player === player);
  if (!first) return;
  state.effects = state.effects.filter((e) => e !== first);
}

/**
 * The token count the shooting rules see: the tokens on the target, plus the TARGET ANALYSIS
 * OPTIC's "it's treated as having one more" while that use is live.
 */
function effectiveTokens(T: TeamHooks, state: GameState, target: OperativeState): number {
  const base = markerlightTokens(state, target, T.player);
  if (base < 1) return base;
  const optic = effectOn(state, target.id, 'pathfinders.opticTarget');
  return optic && optic.player === T.player ? base + 1 : base;
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

/** Art of War (SHAS'UI): one STRATEGIC GAMBIT per option, once per battle each. */
export const ART_OF_WAR = 'pathfinders.shas-ui-pathfinder.art-of-war';
export const artOfWarId = (choice: 'montka' | 'kauyon'): string => `${ART_OF_WAR}:${choice}`;
export const ART_OF_WAR_TEXT: Record<'montka' | 'kauyon', string> = {
  montka: 'Mont’ka: Add 1" to the Move stat of friendly PATHFINDER operatives.',
  kauyon:
    'Kauyon: Friendly PATHFINDER operatives can perform a free Markerlight action during their activation if they have a Conceal order.',
};

/** Blooded › Veteran: it uses the OTHER Art of War option. */
function artOfWarFor(T: TeamHooks, state: GameState, op: OperativeState, choice: 'montka' | 'kauyon'): boolean {
  const used = gambitUsed(state, T.player, artOfWarId(choice));
  const other = gambitUsed(state, T.player, artOfWarId(choice === 'montka' ? 'kauyon' : 'montka'));
  if (op.datacardId === 'pathfinders.blooded-pathfinder') return other || used;
  return used;
}

const DRONE_ACTIONS: Record<string, string[]> = {
  'pathfinders.mb3-recon-drone': ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'Shoot', 'pathfinders.mb3-recon-drone.act.markerlight'],
  'pathfinders.mv1-gun-drone': ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'Shoot'],
  'pathfinders.mv4-shield-drone': ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition'],
  'pathfinders.mv7-marker-drone': ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition', 'pathfinders.mv7-marker-drone.act.markerlight'],
  'pathfinders.mv31-pulse-accelerator-drone': [
    'Charge',
    'Dash',
    'Fall Back',
    'Fight',
    'Reposition',
    'pathfinders.mv31-pulse-accelerator-drone.act.pulse-accelerator',
  ],
  'pathfinders.mv33-grav-inhibitor-drone': ['Charge', 'Dash', 'Fall Back', 'Fight', 'Reposition'],
};

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Markerlights: the cumulative additional rules ----------------------
  reg.on('onWeaponRules', T.bind('pathfinders.rule.markerlights', 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    // "…with a weapon from its datacard (excluding ASSAULT GRENADIER's fusion grenade)"
    if (!(T.card(ev.operative)?.weapons ?? []).some((w) => w.name === ev.weaponName)) return;
    if (/fusion grenade/i.test(ev.weaponName)) return;
    const n = effectiveTokens(T, ev.state, ev.target);
    if (n >= 1) {
      ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Markerlight)'));
      ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Markerlight)'));
    }
    if (n >= 4) ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (Markerlight)'));
  });
  // "2 — Improve the Hit stat of that friendly operative's ranged weapons by 1 (to a maximum
  //  of 3+)." `aplOf`-style stat changes go through onStatMod, which is what `hitOf` reads.
  reg.on('onStatMod', T.bind('pathfinders.rule.markerlights', 13), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !T.mineKw(ev.operative, KW)) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target) return;
    if (effectiveTokens(T, ev.state, target) < 2) return;
    const profile = weaponProfile(T, ev.operative, seq.weaponName, seq.profileName);
    if (!profile || profile.hit <= 3) return; // "(to a maximum of 3+)"
    if (/fusion grenade/i.test(seq.weaponName)) return;
    ev.mods.hit += 1;
  });
  // "3 — The target cannot be obscured."
  reg.on('onCollectAttackDice', T.bind('pathfinders.rule.markerlights', 14), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    if (!target || effectiveTokens(T, ev.state, target) < 3) return;
    seq.obscured = false;
  });
  // "Once during each of their activations, whenever an enemy operative that has any of your
  //  Markerlight tokens performs the Dash, Charge, Fall Back or Reposition action, remove one."
  reg.on('onActivationEnd', T.bind('pathfinders.rule.markerlights', 15), (ev) => {
    if (ev.operative.player === T.player) return;
    if (markerlightTokens(ev.state, ev.operative, T.player) === 0) return;
    const moved = ev.operative.actionsThisActivation.some((a) =>
      ['Dash', 'Charge', 'Fall Back', 'Reposition'].includes(a),
    );
    if (!moved) return;
    removeOneMarkerlight(ev.state, ev.operative, T.player);
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.letter} shakes off a Markerlight token` });
  });

  // ---- SHAS'UI › Art of War (STRATEGIC GAMBIT) ---------------------------
  for (const choice of ['montka', 'kauyon'] as const) {
    reg.on('gambitOptions', T.bind(ART_OF_WAR, 15), (ev) => {
      if (ev.player !== T.player) return;
      if (!T.friendlies(ev.state).some((o) => o.datacardId === 'pathfinders.shas-ui-pathfinder')) return;
      // "You cannot select each option more than once per battle."
      if (artOfWarUsed(ev.state, T.player, choice)) return;
      ev.options.push({
        id: artOfWarId(choice),
        label: `Art of War: ${choice === 'montka' ? 'Mont’ka' : 'Kauyon'}`,
        sourceText: ART_OF_WAR_TEXT[choice],
      });
    });
  }
  reg.on('onPloyUsed', T.bind(ART_OF_WAR, 16), (ev) => {
    if (ev.player !== T.player) return;
    for (const choice of ['montka', 'kauyon'] as const) {
      if (ev.ployId !== artOfWarId(choice)) continue;
      const b = (ev.state.opState['pathfinders.artOfWar'] ?? {}) as Record<string, string[]>;
      b[T.player] = [...(b[T.player] ?? []), choice];
      ev.state.opState['pathfinders.artOfWar'] = b;
    }
  });
  reg.on('onMoveDistance', T.bindText(`${ART_OF_WAR}.montka`, ART_OF_WAR_TEXT.montka), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!artOfWarFor(T, ev.state, ev.operative, 'montka')) return;
    ev.inches += 1;
  });
  // Kauyon's free Markerlight action is granted at the start of the activation.
  reg.on('onActivationStart', T.bindText(`${ART_OF_WAR}.kauyon`, ART_OF_WAR_TEXT.kauyon), (ev) => {
    if (!T.mineKw(ev.operative, KW) || ev.operative.order !== 'conceal') return;
    if (!artOfWarFor(T, ev.state, ev.operative, 'kauyon')) return;
    const action = markerlightActionOf(ev.operative.datacardId);
    if (!action) return;
    grantFreeAction(ev.state, ev.operative, {
      sourceId: ART_OF_WAR,
      sourceText: ART_OF_WAR_TEXT.kauyon,
      threshold: currentApl(T, ev.state, ev.operative),
      kind: 'ability',
      only: [action],
    });
  });

  // ---- SHAS'LA › Group Activation ----------------------------------------
  // The engine alternates activations strictly, so the pairing is recorded as an effect the
  // UI/AI reads (the same shape as the Imperial Navy Breachers' Breach and Clear).
  reg.on('onActivationEnd', T.bind('pathfinders.shas-la-pathfinder.group-activation', 12), (ev) => {
    if (ev.operative.datacardId !== 'pathfinders.shas-la-pathfinder' || ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, 'pathfinders.groupActivationUsed')) return;
    const other = T.friendlies(ev.state).find(
      (o) => o.id !== ev.operative.id && o.ready && o.datacardId === 'pathfinders.shas-la-pathfinder',
    );
    if (!other) return;
    for (const [rule, id] of [
      ['pathfinders.groupActivation', other.id],
      ['pathfinders.groupActivationUsed', other.id],
    ] as const) {
      effect(ev.state, {
        rule,
        source: { kind: 'ability', id: 'pathfinders.shas-la-pathfinder.group-activation' },
        sourceText: shortQuote(abilityText('pathfinders.shas-la-pathfinder', 'pathfinders.shas-la-pathfinder.group-activation')),
        operativeId: id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
    }
  });

  // ---- SHAS'LA › Fearless on the Frontline --------------------------------
  reg.on('onActionCost', T.bind('pathfinders.shas-la-pathfinder.fearless-on-the-frontline', 12), (ev) => {
    if (ev.operative.datacardId !== 'pathfinders.shas-la-pathfinder' || ev.operative.player !== T.player) return;
    if (ev.action === 'Fall Back') ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- DRONE CONTROLLER ---------------------------------------------------
  reg.on('onMoveDistance', T.bind('pathfinders.drone-controller-pathfinder.drone-controller', 12), (ev) => {
    if (!T.mineKw(ev.operative, 'DRONE')) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === 'pathfinders.drone-controller-pathfinder')) return;
    ev.inches += 2; // "Add 2" to the Move stat of friendly PATHFINDER DRONE operatives."
  });
  reg.on('onPloyUsed', T.bind('pathfinders.drone-controller-pathfinder.drone-controller', 13), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'pathfinders.fp.saviour-protocols') return;
    const free =
      T.friendlies(ev.state).some((o) => o.datacardId === 'pathfinders.drone-controller-pathfinder') ||
      T.friendlies(ev.state).some((o) => o.datacardId === 'pathfinders.mv4-shield-drone');
    if (!free) return;
    ev.state.teams[T.player].cp += 1; // "The Saviour Protocols firefight ploy costs you 0CP."
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Saviour Protocols costs 0CP' });
  });

  // ---- TRANSPECTRAL INTERFERENCE › Multi-Dimensional Vision ---------------
  reg.on('onCollectAttackDice', T.bind('pathfinders.transpectral-interference-pathfinder.multi-dimensional-vision', 12), (ev) => {
    if (ev.ctx.attacker.datacardId !== 'pathfinders.transpectral-interference-pathfinder') return;
    if (ev.ctx.attacker.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (seq) seq.obscured = false; // "enemy operatives cannot be obscured"
  });

  // ---- ASSAULT GRENADIER › Grenadier Specialist ---------------------------
  const giveGrenades = (state: GameState): void => {
    for (const op of T.friendlies(state, KW)) {
      if (op.datacardId !== 'pathfinders.assault-grenadier-pathfinder') continue;
      grantWeapon(op, grenadeWeapon('frag'));
      grantWeapon(op, grenadeWeapon('krak'));
    }
  };
  reg.on('onDeploy', T.bind('pathfinders.assault-grenadier-pathfinder.grenadier-specialist', 12), (ev) => {
    if (ev.operative.player === T.player) giveGrenades(ev.state);
  });
  reg.on('onActivationStart', T.bind('pathfinders.assault-grenadier-pathfinder.grenadier-specialist', 13), (ev) => {
    if (ev.operative.player === T.player) giveGrenades(ev.state);
  });
  reg.on('onStatMod', T.bind('pathfinders.assault-grenadier-pathfinder.grenadier-specialist', 14), (ev) => {
    if (ev.operative.datacardId !== 'pathfinders.assault-grenadier-pathfinder' || ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!/^(frag|krak) grenade$/i.test(seq.weaponName)) return;
    ev.mods.hit += 1; // "improve the Hit stat of that weapon by 1"
  });

  // ---- MEDICAL TECHNICIAN › Medic! ---------------------------------------
  reg.on('onIncapacitated', T.bind('pathfinders.medical-technician-pathfinder.medic', 12), (ev) => {
    const victim = ev.operative;
    if (!T.mineKw(victim, KW) || T.kw(victim, 'DRONE')) return;
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === 'pathfinders.medical-technician-pathfinder' &&
        o.id !== victim.id &&
        !o.incapacitated &&
        T.gap(o, victim) <= 3 + 1e-6 &&
        T.enemies(ev.state).every((e) => T.gap(e, o) > 1 && T.gap(e, victim) > 1),
    );
    if (!medic) return;
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    if (!useOncePerTP(ev.state, `pathfinders.medic:${medic.id}`)) return;
    ev.prevented = true;
    victim.wounds = 1;
    medicTargets(ev.state)[medic.id] = victim.id;
    for (const o of [medic, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: 'pathfinders.medicApl',
        source: { kind: 'ability', id: 'pathfinders.medical-technician-pathfinder.medic' },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    log(ev.state, { kind: 'action', player: T.player, text: `Medic!: ${victim.letter} stays on 1 wound` });
  });

  // ---- MARKSMAN › Inertial Dampener --------------------------------------
  reg.on('onStatMod', T.bind('pathfinders.marksman-pathfinder.inertial-dampener', 12), (ev) => {
    if (ev.operative.datacardId !== 'pathfinders.marksman-pathfinder' || ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!/marksman rail rifle/i.test(seq.weaponName)) return;
    ev.mods.hit = 0; // "You can ignore any changes to the Hit stat of this operative's marksman rail rifle."
    const card = T.card(ev.operative);
    if (card && ev.operative.wounds < card.wounds / 2) ev.mods.hit += 1; // and the injured change
  });

  // ---- MB3 RECON DRONE › Analyse (applied inside the Markerlight action) --

  // ---- DRONE (every drone) ------------------------------------------------
  reg.on('canPerformAction', T.bind('pathfinders.mv1-gun-drone.drone', 12), (ev) => {
    const allowed = DRONE_ACTIONS[ev.operative.datacardId];
    if (!allowed || ev.operative.player !== T.player) return;
    if (!allowed.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'a DRONE cannot perform that action';
    }
  });
  reg.on('onMarkerControl', T.bind('pathfinders.mv1-gun-drone.drone', 13), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker || marker.kind !== 'objective') return;
    for (const o of T.friendlies(ev.state)) {
      if (!DRONE_ACTIONS[o.datacardId]) continue;
      if (T.markerGap(o, marker) <= 1 + 1e-6) ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - 1);
    }
  });

  // ---- MV4 SHIELD DRONE › Shield Generator -------------------------------
  reg.on('onDefenceDice', T.bind('pathfinders.mv4-shield-drone.shield-generator', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.datacardId !== 'pathfinders.mv4-shield-drone' || target.player !== T.player) return;
    if (ev.count <= 0) return;
    // "This operative ignores the Piercing weapon rule."
    const piercing = ev.ctx.rules.find((r) => r.id === 'Piercing');
    if (piercing) ev.count += piercing.x ?? 1;
  });
  reg.on('onDamage', T.bind('pathfinders.mv4-shield-drone.shield-generator', 13), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (ev.target.datacardId !== 'pathfinders.mv4-shield-drone' || ev.target.player !== T.player) return;
    const profile = currentProfile(T, ev.state);
    if (profile && profile.dmgC !== profile.dmgN && ev.amount >= profile.dmgC) return; // Normal Dmg only
    if (!useOncePerTP(ev.state, `pathfinders.shieldGenerator:${ev.target.id}`)) return;
    ev.amount = 0;
  });

  // ---- MV31 PULSE ACCELERATOR DRONE --------------------------------------
  reg.on('onWeaponRules', T.bind('pathfinders.mv31-pulse-accelerator-drone.act.pulse-accelerator', 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!/pulse/i.test(ev.weaponName)) return;
    const drone = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === 'pathfinders.mv31-pulse-accelerator-drone' &&
        o.id !== ev.operative.id &&
        effectOn(ev.state, o.id, 'pathfinders.pulseAccelerator') &&
        T.gap(o, ev.operative) <= 3 + 1e-6,
    );
    if (!drone) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Pulse Accelerator)'), ruleTag('Severe', undefined, 'Severe (Pulse Accelerator)'));
  });

  // ---- MV33 GRAV-INHIBITOR DRONE -----------------------------------------
  reg.on('onMoveDistance', T.bind('pathfinders.mv33-grav-inhibitor-drone.grav-inhibitor', 12), (ev) => {
    if (ev.operative.player === T.player || ev.action === 'Dash') return;
    const drone = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'pathfinders.mv33-grav-inhibitor-drone' && T.gap(o, ev.operative) <= 6 + 1e-6,
    );
    if (!drone) return;
    ev.inches -= 2; // "treat the distance as an additional 2""
  });
  reg.on('onStatMod', T.bind('pathfinders.mv33-grav-inhibitor-drone.grav-inhibitor', 13), (ev) => {
    if (ev.operative.player === T.player) return;
    if (ev.state.sequence?.kind !== 'fight') return;
    const drone = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'pathfinders.mv33-grav-inhibitor-drone' && T.gap(o, ev.operative) <= 6 + 1e-6,
    );
    if (!drone) return;
    ev.mods.hit -= 1; // "worsen the Hit stat of that enemy operative's melee weapons by 1"
  });
}

function artOfWarUsed(state: GameState, player: PlayerId, choice: 'montka' | 'kauyon'): boolean {
  const b = (state.opState['pathfinders.artOfWar'] ?? {}) as Record<string, string[]>;
  return (b[player] ?? []).includes(choice);
}

function medicTargets(state: GameState): Record<string, string> {
  const b = (state.opState['pathfinders.medicTarget'] ?? {}) as Record<string, string>;
  state.opState['pathfinders.medicTarget'] = b;
  return b;
}

function weaponProfile(
  T: TeamHooks,
  op: OperativeState,
  weaponName: string,
  profileName?: string,
): WeaponProfile | undefined {
  const weapon = T.card(op)?.weapons.find((w) => w.name === weaponName);
  return weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
}

function currentProfile(T: TeamHooks, state: GameState): WeaponProfile | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const holderId = seq.kind === 'shoot' ? seq.attackerId : seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
  const holder = state.operatives[holderId];
  if (!holder) return undefined;
  const name = seq.kind === 'shoot' ? seq.weaponName : seq.turn === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const profileName = seq.kind === 'shoot' ? seq.profileName : seq.turn === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
  return weaponProfile(T, holder, name, profileName);
}

/** The MARKERLIGHT action id printed on a datacard, if it has one. */
export function markerlightActionOf(datacardId: string): string | undefined {
  return DATA.datacards.find((c) => c.id === datacardId)?.uniqueActions.find((a) => a.name === 'MARKERLIGHT')?.id;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // RECON SWEEP (strategy)
  reg.on('onPloyUsed', T.bind('pathfinders.sp.recon-sweep', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'pathfinders.sp.recon-sweep') return;
    const mine = ev.state.map.killzoneEdges[T.player];
    const others = [
      ...ev.state.map.killzoneEdges[T.player === 'p1' ? 'p2' : 'p1'],
      ...ev.state.map.killzoneEdges.neutral,
    ];
    void mine; // "(excluding your own)"
    for (const op of T.friendlies(ev.state, KW)) {
      const near = others.some((seg) => pointToSegment(op.pos, seg.a, seg.b) <= 6 + 1e-6);
      if (!near) continue;
      grantFreeAction(ev.state, op, {
        sourceId: 'pathfinders.sp.recon-sweep',
        sourceText: shortQuote(text('pathfinders.sp.recon-sweep')),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash'],
      });
    }
  });

  // SUPPRESSING FIRE (strategy)
  reg.on('onRollAttack', T.bind('pathfinders.sp.suppressing-fire', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'pathfinders.sp.suppressing-fire')) return;
    const attacker = ev.ctx.attacker;
    if (attacker.player === T.player) return; // "whenever an ENEMY operative is performing the Shoot action"
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player) return;
    // "Ignore friendly PATHFINDER operatives that have a Conceal order or are obscured."
    const candidates = T.friendlies(ev.state, KW).filter((o) => o.order !== 'conceal');
    if (candidates.length === 0) return;
    const closest = candidates.reduce((a, b) => (T.gap(attacker, a) <= T.gap(attacker, b) ? a : b));
    if (closest.id === target.id) return;
    ev.rerolls = ev.rerolls.filter((g) => g.player !== undefined && g.player !== attacker.player);
  });

  // BONDED (strategy)
  reg.on('onWeaponRules', T.bind('pathfinders.sp.bonded', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'pathfinders.sp.bonded')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || T.kw(ev.operative, 'DRONE')) return;
    const near = T.friendlies(ev.state, KW).some(
      (o) => o.id !== ev.operative.id && !T.kw(o, 'DRONE') && T.gap(o, ev.operative) <= 3 + 1e-6,
    );
    if (!near) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Bonded)'));
  });

  // TAKE COVER (strategy)
  reg.on('onDefenceDice', T.bind('pathfinders.sp.take-cover', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'pathfinders.sp.take-cover')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!ev.coverSave) return; // "if you can retain any cover saves"
    ev.mods.save += 1; // "improve that friendly operative's Save stat by 1"
  });

  // A WORTHY CAUSE (firefight)
  reg.on('onPloyUsed', T.bind('pathfinders.fp.a-worthy-cause', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'pathfinders.fp.a-worthy-cause') return;
    const missionActions = allActions()
      .filter((a) => a.type === 'mission')
      .map((a) => a.id);
    if (missionActions.length === 0) return;
    const op = chosenOperative(
      ev.state,
      ev.data,
      T.friendlies(ev.state, KW).filter((o) => !T.kw(o, 'DRONE')),
    );
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: 'pathfinders.fp.a-worthy-cause',
      sourceText: shortQuote(text('pathfinders.fp.a-worthy-cause')),
      threshold: currentApl(T, ev.state, op),
      only: missionActions,
    });
  });

  // SUPPORTING FIRE (firefight)
  reg.on('onValidTarget', T.bind('pathfinders.fp.supporting-fire', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'pathfinders.fp.supporting-fire')) return;
    if (!T.mineKw(ev.attacker, KW)) return;
    if (T.gap(ev.attacker, ev.target) > 6 + 1e-6) return; // "a valid target within 6" of it"
    ev.ignoreFriendlyControlRange = true;
  });

  // SAVIOUR PROTOCOLS (firefight)
  reg.on('onSelectTarget', T.bind('pathfinders.fp.saviour-protocols', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'pathfinders.fp.saviour-protocols')) return;
    if (ev.target.player !== T.player || !T.kw(ev.target, KW) || T.kw(ev.target, 'DRONE')) return;
    // "This ploy has no effect if the ranged weapon has the Blast or Torrent weapon rule."
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (usedThisTP(ev.state, `pathfinders.saviour:${T.player}`)) return;
    const drone = T.friendlies(ev.state, 'DRONE').find(
      (o) => T.gap(o, ev.target) <= 3 + 1e-6 && !o.incapacitated,
    );
    if (!drone) return;
    useOncePerTP(ev.state, `pathfinders.saviour:${T.player}`);
    ev.redirectTo = drone.id;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Saviour Protocols: ${drone.letter} takes the hit` });
  });

  // POINT-BLANK FUSILLADE (firefight)
  reg.on('onPloyUsed', T.bind('pathfinders.fp.point-blank-fusillade', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'pathfinders.fp.point-blank-fusillade') return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'fight') return;
    const defender = ev.state.operatives[seq.defenderId];
    if (!defender || !T.mineKw(defender, KW) || T.kw(defender, 'DRONE')) return;
    // "You can use one of its ranged weapons as a melee weapon (excluding … 'grenade')."
    const ranged = (T.card(defender)?.weapons ?? []).find(
      (w) => !/grenade/i.test(w.name) && w.profiles.some((p) => p.type === 'ranged'),
    );
    const profile = ranged?.profiles.find((p) => p.type === 'ranged');
    if (!ranged || !profile) return;
    const melee: Weapon = {
      name: `${ranged.name} (point-blank)`,
      profiles: [{ ...profile, type: 'melee', rules: profile.rules.filter((r) => !['Devastating', 'Piercing', 'Torrent', 'Range'].includes(r.id)) }],
    };
    grantWeapon(defender, melee);
    seq.defenderWeapon = melee.name;
    seq.defenderCanRetaliate = true;
    // "If that friendly operative is ready, has an Engage order and is retaliating with a
    //  pulse weapon, you resolve the first attack dice."
    if (defender.ready && defender.order === 'engage' && /pulse/i.test(ranged.name)) seq.turn = 'defender';
    log(ev.state, { kind: 'ploy', player: T.player, text: `Point-blank Fusillade: ${defender.letter} fights with its ${ranged.name}` });
  });
}

/** Distance from a point to a segment, for RECON SWEEP's killzone edges. */
function pointToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return dist(p, { x: a.x + t * vx, y: a.y + t * vy });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // TARGET ANALYSIS OPTIC — "…it's treated as having one more", once per turning point.
  reg.on('onCollectAttackDice', T.bind('pathfinders.eq.target-analysis-optic', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'pathfinders.eq.target-analysis-optic')) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW) || T.kw(ev.ctx.attacker, 'DRONE')) return;
    const target = ev.ctx.defender;
    if (!target || markerlightTokens(ev.state, target, T.player) < 1) return;
    if (usedThisTP(ev.state, `pathfinders.optic:${T.player}`)) return;
    useOncePerTP(ev.state, `pathfinders.optic:${T.player}`);
    effect(ev.state, {
      rule: 'pathfinders.opticTarget',
      source: { kind: 'equipment', id: 'pathfinders.eq.target-analysis-optic' },
      sourceText: shortQuote(text('pathfinders.eq.target-analysis-optic')),
      operativeId: target.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
  });

  // PHOTON GRENADE and the two Markerlight riders are applied in the actions below; these
  // bindings record the printed rules for the tooltip and gate their availability.
  reg.on('canPerformAction', T.bind('pathfinders.eq.photon-grenade', 31), (ev) => {
    if (ev.action !== PHOTON_GRENADE) return;
    if (ev.operative.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, 'pathfinders.eq.photon-grenade')) {
      ev.allowed = false;
      ev.reason = 'your kill team has not selected Photon Grenades';
    } else if (usedThisTP(ev.state, `pathfinders.photon:${T.player}`)) {
      ev.allowed = false;
      ev.reason = 'once per turning point';
    }
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

export const PHOTON_GRENADE = 'Photon Grenade';

/** MARKERLIGHT is printed on ten datacards; they share one implementation. */
function markerlightAction(datacardId: string, actionId: string) {
  return uniqueAction(DATA, datacardId, actionId, {
    check: (ctx, state, op, params) => {
      // "An operative cannot perform this action while within control range of an enemy
      //  operative" — the SHAS'LA's Fearless on the Frontline takes precedence.
      if (op.datacardId !== 'pathfinders.shas-la-pathfinder') {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
      }
      const target = markerlightTarget(ctx, state, op, params.targetOperativeId);
      if (!target) return { ok: false, reason: 'select one enemy operative visible to this operative' };
      if (markerlightTokens(state, target, op.player) >= 4)
        return { ok: false, reason: 'that operative already has four of your Markerlight tokens' };
      // "If an operative … would perform the Shoot action (excluding Guard) and this action
      //  during the same activation, only the target of that Shoot action can be selected."
      if (op.datacardId !== 'pathfinders.mb3-recon-drone') {
        const shotAt = effectOn(state, op.id, 'pathfinders.shotTarget')?.data?.['targetId'];
        if (typeof shotAt === 'string' && shotAt !== target.id)
          return { ok: false, reason: 'only the target of this activation’s Shoot action can be selected' };
      }
      return { ok: true };
    },
    perform: (ctx, state, op, params) => {
      const target = markerlightTarget(ctx, state, op, params.targetOperativeId);
      if (!target) return { ok: false, reason: 'select one enemy operative visible to this operative' };
      // MV7 MARKER DRONE / HIGH-INTENSITY MARKERLIGHT: two tokens instead of one.
      let count = 1;
      if (op.datacardId === 'pathfinders.mv7-marker-drone') count = 2;
      else if (
        state.teams[op.player].equipment.includes('pathfinders.eq.high-intensity-markerlight') &&
        highIntensityUses(state, op.player) < 2
      ) {
        count = 2;
        setHighIntensityUses(state, op.player, highIntensityUses(state, op.player) + 1);
      }
      giveMarkerlight(state, target, op.player, count);
      // MB3 RECON DRONE › Analyse.
      if (op.datacardId === 'pathfinders.mb3-recon-drone') {
        for (const other of aliveOperatives(state).filter((o) => o.player !== op.player && o.id !== target.id)) {
          if (Math.max(0, dist(other.pos, target.pos) - 1.6) > 3 + 1e-6) continue;
          if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, other)).visible) continue;
          giveMarkerlight(state, other, op.player, 1);
        }
      }
      effect(state, {
        rule: 'pathfinders.markerlightTarget',
        source: { kind: 'ability', id: actionId },
        operativeId: op.id,
        player: op.player,
        data: { targetId: target.id },
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: MARKERLIGHT on ${target.letter}` });
      return { ok: true };
    },
  });
}

function markerlightTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosenId: string | undefined,
): OperativeState | undefined {
  // ORBITAL SURVEY UPLINK: "you can select one enemy operative in the killzone … (it doesn't
  // need to be visible)", once per turning point.
  const uplink =
    state.teams[op.player].equipment.includes('pathfinders.eq.orbital-survey-uplink') &&
    !usedThisTP(state, `pathfinders.uplink:${op.player}`);
  const enemies = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1')
    .filter((e) => uplink || isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const target = enemies.find((e) => e.id === chosenId) ?? enemies[0];
  if (target && uplink && !isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
    useOncePerTP(state, `pathfinders.uplink:${op.player}`);
  return target;
}

function highIntensityUses(state: GameState, player: PlayerId): number {
  return Number((state.opState['pathfinders.highIntensity'] as Record<string, number> | undefined)?.[player] ?? 0);
}
function setHighIntensityUses(state: GameState, player: PlayerId, n: number): void {
  const b = (state.opState['pathfinders.highIntensity'] ?? {}) as Record<string, number>;
  b[player] = n;
  state.opState['pathfinders.highIntensity'] = b;
}

function actions(data: typeof DATA) {
  const out = [];
  for (const card of data.datacards) {
    const printed = card.uniqueActions.find((a) => a.name === 'MARKERLIGHT');
    if (printed) out.push(markerlightAction(card.id, printed.id));
  }

  // REMOTE PILOT 1AP — DRONE CONTROLLER
  out.push(
    uniqueAction(data, 'pathfinders.drone-controller-pathfinder', 'pathfinders.drone-controller-pathfinder.act.remote-pilot', {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const drone = aliveOperatives(state, op.player).find((o) => DRONE_ACTIONS[o.datacardId]);
        return drone ? { ok: true } : { ok: false, reason: 'no friendly PATHFINDER DRONE operative' };
      },
      perform: (_ctx, state, op, params) => {
        const drones = aliveOperatives(state, op.player).filter((o) => DRONE_ACTIONS[o.datacardId]);
        const drone = drones.find((o) => o.id === params.targetOperativeId) ?? drones[0];
        if (!drone) return { ok: false, reason: 'no friendly PATHFINDER DRONE operative' };
        drone.aplMods.push(1);
        effect(state, {
          rule: 'pathfinders.remotePilot',
          source: { kind: 'ability', id: 'pathfinders.drone-controller-pathfinder.act.remote-pilot' },
          sourceText:
            'One friendly PATHFINDER DRONE operative can immediately perform one free action, but it cannot move more than 2" during that action.',
          operativeId: drone.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: drone.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: REMOTE PILOT (${drone.letter})` });
        return { ok: true };
      },
    }),
  );

  // SYSTEM JAM 1AP — TRANSPECTRAL INTERFERENCE
  out.push(
    uniqueAction(data, 'pathfinders.transpectral-interference-pathfinder', 'pathfinders.transpectral-interference-pathfinder.act.system-jam', {
      check: (ctx, state, op, params) => {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot perform this action with a Conceal order' };
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = jamTarget(ctx, state, op, params.targetOperativeId);
        return target ? { ok: true } : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = jamTarget(ctx, state, op, params.targetOperativeId)!;
        target.aplMods.push(-1);
        effect(state, {
          rule: 'pathfinders.systemJam',
          source: { kind: 'ability', id: 'pathfinders.transpectral-interference-pathfinder.act.system-jam' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SYSTEM JAM on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // SIGNAL 1AP (SUPPORT) — COMMS SPECIALIST
  out.push(
    uniqueAction(data, 'pathfinders.comms-specialist-pathfinder', 'pathfinders.comms-specialist-pathfinder.act.signal', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return signalTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly PATHFINDER operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = signalTarget(ctx, state, op, params.targetOperativeId)!;
        target.aplMods.push(1);
        effect(state, {
          rule: 'pathfinders.signal',
          source: { kind: 'ability', id: 'pathfinders.comms-specialist-pathfinder.act.signal' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
        return { ok: true };
      },
    }),
  );

  // MEDIKIT 0AP — MEDICAL TECHNICIAN
  out.push(
    uniqueAction(data, 'pathfinders.medical-technician-pathfinder', 'pathfinders.medical-technician-pathfinder.act.medikit', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = medikitTarget(ctx, state, op, params.targetOperativeId);
        if (!target) return { ok: false, reason: 'select one friendly PATHFINDER operative within control range' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = medikitTarget(ctx, state, op, params.targetOperativeId)!;
        const heal = ctx.rng.d3() + ctx.rng.d3();
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: MEDIKIT restores ${heal} wounds` });
        return { ok: true };
      },
    }),
  );

  // PULSE ACCELERATOR 0AP — MV31
  out.push(
    uniqueAction(data, 'pathfinders.mv31-pulse-accelerator-drone', 'pathfinders.mv31-pulse-accelerator-drone.act.pulse-accelerator', {
      check: () => ({ ok: true }),
      perform: (_ctx, state, op) => {
        effect(state, {
          rule: 'pathfinders.pulseAccelerator',
          source: { kind: 'ability', id: 'pathfinders.mv31-pulse-accelerator-drone.act.pulse-accelerator' },
          operativeId: op.id,
          player: op.player,
          // "Until the start of this operative's next activation or until it's incapacitated."
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: PULSE ACCELERATOR` });
        return { ok: true };
      },
    }),
  );

  return out;
}

function jamTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const enemies = aliveOperatives(state, op.player === 'p1' ? 'p2' : 'p1')
    .filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return enemies.find((e) => e.id === chosen) ?? enemies[0];
}

function signalTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const range = supportDistance(ctx, state, op, 6);
  const mates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter(
      (o) =>
        Math.max(0, dist(o.pos, op.pos) - 1.3) <= range + 1e-6 &&
        isVisible(terrain(ctx, state), body(ctx, op), body(ctx, o)).visible,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function medikitTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const mates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .filter((o) => !(ctx.datacards.get(o.datacardId)?.keywords ?? []).includes('DRONE'))
    .filter((o) => Math.max(0, dist(o.pos, op.pos) - 1.3) <= 1 + 1e-6)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

/** PHOTON GRENADE (faction equipment), on any operative that prints the Markerlight action. */
registerAction({
  id: PHOTON_GRENADE,
  name: 'Photon Grenade',
  ap: 1,
  type: 'unique',
  sourceText: DATA.equipment.find((e) => e.id === 'pathfinders.eq.photon-grenade')!.text,
  available: (ctx, state, op) =>
    state.teams[op.player].equipment.includes('pathfinders.eq.photon-grenade') &&
    Boolean(markerlightActionOf(op.datacardId)) &&
    !(ctx.datacards.get(op.datacardId)?.keywords ?? []).includes('DRONE'),
  check(ctx, state, op, params) {
    const eng = notEngaged(ctx, state, op);
    if (!eng.ok) return eng;
    const target = jamTarget(ctx, state, op, params.targetOperativeId);
    return target ? { ok: true } : { ok: false, reason: 'select one enemy operative visible to this operative' };
  },
  perform(ctx, state, op, params) {
    const target = jamTarget(ctx, state, op, params.targetOperativeId)!;
    useOncePerTP(state, `pathfinders.photon:${op.player}`);
    const roll = ctx.rng.d6();
    recordRoll(state, 'photonGrenade', [roll], op.player, 'PHOTON GRENADE 3+');
    if (roll >= 3) {
      effect(state, {
        rule: 'pathfinders.photonGrenade',
        source: { kind: 'equipment', id: 'pathfinders.eq.photon-grenade' },
        sourceText: 'on a 3+, until the end of that operative’s next activation, subtract 2" from its Move stat',
        operativeId: target.id,
        player: op.player,
        expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
      });
    }
    log(state, { kind: 'action', player: op.player, text: `${op.letter}: PHOTON GRENADE (${roll})` });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------

export const pathfinders = defineTeam({
  id: 'pathfinders',
  rules: (reg, T) => {
    rules(reg, T);
    // The Markerlight action's "only the target of that Shoot action" clause needs to know
    // what this operative shot at during this activation.
    reg.on('onCollectAttackDice', T.bind('pathfinders.rule.markerlights', 16), (ev) => {
      if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
      const target = ev.ctx.defender;
      if (!target) return;
      const existing = effectOn(ev.state, ev.ctx.attacker.id, 'pathfinders.shotTarget');
      if (existing) existing.data = { targetId: target.id };
      else
        effect(ev.state, {
          rule: 'pathfinders.shotTarget',
          source: { kind: 'core', id: 'pathfinders.rule.markerlights' },
          operativeId: ev.ctx.attacker.id,
          player: T.player,
          data: { targetId: target.id },
          expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
        });
    });
    // PHOTON GRENADE's Move penalty.
    reg.on('onStatMod', T.bind('pathfinders.eq.photon-grenade', 17), (ev) => {
      if (!effectOn(ev.state, ev.operative.id, 'pathfinders.photonGrenade')) return;
      ev.mods.move -= 2;
    });
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "You cannot use this ploy during the first turning point."
    'pathfinders.sp.recon-sweep': (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
  },
  aiHints: {
    roles: {
      'pathfinders.shas-ui-pathfinder': 'leader',
      'pathfinders.shas-la-pathfinder': 'objective',
      'pathfinders.blooded-pathfinder': 'gunner',
      'pathfinders.assault-grenadier-pathfinder': 'gunner',
      'pathfinders.comms-specialist-pathfinder': 'support',
      'pathfinders.drone-controller-pathfinder': 'support',
      'pathfinders.marksman-pathfinder': 'sniper',
      'pathfinders.medical-technician-pathfinder': 'support',
      'pathfinders.transpectral-interference-pathfinder': 'scout',
      'pathfinders.weapons-expert-pathfinder': 'gunner',
      'pathfinders.mb3-recon-drone': 'scout',
      'pathfinders.mv1-gun-drone': 'gunner',
      'pathfinders.mv4-shield-drone': 'support',
      'pathfinders.mv7-marker-drone': 'scout',
      'pathfinders.mv31-pulse-accelerator-drone': 'support',
      'pathfinders.mv33-grav-inhibitor-drone': 'support',
    },
    ployValue: {
      'pathfinders.sp.recon-sweep': 0.4,
      'pathfinders.sp.suppressing-fire': 0.5,
      'pathfinders.sp.bonded': 0.6,
      'pathfinders.sp.take-cover': 0.5,
      'pathfinders.fp.a-worthy-cause': 0.5,
      'pathfinders.fp.supporting-fire': 0.5,
      'pathfinders.fp.saviour-protocols': 0.6,
      'pathfinders.fp.point-blank-fusillade': 0.3,
    },
    equipmentValue: {
      'pathfinders.eq.target-analysis-optic': 0.6,
      'pathfinders.eq.high-intensity-markerlight': 0.6,
      'pathfinders.eq.photon-grenade': 0.4,
      'pathfinders.eq.orbital-survey-uplink': 0.5,
    },
  },
});

export default pathfinders;
