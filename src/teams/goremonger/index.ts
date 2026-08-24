/**
 * GOREMONGER — World Eaters gore-fuelled butchers.
 * https://wahapedia.ru/kill-team3/kill-teams/goremonger/
 *
 * Seven datacards, eleven abilities, two unique actions, three faction rules.
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read
 * from `data/teams/goremonger.json` at module load and never retyped. One printed structure is a
 * MENU with no ids of its own — the six **SANGUAVITAE** rules, printed inside the one Sanguavitae
 * faction rule as `<name>\nWHEN: …\nEFFECT: …` — so each one's text is sliced out of that string
 * here (the Legionary "Marks of Chaos" / Warpcoven BOONS / Hand of the Archon INVIGORATIONS
 * treatment).
 *
 * The whole team hangs off ONE economy — the **GORE TANK**, a three-level gauge
 * (`goreTankOf`/`increaseGoreTank`/`decreaseGoreTank`) that fourteen rules read or write. It is an
 * effect on the operative that holds it (`data.level`), so the UI sees it in `state.effects` and
 * it replays byte-identically.
 *
 * **The engine has no "use a rule now" intent**, so the six SANGUAVITAE rules are registered as
 * their own 0AP `ActionDef`s — `SANGUAVITAE (Rejuvenate)` and friends (D-021, the Blades of Khaine
 * "Aspect Technique (…)" 0AP declaration precedent). That makes them AI-reachable, gives each its
 * own action-restriction key (which is exactly "you cannot use the same SANGUAVITAE rule more than
 * once per activation"), and keeps the whole legality of each in `check` (D-026). The one thing it
 * cannot reach is a COUNTERACTION: the reducer refuses any action that is not 1AP while
 * counteracting and allows only one action, so "…or counteraction" is unreachable for every
 * SANGUAVITAE rule — reported, not faked.
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import { baseGap, baseRadius, dist } from '../../core/geometry.ts';
import { validateMove } from '../../core/movement.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  findProfile,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  modelHeight,
  recordRoll,
  startingWounds,
  weaponsOf,
} from '../../core/state.ts';
import {
  baseBlockedByTerrain,
  baseTouchesHazardous,
  hasType,
  partsSupporting,
  surfaceAt,
} from '../../core/terrain.ts';
import { isVisible } from '../../core/visibility.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Vec2,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  bucket,
  defineTeam,
  dropEffects,
  makeTeamHooks,
  effect,
  effectOn,
  effectsOn,
  gambitUsed,
  hasEquipment,
  placeTeamMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('goremonger');
export const KW = 'GOREMONGER';
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Printed ids
// ---------------------------------------------------------------------------

export const C = {
  bloodHerald: 'goremonger.blood-herald',
  aspirant: 'goremonger.aspirant',
  bloodtaker: 'goremonger.bloodtaker',
  impaler: 'goremonger.impaler',
  inciter: 'goremonger.inciter',
  skullclaimer: 'goremonger.skullclaimer',
  stalker: 'goremonger.stalker',
} as const;

export const RULE = {
  runesOfKhorne: 'goremonger.rule.runes-of-khorne',
  goreTanks: 'goremonger.rule.gore-tanks',
  sanguavitae: 'goremonger.rule.sanguavitae',
} as const;

export const SP = {
  enhancedViolence: 'goremonger.sp.enhanced-violence',
  augmentedEndurance: 'goremonger.sp.augmented-endurance',
  goryTenacity: 'goremonger.sp.gory-tenacity',
  huntForBlood: 'goremonger.sp.hunt-for-blood',
} as const;

export const FP = {
  unbridledAggression: 'goremonger.fp.unbridled-aggression',
  gorethirst: 'goremonger.fp.gorethirst',
  destructiveDemise: 'goremonger.fp.destructive-demise',
  lacerateFlesh: 'goremonger.fp.lacerate-flesh',
} as const;

export const EQ = {
  goryTotem: 'goremonger.eq.gory-totem',
  bloodyCadaver: 'goremonger.eq.bloody-cadaver',
  chaosSigil: 'goremonger.eq.chaos-sigil',
  wristChains: 'goremonger.eq.wrist-chains',
} as const;

export const AB = {
  khornesFavour: 'goremonger.blood-herald.khornes-favour',
  impendingApotheosis: 'goremonger.blood-herald.impending-apotheosis',
  obsessiveBloodlust: 'goremonger.aspirant.obsessive-bloodlust',
  ritual: 'goremonger.bloodtaker.ritual',
  drag: 'goremonger.impaler.drag',
  prey: 'goremonger.impaler.prey',
  inciteTheHunt: 'goremonger.inciter.incite-the-hunt',
  brutish: 'goremonger.skullclaimer.brutish',
  claimSkull: 'goremonger.skullclaimer.claim-skull',
  climbingPicks: 'goremonger.stalker.climbing-picks',
  rooftopStalker: 'goremonger.stalker.rooftop-stalker',
} as const;

export const ACT = {
  transfusionRitual: 'goremonger.bloodtaker.act.transfusion-ritual',
  dashAndSpray: 'goremonger.inciter.act.dash-and-spray',
} as const;

/** The carve-out actions this module owns (docs/DECISIONS.md D-021). */
export const FIGHT_FURY = 'Fight (Fury)';
export const CHARGE_BLOODLUST = 'Charge (Obsessive Bloodlust)';
export const CHARGE_HUNT = 'Charge (Hunt for Blood)';
export const PICK_UP_CADAVER = 'Pick Up Marker (Bloody Cadaver)';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const shootSeq = (state: GameState): ShootSequence | null =>
  state.sequence?.kind === 'shoot' ? state.sequence : null;
const fightSeq = (state: GameState): FightSequence | null =>
  state.sequence?.kind === 'fight' ? state.sequence : null;

const isGoremongerCard = (op: OperativeState): boolean => op.datacardId.startsWith('goremonger.');

/**
 * `PloyDef.usable` is a pure `(state, player)` query with no `GameContext`, but the predicates it
 * needs are written against the same `TeamHooks` facade every rule uses — and the static datacard
 * catalogue is enough for all of them (keywords and base sizes). Built once at module load, so
 * there is no module-level MUTABLE state (architecture rule 7).
 */
const STATIC_HOOKS: Record<PlayerId, TeamHooks> = {
  p1: makeTeamHooks(DATA, 'p1'),
  p2: makeTeamHooks(DATA, 'p2'),
};
const staticHooks = (player: PlayerId): TeamHooks => STATIC_HOOKS[player];

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

/** Every rule that says "an operative" rather than "an enemy operative" needs the killer's id. */
function actingOperative(state: GameState): OperativeState | undefined {
  const seq = state.sequence;
  if (seq?.kind === 'shoot') return state.operatives[seq.attackerId];
  if (seq?.kind === 'fight')
    return state.operatives[seq.turn === 'attacker' ? seq.attackerId : seq.defenderId];
  return state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
}

/** The weapon the operative resolving a fight die is striking with. */
function strikingFightWeapon(seq: FightSequence): string {
  return seq.turn === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
}

/**
 * A fingerprint for "this Shoot action", which the engine gives no id of its own. The reducer
 * pushes `actionsThisActivation`/`apSpent` only after `perform` returns, so both are stable for
 * the whole sequence, Blast/Torrent secondaries included.
 */
function shootActionKey(state: GameState, seq: ShootSequence): string {
  const attacker = state.operatives[seq.attackerId];
  return `${state.turningPoint}|${state.activationsThisTP}|${seq.attackerId}|${
    attacker?.actionsThisActivation.length ?? 0
  }|${attacker?.apSpent ?? 0}`;
}

/** The same fingerprint for a fight — the pair alone is not enough, Fury fights twice. */
function fightKey(state: GameState, seq: FightSequence): string {
  const attacker = state.operatives[seq.attackerId];
  return `${state.turningPoint}|${state.activationsThisTP}|${seq.attackerId}:${seq.defenderId}|${
    attacker?.actionsThisActivation.length ?? 0
  }|${attacker?.apSpent ?? 0}`;
}

// ---------------------------------------------------------------------------
// GORE TANKS — the team's one economy (faction rule 2)
// ---------------------------------------------------------------------------

/**
 * "Each friendly GOREMONGER operative has a GORE TANK that has three levels: full, half and
 * empty. They start the battle at half."
 *
 * The gauge is an effect on the operative that holds it, so it is state the UI can read (the
 * printed marker guide names a "Gore Tank token (full)" and a "Gore Tank token (half)"). An
 * operative with no effect yet is at half, which is where every operative starts — the effect is
 * created the first time the level actually changes, never on a read.
 */
export const GORE_TANK = 'goremonger.goreTank';
export type GoreLevel = 0 | 1 | 2;
export const GORE_LEVEL_NAME: Record<GoreLevel, string> = { 0: 'empty', 1: 'half', 2: 'full' };

export function goreTankOf(state: GameState, op: OperativeState): GoreLevel {
  const raw = Number(effectOn(state, op.id, GORE_TANK)?.data?.['level'] ?? 1);
  return (raw <= 0 ? 0 : raw >= 2 ? 2 : 1) as GoreLevel;
}

function setGoreTank(state: GameState, op: OperativeState, level: GoreLevel): void {
  const eff = effectOn(state, op.id, GORE_TANK);
  if (eff) {
    eff.data = { ...(eff.data ?? {}), level };
    return;
  }
  effect(state, {
    rule: GORE_TANK,
    source: { kind: 'ability', id: RULE.goreTanks },
    sourceText: shortQuote(text(RULE.goreTanks)),
    operativeId: op.id,
    player: op.player,
    data: { level },
    expiry: { kind: 'endOfBattle' },
  });
}

/** "Whenever a GORE TANK increases, it goes up one level… cannot increase when it's already full." */
export function increaseGoreTank(state: GameState, op: OperativeState, why: string): boolean {
  if (op.removed) return false;
  const level = goreTankOf(state, op);
  if (level >= 2) return false;
  const next = (level + 1) as GoreLevel;
  setGoreTank(state, op, next);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter}'s GORE TANK increases to ${GORE_LEVEL_NAME[next]} (${why})`,
    data: { operativeId: op.id, goreTank: next, source: why },
  });
  return true;
}

/** "…whenever it decreases, it goes down one level… cannot decrease when it's already empty." */
export function decreaseGoreTank(state: GameState, op: OperativeState, why: string): boolean {
  const level = goreTankOf(state, op);
  if (level <= 0) return false;
  const next = (level - 1) as GoreLevel;
  setGoreTank(state, op, next);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter}'s GORE TANK decreases to ${GORE_LEVEL_NAME[next]} (${why})`,
    data: { operativeId: op.id, goreTank: next, source: why },
  });
  khornesFavour(state, op);
  return true;
}

/**
 * BLOOD HERALD › Khorne's Favour. "Once during each of this operative's activations, before or
 * after it performs an action, if its GORE TANK is empty, you can increase its GORE TANK."
 *
 * Free and strictly good, so it is auto-used on its printed trigger (D-022): at the start of the
 * BLOOD HERALD's activation, and again the moment its tank runs dry during that activation.
 */
export const KHORNES_FAVOUR_USED = 'goremonger.khornesFavourUsed';

export function khornesFavour(state: GameState, op: OperativeState): boolean {
  if (op.datacardId !== C.bloodHerald || op.removed) return false;
  if (state.activeOperativeId !== op.id) return false; // "during THIS operative's activations"
  if (goreTankOf(state, op) !== 0) return false;
  if (effectOn(state, op.id, KHORNES_FAVOUR_USED)) return false;
  effect(state, {
    rule: KHORNES_FAVOUR_USED,
    source: { kind: 'ability', id: AB.khornesFavour },
    sourceText: shortQuote(abilityText(C.bloodHerald, AB.khornesFavour)),
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  return increaseGoreTank(state, op, 'Khorne’s Favour');
}

// ---------------------------------------------------------------------------
// SANGUAVITAE (faction rule 3) — a MENU with no printed ids
// ---------------------------------------------------------------------------

export const SANGUAVITAE = ['rejuvenate', 'mania', 'fury', 'rake', 'surge', 'rage'] as const;
export type Sanguavitae = (typeof SANGUAVITAE)[number];

export const SANGUAVITAE_NAME: Record<Sanguavitae, string> = {
  rejuvenate: 'Rejuvenate',
  mania: 'Mania',
  fury: 'Fury',
  rake: 'Rake',
  surge: 'Surge',
  rage: 'Rage',
};

/**
 * The six SANGUAVITAE rules are printed inside the one Sanguavitae faction rule as
 * `<name>\nWHEN: …\nEFFECT: …`, with no ids of their own, so each one's printed text is sliced out
 * of that string here rather than being retyped (CLAUDE.md: rule text is data).
 */
export const SANGUAVITAE_TEXT: Record<Sanguavitae, string> = sliceSanguavitae();

function sliceSanguavitae(): Record<Sanguavitae, string> {
  const whole = text(RULE.sanguavitae);
  const marks = SANGUAVITAE.map((id) => {
    const name = SANGUAVITAE_NAME[id];
    const at = whole.indexOf(`\n${name}\nWHEN:`);
    return { id, name, at, from: at + 1 + name.length };
  });
  const out = {} as Record<Sanguavitae, string>;
  marks.forEach((mark, i) => {
    if (mark.at < 0) throw new Error(`SANGUAVITAE rule '${mark.name}' is not in data/teams/goremonger.json`);
    const to = marks[i + 1]?.at ?? whole.length;
    out[mark.id] = whole.slice(mark.from, to < 0 ? whole.length : to).trim();
  });
  return out;
}

/** Each SANGUAVITAE rule is its own 0AP declaration action (D-021). */
export const SANGUAVITAE_ACTION: Record<Sanguavitae, string> = {
  rejuvenate: 'SANGUAVITAE (Rejuvenate)',
  mania: 'SANGUAVITAE (Mania)',
  fury: 'SANGUAVITAE (Fury)',
  rake: 'SANGUAVITAE (Rake)',
  surge: 'SANGUAVITAE (Surge)',
  rage: 'SANGUAVITAE (Rage)',
};

/** One effect per use, so the per-activation budget expires with the activation. */
export const SANGUAVITAE_USED = 'goremonger.sanguavitaeUsed';
export const MANIA = 'goremonger.mania';
export const FURY = 'goremonger.fury';
export const SURGE = 'goremonger.surge';
export const RAGE = 'goremonger.rage';

export function sanguavitaeUsed(state: GameState, op: OperativeState): Sanguavitae[] {
  return effectsOn(state, op.id, SANGUAVITAE_USED).map((e) => String(e.data?.['rule'] ?? '') as Sanguavitae);
}

/**
 * "Each SANGUAVITAE rule specifies when it can be used, and you must decrease the operative's GORE
 * TANK to do so. You cannot use the same SANGUAVITAE rule more than once per activation or
 * counteraction, and you cannot use more than two SANGUAVITAE rules per activation or
 * counteraction. You cannot use Mania and Fury during the same activation."
 */
export function canUseSanguavitae(
  state: GameState,
  op: OperativeState,
  which: Sanguavitae,
): { ok: boolean; reason?: string } {
  if (goreTankOf(state, op) === 0) return { ok: false, reason: 'its GORE TANK is empty' };
  const used = sanguavitaeUsed(state, op);
  if (used.includes(which))
    return { ok: false, reason: 'you cannot use the same SANGUAVITAE rule more than once per activation' };
  if (used.length >= 2)
    return { ok: false, reason: 'you cannot use more than two SANGUAVITAE rules per activation' };
  if ((which === 'mania' && used.includes('fury')) || (which === 'fury' && used.includes('mania')))
    return { ok: false, reason: 'you cannot use Mania and Fury during the same activation' };
  return { ok: true };
}

function claimSanguavitae(state: GameState, op: OperativeState, which: Sanguavitae): void {
  effect(state, {
    rule: SANGUAVITAE_USED,
    source: { kind: 'ability', id: RULE.sanguavitae },
    sourceText: shortQuote(SANGUAVITAE_TEXT[which]),
    operativeId: op.id,
    player: op.player,
    data: { rule: which },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'ploy',
    player: op.player,
    text: `${op.letter} uses SANGUAVITAE: ${SANGUAVITAE_NAME[which]}`,
    data: { operativeId: op.id, sanguavitae: which },
  });
  decreaseGoreTank(state, op, `SANGUAVITAE: ${SANGUAVITAE_NAME[which]}`);
}

// ---------------------------------------------------------------------------
// Bleeding tokens (INCITER) and the Impaler's Prey setter
// ---------------------------------------------------------------------------

export const BLEEDING = 'goremonger.bleeding';

export function hasBleeding(state: GameState, operativeId: string, player: PlayerId): boolean {
  return state.effects.some((e) => e.rule === BLEEDING && e.operativeId === operativeId && e.player === player);
}

/**
 * Prey. "…you can discard any of your successful unblocked attack dice. In other words, you can
 * choose not to inflict damage with any number of them."
 *
 * `onDamage` cannot raise a decision without stalling the sequence (D-022), and a discard can only
 * ever LOWER the damage the shooter inflicts, so there is no honest deterministic policy that
 * fires: the default is to discard nothing. The choice is therefore a pure setter (D-017) the UI
 * calls before the shot — which makes Prey live in the app and inert in AI-driven games.
 */
export function setPreyDiscard(
  state: GameState,
  attackerId: string,
  discard: { crits?: number; normals?: number },
): void {
  const store = bucket(state, 'goremonger.prey') as Record<string, { crits: number; normals: number }>;
  store[attackerId] = { crits: Math.max(0, discard.crits ?? 0), normals: Math.max(0, discard.normals ?? 0) };
}

export function preyDiscard(state: GameState, attackerId: string): { crits: number; normals: number } {
  const store = bucket(state, 'goremonger.prey') as Record<string, { crits: number; normals: number } | undefined>;
  return store[attackerId] ?? { crits: 0, normals: 0 };
}

// ---------------------------------------------------------------------------
// Clauses with no seam — named, never registered as a silent no-op
// ---------------------------------------------------------------------------

export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE.sanguavitae}.counteraction`]:
    'the reducer refuses any action that is not 1AP while counteracting and allows exactly one action, so a 0AP SANGUAVITAE declaration cannot be made during a counteraction — every "…or counteraction" clause of the six rules is unreachable',
  [AB.climbingPicks]:
    'onMoveRules is declared but never emitted and onMoveDistance only scales the whole allowance, so "treat the vertical distance as 2\\" whenever this operative is climbing up" has no per-leg seam (the Ratlings Grappling Hook / Void-Dancer Panoply gap)',
  [`${EQ.goryTotem}.fight`]:
    'fight.ts emits no onRollAttack (D-031), so "your opponent cannot re-roll their attack dice" is exact when the enemy is shooting and unreachable when it is fighting or retaliating',
  [`${FP.destructiveDemise}.timing`]:
    'onIncapacitated fires deep inside inflictDamage and the reducer cannot be re-entered from there, so the ploy is declared in advance and pays out on its printed trigger (the Celestian GLORIOUS MARTYRDOM shape)',
  [`${FP.unbridledAggression}.window`]:
    'advanceFight runs a whole fight inside the Fight action and enumerateCandidates offers no ploy while a decision is pending, so "at the end of the Roll Attack Dice step" is declared before the Fight action instead; the Severe grant itself is exact',
  [`${ACT.dashAndSpray}.order`]:
    'the engine cannot interleave two actions, so "in any order" is the deterministic Dash-then-Shoot order (D-016) — a Shoot first would leave the sequence mid-flight with the Dash unresolvable',
};

// ---------------------------------------------------------------------------
// Faction rules, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  runesOfKhorne(reg, T, mine);
  goreTanks(reg, T, mine);
  sanguavitae(reg, T, mine);
  bloodHerald(reg, T);
  bloodtaker(reg, T);
  impaler(reg, T);
  inciter(reg, T, mine);
  skullclaimer(reg, T);
  stalker(reg, T);
}

// ---------------------------------------------------------------------------

/** "Each friendly GOREMONGER operative cannot lose more than 8 wounds per Shoot action." */
function runesOfKhorne(reg: HookRegistry, T: TeamHooks, mine: (op: OperativeState) => boolean): void {
  // Bound LAST (95) so every rule that changes the damage — Impending Apotheosis, Brutish — has
  // already had its say and `ev.amount` is the damage that would actually be inflicted.
  reg.on('onDamage', T.bind(RULE.runesOfKhorne, 95), (ev) => {
    if (!mine(ev.target)) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    // One entry per operative rather than per action, so the ledger cannot grow without bound.
    const key = shootActionKey(ev.state, seq);
    const store = bucket(ev.state, 'goremonger.runes') as Record<string, { key: string; lost: number } | undefined>;
    const held = store[ev.target.id];
    const lost = held?.key === key ? held.lost : 0;
    const allowed = Math.max(0, 8 - lost);
    const amount = Math.max(0, Math.round(ev.amount));
    if (amount > allowed) {
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Runes of Khorne: ${ev.target.letter} cannot lose more than 8 wounds in one Shoot action (${amount} → ${allowed})`,
        data: { operativeId: ev.target.id, capped: amount - allowed },
      });
      ev.amount = allowed;
    }
    store[ev.target.id] = { key, lost: lost + Math.min(amount, allowed) };
  });
}

// ---------------------------------------------------------------------------

function goreTanks(reg: HookRegistry, T: TeamHooks, mine: (op: OperativeState) => boolean): void {
  /*
   * "Whenever a friendly GOREMONGER operative incapacitates an operative within its control range,
   *  or visible to and within 2" of it, you can increase its GORE TANK."
   *
   * Free and strictly good, so it is auto-used on the printed trigger (D-022). Note the printed
   * text says "an operative", not "an enemy operative" — a friendly kill pays too.
   */
  reg.on('onIncapacitated', T.bind(RULE.goreTanks, 20), (ev) => {
    if (ev.prevented) return;
    const killer = actingOperative(ev.state);
    if (!killer || killer.removed || !mine(killer)) return;
    if (killer.id === ev.operative.id) return;
    if (!inKillRange(T, ev.state, killer, ev.operative)) return;
    increaseGoreTank(ev.state, killer, 'incapacitated an operative nearby');
  });
}

/** "…within its control range, or visible to and within 2" of it". */
function inKillRange(T: TeamHooks, state: GameState, op: OperativeState, victim: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx) return T.gap(op, victim) <= 2 + EPS;
  if (inControlRange(ctx, state, op, victim)) return true;
  if (T.gap(op, victim) > 2 + EPS) return false;
  return isVisible(terrain(ctx, state), body(ctx, op), body(ctx, victim)).visible;
}

// ---------------------------------------------------------------------------

function sanguavitae(reg: HookRegistry, T: TeamHooks, mine: (op: OperativeState) => boolean): void {
  // Mania — "Until the start of that operative's next activation, add 1 to its APL stat."
  // This really is an APL STAT change, so it must go through the ±1 clamp — but `op.aplMods` has
  // no owner in the core, and a modifier pushed into it stands for the rest of the battle unless
  // the team pops it by hand at the right moment (the Ratlings upkeep). `aplOf` also consults
  // `onStatMod`, which is clamped the same way and is read live, so riding the hook off the
  // effect expires the +1 exactly when the effect does and leaves nothing behind.
  reg.on('onStatMod', T.bindText(`${RULE.sanguavitae}.mania`, SANGUAVITAE_TEXT.mania, 12), (ev) => {
    if (!mine(ev.operative)) return;
    if (!effectOn(ev.state, ev.operative.id, MANIA)) return;
    ev.mods.apl += 1;
  });
  reg.on('onActivationStart', T.bindText(`${RULE.sanguavitae}.mania`, SANGUAVITAE_TEXT.mania, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === MANIA && e.operativeId === ev.operative.id);
  });

  // Surge — "Until the end of that action, add 1" to that operative's Move stat."
  // `onMoveDistance` is also emitted from the action's `check` (validateMove), so this handler
  // must stay a pure read: the declaration is spent when it is made, not when the move happens.
  reg.on('onMoveDistance', T.bindText(`${RULE.sanguavitae}.surge`, SANGUAVITAE_TEXT.surge, 12), (ev) => {
    if (!mine(ev.operative)) return;
    if (ev.action !== 'Charge' && ev.action !== 'Reposition') return;
    if (!effectOn(ev.state, ev.operative.id, SURGE)) return;
    ev.inches += 1;
  });

  // Rage — "Until the end of that action, add 1 to the Atk stat of that operative's melee weapons."
  // `fight.ts` reads `mods.atk` from `onCollectAttackDice`, so this is live for the Fight action;
  // it is claimed by the FIRST fight the operative attacks in, so Fury's second Fight is not
  // covered by one declaration.
  reg.on('onCollectAttackDice', T.bindText(`${RULE.sanguavitae}.rage`, SANGUAVITAE_TEXT.rage, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || !mine(ev.ctx.attacker)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return; // "is fighting", not retaliating
    const eff = effectOn(ev.state, ev.ctx.attacker.id, RAGE);
    if (!eff) return;
    const key = fightKey(ev.state, seq);
    const usedIn = eff.data?.['usedIn'];
    if (typeof usedIn === 'string' && usedIn !== key) return;
    eff.data = { ...(eff.data ?? {}), usedIn: key };
    ev.mods.atk += 1;
  });
}

// ---------------------------------------------------------------------------

function bloodHerald(reg: HookRegistry, T: TeamHooks): void {
  // Khorne's Favour — "before or after it performs an action": the start of its activation, plus
  // every moment its tank runs dry during that activation (`decreaseGoreTank` calls it).
  reg.on('onActivationStart', T.bind(AB.khornesFavour, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    khornesFavour(ev.state, ev.operative);
  });

  /*
   * Impending Apotheosis. "Once per battle, when an attack dice inflicts Normal Dmg on this
   * operative, you can ignore that inflicted damage."
   *
   * A fight inflicts one dice at a time, so the normal strike is exact. A shoot aggregates every
   * unblocked dice into one `inflictDamage` call, so one normal dice's worth is subtracted off the
   * total (the Mandrakes Oubliex read). D-022 policy, written here because `onDamage` cannot ask:
   * spend it on damage of 3+ or on a blow that would incapacitate the BLOOD HERALD.
   */
  reg.on('onDamage', T.bind(AB.impendingApotheosis, 90), (ev) => {
    if (ev.kind !== 'attack' || ev.target.player !== T.player) return;
    if (ev.target.datacardId !== C.bloodHerald) return;
    const normal = normalDamageOn(T, ev.state, ev.target);
    if (normal === undefined || normal <= 0 || ev.amount <= 0) return;
    const amount = Math.max(0, Math.round(ev.amount));
    if (amount < 3 && amount < ev.target.wounds) return; // policy: keep it for a real blow
    if (!useOncePerBattle(ev.state, `goremonger.impendingApotheosis.${ev.target.id}`)) return;
    ev.amount = Math.max(0, amount - normal);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Impending Apotheosis: ${ev.target.letter} ignores ${Math.min(normal, amount)} Normal Dmg`,
      data: { operativeId: ev.target.id },
    });
  });
}

/** The Normal Dmg one unblocked attack dice of the in-flight sequence would inflict, if any. */
function normalDamageOn(T: TeamHooks, state: GameState, target: OperativeState): number | undefined {
  const ctx = T.ctx;
  const fight = fightSeq(state);
  if (fight && ctx) {
    const side = fight.turn;
    const striker = side === 'attacker' ? fight.attackerId : fight.defenderId;
    if (striker === target.id) return undefined;
    const { profile } = sideWeapon(ctx, state, fight, side);
    // The die in hand is a normal success only when the damage matches Normal Dmg.
    return profile.dmgN;
  }
  const shoot = shootSeq(state);
  if (shoot && shoot.targetId === target.id) {
    const profile = shotProfile(T, state, shoot);
    if (!profile) return undefined;
    return shoot.attack.dice.some((d) => d.state === 'normal') ? profile.dmgN : 0;
  }
  return undefined;
}

function shotProfile(T: TeamHooks, state: GameState, seq: ShootSequence): WeaponProfile | undefined {
  const ctx = T.ctx;
  const attacker = state.operatives[seq.attackerId];
  if (!ctx || !attacker) return undefined;
  const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
  return w ? findProfile(w, seq.profileName) : undefined;
}

// ---------------------------------------------------------------------------

function bloodtaker(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Ritual (the rare weapon rule, printed as the BLOODTAKER's datacard ability). "Whenever this
   * operative is using this weapon, the first time you inflict damage on an operative within its
   * control range during that sequence, you can increase this operative's GORE TANK."
   *
   * The ritual blade is melee, so the sequence is a fight; "using this weapon" covers retaliating
   * too, which is why the striker is read off `seq.turn` rather than the attacker slot.
   */
  reg.on('onDamage', T.bind(AB.ritual, 40), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || ev.kind !== 'attack') return;
    const striker = ev.state.operatives[seq.turn === 'attacker' ? seq.attackerId : seq.defenderId];
    if (!striker || striker.datacardId !== C.bloodtaker || striker.player !== T.player) return;
    if ((strikingFightWeapon(seq) ?? '').trim().toLowerCase() !== 'ritual blade') return;
    const ctx = T.ctx;
    if (ctx && !inControlRange(ctx, ev.state, striker, ev.target)) return;
    const store = bucket(ev.state, 'goremonger.ritual') as Record<string, string | undefined>;
    const key = fightKey(ev.state, seq);
    if (store[striker.id] === key) return; // "the FIRST time … during that sequence"
    store[striker.id] = key;
    increaseGoreTank(ev.state, striker, 'Ritual');
  });
}

// ---------------------------------------------------------------------------

function impaler(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Drag. "Whenever this operative is shooting with this weapon, at the start of the Resolve Attack
   * Dice step (before inflicting damage), you can move the target up to x". X is your total number
   * of successful unblocked attack dice, multiplied by 2."
   *
   * `inflictDamage` emits `onDamage` BEFORE it subtracts the wounds, which is exactly "before
   * inflicting damage" in the Resolve Attack Dice step. D-022 policy: always drag the maximum, and
   * Prey (below) then decides how much damage to keep.
   */
  reg.on('onDamage', T.bind(AB.drag, 30), (ev) => {
    const seq = shootSeq(ev.state);
    const ctx = T.ctx;
    if (!seq || !ctx || ev.kind !== 'attack') return;
    if (seq.targetId !== ev.target.id) return;
    const shooter = ev.state.operatives[seq.attackerId];
    if (!shooter || shooter.player !== T.player || shooter.datacardId !== C.impaler) return;
    if ((seq.weaponName ?? '').trim().toLowerCase() !== 'fleshskewer' || seq.profileName !== 'ranged') return;
    const store = bucket(ev.state, 'goremonger.drag') as Record<string, string | undefined>;
    const key = `${shootActionKey(ev.state, seq)}|${ev.target.id}`;
    if (store[shooter.id] === key) return;
    store[shooter.id] = key;
    const successes =
      seq.attack.dice.filter((d) => d.state === 'crit').length + seq.attack.dice.filter((d) => d.state === 'normal').length;
    if (successes <= 0) return;
    dragToward(ctx, ev.state, shooter, ev.target, successes * 2);
  });

  /*
   * Prey. "…after resolving the Drag weapon rule (if you choose to), you can discard any of your
   * successful unblocked attack dice." Bound after Drag, and it reads the pure setter above.
   */
  reg.on('onDamage', T.bind(AB.prey, 35), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || ev.kind !== 'attack' || seq.targetId !== ev.target.id) return;
    const shooter = ev.state.operatives[seq.attackerId];
    if (!shooter || shooter.player !== T.player || shooter.datacardId !== C.impaler) return;
    if ((seq.weaponName ?? '').trim().toLowerCase() !== 'fleshskewer' || seq.profileName !== 'ranged') return;
    const want = preyDiscard(ev.state, shooter.id);
    if (want.crits <= 0 && want.normals <= 0) return;
    const profile = shotProfile(T, ev.state, seq);
    if (!profile) return;
    const crits = Math.min(want.crits, seq.attack.dice.filter((d) => d.state === 'crit').length);
    const normals = Math.min(want.normals, seq.attack.dice.filter((d) => d.state === 'normal').length);
    const dropped = crits * profile.dmgC + normals * profile.dmgN;
    if (dropped <= 0) return;
    ev.amount = Math.max(0, Math.round(ev.amount) - dropped);
    setPreyDiscard(ev.state, shooter.id, {});
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Prey: ${shooter.letter} discards ${crits} critical and ${normals} normal successes (${dropped} damage not inflicted)`,
      data: { operativeId: shooter.id },
    });
  });
}

/**
 * "The target must be moved to a location it can be placed as close as possible to this operative,
 * determined by the x" you choose to use… Whenever the target is dropping during that move, ignore
 * the vertical distance."
 *
 * A deterministic straight-line slide toward the Impaler (D-016). A destination whose surface is
 * HIGHER than the target's current elevation is refused: the printed rule excuses the vertical
 * distance of a drop only, and this module cannot charge a climb.
 */
export function dragToward(
  ctx: GameContext,
  state: GameState,
  puller: OperativeState,
  target: OperativeState,
  inches: number,
): number {
  const pullerCard = ctx.datacards.get(puller.datacardId);
  const targetCard = ctx.datacards.get(target.datacardId);
  if (!pullerCard || !targetCard || inches <= 0) return 0;
  const apart = dist(target.pos, puller.pos);
  const contact = baseRadius(pullerCard.base) + baseRadius(targetCard.base);
  const most = Math.min(inches, Math.max(0, apart - contact));
  if (most <= EPS) return 0;
  const ux = (puller.pos.x - target.pos.x) / (apart || 1);
  const uy = (puller.pos.y - target.pos.y) / (apart || 1);
  for (let d = most; d > 0.05; d -= 0.25) {
    const pos: Vec2 = { x: target.pos.x + ux * d, y: target.pos.y + uy * d };
    const spot = placeableAt(ctx, state, target, pos);
    if (!spot.ok) continue;
    if ((spot.z ?? 0) > target.z + EPS) continue; // a drag never climbs
    const from = { ...target.pos };
    target.pos = pos;
    target.z = spot.z ?? 0;
    if (target.carryingMarkerId) {
      const m = state.markers[target.carryingMarkerId];
      if (m) {
        m.pos = { ...target.pos };
        m.z = target.z;
      }
    }
    log(state, {
      kind: 'action',
      player: puller.player,
      text: `Drag: ${puller.letter} pulls ${target.letter} ${Math.ceil(d)}" closer`,
      data: { operativeId: target.id, inches: Math.ceil(d), from },
    });
    return d;
  }
  return 0;
}

function placeableAt(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
): { ok: boolean; z?: number } {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false };
  const index = terrain(ctx, state);
  const r = baseRadius(card.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r) return { ok: false };
  if (baseTouchesHazardous(index, pos, card.base, op.rot)) return { ok: false };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, card.base, op.rot, z, modelHeight(card))) return { ok: false };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (Math.hypot(pos.x - other.pos.x, pos.y - other.pos.y) - r - baseRadius(oc.base) < -1e-4) return { ok: false };
  }
  return { ok: true, z };
}

// ---------------------------------------------------------------------------

function inciter(reg: HookRegistry, T: TeamHooks, mine: (op: OperativeState) => boolean): void {
  /*
   * Incite the Hunt, clause 1. "Whenever this operative incapacitates an enemy operative from more
   * than 2" away, before that enemy operative is removed from the killzone, you can increase the
   * GORE TANK of one friendly GOREMONGER operative within 8" of that enemy operative."
   */
  reg.on('onIncapacitated', T.bind(AB.inciteTheHunt, 22), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const killer = actingOperative(ev.state);
    if (!killer || killer.player !== T.player || killer.datacardId !== C.inciter) return;
    if (T.gap(killer, ev.operative) <= 2 + EPS) return;
    const candidates = T.friendlies(ev.state, KW)
      .filter((o) => !o.removed && T.gap(o, ev.operative) <= 8 + EPS && goreTankOf(ev.state, o) < 2)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosen = candidates[0];
    if (chosen) increaseGoreTank(ev.state, chosen, 'Incite the Hunt');
  });

  /*
   * Clause 2. "Whenever this operative inflicts damage on an enemy operative with either profile of
   * its dual autopistols but doesn't incapacitate it, that enemy operative gains one of your
   * Bleeding tokens (if it doesn't already have one)."
   */
  reg.on('onDamage', T.bind(AB.inciteTheHunt, 92), (ev) => {
    if (ev.target.player === T.player) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const shooter =
      seq.kind === 'shoot'
        ? ev.state.operatives[seq.attackerId]
        : ev.state.operatives[seq.turn === 'attacker' ? seq.attackerId : seq.defenderId];
    if (!shooter || shooter.player !== T.player || shooter.datacardId !== C.inciter) return;
    const weapon = (seq.kind === 'shoot' ? seq.weaponName : strikingFightWeapon(seq)) ?? '';
    if (weapon.trim().toLowerCase() !== 'dual autopistols') return;
    const amount = Math.max(0, Math.round(ev.amount));
    if (amount <= 0 || ev.target.wounds - amount <= 0) return; // "but doesn't incapacitate it"
    if (hasBleeding(ev.state, ev.target.id, T.player)) return;
    effect(ev.state, {
      rule: BLEEDING,
      source: { kind: 'ability', id: AB.inciteTheHunt },
      sourceText: shortQuote(abilityText(C.inciter, AB.inciteTheHunt)),
      operativeId: ev.target.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${ev.target.letter} gains a Bleeding token`,
      data: { operativeId: ev.target.id },
    });
  });

  /*
   * Clause 3. "During a friendly GOREMONGER operative's activation or counteraction, before or
   * after it performs an action, if it's within 8" of an enemy operative that has one of your
   * Bleeding tokens, you can remove that token and increase that friendly operative's GORE TANK."
   *
   * Free and strictly good, so it is auto-used (D-022) at both ends of the activation — the
   * printed "before or after it performs an action" — and only while the tank is not already full,
   * so a token is never spent for nothing.
   */
  const bleed = (state: GameState, op: OperativeState): void => {
    if (!mine(op) || op.removed || goreTankOf(state, op) >= 2) return;
    const bleeding = T.enemies(state)
      .filter((e) => hasBleeding(state, e.id, T.player) && T.gap(op, e) <= 8 + EPS)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const victim = bleeding[0];
    if (!victim) return;
    dropEffects(state, (e) => e.rule === BLEEDING && e.operativeId === victim.id && e.player === T.player);
    log(state, {
      kind: 'action',
      player: T.player,
      text: `${op.letter} feeds on ${victim.letter}'s Bleeding token`,
      data: { operativeId: op.id },
    });
    increaseGoreTank(state, op, 'Incite the Hunt (Bleeding token)');
  };
  reg.on('onActivationStart', T.bind(AB.inciteTheHunt, 24), (ev) => bleed(ev.state, ev.operative));
  reg.on('onActivationEnd', T.bind(AB.inciteTheHunt, 24), (ev) => bleed(ev.state, ev.operative));
}

// ---------------------------------------------------------------------------

function skullclaimer(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Brutish. "Whenever an attack dice would inflict Critical Dmg on this operative, you can choose
   * for that attack dice to inflict Normal Dmg instead."
   *
   * Unlimited and free, so applying it to EVERY critical dice is always optimal and the aggregated
   * shooting total can be converted exactly: subtract (Critical Dmg − Normal Dmg) per unblocked
   * critical success. Devastating damage is not an attack dice inflicting damage, hence `'attack'`.
   */
  reg.on('onDamage', T.bind(AB.brutish, 88), (ev) => {
    if (ev.kind !== 'attack' || ev.target.player !== T.player) return;
    if (ev.target.datacardId !== C.skullclaimer) return;
    const ctx = T.ctx;
    if (!ctx) return;
    const fight = fightSeq(ev.state);
    if (fight) {
      const side = fight.turn;
      const striker = side === 'attacker' ? fight.attackerId : fight.defenderId;
      if (striker === ev.target.id) return;
      const { profile } = sideWeapon(ctx, ev.state, fight, side);
      if (profile.dmgC <= profile.dmgN) return;
      if (Math.round(ev.amount) !== profile.dmgC) return; // this die was a normal success
      ev.amount = profile.dmgN;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Brutish: ${ev.target.letter} takes Normal Dmg (${profile.dmgN}) instead of Critical Dmg (${profile.dmgC})`,
        data: { operativeId: ev.target.id },
      });
      return;
    }
    const shoot = shootSeq(ev.state);
    if (!shoot || shoot.targetId !== ev.target.id) return;
    const profile = shotProfile(T, ev.state, shoot);
    if (!profile || profile.dmgC <= profile.dmgN) return;
    const crits = shoot.attack.dice.filter((d) => d.state === 'crit').length;
    if (crits <= 0) return;
    const saved = crits * (profile.dmgC - profile.dmgN);
    ev.amount = Math.max(0, Math.round(ev.amount) - saved);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Brutish: ${crits} critical successes inflict Normal Dmg on ${ev.target.letter} (${saved} less)`,
      data: { operativeId: ev.target.id },
    });
  });

  /*
   * Claim Skull. "Once per turning point, if this operative incapacitates an enemy operative with
   * its great chainaxe, you gain 1CP."
   */
  reg.on('onIncapacitated', T.bind(AB.claimSkull, 26), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const killer = ev.state.operatives[seq.turn === 'attacker' ? seq.attackerId : seq.defenderId];
    if (!killer || killer.player !== T.player || killer.datacardId !== C.skullclaimer) return;
    if ((strikingFightWeapon(seq) ?? '').trim().toLowerCase() !== 'great chainaxe') return;
    if (!useOncePerTP(ev.state, `goremonger.claimSkull.${T.player}`)) return;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Claim Skull: ${killer.letter} claims a skull — you gain 1CP`,
      data: { operativeId: killer.id },
    });
  });
}

// ---------------------------------------------------------------------------

function stalker(reg: HookRegistry, T: TeamHooks): void {
  // Climbing Picks is reminder-only (see REMINDER_ONLY) — `onMoveRules` is never emitted.

  /*
   * Rooftop Stalker. "Whenever this operative is fighting during an activation in which it dropped
   * from Vantage terrain, or whenever this operative is fighting against an enemy operative that's
   * on Vantage terrain, this operative's melee weapons have the Relentless weapon rule."
   *
   * The second half is exact. The first is measured as an elevation CHANGE across the activation
   * (the Scout Squad Grapnel Assault read): the operative's elevation and whether it stood on
   * Vantage terrain are recorded at its activation start, and a later, lower elevation is the drop.
   */
  reg.on('onActivationStart', T.bind(AB.rooftopStalker, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.stalker) return;
    const store = bucket(ev.state, 'goremonger.stalkerStart') as Record<
      string,
      { z: number; vantage: boolean } | undefined
    >;
    store[ev.operative.id] = { z: ev.operative.z, vantage: onVantage(T, ev.state, ev.operative) };
  });

  reg.on('onWeaponRules', T.bind(AB.rooftopStalker, 12), (ev) => {
    if (ev.type !== 'melee' || ev.retaliating) return;
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.stalker) return;
    const store = bucket(ev.state, 'goremonger.stalkerStart') as Record<
      string,
      { z: number; vantage: boolean } | undefined
    >;
    const start = store[ev.operative.id];
    const dropped = Boolean(start?.vantage) && ev.operative.z < (start?.z ?? 0) - EPS;
    const targetOnVantage = ev.target !== undefined && onVantage(T, ev.state, ev.target);
    if (!dropped && !targetOnVantage) return;
    if (ev.rules.some((r) => r.id === 'Relentless')) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Rooftop Stalker)'));
  });
}

/** "…on Vantage terrain" — the surface the operative is standing on is part of a Vantage part. */
function onVantage(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const ctx = T.ctx;
  if (!ctx || op.z <= EPS) return false;
  return partsSupporting(terrain(ctx, state), op.pos, op.z).some((p) => hasType(p, 'Vantage'));
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

export const HUNT_READY = 'goremonger.huntForBlood';
export const GORETHIRST = 'goremonger.gorethirst';
export const UNBRIDLED = 'goremonger.unbridledAggression';
export const DEMISE_ARMED = 'goremonger.destructiveDemiseArmed';
export const LACERATE = 'goremonger.lacerateFlesh';

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // ENHANCED VIOLENCE (strategy, 1CP)
  // =========================================================================
  // "Whenever a friendly GOREMONGER operative's GORE TANK is: Half, its melee weapons have the
  //  Balanced weapon rule. Full, its melee weapons have the Relentless weapon rule."
  // `onWeaponRules` is read by BOTH sequences, so this is live when fighting AND retaliating.
  reg.on('onWeaponRules', T.bind(SP.enhancedViolence, 20), (ev) => {
    if (ev.type !== 'melee' || !mine(ev.operative)) return;
    if (!gambitUsed(ev.state, T.player, SP.enhancedViolence)) return;
    const level = goreTankOf(ev.state, ev.operative);
    if (level === 1 && !ev.rules.some((r) => r.id === 'Balanced'))
      ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (ENHANCED VIOLENCE)'));
    if (level === 2 && !ev.rules.some((r) => r.id === 'Relentless'))
      ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (ENHANCED VIOLENCE)'));
  });

  // =========================================================================
  // AUGMENTED ENDURANCE (strategy, 1CP)
  // =========================================================================
  // "Whenever an operative is shooting a friendly GOREMONGER operative, if that friendly
  //  operative's GORE TANK is: Half, you can re-roll one of your defence dice. Full, you can
  //  re-roll any of your defence dice."
  reg.on('onDefenceDice', T.bind(SP.augmentedEndurance, 20), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    if (!gambitUsed(ev.state, T.player, SP.augmentedEndurance)) return;
    const target = ev.ctx.defender;
    if (!target || !mine(target)) return;
    const level = goreTankOf(ev.state, target);
    if (level === 0) return;
    const grant: RerollGrant =
      level === 2
        ? {
            id: 'goremonger.augmentedEndurance',
            label: 'AUGMENTED ENDURANCE: re-roll any of your defence dice',
            mode: 'any',
            player: T.player,
            sourceText: shortQuote(text(SP.augmentedEndurance)),
          }
        : {
            id: 'goremonger.augmentedEndurance',
            label: 'AUGMENTED ENDURANCE: re-roll one of your defence dice',
            mode: 'one',
            max: 1,
            player: T.player,
            sourceText: shortQuote(text(SP.augmentedEndurance)),
          };
    ev.rerolls.push(grant);
  });

  // =========================================================================
  // GORY TENACITY (strategy, 1CP)
  // =========================================================================
  // "Whenever a friendly GOREMONGER operative is fighting or retaliating, the first time your
  //  opponent strikes it during that sequence, halve the damage inflicted (rounding up and to a
  //  minimum of 2)."
  reg.on('onDamage', T.bind(SP.goryTenacity, 85), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || ev.kind !== 'attack' || !mine(ev.target)) return;
    if (!gambitUsed(ev.state, T.player, SP.goryTenacity)) return;
    const striker = ev.state.operatives[seq.turn === 'attacker' ? seq.attackerId : seq.defenderId];
    if (!striker || striker.player === T.player) return;
    const store = bucket(ev.state, 'goremonger.goryTenacity') as Record<string, string | undefined>;
    const key = fightKey(ev.state, seq);
    if (store[ev.target.id] === key) return; // "the FIRST time your opponent strikes it"
    store[ev.target.id] = key;
    const amount = Math.max(0, Math.round(ev.amount));
    const halved = Math.max(2, Math.ceil(amount / 2));
    if (halved >= amount) return;
    ev.amount = halved;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `GORY TENACITY: ${ev.target.letter} halves the first strike (${amount} → ${halved})`,
      data: { operativeId: ev.target.id },
    });
  });

  // =========================================================================
  // HUNT FOR BLOOD (strategy, 1CP)
  // =========================================================================
  // "Select one friendly GOREMONGER operative. If it has a Conceal order, change it to Engage.
  //  Then it can immediately perform a free Charge action, but cannot move more than 3" during
  //  that action."
  // The engine has no intent for an action outside an activation, so the free Charge lands on that
  // operative's activation. It is its own 0AP `Charge (Hunt for Blood)` ActionDef (D-021) rather
  // than a `grantFreeAction`, because the printed 3" cap and the order change belong to this ploy
  // alone; being 0AP it never touches the APL stat or the free-AP budget (D-100) at all.
  reg.on('onPloyUsed', T.bind(SP.huntForBlood, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.huntForBlood) return;
    const wanted = ev.data?.['operativeId'];
    const candidates = T.friendlies(ev.state, KW).sort((a, b) => (a.id < b.id ? -1 : 1));
    const op = (typeof wanted === 'string' ? candidates.find((o) => o.id === wanted) : undefined) ?? candidates[0];
    if (!op) return;
    if (op.order === 'conceal') {
      op.order = 'engage';
      log(ev.state, { kind: 'action', player: T.player, text: `${op.letter} changes its order to Engage (HUNT FOR BLOOD)` });
    }
    effect(ev.state, {
      rule: HUNT_READY,
      source: { kind: 'ploy', id: SP.huntForBlood },
      sourceText: shortQuote(text(SP.huntForBlood)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `HUNT FOR BLOOD: ${op.letter} can make a free 3" Charge`,
      data: { operativeId: op.id },
    });
  });

  // =========================================================================
  // UNBRIDLED AGGRESSION (firefight, 1CP)
  // =========================================================================
  // "Use this firefight ploy when a friendly GOREMONGER operative is fighting during an activation
  //  in which it performed the Charge action, at the end of the Roll Attack Dice step. Until the
  //  end of that sequence, that operative's melee weapons have the Severe weapon rule."
  reg.on('onPloyUsed', T.bind(FP.unbridledAggression, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.unbridledAggression) return;
    const op = unbridledCandidate(ev.state, T);
    if (!op) return;
    effect(ev.state, {
      rule: UNBRIDLED,
      source: { kind: 'ploy', id: FP.unbridledAggression },
      sourceText: shortQuote(text(FP.unbridledAggression)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `UNBRIDLED AGGRESSION: ${op.letter}'s melee weapons have Severe` });
  });
  reg.on('onWeaponRules', T.bind(FP.unbridledAggression, 21), (ev) => {
    if (ev.type !== 'melee' || ev.retaliating || !mine(ev.operative)) return;
    if (!effectOn(ev.state, ev.operative.id, UNBRIDLED)) return;
    if (ev.rules.some((r) => r.id === 'Severe')) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (UNBRIDLED AGGRESSION)'));
  });

  // =========================================================================
  // GORETHIRST (firefight, 1CP)
  // =========================================================================
  // "Use this firefight ploy when you would counteract. You can do so with one friendly GOREMONGER
  //  operative that has a Conceal order, but before it counteracts, you must change its order to
  //  Engage and it cannot perform any actions other than Charge, Shoot or Fight during that
  //  counteraction."
  reg.on('onPloyUsed', T.bind(FP.gorethirst, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.gorethirst) return;
    const wanted = ev.data?.['operativeId'];
    const candidates = gorethirstCandidates(ev.state, T);
    const op = (typeof wanted === 'string' ? candidates.find((o) => o.id === wanted) : undefined) ?? candidates[0];
    if (!op) return;
    op.order = 'engage'; // "before it counteracts, you must change its order to Engage"
    effect(ev.state, {
      rule: GORETHIRST,
      source: { kind: 'ploy', id: FP.gorethirst },
      sourceText: shortQuote(text(FP.gorethirst)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `GORETHIRST: ${op.letter} changes its order to Engage and can counteract`,
      data: { operativeId: op.id },
    });
  });
  reg.on('canPerformAction', T.bind(FP.gorethirst, 21), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, GORETHIRST)) return;
    const counteract = ev.state.opState['counteract'] as { operativeId?: string } | undefined;
    if (counteract?.operativeId !== ev.operative.id) return;
    const def = getAction(ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (['Charge', 'Shoot', 'Fight'].includes(key)) return;
    ev.allowed = false;
    ev.reason = 'GORETHIRST: it cannot perform any actions other than Charge, Shoot or Fight';
  });

  // =========================================================================
  // DESTRUCTIVE DEMISE (firefight, 1CP)
  // =========================================================================
  // "Use this firefight ploy when a friendly GOREMONGER operative is incapacitated, before it's
  //  removed from the killzone. Inflict damage determined by that friendly operative's GORE TANK
  //  on one enemy operative within that friendly operative's control range. Inflict: D3 if empty.
  //  D3+1 if half. D3+2 if full."
  // `onIncapacitated` fires deep inside `inflictDamage`, so the ploy is declared in advance and
  // pays out on its printed trigger (the Celestian GLORIOUS MARTYRDOM shape).
  reg.on('onPloyUsed', T.bind(FP.destructiveDemise, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.destructiveDemise) return;
    effect(ev.state, {
      rule: DEMISE_ARMED,
      source: { kind: 'ploy', id: FP.destructiveDemise },
      sourceText: shortQuote(text(FP.destructiveDemise)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: 'DESTRUCTIVE DEMISE is armed' });
  });
  reg.on('onIncapacitated', T.bind(FP.destructiveDemise, 30), (ev) => {
    if (ev.prevented || !mine(ev.operative)) return;
    const ctx = T.ctx;
    if (!ctx) return;
    const armed = ev.state.effects.find((e) => e.rule === DEMISE_ARMED && e.player === T.player);
    if (!armed) return;
    const victims = enemiesInControlRange(ctx, ev.state, ev.operative)
      .filter((e) => !e.removed && !e.incapacitated)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const victim = victims[0];
    if (!victim) return;
    dropEffects(ev.state, (e) => e === armed);
    const level = goreTankOf(ev.state, ev.operative);
    const d3 = ctx.rng.d3();
    recordRoll(ev.state, 'destructiveDemise', [d3], T.player, `${GORE_LEVEL_NAME[level]} GORE TANK`);
    const damage = d3 + level;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `DESTRUCTIVE DEMISE: ${ev.operative.letter} (${GORE_LEVEL_NAME[level]}) inflicts ${damage} damage on ${victim.letter}`,
      data: { operativeId: victim.id, damage },
    });
    inflictDamage(ctx, ev.state, victim, damage, 'other');
  });

  // =========================================================================
  // LACERATE FLESH (firefight, 1CP)
  // =========================================================================
  // "Use this firefight ploy when a friendly GOREMONGER operative with an empty GORE TANK is
  //  activated or counteracts. Increase that operative's GORE TANK. At the end of that
  //  activation/counteraction, decrease its GORE TANK (you cannot use this decrease to use a
  //  SANGUAVITAE rule); if you cannot decrease its GORE TANK, inflict D3 damage on it."
  reg.on('onPloyUsed', T.bind(FP.lacerateFlesh, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.lacerateFlesh) return;
    const op = lacerateCandidate(ev.state, T);
    if (!op) return;
    increaseGoreTank(ev.state, op, 'LACERATE FLESH');
    effect(ev.state, {
      rule: LACERATE,
      source: { kind: 'ploy', id: FP.lacerateFlesh },
      sourceText: shortQuote(text(FP.lacerateFlesh)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onActivationEnd', T.bind(FP.lacerateFlesh, 40), (ev) => {
    if (ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, LACERATE);
    if (!eff) return;
    dropEffects(ev.state, (e) => e === eff);
    if (decreaseGoreTank(ev.state, ev.operative, 'LACERATE FLESH')) return;
    const ctx = T.ctx;
    if (!ctx) return;
    const d3 = ctx.rng.d3();
    recordRoll(ev.state, 'lacerateFlesh', [d3], T.player, 'no GORE TANK left to decrease');
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `LACERATE FLESH: ${ev.operative.letter} cannot decrease its GORE TANK and takes ${d3} damage`,
      data: { operativeId: ev.operative.id },
    });
    inflictDamage(ctx, ev.state, ev.operative, d3, 'other');
  });
}

/** "…a friendly GOREMONGER operative is fighting during an activation in which it performed the Charge action". */
function unbridledCandidate(state: GameState, T: TeamHooks): OperativeState | undefined {
  const seq = fightSeq(state);
  const charged = (op: OperativeState): boolean =>
    did(op, 'Charge') || did(op, CHARGE_BLOODLUST) || did(op, CHARGE_HUNT);
  if (seq) {
    const attacker = state.operatives[seq.attackerId];
    if (attacker && T.mineKw(attacker, KW) && charged(attacker)) return attacker;
    return undefined;
  }
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  return active && T.mineKw(active, KW) && charged(active) ? active : undefined;
}

function gorethirstCandidates(state: GameState, T: TeamHooks): OperativeState[] {
  return T.friendlies(state, KW)
    .filter((o) => o.expended && !o.counteractedThisTP && o.order === 'conceal' && o.guardSpentTP !== state.turningPoint)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function lacerateCandidate(state: GameState, T: TeamHooks): OperativeState | undefined {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!active || !T.mineKw(active, KW)) return undefined;
  return goreTankOf(state, active) === 0 ? active : undefined;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

export const TOTEM_MARKER = (player: PlayerId): string => `goremonger.goryTotem.${player}`;
export const CADAVER_MARKER = (player: PlayerId): string => `goremonger.bloodyCadaver.${player}`;

const MARKER_BASE = { shape: 'round', mm: 20 } as const;

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // GORY TOTEM / BLOODY CADAVER — both are set up "before the battle"
  // =========================================================================
  // `onDeploy` is the only hook the Set Up Operatives step emits; the activation-start and
  // ready-step bindings are idempotent safety nets for callers that place operatives directly
  // (the test harness, a restored save) — the Raveners Tunnel precedent.
  const ensure = (state: GameState): void => {
    if (hasEquipment(state, T.player, EQ.goryTotem)) ensureMarker(T, state, 'totem');
    if (hasEquipment(state, T.player, EQ.bloodyCadaver)) ensureMarker(T, state, 'cadaver');
  };
  reg.on('onDeploy', T.bind(EQ.goryTotem, 30), (ev) => {
    if (ev.operative.player === T.player) ensure(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.goryTotem, 30), (ev) => {
    if (ev.operative.player === T.player) ensure(ev.state);
  });
  reg.on('onReadyStep', T.bind(EQ.goryTotem, 30), (ev) => {
    if (ev.player === T.player) ensure(ev.state);
  });

  // "Whenever an enemy operative within 3" of your Gory Totem marker is shooting, fighting or
  //  retaliating, your opponent cannot re-roll their attack dice."
  // `fight.ts` emits no `onRollAttack` (D-031), so the fighting/retaliating half is unreachable.
  reg.on('onRollAttack', T.bind(EQ.goryTotem, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.goryTotem)) return;
    if (ev.ctx.attacker.player === T.player) return;
    const marker = ev.state.markers[TOTEM_MARKER(T.player)];
    if (!marker) return;
    if (T.markerGap(ev.ctx.attacker, marker) > 3 + EPS) return;
    if (ev.rerolls.length === 0) return;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `GORY TOTEM: ${ev.ctx.attacker.letter} cannot re-roll its attack dice`,
      data: { operativeId: ev.ctx.attacker.id },
    });
    ev.rerolls.length = 0;
  });

  // "In the Ready step of each Strategy phase, you can increase the GORE TANK of one friendly
  //  GOREMONGER operative that controls that marker, unless that friendly operative is within
  //  control range of an enemy operative."
  reg.on('onReadyStep', T.bind(EQ.bloodyCadaver, 31), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.bloodyCadaver)) return;
    const ctx = T.ctx;
    const marker = ev.state.markers[CADAVER_MARKER(T.player)];
    if (!ctx || !marker) return;
    if (markerController(ctx, ev.state, marker) !== T.player) return;
    const holders = T.friendlies(ev.state, KW)
      .filter(
        (o) =>
          markerContestedBy(ctx, ev.state, marker, o) &&
          enemiesInControlRange(ctx, ev.state, o).length === 0 &&
          goreTankOf(ev.state, o) < 2,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosen = holders[0];
    if (chosen) increaseGoreTank(ev.state, chosen, 'BLOODY CADAVER');
  });

  // =========================================================================
  // CHAOS SIGIL
  // =========================================================================
  // "Once per turning point, when an operative is shooting a friendly GOREMONGER operative, at the
  //  start of the Roll Defence Dice step, you can use this rule. If you do, worsen the x of the
  //  Piercing weapon rule by 1 (if any) until the end of that sequence. Note that Piercing 1 would
  //  therefore be ignored."
  // The core rolls `3 - piercing` defence dice, so worsening Piercing by 1 is one more defence
  // dice — and it is only claimed when Piercing is actually costing the defender a dice, which is
  // exactly the printed "(if any)" (the Corsair MISTFIELD / Void-Dancer Panoply read).
  reg.on('onDefenceDice', T.bind(EQ.chaosSigil, 30), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return;
    if (!hasEquipment(ev.state, T.player, EQ.chaosSigil)) return;
    const target = ev.ctx.defender;
    if (!target || !mine(target)) return;
    if (ev.count >= 3) return; // no Piercing to worsen
    if (!useOncePerTP(ev.state, `goremonger.chaosSigil.${T.player}`)) return;
    ev.count += 1;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `CHAOS SIGIL: Piercing is worsened by 1 against ${target.letter}`,
      data: { operativeId: target.id },
    });
  });

  // =========================================================================
  // WRIST CHAINS
  // =========================================================================
  // "Once per turning point, when a friendly GOREMONGER operative performs the Shoot action and
  //  you're selecting a ranged weapon, you can use this rule. If you do, until the end of that
  //  action, the following melee weapons are treated as ranged weapons with the Range 2" weapon
  //  rule: chainblade, chainglaive, great chainaxe (ignore its Brutal weapon rule), pickrippers."
  // `grantedWeapons` is kept equal to exactly the legal set on every `availableWeapons` read, so
  // the UI, `shotPlans` and `startShoot` can never disagree (the Elucidian asset precedent).
  reg.on('availableWeapons', T.bind(EQ.wristChains, 30), (ev) => {
    if (!mine(ev.operative)) return;
    const holder = ev.operative as OperativeState & { grantedWeapons?: Weapon[] };
    holder.grantedWeapons = (holder.grantedWeapons ?? []).filter((w) => !w.name.endsWith(WRIST_SUFFIX));
    if (!hasEquipment(ev.state, T.player, EQ.wristChains)) return;
    const seq = shootSeq(ev.state);
    const inUse = seq?.attackerId === ev.operative.id && seq.weaponName.endsWith(WRIST_SUFFIX);
    if (usedThisTP(ev.state, `goremonger.wristChains.${T.player}`) && !inUse) return;
    for (const w of wristChainWeapons(ev.operative)) holder.grantedWeapons.push(w);
  });
  // The allowance is claimed only by the REAL emit — a dry run is the Shoot action's `check`,
  // which the AI runs many times per turn and which must never change state (D-032).
  reg.on('onSelectWeapon', T.bind(EQ.wristChains, 30), (ev) => {
    if (ev.dryRun) return;
    if (!mine(ev.ctx.attacker) || !ev.ctx.weaponName.endsWith(WRIST_SUFFIX)) return;
    useOncePerTP(ev.state, `goremonger.wristChains.${T.player}`);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `WRIST CHAINS: ${ev.ctx.attacker.letter} hurls its ${ev.ctx.weaponName}`,
      data: { operativeId: ev.ctx.attacker.id },
    });
  });
}

export const WRIST_SUFFIX = ' (Wrist Chains)';
const WRIST_CHAIN_WEAPONS = ['chainblade', 'chainglaive', 'great chainaxe', 'pickrippers'];

/** The thrown copies. `WeaponProfile`s are shared catalogue data, so every one is built fresh (D-019). */
export function wristChainWeapons(op: OperativeState): Weapon[] {
  const card = DATA.datacards.find((c) => c.id === op.datacardId);
  if (!card) return [];
  const out: Weapon[] = [];
  for (const weapon of card.weapons) {
    if (!WRIST_CHAIN_WEAPONS.includes(weapon.name.trim().toLowerCase())) continue;
    const melee = weapon.profiles.find((p) => p.type === 'melee');
    if (!melee) continue;
    out.push({
      name: `${weapon.name}${WRIST_SUFFIX}`,
      profiles: [
        {
          type: 'ranged',
          atk: melee.atk,
          hit: melee.hit,
          dmgN: melee.dmgN,
          dmgC: melee.dmgC,
          rules: [
            // "…treated as ranged weapons with the Range 2" weapon rule"
            ruleTag('Range', 2, 'Range 2"'),
            // "…great chainaxe (ignore its Brutal weapon rule)"
            ...melee.rules.filter((r) => r.id !== 'Brutal').map((r) => ({ ...r })),
          ],
        },
      ],
    });
  }
  return out;
}

/**
 * "Before the battle, you can set up one of your <X> markers wholly within your territory and more
 * than 2" from other markers (excluding your <sibling> marker)."
 *
 * Equipment carries no data channel, so the position is the deterministic default D-016 asks for:
 * the legal spot closest to the centre of the board, which is the useful end of your territory.
 */
function ensureMarker(T: TeamHooks, state: GameState, which: 'totem' | 'cadaver'): MarkerState | undefined {
  const id = which === 'totem' ? TOTEM_MARKER(T.player) : CADAVER_MARKER(T.player);
  const existing = state.markers[id];
  if (existing) return existing;
  const tried = bucket(state, 'goremonger.markersPlaced') as Record<string, boolean | undefined>;
  if (tried[id]) return undefined; // "you CAN set up one" — with nowhere legal, it is not set up
  tried[id] = true;
  const sibling = which === 'totem' ? CADAVER_MARKER(T.player) : TOTEM_MARKER(T.player);
  const pos = markerSpot(state, T.player, sibling);
  if (!pos) return undefined;
  const marker = placeTeamMarker(state, {
    id,
    kind: 'generic',
    player: T.player,
    pos,
    flags: which === 'cadaver' ? { bloodyCadaver: true } : { goryTotem: true },
  });
  log(state, {
    kind: 'action',
    player: T.player,
    text: `${which === 'totem' ? 'Gory Totem' : 'Bloody Cadaver'} marker is set up`,
    data: { markerId: id, pos },
  });
  return marker;
}

function markerSpot(state: GameState, player: PlayerId, ignoreMarkerId: string): Vec2 | undefined {
  const zoneKey = state.setup.dropZone[player] ?? player;
  const territory = state.map.territories[zoneKey] ?? [];
  if (territory.length === 0) return undefined;
  const { w, h } = state.map.board;
  const centre = { x: w / 2, y: h / 2 };
  const clear = (p: Vec2): boolean => {
    for (const m of Object.values(state.markers)) {
      if (m.id === ignoreMarkerId) continue;
      if (baseGap(p, MARKER_BASE, 0, m.pos, { shape: 'round', mm: m.diameterMm }, 0) <= 2 + EPS) return false;
    }
    return true;
  };
  const candidates: Vec2[] = [];
  for (let x = 0.5; x <= w - 0.5; x += 1) {
    for (let y = 0.5; y <= h - 0.5; y += 1) {
      const p = { x, y };
      if (!baseWhollyWithinTerritory(p, territory)) continue;
      if (!clear(p)) continue;
      candidates.push(p);
    }
  }
  candidates.sort((a, b) => dist(a, centre) - dist(b, centre) || a.x - b.x || a.y - b.y);
  return candidates[0];
}

function baseWhollyWithinTerritory(p: Vec2, territory: { x: number; y: number }[][]): boolean {
  // A 20mm marker, sampled the way `baseWhollyWithin` does, without importing the whole helper.
  const r = 10 / 25.4;
  const pts: Vec2[] = [p];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r });
  }
  return pts.every((q) => territory.some((poly) => pointIn(q, poly)));
}

function pointIn(p: Vec2, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Shared gate for the six 0AP SANGUAVITAE declarations. */
function sanguavitaeGate(
  state: GameState,
  op: OperativeState,
  which: Sanguavitae,
): { ok: boolean; reason?: string } {
  if (!isGoremongerCard(op)) return { ok: false, reason: 'not a GOREMONGER operative' };
  if (state.activeOperativeId !== op.id)
    return { ok: false, reason: 'a SANGUAVITAE rule is used during that operative’s activation' };
  return canUseSanguavitae(state, op, which);
}

function sanguavitaeAction(
  which: Sanguavitae,
  impl: {
    check?(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): { ok: boolean; reason?: string };
    perform(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): void;
    takesTarget?: boolean;
  },
): ActionDef {
  return {
    id: SANGUAVITAE_ACTION[which],
    name: SANGUAVITAE_ACTION[which],
    ap: 0,
    type: 'unique',
    sourceText: `SANGUAVITAE › ${SANGUAVITAE_NAME[which]}: ${SANGUAVITAE_TEXT[which].replace(/\s+/g, ' ').trim()}`,
    available: (_ctx, state, op) => isGoremongerCard(op) && canUseSanguavitae(state, op, which).ok,
    check(ctx, state, op, params) {
      if (!impl.takesTarget && Object.keys(params).length > 0)
        return { ok: false, reason: 'this SANGUAVITAE rule takes no target' };
      const gate = sanguavitaeGate(state, op, which);
      if (!gate.ok) return gate;
      return impl.check?.(ctx, state, op, params) ?? { ok: true };
    },
    perform(ctx, state, op, params) {
      claimSanguavitae(state, op, which);
      impl.perform(ctx, state, op, params);
      return { ok: true };
    },
  };
}

function actions(data: TeamData): ActionDef[] {
  return [
    // =====================================================================
    // SANGUAVITAE — six 0AP declarations (D-021)
    // =====================================================================

    // "That operative regains up to D3+1 lost wounds."
    sanguavitaeAction('rejuvenate', {
      perform(ctx, state, op) {
        const d3 = ctx.rng.d3();
        recordRoll(state, 'rejuvenate', [d3], op.player, `${op.letter} regains D3+1 wounds`);
        const max = startingWounds(ctx, op);
        const healed = Math.min(d3 + 1, Math.max(0, max - op.wounds));
        op.wounds += healed;
        log(state, {
          kind: 'action',
          player: op.player,
          text: `Rejuvenate: ${op.letter} regains ${healed} lost wounds (${op.wounds} left)`,
          data: { operativeId: op.id, healed },
        });
      },
    }),

    // "Until the start of that operative's next activation, add 1 to its APL stat."
    sanguavitaeAction('mania', {
      perform(_ctx, state, op) {
        effect(state, {
          rule: MANIA,
          source: { kind: 'ability', id: RULE.sanguavitae },
          sourceText: shortQuote(SANGUAVITAE_TEXT.mania),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfBattle' }, // cleared at the START of its next activation
        });
      },
    }),

    // "That operative can perform two Fight actions during that activation, and the second one is free."
    sanguavitaeAction('fury', {
      perform(_ctx, state, op) {
        effect(state, {
          rule: FURY,
          source: { kind: 'ability', id: RULE.sanguavitae },
          sourceText: shortQuote(SANGUAVITAE_TEXT.fury),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
      },
    }),

    /*
     * "WHEN: When a friendly GOREMONGER operative performs the Charge action during its
     *  activation. EFFECT: When that operative finishes moving during that action, you can inflict
     *  D3 damage on one enemy operative within its control range."
     *
     * Nothing runs at the end of an action, so the declaration is made IMMEDIATELY after the
     * Charge: `check` refuses unless the last action performed was a Charge, which pins it to the
     * printed moment without needing a seam the engine does not have.
     */
    sanguavitaeAction('rake', {
      takesTarget: true,
      check(ctx, state, op, params) {
        const last = op.actionsThisActivation[op.actionsThisActivation.length - 1];
        if (last !== 'Charge' && last !== CHARGE_BLOODLUST)
          return { ok: false, reason: 'Rake is used when that operative finishes its Charge action' };
        const victims = rakeVictims(ctx, state, op);
        if (victims.length === 0) return { ok: false, reason: 'no enemy operative within its control range' };
        const wanted = params.targetOperativeId ?? params.targetId;
        if (wanted !== undefined && !victims.some((v) => v.id === wanted))
          return { ok: false, reason: 'that enemy operative is not within its control range' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        const victims = rakeVictims(ctx, state, op);
        const wanted = params.targetOperativeId ?? params.targetId;
        const victim = victims.find((v) => v.id === wanted) ?? victims[0];
        if (!victim) return;
        const d3 = ctx.rng.d3();
        recordRoll(state, 'rake', [d3], op.player, `Rake vs ${victim.letter}`);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `Rake: ${op.letter} inflicts ${d3} damage on ${victim.letter}`,
          data: { operativeId: victim.id, damage: d3 },
        });
        inflictDamage(ctx, state, victim, d3, 'other');
      },
    }),

    // "Until the end of that action, add 1" to that operative's Move stat."
    sanguavitaeAction('surge', {
      check(_ctx, _state, op) {
        if (did(op, 'Charge') || did(op, 'Reposition') || did(op, 'Fall Back'))
          return { ok: false, reason: 'it has already moved this activation' };
        return { ok: true };
      },
      perform(_ctx, state, op) {
        effect(state, {
          rule: SURGE,
          source: { kind: 'ability', id: RULE.sanguavitae },
          sourceText: shortQuote(SANGUAVITAE_TEXT.surge),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
      },
    }),

    // "Until the end of that action, add 1 to the Atk stat of that operative's melee weapons."
    sanguavitaeAction('rage', {
      check(ctx, state, op) {
        const fury = effectOn(state, op.id, FURY) !== undefined;
        const canFight = !did(op, 'Fight') || (fury && !did(op, FIGHT_FURY));
        if (!canFight) return { ok: false, reason: 'it has no Fight action left this activation' };
        if (weaponsOf(ctx, state, op, 'melee').length === 0) return { ok: false, reason: 'it has no melee weapon' };
        return { ok: true };
      },
      perform(_ctx, state, op) {
        effect(state, {
          rule: RAGE,
          source: { kind: 'ability', id: RULE.sanguavitae },
          sourceText: shortQuote(SANGUAVITAE_TEXT.rage),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
      },
    }),

    // =====================================================================
    // Fury's second Fight (D-021) — "the second one is free"
    // =====================================================================
    {
      id: FIGHT_FURY,
      name: FIGHT_FURY,
      ap: 0,
      type: 'unique',
      sourceText: `SANGUAVITAE › Fury: ${SANGUAVITAE_TEXT.fury.replace(/\s+/g, ' ').trim()}`,
      available: (_ctx, state, op) => effectOn(state, op.id, FURY) !== undefined,
      check(ctx, state, op, params) {
        if (!effectOn(state, op.id, FURY)) return { ok: false, reason: 'it has not used the Fury SANGUAVITAE rule' };
        if (!did(op, 'Fight')) return { ok: false, reason: 'Fury is the second Fight action of the activation' };
        // The universal Fight takes its target from `params` inside `perform`; this action is
        // enumerated through `missionCandidates`, which offers any nearby enemy, so the target is
        // validated HERE or a rejected intent is the result (D-026).
        if (params.targetId !== undefined) {
          const t = state.operatives[params.targetId];
          if (!t || t.removed || t.player === op.player || !inControlRange(ctx, state, op, t))
            return { ok: false, reason: 'that enemy operative is not within control range' };
        }
        return getAction('Fight')!.check(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
    },

    // =====================================================================
    // ASPIRANT › Obsessive Bloodlust (D-021)
    // =====================================================================
    // "…it can immediately perform a free Charge action (even if it's already performed the Charge
    //  action during that activation), but it cannot move more than 2" during that action. Doing so
    //  doesn't prevent it from performing the Charge, Dash or Reposition action afterwards during
    //  that activation." — hence 0AP, its OWN restriction key and no `treatedAs`.
    {
      id: CHARGE_BLOODLUST,
      name: CHARGE_BLOODLUST,
      ap: 0,
      type: 'unique',
      sourceText: `Obsessive Bloodlust: ${abilityText(C.aspirant, AB.obsessiveBloodlust).replace(/\s+/g, ' ').trim()}`,
      available: (_ctx, _state, op) => op.datacardId === C.aspirant,
      check: (ctx, state, op, params) => bloodlustCharge(ctx, state, op, params, false),
      perform: (ctx, state, op, params) => bloodlustCharge(ctx, state, op, params, true),
    },

    // =====================================================================
    // HUNT FOR BLOOD's free Charge (D-021)
    // =====================================================================
    {
      id: CHARGE_HUNT,
      name: CHARGE_HUNT,
      ap: 0,
      type: 'unique',
      treatedAs: 'Charge',
      sourceText: text(SP.huntForBlood).replace(/\s+/g, ' ').trim(),
      available: (_ctx, state, op) => effectOn(state, op.id, HUNT_READY) !== undefined,
      check: (ctx, state, op, params) => huntCharge(ctx, state, op, params, false),
      perform: (ctx, state, op, params) => huntCharge(ctx, state, op, params, true),
    },

    // =====================================================================
    // BLOODY CADAVER's Pick Up Marker
    // =====================================================================
    // "Friendly GOREMONGER operatives can perform the Pick Up Marker action on that marker." The
    // universal action would let ANY operative that controls the marker pick it up, so the printed
    // restriction gets its own ActionDef sharing the universal restriction key (D-021).
    {
      id: PICK_UP_CADAVER,
      name: PICK_UP_CADAVER,
      ap: 1,
      type: 'unique',
      treatedAs: 'Pick Up Marker',
      sourceText: text(EQ.bloodyCadaver).replace(/\s+/g, ' ').trim(),
      available: (_ctx, state, op) =>
        isGoremongerCard(op) && state.markers[CADAVER_MARKER(op.player)] !== undefined,
      check(ctx, state, op, params) {
        const marker = state.markers[CADAVER_MARKER(op.player)];
        if (!marker) return { ok: false, reason: 'you have no Bloody Cadaver marker' };
        if (params.markerId !== undefined && params.markerId !== marker.id)
          return { ok: false, reason: 'that is not your Bloody Cadaver marker' };
        if (marker.carriedBy) return { ok: false, reason: 'that marker is already being carried' };
        if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
        if (enemiesInControlRange(ctx, state, op).length > 0)
          return { ok: false, reason: 'within control range of an enemy operative' };
        if (markerController(ctx, state, marker) !== op.player)
          return { ok: false, reason: 'your operatives do not control that marker' };
        if (!markerContestedBy(ctx, state, marker, op))
          return { ok: false, reason: 'that marker is not within its control range' };
        return { ok: true };
      },
      perform(_ctx, state, op) {
        const marker = state.markers[CADAVER_MARKER(op.player)]!;
        marker.carriedBy = op.id;
        marker.pos = { ...op.pos };
        marker.z = op.z;
        op.carryingMarkerId = marker.id;
        log(state, { kind: 'action', player: op.player, text: `${op.letter} picks up the Bloody Cadaver marker` });
        return { ok: true };
      },
    },

    // =====================================================================
    // BLOODTAKER › TRANSFUSION RITUAL 1AP
    // =====================================================================
    uniqueAction(data, C.bloodtaker, ACT.transfusionRitual, {
      check(ctx, state, op, params) {
        if (enemiesInControlRange(ctx, state, op).length > 0)
          return { ok: false, reason: 'within control range of an enemy operative' };
        if (goreTankOf(state, op) === 0) return { ok: false, reason: 'its GORE TANK is empty' };
        const wanted = params.targetOperativeId ?? params.targetId;
        if (wanted !== undefined && !transfusionTargets(ctx, state, op).some((o) => o.id === wanted))
          return { ok: false, reason: 'that is not another friendly GOREMONGER operative within 8"' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        // "Decrease this operative's GORE TANK. Instead of using a SANGUAVITAE rule, you can
        //  increase the GORE TANK of one other friendly GOREMONGER operative within 8"."
        decreaseGoreTank(state, op, 'TRANSFUSION RITUAL');
        const wanted = params.targetOperativeId ?? params.targetId;
        const targets = transfusionTargets(ctx, state, op);
        const target = targets.find((o) => o.id === wanted) ?? targets.find((o) => goreTankOf(state, o) < 2);
        if (target) increaseGoreTank(state, target, 'TRANSFUSION RITUAL');
        return { ok: true };
      },
    }),

    // =====================================================================
    // INCITER › DASH AND SPRAY 1AP
    // =====================================================================
    uniqueAction(data, C.inciter, ACT.dashAndSpray, {
      check: (ctx, state, op, params) => dashAndSpray(ctx, state, op, params, false),
      perform: (ctx, state, op, params) => dashAndSpray(ctx, state, op, params, true),
    }),
  ];
}

/** "…you can inflict D3 damage on one enemy operative within its control range." */
function rakeVictims(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return enemiesInControlRange(ctx, state, op)
    .filter((e) => !e.removed && !e.incapacitated)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function transfusionTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && isGoremongerCard(o) && gapOf(ctx, op, o) <= 8 + EPS)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function gapOf(ctx: GameContext, a: OperativeState, b: OperativeState): number {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return baseGap(a.pos, ca.base, a.rot, b.pos, cb.base, b.rot);
}

/**
 * Obsessive Bloodlust's free Charge. `validateMove`'s own `hardCap` is exactly "it cannot move
 * more than 2" during that action" (the Hearthkyn KNUX SMASH precedent).
 */
function bloodlustCharge(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  apply: boolean,
): { ok: boolean; reason?: string } {
  if (op.datacardId !== C.aspirant) return { ok: false, reason: 'only an ASPIRANT has Obsessive Bloodlust' };
  if (!did(op, 'Fight') && !did(op, FIGHT_FURY))
    return { ok: false, reason: 'it has not ended the Fight action this activation' };
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'it is still within control range of an enemy operative' };
  if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const v = validateMove(ctx, state, op, params.path, {
    action: 'Charge',
    bonusInches: 2,
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
    hardCap: 2, // "it cannot move more than 2" during that action"
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  if (!apply) return { ok: true };
  op.pos = { ...v.endPos };
  op.z = v.endZ;
  if (params.path.endRot !== undefined) op.rot = params.path.endRot;
  op.onGuard = false;
  op.stickyEngagedWith = enemiesInControlRange(ctx, state, op).map((e) => e.id);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} performs ${CHARGE_BLOODLUST} (${v.total}")`,
    data: { operativeId: op.id, action: CHARGE_BLOODLUST, inches: v.total },
  });
  return { ok: true };
}

/** HUNT FOR BLOOD's free Charge: "cannot move more than 3" during that action". */
function huntCharge(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  apply: boolean,
): { ok: boolean; reason?: string } {
  if (!effectOn(state, op.id, HUNT_READY)) return { ok: false, reason: 'HUNT FOR BLOOD did not select this operative' };
  if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'already within control range of an enemy operative' };
  if (did(op, 'Reposition') || did(op, 'Dash') || did(op, 'Fall Back'))
    return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const counteracting = (state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId === op.id;
  const v = validateMove(ctx, state, op, params.path, {
    action: 'Charge',
    bonusInches: 2,
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
    hardCap: counteracting ? 2 : 3,
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  if (!apply) return { ok: true };
  op.pos = { ...v.endPos };
  op.z = v.endZ;
  if (params.path.endRot !== undefined) op.rot = params.path.endRot;
  op.onGuard = false;
  op.stickyEngagedWith = enemiesInControlRange(ctx, state, op).map((e) => e.id);
  dropEffects(state, (e) => e.rule === HUNT_READY && e.operativeId === op.id);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} performs ${CHARGE_HUNT} (${v.total}")`,
    data: { operativeId: op.id, action: CHARGE_HUNT, inches: v.total },
  });
  return { ok: true };
}

/**
 * DASH AND SPRAY. "Perform a free Dash action and a free Shoot action with this operative in any
 * order. You can only select dual autopistols (focused) for that Shoot action."
 *
 * The engine cannot interleave two actions, and `startShoot` leaves the sequence mid-flight when it
 * raises a decision, so the Dash is resolved FIRST and the shot second — the deterministic order
 * D-016 asks for. `check` validates the shot from the POST-Dash position, so nothing `check`
 * accepts can fail in `perform` (D-026). Both halves are still Dash and Shoot actions, so both keys
 * are pushed into `actionsThisActivation` and both are refused if already performed.
 */
function dashAndSpray(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  apply: boolean,
): { ok: boolean; reason?: string } {
  if (op.order === 'conceal') return { ok: false, reason: 'it cannot perform this action with a Conceal order' };
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'within control range of an enemy operative' };
  if (did(op, 'Dash')) return { ok: false, reason: 'already performed Dash this activation' };
  if (did(op, 'Shoot')) return { ok: false, reason: 'already performed Shoot this activation' };
  if (did(op, 'Charge')) return { ok: false, reason: 'already performed Charge this activation' };

  const weapon = weaponsOf(ctx, state, op, 'ranged').find((w) => w.name.trim().toLowerCase() === 'dual autopistols');
  if (!weapon) return { ok: false, reason: 'it has no dual autopistols' };
  const profile = weapon.profiles.find((p) => p.name === 'focused');
  if (!profile) return { ok: false, reason: 'it has no dual autopistols (focused) profile' };

  // The Dash: the caller's path, or "stay where you are" when none is supplied (D-016).
  let endPos = { ...op.pos };
  let endZ = op.z;
  let dashed = 0;
  if (params.path) {
    const v = validateMove(ctx, state, op, params.path, { action: 'Dash', noClimb: true, mustNotFinishEngaged: true });
    if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal Dash' };
    endPos = { ...v.endPos };
    endZ = v.endZ;
    dashed = v.total;
  }

  // The shot, checked from where the Dash ends.
  const proxy: OperativeState = { ...op, pos: endPos, z: endZ };
  const rules = effectiveRules(ctx, state, profile, { operative: proxy, weaponName: weapon.name });
  const wanted = params.targetId ?? params.targetOperativeId;
  const targets = aliveOperatives(state, otherPlayer(op.player)).filter(
    (t) => checkTarget(ctx, state, proxy, t, profile, rules).valid,
  );
  if (targets.length === 0) return { ok: false, reason: 'no valid target for the dual autopistols (focused)' };
  if (wanted !== undefined && !targets.some((t) => t.id === wanted))
    return { ok: false, reason: 'that operative is not a valid target for the dual autopistols (focused)' };
  const target = targets.find((t) => t.id === wanted) ?? [...targets].sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
  if (!apply) return { ok: true };

  if (params.path) {
    op.pos = endPos;
    op.z = endZ;
    if (params.path.endRot !== undefined) op.rot = params.path.endRot;
    op.onGuard = false;
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} performs a free Dash (DASH AND SPRAY, ${dashed}")`,
      data: { operativeId: op.id, inches: dashed },
    });
  }
  op.actionsThisActivation.push('Dash', 'Shoot');
  const shootAction = getAction('Shoot')!;
  return shootAction.perform(ctx, state, op, {
    weaponName: weapon.name,
    profileName: 'focused',
    targetId: target.id,
  });
}

// ---------------------------------------------------------------------------

export const goremonger = defineTeam({
  id: 'goremonger',
  rareRules: ['Drag', 'Prey', 'Ritual'],
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "…when a friendly GOREMONGER operative is fighting during an activation in which it
    //  performed the Charge action, at the end of the Roll Attack Dice step."
    [FP.unbridledAggression]: (state, player) =>
      unbridledCandidate(state, staticHooks(player))
        ? { ok: true }
        : { ok: false, reason: 'no friendly GOREMONGER operative is fighting after a Charge' },
    // "Use this firefight ploy when you would counteract."
    [FP.gorethirst]: (state, player) =>
      gorethirstCandidates(state, staticHooks(player)).length > 0
        ? { ok: true }
        : { ok: false, reason: 'no expended Conceal-order GOREMONGER operative can counteract' },
    // "…when a friendly GOREMONGER operative is incapacitated, before it's removed from the
    //  killzone." Declared in advance, so it is only offered while it could actually pay out.
    [FP.destructiveDemise]: (state, player) => {
      if (state.effects.some((e) => e.rule === DEMISE_ARMED && e.player === player))
        return { ok: false, reason: 'DESTRUCTIVE DEMISE is already armed' };
      const T = staticHooks(player);
      const engaged = T.friendlies(state, KW).some((o) =>
        aliveOperatives(state, otherPlayer(player)).some((e) => T.gap(o, e) <= 1 + EPS),
      );
      return engaged ? { ok: true } : { ok: false, reason: 'no friendly GOREMONGER operative is engaged' };
    },
    // "…when a friendly GOREMONGER operative with an empty GORE TANK is activated or counteracts."
    [FP.lacerateFlesh]: (state, player) =>
      lacerateCandidate(state, staticHooks(player))
        ? { ok: true }
        : { ok: false, reason: 'the activated operative’s GORE TANK is not empty' },
  },
  aiHints: {
    roles: {
      [C.bloodHerald]: 'leader',
      [C.aspirant]: 'melee',
      [C.bloodtaker]: 'support',
      [C.impaler]: 'gunner',
      [C.inciter]: 'gunner',
      [C.skullclaimer]: 'melee',
      [C.stalker]: 'scout',
    },
    ployValue: {
      [SP.enhancedViolence]: 0.8,
      [SP.augmentedEndurance]: 0.6,
      [SP.goryTenacity]: 0.6,
      [SP.huntForBlood]: 0.5,
      [FP.unbridledAggression]: 0.7,
      [FP.gorethirst]: 0.5,
      [FP.destructiveDemise]: 0.4,
      [FP.lacerateFlesh]: 0.3,
    },
    equipmentValue: {
      [EQ.goryTotem]: 0.5,
      [EQ.bloodyCadaver]: 0.6,
      [EQ.chaosSigil]: 0.5,
      [EQ.wristChains]: 0.4,
    },
  },
});

export default goremonger;
