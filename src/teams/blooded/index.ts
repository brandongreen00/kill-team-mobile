/**
 * BLOODED — Traitor Guardsmen of the Militarum Traitoris.
 * https://wahapedia.ru/kill-team3/kill-teams/blooded/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is read
 * out of `data/teams/blooded.json` and is never retyped here.
 *
 * Thirteen datacards, 21 datacard abilities and FOUR unique actions hang off ONE faction rule:
 * **Blooded**, a token economy. Your unassigned Blooded tokens are a per-player pool
 * (`state.opState['blooded.pool']`); an assigned token is an `endOfBattle` effect on the operative
 * that holds it (the Plague Marines Poison / Brood Brother Crossfire shape), and GAZE OF THE GODS
 * is a second, `endOfTurningPoint` effect. Two datacard rules widen those two predicates rather
 * than placing tokens — the CHIEFTAIN's Lead With Strength and the SHARPSHOOTER's A Name Whispered
 * In Blood — so both are read through `tokenFor()` / `gazeFor()` at every call site.
 *
 * The faction rule's last clause ("you can retain one of your normal successes as a result of the
 * Accurate 1 weapon rule as a critical success instead") promotes the auto-retained Accurate die in
 * the pool, which only `onRollAttack` can reach — and `shoot.ts` alone emits it (D-031), so it is
 * live when a Blooded operative SHOOTS and unreachable when it fights or retaliates. Named in
 * `REMINDER_ONLY` rather than implied to be complete.
 *
 * Three rare weapon rules are printed and all three resolve against this team's own datacard
 * abilities through `rareRuleTextFor` (D-033): `BloodOffering` (BUTCHER), `Shield` (TRENCH SWEEPER,
 * through the `onBlockAllocation` seam the Imperial Navy Breachers' ENDURANT opened) and `Stalk`
 * (FLENSER).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import {
  EXPLOSIVE_ID,
  grenadeAllowance,
  grenadeWeapon,
  GRENADE_WEAPON_NAMES,
} from '../../core/equipment/grenades.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { baseWhollyWithin } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  enemiesInControlRange,
  findProfile,
  gapBetween,
  inControlRange,
  inflictDamage,
  log,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { baseDistanceToPart, hasType } from '../../core/terrain.ts';
import type {
  BaseShape,
  GameState,
  OperativeState,
  PlayerId,
  Poly,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { coverAndObscured, isVisible } from '../../core/visibility.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  defineTeam,
  makeTeamHooks,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  FREE_ACTION_RULE,
  gambitUsed,
  giveToken,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  hasToken,
  isInjuredCard,
  notEngaged,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisBattle,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('blooded');
const KW = 'BLOODED';
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

export const CARD = {
  chieftain: 'blooded.traitor-chieftain',
  brimstone: 'blooded.traitor-brimstone-grenadier',
  butcher: 'blooded.traitor-butcher',
  commsman: 'blooded.traitor-commsman',
  corpseman: 'blooded.traitor-corpseman',
  enforcer: 'blooded.traitor-enforcer',
  flenser: 'blooded.traitor-flenser',
  gunner: 'blooded.traitor-gunner',
  ogryn: 'blooded.traitor-ogryn',
  sharpshooter: 'blooded.traitor-sharpshooter',
  thug: 'blooded.traitor-thug',
  trenchSweeper: 'blooded.traitor-trench-sweeper',
  trooper: 'blooded.traitor-trooper',
} as const;

export const RULE_BLOODED = 'blooded.rule.blooded';

export const SP = {
  gloryKill: 'blooded.sp.glory-kill',
  recklessAspirant: 'blooded.sp.reckless-aspirant',
  malevolentGrit: 'blooded.sp.malevolent-grit',
  bitterDemise: 'blooded.sp.bitter-demise',
} as const;

export const FP = {
  callousDisregard: 'blooded.fp.callous-disregard',
  momentOfRepute: 'blooded.fp.moment-of-repute',
  rewardEarned: 'blooded.fp.reward-earned',
  darkFavour: 'blooded.fp.dark-favour',
} as const;

export const EQ = {
  chaosSigil: 'blooded.eq.chaos-sigil',
  sinisterTrophies: 'blooded.eq.sinister-trophies',
  symbolsOfBloodyWorship: 'blooded.eq.symbols-of-bloody-worship',
  wickedBlades: 'blooded.eq.wicked-blades',
} as const;

export const AB = {
  bloodedIcon: 'blooded.traitor-chieftain.blooded-icon',
  leadWithStrength: 'blooded.traitor-chieftain.lead-with-strength',
  grenadier: 'blooded.traitor-brimstone-grenadier.grenadier',
  explosiveDemise: 'blooded.traitor-brimstone-grenadier.explosive-demise',
  unholySustenance: 'blooded.traitor-butcher.unholy-sustenance',
  bloodOffering: 'blooded.traitor-butcher.blood-offering',
  stimmRules: 'blooded.traitor-corpseman.stimm-rules',
  regularDosage: 'blooded.traitor-corpseman.regular-dosage',
  gruellingDisciplinarian: 'blooded.traitor-enforcer.gruelling-disciplinarian',
  stalk: 'blooded.traitor-flenser.stalk',
  wretched: 'blooded.traitor-flenser.wretched',
  avalancheOfMuscle: 'blooded.traitor-ogryn.avalanche-of-muscle',
  chemEnhanced: 'blooded.traitor-ogryn.chem-enhanced',
  brute: 'blooded.traitor-ogryn.brute',
  slowWitted: 'blooded.traitor-ogryn.slow-witted',
  camoCloak: 'blooded.traitor-sharpshooter.camo-cloak',
  whisperedInBlood: 'blooded.traitor-sharpshooter.a-name-whispered-in-blood',
  tough: 'blooded.traitor-thug.tough',
  shield: 'blooded.traitor-trench-sweeper.shield',
  shielding: 'blooded.traitor-trench-sweeper.shielding',
  groupActivation: 'blooded.traitor-trooper.group-activation',
} as const;

export const ACT = {
  signal: 'blooded.traitor-commsman.act.signal',
  sacrilegiousActuation: 'blooded.traitor-commsman.act.sacrilegious-actuation',
  stimms: 'blooded.traitor-corpseman.act.stimms',
  enforce: 'blooded.traitor-enforcer.act.enforce',
} as const;

/** A rule granting an action the universal one forbids gets its own `ActionDef` (D-021). */
export const CHARGE_WRETCHED = 'Charge (Wretched)';

/** The faction rule's own STRATEGIC GAMBIT, and the SHARPSHOOTER's. Both cost 0CP. */
export const BLOODED_GAMBIT = 'blooded.gambit.blooded';
export const WHISPER_GAMBIT = 'blooded.gambit.a-name-whispered-in-blood';

// ---------------------------------------------------------------------------
// Tokens, effects and scratch bags (never module-level state — architecture rule 7)
// ---------------------------------------------------------------------------

/** The printed marker guide names each of these. */
export const BLOODED_TOKEN = 'blooded.token';
export const GAZE = 'blooded.gaze';
export const STIMM_TOKEN = 'blooded.stimm';
export const SHIELDING = 'blooded.shielding';
export const CALLOUS = 'blooded.callousDisregard';
export const ENFORCED = 'blooded.enforced';
export const SIGNAL_EFFECT = 'blooded.signal';
export const REPUTE_EFFECT = 'blooded.momentOfRepute';
export const DISCIPLINARIAN = 'blooded.gruellingDisciplinarian';
export const GROUP_ACTIVATION = 'blooded.groupActivation';

const POOL_BAG = 'blooded.pool';
const WHISPER_BAG = 'blooded.whispered';
const GLORY_BAG = 'blooded.gloryKill';
const REWARD_BAG = 'blooded.rewardEarned';
const STIMM_BAG = 'blooded.stimmUsed';
const BLOODLETTER_BAG = 'blooded.dealtDamage';

export type StimmRule = 'Rejuvenated' | 'Enraged' | 'Fortified';
export const STIMM_RULES: StimmRule[] = ['Rejuvenated', 'Enraged', 'Fortified'];

/**
 * The three STIMM rules are printed as ONE ability with no ids — the Kasrkin SKILL AT ARMS /
 * Warpcoven BOONS shape — so each is sliced out of the committed text at load rather than retyped.
 */
export function stimmText(rule: StimmRule): string {
  const line = abilityText(CARD.corpseman, AB.stimmRules)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`${rule.toLowerCase()}:`));
  if (!line) throw new Error(`No printed STIMM rule '${rule}' in data/teams/blooded.json`);
  return line;
}

// ---------------------------------------------------------------------------
// The Blooded token economy
// ---------------------------------------------------------------------------

/** "…any of your unassigned Blooded tokens." */
export function bloodedPool(state: GameState, player: PlayerId): number {
  return Number(bucket(state, POOL_BAG)[player] ?? 0);
}

function setPool(state: GameState, player: PlayerId, n: number): void {
  bucket(state, POOL_BAG)[player] = Math.max(0, n);
}

/** "You gain one Blooded token." */
export function gainBloodedToken(state: GameState, player: PlayerId, why: string): void {
  setPool(state, player, bloodedPool(state, player) + 1);
  log(state, {
    kind: 'action',
    player,
    text: `Blooded: gain one Blooded token (${why}) — ${bloodedPool(state, player)} unassigned`,
    data: { source: RULE_BLOODED },
  });
}

/** Does this operative physically hold one of `player`'s Blooded tokens? */
export function hasBloodedToken(state: GameState, operativeId: string, player: PlayerId): boolean {
  return hasToken(state, operativeId, BLOODED_TOKEN, player);
}

/** "…assign any of your unassigned Blooded tokens to friendly BLOODED operatives." */
export function assignBloodedToken(state: GameState, op: OperativeState, player: PlayerId): boolean {
  if (bloodedPool(state, player) <= 0) return false;
  // "Each operative cannot have more than one of your Blooded tokens."
  if (hasBloodedToken(state, op.id, player)) return false;
  setPool(state, player, bloodedPool(state, player) - 1);
  giveToken(state, op, BLOODED_TOKEN, {
    sourceId: RULE_BLOODED,
    sourceText: shortQuote(text(RULE_BLOODED)),
    player,
    expiry: { kind: 'endOfBattle' },
  });
  return true;
}

export function tokenHolders(state: GameState, player: PlayerId): OperativeState[] {
  return aliveOperatives(state, player).filter((o) => hasBloodedToken(state, o.id, player));
}

/** "…to be under the GAZE OF THE GODS until the end of the turning point." */
export function setGaze(state: GameState, op: OperativeState, player: PlayerId): void {
  if (effectOn(state, op.id, GAZE)) return;
  effect(state, {
    rule: GAZE,
    source: { kind: 'ability', id: RULE_BLOODED },
    sourceText: shortQuote(text(RULE_BLOODED)),
    operativeId: op.id,
    player,
    expiry: { kind: 'endOfTurningPoint' },
  });
  log(state, { kind: 'action', player, text: `${op.letter} is under the GAZE OF THE GODS` });
}

/** The enemy operative the SHARPSHOOTER named with A Name Whispered In Blood, if any. */
export function whisperedTarget(state: GameState, player: PlayerId): string | undefined {
  const id = bucket(state, WHISPER_BAG)[player];
  return typeof id === 'string' ? id : undefined;
}

/** The enemy operative GLORY KILL named this turning point, if any. */
export function gloryKillTarget(state: GameState, player: PlayerId): string | undefined {
  const rec = bucket(state, GLORY_BAG)[player] as { tp: number; id: string } | undefined;
  return rec && rec.tp === state.turningPoint ? rec.id : undefined;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * `useOncePerSequence` stamps on (kind, attacker, target), which repeats when the SAME two
 * operatives meet again later in the battle — so the key carries the activation as well.
 */
const seqKey = (state: GameState, rule: string): string =>
  `${rule}:${state.turningPoint}:${state.activationsThisTP}:${state.activeOperativeId ?? ''}`;

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

function baseOf(T: TeamHooks, op: OperativeState): BaseShape {
  return T.card(op)?.base ?? { shape: 'round', mm: 32 };
}

const territoryOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.territories[state.setup.dropZone[player] ?? player] ?? [];

/** "…wholly within your opponent's territory." */
function whollyInEnemyTerritory(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  const polys = territoryOf(state, otherPlayer(T.player));
  return polys.length > 0 && baseWhollyWithin(op.pos, baseOf(T, op), op.rot, polys);
}

function inCR(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return T.gap(a, b) <= 1 + EPS;
  return inControlRange(T.ctx, state, a, b);
}

function visibleTo(T: TeamHooks, state: GameState, from: OperativeState, to: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, from), body(T.ctx, to)).visible;
}

/**
 * "Whenever a friendly BLOODED operative has one of your Blooded tokens…"
 *
 * `target` is the operative it is shooting: A Name Whispered In Blood makes the SHARPSHOOTER count
 * as holding a token against ONE named enemy, so every reader has to pass the shot's target.
 */
export function tokenFor(T: TeamHooks, state: GameState, op: OperativeState, target?: OperativeState): boolean {
  if (op.player !== T.player || !T.kw(op, KW)) return false;
  if (hasBloodedToken(state, op.id, T.player)) return true;
  if (op.datacardId === CARD.sharpshooter && target && whisperedTarget(state, T.player) === target.id) return true;
  return false;
}

/** "…if that friendly BLOODED operative is under the GAZE OF THE GODS…" */
export function gazeFor(T: TeamHooks, state: GameState, op: OperativeState, target?: OperativeState): boolean {
  if (op.player !== T.player) return false;
  if (effectOn(state, op.id, GAZE)) return true;
  // CHIEFTAIN › Lead With Strength.
  if (
    op.datacardId === CARD.chieftain &&
    (hasBloodedToken(state, op.id, T.player) || whollyInEnemyTerritory(T, state, op))
  )
    return true;
  // SHARPSHOOTER › A Name Whispered In Blood.
  if (op.datacardId === CARD.sharpshooter && target && whisperedTarget(state, T.player) === target.id) return true;
  return false;
}

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

/** The operative dealing the damage currently being inflicted on `victim`, read off the sequence. */
function dealerOf(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') return state.operatives[seq.attackerId];
  const id = seq.defenderId === victim.id ? seq.attackerId : seq.attackerId === victim.id ? seq.defenderId : undefined;
  return id ? state.operatives[id] : undefined;
}

/** The melee weapon name the dealer is striking with, for WICKED BLADES. */
function dealerWeaponName(state: GameState, victim: OperativeState): string | undefined {
  const seq = fightSeq(state);
  if (!seq) return undefined;
  if (seq.defenderId === victim.id) return seq.attackerWeapon;
  if (seq.attackerId === victim.id) return seq.defenderWeapon;
  return undefined;
}

// ---------------------------------------------------------------------------
// Faction rule, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // Blooded — where the tokens come from
  // =========================================================================
  // "You gain one Blooded token: In the Ready step of each Strategy phase."
  reg.on('onReadyStep', T.bind(RULE_BLOODED, 11), (ev) => {
    if (ev.player !== T.player) return;
    gainBloodedToken(ev.state, T.player, 'Ready step');
  });

  // "The first time an enemy operative is incapacitated during each turning point." /
  // "The first time a friendly operative is incapacitated within 6\" of an enemy operative during
  //  each turning point."  Priority 40 so any rule that PREVENTS the incapacitation has run first.
  reg.on('onIncapacitated', T.bind(RULE_BLOODED, 40), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (victim.player !== T.player) {
      if (useOncePerTP(ev.state, `blooded.enemyIncap:${T.player}`))
        gainBloodedToken(ev.state, T.player, 'an enemy operative was incapacitated');
      return;
    }
    const near = aliveOperatives(ev.state, otherPlayer(T.player)).some((e) => T.gap(e, victim) <= 6 + EPS);
    if (!near) return;
    if (useOncePerTP(ev.state, `blooded.friendIncap:${T.player}`))
      gainBloodedToken(ev.state, T.player, 'a friendly operative was incapacitated within 6" of an enemy');
  });

  // =========================================================================
  // Blooded — the STRATEGIC GAMBIT
  // =========================================================================
  // "As a STRATEGIC GAMBIT, you can assign any of your unassigned Blooded tokens to friendly
  //  BLOODED operatives… Then, if four or more friendly operatives in the killzone have one of your
  //  Blooded tokens, you can select one of them to be under the GAZE OF THE GODS."
  reg.on('gambitOptions', T.bind(RULE_BLOODED, 15), (ev) => {
    if (ev.player !== T.player) return;
    const untaken = T.friendlies(ev.state, KW).filter((o) => !hasBloodedToken(ev.state, o.id, T.player));
    const holders = tokenHolders(ev.state, T.player);
    const canAssign = bloodedPool(ev.state, T.player) > 0 && untaken.length > 0;
    const canGaze = holders.length >= 4 && !holders.some((o) => effectOn(ev.state, o.id, GAZE));
    if (!canAssign && !canGaze) return;
    ev.options.push({
      id: BLOODED_GAMBIT,
      label: `Blooded: assign ${bloodedPool(ev.state, T.player)} Blooded token(s) (0CP)`,
      sourceText: shortQuote(text(RULE_BLOODED)),
    });
  });
  reg.on('onPloyUsed', T.bind(RULE_BLOODED, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== BLOODED_GAMBIT) return;
    // D-016: the assignment order comes from the gambit's `data` when the UI supplies it, and is a
    // deterministic, logged default otherwise.
    const wanted = (ev.data?.['operativeIds'] as string[] | undefined) ?? [];
    const untaken = T.friendlies(ev.state, KW)
      .filter((o) => !hasBloodedToken(ev.state, o.id, T.player))
      .sort(byId);
    const order = [
      ...wanted.map((id) => untaken.find((o) => o.id === id)).filter((o): o is OperativeState => Boolean(o)),
      ...untaken,
    ];
    const seen = new Set<string>();
    for (const op of order) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      if (!assignBloodedToken(ev.state, op, T.player)) continue;
    }
    const holders = tokenHolders(ev.state, T.player);
    if (holders.length < 4) return;
    if (holders.some((o) => effectOn(ev.state, o.id, GAZE))) return;
    const chosenId = ev.data?.['gazeOperativeId'];
    const pick = holders.find((o) => o.id === chosenId) ?? [...holders].sort(byId)[0];
    if (pick) setGaze(ev.state, pick, T.player);
  });

  // =========================================================================
  // Blooded — Accurate 1, and the GAZE OF THE GODS promotion
  // =========================================================================
  // "Whenever a friendly BLOODED operative has one of your Blooded tokens, its weapons have the
  //  Accurate 1 weapon rule."  `onWeaponRules` is read by `effectiveRules` and by `sideWeapon` for
  //  both sides of a fight, so shooting, fighting AND retaliating are all live.
  reg.on('onWeaponRules', T.bind(RULE_BLOODED, 12), (ev) => {
    if (!mine(ev.operative)) return;
    if (!tokenFor(T, ev.state, ev.operative, ev.type === 'ranged' ? ev.target : undefined)) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (Blooded)'));
  });
  // "…you can retain one of your normal successes as a result of the Accurate 1 weapon rule as a
  //  critical success instead."  The auto-retained die exists only after `addAutoNormal`, and the
  //  only hook emitted after that is `onRollAttack` — which `fight.ts` does not emit (D-031).
  reg.on('onRollAttack', T.bind(RULE_BLOODED, 13), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || !mine(ev.ctx.attacker)) return;
    const target = ev.ctx.defender;
    if (!tokenFor(T, ev.state, ev.ctx.attacker, target)) return;
    if (!gazeFor(T, ev.state, ev.ctx.attacker, target)) return;
    const die = seq.attack.dice.find((d) => !d.rolled && d.state === 'normal' && (d.note ?? '').startsWith('Accurate'));
    if (!die) return;
    if (!useOncePerSequence(ev.state, seqKey(ev.state, `blooded.gazeCrit:${T.player}`))) return;
    die.state = 'crit';
    die.note = 'Accurate 1 (GAZE OF THE GODS)';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `GAZE OF THE GODS: ${ev.ctx.attacker.letter} retains the Accurate 1 success as a critical success`,
    });
  });

  // =========================================================================
  // CHIEFTAIN › Blooded Icon
  // =========================================================================
  // "Once per turning point, when a friendly BLOODED operative that has one of your Blooded tokens
  //  is incapacitated, if this operative is within 6\" of it, you can regain that token."
  reg.on('onIncapacitated', T.bind(AB.bloodedIcon, 41), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (!mine(victim) || !hasBloodedToken(ev.state, victim.id, T.player)) return;
    const chief = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.chieftain && T.gap(o, victim) <= 6 + EPS,
    );
    if (!chief) return;
    if (!useOncePerTP(ev.state, `blooded.bloodedIcon:${T.player}`)) return;
    dropEffects(ev.state, (e) => e.rule === BLOODED_TOKEN && e.operativeId === victim.id && e.player === T.player);
    gainBloodedToken(ev.state, T.player, `Blooded Icon — ${chief.letter} regains ${victim.letter}'s token`);
  });

  // CHIEFTAIN › Lead With Strength — "Whenever this operative has one of your Blooded tokens or is
  // wholly within your opponent's territory, treat it as if it's under the GAZE OF THE GODS."
  // A predicate, not an event: `gazeFor()` reads it at every call site.

  // =========================================================================
  // BRIMSTONE GRENADIER › Grenadier
  // =========================================================================
  // "This operative can use frag and krak grenades (see universal equipment)." The two explosive
  // grenades are weapons, so they are granted whether or not the kill team took the equipment.
  const armGrenadier = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === CARD.brimstone)) {
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
  // The universal Explosive Grenades limiter runs at priority 10 on this hook; the BRIMSTONE
  // GRENADIER is exempt, so it is re-allowed at a later priority.
  reg.on('onSelectWeapon', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== CARD.brimstone) return;
    if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName)) return;
    ev.allowed = true;
    delete ev.reason;
  });
  // "Doing so doesn't count towards any limited uses you have" — the equipment's spender runs at
  // priority 10 on this hook, so its increment is handed straight back.
  reg.on('onCollectAttackDice', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== CARD.brimstone) return;
    if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName) || ev.ctx.secondary) return;
    const choice = /krak/i.test(ev.ctx.weaponName) ? 'krak' : 'frag';
    if (grenadeAllowance(ev.state, T.player, EXPLOSIVE_ID, choice) <= 0) return;
    const uses = ev.state.teams[T.player].equipmentUses;
    const key = `used:${EXPLOSIVE_ID}:${choice}`;
    uses[key] = Math.max(0, (uses[key] ?? 0) - 1);
  });
  // "Whenever it's doing so, improve the Hit stat of that weapon by 1."
  reg.on('onStatMod', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.brimstone) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!GRENADE_WEAPON_NAMES.includes(seq.weaponName)) return;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // BRIMSTONE GRENADIER › Explosive Demise
  // =========================================================================
  // "If this operative is incapacitated, before it's removed from the killzone, you can use this
  //  rule. If you do, roll two D6, or one D6 if this operative is within control range of an enemy
  //  operative. If any result is a 4+, inflict D3+2 damage on each operative visible to and within
  //  2\" of this operative (roll separately for each). If this operative hasn't used its diabolyk
  //  bomb during the battle, inflict D6+2 damage instead."
  // "You can use this rule" is free, so it is auto-used on a stated policy (D-022).
  reg.on('onIncapacitated', T.bind(AB.explosiveDemise, 30), (ev) => {
    if (ev.prevented || !T.ctx) return;
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.brimstone) return;
    if (!useOncePerBattle(ev.state, `blooded.explosiveDemise:${op.id}`)) return;
    const engagedNow = enemiesInControlRange(T.ctx, ev.state, op).length > 0;
    const rolls = engagedNow ? [T.ctx.rng.d6()] : [T.ctx.rng.d6(), T.ctx.rng.d6()];
    recordRoll(ev.state, 'explosiveDemise', rolls, T.player, engagedNow ? 'Explosive Demise 1D6 4+' : 'Explosive Demise 2D6 4+');
    if (!rolls.some((r) => r >= 4)) return;
    const unused = (op.weaponUses['Diabolyk bomb'] ?? 0) === 0;
    const victims = aliveOperatives(ev.state)
      .filter((o) => o.id !== op.id && T.gap(op, o) <= 2 + EPS && visibleTo(T, ev.state, op, o))
      .sort(byId);
    for (const victim of victims) {
      const roll = unused ? T.ctx.rng.d6() : T.ctx.rng.d3();
      recordRoll(ev.state, 'explosiveDemise', [roll], T.player, unused ? 'D6+2' : 'D3+2');
      inflictDamage(T.ctx, ev.state, victim, roll + 2, 'other');
    }
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Explosive Demise: ${op.letter} detonates (${rolls.join(', ')}) — ${victims.length} operative(s) caught`,
    });
  });

  // =========================================================================
  // BUTCHER › Unholy Sustenance
  // =========================================================================
  // "Whenever this operative is fighting or retaliating, if it incapacitates the enemy operative in
  //  that sequence, it regains up to D3 lost wounds."
  reg.on('onIncapacitated', T.bind(AB.unholySustenance, 31), (ev) => {
    if (ev.prevented || !T.ctx) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.defenderId !== ev.operative.id && seq.attackerId !== ev.operative.id) return;
    const butcher = dealerOf(ev.state, ev.operative);
    if (!butcher || butcher.player !== T.player || butcher.datacardId !== CARD.butcher) return;
    const heal = T.ctx.rng.d3();
    recordRoll(ev.state, 'unholySustenance', [heal], T.player, 'Unholy Sustenance D3');
    healUpTo(T, ev.state, butcher, heal, 'Unholy Sustenance');
  });

  // =========================================================================
  // BUTCHER › Blood Offering (rare weapon rule)
  // =========================================================================
  // "Whenever this operative is fighting or retaliating with this weapon, the first time you strike
  //  with a critical success during that sequence, you gain one Blooded token."
  reg.on('onStrikeResolved', T.bind(AB.bloodOffering, 12), (ev) => {
    if (ev.ctx.type !== 'melee' || !ev.crit) return;
    const striker = ev.ctx.attacker;
    if (striker.player !== T.player || striker.datacardId !== CARD.butcher) return;
    if (!ev.ctx.rules.some((r) => r.id === 'BloodOffering')) return;
    if (!useOncePerSequence(ev.state, seqKey(ev.state, `blooded.bloodOffering:${striker.id}`))) return;
    gainBloodedToken(ev.state, T.player, 'Blood Offering');
  });

  // =========================================================================
  // CORPSEMAN › STIMM Rules
  // =========================================================================
  // Enraged: "The operative's melee weapons have the Relentless weapon rule."
  reg.on('onWeaponRules', T.bind(AB.stimmRules, 12), (ev) => {
    if (ev.type !== 'melee' || ev.operative.player !== T.player) return;
    if (!hasStimm(ev.state, ev.operative.id, 'Enraged')) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Enraged)'));
  });
  // Fortified: "Whenever an attack dice inflicts damage of 3 or more on the operative, roll one D6:
  //  on a 5+, subtract 1 from that inflicted damage."
  reg.on('onDamage', T.bind(AB.stimmRules, 13), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    if (ev.target.player !== T.player || !hasStimm(ev.state, ev.target.id, 'Fortified')) return;
    const incoming = incomingProfile(T, ev.state, ev.target);
    if (!incoming) return;
    // A fight strike is one dice; a shoot aggregates its unblocked dice into one call, so the test
    // is applied per unblocked success whose own damage is 3 or more.
    const perDie = fortifiedDice(ev.state, ev.target, incoming, ev.amount);
    let saved = 0;
    for (const dmg of perDie) {
      if (dmg < 3) continue;
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'fortified', [roll], T.player, 'Fortified 5+');
      if (roll >= 5) saved += 1;
    }
    if (saved === 0) return;
    ev.amount = Math.max(0, ev.amount - saved);
    log(ev.state, { kind: 'action', player: T.player, text: `Fortified: ${ev.target.letter} takes ${saved} less damage` });
  });

  // =========================================================================
  // CORPSEMAN › Regular Dosage
  // =========================================================================
  // "At the end of the Select Operatives step, if this operative is selected for deployment, you
  //  can select one other friendly BLOODED operative to gain one STIMM rule for the battle
  //  (excluding Rejuvenated)."  Select Operatives has no decision channel (docs/TEAM-STATUS.md §
  //  Known engine gaps), so the pick is a deterministic, logged default (D-016): Enraged, on the
  //  lowest-id other friendly BLOODED operative that has a melee weapon.
  const regularDosage = (state: GameState): void => {
    if (usedThisBattle(state, `blooded.regularDosage:${T.player}`)) return;
    if (!T.friendlies(state).some((o) => o.datacardId === CARD.corpseman)) return;
    const target = T.friendlies(state, KW)
      .filter((o) => o.datacardId !== CARD.corpseman)
      .sort(byId)[0];
    if (!target) return;
    useOncePerBattle(state, `blooded.regularDosage:${T.player}`);
    giveStimm(state, target, 'Enraged', T.player);
  };
  reg.on('onDeploy', T.bind(AB.regularDosage, 14), (ev) => {
    if (ev.operative.player === T.player) regularDosage(ev.state);
  });
  // …with the same idempotent safety nets `Grenadier` uses, because a battle built without the
  // DeployOperative intent (the test harness, a restored save) never emits `onDeploy`.
  reg.on('onActivationStart', T.bind(AB.regularDosage, 14), (ev) => regularDosage(ev.state));
  reg.on('onReadyStep', T.bind(AB.regularDosage, 14), (ev) => {
    if (ev.player === T.player) regularDosage(ev.state);
  });

  // =========================================================================
  // ENFORCER › Gruelling Disciplinarian
  // =========================================================================
  // "Whenever a friendly BLOODED operative is activated within 6\" of this operative, you can ignore
  //  any changes to that operative's stats from being injured until the end of its activation
  //  (including its weapons' stats)."
  reg.on('onActivationStart', T.bind(AB.gruellingDisciplinarian, 12), (ev) => {
    const op = ev.operative;
    if (!mine(op)) return;
    const enforcer = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.enforcer && o.id !== op.id && T.gap(o, op) <= 6 + EPS,
    );
    if (!enforcer) return;
    effect(ev.state, {
      rule: DISCIPLINARIAN,
      source: { kind: 'ability', id: AB.gruellingDisciplinarian },
      sourceText: shortQuote(abilityText(CARD.enforcer, AB.gruellingDisciplinarian)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Gruelling Disciplinarian: ${op.letter} ignores being injured` });
  });
  // Injured costs an operative 2" of Move and worsens its weapons' Hit stat by 1 (`moveOf` /
  // `hitOf`); both are cancelled here rather than by faking the wound count.
  reg.on('onStatMod', T.bind(AB.gruellingDisciplinarian, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, DISCIPLINARIAN)) return;
    if (!isInjuredCard(T.card(ev.operative), ev.operative)) return;
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // ENFORCE — the free action's two printed limits
  // =========================================================================
  // "…but it cannot move more than 2\" during that action."
  reg.on('onMoveDistance', T.bind(ACT.enforce, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!spendingEnforce(ev.state, ev.operative)) return;
    ev.inches = Math.min(ev.inches, 2);
  });
  // "If the selected friendly operative is a COMMSMAN, it cannot perform the Sacrilegious Actuation
  //  or Signal actions."
  reg.on('canPerformAction', T.bind(ACT.enforce, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.commsman) return;
    if (ev.action !== ACT.signal && ev.action !== ACT.sacrilegiousActuation) return;
    if (!spendingEnforce(ev.state, ev.operative)) return;
    ev.allowed = false;
    ev.reason = 'ENFORCE: a COMMSMAN cannot perform Sacrilegious Actuation or Signal for free';
  });

  // =========================================================================
  // FLENSER › Stalk (rare weapon rule)
  // =========================================================================
  // "Whenever this operative is fighting or retaliating with this weapon, if Light or Heavy terrain
  //  is within its control range, this weapon has the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind(AB.stalk, 12), (ev) => {
    if (ev.type !== 'melee' || ev.operative.player !== T.player) return;
    if (ev.operative.datacardId !== CARD.flenser) return;
    if (!ev.rules.some((r) => r.id === 'Stalk')) return;
    if (!coverTerrainInControlRange(T, ev.state, ev.operative)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Stalk)'));
  });

  // =========================================================================
  // FLENSER › Wretched
  // =========================================================================
  // "This operative can perform the Charge action while it has a Conceal order." — its own
  // `ActionDef` (D-021), registered at module load below.
  //
  // "If this operative is incapacitated during the Fight action, you can strike the enemy operative
  //  in that sequence with one of your unresolved successes before this operative is removed from
  //  the killzone."  Free, so auto-used (D-022); the success is taken crit-first.
  reg.on('onIncapacitated', T.bind(AB.wretched, 32), (ev) => {
    if (ev.prevented || !T.ctx) return;
    const flenser = ev.operative;
    if (flenser.player !== T.player || flenser.datacardId !== CARD.flenser) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const side = seq.attackerId === flenser.id ? 'attacker' : seq.defenderId === flenser.id ? 'defender' : undefined;
    if (!side) return;
    if (!useOncePerSequence(ev.state, seqKey(ev.state, `blooded.wretched:${flenser.id}`))) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const die = pool.dice.find((d) => d.state === 'crit') ?? pool.dice.find((d) => d.state === 'normal');
    if (!die) return;
    const foe = ev.state.operatives[side === 'attacker' ? seq.defenderId : seq.attackerId];
    if (!foe || foe.removed) return;
    const { profile } = sideWeapon(T.ctx, ev.state, seq, side);
    const crit = die.state === 'crit';
    die.state = 'struck';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Wretched: ${flenser.letter} strikes ${foe.letter} for ${crit ? profile.dmgC : profile.dmgN} as it dies`,
    });
    inflictDamage(T.ctx, ev.state, foe, crit ? profile.dmgC : profile.dmgN, 'attack');
  });

  // =========================================================================
  // OGRYN › Avalanche of Muscle
  // =========================================================================
  // "Whenever this operative ends its move during the Charge action, you can inflict D3 damage on
  //  one enemy operative within its control range."  Nothing runs at the end of an ACTION
  //  (docs/TEAM-STATUS.md § Known engine gaps), so it is bounded to the end of the activation the
  //  Charge happened in — the Legionary MALIGNANT AURA precedent.
  reg.on('onActivationEnd', T.bind(AB.avalancheOfMuscle, 12), (ev) => {
    const op = ev.operative;
    if (!T.ctx || op.player !== T.player || op.datacardId !== CARD.ogryn) return;
    if (!did(op, 'Charge')) return;
    const victim = enemiesInControlRange(T.ctx, ev.state, op).sort(byId)[0];
    if (!victim) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'avalancheOfMuscle', [d3], T.player, 'Avalanche of Muscle D3');
    log(ev.state, { kind: 'action', player: T.player, text: `Avalanche of Muscle: ${op.letter} crushes ${victim.letter}` });
    inflictDamage(T.ctx, ev.state, victim, d3, 'other');
  });

  // =========================================================================
  // OGRYN › Chem-enhanced
  // =========================================================================
  // "You can ignore any changes to this operative's APL stat and it's not affected by enemy
  //  operatives' Shock and Stun weapon rules."
  // `aplOf` reads `op.aplMods` PLUS `onStatMod.apl`, so cancelling the running total at a late
  // priority ignores every change, whichever channel it arrived through. A granted free action is
  // not one of those changes: it is AP outside the APL budget (`freeApOf`, docs/DECISIONS.md
  // D-100), so it neither needs excusing here nor may be added back — doing so would put free AP
  // into the APL STAT, which is what marker control totals.
  reg.on('onStatMod', T.bind(AB.chemEnhanced, 90), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.ogryn) return;
    const raw = ev.operative.aplMods.reduce((a, b) => a + b, 0);
    ev.mods.apl = -raw;
  });
  reg.on('onWeaponRules', T.bind(AB.chemEnhanced, 13), (ev) => {
    if (ev.operative.player === T.player) return; // an ENEMY operative's weapon
    if (!ev.target || ev.target.player !== T.player || ev.target.datacardId !== CARD.ogryn) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Shock' && r.id !== 'Stun');
  });

  // =========================================================================
  // OGRYN › Brute
  // =========================================================================
  // "Whenever your opponent is selecting a valid target, if this operative has a Conceal order, it
  //  cannot use Light terrain for cover. While this can allow this operative to be targeted
  //  (assuming it's visible), it doesn't remove its cover save (if any)."
  reg.on('onValidTarget', T.bind(AB.brute, 12), (ev) => {
    if (ev.target.player !== T.player || ev.target.datacardId !== CARD.ogryn) return;
    if (ev.attacker.player === T.player || ev.target.order !== 'conceal') return;
    if (ev.ignoreCoverTerrain === 'none') ev.ignoreCoverTerrain = 'light';
  });
  // …and the cover save is handed back, because `checkTarget` uses ONE `inCover` for both the
  // Conceal-order validity test and the save.
  reg.on('onDefenceDice', T.bind(AB.brute, 13), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || ev.count <= 0 || !T.ctx) return;
    const ogryn = ev.ctx.defender;
    if (!ogryn || ogryn.player !== T.player || ogryn.datacardId !== CARD.ogryn) return;
    if (ogryn.order !== 'conceal' || seq.inCover) return;
    if (ev.ctx.rules.some((r) => r.id === 'Saturate')) return;
    // Re-derive the cover the OGRYN would have had but for Brute's own Light carve-out, honouring
    // the weapon's own Seek / Seek Light (which deny that cover for a different reason). Vantage's
    // ignore filter is not reapplied here — an approximation noted in docs/TEAM-STATUS.md.
    const seekAll = ev.ctx.rules.some((r) => r.id === 'Seek');
    const seekLight = ev.ctx.rules.some((r) => r.id === 'SeekLight');
    const index = terrain(T.ctx, ev.state);
    const withLight = coverAndObscured(index, body(T.ctx, ev.ctx.attacker), body(T.ctx, ogryn), {
      ignoreCoverTerrain: seekAll ? 'all' : seekLight ? 'light' : 'none',
    });
    if (!withLight.inCover) return;
    ev.coverSave = true;
    log(ev.state, { kind: 'action', player: T.player, text: `Brute: ${ogryn.letter} keeps its cover save` });
  });

  // =========================================================================
  // OGRYN › Slow-witted
  // =========================================================================
  // "You must spend 1 additional AP for this operative to perform the Pick Up Marker and mission
  //  actions (excluding Operate Hatch)."
  reg.on('onActionCost', T.bind(AB.slowWitted, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.ogryn) return;
    if (ev.action === 'Operate Hatch') return;
    const isMission = getAction(ev.action)?.type === 'mission';
    if (ev.action !== 'Pick Up Marker' && !isMission) return;
    ev.ap += 1;
  });

  // =========================================================================
  // SHARPSHOOTER › Camo Cloak
  // =========================================================================
  // "Whenever an operative is shooting this operative, if you can retain any cover saves, you can
  //  retain one additional cover save. This isn't cumulative with improved cover saves from Vantage
  //  terrain."
  reg.on('onDefenceDice', T.bind(AB.camoCloak, 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== CARD.sharpshooter) return;
    if (!ev.coverSave) return;
    if (shootSeq(ev.state)?.vantageImprovedCover) return;
    ev.extraCoverSaves += 1;
  });

  // =========================================================================
  // SHARPSHOOTER › A Name Whispered In Blood
  // =========================================================================
  // "STRATEGIC GAMBIT in the first turning point. Select one enemy operative. Whenever this
  //  operative is shooting that enemy operative, treat this operative as if it has one of your
  //  Blooded tokens and is under the GAZE OF THE GODS."
  const whisperBinding = T.bind(AB.whisperedInBlood, 15);
  reg.on('gambitOptions', whisperBinding, (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (whisperedTarget(ev.state, T.player)) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === CARD.sharpshooter)) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: WHISPER_GAMBIT,
      label: 'A Name Whispered In Blood (0CP)',
      sourceText: shortQuote(abilityText(CARD.sharpshooter, AB.whisperedInBlood)),
    });
  });
  reg.on('onPloyUsed', whisperBinding, (ev) => {
    if (ev.player !== T.player || ev.ployId !== WHISPER_GAMBIT) return;
    const wanted = ev.data?.['operativeId'];
    const foes = T.enemies(ev.state).sort(byId);
    const pick = foes.find((o) => o.id === wanted) ?? foes[0];
    if (!pick) return;
    bucket(ev.state, WHISPER_BAG)[T.player] = pick.id;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `A Name Whispered In Blood: ${pick.letter} is marked`,
      data: { operativeId: pick.id },
    });
  });

  // =========================================================================
  // THUG › Tough
  // =========================================================================
  // "Whenever this operative is fighting or retaliating, or an operative is shooting it, Normal Dmg
  //  of 3 or more inflicts 1 less damage on it."
  reg.on('onDamage', T.bind(AB.tough, 12), (ev) => {
    if (ev.kind !== 'attack') return;
    const thug = ev.target;
    if (thug.player !== T.player || thug.datacardId !== CARD.thug) return;
    const incoming = incomingProfile(T, ev.state, thug);
    if (!incoming || incoming.profile.dmgN < 3) return;
    let normals: number;
    if (incoming.melee) {
      if (ev.amount !== incoming.profile.dmgN) return; // a critical success is unaffected
      normals = 1;
    } else {
      const seq = shootSeq(ev.state);
      normals = seq ? seq.attack.dice.filter((d) => d.state === 'normal').length : 0;
      if (normals === 0) return;
    }
    ev.amount = Math.max(0, ev.amount - normals);
    log(ev.state, { kind: 'action', player: T.player, text: `Tough: ${thug.letter} takes ${normals} less damage` });
  });

  // =========================================================================
  // TRENCH SWEEPER › Shield (rare weapon rule)
  // =========================================================================
  // "Whenever this operative is fighting or retaliating with this weapon, each of your blocks can be
  //  allocated to block two unresolved successes (instead of one)."
  reg.on('onBlockAllocation', T.bind(AB.shield, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return; // `attacker` is the operative doing the blocking
    if (ev.ctx.attacker.datacardId !== CARD.trenchSweeper) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Shield')) return;
    ev.blocks = 2;
  });

  // =========================================================================
  // TRENCH SWEEPER › Shielding
  // =========================================================================
  // "Whenever this operative is activated, you can use this rule. If you do, until the start of this
  //  operative's next activation: Subtract 2\" from its Move stat. Whenever an operative is shooting
  //  this operative, you can re-roll any of your defence dice."
  // D-022 policy: taken whenever no enemy operative is within the operative's Move stat + 2" — i.e.
  // whenever the 2" it gives up cannot buy it a Charge this activation.
  reg.on('onActivationStart', T.bind(AB.shielding, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.trenchSweeper) return;
    // "until the START of this operative's next activation" — the engine's endOfNextActivation
    // expiry runs one activation longer, so the previous grant is dropped here instead.
    dropEffects(ev.state, (e) => e.rule === SHIELDING && e.operativeId === op.id);
    const reach = (T.card(op)?.move ?? 6) + 2;
    if (T.enemies(ev.state).some((e) => T.gap(op, e) <= reach + EPS)) return;
    effect(ev.state, {
      rule: SHIELDING,
      source: { kind: 'ability', id: AB.shielding },
      sourceText: shortQuote(abilityText(CARD.trenchSweeper, AB.shielding)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Shielding: ${op.letter} braces (-2" Move)` });
  });
  reg.on('onStatMod', T.bind(AB.shielding, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, SHIELDING)) return;
    ev.mods.move -= 2;
  });
  reg.on('onDefenceDice', T.bind(AB.shielding, 14), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player) return;
    if (!effectOn(ev.state, target.id, SHIELDING)) return;
    ev.rerolls.push({
      id: 'blooded.shielding',
      label: 'Shielding: re-roll any of your defence dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(abilityText(CARD.trenchSweeper, AB.shielding)),
    });
  });

  // =========================================================================
  // TROOPER › Group Activation
  // =========================================================================
  // "Whenever this operative is expended, you must then activate one other ready friendly BLOODED
  //  TROOPER operative (if able) before your opponent activates."
  // PARTIAL: the engine alternates activations strictly, so the pairing is recorded as an effect for
  // the UI/AI (the Death Korps TROOPER / Brood Brother precedent).
  reg.on('onActivationEnd', T.bind(AB.groupActivation, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.trooper) return;
    // "…in other words, you cannot activate more than two operatives in succession with this rule."
    if (effectOn(ev.state, op.id, `${GROUP_ACTIVATION}.used`)) return;
    const other = T.friendlies(ev.state).find(
      (o) => o.id !== op.id && o.ready && o.datacardId === CARD.trooper,
    );
    if (!other) return;
    for (const rule of [GROUP_ACTIVATION, `${GROUP_ACTIVATION}.used`]) {
      effect(ev.state, {
        rule,
        source: { kind: 'ability', id: AB.groupActivation },
        sourceText: shortQuote(abilityText(CARD.trooper, AB.groupActivation)),
        operativeId: other.id,
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

  // =========================================================================
  // Upkeep
  // =========================================================================
  // A `grantFreeAction` effect expires at the end of the recipient's activation
  // (docs/DECISIONS.md D-100), which is exactly right when the ENFORCER enforces an operative that
  // still has an activation to come. ENFORCE hands the grant to ANOTHER operative, though, and
  // that operative may already be expended: its activation never ends again this turning point, so
  // nothing would clear the grant, and it would wake up next turning point still holding a free AP
  // nobody gave it. The Ready-step sweep below is that missing bound. The activation-end sweep
  // is what keeps the ENFORCED marker in step with the grant it belongs to — that marker lives for
  // one further activation of its own accord, and it means nothing once the free AP is gone.
  const clearSpentGrants = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (eff.source.id !== ACT.enforce) continue;
      dropEffects(state, (e) => e.id === eff.id);
      dropEffects(state, (e) => e.rule === ENFORCED && e.operativeId === op.id);
    }
  };
  reg.on('onActivationEnd', T.bindText('blooded.freeAction', actionTextOf(CARD.enforcer, ACT.enforce), 90), (ev) => {
    if (ev.operative.player === T.player) clearSpentGrants(ev.state, ev.operative);
  });
  reg.on('onReadyStep', T.bindText('blooded.freeAction', actionTextOf(CARD.enforcer, ACT.enforce), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) clearSpentGrants(ev.state, o);
  });

  // APL changes that ride an effect rather than leaking into `aplMods`.
  reg.on('onStatMod', T.bind(ACT.signal, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, SIGNAL_EFFECT)) ev.mods.apl += 1;
  });
  reg.on('onStatMod', T.bind(FP.momentOfRepute, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, REPUTE_EFFECT)) ev.mods.apl += 1;
  });
}

// ---------------------------------------------------------------------------
// Small rule helpers used by `rules`
// ---------------------------------------------------------------------------

function healUpTo(T: TeamHooks, state: GameState, op: OperativeState, amount: number, why: string): void {
  const max = T.card(op)?.wounds ?? op.wounds + amount;
  const before = op.wounds;
  op.wounds = Math.min(max, op.wounds + amount);
  if (op.wounds === before) return;
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${why}: ${op.letter} regains ${op.wounds - before} lost wound(s)`,
    data: { operativeId: op.id },
  });
}

/**
 * The per-dice damage the incoming attack is inflicting, for Fortified's "3 or more" test.
 * A fight resolves ONE success at a time, so the amount already IS that dice's damage; a shoot
 * aggregates every unblocked dice into one call, so they are re-derived from the pool.
 */
function fortifiedDice(
  state: GameState,
  victim: OperativeState,
  incoming: { profile: WeaponProfile; melee: boolean },
  amount: number,
): number[] {
  if (incoming.melee) return [amount];
  const seq = shootSeq(state);
  if (!seq || seq.targetId !== victim.id) return [amount];
  return [
    ...seq.attack.dice.filter((d) => d.state === 'crit').map(() => incoming.profile.dmgC),
    ...seq.attack.dice.filter((d) => d.state === 'normal').map(() => incoming.profile.dmgN),
  ];
}

/** "…if Light or Heavy terrain is within its control range." */
function coverTerrainInControlRange(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx) return false;
  const index = terrain(T.ctx, state);
  const base = baseOf(T, op);
  return index.parts.some(
    (p) =>
      (hasType(p, 'Light') || hasType(p, 'Heavy')) &&
      baseDistanceToPart(op.pos, base, op.rot, p) <= 1 + EPS,
  );
}

/** Is this operative currently spending the free AP ENFORCE gave it? */
function spendingEnforce(state: GameState, op: OperativeState): boolean {
  const eff = effectsOn(state, op.id, FREE_ACTION_RULE).find((e) => e.source.id === ACT.enforce);
  if (!eff) return false;
  return op.apSpent >= Number(eff.data?.['threshold'] ?? 0);
}

// ---------------------------------------------------------------------------
// STIMM rules
// ---------------------------------------------------------------------------

export function hasStimm(state: GameState, operativeId: string, rule: StimmRule): boolean {
  return state.effects.some((e) => e.rule === `${STIMM_TOKEN}.${rule}` && e.operativeId === operativeId);
}

/** "You cannot select each STIMM rule for each operative more than once per battle." */
export function stimmTaken(state: GameState, operativeId: string, rule: StimmRule): boolean {
  return Boolean(bucket(state, STIMM_BAG)[`${operativeId}:${rule}`]);
}

export function giveStimm(state: GameState, op: OperativeState, rule: StimmRule, player: PlayerId): void {
  bucket(state, STIMM_BAG)[`${op.id}:${rule}`] = true;
  // Rejuvenated is an immediate effect, not a lasting one.
  if (rule !== 'Rejuvenated') {
    effect(state, {
      rule: `${STIMM_TOKEN}.${rule}`,
      source: { kind: 'ability', id: AB.stimmRules },
      sourceText: stimmText(rule),
      operativeId: op.id,
      player,
      expiry: { kind: 'endOfBattle' },
    });
  }
  log(state, {
    kind: 'action',
    player,
    text: `${op.letter} gains the ${rule} STIMM rule`,
    data: { operativeId: op.id, stimm: rule },
  });
}

// ---------------------------------------------------------------------------
// Strategy and firefight ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // ---- GLORY KILL (strategy) ----------------------------------------------
  // "Select one enemy operative. Until the end of the turning point, whenever a friendly BLOODED
  //  operative is shooting against, fighting against or retaliating against that enemy operative,
  //  that shooting, fighting or retaliating operative's weapons have the Ceaseless weapon rule, or
  //  Relentless if it has one of your Blooded tokens."
  reg.on('onPloyUsed', T.bind(SP.gloryKill, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.gloryKill) return;
    const wanted = ev.data?.['operativeId'];
    // D-016: the named enemy comes from the gambit's `data`; the default is the toughest enemy
    // still standing (most wounds left), ties broken by id — deterministic and logged.
    const foes = T.enemies(ev.state).sort((a, b) => b.wounds - a.wounds || (a.id < b.id ? -1 : 1));
    const pick = foes.find((o) => o.id === wanted) ?? foes[0];
    if (!pick) return;
    bucket(ev.state, GLORY_BAG)[T.player] = { tp: ev.state.turningPoint, id: pick.id };
    log(ev.state, { kind: 'ploy', player: T.player, text: `GLORY KILL: ${pick.letter}`, data: { operativeId: pick.id } });
  });
  reg.on('onWeaponRules', T.bind(SP.gloryKill, 21), (ev) => {
    if (!mine(ev.operative) || !ev.target) return;
    if (gloryKillTarget(ev.state, T.player) !== ev.target.id) return;
    if (tokenFor(T, ev.state, ev.operative, ev.target))
      ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (GLORY KILL)'));
    else ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (GLORY KILL)'));
  });

  // ---- RECKLESS ASPIRANT (strategy) ---------------------------------------
  // "Whenever a friendly BLOODED operative that's wholly within your opponent's territory and
  //  doesn't have one of your Blooded tokens is shooting or fighting, its weapons have the
  //  Accurate 1 weapon rule.  Whenever a friendly BLOODED operative that has one of your Blooded
  //  tokens is wholly within your opponent's territory, its weapons have the Punishing weapon rule."
  reg.on('onWeaponRules', T.bind(SP.recklessAspirant, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.recklessAspirant)) return;
    if (!mine(ev.operative)) return;
    if (!whollyInEnemyTerritory(T, ev.state, ev.operative)) return;
    const token = tokenFor(T, ev.state, ev.operative, ev.type === 'ranged' ? ev.target : undefined);
    if (token) {
      ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (RECKLESS ASPIRANT)'));
      return;
    }
    // "is shooting or fighting" — a retaliation is neither.
    if (ev.retaliating) return;
    ev.rules.push(ruleTag('Accurate', 1, 'Accurate 1 (RECKLESS ASPIRANT)'));
  });

  // ---- MALEVOLENT GRIT (strategy) -----------------------------------------
  // "Whenever an operative is shooting a friendly BLOODED operative that has one of your Blooded
  //  tokens or is wholly within your opponent's territory, you can re-roll one of your defence
  //  dice."
  reg.on('onDefenceDice', T.bind(SP.malevolentGrit, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.malevolentGrit)) return;
    const target = ev.ctx.defender;
    if (!target || !mine(target)) return;
    if (!hasBloodedToken(ev.state, target.id, T.player) && !whollyInEnemyTerritory(T, ev.state, target)) return;
    ev.rerolls.push({
      id: 'blooded.malevolentGrit',
      label: 'MALEVOLENT GRIT: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(SP.malevolentGrit)),
    });
  });

  // ---- BITTER DEMISE (strategy) -------------------------------------------
  // "Whenever a friendly BLOODED operative is incapacitated, before it's removed from the killzone,
  //  roll one D3: on a 3 (or 2+ if that friendly operative has one of your Blooded tokens), inflict
  //  damage equal to the result on one enemy operative visible to and within 2\" of that friendly
  //  operative."
  reg.on('onIncapacitated', T.bind(SP.bitterDemise, 33), (ev) => {
    if (ev.prevented || !T.ctx) return;
    if (!gambitUsed(ev.state, T.player, SP.bitterDemise)) return;
    const victim = ev.operative;
    if (!mine(victim)) return;
    if (!useOncePerBattle(ev.state, `blooded.bitterDemise:${victim.id}`)) return;
    const d3 = T.ctx.rng.d3();
    const threshold = hasBloodedToken(ev.state, victim.id, T.player) ? 2 : 3;
    recordRoll(ev.state, 'bitterDemise', [d3], T.player, `BITTER DEMISE ${threshold}+`);
    if (d3 < threshold) return;
    const foe = T.enemies(ev.state)
      .filter((o) => T.gap(victim, o) <= 2 + EPS && visibleTo(T, ev.state, victim, o))
      .sort(byId)[0];
    if (!foe) return;
    log(ev.state, { kind: 'ploy', player: T.player, text: `BITTER DEMISE: ${victim.letter} takes ${foe.letter} with it (${d3})` });
    inflictDamage(T.ctx, ev.state, foe, d3, 'other');
  });

  // ---- CALLOUS DISREGARD (firefight) --------------------------------------
  // "Use this firefight ploy when a friendly BLOODED operative performs the Shoot action and you're
  //  selecting a valid target. Having other friendly BLOODED operatives within an enemy operative's
  //  control range doesn't prevent that enemy operative from being selected. Until the end of that
  //  action, whenever you discard an attack dice as a fail, inflict damage equal to the dice result
  //  on one friendly operative of your choice within control range of the target."
  reg.on('onPloyUsed', T.bind(FP.callousDisregard, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.callousDisregard) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !mine(active)) return;
    // "Until the end of that ACTION" — nothing runs at the end of an action, so the window is the
    // activation (one Shoot action per activation under action restrictions).
    effect(ev.state, {
      rule: CALLOUS,
      source: { kind: 'ploy', id: FP.callousDisregard },
      sourceText: shortQuote(text(FP.callousDisregard)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
  });
  reg.on('onValidTarget', T.bind(FP.callousDisregard, 21), (ev) => {
    if (ev.attacker.player !== T.player || !effectOn(ev.state, ev.attacker.id, CALLOUS)) return;
    if (!T.kw(ev.attacker, KW)) return;
    // Only friendly BLOODED operatives are ignored, so the lift applies only when every friendly in
    // the target's control range is one.
    const blockers = T.friendlies(ev.state).filter((f) => f.id !== ev.attacker.id && inCR(T, ev.state, f, ev.target));
    if (blockers.length === 0 || !blockers.every((f) => T.kw(f, KW))) return;
    ev.ignoreFriendlyControlRange = true;
  });
  // The attack pool's fails are final at the Roll Defence Dice step, which is the first hook emitted
  // after they are discarded — `dice.ts` has no discard seam of its own.
  reg.on('onDefenceDice', T.bind(FP.callousDisregard, 22), (ev) => {
    if (!T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player !== T.player || !effectOn(ev.state, attacker.id, CALLOUS)) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target) return;
    const fails = seq.attack.dice.filter((d) => d.state === 'fail' && d.rolled);
    if (fails.length === 0) return;
    if (!useOncePerSequence(ev.state, seqKey(ev.state, `blooded.callous:${T.player}`))) return;
    for (const die of fails) {
      // "…on one friendly operative of your choice within control range of the target"; the
      // deterministic default is the lowest-id one (D-016).
      const victim = T.friendlies(ev.state)
        .filter((f) => f.id !== attacker.id && inCR(T, ev.state, f, target))
        .sort(byId)[0];
      if (!victim) return;
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `CALLOUS DISREGARD: ${victim.letter} takes ${die.value} damage from a discarded fail`,
      });
      inflictDamage(T.ctx, ev.state, victim, die.value, 'other');
    }
  });

  // ---- MOMENT OF REPUTE (firefight) ---------------------------------------
  // "Use this firefight ploy during the activation of a friendly BLOODED operative that's under the
  //  GAZE OF THE GODS, before or after it performs an action. Until the end of that operative's
  //  activation, add 1 to its APL stat."
  reg.on('onPloyUsed', T.bind(FP.momentOfRepute, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.momentOfRepute) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!active || !mine(active) || !gazeFor(T, ev.state, active)) return;
    effect(ev.state, {
      rule: REPUTE_EFFECT,
      source: { kind: 'ploy', id: FP.momentOfRepute },
      sourceText: shortQuote(text(FP.momentOfRepute)),
      operativeId: active.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: active.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `MOMENT OF REPUTE: ${active.letter} gains 1 APL` });
  });

  // ---- REWARD EARNED (firefight) ------------------------------------------
  // "Use this firefight ploy when an enemy operative is incapacitated by a friendly BLOODED
  //  operative within 2\" of it that has one of your Blooded tokens. You gain one Blooded token."
  reg.on('onIncapacitated', T.bind(FP.rewardEarned, 34), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (victim.player === T.player) return;
    const killer = dealerOf(ev.state, victim);
    if (!killer || !mine(killer)) return;
    if (!hasBloodedToken(ev.state, killer.id, T.player)) return;
    if (T.gap(killer, victim) > 2 + EPS) return;
    bucket(ev.state, REWARD_BAG)[T.player] = ev.state.turningPoint;
  });
  reg.on('onPloyUsed', T.bind(FP.rewardEarned, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.rewardEarned) return;
    delete bucket(ev.state, REWARD_BAG)[T.player];
    gainBloodedToken(ev.state, T.player, 'REWARD EARNED');
  });

  // ---- DARK FAVOUR (firefight) --------------------------------------------
  // "Use this firefight ploy when a friendly BLOODED operative that has one of your Blooded tokens
  //  is selected as the valid target of a Shoot action or to fight against during the Fight action.
  //  Select one other friendly BLOODED operative visible to and within 3\" of that first friendly
  //  operative to become the valid target… This ploy has no effect if it's the Shoot action and the
  //  ranged weapon has the Blast or Torrent weapon rule."
  reg.on('onSelectTarget', T.bind(FP.darkFavour, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.darkFavour)) return;
    if (ev.attacker.player === T.player) return;
    const first = ev.target;
    if (!mine(first) || !hasBloodedToken(ev.state, first.id, T.player)) return;
    if (ev.rules.some((r) => r.id === 'Blast' || r.id === 'Torrent')) return;
    if (!useOncePerBattle(ev.state, `blooded.darkFavour:${T.player}:${ev.state.turningPoint}`)) return;
    const shield = T.friendlies(ev.state, KW)
      .filter((o) => o.id !== first.id && T.gap(first, o) <= 3 + EPS && visibleTo(T, ev.state, first, o))
      .sort(byId)[0];
    if (!shield) return;
    ev.redirectTo = shield.id;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `DARK FAVOUR: ${shield.letter} is targeted instead of ${first.letter}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

const WICKED_BLADE_WEAPONS = ['bayonet', 'bayonet & shield', 'improvised blade'];

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // ---- CHAOS SIGIL --------------------------------------------------------
  // "The Reward Earned firefight ploy costs you 0CP."  CP is deducted before `onPloyUsed` fires
  // (docs/TEAM-STATUS.md § Known engine gaps), so the discount is a refund.
  reg.on('onPloyUsed', T.bind(EQ.chaosSigil, 30), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.rewardEarned) return;
    if (!hasEquipment(ev.state, T.player, EQ.chaosSigil)) return;
    const cp = DATA.firefightPloys.find((p) => p.id === FP.rewardEarned)?.cp ?? 1;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Chaos Sigil: Reward Earned costs 0CP (${cp}CP refunded)` });
  });

  // ---- SINISTER TROPHIES --------------------------------------------------
  // "…your opponent cannot re-roll their attack dice results of 1."  REMINDER ONLY: a `RerollGrant`
  // has no way to exclude a dice VALUE, and the option list is built inside `rerollDecision` from
  // the pool. No handler is registered — one would be the silent no-op architecture rule 5 forbids.

  // ---- SYMBOLS OF BLOODY WORSHIP ------------------------------------------
  // "Whenever a friendly BLOODED operative ends an action, if it wasn't incapacitated but inflicted
  //  damage on any enemy operatives during that action, it regains 1 lost wound."
  // Nothing runs at the end of an ACTION, so the window is the activation (a known engine gap): the
  // wound comes back once per activation rather than once per damaging action.
  reg.on('onDamage', T.bind(EQ.symbolsOfBloodyWorship, 60), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.symbolsOfBloodyWorship)) return;
    if (ev.amount <= 0 || ev.target.player === T.player) return;
    const dealer = dealerOf(ev.state, ev.target);
    if (!dealer || !mine(dealer)) return;
    bucket(ev.state, BLOODLETTER_BAG)[dealer.id] = `${ev.state.turningPoint}:${ev.state.activationsThisTP}`;
  });
  reg.on('onActivationEnd', T.bind(EQ.symbolsOfBloodyWorship, 31), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.symbolsOfBloodyWorship)) return;
    const op = ev.operative;
    if (!mine(op) || op.incapacitated || op.removed) return;
    const stamp = bucket(ev.state, BLOODLETTER_BAG)[op.id];
    if (stamp !== `${ev.state.turningPoint}:${ev.state.activationsThisTP}`) return;
    delete bucket(ev.state, BLOODLETTER_BAG)[op.id];
    healUpTo(T, ev.state, op, 1, 'Symbols of Bloody Worship');
  });

  // ---- WICKED BLADES ------------------------------------------------------
  // "Add 1 to both Dmg stats of each friendly BLOODED operative's bayonet, bayonet & shield and
  //  improvised blade for the battle."  Applied where the damage is inflicted, never by rewriting a
  //  shared `WeaponProfile` (D-019).
  reg.on('onDamage', T.bind(EQ.wickedBlades, 30), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!hasEquipment(ev.state, T.player, EQ.wickedBlades)) return;
    const dealer = dealerOf(ev.state, ev.target);
    if (!dealer || !mine(dealer)) return;
    const weapon = dealerWeaponName(ev.state, ev.target);
    if (!weapon || !WICKED_BLADE_WEAPONS.includes(weapon.trim().toLowerCase())) return;
    ev.amount += 1;
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** "…one other friendly BLOODED operative (excluding OGRYN) visible to and within 6\"." */
function signalTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  const reach = supportDistance(ctx, state, op, 6); // SUPPORT: a Comms Device widens it
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => o.datacardId !== CARD.ogryn)
    .filter((o) => gapBetween(ctx, op, o) <= reach + EPS)
    .filter((o) => isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort(byId);
}

/** "…one friendly BLOODED operative within this operative's control range" (itself included). */
function stimmTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, op.player)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => o.id === op.id || inControlRange(ctx, state, op, o))
    .sort(byId);
}

/** "…one other friendly BLOODED operative visible to and within 3\" of this operative." */
function enforceTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id)
    .filter((o) => (ctx.datacards.get(o.datacardId)?.keywords ?? []).includes(KW))
    .filter((o) => gapBetween(ctx, op, o) <= 3 + EPS)
    .filter((o) => isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort(byId);
}

const pick = (list: OperativeState[], chosen?: string): OperativeState | undefined =>
  list.find((o) => o.id === chosen) ?? list[0];

/** The (target, STIMM rule) pair STIMMS would apply, so `check` and `perform` never disagree. */
function stimmChoice(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: { targetOperativeId?: string; targetId?: string; choice?: string },
): { target: OperativeState; rule: StimmRule } | undefined {
  const targets = stimmTargets(ctx, state, op);
  const wanted = params.targetOperativeId ?? params.targetId;
  const ordered = [...targets.filter((o) => o.id === wanted), ...targets];
  for (const target of ordered) {
    const free = STIMM_RULES.filter((r) => !stimmTaken(state, target.id, r));
    if (free.length === 0) continue;
    const named = STIMM_RULES.find((r) => r.toLowerCase() === (params.choice ?? '').toLowerCase());
    if (named && free.includes(named)) return { target, rule: named };
    // Deterministic default: heal a wounded operative, otherwise the melee buff, otherwise the save.
    const card = ctx.datacards.get(target.datacardId);
    const wounded = card !== undefined && target.wounds < card.wounds;
    const order: StimmRule[] = wounded ? ['Rejuvenated', 'Enraged', 'Fortified'] : ['Enraged', 'Fortified', 'Rejuvenated'];
    const chosen = order.find((r) => free.includes(r));
    if (chosen) return { target, rule: chosen };
  }
  return undefined;
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    // SIGNAL 1AP — COMMSMAN
    uniqueAction(data, CARD.commsman, ACT.signal, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(signalTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly BLOODED operative (excluding OGRYN) visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(signalTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        effect(state, {
          rule: SIGNAL_EFFECT,
          source: { kind: 'ability', id: ACT.signal },
          sourceText: shortQuote(actionTextOf(CARD.commsman, ACT.signal)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: SIGNAL — ${target.letter} +1 APL` });
        return { ok: true };
      },
    }),

    // SACRILEGIOUS ACTUATION 1AP — COMMSMAN
    uniqueAction(data, CARD.commsman, ACT.sacrilegiousActuation, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        // "…or if it doesn't have one of your Blooded tokens."
        if (!hasBloodedToken(state, op.id, op.player))
          return { ok: false, reason: 'it does not have one of your Blooded tokens' };
        return { ok: true };
      },
      perform: (_ctx, state, op) => {
        gainBloodedToken(state, op.player, `SACRILEGIOUS ACTUATION (${op.letter})`);
        return { ok: true };
      },
    }),

    // STIMMS 1AP — CORPSEMAN
    uniqueAction(data, CARD.corpseman, ACT.stimms, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return stimmChoice(ctx, state, op, params)
          ? { ok: true }
          : { ok: false, reason: 'no friendly BLOODED operative within control range has a STIMM rule left' };
      },
      perform: (ctx, state, op, params) => {
        const { target, rule } = stimmChoice(ctx, state, op, params)!;
        giveStimm(state, target, rule, op.player);
        if (rule === 'Rejuvenated') {
          const heal = ctx.rng.d3() + ctx.rng.d3();
          recordRoll(state, 'rejuvenated', [heal], op.player, 'Rejuvenated 2D3');
          const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
          target.wounds = Math.min(max, target.wounds + heal);
        }
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: STIMMS — ${target.letter} (${rule})` });
        return { ok: true };
      },
    }),

    // ENFORCE 1AP — ENFORCER
    uniqueAction(data, CARD.enforcer, ACT.enforce, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        return pick(enforceTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly BLOODED operative visible to and within 3"' };
      },
      perform: (ctx, state, op, params) => {
        const target = pick(enforceTargets(ctx, state, op), params.targetOperativeId ?? params.targetId)!;
        grantFreeAction(state, target, {
          sourceId: ACT.enforce,
          sourceText: shortQuote(actionTextOf(CARD.enforcer, ACT.enforce)),
          kind: 'ability',
          // The free AP is always the LAST one the operative spends (D-100), so the 2" cap and
          // the COMMSMAN carve-out only bite once its own APL is used up.
          threshold: aplOf(ctx, state, target),
        });
        effect(state, {
          rule: ENFORCED,
          source: { kind: 'ability', id: ACT.enforce },
          sourceText: shortQuote(actionTextOf(CARD.enforcer, ACT.enforce)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: ENFORCE — ${target.letter} acts for free` });
        return { ok: true };
      },
    }),
  ];
}

/**
 * FLENSER › Wretched: "This operative can perform the Charge action while it has a Conceal order."
 * The universal Charge rejects a Conceal order outright and `canPerformAction` can only forbid, so
 * the carve-out is its own action that runs the same move validation and resolves through the
 * universal Charge (the Kommandos THROAT SLITTAS / Brood Brother Assassin precedent, D-021).
 */
registerAction({
  id: CHARGE_WRETCHED,
  name: CHARGE_WRETCHED,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(CARD.flenser, AB.wretched),
  available: (_ctx, _state, op) => op.datacardId === CARD.flenser,
  check(ctx, state, op, params) {
    if (op.order !== 'conceal') return { ok: false, reason: 'use the normal Charge action with an Engage order' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'already within control range of an enemy operative' };
    if (['Reposition', 'Dash', 'Fall Back'].some((a) => did(op, a)))
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    // "That operative cannot move more than 2\" … while counteracting" — the universal Charge
    // applies the same cap inside its own check, so this one has to as well (D-026).
    const counteracting = state.opState['counteract']?.['operativeId'] === op.id;
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Charge',
      bonusInches: 2,
      mayEnterEnemyControlRange: true,
      mustFinishEngaged: true,
      ...(counteracting ? { hardCap: 2 } : {}),
    });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  perform: (ctx, state, op, params) => getAction('Charge')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// What is NOT implemented, and why
// ---------------------------------------------------------------------------

export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE_BLOODED}.gazeCritInFight`]:
    'the GAZE OF THE GODS promotion ("retain one of your normal successes as a result of the Accurate 1 weapon rule as a critical success instead") rewrites the auto-retained die AFTER addAutoNormal, and onRollAttack is the only hook emitted after that point — fight.ts does not emit it (D-031), so the promotion is exact when a Blooded operative SHOOTS and unreachable when it fights or retaliates',
  [`${FP.darkFavour}.fight`]:
    'the Fight half ("to be fought against … instead", and treating that operative as within the fighting operative\'s control range) has no seam: startFight takes its defender straight from the intent and fight.ts emits neither onSelectTarget nor onValidTarget; the Shoot half is exact, cover/obscured inheritance and the Blast/Torrent carve-out included',
  [EQ.sinisterTrophies]:
    'a RerollGrant cannot exclude a dice VALUE — rerollDecision builds its options from the pool inside shoot.ts/fight.ts — so "your opponent cannot re-roll their attack dice results of 1" has no seam at all; registering a handler would be the silent no-op CLAUDE.md architecture rule 5 forbids',
  [`${AB.avalancheOfMuscle}.endOfMove`]:
    'nothing runs at the end of an ACTION (only onActivationStart/onActivationEnd), so "whenever this operative ends its move during the Charge action" is bounded to the end of the activation the Charge happened in — the D3 lands after any Fight the OGRYN made in the same activation instead of before it',
  [`${EQ.symbolsOfBloodyWorship}.perAction`]:
    'the same end-of-action gap: "whenever a friendly BLOODED operative ends an action" is bounded to the end of its activation, so the wound comes back once per activation rather than once per damaging action',
  [`${FP.callousDisregard}.window`]:
    '"until the end of that action" is bounded to the activation (endOfActivation), and the fail damage is applied at the Roll Defence Dice step — the first hook emitted after the attack pool\'s fails are final, because dice.ts has no discard seam',
  [`${ACT.enforce}.immediate`]:
    'D-013: the engine has no intent for performing an action outside an activation, so "that operative can immediately perform a 1AP action for free" lands as one extra AP on the recipient\'s NEXT activation — free AP outside its APL budget (D-100), not an APL stat change; the 2" movement cap and the COMMSMAN carve-out are both enforced on that AP',
  [`${AB.groupActivation}.order`]:
    'the engine alternates activations strictly and there is no activation-order seam, so "you must then activate one other ready friendly BLOODED TROOPER operative before your opponent activates" is recorded as an effect for the UI/AI rather than enforced (the Death Korps TROOPER / Brood Brother precedent)',
  [`${AB.regularDosage}.choice`]:
    'Select Operatives has no decision channel, so "you can select one other friendly BLOODED operative to gain one STIMM rule" is a deterministic, logged default (Enraged, lowest-id other friendly BLOODED) rather than a player choice (D-016)',
  'blooded.selection.custom':
    'selection.constraints carries {kind:"custom"} — "In other words, you can only have one operative with a plasma weapon" — and `custom` is the one constraint kind validateRosterFor has no branch for (D-036). It cannot be re-expressed as a maxItem either: "plasma weapon" is a weapon CLASS (Plasma pistol on the CHIEFTAIN, Plasma gun on the GUNNER), not a weapon NAME, and maxItem matches by name with only a plural tolerance (D-040)',
  'blooded.selection.exclusive':
    'selection.constraints also carries {kind:"exclusive", group:"^2"} — "You cannot select this option and this operative" — and `exclusive` has NO branch in validateRosterFor at all (the enforced kinds are uniqueExcept, maxCount, requires, groupCap, halfSelection, distinctOptions, sameAsAbove, every, maxItem and exclusiveItems). It is the same printed footnote as the custom constraint above',
};

// ---------------------------------------------------------------------------

export const blooded = defineTeam({
  id: 'blooded',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy when a friendly BLOODED operative performs the Shoot action…"
    [FP.callousDisregard]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player
        ? { ok: true }
        : { ok: false, reason: 'only during the activation of a friendly BLOODED operative' };
    },
    // "…during the activation of a friendly BLOODED operative that's under the GAZE OF THE GODS."
    [FP.momentOfRepute]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player) return { ok: false, reason: 'only during a friendly activation' };
      // The same predicate the ploy's own handler uses, so Lead With Strength counts here too.
      return gazeFor(makeTeamHooks(DATA, player), state, active)
        ? { ok: true }
        : { ok: false, reason: 'that operative is not under the GAZE OF THE GODS' };
    },
    // "…when an enemy operative is incapacitated by a friendly BLOODED operative within 2" of it
    //  that has one of your Blooded tokens."
    [FP.rewardEarned]: (state, player) =>
      bucket(state, REWARD_BAG)[player] === state.turningPoint
        ? { ok: true }
        : { ok: false, reason: 'no enemy operative has been incapacitated by a token-bearer within 2"' },
    // "…when a friendly BLOODED operative that has one of your Blooded tokens is selected as the
    //  valid target of a Shoot action or to fight against during the Fight action."
    [FP.darkFavour]: (state, player) => {
      const holders = aliveOperatives(state, player).filter((o) => hasBloodedToken(state, o.id, player));
      return holders.length > 0
        ? { ok: true }
        : { ok: false, reason: 'no friendly BLOODED operative has one of your Blooded tokens' };
    },
  },
  aiHints: {
    roles: {
      [CARD.chieftain]: 'leader',
      [CARD.brimstone]: 'gunner',
      [CARD.butcher]: 'melee',
      [CARD.commsman]: 'support',
      [CARD.corpseman]: 'support',
      [CARD.enforcer]: 'support',
      [CARD.flenser]: 'melee',
      [CARD.gunner]: 'gunner',
      [CARD.ogryn]: 'melee',
      [CARD.sharpshooter]: 'sniper',
      [CARD.thug]: 'melee',
      [CARD.trenchSweeper]: 'objective',
      [CARD.trooper]: 'objective',
    },
    ployValue: {
      [SP.gloryKill]: 0.6,
      [SP.recklessAspirant]: 0.5,
      [SP.malevolentGrit]: 0.5,
      [SP.bitterDemise]: 0.4,
      [FP.callousDisregard]: 0.3,
      [FP.momentOfRepute]: 0.7,
      [FP.rewardEarned]: 0.6,
      [FP.darkFavour]: 0.6,
    },
    equipmentValue: {
      [EQ.chaosSigil]: 0.4,
      [EQ.sinisterTrophies]: 0.4,
      [EQ.symbolsOfBloodyWorship]: 0.6,
      [EQ.wickedBlades]: 0.7,
    },
  },
});

export default blooded;
export { KW };
