/**
 * EXACTION SQUAD — Adeptus Arbites. https://wahapedia.ru/kill-team3/kill-teams/exaction-squad/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read
 * from `data/teams/exaction-squad.json` and never retyped. The one exception is the LEASHMASTER's
 * Attack Pattern menu (Aggressive / Swift / Defensive), whose three sub-rules have no id of their
 * own in the JSON — they are **sliced out of** the printed ability text at module load
 * (`ATTACK_PATTERN_TEXT`), the same treatment the Legionary Marks of Chaos menu needed.
 *
 * The team is a token economy: Marked for Justice, Apprehend, Veriscant and Spot are all
 * per-player effects on the operative that carries them (`giveToken`/`hasToken`/`removeToken`),
 * which is the shape the Plague Marines' Poison and the Nemesis Claw's Terrorchem established.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { hasRule } from '../../core/dice.ts';
import { baseWhollyWithin, dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { advanceShoot, checkTarget, effectiveRules, startShoot } from '../../core/sequences/shoot.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  findProfile,
  inControlRange,
  log,
  markerContestedBy,
  recordRoll,
  saveOf,
  weaponsOf,
} from '../../core/state.ts';
import { coverAndObscured, isVisible, vantageIgnoreFilter } from '../../core/visibility.ts';
import type { ActionDef } from '../../core/actions.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type { Datacard, GameState, MarkerState, OperativeState, PlayerId } from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import { loadoutOf } from '../selection.ts';
import {
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  giveToken,
  grantFreeAction,
  hasEquipment,
  hasToken,
  notEngaged,
  removeToken,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('exaction-squad');
const KW = 'EXACTION SQUAD';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionTextOf = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Datacards, rules, ploys, equipment — ids
// ---------------------------------------------------------------------------

export const PROCTOR = 'exaction-squad.arbites-proctor-exactant';
export const CASTIGATOR = 'exaction-squad.arbites-castigator';
export const CHIRURGANT = 'exaction-squad.arbites-chirurgant';
export const GUNNER = 'exaction-squad.arbites-gunner';
export const LEASHMASTER = 'exaction-squad.arbites-leashmaster';
export const MASTIFF = 'exaction-squad.r-vr-cyber-mastiff';
export const MALOCATOR = 'exaction-squad.arbites-malocator';
export const MARKSMAN = 'exaction-squad.arbites-marksman';
export const REVELATUM = 'exaction-squad.arbites-revelatum';
export const SUBDUCTOR = 'exaction-squad.arbites-subductor';
export const VIGILANT = 'exaction-squad.arbites-vigilant';
export const VOX_SIGNIFIER = 'exaction-squad.arbites-vox-signifier';

const RULE_RUTHLESS = 'exaction-squad.rule.ruthless-efficiency';
const RULE_MARK = 'exaction-squad.rule.marked-for-justice';
const RULE_REPRESS = 'exaction-squad.rule.repress';

const SP_GUILT = 'exaction-squad.sp.guilt-reveals-itself';
const SP_INVIOLATE = 'exaction-squad.sp.inviolate-jurisdiction';
const SP_DISPENSE = 'exaction-squad.sp.dispense-justice';
const SP_TERMINAL = 'exaction-squad.sp.terminal-decree';
const FP_LONG_ARM = 'exaction-squad.fp.long-arm-of-the-emperors-law';
const FP_EXACT_PUNISHMENT = 'exaction-squad.fp.exact-punishment';
const FP_BRUTAL_BACKUP = 'exaction-squad.fp.brutal-backup';
const FP_EXECUTION_ORDER = 'exaction-squad.fp.execution-order';
const EQ_VISOR = 'exaction-squad.eq.reinforced-mirror-visor';
const EQ_MANACLES = 'exaction-squad.eq.manacles';
const EQ_LUMEN = 'exaction-squad.eq.strobing-phosphor-lumen';
const EQ_SHELLS = 'exaction-squad.eq.special-issue-shells';

const ACT_NUNCIO = 'exaction-squad.arbites-proctor-exactant.act.deploy-nuncio-aquila';
const ACT_MEDIKIT = 'exaction-squad.arbites-chirurgant.act.medikit';
const ACT_RVR_COMMAND = 'exaction-squad.arbites-leashmaster.act.r-vr-command';
const ACT_APPREHEND = 'exaction-squad.r-vr-cyber-mastiff.act.apprehend';
const ACT_VERISCANT = 'exaction-squad.arbites-malocator.act.veriscant';
const ACT_OPTICS = 'exaction-squad.arbites-marksman.act.optics';
const ACT_SPOT = 'exaction-squad.arbites-revelatum.act.spot';
const ACT_SIGNAL = 'exaction-squad.arbites-vox-signifier.act.signal';

const AB_ASSAULT_SHIELD = 'exaction-squad.arbites-proctor-exactant.assault-shield';
const AB_NUNCIO = 'exaction-squad.arbites-proctor-exactant.nuncio-aquila';
const AB_ENGENDERED = 'exaction-squad.arbites-castigator.engendered-focus';
const AB_ZEALOUS = 'exaction-squad.arbites-castigator.zealous-dedication';
const AB_ARREST = 'exaction-squad.arbites-castigator.castigators-arrest';
const AB_MEDIC = 'exaction-squad.arbites-chirurgant.medic';
const AB_HANDLER = 'exaction-squad.arbites-leashmaster.handler';
const AB_ATTACK_PATTERN = 'exaction-squad.arbites-leashmaster.attack-pattern';
const AB_BEAST = 'exaction-squad.r-vr-cyber-mastiff.beast';
const AB_ACUTE_FOCUS = 'exaction-squad.arbites-malocator.acute-focus';
const AB_CONCEALED = 'exaction-squad.arbites-marksman.concealed-position';
const AB_FIRST_IN_FIELD = 'exaction-squad.arbites-revelatum.first-in-the-field';
const AB_STUBBORN = 'exaction-squad.arbites-subductor.stubborn-subjugator';
const AB_CQ_VIGILANCE = 'exaction-squad.arbites-vigilant.close-quarters-vigilance';

/** Tokens the printed marker guide names, held as per-player effects on their bearer. */
export const MARK_TOKEN = 'exaction-squad.markedForJustice';
export const APPREHEND_TOKEN = 'exaction-squad.apprehend';
export const VERISCANT_TOKEN = 'exaction-squad.veriscant';
export const SPOT_TOKEN = 'exaction-squad.spot';
const OPTICS_EFFECT = 'exaction-squad.optics';
const PATTERN_EFFECT = 'exaction-squad.attackPattern';
const HANDLER_EFFECT = 'exaction-squad.handlerPair';
const EXECUTION_EFFECT = 'exaction-squad.executionOrder';
const TARGET_LOCK = 'exaction-squad.targetLock';
const MEDIC_APL = 'exaction-squad.medicApl';
const MEDIC_SHIELD = 'exaction-squad.medicShield';
const MANACLED = 'exaction-squad.manacled';
const LONG_ARM_EFFECT = 'exaction-squad.longArm';
const SHELLS_EFFECT = 'exaction-squad.shells';
const POINT_BLANK_CANCEL = 'exaction-squad.vigilantShot';
const ACTIVATION_MARK = 'exaction-squad.activationStart';

export const NUNCIO_MARKER = (player: PlayerId): string => `exaction-squad.nuncio.${player}`;
export const VIGILANT_SHOOT = 'Shoot (Close Quarters Vigilance)';

const SHOTGUNS = ['combat shotgun', 'executioner shotgun', 'scoped shotpistol', 'shotpistol'];
const isGrenade = (name: string): boolean => /^(frag|krak) grenade$/i.test(name.trim());

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

const isInjured = (T: TeamHooks, op: OperativeState): boolean => {
  const c = T.card(op);
  return c !== undefined && op.wounds < c.wounds / 2;
};

/** The weapons this operative actually carries (the roster loadout, or the whole datacard). */
function hasWeapon(T: TeamHooks, state: GameState, op: OperativeState, name: string): boolean {
  const chosen = loadoutOf(state, op.id);
  if (chosen && chosen.length > 0) return chosen.some((n) => n.trim().toLowerCase() === name.toLowerCase());
  return (T.card(op)?.weapons ?? []).some((w) => w.name.toLowerCase() === name.toLowerCase());
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/** Control range is "visible to and within 1"", which only the core geometry knows. */
function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

/**
 * "…until the start of this operative's next activation."
 *
 * `endOfNextActivation` (the engine's nearest expiry) runs one whole activation long, so the
 * effect is stored to the end of the battle and dropped by an `onActivationStart` handler when
 * its owner activates again. That is exact where the built-in expiry is not.
 */
function untilNextActivation(state: GameState, op: OperativeState, rule: string, sourceId: string, sourceText: string, data?: Record<string, unknown>): void {
  dropEffects(state, (e) => e.rule === rule && e.data?.['owner'] === op.id);
  effect(state, {
    rule,
    source: { kind: 'ability', id: sourceId },
    sourceText: shortQuote(sourceText),
    player: op.player,
    ...(data?.['on'] ? { operativeId: String(data['on']) } : { operativeId: op.id }),
    data: { ...(data ?? {}), owner: op.id },
    expiry: { kind: 'endOfBattle' },
  });
}

// ---------------------------------------------------------------------------
// Attack Pattern — the LEASHMASTER's three-option menu, sliced out of its printed text
// ---------------------------------------------------------------------------

export const PATTERNS = ['Aggressive', 'Swift', 'Defensive'] as const;
export type AttackPattern = (typeof PATTERNS)[number];

/**
 * The three sub-rules have no id of their own in the JSON — they are printed as
 * `\nAggressive: …\nSwift: …\nDefensive: …` inside the one ability, so they are sliced out
 * here rather than retyped (the Legionary Marks of Chaos exception).
 */
export const ATTACK_PATTERN_TEXT: Record<AttackPattern, string> = (() => {
  const printed = abilityText(LEASHMASTER, AB_ATTACK_PATTERN);
  const out = {} as Record<AttackPattern, string>;
  PATTERNS.forEach((p, i) => {
    const start = printed.indexOf(`${p}:`);
    const next = PATTERNS[i + 1];
    const endAt = next ? printed.indexOf(`${next}:`) : -1;
    out[p] = start < 0 ? p : printed.slice(start, endAt < 0 ? printed.length : endAt).trim();
  });
  return out;
})();

/** The two attack patterns a CYBER-MASTIFF currently has, in printed order. */
export function patternsOf(state: GameState, op: OperativeState): AttackPattern[] {
  const eff = state.effects.find((e) => e.rule === PATTERN_EFFECT && e.operativeId === op.id);
  const raw = (eff?.data?.['patterns'] as string[] | undefined) ?? [];
  return PATTERNS.filter((p) => raw.includes(p));
}

function setPatterns(state: GameState, op: OperativeState, patterns: AttackPattern[]): void {
  dropEffects(state, (e) => e.rule === PATTERN_EFFECT && e.operativeId === op.id);
  effect(state, {
    rule: PATTERN_EFFECT,
    source: { kind: 'ability', id: AB_ATTACK_PATTERN },
    sourceText: shortQuote(abilityText(LEASHMASTER, AB_ATTACK_PATTERN)),
    operativeId: op.id,
    player: op.player,
    data: { patterns: [...patterns] },
    expiry: { kind: 'endOfBattle' }, // "…for the battle"
  });
}

const PATTERN_PAIRS: [AttackPattern, AttackPattern][] = [
  ['Aggressive', 'Swift'],
  ['Aggressive', 'Defensive'],
  ['Swift', 'Defensive'],
];
const patternGambitId = (pair: [AttackPattern, AttackPattern]): string => `${AB_ATTACK_PATTERN}:${pair.join('+')}`;

// ---------------------------------------------------------------------------
// Marked for Justice
// ---------------------------------------------------------------------------

/** The enemy operative that is this player's mark for the turning point, if any. */
export function markOf(state: GameState, player: PlayerId): OperativeState | undefined {
  return aliveOperatives(state, otherPlayer(player)).find((o) => hasToken(state, o.id, MARK_TOKEN, player));
}

function setMark(state: GameState, target: OperativeState, player: PlayerId): void {
  for (const o of aliveOperatives(state, target.player)) removeToken(state, o.id, MARK_TOKEN);
  giveToken(state, target, MARK_TOKEN, {
    sourceId: RULE_MARK,
    sourceText: shortQuote(text(RULE_MARK)),
    player,
    // "…to be your mark for the turning point."
    expiry: { kind: 'endOfTurningPoint' },
  });
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

/** Distance moved by this operative so far in this activation, in inches. */
function movedThisActivation(state: GameState, op: OperativeState): number {
  const start = effectOn(state, op.id, ACTIVATION_MARK)?.data?.['seq'];
  if (typeof start !== 'number') return 0;
  // `applyMove` records the validated distance of every move on the log, and the log is part of
  // GameState — so "moved more than its Move stat during the activation" is exact rather than
  // inferred from which move actions were performed. Entries are appended in `seq` order, so the
  // scan runs backwards and stops at the activation boundary.
  let total = 0;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.seq < start) break;
    if (entry.kind !== 'action' || entry.data?.['operativeId'] !== op.id) continue;
    const inches = entry.data?.['inches'];
    if (typeof inches === 'number') total += inches;
  }
  return total;
}

function moveStatOf(T: TeamHooks, op: OperativeState): number {
  return T.card(op)?.move ?? 6;
}

/** The Nuncio-aquila marker, or the PROCTOR itself while the marker isn't in the killzone. */
function nuncioAnchor(T: TeamHooks, state: GameState): { marker?: MarkerState; op?: OperativeState } {
  const marker = state.markers[NUNCIO_MARKER(T.player)];
  if (marker) return { marker };
  const proctor = T.friendlies(state).find((o) => o.datacardId === PROCTOR);
  return proctor ? { op: proctor } : {};
}

function withinNuncio(T: TeamHooks, state: GameState, op: OperativeState, inches: number): boolean {
  const anchor = nuncioAnchor(T, state);
  if (anchor.marker) return T.markerGap(op, anchor.marker) <= inches + EPS;
  if (anchor.op) return T.gap(op, anchor.op) <= inches + EPS;
  return false;
}

function rules(reg: HookRegistry, T: TeamHooks): void {
  // Bookkeeping: remember where each activation started on the log, for DISPENSE JUSTICE.
  reg.on('onActivationStart', T.bind(SP_DISPENSE, 9), (ev) => {
    if (ev.operative.player !== T.player) return;
    // The weapon Ruthless Efficiency recorded for the last Shoot action is stale from here on.
    delete bucket(ev.state, 'exaction-squad.shooting')[ev.operative.id];
    effect(ev.state, {
      rule: ACTIVATION_MARK,
      source: { kind: 'core', id: SP_DISPENSE },
      operativeId: ev.operative.id,
      player: T.player,
      data: { seq: ev.state.seq },
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
  });

  // ---- Ruthless Efficiency (faction rule) ---------------------------------
  // "…having other friendly EXACTION SQUAD operatives within an enemy operative's control range
  //  doesn't prevent that enemy operative from being selected." The seam is the `onValidTarget`
  //  payload's `ignoreFriendlyControlRange` (Pathfinders' SUPPORTING FIRE added it).
  //  The rule is free, so it is always used (docs/DECISIONS.md D-022).
  reg.on('onSelectWeapon', T.bind(RULE_RUTHLESS, 10), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    // `onValidTarget` carries no weapon, and the grenade carve-out is per weapon — so the weapon
    // chosen for THIS Shoot action is recorded here (startShoot emits this immediately before
    // the target check) and read back below.
    bucket(ev.state, 'exaction-squad.shooting')[ev.ctx.attacker.id] = ev.ctx.weaponName;
  });
  reg.on('onValidTarget', T.bind(RULE_RUTHLESS, 11), (ev) => {
    if (!T.mineKw(ev.attacker, KW)) return;
    const weapon = bucket(ev.state, 'exaction-squad.shooting')[ev.attacker.id];
    if (typeof weapon === 'string' && isGrenade(weapon)) return; // "excluding with frag or krak grenades"
    // "other friendly EXACTION SQUAD operatives" only — a non-EXACTION SQUAD friendly still blocks.
    const blockers = T.friendlies(ev.state).filter(
      (f) => f.id !== ev.attacker.id && inCR(T, ev.state, f, ev.target),
    );
    if (blockers.length > 0 && blockers.every((f) => T.kw(f, KW))) ev.ignoreFriendlyControlRange = true;
  });

  // ---- Marked for Justice (faction rule, STRATEGIC GAMBIT) ----------------
  reg.on('gambitOptions', T.bind(RULE_MARK, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({ id: RULE_MARK, label: 'Marked for Justice', sourceText: shortQuote(text(RULE_MARK)) });
  });
  reg.on('onPloyUsed', T.bind(RULE_MARK, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== RULE_MARK) return;
    // "Select one enemy operative to be your mark" — from the gambit's data, else a logged
    // deterministic default (docs/DECISIONS.md D-016).
    const target = chosenOperative(ev.state, ev.data, T.enemies(ev.state));
    if (!target) return;
    setMark(ev.state, target, T.player);
  });
  // "Whenever a friendly EXACTION SQUAD operative is shooting against, fighting against or
  //  retaliating against your mark, that friendly operative's weapons have the Punishing weapon
  //  rule." `onWeaponRules` is emitted by `effectiveRules`, which both shoot.ts and fight.ts use
  //  (fight.ts for the attacker AND the retaliating defender), so all three cases are live.
  reg.on('onWeaponRules', T.bind(RULE_MARK, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!hasToken(ev.state, ev.target.id, MARK_TOKEN, T.player)) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Marked for Justice)'));
  });
  // "Whenever your mark is incapacitated, you can select a new enemy operative to be your mark."
  reg.on('onIncapacitated', T.bind(RULE_MARK, 14), (ev) => {
    if (ev.prevented) return;
    if (!hasToken(ev.state, ev.operative.id, MARK_TOKEN, T.player)) return;
    removeToken(ev.state, ev.operative.id, MARK_TOKEN);
    const next = T.enemies(ev.state).find((o) => o.id !== ev.operative.id && !o.incapacitated);
    if (!next) return;
    setMark(ev.state, next, T.player);
  });

  // ---- Repress (rare weapon rule, defined by the faction rule) ------------
  // "Each of your blocks can be allocated to block two unresolved successes (instead of one)."
  reg.on('onBlockAllocation', T.bind(RULE_REPRESS, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return; // `attacker` is whoever is resolving the die
    if (!hasRule(ev.ctx.rules, 'Repress')) return;
    ev.blocks = 2;
  });
  // "If this operative is retaliating, you resolve the first attack dice (i.e. defender instead
  //  of attacker)." The defender's dice are rolled in the same step, so the turn is flipped as
  //  its pool is collected — long before the Resolve Attack Dice step reads `seq.turn`.
  reg.on('onCollectAttackDice', T.bind(RULE_REPRESS, 13), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.ctx.attacker.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== ev.ctx.attacker.id) return;
    if (!hasRule(ev.ctx.rules, 'Repress')) return;
    seq.turn = 'defender';
    log(ev.state, { kind: 'dice', player: T.player, text: `Repress: ${ev.ctx.attacker.letter} resolves the first attack dice` });
  });

  // ---- PROCTOR-EXACTANT › Assault Shield ---------------------------------
  reg.on('onStatMod', T.bind(AB_ASSAULT_SHIELD, 12), (ev) => {
    if (ev.operative.datacardId !== PROCTOR || ev.operative.player !== T.player) return;
    if (!hasWeapon(T, ev.state, ev.operative, 'Dominator maul & assault shield')) return;
    const base = T.card(ev.operative)?.save ?? 4;
    ev.mods.save += base - 3; // "it has a 3+ Save stat"
  });

  // ---- PROCTOR-EXACTANT › Nuncio-aquila ----------------------------------
  reg.on('onActionCost', T.bind(AB_NUNCIO, 12), (ev) => {
    if (ev.operative.player === T.player) return; // "for that ENEMY operative"
    const def = getAction(ev.action);
    if (ev.action !== 'Pick Up Marker' && def?.type !== 'mission') return;
    if (!withinNuncio(T, ev.state, ev.operative, 3)) return;
    ev.ap += 1; // "your opponent must spend 1 additional AP"
  });
  reg.on('onMarkerControl', T.bind(AB_NUNCIO, 13), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const foe = otherPlayer(T.player);
    const near = aliveOperatives(ev.state, foe).some(
      (o) => markerContestedBy(T.ctx!, ev.state, marker, o) && withinNuncio(T, ev.state, o, 3),
    );
    // "treat the total APL stat of enemy operatives that contest it as 1 lower … Note this
    //  isn't a change to the APL stat, so any changes are cumulative with this."
    if (near) ev.aplByPlayer[foe] = Math.max(0, ev.aplByPlayer[foe] - 1);
  });

  // ---- CASTIGATOR › Engendered Focus -------------------------------------
  /**
   * "You can ignore any changes to this operative's stats (including its weapons' stats, but
   * excluding its Save stat)." It is a *may*, so the stated policy (docs/DECISIONS.md D-022) is
   * to use it exactly when it helps: worsening changes are ignored, improvements are kept.
   * Priority 60 so it runs after every other stat handler on either side.
   */
  reg.on('onStatMod', T.bind(AB_ENGENDERED, 60), (ev) => {
    if (ev.operative.datacardId !== CASTIGATOR || ev.operative.player !== T.player) return;
    if (ev.mods.hit < 0) ev.mods.hit = 0;
    if (ev.mods.move < 0) ev.mods.move = 0;
    const apl = ev.operative.aplMods.reduce((a, b) => a + b, 0) + ev.mods.apl;
    if (apl < 0) ev.mods.apl -= apl;
    // Injured ("subtract 2" from Move, worsen Hit by 1") is a change to its stats too, and both
    // are applied outside `StatMods`, so they are cancelled here.
    if (isInjured(T, ev.operative)) {
      ev.mods.hit += 1;
      ev.mods.move += 2;
    }
    // "excluding its Save stat" — `mods.save` is deliberately untouched.
  });
  reg.on('onCollectAttackDice', T.bind(AB_ENGENDERED, 60), (ev) => {
    if (ev.ctx.attacker.datacardId !== CASTIGATOR || ev.ctx.attacker.player !== T.player) return;
    if (ev.mods.atk < 0) ev.mods.atk = 0; // "including its weapons' stats"
    if (ev.count < ev.ctx.profile.atk) ev.count = ev.ctx.profile.atk;
  });

  // ---- CASTIGATOR › Zealous Dedication -----------------------------------
  reg.on('onDamage', T.bind(AB_ZEALOUS, 12), (ev) => {
    if (!T.ctx) return;
    if (ev.kind !== 'attack' && ev.kind !== 'devastating') return; // "whenever an attack dice inflicts damage"
    if (ev.target.datacardId !== CASTIGATOR || ev.target.player !== T.player) return;
    if (ev.amount < 3) return; // "…damage of 3 or more"
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'zealousDedication', [roll], T.player, 'Zealous Dedication 5+');
    if (roll >= 5) ev.amount -= 1;
  });

  // ---- CASTIGATOR › Castigator's Arrest ----------------------------------
  reg.on('canPerformAction', T.bind(AB_ARREST, 12), (ev) => {
    if (ev.action !== 'Fall Back') return;
    if (ev.operative.player === T.player) return;
    const lone = T.friendlies(ev.state).some(
      (c) =>
        c.datacardId === CASTIGATOR &&
        inCR(T, ev.state, c, ev.operative) &&
        // "if no other enemy operatives are within this operative's control range"
        T.enemies(ev.state).every((e) => e.id === ev.operative.id || !inCR(T, ev.state, c, e)),
    );
    if (!lone) return;
    ev.allowed = false;
    ev.reason = 'Castigator’s Arrest: that enemy operative cannot Fall Back';
  });

  // ---- CHIRURGANT › Medic! -----------------------------------------------
  /**
   * Modelled on the Pathfinders' Medic!. "…that activation ends" is expressed as the free Dash
   * grant's threshold: from the moment the rule fires, the only action the saved operative may
   * still perform is the printed free Dash. Its "must end that move within this operative's
   * control range" has no seam (nothing constrains where a move ends) and is reminder-only.
   */
  reg.on('onIncapacitated', T.bind(AB_MEDIC, 12), (ev) => {
    const victim = ev.operative;
    if (ev.prevented) return;
    if (!T.mineKw(victim, KW)) return;
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CHIRURGANT &&
        o.id !== victim.id &&
        !o.incapacitated && // "You cannot use this rule if this operative is incapacitated"
        T.gap(o, victim) <= 3 + EPS &&
        visibleTo(T, ev.state, o, victim) &&
        // "providing neither this nor that operative is within control range of an enemy operative"
        T.enemies(ev.state).every((e) => !inCR(T, ev.state, e, o) && !inCR(T, ev.state, e, victim)),
    );
    if (!medic) return;
    // "…or if it's a Shoot action and this operative would be a primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id))) return;
    if (!useOncePerTP(ev.state, `exaction-squad.medic:${medic.id}`)) return;

    ev.prevented = true;
    victim.wounds = 1; // "that friendly operative isn't incapacitated, has 1 wound remaining"
    medicTargets(ev.state)[medic.id] = victim.id;
    // "…and cannot be incapacitated for the remainder of the action."
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: AB_MEDIC },
      sourceText: shortQuote(abilityText(CHIRURGANT, AB_MEDIC)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next activations."
    for (const o of [medic, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: MEDIC_APL,
        source: { kind: 'ability', id: AB_MEDIC },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    // "After that action, that friendly operative can immediately perform a free Dash action" —
    // and "if this rule was used during that friendly operative's activation, that activation
    // ends", so once the rule fires the Dash is the only action left to it.
    grantFreeAction(ev.state, victim, {
      sourceId: AB_MEDIC,
      sourceText: shortQuote(abilityText(CHIRURGANT, AB_MEDIC)),
      threshold: ev.state.activeOperativeId === victim.id ? victim.apSpent : currentApl(T, ev.state, victim),
      kind: 'ability',
      only: ['Dash'],
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Medic!: ${victim.letter} stays on 1 wound` });
  });
  reg.on('onIncapacitated', T.bind(AB_MEDIC, 11), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, MEDIC_SHIELD)) return;
    ev.prevented = true;
    if (ev.operative.wounds <= 0) ev.operative.wounds = 1;
  });

  // ---- LEASHMASTER › Handler ---------------------------------------------
  /**
   * "…you can activate a ready friendly R-VR CYBER-MASTIFF operative at the same time."
   * The engine alternates activations strictly, so the pairing is recorded as an effect the
   * UI/AI reads — the same partial as the Breachers' Breach and Clear and the Pathfinders'
   * Group Activation.
   */
  reg.on('onActivationStart', T.bind(AB_HANDLER, 12), (ev) => {
    if (ev.operative.datacardId !== LEASHMASTER || ev.operative.player !== T.player) return;
    const mastiff = T.friendlies(ev.state).find((o) => o.datacardId === MASTIFF && o.ready && o.id !== ev.operative.id);
    if (!mastiff) return;
    effect(ev.state, {
      rule: HANDLER_EFFECT,
      source: { kind: 'ability', id: AB_HANDLER },
      sourceText: shortQuote(abilityText(LEASHMASTER, AB_HANDLER)),
      operativeId: mastiff.id,
      player: T.player,
      data: { with: ev.operative.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
  });

  // ---- LEASHMASTER › Attack Pattern (STRATEGIC GAMBIT in TP1) ------------
  for (const pair of PATTERN_PAIRS) {
    reg.on('gambitOptions', T.bind(AB_ATTACK_PATTERN, 15), (ev) => {
      if (ev.player !== T.player || ev.state.turningPoint !== 1) return; // "in the first turning point"
      if (!T.friendlies(ev.state).some((o) => o.datacardId === LEASHMASTER)) return;
      const mastiff = T.friendlies(ev.state).find((o) => o.datacardId === MASTIFF);
      if (!mastiff || patternsOf(ev.state, mastiff).length > 0) return; // "select two", once
      ev.options.push({
        id: patternGambitId(pair),
        label: `Attack Pattern: ${pair.join(' + ')}`,
        sourceText: pair.map((p) => ATTACK_PATTERN_TEXT[p]).join(' '),
      });
    });
  }
  reg.on('onPloyUsed', T.bind(AB_ATTACK_PATTERN, 16), (ev) => {
    if (ev.player !== T.player) return;
    const pair = PATTERN_PAIRS.find((p) => patternGambitId(p) === ev.ployId);
    if (!pair) return;
    const mastiff = T.friendlies(ev.state).find((o) => o.datacardId === MASTIFF);
    if (!mastiff) return;
    setPatterns(ev.state, mastiff, [...pair]);
    log(ev.state, { kind: 'ploy', player: T.player, text: `Attack Pattern: ${pair.join(' + ')}` });
  });
  // "Aggressive: Its melee weapons have the Relentless weapon rule."
  reg.on('onWeaponRules', T.bindText(`${AB_ATTACK_PATTERN}.aggressive`, ATTACK_PATTERN_TEXT.Aggressive, 12), (ev) => {
    if (ev.type !== 'melee' || ev.operative.datacardId !== MASTIFF || ev.operative.player !== T.player) return;
    if (!patternsOf(ev.state, ev.operative).includes('Aggressive')) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Aggressive)'));
  });
  // "Swift: Add 2" to its Move stat." / "Defensive: Improve its Save stat by 1."
  reg.on('onStatMod', T.bindText(`${AB_ATTACK_PATTERN}.swift`, `${ATTACK_PATTERN_TEXT.Swift} ${ATTACK_PATTERN_TEXT.Defensive}`, 12), (ev) => {
    if (ev.operative.datacardId !== MASTIFF || ev.operative.player !== T.player) return;
    const patterns = patternsOf(ev.state, ev.operative);
    if (patterns.includes('Swift')) ev.mods.move += 2;
    if (patterns.includes('Defensive')) ev.mods.save += 1;
  });

  // ---- R-VR CYBER-MASTIFF › Beast ----------------------------------------
  const BEAST_ACTIONS = [
    ACT_APPREHEND,
    'Charge',
    'Dash',
    'Fall Back',
    'Fight',
    'Guard',
    'Reposition',
    'Pick Up Marker',
    'Place Marker',
  ];
  reg.on('canPerformAction', T.bind(AB_BEAST, 12), (ev) => {
    if (ev.operative.datacardId !== MASTIFF || ev.operative.player !== T.player) return;
    if (BEAST_ACTIONS.includes(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'a R-VR CYBER-MASTIFF cannot perform that action';
  });
  // "It cannot use any weapons that aren't on its datacard." `weaponsOf` appends granted weapons
  // AFTER `availableWeapons`, so the ranged half is enforced at Select Weapon as well.
  reg.on('availableWeapons', T.bind(AB_BEAST, 13), (ev) => {
    if (ev.operative.datacardId !== MASTIFF || ev.operative.player !== T.player) return;
    const own = new Set((T.card(ev.operative)?.weapons ?? []).map((w) => w.name));
    ev.weapons = ev.weapons.filter((n) => own.has(n));
  });
  reg.on('onSelectWeapon', T.bind(AB_BEAST, 14), (ev) => {
    if (ev.ctx.attacker.datacardId !== MASTIFF || ev.ctx.attacker.player !== T.player) return;
    if ((T.card(ev.ctx.attacker)?.weapons ?? []).some((w) => w.name === ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'a R-VR CYBER-MASTIFF cannot use weapons that aren’t on its datacard';
  });

  // ---- R-VR CYBER-MASTIFF › APPREHEND (the action's lasting effect) ------
  reg.on('onStatMod', T.bind(ACT_APPREHEND, 12), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!apprehendedBy(T, ev.state, ev.operative)) return;
    // "worsen the Hit stat of that enemy operative's weapons by 1 (this isn't cumulative with
    //  being injured)" — injured already worsens Hit by 1, so nothing is added on top.
    if (isInjured(T, ev.operative)) return;
    ev.mods.hit -= 1;
  });
  reg.on('canPerformAction', T.bind(ACT_APPREHEND, 13), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player === T.player) return;
    if (!apprehendedBy(T, ev.state, ev.operative)) return;
    ev.allowed = false;
    ev.reason = 'APPREHEND: that enemy operative cannot Fall Back';
  });
  // "Until that enemy operative is no longer within this operative's control range" — once it
  // leaves, the effect is over for good, so it is dropped at the next activation boundary.
  reg.on('onActivationEnd', T.bind(ACT_APPREHEND, 14), (ev) => {
    dropEffects(ev.state, (e) => {
      if (e.rule !== APPREHEND_TOKEN || e.player !== T.player) return false;
      const victim = e.operativeId ? ev.state.operatives[e.operativeId] : undefined;
      const dog = ev.state.operatives[String(e.data?.['by'] ?? '')];
      return !victim || !dog || victim.removed || dog.removed || !inCR(T, ev.state, dog, victim);
    });
  });

  // ---- MALOCATOR › Acute Focus -------------------------------------------
  reg.on('onActionCost', T.bind(AB_ACUTE_FOCUS, 12), (ev) => {
    if (ev.operative.datacardId !== MALOCATOR || ev.operative.player !== T.player) return;
    if (!acuteFocusAction(ev.action)) return;
    // "Once during each of this operative's activations" — the first such action gets it.
    if (ev.operative.actionsThisActivation.some((a) => acuteFocusAction(a))) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- MALOCATOR › VERISCANT (the action's lasting effect) ---------------
  reg.on('onWeaponRules', T.bind(ACT_VERISCANT, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!hasToken(ev.state, ev.target.id, VERISCANT_TOKEN, T.player)) return;
    ev.rules.push(
      ruleTag('Lethal', 5, 'Lethal 5+ (VERISCANT)'),
      ruleTag('Severe', undefined, 'Severe (VERISCANT)'),
    );
  });

  // ---- MARKSMAN › Concealed Position (rare weapon rule) ------------------
  reg.on('onSelectWeapon', T.bind(AB_CONCEALED, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (!hasShot(ev.state, ev.ctx.attacker.id)) return;
    ev.allowed = false;
    ev.reason = 'Concealed Position: only the first Shoot action of the battle';
  });
  reg.on('onCollectAttackDice', T.bind(AB_CONCEALED, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    bucket(ev.state, 'exaction-squad.hasShot')[ev.ctx.attacker.id] = true;
  });

  // ---- MARKSMAN › OPTICS (the action's lasting effect) -------------------
  reg.on('onWeaponRules', T.bind(ACT_OPTICS, 12), (ev) => {
    if (ev.operative.datacardId !== MARKSMAN || ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, OPTICS_EFFECT)) return;
    if (!/executioner shotgun/i.test(ev.weaponName)) return;
    // "The concealed and stationary profiles of its executioner shotgun have Lethal 5+."
    if (ev.profile.name !== 'concealed' && ev.profile.name !== 'stationary') return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (OPTICS)'));
  });
  reg.on('onCollectAttackDice', T.bind(ACT_OPTICS, 13), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    if (ev.ctx.attacker.datacardId !== MARKSMAN || ev.ctx.attacker.player !== T.player) return;
    if (!effectOn(ev.state, ev.ctx.attacker.id, OPTICS_EFFECT)) return;
    if (!/executioner shotgun/i.test(ev.ctx.weaponName)) return;
    const seq = shootSeq(ev.state);
    if (seq) seq.obscured = false; // "enemy operatives cannot be obscured"
  });

  // ---- REVELATUM › First in the Field (STRATEGIC GAMBIT in TP1) ---------
  reg.on('gambitOptions', T.bind(AB_FIRST_IN_FIELD, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (!firstInFieldCandidate(T, ev.state)) return;
    ev.options.push({
      id: AB_FIRST_IN_FIELD,
      label: 'First in the Field',
      sourceText: shortQuote(abilityText(REVELATUM, AB_FIRST_IN_FIELD)),
    });
  });
  reg.on('onPloyUsed', T.bind(AB_FIRST_IN_FIELD, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== AB_FIRST_IN_FIELD) return;
    const op = firstInFieldCandidate(T, ev.state);
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: AB_FIRST_IN_FIELD,
      sourceText: shortQuote(abilityText(REVELATUM, AB_FIRST_IN_FIELD)),
      threshold: currentApl(T, ev.state, op),
      kind: 'ability',
      only: ['Reposition'],
    });
  });

  // ---- REVELATUM › SPOT (the action's lasting effect) --------------------
  reg.on('onWeaponRules', T.bind(ACT_SPOT, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!hasToken(ev.state, ev.target.id, SPOT_TOKEN, T.player)) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (SPOT)'));
  });
  reg.on('onCollectAttackDice', T.bind(ACT_SPOT, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    if (!target || !hasToken(ev.state, target.id, SPOT_TOKEN, T.player)) return;
    const seq = shootSeq(ev.state);
    if (seq) seq.obscured = false; // "That enemy operative cannot be obscured."
  });

  // ---- SUBDUCTOR › Stubborn Subjugator -----------------------------------
  /** "You can ignore any changes to the Hit stat of this operative's melee weapons." (D-022.) */
  reg.on('onStatMod', T.bind(AB_STUBBORN, 59), (ev) => {
    if (ev.operative.datacardId !== SUBDUCTOR || ev.operative.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || (seq.attackerId !== ev.operative.id && seq.defenderId !== ev.operative.id)) return;
    if (ev.mods.hit < 0) ev.mods.hit = 0;
    if (isInjured(T, ev.operative)) ev.mods.hit += 1; // injured worsens Hit by 1 outside StatMods
  });

  // ---- VIGILANT › Close Quarters Vigilance --------------------------------
  // The action itself is `Shoot (Close Quarters Vigilance)` below (docs/DECISIONS.md D-021).
  // It goes through the engine's point-blank path — the only way to shoot while engaged — so
  // the point-blank Hit penalty, which this rule does not print, is cancelled here.
  reg.on('onStatMod', T.bind(AB_CQ_VIGILANCE, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, POINT_BLANK_CANCEL)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !seq.pointBlank) return;
    ev.mods.hit += 1;
  });

  // ---- effects that end when their owner activates again ------------------
  reg.on('onActivationStart', T.bind(ACT_VERISCANT, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    for (const rule of [VERISCANT_TOKEN, OPTICS_EFFECT])
      dropEffects(ev.state, (e) => e.rule === rule && e.data?.['owner'] === ev.operative.id);
  });
  // "…until it's incapacitated" (the MALOCATOR / the MARKSMAN).
  reg.on('onIncapacitated', T.bind(ACT_VERISCANT, 13), (ev) => {
    if (ev.prevented || ev.operative.player !== T.player) return;
    for (const rule of [VERISCANT_TOKEN, OPTICS_EFFECT])
      dropEffects(ev.state, (e) => e.rule === rule && e.data?.['owner'] === ev.operative.id);
    // "If this operative is removed from the killzone, remove your Nuncio-aquila marker."
    if (ev.operative.datacardId === PROCTOR) delete ev.state.markers[NUNCIO_MARKER(T.player)];
  });
}

const ACUTE_FOCUS_ACTIONS = new Set(['Pick Up Marker', 'Place Marker', ACT_VERISCANT]);
const acuteFocusAction = (action: string): boolean =>
  ACUTE_FOCUS_ACTIONS.has(action) || getAction(action)?.type === 'mission';

function apprehendedBy(T: TeamHooks, state: GameState, victim: OperativeState): boolean {
  const eff = state.effects.find((e) => e.rule === APPREHEND_TOKEN && e.operativeId === victim.id && e.player === T.player);
  if (!eff) return false;
  const dog = state.operatives[String(eff.data?.['by'] ?? '')];
  return Boolean(dog) && !dog!.removed && inCR(T, state, dog!, victim);
}

function hasShot(state: GameState, operativeId: string): boolean {
  return Boolean(bucket(state, 'exaction-squad.hasShot')[operativeId]);
}

function medicTargets(state: GameState): Record<string, string> {
  return bucket(state, 'exaction-squad.medicTarget') as Record<string, string>;
}

/** "If this operative is wholly within your drop zone" (the REVELATUM). */
function firstInFieldCandidate(T: TeamHooks, state: GameState): OperativeState | undefined {
  const zones = state.map.dropZones[state.setup.dropZone[T.player] ?? T.player] ?? [];
  if (zones.length === 0) return undefined;
  return T.friendlies(state).find((o) => {
    if (o.datacardId !== REVELATUM) return false;
    const card = T.card(o);
    return card !== undefined && baseWhollyWithin(o.pos, card.base, o.rot, zones);
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- GUILT REVEALS ITSELF (strategy) -----------------------------------
  /**
   * "…enemy operatives within 4" of it cannot be in cover (instead of 2"). While this can allow
   * such operatives to be targeted…, it doesn't remove their cover save (if any), unless the
   * friendly operative is within 2" as normal."
   *
   * The core denies cover inside 2" inside `coverAndObscured`, and the only seam that reaches it
   * is `onValidTarget.ignoreCoverTerrain` — which also clears `seq.inCover`, i.e. the cover save.
   * So the save is put back at the Roll Defence Dice step, by recomputing what the cover would
   * have been without the ploy.
   */
  reg.on('onValidTarget', T.bind(SP_GUILT, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_GUILT)) return;
    if (!T.mineKw(ev.attacker, KW)) return;
    if (T.gap(ev.attacker, ev.target) > 4 + EPS) return;
    ev.ignoreCoverTerrain = 'all';
  });
  reg.on('onDefenceDice', T.bind(SP_GUILT, 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_GUILT)) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const target = ev.ctx.defender;
    const seq = shootSeq(ev.state);
    if (!target || !seq || seq.inCover || !T.ctx) return;
    if (ev.ctx.distance <= 2 + EPS || ev.ctx.distance > 4 + EPS) return; // "within 2" as normal"
    if (hasRule(ev.ctx.rules, 'Saturate')) return;
    const index = terrain(T.ctx, ev.state);
    const a = body(T.ctx, ev.ctx.attacker);
    const t = body(T.ctx, target);
    const cover = coverAndObscured(index, a, t, { ignore: vantageIgnoreFilter(index, a, t) });
    if (cover.inCover) ev.coverSave = true; // "it doesn't remove their cover save (if any)"
  });

  // ---- INVIOLATE JURISDICTION (strategy) ---------------------------------
  reg.on('onDefenceDice', T.bind(SP_INVIOLATE, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_INVIOLATE)) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (ev.ctx.type !== 'ranged') return; // "whenever an operative is SHOOTING a friendly operative"
    const nearObjective = Object.values(ev.state.markers).some(
      (m) => m.kind === 'objective' && T.markerGap(target, m) <= 2 + EPS,
    );
    const nearEnemy = T.enemies(ev.state).some((e) => T.gap(e, target) <= 2 + EPS);
    if (!nearObjective && !nearEnemy) return;
    ev.rerolls.push({
      id: 'exaction-squad.inviolateJurisdiction',
      label: 'Inviolate Jurisdiction: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(SP_INVIOLATE)),
    });
  });

  // ---- DISPENSE JUSTICE (strategy) ---------------------------------------
  reg.on('onWeaponRules', T.bind(SP_DISPENSE, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_DISPENSE)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    // "…if it hasn't moved more than its Move stat during the activation, or if it's a counteraction"
    if (!counteracting(ev.state, ev.operative) && movedThisActivation(ev.state, ev.operative) > moveStatOf(T, ev.operative) + EPS)
      return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Dispense Justice)'));
  });

  // ---- TERMINAL DECREE (strategy) ----------------------------------------
  reg.on('onWeaponRules', T.bind(SP_TERMINAL, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_TERMINAL)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    const close = ev.target !== undefined && T.gap(ev.operative, ev.target) <= 6 + EPS;
    if (!close && !T.kw(ev.operative, 'GUNNER')) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Terminal Decree)'));
  });

  // ---- LONG ARM OF THE EMPEROR'S LAW (firefight) -------------------------
  /**
   * "…add 3" to x." Nothing runs at the end of an action (docs/TEAM-STATUS.md § Known engine
   * gaps), so the grant is bounded to the operative's activation instead — which is exactly one
   * Shoot action for this team, since every Shoot variant it has is `treatedAs: 'Shoot'` and
   * action restrictions allow one per activation.
   */
  reg.on('onPloyUsed', T.bind(FP_LONG_ARM, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_LONG_ARM) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = active && T.mineKw(active, KW) ? active : chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW));
    if (!op) return;
    effect(ev.state, {
      rule: LONG_ARM_EFFECT,
      source: { kind: 'ploy', id: FP_LONG_ARM },
      sourceText: shortQuote(text(FP_LONG_ARM)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind(FP_LONG_ARM, 21), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!effectOn(ev.state, ev.operative.id, LONG_ARM_EFFECT)) return;
    if (isGrenade(ev.weaponName)) return; // "(excluding frag or krak grenade)"
    const range = ev.rules.find((r) => r.id === 'Range');
    if (!range) return;
    // Weapon rules are shared catalogue objects (docs/DECISIONS.md D-019) — replace, never mutate.
    ev.rules = ev.rules.map((r) =>
      r === range ? ruleTag('Range', (range.x ?? 0) + 3, `Range ${(range.x ?? 0) + 3}" (Long Arm)`) : r,
    );
  });

  // ---- EXACT PUNISHMENT (firefight) --------------------------------------
  reg.on('onPloyUsed', T.bind(FP_EXACT_PUNISHMENT, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_EXACT_PUNISHMENT) return;
    const pairing = punishmentPair(T, ev.state, ev.data);
    if (!pairing) return;
    const { friend, foe } = pairing;
    const threshold = ev.state.activeOperativeId === friend.id ? friend.apSpent : currentApl(T, ev.state, friend);
    grantFreeAction(ev.state, friend, {
      sourceId: FP_EXACT_PUNISHMENT,
      sourceText: shortQuote(text(FP_EXACT_PUNISHMENT)),
      threshold,
      only: ['Shoot', 'Fight', VIGILANT_SHOOT],
    });
    lockTarget(ev.state, friend, foe, threshold, FP_EXACT_PUNISHMENT, text(FP_EXACT_PUNISHMENT));
  });

  // ---- BRUTAL BACKUP (firefight) -----------------------------------------
  reg.on('onPloyUsed', T.bind(FP_BRUTAL_BACKUP, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_BRUTAL_BACKUP) return;
    const pairing = brutalBackupPair(T, ev.state, ev.data);
    if (!pairing) return;
    const { friend, foe } = pairing;
    const threshold = ev.state.activeOperativeId === friend.id ? friend.apSpent : currentApl(T, ev.state, friend);
    grantFreeAction(ev.state, friend, {
      sourceId: FP_BRUTAL_BACKUP,
      sourceText: shortQuote(text(FP_BRUTAL_BACKUP)),
      threshold,
      only: ['Fight'],
    });
    lockTarget(ev.state, friend, foe, threshold, FP_BRUTAL_BACKUP, text(FP_BRUTAL_BACKUP));
  });

  // The Shoot half of both target locks. The Fight half ("…or to fight against during that
  // action") has no seam: `Fight` takes its target from the intent and nothing is emitted
  // between that and `startFight`.
  reg.on('onValidTarget', T.bind(FP_EXACT_PUNISHMENT, 21), (ev) => {
    if (ev.attacker.player !== T.player) return;
    const lock = effectOn(ev.state, ev.attacker.id, TARGET_LOCK);
    if (!lock) return;
    if (ev.attacker.apSpent < Number(lock.data?.['threshold'] ?? 0)) return;
    if (ev.target.id === lock.data?.['enemyId']) return;
    ev.valid = false;
    ev.reason = 'you cannot select any other enemy operative as a valid target during that action';
  });

  // ---- EXECUTION ORDER (firefight) ---------------------------------------
  /**
   * REMINDER ONLY. Every clause hangs off "you can interrupt that activation and activate a
   * ready friendly operative", and the engine has no activation-order seam (the same wall the
   * Murderwing's MALICIOUS NARCISSISM and the Phobos Tactical Advantage hit). The marked enemy
   * is recorded as an effect so the UI can show it and a human can play the ploy by hand.
   */
  reg.on('onPloyUsed', T.bind(FP_EXECUTION_ORDER, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_EXECUTION_ORDER) return;
    const foe = chosenOperative(ev.state, ev.data, T.enemies(ev.state));
    if (!foe) return;
    effect(ev.state, {
      rule: EXECUTION_EFFECT,
      source: { kind: 'ploy', id: FP_EXECUTION_ORDER },
      sourceText: shortQuote(text(FP_EXECUTION_ORDER)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Execution Order marks ${foe.letter}` });
  });
}

function lockTarget(
  state: GameState,
  friend: OperativeState,
  foe: OperativeState,
  threshold: number,
  sourceId: string,
  sourceText: string,
): void {
  dropEffects(state, (e) => e.rule === TARGET_LOCK && e.operativeId === friend.id);
  effect(state, {
    rule: TARGET_LOCK,
    source: { kind: 'ploy', id: sourceId },
    sourceText: shortQuote(sourceText),
    operativeId: friend.id,
    player: friend.player,
    data: { enemyId: foe.id, threshold },
    expiry: { kind: 'endOfActivation', operativeId: friend.id },
  });
}

/** "…a friendly EXACTION SQUAD operative within 6" of it" — the ploy's trigger pair. */
function punishmentPair(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): { friend: OperativeState; foe: OperativeState } | undefined {
  const friends = T.friendlies(state, KW).filter((f) => T.enemies(state).some((e) => T.gap(e, f) <= 6 + EPS));
  const friend = chosenOperative(state, data, friends);
  if (!friend) return undefined;
  const foes = T.enemies(state)
    .filter((e) => T.gap(e, friend) <= 6 + EPS)
    .sort((a, b) => T.gap(a, friend) - T.gap(b, friend));
  const named = typeof data?.['targetOperativeId'] === 'string' ? foes.find((e) => e.id === data['targetOperativeId']) : undefined;
  const foe = named ?? foes[0];
  return foe ? { friend, foe } : undefined;
}

/** "Select one enemy operative within its control range. One OTHER friendly operative…" */
function brutalBackupPair(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): { friend: OperativeState; foe: OperativeState } | undefined {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!active || !T.mineKw(active, KW)) return undefined;
  const foes = T.enemies(state).filter((e) => inCR(T, state, active, e));
  const named = typeof data?.['targetOperativeId'] === 'string' ? foes.find((e) => e.id === data['targetOperativeId']) : undefined;
  const foe = named ?? foes[0];
  if (!foe) return undefined;
  const helpers = T.friendlies(state, KW).filter((f) => f.id !== active.id && inCR(T, state, f, foe));
  const friend = chosenOperative(state, data, helpers);
  return friend ? { friend, foe } : undefined;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- REINFORCED MIRROR-VISOR -------------------------------------------
  // "You can ignore any changes to the APL stat of friendly EXACTION SQUAD operatives" — a
  // *may*, so it is used exactly when it helps (D-022): net reductions are ignored, the team's
  // own SIGNAL bonus is kept.
  reg.on('onStatMod', T.bind(EQ_VISOR, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_VISOR) || !T.mineKw(ev.operative, KW)) return;
    const apl = ev.operative.aplMods.reduce((a, b) => a + b, 0) + ev.mods.apl;
    if (apl < 0) ev.mods.apl -= apl;
  });
  // "…and they aren't affected by enemy operatives' Shock weapon rule."
  reg.on('onWeaponRules', T.bind(EQ_VISOR, 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_VISOR)) return;
    if (ev.operative.player === T.player) return;
    if (!ev.target || !T.mineKw(ev.target, KW)) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Shock');
  });

  // ---- MANACLES ----------------------------------------------------------
  /**
   * The trigger is "whenever an enemy operative WOULD PERFORM the Fall Back action", but
   * `canPerformAction` is a pure query the UI and the AI run many times per activation, so
   * rolling there would burn RNG outside the reducer. The roll is taken at the start of that
   * enemy's activation instead, exactly as the Nemesis Claw's CHAIN SNARE does.
   */
  reg.on('onActivationStart', T.bind(EQ_MANACLES, 30), (ev) => {
    if (!T.ctx || !hasEquipment(ev.state, T.player, EQ_MANACLES)) return;
    if (ev.operative.player === T.player) return;
    if (usedThisTP(ev.state, `exaction-squad.manacles:${T.player}`)) return;
    const jailer = T.friendlies(ev.state, KW).find(
      (f) =>
        inCR(T, ev.state, f, ev.operative) &&
        // "if no other enemy operatives are within that friendly operative's control range"
        T.enemies(ev.state).every((e) => e.id === ev.operative.id || !inCR(T, ev.state, f, e)),
    );
    if (!jailer) return;
    // "roll two D6, or one D6 if that enemy operative has a higher Wounds stat"
    const theirs = T.card(ev.operative)?.wounds ?? 0;
    const ours = T.card(jailer)?.wounds ?? 0;
    const rolls = theirs > ours ? [T.ctx.rng.d6()] : [T.ctx.rng.d6(), T.ctx.rng.d6()];
    recordRoll(ev.state, 'manacles', rolls, T.player, 'MANACLES 4+');
    if (!rolls.some((r) => r >= 4)) return;
    // "…and you cannot use this rule again during this turning point" — only on a success.
    useOncePerTP(ev.state, `exaction-squad.manacles:${T.player}`);
    effect(ev.state, {
      rule: MANACLED,
      source: { kind: 'equipment', id: EQ_MANACLES },
      sourceText: shortQuote(text(EQ_MANACLES)),
      operativeId: ev.operative.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `MANACLES hold ${ev.operative.letter}` });
  });
  reg.on('canPerformAction', T.bind(EQ_MANACLES, 31), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player === T.player) return;
    if (!effectOn(ev.state, ev.operative.id, MANACLED)) return;
    ev.allowed = false;
    ev.reason = 'MANACLES: that enemy operative cannot Fall Back during this activation';
  });

  // ---- STROBING PHOSPHOR-LUMEN -------------------------------------------
  // REMINDER ONLY — see the module footer and the report: `RerollGrant` cannot exclude a dice
  // value, so "your opponent cannot re-roll their attack dice results of 1" has no seam.

  // ---- SPECIAL ISSUE SHELLS ----------------------------------------------
  /**
   * "Up to twice per turning point … select one of the following weapon rules for that weapon to
   * have until the end of that action." The choice is made once per Shoot action, at Select
   * Weapon, on a stated deterministic policy (D-022): Saturate when the target would otherwise
   * keep a cover save, Piercing 1 when the printed 3+ Save condition is met, and the rule is
   * declined otherwise so the twice-per-turning-point budget is not wasted. The third option
   * (Torrent 1") is never taken — see the report.
   */
  reg.on('onSelectWeapon', T.bind(EQ_SHELLS, 30), (ev) => {
    if (!T.ctx || !hasEquipment(ev.state, T.player, EQ_SHELLS)) return;
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    if (!SHOTGUNS.includes(ev.ctx.weaponName.trim().toLowerCase())) return;
    if (effectOn(ev.state, ev.ctx.attacker.id, SHELLS_EFFECT)) return;
    if (shellsUsed(ev.state, T.player) >= 2) return;
    const target = ev.ctx.defender;
    if (!target) return;
    const index = terrain(T.ctx, ev.state);
    const a = body(T.ctx, ev.ctx.attacker);
    const t = body(T.ctx, target);
    const cover = coverAndObscured(index, a, t, { ignore: vantageIgnoreFilter(index, a, t) });
    let choice: 'Saturate' | 'Piercing' | undefined;
    if (cover.inCover && !hasRule(ev.ctx.rules, 'Saturate')) choice = 'Saturate';
    else if (saveOf(T.ctx, ev.state, target) <= 3) choice = 'Piercing';
    if (!choice) return;
    setShellsUsed(ev.state, T.player, shellsUsed(ev.state, T.player) + 1);
    effect(ev.state, {
      rule: SHELLS_EFFECT,
      source: { kind: 'equipment', id: EQ_SHELLS },
      sourceText: shortQuote(text(EQ_SHELLS)),
      operativeId: ev.ctx.attacker.id,
      player: T.player,
      data: { rule: choice, weapon: ev.ctx.weaponName },
      expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Special Issue Shells: ${choice}` });
  });
  reg.on('onWeaponRules', T.bind(EQ_SHELLS, 31), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    const eff = effectOn(ev.state, ev.operative.id, SHELLS_EFFECT);
    if (!eff || eff.data?.['weapon'] !== ev.weaponName) return;
    if (eff.data['rule'] === 'Saturate') ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Special Issue Shells)'));
    // "Piercing 1, but only if the target has a Save stat of 3+ or better."
    if (eff.data['rule'] === 'Piercing' && T.ctx && ev.target && saveOf(T.ctx, ev.state, ev.target) <= 3)
      ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (Special Issue Shells)'));
  });
}

function shellsUsed(state: GameState, player: PlayerId): number {
  const b = bucket(state, 'exaction-squad.shellsUses') as Record<string, unknown>;
  return b['tp'] === state.turningPoint ? Number(b[player] ?? 0) : 0;
}
function setShellsUsed(state: GameState, player: PlayerId, n: number): void {
  const b = bucket(state, 'exaction-squad.shellsUses') as Record<string, unknown>;
  if (b['tp'] !== state.turningPoint) {
    b['tp'] = state.turningPoint;
    b['p1'] = 0;
    b['p2'] = 0;
  }
  b[player] = n;
}

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

const enemiesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, otherPlayer(op.player)).sort((a, b) => (a.id < b.id ? -1 : 1));
const friendliesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
const hasKw = (ctx: GameContext, op: OperativeState, kw: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(kw);

/** "…place it within 6" horizontally of this operative; otherwise move it up to 6" horizontally." */
function nuncioPlacement(state: GameState, op: OperativeState, params: ActionParams): { pos: { x: number; y: number }; from: { x: number; y: number }; existing: boolean } {
  const marker = state.markers[NUNCIO_MARKER(op.player)];
  const from = marker ? marker.pos : op.pos;
  const pos = params.markerPos ?? params.targetPos ?? { ...from };
  return { pos, from, existing: Boolean(marker) };
}

function actions(data: typeof DATA): ActionDef[] {
  const out: ActionDef[] = [];

  // DEPLOY NUNCIO-AQUILA — PROCTOR-EXACTANT
  out.push(
    uniqueAction(data, PROCTOR, ACT_NUNCIO, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const { pos, from } = nuncioPlacement(state, op, params);
        if (dist(pos, from) > 6 + EPS)
          return { ok: false, reason: 'the Nuncio-aquila marker moves up to 6" horizontally' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const { pos } = nuncioPlacement(state, op, params);
        const id = NUNCIO_MARKER(op.player);
        const existing = state.markers[id];
        if (existing) existing.pos = { ...pos };
        else
          state.markers[id] = {
            id,
            kind: 'generic',
            diameterMm: 20,
            pos: { ...pos },
            z: 0,
            owner: op.player,
            flags: { nuncioAquila: true },
          };
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: DEPLOY NUNCIO-AQUILA` });
        return { ok: true };
      },
    }),
  );

  // MEDIKIT — CHIRURGANT
  out.push(
    uniqueAction(data, CHIRURGANT, ACT_MEDIKIT, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return medikitTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly EXACTION SQUAD operative within control range' };
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

  // R-VR COMMAND — LEASHMASTER
  out.push(
    uniqueAction(data, LEASHMASTER, ACT_RVR_COMMAND, {
      check: (ctx, state, op, params) => {
        const mastiff = rvrTarget(ctx, state, op, params.targetOperativeId);
        if (!mastiff) return { ok: false, reason: 'select one friendly R-VR CYBER-MASTIFF operative' };
        if (patternsOf(state, mastiff).length === 0)
          return { ok: false, reason: 'that operative has no attack pattern to change' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const mastiff = rvrTarget(ctx, state, op, params.targetOperativeId)!;
        const current = patternsOf(state, mastiff);
        const spare = PATTERNS.find((p) => !current.includes(p));
        if (!spare) return { ok: true };
        // "…change one of its attack pattern": the named one, else the first in printed order.
        const drop = PATTERNS.find((p) => p === params.choice && current.includes(p)) ?? current[0]!;
        setPatterns(state, mastiff, PATTERNS.filter((p) => (current.includes(p) && p !== drop) || p === spare));
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: R-VR COMMAND — ${drop} becomes ${spare}`,
        });
        return { ok: true };
      },
    }),
  );

  // APPREHEND — R-VR CYBER-MASTIFF
  out.push(
    uniqueAction(data, MASTIFF, ACT_APPREHEND, {
      check: (ctx, state, op, params) => {
        const target = apprehendTarget(ctx, state, op, params.targetOperativeId);
        return target
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative within this operative’s control range' };
      },
      perform: (ctx, state, op, params) => {
        const target = apprehendTarget(ctx, state, op, params.targetOperativeId)!;
        // "…or until this operative performs this action again (whichever comes first)"
        dropEffects(state, (e) => e.rule === APPREHEND_TOKEN && e.data?.['by'] === op.id);
        effect(state, {
          rule: APPREHEND_TOKEN,
          source: { kind: 'ability', id: ACT_APPREHEND },
          sourceText: shortQuote(actionTextOf(MASTIFF, ACT_APPREHEND)),
          operativeId: target.id,
          player: op.player,
          data: { by: op.id },
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: APPREHEND on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // VERISCANT — MALOCATOR
  out.push(
    uniqueAction(data, MALOCATOR, ACT_VERISCANT, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return visibleEnemy(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = visibleEnemy(ctx, state, op, params.targetOperativeId)!;
        untilNextActivation(state, op, VERISCANT_TOKEN, ACT_VERISCANT, actionTextOf(MALOCATOR, ACT_VERISCANT), {
          on: target.id,
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: VERISCANT on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // OPTICS — MARKSMAN
  out.push(
    uniqueAction(data, MARKSMAN, ACT_OPTICS, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        untilNextActivation(state, op, OPTICS_EFFECT, ACT_OPTICS, actionTextOf(MARKSMAN, ACT_OPTICS));
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: OPTICS` });
        return { ok: true };
      },
    }),
  );

  // SPOT — REVELATUM
  out.push(
    uniqueAction(data, REVELATUM, ACT_SPOT, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return spotTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to and within 8" of this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = spotTarget(ctx, state, op, params.targetOperativeId)!;
        giveToken(state, target, SPOT_TOKEN, {
          sourceId: ACT_SPOT,
          sourceText: shortQuote(actionTextOf(REVELATUM, ACT_SPOT)),
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' }, // "Until the end of the turning point"
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SPOT on ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // SIGNAL — VOX-SIGNIFIER
  out.push(
    uniqueAction(data, VOX_SIGNIFIER, ACT_SIGNAL, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return signalTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly EXACTION SQUAD operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = signalTarget(ctx, state, op, params.targetOperativeId)!;
        target.aplMods.push(1);
        effect(state, {
          rule: 'exaction-squad.signal',
          source: { kind: 'ability', id: ACT_SIGNAL },
          sourceText: shortQuote(actionTextOf(VOX_SIGNIFIER, ACT_SIGNAL)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
        return { ok: true };
      },
    }),
  );

  return out;
}

function medikitTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const mates = friendliesOf(state, op)
    .filter((o) => hasKw(ctx, o, KW))
    .filter((o) => inControlRange(ctx, state, op, o))
    // "It cannot be an operative that the Medic! rule was used on during this turning point."
    .filter((o) => !Object.values(medicTargets(state)).includes(o.id));
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

function rvrTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const dogs = friendliesOf(state, op).filter((o) => o.datacardId === MASTIFF && hasKw(ctx, o, KW));
  return dogs.find((o) => o.id === chosen) ?? dogs[0];
}

function apprehendTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const foes = enemiesOf(state, op).filter((e) => inControlRange(ctx, state, op, e));
  return foes.find((e) => e.id === chosen) ?? foes[0];
}

function visibleEnemy(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const foes = enemiesOf(state, op).filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible);
  return foes.find((e) => e.id === chosen) ?? foes[0];
}

function spotTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const foes = enemiesOf(state, op)
    .filter((e) => Math.max(0, dist(e.pos, op.pos) - 1.3) <= 8 + EPS)
    .filter((e) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, e)).visible);
  return foes.find((e) => e.id === chosen) ?? foes[0];
}

function signalTarget(ctx: GameContext, state: GameState, op: OperativeState, chosen?: string): OperativeState | undefined {
  const mates = friendliesOf(state, op)
    .filter((o) => hasKw(ctx, o, KW))
    .filter((o) => isVisible(terrain(ctx, state), body(ctx, op), body(ctx, o)).visible);
  return mates.find((o) => o.id === chosen) ?? mates[0];
}

// ---------------------------------------------------------------------------
// VIGILANT › Close Quarters Vigilance — its own Shoot action (D-021)
// ---------------------------------------------------------------------------

/**
 * "This operative can perform the Shoot action (excluding Guard) while within control range of
 * an enemy operative, but only if it hasn't performed the Charge action during the activation,
 * or if it's a counteraction."
 *
 * `canPerformAction` can only forbid, so this is its own `ActionDef` with `treatedAs: 'Shoot'`
 * (D-021). The engine's only path for shooting while engaged is the point-blank one, so the
 * shot goes through it and the point-blank Hit penalty — which this rule does not print — is
 * cancelled by the `onStatMod` handler bound to the ability. The visibility and Conceal-in-cover
 * checks that the point-blank path waives are re-applied here, because the printed rule lifts
 * only the "within control range" restriction.
 */
function vigilantShot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string; weaponName?: string; profileName?: string; targetId?: string } {
  if (enemiesInControlRange(ctx, state, op).length === 0)
    return { ok: false, reason: 'no enemy operative within control range — use the Shoot action' };
  if (op.actionsThisActivation.includes('Charge') && state.opState['counteract']?.['operativeId'] !== op.id)
    return { ok: false, reason: 'it performed the Charge action during this activation' };
  const ranged = weaponsOf(ctx, state, op, 'ranged');
  const weapon = params.weaponName ? ranged.find((w) => w.name === params.weaponName) : ranged[0];
  if (!weapon) return { ok: false, reason: 'operative has no ranged weapon' };
  const profile = findProfile(weapon, params.profileName);
  if (!profile) return { ok: false, reason: `weapon '${weapon.name}' has no such profile` };
  if (op.order === 'conceal' && !weapon.profiles.some((p) => p.rules.some((r) => r.id === 'Silent')))
    return { ok: false, reason: 'cannot Shoot with a Conceal order' };
  if (profile.rules.some((r) => r.id === 'Heavy') && op.actionsThisActivation.some((a) => MOVES.includes(a)))
    return { ok: false, reason: `${weapon.name} is Heavy — it cannot be used in an activation in which the operative moved` };
  const targetId = params.targetId ?? params.targetOperativeId;
  const target = targetId ? state.operatives[targetId] : undefined;
  if (!target || target.removed || target.player === op.player)
    return { ok: false, reason: 'select an enemy operative as the target' };
  const rules = effectiveRules(ctx, state, profile, { operative: op, target, weaponName: weapon.name });
  const check = checkTarget(ctx, state, op, target, profile, rules, { pointBlank: true });
  if (!check.valid) return { ok: false, reason: check.reason ?? 'not a valid target' };
  if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
    return { ok: false, reason: 'not visible' };
  if (target.order === 'conceal' && check.inCover)
    return { ok: false, reason: 'target has a Conceal order and is in cover' };
  // "has no friendly operatives within its control range" — Ruthless Efficiency lifts it for
  // friendly EXACTION SQUAD operatives only, so a non-EXACTION SQUAD friendly still blocks.
  const blocker = aliveOperatives(state, op.player).some(
    (f) => f.id !== op.id && inControlRange(ctx, state, f, target) && !hasKw(ctx, f, KW),
  );
  if (blocker) return { ok: false, reason: 'a friendly operative is within the target’s control range' };
  return { ok: true, weaponName: weapon.name, targetId: target.id, ...(params.profileName ? { profileName: params.profileName } : {}) };
}

const MOVES = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

registerAction({
  id: VIGILANT_SHOOT,
  name: 'Shoot (Close Quarters Vigilance)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(VIGILANT, AB_CQ_VIGILANCE),
  available: (_ctx, _state, op) => op.datacardId === VIGILANT,
  check(ctx, state, op, params) {
    const r = vigilantShot(ctx, state, op, params);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'not possible' };
  },
  perform(ctx, state, op, params) {
    const r = vigilantShot(ctx, state, op, params);
    if (!r.ok) return { ok: false, reason: r.reason ?? 'not possible' };
    effect(state, {
      rule: POINT_BLANK_CANCEL,
      source: { kind: 'ability', id: AB_CQ_VIGILANCE },
      sourceText: shortQuote(abilityText(VIGILANT, AB_CQ_VIGILANCE)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    const started = startShoot(ctx, state, op, r.weaponName!, r.profileName, r.targetId!, { pointBlank: true });
    if (!started.ok) return started;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------

export const exactionSquad = defineTeam({
  id: 'exaction-squad',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "…after an enemy operative shoots against or fights against a friendly EXACTION SQUAD
    //  operative within 6" of it"
    [FP_EXACT_PUNISHMENT]: (state, player) => {
      const mine = aliveOperatives(state, player);
      const foes = aliveOperatives(state, otherPlayer(player));
      const near = mine.some((f) => foes.some((e) => dist(e.pos, f.pos) <= 6 + 1.6));
      return near ? { ok: true } : { ok: false, reason: 'no friendly operative within 6" of an enemy operative' };
    },
    // "Use this firefight ploy during a friendly EXACTION SQUAD operative's activation."
    [FP_BRUTAL_BACKUP]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'only during a friendly EXACTION SQUAD operative’s activation' };
    },
    [FP_EXECUTION_ORDER]: (state, player) =>
      aliveOperatives(state, otherPlayer(player)).length > 0
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative to mark' },
  },
  aiHints: {
    roles: {
      [PROCTOR]: 'leader',
      [CASTIGATOR]: 'melee',
      [CHIRURGANT]: 'support',
      [GUNNER]: 'gunner',
      [LEASHMASTER]: 'support',
      [MASTIFF]: 'melee',
      [MALOCATOR]: 'support',
      [MARKSMAN]: 'sniper',
      [REVELATUM]: 'scout',
      [SUBDUCTOR]: 'objective',
      [VIGILANT]: 'objective',
      [VOX_SIGNIFIER]: 'support',
    },
    ployValue: {
      [SP_GUILT]: 0.5,
      [SP_INVIOLATE]: 0.5,
      [SP_DISPENSE]: 0.6,
      [SP_TERMINAL]: 0.6,
      [FP_LONG_ARM]: 0.4,
      [FP_EXACT_PUNISHMENT]: 0.6,
      [FP_BRUTAL_BACKUP]: 0.5,
      [FP_EXECUTION_ORDER]: 0.2,
    },
    equipmentValue: {
      [EQ_VISOR]: 0.4,
      [EQ_MANACLES]: 0.4,
      [EQ_LUMEN]: 0.3,
      [EQ_SHELLS]: 0.6,
    },
  },
});

export default exactionSquad;
