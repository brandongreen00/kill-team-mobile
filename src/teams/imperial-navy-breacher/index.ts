/**
 * IMPERIAL NAVY BREACHERS.
 * https://wahapedia.ru/kill-team3/kill-teams/imperial-navy-breacher/
 * Rule text is read from `data/teams/imperial-navy-breacher.json`.
 */
import { HookRegistry } from '../../core/hooks.ts';
import { body, gapBetween, inflictDamage, log, recordRoll } from '../../core/state.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { isVisible } from '../../core/visibility.ts';
import type { GameState, OperativeState, PlayerId } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  centroidOf,
  defineTeam,
  effect,
  effectOn,
  gambitUsed,
  hasEquipment,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  posFromData,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('imperial-navy-breacher');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!.text;

const KW = 'IMPERIAL NAVY BREACHER';
const ATTACK_ORDER = (p: PlayerId): string => `inb.attackOrder.${p}`;
const DEFENCE_ORDER = (p: PlayerId): string => `inb.defenceOrder.${p}`;

// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Void Armour --------------------------------------------------------
  reg.on('onDefenceDice', T.bind('imperial-navy-breacher.rule.void-armour', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (ev.ctx.profile.name === 'sweeping') return; // "excluding weapons that have a sweeping profile"
    const grenadier = target.datacardId === 'imperial-navy-breacher.navis-grenadier';
    ev.rerolls.push({
      id: 'inb.voidArmour',
      label: grenadier ? 'Void Armour: re-roll up to two of your defence dice' : 'Void Armour: re-roll one of your defence dice',
      mode: grenadier ? 'any' : 'one',
      max: grenadier ? 2 : 1,
      player: T.player,
      sourceText: shortQuote(text('imperial-navy-breacher.rule.void-armour')),
    });
  });
  reg.on('onDamage', T.bind('imperial-navy-breacher.rule.void-armour', 13), (ev) => {
    // "aren't affected by the x" Devastating x weapon rule … unless they are the target"
    if (ev.kind !== 'devastating' || !T.mineKw(ev.target, KW)) return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'shoot' || seq.targetId === ev.target.id) return;
    ev.amount = 0;
  });

  // ---- Breach and Clear ---------------------------------------------------
  // "Once per turning point, when a ready friendly … operative is activated … select one other
  //  ready friendly … operative visible to and within 3" … you can activate that other friendly
  //  operative before your opponent activates."
  reg.on('onActivationStart', T.bind('imperial-navy-breacher.rule.breach-and-clear', 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (usedThisTP(ev.state, `inb.breachAndClear:${T.player}`)) return;
    const partner = T.friendlies(ev.state, KW).find(
      (o) => o.id !== ev.operative.id && o.ready && T.gap(o, ev.operative) <= 3 + 1e-6,
    );
    if (!partner) return;
    useOncePerTP(ev.state, `inb.breachAndClear:${T.player}`);
    effect(ev.state, {
      rule: 'inb.breachAndClear',
      source: { kind: 'ability', id: 'imperial-navy-breacher.rule.breach-and-clear' },
      sourceText: shortQuote(text('imperial-navy-breacher.rule.breach-and-clear')),
      operativeId: partner.id,
      player: T.player,
      data: { after: ev.operative.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Breach and Clear: ${partner.name} activates after ${ev.operative.name}`,
    });
  });

  // ---- SERGEANT-AT-ARMS › Command Breach ---------------------------------
  // "Whenever you would use the Attack Order or Defence Order strategy ploy, if this operative
  //  is in the killzone, it costs you 0CP."
  reg.on('onPloyUsed', T.bind('imperial-navy-breacher.navis-sergeant-at-arms.command-breach', 12), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.ployId !== 'imperial-navy-breacher.sp.attack-order' && ev.ployId !== 'imperial-navy-breacher.sp.defence-order')
      return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === 'imperial-navy-breacher.navis-sergeant-at-arms')) return;
    const ploy = DATA.strategyPloys.find((p) => p.id === ev.ployId)!;
    ev.state.teams[T.player].cp += ploy.cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Command Breach: ${ploy.name} costs 0CP` });
  });

  // ---- ARMSMAN › Group Activation ----------------------------------------
  reg.on('onActivationEnd', T.bind('imperial-navy-breacher.navis-armsman.group-activation', 12), (ev) => {
    if (ev.operative.datacardId !== 'imperial-navy-breacher.navis-armsman' || ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, 'inb.groupActivationUsed')) return;
    const other = T.friendlies(ev.state).find(
      (o) => o.id !== ev.operative.id && o.ready && o.datacardId === 'imperial-navy-breacher.navis-armsman',
    );
    if (!other) return;
    effect(ev.state, {
      rule: 'inb.groupActivation',
      source: { kind: 'ability', id: 'imperial-navy-breacher.navis-armsman.group-activation' },
      sourceText: shortQuote(
        DATA.datacards
          .find((c) => c.id === 'imperial-navy-breacher.navis-armsman')!
          .abilities.find((a) => a.id === 'imperial-navy-breacher.navis-armsman.group-activation')!.text,
      ),
      operativeId: other.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    effect(ev.state, {
      rule: 'inb.groupActivationUsed',
      source: { kind: 'ability', id: 'imperial-navy-breacher.navis-armsman.group-activation' },
      operativeId: other.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  // ---- AXEJACK › Emboldened ----------------------------------------------
  reg.on('onDamage', T.bind('imperial-navy-breacher.navis-axejack.emboldened', 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.datacardId !== 'imperial-navy-breacher.navis-axejack' || ev.target.player !== T.player) return;
    if (ev.amount < 3) return;
    if (!effectOn(ev.state, ev.target.id, 'inb.chargedThisTP')) return;
    const roll = T.ctx?.rng.d6() ?? 3;
    recordRoll(ev.state, 'emboldened', [roll], T.player, 'Emboldened 5+');
    if (roll >= 5) ev.amount -= 1;
  });
  reg.on('onActivationEnd', T.bind('imperial-navy-breacher.navis-axejack.emboldened', 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    if (effectOn(ev.state, ev.operative.id, 'inb.chargedThisTP')) return;
    effect(ev.state, {
      rule: 'inb.chargedThisTP',
      source: { kind: 'ability', id: 'imperial-navy-breacher.navis-axejack.emboldened' },
      operativeId: ev.operative.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  // ---- ENDURANT › Shield (rare weapon rule) ------------------------------
  reg.on('onBlockAllocation', T.bind('imperial-navy-breacher.navis-endurant.shield', 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Shield')) return;
    ev.blocks = 2; // "each of your blocks can be allocated to block two unresolved successes"
  });

  // ---- ENDURANT › Disengage ----------------------------------------------
  reg.on('onActionCost', T.bind('imperial-navy-breacher.navis-endurant.disengage', 12), (ev) => {
    if (ev.action !== 'Fall Back') return;
    if (ev.operative.datacardId !== 'imperial-navy-breacher.navis-endurant' || ev.operative.player !== T.player) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- ENDURANT › Breachwall ---------------------------------------------
  reg.on('onValidTarget', T.bind('imperial-navy-breacher.navis-endurant.breachwall', 12), (ev) => {
    if (ev.target.player !== T.player || !T.kw(ev.target, KW)) return;
    const endurants = T.friendlies(ev.state).filter(
      (o) => o.datacardId === 'imperial-navy-breacher.navis-endurant' && o.order === 'engage' && o.id !== ev.target.id,
    );
    for (const endurant of endurants) {
      if (T.gap(endurant, ev.target) > 0.01) continue; // "whose base is touching this operative's"
      const touching = T.friendlies(ev.state, KW).filter((o) => o.id !== endurant.id && T.gap(endurant, o) <= 0.01);
      if (touching.length !== 1) continue; // "no effect if more than one other friendly base is touching"
      ev.valid = false;
      ev.reason = 'Breachwall: the ENDURANT is intervening';
      return;
    }
  });

  // ---- GRENADIER --------------------------------------------------------
  reg.on('onCollectAttackDice', T.bind('imperial-navy-breacher.navis-grenadier.grenadier', 12), (ev) => {
    if (ev.ctx.attacker.datacardId !== 'imperial-navy-breacher.navis-grenadier') return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (!/frag|krak/i.test(ev.ctx.weaponName)) return;
    ev.mods.hit += 1;
  });

  // ---- C.A.T. UNIT / GHEISTSKULL › Machine -------------------------------
  reg.on('canPerformAction', T.bind('imperial-navy-breacher.navis-c-a-t-unit.machine', 12), (ev) => {
    if (ev.operative.datacardId !== 'imperial-navy-breacher.navis-c-a-t-unit' || ev.operative.player !== T.player) return;
    const allowed = ['Charge', 'Dash', 'Fall Back', 'Reposition', 'imperial-navy-breacher.navis-c-a-t-unit.act.spot'];
    if (!allowed.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'a C.A.T. UNIT cannot perform that action';
      return;
    }
    const surveyorDown = !T.friendlies(ev.state).some((o) => o.datacardId === 'imperial-navy-breacher.navis-surveyor');
    if (surveyorDown) {
      ev.allowed = false;
      ev.reason = 'the SURVEYOR has been incapacitated';
    }
  });
  reg.on('canPerformAction', T.bind('imperial-navy-breacher.navis-gheistskull.machine', 13), (ev) => {
    if (ev.operative.datacardId !== 'imperial-navy-breacher.navis-gheistskull' || ev.operative.player !== T.player) return;
    const allowed = ['Charge', 'Dash', 'Fall Back', 'Reposition', 'imperial-navy-breacher.navis-gheistskull.act.boost'];
    if (!allowed.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'a GHEISTSKULL cannot perform that action';
    }
  });
  reg.on('onMarkerControl', T.bind('imperial-navy-breacher.navis-gheistskull.machine', 14), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    for (const o of T.friendlies(ev.state)) {
      if (o.datacardId !== 'imperial-navy-breacher.navis-gheistskull') continue;
      if (T.markerGap(o, marker) <= 1 + 1e-6) ev.aplByPlayer[T.player] -= 1;
    }
  });

  // ---- VOID-JAMMER › Detonate (rare weapon rule) -------------------------
  // "If that operative isn't in the killzone, you cannot select this weapon."
  reg.on('availableWeapons', T.bind('imperial-navy-breacher.navis-void-jammer.detonate', 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const detonators = (T.card(ev.operative)?.weapons ?? []).filter((w) =>
      w.profiles.some((p) => p.rules.some((r) => r.id === 'Detonate')),
    );
    if (detonators.length === 0) return;
    const skull = T.friendlies(ev.state).some((o) => o.datacardId === 'imperial-navy-breacher.navis-gheistskull');
    if (skull) return;
    ev.weapons = ev.weapons.filter((n) => !detonators.some((w) => w.name === n));
  });
}

// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ATTACK ORDER (strategy)
  reg.on('onPloyUsed', T.bind('imperial-navy-breacher.sp.attack-order', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'imperial-navy-breacher.sp.attack-order') return;
    const pos = posFromData(ev.data, centroidOf(T.friendlies(ev.state, KW), { x: ev.state.map.board.w / 2, y: ev.state.map.board.h / 2 }));
    placeTeamMarker(ev.state, { id: ATTACK_ORDER(T.player), kind: 'generic', player: T.player, pos });
  });
  reg.on('onWeaponRules', T.bind('imperial-navy-breacher.sp.attack-order', 21), (ev) => {
    const marker = ev.state.markers[ATTACK_ORDER(T.player)];
    if (!marker || !T.mineKw(ev.operative, KW)) return;
    if (T.markerGap(ev.operative, marker) > 3 + 1e-6) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Attack Order)'));
  });

  // DEFENCE ORDER (strategy)
  reg.on('onPloyUsed', T.bind('imperial-navy-breacher.sp.defence-order', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'imperial-navy-breacher.sp.defence-order') return;
    const pos = posFromData(ev.data, centroidOf(T.friendlies(ev.state, KW), { x: ev.state.map.board.w / 2, y: ev.state.map.board.h / 2 }));
    placeTeamMarker(ev.state, { id: DEFENCE_ORDER(T.player), kind: 'generic', player: T.player, pos });
  });
  reg.on('onDefenceDice', T.bind('imperial-navy-breacher.sp.defence-order', 21), (ev) => {
    const marker = ev.state.markers[DEFENCE_ORDER(T.player)];
    const target = ev.ctx.defender;
    if (!marker || !target || !T.mineKw(target, KW)) return;
    if (T.markerGap(target, marker) > 3 + 1e-6) return;
    ev.rerolls.push({
      id: 'inb.defenceOrder',
      label: 'Defence Order: re-roll any of your defence dice results of one result',
      mode: 'value',
      player: T.player,
      sourceText: shortQuote(text('imperial-navy-breacher.sp.defence-order')),
    });
  });

  // Both orders are removed in the Ready step of the next Strategy phase.
  reg.on('onReadyStep', T.bind('imperial-navy-breacher.sp.attack-order', 22), (ev) => {
    if (ev.player !== T.player) return;
    removeMarker(ev.state, ATTACK_ORDER(T.player));
    removeMarker(ev.state, DEFENCE_ORDER(T.player));
  });

  // CLOSE ASSAULT (strategy)
  reg.on('onWeaponRules', T.bind('imperial-navy-breacher.sp.close-assault', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'imperial-navy-breacher.sp.close-assault')) return;
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (T.gap(ev.operative, ev.target) > 3 + 1e-6) return;
    // "+1 to both Dmg stats" is applied in onDamage; the profile itself is shared data.
  });
  reg.on('onDamage', T.bind('imperial-navy-breacher.sp.close-assault', 21), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, 'imperial-navy-breacher.sp.close-assault')) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player !== T.player) return;
    const name = seq.kind === 'shoot' ? seq.weaponName : seq.attackerWeapon;
    if (!/navis (heavy )?shotgun/i.test(name)) return;
    if (T.gap(attacker, ev.target) > 3 + 1e-6) return;
    ev.amount += 1; // "Add 1 to both Dmg stats of all profiles of its Navis shotguns"
  });
  reg.on('onRollAttack', T.bind('imperial-navy-breacher.sp.close-assault', 22), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'imperial-navy-breacher.sp.close-assault')) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    if (!target || T.gap(ev.ctx.attacker, target) > 3 + 1e-6) return;
    const seq = ev.state.sequence;
    const pool = seq?.kind === 'shoot' ? seq.attack : seq?.kind === 'fight' ? seq.attackerPool : undefined;
    if (!pool || pool.dice.filter((d) => d.state === 'fail').length < 2) return;
    ev.rerolls.push({
      id: 'inb.closeAssault',
      label: 'Close Assault: discard one fail to retain another as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('imperial-navy-breacher.sp.close-assault')),
    });
  });

  // BRACE FOR COUNTERATTACK (strategy)
  reg.on('onDamage', T.bind('imperial-navy-breacher.sp.brace-for-counterattack', 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, 'imperial-navy-breacher.sp.brace-for-counterattack')) return;
    if (!T.mineKw(ev.target, KW) || ev.amount < 3) return;
    const moved = ['Charge', 'Fall Back', 'Reposition'].some((a) => ev.target.actionsThisActivation.includes(a));
    const inTerritory = pointInTerritory(ev.state, T.player, ev.target);
    if (!inTerritory && moved) return;
    ev.amount -= 1;
  });

  // OVERWHELM TARGET (firefight)
  reg.on('onPloyUsed', T.bind('imperial-navy-breacher.fp.overwhelm-target', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'imperial-navy-breacher.fp.overwhelm-target') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !T.mineKw(active, KW)) return;
    active.aplMods.push(1); // "Until the end of that operative's activation, add 1 to its APL stat."
    effect(ev.state, {
      rule: 'inb.overwhelmTarget',
      source: { kind: 'ploy', id: 'imperial-navy-breacher.fp.overwhelm-target' },
      sourceText: shortQuote(text('imperial-navy-breacher.fp.overwhelm-target')),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
  });

  // BLITZ (firefight)
  reg.on('onWeaponRules', T.bind('imperial-navy-breacher.fp.blitz', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'imperial-navy-breacher.fp.blitz')) return;
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (T.gap(ev.operative, ev.target) > 6 + 1e-6) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Blitz)'));
    // "If it's the first friendly operative to be activated during this turning point,
    //  its weapons also have the Severe weapon rule for that action."
    if (ev.state.activationsThisTP === 0) ev.rules.push(ruleTag('Severe', undefined, 'Severe (Blitz)'));
  });

  // LOCK IT DOWN (firefight)
  reg.on('onPloyUsed', T.bind('imperial-navy-breacher.fp.lock-it-down', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'imperial-navy-breacher.fp.lock-it-down') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const markerId = (ev.data?.['markerId'] as string | undefined) ??
      Object.values(ev.state.markers).find((m) => m.kind === 'objective')?.id;
    if (!active || !markerId) return;
    const store = (ev.state.opState['inb.lockItDown'] ?? {}) as Record<string, { operativeId: string; markerId: string }>;
    store[T.player] = { operativeId: active.id, markerId };
    ev.state.opState['inb.lockItDown'] = store;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Lock It Down on ${markerId}` });
  });
  reg.on('onMarkerControl', T.bind('imperial-navy-breacher.fp.lock-it-down', 21), (ev) => {
    const store = (ev.state.opState['inb.lockItDown'] ?? {}) as Record<string, { operativeId: string; markerId: string }>;
    const entry = store[T.player];
    if (!entry || entry.markerId !== ev.markerId) return;
    const op = ev.state.operatives[entry.operativeId];
    const marker = ev.state.markers[ev.markerId];
    if (!op || op.removed || !marker) return;
    if (T.markerGap(op, marker) > 1 + 1e-6) return;
    ev.aplByPlayer[T.player] += 1;
  });

  // DECK HAND (firefight)
  reg.on('onMoveDistance', T.bind('imperial-navy-breacher.fp.deck-hand', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'imperial-navy-breacher.fp.deck-hand')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    ev.inches += 1; // "move through one Accessible terrain feature without it counting as an additional 1""
  });
  reg.on('onActionCost', T.bind('imperial-navy-breacher.fp.deck-hand', 21), (ev) => {
    if (!ployUsed(ev.state, T.player, 'imperial-navy-breacher.fp.deck-hand')) return;
    if (ev.action !== 'Operate Hatch' || !T.mineKw(ev.operative, KW)) return;
    if (usedThisTP(ev.state, `inb.deckHand:${T.player}`)) return;
    useOncePerTP(ev.state, `inb.deckHand:${T.player}`);
    ev.ap = 0; // "perform a free Operate Hatch action"
  });
}

/** "within your territory" — the map's territory polygons. */
function pointInTerritory(state: GameState, player: PlayerId, op: OperativeState): boolean {
  for (const poly of state.map.territories[player]) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > op.pos.y !== b.y > op.pos.y && op.pos.x < ((b.x - a.x) * (op.pos.y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // REBREATHERS — ignore APL changes; no Shock.
  reg.on('onActivationStart', T.bind('imperial-navy-breacher.eq.rebreathers', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'imperial-navy-breacher.eq.rebreathers')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (ev.operative.aplMods.length > 0) ev.operative.aplMods = [];
  });
  reg.on('onWeaponRules', T.bind('imperial-navy-breacher.eq.rebreathers', 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'imperial-navy-breacher.eq.rebreathers')) return;
    if (ev.operative.player === T.player) return; // the enemy's weapon
    if (!ev.target || !T.mineKw(ev.target, KW)) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Shock');
  });

  // SLUGS — Navis shotgun (long range), up to three times per turning point.
  reg.on('onCollectAttackDice', T.bind('imperial-navy-breacher.eq.slugs', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'imperial-navy-breacher.eq.slugs')) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    if (!/navis shotgun/i.test(ev.ctx.weaponName) || ev.ctx.profile.name !== 'long range') return;
    const uses = slugUses(ev.state, T.player);
    if (uses >= 3) return;
    setSlugUses(ev.state, T.player, uses + 1);
    ev.mods.hit += 1;
  });
  reg.on('onDamage', T.bind('imperial-navy-breacher.eq.slugs', 31), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!hasEquipment(ev.state, T.player, 'imperial-navy-breacher.eq.slugs')) return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'shoot' || seq.profileName !== 'long range') return;
    if (!/navis shotgun/i.test(seq.weaponName)) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player !== T.player) return;
    ev.amount += 1;
  });

  // COMBAT STIMMS — ignore injured Move changes.
  reg.on('onStatMod', T.bind('imperial-navy-breacher.eq.combat-stimms', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'imperial-navy-breacher.eq.combat-stimms')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2;
  });

  // SYSTEM OVERRIDE DEVICE — one Operate Hatch for 1 less AP per turning point.
  reg.on('onActionCost', T.bind('imperial-navy-breacher.eq.system-override-device', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'imperial-navy-breacher.eq.system-override-device')) return;
    if (ev.action !== 'Operate Hatch' || !T.mineKw(ev.operative, KW)) return;
    if (usedThisTP(ev.state, `inb.override:${T.player}`)) return;
    useOncePerTP(ev.state, `inb.override:${T.player}`);
    ev.ap = Math.max(0, ev.ap - 1);
  });
}

function slugUses(state: GameState, player: PlayerId): number {
  const b = (state.opState['inb.slugs'] ?? {}) as Record<string, { tp: number; used: number }>;
  const cur = b[player];
  return cur && cur.tp === state.turningPoint ? cur.used : 0;
}
function setSlugUses(state: GameState, player: PlayerId, used: number): void {
  const b = (state.opState['inb.slugs'] ?? {}) as Record<string, { tp: number; used: number }>;
  b[player] = { tp: state.turningPoint, used };
  state.opState['inb.slugs'] = b;
}

// ---------------------------------------------------------------------------

const SPOTTED = 'inb.spotted';

function actions(data: typeof DATA) {
  return [
    // SPOT 1AP — C.A.T. UNIT
    uniqueAction(data, 'imperial-navy-breacher.navis-c-a-t-unit', 'imperial-navy-breacher.navis-c-a-t-unit.act.spot', {
      check: (_ctx, state, op, params) =>
        params.targetOperativeId && state.operatives[params.targetOperativeId]?.player !== op.player
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' },
      perform: (_ctx, state, op, params) => {
        state.effects = state.effects.filter((e) => !(e.rule === SPOTTED && e.player === op.player));
        effect(state, {
          rule: SPOTTED,
          source: { kind: 'ability', id: 'imperial-navy-breacher.navis-c-a-t-unit.act.spot' },
          operativeId: params.targetOperativeId!,
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: SPOT` });
        return { ok: true };
      },
    }),

    // BOOST 1AP — GHEISTSKULL
    uniqueAction(data, 'imperial-navy-breacher.navis-gheistskull', 'imperial-navy-breacher.navis-gheistskull.act.boost', {
      check: (_ctx, state, op) => {
        if (state.turningPoint <= 1) return { ok: false, reason: 'cannot Boost during the first turning point' };
        if (!useOncePerBattleCheck(state, `inb.boost:${op.id}`))
          return { ok: false, reason: 'Boost can only be performed once per battle' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        useOncePerBattle(state, `inb.boost:${op.id}`);
        effect(state, {
          rule: 'inb.boost',
          source: { kind: 'ability', id: 'imperial-navy-breacher.navis-gheistskull.act.boost' },
          sourceText: 'Until the end of the activation, add 6" to this operative’s Move stat.',
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: BOOST (+6" Move)` });
        return { ok: true };
      },
    }),

    // WELD SHUT 1AP — HATCHCUTTER
    uniqueAction(data, 'imperial-navy-breacher.navis-hatchcutter', 'imperial-navy-breacher.navis-hatchcutter.act.weld-shut', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (!params.partId) return { ok: false, reason: 'select a closed hatchway within control range' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        effect(state, {
          rule: 'inb.weldedShut',
          source: { kind: 'ability', id: 'imperial-navy-breacher.navis-hatchcutter.act.weld-shut' },
          sourceText: '1 additional AP must be spent for other operatives to perform the Operate Hatch action to open that hatchway.',
          player: op.player,
          data: { partId: params.partId },
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: WELD SHUT` });
        return { ok: true };
      },
    }),

    // BREACH POINT 1AP — HATCHCUTTER
    uniqueAction(data, 'imperial-navy-breacher.navis-hatchcutter', 'imperial-navy-breacher.navis-hatchcutter.act.breach-point', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op, params) => {
        const pos = (params.targetPos as { x: number; y: number } | undefined) ?? { ...op.pos };
        state.markers[`inb.breach.${op.id}`] = {
          id: `inb.breach.${op.id}`,
          kind: 'generic',
          diameterMm: 20,
          pos,
          z: op.z,
          owner: op.player,
          flags: { breachPoint: true },
        };
        log(state, { kind: 'action', player: op.player, text: `${op.name}: BREACH POINT` });
        return { ok: true };
      },
    }),

    // WAYFIND 1AP (SUPPORT) — SURVEYOR
    uniqueAction(data, 'imperial-navy-breacher.navis-surveyor', 'imperial-navy-breacher.navis-surveyor.act.wayfind', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one other friendly IMPERIAL NAVY BREACHER operative within 6"' };
        if (
          target.datacardId === 'imperial-navy-breacher.navis-c-a-t-unit' ||
          target.datacardId === 'imperial-navy-breacher.navis-gheistskull'
        )
          return { ok: false, reason: 'excluding C.A.T. UNIT and GHEISTSKULL operatives' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        target.aplMods.push(1);
        effect(state, {
          rule: 'inb.wayfind',
          source: { kind: 'ability', id: 'imperial-navy-breacher.navis-surveyor.act.wayfind' },
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: WAYFIND — ${target.name} +1 APL` });
        return { ok: true };
      },
    }),

    // REMOTE CONTROL 1AP — SURVEYOR
    uniqueAction(data, 'imperial-navy-breacher.navis-surveyor', 'imperial-navy-breacher.navis-surveyor.act.remote-control', {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const cat = Object.values(state.operatives).find(
          (o) => o.player === op.player && o.datacardId === 'imperial-navy-breacher.navis-c-a-t-unit' && !o.removed,
        );
        if (!cat) return { ok: false, reason: 'no friendly C.A.T. UNIT in the killzone' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        const cat = Object.values(state.operatives).find(
          (o) => o.player === op.player && o.datacardId === 'imperial-navy-breacher.navis-c-a-t-unit' && !o.removed,
        )!;
        cat.aplMods.push(1);
        effect(state, {
          rule: 'inb.remoteControl',
          source: { kind: 'ability', id: 'imperial-navy-breacher.navis-surveyor.act.remote-control' },
          sourceText: 'That operative can immediately perform one free action, but it cannot move more than 3" during that action.',
          operativeId: cat.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: cat.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: REMOTE CONTROL` });
        return { ok: true };
      },
    }),

    // INTERFERENCE PULSE 1AP — VOID-JAMMER
    uniqueAction(data, 'imperial-navy-breacher.navis-void-jammer', 'imperial-navy-breacher.navis-void-jammer.act.interference-pulse', {
      // "Select one enemy operative visible to and within 8\" of a friendly GHEISTSKULL
      // operative. Roll one D6, adding 1 to the result if that enemy operative is a valid
      // target for that friendly GHEISTSKULL operative: on a 3+..."
      // Validated HERE, not in perform: a perform failure is reverted AND recorded as a
      // rejected intent, so anything check accepts must be performable.
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative' };
        if (!gheistskullSeeing(ctx, state, op, target))
          return { ok: false, reason: 'no friendly GHEISTSKULL can see that operative within 8"' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        // "+1 to the result if that enemy operative is a valid target for that GHEISTSKULL"
        const bonus = gheistskullSeeing(ctx, state, op, target) ? 1 : 0;
        const roll = ctx.rng.d6();
        recordRoll(state, 'interferencePulse', [roll], op.player, `INTERFERENCE PULSE 3+${bonus ? ' (+1)' : ''}`);
        if (roll + bonus >= 3) {
          target.aplMods.push(-1);
          effect(state, {
            rule: 'inb.interferencePulse',
            source: { kind: 'ability', id: 'imperial-navy-breacher.navis-void-jammer.act.interference-pulse' },
            operativeId: target.id,
            player: op.player,
            expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
          });
        }
        log(state, { kind: 'action', player: op.player, text: `${op.name}: INTERFERENCE PULSE (${roll})` });
        return { ok: true };
      },
    }),
  ];
}

function useOncePerBattleCheck(state: GameState, key: string): boolean {
  return !((state.opState['teamOnceBattle'] ?? {}) as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------

export const imperialNavyBreacher = defineTeam({
  id: 'imperial-navy-breacher',
  rareRules: ['Detonate', 'Shield'],
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "You cannot use this ploy and the Defence Order strategy ploy during the same Strategy phase."
    'imperial-navy-breacher.sp.attack-order': (state, player) =>
      state.teams[player].gambitsUsedTP.includes('imperial-navy-breacher.sp.defence-order')
        ? { ok: false, reason: 'you cannot use Attack Order and Defence Order in the same Strategy phase' }
        : { ok: true },
    'imperial-navy-breacher.sp.defence-order': (state, player) =>
      state.teams[player].gambitsUsedTP.includes('imperial-navy-breacher.sp.attack-order')
        ? { ok: false, reason: 'you cannot use Defence Order and Attack Order in the same Strategy phase' }
        : { ok: true },
  },
  aiHints: {
    roles: {
      'imperial-navy-breacher.navis-sergeant-at-arms': 'leader',
      'imperial-navy-breacher.navis-armsman': 'objective',
      'imperial-navy-breacher.navis-axejack': 'melee',
      'imperial-navy-breacher.navis-c-a-t-unit': 'scout',
      'imperial-navy-breacher.navis-endurant': 'support',
      'imperial-navy-breacher.navis-gheistskull': 'scout',
      'imperial-navy-breacher.navis-grenadier': 'gunner',
      'imperial-navy-breacher.navis-gunner': 'gunner',
      'imperial-navy-breacher.navis-hatchcutter': 'support',
      'imperial-navy-breacher.navis-surveyor': 'support',
      'imperial-navy-breacher.navis-void-jammer': 'support',
    },
    ployValue: {
      'imperial-navy-breacher.sp.attack-order': 0.6,
      'imperial-navy-breacher.sp.defence-order': 0.5,
      'imperial-navy-breacher.sp.close-assault': 0.6,
      'imperial-navy-breacher.sp.brace-for-counterattack': 0.5,
      'imperial-navy-breacher.fp.overwhelm-target': 0.6,
      'imperial-navy-breacher.fp.blitz': 0.6,
      'imperial-navy-breacher.fp.lock-it-down': 0.5,
      'imperial-navy-breacher.fp.deck-hand': 0.3,
    },
    equipmentValue: {
      'imperial-navy-breacher.eq.rebreathers': 0.5,
      'imperial-navy-breacher.eq.slugs': 0.6,
      'imperial-navy-breacher.eq.combat-stimms': 0.4,
      'imperial-navy-breacher.eq.system-override-device': 0.3,
    },
  },
});

export default imperialNavyBreacher;

/**
 * "visible to and within 8\" of a friendly GHEISTSKULL operative" — used both to validate
 * the selection and to decide INTERFERENCE PULSE's +1.
 */
function gheistskullSeeing(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  target: OperativeState,
): boolean {
  const index = terrain(ctx, state);
  return Object.values(state.operatives).some(
    (g) =>
      !g.removed &&
      g.player === op.player &&
      g.datacardId.includes('gheistskull') &&
      gapBetween(ctx, g, target) <= 8 + 1e-6 &&
      isVisible(index, body(ctx, g), body(ctx, target)).visible,
  );
}
