/**
 * NOVITIATES — Adepta Sororitas.
 * https://wahapedia.ru/kill-team3/kill-teams/novitiates/
 *
 * Rule text is read from `data/teams/novitiates.json`; every hook carries a short verbatim
 * quote of the printed rule in its RuleBinding.
 *
 * The whole team hangs off ONE economy — **Faith points** — so it is modelled once, in
 * `state.opState`, and every rule reads or writes it through `faithPoints`/`gainFaith`/
 * `spendFaith`:
 *
 *  - **Acts of Faith** is the faction rule. The three ACTS (GUIDANCE / BLESSING /
 *    INTERVENTION) are a MENU inside one printed rule with no ids of their own, so they are
 *    sliced out of the printed text at module load (the Legionary "Marks of Chaos" exception
 *    to "never retype printed rule text"), and offered as a real `PendingDecision` the owning
 *    player answers through `GameContext.decisionHandlers`.
 *  - The window is opened from three places, because the engine has one post-roll hook for
 *    shooting and none for fighting: `onRollAttack` (a friendly NOVITIATE shooting),
 *    `onDefenceDice` at the `defenceRerolls` step (an operative shooting a friendly
 *    NOVITIATE) and `onCollectAttackDice` for melee (fighting or retaliating). The melee
 *    decision is raised BEFORE the dice are rolled but ANSWERED after them — `advanceFight`
 *    stops as soon as anything is pending — so the handler always reads a rolled pool.
 *  - Faith points are only deducted when an ACT actually lands on a die, so a decision that
 *    cannot apply costs nothing.
 */
import { getAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { baseGap } from '../../core/geometry.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { hasRule, lethalThreshold, rerollDie, type DicePool, type Die } from '../../core/dice.ts';
import { HookRegistry } from '../../core/hooks.ts';
import {
  body,
  card,
  findProfile,
  gapBetween,
  hitOf,
  inflictDamage,
  isInjured,
  log,
  markerController,
  recordRoll,
  saveOf,
  weaponsOf,
} from '../../core/state.ts';
import { effectiveRules } from '../../core/sequences/shoot.ts';
import { sideWeapon } from '../../core/sequences/fight.ts';
import { isVisible } from '../../core/visibility.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import type {
  GameState,
  MarkerState,
  OperativeState,
  PendingDecision,
  PlayerId,
  WeaponProfile,
} from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  aliveOperatives,
  bucket,
  currentApl,
  defaultGambits,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  enemiesInControlRange,
  gambitUsed,
  giveToken,
  grantFreeAction,
  hasEquipment,
  hasToken,
  horizontal,
  notEngaged,
  placeTeamMarker,
  ployUsed,
  posFromData,
  removeMarker,
  removeToken,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('novitiates');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const KW = 'NOVITIATE';

export const RULE_ACTS_OF_FAITH = 'novitiates.rule.acts-of-faith';

export const SP = {
  ardentVengeance: 'novitiates.sp.ardent-vengeance',
  defendersOfTheFaith: 'novitiates.sp.defenders-of-the-faith',
  blessedRejuvenation: 'novitiates.sp.blessed-rejuvenation',
  righteousAdvance: 'novitiates.sp.righteous-advance',
} as const;

export const FP = {
  gloriousMartyrdom: 'novitiates.fp.glorious-martyrdom',
  blazingInferno: 'novitiates.fp.blazing-inferno',
  blindingAura: 'novitiates.fp.blinding-aura',
  guidedByFaith: 'novitiates.fp.guided-by-faith',
} as const;

export const EQ = {
  iconOfFaith: 'novitiates.eq.icon-of-faith',
  sanctifiedRounds: 'novitiates.eq.sanctified-rounds',
  autoChastisers: 'novitiates.eq.auto-chastisers',
  holyEmbrocations: 'novitiates.eq.holy-embrocations',
} as const;

export const C = {
  superior: 'novitiates.superior',
  condemnor: 'novitiates.condemnor',
  dialogus: 'novitiates.dialogus',
  duellist: 'novitiates.duellist',
  exactor: 'novitiates.exactor',
  hospitaller: 'novitiates.hospitaller',
  militant: 'novitiates.militant',
  penitent: 'novitiates.penitent',
  preceptor: 'novitiates.preceptor',
  pronatus: 'novitiates.pronatus',
  purgatus: 'novitiates.purgatus',
  reliquarius: 'novitiates.reliquarius',
} as const;

const A = {
  inspirationalExample: 'novitiates.superior.inspirational-example',
  nullRod: 'novitiates.condemnor.null-rod',
  antiPsyker: 'novitiates.condemnor.anti-psyker',
  riposte: 'novitiates.duellist.riposte',
  medic: 'novitiates.hospitaller.medic',
  militantFaith: 'novitiates.militant.militant-faith',
  zealousRage: 'novitiates.penitent.zealous-rage',
  absolution: 'novitiates.penitent.absolution-through-destruction',
  unflinchingExample: 'novitiates.preceptor.unflinching-example',
  gloriousHymnal: 'novitiates.preceptor.glorious-hymnal',
  relicSeeker: 'novitiates.pronatus.relic-seeker',
  divineAcquisition: 'novitiates.pronatus.divine-acquisition',
  purgeWithFlame: 'novitiates.purgatus.purge-with-flame',
  iconBearer: 'novitiates.reliquarius.icon-bearer',
} as const;

const ACT_STIRRING_RHETORIC = 'novitiates.dialogus.act.stirring-rhetoric';
const ACT_AUTO_BROADCASTER = 'novitiates.dialogus.act.auto-broadcaster';
const ACT_WHIP_INTO_FRENZY = 'novitiates.exactor.act.whip-into-frenzy';
const ACT_CHIRURGEONS_TOOLS = 'novitiates.hospitaller.act.chirurgeons-tools';
const ACT_RAISE_ICON = 'novitiates.reliquarius.act.raise-icon';

/** Effect / token rule names (never module-level mutable state — architecture rule 7). */
const FAITH = 'novitiates.faith';
const ACT_LEDGER = 'novitiates.actSeq';
export const BLAZE_TOKEN = 'novitiates.blazeToken';
const FRENZY = 'novitiates.frenzy';
const RHETORIC = 'novitiates.rhetoric';
const MEDIC_APL = 'novitiates.medicApl';
const MEDIC_SHIELD = 'novitiates.medicShield';
const REJUVENATION = 'novitiates.rejuvenation';
const BLINDING_AURA = 'novitiates.blindingAura';
const GUIDED = 'novitiates.guidedByFaith';
const SANCTIFIED = 'novitiates.sanctifiedRounds';
const MARTYRDOM_FLAG = 'novitiates.inMartyrdom';

export const ACT_DECISION = 'novitiates.actOfFaith';
export const BLAZE_DECISION = 'novitiates.blaze';

const BROADCASTER = (player: PlayerId): string => `novitiates.broadcaster.${player}`;

// ---------------------------------------------------------------------------
// Faith points
// ---------------------------------------------------------------------------

export function faithPoints(state: GameState, player: PlayerId): number {
  return Number(bucket(state, FAITH)[player] ?? 0);
}

function setFaith(state: GameState, player: PlayerId, n: number): void {
  bucket(state, FAITH)[player] = Math.max(0, n);
}

export function gainFaith(state: GameState, player: PlayerId, n: number, why: string): void {
  if (n <= 0) return;
  setFaith(state, player, faithPoints(state, player) + n);
  log(state, {
    kind: 'action',
    player,
    text: `+${n} Faith point${n === 1 ? '' : 's'} (${why}) — ${faithPoints(state, player)} held`,
    data: { faith: faithPoints(state, player), source: why },
  });
}

function spendFaith(state: GameState, player: PlayerId, n: number, why: string): boolean {
  if (n <= 0) return true;
  if (faithPoints(state, player) < n) return false;
  setFaith(state, player, faithPoints(state, player) - n);
  log(state, {
    kind: 'action',
    player,
    text: `−${n} Faith point${n === 1 ? '' : 's'} (${why}) — ${faithPoints(state, player)} held`,
    data: { faith: faithPoints(state, player), source: why },
  });
  return true;
}

// ---------------------------------------------------------------------------
// The ACTS OF FAITH menu, sliced out of the one printed faction rule
// ---------------------------------------------------------------------------

export interface ActOfFaith {
  id: 'guidance' | 'blessing' | 'intervention';
  name: string;
  cost: number;
  effect: string;
}

/**
 * "…their costs and effects are as follows: GUIDANCE1 FAITH POINT / You can re-roll one of
 * your dice. …" — three sub-rules inside one printed faction rule, with no ids of their own.
 * They are sliced out of the printed text rather than retyped (the Legionary Marks of Chaos
 * exception to CLAUDE.md's "rules as data").
 */
export const ACTS_OF_FAITH: ActOfFaith[] = (() => {
  const out: ActOfFaith[] = [];
  const src = text(RULE_ACTS_OF_FAITH);
  const re = /(GUIDANCE|BLESSING|INTERVENTION)(\d+)\s*FAITH POINTS?\n([^\n]+)/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    out.push({
      id: m[1]!.toLowerCase() as ActOfFaith['id'],
      name: m[1]!,
      cost: Number(m[2]),
      effect: m[3]!.trim(),
    });
  }
  return out;
})();

const actById = (id: string): ActOfFaith | undefined => ACTS_OF_FAITH.find((a) => a.id === id);

/** Cheapest-first: the most Faith-efficient act is the deterministic default (D-022). */
const ACT_ORDER: ActOfFaith['id'][] = ['guidance', 'intervention', 'blessing'];
const orderedActs = (): ActOfFaith[] =>
  ACT_ORDER.map((id) => actById(id)).filter((a): a is ActOfFaith => a !== undefined);

// ---------------------------------------------------------------------------
// Sequence bookkeeping for "one ACT OF FAITH per sequence"
// ---------------------------------------------------------------------------

type PoolKey = 'attack' | 'defence' | 'attacker' | 'defender';

interface ActLedger {
  stamp: string;
  /** The window has already been offered in this sequence. */
  offered: boolean;
  used: string[];
  /** Faith points actually spent, per ACT, for Militant Faith's refund. */
  spent: number[];
  refunded: boolean;
  /** The friendly operative the points were spent on (Blessed Rejuvenation). */
  opId: string;
  /** True while the NOVITIATE is shooting / fighting / retaliating (not being shot at). */
  attacking: boolean;
}

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

function seqStamp(state: GameState): string {
  const s = state.sequence;
  if (!s) return 'none';
  return s.kind === 'shoot' ? `shoot:${s.attackerId}:${s.targetId}` : `fight:${s.attackerId}:${s.defenderId}`;
}

function ledger(state: GameState, player: PlayerId): ActLedger {
  const b = bucket(state, ACT_LEDGER);
  const stamp = seqStamp(state);
  const cur = b[player] as ActLedger | undefined;
  if (cur && cur.stamp === stamp) return cur;
  const fresh: ActLedger = { stamp, offered: false, used: [], spent: [], refunded: false, opId: '', attacking: false };
  b[player] = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Dice pools
// ---------------------------------------------------------------------------

interface PoolInfo {
  pool: DicePool;
  hit: number;
  lethal?: number;
  /** Obscured forbids retaining crits, which BLESSING would otherwise do. */
  critsForbidden: boolean;
}

function poolInfo(ctx: GameContext, state: GameState, key: PoolKey): PoolInfo | undefined {
  const shoot = shootSeq(state);
  if (shoot) {
    const attacker = state.operatives[shoot.attackerId];
    const target = state.operatives[shoot.targetId];
    if (!attacker || !target) return undefined;
    if (key === 'defence')
      return { pool: shoot.defence, hit: saveOf(ctx, state, target), critsForbidden: false };
    const w = weaponsOf(ctx, state, attacker, 'ranged').find((x) => x.name === shoot.weaponName);
    const profile = w ? (findProfile(w, shoot.profileName) ?? w.profiles[0]) : undefined;
    if (!profile) return undefined;
    const rules = effectiveRules(ctx, state, profile, {
      operative: attacker,
      target,
      weaponName: shoot.weaponName,
    });
    return {
      pool: shoot.attack,
      hit: hitOf(ctx, state, attacker, profile, shoot.pointBlank ? -1 : 0),
      lethal: lethalThreshold(rules),
      critsForbidden: shoot.obscured,
    };
  }
  const fight = fightSeq(state);
  if (!fight) return undefined;
  const side: 'attacker' | 'defender' = key === 'defender' ? 'defender' : 'attacker';
  const op = state.operatives[side === 'attacker' ? fight.attackerId : fight.defenderId];
  if (!op) return undefined;
  const { profile, rules } = sideWeapon(ctx, state, fight, side);
  const assists = side === 'attacker' ? fight.attackerAssists : fight.defenderAssists;
  return {
    pool: side === 'attacker' ? fight.attackerPool : fight.defenderPool,
    hit: hitOf(ctx, state, op, profile, assists),
    lethal: lethalThreshold(rules),
    critsForbidden: false,
  };
}

/** Apply one ACT OF FAITH to the live pool. Returns false when no die is eligible. */
function applyAct(
  ctx: GameContext,
  state: GameState,
  act: ActOfFaith,
  key: PoolKey,
  player: PlayerId,
): boolean {
  const info = poolInfo(ctx, state, key);
  if (!info) return false;
  if (act.id === 'guidance') {
    // "You can re-roll one of your dice." — a fail first, then the worst rolled die.
    const cands = info.pool.dice.filter((d) => d.rolled && (d.state === 'fail' || d.state === 'normal' || d.state === 'crit'));
    const die = [...cands].sort(
      (a, b) => rank(a) - rank(b) || a.value - b.value || a.id - b.id,
    )[0];
    if (!die) return false;
    const value = ctx.rng.d6();
    recordRoll(state, 'novitiates.guidance', [value], player, 'GUIDANCE re-roll');
    rerollDie(die, value, info.hit, info.lethal !== undefined ? { lethal: info.lethal } : {});
    return true;
  }
  if (act.id === 'blessing') {
    // Obscured "takes precedence over all other rules": crits cannot be retained.
    if (info.critsForbidden) return false;
    const die = info.pool.dice.filter((d) => d.state === 'normal').sort((a, b) => a.value - b.value || a.id - b.id)[0];
    if (!die) return false;
    die.state = 'crit';
    die.note = 'BLESSING';
    return true;
  }
  const die = info.pool.dice.filter((d) => d.state === 'fail').sort((a, b) => b.value - a.value || a.id - b.id)[0];
  if (!die) return false;
  die.state = 'normal';
  die.note = 'INTERVENTION';
  return true;
}

const rank = (d: Die): number => (d.state === 'fail' ? 0 : d.state === 'normal' ? 1 : 2);

// ---------------------------------------------------------------------------
// The ACT OF FAITH decision window
// ---------------------------------------------------------------------------

function offerActOfFaith(
  T: TeamHooks,
  state: GameState,
  spec: { operative: OperativeState; pool: PoolKey; attacking: boolean },
): void {
  if (!T.mineKw(spec.operative, KW)) return;
  const led = ledger(state, T.player);
  if (led.offered) return;
  const faith = faithPoints(state, T.player);
  const options: PendingDecision['options'] = [];
  for (const act of orderedActs()) {
    if (act.cost > faith) continue;
    options.push({
      id: act.id,
      label: `${act.name} (${act.cost} Faith point${act.cost === 1 ? '' : 's'}): ${act.effect}`,
      data: { act: act.id },
    });
  }
  // AUTO-CHASTISERS: "Once per turning point, when a friendly NOVITIATE operative is shooting,
  // fighting or retaliating, in the Roll Attack Dice step, you can inflict 1-3 damage on that
  // friendly operative (but not enough to incapacitate it)."  It is not offered in the Roll
  // Defence Dice window, which the printed rule does not name.
  const chastisers =
    spec.attacking &&
    hasEquipment(state, T.player, EQ.autoChastisers) &&
    !usedThisTP(state, `novitiates.chastisers:${T.player}`);
  if (chastisers) {
    for (const act of orderedActs()) {
      if (spec.operative.wounds <= act.cost) continue; // "but not enough to incapacitate it"
      options.push({
        id: `chastise:${act.id}`,
        label: `AUTO-CHASTISERS: inflict ${act.cost} damage on ${spec.operative.name} and use ${act.name} for free`,
        data: { act: act.id, chastise: true },
      });
    }
  }
  if (options.length === 0) return;
  led.offered = true;
  led.opId = spec.operative.id;
  led.attacking = spec.attacking;
  options.push({ id: 'decline', label: 'Do not use an ACT OF FAITH' });
  state.pending.push({
    id: `faith-${state.seq++}`,
    who: T.player,
    kind: ACT_DECISION,
    prompt: `${spec.operative.name}: use an ACT OF FAITH? (${faith} Faith point${faith === 1 ? '' : 's'} held)`,
    sourceText: shortQuote(text(RULE_ACTS_OF_FAITH)),
    optional: true,
    ctx: { pool: spec.pool, operativeId: spec.operative.id, attacking: spec.attacking },
    options,
  });
}

function resolveActDecision(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): void {
  const option = decision.options.find((o) => o.id === optionId);
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const act = actById(String(payload['act'] ?? ''));
  if (!act) return; // 'decline'
  const player = decision.who;
  const key = (decision.ctx?.['pool'] ?? 'attack') as PoolKey;
  const opId = String(decision.ctx?.['operativeId'] ?? '');
  const op = state.operatives[opId];
  const led = ledger(state, player);
  if (led.used.includes(act.id)) return; // Icon of Faith: "each one must be different"
  const free = Boolean(payload['chastise']);

  if (free) {
    if (!op || op.removed || op.wounds <= act.cost) return;
    if (!useOncePerTP(state, `novitiates.chastisers:${player}`)) return;
    inflictDamage(ctx, state, op, act.cost, 'other');
    log(state, {
      kind: 'action',
      player,
      text: `AUTO-CHASTISERS: ${op.name} takes ${act.cost} damage for a free ${act.name}`,
    });
  } else if (faithPoints(state, player) < act.cost) {
    return;
  }

  if (!applyAct(ctx, state, act, key, player)) {
    log(state, { kind: 'action', player, text: `${act.name}: no eligible dice — no Faith points spent` });
    return;
  }
  // The ICON OF FAITH allowance is claimed when the second ACT actually lands, not when it is
  // offered, so declining it does not burn the turning point's use.
  if (payload['icon']) useOncePerTP(state, `novitiates.icon:${player}`);
  if (!free) spendFaith(state, player, act.cost, act.name);
  led.used.push(act.id);
  led.spent.push(free ? 0 : act.cost);
  log(state, { kind: 'action', player, text: `ACT OF FAITH: ${act.name}${free ? ' (Auto-chastisers)' : ''}` });

  // BLESSED REJUVENATION: "Whenever you spend Faith points, at the end of that action, the
  // friendly operative you spent them on can regain up to D3 lost wounds… no effect … if the
  // ACT OF FAITH doesn't cost any Faith points."
  if (!free && op && !op.removed && ployUsed(state, player, SP.blessedRejuvenation)) {
    effect(state, {
      rule: REJUVENATION,
      source: { kind: 'ploy', id: SP.blessedRejuvenation },
      sourceText: shortQuote(text(SP.blessedRejuvenation)),
      operativeId: op.id,
      player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  }

  // ICON OF FAITH: "Once per turning point, you can use up to two ACTS OF FAITH during a
  // sequence, but each one must be different."
  if (
    led.used.length === 1 &&
    hasEquipment(state, player, EQ.iconOfFaith) &&
    !usedThisTP(state, `novitiates.icon:${player}`) &&
    op &&
    !op.removed
  ) {
    const faith = faithPoints(state, player);
    const second: PendingDecision['options'] = orderedActs()
      .filter((a) => !led.used.includes(a.id) && a.cost <= faith)
      .map((a) => ({
        id: a.id,
        label: `${a.name} (${a.cost} Faith point${a.cost === 1 ? '' : 's'}): ${a.effect}`,
        data: { act: a.id, icon: true },
      }));
    if (second.length > 0) {
      second.push({ id: 'decline', label: 'Do not use a second ACT OF FAITH' });
      state.pending.push({
        id: `faith2-${state.seq++}`,
        who: player,
        kind: ACT_DECISION,
        prompt: `ICON OF FAITH: a second, different ACT OF FAITH for ${op.name}?`,
        sourceText: shortQuote(text(EQ.iconOfFaith)),
        optional: true,
        ctx: { pool: key, operativeId: op.id, attacking: led.attacking },
        options: second,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

function visible(T: TeamHooks, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (!T.ctx) return true;
  return isVisible(terrain(T.ctx, state), body(T.ctx, a), body(T.ctx, b)).visible;
}

/** Is this weapon printed on the operative's own datacard (as opposed to granted)? */
function onDatacard(T: TeamHooks, op: OperativeState, weaponName: string): boolean {
  return (T.card(op)?.weapons ?? []).some((w) => w.name === weaponName);
}

const hasPsychic = (profile: WeaponProfile): boolean => profile.rules.some((r) => r.id === 'PSYCHIC');

/** A PSYCHIC unique action is printed with "PSYCHIC." as its first word. */
const isPsychicAction = (t: string): boolean => /^PSYCHIC\b/i.test(t.trim());

/** The weapon profile currently inflicting damage, for the rules that cap or bump it. */
function currentProfile(T: TeamHooks, state: GameState): { op: OperativeState; profile: WeaponProfile } | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const holderId =
    seq.kind === 'shoot' ? seq.attackerId : seq.turn === 'attacker' ? seq.attackerId : seq.defenderId;
  const holder = state.operatives[holderId];
  if (!holder) return undefined;
  const name =
    seq.kind === 'shoot' ? seq.weaponName : holderId === seq.attackerId ? seq.attackerWeapon : (seq.defenderWeapon ?? '');
  const profileName =
    seq.kind === 'shoot' ? seq.profileName : holderId === seq.attackerId ? seq.attackerProfile : seq.defenderProfile;
  const weapon = T.card(holder)?.weapons.find((w) => w.name === name);
  const profile = weapon?.profiles.find((p) => (p.name ?? '') === (profileName ?? '')) ?? weapon?.profiles[0];
  return profile ? { op: holder, profile } : undefined;
}

/** Whoever inflicted the wound that incapacitated `victim`, as far as the sequence knows. */
function incapacitator(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (seq?.kind === 'shoot') return state.operatives[seq.attackerId];
  if (seq?.kind === 'fight') {
    const other = seq.attackerId === victim.id ? seq.defenderId : seq.attackerId;
    return state.operatives[other];
  }
  return state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
}

/** How many of the attacker's dice are about to inflict damage, for "+1 to both Dmg stats". */
function unblockedDice(state: GameState): number {
  const shoot = shootSeq(state);
  if (shoot) return shoot.attack.dice.filter((d) => d.state === 'crit' || d.state === 'normal').length;
  return 1; // a fight resolves one success at a time
}

const objectiveMarkers = (state: GameState): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.kind === 'objective');

/**
 * `onBlockAllocation` does not carry the die being resolved, so "whenever you block with a
 * critical success" is read off the strike-or-block choice the reducer logs immediately
 * before it calls `resolveFightDie` ("strikeOrBlock: Block with the critical success").
 * See the report: a `dieWasCrit` field on the event would make this exact.
 */
function blockedWithCrit(state: GameState): boolean {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.kind !== 'decision') continue;
    return /^strikeOrBlock: Block with the critical/.test(entry.text);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // ---- Acts of Faith: the Ready-step income --------------------------------
  // "In the Ready step of each Strategy phase, you gain a number of Faith points equal to half
  //  the number of friendly NOVITIATE operatives that haven't been incapacitated (rounding up)."
  reg.on('onReadyStep', T.bind(RULE_ACTS_OF_FAITH, 10), (ev) => {
    if (ev.player !== T.player) return;
    const standing = T.friendlies(ev.state, KW).filter((o) => !o.incapacitated).length;
    gainFaith(ev.state, T.player, Math.ceil(standing / 2), 'Acts of Faith');
  });

  // ---- Acts of Faith: the three windows ------------------------------------
  // "Whenever a friendly NOVITIATE operative is shooting … in the Roll Attack Dice … step."
  reg.on('onRollAttack', T.bind(RULE_ACTS_OF_FAITH, 11), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    offerActOfFaith(T, ev.state, { operative: ev.ctx.attacker, pool: 'attack', attacking: true });
  });
  // "…or an operative is shooting it, in the … Roll Defence Dice step."  The defence pool is
  // only rolled by the time the sequence reaches `defenceRerolls`, which is the second of the
  // two `onDefenceDice` emits.
  reg.on('onDefenceDice', T.bind(RULE_ACTS_OF_FAITH, 12), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    offerActOfFaith(T, ev.state, { operative: target, pool: 'defence', attacking: false });
  });
  // "…fighting or retaliating, in the Roll Attack Dice … step."  `fight.ts` emits no post-roll
  // hook (docs/DECISIONS.md D-031), so the window is opened as the pool is collected and the
  // decision is ANSWERED after both sides have rolled — `advanceFight` stops while anything is
  // pending, so the handler always sees rolled dice.
  reg.on('onCollectAttackDice', T.bind(RULE_ACTS_OF_FAITH, 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    const pool: PoolKey = ev.ctx.attacker.id === seq.attackerId ? 'attacker' : 'defender';
    offerActOfFaith(T, ev.state, { operative: ev.ctx.attacker, pool, attacking: true });
  });

  // ---- SUPERIOR › Inspirational Example ------------------------------------
  reg.on('onIncapacitated', T.bind(A.inspirationalExample, 14), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (victim.player === T.player) return;
    // "This rule has no effect when using the Glorious Martyrdom firefight ploy."
    if (bucket(ev.state, MARTYRDOM_FLAG)[T.player]) return;
    const killer = incapacitator(ev.state, victim);
    if (!killer || killer.player !== T.player || killer.datacardId !== C.superior) return;
    gainFaith(ev.state, T.player, (T.card(victim)?.wounds ?? 0) >= 12 ? 2 : 1, 'Inspirational Example');
  });

  // ---- PRECEPTOR › Unflinching Example --------------------------------------
  // "Whenever this operative incapacitates a ready enemy operative within its control range."
  reg.on('onIncapacitated', T.bind(A.unflinchingExample, 14), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (victim.player === T.player || !victim.ready) return;
    const killer = incapacitator(ev.state, victim);
    if (!killer || killer.player !== T.player || killer.datacardId !== C.preceptor) return;
    if (T.gap(killer, victim) > 1 + 1e-6) return;
    gainFaith(ev.state, T.player, (T.card(victim)?.wounds ?? 0) >= 12 ? 2 : 1, 'Unflinching Example');
  });

  // ---- PRECEPTOR › Glorious Hymnal (SUPPORT) -------------------------------
  reg.on('onWeaponRules', T.bind(A.gloriousHymnal, 15), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    const preceptor = T.friendlies(ev.state).find((o) => {
      if (o.datacardId !== C.preceptor) return false;
      const reach = T.ctx ? supportDistance(T.ctx, ev.state, o, 3) : 3;
      return T.gap(o, ev.operative) <= reach + 1e-6;
    });
    if (!preceptor) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (Glorious Hymnal)'));
  });

  // ---- CONDEMNOR › Null Rod -------------------------------------------------
  // "PSYCHIC ranged weapons cannot inflict damage on this operative."
  reg.on('onDamage', T.bind(A.nullRod, 15), (ev) => {
    if (ev.target.player !== T.player || ev.target.datacardId !== C.condemnor) return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.profile.type !== 'ranged' || !hasPsychic(cur.profile)) return;
    ev.amount = 0;
  });
  // "Whenever an operative is within 6" of this operative: That operative cannot perform
  //  PSYCHIC actions or use PSYCHIC additional rules."
  reg.on('canPerformAction', T.bind(A.nullRod, 16), (ev) => {
    if (!nulledByRod(T, ev.state, ev.operative)) return;
    const printed = T.card(ev.operative)?.uniqueActions.find((a) => a.id === ev.action);
    if (!printed || !isPsychicAction(printed.text)) return;
    ev.allowed = false;
    ev.reason = 'within 6" of a NOVITIATE CONDEMNOR: it cannot perform PSYCHIC actions';
  });
  // "That operative cannot use PSYCHIC ranged weapons."
  reg.on('availableWeapons', T.bind(A.nullRod, 17), (ev) => {
    if (!nulledByRod(T, ev.state, ev.operative)) return;
    const psychic = (T.card(ev.operative)?.weapons ?? []).filter((w) =>
      w.profiles.some((p) => p.type === 'ranged' && hasPsychic(p)),
    );
    if (psychic.length === 0) return;
    ev.weapons = ev.weapons.filter((n) => !psychic.some((w) => w.name === n));
  });
  // "PSYCHIC melee weapons have no weapon rules and cannot have Dmg stats higher than 3/4."
  reg.on('onWeaponRules', T.bind(A.nullRod, 18), (ev) => {
    if (ev.type !== 'melee' || !hasPsychic(ev.profile)) return;
    if (!nulledByRod(T, ev.state, ev.operative)) return;
    ev.rules = [];
  });
  reg.on('onDamage', T.bind(A.nullRod, 19), (ev) => {
    if (ev.kind !== 'attack') return;
    const cur = currentProfile(T, ev.state);
    if (!cur || cur.profile.type !== 'melee' || !hasPsychic(cur.profile)) return;
    if (!nulledByRod(T, ev.state, cur.op)) return;
    const cap = ev.amount >= cur.profile.dmgC ? 4 : 3;
    ev.amount = Math.min(ev.amount, cap);
  });

  // ---- CONDEMNOR › Anti-PSYKER (rare weapon rule) ---------------------------
  // "Whenever this weapon is being used against an operative that has the PSYKER keyword, add
  //  1 to both Dmg stats of this weapon and it has the Lethal 5+ weapon rule."
  // NOTE: the Celestian Insidiants print a DIFFERENT Anti-PSYKER (Lethal 5+ only), so the
  // damage bump is scoped to this team's own operatives (docs/DECISIONS.md D-025).
  reg.on('onWeaponRules', T.bind(A.antiPsyker, 15), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ev.rules.some((r) => r.id === 'AntiPSYKER')) return;
    if (!ev.target || !T.kw(ev.target, 'PSYKER')) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Anti-PSYKER)'));
  });
  // Dmg stats are shared catalogue data, so "+1 to both Dmg stats" lands where the damage is
  // inflicted (docs/DECISIONS.md D-019), once per unblocked attack dice.
  reg.on('onDamage', T.bind(A.antiPsyker, 16), (ev) => {
    if (ev.kind !== 'attack') return;
    if (!T.kw(ev.target, 'PSYKER')) return;
    const cur = currentProfile(T, ev.state);
    if (!cur || !T.mineKw(cur.op, KW)) return;
    if (!cur.profile.rules.some((r) => r.id === 'AntiPSYKER')) return;
    ev.amount += unblockedDice(ev.state);
  });

  // ---- DUELLIST › Riposte (rare weapon rule) --------------------------------
  // "Whenever you block with a critical success, you can also inflict damage equal to the
  //  weapon's Critical Dmg stat on the enemy operative in that sequence."  Free, so it is
  //  auto-used on a stated policy and logged (docs/DECISIONS.md D-022).
  reg.on('onBlockAllocation', T.bind(A.riposte, 15), (ev) => {
    const blocker = ev.ctx.attacker; // `attacker` is whoever is resolving the die
    if (blocker.player !== T.player || !hasRule(ev.ctx.rules, 'Riposte')) return;
    const foe = ev.ctx.defender;
    if (!foe || !T.ctx) return;
    if (!blockedWithCrit(ev.state)) return;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Riposte: ${blocker.name} blocks and strikes ${foe.name} for ${ev.ctx.profile.dmgC}`,
    });
    inflictDamage(T.ctx, ev.state, foe, ev.ctx.profile.dmgC, 'attack');
  });

  // ---- HOSPITALLER › Medic! -------------------------------------------------
  reg.on('onIncapacitated', T.bind(A.medic, 11), (ev) => {
    if (ev.prevented) return;
    const victim = ev.operative;
    if (!T.mineKw(victim, KW) || !T.ctx) return;
    // "…and cannot be incapacitated for the remainder of the action."
    if (effectOn(ev.state, victim.id, MEDIC_SHIELD)) {
      ev.prevented = true;
      victim.wounds = Math.max(1, victim.wounds);
      return;
    }
    if (usedThisTP(ev.state, `novitiates.medic:${T.player}`)) return;
    if (enemiesInControlRange(T.ctx, ev.state, victim).length > 0) return;
    const medic = T.friendlies(ev.state, KW).find(
      (o) =>
        o.datacardId === C.hospitaller &&
        o.id !== victim.id &&
        !o.incapacitated &&
        T.gap(o, victim) <= 3 + 1e-6 &&
        visible(T, ev.state, o, victim) &&
        enemiesInControlRange(T.ctx!, ev.state, o).length === 0,
    );
    if (!medic) return;
    // "…or if it's a Shoot action and this operative would be a primary or secondary target."
    const seq = shootSeq(ev.state);
    if (seq && (seq.targetId === medic.id || seq.queue.includes(medic.id) || seq.resolvedTargets.includes(medic.id)))
      return;
    useOncePerTP(ev.state, `novitiates.medic:${T.player}`);
    ev.prevented = true;
    victim.wounds = 1; // "that friendly operative isn't incapacitated, has 1 wound remaining"
    const holder = ev.state.activeOperativeId ?? victim.id;
    effect(ev.state, {
      rule: MEDIC_SHIELD,
      source: { kind: 'ability', id: A.medic },
      sourceText: shortQuote(abilityText(C.hospitaller, A.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: holder },
    });
    // "After that action, that friendly operative can immediately perform a free Dash action."
    // Its "must end that move within this operative's control range" half has no seam.
    const ownActivation = ev.state.activeOperativeId === victim.id;
    grantFreeAction(ev.state, victim, {
      sourceId: A.medic,
      sourceText: shortQuote(abilityText(C.hospitaller, A.medic)),
      // "…and if this rule was used during that friendly operative's activation, that
      //  activation ends": from here on the only action it may take is the free Dash.
      threshold: ownActivation ? victim.apSpent : currentApl(T, ev.state, victim),
      kind: 'ability',
      only: ['Dash'],
    });
    // CHIRURGEON'S TOOLS: "It cannot be an operative that the Medic! rule was used on during
    // this turning point."
    effect(ev.state, {
      rule: `${MEDIC_APL}.treated`,
      source: { kind: 'ability', id: A.medic },
      sourceText: shortQuote(abilityText(C.hospitaller, A.medic)),
      operativeId: victim.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    // "Subtract 1 from this and that operative's APL stats until the end of their next
    //  activations respectively."
    for (const o of [medic, victim]) {
      effect(ev.state, {
        rule: MEDIC_APL,
        source: { kind: 'ability', id: A.medic },
        sourceText: shortQuote(abilityText(C.hospitaller, A.medic)),
        operativeId: o.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: o.id, armed: ev.state.activeOperativeId !== o.id },
      });
    }
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Medic!: ${medic.name} saves ${victim.name} (1 wound remaining)`,
    });
  });
  reg.on('onStatMod', T.bind(A.medic, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, MEDIC_APL)) ev.mods.apl -= 1;
  });

  // ---- MILITANT › Militant Faith --------------------------------------------
  // "…if you use an ACT OF FAITH during that sequence and an enemy operative is incapacitated,
  //  the Faith points spent on that ACT OF FAITH are refunded."
  reg.on('onIncapacitated', T.bind(A.militantFaith, 15), (ev) => {
    if (ev.prevented) return;
    if (ev.operative.player === T.player) return;
    const led = ledger(ev.state, T.player);
    if (led.refunded || !led.attacking || led.spent.length === 0) return;
    const op = ev.state.operatives[led.opId];
    if (!op || op.datacardId !== C.militant) return;
    // "If you use the Icon of Faith equipment, Faith points are only refunded for one of those
    //  ACTS OF FAITH (your choice)" — the dearest, deterministically.
    const refund = Math.max(...led.spent);
    if (refund <= 0) return;
    led.refunded = true;
    gainFaith(ev.state, T.player, refund, 'Militant Faith');
  });

  // ---- PENITENT › Zealous Rage (rare weapon rule) ---------------------------
  // "Whenever this operative is fighting with this weapon, it has the Ceaseless weapon rule."
  reg.on('onWeaponRules', T.bind(A.zealousRage, 15), (ev) => {
    if (!ev.rules.some((r) => r.id === 'ZealousRage')) return;
    if (!T.mine(ev.operative) || ev.retaliating) return;
    ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Zealous Rage)'));
  });

  // ---- PRONATUS › Relic Seeker ----------------------------------------------
  // "Once during each of this operative's activations, it can perform the Pick Up Marker,
  //  Place Marker or a mission action for 1 less AP."  `onActionCost` is a pure query, so the
  //  allowance is read back off `actionsThisActivation` rather than stamped.
  reg.on('onActionCost', T.bind(A.relicSeeker, 15), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.pronatus) return;
    if (!isRelicSeekerAction(ev.action)) return;
    if (ev.operative.actionsThisActivation.some((a) => isRelicSeekerAction(a))) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- PRONATUS › Divine Acquisition ----------------------------------------
  // Bound to the end of the activation: nothing runs at the end of an action.
  reg.on('onActivationEnd', T.bind(A.divineAcquisition, 15), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.pronatus || !T.ctx) return;
    if (usedThisTP(ev.state, `novitiates.divine:${T.player}`)) return;
    if (!op.actionsThisActivation.some((a) => getAction(a)?.type === 'mission')) return;
    const controls = Object.values(ev.state.markers).some(
      (m) => (m.kind === 'objective' || m.owner === T.player) && markerController(T.ctx!, ev.state, m) === T.player,
    );
    if (!controls) return;
    useOncePerTP(ev.state, `novitiates.divine:${T.player}`);
    gainFaith(ev.state, T.player, ev.state.turningPoint, 'Divine Acquisition');
  });

  // ---- PURGATUS › Purge with Flame ------------------------------------------
  // "Once per turning point, you can use the inferno firefight ploy for 0CP if this is the
  //  specified friendly NOVITIATE operative."  CP is deducted before `onPloyUsed`, so this is
  //  a refund (docs/TEAM-STATUS.md § Known engine gaps).
  reg.on('onPloyUsed', T.bind(A.purgeWithFlame, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.blazingInferno) return;
    const named = (ev.data?.['operativeId'] as string | undefined) ?? shootSeq(ev.state)?.attackerId;
    const op = named ? ev.state.operatives[named] : undefined;
    if (!op || op.player !== T.player || op.datacardId !== C.purgatus) return;
    if (!useOncePerTP(ev.state, `novitiates.purge:${T.player}`)) return;
    const ploy = DATA.firefightPloys.find((p) => p.id === FP.blazingInferno);
    ev.state.teams[T.player].cp += ploy?.cp ?? 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Purge with Flame: BLAZING INFERNO costs 0CP' });
  });

  // ---- RELIQUARIUS › Icon Bearer --------------------------------------------
  reg.on('onMarkerControl', T.bind(A.iconBearer, 15), (ev) => {
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    const bearers = T.friendlies(ev.state).filter(
      (o) => o.datacardId === C.reliquarius && T.markerGap(o, marker) <= 1 + 1e-6,
    );
    // "Note this isn't a change to its APL stat, so any changes are cumulative with this."
    if (bearers.length > 0) ev.aplByPlayer[T.player] += bearers.length;
  });

  // ---- EXACTOR › Whip Into Frenzy: the +1" Move half ------------------------
  reg.on('onStatMod', T.bind(ACT_WHIP_INTO_FRENZY, 15), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, FRENZY)) ev.mods.move += 1;
  });

  // ---- DIALOGUS › Stirring Rhetoric: the +1 APL half -----------------------
  reg.on('onStatMod', T.bind(ACT_STIRRING_RHETORIC, 16), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, RHETORIC)) return;
    // "(to a maximum of 3 after all APL stat changes have been totalled)"
    if ((T.card(ev.operative)?.apl ?? 2) >= 3) return;
    ev.mods.apl += 1;
  });

  // ---- DIALOGUS › Auto-broadcaster: the re-roll denial ---------------------
  // "Whenever an enemy operative within 3" of your Auto-broadcaster marker is shooting,
  //  fighting or retaliating, your opponent cannot re-roll their attack dice."  Only the
  //  shooting half is reachable: `fight.ts` emits no `onRollAttack` (D-031).
  reg.on('onRollAttack', T.bind(ACT_AUTO_BROADCASTER, 45), (ev) => {
    if (ev.ctx.attacker.player === T.player) return;
    const marker = ev.state.markers[BROADCASTER(T.player)];
    if (!marker) return;
    if (T.markerGap(ev.ctx.attacker, marker) > 3 + 1e-6) return;
    if (ev.rerolls.length === 0) return;
    ev.rerolls = [];
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Auto-broadcaster: ${ev.ctx.attacker.name} cannot re-roll its attack dice`,
    });
  });
  // "If this operative is removed from the killzone, remove your Auto-broadcaster marker."
  reg.on('onIncapacitated', T.bind(ACT_AUTO_BROADCASTER, 16), (ev) => {
    if (ev.prevented) return;
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.dialogus) return;
    if (T.friendlies(ev.state).some((o) => o.datacardId === C.dialogus && o.id !== ev.operative.id && !o.incapacitated))
      return;
    removeMarker(ev.state, BROADCASTER(T.player));
  });
}

/** "Whenever an operative is within 6" of this operative" — the CONDEMNOR's Null Rod. */
function nulledByRod(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return T.friendlies(state).some(
    (o) => o.datacardId === C.condemnor && o.id !== op.id && T.gap(o, op) <= 6 + 1e-6,
  );
}

const isRelicSeekerAction = (id: string): boolean =>
  id === 'Pick Up Marker' || id === 'Place Marker' || getAction(id)?.type === 'mission';

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- ARDENT VENGEANCE (strategy, 1CP) ------------------------------------
  reg.on('onWeaponRules', T.bind(SP.ardentVengeance, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.ardentVengeance)) return;
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!ev.target.expended) return; // "against an expended enemy operative"
    ev.rules.push(ruleTag('Punishing', undefined, 'Punishing (Ardent Vengeance)'));
  });

  // ---- DEFENDERS OF THE FAITH (strategy, 1CP) ------------------------------
  // "…you can halve the damage inflicted (rounding up and to a minimum of 2) on that friendly
  //  operative from ONE success."
  reg.on('onDamage', T.bind(SP.defendersOfTheFaith, 20), (ev) => {
    if (ev.kind !== 'attack' || ev.amount <= 0) return;
    if (!gambitUsed(ev.state, T.player, SP.defendersOfTheFaith)) return;
    if (!T.mineKw(ev.target, KW) || !T.ctx) return;
    const led = bucket(ev.state, 'novitiates.defenders');
    const stamp = seqStamp(ev.state);
    if (stamp === 'none' || led[T.player] === stamp) return;
    const contests = objectiveMarkers(ev.state).some((m) => T.markerGap(ev.target, m) <= 1 + 1e-6);
    if (!contests) return;
    const cur = currentProfile(T, ev.state);
    if (!cur) return;
    const shoot = shootSeq(ev.state);
    const crit = shoot ? shoot.attack.dice.some((d) => d.state === 'crit') : ev.amount >= cur.profile.dmgC;
    const one = crit ? cur.profile.dmgC : cur.profile.dmgN;
    const halved = Math.max(2, Math.ceil(one / 2));
    if (halved >= one) return;
    led[T.player] = stamp;
    ev.amount = Math.max(0, ev.amount - (one - halved));
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Defenders of the Faith: one success against ${ev.target.name} inflicts ${halved} instead of ${one}`,
    });
  });

  // ---- BLESSED REJUVENATION (strategy, 1CP) --------------------------------
  // The heal is armed where the Faith points are spent (see `resolveActDecision`) and paid out
  // here: nothing runs at the end of an action, so it is bounded to the activation.
  reg.on('onActivationEnd', T.bind(SP.blessedRejuvenation, 20), (ev) => {
    if (!T.ctx) return;
    const pending = ev.state.effects.filter((e) => e.rule === REJUVENATION && e.player === T.player);
    if (pending.length === 0) return;
    for (const e of pending) {
      const op = e.operativeId ? ev.state.operatives[e.operativeId] : undefined;
      dropEffects(ev.state, (x) => x.id === e.id);
      // "…no effect if that friendly operative was incapacitated during that action."
      if (!op || op.removed || op.incapacitated) continue;
      const heal = T.ctx.rng.d3();
      recordRoll(ev.state, 'novitiates.rejuvenation', [heal], T.player, 'Blessed Rejuvenation D3');
      const max = T.card(op)?.wounds ?? op.wounds + heal;
      const before = op.wounds;
      op.wounds = Math.min(max, op.wounds + heal);
      if (op.wounds > before)
        log(ev.state, {
          kind: 'ploy',
          player: T.player,
          text: `Blessed Rejuvenation: ${op.name} regains ${op.wounds - before} lost wounds`,
        });
    }
  });

  // ---- RIGHTEOUS ADVANCE (strategy, 1CP) -----------------------------------
  // "Up to one third of the friendly NOVITIATE operatives in the killzone (rounding down, to a
  //  minimum of 1) can immediately perform a free Dash action in an order of your choice."
  //  The "must end that move closer to…" half has no seam (no hook constrains where a move
  //  ends), so it is reminder-only.
  reg.on('onPloyUsed', T.bind(SP.righteousAdvance, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.righteousAdvance) return;
    const all = T.friendlies(ev.state, KW).filter((o) => !o.incapacitated);
    const n = Math.max(1, Math.floor(all.length / 3));
    const chosen = [...all].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, n);
    for (const op of chosen) {
      grantFreeAction(ev.state, op, {
        sourceId: SP.righteousAdvance,
        sourceText: shortQuote(text(SP.righteousAdvance)),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash'],
      });
    }
  });

  // ---- GLORIOUS MARTYRDOM (firefight, 1CP) ---------------------------------
  reg.on('onIncapacitated', T.bind(FP.gloriousMartyrdom, 20), (ev) => {
    if (ev.prevented) return;
    if (!ployUsed(ev.state, T.player, FP.gloriousMartyrdom)) return;
    if (!T.mineKw(ev.operative, KW) || !T.ctx) return;
    if (!useOncePerTP(ev.state, `novitiates.martyrdom:${T.player}`)) return;
    const flags = bucket(ev.state, MARTYRDOM_FLAG);
    flags[T.player] = true;
    // "For each enemy operative visible to and within 2" of it, you gain 1 Faith point and
    //  inflict D3 damage on that enemy operative (roll separately for each)."
    for (const enemy of [...T.enemies(ev.state)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (enemy.incapacitated) continue;
      if (T.gap(ev.operative, enemy) > 2 + 1e-6) continue;
      if (!visible(T, ev.state, ev.operative, enemy)) continue;
      gainFaith(ev.state, T.player, 1, 'Glorious Martyrdom');
      const d3 = T.ctx.rng.d3();
      recordRoll(ev.state, 'novitiates.martyrdom', [d3], T.player, `Glorious Martyrdom vs ${enemy.name}`);
      inflictDamage(T.ctx, ev.state, enemy, d3, 'other');
    }
    delete flags[T.player];
  });

  // ---- BLAZING INFERNO (firefight, 1CP) ------------------------------------
  // "…is shooting with a Ministorum flamer and you inflict damage with any critical successes.
  //  The target gains one of your Blaze tokens (if it doesn't already have one)."
  reg.on('onStrikeResolved', T.bind(FP.blazingInferno, 20), (ev) => {
    if (!ployUsed(ev.state, T.player, FP.blazingInferno)) return;
    if (ev.ctx.type !== 'ranged' || !ev.crit) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    if (!/ministorum flamer/i.test(ev.ctx.weaponName)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.damage <= 0) return;
    if (ev.struck.removed) return;
    giveToken(ev.state, ev.struck, BLAZE_TOKEN, {
      sourceId: FP.blazingInferno,
      sourceText: shortQuote(text(FP.blazingInferno)),
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
  });
  // "Whenever an operative that has one of your Blaze tokens is activated: Inflict D3 damage on
  //  it.  Its controlling player can subtract 1 from that operative's APL stat until the end of
  //  that activation to remove that token.  Note that this must be done before that operative
  //  performs any actions during that activation."
  reg.on('onActivationStart', T.bind(FP.blazingInferno, 21), (ev) => {
    if (!hasToken(ev.state, ev.operative.id, BLAZE_TOKEN, T.player) || !T.ctx) return;
    const d3 = T.ctx.rng.d3();
    recordRoll(ev.state, 'novitiates.blaze', [d3], T.player, `Blaze vs ${ev.operative.name}`);
    inflictDamage(T.ctx, ev.state, ev.operative, d3, 'other');
    if (ev.operative.incapacitated || ev.operative.removed) return;
    ev.state.pending.push({
      id: `blaze-${ev.state.seq++}`,
      who: ev.operative.player,
      kind: BLAZE_DECISION,
      prompt: `${ev.operative.name} is ablaze — subtract 1 APL this activation to remove the Blaze token?`,
      sourceText: shortQuote(text(FP.blazingInferno)),
      optional: true,
      ctx: { operativeId: ev.operative.id, owner: T.player },
      options: [
        { id: 'remove', label: 'Subtract 1 APL until the end of this activation and remove the token' },
        { id: 'keep', label: 'Keep the Blaze token' },
      ],
    });
  });
  // The doused operative belongs to the OPPONENT, so the effect names the Blaze's owner and
  // only that player's copy of this rule applies the penalty (a mirror match has both).
  reg.on('onStatMod', T.bind(FP.blazingInferno, 22), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, `${BLAZE_TOKEN}.doused`);
    if (eff && eff.data?.['owner'] === T.player) ev.mods.apl -= 1;
  });

  // ---- BLINDING AURA (firefight, 1CP) --------------------------------------
  reg.on('onPloyUsed', T.bind(FP.blindingAura, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.blindingAura) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const enemyId = (ev.data?.['enemyId'] as string | undefined) ?? active?.id;
    const enemy = enemyId ? ev.state.operatives[enemyId] : undefined;
    if (!enemy || enemy.player === T.player) return;
    const seq = shootSeq(ev.state);
    const seqTarget = seq ? ev.state.operatives[seq.targetId] : undefined;
    const named = ev.data?.['operativeId'] as string | undefined;
    const friendly =
      (named ? ev.state.operatives[named] : undefined) ??
      (seqTarget && T.mineKw(seqTarget, KW) ? seqTarget : undefined) ??
      [...T.friendlies(ev.state, KW)].sort((a, b) => T.gap(enemy, a) - T.gap(enemy, b) || (a.id < b.id ? -1 : 1))[0];
    if (!friendly) return;
    effect(ev.state, {
      rule: BLINDING_AURA,
      source: { kind: 'ploy', id: FP.blindingAura },
      sourceText: shortQuote(text(FP.blindingAura)),
      operativeId: friendly.id,
      player: T.player,
      data: { enemyId: enemy.id },
      expiry: { kind: 'endOfActivation', operativeId: enemy.id },
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Blinding Aura: ${enemy.name} cannot select ${friendly.name} beyond 2"`,
    });
  });
  reg.on('onValidTarget', T.bind(FP.blindingAura, 21), (ev) => {
    const eff = effectOn(ev.state, ev.target.id, BLINDING_AURA);
    if (!eff || eff.player !== T.player) return;
    if (eff.data?.['enemyId'] !== ev.attacker.id) return;
    if (T.gap(ev.attacker, ev.target) <= 2 + 1e-6) return; // "while … more than 2" from"
    ev.valid = false;
    ev.reason = 'Blinding Aura: that operative cannot be selected as a valid target';
  });

  // ---- GUIDED BY FAITH (firefight, 1CP) ------------------------------------
  reg.on('onPloyUsed', T.bind(FP.guidedByFaith, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.guidedByFaith) return;
    const named = ev.data?.['operativeId'] as string | undefined;
    const op =
      (named ? ev.state.operatives[named] : undefined) ??
      (ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined);
    if (!op || !T.mineKw(op, KW)) return;
    effect(ev.state, {
      rule: GUIDED,
      source: { kind: 'ploy', id: FP.guidedByFaith },
      sourceText: shortQuote(text(FP.guidedByFaith)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onWeaponRules', T.bind(FP.guidedByFaith, 21), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!effectOn(ev.state, ev.operative.id, GUIDED)) return;
    if (!ev.target || T.gap(ev.operative, ev.target) > 6 + 1e-6) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (Guided by Faith)'));
  });
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ICON OF FAITH is read directly by `resolveActDecision`, which offers a second, different
  // ACT OF FAITH once per turning point.

  // ---- SANCTIFIED ROUNDS ---------------------------------------------------
  // "Whenever a friendly NOVITIATE operative is shooting with an autogun, autopistol, relic
  //  bolt pistol or relic boltgun, if you spend a Faith point, that weapon has the Piercing
  //  Crits 1 weapon rule until the end of that sequence."
  //  A decision on every shot would drown the log, so it is auto-used on a stated policy
  //  (docs/DECISIONS.md D-022): spend a point whenever more than one is held, so it can never
  //  eat the last point an ACT OF FAITH would want.
  reg.on('onCollectAttackDice', T.bind(EQ.sanctifiedRounds, 30), (ev) => {
    if (ev.ctx.type !== 'ranged') return;
    if (!hasEquipment(ev.state, T.player, EQ.sanctifiedRounds)) return;
    if (!T.mineKw(ev.ctx.attacker, KW)) return;
    if (!SANCTIFIED_WEAPONS.some((w) => w === ev.ctx.weaponName.toLowerCase())) return;
    const b = bucket(ev.state, SANCTIFIED);
    const stamp = seqStamp(ev.state);
    if (stamp === 'none' || b[T.player] === stamp) return;
    if (faithPoints(ev.state, T.player) <= 1) return;
    if (!spendFaith(ev.state, T.player, 1, 'Sanctified Rounds')) return;
    b[T.player] = stamp;
  });
  reg.on('onWeaponRules', T.bind(EQ.sanctifiedRounds, 31), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!SANCTIFIED_WEAPONS.some((w) => w === ev.weaponName.toLowerCase())) return;
    if (bucket(ev.state, SANCTIFIED)[T.player] !== seqStamp(ev.state)) return;
    ev.rules.push(ruleTag('PiercingCrits', 1, 'Piercing Crits 1 (Sanctified Rounds)'));
  });

  // AUTO-CHASTISERS rides on the ACT OF FAITH decision window (see `offerActOfFaith`).

  // ---- HOLY EMBROCATIONS ---------------------------------------------------
  // "You can ignore any changes to the Move stat of friendly NOVITIATE operatives from being
  //  injured."  `moveOf` subtracts the 2" itself, so the equipment adds it back.
  reg.on('onStatMod', T.bind(EQ.holyEmbrocations, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.holyEmbrocations)) return;
    if (!T.mineKw(ev.operative, KW) || !T.ctx) return;
    if (!isInjured(T.ctx, ev.operative)) return;
    ev.mods.move += 2;
  });
}

const SANCTIFIED_WEAPONS = ['autogun', 'autopistol', 'relic bolt pistol', 'relic boltgun'];

// ---------------------------------------------------------------------------
// Team-owned decisions
// ---------------------------------------------------------------------------

function decisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind === ACT_DECISION) {
    resolveActDecision(ctx, state, decision, optionId, data);
    return true;
  }
  if (decision.kind === BLAZE_DECISION) {
    if (optionId !== 'remove') return true;
    const op = state.operatives[String(decision.ctx?.['operativeId'] ?? '')];
    if (!op || op.removed) return true;
    removeToken(state, op.id, BLAZE_TOKEN);
    effect(state, {
      rule: `${BLAZE_TOKEN}.doused`,
      source: { kind: 'ploy', id: FP.blazingInferno },
      sourceText: shortQuote(text(FP.blazingInferno)),
      operativeId: op.id,
      player: op.player,
      data: { owner: String(decision.ctx?.['owner'] ?? '') },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.name} smothers the Blaze token (-1 APL this activation)`,
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);

const isNovitiate = (ctx: GameContext, op: OperativeState): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW);

const seesWithin = (ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState, inches: number): boolean =>
  gapBetween(ctx, a, b) <= inches + 1e-6 && isVisible(terrain(ctx, state), body(ctx, a), body(ctx, b)).visible;

function markerGap(ctx: GameContext, op: OperativeState, marker: MarkerState): number {
  return baseGap(op.pos, card(ctx, op).base, op.rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0);
}

/** STIRRING RHETORIC's candidates: visible and within 6", or within 6" of the broadcaster. */
function rhetoricTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const reach = supportDistance(ctx, state, op, 6);
  const marker = state.markers[BROADCASTER(op.player)];
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && !o.incapacitated && isNovitiate(ctx, o))
    .filter(
      (o) =>
        seesWithin(ctx, state, op, o, reach) || (marker !== undefined && markerGap(ctx, o, marker) <= 6 + 1e-6),
    )
    .sort(byId);
}

function frenzyTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, op.player)
    .filter(
      (o) =>
        o.id !== op.id &&
        !o.incapacitated &&
        isNovitiate(ctx, o) &&
        !(ctx.datacards.get(o.datacardId)?.keywords ?? []).includes('SUPERIOR') &&
        !state.effects.some((e) => e.rule === FRENZY && e.operativeId === o.id) &&
        seesWithin(ctx, state, op, o, 3),
    )
    .sort(byId);
}

function chirurgeonTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, op.player)
    .filter(
      (o) =>
        !o.incapacitated &&
        isNovitiate(ctx, o) &&
        // "Select one friendly NOVITIATE operative within this operative's control range" —
        // unlike Medic! ("another") and STIRRING RHETORIC ("one other"), the HOSPITALLER
        // itself qualifies.
        (o.id === op.id || gapBetween(ctx, op, o) <= 1 + 1e-6) &&
        !state.effects.some((e) => e.rule === `${MEDIC_APL}.treated` && e.operativeId === o.id),
    )
    .sort(byId);
}

/** WHIP INTO FRENZY's second, free Fight action. */
export const WHIP_FIGHT = 'Fight (Whip Into Frenzy)';
/** ABSOLUTION THROUGH DESTRUCTION's free follow-up Fight actions (one per Fight). */
export const ABSOLUTION_FIGHTS = ['Fight (Absolution Through Destruction)', 'Fight (Absolution Through Destruction 2)'];

const FIGHT_ACTIONS = ['Fight', WHIP_FIGHT];

function actions(data: typeof DATA): ActionDef[] {
  const defs: ActionDef[] = [
    // STIRRING RHETORIC 1AP (SUPPORT) — DIALOGUS
    uniqueAction(data, C.dialogus, ACT_STIRRING_RHETORIC, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const targets = rhetoricTargets(ctx, state, op);
        const chosen = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        return chosen
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly NOVITIATE operative visible to and within 6"' };
      },
      perform: (ctx, state, op, params) => {
        const targets = rhetoricTargets(ctx, state, op);
        const target = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        if (!target) return { ok: false, reason: 'no eligible friendly NOVITIATE operative' };
        effect(state, {
          rule: RHETORIC,
          source: { kind: 'ability', id: ACT_STIRRING_RHETORIC },
          sourceText: shortQuote(printedAction(data, C.dialogus, ACT_STIRRING_RHETORIC)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: state.activeOperativeId !== target.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: STIRRING RHETORIC → ${target.name} (+1 APL)` });
        return { ok: true };
      },
    }),

    // AUTO-BROADCASTER 0AP — DIALOGUS
    uniqueAction(data, C.dialogus, ACT_AUTO_BROADCASTER, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const marker = state.markers[BROADCASTER(op.player)];
        const anchor = marker ? marker.pos : op.pos;
        const pos = broadcasterPos(state, op, params);
        // "place it within 8" horizontally of this operative; otherwise, move your
        //  Auto-broadcaster marker up to 8" horizontally."
        if (horizontal(anchor, pos) > 8 + 1e-6) return { ok: false, reason: 'no more than 8" horizontally' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const pos = broadcasterPos(state, op, params);
        const existing = state.markers[BROADCASTER(op.player)];
        if (existing) {
          existing.pos = { ...pos };
          existing.z = op.z;
        } else {
          placeTeamMarker(state, {
            id: BROADCASTER(op.player),
            kind: 'generic',
            player: op.player,
            pos,
            z: op.z,
            flags: { autoBroadcaster: true },
          });
        }
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: AUTO-BROADCASTER marker at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`,
        });
        return { ok: true };
      },
    }),

    // WHIP INTO FRENZY 1AP — EXACTOR
    uniqueAction(data, C.exactor, ACT_WHIP_INTO_FRENZY, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const targets = frenzyTargets(ctx, state, op);
        const chosen = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        return chosen
          ? { ok: true }
          : { ok: false, reason: 'select one other friendly NOVITIATE operative (excluding SUPERIOR) visible to and within 3"' };
      },
      perform: (ctx, state, op, params) => {
        const targets = frenzyTargets(ctx, state, op);
        const target = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        if (!target) return { ok: false, reason: 'no eligible friendly NOVITIATE operative' };
        effect(state, {
          rule: FRENZY,
          source: { kind: 'ability', id: ACT_WHIP_INTO_FRENZY },
          sourceText: shortQuote(printedAction(data, C.exactor, ACT_WHIP_INTO_FRENZY)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: state.activeOperativeId !== target.id },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.name}: WHIP INTO FRENZY → ${target.name}` });
        return { ok: true };
      },
    }),

    // CHIRURGEON'S TOOLS 1AP — HOSPITALLER
    uniqueAction(data, C.hospitaller, ACT_CHIRURGEONS_TOOLS, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const targets = chirurgeonTargets(ctx, state, op);
        const chosen = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        if (!chosen) return { ok: false, reason: 'no friendly NOVITIATE operative within control range' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const targets = chirurgeonTargets(ctx, state, op);
        const target = targets.find((o) => o.id === params.targetOperativeId) ?? targets[0];
        if (!target) return { ok: false, reason: 'no friendly NOVITIATE operative within control range' };
        const heal = ctx.rng.d3() + ctx.rng.d3(); // "regain up to 2D3 lost wounds"
        recordRoll(state, 'novitiates.chirurgeon', [heal], op.player, "Chirurgeon's Tools 2D3");
        const max = ctx.datacards.get(target.datacardId)?.wounds ?? target.wounds + heal;
        const before = target.wounds;
        target.wounds = Math.min(max, target.wounds + heal);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name}: CHIRURGEON'S TOOLS heals ${target.name} for ${target.wounds - before}`,
        });
        return { ok: true };
      },
    }),

    // RAISE ICON 1AP — RELIQUARIUS
    uniqueAction(data, C.reliquarius, ACT_RAISE_ICON, {
      check: (ctx, state, op) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        if (usedThisTP(state, `novitiates.raiseIcon:${op.id}`))
          return { ok: false, reason: 'this operative cannot perform this action more than once per turning point' };
        return { ok: true };
      },
      perform: (ctx, state, op) => {
        useOncePerTP(state, `novitiates.raiseIcon:${op.id}`);
        gainFaith(state, op.player, 1, 'Raise Icon');
        const holds = Object.values(state.markers).some(
          (m) => m.kind === 'objective' && markerController(ctx, state, m) === op.player && markerGap(ctx, op, m) <= 1 + 1e-6,
        );
        if (holds) gainFaith(state, op.player, state.turningPoint, 'Raise Icon (objective marker)');
        return { ok: true };
      },
    }),

    // WHIP INTO FRENZY's second Fight, which "can be free" (docs/DECISIONS.md D-021).
    {
      id: WHIP_FIGHT,
      name: WHIP_FIGHT,
      ap: 0,
      type: 'unique',
      sourceText: printedAction(data, C.exactor, ACT_WHIP_INTO_FRENZY),
      available: (_ctx, state, op) => state.effects.some((e) => e.rule === FRENZY && e.operativeId === op.id),
      check(ctx, state, op, params) {
        if (!state.effects.some((e) => e.rule === FRENZY && e.operativeId === op.id))
          return { ok: false, reason: 'this operative is not benefitting from Whip Into Frenzy' };
        if (!op.actionsThisActivation.includes('Fight'))
          return { ok: false, reason: 'this is the second of the two Fight actions' };
        return getAction('Fight')!.check(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
    },
  ];

  // ABSOLUTION THROUGH DESTRUCTION: "…it can immediately perform a free Fight action
  // afterwards. This takes precedence over action restrictions, and you cannot perform more
  // than two Fight actions in succession as a result of this rule."  Action restrictions are
  // keyed on the action id, so each link is its own id (the Deathwatch Phase Sweep precedent).
  ABSOLUTION_FIGHTS.forEach((id, link) => {
    defs.push({
      id,
      name: id,
      ap: 0,
      type: 'unique',
      sourceText: abilityText(C.penitent, A.absolution),
      available: (_ctx, _state, op) => op.datacardId === C.penitent,
      check(ctx, state, op, params) {
        if (op.incapacitated || op.removed) return { ok: false, reason: 'this operative is incapacitated' };
        const fights = op.actionsThisActivation.filter((a) => FIGHT_ACTIONS.includes(a)).length;
        const frees = op.actionsThisActivation.filter((a) => ABSOLUTION_FIGHTS.includes(a)).length;
        if (frees !== link) return { ok: false, reason: 'Absolution Through Destruction follows each Fight action once' };
        if (fights < link + 1) return { ok: false, reason: 'it must follow a Fight action' };
        const last = op.actionsThisActivation[op.actionsThisActivation.length - 1];
        if (last !== undefined && ABSOLUTION_FIGHTS.includes(last))
          return { ok: false, reason: 'you cannot perform more than two Fight actions in succession' };
        return getAction('Fight')!.check(ctx, state, op, params);
      },
      perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
    });
  });

  return defs;
}

function printedAction(data: typeof DATA, cardId: string, actionId: string): string {
  const card = data.datacards.find((c) => c.id === cardId)!;
  return card.uniqueActions.find((a) => a.id === actionId)!.text;
}

/** D-016: the position comes from the intent's `data`, with a deterministic logged default. */
function broadcasterPos(state: GameState, op: OperativeState, params: { markerPos?: { x: number; y: number }; targetPos?: { x: number; y: number }; data?: Record<string, unknown> }) {
  return posFromData(
    { pos: params.markerPos ?? params.targetPos ?? (params.data?.['pos'] as { x: number; y: number } | undefined) },
    op.pos,
  );
}

// ---------------------------------------------------------------------------

export const novitiates = defineTeam({
  id: 'novitiates',
  rareRules: ['AntiPSYKER', 'Riposte', 'ZealousRage'],
  rules: (reg, T) => {
    rules(reg, T);
    // The team owns two decision kinds (ACT OF FAITH, Blaze token); the handler is installed
    // once per GameContext — `decisionHandler` is a stable reference.
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
    // "You cannot use this ploy during the first turning point."
    reg.on('gambitOptions', T.bind(SP.righteousAdvance, 60), (ev) => {
      if (ev.player !== T.player || ev.state.turningPoint > 1) return;
      ev.options = ev.options.filter((o) => o.id !== SP.righteousAdvance);
    });
  },
  ployUsable: {
    // "You cannot use this ploy during the first turning point."
    [SP.righteousAdvance]: (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
    // "Use this firefight ploy when a friendly NOVITIATE operative is incapacitated, before
    //  it's removed from the killzone."  The trigger is inside `onIncapacitated`, which the
    //  reducer cannot be re-entered from, so the ploy is declared in advance and fires on the
    //  next friendly casualty — the Celestian GLORY TO THE MARTYRS shape.  There is nothing to
    //  gate on, so `usable` would only make the ploy unreachable.
    //
    // "Use this firefight ploy when a friendly NOVITIATE operative is shooting with a
    //  Ministorum flamer…" — same: the payout is inside the shoot sequence, so the gate is
    //  only that the kill team can produce that shot at all.
    [FP.blazingInferno]: (state, player) => {
      const seq = state.sequence;
      if (seq?.kind === 'shoot' && seq.attacker === player)
        return /ministorum flamer/i.test(seq.weaponName)
          ? { ok: true }
          : { ok: false, reason: 'that operative is not shooting with a Ministorum flamer' };
      const flamer = Object.values(state.operatives).some(
        (o) => o.player === player && !o.removed && o.datacardId === C.purgatus,
      );
      return flamer ? { ok: true } : { ok: false, reason: 'no friendly operative has a Ministorum flamer' };
    },
    // "Use this firefight ploy when an enemy operative is performing the Shoot action and
    //  selects a friendly NOVITIATE operative as the valid target."
    [FP.blindingAura]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player === player)
        return { ok: false, reason: 'use this ploy during an enemy operative’s Shoot action' };
      return { ok: true };
    },
    // "Use this firefight ploy when a friendly NOVITIATE operative is performing the Shoot
    //  action and you're selecting a ranged weapon."
    [FP.guidedByFaith]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player)
        return { ok: false, reason: 'use this ploy during a friendly operative’s Shoot action' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [C.superior]: 'leader',
      [C.condemnor]: 'sniper',
      [C.dialogus]: 'support',
      [C.duellist]: 'melee',
      [C.exactor]: 'support',
      [C.hospitaller]: 'support',
      [C.militant]: 'gunner',
      [C.penitent]: 'melee',
      [C.preceptor]: 'melee',
      [C.pronatus]: 'objective',
      [C.purgatus]: 'gunner',
      [C.reliquarius]: 'objective',
    },
    ployValue: {
      [SP.ardentVengeance]: 0.5,
      [SP.defendersOfTheFaith]: 0.5,
      [SP.blessedRejuvenation]: 0.4,
      [SP.righteousAdvance]: 0.5,
      [FP.gloriousMartyrdom]: 0.5,
      [FP.blazingInferno]: 0.5,
      [FP.blindingAura]: 0.4,
      [FP.guidedByFaith]: 0.6,
    },
    equipmentValue: {
      [EQ.iconOfFaith]: 0.6,
      [EQ.sanctifiedRounds]: 0.4,
      [EQ.autoChastisers]: 0.5,
      [EQ.holyEmbrocations]: 0.4,
    },
  },
});

export default novitiates;
