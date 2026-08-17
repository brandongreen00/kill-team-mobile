/**
 * PLAGUE MARINES — Death Guard. https://wahapedia.ru/kill-team3/kill-teams/plague-marines/
 * Rule text is read from `data/teams/plague-marines.json`.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { body, gapBetween, inflictDamage, log, recordRoll } from '../../core/state.ts';
import { terrain } from '../../core/context.ts';
import { isVisible } from '../../core/visibility.ts';
import type { GameState, OperativeState, PlayerId, Weapon } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  defineTeam,
  effect,
  effectOn,
  gambitUsed,
  giveToken,
  grantWeapon,
  hasEquipment,
  hasToken,
  notEngaged,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('plague-marines');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!.text;

/** "…gains one of your Poison tokens". Tokens belong to a player and sit on an operative. */
export const POISON = 'plagueMarines.poison';

export function hasPoison(state: GameState, op: OperativeState, player: PlayerId): boolean {
  return hasToken(state, op.id, POISON, player);
}

const POISON_TEXT =
  'Poison: In the Resolve Attack Dice step, if you inflict damage with any successes, the operative this weapon is being used against (excluding friendly PLAGUE MARINE operatives) gains one of your Poison tokens (if it doesn’t already have one). Whenever an operative that has one of your Poison tokens is activated, inflict 1 damage on it.';

// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Poison (rare weapon rule + faction rule) ---------------------------
  reg.on('onStrikeResolved', T.bind('plague-marines.rule.poison', 12), (ev) => {
    if (!ev.ctx.rules.some((r) => r.id === 'Poison')) return;
    if (ev.ctx.attacker.player !== T.player) return;
    // "excluding friendly PLAGUE MARINE operatives"
    if (T.mineKw(ev.struck, 'PLAGUE MARINE')) return;
    giveToken(ev.state, ev.struck, POISON, {
      sourceId: 'plague-marines.rule.poison',
      sourceText: POISON_TEXT,
      player: T.player,
    });
  });
  // "Whenever an operative that has one of your Poison tokens is activated, inflict 1 damage."
  reg.on('onActivationStart', T.bind('plague-marines.rule.poison', 13), (ev) => {
    if (!hasPoison(ev.state, ev.operative, T.player)) return;
    if (T.ctx) inflictDamage(T.ctx, ev.state, ev.operative, 1, 'other');
  });

  // ---- Toxic (rare weapon rule, CHAMPION / BOMBARDIER / WARRIOR) ----------
  // Dmg stats live on the (shared) datacard profile, so Toxic's "+1 to both Dmg stats" is
  // applied where the damage is inflicted rather than by rewriting the profile.
  reg.on('onDamage', T.bindText('plague-marines.toxic.dmg', 'Toxic: add 1 to both Dmg stats of this weapon.'), (ev) => {
    if (ev.kind !== 'attack') return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player !== T.player) return;
    if (!hasPoison(ev.state, ev.target, T.player)) return;
    const name = seq.kind === 'shoot' ? seq.weaponName : seq.attackerWeapon;
    const weapon = T.card(attacker)?.weapons.find((w) => w.name === name);
    const toxic = weapon?.profiles.some((p) => p.rules.some((r) => r.id === 'Toxic'));
    if (!toxic) return;
    ev.amount += 1;
  });

  // ---- Disgustingly Resilient --------------------------------------------
  // "Whenever an attack dice inflicts damage of 3 or more on a friendly PLAGUE MARINE
  //  operative, roll one D6: on a 4+, subtract 1 from that inflicted damage."
  reg.on('onDamage', T.bind('plague-marines.rule.disgustingly-resilient', 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!T.mineKw(ev.target, 'PLAGUE MARINE')) return;
    if (ev.amount < 3) return;
    // SICKENING RESILIENCE: "always subtract 1 … you don't need to roll."
    if (effectOn(ev.state, ev.target.id, 'plagueMarines.sickeningResilience')) {
      ev.amount = Math.max(2, ev.amount - 1);
      return;
    }
    const roll = rollD6(ev.state, T);
    if (roll >= 4) ev.amount -= 1;
  });

  // ---- Astartes: counteract regardless of order ---------------------------
  reg.on('onCounteract', T.bind('plague-marines.rule.astartes', 12), (ev) => {
    if (T.mineKw(ev.operative, 'PLAGUE MARINE')) ev.allowed = true;
  });

  // ---- CHAMPION › Grandfather's Blessing ----------------------------------
  reg.on('onDamage', T.bind('plague-marines.champion.grandfathers-blessing', 12), (ev) => {
    if (!hasPoison(ev.state, ev.target, T.player)) return;
    if (ev.target.player === T.player) return;
    const champion = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'plague-marines.champion' && !o.incapacitated && T.gap(o, ev.target) <= 7 + 1e-6,
    );
    if (!champion) return;
    const card = T.card(champion);
    const budget = healBudget(ev.state, T.player);
    if (budget <= 0 || !card) return;
    const healed = Math.min(ev.amount, budget, card.wounds - champion.wounds);
    if (healed <= 0) return;
    champion.wounds += healed;
    spendHeal(ev.state, T.player, healed);
    log(ev.state, { kind: 'action', player: T.player, text: `Grandfather’s Blessing: ${champion.letter} regains ${healed} wounds` });
  });

  // ---- ICON BEARER › Icon Bearer -----------------------------------------
  reg.on('onMarkerControl', T.bind('plague-marines.icon-bearer.icon-bearer', 12), (ev) => {
    const bearer = T.friendlies(ev.state).find((o) => o.datacardId === 'plague-marines.icon-bearer');
    if (!bearer) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker || T.markerGap(bearer, marker) > 1 + 1e-6) return;
    ev.aplByPlayer[T.player] += 1; // "treat this operative's APL stat as 1 higher"
  });

  // ---- WARRIOR › Repulsive Fortitude --------------------------------------
  reg.on('onDefenceDice', T.bind('plague-marines.warrior.repulsive-fortitude', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.datacardId !== 'plague-marines.warrior' || target.player !== T.player) return;
    // "defence dice results of 5+ are critical successes" — the best normal is promoted.
    const seq = ev.state.sequence;
    if (seq?.kind !== 'shoot') return;
    for (const die of seq.defence.dice) if (die.rolled && die.value >= 5 && die.state === 'normal') die.state = 'crit';
  });
}

function rollD6(state: GameState, T: TeamHooks): number {
  const roll = T.ctx?.rng.d6() ?? 4;
  recordRoll(state, 'disgustinglyResilient', [roll], T.player, 'Disgustingly Resilient 4+');
  return roll;
}

function healBudget(state: GameState, player: PlayerId): number {
  const b = (state.opState['plagueMarines.heal'] ?? {}) as Record<string, { tp: number; used: number }>;
  const cur = b[player];
  if (!cur || cur.tp !== state.turningPoint) return 3;
  return Math.max(0, 3 - cur.used);
}
function spendHeal(state: GameState, player: PlayerId, n: number): void {
  const b = (state.opState['plagueMarines.heal'] ?? {}) as Record<string, { tp: number; used: number }>;
  const cur = b[player] && b[player]!.tp === state.turningPoint ? b[player]! : { tp: state.turningPoint, used: 0 };
  cur.used += n;
  b[player] = cur;
  state.opState['plagueMarines.heal'] = b;
}

// ---------------------------------------------------------------------------

const FLIES_MARKER = (player: PlayerId): string => `plagueMarines.cloudOfFlies.${player}`;

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // CONTAGION (strategy)
  reg.on('onStatMod', T.bind('plague-marines.sp.contagion', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'plague-marines.sp.contagion')) return;
    if (ev.operative.player === T.player) return; // "an enemy operative"
    const near = T.friendlies(ev.state, 'PLAGUE MARINE');
    const poisoned = hasPoison(ev.state, ev.operative, T.player) && near.some((o) => T.gap(o, ev.operative) <= 3 + 1e-6);
    const iconNear = near.some(
      (o) => o.datacardId === 'plague-marines.icon-bearer' && T.gap(o, ev.operative) <= 3 + 1e-6,
    );
    if (!poisoned && !iconNear) return;
    ev.mods.move -= 2;
    ev.mods.hit -= 1; // worsen the Hit stat by 1
  });

  // LUMBERING DEATH (strategy)
  reg.on('onWeaponRules', T.bind('plague-marines.sp.lumbering-death', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'plague-marines.sp.lumbering-death')) return;
    if (!T.mineKw(ev.operative, 'PLAGUE MARINE')) return;
    const moved = ev.operative.actionsThisActivation.some((a) => ['Reposition', 'Charge', 'Fall Back'].includes(a));
    if (moved && !ev.retaliating) return; // "hasn't moved more than 3", or whenever it's retaliating"
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Lumbering Death)'));
  });

  // CLOUD OF FLIES (strategy)
  reg.on('onPloyUsed', T.bind('plague-marines.sp.cloud-of-flies', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'plague-marines.sp.cloud-of-flies') return;
    const friendlies = T.friendlies(ev.state, 'PLAGUE MARINE');
    const anchor = friendlies[0];
    const pos = (ev.data?.['pos'] as { x: number; y: number } | undefined) ??
      (anchor ? { ...anchor.pos } : { x: ev.state.map.board.w / 2, y: ev.state.map.board.h / 2 });
    ev.state.markers[FLIES_MARKER(T.player)] = {
      id: FLIES_MARKER(T.player),
      kind: 'generic',
      diameterMm: 20,
      pos,
      z: anchor?.z ?? 0,
      owner: T.player,
      flags: { cloudOfFlies: true },
    };
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Cloud of Flies marker placed' });
  });
  reg.on('onValidTarget', T.bind('plague-marines.sp.cloud-of-flies', 21), (ev) => {
    const marker = ev.state.markers[FLIES_MARKER(T.player)];
    if (!marker) return;
    if (!T.mineKw(ev.target, 'PLAGUE MARINE')) return;
    if (T.gap(ev.attacker, ev.target) <= 3 + 1e-6) return; // "more than 3" from it"
    if (T.markerGap(ev.target, marker) > 1 + 1e-6) return; // "wholly within 1" of that marker"
    // The obscured flag itself is set by the sequence; mark the target so the shoot step sees it.
    effect(ev.state, {
      rule: 'plagueMarines.obscuredByFlies',
      source: { kind: 'ploy', id: 'plague-marines.sp.cloud-of-flies' },
      operativeId: ev.target.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
  });
  reg.on('onDefenceDice', T.bind('plague-marines.sp.cloud-of-flies', 22), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !effectOn(ev.state, target.id, 'plagueMarines.obscuredByFlies')) return;
    const seq = ev.state.sequence;
    if (seq?.kind === 'shoot') seq.obscured = true;
  });
  reg.on('onReadyStep', T.bind('plague-marines.sp.cloud-of-flies', 23), (ev) => {
    if (ev.player === T.player) delete ev.state.markers[FLIES_MARKER(T.player)];
  });

  // NURGLINGS (strategy)
  reg.on('onPloyUsed', T.bind('plague-marines.sp.nurglings', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'plague-marines.sp.nurglings') return;
    const friendlies = T.friendlies(ev.state, 'PLAGUE MARINE');
    const eligible = T.enemies(ev.state).filter((e) => {
      const near3 = friendlies.some((f) => T.gap(f, e) <= 3 + 1e-6);
      const near7 = hasPoison(ev.state, e, T.player) && friendlies.some((f) => T.gap(f, e) <= 7 + 1e-6);
      return near3 || near7;
    });
    const chosenId = ev.data?.['operativeId'];
    const target = eligible.find((e) => e.id === chosenId) ?? [...eligible].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!target) return;
    target.aplMods.push(-1);
    effect(ev.state, {
      rule: 'plagueMarines.nurglings',
      source: { kind: 'ploy', id: 'plague-marines.sp.nurglings' },
      sourceText: shortQuote(text('plague-marines.sp.nurglings')),
      operativeId: target.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Nurglings: ${target.letter} −1 APL` });
  });

  // VIRULENT POISON (firefight)
  reg.on('onPloyUsed', T.bind('plague-marines.fp.virulent-poison', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'plague-marines.fp.virulent-poison') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const source = active && T.mineKw(active, 'PLAGUE MARINE') ? active : T.friendlies(ev.state, 'PLAGUE MARINE')[0];
    if (!source) return;
    const eligible = T.enemies(ev.state).filter((e) => T.gap(source, e) <= 7 + 1e-6 && !hasPoison(ev.state, e, T.player));
    const chosenId = ev.data?.['operativeId'];
    const target = eligible.find((e) => e.id === chosenId) ?? [...eligible].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!target) return;
    giveToken(ev.state, target, POISON, {
      sourceId: 'plague-marines.fp.virulent-poison',
      sourceText: shortQuote(text('plague-marines.fp.virulent-poison')),
      player: T.player,
    });
  });

  // SICKENING RESILIENCE (firefight)
  reg.on('onPloyUsed', T.bind('plague-marines.fp.sickening-resilience', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'plague-marines.fp.sickening-resilience') return;
    for (const o of T.friendlies(ev.state, 'PLAGUE MARINE')) {
      if (effectOn(ev.state, o.id, 'plagueMarines.sickeningResilience')) continue;
      effect(ev.state, {
        rule: 'plagueMarines.sickeningResilience',
        source: { kind: 'ploy', id: 'plague-marines.fp.sickening-resilience' },
        sourceText: shortQuote(text('plague-marines.fp.sickening-resilience')),
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? o.id },
      });
    }
  });

  // POISONOUS DEMISE (firefight)
  reg.on('onIncapacitated', T.bind('plague-marines.fp.poisonous-demise', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'plague-marines.fp.poisonous-demise')) return;
    if (!T.mineKw(ev.operative, 'PLAGUE MARINE')) return;
    for (const e of T.enemies(ev.state)) {
      if (T.gap(ev.operative, e) > 3 + 1e-6) continue;
      if (hasPoison(ev.state, e, T.player)) {
        if (T.ctx) inflictDamage(T.ctx, ev.state, e, 1, 'other');
      } else {
        giveToken(ev.state, e, POISON, {
          sourceId: 'plague-marines.fp.poisonous-demise',
          sourceText: shortQuote(text('plague-marines.fp.poisonous-demise')),
          player: T.player,
        });
      }
    }
  });

  // CURSE OF ROT (firefight)
  reg.on('onRollAttack', T.bind('plague-marines.fp.curse-of-rot', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'plague-marines.fp.curse-of-rot')) return;
    // The opponent's dice: this fires when the enemy is the one rolling.
    if (ev.ctx.attacker.player === T.player) return;
    const foe = ev.ctx.defender;
    if (!foe || !T.mineKw(foe, 'PLAGUE MARINE')) return;
    const seq = ev.state.sequence;
    const pool = seq?.kind === 'shoot' ? seq.attack : seq?.kind === 'fight' ? seq.attackerPool : undefined;
    if (!pool) return;
    let hits = 0;
    for (const die of pool.dice) {
      if (!die.rolled || die.value !== 3 || die.state === 'discarded') continue;
      die.state = 'discarded'; // "that result cannot be retained as a success"
      die.note = 'Curse of Rot';
      hits++;
    }
    if (hits > 0) {
      const victim = ev.state.operatives[ev.ctx.attacker.id]!;
      if (T.ctx) inflictDamage(T.ctx, ev.state, victim, hits, 'other');
      log(ev.state, { kind: 'ploy', player: T.player, text: `Curse of Rot inflicts ${hits} damage` });
    }
  });
}

// ---------------------------------------------------------------------------

/** "Blight grenade — ATK 4, HIT 4+, DMG 2/4, Range 6", Blast 2", Saturate, Severe, Poison*" */
const BLIGHT_GRENADE: Weapon = {
  name: 'Blight grenade',
  profiles: [
    {
      type: 'ranged',
      atk: 4,
      hit: 4,
      dmgN: 2,
      dmgC: 4,
      rules: [
        ruleTag('Range', 6, 'Range 6"'),
        ruleTag('Blast', 2, 'Blast 2"'),
        ruleTag('Saturate'),
        ruleTag('Severe'),
        ruleTag('Poison', undefined, 'Poison*'),
        ruleTag('Limited', 2, 'Limited 2'),
      ],
    },
  ],
};

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // PLAGUE BELLS — ignore injured stat changes.
  reg.on('onStatMod', T.bind('plague-marines.eq.plague-bells', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'plague-marines.eq.plague-bells')) return;
    if (!T.mineKw(ev.operative, 'PLAGUE MARINE')) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });

  // PLAGUE ROUNDS
  reg.on('onWeaponRules', T.bind('plague-marines.eq.plague-rounds', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'plague-marines.eq.plague-rounds')) return;
    if (!T.mineKw(ev.operative, 'PLAGUE MARINE')) return;
    if (!/^(boltgun|bolt pistol)$/i.test(ev.weaponName)) return;
    ev.rules.push(ruleTag('Poison', undefined, 'Poison*'), ruleTag('Severe', undefined, 'Severe (Plague Rounds)'));
  });

  // BLIGHT GRENADES
  const giveGrenades = (state: GameState): void => {
    if (!hasEquipment(state, T.player, 'plague-marines.eq.blight-grenades')) return;
    for (const o of T.friendlies(state, 'PLAGUE MARINE')) grantWeapon(o, structuredClone(BLIGHT_GRENADE));
  };
  reg.on('onDeploy', T.bind('plague-marines.eq.blight-grenades', 30), (ev) => {
    if (ev.operative.player === T.player) giveGrenades(ev.state);
  });
  reg.on('onActivationStart', T.bind('plague-marines.eq.blight-grenades', 31), (ev) => {
    if (ev.operative.player === T.player) giveGrenades(ev.state);
  });

  // POISON VENTS
  reg.on('onActivationStart', T.bind('plague-marines.eq.poison-vents', 32), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'plague-marines.eq.poison-vents')) return;
    if (ev.operative.player === T.player) return; // "whenever an ENEMY operative is activated"
    const near = T.friendlies(ev.state, 'PLAGUE MARINE').some((o) => T.gap(o, ev.operative) <= 3 + 1e-6);
    if (!near) return;
    if (!hasPoison(ev.state, ev.operative, T.player)) {
      const roll = T.ctx?.rng.d3() ?? 1;
      recordRoll(ev.state, 'poisonVents', [roll], T.player, 'Poison Vents D3');
      if (roll === 3)
        giveToken(ev.state, ev.operative, POISON, {
          sourceId: 'plague-marines.eq.poison-vents',
          sourceText: shortQuote(text('plague-marines.eq.poison-vents')),
          player: T.player,
        });
    } else {
      const dmg = T.ctx?.rng.d3() ?? 1;
      recordRoll(ev.state, 'poisonVents', [dmg], T.player, 'Poison Vents D3 damage');
      if (T.ctx) inflictDamage(T.ctx, ev.state, ev.operative, dmg, 'other');
      log(ev.state, { kind: 'action', player: T.player, text: `Poison Vents inflict ${dmg} damage on ${ev.operative.letter}` });
    }
  });
}

// ---------------------------------------------------------------------------

function actions(data: typeof DATA) {
  return [
    // FLAIL 1AP — FIGHTER
    uniqueAction(data, 'plague-marines.fighter', 'plague-marines.fighter.act.flail', {
      treatedAs: 'Fight',
      check: (_ctx, _state, op) =>
        op.order === 'conceal'
          ? { ok: false, reason: 'cannot perform this action while it has a Conceal order' }
          : { ok: true },
      perform: (ctx, state, op) => {
        for (const other of Object.values(state.operatives)) {
          if (other.id === op.id || other.removed) continue;
          const c = ctx.datacards.get(other.datacardId);
          const oc = ctx.datacards.get(op.datacardId);
          if (!c || !oc) continue;
          const gap = Math.max(
            0,
            Math.hypot(other.pos.x - op.pos.x, other.pos.y - op.pos.y) -
              radius(c.base) -
              radius(oc.base),
          );
          if (gap > 2 + 1e-6) continue;
          const d3 = ctx.rng.d3();
          recordRoll(state, 'flail', [d3], op.player, `FLAIL vs ${other.letter}`);
          inflictDamage(ctx, state, other, d3 + 2, 'other');
          if (other.player !== op.player && d3 === 3) {
            giveToken(state, other, POISON, {
              sourceId: 'plague-marines.fighter.act.flail',
              sourceText: POISON_TEXT,
              player: op.player,
            });
          }
        }
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: FLAIL` });
        return { ok: true };
      },
    }),

    // POISONOUS MIASMA 1AP — MALIGNANT PLAGUECASTER (PSYCHIC)
    uniqueAction(data, 'plague-marines.malignant-plaguecaster', 'plague-marines.malignant-plaguecaster.act.poisonous-miasma', {
      // "Select one enemy operative visible to and within 7\" of this operative, or one enemy
      // operative that's a valid target for this operative."
      // The selection is validated HERE, not in perform: a perform failure is reverted AND
      // recorded as a rejected intent, so anything that check accepts must be performable.
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative' };
        const near =
          gapBetween(ctx, op, target) <= 7 + 1e-6 &&
          isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible;
        // The "or a valid target for this operative" limb is covered by the visibility test
        // above for every weapon this operative carries, since a valid target must be visible.
        if (!near) return { ok: false, reason: 'that operative is not visible and within 7"' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        if (hasToken(state, target.id, POISON, op.player)) {
          inflictDamage(ctx, state, target, 3, 'other');
        } else {
          giveToken(state, target, POISON, {
            sourceId: 'plague-marines.malignant-plaguecaster.act.poisonous-miasma',
            sourceText: POISON_TEXT,
            player: op.player,
          });
        }
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: POISONOUS MIASMA on ${target.letter}` });
        return { ok: true };
      },
    }),

    // PUTRESCENT VITALITY 1AP — MALIGNANT PLAGUECASTER (PSYCHIC)
    uniqueAction(data, 'plague-marines.malignant-plaguecaster', 'plague-marines.malignant-plaguecaster.act.putrescent-vitality', {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (!useOncePerTPCheck(state, `pm.vitality:${op.id}`))
          return { ok: false, reason: 'this action cannot be performed more than once per turning point' };
        if (!params.targetOperativeId) return { ok: false, reason: 'select one friendly operative within 3"' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!];
        if (!target || target.player !== op.player) return { ok: false, reason: 'select a friendly operative' };
        useOncePerTP(state, `pm.vitality:${op.id}`);
        const a = ctx.rng.d6();
        const b = ctx.rng.d6();
        recordRoll(state, 'putrescentVitality', [a, b], op.player, 'PUTRESCENT VITALITY 2D6');
        const heal = a + b === 7 ? 7 : Math.max(a, b);
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: PUTRESCENT VITALITY restores ${heal} wounds` });
        return { ok: true };
      },
    }),
  ];
}

function radius(base: { shape: 'round'; mm: number } | { shape: 'oval'; mm: [number, number] }): number {
  return base.shape === 'round' ? base.mm / 2 / 25.4 : Math.max(base.mm[0], base.mm[1]) / 2 / 25.4;
}

function useOncePerTPCheck(state: GameState, key: string): boolean {
  const b = (state.opState['teamOnce'] ?? {}) as Record<string, unknown>;
  return b[key] !== `${state.turningPoint}`;
}

/**
 * ASTARTES: "During each friendly PLAGUE MARINE operative's activation, it can perform either
 * two Shoot actions or two Fight actions. If it's two Shoot actions, a bolt pistol, boltgun or
 * PSYCHIC weapon must be selected for at least one of them. You cannot select the same PSYCHIC
 * ranged weapon more than once per activation."
 */
export const PM_ASTARTES_SHOOT = 'Shoot (Astartes, Plague Marine)';
export const PM_ASTARTES_FIGHT = 'Fight (Astartes, Plague Marine)';
const PM_LAST_RANGED = 'plagueMarines.lastRanged';

const QUALIFYING = (name: string, psychic: boolean): boolean =>
  psychic || /^(boltgun|bolt pistol)$/i.test(name);

registerAction({
  id: PM_ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'plague-marines.rule.astartes')!.text,
  available: (ctx, _s, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes('PLAGUE MARINE'),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    const card = ctx.datacards.get(op.datacardId);
    const name = params.weaponName ?? '';
    const psychicOf = (n: string): boolean =>
      Boolean(card?.weapons.find((w) => w.name === n)?.profiles.some((p) => p.rules.some((r) => r.id === 'PSYCHIC')));
    const first = String(effectOn(state, op.id, PM_LAST_RANGED)?.data?.['weapon'] ?? '');
    if (psychicOf(name) && first.toLowerCase() === name.toLowerCase())
      return { ok: false, reason: 'you cannot select the same PSYCHIC ranged weapon more than once per activation' };
    if (!QUALIFYING(first, psychicOf(first)) && !QUALIFYING(name, psychicOf(name)))
      return { ok: false, reason: 'a bolt pistol, boltgun or PSYCHIC weapon must be selected for at least one of them' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: PM_ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'plague-marines.rule.astartes')!.text,
  available: (ctx, _s, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes('PLAGUE MARINE'),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    if (op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

export const plagueMarines = defineTeam({
  id: 'plague-marines',
  rareRules: ['Poison', 'Toxic', 'PSYCHIC'],
  rules: (reg, T) => {
    rules(reg, T);
    reg.on('onCollectAttackDice', T.bind('plague-marines.rule.astartes', 13), (ev) => {
      if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, 'PLAGUE MARINE')) return;
      const existing = effectOn(ev.state, ev.ctx.attacker.id, PM_LAST_RANGED);
      if (existing) existing.data = { weapon: ev.ctx.weaponName };
      else
        effect(ev.state, {
          rule: PM_LAST_RANGED,
          source: { kind: 'core', id: 'plague-marines.rule.astartes' },
          operativeId: ev.ctx.attacker.id,
          player: T.player,
          data: { weapon: ev.ctx.weaponName },
          expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
        });
    });
  },
  ploys,
  equipment,
  actions,
  aiHints: {
    roles: {
      'plague-marines.champion': 'leader',
      'plague-marines.bombardier': 'gunner',
      'plague-marines.fighter': 'melee',
      'plague-marines.heavy-gunner': 'gunner',
      'plague-marines.icon-bearer': 'objective',
      'plague-marines.malignant-plaguecaster': 'support',
      'plague-marines.warrior': 'objective',
    },
    ployValue: {
      'plague-marines.sp.contagion': 0.6,
      'plague-marines.sp.lumbering-death': 0.6,
      'plague-marines.sp.cloud-of-flies': 0.5,
      'plague-marines.sp.nurglings': 0.5,
      'plague-marines.fp.virulent-poison': 0.6,
      'plague-marines.fp.sickening-resilience': 0.6,
      'plague-marines.fp.poisonous-demise': 0.4,
      'plague-marines.fp.curse-of-rot': 0.5,
    },
    equipmentValue: {
      'plague-marines.eq.plague-bells': 0.5,
      'plague-marines.eq.plague-rounds': 0.6,
      'plague-marines.eq.blight-grenades': 0.6,
      'plague-marines.eq.poison-vents': 0.5,
    },
  },
});

export default plagueMarines;
