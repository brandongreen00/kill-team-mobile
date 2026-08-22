/**
 * HUNTER CLADE — Adeptus Mechanicus. https://wahapedia.ru/kill-team3/kill-teams/hunter-clade/
 * Every printed string quoted here is read from `data/teams/hunter-clade.json`, never retyped.
 *
 * The team is ONE faction rule wide: **Doctrina Imperatives**, a stance economy.
 *
 *  - A STRATEGIC GAMBIT selects one of five DOCTRINA IMPERATIVEs for the whole kill team until
 *    the Ready step of the next Strategy phase. Each imperative is a MENU entry printed inside
 *    the faction rule with no id of its own, so the five blocks — and the Optimisation and
 *    Deprecation halves inside each — are **sliced out of the printed text at module load**
 *    (`IMPERATIVE_TEXT` / `OPTIMISATION` / `DEPRECATION`), the Death Korps *Guardsmen Orders* and
 *    Kasrkin *SKILL AT ARMS* treatment. The five headings are the only retyped bytes and exist
 *    solely as slice anchors.
 *  - COMMAND OVERRIDE gives ONE operative a different imperative, so every reader asks
 *    `imperativeOf(state, op, player)`: the operative's own override first, the kill team's
 *    gambit second.
 *  - The Primary Mode ("At the end of the Select Operatives step, select one DOCTRINA IMPERATIVE
 *    to be a Primary Mode") is a **pure setter**, `setPrimaryMode` — the Select Operatives step
 *    has no decision channel (docs/DECISIONS.md D-017, the Angels of Death CHAPTER TACTICS
 *    precedent), and picking one silently would be worse than picking none. Until it is set, the
 *    "once per battle you can ignore its Deprecation rule" clause simply never fires.
 *  - OMNISSIAH'S IMPERATIVE is a second menu, keyed off the same imperative.
 *
 * Reminder-only clauses (each with its engine reason) are listed at REMINDER_ONLY below; no
 * handler is registered for any of them, because a declared-but-unemitted hook is the silent
 * no-op CLAUDE.md architecture rule 5 forbids.
 *
 * No rare weapon rules are printed on this team (`rareWeaponRules: []`).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { countCrits, piercingValue } from '../../core/dice.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseGap, baseGapToPoly } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  body,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
} from '../../core/state.ts';
import { hasType } from '../../core/terrain.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import type {
  BaseShape,
  Datacard,
  GameState,
  MarkerState,
  Order,
  OperativeState,
  PendingDecision,
  PlayerId,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  chosenOperative,
  currentApl,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectFor,
  effectOn,
  effectsOn,
  enemiesInControlRange,
  gambitUsed,
  gambitsWithPrefix,
  grantFreeAction,
  hasEquipment,
  isInjuredCard,
  notEngaged,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisBattle,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('hunter-clade');
export const KW = 'HUNTER CLADE';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const CARD = {
  ruststalkerPrinceps: 'hunter-clade.sicarian-ruststalker-princeps',
  infiltratorPrinceps: 'hunter-clade.sicarian-infiltrator-princeps',
  rangerAlpha: 'hunter-clade.skitarii-ranger-alpha',
  vanguardAlpha: 'hunter-clade.skitarii-vanguard-alpha',
  infiltratorWarrior: 'hunter-clade.sicarian-infiltrator-warrior',
  ruststalkerWarrior: 'hunter-clade.sicarian-ruststalker-warrior',
  rangerDiktat: 'hunter-clade.skitarii-ranger-diktat',
  rangerGunner: 'hunter-clade.skitarii-ranger-gunner',
  rangerSurveyor: 'hunter-clade.skitarii-ranger-surveyor',
  rangerWarrior: 'hunter-clade.skitarii-ranger-warrior',
  vanguardDiktat: 'hunter-clade.skitarii-vanguard-diktat',
  vanguardGunner: 'hunter-clade.skitarii-vanguard-gunner',
  vanguardSurveyor: 'hunter-clade.skitarii-vanguard-surveyor',
  vanguardWarrior: 'hunter-clade.skitarii-vanguard-warrior',
} as const;

export const RULE = { doctrina: 'hunter-clade.rule.doctrina-imperatives' } as const;

export const SP = {
  debilitatingIrradiation: 'hunter-clade.sp.debilitating-irradiation',
  neurostaticInterference: 'hunter-clade.sp.neurostatic-interference',
  scoutingProtocol: 'hunter-clade.sp.scouting-protocol',
  accelerantAgents: 'hunter-clade.sp.accelerant-agents',
} as const;

export const FP = {
  controlEdict: 'hunter-clade.fp.control-edict',
  scrapcodeOverload: 'hunter-clade.fp.scrapcode-overload',
  commandOverride: 'hunter-clade.fp.command-override',
  omnissiahsImperative: 'hunter-clade.fp.omnissiahs-imperative',
} as const;

export const EQ = {
  radBombardment: 'hunter-clade.eq.rad-bombardment',
  redundancySystems: 'hunter-clade.eq.redundancy-systems',
  refractorField: 'hunter-clade.eq.refractor-field',
  extremisMindLink: 'hunter-clade.eq.extremis-mind-link',
} as const;

export const AB = {
  canticleOfDestruction: `${CARD.ruststalkerPrinceps}.canticle-of-destruction`,
  wastelandStalkerPrinceps: `${CARD.ruststalkerPrinceps}.wasteland-stalker`,
  wastelandStalkerWarrior: `${CARD.ruststalkerWarrior}.wasteland-stalker`,
  canticleOfShroudpsalm: `${CARD.infiltratorPrinceps}.canticle-of-shroudpsalm`,
  canticleOfElimination: `${CARD.rangerAlpha}.canticle-of-elimination`,
  canticleOfTheGlow: `${CARD.vanguardAlpha}.canticle-of-the-glow`,
  /** Printed on all four LEADER datacards. */
  controlProtocol: `${CARD.rangerAlpha}.control-protocol`,
  /** Printed on the RANGER ALPHA, DIKTAT, GUNNER, SURVEYOR and WARRIOR. */
  targetingProtocol: `${CARD.rangerAlpha}.targeting-protocol`,
  /** Printed on the VANGUARD ALPHA, DIKTAT, GUNNER, SURVEYOR and WARRIOR. */
  radSaturation: `${CARD.vanguardAlpha}.rad-saturation`,
} as const;

export const ACT = {
  rangerSignal: `${CARD.rangerDiktat}.act.signal`,
  vanguardSignal: `${CARD.vanguardDiktat}.act.signal`,
  rangerSpot: `${CARD.rangerSurveyor}.act.spot`,
  vanguardSpot: `${CARD.vanguardSurveyor}.act.spot`,
} as const;

/** "During each friendly HUNTER CLADE RUSTSTALKER operative's activation, it can perform two
 *  Fight actions" — the second Fight needs its own restriction key (D-021). */
export const FIGHT_ACCELERANT = 'Fight (Accelerant Agents)';

/** CONTROL EDICT hands the active slot back through the team's own decision kind. */
export const CONTROL_EDICT_DECISION = 'hunter-clade.controlEdict';

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

/**
 * Printed clauses with NO handler, and why. Registering one would be a silent no-op
 * (CLAUDE.md architecture rule 5); each is reported in docs/TEAM-STATUS.md.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE.doctrina}.primaryMode`]:
    'The Select Operatives step has no decision channel, so the Primary Mode is a pure setter ' +
    '(`setPrimaryMode`, D-017). Nothing is chosen by default and the once-per-battle "ignore its ' +
    'Deprecation rule" clause therefore never fires until a caller sets it.',
  [`${SP.neurostaticInterference}.melee`]:
    '"…is shooting, fighting or retaliating" — `onRollAttack` is emitted by `shoot.ts` only ' +
    '(D-031), so the re-roll lockout reaches shooting and cannot reach a fight.',
  [`${FP.omnissiahsImperative}.conqueror`]:
    '"after resolving your first attack dice during that sequence, you can immediately resolve ' +
    'another (before your opponent)" — `resolveFightDie` assigns `seq.turn` AFTER it emits ' +
    '`onStrikeResolved`, and no hook runs between the strike and the turn flip, so the extra ' +
    'dice cannot be taken.',
  [`${FP.omnissiahsImperative}.aggressor`]:
    '"You can ignore the first vertical distance of 2\\" this operative moves during one climb ' +
    'up" — per-leg climb control needs `onMoveRules`, which is declared but never emitted.',
  [`${EQ.extremisMindLink}.simultaneous`]:
    '"instead of activating the selected friendly operatives in succession, activate them at the ' +
    'same time. Complete their activations action by action in any order" — the engine has a ' +
    'single `activeOperativeId`, so two interleaved activations cannot be expressed. The 0CP ' +
    'half IS implemented (a refund, because the reducer charges CP before `onPloyUsed`).',
  [`${ACT.rangerSpot}.effect`]:
    'SPOT\'s printed effect list is MISSING from data/teams/hunter-clade.json — the text ends at ' +
    '"…you can use this effect. If you do:" with the list absent (the seventh instance of this ' +
    'scraper defect). The action marks its target; nothing can read the mark.',
  [`${ACT.vanguardSpot}.effect`]:
    'The SKITARII VANGUARD SURVEYOR prints the same truncated SPOT — the eighth instance.',
};

// ---------------------------------------------------------------------------
// Doctrina Imperatives — the menu, sliced out of the printed faction rule
// ---------------------------------------------------------------------------

export const IMPERATIVES = ['protector', 'conqueror', 'bulwark', 'aggressor', 'neutral'] as const;
export type Imperative = (typeof IMPERATIVES)[number];

/** Slice anchors — the five headings exactly as the faction rule prints them. */
export const IMPERATIVE_LABEL: Record<Imperative, string> = {
  protector: 'Protector Imperative',
  conqueror: 'Conqueror Imperative',
  bulwark: 'Bulwark Imperative',
  aggressor: 'Aggressor Imperative',
  neutral: 'Neutral Imperative',
};

/** The five DOCTRINA IMPERATIVE blocks, sliced out of the printed faction rule. */
export const IMPERATIVE_TEXT: Record<Imperative, string> = (() => {
  const printed = text(RULE.doctrina);
  const out = {} as Record<Imperative, string>;
  IMPERATIVES.forEach((imp, i) => {
    const start = printed.indexOf(`\n${IMPERATIVE_LABEL[imp]}\n`);
    const next = IMPERATIVES[i + 1];
    const endAt = next ? printed.indexOf(`\n${IMPERATIVE_LABEL[next]}\n`) : -1;
    out[imp] =
      start < 0 ? IMPERATIVE_LABEL[imp] : printed.slice(start + 1, endAt < 0 ? printed.length : endAt).trim();
  });
  return out;
})();

/** "Each DOCTRINA IMPERATIVE has both an Optimisation and a Deprecation rule." */
function half(block: string, label: 'Optimisation' | 'Deprecation'): string {
  const at = block.indexOf(`${label}:`);
  if (at < 0) return label;
  const rest = block.slice(at);
  const end = rest.indexOf('\n\n');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export const OPTIMISATION: Record<Imperative, string> = Object.fromEntries(
  IMPERATIVES.map((i) => [i, half(IMPERATIVE_TEXT[i], 'Optimisation')]),
) as Record<Imperative, string>;

export const DEPRECATION: Record<Imperative, string> = Object.fromEntries(
  IMPERATIVES.map((i) => [i, half(IMPERATIVE_TEXT[i], 'Deprecation')]),
) as Record<Imperative, string>;

/**
 * OMNISSIAH'S IMPERATIVE's own five-way menu ("that friendly operative has an additional rule
 * determined by its current DOCTRINA IMPERATIVE as follows: Protector: … Neutral: None."),
 * sliced out of the ploy text the same way. The blocks end at the closing "Note that…" sentence.
 */
export const OMNISSIAH_TEXT: Record<Imperative, string> = (() => {
  const printed = text(FP.omnissiahsImperative);
  const tail = printed.indexOf('\n\nNote that you can use this ploy');
  const body = tail < 0 ? printed : printed.slice(0, tail);
  const label = (i: Imperative): string => `${IMPERATIVE_LABEL[i].split(' ')[0]!}:`;
  const out = {} as Record<Imperative, string>;
  IMPERATIVES.forEach((imp, i) => {
    const start = body.indexOf(`\n${label(imp)}`);
    const next = IMPERATIVES[i + 1];
    const endAt = next ? body.indexOf(`\n${label(next)}`) : -1;
    out[imp] = start < 0 ? label(imp) : body.slice(start + 1, endAt < 0 ? body.length : endAt).trim();
  });
  return out;
})();

const IMPERATIVE_SET: ReadonlySet<string> = new Set(IMPERATIVES);

/** The kill-team-wide imperative from the STRATEGIC GAMBIT. */
const IMPERATIVE_TEAM = 'hunter-clade.imperative';
/** COMMAND OVERRIDE: "…for that operative to have instead of its current one (if any)". */
const IMPERATIVE_OP = 'hunter-clade.imperativeOp';
/** OMNISSIAH'S IMPERATIVE's extra rule, on one operative. */
const OMNISSIAH_EFFECT = 'hunter-clade.omnissiah';
const PRIMARY_MODE = 'hunter-clade.primaryMode';
const EDICT_PAIR = 'hunter-clade.controlEdictPair';
const SCRAPCODE_EFFECT = 'hunter-clade.scrapcode';
const SPOT_EFFECT = 'hunter-clade.spot';
const SIGNAL_EFFECT = 'hunter-clade.signal';
const RAD_APL = 'hunter-clade.radBombardmentApl';
const REFRACTOR_EFFECT = 'hunter-clade.refractorField';
const ACCELERANT_EFFECT = 'hunter-clade.accelerantAgents';
/** Sources whose `grantFreeAction` +1 APL this module has to pop again. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set([SP.scoutingProtocol, SP.accelerantAgents]);

export const imperativeGambitId = (imp: Imperative): string => `${RULE.doctrina}:${imp}`;

/**
 * "At the end of the Select Operatives step, select one DOCTRINA IMPERATIVE to be a Primary Mode
 * for your kill team until the end of the battle." A pure setter (D-017): the Select Operatives
 * step has no decision channel, so nothing is chosen until a caller says so.
 */
export function setPrimaryMode(state: GameState, player: PlayerId, imperative: Imperative): void {
  bucket(state, PRIMARY_MODE)[player] = imperative;
  log(state, {
    kind: 'system',
    player,
    text: `Primary Mode: ${IMPERATIVE_LABEL[imperative]}`,
    data: { imperative },
  });
}

export function primaryMode(state: GameState, player: PlayerId): Imperative | undefined {
  const v = bucket(state, PRIMARY_MODE)[player];
  return typeof v === 'string' && IMPERATIVE_SET.has(v) ? (v as Imperative) : undefined;
}

const teamImperativeEffect = (state: GameState, player: PlayerId) =>
  state.effects.find((e) => e.rule === IMPERATIVE_TEAM && e.player === player);

const opImperativeEffect = (state: GameState, op: OperativeState, player: PlayerId) =>
  state.effects.find((e) => e.rule === IMPERATIVE_OP && e.operativeId === op.id && e.player === player);

/**
 * The DOCTRINA IMPERATIVE this operative currently has: its own COMMAND OVERRIDE first
 * ("instead of its current one (if any)"), otherwise the kill team's.
 */
export function imperativeOf(state: GameState, op: OperativeState, player: PlayerId): Imperative | undefined {
  const own = opImperativeEffect(state, op, player);
  const raw = own ? own.data?.['imperative'] : teamImperativeEffect(state, player)?.data?.['imperative'];
  return typeof raw === 'string' && IMPERATIVE_SET.has(raw) ? (raw as Imperative) : undefined;
}

/**
 * The imperative whose **Deprecation** is in effect on this operative. The kill-team-wide one is
 * silent when the once-per-battle Primary Mode waiver was claimed for it; a COMMAND OVERRIDE is
 * not "the DOCTRINA IMPERATIVE that's your kill team's Primary Mode", so it always deprecates.
 */
export function deprecationOf(state: GameState, op: OperativeState, player: PlayerId): Imperative | undefined {
  const own = opImperativeEffect(state, op, player);
  if (own) {
    const raw = own.data?.['imperative'];
    return typeof raw === 'string' && IMPERATIVE_SET.has(raw) ? (raw as Imperative) : undefined;
  }
  const team = teamImperativeEffect(state, player);
  if (!team || team.data?.['ignoreDeprecation'] === true) return undefined;
  const raw = team.data?.['imperative'];
  return typeof raw === 'string' && IMPERATIVE_SET.has(raw) ? (raw as Imperative) : undefined;
}

/** The OMNISSIAH'S IMPERATIVE rule this operative is carrying, if any. */
export function omnissiahOf(state: GameState, op: OperativeState, player: PlayerId): Imperative | undefined {
  const eff = state.effects.find((e) => e.rule === OMNISSIAH_EFFECT && e.operativeId === op.id && e.player === player);
  if (!eff) return undefined;
  const raw = eff.data?.['imperative'];
  return typeof raw === 'string' && IMPERATIVE_SET.has(raw) ? (raw as Imperative) : undefined;
}

function setTeamImperative(T: TeamHooks, state: GameState, imperative: Imperative): void {
  dropEffects(state, (e) => e.rule === IMPERATIVE_TEAM && e.player === T.player);
  // "Once per battle, when you select the DOCTRINA IMPERATIVE that's your kill team's Primary
  //  Mode, you can ignore its Deprecation rule." Free and strictly beneficial, so it is taken on
  //  the first qualifying selection and logged (D-022).
  const ignore =
    primaryMode(state, T.player) === imperative && useOncePerBattle(state, `hunter-clade.primaryWaiver:${T.player}`);
  effect(state, {
    rule: IMPERATIVE_TEAM,
    source: { kind: 'ability', id: RULE.doctrina },
    sourceText: shortQuote(IMPERATIVE_TEXT[imperative]),
    player: T.player,
    data: { imperative, ...(ignore ? { ignoreDeprecation: true } : {}) },
    // "until the Ready step of the next Strategy phase" — nothing happens between the end of
    // this turning point and that step, so the effect expires at the end of the turning point.
    expiry: { kind: 'endOfTurningPoint' },
  });
  log(state, {
    kind: 'ploy',
    player: T.player,
    text: `DOCTRINA IMPERATIVE: ${IMPERATIVE_LABEL[imperative]}${ignore ? ' (Primary Mode — Deprecation ignored)' : ''}`,
    data: { imperative },
  });
}

function imperativeFromData(data: Record<string, unknown> | undefined): Imperative | undefined {
  const v = data?.['imperative'];
  return typeof v === 'string' && IMPERATIVE_SET.has(v) ? (v as Imperative) : undefined;
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const baseOf = (T: TeamHooks, op: OperativeState): BaseShape => T.card(op)?.base ?? { shape: 'round', mm: 25 };
const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);
const live = (o: OperativeState): boolean => !o.removed && !o.incapacitated;

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/** Is this operative currently rolling MELEE attack dice (fighting or retaliating)? */
const inMelee = (state: GameState, op: OperativeState): boolean => {
  const seq = fightSeq(state);
  return seq !== undefined && (seq.attackerId === op.id || seq.defenderId === op.id);
};

/** Is this operative currently the shooter? */
const inShoot = (state: GameState, op: OperativeState): boolean => shootSeq(state)?.attackerId === op.id;

const counteracting = (state: GameState, op: OperativeState): boolean =>
  (state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId === op.id;

const movedThisActivation = (op: OperativeState): boolean =>
  op.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a));

const onDatacard = (T: TeamHooks, op: OperativeState, weaponName: string): boolean =>
  (T.card(op)?.weapons ?? []).some((w) => w.name === weaponName);

function profileOf(T: TeamHooks, op: OperativeState, weaponName: string, profileName?: string): WeaponProfile | undefined {
  const w = T.card(op)?.weapons.find((x) => x.name === weaponName);
  return w?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? w?.profiles[0];
}

/**
 * The attack dice behind one `onDamage` event, so a per-dice change to the **Normal Dmg stat**
 * ("Normal Dmg of 3 or more inflicts 1 less damage", "subtract 1 from the Normal Dmg stat of its
 * weapons") applies once per normal success rather than once per event. A shoot resolves its
 * whole pool in one `inflictDamage` call; a fight resolves exactly one dice per strike.
 */
interface IncomingAttack {
  profile: WeaponProfile;
  striker: OperativeState;
  normals: number;
  crits: number;
}

function incomingAttack(
  T: TeamHooks,
  state: GameState,
  target: OperativeState,
  amount: number,
): IncomingAttack | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') {
    if (seq.targetId !== target.id) return undefined;
    const striker = state.operatives[seq.attackerId];
    const profile = striker ? profileOf(T, striker, seq.weaponName, seq.profileName) : undefined;
    if (!striker || !profile) return undefined;
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
    if (crits * profile.dmgC + normals * profile.dmgN !== amount) return undefined; // not the attack-dice damage
    return { profile, striker, normals, crits };
  }
  if (seq.attackerId !== target.id && seq.defenderId !== target.id) return undefined;
  const strikerId = seq.attackerId === target.id ? seq.defenderId : seq.attackerId;
  const striker = state.operatives[strikerId];
  const name = strikerId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const pname = strikerId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const profile = striker ? profileOf(T, striker, name, pname) : undefined;
  if (!striker || !profile) return undefined;
  const crit = profile.dmgC !== profile.dmgN && amount === profile.dmgC;
  if (amount !== (crit ? profile.dmgC : profile.dmgN)) return undefined;
  return { profile, striker, normals: crit ? 0 : 1, crits: crit ? 1 : 0 };
}

/**
 * "…if that enemy operative is under the effects of the Rad-Saturation rule" — Rad-Saturation is
 * the VANGUARD datacard ability "Whenever an enemy operative is within 2" of friendly HUNTER
 * CLADE VANGUARD operatives…", so the test is read off the datacards rather than hard-coded.
 */
function radSaturated(T: TeamHooks, state: GameState, foe: OperativeState): boolean {
  return T.friendlies(state, KW).some(
    (o) =>
      live(o) &&
      (T.card(o)?.abilities ?? []).some((a) => a.id.endsWith('.rad-saturation')) &&
      T.gap(o, foe) <= 2 + EPS,
  );
}

/** "any part of that enemy operative's base is underneath Vantage terrain". */
function underVantage(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  return terrain(T.ctx, state).parts.some(
    (part) =>
      hasType(part, 'Vantage') &&
      part.z0 > op.z + 0.05 &&
      baseGapToPoly(op.pos, baseOf(T, op), op.rot, part.poly) <= EPS,
  );
}

const dropZonesOf = (state: GameState, player: PlayerId) =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

/** "within that drop zone" — KT24 "within" an area is any part of the base. */
function inDropZone(T: TeamHooks, state: GameState, op: OperativeState, player: PlayerId): boolean {
  return dropZonesOf(state, player).some((zone) => baseGapToPoly(op.pos, baseOf(T, op), op.rot, zone) <= EPS);
}

function orderFromData(data: Record<string, unknown> | undefined, fallback: Order): Order {
  const v = data?.['order'];
  return v === 'engage' || v === 'conceal' ? v : fallback;
}

// ---------------------------------------------------------------------------
// CONTROL EDICT — the team's own decision kind
// ---------------------------------------------------------------------------

/**
 * "…activate one of them as normal. When that first friendly operative you activate is expended,
 * you can activate the other friendly operative before your opponent activates."
 *
 * `EndActivation` sets `state.activePlayer = otherPlayer(op.player)` AFTER it emits
 * `onActivationEnd`, and `whoActivates` reads only `activePlayer`, so the pairing cannot be
 * honoured from a hook. What the core does give is `GameContext.decisionHandlers` (the Battleclade
 * NETWORK COUNTERACT / Hierotek Reanimation Protocols shape): the end of the first activation
 * raises a real `PendingDecision`, and resolving it hands the active slot straight to the named
 * operative — a full activation, with its own order and a fresh AP budget.
 */
function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== CONTROL_EDICT_DECISION) return false;
  const player = decision.who;
  if (optionId === 'decline' || optionId === 'pass' || optionId === 'skip') {
    log(state, { kind: 'ploy', player, text: 'CONTROL EDICT: your opponent activates as normal' });
    return true;
  }
  const option = decision.options.find((o) => o.id === optionId) ?? decision.options[0];
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const op = state.operatives[String(payload['operativeId'] ?? '')];
  const order = orderFromData(payload, 'engage');
  // The first activation may have ended the turning point, or the paired operative may have been
  // incapacitated in it; in either case the window the ploy names is gone.
  if (!op || op.player !== player || !live(op) || !op.ready) return true;
  if (state.phase !== 'firefight' || state.activeOperativeId) return true;
  op.order = order; // ActivateOperative's own bookkeeping, reproduced exactly.
  op.onGuard = false;
  op.apSpent = 0;
  op.actionsThisActivation = [];
  state.activeOperativeId = op.id;
  state.activePlayer = player;
  state.firefightStep = 'performActions';
  log(state, {
    kind: 'ploy',
    player,
    text: `CONTROL EDICT: ${op.letter} activates (${order}) before the opponent`,
    data: { operativeId: op.id },
  });
  ctx.hooks.emit('onActivationStart', state, { state, operative: op });
  return true;
}

/** The LEADER + partner pair CONTROL EDICT may name, as the printed sentence allows it. */
function edictPairs(
  T: TeamHooks,
  state: GameState,
): { leader: OperativeState; partner: OperativeState }[] {
  const out: { leader: OperativeState; partner: OperativeState }[] = [];
  const mine = T.friendlies(state, KW).filter((o) => o.ready && live(o));
  for (const leader of mine.filter((o) => T.kw(o, 'LEADER')).sort(byId)) {
    for (const partner of mine.filter((o) => o.id !== leader.id).sort(byId)) {
      if (T.gap(leader, partner) > 3 + EPS) continue;
      if (!visibleTo(T, state, leader, partner)) continue;
      // "Whenever you use this ploy, you cannot select more than one HUNTER CLADE SICARIAN
      //  operative."
      if (T.kw(leader, 'SICARIAN') && T.kw(partner, 'SICARIAN')) continue;
      out.push({ leader, partner });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  doctrinaImperatives(reg, T);
  abilities(reg, T);
}

function doctrinaImperatives(reg: HookRegistry, T: TeamHooks): void {
  // ---- The STRATEGIC GAMBIT ------------------------------------------------
  // One gambit id per imperative so the choice is the player's and lands in `gambitsUsedTP`,
  // never picked silently (the Kasrkin SKILL AT ARMS / Death Korps Guardsmen Orders precedent);
  // once one has been selected this turning point the rest are withdrawn, because the rule is
  // ONE gambit with a five-way choice.
  for (const imperative of IMPERATIVES) {
    reg.on('gambitOptions', T.bind(RULE.doctrina, 15), (ev) => {
      if (ev.player !== T.player) return;
      if (T.friendlies(ev.state, KW).length === 0) return;
      if (gambitsWithPrefix(ev.state, T.player, `${RULE.doctrina}:`).length > 0) return;
      ev.options.push({
        id: imperativeGambitId(imperative),
        label: `DOCTRINA IMPERATIVE: ${IMPERATIVE_LABEL[imperative]}${
          primaryMode(ev.state, T.player) === imperative ? ' (Primary Mode)' : ''
        }`,
        sourceText: shortQuote(IMPERATIVE_TEXT[imperative]),
      });
    });
  }
  reg.on('onPloyUsed', T.bind(RULE.doctrina, 16), (ev) => {
    if (ev.player !== T.player || !ev.ployId.startsWith(`${RULE.doctrina}:`)) return;
    const imperative = ev.ployId.slice(RULE.doctrina.length + 1);
    if (!IMPERATIVE_SET.has(imperative)) return;
    setTeamImperative(T, ev.state, imperative as Imperative);
  });

  // ---- Protector Imperative ------------------------------------------------
  // Optimisation: "Friendly HUNTER CLADE operatives' ranged weapons have the Ceaseless weapon
  //  rule."
  reg.on('onWeaponRules', T.bindText(`${RULE.doctrina}.protector.opt`, OPTIMISATION.protector, 11), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (imperativeOf(ev.state, ev.operative, T.player) !== 'protector') return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Protector Imperative)'));
  });
  // Deprecation: "Worsen the Hit stat of friendly HUNTER CLADE operatives' melee weapons by 1.
  //  This isn't cumulative with being injured."
  reg.on('onStatMod', T.bindText(`${RULE.doctrina}.protector.dep`, DEPRECATION.protector, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !inMelee(ev.state, ev.operative)) return;
    if (deprecationOf(ev.state, ev.operative, T.player) !== 'protector') return;
    if (isInjuredCard(T.card(ev.operative), ev.operative)) return;
    ev.mods.hit -= 1;
  });

  // ---- Conqueror Imperative ------------------------------------------------
  reg.on('onWeaponRules', T.bindText(`${RULE.doctrina}.conqueror.opt`, OPTIMISATION.conqueror, 11), (ev) => {
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    if (imperativeOf(ev.state, ev.operative, T.player) !== 'conqueror') return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Conqueror Imperative)'));
  });
  reg.on('onStatMod', T.bindText(`${RULE.doctrina}.conqueror.dep`, DEPRECATION.conqueror, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !inShoot(ev.state, ev.operative)) return;
    if (deprecationOf(ev.state, ev.operative, T.player) !== 'conqueror') return;
    if (isInjuredCard(T.card(ev.operative), ev.operative)) return;
    ev.mods.hit -= 1;
  });

  // ---- Bulwark Imperative --------------------------------------------------
  // Optimisation: "Normal Dmg of 3 or more inflicts 1 less damage on friendly HUNTER CLADE
  //  operatives." Applied per normal-success dice, which is what a change to the Normal Dmg
  //  STAT means when a shoot resolves its whole pool in one damage event.
  reg.on('onDamage', T.bindText(`${RULE.doctrina}.bulwark.opt`, OPTIMISATION.bulwark, 11), (ev) => {
    if (ev.kind !== 'attack' || !T.mineKw(ev.target, KW)) return;
    if (imperativeOf(ev.state, ev.target, T.player) !== 'bulwark') return;
    const hit = incomingAttack(T, ev.state, ev.target, ev.amount);
    if (!hit || hit.profile.dmgN < 3 || hit.normals === 0) return;
    ev.amount = Math.max(0, ev.amount - hit.normals);
  });
  // Deprecation: "Subtract 1" from the Move stat of friendly HUNTER CLADE operatives."
  reg.on('onStatMod', T.bindText(`${RULE.doctrina}.bulwark.dep`, DEPRECATION.bulwark, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (deprecationOf(ev.state, ev.operative, T.player) !== 'bulwark') return;
    ev.mods.move -= 1;
  });

  // ---- Aggressor Imperative ------------------------------------------------
  reg.on('onStatMod', T.bindText(`${RULE.doctrina}.aggressor.opt`, OPTIMISATION.aggressor, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (imperativeOf(ev.state, ev.operative, T.player) !== 'aggressor') return;
    ev.mods.move += 1;
  });
  // Deprecation: "Worsen the Save stat of friendly HUNTER CLADE operatives by 1."
  // `saveOf` computes `card.save - mods.save`, so a negative `save` mod worsens it.
  reg.on('onStatMod', T.bindText(`${RULE.doctrina}.aggressor.dep`, DEPRECATION.aggressor, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (deprecationOf(ev.state, ev.operative, T.player) !== 'aggressor') return;
    ev.mods.save -= 1;
  });

  // Neutral Imperative prints "Optimisation: None. Deprecation: None." — there is nothing to
  // register, and a handler here would be the silent no-op architecture rule 5 forbids.
}

function abilities(reg: HookRegistry, T: TeamHooks): void {
  // ---- SICARIAN RUSTSTALKER PRINCEPS › Canticle of Destruction -------------
  // "Whenever a friendly HUNTER CLADE RUSTSTALKER operative within 3" of this operative is
  //  fighting, the first time you strike with a critical success during that sequence, inflict 1
  //  additional damage."
  reg.on('onStrikeResolved', T.bind(AB.canticleOfDestruction, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || !ev.crit || !T.ctx) return;
    const striker = ev.ctx.attacker;
    if (!T.mineKw(striker, KW) || !T.kw(striker, 'RUSTSTALKER')) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== striker.id) return; // "is fighting", not retaliating
    const princeps = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.ruststalkerPrinceps && live(o) && T.gap(o, striker) <= 3 + EPS,
    );
    if (!princeps) return;
    if (!useOncePerSequence(ev.state, `hunter-clade.canticleOfDestruction:${striker.id}`)) return;
    if (!live(ev.struck)) return;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Canticle of Destruction: ${striker.letter} inflicts 1 additional damage on ${ev.struck.letter}`,
    });
    inflictDamage(T.ctx, ev.state, ev.struck, 1, 'other');
  });

  // ---- Wasteland Stalker (RUSTSTALKER PRINCEPS + RUSTSTALKER WARRIOR) ------
  // "Whenever an operative is shooting this operative, if you can retain any cover saves, you can
  //  retain one additional cover save, or you can retain one cover save as a critical success
  //  instead. This isn't cumulative with improved cover saves from Vantage terrain."
  //
  // D-022: the rule is free, so it is auto-used on a stated policy — a critical cover save when
  // the shooter has retained a critical success (only a crit blocks a crit), an extra normal
  // cover save otherwise.
  reg.on('onDefenceDice', T.bind(AB.wastelandStalkerPrinceps, 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player) return;
    if (!(T.card(target)?.abilities ?? []).some((a) => a.id.endsWith('.wasteland-stalker'))) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    if (!ev.coverSave) return; // "if you can retain any cover saves"
    if (seq.vantageImprovedCover) return; // "isn't cumulative with improved cover saves from Vantage"
    if (countCrits(seq.attack) > 0) ev.coverSaveAsCrit = true;
    else ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // ---- Control Protocol (all four LEADER datacards) ------------------------
  // "You can use the Command Override firefight ploy for 0CP if the specified friendly HUNTER
  //  CLADE operative is visible to this operative."  CP is deducted before `onPloyUsed` fires
  //  (a known engine gap), so the discount can only be modelled as a refund.
  reg.on('onPloyUsed', T.bind(AB.controlProtocol, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.commandOverride) return;
    const target = commandOverrideTarget(T, ev.state, ev.data);
    if (!target) return;
    const leader = T.friendlies(ev.state, KW).find(
      (o) =>
        live(o) &&
        (T.card(o)?.abilities ?? []).some((a) => a.id.endsWith('.control-protocol')) &&
        visibleTo(T, ev.state, o, target),
    );
    if (!leader) return;
    const cp = DATA.firefightPloys.find((p) => p.id === FP.commandOverride)?.cp ?? 0;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Control Protocol: Command Override costs 0CP (${leader.letter} sees ${target.letter})`,
    });
  });

  // ---- SICARIAN INFILTRATOR PRINCEPS › Canticle of Shroudpsalm ------------
  // "Whenever a friendly HUNTER CLADE INFILTRATOR operative is within 3" of this operative, has a
  //  Conceal order and is in cover, that friendly operative cannot be selected as a valid target,
  //  taking precedence over all other rules (e.g. Seek, Vantage terrain) except being within 2"."
  //
  // `onValidTarget` is emitted before the core computes cover, so cover is recomputed here with
  // the DEFAULT options — which is exactly what "taking precedence over Seek and Vantage" means.
  reg.on('onValidTarget', T.bind(AB.canticleOfShroudpsalm, 25), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || !T.kw(target, KW) || !T.kw(target, 'INFILTRATOR')) return;
    if (target.order !== 'conceal' || !T.ctx) return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    const princeps = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.infiltratorPrinceps && live(o) && T.gap(o, target) <= 3 + EPS,
    );
    if (!princeps) return;
    const cover = coverAndObscured(terrain(T.ctx, ev.state), body(T.ctx, ev.attacker), body(T.ctx, target));
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'Canticle of Shroudpsalm: a concealed INFILTRATOR in cover cannot be selected';
  });

  // ---- SKITARII RANGER ALPHA › Canticle of Elimination --------------------
  // "Whenever a friendly HUNTER CLADE RANGER operative is within 3" of this operative, that
  //  friendly operative's ranged weapons have the Punishing weapon rule." The ALPHA is itself a
  //  RANGER and sits 0" from itself, so it benefits too.
  reg.on('onWeaponRules', T.bind(AB.canticleOfElimination, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !T.kw(ev.operative, 'RANGER')) return;
    const alpha = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.rangerAlpha && live(o) && T.gap(o, ev.operative) <= 3 + EPS,
    );
    if (!alpha) return;
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Canticle of Elimination)'));
  });

  // ---- Targeting Protocol (RANGER ALPHA / DIKTAT / GUNNER / SURVEYOR / WARRIOR)
  // "Whenever this operative is shooting, if it hasn't moved during the activation, or if it's a
  //  counteraction, ranged weapons on its datacard have the Lethal 5+ weapon rule. Note this
  //  operative isn't restricted from moving after shooting."
  reg.on('onWeaponRules', T.bind(AB.targetingProtocol, 12), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (!(T.card(ev.operative)?.abilities ?? []).some((a) => a.id.endsWith('.targeting-protocol'))) return;
    if (!onDatacard(T, ev.operative, ev.weaponName)) return; // "ranged weapons on its datacard"
    if (movedThisActivation(ev.operative) && !counteracting(ev.state, ev.operative)) return;
    if (ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Targeting Protocol)'));
  });

  // ---- SKITARII VANGUARD ALPHA › Canticle of the Glow --------------------
  // "Whenever an enemy operative is within 3" of this operative, if it's under the effects of the
  //  Rad-Saturation rule, also subtract 1 from the Atk stat of that enemy operative's weapons."
  reg.on('onCollectAttackDice', T.bind(AB.canticleOfTheGlow, 12), (ev) => {
    const foe = ev.ctx.attacker;
    if (foe.player === T.player) return;
    const alpha = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.vanguardAlpha && live(o) && T.gap(o, foe) <= 3 + EPS,
    );
    if (!alpha) return;
    if (!radSaturated(T, ev.state, foe)) return;
    ev.mods.atk -= 1;
  });

  // ---- Rad-Saturation (every VANGUARD datacard) --------------------------
  // "Whenever an enemy operative is within 2" of friendly HUNTER CLADE VANGUARD operatives,
  //  worsen the Hit stat of that enemy operative's weapons by 1. This isn't cumulative with being
  //  injured."
  reg.on('onStatMod', T.bind(AB.radSaturation, 12), (ev) => {
    const foe = ev.operative;
    if (foe.player === T.player) return;
    if (!radSaturated(T, ev.state, foe)) return;
    if (isInjuredCard(T.card(foe), foe)) return; // "isn't cumulative with being injured"
    ev.mods.hit -= 1;
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

/** COMMAND OVERRIDE names "a friendly HUNTER CLADE operative [you] activate". */
function commandOverrideTarget(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): OperativeState | undefined {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && T.mineKw(active, KW) && live(active)) return active;
  // D-016: with no activation in flight the operative comes from the intent's `data`, and the
  // deterministic default is the lowest-id ready friendly operative.
  return chosenOperative(state, data, T.friendlies(state, KW).filter((o) => o.ready && live(o)));
}

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // DEBILITATING IRRADIATION (strategy, 1CP)
  // =========================================================================
  // "Whenever an enemy operative is shooting against, fighting against or retaliating against a
  //  friendly HUNTER CLADE VANGUARD operative, if that enemy operative is under the effects of
  //  the Rad-Saturation rule, subtract 1 from the Normal Dmg stat of its weapons (to a minimum
  //  of 3)."
  //
  // A change to the Normal Dmg STAT, so it lands where damage is inflicted (D-019: a shared
  // `WeaponProfile` is never rewritten) and applies once per normal-success dice.
  reg.on('onDamage', T.bind(SP.debilitatingIrradiation, 20), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!gambitUsed(ev.state, T.player, SP.debilitatingIrradiation)) return;
    if (!T.mineKw(ev.target, KW) || !T.kw(ev.target, 'VANGUARD')) return;
    const hit = incomingAttack(T, ev.state, ev.target, ev.amount);
    if (!hit || hit.striker.player === T.player || hit.normals === 0) return;
    if (hit.profile.dmgN <= 3) return; // "(to a minimum of 3)"
    if (!radSaturated(T, ev.state, hit.striker)) return;
    ev.amount = Math.max(0, ev.amount - hit.normals);
  });

  // =========================================================================
  // NEUROSTATIC INTERFERENCE (strategy, 1CP)
  // =========================================================================
  // "Whenever an enemy operative within 6" of a friendly HUNTER CLADE INFILTRATOR operative is
  //  shooting, fighting or retaliating, your opponent cannot re-roll their attack dice."
  //
  // PARTIAL: `onRollAttack` is emitted by `shoot.ts` only (D-031), so the lockout reaches
  // shooting and cannot reach a fight. The melee half is REMINDER_ONLY.
  reg.on('onRollAttack', T.bind(SP.neurostaticInterference, 45), (ev) => {
    if (ev.ctx.attacker.player === T.player) return;
    if (!gambitUsed(ev.state, T.player, SP.neurostaticInterference)) return;
    if (ev.rerolls.length === 0) return;
    const near = T.friendlies(ev.state, KW).some(
      (o) => live(o) && T.kw(o, 'INFILTRATOR') && T.gap(o, ev.ctx.attacker) <= 6 + EPS,
    );
    if (!near) return;
    ev.rerolls = [];
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: 'NEUROSTATIC INTERFERENCE: your opponent cannot re-roll their attack dice',
    });
  });

  // =========================================================================
  // SCOUTING PROTOCOL (strategy, 1CP)
  // =========================================================================
  // "Each friendly HUNTER CLADE RANGER operative that has a Conceal order and is more than 6"
  //  from enemy operatives can immediately perform a free Dash action in an order of your choice.
  //  You cannot use this ploy during the first turning point."
  //
  // D-015: the free Dash is one extra AP restricted to Dash, landing on that operative's next
  // activation (the gambit is used in the Strategy phase, where nothing can act).
  reg.on('onPloyUsed', T.bind(SP.scoutingProtocol, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.scoutingProtocol) return;
    const foes = T.enemies(ev.state);
    const movers = T.friendlies(ev.state, KW)
      .filter(
        (o) =>
          live(o) &&
          T.kw(o, 'RANGER') &&
          o.order === 'conceal' &&
          foes.every((f) => T.gap(o, f) > 6 + EPS),
      )
      .sort(byId);
    for (const o of movers) {
      o.order = orderFromData(ev.data, o.order); // "in an order of your choice"
      if (effectOn(ev.state, o.id, FREE_ACTION_RULE)) continue;
      grantFreeAction(ev.state, o, {
        sourceId: SP.scoutingProtocol,
        sourceText: shortQuote(text(SP.scoutingProtocol)),
        threshold: currentApl(T, ev.state, o),
        only: ['Dash'],
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `SCOUTING PROTOCOL: ${movers.length} RANGER operative(s) get a free Dash`,
    });
  });

  // =========================================================================
  // ACCELERANT AGENTS (strategy, 1CP)
  // =========================================================================
  // "During each friendly HUNTER CLADE RUSTSTALKER operative's activation, it can perform two
  //  Fight actions, and one of them can be free."
  //
  // The second Fight is `Fight (Accelerant Agents)` — its own `ActionDef` with its own
  // restriction key (D-021) — and "one of them can be free" is D-015's extra AP restricted to a
  // Fight, handed out at the start of each RUSTSTALKER's activation while the gambit stands.
  reg.on('onActivationStart', T.bind(SP.accelerantAgents, 20), (ev) => {
    const op = ev.operative;
    if (!T.mineKw(op, KW) || !T.kw(op, 'RUSTSTALKER')) return;
    if (!gambitUsed(ev.state, T.player, SP.accelerantAgents)) return;
    effect(ev.state, {
      rule: ACCELERANT_EFFECT,
      source: { kind: 'ploy', id: SP.accelerantAgents },
      sourceText: shortQuote(text(SP.accelerantAgents)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    if (effectOn(ev.state, op.id, FREE_ACTION_RULE)) return;
    grantFreeAction(ev.state, op, {
      sourceId: SP.accelerantAgents,
      sourceText: shortQuote(text(SP.accelerantAgents)),
      threshold: currentApl(T, ev.state, op),
      only: ['Fight', FIGHT_ACCELERANT],
    });
  });

  // =========================================================================
  // CONTROL EDICT (firefight, 1CP)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.controlEdict, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.controlEdict) return;
    const pairs = edictPairs(T, ev.state);
    if (pairs.length === 0) return;
    const leaderId = ev.data?.['leaderId'];
    const partnerId = ev.data?.['operativeId'];
    const chosen =
      pairs.find((p) => p.leader.id === leaderId && p.partner.id === partnerId) ??
      pairs.find((p) => p.partner.id === partnerId) ??
      pairs.find((p) => p.leader.id === leaderId) ??
      pairs[0]!;
    dropEffects(ev.state, (e) => e.rule === EDICT_PAIR && e.player === T.player);
    effect(ev.state, {
      rule: EDICT_PAIR,
      source: { kind: 'ploy', id: FP.controlEdict },
      sourceText: shortQuote(text(FP.controlEdict)),
      player: T.player,
      data: { ids: [chosen.leader.id, chosen.partner.id] },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `CONTROL EDICT: ${chosen.leader.letter} and ${chosen.partner.letter} activate in succession`,
      data: { operativeIds: [chosen.leader.id, chosen.partner.id] },
    });
  });
  // "When that first friendly operative you activate is expended, you can activate the other
  //  friendly operative before your opponent activates."
  reg.on('onActivationEnd', T.bind(FP.controlEdict, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const pair = ev.state.effects.find(
      (e) => e.rule === EDICT_PAIR && e.player === T.player && (e.data?.['ids'] as string[] | undefined)?.includes(op.id),
    );
    if (!pair) return;
    const ids = (pair.data?.['ids'] as string[] | undefined) ?? [];
    const otherId = ids.find((id) => id !== op.id);
    const other = otherId ? ev.state.operatives[otherId] : undefined;
    dropEffects(ev.state, (e) => e === pair); // the ploy pairs exactly one succession
    if (!other || !live(other) || !other.ready) return;
    ev.state.pending.push({
      id: `hcEdict-${ev.state.seq++}`,
      who: T.player,
      kind: CONTROL_EDICT_DECISION,
      prompt: `CONTROL EDICT: activate ${other.letter} before your opponent activates?`,
      sourceText: shortQuote(text(FP.controlEdict)),
      optional: true,
      options: [
        { id: 'activate:engage', label: `Activate ${other.letter} (Engage)`, data: { operativeId: other.id, order: 'engage' } },
        { id: 'activate:conceal', label: `Activate ${other.letter} (Conceal)`, data: { operativeId: other.id, order: 'conceal' } },
        { id: 'decline', label: 'Your opponent activates as normal' },
      ],
    });
  });

  // =========================================================================
  // SCRAPCODE OVERLOAD (firefight, 1CP)
  // =========================================================================
  // "Until the start of that friendly operative's next activation, whenever determining control
  //  of a marker, treat the total APL stat of enemy operatives that contest it as 1 lower if at
  //  least one of those enemy operatives is within 3" of that friendly operative. Note this isn't
  //  a change to the APL stat, so any changes are cumulative with this, and this can change
  //  control of a marker before performing the action."
  reg.on('onPloyUsed', T.bind(FP.scrapcodeOverload, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.scrapcodeOverload) return;
    const candidates = T.friendlies(ev.state, KW).filter((o) => live(o) && T.kw(o, 'INFILTRATOR'));
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op =
      active && candidates.some((c) => c.id === active.id)
        ? active
        : chosenOperative(ev.state, ev.data, candidates.sort(byId));
    if (!op) return;
    dropEffects(ev.state, (e) => e.rule === SCRAPCODE_EFFECT && e.player === T.player);
    effect(ev.state, {
      rule: SCRAPCODE_EFFECT,
      source: { kind: 'ploy', id: FP.scrapcodeOverload },
      sourceText: shortQuote(text(FP.scrapcodeOverload)),
      operativeId: op.id,
      player: T.player,
      // "Until the start of that friendly operative's next activation" — there is no such expiry
      // kind, so it is dropped by hand at that operative's next `onActivationStart` (the
      // Mandrakes SHADOW GLYPH precedent). Both printed windows put the ploy AFTER that
      // operative's current `onActivationStart` has already been emitted, so the next emit for
      // it really is the start of its next activation.
      expiry: { kind: 'endOfBattle' },
      data: { armedTP: ev.state.turningPoint },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `SCRAPCODE OVERLOAD: ${op.letter} jams enemy coordination` });
  });
  reg.on('onActivationStart', T.bind(FP.scrapcodeOverload, 21), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, SCRAPCODE_EFFECT);
    if (!eff || eff.player !== T.player) return;
    dropEffects(ev.state, (e) => e === eff);
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `SCRAPCODE OVERLOAD ends as ${ev.operative.letter} activates again`,
    });
  });
  reg.on('onMarkerControl', T.bind(FP.scrapcodeOverload, 22), (ev) => {
    const holder = ev.state.effects.find((e) => e.rule === SCRAPCODE_EFFECT && e.player === T.player);
    const op = holder?.operativeId ? ev.state.operatives[holder.operativeId] : undefined;
    if (!op || !live(op) || !T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const foe = otherPlayer(T.player);
    const contesting = T.enemies(ev.state).filter((o) => markerContestedBy(T.ctx!, ev.state, marker, o));
    if (contesting.length === 0) return;
    if (!contesting.some((o) => T.gap(op, o) <= 3 + EPS)) return;
    ev.aplByPlayer[foe] -= 1;
  });

  // =========================================================================
  // COMMAND OVERRIDE (firefight, 1CP)
  // =========================================================================
  // "Use this firefight ploy when you activate a friendly HUNTER CLADE operative. Select a
  //  DOCTRINA IMPERATIVE for that operative to have instead of its current one (if any) until the
  //  Ready step of the next Strategy phase."
  reg.on('onPloyUsed', T.bind(FP.commandOverride, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.commandOverride) return;
    const op = commandOverrideTarget(T, ev.state, ev.data);
    if (!op) return;
    // D-016: the imperative comes from the intent's `data`; the deterministic default is the kill
    // team's Primary Mode, else the imperative it already has, else Protector.
    const imperative =
      imperativeFromData(ev.data) ?? primaryMode(ev.state, T.player) ?? imperativeOf(ev.state, op, T.player) ?? 'protector';
    dropEffects(ev.state, (e) => e.rule === IMPERATIVE_OP && e.operativeId === op.id && e.player === T.player);
    effect(ev.state, {
      rule: IMPERATIVE_OP,
      source: { kind: 'ploy', id: FP.commandOverride },
      sourceText: shortQuote(IMPERATIVE_TEXT[imperative]),
      operativeId: op.id,
      player: T.player,
      data: { imperative },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `COMMAND OVERRIDE: ${op.letter} has the ${IMPERATIVE_LABEL[imperative]}`,
      data: { operativeId: op.id, imperative },
    });
  });

  // =========================================================================
  // OMNISSIAH'S IMPERATIVE (firefight, 1CP)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.omnissiahsImperative, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.omnissiahsImperative) return;
    const op = omnissiahTarget(T, ev.state, ev.data);
    if (!op) return;
    const imperative = imperativeOf(ev.state, op, T.player) ?? 'neutral';
    dropEffects(ev.state, (e) => e.rule === OMNISSIAH_EFFECT && e.operativeId === op.id && e.player === T.player);
    effect(ev.state, {
      rule: OMNISSIAH_EFFECT,
      source: { kind: 'ploy', id: FP.omnissiahsImperative },
      sourceText: shortQuote(OMNISSIAH_TEXT[imperative]),
      operativeId: op.id,
      player: T.player,
      data: { imperative },
      // "Until the Ready step of the next Strategy phase."
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `OMNISSIAH'S IMPERATIVE: ${op.letter} — ${IMPERATIVE_LABEL[imperative].split(' ')[0]}`,
      data: { operativeId: op.id, imperative },
    });
  });
  // Protector: "This operative's ranged weapons have the Severe weapon rule."
  reg.on('onWeaponRules', T.bindText(`${FP.omnissiahsImperative}.protector`, OMNISSIAH_TEXT.protector, 21), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (omnissiahOf(ev.state, ev.operative, T.player) !== 'protector') return;
    ev.rules.push(ruleTag('Severe', undefined, "Severe (OMNISSIAH'S IMPERATIVE)"));
  });
  // Bulwark: "Improve this operative's Save stat by 1. In addition, whenever an operative is
  //  shooting this operative, you can collect and roll one additional defence dice. If you use
  //  this ploy during a Shoot action, this operative's Save stat is changed immediately (this
  //  takes precedence over the core rules)." The Save rides `onStatMod`, which `saveOf` reads at
  //  the moment the defence dice are rolled, so the "immediately" clause holds by construction.
  reg.on('onStatMod', T.bindText(`${FP.omnissiahsImperative}.bulwark`, OMNISSIAH_TEXT.bulwark, 21), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (omnissiahOf(ev.state, ev.operative, T.player) !== 'bulwark') return;
    ev.mods.save += 1;
  });
  reg.on('onDefenceDice', T.bindText(`${FP.omnissiahsImperative}.bulwark`, OMNISSIAH_TEXT.bulwark, 21), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    if (omnissiahOf(ev.state, target, T.player) !== 'bulwark') return;
    ev.count += 1;
  });
  // Conqueror and Aggressor are REMINDER_ONLY — see REMINDER_ONLY above. Neutral prints "None."
}

/** OMNISSIAH'S IMPERATIVE names "a friendly HUNTER CLADE operative" in two windows. */
function omnissiahTarget(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
): OperativeState | undefined {
  const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (active && T.mineKw(active, KW) && live(active)) return active;
  // "Alternatively, use it when an enemy operative is shooting a friendly HUNTER CLADE operative,
  //  at the end of the Roll Attack Dice step."
  const seq = shootSeq(state);
  const shot = seq ? state.operatives[seq.targetId] : undefined;
  if (shot && T.mineKw(shot, KW) && live(shot)) return shot;
  return chosenOperative(state, data, T.friendlies(state, KW).filter(live));
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // RAD BOMBARDMENT
  // =========================================================================
  // "Once per battle STRATEGIC GAMBIT in any turning point after the first. Select one objective
  //  marker or your opponent's drop zone. Roll one D6 separately for each enemy operative within
  //  control range of that selected objective marker or within that drop zone, and subtract 1 if
  //  any part of that enemy operative's base is underneath Vantage terrain: on a 4+, subtract 1
  //  from that operative's APL stat until the end of its next activation; on a 6, also inflict D3
  //  damage on it (roll separately for each)."
  reg.on('gambitOptions', T.bind(EQ.radBombardment, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.radBombardment)) return;
    if (ev.state.turningPoint <= 1) return; // "in any turning point after the first"
    if (usedThisBattle(ev.state, `hunter-clade.radBombardment:${T.player}`)) return;
    ev.options.push({
      id: EQ.radBombardment,
      label: 'RAD BOMBARDMENT (STRATEGIC GAMBIT)',
      sourceText: shortQuote(text(EQ.radBombardment)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.radBombardment, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.radBombardment) return;
    if (!useOncePerBattle(ev.state, `hunter-clade.radBombardment:${T.player}`)) return;
    if (!T.ctx) return;
    const foe = otherPlayer(T.player);
    const objectives = Object.values(ev.state.markers)
      .filter((m) => m.kind === 'objective')
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // D-016: the choice comes from the gambit's `data`; the deterministic default is whichever
    // objective marker (or the enemy drop zone) currently catches the most enemy operatives.
    const asked = ev.data?.['markerId'];
    const wantsDropZone = ev.data?.['dropZone'] === true;
    const caughtByMarker = (m: MarkerState): OperativeState[] =>
      T.enemies(ev.state).filter((o) => live(o) && markerContestedBy(T.ctx!, ev.state, m, o));
    const caughtByZone = (): OperativeState[] =>
      T.enemies(ev.state).filter((o) => live(o) && inDropZone(T, ev.state, o, foe));
    let label = "your opponent's drop zone";
    let caught = caughtByZone();
    if (!wantsDropZone) {
      const chosenMarker =
        objectives.find((m) => m.id === asked) ??
        objectives.slice().sort((a, b) => caughtByMarker(b).length - caughtByMarker(a).length)[0];
      if (chosenMarker && (asked !== undefined || caughtByMarker(chosenMarker).length >= caught.length)) {
        label = `objective marker ${chosenMarker.id}`;
        caught = caughtByMarker(chosenMarker);
      }
    }
    log(ev.state, { kind: 'ploy', player: T.player, text: `RAD BOMBARDMENT falls on ${label}` });
    for (const victim of caught.slice().sort(byId)) {
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'radBombardment', [roll], T.player, `RAD BOMBARDMENT ${victim.letter}`);
      const score = roll - (underVantage(T, ev.state, victim) ? 1 : 0);
      if (score < 4) {
        log(ev.state, { kind: 'dice', player: T.player, text: `RAD BOMBARDMENT: ${victim.letter} is unharmed (${score})` });
        continue;
      }
      effect(ev.state, {
        rule: RAD_APL,
        source: { kind: 'equipment', id: EQ.radBombardment },
        sourceText: shortQuote(text(EQ.radBombardment)),
        operativeId: victim.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
      });
      log(ev.state, { kind: 'dice', player: T.player, text: `RAD BOMBARDMENT: ${victim.letter} loses 1 APL (${score})` });
      if (score < 6) continue;
      const dmg = T.ctx.rng.d3();
      recordRoll(ev.state, 'radBombardment', [dmg], T.player, `RAD BOMBARDMENT D3 ${victim.letter}`);
      inflictDamage(T.ctx, ev.state, victim, dmg, 'other');
    }
  });
  reg.on('onStatMod', T.bind(EQ.radBombardment, 32), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, RAD_APL);
    if (!eff || eff.player !== T.player) return;
    ev.mods.apl -= 1;
  });

  // =========================================================================
  // REDUNDANCY SYSTEMS
  // =========================================================================
  // "Once per turning point, when a friendly HUNTER CLADE operative is activated, if it's not
  //  within control range of enemy operatives, you can use this rule. If you do, that friendly
  //  operative regains up to D3+2 lost wounds."
  //
  // D-022: the rule is free, so it is auto-used on a stated policy — the first activation each
  // turning point of a friendly operative that has already lost at least 3 wounds (the minimum
  // the roll can restore), so the one use is never spent healing nothing.
  reg.on('onActivationStart', T.bind(EQ.redundancySystems, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.redundancySystems) || !T.ctx) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW) || !live(op)) return;
    if (enemiesInControlRange(T.ctx, ev.state, op).length > 0) return;
    const max = T.card(op)?.wounds ?? op.wounds;
    if (max - op.wounds < 3) return;
    if (!useOncePerTP(ev.state, `hunter-clade.redundancy:${T.player}`)) return;
    const roll = T.ctx.rng.d3();
    recordRoll(ev.state, 'redundancySystems', [roll], T.player, 'REDUNDANCY SYSTEMS D3+2');
    const healed = Math.min(max - op.wounds, roll + 2);
    op.wounds += healed;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `REDUNDANCY SYSTEMS: ${op.letter} regains ${healed} lost wounds`,
      data: { operativeId: op.id },
    });
  });

  // =========================================================================
  // REFRACTOR FIELD
  // =========================================================================
  // "Once per turning point, when an operative is shooting a friendly HUNTER CLADE operative, at
  //  the start of the Roll Defence Dice step, you can use this rule. If you do, worsen the x of
  //  the Piercing weapon rule by 1 (if any) until the end of that sequence. Note that Piercing 1
  //  would therefore be ignored."
  //
  // Piercing only ever removes defence dice, and `rollDefence` collects `3 - piercing` before
  // this hook runs, so worsening x by 1 is exactly one defence dice back. D-022: free, so it is
  // auto-used the first time in a turning point that it would actually give a dice back.
  //
  // "until the end of that sequence" is scoped by clearing the marker whenever a PRIMARY target's
  // attack dice are collected: a Blast/Torrent secondary keeps `seq` and re-enters `rollDefence`
  // with `ctx.secondary === true`, so every target of one sequence shares the single use.
  reg.on('onCollectAttackDice', T.bind(EQ.refractorField, 29), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.secondary) return;
    dropEffects(ev.state, (e) => e.rule === REFRACTOR_EFFECT && e.player === T.player);
  });
  reg.on('onDefenceDice', T.bind(EQ.refractorField, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.refractorField)) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    // The marker is per-PLAYER, not per-target: one use covers every target of the sequence.
    const already = effectFor(ev.state, T.player, REFRACTOR_EFFECT);
    if (piercingValue(ev.ctx.rules, countCrits(seq.attack)) < 1) return;
    if (!already && !useOncePerTP(ev.state, `hunter-clade.refractor:${T.player}`)) return;
    if (!already) {
      effect(ev.state, {
        rule: REFRACTOR_EFFECT,
        source: { kind: 'equipment', id: EQ.refractorField },
        sourceText: shortQuote(text(EQ.refractorField)),
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `REFRACTOR FIELD: Piercing is worsened by 1 against ${target.letter}`,
      });
    }
    ev.count += 1;
  });

  // =========================================================================
  // EXTREMIS MIND-LINK
  // =========================================================================
  // "Once per battle, you can use the Control Edict firefight ploy for 0CP…"  CP is deducted
  // before `onPloyUsed` fires, so the discount is a refund. The rest of the sentence — activating
  // both operatives at the same time, action by action — is REMINDER_ONLY.
  reg.on('onPloyUsed', T.bind(EQ.extremisMindLink, 12), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.controlEdict) return;
    if (!hasEquipment(ev.state, T.player, EQ.extremisMindLink)) return;
    if (!useOncePerBattle(ev.state, `hunter-clade.mindLink:${T.player}`)) return;
    const cp = DATA.firefightPloys.find((p) => p.id === FP.controlEdict)?.cp ?? 0;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'EXTREMIS MIND-LINK: Control Edict costs 0CP' });
  });
}

// ---------------------------------------------------------------------------
// The `grantFreeAction` APL upkeep
// ---------------------------------------------------------------------------

/*
 * `grantFreeAction` models a free action as one extra AP (D-015) by pushing +1 into `aplMods`,
 * which the engine never pops — `expireActivationEffects` drops the effect and leaves the
 * modifier behind. SCOUTING PROTOCOL hands one out per RANGER in the Strategy phase and
 * ACCELERANT AGENTS one per RUSTSTALKER activation, so without this upkeep those operatives
 * would sit on APL 3 for the rest of the battle (the Chaos Cult / Canoptek Circle precedent).
 */
function upkeep(reg: HookRegistry, T: TeamHooks): void {
  const sweep = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      const at = op.aplMods.lastIndexOf(1);
      if (at >= 0) op.aplMods.splice(at, 1);
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onActivationEnd', T.bindText('hunter-clade.aplUpkeep', text(SP.scoutingProtocol), 90), (ev) => {
    if (ev.operative.player === T.player) sweep(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('hunter-clade.aplUpkeep', text(SP.scoutingProtocol), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) sweep(ev.state, o);
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** SIGNAL and SPOT are printed identically on the RANGER and the VANGUARD datacard. */
function signalAction(data: typeof DATA, datacardId: string, actionId: string): ActionDef {
  return uniqueAction(data, datacardId, actionId, {
    // "SUPPORT. Select one other friendly HUNTER CLADE operative visible to and within 6" of this
    //  operative." Every condition lives in `check` (D-026).
    check: (ctx, state, op, params) => {
      const eng = notEngaged(ctx, state, op);
      if (!eng.ok) return eng; // "cannot perform this action while within control range of an enemy operative"
      const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
      if (!target || target.removed || target.incapacitated || target.player !== op.player || target.id === op.id)
        return { ok: false, reason: 'select one OTHER friendly HUNTER CLADE operative' };
      const card = ctx.datacards.get(op.datacardId);
      const targetCard = ctx.datacards.get(target.datacardId);
      if (!card || !targetCard) return { ok: false, reason: 'unknown datacard' };
      if (!targetCard.keywords.includes(KW))
        return { ok: false, reason: 'select one OTHER friendly HUNTER CLADE operative' };
      const range = supportDistance(ctx, state, op, 6);
      if (baseGap(op.pos, card.base, op.rot, target.pos, targetCard.base, target.rot) > range + EPS)
        return { ok: false, reason: `that operative is more than ${range}" away` };
      if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
        return { ok: false, reason: 'that operative is not visible to this operative' };
      return { ok: true };
    },
    perform: (_ctx, state, op, params) => {
      const target = state.operatives[params.targetOperativeId!]!;
      dropEffects(state, (e) => e.rule === SIGNAL_EFFECT && e.operativeId === target.id);
      effect(state, {
        rule: SIGNAL_EFFECT,
        source: { kind: 'ability', id: actionId },
        sourceText: shortQuote(actionText(datacardId, actionId)),
        operativeId: target.id,
        player: op.player,
        // "Until the end of that operative's next activation, add 1 to its APL stat."
        expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
      });
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
      return { ok: true };
    },
  });
}

function spotAction(data: typeof DATA, datacardId: string, actionId: string): ActionDef {
  return uniqueAction(data, datacardId, actionId, {
    // "SUPPORT. Select one enemy operative visible to this operative."
    check: (ctx, state, op, params) => {
      const eng = notEngaged(ctx, state, op);
      if (!eng.ok) return eng;
      const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
      if (!target || target.removed || target.incapacitated || target.player === op.player)
        return { ok: false, reason: 'select one enemy operative' };
      if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
        return { ok: false, reason: 'that operative is not visible to this operative' };
      return { ok: true };
    },
    perform: (_ctx, state, op, params) => {
      const target = state.operatives[params.targetOperativeId!]!;
      dropEffects(state, (e) => e.rule === SPOT_EFFECT && e.player === op.player);
      effect(state, {
        rule: SPOT_EFFECT,
        source: { kind: 'ability', id: actionId },
        sourceText: shortQuote(actionText(datacardId, actionId)),
        operativeId: target.id,
        player: op.player,
        data: { spotterId: op.id },
        // "Until the end of the turning point"
        expiry: { kind: 'endOfTurningPoint' },
      });
      // The printed effect list is MISSING from data/teams/hunter-clade.json — the text ends at
      // "…you can use this effect. If you do:" with the list absent — so the Spot mark is placed
      // and nothing reads it. Registering a hook here would be a silent no-op; reported as a data
      // bug instead (REMINDER_ONLY).
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter}: SPOT — ${target.letter} is spotted (the printed effect list is missing from the source data)`,
      });
      return { ok: true };
    },
  });
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    signalAction(data, CARD.rangerDiktat, ACT.rangerSignal),
    signalAction(data, CARD.vanguardDiktat, ACT.vanguardSignal),
    spotAction(data, CARD.rangerSurveyor, ACT.rangerSpot),
    spotAction(data, CARD.vanguardSurveyor, ACT.vanguardSpot),
  ];
}

/**
 * "…it can perform two Fight actions" — the reducer refuses a repeated restriction key BEFORE
 * `canPerformAction` is emitted, and a hook can only forbid, so the second Fight is its own
 * `ActionDef` with its own key (D-021, the Chaos Cult UNLEASH THE DAEMON shape).
 */
registerAction({
  id: FIGHT_ACCELERANT,
  name: FIGHT_ACCELERANT,
  ap: 1,
  type: 'unique',
  sourceText: text(SP.accelerantAgents),
  available: (_ctx, state, op) => state.effects.some((e) => e.rule === ACCELERANT_EFFECT && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === ACCELERANT_EFFECT && e.operativeId === op.id))
      return { ok: false, reason: 'ACCELERANT AGENTS has not been used this turning point' };
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'this is the second Fight action of that activation' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------

export const hunterClade = defineTeam({
  id: 'hunter-clade',
  rules: (reg, T) => {
    rules(reg, T);
    upkeep(reg, T);
    // CONTROL EDICT raises its own decision kind; the handler is installed once per GameContext
    // (`decisionHandler` is a stable reference).
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(decisionHandler)) handlers.push(decisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  gambits: (reg, T) => {
    defaultGambits(reg, T);
    // "You cannot use this ploy during the first turning point." (SCOUTING PROTOCOL)
    reg.on('gambitOptions', T.bind(SP.scoutingProtocol, 60), (ev) => {
      if (ev.player !== T.player || ev.state.turningPoint > 1) return;
      ev.options = ev.options.filter((o) => o.id !== SP.scoutingProtocol);
    });
  },
  ployUsable: {
    // "You cannot use this ploy during the first turning point."
    [SP.scoutingProtocol]: (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
    // "Use this firefight ploy when it's your turn to activate a friendly operative. Select one
    //  friendly HUNTER CLADE LEADER operative and one other ready friendly HUNTER CLADE operative
    //  visible to and within 3" of that LEADER operative."  Visibility needs a GameContext, which
    //  `usable` is not given, so the pair is screened here on readiness, the 3" and the SICARIAN
    //  clause; `onPloyUsed` applies the full test.
    [FP.controlEdict]: (state, player) => {
      if (state.phase !== 'firefight' || state.activeOperativeId)
        return { ok: false, reason: "use this ploy when it's your turn to activate a friendly operative" };
      const mine = state.teams[player].operativeIds
        .map((id) => state.operatives[id]!)
        .filter((o) => o.ready && !o.removed && !o.incapacitated);
      const kwOf = (o: OperativeState): string[] => cardById(o.datacardId)?.keywords ?? [];
      const leaders = mine.filter((o) => kwOf(o).includes('LEADER'));
      const ok = leaders.some((l) =>
        mine.some((p) => {
          if (p.id === l.id) return false;
          if (kwOf(l).includes('SICARIAN') && kwOf(p).includes('SICARIAN')) return false;
          const lc = cardById(l.datacardId);
          const pc = cardById(p.datacardId);
          if (!lc || !pc) return false;
          return baseGap(l.pos, lc.base, l.rot, p.pos, pc.base, p.rot) <= 3 + EPS;
        }),
      );
      return ok
        ? { ok: true }
        : { ok: false, reason: 'no ready friendly operative is within 3" of a ready friendly LEADER operative' };
    },
    // "Use this firefight ploy when you activate a friendly HUNTER CLADE operative."
    [FP.commandOverride]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'no friendly operative is activating' };
      return { ok: true };
    },
    // "Use this firefight ploy during a friendly HUNTER CLADE operative's activation.
    //  Alternatively, use it when an enemy operative is shooting a friendly HUNTER CLADE
    //  operative, at the end of the Roll Attack Dice step."
    [FP.omnissiahsImperative]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (active && active.player === player) return { ok: true };
      const seq = state.sequence?.kind === 'shoot' ? state.sequence : undefined;
      if (seq && seq.defender === player) return { ok: true };
      return { ok: false, reason: "use this ploy during a friendly operative's activation, or while it is being shot" };
    },
  },
  aiHints: {
    roles: {
      [CARD.ruststalkerPrinceps]: 'leader',
      [CARD.infiltratorPrinceps]: 'leader',
      [CARD.rangerAlpha]: 'leader',
      [CARD.vanguardAlpha]: 'leader',
      [CARD.infiltratorWarrior]: 'melee',
      [CARD.ruststalkerWarrior]: 'melee',
      [CARD.rangerDiktat]: 'support',
      [CARD.rangerGunner]: 'gunner',
      [CARD.rangerSurveyor]: 'scout',
      [CARD.rangerWarrior]: 'objective',
      [CARD.vanguardDiktat]: 'support',
      [CARD.vanguardGunner]: 'gunner',
      [CARD.vanguardSurveyor]: 'scout',
      [CARD.vanguardWarrior]: 'objective',
    },
    ployValue: {
      [SP.debilitatingIrradiation]: 2,
      [SP.neurostaticInterference]: 3,
      [SP.scoutingProtocol]: 3,
      [SP.accelerantAgents]: 3,
      [FP.controlEdict]: 4,
      [FP.scrapcodeOverload]: 3,
      [FP.commandOverride]: 3,
      [FP.omnissiahsImperative]: 4,
      // Without a DOCTRINA IMPERATIVE the faction rule is switched off for the turning point, so
      // the gambit is priced above every ploy.
      [imperativeGambitId('protector')]: 9,
      [imperativeGambitId('conqueror')]: 8,
      [imperativeGambitId('bulwark')]: 7,
      [imperativeGambitId('aggressor')]: 7,
      [imperativeGambitId('neutral')]: 1,
      [EQ.radBombardment]: 6,
    },
    equipmentValue: {
      [EQ.radBombardment]: 4,
      [EQ.redundancySystems]: 3,
      [EQ.refractorField]: 3,
      [EQ.extremisMindLink]: 2,
    },
  },
});

/** The static datacard catalogue, for the pure `ployUsable` predicates (which get no context). */
function cardById(id: string): Datacard | undefined {
  return DATA.datacards.find((c) => c.id === id);
}
