/**
 * LEGIONARY — Chaos Space Marines. https://wahapedia.ru/kill-team3/kill-teams/legionary/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is read
 * from `data/teams/legionary.json`, never retyped. The five Marks of Chaos sub-rules have no id
 * of their own in the JSON, so their text is **sliced out of** the Marks of Chaos faction rule
 * at module load (see `MARK_RULE`) rather than being retyped — the same treatment the Kasrkin
 * SKILL AT ARMS menu needed.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { countCrits, fails } from '../../core/dice.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  body,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  recordRoll,
} from '../../core/state.ts';
import { isVisible } from '../../core/visibility.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  Datacard,
  GameState,
  OperativeState,
  PendingDecision,
  PlayerId,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { teamData, type TeamRuleText } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  catalogueCard,
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
  grantedWeapons,
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

const DATA = teamData('legionary');
const KW = 'LEGIONARY';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

/** The weapon table printed underneath a rule (MALEFIC BLADES' Malefic blade). */
function printedWeapon(ruleId: string, name: string): Weapon {
  const holder = [...DATA.equipment, ...DATA.strategyPloys, ...DATA.firefightPloys].find((r) => r.id === ruleId) as
    | (TeamRuleText & { weapons?: Weapon[] })
    | undefined;
  const w = holder?.weapons?.find((x) => x.name === name);
  if (!w) throw new Error(`No printed weapon '${name}' on '${ruleId}' in data/teams/legionary.json`);
  return w;
}

// ---------------------------------------------------------------------------
// Marks of Chaos (faction rule 1)
// ---------------------------------------------------------------------------

export const MARKS = ['KHORNE', 'NURGLE', 'SLAANESH', 'TZEENTCH', 'UNDIVIDED'] as const;
export type MarkOfChaos = (typeof MARKS)[number];

/**
 * The five additional rules, sliced out of the printed Marks of Chaos text (they are printed as
 * `\nKHORNE\nWrathful Onslaught\n…` blocks with no id of their own).
 */
export const MARK_RULE: Record<MarkOfChaos, string> = (() => {
  const printed = text('legionary.rule.marks-of-chaos');
  const out = {} as Record<MarkOfChaos, string>;
  MARKS.forEach((mark, i) => {
    const start = printed.indexOf(`\n${mark}\n`);
    const next = MARKS[i + 1];
    const endAt = next ? printed.indexOf(`\n${next}\n`) : -1;
    out[mark] = start < 0 ? mark : printed.slice(start + 1, endAt < 0 ? printed.length : endAt).trim();
  });
  return out;
})();

const MARK_SET: ReadonlySet<string> = new Set(MARKS);

/**
 * Which Marks of Chaos keyword an operative was given for the battle, if any.
 * Read-only: `onStatMod` reaches this from `availableActions`, i.e. outside the reducer.
 */
export function markOf(state: GameState, op: OperativeState): MarkOfChaos | undefined {
  const v = (state.opState['legionary.marks'] as Record<string, unknown> | undefined)?.[op.id];
  return typeof v === 'string' && MARK_SET.has(v) ? (v as MarkOfChaos) : undefined;
}

/**
 * "Whenever you select a LEGIONARY operative for the battle, you must select one of the
 * following keywords for it to have for that battle."
 *
 * Select Operatives has no decision channel in the engine (docs/DECISIONS.md D-017), so the
 * choice is made through this pure setter. Nothing applies until it is called — an operative
 * with no keyword simply has no additional rule. Returns false (and logs) when the printed
 * restriction refuses the pick.
 */
export function setMarkOfChaos(
  state: GameState,
  player: PlayerId,
  operativeId: string,
  mark: MarkOfChaos,
): boolean {
  const op = state.operatives[operativeId];
  if (!op || op.player !== player || op.removed) return false;
  // "…but a BALEFIRE ACOLYTE operative cannot have the KHORNE keyword."
  if (mark === 'KHORNE' && op.datacardId === 'legionary.balefire-acolyte') {
    log(state, { kind: 'system', player, text: 'a BALEFIRE ACOLYTE operative cannot have the KHORNE keyword' });
    return false;
  }
  bucket(state, 'legionary.marks')[operativeId] = mark;
  log(state, { kind: 'system', player, text: `${op.name} has the ${mark} Marks of Chaos keyword` });
  return true;
}

/** Convenience for the roster screen / tests: one keyword per operative id. */
export function setMarksOfChaos(state: GameState, player: PlayerId, marks: Record<string, MarkOfChaos>): void {
  for (const [operativeId, mark] of Object.entries(marks)) setMarkOfChaos(state, player, operativeId, mark);
}

function hasMark(T: TeamHooks, state: GameState, op: OperativeState, mark: MarkOfChaos): boolean {
  return T.mineKw(op, KW) && markOf(state, op) === mark;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/**
 * "…that performed an action in which it moved during this turning point." `actionsThisActivation`
 * survives the end of an activation (it is only cleared when the operative next activates, when it
 * counteracts, or in the Ready step), and the flag below covers the counteraction case.
 */
function movedThisTP(state: GameState, op: OperativeState): boolean {
  if (op.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a))) return true;
  return (state.opState['legionary.movedTP'] as Record<string, unknown> | undefined)?.[op.id] === state.turningPoint;
}

function d6(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d6() ?? 4;
  recordRoll(state, 'legionary', [roll], T.player, note);
  return roll;
}

function d3(T: TeamHooks, state: GameState, note: string): number {
  const roll = T.ctx?.rng.d3() ?? 2;
  recordRoll(state, 'legionary', [roll], T.player, note);
  return roll;
}

function sees(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

function engagedWith(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + 1e-6;
  return inControlRange(T.ctx, state, a, b);
}

function heal(T: TeamHooks, op: OperativeState, amount: number): number {
  const max = T.card(op)?.wounds ?? op.wounds + amount;
  const before = op.wounds;
  op.wounds = Math.min(max, op.wounds + amount);
  return op.wounds - before;
}

function profileOf(
  T: TeamHooks,
  op: OperativeState,
  weaponName: string,
  profileName?: string,
): WeaponProfile | undefined {
  const w = [...(T.card(op)?.weapons ?? []), ...grantedWeapons(op)].find((x) => x.name === weaponName);
  if (!w) return undefined;
  return w.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? w.profiles[0];
}

/** Who inflicted the damage that incapacitated `victim`, from the sequence in flight. */
function killerOf(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') return state.operatives[seq.attackerId];
  if (seq.attackerId === victim.id) return state.operatives[seq.defenderId];
  if (seq.defenderId === victim.id) return state.operatives[seq.attackerId];
  return undefined;
}

interface AttackDie {
  /** The weapon's printed Normal/Critical Dmg for this dice. */
  dmg: number;
  crit: boolean;
}

/**
 * The attack dice behind one `onDamage` event, so per-dice damage reductions ("Normal Dmg of 3
 * or more … subtract 1 from that inflicted damage") can be applied per dice rather than once.
 *
 * A fight resolves exactly one dice per strike, so its Normal/Critical nature is read back from
 * the amount against the weapon's two Dmg stats; when the two are equal the dice is treated as a
 * normal success (the numeric threshold is the same either way).
 */
function incomingAttackDice(T: TeamHooks, state: GameState, target: OperativeState, amount: number): AttackDie[] {
  const seq = state.sequence;
  if (!seq) return [];
  if (seq.kind === 'shoot') {
    if (seq.targetId !== target.id) return [];
    const attacker = state.operatives[seq.attackerId];
    const profile = attacker ? profileOf(T, attacker, seq.weaponName, seq.profileName) : undefined;
    if (!profile) return [];
    const out: AttackDie[] = [];
    for (const die of seq.attack.dice) {
      if (die.state === 'crit') out.push({ dmg: profile.dmgC, crit: true });
      else if (die.state === 'normal') out.push({ dmg: profile.dmgN, crit: false });
    }
    return out;
  }
  if (seq.attackerId !== target.id && seq.defenderId !== target.id) return [];
  const strikerId = seq.attackerId === target.id ? seq.defenderId : seq.attackerId;
  const striker = state.operatives[strikerId];
  const name = strikerId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const pname = strikerId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const profile = striker ? profileOf(T, striker, name, pname) : undefined;
  if (!profile) return [];
  const crit = profile.dmgC !== profile.dmgN && amount === profile.dmgC;
  return [{ dmg: crit ? profile.dmgC : profile.dmgN, crit }];
}

// ---------------------------------------------------------------------------
// Effect / decision keys
// ---------------------------------------------------------------------------

const UNLEASHED = 'legionary.unleashed';
const SIPHON = 'legionary.siphonLife';
const EYES = 'legionary.inTheEyesOfTheGods';
const AURA_ROLL = 'legionary.daemonicAura';
const WARDED = 'legionary.wardedArmour';
const TAINTED_ROUNDS = 'legionary.taintedRounds';
const TALISMAN_USED = 'legionary.talismanUsed';
const MALIGNANT = 'legionary.malignantAura';
const MUTABILITY = 'legionary.mutability';
const MARK_LOCKED = 'legionary.markLocked';
const TALISMAN_OFFER_KEY = 'legionary.chaosTalismans';

export const UNLEASH_DECISION = 'legionary.unleashDaemon';
export const INFERNAL_DECISION = 'legionary.infernalPact';
export const TALISMAN_DECISION = 'legionary.chaosTalismans';

const unleashed = (state: GameState, op: OperativeState): boolean =>
  state.effects.some((e) => e.rule === UNLEASHED && e.operativeId === op.id);

// ---------------------------------------------------------------------------
// Faction rules, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Marks of Chaos › KHORNE — Wrathful Onslaught ----------------------
  reg.on('onWeaponRules', T.bindText('legionary.mark.khorne', MARK_RULE.KHORNE), (ev) => {
    if (ev.type !== 'melee' || !hasMark(T, ev.state, ev.operative, 'KHORNE')) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Wrathful Onslaught)'));
  });

  // ---- Marks of Chaos › TZEENTCH — Empyreal Guidance ---------------------
  reg.on('onWeaponRules', T.bindText('legionary.mark.tzeentch', MARK_RULE.TZEENTCH), (ev) => {
    if (ev.type !== 'ranged' || !hasMark(T, ev.state, ev.operative, 'TZEENTCH')) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Empyreal Guidance)'));
  });

  // ---- Marks of Chaos › SLAANESH — Unnatural Agility ---------------------
  reg.on('onStatMod', T.bindText('legionary.mark.slaanesh', MARK_RULE.SLAANESH), (ev) => {
    if (!hasMark(T, ev.state, ev.operative, 'SLAANESH')) return;
    ev.mods.move += 1; // "Add 1" to this operative's Move stat."
  });

  // ---- Marks of Chaos › UNDIVIDED — Vicious Reavers ----------------------
  reg.on('onWeaponRules', T.bindText('legionary.mark.undivided', MARK_RULE.UNDIVIDED), (ev) => {
    if (!hasMark(T, ev.state, ev.operative, 'UNDIVIDED')) return;
    const foe = ev.target;
    if (!foe || foe.player === T.player) return; // "…against an enemy operative within 6" of it"
    if (T.gap(ev.operative, foe) > 6 + 1e-6) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Vicious Reavers)'));
  });

  // ---- Marks of Chaos › NURGLE — Disgusting Vigour -----------------------
  reg.on('onDamage', T.bindText('legionary.mark.nurgle', MARK_RULE.NURGLE, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!hasMark(T, ev.state, ev.target, 'NURGLE')) return;
    // The ANOINTED's Unleash Daemon prints the interaction cap, so it owns both reductions.
    if (unleashed(ev.state, ev.target)) return;
    let cut = 0;
    for (const die of incomingAttackDice(T, ev.state, ev.target, ev.amount)) {
      if (die.crit || die.dmg < 3) continue;
      if (d6(T, ev.state, 'Disgusting Vigour 5+') >= 5) cut += 1;
    }
    if (cut > 0) ev.amount = Math.max(0, ev.amount - cut);
  });

  // ---- Astartes › "can counteract regardless of its order" ---------------
  // `counteractCandidates` (src/core/phases.ts) now emits `onCounteract` for every expended,
  // not-yet-counteracted operative with `allowed: o.order === 'engage'` as the DEFAULT, so this
  // handler widens that default instead of only being able to narrow it. It grants — it never
  // denies — so the printed limits the core owns (expended, once per turning point, and the On
  // Guard "cannot counteract during the turning point" lockout) all keep working.
  reg.on('onCounteract', T.bind('legionary.rule.astartes', 12), (ev) => {
    // "Each friendly LEGIONARY operative can counteract regardless of its order."
    if (T.mineKw(ev.operative, KW)) ev.allowed = true;
  });

  // Remember the ranged weapon used, so the Astartes second Shoot can be validated.
  reg.on('onCollectAttackDice', T.bind('legionary.rule.astartes', 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: 'legionary.rule.astartes' },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });

  // QUICKSILVER SPEED needs "moved during this turning point" to survive a counteraction, which
  // clears `actionsThisActivation`.
  reg.on('onActivationEnd', T.bind('legionary.sp.quicksilver-speed', 14), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (ev.operative.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a)))
      bucket(ev.state, 'legionary.movedTP')[ev.operative.id] = ev.state.turningPoint;
  });

  // ---- ASPIRING CHAMPION › In the Eyes of the Gods -----------------------
  reg.on('onIncapacitated', T.bind('legionary.aspiring-champion.in-the-eyes-of-the-gods', 12), (ev) => {
    if (ev.operative.player === T.player) return; // "if it incapacitates an enemy operative"
    const champion = killerOf(ev.state, ev.operative);
    if (!champion || champion.player !== T.player) return;
    if (champion.datacardId !== 'legionary.aspiring-champion') return;
    // "Once during each of this operative's activations…"
    if (ev.state.activeOperativeId !== champion.id) return;
    if (effectOn(ev.state, champion.id, EYES)) return;
    champion.aplMods.push(1);
    effect(ev.state, {
      rule: EYES,
      source: { kind: 'ability', id: 'legionary.aspiring-champion.in-the-eyes-of-the-gods' },
      sourceText: shortQuote(abilityText('legionary.aspiring-champion', 'legionary.aspiring-champion.in-the-eyes-of-the-gods')),
      operativeId: champion.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: champion.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${champion.name}: In the Eyes of the Gods (+1 APL)` });
  });

  // ---- CHOSEN › Daemonic Aura -------------------------------------------
  // The D6 is rolled once, when an enemy operative activates within the CHOSEN's control range;
  // `canPerformAction` is consulted by the UI/AI menu many times per activation, so rolling there
  // would burn RNG outside the reducer and break replay.
  reg.on('onActivationStart', T.bind('legionary.chosen.daemonic-aura', 12), (ev) => {
    if (ev.operative.player === T.player) return;
    const chosen = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'legionary.chosen' && engagedWith(T, ev.state, o, ev.operative),
    );
    if (!chosen) return;
    const roll = d6(T, ev.state, 'Daemonic Aura 3+');
    effect(ev.state, {
      rule: AURA_ROLL,
      source: { kind: 'ability', id: 'legionary.chosen.daemonic-aura' },
      sourceText: shortQuote(abilityText('legionary.chosen', 'legionary.chosen.daemonic-aura')),
      operativeId: ev.operative.id,
      player: T.player,
      data: { roll, chosenId: chosen.id },
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
  });
  reg.on('canPerformAction', T.bind('legionary.chosen.daemonic-aura', 13), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player === T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, AURA_ROLL);
    if (!eff || eff.player !== T.player) return;
    if (Number(eff.data?.['roll'] ?? 0) < 3) return; // "on a 3+"
    const chosen = ev.state.operatives[String(eff.data?.['chosenId'] ?? '')];
    if (!chosen || chosen.removed || !engagedWith(T, ev.state, chosen, ev.operative)) return;
    ev.allowed = false;
    ev.reason = 'Daemonic Aura: it cannot perform that action during this activation';
  });

  // ---- CHOSEN › Soul Gorge ----------------------------------------------
  reg.on('onIncapacitated', T.bind('legionary.chosen.soul-gorge', 13), (ev) => {
    if (ev.operative.player === T.player || !fightSeq(ev.state)) return;
    const chosen = killerOf(ev.state, ev.operative);
    if (!chosen || chosen.player !== T.player || chosen.datacardId !== 'legionary.chosen') return;
    if (chosen.incapacitated || chosen.removed) return; // "if it isn't incapacitated"
    const gained = heal(T, chosen, d3(T, ev.state, 'SOUL GORGE D3+1') + 1);
    log(ev.state, { kind: 'action', player: T.player, text: `${chosen.name}: Soul Gorge regains ${gained} wounds` });
  });

  // ---- ANOINTED › Unleash Daemon ----------------------------------------
  // "Once per battle, when this operative is activated, you can use this rule." It costs the
  // operative every mission action for the rest of the battle, so it is a real decision
  // (docs/DECISIONS.md D-022) — declining is the first, deterministic default option.
  reg.on('onActivationStart', T.bind('legionary.anointed.unleash-daemon', 13), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== 'legionary.anointed') return;
    if (usedThisBattle(ev.state, `legionary.unleash:${T.player}`)) return;
    ev.state.pending.push({
      id: `unleash-${ev.state.seq++}`,
      who: T.player,
      kind: UNLEASH_DECISION,
      prompt: `${op.name}: use Unleash Daemon? (once per battle)`,
      sourceText: shortQuote(abilityText('legionary.anointed', 'legionary.anointed.unleash-daemon')),
      optional: true,
      ctx: { operativeId: op.id, player: T.player },
      options: [
        { id: 'no', label: 'Not yet' },
        { id: 'yes', label: 'Unleash the daemon for the rest of the battle' },
      ],
    });
  });
  reg.on('canPerformAction', T.bind('legionary.anointed.unleash-daemon', 14), (ev) => {
    if (ev.operative.player !== T.player || !unleashed(ev.state, ev.operative)) return;
    if (ev.action === 'Operate Hatch') return; // "(excluding Operate Hatch)"
    if (ev.action !== 'Pick Up Marker' && getAction(ev.action)?.type !== 'mission') return;
    ev.allowed = false;
    ev.reason = 'Unleash Daemon: it cannot perform the Pick Up Marker or mission actions';
  });
  reg.on(
    'onDamage',
    T.bindText('legionary.anointed.unleash-daemon.dmg', abilityText('legionary.anointed', 'legionary.anointed.unleash-daemon'), 12),
    (ev) => {
      if (ev.kind !== 'attack') return;
      if (ev.target.player !== T.player || !unleashed(ev.state, ev.target)) return;
      // "If this operative has the NURGLE keyword, you cannot reduce the damage of an attack dice
      //  by more than 1" — so both reductions are resolved here, per dice.
      const nurgle = hasMark(T, ev.state, ev.target, 'NURGLE');
      let cut = 0;
      for (const die of incomingAttackDice(T, ev.state, ev.target, ev.amount)) {
        if (die.dmg >= 4) {
          cut += 1;
          continue;
        }
        if (nurgle && !die.crit && die.dmg >= 3 && d6(T, ev.state, 'Disgusting Vigour 5+') >= 5) cut += 1;
      }
      if (cut > 0) ev.amount = Math.max(0, ev.amount - cut);
    },
  );
  reg.on(
    'onWeaponRules',
    T.bindText('legionary.anointed.unleash-daemon.claw', abilityText('legionary.anointed', 'legionary.anointed.unleash-daemon'), 12),
    (ev) => {
      if (ev.operative.player !== T.player || !unleashed(ev.state, ev.operative)) return;
      if (ev.weaponName !== 'Daemonic claw') return;
      ev.rules.push(
        ruleTag('Ceaseless', undefined, 'Ceaseless (Unleash Daemon)'),
        ruleTag('Lethal', 5, 'Lethal 5+ (Unleash Daemon)'),
      );
    },
  );

  // ---- BALEFIRE ACOLYTE › Siphon Life (rare weapon rule `SiphonLife`) ----
  // "When you select this weapon, you can use this rule" is free, so it is auto-used on a stated
  // policy (docs/DECISIONS.md D-022): the first SiphonLife weapon selected in a turning point
  // nominates the friendly LEGIONARY operative that has lost the most wounds; if none has lost
  // any, the rule would do nothing and is not used.
  reg.on('onCollectAttackDice', T.bind('legionary.balefire-acolyte.siphon-life', 12), (ev) => {
    const user = ev.ctx.attacker;
    if (user.player !== T.player) return;
    // A nomination lives for exactly one attack: the next attack this operative makes clears it.
    dropEffects(ev.state, (e) => e.rule === SIPHON && e.operativeId === user.id);
    if (!ev.ctx.rules.some((r) => r.id === 'SiphonLife')) return;
    if (usedThisTP(ev.state, `legionary.siphon:${T.player}`)) return; // "not more than once per turning point"
    const wounded = T.friendlies(ev.state, KW)
      .filter((o) => o.id !== user.id && !o.removed)
      .filter((o) => o.wounds < (T.card(o)?.wounds ?? o.wounds))
      .filter((o) => T.gap(user, o) <= 6 + 1e-6 && sees(T, ev.state, user, o))
      .sort((a, b) => {
        const la = (T.card(a)?.wounds ?? 0) - a.wounds;
        const lb = (T.card(b)?.wounds ?? 0) - b.wounds;
        return lb - la || (a.id < b.id ? -1 : 1);
      })[0];
    if (!wounded) return;
    useOncePerTP(ev.state, `legionary.siphon:${T.player}`);
    effect(ev.state, {
      rule: SIPHON,
      source: { kind: 'weapon', id: 'SiphonLife' },
      sourceText: shortQuote(abilityText('legionary.balefire-acolyte', 'legionary.balefire-acolyte.siphon-life')),
      operativeId: user.id,
      player: T.player,
      data: { targetId: wounded.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${user.name}: Siphon Life targets ${wounded.name}` });
  });
  reg.on('onStrikeResolved', T.bind('legionary.balefire-acolyte.siphon-life', 13), (ev) => {
    const user = ev.ctx.attacker;
    if (user.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'SiphonLife')) return;
    const eff = effectOn(ev.state, user.id, SIPHON);
    if (!eff || eff.player !== T.player) return;
    const patient = ev.state.operatives[String(eff.data?.['targetId'] ?? '')];
    if (!patient || patient.removed) return;
    const seq = shootSeq(ev.state);
    // "For each attack dice you resolve during that step that inflicts damage…"
    const critCount = seq ? seq.attack.dice.filter((d) => d.state === 'crit').length : ev.crit ? 1 : 0;
    const normalCount = seq ? seq.attack.dice.filter((d) => d.state === 'normal').length : ev.crit ? 0 : 1;
    let regained = 0;
    for (let i = 0; i < critCount; i++) regained += d3(T, ev.state, 'Siphon Life D3');
    regained += normalCount;
    if (regained <= 0) return;
    const gained = heal(T, patient, regained);
    if (gained > 0)
      log(ev.state, { kind: 'action', player: T.player, text: `Siphon Life: ${patient.name} regains ${gained} wounds` });
  });

  // ---- BUTCHER › Devastating Onslaught ----------------------------------
  // "Whenever this operative is fighting or retaliating, enemy operatives cannot assist."
  // `assistCount` is called before `state.sequence` is set, so the BUTCHER is identified by being
  // within the fighting enemy's control range.
  reg.on('onFightAssist', T.bind('legionary.butcher.devastating-onslaught', 12), (ev) => {
    if (ev.operative.player === T.player || ev.assists === 0) return;
    const butcher = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'legionary.butcher' && engagedWith(T, ev.state, o, ev.operative),
    );
    if (!butcher) return;
    ev.assists = 0;
  });
  // "…this operative can perform a free Charge action … but it cannot move more than 2"."
  // D-015: a free action is one extra AP restricted to Charge, spent on the BUTCHER's own
  // activation, so the grant is only made while it is still ready.
  reg.on('onActivationEnd', T.bind('legionary.butcher.devastating-onslaught', 13), (ev) => {
    if (ev.operative.player === T.player) return;
    for (const butcher of T.friendlies(ev.state).filter((o) => o.datacardId === 'legionary.butcher')) {
      if (!butcher.ready || effectOn(ev.state, butcher.id, FREE_ACTION_RULE)) continue;
      const near = T.enemies(ev.state).some((e) => T.gap(butcher, e) <= 2 + 1e-6);
      if (!near) continue;
      grantFreeAction(ev.state, butcher, {
        sourceId: 'legionary.butcher.devastating-onslaught',
        sourceText: shortQuote(abilityText('legionary.butcher', 'legionary.butcher.devastating-onslaught')),
        threshold: currentApl(T, ev.state, butcher),
        kind: 'ability',
        only: ['Charge'],
      });
    }
  });
  reg.on('onMoveDistance', T.bind('legionary.butcher.devastating-onslaught', 14), (ev) => {
    if (ev.action !== 'Charge' || ev.operative.player !== T.player) return;
    const free = effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE);
    if (!free || free.source.id !== 'legionary.butcher.devastating-onslaught') return;
    if (ev.operative.apSpent < Number(free.data?.['threshold'] ?? 0)) return; // still on its own AP
    ev.inches = Math.min(ev.inches, 2); // "but it cannot move more than 2""
  });
  // The granted AP is for that activation only; drop it again so it cannot accumulate.
  reg.on('onActivationEnd', T.bind('legionary.butcher.devastating-onslaught', 15), (ev) => {
    if (ev.operative.player !== T.player) return;
    const free = effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE);
    if (!free || free.source.id !== 'legionary.butcher.devastating-onslaught') return;
    const at = ev.operative.aplMods.lastIndexOf(1);
    if (at >= 0) ev.operative.aplMods.splice(at, 1);
  });

  // ---- ICON BEARER › Icon Bearer ----------------------------------------
  reg.on('onMarkerControl', T.bind('legionary.icon-bearer.icon-bearer', 12), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const bearer = T.friendlies(ev.state).find(
      (o) => o.datacardId === 'legionary.icon-bearer' && markerContestedBy(T.ctx!, ev.state, marker, o),
    );
    if (!bearer) return;
    ev.aplByPlayer[T.player] += 1; // "treat this operative's APL stat as 1 higher"
  });

  // ---- ICON BEARER › Favoured of the Dark Gods --------------------------
  reg.on('onReadyStep', T.bind('legionary.icon-bearer.favoured-of-the-dark-gods', 12), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const bearer = T.friendlies(ev.state).find((o) => o.datacardId === 'legionary.icon-bearer');
    if (!bearer) return;
    const marker = Object.values(ev.state.markers)
      .filter((m) => m.kind === 'objective' && !m.flags['legionaryTainted'])
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .find(
        (m) => markerContestedBy(T.ctx!, ev.state, m, bearer) && markerController(T.ctx!, ev.state, m) === T.player,
      );
    if (!marker) return;
    // "if any operative (including enemy operatives) has tainted an objective marker, you cannot
    //  taint that objective marker" — one shared flag, read by both players' registrations.
    marker.flags['legionaryTainted'] = T.player;
    ev.cp += 1;
    log(ev.state, { kind: 'system', player: T.player, text: `${bearer.name} taints ${marker.id} (+1CP)` });
  });

  // ---- SHRIVETALON › Vicious Reflexes ------------------------------------
  reg.on('onCollectAttackDice', T.bind('legionary.shrivetalon.vicious-reflexes', 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== 'legionary.shrivetalon') return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return; // "whenever this operative is retaliating"
    seq.turn = 'defender'; // "you resolve the first attack dice (i.e. defender instead of attacker)"
  });

  // ---- SHRIVETALON › Horrifying Dismemberment ---------------------------
  reg.on('onIncapacitated', T.bind('legionary.shrivetalon.horrifying-dismemberment', 14), (ev) => {
    const victim = ev.operative;
    if (victim.player === T.player || !fightSeq(ev.state)) return;
    const shrivetalon = killerOf(ev.state, victim);
    if (!shrivetalon || shrivetalon.player !== T.player) return;
    if (shrivetalon.datacardId !== 'legionary.shrivetalon') return;
    const near = (from: OperativeState, to: OperativeState): boolean =>
      T.gap(from, to) <= 3 + 1e-6 && sees(T, ev.state, from, to);
    const other = T.enemies(ev.state)
      .filter((e) => e.id !== victim.id && !e.incapacitated)
      .filter((e) => near(shrivetalon, e) || near(victim, e))
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!other) return;
    other.aplMods.push(-1);
    effect(ev.state, {
      rule: 'legionary.dismembered',
      source: { kind: 'ability', id: 'legionary.shrivetalon.horrifying-dismemberment' },
      sourceText: shortQuote(abilityText('legionary.shrivetalon', 'legionary.shrivetalon.horrifying-dismemberment')),
      operativeId: other.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: other.id, armed: false },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Horrifying Dismemberment: ${other.name} −1 APL` });
  });

  // ---- WARRIOR › Infernal Pact ------------------------------------------
  reg.on('onActivationStart', T.bind('legionary.warrior.infernal-pact', 14), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== 'legionary.warrior') return;
    if (usedThisBattle(ev.state, `legionary.infernalPact:${T.player}`)) return;
    // MUTABILITY AND CHANGE: "that operative's Marks of Chaos keyword cannot be changed during
    // this turning point (see Infernal Pact additional rule)".
    if (effectOn(ev.state, op.id, MARK_LOCKED)) return;
    ev.state.pending.push({
      id: `infernal-${ev.state.seq++}`,
      who: T.player,
      kind: INFERNAL_DECISION,
      prompt: `${op.name}: Infernal Pact — change its Marks of Chaos keyword? (once per battle)`,
      sourceText: shortQuote(abilityText('legionary.warrior', 'legionary.warrior.infernal-pact')),
      optional: true,
      ctx: { operativeId: op.id, player: T.player },
      options: [
        { id: 'none', label: 'Keep its current Marks of Chaos keyword' },
        ...MARKS.map((m) => ({ id: m, label: `Change to ${m}`, data: { mark: m } })),
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// The team's own decision kinds, claimed through `GameContext.decisionHandlers`
// ---------------------------------------------------------------------------

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  const payload = { ...(decision.options.find((o) => o.id === optionId)?.data ?? {}), ...(data ?? {}) };
  const player = (decision.ctx?.['player'] ?? decision.who) as PlayerId;
  const operativeId = String(decision.ctx?.['operativeId'] ?? '');

  if (decision.kind === UNLEASH_DECISION) {
    if (optionId !== 'yes') return true;
    const op = state.operatives[operativeId];
    if (!op) return true;
    useOncePerBattle(state, `legionary.unleash:${player}`);
    effect(state, {
      rule: UNLEASHED,
      source: { kind: 'ability', id: 'legionary.anointed.unleash-daemon' },
      sourceText: shortQuote(abilityText('legionary.anointed', 'legionary.anointed.unleash-daemon')),
      operativeId: op.id,
      player,
      expiry: { kind: 'endOfBattle' },
    });
    // "If it's carrying a marker, it must immediately perform the Place Marker action for 0AP
    //  (this takes precedence over all other rules)."
    if (op.carryingMarkerId) {
      const marker = state.markers[op.carryingMarkerId];
      if (marker) {
        marker.carriedBy = undefined as unknown as string | undefined;
        marker.pos = { ...op.pos };
        marker.z = op.z;
      }
      op.carryingMarkerId = undefined as unknown as string | undefined;
      log(state, { kind: 'action', player, text: `${op.name} places its marker for 0AP (Unleash Daemon)` });
    }
    log(state, { kind: 'action', player, text: `${op.name} unleashes the daemon within` });
    return true;
  }

  if (decision.kind === INFERNAL_DECISION) {
    const mark = String(payload['mark'] ?? optionId);
    if (!MARK_SET.has(mark)) return true;
    if (setMarkOfChaos(state, player, operativeId, mark as MarkOfChaos))
      useOncePerBattle(state, `legionary.infernalPact:${player}`);
    return true;
  }

  if (decision.kind === TALISMAN_DECISION) {
    if (optionId !== 'accept') return true;
    const seq = state.sequence;
    const op = state.operatives[operativeId];
    if (!op || seq?.kind !== 'shoot') return true;
    const failed = fails(seq.attack);
    if (failed.length < 2) return true;
    // "…discard one of them and retain the other as a normal success instead."
    failed[0]!.state = 'discarded';
    failed[0]!.note = 'Chaos Talismans';
    failed[1]!.state = 'normal';
    failed[1]!.note = 'Chaos Talismans';
    effect(state, {
      rule: TALISMAN_USED,
      source: { kind: 'equipment', id: 'legionary.eq.chaos-talismans' },
      operativeId: op.id,
      player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    const damage = ctx.rng.d3();
    recordRoll(state, 'legionary', [damage], player, 'CHAOS TALISMANS D3');
    // "if it's the Shoot action and that damage incapacitates that friendly operative, the action
    //  doesn't end (continue the sequence with your successful attack dice)" — the dice are
    //  already changed, and the sequence reads the attacker until the action finishes.
    inflictDamage(ctx, state, op, damage, 'other');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- IMPLACABLE (strategy, 1CP) ---------------------------------------
  reg.on('onWeaponRules', T.bind('legionary.sp.implacable', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.implacable')) return;
    if (ev.type !== 'ranged') return; // "whenever an operative is shooting a friendly LEGIONARY operative"
    if (!ev.target || !T.mineKw(ev.target, KW)) return;
    if (!ev.rules.some((r) => r.id === 'Piercing' && (r.x ?? 0) === 1)) return;
    ev.rules = ev.rules.filter((r) => !(r.id === 'Piercing' && (r.x ?? 0) === 1));
    ev.rules.push(ruleTag('PiercingCrits', 1, 'Piercing Crits 1 (Implacable)'));
  });
  reg.on('onStatMod', T.bind('legionary.sp.implacable', 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.implacable')) return;
    if (!hasMark(T, ev.state, ev.operative, 'NURGLE')) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2; // cancels the injured −2" Move
    ev.mods.hit += 1; // cancels the injured Hit worsening
  });

  // ---- QUICKSILVER SPEED (strategy, 1CP) --------------------------------
  reg.on('onStatMod', T.bind('legionary.sp.quicksilver-speed', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.quicksilver-speed')) return;
    const foe = ev.operative;
    if (foe.player === T.player) return; // it is the ENEMY operative's Hit stat that worsens
    const card = T.card(foe);
    // "In all cases for this ploy, this isn't cumulative with being injured."
    if (card && foe.wounds < card.wounds / 2) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    if (seq.kind === 'fight') {
      if (seq.defenderId !== foe.id) return; // "…a friendly LEGIONARY operative … is fighting"
      const mine = ev.state.operatives[seq.attackerId];
      if (!mine || !T.mineKw(mine, KW) || !movedThisTP(ev.state, mine)) return;
      ev.mods.hit -= 1;
      return;
    }
    if (seq.attackerId !== foe.id) return;
    const mine = ev.state.operatives[seq.targetId];
    if (!mine || !T.mineKw(mine, KW) || markOf(ev.state, mine) !== 'SLAANESH') return;
    if (!movedThisTP(ev.state, mine)) return;
    if (T.gap(foe, mine) <= 6 + 1e-6) return; // "more than 6" from it"
    ev.mods.hit -= 1;
  });

  // ---- FICKLE FATES (strategy, 1CP) -------------------------------------
  reg.on('onWeaponRules', T.bind('legionary.sp.fickle-fates', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.fickle-fates')) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    const foe = ev.target;
    if (!foe || foe.player === T.player || !foe.ready) return; // "…shooting a ready enemy operative"
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Fickle Fates)'));
  });
  reg.on('onDefenceDice', T.bind('legionary.sp.fickle-fates', 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.fickle-fates')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || !target.ready) return;
    if (markOf(ev.state, target) !== 'TZEENTCH') return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    if (countCrits(seq.defence) < 1 || fails(seq.defence).length < 1) return;
    ev.rerolls.push({
      id: 'legionary.fickleFates',
      label: 'Fickle Fates: retain one of your fails as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('legionary.sp.fickle-fates')),
    });
  });

  // ---- BLOOD FOR THE BLOOD GOD (strategy, 1CP) --------------------------
  reg.on('onDamage', T.bind('legionary.sp.blood-for-the-blood-god', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.blood-for-the-blood-god')) return;
    if (ev.kind !== 'attack') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const striker = ev.state.operatives[seq.attackerId];
    if (!striker || striker.id === ev.target.id) return; // "is fighting" — not the retaliator
    if (!T.mineKw(striker, KW) || markOf(ev.state, striker) === 'KHORNE') return;
    if (!useOncePerSequence(ev.state, `legionary.bftbg:${striker.id}`)) return;
    ev.amount = Math.min(7, ev.amount + 1); // "(to a maximum of 7)"
  });
  reg.on('onDamage', T.bind('legionary.sp.blood-for-the-blood-god', 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'legionary.sp.blood-for-the-blood-god')) return;
    if (ev.kind !== 'attack') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const strikerId = seq.attackerId === ev.target.id ? seq.defenderId : seq.defenderId === ev.target.id ? seq.attackerId : '';
    const striker = ev.state.operatives[strikerId];
    if (!striker || !T.mineKw(striker, KW) || markOf(ev.state, striker) !== 'KHORNE') return;
    ev.amount = Math.min(7, ev.amount + 1); // "Add 1 to both Dmg stats … (to a maximum of 7)"
  });

  // ---- UNENDING BLOODSHED (firefight, 1CP) ------------------------------
  // The engine has no window at "a friendly operative is incapacitated while fighting", so the
  // ploy is paid for during the fight and pays out the moment the KHORNE operative goes down —
  // inside `inflictDamage`, i.e. before it is removed from the killzone.
  reg.on('onIncapacitated', T.bind('legionary.fp.unending-bloodshed', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'legionary.fp.unending-bloodshed')) return;
    const dying = ev.operative;
    if (!T.mineKw(dying, KW) || markOf(ev.state, dying) !== 'KHORNE') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === dying.id ? 'attacker' : seq.defenderId === dying.id ? 'defender' : undefined;
    if (!side || !T.ctx) return;
    if (!useOncePerBattle(ev.state, `legionary.unending:${T.player}:${ev.state.turningPoint}`)) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const die = pool.dice.find((d) => d.state === 'crit') ?? pool.dice.find((d) => d.state === 'normal');
    if (!die) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    const name = side === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
    const pname = side === 'attacker' ? seq.attackerProfile : seq.defenderProfile;
    const profile = profileOf(T, dying, name, pname);
    if (!foe || !profile) return;
    const crit = die.state === 'crit';
    die.state = 'struck';
    die.note = 'Unending Bloodshed';
    inflictDamage(T.ctx, ev.state, foe, crit ? profile.dmgC : profile.dmgN, 'attack');
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Unending Bloodshed: ${dying.name} strikes ${foe.name} before being removed`,
    });
  });

  // ---- MALIGNANT AURA (firefight, 1CP) ----------------------------------
  reg.on('onPloyUsed', T.bind('legionary.fp.malignant-aura', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'legionary.fp.malignant-aura') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const nurgle = T.friendlies(ev.state, KW).filter((o) => markOf(ev.state, o) === 'NURGLE');
    const op = active && nurgle.some((o) => o.id === active.id) ? active : chosenOperative(ev.state, ev.data, nurgle);
    if (!op) return;
    effect(ev.state, {
      rule: MALIGNANT,
      source: { kind: 'ploy', id: 'legionary.fp.malignant-aura' },
      sourceText: shortQuote(text('legionary.fp.malignant-aura')),
      operativeId: op.id,
      player: T.player,
      // "Until the end of that action" — the engine has no end-of-action expiry that fires, so
      // the grant is bounded to that operative's activation instead.
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind('legionary.fp.malignant-aura', 21), (ev) => {
    if (ev.type !== 'ranged') return;
    const eff = effectOn(ev.state, ev.operative.id, MALIGNANT);
    if (!eff || eff.player !== T.player) return;
    const foe = ev.target;
    // "…shooting an enemy operative within 3" of it (i.e. including secondary targets, if any)"
    if (!foe || foe.player === T.player || T.gap(ev.operative, foe) > 3 + 1e-6) return;
    ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (Malignant Aura)'));
  });

  // ---- SICKENING CAPTIVATION (firefight, 1CP) ---------------------------
  reg.on('onPloyUsed', T.bind('legionary.fp.sickening-captivation', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'legionary.fp.sickening-captivation') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const slaanesh = T.friendlies(ev.state, KW).filter((o) => markOf(ev.state, o) === 'SLAANESH');
    const op = active && slaanesh.some((o) => o.id === active.id) ? active : slaanesh[0];
    if (!op) return;
    // "Select one enemy operative visible to and within 4" of that friendly operative."
    const candidates = T.enemies(ev.state).filter((e) => T.gap(op, e) <= 4 + 1e-6 && sees(T, ev.state, op, e));
    const victim = chosenOperative(ev.state, ev.data, candidates);
    if (!victim) return;
    victim.aplMods.push(-1);
    effect(ev.state, {
      rule: 'legionary.sickeningCaptivation',
      source: { kind: 'ploy', id: 'legionary.fp.sickening-captivation' },
      sourceText: shortQuote(text('legionary.fp.sickening-captivation')),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Sickening Captivation: ${victim.name} −1 APL` });
  });

  // ---- MUTABILITY AND CHANGE (firefight, 1CP) ---------------------------
  reg.on('onPloyUsed', T.bind('legionary.fp.mutability-and-change', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'legionary.fp.mutability-and-change') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const tzeentch = T.friendlies(ev.state, KW).filter((o) => markOf(ev.state, o) === 'TZEENTCH');
    const op = active && tzeentch.some((o) => o.id === active.id) ? active : chosenOperative(ev.state, ev.data, tzeentch);
    if (!op) return;
    op.aplMods.push(1); // "add 1 to its APL stat"
    effect(ev.state, {
      rule: MUTABILITY,
      source: { kind: 'ploy', id: 'legionary.fp.mutability-and-change' },
      sourceText: shortQuote(text('legionary.fp.mutability-and-change')),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    // "If it's a WARRIOR operative, that operative's Marks of Chaos keyword cannot be changed
    //  during this turning point (see Infernal Pact additional rule)."
    if (T.kw(op, 'WARRIOR'))
      effect(ev.state, {
        rule: MARK_LOCKED,
        source: { kind: 'ploy', id: 'legionary.fp.mutability-and-change' },
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Mutability and Change: ${op.name} +1 APL` });
  });
  reg.on('canPerformAction', T.bind('legionary.fp.mutability-and-change', 21), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, MUTABILITY)) return;
    // "…but it cannot perform the same action more than once during that activation", which
    // switches off the Astartes second Shoot / second Fight.
    if (ev.action !== ASTARTES_SHOOT && ev.action !== ASTARTES_FIGHT) return;
    ev.allowed = false;
    ev.reason = 'Mutability and Change: it cannot perform the same action more than once';
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/** "Malefic blade — ATK 5, HIT 3+, DMG 3/4" (legionary.json › equipment). */
const MALEFIC_BLADE: Weapon = printedWeapon('legionary.eq.malefic-blades', 'Malefic blade');

const WARDED_GAMBIT = 'legionary.eq.warded-armour';
const TALISMAN_GAMBIT = 'legionary.eq.chaos-talismans';
export const talismanGambitId = (mark: MarkOfChaos): string => `${TALISMAN_GAMBIT}:${mark}`;

/** The Marks of Chaos keyword CHAOS TALISMANS names this turning point, if any. */
export function talismanMark(state: GameState, player: PlayerId): MarkOfChaos | undefined {
  const used = gambitsWithPrefix(state, player, `${TALISMAN_GAMBIT}:`)[0];
  if (!used) return undefined;
  const mark = used.slice(TALISMAN_GAMBIT.length + 1);
  return MARK_SET.has(mark) ? (mark as MarkOfChaos) : undefined;
}

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- WARDED ARMOUR (STRATEGIC GAMBIT) ---------------------------------
  reg.on('gambitOptions', T.bind(WARDED_GAMBIT, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, WARDED_GAMBIT)) return;
    if (T.friendlies(ev.state, KW).length === 0) return;
    ev.options.push({ id: WARDED_GAMBIT, label: 'WARDED ARMOUR', sourceText: shortQuote(text(WARDED_GAMBIT)) });
  });
  reg.on('onPloyUsed', T.bind(WARDED_GAMBIT, 30), (ev) => {
    if (ev.player !== T.player || ev.ployId !== WARDED_GAMBIT) return;
    const op = chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW));
    if (!op) return;
    effect(ev.state, {
      rule: WARDED,
      source: { kind: 'equipment', id: WARDED_GAMBIT },
      sourceText: shortQuote(text(WARDED_GAMBIT)),
      operativeId: op.id,
      player: T.player,
      // "Until the Ready step of the next Strategy phase" — nothing happens between the end of
      // this turning point and that step, so the effect expires at the end of the turning point.
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Warded Armour: ${op.name} has a 2+ Save` });
  });
  reg.on('onStatMod', T.bind(WARDED_GAMBIT, 31), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, WARDED);
    if (!eff || eff.player !== T.player) return;
    const card = T.card(ev.operative);
    if (!card) return;
    ev.mods.save += card.save - 2; // "change that operative's Save stat to 2+"
  });

  // ---- MALEFIC BLADES ---------------------------------------------------
  const giveBlades = (state: GameState): void => {
    if (!hasEquipment(state, T.player, 'legionary.eq.malefic-blades')) return;
    for (const o of T.friendlies(state, KW)) grantWeapon(o, structuredClone(MALEFIC_BLADE));
  };
  reg.on('onDeploy', T.bind('legionary.eq.malefic-blades', 30), (ev) => {
    if (ev.operative.player === T.player) giveBlades(ev.state);
  });
  reg.on('onActivationStart', T.bind('legionary.eq.malefic-blades', 31), (ev) => {
    if (ev.operative.player === T.player) giveBlades(ev.state);
  });

  // ---- TAINTED ROUNDS ---------------------------------------------------
  // "…you can use this rule" is free, so it is auto-used on the first bolt pistol / boltgun Shoot
  // action of each turning point (docs/DECISIONS.md D-022).
  reg.on('onSelectWeapon', T.bind('legionary.eq.tainted-rounds', 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    if (!hasEquipment(ev.state, T.player, 'legionary.eq.tainted-rounds')) return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    if (!/^(bolt pistol|boltgun)$/i.test(ev.ctx.weaponName)) return;
    if (!useOncePerTP(ev.state, `legionary.taintedRounds:${T.player}`)) return;
    effect(ev.state, {
      rule: TAINTED_ROUNDS,
      source: { kind: 'equipment', id: 'legionary.eq.tainted-rounds' },
      sourceText: shortQuote(text('legionary.eq.tainted-rounds')),
      operativeId: op.id,
      player: T.player,
      data: { weapon: ev.ctx.weaponName },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `${op.name}: Tainted Rounds (Rending)` });
  });
  reg.on('onWeaponRules', T.bind('legionary.eq.tainted-rounds', 31), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, TAINTED_ROUNDS);
    if (!eff || eff.player !== T.player) return;
    if (String(eff.data?.['weapon'] ?? '').toLowerCase() !== ev.weaponName.toLowerCase()) return;
    ev.rules.push(ruleTag('Rending', undefined, 'Rending (Tainted Rounds)'));
  });

  // ---- CHAOS TALISMANS (STRATEGIC GAMBIT) -------------------------------
  for (const mark of MARKS) {
    reg.on('gambitOptions', T.bind(TALISMAN_GAMBIT, 30), (ev) => {
      if (ev.player !== T.player || !hasEquipment(ev.state, T.player, TALISMAN_GAMBIT)) return;
      if (talismanMark(ev.state, T.player)) return; // "Select one Marks of Chaos keyword"
      ev.options.push({
        id: talismanGambitId(mark),
        label: `CHAOS TALISMANS: ${mark}`,
        sourceText: shortQuote(text(TALISMAN_GAMBIT)),
      });
    });
  }
  reg.on('onRollAttack', T.bind(TALISMAN_GAMBIT, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, TALISMAN_GAMBIT)) return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    const mark = talismanMark(ev.state, T.player);
    if (!mark || markOf(ev.state, op) !== mark) return;
    // Only the Shoot sequence emits `onRollAttack`; `fight.ts` builds its re-roll grants without
    // a hook, so "fighting or retaliating" is out of reach (reported as a needed seam).
    const seq = shootSeq(ev.state);
    if (!seq) return;
    if (seq.usedRerolls.includes(TALISMAN_OFFER_KEY)) return;
    if (effectOn(ev.state, op.id, TALISMAN_USED)) return; // "Once during each of their activations"
    if (fails(seq.attack).length < 2) return; // "if you roll two or more fails"
    seq.usedRerolls.push(TALISMAN_OFFER_KEY);
    ev.state.pending.push({
      id: `talisman-${ev.state.seq++}`,
      who: T.player,
      kind: TALISMAN_DECISION,
      prompt: `${op.name}: inflict D3 damage on it to turn one fail into a normal success?`,
      sourceText: shortQuote(text(TALISMAN_GAMBIT)),
      optional: true,
      ctx: { operativeId: op.id, player: T.player },
      options: [
        { id: 'decline', label: 'Keep the dice as rolled' },
        { id: 'accept', label: 'Inflict D3 damage on it and retain one fail as a normal success' },
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

export const GRISLY_MARKER = (player: PlayerId): string => `legionary.grisly.${player}`;

function actions(data: typeof DATA) {
  return [
    // GRISLY MARK 2AP — SHRIVETALON
    uniqueAction(data, 'legionary.shrivetalon', 'legionary.shrivetalon.act.grisly-mark', {
      // D-026: the whole legality lives here, because `src/ai/legal.ts` only re-runs `check`.
      check: (ctx, state, op) => {
        // "…cannot perform it while within control range of an enemy operative."
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        // "This operative cannot perform this action more than once per battle."
        if (usedThisBattle(state, `legionary.grisly:${op.id}`))
          return { ok: false, reason: 'this operative has already placed its Grisly marker this battle' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        useOncePerBattle(state, `legionary.grisly:${op.id}`);
        placeTeamMarker(state, {
          id: GRISLY_MARKER(op.player),
          kind: 'generic',
          player: op.player,
          pos: { ...op.pos },
          z: op.z,
          flags: { grisly: true },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: GRISLY MARK placed` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Astartes — the second Shoot / second Fight action
// ---------------------------------------------------------------------------

/**
 * "During each friendly LEGIONARY operative's activation, it can perform either two Shoot actions
 * or two Fight actions. If it's two Shoot actions, a bolt pistol, boltgun or tainted bolt pistol
 * must be selected for at least one of them."
 *
 * Action restrictions forbid repeating an action, so the second one is its own `ActionDef` that
 * resolves through the universal action (D-021).
 */
export const ASTARTES_SHOOT = 'Shoot (Astartes, Legionary)';
export const ASTARTES_FIGHT = 'Fight (Astartes, Legionary)';
const LAST_RANGED = 'legionary.lastRanged';

const BOLT_WEAPON = (name: string): boolean => /^(bolt pistol|boltgun|tainted bolt pistol)$/i.test(name.trim());
const isLegionary = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);

registerAction({
  id: ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'legionary.rule.astartes')!.text,
  available: (ctx, _state, op) => isLegionary(ctx, op),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    const second = params.weaponName ?? '';
    if (!BOLT_WEAPON(first) && !BOLT_WEAPON(second))
      return { ok: false, reason: 'a bolt pistol, boltgun or tainted bolt pistol must be selected for at least one of them' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Shoot')!.perform(ctx, state, op, params),
});

registerAction({
  id: ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'legionary.rule.astartes')!.text,
  available: (ctx, _state, op) => isLegionary(ctx, op),
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
// "You cannot use this ploy…" — the printed windows each firefight ploy names
// ---------------------------------------------------------------------------

function hasMarked(state: GameState, player: PlayerId, mark: MarkOfChaos): boolean {
  return Object.values(state.operatives).some(
    (o) =>
      o.player === player &&
      !o.removed &&
      (catalogueCard(o.datacardId)?.keywords ?? []).includes(KW) &&
      markOf(state, o) === mark,
  );
}

const needsMark =
  (mark: MarkOfChaos) =>
  (state: GameState, player: PlayerId): { ok: boolean; reason?: string } =>
    hasMarked(state, player, mark)
      ? { ok: true }
      : { ok: false, reason: `no friendly LEGIONARY ${mark} operative is in the killzone` };

// ---------------------------------------------------------------------------

export const legionary = defineTeam({
  id: 'legionary',
  rules: (reg, T) => {
    rules(reg, T);
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    'legionary.fp.unending-bloodshed': needsMark('KHORNE'),
    'legionary.fp.malignant-aura': needsMark('NURGLE'),
    'legionary.fp.sickening-captivation': needsMark('SLAANESH'),
    'legionary.fp.mutability-and-change': needsMark('TZEENTCH'),
  },
  aiHints: {
    roles: {
      'legionary.aspiring-champion': 'leader',
      'legionary.chosen': 'leader',
      'legionary.anointed': 'melee',
      'legionary.balefire-acolyte': 'support',
      'legionary.butcher': 'melee',
      'legionary.gunner': 'gunner',
      'legionary.heavy-gunner': 'gunner',
      'legionary.icon-bearer': 'objective',
      'legionary.shrivetalon': 'melee',
      'legionary.warrior': 'objective',
    },
    ployValue: {
      'legionary.sp.implacable': 0.5,
      'legionary.sp.quicksilver-speed': 0.5,
      'legionary.sp.fickle-fates': 0.6,
      'legionary.sp.blood-for-the-blood-god': 0.7,
      'legionary.fp.unending-bloodshed': 0.3,
      'legionary.fp.malignant-aura': 0.5,
      'legionary.fp.sickening-captivation': 0.5,
      'legionary.fp.mutability-and-change': 0.6,
    },
    equipmentValue: {
      'legionary.eq.warded-armour': 0.5,
      'legionary.eq.malefic-blades': 0.6,
      'legionary.eq.tainted-rounds': 0.5,
      'legionary.eq.chaos-talismans': 0.4,
    },
  },
});

export default legionary;
