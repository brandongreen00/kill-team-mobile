/**
 * KOMMANDOS — Orks. https://wahapedia.ru/kill-team3/kill-teams/kommandos/
 * Rule text is read from `data/teams/kommandos.json`.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { successes } from '../../core/dice.ts';
import { aliveOperatives, body, enemiesInControlRange, inflictDamage, log, recordRoll, settleZ } from '../../core/state.ts';
import { advanceShoot, startShoot } from '../../core/sequences/shoot.ts';
import { coverAndObscured, isVisible, vantageIgnoreFilter } from '../../core/visibility.ts';
import { dist } from '../../core/geometry.ts';
import type { GameContext } from '../../core/context.ts';
import type { FightSequence } from '../../core/sequences/types.ts';
import type { GameState, OperativeState, PlayerId, Weapon } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  chosenOperative,
  currentApl,
  defineTeam,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('kommandos');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const KW = 'KOMMANDO';
/** "…(excluding BOMB SQUIG and GROT)" — the two half-selection operatives. */
const isBoyOrBigger = (T: TeamHooks, op: OperativeState): boolean =>
  T.mineKw(op, KW) && !T.kw(op, 'BOMB SQUIG') && !T.kw(op, 'GROT');

const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

/**
 * Throat Slittas: "Each friendly KOMMANDO operative (excluding BOMB SQUIG) can perform the
 * Charge action while it has a Conceal order."
 *
 * The universal Charge action rejects a Conceal order outright and `canPerformAction` can only
 * forbid, never permit, so the carve-out is its own action that runs the same move validation
 * and resolves through the universal Charge (`treatedAs: 'Charge'`, so action restrictions and
 * the Reposition/Dash/Fall Back exclusions are shared with it).
 */
export const THROAT_SLITTAS_CHARGE = 'Charge (Throat Slittas)';

registerAction({
  id: THROAT_SLITTAS_CHARGE,
  name: 'Charge (Throat Slittas)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: DATA.factionRules.find((r) => r.id === 'kommandos.rule.throat-slittas')!.text,
  available: (ctx, _state, op) => {
    const kws = ctx.datacards.get(op.datacardId)?.keywords ?? [];
    return kws.includes(KW) && !kws.includes('BOMB SQUIG');
  },
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
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

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- BOSS NOB › Krumpin' Time (see the extra Fight action below) --------

  // ---- BOY › Taktical Wot-notz -------------------------------------------
  // Registered as two extra actions; this binding records the rule for the tooltip.
  reg.on('canPerformAction', T.bind('kommandos.boy.taktical-wot-notz', 12), (ev) => {
    if (ev.action !== SMOKE_WOT_NOTZ && ev.action !== STUN_WOT_NOTZ) return;
    if (ev.operative.player !== T.player) return;
    if (usedThisTP(ev.state, `kommandos.wotNotz:${T.player}:${ev.action}`)) {
      ev.allowed = false;
      ev.reason = 'you can do each of these once per turning point';
    }
  });

  // ---- COMMS BOY › I Got a Plan, Ladz ------------------------------------
  reg.on('onActionCost', T.bind('kommandos.comms-boy.i-got-a-plan-ladz', 12), (ev) => {
    if (ev.operative.datacardId !== 'kommandos.comms-boy' || ev.operative.player !== T.player) return;
    const def = ev.action;
    const mission = def === 'Pick Up Marker' || def === 'Place Marker' || isMissionAction(def);
    if (!mission) return;
    if (planUsedThisActivation(ev.state, ev.operative.id)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  reg.on('onActivationEnd', T.bind('kommandos.comms-boy.i-got-a-plan-ladz', 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    const store = (ev.state.opState['kommandos.plan'] ?? {}) as Record<string, unknown>;
    delete store[ev.operative.id];
    ev.state.opState['kommandos.plan'] = store;
  });

  // ---- BREACHA BOY › BREACH (AP discount during Charge/Reposition) -------
  reg.on('onActionCost', T.bind('kommandos.breacha-boy.act.breach', 12), (ev) => {
    if (ev.action !== BREACH_ACTION) return;
    if (ev.operative.datacardId !== 'kommandos.breacha-boy' || ev.operative.player !== T.player) return;
    // "…it can do so for 1 less AP during those actions."
    if (ev.operative.actionsThisActivation.some((a) => a === 'Charge' || a === 'Reposition')) ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- GROT › Sneaky Zogger ----------------------------------------------
  // "This operative cannot have an Engage order."
  reg.on('onActivationStart', T.bind('kommandos.grot.sneaky-zogger', 12), (ev) => {
    if (ev.operative.datacardId !== 'kommandos.grot' || ev.operative.player !== T.player) return;
    if (ev.operative.order === 'engage') {
      ev.operative.order = 'conceal';
      log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.letter} cannot have an Engage order (Sneaky Zogger)` });
    }
  });
  // "Whenever this operative is in cover, it cannot be selected as a valid target, taking
  //  precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"."
  reg.on('onValidTarget', T.bind('kommandos.grot.sneaky-zogger', 13), (ev) => {
    if (ev.target.datacardId !== 'kommandos.grot' || ev.target.player !== T.player) return;
    if (!T.ctx) return;
    if (T.gap(ev.attacker, ev.target) <= 2 + 1e-6) return; // "except being within 2""
    const index = terrain(T.ctx, ev.state);
    const a = body(T.ctx, ev.attacker);
    const t = body(T.ctx, ev.target);
    const cover = coverAndObscured(index, a, t, { ignore: vantageIgnoreFilter(index, a, t) });
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'Sneaky Zogger: the GROT is in cover';
  });

  // ---- SNIPA BOY › Concealed Position (rare weapon rule) -----------------
  reg.on('availableWeapons', T.bind('kommandos.snipa-boy.concealed-position', 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const concealed = (T.card(ev.operative)?.weapons ?? []).filter((w) =>
      w.profiles.some((p) => p.rules.some((r) => r.id === 'ConcealedPosition')),
    );
    if (concealed.length === 0 || !hasShot(ev.state, ev.operative.id)) return;
    // The rule is per PROFILE, but weapon availability is per weapon: only the concealed
    // profile is removed, by dropping the weapon when every remaining profile is concealed.
    for (const w of concealed) {
      if (w.profiles.every((p) => p.rules.some((r) => r.id === 'ConcealedPosition')))
        ev.weapons = ev.weapons.filter((n) => n !== w.name);
    }
  });
  reg.on('onSelectWeapon', T.bind('kommandos.snipa-boy.concealed-position', 13), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (hasShot(ev.state, ev.ctx.attacker.id)) {
      ev.allowed = false;
      ev.reason = 'Concealed Position: only the first Shoot action of the battle';
    }
  });
  reg.on('onCollectAttackDice', T.bind('kommandos.snipa-boy.concealed-position', 14), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    if (ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition') && hasShot(ev.state, ev.ctx.attacker.id)) {
      // The concealed profile can only be used once; a later use loses its Devastating punch.
      ev.mods.hit -= 1;
    }
    markShot(ev.state, ev.ctx.attacker.id);
  });

  // ---- SLASHA BOY › Dat All You Got? -------------------------------------
  reg.on('onStrikeResolved', T.bind('kommandos.slasha-boy.dat-all-you-got', 12), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || !T.ctx) return;
    const slasha = [seq.attackerId, seq.defenderId]
      .map((id) => ev.state.operatives[id])
      .find((o) => o && o.datacardId === 'kommandos.slasha-boy' && o.player === T.player);
    if (!slasha || slasha.incapacitated) return; // "if it wasn't incapacitated"
    const foe = ev.state.operatives[slasha.id === seq.attackerId ? seq.defenderId : seq.attackerId];
    if (!foe) return;
    // "After this operative fights or retaliates" — once the dice are all resolved.
    const over = successes(seq.attackerPool).length === 0 && successes(seq.defenderPool).length === 0;
    if (!over && !foe.incapacitated) return;
    if (!useOncePerSequence(ev.state, `kommandos.datAllYouGot:${slasha.id}`)) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'datAllYouGot', [d3], T.player, 'Dat All You Got? D3');
    inflictDamage(T.ctx, ev.state, foe, d3, 'other');
  });

  // ---- BOMB SQUIG › Stoopid ----------------------------------------------
  reg.on('canPerformAction', T.bind('kommandos.bomb-squig.stoopid', 12), (ev) => {
    if (ev.operative.datacardId !== 'kommandos.bomb-squig' || ev.operative.player !== T.player) return;
    const allowed = ['Charge', 'Dash', 'Fight', 'Reposition', 'Shoot', EXPLOSIVE_SHOOT];
    if (!allowed.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'a BOMB SQUIG cannot perform that action';
    }
  });
  reg.on('onActivationStart', T.bind('kommandos.bomb-squig.stoopid', 13), (ev) => {
    if (ev.operative.datacardId !== 'kommandos.bomb-squig' || ev.operative.player !== T.player) return;
    // "whenever you determine this operative's order, you cannot select Conceal"
    if (ev.operative.order === 'conceal') {
      ev.operative.order = 'engage';
      log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.letter} cannot have a Conceal order (Stoopid)` });
    }
  });

  // ---- BOMB SQUIG › Explosive (rare weapon rule) -------------------------
  // The Explosive shot targets the BOMB SQUIG itself, so the shot is resolved point-blank
  // (the only way the engine lets an operative shoot while engaged). The point-blank Hit
  // penalty is cancelled here, because Explosive does not print one.
  reg.on('onStatMod', T.bind('kommandos.bomb-squig.explosive', 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'shoot' || seq.attackerId !== ev.operative.id || !seq.pointBlank) return;
    const weapon = T.card(ev.operative)?.weapons.find((w) => w.name === seq.weaponName);
    if (!weapon?.profiles.some((p) => p.rules.some((r) => r.id === 'Explosive'))) return;
    ev.mods.hit += 1;
  });

  // ---- BOMB SQUIG › Boom! -------------------------------------------------
  reg.on('onIncapacitated', T.bind('kommandos.bomb-squig.boom', 13), (ev) => {
    const squig = ev.operative;
    if (squig.datacardId !== 'kommandos.bomb-squig' || squig.player !== T.player || ev.prevented) return;
    if (!T.ctx) return;
    const weapon = T.card(squig)?.weapons.find((w) => w.name === 'Explosives');
    const profile = weapon?.profiles[0];
    if (!weapon || !profile) return;
    if ((squig.weaponUses[weapon.name] ?? 0) > 0) return; // "a battle in which it hasn't used its explosives"
    if (!useOncePerBattle(ev.state, `kommandos.boom:${squig.id}`)) return;
    // "roll one D6, or two D6 if you wish" — two dice cost nothing, so two are always rolled.
    const rolls = [T.ctx.rng.d6(), T.ctx.rng.d6()];
    recordRoll(ev.state, 'boom', rolls, T.player, 'Boom! 4+');
    if (!rolls.some((r) => r >= 4)) return;
    const radius = profile.rules.find((r) => r.id === 'Blast')?.x ?? 1;
    for (const other of aliveOperatives(ev.state)) {
      if (other.id === squig.id) continue;
      if (T.gap(squig, other) > radius + 1e-6) continue;
      inflictDamage(T.ctx, ev.state, other, profile.dmgN, 'other');
    }
    log(ev.state, { kind: 'action', player: T.player, text: `${squig.letter}: Boom! (${rolls.join(', ')})` });
  });
}

const isMissionAction = (id: string): boolean => getAction(id)?.type === 'mission';

function planUsedThisActivation(state: GameState, id: string): boolean {
  const store = (state.opState['kommandos.plan'] ?? {}) as Record<string, unknown>;
  if (store[id]) return true;
  store[id] = true;
  state.opState['kommandos.plan'] = store;
  return false;
}

function hasShot(state: GameState, id: string): boolean {
  return Boolean((state.opState['kommandos.shot'] as Record<string, boolean> | undefined)?.[id]);
}
function markShot(state: GameState, id: string): void {
  const b = (state.opState['kommandos.shot'] ?? {}) as Record<string, boolean>;
  b[id] = true;
  state.opState['kommandos.shot'] = b;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // DAKKA! DAKKA! DAKKA! (strategy)
  reg.on('onWeaponRules', T.bind('kommandos.sp.dakka-dakka-dakka', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'kommandos.sp.dakka-dakka-dakka')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Dakka! Dakka! Dakka!)'));
  });

  // WAAAGH! (strategy)
  reg.on('onWeaponRules', T.bind('kommandos.sp.waaagh', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'kommandos.sp.waaagh')) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Waaagh!)'));
  });

  // SKULK ABOUT (strategy)
  reg.on('onDefenceDice', T.bind('kommandos.sp.skulk-about', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'kommandos.sp.skulk-about')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || target.order !== 'conceal') return;
    if (ev.state.sequence?.kind !== 'shoot') return;
    // "retain one of your defence dice as a normal success without rolling it (in addition to
    //  a cover save, if any)" — the engine's auto-retained die is the cover-save slot.
    if (ev.coverSave) ev.extraCoverSaves += 1;
    else ev.coverSave = true;
  });

  // SSSSHHHH! (strategy) — "You cannot use this ploy during the first turning point."
  reg.on('onPloyUsed', T.bind('kommandos.sp.sssshhhh', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kommandos.sp.sssshhhh') return;
    for (const op of T.friendlies(ev.state, KW)) {
      const hidden = op.order === 'conceal' && T.enemies(ev.state).every((e) => T.gap(op, e) > 6 + 1e-6);
      const unseen = T.enemies(ev.state).every((e) => !visibleTo(T, ev.state, e, op));
      if (!hidden && !unseen) continue;
      grantFreeAction(ev.state, op, {
        sourceId: 'kommandos.sp.sssshhhh',
        sourceText: shortQuote(text('kommandos.sp.sssshhhh')),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash'],
      });
    }
  });

  // JUST A SCRATCH (firefight)
  reg.on('onDamage', T.bind('kommandos.fp.just-a-scratch', 20), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (!ployUsed(ev.state, T.player, 'kommandos.fp.just-a-scratch')) return;
    if (!isBoyOrBigger(T, ev.target)) return;
    // "when an attack dice inflicts Normal Dmg" — a critical success is not covered.
    const profile = currentDamageProfile(T, ev.state);
    if (profile && ev.amount >= profile.dmgC && profile.dmgC !== profile.dmgN) return;
    if (!useOncePerTP(ev.state, `kommandos.justAScratch:${T.player}`)) return;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Just a Scratch: ${ev.target.letter} ignores ${ev.amount} damage` });
    ev.amount = 0;
  });

  // KRUMP 'EM! (firefight)
  reg.on('onPloyUsed', T.bind('kommandos.fp.krump-em', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kommandos.fp.krump-em') return;
    const engaged = T.friendlies(ev.state, KW).filter((o) => T.enemies(ev.state).some((e) => T.gap(o, e) <= 1 + 1e-6));
    const op = chosenOperative(ev.state, ev.data, engaged.length > 0 ? engaged : T.friendlies(ev.state, KW));
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: 'kommandos.fp.krump-em',
      sourceText: shortQuote(text('kommandos.fp.krump-em')),
      threshold: currentApl(T, ev.state, op),
      only: ['Fight'],
    });
  });

  // KUNNIN' BUT BRUTAL (firefight)
  reg.on('onWeaponRules', T.bind('kommandos.fp.kunnin-but-brutal', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'kommandos.fp.kunnin-but-brutal')) return;
    const seq = fightSeq(ev.state);
    if (!seq || ev.type !== 'melee') return;
    const fighter = ev.state.operatives[seq.attackerId];
    if (!fighter || fighter.id !== ev.operative.id) return;
    if (!T.mineKw(fighter, KW) || fighter.order !== 'conceal') return;
    if (!fighter.actionsThisActivation.includes('Charge')) return;
    const pool = seq.attackerPool;
    // "you're resolving the first attack dice, and it's a strike with a normal success:
    //  treat that normal success as a critical success instead."
    if (pool.dice.some((d) => d.state === 'struck' || d.state === 'blocked' || d.state === 'discarded')) return;
    const die = pool.dice.find((d) => d.state === 'normal');
    if (!die) return;
    if (!useOncePerSequence(ev.state, `kommandos.kunnin:${fighter.id}`)) return;
    die.state = 'crit';
    die.note = 'Kunnin’ but Brutal';
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Kunnin’ but Brutal: a normal success becomes critical' });
  });

  // SHAKE IT OFF (firefight)
  reg.on('onPloyUsed', T.bind('kommandos.fp.shake-it-off', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'kommandos.fp.shake-it-off') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = chosenOperative(
      ev.state,
      ev.data,
      active && T.mineKw(active, KW) ? [active] : T.friendlies(ev.state, KW),
    );
    if (!op) return;
    op.aplMods = [];
    effect(ev.state, {
      rule: 'kommandos.shakeItOff',
      source: { kind: 'ploy', id: 'kommandos.fp.shake-it-off' },
      sourceText: shortQuote(text('kommandos.fp.shake-it-off')),
      operativeId: op.id,
      player: T.player,
      // "Until the start of the next turning point".
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onStatMod', T.bind('kommandos.fp.shake-it-off', 21), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, 'kommandos.shakeItOff')) return;
    if (ev.operative.aplMods.length > 0) ev.operative.aplMods = []; // "ignore any changes to its APL stat"
  });
  reg.on('onActivationStart', T.bind('kommandos.fp.shake-it-off', 22), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, 'kommandos.shakeItOff')) return;
    ev.operative.aplMods = [];
  });
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

function currentDamageProfile(T: TeamHooks, state: GameState) {
  const seq = state.sequence;
  if (!seq) return undefined;
  const holder = state.operatives[seq.kind === 'shoot' ? seq.attackerId : seq.turn === 'attacker' ? seq.attackerId : seq.defenderId];
  if (!holder) return undefined;
  const name = seq.kind === 'shoot' ? seq.weaponName : seq.turn === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const profileName = seq.kind === 'shoot' ? seq.profileName : seq.turn === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
  return weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/** "Choppa — ATK 3, HIT 3+, DMG 4/5" (kommandos.json › equipment). */
const CHOPPA: Weapon = { name: 'Choppa', profiles: [{ type: 'melee', atk: 3, hit: 3, dmgN: 4, dmgC: 5, rules: [] }] };

/** "Dynamite — ATK 5, HIT 4+, DMG 4/5, Range 4", Blast 1", Heavy (Reposition only), Saturate" */
const DYNAMITE: Weapon = {
  name: 'Dynamite',
  profiles: [
    {
      type: 'ranged',
      atk: 5,
      hit: 4,
      dmgN: 4,
      dmgC: 5,
      rules: [ruleTag('Range', 4, 'Range 4"'), ruleTag('Blast', 1, 'Blast 1"'), { id: 'Heavy', only: 'Reposition', raw: 'Heavy (Reposition only)' }, ruleTag('Saturate')],
    },
  ],
};

/** "Harpoon — ATK 4, HIT 4+, DMG 4/5, Range 8", Lethal 5+, Stun" */
const HARPOON: Weapon = {
  name: 'Harpoon',
  profiles: [
    {
      type: 'ranged',
      atk: 4,
      hit: 4,
      dmgN: 4,
      dmgC: 5,
      rules: [ruleTag('Range', 8, 'Range 8"'), ruleTag('Lethal', 5, 'Lethal 5+'), ruleTag('Stun')],
    },
  ],
};

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const giveWeapons = (state: GameState): void => {
    for (const op of T.friendlies(state, KW)) {
      if (!isBoyOrBigger(T, op)) continue;
      const own = (T.card(op)?.weapons ?? []).map((w) => w.name.toLowerCase());
      // CHOPPAS: "some operatives already have this weapon but with better stats; in that
      // instance, use the better version."
      if (hasEquipment(state, T.player, 'kommandos.eq.choppas') && !own.includes('choppa'))
        grantWeapon(op, structuredClone(CHOPPA));
      if (hasEquipment(state, T.player, 'kommandos.eq.dynamite')) grantWeapon(op, structuredClone(DYNAMITE));
      if (hasEquipment(state, T.player, 'kommandos.eq.harpoon')) grantWeapon(op, structuredClone(HARPOON));
    }
  };
  reg.on('onDeploy', T.bind('kommandos.eq.choppas', 30), (ev) => {
    if (ev.operative.player === T.player) giveWeapons(ev.state);
  });
  reg.on('onActivationStart', T.bind('kommandos.eq.choppas', 31), (ev) => {
    if (ev.operative.player === T.player) giveWeapons(ev.state);
  });

  // DYNAMITE — "Once per battle, a friendly KOMMANDO operative … can use the following weapon"
  reg.on('availableWeapons', T.bind('kommandos.eq.dynamite', 32), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!usedThisBattle(ev.state, `kommandos.dynamite:${T.player}`)) return;
    ev.weapons = ev.weapons.filter((n) => n !== 'Dynamite');
  });
  reg.on('onCollectAttackDice', T.bind('kommandos.eq.dynamite', 33), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.weaponName !== 'Dynamite') return;
    useOncePerBattle(ev.state, `kommandos.dynamite:${T.player}`);
  });

  // HARPOON — "Once per turning point…"
  reg.on('availableWeapons', T.bind('kommandos.eq.harpoon', 34), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!usedThisTP(ev.state, `kommandos.harpoon:${T.player}`)) return;
    ev.weapons = ev.weapons.filter((n) => n !== 'Harpoon');
  });
  reg.on('onCollectAttackDice', T.bind('kommandos.eq.harpoon', 35), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.weaponName !== 'Harpoon') return;
    useOncePerTP(ev.state, `kommandos.harpoon:${T.player}`);
  });

  // COLLAPSIBLE STOCKS
  reg.on('onWeaponRules', T.bind('kommandos.eq.collapsible-stocks', 36), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'kommandos.eq.collapsible-stocks')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!/^(shokka pistol|slugga)$/i.test(ev.weaponName)) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Range'); // "Remove the Range weapon rule"
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const BREACH_ACTION = 'kommandos.breacha-boy.act.breach';
const SMOKE_WOT_NOTZ = 'Smoke Grenade (Taktical Wot-notz)';
const STUN_WOT_NOTZ = 'Stun Grenade (Taktical Wot-notz)';
export const EXPLOSIVE_SHOOT = 'Shoot (Explosive)';
export const KRUMPIN_TIME_FIGHT = 'Fight (Krumpin’ Time)';

/** "…add 1 to its APL stat" for the two SUPPORT actions (GET IT DUN! / LISTEN IN). */
function supportApl(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  targetId: string | undefined,
  actionId: string,
): { ok: boolean; reason?: string; target?: OperativeState } {
  const range = supportDistance(ctx, state, op, 6);
  const eligible = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => !(ctx.datacards.get(o.datacardId)?.keywords ?? []).includes('BOMB SQUIG'))
    .filter(
      (o) =>
        Math.max(0, dist(o.pos, op.pos) - 1.3) <= range + 1e-6 &&
        isVisible(terrain(ctx, state), body(ctx, op), body(ctx, o)).visible,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const target = eligible.find((o) => o.id === targetId) ?? eligible[0];
  if (!target)
    return { ok: false, reason: `select one other friendly KOMMANDO operative visible to and within ${range}"` };
  if (state.opState['counteract']?.['operativeId'] === op.id && actionId === 'kommandos.boss-nob.act.get-it-dun')
    return { ok: false, reason: 'this operative cannot perform this action while counteracting' };
  return { ok: true, target };
}

function actions(data: typeof DATA) {
  const aplBoost = (actionId: string) => ({
    check: (ctx: GameContext, state: GameState, op: OperativeState, params: { targetOperativeId?: string }) => {
      const eng = notEngaged(ctx, state, op);
      if (!eng.ok) return eng;
      const r = supportApl(ctx, state, op, params.targetOperativeId, actionId);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason! };
    },
    perform: (ctx: GameContext, state: GameState, op: OperativeState, params: { targetOperativeId?: string }) => {
      const r = supportApl(ctx, state, op, params.targetOperativeId, actionId);
      if (!r.ok || !r.target) return { ok: false, reason: r.reason ?? 'no target' };
      r.target.aplMods.push(1);
      effect(state, {
        rule: 'kommandos.aplBoost',
        source: { kind: 'ability', id: actionId },
        operativeId: r.target.id,
        player: op.player,
        expiry: { kind: 'endOfNextActivation', operativeId: r.target.id, armed: false },
      });
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: ${r.target.letter} +1 APL` });
      return { ok: true };
    },
  });

  return [
    // GET IT DUN! 1AP (SUPPORT) — BOSS NOB
    uniqueAction(data, 'kommandos.boss-nob', 'kommandos.boss-nob.act.get-it-dun', aplBoost('kommandos.boss-nob.act.get-it-dun')),
    // LISTEN IN 1AP (SUPPORT) — COMMS BOY
    uniqueAction(data, 'kommandos.comms-boy', 'kommandos.comms-boy.act.listen-in', aplBoost('kommandos.comms-boy.act.listen-in')),

    // BREACH 1AP — BREACHA BOY
    uniqueAction(data, 'kommandos.breacha-boy', BREACH_ACTION, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const index = terrain(ctx, state);
        const near = index.parts.some(
          (p) => dist(op.pos, { x: (p.bounds.min.x + p.bounds.max.x) / 2, y: (p.bounds.min.y + p.bounds.max.y) / 2 }) <= 3,
        );
        return near ? { ok: true } : { ok: false, reason: 'no terrain feature within control range' };
      },
      perform: (_ctx, state, op, params) => {
        const pos = params.targetPos ?? { ...op.pos };
        placeTeamMarker(state, { id: `kommandos.breach.${op.id}`, kind: 'generic', player: op.player, pos, z: op.z, flags: { breach: true } });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: BREACH marker placed` });
        return { ok: true };
      },
    }),

    // GRAPPLING HOOK 1AP — GROT
    uniqueAction(data, 'kommandos.grot', 'kommandos.grot.act.grappling-hook', {
      treatedAs: 'Reposition', // "This action is treated as a Reposition action."
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (op.actionsThisActivation.includes('Charge') || op.actionsThisActivation.includes('Fall Back'))
          return { ok: false, reason: 'already performed Charge or Fall Back this activation' };
        if (!params.targetPos) return { ok: false, reason: 'select a visible point on a terrain feature' };
        const ev = ctx.hooks.emit('onSetUpAgain', state, { state, operative: op, maxInches: Infinity });
        if (dist(op.pos, params.targetPos) > ev.maxInches)
          return { ok: false, reason: ev.reason ?? 'that point is too far away' };
        const clash = aliveOperatives(state).some(
          (o) => o.id !== op.id && o.player !== op.player && dist(o.pos, params.targetPos!) <= 1.6,
        );
        if (clash) return { ok: false, reason: 'cannot be set up within control range of enemy operatives' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        op.pos = { ...params.targetPos! };
        settleZ(ctx, state, op);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: GRAPPLING HOOK` });
        return { ok: true };
      },
    }),

    // DAKKA DASH 1AP — DAKKA BOY
    uniqueAction(data, 'kommandos.dakka-boy', 'kommandos.dakka-boy.act.dakka-dash', {
      check: (ctx, state, op, params) => {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot perform this action with a Conceal order' };
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (!/dakka shoota/i.test(params.weaponName ?? ''))
          return { ok: false, reason: 'you can only select a dakka shoota for that Shoot action' };
        if (params.path) {
          const dash = getAction('Dash')!.check(ctx, state, op, params);
          if (!dash.ok) return dash;
        }
        return getAction('Shoot')!.check(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => {
        if (params.path) {
          const dash = getAction('Dash')!.perform(ctx, state, op, params);
          if (!dash.ok) return dash;
        }
        return getAction('Shoot')!.perform(ctx, state, op, params);
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Extra actions: Krumpin' Time, the Explosive shot and Taktical Wot-notz
// ---------------------------------------------------------------------------

/** BOSS NOB › Krumpin' Time: "This operative can perform two Fight actions during its activation". */
registerAction({
  id: KRUMPIN_TIME_FIGHT,
  name: 'Fight (Krumpin’ Time)',
  ap: 1,
  type: 'unique',
  sourceText: abilityText('kommandos.boss-nob', 'kommandos.boss-nob.krumpin-time'),
  available: (_ctx, _state, op) => op.datacardId === 'kommandos.boss-nob',
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Krumpin’ Time is the second Fight action of an activation' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

/**
 * BOMB SQUIG › Explosive: "This operative can perform the Shoot action with this weapon while
 * within control range of an enemy operative. Don't select a valid target. Instead, this
 * operative is always the primary target and cannot be in cover or obscured."
 */
registerAction({
  id: EXPLOSIVE_SHOOT,
  name: 'Shoot (Explosive)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText:
    'Explosive: This operative can perform the Shoot action with this weapon while within control range of an enemy operative. Don’t select a valid target. Instead, this operative is always the primary target and cannot be in cover or obscured.',
  available: (ctx, _state, op) =>
    (ctx.datacards.get(op.datacardId)?.weapons ?? []).some((w) =>
      w.profiles.some((p) => p.rules.some((r) => r.id === 'Explosive')),
    ),
  check(ctx, state, op, params) {
    const weapon = (ctx.datacards.get(op.datacardId)?.weapons ?? []).find(
      (w) => w.name === params.weaponName && w.profiles.some((p) => p.rules.some((r) => r.id === 'Explosive')),
    );
    if (!weapon) return { ok: false, reason: 'select a weapon that has the Explosive weapon rule' };
    const limited = weapon.profiles[0]?.rules.find((r) => r.id === 'Limited');
    if (limited && (op.weaponUses[weapon.name] ?? 0) >= (limited.x ?? 1))
      return { ok: false, reason: `${weapon.name} has already been used` };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    // The operative is its own primary target; point-blank is the engine's "shoot while
    // engaged" path, and its Hit penalty is cancelled by the Explosive stat hook above.
    const r = startShoot(ctx, state, op, params.weaponName!, params.profileName, op.id, { pointBlank: true });
    if (!r.ok) return r;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

/** BOY › Taktical Wot-notz: the two universal grenade actions, free of the equipment. */
function wotNotz(id: string, name: string, delegate: string): void {
  registerAction({
    id,
    name,
    ap: 1,
    type: 'unique',
    sourceText: abilityText('kommandos.boy', 'kommandos.boy.taktical-wot-notz'),
    available: (_ctx, _state, op) => op.datacardId === 'kommandos.boy',
    check(ctx, state, op, params) {
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      if (delegate === 'Smoke Grenade') {
        const pos = params.targetPos ?? params.markerPos;
        if (!pos) return { ok: false, reason: 'select where to place the Smoke Grenade marker' };
        if (dist(op.pos, pos) > 6 + 1e-6) return { ok: false, reason: 'the marker must be within 6" of this operative' };
        return { ok: true };
      }
      const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
      if (!target || target.removed || target.player === op.player)
        return { ok: false, reason: 'select an enemy operative' };
      if (Math.max(0, dist(op.pos, target.pos) - 1.6) > 6 + 1e-6)
        return { ok: false, reason: 'that operative is more than 6" away' };
      if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
        return { ok: false, reason: 'that operative is not visible' };
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      // "Performing these actions using this rule doesn't count towards their action limits" —
      // the universal action spends a kill-team grenade use, which is restored afterwards.
      const uses = { ...state.teams[op.player].equipmentUses };
      const res = getAction(delegate)!.perform(ctx, state, op, params);
      state.teams[op.player].equipmentUses = { ...uses };
      if (res.ok) markWotNotz(state, op.player, id);
      return res;
    },
  });
}

function markWotNotz(state: GameState, player: PlayerId, action: string): void {
  const b = (state.opState['teamOnce'] ?? {}) as Record<string, unknown>;
  b[`kommandos.wotNotz:${player}:${action}`] = `${state.turningPoint}`;
  state.opState['teamOnce'] = b;
}

wotNotz(SMOKE_WOT_NOTZ, 'Smoke Grenade (Taktical Wot-notz)', 'Smoke Grenade');
wotNotz(STUN_WOT_NOTZ, 'Stun Grenade (Taktical Wot-notz)', 'Stun Grenade');

// ---------------------------------------------------------------------------

export const kommandos = defineTeam({
  id: 'kommandos',
  rareRules: ['ConcealedPosition', 'Explosive'],
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "You cannot use this ploy during the first turning point."
    'kommandos.sp.sssshhhh': (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
  },
  aiHints: {
    roles: {
      'kommandos.boss-nob': 'leader',
      'kommandos.bomb-squig': 'melee',
      'kommandos.boy': 'objective',
      'kommandos.breacha-boy': 'melee',
      'kommandos.burna-boy': 'gunner',
      'kommandos.comms-boy': 'support',
      'kommandos.dakka-boy': 'gunner',
      'kommandos.grot': 'scout',
      'kommandos.rokkit-boy': 'gunner',
      'kommandos.slasha-boy': 'melee',
      'kommandos.snipa-boy': 'sniper',
    },
    ployValue: {
      'kommandos.sp.dakka-dakka-dakka': 0.6,
      'kommandos.sp.waaagh': 0.6,
      'kommandos.sp.skulk-about': 0.5,
      'kommandos.sp.sssshhhh': 0.4,
      'kommandos.fp.just-a-scratch': 0.7,
      'kommandos.fp.krump-em': 0.5,
      'kommandos.fp.kunnin-but-brutal': 0.5,
      'kommandos.fp.shake-it-off': 0.3,
    },
    equipmentValue: {
      'kommandos.eq.choppas': 0.6,
      'kommandos.eq.dynamite': 0.4,
      'kommandos.eq.harpoon': 0.5,
      'kommandos.eq.collapsible-stocks': 0.4,
    },
  },
});

export default kommandos;
