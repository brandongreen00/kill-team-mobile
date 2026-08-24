/**
 * FELLGOR RAVAGERS — Chaos. https://wahapedia.ru/kill-team3/kill-teams/fellgor-ravager/
 *
 * Rule text is read from `data/teams/fellgor-ravager.json` and never retyped; every hook carries
 * a short verbatim quote of the printed rule in its `RuleBinding`.
 *
 * Eleven datacards, ONE faction rule, fifteen datacard abilities and seven unique actions.
 * Everything hangs off **Frenzy**, which is unlike any other faction rule in the game: a friendly
 * FELLGOR RAVAGER operative that would be incapacitated is not — it gains a Frenzy token instead
 * and keeps fighting under six printed consequences, until one of five printed triggers kills it.
 *
 *  - **The token is a per-player effect on the operative** (`FRENZY_TOKEN`, the marker guide's
 *    "Frenzy token"). It is handed out from `onIncapacitated`, which is the ONE moment the engine
 *    offers: `inflictDamage` sets `incapacitated`, emits the hook, and honours `prevented` by
 *    restoring the operative at 1 wound. That is also exactly the printed moment for the last
 *    bullet — "your opponent treats a FELLGOR RAVAGER operative as being incapacitated … when it
 *    gains one of your Frenzy tokens … for faction rules that require it to be incapacitated" —
 *    because every enemy `onIncapacitated` handler in the tree fires on that same emit. Only the
 *    **VP half** of that bullet is reminder-only: op scoring lives in `src/core/ops/**`.
 *  - **"It's injured" holds by construction**: the prevention leaves the operative on 1 wound, so
 *    `isInjured` is already true. A defensive `onStatMod` supplies the −2" Move / +1 Hit if a heal
 *    ever lifted it back above half wounds (APOPLECTIC REJUVENATION and Headtaker both refuse a
 *    Frenzy-token operative, so nothing in this team can).
 *  - **The five incapacitation triggers apply the incapacitation WITHOUT re-emitting
 *    `onIncapacitated`** (the Canoptek Dimensional Banishment shape). That is what the last bullet
 *    asks for — the opponent already counted it when the token was gained — and it is also the only
 *    way the prevention above does not simply fire again.
 *
 * Three of the four printed rare weapon rules are defined on this team's OWN datacards (Headtaker
 * on the GOREHORN, Tactual Hunter on the MANGLER, Vicious Blows on the VANDAL), so `rareRuleTextFor`
 * (docs/DECISIONS.md D-033) resolves each to the datacard ability — byte-identical to
 * `_rare-weapon-rules.json` here, pinned by a test. `PSYCHIC` is a tag with no printed definition.
 *
 * Seams this module leans on, all established by earlier batches:
 *  - the post-roll `onWeaponRules` emit both sequences make (`advanceFight` calls `sideWeapon` at
 *    the re-roll and retention steps; `advanceShoot` calls `effectiveRules` every iteration) —
 *    the Hearthkyn Grudge / Void Dancer WRAITHBONE TALISMAN seam, which is how VIOLENT TEMPERAMENT,
 *    AMBUSH and GORE MARKS reach a FIGHT despite `fight.ts` emitting no `onRollAttack` (D-031);
 *  - re-entering `resolveFightDie` from inside `onStrikeResolved` (Tactual Hunter — the Wyrmblade
 *    ASSASSINATE / Void Dancer CEGORACH'S JEST precedent);
 *  - one fewer defence dice rolled plus an auto-normal pushed post-roll (RECKLESS DETERMINATION —
 *    the Elucidian ARMOURED UNDERSUIT / Mandrakes GLOAMING SHROUD precedent);
 *  - `3 − Piercing` defence dice, so "worsen the x of Piercing by 1" is one more die (CHAOS SIGIL —
 *    the Corsair MISTFIELD / Void Dancer Harlequin's Panoply precedent).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import {
  addAutoNormal,
  countCrits,
  hasRule,
  piercingValue,
  rerollDie,
  successes,
  type DicePool,
} from '../../core/dice.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { withGrenadeBudgetIgnored } from '../../core/equipment/grenades.ts';
import { baseGap, dist } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { resolveFightDie, sideWeapon } from '../../core/sequences/fight.ts';
import { advanceShoot, checkTarget, effectiveRules, startShoot } from '../../core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  card,
  enemiesInControlRange,
  findProfile,
  gapBetween,
  hitOf,
  inControlRange,
  inflictDamage,
  isInjured,
  log,
  markerContestedBy,
  modelHeight,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { isVisible, coverAndObscured, type Body } from '../../core/visibility.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { BaseShape, GameState, OperativeState, Order, PlayerId, Vec2 } from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  FREE_ACTION_RULE,
  bucket,
  catalogueCard,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  gambitUsed,
  giveToken,
  grantFreeAction,
  hasEquipment,
  hasToken,
  notEngaged,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA: TeamData = teamData('fellgor-ravager');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

export const KW = 'FELLGOR RAVAGER';
const EPS = 1e-6;
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

export const CARD = {
  ironhorn: 'fellgor-ravager.ironhorn',
  deathknell: 'fellgor-ravager.deathknell',
  fluxbray: 'fellgor-ravager.fluxbray',
  gnarlscar: 'fellgor-ravager.gnarlscar',
  gorehorn: 'fellgor-ravager.gorehorn',
  herdGoad: 'fellgor-ravager.herd-goad',
  mangler: 'fellgor-ravager.mangler',
  shaman: 'fellgor-ravager.shaman',
  toxhorn: 'fellgor-ravager.toxhorn',
  vandal: 'fellgor-ravager.vandal',
  warrior: 'fellgor-ravager.warrior',
} as const;

export const RULE_FRENZY = 'fellgor-ravager.rule.frenzy';

export const AB = {
  callTheAttack: 'fellgor-ravager.ironhorn.call-the-attack',
  iconBearer: 'fellgor-ravager.deathknell.icon-bearer',
  warGong: 'fellgor-ravager.deathknell.war-gong',
  bladeWhirl: 'fellgor-ravager.fluxbray.blade-whirl',
  sagacious: 'fellgor-ravager.gnarlscar.sagacious',
  champion: 'fellgor-ravager.gorehorn.champion',
  headtaker: 'fellgor-ravager.gorehorn.headtaker',
  whipControl: 'fellgor-ravager.herd-goad.whip-control',
  tactualHunter: 'fellgor-ravager.mangler.tactual-hunter',
  berserker: 'fellgor-ravager.mangler.berserker',
  savage: 'fellgor-ravager.mangler.savage',
  toxicBlessings: 'fellgor-ravager.toxhorn.toxic-blessings',
  poxBomb: 'fellgor-ravager.toxhorn.pox-bomb',
  viciousBlows: 'fellgor-ravager.vandal.vicious-blows',
  warriorFrenzy: 'fellgor-ravager.warrior.warrior-frenzy',
} as const;

export const ACT = {
  gongKnell: 'fellgor-ravager.deathknell.act.gong-knell',
  cleaverFlurry: 'fellgor-ravager.fluxbray.act.cleaver-flurry',
  uncompromisingAttack: 'fellgor-ravager.gnarlscar.act.uncompromising-attack',
  inciteFury: 'fellgor-ravager.herd-goad.act.incite-fury',
  apoplecticRejuvenation: 'fellgor-ravager.shaman.act.apoplectic-rejuvenation',
  mantleOfDarkness: 'fellgor-ravager.shaman.act.mantle-of-darkness',
  sweepingBlow: 'fellgor-ravager.vandal.act.sweeping-blow',
} as const;

export const SP = {
  violentTemperament: 'fellgor-ravager.sp.violent-temperament',
  ambush: 'fellgor-ravager.sp.ambush',
  peltingFirepower: 'fellgor-ravager.sp.pelting-firepower',
  recklessDetermination: 'fellgor-ravager.sp.reckless-determination',
} as const;

export const FP = {
  ruthlessRampage: 'fellgor-ravager.fp.ruthless-rampage',
  wildRage: 'fellgor-ravager.fp.wild-rage',
  animalisticFury: 'fellgor-ravager.fp.animalistic-fury',
  bloodsense: 'fellgor-ravager.fp.bloodsense',
} as const;

export const EQ = {
  brassAdornments: 'fellgor-ravager.eq.brass-adornments',
  goreMarks: 'fellgor-ravager.eq.gore-marks',
  chaosSigil: 'fellgor-ravager.eq.chaos-sigil',
  warPaint: 'fellgor-ravager.eq.war-paint',
} as const;

/** Extra `ActionDef`s (docs/DECISIONS.md D-021) — the universal action forbids each of these. */
export const FIGHT_CHAMPION = 'Fight (Champion)';
export const FIGHT_SAVAGE = 'Fight (Savage)';
export const CHARGE_RAMPAGE = 'Charge (Ruthless Rampage)';
export const SHOOT_UNCOMPROMISING = 'Shoot (Uncompromising Attack)';
export const STUN_POX_BOMB = 'Stun Grenade (Pox Bomb)';

/**
 * The four ActionDefs above are universal actions in disguise, not printed unique actions, so
 * Frenzy's "it cannot perform … unique … actions" must not catch them.
 */
const UNIVERSAL_WRAPPERS = new Set<string>([FIGHT_CHAMPION, FIGHT_SAVAGE, CHARGE_RAMPAGE, SHOOT_UNCOMPROMISING]);

/** Tokens and effects — never module-level mutable state (CLAUDE.md architecture rule 7). */
export const FRENZY_TOKEN = 'fellgor-ravager.frenzy';
export const E_GONG_KNELL = 'fellgor-ravager.gongKnell';
export const E_MANTLE = 'fellgor-ravager.mantleOfDarkness';
export const E_INCITE_FURY = 'fellgor-ravager.inciteFury';
export const E_WILD_RAGE = 'fellgor-ravager.wildRage';
export const E_ANIMALISTIC = 'fellgor-ravager.animalisticFury';
export const E_RAMPAGE = 'fellgor-ravager.ruthlessRampage';
export const E_BLOODSENSE_READY = 'fellgor-ravager.bloodsenseReady';
export const E_BLOODSENSE_PAIR = 'fellgor-ravager.bloodsensePair';
export const E_UNCOMPROMISING = 'fellgor-ravager.uncompromisingAttack';
export const E_UNCOMP_SHOT = 'fellgor-ravager.uncompromisingShot';
export const E_RAMPAGE_USED = 'fellgor-ravager.ruthlessRampageUsed';
export const E_AMBUSHING = 'fellgor-ravager.ambushing';

const ORDERS_KEY = 'fellgor-ravager.orders';
const PELTING_KEY = 'fellgor-ravager.peltingFirepower';
const NORMAL_STRIKES_KEY = 'fellgor-ravager.frenzyNormalStrikes';
const MELEE_KILLS_KEY = 'fellgor-ravager.meleeKills';
const HEADTAKER_KEY = 'fellgor-ravager.headtaker';
const WAR_GONG_KEY = 'fellgor-ravager.warGong';
const RECKLESS_KEY = 'fellgor-ravager.recklessDetermination';
const VIOLENT_KEY = 'fellgor-ravager.violentTemperament';
const AMBUSH_NOTE = 'AMBUSH';
const GORE_MARKS_KEY = 'fellgor-ravager.goreMarks';
const TACTUAL_KEY = 'fellgor-ravager.tactualHunter';
const BLOODSENSE_SNAP = 'fellgor-ravager.bloodsenseSnapshot';

/**
 * Printed clauses this module does NOT implement, with the engine reason. Exported so the tests
 * can pin every one of them — docs/TEAM-STATUS.md is only worth anything if it is honest.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [`${RULE_FRENZY}.scoring`]:
    'the last bullet\'s VP half — "your opponent treats a FELLGOR RAVAGER operative as being incapacitated … for the purposes of scoring VPs (e.g. kill op)" — belongs to src/core/ops/**, which a team module may not reach; the faction-rule half IS live by construction, because every enemy onIncapacitated handler fires on the very emit that hands out the token',
  [`${RULE_FRENZY}.areas`]:
    '"for the purpose of determining control of … areas of the killzone, treat its APL stat as 1" — only marker control emits a hook (onMarkerControl); area/territory control is computed inside src/core/ops/** with no seam, so the marker half is exact and the area half is reminder-only',
  [`${AB.berserker}.guard`]:
    '"other than Guard, but cannot then perform a free Shoot action during the interruption" — the OnGuardInterrupt intent emits nothing, so the free point-blank Shoot cannot be refused; it bites on nothing today because the MANGLER carries no ranged weapon at all (startShoot refuses it outright)',
  [`${AB.bladeWhirl}.block`]:
    '"that success must be used to block" — advanceFight builds the strike/block options itself and no hook is consulted, the same clause six teams before this one reported (Celestian Bladed Stance, Elucidian, Spectre PREPARED DEFENCE, Blades SCREAM-THAT-STEALS, Void Dancer, Wyrmblade)',
  [`${FP.bloodsense}.activation`]:
    'there is no activation-order seam — EndActivation hands activePlayer to the opponent after onActivationEnd and nothing runs later — so "you can activate that other friendly operative before your opponent activates" is recorded as an effect for the UI/AI (the Breachers Breach and Clear / Pathfinders Group Activation partial)',
  [`${AB.warriorFrenzy}.isInjured`]:
    '"it cannot be injured" cancels the printed injured penalties through onStatMod (−2" Move, Hit worsened by 1); isInjured() itself is a pure wounds read in src/core/state.ts with no hook, so any OTHER rule that asks "is it injured?" still sees a 1-wound WARRIOR as injured (the Wolf Scouts Spiritual Chirurgy shape)',
};

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);
const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

const baseOf = (op: OperativeState): BaseShape => catalogueCard(op.datacardId)?.base ?? DEFAULT_BASE;
const catalogueKw = (op: OperativeState, keyword: string): boolean =>
  (catalogueCard(op.datacardId)?.keywords ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

const shootStamp = (seq: ShootSequence): string =>
  `${seq.attackerId}:${seq.targetId}:${seq.resolvedTargets.length}`;
const fightStamp = (seq: FightSequence): string => `${seq.attackerId}:${seq.defenderId}:${seq.attacker}`;

/** Does this operative have one of `player`'s Frenzy tokens? */
export const hasFrenzy = (state: GameState, op: OperativeState, player?: PlayerId): boolean =>
  hasToken(state, op.id, FRENZY_TOKEN, player ?? op.player);

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A `Body` at a remembered position, for a visibility test against an operative already removed. */
function bodyAt(pos: Vec2, z: number, base: BaseShape, height: number): Body {
  return { id: 'ghost', pos, z, rot: 0, base, height };
}

// ---------------------------------------------------------------------------
// Frenzy
// ---------------------------------------------------------------------------

/**
 * "All remaining attack dice are discarded (including yours if this operative is fighting or
 * retaliating)." Applied the moment the token is gained.
 */
function discardRemainingDice(state: GameState, op: OperativeState): void {
  const seq = state.sequence;
  if (!seq) return;
  const pools: DicePool[] = [];
  if (seq.kind === 'fight' && (seq.attackerId === op.id || seq.defenderId === op.id)) {
    pools.push(seq.attackerPool, seq.defenderPool);
  } else if (seq.kind === 'shoot' && seq.targetId === op.id) {
    pools.push(seq.attack);
  }
  let n = 0;
  for (const pool of pools) {
    for (const die of pool.dice) {
      if (die.state === 'crit' || die.state === 'normal') {
        die.state = 'discarded';
        die.note = 'Frenzy';
        n++;
      }
    }
  }
  if (n > 0)
    log(state, { kind: 'dice', player: op.player, text: `Frenzy: ${n} remaining attack dice are discarded` });
}

/**
 * The five printed triggers. The incapacitation is applied WITHOUT re-emitting `onIncapacitated`:
 * the opponent already treated this operative as incapacitated when it gained the token (the last
 * printed bullet), and re-emitting would only run this module's own prevention again.
 */
function frenzyIncapacitate(state: GameState, op: OperativeState, why: string): void {
  if (op.incapacitated || op.removed) return;
  op.incapacitated = true;
  // "…or until this operative is incapacitated (whichever comes first)" — GONG KNELL and MANTLE OF
  // DARKNESS both end here, and this is the only moment the engine reaches for a Frenzy kill.
  dropEffects(state, (e) => (e.rule === E_GONG_KNELL || e.rule === E_MANTLE) && e.operativeId === op.id);
  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} is incapacitated — Frenzy: ${why}`,
    data: { operativeId: op.id, frenzy: why },
  });
}

// ---------------------------------------------------------------------------
// Cult-Ambush-style shadow order ledger (the Wyrmblade precedent)
// ---------------------------------------------------------------------------

/**
 * `ActivateOperative` writes `op.order` BEFORE `onActivationStart` is emitted, so "if its order is
 * changed from Conceal to Engage" needs a shadow of the order each operative carried into its
 * activation. The currently active operative is deliberately skipped.
 */
function recordOrders(T: TeamHooks, state: GameState, force?: string): void {
  const b = bucket(state, ORDERS_KEY);
  for (const op of T.friendlies(state)) {
    if (op.id === state.activeOperativeId && op.id !== force) continue;
    b[op.id] = op.order;
  }
}

export function recordedOrder(state: GameState, operativeId: string): Order | undefined {
  const v = bucket(state, ORDERS_KEY)[operativeId];
  return v === 'engage' || v === 'conceal' ? v : undefined;
}

/** "…it's ambushing for that activation." */
export const isAmbushing = (state: GameState, operativeId: string): boolean =>
  Boolean(effectOn(state, operativeId, E_AMBUSHING));

// ---------------------------------------------------------------------------
// PELTING FIREPOWER ledger
// ---------------------------------------------------------------------------

/** Per player, per turning point: which friendly operatives have shot which enemy operative. */
const peltingLedger = (state: GameState, player: PlayerId): Record<string, string[]> => {
  const b = bucket(state, PELTING_KEY) as Record<string, unknown>;
  const key = `${player}:${state.turningPoint}`;
  const led = (b[key] ?? {}) as Record<string, string[]>;
  b[key] = led;
  return led;
};

/** How many OTHER friendly operatives have shot this enemy during this turning point. */
export function peltingShooters(state: GameState, player: PlayerId, targetId: string, exclude: string): number {
  const led = peltingLedger(state, player);
  return (led[targetId] ?? []).filter((id) => id !== exclude).length;
}

function recordPelting(state: GameState, player: PlayerId, targetId: string, shooterId: string): void {
  const led = peltingLedger(state, player);
  const list = led[targetId] ?? [];
  if (!list.includes(shooterId)) list.push(shooterId);
  led[targetId] = list;
}

// ---------------------------------------------------------------------------
// Headtaker's Critical Dmg growth
// ---------------------------------------------------------------------------

export const headtakerBonus = (state: GameState, operativeId: string): number =>
  Number(bucket(state, HEADTAKER_KEY)[operativeId] ?? 0);

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const FRENZY = text(RULE_FRENZY);
  const isMine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // Frenzy — the prevention, the token, the discard, the order flip
  // =========================================================================
  reg.on('onIncapacitated', T.bind(RULE_FRENZY, 8), (ev) => {
    const op = ev.operative;
    if (!isMine(op)) return;
    ev.prevented = true;
    if (hasFrenzy(ev.state, op, T.player)) return; // "It's only incapacitated as detailed overleaf."
    giveToken(ev.state, op, FRENZY_TOKEN, {
      sourceId: RULE_FRENZY,
      sourceText: shortQuote(FRENZY),
      player: T.player,
    });
    discardRemainingDice(ev.state, op);
    if (op.order === 'conceal') {
      op.order = 'engage'; // "If it has a Conceal order, change it to Engage."
      log(ev.state, { kind: 'action', player: T.player, text: `${op.letter}: Frenzy changes its order to Engage` });
    }
  });

  // "It cannot have a Conceal order." `onOrderChange` is declared but never emitted, so the order
  // is corrected at the start of the activation (the Kommandos GROT precedent).
  reg.on('onActivationStart', T.bind(RULE_FRENZY, 6), (ev) => {
    const op = ev.operative;
    if (!isMine(op) || !hasFrenzy(ev.state, op, T.player)) return;
    if (op.order !== 'conceal') return;
    op.order = 'engage';
    log(ev.state, { kind: 'action', player: T.player, text: `${op.letter}: Frenzy — it cannot have a Conceal order` });
  });

  // "It's injured." The prevention leaves the operative on 1 wound, so this is already true; the
  // handler exists so a heal that lifted it back over half wounds could not switch it off.
  reg.on('onStatMod', T.bind(RULE_FRENZY, 10), (ev) => {
    const op = ev.operative;
    if (!isMine(op) || !hasFrenzy(ev.state, op, T.player)) return;
    if (!T.ctx || isInjured(T.ctx, op)) return;
    ev.mods.move -= 2;
    ev.mods.hit -= 1;
  });

  // "It cannot perform the Pick Up Marker, unique (excluding Sweeping Blow, see VANDAL) or mission
  //  actions (excluding Operate Hatch)."
  reg.on('canPerformAction', T.bind(RULE_FRENZY, 10), (ev) => {
    const op = ev.operative;
    if (!isMine(op) || !hasFrenzy(ev.state, op, T.player)) return;
    const def = getAction(ev.action);
    const deny = (reason: string): void => {
      ev.allowed = false;
      ev.reason = reason;
    };
    if (ev.action === 'Pick Up Marker') return deny('Frenzy: it cannot perform the Pick Up Marker action');
    if (def?.type === 'mission' && ev.action !== 'Operate Hatch')
      return deny('Frenzy: it cannot perform mission actions (excluding Operate Hatch)');
    if (def?.type === 'unique' && ev.action !== ACT.sweepingBlow && !UNIVERSAL_WRAPPERS.has(ev.action))
      return deny('Frenzy: it cannot perform unique actions (excluding Sweeping Blow)');
  });

  // "For the purpose of determining control of markers … treat its APL stat as 1. This takes
  //  precedence over any stat changes." (The "areas of the killzone" half is reminder-only.)
  // The DEATHKNELL's Icon Bearer exempts itself from this bullet.
  reg.on('onMarkerControl', T.bind(RULE_FRENZY, 20), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    for (const op of T.friendlies(ev.state)) {
      if (!T.kw(op, KW) || !hasFrenzy(ev.state, op, T.player)) continue;
      if (op.datacardId === CARD.deathknell) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
      const apl = T.ctx ? currentApl(T, ev.state, op) : 1;
      ev.aplByPlayer[T.player] += 1 - apl;
    }
  });

  // The five printed triggers.
  reg.on('onActivationEnd', T.bind(RULE_FRENZY, 80), (ev) => {
    const op = ev.operative;
    if (!isMine(op) || !hasFrenzy(ev.state, op, T.player)) return;
    frenzyIncapacitate(ev.state, op, 'its activation or counteraction ends');
  });

  reg.on('onStrikeResolved', T.bind(RULE_FRENZY, 20), (ev) => {
    const victim = ev.struck;
    if (!isMine(victim) || !hasFrenzy(ev.state, victim, T.player)) return;
    if (ev.ctx.attacker.player === T.player) return; // "An enemy operative is …"
    if (ev.ctx.type === 'melee') {
      if (ev.crit)
        return frenzyIncapacitate(ev.state, victim, 'your opponent strikes with a critical success');
      const b = bucket(ev.state, NORMAL_STRIKES_KEY) as Record<string, number>;
      const n = Number(b[victim.id] ?? 0) + 1;
      b[victim.id] = n;
      // "…strikes it for a SECOND time with a normal success. Note this can be strikes from two
      //  different Fight actions."
      if (n >= 2)
        frenzyIncapacitate(ev.state, victim, 'your opponent strikes it a second time with a normal success');
      return;
    }
    // "An enemy operative is shooting it and Critical Dmg is inflicted on it."
    if (!ev.crit || ev.ctx.profile.dmgC <= 0) return;
    const seq = shootSeq(ev.state);
    if (seq && bucket(ev.state, WAR_GONG_KEY)[seq.targetId] === shootStamp(seq)) return; // War Gong
    frenzyIncapacitate(ev.state, victim, 'Critical Dmg is inflicted on it while being shot');
  });

  // "The battle ends (resolve this before any victory conditions that resolve at the end of the
  //  battle)." `endTurningPoint` emits onEndOfTP before `scoreEndOfBattle` runs.
  reg.on('onEndOfTP', T.bind(RULE_FRENZY, 80), (ev) => {
    if (ev.state.turningPoint < (ev.state.maxTurningPoints || 4)) return;
    for (const op of T.friendlies(ev.state)) {
      if (!T.kw(op, KW) || !hasFrenzy(ev.state, op, T.player)) continue;
      frenzyIncapacitate(ev.state, op, 'the battle ends');
    }
  });

  // =========================================================================
  // IRONHORN › Call the Attack — an extra 0CP STRATEGIC GAMBIT
  // =========================================================================
  const callTheAttackTargets = (state: GameState, ironhorn: OperativeState): OperativeState[] => {
    if (!T.ctx) return [];
    const index = terrain(T.ctx, state);
    return T.friendlies(state)
      .filter((o) => T.kw(o, KW) && o.id !== ironhorn.id)
      .filter(
        (o) =>
          T.gap(ironhorn, o) <= 6 + EPS && isVisible(index, body(T.ctx!, ironhorn), body(T.ctx!, o)).visible,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  };
  const liveIronhorn = (state: GameState): OperativeState | undefined =>
    T.friendlies(state).find((o) => o.datacardId === CARD.ironhorn && !hasFrenzy(state, o, T.player));

  reg.on('gambitOptions', T.bind(AB.callTheAttack, 15), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    const ironhorn = liveIronhorn(ev.state);
    if (!ironhorn || callTheAttackTargets(ev.state, ironhorn).length === 0) return;
    ev.options.push({
      id: AB.callTheAttack,
      label: 'Call the Attack (0CP)',
      sourceText: shortQuote(abilityText(CARD.ironhorn, AB.callTheAttack)),
    });
  });

  reg.on('onPloyUsed', T.bind(AB.callTheAttack, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== AB.callTheAttack || !T.ctx) return;
    const ironhorn = liveIronhorn(ev.state);
    if (!ironhorn) return;
    const candidates = callTheAttackTargets(ev.state, ironhorn);
    const wanted = ev.data?.['operativeId'];
    const chosen =
      (typeof wanted === 'string' ? candidates.find((o) => o.id === wanted) : undefined) ?? candidates[0];
    if (!chosen) return;
    const index = terrain(T.ctx, ev.state);
    // "That selected operative, and each other friendly FELLGOR RAVAGER operative visible to and
    //  within 2" of it, can immediately perform a free Dash action in an order of your choice."
    const group = [
      chosen,
      ...T.friendlies(ev.state)
        .filter((o) => T.kw(o, KW) && o.id !== chosen.id)
        .filter((o) => T.gap(chosen, o) <= 2 + EPS && isVisible(index, body(T.ctx!, chosen), body(T.ctx!, o)).visible),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const op of group) {
      // "…can immediately perform a free Dash action": one free Dash each, so an operative
      // already holding this gambit's grant is skipped rather than handed a second AP.
      if (effectsOn(ev.state, op.id, FREE_ACTION_RULE).some((e) => e.source.id === AB.callTheAttack)) continue;
      grantFreeAction(ev.state, op, {
        sourceId: AB.callTheAttack,
        sourceText: shortQuote(abilityText(CARD.ironhorn, AB.callTheAttack)),
        kind: 'ability',
        threshold: currentApl(T, ev.state, op),
        only: ['Dash'],
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Call the Attack: ${group.map((o) => o.letter).join(', ')} gain a free Dash`,
    });
  });

  // Call the Attack is a STRATEGIC GAMBIT, so its free Dash is handed to operatives that are not
  // activating and is spent later in the same turning point. The grant's own `endOfActivation`
  // expiry (D-100) therefore only fires for a herd-mate that goes on to activate: one that ends
  // the turning point expended without ever taking the Dash would still be carrying the offer
  // when the next one opens. "Immediately" belongs to the turning point the gambit was used in,
  // so the Ready step drops whatever was never taken.
  const dropUntakenDash = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (eff.source.id !== AB.callTheAttack) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bindText('fellgor.freeActionUpkeep', abilityText(CARD.ironhorn, AB.callTheAttack), 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) dropUntakenDash(ev.state, o);
  });

  // =========================================================================
  // DEATHKNELL › Icon Bearer
  // =========================================================================
  // "Whenever determining control of a marker, treat this operative's APL stat as 1 higher. Note
  //  this isn't a change to its APL stat, so any changes are cumulative with this."
  reg.on('onMarkerControl', T.bind(AB.iconBearer, 21), (ev) => {
    if (!T.ctx) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    for (const op of T.friendlies(ev.state)) {
      if (op.datacardId !== CARD.deathknell) continue;
      if (!markerContestedBy(T.ctx, ev.state, marker, op)) continue;
      ev.aplByPlayer[T.player] += 1;
    }
  });

  // =========================================================================
  // DEATHKNELL › War Gong
  // =========================================================================
  /*
   * "Whenever an attack dice would inflict Critical Dmg on a friendly FELLGOR RAVAGER operative
   *  within 3" of this operative, if this operative doesn't have one of your Frenzy tokens, you can
   *  choose for that attack dice to inflict Normal Dmg instead."
   *
   * `onDamage` always carries `ctx: null`, so the striking profile is re-derived from
   * `state.sequence` (the Hearthkyn Weavefield Crest / Raveners Reinforced Carapace shape). Free
   * and strictly beneficial, so it is auto-used under D-022 — and only when Critical Dmg is
   * actually worse than Normal Dmg, which is where the printed choice could ever matter.
   */
  reg.on('onDamage', T.bind(AB.warGong, 12), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    const victim = ev.target;
    if (!isMine(victim)) return;
    const gong = T.friendlies(ev.state).find(
      (o) => o.datacardId === CARD.deathknell && !hasFrenzy(ev.state, o, T.player) && T.gap(o, victim) <= 3 + EPS,
    );
    if (!gong) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    if (seq.kind === 'fight') {
      const striker = seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
      if (striker === victim.id) return;
      const { profile } = sideWeapon(T.ctx, ev.state, seq, seq.turn);
      if (profile.dmgC <= profile.dmgN || ev.amount !== profile.dmgC) return;
      ev.amount = profile.dmgN;
      log(ev.state, { kind: 'dice', player: T.player, text: `War Gong: that attack dice inflicts Normal Dmg instead` });
      return;
    }
    if (seq.targetId !== victim.id) return;
    const attacker = ev.state.operatives[seq.attackerId];
    if (!attacker || attacker.player === T.player) return;
    const weapon = weaponsOf(T.ctx, ev.state, attacker, 'ranged').find((w) => w.name === seq.weaponName);
    const profile = weapon ? findProfile(weapon, seq.profileName) : undefined;
    if (!profile || profile.dmgC <= profile.dmgN) return;
    const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
    if (crits <= 0) return;
    ev.amount = Math.max(0, ev.amount - (profile.dmgC - profile.dmgN) * crits);
    bucket(ev.state, WAR_GONG_KEY)[seq.targetId] = shootStamp(seq);
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `War Gong: ${crits} critical attack dice inflict Normal Dmg instead`,
    });
  });

  // =========================================================================
  // FLUXBRAY › Blade Whirl
  // =========================================================================
  /*
   * "Whenever this operative is fighting or retaliating, if it doesn't have one of your Frenzy
   *  tokens, you can resolve one of your successes before the normal order. If you do, that success
   *  must be used to block."
   *
   * The attacker already resolves first, so the rule only bites while the FLUXBRAY RETALIATES:
   * `seq.turn` is flipped to the defender at the retention step, which `advanceFight` reaches by
   * calling `sideWeapon` (and therefore emitting `onWeaponRules`) for each side. The second half —
   * "that success must be used to block" — is unenforceable: `advanceFight` builds the strike/block
   * options itself (REMINDER_ONLY).
   */
  reg.on('onWeaponRules', T.bind(AB.bladeWhirl, 14), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || seq.step !== 'retention' || !ev.retaliating) return;
    if (seq.turn !== 'attacker' || !seq.defenderCanRetaliate) return;
    const fluxbray = ev.state.operatives[seq.defenderId];
    if (!fluxbray || fluxbray.player !== T.player || fluxbray.datacardId !== CARD.fluxbray) return;
    if (hasFrenzy(ev.state, fluxbray, T.player)) return;
    seq.turn = 'defender';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Blade Whirl: ${fluxbray.letter} resolves one of its successes before the normal order`,
    });
  });

  // =========================================================================
  // GNARLSCAR › Sagacious
  // =========================================================================
  /*
   * "At the end of this operative's activation, you can change its order."
   *
   * D-022 policy, stated here: take the order that leaves the GNARLSCAR a valid target for FEWER
   * enemy operatives, tested with the engine's own `checkTarget` over each enemy's ranged profiles
   * (the Mandrakes SHADOW PASSAGE read); ties keep Engage, so the operative can still counteract.
   * A Frenzy token forbids Conceal outright.
   */
  reg.on('onActivationEnd', T.bind(AB.sagacious, 40), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.gnarlscar || !T.ctx) return;
    if (op.removed || op.incapacitated) return;
    if (hasFrenzy(ev.state, op, T.player)) return;
    const was = op.order;
    op.order = 'engage';
    const asEngage = targetingEnemies(T.ctx, ev.state, op);
    op.order = 'conceal';
    const asConceal = targetingEnemies(T.ctx, ev.state, op);
    op.order = asConceal < asEngage ? 'conceal' : 'engage';
    if (op.order === was) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Sagacious: ${op.letter} changes its order to ${op.order}`,
    });
  });

  // =========================================================================
  // GOREHORN › Headtaker (also the rare weapon rule)
  // =========================================================================
  /*
   * "Whenever this operative incapacitates an operative with this weapon, roll one D3: this
   *  operative regains a number of lost wounds equal to the result (unless it has a Frenzy token).
   *  Until the end of the battle, add the result to the Critical Dmg stat of this operative's
   *  skullcleaver (to a maximum of 8)."
   *
   * `onStrikeResolved` fires immediately after the strike's damage, so `struck.incapacitated` is
   * the printed trigger. It carries the STRIKING side's profile and rules (its `weaponName` is
   * always the fight's attacker weapon — a fight.ts quirk), so the weapon is identified by its
   * `Headtaker` rule rather than by name.
   */
  reg.on('onStrikeResolved', T.bind(AB.headtaker, 22), (ev) => {
    if (!T.ctx || ev.ctx.type !== 'melee') return;
    const gorehorn = ev.ctx.attacker;
    if (gorehorn.player !== T.player || gorehorn.datacardId !== CARD.gorehorn) return;
    if (!hasRule(ev.ctx.rules, 'Headtaker')) return;
    if (!ev.struck.incapacitated) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'headtaker', [d3], T.player, `${gorehorn.letter} Headtaker`);
    if (!hasFrenzy(ev.state, gorehorn, T.player)) {
      const startWounds = T.card(gorehorn)?.wounds ?? gorehorn.wounds;
      gorehorn.wounds = Math.min(startWounds, gorehorn.wounds + d3);
    }
    const b = bucket(ev.state, HEADTAKER_KEY) as Record<string, number>;
    b[gorehorn.id] = Number(b[gorehorn.id] ?? 0) + d3;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Headtaker: ${gorehorn.letter} rolls ${d3} (skullcleaver Critical Dmg +${d3})`,
    });
  });

  // "add the result to the Critical Dmg stat of this operative's skullcleaver (to a maximum of 8)"
  // — D-019: the shared `WeaponProfile` is never rewritten, so the bump is applied where the damage
  // is inflicted.
  reg.on('onDamage', T.bind(AB.headtaker, 16), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const strikerId = seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
    const striker = ev.state.operatives[strikerId];
    if (!striker || striker.player !== T.player || striker.datacardId !== CARD.gorehorn) return;
    const { profile, rules: wrules } = sideWeapon(T.ctx, ev.state, seq, seq.turn);
    if (!hasRule(wrules, 'Headtaker')) return;
    if (ev.amount !== profile.dmgC) return; // a critical strike (the Death Korps Bruiser read)
    const bonus = Math.min(headtakerBonus(ev.state, striker.id), Math.max(0, 8 - profile.dmgC));
    if (bonus <= 0) return;
    ev.amount += bonus;
  });

  // =========================================================================
  // HERD-GOAD › Whip Control
  // =========================================================================
  const whipped = (state: GameState, foe: OperativeState): boolean => {
    if (!T.ctx) return false;
    const index = terrain(T.ctx, state);
    return T.friendlies(state).some((goad) => {
      if (goad.datacardId !== CARD.herdGoad) return false;
      if (T.gap(goad, foe) > 3 + EPS) return false;
      if (!isVisible(index, body(T.ctx!, goad), body(T.ctx!, foe)).visible) return false;
      // "if this operative isn't within control range of any OTHER enemy operatives"
      return !enemiesInControlRange(T.ctx!, state, goad).some((e) => e.id !== foe.id);
    });
  };

  // "Subtract 1 from the Atk stat of that enemy operative's melee weapons (to a minimum of 1)."
  reg.on('onCollectAttackDice', T.bind(AB.whipControl, 12), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const foe = ev.ctx.attacker;
    if (foe.player === T.player) return;
    if (!whipped(ev.state, foe)) return;
    ev.count = Math.max(1, ev.count - 1);
  });

  // "Your opponent must spend 1 additional AP for that enemy operative to perform the Fall Back
  //  action."
  reg.on('onActionCost', T.bind(AB.whipControl, 12), (ev) => {
    if (ev.action !== 'Fall Back') return;
    const foe = ev.operative;
    if (foe.player === T.player) return;
    if (!whipped(ev.state, foe)) return;
    ev.ap += 1;
  });

  // =========================================================================
  // MANGLER › Tactual Hunter (also the rare weapon rule)
  // =========================================================================
  /*
   * "Whenever this operative is fighting with this weapon against an expended operative, the first
   *  time you strike with a critical success during that sequence, you can immediately resolve
   *  another of your successes as a strike (before your opponent)."
   *
   * `resolveFightDie` flips `seq.turn` immediately after emitting `onStrikeResolved`, so the extra
   * strike is resolved by re-entering it for the same side from inside the hook (the Wyrmblade
   * ASSASSINATE / Void Dancer CEGORACH'S JEST precedent). "…is FIGHTING with this weapon" — never
   * while retaliating.
   */
  reg.on('onStrikeResolved', T.bind(AB.tactualHunter, 24), (ev) => {
    if (!T.ctx || ev.ctx.type !== 'melee' || !ev.crit) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const mangler = ev.ctx.attacker;
    if (mangler.player !== T.player || seq.attackerId !== mangler.id) return;
    if (!hasRule(ev.ctx.rules, 'TactualHunter')) return;
    if (!ev.struck.expended) return; // "against an expended operative"
    if (ev.struck.incapacitated || mangler.incapacitated) return;
    const b = bucket(ev.state, TACTUAL_KEY) as Record<string, string>;
    if (b[mangler.id] === fightStamp(seq)) return; // "the FIRST time you strike with a critical success"
    b[mangler.id] = fightStamp(seq);
    const mine = successes(seq.attackerPool);
    const next = mine.find((d) => d.state === 'crit') ?? mine[0];
    if (!next) return;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Tactual Hunter: ${mangler.letter} immediately resolves another success as a strike`,
    });
    resolveFightDie(T.ctx, ev.state, seq, 'attacker', next.id, 'strike');
  });

  // =========================================================================
  // MANGLER › Berserker
  // =========================================================================
  // Savage: "…and you cannot use the Ruthless Rampage firefight ploy between those two Fight
  //  actions." Enforced in the reachable direction — once the ploy has been used during this
  //  activation, the MANGLER's free Fight is gone (`ployUsable` carries no GameContext, so the
  //  other direction cannot test control range there).
  reg.on('canPerformAction', T.bind(AB.savage, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.mangler) return;
    if (ev.action !== FIGHT_SAVAGE) return;
    if (!effectOn(ev.state, op.id, E_RAMPAGE_USED)) return;
    ev.allowed = false;
    ev.reason = 'Savage: you cannot use the Ruthless Rampage firefight ploy between those two Fight actions';
  });

  reg.on('canPerformAction', T.bind(AB.berserker, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.mangler) return;
    const def = getAction(ev.action);
    const isShoot = ev.action === 'Shoot' || def?.treatedAs === 'Shoot';
    if (isShoot && ev.action !== 'Guard') {
      ev.allowed = false;
      ev.reason = 'Berserker: this operative cannot perform the Shoot action';
    }
  });

  // "You must spend 1 additional AP for this operative to perform the Pick Up Marker and mission
  //  actions (excluding Operate Hatch)."
  reg.on('onActionCost', T.bind(AB.berserker, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.mangler) return;
    const def = getAction(ev.action);
    if (ev.action === 'Operate Hatch') return;
    if (ev.action === 'Pick Up Marker' || def?.type === 'mission') ev.ap += 1;
  });

  // =========================================================================
  // TOXHORN › Toxic Blessings
  // =========================================================================
  // "You can ignore any changes to this operative's APL stat" — D-022: a permission to ignore is
  // taken only against WORSENING changes (the Exaction Squad Engendered Focus reading). Bound late
  // so the other APL handlers in the tree have already spoken.
  reg.on('onStatMod', T.bind(AB.toxicBlessings, 60), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.toxhorn) return;
    const raw = op.aplMods.reduce((a, b) => a + b, 0);
    if (raw < 0) ev.mods.apl -= raw;
    if (ev.mods.apl < 0) ev.mods.apl = 0;
  });

  // "…and it's not affected by enemy operatives' Shock weapon rule."
  reg.on('onWeaponRules', T.bind(AB.toxicBlessings, 45), (ev) => {
    if (ev.operative.player === T.player) return;
    const victim = ev.target;
    if (!victim || victim.player !== T.player || victim.datacardId !== CARD.toxhorn) return;
    for (let i = ev.rules.length - 1; i >= 0; i--) if (ev.rules[i]!.id === 'Shock') ev.rules.splice(i, 1);
  });

  // "Whenever an attack dice inflicts Normal Dmg of 3 or more on this operative, roll one D6: on a
  //  5+, subtract 1 from that inflicted damage." A shoot inflicts one aggregated total, so the roll
  //  is made per unblocked attack dice (the Raveners Reinforced Carapace read).
  reg.on('onDamage', T.bind(AB.toxicBlessings, 14), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    const victim = ev.target;
    if (victim.player !== T.player || victim.datacardId !== CARD.toxhorn) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    let dice = 0;
    if (seq.kind === 'fight') {
      const strikerId = seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
      if (strikerId === victim.id) return;
      const { profile } = sideWeapon(T.ctx, ev.state, seq, seq.turn);
      if (profile.dmgN < 3 || ev.amount !== profile.dmgN) return;
      dice = 1;
    } else {
      if (seq.targetId !== victim.id) return;
      const attacker = ev.state.operatives[seq.attackerId];
      const weapon = attacker ? weaponsOf(T.ctx, ev.state, attacker, 'ranged').find((w) => w.name === seq.weaponName) : undefined;
      const profile = weapon ? findProfile(weapon, seq.profileName) : undefined;
      if (!profile || profile.dmgN < 3) return;
      dice = seq.attack.dice.filter((d) => d.state === 'normal').length;
      // War Gong turned this shot's critical successes into Normal Dmg, so they qualify too.
      if (bucket(ev.state, WAR_GONG_KEY)[seq.targetId] === shootStamp(seq))
        dice += seq.attack.dice.filter((d) => d.state === 'crit').length;
    }
    let saved = 0;
    for (let i = 0; i < dice; i++) {
      const roll = T.ctx.rng.d6();
      recordRoll(ev.state, 'toxicBlessings', [roll], T.player, `${victim.letter} Toxic Blessings`);
      if (roll >= 5) saved++;
    }
    if (saved <= 0) return;
    ev.amount = Math.max(0, ev.amount - saved);
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Toxic Blessings: ${saved} damage subtracted from ${victim.letter}`,
    });
  });

  // =========================================================================
  // TOXHORN › Pox Bomb — the stun-test rider (its own Stun Grenade action is below)
  // =========================================================================
  // "Whenever an enemy operative takes a stun test as a result of this operative performing the
  //  Stun Grenade action, if the result is a 3+, also inflict damage on that enemy operative equal
  //  to the dice result halved (rounding up)."
  reg.on('onStunTest', T.bind(AB.poxBomb, 12), (ev) => {
    const thrower = ev.thrower;
    if (thrower.player !== T.player || thrower.datacardId !== CARD.toxhorn) return;
    if (ev.target.player === T.player) return; // "an ENEMY operative"
    if (ev.roll < 3) return;
    ev.damage += Math.ceil(ev.roll / 2);
  });

  // =========================================================================
  // VANDAL › Vicious Blows (also the rare weapon rule)
  // =========================================================================
  // "Whenever this operative is FIGHTING, this weapon has the Ceaseless weapon rule." — printed
  // without "or retaliating", so a retaliating VANDAL does not get it.
  reg.on('onWeaponRules', T.bind(AB.viciousBlows, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.vandal) return;
    if (ev.type !== 'melee' || ev.retaliating) return;
    if (!hasRule(ev.rules, 'ViciousBlows')) return;
    if (!ev.rules.some((r) => r.id === 'Ceaseless')) ev.rules.push(ruleTag('Ceaseless'));
  });

  // =========================================================================
  // WARRIOR › Warrior Frenzy
  // =========================================================================
  // "Whenever this operative has one of your Frenzy tokens, it cannot be injured. This takes
  //  precedence over the normal Frenzy rules." The injured PENALTIES are cancelled through
  //  `onStatMod`; `isInjured()` itself is a pure wounds read with no hook (REMINDER_ONLY).
  reg.on('onStatMod', T.bind(AB.warriorFrenzy, 14), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.warrior || !T.ctx) return;
    if (!hasFrenzy(ev.state, op, T.player) || !isInjured(T.ctx, op)) return;
    ev.mods.move += 2;
    ev.mods.hit += 1;
  });
}

/** How many enemy operatives could select this operative as a valid target right now? */
function targetingEnemies(ctx: GameContext, state: GameState, op: OperativeState): number {
  let n = 0;
  for (const foe of aliveOperatives(state, otherPlayer(op.player))) {
    let can = false;
    for (const weapon of weaponsOf(ctx, state, foe, 'ranged')) {
      for (const profile of weapon.profiles.filter((p) => p.type === 'ranged')) {
        const wrules = effectiveRules(ctx, state, profile, { operative: foe, target: op, weaponName: weapon.name });
        if (checkTarget(ctx, state, foe, op, profile, wrules).valid) {
          can = true;
          break;
        }
      }
      if (can) break;
    }
    if (can) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const isMine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // VIOLENT TEMPERAMENT (strategy)
  // =========================================================================
  /*
   * "Whenever a friendly FELLGOR RAVAGER operative is fighting or retaliating, after rolling your
   *  attack dice, you can use this rule. If you do, you must re-roll all of your attack dice (you
   *  cannot only re-roll some)."
   *
   * `fight.ts` emits no `onRollAttack` (D-031) — but `offerRerolls` calls `sideWeapon`, and
   * therefore emits `onWeaponRules`, at the `attackerRerolls`/`defenderRerolls` step, which is
   * exactly "after rolling your attack dice" and before any optional re-roll is offered. A mandatory
   * whole-pool re-roll cannot be expressed as a `RerollGrant` (every grant is optional and per-die),
   * so the pool is re-rolled inside the hook (the Warpcoven RAVAGE DESTINY precedent).
   *
   * D-022 policy, stated: re-roll only when the pool holds strictly more fails than successes, i.e.
   * when re-rolling everything is expected to improve it.
   */
  reg.on('onWeaponRules', T.bind(SP.violentTemperament, 16), (ev) => {
    if (!T.ctx || !gambitUsed(ev.state, T.player, SP.violentTemperament)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (seq.step !== 'attackerRerolls' && seq.step !== 'defenderRerolls') return;
    const side: 'attacker' | 'defender' = ev.retaliating ? 'defender' : 'attacker';
    const op = ev.operative;
    if (!isMine(op)) return;
    const mineId = side === 'attacker' ? seq.attackerId : seq.defenderId;
    if (mineId !== op.id) return;
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const b = bucket(ev.state, VIOLENT_KEY) as Record<string, string>;
    const key = `${side}:${op.id}`;
    if (b[key] === fightStamp(seq)) return;
    const rolled = pool.dice.filter((d) => d.rolled && d.state !== 'discarded');
    if (rolled.length === 0) return;
    const fails = rolled.filter((d) => d.state === 'fail').length;
    if (fails <= rolled.length - fails) return; // policy: only when fails outnumber successes
    b[key] = fightStamp(seq);
    const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
    const hit = hitOf(T.ctx, ev.state, op, ev.profile, assists);
    const lethal = ev.rules.find((r) => r.id === 'Lethal')?.x;
    const results = T.ctx.rng.roll(rolled.length);
    recordRoll(ev.state, 'violentTemperament', results, T.player, `${op.letter} re-rolls all attack dice`);
    rolled.forEach((die, i) => rerollDie(die, results[i]!, hit, lethal !== undefined ? { lethal } : {}));
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `VIOLENT TEMPERAMENT: ${op.letter} must re-roll all of its attack dice — ${results.join(', ')}`,
    });
  });

  // =========================================================================
  // AMBUSH (strategy)
  // =========================================================================
  // The shadow order ledger (the Wyrmblade Cult Ambush precedent).
  const ledger = T.bind(SP.ambush, 4);
  reg.on('onReadyStep', ledger, (ev) => {
    if (ev.player === T.player) recordOrders(T, ev.state);
  });
  reg.on('gambitOptions', ledger, (ev) => {
    if (ev.player === T.player) recordOrders(T, ev.state);
  });
  reg.on('onDeploy', ledger, (ev) => {
    if (ev.operative.player === T.player) recordOrders(T, ev.state, ev.operative.id);
  });
  reg.on('onActivationEnd', ledger, (ev) => {
    if (ev.operative.player === T.player) recordOrders(T, ev.state, ev.operative.id);
  });

  // "Whenever a friendly FELLGOR RAVAGER operative is activated, if its order is changed from
  //  Conceal to Engage, it's ambushing for that activation. … Note that an operative that has one of
  //  your Frenzy tokens cannot ambush."
  reg.on('onActivationStart', T.bind(SP.ambush, 7), (ev) => {
    const op = ev.operative;
    if (!isMine(op)) return;
    const before = recordedOrder(ev.state, op.id);
    if (before === 'conceal' && op.order === 'engage' && !hasFrenzy(ev.state, op, T.player)) {
      effect(ev.state, {
        rule: E_AMBUSHING,
        source: { kind: 'ploy', id: SP.ambush },
        sourceText: shortQuote(text(SP.ambush)),
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
    }
    recordOrders(T, ev.state);
  });

  // "Whenever a friendly FELLGOR RAVAGER operative that's ambushing is FIGHTING, you can retain one
  //  of your normal successes as a critical success instead." Applied at the retention step, which
  //  both sequences reach through `onWeaponRules` (the Hearthkyn Grudge seam); free and strictly
  //  beneficial, so auto-used (D-022). "is fighting" — never while retaliating.
  reg.on('onWeaponRules', T.bind(SP.ambush, 16), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.ambush)) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.step !== 'retention' || ev.retaliating) return;
    const op = ev.operative;
    if (!isMine(op) || seq.attackerId !== op.id) return;
    if (!isAmbushing(ev.state, op.id)) return;
    const pool = seq.attackerPool;
    if (pool.dice.some((d) => d.note === AMBUSH_NOTE)) return;
    const die = pool.dice.find((d) => d.state === 'normal');
    if (!die) return;
    die.state = 'crit';
    die.note = AMBUSH_NOTE;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `AMBUSH: ${op.letter} retains a normal success as a critical success`,
    });
  });

  // =========================================================================
  // PELTING FIREPOWER (strategy)
  // =========================================================================
  // The ledger: which friendly operatives have shot which enemy this turning point.
  reg.on('onStrikeResolved', T.bindText(`${SP.peltingFirepower}.ledger`, text(SP.peltingFirepower), 8), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    const shooter = ev.ctx.attacker;
    if (!isMine(shooter)) return;
    if (ev.struck.player === T.player) return;
    recordPelting(ev.state, T.player, ev.struck.id, shooter.id);
  });

  // "…that first friendly operative's ranged weapons have the Ceaseless weapon rule; if the enemy
  //  operative has been shot by MORE THAN ONE other friendly FELLGOR RAVAGER operative during this
  //  turning point, that first friendly operative's ranged weapons have the Relentless weapon rule
  //  instead."
  reg.on('onWeaponRules', T.bind(SP.peltingFirepower, 12), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.peltingFirepower)) return;
    if (ev.type !== 'ranged') return;
    const op = ev.operative;
    if (!isMine(op) || !ev.target) return;
    const others = peltingShooters(ev.state, T.player, ev.target.id, op.id);
    if (others <= 0) return;
    if (others > 1) {
      if (!ev.rules.some((r) => r.id === 'Relentless')) ev.rules.push(ruleTag('Relentless'));
      return;
    }
    if (!ev.rules.some((r) => r.id === 'Ceaseless')) ev.rules.push(ruleTag('Ceaseless'));
  });

  // =========================================================================
  // RECKLESS DETERMINATION (strategy)
  // =========================================================================
  /*
   * "Whenever an enemy operative is shooting an EXPENDED friendly FELLGOR RAVAGER operative, if you
   *  cannot retain any cover saves, you can retain one of your defence dice as a normal success
   *  without rolling it."
   *
   * There is no defence-retention hook, so one die fewer is rolled at the Roll Defence Dice step and
   * the retained die is pushed in at the post-roll emit (the Elucidian ARMOURED UNDERSUIT /
   * Mandrakes GLOAMING SHROUD precedent).
   */
  reg.on('onDefenceDice', T.bind(SP.recklessDetermination, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.recklessDetermination)) return;
    const target = ev.ctx.defender;
    if (!target || !isMine(target) || !target.expended) return;
    if (ev.ctx.attacker.player === T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id) return;
    const b = bucket(ev.state, RECKLESS_KEY) as Record<string, string>;
    const key = `${T.player}:${target.id}`;
    const stamp = shootStamp(seq);
    if (seq.step === 'rollDefence') {
      if (ev.coverSave || ev.count <= 0 || b[key] === stamp) return;
      b[key] = stamp;
      ev.count -= 1;
      return;
    }
    if (seq.step !== 'defenceRerolls' || b[key] !== stamp || b[`${key}|done`] === stamp) return;
    b[`${key}|done`] = stamp;
    addAutoNormal(seq.defence, 1, 'RECKLESS DETERMINATION');
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `RECKLESS DETERMINATION: ${target.letter} retains one defence dice as a normal success without rolling it`,
    });
  });

  // =========================================================================
  // RUTHLESS RAMPAGE (firefight) — the free Charge is its own 0AP ActionDef (D-021)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.ruthlessRampage, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.ruthlessRampage) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op) return;
    for (const rule of [E_RAMPAGE, E_RAMPAGE_USED]) {
      effect(ev.state, {
        rule,
        source: { kind: 'ploy', id: FP.ruthlessRampage },
        sourceText: shortQuote(text(FP.ruthlessRampage)),
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfActivation', operativeId: op.id },
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `RUTHLESS RAMPAGE: ${op.letter} can immediately perform a free Charge action (max 3")`,
    });
  });

  // =========================================================================
  // WILD RAGE (firefight)
  // =========================================================================
  reg.on('onPloyUsed', T.bind(FP.wildRage, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.wildRage) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op) return;
    effect(ev.state, {
      rule: E_WILD_RAGE,
      source: { kind: 'ploy', id: FP.wildRage },
      sourceText: shortQuote(text(FP.wildRage)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  // "Until the end of that operative's activation, add 1" to its Move stat."
  reg.on('onStatMod', T.bind(FP.wildRage, 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, E_WILD_RAGE)) ev.mods.move += 1;
  });

  // =========================================================================
  // ANIMALISTIC FURY (firefight)
  // =========================================================================
  /*
   * "Use this firefight ploy when a friendly FELLGOR RAVAGER operative is fighting or retaliating and
   *  you strike with a critical success. Inflict 1 additional damage with that strike."
   *
   * `advanceFight` runs a whole fight inside the Fight action, and `enumerateCandidates` offers no
   * ploy while a decision is pending, so the ploy is DECLARED and then fires on its printed trigger
   * (the Mandrakes SHADOW'S BITE / Vespid NEUTRON OVERLOAD shape). A human using it at the
   * strike/block decision lands on the same armed effect — `reduce` allows `UsePloy` while a
   * decision is pending.
   */
  reg.on('onPloyUsed', T.bind(FP.animalisticFury, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.animalisticFury) return;
    effect(ev.state, {
      rule: E_ANIMALISTIC,
      source: { kind: 'ploy', id: FP.animalisticFury },
      sourceText: shortQuote(text(FP.animalisticFury)),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onStrikeResolved', T.bind(FP.animalisticFury, 26), (ev) => {
    if (!T.ctx || ev.ctx.type !== 'melee' || !ev.crit) return;
    const striker = ev.ctx.attacker;
    if (!isMine(striker)) return;
    const armed = ev.state.effects.find((e) => e.rule === E_ANIMALISTIC && e.player === T.player);
    if (!armed) return;
    dropEffects(ev.state, (e) => e === armed);
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `ANIMALISTIC FURY: ${striker.letter} inflicts 1 additional damage with that strike`,
    });
    inflictDamage(T.ctx, ev.state, ev.struck, 1, 'other');
  });

  // =========================================================================
  // BLOODSENSE (firefight)
  // =========================================================================
  /*
   * The window: "during a friendly FELLGOR RAVAGER operative's activation, when it incapacitates an
   * enemy operative within its control range."
   *
   * Against another FELLGOR RAVAGER kill team the enemy's own Frenzy PREVENTS the incapacitation —
   * and its last printed bullet says the opponent treats that operative as incapacitated at exactly
   * that moment. So the window opens either on a real incapacitation or on the emit that hands the
   * enemy its first Frenzy token, which the priority-5 snapshot below identifies exactly.
   */
  reg.on('onIncapacitated', T.bindText(`${FP.bloodsense}.snapshot`, text(FP.bloodsense), 5), (ev) => {
    (bucket(ev.state, BLOODSENSE_SNAP) as Record<string, boolean>)[ev.operative.id] = hasFrenzy(
      ev.state,
      ev.operative,
    );
  });
  reg.on('onIncapacitated', T.bindText(`${FP.bloodsense}.window`, text(FP.bloodsense), 20), (ev) => {
    if (!T.ctx) return;
    const victim = ev.operative;
    if (victim.player === T.player) return;
    const hadToken = Boolean((bucket(ev.state, BLOODSENSE_SNAP) as Record<string, boolean>)[victim.id]);
    const treatedAsIncapacitated = !ev.prevented || (!hadToken && hasFrenzy(ev.state, victim));
    if (!treatedAsIncapacitated) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op || !T.kw(op, KW)) return;
    if (!inControlRange(T.ctx, ev.state, op, victim)) return;
    const vc = T.card(victim);
    effect(ev.state, {
      rule: E_BLOODSENSE_READY,
      source: { kind: 'ploy', id: FP.bloodsense },
      sourceText: shortQuote(text(FP.bloodsense)),
      operativeId: op.id,
      player: T.player,
      data: {
        pos: { ...victim.pos },
        z: victim.z,
        mm: vc?.base.shape === 'round' ? vc.base.mm : 32,
        height: vc ? modelHeight(vc) : 1.6,
      },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });

  reg.on('onPloyUsed', T.bind(FP.bloodsense, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.bloodsense || !T.ctx) return;
    const op = activeFriendly(ev.state, T.player);
    if (!op) return;
    const ready = effectOn(ev.state, op.id, E_BLOODSENSE_READY);
    if (!ready) return;
    const pos = ready.data?.['pos'] as Vec2 | undefined;
    if (!pos) return;
    const ghost = bodyAt(
      pos,
      Number(ready.data?.['z'] ?? 0),
      { shape: 'round', mm: Number(ready.data?.['mm'] ?? 32) },
      Number(ready.data?.['height'] ?? 1.6),
    );
    const index = terrain(T.ctx, ev.state);
    const candidates = T.friendlies(ev.state)
      .filter((o) => T.kw(o, KW) && o.id !== op.id && o.ready)
      .filter(
        (o) =>
          baseGap(o.pos, baseOf(o), o.rot, pos, ghost.base, 0) <= 3 + EPS &&
          isVisible(index, ghost, body(T.ctx!, o)).visible,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const wanted = ev.data?.['operativeId'];
    const chosen =
      (typeof wanted === 'string' ? candidates.find((o) => o.id === wanted) : undefined) ?? candidates[0];
    if (!chosen) return;
    // PARTIAL: no activation-order seam — the pairing is recorded for the UI/AI (REMINDER_ONLY).
    effect(ev.state, {
      rule: E_BLOODSENSE_PAIR,
      source: { kind: 'ploy', id: FP.bloodsense },
      sourceText: shortQuote(text(FP.bloodsense)),
      operativeId: chosen.id,
      player: T.player,
      data: { after: op.id },
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `BLOODSENSE: ${chosen.letter} may activate immediately after ${op.letter}`,
    });
  });
}

const activeFriendly = (state: GameState, player: PlayerId): OperativeState | undefined => {
  const op = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  return op && op.player === player && !op.removed ? op : undefined;
};

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const isMine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // BRASS ADORNMENTS
  // =========================================================================
  // "Once per battle, you can use the Animalistic Fury and Wild Rage firefight ploys for 0CP each."
  // The reducer charges the CP before `onPloyUsed` fires, so this is a REFUND — the player still
  // needs the CP in hand (the Corsair Prowling Raiders / Wrecka GLYPHS precedent).
  reg.on('onPloyUsed', T.bind(EQ.brassAdornments, 30), (ev) => {
    if (ev.player !== T.player) return;
    if (!hasEquipment(ev.state, T.player, EQ.brassAdornments)) return;
    if (ev.ployId !== FP.animalisticFury && ev.ployId !== FP.wildRage) return;
    const b = bucket(ev.state, 'fellgor.brassAdornments') as Record<string, boolean>;
    const key = `${T.player}:${ev.ployId}`;
    if (b[key]) return;
    b[key] = true;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `BRASS ADORNMENTS: that firefight ploy costs 0CP (1CP refunded)`,
    });
  });

  // =========================================================================
  // GORE MARKS
  // =========================================================================
  /*
   * "Once per turning point, when a friendly FELLGOR RAVAGER operative is fighting or retaliating,
   *  you can use this rule. If you do, inflict 1 damage on that friendly operative and re-roll one
   *  of your attack dice. If the result is a fail, inflict 1 additional damage on that friendly
   *  operative."
   *
   * The same post-roll `onWeaponRules` seam VIOLENT TEMPERAMENT uses. It costs wounds, so the D-022
   * policy is stated: taken only when there is a failed attack dice worth re-rolling AND the
   * operative has at least 3 wounds left, so the worst case (2 damage) can neither incapacitate it
   * nor hand it a Frenzy token.
   */
  reg.on('onWeaponRules', T.bind(EQ.goreMarks, 18), (ev) => {
    if (!T.ctx || !hasEquipment(ev.state, T.player, EQ.goreMarks)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (seq.step !== 'attackerRerolls' && seq.step !== 'defenderRerolls') return;
    const op = ev.operative;
    if (!isMine(op)) return;
    const side: 'attacker' | 'defender' = ev.retaliating ? 'defender' : 'attacker';
    const mineId = side === 'attacker' ? seq.attackerId : seq.defenderId;
    if (mineId !== op.id) return;
    if (op.wounds < 3) return; // policy: never risk the Frenzy token
    const pool = side === 'attacker' ? seq.attackerPool : seq.defenderPool;
    const die = pool.dice
      .filter((d) => d.rolled && d.state === 'fail')
      .sort((a, b) => a.value - b.value)[0];
    if (!die) return;
    const b = bucket(ev.state, GORE_MARKS_KEY) as Record<string, string>;
    if (b[T.player] === `${ev.state.turningPoint}`) return;
    b[T.player] = `${ev.state.turningPoint}`;
    inflictDamage(T.ctx, ev.state, op, 1, 'other');
    const assists = side === 'attacker' ? seq.attackerAssists : seq.defenderAssists;
    const hit = hitOf(T.ctx, ev.state, op, ev.profile, assists);
    const lethal = ev.rules.find((r) => r.id === 'Lethal')?.x;
    const roll = T.ctx.rng.d6();
    recordRoll(ev.state, 'goreMarks', [roll], T.player, `${op.letter} GORE MARKS re-roll`);
    rerollDie(die, roll, hit, lethal !== undefined ? { lethal } : {});
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `GORE MARKS: ${op.letter} takes 1 damage and re-rolls an attack dice — ${roll}`,
    });
    if (die.state === 'fail') inflictDamage(T.ctx, ev.state, op, 1, 'other');
  });

  // =========================================================================
  // CHAOS SIGIL
  // =========================================================================
  // "Once per turning point, when an operative is shooting a friendly FELLGOR RAVAGER operative, at
  //  the start of the Roll Defence Dice step, you can use this rule. If you do, worsen the x of the
  //  Piercing weapon rule by 1 (if any) until the end of that sequence. Note that Piercing 1 would
  //  therefore be ignored." The defence pool is `3 − Piercing`, so worsening x by 1 is exactly one
  //  more defence dice (the Corsair MISTFIELD / Void Dancer Harlequin's Panoply reading).
  reg.on('onDefenceDice', T.bind(EQ.chaosSigil, 22), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.chaosSigil)) return;
    const target = ev.ctx.defender;
    if (!target || !isMine(target)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    if (piercingValue(ev.ctx.rules, countCrits(seq.attack)) <= 0) return;
    // GONG KNELL already ignores Piercing for this operative, so the sigil would pay twice.
    if (effectOn(ev.state, target.id, E_GONG_KNELL)) return;
    if (!useOncePerTP(ev.state, `fellgor.chaosSigil.${T.player}`)) return;
    ev.count += 1;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `CHAOS SIGIL: the Piercing weapon rule is worsened by 1 against ${target.letter}`,
    });
  });

  // =========================================================================
  // WAR PAINT
  // =========================================================================
  // "You can ignore any changes to the Move stat of friendly FELLGOR RAVAGER operatives from being
  //  injured." `moveOf` subtracts 2" for injured after the hook, so +2" cancels it exactly (the Wolf
  //  Scouts Spiritual Chirurgy shape). The WARRIOR's own Warrior Frenzy already cancels it, so this
  //  stands down there rather than paying twice.
  reg.on('onStatMod', T.bind(EQ.warPaint, 32), (ev) => {
    const op = ev.operative;
    if (!isMine(op) || !T.ctx) return;
    if (!hasEquipment(ev.state, T.player, EQ.warPaint)) return;
    if (!isInjured(T.ctx, op)) return;
    if (op.datacardId === CARD.warrior && hasFrenzy(ev.state, op, T.player)) return;
    ev.mods.move += 2;
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

/** "each other operative visible to and within x" of this operative" */
function operativesWithin(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  inches: number,
): OperativeState[] {
  const index = terrain(ctx, state);
  return aliveOperatives(state)
    .filter((o) => o.id !== op.id)
    .filter((o) => gapBetween(ctx, op, o) <= inches + EPS)
    .filter((o) => isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** INCITE FURY's target: "one other friendly … operative (excluding SHAMAN or IRONHORN)". */
function inciteTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  wanted: string | undefined,
): OperativeState | undefined {
  const index = terrain(ctx, state);
  const reach = supportDistance(ctx, state, op, 3);
  const candidates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && catalogueKw(o, KW))
    .filter((o) => o.datacardId !== CARD.shaman && o.datacardId !== CARD.ironhorn)
    .filter((o) => gapBetween(ctx, op, o) <= reach + EPS && isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (wanted) return candidates.find((o) => o.id === wanted);
  return candidates[0];
}

/** APOPLECTIC REJUVENATION's target — it may be the SHAMAN itself ("one friendly … operative"). */
function rejuvenationTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  wanted: string | undefined,
): OperativeState | undefined {
  const index = terrain(ctx, state);
  const candidates = aliveOperatives(state, op.player)
    .filter((o) => catalogueKw(o, KW))
    .filter((o) => !hasToken(state, o.id, FRENZY_TOKEN, op.player))
    .filter(
      (o) =>
        o.id === op.id ||
        (gapBetween(ctx, op, o) <= 6 + EPS && isVisible(index, body(ctx, op), body(ctx, o)).visible),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (wanted) return candidates.find((o) => o.id === wanted);
  // Deterministic default (D-016): the operative that has lost the most wounds.
  return [...candidates].sort((a, b) => {
    const la = (card(ctx, a).wounds ?? a.wounds) - a.wounds;
    const lb = (card(ctx, b).wounds ?? b.wounds) - b.wounds;
    return lb - la || (a.id < b.id ? -1 : 1);
  })[0];
}

/** "has incapacitated an enemy operative while fighting or retaliating during the battle" */
export const hasMeleeKill = (state: GameState, operativeId: string): boolean =>
  Boolean((bucket(state, MELEE_KILLS_KEY) as Record<string, boolean>)[operativeId]);

/** The one enemy operative a free UNCOMPROMISING ATTACK Shoot may (and must) target. */
function uncompromisingShootTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  wanted: string | undefined,
): OperativeState | undefined {
  const weapon = weaponsOf(ctx, state, op, 'ranged').find((w) => sameName(w.name, 'Autopistol'));
  if (!weapon) return undefined;
  const profile = weapon.profiles.find((p) => p.type === 'ranged');
  if (!profile) return undefined;
  const engagedWith = enemiesInControlRange(ctx, state, op);
  // "…it can and must target an enemy operative within its control range (even if other friendly
  //  operatives are within that enemy operative's control range)." The engine's point-blank path is
  //  the one that waives the engaged ban and the friendly-control-range block, but it ALSO waives
  //  visibility and the Conceal-in-cover test, which this rule does not — so those two are
  //  re-applied here (the Exaction Squad CLOSE QUARTERS VIGILANCE / Corsair Quick on the Trigger
  //  precedent).
  const index = terrain(ctx, state);
  const pool =
    engagedWith.length > 0
      ? engagedWith.filter((foe) => {
          if (!isVisible(index, body(ctx, op), body(ctx, foe)).visible) return false;
          if (foe.order !== 'conceal') return true;
          return !coverAndObscured(index, body(ctx, op), body(ctx, foe)).inCover;
        })
      : aliveOperatives(state, otherPlayer(op.player)).filter((foe) => {
          const wrules = effectiveRules(ctx, state, profile, { operative: op, target: foe, weaponName: weapon.name });
          return checkTarget(ctx, state, op, foe, profile, wrules).valid;
        });
  const sorted = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (wanted) return sorted.find((o) => o.id === wanted);
  return sorted[0];
}

function actions(data: TeamData): ActionDef[] {
  return [
    // ---- DEATHKNELL › GONG KNELL 1AP -------------------------------------
    uniqueAction(data, CARD.deathknell, ACT.gongKnell, {
      check: () => ({ ok: true }),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === E_GONG_KNELL && e.operativeId === op.id);
        effect(state, {
          rule: E_GONG_KNELL,
          source: { kind: 'ability', id: ACT.gongKnell },
          sourceText: shortQuote(actionText(CARD.deathknell, ACT.gongKnell)),
          operativeId: op.id,
          player: op.player,
          // "Until the START of this operative's next activation" — the engine has no such expiry
          // kind, so the module drops it at that moment (and on incapacitation) itself.
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter} sounds the GONG KNELL` });
        return { ok: true };
      },
    }),

    // ---- FLUXBRAY › CLEAVER FLURRY 2AP -----------------------------------
    /*
     * "Perform a free Reposition action with this operative. During that action, it can move an
     *  additional 2", and can move within control range of enemy operatives (it cannot begin or end
     *  the move there). Inflict D3+1 damage on each enemy operative it moved within control range of
     *  (roll separately for each after it's moved, in the order it moved within control range of
     *  them). This operative cannot perform this action while it has a Conceal order."
     *
     * `validateMove` only ever tests the END of a move against control range, so "can move within
     * control range of enemy operatives" is already true for every operative in the game (the Void
     * Dancer Harlequin's Panoply finding); the printed carve-out that DOES need code is "it cannot
     * begin … the move there", which the universal Reposition's own `check` supplies. The swept
     * control range is measured by sampling the declared path (the Murderwing BOOST ZONE shape).
     */
    uniqueAction(data, CARD.fluxbray, ACT.cleaverFlurry, {
      treatedAs: 'Reposition',
      check: (ctx, state, op, params) => {
        if (op.order === 'conceal')
          return { ok: false, reason: 'it cannot perform this action while it has a Conceal order' };
        return cleaverFlurryMove(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => {
        const before = { ...op.pos };
        const swept = cleaverFlurrySwept(ctx, state, op, params);
        const res = cleaverFlurryApply(ctx, state, op, params);
        if (!res.ok) return res;
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: CLEAVER FLURRY from (${before.x.toFixed(1)}, ${before.y.toFixed(1)})`,
        });
        for (const foe of swept) {
          const d3 = ctx.rng.d3();
          recordRoll(state, 'cleaverFlurry', [d3], op.player, `${op.letter} vs ${foe.letter}`);
          inflictDamage(ctx, state, foe, d3 + 1, 'other');
        }
        return { ok: true };
      },
    }),

    // ---- GNARLSCAR › UNCOMPROMISING ATTACK 1AP ---------------------------
    /*
     * "Perform a free Fight action with this operative, then perform a free Shoot action with this
     *  operative (or vice versa)."
     *
     * `state.sequence` is single-slot and `advanceFight` can raise decisions, so the two halves
     * cannot both resolve inside one `perform`: the printed action performs the Fight and arms a 0AP
     * `Shoot (Uncompromising Attack)` for the second half (the Elucidian UNCOMPROMISING FIRE shape).
     * "or vice versa" is the deterministic default (D-016): the Fight goes first, which is also the
     * only order in which both halves can ever happen — the Shoot half's printed target lock needs
     * the operative to be engaged.
     */
    uniqueAction(data, CARD.gnarlscar, ACT.uncompromisingAttack, {
      check: (ctx, state, op, params) => {
        if (did(op, 'Fight')) return { ok: false, reason: 'it has already performed the Fight action' };
        if (did(op, 'Shoot')) return { ok: false, reason: 'it has already performed the Shoot action' };
        const foes = enemiesInControlRange(ctx, state, op);
        if (foes.length === 0) return { ok: false, reason: 'no enemy operative within control range' };
        if (weaponsOf(ctx, state, op, 'melee').length === 0)
          return { ok: false, reason: 'operative has no melee weapon' };
        if (params.targetId && !foes.some((f) => f.id === params.targetId))
          return { ok: false, reason: 'that operative is not within control range' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const foes = enemiesInControlRange(ctx, state, op);
        const foe = (params.targetId ? foes.find((f) => f.id === params.targetId) : undefined) ?? foes[0];
        if (!foe) return { ok: false, reason: 'no enemy operative within control range' };
        effect(state, {
          rule: E_UNCOMPROMISING,
          source: { kind: 'ability', id: ACT.uncompromisingAttack },
          sourceText: shortQuote(actionText(CARD.gnarlscar, ACT.uncompromisingAttack)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        // "…a free FIGHT action" — action restrictions still see it as a Fight.
        if (!op.actionsThisActivation.includes('Fight')) op.actionsThisActivation.push('Fight');
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: UNCOMPROMISING ATTACK (Fight first)` });
        return getAction('Fight')!.perform(ctx, state, op, {
          meleeWeaponName: weaponsOf(ctx, state, op, 'melee')[0]!.name,
          targetId: foe.id,
        });
      },
    }),

    // ---- HERD-GOAD › INCITE FURY 1AP -------------------------------------
    uniqueAction(data, CARD.herdGoad, ACT.inciteFury, {
      check: (ctx, state, op, params) => {
        const free = notEngaged(ctx, state, op);
        if (!free.ok) return free;
        if (!inciteTarget(ctx, state, op, params.targetOperativeId ?? params.targetId))
          return { ok: false, reason: 'no other friendly FELLGOR RAVAGER operative visible to and within 3"' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = inciteTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        // "Until the end of that operative's next activation, add 1 to its APL stat." Through
        // `onStatMod`, never the leaking `aplMods` (the Farstalker TROPHY precedent).
        dropEffects(state, (e) => e.rule === E_INCITE_FURY && e.operativeId === target.id);
        effect(state, {
          rule: E_INCITE_FURY,
          source: { kind: 'ability', id: ACT.inciteFury },
          sourceText: shortQuote(actionText(CARD.herdGoad, ACT.inciteFury)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: true },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter} incites ${target.letter} (+1 APL)` });
        return { ok: true };
      },
    }),

    // ---- SHAMAN › APOPLECTIC REJUVENATION 1AP ----------------------------
    uniqueAction(data, CARD.shaman, ACT.apoplecticRejuvenation, {
      check: (ctx, state, op, params) => {
        const free = notEngaged(ctx, state, op);
        if (!free.ok) return free;
        if (!rejuvenationTarget(ctx, state, op, params.targetOperativeId ?? params.targetId))
          return {
            ok: false,
            reason: 'no friendly FELLGOR RAVAGER operative without a Frenzy token visible to and within 6"',
          };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const target = rejuvenationTarget(ctx, state, op, params.targetOperativeId ?? params.targetId)!;
        // "regains up to 2D3 lost wounds; if that operative has incapacitated an enemy operative
        //  while fighting or retaliating during the battle, it regains up to 6 lost wounds instead."
        let heal: number;
        if (hasMeleeKill(state, target.id)) {
          heal = 6;
        } else {
          const a = ctx.rng.d3();
          const b = ctx.rng.d3();
          recordRoll(state, 'apoplecticRejuvenation', [a, b], op.player, `${target.letter} 2D3`);
          heal = a + b;
        }
        const max = card(ctx, target).wounds;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: APOPLECTIC REJUVENATION — ${target.letter} regains up to ${heal} lost wounds (${target.wounds})`,
        });
        return { ok: true };
      },
    }),

    // ---- SHAMAN › MANTLE OF DARKNESS 1AP (PSYCHIC) -----------------------
    uniqueAction(data, CARD.shaman, ACT.mantleOfDarkness, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === E_MANTLE && e.operativeId === op.id);
        effect(state, {
          rule: E_MANTLE,
          source: { kind: 'ability', id: ACT.mantleOfDarkness },
          sourceText: shortQuote(actionText(CARD.shaman, ACT.mantleOfDarkness)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter} draws a MANTLE OF DARKNESS` });
        return { ok: true };
      },
    }),

    // ---- VANDAL › SWEEPING BLOW 1AP --------------------------------------
    // "Inflict D3+1 damage on each OTHER operative visible to and within 2" of this operative" —
    // friendly operatives included, which is why the action carries no target selection at all.
    uniqueAction(data, CARD.vandal, ACT.sweepingBlow, {
      check: (_ctx, _state, op) =>
        op.order === 'conceal'
          ? { ok: false, reason: 'it cannot perform this action while it has a Conceal order' }
          : { ok: true },
      perform: (ctx, state, op) => {
        const victims = operativesWithin(ctx, state, op, 2);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: SWEEPING BLOW hits ${victims.length} operative${victims.length === 1 ? '' : 's'}`,
        });
        for (const victim of victims) {
          const d3 = ctx.rng.d3();
          recordRoll(state, 'sweepingBlow', [d3], op.player, `${op.letter} vs ${victim.letter}`);
          inflictDamage(ctx, state, victim, d3 + 1, 'other');
        }
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// CLEAVER FLURRY movement helpers
// ---------------------------------------------------------------------------

const CLEAVER_OPTS = {
  action: 'Reposition' as const,
  bonusInches: 2,
  mayEnterEnemyControlRange: true,
  mustNotFinishEngaged: true,
};

function cleaverFlurryMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string } {
  // "(it cannot BEGIN … the move there)" — the universal Reposition's own condition.
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'within control range of an enemy operative' };
  if (did(op, 'Fall Back') || did(op, 'Charge'))
    return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const v = validateMove(ctx, state, op, params.path, CLEAVER_OPTS);
  return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
}

function cleaverFlurryApply(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string } {
  const v = validateMove(ctx, state, op, params.path!, CLEAVER_OPTS);
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  op.pos = { ...v.endPos };
  op.z = v.endZ;
  if (params.path!.endRot !== undefined) op.rot = params.path!.endRot;
  op.onGuard = false;
  return { ok: true };
}

/**
 * "each enemy operative it moved within control range of … in the order it moved within control
 * range of them" — the declared path is sampled at 0.25" steps and each enemy is recorded the first
 * time the moving base would be within its control range (the Murderwing BOOST ZONE measurement).
 */
function cleaverFlurrySwept(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState[] {
  const path = params.path;
  if (!path) return [];
  const foes = aliveOperatives(state, otherPlayer(op.player));
  if (foes.length === 0) return [];
  const c = card(ctx, op);
  const height = modelHeight(c);
  const out: OperativeState[] = [];
  const seen = new Set<string>();
  const points: { p: Vec2; z: number }[] = [{ p: { ...op.pos }, z: op.z }];
  path.points.forEach((p, i) => points.push({ p, z: path.zs?.[i] ?? op.z }));
  const index = terrain(ctx, state);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const steps = Math.max(1, Math.ceil(dist(a.p, b.p) / 0.25));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const at: Body = {
        id: op.id,
        pos: { x: a.p.x + (b.p.x - a.p.x) * t, y: a.p.y + (b.p.y - a.p.y) * t },
        z: a.z + (b.z - a.z) * t,
        rot: op.rot,
        base: c.base,
        height,
      };
      for (const foe of foes) {
        if (seen.has(foe.id)) continue;
        const fb = body(ctx, foe);
        if (baseGap(at.pos, at.base, at.rot, fb.pos, fb.base, fb.rot) > 1 + EPS) continue;
        if (!isVisible(index, at, fb).visible) continue;
        seen.add(foe.id);
        out.push(foe);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extra ActionDefs (D-021) — each one the universal action refuses
// ---------------------------------------------------------------------------

/**
 * The universal `Fight` action takes its enemy straight out of `params.targetId` without checking
 * it, which is safe for the four universal ids the AI builds params for — but `src/ai/legal.ts`
 * offers a `type: 'unique'` action every operative id it can think of, friendly ones included, so an
 * extra Fight of our own has to validate the selection in `check` (docs/DECISIONS.md D-026).
 */
function fightTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const foes = enemiesInControlRange(ctx, state, op);
  if (params.targetId) return foes.find((f) => f.id === params.targetId);
  return foes[0];
}

function extraFight(id: string, sourceText: string, ap: number, owner: string, gate: string): void {
  registerAction({
    id,
    name: id,
    ap,
    type: 'unique',
    sourceText,
    available: (_ctx, _state, op) => op.datacardId === owner,
    check(ctx, state, op, params) {
      if (counteracting(state, op)) return { ok: false, reason: gate };
      if (!did(op, 'Fight')) return { ok: false, reason: gate };
      if (!fightTarget(ctx, state, op, params))
        return { ok: false, reason: 'no enemy operative within control range' };
      const base = getAction('Fight')!.check(ctx, state, op, params);
      if (!base.ok) return base;
      return { ok: true };
    },
    perform(ctx, state, op, params) {
      const foe = fightTarget(ctx, state, op, params);
      if (!foe) return { ok: false, reason: 'no enemy operative within control range' };
      return getAction('Fight')!.perform(ctx, state, op, { ...params, targetId: foe.id });
    },
  });
}

/** GOREHORN › Champion: "This operative can perform two Fight actions during its activation." */
extraFight(
  FIGHT_CHAMPION,
  abilityText(CARD.gorehorn, AB.champion),
  1,
  CARD.gorehorn,
  'this is the second Fight action of an activation',
);

/**
 * MANGLER › Savage: "The first time this operative performs the Fight action during each of its
 * activations … it can immediately perform a free Fight action afterwards … This takes precedence
 * over action restrictions" — hence 0AP and no `treatedAs`, so the restriction key is its own.
 */
extraFight(
  FIGHT_SAVAGE,
  abilityText(CARD.mangler, AB.savage),
  0,
  CARD.mangler,
  'only after the first Fight action of this activation',
);

/**
 * RUTHLESS RAMPAGE: "That friendly operative can immediately perform a free Charge action (even if
 * it's already performed the Charge action during that activation), but cannot move more than 3"."
 * 0AP with no `treatedAs`, so the printed carve-out works; the 3" cap goes through
 * `MoveOptions.hardCap` in `check`, and `perform` delegates to the universal Charge, whose budget is
 * a strictly larger superset — so `perform` can never refuse what `check` allowed (D-026).
 */
registerAction({
  id: CHARGE_RAMPAGE,
  name: CHARGE_RAMPAGE,
  ap: 0,
  type: 'unique',
  sourceText: text(FP.ruthlessRampage),
  available: (_ctx, state, op) =>
    catalogueKw(op, KW) && state.effects.some((e) => e.rule === E_RAMPAGE && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === E_RAMPAGE && e.operativeId === op.id))
      return { ok: false, reason: 'RUTHLESS RAMPAGE has not been used for this operative' };
    if (!did(op, 'Fight')) return { ok: false, reason: 'only after it performs the Fight action' };
    if (op.order === 'conceal') return { ok: false, reason: 'cannot Charge with a Conceal order' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'it is still within control range of an enemy operative' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Charge',
      bonusInches: 2,
      mayEnterEnemyControlRange: true,
      mustFinishEngaged: true,
      hardCap: 3,
    });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  perform(ctx, state, op, params) {
    const res = getAction('Charge')!.perform(ctx, state, op, params);
    if (res.ok) dropEffects(state, (e) => e.rule === E_RAMPAGE && e.operativeId === op.id);
    return res;
  },
});

/**
 * The second half of UNCOMPROMISING ATTACK. `treatedAs: 'Shoot'` because it IS a Shoot action for
 * action restrictions — the printed rule says "a free Shoot action", not "taking precedence over
 * action restrictions".
 */
registerAction({
  id: SHOOT_UNCOMPROMISING,
  name: SHOOT_UNCOMPROMISING,
  ap: 0,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: actionText(CARD.gnarlscar, ACT.uncompromisingAttack),
  available: (_ctx, state, op) =>
    op.datacardId === CARD.gnarlscar && state.effects.some((e) => e.rule === E_UNCOMPROMISING && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === E_UNCOMPROMISING && e.operativeId === op.id))
      return { ok: false, reason: 'only as the free Shoot action of UNCOMPROMISING ATTACK' };
    if (!weaponsOf(ctx, state, op, 'ranged').some((w) => sameName(w.name, 'Autopistol')))
      return { ok: false, reason: 'you can only select an autopistol for that Shoot action' };
    if (!uncompromisingShootTarget(ctx, state, op, params.targetId))
      return { ok: false, reason: 'no valid target for its autopistol' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const target = uncompromisingShootTarget(ctx, state, op, params.targetId)!;
    const weapon = weaponsOf(ctx, state, op, 'ranged').find((w) => sameName(w.name, 'Autopistol'))!;
    dropEffects(state, (e) => e.rule === E_UNCOMPROMISING && e.operativeId === op.id);
    // "This operative can perform that Shoot action while within control range of an enemy
    //  operative" — the engine's point-blank path is the one that waives the engaged ban and the
    //  friendly-control-range block, exactly as the printed carve-out asks.
    const pointBlank = enemiesInControlRange(ctx, state, op).some((e) => e.id === target.id);
    if (!pointBlank)
      return getAction('Shoot')!.perform(ctx, state, op, { weaponName: weapon.name, targetId: target.id });
    // The printed rule creates an ordinary Shoot action, not an On Guard interrupt, so the engine's
    // point-blank Hit penalty is cancelled (below, at `onCollectAttackDice`).
    effect(state, {
      rule: E_UNCOMP_SHOT,
      source: { kind: 'ability', id: ACT.uncompromisingAttack },
      sourceText: shortQuote(actionText(CARD.gnarlscar, ACT.uncompromisingAttack)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    const r = startShoot(ctx, state, op, weapon.name, undefined, target.id, { pointBlank: true, free: true });
    if (!r.ok) return r;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

/**
 * TOXHORN › Pox Bomb: "This operative can use stun grenades (see universal equipment). Doing so
 * doesn't count towards any limited uses you have." The universal Stun Grenade action is gated on
 * the Utility Grenades equipment, so the TOXHORN gets its own (the Kommandos Taktical Wot-notz /
 * Hearthkyn GRENADIER shape) with the kill team's grenade budget floored and restored.
 */
registerAction({
  id: STUN_POX_BOMB,
  name: STUN_POX_BOMB,
  ap: 1,
  type: 'unique',
  sourceText: abilityText(CARD.toxhorn, AB.poxBomb),
  available: (_ctx, _state, op) => op.datacardId === CARD.toxhorn,
  check(ctx, state, op, params) {
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    return getAction('Stun Grenade')!.check(ctx, withGrenadeBudgetIgnored(state, op.player), op, params);
  },
  perform(ctx, state, op, params) {
    const uses = { ...state.teams[op.player].equipmentUses };
    state.teams[op.player].equipmentUses = {
      ...withGrenadeBudgetIgnored(state, op.player).teams[op.player].equipmentUses,
    };
    const res = getAction('Stun Grenade')!.perform(ctx, state, op, params);
    state.teams[op.player].equipmentUses = uses;
    return res;
  },
});

// ---------------------------------------------------------------------------
// Cross-cutting bookkeeping that belongs to no single printed rule
// ---------------------------------------------------------------------------

function bookkeeping(reg: HookRegistry, T: TeamHooks): void {
  // GONG KNELL — "Until the start of this operative's next activation … whenever an operative is
  // shooting this operative, improve this operative's Save stat by 1 and ignore the Piercing
  // weapon rule."
  reg.on('onActivationStart', T.bindText(ACT.gongKnell, actionText(CARD.deathknell, ACT.gongKnell), 6), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === E_GONG_KNELL && e.operativeId === ev.operative.id);
  });
  reg.on('onDefenceDice', T.bindText(ACT.gongKnell, actionText(CARD.deathknell, ACT.gongKnell), 20), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player) return;
    if (!effectOn(ev.state, target.id, E_GONG_KNELL)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    ev.mods.save += 1;
    const piercing = piercingValue(ev.ctx.rules, countCrits(seq.attack));
    if (piercing > 0) ev.count += piercing;
  });

  // MANTLE OF DARKNESS — the targeting veto. Bound at 60 so it speaks after every other
  // `onValidTarget` handler, which is what "taking precedence over all other rules" means; cover is
  // recomputed with DEFAULT options (the Ratlings SHIFTY / Blades ONE WITH THE GLOOM precedent).
  reg.on('onValidTarget', T.bindText(ACT.mantleOfDarkness, actionText(CARD.shaman, ACT.mantleOfDarkness), 60), (ev) => {
    if (!T.ctx) return;
    const target = ev.target;
    if (!T.mineKw(target, KW) || target.order !== 'conceal') return;
    if (!ev.state.effects.some((e) => e.rule === E_MANTLE && e.player === T.player)) return;
    if (gapBetween(T.ctx, ev.attacker, target) <= 2 + EPS) return; // "except being within 2""
    const index = terrain(T.ctx, ev.state);
    const shaman = T.friendlies(ev.state).find(
      (o) =>
        o.datacardId === CARD.shaman &&
        effectOn(ev.state, o.id, E_MANTLE) &&
        T.gap(o, target) <= 3 + EPS &&
        isVisible(index, body(T.ctx!, o), body(T.ctx!, target)).visible,
    );
    if (!shaman) return;
    if (!coverAndObscured(index, body(T.ctx, ev.attacker), body(T.ctx, target)).inCover) return;
    ev.valid = false;
    ev.reason = 'MANTLE OF DARKNESS: a Conceal-order FELLGOR RAVAGER operative in cover cannot be selected';
  });
  reg.on('onActivationStart', T.bindText(ACT.mantleOfDarkness, actionText(CARD.shaman, ACT.mantleOfDarkness), 6), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.shaman) return;
    dropEffects(ev.state, (e) => e.rule === E_MANTLE && e.operativeId === ev.operative.id);
  });

  // UNCOMPROMISING ATTACK's free Shoot goes down the engine's point-blank path (the only one that
  // waives the engaged ban and the friendly-control-range block), so the point-blank Hit penalty
  // that path applies — which this printed rule does not — is cancelled here.
  reg.on(
    'onCollectAttackDice',
    T.bindText(`${ACT.uncompromisingAttack}.hit`, actionText(CARD.gnarlscar, ACT.uncompromisingAttack), 12),
    (ev) => {
      if (ev.ctx.type !== 'ranged' || !ev.ctx.pointBlank) return;
      const op = ev.ctx.attacker;
      if (op.player !== T.player || op.datacardId !== CARD.gnarlscar) return;
      if (!effectOn(ev.state, op.id, E_UNCOMP_SHOT)) return;
      ev.mods.hit += 1;
    },
  );

  // INCITE FURY's +1 APL rides `onStatMod` (which `aplOf` consults), never `op.aplMods`.
  reg.on('onStatMod', T.bindText(ACT.inciteFury, actionText(CARD.herdGoad, ACT.inciteFury), 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, E_INCITE_FURY)) ev.mods.apl += 1;
  });

  // APOPLECTIC REJUVENATION's "if that operative has incapacitated an enemy operative while fighting
  // or retaliating during the battle" ledger. `onStrikeResolved` fires for BOTH sides of a fight.
  reg.on(
    'onStrikeResolved',
    T.bindText(`${ACT.apoplecticRejuvenation}.ledger`, actionText(CARD.shaman, ACT.apoplecticRejuvenation), 30),
    (ev) => {
      if (ev.ctx.type !== 'melee') return;
      const striker = ev.ctx.attacker;
      if (striker.player !== T.player) return;
      if (!ev.struck.incapacitated) return;
      (bucket(ev.state, MELEE_KILLS_KEY) as Record<string, boolean>)[striker.id] = true;
    },
  );
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const fellgorRavager = defineTeam({
  id: 'fellgor-ravager',
  rules: (reg, T) => {
    rules(reg, T);
    bookkeeping(reg, T);
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy after a friendly FELLGOR RAVAGER operative performs the Fight action,
    //  if it's no longer within control range of enemy operatives." The Savage carve-out — "you
    //  cannot use the Ruthless Rampage firefight ploy between those two Fight actions" — is the
    //  second clause.
    [FP.ruthlessRampage]: (state, player) => {
      const op = activeFriendly(state, player);
      if (!op || !catalogueKw(op, KW)) return { ok: false, reason: 'no friendly FELLGOR RAVAGER operative is active' };
      if (!did(op, 'Fight')) return { ok: false, reason: 'it has not performed the Fight action' };
      return { ok: true };
    },
    [FP.wildRage]: (state, player) => {
      const op = activeFriendly(state, player);
      if (!op || !catalogueKw(op, KW)) return { ok: false, reason: 'no friendly FELLGOR RAVAGER operative is active' };
      if (op.apSpent > 0 || op.actionsThisActivation.length > 0)
        return { ok: false, reason: 'use it when that operative is activated' };
      return { ok: true };
    },
    [FP.animalisticFury]: (state, player) =>
      state.phase === 'firefight' &&
      aliveOperatives(state, player).some((o) => catalogueKw(o, KW))
        ? { ok: true }
        : { ok: false, reason: 'no friendly FELLGOR RAVAGER operative could strike' },
    [FP.bloodsense]: (state, player) => {
      const op = activeFriendly(state, player);
      if (!op || !effectOn(state, op.id, E_BLOODSENSE_READY))
        return { ok: false, reason: 'no friendly operative has just incapacitated an enemy within its control range' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [CARD.ironhorn]: 'leader',
      [CARD.deathknell]: 'support',
      [CARD.fluxbray]: 'melee',
      [CARD.gnarlscar]: 'melee',
      [CARD.gorehorn]: 'melee',
      [CARD.herdGoad]: 'support',
      [CARD.mangler]: 'melee',
      [CARD.shaman]: 'support',
      [CARD.toxhorn]: 'gunner',
      [CARD.vandal]: 'melee',
      [CARD.warrior]: 'objective',
    },
    ployValue: {
      [SP.violentTemperament]: 0.65,
      [SP.ambush]: 0.5,
      [SP.peltingFirepower]: 0.35,
      [SP.recklessDetermination]: 0.45,
      [FP.ruthlessRampage]: 0.55,
      [FP.wildRage]: 0.4,
      [FP.animalisticFury]: 0.6,
      [FP.bloodsense]: 0.1,
    },
    equipmentValue: {
      [EQ.brassAdornments]: 0.45,
      [EQ.goreMarks]: 0.4,
      [EQ.chaosSigil]: 0.6,
      [EQ.warPaint]: 0.7,
    },
  },
});

export default fellgorRavager;
