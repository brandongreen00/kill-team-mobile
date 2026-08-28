/**
 * FARSTALKER KINBAND — T'au Empire (Kroot).
 * https://wahapedia.ru/kill-team3/kill-teams/farstalker-kinband/
 *
 * Every hook carries a verbatim quote of the printed rule in its `RuleBinding`; the text is
 * read from `data/teams/farstalker-kinband.json` and is never retyped.
 *
 * Three things shape the module:
 *
 *  - **Farstalker** is two order-change clauses. The Ready-step half raises a REAL
 *    `PendingDecision` (the Hierotek Reanimation Protocols precedent — the Ready step is the
 *    one pre-Firefight moment the engine can ask a question), repeated until the player
 *    declines or three operatives have changed order. The counteract half is a 1AP
 *    `Change Order (Farstalker)` action, because the engine has no "counteract without
 *    selecting an operative" channel.
 *  - **Six unique actions**, and docs/DECISIONS.md D-026 puts their whole legality in `check`.
 *  - **Two rare weapon rules**: `Concealed Position` is a PROFILE-level restriction carried by
 *    `onSelectWeapon` (D-032, the spectre-squad / death-korps precedent) and `Salvo` is a
 *    second free Shoot action at a different target (D-100 + D-021).
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { supportDistance } from '../../core/equipment/index.ts';
import { devastatingDamage, hasRule, successes } from '../../core/dice.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove, type MoveOptions } from '../../core/movement.ts';
import { advanceFight, startFight } from '../../core/sequences/fight.ts';
import { checkTarget, effectiveRules } from '../../core/sequences/shoot.ts';
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
  isInjured,
  isWounded,
  log,
  markerContestedBy,
  recordRoll,
  weaponsOf,
} from '../../core/state.ts';
import { baseDistanceToPart, hasType, surfaceAt } from '../../core/terrain.ts';
import type {
  Datacard,
  GameState,
  MarkerState,
  OperativeState,
  PendingDecision,
  PlayerId,
  TerrainType,
  Vec2,
  WeaponProfile,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { isVisible, type Body } from '../../core/visibility.ts';
import type { ActionParams } from '../../core/intents.ts';
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
  notEngaged,
  placeTeamMarker,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('farstalker-kinband');
const EPS = 1e-6;

export const KW = 'FARSTALKER KINBAND';

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

/** Datacard ids the printed rules name. */
export const C = {
  killBroker: 'farstalker-kinband.kroot-kill-broker',
  bowHunter: 'farstalker-kinband.kroot-bow-hunter',
  coldBlood: 'farstalker-kinband.kroot-cold-blood',
  cutSkin: 'farstalker-kinband.kroot-cut-skin',
  heavyGunner: 'farstalker-kinband.kroot-heavy-gunner',
  hound: 'farstalker-kinband.kroot-hound',
  longSight: 'farstalker-kinband.kroot-long-sight',
  pistolier: 'farstalker-kinband.kroot-pistolier',
  stalker: 'farstalker-kinband.kroot-stalker',
  tracker: 'farstalker-kinband.kroot-tracker',
  warrior: 'farstalker-kinband.kroot-warrior',
} as const;

export const RULE = { farstalker: 'farstalker-kinband.rule.farstalker' } as const;

export const SP = {
  cutThroats: 'farstalker-kinband.sp.cut-throats',
  prey: 'farstalker-kinband.sp.prey',
  rogue: 'farstalker-kinband.sp.rogue',
  bound: 'farstalker-kinband.sp.bound',
} as const;

export const FP = {
  savageAmbush: 'farstalker-kinband.fp.savage-ambush',
  poach: 'farstalker-kinband.fp.poach',
  slipAway: 'farstalker-kinband.fp.slip-away',
  vengeance: 'farstalker-kinband.fp.vengeance-for-the-kinband',
} as const;

export const EQ = {
  piercingShot: 'farstalker-kinband.eq.piercing-shot',
  meat: 'farstalker-kinband.eq.meat',
  toxinShot: 'farstalker-kinband.eq.toxin-shot',
  trophy: 'farstalker-kinband.eq.trophy',
} as const;

export const AB = {
  callTheKill: `${C.killBroker}.call-the-kill`,
  victoryShriek: `${C.killBroker}.victory-shriek`,
  hardy: `${C.coldBlood}.hardy`,
  coldBlooded: `${C.coldBlood}.cold-blooded`,
  viciousDuellist: `${C.cutSkin}.vicious-duellist`,
  savageAssault: `${C.cutSkin}.savage-assault`,
  beast: `${C.hound}.beast`,
  badTempered: `${C.hound}.bad-tempered`,
  concealedPosition: `${C.longSight}.concealed-position`,
  quickDraw: `${C.pistolier}.quick-draw`,
  salvo: `${C.pistolier}.salvo`,
  stalker: `${C.stalker}.stalker`,
  readyForAnything: `${C.warrior}.ready-for-anything`,
} as const;

export const ACT = {
  energise: `${C.bowHunter}.act.energise`,
  gather: `${C.hound}.act.gather`,
  longSight: `${C.longSight}.act.long-sight`,
  markedForTheHunt: `${C.tracker}.act.marked-for-the-hunt`,
  fromTheEyeAbove: `${C.tracker}.act.from-the-eye-above`,
  stealthAttack: `${C.stalker}.act.stealth-attack`,
} as const;

/** Extra `ActionDef`s the universal actions forbid (docs/DECISIONS.md D-021). */
export const CHANGE_ORDER_COUNTERACT = 'Change Order (Farstalker)';
export const POACH_PICK_UP = 'Pick Up Marker (Poach)';
export const STALKER_CHARGE = 'Charge (Stalker)';
export const SAVAGE_FIGHT = 'Fight (Savage Assault)';
export const QUICK_DRAW_SHOOT = 'Shoot (Quick Draw)';
export const SALVO_SHOOT = 'Shoot (Salvo)';
export const BOUND_REPOSITION = 'Reposition (Bound)';
export const BOUND_CHARGE = 'Charge (Bound)';
export const BOUND_FALL_BACK = 'Fall Back (Bound)';

/** The decision kind the Ready-step half of Farstalker raises. */
export const ORDER_DECISION = 'farstalker.readyOrders';

/** Effect rule names — namespaced scratch, never module-level state (architecture rule 7). */
export const E = {
  mark: 'farstalker.mark',
  victoryShriek: 'farstalker.victoryShriek',
  vengeance: 'farstalker.vengeance',
  poach: 'farstalker.poach',
  slipAway: 'farstalker.slipAway',
  energise: 'farstalker.energise',
  trophy: 'farstalker.trophy',
  eyeAbove: 'farstalker.eyeAbove',
  longSight: 'farstalker.longSight',
  ammo: 'farstalker.ammo',
  quickDraw: 'farstalker.quickDraw',
  salvo: 'farstalker.salvo',
  stealthStrike: 'farstalker.stealthStrike',
} as const;

/**
 * Clauses with no honest expression on the current hook surface. Exported so the tests can
 * pin the reason, and so `docs/TEAM-STATUS.md` and the module can never drift apart.
 */
export const REMINDER_ONLY: Record<string, string> = {
  [`${AB.badTempered}.taunt`]:
    'a Fight takes its target from the intent and nothing is emitted before startFight, so there is no target-substitution seam for fights (onSelectTarget is shoot-only)',
  [`${AB.badTempered}.charge`]:
    'no hook constrains where a move ENDS, so "must end that move within control range of that enemy operative" is not enforced',
  [ACT.longSight]:
    'the printed effect list is truncated out of the JSON (the text ends at "Until the start of this operative’s next activation:")',
  [`${ACT.gather}.remainder`]:
    'a move is atomic inside validateMove, so "any remaining move distance … can be used after it does so" cannot be split around the marker action',
  [`${AB.beast}.melee`]:
    'weaponsOf appends granted weapons AFTER availableWeapons filters the datacard, and startFight picks the defender’s melee weapon with no hook, so the ban reaches ranged weapons only (every weapon the engine can grant today is ranged)',
  [`${FP.poach}.mission`]:
    'mission actions are ActionDefs owned by src/core/ops/**, which a team module cannot wrap',
  [`${ACT.stealthAttack}.block`]:
    'the engine builds the strike/block options, so the extra resolution is taken as a strike rather than offered as a choice',
};

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;
const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);
const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);
const hasKw = (ctx: GameContext, op: OperativeState, keyword: string): boolean =>
  (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(keyword);
const aliveOf = (state: GameState, player: PlayerId): OperativeState[] =>
  aliveOperatives(state, player).filter((o) => !o.incapacitated);
const engagedWith = (ctx: GameContext, state: GameState, op: OperativeState): boolean =>
  enemiesInControlRange(ctx, state, op).length > 0;
const flip = (order: OperativeState['order']): OperativeState['order'] => (order === 'engage' ? 'conceal' : 'engage');

/** "…has Light or Heavy terrain within its control range" / "within 1" of Light or Heavy terrain". */
function terrainWithin(
  T: TeamHooks,
  state: GameState,
  op: OperativeState,
  inches: number,
  types: TerrainType[],
): boolean {
  if (!T.ctx) return false;
  const index = terrain(T.ctx, state);
  const base = T.card(op)?.base ?? { shape: 'round' as const, mm: 28 };
  return index.parts.some(
    (p) => types.some((t) => hasType(p, t)) && baseDistanceToPart(op.pos, base, op.rot, p) <= inches + EPS,
  );
}

/** The enemy operative that put a friendly one down, from the sequence in flight. */
function incapacitatorOf(state: GameState, victim: OperativeState): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  const ids = seq.kind === 'shoot' ? [seq.attackerId] : [seq.attackerId, seq.defenderId];
  return ids
    .map((id) => state.operatives[id])
    .find((o): o is OperativeState => o !== undefined && o.player !== victim.player);
}

/**
 * The universal Shoot action's `check` never runs the Select Valid Target step, so a delegating
 * action has to (D-026: whatever `check` accepts, `perform` must be able to complete).
 */
function targetIsValid(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  weaponName: string,
  profileName: string,
  targetId: string,
): { ok: boolean; reason?: string } {
  const target = state.operatives[targetId];
  if (!target || target.removed) return { ok: false, reason: 'that enemy operative is no longer in the killzone' };
  const w = weaponsOf(ctx, state, op, 'ranged').find((x) => x.name === weaponName);
  const profile = w ? findProfile(w, profileName) : undefined;
  if (!w || !profile) return { ok: false, reason: `no ranged weapon '${weaponName}'` };
  const rules = effectiveRules(ctx, state, profile, { operative: op, target, weaponName });
  const chk = checkTarget(ctx, state, op, target, profile, rules);
  return chk.valid ? { ok: true } : { ok: false, reason: chk.reason ?? 'not a valid target' };
}

/** The profile a sequence is using, without re-emitting `onWeaponRules`. */
function sequenceProfile(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  name: string,
  profileName: string | undefined,
  type: 'ranged' | 'melee',
): WeaponProfile | undefined {
  const list = weaponsOf(ctx, state, op, type);
  const w = list.find((x) => x.name === name) ?? list[0];
  return w ? findProfile(w, profileName) : undefined;
}

// ---------------------------------------------------------------------------
// Farstalker — the order-change decision (Ready step)
// ---------------------------------------------------------------------------

/**
 * "In the Ready step of each Strategy phase, you can change the order of up to three friendly
 * FARSTALKER KINBAND operatives that are not within control range of enemy operatives."
 *
 * There is no data channel on `onReadyStep`, so the choice is a real `PendingDecision` answered
 * through `GameContext.decisionHandlers`. "Change no (more) orders" is the FIRST option, so the
 * deterministic default (`defaultDecisionOption`, and the test harness's `settle`) declines —
 * the Legionary "Not yet" precedent. Declining ends the offer, so a bot game sees exactly one
 * decision per Ready step rather than three.
 */
function orderChangeCandidates(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  done: string[],
): OperativeState[] {
  return aliveOf(state, player)
    .filter((o) => hasKw(ctx, o, KW))
    .filter((o) => !done.includes(o.id))
    .filter((o) => !engagedWith(ctx, state, o))
    .sort(byId);
}

function offerOrderChange(ctx: GameContext, state: GameState, player: PlayerId, done: string[]): void {
  if (done.length >= 3) return; // "up to three friendly FARSTALKER KINBAND operatives"
  const candidates = orderChangeCandidates(ctx, state, player, done);
  if (candidates.length === 0) return;
  const options: PendingDecision['options'] = [
    { id: 'none', label: 'Change no (more) orders', data: { done } },
    ...candidates.map((o) => ({
      id: o.id,
      label: `Change ${o.letter}'s order to ${flip(o.order) === 'engage' ? 'Engage' : 'Conceal'}`,
      data: { operativeId: o.id, done },
    })),
  ];
  state.pending.push({
    id: `farstalker-order-${state.seq++}`,
    who: player,
    kind: ORDER_DECISION,
    prompt: `Farstalker: change the order of up to three operatives (${3 - done.length} left)`,
    optional: true,
    sourceText: shortQuote(text(RULE.farstalker)),
    options,
  });
  log(state, {
    kind: 'decision',
    player,
    text: 'Farstalker: change up to three operatives’ orders',
    data: { kind: ORDER_DECISION },
  });
}

function orderDecisionHandler(
  ctx: GameContext,
  state: GameState,
  decision: PendingDecision,
  optionId: string,
  data?: Record<string, unknown>,
): boolean {
  if (decision.kind !== ORDER_DECISION) return false;
  const option = decision.options.find((o) => o.id === optionId);
  const payload = { ...(option?.data ?? {}), ...(data ?? {}) };
  const done = [...((payload['done'] as string[] | undefined) ?? [])];
  const id = typeof payload['operativeId'] === 'string' ? payload['operativeId'] : undefined;
  if (optionId === 'none' || !id) return true;
  const op = state.operatives[id];
  if (!op || op.removed || op.player !== decision.who) return true;
  if (engagedWith(ctx, state, op)) return true;
  op.order = flip(op.order);
  done.push(op.id);
  log(state, {
    kind: 'action',
    player: decision.who,
    text: `Farstalker: ${op.letter} changes its order to ${op.order}`,
    data: { operativeId: op.id, order: op.order },
  });
  offerOrderChange(ctx, state, decision.who, done);
  return true;
}

/** The friendly operative whose order the counteract half of Farstalker changes. */
function orderChangeTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  requested: string | undefined,
): OperativeState | undefined {
  const candidates = orderChangeCandidates(ctx, state, op.player, []);
  if (requested !== undefined) return candidates.find((o) => o.id === requested);
  return candidates.find((o) => o.id === op.id) ?? candidates[0];
}

// ---------------------------------------------------------------------------
// Call The Kill — "your mark for the turning point"
// ---------------------------------------------------------------------------

export function markOf(state: GameState, player: PlayerId): string | undefined {
  const eff = state.effects.find((e) => e.rule === E.mark && e.player === player);
  const id = eff?.data?.['operativeId'];
  return typeof id === 'string' ? id : undefined;
}

function setMark(state: GameState, player: PlayerId, enemy: OperativeState | undefined): void {
  dropEffects(state, (e) => e.rule === E.mark && e.player === player);
  if (!enemy) return;
  effect(state, {
    rule: E.mark,
    source: { kind: 'ability', id: AB.callTheKill },
    sourceText: shortQuote(abilityText(C.killBroker, AB.callTheKill)),
    player,
    data: { operativeId: enemy.id },
    expiry: { kind: 'endOfTurningPoint' }, // "…to be your mark for the turning point"
  });
  log(state, {
    kind: 'ploy',
    player,
    text: `Call The Kill: ${enemy.letter} is the mark`,
    data: { operativeId: enemy.id },
  });
}

// ---------------------------------------------------------------------------
// Piercing Shot / Toxin Shot / Meat — the once-per-turning-point ammunition rules
// ---------------------------------------------------------------------------

/** "…you select a Kroot rifle, Kroot scattergun or dual Kroot pistols (focused)". */
export function ammoWeapon(weaponName: string, profileName: string | undefined): boolean {
  const n = weaponName.trim().toLowerCase();
  if (n === 'kroot rifle' || n === 'kroot scattergun') return true;
  return n === 'dual kroot pistols' && (profileName ?? '') === 'focused';
}

const equipmentKey = (player: PlayerId, id: string): string => `farstalker.${id}:${player}`;
const READY_KEY = (player: PlayerId): string => `farstalker.readyForAnything:${player}`;

/**
 * WARRIOR › Ready for Anything: "Once per turning point, during a friendly WARRIOR operative's
 * activation, you can use the Meat, Piercing Shot or Toxin Shot rule for that operative. Doing
 * so doesn't count for its once per turning point limit." Consumed only when the equipment's
 * own once-per-turning-point use is already spent.
 */
function readyForAnythingReady(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.ctx || op.player !== T.player) return false;
  if (!hasKw(T.ctx, op, 'WARRIOR')) return false;
  if (state.activeOperativeId !== op.id) return false;
  return !usedThisTP(state, READY_KEY(T.player));
}

/**
 * D-022 policy for the two ammunition rules, which are free and mutually exclusive within one
 * action: TOXIN SHOT goes first (Lethal 5+ changes more dice than one defence die) unless the
 * profile already has Lethal, in which case PIERCING SHOT is taken instead. Each is used once
 * per turning point, so the other lands on the kill team's next qualifying Shoot action.
 */
function chooseAmmunition(T: TeamHooks, state: GameState, op: OperativeState, weaponName: string, profile: WeaponProfile): void {
  if (!T.mineKw(op, KW)) return;
  if (!ammoWeapon(weaponName, profile.name)) return;
  dropEffects(state, (e) => e.rule === E.ammo && e.operativeId === op.id);
  const held = (id: string): boolean => hasEquipment(state, T.player, id);
  const lethalAlready = profile.rules.some((r) => r.id === 'Lethal');
  const order = lethalAlready ? [EQ.piercingShot, EQ.toxinShot] : [EQ.toxinShot, EQ.piercingShot];
  let pick = order.find((id) => held(id) && !usedThisTP(state, equipmentKey(T.player, id)));
  let viaReady = false;
  if (!pick && readyForAnythingReady(T, state, op)) {
    pick = order.find(held);
    viaReady = pick !== undefined;
  }
  if (!pick) return;
  if (viaReady) useOncePerTP(state, READY_KEY(T.player));
  else useOncePerTP(state, equipmentKey(T.player, pick));
  effect(state, {
    rule: E.ammo,
    source: { kind: 'equipment', id: pick },
    sourceText: shortQuote(text(pick)),
    operativeId: op.id,
    player: T.player,
    data: { equipmentId: pick, weaponName },
    // "…until the end of that action": an operative performs at most one Shoot action per
    // activation, so the activation is the closest expiry the engine offers.
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
  log(state, {
    kind: 'action',
    player: T.player,
    text: `${op.letter} loads ${pick === EQ.piercingShot ? 'Piercing Shot' : 'Toxin Shot'}${viaReady ? ' (Ready for Anything)' : ''}`,
    data: { operativeId: op.id, equipmentId: pick },
  });
}

const ammoInUse = (state: GameState, op: OperativeState, weaponName: string, equipmentId: string): boolean => {
  const eff = effectOn(state, op.id, E.ammo);
  return Boolean(eff && eff.data?.['equipmentId'] === equipmentId && eff.data?.['weaponName'] === weaponName);
};

// ---------------------------------------------------------------------------
// ENERGISE — "until this operative has shot with its accelerator bow"
// ---------------------------------------------------------------------------

const BOW = 'Accelerator bow';

/** Identity of the Shoot action a sequence belongs to, so a grant survives Blast secondaries. */
function shotKey(state: GameState, attackerId: string, weaponName: string): string {
  return `${state.turningPoint}:${state.activationsThisTP}:${attackerId}:${weaponName}`;
}

// ---------------------------------------------------------------------------
// The Pech'ra marker
// ---------------------------------------------------------------------------

export const PECHRA_MARKER = (player: PlayerId): string => `farstalker.pechra.${player}`;

export function pechraMarker(state: GameState, player: PlayerId): MarkerState | undefined {
  return state.markers[PECHRA_MARKER(player)];
}

/** "…visible to this operative, or on Vantage terrain of a terrain feature that's visible." */
function markerVisibleFrom(ctx: GameContext, state: GameState, op: OperativeState, pos: Vec2): boolean {
  const index = terrain(ctx, state);
  const marker: Body = {
    id: 'pechra',
    pos,
    z: surfaceAt(index, pos),
    rot: 0,
    base: { shape: 'round', mm: 20 },
    height: 0.2,
  };
  return isVisible(index, body(ctx, op), marker).visible;
}

function pechraSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string; pos?: Vec2 } {
  const requested = params.targetPos ?? params.markerPos;
  if (requested) {
    return markerVisibleFrom(ctx, state, op, requested)
      ? { ok: true, pos: { ...requested } }
      : { ok: false, reason: 'that location is not visible to this operative' };
  }
  // D-016: no position supplied, so a deterministic, logged default — the nearest visible enemy
  // operative (the marker then sits inside its control range), else this operative's own spot.
  const seen = aliveOf(state, otherPlayer(op.player))
    .filter((e) => markerVisibleFrom(ctx, state, op, e.pos))
    .sort((a, b) => gapBetween(ctx, op, a) - gapBetween(ctx, op, b) || (a.id < b.id ? -1 : 1));
  return { ok: true, pos: { ...(seen[0]?.pos ?? op.pos) } };
}

// ---------------------------------------------------------------------------
// BOUND — the climb-discounted move actions
// ---------------------------------------------------------------------------

const BOUND_KEY = 'farstalker.bound';

function boundUsedThisActivation(state: GameState, op: OperativeState): boolean {
  return (bucket(state, BOUND_KEY) as Record<string, string>)[op.id] === activationStamp(state);
}
function markBoundUsed(state: GameState, op: OperativeState): void {
  (bucket(state, BOUND_KEY) as Record<string, string>)[op.id] = activationStamp(state);
}
const activationStamp = (state: GameState): string => `${state.turningPoint}:${state.activationsThisTP}`;

/**
 * `applyMove` is private to `src/core/actions.ts`, so an action that validates its own move has
 * to repeat the two things it does besides writing the position: a carried marker travels with
 * its operative, and it drops Guard. `checkMines` is also private and is NOT repeated — a mine
 * therefore does not trigger under a BOUND or STEALTH ATTACK move (the same consequence the
 * Murderwing BOOST and the Hearthkyn KNUX SMASH charge already carry).
 */
function finishCustomMove(state: GameState, op: OperativeState, endPos: Vec2, endZ: number, endRot?: number): void {
  op.pos = { ...endPos };
  op.z = endZ;
  if (endRot !== undefined) op.rot = endRot;
  op.onGuard = false;
  if (op.carryingMarkerId) {
    const m = state.markers[op.carryingMarkerId];
    if (m) {
      m.pos = { ...op.pos };
      m.z = op.z;
    }
  }
}

interface BoundSpec {
  id: string;
  base: 'Reposition' | 'Charge' | 'Fall Back';
}

const BOUND_SPECS: BoundSpec[] = [
  { id: BOUND_REPOSITION, base: 'Reposition' },
  { id: BOUND_CHARGE, base: 'Charge' },
  { id: BOUND_FALL_BACK, base: 'Fall Back' },
];

function boundMoveOptions(state: GameState, op: OperativeState, base: BoundSpec['base']): MoveOptions {
  const counteracting = state.opState['counteract']?.['operativeId'] === op.id;
  const common = counteracting ? { hardCap: 2 } : {};
  if (base === 'Charge')
    return { action: 'Charge', bonusInches: 2, mayEnterEnemyControlRange: true, mustFinishEngaged: true, ...common };
  if (base === 'Fall Back')
    return { action: 'Fall Back', mayEnterEnemyControlRange: true, mustNotFinishEngaged: true, ...common };
  return { action: 'Reposition', mustNotFinishEngaged: true, ...common };
}

function boundPreconditions(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  base: BoundSpec['base'],
): { ok: boolean; reason?: string } {
  if (base === 'Fall Back') {
    if (!engagedWith(ctx, state, op)) return { ok: false, reason: 'no enemy operative within control range' };
    if (did(op, 'Reposition') || did(op, 'Charge'))
      return { ok: false, reason: 'already performed Reposition or Charge this activation' };
    return { ok: true };
  }
  if (engagedWith(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
  if (base === 'Charge') {
    // The STALKER "can perform the Charge action while it has a Conceal order".
    if (op.order === 'conceal' && op.datacardId !== C.stalker)
      return { ok: false, reason: 'cannot Charge with a Conceal order' };
    if (did(op, 'Reposition') || did(op, 'Dash') || did(op, 'Fall Back'))
      return { ok: false, reason: 'already performed Reposition, Dash or Fall Back this activation' };
    return { ok: true };
  }
  if (did(op, 'Fall Back') || did(op, 'Charge'))
    return { ok: false, reason: 'already performed Fall Back or Charge this activation' };
  return { ok: true };
}

/**
 * "…you can ignore the first vertical distance of 2" they move during one climb up."
 *
 * `onMoveRules.ignoreClimbCost` is declared but never emitted and `validateMove` keeps its legs
 * to itself, so BOUND is three sibling `ActionDef`s (the Murderwing BOOST precedent, D-021).
 * The path is validated twice: once with the full 2" to discover the climb leg, then again
 * with exactly the ignored vertical distance as the allowance.
 */
function boundValidate(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  base: BoundSpec['base'],
): { ok: boolean; reason?: string; endPos?: Vec2; endZ?: number; total?: number; ignored?: number } {
  if (!gambitUsed(state, op.player, SP.bound)) return { ok: false, reason: 'BOUND has not been used this turning point' };
  if (boundUsedThisActivation(state, op))
    return { ok: false, reason: 'BOUND has already been used during this activation' };
  const pre = boundPreconditions(ctx, state, op, base);
  if (!pre.ok) return pre;
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const opts = boundMoveOptions(state, op, base);
  const bonus = opts.bonusInches ?? 0;
  const probe = validateMove(ctx, state, op, params.path, { ...opts, bonusInches: bonus + 2 });
  if (!probe.ok) return { ok: false, reason: probe.reason ?? 'illegal move' };
  const climb = probe.legs.find((l) => l.kind === 'climb');
  if (!climb) return { ok: false, reason: 'this move includes no climb up' };
  const ignored = Math.min(2, climb.charged);
  const v = validateMove(ctx, state, op, params.path, { ...opts, bonusInches: bonus + ignored });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  return { ok: true, endPos: v.endPos, endZ: v.endZ, total: v.total, ignored };
}

function boundAction(spec: BoundSpec): ActionDef {
  return {
    id: spec.id,
    name: spec.id,
    ap: spec.base === 'Fall Back' ? 2 : 1,
    type: 'unique',
    treatedAs: spec.base,
    sourceText: text(SP.bound),
    available: (ctx, state, op) => hasKw(ctx, op, KW) && gambitUsed(state, op.player, SP.bound),
    check: (ctx, state, op, params) => {
      const v = boundValidate(ctx, state, op, params, spec.base);
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
    },
    perform: (ctx, state, op, params) => {
      const v = boundValidate(ctx, state, op, params, spec.base);
      if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
      finishCustomMove(state, op, v.endPos!, v.endZ!, params.path?.endRot);
      if (spec.base === 'Charge') {
        op.stickyEngagedWith = aliveOf(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
      }
      markBoundUsed(state, op);
      log(state, {
        kind: 'action',
        player: op.player,
        text: `${op.letter} performs ${spec.id} (${v.total!}", ignoring ${v.ignored!}" of one climb up)`,
        data: { operativeId: op.id, action: spec.id, inches: v.total },
      });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // =========================================================================
  // Farstalker (faction rule)
  // =========================================================================
  // "In the Ready step of each Strategy phase, you can change the order of up to three friendly
  //  FARSTALKER KINBAND operatives that are not within control range of enemy operatives."
  reg.on('onReadyStep', T.bind(RULE.farstalker, 10), (ev) => {
    if (ev.player !== T.player || !T.ctx) return;
    offerOrderChange(T.ctx, ev.state, T.player, []);
  });
  // The counteract half is the `Change Order (Farstalker)` action registered below.

  // =========================================================================
  // KILL-BROKER › Call The Kill
  // =========================================================================
  // "STRATEGIC GAMBIT if this operative is in the killzone. Select one enemy operative to be
  //  your mark for the turning point."
  reg.on('gambitOptions', T.bind(AB.callTheKill, 15), (ev) => {
    if (ev.player !== T.player) return;
    if (!T.friendlies(ev.state).some((o) => o.datacardId === C.killBroker)) return;
    if (T.enemies(ev.state).length === 0) return;
    ev.options.push({
      id: AB.callTheKill,
      label: 'Call The Kill (STRATEGIC GAMBIT)',
      sourceText: shortQuote(abilityText(C.killBroker, AB.callTheKill)),
    });
  });
  reg.on('onPloyUsed', T.bind(AB.callTheKill, 16), (ev) => {
    if (ev.player !== T.player || ev.ployId !== AB.callTheKill) return;
    setMark(ev.state, T.player, chosenOperative(ev.state, ev.data, T.enemies(ev.state)));
  });
  // "Whenever a friendly FARSTALKER KINBAND operative is shooting against, fighting against or
  //  retaliating against your mark, that friendly operative's weapons have the Balanced weapon
  //  rule." `onWeaponRules` is emitted by BOTH sequences (fight.ts reads it through
  //  `sideWeapon`), so all three halves are live.
  reg.on('onWeaponRules', T.bind(AB.callTheKill, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    if (markOf(ev.state, T.player) !== ev.target.id) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Call The Kill)'));
  });

  // =========================================================================
  // KILL-BROKER › Victory Shriek  (bound BEFORE the re-mark, so it sees the old mark)
  // =========================================================================
  // "Whenever your mark is incapacitated, you can select one friendly FARSTALKER KINBAND
  //  operative within 6" of this operative. Until the end of the battle, that operative's
  //  weapons have the Balanced weapon rule. Each friendly operative can only be selected for
  //  this rule once per battle."
  reg.on('onIncapacitated', T.bind(AB.victoryShriek, 12), (ev) => {
    if (ev.prevented || markOf(ev.state, T.player) !== ev.operative.id) return;
    const broker = T.friendlies(ev.state).find((o) => o.datacardId === C.killBroker);
    if (!broker) return;
    const pick = T.friendlies(ev.state, KW)
      .filter((o) => !effectOn(ev.state, o.id, E.victoryShriek))
      .filter((o) => T.gap(o, broker) <= 6 + EPS)
      .sort(byId)[0];
    if (!pick) return;
    effect(ev.state, {
      rule: E.victoryShriek,
      source: { kind: 'ability', id: AB.victoryShriek },
      sourceText: shortQuote(abilityText(C.killBroker, AB.victoryShriek)),
      operativeId: pick.id,
      player: T.player,
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Victory Shriek: ${pick.letter}'s weapons have Balanced for the battle`,
      data: { operativeId: pick.id },
    });
  });
  reg.on('onWeaponRules', T.bind(AB.victoryShriek, 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (!effectOn(ev.state, ev.operative.id, E.victoryShriek)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Victory Shriek)'));
  });
  // "Whenever your mark is incapacitated, you can select a new enemy operative to be your mark
  //  for the turning point (and can continue to do so during this turning point)."
  reg.on('onIncapacitated', T.bind(AB.callTheKill, 14), (ev) => {
    if (ev.prevented || markOf(ev.state, T.player) !== ev.operative.id) return;
    const next = T.enemies(ev.state)
      .filter((o) => o.id !== ev.operative.id && !o.incapacitated)
      .sort(byId)[0];
    setMark(ev.state, T.player, next);
  });

  // =========================================================================
  // COLD-BLOOD › Hardy
  // =========================================================================
  // "Whenever an attack dice would inflict Critical Dmg on this operative, you can choose for
  //  that attack dice to inflict Normal Dmg instead." D-022: always beneficial, so auto-used.
  reg.on('onDamage', T.bind(AB.hardy, 12), (ev) => {
    if (ev.kind !== 'attack' || !T.ctx) return;
    const victim = ev.target;
    if (victim.player !== T.player || victim.datacardId !== C.coldBlood) return;
    const seq = ev.state.sequence;
    if (!seq) return;
    if (seq.kind === 'shoot') {
      if (seq.targetId !== victim.id) return;
      const attacker = ev.state.operatives[seq.attackerId];
      const profile = attacker
        ? sequenceProfile(T.ctx, ev.state, attacker, seq.weaponName, seq.profileName, 'ranged')
        : undefined;
      if (!profile || profile.dmgC <= profile.dmgN) return;
      const crits = seq.attack.dice.filter((d) => d.state === 'crit').length;
      if (crits === 0) return;
      const saved = crits * (profile.dmgC - profile.dmgN);
      ev.amount = Math.max(0, ev.amount - saved);
      log(ev.state, { kind: 'action', player: T.player, text: `Hardy: ${victim.letter} takes Normal Dmg instead (-${saved})` });
      return;
    }
    // A fight resolves one die at a time, so Critical Dmg is identified by the amount itself.
    const side = seq.attackerId === victim.id ? 'defender' : 'attacker';
    const striker = ev.state.operatives[side === 'attacker' ? seq.attackerId : seq.defenderId];
    if (!striker) return;
    const profile = sequenceProfile(
      T.ctx,
      ev.state,
      striker,
      side === 'attacker' ? seq.attackerWeapon : (seq.defenderWeapon ?? ''),
      side === 'attacker' ? seq.attackerProfile : seq.defenderProfile,
      'melee',
    );
    if (!profile || profile.dmgC <= profile.dmgN || ev.amount !== profile.dmgC) return;
    ev.amount = profile.dmgN;
    log(ev.state, { kind: 'action', player: T.player, text: `Hardy: ${victim.letter} takes Normal Dmg instead` });
  });

  // =========================================================================
  // COLD-BLOOD › Cold-blooded
  // =========================================================================
  // "Whenever this operative is shooting against, fighting against or retaliating against a
  //  wounded enemy operative, this operative's weapons have the Lethal 5+ weapon rule; if that
  //  enemy operative is also injured, this operative's weapons also have the Rending weapon
  //  rule."
  reg.on('onWeaponRules', T.bind(AB.coldBlooded, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.coldBlood) return;
    if (!ev.target || !T.ctx) return;
    if (!isWounded(T.ctx, ev.target)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Cold-blooded)'));
    if (isInjured(T.ctx, ev.target)) ev.rules.push(ruleTag('Rending', undefined, 'Rending (Cold-blooded)'));
  });

  // =========================================================================
  // CUT-SKIN › Vicious Duellist
  // =========================================================================
  /*
   * "Whenever this operative is fighting or retaliating, for each attack dice your opponent
   *  discards as a fail, inflict 1 damage on the enemy operative in that sequence."
   *
   * `fight.ts` emits nothing between the roll and the Resolve Attack Dice step, so the count is
   * taken on the `onWeaponRules` emit `sideWeapon` makes at the retention step — the first
   * moment after every re-roll has been offered. PARTIAL: an opponent's `Punishing` retention
   * could still turn one of those fails into a normal success afterwards, which would make this
   * one damage generous.
   */
  reg.on('onWeaponRules', T.bind(AB.viciousDuellist, 14), (ev) => {
    const seq = fightSeq(ev.state);
    if (!seq || !T.ctx) return;
    if (seq.step !== 'retention' && seq.step !== 'resolve') return;
    const mine = [seq.attackerId, seq.defenderId]
      .map((id) => ev.state.operatives[id])
      .find((o) => o !== undefined && o.player === T.player && o.datacardId === C.cutSkin);
    if (!mine) return;
    const foe = ev.state.operatives[mine.id === seq.attackerId ? seq.defenderId : seq.attackerId];
    if (!foe || foe.removed || foe.incapacitated) return;
    const stamp = `${seq.attackerId}:${seq.defenderId}:${activationStamp(ev.state)}`;
    const b = bucket(ev.state, 'farstalker.viciousDuellist') as Record<string, string>;
    if (b[mine.id] === stamp) return;
    b[mine.id] = stamp; // set BEFORE inflicting: inflictDamage re-enters effectiveRules
    const foePool = mine.id === seq.attackerId ? seq.defenderPool : seq.attackerPool;
    const failed = foePool.dice.filter((d) => d.state === 'fail').length;
    if (failed === 0) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Vicious Duellist: ${failed} of ${foe.letter}'s attack dice failed — ${failed} damage`,
    });
    inflictDamage(T.ctx, ev.state, foe, failed, 'other');
  });

  // =========================================================================
  // CUT-SKIN › Savage Assault
  // =========================================================================
  /*
   * "The first time this operative performs the Fight action during each of its activations, if
   *  neither it nor the enemy operative in that sequence is incapacitated, this operative can
   *  immediately perform a free FIGHT action afterwards, but you cannot select any other enemy
   *  operative to fight against during that action (and only if it's still valid to fight
   *  against). This takes precedence over action restrictions."
   *
   * Nothing runs at the end of an action, so the free AP (D-100) is granted at the start of the
   * activation and restricted to `Fight (Savage Assault)`, whose own `check` carries every
   * printed condition (D-026). The AP is simply unusable if the operative never fights. It is
   * free AP, not an APL stat change, so "this takes precedence over action restrictions" is not
   * quietly cancelled by the +-1 APL clamp when something else has already raised this
   * operative's APL.
   */
  reg.on('onActivationStart', T.bind(AB.savageAssault, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== C.cutSkin) return;
    grantFreeAction(ev.state, op, {
      sourceId: AB.savageAssault,
      sourceText: shortQuote(abilityText(C.cutSkin, AB.savageAssault)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, op),
      only: [SAVAGE_FIGHT],
    });
  });
  // The enemy of the first fight, so the free one cannot select another.
  reg.on('onCollectAttackDice', T.bind(AB.savageAssault, 13), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.cutSkin || !ev.ctx.defender) return;
    const b = bucket(ev.state, 'farstalker.savageTarget') as Record<string, string>;
    const key = `${op.id}:${activationStamp(ev.state)}`;
    if (b[key]) return; // "the first time this operative performs the Fight action"
    b[key] = ev.ctx.defender.id;
  });

  // =========================================================================
  // HOUND › Beast
  // =========================================================================
  // "This operative cannot perform any actions other than Charge, Dash, Fall Back, Fight,
  //  Gather, Guard, Reposition, Pick Up Marker and Place Marker."
  reg.on('canPerformAction', T.bind(AB.beast, 10), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.hound) return;
    if (beastAllows(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'Beast: this operative cannot perform that action';
  });
  // "It cannot use any weapons that aren't on its datacard." `weaponsOf` appends granted
  // weapons AFTER `availableWeapons` filters the card, so the ban is also enforced at the
  // Select Weapon step, which is what a granted grenade would go through.
  reg.on('availableWeapons', T.bind(AB.beast, 10), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== C.hound) return;
    const own = (T.card(ev.operative)?.weapons ?? []).map((w) => w.name);
    ev.weapons = ev.weapons.filter((n) => own.includes(n));
  });
  reg.on('onSelectWeapon', T.bind(AB.beast, 10), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== C.hound) return;
    const own = (T.card(op)?.weapons ?? []).map((w) => w.name);
    if (own.includes(ev.ctx.weaponName)) return;
    ev.allowed = false;
    ev.reason = 'Beast: it cannot use any weapons that aren’t on its datacard';
  });

  // =========================================================================
  // HOUND › Bad-tempered
  // =========================================================================
  // The taunt half ("you can force them to select this operative to fight against instead") is
  // REMINDER ONLY — see REMINDER_ONLY: `Fight` takes its target from the intent and nothing is
  // emitted before `startFight`, so there is no fight-target substitution seam.
  //
  // "Whenever an enemy operative ends the Charge action … within control range of another
  //  friendly FARSTALKER KINBAND operative within 3" of this operative, if this operative isn't
  //  within control range of enemy operatives, this operative can immediately perform a free
  //  Charge action (you can change its order to Engage to do so)."
  // PARTIAL: with no post-action hook the test is taken at the end of that enemy's activation,
  // and the free Charge is D-100's free AP on the HOUND's own next activation.
  reg.on('onActivationEnd', T.bind(AB.badTempered, 13), (ev) => {
    const enemy = ev.operative;
    if (enemy.player === T.player || !T.ctx) return;
    if (!did(enemy, 'Charge')) return;
    const hound = T.friendlies(ev.state)
      .filter((o) => o.datacardId === C.hound)
      .filter((o) => !engagedWith(T.ctx!, ev.state, o))
      .filter((o) =>
        T.friendlies(ev.state, KW).some(
          (f) => f.id !== o.id && T.gap(f, enemy) <= 1 + EPS && T.gap(f, o) <= 3 + EPS,
        ),
      )
      .sort(byId)[0];
    if (!hound) return;
    hound.order = 'engage'; // "(you can change its order to Engage to do so)"
    grantFreeAction(ev.state, hound, {
      sourceId: AB.badTempered,
      sourceText: shortQuote(abilityText(C.hound, AB.badTempered)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, hound),
      only: ['Charge', STALKER_CHARGE, BOUND_CHARGE],
    });
  });

  // =========================================================================
  // LONG-SIGHT › Concealed Position (rare weapon rule)
  // =========================================================================
  // "This operative can only use this weapon the first time it's performing the Shoot action
  //  during the battle." It sits on ONE profile of the Kroot hunting rifle, which
  //  `availableWeapons` (per weapon) cannot express — `onSelectWeapon` can (D-032), and the
  //  Shoot action's own `check` emits it as a dry run so the AI never commits a refused shot.
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
  // PISTOLIER › Quick Draw
  // =========================================================================
  /*
   * "Once per turning point, when an enemy operative is performing the Shoot action and this
   *  operative is selected as the valid target (or if it will be a secondary target from the
   *  Blast weapon rule), if this operative is ready, you can interrupt that action to use this
   *  rule. If you do, this operative can immediately perform a free Shoot action with its dual
   *  Kroot pistols (focused) against that enemy operative (you can change its order to Engage
   *  to do so), but that enemy operative must be a valid target."
   *
   * PARTIAL, exactly as the Spectre Squad's Elite Fieldcraft: `state.sequence` is single-slot,
   * so a second shoot sequence cannot be started inside the enemy's. The interrupt is taken at
   * the Select Valid Target step (and, for a Blast secondary, as its dice are collected) and the
   * shot itself is D-100's free AP on the PISTOLIER's own next activation, locked to that enemy
   * through `Shoot (Quick Draw)`.
   */
  reg.on('onSelectTarget', T.bind(AB.quickDraw, 12), (ev) => {
    if (ev.attacker.player === T.player) return;
    armQuickDraw(T, ev.state, ev.target, ev.attacker);
  });
  reg.on('onCollectAttackDice', T.bind(AB.quickDraw, 12), (ev) => {
    if (!ev.ctx.secondary || ev.ctx.type !== 'ranged' || !ev.ctx.defender) return;
    if (ev.ctx.attacker.player === T.player) return;
    armQuickDraw(T, ev.state, ev.ctx.defender, ev.ctx.attacker);
  });

  // =========================================================================
  // PISTOLIER › Salvo (rare weapon rule)
  // =========================================================================
  // "Select up to two different valid targets that aren't within control range of friendly
  //  operatives. Shoot with this weapon against both of them in an order of your choice (roll
  //  each sequence separately)."
  // The engine's secondary-target queue makes one sequence inherit the primary's cover, so the
  // second shot is its own `Shoot (Salvo)` action instead — D-100's free AP, locked to a
  // different target. PARTIAL: it is a second ACTION, so "until the end of that action" rules
  // (Piercing Shot / Toxin Shot) do not span both halves.
  reg.on('onCollectAttackDice', T.bind(AB.salvo, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.secondary) return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player || !ev.ctx.profile.rules.some((r) => r.id === 'Salvo')) return;
    if (effectOn(ev.state, op.id, E.salvo)) return;
    if (ev.state.activeOperativeId !== op.id) return;
    effect(ev.state, {
      rule: E.salvo,
      source: { kind: 'ability', id: AB.salvo },
      sourceText: shortQuote(abilityText(C.pistolier, AB.salvo)),
      operativeId: op.id,
      player: T.player,
      data: { firstTargetId: ev.ctx.defender?.id ?? '', weaponName: ev.ctx.weaponName, profileName: ev.ctx.profile.name ?? '' },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    grantFreeAction(ev.state, op, {
      sourceId: AB.salvo,
      sourceText: shortQuote(abilityText(C.pistolier, AB.salvo)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, op),
      only: [SALVO_SHOOT],
    });
  });

  // =========================================================================
  // STALKER › Stalker
  // =========================================================================
  // "This operative can perform the Charge action while it has a Conceal order." The universal
  // Charge refuses a Conceal order and `canPerformAction` can only forbid, so it is its own
  // `Charge (Stalker)` action (D-021, the Kommandos Throat Slittas precedent).

  // =========================================================================
  // WARRIOR › Ready for Anything
  // =========================================================================
  // Implemented inside `chooseAmmunition` and the MEAT handler: a WARRIOR may spend the free
  // once-per-turning-point use when the equipment's own use is already gone.

  // =========================================================================
  // Free actions that were offered and never taken
  // =========================================================================
  // Free AP expires by itself: `grantFreeAction` records it on an effect that expires at the end
  // of the grantee's activation, which `expireActivationEffects` honours (D-100). That covers
  // Savage Assault, Salvo and GATHER, granted inside the operative's own activation.
  //
  // It does NOT cover the two grants this team makes to an operative that is not activating —
  // Bad-tempered arms the HOUND at the end of an enemy's activation, Quick Draw arms the
  // PISTOLIER while an enemy is shooting it — because both are spent "on its own next
  // activation" (PARTIAL, above), and an operative that was already expended when it earned the
  // offer never gets one. Such an offer belongs to the turning point that earned it, so the
  // Ready step sweeps away anything still unspent rather than letting a free Charge cross into
  // the next turning point.
  const dropUntakenGrant = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (eff.player !== T.player) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bindText('farstalker.freeActionUpkeep', text(RULE.farstalker), 92), (ev) => {
    if (ev.player !== T.player) return;
    for (const o of T.friendlies(ev.state)) dropUntakenGrant(ev.state, o);
  });

  // "At the start of this operative's next activation or if it's removed from the killzone
  //  (whichever comes first), remove your Pech'ra marker from the killzone."
  reg.on('onActivationStart', T.bindText('farstalker.pechraUpkeep', actionText(C.tracker, ACT.markedForTheHunt), 9), (ev) => {
    pechraUpkeep(T, ev.state, ev.operative, true);
  });
  reg.on('onActivationEnd', T.bindText('farstalker.pechraUpkeep', actionText(C.tracker, ACT.markedForTheHunt), 9), (ev) => {
    pechraUpkeep(T, ev.state, ev.operative, false);
  });

  // =========================================================================
  // TRACKER › MARKED FOR THE HUNT — the marker's own effect
  // =========================================================================
  // "Whenever a friendly FARSTALKER KINBAND operative is shooting an enemy operative that has
  //  that marker within its control range, that friendly operative's ranged weapons have the
  //  Seek Light weapon rule."
  reg.on('onWeaponRules', T.bind(ACT.markedForTheHunt, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target || !T.ctx) return;
    const marker = pechraMarker(ev.state, T.player);
    if (!marker) return;
    if (!markerContestedBy(T.ctx, ev.state, marker, ev.target)) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (Marked for the Hunt)'));
  });

  // =========================================================================
  // BOW-HUNTER › ENERGISE — the grant
  // =========================================================================
  // "Until the end of the turning point or until this operative has shot with its accelerator
  //  bow (whichever comes first), all profiles of its accelerator bow have the Lethal 5+ weapon
  //  rule."
  reg.on('onWeaponRules', T.bind(ACT.energise, 12), (ev) => {
    if (ev.weaponName !== BOW || ev.operative.player !== T.player) return;
    const eff = effectOn(ev.state, ev.operative.id, E.energise);
    if (!eff) return;
    const spent = eff.data?.['spentAt'];
    if (typeof spent === 'string' && spent !== shotKey(ev.state, ev.operative.id, BOW)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (ENERGISE)'));
  });
  reg.on('onCollectAttackDice', T.bind(ACT.energise, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.weaponName !== BOW) return;
    const op = ev.ctx.attacker;
    if (op.player !== T.player) return;
    const eff = effectOn(ev.state, op.id, E.energise);
    if (!eff || eff.data?.['spentAt']) return;
    eff.data = { ...(eff.data ?? {}), spentAt: shotKey(ev.state, op.id, BOW) };
  });

  // =========================================================================
  // TRACKER › FROM THE EYE ABOVE / equipment TROPHY — APL through `onStatMod`
  // =========================================================================
  reg.on('onStatMod', T.bind(ACT.fromTheEyeAbove, 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (effectOn(ev.state, ev.operative.id, E.eyeAbove)) ev.mods.apl += 1;
    if (effectOn(ev.state, ev.operative.id, E.trophy)) ev.mods.apl += 1;
  });
}

/** "…other than Charge, Dash, Fall Back, Fight, Gather, Guard, Reposition, Pick Up Marker and Place Marker." */
const BEAST_ALLOWED = [
  'charge',
  'dash',
  'fall back',
  'fight',
  'gather',
  'guard',
  'reposition',
  'pick up marker',
  'place marker',
];

function beastAllows(actionId: string): boolean {
  const def = getAction(actionId);
  const names = [def?.treatedAs ?? actionId, def?.name ?? actionId, actionId].map((s) => s.trim().toLowerCase());
  return names.some((n) => BEAST_ALLOWED.includes(n));
}

function hasShot(state: GameState, id: string): boolean {
  return Boolean((bucket(state, 'farstalker.shot') as Record<string, boolean>)[id]);
}
function markShot(state: GameState, id: string): void {
  (bucket(state, 'farstalker.shot') as Record<string, boolean>)[id] = true;
}

/** "…this operative is selected as the valid target … if this operative is ready." */
function armQuickDraw(T: TeamHooks, state: GameState, target: OperativeState, shooter: OperativeState): void {
  if (target.player !== T.player || target.datacardId !== C.pistolier) return;
  if (!target.ready || target.incapacitated || target.removed) return;
  if (usedThisTP(state, `farstalker.quickDraw:${target.id}`)) return;
  if (effectOn(state, target.id, E.quickDraw)) return;
  useOncePerTP(state, `farstalker.quickDraw:${target.id}`);
  effect(state, {
    rule: E.quickDraw,
    source: { kind: 'ability', id: AB.quickDraw },
    sourceText: shortQuote(abilityText(C.pistolier, AB.quickDraw)),
    operativeId: target.id,
    player: T.player,
    data: { enemyId: shooter.id },
    expiry: { kind: 'endOfActivation', operativeId: target.id },
  });
  grantFreeAction(state, target, {
    sourceId: AB.quickDraw,
    sourceText: shortQuote(abilityText(C.pistolier, AB.quickDraw)),
    kind: 'ability',
    threshold: currentApl(T, state, target),
    only: [QUICK_DRAW_SHOOT],
  });
  log(state, {
    kind: 'action',
    player: T.player,
    text: `Quick Draw: ${target.letter} readies its pistols against ${shooter.letter}`,
    data: { operativeId: target.id, enemyId: shooter.id },
  });
}

/** "…or if it's removed from the killzone (whichever comes first), remove your Pech'ra marker." */
function pechraUpkeep(T: TeamHooks, state: GameState, op: OperativeState, atStart: boolean): void {
  const marker = pechraMarker(state, T.player);
  if (!marker) return;
  const ownerId = String(marker.flags['forOperative'] ?? '');
  const owner = state.operatives[ownerId];
  // "At the start of this operative's next activation…" — never at the end of the activation it
  // was placed in, which is why the end-of-activation emit only tests removal.
  if (atStart && op.id === ownerId) {
    removeMarker(state, marker.id);
    log(state, { kind: 'action', player: T.player, text: 'The Pech’ra marker is removed' });
    return;
  }
  if (!owner || owner.removed || owner.incapacitated) {
    removeMarker(state, marker.id);
    log(state, { kind: 'action', player: T.player, text: 'The Pech’ra marker is removed' });
  }
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- CUT-THROATS (strategy, 1CP) ----------------------------------------
  // "Add 1 to the Atk stat of friendly FARSTALKER KINBAND operatives' melee weapons (to a
  //  maximum of 5)." `fight.ts` collects both sides through `onCollectAttackDice`, so this is
  //  live when fighting AND when retaliating.
  reg.on('onCollectAttackDice', T.bind(SP.cutThroats, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.cutThroats)) return;
    if (ev.ctx.type !== 'melee' || !T.mineKw(ev.ctx.attacker, KW)) return;
    ev.count = Math.min(5, ev.count + 1);
  });

  // ---- PREY (strategy, 1CP) ------------------------------------------------
  // "Whenever a friendly FARSTALKER KINBAND operative is shooting during an activation in which
  //  it hasn't performed the Charge, Fall Back or Reposition action, its ranged weapons have the
  //  Balanced and Severe weapon rules; if the weapon already has the Balanced weapon rule, it
  //  has the Ceaseless and Severe weapon rules instead."
  reg.on('onWeaponRules', T.bind(SP.prey, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.prey)) return;
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (['Charge', 'Fall Back', 'Reposition'].some((a) => did(ev.operative, a))) return;
    // "already has": the rules in effect at this point, so Call The Kill's Balanced upgrades it.
    if (hasRule(ev.rules, 'Balanced')) ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (PREY)'));
    else ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (PREY)'));
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (PREY)'));
  });

  // ---- ROGUE (strategy, 1CP) ----------------------------------------------
  // "Whenever an operative is shooting a friendly FARSTALKER KINBAND operative: Ignore the
  //  Saturate weapon rule. If you can retain any cover saves, you can retain one additional
  //  cover save, or you can retain one cover save as a critical success instead. This isn't
  //  cumulative with improved cover saves from Vantage terrain."
  reg.on('onDefenceDice', T.bind(SP.rogue, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.rogue)) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'rollDefence' || seq.targetId !== target.id) return;
    if (seq.inCover) ev.coverSave = true; // "Ignore the Saturate weapon rule."
    if (!ev.coverSave || seq.vantageImprovedCover) return;
    // The two halves are exclusive ("or"); a second retained normal is never worse than
    // promoting one to a critical, so the additional cover save is the deterministic choice.
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // ---- BOUND (strategy, 1CP) ----------------------------------------------
  // Three sibling move actions, registered below.

  // ---- SAVAGE AMBUSH (firefight, 1CP) -------------------------------------
  // "…In the Resolve Attack Dice step of that sequence, you resolve the first attack dice (i.e.
  //  defender instead of attacker)."
  reg.on('onPloyUsed', T.bind(FP.savageAmbush, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.savageAmbush) return;
    const seq = fightSeq(ev.state);
    const mine = seq && seq.defender === T.player ? ev.state.operatives[seq.defenderId] : undefined;
    // "…a ready friendly FARSTALKER KINBAND operative that has Light or Heavy terrain within its
    //  control range". `usable` gets no GameContext, so the terrain test lands here and the CP is
    //  handed back when it fails (the Mandrakes SLITHER OUT OF SIGHT precedent).
    if (!seq || !mine || !T.kw(mine, KW) || !mine.ready || !terrainWithin(T, ev.state, mine, 1, ['Light', 'Heavy'])) {
      ev.state.teams[T.player].cp += 1;
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: 'SAVAGE AMBUSH: no ready operative with Light or Heavy terrain within control range — 1CP refunded',
      });
      return;
    }
    seq.turn = 'defender';
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `SAVAGE AMBUSH: ${mine.letter} resolves the first attack dice`,
      data: { operativeId: mine.id },
    });
  });

  // ---- POACH (firefight, 1CP) ---------------------------------------------
  // "Until the end of that activation, that operative doesn't have to control a marker to
  //  perform the Pick Up Marker or mission actions that usually require this."
  // The mission-action half is REMINDER ONLY (ops own those ActionDefs); the Pick Up Marker half
  // is `Pick Up Marker (Poach)` below, because `canPerformAction` can only forbid, never permit.
  reg.on('onPloyUsed', T.bind(FP.poach, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.poach) return;
    const op = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!op || op.player !== T.player) return;
    effect(ev.state, {
      rule: E.poach,
      source: { kind: 'ploy', id: FP.poach },
      sourceText: shortQuote(text(FP.poach)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });

  // ---- SLIP AWAY (firefight, 1CP) -----------------------------------------
  // "During that activation, that operative can perform the Fall Back action for 1 less AP."
  reg.on('onPloyUsed', T.bind(FP.slipAway, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.slipAway) return;
    const op = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    if (!op || op.player !== T.player) return;
    effect(ev.state, {
      rule: E.slipAway,
      source: { kind: 'ploy', id: FP.slipAway },
      sourceText: shortQuote(text(FP.slipAway)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onActionCost', T.bind(FP.slipAway, 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (ev.action !== 'Fall Back' && ev.action !== BOUND_FALL_BACK) return;
    if (!effectOn(ev.state, ev.operative.id, E.slipAway)) return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // ---- VENGEANCE FOR THE KINBAND (firefight, 1CP) -------------------------
  // "Use this firefight ploy when a friendly FARSTALKER KINBAND operative is incapacitated by an
  //  enemy operative." The engine has no window at that moment, so the killer is recorded as it
  //  happens and the ploy reads it back.
  reg.on('onIncapacitated', T.bind(FP.vengeance, 19), (ev) => {
    if (ev.prevented || !T.mineKw(ev.operative, KW)) return;
    const killer = incapacitatorOf(ev.state, ev.operative);
    if (!killer || killer.player === T.player) return;
    (bucket(ev.state, LAST_KILLER) as Record<string, string>)[T.player] = killer.id;
    (bucket(ev.state, LAST_VICTIM) as Record<string, string>)[T.player] = ev.operative.id;
  });
  reg.on('onPloyUsed', T.bind(FP.vengeance, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.vengeance) return;
    const killerId = lastKiller(ev.state, T.player);
    const enemy = killerId ? ev.state.operatives[killerId] : undefined;
    if (!enemy || enemy.removed || enemy.incapacitated) {
      ev.state.teams[T.player].cp += 1;
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: 'VENGEANCE FOR THE KINBAND: no enemy operative has incapacitated a friendly operative — 1CP refunded',
      });
      return;
    }
    effect(ev.state, {
      rule: E.vengeance,
      source: { kind: 'ploy', id: FP.vengeance },
      sourceText: shortQuote(text(FP.vengeance)),
      player: T.player,
      data: { enemyId: enemy.id, victimId: lastVictim(ev.state, T.player) ?? '' },
      expiry: { kind: 'endOfBattle' }, // "Until the end of the battle"
    });
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `VENGEANCE FOR THE KINBAND: ${enemy.letter} is marked for the battle`,
      data: { enemyId: enemy.id },
    });
  });
  // "…whenever ANOTHER friendly FARSTALKER KINBAND operative is shooting against, fighting
  //  against or retaliating against that enemy operative, that other friendly operative's
  //  weapons have the Relentless weapon rule."
  reg.on('onWeaponRules', T.bind(FP.vengeance, 21), (ev) => {
    if (!T.mineKw(ev.operative, KW) || !ev.target) return;
    const marked = ev.state.effects.some(
      (e) =>
        e.rule === E.vengeance &&
        e.player === T.player &&
        e.data?.['enemyId'] === ev.target!.id &&
        e.data?.['victimId'] !== ev.operative.id,
    );
    if (!marked) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Vengeance for the Kinband)'));
  });
}

const LAST_KILLER = 'farstalker.lastKiller';
const LAST_VICTIM = 'farstalker.lastVictim';
const lastKiller = (state: GameState, player: PlayerId): string | undefined =>
  (state.opState[LAST_KILLER] as Record<string, string> | undefined)?.[player];
const lastVictim = (state: GameState, player: PlayerId): string | undefined =>
  (state.opState[LAST_VICTIM] as Record<string, string> | undefined)?.[player];

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- PIERCING SHOT / TOXIN SHOT -----------------------------------------
  // "Once per turning point, when a friendly FARSTALKER KINBAND operative is performing the
  //  Shoot action and you select a Kroot rifle, Kroot scattergun or dual Kroot pistols
  //  (focused), you can use this rule."
  // `onSelectWeapon` IS the Select Weapon step; D-032 requires a state-changing handler to
  // return early on a dry run, because the Shoot action's `check` emits it as a query.
  reg.on('onSelectWeapon', T.bind(EQ.piercingShot, 30), (ev) => {
    if (ev.dryRun) return;
    chooseAmmunition(T, ev.state, ev.ctx.attacker, ev.ctx.weaponName, ev.ctx.profile);
  });
  reg.on('onWeaponRules', T.bind(EQ.piercingShot, 31), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (!ammoInUse(ev.state, ev.operative, ev.weaponName, EQ.piercingShot)) return;
    ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (PIERCING SHOT)'));
  });
  reg.on('onWeaponRules', T.bind(EQ.toxinShot, 31), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (!ammoInUse(ev.state, ev.operative, ev.weaponName, EQ.toxinShot)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (TOXIN SHOT)'));
    ev.rules.push(ruleTag('Stun', undefined, 'Stun (TOXIN SHOT)'));
  });

  // ---- MEAT ---------------------------------------------------------------
  // "Once per turning point, when a friendly FARSTALKER KINBAND operative (excluding HOUND) is
  //  activated, if it's not within control range of enemy operatives, you can use this rule. If
  //  you do, that friendly operative regains up to D3+1 lost wounds."
  // D-022: free, so auto-used on the first activation of the turning point where it would
  // actually restore a wound.
  reg.on('onActivationStart', T.bind(EQ.meat, 30), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !T.kw(op, KW) || op.datacardId === C.hound || !T.ctx) return;
    if (!hasEquipment(ev.state, T.player, EQ.meat)) return;
    if (T.enemies(ev.state).some((e) => T.gap(e, op) <= 1 + EPS)) return;
    const max = T.card(op)?.wounds ?? op.wounds;
    if (op.wounds >= max) return;
    let viaReady = false;
    if (!useOncePerTP(ev.state, equipmentKey(T.player, EQ.meat))) {
      if (!readyForAnythingReady(T, ev.state, op)) return;
      useOncePerTP(ev.state, READY_KEY(T.player));
      viaReady = true;
    }
    const heal = T.ctx.rng.d3() + 1;
    recordRoll(ev.state, 'meat', [heal], T.player, 'MEAT D3+1');
    op.wounds = Math.min(max, op.wounds + heal);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `MEAT: ${op.letter} regains ${heal} wounds${viaReady ? ' (Ready for Anything)' : ''}`,
      data: { operativeId: op.id },
    });
  });

  // ---- TROPHY -------------------------------------------------------------
  // "Once per battle, during a friendly FARSTALKER KINBAND operative's activation (excluding
  //  HOUND), before or after it performs an action, if it's not within control range of enemy
  //  operatives, you can use this rule. If you do, add 1 to that friendly operative's APL stat
  //  until the end of its activation."
  // D-022: free and never harmful, so it is taken at the first eligible activation, and the APL
  // change goes through `onStatMod` so it expires with the effect instead of leaking `aplMods`.
  reg.on('onActivationStart', T.bind(EQ.trophy, 31), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || !T.kw(op, KW) || op.datacardId === C.hound) return;
    if (!hasEquipment(ev.state, T.player, EQ.trophy)) return;
    if (T.enemies(ev.state).some((e) => T.gap(e, op) <= 1 + EPS)) return;
    if (!useOncePerBattle(ev.state, `farstalker.trophy:${T.player}`)) return;
    effect(ev.state, {
      rule: E.trophy,
      source: { kind: 'equipment', id: EQ.trophy },
      sourceText: shortQuote(text(EQ.trophy)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `TROPHY: ${op.letter} gains 1 APL`, data: { operativeId: op.id } });
  });
}

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

function actions(data: typeof DATA): ActionDef[] {
  return [
    // ---- ENERGISE 1AP — BOW-HUNTER --------------------------------------
    uniqueAction(data, C.bowHunter, ACT.energise, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === E.energise && e.operativeId === op.id);
        effect(state, {
          rule: E.energise,
          source: { kind: 'ability', id: ACT.energise },
          sourceText: shortQuote(actionText(C.bowHunter, ACT.energise)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfTurningPoint' }, // "Until the end of the turning point…"
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: ENERGISE (Lethal 5+ on all bow profiles)` });
        return { ok: true };
      },
    }),

    // ---- GATHER 1AP — HOUND ---------------------------------------------
    // "Perform a free Dash or Reposition action with this operative. During that move, it can
    //  perform a free Pick Up Marker or Place Marker action." The "any remaining move distance
    //  … can be used after it does so" half is REMINDER ONLY (a move is atomic).
    uniqueAction(data, C.hound, ACT.gather, {
      check: (ctx, state, op, params) => getAction(gatherMode(params))!.check(ctx, state, op, params),
      perform: (ctx, state, op, params) => {
        const mode = gatherMode(params);
        const r = getAction(mode)!.perform(ctx, state, op, params);
        if (!r.ok) return r;
        // The free move still counts as that action for action restrictions.
        if (!op.actionsThisActivation.includes(mode)) op.actionsThisActivation.push(mode);
        grantFreeAction(state, op, {
          sourceId: ACT.gather,
          sourceText: shortQuote(actionText(C.hound, ACT.gather)),
          kind: 'ability',
          threshold: aplOf(ctx, state, op),
          only: ['Pick Up Marker', 'Place Marker', POACH_PICK_UP],
        });
        return { ok: true };
      },
    }),

    // ---- LONG-SIGHT 1AP — LONG-SIGHT -------------------------------------
    // DATA PROBLEM: the printed effect list is missing from the JSON — the text stops at
    // "Until the start of this operative's next activation:". The action and its printed
    // restriction are implemented; its benefit is REMINDER ONLY (see REMINDER_ONLY).
    uniqueAction(data, C.longSight, ACT.longSight, {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === E.longSight && e.operativeId === op.id);
        effect(state, {
          rule: E.longSight,
          source: { kind: 'ability', id: ACT.longSight },
          sourceText: shortQuote(actionText(C.longSight, ACT.longSight)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: LONG-SIGHT` });
        return { ok: true };
      },
    }),

    // ---- MARKED FOR THE HUNT 1AP — TRACKER -------------------------------
    uniqueAction(data, C.tracker, ACT.markedForTheHunt, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const spot = pechraSpot(ctx, state, op, params);
        return spot.ok ? { ok: true } : { ok: false, reason: spot.reason ?? 'no legal location' };
      },
      perform: (ctx, state, op, params) => {
        const spot = pechraSpot(ctx, state, op, params);
        if (!spot.ok || !spot.pos) return { ok: false, reason: spot.reason ?? 'no legal location' };
        removeMarker(state, PECHRA_MARKER(op.player)); // "Remove your Pech'ra marker (if any)."
        placeTeamMarker(state, {
          id: PECHRA_MARKER(op.player),
          kind: 'generic',
          player: op.player,
          pos: spot.pos,
          z: surfaceAt(terrain(ctx, state), spot.pos),
          flags: { pechra: true, forOperative: op.id },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: MARKED FOR THE HUNT — Pech’ra marker at ${spot.pos.x.toFixed(1)}, ${spot.pos.y.toFixed(1)}`,
          data: { operativeId: op.id },
        });
        return { ok: true };
      },
    }),

    // ---- FROM THE EYE ABOVE 1AP — TRACKER --------------------------------
    // "SUPPORT. Select one other friendly FARSTALKER KINBAND operative visible to and within 6"
    //  of this operative. Until the end of that operative's next activation, add 1 to its APL."
    uniqueAction(data, C.tracker, ACT.fromTheEyeAbove, {
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player !== op.player || target.id === op.id)
          return { ok: false, reason: 'select one other friendly FARSTALKER KINBAND operative' };
        if (!hasKw(ctx, target, KW)) return { ok: false, reason: 'that operative is not a FARSTALKER KINBAND operative' };
        // SUPPORT: a Comms Device widens the printed 6" (universal equipment).
        const range = supportDistance(ctx, state, op, 6);
        if (gapBetween(ctx, op, target) > range + EPS)
          return { ok: false, reason: `that operative is more than ${range}" away` };
        if (!isVisible(terrain(ctx, state), body(ctx, op), body(ctx, target)).visible)
          return { ok: false, reason: 'that operative is not visible to this operative' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        dropEffects(state, (e) => e.rule === E.eyeAbove && e.operativeId === target.id);
        effect(state, {
          rule: E.eyeAbove,
          source: { kind: 'ability', id: ACT.fromTheEyeAbove },
          sourceText: shortQuote(actionText(C.tracker, ACT.fromTheEyeAbove)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: FROM THE EYE ABOVE — ${target.letter} +1 APL`,
          data: { operativeId: target.id },
        });
        return { ok: true };
      },
    }),

    // ---- STEALTH ATTACK 2AP — STALKER ------------------------------------
    uniqueAction(data, C.stalker, ACT.stealthAttack, {
      check: (ctx, state, op, params) => {
        const v = stealthAttackMove(ctx, state, op, params);
        return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
      },
      perform: (ctx, state, op, params) => {
        const v = stealthAttackMove(ctx, state, op, params);
        if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
        finishCustomMove(state, op, v.endPos!, v.endZ!, params.path?.endRot);
        op.stickyEngagedWith = aliveOf(state, otherPlayer(op.player))
          .filter((e) => inControlRange(ctx, state, op, e))
          .map((e) => e.id);
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: STEALTH ATTACK — free Charge (${v.total!}", no +2")`,
          data: { operativeId: op.id, inches: v.total },
        });
        const engagedFoes = aliveOf(state, otherPlayer(op.player)).filter((e) => inControlRange(ctx, state, op, e));
        const targetId = engagedFoes.some((e) => e.id === params.targetId)
          ? params.targetId
          : engagedFoes.sort(byId)[0]?.id;
        if (!targetId) return { ok: false, reason: 'no enemy operative within control range' };
        const weapon = params.meleeWeaponName ?? weaponsOf(ctx, state, op, 'melee')[0]?.name;
        if (!weapon) return { ok: false, reason: 'operative has no melee weapon' };
        // "The first time you strike during that action, you can immediately resolve another of
        //  your successes as a strike (before your opponent)."
        effect(state, {
          rule: E.stealthStrike,
          source: { kind: 'ability', id: ACT.stealthAttack },
          sourceText: shortQuote(actionText(C.stalker, ACT.stealthAttack)),
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfActivation', operativeId: op.id },
        });
        const r = startFight(ctx, state, op, weapon, params.meleeProfileName, targetId, { free: true });
        if (!r.ok) return r;
        advanceFight(ctx, state);
        return { ok: true };
      },
    }),
  ];
}

const gatherMode = (params: ActionParams): 'Dash' | 'Reposition' => (params.choice === 'Dash' ? 'Dash' : 'Reposition');

/**
 * STEALTH ATTACK's move: "Perform a free Charge action with this operative, but don't exceed its
 * Move stat (i.e. don't add 2")." The universal Charge refuses a Conceal order — which this
 * action REQUIRES — and always adds 2", so the move is validated here.
 */
function stealthAttackMove(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): { ok: boolean; reason?: string; endPos?: Vec2; endZ?: number; total?: number } {
  if (op.order === 'engage') return { ok: false, reason: 'it cannot perform this action while it has an Engage order' };
  if (engagedWith(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
  const index = terrain(ctx, state);
  const base = ctx.datacards.get(op.datacardId)?.base ?? { shape: 'round' as const, mm: 28 };
  const nearTerrain = index.parts.some(
    (p) => (hasType(p, 'Light') || hasType(p, 'Heavy')) && baseDistanceToPart(op.pos, base, op.rot, p) <= 1 + EPS,
  );
  if (!nearTerrain) return { ok: false, reason: 'it is not within 1" of Light or Heavy terrain' };
  if (weaponsOf(ctx, state, op, 'melee').length === 0) return { ok: false, reason: 'operative has no melee weapon' };
  if (!params.path) return { ok: false, reason: 'no path supplied' };
  const counteracting = state.opState['counteract']?.['operativeId'] === op.id;
  const v = validateMove(ctx, state, op, params.path, {
    action: 'Charge',
    mayEnterEnemyControlRange: true,
    mustFinishEngaged: true,
    ...(counteracting ? { hardCap: 2 } : {}),
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
  return { ok: true, endPos: v.endPos, endZ: v.endZ, total: v.total };
}

// ---------------------------------------------------------------------------
// Extra actions the universal ones forbid (docs/DECISIONS.md D-021)
// ---------------------------------------------------------------------------

/**
 * Farstalker's counteract half: "Whenever it's your turn to counteract, you can change the order
 * of one friendly FARSTALKER KINBAND operative that's not within control range of enemy
 * operatives instead. This still counts as you counteracting … but doesn't count as that
 * friendly operative's counteraction for this turning point."
 *
 * PARTIAL: the engine has no "counteract without selecting an operative" channel, so an eligible
 * counteract candidate carries the action; its own counteraction is handed back, which is the
 * only way the engine can express "this doesn't count as a counteraction".
 */
registerAction({
  id: CHANGE_ORDER_COUNTERACT,
  name: CHANGE_ORDER_COUNTERACT,
  ap: 1,
  type: 'unique',
  sourceText: text(RULE.farstalker),
  available: (ctx, state, op) => hasKw(ctx, op, KW) && state.opState['counteract']?.['operativeId'] === op.id,
  check(ctx, state, op, params) {
    if (state.opState['counteract']?.['operativeId'] !== op.id)
      return { ok: false, reason: 'only instead of counteracting' };
    const target = orderChangeTarget(ctx, state, op, params.targetOperativeId);
    if (!target)
      return { ok: false, reason: 'no friendly FARSTALKER KINBAND operative is outside enemy control range' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const target = orderChangeTarget(ctx, state, op, params.targetOperativeId);
    if (!target) return { ok: false, reason: 'no friendly FARSTALKER KINBAND operative is outside enemy control range' };
    target.order = flip(target.order);
    op.counteractedThisTP = false;
    log(state, {
      kind: 'action',
      player: op.player,
      text: `Farstalker: ${target.letter} changes its order to ${target.order} instead of counteracting`,
      data: { operativeId: target.id, order: target.order },
    });
    return { ok: true };
  },
});

/** STALKER: "This operative can perform the Charge action while it has a Conceal order." */
registerAction({
  id: STALKER_CHARGE,
  name: STALKER_CHARGE,
  ap: 1,
  type: 'unique',
  treatedAs: 'Charge',
  sourceText: abilityText(C.stalker, AB.stalker),
  available: (_ctx, _state, op) => op.datacardId === C.stalker,
  check(ctx, state, op, params) {
    const order = op.order;
    op.order = 'engage';
    try {
      return getAction('Charge')!.check(ctx, state, op, params);
    } finally {
      op.order = order;
    }
  },
  perform(ctx, state, op, params) {
    return getAction('Charge')!.perform(ctx, state, op, params);
  },
});

/** POACH: "…doesn't have to control a marker to perform the Pick Up Marker action." */
registerAction({
  id: POACH_PICK_UP,
  name: POACH_PICK_UP,
  ap: 1,
  type: 'unique',
  treatedAs: 'Pick Up Marker',
  sourceText: text(FP.poach),
  available: (ctx, state, op) =>
    hasKw(ctx, op, KW) && state.effects.some((e) => e.rule === E.poach && e.operativeId === op.id),
  check(ctx, state, op, params) {
    if (!state.effects.some((e) => e.rule === E.poach && e.operativeId === op.id))
      return { ok: false, reason: 'POACH has not been used on this operative' };
    if (engagedWith(ctx, state, op)) return { ok: false, reason: 'within control range of an enemy operative' };
    if (op.carryingMarkerId) return { ok: false, reason: 'already carrying a marker' };
    const marker = params.markerId ? state.markers[params.markerId] : undefined;
    if (!marker) return { ok: false, reason: 'no such marker' };
    if (!marker.flags['pickUpAllowed']) return { ok: false, reason: 'this marker cannot be picked up' };
    // "…it only needs to contest the marker" (taking precedence over that action's conditions).
    if (!markerContestedBy(ctx, state, marker, op))
      return { ok: false, reason: 'that marker is not within this operative’s control range' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const marker = state.markers[params.markerId!]!;
    marker.carriedBy = op.id;
    marker.pos = { ...op.pos };
    marker.z = op.z;
    op.carryingMarkerId = marker.id;
    log(state, { kind: 'action', player: op.player, text: `${op.letter} picks up the ${marker.kind} marker (POACH)` });
    return { ok: true };
  },
});

/** CUT-SKIN › Savage Assault: the free second FIGHT, locked to the first fight's enemy. */
registerAction({
  id: SAVAGE_FIGHT,
  name: SAVAGE_FIGHT,
  ap: 1,
  type: 'unique',
  sourceText: abilityText(C.cutSkin, AB.savageAssault),
  available: (_ctx, _state, op) => op.datacardId === C.cutSkin,
  check(ctx, state, op, params) {
    if (!did(op, 'Fight')) return { ok: false, reason: 'this operative has not performed the Fight action yet' };
    if (op.incapacitated) return { ok: false, reason: 'this operative is incapacitated' };
    const foeId = savageTarget(state, op);
    if (!foeId) return { ok: false, reason: 'no enemy operative was fought this activation' };
    const foe = state.operatives[foeId];
    if (!foe || foe.removed || foe.incapacitated)
      return { ok: false, reason: 'that enemy operative is no longer in the killzone' };
    if (params.targetId && params.targetId !== foeId)
      return { ok: false, reason: 'you cannot select any other enemy operative to fight against' };
    // "…and only if it's still valid to fight against."
    if (!inControlRange(ctx, state, op, foe))
      return { ok: false, reason: 'that enemy operative is no longer within control range' };
    return getAction('Fight')!.check(ctx, state, op, { ...params, targetId: foeId });
  },
  perform(ctx, state, op, params) {
    const foeId = savageTarget(state, op)!;
    return getAction('Fight')!.perform(ctx, state, op, { ...params, targetId: foeId });
  },
});

function savageTarget(state: GameState, op: OperativeState): string | undefined {
  const b = state.opState['farstalker.savageTarget'] as Record<string, string> | undefined;
  return b?.[`${op.id}:${activationStamp(state)}`];
}

/** PISTOLIER › Quick Draw: the free Shoot with its dual Kroot pistols (focused). */
registerAction({
  id: QUICK_DRAW_SHOOT,
  name: QUICK_DRAW_SHOOT,
  ap: 1,
  type: 'unique',
  sourceText: abilityText(C.pistolier, AB.quickDraw),
  available: (_ctx, _state, op) => op.datacardId === C.pistolier,
  check(ctx, state, op, params) {
    const eff = effectOn(state, op.id, E.quickDraw);
    if (!eff) return { ok: false, reason: 'Quick Draw has not been used with this operative' };
    const enemyId = String(eff.data?.['enemyId'] ?? '');
    if (params.targetId && params.targetId !== enemyId)
      return { ok: false, reason: 'only the enemy operative that shot at it can be selected' };
    const enemy = state.operatives[enemyId];
    if (!enemy || enemy.removed) return { ok: false, reason: 'that enemy operative is no longer in the killzone' };
    const order = op.order;
    op.order = 'engage'; // "(you can change its order to Engage to do so)"
    try {
      const base = getAction('Shoot')!.check(ctx, state, op, {
        ...params,
        weaponName: PISTOLS,
        profileName: 'focused',
        targetId: enemyId,
      });
      if (!base.ok) return base;
      // "…but that enemy operative must be a valid target."
      return targetIsValid(ctx, state, op, PISTOLS, 'focused', enemyId);
    } finally {
      op.order = order;
    }
  },
  perform(ctx, state, op, params) {
    const eff = effectOn(state, op.id, E.quickDraw);
    const enemyId = String(eff?.data?.['enemyId'] ?? '');
    if (op.order === 'conceal') {
      op.order = 'engage';
      log(state, { kind: 'action', player: op.player, text: `${op.letter} changes its order to Engage (Quick Draw)` });
    }
    dropEffects(state, (e) => e.rule === E.quickDraw && e.operativeId === op.id);
    return getAction('Shoot')!.perform(ctx, state, op, {
      ...params,
      weaponName: PISTOLS,
      profileName: 'focused',
      targetId: enemyId,
    });
  },
});

const PISTOLS = 'Dual Kroot pistols';

/** PISTOLIER › Salvo: the second of the two targets. */
registerAction({
  id: SALVO_SHOOT,
  name: SALVO_SHOOT,
  ap: 1,
  type: 'unique',
  sourceText: abilityText(C.pistolier, AB.salvo),
  available: (_ctx, state, op) => state.effects.some((e) => e.rule === E.salvo && e.operativeId === op.id),
  check(ctx, state, op, params) {
    const eff = effectOn(state, op.id, E.salvo);
    if (!eff) return { ok: false, reason: 'this operative has not shot with a Salvo weapon this activation' };
    const first = String(eff.data?.['firstTargetId'] ?? '');
    if (!params.targetId) return { ok: false, reason: 'select the second valid target' };
    if (params.targetId === first) return { ok: false, reason: 'Salvo: select two DIFFERENT valid targets' };
    const weaponName = String(eff.data?.['weaponName'] ?? PISTOLS);
    const profileName = String(eff.data?.['profileName'] ?? 'salvo');
    const base = getAction('Shoot')!.check(ctx, state, op, { ...params, weaponName, profileName });
    if (!base.ok) return base;
    return targetIsValid(ctx, state, op, weaponName, profileName, params.targetId);
  },
  perform(ctx, state, op, params) {
    const eff = effectOn(state, op.id, E.salvo)!;
    const weaponName = String(eff.data?.['weaponName'] ?? PISTOLS);
    const profileName = String(eff.data?.['profileName'] ?? 'salvo');
    dropEffects(state, (e) => e.rule === E.salvo && e.operativeId === op.id);
    return getAction('Shoot')!.perform(ctx, state, op, { ...params, weaponName, profileName });
  },
});

for (const spec of BOUND_SPECS) registerAction(boundAction(spec));

// ---------------------------------------------------------------------------
// STEALTH ATTACK's extra strike
// ---------------------------------------------------------------------------

/**
 * "The first time you strike during that action, you can immediately resolve another of your
 * successes as a strike (before your opponent)."
 *
 * `resolveFightDie` rewrites `seq.turn` AFTER `onStrikeResolved` is emitted, so the second
 * success is resolved here directly rather than by handing the turn back. PARTIAL: the engine
 * builds the strike/block options, so this always takes the extra resolution as a strike.
 */
function stealthStrike(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onStrikeResolved', T.bindText(ACT.stealthAttack, actionText(C.stalker, ACT.stealthAttack), 15), (ev) => {
    if (ev.ctx.type !== 'melee' || !T.ctx) return;
    const striker = ev.ctx.attacker;
    if (striker.player !== T.player || striker.datacardId !== C.stalker) return;
    if (!effectOn(ev.state, striker.id, E.stealthStrike)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const victim = ev.struck;
    if (victim.incapacitated || victim.removed) return;
    dropEffects(ev.state, (e) => e.rule === E.stealthStrike && e.operativeId === striker.id); // "the first time"
    const pool = striker.id === seq.attackerId ? seq.attackerPool : seq.defenderPool;
    const die = successes(pool).find((d) => d.state === 'crit') ?? successes(pool)[0];
    if (!die) return;
    const crit = die.state === 'crit';
    die.state = 'struck';
    const dmg = crit ? ev.ctx.profile.dmgC : ev.ctx.profile.dmgN;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `STEALTH ATTACK: ${striker.letter} immediately strikes again for ${dmg}${crit ? ' (critical)' : ''}`,
    });
    inflictDamage(T.ctx, ev.state, victim, dmg, 'attack');
    const dev = devastatingDamage(ev.ctx.rules, crit ? 1 : 0);
    if (dev.perCrit > 0 && crit) inflictDamage(T.ctx, ev.state, victim, dev.perCrit, 'devastating');
  });
}

// ---------------------------------------------------------------------------

const activeIsMine = (state: GameState, player: PlayerId): { ok: boolean; reason?: string } => {
  const op = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
  if (!op || op.player !== player) return { ok: false, reason: 'no friendly operative is activating' };
  return { ok: true };
};

export const farstalkerKinband = defineTeam({
  id: 'farstalker-kinband',
  rules: (reg, T) => {
    rules(reg, T);
    stealthStrike(reg, T);
    if (T.ctx) {
      const handlers = (T.ctx.decisionHandlers ??= []);
      if (!handlers.includes(orderDecisionHandler)) handlers.push(orderDecisionHandler);
    }
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy during the Fight action when a ready friendly FARSTALKER KINBAND
    //  operative … is selected to fight against."
    [FP.savageAmbush]: (state, player) => {
      const seq = state.sequence?.kind === 'fight' ? state.sequence : undefined;
      if (!seq) return { ok: false, reason: 'no fight is in progress' };
      const mine = seq.defender === player ? state.operatives[seq.defenderId] : undefined;
      if (!mine) return { ok: false, reason: 'none of your operatives is being fought against' };
      if (!mine.ready) return { ok: false, reason: 'that operative is not ready' };
      return { ok: true };
    },
    // "Use this firefight ploy during a friendly FARSTALKER KINBAND operative's activation."
    [FP.poach]: activeIsMine,
    [FP.slipAway]: activeIsMine,
    // "Use this firefight ploy when a friendly FARSTALKER KINBAND operative is incapacitated by
    //  an enemy operative. … You cannot use this ploy again during the battle until that enemy
    //  operative is incapacitated."
    [FP.vengeance]: (state, player) => {
      const killerId = lastKiller(state, player);
      const killer = killerId ? state.operatives[killerId] : undefined;
      if (!killer || killer.removed || killer.incapacitated)
        return { ok: false, reason: 'no enemy operative has incapacitated a friendly FARSTALKER KINBAND operative' };
      const live = state.effects.some((e) => {
        if (e.rule !== E.vengeance || e.player !== player) return false;
        const marked = state.operatives[String(e.data?.['enemyId'] ?? '')];
        return Boolean(marked && !marked.removed && !marked.incapacitated);
      });
      if (live) return { ok: false, reason: 'you cannot use this ploy again until that enemy operative is incapacitated' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [C.killBroker]: 'leader',
      [C.bowHunter]: 'gunner',
      [C.coldBlood]: 'gunner',
      [C.cutSkin]: 'melee',
      [C.heavyGunner]: 'gunner',
      [C.hound]: 'objective',
      [C.longSight]: 'sniper',
      [C.pistolier]: 'gunner',
      [C.stalker]: 'melee',
      [C.tracker]: 'support',
      [C.warrior]: 'objective',
    },
    ployValue: {
      [SP.cutThroats]: 0.5,
      [SP.prey]: 0.7,
      [SP.rogue]: 0.5,
      [SP.bound]: 0.3,
      [FP.savageAmbush]: 0.6,
      [FP.poach]: 0.5,
      [FP.slipAway]: 0.4,
      [FP.vengeance]: 0.6,
    },
    equipmentValue: {
      [EQ.piercingShot]: 0.6,
      [EQ.meat]: 0.7,
      [EQ.toxinShot]: 0.6,
      [EQ.trophy]: 0.5,
    },
  },
});

export default farstalkerKinband;
