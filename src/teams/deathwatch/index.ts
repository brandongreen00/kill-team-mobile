/**
 * DEATHWATCH — Adeptus Astartes. https://wahapedia.ru/kill-team3/kill-teams/deathwatch/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/deathwatch.json`, never retyped.
 *
 * Shape notes
 *  - Veteran Astartes' "two Shoot actions or two Fight actions" is two extra `ActionDef`s
 *    (action restrictions forbid repeating one) — docs/DECISIONS.md D-021, the same pattern
 *    the Angels of Death use for ASTARTES.
 *  - Special Issue Ammunition is a player CHOICE made in the Select Weapon step, and the
 *    engine has no decision channel there, so it is a `Shoot (Special Issue Ammunition)`
 *    action whose `params.choice` names the ammunition (and an optional `choice` on the
 *    second, Veteran Astartes Shoot). Its whole legality lives in `check` (D-026).
 *  - Phase Sweep chains free Fight actions "taking precedence over action restrictions", so
 *    each link is its own `ActionDef` (`Fight (Phase Sweep)` … `4`) that delegates to the
 *    universal Fight and refuses an enemy this operative has already swept this activation.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { baseWhollyWithin } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import { body, inflictDamage, isInjured, log, recordRoll } from '../../core/state.ts';
import { isVisible } from '../../core/visibility.ts';
import type {
  ActiveEffect,
  BaseShape,
  Datacard,
  GameState,
  OperativeState,
  PlayerId,
  WeaponProfile,
  WeaponRule,
  WeaponRuleId,
} from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  aplOf,
  bucket,
  catalogueCard,
  chosenOperative,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  enemiesInControlRange,
  gambitUsed,
  hasEquipment,
  otherPlayer,
  ployUsed,
  ruleTag,
  shortQuote,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('deathwatch');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

const KW = 'DEATHWATCH';

const WATCH_SERGEANT = 'deathwatch.watch-sergeant';
const AEGIS = 'deathwatch.aegis-veteran';
const BLADEMASTER = 'deathwatch.blademaster-veteran';
const DEMOLISHER = 'deathwatch.demolisher-veteran';
const DISRUPTOR = 'deathwatch.disruptor-veteran';
const HEADTAKER = 'deathwatch.headtaker-veteran';
const MARKSMAN = 'deathwatch.marksman-veteran';

const RULE_VETERAN_ASTARTES = 'deathwatch.rule.veteran-astartes';
const RULE_SPECIAL_ISSUE = 'deathwatch.rule.special-issue-ammunition';
const EQ_DIGITAL = 'deathwatch.eq.digital-weapons';
const EQ_CUFFS = 'deathwatch.eq.sanctus-v-bioscryer-cuffs';
const EQ_SERVO_THRALL = 'deathwatch.eq.scrutavore-servo-thrall';
const EQ_AMMO_RESERVE = 'deathwatch.eq.ammunition-reserve';
const FP_AUSPEX_SCAN = 'deathwatch.fp.advanced-auspex-scan';

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);

const isDeathwatch = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);

function baseOf(T: TeamHooks, op: OperativeState): BaseShape {
  return T.card(op)?.base ?? { shape: 'round', mm: 32 };
}

/** "wholly within your territory" / "wholly within your opponent's territory". */
function whollyInTerritory(T: TeamHooks, state: GameState, op: OperativeState, player: PlayerId): boolean {
  return baseWhollyWithin(op.pos, baseOf(T, op), op.rot, state.map.territories[player]);
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/** The weapon profile currently inflicting damage (the striking side, in a fight). */
function damageProfile(T: TeamHooks, state: GameState): WeaponProfile | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') {
    const holder = state.operatives[seq.attackerId];
    const w = holder ? T.card(holder)?.weapons.find((x) => x.name === seq.weaponName) : undefined;
    return w?.profiles.find((p) => (p.name ?? '') === (seq.profileName ?? '')) ?? w?.profiles[0];
  }
  if (seq.kind !== 'fight') return undefined;
  const strikerId = seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
  const holder = state.operatives[strikerId];
  const name = strikerId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const w = holder ? T.card(holder)?.weapons.find((x) => x.name === name) : undefined;
  const pn = strikerId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  return w?.profiles.find((p) => (p.name ?? '') === (pn ?? '')) ?? w?.profiles[0];
}

// ---------------------------------------------------------------------------
// Special Issue Ammunition — the six ammunition types
// ---------------------------------------------------------------------------

/**
 * The six ammunition types are a menu of sub-options printed inside the Special Issue
 * Ammunition faction rule with no ids of their own, so they are PARSED out of that rule's
 * text rather than retyped (CLAUDE.md: rules as data). Only the keyword → `WeaponRuleId`
 * mapping is code.
 */
const AMMO_RULE_ID: Record<string, WeaponRuleId> = {
  Blast: 'Blast',
  Devastating: 'Devastating',
  Lethal: 'Lethal',
  'Piercing Crits': 'PiercingCrits',
  Saturate: 'Saturate',
  Severe: 'Severe',
};

export interface AmmoOption {
  /** Slug of the printed keyword: 'blast', 'devastating', 'lethal', 'piercing-crits', … */
  id: string;
  /** The printed token, e.g. `Blast 1"`. */
  label: string;
  /** The whole printed line, including any parenthetical restriction. */
  text: string;
  rule: WeaponRule;
}

function parseAmmoOptions(): AmmoOption[] {
  const out: AmmoOption[] = [];
  for (const line of text(RULE_SPECIAL_ISSUE).split(/\n+/)) {
    const para = line.trim();
    const m = /^(Piercing Crits|Blast|Devastating|Lethal|Saturate|Severe)(?:\s+(\d+))?/.exec(para);
    if (!m) continue;
    const keyword = m[1]!;
    const x = m[2] !== undefined ? Number(m[2]) : undefined;
    const label = para.split('(')[0]!.trim();
    out.push({
      id: keyword.toLowerCase().replace(/\s+/g, '-'),
      label,
      text: para,
      rule: ruleTag(AMMO_RULE_ID[keyword]!, x, label),
    });
  }
  return out;
}

export const AMMO: AmmoOption[] = parseAmmoOptions();
export const ammoOption = (id: string | undefined): AmmoOption | undefined => AMMO.find((a) => a.id === id);

/** The effect that carries the chosen ammunition for one Shoot action. */
const AMMO_EFFECT = 'deathwatch.specialIssueAmmo';
/** The last ranged weapon this operative used, so the second Shoot can be priced. */
const LAST_RANGED = 'deathwatch.lastRanged';

interface AmmoLedger {
  tp: number;
  choices: string[];
  /** The turning point in which AMMUNITION RESERVE bought the second use. */
  reserveTp?: number;
}

/** Pure read — a `check` must never change game state (`src/core/actions.ts` › ActionDef). */
function readLedger(state: GameState, player: PlayerId): AmmoLedger {
  const b = (state.opState['deathwatch.ammo'] ?? {}) as Record<string, AmmoLedger | undefined>;
  const cur = b[player];
  if (cur && cur.tp === state.turningPoint) return cur;
  return {
    tp: state.turningPoint,
    choices: [],
    ...(cur?.reserveTp !== undefined ? { reserveTp: cur.reserveTp } : {}),
  };
}

function writeLedger(state: GameState, player: PlayerId, ledger: AmmoLedger): void {
  const b = bucket(state, 'deathwatch.ammo') as Record<string, AmmoLedger | undefined>;
  b[player] = ledger;
}

/** "This rule cannot be used with explosive grenades (see universal equipment) or melta bombs." */
const AMMO_BANNED_WEAPON = /melta bomb|frag grenade|krak grenade/i;

/**
 * Whole legality of using Special Issue Ammunition for this Shoot action (D-026: a `check`
 * that accepts must be performable). Pure — it never touches the ledger.
 */
function ammoCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string } {
  const option = ammoOption(params.choice);
  if (!option) return { ok: false, reason: `select one of ${AMMO.map((a) => a.label).join(', ')}` };
  if (AMMO_BANNED_WEAPON.test(params.weaponName ?? ''))
    return { ok: false, reason: 'this rule cannot be used with explosive grenades or melta bombs' };
  // "Blast 1" (you cannot select this if the weapon profile being used has the Torrent weapon rule)"
  if (option.id === 'blast') {
    const w = (ctx.datacards.get(op.datacardId)?.weapons ?? []).find((x) => x.name === params.weaponName);
    const profile = w?.profiles.find((p) => (p.name ?? '') === (params.profileName ?? '')) ?? w?.profiles[0];
    if (profile?.rules.some((r) => r.id === 'Torrent'))
      return { ok: false, reason: 'you cannot select Blast if the weapon profile being used has the Torrent weapon rule' };
  }
  const ledger = readLedger(state, op.player);
  if (ledger.choices.length === 0) return { ok: true };
  // AMMUNITION RESERVE: "Once per battle, you can use the Special Issue Ammunition faction rule
  // for up to two Shoot actions during one turning point, but you must select different weapon
  // rules for both uses."
  if (ledger.choices.length >= 2)
    return { ok: false, reason: 'Special Issue Ammunition has already been used twice this turning point' };
  if (!hasEquipment(state, op.player, EQ_AMMO_RESERVE))
    return { ok: false, reason: 'Special Issue Ammunition is once per turning point' };
  if (ledger.reserveTp !== undefined && ledger.reserveTp !== state.turningPoint)
    return { ok: false, reason: 'the Ammunition Reserve has already been used this battle' };
  if (ledger.choices.includes(option.id))
    return { ok: false, reason: 'you must select different weapon rules for both uses' };
  return { ok: true };
}

/** Spend the use and arm the ammunition for the Shoot action that is about to start. */
function ammoApply(state: GameState, op: OperativeState, choice: string): void {
  const option = ammoOption(choice)!;
  const ledger = readLedger(state, op.player);
  if (ledger.choices.length === 1) ledger.reserveTp = state.turningPoint;
  writeLedger(state, op.player, { ...ledger, choices: [...ledger.choices, option.id] });
  dropEffects(state, (e) => e.rule === AMMO_EFFECT && e.operativeId === op.id);
  effect(state, {
    rule: AMMO_EFFECT,
    source: { kind: 'ability', id: RULE_SPECIAL_ISSUE },
    sourceText: option.text,
    operativeId: op.id,
    player: op.player,
    data: { ammo: option.id, phase: 'pending' },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter}: Special Issue Ammunition — ${option.label}`,
    data: { operativeId: op.id, ammo: option.id },
  });
}

/**
 * Is the ammunition live right now? "…until the end of the action".
 *
 * `phase: 'pending'` covers the Select Weapon / Select Valid Target steps, which run before
 * `state.sequence` exists; once `onSelectWeapon` has armed it, it only applies while THIS
 * operative's shoot sequence is in flight, so it can never leak into a later Shoot action.
 */
function liveAmmo(state: GameState, op: OperativeState): AmmoOption | undefined {
  const eff = effectOn(state, op.id, AMMO_EFFECT);
  if (!eff) return undefined;
  const phase = String(eff.data?.['phase'] ?? 'pending');
  if (phase === 'pending') return ammoOption(String(eff.data?.['ammo'] ?? ''));
  const seq = shootSeq(state);
  if (!seq || seq.attackerId !== op.id) return undefined;
  return ammoOption(String(eff.data?.['ammo'] ?? ''));
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

/** MISSION TACTICS records the chosen order as a per-player effect. */
const MISSION_TACTICS = 'deathwatch.missionTactics';
/** ADVANCED AUSPEX SCAN lasts "until the end of the activation/counteraction". */
const AUSPEX_SCAN = 'deathwatch.auspexScan';
/** ADVANCED OMNI-SCRAMBLER's lock on one enemy operative. */
const SCRAMBLED = 'deathwatch.scrambled';
/** Enemy operatives the HEADTAKER was not visible to at the start of its activation. */
const UNSEEN_BY = 'deathwatch.unseenBy';
/** Enemy operatives the BLADEMASTER has already swept this activation/counteraction. */
const SWEPT = 'deathwatch.phaseSweepFought';

export const OMNI_SCRAMBLER_GAMBIT = 'deathwatch.disruptor-veteran.advanced-omni-scrambler';

/** The weapon/profile the rare `PhaseSweep` rule is printed on, read from the datacard. */
function phaseSweepProfile(): { weapon: string; profile: string } {
  for (const w of cardOf(BLADEMASTER).weapons)
    for (const p of w.profiles) if (p.rules.some((r) => r.id === 'PhaseSweep')) return { weapon: w.name, profile: p.name ?? '' };
  return { weapon: '', profile: '' };
}
export const PHASE_SWEEP = phaseSweepProfile();

function sweptIds(state: GameState, op: OperativeState): string[] {
  const eff = effectOn(state, op.id, SWEPT);
  return (eff?.data?.['fought'] as string[] | undefined) ?? [];
}

function recordSweep(state: GameState, op: OperativeState, enemyId: string): void {
  const eff = effectOn(state, op.id, SWEPT);
  if (eff) {
    const fought = (eff.data?.['fought'] as string[] | undefined) ?? [];
    if (!fought.includes(enemyId)) eff.data = { fought: [...fought, enemyId] };
    return;
  }
  effect(state, {
    rule: SWEPT,
    source: { kind: 'ability', id: 'deathwatch.blademaster-veteran.phase-sweep' },
    sourceText: shortQuote(abilityText(BLADEMASTER, 'deathwatch.blademaster-veteran.phase-sweep')),
    operativeId: op.id,
    player: op.player,
    data: { fought: [enemyId] },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
}

/** Is this operative fighting/retaliating with the xenophase blade right now? */
function usingXenophase(state: GameState, op: OperativeState): boolean {
  const seq = fightSeq(state);
  if (!seq) return false;
  if (seq.attackerId === op.id) return seq.attackerWeapon === PHASE_SWEEP.weapon;
  if (seq.defenderId === op.id) return (seq.defenderWeapon ?? '') === PHASE_SWEEP.weapon;
  return false;
}

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Veteran Astartes ---------------------------------------------------
  // "…it can perform either two Shoot actions or two Fight actions" is the pair of extra
  // actions registered at the bottom of this module; this remembers the first Shoot's weapon
  // so the second one can be priced ("1 additional AP must be spent for the second action").
  reg.on('onCollectAttackDice', T.bind(RULE_VETERAN_ASTARTES, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const existing = effectOn(ev.state, ev.ctx.attacker.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: RULE_VETERAN_ASTARTES },
        operativeId: ev.ctx.attacker.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
      });
  });
  // "Each friendly DEATHWATCH operative can counteract regardless of its order."
  // `counteractCandidates` now emits `onCounteract` for every expended, not-yet-counteracted
  // operative with `allowed: o.order === 'engage'` as the DEFAULT, so this WIDENS eligibility
  // to a Conceal order. It is the only condition the clause lifts: expended, "once during the
  // turning point" (`counteractedThisTP`) and the On Guard lockout ("that friendly operative
  // cannot counteract during the turning point", `guardSpentTP`) are filtered by the core
  // outside this hook and are deliberately left alone. Scoped to the printed keyword, so an
  // allied non-DEATHWATCH operative — and every enemy — keeps the printed Engage default.
  reg.on('onCounteract', T.bind(RULE_VETERAN_ASTARTES, 13), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    ev.allowed = true;
  });

  // ---- Special Issue Ammunition -------------------------------------------
  // "…select one of the following weapon rules for that operative's ranged weapons to have
  //  until the end of the action."
  reg.on('onWeaponRules', T.bind(RULE_SPECIAL_ISSUE, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    const ammo = liveAmmo(ev.state, ev.operative);
    if (!ammo) return;
    ev.rules.push(ammo.rule);
  });
  // The Select Weapon step is the only moment the engine tells a rule that a NEW shot is
  // starting, so it is where the ammunition is armed and where a stale one is dropped.
  reg.on('onSelectWeapon', T.bind(RULE_SPECIAL_ISSUE, 12), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (see onSelectWeapon)
    const shooter = ev.ctx.attacker;
    if (shooter.player !== T.player) return;
    const eff = effectOn(ev.state, shooter.id, AMMO_EFFECT);
    if (!eff) return;
    if (String(eff.data?.['phase'] ?? 'pending') === 'pending') eff.data = { ...eff.data, phase: 'active' };
    else dropEffects(ev.state, (e) => e === eff);
  });

  // ---- WATCH SERGEANT › Strategic Command ---------------------------------
  // "You can do each of the following once per battle if this operative is in the killzone:
  //  Use a DEATHWATCH strategy ploy for 0CP. Use a DEATHWATCH firefight ploy for 0CP."
  // CP is deducted before `onPloyUsed` fires, so the discount is a refund.
  reg.on('onPloyUsed', T.bind('deathwatch.watch-sergeant.strategic-command', 12), (ev) => {
    if (ev.player !== T.player) return;
    const ploy = [...DATA.strategyPloys, ...DATA.firefightPloys].find((p) => p.id === ev.ployId);
    if (!ploy) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === WATCH_SERGEANT)) return;
    if (!useOncePerBattle(ev.state, `deathwatch.strategicCommand:${T.player}:${ev.kind}`)) return;
    ev.state.teams[T.player].cp += ploy.cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Strategic Command: ${ploy.name} costs 0CP` });
  });

  // ---- AEGIS › Shield (rare weapon rule) ----------------------------------
  reg.on('onBlockAllocation', T.bind('deathwatch.aegis-veteran.shield', 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Shield')) return;
    ev.blocks = 2; // "each of your blocks can be allocated to block two unresolved successes"
  });

  // ---- AEGIS › Storm Shield ----------------------------------------------
  // "Whenever an operative is shooting this operative, worsen the x of the Piercing weapon
  //  rule by 1 (if any). Note that Piercing 1 would therefore be ignored."
  reg.on('onWeaponRules', T.bind('deathwatch.aegis-veteran.storm-shield', 12), (ev) => {
    if (ev.type !== 'ranged') return;
    const target = ev.target;
    if (!target || target.datacardId !== AEGIS || target.player !== T.player) return;
    ev.rules = ev.rules.flatMap((r) => {
      if (r.id !== 'Piercing') return [r];
      const x = (r.x ?? 1) - 1;
      return x > 0 ? [ruleTag('Piercing', x, `Piercing ${x} (Storm Shield)`)] : [];
    });
  });

  // ---- BLADEMASTER › Adaptive Swordsmanship -------------------------------
  // "You can ignore any changes to the Hit stat of this operative's xenophase blade."
  // Priority 40 so it runs after every other onStatMod handler (And They Shall Know No Fear).
  reg.on('onStatMod', T.bind('deathwatch.blademaster-veteran.adaptive-swordsmanship', 40), (ev) => {
    const op = ev.operative;
    if (op.datacardId !== BLADEMASTER || op.player !== T.player) return;
    if (!usingXenophase(ev.state, op)) return;
    const injuredFix = T.ctx && isInjured(T.ctx, op) ? 1 : 0; // cancels the injured Hit worsening
    ev.mods.hit = Math.max(ev.mods.hit, injuredFix, 0);
  });
  // "Whenever this operative is fighting or retaliating, you can resolve one of your successes
  //  before the normal order." — the retaliating BLADEMASTER resolves first.
  reg.on('onCollectAttackDice', T.bind('deathwatch.blademaster-veteran.adaptive-swordsmanship', 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.datacardId !== BLADEMASTER || op.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== op.id) return;
    seq.turn = 'defender';
  });

  // ---- BLADEMASTER › Phase Sweep (rare weapon rule) -----------------------
  // "…it can only fight against each enemy operative within its control range once per
  //  activation or counteraction using this weapon profile."
  reg.on('onCollectAttackDice', T.bind('deathwatch.blademaster-veteran.phase-sweep', 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.datacardId !== BLADEMASTER || op.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== op.id) return;
    if ((seq.attackerProfile ?? '') !== PHASE_SWEEP.profile) return;
    recordSweep(ev.state, op, seq.defenderId);
  });
  // The chained free Fight actions are 0AP; `onActionCost` is the only seam that survives a
  // counteraction's "must be a 1AP action" gate, so they are printed 1AP and discounted here.
  reg.on('onActionCost', T.bind('deathwatch.blademaster-veteran.phase-sweep', 13), (ev) => {
    if (!PHASE_SWEEP_ACTIONS.includes(ev.action)) return;
    if (ev.operative.datacardId !== BLADEMASTER || ev.operative.player !== T.player) return;
    ev.ap = 0; // "it can immediately perform a free Fight action afterwards"
  });

  // ---- DEMOLISHER › Brutal Assault ---------------------------------------
  reg.on('onWeaponRules', T.bind('deathwatch.demolisher-veteran.brutal-assault', 12), (ev) => {
    if (ev.type !== 'melee') return;
    if (ev.operative.datacardId !== DEMOLISHER || ev.operative.player !== T.player) return;
    if (!/heavy thunder hammer/i.test(ev.weaponName)) return;
    // "Whenever this operative is FIGHTING, its heavy thunder hammer has the Brutal weapon rule."
    if (!ev.retaliating) ev.rules.push(ruleTag('Brutal', undefined, 'Brutal (Brutal Assault)'));
    // "Whenever this operative performs the Charge action, … the Ceaseless weapon rule until
    //  the end of the activation/counteraction."
    if (ev.operative.actionsThisActivation.includes('Charge'))
      ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Brutal Assault)'));
  });

  // ---- DEMOLISHER › Aggressive Force -------------------------------------
  // "Whenever this operative is fighting or retaliating, Normal and Critical Dmg of 3 or more
  //  inflicts 1 less damage on it."
  reg.on('onDamage', T.bind('deathwatch.demolisher-veteran.aggressive-force', 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.datacardId !== DEMOLISHER || ev.target.player !== T.player) return;
    if (!fightSeq(ev.state)) return;
    if (ev.amount < 3) return;
    ev.amount -= 1;
  });

  // ---- DISRUPTOR › Advanced Omni-Scrambler --------------------------------
  reg.on('gambitOptions', T.bind(OMNI_SCRAMBLER_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (scramblerTargets(T, ev.state).length === 0) return;
    ev.options.push({
      id: OMNI_SCRAMBLER_GAMBIT,
      label: 'Advanced Omni-Scrambler',
      sourceText: shortQuote(abilityText(DISRUPTOR, OMNI_SCRAMBLER_GAMBIT)),
    });
  });
  reg.on('onPloyUsed', T.bind(OMNI_SCRAMBLER_GAMBIT, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== OMNI_SCRAMBLER_GAMBIT) return;
    const candidates = scramblerTargets(T, ev.state);
    const enemy = chosenOperative(ev.state, ev.data, candidates);
    if (!enemy || !T.ctx) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'omniScrambler', [roll], T.player, 'ADVANCED OMNI-SCRAMBLER D6');
    effect(ev.state, {
      rule: SCRAMBLED,
      source: { kind: 'ability', id: OMNI_SCRAMBLER_GAMBIT },
      sourceText: shortQuote(abilityText(DISRUPTOR, OMNI_SCRAMBLER_GAMBIT)),
      operativeId: enemy.id,
      player: T.player,
      data: { roll },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Advanced Omni-Scrambler: ${enemy.letter} is jammed until ${roll} enemy operatives have activated`,
    });
  });
  // "…that enemy operative cannot be activated or perform actions until one of the following
  //  is true: Your opponent has activated a number of enemy operatives equal to the result of
  //  the D6. It's the last enemy operative to be activated."
  reg.on('canPerformAction', T.bind(OMNI_SCRAMBLER_GAMBIT, 16), (ev) => {
    if (ev.operative.player === T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, SCRAMBLED);
    if (!eff || eff.player !== T.player) return;
    if (scramblerReleased(T, ev.state, ev.operative, eff)) return;
    ev.allowed = false;
    ev.reason = 'Advanced Omni-Scrambler: this operative cannot perform actions yet';
  });

  // ---- DISRUPTOR › Auspex Triangulation -----------------------------------
  // "The Advanced Auspex Scan firefight ploy costs you 0CP when both of the following are
  //  true: This operative isn't within control range of enemy operatives. The target of that
  //  Shoot action (primary target, if relevant) is visible to this operative."
  // Priority 22 so it runs after the ploy's own handler has created the effect.
  reg.on('onPloyUsed', T.bind('deathwatch.disruptor-veteran.auspex-triangulation', 22), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_AUSPEX_SCAN) return;
    const disruptor = T.friendlies(ev.state).find((o) => o.datacardId === DISRUPTOR);
    if (!disruptor || !triangulationReady(T, ev.state, disruptor)) return;
    const targetId = (ev.data?.['targetId'] as string | undefined) ?? shootSeq(ev.state)?.targetId;
    const target = targetId ? ev.state.operatives[targetId] : undefined;
    if (!target || !visibleTo(T, ev.state, disruptor, target)) return;
    const eff = ev.state.effects.find((e) => e.rule === AUSPEX_SCAN && e.player === T.player);
    if (eff) eff.data = { ...eff.data, triangulated: true };
    const ploy = DATA.firefightPloys.find((p) => p.id === FP_AUSPEX_SCAN)!;
    ev.state.teams[T.player].cp += ploy.cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Auspex Triangulation: Advanced Auspex Scan costs 0CP' });
  });

  // ---- HEADTAKER › Clandestine Headtaker ----------------------------------
  // "…an operative it wasn't visible to at the start of the activation/counteraction."
  reg.on('onActivationStart', T.bind('deathwatch.headtaker-veteran.clandestine-headtaker', 12), (ev) => {
    if (ev.operative.datacardId !== HEADTAKER || ev.operative.player !== T.player) return;
    recordUnseen(T, ev.state, ev.operative);
  });
  reg.on('onCounteract', T.bind('deathwatch.headtaker-veteran.clandestine-headtaker', 12), (ev) => {
    if (ev.operative.datacardId !== HEADTAKER || ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, UNSEEN_BY)) return;
    recordUnseen(T, ev.state, ev.operative);
  });
  // "…the first time you strike during that sequence, you can immediately resolve another of
  //  your successes as a strike (before your opponent)."
  reg.on('onStrikeResolved', T.bind('deathwatch.headtaker-veteran.clandestine-headtaker', 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const headtaker = ev.ctx.attacker;
    if (headtaker.datacardId !== HEADTAKER || headtaker.player !== T.player) return;
    if (seq.attackerId !== headtaker.id) return; // "whenever this operative is FIGHTING against"
    const unseen = (effectOn(ev.state, headtaker.id, UNSEEN_BY)?.data?.['ids'] as string[] | undefined) ?? [];
    if (!unseen.includes(seq.defenderId)) return;
    const victim = ev.state.operatives[seq.defenderId];
    if (!victim || victim.incapacitated || victim.removed || !T.ctx) return;
    if (!useOncePerSequence(ev.state, `deathwatch.clandestine:${headtaker.id}`)) return;
    const die = seq.attackerPool.dice.find((d) => d.state === 'crit' || d.state === 'normal');
    if (!die) return;
    const crit = die.state === 'crit';
    die.state = 'struck';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Clandestine Headtaker: ${headtaker.letter} resolves another success as a strike`,
    });
    inflictDamage(T.ctx, ev.state, victim, crit ? ev.ctx.profile.dmgC : ev.ctx.profile.dmgN, 'attack');
  });

  // ---- MARKSMAN › Vigilant Marksman ---------------------------------------
  // "When using the close quarters rules, once per turning point, after this operative performs
  //  a free Shoot action on guard, it can immediately perform a free Guard action."
  reg.on('onStrikeResolved', T.bind('deathwatch.marksman-veteran.vigilant-marksman', 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const op = ev.ctx.attacker;
    if (op.datacardId !== MARKSMAN || op.player !== T.player) return;
    if (!ev.state.map.closeQuarters) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.free || seq.attackerId !== op.id) return; // the On Guard interrupt shot
    if (!useOncePerTP(ev.state, `deathwatch.vigilantMarksman:${op.id}`)) return;
    op.onGuard = true; // "it can immediately perform a free Guard action"
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter} goes back on Guard (Vigilant Marksman)` });
  });
  // Restore the Guard the reducer cleared after `Guard (Vigilant Marksman)` (see that action).
  reg.on('onActivationEnd', T.bind('deathwatch.marksman-veteran.vigilant-marksman', 13), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, VIGILANT_GUARD_EFFECT);
    if (!eff || eff.player !== T.player) return;
    if (ev.operative.actionsThisActivation.length !== Number(eff.data?.['actionsAt'] ?? 0) + 1) return;
    ev.operative.onGuard = true;
  });
}

/** "Select one enemy operative visible to or within 6" of this operative." */
function scramblerTargets(T: TeamHooks, state: GameState): OperativeState[] {
  const disruptor = T.friendlies(state).find((o) => o.datacardId === DISRUPTOR);
  if (!disruptor) return [];
  return T.enemies(state)
    .filter((e) => T.gap(disruptor, e) <= 6 + 1e-6 || visibleTo(T, state, disruptor, e))
    .sort(byId);
}

function scramblerReleased(T: TeamHooks, state: GameState, op: OperativeState, eff: ActiveEffect): boolean {
  const roll = Number(eff.data?.['roll'] ?? 0);
  // "Your opponent has activated a number of enemy operatives equal to the result of the D6."
  const activated = T.enemies(state).filter((o) => o.expended).length;
  if (activated >= roll) return true;
  // "It's the last enemy operative to be activated."
  return T.enemies(state).filter((o) => o.ready).length <= 1 && op.ready;
}

/** "This operative isn't within control range of enemy operatives." */
function triangulationReady(T: TeamHooks, state: GameState, disruptor: OperativeState): boolean {
  return T.enemies(state).every((e) => T.gap(disruptor, e) > 1 + 1e-6);
}

function recordUnseen(T: TeamHooks, state: GameState, headtaker: OperativeState): void {
  const ids = T.enemies(state)
    .filter((e) => !visibleTo(T, state, e, headtaker))
    .map((e) => e.id);
  dropEffects(state, (e) => e.rule === UNSEEN_BY && e.operativeId === headtaker.id);
  effect(state, {
    rule: UNSEEN_BY,
    source: { kind: 'ability', id: 'deathwatch.headtaker-veteran.clandestine-headtaker' },
    sourceText: shortQuote(abilityText(HEADTAKER, 'deathwatch.headtaker-veteran.clandestine-headtaker')),
    operativeId: headtaker.id,
    player: headtaker.player,
    data: { ids },
    expiry: { kind: 'endOfActivation', operativeId: headtaker.id },
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- MISSION TACTICS (strategy) -----------------------------------------
  // "Select Conceal or Engage." The engine has no decision channel in the Gambit step, so the
  // order comes from the intent's data with a deterministic, logged default (D-016).
  reg.on('onPloyUsed', T.bind('deathwatch.sp.mission-tactics', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'deathwatch.sp.mission-tactics') return;
    const asked = ev.data?.['order'];
    const order = asked === 'conceal' || asked === 'engage' ? asked : majorityOrder(T, ev.state);
    effect(ev.state, {
      rule: MISSION_TACTICS,
      source: { kind: 'ploy', id: 'deathwatch.sp.mission-tactics' },
      sourceText: shortQuote(text('deathwatch.sp.mission-tactics')),
      player: T.player,
      data: { order },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Mission Tactics: ${order}` });
  });
  reg.on('onWeaponRules', T.bind('deathwatch.sp.mission-tactics', 21), (ev) => {
    const eff = ev.state.effects.find((e) => e.rule === MISSION_TACTICS && e.player === T.player);
    if (!eff || !T.mineKw(ev.operative, KW)) return;
    // "shooting against or fighting against" — a retaliation is neither.
    if (ev.type === 'melee' && ev.retaliating) return;
    if (!ev.target || ev.target.order !== eff.data?.['order']) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Mission Tactics)'));
  });

  // ---- THE SHIELD THAT SLAYS (strategy) -----------------------------------
  // "Whenever a friendly DEATHWATCH operative is wholly within your opponent's territory,
  //  Normal Dmg of 4 or more inflicts 1 less damage on it."
  reg.on('onDamage', T.bind('deathwatch.sp.the-shield-that-slays', 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, 'deathwatch.sp.the-shield-that-slays')) return;
    if (!T.mineKw(ev.target, KW)) return;
    // Aggressive Force: "This isn't cumulative with the Shield that Slays strategy ploy." In a
    // fight, any Normal Dmg of 4 or more is also 3 or more, so Aggressive Force always covers it.
    if (ev.target.datacardId === DEMOLISHER && fightSeq(ev.state)) return;
    const profile = damageProfile(T, ev.state);
    if (!profile || profile.dmgN < 4) return;
    if (!whollyInTerritory(T, ev.state, ev.target, otherPlayer(T.player))) return;
    const seq = ev.state.sequence;
    let reduction = 1;
    if (seq?.kind === 'shoot') {
      reduction = seq.attack.dice.filter((d) => d.state === 'normal').length;
      if (reduction === 0) return;
    } else if (ev.amount !== profile.dmgN) {
      return; // in a fight, only a NORMAL success strike is Normal Dmg
    }
    ev.amount = Math.max(0, ev.amount - reduction);
  });

  // ---- THE LONG VIGIL (strategy) ------------------------------------------
  reg.on('onDefenceDice', T.bind('deathwatch.sp.the-long-vigil', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'deathwatch.sp.the-long-vigil')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!whollyInTerritory(T, ev.state, target, T.player)) return;
    ev.rerolls.push({
      id: 'deathwatch.theLongVigil',
      label: 'The Long Vigil: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('deathwatch.sp.the-long-vigil')),
    });
  });

  // ---- AND THEY SHALL KNOW NO FEAR (strategy) -----------------------------
  // "You can ignore any changes to the stats of friendly DEATHWATCH operatives from being
  //  injured (including their weapons' stats)."
  reg.on('onStatMod', T.bind('deathwatch.sp.and-they-shall-know-no-fear', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'deathwatch.sp.and-they-shall-know-no-fear')) return;
    if (!T.mineKw(ev.operative, KW)) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2; // cancels the injured −2" Move
    ev.mods.hit += 1; // cancels the injured Hit worsening
  });

  // ---- SUFFER NOT THE ALIEN (firefight) -----------------------------------
  reg.on('onRollAttack', T.bind('deathwatch.fp.suffer-not-the-alien', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'deathwatch.fp.suffer-not-the-alien')) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    // "an operative that doesn't have the CHAOS or IMPERIUM keyword"
    if (!target || T.kw(target, 'CHAOS') || T.kw(target, 'IMPERIUM')) return;
    ev.rerolls.push({
      id: 'deathwatch.sufferNotTheAlien',
      label: 'Suffer Not the Alien: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text('deathwatch.fp.suffer-not-the-alien')),
    });
  });

  // ---- ADVANCED AUSPEX SCAN (firefight) -----------------------------------
  reg.on('onPloyUsed', T.bind(FP_AUSPEX_SCAN, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_AUSPEX_SCAN) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = chosenOperative(ev.state, ev.data, active && T.mineKw(active, KW) ? [active] : T.friendlies(ev.state, KW));
    if (!op) return;
    effect(ev.state, {
      rule: AUSPEX_SCAN,
      source: { kind: 'ploy', id: FP_AUSPEX_SCAN },
      sourceText: shortQuote(text(FP_AUSPEX_SCAN)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind(FP_AUSPEX_SCAN, 21), (ev) => {
    if (ev.type !== 'ranged') return;
    if (!auspexScanApplies(T, ev.state, ev.operative, ev.target)) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Advanced Auspex Scan)'));
  });
  reg.on('onCollectAttackDice', T.bind(FP_AUSPEX_SCAN, 21), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    if (!auspexScanApplies(T, ev.state, ev.ctx.attacker, ev.ctx.defender)) return;
    seq.obscured = false; // "enemy operatives cannot be obscured"
  });

  // ---- AUSPICATOR TRACKING (firefight) ------------------------------------
  // "Use this firefight ploy when a friendly DEATHWATCH operative is counteracting, before it
  //  performs any actions. You can change its order."
  reg.on('onPloyUsed', T.bind('deathwatch.fp.auspicator-tracking', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'deathwatch.fp.auspicator-tracking') return;
    const id = (ev.state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId;
    const op = id ? ev.state.operatives[id] : undefined;
    if (!op || op.player !== T.player) return;
    const asked = ev.data?.['order'];
    op.order = asked === 'conceal' || asked === 'engage' ? asked : op.order === 'engage' ? 'conceal' : 'engage';
    log(ev.state, { kind: 'ploy', player: T.player, text: `Auspicator Tracking: ${op.letter} → ${op.order}` });
  });

  // ---- TRANSHUMAN PHYSIOLOGY (firefight) ----------------------------------
  // "…in the Roll Defence Dice step. You can retain one of your normal successes as a critical
  //  success instead."
  reg.on('onDefenceDice', T.bind('deathwatch.fp.transhuman-physiology', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'deathwatch.fp.transhuman-physiology')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const normal = seq.defence.dice.find((d) => d.state === 'normal');
    if (!normal) return;
    if (!useOncePerTP(ev.state, `deathwatch.transhuman:${T.player}`)) return;
    normal.state = 'crit';
    normal.note = 'Transhuman Physiology';
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Transhuman Physiology: a normal success becomes critical' });
  });
}

/** "Until the end of the activation/counteraction, its ranged weapons have Saturate…" */
function auspexScanApplies(
  T: TeamHooks,
  state: GameState,
  shooter: OperativeState,
  target: OperativeState | undefined,
): boolean {
  const eff = effectOn(state, shooter.id, AUSPEX_SCAN);
  if (!eff || eff.player !== T.player) return false;
  if (!eff.data?.['triangulated']) return true;
  // AUSPEX TRIANGULATION: "any subsequent Shoot actions during that activation/counteraction
  // must meet these same requirements (or that ploy has no effect on those Shoot actions)."
  const disruptor = T.friendlies(state).find((o) => o.datacardId === DISRUPTOR);
  if (!disruptor || !triangulationReady(T, state, disruptor)) return false;
  return Boolean(target && visibleTo(T, state, disruptor, target));
}

/** A deterministic default for MISSION TACTICS: the order most enemy operatives have. */
function majorityOrder(T: TeamHooks, state: GameState): 'conceal' | 'engage' {
  const enemies = T.enemies(state);
  const conceal = enemies.filter((o) => o.order === 'conceal').length;
  return conceal > enemies.length - conceal ? 'conceal' : 'engage';
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- DIGITAL WEAPONS ----------------------------------------------------
  // "Once per turning point, when a friendly DEATHWATCH operative performs the Fight action,
  //  at the start of the Roll Attack Dice step … inflict 1 damage on the enemy operative in
  //  that sequence."
  reg.on('onCollectAttackDice', T.bind(EQ_DIGITAL, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_DIGITAL)) return;
    if (ev.ctx.type !== 'melee' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return; // the operative performing Fight
    const victim = ev.state.operatives[seq.defenderId];
    if (!victim || victim.removed || victim.incapacitated || !T.ctx) return;
    if (!useOncePerTP(ev.state, `deathwatch.digitalWeapons:${T.player}`)) return;
    log(ev.state, { kind: 'action', player: T.player, text: `Digital Weapons: 1 damage to ${victim.letter}` });
    inflictDamage(T.ctx, ev.state, victim, 1, 'other');
  });

  // ---- SCRUTAVORE SERVO-THRALL -------------------------------------------
  // "Once per turning point, during a friendly DEATHWATCH operative's activation … that
  //  operative can perform a mission action for 1 less AP."
  reg.on('onActionCost', T.bind(EQ_SERVO_THRALL, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_SERVO_THRALL)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (getAction(ev.action)?.type !== 'mission') return;
    if (usedThisTP(ev.state, `deathwatch.servoThrall:${T.player}`)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  reg.on('onActivationEnd', T.bind(EQ_SERVO_THRALL, 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_SERVO_THRALL)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ev.operative.actionsThisActivation.some((a) => getAction(a)?.type === 'mission')) return;
    useOncePerTP(ev.state, `deathwatch.servoThrall:${T.player}`);
  });

  // SANCTUS-V BIOSCRYER CUFFS is the `Bioscryer Cuffs` action registered below; AMMUNITION
  // RESERVE is read by `ammoCheck` (it is a change to the Special Issue Ammunition allowance).
}

// ---------------------------------------------------------------------------
// Veteran Astartes: the second Shoot / Fight action
// ---------------------------------------------------------------------------

/**
 * "If it's two Shoot actions and an auxiliary grenade launcher, frag cannon, heavy plasma
 * incinerator, infernus heavy bolter, plasma pistol or stalker bolt rifle is selected for
 * both, or if a melta bomb is selected for either, 1 additional AP must be spent for the
 * second action." Matched by weapon name, exactly as printed.
 */
const SURCHARGE_WEAPONS = [
  'auxiliary grenade launcher',
  'frag cannon',
  'heavy plasma incinerator',
  'infernus heavy bolter',
  'plasma pistol',
  'stalker bolt rifle',
];
const MELTA_BOMB = 'melta bomb';

export const VETERAN_SHOOT = 'Shoot (Veteran Astartes)';
export const VETERAN_FIGHT = 'Fight (Veteran Astartes)';
export const SIA_SHOOT = 'Shoot (Special Issue Ammunition)';

export function veteranSurcharge(state: GameState, op: OperativeState, second: string): number {
  const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '').toLowerCase();
  const next = second.toLowerCase();
  if (first === MELTA_BOMB || next === MELTA_BOMB) return 1;
  return SURCHARGE_WEAPONS.includes(first) && SURCHARGE_WEAPONS.includes(next) ? 1 : 0;
}

registerAction({
  id: VETERAN_SHOOT,
  name: 'Shoot (Veteran Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text(RULE_VETERAN_ASTARTES),
  available: (ctx, _state, op) => isDeathwatch(ctx, op),
  check(ctx, state, op, params) {
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Veteran Astartes is the second Shoot action of an activation' };
    const extra = veteranSurcharge(state, op, params.weaponName ?? '');
    if (op.apSpent + 1 + extra > aplOf(ctx, state, op))
      return { ok: false, reason: '1 additional AP must be spent for the second Shoot action' };
    if (params.choice !== undefined) {
      const ammo = ammoCheck(ctx, state, op, params);
      if (!ammo.ok) return ammo;
    }
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    op.apSpent += veteranSurcharge(state, op, params.weaponName ?? '');
    if (params.choice !== undefined) ammoApply(state, op, params.choice);
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

registerAction({
  id: VETERAN_FIGHT,
  name: 'Fight (Veteran Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: text(RULE_VETERAN_ASTARTES),
  available: (ctx, _state, op) => isDeathwatch(ctx, op),
  check(ctx, state, op, params) {
    if (op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Veteran Astartes is the second Fight action of an activation' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

/**
 * Special Issue Ammunition is used "in the Select Weapon step" of a Shoot action, which the
 * engine offers no decision channel for, so the choice rides on the action's own params.
 * `treatedAs: 'Shoot'` keeps it the operative's FIRST Shoot; the second one takes an optional
 * `choice` on `Shoot (Veteran Astartes)` above.
 */
registerAction({
  id: SIA_SHOOT,
  name: 'Shoot (Special Issue Ammunition)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: text(RULE_SPECIAL_ISSUE),
  available: (ctx, _state, op) => isDeathwatch(ctx, op),
  check(ctx, state, op, params) {
    const ammo = ammoCheck(ctx, state, op, params);
    if (!ammo.ok) return ammo;
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    ammoApply(state, op, params.choice!);
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

// ---------------------------------------------------------------------------
// Phase Sweep: the chain of free Fight actions
// ---------------------------------------------------------------------------

/**
 * "…you can continue to perform free Fight actions until this operative is incapacitated or
 * has fought against every enemy operative within its control range. This takes precedence
 * over action restrictions."
 *
 * Action restrictions are keyed on the action id and the reducer records one per action, so
 * each link of the chain is its own id. Four links is more enemy operatives than can fit
 * inside a 32mm base's control range at once.
 */
export const PHASE_SWEEP_ACTIONS = [
  'Fight (Phase Sweep)',
  'Fight (Phase Sweep 2)',
  'Fight (Phase Sweep 3)',
  'Fight (Phase Sweep 4)',
];

function phaseSweepTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const fought = sweptIds(state, op);
  const candidates = enemiesInControlRange(ctx, state, op)
    .filter((e) => !fought.includes(e.id))
    .sort(byId);
  return candidates.find((e) => e.id === params.targetId) ?? candidates[0];
}

PHASE_SWEEP_ACTIONS.forEach((id, link) => {
  registerAction({
    id,
    name: id,
    ap: 1, // discounted to 0AP by the `onActionCost` handler above ("a free Fight action")
    type: 'unique',
    sourceText: abilityText(BLADEMASTER, 'deathwatch.blademaster-veteran.phase-sweep'),
    available: (_ctx, _state, op) => op.datacardId === BLADEMASTER,
    check(ctx, state, op, params) {
      if (op.incapacitated || op.removed) return { ok: false, reason: 'this operative is incapacitated' };
      const fought = sweptIds(state, op);
      if (fought.length !== link + 1)
        return { ok: false, reason: `Phase Sweep chains after ${link + 1} Fight action(s) with that weapon profile` };
      const target = phaseSweepTarget(ctx, state, op, params);
      if (!target)
        return { ok: false, reason: 'it has already fought against every enemy operative within its control range' };
      return getAction('Fight')!.check(ctx, state, op, sweepParams(params, target));
    },
    perform(ctx, state, op, params) {
      const target = phaseSweepTarget(ctx, state, op, params);
      if (!target) return { ok: false, reason: 'no enemy operative left to sweep' };
      return getAction('Fight')!.perform(ctx, state, op, sweepParams(params, target));
    },
  });
});

/** "…but you must select this weapon profile." */
function sweepParams(params: ActionParams, target: OperativeState): ActionParams {
  return {
    ...params,
    meleeWeaponName: PHASE_SWEEP.weapon,
    meleeProfileName: PHASE_SWEEP.profile,
    targetId: target.id,
  };
}

// ---------------------------------------------------------------------------
// Clandestine Headtaker: Charge with a Conceal order
// ---------------------------------------------------------------------------

/**
 * "This operative can perform the Charge action while it has a Conceal order." The universal
 * Charge refuses a Conceal order outright and `canPerformAction` can only forbid, never
 * permit, so the carve-out is its own action resolving through the universal Charge
 * (`treatedAs: 'Charge'`, docs/DECISIONS.md D-021).
 */
export const HEADTAKER_CHARGE = 'Charge (Clandestine Headtaker)';

registerAction({
  id: HEADTAKER_CHARGE,
  name: 'Charge (Clandestine Headtaker)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(HEADTAKER, 'deathwatch.headtaker-veteran.clandestine-headtaker'),
  available: (_ctx, _state, op) => op.datacardId === HEADTAKER,
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'already within control range of an enemy operative' };
    if (['Reposition', 'Dash', 'Fall Back'].some((a) => op.actionsThisActivation.includes(a)))
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const engage: OperativeState = { ...op, order: 'engage' };
    return getAction('Charge')!.check(ctx, state, engage, params);
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// Vigilant Marksman: Guard outside a close quarters killzone
// ---------------------------------------------------------------------------

/**
 * "This operative can perform the Guard action during its activation regardless of the
 * killzone." The universal Guard is gated on `map.closeQuarters` in both `available` and
 * `check`, so the permission is its own action (`treatedAs: 'Shoot'`, exactly as Guard is).
 */
export const VIGILANT_GUARD = 'Guard (Vigilant Marksman)';

registerAction({
  id: VIGILANT_GUARD,
  name: 'Guard (Vigilant Marksman)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(MARKSMAN, 'deathwatch.marksman-veteran.vigilant-marksman'),
  // Only offered where the universal Guard is not: in close quarters the operative already
  // has it, and offering both would be two ids for one action.
  available: (_ctx, state, op) => op.datacardId === MARKSMAN && !state.map.closeQuarters,
  check(ctx, state, op) {
    // "…during its ACTIVATION"; the core rules also forbid Guard as a counteraction.
    if ((state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId === op.id)
      return { ok: false, reason: 'a counteraction cannot be the Guard action' };
    if (op.order === 'conceal') return { ok: false, reason: 'cannot go on Guard with a Conceal order' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    op.onGuard = true;
    // ENGINE GAP: the reducer clears `onGuard` after ANY action whose id is not literally
    // 'Guard' (`src/core/reducer.ts` › PerformAction), so the flag is re-applied at the end of
    // the activation — unless the operative went on to do something else, which ends Guard
    // anyway ("It performs any action, moves or is set up").
    effect(state, {
      rule: VIGILANT_GUARD_EFFECT,
      source: { kind: 'ability', id: 'deathwatch.marksman-veteran.vigilant-marksman' },
      sourceText: shortQuote(abilityText(MARKSMAN, 'deathwatch.marksman-veteran.vigilant-marksman')),
      operativeId: op.id,
      player: op.player,
      data: { actionsAt: op.actionsThisActivation.length },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(state, { kind: 'action', player: op.player, text: `${op.letter} goes on Guard (Vigilant Marksman)` });
    return { ok: true };
  },
});

export const VIGILANT_GUARD_EFFECT = 'deathwatch.vigilantGuard';

// ---------------------------------------------------------------------------
// SANCTUS-V BIOSCRYER CUFFS
// ---------------------------------------------------------------------------

export const CUFFS_ACTION = 'Bioscryer Cuffs';
/** "Neutron Fragment, Poison, Terrorchem" — team token effects are namespaced per team. */
const CUFF_TOKENS = /neutron|poison|terrorchem/i;

const cuffToken = (state: GameState, op: OperativeState): ActiveEffect | undefined =>
  state.effects.find((e) => e.operativeId === op.id && CUFF_TOKENS.test(e.rule));

registerAction({
  id: CUFFS_ACTION,
  name: 'Sanctus-V Bioscryer Cuffs',
  ap: 0,
  type: 'unique',
  sourceText: text(EQ_CUFFS),
  available: (ctx, state, op) => isDeathwatch(ctx, op) && hasEquipment(state, op.player, EQ_CUFFS),
  check(ctx, state, op, params) {
    // "…if it's not within control range of enemy operatives"
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    const choice = params.choice;
    if (choice !== undefined && !['wounds', 'apl', 'token'].includes(choice))
      return { ok: false, reason: 'select wounds, apl or token' };
    const wounded = op.wounds < (ctx.datacards.get(op.datacardId)?.wounds ?? op.wounds);
    const hasToken = cuffToken(state, op) !== undefined;
    if (choice === 'wounds' && !wounded) return { ok: false, reason: 'this operative has not lost any wounds' };
    if (choice === 'apl' && op.aplMods.length === 0) return { ok: false, reason: 'its APL stat has not been changed' };
    if (choice === 'token' && !hasToken) return { ok: false, reason: 'it has no Neutron Fragment, Poison or Terrorchem token' };
    if (!wounded && op.aplMods.length === 0 && !hasToken)
      return { ok: false, reason: 'there is nothing for the cuffs to purge' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const wounded = op.wounds < (ctx.datacards.get(op.datacardId)?.wounds ?? op.wounds);
    const token = cuffToken(state, op);
    const choice = params.choice ?? (wounded ? 'wounds' : op.aplMods.length > 0 ? 'apl' : 'token');
    if (choice === 'wounds') {
      const heal = ctx.rng.d3(); // "regains up to D3 lost wounds"
      recordRoll(state, 'bioscryerCuffs', [heal], op.player, 'SANCTUS-V BIOSCRYER CUFFS D3');
      const max = ctx.datacards.get(op.datacardId)?.wounds ?? op.wounds + heal;
      op.wounds = Math.min(max, op.wounds + heal);
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: Bioscryer Cuffs restore ${heal} wounds` });
    } else if (choice === 'apl') {
      op.aplMods = []; // "Remove any changes to that friendly operative's APL stat."
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: Bioscryer Cuffs clear its APL changes` });
    } else if (token) {
      dropEffects(state, (e) => e === token);
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: Bioscryer Cuffs purge a ${token.rule} token` });
    }
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------

export const deathwatch = defineTeam({
  id: 'deathwatch',
  rules,
  ploys,
  equipment,
  ployUsable: {
    // "…when a friendly DEATHWATCH operative is counteracting, before it performs any actions."
    'deathwatch.fp.auspicator-tracking': (state, player) => {
      const id = (state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId;
      const op = id ? state.operatives[id] : undefined;
      if (!op || op.player !== player) return { ok: false, reason: 'no friendly operative is counteracting' };
      if (op.actionsThisActivation.length > 0) return { ok: false, reason: 'it has already performed an action' };
      return { ok: true };
    },
    // "…if it's shooting against or fighting against an operative that doesn't have the CHAOS
    //  or IMPERIUM keyword."
    'deathwatch.fp.suffer-not-the-alien': (state, player) => {
      const xenos = Object.values(state.operatives).some((o) => {
        if (o.player === player || o.removed) return false;
        const kws = catalogueKeywords(o);
        return !kws.includes('CHAOS') && !kws.includes('IMPERIUM');
      });
      return xenos ? { ok: true } : { ok: false, reason: 'every enemy operative has the CHAOS or IMPERIUM keyword' };
    },
    // "…when a friendly DEATHWATCH operative performs the Shoot action."
    'deathwatch.fp.advanced-auspex-scan': (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative is performing the Shoot action' };
    },
  },
  aiHints: {
    roles: {
      'deathwatch.watch-sergeant': 'leader',
      'deathwatch.aegis-veteran': 'melee',
      'deathwatch.blademaster-veteran': 'melee',
      'deathwatch.bombard-veteran': 'gunner',
      'deathwatch.breacher-veteran': 'gunner',
      'deathwatch.demolisher-veteran': 'melee',
      'deathwatch.disruptor-veteran': 'scout',
      'deathwatch.gunner-veteran': 'gunner',
      'deathwatch.headtaker-veteran': 'melee',
      'deathwatch.horde-slayer-veteran': 'gunner',
      'deathwatch.marksman-veteran': 'sniper',
    },
    ployValue: {
      'deathwatch.sp.mission-tactics': 0.6,
      'deathwatch.sp.the-shield-that-slays': 0.5,
      'deathwatch.sp.the-long-vigil': 0.5,
      'deathwatch.sp.and-they-shall-know-no-fear': 0.4,
      'deathwatch.fp.suffer-not-the-alien': 0.7,
      'deathwatch.fp.advanced-auspex-scan': 0.6,
      'deathwatch.fp.auspicator-tracking': 0.3,
      'deathwatch.fp.transhuman-physiology': 0.5,
    },
    equipmentValue: {
      'deathwatch.eq.digital-weapons': 0.6,
      'deathwatch.eq.sanctus-v-bioscryer-cuffs': 0.5,
      'deathwatch.eq.scrutavore-servo-thrall': 0.4,
      'deathwatch.eq.ammunition-reserve': 0.5,
    },
  },
});

export default deathwatch;

/** A ploy's `usable` gets no GameContext, so the shared static datacard catalogue answers. */
function catalogueKeywords(op: OperativeState): string[] {
  return catalogueCard(op.datacardId)?.keywords ?? [];
}
