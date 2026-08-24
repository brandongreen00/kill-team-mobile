/**
 * WRECKA KREW — Orks. https://wahapedia.ru/kill-team3/kill-teams/wrecka-krew/
 *
 * Rule text is read from `data/teams/wrecka-krew.json` and never retyped.
 *
 * Everything hangs off one per-player **Wrecka point** pool (`wreckaPoints`), capped at 6, that
 * seven printed rules read or write. The pool is gained and spent in the Roll Attack Dice step,
 * which has no hook of its own — `onAttackDiceRetained` is declared but never emitted — so it
 * rides the `onWeaponRules` emit that BOTH sequences make while `step === 'retention'`
 * (the Hearthkyn Salvager Grudge / Void Dancer WRAITHBONE TALISMAN seam), which is what makes
 * "shooting, fighting or retaliating" reachable in all three modes despite D-031.
 *
 * This team prints FIVE rare weapon rules — Detonate, Explosive, Pulsa, Salvo and Smash — and
 * every one of them resolves through `rareRuleTextFor` (D-033) to this team's OWN datacard
 * ability, which for Detonate and Salvo is a materially different rule from the shared registry
 * entry. See the report.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { classify, type DicePool } from '../../core/dice.ts';
import { EPS, baseRadius, basesOverlap, dist, mmToInches } from '../../core/geometry.ts';
import { HookRegistry, type RerollGrant } from '../../core/hooks.ts';
import { advanceShoot, checkTarget, startShoot, validTargets } from '../../core/sequences/shoot.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import {
  aliveOperatives,
  body,
  findProfile,
  hitOf,
  inControlRange,
  inflictDamage,
  isInjured,
  log,
  markerContestedBy,
  modelHeight,
  recordRoll,
  settleZ,
  startingWounds,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseDistanceToPart, baseTouchesHazardous, surfaceAt } from '../../core/terrain.ts';
import { isVisible } from '../../core/visibility.ts';
import type { ActionParams } from '../../core/intents.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  BaseShape,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  TerrainFeature,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  chosenOperative,
  defineTeam,
  effect,
  effectOn,
  dropEffects,
  gambitUsed,
  hasEquipment,
  placeTeamMarker,
  ployUsed,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('wrecka-krew');
const KW = 'WRECKA KREW';

// ---------------------------------------------------------------------------
// Printed ids
// ---------------------------------------------------------------------------

export const BOSS_NOB = 'wrecka-krew.boss-nob';
export const BOMB_SQUIG = 'wrecka-krew.bomb-squig';
export const DEMOLISHA = 'wrecka-krew.breaka-boy-demolisha';
export const FIGHTER = 'wrecka-krew.breaka-boy-fighter';
export const KRUSHA = 'wrecka-krew.breaka-boy-krusha';
export const GUNNER = 'wrecka-krew.tankbusta-gunner';
export const ROKKITEER = 'wrecka-krew.tankbusta-rokkiteer';

export const RULE_RAMPAGE = 'wrecka-krew.rule.wrecka-rampage';
export const RULE_TANKED_UP = 'wrecka-krew.rule.tanked-up';

export const SP_WAAAGH = 'wrecka-krew.sp.waaagh';
export const SP_DESTRUCTION = 'wrecka-krew.sp.destruction';
export const SP_TUFF_GITZ = 'wrecka-krew.sp.tuff-gitz';
export const SP_AMPED_UP = 'wrecka-krew.sp.amped-up';
export const FP_JUST_A_SCRATCH = 'wrecka-krew.fp.just-a-scratch';
export const FP_PROPPA_SCRAP = 'wrecka-krew.fp.proppa-scrap';
export const FP_DEMOLITION_JOB = 'wrecka-krew.fp.demolition-job';
export const FP_KABOOM = 'wrecka-krew.fp.kaboom';

export const EQ_DRILL_ROKKITS = 'wrecka-krew.eq.drill-rokkits';
export const EQ_ENGINE_OIL = 'wrecka-krew.eq.engine-oil';
export const EQ_EXTRA_ARMOUR = 'wrecka-krew.eq.extra-armour';
export const EQ_GLYPHS = 'wrecka-krew.eq.glyphs';

export const AB_WRECKA_BOSS = 'wrecka-krew.boss-nob.wrecka-boss';
export const AB_SALVO = 'wrecka-krew.boss-nob.salvo';
export const AB_EXPLOSIVE = 'wrecka-krew.bomb-squig.explosive';
export const AB_STOOPID = 'wrecka-krew.bomb-squig.stoopid';
export const AB_BOOM = 'wrecka-krew.bomb-squig.boom';
export const AB_EXPENDABLE = 'wrecka-krew.bomb-squig.expendable';
export const AB_RECKLESS = 'wrecka-krew.breaka-boy-demolisha.reckless-temperament';
export const AB_DETONATE = 'wrecka-krew.breaka-boy-demolisha.detonate';
export const AB_SMASH = 'wrecka-krew.breaka-boy-krusha.smash';
export const AB_ARMOURED_UP = 'wrecka-krew.breaka-boy-krusha.armoured-up';
export const AB_KOMPETITIVE = 'wrecka-krew.tankbusta-gunner.kompetitive-streak';
export const AB_PULSA = 'wrecka-krew.tankbusta-rokkiteer.pulsa';
export const AB_SHOKKWAVE = 'wrecka-krew.tankbusta-rokkiteer.shokkwave';
export const ACT_BREAK_STUFF = 'wrecka-krew.breaka-boy-fighter.act.break-stuff';

/** Action ids this module registers (team-distinctive: `registerAction` is a global map). */
export const EXPLOSIVE_SHOOT = 'Shoot (Wrecka Explosives)';
export const PULSA_SHOOT = 'Shoot (Pulsa Rokkit)';
export const PROPPA_SCRAP_FIGHT = 'Fight (Proppa Scrap)';

/** Clauses that have no honest expression on the current hook surface. */
export const REMINDER_ONLY: Record<string, string> = {
  [AB_EXPENDABLE]:
    'kill/elimination op and "escape/survive/incapacitated" victory conditions are op scoring, owned by src/core/ops/** — a team module cannot reach them',
  [`${AB_STOOPID}.weapons`]:
    '"It cannot use any weapons that aren\'t on its datacard": `weaponsOf` appends grantedWeapons AFTER `availableWeapons`, so there is no seam — and nothing in this team grants a weapon, so it bites on nothing',
  [`${ACT_BREAK_STUFF}.accessible`]:
    '"it treats parts of that terrain feature that are no more than 1" thick as Accessible terrain": terrain types are compiled from the map and `state.terrainState` carries only state/removed — no runtime type override exists (the Kommandos BREACH gap)',
  [`${FP_DEMOLITION_JOB}.timing`]:
    '"just before incapacitated operatives are removed": nothing runs at that point in `PerformAction`, so the marker is placed from `onPloyUsed` against the last Shoot/Fight target recorded this activation',
  [`${EQ_GLYPHS}.cost`]:
    '"it costs you 0CP": the reducer charges CP before `onPloyUsed`, so the discount is a refund and the player still needs the CP in hand to use the gambit at all',
};

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;
const ruleText = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** "friendly WRECKA KREW operative (excluding BOMB SQUIG)" — the shape most rules are written in. */
const isBoy = (T: TeamHooks, op: OperativeState): boolean => T.mineKw(op, KW) && !T.kw(op, 'BOMB SQUIG');

/** Every marker but an objective is 20mm (core rules › Markers). */
const MARKER_RADIUS = mmToInches(20) / 2;

// ---------------------------------------------------------------------------
// Wrecka points — the faction rule's economy
// ---------------------------------------------------------------------------

/** "You cannot have more than 6 Wrecka points at once." */
export const MAX_WRECKA_POINTS = 6;

export function wreckaPoints(state: GameState, player: PlayerId): number {
  return Number(bucket(state, 'wrecka-krew.points')[player] ?? 0);
}

function setWreckaPoints(state: GameState, player: PlayerId, n: number): void {
  bucket(state, 'wrecka-krew.points')[player] = Math.max(0, Math.min(MAX_WRECKA_POINTS, n));
}

/** Returns how many points were actually gained (the cap of 6 bites). */
export function gainWreckaPoints(state: GameState, player: PlayerId, n: number, why: string): number {
  const before = wreckaPoints(state, player);
  setWreckaPoints(state, player, before + n);
  const gained = wreckaPoints(state, player) - before;
  if (gained > 0)
    log(state, {
      kind: 'action',
      player,
      text: `+${gained} Wrecka point${gained > 1 ? 's' : ''} (${why}) — ${wreckaPoints(state, player)} held`,
    });
  return gained;
}

export function spendWreckaPoint(state: GameState, player: PlayerId): boolean {
  const held = wreckaPoints(state, player);
  if (held <= 0) return false;
  setWreckaPoints(state, player, held - 1);
  return true;
}

/** Dice notes, which double as the idempotency record across a retention re-entry. */
export const GAIN_NOTE = 'Wrecka point';
export const SPEND_NOTE = 'Wrecka Rampage';

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export const PULSA_MARKER = (player: PlayerId): string => `wrecka-krew.pulsa.${player}`;
export const DEMOLITION_MARKER = (player: PlayerId): string => `wrecka-krew.demolition.${player}`;

export function pulsaMarker(state: GameState, player: PlayerId): MarkerState | undefined {
  return state.markers[PULSA_MARKER(player)];
}

/** "X is that marker's Pulsa points." */
export function pulsaPoints(marker: MarkerState | undefined): number {
  return marker ? Number(marker.flags['pulsaPoints'] ?? 0) : 0;
}

/**
 * "each operative wholly within x" of that marker" — the whole base inside the ring measured
 * from the marker's edge (the Wolf Scouts STORM reading of "wholly within" of a marker).
 */
export function whollyWithinMarker(
  op: OperativeState,
  base: BaseShape,
  marker: MarkerState,
  inches: number,
): boolean {
  return dist(op.pos, marker.pos) + baseRadius(base) - MARKER_RADIUS <= inches + 1e-6;
}

// ---------------------------------------------------------------------------
// Faction rules
// ---------------------------------------------------------------------------

/**
 * The attack pool this operative owns in the in-flight sequence, plus who it is being used
 * against — the two things every Wrecka Rampage clause needs.
 */
function ownPool(
  state: GameState,
  op: OperativeState,
): { pool: DicePool; foe: OperativeState | undefined } | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'shoot') {
    if (seq.attackerId !== op.id) return undefined;
    return { pool: seq.attack, foe: state.operatives[seq.targetId] };
  }
  if (seq.attackerId === op.id) return { pool: seq.attackerPool, foe: state.operatives[seq.defenderId] };
  if (seq.defenderId === op.id) return { pool: seq.defenderPool, foe: state.operatives[seq.attackerId] };
  return undefined;
}

/** "an operative that's within 3" of that marker" — DEMOLITION JOB's free spend. */
function demolitionFreeSpend(T: TeamHooks, state: GameState, foe: OperativeState | undefined): boolean {
  if (!foe) return false;
  const marker = state.markers[DEMOLITION_MARKER(T.player)];
  if (!marker) return false;
  return T.markerGap(foe, marker) <= 3 + EPS;
}

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Wrecka Rampage (faction rule) --------------------------------------
  /*
   * "Whenever a friendly WRECKA KREW operative is shooting, fighting or retaliating, in the Roll
   *  Attack Dice step: For each attack dice result of 6 you retain, you gain one Wrecka point.
   *  You can spend up to 2 of your Wrecka points (unless it's a BOMB SQUIG, then you cannot spend
   *  any). For each point you spend this way, retain one of your fails as a normal success instead
   *  of discarding it. You cannot have more than 6 Wrecka points at once. You can gain and spend
   *  Wrecka points during the same action and can do so in an order of your choice, unless you
   *  started the action with 6, in which case you can only spend them."
   *
   * The Roll Attack Dice step's retention moment is reached in BOTH sequences through the
   * `onWeaponRules` emit made while `state.sequence.step === 'retention'`: `advanceShoot` calls
   * `effectiveRules` at the top of every iteration and `advanceFight`'s retention case calls
   * `sideWeapon` per side, each immediately before `retentionOptions` — so shooting, fighting AND
   * retaliating are all live (D-031 is side-stepped exactly as WRAITHBONE TALISMAN side-steps it).
   *
   * Order is the player's choice; gaining first is never worse than spending first (it can only
   * make more points available), so gain-then-spend is the deterministic default (D-016).
   * Spending is auto-used under D-022: there is nothing else in the team a Wrecka point can be
   * spent on, so holding one back can never pay off, and a decision on every attack roll would
   * drown the log. Both halves are idempotent across a retention re-entry, read back off the
   * dice notes.
   */
  reg.on('onWeaponRules', T.bind(RULE_RAMPAGE, 12), (ev) => {
    const state = ev.state;
    if (state.sequence?.step !== 'retention') return;
    if (!T.mineKw(ev.operative, KW)) return;
    const own = ownPool(state, ev.operative);
    if (!own) return;
    const { pool, foe } = own;

    // "unless you started the action with 6, in which case you can only spend them"
    const started = Number(bucket(state, 'wrecka-krew.actionStart')[T.player] ?? wreckaPoints(state, T.player));
    if (started < MAX_WRECKA_POINTS) {
      const sixes = pool.dice.filter(
        (d) => d.rolled && d.value === 6 && (d.state === 'crit' || d.state === 'normal') && d.note !== GAIN_NOTE,
      );
      for (const die of sixes) die.note = GAIN_NOTE;
      if (sixes.length > 0)
        gainWreckaPoints(state, T.player, sixes.length, `${ev.operative.letter}: ${sixes.length} × result of 6`);
    }

    // "(unless it's a BOMB SQUIG, then you cannot spend any)"
    if (T.kw(ev.operative, 'BOMB SQUIG')) return;
    let converted = pool.dice.filter((d) => d.note === SPEND_NOTE).length;
    // DEMOLITION JOB: "you can spend a Wrecka point for free (even if you have none)".
    const free = converted === 0 && isBoy(T, ev.operative) && demolitionFreeSpend(T, state, foe);
    let spent = 0;
    while (converted < 2) {
      const die = pool.dice.find((d) => d.state === 'fail');
      if (!die) break;
      const gratis = free && converted === 0;
      if (!gratis && !spendWreckaPoint(state, T.player)) break;
      die.state = 'normal';
      die.note = SPEND_NOTE;
      converted++;
      spent++;
    }
    if (spent > 0)
      log(state, {
        kind: 'dice',
        player: T.player,
        text: `Wrecka Rampage: ${spent} fail${spent > 1 ? 's' : ''} retained as normal success${spent > 1 ? 'es' : ''}${
          free ? ' (one free — DEMOLITION JOB)' : ''
        }`,
      });
  });

  /** The "started the action with 6" snapshot, taken as the first pool of the action is collected. */
  reg.on('onCollectAttackDice', T.bind(RULE_RAMPAGE, 11), (ev) => {
    if (ev.ctx.attacker.player !== T.player || !T.mineKw(ev.ctx.attacker, KW)) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const first =
      seq.kind === 'shoot'
        ? !seq.secondary && seq.resolvedTargets.length === 0
        : (seq.attackerId === ev.ctx.attacker.id ? seq.attackerPool : seq.defenderPool).dice.length === 0;
    if (!first) return;
    bucket(ev.state, 'wrecka-krew.actionStart')[T.player] = wreckaPoints(ev.state, T.player);
  });

  // ---- Tanked Up (faction rule) -------------------------------------------
  /*
   * "The first time a friendly WRECKA KREW operative (excluding BOMB SQUIG) that has an Engage
   *  order performs either the Charge, Shoot or Fight action (excluding Guard) during each of its
   *  activations/counteractions, add 1 to its APL stat until the start of its next activation."
   *
   * Nothing runs at the end of an action, so the trigger is read off the action's own effects:
   * a Shoot or a Fight is the moment its attack dice are collected — which Guard never reaches,
   * because Guard rolls no dice, so the printed "(excluding Guard)" holds by construction — and a
   * Charge is read from `actionsThisActivation`, which the reducer pushes as soon as the move
   * resolves. The +1 rides `onStatMod` (which `aplOf` consults) rather than `op.aplMods`, so it
   * expires with its effect and never leaks a permanent modifier.
   */
  const TANKED_EFFECT = 'wrecka-krew.tankedUp';
  const armTankedUp = (state: GameState, op: OperativeState): void => {
    if (!isBoy(T, op) || op.order !== 'engage') return;
    if (effectOn(state, op.id, TANKED_EFFECT)) return;
    effect(state, {
      rule: TANKED_EFFECT,
      source: { kind: 'ability', id: RULE_TANKED_UP },
      sourceText: shortQuote(ruleText(RULE_TANKED_UP)),
      operativeId: op.id,
      player: T.player,
      // "until the start of its next activation" — dropped by the handler below; the engine has
      // no expiry kind for it (the Hernkyn Yaegir Intrepid note).
      expiry: { kind: 'endOfBattle' },
    });
    log(state, { kind: 'action', player: T.player, text: `${op.letter}: Tanked Up (+1 APL)` });
  };
  reg.on('onCollectAttackDice', T.bind(RULE_TANKED_UP, 12), (ev) => {
    const seq = ev.state.sequence;
    if (!seq) return;
    // Only the operative PERFORMING the action: a retaliating operative is not performing one.
    if (seq.kind === 'fight' && seq.attackerId !== ev.ctx.attacker.id) return;
    if (seq.kind === 'shoot' && seq.attackerId !== ev.ctx.attacker.id) return;
    if (ev.ctx.attacker.player !== T.player) return;
    armTankedUp(ev.state, ev.ctx.attacker);
  });
  // A Charge has no hook of its own that only fires on the real move (`onMoveDistance` is emitted
  // from `validateMove`, which every `check` and the AI's move planner also run), so it is read
  // live off `actionsThisActivation` — which the reducer pushes as soon as the move resolves — and
  // converted into the effect at the end of the activation so it survives the Ready step's reset.
  reg.on('onActivationEnd', T.bind(RULE_TANKED_UP, 13), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (ev.operative.actionsThisActivation.includes('Charge')) armTankedUp(ev.state, ev.operative);
  });
  reg.on('onStatMod', T.bind(RULE_TANKED_UP, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    if (op.order !== 'engage' || !isBoy(T, op)) return;
    if (op.actionsThisActivation.includes('Charge') || effectOn(ev.state, op.id, TANKED_EFFECT)) ev.mods.apl += 1;
  });
  reg.on('onActivationStart', T.bind(RULE_TANKED_UP, 11), (ev) => {
    if (ev.operative.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === TANKED_EFFECT && e.operativeId === ev.operative.id);
  });

  bossNob(reg, T);
  bombSquig(reg, T);
  demolisha(reg, T);
  krusha(reg, T);
  tankbustas(reg, T);
}

// ---------------------------------------------------------------------------
// WRECKA BOSS NOB
// ---------------------------------------------------------------------------

function bossNob(reg: HookRegistry, T: TeamHooks): void {
  // "Whenever this operative performs the Shoot or Fight action (excluding Guard), you gain 1
  //  Wrecka point." — the dice-collection moment again: Guard rolls none, and a Blast/Salvo
  //  secondary is the same action, so only the first pool of the action pays out.
  reg.on('onCollectAttackDice', T.bind(AB_WRECKA_BOSS, 12), (ev) => {
    const attacker = ev.ctx.attacker;
    if (attacker.datacardId !== BOSS_NOB || attacker.player !== T.player) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    if (seq.kind === 'shoot') {
      if (seq.attackerId !== attacker.id || seq.secondary || seq.resolvedTargets.length > 0) return;
    } else {
      if (seq.attackerId !== attacker.id || seq.attackerPool.dice.length > 0) return;
    }
    gainWreckaPoints(ev.state, T.player, 1, `${attacker.letter}: Wrecka Boss`);
  });

  /*
   * Salvo (rare weapon rule, as THIS team prints it): "Select up to two different valid targets
   * that aren't within control range of friendly operatives. Shoot with this weapon against both
   * primary targets in an order of your choice, then against all remaining secondary targets in
   * the same manner (roll each sequence separately). Each target (primary and secondary) cannot
   * be shot more than once during the action."
   *
   * The second primary is queued in FRONT of the Blast secondaries the engine already found, and
   * the second primary's OWN Blast secondaries are appended behind them, deduplicated — which is
   * exactly the printed order. The second target is the player's choice; the lowest-id valid one
   * is the deterministic default (D-016), the Sanctifiers' Twin Torrent precedent.
   */
  reg.on('onCollectAttackDice', T.bind(AB_SALVO, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Salvo')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.secondary || seq.resolvedTargets.length > 0) return;
    const attacker = ev.ctx.attacker;
    const already = new Set([seq.targetId, ...seq.queue]);
    const second = validTargets(T.ctx, ev.state, attacker, seq.weaponName, seq.profileName)
      .map((r) => r.target)
      .filter((o) => o.id !== seq.targetId)
      // "…that aren't within control range of friendly operatives"
      .filter(
        (o) =>
          !aliveOperatives(ev.state, T.player).some(
            (f) => f.id !== attacker.id && inControlRange(T.ctx!, ev.state, f, o),
          ),
      )
      .sort(byId)[0];
    if (!second) return;
    const extras = aliveOperatives(ev.state).filter(
      (o) =>
        o.id !== second.id &&
        o.id !== attacker.id &&
        !already.has(o.id) &&
        blastRadius(ev.ctx.rules) > 0 &&
        T.gap(second, o) <= blastRadius(ev.ctx.rules) + EPS &&
        isVisible(terrain(T.ctx!, ev.state), body(T.ctx!, second), body(T.ctx!, o)).visible,
    );
    seq.queue = [second.id, ...seq.queue, ...extras.map((o) => o.id).filter((id) => !already.has(id))];
    bucket(ev.state, 'wrecka-krew.salvo')[T.player] = second.id;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Salvo: ${attacker.letter} also shoots ${second.letter}`,
    });
  });
  // A Salvo second primary is a valid target in its own right, not a Blast secondary, so its
  // cover and obscured are re-determined before its dice are rolled ("roll each sequence
  // separately").
  reg.on('onCollectAttackDice', T.bind(AB_SALVO, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Salvo')) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.secondary) return;
    if (bucket(ev.state, 'wrecka-krew.salvo')[T.player] !== seq.targetId) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target) return;
    const check = checkTarget(T.ctx, ev.state, ev.ctx.attacker, target, ev.ctx.profile, ev.ctx.rules);
    // A tie between cover and obscured defaults to obscured (D-012).
    seq.obscured = check.obscured;
    seq.inCover = check.inCover && !(check.mustChoose && check.obscured);
  });
}

const blastRadius = (rules: { id: string; x?: number }[]): number =>
  rules.find((r) => r.id === 'Blast')?.x ?? 0;

// ---------------------------------------------------------------------------
// WRECKA BOMB SQUIG
// ---------------------------------------------------------------------------

function bombSquig(reg: HookRegistry, T: TeamHooks): void {
  // ---- Stoopid -----------------------------------------------------------
  // "This operative cannot perform any actions other than Charge, Dash, Fight, Reposition and Shoot."
  reg.on('canPerformAction', T.bind(AB_STOOPID, 12), (ev) => {
    if (ev.operative.datacardId !== BOMB_SQUIG || ev.operative.player !== T.player) return;
    const allowed = ['Charge', 'Dash', 'Fight', 'Reposition', 'Shoot', EXPLOSIVE_SHOOT];
    if (!allowed.includes(ev.action)) {
      ev.allowed = false;
      ev.reason = 'a BOMB SQUIG cannot perform that action';
    }
  });
  // "In the Firefight phase, whenever you determine this operative's order, you cannot select
  //  Conceal." — `onOrderChange` is declared but never emitted, so the order is corrected at the
  //  start of the activation instead (the Kommandos GROT precedent).
  reg.on('onActivationStart', T.bind(AB_STOOPID, 13), (ev) => {
    if (ev.operative.datacardId !== BOMB_SQUIG || ev.operative.player !== T.player) return;
    if (ev.operative.order === 'conceal') {
      ev.operative.order = 'engage';
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `${ev.operative.letter} cannot select Conceal (Stoopid)`,
      });
    }
  });

  // ---- Explosive (rare weapon rule) --------------------------------------
  // "Don't select a valid target. Instead, this operative is always the primary target and cannot
  //  be in cover or obscured." The shot goes down the engine's point-blank path (the only way it
  //  lets an operative shoot while engaged); the point-blank Hit penalty is cancelled here,
  //  because Explosive does not print one.
  reg.on('onStatMod', T.bind(AB_EXPLOSIVE, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id || !seq.pointBlank) return;
    if (!explosiveWeaponName(T, ev.operative, seq.weaponName)) return;
    ev.mods.hit += 1;
  });
  // The universal Shoot action must never fire the explosives at somebody else: the printed rule
  // says the bearer is always the primary target. `onSelectWeapon` is emitted from the Shoot
  // action's own `check` as well (D-032), so the AI sees the refusal before it commits an intent.
  reg.on('onSelectWeapon', T.bind(AB_EXPLOSIVE, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Explosive')) return;
    if (ev.ctx.defender && ev.ctx.defender.id !== ev.ctx.attacker.id) {
      ev.allowed = false;
      ev.reason = 'Explosive: this operative is always the primary target';
    }
  });

  // ---- Boom! -------------------------------------------------------------
  /*
   * "If this operative is incapacitated during a battle in which it hasn't used its explosives,
   *  roll one D6, or two D6 if you wish. If any result is a 4+, this operative performs a free
   *  Shoot action with its explosives before it's removed from the killzone."
   *
   * The free Shoot happens inside `inflictDamage`, i.e. inside another in-flight sequence, and
   * `state.sequence` is single-slot — so it resolves as direct Blast damage instead (D-024, the
   * Kommandos Boom! precedent; `onIncapacitated.freeActions` is declared but never consumed).
   * Two D6 are always rolled because the second costs nothing (D-022).
   */
  reg.on('onIncapacitated', T.bind(AB_BOOM, 13), (ev) => {
    const squig = ev.operative;
    if (squig.datacardId !== BOMB_SQUIG || squig.player !== T.player || ev.prevented) return;
    if (!T.ctx) return;
    const weapon = T.card(squig)?.weapons.find((w) => w.name === 'Explosives');
    const profile = weapon?.profiles[0];
    if (!weapon || !profile) return;
    if ((squig.weaponUses[weapon.name] ?? 0) > 0) return; // "hasn't used its explosives"
    if (!useOncePerBattle(ev.state, `wrecka-krew.boom:${squig.id}`)) return;
    const rolls = [T.ctx.rng.d6(), T.ctx.rng.d6()];
    recordRoll(ev.state, 'boom', rolls, T.player, 'Boom! 4+');
    if (!rolls.some((r) => r >= 4)) return;
    const radius = blastRadius(profile.rules);
    for (const other of aliveOperatives(ev.state)) {
      if (other.id === squig.id) continue;
      if (T.gap(squig, other) > radius + EPS) continue;
      inflictDamage(T.ctx, ev.state, other, profile.dmgN, 'other');
    }
    log(ev.state, { kind: 'action', player: T.player, text: `${squig.letter}: Boom! (${rolls.join(', ')})` });
  });

  // Expendable is op scoring (src/core/ops/**) — reminder-only, see REMINDER_ONLY.
}

function explosiveWeaponName(T: TeamHooks, op: OperativeState, name?: string): string | undefined {
  const weapon = (T.card(op)?.weapons ?? []).find(
    (w) => (name === undefined || w.name === name) && w.profiles.some((p) => p.rules.some((r) => r.id === 'Explosive')),
  );
  return weapon?.name;
}

// ---------------------------------------------------------------------------
// BREAKA BOY DEMOLISHA
// ---------------------------------------------------------------------------

const UNSTOPPABLE = 'wrecka-krew.detonateDamage';

function demolisha(reg: HookRegistry, T: TeamHooks): void {
  // ---- Reckless Temperament ----------------------------------------------
  /*
   * "Normal Dmg of 4 or more inflicts 1 less damage on this operative; if this operative has an
   *  Engage order, Critical Dmg of 4 or more also inflicts 1 less damage on this operative."
   *
   * `onDamage` always carries `ctx: null`, so the striking profile is re-derived from the
   * in-flight sequence (the Death Korps Bruiser / Hearthkyn Weavefield read). A fight inflicts one
   * attack dice at a time; a shoot aggregates every unblocked dice into one call, so the reduction
   * is counted per unblocked dice off the resolved pool.
   */
  reg.on('onDamage', T.bind(AB_RECKLESS, 12), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    const victim = ev.target;
    if (victim.datacardId !== DEMOLISHA || victim.player !== T.player) return;
    const incoming = incomingProfile(T, ev.state, victim);
    if (!incoming) return;
    const { profile, melee } = incoming;
    const engage = victim.order === 'engage';
    let reduction = 0;
    if (melee) {
      if (ev.amount === profile.dmgN && profile.dmgN >= 4) reduction = 1;
      else if (ev.amount === profile.dmgC && profile.dmgC >= 4 && engage) reduction = 1;
    } else {
      const seq = shootSeq(ev.state)!;
      const normals = seq.attack.dice.filter((d) => d.state === 'normal').length;
      const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
      reduction = (profile.dmgN >= 4 ? normals : 0) + (engage && profile.dmgC >= 4 ? crits : 0);
    }
    if (reduction <= 0) return;
    const before = ev.amount;
    ev.amount = Math.max(0, ev.amount - reduction);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Reckless Temperament: ${victim.letter} takes ${ev.amount} instead of ${before}`,
    });
  });

  // ---- Detonate (rare weapon rule, as THIS team prints it) ---------------
  /*
   * "The first time you would inflict damage on an enemy operative with this weapon profile
   *  during the battle, inflict D6+6 damage on that enemy operative and each other operative
   *  within its control range if it's a normal success, or 2D6+6 damage if it's a critical
   *  success (roll separately for each). Then the action ends and you gain 1 Wrecka point, plus 1
   *  for each operative that was incapacitated during that action. Damage from this weapon rule
   *  cannot be ignored or reduced."
   *
   * NOTE this is NOT the registry's Detonate (a remote detonator fired at a Mine marker): the
   * Wrecka Krew's Detonate is a MELEE profile whose Dmg is printed `*`, recorded as 0/0 in the
   * JSON, and resolved entirely by this rule — so `onStrikeResolved`, which fires immediately
   * after the strike's own (zero) damage and carries both the striking profile and whether the
   * die was a critical success, is the exact printed moment.
   */
  reg.on('onStrikeResolved', T.bind(AB_DETONATE, 12), (ev) => {
    if (!T.ctx) return;
    const striker = ev.ctx.attacker;
    if (striker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Detonate')) return;
    // "The first time … during the battle" (the profile is also Limited 1).
    if (!useOncePerBattle(ev.state, `wrecka-krew.detonate:${striker.id}`)) return;
    const seq = fightSeq(ev.state);
    const already =
      (bucket(ev.state, 'wrecka-krew.detonateBefore')[striker.id] as string[] | undefined) ??
      Object.values(ev.state.operatives)
        .filter((o) => o.incapacitated || o.removed)
        .map((o) => o.id);
    const victims = [
      ev.struck,
      ...aliveOperatives(ev.state).filter((o) => o.id !== ev.struck.id && inControlRange(T.ctx!, ev.state, o, ev.struck)),
    ];
    const dice = ev.crit ? 2 : 1;
    for (const victim of victims) {
      const rolls = [...Array(dice)].map(() => T.ctx!.rng.d6());
      recordRoll(ev.state, 'detonate', rolls, T.player, `Detonate ${dice}D6+6 vs ${victim.letter}`);
      const amount = rolls.reduce((a, b) => a + b, 0) + 6;
      // "Damage from this weapon rule cannot be ignored or reduced" — see the restore below.
      bucket(ev.state, UNSTOPPABLE)[victim.id] = { amount, player: T.player };
      inflictDamage(T.ctx, ev.state, victim, amount, 'other');
      delete bucket(ev.state, UNSTOPPABLE)[victim.id];
    }
    // "…you gain 1 Wrecka point, plus 1 for each operative that was incapacitated during that action."
    const killed = Object.values(ev.state.operatives).filter(
      (o) => (o.incapacitated || o.removed) && !already.includes(o.id),
    ).length;
    gainWreckaPoints(ev.state, T.player, 1 + killed, `${striker.letter}: Detonate (${killed} incapacitated)`);
    // "Then the action ends."
    if (seq) seq.step = 'done';
    log(ev.state, { kind: 'action', player: T.player, text: `${striker.letter}: Detonate — the action ends` });
  });
  // The snapshot of who was ALREADY down when the Detonate action began ("incapacitated during
  // that action"), taken as the fight's attack dice are collected.
  reg.on('onCollectAttackDice', T.bind(AB_DETONATE, 11), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Detonate')) return;
    bucket(ev.state, 'wrecka-krew.detonateBefore')[ev.ctx.attacker.id] = Object.values(ev.state.operatives)
      .filter((o) => o.incapacitated || o.removed)
      .map((o) => o.id);
  });
  /*
   * "Damage from this weapon rule cannot be ignored or reduced." Bound at priority 99 so it is the
   * LAST `onDamage` handler to run: every rule that would have reduced or zeroed the amount — this
   * team's own Reckless Temperament and JUST A SCRATCH included, and the opponent's too — has
   * already had its turn, and the printed amount is restored over the top of it.
   */
  reg.on('onDamage', T.bind(AB_DETONATE, 99), (ev) => {
    const forced = bucket(ev.state, UNSTOPPABLE)[ev.target.id] as
      | { amount: number; player: PlayerId }
      | undefined;
    if (!forced || forced.player !== T.player) return;
    if (ev.amount === forced.amount) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Detonate damage cannot be ignored or reduced: ${forced.amount} stands (was reduced to ${ev.amount})`,
    });
    ev.amount = forced.amount;
  });
}

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

// ---------------------------------------------------------------------------
// BREAKA BOY KRUSHA
// ---------------------------------------------------------------------------

function krusha(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Armoured Up: "Whenever an enemy operative is shooting this operative, or this operative is
   * fighting or retaliating, your opponent cannot retain attack dice results of less than 6 as
   * critical successes (e.g. as a result of the Lethal, Rending or Severe weapon rules)."
   *
   * Stripping Lethal / Rending / Severe from the enemy's weapon covers every printed route to a
   * sub-6 critical success: Lethal is read by `addRolled` at the roll itself, and Rending and
   * Severe are retention options built from these same rules one line later. `onWeaponRules` is
   * emitted by BOTH sequences with the FOE as `target`, so the shooting half and the
   * fighting/retaliating half are equally live (the Exodite SPECTRAL NIMBUS precedent — the same
   * outcome, declared before the roll rather than after it).
   */
  reg.on('onWeaponRules', T.bind(AB_ARMOURED_UP, 15), (ev) => {
    const foe = ev.target;
    if (!foe || foe.datacardId !== KRUSHA || foe.player !== T.player) return;
    if (ev.operative.player === T.player) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Lethal' && r.id !== 'Rending' && r.id !== 'Severe');
  });

  /*
   * Smash (rare weapon rule): "Whenever you strike, you can move the enemy operative in a straight
   * line increment of up to 1". If you do, it must end the move further away from this operative
   * and in a location it can be placed. Then move this operative in a straight line increment of
   * up to 1", but it must end that move within that enemy operative's control range (if either
   * isn't possible, you cannot move them)."
   *
   * Free and reversible in effect (the KRUSHA follows the enemy and stays engaged), so it is
   * auto-used on a stated deterministic policy under D-022: push directly away along the line
   * between the two bases, taking the longest legal increment of 1", 0.75", 0.5" or 0.25", then
   * follow by the same amount. If either half has no legal spot, neither operative moves.
   */
  reg.on('onStrikeResolved', T.bind(AB_SMASH, 12), (ev) => {
    if (!T.ctx) return;
    const striker = ev.ctx.attacker;
    if (striker.datacardId !== KRUSHA || striker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Smash')) return;
    const foe = ev.struck;
    if (foe.incapacitated || foe.removed || striker.incapacitated) return;
    const plan = planSmash(T.ctx, ev.state, striker, foe);
    if (!plan) return;
    foe.pos = plan.foePos;
    settleZ(T.ctx, ev.state, foe);
    striker.pos = plan.selfPos;
    settleZ(T.ctx, ev.state, striker);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Smash: ${striker.letter} shoves ${foe.letter} ${plan.inches.toFixed(2)}" and follows up`,
    });
  });
}

const SMASH_STEPS = [1, 0.75, 0.5, 0.25];

function planSmash(
  ctx: GameContext,
  state: GameState,
  striker: OperativeState,
  foe: OperativeState,
): { foePos: Vec2; selfPos: Vec2; inches: number } | undefined {
  const dx = foe.pos.x - striker.pos.x;
  const dy = foe.pos.y - striker.pos.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return undefined;
  const ux = dx / length;
  const uy = dy / length;
  for (const step of SMASH_STEPS) {
    const foePos = { x: foe.pos.x + ux * step, y: foe.pos.y + uy * step };
    if (!placeable(ctx, state, foe, foePos).ok) continue;
    const selfPos = { x: striker.pos.x + ux * step, y: striker.pos.y + uy * step };
    if (!placeable(ctx, state, striker, selfPos, [foe.id]).ok) continue;
    // "…but it must end that move within that enemy operative's control range"
    const moved = { ...striker, pos: selfPos };
    const shoved = { ...foe, pos: foePos };
    if (!inControlRange(ctx, state, moved, shoved)) continue;
    return { foePos, selfPos, inches: step };
  }
  return undefined;
}

/** "…in a location it can be placed" (the Hearthkyn KNUX SMASH test). */
function placeable(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
  ignoreIds: string[] = [],
): { ok: boolean; reason?: string; z?: number } {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const r = baseRadius(card.base);
  const board = state.map.board;
  if (pos.x < r || pos.y < r || pos.x > board.w - r || pos.y > board.h - r)
    return { ok: false, reason: 'it must be in a location it can be placed' };
  if (baseTouchesHazardous(index, pos, card.base, op.rot))
    return { ok: false, reason: 'a base cannot touch a hazardous area' };
  const z = surfaceAt(index, pos);
  if (baseBlockedByTerrain(index, pos, card.base, op.rot, z, modelHeight(card)))
    return { ok: false, reason: 'it must be in a location it can be placed' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id || ignoreIds.includes(other.id)) continue;
    const oc = ctx.datacards.get(other.datacardId);
    if (!oc) continue;
    if (basesOverlap(pos, card.base, op.rot, other.pos, oc.base, other.rot))
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true, z };
}

// ---------------------------------------------------------------------------
// TANKBUSTA GUNNER + ROKKITEER
// ---------------------------------------------------------------------------

function tankbustas(reg: HookRegistry, T: TeamHooks): void {
  /*
   * Kompetitive Streak: "Once per Shoot action, if this operative shoots an enemy operative that
   * another friendly operative has already shot during this turning point, you gain 1 Wrecka
   * point. Determine this when you select a valid target, but you can include any secondary
   * targets when doing so (e.g. from the Blast weapon rule)."
   */
  reg.on('onCollectAttackDice', T.bind(AB_KOMPETITIVE, 14), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    const ledger = shotLedger(ev.state, T.player);
    if (ev.ctx.attacker.datacardId === GUNNER && !seq.secondary && seq.resolvedTargets.length === 0) {
      const candidates = [seq.targetId, ...seq.queue];
      const paid = candidates.some((id) => (ledger[id] ?? []).some((who) => who !== ev.ctx.attacker.id));
      if (paid) gainWreckaPoints(ev.state, T.player, 1, `${ev.ctx.attacker.letter}: Kompetitive Streak`);
    }
    // The per-turning-point ledger every Kompetitive Streak read consults.
    const current = ledger[seq.targetId] ?? [];
    if (!current.includes(ev.ctx.attacker.id)) ledger[seq.targetId] = [...current, ev.ctx.attacker.id];
  });

  /*
   * Shokkwave: "Whenever an operative is within x" of your Pulsa marker (see left), subtract 2"
   * from its Move stat and worsen the Hit stat of its weapons by 1. This is cumulative with being
   * injured. X is that marker's Pulsa points. In the Ready step of each Strategy phase, subtract 1
   * from your Pulsa marker's points. If a Pulsa marker ever has 0 points, remove it."
   *
   * It applies to ANY operative in the ring — friendly ones included. `moveOf` and `hitOf` apply
   * the injured penalties separately, so "cumulative with being injured" needs no extra work.
   */
  reg.on('onStatMod', T.bind(AB_SHOKKWAVE, 14), (ev) => {
    const marker = pulsaMarker(ev.state, T.player);
    if (!marker) return;
    const points = pulsaPoints(marker);
    if (points <= 0) return;
    if (T.markerGap(ev.operative, marker) > points + EPS) return;
    ev.mods.move -= 2;
    ev.mods.hit -= 1; // positive improves, so a worsened Hit stat is negative
  });
  reg.on('onReadyStep', T.bind(AB_SHOKKWAVE, 12), (ev) => {
    if (ev.player !== T.player) return;
    const marker = pulsaMarker(ev.state, T.player);
    if (!marker) return;
    const points = pulsaPoints(marker) - 1;
    marker.flags['pulsaPoints'] = points;
    if (points <= 0) {
      removeMarker(ev.state, marker.id);
      log(ev.state, { kind: 'action', player: T.player, text: 'The Pulsa marker reaches 0 points and is removed' });
    } else {
      log(ev.state, { kind: 'action', player: T.player, text: `Pulsa marker: ${points} Pulsa point(s)` });
    }
  });

  // The Pulsa rokkit is never fired through the universal Shoot action: "Don't select a valid
  // target" (the Death Korps remote-detonator precedent). It has its own action below.
  reg.on('onSelectWeapon', T.bind(AB_PULSA, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Pulsa')) return;
    ev.allowed = false;
    ev.reason = 'Pulsa: don’t select a valid target — use the Pulsa Rokkit action';
  });
}

function shotLedger(state: GameState, player: PlayerId): Record<string, string[]> {
  const b = bucket(state, 'wrecka-krew.shotThisTP');
  const stamp = `${state.turningPoint}`;
  if (b['tp'] !== stamp) {
    b['tp'] = stamp;
    b['by'] = {};
  }
  return b['by'] as Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

const KABOOM_EFFECT = 'wrecka-krew.kaboom';
const DRILL_EFFECT = 'wrecka-krew.drillRokkits';
const PROPPA_EFFECT = 'wrecka-krew.proppaScrap';

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- WAAAGH! (strategy) ------------------------------------------------
  // "Friendly WRECKA KREW operatives' melee weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(SP_WAAAGH, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_WAAAGH)) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Waaagh!)'));
  });

  // ---- DESTRUCTION (strategy) --------------------------------------------
  // "Friendly WRECKA KREW operatives' ranged weapons have the Saturate weapon rule."
  reg.on('onWeaponRules', T.bind(SP_DESTRUCTION, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_DESTRUCTION)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Destruction)'));
  });

  // ---- TUFF GITZ (strategy) ----------------------------------------------
  // "Whenever an operative is shooting a friendly WRECKA KREW operative that has an Engage order,
  //  you can re-roll one of your defence dice."
  reg.on('onDefenceDice', T.bind(SP_TUFF_GITZ, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP_TUFF_GITZ)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || target.order !== 'engage') return;
    const grant: RerollGrant = {
      id: 'wrecka-krew.tuffGitz',
      label: 'Tuff Gitz: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(ruleText(SP_TUFF_GITZ)),
    };
    ev.rerolls.push(grant);
  });

  // ---- AMPED UP (strategy) -----------------------------------------------
  // "Each friendly WRECKA KREW operative that has an Engage order can immediately regain up to
  //  D3+1 lost wounds (roll separately for each)."
  reg.on('onPloyUsed', T.bind(SP_AMPED_UP, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP_AMPED_UP || !T.ctx) return;
    for (const op of T.friendlies(ev.state, KW).sort(byId)) {
      if (op.order !== 'engage') continue;
      const lost = startingWounds(T.ctx, op) - op.wounds;
      if (lost <= 0) continue;
      const d3 = T.ctx.rng.d3();
      recordRoll(ev.state, 'ampedUp', [d3], T.player, `Amped Up D3+1 for ${op.letter}`);
      const healed = Math.min(d3 + 1, lost);
      op.wounds += healed;
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `Amped Up: ${op.letter} regains ${healed} lost wounds (${op.wounds})`,
      });
    }
  });

  // ---- JUST A SCRATCH (firefight) ----------------------------------------
  /*
   * "Use this firefight ploy when an attack dice inflicts Normal Dmg on a friendly WRECKA KREW
   *  operative (excluding BOMB SQUIG). Ignore that inflicted damage."
   *
   * One attack dice's worth of Normal Dmg is ignored: in a fight that IS the whole call, in a
   * shoot the call aggregates every unblocked dice, so only the profile's Normal Dmg comes off.
   */
  reg.on('onDamage', T.bind(FP_JUST_A_SCRATCH, 20), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (!ployUsed(ev.state, T.player, FP_JUST_A_SCRATCH)) return;
    if (!isBoy(T, ev.target)) return;
    const incoming = incomingProfile(T, ev.state, ev.target);
    if (!incoming) return;
    const slice = normalDamageSlice(ev.state, incoming, ev.amount);
    if (slice <= 0) return;
    if (!useOncePerTP(ev.state, `wrecka-krew.justAScratch:${T.player}`)) return;
    ev.amount = Math.max(0, ev.amount - slice);
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Just a Scratch: ${ev.target.letter} ignores ${slice} damage`,
    });
  });

  // ---- PROPPA SCRAP (firefight) ------------------------------------------
  // "Use this firefight ploy during a friendly BREAKA BOY or BOSS NOB operative's activation.
  //  During that activation, that operative can perform two FIGHT actions."
  reg.on('onPloyUsed', T.bind(FP_PROPPA_SCRAP, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_PROPPA_SCRAP) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const eligible = T.friendlies(ev.state, KW).filter((o) => T.kw(o, 'BREAKA BOY') || T.kw(o, 'BOSS NOB'));
    const op = active && eligible.some((o) => o.id === active.id) ? active : chosenOperative(ev.state, ev.data, eligible);
    if (!op) return;
    effect(ev.state, {
      rule: PROPPA_EFFECT,
      source: { kind: 'ploy', id: FP_PROPPA_SCRAP },
      sourceText: shortQuote(ruleText(FP_PROPPA_SCRAP)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Proppa Scrap: ${op.letter} can Fight twice` });
  });

  // ---- DEMOLITION JOB (firefight) ----------------------------------------
  /*
   * "Use this firefight ploy after a friendly WRECKA KREW operative performs the Shoot or Fight
   *  action, just before incapacitated operatives are removed (if any). Place one of your
   *  Demolition markers within the target's control range (if it's using a Blast weapon, the
   *  primary target)."
   *
   * Nothing runs at that point in `PerformAction`, so the primary target of the last Shoot/Fight
   * action of this activation is recorded as it happens and the marker is placed on it here.
   */
  reg.on('onCollectAttackDice', T.bind(FP_DEMOLITION_JOB, 15), (ev) => {
    if (ev.ctx.attacker.player !== T.player || !T.mineKw(ev.ctx.attacker, KW)) return;
    const seq = ev.state.sequence;
    if (!seq || seq.attackerId !== ev.ctx.attacker.id) return;
    if (seq.kind === 'shoot' && (seq.secondary || seq.resolvedTargets.length > 0)) return;
    const targetId = seq.kind === 'shoot' ? seq.targetId : seq.defenderId;
    bucket(ev.state, 'wrecka-krew.lastAttack')[T.player] = {
      targetId,
      stamp: attackStamp(ev.state),
    };
  });
  reg.on('onPloyUsed', T.bind(FP_DEMOLITION_JOB, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_DEMOLITION_JOB) return;
    const target = lastAttackTarget(ev.state, T.player);
    if (!target) return;
    removeMarker(ev.state, DEMOLITION_MARKER(T.player));
    placeTeamMarker(ev.state, {
      id: DEMOLITION_MARKER(T.player),
      kind: 'generic',
      player: T.player,
      pos: { ...target.pos },
      z: target.z,
      flags: { demolition: true, placedTP: ev.state.turningPoint },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Demolition Job: marker placed on ${target.letter}`,
    });
  });
  // "In the Ready step of the next Strategy phase, remove that marker."
  reg.on('onReadyStep', T.bind(FP_DEMOLITION_JOB, 13), (ev) => {
    if (ev.player !== T.player) return;
    const marker = ev.state.markers[DEMOLITION_MARKER(T.player)];
    if (!marker) return;
    if (Number(marker.flags['placedTP'] ?? 0) >= ev.state.turningPoint) return;
    removeMarker(ev.state, marker.id);
    log(ev.state, { kind: 'action', player: T.player, text: 'The Demolition marker is removed' });
  });

  // ---- KABOOM! (firefight) -----------------------------------------------
  /*
   * "Use this firefight ploy when a friendly WRECKA KREW operative performs the Shoot action and a
   *  weapon with the Blast weapon rule is selected. Until the end of that action, add 1" to that
   *  weapon's Blast and it has the Severe weapon rule when shooting the primary target. You cannot
   *  use this ploy and the Drill Rokkits rule during the same action. Note that Severe doesn't
   *  generate a Wrecka point (as it's not a 6)."
   *
   * The engine has no window inside the Select Weapon step, so the ploy is used immediately
   * before the Shoot action and armed on the active operative; the operative can only Shoot once
   * per activation, so "until the end of that action" and "until the end of that activation"
   * coincide (the Blades of Khaine bound). Severe never pays a Wrecka point because the gain
   * counts dice whose VALUE is 6, which no retention transform changes.
   */
  reg.on('onPloyUsed', T.bind(FP_KABOOM, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP_KABOOM) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = active && T.mineKw(active, KW) ? active : chosenOperative(ev.state, ev.data, T.friendlies(ev.state, KW));
    if (!op) return;
    effect(ev.state, {
      rule: KABOOM_EFFECT,
      source: { kind: 'ploy', id: FP_KABOOM },
      sourceText: shortQuote(ruleText(FP_KABOOM)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Kaboom!: ${op.letter}'s Blast weapon` });
  });
  reg.on('onWeaponRules', T.bind(FP_KABOOM, 21), (ev) => {
    if (!effectOn(ev.state, ev.operative.id, KABOOM_EFFECT)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    const blast = ev.rules.find((r) => r.id === 'Blast');
    if (!blast) return;
    ev.rules = ev.rules.map((r) =>
      r.id === 'Blast' ? ruleTag('Blast', (r.x ?? 0) + 1, `Blast ${(r.x ?? 0) + 1}" (Kaboom!)`) : r,
    );
    // "…it has the Severe weapon rule when shooting the primary target"
    const seq = shootSeq(ev.state);
    if (seq && seq.secondary) return;
    if (!ev.rules.some((r) => r.id === 'Severe')) ev.rules.push(ruleTag('Severe', undefined, 'Severe (Kaboom!)'));
  });
}

/** A fingerprint for "this activation's last Shoot/Fight action". */
const attackStamp = (state: GameState): string =>
  `${state.turningPoint}:${state.activationsThisTP}:${state.activeOperativeId ?? ''}`;

function lastAttackTarget(state: GameState, player: PlayerId): OperativeState | undefined {
  const rec = bucket(state, 'wrecka-krew.lastAttack')[player] as { targetId: string; stamp: string } | undefined;
  if (!rec || rec.stamp !== attackStamp(state)) return undefined;
  const target = state.operatives[rec.targetId];
  return target && !target.removed ? target : undefined;
}

function normalDamageSlice(
  state: GameState,
  incoming: { profile: WeaponProfile; melee: boolean },
  amount: number,
): number {
  const dmgN = incoming.profile.dmgN;
  if (dmgN <= 0) return 0;
  // A fight resolves one attack dice at a time, so the amount IS that dice's damage.
  if (incoming.melee) return amount === dmgN ? dmgN : 0;
  const seq = shootSeq(state);
  if (!seq || !seq.attack.dice.some((d) => d.state === 'normal')) return 0;
  return Math.min(dmgN, amount);
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- DRILL ROKKITS -----------------------------------------------------
  /*
   * "Once per turning point, when a friendly WRECKA KREW operative is performing the Shoot action
   *  and you select a rokkit launcha or 'eavy rokkit launcha, you can use this rule. If you do,
   *  until the end of that action, that weapon loses the Blast weapon rule but has the Piercing 1
   *  weapon rule."
   *
   * The choice is made in the Select Weapon step, which `onSelectWeapon` is exactly (D-032) — and
   * because `startShoot` emits it BEFORE it computes the Blast secondary queue, dropping Blast
   * there really does drop the secondaries. Auto-used under D-022 on a stated policy: take it only
   * when the Blast footprint around the intended target holds no OTHER operative, so nothing is
   * given up, and never while KABOOM! is armed ("you cannot use this ploy and the Drill Rokkits
   * rule during the same action"). A dry run never claims the allowance.
   */
  reg.on('onSelectWeapon', T.bind(EQ_DRILL_ROKKITS, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a query — it must not mutate (D-032)
    if (!hasEquipment(ev.state, T.player, EQ_DRILL_ROKKITS)) return;
    const shooter = ev.ctx.attacker;
    if (!T.mineKw(shooter, KW) || !isDrillRokkit(ev.ctx.weaponName)) return;
    if (effectOn(ev.state, shooter.id, KABOOM_EFFECT)) return;
    if (usedThisTP(ev.state, `wrecka-krew.drillRokkits:${T.player}`)) return;
    const radius = blastRadius(ev.ctx.rules);
    const target = ev.ctx.defender;
    if (radius > 0 && target && T.ctx) {
      const caught = aliveOperatives(ev.state).some(
        (o) => o.id !== target.id && o.id !== shooter.id && T.gap(target, o) <= radius + EPS,
      );
      if (caught) return; // the Blast is worth more than Piercing 1 here
    }
    useOncePerTP(ev.state, `wrecka-krew.drillRokkits:${T.player}`);
    effect(ev.state, {
      rule: DRILL_EFFECT,
      source: { kind: 'equipment', id: EQ_DRILL_ROKKITS },
      sourceText: shortQuote(ruleText(EQ_DRILL_ROKKITS)),
      operativeId: shooter.id,
      player: T.player,
      data: { weaponName: ev.ctx.weaponName },
      expiry: { kind: 'endOfActivation', operativeId: shooter.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Drill Rokkits: ${shooter.letter}'s ${ev.ctx.weaponName} loses Blast and gains Piercing 1`,
    });
  });
  reg.on('onWeaponRules', T.bind(EQ_DRILL_ROKKITS, 31), (ev) => {
    if (ev.operative.player !== T.player) return; // both players register this module
    const eff = effectOn(ev.state, ev.operative.id, DRILL_EFFECT);
    if (!eff || eff.data?.['weaponName'] !== ev.weaponName) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Blast');
    if (!ev.rules.some((r) => r.id === 'Piercing'))
      ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (Drill Rokkits)'));
  });

  // ---- ENGINE OIL --------------------------------------------------------
  /*
   * "Once per turning point, when a friendly WRECKA KREW operative (excluding BOMB SQUIG) is
   *  activated, you can use this rule. If you do, until the end of that activation, you can ignore
   *  any changes to that operative's stats from being injured (including its weapons' stats)."
   *
   * `moveOf` applies -2" and `hitOf` +1 for an injured operative, so ignoring them is exactly
   * cancelling those two. Free, so auto-used under D-022 on the first injured operative activated
   * in the turning point — the only activation where it can do anything at all.
   */
  reg.on('onActivationStart', T.bind(EQ_ENGINE_OIL, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_ENGINE_OIL)) return;
    if (!isBoy(T, ev.operative) || !T.ctx) return;
    if (!isInjured(T.ctx, ev.operative)) return;
    if (!useOncePerTP(ev.state, `wrecka-krew.engineOil:${T.player}`)) return;
    effect(ev.state, {
      rule: 'wrecka-krew.engineOil',
      source: { kind: 'equipment', id: EQ_ENGINE_OIL },
      sourceText: shortQuote(ruleText(EQ_ENGINE_OIL)),
      operativeId: ev.operative.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Engine Oil: ${ev.operative.letter} ignores its injured stat changes`,
    });
  });
  reg.on('onStatMod', T.bind(EQ_ENGINE_OIL, 31), (ev) => {
    if (ev.operative.player !== T.player) return; // both players register this module
    if (!effectOn(ev.state, ev.operative.id, 'wrecka-krew.engineOil') || !T.ctx) return;
    if (!isInjured(T.ctx, ev.operative)) return;
    ev.mods.move += 2; // "Subtract 2" from the Move stat of injured operatives"
    ev.mods.hit += 1; // "worsen the Hit stat of their weapons by 1"
  });

  // ---- EXTRA ARMOUR ------------------------------------------------------
  // "Subtract 1" from the Move stat of friendly WRECKA KREW operatives and improve their Save stat
  //  by 1. This excludes BOMB SQUIG operatives and isn't cumulative with the Protective rule of a
  //  Portable Barricade from universal equipment."
  reg.on('onStatMod', T.bind(EQ_EXTRA_ARMOUR, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_EXTRA_ARMOUR)) return;
    if (!isBoy(T, ev.operative)) return;
    ev.mods.move -= 1;
    ev.mods.save += 1;
  });
  // "…isn't cumulative with the Protective rule of a Portable Barricade": the universal equipment
  // adds its +1 at `onDefenceDice` (priority 30) while EXTRA ARMOUR's rides `onStatMod`, so the
  // duplicate is taken back off here, after the barricade has had its say.
  reg.on('onDefenceDice', T.bind(EQ_EXTRA_ARMOUR, 45), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ_EXTRA_ARMOUR)) return;
    const target = ev.ctx.defender;
    if (!target || !isBoy(T, target)) return;
    if (ev.mods.save <= 0 || !ev.ctx.inCover) return;
    const barricade = ev.state.placedFeatures.some(
      (f) => f.kind === 'equipment.portableBarricade' && f.owner === target.player,
    );
    if (!barricade) return;
    ev.mods.save -= 1;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: 'Extra Armour is not cumulative with a Portable Barricade’s Protective rule',
    });
  });

  // ---- GLYPHS ------------------------------------------------------------
  /*
   * "When this item of equipment is selected, also select the Waaagh! or Destruction strategy ploy.
   *  The first time you would use that ploy during the battle, it costs you 0CP; whenever you would
   *  use it thereafter, it costs you 0CP if you have any Wrecka points."
   *
   * Equipment selection has no decision channel, so the named ploy is the first of the two the
   * player actually uses — a deterministic, logged default (D-016) that then locks for the battle.
   * The reducer charges the CP before any hook sees the ploy, so "costs you 0CP" is a refund
   * (the Corsair Prowling Raiders shape); see REMINDER_ONLY for the consequence.
   */
  reg.on('onPloyUsed', T.bind(EQ_GLYPHS, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ_GLYPHS)) return;
    if (ev.ployId !== SP_WAAAGH && ev.ployId !== SP_DESTRUCTION) return;
    const b = bucket(ev.state, 'wrecka-krew.glyphs');
    let named = b[T.player] as string | undefined;
    if (!named) {
      named = ev.ployId;
      b[T.player] = named;
      log(ev.state, { kind: 'system', player: T.player, text: `Glyphs name ${ployName(named)}` });
    }
    if (named !== ev.ployId) return;
    const first = b[`used:${T.player}`] !== true;
    b[`used:${T.player}`] = true;
    if (!first && wreckaPoints(ev.state, T.player) <= 0) return;
    const cp = DATA.strategyPloys.find((p) => p.id === ev.ployId)?.cp ?? 0;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Glyphs: ${ployName(ev.ployId)} costs 0CP (${cp}CP refunded)`,
    });
  });
}

const ployName = (id: string): string => DATA.strategyPloys.find((p) => p.id === id)?.name ?? id;

const isDrillRokkit = (name: string): boolean => /^(’|')?eavy rokkit launcha$|^rokkit launcha$/i.test(name.trim());

/** The chosen GLYPHS ploy (pure setter shape, D-017 — the UI names it at equipment selection). */
export function setGlyphsPloy(state: GameState, player: PlayerId, ployId: string): void {
  bucket(state, 'wrecka-krew.glyphs')[player] = ployId;
}
export function glyphsPloy(state: GameState, player: PlayerId): string | undefined {
  return bucket(state, 'wrecka-krew.glyphs')[player] as string | undefined;
}

// ---------------------------------------------------------------------------
// Unique action: BREAK STUFF
// ---------------------------------------------------------------------------

interface BreakStuffPlan {
  ok: boolean;
  reason?: string;
  feature?: TerrainFeature;
  isEquipment?: boolean;
  markerPos?: Vec2;
}

/**
 * BREAK STUFF 1AP: "Select a terrain feature within this operative's control range. If it's an
 * equipment terrain feature, remove it. Otherwise, place one of your Breach markers within this
 * operative's control range as close as possible to that terrain feature… This operative cannot
 * perform this action while within control range of an enemy operative, or if a terrain feature
 * isn't within its control range."
 *
 * Pure and shared by `check` and `perform` (D-026).
 */
function planBreakStuff(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): BreakStuffPlan {
  const card = ctx.datacards.get(op.datacardId);
  if (!card) return { ok: false, reason: 'unknown datacard' };
  if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
    return { ok: false, reason: 'within control range of an enemy operative' };
  const index = terrain(ctx, state);
  const near = index.parts
    .map((part) => ({ part, gap: baseDistanceToPart(op.pos, card.base, op.rot, part) }))
    .filter((x) => x.gap <= 1 + EPS)
    .sort((a, b) => a.gap - b.gap || (a.part.id < b.part.id ? -1 : 1));
  if (near.length === 0) return { ok: false, reason: 'a terrain feature isn’t within its control range' };
  const wanted = params.partId ? near.find((x) => x.part.id === params.partId) : undefined;
  const chosen = wanted ?? near[0]!;
  const feature = chosen.part.feature;
  const isEquipment = state.placedFeatures.some((f) => f.id === feature.id);
  if (isEquipment) return { ok: true, feature, isEquipment: true };
  // "…as close as possible to that terrain feature", still within this operative's control range.
  const anchor = closestPointOnPoly(op.pos, chosen.part.poly);
  const away = { x: anchor.x - op.pos.x, y: anchor.y - op.pos.y };
  const length = Math.hypot(away.x, away.y);
  const reach = Math.min(length, baseRadius(card.base) + 0.5);
  const markerPos =
    length < 1e-6 ? { ...op.pos } : { x: op.pos.x + (away.x / length) * reach, y: op.pos.y + (away.y / length) * reach };
  const probe: MarkerState = { id: 'probe', kind: 'generic', diameterMm: 20, pos: markerPos, z: op.z, flags: {} };
  if (!markerContestedBy(ctx, state, probe, op)) return { ok: true, feature, markerPos: { ...op.pos } };
  return { ok: true, feature, markerPos };
}

function closestPointOnPoly(p: Vec2, poly: Vec2[]): Vec2 {
  let best = poly[0] ?? p;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    const q = { x: a.x + abx * t, y: a.y + aby * t };
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

function actions(data: typeof DATA): ActionDef[] {
  return [
    uniqueAction(data, FIGHTER, ACT_BREAK_STUFF, {
      check: (ctx, state, op, params) => {
        const plan = planBreakStuff(ctx, state, op, params);
        return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'no terrain feature to break' };
      },
      perform: (ctx, state, op, params) => {
        const plan = planBreakStuff(ctx, state, op, params);
        if (!plan.ok || !plan.feature) return { ok: false, reason: plan.reason ?? 'no terrain feature to break' };
        if (plan.isEquipment) {
          for (const part of plan.feature.parts)
            state.terrainState[part.id] = { ...(state.terrainState[part.id] ?? {}), removed: true };
          log(state, {
            kind: 'action',
            player: op.player,
            text: `${op.letter}: BREAK STUFF removes the ${plan.feature.kind} equipment terrain feature`,
          });
          return { ok: true };
        }
        const n = Object.keys(state.markers).filter((id) => id.startsWith(`wrecka-krew.breach.${op.player}.`)).length;
        placeTeamMarker(state, {
          id: `wrecka-krew.breach.${op.player}.${n}`,
          kind: 'generic',
          player: op.player,
          pos: plan.markerPos ?? { ...op.pos },
          z: op.z,
          flags: { breach: true, featureId: plan.feature.id },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: BREAK STUFF places a Breach marker by ${plan.feature.label ?? plan.feature.id}`,
        });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Extra actions: the Explosive shot, the Pulsa rokkit and Proppa Scrap's second Fight
// ---------------------------------------------------------------------------

/**
 * BOMB SQUIG › Explosive: "This operative can perform the Shoot action with this weapon while
 * within control range of an enemy operative. Don't select a valid target. Instead, this operative
 * is always the primary target and cannot be in cover or obscured." (D-021: the universal Shoot
 * refuses both, and `canPerformAction` can only forbid.)
 */
registerAction({
  id: EXPLOSIVE_SHOOT,
  name: 'Shoot (Explosives)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(BOMB_SQUIG, AB_EXPLOSIVE),
  available: (_ctx, _state, op) => op.datacardId === BOMB_SQUIG,
  check(ctx, state, op, params) {
    const weapon = weaponsOf(ctx, state, op, 'ranged').find(
      (w) =>
        (params.weaponName === undefined || w.name === params.weaponName) &&
        w.profiles.some((p) => p.rules.some((r) => r.id === 'Explosive')),
    );
    if (!weapon) return { ok: false, reason: 'select a weapon that has the Explosive weapon rule' };
    const profile = weapon.profiles[0]!;
    const limited = profile.rules.find((r) => r.id === 'Limited');
    if (limited && (op.weaponUses[weapon.name] ?? 0) >= (limited.x ?? 1))
      return { ok: false, reason: `${weapon.name} has already been used` };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = weaponsOf(ctx, state, op, 'ranged').find(
      (w) =>
        (params.weaponName === undefined || w.name === params.weaponName) &&
        w.profiles.some((p) => p.rules.some((r) => r.id === 'Explosive')),
    )!;
    // Point-blank is the engine's "not a valid target" path; the Hit penalty it carries is
    // cancelled by the Explosive stat hook, because the printed rule does not print one.
    const r = startShoot(ctx, state, op, weapon.name, params.profileName, op.id, { pointBlank: true });
    if (!r.ok) return r;
    const seq = state.sequence as ShootSequence;
    // "…and cannot be in cover or obscured"
    seq.inCover = false;
    seq.obscured = false;
    seq.coverChoiceMade = true;
    advanceShoot(ctx, state);
    return { ok: true };
  },
});

/**
 * TANKBUSTA ROKKITEER › Pulsa (rare weapon rule): "Don't select a valid target. Instead, place your
 * Pulsa marker visible to this operative, or on Vantage terrain of a terrain feature that's visible
 * to this operative. That marker gains 1 Pulsa point, then roll attack dice: it gains 1 additional
 * Pulsa point for each success (to a maximum of 3 additional points). Separately inflict D3 damage
 * on each operative wholly within x" of that marker, where x is that marker's Pulsa points. Then
 * the action ends."
 *
 * The marker position comes from the intent's `data` with a deterministic, logged default (D-016):
 * the nearest enemy operative visible to the ROKKITEER, else its own position.
 */
registerAction({
  id: PULSA_SHOOT,
  name: 'Shoot (Pulsa Rokkit)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: abilityText(ROKKITEER, AB_PULSA),
  available: (_ctx, _state, op) => op.datacardId === ROKKITEER,
  check(ctx, state, op, params) {
    const plan = planPulsa(ctx, state, op, params);
    return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'the Pulsa rokkit cannot be used' };
  },
  perform(ctx, state, op, params) {
    const plan = planPulsa(ctx, state, op, params);
    if (!plan.ok || !plan.pos || !plan.profile) return { ok: false, reason: plan.reason ?? 'no Pulsa rokkit' };
    const index = terrain(ctx, state);
    removeMarker(state, PULSA_MARKER(op.player));
    const marker = placeTeamMarker(state, {
      id: PULSA_MARKER(op.player),
      kind: 'generic',
      player: op.player,
      pos: plan.pos,
      z: surfaceAt(index, plan.pos),
      flags: { pulsa: true, pulsaPoints: 1 },
    });
    // "…then roll attack dice: it gains 1 additional Pulsa point for each success"
    const hit = hitOf(ctx, state, op, plan.profile);
    const results = ctx.rng.roll(plan.profile.atk);
    recordRoll(state, 'pulsa', results, op.player, `Pulsa attack dice (${hit}+)`);
    const hits = results.filter((v) => classify(v, hit) !== 'fail').length;
    const points = 1 + Math.min(3, hits);
    marker.flags['pulsaPoints'] = points;
    log(state, {
      kind: 'dice',
      player: op.player,
      text: `Pulsa: ${results.join(', ')} → ${hits} success(es), marker has ${points} Pulsa point(s)`,
    });
    // "Separately inflict D3 damage on each operative wholly within x" of that marker"
    for (const victim of aliveOperatives(state).sort(byId)) {
      const card = ctx.datacards.get(victim.datacardId);
      if (!card) continue;
      if (!whollyWithinMarker(victim, card.base, marker, points)) continue;
      const d3 = ctx.rng.d3();
      recordRoll(state, 'pulsa', [d3], op.player, `Pulsa D3 vs ${victim.letter}`);
      inflictDamage(ctx, state, victim, d3, 'other');
    }
    // "Then the action ends."
    op.weaponUses[plan.weaponName!] = (op.weaponUses[plan.weaponName!] ?? 0) + 1;
    return { ok: true };
  },
});

interface PulsaPlan {
  ok: boolean;
  reason?: string;
  pos?: Vec2;
  profile?: WeaponProfile;
  weaponName?: string;
}

function planPulsa(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): PulsaPlan {
  const weapon = weaponsOf(ctx, state, op, 'ranged').find((w) =>
    w.profiles.some((p) => p.rules.some((r) => r.id === 'Pulsa')),
  );
  if (!weapon) return { ok: false, reason: 'this operative has no pulsa rokkit' };
  const profile = weapon.profiles.find((p) => p.rules.some((r) => r.id === 'Pulsa'))!;
  const limited = profile.rules.find((r) => r.id === 'Limited');
  if (limited && (op.weaponUses[weapon.name] ?? 0) >= (limited.x ?? 1))
    return { ok: false, reason: `${weapon.name} has already been used` };
  // Heavy (Reposition only): "cannot use this weapon in an activation in which it moved".
  const heavy = profile.rules.find((r) => r.id === 'Heavy');
  if (heavy) {
    const moves = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];
    const moved = op.actionsThisActivation.some((a) => moves.includes(a));
    if (moved && !op.actionsThisActivation.every((a) => a === heavy.only || !moves.includes(a)))
      return { ok: false, reason: `${weapon.name} is Heavy — it cannot be used in an activation in which it moved` };
  }
  if (op.order === 'conceal') return { ok: false, reason: 'cannot Shoot with a Conceal order' };
  if (aliveOperatives(state, otherPlayer(op.player)).some((e) => inControlRange(ctx, state, op, e)))
    return { ok: false, reason: 'within control range of an enemy operative' };

  const index = terrain(ctx, state);
  const named = params.targetOperativeId ?? params.targetId;
  const namedOp = named ? state.operatives[named] : undefined;
  const requested =
    params.markerPos ?? params.targetPos ?? (namedOp && !namedOp.removed ? { ...namedOp.pos } : undefined);
  const fallback = aliveOperatives(state, otherPlayer(op.player))
    .filter((e) => isVisible(index, body(ctx, op), body(ctx, e)).visible)
    .sort((a, b) => dist(op.pos, a.pos) - dist(op.pos, b.pos) || (a.id < b.id ? -1 : 1))[0];
  const pos = requested ?? (fallback ? { ...fallback.pos } : { ...op.pos });
  // "place your Pulsa marker visible to this operative"
  const probe = {
    id: 'pulsa-probe',
    pos,
    z: surfaceAt(index, pos),
    rot: 0,
    base: { shape: 'round' as const, mm: 20 },
    height: 0.2,
  };
  if (!isVisible(index, body(ctx, op), probe).visible)
    return { ok: false, reason: 'the Pulsa marker must be placed visible to this operative' };
  const board = state.map.board;
  if (pos.x < 0 || pos.y < 0 || pos.x > board.w || pos.y > board.h)
    return { ok: false, reason: 'that point is off the killzone' };
  return { ok: true, pos, profile, weaponName: weapon.name };
}

/**
 * PROPPA SCRAP: "During that activation, that operative can perform two FIGHT actions." Action
 * restrictions refuse a second Fight, and `canPerformAction` can only forbid, so the second one is
 * its own ActionDef (D-021 — the Kommandos Krumpin' Time precedent); with no `treatedAs` it is a
 * separate restriction key, so it can itself only be used once.
 */
registerAction({
  id: PROPPA_SCRAP_FIGHT,
  name: 'Fight (Proppa Scrap)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.firefightPloys.find((p) => p.id === FP_PROPPA_SCRAP)!.text,
  available: (ctx, _state, op) => {
    const kws = ctx.datacards.get(op.datacardId)?.keywords ?? [];
    return kws.includes('WRECKA KREW') && (kws.includes('BREAKA BOY') || kws.includes('BOSS NOB'));
  },
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === PROPPA_EFFECT && e.operativeId === op.id))
      return { ok: false, reason: 'Proppa Scrap has not been used on this operative' };
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Proppa Scrap is the second Fight action of an activation' };
    // D-026: the universal Fight's `check` never looks at `params.targetId`, but its `perform`
    // does — so a named target that is out of control range would be a rejected intent.
    const target = params.targetId ? state.operatives[params.targetId] : undefined;
    if (params.targetId && (!target || target.removed || target.player === op.player || !inControlRange(ctx, state, op, target)))
      return { ok: false, reason: 'that enemy operative is not within control range' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------

const catalogueKeywords = (datacardId: string): string[] =>
  DATA.datacards.find((c) => c.id === datacardId)?.keywords ?? [];
const catalogueWeapons = (datacardId: string) => DATA.datacards.find((c) => c.id === datacardId)?.weapons;

export const wreckaKrew = defineTeam({
  id: 'wrecka-krew',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy during a friendly BREAKA BOY or BOSS NOB operative's activation."
    [FP_PROPPA_SCRAP]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'use this ploy during a friendly operative’s activation' };
      const kws = catalogueKeywords(active.datacardId);
      if (!kws.includes('BREAKA BOY') && !kws.includes('BOSS NOB'))
        return { ok: false, reason: 'that operative is not a BREAKA BOY or BOSS NOB' };
      return { ok: true };
    },
    // "Use this firefight ploy after a friendly WRECKA KREW operative performs the Shoot or Fight
    //  action, just before incapacitated operatives are removed (if any)."
    [FP_DEMOLITION_JOB]: (state, player) =>
      lastAttackTarget(state, player)
        ? { ok: true }
        : { ok: false, reason: 'use this ploy after a friendly operative performs the Shoot or Fight action' },
    // "Use this firefight ploy when a friendly WRECKA KREW operative performs the Shoot action and
    //  a weapon with the Blast weapon rule is selected."
    [FP_KABOOM]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'use this ploy during a friendly operative’s activation' };
      if (active.actionsThisActivation.includes('Shoot'))
        return { ok: false, reason: 'that operative has already performed the Shoot action' };
      const blast = (catalogueWeapons(active.datacardId) ?? []).some((w) =>
        w.profiles.some((p) => p.type === 'ranged' && p.rules.some((r) => r.id === 'Blast')),
      );
      return blast ? { ok: true } : { ok: false, reason: 'that operative has no weapon with the Blast weapon rule' };
    },
  },
  aiHints: {
    roles: {
      [BOSS_NOB]: 'leader',
      [BOMB_SQUIG]: 'melee',
      [DEMOLISHA]: 'melee',
      [FIGHTER]: 'melee',
      [KRUSHA]: 'melee',
      [GUNNER]: 'gunner',
      [ROKKITEER]: 'gunner',
    },
    ployValue: {
      [SP_WAAAGH]: 0.6,
      [SP_DESTRUCTION]: 0.6,
      [SP_TUFF_GITZ]: 0.5,
      [SP_AMPED_UP]: 0.7,
      [FP_JUST_A_SCRATCH]: 0.7,
      [FP_PROPPA_SCRAP]: 0.6,
      [FP_DEMOLITION_JOB]: 0.4,
      [FP_KABOOM]: 0.5,
    },
    equipmentValue: {
      [EQ_DRILL_ROKKITS]: 0.5,
      [EQ_ENGINE_OIL]: 0.4,
      [EQ_EXTRA_ARMOUR]: 0.7,
      [EQ_GLYPHS]: 0.6,
    },
  },
});

export default wreckaKrew;

/** Exported for the tests. */
export { ownPool, planSmash, planPulsa, planBreakStuff, isDrillRokkit };
