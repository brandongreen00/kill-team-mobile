/**
 * BROOD BROTHERS — Genestealer Cults.
 * https://wahapedia.ru/kill-team3/kill-teams/brood-brother/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read
 * out of `data/teams/brood-brother.json` and is never retyped here.
 *
 * Fifteen datacards, 22 datacard abilities and NINE unique actions hang off ONE faction rule:
 * **Crossfire**. A Crossfire token is a per-player effect on the enemy operative that carries it
 * (the Plague Marines' Poison / Hearthkyn Grudge shape), except that an operative can hold more
 * than one — the printed marker guide lists "Crossfire Tokens (Values 1 & 2)" — so the count lives
 * in the effect's `data.count`.
 *
 * Crossfire's second half ("…you can re-roll one of your attack dice") only reaches SHOOTING:
 * `onRollAttack` is emitted by `src/core/sequences/shoot.ts` alone and deliberately not by
 * `fight.ts` (docs/DECISIONS.md D-031). The same limit binds the AGITATOR's Psiren Caster. Both
 * are named in `REMINDER_ONLY` rather than implied to be complete.
 *
 * Two rare weapon rules are printed: `ConcealedPosition` (the SNIPER's sniper rifle, whose
 * `concealed` profile alone carries it — a PROFILE-level restriction, so `onSelectWeapon` with the
 * D-032 `dryRun` guard) and `PSYCHIC` (a weapon keyword with no printed definition; the MAGUS's
 * force stave carries it and this team prints no rule that reads it).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { successes } from '../../core/dice.ts';
import {
  EXPLOSIVE_ID,
  grenadeAllowance,
  grenadeWeapon,
  GRENADE_WEAPON_NAMES,
} from '../../core/equipment/grenades.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseWhollyWithin, dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  findProfile,
  hitOf,
  inControlRange,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { hasType } from '../../core/terrain.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { validateMove } from '../../core/movement.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Poly,
  Weapon,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData, type TeamRuleText } from '../data.ts';
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
  grantWeapon,
  hasEquipment,
  notEngaged,
  ployUsed,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('brood-brother');
const KW = 'BROOD BROTHER';
const EPS = 1e-6;

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string) => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionTextOf = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const COMMANDER = 'brood-brother.commander';
export const AGITATOR = 'brood-brother.agitator';
export const GUNNER = 'brood-brother.gunner';
export const ICONWARD = 'brood-brother.iconward';
export const KNIFE_FIGHTER = 'brood-brother.knife-fighter';
export const MEDIC = 'brood-brother.medic';
export const SAPPER = 'brood-brother.sapper';
export const SNIPER = 'brood-brother.sniper';
export const TROOPER = 'brood-brother.trooper';
export const VETERAN = 'brood-brother.veteran';
export const VOX_OPERATOR = 'brood-brother.vox-operator';
export const PSYCHIC_FAMILIAR = 'brood-brother.psychic-familiar';
export const MAGUS = 'brood-brother.magus';
export const PATRIARCH = 'brood-brother.patriarch';
export const PRIMUS = 'brood-brother.primus';

export const RULE_CROSSFIRE = 'brood-brother.rule.crossfire';

export const SP = {
  pervasive: 'brood-brother.sp.pervasive',
  uprising: 'brood-brother.sp.uprising',
  embedded: 'brood-brother.sp.embedded',
  cultDevotion: 'brood-brother.sp.cult-devotion',
} as const;

export const FP = {
  ruthlessCoordination: 'brood-brother.fp.ruthless-coordination',
  unquestioningLoyalty: 'brood-brother.fp.unquestioning-loyalty',
  idolisation: 'brood-brother.fp.idolisation',
  insidious: 'brood-brother.fp.insidious',
} as const;

export const EQ = {
  cultTalisman: 'brood-brother.eq.cult-talisman',
  covertGuises: 'brood-brother.eq.covert-guises',
  cultKnives: 'brood-brother.eq.cult-knives',
  lookout: 'brood-brother.eq.lookout',
} as const;

export const AB = {
  coordinate: 'brood-brother.commander.coordinate',
  devoted: 'brood-brother.agitator.devoted',
  psirenCaster: 'brood-brother.agitator.psiren-caster',
  cultIcon: 'brood-brother.iconward.cult-icon',
  broodmindDevotion: 'brood-brother.iconward.broodmind-devotion',
  assassin: 'brood-brother.knife-fighter.assassin',
  counterattack: 'brood-brother.knife-fighter.counterattack',
  medic: 'brood-brother.medic.medic',
  finalDefiance: 'brood-brother.sapper.final-defiance',
  grenadier: 'brood-brother.sapper.grenadier',
  concealedPosition: 'brood-brother.sniper.concealed-position',
  trooperGroupActivation: 'brood-brother.trooper.group-activation',
  resilient: 'brood-brother.veteran.resilient',
  bodyguard: 'brood-brother.veteran.bodyguard',
  small: 'brood-brother.psychic-familiar.small',
  familiarGroupActivation: 'brood-brother.psychic-familiar.group-activation',
  elusive: 'brood-brother.psychic-familiar.elusive',
  spiritualLeader: 'brood-brother.magus.spiritual-leader',
  alphaPredator: 'brood-brother.patriarch.alpha-predator',
  monster: 'brood-brother.patriarch.monster',
  fistOfThePatriarch: 'brood-brother.primus.fist-of-the-patriarch',
  mastermind: 'brood-brother.primus.mastermind',
} as const;

export const ACT = {
  medikit: 'brood-brother.medic.act.medikit',
  explosives: 'brood-brother.sapper.act.explosives',
  signal: 'brood-brother.vox-operator.act.signal',
  jam: 'brood-brother.vox-operator.act.jam',
  telepathicOverload: 'brood-brother.magus.act.telepathic-overload',
  mentalOnslaught: 'brood-brother.magus.act.mental-onslaught',
  intoShadow: 'brood-brother.patriarch.act.into-shadow',
  mindControl: 'brood-brother.patriarch.act.mind-control',
  conspire: 'brood-brother.primus.act.conspire',
} as const;

/** Extra `ActionDef`s a rule grants that a universal action forbids (docs/DECISIONS.md D-021). */
export const ASSASSIN_CHARGE = 'Charge (Assassin)';
export const FIST_SHOOT = 'Shoot (Fist of the Patriarch)';
export const FIST_FIGHT = 'Fight (Fist of the Patriarch)';
export const JAM_VISIBLE = 'JAM (visible)';

// ---------------------------------------------------------------------------
// Tokens and effect names (the printed marker guide names each of these)
// ---------------------------------------------------------------------------

export const CROSSFIRE_TOKEN = 'brood-brother.crossfire';
export const JAM_TOKEN = 'brood-brother.jam';
export const MIND_CONTROL_TOKEN = 'brood-brother.mindControl';
export const DEVOTED_TOKEN = 'brood-brother.devoted';

const SPIRITUAL_EFFECT = 'brood-brother.spiritualLeader';
const UPRISING_ARMED = 'brood-brother.uprisingArmed';
const UPRISING_GRANTED = 'brood-brother.uprisingGranted';
const MEDIC_SHIELD = 'brood-brother.medicShield';
const MEDIC_APL = 'brood-brother.medicApl';
const SIGNAL_EFFECT = 'brood-brother.signal';
const OVERLOAD_EFFECT = 'brood-brother.telepathicOverload';
const GROUP_ACTIVATION = 'brood-brother.groupActivation';
const COVERT_GUISES_D3 = 'brood-brother.covertGuisesD3';
const RUTHLESS_ARMED = 'brood-brother.ruthlessCoordination';

const LAST_ORDER_BAG = 'brood-brother.lastOrder';
const CROSSFIRE_OFFER_BAG = 'brood-brother.crossfireOffer';
const EXPLOSIVES_BAG = 'brood-brother.explosivesUses';
const MEDIC_TARGET_BAG = 'brood-brother.medicTarget';
const PATRIARCH_AP_BAG = 'brood-brother.patriarchAp';
const IDOLISATION_NOTE = 'Idolisation';
const CROSSFIRE_NOTE = 'Crossfire';
const TALISMAN_NOTE = 'Cult Talisman';

export const EXPLOSIVES_MARKER = (player: PlayerId): string => `brood-brother.explosives.${player}`;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

const engagedWithAnyEnemy = (T: TeamHooks, state: GameState, op: OperativeState): boolean =>
  aliveOperatives(state, otherPlayer(op.player)).some((e) => inCR(T, state, e, op));

/** The weapon profile of the attack currently being resolved against `victim`, if any. */
function incomingProfile(
  T: TeamHooks,
  state: GameState,
  victim: OperativeState,
): { profile: WeaponProfile; melee: boolean } | undefined {
  const seq = state.sequence;
  if (!seq || !T.ctx) return undefined;
  if (seq.kind === 'shoot') {
    if (seq.targetId !== victim.id) return undefined;
    const attacker = state.operatives[seq.attackerId];
    if (!attacker) return undefined;
    const w = weaponsOf(T.ctx, state, attacker, 'ranged').find((x) => x.name === seq.weaponName);
    const profile = w ? findProfile(w, seq.profileName) : undefined;
    return profile ? { profile, melee: false } : undefined;
  }
  const side = seq.defenderId === victim.id ? 'attacker' : seq.attackerId === victim.id ? 'defender' : undefined;
  if (!side) return undefined;
  return { profile: sideWeapon(T.ctx, state, seq, side).profile, melee: true };
}

/** The operative that just incapacitated `victim`, read from the in-flight sequence. */
function incapacitatorOf(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const ids = seq.kind === 'shoot' ? [seq.attackerId] : [seq.attackerId, seq.defenderId];
  return ids
    .map((id) => state.operatives[id])
    .find((o): o is OperativeState => o !== undefined && o.player !== victim.player);
}

const dropZoneOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

const medicTargets = (state: GameState): Record<string, unknown> => bucket(state, MEDIC_TARGET_BAG);

// ---------------------------------------------------------------------------
// Crossfire — the faction rule's token economy
// ---------------------------------------------------------------------------

const crossfireEffect = (state: GameState, operativeId: string, player: PlayerId) =>
  state.effects.find((e) => e.rule === CROSSFIRE_TOKEN && e.operativeId === operativeId && e.player === player);

/** How many of `player`'s Crossfire tokens this operative physically holds. */
export function crossfireTokens(state: GameState, operativeId: string, player: PlayerId): number {
  const eff = crossfireEffect(state, operativeId, player);
  return eff ? Number(eff.data?.['count'] ?? 1) : 0;
}

/** "…it gains one of your Crossfire tokens." */
export function giveCrossfire(state: GameState, target: OperativeState, player: PlayerId): void {
  const existing = crossfireEffect(state, target.id, player);
  if (existing) {
    const count = Number(existing.data?.['count'] ?? 1) + 1;
    existing.data = { ...(existing.data ?? {}), count };
    log(state, { kind: 'action', player, text: `${target.letter} gains a Crossfire token (${count})` });
    return;
  }
  giveToken(state, target, CROSSFIRE_TOKEN, {
    sourceId: RULE_CROSSFIRE,
    sourceText: shortQuote(text(RULE_CROSSFIRE)),
    player,
    expiry: { kind: 'endOfBattle' },
  });
  const created = crossfireEffect(state, target.id, player);
  if (created) created.data = { count: 1 };
}

/** "…you can remove any of those tokens." */
export function removeCrossfire(state: GameState, operativeId: string, player: PlayerId, n = 1): void {
  const eff = crossfireEffect(state, operativeId, player);
  if (!eff) return;
  const left = Number(eff.data?.['count'] ?? 1) - n;
  if (left <= 0) dropEffects(state, (e) => e.id === eff.id);
  else eff.data = { ...(eff.data ?? {}), count: left };
}

interface CrossfireOffer {
  n: number;
  pending: boolean;
  prev: number;
  stopped: boolean;
}

const crossfireOfferId = (n: number): string => `${RULE_CROSSFIRE}:reroll:${n}`;

/**
 * A per-SEQUENCE key for the offer bookkeeping below. `seq.usedRerolls` is a plain list of grant
 * ids the engine only tests membership on, so a sentinel parked there is a free, replay-safe way
 * to tell one shoot from the next (it is reset per secondary Blast/Torrent target too). Without it
 * a declined offer would stick to the same attacker/target pair for the rest of the battle.
 */
function crossfireGeneration(state: GameState, seq: ShootSequence, player: PlayerId): string {
  const prefix = `${RULE_CROSSFIRE}:gen:${player}:`;
  const found = seq.usedRerolls.find((id) => id.startsWith(prefix));
  if (found) return found;
  const id = `${prefix}${state.seq++}`;
  seq.usedRerolls.push(id);
  return id;
}

/**
 * "…after resolving all of your attack dice, if that enemy operative isn't incapacitated it gains
 * one of your Crossfire tokens." — the FIGHT half.
 *
 * `fight.ts` has no end-of-sequence hook, so the token is granted at the moment the fight's
 * ATTACKER has no unresolved successes left: `onStrikeResolved` fires after a die is struck
 * (offset 0) and `onBlockAllocation` fires before a die is discarded as a block (offset 1), so
 * between them every die the attacker resolves is seen. Both hooks also fire when the DEFENDER
 * resolves a die, which is what covers a fight in which the attacker retained nothing at all.
 */
function crossfireAfterFight(T: TeamHooks, state: GameState, offset: number): void {
  const seq = fightSeq(state);
  if (!seq) return;
  const me = state.operatives[seq.attackerId];
  // "shooting against or fighting against" — the RETALIATING half of a fight grants nothing.
  if (!me || me.player !== T.player || !T.kw(me, KW)) return;
  const them = state.operatives[seq.defenderId];
  if (!them || them.removed || them.incapacitated || them.player === T.player) return;
  if (successes(seq.attackerPool).length - offset > 0) return;
  const early = effectOn(state, them.id, UPRISING_GRANTED);
  if (early) {
    // UPRISING granted it "as soon as it's selected (instead of after resolving your attack dice)".
    dropEffects(state, (e) => e.id === early.id);
    return;
  }
  if (!useOncePerSequence(state, `brood-brother.crossfire:${T.player}`)) return;
  giveCrossfire(state, them, T.player);
}

// ---------------------------------------------------------------------------
// Spiritual Leader — a MENU of three sub-rules with no ids of their own
// ---------------------------------------------------------------------------

export const SPIRITUAL_OPTIONS = ['piercing', 'injured', 'apl'] as const;
export type SpiritualOption = (typeof SPIRITUAL_OPTIONS)[number];

/**
 * The three options, **sliced out of the printed Spiritual Leader ability** — they are printed as
 * blank-line-separated paragraphs after the lead-in colon and carry no ids, so there is nothing to
 * read them from (the Death Korps GUARDSMAN ORDERS / Kasrkin SKILL AT ARMS shape).
 */
export const SPIRITUAL_TEXT: Record<SpiritualOption, string> = (() => {
  const printed = abilityText(MAGUS, AB.spiritualLeader);
  const body = printed.slice(printed.indexOf(':') + 1);
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  const out = {} as Record<SpiritualOption, string>;
  SPIRITUAL_OPTIONS.forEach((option, i) => {
    out[option] = paras[i] ?? option;
  });
  return out;
})();

export const SPIRITUAL_LABEL: Record<SpiritualOption, string> = {
  piercing: 'Spiritual Leader: ignore the Piercing weapon rule',
  injured: 'Spiritual Leader: ignore changes from being injured',
  apl: 'Spiritual Leader: ignore changes to the APL stat',
};

export const spiritualGambitId = (option: SpiritualOption): string => `${AB.spiritualLeader}:${option}`;

/**
 * "…for friendly BROOD BROTHER operatives to have until the end of the turning point or until this
 * operative is incapacitated (whichever comes first)."
 */
function spiritualActive(T: TeamHooks, state: GameState, option: SpiritualOption): boolean {
  const eff = state.effects.find(
    (e) => e.rule === SPIRITUAL_EFFECT && e.player === T.player && e.data?.['option'] === option,
  );
  if (!eff) return false;
  return T.friendlies(state).some((o) => o.datacardId === MAGUS && !o.incapacitated);
}

// ---------------------------------------------------------------------------
// CULT KNIVES — the equipment weapon, taken from the printed table in the JSON
// ---------------------------------------------------------------------------

type EquipmentWithWeapons = TeamRuleText & { weapons?: { name: string; profiles: WeaponProfile[] }[] };

/**
 * "Friendly BROODGUARD operatives have the following melee weapon: Cult knife 3 / 4+ / 3/4."
 *
 * NOT the known `rules: []` scraper bug: the printed table for this weapon has NAME/ATK/HIT/DMG
 * columns and no WR column at all, so an empty rules list is the correct parse.
 */
export const CULT_KNIFE: Weapon = (() => {
  const printed = (DATA.equipment.find((e) => e.id === EQ.cultKnives) as EquipmentWithWeapons | undefined)?.weapons?.[0];
  const profile = printed?.profiles?.[0];
  return {
    name: printed?.name ?? 'Cult knife',
    profiles: [
      profile
        ? { ...profile, type: 'melee', rules: [...profile.rules] }
        : { type: 'melee', atk: 3, hit: 4, dmgN: 3, dmgC: 4, rules: [] },
    ],
  };
})();

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Crossfire (the one faction rule)
  // =========================================================================

  /*
   * "Whenever a friendly BROOD BROTHER operative is shooting against or fighting against an enemy
   *  operative, after resolving all of your attack dice, if that enemy operative isn't
   *  incapacitated it gains one of your Crossfire tokens."
   *
   * SHOOTING: `onStrikeResolved` is emitted by `resolveAttackDice` once per target, immediately
   * after every unblocked dice has been resolved and the damage inflicted — exactly the printed
   * moment, and `struck.incapacitated` is already true if the shot killed it. A Blast secondary is
   * its own emit, so each enemy target gains its own token; a friendly caught by a Blast does not.
   */
  reg.on('onStrikeResolved', T.bind(RULE_CROSSFIRE, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    if (ev.ctx.attacker.player !== T.player || !T.kw(ev.ctx.attacker, KW)) return;
    const foe = ev.struck;
    if (foe.player === T.player || foe.removed || foe.incapacitated) return;
    // UPRISING grants the token "as soon as it's selected (instead of after resolving your dice)".
    const early = effectOn(ev.state, foe.id, UPRISING_GRANTED);
    if (early) {
      dropEffects(ev.state, (e) => e.id === early.id);
      return;
    }
    giveCrossfire(ev.state, foe, T.player);
  });

  // FIGHTING: see `crossfireAfterFight` — both of the fight's die-resolution hooks feed it.
  reg.on('onStrikeResolved', T.bind(RULE_CROSSFIRE, 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    crossfireAfterFight(T, ev.state, 0);
  });
  reg.on('onBlockAllocation', T.bind(RULE_CROSSFIRE, 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    crossfireAfterFight(T, ev.state, 1);
  });

  /*
   * "Whenever a friendly BROOD BROTHER operative is shooting against, fighting against or
   *  retaliating against an enemy operative that has any of your Crossfire tokens, you can remove
   *  any of those tokens. For each that you do, you can re-roll one of your attack dice."
   *
   * REMINDER ONLY for fighting and retaliating: `fight.ts` builds its re-roll grants without
   * emitting `onRollAttack` (docs/DECISIONS.md D-031). What follows is the SHOOTING half.
   *
   * The engine offers a re-roll grant as a decision with a `keep` option and never reports back
   * whether it was taken, so the token is spent by RECONCILIATION: `onRollAttack` is re-emitted
   * once per `attackRerolls` iteration, exactly one grant is answered between two emits, and a
   * grant of ours that has been consumed since the previous emit is charged a token only if the
   * pool gained a re-rolled dice. A decline stops the offers, which is what "you can remove any of
   * those tokens" means — the token is only spent when the re-roll is actually used.
   */
  reg.on('onRollAttack', T.bind(RULE_CROSSFIRE, 12), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    if (ev.ctx.attacker.player !== T.player || !T.kw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    const seq = shootSeq(ev.state);
    if (!foe || foe.player === T.player || !seq) return;
    const bag = bucket(ev.state, CROSSFIRE_OFFER_BAG);
    const key = crossfireGeneration(ev.state, seq, T.player);
    const st = (bag[key] ?? { n: 0, pending: false, prev: 0, stopped: false }) as CrossfireOffer;
    bag[key] = st;
    const rerolled = seq.attack.dice.filter((d) => d.rerolledFrom !== undefined).length;
    if (st.pending && seq.usedRerolls.includes(crossfireOfferId(st.n))) {
      if (rerolled > st.prev) {
        removeCrossfire(ev.state, foe.id, T.player);
        log(ev.state, {
          kind: 'dice',
          player: T.player,
          text: `Crossfire: one of ${foe.letter}'s Crossfire tokens is removed for a re-roll`,
        });
      } else {
        st.stopped = true;
      }
      st.pending = false;
    }
    st.prev = rerolled;
    if (st.stopped) return;
    const tokens = crossfireTokens(ev.state, foe.id, T.player);
    if (tokens <= 0) return;
    if (!st.pending) {
      st.n += 1;
      st.pending = true;
    }
    ev.rerolls.push({
      id: crossfireOfferId(st.n),
      label: `Crossfire: remove one of ${foe.letter}'s Crossfire tokens to re-roll one attack dice (${tokens} held)`,
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(RULE_CROSSFIRE)),
    });
  });

  // =========================================================================
  // COMMANDER › Coordinate
  // =========================================================================
  // "STRATEGIC GAMBIT if this operative is in the killzone. Select one enemy operative to gain one
  //  of your Crossfire tokens."
  reg.on('gambitOptions', T.bind(AB.coordinate, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === COMMANDER)) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: AB.coordinate,
      label: 'Coordinate: an enemy operative gains a Crossfire token',
      sourceText: shortQuote(abilityText(COMMANDER, AB.coordinate)),
    });
  });
  reg.on('onPloyUsed', T.bind(AB.coordinate, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== AB.coordinate) return;
    const foe = chosenOperative(ev.state, ev.data, [...T.enemies(ev.state)].sort(byId));
    if (foe) giveCrossfire(ev.state, foe, T.player);
  });

  // =========================================================================
  // AGITATOR › Devoted
  // =========================================================================
  /**
   * "Once per turning point, when this operative is fighting or retaliating, in the Resolve Attack
   * Dice step, you can ignore the damage inflicted on it from one normal success."
   *
   * A fight resolves one dice at a time, so a damage call equal to the striking weapon's Normal Dmg
   * IS one normal success. It is free and once per turning point, so it is auto-used on the first
   * qualifying success (docs/DECISIONS.md D-022) and logged.
   */
  reg.on('onDamage', T.bind(AB.devoted, 12), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    const ag = ev.target;
    if (ag.player !== T.player || ag.datacardId !== AGITATOR) return;
    const seq = fightSeq(ev.state);
    if (!seq || (seq.attackerId !== ag.id && seq.defenderId !== ag.id)) return;
    const incoming = incomingProfile(T, ev.state, ag);
    if (!incoming || !incoming.melee) return;
    if (ev.amount !== incoming.profile.dmgN) return; // one NORMAL success's worth
    if (!useOncePerTP(ev.state, `brood-brother.devoted:${ag.id}`)) return;
    ev.amount = 0;
    giveToken(ev.state, ag, DEVOTED_TOKEN, {
      sourceId: AB.devoted,
      sourceText: shortQuote(abilityText(AGITATOR, AB.devoted)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Devoted: ${ag.letter} ignores one normal success` });
  });

  // =========================================================================
  // AGITATOR › Psiren Caster
  // =========================================================================
  // "Whenever a friendly BROOD BROTHER operative is shooting against, fighting against or
  //  retaliating against an enemy operative within 6" of this operative, you can re-roll one of
  //  your attack dice."  SHOOTING ONLY — `fight.ts` emits no `onRollAttack` (D-031).
  reg.on('onRollAttack', T.bind(AB.psirenCaster, 13), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    if (ev.ctx.attacker.player !== T.player || !T.kw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    if (!foe || foe.player === T.player) return;
    const agitator = T.friendlies(ev.state).find((o) => o.datacardId === AGITATOR && T.gap(o, foe) <= 6 + EPS);
    if (!agitator) return;
    ev.rerolls.push({
      id: `${AB.psirenCaster}:${agitator.id}`,
      label: 'Psiren Caster: re-roll one of your attack dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(abilityText(AGITATOR, AB.psirenCaster)),
    });
  });

  // =========================================================================
  // ICONWARD › Cult Icon
  // =========================================================================
  // "Whenever determining control of a marker within 4" of this operative, treat the total APL stat
  //  of friendly BROOD BROTHER operatives that contest it as 1 higher if at least one friendly
  //  BROOD BROTHER operative contests that marker. Note this isn't a change to the APL stat, so any
  //  changes are cumulative with this."
  reg.on('onMarkerControl', T.bind(AB.cultIcon, 12), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const iconward = T.friendlies(ev.state).find(
      (o) => o.datacardId === ICONWARD && T.markerGap(o, marker) <= 4 + EPS,
    );
    if (!iconward) return;
    const contests = T.friendlies(ev.state, KW).some((o) => markerContestedBy(T.ctx!, ev.state, marker, o));
    if (!contests) return;
    ev.aplByPlayer[T.player] += 1;
  });

  // =========================================================================
  // ICONWARD › Broodmind Devotion — REMINDER ONLY (see REMINDER_ONLY)
  // =========================================================================
  // "…before that operative is removed from the killzone, it can perform a 1AP action for free."
  // The operative is being removed, so D-015's "one extra AP on its next activation" can never be
  // spent, and `onIncapacitated.freeActions` is declared but never consumed. No handler is
  // registered, because one would be the silent no-op CLAUDE.md rule 5 forbids.

  // =========================================================================
  // KNIFE FIGHTER › Assassin — its own ActionDef (D-021), registered below.
  // =========================================================================

  // =========================================================================
  // KNIFE FIGHTER › Counterattack
  // =========================================================================
  // "Whenever this operative is fighting or retaliating, whenever your opponent resolves a normal
  //  success, inflict 1 damage on the enemy operative in that sequence."
  // The STRIKE half is exact; a normal success your opponent resolves as a BLOCK is not reachable
  // (`onBlockAllocation` carries no die), and is reported.
  reg.on('onStrikeResolved', T.bind(AB.counterattack, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.crit || !T.ctx) return;
    const kf = ev.struck;
    if (kf.player !== T.player || kf.datacardId !== KNIFE_FIGHTER) return;
    const foe = ev.ctx.attacker;
    if (foe.player === T.player || foe.removed) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Counterattack: ${foe.letter} takes 1 damage from ${kf.letter}`,
    });
    inflictDamage(T.ctx, ev.state, foe, 1, 'other');
  });

  // =========================================================================
  // MEDIC › Medic!
  // =========================================================================
  reg.on('onIncapacitated', T.bind(AB.medic, 11), (ev) => {
    const victim = ev.operative;
    if (ev.prevented || !T.mineKw(victim, KW)) return;
    if (T.kw(victim, 'PATRIARCH')) return; // "(excluding PATRIARCH)"
    const medic = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === MEDIC &&
        o.id !== victim.id && // "another friendly BROOD BROTHER operative"
        !o.incapacitated && // "You cannot use this rule if this operative is incapacitated."
        T.gap(o, victim) <= 3 + EPS &&
        visibleTo(T, ev.state, o, victim) &&
        // "providing neither this nor that operative is within control range of an enemy operative"
        !engagedWithAnyEnemy(T, ev.state, o) &&
        !engagedWithAnyEnemy(T, ev.state, victim),
    );
    if (!medic) return;
    // "The first time during each turning point that another friendly … would be removed…"
    if (!useOncePerTP(ev.state, `brood-brother.medic:${medic.id}`)) return;

    ev.prevented = true;
    victim.wounds = 1; // "that friendly operative isn't incapacitated and has 1 wound remaining"
    medicTargets(ev.state)[medic.id] = victim.id;
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: AB.medic },
      sourceText: shortQuote(abilityText(MEDIC, AB.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfAction' },
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next activations
    //  respectively."
    for (const o of [medic, victim]) {
      o.aplMods.push(-1);
      effect(ev.state, {
        rule: MEDIC_APL,
        source: { kind: 'ability', id: AB.medic },
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: false },
      });
    }
    // "That friendly operative can then immediately perform a free Dash action" and "if this rule
    //  was used during that friendly operative's activation, that activation ends" — so from here
    //  the Dash is the only action it may still perform (D-015).
    // REMINDER ONLY: "must end that move within this operative's control range" has no seam.
    grantFreeAction(ev.state, victim, {
      sourceId: AB.medic,
      sourceText: shortQuote(abilityText(MEDIC, AB.medic)),
      threshold: ev.state.activeOperativeId === victim.id ? victim.apSpent : currentApl(T, ev.state, victim),
      kind: 'ability',
      only: ['Dash'],
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Medic!: ${victim.letter} stays on 1 wound` });
  });
  // The shielded operative cannot be incapacitated again for the remainder of the action.
  reg.on('onIncapacitated', T.bind(AB.medic, 10), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, MEDIC_SHIELD)) return;
    ev.prevented = true;
    if (ev.operative.wounds <= 0) ev.operative.wounds = 1;
  });
  // `endOfAction` effects are only swept at the end of a turning point, so the shield is dropped at
  // the activation boundary instead — tighter than the engine's own expiry.
  reg.on('onActivationEnd', T.bind(AB.medic, 12), (ev) => {
    dropEffects(ev.state, (e) => e.rule === MEDIC_SHIELD && e.player === T.player);
  });
  // "It cannot be an operative that the Medic! rule was used on during this turning point."
  reg.on('onReadyStep', T.bind(AB.medic, 13), (ev) => {
    if (ev.player !== T.player) return;
    ev.state.opState[MEDIC_TARGET_BAG] = {};
  });
  // Housekeeping: the Crossfire offer ledger is per sequence, so nothing in it outlives a
  // turning point.
  reg.on('onReadyStep', T.bind(RULE_CROSSFIRE, 14), (ev) => {
    if (ev.player !== T.player) return;
    ev.state.opState[CROSSFIRE_OFFER_BAG] = {};
  });

  // =========================================================================
  // SAPPER › Final Defiance
  // =========================================================================
  /**
   * "If this operative is incapacitated, it can perform a free Explosives unique action before it's
   * removed from the killzone."
   *
   * There is no intent for performing an action outside an activation and
   * `onIncapacitated.freeActions` is never consumed, so the ACTION's effect is resolved directly —
   * the Kommandos' Boom! precedent (docs/DECISIONS.md D-024). EXPLOSIVES starts no sequence, so
   * unlike Boom! nothing has to be approximated: the printed effect is executed as written.
   */
  reg.on('onIncapacitated', T.bind(AB.finalDefiance, 13), (ev) => {
    const sapper = ev.operative;
    if (ev.prevented || !T.ctx) return;
    if (sapper.player !== T.player || sapper.datacardId !== SAPPER) return;
    if (explosivesUses(ev.state, sapper.id) >= 2) return; // "not more than twice per battle"
    if (!useOncePerBattle(ev.state, `brood-brother.finalDefiance:${sapper.id}`)) return;
    log(ev.state, { kind: 'action', player: T.player, text: `Final Defiance: ${sapper.letter} sets off its charges` });
    resolveExplosives(T.ctx, ev.state, sapper);
  });

  // =========================================================================
  // SAPPER › Grenadier
  // =========================================================================
  // "This operative can use frag and krak grenades."  The two explosive grenades are weapons, so
  // they are granted to the SAPPER whether or not the kill team took the equipment.
  const armGrenadier = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === SAPPER)) {
      grantWeapon(o, structuredClone(grenadeWeapon('frag')));
      grantWeapon(o, structuredClone(grenadeWeapon('krak')));
    }
  };
  reg.on('onDeploy', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.operative.player === T.player) armGrenadier(ev.state);
  });
  reg.on('onActivationStart', T.bind(AB.grenadier, 12), (ev) => armGrenadier(ev.state));
  reg.on('onReadyStep', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.player === T.player) armGrenadier(ev.state);
  });
  // The universal Explosive Grenades limiter runs at priority 10 on this hook; the SAPPER is
  // exempt, so it is re-allowed at a later priority.
  reg.on('onSelectWeapon', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== SAPPER) return;
    if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName)) return;
    ev.allowed = true;
    delete ev.reason;
  });
  // "Doing so doesn't count towards any limited uses you have" — the equipment's spender runs at
  // priority 10 on this hook, so its increment is handed straight back.
  reg.on('onCollectAttackDice', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== SAPPER) return;
    if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName) || ev.ctx.secondary) return;
    const choice = /krak/i.test(ev.ctx.weaponName) ? 'krak' : 'frag';
    if (grenadeAllowance(ev.state, T.player, EXPLOSIVE_ID, choice) <= 0) return;
    const uses = ev.state.teams[T.player].equipmentUses;
    const key = `used:${EXPLOSIVE_ID}:${choice}`;
    uses[key] = Math.max(0, (uses[key] ?? 0) - 1);
  });
  // "Whenever it's doing so, improve the Hit stat of that weapon by 1."  `StatMods.hit` from
  // `onCollectAttackDice` is dead — `hitOf` reads only `onStatMod`.
  reg.on('onStatMod', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== SAPPER) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!GRENADE_WEAPON_NAMES.includes(seq.weaponName)) return;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // SNIPER › Concealed Position (rare weapon rule)
  // =========================================================================
  // "This operative can only use this weapon the first time it's performing the Shoot action during
  //  the battle."  Concealed Position sits on ONE profile of the sniper rifle, which
  //  `availableWeapons` (per weapon) cannot express — `onSelectWeapon` can (D-032).
  reg.on('onSelectWeapon', T.bind(AB.concealedPosition, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'ConcealedPosition')) return;
    if (!hasShot(ev.state, ev.ctx.attacker.id)) return;
    ev.allowed = false;
    ev.reason = 'Concealed Position: only the first Shoot action of the battle';
  });
  reg.on('onCollectAttackDice', T.bind(AB.concealedPosition, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || ev.ctx.secondary) return;
    markShot(ev.state, ev.ctx.attacker.id);
  });

  // =========================================================================
  // TROOPER / PSYCHIC FAMILIAR › Group Activation
  // =========================================================================
  // "Whenever this operative is expended, you must then activate one other ready friendly BROOD
  //  BROTHER TROOPER operative (if able) before your opponent activates."
  // PARTIAL: the engine alternates activations strictly, so the pairing is recorded as an effect
  // for the UI/AI (the Death Korps TROOPER / Pathfinders SHAS'LA precedent).
  for (const [cardId, abilityId] of [
    [TROOPER, AB.trooperGroupActivation],
    [PSYCHIC_FAMILIAR, AB.familiarGroupActivation],
  ] as const) {
    reg.on('onActivationEnd', T.bind(abilityId, 12), (ev) => {
      const op = ev.operative;
      if (op.player !== T.player || op.datacardId !== cardId) return;
      // "…in other words, you cannot activate more than two operatives in succession with this."
      if (effectOn(ev.state, op.id, `${GROUP_ACTIVATION}.used`)) return;
      const other = T.friendlies(ev.state).find((o) => o.id !== op.id && o.ready && o.datacardId === cardId);
      if (!other) return;
      for (const [rule, id] of [
        [GROUP_ACTIVATION, other.id],
        [`${GROUP_ACTIVATION}.used`, other.id],
      ] as const) {
        effect(ev.state, {
          rule,
          source: { kind: 'ability', id: abilityId },
          sourceText: shortQuote(abilityText(cardId, abilityId)),
          operativeId: id,
          player: T.player,
          expiry: { kind: 'endOfTurningPoint' },
        });
      }
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Group Activation: ${other.letter} activates next`,
        data: { operativeId: other.id },
      });
    });
  }

  // =========================================================================
  // VETERAN › Resilient
  // =========================================================================
  /**
   * "Normal Dmg of 3 or more inflicts 1 less damage on this operative."
   *
   * A fight inflicts one dice at a time, so the amount IS one success's damage. A shoot aggregates
   * every unblocked dice into one call, so the count of unblocked NORMAL successes is read straight
   * off the pool and one damage is removed per normal success.
   */
  reg.on('onDamage', T.bind(AB.resilient, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const vet = ev.target;
    if (vet.player !== T.player || vet.datacardId !== VETERAN) return;
    const incoming = incomingProfile(T, ev.state, vet);
    if (!incoming || incoming.profile.dmgN < 3) return;
    let normals: number;
    if (incoming.melee) {
      if (ev.amount !== incoming.profile.dmgN) return; // a critical success is unaffected
      normals = 1;
    } else {
      const seq = shootSeq(ev.state)!;
      normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
      if (normals === 0) return;
    }
    ev.amount = Math.max(0, ev.amount - normals);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Resilient: ${vet.letter} takes ${normals} less damage`,
    });
  });

  // =========================================================================
  // VETERAN › Bodyguard
  // =========================================================================
  // "You can use the Unquestioning Loyalty firefight ploy for 0CP if this is the specified friendly
  //  BROODGUARD operative."  The reducer charges CP BEFORE `onPloyUsed` is emitted (known engine
  //  gap), so the discount is a refund.
  reg.on('onPloyUsed', T.bind(AB.bodyguard, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.unquestioningLoyalty) return;
    const shield = loyaltyShield(T, ev.state, ev.data);
    if (!shield || shield.datacardId !== VETERAN) return;
    const cp = DATA.firefightPloys.find((p) => p.id === FP.unquestioningLoyalty)?.cp ?? 1;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Bodyguard: Unquestioning Loyalty costs ${shield.letter} 0CP (${cp}CP refunded)`,
    });
  });

  // =========================================================================
  // PSYCHIC FAMILIAR › Small
  // =========================================================================
  // "This operative cannot use any weapons that aren't on its datacard…"
  reg.on('availableWeapons', T.bind(AB.small, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== PSYCHIC_FAMILIAR) return;
    const own = (T.card(ev.operative)?.weapons ?? []).map((w) => w.name);
    ev.weapons = ev.weapons.filter((n) => own.includes(n));
  });
  // Granted weapons (grenades, CULT KNIVES) bypass `availableWeapons`, so they are refused here.
  reg.on('onSelectWeapon', T.bind(AB.small, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== PSYCHIC_FAMILIAR) return;
    const own = (T.card(op)?.weapons ?? []).map((w) => w.name);
    if (own.includes(ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'Small: it cannot use any weapons that aren’t on its datacard';
  });
  // "…or perform unique actions."
  reg.on('canPerformAction', T.bind(AB.small, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== PSYCHIC_FAMILIAR) return;
    if (getAction(ev.action)?.type !== 'unique') return;
    ev.allowed = false;
    ev.reason = 'Small: it cannot perform unique actions';
  });
  /**
   * "Whenever this operative is in cover, it cannot be selected as a valid target, taking precedence
   * over all other rules (e.g. Seek, Vantage terrain) except being within 2"."
   *
   * `onValidTarget` is emitted before the sequence works out cover, so cover is recomputed here
   * with the PRINTED defaults — no Seek, no Vantage denial — which is what "taking precedence over
   * all other rules" asks for. `coverAndObscured` already reports no cover within 2".
   */
  reg.on('onValidTarget', T.bind(AB.small, 40), (ev) => {
    if (!T.ctx) return;
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== PSYCHIC_FAMILIAR) return;
    const index = terrain(T.ctx, ev.state);
    const cover = coverAndObscured(index, body(T.ctx, ev.attacker), body(T.ctx, target), {});
    if (!cover.inCover) return;
    ev.valid = false;
    ev.reason = 'Small: while it is in cover it cannot be selected as a valid target';
  });
  // "This operative can perform the Fall Back action for 1 less AP."
  reg.on('onActionCost', T.bind(AB.small, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== PSYCHIC_FAMILIAR) return;
    if (ev.action !== 'Fall Back') return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // =========================================================================
  // PSYCHIC FAMILIAR › Elusive — REMINDER ONLY (see REMINDER_ONLY)
  // =========================================================================
  // Both halves are engine gaps: `missionActionAllowed` in `src/core/ops/common.ts` hard-codes the
  // control-range refusal with no hook, and `canPerformAction` can only forbid (D-021); and
  // `onMoveRules` (`mayMoveThroughEnemies` / `ignoreControlRange`) is declared but never emitted.

  // =========================================================================
  // MAGUS › Spiritual Leader
  // =========================================================================
  for (const option of SPIRITUAL_OPTIONS) {
    reg.on('gambitOptions', T.bind(AB.spiritualLeader, 15), (ev) => {
      if (ev.player !== T.player) return;
      // "STRATEGIC GAMBIT if this operative is in the killzone."
      if (!T.friendlies(ev.state).some((o) => o.datacardId === MAGUS)) return;
      ev.options.push({
        id: spiritualGambitId(option),
        label: SPIRITUAL_LABEL[option],
        sourceText: SPIRITUAL_TEXT[option],
      });
    });
  }
  reg.on('onPloyUsed', T.bind(AB.spiritualLeader, 16), (ev) => {
    if (ev.player !== T.player) return;
    const option = SPIRITUAL_OPTIONS.find((o) => spiritualGambitId(o) === ev.ployId);
    if (!option) return;
    effect(ev.state, {
      rule: SPIRITUAL_EFFECT,
      source: { kind: 'ability', id: AB.spiritualLeader },
      sourceText: SPIRITUAL_TEXT[option],
      player: T.player,
      data: { option },
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  // Option 1: "Whenever an operative is shooting a friendly BROOD BROTHER operative, ignore the
  //            Piercing weapon rule."
  reg.on('onWeaponRules', T.bind(AB.spiritualLeader, 24), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player === T.player) return;
    if (!ev.target || !T.mineKw(ev.target, KW)) return;
    if (!spiritualActive(T, ev.state, 'piercing')) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing');
  });
  // Option 2: "You can ignore any changes to friendly BROOD BROTHER operatives' stats from being
  //            injured (including their weapons' stats)."  `hitOf` adds 1 and `moveOf` subtracts
  //            2" for an injured operative; both read `onStatMod`, so both are cancelled here.
  reg.on('onStatMod', T.bind(AB.spiritualLeader, 24), (ev) => {
    if (!T.ctx) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!spiritualActive(T, ev.state, 'injured')) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.hit += 1;
    ev.mods.move += 2;
  });
  // Option 3: "You can ignore any changes to the APL stat of friendly BROOD BROTHER operatives."
  //           `aplOf` sums `op.aplMods` plus `StatMods.apl`, so cancelling both leaves the base.
  reg.on('onStatMod', T.bind(AB.spiritualLeader, 44), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!spiritualActive(T, ev.state, 'apl')) return;
    ev.mods.apl = -ev.operative.aplMods.reduce((a, b) => a + b, 0);
  });

  // =========================================================================
  // PATRIARCH › Alpha Predator
  // =========================================================================
  // "Whenever an operative is shooting this operative, ignore the Piercing weapon rule."
  reg.on('onWeaponRules', T.bind(AB.alphaPredator, 12), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player === T.player) return;
    if (!ev.target || ev.target.player !== T.player || ev.target.datacardId !== PATRIARCH) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Piercing');
  });
  /**
   * "You can activate this operative twice during the turning point as long as it has AP to spend
   * (it stays ready while it can still be activated a second time). Per turning point, it cannot
   * move more than 9" and you cannot spend more than 4AP in total for it."
   *
   * `EndActivation` sets `ready = false` and `expended = true` BEFORE emitting `onActivationEnd`,
   * so the second activation is granted by putting both back.
   */
  reg.on('onActivationEnd', T.bind(AB.alphaPredator, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== PATRIARCH || op.removed || op.incapacitated) return;
    // "Counteracting isn't an activation, it's instead of activating" — it neither counts toward
    // the two activations nor toward the 4AP, and it must not put the operative back on ready.
    if (ev.state.opState['counteract']?.['operativeId'] === op.id) return;
    const bag = bucket(ev.state, PATRIARCH_AP_BAG);
    const key = `${op.id}:${ev.state.turningPoint}`;
    const spent = Number(bag[key] ?? 0) + op.apSpent;
    bag[key] = spent;
    const activations = Number(bag[`${key}:n`] ?? 0) + 1;
    bag[`${key}:n`] = activations;
    if (activations >= 2 || spent >= 4) return;
    op.ready = true;
    op.expended = false;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Alpha Predator: ${op.letter} stays ready (${4 - spent}AP left this turning point)`,
    });
  });
  // "…you cannot spend more than 4AP in total for it" per turning point.
  reg.on('canPerformAction', T.bind(AB.alphaPredator, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== PATRIARCH) return;
    const bag = bucket(ev.state, PATRIARCH_AP_BAG);
    const spent = Number(bag[`${op.id}:${ev.state.turningPoint}`] ?? 0) + op.apSpent;
    const cost = getAction(ev.action)?.ap ?? 1;
    if (spent + cost <= 4) return;
    ev.allowed = false;
    ev.reason = 'Alpha Predator: no more than 4AP in total per turning point';
  });
  // "Per turning point, it cannot move more than 9"."  `onMoveDistance` only scales the whole
  // allowance, so the distance already moved this turning point is read back off the move log
  // entries `applyMove` writes (`data.inches`, stamped with the turning point).
  reg.on('onMoveDistance', T.bind(AB.alphaPredator, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== PATRIARCH) return;
    ev.inches = Math.max(0, Math.min(ev.inches, 9 - movedThisTP(ev.state, op.id)));
  });

  // =========================================================================
  // PATRIARCH › Monster
  // =========================================================================
  // "This operative cannot use any weapons that aren't on its datacard…"
  reg.on('availableWeapons', T.bind(AB.monster, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== PATRIARCH) return;
    const own = (T.card(ev.operative)?.weapons ?? []).map((w) => w.name);
    ev.weapons = ev.weapons.filter((n) => own.includes(n));
  });
  reg.on('onSelectWeapon', T.bind(AB.monster, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== PATRIARCH) return;
    const own = (T.card(op)?.weapons ?? []).map((w) => w.name);
    if (own.includes(ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'Monster: it cannot use any weapons that aren’t on its datacard';
  });
  // "…or perform unique actions (excluding Into Shadow and Mind Control)."
  reg.on('canPerformAction', T.bind(AB.monster, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== PATRIARCH) return;
    if (ev.action === ACT.intoShadow || ev.action === ACT.mindControl) return;
    if (getAction(ev.action)?.type !== 'unique') return;
    ev.allowed = false;
    ev.reason = 'Monster: it cannot perform unique actions other than INTO SHADOW and MIND CONTROL';
  });
  /**
   * "Whenever your opponent is selecting a valid target, if this operative has a Conceal order, it
   * cannot use Light terrain for cover. While this can allow this operative to be targeted
   * (assuming it's visible), it doesn't remove its cover save (if any)."
   *
   * Two halves: `ignoreCoverTerrain: 'light'` makes it targetable, and because that ALSO clears
   * `seq.inCover`, the cover save is handed straight back in the Roll Defence Dice step.
   */
  reg.on('onValidTarget', T.bind(AB.monster, 13), (ev) => {
    const target = ev.target;
    if (target.player !== T.player || target.datacardId !== PATRIARCH) return;
    if (target.order !== 'conceal') return;
    if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
  });
  reg.on('onDefenceDice', T.bind(AB.monster, 13), (ev) => {
    if (!T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || ev.coverSave) return;
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== PATRIARCH) return;
    if (target.order !== 'conceal') return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
    const index = terrain(T.ctx, ev.state);
    const cover = coverAndObscured(index, body(T.ctx, ev.ctx.attacker), body(T.ctx, target), {});
    if (!cover.inCover) return;
    ev.coverSave = true;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Monster: ${target.letter} keeps its cover save`,
    });
  });

  // =========================================================================
  // PRIMUS › Fist of the Patriarch — two extra ActionDefs (D-021), below.
  // =========================================================================

  // =========================================================================
  // PRIMUS › Mastermind
  // =========================================================================
  /**
   * "Once per turning point, after rolling off to decide initiative, if this operative is in the
   * killzone, you can do one of the following (you cannot select each option more than once per
   * battle): Add 1 to your dice result. / If you didn't have initiative in the previous turning
   * point, re-roll your dice."
   *
   * `initiativeRollModifiers` is emitted BEFORE the D6, so "after rolling off" cannot be honoured
   * and the re-roll option is unreachable (`rerollOffered` is never consulted by `rollInitiative`).
   * The +1 is spent blind on a stated policy (D-022): the first Strategy-phase roll-off from
   * turning point 2, when initiative first has a price — the Blades of Khaine RUNE OF PROPHECY
   * precedent.
   */
  reg.on('initiativeRollModifiers', T.bind(AB.mastermind, 30), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.state.phase !== 'strategy' || ev.state.turningPoint < 2) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === PRIMUS)) return;
    if (!useOncePerBattle(ev.state, `brood-brother.mastermind:${T.player}`)) return;
    ev.mod += 1;
    log(ev.state, { kind: 'dice', player: T.player, text: 'Mastermind: +1 to the initiative roll-off' });
  });
}

// ---------------------------------------------------------------------------
// Scratch space (never module-level state — architecture rule 7)
// ---------------------------------------------------------------------------

function hasShot(state: GameState, id: string): boolean {
  return Boolean((state.opState['brood-brother.shot'] as Record<string, boolean> | undefined)?.[id]);
}
function markShot(state: GameState, id: string): void {
  const b = (state.opState['brood-brother.shot'] ?? {}) as Record<string, boolean>;
  b[id] = true;
  state.opState['brood-brother.shot'] = b;
}

export function explosivesUses(state: GameState, operativeId: string): number {
  return Number(bucket(state, EXPLOSIVES_BAG)[operativeId] ?? 0);
}

/** Inches this operative has already moved this turning point, from the move log. */
function movedThisTP(state: GameState, operativeId: string): number {
  let total = 0;
  for (const entry of state.log) {
    if (entry.tp !== state.turningPoint || entry.kind !== 'action') continue;
    const data = entry.data;
    if (!data || data['operativeId'] !== operativeId) continue;
    const inches = data['inches'];
    if (typeof inches === 'number') total += inches;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

/** "Select one other friendly BROODGUARD operative (excluding LEADER) visible to and within 3"." */
function loyaltyShield(
  T: TeamHooks,
  state: GameState,
  data: Record<string, unknown> | undefined,
  leader?: OperativeState,
): OperativeState | undefined {
  const boss =
    leader ?? T.friendlies(state, KW).find((o) => T.kw(o, 'LEADER'));
  if (!boss) return undefined;
  const candidates = T.friendlies(state, 'BROODGUARD')
    .filter((o) => o.id !== boss.id && !T.kw(o, 'LEADER'))
    .filter((o) => T.gap(o, boss) <= 3 + EPS && visibleTo(T, state, boss, o))
    .sort(byId);
  return chosenOperative(state, data, candidates);
}

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // PERVASIVE (strategy) — REMINDER ONLY (see REMINDER_ONLY)
  // =========================================================================
  // "…you can ignore the first vertical distance of 2" they move during one climb."  A per-LEG
  // change inside `validateMove`, which keeps its `legs` to itself: `onMoveRules` is declared but
  // never emitted, and `onMoveDistance` only scales the whole allowance with no path in the
  // payload. No handler is registered — the Hearthkyn CLIMBING RIGS gap.

  // =========================================================================
  // UPRISING (strategy)
  // =========================================================================
  /**
   * "The first time each friendly BROOD BROTHER operative performs either the Shoot or Fight action
   * during each of its activations, if its order was changed from Conceal to Engage at the start of
   * that activation, the enemy operative selected as the valid target or to fight against gains one
   * of your Crossfire tokens as soon as it's selected (instead of after resolving your attack
   * dice). This ploy has no effect if that friendly operative was activated within control range of
   * an enemy operative."
   *
   * `ActivateOperative` overwrites `op.order` before `onActivationStart` is emitted, so the order
   * an operative HAD is recorded when it deploys and at the end of every activation.
   */
  const recordOrder = (state: GameState, op: OperativeState): void => {
    if (op.player !== T.player) return;
    bucket(state, LAST_ORDER_BAG)[op.id] = op.order;
  };
  reg.on('onDeploy', T.bind(SP.uprising, 11), (ev) => recordOrder(ev.state, ev.operative));
  reg.on('onActivationEnd', T.bind(SP.uprising, 11), (ev) => recordOrder(ev.state, ev.operative));
  reg.on('onActivationStart', T.bind(SP.uprising, 11), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !T.kw(op, KW)) return;
    const bag = bucket(ev.state, LAST_ORDER_BAG);
    const previous = bag[op.id];
    bag[op.id] = op.order;
    if (!gambitUsed(ev.state, T.player, SP.uprising)) return;
    if (previous !== 'conceal' || op.order !== 'engage') return;
    if (engagedWithAnyEnemy(T, ev.state, op)) return; // "activated within control range of an enemy"
    effect(ev.state, {
      rule: UPRISING_ARMED,
      source: { kind: 'ploy', id: SP.uprising },
      sourceText: shortQuote(text(SP.uprising)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  const fireUprising = (state: GameState, shooter: OperativeState, foe: OperativeState): void => {
    const armed = effectOn(state, shooter.id, UPRISING_ARMED);
    if (!armed || foe.player === T.player) return;
    // "Note this ploy cannot come into effect more than once per activation."
    dropEffects(state, (e) => e.id === armed.id);
    giveCrossfire(state, foe, T.player);
    effect(state, {
      rule: UPRISING_GRANTED,
      source: { kind: 'ploy', id: SP.uprising },
      sourceText: shortQuote(text(SP.uprising)),
      operativeId: foe.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: shooter.id },
    });
    log(state, { kind: 'ploy', player: T.player, text: `Uprising: ${foe.letter} is marked as soon as it is selected` });
  };
  // Shoot: `onSelectTarget` is emitted in `startShoot` immediately after the target is chosen and
  // BEFORE the attack dice are rolled, so the token is available to Crossfire's own re-roll.
  reg.on('onSelectTarget', T.bind(SP.uprising, 12), (ev) => {
    if (ev.attacker.player !== T.player || !T.kw(ev.attacker, KW)) return;
    fireUprising(ev.state, ev.attacker, ev.target);
  });
  // Fight: `startFight` emits no target hook, so the earliest seam is the attacker's dice
  // collection in `rollSide`, which is still before the dice are rolled.
  reg.on('onCollectAttackDice', T.bind(SP.uprising, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    if (ev.ctx.attacker.player !== T.player || !T.kw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    if (foe) fireUprising(ev.state, ev.ctx.attacker, foe);
  });

  // =========================================================================
  // EMBEDDED (strategy)
  // =========================================================================
  // "Whenever an enemy operative is shooting a friendly BROOD BROTHER operative, if you can retain
  //  any cover saves as a result of Heavy terrain, you can retain one additional cover save."
  reg.on('onDefenceDice', T.bind(SP.embedded, 20), (ev) => {
    if (!T.ctx || !gambitUsed(ev.state, T.player, SP.embedded)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || !ev.coverSave) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (ev.ctx.attacker.player === T.player) return;
    const index = terrain(T.ctx, ev.state);
    const cover = coverAndObscured(index, body(T.ctx, ev.ctx.attacker), body(T.ctx, target), {});
    if (!cover.coverParts.some((p) => hasType(p, 'Heavy'))) return;
    ev.extraCoverSaves += 1;
    log(ev.state, { kind: 'dice', player: T.player, text: `Embedded: ${target.letter} retains one extra cover save` });
  });

  // =========================================================================
  // CULT DEVOTION (strategy)
  // =========================================================================
  /**
   * "Whenever a friendly BROOD BROTHER operative (excluding PATRIARCH) is incapacitated while
   * fighting or retaliating, if you have any unresolved successes, you can roll one D6: if the
   * result is a success as if it were the Roll Attack Dice step of that sequence (i.e. using the
   * same weapon, but with no re-rolls), you can strike the enemy operative in that sequence with
   * one of your unresolved normal successes, or any of your successes instead if the D6 result is a
   * critical success. In either case, that friendly operative is removed from the killzone
   * afterwards."
   */
  reg.on('onIncapacitated', T.bind(SP.cultDevotion, 20), (ev) => {
    if (ev.prevented || !T.ctx) return;
    if (!gambitUsed(ev.state, T.player, SP.cultDevotion)) return;
    const dying = ev.operative;
    if (!T.mineKw(dying, KW) || dying.datacardId === PATRIARCH) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === dying.id ? 'attacker' : seq.defenderId === dying.id ? 'defender' : undefined;
    if (!side) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const unresolved = successes(pool);
    if (unresolved.length === 0) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    if (!foe || foe.removed || foe.incapacitated) return;
    if (!useOncePerSequence(ev.state, `brood-brother.cultDevotion:${T.player}`)) return;
    const { profile, rules: wrules } = sideWeapon(T.ctx, ev.state, seq, side);
    const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
    const hit = hitOf(T.ctx, ev.state, dying, profile, assists);
    const lethal = wrules.find((r) => r.id === 'Lethal')?.x ?? 6;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'cultDevotion', [roll], T.player, `CULT DEVOTION ${hit}+`);
    if (roll < hit) {
      log(ev.state, { kind: 'dice', player: T.player, text: `Cult Devotion: ${dying.letter} rolls ${roll} — no strike` });
      return;
    }
    const critRoll = roll >= lethal;
    const die =
      (critRoll ? unresolved.find((d) => d.state === 'crit') : undefined) ??
      unresolved.find((d) => d.state === 'normal') ??
      (critRoll ? unresolved[0] : undefined);
    if (!die) return;
    const dmg = die.state === 'crit' ? profile.dmgC : profile.dmgN;
    die.state = 'struck';
    die.note = 'Cult Devotion';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Cult Devotion: ${dying.letter} strikes ${foe.letter} for ${dmg} before being removed`,
    });
    inflictDamage(T.ctx, ev.state, foe, dmg, 'attack');
  });

  // =========================================================================
  // RUTHLESS COORDINATION (firefight)
  // =========================================================================
  /**
   * "Until the end of the action, determine visibility as normal, but you can instead determine
   * intervening (for cover and obscured) from another friendly BROOD BROTHER operative that both
   * that friendly operative and the potential valid target are visible to, but that isn't itself
   * within control range of enemy operatives."
   *
   * `onValidTarget.viewFrom` (the Hierotek Magnify seam) is the only way to look through another
   * operative's eyes, and it moves visibility AND Vantage with it. Visibility is neutralised by
   * only setting `viewFrom` when the target is visible to the SHOOTER as well (which the printed
   * spotter conditions already require of the spotter). The Vantage carve-out — "the friendly
   * operative doesn't gain the additional benefits of Vantage terrain if the other friendly
   * operative is on it" — cannot be expressed, so a spotter that grants no Vantage is preferred and
   * the residue is reported.
   */
  // "Use this firefight ploy when selecting a valid target for a friendly BROOD BROTHER
  //  operative. Until the end of the action…" — the engine has no end-of-action seam, so the
  //  grant is pinned to the operative that was active when the ploy was paid for and expires with
  //  its activation (tighter than the plain `ploysUsedTP` read a turning-point-long ploy gets).
  reg.on('onPloyUsed', T.bind(FP.ruthlessCoordination, 19), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.ruthlessCoordination) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || active.player !== T.player) return;
    effect(ev.state, {
      rule: RUTHLESS_ARMED,
      source: { kind: 'ploy', id: FP.ruthlessCoordination },
      sourceText: shortQuote(text(FP.ruthlessCoordination)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
  });
  reg.on('onValidTarget', T.bind(FP.ruthlessCoordination, 20), (ev) => {
    if (!T.ctx || !ployUsed(ev.state, T.player, FP.ruthlessCoordination)) return;
    const shooter = ev.attacker;
    if (shooter.player !== T.player || !T.kw(shooter, KW)) return;
    if (!effectOn(ev.state, shooter.id, RUTHLESS_ARMED)) return;
    const index = terrain(T.ctx, ev.state);
    const targetBody = body(T.ctx, ev.target);
    if (!isVisible(index, body(T.ctx, shooter), targetBody).visible) return; // "visibility as normal"
    const spotters = T.friendlies(ev.state, KW)
      .filter((o) => o.id !== shooter.id && o.id !== ev.target.id)
      .filter((o) => !engagedWithAnyEnemy(T, ev.state, o))
      .filter((o) => visibleTo(T, ev.state, o, shooter) && visibleTo(T, ev.state, o, ev.target))
      .sort(byId);
    if (spotters.length === 0) return;
    const flat = spotters.find((o) => body(T.ctx!, o).z - targetBody.z < 2 - EPS);
    const spotter = flat ?? spotters[0]!;
    ev.viewFrom = spotter;
  });

  // =========================================================================
  // UNQUESTIONING LOYALTY (firefight)
  // =========================================================================
  // "Select one other friendly BROODGUARD operative (excluding LEADER) visible to and within 3" of
  //  that LEADER operative to become the valid target … instead (even if it wouldn't normally be
  //  valid for this).  This ploy has no effect if it's the Shoot action and the ranged weapon has
  //  the Blast or Torrent weapon rule."
  // SHOOT ONLY: `startFight` has no target-substitution seam (the Celestian HOLY DEFENDER gap).
  reg.on('onSelectTarget', T.bind(FP.unquestioningLoyalty, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.unquestioningLoyalty)) return;
    const boss = ev.target;
    if (boss.player !== T.player || !T.kw(boss, KW) || !T.kw(boss, 'LEADER')) return;
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (usedThisTP(ev.state, `brood-brother.loyalty:${T.player}`)) return;
    const shield = loyaltyShield(T, ev.state, undefined, boss);
    if (!shield || shield.incapacitated) return;
    useOncePerTP(ev.state, `brood-brother.loyalty:${T.player}`);
    ev.redirectTo = shield.id;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Unquestioning Loyalty: ${shield.letter} takes the shot meant for ${boss.letter}`,
    });
  });

  // =========================================================================
  // IDOLISATION (firefight)
  // =========================================================================
  /**
   * "…in the Roll Attack Dice step. You can retain one of your fails as a normal success instead of
   * discarding it, or retain one of your normal successes as a critical success instead."
   *
   * `onAttackDiceRetained` is declared but never emitted, so the promotion rides the `onWeaponRules`
   * emit that BOTH sequences make while the dice are on the table (the Hearthkyn Grudge seam):
   * `advanceShoot` calls `effectiveRules` at the top of every iteration and `advanceFight` calls
   * `sideWeapon` per side. That makes this the ONE Crossfire-adjacent rule that reaches fighting and
   * retaliating as well as shooting.
   *
   * The choice is the player's; the policy (D-022) takes the larger gain — a fail promoted to a
   * normal success adds a whole success, which beats the crit/normal damage difference.
   */
  const ROLLED_STEPS = new Set(['attackRerolls', 'retention', 'attackerRerolls', 'defenderRerolls']);
  reg.on('onWeaponRules', T.bind(FP.idolisation, 22), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.idolisation)) return;
    const op = ev.operative;
    if (!T.mineKw(op, KW) || T.kw(op, 'LEADER')) return; // "(excluding LEADER)"
    const near = T.friendlies(ev.state, KW).some(
      (o) => o.id !== op.id && (T.kw(o, 'LEADER') || o.datacardId === ICONWARD) && T.gap(o, op) <= 6 + EPS,
    );
    if (!near) return;
    const seq = ev.state.sequence;
    if (!seq || !ROLLED_STEPS.has(seq.step)) return;
    let pool;
    if (seq.kind === 'shoot') {
      if (seq.attackerId !== op.id) return;
      pool = seq.attack;
    } else if (seq.attackerId === op.id) {
      pool = seq.attackerPool;
    } else if (seq.defenderId === op.id) {
      pool = seq.defenderPool;
    } else {
      return;
    }
    if (pool.dice.some((d) => d.note === IDOLISATION_NOTE)) return; // already applied this sequence
    const fail = pool.dice.find((d) => d.state === 'fail');
    const promoted = fail ?? pool.dice.find((d) => d.state === 'normal');
    if (!promoted) return;
    // One use of the ploy, one promotion — `ploysUsedTP` otherwise reads true for the rest of the
    // turning point and would fire again in the next sequence.
    if (!useOncePerTP(ev.state, `brood-brother.idolisation:${T.player}`)) return;
    promoted.state = promoted.state === 'fail' ? 'normal' : 'crit';
    promoted.note = IDOLISATION_NOTE;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Idolisation: ${op.letter} retains a ${fail ? 'fail as a normal success' : 'normal success as a critical success'}`,
    });
  });

  // =========================================================================
  // INSIDIOUS (firefight)
  // =========================================================================
  // "Before the next activation, one friendly BROOD BROTHER operative can perform a free Dash
  //  action…"  There is no intent for performing an action outside an activation, so D-015 applies:
  //  the Dash is one extra AP restricted to Dash, landing on that operative's next activation.
  //  REMINDER ONLY: the printed timing, and "as long as it's not a valid target for enemy
  //  operatives when it starts and ends that action".
  reg.on('onPloyUsed', T.bind(FP.insidious, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.insidious) return;
    const op = chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW).sort(byId));
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: FP.insidious,
      sourceText: shortQuote(text(FP.insidious)),
      threshold: currentApl(T, ev.state, op),
      only: ['Dash'],
    });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // CULT TALISMAN
  // =========================================================================
  // "Once per turning point, when an operative is shooting a friendly BROOD BROTHER operative
  //  (excluding PATRIARCH), in the Roll Defence Dice step, you can retain one of your normal
  //  successes as a critical success instead."
  // The second `onDefenceDice` emit (the `defenceRerolls` step) is the first moment the defence
  // pool exists, which is where the promotion is applied.
  reg.on('onDefenceDice', T.bind(EQ.cultTalisman, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.cultTalisman)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || target.datacardId === PATRIARCH) return;
    if (ev.ctx.attacker.player === T.player) return;
    if (seq.defence.dice.some((d) => d.note === TALISMAN_NOTE)) return;
    const normal = seq.defence.dice.find((d) => d.state === 'normal');
    if (!normal) return;
    if (!useOncePerTP(ev.state, `brood-brother.talisman:${T.player}`)) return;
    normal.state = 'crit';
    normal.note = TALISMAN_NOTE;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Cult Talisman: ${target.letter} retains a normal success as a critical success`,
    });
  });

  // =========================================================================
  // COVERT GUISES
  // =========================================================================
  // "After revealing this equipment option, roll one D3. As a STRATEGIC GAMBIT in the first turning
  //  point, a number of friendly BROODGUARD operatives equal to the result that are wholly within
  //  your drop zone can immediately perform a free Reposition action, but must end that move wholly
  //  within 3" of your drop zone."
  reg.on('onSelectEquipment', T.bind(EQ.covertGuises, 30), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    if (!ev.equipment.includes(EQ.covertGuises)) return;
    if (!useOncePerBattle(ev.state, `brood-brother.covertGuises:${T.player}`)) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'covertGuises', [d3], T.player, 'COVERT GUISES D3');
    effect(ev.state, {
      rule: COVERT_GUISES_D3,
      source: { kind: 'equipment', id: EQ.covertGuises },
      sourceText: shortQuote(text(EQ.covertGuises)),
      player: T.player,
      data: { count: d3 },
      expiry: { kind: 'endOfBattle' },
    });
  });
  reg.on('gambitOptions', T.bind(EQ.covertGuises, 30), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (!hasEquipment(ev.state, T.player, EQ.covertGuises)) return;
    ev.options.push({
      id: EQ.covertGuises,
      label: 'Covert Guises: free Reposition for BROODGUARD operatives in your drop zone',
      sourceText: shortQuote(text(EQ.covertGuises)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.covertGuises, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.covertGuises) return;
    const rolled = ev.state.effects.find((e) => e.rule === COVERT_GUISES_D3 && e.player === T.player);
    const count = Number(rolled?.data?.['count'] ?? 1);
    const zones = dropZoneOf(ev.state, T.player);
    const eligible = T.friendlies(ev.state, 'BROODGUARD')
      .filter((o) => {
        const card = T.card(o);
        return card !== undefined && zones.length > 0 && baseWhollyWithin(o.pos, card.base, o.rot, zones);
      })
      .sort(byId)
      .slice(0, count);
    for (const op of eligible) {
      // REMINDER ONLY: "must end that move wholly within 3" of your drop zone" — `validateMove`
      // has no end-region option and `onMoveRules` is never emitted.
      grantFreeAction(ev.state, op, {
        sourceId: EQ.covertGuises,
        sourceText: shortQuote(text(EQ.covertGuises)),
        threshold: currentApl(T, ev.state, op),
        kind: 'equipment',
        only: ['Reposition'],
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Covert Guises: ${eligible.length} of ${count} BROODGUARD operatives may Reposition for free`,
    });
  });

  // =========================================================================
  // CULT KNIVES
  // =========================================================================
  // "Friendly BROODGUARD operatives have the following melee weapon: Cult knife."
  const armKnives = (state: GameState): void => {
    if (!hasEquipment(state, T.player, EQ.cultKnives)) return;
    for (const op of T.friendlies(state, 'BROODGUARD')) grantWeapon(op, structuredClone(CULT_KNIFE));
  };
  reg.on('onSelectEquipment', T.bind(EQ.cultKnives, 30), (ev) => {
    if (ev.player === T.player) armKnives(ev.state);
  });
  reg.on('onDeploy', T.bind(EQ.cultKnives, 30), (ev) => {
    if (ev.operative.player === T.player) armKnives(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.cultKnives, 30), (ev) => armKnives(ev.state));
  reg.on('onReadyStep', T.bind(EQ.cultKnives, 30), (ev) => {
    if (ev.player === T.player) armKnives(ev.state);
  });

  // =========================================================================
  // LOOKOUT
  // =========================================================================
  // "STRATEGIC GAMBIT. Select one enemy operative visible to a friendly BROOD BROTHER operative to
  //  gain one of your Crossfire tokens."
  reg.on('gambitOptions', T.bind(EQ.lookout, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.lookout)) return;
    if (lookoutTargets(T, ev.state).length === 0) return;
    ev.options.push({
      id: EQ.lookout,
      label: 'Lookout: a visible enemy operative gains a Crossfire token',
      sourceText: shortQuote(text(EQ.lookout)),
    });
  });
  reg.on('onPloyUsed', T.bind(EQ.lookout, 31), (ev) => {
    if (ev.player !== T.player || ev.ployId !== EQ.lookout) return;
    const foe = chosenOperative(ev.state, ev.data, lookoutTargets(T, ev.state));
    if (foe) giveCrossfire(ev.state, foe, T.player);
  });
}

function lookoutTargets(T: TeamHooks, state: GameState): OperativeState[] {
  const mine = T.friendlies(state, KW);
  return T.enemies(state)
    .filter((foe) => mine.some((o) => visibleTo(T, state, o, foe)))
    .sort(byId);
}

// ---------------------------------------------------------------------------
// The clauses this hook surface cannot express, with the reason (UI + docs).
// ---------------------------------------------------------------------------

export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE_CROSSFIRE}.fightReroll`]:
    'fight.ts emits no onRollAttack (D-031), so Crossfire’s "you can remove any of those tokens … re-roll one of your attack dice" works only when SHOOTING; the token-granting half is live in both sequences',
  [AB.psirenCaster]:
    'fight.ts emits no onRollAttack (D-031), so the re-roll works only when shooting, not when fighting or retaliating',
  [AB.broodmindDevotion]:
    'the operative is being removed from the killzone, so D-015’s extra AP can never be spent and onIncapacitated.freeActions is declared but never consumed — the free 1AP action (and its order change) has no seam at all',
  [AB.trooperGroupActivation]:
    'the reducer sets activePlayer = otherPlayer(op.player) AFTER onActivationEnd is emitted, so "you must then activate one other ready friendly TROOPER operative before your opponent activates" cannot be enforced; the pairing is recorded as an effect for the UI/AI (the Death Korps / Pathfinders partial)',
  [AB.familiarGroupActivation]:
    'the reducer sets activePlayer = otherPlayer(op.player) AFTER onActivationEnd is emitted, so the PSYCHIC FAMILIAR pairing is recorded as an effect rather than enforced',
  [`${AB.counterattack}.block`]:
    'onBlockAllocation carries no die, so a normal success your opponent resolves as a BLOCK cannot be detected; the strike half is exact',
  [`${AB.medic}.dashEnd`]:
    'validateMove has no end-region option, so "must end that move within this operative’s control range" is not enforced',
  [AB.elusive]:
    'missionActionAllowed in src/core/ops/common.ts hard-codes the control-range refusal with no hook and canPerformAction can only forbid (D-021); and onMoveRules (mayMoveThroughEnemies / ignoreControlRange) is declared but never emitted',
  [`${AB.mastermind}.reroll`]:
    'initiativeRollModifiers is emitted BEFORE the D6 and rerollOffered is never consulted by rollInitiative, so "after rolling off" and the re-roll option cannot be expressed; the +1 is spent blind on a stated policy',
  [SP.pervasive]:
    'onMoveRules is declared but never emitted and onMoveDistance carries no path, so a single climb leg’s vertical distance cannot be changed — the whole ploy is reminder-only',
  [`${FP.ruthlessCoordination}.vantage`]:
    'onValidTarget.viewFrom moves Vantage with the view, so "the friendly operative doesn’t gain the additional benefits of Vantage terrain if the other friendly operative is on it" cannot be enforced; a spotter that grants no Vantage is preferred',
  [`${FP.unquestioningLoyalty}.fight`]:
    'startFight emits no target-substitution hook, so the Fight half (and "treat that other operative as being within the fighting operative’s control range") is unreachable; the Shoot half is exact',
  [`${FP.insidious}.timing`]:
    'no intent performs an action outside an activation, so the free Dash lands on that operative’s next activation (D-015) instead of "before the next activation", and "not a valid target when it starts and ends that action" cannot be checked',
  [`${EQ.covertGuises}.dropZone`]:
    'validateMove has no end-region option, so "must end that move wholly within 3" of your drop zone" is not enforced; the D3 and the eligibility test are',
  [`${ACT.jam}.activation`]:
    'nothing hooks the choice of which operative activates next, so "that enemy operative cannot be activated" is unreachable; "or perform actions" IS enforced through canPerformAction',
  [`${ACT.mindControl}.control`]:
    'an operative cannot change sides (op.player drives rosters, control range and scoring) and no intent performs an action outside an activation, so the second effect is recorded as a Mind Control token only; the roll-off and its once-per-battle limit are live',
  'brood-brother.selection.leaderKeyword':
    'the printed "if one of these operatives is selected for deployment, your COMMANDER operative loses the LEADER keyword for the battle" is a kind:"custom" selection constraint, which is the one constraint kind the shared validator does not enforce (D-036)',
  'brood-brother.selection.freePloy':
    'the ^3 footnote ("up to three times, instead of selecting one of these operatives, you can select one BROOD BROTHER ploy to cost you 0CP for the battle") has no constraint entry at all and Select Operatives has no decision channel',
};

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

const enemiesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, otherPlayer(op.player)).sort(byId);
const friendliesOf = (state: GameState, op: OperativeState): OperativeState[] =>
  aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .sort(byId);
const hasKw = (ctx: GameContext, op: OperativeState, keyword: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

function visibleEnemies(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  return enemiesOf(state, op).filter((e) => isVisible(index, body(ctx, op), body(ctx, e)).visible);
}

/** "…an enemy operative that's a valid target for this operative", using its own ranged weapon. */
function validTargetsOf(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const weapon = weaponsOf(ctx, state, op, 'ranged')[0];
  const profile = weapon ? findProfile(weapon) : undefined;
  if (!weapon || !profile) return [];
  return enemiesOf(state, op).filter((e) => {
    const wrules = effectiveRules(ctx, state, profile, { operative: op, target: e, weaponName: weapon.name });
    return checkTarget(ctx, state, op, e, profile, wrules).valid;
  });
}

const pick = (list: OperativeState[], chosen?: string): OperativeState | undefined =>
  list.find((o) => o.id === chosen) ?? list[0];

/** "…regain up to 2D3 lost wounds" — friendly BROOD BROTHER (excluding PATRIARCH) in control range. */
function medikitTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const used = Object.values(medicTargets(state));
  return friendliesOf(state, op)
    .filter((o) => hasKw(ctx, o, KW) && !hasKw(ctx, o, 'PATRIARCH'))
    .filter((o) => inControlRange(ctx, state, op, o))
    .filter((o) => !used.includes(o.id));
}

/** "…one other friendly BROODGUARD operative visible to and within 6" of this operative." */
function signalTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  const reach = supportDistance(ctx, state, op, 6); // SUPPORT: a Comms Device widens it
  return friendliesOf(state, op)
    .filter((o) => hasKw(ctx, o, 'BROODGUARD'))
    .filter((o) => baseGapBetween(ctx, op, o) <= reach + EPS)
    .filter((o) => isVisible(index, body(ctx, op), body(ctx, o)).visible);
}

function baseGapBetween(ctx: GameContext, a: OperativeState, b: OperativeState): number {
  const ca = ctx.datacards.get(a.datacardId);
  const cb = ctx.datacards.get(b.datacardId);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return Math.max(0, dist(a.pos, b.pos) - baseR(ca.base) - baseR(cb.base));
}
const baseR = (base: { shape: 'round'; mm: number } | { shape: 'oval'; mm: [number, number] }): number =>
  (base.shape === 'round' ? base.mm : Math.max(base.mm[0], base.mm[1])) / 25.4 / 2;

/** EXPLOSIVES, resolved as its printed effect so Final Defiance can run it on death too. */
export function resolveExplosives(ctx: GameContext, state: GameState, op: OperativeState): void {
  const bag = bucket(state, EXPLOSIVES_BAG);
  const used = Number(bag[op.id] ?? 0);
  bag[op.id] = used + 1;
  const id = EXPLOSIVES_MARKER(op.player);
  if (used === 0) {
    // "The first time this operative performs this action during the battle, place your Explosives
    //  marker within its control range."
    const marker: MarkerState = {
      id,
      kind: 'generic',
      diameterMm: 20,
      pos: { ...op.pos },
      z: op.z,
      owner: op.player,
      flags: { explosives: true },
    };
    state.markers[id] = marker;
    log(state, { kind: 'action', player: op.player, text: `${op.letter}: EXPLOSIVES marker placed` });
    return;
  }
  // "The second time … inflict 2D6 damage on each operative within 2" of that marker (roll
  //  separately for each) unless Heavy terrain is wholly intervening between that operative and
  //  that marker."
  const marker = state.markers[id];
  if (!marker) {
    log(state, { kind: 'action', player: op.player, text: `${op.letter}: EXPLOSIVES — no marker to detonate` });
    return;
  }
  for (const victim of explosivesVictims(ctx, state, marker)) {
    const rolls = [ctx.rng.d6(), ctx.rng.d6()];
    recordRoll(state, 'explosives', rolls, op.player, `EXPLOSIVES vs ${victim.letter}`);
    inflictDamage(ctx, state, victim, rolls[0]! + rolls[1]!, 'other');
  }
  log(state, { kind: 'action', player: op.player, text: `${op.letter}: EXPLOSIVES detonated` });
}

export function explosivesVictims(ctx: GameContext, state: GameState, marker: MarkerState): OperativeState[] {
  const index = terrain(ctx, state);
  const markerBody = {
    id: marker.id,
    pos: marker.pos,
    z: marker.z,
    rot: 0,
    base: { shape: 'round' as const, mm: marker.diameterMm },
    height: 0.2,
  };
  return Object.values(state.operatives)
    .filter((o) => !o.removed && !o.incapacitated)
    .filter((o) => {
      const card = ctx.datacards.get(o.datacardId);
      if (!card) return false;
      const gap = Math.max(0, dist(o.pos, marker.pos) - baseR(card.base) - baseR({ shape: 'round', mm: marker.diameterMm }));
      if (gap > 2 + EPS) return false;
      const vis = isVisible(index, markerBody, body(ctx, o));
      if (!vis.visible && vis.blockedBy?.types.includes('Heavy')) return false;
      return true;
    })
    .sort(byId);
}

/** "…until your opponent has activated a number of enemy operatives after this action equal to D6." */
export function jamRemaining(state: GameState, operativeId: string): number {
  const eff = state.effects.find((e) => e.rule === JAM_TOKEN && e.operativeId === operativeId);
  return eff ? Number(eff.data?.['remaining'] ?? 0) : 0;
}

function jamAction(id: string, ap: number, mode: 'validTarget' | 'visible'): ActionDef {
  const printed = cardOf(VOX_OPERATOR).uniqueActions.find((a) => a.id === ACT.jam)!;
  const targets = (ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] => {
    const all = mode === 'validTarget' ? validTargetsOf(ctx, state, op) : visibleEnemies(ctx, state, op);
    const valid = mode === 'visible' ? validTargetsOf(ctx, state, op).map((o) => o.id) : [];
    return all
      .filter((o) => o.ready) // "Select one ready enemy operative"
      .filter((o) => jamRemaining(state, o.id) <= 0)
      .filter((o) => mode === 'validTarget' || !valid.includes(o.id)); // the +1AP variant only
  };
  return {
    id,
    name: mode === 'validTarget' ? printed.name : `${printed.name} (visible)`,
    ap,
    type: 'unique',
    ...(id === ACT.jam ? {} : { treatedAs: ACT.jam }),
    sourceText: `${printed.name} ${ap}AP: ${printed.text.replace(/\s+/g, ' ').trim()}`,
    available: (_ctx, _state, op) => op.datacardId === VOX_OPERATOR,
    check(ctx, state, op, params) {
      const eng = notEngaged(ctx, state, op);
      if (!eng.ok) return eng;
      return pick(targets(ctx, state, op), params.targetOperativeId ?? params.targetId)
        ? { ok: true }
        : { ok: false, reason: `select one ready enemy operative ${mode === 'visible' ? 'visible to' : 'that is a valid target for'} this operative` };
    },
    perform(ctx, state, op, params) {
      const target = pick(targets(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
      const d6 = ctx.rng.d6();
      recordRoll(state, 'jam', [d6], op.player, `JAM vs ${target.letter}`);
      giveToken(state, target, JAM_TOKEN, {
        sourceId: ACT.jam,
        sourceText: shortQuote(printed.text),
        player: op.player,
        expiry: { kind: 'endOfTurningPoint' }, // "Until the end of the turning point"
      });
      const eff = state.effects.find((e) => e.rule === JAM_TOKEN && e.operativeId === target.id);
      if (eff) eff.data = { remaining: d6 };
      log(state, { kind: 'action', player: op.player, text: `${op.letter}: JAM on ${target.letter} (${d6})` });
      return { ok: true };
    },
  };
}

function actions(data: typeof DATA): ActionDef[] {
  const out: ActionDef[] = [];

  // ---- MEDIKIT — MEDIC ---------------------------------------------------
  out.push(
    uniqueAction(data, MEDIC, ACT.medikit, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(medikitTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly BROOD BROTHER operative (excluding PATRIARCH) within control range' };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(medikitTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        const heal = ctx.rng.d3() + ctx.rng.d3(); // "regain up to 2D3 lost wounds"
        recordRoll(state, 'medikit', [heal], op.player, 'MEDIKIT 2D3');
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: MEDIKIT restores ${heal} wounds to ${target.letter}`,
        });
        return { ok: true };
      },
    }),
  );

  // ---- EXPLOSIVES — SAPPER -----------------------------------------------
  out.push(
    uniqueAction(data, SAPPER, ACT.explosives, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (explosivesUses(state, op.id) >= 2)
          return { ok: false, reason: 'this operative cannot perform this action more than twice per battle' };
        if (['Charge', 'Dash', 'Fall Back'].some((a) => did(op, a)))
          return { ok: false, reason: 'not during an activation in which it performed the Charge, Dash or Fall Back action' };
        return { ok: true };
      },
      perform: (ctx, state, op) => {
        resolveExplosives(ctx, state, op);
        return { ok: true };
      },
    }),
  );

  // ---- SIGNAL — VOX-OPERATOR ---------------------------------------------
  out.push(
    uniqueAction(data, VOX_OPERATOR, ACT.signal, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(signalTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly BROODGUARD operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(signalTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        target.aplMods.push(1); // "Until the end of that operative's next activation, add 1 to its APL stat."
        effect(state, {
          rule: SIGNAL_EFFECT,
          source: { kind: 'ability', id: ACT.signal },
          sourceText: shortQuote(actionTextOf(VOX_OPERATOR, ACT.signal)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
        return { ok: true };
      },
    }),
  );

  // ---- TELEPATHIC OVERLOAD — MAGUS ---------------------------------------
  out.push(
    uniqueAction(data, MAGUS, ACT.telepathicOverload, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(visibleEnemies(ctx, state, op), params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(visibleEnemies(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        target.aplMods.push(-1);
        effect(state, {
          rule: OVERLOAD_EFFECT,
          source: { kind: 'ability', id: ACT.telepathicOverload },
          sourceText: shortQuote(actionTextOf(MAGUS, ACT.telepathicOverload)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: TELEPATHIC OVERLOAD — ${target.letter} -1 APL`,
        });
        return { ok: true };
      },
    }),
  );

  // ---- MENTAL ONSLAUGHT — MAGUS ------------------------------------------
  out.push(
    uniqueAction(data, MAGUS, ACT.mentalOnslaught, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(validTargetsOf(ctx, state, op), params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative that’s a valid target for this operative' };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(validTargetsOf(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        // "Inflict 2 damage on it, or 4 damage instead if it's within 6" of this operative."
        const bite = (): number => (baseGapBetween(ctx, op, target) <= 6 + EPS ? 4 : 2);
        let total = 0;
        const first = bite();
        inflictDamage(ctx, state, target, first, 'mortal');
        total += first;
        // "Keep rolling one D6 in this manner until you roll equal to or less than that enemy
        //  operative's APL stat, until it's incapacitated, or until you inflict 8 damage."
        let guard = 0;
        while (total < 8 && !target.incapacitated && !target.removed && guard++ < 8) {
          const apl = aplOf(ctx, state, target);
          const roll = ctx.rng.d6();
          recordRoll(state, 'mentalOnslaught', [roll], op.player, `MENTAL ONSLAUGHT vs APL ${apl}`);
          if (roll <= apl) break;
          const more = Math.min(bite(), 8 - total);
          inflictDamage(ctx, state, target, more, 'mortal');
          total += more;
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: MENTAL ONSLAUGHT inflicts ${total} damage on ${target.letter}`,
        });
        return { ok: true };
      },
    }),
  );

  // ---- INTO SHADOW — PATRIARCH -------------------------------------------
  out.push(
    uniqueAction(data, PATRIARCH, ACT.intoShadow, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        op.order = op.order === 'conceal' ? 'engage' : 'conceal';
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: INTO SHADOW (${op.order})` });
        return { ok: true };
      },
    }),
  );

  // ---- MIND CONTROL — PATRIARCH ------------------------------------------
  out.push(
    uniqueAction(data, PATRIARCH, ACT.mindControl, {
      check: (ctx, state, op, params) => {
        const candidates = mindControlTargets(ctx, state, op);
        const target = pick(candidates, params.targetOperativeId ?? params.targetId);
        if (!target) return { ok: false, reason: 'select one enemy operative visible to and within 2" of this operative' };
        // "…unless the only enemy operative it's within control range of is selected for this."
        const engagedWith = aliveOperatives(state, otherPlayer(op.player)).filter((e) =>
          inControlRange(ctx, state, op, e),
        );
        if (engagedWith.length > 1 || (engagedWith.length === 1 && engagedWith[0]!.id !== target.id))
          return { ok: false, reason: 'within control range of an enemy operative that is not the selected one' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(mindControlTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        const mine = ctx.rng.d6();
        const theirs = ctx.rng.d6();
        recordRoll(state, 'mindControl', [mine, theirs], op.player, 'MIND CONTROL roll-off');
        const myTotal = mine + aplOf(ctx, state, op);
        const theirTotal = theirs + aplOf(ctx, state, target);
        if (myTotal <= theirTotal) {
          log(state, {
            kind: 'action',
            player: op.player,
            text: `${op.letter}: MIND CONTROL fails on ${target.letter} (${myTotal} vs ${theirTotal})`,
          });
          return { ok: true };
        }
        // "You can only resolve this action's second effect once per battle."
        // REMINDER ONLY: the second effect itself — an operative cannot change sides and no intent
        // performs an action outside an activation. The token records the win for the UI.
        if (useOncePerBattle(state, `brood-brother.mindControl:${op.player}`)) {
          giveToken(state, target, MIND_CONTROL_TOKEN, {
            sourceId: ACT.mindControl,
            sourceText: shortQuote(actionTextOf(PATRIARCH, ACT.mindControl)),
            player: op.player,
            expiry: { kind: 'endOfActivation', operativeId: op.id },
          });
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: MIND CONTROL wins the roll-off against ${target.letter} (${myTotal} vs ${theirTotal})`,
        });
        return { ok: true };
      },
    }),
  );

  // ---- CONSPIRE — PRIMUS -------------------------------------------------
  out.push(
    uniqueAction(data, PRIMUS, ACT.conspire, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (usedThisTP(state, `brood-brother.conspire:${op.id}`))
          return { ok: false, reason: 'this operative cannot perform this action more than once per turning point' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        useOncePerTP(state, `brood-brother.conspire:${op.id}`);
        state.teams[op.player].cp += 1; // "[Y]ou gain 1CP."
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: CONSPIRE — +1CP` });
        return { ok: true };
      },
    }),
  );

  // ---- JAM — VOX-OPERATOR (2AP, plus the printed "+1 additional AP" variant)
  out.push(jamAction(ACT.jam, cardOf(VOX_OPERATOR).uniqueActions.find((a) => a.id === ACT.jam)!.ap, 'validTarget'));

  return out;
}

/** "Select one enemy operative visible to and within 2" of this operative." */
function mindControlTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  return enemiesOf(state, op)
    .filter((e) => baseGapBetween(ctx, op, e) <= 2 + EPS)
    .filter((e) => isVisible(index, body(ctx, op), body(ctx, e)).visible);
}

// ---------------------------------------------------------------------------
// Actions the universal ones forbid (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/**
 * KNIFE FIGHTER › Assassin: "This operative can perform the Charge action while it has a Conceal
 * order."  The universal Charge rejects a Conceal order outright and `canPerformAction` can only
 * forbid, so the carve-out is its own action that runs the same move validation and resolves
 * through the universal Charge (the Kommandos THROAT SLITTAS precedent).
 */
registerAction({
  id: ASSASSIN_CHARGE,
  name: ASSASSIN_CHARGE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(KNIFE_FIGHTER, AB.assassin),
  available: (_ctx, _state, op) => op.datacardId === KNIFE_FIGHTER,
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
    if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
      return { ok: false, reason: 'already within control range of an enemy operative' };
    if (['Reposition', 'Dash', 'Fall Back'].some((a) => did(op, a)))
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
 * PRIMUS › Fist of the Patriarch: "This operative can either perform two Shoot or two Fight actions
 * during its activation."  The reducer refuses a repeat of an action's restriction key, so the
 * SECOND one is its own `ActionDef` with its own id (the Kasrkin `Shoot (Rapid Fire)` precedent) —
 * and the printed "either… or" is enforced by refusing the extra Shoot once the extra Fight has
 * been used, and vice versa.
 */
function fistAction(id: string, name: string, delegate: 'Shoot' | 'Fight', other: string): ActionDef {
  return {
    id,
    name,
    ap: 1,
    type: 'unique',
    sourceText: abilityText(PRIMUS, AB.fistOfThePatriarch),
    available: (_ctx, _state, op) => op.datacardId === PRIMUS,
    check(ctx, state, op, params) {
      if (!did(op, delegate))
        return { ok: false, reason: `Fist of the Patriarch is the second ${delegate} action of an activation` };
      if (did(op, other)) return { ok: false, reason: 'either two Shoot or two Fight actions, not both' };
      return getAction(delegate)!.check(ctx, state, op, params);
    },
    perform: (ctx, state, op, params) => getAction(delegate)!.perform(ctx, state, op, params),
  };
}

registerAction(fistAction(FIST_SHOOT, FIST_SHOOT, 'Shoot', FIST_FIGHT));
registerAction(fistAction(FIST_FIGHT, FIST_FIGHT, 'Fight', FIST_SHOOT));

/**
 * JAM's printed alternative: "…or visible to this operative instead if you spend 1 additional AP."
 * The AP cost is a property of the `ActionDef`, so the dearer form is its own action sharing JAM's
 * restriction key through `treatedAs`.
 */
registerAction(jamAction(JAM_VISIBLE, cardOf(VOX_OPERATOR).uniqueActions.find((a) => a.id === ACT.jam)!.ap + 1, 'visible'));

// ---------------------------------------------------------------------------

export const broodBrother = defineTeam({
  id: 'brood-brother',
  rules: (reg, T) => {
    rules(reg, T);

    // ---- SAPPER › EXPLOSIVES: "…or during an activation in which it performed the Charge, Dash
    //      or Fall Back action (or vice versa)."  The "vice versa" half.
    reg.on('canPerformAction', T.bind(ACT.explosives, 12), (ev) => {
      if (ev.operative.player !== T.player || ev.operative.datacardId !== SAPPER) return;
      if (!['Charge', 'Dash', 'Fall Back'].includes(ev.action)) return;
      if (!did(ev.operative, ACT.explosives)) return;
      ev.allowed = false;
      ev.reason = 'it performed EXPLOSIVES during this activation';
    });

    // ---- VOX-OPERATOR › JAM: "…that enemy operative cannot be activated or perform actions."
    //      The activation half has no seam (reported); the ACTION half is enforced here.
    reg.on('canPerformAction', T.bind(ACT.jam, 12), (ev) => {
      const op = ev.operative;
      if (op.player === T.player) return; // the token belongs to this player, held by an enemy
      if (jamRemaining(ev.state, op.id) <= 0) return;
      // "…until it's the last enemy operative to be activated"
      if (!aliveOperatives(ev.state, op.player).some((o) => o.id !== op.id && o.ready)) return;
      ev.allowed = false;
      ev.reason = 'JAM: this operative cannot perform actions yet';
    });
    reg.on('onActivationEnd', T.bind(ACT.jam, 12), (ev) => {
      if (ev.operative.player === T.player) return;
      for (const eff of ev.state.effects.filter((e) => e.rule === JAM_TOKEN && e.player === T.player)) {
        const left = Number(eff.data?.['remaining'] ?? 0) - 1;
        if (left <= 0) dropEffects(ev.state, (e) => e.id === eff.id);
        else eff.data = { ...(eff.data ?? {}), remaining: left };
      }
    });
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy when selecting a valid target for a friendly BROOD BROTHER operative."
    [FP.ruthlessCoordination]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'only while a friendly BROOD BROTHER operative is acting' };
    },
    // "Use this firefight ploy when a friendly BROOD BROTHER operative … is shooting, fighting or
    //  retaliating, in the Roll Attack Dice step."
    [FP.idolisation]: (state, player) => {
      const seq = state.sequence;
      const ok =
        Boolean(seq) && (seq!.kind === 'shoot' ? seq!.attacker === player : seq!.attacker === player || seq!.defender === player);
      return ok ? { ok: true } : { ok: false, reason: 'only while a friendly operative is rolling attack dice' };
    },
    // "Use this firefight ploy after an activation… You cannot use this ploy during the first
    //  turning point."
    [FP.insidious]: (state) => {
      if (state.turningPoint <= 1) return { ok: false, reason: 'not during the first turning point' };
      return state.activeOperativeId
        ? { ok: false, reason: 'only between activations' }
        : { ok: true };
    },
  },
  aiHints: {
    roles: {
      [COMMANDER]: 'leader',
      [AGITATOR]: 'support',
      [GUNNER]: 'gunner',
      [ICONWARD]: 'objective',
      [KNIFE_FIGHTER]: 'melee',
      [MEDIC]: 'support',
      [SAPPER]: 'gunner',
      [SNIPER]: 'sniper',
      [TROOPER]: 'objective',
      [VETERAN]: 'melee',
      [VOX_OPERATOR]: 'support',
      [PSYCHIC_FAMILIAR]: 'scout',
      [MAGUS]: 'leader',
      [PATRIARCH]: 'leader',
      [PRIMUS]: 'leader',
    },
    ployValue: {
      [SP.pervasive]: 0.2,
      [SP.uprising]: 0.7,
      [SP.embedded]: 0.5,
      [SP.cultDevotion]: 0.4,
      [FP.ruthlessCoordination]: 0.6,
      [FP.unquestioningLoyalty]: 0.6,
      [FP.idolisation]: 0.7,
      [FP.insidious]: 0.3,
    },
    equipmentValue: {
      [EQ.cultTalisman]: 0.6,
      [EQ.covertGuises]: 0.4,
      [EQ.cultKnives]: 0.7,
      [EQ.lookout]: 0.5,
    },
  },
});

export default broodBrother;
