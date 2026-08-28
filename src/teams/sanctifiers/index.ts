/**
 * SANCTIFIERS — Adeptus Ministorum (Agents of the Imperium).
 * https://wahapedia.ru/kill-team3/kill-teams/sanctifiers/
 *
 * Rule text is read from `data/teams/sanctifiers.json`; every hook carries a short verbatim
 * quote of the printed rule in its RuleBinding.
 *
 * Two states drive almost every rule in the team, so both are modelled once and read back
 * rather than recomputed per rule:
 *
 *  - **ORATOR** — the operative selected by the Ministorum Sermon STRATEGIC GAMBIT, held as an
 *    `endOfBattle` effect ("Until you use this STRATEGIC GAMBIT again during the battle").
 *  - **benefitting from the SERMON** — within 3" of a friendly ORATOR (6" for a CONFESSOR), or
 *    activated within that distance, or a MISSIONARY with a holy relic, or a PREACHER that
 *    controls an objective marker. `benefitting()` is the single predicate; nine other rules
 *    read it.
 *
 * The Brazier of holy fire is ONE weapon with two UNNAMED profiles that differ only by
 * `type` (ranged / melee) — see docs/TEAM-DATA.md §2. Nothing here looks a profile up by
 * name; profiles are always matched on `(name ?? '')` against the sequence's `profileName`,
 * exactly as `findProfile` does.
 *
 * NOT modelled (each clause is reported in docs/TEAM-STATUS.md rather than silently dropped):
 *  - RELIQUANT › Imperial Cult Devotion, whole rule: a free action performed by an operative
 *    that is already incapacitated. `onIncapacitated.freeActions` is declared but never
 *    consumed and there is no intent for acting outside an activation (the Kommandos Boom!
 *    gap), so no handler is registered for it at all.
 *  - Lead the Procession / RALLY THE FLOCK: "must end that move in a location where they are
 *    still benefitting from the SERMON" / "closer and visible to a friendly ORATOR" — no hook
 *    constrains where a move ENDS (`onMoveDistance` carries only the allowance).
 *  - Lead the Procession: "don't remove it from the killzone until this rule has been
 *    resolved" — removal is `removeIncapacitated`, with no seam.
 *  - Bladed Stance: "that success must be used to block" — the engine builds the
 *    strike/block options.
 *  - Miracle: "even if it's performed an action that prevents it from performing those
 *    actions" — the universal Dash / Fall Back checks still apply to the free action.
 *  - CHERUB: "cannot use any weapons that aren't on its datacard" — `weaponsOf` appends
 *    granted weapons AFTER `availableWeapons`, so the clause has no seam (nothing in this
 *    team or in universal equipment grants the CHERUB a weapon, so it currently bites on
 *    nothing); the "unique actions other than Incentivise" half IS enforced.
 *  - Commanding Declamation and PURITY SEALS / ARDENT ERADICATION: see the comments at each.
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { ruleOf, successes } from '../../core/dice.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseGap, baseRadius, basesOverlap, dist } from '../../core/geometry.ts';
import { HookRegistry, type HookEvents } from '../../core/hooks.ts';
import { advanceShoot, checkTarget, startShoot, validTargets } from '../../core/sequences/shoot.ts';
import type { ShootSequence, FightSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  card,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  markerController,
  modelHeight,
  moveOf,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, surfaceAt, wallRouteDistance } from '../../core/terrain.ts';
import type { GameState, OperativeState, PendingDecision, PlayerId, Vec2, Weapon, WeaponProfile } from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { coverAndObscured, isVisible, vantageIgnoreFilter, withinControlRange, type Body } from '../../core/visibility.ts';
import { teamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  hasToken,
  giveToken,
  makeTeamHooks,
  notEngaged,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisBattle,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('sanctifiers');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

const KW = 'SANCTIFIER';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const CONFESSOR = 'sanctifiers.confessor';
export const CHERUB = 'sanctifiers.cherub';
export const CONFLAGRATOR = 'sanctifiers.conflagrator';
export const DEATH_CULT_ASSASSIN = 'sanctifiers.death-cult-assassin';
export const DRILL_ABBOT = 'sanctifiers.drill-abbot';
export const PERSECUTOR = 'sanctifiers.persecutor';
export const MIRACULIST = 'sanctifiers.miraculist';
export const MISSIONARY = 'sanctifiers.missionary';
export const PREACHER = 'sanctifiers.preacher';
export const RELIQUANT = 'sanctifiers.reliquant';
export const SALVATIONIST = 'sanctifiers.salvationist';

const R_BLAZE = 'sanctifiers.rule.blaze';
const R_SERMON = 'sanctifiers.rule.ministorum-sermon';

const A_LEAD = 'sanctifiers.confessor.lead-the-procession';
const A_DECLAMATION = 'sanctifiers.confessor.commanding-declamation';
const A_CHERUB = 'sanctifiers.cherub.cherub';
const A_FLY = 'sanctifiers.cherub.fly';
const A_TWIN_TORRENT = 'sanctifiers.conflagrator.twin-torrent';
const A_RACK = 'sanctifiers.conflagrator.sanctification-rack';
const A_BLADED_STANCE = 'sanctifiers.death-cult-assassin.bladed-stance';
const A_DISCIPLINARIAN = 'sanctifiers.drill-abbot.schola-progenium-disciplinarian';
const A_NULL_SKULL = 'sanctifiers.drill-abbot.null-skull';
const A_MERCILESS = 'sanctifiers.persecutor.merciless-castigation';
const A_FANATICAL = 'sanctifiers.persecutor.fanatical-retribution';
const A_WREATHED = 'sanctifiers.miraculist.wreathed';
const A_MIRACLE = 'sanctifiers.miraculist.miracle';
const A_SPREAD_THE_WORD = 'sanctifiers.missionary.spread-the-word-of-the-god-emperor';
const A_CULT_ICON = 'sanctifiers.reliquant.cult-icon';
const A_CONVERSION_FIELD = 'sanctifiers.salvationist.conversion-field';

const SP_EMPEROR_PROTECTS = 'sanctifiers.sp.the-emperor-protects';
const SP_FERVENT_BRAWL = 'sanctifiers.sp.fervent-brawl';
const SP_ZEALOUS_PERSECUTION = 'sanctifiers.sp.zealous-persecution';
const SP_RALLY_THE_FLOCK = 'sanctifiers.sp.rally-the-flock';
const FP_ROSARIUS = 'sanctifiers.fp.rosarius';
const FP_ARDENT_ERADICATION = 'sanctifiers.fp.ardent-eradication';
const FP_REDEEMED_THROUGH_FIRE = 'sanctifiers.fp.redeemed-through-fire';
const FP_UNWAVERING_DEVOTION = 'sanctifiers.fp.unwavering-devotion';
const EQ_ORBS = 'sanctifiers.eq.sanctification-orbs';
const EQ_PURITY_SEALS = 'sanctifiers.eq.purity-seals';
const EQ_ECCLESIARCHY_TEXTS = 'sanctifiers.eq.ecclesiarchy-texts';
const EQ_CULT_SYMBOLS = 'sanctifiers.eq.imperial-cult-symbols';

export const ACT_INCENTIVISE = 'sanctifiers.cherub.act.incentivise';
export const ACT_TRAINED_ASSASSIN = 'sanctifiers.death-cult-assassin.act.trained-assassin';
export const ACT_MEDIKIT = 'sanctifiers.salvationist.act.medikit';
/** The unique action the SANCTIFICATION ORBS equipment grants (it has no `uniqueActions` entry). */
export const ACT_SANCTIFICATION_ORB = 'sanctifiers.eq.act.sanctification-orb';
export const WREATHED_SHOOT = 'Shoot (Wreathed)';
export const MERCILESS_FIGHT = 'Fight (Merciless Castigation)';
export const FLY_REPOSITION = 'Reposition (Cherub Fly)';
export const FLY_FALL_BACK = 'Fall Back (Cherub Fly)';
export const FLY_CHARGE = 'Charge (Cherub Fly)';

/** The Ministorum Sermon STRATEGIC GAMBIT (a faction rule, not one of the four strategy ploys). */
export const SERMON_GAMBIT = R_SERMON;

/** "…that operative has the ORATOR keyword." */
export const ORATOR_EFFECT = 'sanctifiers.orator';
/** "…gains one of your Blaze tokens." */
export const BLAZE_TOKEN = 'sanctifiers.blaze';
/** "…it gains one of your Doused tokens." */
export const DOUSED_TOKEN = 'sanctifiers.doused';
/** The SERMON window opened by activating within range of an ORATOR. */
const SERMON_ACTIVATION = 'sanctifiers.sermonActivation';
/** A temporary APL change this module owns, popped when the operative's activation ends. */
const TEMP_APL = 'sanctifiers.tempApl';
/** Records MERCILESS CASTIGATION's locked-in enemy for the free second Fight. */
const MERCILESS_TARGET = 'sanctifiers.mercilessTarget';
/** MIRACLE's "cannot be incapacitated for the remainder of the action". */
const MIRACLE_SHIELD = 'sanctifiers.miracleShield';
/** Set while a Wreathed weapon is being used through its own action. */
const WREATHED_ARMED = 'sanctifiers.wreathedArmed';

/** The token's own effect is the SANCTIFIERS player's choice of removal method. */
export const BLAZE_DECISION = 'sanctifiers.blazeToken';

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

/** Visible to one another — the "visible to this operative (or vice versa)" shape. */
function eitherVisible(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  return visible(T, state, a, b) || visible(T, state, b, a);
}

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);

/** In a fight, whoever is resolving a die is the one inflicting damage. */
function lastStriker(state: GameState): string | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  return seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
}

/**
 * The weapon profile currently inflicting damage. `inflictDamage` always emits `onDamage`
 * with `ctx: null`, so the profile has to be recovered from `state.sequence`. Profiles are
 * matched on `(name ?? '')` — the Brazier of holy fire's two profiles are both unnamed.
 */
function currentProfile(T: TeamHooks, state: GameState): { op: OperativeState; profile: WeaponProfile } | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const holderId = seq.kind === 'shoot' ? seq.attackerId : (lastStriker(state) ?? seq.attackerId);
  const holder = state.operatives[holderId];
  if (!holder) return undefined;
  const name =
    seq.kind === 'shoot' ? seq.weaponName : holderId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const profileName = seq.kind === 'shoot' ? seq.profileName : holderId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const wanted = profileName ?? '';
  const profile =
    weapon?.profiles.find((p) => (p.name ?? '') === wanted) ??
    // A melee strike with a two-profile weapon: pick the profile of the right type.
    weapon?.profiles.find((p) => (seq.kind === 'fight' ? p.type === 'melee' : p.type === 'ranged')) ??
    weapon?.profiles[0];
  return profile ? { op: holder, profile } : undefined;
}

/** The profile a named operative is using in the current fight (for a strike out of turn). */
function fightProfileOf(T: TeamHooks, state: GameState, op: OperativeState): WeaponProfile | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  const name = seq.attackerId === op.id ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const profileName = seq.attackerId === op.id ? seq.attackerProfile : seq.defenderProfile;
  const weapon = T.card(op)?.weapons.find((w) => w.name === name);
  const wanted = profileName ?? '';
  return (
    weapon?.profiles.find((p) => (p.name ?? '') === wanted) ??
    weapon?.profiles.find((p) => p.type === 'melee') ??
    weapon?.profiles[0]
  );
}

/** Every weapon the operative actually carries (loadout-aware when a context exists). */
function carriedWeapons(T: TeamHooks, state: GameState, op: OperativeState): Weapon[] {
  if (T.ctx) return weaponsOf(T.ctx, state, op);
  return T.card(op)?.weapons ?? [];
}

const hasRuleNamed = (w: Weapon, id: string): boolean => w.profiles.some((p) => p.rules.some((r) => r.id === id));

/**
 * A temporary APL change this module owns. `expireActivationEffects` drops the marker effect
 * but never pops `aplMods`, so the pop is done in `onActivationEnd` (see `tempAplEngine`).
 */
function tempApl(
  state: GameState,
  op: OperativeState,
  delta: number,
  sourceId: string,
  sourceText: string,
): void {
  op.aplMods.push(delta);
  effect(state, {
    rule: TEMP_APL,
    source: { kind: 'ability', id: sourceId },
    sourceText,
    operativeId: op.id,
    player: op.player,
    data: { delta },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
}

/** Pops the `aplMods` entry a `tempApl` pushed, at the end of that operative's activation. */
function tempAplEngine(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onActivationEnd', T.bindText('sanctifiers.tempApl', 'Temporary APL changes end with the activation.', 40), (ev) => {
    const mine = effectsOn(ev.state, ev.operative.id, TEMP_APL);
    if (mine.length === 0) return;
    for (const e of mine) {
      const delta = Number(e.data?.['delta'] ?? 0);
      const at = ev.operative.aplMods.lastIndexOf(delta);
      if (at >= 0) ev.operative.aplMods.splice(at, 1);
    }
    dropEffects(ev.state, (e) => e.rule === TEMP_APL && e.operativeId === ev.operative.id);
  });
}

/** The free-action grant this rule made, once the operative is actually spending it. */
function spendingFreeAction(state: GameState, op: OperativeState, sourceId: string): boolean {
  const eff = effectOn(state, op.id, FREE_ACTION_RULE);
  if (!eff || eff.source.id !== sourceId) return false;
  return op.apSpent >= Number(eff.data?.['threshold'] ?? 0);
}

/**
 * "…can immediately perform a free Charge, Fall Back or Reposition action" — Fall Back costs
 * 2AP, and a granted free action is ONE AP outside the operative's APL budget
 * (docs/DECISIONS.md D-100), so the surcharge is removed while the grant is the AP being
 * spent. Without this the printed "free Fall Back" would be unpayable.
 *
 * Nothing in this module hands the AP back afterwards: it is not an APL stat change sitting
 * in `aplMods` but an effect the core expires with the activation it is spent in. A grant made
 * outside the recipient's activation — Lead the Procession, MIRACLE, RALLY THE FLOCK — simply
 * waits for that operative's next one, which is the model the free action is landed on.
 */
function freeActionCost(reg: HookRegistry, T: TeamHooks, sourceId: string, priority: number): void {
  reg.on('onActionCost', T.bindText(`${sourceId}.cost`, 'A free action costs no AP of the operative’s own.', priority), (ev) => {
    if (ev.operative.player !== T.player || ev.ap <= 1) return;
    const eff = effectOn(ev.state, ev.operative.id, FREE_ACTION_RULE);
    if (!eff || eff.source.id !== sourceId) return;
    const only = eff.data?.['only'] as string[] | undefined;
    if (only && !only.includes(ev.action)) return;
    if (ev.operative.apSpent < Number(eff.data?.['threshold'] ?? 0)) return;
    ev.ap = 1;
  });
}

// ---------------------------------------------------------------------------
// ORATOR + benefitting from the SERMON
// ---------------------------------------------------------------------------

/** "…that operative has the ORATOR keyword." */
export function isOrator(state: GameState, op: OperativeState): boolean {
  return state.effects.some((e) => e.rule === ORATOR_EFFECT && e.operativeId === op.id);
}

/** "…within 3" of a friendly ORATOR operative (or 6" if the ORATOR is a CONFESSOR)". */
function oratorRange(T: TeamHooks, orator: OperativeState): number {
  return orator.datacardId === CONFESSOR ? 6 : 3;
}

/** True for ANY operative inside a friendly ORATOR's preaching radius (ARDENT ERADICATION too). */
function withinOratorRange(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return T.friendlies(state).some((o) => isOrator(state, o) && T.gap(o, op) <= oratorRange(T, o) + 1e-6);
}

/**
 * "…option 'Ministorum flamer; gun butt; holy relic'" — the holy relic is NOT a weapon on the
 * datacard, so the scraper keeps it in `items[]` (the JSON's own `notes[]` records this) and
 * `SelectRoster` drops it. Both MISSIONARY rows offer exactly one brazier option and one holy
 * relic option, so the recorded loadout identifies it: a MISSIONARY without a Brazier of holy
 * fire is the one carrying the relic. Pinned by a test.
 */
function hasHolyRelic(state: GameState, op: OperativeState): boolean {
  if (op.datacardId !== MISSIONARY) return false;
  const store = state.opState['loadout'] as Record<string, string[]> | undefined;
  const loadout = store?.[op.id];
  if (!loadout || loadout.length === 0) return false;
  return !loadout.some((w) => w.trim().toLowerCase() === 'brazier of holy fire');
}

/** "Whenever this operative controls an objective marker, it's benefitting from the SERMON." */
function controlsObjective(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  for (const marker of Object.values(state.markers)) {
    if (marker.kind !== 'objective') continue;
    if (!markerContestedBy(T.ctx, state, marker, op)) continue;
    if (markerController(T.ctx, state, marker) === op.player) return true;
  }
  return false;
}

/** The whole "benefitting from the SERMON" predicate, including the two datacard shortcuts. */
function benefitting(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.mineKw(op, KW)) return false;
  if (withinOratorRange(T, state, op)) return true;
  // "…is activated within 3" … that friendly SANCTIFIER operative is benefitting from the
  //  SERMON until the end of that activation (i.e. even if it then moves more than …)."
  if (effectOn(state, op.id, SERMON_ACTIVATION)) return true;
  if (hasHolyRelic(state, op)) return true; // MISSIONARY › Holy Relic
  if (op.datacardId === PREACHER && controlsObjective(T, state, op)) return true; // PREACHER › Defend the Faith
  return false;
}

/** Public form for the UI and the tests. */
export function benefitsFromSermon(ctx: GameContext | undefined, state: GameState, op: OperativeState): boolean {
  return benefitting(makeTeamHooks(DATA, op.player, ctx), state, op);
}

// ---------------------------------------------------------------------------
// Blaze (faction rule + rare weapon rule)
// ---------------------------------------------------------------------------

/** "If you inflict damage with any critical successes…" (Devastating counts — it pays out on retained crits). */
function critDamage(ev: HookEvents['onStrikeResolved'], state: GameState): boolean {
  const dev = ruleOf(ev.ctx.rules, 'Devastating');
  const devastating = dev !== undefined && (dev.x ?? 0) > 0;
  const seq = shootSeq(state);
  if (seq) {
    const retainedCrits = seq.attack.dice.filter((d) => d.state === 'crit' || d.state === 'blocked').length;
    if (devastating && retainedCrits > 0) return true;
    return ev.crit && ev.ctx.profile.dmgC > 0;
  }
  if (!ev.crit) return false;
  return ev.ctx.profile.dmgC > 0 || devastating;
}

const dropToken = (state: GameState, operativeId: string, token: string, player: PlayerId): void => {
  dropEffects(state, (e) => e.rule === token && e.operativeId === operativeId && e.player === player);
};

function blaze(reg: HookRegistry, T: TeamHooks): void {
  // "*Blaze: If you inflict damage with any critical successes, the operative this weapon is
  //  being used against gains one of your Blaze tokens (if it doesn't already have one)."
  reg.on('onStrikeResolved', T.bind(R_BLAZE, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Blaze')) return;
    if (!critDamage(ev, ev.state)) return;
    giveToken(ev.state, ev.struck, BLAZE_TOKEN, {
      sourceId: R_BLAZE,
      sourceText: shortQuote(text(R_BLAZE)),
      player: T.player,
    });
  });

  // "Whenever an operative that has one of your Blaze tokens is activated, inflict D3 damage
  //  on it. Then that operative's controlling player selects one of the following: …"
  reg.on('onActivationStart', T.bind(R_BLAZE, 13), (ev) => {
    if (!hasToken(ev.state, ev.operative.id, BLAZE_TOKEN, T.player)) return;
    if (!T.ctx) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'blaze', [d3], T.player, `Blaze D3 vs ${ev.operative.letter}`);
    inflictDamage(T.ctx, ev.state, ev.operative, d3, 'other');
    if (ev.operative.incapacitated || ev.operative.removed) return;
    ev.state.pending.push({
      id: `blaze-${ev.state.seq++}`,
      who: ev.operative.player,
      kind: BLAZE_DECISION,
      prompt: `${ev.operative.letter} is ablaze — choose how to remove the Blaze token`,
      sourceText: shortQuote(text(R_BLAZE)),
      ctx: { operativeId: ev.operative.id, owner: T.player },
      options: [
        { id: 'roll', label: 'Roll one D6: on a 3+, remove that token' },
        { id: 'apl', label: 'Subtract 1 from its APL stat until the end of this activation to remove that token' },
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// Ministorum Sermon (faction rule; a STRATEGIC GAMBIT of its own)
// ---------------------------------------------------------------------------

function sermon(reg: HookRegistry, T: TeamHooks): void {
  // "STRATEGIC GAMBIT. Select one friendly SANCTIFIER operative. If a friendly CONFESSOR
  //  operative hasn't been incapacitated, you must select it."
  reg.on('onPloyUsed', T.bind(R_SERMON, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SERMON_GAMBIT) return;
    const friends = T.friendlies(ev.state, KW);
    const confessor = friends.find((o) => o.datacardId === CONFESSOR);
    const chosen = confessor ?? chosenOperative(ev.state, ev.data, friends);
    if (!chosen) return;
    // "Until you use this STRATEGIC GAMBIT again during the battle" — one ORATOR at a time.
    dropEffects(ev.state, (e) => e.rule === ORATOR_EFFECT && e.player === T.player);
    effect(ev.state, {
      rule: ORATOR_EFFECT,
      source: { kind: 'ability', id: R_SERMON },
      sourceText: shortQuote(text(R_SERMON)),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Ministorum Sermon: ${chosen.letter} is the ORATOR` });
  });

  // "Whenever a friendly SANCTIFIER operative is ACTIVATED within 3" … that friendly
  //  SANCTIFIER operative is benefitting from the SERMON until the end of that activation."
  reg.on('onActivationStart', T.bind(R_SERMON, 11), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!withinOratorRange(T, ev.state, ev.operative)) return;
    if (effectOn(ev.state, ev.operative.id, SERMON_ACTIVATION)) return;
    effect(ev.state, {
      rule: SERMON_ACTIVATION,
      source: { kind: 'ability', id: R_SERMON },
      sourceText: shortQuote(text(R_SERMON)),
      operativeId: ev.operative.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
  });

  // "Whenever a friendly SANCTIFIER operative is benefitting from the SERMON, Normal and
  //  Critical Dmg of 4 or more inflicts 1 less damage on it."
  reg.on('onDamage', T.bind(R_SERMON, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!benefitting(T, ev.state, ev.target)) return;
    const cut = sermonCut(T, ev.state, ev.amount);
    if (cut > 0) ev.amount = Math.max(0, ev.amount - cut);
  });
}

/**
 * How much the SERMON takes off one `inflictDamage` call. A shoot sequence inflicts every
 * unblocked die's damage in ONE call, so the reduction is per die whose Dmg stat is 4+; a
 * fight resolves one die at a time, where the amount IS the Dmg stat.
 */
function sermonCut(T: TeamHooks, state: GameState, amount: number): number {
  const cur = currentProfile(T, state);
  const seq = shootSeq(state);
  if (cur && seq) {
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
    if (crits * cur.profile.dmgC + normals * cur.profile.dmgN === amount) {
      return (cur.profile.dmgC >= 4 ? crits : 0) + (cur.profile.dmgN >= 4 ? normals : 0);
    }
  }
  return amount >= 4 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CONFESSOR
// ---------------------------------------------------------------------------

function confessor(reg: HookRegistry, T: TeamHooks): void {
  // ---- Lead the Procession ----------------------------------------------
  // "In each turning point after the first, whenever this operative is an ORATOR and performs
  //  the Charge, Fall Back or Reposition action during its activation … each of those friendly
  //  SANCTIFIER operatives can immediately perform a free Charge, Fall Back or Reposition
  //  action … but each cannot move more than … 3"."
  //
  // Nothing runs at the end of an ACTION, so the grants are made when the CONFESSOR's
  // activation ends, and each is one AP outside the recipient's APL budget (docs/DECISIONS.md
  // D-100) on its own next activation.
  reg.on('onActivationEnd', T.bind(A_LEAD, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CONFESSOR) return;
    if (ev.state.turningPoint < 2) return; // "In each turning point after the first"
    if (!isOrator(ev.state, op)) return;
    if (!op.actionsThisActivation.some((a) => a === 'Charge' || a === 'Fall Back' || a === 'Reposition')) return;
    for (const friend of T.friendlies(ev.state, KW)) {
      if (friend.id === op.id) continue; // "each OTHER friendly SANCTIFIER operative"
      if (!benefitting(T, ev.state, friend)) continue;
      if (!eitherVisible(T, ev.state, op, friend)) continue;
      if (effectOn(ev.state, friend.id, FREE_ACTION_RULE)) continue;
      grantFreeAction(ev.state, friend, {
        sourceId: A_LEAD,
        sourceText: shortQuote(abilityText(CONFESSOR, A_LEAD)),
        threshold: currentApl(T, ev.state, friend),
        kind: 'ability',
        only: ['Charge', 'Fall Back', 'Reposition'],
      });
    }
  });
  reg.on('onMoveDistance', T.bind(A_LEAD, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!spendingFreeAction(ev.state, ev.operative, A_LEAD)) return;
    ev.inches = Math.min(ev.inches, 3); // "cannot move more than … 3""
  });
  freeActionCost(reg, T, A_LEAD, 14);

  // ---- Commanding Declamation -------------------------------------------
  // "Whenever an enemy operative would perform an action during an activation … while visible
  //  to and within 6" of this operative, you can use this rule. If you do, roll one D6: if the
  //  result is higher than that enemy operative's APL stat: it cannot perform that action
  //  during that activation … You cannot use this rule again during the battle."
  //
  // `canPerformAction` is a pure query the AI runs for every candidate action, so the D6
  // cannot be rolled there (it would burn RNG outside the reducer — the Legionary Daemonic
  // Aura precedent). The roll is made when the enemy activates, and losing one action is
  // modelled as −1 APL for that activation, the VISION OF MADNESS / VOX SCREAM substitution.
  reg.on('onActivationStart', T.bind(A_DECLAMATION, 14), (ev) => {
    const enemy = ev.operative;
    if (enemy.player === T.player || !T.ctx) return;
    if (usedThisBattle(ev.state, `sanctifiers.declamation:${T.player}`)) return;
    const speaker = T.friendlies(ev.state).find(
      (o) => o.datacardId === CONFESSOR && T.gap(o, enemy) <= 6 + 1e-6 && visible(T, ev.state, o, enemy),
    );
    if (!speaker) return;
    useOncePerBattle(ev.state, `sanctifiers.declamation:${T.player}`);
    const roll = T.ctx.rng.d6();
    const apl = aplOf(T.ctx, ev.state, enemy);
    recordRoll(ev.state, 'commandingDeclamation', [roll], T.player, `vs ${enemy.letter} (APL ${apl})`);
    if (roll <= apl) {
      log(ev.state, { kind: 'action', player: T.player, text: `Commanding Declamation: ${roll} vs APL ${apl} — no effect` });
      return;
    }
    tempApl(ev.state, enemy, -1, A_DECLAMATION, shortQuote(abilityText(CONFESSOR, A_DECLAMATION)));
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Commanding Declamation: ${enemy.letter} loses one action this activation`,
    });
  });
}

// ---------------------------------------------------------------------------
// CHERUB
// ---------------------------------------------------------------------------

const CHERUB_ALLOWED_ACTIONS = new Set([ACT_INCENTIVISE, FLY_REPOSITION, FLY_FALL_BACK, FLY_CHARGE]);

function cherub(reg: HookRegistry, T: TeamHooks): void {
  // "Whenever determining control of an objective marker, treat this operative's APL stat as 1
  //  lower. Note this isn't a change to its APL stat, so any changes are cumulative with this."
  reg.on('onMarkerControl', T.bind(A_CHERUB, 12), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker || marker.kind !== 'objective') return;
    for (const c of T.friendlies(ev.state)) {
      if (c.datacardId !== CHERUB) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, c)) continue;
      ev.aplByPlayer[T.player] = Math.max(0, ev.aplByPlayer[T.player] - 1);
    }
  });

  // "Whenever this operative has a Conceal order and is in cover, it cannot be selected as a
  //  valid target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except
  //  being within 2"."  `onValidTarget` is emitted before cover is computed, so cover is
  //  determined here with Seek and the Vantage light-cover denial deliberately switched off.
  //  Priority 45 so it runs after any rule that would have made the CHERUB targetable.
  reg.on('onValidTarget', T.bind(A_CHERUB, 45), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== CHERUB) return;
    if (target.order !== 'conceal' || !T.ctx) return;
    if (T.gap(ev.attacker, target) <= 2 + 1e-6) return; // "except being within 2""
    const index = terrain(T.ctx, ev.state);
    const a = body(T.ctx, ev.attacker);
    const t = body(T.ctx, target);
    if (!coverAndObscured(index, a, t, { ignore: vantageIgnoreFilter(index, a, t) }).inCover) return;
    ev.valid = false;
    ev.reason = 'CHERUB: it has a Conceal order and is in cover';
  });

  // "This operative cannot … perform unique actions other than Incentivise." (Its own FLY
  //  moves are a datacard ability, not a unique action, so they stay available.)
  reg.on('canPerformAction', T.bind(A_CHERUB, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CHERUB) return;
    if (CHERUB_ALLOWED_ACTIONS.has(ev.action)) return;
    if (getAction(ev.action)?.type !== 'unique') return;
    ev.allowed = false;
    ev.reason = 'this operative cannot perform unique actions other than Incentivise';
  });
}

// ---------------------------------------------------------------------------
// CONFLAGRATOR
// ---------------------------------------------------------------------------

function conflagrator(reg: HookRegistry, T: TeamHooks): void {
  // Twin Torrent (rare weapon rule): "Select up to two different valid targets that aren't
  // within control range of friendly operatives. Shoot with this weapon against both of them
  // in an order of your choice (roll each sequence separately)."
  //
  // Torrent 0" leaves the sequence with an empty secondary queue, so the second target is
  // pushed onto it: the engine then rolls a fresh attack and defence pool for it, which is the
  // "roll each sequence separately" the rule asks for. Which second target is the player's
  // choice; the lowest-id valid one is the deterministic default (D-016).
  reg.on('onCollectAttackDice', T.bind(A_TWIN_TORRENT, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'TwinTorrent')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.secondary || seq.queue.length > 0 || seq.resolvedTargets.length > 0) return;
    const attacker = ev.ctx.attacker;
    const second = validTargets(T.ctx, ev.state, attacker, seq.weaponName, seq.profileName)
      .map((r) => r.target)
      .filter((o) => o.id !== seq.targetId)
      .filter(
        (o) =>
          !aliveOperatives(ev.state, T.player).some((f) => f.id !== attacker.id && inControlRange(T.ctx!, ev.state, f, o)),
      )
      .sort(byId)[0];
    if (!second) return;
    seq.queue.push(second.id);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Twin Torrent: ${attacker.letter} also shoots ${second.letter}`,
    });
  });
  // The engine's secondary targets inherit the primary's cover/obscured (Blast/Torrent), but
  // a Twin Torrent target is a valid target in its own right — "roll each sequence
  // separately" — so its cover and obscured are re-determined before its dice are rolled.
  reg.on('onCollectAttackDice', T.bind(A_TWIN_TORRENT, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'TwinTorrent')) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.secondary) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target) return;
    const check = checkTarget(T.ctx, ev.state, ev.ctx.attacker, target, ev.ctx.profile, ev.ctx.rules);
    // A tie between cover and obscured defaults to obscured (docs/DECISIONS.md D-012).
    seq.obscured = check.obscured;
    seq.inCover = check.inCover && !(check.mustChoose && check.obscured);
  });

  // Sanctification Rack: "This operative can perform the Sanctification Orb action (see faction
  // equipment). Doing so in this manner doesn't count towards the once per turning point
  // limit." — both halves are the SANCTIFICATION ORB ActionDef's own `available` and `check`
  // (no hook: registering an inert handler here would be the silent no-op the architecture
  // forbids).
}

// ---------------------------------------------------------------------------
// DEATH CULT ASSASSIN
// ---------------------------------------------------------------------------

function deathCultAssassin(reg: HookRegistry, T: TeamHooks): void {
  // "Whenever this operative is fighting or retaliating, you can resolve one of your successes
  //  before the normal order."  The fight sequence alternates from `seq.turn`, so a retaliating
  //  DEATH CULT ASSASSIN is moved to the front. Its second sentence ("that success must be used
  //  to block") cannot be enforced — the engine builds the strike/block options.
  reg.on('onCollectAttackDice', T.bind(A_BLADED_STANCE, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    if (ev.ctx.attacker.datacardId !== DEATH_CULT_ASSASSIN || ev.ctx.attacker.player !== T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== ev.ctx.attacker.id) return;
    seq.turn = 'defender';
  });
}

// ---------------------------------------------------------------------------
// DRILL ABBOT
// ---------------------------------------------------------------------------

function drillAbbot(reg: HookRegistry, T: TeamHooks): void {
  // "Whenever a friendly SANCTIFIER operative is within 6" of this operative, you can ignore
  //  any changes to that operative's stats from being injured (including its weapons' stats)."
  //  `moveOf` subtracts 2" and `hitOf` worsens Hit by 1; both consult `statMods`.
  reg.on('onStatMod', T.bind(A_DISCIPLINARIAN, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    const c = T.card(ev.operative);
    if (!c || ev.operative.wounds >= c.wounds / 2) return; // not injured
    if (!T.friendlies(ev.state).some((o) => o.datacardId === DRILL_ABBOT && T.gap(o, ev.operative) <= 6 + 1e-6)) return;
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });

  // "Whenever an enemy operative is within 4" of this operative, that enemy operative's APL
  //  stat cannot be added to (remove all positive APL stat changes it has)."
  reg.on('onStatMod', T.bind(A_NULL_SKULL, 13), (ev) => {
    if (ev.operative.player === T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === DRILL_ABBOT && T.gap(o, ev.operative) <= 4 + 1e-6)) return;
    const positives = ev.operative.aplMods.filter((m) => m > 0).reduce((a, b) => a + b, 0);
    if (positives > 0) ev.mods.apl -= positives;
    if (ev.mods.apl > 0) ev.mods.apl = 0;
  });
}

// ---------------------------------------------------------------------------
// PERSECUTOR
// ---------------------------------------------------------------------------

function persecutor(reg: HookRegistry, T: TeamHooks): void {
  // "The first time this operative performs the Fight action during each of its activations …
  //  this operative can immediately perform a free Fight action afterwards, but you cannot
  //  select any other enemy operative to fight against during that action … This takes
  //  precedence over action restrictions."
  //
  // The grant is made as the first Fight collects its dice (the last moment the engine tells a
  // team rule which enemy is in the sequence); every "if neither … is incapacitated" condition
  // is re-checked in `Fight (Merciless Castigation)`'s own `check` (D-026).
  reg.on('onCollectAttackDice', T.bind(A_MERCILESS, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.ctx.attacker.player !== T.player) return;
    const op = ev.ctx.attacker;
    if (op.datacardId !== PERSECUTOR) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== op.id) return; // "performs the Fight action", not retaliating
    if (op.actionsThisActivation.includes('Fight') || op.actionsThisActivation.includes(MERCILESS_FIGHT)) return;
    if (effectOn(ev.state, op.id, FREE_ACTION_RULE)) return;
    effect(ev.state, {
      rule: MERCILESS_TARGET,
      source: { kind: 'ability', id: A_MERCILESS },
      sourceText: shortQuote(abilityText(PERSECUTOR, A_MERCILESS)),
      operativeId: op.id,
      player: T.player,
      data: { targetId: seq.defenderId },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    grantFreeAction(ev.state, op, {
      sourceId: A_MERCILESS,
      sourceText: shortQuote(abilityText(PERSECUTOR, A_MERCILESS)),
      threshold: currentApl(T, ev.state, op),
      kind: 'ability',
      only: [MERCILESS_FIGHT],
    });
  });

  // "If this operative is incapacitated during the Fight action, you can strike the enemy
  //  operative in that sequence with one of your unresolved successes before this operative is
  //  removed from the killzone."  Free, so it is always taken (D-022).
  reg.on('onIncapacitated', T.bind(A_FANATICAL, 13), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== PERSECUTOR || ev.prevented || !T.ctx) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const pool = seq.attackerId === op.id ? seq.attackerPool : seq.defenderPool;
    const die = successes(pool)[0];
    const foe = ev.state.operatives[seq.attackerId === op.id ? seq.defenderId : seq.attackerId];
    if (!die || !foe) return;
    const profile = fightProfileOf(T, ev.state, op);
    const dmg = die.state === 'crit' ? (profile?.dmgC ?? 0) : (profile?.dmgN ?? 0);
    die.state = 'struck';
    log(ev.state, { kind: 'action', player: T.player, text: `Fanatical Retribution: ${op.letter} strikes for ${dmg}` });
    inflictDamage(T.ctx, ev.state, foe, dmg, 'attack');
  });
}

// ---------------------------------------------------------------------------
// MIRACULIST
// ---------------------------------------------------------------------------

const wreathedArmed = (state: GameState, opId: string): boolean => Boolean(bucket(state, WREATHED_ARMED)[opId]);

function miraculist(reg: HookRegistry, T: TeamHooks): void {
  // Wreathed (rare weapon rule) is used ONLY through its own action ("Don't select a valid
  // target"), so the weapon is hidden from the universal Shoot until that action arms it —
  // otherwise the shooter would pick a normal target with it and every clause would be wrong.
  reg.on('availableWeapons', T.bind(A_WREATHED, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const c = T.card(ev.operative);
    if (!c) return;
    const wreathed = c.weapons.filter((w) => hasRuleNamed(w, 'Wreathed')).map((w) => w.name);
    if (wreathed.length === 0 || wreathedArmed(ev.state, ev.operative.id)) return;
    ev.weapons = ev.weapons.filter((n) => !wreathed.includes(n));
  });
  reg.on('onActivationEnd', T.bindText(`${A_WREATHED}.disarm`, 'Wreathed weapons are used only through their own action.', 43), (ev) => {
    if (ev.operative.player !== T.player) return;
    delete bucket(ev.state, WREATHED_ARMED)[ev.operative.id];
  });

  // "The first time this operative would be incapacitated during the battle, it's not
  //  incapacitated, has 1 wound remaining and cannot be incapacitated for the remainder of the
  //  action. All remaining attack dice are discarded (including yours if this operative is
  //  fighting or retaliating), then this operative can immediately perform a free Dash or Fall
  //  Back action (for the latter, it cannot move more than 3")."
  reg.on('onIncapacitated', T.bind(A_MIRACLE, 11), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== MIRACULIST) return;
    const shield = effectOn(ev.state, op.id, MIRACLE_SHIELD);
    if (shield && shield.data?.['stamp'] === sequenceStamp(ev.state)) {
      ev.prevented = true; // "cannot be incapacitated for the remainder of the action"
      return;
    }
    if (ev.prevented) return;
    if (!useOncePerBattle(ev.state, `sanctifiers.miracle:${op.id}`)) return;
    ev.prevented = true; // `inflictDamage` restores it to 1 wound
    effect(ev.state, {
      rule: MIRACLE_SHIELD,
      source: { kind: 'ability', id: A_MIRACLE },
      sourceText: shortQuote(abilityText(MIRACULIST, A_MIRACLE)),
      operativeId: op.id,
      player: T.player,
      data: { stamp: sequenceStamp(ev.state) },
      // The shield covers exactly the action that would have incapacitated it; it dies with
      // the acting operative's activation so it can never leak into a later one.
      expiry: { kind: 'endOfActivation', operativeId: ev.state.activeOperativeId ?? op.id },
    });
    discardRemainingDice(ev.state, op);
    grantFreeAction(ev.state, op, {
      sourceId: A_MIRACLE,
      sourceText: shortQuote(abilityText(MIRACULIST, A_MIRACLE)),
      threshold: currentApl(T, ev.state, op),
      kind: 'ability',
      only: ['Dash', 'Fall Back'],
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Miracle: ${op.letter} survives with 1 wound` });
  });
  reg.on('onMoveDistance', T.bind(A_MIRACLE, 13), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player !== T.player) return;
    if (!spendingFreeAction(ev.state, ev.operative, A_MIRACLE)) return;
    ev.inches = Math.min(ev.inches, 3); // "for the latter, it cannot move more than 3""
  });
  freeActionCost(reg, T, A_MIRACLE, 14);
}

/**
 * Which shoot/fight ACTION is in flight, so MIRACLE's shield covers exactly that one. A shoot
 * is stamped by attacker + weapon rather than by target, so Blast/Torrent secondaries of the
 * same action share it.
 */
function sequenceStamp(state: GameState): string {
  const seq = state.sequence;
  if (!seq) return `none:${state.seq}`;
  return seq.kind === 'shoot'
    ? `shoot:${seq.attackerId}:${seq.weaponName}:${seq.profileName ?? ''}`
    : `fight:${seq.attackerId}:${seq.defenderId}`;
}

/** "All remaining attack dice are discarded (including yours if this operative is fighting…)". */
function discardRemainingDice(state: GameState, op: OperativeState): void {
  const seq = state.sequence;
  if (!seq) return;
  const pools = seq.kind === 'shoot' ? [seq.attack] : [seq.attackerPool, seq.defenderPool];
  for (const pool of pools) {
    for (const die of pool.dice) {
      if (die.state === 'crit' || die.state === 'normal') die.state = 'discarded';
    }
  }
  if (seq.kind === 'fight') seq.step = 'done';
  log(state, { kind: 'dice', player: op.player, text: 'Miracle: all remaining attack dice are discarded' });
}

// ---------------------------------------------------------------------------
// MISSIONARY / PREACHER / RELIQUANT / SALVATIONIST
// ---------------------------------------------------------------------------

function otherCards(reg: HookRegistry, T: TeamHooks): void {
  // MISSIONARY › Spread the Word of the God-Emperor: "Whenever this operative is more than 6"
  // from other friendly operatives, its weapons have the Severe weapon rule."
  reg.on('onWeaponRules', T.bind(A_SPREAD_THE_WORD, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== MISSIONARY) return;
    if (T.friendlies(ev.state).some((o) => o.id !== op.id && T.gap(o, op) <= 6 + 1e-6)) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Spread the Word of the God-Emperor)'));
  });

  // MISSIONARY › Holy Relic ("If this operative has a holy relic, it's always benefitting from
  // the SERMON") and PREACHER › Defend the Faith ("Whenever this operative controls an
  // objective marker, it's benefitting from the SERMON") are branches of `benefitting()`
  // above — they change no hook of their own, so none is registered here.

  // RELIQUANT › Cult Icon: "Whenever determining control of a marker within 4" of this
  // operative, treat the total APL stat of friendly SANCTIFIER operatives that contest it as 1
  // higher if at least one friendly SANCTIFIER operative contests that marker."
  reg.on('onMarkerControl', T.bind(A_CULT_ICON, 13), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const reliquant = T.friendlies(ev.state).find(
      (o) => o.datacardId === RELIQUANT && T.markerGap(o, marker) <= 4 + 1e-6,
    );
    if (!reliquant) return;
    if (!T.friendlies(ev.state, KW).some((o) => markerContestedBy(T.ctx!, ev.state, marker, o))) return;
    ev.aplByPlayer[T.player] += 1;
  });

  // SALVATIONIST › Conversion Field: "Whenever an operative more than 6" from this operative is
  // shooting a friendly SANCTIFIER operative within 6" of this operative, improve that friendly
  // operative's Save stat by 1."
  reg.on('onDefenceDice', T.bind(A_CONVERSION_FIELD, 12), (ev) => {
    const target = ev.ctx.defender;
    if (ev.ctx.type !== 'ranged' || !target || !T.mineKw(target, KW)) return;
    const salvationist = T.friendlies(ev.state).find(
      (o) => o.datacardId === SALVATIONIST && T.gap(o, target) <= 6 + 1e-6 && T.gap(o, ev.ctx.attacker) > 6 + 1e-6,
    );
    if (!salvationist) return;
    ev.mods.save += 1;
  });
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  blaze(reg, T);
  sermon(reg, T);
  confessor(reg, T);
  cherub(reg, T);
  conflagrator(reg, T);
  deathCultAssassin(reg, T);
  drillAbbot(reg, T);
  persecutor(reg, T);
  miraculist(reg, T);
  otherCards(reg, T);
  tempAplEngine(reg, T);
}

// ---------------------------------------------------------------------------
// Decisions this team owns
// ---------------------------------------------------------------------------

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== BLAZE_DECISION) return false;
  const payload = { ...(decision.ctx ?? {}), ...(data ?? {}) };
  const op = state.operatives[String(payload['operativeId'] ?? '')];
  const owner = String(payload['owner'] ?? 'p1') as PlayerId;
  if (!op || op.removed) return true;
  if (optionId === 'apl') {
    // "Subtract 1 from the operative's APL stat until the end of that activation to remove that token."
    tempApl(state, op, -1, R_BLAZE, shortQuote(text(R_BLAZE)));
    dropToken(state, op.id, BLAZE_TOKEN, owner);
    log(state, { kind: 'decision', player: op.player, text: `${op.letter} smothers the Blaze token (−1 APL)` });
    return true;
  }
  // "Roll one D6: on a 3+, remove that token."
  const roll = ctx.rng.d6();
  recordRoll(state, 'blaze', [roll], op.player, `Blaze removal 3+ (${op.letter})`);
  if (roll >= 3) {
    dropToken(state, op.id, BLAZE_TOKEN, owner);
    log(state, { kind: 'decision', player: op.player, text: `${op.letter} puts out the Blaze token (${roll})` });
  } else {
    log(state, { kind: 'decision', player: op.player, text: `${op.letter} is still ablaze (${roll})` });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- THE EMPEROR PROTECTS (strategy) ----------------------------------
  // "Whenever an operative is shooting a friendly SANCTIFIER operative that's benefitting from
  //  the SERMON, you can re-roll any of your defence dice results of one result."
  reg.on('onDefenceDice', T.bind(SP_EMPEROR_PROTECTS, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_EMPEROR_PROTECTS)) return;
    const target = ev.ctx.defender;
    if (!target || !benefitting(T, ev.state, target)) return;
    ev.rerolls.push({
      id: 'sanctifiers.theEmperorProtects',
      label: 'The Emperor Protects: re-roll any of your defence dice results of one result',
      mode: 'value',
      player: T.player,
      sourceText: shortQuote(text(SP_EMPEROR_PROTECTS)),
    });
  });

  // ---- FERVENT BRAWL (strategy) -----------------------------------------
  // "Whenever a friendly SANCTIFIER operative that's benefitting from the SERMON is fighting or
  //  retaliating, its melee weapons have the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bind(SP_FERVENT_BRAWL, 20), (ev) => {
    if (ev.type !== 'melee') return;
    if (!gambitUsed(ev.state, T.player, SP_FERVENT_BRAWL)) return;
    if (!benefitting(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Fervent Brawl)'));
  });

  // ---- ZEALOUS PERSECUTION (strategy) -----------------------------------
  // "Whenever a friendly SANCTIFIER operative is FIGHTING during an activation in which it
  //  performed the Charge action, its melee weapons have the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind(SP_ZEALOUS_PERSECUTION, 20), (ev) => {
    if (ev.type !== 'melee' || ev.retaliating) return; // "is fighting", not retaliating
    if (!gambitUsed(ev.state, T.player, SP_ZEALOUS_PERSECUTION)) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Zealous Persecution)'));
  });

  // ---- RALLY THE FLOCK (strategy) ---------------------------------------
  // "Each friendly SANCTIFIER operative (excluding ORATOR) that's benefitting from the SERMON
  //  can immediately perform a free Dash or Fall Back action … (for the latter, it cannot move
  //  more than 3")."  Its "must end that move closer and visible to a friendly ORATOR" clause
  //  has no seam — no hook constrains where a move ends.
  reg.on('onPloyUsed', T.bind(SP_RALLY_THE_FLOCK, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP_RALLY_THE_FLOCK) return;
    for (const op of T.friendlies(ev.state, KW)) {
      if (isOrator(ev.state, op)) continue; // "(excluding ORATOR)"
      if (!benefitting(T, ev.state, op)) continue;
      if (effectOn(ev.state, op.id, FREE_ACTION_RULE)) continue;
      grantFreeAction(ev.state, op, {
        sourceId: SP_RALLY_THE_FLOCK,
        sourceText: shortQuote(text(SP_RALLY_THE_FLOCK)),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash', 'Fall Back'],
      });
    }
  });
  reg.on('onMoveDistance', T.bind(SP_RALLY_THE_FLOCK, 21), (ev) => {
    if (ev.action !== 'Fall Back' || ev.operative.player !== T.player) return;
    if (!spendingFreeAction(ev.state, ev.operative, SP_RALLY_THE_FLOCK)) return;
    ev.inches = Math.min(ev.inches, 3);
  });
  freeActionCost(reg, T, SP_RALLY_THE_FLOCK, 22);

  // ---- ROSARIUS (firefight) ---------------------------------------------
  // "Use this firefight ploy when an attack dice inflicts Normal Dmg on a friendly SANCTIFIER
  //  operative. Ignore that inflicted damage."  One attack dice per use of the ploy.
  reg.on('onDamage', T.bind(FP_ROSARIUS, 25), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (!ployUsed(ev.state, T.player, FP_ROSARIUS)) return;
    if (!T.mineKw(ev.target, KW)) return;
    const cur = currentProfile(T, ev.state);
    const dmgN = cur?.profile.dmgN ?? 0;
    if (dmgN <= 0) return;
    // The SERMON handler (priority 12) has already taken 1 off each 4+ die.
    const perDie = dmgN - (dmgN >= 4 && benefitting(T, ev.state, ev.target) ? 1 : 0);
    if (perDie <= 0 || ev.amount < perDie) return;
    if (!useOncePerTP(ev.state, `sanctifiers.rosarius:${T.player}`)) return;
    ev.amount -= perDie;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Rosarius: ${ev.target.letter} ignores ${perDie} damage` });
  });

  // ---- ARDENT ERADICATION (firefight) -----------------------------------
  // "…if it's shooting against or fighting against an enemy operative that's within 3" of a
  //  friendly ORATOR operative (or 6" if the ORATOR is a CONFESSOR). You can re-roll any of
  //  your attack dice."  `fight.ts` emits no post-roll hook (D-031), so only the shooting half
  //  is reachable.
  reg.on('onRollAttack', T.bind(FP_ARDENT_ERADICATION, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP_ARDENT_ERADICATION)) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    if (!foe || !withinOratorRange(T, ev.state, foe)) return;
    ev.rerolls.push({
      id: 'sanctifiers.ardentEradication',
      label: 'Ardent Eradication: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(text(FP_ARDENT_ERADICATION)),
    });
  });

  // ---- REDEEMED THROUGH FIRE (firefight) --------------------------------
  // "…when a friendly SANCTIFIER operative that has a weapon with the Blaze weapon rule is
  //  incapacitated, before it's removed from the killzone. Each enemy operative visible to and
  //  within 2" of it gains one of your Blaze tokens (if it doesn't already have one)."
  reg.on('onIncapacitated', T.bind(FP_REDEEMED_THROUGH_FIRE, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP_REDEEMED_THROUGH_FIRE)) return;
    if (!T.mineKw(ev.operative, KW) || ev.prevented) return;
    if (!carriedWeapons(T, ev.state, ev.operative).some((w) => hasRuleNamed(w, 'Blaze'))) return;
    if (!useOncePerTP(ev.state, `sanctifiers.redeemed:${T.player}`)) return;
    for (const enemy of T.enemies(ev.state)) {
      if (T.gap(ev.operative, enemy) > 2 + 1e-6) continue;
      if (!visible(T, ev.state, ev.operative, enemy)) continue;
      giveToken(ev.state, enemy, BLAZE_TOKEN, {
        sourceId: FP_REDEEMED_THROUGH_FIRE,
        sourceText: shortQuote(text(FP_REDEEMED_THROUGH_FIRE)),
        player: T.player,
      });
    }
  });

  // ---- UNWAVERING DEVOTION (firefight) ----------------------------------
  // "…when a friendly SANCTIFIER ORATOR or SANCTIFIER MIRACULIST operative is selected as the
  //  valid target of a Shoot action … Select one other friendly SANCTIFIER operative (excluding
  //  CONFESSOR, MIRACULIST and ORATOR) visible to and within 3" of that first friendly operative
  //  to become the valid target … This ploy has no effect if it's the Shoot action and the
  //  ranged weapon has the Blast or Torrent weapon rule."
  //  The Fight half has no seam — only the Shoot step offers target substitution.
  reg.on('onSelectTarget', T.bind(FP_UNWAVERING_DEVOTION, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP_UNWAVERING_DEVOTION)) return;
    const first = ev.target;
    if (first.player !== T.player || !T.kw(first, KW)) return;
    if (!isOrator(ev.state, first) && first.datacardId !== MIRACULIST) return;
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (usedThisTP(ev.state, `sanctifiers.unwavering:${T.player}`)) return;
    const shield = T.friendlies(ev.state, KW)
      .filter(
        (o) =>
          o.id !== first.id &&
          o.datacardId !== CONFESSOR &&
          o.datacardId !== MIRACULIST &&
          !isOrator(ev.state, o) &&
          T.gap(o, first) <= 3 + 1e-6 &&
          eitherVisible(T, ev.state, o, first),
      )
      .sort(byId)[0];
    if (!shield) return;
    useOncePerTP(ev.state, `sanctifiers.unwavering:${T.player}`);
    ev.redirectTo = shield.id;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Unwavering Devotion: ${shield.letter} shields ${first.letter}`,
    });
  });
}

/**
 * The four strategy ploys plus the Ministorum Sermon, which is a STRATEGIC GAMBIT printed as a
 * faction rule rather than as one of the four ploys (so it costs 0CP).
 */
function gambits(reg: HookRegistry, T: TeamHooks): void {
  for (const ploy of T.data.strategyPloys) {
    reg.on('gambitOptions', T.bind(ploy.id, 20), (ev) => {
      if (ev.player !== T.player) return;
      if (ev.state.teams[T.player].cp < ploy.cp) return;
      // "You cannot use this ploy during the first turning point."
      if (ploy.id === SP_RALLY_THE_FLOCK && ev.state.turningPoint < 2) return;
      ev.options.push({ id: ploy.id, label: `${ploy.name} (${ploy.cp}CP)`, sourceText: shortQuote(ploy.text) });
    });
  }
  reg.on('gambitOptions', T.bind(R_SERMON, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (T.friendlies(ev.state, KW).length === 0) return;
    ev.options.push({ id: SERMON_GAMBIT, label: 'Ministorum Sermon', sourceText: shortQuote(text(R_SERMON)) });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- SANCTIFICATION ORBS ----------------------------------------------
  // "Whenever a friendly SANCTIFIER operative is shooting an operative that has one of your
  //  Doused tokens with a weapon that has the Blaze weapon rule, that weapon also has the Seek
  //  weapon rule."
  reg.on('onWeaponRules', T.bind(EQ_ORBS, 30), (ev) => {
    if (ev.type !== 'ranged' || !ev.target) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!hasToken(ev.state, ev.target.id, DOUSED_TOKEN, T.player)) return;
    if (!ev.rules.some((r) => r.id === 'Blaze')) return;
    ev.rules.push(ruleTag('Seek', undefined, 'Seek (Sanctification Orbs)'));
  });
  // "After a friendly SANCTIFIER operative uses a weapon that has the Blaze weapon rule against
  //  an enemy operative that has one of your Doused tokens, remove that token (even if the Seek
  //  weapon rule wasn't used)."
  reg.on('onStrikeResolved', T.bind(EQ_ORBS, 31), (ev) => {
    if (ev.ctx.attacker.player !== T.player || !T.mineKw(ev.ctx.attacker, KW)) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Blaze')) return;
    if (!hasToken(ev.state, ev.struck.id, DOUSED_TOKEN, T.player)) return;
    dropToken(ev.state, ev.struck.id, DOUSED_TOKEN, T.player);
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.struck.letter} loses its Doused token` });
  });

  // ---- PURITY SEALS ------------------------------------------------------
  // "Once per turning point, when a friendly SANCTIFIER operative is shooting or fighting, if
  //  you roll two or more fails, you can discard one of them to retain another as a normal
  //  success instead."  Offered as a `mode: 'fails'` re-roll grant (D-018); the fighting half
  //  is unreachable because `fight.ts` emits no post-roll hook (D-031).
  reg.on('onRollAttack', T.bind(EQ_PURITY_SEALS, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_PURITY_SEALS)) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    if (usedThisTP(ev.state, `sanctifiers.puritySeals:${T.player}`)) return;
    const seq = shootSeq(ev.state);
    const fails = seq ? seq.attack.dice.filter((d) => d.state === 'fail').length : 0;
    if (fails < 2) return; // "if you roll two or more fails"
    useOncePerTP(ev.state, `sanctifiers.puritySeals:${T.player}`);
    ev.rerolls.push({
      id: 'sanctifiers.puritySeals',
      label: 'Purity Seals: discard one fail to retain another as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(EQ_PURITY_SEALS)),
    });
  });

  // ---- ECCLESIARCHY TEXTS ------------------------------------------------
  // "In the Ready step of each Strategy phase, roll 3D6: if the result is less than the
  //  remaining wounds of a friendly ORATOR operative, you gain 1CP… if there isn't a valid
  //  ORATOR operative, you cannot use this rule during that turning point."
  reg.on('onReadyStep', T.bind(EQ_ECCLESIARCHY_TEXTS, 30), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!hasEquipment(ev.state, T.player, EQ_ECCLESIARCHY_TEXTS)) return;
    const orator = T.friendlies(ev.state).find((o) => isOrator(ev.state, o));
    if (!orator) return;
    const rolls = [T.ctx.rng.d6(), T.ctx.rng.d6(), T.ctx.rng.d6()];
    const total = rolls.reduce((a, b) => a + b, 0);
    recordRoll(ev.state, 'ecclesiarchyTexts', rolls, T.player, `3D6 vs ${orator.letter} (${orator.wounds} wounds)`);
    if (total < orator.wounds) {
      ev.cp += 1;
      log(ev.state, { kind: 'ploy', player: T.player, text: `Ecclesiarchy Texts: ${total} < ${orator.wounds} — gain 1CP` });
    }
  });

  // ---- IMPERIAL CULT SYMBOLS ---------------------------------------------
  // "Once per turning point, when an operative is shooting a friendly SANCTIFIER operative
  //  that's benefitting from the SERMON, when you collect your defence dice, you can use this
  //  rule. If you do, change one of the attacker's retained critical successes to a normal
  //  success (any weapon rules they've already resolved aren't affected, e.g. Piercing Crits)."
  //  Piercing has already been subtracted from the defence pool when this hook is emitted.
  reg.on('onDefenceDice', T.bind(EQ_CULT_SYMBOLS, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_CULT_SYMBOLS)) return;
    const target = ev.ctx.defender;
    if (!target || !benefitting(T, ev.state, target)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence') return; // "when you collect your defence dice"
    const crit = seq.attack.dice.find((d) => d.state === 'crit');
    if (!crit) return;
    if (!useOncePerTP(ev.state, `sanctifiers.cultSymbols:${T.player}`)) return;
    crit.state = 'normal';
    crit.note = 'Imperial Cult Symbols';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: 'Imperial Cult Symbols: one critical success becomes a normal success',
    });
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const ORB_EXCLUDED = new Set([CHERUB, DEATH_CULT_ASSASSIN, MIRACULIST]);

/** SUPPORT distance goes through `supportDistance` so a Comms Device widens it. */
function incentiviseTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosenId: string | undefined,
): OperativeState | undefined {
  const range = supportDistance(ctx, state, op, 2);
  const index = terrain(ctx, state);
  const eligible = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    // "(excluding CONFESSOR, DEATH CULT ASSASSIN, MIRACULIST and ORATOR)"
    .filter((o) => o.datacardId !== CONFESSOR && o.datacardId !== DEATH_CULT_ASSASSIN && o.datacardId !== MIRACULIST)
    .filter((o) => !isOrator(state, o))
    .filter(
      (o) =>
        baseGap(op.pos, card(ctx, op).base, op.rot, o.pos, card(ctx, o).base, o.rot) <= range + 1e-6 &&
        isVisible(index, body(ctx, op), body(ctx, o)).visible,
    )
    .sort(byId);
  return eligible.find((o) => o.id === chosenId) ?? eligible[0];
}

function medikitTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosenId: string | undefined,
): OperativeState | undefined {
  const eligible = aliveOperatives(state, op.player)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => inControlRange(ctx, state, op, o) || o.id === op.id)
    .sort(byId);
  return eligible.find((o) => o.id === chosenId) ?? eligible.find((o) => o.wounds < card(ctx, o).wounds) ?? eligible[0];
}

function orbTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  chosenId: string | undefined,
): OperativeState | undefined {
  const index = terrain(ctx, state);
  const eligible = aliveOperatives(state, otherPlayer(op.player))
    .filter(
      (o) =>
        baseGap(op.pos, card(ctx, op).base, op.rot, o.pos, card(ctx, o).base, o.rot) <= 6 + 1e-6 &&
        isVisible(index, body(ctx, op), body(ctx, o)).visible,
    )
    .sort(byId);
  return eligible.find((o) => o.id === chosenId) ?? eligible[0];
}

/** The Blast footprint of a Wreathed weapon, "determined from this operative". */
function wreathedTargets(ctx: GameContext, state: GameState, op: OperativeState, profile: WeaponProfile): OperativeState[] {
  const radius = profile.rules.find((r) => r.id === 'Blast')?.x ?? 0;
  const index = terrain(ctx, state);
  return aliveOperatives(state)
    .filter((o) => o.id !== op.id)
    .filter(
      (o) =>
        baseGap(op.pos, card(ctx, op).base, op.rot, o.pos, card(ctx, o).base, o.rot) <= radius + 1e-6 &&
        isVisible(index, body(ctx, op), body(ctx, o)).visible,
    )
    .sort(byId);
}

/**
 * The Wreathed weapon, read from the DATACARD (filtered by the recorded loadout): `weaponsOf`
 * hides it until the action arms it, and `check` must not mutate state.
 */
function wreathedWeapon(ctx: GameContext, state: GameState, op: OperativeState, wanted?: string): { weapon: Weapon; profile: WeaponProfile } | undefined {
  const store = state.opState['loadout'] as Record<string, string[]> | undefined;
  const loadout = store?.[op.id];
  for (const w of ctx.datacards.get(op.datacardId)?.weapons ?? []) {
    if (wanted && w.name !== wanted) continue;
    if (loadout && loadout.length > 0 && !loadout.some((n) => n.trim().toLowerCase() === w.name.trim().toLowerCase()))
      continue;
    const profile = w.profiles.find((p) => p.type === 'ranged' && p.rules.some((r) => r.id === 'Wreathed'));
    if (profile) return { weapon: w, profile };
  }
  return undefined;
}

/** "…remove it from the killzone and set it back up wholly within a distance equal to its Move stat horizontally". */
function flyDestination(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2 | undefined,
  mode: 'Reposition' | 'Fall Back' | 'Charge',
): { ok: boolean; reason?: string; pos?: Vec2; z?: number } {
  if (!pos) return { ok: false, reason: 'select a location to be set up in' };
  if (dist(op.pos, pos) < 0.01) return { ok: false, reason: 'select a different location to be set up in' };
  const c = card(ctx, op);
  const index = terrain(ctx, state);
  // "Note that it gains no additional distance when performing the Charge action." and, in a
  // close-quarters killzone, "this distance cannot be measured over or through Wall terrain".
  const max = moveOf(ctx, state, op);
  const travelled = state.map.closeQuarters ? wallRouteDistance(index, op.pos, pos) : dist(op.pos, pos);
  if (travelled > max + 1e-6) return { ok: false, reason: `it can only FLY up to ${max}"` };
  const r = baseRadius(c.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, c.base, op.rot)) return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, modelHeight(c)))
    return { ok: false, reason: 'it must be set up in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    if (basesOverlap(pos, c.base, op.rot, other.pos, card(ctx, other).base, other.rot))
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  const landed: Body = { id: op.id, pos, z, rot: op.rot, base: c.base, height: modelHeight(c) };
  const engagedThere = aliveOperatives(state, otherPlayer(op.player)).some((e) =>
    withinControlRange(index, landed, body(ctx, e)),
  );
  if (mode === 'Charge' && !engagedThere)
    return { ok: false, reason: 'a Charge must finish within control range of an enemy operative' };
  // "unless it's the Charge action, it cannot be set up within control range of an enemy operative"
  if (mode !== 'Charge' && engagedThere)
    return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
  return { ok: true, pos, z };
}

function flyAction(id: string, name: string, mode: 'Reposition' | 'Fall Back' | 'Charge', ap: number): ActionDef {
  return {
    id,
    name,
    ap,
    type: 'unique',
    treatedAs: mode,
    sourceText: abilityText(CHERUB, A_FLY),
    available: (_ctx, _state, op) => op.datacardId === CHERUB,
    check(ctx, state, op, params) {
      const engaged = aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e));
      const did = (a: string): boolean => op.actionsThisActivation.includes(a);
      if (mode === 'Reposition') {
        if (engaged) return { ok: false, reason: 'within control range of an enemy operative' };
        if (did('Fall Back') || did('Charge')) return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
      } else if (mode === 'Fall Back') {
        if (!engaged) return { ok: false, reason: 'no enemy operative within control range' };
        if (did('Reposition') || did('Charge')) return { ok: false, reason: 'already performed Reposition or Charge this activation' };
      } else {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
        if (engaged) return { ok: false, reason: 'already within control range of an enemy operative' };
        if (did('Reposition') || did('Dash') || did('Fall Back'))
          return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
      }
      const d = flyDestination(ctx, state, op, params.targetPos, mode);
      return d.ok ? { ok: true } : { ok: false, reason: d.reason ?? 'it cannot FLY there' };
    },
    perform(ctx, state, op, params) {
      const d = flyDestination(ctx, state, op, params.targetPos, mode);
      if (!d.ok || !d.pos) return { ok: false, reason: d.reason ?? 'it cannot FLY there' };
      op.pos = { ...d.pos };
      op.z = d.z ?? 0;
      op.onGuard = false;
      if (op.carryingMarkerId) {
        const m = state.markers[op.carryingMarkerId];
        if (m) {
          m.pos = { ...op.pos };
          m.z = op.z;
        }
      }
      if (mode === 'Charge') {
        op.stickyEngagedWith = aliveOperatives(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
      }
      log(state, { kind: 'action', player: op.player, text: `${op.letter} FLIES (${name})` });
      return { ok: true };
    },
  };
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- INCENTIVISE 1AP (SUPPORT) — CHERUB ------------------------------
    uniqueAction(data, CHERUB, ACT_INCENTIVISE, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return incentiviseTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly SANCTIFIER operative visible to and within 2"' };
      },
      perform: (ctx, state, op, params) => {
        const target = incentiviseTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'select one other friendly SANCTIFIER operative visible to and within 2"' };
        // "Until the end of that operative's next activation, add 1 to its APL stat."
        tempApl(state, target, 1, ACT_INCENTIVISE, shortQuote(actionText(CHERUB, ACT_INCENTIVISE)));
        log(state, { kind: 'action', player: op.player, text: `${op.letter} incentivises ${target.letter} (+1 APL)` });
        return { ok: true };
      },
    }),

    // ---- TRAINED ASSASSIN 1AP — DEATH CULT ASSASSIN ----------------------
    uniqueAction(data, DEATH_CULT_ASSASSIN, ACT_TRAINED_ASSASSIN, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op, params) => {
        // "Change this operative's order."
        const wanted = params.choice === 'engage' || params.choice === 'conceal' ? params.choice : undefined;
        op.order = wanted ?? (op.order === 'engage' ? 'conceal' : 'engage');
        log(state, { kind: 'action', player: op.player, text: `${op.letter} changes its order to ${op.order}` });
        return { ok: true };
      },
    }),

    // ---- MEDIKIT 1AP — SALVATIONIST --------------------------------------
    uniqueAction(data, SALVATIONIST, ACT_MEDIKIT, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return medikitTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly SANCTIFIER operative within this operative’s control range' };
      },
      perform: (ctx, state, op, params) => {
        const target = medikitTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'select one friendly SANCTIFIER operative within this operative’s control range' };
        // "…to regain up to 2D3 lost wounds."
        const rolls = [ctx.rng.d3(), ctx.rng.d3()];
        const heal = rolls[0]! + rolls[1]!;
        recordRoll(state, 'medikit', rolls, op.player, `MEDIKIT 2D3 on ${target.letter}`);
        target.wounds = Math.min(card(ctx, target).wounds, target.wounds + heal);
        log(state, { kind: 'action', player: op.player, text: `${op.letter} heals ${target.letter} for ${heal}` });
        return { ok: true };
      },
    }),

    // ---- SANCTIFICATION ORB 1AP (faction equipment) ----------------------
    {
      id: ACT_SANCTIFICATION_ORB,
      name: 'SANCTIFICATION ORB',
      ap: 1,
      type: 'unique',
      sourceText: `${text(EQ_ORBS)}\n\n${abilityText(CONFLAGRATOR, A_RACK)}`,
      available: (_ctx, state, op) =>
        !ORB_EXCLUDED.has(op.datacardId) &&
        op.datacardId.startsWith('sanctifiers.') &&
        (hasEquipment(state, op.player, EQ_ORBS) || op.datacardId === CONFLAGRATOR),
      check(ctx, state, op, params) {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        // "Once per turning point, one friendly SANCTIFIER operative … can perform the following
        //  unique action" — the CONFLAGRATOR's Sanctification Rack is exempt from that limit.
        if (op.datacardId !== CONFLAGRATOR && usedThisTP(state, `sanctifiers.orb:${op.player}`))
          return { ok: false, reason: 'the Sanctification Orb action has already been performed this turning point' };
        return orbTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to and within 6"' };
      },
      perform(ctx, state, op, params) {
        const first = orbTarget(ctx, state, op, params.targetOperativeId ?? params.targetId);
        if (!first) return { ok: false, reason: 'select one enemy operative visible to and within 6"' };
        if (op.datacardId !== CONFLAGRATOR) useOncePerTP(state, `sanctifiers.orb:${op.player}`);
        // "That operative and each other enemy operative within 1" of it takes a doused test."
        const victims = [
          first,
          ...aliveOperatives(state, otherPlayer(op.player)).filter(
            (o) =>
              o.id !== first.id &&
              baseGap(first.pos, card(ctx, first).base, first.rot, o.pos, card(ctx, o).base, o.rot) <= 1 + 1e-6,
          ),
        ].sort(byId);
        for (const victim of victims) {
          const roll = ctx.rng.d6();
          recordRoll(state, 'dousedTest', [roll], op.player, `doused test on ${victim.letter}`);
          if (roll < 3) continue; // "roll one D6: on a 3+, it gains one of your Doused tokens"
          giveToken(state, victim, DOUSED_TOKEN, {
            sourceId: EQ_ORBS,
            sourceText: shortQuote(text(EQ_ORBS)),
            player: op.player,
          });
        }
        return { ok: true };
      },
    },

    // ---- Shoot (Wreathed) — MIRACULIST -----------------------------------
    {
      id: WREATHED_SHOOT,
      name: 'Shoot (Wreathed)',
      ap: 1,
      type: 'unique',
      treatedAs: 'Shoot',
      sourceText: abilityText(MIRACULIST, A_WREATHED),
      available: (ctx, _state, op) =>
        (ctx.datacards.get(op.datacardId)?.weapons ?? []).some((w) => hasRuleNamed(w, 'Wreathed')),
      check(ctx, state, op, params) {
        if (op.order === 'conceal') return { ok: false, reason: 'cannot Shoot with a Conceal order' };
        const found = wreathedWeapon(ctx, state, op, params.weaponName);
        if (!found) return { ok: false, reason: 'select a weapon that has the Wreathed weapon rule' };
        const limited = found.profile.rules.find((r) => r.id === 'Limited');
        if (limited && (op.weaponUses[found.weapon.name] ?? 0) >= (limited.x ?? 1))
          return { ok: false, reason: `${found.weapon.name} has already been used` };
        if (wreathedTargets(ctx, state, op, found.profile).length === 0)
          return { ok: false, reason: 'no other operative is visible to and within the Blast radius of this operative' };
        return { ok: true };
      },
      perform(ctx, state, op, params) {
        const found = wreathedWeapon(ctx, state, op, params.weaponName);
        if (!found) return { ok: false, reason: 'select a weapon that has the Wreathed weapon rule' };
        const victims = wreathedTargets(ctx, state, op, found.profile);
        const first = victims[0];
        if (!first) return { ok: false, reason: 'no other operative is visible to and within the Blast radius of this operative' };
        bucket(state, WREATHED_ARMED)[op.id] = true;
        // "…this operative is always the primary target, but only shoot against secondary
        //  targets" — the MIRACULIST is skipped entirely and the Blast footprint it defines
        //  becomes the queue. "…they cannot be in cover or obscured."
        const profileName = found.profile.name;
        const r = startShoot(ctx, state, op, found.weapon.name, profileName, first.id, { pointBlank: true });
        if (!r.ok) return r;
        const seq = shootSeq(state);
        if (!seq) return { ok: false, reason: 'the shot could not be started' };
        seq.queue = victims.slice(1).map((o) => o.id);
        seq.pointBlank = false; // Wreathed prints no Hit penalty
        seq.inCover = false;
        seq.obscured = false;
        seq.coverChoiceMade = true;
        advanceShoot(ctx, state);
        return { ok: true };
      },
    },

    // ---- Fight (Merciless Castigation) — PERSECUTOR ----------------------
    {
      id: MERCILESS_FIGHT,
      name: 'Fight (Merciless Castigation)',
      ap: 1,
      type: 'unique',
      sourceText: abilityText(PERSECUTOR, A_MERCILESS),
      available: (_ctx, _state, op) => op.datacardId === PERSECUTOR,
      check(ctx, state, op, params) {
        const locked = effectOn(state, op.id, MERCILESS_TARGET);
        if (!locked) return { ok: false, reason: 'this operative has not performed the Fight action this activation' };
        if (op.incapacitated) return { ok: false, reason: 'this operative is incapacitated' };
        const foe = state.operatives[String(locked.data?.['targetId'] ?? '')];
        // "…and only if it's still valid to fight against"
        if (!foe || foe.removed || foe.incapacitated) return { ok: false, reason: 'that enemy operative is no longer valid' };
        if (!inControlRange(ctx, state, op, foe)) return { ok: false, reason: 'that enemy operative is not within control range' };
        return getAction('Fight')!.check(ctx, state, op, { ...params, targetId: foe.id });
      },
      perform(ctx, state, op, params) {
        const locked = effectOn(state, op.id, MERCILESS_TARGET);
        const targetId = String(locked?.data?.['targetId'] ?? '');
        // "…you cannot select any other enemy operative to fight against during that action"
        return getAction('Fight')!.perform(ctx, state, op, { ...params, targetId });
      },
    },

    // ---- CHERUB › Fly -----------------------------------------------------
    flyAction(FLY_REPOSITION, 'Reposition (Fly)', 'Reposition', 1),
    flyAction(FLY_FALL_BACK, 'Fall Back (Fly)', 'Fall Back', 2),
    flyAction(FLY_CHARGE, 'Charge (Fly)', 'Charge', 1),
  ];
}

// ---------------------------------------------------------------------------

export const sanctifiers = defineTeam({
  id: 'sanctifiers',
  rules: (reg, T) => {
    rules(reg, T);
    // The Blaze token's removal is the holder's choice, so it is a real PendingDecision this
    // team owns; the handler is a stable reference installed once per GameContext.
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
    [FP_ARDENT_ERADICATION]: (state, player) => {
      const T = makeTeamHooks(DATA, player);
      return T.friendlies(state).some((o) => isOrator(state, o))
        ? { ok: true }
        : { ok: false, reason: 'no friendly ORATOR operative — use the Ministorum Sermon first' };
    },
    [FP_UNWAVERING_DEVOTION]: (state, player) => {
      const T = makeTeamHooks(DATA, player);
      return T.friendlies(state).some((o) => isOrator(state, o) || o.datacardId === MIRACULIST)
        ? { ok: true }
        : { ok: false, reason: 'no friendly SANCTIFIER ORATOR or MIRACULIST operative' };
    },
    [FP_REDEEMED_THROUGH_FIRE]: (state, player) => {
      const T = makeTeamHooks(DATA, player);
      return T.friendlies(state, KW).some((o) => (T.card(o)?.weapons ?? []).some((w) => hasRuleNamed(w, 'Blaze')))
        ? { ok: true }
        : { ok: false, reason: 'no friendly SANCTIFIER operative has a weapon with the Blaze weapon rule' };
    },
  },
  aiHints: {
    roles: {
      [CONFESSOR]: 'leader',
      [CHERUB]: 'support',
      [CONFLAGRATOR]: 'gunner',
      [DEATH_CULT_ASSASSIN]: 'melee',
      [DRILL_ABBOT]: 'melee',
      [MIRACULIST]: 'gunner',
      [MISSIONARY]: 'gunner',
      [PERSECUTOR]: 'melee',
      [PREACHER]: 'objective',
      [RELIQUANT]: 'objective',
      [SALVATIONIST]: 'support',
    },
    ployValue: {
      [SP_EMPEROR_PROTECTS]: 0.5,
      [SP_FERVENT_BRAWL]: 0.5,
      [SP_ZEALOUS_PERSECUTION]: 0.5,
      [SP_RALLY_THE_FLOCK]: 0.4,
      [FP_ROSARIUS]: 0.5,
      [FP_ARDENT_ERADICATION]: 0.6,
      [FP_REDEEMED_THROUGH_FIRE]: 0.3,
      [FP_UNWAVERING_DEVOTION]: 0.4,
    },
    equipmentValue: {
      [EQ_ORBS]: 0.5,
      [EQ_PURITY_SEALS]: 0.6,
      [EQ_ECCLESIARCHY_TEXTS]: 0.4,
      [EQ_CULT_SYMBOLS]: 0.5,
    },
  },
});

export default sanctifiers;
