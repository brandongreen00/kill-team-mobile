/**
 * INQUISITORIAL AGENT — Agents of the Imperium.
 * https://wahapedia.ru/kill-team3/kill-teams/inquisitorial-agent/
 *
 * Rule text is read from `data/teams/inquisitorial-agent.json`; every hook carries a short
 * verbatim quote of the printed rule in its RuleBinding.
 *
 * The largest team in the game: 18 datacards, 26 abilities, 5 unique actions. Two ideas do
 * most of the work and are therefore modelled once and read everywhere:
 *   - an INQUISITORIAL TOME rule held by the INTERROGATOR and/or the TOME-SKULL (`tomeOf`);
 *   - the player's quarry for the turning point (`quarryOf`).
 * Both are effects on the state, never module-level variables (architecture rule 7).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { baseGap } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { successes } from '../../core/dice.ts';
import { validateMove } from '../../core/movement.ts';
import {
  aliveOperatives,
  body,
  enemiesInControlRange,
  gapBetween,
  inflictDamage,
  isInjured,
  isWounded,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { UTILITY_ID } from '../../core/equipment/grenades.ts';
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
import { otherPlayer } from '../../core/types.ts';
import { teamData, type TeamRuleText } from '../data.ts';
import {
  bucket,
  catalogueCard,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  notEngaged,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  FREE_ACTION_RULE,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('inquisitorial-agent');
const KW = 'INQUISITORIAL AGENT';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionTextOf = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

/** The weapon table printed underneath a faction equipment option (COMBAT DAGGERS). */
function printedWeapon(ruleId: string, name: string): Weapon {
  const holder = DATA.equipment.find((r) => r.id === ruleId) as (TeamRuleText & { weapons?: Weapon[] }) | undefined;
  const w = holder?.weapons?.find((x) => x.name === name);
  if (!w) throw new Error(`No printed weapon '${name}' on '${ruleId}' in data/teams/inquisitorial-agent.json`);
  return w;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const RULE_REQUISITION = 'inquisitorial-agent.rule.inquisitorial-requisition';

export const SP = {
  denounce: 'inquisitorial-agent.sp.denounce',
  intenseScrutiny: 'inquisitorial-agent.sp.intense-scrutiny',
  quarry: 'inquisitorial-agent.sp.quarry',
  irrefutableJurisdiction: 'inquisitorial-agent.sp.irrefutable-jurisdiction',
} as const;

/**
 * The four firefight ploy ids (and names) carry a glued-on "1CP" — `ABSOLUTE AUTHORITY1CP`.
 * That is a scraper bug in the committed JSON, reported rather than papered over: the ids are
 * used verbatim so a re-scrape that fixes them fails these bindings loudly.
 */
export const FP = {
  absoluteAuthority: 'inquisitorial-agent.fp.absolute-authority1cp',
  relentlessInPursuit: 'inquisitorial-agent.fp.relentless-in-pursuit1cp',
  emperorsWill: 'inquisitorial-agent.fp.the-emperors-will1cp',
  intimidatingPresence: 'inquisitorial-agent.fp.intimidating-presence1cp',
} as const;

export const EQ = {
  rosette: 'inquisitorial-agent.eq.inquisitorial-rosette',
  daggers: 'inquisitorial-agent.eq.combat-daggers',
  bodysuits: 'inquisitorial-agent.eq.armoured-bodysuits',
  servoSkull: 'inquisitorial-agent.eq.servo-skull',
} as const;

export const CARD = {
  interrogator: 'inquisitorial-agent.interrogator-agent',
  tomeSkull: 'inquisitorial-agent.tome-skull',
  autosavant: 'inquisitorial-agent.autosavant-agent',
  deathWorldVeteran: 'inquisitorial-agent.death-world-veteran-agent',
  enlightener: 'inquisitorial-agent.enlightener-agent',
  hexorcist: 'inquisitorial-agent.hexorcist-agent',
  mystic: 'inquisitorial-agent.mystic-agent',
  penalLegionnaire: 'inquisitorial-agent.penal-legionnaire-agent',
  pistolier: 'inquisitorial-agent.pistolier-agent',
  questkeeper: 'inquisitorial-agent.questkeeper-agent',
  gunServitor: 'inquisitorial-agent.requisitioned-gun-servitor',
  prosecutor: 'inquisitorial-agent.sister-of-silence-prosecutor',
  vigilator: 'inquisitorial-agent.sister-of-silence-vigilator',
  witchseeker: 'inquisitorial-agent.sister-of-silence-witchseeker',
  scionGunner: 'inquisitorial-agent.tempestus-scion-gunner',
  scionMedic: 'inquisitorial-agent.tempestus-scion-medic',
  scionTrooper: 'inquisitorial-agent.tempestus-scion-trooper',
  scionVox: 'inquisitorial-agent.tempestus-scion-vox-operator',
} as const;

const AB = {
  tomes: 'inquisitorial-agent.interrogator-agent.inquisitorial-tomes',
  consecratedTome: 'inquisitorial-agent.tome-skull.consecrated-tome',
  machine: 'inquisitorial-agent.tome-skull.machine',
  expendable: 'inquisitorial-agent.tome-skull.expendable',
  groupActivation: 'inquisitorial-agent.tome-skull.group-activation',
  scrivener: 'inquisitorial-agent.autosavant-agent.scrivener',
  irrefutableReport: 'inquisitorial-agent.autosavant-agent.irrefutable-report',
  lightlyArmedAutosavant: 'inquisitorial-agent.autosavant-agent.lightly-armed',
  hunter: 'inquisitorial-agent.death-world-veteran-agent.hunter',
  weathered: 'inquisitorial-agent.death-world-veteran-agent.weathered',
  noEscape: 'inquisitorial-agent.enlightener-agent.no-escape',
  extractInformation: 'inquisitorial-agent.enlightener-agent.extract-information',
  hexorcise: 'inquisitorial-agent.hexorcist-agent.hexorcise',
  iconBearer: 'inquisitorial-agent.mystic-agent.icon-bearer',
  lightlyArmedMystic: 'inquisitorial-agent.mystic-agent.lightly-armed',
  chemMask: 'inquisitorial-agent.penal-legionnaire-agent.chem-mask',
  cruel: 'inquisitorial-agent.penal-legionnaire-agent.cruel',
  pistolier: 'inquisitorial-agent.pistolier-agent.pistolier',
  irrepressiblePurpose: 'inquisitorial-agent.questkeeper-agent.irrepressible-purpose',
  zealot: 'inquisitorial-agent.questkeeper-agent.zealot',
  lobotomised: 'inquisitorial-agent.requisitioned-gun-servitor.lobotomised',
  psychicNullProsecutor: 'inquisitorial-agent.sister-of-silence-prosecutor.psychic-null',
  psychicNullVigilator: 'inquisitorial-agent.sister-of-silence-vigilator.psychic-null',
  psychicNullWitchseeker: 'inquisitorial-agent.sister-of-silence-witchseeker.psychic-null',
  medic: 'inquisitorial-agent.tempestus-scion-medic.medic',
  adaptiveEquipment: 'inquisitorial-agent.tempestus-scion-trooper.adaptive-equipment',
} as const;

export const ACT = {
  chasten: 'inquisitorial-agent.hexorcist-agent.act.chasten',
  scry: 'inquisitorial-agent.mystic-agent.act.scry',
  pistolBarrage: 'inquisitorial-agent.pistolier-agent.act.pistol-barrage',
  medikit: 'inquisitorial-agent.tempestus-scion-medic.act.medikit',
  signal: 'inquisitorial-agent.tempestus-scion-vox-operator.act.signal',
} as const;

/** Extra `ActionDef`s the printed rules force (D-021: `canPerformAction` can only forbid). */
export const HUNTER_CHARGE = 'Charge (Hunter)';
export const PISTOL_BARRAGE_2 = `${ACT.pistolBarrage}.2`;
export const SIGNAL_2 = `${ACT.signal}.2`;
export const SMOKE_ADAPTIVE = 'Smoke Grenade (Adaptive Equipment)';
export const STUN_ADAPTIVE = 'Stun Grenade (Adaptive Equipment)';

/** Effect rule names. */
const TOME_EFFECT = 'inquisitorial-agent.tome';
const QUARRY_EFFECT = 'inquisitorial-agent.quarry';
const DENOUNCE_EFFECT = 'inquisitorial-agent.denounce';
const NO_ESCAPE_EFFECT = 'inquisitorial-agent.noEscape';
const CHASTEN_EFFECT = 'inquisitorial-agent.chasten';
const SCRY_EFFECT = 'inquisitorial-agent.scry';
const EMPERORS_WILL_EFFECT = 'inquisitorial-agent.emperorsWill';
const MEDIC_SHIELD = 'inquisitorial-agent.medicShield';
const MEDIC_USED_ON = 'inquisitorial-agent.medicUsedOn';
const GROUP_ACTIVATION_EFFECT = 'inquisitorial-agent.groupActivation';
const APL_TIMED = 'inquisitorial-agent.aplTimed';
const CANNOT_RETALIATE = 'cannotRetaliate';

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Inquisitorial Requisition (the one faction rule)
// ---------------------------------------------------------------------------

/**
 * "REQUISITIONED operatives can be taken from one of the following groups…" — the six group
 * names are printed as bare uppercase lines with no ids of their own, so they are sliced out
 * of the faction rule text at load (the Legionary MARKS OF CHAOS idiom).
 */
export const REQUISITION_GROUPS: readonly string[] = (() => {
  const printed = text(RULE_REQUISITION);
  const start = printed.indexOf('selection rules:');
  const end = printed.indexOf('These operatives have their faction keyword replaced');
  if (start < 0 || end < 0) return [];
  return printed
    .slice(start + 'selection rules:'.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line === line.toUpperCase());
})();

/** Datacards in this team's own JSON that belong to a REQUISITIONED group. */
export const REQUISITIONED_CARDS: readonly string[] = DATA.datacards
  .filter((c) => REQUISITION_GROUPS.some((g) => c.keywords.includes(g)))
  .map((c) => c.id);

// ---------------------------------------------------------------------------
// INQUISITORIAL TOMES
// ---------------------------------------------------------------------------

export const TOMES = ['Denunciation', 'Sanctification'] as const;
export type Tome = (typeof TOMES)[number];

/** The two INQUISITORIAL TOME rules, sliced out of the printed Inquisitorial Tomes text. */
export const TOME_RULE: Record<Tome, string> = (() => {
  const printed = abilityText(CARD.interrogator, AB.tomes);
  const out = {} as Record<Tome, string>;
  TOMES.forEach((tome, i) => {
    const start = printed.indexOf(`${tome}:`);
    const next = TOMES[i + 1];
    const endAt = next ? printed.indexOf(`${next}:`) : -1;
    out[tome] = start < 0 ? tome : printed.slice(start, endAt < 0 ? printed.length : endAt).trim();
  });
  return out;
})();

const TOME_SET: ReadonlySet<string> = new Set(TOMES);

export function tomeOf(state: GameState, op: OperativeState): Tome | undefined {
  const v = effectOn(state, op.id, TOME_EFFECT)?.data?.['tome'];
  return typeof v === 'string' && TOME_SET.has(v) ? (v as Tome) : undefined;
}

/**
 * "Select one of the following INQUISITORIAL TOME rules for this operative to have, and one
 * for a friendly INQUISITORIAL AGENT TOME-SKULL operative to have."
 *
 * Consecrated Tome: "Note it keeps that rule even if that friendly INTERROGATOR operative is
 * removed from the killzone" — so the TOME-SKULL's effect hangs off the TOME-SKULL, not the
 * INTERROGATOR, and lasts until the end of the battle.
 */
function setTome(state: GameState, op: OperativeState, tome: Tome): void {
  dropEffects(state, (e) => e.rule === TOME_EFFECT && e.operativeId === op.id);
  effect(state, {
    rule: TOME_EFFECT,
    source: { kind: 'ability', id: AB.tomes },
    sourceText: TOME_RULE[tome],
    operativeId: op.id,
    player: op.player,
    data: { tome },
    expiry: { kind: 'endOfBattle' },
  });
  log(state, { kind: 'action', player: op.player, text: `${op.letter} has the ${tome} INQUISITORIAL TOME rule` });
}

const TOMES_GAMBIT = AB.tomes;
const TOMES_DECISION = 'inquisitorial-agent.tomes';

/** The four INTERROGATOR × TOME-SKULL combinations ("they can be the same"). */
function tomeCombos(): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const mine of TOMES) for (const skull of TOMES) out.push({ id: `${mine}|${skull}`, label: `INTERROGATOR ${mine}, TOME-SKULL ${skull}` });
  return out;
}

function applyTomeCombo(T: TeamHooks, state: GameState, comboId: string): void {
  const [mine, skull] = comboId.split('|');
  const interrogator = T.friendlies(state).find((o) => o.datacardId === CARD.interrogator);
  const tomeSkull = T.friendlies(state).find((o) => o.datacardId === CARD.tomeSkull);
  if (interrogator && mine && TOME_SET.has(mine)) setTome(state, interrogator, mine as Tome);
  if (tomeSkull && skull && TOME_SET.has(skull)) setTome(state, tomeSkull, skull as Tome);
}

/** "…an enemy operative within 2" of friendly operatives with this rule." */
function nearTomeHolder(T: TeamHooks, state: GameState, op: OperativeState, tome: Tome): boolean {
  return T.friendlies(state).some((o) => tomeOf(state, o) === tome && T.gap(o, op) <= 2 + EPS);
}

// ---------------------------------------------------------------------------
// Quarry
// ---------------------------------------------------------------------------

export function quarryOf(state: GameState, player: PlayerId): string | undefined {
  const eff = state.effects.find((e) => e.rule === QUARRY_EFFECT && e.player === player);
  const id = eff?.data?.['targetId'];
  return typeof id === 'string' ? id : undefined;
}

function setQuarry(T: TeamHooks, state: GameState, target: OperativeState, why: string): void {
  dropEffects(state, (e) => e.rule === QUARRY_EFFECT && e.player === T.player);
  effect(state, {
    rule: QUARRY_EFFECT,
    source: { kind: 'ploy', id: SP.quarry },
    sourceText: shortQuote(text(SP.quarry)),
    player: T.player,
    data: { targetId: target.id },
    expiry: { kind: 'endOfTurningPoint' },
  });
  log(state, { kind: 'ploy', player: T.player, text: `${why}: ${target.letter} is the quarry` });
}

/** D-016: the named enemy, else the enemy closest to any friendly operative. */
function nearestEnemy(T: TeamHooks, state: GameState, exclude?: string): OperativeState | undefined {
  const mine = T.friendlies(state);
  return [...T.enemies(state)]
    .filter((e) => e.id !== exclude && !e.incapacitated)
    .map((e) => ({ e, d: Math.min(...mine.map((f) => T.gap(f, e)), Infinity) }))
    .sort((a, b) => a.d - b.d || (a.e.id < b.e.id ? -1 : 1))[0]?.e;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

function visible(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, a), body(T.ctx, b)).visible;
}

/** The weapon profile currently inflicting damage — `onDamage` never carries an AttackContext. */
function currentProfile(T: TeamHooks, state: GameState): { op: OperativeState; profile: WeaponProfile } | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const holderId = seq.kind === 'shoot' ? seq.attackerId : (seq.turn === 'attacker' ? seq.attackerId : seq.defenderId);
  const holder = state.operatives[holderId];
  if (!holder) return undefined;
  const name =
    seq.kind === 'shoot' ? seq.weaponName : holderId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const profileName = seq.kind === 'shoot' ? seq.profileName : holderId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
  return profile ? { op: holder, profile } : undefined;
}

/** Base-to-base gap without a GameContext, for `PloyDef.usable` (which is given none). */
function catalogueGap(a: OperativeState, b: OperativeState): number {
  const ba = catalogueCard(a.datacardId)?.base ?? { shape: 'round' as const, mm: 32 };
  const bb = catalogueCard(b.datacardId)?.base ?? { shape: 'round' as const, mm: 32 };
  return baseGap(a.pos, ba, a.rot, b.pos, bb, b.rot);
}

const cardHasKw = (op: OperativeState, keyword: string): boolean =>
  (catalogueCard(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

const isMissionAction = (action: string): boolean => getAction(action)?.type === 'mission';

/** A PSYCHIC unique action is printed with "PSYCHIC." as its first word (the Celestian idiom). */
export const isPsychicAction = (t: string): boolean => /^PSYCHIC\b/i.test(t.trim());
const hasPsychicProfile = (profile: WeaponProfile): boolean => profile.rules.some((r) => r.id === 'PSYCHIC');

/**
 * "Add 1 to its APL stat until the end of [its next] activation" — the +1 is pushed into
 * `aplMods` (which the engine never pops) and paired with an effect so it can be undone at the
 * right moment. Without the pairing every boosted operative would sit at APL 3 for the battle.
 */
function timedApl(
  state: GameState,
  op: OperativeState,
  delta: number,
  spec: { sourceId: string; sourceText: string; until: 'activation' | 'nextActivation' },
): void {
  op.aplMods.push(delta);
  effect(state, {
    rule: APL_TIMED,
    source: { kind: 'ability', id: spec.sourceId },
    sourceText: spec.sourceText,
    operativeId: op.id,
    player: op.player,
    data: { delta },
    expiry:
      spec.until === 'activation'
        ? { kind: 'endOfActivation', operativeId: op.id }
        : { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
  });
}

function popTimedApl(state: GameState, op: OperativeState): void {
  const due = state.effects.filter(
    (e) =>
      e.rule === APL_TIMED &&
      e.operativeId === op.id &&
      ((e.expiry.kind === 'endOfActivation' && e.expiry.operativeId === op.id) ||
        (e.expiry.kind === 'endOfNextActivation' && e.expiry.operativeId === op.id && e.expiry.armed)),
  );
  for (const e of due) {
    const at = op.aplMods.lastIndexOf(Number(e.data?.['delta'] ?? 0));
    if (at >= 0) op.aplMods.splice(at, 1);
  }
  dropEffects(state, (e) => due.includes(e));
}

/** The rules of this team that hand out a free action, for the stale-grant sweep below. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set<string>([FP.relentlessInPursuit, AB.medic]);

// ---------------------------------------------------------------------------
// Machine (TOME-SKULL): the effects the core reads by name
// ---------------------------------------------------------------------------

/** "It cannot retaliate…" — `startFight` reads a `cannotRetaliate` effect by that name. */
function ensureMachine(T: TeamHooks, state: GameState): void {
  for (const op of T.friendlies(state)) {
    if (op.datacardId !== CARD.tomeSkull) continue;
    if (effectOn(state, op.id, CANNOT_RETALIATE)) continue;
    effect(state, {
      rule: CANNOT_RETALIATE,
      source: { kind: 'ability', id: AB.machine },
      sourceText: shortQuote(abilityText(CARD.tomeSkull, AB.machine)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfBattle' },
    });
  }
}

const MACHINE_ACTIONS = ['Charge', 'Dash', 'Fall Back', 'Reposition'];

// ---------------------------------------------------------------------------
// DENOUNCE
// ---------------------------------------------------------------------------

/** "This ploy costs you 1 additional CP for each previous time you've used it." Read-only: it is
 *  consulted from `gambitOptions`, which the AI runs as a pure query. */
export function denounceCost(state: GameState, player: PlayerId): number {
  const b = state.opState['inquisitorial-agent.denounceUses'] as Record<string, unknown> | undefined;
  return 1 + Number(b?.[player] ?? 0);
}

function bumpDenounceUses(state: GameState, player: PlayerId): void {
  const b = bucket(state, 'inquisitorial-agent.denounceUses');
  b[player] = Number(b[player] ?? 0) + 1;
}

/**
 * "…cannot be activated or perform actions until it's the last enemy operative to be
 * activated, or your opponent has activated a number of enemy operatives equal to the D3."
 */
export function denounced(state: GameState, op: OperativeState): boolean {
  const eff = effectOn(state, op.id, DENOUNCE_EFFECT);
  if (!eff) return false;
  if (Number(eff.data?.['tp'] ?? 0) !== state.turningPoint) return false;
  if (Number(eff.data?.['activations'] ?? 0) >= Number(eff.data?.['count'] ?? 0)) return false;
  const others = aliveOperatives(state, op.player).filter((o) => o.id !== op.id);
  if (others.length > 0 && others.every((o) => !o.ready)) return false; // it is the last to be activated
  return true;
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Inquisitorial Requisition (faction rule)
  // =========================================================================
  // "You cannot use ploys and equipment associated with a REQUISITIONED operative's former
  //  faction keyword." Faction equipment ids are `<team-slug>.eq.*`; universal equipment is
  //  `eq.*`. Anything belonging to another kill team is dropped at selection.
  reg.on('onSelectEquipment', T.bind(RULE_REQUISITION, 10), (ev) => {
    if (ev.player !== T.player) return;
    const foreign = ev.equipment.filter((id) => /^[a-z0-9-]+\.eq\./.test(id) && !id.startsWith(`${DATA.id}.`));
    if (foreign.length === 0) return;
    ev.equipment = ev.equipment.filter((id) => !foreign.includes(id));
    // The reducer copies the intent's list onto the team BEFORE emitting, so the team's own
    // list is what has to be trimmed for the ban to bite.
    ev.state.teams[T.player].equipment = ev.state.teams[T.player].equipment.filter((id) => !foreign.includes(id));
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Inquisitorial Requisition: ${foreign.join(', ')} is another faction's equipment and cannot be used`,
    });
  });

  // =========================================================================
  // INTERROGATOR › Inquisitorial Tomes  (+ TOME-SKULL › Consecrated Tome)
  // =========================================================================
  reg.on('gambitOptions', T.bind(AB.tomes, 15), (ev) => {
    if (ev.player !== T.player) return;
    // "STRATEGIC GAMBIT if this operative is in the killzone…"
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.interrogator)) return;
    for (const combo of tomeCombos()) {
      ev.options.push({
        id: `${TOMES_GAMBIT}:${combo.id}`,
        label: `Inquisitorial Tomes — ${combo.label}`,
        sourceText: shortQuote(abilityText(CARD.interrogator, AB.tomes)),
      });
    }
  });
  reg.on('onPloyUsed', T.bind(AB.tomes, 16), (ev) => {
    if (ev.player !== T.player || !ev.ployId.startsWith(`${TOMES_GAMBIT}:`)) return;
    applyTomeCombo(T, ev.state, ev.ployId.slice(TOMES_GAMBIT.length + 1));
  });
  // "…and/or when this operative is activated." The engine has a decision channel here, so the
  // second half is a real PendingDecision. "Keep" is first, so the deterministic default is to
  // leave the tomes alone rather than silently re-picking them.
  reg.on('onActivationStart', T.bind(AB.tomes, 17), (ev) => {
    if (ev.operative.datacardId !== CARD.interrogator || ev.operative.player !== T.player) return;
    ev.state.pending.push({
      id: `iatomes-${ev.state.seq++}`,
      who: T.player,
      kind: TOMES_DECISION,
      prompt: `${ev.operative.letter}: select INQUISITORIAL TOME rules`,
      sourceText: shortQuote(abilityText(CARD.interrogator, AB.tomes)),
      ctx: { player: T.player },
      options: [
        { id: 'keep', label: 'Keep the current INQUISITORIAL TOME rules' },
        ...tomeCombos().map((c) => ({ id: c.id, label: c.label, data: { combo: c.id, player: T.player } })),
      ],
    });
  });
  // Denunciation: "add 1 to the Atk stat of that friendly operative's weapons."
  reg.on('onCollectAttackDice', T.bindText(`${AB.tomes}.denunciation`, TOME_RULE.Denunciation, 12), (ev) => {
    const attacker = ev.ctx.attacker;
    const foe = ev.ctx.defender;
    if (!foe || !T.mineKw(attacker, KW)) return;
    if (!nearTomeHolder(T, ev.state, foe, 'Denunciation')) return;
    ev.count += 1;
  });
  // Sanctification: "subtract 1 from the Atk stat of that enemy operative's weapons."
  reg.on('onCollectAttackDice', T.bindText(`${AB.tomes}.sanctification`, TOME_RULE.Sanctification, 12), (ev) => {
    const attacker = ev.ctx.attacker;
    const foe = ev.ctx.defender;
    if (attacker.player === T.player || !foe || !T.mineKw(foe, KW)) return;
    if (!nearTomeHolder(T, ev.state, foe, 'Sanctification')) return;
    ev.count = Math.max(0, ev.count - 1);
  });

  // =========================================================================
  // TOME-SKULL
  // =========================================================================
  // Machine › "cannot perform any actions other than Charge, Dash, Fall Back and Reposition."
  reg.on('canPerformAction', T.bind(AB.machine, 12), (ev) => {
    if (ev.operative.datacardId !== CARD.tomeSkull || ev.operative.player !== T.player) return;
    const restrictionKey = getAction(ev.action)?.treatedAs ?? ev.action;
    if (MACHINE_ACTIONS.includes(restrictionKey)) return;
    ev.allowed = false;
    ev.reason = 'this operative cannot perform any actions other than Charge, Dash, Fall Back and Reposition';
  });
  // Machine › "It cannot retaliate or assist in a fight."
  reg.on('onActivationStart', T.bind(AB.machine, 11), (ev) => ensureMachine(T, ev.state));
  reg.on('onDeploy', T.bind(AB.machine, 11), (ev) => {
    if (ev.operative.player === T.player) ensureMachine(T, ev.state);
  });
  reg.on('onReadyStep', T.bind(AB.machine, 11), (ev) => {
    if (ev.player === T.player) ensureMachine(T, ev.state);
  });
  reg.on('onFightAssist', T.bind(AB.machine, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.assists <= 0 || !T.ctx) return;
    // `assistCount` does not say which enemy the fight is against, so an assisting TOME-SKULL is
    // recognised by replaying the same test against every enemy in the fighter's control range.
    const foes = T.enemies(ev.state).filter((e) => T.gap(ev.operative, e) <= 1 + EPS);
    for (const skull of T.friendlies(ev.state)) {
      if (skull.datacardId !== CARD.tomeSkull || skull.id === ev.operative.id) continue;
      const counted = foes.some(
        (foe) =>
          T.gap(skull, foe) <= 1 + EPS && !T.enemies(ev.state).some((o) => o.id !== foe.id && T.gap(skull, o) <= 1 + EPS),
      );
      if (counted) ev.assists = Math.max(0, ev.assists - 1);
    }
  });
  // Machine › "Whenever determining control of a marker, treat this operative's APL stat as 1
  //  lower. Note this isn't a change to its APL stat, so any changes are cumulative with this."
  reg.on('onMarkerControl', T.bind(AB.machine, 14), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    for (const op of T.friendlies(ev.state)) {
      if (op.datacardId !== CARD.tomeSkull) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
      ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - 1);
    }
  });
  // Machine › "Whenever this operative has a Conceal order and is in cover, it cannot be
  //  selected as a valid target, taking precedence over all other rules … except being within 2"."
  reg.on('onValidTarget', T.bind(AB.machine, 15), (ev) => {
    const target = ev.target;
    if (target.datacardId !== CARD.tomeSkull || target.player !== T.player) return;
    if (target.order !== 'conceal' || !T.ctx) return;
    if (gapBetween(T.ctx, ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    const index = terrain(T.ctx, ev.state);
    const cover = coverAndObscured(index, body(T.ctx, ev.attacker), body(T.ctx, target));
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'the TOME-SKULL has a Conceal order and is in cover';
  });
  // Group Activation — the engine alternates activations strictly, so the pairing is recorded
  // as an effect for the UI/AI (the Breach and Clear / Group Activation partial).
  reg.on('onActivationEnd', T.bind(AB.groupActivation, 16), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    if (op.datacardId !== CARD.tomeSkull && op.datacardId !== CARD.interrogator) return;
    const wantId = op.datacardId === CARD.tomeSkull ? CARD.interrogator : CARD.tomeSkull;
    const partner = T.friendlies(ev.state).find((o) => o.datacardId === wantId && o.ready);
    if (!partner) return;
    effect(ev.state, {
      rule: GROUP_ACTIVATION_EFFECT,
      source: { kind: 'ability', id: AB.groupActivation },
      sourceText: shortQuote(abilityText(CARD.tomeSkull, AB.groupActivation)),
      operativeId: partner.id,
      player: T.player,
      data: { after: op.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Group Activation: ${partner.letter} must activate next`,
    });
  });

  // =========================================================================
  // AUTOSAVANT
  // =========================================================================
  // Scrivener › "Each subsequent time your opponent uses each ploy during the battle (excluding
  //  Command Re-roll), if this operative is in the killzone, you gain 1CP (max 2CP per TP)."
  reg.on('onPloyUsed', T.bind(AB.scrivener, 12), (ev) => {
    if (ev.player === T.player) return;
    const b = bucket(ev.state, `inquisitorial-agent.scrivener:${T.player}`);
    const before = Number(b[ev.ployId] ?? 0);
    b[ev.ployId] = before + 1;
    if (before === 0) return; // the FIRST use is not a "subsequent time"
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.autosavant)) return;
    const gainedKey = `gained:${ev.state.turningPoint}`;
    const gained = Number(b[gainedKey] ?? 0);
    if (gained >= 2) return; // "to a maximum of 2CP per turning point"
    b[gainedKey] = gained + 1;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Scrivener: +1CP' });
  });
  // Irrefutable Report › "…it always controls that marker. This takes precedence over all
  //  other rules."
  reg.on('onMarkerControl', T.bind(AB.irrefutableReport, 60), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    if (marker.kind !== 'objective' && marker.owner !== T.player) return; // "or one of YOUR mission markers"
    const savant = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.autosavant && markerContestedBy(T.ctx!, ev.state, marker, o),
    );
    if (savant) ev.forced = T.player;
  });
  // Lightly Armed › "cannot use any weapons that aren't on its datacard, or perform unique
  //  actions." Granted weapons bypass `availableWeapons` (they are appended after the hook), so
  //  they are stripped from the operative instead.
  const stripGranted = (op: OperativeState): void => {
    const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
    if (holder.grantedWeapons && holder.grantedWeapons.length > 0) holder.grantedWeapons = [];
  };
  reg.on('onActivationStart', T.bind(AB.lightlyArmedAutosavant, 13), (ev) => {
    for (const op of T.friendlies(ev.state)) {
      if (op.datacardId === CARD.autosavant || op.datacardId === CARD.mystic) stripGranted(op);
    }
  });
  reg.on('canPerformAction', T.bind(AB.lightlyArmedAutosavant, 13), (ev) => {
    if (ev.operative.datacardId !== CARD.autosavant || ev.operative.player !== T.player) return;
    if (getAction(ev.action)?.type !== 'unique') return;
    ev.allowed = false;
    ev.reason = 'this operative cannot perform unique actions';
  });

  // =========================================================================
  // DEATH WORLD VETERAN
  // =========================================================================
  // Hunter is the `Charge (Hunter)` action below (D-021); this binding records the rule and
  // keeps the once-per-activation restriction shared with the universal Charge.
  reg.on('canPerformAction', T.bind(AB.hunter, 12), (ev) => {
    if (ev.action !== HUNTER_CHARGE) return;
    if (ev.operative.datacardId === CARD.deathWorldVeteran) return;
    ev.allowed = false;
    ev.reason = 'only a DEATH WORLD VETERAN can Charge with a Conceal order';
  });
  // Weathered › "Once per turning point, when this operative is fighting or retaliating, in the
  //  Resolve Attack Dice step, you can ignore the damage inflicted on it from one normal success."
  reg.on('onDamage', T.bind(AB.weathered, 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (ev.target.datacardId !== CARD.deathWorldVeteran || ev.target.player !== T.player) return;
    if (!fightSeq(ev.state)) return; // "when this operative is fighting or retaliating"
    const cur = currentProfile(T, ev.state);
    if (!cur || ev.amount !== cur.profile.dmgN) return; // "from one NORMAL success"
    if (!useOncePerTP(ev.state, `inquisitorial-agent.weathered:${ev.target.id}`)) return;
    ev.amount = 0;
    log(ev.state, { kind: 'action', player: T.player, text: `Weathered: ${ev.target.letter} ignores ${cur.profile.dmgN} damage` });
  });

  // =========================================================================
  // ENLIGHTENER
  // =========================================================================
  // No Escape › the D6 is rolled when the enemy operative is activated, not when it declares the
  //  Fall Back: `canPerformAction` is a pure query the AI runs many times, so rolling there would
  //  burn RNG outside the reducer (the Nemesis Claw CHAIN SNARE precedent).
  reg.on('onActivationStart', T.bind(AB.noEscape, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player || !T.ctx) return;
    const enlightener = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.enlightener && T.gap(o, foe) <= 1 + EPS,
    );
    if (!enlightener) return;
    const foeWounds = T.card(foe)?.wounds ?? 0;
    const mineWounds = T.card(enlightener)?.wounds ?? 0;
    const roll = T.ctx.rng.d6();
    const modified = roll - (foeWounds > mineWounds ? 1 : 0) + (isWounded(T.ctx, foe) ? 1 : 0);
    recordRoll(ev.state, 'noEscape', [roll], T.player, `No Escape vs ${foe.letter} (modified ${modified})`);
    if (modified < 4) return;
    effect(ev.state, {
      rule: NO_ESCAPE_EFFECT,
      source: { kind: 'ability', id: AB.noEscape },
      sourceText: shortQuote(abilityText(CARD.enlightener, AB.noEscape)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: foe.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `No Escape: ${foe.letter} cannot Fall Back this activation` });
  });
  reg.on('canPerformAction', T.bind(AB.noEscape, 13), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player === T.player) return;
    if (!effectOn(ev.state, ev.operative.id, NO_ESCAPE_EFFECT)) return;
    ev.allowed = false;
    ev.reason = 'No Escape: that operative cannot perform that action during this activation';
  });
  // Extract Information › "Whenever an enemy operative is incapacitated within this operative's
  //  control range, you gain 1CP."
  reg.on('onIncapacitated', T.bind(AB.extractInformation, 14), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    const near = T.friendlies(ev.state).some(
      (o) => o.datacardId === CARD.enlightener && T.gap(o, ev.operative) <= 1 + EPS,
    );
    if (!near) return;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, { kind: 'action', player: T.player, text: 'Extract Information: +1CP' });
  });

  // =========================================================================
  // HEXORCIST › Hexorcise
  // =========================================================================
  // "Whenever an enemy operative is visible to and within 6" of this operative, your opponent
  //  cannot re-roll their attack or defence dice for that operative."
  const hexorcised = (state: GameState, foe: OperativeState): boolean =>
    foe.player !== T.player &&
    T.friendlies(state).some(
      (o) => o.datacardId === CARD.hexorcist && T.gap(o, foe) <= 6 + EPS && visible(T, state, o, foe),
    );
  reg.on('onRollAttack', T.bind(AB.hexorcise, 45), (ev) => {
    if (!hexorcised(ev.state, ev.ctx.attacker)) return;
    const foe = ev.ctx.attacker.player;
    ev.rerolls = ev.rerolls.filter((g) => (g.player ?? foe) !== foe);
  });
  reg.on('onDefenceDice', T.bind(AB.hexorcise, 45), (ev) => {
    const defender = ev.ctx.defender;
    if (!defender || !hexorcised(ev.state, defender)) return;
    const foe = defender.player;
    ev.rerolls = ev.rerolls.filter((g) => (g.player ?? foe) !== foe);
  });
  // CHASTEN's suppression: only a unique action can actually be switched off.
  reg.on('canPerformAction', T.bind(ACT.chasten, 12), (ev) => {
    if (ev.operative.player === T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, CHASTEN_EFFECT);
    if (!eff || eff.data?.['ruleId'] !== ev.action) return;
    ev.allowed = false;
    ev.reason = 'CHASTEN: it is treated as not having that additional rule';
  });

  // =========================================================================
  // MYSTIC › Icon Bearer
  // =========================================================================
  reg.on('onMarkerControl', T.bind(AB.iconBearer, 14), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    for (const op of T.friendlies(ev.state)) {
      if (op.datacardId !== CARD.mystic) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
      ev.aplByPlayer[T.player] += 1;
    }
  });

  // =========================================================================
  // PENAL LEGIONNAIRE
  // =========================================================================
  // Chem-mask › "You can ignore any changes to this operative's APL stat, and any changes to its
  //  stats from being injured." Injured is applied inside `moveOf`/`hitOf`, outside `StatMods`,
  //  so both are cancelled here. Priority 60: after every other stat handler on either side.
  reg.on('onStatMod', T.bind(AB.chemMask, 60), (ev) => {
    if (ev.operative.datacardId !== CARD.penalLegionnaire || ev.operative.player !== T.player) return;
    const apl = ev.operative.aplMods.reduce((a, b) => a + b, 0) + ev.mods.apl;
    ev.mods.apl -= apl;
    if (T.ctx && isInjured(T.ctx, ev.operative)) {
      ev.mods.hit += 1;
      ev.mods.move += 2;
    }
  });
  // Chem-mask › "This operative isn't affected by enemy operatives' Shock and Stun weapon rules."
  reg.on('onWeaponRules', T.bind(AB.chemMask, 61), (ev) => {
    if (!ev.target || ev.target.datacardId !== CARD.penalLegionnaire || ev.target.player !== T.player) return;
    if (ev.operative.player === T.player) return; // "ENEMY operatives' Shock and Stun"
    ev.rules = ev.rules.filter((r) => r.id !== 'Shock' && r.id !== 'Stun');
  });
  // Cruel › "…against a wounded enemy operative, this operative's weapons have the Relentless
  //  weapon rule."
  reg.on('onWeaponRules', T.bind(AB.cruel, 12), (ev) => {
    if (ev.operative.datacardId !== CARD.penalLegionnaire || ev.operative.player !== T.player) return;
    if (!ev.target || !T.ctx || !isWounded(T.ctx, ev.target)) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Cruel)'));
  });

  // =========================================================================
  // PISTOLIER › Pistolier
  // =========================================================================
  // "You can ignore any changes to the Hit stat of this operative's ranged weapons."
  // `onStatMod` carries no weapon, so the in-flight shoot sequence supplies the context.
  reg.on('onStatMod', T.bind(AB.pistolier, 60), (ev) => {
    if (ev.operative.datacardId !== CARD.pistolier || ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    // `hitOf` computes profile.hit - mods.hit - extraHitMod, then adds 1 while injured. Both the
    // injured worsening and the point-blank one (passed as extraHitMod by `hitStat`, so no other
    // rule can see it) are changes to the Hit stat, so both are cancelled here.
    ev.mods.hit = (T.ctx && isInjured(T.ctx, ev.operative) ? 1 : 0) + (seq.pointBlank ? 1 : 0);
  });

  // =========================================================================
  // QUESTKEEPER
  // =========================================================================
  // Irrepressible Purpose › "If this operative is incapacitated while fighting or retaliating,
  //  you can strike the enemy operative in that sequence with one of your unresolved successes
  //  before this operative removed from the killzone."
  reg.on('onIncapacitated', T.bind(AB.irrepressiblePurpose, 15), (ev) => {
    const op = ev.operative;
    if (ev.prevented || op.datacardId !== CARD.questkeeper || op.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || !T.ctx) return;
    if (!useOncePerSequence(ev.state, `inquisitorial-agent.irrepressible:${op.id}`)) return;
    const mine = seq.attackerId === op.id ? seq.attackerPool : seq.defenderPool;
    const foe = ev.state.operatives[seq.attackerId === op.id ? seq.defenderId : seq.attackerId];
    const die = successes(mine)[0];
    if (!foe || !die) return;
    const profile = currentProfileOf(T, ev.state, op);
    const dmg = die.state === 'crit' ? (profile?.dmgC ?? 3) : (profile?.dmgN ?? 2);
    die.state = 'struck';
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Irrepressible Purpose: ${op.letter} strikes ${foe.letter} for ${dmg}`,
    });
    inflictDamage(T.ctx, ev.state, foe, dmg, 'attack');
  });
  // Zealot › "Whenever an attack dice inflicts damage of 3 or more on this operative, roll one
  //  D6: on a 5+, subtract 1 from that inflicted damage."
  reg.on('onDamage', T.bind(AB.zealot, 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount < 3) return;
    if (ev.target.datacardId !== CARD.questkeeper || ev.target.player !== T.player || !T.ctx) return;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'zealot', [roll], T.player, 'Zealot 5+');
    if (roll >= 5) ev.amount -= 1;
  });

  // =========================================================================
  // GUN SERVITOR › Lobotomised
  // =========================================================================
  reg.on('onActivationStart', T.bind(AB.lobotomised, 12), (ev) => {
    const op = ev.operative;
    if (op.datacardId !== CARD.gunServitor || op.player !== T.player) return;
    const near = T.friendlies(ev.state, KW).some(
      (o) =>
        o.id !== op.id &&
        !T.kw(o, 'GUN SERVITOR') &&
        T.gap(o, op) <= 3 + EPS &&
        (visible(T, ev.state, op, o) || visible(T, ev.state, o, op)), // "…or vice versa"
    );
    if (!near) return;
    timedApl(ev.state, op, 1, {
      sourceId: AB.lobotomised,
      sourceText: shortQuote(abilityText(CARD.gunServitor, AB.lobotomised)),
      until: 'activation',
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Lobotomised: ${op.letter} +1 APL` });
  });

  // =========================================================================
  // SISTER OF SILENCE › Psychic Null (identical on all three datacards)
  // =========================================================================
  const nullBearer = (state: GameState, op: OperativeState): boolean =>
    op.player === T.player && PSYCHIC_NULL_CARDS.includes(op.datacardId);
  /** "Whenever an operative is within 6" of this operative." */
  const nulled = (state: GameState, op: OperativeState): boolean =>
    T.friendlies(state).some((o) => nullBearer(state, o) && o.id !== op.id && T.gap(o, op) <= 6 + EPS);

  // "PSYCHIC ranged weapons cannot inflict damage on this operative."
  reg.on('onDamage', T.bind(AB.psychicNullProsecutor, 12), (ev) => {
    if (!nullBearer(ev.state, ev.target)) return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.profile.type !== 'ranged' || !hasPsychicProfile(cur.profile)) return;
    ev.amount = 0;
  });
  // "That operative cannot perform PSYCHIC actions or use PSYCHIC additional rules."
  reg.on('canPerformAction', T.bind(AB.psychicNullProsecutor, 13), (ev) => {
    if (!nulled(ev.state, ev.operative)) return;
    const printed = T.card(ev.operative)?.uniqueActions.find((a) => a.id === ev.action);
    if (!printed || !isPsychicAction(printed.text)) return;
    ev.allowed = false;
    ev.reason = 'within 6" of a SISTER OF SILENCE operative: it cannot perform PSYCHIC actions';
  });
  // "That operative cannot use PSYCHIC ranged weapons."
  reg.on('availableWeapons', T.bind(AB.psychicNullProsecutor, 14), (ev) => {
    if (!nulled(ev.state, ev.operative)) return;
    const psychic = (T.card(ev.operative)?.weapons ?? []).filter((w) =>
      w.profiles.some((p) => p.type === 'ranged' && hasPsychicProfile(p)),
    );
    if (psychic.length === 0) return;
    ev.weapons = ev.weapons.filter((n) => !psychic.some((w) => w.name === n));
  });
  // "PSYCHIC melee weapons have no weapon rules and cannot have Dmg stats higher than 3/4."
  reg.on('onWeaponRules', T.bind(AB.psychicNullProsecutor, 15), (ev) => {
    if (ev.type !== 'melee' || !hasPsychicProfile(ev.profile)) return;
    if (!nulled(ev.state, ev.operative)) return;
    ev.rules = [];
  });
  reg.on('onDamage', T.bind(AB.psychicNullProsecutor, 16), (ev) => {
    if (ev.kind !== 'attack') return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.profile.type !== 'melee' || !hasPsychicProfile(cur.profile)) return;
    if (!nulled(ev.state, cur.op)) return;
    const cap = ev.amount >= cur.profile.dmgC ? 4 : 3;
    ev.amount = Math.min(ev.amount, cap);
  });

  // =========================================================================
  // TEMPESTUS SCION MEDIC › Medic!
  // =========================================================================
  // "…that friendly operative isn't incapacitated, has 1 wound remaining and cannot be
  //  incapacitated for the remainder of the action."
  reg.on('onIncapacitated', T.bind(AB.medic, 11), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, MEDIC_SHIELD);
    if (!eff || eff.data?.['seq'] !== sequenceKey(ev.state)) return;
    ev.prevented = true;
  });
  reg.on('onIncapacitated', T.bind(AB.medic, 12), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW) || !T.ctx) return;
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CARD.scionMedic &&
        o.id !== victim.id &&
        !o.incapacitated &&
        !o.removed &&
        T.gap(o, victim) <= 3 + EPS &&
        visible(T, ev.state, o, victim) &&
        enemiesInControlRange(T.ctx!, ev.state, o).length === 0,
    );
    if (!medic) return;
    // "providing neither this nor that operative is within control range of an enemy operative"
    if (enemiesInControlRange(T.ctx, ev.state, victim).length > 0) return;
    // "You cannot use this rule … if it's a Shoot action and this operative would be a primary
    //  or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id) || seq.resolvedTargets.includes(medic.id)))
      return;
    if (!useOncePerTP(ev.state, `inquisitorial-agent.medic:${T.player}`)) return;
    ev.prevented = true;
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: AB.medic },
      sourceText: shortQuote(abilityText(CARD.scionMedic, AB.medic)),
      operativeId: victim.id,
      player: T.player,
      data: { seq: sequenceKey(ev.state) },
      expiry: { kind: 'endOfTurningPoint' },
    });
    effect(ev.state, {
      rule: MEDIC_USED_ON,
      source: { kind: 'ability', id: AB.medic },
      sourceText: shortQuote(abilityText(CARD.scionMedic, AB.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next
    //  activations respectively." Applied FIRST, so the free Dash below is the last AP the
    //  operative has rather than its only one.
    const src = { sourceId: AB.medic, sourceText: shortQuote(abilityText(CARD.scionMedic, AB.medic)), until: 'nextActivation' as const };
    timedApl(ev.state, victim, -1, src);
    timedApl(ev.state, medic, -1, src);
    // "After that action, that friendly operative can immediately perform a free Dash action."
    grantFreeAction(ev.state, victim, {
      sourceId: AB.medic,
      sourceText: shortQuote(abilityText(CARD.scionMedic, AB.medic)),
      threshold: Math.max(victim.apSpent, currentApl(T, ev.state, victim)),
      kind: 'ability',
      only: ['Dash'],
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Medic!: ${medic.letter} saves ${victim.letter}` });
  });

  // =========================================================================
  // Bookkeeping: timed APL, and free-action grants nobody spent
  // =========================================================================
  // The APL stat changes are the module's own to undo — `aplMods` has no owner in the core, so
  // an "until the end of its next activation" +1 or -1 that is not popped here would stand for
  // the rest of the battle. A free action needs no such pop: it is AP, not a stat change, and
  // `expireActivationEffects` drops it as soon as the recipient's activation ends.
  const bookkeeping = actionTextOf(CARD.scionVox, ACT.signal);
  reg.on('onActivationEnd', T.bindText('inquisitorial-agent.aplBookkeeping', bookkeeping, 90), (ev) => {
    if (ev.operative.player !== T.player) return;
    popTimedApl(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('inquisitorial-agent.aplBookkeeping', bookkeeping, 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) dropStaleGrant(ev.state, o);
  });
}

const PSYCHIC_NULL_CARDS: readonly string[] = [CARD.prosecutor, CARD.vigilator, CARD.witchseeker];

/** A stable key for the in-flight sequence, so a "remainder of the action" shield is bounded. */
function sequenceKey(state: GameState): string {
  const seq = state.sequence;
  if (!seq) return `none:${state.activeOperativeId ?? ''}`;
  return seq.kind === 'shoot' ? `shoot:${seq.attackerId}:${seq.targetId}` : `fight:${seq.attackerId}:${seq.defenderId}`;
}

function currentProfileOf(T: TeamHooks, state: GameState, op: OperativeState): WeaponProfile | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  const name = seq.attackerId === op.id ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const weapon = T.card(op)?.weapons.find((w) => w.name === name);
  const profileName = seq.attackerId === op.id ? seq.attackerProfile : seq.defenderProfile;
  return weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
}

/**
 * A free action is one AP outside the APL budget, and it expires with the activation it was
 * given for (docs/DECISIONS.md D-100) — the core does that itself. Neither of this team's
 * grants is aimed at the operative that is activating, though: RELENTLESS IN PURSUIT names a
 * friendly chasing an enemy and Medic! saves whichever operative was about to be
 * incapacitated, and an operative that is already expended never ends another activation this
 * turning point. Nothing would take that AP back, so it would still be waiting when the
 * operative activates in the NEXT turning point, long after "immediately". The Ready step is
 * where that window closes. The source check keeps the sweep to grants this team made.
 */
function dropStaleGrant(state: GameState, op: OperativeState): void {
  const eff = effectOn(state, op.id, FREE_ACTION_RULE);
  if (!eff || !FREE_ACTION_SOURCES.has(eff.source.id)) return;
  dropEffects(state, (e) => e === eff);
}

// ---------------------------------------------------------------------------
// The team's own decisions
// ---------------------------------------------------------------------------

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== TOMES_DECISION) return false;
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const combo = payload['combo'];
  const player = String(payload['player'] ?? decision.ctx?.['player'] ?? decision.who) as PlayerId;
  if (typeof combo !== 'string') return true; // "keep": nothing changes
  const [mine, skull] = combo.split('|');
  const own = aliveOperatives(state, player);
  const interrogator = own.find((o) => o.datacardId === CARD.interrogator);
  const tomeSkull = own.find((o) => o.datacardId === CARD.tomeSkull);
  if (interrogator && mine && TOME_SET.has(mine)) setTome(state, interrogator, mine as Tome);
  if (tomeSkull && skull && TOME_SET.has(skull)) setTome(state, tomeSkull, skull as Tome);
  void ctx;
  return true;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // DENOUNCE (strategy)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(SP.denounce, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.denounce || !T.ctx) return;
    // "This ploy costs you 1 additional CP for each previous time you've used it during the
    //  battle." The reducer has already charged the printed 1CP, so only the surcharge is left.
    const cost = denounceCost(ev.state, T.player);
    ev.state.teams[T.player].cp -= cost - 1;
    bumpDenounceUses(ev.state, T.player);
    const chosen = ev.data?.['operativeId'] as string | undefined;
    const foe = (chosen ? ev.state.operatives[chosen] : undefined) ?? nearestEnemy(T, ev.state);
    if (!foe) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'denounce', [d3], T.player, `Denounce ${foe.letter}`);
    effect(ev.state, {
      rule: DENOUNCE_EFFECT,
      source: { kind: 'ploy', id: SP.denounce },
      sourceText: shortQuote(text(SP.denounce)),
      operativeId: foe.id,
      player: T.player,
      data: { count: d3, activations: 0, tp: ev.state.turningPoint },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Denounce (${cost}CP): ${foe.letter} is silenced for ${d3} enemy activations`,
    });
  });
  reg.on('canPerformAction', T.bind(SP.denounce, 21), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!denounced(ev.state, ev.operative)) return;
    ev.allowed = false;
    ev.reason = 'Denounce: that operative cannot perform actions yet';
  });
  reg.on('onActivationEnd', T.bind(SP.denounce, 21), (ev) => {
    if (ev.operative.player === T.player) return;
    for (const foe of T.enemies(ev.state)) {
      if (foe.id === ev.operative.id) continue;
      const eff = effectOn(ev.state, foe.id, DENOUNCE_EFFECT);
      if (!eff) continue;
      eff.data = { ...eff.data, activations: Number(eff.data?.['activations'] ?? 0) + 1 };
    }
  });

  // =========================================================================
  // INTENSE SCRUTINY (strategy)
  // =========================================================================
  // "…enemy operatives within 4" of it cannot be in cover (instead of 2")."
  reg.on('onValidTarget', T.bind(SP.intenseScrutiny, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.intenseScrutiny)) return;
    if (!T.mineKw(ev.attacker, KW) || ev.target.player === T.player || !T.ctx) return;
    if (gapBetween(T.ctx, ev.attacker, ev.target) > 4 + EPS) return;
    ev.ignoreCoverTerrain = 'all';
  });
  // "…it doesn't remove their cover save (if any), unless the friendly … operative is within 2"
  //  as normal." The cover save is handed back here, because the widening above cleared it.
  reg.on('onDefenceDice', T.bind(SP.intenseScrutiny, 21), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.intenseScrutiny)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.defence.dice.length > 0) return; // the rolling emit, not the re-roll emit
    const defender = ev.ctx.defender;
    if (!defender || defender.player === T.player || !T.mineKw(ev.ctx.attacker, KW) || !T.ctx) return;
    if (ev.coverSave) return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
    const gap = gapBetween(T.ctx, ev.ctx.attacker, defender);
    if (gap <= 2 + EPS || gap > 4 + EPS) return;
    const index = terrain(T.ctx, ev.state);
    const cover = coverAndObscured(index, body(T.ctx, ev.ctx.attacker), body(T.ctx, defender));
    if (!cover.inCover) return;
    ev.coverSave = true;
  });

  // =========================================================================
  // QUARRY (strategy)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(SP.quarry, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.quarry) return;
    const chosen = ev.data?.['operativeId'] as string | undefined;
    const foe = (chosen ? ev.state.operatives[chosen] : undefined) ?? nearestEnemy(T, ev.state);
    if (foe) setQuarry(T, ev.state, foe, 'Quarry');
  });
  reg.on('onWeaponRules', T.bind(SP.quarry, 21), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (quarryOf(ev.state, T.player) !== ev.target.id) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Quarry)'));
  });
  // "Whenever your quarry is incapacitated, you can select a new enemy operative to be your
  //  quarry (and can continue to do so during this turning point)."
  reg.on('onIncapacitated', T.bind(SP.quarry, 22), (ev) => {
    if (ev.prevented || ev.operative.player === T.player) return;
    if (quarryOf(ev.state, T.player) !== ev.operative.id) return;
    const next = nearestEnemy(T, ev.state, ev.operative.id);
    if (next) setQuarry(T, ev.state, next, 'Quarry (new)');
  });

  // =========================================================================
  // IRREFUTABLE JURISDICTION (strategy)
  // =========================================================================
  // "Whenever an operative is shooting a friendly … operative that's within 3" of an objective
  //  marker, you can re-roll one of your defence dice. If that friendly operative contests that
  //  marker, you can re-roll any of your defence dice results of one result instead."
  reg.on('onDefenceDice', T.bind(SP.irrefutableJurisdiction, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.irrefutableJurisdiction)) return;
    const defender = ev.ctx.defender;
    if (!defender || !T.mineKw(defender, KW) || !T.ctx) return;
    const objectives = Object.values(ev.state.markers).filter((m) => m.kind === 'objective');
    const near = objectives.find((m) => T.markerGap(defender, m) <= 3 + EPS);
    if (!near) return;
    const contests = markerContestedBy(T.ctx, ev.state, near, defender);
    ev.rerolls.push({
      id: 'inquisitorial-agent.irrefutableJurisdiction',
      label: contests
        ? 'Irrefutable Jurisdiction: re-roll any of your defence dice results of one result'
        : 'Irrefutable Jurisdiction: re-roll one of your defence dice',
      mode: contests ? 'value' : 'one',
      ...(contests ? {} : { max: 1 }),
      player: T.player,
      sourceText: shortQuote(text(SP.irrefutableJurisdiction)),
    });
  });

  // =========================================================================
  // ABSOLUTE AUTHORITY (firefight)
  // =========================================================================
  // Every opponent ploy that could be stopped is recorded as it is used, so `usable` knows
  // whether the response window is open.
  reg.on('onPloyUsed', T.bindText(FP.absoluteAuthority, text(FP.absoluteAuthority), 1), (ev) => {
    if (ev.player === T.player) return;
    const cp = ployCp(T, ev.state, ev.player, ev.ployId);
    if (cp <= 0) return; // "(excluding Command Re-roll or one that costs 0CP)"
    const b = bucket(ev.state, `inquisitorial-agent.lastPloy:${T.player}`);
    b['ployId'] = ev.ployId;
    b['cp'] = cp;
    b['tp'] = ev.state.turningPoint;
  });
  reg.on('onPloyUsed', T.bind(FP.absoluteAuthority, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.absoluteAuthority) return;
    const b = bucket(ev.state, `inquisitorial-agent.lastPloy:${T.player}`);
    const stopped = String(b['ployId'] ?? '');
    if (!stopped) return;
    const cp = Number(b['cp'] ?? 0);
    const foe = otherPlayer(T.player);
    // "the CP spent on it is refunded" — and it stays in `ploysUsedTP`, which is exactly the
    // ledger the reducer consults for "they cannot use that ploy again during this turning point".
    ev.state.teams[foe].cp += cp;
    useOncePerBattle(ev.state, `inquisitorial-agent.absoluteAuthority:${stopped}`);
    delete b['ployId'];
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Absolute Authority: ${stopped} is stopped, ${cp}CP refunded and it cannot be used again this turning point`,
    });
  });

  // =========================================================================
  // RELENTLESS IN PURSUIT (firefight)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.relentlessInPursuit, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.relentlessInPursuit) return;
    const pairs = pursuitPairs(T, ev.state);
    const chosen = ev.data?.['operativeId'] as string | undefined;
    const pair = pairs.find((p) => p.mine.id === chosen) ?? pairs[0];
    if (!pair) {
      // "If neither is possible, that friendly operative cannot perform those actions, this
      //  ploy isn't used and the CP spent on it is refunded."
      ev.state.teams[T.player].cp += 1;
      ev.state.teams[T.player].ploysUsedTP = ev.state.teams[T.player].ploysUsedTP.filter(
        (p) => p !== FP.relentlessInPursuit,
      );
      log(ev.state, { kind: 'ploy', player: T.player, text: 'Relentless in Pursuit: no eligible operative — 1CP refunded' });
      return;
    }
    grantFreeAction(ev.state, pair.mine, {
      sourceId: FP.relentlessInPursuit,
      sourceText: shortQuote(text(FP.relentlessInPursuit)),
      threshold: Math.max(0, pair.mine.apSpent),
      only: ['Reposition', 'Charge'],
    });
  });

  // =========================================================================
  // THE EMPEROR'S WILL (firefight)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.emperorsWill, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.emperorsWill) return;
    const activeId = ev.state.activeOperativeId;
    const op = activeId ? ev.state.operatives[activeId] : undefined;
    if (!op || !T.mineKw(op, KW)) return;
    effect(ev.state, {
      rule: EMPERORS_WILL_EFFECT,
      source: { kind: 'ploy', id: FP.emperorsWill },
      sourceText: shortQuote(text(FP.emperorsWill)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onStatMod', T.bind(FP.emperorsWill, 70), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, EMPERORS_WILL_EFFECT)) return;
    const apl = ev.operative.aplMods.reduce((a, b) => a + b, 0) + ev.mods.apl;
    ev.mods = { hit: 0, save: 0, move: 0, atk: 0, apl: -apl };
    // Injured ("subtract 2" from Move, worsen Hit by 1") is a change to its stats too, and both
    // are applied outside `StatMods`, so they are cancelled here as well.
    if (T.ctx && isInjured(T.ctx, ev.operative)) {
      ev.mods.hit += 1;
      ev.mods.move += 2;
    }
  });
  // "…(including its weapons' stats)": the Atk stat is collected here, so it goes back to the
  // printed value after every other rule has had its say.
  reg.on('onCollectAttackDice', T.bind(FP.emperorsWill, 70), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!effectOn(ev.state, ev.ctx.attacker.id, EMPERORS_WILL_EFFECT)) return;
    ev.count = ev.ctx.profile.atk;
    ev.mods.atk = 0;
    ev.mods.hit = 0;
  });

  // =========================================================================
  // INTIMIDATING PRESENCE (firefight)
  // =========================================================================
  reg.on('onActionCost', T.bind(FP.intimidatingPresence, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.intimidatingPresence)) return;
    if (ev.operative.player === T.player) return;
    if (ev.action === 'Operate Hatch') return; // "(excluding Operate Hatch)"
    if (ev.action !== 'Pick Up Marker' && !isMissionAction(ev.action)) return;
    if (!intimidated(T, ev.state, ev.operative)) return;
    ev.ap += 1;
  });
}

/** "…visible to and within 3" of a friendly … operative, or … 6" of a friendly MYSTIC operative." */
function intimidated(T: TeamHooks, state: GameState, foe: OperativeState): boolean {
  return T.friendlies(state, KW).some((o) => {
    const range = o.datacardId === CARD.mystic ? 6 : 3;
    return T.gap(o, foe) <= range + EPS && visible(T, state, o, foe);
  });
}

/** RELENTLESS IN PURSUIT: ready friendly IA operatives with an enemy within 2". */
function pursuitPairs(T: TeamHooks, state: GameState): { mine: OperativeState; foe: OperativeState }[] {
  const out: { mine: OperativeState; foe: OperativeState }[] = [];
  for (const mine of T.friendlies(state, KW)) {
    if (!mine.ready) continue;
    for (const foe of T.enemies(state)) {
      if (T.gap(mine, foe) <= 2 + EPS) out.push({ mine, foe });
    }
  }
  return out.sort((a, b) => (a.mine.id < b.mine.id ? -1 : 1));
}

/**
 * The printed CP cost of the ploy the opponent just used, for ABSOLUTE AUTHORITY's refund.
 * Ids that belong to no `PloyDef` are team-raised STRATEGIC GAMBITs, which are free — and
 * "one that costs 0CP" is exactly what the ploy cannot stop.
 */
function ployCp(T: TeamHooks, state: GameState, player: PlayerId, ployId: string): number {
  if (ployId.startsWith('commandReroll')) return 0;
  const module = T.ctx?.teams.get(state.teams[player].teamId);
  const printed =
    module?.ploys.find((p) => p.id === ployId) ??
    [...DATA.strategyPloys, ...DATA.firefightPloys].find((p) => p.id === ployId);
  return printed?.cp ?? 0;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

const COMBAT_DAGGER = printedWeapon(EQ.daggers, 'Combat dagger');

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // INQUISITORIAL ROSETTE
  // =========================================================================
  // "Once per battle, when a friendly … operative is activated, if you've used the Quarry
  //  strategy ploy during this turning point, you can use this rule."
  // D-022 policy: it is spent only when the current quarry has drifted out of reach — no friendly
  // operative is within 8" of it while another enemy operative is.
  reg.on('onActivationStart', T.bind(EQ.rosette, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.rosette)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!gambitUsed(ev.state, T.player, SP.quarry)) return;
    if (usedThisBattle(ev.state, `inquisitorial-agent.rosette:${T.player}`)) return;
    const currentId = quarryOf(ev.state, T.player);
    const current = currentId ? ev.state.operatives[currentId] : undefined;
    const mine = T.friendlies(ev.state, KW);
    const reach = (foe: OperativeState): number => Math.min(...mine.map((f) => T.gap(f, foe)), Infinity);
    if (current && !current.removed && reach(current) <= 8 + EPS) return;
    const next = nearestEnemy(T, ev.state, currentId);
    if (!next || reach(next) > 8 + EPS) return;
    useOncePerBattle(ev.state, `inquisitorial-agent.rosette:${T.player}`);
    setQuarry(T, ev.state, next, 'Inquisitorial Rosette');
  });

  // =========================================================================
  // COMBAT DAGGERS
  // =========================================================================
  // "Friendly INQUISITORIAL AGENT operatives have the following melee weapon." Lightly Armed
  // operatives ("cannot use any weapons that aren't on its datacard") are skipped.
  const giveDaggers = (state: GameState): void => {
    if (!hasEquipment(state, T.player, EQ.daggers)) return;
    for (const o of T.friendlies(state, KW)) {
      if (o.datacardId === CARD.autosavant || o.datacardId === CARD.mystic) continue;
      grantWeapon(o, structuredClone(COMBAT_DAGGER));
    }
  };
  reg.on('onDeploy', T.bind(EQ.daggers, 30), (ev) => {
    if (ev.operative.player === T.player) giveDaggers(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.daggers, 31), (ev) => {
    if (ev.operative.player === T.player) giveDaggers(ev.state);
  });
  // "Whenever a friendly SISTER OF SILENCE operative is using it, add 1 to its Atk stat."
  reg.on('onCollectAttackDice', T.bind(EQ.daggers, 32), (ev) => {
    if (ev.ctx.weaponName !== COMBAT_DAGGER.name) return;
    if (!T.mineKw(ev.ctx.attacker, KW) || !T.kw(ev.ctx.attacker, 'SISTER OF SILENCE')) return;
    ev.count += 1;
  });

  // =========================================================================
  // ARMOURED BODYSUITS
  // =========================================================================
  // "Whenever an operative is shooting a friendly … operative (excluding TOME-SKULL) that has a
  //  5+ Save stat, you can retain one of your defence dice results of 4 as a normal success."
  // The defence pool has already been rolled by the time the second `onDefenceDice` emit runs
  // (the re-roll window), which is the only moment a specific result can be promoted.
  reg.on('onDefenceDice', T.bind(EQ.bodysuits, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.bodysuits)) return;
    const defender = ev.ctx.defender;
    if (!defender || !T.mineKw(defender, KW) || defender.datacardId === CARD.tomeSkull) return;
    if ((T.card(defender)?.save ?? 0) !== 5) return; // "that has a 5+ Save stat"
    const seq = shootSeq(ev.state);
    if (!seq || seq.defence.dice.length === 0) return;
    if (!useOncePerSequence(ev.state, `inquisitorial-agent.bodysuits:${defender.id}`)) return;
    const die = seq.defence.dice.find((d) => d.rolled && d.value === 4 && d.state === 'fail');
    if (!die) return;
    die.state = 'normal';
    die.note = 'Armoured Bodysuits';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Armoured Bodysuits: ${defender.letter} retains a 4 as a normal success`,
    });
  });

  // =========================================================================
  // SERVO-SKULL
  // =========================================================================
  // "Once per battle, one friendly INQUISITORIAL AGENT operative can perform a mission action
  //  for 1 less AP." `onActionCost` is a pure query, so the allowance is consumed at the end of
  //  the activation in which a mission action was actually performed (the Deathwatch idiom).
  reg.on('onActionCost', T.bind(EQ.servoSkull, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.servoSkull)) return;
    if (!T.mineKw(ev.operative, KW) || !isMissionAction(ev.action)) return;
    if (usedThisBattle(ev.state, `inquisitorial-agent.servoSkull:${T.player}`)) return;
    if (ev.operative.actionsThisActivation.some((a) => isMissionAction(a))) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });
  reg.on('onActivationEnd', T.bind(EQ.servoSkull, 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.servoSkull)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ev.operative.actionsThisActivation.some((a) => isMissionAction(a))) return;
    useOncePerBattle(ev.state, `inquisitorial-agent.servoSkull:${T.player}`);
  });
}

// ---------------------------------------------------------------------------
// Extra ActionDefs the printed rules force (D-021)
// ---------------------------------------------------------------------------

/**
 * Hunter: "This operative can perform the Charge action while it has a Conceal order."
 * The universal Charge refuses a Conceal order outright and `canPerformAction` can only forbid,
 * so the carve-out is its own action resolving through the universal one.
 */
registerAction({
  id: HUNTER_CHARGE,
  name: 'Charge (Hunter)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(CARD.deathWorldVeteran, AB.hunter),
  available: (_ctx, _state, op) => op.datacardId === CARD.deathWorldVeteran,
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

/**
 * PISTOL BARRAGE: "Perform two free Shoot actions with this operative (this takes precedence
 * over action restrictions). You must select a profile of its scoped plasma pistol for one
 * action and its suppressed autopistol for the other (in any order)."
 *
 * `state.sequence` is single-slot, so two shoot sequences cannot be started from one `perform`.
 * The barrage is therefore two sibling actions — the printed 1AP one fires the scoped plasma
 * pistol and the 0AP follow-up the suppressed autopistol (the printed "in any order" is fixed to
 * that order deterministically). Neither is `treatedAs: 'Shoot'`, which is what gives the rule
 * its precedence over action restrictions.
 */
const BARRAGE_WEAPON: Record<string, string> = {
  [ACT.pistolBarrage]: 'Scoped plasma pistol',
  [PISTOL_BARRAGE_2]: 'Suppressed autopistol',
};

function barrageParams(actionId: string, params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, weaponName: BARRAGE_WEAPON[actionId], profileName: params['profileName'] };
}

function barrageCheck(
  actionId: string,
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  if (op.order === 'conceal') return { ok: false, reason: 'this operative cannot perform this action while it has a Conceal order' };
  if (op.actionsThisActivation.includes('Shoot'))
    return { ok: false, reason: 'it already performed the Shoot action during this activation' };
  if (actionId === PISTOL_BARRAGE_2 && !op.actionsThisActivation.includes(ACT.pistolBarrage))
    return { ok: false, reason: 'the second barrage shot follows the first' };
  if (actionId === ACT.pistolBarrage && op.actionsThisActivation.includes(PISTOL_BARRAGE_2))
    return { ok: false, reason: 'the barrage is already finished' };
  const target = state.operatives[String(params['targetId'] ?? '')];
  if (!target || target.removed || target.player === op.player) return { ok: false, reason: 'select an enemy operative' };
  return getAction('Shoot')!.check(ctx, state, op, barrageParams(actionId, params));
}

for (const actionId of [ACT.pistolBarrage, PISTOL_BARRAGE_2]) {
  registerAction({
    id: actionId,
    name: actionId === ACT.pistolBarrage ? 'PISTOL BARRAGE' : 'PISTOL BARRAGE (2)',
    ap: actionId === ACT.pistolBarrage ? 1 : 0,
    type: 'unique',
    sourceText: `PISTOL BARRAGE 1AP: ${actionTextOf(CARD.pistolier, ACT.pistolBarrage).replace(/\s+/g, ' ').trim()}`,
    available: (_ctx, _state, op) => op.datacardId === CARD.pistolier,
    check: (ctx, state, op, params) => barrageCheck(actionId, ctx, state, op, params as Record<string, unknown>),
    perform: (ctx, state, op, params) =>
      getAction('Shoot')!.perform(ctx, state, op, barrageParams(actionId, params as Record<string, unknown>)),
  });
}

/**
 * Adaptive Equipment: "One friendly … TROOPER operative can perform the Smoke Grenade action …
 * the Stun Grenade action. The rules for these actions are found in universal equipment.
 * Performing these actions using this rule doesn't count towards their action limits."
 * The universal action spends a kill-team grenade allowance, which is lent and then restored.
 */
function adaptiveGrenade(id: string, name: string, delegate: 'Smoke Grenade' | 'Stun Grenade', choice: 'smoke' | 'stun'): void {
  registerAction({
    id,
    name,
    ap: 1,
    type: 'unique',
    sourceText: abilityText(CARD.scionTrooper, AB.adaptiveEquipment),
    available: (_ctx, _state, op) => op.datacardId === CARD.scionTrooper,
    check(ctx, state, op, params) {
      if (enemiesInControlRange(ctx, state, op).length > 0)
        return { ok: false, reason: 'within control range of an enemy operative' };
      if (usedThisTP(state, `inquisitorial-agent.adaptive:${op.player}:${id}`))
        return { ok: false, reason: 'you can do each of these once per turning point' };
      // The universal action's own conditions, minus the equipment allowance this rule lends.
      if (delegate === 'Smoke Grenade') {
        const pos = params.targetPos ?? params.markerPos;
        if (!pos) return { ok: false, reason: 'select where to place the Smoke Grenade marker' };
        if (Math.hypot(op.pos.x - pos.x, op.pos.y - pos.y) > 6 + EPS)
          return { ok: false, reason: 'the marker must be within 6" of this operative' };
        return { ok: true };
      }
      const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
      if (!target || target.removed || target.player === op.player) return { ok: false, reason: 'select an enemy operative' };
      if (gapBetween(ctx, op, target) > 6 + EPS) return { ok: false, reason: 'that operative is more than 6" away' };
      if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
        return { ok: false, reason: 'that operative is not visible' };
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      const uses = { ...state.teams[op.player].equipmentUses };
      state.teams[op.player].equipmentUses[`${UTILITY_ID}:${choice}`] =
        Number(uses[`used:${UTILITY_ID}:${choice}`] ?? 0) + 1;
      let res: { ok: boolean; reason?: string };
      try {
        res = getAction(delegate)!.perform(ctx, state, op, params);
      } finally {
        state.teams[op.player].equipmentUses = { ...uses };
      }
      if (res.ok) {
        const b = bucket(state, 'teamOnce');
        b[`inquisitorial-agent.adaptive:${op.player}:${id}`] = `${state.turningPoint}`;
      }
      return res;
    },
  });
}

adaptiveGrenade(SMOKE_ADAPTIVE, 'Smoke Grenade (Adaptive Equipment)', 'Smoke Grenade', 'smoke');
adaptiveGrenade(STUN_ADAPTIVE, 'Stun Grenade (Adaptive Equipment)', 'Stun Grenade', 'stun');

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** "…that's a valid target for this operative and within 6" of it" (CHASTEN). */
function chastenTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  return aliveOperatives(state, otherPlayer(op.player))
    .filter((foe) => {
      if (gapBetween(ctx, op, foe) > 6 + EPS) return false;
      if (!isVisible(index, body(ctx, op), body(ctx, foe)).visible) return false;
      if (foe.order !== 'conceal') return true;
      return !coverAndObscured(index, body(ctx, op), body(ctx, foe)).inCover;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * "…select one additional rule (including a unique action) that enemy operative has on its
 * datacard (excluding a weapon rule or a rule that states it is ignored for the kill/elimination
 * op)." Unique actions are offered first, because those are the ones the engine can switch off.
 */
export function chastenableRules(ctx: GameContext, foe: OperativeState): { id: string; name: string }[] {
  const card = ctx.datacards.get(foe.datacardId);
  if (!card) return [];
  const abilities = card.abilities
    .filter((a) => !/kill\s*\/\s*elimination op|kill or elimination op/i.test(a.text))
    .map((a) => ({ id: a.id, name: a.name }));
  return [...card.uniqueActions.map((a) => ({ id: a.id, name: a.name })), ...abilities];
}

export function chastenedRule(state: GameState, op: OperativeState): string | undefined {
  const v = effectOn(state, op.id, CHASTEN_EFFECT)?.data?.['ruleId'];
  return typeof v === 'string' ? v : undefined;
}

/** SCRY / MEDIKIT / SIGNAL: friendly INQUISITORIAL AGENT operatives in reach. */
function friendlyAgentsWithin(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  inches: number,
  opts: { excludeSelf?: boolean; psychic?: boolean } = {},
): OperativeState[] {
  return aliveOperatives(state, op.player)
    .filter((o) => !(opts.excludeSelf && o.id === op.id))
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    // Psychic Null: "For the effects of PSYCHIC actions, this operative cannot be selected and is
    // never treated as being within those actions' required distances."
    .filter((o) => !(opts.psychic && PSYCHIC_NULL_CARDS.includes(o.datacardId)))
    .filter((o) => gapBetween(ctx, op, o) <= inches + EPS)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function actions(data: typeof DATA): ActionDef[] {
  const out: ActionDef[] = [];

  // ---- CHASTEN 1AP — HEXORCIST -------------------------------------------
  out.push(
    uniqueAction(data, CARD.hexorcist, ACT.chasten, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const targets = chastenTargets(ctx, state, op);
        const foe = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        if (!foe) return { ok: false, reason: 'select one enemy operative that is a valid target and within 6"' };
        if (chastenableRules(ctx, foe).length === 0)
          return { ok: false, reason: 'that operative has no additional rule on its datacard' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const targets = chastenTargets(ctx, state, op);
        const foe = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        if (!foe) return { ok: false, reason: 'select one enemy operative that is a valid target and within 6"' };
        const options = chastenableRules(ctx, foe);
        const pick = options.find((r) => r.id === params.choice) ?? options[0]!;
        dropEffects(state, (e) => e.rule === CHASTEN_EFFECT && e.operativeId === foe.id);
        effect(state, {
          rule: CHASTEN_EFFECT,
          source: { kind: 'ability', id: ACT.chasten },
          sourceText: shortQuote(actionTextOf(CARD.hexorcist, ACT.chasten)),
          operativeId: foe.id,
          player: op.player,
          data: { ruleId: pick.id, ruleName: pick.name },
          expiry: { kind: 'endOfNextActivation', operativeId: foe.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: CHASTEN — ${foe.letter} loses ${pick.name}` });
        return { ok: true };
      },
    }),
  );

  // ---- SCRY 1AP (PSYCHIC) — MYSTIC ---------------------------------------
  out.push(
    uniqueAction(data, CARD.mystic, ACT.scry, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const eligible = friendlyAgentsWithin(ctx, state, op, 6, { psychic: true });
        const target = eligible.find((o) => o.id === params.targetOperativeId) ?? eligible[0];
        return target
          ? { ok: true }
          : { ok: false, reason: 'select one friendly INQUISITORIAL AGENT operative within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const eligible = friendlyAgentsWithin(ctx, state, op, 6, { psychic: true });
        const target = eligible.find((o) => o.id === params.targetOperativeId) ?? eligible[0];
        if (!target) return { ok: false, reason: 'select one friendly INQUISITORIAL AGENT operative within 6"' };
        // "…or until it performs this action again (whichever comes first)."
        dropEffects(state, (e) => e.rule === SCRY_EFFECT && e.player === op.player && e.data?.['mysticId'] === op.id);
        effect(state, {
          rule: SCRY_EFFECT,
          source: { kind: 'ability', id: ACT.scry },
          sourceText: shortQuote(actionTextOf(CARD.mystic, ACT.scry)),
          operativeId: target.id,
          player: op.player,
          data: { mysticId: op.id },
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SCRY — ${target.letter}` });
        return { ok: true };
      },
    }),
  );

  // ---- MEDIKIT 1AP — TEMPESTUS SCION MEDIC --------------------------------
  const medikitTarget = (
    ctx: GameContext,
    state: GameState,
    op: OperativeState,
    chosen: string | undefined,
  ): OperativeState | undefined => {
    const eligible = friendlyAgentsWithin(ctx, state, op, 1)
      // "It cannot be an operative that the Medic! rule was used on during this turning point."
      .filter((o) => !effectOn(state, o.id, MEDIC_USED_ON))
      .filter((o) => o.wounds < (ctx.datacards.get(o.datacardId)?.wounds ?? o.wounds));
    return eligible.find((o) => o.id === chosen) ?? eligible[0];
  };
  out.push(
    uniqueAction(data, CARD.scionMedic, ACT.medikit, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return medikitTarget(ctx, state, op, params.targetOperativeId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly INQUISITORIAL AGENT operative within control range with lost wounds' };
      },
      perform: (ctx, state, op, params) => {
        const target = medikitTarget(ctx, state, op, params.targetOperativeId);
        if (!target)
          return { ok: false, reason: 'select one friendly INQUISITORIAL AGENT operative within control range with lost wounds' };
        const heal = ctx.rng.d3() + ctx.rng.d3();
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: MEDIKIT — ${target.letter} regains ${heal}` });
        return { ok: true };
      },
    }),
  );

  // ---- SIGNAL 1AP (SUPPORT) — TEMPESTUS SCION VOX-OPERATOR ----------------
  // "This operative can perform this action twice during its activation": action restrictions
  // forbid a repeat, so the second use is its own sibling action.
  const signalTarget = (
    ctx: GameContext,
    state: GameState,
    op: OperativeState,
    chosen: string | undefined,
  ): OperativeState | undefined => {
    // "Select one other friendly INQUISITORIAL AGENT operative in the killzone" — no distance.
    const eligible = friendlyAgentsWithin(ctx, state, op, Number.MAX_SAFE_INTEGER, { excludeSelf: true });
    return eligible.find((o) => o.id === chosen) ?? eligible[0];
  };
  const signalImpl = {
    check: (ctx: GameContext, state: GameState, op: OperativeState, params: { targetOperativeId?: string }) => {
      const eng = notEngaged(ctx, state, op);
      if (!eng.ok) return eng;
      return signalTarget(ctx, state, op, params.targetOperativeId)
        ? { ok: true }
        : { ok: false, reason: 'select one other friendly INQUISITORIAL AGENT operative in the killzone' };
    },
    perform: (ctx: GameContext, state: GameState, op: OperativeState, params: { targetOperativeId?: string }) => {
      const target = signalTarget(ctx, state, op, params.targetOperativeId);
      if (!target) return { ok: false, reason: 'select one other friendly INQUISITORIAL AGENT operative in the killzone' };
      timedApl(state, target, 1, {
        sourceId: ACT.signal,
        sourceText: shortQuote(actionTextOf(CARD.scionVox, ACT.signal)),
        until: 'nextActivation',
      });
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
      return { ok: true };
    },
  };
  out.push(uniqueAction(data, CARD.scionVox, ACT.signal, signalImpl));
  const printedSignal = cardOf(CARD.scionVox).uniqueActions.find((a) => a.id === ACT.signal)!;
  out.push({
    id: SIGNAL_2,
    name: 'SIGNAL (2)',
    ap: printedSignal.ap,
    type: 'unique',
    sourceText: `${printedSignal.name} ${printedSignal.ap}AP: ${printedSignal.text.replace(/\s+/g, ' ').trim()}`,
    available: (_ctx, _state, op) => op.datacardId === CARD.scionVox,
    check: (ctx, state, op, params) => {
      if (!op.actionsThisActivation.includes(ACT.signal))
        return { ok: false, reason: 'the second SIGNAL follows the first' };
      return signalImpl.check(ctx, state, op, params);
    },
    perform: (ctx, state, op, params) => signalImpl.perform(ctx, state, op, params),
  });

  return out;
}

// ---------------------------------------------------------------------------
// STRATEGIC GAMBITs — DENOUNCE's cost escalates, so the default list is replaced
// ---------------------------------------------------------------------------

function gambits(reg: HookRegistry, T: TeamHooks): void {
  for (const ploy of T.data.strategyPloys) {
    reg.on('gambitOptions', T.bind(ploy.id, 20), (ev) => {
      if (ev.player !== T.player) return;
      const cp = ploy.id === SP.denounce ? denounceCost(ev.state, T.player) : ploy.cp;
      if (ev.state.teams[T.player].cp < cp) return;
      ev.options.push({ id: ploy.id, label: `${ploy.name} (${cp}CP)`, sourceText: shortQuote(ploy.text) });
    });
  }
}

// ---------------------------------------------------------------------------

export const inquisitorialAgent = defineTeam({
  id: 'inquisitorial-agent',
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
  gambits,
  ployUsable: {
    // "…when an opponent uses a strategy or firefight ploy (excluding Command Re-roll or one
    //  that costs 0CP)… This ploy cannot be used to stop the same ploy more than once per battle."
    [FP.absoluteAuthority]: (state, player) => {
      const b = (state.opState[`inquisitorial-agent.lastPloy:${player}`] ?? {}) as Record<string, unknown>;
      const ployId = String(b['ployId'] ?? '');
      if (!ployId || Number(b['tp'] ?? -1) !== state.turningPoint)
        return { ok: false, reason: 'your opponent has not used a ploy you could stop' };
      if (usedThisBattle(state, `inquisitorial-agent.absoluteAuthority:${ployId}`))
        return { ok: false, reason: 'this ploy cannot stop the same ploy more than once per battle' };
      return { ok: true };
    },
    // "…when an enemy operative within 2" of a ready friendly INQUISITORIAL AGENT operative
    //  performs an action in which it moves."
    [FP.relentlessInPursuit]: (state, player) => {
      const mine = aliveOperatives(state, player).filter((o) => o.ready && cardHasKw(o, KW));
      const foes = aliveOperatives(state, otherPlayer(player));
      const ok = mine.some((m) => foes.some((f) => catalogueGap(m, f) <= 2 + EPS));
      return ok ? { ok: true } : { ok: false, reason: 'no ready friendly operative is within 2" of an enemy operative' };
    },
    // "…when a friendly INQUISITORIAL AGENT operative is activated."
    [FP.emperorsWill]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && cardHasKw(active, KW)
        ? { ok: true }
        : { ok: false, reason: 'use it when a friendly INQUISITORIAL AGENT operative is activated' };
    },
    // "…when an enemy operative visible to and within 3" of a friendly … operative, or … 6" of a
    //  friendly MYSTIC operative, performs the Pick Up Marker or a mission action."
    [FP.intimidatingPresence]: (state, player) => {
      const mine = aliveOperatives(state, player).filter((o) => cardHasKw(o, KW));
      const foes = aliveOperatives(state, otherPlayer(player));
      const ok = mine.some((m) =>
        foes.some((f) => catalogueGap(m, f) <= (m.datacardId === CARD.mystic ? 6 : 3) + EPS),
      );
      return ok ? { ok: true } : { ok: false, reason: 'no enemy operative is close enough to be intimidated' };
    },
  },
  aiHints: {
    roles: {
      [CARD.interrogator]: 'leader',
      [CARD.tomeSkull]: 'support',
      [CARD.autosavant]: 'objective',
      [CARD.deathWorldVeteran]: 'melee',
      [CARD.enlightener]: 'melee',
      [CARD.hexorcist]: 'gunner',
      [CARD.mystic]: 'support',
      [CARD.penalLegionnaire]: 'gunner',
      [CARD.pistolier]: 'sniper',
      [CARD.questkeeper]: 'melee',
      [CARD.gunServitor]: 'gunner',
      [CARD.prosecutor]: 'gunner',
      [CARD.vigilator]: 'melee',
      [CARD.witchseeker]: 'gunner',
      [CARD.scionGunner]: 'gunner',
      [CARD.scionMedic]: 'support',
      [CARD.scionTrooper]: 'objective',
      [CARD.scionVox]: 'support',
    },
    ployValue: {
      [SP.denounce]: 0.6,
      [SP.intenseScrutiny]: 0.5,
      [SP.quarry]: 0.7,
      [SP.irrefutableJurisdiction]: 0.4,
      [FP.absoluteAuthority]: 0.5,
      [FP.relentlessInPursuit]: 0.4,
      [FP.emperorsWill]: 0.4,
      [FP.intimidatingPresence]: 0.5,
    },
    equipmentValue: {
      [EQ.rosette]: 0.3,
      [EQ.daggers]: 0.5,
      [EQ.bodysuits]: 0.6,
      [EQ.servoSkull]: 0.4,
    },
  },
});

export default inquisitorialAgent;

/** Exported for the tests: the effect names this module writes. */
export const EFFECTS = {
  tome: TOME_EFFECT,
  quarry: QUARRY_EFFECT,
  denounce: DENOUNCE_EFFECT,
  noEscape: NO_ESCAPE_EFFECT,
  chasten: CHASTEN_EFFECT,
  scry: SCRY_EFFECT,
  emperorsWill: EMPERORS_WILL_EFFECT,
  medicShield: MEDIC_SHIELD,
  medicUsedOn: MEDIC_USED_ON,
  groupActivation: GROUP_ACTIVATION_EFFECT,
  aplTimed: APL_TIMED,
  cannotRetaliate: CANNOT_RETALIATE,
} as const;

export { TOMES_DECISION, TOMES_GAMBIT, COMBAT_DAGGER };
